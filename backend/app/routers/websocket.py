"""
WebSocket endpoint for real-time collaborative editing.

Endpoint: WS /ws/{doc_slug}/{user_id}

Protocol summary:
  On connect  → send 'init' with full ops log + current presence list
              → record join in MongoDB
              → broadcast 'user_joined' to room

  While open  → type='op':       persist to PostgreSQL, broadcast to room
              → type='presence': update presence store, broadcast to room (no DB write)

  On close    → remove from room, update MongoDB presence_events.left_at
              → broadcast 'user_left' to room
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import asyncpg
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from starlette.websockets import WebSocketState

from app.database import get_mongo_db, get_pg_pool
from app.models import OpModel
from app.ws_manager import manager

logger = logging.getLogger(__name__)
router = APIRouter(tags=["websocket"])


@router.websocket("/ws/{doc_slug}/{user_id}")
async def websocket_endpoint(
    ws: WebSocket,
    doc_slug: str,
    user_id: str,
) -> None:
    await ws.accept()

    pool = get_pg_pool()
    mongo = get_mongo_db()

    # ── Validate document exists ──────────────────────────────────────────────
    doc_row = await pool.fetchrow(
        "SELECT id, title, slug, created_at FROM documents WHERE slug = $1",
        doc_slug,
    )
    if doc_row is None:
        await ws.close(code=4004, reason=f"Document '{doc_slug}' not found")
        return

    doc_id: str = str(doc_row["id"])

    # ── Load ops log ──────────────────────────────────────────────────────────
    op_rows = await pool.fetch(
        "SELECT op_json FROM ops WHERE document_id = $1 ORDER BY seq",
        doc_row["id"],
    )
    # asyncpg may return JSONB as a str (when the codec isn't active) or as a
    # dict (when the pg_catalog codec IS active).  Parse defensively so the
    # init message always contains plain Python dicts that FastAPI can serialise.
    import json as _json
    def _coerce_op(v: Any) -> dict:
        return _json.loads(v) if isinstance(v, str) else v

    ops_list: list[dict[str, Any]] = [_coerce_op(r["op_json"]) for r in op_rows]

    # ── Join the room BEFORE sending init so we don't miss concurrent ops ─────
    manager.connect(doc_slug, ws)

    # ── Send init message ─────────────────────────────────────────────────────
    presence_list = manager.get_presence_list(doc_slug)
    await ws.send_json({
        "type": "init",
        "document": {
            "id": doc_id,
            "title": doc_row["title"],
            "slug": doc_row["slug"],
        },
        "ops": ops_list,
        "presenceList": presence_list,
    })

    # ── Record join in MongoDB ────────────────────────────────────────────────
    await mongo.presence_events.insert_one({
        "document_id": doc_id,
        "user_id": user_id,
        "display_name": "",        # will be populated on first presence message
        "color": "",
        "joined_at": datetime.now(timezone.utc),
        "left_at": None,
    })

    # ── Broadcast user_joined ─────────────────────────────────────────────────
    await manager.broadcast_except(doc_slug, ws, {
        "type": "user_joined",
        "userId": user_id,
    })

    # ── Message loop ──────────────────────────────────────────────────────────
    try:
        while True:
            data: dict[str, Any] = await ws.receive_json()
            msg_type = data.get("type")

            if msg_type == "op":
                await _handle_op(data, doc_id, doc_slug, ws, pool)

            elif msg_type == "presence":
                await _handle_presence(data, doc_slug, ws, mongo)

            else:
                logger.warning("Unknown WS message type: %r", msg_type)

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.exception("Unexpected WebSocket error: %s", exc)
    finally:
        await _handle_disconnect(doc_slug, doc_id, user_id, ws, mongo)


# ─── Handlers ─────────────────────────────────────────────────────────────────


async def _handle_op(
    data: dict[str, Any],
    doc_id: str,
    doc_slug: str,
    ws: WebSocket,
    pool: asyncpg.Pool,
) -> None:
    """Persist an op to PostgreSQL and fan it out to other clients."""
    op_data = data.get("op")
    if not op_data:
        return

    # Validate op shape via Pydantic.
    try:
        OpModel(**op_data)
    except Exception as exc:
        logger.warning("Invalid op shape: %s", exc)
        return

    try:
        await pool.execute(
            """
            INSERT INTO ops (document_id, op_json)
            VALUES ($1, $2::jsonb)
            ON CONFLICT DO NOTHING
            """,
            doc_id,
            # asyncpg needs the value as a string when using ::jsonb cast
            _dict_to_jsonb_str(op_data),
        )
    except Exception as exc:
        logger.error("Failed to persist op: %s", exc)
        return

    # Broadcast to all other clients in the room.
    await manager.broadcast_except(doc_slug, ws, {"type": "op", "op": op_data})


async def _handle_presence(
    data: dict[str, Any],
    doc_slug: str,
    ws: WebSocket,
    mongo: Any,
) -> None:
    """Update in-memory presence state and fan out to other clients."""
    presence_snap = {
        "userId": data.get("userId", ""),
        "displayName": data.get("displayName", ""),
        "color": data.get("color", ""),
        "cursorPosition": data.get("cursorPosition", 0),
        "selectionStart": data.get("selectionStart", 0),
        "selectionEnd": data.get("selectionEnd", 0),
    }
    manager.update_presence(ws, presence_snap)

    # Persist display name / color to MongoDB for session history.
    user_id = data.get("userId", "")
    if user_id and data.get("displayName"):
        await mongo.presence_events.update_one(
            {"user_id": user_id, "left_at": None},
            {"$set": {
                "display_name": data["displayName"],
                "color": data.get("color", ""),
            }},
        )

    await manager.broadcast_except(doc_slug, ws, {"type": "presence", **presence_snap})


async def _handle_disconnect(
    doc_slug: str,
    doc_id: str,
    user_id: str,
    ws: WebSocket,
    mongo: Any,
) -> None:
    """Clean up after a client disconnects."""
    manager.disconnect(doc_slug, ws)

    # Mark session as ended in MongoDB.
    await mongo.presence_events.update_one(
        {"document_id": doc_id, "user_id": user_id, "left_at": None},
        {"$set": {"left_at": datetime.now(timezone.utc)}},
    )

    await manager.broadcast(doc_slug, {"type": "user_left", "userId": user_id})


# ─── Utilities ────────────────────────────────────────────────────────────────


def _dict_to_jsonb_str(d: dict[str, Any]) -> str:
    """Serialise a dict to a JSON string for asyncpg JSONB insertion."""
    import json
    return json.dumps(d)

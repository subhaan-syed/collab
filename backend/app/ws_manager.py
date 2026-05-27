"""
WebSocket connection manager.

Maintains a set of active WebSocket connections per document slug ("room").
Provides broadcast helpers used by the WebSocket endpoint.

This is an in-process manager. For multi-process / multi-instance deployments,
replace the in-memory store with a Redis Pub/Sub channel per room.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any

from fastapi import WebSocket
from starlette.websockets import WebSocketState

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self) -> None:
        # Maps document slug → set of connected WebSockets.
        self._rooms: dict[str, set[WebSocket]] = defaultdict(set)
        # Maps WebSocket → presence snapshot (for sending to newly joining clients).
        self._presence: dict[WebSocket, dict[str, Any]] = {}

    # ── Connection lifecycle ──────────────────────────────────────────────────

    def connect(self, room: str, ws: WebSocket) -> None:
        self._rooms[room].add(ws)

    def disconnect(self, room: str, ws: WebSocket) -> None:
        self._rooms[room].discard(ws)
        self._presence.pop(ws, None)
        # Clean up empty rooms to avoid unbounded memory growth.
        if not self._rooms[room]:
            del self._rooms[room]

    def update_presence(self, ws: WebSocket, presence: dict[str, Any]) -> None:
        """Store the latest presence snapshot for a connection."""
        self._presence[ws] = presence

    def get_presence_list(self, room: str) -> list[dict[str, Any]]:
        """Return current presence snapshots for all connections in a room."""
        result = []
        for ws in self._rooms.get(room, set()):
            snap = self._presence.get(ws)
            if snap:
                result.append(snap)
        return result

    def connected_count(self, room: str) -> int:
        return len(self._rooms.get(room, set()))

    # ── Broadcast helpers ─────────────────────────────────────────────────────

    async def broadcast(self, room: str, message: dict[str, Any]) -> None:
        """Send a message to every connection in the room."""
        await self._send_to(self._rooms.get(room, set()), message)

    async def broadcast_except(
        self, room: str, sender: WebSocket, message: dict[str, Any]
    ) -> None:
        """Send a message to every connection in the room except the sender."""
        recipients = self._rooms.get(room, set()) - {sender}
        await self._send_to(recipients, message)

    async def _send_to(
        self, connections: set[WebSocket], message: dict[str, Any]
    ) -> None:
        stale: list[WebSocket] = []
        for ws in list(connections):
            try:
                if ws.client_state == WebSocketState.CONNECTED:
                    await ws.send_json(message)
            except Exception:
                # Connection is broken — mark for removal.
                stale.append(ws)
                logger.debug("Removing stale WebSocket connection")
        for ws in stale:
            for room_connections in self._rooms.values():
                room_connections.discard(ws)
            self._presence.pop(ws, None)


# Singleton instance shared by all WebSocket endpoint handlers.
manager = ConnectionManager()

"""
REST endpoints for document management.

GET  /api/documents          — list all documents (most recent first)
POST /api/documents          — create a new document
GET  /api/documents/{slug}   — get document metadata + reconstructed text
"""

from __future__ import annotations

import logging
from typing import Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status

from app.crdt import Operation, RGADocument
from app.database import get_pg_pool
from app.models import (
    CreateDocumentRequest,
    DocumentResponse,
    DocumentWithTextResponse,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/documents", tags=["documents"])


@router.get("", response_model=list[DocumentResponse])
async def list_documents(
    pool: asyncpg.Pool = Depends(get_pg_pool),
) -> list[dict[str, Any]]:
    """Return all documents ordered by creation time (newest first)."""
    rows = await pool.fetch(
        "SELECT id, title, slug, created_at FROM documents ORDER BY created_at DESC"
    )
    return [dict(r) for r in rows]


@router.post("", response_model=DocumentResponse, status_code=status.HTTP_201_CREATED)
async def create_document(
    body: CreateDocumentRequest,
    pool: asyncpg.Pool = Depends(get_pg_pool),
) -> dict[str, Any]:
    """Create a document with the given title and slug."""
    try:
        row = await pool.fetchrow(
            """
            INSERT INTO documents (title, slug)
            VALUES ($1, $2)
            RETURNING id, title, slug, created_at
            """,
            body.title,
            body.slug,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"A document with slug '{body.slug}' already exists.",
        )
    return dict(row)


@router.get("/{slug}", response_model=DocumentWithTextResponse)
async def get_document(
    slug: str,
    pool: asyncpg.Pool = Depends(get_pg_pool),
) -> dict[str, Any]:
    """
    Return document metadata plus the current document text.

    The text is computed by replaying all stored ops through the Python RGA
    implementation in `app/crdt.py`. This is the persistence guarantee: even
    after a server restart with an empty in-memory state, the document text
    is always reconstructed from the durable ops log.
    """
    doc_row = await pool.fetchrow(
        "SELECT id, title, slug, created_at FROM documents WHERE slug = $1",
        slug,
    )
    if doc_row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Document '{slug}' not found.",
        )

    op_rows = await pool.fetch(
        "SELECT op_json FROM ops WHERE document_id = $1 ORDER BY seq",
        doc_row["id"],
    )

    import json as _json
    rga = RGADocument()
    for row in op_rows:
        raw = row["op_json"]
        op_dict = _json.loads(raw) if isinstance(raw, str) else dict(raw)
        op = Operation.from_dict(op_dict)
        rga.apply(op)

    return {**dict(doc_row), "text": rga.get_text()}

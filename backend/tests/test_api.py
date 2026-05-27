"""
REST endpoint integration tests.

Uses the httpx AsyncClient fixture with mocked database dependencies
from conftest.py so these tests run without a live database.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock

import pytest
from httpx import AsyncClient


# ─── /health ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_health(client: AsyncClient) -> None:
    resp = await client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


# ─── /api/slug ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_generate_slug(client: AsyncClient) -> None:
    resp = await client.get("/api/slug")
    assert resp.status_code == 200
    data = resp.json()
    assert "slug" in data
    assert "-" in data["slug"]


# ─── GET /api/documents ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_documents_empty(client: AsyncClient, mock_pg_pool) -> None:
    mock_pg_pool.fetch = AsyncMock(return_value=[])
    resp = await client.get("/api/documents")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_documents_returns_rows(client: AsyncClient, mock_pg_pool) -> None:
    doc_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    mock_row = {
        "id": doc_id,
        "title": "Test Doc",
        "slug": "test-doc",
        "created_at": now,
    }
    # asyncpg rows are dict-like; mock as a list of mappings
    mock_pg_pool.fetch = AsyncMock(return_value=[mock_row])
    resp = await client.get("/api/documents")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["slug"] == "test-doc"
    assert body[0]["title"] == "Test Doc"


# ─── POST /api/documents ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_create_document(client: AsyncClient, mock_pg_pool) -> None:
    doc_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    mock_pg_pool.fetchrow = AsyncMock(return_value={
        "id": doc_id,
        "title": "Hello World",
        "slug": "hello-world",
        "created_at": now,
    })
    resp = await client.post(
        "/api/documents",
        json={"title": "Hello World", "slug": "hello-world"},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["slug"] == "hello-world"
    assert body["title"] == "Hello World"


@pytest.mark.asyncio
async def test_create_document_invalid_slug(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/documents",
        json={"title": "Bad", "slug": "-invalid-start"},
    )
    assert resp.status_code == 422


# ─── GET /api/documents/{slug} ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_document_not_found(client: AsyncClient, mock_pg_pool) -> None:
    mock_pg_pool.fetchrow = AsyncMock(return_value=None)
    resp = await client.get("/api/documents/nonexistent")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_document_with_ops(client: AsyncClient, mock_pg_pool) -> None:
    """
    Create a document with a few ops stored and verify the reconstructed text
    is returned correctly by the GET endpoint.
    """
    doc_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)

    mock_pg_pool.fetchrow = AsyncMock(return_value={
        "id": doc_id,
        "title": "My Doc",
        "slug": "my-doc",
        "created_at": now,
    })

    # Build ops for "hi" — two insert ops
    op1 = {
        "type": "insert",
        "charId": {"siteId": "alice", "clock": 1},
        "value": "h",
        "afterId": None,
        "siteId": "alice",
        "clock": 1,
    }
    op2 = {
        "type": "insert",
        "charId": {"siteId": "alice", "clock": 2},
        "value": "i",
        "afterId": {"siteId": "alice", "clock": 1},
        "siteId": "alice",
        "clock": 2,
    }

    class FakeRow:
        def __init__(self, d):
            self._d = d
        def __getitem__(self, key):
            return self._d[key]

    mock_pg_pool.fetch = AsyncMock(return_value=[
        FakeRow({"op_json": op1}),
        FakeRow({"op_json": op2}),
    ])

    resp = await client.get("/api/documents/my-doc")
    assert resp.status_code == 200
    body = resp.json()
    assert body["text"] == "hi"
    assert body["slug"] == "my-doc"

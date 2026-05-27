"""
pytest fixtures for backend tests.

The API tests spin up an httpx AsyncClient against the FastAPI app with
mocked database dependencies so they run without a live PostgreSQL/MongoDB
instance in CI.
"""

from __future__ import annotations

import json
from typing import Any, AsyncIterator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport

from app.main import app
from app.database import get_pg_pool, get_mongo_db


# ─── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
def mock_pg_pool():
    """Return a mock asyncpg pool that supports basic fetch/fetchrow/execute."""
    pool = AsyncMock()
    return pool


@pytest.fixture
def mock_mongo_db():
    """Return a mock Motor database handle."""
    db = MagicMock()
    db.presence_events = MagicMock()
    db.presence_events.insert_one = AsyncMock()
    db.presence_events.update_one = AsyncMock()
    db.presence_events.create_index = AsyncMock()
    db.documents = MagicMock()
    db.documents.create_index = AsyncMock()
    return db


@pytest_asyncio.fixture
async def client(mock_pg_pool, mock_mongo_db) -> AsyncIterator[AsyncClient]:
    """
    Return an httpx AsyncClient wired to the FastAPI app with mocked DBs.
    Dependencies are overridden so no real DB is required.
    """
    app.dependency_overrides[get_pg_pool] = lambda: mock_pg_pool
    app.dependency_overrides[get_mongo_db] = lambda: mock_mongo_db

    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        yield ac

    app.dependency_overrides.clear()

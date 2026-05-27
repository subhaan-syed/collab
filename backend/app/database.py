"""
Database connection management.

Provides two async singletons:
  - pg_pool: asyncpg connection pool for PostgreSQL
  - mongo_db: Motor AsyncIOMotorDatabase for MongoDB

Both are initialised during the FastAPI lifespan startup and closed on
shutdown. All other modules import the pool/db objects directly rather than
constructing new connections.
"""

from __future__ import annotations

import json

import asyncpg
import motor.motor_asyncio

from app.config import settings


async def _init_connection(conn: asyncpg.Connection) -> None:
    """Register JSON/JSONB codecs so asyncpg returns parsed Python objects.

    The ``format='text'`` argument is required: asyncpg uses the binary wire
    format for built-in types by default, but our custom codec expects text so
    that ``json.loads`` / ``json.dumps`` can process it directly.
    """
    await conn.set_type_codec(
        "jsonb",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
        format="text",
    )
    await conn.set_type_codec(
        "json",
        encoder=json.dumps,
        decoder=json.loads,
        schema="pg_catalog",
        format="text",
    )

# Module-level singletons — populated by init_* functions during lifespan.
pg_pool: asyncpg.Pool | None = None
mongo_client: motor.motor_asyncio.AsyncIOMotorClient | None = None
mongo_db: motor.motor_asyncio.AsyncIOMotorDatabase | None = None


async def init_pg_pool() -> None:
    """Create the asyncpg connection pool."""
    global pg_pool
    pg_pool = await asyncpg.create_pool(
        dsn=settings.database_url,
        min_size=2,
        max_size=10,
        command_timeout=30,
        init=_init_connection,
    )


async def close_pg_pool() -> None:
    global pg_pool
    if pg_pool:
        await pg_pool.close()
        pg_pool = None


async def init_mongo_client() -> None:
    """Create the Motor client and initialise indexes."""
    global mongo_client, mongo_db
    mongo_client = motor.motor_asyncio.AsyncIOMotorClient(settings.mongodb_url)
    mongo_db = mongo_client[settings.mongodb_db_name]

    # Ensure indexes exist (idempotent).
    await mongo_db.presence_events.create_index(
        [("document_id", 1), ("user_id", 1)]
    )
    await mongo_db.presence_events.create_index(
        [("document_id", 1), ("left_at", 1)]
    )
    await mongo_db.documents.create_index("slug", unique=True)


async def close_mongo_client() -> None:
    global mongo_client, mongo_db
    if mongo_client:
        mongo_client.close()
        mongo_client = None
        mongo_db = None


def get_pg_pool() -> asyncpg.Pool:
    """FastAPI dependency — returns the live pool, raises if not initialised."""
    if pg_pool is None:
        raise RuntimeError("PostgreSQL pool is not initialised")
    return pg_pool


def get_mongo_db() -> motor.motor_asyncio.AsyncIOMotorDatabase:
    """FastAPI dependency — returns the live Motor database handle."""
    if mongo_db is None:
        raise RuntimeError("MongoDB client is not initialised")
    return mongo_db

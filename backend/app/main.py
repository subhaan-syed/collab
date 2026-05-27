"""
FastAPI application entry point.

Registers the lifespan handler (DB pool init/teardown), CORS middleware,
and all API routers.
"""

from __future__ import annotations

import logging
import random
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import (
    close_mongo_client,
    close_pg_pool,
    init_mongo_client,
    init_pg_pool,
)
from app.routers.documents import router as documents_router
from app.routers.websocket import router as ws_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Initialise database connections on startup, close them on shutdown."""
    logger.info("Starting Collab backend…")
    await init_pg_pool()
    await init_mongo_client()
    logger.info("Database connections established")
    yield
    logger.info("Shutting down Collab backend…")
    await close_pg_pool()
    await close_mongo_client()


app = FastAPI(
    title="Collab",
    description="Real-time collaborative code editor API",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(documents_router)
app.include_router(ws_router)


# ── Utility endpoint ──────────────────────────────────────────────────────────

# Word lists for slug generation.  The frontend calls this to get a new slug
# before creating a document via POST /api/documents.
_ADJECTIVES = [
    "violet", "amber", "crimson", "silver", "golden", "azure", "coral",
    "indigo", "jade", "scarlet", "teal", "ochre", "mauve", "cobalt",
    "ivory", "ebony", "russet", "fuchsia", "cerise", "verdant",
]
_NOUNS = [
    "thunder", "river", "forest", "canyon", "harbor", "meadow", "eclipse",
    "comet", "summit", "valley", "glacier", "phoenix", "aurora", "zenith",
    "vortex", "nebula", "cascade", "tempest", "solstice", "horizon",
]


@app.get("/api/slug", tags=["utility"])
async def generate_slug() -> dict[str, str]:
    """Return a random two-word slug suitable for a new document URL."""
    slug = f"{random.choice(_ADJECTIVES)}-{random.choice(_NOUNS)}"
    return {"slug": slug}


@app.get("/health", tags=["utility"])
async def health() -> dict[str, str]:
    return {"status": "ok"}

"""
Pydantic models for all wire shapes — request bodies, response models,
WebSocket messages, and CRDT operations.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, field_validator


# ─── CRDT Op wire format ──────────────────────────────────────────────────────


class CharIdModel(BaseModel):
    siteId: str
    clock: int


class OpModel(BaseModel):
    """A single CRDT operation as transmitted over WebSocket / stored in PostgreSQL."""
    type: str  # 'insert' | 'delete'
    charId: CharIdModel
    value: str = ""
    afterId: Optional[CharIdModel] = None
    siteId: str
    clock: int

    @field_validator("type")
    @classmethod
    def type_must_be_valid(cls, v: str) -> str:
        if v not in ("insert", "delete"):
            raise ValueError(f"Op type must be 'insert' or 'delete', got {v!r}")
        return v


# ─── Presence ─────────────────────────────────────────────────────────────────


class PresenceModel(BaseModel):
    """Cursor and selection state for a single user."""
    userId: str
    displayName: str
    color: str
    cursorPosition: int = 0
    selectionStart: int = 0
    selectionEnd: int = 0


# ─── WebSocket messages ───────────────────────────────────────────────────────


class WsOpMessage(BaseModel):
    type: str = "op"
    op: OpModel


class WsPresenceMessage(BaseModel):
    type: str = "presence"
    userId: str
    displayName: str
    color: str
    cursorPosition: int = 0
    selectionStart: int = 0
    selectionEnd: int = 0


# ─── REST request / response bodies ──────────────────────────────────────────


class CreateDocumentRequest(BaseModel):
    title: str
    slug: str

    @field_validator("slug")
    @classmethod
    def slug_must_be_valid(cls, v: str) -> str:
        import re
        if not re.match(r"^[a-z0-9][a-z0-9-]*[a-z0-9]$", v):
            raise ValueError(
                "Slug must contain only lowercase letters, digits, and hyphens, "
                "and must not start or end with a hyphen."
            )
        return v


class DocumentResponse(BaseModel):
    id: UUID
    title: str
    slug: str
    created_at: datetime


class DocumentWithTextResponse(BaseModel):
    id: UUID
    title: str
    slug: str
    created_at: datetime
    text: str


class InitMessage(BaseModel):
    type: str = "init"
    document: dict[str, Any]
    ops: list[dict[str, Any]]
    presenceList: list[dict[str, Any]]

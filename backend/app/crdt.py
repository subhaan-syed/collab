"""
Python mirror of the TypeScript RGA CRDT implementation.

This module reconstructs document state from a persisted ops log. It is used
by the REST endpoint GET /api/documents/{slug} (which returns the current text)
and by the pytest test suite. The WebSocket hot path does NOT call this on
every message — it only persists and forwards ops, relying on the client-side
TypeScript RGA for real-time state maintenance.

The algorithm is identical to the TypeScript version in frontend/src/crdt/rga.ts.
See that file for a detailed explanation of the conflict-resolution scan and
the correctness argument.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


# ─── Types ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CharId:
    """
    Globally unique identifier for a character.
    Uniqueness: (site_id, clock) is never reused within the system.
    frozen=True makes CharId hashable so it can be used as a dict key.
    """
    site_id: str
    clock: int

    def key(self) -> str:
        """String key for use in dictionaries."""
        return f"{self.site_id}:{self.clock}"

    def __lt__(self, other: "CharId") -> bool:
        """Lexicographic order on site_id (used in conflict-resolution)."""
        return self.site_id < other.site_id

    def __gt__(self, other: "CharId") -> bool:
        return self.site_id > other.site_id


# Sentinel head node identifier — never deleted, never emitted in get_text().
HEAD_ID = CharId(site_id="__head__", clock=-1)


@dataclass
class RGANode:
    """
    A node in the RGA linked list.

    `origin_after_id` is the insertion anchor recorded at the time the insert
    operation was created. It is essential for conflict resolution: without it
    the scan cannot distinguish a concurrent sibling (same anchor) from a later
    independent insertion (different anchor).
    """
    id: CharId
    value: str
    deleted: bool = False
    origin_after_id: Optional[CharId] = None
    # Next node id in list order; None means this is the last node.
    next_id: Optional[CharId] = None


@dataclass
class Operation:
    """Wire-format representation of an RGA operation."""
    type: str               # 'insert' | 'delete'
    char_id: CharId
    value: str              # empty string for delete ops
    after_id: Optional[CharId]  # None → insert at head
    site_id: str
    clock: int

    @staticmethod
    def from_dict(d: dict) -> "Operation":
        """Deserialise from the JSONB op_json column."""
        char_id = CharId(site_id=d["charId"]["siteId"], clock=int(d["charId"]["clock"]))
        after_id: Optional[CharId] = None
        if d.get("afterId"):
            after_id = CharId(
                site_id=d["afterId"]["siteId"],
                clock=int(d["afterId"]["clock"]),
            )
        return Operation(
            type=d["type"],
            char_id=char_id,
            value=d.get("value", ""),
            after_id=after_id,
            site_id=d["siteId"],
            clock=int(d["clock"]),
        )


# ─── RGA Document ─────────────────────────────────────────────────────────────


class RGADocument:
    """
    Replicated Growable Array document.

    Maintains a singly-linked list of nodes plus an index (dict) for O(1)
    access by CharId. Deletions are tombstones — nodes are never removed so
    that concurrent inserts can still locate their anchor.
    """

    def __init__(self) -> None:
        # Sentinel head node
        self._head = RGANode(id=HEAD_ID, value="", origin_after_id=None)
        self._index: dict[str, RGANode] = {HEAD_ID.key(): self._head}
        # Buffered delete ops that arrived before the corresponding insert.
        self._pending_deletes: dict[str, list[Operation]] = {}

    # ── Public API ────────────────────────────────────────────────────────────

    def apply(self, op: Operation) -> None:
        """
        Apply a single operation. Safe to call multiple times (idempotent).
        Out-of-order deletes are automatically buffered and applied once the
        corresponding insert arrives.
        """
        if op.type == "insert":
            self._insert(op)
        elif op.type == "delete":
            self._delete(op)
        else:
            raise ValueError(f"Unknown op type: {op.type!r}")

    def apply_all(self, ops: list[Operation]) -> None:
        """
        Replay an ordered ops log to reconstruct document state.
        Equivalent to calling apply() for each op in sequence.
        """
        for op in ops:
            self.apply(op)

    def get_text(self) -> str:
        """Return the current visible document text (tombstones excluded)."""
        parts: list[str] = []
        cursor = self._head.next_id
        while cursor is not None:
            node = self._index[cursor.key()]
            if not node.deleted:
                parts.append(node.value)
            cursor = node.next_id
        return "".join(parts)

    def get_node_count(self) -> int:
        """Return total node count including tombstones (for testing)."""
        return len(self._index) - 1  # exclude sentinel

    # ── Internal ──────────────────────────────────────────────────────────────

    def _insert(self, op: Operation) -> None:
        # Idempotency guard.
        if op.char_id.key() in self._index:
            return

        # Resolve the anchor node.
        anchor_id: CharId = op.after_id if op.after_id is not None else HEAD_ID
        anchor = self._index.get(anchor_id.key())
        if anchor is None:
            raise KeyError(
                f"RGA insert error: anchor {anchor_id.key()} not found "
                f"for op {op.char_id.key()}. Ops must be delivered causally."
            )

        # ── Conflict-resolution rightward scan ──────────────────────────────
        #
        # Walk rightward past all sibling nodes (same origin_after_id) whose
        # site_id is lexicographically greater than op.char_id.site_id.
        # A greater site_id wins the leftward (earlier) position.
        #
        # The scan terminates when:
        #   (a) we reach a node that is not a sibling, or
        #   (b) we reach a sibling with equal or lower site_id priority.
        #
        # Both conditions are site-independent: every replica evaluates the
        # same comparison and reaches the same position.

        current_anchor = anchor
        cursor_id = anchor.next_id

        while cursor_id is not None:
            cursor_node = self._index[cursor_id.key()]

            # Check sibling-hood: does this node share our insertion anchor?
            same_origin = (
                cursor_node.origin_after_id is None
                and anchor_id == HEAD_ID
            ) or (
                cursor_node.origin_after_id is not None
                and cursor_node.origin_after_id == anchor_id
            )

            if same_origin and cursor_node.id > op.char_id:
                # Higher-priority sibling — skip past it.
                current_anchor = cursor_node
                cursor_id = cursor_node.next_id
            else:
                break

        # Splice the new node between current_anchor and cursor_id.
        new_node = RGANode(
            id=op.char_id,
            value=op.value,
            deleted=False,
            origin_after_id=op.after_id,
            next_id=current_anchor.next_id,
        )
        current_anchor.next_id = op.char_id
        self._index[op.char_id.key()] = new_node

        # Drain any delete ops that were waiting for this insert.
        buffered = self._pending_deletes.pop(op.char_id.key(), [])
        for pending_op in buffered:
            self._delete(pending_op)

    def _delete(self, op: Operation) -> None:
        node = self._index.get(op.char_id.key())
        if node is None:
            # Insert has not arrived yet — buffer the delete.
            self._pending_deletes.setdefault(op.char_id.key(), []).append(op)
            return
        # Setting deleted=True is idempotent.
        node.deleted = True

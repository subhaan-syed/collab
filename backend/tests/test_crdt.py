"""
pytest tests for the Python RGA CRDT implementation.

Mirrors the TypeScript Jest tests to verify that the Python backend's CRDT
logic is correct and consistent with the frontend implementation.
"""

import itertools
import pytest

from app.crdt import CharId, Operation, RGADocument


# ─── Helpers ──────────────────────────────────────────────────────────────────


def make_insert(site_id: str, clock: int, value: str, after_id: CharId | None) -> Operation:
    return Operation(
        type="insert",
        char_id=CharId(site_id=site_id, clock=clock),
        value=value,
        after_id=after_id,
        site_id=site_id,
        clock=clock,
    )


def make_delete(char_id: CharId, site_id: str, clock: int) -> Operation:
    return Operation(
        type="delete",
        char_id=char_id,
        value="",
        after_id=None,
        site_id=site_id,
        clock=clock,
    )


def insert_string(doc: RGADocument, site_id: str, start_clock: int, text: str) -> list[CharId]:
    """Insert a full string sequentially and return the list of CharIds."""
    clock = start_clock
    after_id: CharId | None = None
    # Find the last visible char id as starting anchor
    content = doc.get_text()
    # Walk the linked list to find the tail char id
    # We build ops starting from the current tail
    char_ids: list[CharId] = []
    for char in text:
        clock += 1
        op = make_insert(site_id, clock, char, after_id)
        doc.apply(op)
        after_id = op.char_id
        char_ids.append(op.char_id)
    return char_ids


# ─── Test 1: Insert a single character ────────────────────────────────────────

def test_insert_single_char():
    doc = RGADocument()
    op = make_insert("alice", 1, "A", None)
    doc.apply(op)
    assert doc.get_text() == "A"


# ─── Test 2: Insert multiple sequential characters ────────────────────────────

def test_insert_multiple_sequential():
    doc = RGADocument()
    insert_string(doc, "alice", 0, "hello")
    assert doc.get_text() == "hello"


# ─── Test 3: Delete tombstones a character ────────────────────────────────────

def test_delete_tombstone():
    doc = RGADocument()
    op = make_insert("alice", 1, "X", None)
    doc.apply(op)
    assert doc.get_text() == "X"

    del_op = make_delete(op.char_id, "alice", 2)
    doc.apply(del_op)
    assert doc.get_text() == ""

    # Node still exists as tombstone
    assert op.char_id.key() in doc._index
    assert doc._index[op.char_id.key()].deleted is True


# ─── Test 4: Idempotent insert ────────────────────────────────────────────────

def test_idempotent_insert():
    doc = RGADocument()
    op = make_insert("alice", 1, "A", None)
    doc.apply(op)
    doc.apply(op)  # second call must be a no-op
    assert doc.get_text() == "A"
    assert doc.get_node_count() == 1


# ─── Test 5: Idempotent delete ────────────────────────────────────────────────

def test_idempotent_delete():
    doc = RGADocument()
    op = make_insert("alice", 1, "A", None)
    doc.apply(op)

    del_op = make_delete(op.char_id, "alice", 2)
    doc.apply(del_op)
    doc.apply(del_op)  # must not raise
    assert doc.get_text() == ""


# ─── Test 6: Concurrent inserts — siteId tie-break ───────────────────────────

def test_concurrent_insert_site_order():
    alice_op = make_insert("alice", 1, "A", None)
    bob_op = make_insert("bob", 1, "B", None)

    doc1 = RGADocument()
    doc1.apply(alice_op)
    doc1.apply(bob_op)
    result1 = doc1.get_text()

    doc2 = RGADocument()
    doc2.apply(bob_op)
    doc2.apply(alice_op)
    result2 = doc2.get_text()

    # Both orders must converge
    assert result1 == result2
    # 'bob' > 'alice' → Bob's char wins leftward
    assert result1 == "BA"


# ─── Test 7: Commutativity — two independent ops ─────────────────────────────

def test_commutativity_two_ops():
    op_a = make_insert("alice", 1, "X", None)
    op_b = make_insert("charlie", 1, "Y", None)

    doc1 = RGADocument()
    doc1.apply(op_a)
    doc1.apply(op_b)

    doc2 = RGADocument()
    doc2.apply(op_b)
    doc2.apply(op_a)

    assert doc1.get_text() == doc2.get_text()


# ─── Test 8: Out-of-order delete before insert ───────────────────────────────

def test_out_of_order_delete():
    doc = RGADocument()
    insert_op = make_insert("alice", 1, "A", None)
    delete_op = make_delete(insert_op.char_id, "bob", 2)

    doc.apply(delete_op)        # arrives first — must buffer
    assert doc.get_text() == ""  # insert not yet applied

    doc.apply(insert_op)         # buffered delete fires here
    assert doc.get_text() == ""  # character was deleted


# ─── Test 9: Reconstruct from ops log ────────────────────────────────────────

def test_reconstruct_from_ops_log():
    ops: list[Operation] = []
    clock = 0
    after_id: CharId | None = None
    for char in "hello world":
        clock += 1
        op = make_insert("server", clock, char, after_id)
        ops.append(op)
        after_id = op.char_id

    # Delete the space (index 5)
    space_op = ops[5]
    clock += 1
    ops.append(make_delete(space_op.char_id, "server", clock))

    doc = RGADocument()
    doc.apply_all(ops)
    assert doc.get_text() == "helloworld"


# ─── Test 10: Three-way concurrent conflict — all permutations converge ───────

def test_three_way_concurrent_conflict():
    op_a = make_insert("alice", 1, "A", None)
    op_b = make_insert("bob", 1, "B", None)
    op_c = make_insert("charlie", 1, "C", None)

    results = set()
    for perm in itertools.permutations([op_a, op_b, op_c]):
        doc = RGADocument()
        for op in perm:
            doc.apply(op)
        results.add(doc.get_text())

    # All 6 permutations must produce the same result
    assert len(results) == 1
    # 'charlie' > 'bob' > 'alice' → CBA
    assert results.pop() == "CBA"


# ─── Test 11: Interleaved insert and delete ───────────────────────────────────

def test_interleaved_insert_delete():
    doc = RGADocument()
    op_a = make_insert("alice", 1, "A", None)
    op_b = make_insert("alice", 2, "B", op_a.char_id)
    doc.apply(op_a)
    doc.apply(op_b)
    assert doc.get_text() == "AB"

    delete_a = make_delete(op_a.char_id, "alice", 3)
    insert_x = make_insert("bob", 1, "X", op_a.char_id)

    doc1 = RGADocument()
    doc1.apply(op_a)
    doc1.apply(op_b)
    doc1.apply(delete_a)
    doc1.apply(insert_x)

    doc2 = RGADocument()
    doc2.apply(op_a)
    doc2.apply(op_b)
    doc2.apply(insert_x)
    doc2.apply(delete_a)

    assert doc1.get_text() == doc2.get_text()
    assert doc1.get_text() == "XB"


# ─── Test 12: Empty document ──────────────────────────────────────────────────

def test_empty_document():
    doc = RGADocument()
    assert doc.get_text() == ""


# ─── Test 13: Operation.from_dict deserialisation ────────────────────────────

def test_operation_from_dict_insert():
    d = {
        "type": "insert",
        "charId": {"siteId": "alice", "clock": 5},
        "value": "Z",
        "afterId": {"siteId": "bob", "clock": 3},
        "siteId": "alice",
        "clock": 5,
    }
    op = Operation.from_dict(d)
    assert op.type == "insert"
    assert op.char_id == CharId("alice", 5)
    assert op.value == "Z"
    assert op.after_id == CharId("bob", 3)


def test_operation_from_dict_delete_null_after():
    d = {
        "type": "delete",
        "charId": {"siteId": "alice", "clock": 1},
        "value": "",
        "afterId": None,
        "siteId": "alice",
        "clock": 2,
    }
    op = Operation.from_dict(d)
    assert op.type == "delete"
    assert op.after_id is None

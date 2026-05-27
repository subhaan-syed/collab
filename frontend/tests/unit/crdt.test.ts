/**
 * Jest unit tests for the RGA CRDT module.
 *
 * Tests cover: basic insert/delete, idempotency, concurrent edits,
 * out-of-order delivery, commutativity, convergence, position translation,
 * and ops-log reconstruction.
 */

import {
  createDoc,
  applyOp,
  applyAll,
  getContent,
  positionToCharId,
  charIdToPosition,
  createInsertOp,
  createDeleteOp,
  charIdKey,
  type Op,
  type RGADoc,
} from '../../src/crdt/rga';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Insert a full string sequentially at the end of the document. */
function insertString(doc: RGADoc, siteId: string, startClock: number, text: string): number {
  let clock = startClock;
  let afterId = positionToCharId(doc, getContent(doc).length - 1);
  for (const char of text) {
    const op = createInsertOp(siteId, ++clock, char, afterId);
    applyOp(doc, op);
    afterId = op.charId;
  }
  return clock;
}

// ─── Test 1: Insert a single character ────────────────────────────────────────

test('insert single character produces correct content', () => {
  const doc = createDoc();
  const op = createInsertOp('alice', 1, 'A', null);
  applyOp(doc, op);
  expect(getContent(doc)).toBe('A');
});

// ─── Test 2: Insert multiple sequential characters ────────────────────────────

test('multiple sequential inserts produce correct string', () => {
  const doc = createDoc();
  insertString(doc, 'alice', 0, 'hello');
  expect(getContent(doc)).toBe('hello');
});

// ─── Test 3: Delete tombstones a character ────────────────────────────────────

test('deleted character is absent from content but node remains as tombstone', () => {
  const doc = createDoc();
  const insertOp = createInsertOp('alice', 1, 'X', null);
  applyOp(doc, insertOp);
  expect(getContent(doc)).toBe('X');

  const deleteOp = createDeleteOp(insertOp.charId, 'alice', 2);
  applyOp(doc, deleteOp);
  expect(getContent(doc)).toBe('');

  // Node still exists (tombstone preserves insert point for future concurrent inserts)
  expect(doc.nodes.has(charIdKey(insertOp.charId))).toBe(true);
  expect(doc.nodes.get(charIdKey(insertOp.charId))!.deleted).toBe(true);
});

// ─── Test 4: Idempotent insert ────────────────────────────────────────────────

test('applying the same insert op twice produces the same result as once', () => {
  const doc = createDoc();
  const op = createInsertOp('alice', 1, 'A', null);
  applyOp(doc, op);
  applyOp(doc, op); // second application must be a no-op
  expect(getContent(doc)).toBe('A');
  // No duplicate nodes in the list
  let count = 0;
  let cursorId = doc.nodes.get(`__head__:-1`)!.next;
  while (cursorId !== null) {
    const node = doc.nodes.get(`${cursorId.siteId}:${cursorId.clock}`)!;
    if (!node.deleted) count++;
    cursorId = node.next;
  }
  expect(count).toBe(1);
});

// ─── Test 5: Idempotent delete ────────────────────────────────────────────────

test('applying the same delete op twice does not throw and leaves doc in correct state', () => {
  const doc = createDoc();
  const insertOp = createInsertOp('alice', 1, 'A', null);
  applyOp(doc, insertOp);

  const deleteOp = createDeleteOp(insertOp.charId, 'alice', 2);
  applyOp(doc, deleteOp);
  applyOp(doc, deleteOp); // idempotent — must not throw

  expect(getContent(doc)).toBe('');
});

// ─── Test 6: Concurrent inserts at the same position — siteId tie-break ──────

test('concurrent inserts at same position are ordered by siteId (higher siteId wins leftward)', () => {
  // Both Alice and Bob insert after the sentinel (position 0).
  // 'bob' > 'alice' lexicographically, so Bob's char goes first (leftward).
  const doc = createDoc();
  const aliceOp = createInsertOp('alice', 1, 'A', null);
  const bobOp = createInsertOp('bob', 1, 'B', null);

  applyOp(doc, aliceOp);
  applyOp(doc, bobOp);
  expect(getContent(doc)).toBe('BA'); // bob ('b') > alice ('a')

  // Verify same result with reversed arrival order
  const doc2 = createDoc();
  applyOp(doc2, bobOp);
  applyOp(doc2, aliceOp);
  expect(getContent(doc2)).toBe('BA');
});

// ─── Test 7: Commutativity — two independent ops ─────────────────────────────

test('two independent insert ops commute (A then B === B then A)', () => {
  const doc1 = createDoc();
  const doc2 = createDoc();

  // op_a: insert 'H' at position 0
  // op_b: insert 'i' after op_a (only possible if op_a applied first)
  // Use independent positions for true commutativity: both after sentinel
  const opA = createInsertOp('alice', 1, 'X', null);
  const opB = createInsertOp('charlie', 1, 'Y', null);

  applyOp(doc1, opA);
  applyOp(doc1, opB);

  applyOp(doc2, opB);
  applyOp(doc2, opA);

  expect(getContent(doc1)).toBe(getContent(doc2));
});

// ─── Test 8: Out-of-order delete before insert ───────────────────────────────

test('delete arriving before its insert is buffered and applied once insert arrives', () => {
  const doc = createDoc();
  const insertOp = createInsertOp('alice', 1, 'A', null);
  const deleteOp = createDeleteOp(insertOp.charId, 'bob', 2);

  // Apply delete first — should buffer, not throw
  applyOp(doc, deleteOp);
  expect(getContent(doc)).toBe(''); // insert not yet applied

  // Now apply the insert — buffered delete should fire
  applyOp(doc, insertOp);
  expect(getContent(doc)).toBe(''); // char was deleted immediately
});

// ─── Test 9: Reconstruct from ops log ────────────────────────────────────────

test('applyAll correctly reconstructs document from an ops log', () => {
  const ops: Op[] = [];

  // Build an ops log: "hello world"
  const doc = createDoc();
  let clock = 0;
  let afterId = null;
  for (const char of 'hello world') {
    clock++;
    const op = createInsertOp('server', clock, char, afterId);
    ops.push(op);
    afterId = op.charId;
  }

  // Delete the space (index 5)
  const spaceOp = ops[5];
  ops.push(createDeleteOp(spaceOp.charId, 'server', ++clock));

  // Replay on a fresh doc
  const reconstructed = createDoc();
  applyAll(reconstructed, ops);
  expect(getContent(reconstructed)).toBe('helloworld');
});

// ─── Test 10: Three-way concurrent conflict — all permutations converge ──────

test('three concurrent inserts at same position converge under all 6 delivery permutations', () => {
  const opA = createInsertOp('alice', 1, 'A', null);
  const opB = createInsertOp('bob', 1, 'B', null);
  const opC = createInsertOp('charlie', 1, 'C', null);

  // 'charlie' > 'bob' > 'alice' → expected order: CBA
  const permutations = [
    [opA, opB, opC],
    [opA, opC, opB],
    [opB, opA, opC],
    [opB, opC, opA],
    [opC, opA, opB],
    [opC, opB, opA],
  ];

  const results = permutations.map((perm) => {
    const doc = createDoc();
    for (const op of perm) applyOp(doc, op);
    return getContent(doc);
  });

  // All permutations must produce the same result
  const first = results[0];
  for (const result of results) {
    expect(result).toBe(first);
  }
  // 'c' > 'b' > 'a', so 'charlie' leftmost, then 'bob', then 'alice'
  expect(first).toBe('CBA');
});

// ─── Test 11: Interleaved insert and delete at same position ─────────────────

test('concurrent insert at a position being deleted is handled correctly', () => {
  const doc = createDoc();

  // Both sites start with 'AB'
  const opA = createInsertOp('alice', 1, 'A', null);
  const opB = createInsertOp('alice', 2, 'B', opA.charId);
  applyOp(doc, opA);
  applyOp(doc, opB);
  expect(getContent(doc)).toBe('AB');

  // Alice deletes 'A'; Bob concurrently inserts 'X' after 'A'
  const deleteA = createDeleteOp(opA.charId, 'alice', 3);
  const insertX = createInsertOp('bob', 1, 'X', opA.charId);

  // Apply in one order
  const doc1 = createDoc();
  applyOp(doc1, opA);
  applyOp(doc1, opB);
  applyOp(doc1, deleteA);
  applyOp(doc1, insertX);

  // Apply in other order
  const doc2 = createDoc();
  applyOp(doc2, opA);
  applyOp(doc2, opB);
  applyOp(doc2, insertX);
  applyOp(doc2, deleteA);

  // Both must converge
  expect(getContent(doc1)).toBe(getContent(doc2));
  // 'A' deleted, 'X' inserted after where A was, 'B' follows
  expect(getContent(doc1)).toBe('XB');
});

// ─── Test 12: Empty document ──────────────────────────────────────────────────

test('getContent on an empty document returns empty string', () => {
  const doc = createDoc();
  expect(getContent(doc)).toBe('');
});

// ─── Test 13: positionToCharId / charIdToPosition round-trip ─────────────────

test('positionToCharId and charIdToPosition round-trip correctly', () => {
  const doc = createDoc();
  insertString(doc, 'alice', 0, 'abcde');

  for (let i = 0; i < 5; i++) {
    const charId = positionToCharId(doc, i);
    expect(charId).not.toBeNull();
    const pos = charIdToPosition(doc, charId!);
    expect(pos).toBe(i);
  }
});

// ─── Test 14: Insert at position 0 (after sentinel head) ─────────────────────

test('inserting at position 0 (afterId = null) places character at beginning', () => {
  const doc = createDoc();
  const op1 = createInsertOp('alice', 1, 'B', null);
  const op2 = createInsertOp('alice', 2, 'A', null); // also after sentinel
  applyOp(doc, op1);
  applyOp(doc, op2);
  // op2 has clock=2, op1 has clock=1; same siteId 'alice'
  // same originAfterId (sentinel); tie-break: same siteId — fall back to
  // arrival: op1 already placed, op2 scans past no siblings (same siteId, not >),
  // so op2 lands at position 0 ahead of op1 only if siteId matches — actually
  // they share the same siteId so the conflict scan stops immediately.
  // The scan condition is siteId > op.charId.siteId, so 'alice' > 'alice' is false.
  // op2 is inserted before op1 (immediately after anchor which is sentinel after op1 splice).
  // Actually op2 is inserted BEFORE op1 in list order since anchor=sentinel, cursor=op1,
  // siteId 'alice' is NOT > 'alice', so scan stops. New node goes between sentinel and op1.
  expect(getContent(doc)).toBe('AB');
});

// ─── Test 15: Large sequential document ──────────────────────────────────────

test('100-character sequential document has correct length and content', () => {
  const doc = createDoc();
  const text = Array.from({ length: 100 }, (_, i) => String.fromCharCode(65 + (i % 26))).join('');
  insertString(doc, 'alice', 0, text);
  const content = getContent(doc);
  expect(content.length).toBe(100);
  expect(content).toBe(text);
});

// ─── Test 16: positionToCharId returns null for position beyond content ───────

test('positionToCharId returns null when position is beyond document length', () => {
  const doc = createDoc();
  insertString(doc, 'alice', 0, 'hi');
  expect(positionToCharId(doc, 2)).toBeNull(); // only positions 0,1 exist
  expect(positionToCharId(doc, -1)).toBeNull(); // -1 means "before first char"
});

// ─── Test 17: charIdToPosition returns -1 for deleted characters ──────────────

test('charIdToPosition returns -1 for a deleted character', () => {
  const doc = createDoc();
  const op = createInsertOp('alice', 1, 'Z', null);
  applyOp(doc, op);
  const deleteOp = createDeleteOp(op.charId, 'alice', 2);
  applyOp(doc, deleteOp);
  expect(charIdToPosition(doc, op.charId)).toBe(-1);
});

// ─── Test 18: Mixed insert/delete builds correct string ──────────────────────

test('mixed sequence of inserts and deletes produces correct final content', () => {
  const doc = createDoc();
  // Insert "hello"
  let clock = 0;
  let afterId = null;
  const charIds: ReturnType<typeof createInsertOp>['charId'][] = [];
  for (const char of 'hello') {
    const op = createInsertOp('alice', ++clock, char, afterId);
    applyOp(doc, op);
    charIds.push(op.charId);
    afterId = op.charId;
  }
  expect(getContent(doc)).toBe('hello');

  // Delete 'e' (index 1) and 'l' (index 2)
  applyOp(doc, createDeleteOp(charIds[1], 'alice', ++clock));
  applyOp(doc, createDeleteOp(charIds[2], 'alice', ++clock));
  expect(getContent(doc)).toBe('hlo');
});

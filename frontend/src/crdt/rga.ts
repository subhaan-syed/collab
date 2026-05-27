/**
 * RGA (Replicated Growable Array) CRDT — framework-agnostic TypeScript module.
 *
 * An RGA is a sequence CRDT that assigns each character a globally unique
 * identifier and uses a causal ordering rule to resolve concurrent insertions
 * deterministically. The result: any two sites that have received the same set
 * of operations will converge to the same document, regardless of the order
 * in which operations were applied.
 *
 * Key properties:
 *   - Commutativity:  apply(A, apply(B, doc)) === apply(B, apply(A, doc))
 *   - Idempotency:    apply(A, apply(A, doc)) === apply(A, doc)
 *   - Convergence:    all sites with the same op-set produce the same text
 *
 * The document is stored as a singly-linked list with a permanent sentinel
 * head node. Characters are never removed from the list; deletions are
 * recorded as tombstone flags so that concurrent inserts can still locate
 * their insertion point relative to deleted characters.
 */

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Globally unique identifier for a single character.
 * Uniqueness guarantee: a given (siteId, clock) pair is never reused within
 * the system, so the pair uniquely identifies any character ever inserted.
 */
export type CharId = {
  siteId: string;
  clock: number;
};

/**
 * A node in the RGA linked list.
 * `originAfterId` records the insertion anchor at the time of the insert
 * operation. This field is critical: without it the conflict-resolution
 * scan cannot distinguish a "concurrent sibling" (inserted after the same
 * anchor) from a "later independent insertion" (inserted after some
 * subsequent character).
 */
export type RGANode = {
  id: CharId;
  value: string;
  deleted: boolean;
  /**
   * The charId after which this node was originally inserted.
   * null means "inserted at the head (position 0)".
   */
  originAfterId: CharId | null;
  /** Next node id in list order. null means this is the last node. */
  next: CharId | null;
};

/**
 * The RGA document. The `nodes` map is keyed by charIdKey(id).
 * `head` always points to the sentinel node whose siteId is '__head__' and
 * clock is -1. The sentinel is never deleted and never emitted by getContent.
 */
export type RGADoc = {
  nodes: Map<string, RGANode>;
  /** Id of the sentinel head node. */
  head: CharId;
  /**
   * Buffered deletes that arrived before the corresponding insert.
   * Key: charIdKey of the target character.
   */
  pendingDeletes: Map<string, Op[]>;
};

/**
 * An operation that can be applied to an RGA document.
 * The wire format transmitted over WebSocket uses this same shape.
 */
export type Op = {
  type: 'insert' | 'delete';
  /** The character being inserted or deleted. */
  charId: CharId;
  /** Character value. Meaningful only for insert ops; empty string for delete. */
  value: string;
  /**
   * For insert ops: the character after which this one is inserted.
   * null means "insert at position 0 (after the sentinel head)".
   * Unused for delete ops (only charId matters for deletion).
   */
  afterId: CharId | null;
  /** Site that generated this operation. */
  siteId: string;
  /** Logical clock value at the generating site when this op was created. */
  clock: number;
};

// ─── Internal constants ───────────────────────────────────────────────────────

/** The sentinel head node's identifier. */
const HEAD_ID: CharId = { siteId: '__head__', clock: -1 };

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Produce a string key suitable for use in a Map from a CharId.
 * The separator ':' is chosen because siteIds are UUIDs (no colons),
 * so there is no collision risk.
 */
export function charIdKey(id: CharId): string {
  return `${id.siteId}:${id.clock}`;
}

/** Compare two CharIds for structural equality. */
export function charIdEqual(a: CharId, b: CharId): boolean {
  return a.siteId === b.siteId && a.clock === b.clock;
}

// ─── Document lifecycle ───────────────────────────────────────────────────────

/**
 * Create a fresh, empty RGA document.
 * The sentinel head node is pre-inserted. It acts as the anchor for all
 * characters that are inserted at position 0.
 */
export function createDoc(): RGADoc {
  const sentinel: RGANode = {
    id: HEAD_ID,
    value: '',
    deleted: false,
    originAfterId: null,
    next: null,
  };
  const nodes = new Map<string, RGANode>();
  nodes.set(charIdKey(HEAD_ID), sentinel);
  return {
    nodes,
    head: HEAD_ID,
    pendingDeletes: new Map(),
  };
}

// ─── Apply operations ─────────────────────────────────────────────────────────

/**
 * Apply a single operation to the document.
 *
 * This function is idempotent: calling it multiple times with the same op
 * produces the same result as calling it once.
 *
 * It is also safe to call in any order: out-of-order deletes are buffered
 * until the corresponding insert arrives.
 */
export function applyOp(doc: RGADoc, op: Op): void {
  if (op.type === 'insert') {
    applyInsert(doc, op);
  } else {
    applyDelete(doc, op);
  }
}

/**
 * Apply a sequence of operations (e.g. when replaying a persisted ops log).
 * Each op is applied individually; ordering and idempotency are handled
 * inside applyOp.
 */
export function applyAll(doc: RGADoc, ops: Op[]): void {
  for (const op of ops) {
    applyOp(doc, op);
  }
}

// ─── Insert ───────────────────────────────────────────────────────────────────

function applyInsert(doc: RGADoc, op: Op): void {
  // Idempotency guard: if this charId is already in the document, skip.
  if (doc.nodes.has(charIdKey(op.charId))) {
    return;
  }

  // Locate the anchor node (the character after which we are inserting).
  const anchorId: CharId = op.afterId ?? HEAD_ID;
  const anchor = doc.nodes.get(charIdKey(anchorId));
  if (!anchor) {
    // The anchor has not arrived yet. This should not happen in practice
    // because the server delivers ops in causal order. If it does occur in
    // tests simulating arbitrary delivery order, the caller should retry.
    throw new Error(
      `RGA insert error: anchor ${charIdKey(anchorId)} not found. ` +
      `Op ${charIdKey(op.charId)} cannot be applied yet.`
    );
  }

  // ── Conflict-resolution rightward scan ──────────────────────────────────
  //
  // Two concurrent inserts after the same anchor are "siblings". To ensure
  // every site places them in the same relative order, we walk rightward
  // past any sibling that has higher priority (lexicographically greater
  // siteId). A higher siteId wins the leftward (earlier) position.
  //
  // The scan stops as soon as we meet a node that is NOT a sibling of the
  // incoming op (i.e. its originAfterId is different from our anchor), or
  // a sibling with lower or equal siteId priority.
  //
  // Correctness argument:
  //   - Both sites perform the same scan with the same comparison rule.
  //   - The rule only depends on siteId, which is immutable and globally
  //     consistent, so both sites reach the same conclusion regardless of
  //     which op arrived first.

  let currentAnchor = anchor;
  let cursorId = anchor.next;

  while (cursorId !== null) {
    const cursorNode = doc.nodes.get(charIdKey(cursorId))!;

    // Is this node a sibling? Siblings share the same originAfterId as the
    // incoming op's afterId.
    const isSibling =
      (cursorNode.originAfterId === null && anchorId === HEAD_ID) ||
      (cursorNode.originAfterId !== null &&
        anchorId !== null &&
        charIdEqual(cursorNode.originAfterId, anchorId));

    if (isSibling && cursorNode.id.siteId > op.charId.siteId) {
      // This sibling has higher priority — skip past it.
      currentAnchor = cursorNode;
      cursorId = cursorNode.next;
    } else {
      // Either not a sibling, or lower/equal priority. Stop here.
      break;
    }
  }

  // Splice the new node between currentAnchor and cursorId.
  const newNode: RGANode = {
    id: op.charId,
    value: op.value,
    deleted: false,
    originAfterId: op.afterId,
    next: currentAnchor.next,
  };
  currentAnchor.next = op.charId;
  doc.nodes.set(charIdKey(op.charId), newNode);

  // Drain any delete ops that were buffered while waiting for this insert.
  const key = charIdKey(op.charId);
  const buffered = doc.pendingDeletes.get(key);
  if (buffered) {
    doc.pendingDeletes.delete(key);
    for (const pendingOp of buffered) {
      applyDelete(doc, pendingOp);
    }
  }
}

// ─── Delete ───────────────────────────────────────────────────────────────────

function applyDelete(doc: RGADoc, op: Op): void {
  const node = doc.nodes.get(charIdKey(op.charId));
  if (!node) {
    // The insert for this character has not arrived yet.
    // Buffer the delete and apply it once the insert is processed.
    const key = charIdKey(op.charId);
    const pending = doc.pendingDeletes.get(key) ?? [];
    pending.push(op);
    doc.pendingDeletes.set(key, pending);
    return;
  }
  // Tombstone the node. Setting deleted=true is idempotent.
  node.deleted = true;
}

// ─── Content extraction ───────────────────────────────────────────────────────

/**
 * Walk the linked list and return the visible (non-deleted) characters as a
 * plain string.
 */
export function getContent(doc: RGADoc): string {
  const parts: string[] = [];
  let cursorId = doc.nodes.get(charIdKey(doc.head))!.next;
  while (cursorId !== null) {
    const node = doc.nodes.get(charIdKey(cursorId))!;
    if (!node.deleted) {
      parts.push(node.value);
    }
    cursorId = node.next;
  }
  return parts.join('');
}

// ─── Position ↔ CharId translation ──────────────────────────────────────────

/**
 * Convert a zero-based character position in the visible document text to
 * the CharId of the character at that position.
 *
 * Returns null if `pos` is -1 (meaning "before the first character",
 * i.e. after the sentinel head) or if the document has fewer than pos+1
 * visible characters.
 *
 * This is used when generating insert ops from a CodeMirror position:
 *   afterId = positionToCharId(doc, insertionPos - 1)
 */
export function positionToCharId(doc: RGADoc, pos: number): CharId | null {
  if (pos < 0) {
    // pos -1 → insert after sentinel (position 0 in the visible text)
    return null;
  }
  let visibleIndex = -1;
  let cursorId = doc.nodes.get(charIdKey(doc.head))!.next;
  while (cursorId !== null) {
    const node = doc.nodes.get(charIdKey(cursorId))!;
    if (!node.deleted) {
      visibleIndex++;
      if (visibleIndex === pos) {
        return node.id;
      }
    }
    cursorId = node.next;
  }
  return null;
}

/**
 * Convert a CharId to its zero-based position in the current visible text.
 * Returns -1 if the character is deleted or not found.
 */
export function charIdToPosition(doc: RGADoc, id: CharId): number {
  let visibleIndex = 0;
  let cursorId = doc.nodes.get(charIdKey(doc.head))!.next;
  while (cursorId !== null) {
    const node = doc.nodes.get(charIdKey(cursorId))!;
    if (charIdEqual(node.id, id)) {
      return node.deleted ? -1 : visibleIndex;
    }
    if (!node.deleted) {
      visibleIndex++;
    }
    cursorId = node.next;
  }
  return -1;
}

// ─── Op factories ─────────────────────────────────────────────────────────────

/**
 * Create an insert operation.
 *
 * @param siteId  - the local user's site identifier
 * @param clock   - the current logical clock value (increment before passing)
 * @param value   - the character being inserted
 * @param afterId - insert after this character; null means insert at position 0
 */
export function createInsertOp(
  siteId: string,
  clock: number,
  value: string,
  afterId: CharId | null
): Op {
  return {
    type: 'insert',
    charId: { siteId, clock },
    value,
    afterId,
    siteId,
    clock,
  };
}

/**
 * Create a delete operation.
 *
 * @param charId  - the character to delete
 * @param siteId  - the local user's site identifier
 * @param clock   - the current logical clock value (increment before passing)
 */
export function createDeleteOp(
  charId: CharId,
  siteId: string,
  clock: number
): Op {
  return {
    type: 'delete',
    charId,
    value: '',
    afterId: null,
    siteId,
    clock,
  };
}

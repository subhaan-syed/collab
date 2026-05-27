/**
 * Shared TypeScript interfaces used across the frontend.
 * These types mirror the wire format agreed with the FastAPI backend.
 */

import type { Op } from '../crdt/rga';

// ─── User identity ────────────────────────────────────────────────────────────

/** The local user's identity, set in the JoinModal and persisted in localStorage. */
export interface UserInfo {
  userId: string;       // UUID generated once and stored in localStorage
  displayName: string;
  color: string;        // one of the 6 preset hex values
}

// ─── Presence ─────────────────────────────────────────────────────────────────

/** Live presence snapshot for a single peer. */
export interface PresenceState {
  userId: string;
  displayName: string;
  color: string;
  /** Absolute character offset within the document. */
  cursorPosition: number;
  selectionStart: number;
  selectionEnd: number;
  /** Date.now() when this snapshot was last received — used to evict stale peers. */
  lastSeen: number;
}

// ─── Editor ───────────────────────────────────────────────────────────────────

export type EditorLanguage = 'javascript' | 'python' | 'cpp';

// ─── Document metadata ────────────────────────────────────────────────────────

export interface DocumentMeta {
  id: string;
  title: string;
  slug: string;
  created_at: string; // ISO 8601 string from the server
}

// ─── WebSocket message protocol ───────────────────────────────────────────────

/** Message sent from the server to a connecting client. */
export interface InitMessage {
  type: 'init';
  document: { id: string; title: string; slug: string };
  ops: Op[];
  presenceList: PresenceState[];
}

/** An op relayed to all other clients in the room. */
export interface OpMessage {
  type: 'op';
  op: Op;
}

/** Presence update broadcast from another client. */
export interface PresenceMessage {
  type: 'presence';
  userId: string;
  displayName: string;
  color: string;
  cursorPosition: number;
  selectionStart: number;
  selectionEnd: number;
}

export interface UserJoinedMessage {
  type: 'user_joined';
  userId: string;
  displayName: string;
  color: string;
}

export interface UserLeftMessage {
  type: 'user_left';
  userId: string;
}

export type ServerMessage =
  | InitMessage
  | OpMessage
  | PresenceMessage
  | UserJoinedMessage
  | UserLeftMessage;

/** Messages sent from the client to the server. */
export type ClientMessage =
  | { type: 'op'; op: Op }
  | {
      type: 'presence';
      userId: string;
      displayName: string;
      color: string;
      cursorPosition: number;
      selectionStart: number;
      selectionEnd: number;
    };

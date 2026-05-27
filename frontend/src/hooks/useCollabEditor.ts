/**
 * useCollabEditor — central orchestration hook for the collaborative editor.
 *
 * Responsibilities:
 *  1. Owns the CRDT document (docRef) and logical clock (clockRef)
 *  2. Manages the WebSocket connection via useWebSocket
 *  3. Creates and configures the CodeMirror EditorView
 *  4. Translates local CodeMirror changes into CRDT ops and broadcasts them
 *  5. Applies incoming remote ops to both the CRDT doc and the CodeMirror view
 *  6. Maintains remote presence state and updates CodeMirror decorations
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import {
  Annotation,
  Compartment,
  EditorState,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { cpp } from '@codemirror/lang-cpp';
import { oneDark } from '@codemirror/theme-one-dark';
import { basicSetup } from 'codemirror';

import {
  applyOp,
  applyAll,
  charIdToPosition,
  createDoc,
  createDeleteOp,
  createInsertOp,
  getContent,
  positionToCharId,
  type CharId,
  type RGADoc,
} from '../crdt/rga';
import { useWebSocket } from './useWebSocket';
import type {
  EditorLanguage,
  PresenceState,
  ServerMessage,
  UserInfo,
} from '../types';

// ─── Annotation to tag remote transactions ────────────────────────────────────

/**
 * Applied to every transaction dispatched from incoming remote ops.
 * The updateListener checks for this annotation and skips those transactions
 * to avoid re-broadcasting remote changes as local ops.
 */
const RemoteAnnotation = Annotation.define<boolean>();

// ─── Cursor decoration (WidgetDecoration) ────────────────────────────────────

class CursorWidget extends WidgetType {
  constructor(
    private readonly color: string,
    private readonly name: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-cursor-widget';

    const bar = document.createElement('span');
    bar.className = 'cm-cursor-bar';
    bar.style.backgroundColor = this.color;

    const chip = document.createElement('span');
    chip.className = 'cm-cursor-name';
    chip.textContent = this.name;
    chip.style.backgroundColor = this.color;

    wrap.appendChild(bar);
    wrap.appendChild(chip);
    return wrap;
  }

  eq(other: CursorWidget): boolean {
    return other.color === this.color && other.name === this.name;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// ─── StateEffects for presence decorations ───────────────────────────────────

const setCursorsEffect = StateEffect.define<PresenceState[]>();
const setSelectionsEffect = StateEffect.define<PresenceState[]>();

/** StateField holding all remote cursor decorations. */
const cursorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    let mapped = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setCursorsEffect)) {
        const widgets = effect.value
          .map((peer) => {
            const pos = Math.max(0, Math.min(peer.cursorPosition, tr.newDoc.length));
            return Decoration.widget({
              widget: new CursorWidget(peer.color, peer.displayName),
              side: 1,
            }).range(pos);
          })
          .sort((a, b) => a.from - b.from);
        mapped = Decoration.set(widgets, true);
      }
    }
    return mapped;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** StateField holding all remote selection highlight decorations. */
const selectionField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    let mapped = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setSelectionsEffect)) {
        const marks = effect.value
          .filter((p) => p.selectionStart !== p.selectionEnd)
          .map((peer) => {
            const docLen = tr.newDoc.length;
            const from = Math.max(0, Math.min(peer.selectionStart, docLen));
            const to = Math.max(0, Math.min(peer.selectionEnd, docLen));
            if (from >= to) return null;
            return Decoration.mark({
              attributes: { style: `background-color: ${peer.color}4D` },
              class: 'cm-remote-selection',
            }).range(from, to);
          })
          .filter((d): d is ReturnType<typeof Decoration.mark> => d !== null)
          .sort((a, b) => a.from - b.from);
        mapped = Decoration.set(marks, true);
      }
    }
    return mapped;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ─── Language compartment ─────────────────────────────────────────────────────

const languageCompartment = new Compartment();

function getLanguageExtension(lang: EditorLanguage) {
  switch (lang) {
    case 'javascript':
      return javascript({ jsx: true, typescript: true });
    case 'python':
      return python();
    case 'cpp':
      return cpp();
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/** Three-way connection status exposed to the UI. */
export type ConnStatus = 'live' | 'reconnecting' | 'failed';

export interface UseCollabEditorReturn {
  /** Attach this ref callback to the container div that should host CodeMirror. */
  editorContainerRef: (node: HTMLDivElement | null) => void;
  peers: PresenceState[];
  language: EditorLanguage;
  setLanguage: (lang: EditorLanguage) => void;
  connectedCount: number;
  /** Shorthand: true only when connStatus === 'live'. */
  isConnected: boolean;
  /**
   * Three-way status:
   *   'live'        — WS open and 'init' received; ready to edit.
   *   'reconnecting'— trying to connect (or waiting between retries).
   *   'failed'      — gave up after maxRetries; call retryConnect to try again.
   */
  connStatus: ConnStatus;
  /** Reset the retry counter and immediately attempt a new connection. */
  retryConnect: () => void;
}

export function useCollabEditor(
  docId: string,
  userInfo: UserInfo | null,
): UseCollabEditorReturn {
  // ── Mutable singletons (no re-render on change) ──────────────────────────
  const docRef = useRef<RGADoc>(createDoc());
  const viewRef = useRef<EditorView | null>(null);
  const clockRef = useRef<number>(0);
  const userInfoRef = useRef(userInfo);
  userInfoRef.current = userInfo;

  // ── React state (triggers re-render) ─────────────────────────────────────
  const [peers, setPeers] = useState<Map<string, PresenceState>>(new Map());
  const [language, setLanguageState] = useState<EditorLanguage>('javascript');
  const [connectedCount, setConnectedCount] = useState(0);
  /**
   * True only after the server's 'init' message has been fully applied.
   * We expose this as `isConnected` so the UI (and tests) don't treat the
   * editor as ready until the initial document state has been synced.
   */
  const [isInitialized, setIsInitialized] = useState(false);

  const languageRef = useRef<EditorLanguage>('javascript');

  // ── WebSocket URL ─────────────────────────────────────────────────────────
  const wsUrl = userInfo
    ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${docId}/${userInfo.userId}`
    : '';

  // ── Handle incoming server messages ──────────────────────────────────────
  const handleMessage = useCallback((raw: unknown) => {
    const msg = raw as ServerMessage;
    const view = viewRef.current;

    switch (msg.type) {
      case 'init': {
        // Replay full ops log on fresh document
        const freshDoc = createDoc();
        applyAll(freshDoc, msg.ops as Parameters<typeof applyAll>[1]);
        docRef.current = freshDoc;

        if (view) {
          const text = getContent(freshDoc);
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: text },
            annotations: RemoteAnnotation.of(true),
          });
        }

        // Mark the editor as fully initialized — the UI 'Live' indicator and
        // tests gate on this to ensure typing starts only after doc state is in sync.
        setIsInitialized(true);
        break;
      }

      case 'op': {
        const op = msg.op;
        applyOp(docRef.current, op);

        if (!view) break;

        if (op.type === 'insert') {
          // Find the position in the visible text where this char was inserted
          const pos = charIdToPosition(docRef.current, op.charId);
          if (pos >= 0) {
            view.dispatch({
              changes: { from: pos, to: pos, insert: op.value },
              annotations: RemoteAnnotation.of(true),
            });
          }
        } else if (op.type === 'delete') {
          // The node is already marked deleted in the CRDT; now remove from view
          // Re-derive content from scratch to get the correct position
          const textBefore = view.state.doc.toString();
          const textAfter = getContent(docRef.current);
          if (textBefore !== textAfter) {
            // Find the first differing position
            let from = 0;
            while (from < textAfter.length && textBefore[from] === textAfter[from]) {
              from++;
            }
            let toOld = textBefore.length;
            let toNew = textAfter.length;
            while (
              toOld > from &&
              toNew > from &&
              textBefore[toOld - 1] === textAfter[toNew - 1]
            ) {
              toOld--;
              toNew--;
            }
            view.dispatch({
              changes: {
                from,
                to: toOld,
                insert: textAfter.slice(from, toNew),
              },
              annotations: RemoteAnnotation.of(true),
            });
          }
        }
        break;
      }

      case 'presence': {
        setPeers((prev) => {
          const next = new Map(prev);
          next.set(msg.userId, {
            userId: msg.userId,
            displayName: msg.displayName,
            color: msg.color,
            cursorPosition: msg.cursorPosition,
            selectionStart: msg.selectionStart,
            selectionEnd: msg.selectionEnd,
            lastSeen: Date.now(),
          });
          return next;
        });
        break;
      }

      case 'user_joined': {
        setConnectedCount((n) => n + 1);
        break;
      }

      case 'user_left': {
        setConnectedCount((n) => Math.max(0, n - 1));
        setPeers((prev) => {
          const next = new Map(prev);
          next.delete(msg.userId);
          return next;
        });
        break;
      }
    }
  }, []);

  const { readyState, send, reconnect } = useWebSocket(wsUrl, {
    onMessage: handleMessage,
    // Reset initialized flag on every disconnect so that after a reconnect
    // we wait for a fresh 'init' before reporting 'Live' again.
    onClose: () => setIsInitialized(false),
    enabled: !!userInfo,
    maxRetries: 8,
  });

  const sendRef = useRef(send);
  sendRef.current = send;

  // ── Send presence update ──────────────────────────────────────────────────
  const sendPresence = useCallback(
    (cursorPos: number, selStart: number, selEnd: number) => {
      const u = userInfoRef.current;
      if (!u) return;
      sendRef.current({
        type: 'presence',
        userId: u.userId,
        displayName: u.displayName,
        color: u.color,
        cursorPosition: cursorPos,
        selectionStart: selStart,
        selectionEnd: selEnd,
      });
    },
    [],
  );

  // ── Update decoration fields whenever peers change ────────────────────────
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const peerList = Array.from(peers.values()).filter(
      (p) => p.userId !== userInfoRef.current?.userId,
    );
    view.dispatch({
      effects: [
        setCursorsEffect.of(peerList),
        setSelectionsEffect.of(peerList),
      ],
    });
  }, [peers]);

  // ── Stale peer eviction ───────────────────────────────────────────────────
  useEffect(() => {
    const interval = setInterval(() => {
      const threshold = Date.now() - 20_000;
      setPeers((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [id, p] of next) {
          if (p.lastSeen < threshold) {
            next.delete(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 10_000);
    return () => clearInterval(interval);
  }, []);

  // ── Language change ───────────────────────────────────────────────────────
  const setLanguage = useCallback((lang: EditorLanguage) => {
    languageRef.current = lang;
    setLanguageState(lang);
    const view = viewRef.current;
    if (view) {
      view.dispatch({
        effects: languageCompartment.reconfigure(getLanguageExtension(lang)),
      });
    }
  }, []);

  // ── CodeMirror container ref callback ────────────────────────────────────
  const editorContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) {
        viewRef.current?.destroy();
        viewRef.current = null;
        return;
      }
      if (viewRef.current) return; // already mounted

      const view = new EditorView({
        state: EditorState.create({
          doc: '',
          extensions: [
            basicSetup,
            languageCompartment.of(getLanguageExtension(languageRef.current)),
            oneDark,
            cursorField,
            selectionField,
            // Listen to all document changes
            EditorView.updateListener.of((update: ViewUpdate) => {
              if (!update.docChanged) {
                // Still send presence on cursor/selection moves
                if (update.selectionSet) {
                  const sel = update.state.selection.main;
                  sendPresence(sel.head, sel.from, sel.to);
                }
                return;
              }

              // Skip transactions that came from remote ops
              if (
                update.transactions.some((tr) =>
                  tr.annotation(RemoteAnnotation),
                )
              ) {
                return;
              }

              // Generate CRDT ops for each local change
              update.changes.iterChanges(
                (fromA, toA, _fromB, _toB, inserted) => {
                  const u = userInfoRef.current;
                  if (!u) return;

                  // ── Deletions ────────────────────────────────────────
                  // Process deletions right-to-left to keep positions stable
                  for (let pos = toA - 1; pos >= fromA; pos--) {
                    const charId = positionToCharId(docRef.current, pos);
                    if (charId) {
                      const op = createDeleteOp(
                        charId,
                        u.userId,
                        ++clockRef.current,
                      );
                      applyOp(docRef.current, op);
                      sendRef.current({ type: 'op', op });
                    }
                  }

                  // ── Insertions ───────────────────────────────────────
                  // afterId is the char at (fromA - 1) after deletions were applied
                  let afterId: CharId | null = positionToCharId(
                    docRef.current,
                    fromA - 1,
                  );
                  const text = inserted.sliceString(0);
                  for (const char of text) {
                    const op = createInsertOp(
                      u.userId,
                      ++clockRef.current,
                      char,
                      afterId,
                    );
                    applyOp(docRef.current, op);
                    sendRef.current({ type: 'op', op });
                    afterId = op.charId;
                  }
                },
              );

              // Send presence update with new cursor position
              const sel = update.state.selection.main;
              sendPresence(sel.head, sel.from, sel.to);
            }),
            EditorView.theme({
              '&': { height: '100%' },
              '.cm-scroller': { overflow: 'auto' },
            }),
          ],
        }),
        parent: node,
      });

      viewRef.current = view;
    },
    [sendPresence],
  );

  const peerArray = Array.from(peers.values());

  // Derive the three-way status from readyState + isInitialized.
  const connStatus: ConnStatus =
    readyState === 'open' && isInitialized
      ? 'live'
      : readyState === 'failed'
        ? 'failed'
        : 'reconnecting';

  return {
    editorContainerRef,
    peers: peerArray,
    language,
    setLanguage,
    connectedCount,
    isConnected: connStatus === 'live',
    connStatus,
    retryConnect: reconnect,
  };
}

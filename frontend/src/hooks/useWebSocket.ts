/**
 * Custom WebSocket hook with automatic reconnection, send queue, and a
 * hard retry limit that surfaces a 'failed' state instead of looping forever.
 *
 * Features:
 *  - Exponential back-off reconnect (500 ms → doubles → capped at MAX_DELAY ms)
 *  - Hard retry limit (maxRetries, default 8). After the limit the hook
 *    transitions to readyState === 'failed' and stops retrying automatically.
 *  - `reconnect()` resets the counter and tries again — for a manual "Retry"
 *    action in the UI.
 *  - Messages sent before the connection is open are queued and flushed on
 *    first connect.
 *  - Stable `send` and `reconnect` callbacks that never need to be listed as
 *    effect dependencies.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type ReadyState = 'connecting' | 'open' | 'closed' | 'failed';

const INITIAL_DELAY = 500;   // ms
const MAX_DELAY     = 16_000; // ms

interface UseWebSocketOptions {
  onMessage: (data: unknown) => void;
  onOpen?: () => void;
  onClose?: () => void;
  /** Stop automatic reconnection when connection is not possible. */
  enabled?: boolean;
  /**
   * Maximum number of reconnect attempts before giving up and setting
   * readyState to 'failed'.  0 = never retry; Infinity = retry forever.
   * @default 8
   */
  maxRetries?: number;
}

export function useWebSocket(url: string, options: UseWebSocketOptions) {
  const {
    onMessage,
    onOpen,
    onClose,
    enabled = true,
    maxRetries = 8,
  } = options;

  const wsRef              = useRef<WebSocket | null>(null);
  const queueRef           = useRef<string[]>([]);
  const reconnectTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const delayRef           = useRef<number>(INITIAL_DELAY);
  const retryCountRef      = useRef<number>(0);
  const unmountedRef       = useRef<boolean>(false);

  // Keep latest callbacks stable inside effects.
  const onMessageRef = useRef(onMessage); onMessageRef.current = onMessage;
  const onOpenRef    = useRef(onOpen);    onOpenRef.current    = onOpen;
  const onCloseRef   = useRef(onClose);   onCloseRef.current   = onClose;

  const [readyState, setReadyState] = useState<ReadyState>('closed');

  // ── Core connect logic ──────────────────────────────────────────────────────
  const connect = useCallback(() => {
    if (unmountedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    setReadyState('connecting');
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (unmountedRef.current) { ws.close(); return; }
      // Reset back-off and retry counter on a successful connection.
      delayRef.current     = INITIAL_DELAY;
      retryCountRef.current = 0;
      setReadyState('open');
      onOpenRef.current?.();

      // Flush any messages queued while we were connecting.
      while (queueRef.current.length > 0) {
        ws.send(queueRef.current.shift()!);
      }
    };

    ws.onmessage = (event) => {
      if (unmountedRef.current) return;
      try {
        onMessageRef.current(JSON.parse(event.data as string));
      } catch {
        // ignore malformed frames
      }
    };

    ws.onclose = () => {
      if (unmountedRef.current) return;
      setReadyState('closed');
      onCloseRef.current?.();

      retryCountRef.current += 1;

      if (retryCountRef.current > maxRetries) {
        // Give up — transition to permanent failure state.
        setReadyState('failed');
        return;
      }

      // Schedule next attempt with exponential back-off.
      const delay = delayRef.current;
      delayRef.current = Math.min(delay * 2, MAX_DELAY);
      reconnectTimerRef.current = setTimeout(() => {
        if (!unmountedRef.current) connect();
      }, delay);
    };

    ws.onerror = () => {
      // onclose fires right after onerror and handles reconnect.
      ws.close();
    };
  }, [url, maxRetries]);

  // ── Effect: open / close on url / enabled changes ──────────────────────────
  useEffect(() => {
    unmountedRef.current = false;
    if (enabled) {
      connect();
    }
    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [url, enabled, connect]);

  // ── Send (queued when not yet open) ────────────────────────────────────────
  const send = useCallback((data: unknown) => {
    const serialised = JSON.stringify(data);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(serialised);
    } else {
      queueRef.current.push(serialised);
    }
  }, []);

  // ── Manual reconnect (resets retry counter) ────────────────────────────────
  const reconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    wsRef.current?.close();
    wsRef.current = null;
    delayRef.current      = INITIAL_DELAY;
    retryCountRef.current = 0;
    connect();
  }, [connect]);

  return { readyState, send, reconnect };
}

import type { ConnStatus } from '../../hooks/useCollabEditor';
import type { EditorLanguage } from '../../types';
import styles from './Toolbar.module.scss';

interface ToolbarProps {
  docTitle: string;
  language: EditorLanguage;
  onLanguageChange: (lang: EditorLanguage) => void;
  connectedCount: number;
  /** Shorthand bool — kept for backward-compat with unit tests. */
  isConnected: boolean;
  /**
   * Three-way status from useCollabEditor.
   * Defaults to deriving from isConnected so existing tests keep passing.
   */
  connStatus?: ConnStatus;
  /** Called when the user clicks "Retry" after a failed connection. */
  onRetryConnect?: () => void;
}

const LANGUAGES: { value: EditorLanguage; label: string }[] = [
  { value: 'javascript', label: 'JavaScript' },
  { value: 'python',     label: 'Python' },
  { value: 'cpp',        label: 'C++' },
];

export function Toolbar({
  docTitle,
  language,
  onLanguageChange,
  connectedCount,
  isConnected,
  connStatus,
  onRetryConnect,
}: ToolbarProps) {
  // If the caller supplies the richer connStatus, use it; otherwise derive it.
  const status: ConnStatus = connStatus ?? (isConnected ? 'live' : 'reconnecting');

  return (
    <header className={styles.toolbar} role="banner">
      <div className={styles.left}>
        <span className={styles.docTitle} title={docTitle}>
          {docTitle}
        </span>
        <label htmlFor="lang-select" className="visually-hidden">
          Programming language
        </label>
        <select
          id="lang-select"
          className={styles.langSelect}
          value={language}
          onChange={(e) => onLanguageChange(e.target.value as EditorLanguage)}
          data-testid="lang-select"
        >
          {LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.right}>
        {/* ── Connection status badge ─────────────────────────────────── */}
        {status === 'failed' ? (
          <>
            <span
              className={`${styles.connStatus} ${styles.failed}`}
              role="status"
              aria-live="assertive"
              data-testid="conn-status"
            >
              Connection failed
            </span>
            <button
              className={styles.retryBtn}
              onClick={onRetryConnect}
              data-testid="conn-retry"
              aria-label="Retry WebSocket connection"
            >
              Retry
            </button>
          </>
        ) : (
          <span
            className={`${styles.connStatus} ${status === 'live' ? styles.connected : styles.disconnected}`}
            role="status"
            aria-live="polite"
            data-testid="conn-status"
          >
            {status === 'live' ? 'Live' : 'Reconnecting…'}
          </span>
        )}

        {/* ── Online peer count ───────────────────────────────────────── */}
        {connectedCount > 0 && (
          <span
            className={styles.onlineBadge}
            aria-label={`${connectedCount} other user${connectedCount === 1 ? '' : 's'} online`}
            data-testid="online-badge"
          >
            {connectedCount} online
          </span>
        )}
      </div>
    </header>
  );
}

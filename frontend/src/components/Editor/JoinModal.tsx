import React, { useEffect, useRef, useState } from 'react';
import type { UserInfo } from '../../types';
import styles from './JoinModal.module.scss';

interface JoinModalProps {
  onJoin: (info: UserInfo) => void;
}

// The 6 WCAG-AA verified presence colors (matches _variables.scss)
const PRESET_COLORS: { hex: string; name: string }[] = [
  { hex: '#c0392b', name: 'Red' },
  { hex: '#1a7a5e', name: 'Green' },
  { hex: '#b5601a', name: 'Orange' },
  { hex: '#2874a6', name: 'Blue' },
  { hex: '#6c3483', name: 'Purple' },
  { hex: '#17736b', name: 'Teal' },
];

function getStoredPrefs(): { displayName: string; color: string } | null {
  try {
    const raw = localStorage.getItem('collab:userPrefs');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getOrCreateUserId(): string {
  let id = localStorage.getItem('collab:userId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('collab:userId', id);
  }
  return id;
}

export function JoinModal({ onJoin }: JoinModalProps) {
  const prefs = getStoredPrefs();
  const [displayName, setDisplayName] = useState(prefs?.displayName ?? '');
  const [selectedColor, setSelectedColor] = useState(
    prefs?.color ?? PRESET_COLORS[0].hex,
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const firstSwatchRef = useRef<HTMLButtonElement>(null);

  // Focus the input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Trap focus within modal
  useEffect(() => {
    const modal = document.getElementById('join-modal');
    if (!modal) return;
    const focusable = modal.querySelectorAll<HTMLElement>(
      'input, button, [tabindex]:not([tabindex="-1"])',
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = displayName.trim();
    if (!name) return;

    const userId = getOrCreateUserId();
    localStorage.setItem(
      'collab:userPrefs',
      JSON.stringify({ displayName: name, color: selectedColor }),
    );

    onJoin({ userId, displayName: name, color: selectedColor });
  }

  return (
    <div className={styles.backdrop} role="presentation">
      <div
        id="join-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="join-modal-title"
        className={styles.modal}
      >
        <h1 id="join-modal-title" className={styles.title}>
          Welcome to Collab
        </h1>
        <p className={styles.subtitle}>
          Choose a display name and color before joining.
        </p>

        <form onSubmit={handleSubmit} noValidate>
          <div className={styles.field}>
            <label htmlFor="display-name" className={styles.label}>
              Display name
            </label>
            <input
              id="display-name"
              ref={inputRef}
              type="text"
              className={styles.input}
              placeholder="e.g. Alice"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={30}
              autoComplete="nickname"
            />
          </div>

          <div className={styles.field}>
            <span className={styles.label} id="color-label">
              Your color
            </span>
            <div
              className={styles.colorSwatches}
              role="radiogroup"
              aria-labelledby="color-label"
            >
              {PRESET_COLORS.map((c, i) => (
                <button
                  key={c.hex}
                  ref={i === 0 ? firstSwatchRef : undefined}
                  type="button"
                  className={`${styles.swatch}${selectedColor === c.hex ? ` ${styles.selected}` : ''}`}
                  style={{ backgroundColor: c.hex }}
                  aria-label={`Pick ${c.name}`}
                  aria-pressed={selectedColor === c.hex}
                  data-testid={`color-swatch-${i}`}
                  onClick={() => setSelectedColor(c.hex)}
                />
              ))}
            </div>
          </div>

          <div className={styles.actions}>
            <button
              type="submit"
              className={styles.submitBtn}
              disabled={!displayName.trim()}
              data-testid="join-submit"
            >
              Join document
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * React Testing Library tests for the PresenceSidebar component.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { PresenceSidebar } from '../../src/components/Editor/PresenceSidebar';
import type { PresenceState, UserInfo } from '../../src/types';
import '@testing-library/jest-dom';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const selfInfo: UserInfo = {
  userId: 'self-123',
  displayName: 'Alice',
  color: '#c0392b',
};

function makePresence(override: Partial<PresenceState> = {}): PresenceState {
  return {
    userId: 'user-456',
    displayName: 'Bob',
    color: '#2874a6',
    cursorPosition: 0,
    selectionStart: 0,
    selectionEnd: 0,
    lastSeen: Date.now(),
    ...override,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test('renders the sidebar with accessible landmark role', () => {
  render(<PresenceSidebar peers={[]} selfInfo={null} />);
  expect(screen.getByRole('complementary')).toBeInTheDocument();
});

test('renders the self user entry with "(you)" label', () => {
  render(<PresenceSidebar peers={[]} selfInfo={selfInfo} />);
  expect(screen.getByText(/alice/i)).toBeInTheDocument();
  expect(screen.getByText(/you/i)).toBeInTheDocument();
});

test('renders peer users in the presence list', () => {
  const peers = [makePresence()];
  render(<PresenceSidebar peers={peers} selfInfo={null} />);
  expect(screen.getByText('Bob')).toBeInTheDocument();
});

test('renders colored chips for each user', () => {
  const peers = [makePresence()];
  render(<PresenceSidebar peers={peers} selfInfo={selfInfo} />);
  const items = screen.getAllByTestId('presence-item');
  // 2 users: self + 1 peer
  expect(items).toHaveLength(2);
});

test('renders "no one else here" when no peers and no self', () => {
  render(<PresenceSidebar peers={[]} selfInfo={null} />);
  expect(screen.getByText(/no one else here/i)).toBeInTheDocument();
});

test('applies the correct background color to each chip', () => {
  const peers = [makePresence({ color: '#2874a6', displayName: 'Bob' })];
  render(<PresenceSidebar peers={peers} selfInfo={null} />);
  const chip = screen.getByTitle('Bob');
  expect(chip).toHaveStyle({ backgroundColor: '#2874a6' });
});

/**
 * React Testing Library tests for the JoinModal component.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JoinModal } from '../../src/components/Editor/JoinModal';
import '@testing-library/jest-dom';

// ─── localStorage mock ────────────────────────────────────────────────────────

beforeEach(() => {
  // Clear localStorage before each test
  localStorage.clear();
  // Provide crypto.randomUUID in jsdom
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID: () => 'test-uuid-1234' },
    configurable: true,
  });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test('renders the dialog with accessible role', () => {
  render(<JoinModal onJoin={jest.fn()} />);
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

test('renders the display name input', () => {
  render(<JoinModal onJoin={jest.fn()} />);
  expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
});

test('renders 6 color swatch buttons', () => {
  render(<JoinModal onJoin={jest.fn()} />);
  // Each swatch has data-testid="color-swatch-{i}"
  for (let i = 0; i < 6; i++) {
    expect(screen.getByTestId(`color-swatch-${i}`)).toBeInTheDocument();
  }
});

test('submit button is disabled when display name is empty', () => {
  render(<JoinModal onJoin={jest.fn()} />);
  const btn = screen.getByTestId('join-submit');
  expect(btn).toBeDisabled();
});

test('submit button is enabled after typing a display name', async () => {
  const user = userEvent.setup();
  render(<JoinModal onJoin={jest.fn()} />);
  await user.type(screen.getByLabelText(/display name/i), 'Alice');
  expect(screen.getByTestId('join-submit')).not.toBeDisabled();
});

test('clicking a color swatch marks it as selected', async () => {
  const user = userEvent.setup();
  render(<JoinModal onJoin={jest.fn()} />);
  const swatch = screen.getByTestId('color-swatch-2');
  await user.click(swatch);
  expect(swatch).toHaveAttribute('aria-pressed', 'true');
});

test('submitting the form calls onJoin with user info', async () => {
  const onJoin = jest.fn();
  const user = userEvent.setup();
  render(<JoinModal onJoin={onJoin} />);

  await user.type(screen.getByLabelText(/display name/i), 'Alice');
  await user.click(screen.getByTestId('join-submit'));

  expect(onJoin).toHaveBeenCalledWith(
    expect.objectContaining({
      displayName: 'Alice',
      userId: expect.any(String),
      color: expect.any(String),
    }),
  );
});

test('pre-fills display name from localStorage if stored', () => {
  localStorage.setItem(
    'collab:userPrefs',
    JSON.stringify({ displayName: 'Bob', color: '#2874a6' }),
  );
  render(<JoinModal onJoin={jest.fn()} />);
  const input = screen.getByLabelText(/display name/i) as HTMLInputElement;
  expect(input.value).toBe('Bob');
});

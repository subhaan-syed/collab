/**
 * React Testing Library tests for the Toolbar component.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Toolbar } from '../../src/components/Editor/Toolbar';
import '@testing-library/jest-dom';

// ─── Tests ────────────────────────────────────────────────────────────────────

const defaultProps = {
  docTitle: 'violet-thunder',
  language: 'javascript' as const,
  onLanguageChange: jest.fn(),
  connectedCount: 0,
  isConnected: true,
};

test('renders the document title', () => {
  render(<Toolbar {...defaultProps} />);
  expect(screen.getByText('violet-thunder')).toBeInTheDocument();
});

test('renders the language selector with all three options', () => {
  render(<Toolbar {...defaultProps} />);
  const select = screen.getByTestId('lang-select');
  expect(select).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'JavaScript' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Python' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'C++' })).toBeInTheDocument();
});

test('language selector shows the current language as selected', () => {
  render(<Toolbar {...defaultProps} language="python" />);
  const select = screen.getByTestId('lang-select') as HTMLSelectElement;
  expect(select.value).toBe('python');
});

test('onLanguageChange is called when the language selector changes', () => {
  const onLangChange = jest.fn();
  render(<Toolbar {...defaultProps} onLanguageChange={onLangChange} />);
  const select = screen.getByTestId('lang-select');
  fireEvent.change(select, { target: { value: 'cpp' } });
  expect(onLangChange).toHaveBeenCalledWith('cpp');
});

test('shows "Live" status when isConnected is true', () => {
  render(<Toolbar {...defaultProps} isConnected={true} />);
  expect(screen.getByTestId('conn-status')).toHaveTextContent('Live');
});

test('shows "Reconnecting" status when isConnected is false', () => {
  render(<Toolbar {...defaultProps} isConnected={false} />);
  expect(screen.getByTestId('conn-status')).toHaveTextContent('Reconnecting');
});

test('shows online badge when connectedCount > 0', () => {
  render(<Toolbar {...defaultProps} connectedCount={2} />);
  expect(screen.getByTestId('online-badge')).toHaveTextContent('2 online');
});

test('hides online badge when connectedCount is 0', () => {
  render(<Toolbar {...defaultProps} connectedCount={0} />);
  expect(screen.queryByTestId('online-badge')).not.toBeInTheDocument();
});

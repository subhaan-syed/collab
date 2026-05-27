/**
 * React Testing Library tests for the HomePage component.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { HomePage } from '../../src/components/HomePage/HomePage';
import '@testing-library/jest-dom';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

function renderHomePage() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockNavigate.mockClear();
});

test('renders the Collab logo and tagline', async () => {
  global.fetch = jest.fn().mockResolvedValue({
    json: async () => [],
  }) as unknown as typeof fetch;

  renderHomePage();
  expect(screen.getByRole('heading', { name: /collab/i })).toBeInTheDocument();
  // The tagline and the new explainer paragraph both contain the phrase, so
  // assert that at least one element matches rather than expecting exactly one.
  expect(screen.getAllByText(/real-time collaborative/i).length).toBeGreaterThan(0);
});

test('renders the New Document button', async () => {
  global.fetch = jest.fn().mockResolvedValue({
    json: async () => [],
  }) as unknown as typeof fetch;

  renderHomePage();
  expect(screen.getByTestId('new-doc-btn')).toBeInTheDocument();
});

test('renders empty state when no documents exist', async () => {
  global.fetch = jest.fn().mockResolvedValue({
    json: async () => [],
  }) as unknown as typeof fetch;

  renderHomePage();
  await waitFor(() =>
    expect(screen.getByText(/no documents yet/i)).toBeInTheDocument(),
  );
});

test('renders document list when documents are returned', async () => {
  global.fetch = jest.fn().mockResolvedValue({
    json: async () => [
      {
        id: '1',
        title: 'violet-thunder',
        slug: 'violet-thunder',
        created_at: new Date().toISOString(),
      },
      {
        id: '2',
        title: 'azure-river',
        slug: 'azure-river',
        created_at: new Date().toISOString(),
      },
    ],
  }) as unknown as typeof fetch;

  renderHomePage();
  await waitFor(() =>
    expect(screen.getAllByTestId('doc-item')).toHaveLength(2),
  );
  expect(screen.getByText('violet-thunder')).toBeInTheDocument();
  expect(screen.getByText('azure-river')).toBeInTheDocument();
});

test('clicking a document item navigates to /doc/{slug}', async () => {
  global.fetch = jest.fn().mockResolvedValue({
    json: async () => [
      {
        id: '1',
        title: 'violet-thunder',
        slug: 'violet-thunder',
        created_at: new Date().toISOString(),
      },
    ],
  }) as unknown as typeof fetch;

  renderHomePage();
  await waitFor(() => screen.getByTestId('doc-item'));
  fireEvent.click(screen.getByTestId('doc-item'));
  expect(mockNavigate).toHaveBeenCalledWith('/doc/violet-thunder');
});

test('New Document button calls the create API and navigates', async () => {
  let callCount = 0;
  global.fetch = jest.fn().mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      // Initial document list
      return Promise.resolve({ json: async () => [] });
    }
    if (callCount === 2) {
      // /api/slug
      return Promise.resolve({ json: async () => ({ slug: 'violet-thunder' }) });
    }
    // /api/documents POST
    return Promise.resolve({ json: async () => ({ id: '1', slug: 'violet-thunder' }) });
  }) as unknown as typeof fetch;

  renderHomePage();
  await waitFor(() => screen.getByTestId('new-doc-btn'));
  fireEvent.click(screen.getByTestId('new-doc-btn'));

  await waitFor(() =>
    expect(mockNavigate).toHaveBeenCalledWith('/doc/violet-thunder'),
  );
});

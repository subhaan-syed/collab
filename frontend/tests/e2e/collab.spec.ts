/**
 * Playwright end-to-end tests for real-time collaborative editing.
 *
 * Each test uses two isolated BrowserContext instances so they behave as
 * completely independent users (separate localStorage, cookies, WebSocket
 * connections). A real backend + WebSocket server must be running at
 * http://localhost:8000 for these tests to pass.
 *
 * Run with:
 *   npx playwright test
 *
 * Prerequisites:
 *   docker-compose up  (or equivalent)
 *   npm run dev        (Vite dev server — started automatically by playwright.config.ts)
 */

import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Complete the JoinModal for a given page. */
async function joinAsUser(
  page: Page,
  name: string,
  colorIndex = 0,
): Promise<void> {
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
  await page.getByLabel('Display name').fill(name);
  await page.getByTestId(`color-swatch-${colorIndex}`).click();
  await page.getByTestId('join-submit').click();
  // Wait for modal to dismiss
  await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5_000 });
}

/** Click into the CodeMirror editor and type text. */
async function typeInEditor(page: Page, text: string): Promise<void> {
  const content = page.locator('.cm-content');
  await content.click();
  await page.keyboard.type(text);
}

/**
 * Get the typed code content of the CodeMirror editor.
 * Uses page.evaluate so we can strip cursor-widget DOM nodes (name chips
 * rendered as WidgetDecorations) before reading innerText — without this,
 * the cursor names would pollute the returned string.
 */
async function getEditorText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const content = document.querySelector('.cm-content');
    if (!content) return '';
    const clone = content.cloneNode(true) as Element;
    // Remove cursor-name chips (rendered by CursorWidget.toDOM)
    clone.querySelectorAll('.cm-cursor-widget').forEach((el) => el.remove());
    return (clone as HTMLElement).innerText.trim();
  });
}

// ─── Shared browser instance ──────────────────────────────────────────────────

let browser: Browser;

test.beforeAll(async () => {
  browser = await chromium.launch();
});

test.afterAll(async () => {
  await browser.close();
});

// ─── Test suite ───────────────────────────────────────────────────────────────

test.describe('Real-time collaborative editing', () => {
  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;
  // Each test gets its own slug so tests never share document state.
  let docSlug: string;

  test.beforeEach(async () => {
    docSlug = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const baseURL = 'http://localhost:5173';
    ctxA = await browser.newContext({ baseURL });
    ctxB = await browser.newContext({ baseURL });
    pageA = await ctxA.newPage();
    pageB = await ctxB.newPage();

    // Create the document via the API before both clients connect.
    await pageA.request.post('http://localhost:8000/api/documents', {
      data: { title: docSlug, slug: docSlug },
    });

    const docUrl = `${baseURL}/doc/${docSlug}`;
    await Promise.all([pageA.goto(docUrl), pageB.goto(docUrl)]);

    await Promise.all([
      joinAsUser(pageA, 'Alice', 0),
      joinAsUser(pageB, 'Bob', 1),
    ]);

    // Wait for both clients to be connected (status indicator shows 'Live').
    await Promise.all([
      expect(pageA.getByTestId('conn-status')).toHaveText('Live', { timeout: 10_000 }),
      expect(pageB.getByTestId('conn-status')).toHaveText('Live', { timeout: 10_000 }),
    ]);
  });

  test.afterEach(async () => {
    await ctxA.close();
    await ctxB.close();
  });

  // ── Test 1: A types, B receives ───────────────────────────────────────────

  test('User A types text and it appears in User B editor', async () => {
    await typeInEditor(pageA, 'hello');
    await expect
      .poll(() => getEditorText(pageB), { timeout: 8_000 })
      .toContain('hello');
  });

  // ── Test 2: B types, A receives ───────────────────────────────────────────

  test('User B types text and it appears in User A editor', async () => {
    await typeInEditor(pageA, 'hello');
    await expect
      .poll(() => getEditorText(pageB), { timeout: 8_000 })
      .toContain('hello');

    await typeInEditor(pageB, ' world');
    await expect
      .poll(() => getEditorText(pageA), { timeout: 8_000 })
      .toContain('world');
  });

  // ── Test 3: Cursor presence chip ─────────────────────────────────────────

  test("User A cursor chip with name appears in User B view after typing", async () => {
    // Typing generates a presence broadcast.
    await typeInEditor(pageA, 'x');
    await expect(
      pageB.locator('.cm-cursor-name', { hasText: 'Alice' }),
    ).toBeVisible({ timeout: 8_000 });
  });

  // ── Test 4: Selection presence highlight ─────────────────────────────────

  test("User A selection appears as highlight in User B view", async () => {
    await typeInEditor(pageA, 'hello world');
    await expect
      .poll(() => getEditorText(pageB), { timeout: 8_000 })
      .toContain('hello world');

    // Select all text in A's editor.
    await pageA.locator('.cm-content').click();
    const isMac = process.platform === 'darwin';
    await pageA.keyboard.press(isMac ? 'Meta+A' : 'Control+A');

    // B should see the remote selection decoration element.
    await expect(pageB.locator('.cm-remote-selection').first()).toBeVisible({
      timeout: 8_000,
    });
  });

  // ── Test 5: Simultaneous edits converge ──────────────────────────────────

  test('Simultaneous edits at same position produce identical content in both clients', async () => {
    // Both users type at the same time without waiting for sync.
    await Promise.all([
      typeInEditor(pageA, 'A'),
      typeInEditor(pageB, 'B'),
    ]);

    // Allow time for WebSocket messages to propagate and CRDT to merge.
    await expect
      .poll(() => getEditorText(pageA), { timeout: 10_000 })
      .toMatch(/A|B/);

    // Wait for both sides to converge to the same text.
    await expect
      .poll(
        async () => {
          const a = await getEditorText(pageA);
          const b = await getEditorText(pageB);
          return a === b;
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    const contentA = await getEditorText(pageA);
    const contentB = await getEditorText(pageB);
    expect(contentA).toBe(contentB);
  });
});

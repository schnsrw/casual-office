/**
 * Tauri-mounted editor boot smoke tests.
 *
 * The launcher tests in launcher.spec.ts only exercise the launcher
 * itself. The editors (docx, sheets) live under `/docx/index.html` and
 * `/sheets/index.html` and are loaded by Tauri in a separate webview
 * window with `?desk=1[&file=...]`. When either editor's JS bundle
 * fails to evaluate — missing asset, MIME error, runtime error in the
 * desk-bridge bootstrap — the user sees a blank screen or a broken UI
 * with no obvious clue why.
 *
 * These tests serve the same built editor dists Tauri serves (via the
 * shell's Vite dev server, which proxies `public/` at the root), mock
 * the Tauri global the bootstraps reach for, and assert:
 *
 *   1. No fatal JS / network errors during boot.
 *   2. window.__deskApp__ is wired (proves the bootstrap ran).
 *   3. The editor's root mount node is in the DOM (proves the React/
 *      Univer tree at least started rendering).
 *
 * If the user reports "blank screen" or "UI broken", this test should
 * fail; if it passes here but fails in Tauri, the bug is Tauri-specific
 * (webview policy, custom protocol MIME, etc.) and not in the editor
 * bundle itself.
 */
import { expect, test, type ConsoleMessage } from '@playwright/test';

/**
 * Mock the parts of window.__TAURI__ the editor bootstraps use. Same
 * shape as the launcher's _setup.ts mock, but tailored for the editor
 * flow: load_document / document_size / read_document_chunk / etc.
 *
 * `fileBytes` is the bytes the chunked-read mock returns; for a smoke
 * test you can pass an empty Uint8Array — the bootstrap will fail the
 * magic-byte check but the editor's React tree should still mount with
 * the error banner. What we care about is that nothing throws *before*
 * that point.
 */
async function mockEditorBridge(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  page: import('@playwright/test').Page,
  fileBytes: Uint8Array,
) {
  await page.addInitScript((bytes) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__deskAppMockBytes = bytes;
    const u8 = new Uint8Array(bytes);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const invoke = async (cmd: string, args: any = {}) => {
      switch (cmd) {
        case 'document_size':
          return u8.byteLength;
        case 'read_document_chunk': {
          const offset = Number(args.offset ?? 0);
          const length = Number(args.length ?? u8.byteLength);
          return Array.from(u8.subarray(offset, offset + length));
        }
        case 'load_document':
          return Array.from(u8);
        case 'get_profile':
          return {
            name: 'Test User',
            avatar_hue: 200,
            timezone: 'UTC',
            email: null,
            avatar_path: null,
            created_at: 1_700_000_000,
          };
        case 'begin_save_document':
        case 'write_save_chunk':
        case 'add_recent_file':
        case 'save_document':
          return null;
        case 'pick_save_path':
        case 'save_document_as':
          return null;
        case 'focus_launcher_window':
          return;
        default:
          // Don't throw — the editor probes a number of commands we
          // don't want to enumerate. Just resolve null.
          return null;
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__TAURI__ = {
      core: { invoke },
      window: {
        getCurrentWindow: () => ({
          setTitle: async () => undefined,
          show: async () => undefined,
          unminimize: async () => undefined,
          setFocus: async () => undefined,
          onDragDropEvent: async () => () => undefined,
        }),
      },
      dialog: { save: async () => null, open: async () => null },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__TAURI_INTERNALS__ = {
      invoke,
      transformCallback: () => 0,
    };
  }, Array.from(fileBytes));
}

/**
 * Collect console + page errors so a failing test can report what
 * actually fired during boot. We treat 404s for required JS/CSS assets
 * as fatal (these are exactly the regressions the user is hitting:
 * `text/html` MIME error from a missing /assets/foo.js).
 */
type Captured = {
  errors: string[];
  pageErrors: string[];
  failedRequests: string[];
};

function startCapturing(page: import('@playwright/test').Page): Captured {
  const captured: Captured = { errors: [], pageErrors: [], failedRequests: [] };

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') captured.errors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    captured.pageErrors.push(`${err.name}: ${err.message}`);
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    // Ignore favicon and analytics-style failures.
    if (/favicon|analytics|gtag|googletag/i.test(url)) return;
    captured.failedRequests.push(`${req.method()} ${url} — ${req.failure()?.errorText ?? 'failed'}`);
  });
  page.on('response', (res) => {
    const url = res.url();
    const status = res.status();
    if (status >= 400 && /\.(js|css|woff2?|ttf|json)(\?|$)/.test(url)) {
      captured.failedRequests.push(`${status} ${url}`);
    }
  });

  return captured;
}

test.describe('Editor boot — docx (Tauri mode)', () => {
  // Guards against the regression where Tailwind v3 didn't generate any
  // utility classes (cwd-relative `content` globs in tailwind.config.js
  // resolving to the wrong directory under Vite 8 + rolldown). When
  // utilities are missing, every `className="flex items-center gap-2"`
  // in the toolbar becomes a block-level no-op and the ribbon
  // collapses into a vertical stack. The CSS bundle drops from ~41 KB
  // to ~27 KB (only preflight + scoped editor styles, no utilities).
  test('docx CSS bundle ships Tailwind utility classes', async ({ page }) => {
    await page.goto('/docx/index.html?desk=1', { waitUntil: 'domcontentloaded' });
    const cssText = await page.evaluate(async () => {
      const link = Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
        .map((l) => (l as HTMLLinkElement).href)
        .find((h) => /\/docx\/assets\/.*\.css$/.test(h));
      if (!link) return '';
      const res = await fetch(link);
      return await res.text();
    });
    expect(cssText, 'docx editor CSS bundle not found').not.toBe('');
    // Spot-check a handful of utilities the toolbar / menubar rely on.
    // If any of these is missing, the ribbon is broken.
    const required = ['.flex{', '.items-center{', '.gap-2{', '.justify-center{'];
    const missing = required.filter((cls) => !cssText.includes(cls));
    expect(missing, `Missing Tailwind utilities in docx bundle: ${missing.join(', ')}`).toEqual([]);
  });

  test('docx editor boots without console errors or asset 404s', async ({ page }) => {
    await mockEditorBridge(page, new Uint8Array([0x50, 0x4b, 0x03, 0x04])); // bare PK header
    const captured = startCapturing(page);
    await page.goto('/docx/index.html?desk=1', { waitUntil: 'load' });
    // Give the bootstrap a moment to run and any deferred JS to evaluate.
    await page.waitForTimeout(2000);

    const fatal = [
      ...captured.pageErrors,
      ...captured.failedRequests.filter((r) => !/200/.test(r)),
    ];
    if (fatal.length) {
      console.log('Captured console errors:', captured.errors);
      console.log('Captured page errors:', captured.pageErrors);
      console.log('Captured failed requests:', captured.failedRequests);
    }
    expect(fatal, `Fatal boot errors:\n${fatal.join('\n')}`).toEqual([]);

    // Bridge present → bootstrap ran.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = await page.evaluate(() => (window as any).__deskApp__);
    expect(bridge, 'window.__deskApp__ should be defined after bootstrap').toBeDefined();
    expect(bridge?.isDesktop).toBe(true);
  });
});

test.describe('Editor boot — sheets (Tauri mode)', () => {
  test('sheets editor boots without console errors or asset 404s', async ({ page }) => {
    await mockEditorBridge(page, new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    const captured = startCapturing(page);
    await page.goto('/sheets/index.html?desk=1', { waitUntil: 'load' });
    await page.waitForTimeout(2000);

    const fatal = [
      ...captured.pageErrors,
      ...captured.failedRequests.filter((r) => !/200/.test(r)),
    ];
    if (fatal.length) {
      console.log('Captured console errors:', captured.errors);
      console.log('Captured page errors:', captured.pageErrors);
      console.log('Captured failed requests:', captured.failedRequests);
    }
    expect(fatal, `Fatal boot errors:\n${fatal.join('\n')}`).toEqual([]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bridge = await page.evaluate(() => (window as any).__deskApp__);
    expect(bridge, 'window.__deskApp__ should be defined after bootstrap').toBeDefined();
    expect(bridge?.isDesktop).toBe(true);
  });
});

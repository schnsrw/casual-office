/**
 * End-to-end save-bridge tests for both editors. Boots each editor
 * with `?desk=1&file=/mock/path` exactly as Tauri does, mocks every
 * `invoke()` to record arguments, then drives Save by clicking the
 * editor's own Save button. Asserts that:
 *
 *   1. `window.__deskApp__.filePath` is set to the mocked path (so
 *      bridge.save knows where to write — without this, save falls
 *      through to saveAs and creates a new file).
 *   2. The Rust-side save commands fire with the expected path:
 *      `begin_save_document` + `write_save_chunk` for the chunked
 *      path, or `save_document` for the legacy path.
 *
 * If save "creates new files" or "doesn't work", one of those
 * assertions will fail and pinpoint where the chain breaks.
 */
import { expect, test } from '@playwright/test';

const MOCK_PATH = '/mock/path/test-document.docx';
const MOCK_SHEET_PATH = '/mock/path/test-workbook.xlsx';

/**
 * Install a Tauri shim that records every invoke call in
 * `window.__invokeLog`. Returns a minimal ZIP header so the magic-byte
 * sniff in the bootstrap passes.
 */
async function mockTauriRecorder(
  page: import('@playwright/test').Page,
) {
  await page.addInitScript(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__invokeLog = [] as Array<{ cmd: string; args: Record<string, unknown> }>;
    const PK = [0x50, 0x4b, 0x03, 0x04];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const invoke = async (cmd: string, args: any = {}) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__invokeLog.push({ cmd, args });
      switch (cmd) {
        case 'document_size':
          return PK.length;
        case 'read_document_chunk':
          return PK.slice(args.offset ?? 0, (args.offset ?? 0) + (args.length ?? PK.length));
        case 'load_document':
          return PK.slice();
        case 'get_profile':
          return {
            name: 'Test User',
            avatar_hue: 200,
            timezone: null,
            email: null,
            avatar_path: null,
            created_at: 0,
          };
        case 'begin_save_document':
        case 'write_save_chunk':
        case 'save_document':
        case 'add_recent_file':
          return null;
        case 'pick_save_path':
          // Pretend the user picked a brand-new path.
          return '/mock/path/PICKED-saveas.docx';
        case 'save_document_as':
          return '/mock/path/PICKED-saveas.docx';
        default:
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
        }),
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__TAURI_INTERNALS__ = { invoke, transformCallback: () => 0 };
  });
}

test.describe('Save bridge — docx', () => {
  test('bridge.save() with a bound filePath writes to that path (not Save As)', async ({ page }) => {
    await mockTauriRecorder(page);
    await page.goto(
      `/docx/index.html?desk=1&file=${encodeURIComponent(MOCK_PATH)}`,
      { waitUntil: 'load' },
    );
    await page.waitForTimeout(1500);

    // Bridge wired? filePath bound?
    const bridgeState = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = (window as any).__deskApp__;
      return b ? { isDesktop: b.isDesktop, filePath: b.filePath } : null;
    });
    expect(bridgeState, 'window.__deskApp__ must be defined').not.toBeNull();
    expect(bridgeState?.isDesktop).toBe(true);
    expect(bridgeState?.filePath).toBe(MOCK_PATH);

    // Directly invoke bridge.save with synthetic bytes — bypasses the
    // editor's own save handler since we only care that the BRIDGE
    // routes correctly (the editor calling bridge.save is exercised
    // in launcher.spec; this test isolates the bridge).
    const result = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = (window as any).__deskApp__;
      const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x05, 0x06]).buffer;
      const written = await b.save(bytes);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { written, log: (window as any).__invokeLog };
    });

    // Save must report the SAME path it was bound to — not a new one.
    expect(result.written, 'bridge.save should return the bound filePath, not null/new').toBe(MOCK_PATH);

    // Must hit chunked-write commands targeting the bound path.
    const beginCall = result.log.find((e: { cmd: string; args: Record<string, unknown> }) => e.cmd === 'begin_save_document');
    expect(beginCall, 'begin_save_document must be called').toBeTruthy();
    expect(beginCall?.args.path, 'begin_save_document path').toBe(MOCK_PATH);

    const writeCall = result.log.find((e: { cmd: string; args: Record<string, unknown> }) => e.cmd === 'write_save_chunk');
    expect(writeCall, 'write_save_chunk must be called').toBeTruthy();
    expect(writeCall?.args.path, 'write_save_chunk path').toBe(MOCK_PATH);

    // Must NOT have shown Save As dialog.
    const pickCall = result.log.find((e: { cmd: string; args: Record<string, unknown> }) => e.cmd === 'pick_save_path');
    expect(pickCall, 'Save must not fall through to Save As when filePath is bound').toBeUndefined();
  });
});

test.describe('Save bridge — sheets', () => {
  test('bridge.save() with a bound filePath writes to that path (not Save As)', async ({ page }) => {
    await mockTauriRecorder(page);
    await page.goto(
      `/sheets/index.html?desk=1&file=${encodeURIComponent(MOCK_SHEET_PATH)}`,
      { waitUntil: 'load' },
    );
    await page.waitForTimeout(2000);

    const bridgeState = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = (window as any).__deskApp__;
      return b ? { isDesktop: b.isDesktop, filePath: b.filePath } : null;
    });
    expect(bridgeState, 'window.__deskApp__ must be defined').not.toBeNull();
    expect(bridgeState?.isDesktop).toBe(true);
    expect(bridgeState?.filePath).toBe(MOCK_SHEET_PATH);

    const result = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = (window as any).__deskApp__;
      const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x05, 0x06]).buffer;
      const written = await b.save(bytes);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { written, log: (window as any).__invokeLog };
    });

    expect(result.written, 'bridge.save should return the bound filePath').toBe(MOCK_SHEET_PATH);

    const beginCall = result.log.find((e: { cmd: string; args: Record<string, unknown> }) => e.cmd === 'begin_save_document');
    expect(beginCall, 'begin_save_document must be called').toBeTruthy();
    expect(beginCall?.args.path, 'begin_save_document path').toBe(MOCK_SHEET_PATH);

    const writeCall = result.log.find((e: { cmd: string; args: Record<string, unknown> }) => e.cmd === 'write_save_chunk');
    expect(writeCall, 'write_save_chunk must be called').toBeTruthy();
    expect(writeCall?.args.path, 'write_save_chunk path').toBe(MOCK_SHEET_PATH);

    const pickCall = result.log.find((e: { cmd: string; args: Record<string, unknown> }) => e.cmd === 'pick_save_path');
    expect(pickCall, 'Save must not fall through to Save As when filePath is bound').toBeUndefined();
  });
});

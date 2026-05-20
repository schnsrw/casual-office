/**
 * Visual inspection of the docx editor mounted in Tauri mode. Takes a
 * screenshot and dumps the rendered DOM tree + computed font metrics
 * so we can see what's actually rendering when the user reports a
 * "disfigured" UI. Not a pass/fail test — diagnostic.
 */
import { test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('inspect docx editor UI in Tauri mode', async ({ page }) => {
  // Minimal Tauri shim — same as editor-boot.spec but always returns a
  // valid ZIP header so the chunked-read sniff passes.
  await page.addInitScript(() => {
    const u8 = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const invoke = async (cmd: string, args: any = {}) => {
      switch (cmd) {
        case 'document_size': return u8.byteLength;
        case 'read_document_chunk':
          return Array.from(u8.subarray(args.offset ?? 0, (args.offset ?? 0) + (args.length ?? 0)));
        case 'get_profile':
          return { name: 'Test', avatar_hue: 200, timezone: null, email: null, avatar_path: null, created_at: 0 };
        default: return null;
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

  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/docx/index.html?desk=1', { waitUntil: 'load' });
  await page.waitForTimeout(3000);

  const outDir = path.resolve(__dirname, '../screenshots');
  fs.mkdirSync(outDir, { recursive: true });
  const shotPath = path.join(outDir, 'docx-ui.png');
  await page.screenshot({ path: shotPath, fullPage: true });

  // Inspect the DOM and computed styles. Look for the things a docx
  // editor "should have" — toolbar buttons, editor canvas, etc.
  const inspection = await page.evaluate(() => {
    const body = document.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    return {
      bodyClass: body.className,
      bodyChildren: Array.from(body.children).map((c) => ({
        tag: c.tagName,
        id: (c as HTMLElement).id,
        className: (c as HTMLElement).className,
        innerHTMLPreview: c.innerHTML.slice(0, 200),
      })),
      hasDeskApp: !!w.__deskApp__,
      hasReact: !!(document.querySelector('#app, #root, [class*="ep-root"], [class*="DocxEditor"]')),
      // Sample a button to check if it's styled or unstyled
      firstButton: (() => {
        const b = document.querySelector('button');
        if (!b) return null;
        const cs = getComputedStyle(b);
        return {
          text: b.textContent?.slice(0, 30) ?? '',
          background: cs.backgroundColor,
          color: cs.color,
          fontSize: cs.fontSize,
          fontFamily: cs.fontFamily,
          border: cs.border,
          width: b.getBoundingClientRect().width,
          height: b.getBoundingClientRect().height,
        };
      })(),
      stylesheets: Array.from(document.styleSheets).map((s) => ({
        href: s.href,
        rules: (() => {
          try { return s.cssRules?.length ?? 0; } catch { return 'CORS-blocked'; }
        })(),
      })),
      // Did any link fail?
      brokenLinks: Array.from(document.querySelectorAll('link')).map((l) => ({
        rel: l.rel,
        href: l.href,
        sheet: (l as HTMLLinkElement).sheet === null ? 'null' : 'ok',
      })),
    };
  });

  console.log('=== DOCX UI INSPECTION ===');
  console.log(JSON.stringify(inspection, null, 2));
  console.log(`Screenshot saved: ${shotPath}`);
});

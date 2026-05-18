# CLAUDE.md — Casual Office (deskApp)

Working rules for AI coding sessions inside this repo.

## What this repo is

A Tauri 2 desktop shell that wraps two existing browser editors into one
single-user app for `.docx` and `.xlsx` files. Local-only — no auth, no
network sync, no database. Files live on disk; the shell saves to and reads
from the user's filesystem through native OS dialogs.

The two editor codebases are **separate git repos**, cloned in-tree:

- `docx/` — `github.com/schnsrw/docx` (fork of `eigenpal/docx-editor`, MIT,
  React + ProseMirror)
- `sheets/` — `github.com/schnsrw/sheets` (Univer OSS-based, Apache-2.0)

Both are listed in `.gitignore` for this repo — they are external
dependencies versioned separately.

## Architecture (locked)

- **Single window** with Chrome-style tabs. One tab = one document.
- **Tabs are iframes** loading the editor's built `dist/` from
  `apps/shell/public/{docx,sheets}/index.html?desk=1&file=…`.
- **No multi-window-per-doc by default.** Drag-out-tab spawns a new Tauri
  window with the same file path; the original window keeps its other tabs.
- **The Rust core is stateless** beyond per-user JSON (`~/.config/live.schnsrw.casualoffice/{profile,settings,recent}.json`).
- **Native save bridge** uses postMessage from iframe to launcher to Tauri
  commands. Popped-out windows are top-level — they use `window.__TAURI__`
  directly (`withGlobalTauri: true`).

See `docs/ARCHITECTURE.md` for the full diagram and decisions.

## Hard rules

1. **Don't reintroduce browser-style downloads.** Save / Save As route through
   `window.__deskApp__` to Tauri commands `save_document` /
   `save_document_as`. Never `<a download>` blobs. Reason: this is a desktop
   app; downloading instead of overwriting is the single biggest UX failure.
2. **`docx/` and `sheets/` are upstream-versioned.** Modifications go through
   the upstream repos' own conventions (see each repo's `CLAUDE.md`). If you
   need to touch them from this repo, the only acceptable changes today are
   in their `examples/vite/src/` (docx) or `apps/web/src/` (sheets) entry
   points to wire the desktop bridge.
3. **Don't modify `vendor/univer/`** in `sheets/` — read-only reference.
4. **Apache-2.0 across the project.** AGPL `@eigenpal/docx-editor-agents`
   was already purged from the docx fork. Do not reintroduce.
5. **`[hidden] { display: none !important; }`** must stay in `apps/shell/src/styles.css`.
   See `~/.claude/projects/.../memory/feedback_hidden_specificity.md` — the
   plain `hidden` attribute loses to any author `display: …` and silently
   breaks view toggling.
6. **Editor bundles must be built with `--base=./`.** Otherwise the
   bundled `<script src="/assets/…">` resolves outside the editor's mount
   path (`/docx/` or `/sheets/`) and 404s with a `text/html` MIME error.

## Save semantics (user spec)

- **Save**: writes back to the file path the document was opened with. No
  prompt.
- **Save**, on a brand-new (untitled) document: prompts for a location once,
  same as Save As, then becomes a path-bound document.
- **Save As / Export**: always prompts for location.

These rules are implemented in:

- `apps/shell/src/main.ts` → `handleBridgeRequest` (host side)
- The editors' bootstraps (`docx/docx-editor/examples/vite/src/desk-bridge-bootstrap.ts`,
  `sheets/apps/web/src/desk-bridge-bootstrap.ts`) (iframe side)

## Working rules for Claude

1. **Read first, write second.** Each upstream repo has its own `CLAUDE.md`
   with binding rules (test commands, file maps, do-not-touch lists). Read
   the relevant one before editing.
2. **Verify with a build, not by inspection.** Tauri's IPC, capabilities,
   webview behavior all have non-obvious traps. `cargo check` is fast and
   reliable; use it before claiming Rust code is done.
3. **`pnpm tauri:dev`** for incremental dev; `pnpm tauri:build --no-bundle`
   for a fast release check. Full bundle (`.deb` + `.AppImage`) takes longer.
4. **Don't break the launcher boot.** All Tauri command invokes from
   `boot()` are wrapped in `withTimeout` fallbacks — keep them. A single
   broken command must not strand the user on a blank screen.
5. **For UX or rendering bugs**, ask the user for the WebView console
   output (right-click → Inspect Element in the live app). Don't guess from
   description alone — Linux/WebKitGTK has its own quirks.
6. **The drop overlay was removed.** Drag-drop still functions (handler
   listens for `type === 'drop'` only), but the visual overlay was killed
   because WebKitGTK fired spurious `enter` events at startup that blanketed
   the wizard. Don't put it back without verifying the spurious-event
   behavior on Linux.

## Where things live

| | |
|---|---|
| `apps/shell/index.html` | Launcher chrome: wizard, tab strip, home panel, frames container |
| `apps/shell/src/main.ts` | Launcher logic: wizard, tabs, drag-drop, postMessage router |
| `apps/shell/src/styles.css` | Launcher styles, theme tokens, `[hidden] !important` |
| `apps/shell/src-tauri/src/lib.rs` | All Tauri commands: load/save/recents/profile/settings, `open_document_window` for pop-outs |
| `apps/shell/src-tauri/tauri.conf.json` | Window config, `withGlobalTauri`, bundle config |
| `apps/shell/src-tauri/capabilities/default.json` | IPC permission set |
| `apps/shell/public/docx/`, `public/sheets/` | Built editor dists copied by `scripts/copy-editors.sh` (gitignored) |
| `docx/docx-editor/examples/vite/src/desk-bridge-bootstrap.ts` | docx-side iframe bootstrap (postMessage + top-level Tauri modes) |
| `sheets/apps/web/src/desk-bridge-bootstrap.ts` | sheets-side bootstrap (mirror of docx) |

## Status (2026-05-18)

- Linux build green; launcher + wizard + tabs + drag-out + recent files all
  working.
- docx editor renders, opens files, saves natively via the bridge.
- sheets editor renders the chrome; xlsx file loading via the bridge wired
  but the file-open path is currently being debugged (visible error overlay
  added in the bootstrap to surface failures).
- Windows + macOS targets not yet built (Tauri 2 cross-OS should work; CI
  matrix is the deferred work).
- No drag-tab-in-to-merge yet — drag-out only.

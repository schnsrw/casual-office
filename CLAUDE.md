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

- **One Tauri window per open document.** Same model as native Excel /
  Word / LibreOffice — each opened file is its own webview process, its
  own event loop, isolated from every other window. The earlier
  iframe-in-shared-process model was abandoned (Univer's canvas race with
  the launcher's React tree produced a permanent blank canvas under
  WebKitGTK; documented as the "swap aborted: snapshotRef is empty" bug).
- **Launcher window** stays open as the home screen — hero + 3 cards
  (New document / New spreadsheet / Open file) + recent files + Settings
  panel + first-run wizard.
- **Open-where dialog** asks the user "this window or new window?" on
  every open, with a Remember-my-choice checkbox that stores
  `open_window_preference` in `settings.json`.
- **Rust core is stateless** beyond per-user JSON
  (`~/.config/live.schnsrw.casualoffice/{profile,settings,recent}.json`)
  plus an optional `avatar.<ext>` for the profile picture.
- **Bridge:** editors load with `?desk=1[&file=…]`; each editor's
  `desk-bridge-bootstrap.ts` (first import in its `main.tsx`) defines
  `window.__deskApp__` and calls `window.__TAURI__.core.invoke` directly
  (top-level Tauri window mode; `withGlobalTauri: true` in
  `tauri.conf.json`). No postMessage hop in the normal flow.

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

These rules are implemented in each editor's `desk-bridge-bootstrap.ts`
(`docx/docx-editor/examples/vite/src/` and `sheets/apps/web/src/`). The
bootstrap's `save()` delegates to `saveAs()` when `filePath` is null; after
a successful `saveAs`, it updates `filePath` so subsequent `save()` calls
overwrite the chosen path.

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
| `apps/shell/index.html` | Wizard + workspace home + Settings panel + open-where modal |
| `apps/shell/src/main.ts` | Launcher logic: wizard, settings, open-where dialog, recents, drag-drop |
| `apps/shell/src/styles.css` | Theme tokens, hero/cards/settings/modal styles, `[hidden] !important` |
| `apps/shell/src-tauri/src/lib.rs` | All Tauri commands (load/save/recents/profile/settings/avatar/`open_document_window`) |
| `apps/shell/src-tauri/Cargo.toml` | `tauri = { features = ["devtools"] }` — right-click → Inspect works in release builds |
| `apps/shell/src-tauri/tauri.conf.json` | Window config, `withGlobalTauri: true`, `fileAssociations` for OS default-app registration |
| `apps/shell/src-tauri/capabilities/default.json` | IPC permission set |
| `apps/shell/public/docx/`, `public/sheets/` | Built editor dists copied by `scripts/copy-editors.sh` (gitignored) |
| `docx/docx-editor/examples/vite/src/desk-bridge-bootstrap.ts` | docx-side bootstrap (top-level Tauri mode; iframe mode kept for symmetry) |
| `sheets/apps/web/src/desk-bridge-bootstrap.ts` | sheets-side bootstrap (mirror of docx) |

## Status (2026-05-19)

- Linux release binary green, 16 MB. Launcher window with wizard, home
  screen, recent files, Settings panel, open-where dialog all wired.
- docx editor renders and saves natively.
- sheets editor renders and saves natively. The earlier "blank canvas" was
  fixed by gating sheets' aggressive `snapshotRef` GC on
  `window.__deskApp__?.isDesktop` — React 18 concurrent rendering can
  defer the swap effect past the 2-macrotask `setTimeout(0)` clear, so the
  swap finds an empty ref. The web build keeps its original GC.
- One Tauri window per document (no tabs, no iframes). Launcher window
  stays open as the home base.
- File associations declared in `tauri.conf.json` for `.docx`/`.xlsx`/
  `.xlsm` — once installed via `.deb` / `.AppImage`, the OS offers Casual
  Office as an opener.
- DevTools enabled in release (`tauri = { features = ["devtools"] }`).
  Right-click any window → Inspect Element.
- Windows + macOS targets not yet built — Tauri 2 cross-OS should work;
  CI matrix is deferred work.
- ODT support deferred until the docx fork gains an OpenDocument Text
  parser.

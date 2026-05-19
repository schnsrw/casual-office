# Architecture

How the pieces fit. For build/dev flow, see [PIPELINE.md](PIPELINE.md). For
the file/module map, see [CODE-GRAPH.md](CODE-GRAPH.md).

## Top-down diagram

```
                              ┌── Casual Office ──┐
                              │   (Tauri 2 app)   │
                              └─────────┬─────────┘
                                        │
                ┌───────────────────────┼───────────────────────┐
                ▼                       ▼                       ▼
   ┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
   │   Launcher window   │   │  Document window 1  │   │  Document window N  │
   │   (apps/shell/dist) │   │  (docx or sheets)   │   │  (docx or sheets)   │
   ├─────────────────────┤   ├─────────────────────┤   ├─────────────────────┤
   │ Setup wizard        │   │ Native webview      │   │ Native webview      │
   │ Home: hero + cards  │   │ tauri://localhost/  │   │ tauri://localhost/  │
   │  + recent files     │   │   docx/?desk=1&file │   │   sheets/?desk=1&…  │
   │ Settings panel      │   │ Own webview process │   │ Own webview process │
   │ Open-where dialog   │   └──────────┬──────────┘   └──────────┬──────────┘
   └──────────┬──────────┘              │                         │
              │                         │ window.__deskApp__      │ window.__deskApp__
              │ invoke('open_document_  │   (top-level mode —     │   (top-level mode)
              │  window', { kind, …})   │    uses window.__TAURI__│
              ▼                         ▼   directly)             ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │                   Tauri 2 Rust core — apps/shell/src-tauri               │
   │                                                                          │
   │   commands: load_document, save_document, save_document_as,              │
   │             open_document_window, is_first_run,                          │
   │             get/save_profile, pick_avatar_image, read_avatar_bytes,      │
   │             get/save_settings,                                           │
   │             get/clear/add_recent_file                                    │
   │   plugins:  tauri-plugin-dialog, tauri-plugin-fs                         │
   └────────────────────────────────────┬─────────────────────────────────────┘
                                        ▼
                  ~/.config/live.schnsrw.casualoffice/
                    ├─ profile.json      (name, email, timezone, avatar_path, avatar_hue)
                    ├─ settings.json     (theme, default_save_dir, open_window_preference)
                    ├─ recent.json       (last 20 opened files)
                    └─ avatar.<ext>      (optional user-picked profile picture)

                  User documents — anywhere on the filesystem, selected via
                  native OS file dialogs.
```

## Decisions

### One Tauri window per open document (one webview process per document)

Each opened `.docx` / `.xlsx` / `.ods` / `.csv` / `.tsv` becomes its own
native Tauri window via `open_document_window`. Same model as native Excel,
Word, LibreOffice: per-document isolation, per-document webview process,
zero shared event-loop contention.

**Why not iframes / tabs in one window:** earlier prototype put each
document in an iframe inside the launcher window. All editors shared a
single webview process; opening a heavy `.xlsx` froze the launcher and
Univer's canvas race with the launcher's React tree manifested as a
permanent blank canvas (the "swap aborted: snapshotRef is empty" bug —
see [PIPELINE.md](PIPELINE.md) for the React 18 concurrent-rendering
detail).

**Why not always-new-window without asking:** users opening a Recent file
sometimes mean "replace the current view," sometimes mean "another window
for side-by-side." The open-where dialog asks once; "Remember my choice"
stores `open_window_preference` in settings so we don't pester repeat
openers.

### Stateless Rust core

The Rust side owns no document state. Each Tauri command is a one-shot:
read bytes from disk, write bytes to disk, return a path. The only
persistent state is the per-user JSON files in `~/.config/…/`. If anything
crashes, the file on disk is the source of truth — no journal, no undo
graph to reconcile.

### The bridge: same protocol, two transports

Editors detect the desktop context via `?desk=1` in the URL. The bootstrap
inside the editor (`docx/.../desk-bridge-bootstrap.ts` and the equivalent
in sheets) sets `window.__deskApp__` so the editor's own save/load paths
route through it.

| Editor window type | Transport |
|---|---|
| Top-level Tauri window (this is the normal case) | Direct `window.__TAURI__.core.invoke('load_document', …)`. Requires `withGlobalTauri: true` in `tauri.conf.json`. |
| Iframe under the launcher (no longer used; the bootstrap still supports it for symmetry) | `postMessage` to the parent launcher, which calls the same Tauri commands and posts the reply back |

### Save semantics

| Action  | If document has a path | If document has no path |
|---------|-----------------------|-------------------------|
| Save    | overwrite the path silently | prompt for location once, then bind |
| Save As | always prompt | always prompt |
| Export  | always prompt | always prompt |

These rules are enforced in the bootstrap's `save()` method — if
`filePath` is null, `save()` delegates to `saveAs()`. After a successful
`saveAs`, the bootstrap updates `filePath` so subsequent `save()` calls
overwrite the chosen path.

### Editor source repos stay separate

`docx/` and `sheets/` keep their own git history and are listed in this
repo's `.gitignore`. Cloning casual-office is a two-step operation
(see [BUILD.md](BUILD.md)). The only edits we make in either upstream
repo are:

- A `desk-bridge-bootstrap.ts` module under each editor's entry-point
  source folder
- A `?desk=1` detection branch in each editor's `App.tsx` mount-time
  `useEffect` (load file via the bridge instead of fetching a demo file)
- A `?desk=1`-gated bypass of sheets' aggressive `snapshotRef` GC in
  `replaceWorkbook` (it raced React 18 concurrent rendering)

Each upstream repo has its own `CLAUDE.md` governing its toolchain (Bun
for docx, pnpm for sheets) and conventions.

## What's intentionally out

- **Collab / multi-user editing.** Both upstream repos have planned
  Hocuspocus/Yjs pipelines. Casual Office stays single-user — `__COLLAB_BUILD__`
  is false in our builds and the collab UI is dead code.
- **Persistence beyond filesystem.** No DB, no autosave to cloud.
- **Auth / accounts.** No login.
- **Plugin system.** Only the two built-in editor kinds.
- **Online services.** No telemetry, no update checks (Tauri updater is a
  future opt-in).
- **`.odt` support.** Out of scope until the docx fork gains an OpenDocument
  Text parser; `.docx`, `.xlsx`, `.xlsm`, `.ods`, `.csv`, `.tsv` are the
  supported extensions today.

## Linux first, cross-OS by design

Tauri 2 abstracts the system webview. Today we ship for Linux (WebKitGTK
4.1). Windows (WebView2) and macOS (WKWebView) targets share the same code
and require only CI matrix work. See [PIPELINE.md](PIPELINE.md).

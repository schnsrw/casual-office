# Architecture

How the pieces fit. For build/dev flow, see [PIPELINE.md](PIPELINE.md). For
the file/module map, see [CODE-GRAPH.md](CODE-GRAPH.md).

## Top-down diagram

```
┌──────────────────────────── Casual Office (Tauri 2 binary) ─────────────────┐
│                                                                             │
│  Frontend  ─ apps/shell/dist/  (Vite-built TS launcher)                     │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ Tab strip  [Home] [doc.docx ×] [sheet.xlsx ×]  [+]                    │  │
│  ├───────────────────────────────────────────────────────────────────────┤  │
│  │ Active panel (one of):                                                │  │
│  │                                                                       │  │
│  │   Home panel: hero + 3 action cards + recent file list                │  │
│  │                                                                       │  │
│  │   Editor iframe: tauri://localhost/docx/index.html?desk=1&file=…      │  │
│  │     │              ↘  postMessage  ↗                                  │  │
│  │     ▼                                                                 │  │
│  │   desk-bridge-bootstrap.ts inside the iframe                          │  │
│  │     - defines window.__deskApp__ (load / save / saveAs)               │  │
│  │     - iframe mode: postMessage to parent                              │  │
│  │     - top-level mode (popped-out window): direct window.__TAURI__     │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│             │ postMessage { src:'deskApp', method:'save', bytes }            │
│             ▼                                                               │
│  Parent launcher's message router (apps/shell/src/main.ts)                  │
│             │                                                               │
│             │ Tauri invoke()                                                │
│             ▼                                                               │
│  Rust core  ─ apps/shell/src-tauri/                                         │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │ commands: load_document, save_document, save_document_as,             │  │
│  │           get/clear/add_recent_file, is_first_run,                    │  │
│  │           get/save_profile, get/save_settings,                        │  │
│  │           open_document_window (pop-out)                              │  │
│  │ plugins:  tauri-plugin-dialog, tauri-plugin-fs                        │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│             │                                                               │
└─────────────┼───────────────────────────────────────────────────────────────┘
              ▼
        ~/.config/live.schnsrw.casualoffice/
              ├─ profile.json   (name + avatar_hue + created_at)
              ├─ settings.json  (theme + default_save_dir)
              └─ recent.json    (last 20 opened files, move-to-front)

        User documents          (anywhere — selected via OS dialogs)
              ├─ *.docx
              ├─ *.xlsx / *.xlsm
```

## Decisions

### One window, multiple tabs (Chrome-style)

Each open document is a tab. Tabs are sibling iframes inside the launcher
window; only the active tab's iframe is `visibility: visible`. Inactive
iframes stay loaded so the user can switch back instantly.

**Drag-out**: dragging a tab vertically past 100 px below the tab strip
detaches it. The launcher spawns a new top-level Tauri window via
`open_document_window` with the same file path, then closes the source tab.

**Drag-in (merge windows)** is not yet implemented — requires inter-window
event coordination. Deferred.

### Stateless Rust core

The Rust side owns no document state. Each Tauri command is a one-shot:
read bytes from disk, write bytes to disk, return a path. The only
persistent state is the three small JSON files in `~/.config/…/`.

This decouples the desktop shell from collaborative-editing concerns and
makes recovery trivial — if anything crashes, the file on disk is the
source of truth.

### The bridge: postMessage vs Tauri global

Editor iframes can't access `window.__TAURI__` directly inside the launcher
window — `withGlobalTauri` only injects the global on top-level windows.
The earlier attempt to assign `iframe.contentWindow.__deskApp__` from the
parent had an unfixable race: the editor's React `useEffect` ran *before*
the iframe `load` event fired.

Fix: the editor's own bootstrap (imported first in `main.tsx`) defines
`window.__deskApp__` *inside* the iframe. Inside the iframe it routes
through `window.parent.postMessage`; in a popped-out window it routes
through `window.__TAURI__.core.invoke`. Same external API both ways.

### Save semantics

| Action  | If document has a path | If document has no path |
|---------|-----------------------|-------------------------|
| Save    | overwrite the path silently | prompt for location once, then bind |
| Save As | always prompt | always prompt |
| Export  | always prompt | always prompt |

This is the only product invariant we will not compromise on.

### Editor source repos stay separate

`docx/` and `sheets/` keep their own git history and are listed in this
repo's `.gitignore`. Cloning casual-office is a two-step operation
(see [BUILD.md](BUILD.md)). Each upstream repo has its own `CLAUDE.md`
governing its toolchain (Bun for docx, pnpm for sheets) and conventions.

## What's intentionally out

- **Collab / multi-user editing.** Both upstream repos have planned Yjs
  pipelines. We don't ship those — the desktop is single-user.
- **Persistence beyond filesystem.** No DB, no autosave to cloud.
- **Auth / accounts.** No login.
- **Plugin system.** Only the two built-in editor types.
- **Online services.** No telemetry, no update checks (Tauri updater is a
  future opt-in).

## Linux first, cross-OS by design

Tauri 2 abstracts the system webview. Today we ship for Linux (WebKitGTK
4.1). Windows (WebView2) and macOS (WKWebView) targets share the same code
and require only CI matrix work. See [PIPELINE.md](PIPELINE.md).

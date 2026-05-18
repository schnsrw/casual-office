# Code graph

Where the code lives and what calls what. Read alongside
[ARCHITECTURE.md](ARCHITECTURE.md).

## Top-level layout

```
casual-office/
├── README.md                  ← project overview + quickstart
├── CLAUDE.md                  ← working rules for AI coding sessions
├── LICENSE                    ← Apache-2.0
├── package.json               ← root pnpm scripts (build:docx, build:sheets, …)
├── pnpm-workspace.yaml        ← workspace = apps/*
├── .gitignore                 ← ignores docx/, sheets/, target/, public/{docx,sheets}/
│
├── docs/                      ← this folder
│   ├── ARCHITECTURE.md
│   ├── PIPELINE.md
│   ├── BUILD.md
│   └── CODE-GRAPH.md
│
├── docx/                      ← gitignored — clone of github.com/schnsrw/docx
├── sheets/                    ← gitignored — clone of github.com/schnsrw/sheets
│
└── apps/
    └── shell/                 ← the Tauri app
        ├── package.json
        ├── vite.config.ts
        ├── tsconfig.json
        ├── index.html         ← launcher chrome markup (wizard + tabs + home)
        ├── public/            ← Vite copies into dist/ at build time
        │   ├── docx/          ← copied from docx/docx-editor/examples/vite/dist/
        │   └── sheets/        ← copied from sheets/apps/web/dist/
        ├── dist/              ← Vite output, embedded into the Tauri binary
        ├── assets/
        │   └── icon.svg       ← source-of-truth icon (rasterized to PNGs in src-tauri/icons/)
        ├── scripts/
        │   └── copy-editors.sh
        ├── src/
        │   ├── main.ts        ← launcher logic — tabs, wizard, postMessage router, drag-drop
        │   └── styles.css     ← theme tokens + view + hero/cards/tabs styling
        └── src-tauri/
            ├── Cargo.toml
            ├── build.rs
            ├── tauri.conf.json
            ├── capabilities/
            │   └── default.json
            ├── icons/         ← generated PNGs at 32/128/128@2x/512
            └── src/
                ├── main.rs    ← thin entry → lib::run()
                └── lib.rs     ← all Tauri commands + the desktop API
```

## Module dependency graph (launcher side)

```
       ┌─────────────────────────────────┐
       │  apps/shell/src/main.ts (entry) │
       └─────────────────────────────────┘
                ↓ imports
   ┌─────────────────────────┬──────────────────────────┐
   ↓                         ↓                          ↓
 @tauri-apps/api/core    @tauri-apps/plugin-dialog   @tauri-apps/api/window
   (invoke)                (open file picker)         (drag-drop events)
        │                        │                          │
        ▼                        ▼                          ▼
   ╔══════════════════════════════════════════════════════════╗
   ║  Tauri 2 IPC bridge → lib.rs commands (see below)        ║
   ╚══════════════════════════════════════════════════════════╝
```

## main.ts internal modules

| Section | Function |
|---|---|
| Types | `DocKind`, `Tab`, `Profile`, `Settings`, `BridgeRequest` |
| Tiny helpers | `escapeHtml`, `basename`, `dirname`, `relTime`, `kindFromPath`, `initials`, `hashHue`, `uid`, `applyTheme`, `setStatus`, `withTimeout` |
| **Bridge router** | `tabForSource`, `handleBridgeRequest`, `bindBridgeRouter` — listens for postMessages from editor iframes and dispatches Tauri commands |
| State | `state` (tabs, activeTabId, profile, settings, draggingTabId) |
| **Tabs lifecycle** | `renderTabs`, `activateTab`, `syncPanels`, `openLauncherTab`, `openDocumentInTab`, `closeTab`, `activeTab`, `bindPathToTab`, `openOrReplaceLauncher` (sticky-tab logic), `detachTab` (drag-out → new window) |
| Home panel | `refreshRecents`, `bindHomePanel` |
| Tabbar | `bindTabBar` (new-tab button, pop-out current tab) |
| Drag-drop | `bindDragDrop` (open files dropped on the window) |
| Shortcuts | `bindShortcuts` (Ctrl+T, Ctrl+W) |
| Wizard | `WizardState`, `showWizardStep`, `bindWizard`, `finishWizard` |
| Boot | `revealWorkspace`, `boot` |

## Rust commands (lib.rs)

| Command | Purpose | JS caller |
|---|---|---|
| `is_first_run` | True if `profile.json` is missing | `boot()` |
| `get_profile`, `save_profile` | Read/write `~/.config/live.schnsrw.casualoffice/profile.json` | Wizard, launcher boot |
| `get_settings`, `save_settings` | Read/write `~/.config/.../settings.json` | Wizard, launcher boot |
| `get_recent_files`, `clear_recent_files`, `add_recent_file` | Manage `recent.json` (last 20, move-to-front) | Home panel, openDocumentInTab |
| `load_document` | `std::fs::read(path)` → bytes | Bridge router on `loadDocument` |
| `save_document` | `std::fs::write(path, bytes)` | Bridge router on `save` (path known) |
| `save_document_as` | Native save dialog + write + recent-file touch | Bridge router on `save` (untitled) or `saveAs` |
| `open_document_window` | Spawn a new Tauri webview window with `?desk=1&file=…` | "Open in new window" + drag-tab-out |

All custom commands are registered in `tauri::generate_handler![]`. Plugin
commands come from `tauri_plugin_dialog::init()` and `tauri_plugin_fs::init()`.

## Bridge protocol (postMessage shape)

### Request (iframe → parent launcher)
```ts
{ src: 'deskApp',
  kind: 'request',
  id: number,                         // monotonic per iframe
  method: 'loadDocument' | 'save' | 'saveAs',
  params: { path?, bytes?, suggestedName? } }
```

### Reply (parent → iframe)
```ts
{ src: 'deskApp',
  kind: 'reply',
  id: number,                         // echoes request id
  result?: unknown,
  error?: string }
```

## Editor entry-points we own

Only the demo entry points of each upstream editor were touched to wire the
bridge — the editor packages themselves are unmodified.

| File | Change |
|---|---|
| `docx/docx-editor/examples/vite/src/main.tsx` | Added `import './desk-bridge-bootstrap';` as first import |
| `docx/docx-editor/examples/vite/src/desk-bridge-bootstrap.ts` | New file — defines `window.__deskApp__` |
| `docx/docx-editor/examples/vite/src/App.tsx` | `useEffect` reads bridge.filePath and loads; `handleSave` / `handleSaveAs` route through bridge |
| `sheets/apps/web/src/main.tsx` | Added `import './desk-bridge-bootstrap';` as first import |
| `sheets/apps/web/src/desk-bridge-bootstrap.ts` | New file — mirror of docx, plus a visible-error overlay for runtime errors |
| `sheets/apps/web/src/App.tsx` | `useEffect` calls bridge.loadDocument → xlsxToWorkbookData → replaceWorkbook |

These changes are additive and gated on `?desk=1` in the URL — the editors
still work as web apps when served from their original deploy hosts.

## What is NOT in this repo

- The editor packages themselves (`docx/docx-editor/packages/*`, the Univer
  npm packages). Editing those happens in the upstream repos.
- The Yjs collab server (`sheets/apps/server/`). The desktop is single-user.
- The Go WOPI backend (planned in the docx repo). Same reason.

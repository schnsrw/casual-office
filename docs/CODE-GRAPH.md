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
        ├── index.html         ← wizard + workspace home + settings + open-where modal
        ├── public/            ← Vite copies into dist/ at build time
        │   ├── docx/          ← copied from docx/docx-editor/examples/vite/dist/  (gitignored)
        │   └── sheets/        ← copied from sheets/apps/web/dist/                 (gitignored)
        ├── dist/              ← Vite output, embedded into the Tauri binary
        ├── assets/
        │   └── icon.svg       ← source-of-truth icon (rasterized to PNGs in src-tauri/icons/)
        ├── scripts/
        │   └── copy-editors.sh
        ├── src/
        │   ├── main.ts        ← launcher logic — wizard, settings, open-where modal, recents
        │   └── styles.css     ← theme tokens + view + hero/cards/settings/modal styling
        └── src-tauri/
            ├── Cargo.toml     ← tauri features = ["devtools"] (right-click → Inspect in release)
            ├── build.rs
            ├── tauri.conf.json     ← withGlobalTauri=true, fileAssociations for .docx/.xlsx/.xlsm
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
   (invoke)                (open + save dialogs)      (drag-drop events)
        │                        │                          │
        ▼                        ▼                          ▼
   ╔══════════════════════════════════════════════════════════╗
   ║  Tauri 2 IPC → lib.rs commands (table below)             ║
   ╚══════════════════════════════════════════════════════════╝
```

## main.ts internal modules

| Section | Function |
|---|---|
| Types | `DocKind`, `RecentFile`, `Profile`, `Settings` |
| Helpers | `escapeHtml`, `basename`, `dirname`, `relTime`, `kindFromPath`, `initials`, `hashHue`, `applyTheme`, `setStatus`, `withTimeout`, `detectTimezone` |
| State | `state` (profile, settings) |
| **Document opening** | `openOrReplaceLauncher` (consults `settings.open_window_preference`), `askOpenChoice` (modal), `doOpen` (either navigates the launcher window via `window.location.href` or spawns a new Tauri window via `open_document_window`) |
| Home panel | `refreshRecents`, `bindHomePanel`, `bindTabBar` (no-op stub kept for boot wiring) |
| Drag-drop | `bindDragDrop` (open files dropped on the launcher) — overlay was removed; drops still work |
| Shortcuts | `bindShortcuts` (Ctrl/Cmd-O = Open file) |
| Wizard | `WizardState`, `showWizardStep`, `bindWizard`, `finishWizard` |
| **Avatar** | `renderAvatar`, `avatarDataUrlCache` — reads user-picked image via `read_avatar_bytes`, encodes as data URL |
| **Settings panel** | `showSettings`, `hideSettings`, `populateSettings`, `bindSettings` — edit name / email / timezone / theme / default folder / profile picture |
| Boot | `revealWorkspace`, `boot` |

## Rust commands (lib.rs)

| Command | Purpose | JS caller |
|---|---|---|
| `is_first_run` | True if `profile.json` is missing | `boot()` |
| `get_profile`, `save_profile` | Read/write `profile.json` | Wizard, Settings save |
| `pick_avatar_image` | Native image picker → copy into config dir as `avatar.<ext>` → return new path | Settings: "Change picture…" |
| `read_avatar_bytes` | Read avatar bytes for data-URL rendering in the launcher | `renderAvatar` |
| `get_settings`, `save_settings` | Read/write `settings.json` | Wizard, Settings save, open-where remember |
| `get_recent_files`, `clear_recent_files`, `add_recent_file` | Manage `recent.json` (last 20, move-to-front) | Home panel, `doOpen` |
| `load_document` | `std::fs::read(path)` → bytes | Editor bootstrap on `loadDocument` |
| `save_document` | `std::fs::write(path, bytes)` | Editor on `save` (path known) |
| `save_document_as` | Native save dialog + write + recent-file touch | Editor on `save` (untitled) or `saveAs` |
| `open_document_window` | Spawn a new top-level Tauri webview window with `?desk=1&file=…` | `doOpen` when "new window" chosen |

All custom commands are registered in `tauri::generate_handler![]`. Plugin
commands come from `tauri_plugin_dialog::init()` and `tauri_plugin_fs::init()`.

## Bridge: how the editor talks to Tauri

The editors run in top-level Tauri windows (one per opened document).
`tauri.conf.json` sets `app.withGlobalTauri: true`, which exposes
`window.__TAURI__.core.invoke` on every webview. Each editor's
`desk-bridge-bootstrap.ts` (imported first in the editor's `main.tsx`)
defines a typed `window.__deskApp__` that calls those `invoke()`s
directly. There is no postMessage hop in the normal flow.

```
[Editor window]
   bootstrap defines window.__deskApp__ from ?desk=1 + ?file=…
       │
       ▼
   App.tsx  useEffect:
       const bridge = window.__deskApp__;
       if (bridge?.isDesktop) bridge.loadDocument()
                              → invoke('load_document', { path })
                              → Rust std::fs::read
                              → bytes
       handleSave / handleSaveAs:
                              → bridge.save(buffer) | bridge.saveAs(name, buffer)
                              → invoke('save_document' | 'save_document_as', …)
                              → Rust std::fs::write
```

The postMessage-based iframe path that older docs described is no longer
used in the runtime; the bootstrap still contains it for symmetry but it
only fires when the editor is loaded under an iframe parent (the launcher
no longer does that).

## Editor entry-points we own (in the upstream repos, gated on `?desk=1`)

These are the *only* edits we make in `docx/` and `sheets/`. Everything
else there is upstream code.

| File | Change |
|---|---|
| `docx/docx-editor/examples/vite/src/main.tsx` | `import './desk-bridge-bootstrap';` as the first line |
| `docx/docx-editor/examples/vite/src/desk-bridge-bootstrap.ts` | New file — defines `window.__deskApp__` |
| `docx/docx-editor/examples/vite/src/App.tsx` | Initial-load `useEffect` reads `bridge.filePath` and calls `loadDocument`; `handleSave` / `handleSaveAs` route through the bridge when `bridge?.isDesktop` |
| `sheets/apps/web/src/main.tsx` | Same first-import line |
| `sheets/apps/web/src/desk-bridge-bootstrap.ts` | New file — mirror of docx, plus a red error-overlay that pins runtime errors to the top of the iframe |
| `sheets/apps/web/src/App.tsx` | `useEffect` calls `bridge.loadDocument` → format-specific parser (xlsx / ods / csv / tsv) → `replaceWorkbook`; `replaceWorkbook` skips its 2-macrotask `snapshotRef` GC when `window.__deskApp__?.isDesktop` (was racing React 18 concurrent rendering and producing a blank canvas) |

These changes are additive and gated on `?desk=1` in the URL — the editors
still work as web apps when served from their original deploy hosts.

## What is NOT in this repo

- The editor packages themselves (`docx/docx-editor/packages/*`, the Univer
  npm packages). Editing those happens in the upstream repos.
- The Yjs collab server (`sheets/apps/server/`). The desktop is single-user.
- The Go WOPI backend (planned in the docx repo). Same reason.

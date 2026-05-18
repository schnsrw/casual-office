# Pipeline

How source becomes a runnable binary, dev cycle, and the data flow from
keystroke to disk.

## Build pipeline (one-time + repeated)

```
┌─ Upstream repos (separate git origins) ────────────────────────────────────┐
│                                                                            │
│  docx/docx-editor/        (Bun toolchain)                                  │
│    bun run build:demo -- --base=./                                         │
│        ↳ examples/vite/dist/index.html + assets/                           │
│                                                                            │
│  sheets/apps/web/         (pnpm toolchain)                                 │
│    pnpm vite build --base=./                                               │
│        ↳ apps/web/dist/index.html + assets/                                │
│                                                                            │
└──────┬──────────────────────────────────────────────────────────────┬──────┘
       │                                                              │
       ▼                                                              ▼
       └─────┬──── apps/shell/scripts/copy-editors.sh ──────────────┬─┘
             │                                                      │
             ▼                                                      ▼
       apps/shell/public/docx/                          apps/shell/public/sheets/
                                  │
                                  ▼
       Vite-builds the launcher,  inlines public/  into  apps/shell/dist/
                                  │
                                  ▼
       Tauri 2 bundle (tauri.conf.json frontendDist=../dist) embeds dist/
                                  │
                                  ▼
              target/release/deskapp-shell  (15-16 MB, Linux binary)
              target/release/bundle/deb/*.deb
              target/release/bundle/appimage/*.AppImage
```

The single command `pnpm prep:editors` runs both editor builds + the copy.

## Dev cycle

| Command | What it does | Use for |
|---|---|---|
| `pnpm prep:editors` | Build both editors → copy to `public/` | First setup or after editor source changes |
| `pnpm shell:dev` | Vite dev server for the launcher only (`http://localhost:5170`) | Iterating on launcher UI without rebuilding Tauri |
| `pnpm tauri:dev` | Tauri runs the launcher in a webview window | Iterating on launcher logic + Rust + actual webview behavior |
| `cd apps/shell/src-tauri && cargo check` | Rust type-check (5–10 s incremental) | Quick Rust verification |
| `cd apps/shell/src-tauri && cargo build` | Debug binary (~200 MB, slower runtime) | Local testing |
| `cd apps/shell/src-tauri && cargo build --release` | Release binary (~16 MB, fast) | Sharing with the user / smoke-testing perf |
| `pnpm tauri:build` | Full release + `.deb`/`.AppImage` | Shipping artifacts |

**The first cargo build is slow** (~3–5 min on a cold cache because the full
Tauri crate tree compiles). Subsequent incremental builds are 5–15 s.

## What changes invalidate what

| You changed | Rebuild |
|---|---|
| `docx/...` source | `pnpm build:docx && pnpm copy:editors`, then `cargo build` |
| `sheets/...` source | `pnpm build:sheets && pnpm copy:editors`, then `cargo build` |
| `apps/shell/src/*.ts` or `.css` or `index.html` | `pnpm build`, then `cargo build` |
| `apps/shell/src-tauri/src/*.rs` | `cargo build` |
| `apps/shell/src-tauri/tauri.conf.json` (icons, identifier, etc.) | `cargo build` |
| `apps/shell/src-tauri/capabilities/*.json` | `cargo build` |
| Tauri's embedded frontend assets (`apps/shell/dist/**`) | `cargo build` — the dist contents are embedded into the binary at compile time via `generate_context!()` |

## Runtime data flow

### Boot
```
exec target/release/deskapp-shell
   ↓
Tauri loads tauri.conf.json + capabilities
   ↓
Builder::default() → manage(RecentsState) → run()
   ↓
Main window opens at tauri://localhost/index.html  (the launcher)
   ↓
JS: boot()
   ↓
invoke('is_first_run')  → true → show wizard
                        → false → load profile + settings → show launcher
```

### Open document (no existing tab)
```
User clicks "Open file" card or Recent entry
   ↓
JS: open() dialog (tauri-plugin-dialog)  → file path
   ↓
JS: openOrReplaceLauncher('docx'|'sheets', path)
   ↓
   if path already open in a tab → activate that tab, return
   else if active tab is launcher → replace it
   else → push new tab
   ↓
JS: openDocumentInTab() creates <iframe src="<kind>/index.html?desk=1&file=…">
   ↓
Tauri serves the editor's index.html from the embedded dist
   ↓
Editor JS executes:
   1. desk-bridge-bootstrap.ts defines window.__deskApp__
   2. main.tsx mounts React
   3. App.tsx useEffect reads window.__deskApp__.filePath
   4. bridge.loadDocument() → postMessage to parent
   ↓
Parent's message router:
   tabForSource(event.source) → tab
   invoke('load_document', { path: tab.filePath })
   ↓
Rust: std::fs::read(path)  → Vec<u8>
   ↓
Parent posts {kind:'reply', result: bytes} back to iframe
   ↓
Editor parses bytes (DOCX → ProseMirror | XLSX → IWorkbookData)
   ↓
Editor renders
```

### Save
```
User hits Cmd/Ctrl-S in the editor
   ↓
Editor's onSave callback → bridge.save(buffer)
   ↓
   if bridge.filePath set:
     postMessage 'save' → parent invokes save_document
     Rust: std::fs::write(path, bytes)  → reply
   else (untitled / new doc):
     postMessage 'save' → parent calls save_document_as
     OS native save dialog → user picks path
     Rust: std::fs::write(picked_path, bytes)  → reply path
     bridge.filePath ← picked_path  (so next Save just overwrites)
```

### Detach tab → new window
```
User drags a tab below the strip
   ↓
dragend handler: rect.bottom + 100px < e.clientY  → detach
   ↓
invoke('open_document_window', { kind, filePath })
   ↓
Rust: WebviewWindowBuilder::new(label='doc-N', url='<kind>/index.html?desk=1&file=…')
   ↓
New OS window opens, loads editor
   ↓
Inside that window: bootstrap detects window.parent === window (top-level)
   ↓
Bridge uses window.__TAURI__.core.invoke directly (no parent to postMessage)
   ↓
Original launcher tab is closed; the new window owns that document now
```

## Release pipeline (future — not yet wired)

| Stage | Tooling |
|---|---|
| Per-PR CI | `pnpm exec tsc --noEmit && cargo check` on Ubuntu, macOS, Windows |
| Tagged release | `cargo tauri build` matrix: Linux (.deb + .AppImage), macOS (.dmg), Windows (.msi) |
| Code signing | macOS: `notarytool` with Apple developer ID; Windows: optional EV cert |
| Distribution | GitHub Releases artifacts; no app store today |
| Auto-update | Tauri updater plugin (opt-in; signed manifest hosted on GH Pages) |

None of these are running yet. Today: cargo build on the maintainer's box,
hand the binary over.

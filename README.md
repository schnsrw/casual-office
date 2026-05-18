# Casual Office

A single-user, cross-platform desktop editor for `.docx` and `.xlsx` files,
built by wrapping two browser-based editor codebases inside a Tauri 2
shell.

- **`.docx`** rendered by [`eigenpal/docx-editor`](https://github.com/schnsrw/docx)
  (Apache-2.0, React + ProseMirror with full OOXML fidelity)
- **`.xlsx`** rendered by [Univer OSS](https://github.com/dream-num/univer)
  (Apache-2.0, canvas grid + formula engine)
- **Shell** is a small Tauri 2 app (Rust + a vanilla-TS launcher) — system
  webview (~15 MB binary on Linux), one cross-OS codebase that targets Linux,
  Windows, and macOS

Files are read from disk and saved back natively — no browser-style "download"
flow. Each open document gets its own tab; tabs can be dragged out into a
separate OS window (Chrome-style).

## Quick start (Linux)

System prerequisites (Ubuntu 22.04):

```bash
sudo apt update && sudo apt install -y \
  libwebkit2gtk-4.1-dev libssl-dev librsvg2-dev \
  libayatana-appindicator3-dev build-essential curl wget file xdg-utils
```

Toolchain:

- Rust 1.94 + Cargo
- Node 20+ with pnpm 9+
- Bun ≥ 1.3.14 (for the docx editor; the rest is pnpm)
- Tauri CLI: `cargo install tauri-cli --version "^2" --locked`

Clone, build, run:

```bash
git clone https://github.com/schnsrw/casual-office.git
cd casual-office

# One-time: clone the two editor source repos in-tree.
git clone https://github.com/schnsrw/docx.git
git clone https://github.com/schnsrw/sheets.git

# Build both editor bundles and copy them into apps/shell/public/.
pnpm install
pnpm prep:editors

# Dev (Vite hot-reload + Tauri):
pnpm tauri:dev

# Release build (.deb + .AppImage on Linux):
pnpm tauri:build
```

The launcher comes up first; on a fresh install a setup wizard collects your
name + theme + default save folder, then the home screen appears.

## What works today

- First-run setup wizard (name, theme, default folder)
- Home screen with recent files (persisted at
  `~/.config/live.schnsrw.casualoffice/recent.json`)
- Open `.docx` / `.xlsx` from disk → opens in a new tab
- Save = writes back to the original path; Save As / new doc = native save
  dialog
- Drag a tab below the tab strip → detaches into a new OS window
- Drag-and-drop a file onto the launcher to open it
- Sticky tabs: opening a file that's already open focuses the existing tab

## Architecture in one diagram

```
┌─────────────────────────── Casual Office window ───────────────────────────┐
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │  Tab strip          [Home] [doc.docx ×] [sheet.xlsx ×]  [+]         │  │
│  ├─────────────────────────────────────────────────────────────────────┤  │
│  │  Panel (active tab):                                                │  │
│  │    • Home panel  → hero + cards + recent list                       │  │
│  │    • Editor iframe → docx or sheets dist, ?desk=1&file=…            │  │
│  │                                                                     │  │
│  │  Bridge: iframe ⇄ launcher via postMessage ⇄ Tauri commands         │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
                    │ load_document / save_document / save_document_as
                    ▼
   Tauri 2 Rust core  →  std::fs   (filesystem owns persistence)
                      →  native OS file dialogs
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full breakdown,
[`docs/PIPELINE.md`](docs/PIPELINE.md) for build/dev flow, and
[`docs/CODE-GRAPH.md`](docs/CODE-GRAPH.md) for where each piece lives.

## License

Casual Office shell: Apache-2.0.
Upstream editors keep their own licenses (docx-editor Apache-2.0, Univer Apache-2.0).

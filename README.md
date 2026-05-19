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
name + email + timezone + theme + default save folder, then the home
screen appears. Click the user chip in the top-right to edit any of it
later, including a profile picture.

## What works today

- First-run setup wizard (name, email, timezone, theme, default folder)
- Profile picture (any image; copied into the app config dir)
- Settings page (top-right chip → edit anything)
- Home screen with recent files (persisted at
  `~/.config/live.schnsrw.casualoffice/recent.json`)
- Open `.docx`, `.xlsx`, `.xlsm`, `.ods`, `.csv`, `.tsv` from disk
- Open-where dialog: "this window or new window?" with Remember-my-choice
- One Tauri window per document — own webview process, own event loop
- Save = writes back to the original path; Save As / new doc = native save
  dialog
- Drag-and-drop a file onto the launcher to open it
- File associations declared for `.docx` / `.xlsx` / `.xlsm` — once
  installed, set Casual Office as the OS default in your file manager
- DevTools enabled in release: right-click → Inspect Element

## Architecture in one diagram

```
                              Casual Office (Tauri 2)
                         ┌─────────────┴─────────────┐
                         ▼                           ▼
                  ┌──────────────┐         ┌─────────────────┐
                  │  Launcher    │         │  Doc window 1   │  ← own webview
                  │  window      │         │  (.docx)        │    process
                  │              │         └─────────────────┘
                  │  • Wizard    │         ┌─────────────────┐
                  │  • Home      │         │  Doc window 2   │  ← own webview
                  │  • Settings  │         │  (.xlsx)        │    process
                  │  • Open-where│         └─────────────────┘
                  └──────┬───────┘                  …
                         │ invoke('open_document_window', { kind, file })
                         ▼
                ┌──────────────────────────────────────────────┐
                │  Tauri Rust core  (apps/shell/src-tauri)     │
                │  load / save / save-as / recents /           │
                │  profile / settings / avatar / open-window   │
                └──────────────────┬───────────────────────────┘
                                   ▼
                ~/.config/live.schnsrw.casualoffice/
                  ├─ profile.json    (name, email, timezone, avatar_path)
                  ├─ settings.json   (theme, default folder, open prefs)
                  ├─ recent.json
                  └─ avatar.<ext>
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full breakdown,
[`docs/PIPELINE.md`](docs/PIPELINE.md) for build/dev flow, and
[`docs/CODE-GRAPH.md`](docs/CODE-GRAPH.md) for where each piece lives.

## License

Casual Office shell: Apache-2.0.
Upstream editors keep their own licenses (docx-editor Apache-2.0, Univer Apache-2.0).

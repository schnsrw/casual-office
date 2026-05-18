# Build instructions

This page is the recipe. For *why* it's shaped this way see
[ARCHITECTURE.md](ARCHITECTURE.md), and [PIPELINE.md](PIPELINE.md) for the
build pipeline diagram.

## Prerequisites — Linux (Ubuntu 22.04 LTS)

```bash
sudo apt update && sudo apt install -y \
  libwebkit2gtk-4.1-dev libssl-dev librsvg2-dev \
  libayatana-appindicator3-dev build-essential curl wget file xdg-utils
```

Toolchain:

| Tool | Version | Install |
|---|---|---|
| Rust + Cargo | 1.94+ | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` (or apt) |
| Node | 20.x | `nvm install 20` |
| pnpm | 9.x | `npm install -g pnpm` |
| Bun | ≥ 1.3.14 | `npm install -g bun` |
| Tauri CLI | 2.x | `cargo install tauri-cli --version "^2" --locked` |
| Python 3 + cairosvg | any | `pip install --user cairosvg` (only needed to regenerate the icon) |

## Prerequisites — Windows

Install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
with the "Desktop development with C++" workload and the Windows 10/11 SDK.
WebView2 is bundled in modern Windows; no extra install needed.

Then: Rust, Node 20, pnpm, Bun (`scoop install bun` or `npm i -g bun`),
Tauri CLI.

## Prerequisites — macOS

```bash
xcode-select --install
brew install rust node pnpm
npm install -g bun
cargo install tauri-cli --version "^2" --locked
```

WKWebView is part of macOS — no extra system deps.

## One-time setup

```bash
# Clone Casual Office
git clone https://github.com/schnsrw/casual-office.git
cd casual-office

# Clone the two editor source repos in-tree (separate origins, gitignored here)
git clone https://github.com/schnsrw/docx.git
git clone https://github.com/schnsrw/sheets.git

# Install workspace deps + build both editor bundles + copy them into the shell
pnpm install
pnpm prep:editors
```

## Dev loop

```bash
# Hot-reload launcher + Tauri:
pnpm tauri:dev
```

The launcher's Vite dev server runs at `http://localhost:5170`. Tauri opens
a webview pointed at it. Editor iframes are still served from the *built*
copies in `apps/shell/public/{docx,sheets}/`, so after editing the editors
themselves you need:

```bash
pnpm copy:editors     # if dist is already current
# OR
pnpm prep:editors     # full rebuild + copy
```

## Release build

```bash
# Compile-only: optimized binary, no installer.
cd apps/shell/src-tauri && cargo build --release

# Full bundle: also produces .deb + .AppImage (Linux), .dmg (macOS), .msi (Windows).
cd .. && pnpm tauri:build
```

Outputs land in `apps/shell/src-tauri/target/release/`:

- `deskapp-shell` — the binary itself (~16 MB on Linux)
- `bundle/deb/Casual Office_*.deb`
- `bundle/appimage/Casual Office_*.AppImage`

## Run it

```bash
# Linux: any of these
./apps/shell/src-tauri/target/release/deskapp-shell
sudo apt install ./apps/shell/src-tauri/target/release/bundle/deb/Casual\ Office_*.deb
./apps/shell/src-tauri/target/release/bundle/appimage/Casual\ Office_*.AppImage
```

First launch shows the setup wizard. Per-user state lives at
`~/.config/live.schnsrw.casualoffice/`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `cargo tauri build` errors about `libwebkit2gtk-4.1` | apt deps missing | install the prerequisite list above |
| Editor renders but assets 404 with `text/html` MIME | editor wasn't built with `--base=./` | re-run `pnpm prep:editors` |
| Wizard finishes but you stay on "Saving…" | A custom Tauri command hangs | `RUST_LOG=debug ./...deskapp-shell` to find the failing command |
| Blank/black iframe content | Editor JS crashed inside the iframe | Right-click in the live app → Inspect Element → console. The bootstrap also pins error overlays to the top of the iframe. |
| Drag-tab-out detaches even when reordering | dragend `clientY` heuristic too aggressive | adjust `DETACH_THRESHOLD_PX` in `apps/shell/src/main.ts` |
| `pkill -f deskapp-shell` doesn't free the port | Lingering Vite dev server | `pkill -f vite` |

## Regenerating the icon

The app icon is `apps/shell/assets/icon.svg`. After editing it:

```bash
python3 - <<'PY'
import cairosvg, os
SRC = "apps/shell/assets/icon.svg"
OUT = "apps/shell/src-tauri/icons"
for name, size in [("32x32.png", 32), ("128x128.png", 128),
                   ("128x128@2x.png", 256), ("icon.png", 512)]:
    cairosvg.svg2png(url=SRC, output_width=size, output_height=size,
                     write_to=os.path.join(OUT, name))
PY
```

Then `cargo build` to re-embed.

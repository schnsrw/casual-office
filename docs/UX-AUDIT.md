# UX Audit — Casual Office

A start-to-finish walk-through with comparisons to native desktop Office
suites (Microsoft Office, LibreOffice, Apple iWork). Items are tagged
**P0** (blocker / breaks the "desktop app" feel), **P1** (visible
friction), or **P2** (polish). Tracking-only — implementation tasks live
in the task list and in commit messages.

## 1. First launch & setup

**What we have:**
- `boot-skeleton` placeholder during the ~300 ms IPC roundtrip
- 3-step wizard: name + email + timezone → theme → default save folder
- Wizard state persisted to `~/.config/live.schnsrw.casualoffice/`

**Office reference:** Office shows an "Account" sign-in screen (we don't
need that — local-only product). LibreOffice has no wizard; first launch
goes straight to the start screen.

**Gaps:**

| Sev | Item |
|---|---|
| P2 | Wizard can't be re-opened after first run except by deleting the profile file. Add a "Re-run setup" entry in Settings → About. |
| P2 | Avatar picker isn't part of the wizard — only post-setup in Settings. |
| P2 | No skip-step option (everything past Name is optional). |

## 2. Home (launcher) screen

**What we have:**
- Hero with greeting + name
- 3 action cards (New doc / New sheet / Open file)
- Recent files list with: pinning (star), search filter, right-click
  context menu (Open / Open in new window / Pin · Unpin / Show in folder
  / Remove)
- Keyboard shortcut footer (Ctrl-N, Ctrl-Shift-N, Ctrl-O, Ctrl-,)
- Drag-and-drop a file → opens it
- "Open where?" modal (this window vs new window) with remember-choice
- User chip top-right opens Settings

**Office reference (Office Backstage / LibreOffice Start Center):**
- Recent files grid with thumbnails
- Pinned section visually separate from recents
- Templates gallery
- Account info column on left
- "Open Other Documents" entry routing to local browser dialog

**Gaps:**

| Sev | Item |
|---|---|
| P1 | No thumbnails on recent file rows — Office shows the first page preview. Generating these from .docx / .xlsx is non-trivial (would need server-side rasterization on first open). |
| P1 | No templates / "Create from template" — would need a template store + bundled defaults. |
| P2 | Pinned and unpinned items share one list — Office Backstage separates them visually under "Pinned" and "Recent" headers. |
| P2 | No keyboard navigation between recent rows (currently relies on Tab cycling through all `role=button`s). |
| P2 | No filter by file type (docx-only / xlsx-only). |
| P2 | Hero greeting doesn't change at midnight without a reload — refresh on document focus. |

## 3. Opening a document

**What we have:**
- Click card / recent / use Ctrl-O → native file dialog (or recent entry)
- Open-where dialog with "Remember my choice"
- Sticky-window: same file already open → focuses that window
- File-association handler — double-click a `.docx` in the file manager
  launches Casual Office (or routes to running instance via
  single-instance)
- Chunked-read load path with magic-byte sniff (catches OLE / non-ZIP
  files with a real error)

**Office reference:** Word / Excel double-click → opens in a window with
the file name in the title bar. Repeat opens focus the existing window.

**Gaps:**

| Sev | Item |
|---|---|
| P1 | No loading indicator while the editor window is starting up — first paint can take ~1-2 s on cold cache. Add a splash or loading overlay in the editor window itself. |
| P1 | If the editor fails to load the file (parse error, magic-byte mismatch), the error currently appears inside the editor's own UI. Could surface a launcher-side notification too. |
| P2 | No "Open with…" submenu inside the editor — once opened, the only way to switch files is back to launcher. |
| P2 | No recently-closed-document recovery — Office offers "Reopen last document". |

## 4. Editor windows (docx & sheets)

**What we have:**
- Each opened document = its own Tauri window, own webview process
- Native title bar (Tauri-default decorations) with the file name
- File contents loaded chunked-bytes from disk via the bridge
- Save / Save As route through `window.__deskApp__` → native OS dialogs
- Live window-title rename after Save As
- The upstream editor's own toolbar, menu bar, status bar
- DevTools available in release builds (right-click → Inspect)

**Office reference:** Word/Excel each have a Ribbon, Quick Access
Toolbar (Save/Undo/Redo top-left), File menu (Backstage), status bar
with page/word/zoom, side panels for navigation/comments.

**Gaps:**

| Sev | Item |
|---|---|
| **P0** | **Share / collab UI is still visible** in the sheets TitleBar (Share button, AvatarStack) and the docx demo's collab branch. Single-user desktop product — must hide. *(Fix in flight this turn.)* |
| **P0** | **No user profile indication** inside the editor. Office shows initials top-right. *(Adding in this turn — replaces the Share button slot.)* |
| P1 | No File menu entry pointing back to the launcher's Home view. Easy "Open another" path is missing. |
| P1 | No print / print-preview in either editor. |
| P1 | No spelling/grammar check. |
| P1 | No auto-save indicator. (Save button is present but state — "Modified" / "Saved" — isn't surfaced.) |
| P2 | No status-bar surface beyond the editor's built-in one. Could add a Casual-Office-branded strip with current file path, zoom, etc. |
| P2 | No templates. |
| P2 | No "Recent" submenu inside the File menu. |
| P2 | No multi-document tabs inside one window (we deliberately use one-window-per-doc; this is the natively-Office way for Excel, less so for Word). |
| P2 | No keyboard shortcut to focus the launcher window from inside an editor (Ctrl-Shift-H?). |

## 5. Saving

**What we have:**
- `Save` (Ctrl-S in editor) overwrites the bound file path
- `Save As` always prompts via native dialog
- New / untitled doc → first save acts like Save As
- File-write goes through Rust directly to disk
- Live title update after Save As

**Office reference:** Same semantics. Plus auto-save (cloud) and
versioning.

**Gaps:**

| Sev | Item |
|---|---|
| P1 | **Save IPC still goes through `Array.from(Uint8Array)`** which JSON-serializes the byte array. For a 50 MB save this is slow / risky. The load path is chunked now; save needs the same treatment via a `write_document_chunk` Rust command. |
| P1 | No auto-save / draft recovery on crash. Office writes `.tmp` and recovers on next launch. |
| P2 | No file-format conversion offer ("Save as PDF", "Save as ODT"). |
| P2 | Save success surfaces only inside the editor — could surface in the launcher's recent list (refresh ordering). |

## 6. Settings

**What we have:**
- Profile: name, email, timezone, avatar (image picker, ≤ 5 MB)
- Appearance: theme (system / light / dark)
- Files: default save folder
- About: app name, version, summary, privacy line
- "Saved" toast on commit
- Escape returns to home

**Office reference:** Word/Excel Options has 10+ tabs (General, Display,
Proofing, Save, Language, Advanced, Customize Ribbon, Quick Access,
Add-ins, Trust Center).

**Gaps:**

| Sev | Item |
|---|---|
| P2 | No keyboard shortcuts customization. |
| P2 | No language settings. |
| P2 | No "Re-run setup" / "Reset" affordance. |
| P2 | Timezone is a freeform `<input list>` — works but could be a grouped dropdown with regional groupings. |

## 7. Cross-cutting

| Sev | Item |
|---|---|
| P1 | No real-time external rename detection. If the user renames a file from the OS while it's open, the editor doesn't know. |
| P1 | No tabbed-within-window mode (Word ships single-window-per-doc by default, same as us; Excel groups workbooks in one window). |
| P1 | Material Symbols Outlined font is 3.9 MB. Subset to the icons sheets actually uses could drop this to ~50 KB. |
| P2 | No accessibility audit yet — screen-reader / high-contrast / keyboard-only tests. |
| P2 | No automated visual regression on the launcher (Playwright takes screenshots manually; no toMatchSnapshot yet). |
| P2 | No crash log surface — Rust panics today go to stderr only. |

## Priorities for the next pass

**P0 — fixing in this turn:**
- Remove Share button + AvatarStack + Share menu entry from sheets when running in Casual Office
- Hide the docx demo's collab UI when running in Casual Office
- Replace the Share slot with a user profile chip that shows the local user's avatar + first name

**P1 — short-list for the round after:**
- Chunked-write save path (`write_document_chunk`) — same as load
- Loading indicator in the editor window during open
- "Home" / launcher-focus shortcut from inside the editor
- File menu entry pointing back to the launcher
- Re-open the wizard from Settings

**P2 — polish backlog:**
- Recent file thumbnails
- Templates
- Print / print-preview
- Auto-save + crash recovery
- Spelling check
- Material Symbols subsetting

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

static WINDOW_SEQ: AtomicU32 = AtomicU32::new(0);
const MAX_RECENTS: usize = 20;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum DocKind {
    Docx,
    Sheets,
}

impl DocKind {
    fn subpath(&self) -> &'static str {
        match self {
            DocKind::Docx => "docx/index.html",
            DocKind::Sheets => "sheets/index.html",
        }
    }
    fn title_prefix(&self) -> &'static str {
        match self {
            DocKind::Docx => "Document",
            DocKind::Sheets => "Spreadsheet",
        }
    }
    fn from_path(path: &str) -> Option<Self> {
        let lower = path.to_lowercase();
        if lower.ends_with(".docx") {
            Some(DocKind::Docx)
        } else if lower.ends_with(".xlsx")
            || lower.ends_with(".xlsm")
            || lower.ends_with(".ods")
            || lower.ends_with(".csv")
            || lower.ends_with(".tsv")
            || lower.ends_with(".tab")
        {
            Some(DocKind::Sheets)
        } else {
            None
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RecentFile {
    path: String,
    kind: DocKind,
    last_opened: u64,
    /// True if the user pinned this file — pinned entries sort first
    /// in the launcher's recent list and aren't evicted when the list
    /// exceeds MAX_RECENTS. Defaults to false for backward compat with
    /// older recent.json files.
    #[serde(default)]
    pinned: bool,
}

#[derive(Default)]
struct RecentsState {
    list: Mutex<Vec<RecentFile>>,
}

fn recents_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir config dir: {e}"))?;
    Ok(dir.join("recent.json"))
}

fn load_recents(app: &AppHandle) -> Vec<RecentFile> {
    let path = match recents_path(app) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return Vec::new();
    };
    serde_json::from_slice::<Vec<RecentFile>>(&bytes).unwrap_or_default()
}

fn save_recents(app: &AppHandle, list: &[RecentFile]) -> Result<(), String> {
    let path = recents_path(app)?;
    let bytes = serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
fn get_recent_files(state: tauri::State<'_, RecentsState>) -> Vec<RecentFile> {
    state.list.lock().unwrap().clone()
}

#[tauri::command]
fn clear_recent_files(
    app: AppHandle,
    state: tauri::State<'_, RecentsState>,
) -> Result<(), String> {
    state.list.lock().unwrap().clear();
    save_recents(&app, &[])
}

#[tauri::command]
fn add_recent_file(
    app: AppHandle,
    state: tauri::State<'_, RecentsState>,
    path: String,
) -> Result<(), String> {
    touch_recent(&app, &state, &path);
    Ok(())
}

/// Remove a single entry from the recents list — used by the launcher
/// when it discovers a stale path (file moved/deleted on disk).
#[tauri::command]
fn remove_recent_file(
    app: AppHandle,
    state: tauri::State<'_, RecentsState>,
    path: String,
) -> Result<(), String> {
    let mut list = state.list.lock().unwrap();
    list.retain(|r| r.path != path);
    let snapshot = list.clone();
    drop(list);
    save_recents(&app, &snapshot)
}

fn touch_recent(app: &AppHandle, state: &RecentsState, path: &str) {
    let Some(kind) = DocKind::from_path(path) else {
        return;
    };
    let mut list = state.list.lock().unwrap();
    // Preserve a pre-existing pinned flag if the entry is already in the
    // list (we don't want re-opening a pinned file to silently unpin it).
    let was_pinned = list.iter().find(|r| r.path == path).map(|r| r.pinned).unwrap_or(false);
    list.retain(|r| r.path != path);
    list.insert(
        0,
        RecentFile {
            path: path.to_string(),
            kind,
            last_opened: now_secs(),
            pinned: was_pinned,
        },
    );
    // Truncate to MAX_RECENTS, but never evict pinned entries.
    if list.len() > MAX_RECENTS {
        let mut kept: Vec<RecentFile> = Vec::with_capacity(MAX_RECENTS);
        // Pinned first (preserve order), then most-recent unpinned to fill.
        for r in list.iter().filter(|r| r.pinned) {
            kept.push(r.clone());
        }
        for r in list.iter().filter(|r| !r.pinned) {
            if kept.len() >= MAX_RECENTS {
                break;
            }
            kept.push(r.clone());
        }
        *list = kept;
    }
    let snapshot = list.clone();
    drop(list);
    let _ = save_recents(app, &snapshot);
}

#[tauri::command]
fn set_recent_pinned(
    app: AppHandle,
    state: tauri::State<'_, RecentsState>,
    path: String,
    pinned: bool,
) -> Result<(), String> {
    let mut list = state.list.lock().unwrap();
    for r in list.iter_mut() {
        if r.path == path {
            r.pinned = pinned;
        }
    }
    // Bubble pinned entries to the top while keeping intra-group order
    // (sort_by_key is stable in Rust). Pinned == true sorts before false.
    list.sort_by_key(|r| !r.pinned);
    let snapshot = list.clone();
    drop(list);
    save_recents(&app, &snapshot)
}

/// Open a per-document Tauri window. Each opened file becomes a top-level
/// webview window so the editor gets its own process and event loop. If a
/// window is already showing the same file (sticky behavior), focus that
/// one instead of opening a duplicate — matches the convention of Excel
/// and Word when you double-click a file that's already open.
#[tauri::command]
async fn open_document_window(
    app: AppHandle,
    state: tauri::State<'_, RecentsState>,
    kind: DocKind,
    file_path: Option<String>,
) -> Result<String, String> {
    // Sticky-window: if this exact file is already open in another doc
    // window, focus that one instead of creating a duplicate.
    if let Some(p) = file_path.as_deref() {
        for window in app.webview_windows().values() {
            let label = window.label();
            if !label.starts_with("doc-") {
                continue;
            }
            if let Ok(url) = window.url() {
                if let Some(q) = url.query() {
                    let mut wants = "file=".to_string();
                    wants.push_str(&urlencoding_lite(p));
                    if q.contains(&wants) {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                        touch_recent(&app, &state, p);
                        return Ok(label.to_string());
                    }
                }
            }
        }
    }

    let id = WINDOW_SEQ.fetch_add(1, Ordering::SeqCst);
    let label = format!("doc-{id}");

    let title = match &file_path {
        Some(p) => format!(
            "{} — {}",
            kind.title_prefix(),
            std::path::Path::new(p)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(p)
        ),
        None => format!("{} — Untitled", kind.title_prefix()),
    };

    // Always include `desk=1` so the editor's bootstrap wires the
    // native-save bridge. The popped-out window is top-level, so the
    // bootstrap will route through the Tauri global `invoke` (requires
    // `withGlobalTauri: true` in tauri.conf.json).
    let mut url = format!("{}?desk=1", kind.subpath());
    if let Some(p) = file_path.as_ref() {
        url.push_str("&file=");
        url.push_str(&urlencoding_lite(p));
    }

    // The editor's own `desk-bridge-bootstrap.ts` runs as the first import
    // inside the new window; it defines window.__deskApp__ using either
    // postMessage (iframe — no longer used) or window.__TAURI__.core
    // (top-level window — the case here). No host-side injection needed.
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(&title)
        .inner_size(1280.0, 860.0)
        .min_inner_size(720.0, 480.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;

    if let Some(p) = file_path.as_deref() {
        touch_recent(&app, &state, p);
    }

    Ok(title)
}

/// Total size of a file. Used by the launcher to compute how many
/// chunks to ask for.
#[tauri::command]
fn document_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| format!("stat {path}: {e}"))
}

/// Read a slice of a file. The launcher reads documents in 1 MB chunks
/// so each individual IPC message stays well below any JSON-array
/// truncation threshold — observed behavior was that returning a 10 MB
/// Vec<u8> as JSON corrupted the tail, breaking JSZip's EOCD lookup in
/// the docx editor.
///
/// (Tauri 2 has a `tauri::ipc::Response::new(bytes)` API that's
/// supposed to side-step JSON entirely, but on this Linux/WebKitGTK
/// build we saw it still fail for large files. Chunked read sidesteps
/// the question by keeping each payload tiny.)
#[tauri::command]
async fn read_document_chunk(
    path: String,
    offset: u64,
    length: u64,
) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(&path).map_err(|e| format!("open {path}: {e}"))?;
    f.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("seek {path}@{offset}: {e}"))?;
    let mut buf = vec![0u8; length as usize];
    let n = f.read(&mut buf).map_err(|e| format!("read {path}: {e}"))?;
    buf.truncate(n);
    Ok(buf)
}

/// One-shot read kept around for small files and as a debugging hook —
/// the launcher's normal path is now read_document_chunk in a loop. For
/// anything past a few MB the JS side will hit the chunked path.
#[tauri::command]
async fn load_document(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))
}

/// Cheap existence check used by the launcher before opening a recent
/// file — saves the user from a confusing "couldn't render" if the file
/// has been moved or deleted since it was last opened.
#[tauri::command]
fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).is_file()
}

/// Open the OS file manager pointed at the directory containing the
/// given file. Matches the "Show in Finder" / "Show in File Explorer"
/// affordance in every Office product.
#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    // If the file is missing, open the parent dir we *can* reach. If even
    // that's missing, fall back to the user's home directory rather than
    // failing the user invisibly.
    let target = if p.is_file() {
        p.parent().map(|q| q.to_path_buf())
    } else if p.is_dir() {
        Some(p.to_path_buf())
    } else {
        None
    };
    let target = target.unwrap_or_else(|| {
        std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("/"))
    });
    let target_str = target.to_string_lossy().to_string();
    #[cfg(target_os = "linux")]
    let cmd = std::process::Command::new("xdg-open").arg(&target_str).spawn();
    #[cfg(target_os = "macos")]
    let cmd = std::process::Command::new("open").arg(&target_str).spawn();
    #[cfg(target_os = "windows")]
    let cmd = std::process::Command::new("explorer").arg(&target_str).spawn();
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    let cmd: Result<std::process::Child, std::io::Error> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "unsupported platform",
    ));
    cmd.map(|_| ()).map_err(|e| format!("open folder: {e}"))
}

#[tauri::command]
async fn save_document(path: String, bytes: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &bytes).map_err(|e| format!("write {path}: {e}"))
}

/// Truncate (or create) the file at `path`. First step of a chunked
/// save — the editor then calls write_save_chunk in a loop. Same
/// motivation as the chunked load: stays under the JSON-array IPC
/// truncation threshold for very large files.
#[tauri::command]
fn begin_save_document(path: String) -> Result<(), String> {
    std::fs::File::create(&path)
        .map(|_| ())
        .map_err(|e| format!("create {path}: {e}"))
}

/// Write a slice of the in-progress file. begin_save_document must run
/// first to truncate / create.
#[tauri::command]
fn write_save_chunk(path: String, offset: u64, bytes: Vec<u8>) -> Result<(), String> {
    use std::io::{Seek, SeekFrom, Write};
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .map_err(|e| format!("open {path}: {e}"))?;
    f.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("seek {path}@{offset}: {e}"))?;
    f.write_all(&bytes)
        .map_err(|e| format!("write {path}: {e}"))?;
    Ok(())
}

/// Show a Save As dialog and return the picked path without writing
/// anything. The editor then chunks bytes into write_save_chunk calls.
/// Returns Ok(None) if the user cancels.
#[tauri::command]
async fn pick_save_path(
    app: AppHandle,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Option<PathBuf>>();
    app.dialog()
        .file()
        .set_file_name(&suggested_name)
        .save_file(move |p| {
            let _ = tx.send(p.and_then(|fp| fp.into_path().ok()));
        });
    let chosen = rx.recv().map_err(|e| e.to_string())?;
    Ok(chosen.map(|p| p.to_string_lossy().to_string()))
}

/// Wipe the profile file so the next launcher boot routes back into
/// the first-run wizard. Called from the launcher's Settings panel.
#[tauri::command]
fn reset_profile(app: AppHandle) -> Result<(), String> {
    let path = profile_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Bring the launcher window (label "main") to the foreground. Called
/// by the in-editor Ctrl/Cmd-H shortcut so the user can pivot back to
/// the home view without alt-tabbing through the document list.
#[tauri::command]
fn focus_launcher_window(app: AppHandle) -> Result<(), String> {
    let Some(w) = app.get_webview_window("main") else {
        return Err("launcher window is not open".into());
    };
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    Ok(())
}

#[tauri::command]
async fn save_document_as(
    app: AppHandle,
    state: tauri::State<'_, RecentsState>,
    suggested_name: String,
    bytes: Vec<u8>,
) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Option<PathBuf>>();
    app.dialog()
        .file()
        .set_file_name(&suggested_name)
        .save_file(move |p| {
            let _ = tx.send(p.and_then(|fp| fp.into_path().ok()));
        });
    let chosen = rx.recv().map_err(|e| e.to_string())?;
    let Some(path) = chosen else {
        return Ok(None);
    };
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    let s = path.to_string_lossy().to_string();
    touch_recent(&app, &state, &s);
    Ok(Some(s))
}

// --- Profile + Settings (first-run wizard data) -----------------------------

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Profile {
    name: String,
    /// HSL hue (0–360) used by the UI to derive an avatar background color
    /// when there's no `avatar_path`. Stored rather than derived so changing
    /// the name later doesn't change the avatar color.
    avatar_hue: u16,
    /// IANA time zone (e.g. "America/New_York"). None = use system tz at
    /// display time.
    #[serde(default)]
    timezone: Option<String>,
    /// Optional email — not validated, not sent anywhere. Used as a hint
    /// in document author fields if present.
    #[serde(default)]
    email: Option<String>,
    /// Absolute path to a user-selected avatar image inside the app config
    /// dir (we copy the original here so deleting the source doesn't break
    /// the avatar).
    #[serde(default)]
    avatar_path: Option<String>,
    created_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Settings {
    /// "system" | "light" | "dark"
    theme: String,
    /// Default directory shown by the open/save dialogs. None = OS default.
    default_save_dir: Option<String>,
    /// "ask" | "same" | "new" — drives the open-where modal.
    #[serde(default)]
    open_window_preference: Option<String>,
    /// Version of Casual Office the user last saw the "What's new" screen
    /// for. None = never seen.
    #[serde(default)]
    last_seen_version: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            default_save_dir: None,
            open_window_preference: None,
            last_seen_version: None,
        }
    }
}

fn profile_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir config dir: {e}"))?;
    Ok(dir.join("profile.json"))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir config dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn is_first_run(app: AppHandle) -> bool {
    profile_path(&app)
        .map(|p| !p.exists())
        .unwrap_or(true)
}

#[tauri::command]
fn get_profile(app: AppHandle) -> Option<Profile> {
    let p = profile_path(&app).ok()?;
    let bytes = std::fs::read(&p).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[tauri::command]
fn save_profile(app: AppHandle, mut profile: Profile) -> Result<Profile, String> {
    let trimmed = profile.name.trim().to_string();
    if trimmed.is_empty() {
        return Err("name is required".into());
    }
    profile.name = trimmed;
    if profile.created_at == 0 {
        profile.created_at = now_secs();
    }
    // Normalize optional fields — empty strings come over the wire as Some("")
    // from the form; persist them as None.
    profile.email = profile.email.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    });
    profile.timezone = profile.timezone.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() { None } else { Some(t) }
    });
    let path = profile_path(&app)?;
    let bytes = serde_json::to_vec_pretty(&profile).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(profile)
}

/// Open a native image picker, copy the chosen file into the app config
/// dir as `avatar.<ext>`, and return the destination path. Returns Ok(None)
/// if the user cancels. The caller is responsible for updating the profile
/// to point at this path.
#[tauri::command]
async fn pick_avatar_image(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Option<PathBuf>>();
    app.dialog()
        .file()
        .add_filter("Image", &["png", "jpg", "jpeg", "webp", "gif"])
        .pick_file(move |p| {
            let _ = tx.send(p.and_then(|fp| fp.into_path().ok()));
        });
    let chosen = rx.recv().map_err(|e| e.to_string())?;
    let Some(src) = chosen else {
        return Ok(None);
    };
    // Cap avatar size at 5 MB. Anything larger is almost always the user
    // mistakenly picking a full-resolution photo; we read the file into JS
    // as a base64 data URL, and oversized images make that path very slow
    // (and bloat the data: URL cache).
    const MAX_AVATAR_BYTES: u64 = 5 * 1024 * 1024;
    if let Ok(meta) = std::fs::metadata(&src) {
        if meta.len() > MAX_AVATAR_BYTES {
            let mb = meta.len() as f64 / (1024.0 * 1024.0);
            return Err(format!(
                "Picture is too large ({mb:.1} MB). Pick an image under 5 MB."
            ));
        }
    }
    let ext = src
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("png")
        .to_lowercase();
    let cfg_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("config dir: {e}"))?;
    std::fs::create_dir_all(&cfg_dir).map_err(|e| e.to_string())?;
    let dst = cfg_dir.join(format!("avatar.{ext}"));
    // Strip any older avatar files with different extensions so we have
    // exactly one avatar on disk.
    for stale_ext in ["png", "jpg", "jpeg", "webp", "gif"] {
        let stale = cfg_dir.join(format!("avatar.{stale_ext}"));
        if stale != dst && stale.exists() {
            let _ = std::fs::remove_file(stale);
        }
    }
    std::fs::copy(&src, &dst).map_err(|e| format!("copy avatar: {e}"))?;
    Ok(Some(dst.to_string_lossy().to_string()))
}

/// Read an image file off disk and return its bytes — the launcher renders
/// the avatar as a data: URL so we never expose raw filesystem paths to
/// the webview's `src` attribute (Tauri's asset protocol works but needs
/// per-asset capability; this is simpler for one small image).
#[tauri::command]
async fn read_avatar_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("read avatar {path}: {e}"))
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    let Some(path) = settings_path(&app).ok() else {
        return Settings::default();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return Settings::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    let bytes = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(settings)
}

// --- File-association / single-instance handling --------------------------
//
// When the user double-clicks a .docx / .xlsx in the file manager, the OS
// launches Casual Office with the file path in argv (because of the
// `fileAssociations` block in tauri.conf.json). If Casual Office is already
// running, the OS still launches a second process; the
// `tauri-plugin-single-instance` plugin catches that, hands the second
// process's argv to the first via callback, and exits the second. Either
// way we end up opening the file in the running app.

/// Pull the first argv entry that looks like an existing path we support
/// (.docx, .xlsx, …). Skips argv[0] (the binary path) and any flags.
fn first_openable_path(args: &[String]) -> Option<String> {
    for arg in args.iter().skip(1) {
        if arg.starts_with('-') {
            continue;
        }
        if DocKind::from_path(arg).is_some() {
            return Some(arg.clone());
        }
    }
    None
}

/// Open the given file in a new document window. Called from setup() for
/// the initial argv path and from the single-instance handler for any
/// subsequent file-manager double-click.
fn open_file_path(app: &AppHandle, path: String) {
    let Some(kind) = DocKind::from_path(&path) else {
        return;
    };
    let id = WINDOW_SEQ.fetch_add(1, Ordering::SeqCst);
    let label = format!("doc-{id}");
    let title = format!(
        "{} — {}",
        kind.title_prefix(),
        std::path::Path::new(&path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&path)
    );
    let mut url = format!("{}?desk=1&file=", kind.subpath());
    url.push_str(&urlencoding_lite(&path));

    let _ = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
        .title(&title)
        .inner_size(1280.0, 860.0)
        .min_inner_size(720.0, 480.0)
        .resizable(true)
        .build();

    if let Some(state) = app.try_state::<RecentsState>() {
        touch_recent(app, &state, &path);
    }
}

#[tauri::command]
fn get_app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

// --- App entry --------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second `casual-office <file>` invocation arrived (or just
            // a bare `casual-office` re-launch). Forward any openable file
            // to the running instance; raise the launcher either way.
            if let Some(path) = first_openable_path(&args) {
                open_file_path(app, path);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
                let _ = w.unminimize();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let initial = load_recents(&app.handle());
            app.manage(RecentsState {
                list: Mutex::new(initial),
            });
            // Initial argv: if the OS launched us via a file association,
            // argv contains the path. Open it in a doc window once the app
            // is up. Done synchronously inside setup() — the app handle is
            // already valid and WebviewWindowBuilder::build returns
            // immediately.
            let args: Vec<String> = std::env::args().collect();
            if let Some(path) = first_openable_path(&args) {
                open_file_path(&app.handle(), path);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_document_window,
            get_recent_files,
            clear_recent_files,
            add_recent_file,
            remove_recent_file,
            set_recent_pinned,
            load_document,
            document_size,
            read_document_chunk,
            file_exists,
            reveal_in_folder,
            save_document,
            save_document_as,
            begin_save_document,
            write_save_chunk,
            pick_save_path,
            reset_profile,
            focus_launcher_window,
            is_first_run,
            get_profile,
            save_profile,
            pick_avatar_image,
            read_avatar_bytes,
            get_settings,
            save_settings,
            get_app_version,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn urlencoding_lite(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let is_safe = matches!(
            b,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/'
        );
        if is_safe {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

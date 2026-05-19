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

fn touch_recent(app: &AppHandle, state: &RecentsState, path: &str) {
    let Some(kind) = DocKind::from_path(path) else {
        return;
    };
    let mut list = state.list.lock().unwrap();
    list.retain(|r| r.path != path);
    list.insert(
        0,
        RecentFile {
            path: path.to_string(),
            kind,
            last_opened: now_secs(),
        },
    );
    list.truncate(MAX_RECENTS);
    let snapshot = list.clone();
    drop(list);
    let _ = save_recents(app, &snapshot);
}

/// Open a per-document Tauri window. Phase 0 spike: each window loads the
/// editor's built dist from /docx/index.html or /sheets/index.html.
/// Phase 1 will replace these with our own wrapper apps that import the
/// editor as a library and wire `window.__deskApp__` for native save/load.
#[tauri::command]
async fn open_document_window(
    app: AppHandle,
    state: tauri::State<'_, RecentsState>,
    kind: DocKind,
    file_path: Option<String>,
) -> Result<String, String> {
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

#[tauri::command]
async fn load_document(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))
}

#[tauri::command]
async fn save_document(path: String, bytes: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &bytes).map_err(|e| format!("write {path}: {e}"))
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
            load_document,
            save_document,
            save_document_as,
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

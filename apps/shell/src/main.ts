import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';

// =============================================================================
// Types
// =============================================================================

type DocKind = 'docx' | 'sheets';

interface RecentFile {
  path: string;
  kind: DocKind;
  last_opened: number;
  pinned: boolean;
}

interface Profile {
  name: string;
  avatar_hue: number;
  timezone: string | null;
  email: string | null;
  avatar_path: string | null;
  created_at: number;
}

interface Settings {
  theme: 'system' | 'light' | 'dark';
  default_save_dir: string | null;
  /** "ask" (show modal every time), "same", "new" — populated by the
   *  "Remember my choice" checkbox in the open-where dialog. */
  open_window_preference?: 'ask' | 'same' | 'new';
  /** Last app version the user saw the "What's new" modal for. */
  last_seen_version?: string | null;
}

/**
 * Inline release notes, newest first. Shown via the "What's new" modal
 * on the first launch after the app's CARGO_PKG_VERSION moves past
 * `settings.last_seen_version`. Keep entries short and concrete.
 */
const CHANGELOG: ReadonlyArray<{ version: string; title: string; highlights: string[] }> = [
  {
    version: '0.0.0',
    title: 'Welcome to Casual Office',
    highlights: [
      'Edit Word (.docx) and Excel (.xlsx, .ods, .csv, .tsv) files locally — nothing leaves your machine.',
      'One native window per document — same speed and isolation as Excel or Word.',
      'Save writes back to the original file; Save As always prompts for a new location.',
      'Profile + settings with custom picture, theme, and default save folder.',
      'Set Casual Office as the default app in your OS to open documents directly from the file manager.',
    ],
  },
];

// =============================================================================
// Tiny helpers
// =============================================================================

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(0, i) : '';
}

function relTime(epochSecs: number): string {
  const diff = Math.floor(Date.now() / 1000) - epochSecs;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function kindFromPath(path: string): DocKind | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.docx')) return 'docx';
  if (
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xlsm') ||
    lower.endsWith('.ods') ||
    lower.endsWith('.csv') ||
    lower.endsWith('.tsv') ||
    lower.endsWith('.tab')
  ) {
    return 'sheets';
  }
  return null;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

function applyTheme(theme: Settings['theme']) {
  document.documentElement.dataset.theme = theme;
}

function setStatus(msg: string) {
  const el = document.getElementById('status');
  if (el) el.textContent = msg;
}

// =============================================================================
// Toast — bottom-right transient notification. Auto-dismisses.
// =============================================================================

type ToastKind = 'default' | 'success' | 'error';

function toast(message: string, kind: ToastKind = 'default', durationMs = 3000) {
  const container = document.getElementById('toasts');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast${kind === 'default' ? '' : ` ${kind}`}`;
  el.textContent = message;
  container.appendChild(el);
  const dismiss = () => {
    el.classList.add('leaving');
    el.addEventListener(
      'animationend',
      () => el.remove(),
      { once: true },
    );
  };
  setTimeout(dismiss, durationMs);
  el.addEventListener('click', dismiss);
}

// =============================================================================
// State
// =============================================================================

const state = {
  profile: null as Profile | null,
  settings: { theme: 'system', default_save_dir: null } as Settings,
};

function openOrReplaceLauncher(kind: DocKind, filePath: string | null) {
  const pref = state.settings.open_window_preference ?? 'ask';
  if (pref === 'same') return doOpen(kind, filePath, 'same');
  if (pref === 'new') return doOpen(kind, filePath, 'new');
  askOpenChoice(kind, filePath);
}

function doOpen(kind: DocKind, filePath: string | null, where: 'same' | 'new') {
  if (filePath) {
    invoke('add_recent_file', { path: filePath }).catch(() => undefined);
  }
  if (where === 'same') {
    const params = new URLSearchParams({ desk: '1' });
    if (filePath) params.set('file', filePath);
    // Navigate the launcher window to the editor. The user can use
    // Alt+Left / Cmd+[ to return to the home screen.
    window.location.href = `${kind}/index.html?${params.toString()}`;
    return;
  }
  const label = filePath
    ? filePath.split(/[\\/]/).pop()
    : kind === 'docx'
      ? 'New document'
      : 'New spreadsheet';
  invoke('open_document_window', { kind, filePath })
    .then(() => {
      refreshRecents();
      toast(`Opened ${label}`, 'success');
    })
    .catch((err) => {
      console.error('open_document_window failed', err);
      toast(`Could not open: ${err}`, 'error', 5000);
    });
}

function askOpenChoice(kind: DocKind, filePath: string | null) {
  const modal = $('open-choice');
  const remember = $<HTMLInputElement>('open-choice-remember');
  const sub = $('open-choice-sub');
  const label = filePath ? filePath.split(/[\\/]/).pop() : kind === 'docx' ? 'New document' : 'New spreadsheet';
  sub.textContent = label ? `Open “${label}” in:` : 'Open in:';
  remember.checked = false;
  modal.hidden = false;
  // Default focus on the primary action so Enter activates it.
  setTimeout(() => $<HTMLButtonElement>('open-choice-same').focus(), 0);

  const sameBtn = $<HTMLButtonElement>('open-choice-same');
  const newBtn = $<HTMLButtonElement>('open-choice-new');
  const cancelBtn = $<HTMLButtonElement>('open-choice-cancel');
  const cleanup = () => {
    modal.hidden = true;
    sameBtn.removeEventListener('click', onSame);
    newBtn.removeEventListener('click', onNew);
    cancelBtn.removeEventListener('click', onCancel);
    window.removeEventListener('keydown', onKey);
  };
  const persistIfRemembered = (choice: 'same' | 'new') => {
    if (remember.checked) {
      const next: Settings = { ...state.settings, open_window_preference: choice };
      state.settings = next;
      invoke('save_settings', { settings: next }).catch(() => undefined);
    }
  };
  const onSame = () => {
    persistIfRemembered('same');
    cleanup();
    doOpen(kind, filePath, 'same');
  };
  const onNew = () => {
    persistIfRemembered('new');
    cleanup();
    doOpen(kind, filePath, 'new');
  };
  const onCancel = () => cleanup();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
    }
  };
  sameBtn.addEventListener('click', onSame);
  newBtn.addEventListener('click', onNew);
  cancelBtn.addEventListener('click', onCancel);
  window.addEventListener('keydown', onKey);
}

// =============================================================================
// Launcher home-panel actions
// =============================================================================

/** Cache of the last-fetched recent list — used by the search filter to
 *  re-render without re-hitting Rust on every keystroke. */
let lastRecentList: RecentFile[] = [];
let recentSearchQuery = '';
let recentTypeFilter: 'all' | 'docx' | 'sheets' = 'all';

/** Stable "what bucket does this file belong in" classifier. Office's
 *  Backstage view groups recent files the same way. */
function groupKeyFor(epochSecs: number): string {
  const now = new Date();
  const then = new Date(epochSecs * 1000);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const oneDay = 86400_000;
  const diffDays = Math.floor((startOfToday - new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()) / oneDay);
  if (epochSecs * 1000 >= startOfToday) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays <= 7) return 'this-week';
  if (diffDays <= 30) return 'this-month';
  return 'older';
}

const GROUP_LABELS: Record<string, string> = {
  pinned: 'Pinned',
  today: 'Today',
  yesterday: 'Yesterday',
  'this-week': 'Earlier this week',
  'this-month': 'Earlier this month',
  older: 'Older',
};

const GROUP_ORDER = ['pinned', 'today', 'yesterday', 'this-week', 'this-month', 'older'];

/** Stylized file icon — a 40×52 "page" shape (blue for docx, green for
 *  xlsx) with simulated content lines / grid. Not a real thumbnail, but
 *  visually consistent with how Office's Backstage represents files. */
function fileIconSvg(kind: DocKind): string {
  if (kind === 'docx') {
    return `
<svg class="file-icon" viewBox="0 0 40 52" aria-hidden="true">
  <rect x="0.5" y="0.5" width="39" height="51" rx="3" ry="3" fill="#fff" stroke="#2563eb33"/>
  <rect x="0.5" y="0.5" width="39" height="10" rx="3" ry="3" fill="#2563eb"/>
  <rect x="6" y="18" width="28" height="2.5" rx="1" fill="#2563eb55"/>
  <rect x="6" y="24" width="22" height="2.5" rx="1" fill="#2563eb44"/>
  <rect x="6" y="30" width="26" height="2.5" rx="1" fill="#2563eb44"/>
  <rect x="6" y="36" width="18" height="2.5" rx="1" fill="#2563eb44"/>
  <rect x="6" y="42" width="24" height="2.5" rx="1" fill="#2563eb44"/>
</svg>`;
  }
  return `
<svg class="file-icon" viewBox="0 0 40 52" aria-hidden="true">
  <rect x="0.5" y="0.5" width="39" height="51" rx="3" ry="3" fill="#fff" stroke="#1e7a4f33"/>
  <rect x="0.5" y="0.5" width="39" height="10" rx="3" ry="3" fill="#1e7a4f"/>
  <g stroke="#1e7a4f55" stroke-width="0.8">
    <line x1="6" y1="20" x2="34" y2="20"/>
    <line x1="6" y1="28" x2="34" y2="28"/>
    <line x1="6" y1="36" x2="34" y2="36"/>
    <line x1="6" y1="44" x2="34" y2="44"/>
    <line x1="16" y1="16" x2="16" y2="48"/>
    <line x1="26" y1="16" x2="26" y2="48"/>
  </g>
</svg>`;
}

async function refreshRecents() {
  try {
    lastRecentList = await invoke<RecentFile[]>('get_recent_files');
    renderRecents();
  } catch (err) {
    console.error('refreshRecents failed', err);
  }
}

function renderRecents() {
  const recent = $('recent');
  const empty = $('empty');
  const noMatch = $('recent-no-match');
  const groupsEl = $('recent-groups');
  groupsEl.innerHTML = '';
  if (lastRecentList.length === 0) {
    recent.hidden = true;
    empty.hidden = false;
    noMatch.hidden = true;
    return;
  }
  recent.hidden = false;
  empty.hidden = true;

  // Apply filters
  const q = recentSearchQuery.trim().toLowerCase();
  const matches = lastRecentList.filter((f) => {
    if (recentTypeFilter !== 'all' && f.kind !== recentTypeFilter) return false;
    if (q) {
      if (
        !f.path.toLowerCase().includes(q) &&
        !basename(f.path).toLowerCase().includes(q)
      )
        return false;
    }
    return true;
  });

  if (matches.length === 0) {
    noMatch.hidden = false;
    return;
  }
  noMatch.hidden = true;

  // Group: pinned files go in their own bucket regardless of recency.
  const groups = new Map<string, RecentFile[]>();
  for (const f of matches) {
    const key = f.pinned ? 'pinned' : groupKeyFor(f.last_opened);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }

  for (const key of GROUP_ORDER) {
    const list = groups.get(key);
    if (!list || list.length === 0) continue;
    const section = document.createElement('div');
    section.className = 'recent-group';

    const heading = document.createElement('div');
    heading.className = 'recent-group-head';
    heading.innerHTML = `<h3>${escapeHtml(GROUP_LABELS[key] ?? key)}</h3><span class="recent-group-count">${list.length}</span>`;
    section.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'recent-grid';
    for (const f of list) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `recent-card${f.pinned ? ' pinned' : ''}`;
      card.title = f.path;
      card.innerHTML = `
        ${fileIconSvg(f.kind)}
        <div class="recent-card-meta">
          <div class="recent-card-name">
            ${f.pinned ? '<span class="pin-mark" aria-label="Pinned">★</span>' : ''}
            ${escapeHtml(basename(f.path))}
          </div>
          <div class="recent-card-path">${escapeHtml(dirname(f.path))}</div>
          <div class="recent-card-time">${escapeHtml(relTime(f.last_opened))}</div>
        </div>
      `;
      card.addEventListener('click', () => openRecent(f));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openRecentContextMenu(f, e.clientX, e.clientY);
      });
      grid.appendChild(card);
    }
    section.appendChild(grid);
    groupsEl.appendChild(section);
  }
}

/**
 * Show a context menu for a recent-file entry. Pinned to the click
 * coordinates; first item is focused so Enter activates the primary
 * action; Esc or click-outside dismisses.
 */
function openRecentContextMenu(f: RecentFile, x: number, y: number) {
  closeAnyContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  const items: Array<{ label: string; run: () => void; primary?: boolean; divider?: boolean }> = [
    { label: 'Open', run: () => openRecent(f), primary: true },
    {
      label: 'Open in new window',
      run: () => {
        invoke('add_recent_file', { path: f.path }).catch(() => undefined);
        invoke('open_document_window', { kind: f.kind, filePath: f.path })
          .then(() => toast(`Opened ${basename(f.path)}`, 'success'))
          .catch((err) => toast(`Could not open: ${err}`, 'error', 4500));
      },
    },
    {
      label: f.pinned ? 'Unpin from top' : 'Pin to top',
      run: async () => {
        try {
          await invoke('set_recent_pinned', { path: f.path, pinned: !f.pinned });
          toast(f.pinned ? 'Unpinned' : 'Pinned to top');
        } catch (err) {
          toast(`Could not update pin: ${err}`, 'error', 4500);
        }
        await refreshRecents();
      },
    },
    {
      label: 'Show in folder',
      run: () => {
        invoke('reveal_in_folder', { path: f.path }).catch((err) => {
          toast(`Could not open folder: ${err}`, 'error', 4500);
        });
      },
    },
    {
      label: 'Remove from recents',
      run: async () => {
        try {
          await invoke('remove_recent_file', { path: f.path });
        } catch {
          /* best-effort */
        }
        await refreshRecents();
      },
    },
  ];
  for (const item of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'context-menu-item';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      item.run();
      closeAnyContextMenu();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  // Position: clamp inside the viewport.
  const r = menu.getBoundingClientRect();
  const maxLeft = window.innerWidth - r.width - 8;
  const maxTop = window.innerHeight - r.height - 8;
  menu.style.left = `${Math.min(x, maxLeft)}px`;
  menu.style.top = `${Math.min(y, maxTop)}px`;
  // Focus the first menu item so Enter activates the primary action.
  setTimeout(() => menu.querySelector<HTMLButtonElement>('.context-menu-item')?.focus(), 0);

  const dismiss = (e?: Event) => {
    if (e && menu.contains(e.target as Node)) return;
    closeAnyContextMenu();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAnyContextMenu();
    }
  };
  // Defer the global listeners by one frame so the contextmenu event that
  // opened us doesn't immediately close it.
  setTimeout(() => {
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('keydown', onKey);
  }, 0);
  // Stash cleanup on the element so closeAnyContextMenu can run it.
  (menu as HTMLElement & { __cleanup?: () => void }).__cleanup = () => {
    window.removeEventListener('mousedown', dismiss);
    window.removeEventListener('keydown', onKey);
    menu.remove();
  };
}

function closeAnyContextMenu() {
  for (const el of document.querySelectorAll<HTMLElement>('.context-menu')) {
    (el as HTMLElement & { __cleanup?: () => void }).__cleanup?.();
  }
}

/**
 * Open a recent file with a pre-flight existence check. If the path no
 * longer exists (user moved or deleted it since it was last opened),
 * show an actionable error toast instead of opening an editor that
 * silently fails to render.
 */
async function openRecent(f: RecentFile) {
  let exists = true;
  try {
    exists = await invoke<boolean>('file_exists', { path: f.path });
  } catch {
    /* if the check itself fails, fall through and let the editor decide */
  }
  if (!exists) {
    toast(`Couldn't find ${basename(f.path)} — removed from recents.`, 'error', 4500);
    try {
      await invoke('remove_recent_file', { path: f.path });
    } catch {
      /* best-effort */
    }
    await refreshRecents();
    return;
  }
  openOrReplaceLauncher(f.kind, f.path);
}

function bindHomePanel() {
  $('open-file').addEventListener('click', async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: 'All supported', extensions: ['docx', 'xlsx', 'xlsm', 'ods', 'csv', 'tsv', 'tab'] },
        { name: 'Word document', extensions: ['docx'] },
        { name: 'Spreadsheet', extensions: ['xlsx', 'xlsm', 'ods'] },
        { name: 'Delimited', extensions: ['csv', 'tsv', 'tab'] },
      ],
    });
    if (!selected || typeof selected !== 'string') return;
    const kind = kindFromPath(selected);
    if (!kind) {
      toast(`Unsupported file: ${basename(selected)}`, 'error', 4000);
      return;
    }
    openOrReplaceLauncher(kind, selected);
  });

  $('new-docx').addEventListener('click', () => openOrReplaceLauncher('docx', null));
  $('new-sheets').addEventListener('click', () => openOrReplaceLauncher('sheets', null));

  $('clear-recents').addEventListener('click', async () => {
    await invoke('clear_recent_files');
    await refreshRecents();
    toast('Recent files cleared');
  });

  // Filter recent files as the user types — pure client-side over the
  // cached list, no Rust round-trips.
  const search = $<HTMLInputElement>('recent-search');
  search.addEventListener('input', () => {
    recentSearchQuery = search.value;
    renderRecents();
  });

  // Type-filter buttons (All / Documents / Spreadsheets).
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.filter-btn')) {
    btn.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.filter-btn')) {
        other.classList.remove('active');
      }
      btn.classList.add('active');
      recentTypeFilter = (btn.dataset.filter as typeof recentTypeFilter) ?? 'all';
      renderRecents();
    });
  }
}

// =============================================================================
// Drag-and-drop: open files dropped on the window
// =============================================================================

async function bindDragDrop() {
  // The WebKitGTK Tauri runtime can fire a spurious 'enter' at startup
  // with an empty paths array. We filter that out: only show the overlay
  // when at least one supported file is actually being dragged.
  let dragActive = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const overlay = $('drop-overlay');
  const title = $('drop-title');
  const sub = $('drop-sub');

  const showOverlay = (supported: string[]) => {
    if (dragActive) return;
    dragActive = true;
    overlay.hidden = false;
    const n = supported.length;
    title.textContent = n === 1 ? 'Drop to open' : `Drop to open ${n} files`;
    sub.textContent = supported
      .slice(0, 3)
      .map((p) => p.split(/[\\/]/).pop())
      .join(' · ');
    // Safety net: if 'leave'/'drop' never fires (some WMs swallow it),
    // auto-hide after 4s of no movement.
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hideOverlay, 4000);
  };
  const hideOverlay = () => {
    dragActive = false;
    overlay.hidden = true;
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  try {
    await getCurrentWindow().onDragDropEvent(({ payload }) => {
      const t = (payload as { type?: string }).type;
      const paths = (payload as { paths?: string[] }).paths ?? [];
      // Don't accept anything while the first-run wizard is up.
      if (!$('wizard').hidden) return;

      if (t === 'enter') {
        const supported = paths.filter((p) => kindFromPath(p));
        if (supported.length > 0) showOverlay(supported);
      } else if (t === 'over') {
        // Keep the overlay alive while we're being hovered.
        if (dragActive && hideTimer) {
          clearTimeout(hideTimer);
          hideTimer = setTimeout(hideOverlay, 4000);
        }
      } else if (t === 'leave') {
        hideOverlay();
      } else if (t === 'drop') {
        hideOverlay();
        for (const p of paths) {
          const kind = kindFromPath(p);
          if (kind) openOrReplaceLauncher(kind, p);
        }
      }
    });
  } catch (err) {
    console.warn('drag-drop binding failed (non-Tauri context?)', err);
  }
}

// =============================================================================
// Keyboard shortcuts (global; editors handle Ctrl+S inside iframes themselves)
// =============================================================================

function bindShortcuts() {
  window.addEventListener('keydown', (e) => {
    const meta = e.ctrlKey || e.metaKey;
    if (!meta) return;
    const key = e.key.toLowerCase();
    // Ctrl/Cmd-O — Open file dialog
    if (key === 'o' && !e.shiftKey) {
      e.preventDefault();
      $('open-file').click();
    }
    // Ctrl/Cmd-N — New document (.docx)
    if (key === 'n' && !e.shiftKey) {
      e.preventDefault();
      $('new-docx').click();
    }
    // Ctrl/Cmd-Shift-N — New spreadsheet (.xlsx)
    if (key === 'n' && e.shiftKey) {
      e.preventDefault();
      $('new-sheets').click();
    }
    // Ctrl/Cmd-, — Settings (industry standard)
    if (key === ',') {
      e.preventDefault();
      if ($('settings-panel').hidden) showSettings();
      else hideSettings();
    }
  });
}

// =============================================================================
// Wizard
// =============================================================================

type WizardState = {
  step: 1 | 2 | 3;
  name: string;
  email: string;
  timezone: string;
  theme: Settings['theme'];
  dir: string | null;
};

const wiz: WizardState = {
  step: 1,
  name: '',
  email: '',
  timezone: detectTimezone(),
  theme: 'system',
  dir: null,
};

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/** Full IANA time zone list when the runtime supports it, falling back
 *  to a hand-picked common subset on older browsers. */
function supportedTimezones(): string[] {
  try {
    // Modern engines (WebKitGTK 2.40+, Chromium 99+, Firefox 93+).
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    if (typeof intl.supportedValuesOf === 'function') {
      return intl.supportedValuesOf('timeZone');
    }
  } catch {
    /* fall through */
  }
  return [
    'UTC',
    'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York',
    'America/Toronto', 'America/Mexico_City', 'America/Sao_Paulo',
    'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
    'Africa/Cairo', 'Africa/Johannesburg',
    'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Bangkok',
    'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul',
    'Australia/Sydney', 'Pacific/Auckland',
  ];
}

function populateTimezoneDatalist() {
  const list = document.getElementById('tz-list');
  if (!list) return;
  // Built once on boot; the option set is fixed for the runtime.
  if (list.children.length > 0) return;
  for (const tz of supportedTimezones()) {
    const opt = document.createElement('option');
    opt.value = tz;
    list.appendChild(opt);
  }
}

function showWizardStep(n: 1 | 2 | 3) {
  wiz.step = n;
  for (const s of document.querySelectorAll<HTMLElement>('.wiz-step')) {
    s.hidden = Number(s.dataset.step) !== n;
  }
  const prog = document.querySelector<HTMLElement>('.wiz-progress');
  if (prog) prog.dataset.step = String(n);
}

function bindWizard() {
  const nameInput = $<HTMLInputElement>('wiz-name');
  const emailInput = $<HTMLInputElement>('wiz-email');
  const tzInput = $<HTMLInputElement>('wiz-tz');
  const next1 = $<HTMLButtonElement>('wiz-next-1');
  // Prefill timezone with the system value; user can edit.
  tzInput.value = wiz.timezone;
  nameInput.addEventListener('input', () => {
    wiz.name = nameInput.value;
    next1.disabled = wiz.name.trim().length === 0;
  });
  emailInput.addEventListener('input', () => {
    wiz.email = emailInput.value;
  });
  tzInput.addEventListener('input', () => {
    wiz.timezone = tzInput.value;
  });
  next1.addEventListener('click', () => showWizardStep(2));

  $('wiz-back-2').addEventListener('click', () => showWizardStep(1));
  $('wiz-next-2').addEventListener('click', () => {
    const selected = document.querySelector<HTMLInputElement>('input[name=theme]:checked');
    wiz.theme = (selected?.value as Settings['theme']) ?? 'system';
    applyTheme(wiz.theme);
    showWizardStep(3);
  });

  $('wiz-back-3').addEventListener('click', () => showWizardStep(2));
  $('wiz-pick-dir').addEventListener('click', async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === 'string') {
      wiz.dir = picked;
      $<HTMLInputElement>('wiz-dir').value = picked;
    }
  });
  $('wiz-clear-dir').addEventListener('click', () => {
    wiz.dir = null;
    $<HTMLInputElement>('wiz-dir').value = '';
  });
  $('wiz-finish').addEventListener('click', finishWizard);
}

async function finishWizard() {
  const finishBtn = $<HTMLButtonElement>('wiz-finish');
  finishBtn.disabled = true;
  finishBtn.textContent = 'Saving…';
  try {
    const profile: Profile = {
      name: wiz.name.trim(),
      avatar_hue: hashHue(wiz.name.trim().toLowerCase()),
      timezone: wiz.timezone.trim() || null,
      email: wiz.email.trim() || null,
      avatar_path: null,
      created_at: 0,
    };
    const settings: Settings = {
      theme: wiz.theme,
      default_save_dir: wiz.dir,
    };
    const saved = await Promise.race([
      invoke<Profile>('save_profile', { profile }),
      new Promise<Profile>((_, reject) =>
        setTimeout(() => reject(new Error('Save profile timed out (5s)')), 5000),
      ),
    ]);
    state.profile = saved;
    const savedSettings = await Promise.race([
      invoke<Settings>('save_settings', { settings }),
      new Promise<Settings>((_, reject) =>
        setTimeout(() => reject(new Error('Save settings timed out (5s)')), 5000),
      ),
    ]);
    state.settings = savedSettings;
    applyTheme(state.settings.theme);
    revealWorkspace();
  } catch (err) {
    console.error('finishWizard failed', err);
    // Show error inline on the wizard so the user sees what went wrong
    // (alert() can be eaten by some Linux webviews).
    let errorEl = document.getElementById('wiz-error');
    if (!errorEl) {
      errorEl = document.createElement('p');
      errorEl.id = 'wiz-error';
      errorEl.className = 'settings-error';
      finishBtn.parentElement?.insertBefore(errorEl, finishBtn);
    }
    errorEl.textContent = `Could not save: ${err instanceof Error ? err.message : err}`;
    finishBtn.disabled = false;
    finishBtn.textContent = 'Finish setup';
  }
}

// =============================================================================
// Workspace boot
// =============================================================================

function revealWorkspace() {
  $('wizard').hidden = true;
  $('workspace').hidden = false;
  if (state.profile) {
    renderAvatar($<HTMLSpanElement>('user-avatar'), state.profile);
    const chipName = document.getElementById('user-chip-name');
    if (chipName) chipName.textContent = state.profile.name.split(/\s+/)[0];
    const greet = $('greeting');
    const hr = new Date().getHours();
    const partOfDay = hr < 5 ? 'Working late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
    greet.textContent = `${partOfDay}, ${state.profile.name.split(/\s+/)[0]}`;
  }
  refreshRecents();
  maybeShowWhatsNew();
}

// ---------- "What's new" modal --------------------------------------------

async function maybeShowWhatsNew() {
  let appVersion: string;
  try {
    appVersion = await invoke<string>('get_app_version');
  } catch {
    return;
  }
  // First-run wizard already covered "welcome" — only show this when the
  // user moves to a NEW version from a SEEN one. Wizard sets
  // last_seen_version on completion (below) so a fresh install doesn't
  // double-greet.
  const lastSeen = state.settings.last_seen_version ?? null;
  if (lastSeen === appVersion) return;
  if (lastSeen === null) {
    // First-ever launch (wizard already ran): just stamp the version and
    // skip — no changelog to compare against.
    await markVersionSeen(appVersion);
    return;
  }

  // Pick the changelog entry that matches the new version. If there's no
  // explicit entry, show the most recent one (covers minor bumps that
  // don't need their own block).
  const entry = CHANGELOG.find((c) => c.version === appVersion) ?? CHANGELOG[0];
  showWhatsNew(entry, appVersion);
}

function showWhatsNew(
  entry: (typeof CHANGELOG)[number],
  appVersion: string,
) {
  const modal = $('whats-new');
  $('whats-new-title').textContent = entry.title;
  $('whats-new-version').textContent = `Casual Office ${appVersion}`;
  const list = $<HTMLUListElement>('whats-new-list');
  list.innerHTML = '';
  for (const h of entry.highlights) {
    const li = document.createElement('li');
    li.textContent = h;
    list.appendChild(li);
  }
  modal.hidden = false;
  setTimeout(() => $<HTMLButtonElement>('whats-new-dismiss').focus(), 0);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      dismiss();
    }
  };
  const dismiss = async () => {
    modal.hidden = true;
    window.removeEventListener('keydown', onKey);
    await markVersionSeen(appVersion);
  };
  $('whats-new-dismiss').addEventListener('click', dismiss, { once: true });
  window.addEventListener('keydown', onKey);
}

async function markVersionSeen(version: string) {
  const next: Settings = { ...state.settings, last_seen_version: version };
  state.settings = next;
  try {
    await invoke('save_settings', { settings: next });
  } catch {
    /* best-effort */
  }
}

const avatarDataUrlCache = new Map<string, string>();

async function renderAvatar(el: HTMLElement, profile: Profile) {
  el.style.backgroundImage = '';
  el.textContent = '';
  if (profile.avatar_path) {
    try {
      let dataUrl = avatarDataUrlCache.get(profile.avatar_path);
      if (!dataUrl) {
        const bytes = await invoke<number[]>('read_avatar_bytes', { path: profile.avatar_path });
        const ext = profile.avatar_path.split('.').pop()?.toLowerCase() ?? 'png';
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'webp' ? 'image/webp'
          : ext === 'gif' ? 'image/gif'
          : 'image/png';
        // btoa needs a binary string; chunk to avoid call-stack overflow.
        let bin = '';
        const arr = Uint8Array.from(bytes);
        for (let i = 0; i < arr.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, Array.from(arr.subarray(i, i + 0x8000)));
        }
        dataUrl = `data:${mime};base64,${btoa(bin)}`;
        avatarDataUrlCache.set(profile.avatar_path, dataUrl);
      }
      el.style.backgroundImage = `url("${dataUrl}")`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.style.backgroundColor = 'transparent';
      return;
    } catch (err) {
      console.warn('avatar read failed', err);
    }
  }
  el.textContent = initials(profile.name);
  el.style.backgroundColor = `hsl(${profile.avatar_hue}, 55%, 50%)`;
}

// ---------- Settings panel -------------------------------------------------

function showSettings() {
  $('home-panel').hidden = true;
  $('settings-panel').hidden = false;
  $('user-chip').setAttribute('aria-pressed', 'true');
  populateSettings();
  // Escape returns to home.
  window.addEventListener('keydown', settingsEscape);
}

function hideSettings() {
  $('settings-panel').hidden = true;
  $('home-panel').hidden = false;
  $('user-chip').setAttribute('aria-pressed', 'false');
  $('settings-error').textContent = '';
  window.removeEventListener('keydown', settingsEscape);
}

function settingsEscape(e: KeyboardEvent) {
  if (e.key === 'Escape' && !$('settings-panel').hidden) {
    e.preventDefault();
    hideSettings();
  }
}

function populateSettings() {
  if (!state.profile) return;
  renderAvatar($('settings-avatar'), state.profile);
  $<HTMLInputElement>('settings-name').value = state.profile.name;
  $<HTMLInputElement>('settings-email').value = state.profile.email ?? '';
  $<HTMLInputElement>('settings-tz').value = state.profile.timezone ?? detectTimezone();
  $<HTMLInputElement>('settings-dir').value = state.settings.default_save_dir ?? '';
  for (const radio of document.querySelectorAll<HTMLInputElement>('input[name=settings-theme]')) {
    radio.checked = radio.value === state.settings.theme;
  }
  // App version in About — cheap call, but only on settings-open to keep
  // boot light.
  invoke<string>('get_app_version')
    .then((v) => {
      const el = document.getElementById('settings-version');
      if (el) el.textContent = `v${v}`;
    })
    .catch(() => undefined);
}

function bindSettings() {
  $('user-chip').addEventListener('click', showSettings);
  $('settings-close').addEventListener('click', hideSettings);

  $('settings-pick-avatar').addEventListener('click', async () => {
    try {
      const newPath = await invoke<string | null>('pick_avatar_image');
      if (!newPath || !state.profile) return;
      const next: Profile = { ...state.profile, avatar_path: newPath };
      state.profile = await invoke<Profile>('save_profile', { profile: next });
      avatarDataUrlCache.delete(newPath);
      await renderAvatar($('settings-avatar'), state.profile);
      await renderAvatar($('user-avatar'), state.profile);
      toast('Profile picture updated', 'success');
    } catch (err) {
      $('settings-error').textContent = `Could not set picture: ${err}`;
    }
  });

  $('settings-remove-avatar').addEventListener('click', async () => {
    if (!state.profile?.avatar_path) return;
    const next: Profile = { ...state.profile, avatar_path: null };
    try {
      state.profile = await invoke<Profile>('save_profile', { profile: next });
      await renderAvatar($('settings-avatar'), state.profile);
      await renderAvatar($('user-avatar'), state.profile);
      toast('Profile picture removed', 'success');
    } catch (err) {
      $('settings-error').textContent = `Could not remove picture: ${err}`;
    }
  });

  $('settings-pick-dir').addEventListener('click', async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === 'string') $<HTMLInputElement>('settings-dir').value = picked;
  });
  $('settings-clear-dir').addEventListener('click', () => {
    $<HTMLInputElement>('settings-dir').value = '';
  });

  $('settings-save').addEventListener('click', async () => {
    if (!state.profile) return;
    $('settings-error').textContent = '';
    const name = $<HTMLInputElement>('settings-name').value.trim();
    if (!name) {
      $('settings-error').textContent = 'Name is required.';
      return;
    }
    const themeRadio = document.querySelector<HTMLInputElement>('input[name=settings-theme]:checked');
    const theme = (themeRadio?.value as Settings['theme']) ?? 'system';
    const dir = $<HTMLInputElement>('settings-dir').value.trim() || null;
    const updatedProfile: Profile = {
      ...state.profile,
      name,
      email: $<HTMLInputElement>('settings-email').value,
      timezone: $<HTMLInputElement>('settings-tz').value,
    };
    const updatedSettings: Settings = {
      ...state.settings,
      theme,
      default_save_dir: dir,
    };
    const saveBtn = $<HTMLButtonElement>('settings-save');
    const originalLabel = saveBtn.textContent ?? 'Save changes';
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      state.profile = await invoke<Profile>('save_profile', { profile: updatedProfile });
      state.settings = await invoke<Settings>('save_settings', { settings: updatedSettings });
      applyTheme(state.settings.theme);
      await renderAvatar($('user-avatar'), state.profile);
      const chipName = document.getElementById('user-chip-name');
      if (chipName) chipName.textContent = state.profile.name.split(/\s+/)[0];
      hideSettings();
      toast('Settings saved', 'success');
    } catch (err) {
      $('settings-error').textContent = `Could not save: ${err}`;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = originalLabel;
    }
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function hideBootSkeleton() {
  const sk = document.getElementById('boot-skeleton');
  if (sk) sk.hidden = true;
}

async function boot() {
  populateTimezoneDatalist();
  bindWizard();
  bindHomePanel();
  bindSettings();
  bindShortcuts();
  // Drag-drop binding is fire-and-forget; failures shouldn't block boot.
  bindDragDrop();

  // Each IPC call gets a short timeout fallback so a single broken Tauri
  // command can't strand the user on a blank screen.
  const firstRun = await withTimeout(invoke<boolean>('is_first_run'), 3000, true);
  if (firstRun) {
    const s = await withTimeout(
      invoke<Settings>('get_settings'),
      2000,
      { theme: 'system', default_save_dir: null } as Settings,
    );
    state.settings = s;
    applyTheme(s.theme);
    hideBootSkeleton();
    $('wizard').hidden = false;
    showWizardStep(1);
    $<HTMLInputElement>('wiz-name').focus();
    return;
  }

  const profile = await withTimeout(invoke<Profile | null>('get_profile'), 2000, null);
  const settings = await withTimeout(
    invoke<Settings>('get_settings'),
    2000,
    { theme: 'system', default_save_dir: null } as Settings,
  );
  state.profile = profile;
  state.settings = settings;
  applyTheme(settings.theme);
  hideBootSkeleton();
  if (profile) {
    revealWorkspace();
  } else {
    $('wizard').hidden = false;
    showWizardStep(1);
  }
}

boot().catch((err) => {
  console.error('boot failed', err);
  hideBootSkeleton();
  // Show the wizard even on catastrophic failure so the user has somewhere
  // to start; the wizard's save_profile call will surface the real error.
  $('wizard').hidden = false;
  showWizardStep(1);
  const status = document.getElementById('status');
  if (status) status.textContent = `Startup error: ${err}`;
});

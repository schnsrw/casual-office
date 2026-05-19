import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';

// =============================================================================
// Types
// =============================================================================

type DocKind = 'docx' | 'sheets';
type TabKind = 'launcher' | DocKind;

interface RecentFile {
  path: string;
  kind: DocKind;
  last_opened: number;
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
}

interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  filePath: string | null; // null for launcher and untitled docs
  iframe?: HTMLIFrameElement;
}

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
// Bridge: each editor iframe talks to the host via postMessage. The editor
// inside the iframe sets up its own `window.__deskApp__` from its bootstrap
// module — this avoids the load-event race where iframe-injected globals
// arrive after the editor's initial useEffect already ran.
//
// The router below listens for `{ src: 'deskApp', kind: 'request', ... }`
// from any iframe, looks up the source tab, and dispatches the appropriate
// Tauri command. Replies are posted back with the same id.
// =============================================================================

interface BridgeRequest {
  src: 'deskApp';
  kind: 'request';
  id: number;
  method: 'loadDocument' | 'save' | 'saveAs';
  params: Record<string, unknown>;
}

function tabForSource(source: MessageEventSource | null): Tab | undefined {
  if (!source) return undefined;
  return state.tabs.find((t) => t.iframe?.contentWindow === source);
}

async function handleBridgeRequest(tab: Tab, req: BridgeRequest): Promise<unknown> {
  const { method, params } = req;
  if (method === 'loadDocument') {
    const path = (params.path as string | null | undefined) ?? tab.filePath;
    if (!path) throw new Error('no file path bound to this tab');
    return await invoke<number[]>('load_document', { path });
  }
  if (method === 'save') {
    const bytes = params.bytes as number[];
    // Product rule: Save writes back to the bound filePath. If untitled,
    // prompt once for a location (acts like Save As on first save).
    if (tab.filePath) {
      await invoke('save_document', { path: tab.filePath, bytes });
      return tab.filePath;
    }
    const written = await invoke<string | null>('save_document_as', {
      suggestedName: suggestedNameForKind(tab.kind),
      bytes,
    });
    if (written) bindPathToTab(tab.id, written);
    return written;
  }
  if (method === 'saveAs') {
    const bytes = params.bytes as number[];
    const suggestedName = (params.suggestedName as string) || suggestedNameForKind(tab.kind);
    const written = await invoke<string | null>('save_document_as', {
      suggestedName,
      bytes,
    });
    if (written) bindPathToTab(tab.id, written);
    return written;
  }
  throw new Error(`unknown bridge method: ${method}`);
}

function bindBridgeRouter() {
  window.addEventListener('message', async (event) => {
    const data = event.data as BridgeRequest | null;
    if (!data || data.src !== 'deskApp' || data.kind !== 'request') return;
    const tab = tabForSource(event.source);
    const reply = (result: unknown, error?: string) => {
      (event.source as Window | null)?.postMessage(
        { src: 'deskApp', kind: 'reply', id: data.id, result, error },
        { targetOrigin: event.origin || '*' },
      );
    };
    if (!tab) return reply(null, 'no tab matches the requesting iframe');
    try {
      const result = await handleBridgeRequest(tab, data);
      reply(result);
    } catch (err) {
      reply(null, err instanceof Error ? err.message : String(err));
    }
  });
}

function suggestedNameForKind(kind: TabKind): string {
  if (kind === 'docx') return 'Untitled.docx';
  if (kind === 'sheets') return 'Untitled.xlsx';
  return 'Untitled';
}

// =============================================================================
// State
// =============================================================================

const state = {
  profile: null as Profile | null,
  settings: { theme: 'system', default_save_dir: null } as Settings,
  tabs: [] as Tab[],
  activeTabId: '' as string,
  draggingTabId: null as string | null,
};

// Threshold (px below the tab strip) at which a drag is treated as
// "detach this tab into a new window" (Chrome-style).
const DETACH_THRESHOLD_PX = 100;

// =============================================================================
// Tabs: rendering, switching, lifecycle
// =============================================================================

function renderTabs() {
  const strip = $('tabstrip');
  strip.innerHTML = '';
  for (const tab of state.tabs) {
    const el = document.createElement('div');
    el.className = 'tab';
    el.dataset.tabId = tab.id;
    if (tab.id === state.activeTabId) el.classList.add('active');
    el.setAttribute('role', 'tab');
    el.tabIndex = 0;

    const icon = document.createElement('span');
    icon.className = `tab-icon ${tab.kind}`;
    el.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'tab-title';
    label.textContent = tab.title;
    label.title = tab.filePath || tab.title;
    el.appendChild(label);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.setAttribute('aria-label', `Close ${tab.title}`);
    closeBtn.innerHTML = '×';
    closeBtn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      closeTab(tab.id);
    });
    el.appendChild(closeBtn);

    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        // middle-click closes (Chrome convention)
        e.preventDefault();
        closeTab(tab.id);
        return;
      }
      activateTab(tab.id);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') activateTab(tab.id);
      if (e.key === 'Delete' || ((e.ctrlKey || e.metaKey) && e.key === 'w')) {
        e.preventDefault();
        closeTab(tab.id);
      }
    });

    // Drag-out support: Chrome-style detach-to-new-window when the user
    // drags the tab vertically past a threshold below the tab strip.
    // Launcher tabs aren't detachable (they're just an empty home view).
    if (tab.kind !== 'launcher') {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        state.draggingTabId = tab.id;
        el.classList.add('dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', `deskapp-tab:${tab.id}`);
        }
      });
      el.addEventListener('dragend', (e) => {
        el.classList.remove('dragging');
        const draggingId = state.draggingTabId;
        state.draggingTabId = null;
        if (!draggingId) return;
        const tabbar = document.querySelector<HTMLElement>('.tabbar');
        if (!tabbar) return;
        const rect = tabbar.getBoundingClientRect();
        // Drag ended below the tab bar by threshold, OR outside the window
        // entirely (clientX/Y are 0 when dropped past the OS window).
        const droppedOutside =
          e.clientY === 0 && e.clientX === 0
            ? true
            : e.clientY > rect.bottom + DETACH_THRESHOLD_PX;
        if (droppedOutside) detachTab(draggingId);
      });
    }
    strip.appendChild(el);
  }
}

async function detachTab(tabId: string) {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab || tab.kind === 'launcher') return;
  try {
    await invoke('open_document_window', { kind: tab.kind, filePath: tab.filePath });
    closeTab(tabId);
  } catch (err) {
    console.error('detachTab failed', err);
    setStatus(`Could not detach tab: ${err}`);
  }
}

function activateTab(id: string) {
  if (state.activeTabId === id) return;
  state.activeTabId = id;
  syncPanels();
  renderTabs();
}

function syncPanels() {
  const homePanel = $('home-panel');
  const framesEl = $('frames');
  const active = state.tabs.find((t) => t.id === state.activeTabId);
  if (!active) {
    homePanel.hidden = true;
    framesEl.hidden = true;
    return;
  }
  if (active.kind === 'launcher') {
    homePanel.hidden = false;
    framesEl.hidden = true;
    // Hide all iframes.
    for (const tab of state.tabs) tab.iframe?.classList.remove('active');
    refreshRecents();
  } else {
    homePanel.hidden = true;
    framesEl.hidden = false;
    for (const tab of state.tabs) {
      if (tab.iframe) {
        if (tab.id === active.id) tab.iframe.classList.add('active');
        else tab.iframe.classList.remove('active');
      }
    }
  }
}

function openLauncherTab() {
  const tab: Tab = {
    id: uid(),
    kind: 'launcher',
    title: 'Home',
    filePath: null,
  };
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  renderTabs();
  syncPanels();
}

async function openDocumentInTab(kind: DocKind, filePath: string | null, replaceTabId?: string) {
  const title = filePath ? basename(filePath) : suggestedNameForKind(kind);
  const newTab: Tab = { id: uid(), kind, title, filePath };

  // Build the iframe lazily so we don't pay for editor JS until needed.
  // Pass `?desk=1` + optional `?file=...` — the editor's
  // desk-bridge-bootstrap.ts reads these and wires window.__deskApp__
  // before any other module runs.
  const iframe = document.createElement('iframe');
  iframe.className = 'editor-frame';
  iframe.dataset.tabId = newTab.id;
  iframe.setAttribute('title', title);
  const params = new URLSearchParams({ desk: '1' });
  if (filePath) params.set('file', filePath);
  iframe.src = `${kind}/index.html?${params.toString()}`;
  newTab.iframe = iframe;
  $('frames').appendChild(iframe);

  if (replaceTabId) {
    // Replace the launcher (or another tab) with this editor in place.
    const idx = state.tabs.findIndex((t) => t.id === replaceTabId);
    if (idx >= 0) {
      const old = state.tabs[idx];
      old.iframe?.remove();
      state.tabs[idx] = newTab;
    } else {
      state.tabs.push(newTab);
    }
  } else {
    state.tabs.push(newTab);
  }
  state.activeTabId = newTab.id;
  renderTabs();
  syncPanels();

  if (filePath) {
    invoke('add_recent_file', { path: filePath }).catch(() => {
      /* recents persistence is best-effort */
    });
  }
}

function bindPathToTab(tabId: string, path: string) {
  const tab = state.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  tab.filePath = path;
  tab.title = basename(path);
  renderTabs();
}

function closeTab(id: string) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const tab = state.tabs[idx];
  tab.iframe?.remove();
  state.tabs.splice(idx, 1);
  if (state.tabs.length === 0) {
    openLauncherTab();
    return;
  }
  if (state.activeTabId === id) {
    state.activeTabId = state.tabs[Math.min(idx, state.tabs.length - 1)].id;
  }
  renderTabs();
  syncPanels();
}

function activeTab(): Tab | undefined {
  return state.tabs.find((t) => t.id === state.activeTabId);
}

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

async function refreshRecents() {
  try {
    const list = await invoke<RecentFile[]>('get_recent_files');
    const recent = $('recent');
    const empty = $('empty');
    const recentList = $<HTMLUListElement>('recent-list');
    recentList.innerHTML = '';
    if (list.length === 0) {
      recent.hidden = true;
      empty.hidden = false;
      return;
    }
    recent.hidden = false;
    empty.hidden = true;
    for (const f of list) {
      const li = document.createElement('li');
      li.setAttribute('role', 'button');
      li.tabIndex = 0;
      li.title = f.path;
      li.innerHTML = `
        <div class="recent-icon ${f.kind}"></div>
        <div class="recent-meta">
          <div class="recent-name">${escapeHtml(basename(f.path))}</div>
          <div class="recent-path">${escapeHtml(dirname(f.path))}</div>
        </div>
        <div class="recent-time">${escapeHtml(relTime(f.last_opened))}</div>
      `;
      const onClick = () => openOrReplaceLauncher(f.kind, f.path);
      li.addEventListener('click', onClick);
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') onClick();
      });
      recentList.appendChild(li);
    }
  } catch (err) {
    console.error('refreshRecents failed', err);
  }
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
      setStatus(`Unsupported file: ${selected}`);
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
}

function bindTabBar() {
  // Tabs were removed in favor of one-window-per-document. No-op kept so
  // boot() doesn't need conditional branches.
}

// =============================================================================
// Drag-and-drop: open files dropped on the window
// =============================================================================

async function bindDragDrop() {
  // Visual overlay is intentionally not toggled on enter/over/leave — the
  // WebKitGTK Tauri runtime fires a spurious 'enter' at startup which, with
  // an overlay at z-index 1000, blanketed the wizard. The drop is still
  // handled. We'll add visual feedback back once we filter the spurious
  // event reliably (probably by sniffing payload.paths length on enter).
  try {
    await getCurrentWindow().onDragDropEvent(({ payload }) => {
      const t = (payload as { type?: string }).type;
      if (t !== 'drop') return;
      // Don't accept drops while the first-run wizard is up — would route
      // to a launcher tab that doesn't exist yet.
      if (!$('wizard').hidden) return;
      const paths = (payload as { paths?: string[] }).paths ?? [];
      for (const p of paths) {
        const kind = kindFromPath(p);
        if (kind) openOrReplaceLauncher(kind, p);
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
      errorEl.className = 'hint';
      errorEl.style.color = '#dc2626';
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
  populateSettings();
  // Escape returns to home.
  window.addEventListener('keydown', settingsEscape);
}

function hideSettings() {
  $('settings-panel').hidden = true;
  $('home-panel').hidden = false;
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

async function boot() {
  bindWizard();
  bindHomePanel();
  bindSettings();
  bindTabBar();
  bindShortcuts();
  bindBridgeRouter();
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
  if (profile) {
    revealWorkspace();
  } else {
    $('wizard').hidden = false;
    showWizardStep(1);
  }
}

boot().catch((err) => {
  console.error('boot failed', err);
  // Show the wizard even on catastrophic failure so the user has somewhere
  // to start; the wizard's save_profile call will surface the real error.
  $('wizard').hidden = false;
  showWizardStep(1);
  const status = document.getElementById('status');
  if (status) status.textContent = `Startup error: ${err}`;
});

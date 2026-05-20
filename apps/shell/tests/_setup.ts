import type { Page } from '@playwright/test';

/**
 * Shared Tauri-API mock that the launcher's `invoke()` calls hit. Loaded
 * BEFORE every page script via `page.addInitScript`, so the Vite dev
 * server can serve the launcher unchanged and our tests still control
 * what `is_first_run` / `get_profile` / `save_*` / `open_document_window`
 * etc. resolve to.
 *
 * Override per-test by chaining your own addInitScript that mutates
 * `window.__deskApp_mock_state` before the launcher boots.
 */
export interface MockState {
  is_first_run: boolean;
  profile: {
    name: string;
    avatar_hue: number;
    timezone: string | null;
    email: string | null;
    avatar_path: string | null;
    created_at: number;
  } | null;
  settings: {
    theme: 'system' | 'light' | 'dark';
    default_save_dir: string | null;
    open_window_preference?: 'ask' | 'same' | 'new';
    last_seen_version?: string | null;
    privacy_mode?: boolean;
  };
  recents: Array<{
    path: string;
    kind: 'docx' | 'sheets';
    last_opened: number;
    pinned: boolean;
  }>;
  app_version: string;
}

export const defaultState: MockState = {
  is_first_run: false,
  profile: {
    name: 'Test User',
    avatar_hue: 200,
    timezone: 'UTC',
    email: null,
    avatar_path: null,
    created_at: 1_700_000_000,
  },
  settings: {
    theme: 'light',
    default_save_dir: null,
    last_seen_version: '0.0.0',
  },
  recents: [],
  app_version: '0.0.0',
};

export async function mockTauri(page: Page, state: Partial<MockState> = {}) {
  await page.addInitScript((initial) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__deskApp_mock_state = initial;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tauri = ((window as any).__TAURI__ = {
      core: {
        async invoke(cmd: string, args: Record<string, unknown> = {}) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const s = (window as any).__deskApp_mock_state as MockState;
          switch (cmd) {
            case 'is_first_run':
              return s.is_first_run;
            case 'get_profile':
              return s.profile;
            case 'save_profile':
              s.profile = args.profile as MockState['profile'];
              return s.profile;
            case 'get_settings':
              return s.settings;
            case 'save_settings':
              s.settings = args.settings as MockState['settings'];
              return s.settings;
            case 'get_recent_files':
              return s.recents;
            case 'clear_recent_files':
              s.recents = [];
              return;
            case 'add_recent_file':
              return;
            case 'remove_recent_file':
              s.recents = s.recents.filter((r) => r.path !== args.path);
              return;
            case 'set_recent_pinned':
              for (const r of s.recents) {
                if (r.path === args.path) r.pinned = args.pinned as boolean;
              }
              s.recents.sort((a, b) => Number(b.pinned) - Number(a.pinned));
              return;
            case 'file_exists':
              return true;
            case 'open_document_window':
              return 'mock-open';
            case 'load_document':
              return new ArrayBuffer(0);
            case 'save_document':
            case 'save_document_as':
              return null;
            case 'pick_avatar_image':
              return null;
            case 'read_avatar_bytes':
              return [];
            case 'reveal_in_folder':
              return;
            case 'get_app_version':
              return s.app_version;
            default:
              throw new Error(`mock: unhandled command ${cmd}`);
          }
        },
      },
      window: {
        getCurrentWindow: () => ({
          setTitle: async (_t: string) => undefined,
          show: async () => undefined,
          unminimize: async () => undefined,
          setFocus: async () => undefined,
          onDragDropEvent: async (_cb: (e: unknown) => void) => () => undefined,
        }),
      },
      dialog: {
        save: async () => null,
        open: async () => null,
      },
    });
    // The plugin-dialog / plugin-fs JS wrappers also use a base IPC
    // path; shim those so any imports resolve cleanly.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__TAURI_INTERNALS__ = {
      invoke: tauri.core.invoke,
      transformCallback: () => 0,
    };
  }, { ...defaultState, ...state });
}

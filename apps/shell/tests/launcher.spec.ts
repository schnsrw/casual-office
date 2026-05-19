import { test, expect } from '@playwright/test';
import { mockTauri } from './_setup';

test.describe('Launcher boot', () => {
  test('renders home for an existing profile', async ({ page }) => {
    await mockTauri(page, { is_first_run: false });
    await page.goto('/');
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.locator('#wizard')).toBeHidden();
    // Greeting includes one of the time-of-day prefixes plus the user's
    // first name. Just confirm the user's name made it in.
    await expect(page.locator('h1#greeting')).toContainText('Test');
  });

  test('renders wizard on first run', async ({ page }) => {
    await mockTauri(page, { is_first_run: true, profile: null });
    await page.goto('/');
    await expect(page.locator('#wizard')).toBeVisible();
    await expect(
      page.locator('section.wiz-step[data-step="1"] h1'),
    ).toContainText('Welcome to Casual Office');
  });
});

test.describe('Wizard flow', () => {
  test('three-step setup completes and reveals home', async ({ page }) => {
    await mockTauri(page, { is_first_run: true, profile: null });
    await page.goto('/');
    await page.locator('#wiz-name').fill('Sachin');
    await page.locator('#wiz-next-1').click();
    // Theme step. The <input type="radio"> is visually hidden behind a
    // span; click the label.
    await expect(page.locator('section.wiz-step[data-step="2"]')).toBeVisible();
    // The radio input is visually hidden; click the radio with force so we
    // don't trip on its 0-opacity overlay siblings.
    await page.locator('input[name=theme][value=light]').check({ force: true });
    await page.locator('#wiz-next-2').click();
    // Last-thing step
    await expect(page.locator('section.wiz-step[data-step="3"]')).toBeVisible();
    await page.locator('#wiz-finish').click();
    // Home
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.locator('#user-chip')).toBeVisible();
  });

  test('Continue is disabled until name is non-empty', async ({ page }) => {
    await mockTauri(page, { is_first_run: true, profile: null });
    await page.goto('/');
    await expect(page.locator('#wiz-next-1')).toBeDisabled();
    await page.locator('#wiz-name').fill('S');
    await expect(page.locator('#wiz-next-1')).toBeEnabled();
    await page.locator('#wiz-name').fill('');
    await expect(page.locator('#wiz-next-1')).toBeDisabled();
  });
});

test.describe('Home — action cards', () => {
  test('clicking "New document" shows the open-where modal', async ({ page }) => {
    await mockTauri(page);
    await page.goto('/');
    await page.locator('#new-docx').click();
    await expect(page.locator('#open-choice')).toBeVisible();
    await expect(page.locator('#open-choice-title')).toHaveText('Open where?');
  });

  test('open-where modal dismisses on Escape', async ({ page }) => {
    await mockTauri(page);
    await page.goto('/');
    await page.locator('#new-sheets').click();
    await expect(page.locator('#open-choice')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#open-choice')).toBeHidden();
  });

  test('Remembering the choice persists open_window_preference', async ({ page }) => {
    await mockTauri(page);
    await page.goto('/');
    await page.locator('#new-docx').click();
    await page.locator('#open-choice-remember').check();
    await page.locator('#open-choice-new').click();
    // Modal closes, settings mutated.
    await expect(page.locator('#open-choice')).toBeHidden();
    const pref = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__deskApp_mock_state.settings.open_window_preference,
    );
    expect(pref).toBe('new');
  });
});

test.describe('Settings panel', () => {
  test('opens via the user chip and closes via "Back to home"', async ({ page }) => {
    await mockTauri(page);
    await page.goto('/');
    await page.locator('#user-chip').click();
    await expect(page.locator('#settings-panel')).toBeVisible();
    await expect(page.locator('#user-chip')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#settings-close').click();
    await expect(page.locator('#settings-panel')).toBeHidden();
    await expect(page.locator('#user-chip')).toHaveAttribute('aria-pressed', 'false');
  });

  test('Escape dismisses Settings', async ({ page }) => {
    await mockTauri(page);
    await page.goto('/');
    await page.locator('#user-chip').click();
    await expect(page.locator('#settings-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-panel')).toBeHidden();
  });

  test('saving with an empty name shows the inline error', async ({ page }) => {
    await mockTauri(page);
    await page.goto('/');
    await page.locator('#user-chip').click();
    await page.locator('#settings-name').fill('');
    await page.locator('#settings-save').click();
    await expect(page.locator('#settings-error')).toContainText('Name is required');
  });

  test('Saving valid changes shows a toast and returns to home', async ({ page }) => {
    await mockTauri(page);
    await page.goto('/');
    await page.locator('#user-chip').click();
    await page.locator('#settings-name').fill('Renamed');
    await page.locator('#settings-save').click();
    await expect(page.locator('.toast.success')).toContainText('Settings saved');
    await expect(page.locator('#home-panel')).toBeVisible();
  });
});

test.describe('Recent files', () => {
  test('empty state when there are no recents', async ({ page }) => {
    await mockTauri(page, { recents: [] });
    await page.goto('/');
    await expect(page.locator('#empty')).toBeVisible();
    await expect(page.locator('#recent')).toBeHidden();
  });

  test('groups by time, separates pinned, and supports search filter', async ({ page }) => {
    const now = Math.floor(Date.now() / 1000);
    await mockTauri(page, {
      recents: [
        { path: '/home/u/report.docx', kind: 'docx', last_opened: now - 60, pinned: true },
        { path: '/home/u/numbers.xlsx', kind: 'sheets', last_opened: now - 120, pinned: false },
        { path: '/home/u/notes.docx', kind: 'docx', last_opened: now - 5 * 86400, pinned: false },
      ],
    });
    await page.goto('/');
    await expect(page.locator('#recent')).toBeVisible();
    const cards = page.locator('.recent-card');
    await expect(cards).toHaveCount(3);
    // Pinned bucket exists.
    await expect(page.locator('.recent-group-head h3', { hasText: 'Pinned' })).toBeVisible();

    await page.locator('#recent-search').fill('numbers');
    await expect(cards).toHaveCount(1);
    await expect(page.locator('.recent-card-name')).toContainText('numbers.xlsx');

    await page.locator('#recent-search').fill('does-not-exist');
    await expect(page.locator('#recent-no-match')).toBeVisible();
  });

  test('type filter narrows by kind', async ({ page }) => {
    const now = Math.floor(Date.now() / 1000);
    await mockTauri(page, {
      recents: [
        { path: '/home/u/a.docx', kind: 'docx', last_opened: now - 60, pinned: false },
        { path: '/home/u/b.xlsx', kind: 'sheets', last_opened: now - 60, pinned: false },
      ],
    });
    await page.goto('/');
    await expect(page.locator('.recent-card')).toHaveCount(2);
    await page.locator('.filter-btn', { hasText: 'Documents' }).click();
    await expect(page.locator('.recent-card')).toHaveCount(1);
    await expect(page.locator('.recent-card-name')).toContainText('a.docx');
    await page.locator('.filter-btn', { hasText: 'All' }).click();
    await expect(page.locator('.recent-card')).toHaveCount(2);
  });

  test('right-click opens the context menu', async ({ page }) => {
    const now = Math.floor(Date.now() / 1000);
    await mockTauri(page, {
      recents: [
        { path: '/home/u/x.docx', kind: 'docx', last_opened: now - 60, pinned: false },
      ],
    });
    await page.goto('/');
    await page.locator('.recent-card').first().click({ button: 'right' });
    await expect(page.locator('.context-menu')).toBeVisible();
    await expect(page.locator('.context-menu-item').first()).toHaveText('Open');
    await page.keyboard.press('Escape');
    await expect(page.locator('.context-menu')).toBeHidden();
  });
});

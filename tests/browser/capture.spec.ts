import { expect, test } from '@playwright/test';

test('a fresh collection captures a task in Inbox and retains it after reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'All Tasks', exact: true })).toBeVisible();
  await expect(page.getByText('No active tasks yet.')).toBeVisible();
  const title = page.getByRole('textbox', { name: 'Task title' });
  await title.fill('  Plan  the week  ');
  await title.press('Enter');
  await expect(page.getByRole('list', { name: 'Tasks' }).getByRole('listitem')).toHaveCount(1);
  await expect(page.getByText('Plan  the week', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Priority for Plan  the week' })).toHaveValue('normal');
  await expect(title).toHaveValue('');
  await expect(title).toBeFocused();
  await page.reload();
  await expect(page.getByText('Plan  the week', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page.getByText('Plan  the week', { exact: true })).toBeVisible();
});

test('saved Priority changes order tasks High, Normal, Low and survive reload', async ({ page }) => {
  await page.goto('/');
  const title = page.getByRole('textbox', { name: 'Task title' });
  for (const text of ['First task', 'Second task', 'Third task', 'Fourth task']) {
    await title.fill(text);
    await title.press('Enter');
    await expect(title).toHaveValue('');
  }
  await page.getByRole('combobox', { name: 'Priority for First task' }).selectOption('low');
  await page.getByRole('combobox', { name: 'Priority for Third task' }).selectOption('high');
  await page.getByRole('combobox', { name: 'Priority for Fourth task' }).selectOption('high');
  const rows = page.getByRole('list', { name: 'Tasks' }).getByRole('listitem');
  await expect(rows).toHaveText([
    /Third task.*Inbox.*High/s,
    /Fourth task.*Inbox.*High/s,
    /Second task.*Inbox.*Normal/s,
    /First task.*Inbox.*Low/s,
  ]);
  await page.reload();
  await expect(rows).toHaveText([
    /Third task/s, /Fourth task/s, /Second task/s, /First task/s,
  ]);
  await expect(page.getByRole('combobox', { name: 'Priority for First task' })).toHaveValue('low');
});

test('a blank title is rejected accessibly without discarding input or saving a task', async ({ page }) => {
  await page.goto('/');
  const title = page.getByRole('textbox', { name: 'Task title' });
  await title.fill('   ');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a task title');
  await expect(title).toHaveAttribute('aria-invalid', 'true');
  await expect(title).toHaveValue('   ');
  await expect(title).toBeFocused();
  await page.getByRole('button', { name: 'Retry loading' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(title).toHaveValue('   ');
  await expect(title).toHaveAttribute('aria-invalid', 'false');
  await page.reload();
  await expect(page.getByText('No active tasks yet.')).toBeVisible();
});

test('unavailable storage is not an empty collection and can be retried', async ({ page }) => {
  await page.addInitScript(() => {
    const storage = globalThis.indexedDB;
    let firstRead = true;
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      get() {
        if (firstRead) {
          firstRead = false;
          throw new DOMException('Storage denied', 'SecurityError');
        }
        return storage;
      },
    });

  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('storage');
  await expect(page.getByText('No active tasks yet.')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Task title' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry loading' }).click();
  await expect(page.getByText('No active tasks yet.')).toBeVisible();
});

test('duplicate script-like titles remain inert, announce committed capture and work offline after load', async ({ page, context }) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('No active tasks yet.')).toBeVisible();
  await context.setOffline(true);
  const title = page.getByRole('textbox', { name: 'Task title' });
  const text = '<img src=x onerror="throw new Error(\'executed\')">';
  await title.fill(text);
  await title.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('Task added to Inbox');
  await expect(title).toBeFocused();
  await title.fill(text);
  await title.press('Enter');
  await expect(page.getByRole('list', { name: 'Tasks' }).getByRole('listitem')).toHaveCount(2);
  await expect(page.getByText(text, { exact: true })).toHaveCount(2);
  await expect(page.getByRole('img')).toHaveCount(0);
  expect(runtimeErrors).toEqual([]);
});

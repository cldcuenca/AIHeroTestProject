import { expect, test } from '@playwright/test';

test('Active and Completed retain the selected List, offer capture only in Active, and restart in All Tasks/Active', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Active', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('textbox', { name: 'Task title' }).fill('Unsubmitted thought');
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(page.getByText('No completed tasks yet.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Task title' })).toHaveCount(0);
  await page.getByRole('button', { name: 'All Tasks', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Completed', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Task title' })).toHaveValue('Unsubmitted thought');
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'All Tasks', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Active', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('No active tasks yet.')).toBeVisible();
});

test('a failed status-view read shows an error, never tasks from the previous status or a false empty state', async ({ page }) => {
  await page.goto('/');
  const title = page.getByRole('textbox', { name: 'Task title' });
  await title.fill('Still active');
  await title.press('Enter');
  await expect(title).toHaveValue('');
  await page.evaluate(() => {
    const get = IDBObjectStore.prototype.get;
    let failNext = true;
    IDBObjectStore.prototype.get = function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      if (failNext) {
        failNext = false;
        throw new DOMException('Read denied', 'SecurityError');
      }
      return get.call(this, key);
    };
  });
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('storage failed');
  await expect(page.getByText('Still active', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No completed tasks yet.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry loading' }).click();
  await expect(page.getByText('No completed tasks yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(page.getByText('Still active', { exact: true })).toBeVisible();
});

test('a failed Completed deletion retains its inert named confirmation and saved task, then retries safely', async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  const text = '<img src=x onerror="throw new Error(\'executed\')">';
  await page.goto('/');
  const title = page.getByRole('textbox', { name: 'Task title' });
  await title.fill(text);
  await title.press('Enter');
  await expect(title).toHaveValue('');
  await page.getByRole('button', { name: `Complete ${text}`, exact: true }).click();
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  const trigger = page.getByRole('button', { name: `Delete ${text}`, exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Delete task?', exact: true });
  await expect(dialog).toContainText(text);
  await expect(dialog.getByRole('img')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
  await expect(trigger).toBeFocused();
  await page.reload();
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(trigger).toBeVisible();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    let abortNext = true;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = key === undefined ? put.call(this, value) : put.call(this, value, key);
      if (abortNext) {
        abortNext = false;
        request.addEventListener('success', () => this.transaction.abort());
      }
      return request;
    };
  });
  await trigger.click();
  const confirm = dialog.getByRole('button', { name: 'Delete permanently', exact: true });
  await confirm.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('storage failed');
  await expect(confirm).toBeFocused();
  await expect(page.getByRole('status')).not.toContainText('deleted');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
  await expect(trigger).toBeFocused();
  await page.reload();
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(trigger).toBeVisible();
  await trigger.click();
  await confirm.press('Enter');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Completed', exact: true })).toBeFocused();
  await expect(page.getByText('No completed tasks yet.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('No active tasks yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(page.getByText('No completed tasks yet.')).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test('permanent deletion names the Active task, traps keyboard focus, cancels unchanged, and removes only after confirmation', async ({ page }) => {
  await page.goto('/');
  const title = page.getByRole('textbox', { name: 'Task title' });
  await title.fill('Keep until confirmed');
  await title.press('Enter');
  await expect(title).toHaveValue('');
  await title.fill('Unsubmitted capture');
  const trigger = page.getByRole('button', { name: 'Delete Keep until confirmed', exact: true });
  await trigger.focus();
  await trigger.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Delete task?', exact: true });
  await expect(dialog).toContainText('Keep until confirmed');
  await expect(dialog).toContainText('cannot be undone');
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Delete permanently', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await expect(title).toHaveValue('Unsubmitted capture');
  await trigger.press('Enter');
  await cancel.press('Enter');
  await expect(trigger).toBeFocused();
  await page.reload();
  await expect(page.getByText('Keep until confirmed', { exact: true })).toBeVisible();
  await trigger.click();
  await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).press('Enter');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Task permanently deleted.');
  await expect(page.getByRole('button', { name: 'Active', exact: true })).toBeFocused();
  await page.reload();
  await expect(page.getByText('No active tasks yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(page.getByText('No completed tasks yet.')).toBeVisible();
});

test('Completed sorting uses Priority and original age, including committed Priority changes and reopening', async ({ page }) => {
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
  for (const text of ['Fourth task', 'Third task', 'Second task', 'First task']) {
    await page.getByRole('button', { name: `Complete ${text}`, exact: true }).click();
    await expect(page.getByRole('button', { name: `Complete ${text}`, exact: true })).toHaveCount(0);
  }
  await expect(page.getByText('No active tasks yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  const rows = page.getByRole('list', { name: 'Tasks' }).getByRole('listitem');
  await expect(rows).toHaveText([/Third task/, /Fourth task/, /Second task/, /First task/]);
  const priority = page.getByRole('combobox', { name: 'Priority for Third task' });
  await priority.selectOption('normal');
  await expect(page.getByRole('status')).toHaveText('Priority saved.');
  await expect(priority).toBeFocused();
  await expect(rows).toHaveText([/Fourth task/, /Second task/, /Third task/, /First task/]);
  await page.reload();
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(rows).toHaveText([/Fourth task/, /Second task/, /Third task/, /First task/]);
  for (const text of ['Third task', 'Second task']) {
    await page.getByRole('button', { name: `Reopen ${text}`, exact: true }).click();
    await expect(page.getByRole('button', { name: `Reopen ${text}`, exact: true })).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(rows).toHaveText([/Second task/, /Third task/]);
});

test('complete and reopen move the same task between saved List/status views without changing its creation order', async ({ page }) => {
  await page.goto('/');
  const title = page.getByRole('textbox', { name: 'Task title' });
  for (const text of ['Older work', 'Newer work']) {
    await title.fill(text);
    await title.press('Enter');
    await expect(title).toHaveValue('');
  }
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  const complete = page.getByRole('button', { name: 'Complete Older work', exact: true });
  await complete.focus();
  await complete.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Task completed.');
  await expect(page.getByRole('button', { name: 'Active', exact: true })).toBeFocused();
  await expect(page.getByText('Older work', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(page.getByText('Older work', { exact: true })).toBeVisible();
  await expect(page.getByText('Newer work', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Older work', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  const reopen = page.getByRole('button', { name: 'Reopen Older work', exact: true });
  await reopen.focus();
  await reopen.press('Enter');
  await expect(page.getByRole('status')).toHaveText('Task reopened.');
  await expect(page.getByRole('button', { name: 'Completed', exact: true })).toBeFocused();
  await expect(page.getByText('No completed tasks yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Tasks' }).getByRole('listitem'))
    .toHaveText([/Older work/, /Newer work/]);
  await page.reload();
  await expect(page.getByRole('list', { name: 'Tasks' }).getByRole('listitem'))
    .toHaveText([/Older work/, /Newer work/]);
});

for (const action of ['Complete', 'Reopen'] as const) {
  test(`a failed ${action} transaction keeps committed status and focus without false success`, async ({ page }) => {
    await page.goto('/');
    const title = page.getByRole('textbox', { name: 'Task title' });
    await title.fill('Retain my status');
    await title.press('Enter');
    await expect(title).toHaveValue('');
    if (action === 'Reopen') {
      await page.getByRole('button', { name: 'Complete Retain my status', exact: true }).click();
      await page.getByRole('button', { name: 'Completed', exact: true }).click();
    } else {
      await title.fill('Unsubmitted capture');
    }
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        const request = key === undefined ? put.call(this, value) : put.call(this, value, key);
        request.addEventListener('success', () => this.transaction.abort());
        return request;
      };
    });
    const control = page.getByRole('button', { name: `${action} Retain my status`, exact: true });
    await control.focus();
    await control.press('Enter');
    await expect(page.getByRole('alert')).toContainText('storage failed');
    await expect(page.getByRole('status')).toHaveText('');
    await expect(control).toBeFocused();
    await expect(page.getByText('Retain my status', { exact: true })).toBeVisible();
    if (action === 'Complete') await expect(title).toHaveValue('Unsubmitted capture');
    await page.reload();
    if (action === 'Reopen') await page.getByRole('button', { name: 'Completed', exact: true }).click();
    await expect(control).toBeVisible();
    await control.press('Enter');
    await expect(control).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText(action === 'Complete' ? 'Task completed.' : 'Task reopened.');
  });
}

test('a stale open deletion confirmation cannot delete a task completed in another tab', async ({ page, context }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Task title' }).fill('Changed elsewhere');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Task title' })).toHaveValue('');
  const other = await context.newPage();
  await other.goto('/');
  await expect(other.getByText('Changed elsewhere', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Changed elsewhere', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete task?', exact: true });
  await other.getByRole('button', { name: 'Complete Changed elsewhere', exact: true }).click();
  await expect(other.getByRole('status')).toHaveText('Task completed.');
  await dialog.getByRole('button', { name: 'Delete permanently', exact: true }).press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('task changed');
  await expect(page.getByRole('status')).not.toContainText('deleted');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.reload();
  await expect(page.getByText('No active tasks yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Completed', exact: true }).click();
  await expect(page.getByText('Changed elsewhere', { exact: true })).toBeVisible();
});

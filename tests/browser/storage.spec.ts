import { expect, test } from '@playwright/test';

test('a real transaction aborted after its write request preserves tasks and capture input', async ({ page }) => {
  await page.goto('/');
  const title = page.getByRole('textbox', { name: 'Task title' });
  await title.fill('Already saved');
  await title.press('Enter');
  await expect(title).toHaveValue('');

  // Induce a genuine browser transaction abort; assertions stay at the app seam.
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
  await title.fill('Retain this idea');
  await title.press('Enter');
  await expect(page.getByRole('alert')).toContainText('storage failed');
  await expect(page.getByRole('status')).not.toContainText('Task added');
  await expect(title).toHaveValue('Retain this idea');
  await expect(title).toBeFocused();
  const rows = page.getByRole('list', { name: 'Tasks' }).getByRole('listitem');
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Already saved');
  await title.press('Enter');
  await expect(title).toHaveValue('');
  await expect(rows).toHaveCount(2);
  await page.reload();
  await expect(rows).toHaveCount(2);
  await expect(page.getByText('Already saved', { exact: true })).toBeVisible();
  await expect(page.getByText('Retain this idea', { exact: true })).toBeVisible();
});

test('a failed Priority transaction keeps the committed value, order and useful input', async ({ page }) => {
  await page.goto('/');
  const title = page.getByRole('textbox', { name: 'Task title' });
  for (const text of ['Old task', 'New task']) {
    await title.fill(text);
    await title.press('Enter');
    await expect(title).toHaveValue('');
  }
  await title.fill('Unsubmitted capture');
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = key === undefined ? put.call(this, value) : put.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort());
      return request;
    };
  });
  const priority = page.getByRole('combobox', { name: 'Priority for New task' });
  await priority.selectOption('high');
  await expect(page.getByRole('alert')).toContainText('storage failed');
  await expect(priority).toHaveValue('normal');
  await expect(title).toHaveValue('Unsubmitted capture');
  await expect(page.getByRole('list', { name: 'Tasks' }).getByRole('listitem'))
    .toHaveText([/Old task/, /New task/]);
  await page.reload();
  await expect(priority).toHaveValue('normal');
});

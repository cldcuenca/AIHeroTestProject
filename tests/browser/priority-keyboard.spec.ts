import { expect, test } from '@playwright/test';

test('keyboard Priority changes keep focus on the saved task control', async ({ page }) => {
  await page.goto('/');
  const title = page.getByRole('textbox', { name: 'Task title' });
  await title.fill('Keyboard task');
  await title.press('Enter');
  await expect(title).toHaveValue('');
  await title.press('Tab');
  await page.keyboard.press('Tab');
  const priority = page.getByRole('combobox', { name: 'Priority for Keyboard task' });
  await expect(priority).toBeFocused();
  await priority.press('ArrowUp');
  await expect(priority).toHaveValue('high');
  await expect(page.getByRole('status')).toContainText('Priority saved');
  await expect(priority).toBeFocused();
});

import { expect, test } from 'vitest';
import { createTaskCollection } from '../../src/collection';
import type { CollectionStorage, StorageChange } from '../../src/collection/storage';

const time = '2026-11-16T12:00:00.000Z';
const inbox = { id: 'inbox', name: 'Inbox', createdAt: time, revision: 0 };
const task = {
  id: 'd1b51f99-b158-47cc-a227-f5658d2506c4',
  title: 'Saved task',
  notes: 'Plain text\nkeeps line breaks',
  listId: 'inbox',
  priority: 'normal',
  status: 'active',
  createdAt: time,
  updatedAt: time,
  completedAt: null,
  revision: 1,
};
const saved = {
  schemaVersion: 1,
  collectionRevision: 1,
  restoreGeneration: 0,
  lists: [inbox],
  tasks: [task],
};

class FixtureStorage implements CollectionStorage {
  constructor(private value: unknown) {}
  async transact<T>(_write: boolean, apply: (saved: unknown) => StorageChange<T>): Promise<T> {
    const result = apply(structuredClone(this.value));
    if (result.next !== undefined) this.value = structuredClone(result.next);
    return result.value;
  }
}

const invalidCollections: [string, unknown][] = [
  ['missing collection', undefined],
  ['null collection', null],
  ['unsupported schema', { ...saved, schemaVersion: 2 }],
  ['negative collection revision', { ...saved, collectionRevision: -1 }],
  ['unsafe revision', { ...saved, collectionRevision: Number.MAX_SAFE_INTEGER + 1 }],
  ['fractional generation', { ...saved, restoreGeneration: 0.5 }],
  ['missing Inbox', { ...saved, lists: [] }],
  ['renamed Inbox', { ...saved, lists: [{ ...inbox, name: 'INBOX' }] }],
  ['duplicate List ID', { ...saved, lists: [inbox, inbox] }],
  ['duplicate List name', { ...saved, lists: [inbox, { ...inbox, id: 'other', name: 'inbox' }] }],
  ['reserved All Tasks name', { ...saved, lists: [inbox, { ...inbox, id: 'other', name: 'All Tasks' }] }],
  ['blank List name', { ...saved, lists: [inbox, { ...inbox, id: 'other', name: ' ' }] }],
  ['untrimmed List name', { ...saved, lists: [inbox, { ...inbox, id: 'other', name: ' Work' }] }],
  ['non-string List ID', { ...saved, lists: [inbox, { ...inbox, id: 1, name: 'Work' }] }],
  ['invalid List timestamp', { ...saved, lists: [{ ...inbox, createdAt: '2026-02-30T12:00:00Z' }] }],
  ['invalid List revision', { ...saved, lists: [{ ...inbox, revision: -1 }] }],
  ['duplicate task ID', { ...saved, tasks: [task, task] }],
  ['empty Task ID', { ...saved, tasks: [{ ...task, id: '' }] }],
  ['blank Task title', { ...saved, tasks: [{ ...task, title: ' ' }] }],
  ['untrimmed Task title', { ...saved, tasks: [{ ...task, title: ' Saved task' }] }],
  ['missing Task field', { ...saved, tasks: [{ id: 'task', title: 'Incomplete' }] }],
  ['non-text notes', { ...saved, tasks: [{ ...task, notes: { text: 'Not plain text' } }] }],
  ['dangling List reference', { ...saved, tasks: [{ ...task, listId: 'absent-list' }] }],
  ['unknown Priority', { ...saved, tasks: [{ ...task, priority: 'urgent' }] }],
  ['unknown status', { ...saved, tasks: [{ ...task, status: 'waiting' }] }],
  ['invalid Task creation timestamp', { ...saved, tasks: [{ ...task, createdAt: 'yesterday' }] }],
  ['non-UTC Task timestamp', { ...saved, tasks: [{ ...task, updatedAt: '2026-11-16T13:00:00+01:00' }] }],
  ['Active task with completion time', { ...saved, tasks: [{ ...task, completedAt: time }] }],
  ['Completed task without completion time', { ...saved, tasks: [{ ...task, status: 'completed' }] }],
  ['negative record revision', { ...saved, tasks: [{ ...task, revision: -1 }] }],
];

test.each(invalidCollections)('invalid saved data: %s is an error, never a repaired or empty collection', async (_name, value) => {
  const collection = createTaskCollection({ storage: new FixtureStorage(value) });
  await expect(collection.read()).rejects.toMatchObject({ code: 'invalid-data' });
  await expect(collection.capture({ title: 'Must not overwrite unreadable data' }))
    .rejects.toMatchObject({ code: 'invalid-data' });
  await expect(collection.read()).rejects.toMatchObject({ code: 'invalid-data' });
});

test('full saved records retain plain-text notes, completion state and scoped visibility', async () => {
  const collection = createTaskCollection({
    storage: new FixtureStorage({
      ...saved,
      tasks: [{ ...task, status: 'completed', completedAt: time }],
    }),
  });
  expect((await collection.read()).tasks).toEqual([]);
  const completed = await collection.read({ listId: 'inbox', status: 'completed' });
  expect(completed.tasks.map((savedTask) => savedTask.task)).toEqual([{
    id: 'd1b51f99-b158-47cc-a227-f5658d2506c4',
    title: 'Saved task',
    notes: 'Plain text\nkeeps line breaks',
    listId: 'inbox',
    priority: 'normal',
    status: 'completed',
    createdAt: time,
    updatedAt: time,
    completedAt: time,
  }]);
});

test('production defaults generate distinct UUIDs and UTC timestamps without changing saved identity', async () => {
  const collection = createTaskCollection({
    storage: new FixtureStorage({ ...saved, tasks: [], collectionRevision: 0 }),
  });
  await collection.capture({ title: 'Duplicate title' });
  const result = await collection.capture({ title: 'Duplicate title' });
  expect(result.tasks).toHaveLength(2);
  const ids = result.tasks.map(({ task: savedTask }) => savedTask.id);
  expect(ids[0]).not.toBe(ids[1]);
  for (const { task: savedTask } of result.tasks) {
    expect(savedTask.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(savedTask.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(savedTask.updatedAt).toBe(savedTask.createdAt);
  }
  expect(await collection.read()).toEqual(result);
});

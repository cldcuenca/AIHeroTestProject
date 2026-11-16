import { describe, expect, test } from 'vitest';
import { createTaskCollection } from '../../src/collection';
import type { CollectionSnapshot, SavedTask } from '../../src/collection';
import type { CollectionStorage, StorageChange } from '../../src/collection/storage';

const time = '2026-11-16T12:00:00.000Z';

function emptySavedCollection() {
  return {
    schemaVersion: 1,
    collectionRevision: 0,
    restoreGeneration: 0,
    lists: [{ id: 'inbox', name: 'Inbox', createdAt: time, revision: 0 }],
    tasks: [],
  };
}

class ControlledStorage implements CollectionStorage {
  constructor(public saved: unknown = emptySavedCollection()) {}
  failRead = false;
  failWrite = false;
  commitGate: Promise<void> | undefined;

  async transact<T>(write: boolean, apply: (saved: unknown) => StorageChange<T>): Promise<T> {
    if (this.failRead) throw new DOMException('Read denied', 'SecurityError');
    const change = apply(structuredClone(this.saved));
    if (write) {
      if (this.commitGate) await this.commitGate;
      if (this.failWrite) throw new DOMException('Disk full', 'QuotaExceededError');
      this.saved = structuredClone(change.next);
    }
    return change.value;
  }
}

function onlyTask(snapshot: CollectionSnapshot): SavedTask {
  expect(snapshot.tasks).toHaveLength(1);
  const task = snapshot.tasks[0];
  if (!task) throw new Error('Expected the saved task.');
  return task;
}

function setup(storage = new ControlledStorage()) {
  const collection = createTaskCollection({
    storage,
    now: () => time,
    uuid: () => '8cd28098-cf26-4d3e-83af-d953d3172c39',
  });
  return { collection, storage };
}

describe('Task Collection public interface (revision-1 supporting seam)', () => {
  test('capture returns the complete agreed record and committed defaults, without storing All Tasks', async () => {
    const { collection } = setup();
    expect(await collection.read()).toEqual({
      lists: [{ id: 'inbox', name: 'Inbox', createdAt: time }],
      tasks: [],
      collectionRevision: 0,
      restoreGeneration: 0,
    });
    const saved = await collection.capture({ title: '  Plan  the week  ' });
    expect(saved).toEqual({
      lists: [{ id: 'inbox', name: 'Inbox', createdAt: time }],
      tasks: [{
        task: {
          id: '8cd28098-cf26-4d3e-83af-d953d3172c39',
          title: 'Plan  the week',
          notes: '',
          listId: 'inbox',
          priority: 'normal',
          status: 'active',
          createdAt: time,
          updatedAt: time,
          completedAt: null,
        },
        version: { recordRevision: 1, restoreGeneration: 0 },
      }],
      collectionRevision: 1,
      restoreGeneration: 0,
    });
    expect(await collection.read({ listId: 'inbox', status: 'active' })).toEqual(saved);
  });

  test('blank input fails validation without changing saved outcomes', async () => {
    const { collection } = setup();
    const before = await collection.read();
    await expect(collection.capture({ title: ' \t\n ' })).rejects.toMatchObject({ code: 'validation' });
    expect(await collection.read()).toEqual(before);
  });

  test('a rejected commit is never a successful capture and leaves saved data unchanged', async () => {
    const { collection, storage } = setup();
    const before = await collection.read();
    storage.failWrite = true;
    await expect(collection.capture({ title: 'Keep my idea' })).rejects.toMatchObject({
      code: 'storage', message: expect.stringContaining('free space'),
    });
    storage.failWrite = false;
    expect(await collection.read()).toEqual(before);
    expect(onlyTask(await collection.capture({ title: 'Keep my idea' })).task.title).toBe('Keep my idea');
  });

  test('a successful result waits for commit, not just validation or a write request', async () => {
    const { collection, storage } = setup();
    let release: (() => void) | undefined;
    storage.commitGate = new Promise<void>((resolve) => { release = resolve; });
    let finished = false;
    const capture = collection.capture({ title: 'Wait for commit' }).then((result) => {
      finished = true;
      return result;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    if (!release) throw new Error('Missing controlled commit release.');
    release();
    expect(onlyTask(await capture).task.title).toBe('Wait for commit');
  });

  test('read failures reject rather than presenting an empty collection', async () => {
    const { collection, storage } = setup();
    await collection.capture({ title: 'Existing task' });
    storage.failRead = true;
    await expect(collection.read()).rejects.toMatchObject({ code: 'storage' });
    storage.failRead = false;
    expect(onlyTask(await collection.read()).task.title).toBe('Existing task');
  });

  test('Priority changes preserve identity, details and creation time, and advance public versions', async () => {
    const { collection, storage } = setup();
    const before = onlyTask(await collection.capture({ title: 'Important work' }));
    storage.failWrite = true;
    await expect(collection.setPriority(before.task.id, 'high', before.version))
      .rejects.toMatchObject({ code: 'storage' });
    storage.failWrite = false;
    expect(onlyTask(await collection.read())).toEqual(before);
    const changed = await collection.setPriority(before.task.id, 'high', before.version);
    expect(onlyTask(changed)).toEqual({
      task: { ...before.task, priority: 'high' },
      version: { recordRevision: 2, restoreGeneration: 0 },
    });
    expect(changed.collectionRevision).toBe(2);
    await expect(collection.setPriority(before.task.id, 'low', before.version))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(await collection.read()).toEqual(changed);
  });

  test('ties use stable ID rather than input order and duplicate titles remain distinct', async () => {
    const storage = new ControlledStorage();
    const ids = ['b-task', 'a-task', 'c-task'];
    const collection = createTaskCollection({
      storage,
      now: () => time,
      uuid: () => {
        const id = ids.shift();
        if (!id) throw new Error('No more deterministic IDs.');
        return id;
      },
    });
    await collection.capture({ title: 'Same title' });
    await collection.capture({ title: 'Same title' });
    const saved = await collection.capture({ title: 'Same title' });
    expect(saved.tasks.map(({ task }) => task.id)).toEqual(['a-task', 'b-task', 'c-task']);
  });
});

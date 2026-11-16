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
    for (const entry of [...saved.tasks].reverse()) {
      await collection.setStatus(entry.task.id, 'completed', entry.version);
    }
    const completed = await collection.read({ status: 'completed' });
    expect(completed.tasks.map(({ task }) => task.id)).toEqual(['a-task', 'b-task', 'c-task']);
    for (const entry of [...completed.tasks].reverse()) {
      await collection.setStatus(entry.task.id, 'active', entry.version);
    }
    expect((await collection.read()).tasks.map(({ task }) => task.id)).toEqual(['a-task', 'b-task', 'c-task']);
  });

  test('completion, reopening and re-completion retain the same record with only the latest completion time', async () => {
    const storage = new ControlledStorage({
      ...emptySavedCollection(),
      lists: [
        { id: 'inbox', name: 'Inbox', createdAt: time, revision: 0 },
        { id: 'work', name: 'Work', createdAt: time, revision: 1 },
      ],
      tasks: [{
        id: 'retained-task', title: 'Review plan', notes: 'Waiting for Ana\nKeep details',
        listId: 'work', priority: 'high', status: 'active', createdAt: time,
        updatedAt: time, completedAt: null, revision: 3,
      }],
      collectionRevision: 7,
      restoreGeneration: 2,
    });
    let clock = '2026-11-17T09:00:00.000Z';
    const collection = createTaskCollection({ storage, now: () => clock });
    const original = onlyTask(await collection.read());
    const completed = await collection.setStatus(original.task.id, 'completed', original.version, { status: 'completed', listId: 'work' });
    expect(onlyTask(completed)).toEqual({
      task: { ...original.task, status: 'completed', updatedAt: clock, completedAt: clock },
      version: { recordRevision: 4, restoreGeneration: 2 },
    });
    expect(completed.collectionRevision).toBe(8);
    expect((await collection.read()).tasks).toEqual([]);
    clock = '2026-11-18T10:00:00.000Z';
    const reopened = await collection.setStatus(original.task.id, 'active', onlyTask(completed).version);
    expect(onlyTask(reopened)).toEqual({
      task: { ...original.task, updatedAt: '2026-11-18T10:00:00.000Z' },
      version: { recordRevision: 5, restoreGeneration: 2 },
    });
    expect(reopened.collectionRevision).toBe(9);
    expect((await collection.read({ status: 'completed' })).tasks).toEqual([]);
    clock = '2026-11-19T11:00:00.000Z';
    await collection.setStatus(original.task.id, 'completed', onlyTask(reopened).version);
    const retained = await collection.read({ status: 'completed' });
    expect(onlyTask(retained)).toEqual({
      task: { ...original.task, status: 'completed', updatedAt: clock, completedAt: clock },
      version: { recordRevision: 6, restoreGeneration: 2 },
    });
    expect(retained.collectionRevision).toBe(10);
    clock = '2040-01-01T00:00:00.000Z';
    expect(await collection.read({ status: 'completed', listId: 'work' })).toEqual(retained);
    expect((await collection.read({ status: 'completed', listId: 'inbox' })).tasks).toEqual([]);
  });

  test('invalid lifecycle inputs and already-current status reject without changing saved data or revisions', async () => {
    const { collection } = setup();
    const before = await collection.capture({ title: 'Validate lifecycle' });
    const saved = onlyTask(before);
    for (const args of [
      [saved.task.id, 'archived', saved.version],
      [saved.task.id, 'active', saved.version],
      ['', 'completed', saved.version],
      [null, 'completed', saved.version],
      [saved.task.id, 'completed', null],
      [saved.task.id, 'completed', { recordRevision: -1, restoreGeneration: 0 }],
      [saved.task.id, 'completed', { recordRevision: 1, restoreGeneration: Number.NaN }],
    ]) {
      await expect(Reflect.apply(collection.setStatus, collection, args))
        .rejects.toMatchObject({ code: 'validation' });
      expect(await collection.read()).toEqual(before);
    }
    await collection.setStatus(saved.task.id, 'completed', saved.version);
    const completed = await collection.read({ status: 'completed' });
    await expect(collection.setStatus(saved.task.id, 'completed', onlyTask(completed).version))
      .rejects.toMatchObject({ code: 'validation' });
    expect(await collection.read({ status: 'completed' })).toEqual(completed);
  });

  test('invalid deletion identity or version fails validation without removing saved tasks', async () => {
    const { collection } = setup();
    const before = await collection.capture({ title: 'Validate deletion' });
    const saved = onlyTask(before);
    for (const args of [
      ['', saved.version],
      [null, saved.version],
      [saved.task.id, null],
      [saved.task.id, { recordRevision: 1.5, restoreGeneration: 0 }],
      [saved.task.id, { recordRevision: 1, restoreGeneration: -1 }],
    ]) {
      await expect(Reflect.apply(collection.deleteTask, collection, args))
        .rejects.toMatchObject({ code: 'validation' });
      expect(await collection.read()).toEqual(before);
    }
  });

  test.each(['complete', 'reopen', 'delete-active', 'delete-completed'] as const)(
    '%s waits for commit, reports rollback unchanged, and advances only a committed collection',
    async (operation) => {
      const { collection, storage } = setup();
      await collection.capture({ title: 'Retain on failed lifecycle write' });
      if (operation === 'reopen' || operation === 'delete-completed') {
        const entry = onlyTask(await collection.read());
        await collection.setStatus(entry.task.id, 'completed', entry.version);
      }
      const activeBefore = await collection.read();
      const completedBefore = await collection.read({ status: 'completed' });
      const entry = onlyTask(operation === 'reopen' || operation === 'delete-completed' ? completedBefore : activeBefore);
      const command = () => operation.startsWith('delete')
        ? collection.deleteTask(entry.task.id, entry.version, { status: entry.task.status })
        : collection.setStatus(entry.task.id, operation === 'complete' ? 'completed' : 'active', entry.version);
      storage.failRead = true;
      await expect(command()).rejects.toMatchObject({ code: 'storage' });
      storage.failRead = false;
      expect(await collection.read()).toEqual(activeBefore);
      expect(await collection.read({ status: 'completed' })).toEqual(completedBefore);
      let release: (() => void) | undefined;
      storage.commitGate = new Promise<void>((resolve) => { release = resolve; });
      storage.failWrite = true;
      let settled = false;
      const attempt = command().then(
        () => { settled = true; return 'unexpected-success'; },
        (error: unknown) => { settled = true; return error; },
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      expect(await collection.read()).toEqual(activeBefore);
      expect(await collection.read({ status: 'completed' })).toEqual(completedBefore);
      if (!release) throw new Error('Missing controlled commit release.');
      release();
      expect(await attempt).toMatchObject({ code: 'storage' });
      storage.commitGate = undefined;
      storage.failWrite = false;
      expect(await collection.read()).toEqual(activeBefore);
      expect(await collection.read({ status: 'completed' })).toEqual(completedBefore);
      const committed = await command();
      expect(committed.collectionRevision).toBe(activeBefore.collectionRevision + 1);
      expect(committed.restoreGeneration).toBe(0);
      if (operation.startsWith('delete')) {
        expect((await collection.read()).tasks).toEqual([]);
        expect((await collection.read({ status: 'completed' })).tasks).toEqual([]);
        await expect(command()).rejects.toMatchObject({ code: 'conflict' });
      } else {
        const after = onlyTask(await collection.read({ status: operation === 'complete' ? 'completed' : 'active' }));
        expect(after.version.recordRevision).toBe(entry.version.recordRevision + 1);
      }
    },
  );

  test('stale status and deletion versions cannot overwrite newer Priority or lifecycle changes', async () => {
    const { collection } = setup();
    const old = onlyTask(await collection.capture({ title: 'Protect newer saved work' }));
    await collection.setPriority(old.task.id, 'high', old.version);
    const newer = await collection.read();
    await expect(collection.setStatus(old.task.id, 'completed', old.version)).rejects.toMatchObject({ code: 'conflict' });
    await expect(collection.deleteTask(old.task.id, old.version)).rejects.toMatchObject({ code: 'conflict' });
    expect(await collection.read()).toEqual(newer);
    await collection.setStatus(old.task.id, 'completed', onlyTask(newer).version);
    const completed = await collection.read({ status: 'completed' });
    await expect(collection.deleteTask(old.task.id, onlyTask(newer).version)).rejects.toMatchObject({ code: 'conflict' });
    expect(await collection.read({ status: 'completed' })).toEqual(completed);
  });

  test('lifecycle and deletion reject pre-restore versions even when record IDs and revisions are reused', async () => {
    const initial = {
      ...emptySavedCollection(),
      tasks: [{
        id: 'reused-task', title: 'Original task', notes: '', listId: 'inbox',
        priority: 'normal', status: 'active', createdAt: time,
        updatedAt: time, completedAt: null, revision: 1,
      }],
      collectionRevision: 1,
    };
    const storage = new ControlledStorage(initial);
    const { collection } = setup(storage);
    const original = onlyTask(await collection.read());
    storage.saved = {
      ...initial, collectionRevision: 2, restoreGeneration: 1,
      tasks: [{ ...initial.tasks[0], title: 'Restored task' }],
    };
    const restored = await collection.read();
    await expect(collection.setStatus(original.task.id, 'completed', original.version)).rejects.toMatchObject({ code: 'conflict' });
    await expect(collection.deleteTask(original.task.id, original.version)).rejects.toMatchObject({ code: 'conflict' });
    expect(await collection.read()).toEqual(restored);
  });

  test('deleting one Completed task preserves the complete remaining collection and versions', async () => {
    const storage = new ControlledStorage();
    const ids = ['active-task', 'completed-task'];
    const collection = createTaskCollection({
      storage, now: () => time, uuid: () => {
        const id = ids.shift();
        if (!id) throw new Error('Missing deterministic ID.');
        return id;
      },
    });
    await collection.capture({ title: 'Keep active' });
    const both = await collection.capture({ title: 'Delete completed' });
    const toDelete = both.tasks.find(({ task }) => task.id === 'completed-task');
    if (!toDelete) throw new Error('Missing deletion target.');
    await collection.setStatus(toDelete.task.id, 'completed', toDelete.version);
    const activeBefore = await collection.read();
    const completed = onlyTask(await collection.read({ status: 'completed' }));
    const result = await collection.deleteTask(completed.task.id, completed.version, { status: 'completed' });
    expect(result.tasks).toEqual([]);
    expect(await collection.read()).toEqual({ ...activeBefore, collectionRevision: 4 });
    expect(result.lists).toEqual(activeBefore.lists);
  });
});

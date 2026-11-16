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

function organizedStorage() {
  return new ControlledStorage({
    ...emptySavedCollection(), collectionRevision: 7, restoreGeneration: 2,
    lists: [
      { id: 'inbox', name: 'Inbox', createdAt: time, revision: 0 },
      { id: 'work', name: 'Work', createdAt: time, revision: 1 },
      { id: 'personal', name: 'Personal', createdAt: time, revision: 1 },
    ],
    tasks: [
      { id: 'active', title: 'Waiting', notes: 'Waiting\nfor Ana', listId: 'work', priority: 'high',
        status: 'active', createdAt: time, updatedAt: time, completedAt: null, revision: 3 },
      { id: 'completed', title: 'Finished', notes: 'Details', listId: 'work', priority: 'low',
        status: 'completed', createdAt: time, updatedAt: time, completedAt: time, revision: 4 },
      { id: 'survivor', title: 'Inbox work', notes: '', listId: 'inbox', priority: 'normal',
        status: 'active', createdAt: time, updatedAt: time, completedAt: null, revision: 1 },
    ],
  });
}

describe('Task Collection public interface (revision-1 supporting seam)', () => {
  test.each(['create', 'rename', 'edit', 'delete'] as const)('%s List/editor command waits for commit and preserves both statuses after read/write failures', async (operation) => {
    const storage = organizedStorage();
    const collection = createTaskCollection({ storage, now: () => '2026-11-18T12:00:00.000Z' });
    const before = await collection.read();
    const completedBefore = await collection.read({ status: 'completed' });
    const original = before.tasks.find(({ task }) => task.id === 'active');
    if (!original) throw new Error('Missing fixture task.');
    const command = () => {
      switch (operation) {
        case 'create': return collection.createList({ name: 'Another List' });
        case 'rename': return collection.renameList('work', 'Office', before);
        case 'edit': return collection.editTask(original.task.id, { ...original.task, title: 'Edited' }, original.version);
        case 'delete': return collection.deleteList('work', before);
      }
    };
    storage.failRead = true;
    await expect(command()).rejects.toMatchObject({ code: 'storage' });
    storage.failRead = false;
    expect(await collection.read()).toEqual(before);
    expect(await collection.read({ status: 'completed' })).toEqual(completedBefore);
    let release: (() => void) | undefined;
    storage.commitGate = new Promise<void>((resolve) => { release = resolve; });
    storage.failWrite = true;
    let settled = false;
    const pending = command().then(
      () => { settled = true; return 'unexpected-success'; },
      (error: unknown) => { settled = true; return error; },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(await collection.read()).toEqual(before);
    expect(await collection.read({ status: 'completed' })).toEqual(completedBefore);
    if (!release) throw new Error('Missing commit release.');
    release();
    expect(await pending).toMatchObject({ code: 'storage' });
    storage.commitGate = undefined;
    storage.failWrite = false;
    expect(await collection.read()).toEqual(before);
    expect(await collection.read({ status: 'completed' })).toEqual(completedBefore);
    expect((await command()).collectionRevision).toBe(8);
  });

  test('rename preserves List and task identities and order, rejects duplicate/reserved names and protects Inbox', async () => {
    const { collection } = setup(organizedStorage());
    const before = await collection.read();
    const completed = await collection.read({ status: 'completed' });
    for (const name of [' ', 'INBOX', ' All Tasks ', 'personal']) {
      await expect(collection.renameList('work', name, before)).rejects.toMatchObject({ code: 'validation' });
      expect(await collection.read()).toEqual(before);
    }
    await expect(collection.renameList('inbox', 'Renamed', before)).rejects.toMatchObject({ code: 'validation' });
    await expect(collection.deleteList('inbox', before)).rejects.toMatchObject({ code: 'validation' });
    await expect(collection.previewListDeletion('inbox')).rejects.toMatchObject({ code: 'validation' });
    const renamed = await collection.renameList('work', ' OFFICE ', before);
    expect(renamed).toEqual({ ...before, collectionRevision: 8, lists: [
      { id: 'inbox', name: 'Inbox', createdAt: time },
      { id: 'work', name: 'OFFICE', createdAt: time },
      { id: 'personal', name: 'Personal', createdAt: time },
    ] });
    expect((await collection.read({ status: 'completed' })).tasks).toEqual(completed.tasks);
  });

  test('malformed List identities/versions and invalid edits never mutate the collection', async () => {
    const { collection } = setup(organizedStorage());
    const before = await collection.read();
    const completed = await collection.read({ status: 'completed' });
    for (const [id, version] of [
      ['', before], [null, before], [' work ', before], ['work', null],
      ['work', { collectionRevision: -1, restoreGeneration: 2 }],
      ['work', { collectionRevision: 7, restoreGeneration: Number.NaN }],
    ]) {
      await expect(Reflect.apply(collection.renameList, collection, [id, 'Office', version])).rejects.toMatchObject({ code: 'validation' });
      await expect(Reflect.apply(collection.deleteList, collection, [id, version])).rejects.toMatchObject({ code: 'validation' });
    }
    const entry = before.tasks[0];
    if (!entry) throw new Error('Missing fixture task.');
    for (const input of [
      null, {}, { ...entry.task, title: ' ' }, { ...entry.task, notes: 2 },
      { ...entry.task, priority: 'urgent' }, { ...entry.task, listId: 'missing' },
    ]) {
      await expect(Reflect.apply(collection.editTask, collection, [entry.task.id, input, entry.version]))
        .rejects.toMatchObject({ code: 'validation' });
    }
    await expect(Reflect.apply(collection.editTask, collection, ['', entry.task, entry.version])).rejects.toMatchObject({ code: 'validation' });
    await expect(Reflect.apply(collection.editTask, collection, [entry.task.id, entry.task, null])).rejects.toMatchObject({ code: 'validation' });
    expect(await collection.read()).toEqual(before);
    expect(await collection.read({ status: 'completed' })).toEqual(completed);
  });

  test('stale List confirmations reject after any saved change and empty Lists delete without affecting tasks', async () => {
    const { collection } = setup(organizedStorage());
    const preview = await collection.previewListDeletion('work');
    await collection.capture({ title: 'New work', listId: 'work' });
    const newer = await collection.read();
    const completed = await collection.read({ status: 'completed' });
    await expect(collection.deleteList('work', preview.version)).rejects.toMatchObject({ code: 'conflict' });
    await expect(collection.renameList('work', 'Office', preview.version)).rejects.toMatchObject({ code: 'conflict' });
    expect(await collection.read()).toEqual(newer);
    expect(await collection.read({ status: 'completed' })).toEqual(completed);
    const empty = await collection.previewListDeletion('personal');
    expect([empty.activeCount, empty.completedCount]).toEqual([0, 0]);
    const result = await collection.deleteList('personal', empty.version);
    expect(result.tasks).toEqual(newer.tasks);
    expect((await collection.read({ status: 'completed' })).tasks).toEqual(completed.tasks);
    expect(result.lists.map((list) => list.id)).toEqual(['inbox', 'work']);
    await expect(collection.previewListDeletion('personal')).rejects.toMatchObject({ code: 'conflict' });
  });

  test('task edits reject stale/deleted/reused versions, but unrelated changes do not invalidate an editor', async () => {
    const storage = organizedStorage();
    const { collection } = setup(storage);
    const before = await collection.read();
    const entry = before.tasks[0];
    if (!entry) throw new Error('Missing fixture task.');
    await collection.createList({ name: 'Unrelated' });
    const changed = await collection.editTask(entry.task.id, { ...entry.task, notes: 'Changed' }, entry.version);
    await expect(collection.editTask(entry.task.id, { ...entry.task, title: 'Stale' }, entry.version)).rejects.toMatchObject({ code: 'conflict' });
    expect(await collection.read()).toEqual(changed);
    const latest = changed.tasks.find(({ task }) => task.id === entry.task.id);
    if (!latest) throw new Error('Missing edited task.');
    await collection.deleteTask(latest.task.id, latest.version);
    const deleted = await collection.read();
    await expect(collection.editTask(latest.task.id, latest.task, latest.version)).rejects.toMatchObject({ code: 'conflict' });
    expect(await collection.read()).toEqual(deleted);
    const replacement = organizedStorage();
    const replacementValue: unknown = replacement.saved;
    if (typeof replacementValue !== 'object' || replacementValue === null) throw new Error('Missing fixture.');
    storage.saved = { ...replacementValue, collectionRevision: 12, restoreGeneration: 3 };
    const restored = await collection.read();
    await expect(collection.editTask(entry.task.id, entry.task, entry.version)).rejects.toMatchObject({ code: 'conflict' });
    await expect(collection.deleteList('work', before)).rejects.toMatchObject({ code: 'conflict' });
    expect(await collection.read()).toEqual(restored);
  });

  test('named Lists keep creation order and identity through scoped reads', async () => {
    const storage = new ControlledStorage();
    const ids = ['work', 'personal'];
    const collection = createTaskCollection({
      storage, now: () => time, uuid: () => {
        const id = ids.shift();
        if (!id) throw new Error('Missing deterministic ID.');
        return id;
      },
    });

    await collection.createList({ name: ' Work ' });
    const saved = await collection.createList({ name: 'Personal' }, { listId: 'work', status: 'completed' });
    expect(saved.lists).toEqual([
      { id: 'inbox', name: 'Inbox', createdAt: time },
      { id: 'work', name: 'Work', createdAt: time },
      { id: 'personal', name: 'Personal', createdAt: time },
    ]);
    expect(saved.tasks).toEqual([]);
    expect(saved.collectionRevision).toBe(2);
    expect(await collection.read({ status: 'completed' })).toEqual(saved);
  });

  test('invalid, duplicate and reserved List names fail actionably without any saved change', async () => {
    const { collection } = setup();
    await collection.createList({ name: 'Work' });
    const before = await collection.read();
    for (const name of ['', ' \t\n ', ' work ', 'WORK', ' inbox ', 'ALL TASKS', null, 2]) {
      await expect(Reflect.apply(collection.createList, collection, [{ name }]))
        .rejects.toMatchObject({ code: 'validation', message: expect.stringMatching(/name/i) });
      expect(await collection.read()).toEqual(before);
    }
  });

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

  test('explicit edits retain Completed identity, creation and completion while moving, reordering and updating versions', async () => {
    const storage = new ControlledStorage({
      ...emptySavedCollection(),
      lists: [
        { id: 'inbox', name: 'Inbox', createdAt: time, revision: 0 },
        { id: 'work', name: 'Work', createdAt: time, revision: 1 },
      ],
      tasks: [{
        id: 'edit-task', title: 'Original', notes: 'Original notes', listId: 'inbox',
        priority: 'normal', status: 'completed', createdAt: time, updatedAt: time, completedAt: time, revision: 4,
      }],
      collectionRevision: 7, restoreGeneration: 2,
    });
    const clock = '2026-11-17T09:00:00.000Z';
    const collection = createTaskCollection({ storage, now: () => clock });
    const original = onlyTask(await collection.read({ status: 'completed' }));
    const saved = await collection.editTask(original.task.id, {
      title: ' New  title ', notes: 'Waiting for Ana\n<script>inert</script>\n', priority: 'high', listId: 'work',
    }, original.version, { listId: 'work', status: 'completed' });
    expect(onlyTask(saved)).toEqual({
      task: { ...original.task, title: 'New  title', notes: 'Waiting for Ana\n<script>inert</script>\n',
        priority: 'high', listId: 'work', updatedAt: clock },
      version: { recordRevision: 5, restoreGeneration: 2 },
    });
    expect(saved.collectionRevision).toBe(8);
    expect((await collection.read({ listId: 'inbox', status: 'completed' })).tasks).toEqual([]);
    expect(await collection.read({ listId: 'work', status: 'completed' })).toEqual(saved);
  });

  test('List deletion previews both statuses and atomically moves every full record to Inbox', async () => {
    const storage = new ControlledStorage({
      ...emptySavedCollection(),
      lists: [
        { id: 'inbox', name: 'Inbox', createdAt: time, revision: 0 },
        { id: 'work', name: 'Work', createdAt: time, revision: 1 },
      ],
      tasks: [
        { id: 'active', title: 'Waiting', notes: 'Waiting\nfor Ana', listId: 'work', priority: 'high',
          status: 'active', createdAt: time, updatedAt: time, completedAt: null, revision: 3 },
        { id: 'completed', title: 'Finished', notes: 'Details', listId: 'work', priority: 'low',
          status: 'completed', createdAt: time, updatedAt: time, completedAt: time, revision: 4 },
        { id: 'survivor', title: 'Inbox work', notes: '', listId: 'inbox', priority: 'normal',
          status: 'active', createdAt: time, updatedAt: time, completedAt: null, revision: 1 },
      ],
      collectionRevision: 7, restoreGeneration: 2,
    });
    const clock = '2026-11-17T09:00:00.000Z';
    const collection = createTaskCollection({ storage, now: () => clock });
    const active = await collection.read();
    const completed = await collection.read({ status: 'completed' });
    const preview = await collection.previewListDeletion('work');
    expect(preview).toEqual({
      list: { id: 'work', name: 'Work', createdAt: time }, activeCount: 1, completedCount: 1,
      version: { collectionRevision: 7, restoreGeneration: 2 },
    });
    const result = await collection.deleteList('work', preview.version, { listId: 'work' });
    expect(result.lists).toEqual([{ id: 'inbox', name: 'Inbox', createdAt: time }]);
    expect(result.collectionRevision).toBe(8);
    expect(result.restoreGeneration).toBe(2);
    expect(result.tasks).toEqual(active.tasks.map((saved) => saved.task.listId === 'work' ? {
      task: { ...saved.task, listId: 'inbox', updatedAt: clock },
      version: { recordRevision: 4, restoreGeneration: 2 },
    } : saved));
    expect((await collection.read({ listId: 'inbox', status: 'completed' })).tasks).toEqual([{
      task: { ...onlyTask(completed).task, listId: 'inbox', updatedAt: clock },
      version: { recordRevision: 5, restoreGeneration: 2 },
    }]);
  });

  test('malformed List/capture inputs reject as validation instead of silently assigning Inbox or storage errors', async () => {
    const { collection } = setup();
    const before = await collection.read();
    for (const input of [null, undefined, {}, { name: null }]) {
      await expect(Reflect.apply(collection.createList, collection, [input])).rejects.toMatchObject({ code: 'validation' });
      expect(await collection.read()).toEqual(before);
    }
    for (const input of [null, undefined, {}, { title: 'Bad List', listId: null }, { title: 'Bad List', listId: '' }, { title: 'Bad List', listId: 'missing' }]) {
      await expect(Reflect.apply(collection.capture, collection, [input])).rejects.toMatchObject({ code: 'validation' });
      expect(await collection.read()).toEqual(before);
    }
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

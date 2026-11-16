import { initialState, prioritySchema, stateSchema } from './model';
import type { CollectionState, List, Priority, Task } from './model';
import { indexedDbStorage } from './storage';
import type { CollectionStorage, StorageChange } from './storage';

export type { List, Priority, Task } from './model';

export type TaskVersion = Readonly<{ recordRevision: number; restoreGeneration: number }>;
export type CollectionVersion = Readonly<{ collectionRevision: number; restoreGeneration: number }>;
export type TaskEdits = Readonly<Pick<Task, 'title' | 'notes' | 'priority' | 'listId'>>;
export type ListDeletionPreview = Readonly<{
  list: List; activeCount: number; completedCount: number; version: CollectionVersion;
}>;
export type SavedTask = Readonly<{ task: Task; version: TaskVersion }>;
export type CollectionSnapshot = Readonly<{
  lists: readonly List[];
  tasks: readonly SavedTask[];
  collectionRevision: number;
  restoreGeneration: number;
}>;
export type ViewScope = Readonly<{ listId?: string; status?: 'active' | 'completed' }>;

export class CollectionError extends Error {
  constructor(
    public readonly code: 'validation' | 'invalid-data' | 'storage' | 'conflict',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CollectionError';
  }
}

export interface TaskCollection {
  read(scope?: ViewScope): Promise<CollectionSnapshot>;
  createList(input: Readonly<{ name: string }>, scope?: ViewScope): Promise<CollectionSnapshot>;
  renameList(id: string, name: string, version: CollectionVersion, scope?: ViewScope): Promise<CollectionSnapshot>;
  editTask(id: string, input: TaskEdits, version: TaskVersion, scope?: ViewScope): Promise<CollectionSnapshot>;
  previewListDeletion(id: string): Promise<ListDeletionPreview>;
  deleteList(id: string, version: CollectionVersion, scope?: ViewScope): Promise<CollectionSnapshot>;
  capture(input: Readonly<{ title: string; listId?: string }>, scope?: ViewScope): Promise<CollectionSnapshot>;
  setPriority(id: string, priority: Priority, version: TaskVersion, scope?: ViewScope): Promise<CollectionSnapshot>;
  setStatus(id: string, status: Task['status'], version: TaskVersion, scope?: ViewScope): Promise<CollectionSnapshot>;
  deleteTask(id: string, version: TaskVersion, scope?: ViewScope): Promise<CollectionSnapshot>;
}

type Options = Readonly<{
  databaseName?: string;
  storage?: CollectionStorage;
  now?: () => string;
  uuid?: () => string;
}>;

export function createTaskCollection(options: Options = {}): TaskCollection {
  const now = options.now ?? (() => new Date().toISOString());
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  const storage = options.storage ?? indexedDbStorage(
    options.databaseName ?? 'taskroom-v1',
    () => initialState(now()),
  );

  function validate(saved: unknown): CollectionState {
    const result = stateSchema.safeParse(saved);
    if (!result.success) {
      throw new CollectionError(
        'invalid-data',
        'Saved data could not be read safely. Do not clear browser data. Keep this profile and seek recovery help.',
        { cause: result.error },
      );
    }
    return result.data;
  }

  function snapshot(state: CollectionState, scope: ViewScope = {}): CollectionSnapshot {
    const weights: Record<Priority, number> = { high: 0, normal: 1, low: 2 };
    const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    return {
      lists: [...state.lists].sort((a, b) => a.id === 'inbox' ? -1 : b.id === 'inbox' ? 1 :
        Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .map(({ revision: _revision, ...list }) => list),
      tasks: state.tasks
        .filter((task) => task.status === (scope.status ?? 'active') &&
          (scope.listId === undefined || task.listId === scope.listId))
        .sort((a, b) => weights[a.priority] - weights[b.priority] ||
          Date.parse(a.createdAt) - Date.parse(b.createdAt) || compareText(a.id, b.id))
        .map(({ revision, ...task }) => ({
          task,
          version: { recordRevision: revision, restoreGeneration: state.restoreGeneration },
        })),
      collectionRevision: state.collectionRevision,
      restoreGeneration: state.restoreGeneration,
    };
  }

  async function run<T>(
    write: boolean,
    apply: (state: CollectionState) => StorageChange<T>,
  ): Promise<T> {
    try {
      return await storage.transact(write, (saved) => apply(validate(saved)));
    } catch (error) {
      if (error instanceof CollectionError) throw error;
      throw new CollectionError(
        'storage',
        'Browser storage failed. Your input is retained; check browser storage permissions and free space, then retry. Do not clear site data.',
        { cause: error },
      );
    }
  }

  function listName(state: CollectionState, name: string, exceptId?: string): string {
    if (typeof name !== 'string' || !name.trim()) {
      throw new CollectionError('validation', 'Enter a List name with at least one non-space character.');
    }
    const trimmed = name.trim();
    const key = trimmed.toLowerCase();
    if (key === 'inbox' || key === 'all tasks') {
      throw new CollectionError('validation', 'That name is reserved. Choose a name other than Inbox or All Tasks.');
    }
    if (state.lists.some((list) => list.id !== exceptId && list.name.toLowerCase() === key)) {
      throw new CollectionError('validation', 'That List name already exists. Choose a unique name.');
    }
    return trimmed;
  }

  function checkListChange(state: CollectionState, id: string, version: CollectionVersion) {
    if (typeof id !== 'string' || !id.trim() || id !== id.trim() ||
      typeof version !== 'object' || version === null ||
      !Number.isSafeInteger(version.collectionRevision) || version.collectionRevision < 0 ||
      !Number.isSafeInteger(version.restoreGeneration) || version.restoreGeneration < 0) {
      throw new CollectionError('validation', 'Choose a saved List and its current collection version.');
    }
    if (id === 'inbox') throw new CollectionError('validation', 'Inbox cannot be renamed or deleted.');
    if (!state.lists.some((list) => list.id === id) || state.collectionRevision !== version.collectionRevision ||
      state.restoreGeneration !== version.restoreGeneration) {
      throw new CollectionError('conflict', 'Saved Lists or tasks changed. Close this dialog and reload the saved tasks before trying again.');
    }
  }

  return {
    read: (scope) => run(false, (state) => ({ value: snapshot(state, scope) })),
    createList: (input, scope) => run(true, (state) => {
      if (typeof input !== 'object' || input === null) {
        throw new CollectionError('validation', 'Enter a List name.');
      }
      const next = validate({
        ...state,
        collectionRevision: state.collectionRevision + 1,
        lists: [...state.lists, { id: uuid(), name: listName(state, input.name), createdAt: now(), revision: 1 }],
      });
      return { next, value: snapshot(next, scope) };
    }),
    renameList: (id, name, version, scope) => run(true, (state) => {
      checkListChange(state, id, version);
      const trimmed = listName(state, name, id);
      const next = validate({
        ...state, collectionRevision: state.collectionRevision + 1,
        lists: state.lists.map((list) => list.id === id ? { ...list, name: trimmed, revision: list.revision + 1 } : list),
      });
      return { next, value: snapshot(next, scope) };
    }),
    previewListDeletion: (id) => run(false, (state) => {
      checkListChange(state, id, state);
      const current = state.lists.find((list) => list.id === id);
      if (!current) throw new CollectionError('conflict', 'This List no longer exists. Reload saved tasks.');
      const { revision: _revision, ...list } = current;
      return { value: {
        list,
        activeCount: state.tasks.filter((task) => task.listId === id && task.status === 'active').length,
        completedCount: state.tasks.filter((task) => task.listId === id && task.status === 'completed').length,
        version: { collectionRevision: state.collectionRevision, restoreGeneration: state.restoreGeneration },
      } };
    }),
    deleteList: (id, version, scope) => run(true, (state) => {
      checkListChange(state, id, version);
      const time = now();
      const next = validate({
        ...state, collectionRevision: state.collectionRevision + 1,
        lists: state.lists.filter((list) => list.id !== id),
        tasks: state.tasks.map((task) => task.listId === id ? {
          ...task, listId: 'inbox',
          updatedAt: new Date(Math.max(Date.parse(time), Date.parse(task.updatedAt))).toISOString(),
          revision: task.revision + 1,
        } : task),
      });
      return { next, value: snapshot(next, scope?.listId === id ? { ...scope, listId: 'inbox' } : scope) };
    }),
    capture: async (input, scope) => {
      if (typeof input !== 'object' || input === null || typeof input.title !== 'string' || !input.title.trim()) {
        throw new CollectionError('validation', 'Enter a task title with at least one non-space character.');
      }
      return run(true, (state) => {
        if ((input.listId !== undefined && typeof input.listId !== 'string') ||
          !state.lists.some((list) => list.id === (input.listId ?? 'inbox'))) {
          throw new CollectionError('validation', 'Choose an existing List before adding this task.');
        }
        const time = now();
        const next = validate({
          ...state,
          collectionRevision: state.collectionRevision + 1,
          tasks: [...state.tasks, {
            id: uuid(),
            title: input.title.trim(),
            notes: '',
            listId: input.listId ?? 'inbox',
            priority: 'normal',
            status: 'active',
            createdAt: time,
            updatedAt: time,
            completedAt: null,
            revision: 1,
          }],
        });
        return { next, value: snapshot(next, scope) };
      });
    },
    editTask: (id, input, version, scope) => run(true, (state) => {
      if (typeof id !== 'string' || !id.trim() || id !== id.trim() ||
        typeof version !== 'object' || version === null ||
        !Number.isSafeInteger(version.recordRevision) || version.recordRevision < 0 ||
        !Number.isSafeInteger(version.restoreGeneration) || version.restoreGeneration < 0) {
        throw new CollectionError('validation', 'Choose a saved task and its version before saving edits.');
      }
      if (typeof input !== 'object' || input === null || typeof input.title !== 'string' || !input.title.trim()) {
        throw new CollectionError('validation', 'Enter a task title with at least one non-space character.');
      }
      if (typeof input.notes !== 'string' || !prioritySchema.safeParse(input.priority).success ||
        !state.lists.some((list) => list.id === input.listId)) {
        throw new CollectionError('validation', 'Use plain-text notes, High/Normal/Low Priority, and an existing List.');
      }
      const current = state.tasks.find((task) => task.id === id);
      if (!current || current.revision !== version.recordRevision ||
        state.restoreGeneration !== version.restoreGeneration) {
        throw new CollectionError('conflict', 'This task changed. Keep your draft, close the editor and reload saved tasks before editing again.');
      }
      const next = validate({
        ...state, collectionRevision: state.collectionRevision + 1,
        tasks: state.tasks.map((task) => task.id === id ? {
          ...task, title: input.title.trim(), notes: input.notes, priority: input.priority, listId: input.listId,
          updatedAt: new Date(Math.max(Date.parse(now()), Date.parse(task.updatedAt))).toISOString(),
          revision: task.revision + 1,
        } : task),
      });
      return { next, value: snapshot(next, scope) };
    }),
    setPriority: async (id, priority, version, scope) => {
      if (!prioritySchema.safeParse(priority).success) {
        throw new CollectionError('validation', 'Choose High, Normal, or Low priority.');
      }
      return run(true, (state) => {
        const current = state.tasks.find((task) => task.id === id);
        if (!current || current.revision !== version.recordRevision ||
          state.restoreGeneration !== version.restoreGeneration) {
          throw new CollectionError('conflict', 'This task changed. Reload the saved tasks before trying again.');
        }
        const next = validate({
          ...state,
          collectionRevision: state.collectionRevision + 1,
          tasks: state.tasks.map((task) => task.id === id ? {
            ...task,
            priority,
            updatedAt: new Date(Math.max(Date.parse(now()), Date.parse(task.updatedAt))).toISOString(),
            revision: task.revision + 1,
          } : task),
        });
        return { next, value: snapshot(next, scope) };
      });
    },
    setStatus: (id, status, version, scope) => run(true, (state) => {
      if (typeof id !== 'string' || !id.trim() || id !== id.trim() ||
        (status !== 'active' && status !== 'completed') ||
        typeof version !== 'object' || version === null ||
        !Number.isSafeInteger(version.recordRevision) || version.recordRevision < 0 ||
        !Number.isSafeInteger(version.restoreGeneration) || version.restoreGeneration < 0) {
        throw new CollectionError('validation', 'Choose a saved task, its version, and Active or Completed status.');
      }
      const current = state.tasks.find((task) => task.id === id);
      if (!current || current.revision !== version.recordRevision ||
        state.restoreGeneration !== version.restoreGeneration) {
        throw new CollectionError('conflict', 'This task changed. Reload the saved tasks before trying again.');
      }
      if (current.status === status) {
        throw new CollectionError('validation', `This task is already ${status}.`);
      }
      const time = new Date(Math.max(Date.parse(now()), Date.parse(current.updatedAt))).toISOString();
      const next = validate({
        ...state,
        collectionRevision: state.collectionRevision + 1,
        tasks: state.tasks.map((task) => task.id === id ? {
          ...task,
          status,
          completedAt: status === 'completed' ? time : null,
          updatedAt: time,
          revision: task.revision + 1,
        } : task),
      });
      return { next, value: snapshot(next, scope) };
    }),
    deleteTask: (id, version, scope) => run(true, (state) => {
      if (typeof id !== 'string' || !id.trim() || id !== id.trim() ||
        typeof version !== 'object' || version === null ||
        !Number.isSafeInteger(version.recordRevision) || version.recordRevision < 0 ||
        !Number.isSafeInteger(version.restoreGeneration) || version.restoreGeneration < 0) {
        throw new CollectionError('validation', 'Choose a saved task and its version before deleting.');
      }
      const current = state.tasks.find((task) => task.id === id);
      if (!current || current.revision !== version.recordRevision ||
        state.restoreGeneration !== version.restoreGeneration) {
        throw new CollectionError('conflict', 'This task changed. Reload the saved tasks before trying again.');
      }
      const next = validate({
        ...state,
        collectionRevision: state.collectionRevision + 1,
        tasks: state.tasks.filter((task) => task.id !== id),
      });
      return { next, value: snapshot(next, scope) };
    }),
  };
}

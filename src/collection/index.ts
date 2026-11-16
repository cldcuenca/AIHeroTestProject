import { initialState, prioritySchema, stateSchema } from './model';
import type { CollectionState, List, Priority, Task } from './model';
import { indexedDbStorage } from './storage';
import type { CollectionStorage, StorageChange } from './storage';

export type { List, Priority, Task } from './model';

export type TaskVersion = Readonly<{ recordRevision: number; restoreGeneration: number }>;
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
  capture(input: Readonly<{ title: string }>): Promise<CollectionSnapshot>;
  setPriority(id: string, priority: Priority, version: TaskVersion): Promise<CollectionSnapshot>;
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
      lists: state.lists.map(({ revision: _revision, ...list }) => list),
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

  return {
    read: (scope) => run(false, (state) => ({ value: snapshot(state, scope) })),
    capture: async (input) => {
      if (typeof input.title !== 'string' || !input.title.trim()) {
        throw new CollectionError('validation', 'Enter a task title with at least one non-space character.');
      }
      return run(true, (state) => {
        const time = now();
        const next = validate({
          ...state,
          collectionRevision: state.collectionRevision + 1,
          tasks: [...state.tasks, {
            id: uuid(),
            title: input.title.trim(),
            notes: '',
            listId: 'inbox',
            priority: 'normal',
            status: 'active',
            createdAt: time,
            updatedAt: time,
            completedAt: null,
            revision: 1,
          }],
        });
        return { next, value: snapshot(next) };
      });
    },
    setPriority: async (id, priority, version) => {
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
        return { next, value: snapshot(next) };
      });
    },
  };
}

import { z } from 'zod';

const id = z.string().min(1).refine((value) => value === value.trim(), 'IDs must be trimmed.');
const text = z.string().min(1).refine((value) => value === value.trim(), 'Text must be trimmed.');
const timestamp = z.string().datetime();
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const prioritySchema = z.enum(['high', 'normal', 'low']);
export type Priority = z.infer<typeof prioritySchema>;

const listSchema = z.object({
  id,
  name: text,
  createdAt: timestamp,
}).strict();

const taskSchema = z.object({
  id,
  title: text,
  notes: z.string(),
  listId: id,
  priority: prioritySchema,
  status: z.enum(['active', 'completed']),
  createdAt: timestamp,
  updatedAt: timestamp,
  completedAt: timestamp.nullable(),
}).strict();

export type List = z.infer<typeof listSchema>;
export type Task = z.infer<typeof taskSchema>;

const storedListSchema = listSchema.extend({ revision });
const storedTaskSchema = taskSchema.extend({ revision });

export const stateSchema = z.object({
  schemaVersion: z.literal(1),
  collectionRevision: revision,
  restoreGeneration: revision,
  lists: z.array(storedListSchema),
  tasks: z.array(storedTaskSchema),
}).strict().superRefine((state, context) => {
  const invalid = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  const listIds = new Set(state.lists.map((list) => list.id));
  const names = state.lists.map((list) => list.name.toLowerCase());
  if (listIds.size !== state.lists.length || new Set(names).size !== names.length) {
    invalid('List IDs and names must be unique.');
  }
  if (state.lists.filter((list) => list.id === 'inbox' && list.name === 'Inbox').length !== 1) {
    invalid('Exactly one Inbox is required.');
  }
  for (const list of state.lists) {
    if (list.name.toLowerCase() === 'all tasks' ||
      (list.id !== 'inbox' && list.name.toLowerCase() === 'inbox')) {
      invalid('Built-in names are reserved.');
    }
  }
  if (new Set(state.tasks.map((task) => task.id)).size !== state.tasks.length) {
    invalid('Task IDs must be unique.');
  }
  for (const task of state.tasks) {
    if (!listIds.has(task.listId)) invalid('A Task must belong to an existing List.');
    if ((task.status === 'active') !== (task.completedAt === null)) {
      invalid('Completion time must match Task status.');
    }
    if (Date.parse(task.updatedAt) < Date.parse(task.createdAt) ||
      (task.completedAt !== null && (Date.parse(task.completedAt) < Date.parse(task.createdAt) ||
        Date.parse(task.completedAt) > Date.parse(task.updatedAt)))) {
      invalid('Task timestamps must be consistent.');
    }
  }
});

export type CollectionState = z.infer<typeof stateSchema>;

export function initialState(now: string): CollectionState {
  return {
    schemaVersion: 1,
    collectionRevision: 0,
    restoreGeneration: 0,
    lists: [{ id: 'inbox', name: 'Inbox', createdAt: now, revision: 0 }],
    tasks: [],
  };
}

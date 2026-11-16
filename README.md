# Taskroom

A quiet, personal, desktop-first space to capture, prioritize and finish Tasks.
React, strict TypeScript and Vite; no account, backend or task-data network requests.

## Run locally

Use Node.js 22.12 or later (Node 22 LTS recommended) and npm.

```powershell
npm ci
npm run dev
```

Open the localhost URL printed by Vite. Keep the same URL, port and browser
profile to return to the same saved collection. Development and preview URLs
may use different ports and therefore different collections.

```powershell
npm run typecheck
npm run build
npm run preview
```

`build` checks strict types and produces `dist`. Serve that directory from a
static host over HTTPS (or localhost during development); opening `index.html`
as a local file is not supported. There is no server-side application.

## Current usage

- Start in **All Tasks / Active**, with exactly one **Inbox** and no sample Tasks.
- Type a title and press **Enter** or choose **Add task**. Leading/trailing
  whitespace is removed; internal whitespace is preserved. Blank titles are
  rejected. Duplicate titles are separate Tasks.
- Captures belong to Inbox and start Active, with Normal Priority and empty
  notes. After a successful save, the title clears and receives focus again.
- Select **High**, **Normal**, or **Low** for a Task. Changes are saved explicitly
  by that control and survive reload. Order is Priority, then oldest creation
  time, then stable ID. A Priority change does not recreate the Task.
- Choose **Inbox** or **All Tasks** in the sidebar. All Tasks is a combined view,
  not another saved List. All current Tasks belong to Inbox.
- Switch between **Active** and **Completed** without changing the selected
  List. Quick-add is available only in Active; switching views retains unsubmitted
  capture text until reload or closing the page. Startup always selects All Tasks/Active.
- Choose **Complete** to move a Task to Completed, or **Reopen** to make it Active
  again. Identity, title, notes, List, Priority and original creation order are
  retained. Reopening clears the completion time; completing again records only
  the latest time. Completed Tasks stay until you explicitly delete them.
- Choose **Delete** in either status view, review the named Task and permanence
  warning, then **Delete permanently**. **Cancel** or **Escape** changes nothing.
  Deletion survives reload; there is no trash, undelete or automatic cleanup.
- Keyboard users can Tab through navigation, capture, Priority and lifecycle controls.
  Deletion starts with Cancel focused and keeps keyboard focus in its dialog.
  Cancellation restores the originating control; a removed Task returns focus
  to the current status selector. Focus is visible; committed changes are announced.
  Entered markup is displayed as plain, inert text.

This includes the PPT-18 capture/Priority and PPT-19 lifecycle slices. Named Lists,
full editing/notes, search, backups/restore and automatic cross-tab refreshing
are **not available yet**. They are separate later slices, not hidden controls.

## Storage, failures and limits

Tasks are stored in IndexedDB in this browser profile **for this origin only**
(scheme, host and port). Another browser, device, private session or origin does
not share the collection. There is no synchronization or automatic backup.
Clearing browser/site data, profile removal, storage eviction or private-session
closure may erase Tasks. **A backup/export workflow is not part of this slice;
do not use it as the only copy of irreplaceable information.**

Operations work without network access after the app has loaded. Offline
cold-start loading, installation and a service worker are not promised.
Unsaved capture input lives only in the open page; reloading, closing or
crashing can lose it.

The app shows loading until storage succeeds. A storage or invalid-data error
is not an empty collection: it never replaces saved data with a fresh collection
or silently switches to memory. Success is shown only after a transaction
commits. A failed capture retains its input; a failed Priority save retains the
committed value and order. Failed completion/reopening keeps the previous saved
status. Failed deletion keeps the confirmation open with an error and removes
nothing; cancel it before refreshing saved Tasks. Errors are accessible and visible.

If storage fails:

1. Keep useful unsaved text by copying it before leaving the page.
2. Check that the browser permits site storage and has free space.
3. Use **Retry loading** to refresh saved Tasks, then retry the intended action.
   Retry loading does not submit or clear a capture.
4. For an invalid-data error, keep the same profile and seek recovery help.
   **Do not clear site data** as a troubleshooting shortcut.

This slice rejects Priority, lifecycle or deletion commands based on an outdated
record version, including a deletion confirmation opened before another tab
changed the Task. Cancel the confirmation, reload the saved Tasks and review
before retrying. It does not yet automatically
refresh other tabs. Already committed changes are never reversed to hide errors.

## Checks

```powershell
npx playwright install chromium firefox webkit
npm test
```

Individual commands:

```powershell
npm run test:collection
npm run test:browser
npm run test:browser -- --project=chromium
```

Only the two specification-revision-1-approved seams are tested:

- **Browser:** user-visible app, production Task Collection and real IndexedDB.
  Isolated browser contexts cover startup, capture/reload, duplicates, inert
  text, Priority ordering, keyboard/focus, after-load offline operation,
  completion/reopening, status/List navigation, confirmed deletion/cancellation,
  stale confirmation rejection, unavailable storage and real transaction aborts
  after successful write requests. Saved outcomes are asserted through the app,
  not database queries.
- **Task Collection interface:** complete records, validation, scoped reads,
  deterministic ordering, returned versions/conflicts and controlled read,
  quota/commit failures, deterministic lifecycle timestamps, deletion and
  unchanged results under stale versions or failed writes. Failure adapters do
  not prove browser atomicity, permissions, focus or UI wiring.

Automated Chromium, Firefox and WebKit checks are configured. These bundled
engines are not proof of compatibility with every current Chrome, Edge, Firefox
or macOS Safari release. Manual current-stable browser, browser-zoom,
screen-reader/high-contrast and native permission-dialog verification remains
necessary. Native leave-page warnings and durable Draft recovery are outside
this slice; engine automation cannot establish assistive-technology experience.

For environments with a corporate certificate authority, use the trusted system
CA or your approved CA bundle for Node/browser downloads; never disable TLS
certificate verification. For a worktree-local browser cache:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH="$PWD\.local-evidence\browsers"
$env:NODE_OPTIONS="--use-system-ca"
npx playwright install chromium firefox webkit
npm test
```

Keep that environment variable set when running the tests. Generated browser
caches, traces, reports and build output are ignored.

## Task Collection interface

Import from `src/collection/index.ts`. The module owns invariants, validation,
ordering, revisions and persistence; the UI owns transient input, navigation,
focus and errors.

```typescript
const collection = createTaskCollection();
const saved = await collection.capture({ title: 'Plan the week' });
const inbox = await collection.read({ listId: 'inbox', status: 'active' });
const entry = inbox.tasks[0];
if (entry) {
  await collection.setPriority(entry.task.id, 'high', entry.version);
}
const current = (await collection.read()).tasks[0];
if (current) {
  await collection.setStatus(current.task.id, 'completed', current.version,
    { status: 'completed' });
}
```

- `read(scope?)` defaults to all Active Tasks. Returns Lists, ordered
  `{ task, version }` entries, collection revision and restore generation.
- `capture({ title })` returns an All Tasks/Active committed snapshot.
- `setPriority(id, priority, version, scope?)`,
  `setStatus(id, 'active' | 'completed', version, scope?)` and
  `deleteTask(id, version, scope?)` return a committed snapshot in the requested
  scope (default All Tasks/Active). Use the latest returned/read Task version
  for each command; stale versions or missing Tasks reject with `conflict`.
  An already-current status rejects with `validation`, without revision changes.
  The UI owns named permanent-deletion confirmation before calling `deleteTask`.
- `Task` contains `id`, `title`, `notes`, `listId`, `priority`, `status`,
  `createdAt`, `updatedAt`, `completedAt`. `List` contains `id`, `name`,
  `createdAt`. Domain fields are separate from internal revisions.
- IDs are generated with browser UUID generation; timestamps are UTC ISO 8601.
  Priority and status saves preserve creation time and identity, update saved-change
  time, and atomically advance record and collection revisions. Completing sets
  `completedAt`; reopening clears it. Deletion removes the record and atomically
  advances the collection revision, leaving other records untouched. Restore
  generation is initialized and checked, reserved for the later restore slice.
- Failures reject with `CollectionError`: `validation`, `invalid-data`,
  `storage`, or `conflict`. Never treat rejection as an empty read or success.
- Optional factory settings select an isolated database, time/UUID sources or
  the internal storage adapter for controlled tests. Production uses IndexedDB.

The internal IndexedDB adapter uses a versioned singleton collection record:
every read-modify-write validates the complete collection inside one serialized
transaction, and results resolve on `complete`, never request `success`.
Initialization creates Inbox only during creation of a genuinely new database.
Existing missing/corrupt state is rejected rather than recreated.

Internal storage shape is not a backup format or a supported integration
interface. The two approved seams remain the app and Task Collection interface;
there are no helper, hook or UI-internal suites.

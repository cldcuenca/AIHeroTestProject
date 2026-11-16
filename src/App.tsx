import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { CollectionError, createTaskCollection } from './collection';
import type { CollectionSnapshot, Priority, SavedTask } from './collection';
import { ListDialog } from './ListDialog';
import { TaskEditor } from './TaskEditor';
import { DeleteListDialog } from './DeleteListDialog';

const collection = createTaskCollection();

export function App() {
  const [snapshot, setSnapshot] = useState<CollectionSnapshot>();
  const [listId, setListId] = useState<string>();
  const [status, setStatus] = useState<'active' | 'completed'>('active');
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [titleInvalid, setTitleInvalid] = useState(false);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<SavedTask | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [creatingList, setCreatingList] = useState(false);
  const [renamingList, setRenamingList] = useState(false);
  const [editing, setEditing] = useState<SavedTask | null>(null);
  const [deletingList, setDeletingList] = useState(false);
  const scope = { ...(listId === undefined ? {} : { listId }), status };
  const selectedName = listId === undefined ? 'All Tasks' : snapshot?.lists.find((list) => list.id === listId)?.name ?? 'Loading List…';
  const selectedList = snapshot?.lists.find((list) => list.id === listId);
  const titleInput = useRef<HTMLInputElement>(null);
  const nextViewNotice = useRef('');
  const committedNavigation = useRef(false);
  const busy = useRef(false);
  const priorityFocus = useRef<HTMLSelectElement | null>(null);
  const lifecycleFocus = useRef<HTMLButtonElement | null>(null);
  const activeView = useRef<HTMLButtonElement>(null);
  const completedView = useRef<HTMLButtonElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const confirmDeleteControl = useRef<HTMLButtonElement>(null);
  const deleteReturnFocus = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const dialog = deleteDialog.current;
    if (deleteTarget) {
      dialog?.showModal();
      cancelDelete.current?.focus();
    } else if (dialog?.open) {
      dialog.close();
      deleteReturnFocus.current?.focus();
    }
  }, [deleteTarget]);

  useEffect(() => {
    if (!saving && priorityFocus.current) {
      priorityFocus.current.focus();
      priorityFocus.current = null;
    }
    if (!saving && lifecycleFocus.current) {
      lifecycleFocus.current.focus();
      lifecycleFocus.current = null;
    }
  }, [saving]);

  useEffect(() => {
    setError('');
    setTitleInvalid(false);
    setNotice(nextViewNotice.current);
    nextViewNotice.current = '';
    if (committedNavigation.current) {
      committedNavigation.current = false;
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setSnapshot(undefined);
    collection.read({ ...(listId === undefined ? {} : { listId }), status }).then((saved) => {
      if (active) setSnapshot(saved);
    }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : 'Storage could not be loaded.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [loadAttempt, listId, status]);

  async function capture(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError('');
    setTitleInvalid(false);
    setNotice('');
    try {
      setSnapshot(await collection.capture({ title, ...(listId === undefined ? {} : { listId }) }, scope));
      setTitle('');
      setNotice(`Task added to ${listId === undefined ? 'Inbox' : selectedName}.`);
    } catch (failure) {
      setTitleInvalid(failure instanceof CollectionError && failure.code === 'validation');
      setError(failure instanceof Error ? failure.message : 'Task could not be saved. Please retry.');
    } finally {
      busy.current = false;
      setSaving(false);
      titleInput.current?.focus();
    }
  }

  async function changePriority(saved: SavedTask, priority: Priority, control: HTMLSelectElement) {
    if (busy.current) return;
    busy.current = true;
    priorityFocus.current = control;
    setSaving(true);
    setError('');
    setTitleInvalid(false);
    setNotice('');
    try {
      setSnapshot(await collection.setPriority(saved.task.id, priority, saved.version, {
        ...(listId === undefined ? {} : { listId }), status,
      }));
      setNotice('Priority saved.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Priority could not be saved. Please retry.');
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  async function changeStatus(saved: SavedTask, control: HTMLButtonElement) {
    if (busy.current) return;
    busy.current = true;
    lifecycleFocus.current = control;
    setSaving(true);
    setError('');
    setTitleInvalid(false);
    setNotice('');
    try {
      const nextStatus = saved.task.status === 'active' ? 'completed' : 'active';
      setSnapshot(await collection.setStatus(saved.task.id, nextStatus, saved.version, {
        ...(listId === undefined ? {} : { listId }), status,
      }));
      setNotice(nextStatus === 'completed' ? 'Task completed.' : 'Task reopened.');
      lifecycleFocus.current = status === 'active' ? activeView.current : completedView.current;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Task status could not be saved. Please retry.');
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (busy.current || !deleteTarget) return;
    busy.current = true;
    lifecycleFocus.current = confirmDeleteControl.current;
    setSaving(true);
    setDeleteError('');
    setError('');
    setTitleInvalid(false);
    setNotice('');
    try {
      setSnapshot(await collection.deleteTask(deleteTarget.task.id, deleteTarget.version, {
        ...(listId === undefined ? {} : { listId }), status,
      }));
      setNotice('Task permanently deleted.');
      deleteReturnFocus.current = status === 'active' ? activeView.current : completedView.current;
      lifecycleFocus.current = deleteReturnFocus.current;
      setDeleteTarget(null);
    } catch (failure) {
      setDeleteError(failure instanceof Error ? failure.message : 'Task could not be deleted. Please retry.');
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">Skip to tasks</a>
      <aside className="sidebar">
        <div className="brand"><span aria-hidden="true">◈</span> Taskroom</div>
        <p className="eyebrow">YOUR SPACE</p>
        <nav aria-label="Task views">
          <button disabled={saving} aria-current={listId === undefined ? 'page' : undefined} onClick={() => setListId(undefined)}>All Tasks</button>
          <button disabled={saving} aria-current={listId === 'inbox' ? 'page' : undefined} onClick={() => setListId('inbox')}>Inbox</button>
          {snapshot?.lists.filter((list) => list.id !== 'inbox').map((list) =>
            <button key={list.id} disabled={saving} aria-current={listId === list.id ? 'page' : undefined} onClick={() => setListId(list.id)}>{list.name}</button>)}
        </nav>
        <button className="task-action new-list" disabled={saving || loading || !snapshot} onClick={(event) => { event.currentTarget.focus(); setCreatingList(true); }}>New List</button>
        <div className="storage-note">
          <strong>A little space of your own.</strong>
          <p>Saved in this browser profile on this site only. No account. No synchronization.</p>
          <p>Clearing browser data erases your tasks. Unsaved input is not recovered after closing.</p>
        </div>
      </aside>
      <main id="main">
        <header>
          <p className="eyebrow">MAKE ROOM FOR WHAT MATTERS</p>
          <h1>{selectedName}</h1>
          <p>Capture a thought. Choose what comes next.</p>
          {selectedList && selectedList.id !== 'inbox' && <div className="list-actions">
            <button className="task-action" disabled={saving} onClick={(event) => { event.currentTarget.focus(); setRenamingList(true); }}>Rename List</button>
            <button className="task-action danger" disabled={saving} onClick={(event) => { event.currentTarget.focus(); setDeletingList(true); }}>Delete List</button>
          </div>}
        </header>
        <div className="view-bar">
          <div role="group" aria-label="Task status">
            <button ref={activeView} disabled={saving} aria-pressed={status === 'active'} onClick={() => setStatus('active')}>Active</button>
            <button ref={completedView} disabled={saving} aria-pressed={status === 'completed'} onClick={() => setStatus('completed')}>Completed</button>
          </div>
          <span>Priority · oldest first</span>
        </div>
        <p role="status" className="save-notice">{notice}</p>
        {error && <div className="error"><p role="alert" id="collection-error">{error}</p><button className="retry" disabled={loading || saving} onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Retry loading</button></div>}
        {loading || !snapshot ? (
          loading && <p aria-live="polite">Loading your tasks…</p>
        ) : (
          <>
            {status === 'active' && <form onSubmit={(event) => { void capture(event); }} className="capture-form" aria-label="Capture a task">
              <label htmlFor="task-title">Task title</label>
              <div className="capture-controls">
                <input id="task-title" ref={titleInput} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What’s on your mind?" readOnly={saving} aria-invalid={titleInvalid} aria-describedby={titleInvalid ? 'collection-error' : 'capture-hint'} />
                <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Add task'}</button>
              </div>
              <p id="capture-hint" className="hint">Press Enter to add to {listId === undefined ? 'Inbox' : selectedName}. Start small; priorities can change.</p>
            </form>}
            {snapshot.tasks.length === 0 ? (
              <section className="empty-state"><span aria-hidden="true">✦</span><h2>{status === 'active' ? 'No active tasks yet.' : 'No completed tasks yet.'}</h2><p>{status === 'active' ? 'A clear space for your next idea. Add your first task above.' : 'Finished tasks stay here until you choose to delete them.'}</p></section>
            ) : (
              <ul aria-label="Tasks" className="task-list">
                {snapshot.tasks.map((saved) => (
                  <li key={saved.task.id}>
                    <div className="task-content"><strong>{saved.task.title}</strong>{listId === undefined && <span className="list-tag">{snapshot.lists.find((list) => list.id === saved.task.listId)?.name}</span>}</div>
                    <select aria-label={`Priority for ${saved.task.title}`} value={saved.task.priority} disabled={saving} onChange={(event) => {
                      const priority = event.target.value;
                      if (priority === 'high' || priority === 'normal' || priority === 'low') {
                        void changePriority(saved, priority, event.currentTarget);
                      }
                    }}>
                      <option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option>
                    </select>
                    <button className="task-action" disabled={saving} aria-label={`${saved.task.status === 'active' ? 'Complete' : 'Reopen'} ${saved.task.title}`} onClick={(event) => { void changeStatus(saved, event.currentTarget); }}>
                      {saved.task.status === 'active' ? 'Complete' : 'Reopen'}
                    </button>
                    <button className="task-action danger" disabled={saving} aria-label={`Delete ${saved.task.title}`} onClick={(event) => {
                      deleteReturnFocus.current = event.currentTarget;
                      setDeleteError('');
                      setNotice('');
                      setDeleteTarget(saved);
                    }}>Delete</button>
                    <button className="task-action" disabled={saving} aria-label={`Edit ${saved.task.title}`} onClick={(event) => { event.currentTarget.focus(); setEditing(saved); }}>Edit</button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <footer>Private by design. One task at a time.</footer>
      </main>
      {deletingList && selectedList && <DeleteListDialog collection={collection} target={selectedList} scope={scope} onClose={() => setDeletingList(false)} fallbackFocus={() => status === 'active' ? activeView.current : completedView.current} onSaved={(result) => {
        setDeletingList(false);
        setSnapshot(result);
        nextViewNotice.current = 'List deleted. All its tasks moved to Inbox.';
        committedNavigation.current = true;
        setListId('inbox');
        setNotice('List deleted. All its tasks moved to Inbox.');
      }} />}
      {editing && snapshot && <TaskEditor collection={collection} saved={editing} snapshot={snapshot} scope={scope} onClose={() => setEditing(null)} fallbackFocus={() => status === 'active' ? activeView.current : completedView.current} onSaved={(result) => {
        setSnapshot(result);
        setEditing(null);
        setNotice('Task saved.');
      }} />}
      {snapshot && (creatingList || renamingList) && <ListDialog collection={collection} scope={scope} baseline={snapshot} {...(renamingList && selectedList ? { target: selectedList } : {})} onClose={() => { setCreatingList(false); setRenamingList(false); }} onSaved={(saved) => {
        setSnapshot(saved);
        setCreatingList(false);
        setRenamingList(false);
        setNotice(renamingList ? 'List renamed.' : 'List created.');
      }} />}
      <dialog ref={deleteDialog} aria-labelledby="delete-heading" aria-describedby="delete-warning" aria-busy={saving} onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (!first || !last) {
          event.preventDefault();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }} onCancel={(event) => {
        event.preventDefault();
        if (!busy.current) setDeleteTarget(null);
      }}>
        <h2 id="delete-heading">Delete task?</h2>
        <p id="delete-warning">Permanently delete “{deleteTarget?.task.title}”? This cannot be undone. There is no trash or undelete.</p>
        {deleteError && <p role="alert" className="error">{deleteError}</p>}
        <div className="dialog-actions">
          <button ref={cancelDelete} className="task-action" disabled={saving} onClick={() => setDeleteTarget(null)}>Cancel</button>
          <button ref={confirmDeleteControl} className="task-action danger" disabled={saving} onClick={() => { void confirmDelete(); }}>{saving ? 'Deleting…' : 'Delete permanently'}</button>
        </div>
      </dialog>
    </div>
  );
}

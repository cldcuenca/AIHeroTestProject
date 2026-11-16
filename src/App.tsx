import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { CollectionError, createTaskCollection } from './collection';
import type { CollectionSnapshot, Priority, SavedTask } from './collection';

const collection = createTaskCollection();

export function App() {
  const [snapshot, setSnapshot] = useState<CollectionSnapshot>();
  const [listId, setListId] = useState<string>();
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [titleInvalid, setTitleInvalid] = useState(false);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const titleInput = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const priorityFocus = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    if (!saving && priorityFocus.current) {
      priorityFocus.current.focus();
      priorityFocus.current = null;
    }
  }, [saving]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setTitleInvalid(false);
    setNotice('');
    collection.read().then((saved) => {
      if (active) setSnapshot(saved);
    }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : 'Storage could not be loaded.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [loadAttempt]);

  async function capture(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError('');
    setTitleInvalid(false);
    setNotice('');
    try {
      setSnapshot(await collection.capture({ title }));
      setTitle('');
      setNotice('Task added to Inbox.');
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
      setSnapshot(await collection.setPriority(saved.task.id, priority, saved.version));
      setNotice('Priority saved.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Priority could not be saved. Please retry.');
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
          <button aria-current={listId === undefined ? 'page' : undefined} onClick={() => setListId(undefined)}>All Tasks</button>
          <button aria-current={listId === 'inbox' ? 'page' : undefined} onClick={() => setListId('inbox')}>Inbox</button>
        </nav>
        <div className="storage-note">
          <strong>A little space of your own.</strong>
          <p>Saved in this browser profile on this site only. No account. No synchronization.</p>
          <p>Clearing browser data erases your tasks. Unsaved input is not recovered after closing.</p>
        </div>
      </aside>
      <main id="main">
        <header>
          <p className="eyebrow">MAKE ROOM FOR WHAT MATTERS</p>
          <h1>{listId === undefined ? 'All Tasks' : 'Inbox'}</h1>
          <p>Capture a thought. Choose what comes next.</p>
        </header>
        <div className="view-bar"><strong>Active</strong><span>Priority · oldest first</span></div>
        <p role="status" className="save-notice">{notice}</p>
        {error && <div className="error"><p role="alert" id="collection-error">{error}</p><button className="retry" disabled={loading || saving} onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Retry loading</button></div>}
        {!snapshot ? (
          loading && <p aria-live="polite">Loading your tasks…</p>
        ) : (
          <>
            <form onSubmit={(event) => { void capture(event); }} className="capture-form" aria-label="Capture a task">
              <label htmlFor="task-title">Task title</label>
              <div className="capture-controls">
                <input id="task-title" ref={titleInput} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What’s on your mind?" readOnly={saving} aria-invalid={titleInvalid} aria-describedby={titleInvalid ? 'collection-error' : 'capture-hint'} />
                <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Add task'}</button>
              </div>
              <p id="capture-hint" className="hint">Press Enter to add to Inbox. Start small; priorities can change.</p>
            </form>
            {snapshot.tasks.length === 0 ? (
              <section className="empty-state"><span aria-hidden="true">✦</span><h2>No active tasks yet.</h2><p>A clear space for your next idea. Add your first task above.</p></section>
            ) : (
              <ul aria-label="Tasks" className="task-list">
                {snapshot.tasks.map((saved) => (
                  <li key={saved.task.id}>
                    <div className="task-content"><strong>{saved.task.title}</strong>{listId === undefined && <span className="list-tag">Inbox</span>}</div>
                    <select aria-label={`Priority for ${saved.task.title}`} value={saved.task.priority} disabled={saving} onChange={(event) => {
                      const priority = event.target.value;
                      if (priority === 'high' || priority === 'normal' || priority === 'low') {
                        void changePriority(saved, priority, event.currentTarget);
                      }
                    }}>
                      <option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option>
                    </select>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <footer>Private by design. One task at a time.</footer>
      </main>
    </div>
  );
}

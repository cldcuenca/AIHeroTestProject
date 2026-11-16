import { useEffect, useRef, useState } from 'react';
import type { CollectionSnapshot, SavedTask, TaskCollection, TaskEdits, ViewScope } from './collection';
import { Modal } from './Modal';

export function TaskEditor({ collection, saved, snapshot, scope, onSaved, onClose, fallbackFocus }: {
  collection: TaskCollection; saved: SavedTask; snapshot: CollectionSnapshot; scope: ViewScope;
  onSaved: (result: CollectionSnapshot) => void; onClose: () => void;
  fallbackFocus: () => HTMLElement | null;
}) {
  const [draft, setDraft] = useState<TaskEdits>({
    title: saved.task.title, notes: saved.task.notes, priority: saved.task.priority, listId: saved.task.listId,
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const [discarding, setDiscarding] = useState(false);
  const dirty = draft.title !== saved.task.title || draft.notes !== saved.task.notes ||
    draft.priority !== saved.task.priority || draft.listId !== saved.task.listId;
  const close = () => { if (dirty) setDiscarding(true); else onClose(); };
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  return <><Modal heading="Edit task" onCancel={close} busy={saving} fallbackFocus={fallbackFocus}>
    <form className="editor-form" aria-describedby={error ? 'edit-error' : 'draft-limit'} onSubmit={(event) => {
      event.preventDefault();
      if (busy.current) return;
      busy.current = true;
      setSaving(true);
      setError('');
      collection.editTask(saved.task.id, draft, saved.version, scope).then(onSaved).catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : 'Task could not be saved. Your draft is retained; please retry.');
      }).finally(() => {
        busy.current = false;
        setSaving(false);
        input.current?.focus();
      });
    }}>
      <label htmlFor="edit-title">Title</label>
      <input ref={input} id="edit-title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} readOnly={saving} aria-invalid={Boolean(error) && !draft.title.trim()} aria-describedby={error ? 'edit-error' : undefined} />
      <label htmlFor="edit-notes">Notes</label>
      <textarea id="edit-notes" rows={6} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} readOnly={saving} />
      <label htmlFor="edit-priority">Priority</label>
      <select id="edit-priority" value={draft.priority} disabled={saving} onChange={(event) => {
        const priority = event.target.value;
        if (priority === 'high' || priority === 'normal' || priority === 'low') setDraft({ ...draft, priority });
      }}><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select>
      <label htmlFor="edit-list">List</label>
      <select id="edit-list" value={draft.listId} disabled={saving} onChange={(event) => setDraft({ ...draft, listId: event.target.value })}>
        {snapshot.lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
      </select>
      <p className="hint" id="draft-limit">Changes are not saved until Save. Drafts are not recovered after closing the page.</p>
      {error && <p role="alert" className="error" id="edit-error">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="task-action" disabled={saving} onClick={(event) => { event.currentTarget.focus(); close(); }}>Cancel</button>
        <button className="retry" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  </Modal>
    {discarding && <Modal heading="Discard unsaved changes?" onCancel={() => setDiscarding(false)}>
      <p>Your task edits have not been saved. Discard these changes or keep editing.</p>
      <div className="dialog-actions">
        <button className="task-action" onClick={() => setDiscarding(false)}>Keep Editing</button>
        <button className="task-action danger" onClick={onClose}>Discard changes</button>
      </div>
    </Modal>}
  </>;
}

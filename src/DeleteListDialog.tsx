import { useEffect, useRef, useState } from 'react';
import type { CollectionSnapshot, List, ListDeletionPreview, TaskCollection, ViewScope } from './collection';
import { Modal } from './Modal';

export function DeleteListDialog({ collection, target, scope, onSaved, onClose, fallbackFocus }: {
  collection: TaskCollection; target: List; scope: ViewScope;
  onSaved: (result: CollectionSnapshot) => void; onClose: () => void;
  fallbackFocus: () => HTMLElement | null;
}) {
  const [preview, setPreview] = useState<ListDeletionPreview>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    collection.previewListDeletion(target.id).then((result) => {
      if (active) setPreview(result);
    }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : 'List counts could not be loaded. Please retry.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [collection, target.id, attempt]);
  useEffect(() => {
    if (!saving && error && preview) confirm.current?.focus();
  }, [saving, error, preview]);

  return <Modal heading="Delete List?" onCancel={onClose} busy={saving} fallbackFocus={fallbackFocus}>
    <p>Delete “{preview?.list.name ?? target.name}”?</p>
    {loading && <p aria-live="polite">Counting all tasks…</p>}
    {preview && <p>{preview.activeCount} Active and {preview.completedCount} Completed tasks will move to Inbox.
      Only the List will be removed; task details and completion state are preserved.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="dialog-actions">
      <button className="task-action" disabled={saving} onClick={onClose}>Cancel</button>
      {!preview && !loading && <button className="retry" onClick={() => setAttempt((value) => value + 1)}>Retry loading counts</button>}
      {preview && <button ref={confirm} className="task-action danger" disabled={saving || loading} onClick={() => {
        if (busy.current) return;
        busy.current = true;
        setSaving(true);
        setError('');
        collection.deleteList(target.id, preview.version, scope).then(onSaved).catch((failure: unknown) => {
          setError(failure instanceof Error ? failure.message : 'List could not be deleted. All saved tasks are unchanged; please retry.');
        }).finally(() => { busy.current = false; setSaving(false); });
      }}>{saving ? 'Deleting…' : 'Move tasks to Inbox and delete List'}</button>}
    </div>
  </Modal>;
}

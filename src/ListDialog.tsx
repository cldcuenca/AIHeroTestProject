import { useRef, useState } from 'react';
import type { CollectionSnapshot, List, TaskCollection, ViewScope } from './collection';
import { Modal } from './Modal';

export function ListDialog({ collection, scope, baseline, target, onSaved, onClose }: {
  collection: TaskCollection; scope: ViewScope;
  baseline: CollectionSnapshot; target?: List;
  onSaved: (snapshot: CollectionSnapshot) => void; onClose: () => void;
}) {
  const [name, setName] = useState(target?.name ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  return <Modal heading={target ? 'Rename List' : 'New List'} onCancel={onClose} busy={saving}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (busy.current) return;
      busy.current = true;
      setSaving(true);
      setError('');
      const command = target
        ? collection.renameList(target.id, name, baseline, scope)
        : collection.createList({ name }, scope);
      command.then(onSaved).catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : 'List could not be saved. Please retry.');
      }).finally(() => {
        busy.current = false;
        setSaving(false);
        input.current?.focus();
      });
    }}>
      <label htmlFor="list-name">List name</label>
      <input ref={input} id="list-name" value={name} onChange={(event) => setName(event.target.value)} readOnly={saving} aria-invalid={Boolean(error)} aria-describedby={error ? 'list-error' : undefined} />
      {error && <p role="alert" className="error" id="list-error">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="task-action" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="retry" disabled={saving}>{target ? 'Save List name' : 'Create List'}</button>
      </div>
    </form>
  </Modal>;
}

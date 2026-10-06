import { useState, type FormEvent } from 'react';
import { api } from './api.js';
import { Select } from './select.js';

export function SlotAssignment({
  bindingName,
  imported = false,
  signups,
  onAssigned,
}: {
  bindingName: string;
  imported?: boolean;
  signups: { did: string; handle: string }[];
  onAssigned: () => Promise<void>;
}) {
  const [ownerDid, setOwnerDid] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.assignOperatorSlot(bindingName, ownerDid);
      await onAssigned();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not assign database slot');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="operator-controls slot-assignment" onSubmit={submit}>
      <div className="field">
        <label htmlFor={`slot-owner-${bindingName}`}>Assign {bindingName} to</label>
        <Select
          id={`slot-owner-${bindingName}`}
          value={ownerDid}
          onChange={setOwnerDid}
          disabled={busy}
          placeholder="Choose an interest signup"
          options={signups.map((signup) => ({ value: signup.did, label: `@${signup.handle}` }))}
        />
      </div>
      {imported && (
        <p className="settings-note">
          This existing imported monitor fleet and its history will belong to the assigned user.
        </p>
      )}
      <button className="button button--quiet" disabled={busy || !ownerDid}>
        {busy ? 'Assigning…' : 'Assign workspace'}
      </button>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </form>
  );
}

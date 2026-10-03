import { useState, type FormEvent } from 'react';
import { api } from './api.js';

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
      <label>
        Assign {bindingName} to
        <select
          value={ownerDid}
          onChange={(event) => setOwnerDid(event.target.value)}
          disabled={busy}
        >
          <option value="">Choose an interest signup</option>
          {signups.map((signup) => (
            <option key={signup.did} value={signup.did}>
              @{signup.handle}
            </option>
          ))}
        </select>
      </label>
      {imported && (
        <p className="settings-note">
          This existing staging monitor fleet and its history will belong to the assigned user.
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

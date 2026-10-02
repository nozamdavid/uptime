export function WorkspaceState({ state }: { state: string }) {
  const waiting = state === 'waiting_for_capacity';
  const deleting = state === 'deleting';
  const deleted = state === 'deleted';
  return (
    <section className="workspace-state" role="status">
      <p className="mono-label">
        WORKSPACE{' '}
        {waiting ? 'WAITING' : deleting ? 'DELETION PENDING' : deleted ? 'DELETED' : 'SUSPENDED'}
      </p>
      <h1>
        {waiting
          ? 'Waiting for workspace capacity.'
          : deleting
            ? 'Workspace deletion is pending.'
            : deleted
              ? 'Workspace has been deleted.'
              : 'Your workspace is suspended.'}
      </h1>
      <p>
        {waiting
          ? 'The owner can retry after refreshing. An operator can activate the workspace when a slot is available.'
          : deleting
            ? 'New checks are stopped while workspace data is removed.'
            : deleted
              ? 'Workspace data has been removed.'
              : 'Operational forms are unavailable while this workspace is suspended.'}
      </p>
    </section>
  );
}

// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkspaceState } from './workspace-state.js';

describe('WorkspaceState', () => {
  it('shows the waiting state for a workspace waiting for capacity', () => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceState, { state: 'waiting_for_capacity' }),
    );

    expect(html).toContain('WORKSPACE WAITING');
    expect(html).toContain('Waiting for workspace capacity.');
    expect(html).toContain('The owner can retry after refreshing.');
    expect(html).not.toContain('Your workspace is suspended.');
  });

  it.each([
    ['suspended', 'WORKSPACE SUSPENDED', 'Your workspace is suspended.'],
    ['deleting', 'WORKSPACE DELETION PENDING', 'Workspace deletion is pending.'],
    ['deleted', 'WORKSPACE DELETED', 'Workspace has been deleted.'],
  ])('keeps %s distinct', (state, label, heading) => {
    const html = renderToStaticMarkup(createElement(WorkspaceState, { state }));

    expect(html).toContain(label);
    expect(html).toContain(heading);
  });
});

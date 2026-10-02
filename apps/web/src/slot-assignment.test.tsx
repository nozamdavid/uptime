// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlotAssignment } from './slot-assignment.js';

const assign = vi.hoisted(() => vi.fn());
vi.mock('./api.js', () => ({ api: { assignOperatorSlot: assign } }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.innerHTML = '';
  assign.mockReset();
});

async function render(onAssigned = vi.fn(async () => {})) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      createElement(SlotAssignment, {
        bindingName: 'STAGING_TEST_DB_001',
        signups: [{ did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', handle: 'test.example' }],
        onAssigned,
      }),
    ),
  );
  return { container, onAssigned };
}

async function submit(container: HTMLElement) {
  await act(async () => {
    const select = container.querySelector('select')!;
    select.value = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
}

describe('slot assignment', () => {
  it('requires a selected verified signup and refreshes capacity after granting access', async () => {
    assign.mockResolvedValue({ state: 'active' });
    const { container, onAssigned } = await render();
    expect(container.querySelector('button')!.disabled).toBe(true);
    await submit(container);
    expect(assign).toHaveBeenCalledWith('STAGING_TEST_DB_001', 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(onAssigned).toHaveBeenCalledTimes(1);
  });

  it('shows a failed assignment without treating it as granted access', async () => {
    assign.mockRejectedValue(new Error('The last available slot is reserved'));
    const { container, onAssigned } = await render();
    await submit(container);
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('last available');
    expect(onAssigned).not.toHaveBeenCalled();
  });
});

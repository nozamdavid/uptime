import { act } from 'react';
import { createRoot } from 'react-dom/client';

/** Creates an isolated DOM root and restores React's act setting on cleanup. */
export function createTestRoot() {
  const container = document.createElement('div');
  const root = createRoot(container);
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  return {
    container,
    root,
    async cleanup() {
      await act(async () => root.unmount());
      if (previous === undefined) delete environment.IS_REACT_ACT_ENVIRONMENT;
      else environment.IS_REACT_ACT_ENVIRONMENT = previous;
    },
  };
}

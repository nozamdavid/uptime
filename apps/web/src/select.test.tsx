// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Select, type SelectOption } from './select.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: ReturnType<typeof createRoot>[] = [];

function render(element: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount());
  });
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const sampleOptions: SelectOption[] = [
  { value: 'apple', label: 'Apple' },
  { value: 'banana', label: 'Banana' },
  { value: 'cherry', label: 'Cherry' },
  { value: 'date', label: 'Date', disabled: 'Out of stock' },
  { value: 'elderberry', label: 'Elderberry' },
];

const longOptions: SelectOption[] = [
  { value: 'us-east', label: 'US East (N. Virginia)', code: 'US-E', group: 'Americas' },
  { value: 'us-west', label: 'US West (Oregon)', code: 'US-W', group: 'Americas' },
  { value: 'ca-central', label: 'Canada (Central)', code: 'CA-C', group: 'Americas' },
  { value: 'eu-west', label: 'EU (Ireland)', code: 'EU-W', group: 'Europe' },
  { value: 'eu-north', label: 'EU (Stockholm)', code: 'EU-N', group: 'Europe' },
  { value: 'eu-south', label: 'EU (Milan)', code: 'EU-S', group: 'Europe' },
  { value: 'asia-se', label: 'Asia (Singapore)', code: 'AS-SE', group: 'Asia-Pacific' },
  { value: 'asia-ne', label: 'Asia (Tokyo)', code: 'AS-NE', group: 'Asia-Pacific' },
  { value: 'asia-s', label: 'Asia (Mumbai)', code: 'AS-S', group: 'Asia-Pacific' },
];

describe('Select component', () => {
  it('renders trigger button with placeholder when empty and opens on click', async () => {
    const { container } = render(
      <Select
        id="fruit-select"
        options={sampleOptions}
        placeholder="Choose fruit"
      />,
    );

    const trigger = container.querySelector<HTMLButtonElement>('button.ut-select')!;
    expect(trigger).toBeTruthy();
    expect(trigger.id).toBe('fruit-select');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.textContent).toContain('Choose fruit');
    expect(container.querySelector('.ut-menu')).toBeNull();

    // Click to open
    await act(async () => {
      trigger.click();
    });

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.classList.contains('is-open')).toBe(true);
    const menu = container.querySelector('.ut-menu')!;
    expect(menu).toBeTruthy();
    expect(menu.getAttribute('role')).toBe('listbox');
    const options = menu.querySelectorAll('.ut-option');
    expect(options.length).toBe(sampleOptions.length);
  });

  it('names the trigger with its label and current value as a combobox', async () => {
    const { container } = render(
      <div>
        <label htmlFor="fruit-labelled">Fruit</label>
        <Select id="fruit-labelled" options={sampleOptions} value="banana" />
        <Select id="fruit-aria" aria-label="Snack" options={sampleOptions} value="apple" />
      </div>,
    );

    // Resolve aria-labelledby the way assistive tech does: referenced text, in order.
    const nameOf = (el: Element) =>
      el
        .getAttribute('aria-labelledby')!
        .split(' ')
        .map((id) => {
          const ref = document.getElementById(id)!;
          return ref === el ? ref.getAttribute('aria-label') : ref.textContent;
        })
        .join(' ');

    const labelled = container.querySelector<HTMLButtonElement>('#fruit-labelled')!;
    const ariaLabelled = container.querySelector<HTMLButtonElement>('#fruit-aria')!;
    expect(nameOf(labelled)).toBe('Fruit Banana');
    expect(nameOf(ariaLabelled)).toBe('Snack Apple');

    // aria-activedescendant is only valid on a combobox, never a plain button.
    expect(labelled.getAttribute('role')).toBe('combobox');
    await act(async () => {
      labelled.click();
    });
    const active = labelled.getAttribute('aria-activedescendant')!;
    expect(document.getElementById(active)?.getAttribute('role')).toBe('option');
  });

  it('hides the keyboard ring after a pointer pick and restores it on the next key', async () => {
    const { container } = render(<Select options={longOptions} />);
    const trigger = container.querySelector<HTMLButtonElement>('button.ut-select')!;
    await act(async () => {
      trigger.click();
    });
    // Search field owns the active option, so the trigger must not point at one.
    expect(trigger.hasAttribute('aria-activedescendant')).toBe(false);

    await act(async () => {
      container.querySelectorAll<HTMLElement>('.ut-option')[1]?.click();
    });
    expect(trigger.getAttribute('data-pointer-focus')).toBe('true');

    await act(async () => {
      trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
    });
    expect(trigger.hasAttribute('data-pointer-focus')).toBe(false);
  });

  it('handles choosing an option and triggers onChange', async () => {
    const onChange = vi.fn();
    function Controlled() {
      const [val, setVal] = useState('');
      return (
        <Select
          options={sampleOptions}
          value={val}
          placeholder="Choose fruit"
          onChange={(next) => {
            setVal(next);
            onChange(next);
          }}
        />
      );
    }

    const { container } = render(<Controlled />);
    const trigger = container.querySelector<HTMLButtonElement>('button.ut-select')!;

    await act(async () => {
      trigger.click();
    });

    const menu = container.querySelector('.ut-menu')!;
    const bananaOpt = Array.from(menu.querySelectorAll<HTMLElement>('.ut-option')).find(
      (opt) => opt.textContent?.includes('Banana'),
    )!;

    await act(async () => {
      bananaOpt.click();
    });

    expect(onChange).toHaveBeenCalledWith('banana');
    expect(container.querySelector('.ut-menu')).toBeNull();
    expect(trigger.textContent).toContain('Banana');
  });

  it('submits the chosen value with an enclosing form via a hidden input', async () => {
    const { container } = render(
      <form>
        <Select name="fruit" options={sampleOptions} defaultValue="cherry" />
      </form>,
    );
    expect(container.querySelector('select')).toBeNull();
    const form = container.querySelector('form')!;
    expect(new FormData(form).get('fruit')).toBe('cherry');

    const trigger = container.querySelector<HTMLButtonElement>('button.ut-select')!;
    await act(async () => {
      trigger.click();
    });
    await act(async () => {
      container.querySelectorAll<HTMLElement>('.ut-option')[1]?.click();
    });
    expect(new FormData(form).get('fruit')).toBe('banana');
  });

  it('keeps focus on the trigger after a pointer choice and does not swallow keys', async () => {
    const { container } = render(<Select options={sampleOptions} />);
    const trigger = container.querySelector<HTMLButtonElement>('button.ut-select')!;
    trigger.focus();
    await act(async () => {
      trigger.click();
    });

    const option = container.querySelectorAll<HTMLElement>('.ut-option')[1]!;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    option.dispatchEvent(down);
    // Pointer press on an option must not steal focus from the trigger.
    expect(down.defaultPrevented).toBe(true);

    await act(async () => {
      option.click();
    });
    expect(container.querySelector('.ut-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('returns focus to the trigger on Tab from the search field so traversal continues', async () => {
    const { container } = render(<Select options={longOptions} />);
    const trigger = container.querySelector<HTMLButtonElement>('button.ut-select')!;
    await act(async () => {
      trigger.click();
    });
    const searchInput = container.querySelector<HTMLInputElement>('.ut-menu__search input')!;
    searchInput.focus();

    let prevented = true;
    await act(async () => {
      const tab = new window.KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });
      searchInput.dispatchEvent(tab);
      prevented = tab.defaultPrevented;
    });

    expect(prevented).toBe(false);
    expect(container.querySelector('.ut-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Escape and returns focus to trigger', async () => {
    const { container } = render(
      <Select options={sampleOptions} placeholder="Choose fruit" />,
    );
    const trigger = container.querySelector<HTMLButtonElement>('button.ut-select')!;
    trigger.focus();

    await act(async () => {
      trigger.click();
    });
    expect(container.querySelector('.ut-menu')).toBeTruthy();

    await act(async () => {
      trigger.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });

    expect(container.querySelector('.ut-menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Tab without preventing default to avoid trapping focus', async () => {
    const { container } = render(
      <Select options={sampleOptions} placeholder="Choose fruit" />,
    );
    const trigger = container.querySelector<HTMLButtonElement>('button.ut-select')!;

    await act(async () => {
      trigger.click();
    });
    expect(container.querySelector('.ut-menu')).toBeTruthy();

    let tabPrevented = false;
    await act(async () => {
      const tabEvent = new window.KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });
      trigger.dispatchEvent(tabEvent);
      tabPrevented = tabEvent.defaultPrevented;
    });

    expect(tabPrevented).toBe(false);
    expect(container.querySelector('.ut-menu')).toBeNull();
  });

  it('closes when clicking outside without changing value', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <div>
        <Select options={sampleOptions} value="apple" onChange={onChange} />
        <button id="outside-btn">Outside</button>
      </div>,
    );

    const trigger = container.querySelector<HTMLButtonElement>('button.ut-select')!;
    await act(async () => {
      trigger.click();
    });
    expect(container.querySelector('.ut-menu')).toBeTruthy();

    await act(async () => {
      document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });

    expect(container.querySelector('.ut-menu')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger.textContent).toContain('Apple');
  });

  it('supports keyboard navigation (ArrowDown, ArrowUp, Home, End, Enter)', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <Select options={sampleOptions} onChange={onChange} />,
    );
    const trigger = container.querySelector<HTMLButtonElement>('button.ut-select')!;

    // Enter opens menu
    await act(async () => {
      trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(container.querySelector('.ut-menu')).toBeTruthy();

    // ArrowDown moves down (Apple -> Banana)
    await act(async () => {
      trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const options = container.querySelectorAll('.ut-option');
    expect(options[1]?.getAttribute('data-active')).toBe('true');

    // ArrowDown moves down (Banana -> Cherry)
    await act(async () => {
      trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(options[2]?.getAttribute('data-active')).toBe('true');

    // ArrowDown skips disabled 'Date' -> Elderberry (index 4)
    await act(async () => {
      trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(options[4]?.getAttribute('data-active')).toBe('true');

    // Home jumps to first enabled (Apple, index 0)
    await act(async () => {
      trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    expect(options[0]?.getAttribute('data-active')).toBe('true');

    // End jumps to last enabled (Elderberry, index 4)
    await act(async () => {
      trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(options[4]?.getAttribute('data-active')).toBe('true');

    // Enter chooses Elderberry
    await act(async () => {
      trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('elderberry');
    expect(container.querySelector('.ut-menu')).toBeNull();
  });

  it('supports typeahead jumping', async () => {
    const { container } = render(
      <Select options={sampleOptions} />,
    );
    const trigger = container.querySelector<HTMLButtonElement>('button.ut-select')!;

    await act(async () => {
      trigger.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    });
    expect(container.querySelector('.ut-menu')).toBeTruthy();
    const options = container.querySelectorAll('.ut-option');
    // Cherry is at index 2
    expect(options[2]?.getAttribute('data-active')).toBe('true');
  });

  it('respects disabled state on the Select and on individual options', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <Select options={sampleOptions} disabled onChange={onChange} />,
    );
    const trigger = container.querySelector<HTMLButtonElement>('button.ut-select')!;
    expect(trigger.disabled).toBe(true);

    await act(async () => {
      trigger.click();
    });
    expect(container.querySelector('.ut-menu')).toBeNull();

    // Now test disabled option inside enabled select
    const { container: enabledContainer } = render(
      <Select options={sampleOptions} onChange={onChange} />,
    );
    const enabledTrigger = enabledContainer.querySelector<HTMLButtonElement>('button.ut-select')!;
    await act(async () => {
      enabledTrigger.click();
    });

    const menu = enabledContainer.querySelector('.ut-menu')!;
    const disabledOpt = menu.querySelector('[aria-disabled="true"]')!;
    expect(disabledOpt).toBeTruthy();
    expect(disabledOpt.textContent).toContain('Date');
    expect(disabledOpt.textContent).toContain('Out of stock');

    await act(async () => {
      (disabledOpt as HTMLElement).click();
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(enabledContainer.querySelector('.ut-menu')).toBeTruthy();
  });

  it('renders sticky search input for long lists (>8 options) and filters matches', async () => {
    const onChange = vi.fn();
    const { container } = render(
      <Select options={longOptions} onChange={onChange} />,
    );
    const trigger = container.querySelector<HTMLButtonElement>('button.ut-select')!;

    await act(async () => {
      trigger.click();
    });

    const searchInput = container.querySelector<HTMLInputElement>('.ut-menu__search input')!;
    expect(searchInput).toBeTruthy();

    // Filter by typing 'tokyo'
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      (searchInput as any)._valueTracker?.setValue('');
      nativeSetter?.call(searchInput, 'tokyo');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Options should now only contain Tokyo (Asia-NE)
    const options = container.querySelectorAll<HTMLElement>('.ut-option');
    expect(options.length).toBe(1);
    expect(options[0]?.textContent).toContain('Tokyo');

    // Enter chooses first search match
    await act(async () => {
      searchInput.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    // Search query 'tokyo' matches 'asia-ne'
    expect(onChange).toHaveBeenCalledWith('asia-ne');
  });

  it('highlights the first enabled filtered option for keyboard selection', async () => {
    const onChange = vi.fn();
    const options = longOptions.map((option) =>
      option.value === 'us-east' ? { ...option, disabled: 'Plan limit' } : option,
    );
    const { container } = render(<Select options={options} onChange={onChange} />);
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.ut-select')!.click();
    });

    const searchInput = container.querySelector<HTMLInputElement>('.ut-menu__search input')!;
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      (searchInput as any)._valueTracker?.setValue('');
      nativeSetter?.call(searchInput, 'us');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const activeId = searchInput.getAttribute('aria-activedescendant')!;
    expect(document.getElementById(activeId)?.textContent).toContain('US West');

    await act(async () => {
      searchInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('us-west');
  });

  it('displays empty message when search has no matches', async () => {
    const { container } = render(
      <Select options={longOptions} />,
    );
    const trigger = container.querySelector<HTMLButtonElement>('button.ut-select')!;
    await act(async () => {
      trigger.click();
    });

    const searchInput = container.querySelector<HTMLInputElement>('.ut-menu__search input')!;
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      (searchInput as any)._valueTracker?.setValue('');
      nativeSetter?.call(searchInput, 'nonexistent');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const empty = container.querySelector('.ut-menu__empty');
    expect(empty).toBeTruthy();
    expect(empty?.textContent).toContain('No options match "nonexistent".');
  });

  it('supports multi-select with checkboxes, count chips, and clear button', async () => {
    const onChange = vi.fn();
    function Multi() {
      const [vals, setVals] = useState<string[]>(['us-east']);
      return (
        <Select
          multiple
          options={longOptions}
          value={vals}
          onChange={(next) => {
            setVals(next);
            onChange(next);
          }}
        />
      );
    }

    const { container } = render(<Multi />);
    const trigger = container.querySelector<HTMLButtonElement>('button.ut-select')!;
    expect(trigger.textContent).toContain('US East (N. Virginia)');

    await act(async () => {
      trigger.click();
    });

    const menu = container.querySelector('.ut-menu')!;
    expect(menu.classList.contains('ut-menu--multi')).toBe(true);

    // Select second option (us-west)
    const options = menu.querySelectorAll<HTMLElement>('.ut-option');
    await act(async () => {
      options[1]?.click();
    });

    expect(onChange).toHaveBeenCalledWith(['us-east', 'us-west']);
    // Menu remains open in multi-select mode
    expect(container.querySelector('.ut-menu')).toBeTruthy();

    // Trigger shows count chip +1
    expect(trigger.querySelector('.ut-select__count')?.textContent).toBe('+1');

    // Footer shows '2 selected' and Clear button
    const footer = container.querySelector('.ut-menu__footer')!;
    expect(footer.textContent).toContain('2 selected');

    const clearBtn = footer.querySelector<HTMLButtonElement>('button')!;
    await act(async () => {
      clearBtn.click();
    });
    expect(onChange).toHaveBeenCalledWith([]);
  });
});

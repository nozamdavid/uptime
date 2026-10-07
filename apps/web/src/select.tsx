import React, {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useId,
  useCallback,
  type ReactNode,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import './select.css';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  lead?: ReactNode;
  code?: string;
  meta?: ReactNode;
  group?: string;
  disabled?: boolean | string;
}

export interface SelectProps<T extends string = string> {
  id?: string;
  name?: string;
  className?: string;
  style?: CSSProperties;
  options: SelectOption<T>[];
  value?: T | T[];
  defaultValue?: T | T[];
  multiple?: boolean;
  onChange?: (value: any) => void;
  placeholder?: string;
  prefix?: string;
  /** Trigger text when a multiple select has every option chosen, e.g. "All regions". */
  allLabel?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  required?: boolean;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  lead?: ReactNode;
  autoFocus?: boolean;
}

export function Select<T extends string = string>({
  id,
  name,
  className = '',
  style,
  options,
  value,
  defaultValue,
  multiple = false,
  onChange,
  placeholder,
  prefix,
  allLabel,
  disabled = false,
  size = 'md',
  required = false,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledby,
  'aria-describedby': ariaDescribedby,
  lead: triggerLeadOverride,
  autoFocus = false,
}: SelectProps<T>) {
  const generatedId = useId();
  const selectId = id || generatedId;
  const listboxId = `${selectId}-listbox`;

  const [internalValue, setInternalValue] = useState<T | T[]>(() => {
    if (value !== undefined) return value;
    if (defaultValue !== undefined) return defaultValue;
    return multiple ? [] : ('' as T);
  });

  const currentValue = value !== undefined ? value : internalValue;

  const [isOpen, setIsOpen] = useState(false);
  const [isFlipped, setIsFlipped] = useState(false);
  const [menuMaxHeight, setMenuMaxHeight] = useState(340);
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  // True while focus sits on the trigger because of a pointer; hides the keyboard ring.
  const [pointerFocus, setPointerFocus] = useState(false);
  // Ids of external <label for> elements, so the name can be label + current value.
  const [labelIds, setLabelIds] = useState('');
  const valueId = `${selectId}-value`;

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const typeaheadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typeaheadBufferRef = useRef<string>('');

  const hasSearch = options.length > 8;

  // Filter options based on search query
  const filteredOptions = options.filter((opt) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      opt.label.toLowerCase().includes(q) ||
      (opt.code && opt.code.toLowerCase().includes(q)) ||
      opt.value.toLowerCase().includes(q)
    );
  });

  // A <label for> on a button replaces its content as the accessible name, which
  // would hide the chosen value. Reference the label and the value together.
  useLayoutEffect(() => {
    const labels = Array.from(triggerRef.current?.labels ?? []);
    labels.forEach((label, index) => {
      if (!label.id) label.id = `${selectId}-label-${index}`;
    });
    setLabelIds(labels.map((label) => label.id).join(' '));
  }, [selectId]);

  // Position and size the menu before it paints so options remain reachable.
  useLayoutEffect(() => {
    if (isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const gap = 4;
      const spaceBelow = window.innerHeight - rect.bottom - gap;
      const spaceAbove = rect.top - gap;
      const estimatedHeight = Math.min(340, options.length * 36 + 60);
      const flip = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
      setIsFlipped(flip);
      setMenuMaxHeight(Math.max(0, Math.min(340, flip ? spaceAbove : spaceBelow)));
    }
  }, [isOpen, options.length]);

  // Outside click to close
  useEffect(() => {
    if (!isOpen) return;
    const handleOutside = (event: Event) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearchQuery('');
      }
    };
    document.addEventListener('pointerdown', handleOutside);
    document.addEventListener('mousedown', handleOutside);
    return () => {
      document.removeEventListener('pointerdown', handleOutside);
      document.removeEventListener('mousedown', handleOutside);
    };
  }, [isOpen]);

  // Focus without a delayed timer that could steal focus after closing.
  useLayoutEffect(() => {
    if (isOpen && hasSearch) {
      searchInputRef.current?.focus();
    }
  }, [isOpen, hasSearch]);

  // Scroll active descendant into view
  useEffect(() => {
    if (isOpen && highlightedIndex >= 0 && menuRef.current) {
      const activeEl = menuRef.current.querySelector<HTMLElement>('[data-active="true"]');
      if (activeEl && typeof activeEl.scrollIntoView === 'function') {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [isOpen, highlightedIndex]);

  // Reset search query and highlighted index when closing
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
      setHighlightedIndex(-1);
    }
  }, [isOpen]);

  // Helper to check if an option is selected
  const isOptionSelected = useCallback(
    (optValue: T) => {
      if (multiple) {
        return Array.isArray(currentValue) && currentValue.includes(optValue);
      }
      return currentValue === optValue;
    },
    [multiple, currentValue],
  );

  // Helper to open menu and set initial highlighted index
  const openMenu = useCallback(() => {
    if (disabled) return;
    setIsOpen(true);
    let initialIndex = -1;
    if (!multiple && typeof currentValue === 'string') {
      initialIndex = filteredOptions.findIndex(
        (o) => o.value === currentValue && !o.disabled,
      );
    }
    if (initialIndex === -1) {
      initialIndex = filteredOptions.findIndex((o) => !o.disabled);
    }
    setHighlightedIndex(initialIndex);
  }, [disabled, multiple, currentValue, filteredOptions]);

  const closeMenu = useCallback(
    (returnFocusToTrigger = false) => {
      setIsOpen(false);
      setSearchQuery('');
      if (returnFocusToTrigger) {
        triggerRef.current?.focus();
      }
    },
    [],
  );

  const toggleOpen = useCallback(() => {
    if (disabled) return;
    if (isOpen) {
      closeMenu(false);
    } else {
      openMenu();
    }
  }, [disabled, isOpen, closeMenu, openMenu]);

  const handleSelect = useCallback(
    (optValue: T) => {
      if (multiple) {
        const currentArr = Array.isArray(currentValue) ? [...currentValue] : [];
        const next = currentArr.includes(optValue)
          ? currentArr.filter((v) => v !== optValue)
          : [...currentArr, optValue];
        if (value === undefined) {
          setInternalValue(next as any);
        }
        onChange?.(next as any);
      } else {
        if (value === undefined) {
          setInternalValue(optValue as any);
        }
        onChange?.(optValue as any);
        closeMenu(true);
      }
    },
    [multiple, currentValue, value, onChange, closeMenu],
  );

  const handleClear = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const empty: T[] = [];
      if (value === undefined) {
        setInternalValue(empty as any);
      }
      onChange?.(empty as any);
    },
    [value, onChange],
  );

  // Keyboard navigation
  const moveHighlight = useCallback(
    (delta: number) => {
      if (filteredOptions.length === 0) return;
      let nextIndex = highlightedIndex;
      for (let i = 0; i < filteredOptions.length; i++) {
        nextIndex = (nextIndex + delta + filteredOptions.length) % filteredOptions.length;
        if (!filteredOptions[nextIndex]?.disabled) {
          setHighlightedIndex(nextIndex);
          return;
        }
      }
    },
    [filteredOptions, highlightedIndex],
  );

  const handleTriggerKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;

      if (!isOpen) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openMenu();
          return;
        }
      }

      if (isOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeMenu(true);
          return;
        }

        if (e.key === 'Tab') {
          // Tab closes while permitting normal onward traversal (avoid trap)
          closeMenu(false);
          return;
        }

        if (e.key === 'ArrowDown') {
          e.preventDefault();
          moveHighlight(1);
          return;
        }

        if (e.key === 'ArrowUp') {
          e.preventDefault();
          moveHighlight(-1);
          return;
        }

        if (e.key === 'Home') {
          e.preventDefault();
          const first = filteredOptions.findIndex((o) => !o.disabled);
          if (first >= 0) setHighlightedIndex(first);
          return;
        }

        if (e.key === 'End') {
          e.preventDefault();
          for (let i = filteredOptions.length - 1; i >= 0; i--) {
            if (!filteredOptions[i]?.disabled) {
              setHighlightedIndex(i);
              break;
            }
          }
          return;
        }

        if (e.key === 'Enter' || (!hasSearch && e.key === ' ')) {
          e.preventDefault();
          if (highlightedIndex >= 0 && filteredOptions[highlightedIndex]) {
            const opt = filteredOptions[highlightedIndex];
            if (!opt.disabled) {
              handleSelect(opt.value);
            }
          }
          return;
        }
      }

      // Typeahead when not searching
      if (!hasSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (typeaheadTimeoutRef.current) {
          clearTimeout(typeaheadTimeoutRef.current);
        }
        typeaheadBufferRef.current += e.key.toLowerCase();
        typeaheadTimeoutRef.current = setTimeout(() => {
          typeaheadBufferRef.current = '';
        }, 500);

        const searchStr = typeaheadBufferRef.current;
        const matchIndex = filteredOptions.findIndex(
          (o) => !o.disabled && o.label.toLowerCase().startsWith(searchStr),
        );
        if (matchIndex >= 0) {
          if (!isOpen) {
            openMenu();
          }
          setHighlightedIndex(matchIndex);
        }
      }
    },
    [
      disabled,
      isOpen,
      openMenu,
      closeMenu,
      moveHighlight,
      filteredOptions,
      highlightedIndex,
      hasSearch,
      handleSelect,
    ],
  );

  const handleSearchKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu(true);
        return;
      }

      if (e.key === 'Tab') {
        // The search field unmounts on close, so hand focus back to the trigger
        // first; the browser's default Tab then moves on from there.
        closeMenu(true);
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveHighlight(1);
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveHighlight(-1);
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        if (highlightedIndex >= 0 && filteredOptions[highlightedIndex]) {
          const opt = filteredOptions[highlightedIndex];
          if (!opt.disabled) {
            handleSelect(opt.value);
          }
        }
        return;
      }
    },
    [closeMenu, moveHighlight, highlightedIndex, filteredOptions, handleSelect],
  );

  // Compute trigger content
  let leadContent: ReactNode = triggerLeadOverride;
  let displayValue: ReactNode = null;
  let countChip: ReactNode = null;

  if (multiple) {
    const selectedVals = Array.isArray(currentValue) ? currentValue : [];
    if (selectedVals.length === 0) {
      displayValue = <span className="ut-select__placeholder">{placeholder || 'Select…'}</span>;
    } else if (selectedVals.length === options.length && options.length > 0) {
      displayValue = allLabel ?? `${selectedVals.length} selected`;
    } else {
      const firstOpt = options.find((o) => o.value === selectedVals[0]);
      displayValue = firstOpt ? firstOpt.label : selectedVals[0];
      if (firstOpt && !leadContent) {
        if (firstOpt.lead) leadContent = firstOpt.lead;
        else if (firstOpt.code) leadContent = <span className="ut-option__code">{firstOpt.code}</span>;
      }
      if (selectedVals.length > 1) {
        countChip = (
          <span className="ut-select__count" aria-hidden="true">
            +{selectedVals.length - 1}
          </span>
        );
      }
    }
  } else {
    const selectedOpt = options.find((o) => o.value === currentValue);
    if (selectedOpt && (selectedOpt.value !== '' || selectedOpt.label)) {
      displayValue = selectedOpt.label;
      if (!leadContent) {
        if (selectedOpt.lead) leadContent = selectedOpt.lead;
        else if (selectedOpt.code) leadContent = <span className="ut-option__code">{selectedOpt.code}</span>;
      }
    } else {
      displayValue = (
        <span className="ut-select__placeholder">
          {placeholder || (selectedOpt ? selectedOpt.label : 'Select…')}
        </span>
      );
    }
  }

  // Grouping options for menu
  const hasGroups = filteredOptions.some((o) => Boolean(o.group));
  const groups: { name?: string | undefined; items: { opt: SelectOption<T>; flatIndex: number }[] }[] = [];
  if (hasGroups) {
    const map = new Map<string, { opt: SelectOption<T>; flatIndex: number }[]>();
    filteredOptions.forEach((opt, idx) => {
      const gName = opt.group || '';
      if (!map.has(gName)) map.set(gName, []);
      map.get(gName)!.push({ opt, flatIndex: idx });
    });
    map.forEach((items, name) => {
      groups.push({ name: name || undefined, items });
    });
  } else {
    groups.push({
      items: filteredOptions.map((opt, idx) => ({ opt, flatIndex: idx })),
    });
  }

  const selectedCount = multiple && Array.isArray(currentValue) ? currentValue.length : 0;

  // Name = label (or aria-label) followed by the current value. Without a label the
  // button content (prefix + value) already names it.
  const nameSource = ariaLabelledby || (ariaLabel ? selectId : labelIds);
  const triggerLabelledby = nameSource ? `${nameSource} ${valueId}` : undefined;

  return (
    <div
      ref={containerRef}
      className={`ut-popover-anchor ${className}`}
      style={style}
    >
      <button
        ref={triggerRef}
        type="button"
        id={selectId}
        className={`ut-select ${size === 'sm' ? 'ut-select--sm' : ''} ${isOpen ? 'is-open' : ''}`}
        // Select-only combobox: aria-activedescendant is not valid on a plain button.
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        // With a search field, focus (and the active option) lives on that input.
        aria-activedescendant={
          isOpen && !hasSearch && highlightedIndex >= 0
            ? `${listboxId}-opt-${highlightedIndex}`
            : undefined
        }
        aria-labelledby={triggerLabelledby}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedby}
        aria-required={required ? 'true' : undefined}
        data-pointer-focus={pointerFocus ? 'true' : undefined}
        disabled={disabled}
        autoFocus={autoFocus}
        onPointerDown={() => setPointerFocus(true)}
        onBlur={() => setPointerFocus(false)}
        onClick={toggleOpen}
        onKeyDown={(e) => {
          setPointerFocus(false);
          handleTriggerKeyDown(e);
        }}
      >
        {leadContent && <span className="ut-select__lead">{leadContent}</span>}
        {prefix && <span className="ut-select__prefix">{prefix}</span>}
        <span className="ut-select__value" id={valueId}>
          {displayValue}
        </span>
        {countChip}
        <svg
          className="ut-select__chevron"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m5 6 3-3 3 3M5 10l3 3 3-3" />
        </svg>
      </button>

      {/* Submits the chosen value(s) with an enclosing form. */}
      {name &&
        !disabled &&
        (multiple ? (Array.isArray(currentValue) ? currentValue : []) : [currentValue]).map(
          (v) => <input key={String(v)} type="hidden" name={name} value={String(v)} />,
        )}

      {/* Open listbox menu */}
      {isOpen && (
        <div
          ref={menuRef}
          id={listboxId}
          role="listbox"
          aria-multiselectable={multiple ? 'true' : undefined}
          aria-label={ariaLabel || prefix || placeholder || 'Options'}
          // Keep focus on the trigger or search field while pointing at options,
          // so keyboard control continues after a click (multiple stays open).
          onMouseDown={(e) => {
            if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
          }}
          style={{ maxHeight: menuMaxHeight }}
          className={`ut-menu ${multiple ? 'ut-menu--multi' : 'ut-menu--single'} ${
            isFlipped ? 'ut-menu--flip' : ''
          }`}
        >
          {hasSearch && (
            <div className="ut-menu__search">
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="7" cy="7" r="5" />
                <line x1="11" y1="11" x2="15" y2="15" />
              </svg>
              <input
                ref={searchInputRef}
                type="search"
                value={searchQuery}
                placeholder="Search…"
                aria-label="Search options"
                role="combobox"
                aria-expanded="true"
                aria-controls={listboxId}
                aria-activedescendant={
                  highlightedIndex >= 0 ? `${listboxId}-opt-${highlightedIndex}` : undefined
                }
                onChange={(e) => {
                  const query = e.target.value.toLowerCase();
                  const matches = options.filter((opt) =>
                    opt.label.toLowerCase().includes(query) ||
                    opt.code?.toLowerCase().includes(query) ||
                    opt.value.toLowerCase().includes(query),
                  );
                  setSearchQuery(e.target.value);
                  setHighlightedIndex(matches.findIndex((opt) => !opt.disabled));
                }}
                onKeyDown={handleSearchKeyDown}
              />
            </div>
          )}

          {filteredOptions.length === 0 ? (
            <div className="ut-menu__empty">
              No options match "{searchQuery}".
            </div>
          ) : (
            groups.map((group, groupIdx) => (
              <React.Fragment key={group.name || `group-${groupIdx}`}>
                {group.name && (
                  <>
                    {groupIdx > 0 && <div className="ut-menu__sep" role="separator" />}
                    <div className="ut-menu__group" role="presentation">
                      {group.name}
                    </div>
                  </>
                )}
                {group.items.map(({ opt, flatIndex }) => {
                  const isSelected = isOptionSelected(opt.value);
                  const isDisabled = Boolean(opt.disabled);
                  const isHighlighted = flatIndex === highlightedIndex;
                  const disabledReason = typeof opt.disabled === 'string' ? opt.disabled : null;
                  const metaText = opt.meta || disabledReason;

                  return (
                    <div
                      key={opt.value}
                      id={`${listboxId}-opt-${flatIndex}`}
                      role="option"
                      aria-selected={isSelected}
                      aria-disabled={isDisabled ? 'true' : undefined}
                      data-active={isHighlighted ? 'true' : undefined}
                      className={`ut-option ${isHighlighted ? 'is-hover' : ''}`}
                      onClick={() => {
                        if (!isDisabled) {
                          // Pointer pick: focus returns to the trigger by script and
                          // must not paint the keyboard ring (search input hands over
                          // its :focus-visible state).
                          setPointerFocus(true);
                          handleSelect(opt.value);
                        }
                      }}
                      onMouseEnter={() => {
                        if (!isDisabled) {
                          setHighlightedIndex(flatIndex);
                        }
                      }}
                    >
                      {multiple && (
                        <span
                          className={`ut-checkbox ${isSelected ? 'is-checked' : ''}`}
                          aria-hidden="true"
                        >
                          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor">
                            <polyline points="3 8 7 12 13 4" />
                          </svg>
                        </span>
                      )}

                      {opt.code && <span className="ut-option__code">{opt.code}</span>}
                      {opt.lead && <span className="ut-select__lead">{opt.lead}</span>}
                      <span className="ut-option__label">{opt.label}</span>
                      {metaText && <span className="ut-option__meta">{metaText}</span>}

                      {!multiple && (
                        <span className="ut-option__check" aria-hidden="true">
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="3 8 7 12 13 4" />
                          </svg>
                        </span>
                      )}
                    </div>
                  );
                })}
              </React.Fragment>
            ))
          )}

          {multiple && (
            <div className="ut-menu__footer">
              <span>{selectedCount} selected</span>
              <button
                type="button"
                className="button button--quiet ut-btn ut-btn--quiet ut-btn--sm"
                onClick={handleClear}
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

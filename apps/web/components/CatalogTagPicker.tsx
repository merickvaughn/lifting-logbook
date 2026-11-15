'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { LIFT_CATALOG } from '@lifting-logbook/core';
import styles from './CatalogTagPicker.module.css';

interface Props {
  id?: string;
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  /**
   * What the search offers; defaults to the catalog's lift names. A value outside it (a
   * legacy free-text muscle tag, say) still shows as a chip and can be removed.
   */
  options?: readonly string[];
  placeholder?: string;
}

const CATALOG_NAMES = LIFT_CATALOG.map((l) => l.name);

export default function CatalogTagPicker({
  id,
  value,
  onChange,
  disabled,
  options = CATALOG_NAMES,
  placeholder = 'Search lifts…',
}: Props) {
  const [query, setQuery] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const filtered = options.filter(
    (name) =>
      !value.includes(name) &&
      name.toLowerCase().includes(query.toLowerCase()),
  );
  const open = query.trim() !== '' && filtered.length > 0;

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, []);

  function select(name: string) {
    onChange([...value, name]);
    setQuery('');
  }

  function remove(name: string) {
    onChange(value.filter((v) => v !== name));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' && filtered.length > 0) {
      e.preventDefault();
      select(filtered[0]);
    } else if (e.key === 'Escape') {
      setQuery('');
    }
  }

  return (
    <div ref={wrapperRef} className={styles.wrapper}>
      <div className={styles.chipList}>
        {value.map((name) => (
          <span key={name} className={styles.chip}>
            {name}
            <button
              type="button"
              className={styles.chipRemove}
              aria-label={`Remove ${name}`}
              onClick={() => remove(name)}
              disabled={disabled}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id={id}
          className={styles.textInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={value.length === 0 ? placeholder : ''}
          disabled={disabled}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
        />
      </div>
      {open && (
        <ul id={listboxId} className={styles.dropdown} role="listbox">
          {filtered.map((name) => (
            <li key={name}>
              <button
                type="button"
                className={styles.option}
                role="option"
                aria-selected={false}
                onMouseDown={(e) => {
                  e.preventDefault(); // prevent input blur before select fires
                  select(name);
                }}
              >
                {name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

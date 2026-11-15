import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type KeyboardEvent } from 'react';
import { api } from '../api.js';
import type { Person } from '../types.js';
import { cx, TextInput } from './ui.js';

/** Who an ID names. Names change rarely, so one lookup serves the whole visit. */
export function usePerson(id: string | null | undefined) {
  return useQuery({ queryKey: ['person', id], queryFn: () => api.person(id!), enabled: Boolean(id), staleTime: 60 * 60_000 });
}

/** The name of a person or agent that a record or its history names. */
export function PersonName({ id }: { id: string }) {
  const person = usePerson(id);
  if (person.isPending) return <span className="text-faint">…</span>;
  if (!person.data) return <span className="text-faint">Someone</span>;
  const gone = person.data.active ? undefined : person.data.kind === 'agent' ? 'This agent is disabled' : 'No longer here';
  return (
    <span className={cx(gone && 'text-muted')} title={gone}>
      {person.data.name}
    </span>
  );
}

/**
 * Picks a colleague for a person field: type part of a name or email, then choose with the mouse
 * or the arrow keys and Enter. Shows the chosen person's name when not searching.
 */
export function PersonPicker({ id, value, onChange }: { id: string; value: string | null; onChange: (value: string | null) => void }) {
  const listId = useId();
  const client = useQueryClient();
  const [text, setText] = useState<string | null>(null); // null: not searching
  const [active, setActive] = useState(0);
  const chosen = usePerson(value);
  const term = text?.trim() ?? '';
  const results = useQuery({ queryKey: ['people-search', term], queryFn: () => api.searchPeople(term), enabled: term.length >= 2, staleTime: 30_000 });
  const open = text !== null && term.length >= 2;
  const options = open ? (results.data ?? []) : [];

  const choose = (person: Person) => {
    client.setQueryData(['person', person.id], person); // the name is known: no need to look it up again
    onChange(person.id);
    setText(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && text !== null) {
      event.preventDefault();
      setText(null);
    }
    if (!options.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (event.key === 'ArrowDown' ? Math.min(i + 1, options.length - 1) : Math.max(i - 1, 0)));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(options[Math.min(active, options.length - 1)]!);
    }
  };

  return (
    <div className="relative">
      <TextInput
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={options.length > 0}
        aria-controls={listId}
        aria-activedescendant={options.length ? `${listId}-${Math.min(active, options.length - 1)}` : undefined}
        autoComplete="off"
        placeholder="Search by name or email"
        value={text ?? (value ? (chosen.data?.name ?? '') : '')}
        onChange={(event) => {
          setText(event.target.value);
          setActive(0);
          if (!event.target.value.trim()) onChange(null);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setText(null)}
      />
      <ul id={listId} role="listbox" aria-label="People" className={cx('absolute z-10 mt-1 w-full list-none overflow-auto rounded-md border border-line bg-surface p-1 shadow-raised', options.length ? 'grid max-h-64 gap-0.5' : 'hidden')}>
        {options.map((person, i) => (
          <li
            key={person.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            className={cx('cursor-pointer rounded-sm px-2 py-1.5', i === active && 'bg-accent-soft')}
            onMouseDown={(event) => {
              event.preventDefault(); // keep focus in the input until the choice is made
              choose(person);
            }}
            onMouseEnter={() => setActive(i)}
          >
            <span className="font-medium">{person.name}</span>
            {person.email ? <span className="ml-2 text-sm text-muted">{person.email}</span> : null}
          </li>
        ))}
      </ul>
      {open && !options.length ? (
        <p className="absolute z-10 m-0 mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-muted shadow-raised" role="status">
          {results.isFetching ? 'Searching…' : 'Nobody matches'}
        </p>
      ) : null}
    </div>
  );
}

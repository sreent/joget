import { useQuery } from '@tanstack/react-query';
import { createContext, Fragment, useContext, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, type AppAt } from '../api.js';
import { atRoute, Link } from '../router.js';
import type { RecordOut, RecordValue, UiEntity, UiField } from '../types.js';
import { Button, cx, TextInput } from './ui.js';

/** The app whose records values name, the entities the person may read, and the titles the screen knows. */
interface Titles {
  readonly at: AppAt;
  readonly entities: Readonly<Record<string, UiEntity>>;
  readonly titles: Readonly<Record<string, string>>;
  remember(id: string, title: string): void;
}

const TitlesContext = createContext<Titles | null>(null);

/**
 * Gives the screens below it the titles of the records their values name: those the server sent
 * with the records, and those the person picks. A provider inside another adds to its titles.
 */
export function TitlesProvider({ at, entities, known, children }: { at?: AppAt; entities?: Readonly<Record<string, UiEntity>>; known?: Readonly<Record<string, string>>; children: ReactNode }) {
  const parent = useContext(TitlesContext);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const here = at ?? parent?.at;
  if (!here) return <>{children}</>;
  const value: Titles = {
    at: here,
    entities: entities ?? parent?.entities ?? {},
    titles: { ...parent?.titles, ...known, ...picked },
    remember: (id, title) => (parent ? parent.remember(id, title) : setPicked((all) => ({ ...all, [id]: title }))),
  };
  return <TitlesContext.Provider value={value}>{children}</TitlesContext.Provider>;
}

/** The titles of every record in a list of records, by ID. */
export const titlesOf = (records: readonly RecordOut[]): Record<string, string> => Object.assign({}, ...records.map((record) => record.titles ?? {}));

/** A record's title as text: a choice's label, a list joined. */
function titleText(field: UiField | undefined, value: RecordValue | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const label = (v: string) => field?.options?.find((option) => option.value === v)?.label ?? v;
  return Array.isArray(value) ? value.map((v) => label(String(v))).join(', ') : label(String(value));
}

/** A record a value names, by its title, as a link that opens it. */
export function RecordTitle({ entity, id, link = true }: { entity: string; id: string; link?: boolean }) {
  const known = useContext(TitlesContext);
  const title = known?.titles[id];
  const about = known?.entities[entity];
  // Its title isn't known here: it's hidden from the person, or the record no longer holds it.
  if (!title) return <span className="text-faint">{about ? `A ${about.label.toLowerCase()}` : 'A record'}</span>;
  if (!link || !known || !about) return <span>{title}</span>;
  return <Link to={{ name: 'use', ...atRoute(known.at), page: entity, recordId: id }}>{title}</Link>;
}

/** The records a reference names, one or several, by their titles. */
export function RecordTitles({ entity, value, link = true }: { entity: string; value: RecordValue | undefined; link?: boolean }) {
  const ids = Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : typeof value === 'string' && value ? [value] : [];
  if (!ids.length) return <>—</>;
  return (
    <>
      {ids.map((id, i) => (
        <Fragment key={id}>
          {i ? ', ' : null}
          <RecordTitle entity={entity} id={id} link={link} />
        </Fragment>
      ))}
    </>
  );
}

/**
 * Picks the record a reference names, or several: type part of a title, then choose with the mouse
 * or the arrow keys and Enter. The records offered are those the person may read. Several show as
 * chips, each with a button that takes it out; Backspace in the empty search takes out the last.
 */
export function RecordPicker({
  id,
  entity,
  multiple = false,
  value,
  onChange,
  label,
}: {
  id: string;
  entity: string;
  multiple?: boolean | undefined;
  value: RecordValue | undefined;
  onChange: (value: string | string[] | null) => void;
  label?: string | undefined;
}) {
  const known = useContext(TitlesContext);
  const listId = useId();
  const [text, setText] = useState<string | null>(null); // null: not searching
  const [active, setActive] = useState(0);
  const about = known?.entities[entity];
  const titleField = about?.titleField ?? null;
  const term = text?.trim() ?? '';
  const results = useQuery({
    queryKey: ['record-search', known?.at.id, known?.at.env, entity, term],
    queryFn: () => api.searchRecords(known!.at, entity, term),
    enabled: Boolean(known && titleField && term.length >= 1),
    staleTime: 30_000,
  });
  const chosen = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : typeof value === 'string' && value ? [value] : [];
  const open = text !== null && term.length >= 1;
  const options = open ? (results.data?.records ?? []).filter((record) => !multiple || !chosen.includes(record.id)) : [];
  const titleOf = (record: RecordOut) => (titleField ? titleText(about?.fields.find((field) => field.name === titleField), record.values?.[titleField]) : '') || record.id;
  const named = (recordId: string) => known?.titles[recordId] ?? `A ${about?.label.toLowerCase() ?? 'record'}`;

  // Records the person can't read can't be picked: show what the value holds, and nothing to search.
  if (!known || !about || !titleField) {
    return (
      <p id={id} className="m-0 text-sm text-muted">
        {chosen.length ? <RecordTitles entity={entity} value={value} link={false} /> : 'You can\'t pick these records.'}
      </p>
    );
  }

  const choose = (record: RecordOut) => {
    known.remember(record.id, titleOf(record));
    onChange(multiple ? [...chosen, record.id] : record.id);
    setText(multiple ? '' : null);
    setActive(0);
  };
  const remove = (recordId: string) => onChange(chosen.filter((c) => c !== recordId).length ? chosen.filter((c) => c !== recordId) : null);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && text !== null) {
      event.preventDefault();
      setText(null);
    }
    if (multiple && event.key === 'Backspace' && !text && chosen.length) remove(chosen.at(-1)!);
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
    <div className="grid gap-1.5">
      {multiple && chosen.length ? (
        <ul aria-label={`${label ?? about.pluralLabel}: chosen`} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {chosen.map((recordId) => (
            <li key={recordId} className="flex items-center gap-1 rounded-full border border-line-strong bg-sunken py-0.5 pr-1 pl-3 text-sm">
              <RecordTitle entity={entity} id={recordId} link={false} />
              <Button size="sm" variant="ghost" aria-label={`Take out ${named(recordId)}`} onClick={() => remove(recordId)}>
                ✕
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="relative">
        <TextInput
          id={id}
          {...(label ? { 'aria-label': label } : {})}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={options.length > 0}
          aria-controls={listId}
          aria-activedescendant={options.length ? `${listId}-${Math.min(active, options.length - 1)}` : undefined}
          autoComplete="off"
          placeholder={multiple ? `Add ${about.pluralLabel.toLowerCase()}: search by ${about.fields.find((field) => field.name === titleField)?.label.toLowerCase() ?? 'title'}` : `Search ${about.pluralLabel.toLowerCase()}`}
          value={text ?? (!multiple && chosen[0] ? named(chosen[0]) : '')}
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
            if (!multiple && !event.target.value.trim()) onChange(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setText(null)}
        />
        <ul id={listId} role="listbox" aria-label={`${about.pluralLabel} that match`} className={cx('absolute z-10 mt-1 w-full list-none overflow-auto rounded-md border border-line bg-surface p-1 shadow-raised', options.length ? 'grid max-h-64 gap-0.5' : 'hidden')}>
          {options.map((record, i) => (
            <li
              key={record.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={cx('cursor-pointer rounded-sm px-2 py-1.5', i === active && 'bg-accent-soft')}
              onMouseDown={(event) => {
                event.preventDefault(); // keep focus in the input until the choice is made
                choose(record);
              }}
              onMouseEnter={() => setActive(i)}
            >
              {titleOf(record)}
            </li>
          ))}
        </ul>
        {open && !options.length ? (
          <p className="absolute z-10 m-0 mt-1 w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-muted shadow-raised" role="status">
            {results.isFetching ? 'Searching…' : `No ${about.pluralLabel.toLowerCase()} match`}
          </p>
        ) : null}
      </div>
    </div>
  );
}

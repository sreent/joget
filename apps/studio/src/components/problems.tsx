import { createContext, useContext } from 'react';
import { Link, type BuildTab } from '../router.js';
import type { Definition, Issue } from '../types.js';
import { Card, cx } from './ui.js';

/**
 * The draft's problems, as the checks find them while someone builds: the same checks the server
 * runs when the draft is saved, run in the browser on each change.
 */
export const ProblemsContext = createContext<readonly Issue[]>([]);
export const useProblems = (): readonly Issue[] => useContext(ProblemsContext);

/** The designer each part of a definition is built in. */
const TABS: Readonly<Record<string, BuildTab>> = {
  entities: 'data',
  forms: 'forms',
  pages: 'pages',
  navigation: 'menu',
  rules: 'rules',
  actions: 'actions',
  queries: 'queries',
  cards: 'cards',
  roles: 'roles',
  flows: 'flows',
  connections: 'connections',
  webhooks: 'webhooks',
};

/** Where a problem is, in words, and the designer that opens it there. */
export function placeOf(definition: Definition, path: string): { readonly label: string; readonly tab?: BuildTab; readonly item?: string } {
  const [part, name] = path.split(/[.[]/);
  const tab = part ? TABS[part] : undefined;
  if (!tab || !name) return { label: 'The app' };
  const named = (definition as unknown as Record<string, Record<string, { label?: string }> | undefined>)[part!]?.[name];
  const label = named?.label ?? name;
  return { label: `${tab === 'data' ? 'Data' : tab[0]!.toUpperCase() + tab.slice(1)}: ${label}`, tab, ...(tab === 'flows' ? { item: name } : {}) };
}

/** A badge that says how many problems the draft has, as a button that opens them; or that it has none. */
export function ProblemsBadge({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  const base = 'inline-flex items-center rounded-full px-2 py-px text-xs font-semibold whitespace-nowrap';
  if (!count) return <span className={cx(base, 'bg-good-bg text-good')}>No problems</span>;
  return (
    <button type="button" className={cx(base, 'cursor-pointer border-0 bg-bad-bg text-bad')} aria-expanded={open} onClick={onToggle}>
      {count === 1 ? '1 problem' : `${count} problems`}
    </button>
  );
}

/** The draft's problems, each with where it is: a link opens the designer there. */
export function ProblemsList({ appId, definition, problems }: { appId: string; definition: Definition; problems: readonly Issue[] }) {
  return (
    <Card aria-label="Problems" className="grid gap-2 p-4">
      <h2 className="m-0 text-sm font-semibold text-muted">Problems to put right before it saves</h2>
      <ul className="m-0 grid list-none gap-1.5 p-0 text-sm">
        {problems.map((problem, i) => {
          const place = placeOf(definition, problem.path);
          return (
            <li key={i} className="grid gap-0.5">
              <span className="font-medium">{problem.message}</span>
              <span className="text-xs text-muted">
                {place.tab ? <Link to={{ name: 'build', appId, tab: place.tab, ...(place.item ? { item: place.item } : {}) }}>{place.label}</Link> : place.label}{' '}
                <code className="text-faint">{problem.path}</code>
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

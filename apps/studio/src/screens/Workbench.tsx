import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../api.js';
import { Icon, type IconName } from '../components/icon.js';
import { Link, type Route } from '../router.js';
import type { Me } from '../types.js';

/**
 * Where people build, as Ocean's workbench: the whole window, with a3t's pages shrunk to the rail
 * on the left and the work beside it. On a phone, the rail is a row of icons above the work.
 */
export function Workbench({ me, children }: { me: Me; children: ReactNode }) {
  const tasks = useQuery({ queryKey: ['tasks', 'open'], queryFn: () => api.tasks('open'), refetchInterval: 60_000 });
  const unread = useQuery({ queryKey: ['notices', 'unread'], queryFn: api.unreadNotices, refetchInterval: 60_000 });
  const name = me.displayName ?? me.email ?? 'You';
  return (
    <div className="wb window">
      <aside className="wb-rail">
        <Link to={{ name: 'home' }} className="brand p-0 no-underline" aria-label="a3t, your apps">
          <span aria-hidden className="mark">
            a3
          </span>
        </Link>
        <nav aria-label="a3t's pages">
          {/* The app on the workbench is one of the person's apps. */}
          <RailLink to={{ name: 'home' }} icon="book" label="Your apps" current />
          <RailLink to={{ name: 'tasks' }} icon="tasks" label="Tasks" count={tasks.data?.tasks.length ?? 0} counted="waiting" />
          <RailLink to={{ name: 'notices' }} icon="bell" label="Notices" count={unread.data?.unread ?? 0} counted="unread" />
        </nav>
        <span className="avatar" role="img" aria-label={name} title={name}>
          {initials(name)}
        </span>
      </aside>
      <main className="wb-main">{children}</main>
    </div>
  );
}

/** A page on the rail: its icon, and on its corner how many wait there. Its name says the count too. */
function RailLink({
  to,
  icon,
  label,
  current,
  count = 0,
  counted,
}: {
  to: Route;
  icon: IconName;
  label: string;
  current?: boolean;
  count?: number;
  counted?: string;
}) {
  return (
    <Link
      to={to}
      aria-label={count ? `${label}, ${count} ${counted}` : label}
      title={label}
      aria-current={current ? 'page' : undefined}
      className="no-underline"
    >
      <Icon name={icon} />
      {count ? (
        <span className="nav-count" aria-hidden>
          {count > 99 ? '99+' : count}
        </span>
      ) : null}
    </Link>
  );
}

/** A person's initials, for the rail's foot: the first letters of the first two words of their name. */
function initials(name: string): string {
  const words = name.split(/[\s@._-]+/).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((word) => word[0]!.toUpperCase())
      .join('') || '?'
  );
}

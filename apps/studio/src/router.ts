import { createElement, useSyncExternalStore, type AnchorHTMLAttributes, type ReactNode } from 'react';

/**
 * The studio's pages. Building needs `app.read`; using an app needs only `app.run`. A team app has
 * delivery tabs too: its change requests, and its releases and environments.
 */
export type BuildTab = 'delivery' | 'changes' | 'data' | 'forms' | 'rules' | 'actions' | 'queries' | 'cards' | 'roles' | 'share' | 'history' | 'advanced';
export type Route =
  | { readonly name: 'home' }
  | { readonly name: 'build'; readonly appId: string; readonly tab: BuildTab }
  | { readonly name: 'change'; readonly changeRequestId: string }
  /** `env` picks a team app's environment: `staging`, or a preview's environment ID. Prod by default. */
  | { readonly name: 'use'; readonly appId: string; readonly page?: string; readonly recordId?: string; readonly env?: string };

const BASE = '/studio';
const TABS: readonly BuildTab[] = ['delivery', 'changes', 'data', 'forms', 'rules', 'actions', 'queries', 'cards', 'roles', 'share', 'history', 'advanced'];

export function parse(pathname: string, search = ''): Route {
  const parts = pathname.replace(/^\/studio\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'changes' && parts[1]) return { name: 'change', changeRequestId: parts[1] };
  if (parts[0] !== 'apps' || !parts[1]) return { name: 'home' };
  const appId = parts[1];
  if (parts[2] === 'build') {
    const tab = TABS.includes(parts[3] as BuildTab) ? (parts[3] as BuildTab) : 'data';
    return { name: 'build', appId, tab };
  }
  const env = new URLSearchParams(search).get('env');
  return { name: 'use', appId, ...(parts[2] ? { page: parts[2] } : {}), ...(parts[3] ? { recordId: parts[3] } : {}), ...(env ? { env } : {}) };
}

export function href(route: Route): string {
  switch (route.name) {
    case 'home':
      return `${BASE}/`;
    case 'build':
      return `${BASE}/apps/${encodeURIComponent(route.appId)}/build/${route.tab}`;
    case 'change':
      return `${BASE}/changes/${encodeURIComponent(route.changeRequestId)}`;
    case 'use': {
      const path = [`${BASE}/apps/${encodeURIComponent(route.appId)}`, route.page, route.recordId].filter(Boolean).map((p, i) => (i ? encodeURIComponent(p!) : p)).join('/');
      return route.env ? `${path}?env=${encodeURIComponent(route.env)}` : path;
    }
  }
}

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

export function navigate(route: Route): void {
  window.history.pushState(null, '', href(route));
  for (const listener of listeners) listener();
}

export function useRoute(): Route {
  const location = useSyncExternalStore(subscribe, () => window.location.pathname + window.location.search);
  const query = location.indexOf('?');
  return query === -1 ? parse(location) : parse(location.slice(0, query), location.slice(query));
}

/** A link within the studio, without a page load. */
export function Link({ to, children, ...rest }: { to: Route; children: ReactNode } & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return createElement(
    'a',
    {
      ...rest,
      href: href(to),
      onClick: (event: MouseEvent) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      },
    },
    children,
  );
}

/** The parts of a `use` route that name an app in one of its environments. */
export const atRoute = (at: { readonly id: string; readonly env?: string | undefined }): { appId: string; env?: string } => ({
  appId: at.id,
  ...(at.env ? { env: at.env } : {}),
});

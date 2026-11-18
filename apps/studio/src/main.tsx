import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api.js';
import { Link, useRoute } from './router.js';
import { Builder } from './screens/Builder.js';
import { ChangeRequestPage } from './screens/Delivery.js';
import { Home } from './screens/Home.js';
import { NoticeCount, Notices } from './screens/Notices.js';
import { TaskCount, Tasks } from './screens/Tasks.js';
import { Use } from './screens/Use.js';
import './styles.css';

const queries = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

function App() {
  const route = useRoute();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  return (
    <div className="min-h-screen">
      {/* The family's frame names the product by its name and its mark, as Ocean's Shell does: a3t, a3. */}
      <header className="sticky top-0 z-10 block border-b border-line bg-surface/95 p-0 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4">
          <Link to={{ name: 'home' }} className="brand p-0 no-underline" aria-label="a3t, your apps">
            <span aria-hidden className="mark">
              a3
            </span>
            a3t
          </Link>
          <span className="flex-1" />
          {me.data ? <NoticeCount /> : null}
          {me.data ? <TaskCount /> : null}
          {me.data ? <span className="text-sm text-muted">{me.data.displayName ?? me.data.email}</span> : null}
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 has-[[data-wide]]:max-w-[110rem]">
        {me.isError ? (
          <p className="text-bad">a3t can't be reached right now.</p>
        ) : !me.data ? null : route.name === 'home' ? (
          <Home me={me.data} />
        ) : route.name === 'tasks' ? (
          <Tasks />
        ) : route.name === 'notices' ? (
          <Notices />
        ) : route.name === 'build' ? (
          <Builder appId={route.appId} tab={route.tab} {...(route.item ? { item: route.item } : {})} />
        ) : route.name === 'change' ? (
          <ChangeRequestPage id={route.changeRequestId} me={me.data} />
        ) : (
          <Use
            appId={route.appId}
            {...(route.env ? { env: route.env } : {})}
            {...(route.appPage ? { appPage: route.appPage } : {})}
            {...(route.page ? { page: route.page } : {})}
            {...(route.recordId ? { recordId: route.recordId } : {})}
          />
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queries}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

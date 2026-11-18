import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, type AppAt } from '../api.js';
import { ChartCard, StatTile } from '../components/charts.js';
import { FilesProvider } from '../components/files.js';
import { filledLines, LinesChangeView, LinesEditor, LinesTable, rollupValue } from '../components/lines.js';
import { PersonName } from '../components/people.js';
import { Badge, Button, Card, cx, EmptyState, Notice } from '../components/ui.js';
import { asLines, display, ValueInput, ValueView } from '../components/values.js';
import { atRoute, Link, navigate, type Route } from '../router.js';
import { MovedNotice } from './BuilderPanels.js';
import { ProcessCard } from './Tasks.js';
import { holdsOn } from '@platform/app-model';
import { Icon } from '../components/icon.js';
import type { HistoryEntry, Line, RecordOut, RecordValue, UiBlock, UiEntity, UiField, UiForm, UiManifest, Value } from '../types.js';

/** What the screen shows: one of the app's pages, a form, an entity's records, or one record. */
type View =
  | { readonly kind: 'page'; readonly name: string; readonly record?: string }
  | { readonly kind: 'form'; readonly name: string }
  | { readonly kind: 'list'; readonly entity: string }
  | { readonly kind: 'record'; readonly entity: string; readonly id: string }
  | { readonly kind: 'none' };

/** Where the app opens: its home page, else its first menu item, else its first list. */
function landing(manifest: UiManifest): View {
  const navigation = manifest.navigation;
  if (navigation?.home && manifest.pages[navigation.home]) return { kind: 'page', name: navigation.home };
  const first = navigation?.items.find((item) => !('heading' in item));
  if (first && 'page' in first) return { kind: 'page', name: first.page };
  if (first && 'form' in first) return { kind: 'form', name: first.form };
  if (first && 'entity' in first) return { kind: 'list', entity: first.entity };
  const entity = Object.entries(manifest.entities).find(([, e]) => e.can.read)?.[0];
  return entity ? { kind: 'list', entity } : { kind: 'none' };
}

/**
 * An app's screens, generated from what the signed-in person may use: the app's pages and menu,
 * or, without a menu of its own, its forms and lists; and records, with their history.
 */
export function Use({ appId, env, page, recordId, appPage }: { appId: string; env?: string; page?: string; recordId?: string; appPage?: string }) {
  const at: AppAt = { id: appId, ...(env ? { env } : {}) };
  const ui = useQuery({ queryKey: ['ui', appId, env], queryFn: () => api.ui(at) });
  if (ui.isError) return <Notice tone="bad">{ui.error instanceof ApiError && ui.error.status === 403 ? "This app isn't shared with you." : "This app can't be opened."}</Notice>;
  if (!ui.data) return <p className="text-muted">Loading…</p>;
  const manifest = ui.data;
  const view: View = appPage
    ? { kind: 'page', name: appPage, ...(recordId ? { record: recordId } : {}) }
    : page === 'new' && recordId
      ? { kind: 'form', name: recordId }
      : page
        ? recordId
          ? { kind: 'record', entity: page, id: recordId }
          : { kind: 'list', entity: page }
        : landing(manifest);

  return (
    <FilesProvider at={at}>
      <div className="grid gap-5 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav aria-label={manifest.app.name} className="grid content-start gap-4">
          <div>
            <h1 className="m-0 text-xl font-semibold tracking-tight">{manifest.app.name}</h1>
            <EnvironmentBadge app={manifest.app} />
            {manifest.app.access.build ? (
              <Link to={{ name: 'build', appId, tab: manifest.app.kind === 'team' ? 'delivery' : 'data' }} className="text-sm">
                {manifest.app.kind === 'team' ? 'Delivery' : 'Build this app'}
              </Link>
            ) : (
              <div className="mt-1 flex flex-wrap gap-1">{manifest.app.access.roles.map((role) => <Badge key={role}>{role}</Badge>)}</div>
            )}
          </div>
          <AppMenu at={at} manifest={manifest} view={view} />
        </nav>

        <div className="grid min-w-0 content-start gap-4">
          {manifest.app.movedTo ? <MovedNotice movedTo={manifest.app.movedTo} /> : null}
          {view.kind === 'page' ? (
            manifest.pages[view.name] ? (
              <PageView at={at} manifest={manifest} name={view.name} {...(view.record ? { record: view.record } : {})} />
            ) : (
              <EmptyState title="This page isn't here for you">It doesn't exist, or it's meant for people in other roles.</EmptyState>
            )
          ) : view.kind === 'form' && manifest.forms[view.name] ? (
            <FormRunner at={at} manifest={manifest} name={view.name} form={manifest.forms[view.name]!} />
          ) : view.kind === 'record' && manifest.entities[view.entity] ? (
            <RecordView at={at} manifest={manifest} entityName={view.entity} recordId={view.id} />
          ) : view.kind === 'list' && manifest.entities[view.entity] ? (
            <RecordList at={at} manifest={manifest} entityName={view.entity} />
          ) : (
            <EmptyState title="Nothing to see here yet">This app has nothing you can read.</EmptyState>
          )}
        </div>
      </div>
    </FilesProvider>
  );
}

/** The app's menu: its own, or every form and list the person may use. */
function AppMenu({ at, manifest, view }: { at: AppAt; manifest: UiManifest; view: View }) {
  const item = (to: Route, label: string, active: boolean, form = false) => (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'block rounded-md px-2.5 py-1.5 no-underline',
        form ? (active ? 'bg-accent font-medium text-accent-text' : 'bg-accent-soft font-medium text-accent') : active ? 'bg-sunken text-text' : 'text-muted hover:text-text',
      )}
    >
      {form ? `+ ${label}` : label}
    </Link>
  );
  const isPage = (name: string) => view.kind === 'page' && view.name === name;
  const isForm = (name: string) => view.kind === 'form' && view.name === name;
  const isList = (entity: string) => (view.kind === 'list' || view.kind === 'record') && view.entity === entity;
  if (manifest.navigation) {
    return (
      <ul className="m-0 grid list-none gap-1 p-0">
        {manifest.navigation.items.map((entry, index) => (
          <li key={index}>
            {'heading' in entry ? (
              <span className="mt-3 block px-2.5 text-xs font-semibold tracking-wide text-faint uppercase">{entry.heading}</span>
            ) : 'page' in entry ? (
              item({ name: 'use', ...atRoute(at), appPage: entry.page }, entry.label, isPage(entry.page))
            ) : 'form' in entry ? (
              item({ name: 'use', ...atRoute(at), page: 'new', recordId: entry.form }, entry.label, isForm(entry.form), true)
            ) : (
              item({ name: 'use', ...atRoute(at), page: entry.entity }, entry.label, isList(entry.entity))
            )}
          </li>
        ))}
      </ul>
    );
  }
  const forms = Object.entries(manifest.forms);
  const entities = Object.entries(manifest.entities).filter(([, e]) => e.can.read);
  return (
    <>
      {forms.length ? (
        <ul className="m-0 grid list-none gap-1 p-0">
          {forms.map(([name, form]) => (
            <li key={name}>{item({ name: 'use', ...atRoute(at), page: 'new', recordId: name }, form.label, isForm(name), true)}</li>
          ))}
        </ul>
      ) : null}
      <ul className="m-0 grid list-none gap-1 p-0">
        {entities.map(([name, entity]) => (
          <li key={name}>{item({ name: 'use', ...atRoute(at), page: name }, entity.pluralLabel, isList(name))}</li>
        ))}
      </ul>
    </>
  );
}

/** Blocks laid out: numbers side by side in a row, half-width charts two by two, everything else on its own. */
function rowsOf(blocks: readonly UiBlock[]): Array<{ kind: 'stats' | 'charts' | 'one'; blocks: UiBlock[] }> {
  const rows: Array<{ kind: 'stats' | 'charts' | 'one'; blocks: UiBlock[] }> = [];
  for (const block of blocks) {
    const kind = block.type === 'stat' ? 'stats' : block.type === 'chart' && block.width === 'half' ? 'charts' : 'one';
    const last = rows.at(-1);
    if (kind !== 'one' && last?.kind === kind) last.blocks.push(block);
    else rows.push({ kind, blocks: [block] });
  }
  return rows;
}

/** Where a block is: its page, and on a page about one record, that record. */
interface BlockAt {
  readonly at: AppAt;
  readonly manifest: UiManifest;
  readonly page: string;
  readonly record?: string | undefined;
}

/** One of the app's pages: its blocks, top to bottom. A page about one record shows that record. */
function PageView({ at, manifest, name, record }: { at: AppAt; manifest: UiManifest; name: string; record?: string }) {
  const page = manifest.pages[name]!;
  const about = page.record ? manifest.entities[page.record.entity] : undefined;
  const found = useQuery({
    queryKey: ['record', at.id, at.env, page.record?.entity, record],
    queryFn: () => api.record(at, page.record!.entity, record!),
    enabled: Boolean(about && record),
  });
  if (page.record && !record) return <EmptyState title="Open it from a list">This page is about one record: a row of a list opens it.</EmptyState>;
  if (page.record && found.isError) return <Notice tone="bad">This record isn't here for you.</Notice>;
  const title = about && found.data ? (about.titleField ? display(about.fields.find((f) => f.name === about.titleField), found.data.values?.[about.titleField]) : found.data.id) : null;
  return (
    <div className="grid gap-5">
      <div>
        {about ? <p className="m-0 text-sm text-muted">{page.label}</p> : null}
        <h2 className="m-0 text-2xl font-semibold tracking-tight">{about ? (title ?? '…') : page.label}</h2>
        {page.description ? <p className="m-0 mt-1 text-muted">{page.description}</p> : null}
      </div>
      <Blocks where={{ at, manifest, page: name, record }} blocks={page.blocks} />
    </div>
  );
}

/** Blocks laid out top to bottom: numbers side by side, half-width charts two by two. */
function Blocks({ where, blocks }: { where: BlockAt; blocks: readonly UiBlock[] }) {
  return (
    <>
      {rowsOf(blocks).map((row, r) =>
        row.kind === 'stats' ? (
          <div key={r} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {row.blocks.map((block) => (block.type === 'stat' ? <StatBlockView key={block.path} where={where} block={block} /> : null))}
          </div>
        ) : row.kind === 'charts' ? (
          <div key={r} className="grid gap-4 lg:grid-cols-2">
            {row.blocks.map((block) => (block.type === 'chart' ? <ChartBlockView key={block.path} where={where} block={block} /> : null))}
          </div>
        ) : (
          <BlockView key={r} where={where} block={row.blocks[0]!} index={r} />
        ),
      )}
    </>
  );
}

/** Tabs: one shows at a time, as a choice of views. */
function TabsBlockView({ where, block }: { where: BlockAt; block: Extract<UiBlock, { type: 'tabs' }> }) {
  const [shown, setShown] = useState(0);
  const tab = block.tabs[Math.min(shown, block.tabs.length - 1)]!;
  return (
    <div className="grid gap-4">
      <div className="modes justify-self-start" role="group" aria-label="Tabs">
        {block.tabs.map((each, t) => (
          <button key={each.label} type="button" aria-pressed={each === tab} onClick={() => setShown(t)}>
            {each.label}
          </button>
        ))}
      </div>
      <Blocks where={where} blocks={tab.blocks} />
    </div>
  );
}

/** The fields of the record a page is about, as the person may read them, and the actions that run on it in one click. */
function FieldsBlockView({ where, block }: { where: BlockAt; block: Extract<UiBlock, { type: 'fields' }> }) {
  const { at, manifest } = where;
  const client = useQueryClient();
  const entityName = manifest.pages[where.page]?.record?.entity ?? '';
  const entity = manifest.entities[entityName];
  const record = useQuery({ queryKey: ['record', at.id, at.env, entityName, where.record], queryFn: () => api.record(at, entityName, where.record!), enabled: Boolean(entity && where.record) });
  const run = useMutation({
    mutationFn: (action: string) => api.runAction(at, action, { values: {}, recordId: record.data!.id, version: record.data!.version }),
    onSuccess: () => Promise.all(['pageList', 'pageSummary', 'records', 'record', 'history'].map((key) => client.invalidateQueries({ queryKey: [key, at.id] }))),
  });
  if (!entity || !record.data) return null;
  const data = record.data;
  return (
    <Card className="grid gap-4">
      {block.title ? <h3 className="m-0 text-base font-semibold">{block.title}</h3> : null}
      <dl className="m-0 grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
        {block.fields.map((name) => {
          const field = entity.fields.find((f) => f.name === name);
          const system = SYSTEM_TIMES.has(name) ? (name === 'created_at' ? data.createdAt : data.updatedAt) : undefined;
          const person = SYSTEM_PEOPLE[name];
          if (!field && system === undefined && !person) return null;
          const lines = field?.type === 'lines';
          return (
            <div key={name} className="contents">
              <dt className={cx('text-muted', lines && 'sm:col-span-2')}>{field?.label ?? SYSTEM_LABELS[name] ?? name}</dt>
              <dd className={cx('m-0', lines && 'sm:col-span-2')}>
                {field && lines ? (
                  <LinesTable field={field} value={data.values?.[name]} masked={data.masked ?? []} />
                ) : field ? (
                  <Cell field={field} record={data} />
                ) : person ? (
                  data[person] ? <PersonName id={data[person]!} /> : '—'
                ) : system ? (
                  new Date(system).toLocaleString()
                ) : (
                  '—'
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      {block.actions.length ? (
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {block.actions.map((action) => (
            <Button key={action} variant="primary" disabled={run.isPending} onClick={() => run.mutate(action)}>
              {manifest.actions[action]?.label ?? action}
            </Button>
          ))}
        </div>
      ) : null}
      {run.error ? <Notice tone="bad">{run.error instanceof ApiError ? run.error.message : 'It failed.'}</Notice> : null}
    </Card>
  );
}

/** Where a summary stands: loading, ready, refused because the role hides what it counts, or failed. */
function summaryState(query: { isPending: boolean; isError: boolean; error: unknown }): 'loading' | 'ready' | 'refused' | 'error' {
  if (query.isPending) return 'loading';
  if (query.isError) return query.error instanceof ApiError && query.error.status === 403 ? 'refused' : 'error';
  return 'ready';
}

function StatBlockView({ where, block }: { where: BlockAt; block: Extract<UiBlock, { type: 'stat' }> }) {
  const { at, page } = where;
  const record = block.of ? where.record : undefined;
  const summary = useQuery({ queryKey: ['pageSummary', at.id, at.env, page, block.path, record], queryFn: () => api.pageSummary(at, page, block.path, record), placeholderData: keepPreviousData });
  const value = summary.data && 'value' in summary.data ? summary.data.value : undefined;
  return <StatTile label={block.label} value={value} decimals={block.decimals} state={summaryState(summary)} />;
}

function ChartBlockView({ where, block }: { where: BlockAt; block: Extract<UiBlock, { type: 'chart' }> }) {
  const { at, page } = where;
  const record = block.of ? where.record : undefined;
  const summary = useQuery({ queryKey: ['pageSummary', at.id, at.env, page, block.path, record], queryFn: () => api.pageSummary(at, page, block.path, record), placeholderData: keepPreviousData });
  const data = summary.data && 'groups' in summary.data ? summary.data : undefined;
  return <ChartCard spec={block} data={data} state={summaryState(summary)} refreshing={summary.isFetching && !summary.isPending} />;
}

/** A block on its own row: text, buttons, a list, the record's fields, tabs, or a full-width chart. */
function BlockView({ where, block, index }: { where: BlockAt; block: UiBlock; index: number }) {
  const { at, manifest } = where;
  return (
    <>
      {[block].map((block) =>
        block.type === 'stat' ? (
          <StatBlockView key={index} where={where} block={block} />
        ) : block.type === 'chart' ? (
          <ChartBlockView key={index} where={where} block={block} />
        ) : block.type === 'fields' ? (
          <FieldsBlockView key={index} where={where} block={block} />
        ) : block.type === 'tabs' ? (
          <TabsBlockView key={index} where={where} block={block} />
        ) : block.type === 'text' ? (
          block.style === 'heading' ? (
            <h3 key={index} className="m-0 text-lg font-semibold">
              {block.text}
            </h3>
          ) : block.style === 'note' ? (
            <p key={index} className="m-0 rounded-md border-l-4 border-accent bg-accent-soft px-3 py-2 text-sm whitespace-pre-line">
              {block.text}
            </p>
          ) : (
            <p key={index} className="m-0 whitespace-pre-line">
              {block.text}
            </p>
          )
        ) : block.type === 'buttons' ? (
          <div key={index} className="flex flex-wrap gap-2">
            {block.buttons.map((button, b) => {
              const to: Route = 'form' in button ? { name: 'use', ...atRoute(at), page: 'new', recordId: button.form } : { name: 'use', ...atRoute(at), appPage: button.page };
              const label = button.label ?? ('form' in button ? manifest.forms[button.form]?.label : manifest.pages[button.page]?.label) ?? '';
              return (
                <Link key={b} to={to} className="no-underline">
                  <Button variant={b === 0 ? 'primary' : 'secondary'} tabIndex={-1}>
                    {label}
                  </Button>
                </Link>
              );
            })}
          </div>
        ) : (
          <ListBlockView key={index} where={where} block={block} />
        ),
      )}
    </>
  );
}

const SYSTEM_TIMES = new Set(['created_at', 'updated_at']);
const SYSTEM_LABELS: Readonly<Record<string, string>> = { created_at: 'Created', updated_at: 'Last changed', owner: 'Owner', created_by: 'Created by', updated_by: 'Changed by' };
const SYSTEM_PEOPLE: Readonly<Record<string, 'owner' | 'createdBy' | 'updatedBy'>> = { owner: 'owner', created_by: 'createdBy', updated_by: 'updatedBy' };

/** A list on a page: its records under the person's own permissions, with more on request, and its row actions. */
function ListBlockView({ where, block }: { where: BlockAt; block: Extract<UiBlock, { type: 'list' }> }) {
  const { at, manifest, page } = where;
  const client = useQueryClient();
  const entity = manifest.entities[block.entity];
  // On a page about one record, a list of the records that refer to it.
  const about = block.of ? where.record : undefined;
  const rows = useInfiniteQuery({
    queryKey: ['pageList', at.id, at.env, page, block.path, about],
    queryFn: ({ pageParam }) => api.pageRecords(at, page, block.path, pageParam, about),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const run = useMutation({
    mutationFn: ({ action, record }: { action: string; record: RecordOut }) => api.runAction(at, action, { values: {}, recordId: record.id, version: record.version }),
    onSuccess: () => Promise.all(['pageList', 'records', 'record', 'history'].map((key) => client.invalidateQueries({ queryKey: [key, at.id] }))),
  });
  const records = rows.data?.pages.flatMap((p) => p.records) ?? [];
  /** Where a row goes: the page about one record that the list names, or the record's own screen. */
  const opens = (id: string): Route => (block.open ? { name: 'use', ...atRoute(at), appPage: block.open, recordId: id } : { name: 'use', ...atRoute(at), page: block.entity, recordId: id });
  const cell = (column: (typeof block.columns)[number], record: RecordOut) => {
    if (SYSTEM_TIMES.has(column.name)) {
      const value = column.name === 'created_at' ? record.createdAt : record.updatedAt;
      return value ? new Date(value).toLocaleDateString() : '—';
    }
    const person = SYSTEM_PEOPLE[column.name];
    if (person) {
      const id = record[person];
      return id ? <PersonName id={id} /> : '—';
    }
    const field = entity?.fields.find((f) => f.name === column.name);
    return field ? <Cell field={field} record={record} /> : '—';
  };
  return (
    <Card className="grid gap-0 overflow-x-auto p-0">
      {block.title ? <h3 className="m-0 border-b border-line px-4 py-3 text-base font-semibold">{block.title}</h3> : null}
      {rows.isError ? (
        <div className="p-4">
          <Notice tone="bad">{rows.error instanceof ApiError ? rows.error.message : 'This list can\'t be shown.'}</Notice>
        </div>
      ) : rows.data && records.length === 0 ? (
        <p className="m-0 px-4 py-6 text-center text-sm text-muted">{block.empty ?? 'Nothing here yet.'}</p>
      ) : records.length ? (
        <FilesProvider at={at} known={Object.assign({}, ...records.map((r) => r.files ?? {}))}>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                {block.columns.map((column) => (
                  <th key={column.name} scope="col" className="px-4 py-2.5 font-medium">
                    {column.label}
                  </th>
                ))}
                {block.actions.length ? <th scope="col" className="px-4 py-2.5" /> : null}
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-sunken" onClick={() => navigate(opens(record.id))}>
                  {block.columns.map((column, i) => (
                    <td key={column.name} className="px-4 py-2.5">
                      {i === 0 ? (
                        <Link to={opens(record.id)} className="font-medium" onClick={(e) => e.stopPropagation()}>
                          {cell(column, record)}
                        </Link>
                      ) : (
                        cell(column, record)
                      )}
                    </td>
                  ))}
                  {block.actions.length ? (
                    <td className="px-4 py-2 text-right whitespace-nowrap">
                      {block.actions.map((action) => (
                        <Button
                          key={action}
                          size="sm"
                          className="ml-2"
                          disabled={run.isPending}
                          onClick={(e) => {
                            e.stopPropagation();
                            run.mutate({ action, record });
                          }}
                        >
                          {manifest.actions[action]?.label ?? action}
                        </Button>
                      ))}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </FilesProvider>
      ) : (
        <p className="m-0 px-4 py-6 text-sm text-muted">Loading…</p>
      )}
      {run.error ? (
        <div className="p-4 pt-0">
          <Notice tone="bad">{run.error instanceof ApiError ? run.error.message : 'That didn\'t work.'}</Notice>
        </div>
      ) : null}
      {rows.hasNextPage ? (
        <div className="border-t border-line p-3 text-center">
          <Button size="sm" onClick={() => void rows.fetchNextPage()} disabled={rows.isFetchingNextPage}>
            {rows.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/** Which environment of a team app this is, with a way to the others the person may use. */
function EnvironmentBadge({ app }: { app: UiManifest['app'] }) {
  const env = app.environment;
  if (app.kind !== 'team' || !env) return null;
  const others = (app.environments ?? []).filter((e) => e.id !== env.id && (e.kind === 'prod' || e.kind === 'staging'));
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
      {env.kind === 'preview' ? (
        <Badge tone="warn">Preview of change #{env.changeRequest?.number}</Badge>
      ) : (
        <Badge tone={env.kind === 'prod' ? 'good' : 'accent'}>
          {env.kind === 'prod' ? 'Prod' : 'Staging'}
          {env.release ? ` · release ${env.release.number}` : ''}
        </Badge>
      )}
      {others.map((e) => (
        <Link key={e.id} to={{ name: 'use', appId: app.id, ...(e.kind === 'staging' ? { env: 'staging' } : {}) }} className="text-muted">
          {e.kind === 'prod' ? 'Prod' : 'Staging'}
        </Link>
      ))}
      {env.kind === 'preview' && env.changeRequest ? (
        <Link to={{ name: 'change', changeRequestId: env.changeRequest.id }} className="text-muted">
          Back to the change
        </Link>
      ) : null}
    </div>
  );
}

function Cell({ field, record }: { field: UiField; record: RecordOut }) {
  if (record.masked?.includes(field.name)) return <span className="text-faint" title="Masked for your role">••••</span>;
  return <ValueView field={field} value={record.values?.[field.name]} />;
}

/** Every record has an owner, though it isn't one of the entity's fields. */
const OWNER: UiField = { name: 'owner', label: 'Owner', type: 'user', required: true, read: 'full', create: false, update: false };

function RecordList({ at, manifest, entityName }: { at: AppAt; manifest: UiManifest; entityName: string }) {
  const entity = manifest.entities[entityName]!;
  const records = useQuery({ queryKey: ['records', at.id, at.env, entityName], queryFn: () => api.records(at, entityName) });
  const columns = entity.fields.filter((f) => f.read && f.type !== 'lines').slice(0, 6);
  const form = Object.entries(manifest.forms).find(([, f]) => f.entity === entityName);
  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-2xl font-semibold tracking-tight">{entity.pluralLabel}</h2>
        {form ? (
          <Link to={{ name: 'use', ...atRoute(at), page: 'new', recordId: form[0] }} className="no-underline">
            <Button variant="primary" tabIndex={-1}>
              {form[1].label}
            </Button>
          </Link>
        ) : null}
      </div>
      {records.data?.records.length === 0 ? <EmptyState title={`No ${entity.pluralLabel.toLowerCase()} you can see`} /> : null}
      {records.data?.records.length ? (
        <FilesProvider at={at} known={Object.assign({}, ...records.data.records.map((r) => r.files ?? {}))}>
        <Card className="overflow-x-auto p-0">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                {columns.map((f) => (
                  <th key={f.name} scope="col" className="px-4 py-2.5 font-medium">
                    {f.label}
                  </th>
                ))}
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {records.data.records.map((record) => (
                <tr key={record.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-sunken" onClick={() => navigate({ name: 'use', ...atRoute(at), page: entityName, recordId: record.id })}>
                  {columns.map((f, i) => (
                    <td key={f.name} className="px-4 py-2.5">
                      {i === 0 ? (
                        <Link to={{ name: 'use', ...atRoute(at), page: entityName, recordId: record.id }} className="font-medium" onClick={(e) => e.stopPropagation()}>
                          <Cell field={f} record={record} />
                        </Link>
                      ) : (
                        <Cell field={f} record={record} />
                      )}
                    </td>
                  ))}
                  <td className="px-4 py-2.5 text-muted">{record.updatedAt ? new Date(record.updatedAt).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        </FilesProvider>
      ) : null}
    </div>
  );
}

/** A control for one field's value, by type. */
function problemsOf(error: unknown): { fields: Record<string, string>; message: string | null } {
  if (!(error instanceof ApiError)) return { fields: {}, message: error ? 'Something went wrong' : null };
  const details = error.details as { issues?: Array<{ field: string; message: string }>; findings?: Array<{ message: string }> } | undefined;
  const fields = Object.fromEntries((details?.issues ?? []).map((issue) => [issue.field, issue.message]));
  return { fields, message: details?.issues?.length ? 'Some values need fixing.' : error.message };
}

/** Whether a value is empty, as a required field can't be. */
const isEmpty = (value: RecordValue | undefined) => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

/**
 * A form, as the person fills it in (design §6.4). A field shows while its condition holds, and a
 * field it hides sends no value. A field is required always, or while its condition holds. A form
 * in steps shows a section at a time, as a path, and checks each before the next; the server
 * checks everything again whatever the form does.
 */
function FormRunner({ at, manifest, name, form }: { at: AppAt; manifest: UiManifest; name: string; form: UiForm }) {
  const client = useQueryClient();
  const entity = manifest.entities[form.entity]!;
  const items = form.sections.flatMap((s) => s.fields);
  const fieldOf = (field: string) => entity.fields.find((f) => f.name === field);
  // Each lines field on the form starts with one empty line to fill in, and each field with its default.
  const [values, setValues] = useState<Record<string, RecordValue>>(() =>
    Object.fromEntries(
      items.flatMap((item): Array<[string, RecordValue]> => {
        const field = fieldOf(item.field);
        if (!field || item.readOnly) return [];
        if (field.type === 'lines') return [[item.field, [{}]]];
        return field.default !== undefined ? [[item.field, field.default]] : [];
      }),
    ),
  );
  const [step, setStep] = useState(0);
  const [missing, setMissing] = useState<Record<string, string>>({});
  // Conditions read the values as they will be saved: with the totals worked out from the lines.
  const current = { ...values, ...Object.fromEntries(entity.fields.filter((f) => f.computed).map((f) => [f.name, rollupValue(f, values)])) };
  const shown = (item: UiForm['sections'][number]['fields'][number]) => !item.visibleWhen || holdsOn(item.visibleWhen, current);
  const required = (field: UiField) => field.required || Boolean(field.requiredWhen && holdsOn(field.requiredWhen, current));
  /** The fields of a section that are required and still empty, as messages. */
  const unfilled = (section: UiForm['sections'][number]) =>
    Object.fromEntries(
      section.fields.flatMap((item) => {
        const field = fieldOf(item.field);
        if (!field || item.readOnly || field.computed || !shown(item) || !required(field)) return [];
        const value = values[field.name];
        const empty = field.type === 'lines' ? !filledLines(asLines(value)).length : isEmpty(value);
        return empty ? [[field.name, field.type === 'lines' ? `${field.label}: add at least one line` : `${item.label ?? field.label} is required`]] : [];
      }),
    );
  const submit = useMutation({
    mutationFn: async () => {
      const editable = Object.fromEntries(
        Object.entries(values)
          .filter(([field]) => items.some((f) => f.field === field && !f.readOnly && shown(f)))
          .map(([field, value]) => [field, Array.isArray(value) && fieldOf(field)?.type === 'lines' ? filledLines(asLines(value)) : value]),
      );
      if (form.action) return api.runAction(at, form.action, { values: editable });
      return { status: 'done' as const, record: await api.createRecord(at, form.entity, editable) };
    },
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ['records', at.id] });
      if (result.status === 'done' && result.record.values) navigate({ name: 'use', ...atRoute(at), page: form.entity, recordId: result.record.id });
      else if (result.status === 'done') navigate({ name: 'use', ...atRoute(at), page: form.entity });
      else window.location.assign(result.proposal.reviewUrl);
    },
    onError: (error) => {
      // In steps, go back to the first step with a value the server refused.
      const refused = Object.keys(problemsOf(error).fields);
      const first = form.sections.findIndex((section) => section.fields.some((item) => refused.some((field) => field === item.field || field.startsWith(`${item.field}[`))));
      if (form.layout === 'steps' && first !== -1) setStep(first);
    },
  });
  const problems = problemsOf(submit.error);
  const inSteps = form.layout === 'steps' && form.sections.length > 1;
  const sections = inSteps ? [form.sections[step]!] : form.sections;
  const last = !inSteps || step === form.sections.length - 1;
  const next = () => {
    const found = unfilled(form.sections[step]!);
    setMissing(found);
    if (!Object.keys(found).length) setStep(step + 1);
  };
  return (
    <Card className="grid max-w-3xl gap-5">
      <h2 className="m-0 text-2xl font-semibold tracking-tight">{form.label}</h2>
      {inSteps ? (
        <div className="journey-box">
          <ol className="journey" aria-label={`The steps of ${form.label}`}>
            {form.sections.map((section, index) => {
              const state = index < step ? 'done' : index === step ? 'now' : 'later';
              const about = section.fields
                .filter((item) => !item.readOnly)
                .map((item) => item.label ?? fieldOf(item.field)?.label ?? item.field)
                .join(', ');
              return (
                <li key={index} className={state} {...(state === 'now' ? { 'aria-current': 'step' as const } : {})}>
                  <span className="journey-mark" aria-hidden="true">
                    {state === 'done' ? <Icon name="check" /> : index + 1}
                  </span>
                  <span>
                    <strong>{section.title ?? `Step ${index + 1}`}</strong>
                    <span className="sr-only">{state === 'done' ? ', done' : state === 'now' ? ', to do now' : ''}</span>
                    {about ? <span className="journey-about">{about}</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}
      <form
        className="grid gap-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!last) return next();
          const found = Object.assign({}, ...form.sections.map(unfilled)) as Record<string, string>;
          setMissing(found);
          if (!Object.keys(found).length) submit.mutate();
        }}
        aria-describedby={problems.message ? 'form-problem' : undefined}
      >
        {sections.map((section) => (
          <fieldset key={section.title ?? form.sections.indexOf(section)} className="m-0 grid gap-3 border-0 p-0">
            {section.title && !inSteps ? <legend className="mb-2 font-semibold">{section.title}</legend> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              {section.fields.map((item) => {
                const field = fieldOf(item.field);
                if (!field || !shown(item)) return null;
                const id = `field-${item.field}`;
                const lines = field.type === 'lines';
                const problem = problems.fields[field.name] ?? missing[field.name];
                return (
                  <div key={item.field} className={cx('grid content-start gap-1', (item.width === 'full' || lines) && 'sm:col-span-2')}>
                    {field.type !== 'boolean' ? (
                      <label htmlFor={id} className="text-sm text-muted">
                        {item.label ?? field.label}
                        {required(field) && !field.computed ? <span className="text-bad"> *</span> : null}
                      </label>
                    ) : null}
                    {field.computed ? (
                      <p className="m-0 tabular-nums" id={id}>
                        <ValueView field={field} value={rollupValue(field, values)} />
                      </p>
                    ) : lines && !item.readOnly ? (
                      <LinesEditor id={id} field={field} value={asLines(values[field.name])} onChange={(value) => setValues({ ...values, [field.name]: value })} mode="create" problems={problems.fields} />
                    ) : item.readOnly ? (
                      <p className="m-0">
                        <ValueView field={field} value={values[field.name]} />
                      </p>
                    ) : (
                      <ValueInput id={id} field={field} value={values[field.name] as Value | undefined} onChange={(value) => setValues({ ...values, [field.name]: value })} />
                    )}
                    {item.help ? <p className="m-0 text-xs text-faint">{item.help}</p> : null}
                    {problem ? <p className="m-0 text-xs text-bad">{problem}</p> : null}
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}
        {problems.message ? (
          <div id="form-problem">
            <Notice tone="bad">{problems.message}</Notice>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {inSteps && step > 0 ? (
            <Button
              onClick={() => {
                setMissing({});
                setStep(step - 1);
              }}
            >
              Back
            </Button>
          ) : null}
          {last ? (
            <Button type="submit" variant="primary" disabled={submit.isPending}>
              {submit.isPending ? 'Submitting…' : form.action ? (manifest.actions[form.action]?.label ?? 'Submit') : 'Save'}
            </Button>
          ) : (
            <Button type="submit" variant="primary">
              Next: {form.sections[step + 1]?.title ?? `step ${step + 2}`}
            </Button>
          )}
        </div>
      </form>
    </Card>
  );
}

function RecordView({ at, manifest, entityName, recordId }: { at: AppAt; manifest: UiManifest; entityName: string; recordId: string }) {
  const client = useQueryClient();
  const entity: UiEntity = manifest.entities[entityName]!;
  const record = useQuery({ queryKey: ['record', at.id, at.env, entityName, recordId], queryFn: () => api.record(at, entityName, recordId) });
  const history = useQuery({ queryKey: ['history', at.id, at.env, entityName, recordId], queryFn: () => api.history(at, entityName, recordId) });
  const [edits, setEdits] = useState<Record<string, RecordValue> | null>(null);
  const refresh = () =>
    Promise.all([...['record', 'records', 'history', 'processes'].map((key) => client.invalidateQueries({ queryKey: [key, at.id] })), client.invalidateQueries({ queryKey: ['tasks'] })]);
  // Lines are sent whole, with their IDs, so the platform knows which changed; empty new rows are dropped.
  const changes = () => Object.fromEntries(Object.entries(edits ?? {}).map(([field, value]) => [field, entity.fields.find((f) => f.name === field)?.type === 'lines' ? filledLines(asLines(value)) : value]));
  const save = useMutation({ mutationFn: () => api.updateRecord(at, entityName, recordId, changes(), record.data!.version), onSuccess: async () => (setEdits(null), await refresh()) });
  const run = useMutation({ mutationFn: (action: string) => api.runAction(at, action, { values: {}, recordId, version: record.data!.version }), onSuccess: refresh });
  const actions = Object.entries(manifest.actions).filter(([, a]) => a.entity === entityName && a.operation === 'update' && a.input.length === 0);
  const editable = entity.fields.filter((f) => f.update && !f.computed && !record.data?.masked?.includes(f.name));

  if (record.isError) return <Notice tone="bad">This record doesn't exist, or you can't see it.</Notice>;
  if (!record.data) return <p className="text-muted">Loading…</p>;
  const title = entity.titleField ? display(entity.fields.find((f) => f.name === entity.titleField), record.data.values?.[entity.titleField]) : record.data.id;
  const problems = problemsOf(save.error ?? run.error);

  return (
    <FilesProvider at={at} known={record.data.files ?? {}}>
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <Card className="grid content-start gap-4">
        <div>
          <p className="m-0 text-sm text-muted">
            <Link to={{ name: 'use', ...atRoute(at), page: entityName }}>{entity.pluralLabel}</Link>
          </p>
          <h2 className="m-0 text-2xl font-semibold tracking-tight">{title}</h2>
        </div>
        <dl className="m-0 grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
          {entity.fields
            .filter((f) => f.read)
            .map((field) => {
              const editing = edits !== null && editable.includes(field);
              const current = edits && field.name in edits ? edits[field.name] : (record.data.values?.[field.name] ?? null);
              const lines = field.type === 'lines';
              return (
              <div key={field.name} className="contents">
                <dt className={cx('text-muted', lines && 'sm:col-span-2')}>{editing ? <label htmlFor={`edit-${field.name}`}>{field.label}</label> : field.label}</dt>
                <dd className={cx('m-0', lines && 'sm:col-span-2')}>
                  {editing && lines ? (
                    <LinesEditor id={`edit-${field.name}`} field={field} value={asLines(current)} onChange={(next) => setEdits({ ...edits, [field.name]: next })} mode="update" problems={problems.fields} />
                  ) : editing ? (
                    <ValueInput id={`edit-${field.name}`} field={field} value={current as Value} onChange={(value) => setEdits({ ...edits, [field.name]: value })} />
                  ) : lines ? (
                    <LinesTable field={field} value={record.data.values?.[field.name]} masked={record.data.masked ?? []} />
                  ) : field.computed && edits ? (
                    <span className="tabular-nums">
                      <ValueView field={field} value={rollupValue(field, { ...record.data.values, ...edits })} />
                    </span>
                  ) : (
                    <Cell field={field} record={record.data} />
                  )}
                  {problems.fields[field.name] && !lines ? <span className="block text-xs text-bad">{problems.fields[field.name]}</span> : null}
                </dd>
              </div>
              );
            })}
          {record.data.owner ? (
            <>
              <dt className="text-muted">{OWNER.label}</dt>
              <dd className="m-0">
                <PersonName id={record.data.owner} />
              </dd>
            </>
          ) : null}
        </dl>
        {problems.message ? <Notice tone="bad">{problems.message}</Notice> : null}
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {edits ? (
            <>
              <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending}>
                Save
              </Button>
              <Button onClick={() => setEdits(null)}>Cancel</Button>
            </>
          ) : (
            <>
              {editable.length ? <Button onClick={() => setEdits({})}>Edit</Button> : null}
              {actions.map(([name, action]) => (
                <Button key={name} variant="primary" onClick={() => run.mutate(name)} disabled={run.isPending}>
                  {action.label}
                </Button>
              ))}
            </>
          )}
        </div>
      </Card>
      <div className="grid content-start gap-4">
      <ProcessCard at={at} entity={entityName} recordId={recordId} />
      <Card className="grid content-start gap-3">
        <h3 className="m-0 text-sm font-semibold text-muted">History</h3>
        <ol className="m-0 grid list-none gap-3 p-0">
          {history.data?.history
            .slice()
            .reverse()
            .map((entry) => (
              <HistoryItem key={`${entry.version}-${entry.at}`} entry={entry} entity={entity} record={record.data!} />
            ))}
        </ol>
      </Card>
      </div>
    </div>
    </FilesProvider>
  );
}

function HistoryItem({ entry, entity, record }: { entry: HistoryEntry; entity: UiEntity; record: RecordOut }) {
  const verb = { create: 'Created', update: 'Changed', delete: 'Deleted' }[entry.operation];
  const { actor } = entry;
  return (
    <li className="grid gap-1 border-l-2 border-line pl-3">
      <p className="m-0 text-sm">
        <strong>{verb}</strong>
        {actor.id ? (
          <>
            {' by '}
            <span className={cx(actor.type === 'service_account' && 'text-agent')}>
              <PersonName id={actor.id} />
              {actor.type === 'service_account' ? ' (agent)' : null}
            </span>
            {actor.onBehalfOf ? (
              <>
                {' for '}
                <PersonName id={actor.onBehalfOf} />
              </>
            ) : null}
          </>
        ) : null}
        <span className="block text-muted">{new Date(entry.at).toLocaleString()}</span>
      </p>
      <ul className="m-0 grid list-none gap-0.5 p-0 text-sm">
        {entry.changes.map((change, i) => {
          const field = change.field === 'owner' ? OWNER : entity.fields.find((f) => f.name === change.field);
          const label = field?.label ?? change.field;
          if (change.masked) return <li key={i} className="text-muted">{label}: changed (masked)</li>;
          if (change.removed) return <li key={i} className="text-faint">{label}: a field that no longer exists</li>;
          if (change.lines && field) {
            return (
              <li key={i}>
                <span className="text-muted">{label}:</span>
                <LinesChangeView field={field} change={change.lines} current={asLines(record.values?.[field.name]) as Line[]} />
              </li>
            );
          }
          return (
            <li key={i}>
              <span className="text-muted">{label}:</span>{' '}
              {entry.operation === 'update' ? (
                <>
                  <ValueView field={field} value={change.before ?? null} link={false} />
                  {' → '}
                </>
              ) : null}
              <ValueView field={field} value={change.after ?? null} link={false} />
              {change.source?.source === 'document' ? <span className="ml-1 text-outside">from {String(change.source['document'] ?? 'a document')}</span> : null}
              {change.source?.source === 'agent' ? <span className="ml-1 text-agent">inferred by the agent</span> : null}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

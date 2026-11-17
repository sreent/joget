import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { Badge, Button, Checkbox, cx, Dialog, Notice } from '../components/ui.js';
import { normalize } from '../model/edit.js';
import { Link, type BuildTab } from '../router.js';
import type { Definition, Issue, Plan } from '../types.js';
import { AccessPanel, AdvancedPanel, HistoryPanel, MovedNotice, MovePanel, SharePanel } from './BuilderPanels.js';
import { ComposePanel } from './Compose.js';
import { ChangesPanel, DeliveryPanel, TeamAppNotice, WorkingCopyBar } from './Delivery.js';
import { DataDesigner } from './DataDesigner.js';
import { FlowsDesigner } from './FlowsDesigner.js';
import { FormDesigner } from './FormDesigner.js';
import { ActionsDesigner, CardsDesigner, QueriesDesigner, RulesDesigner } from './LogicDesigners.js';
import { MenuDesigner, PagesDesigner } from './PagesDesigner.js';
import { RolesDesigner } from './RolesDesigner.js';

type Part = { readonly tab: BuildTab; readonly label: string };

/**
 * The workbench's views (design §6.11): an app's parts, as Ocean's workbench names them, each with
 * what it holds. A view opens on its first part.
 */
const VIEWS: ReadonlyArray<{ readonly label: string; readonly parts: readonly Part[] }> = [
  {
    label: 'Data',
    parts: [
      { tab: 'data', label: 'Entities' },
      { tab: 'rules', label: 'Rules' },
      { tab: 'queries', label: 'Queries' },
    ],
  },
  {
    label: 'Forms',
    parts: [
      { tab: 'forms', label: 'Forms' },
      { tab: 'cards', label: 'Review cards' },
    ],
  },
  {
    label: 'Pages',
    parts: [
      { tab: 'pages', label: 'Pages' },
      { tab: 'menu', label: 'Menu' },
    ],
  },
  {
    label: 'Flows',
    parts: [
      { tab: 'flows', label: 'Flows' },
      { tab: 'actions', label: 'Actions' },
    ],
  },
  {
    label: 'Permissions',
    parts: [
      { tab: 'roles', label: 'Roles' },
      { tab: 'share', label: 'Share' },
    ],
  },
];
const DESIGNERS: readonly BuildTab[] = ['data', 'rules', 'queries', 'forms', 'cards', 'pages', 'menu', 'flows', 'actions', 'roles'];
/** Around the app, beside its views: a team app's delivery first; a personal app's history and settings. */
const AROUND: readonly Part[] = [
  { tab: 'history', label: 'History' },
  { tab: 'advanced', label: 'Advanced' },
];
const TEAM_AROUND: readonly Part[] = [
  { tab: 'delivery', label: 'Delivery' },
  { tab: 'changes', label: 'Change requests' },
  { tab: 'history', label: 'History' },
];

type Review = { plan?: Plan; issues?: Issue[]; error?: string; conflict?: boolean };

/** Building an app: a draft of its definition, edited in the designers, checked and saved as a new revision. */
export function Builder({ appId, tab }: { appId: string; tab: BuildTab }) {
  const client = useQueryClient();
  const summary = useQuery({ queryKey: ['app', appId], queryFn: () => api.app(appId) });
  const saved = useQuery({ queryKey: ['definition', appId], queryFn: () => api.definition(appId) });
  const [draft, setDraft] = useState<Definition | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [confirmLoss, setConfirmLoss] = useState(false);
  // The chat that builds the app (design §6.5), when an admin set up a model for it.
  const composing = useQuery({ queryKey: ['compose'], queryFn: api.composeEnabled, staleTime: Infinity });
  const [chat, setChat] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);

  useEffect(() => {
    if (saved.data) setDraft(normalize(saved.data.definition));
  }, [saved.data]);

  const dirty = !!draft && !!saved.data && JSON.stringify(draft) !== JSON.stringify(normalize(saved.data.definition));
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const failure = (error: unknown): Review => {
    if (!(error instanceof ApiError)) return { error: 'Something went wrong' };
    const details = error.details as { issues?: Issue[]; plan?: Plan } | undefined;
    if (details?.issues) return { issues: details.issues };
    if (error.code === 'revision_mismatch' || error.code === 'revision_conflict') return { error: error.message, conflict: true };
    return { error: error.message, ...(details?.plan ? { plan: details.plan } : {}) };
  };
  const check = useMutation({
    mutationFn: () => api.plan(appId, draft!),
    onSuccess: ({ plan }) => {
      setConfirmLoss(false);
      setReview({ plan });
    },
    onError: (error) => setReview(failure(error)),
  });
  const save = useMutation({
    mutationFn: () => api.save(appId, draft!, saved.data!.revision, confirmLoss),
    onSuccess: async () => {
      setReview(null);
      await Promise.all(['definition', 'app', 'ui', 'apps'].map((key) => client.invalidateQueries({ queryKey: [key] })));
    },
    onError: (error) => setReview(failure(error)),
  });

  if (summary.isError || saved.isError) {
    const error = summary.error ?? saved.error;
    return <Notice tone="bad">{error instanceof ApiError && error.status === 403 ? "You can't build this app." : "This app can't be opened."}</Notice>;
  }
  if (!draft || !summary.data || !saved.data) return <p className="text-muted">Loading…</p>;
  const plan = review?.plan;
  const app = summary.data;
  const team = app.kind === 'team';
  const around = team ? TEAM_AROUND : AROUND;
  const view = VIEWS.find((each) => each.parts.some((part) => part.tab === tab));
  // A team app's people are its access, which its space grants.
  const partLabel = (part: Part) => (team && part.tab === 'share' ? 'Access' : part.label);
  const designing = DESIGNERS.includes(tab) || tab === 'advanced';
  const live = team ? app.environments?.find((env) => env.kind === 'prod') : app.environment;
  const canChat = !!composing.data?.enabled && app.access.compose && !team && !app.movedTo;
  const chatting = canChat && chat;

  return (
    // With the chat beside them, the page widens: the designers lay themselves out by the room they have.
    <div data-wide={chatting || undefined} className={chatting ? 'grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]' : undefined}>
    <div className="grid min-w-0 gap-5 pb-24">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="m-0 text-sm text-muted">
            <Link to={{ name: 'home' }}>Your apps</Link> / Build
          </p>
          <h1 className="m-0 text-2xl font-semibold tracking-tight">{summary.data.name}</h1>
        </div>
        <div className="flex items-center gap-2">
          {team ? <Badge tone="accent">Team app</Badge> : null}
          <Badge>revision {saved.data.revision}</Badge>
          {canChat ? (
            <Button aria-expanded={chat} onClick={() => setChat(!chat)}>
              {chat ? 'Hide the chat' : 'Build by chat'}
            </Button>
          ) : null}
          {live ? (
            <Link to={{ name: 'use', appId }} className="no-underline">
              <Button tabIndex={-1}>{team ? 'Open in Prod' : 'Open the app'}</Button>
            </Link>
          ) : null}
        </div>
      </div>

      {app.workingCopyOf ? <WorkingCopyBar app={app} dirty={dirty} /> : null}
      {app.movedTo ? <MovedNotice movedTo={app.movedTo} /> : null}

      {/* The workbench's views, as Ocean's modes; around them, what concerns the whole app. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="The app" className="inline-flex overflow-hidden rounded-md border border-line-strong bg-surface">
          {VIEWS.map((each, index) => (
            <Link
              key={each.label}
              to={{ name: 'build', appId, tab: each.parts[0]!.tab }}
              aria-current={each === view ? 'true' : undefined}
              className={cx('px-3.5 py-1.5 text-sm no-underline', index > 0 && 'border-l border-line-strong', each === view ? 'bg-accent-soft font-semibold text-accent' : 'text-text hover:bg-sunken')}
            >
              {each.label}
            </Link>
          ))}
        </nav>
        <nav aria-label="Around the app" className="flex gap-1">
          {around.map((item) => (
            <Link
              key={item.tab}
              to={{ name: 'build', appId, tab: item.tab }}
              aria-current={item.tab === tab ? 'page' : undefined}
              className={cx('rounded-md px-3 py-1.5 text-sm no-underline', item.tab === tab ? 'bg-accent-soft font-semibold text-accent' : 'text-muted hover:text-text')}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
      {view ? (
        <nav aria-label={view.label} className="flex gap-1 overflow-x-auto border-b border-line">
          {view.parts.map((part) => (
            <Link
              key={part.tab}
              to={{ name: 'build', appId, tab: part.tab }}
              aria-current={part.tab === tab ? 'page' : undefined}
              className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap no-underline ${part.tab === tab ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text'}`}
            >
              {partLabel(part)}
            </Link>
          ))}
        </nav>
      ) : null}

      {team && designing ? <TeamAppNotice app={app} /> : null}
      {/* A team app's main line is read-only here: a disabled fieldset disables every control in the designers. */}
      {/* While the chat works, the designers wait: its draft replaces the one it was given. */}
      <fieldset disabled={team || chatBusy} className="m-0 min-w-0 border-0 p-0">
        <div className="@container">
        {tab === 'data' ? <DataDesigner definition={draft} onChange={setDraft} /> : null}
        {tab === 'forms' ? <FormDesigner definition={draft} onChange={setDraft} /> : null}
        {tab === 'pages' ? <PagesDesigner definition={draft} onChange={setDraft} /> : null}
        {tab === 'menu' ? <MenuDesigner definition={draft} onChange={setDraft} /> : null}
        {tab === 'rules' ? <RulesDesigner definition={draft} onChange={setDraft} /> : null}
        {tab === 'actions' ? <ActionsDesigner definition={draft} onChange={setDraft} /> : null}
        {tab === 'queries' ? <QueriesDesigner definition={draft} onChange={setDraft} /> : null}
        {tab === 'cards' ? <CardsDesigner definition={draft} onChange={setDraft} /> : null}
        {tab === 'roles' ? <RolesDesigner definition={draft} onChange={setDraft} /> : null}
        {tab === 'flows' ? <FlowsDesigner appId={appId} definition={draft} onChange={setDraft} readOnly={team || chatBusy} dirty={dirty} /> : null}
        {tab === 'advanced' && !team ? <AdvancedPanel definition={draft} onChange={setDraft} /> : null}
        </div>
      </fieldset>
      {tab === 'share' && team ? <AccessPanel app={app} definition={saved.data.definition} /> : null}
      {tab === 'share' && !team && app.access.share ? <SharePanel at={{ id: appId }} definition={saved.data.definition} /> : null}
      {tab === 'share' && !team && !app.workingCopyOf ? <MovePanel app={app} /> : null}
      {tab === 'history' ? <HistoryPanel appId={appId} /> : null}
      {tab === 'delivery' && team ? <DeliveryPanel app={app} /> : null}
      {tab === 'changes' && team ? <ChangesPanel app={app} /> : null}

      {dirty && !team ? (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface/95 backdrop-blur">
          <div className={`mx-auto flex items-center justify-between gap-3 px-4 py-3 ${chatting ? 'max-w-[110rem]' : 'max-w-7xl'}`}>
            <p className="m-0 text-sm">
              <strong>Unsaved changes.</strong>{' '}
              <span className="text-muted">{app.workingCopyOf ? 'They apply to your working copy once saved; submit them for review after.' : 'They apply to your sandbox once saved.'}</span>
            </p>
            <div className="flex gap-2">
              <Button onClick={() => setDraft(normalize(saved.data.definition))} disabled={chatBusy}>
                Discard
              </Button>
              <Button variant="primary" onClick={() => check.mutate()} disabled={check.isPending || chatBusy}>
                {check.isPending ? 'Checking…' : 'Review and save'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <Dialog
        open={review !== null}
        title={review?.issues ? 'Some things need fixing first' : 'Save these changes?'}
        onClose={() => setReview(null)}
        actions={
          <>
            <Button onClick={() => setReview(null)}>{review?.issues || review?.conflict ? 'Back to editing' : 'Cancel'}</Button>
            {review?.conflict ? (
              <Button variant="primary" onClick={() => void saved.refetch().then(() => setReview(null))}>
                Reload the saved version
              </Button>
            ) : plan && !review?.issues ? (
              <Button variant="primary" onClick={() => save.mutate()} disabled={save.isPending || (plan.destructive && !confirmLoss)}>
                {save.isPending ? 'Saving…' : `Save as revision ${plan.revision}`}
              </Button>
            ) : null}
          </>
        }
      >
        {review?.error ? <Notice tone="bad">{review.error}</Notice> : null}
        {review?.issues ? (
          <ul className="m-0 grid gap-2 pl-5">
            {review.issues.map((issue, i) => (
              <li key={i}>
                {issue.message} <code className="text-xs text-faint">{issue.path}</code>
              </li>
            ))}
          </ul>
        ) : null}
        {plan ? (
          <>
            {plan.steps.length === 0 ? <p className="m-0 text-muted">No change to the data model: names, labels, forms or rules only.</p> : null}
            <ul className="m-0 grid list-none gap-2 p-0">
              {plan.steps.map((step, i) => (
                <li key={i} className={`rounded-md px-3 py-2 text-sm ${step.destructive ? 'bg-bad-bg text-bad' : 'bg-sunken'}`}>
                  {step.description}
                  {step.records !== undefined && step.destructive ? <strong> — {step.records} record(s) have values here</strong> : null}
                </li>
              ))}
            </ul>
            {plan.notes.map((note, i) => (
              <p key={i} className="m-0 text-sm text-muted">
                {note}
              </p>
            ))}
            {plan.destructive ? <Checkbox label="I understand this deletes data, and it can't be undone" checked={confirmLoss} onChange={setConfirmLoss} /> : null}
          </>
        ) : null}
      </Dialog>
    </div>
      {canChat ? (
        // Beside the designers on a wide screen; over them on a narrow one. Hidden, it keeps the conversation.
        <aside hidden={!chat} className="fixed inset-0 z-30 bg-page p-2 xl:sticky xl:inset-auto xl:top-[4.5rem] xl:z-auto xl:h-[calc(100vh-9.5rem)] xl:bg-transparent xl:p-0">
          <ComposePanel appId={appId} definition={draft} onDraft={setDraft} onBusy={setChatBusy} onClose={() => setChat(false)} />
        </aside>
      ) : null}
    </div>
  );
}

import { type StoredDefinition, validateDefinition } from '@platform/app-model';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api.js';
import { Icon } from '../components/icon.js';
import { ProblemsBadge, ProblemsContext, ProblemsList } from '../components/problems.js';
import { Badge, Button, Checkbox, cx, Dialog, Notice } from '../components/ui.js';
import { normalize } from '../model/edit.js';
import { type BuildTab, Link } from '../router.js';
import type { Definition, Issue, Plan } from '../types.js';
import { AccessPanel, AdvancedPanel, HistoryPanel, MovedNotice, MovePanel, SharePanel } from './BuilderPanels.js';
import { ComposePanel } from './Compose.js';
import { DataDesigner } from './DataDesigner.js';
import { ChangesPanel, DeliveryPanel, TeamAppNotice, WorkingCopyBar } from './Delivery.js';
import { FlowsDesigner } from './FlowsDesigner.js';
import { FormDesigner } from './FormDesigner.js';
import { ConnectionsDesigner, IntegrationSecrets, WebhooksDesigner } from './IntegrationDesigner.js';
import { ActionsDesigner, CardsDesigner, QueriesDesigner, RulesDesigner } from './LogicDesigners.js';
import { MenuDesigner, PagesDesigner } from './PagesDesigner.js';
import { RolesDesigner } from './RolesDesigner.js';
import { TestsDesigner } from './TestsDesigner.js';

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
      { tab: 'connections', label: 'Connections' },
      { tab: 'webhooks', label: 'Webhooks' },
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
const DESIGNERS: readonly BuildTab[] = [
  'data',
  'rules',
  'queries',
  'forms',
  'cards',
  'pages',
  'menu',
  'flows',
  'actions',
  'connections',
  'webhooks',
  'roles',
  'tests',
];
/** Around the app, beside its views: a team app's delivery first; a personal app's history and settings. */
const AROUND: readonly Part[] = [
  { tab: 'tests', label: 'Tests' },
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
export function Builder({ appId, tab, item }: { appId: string; tab: BuildTab; item?: string }) {
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
  // What undo goes back to, and what redo goes forward to: the drafts before and after this one.
  const [past, setPast] = useState<Definition[]>([]);
  const [future, setFuture] = useState<Definition[]>([]);
  const lastEdit = useRef<{ readonly at: number; readonly field: Element | null }>({ at: 0, field: null });
  // The draft's problems, found as it changes, and whether their list is open.
  const [problems, setProblems] = useState<Issue[]>([]);
  const [showProblems, setShowProblems] = useState(false);

  useEffect(() => {
    if (saved.data) setDraft(normalize(saved.data.definition));
  }, [saved.data]);

  /**
   * A change to the draft, which undo takes back. What someone types into one text box in a burst is
   * one change; a button, a key or a drag is a change of its own, however soon it follows.
   */
  const edit = (next: Definition) => {
    if (!draft || next === draft) return;
    const now = Date.now();
    const active = document.activeElement;
    const field = active?.matches('textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="file"])') ? active : null;
    const typing = field !== null && field === lastEdit.current.field && now - lastEdit.current.at <= TYPING;
    if (!typing) setPast((list) => [...list.slice(1 - HISTORY), draft]);
    lastEdit.current = { at: now, field };
    setFuture([]);
    setDraft(next);
  };
  const undo = () => {
    const previous = past.at(-1);
    if (!previous || !draft) return;
    setPast(past.slice(0, -1));
    setFuture([draft, ...future]);
    setDraft(previous);
    lastEdit.current = { at: 0, field: null };
  };
  const redo = () => {
    const [next, ...rest] = future;
    if (!next || !draft) return;
    setFuture(rest);
    setPast([...past, draft]);
    setDraft(next);
    lastEdit.current = { at: 0, field: null };
  };
  // Ctrl or Cmd with Z undoes, and with Shift, or Y, redoes; in a text box, the box's own undo works instead.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) undo();
      else if (key === 'y' || (key === 'z' && event.shiftKey)) redo();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // The checks the server runs as the draft saves, run here as it changes, a moment after the last change.
  useEffect(() => {
    if (!draft || !saved.data) return;
    const previous = saved.data.definition;
    const timer = window.setTimeout(() => {
      const result = validateDefinition(draft, isStored(previous) ? previous : undefined);
      setProblems(result.ok ? [] : result.issues.map(({ path, message }) => ({ path, message })));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, saved.data]);

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
    <>
      {/* The workbench's toolbar: which app, where its draft stands, and what to do; then its views. */}
      <header className="wb-bar">
        <Link to={{ name: 'home' }} className="crumb">
          <Icon name="back" />
          Your apps
        </Link>
        <h1>{summary.data.name}</h1>
        {team ? <Badge tone="accent">Team app</Badge> : null}
        <Badge>revision {saved.data.revision}</Badge>
        {team ? null : <ProblemsBadge count={problems.length} open={showProblems} onToggle={() => setShowProblems(!showProblems)} />}
        <span className="wb-spacer" />
        {team ? null : (
          <>
            <Button size="sm" variant="ghost" disabled={!past.length || chatBusy} onClick={undo} aria-keyshortcuts="Control+Z Meta+Z">
              Undo
            </Button>
            <Button size="sm" variant="ghost" disabled={!future.length || chatBusy} onClick={redo} aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y">
              Redo
            </Button>
          </>
        )}
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
        <span className="wb-break" />
        {/* The workbench's views, as Ocean's modes; at the end of the row, what concerns the whole app. */}
        <nav aria-label="The app" className="inline-flex overflow-hidden rounded-md border border-line-strong bg-surface">
          {VIEWS.map((each, index) => (
            <Link
              key={each.label}
              to={{ name: 'build', appId, tab: each.parts[0]!.tab }}
              aria-current={each === view ? 'true' : undefined}
              className={cx(
                'px-3.5 py-1.5 text-sm no-underline',
                index > 0 && 'border-l border-line-strong',
                each === view ? 'bg-accent-soft font-semibold text-accent' : 'text-text hover:bg-sunken',
              )}
            >
              {each.label}
            </Link>
          ))}
        </nav>
        <span className="wb-spacer" />
        <nav aria-label="Around the app" className="flex gap-1">
          {around.map((item) => (
            <Link
              key={item.tab}
              to={{ name: 'build', appId, tab: item.tab }}
              aria-current={item.tab === tab ? 'page' : undefined}
              className={cx(
                'rounded-md px-3 py-1.5 text-sm no-underline',
                item.tab === tab ? 'bg-accent-soft font-semibold text-accent' : 'text-muted hover:text-text',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      {/* The work scrolls on its own, under the toolbar; with the chat, the chat is a pane beside it. On a
          phone the page scrolls, as Ocean's workbench does there, so the bar of unsaved changes stays in view. */}
      <div className={cx('wb-body grid-cols-[minmax(0,1fr)]', chatting && 'xl:grid-cols-[minmax(0,1fr)_24rem]')}>
        <div className="min-h-0 min-[761px]:overflow-auto">
          <div className="mx-auto grid w-full max-w-[110rem] min-w-0 gap-5 px-4 py-5 sm:px-6">
            {showProblems && problems.length && !team ? <ProblemsList appId={appId} definition={draft} problems={problems} /> : null}
            {app.workingCopyOf ? <WorkingCopyBar app={app} dirty={dirty} /> : null}
            {app.movedTo ? <MovedNotice movedTo={app.movedTo} /> : null}
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
                <ProblemsContext.Provider value={problems}>
                  {tab === 'data' ? <DataDesigner definition={draft} onChange={edit} /> : null}
                  {tab === 'forms' ? <FormDesigner definition={draft} onChange={edit} /> : null}
                  {tab === 'pages' ? <PagesDesigner definition={draft} onChange={edit} /> : null}
                  {tab === 'menu' ? <MenuDesigner definition={draft} onChange={edit} /> : null}
                  {tab === 'rules' ? <RulesDesigner definition={draft} onChange={edit} /> : null}
                  {tab === 'actions' ? <ActionsDesigner appId={appId} definition={draft} onChange={edit} /> : null}
                  {tab === 'queries' ? <QueriesDesigner definition={draft} onChange={edit} /> : null}
                  {tab === 'cards' ? <CardsDesigner definition={draft} onChange={edit} /> : null}
                  {tab === 'roles' ? <RolesDesigner definition={draft} onChange={edit} /> : null}
                  {tab === 'flows' ? (
                    <FlowsDesigner
                      appId={appId}
                      definition={draft}
                      onChange={edit}
                      readOnly={team || chatBusy}
                      dirty={dirty}
                      {...(item ? { open: item } : {})}
                    />
                  ) : null}
                  {tab === 'connections' ? <ConnectionsDesigner definition={draft} onChange={edit} /> : null}
                  {tab === 'webhooks' ? <WebhooksDesigner definition={draft} onChange={edit} /> : null}
                  {tab === 'tests' && !team ? <TestsDesigner appId={appId} definition={draft} onChange={edit} dirty={dirty} /> : null}
                  {tab === 'advanced' && !team ? <AdvancedPanel definition={draft} onChange={edit} /> : null}
                </ProblemsContext.Provider>
              </div>
            </fieldset>
            {/* Secrets are each environment's, for what is saved: whoever manages connections keeps them, a team app's too. */}
            {tab === 'connections' || tab === 'webhooks' ? <IntegrationSecrets appId={appId} team={team} part={tab} revision={saved.data.revision} /> : null}
            {tab === 'share' && team ? <AccessPanel app={app} definition={saved.data.definition} /> : null}
            {tab === 'share' && !team && app.access.share ? <SharePanel at={{ id: appId }} definition={saved.data.definition} /> : null}
            {tab === 'share' && !team && !app.workingCopyOf ? <MovePanel app={app} /> : null}
            {tab === 'history' ? <HistoryPanel appId={appId} /> : null}
            {tab === 'delivery' && team ? <DeliveryPanel app={app} /> : null}
            {tab === 'changes' && team ? <ChangesPanel app={app} /> : null}
          </div>
          {dirty && !team ? (
            <div className="sticky bottom-0 z-10 border-t border-line bg-surface/95 backdrop-blur">
              <div className="mx-auto flex max-w-[110rem] items-center justify-between gap-3 px-4 py-3 sm:px-6">
                <p className="m-0 text-sm">
                  <strong>Unsaved changes.</strong>{' '}
                  <span className="text-muted">
                    {app.workingCopyOf ? 'They apply to your working copy once saved; submit them for review after.' : 'They apply to your sandbox once saved.'}
                  </span>
                </p>
                <div className="flex gap-2">
                  <Button onClick={() => edit(normalize(saved.data.definition))} disabled={chatBusy}>
                    Discard
                  </Button>
                  <Button variant="primary" onClick={() => check.mutate()} disabled={check.isPending || chatBusy}>
                    {check.isPending ? 'Checking…' : 'Review and save'}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
        {canChat ? (
          // A pane beside the work on a wide screen; over it on a narrow one. Hidden, it keeps the conversation.
          <aside hidden={!chat} className="fixed inset-0 z-30 bg-page p-2 xl:static xl:z-auto xl:min-h-0 xl:border-l xl:border-line xl:p-3">
            <ComposePanel appId={appId} definition={draft} onDraft={edit} onBusy={setChatBusy} onClose={() => setChat(false)} />
          </aside>
        ) : null}
      </div>
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
            {plan.destructive ? (
              <Checkbox label="I understand this deletes data, and it can't be undone" checked={confirmLoss} onChange={setConfirmLoss} />
            ) : null}
          </>
        ) : null}
      </Dialog>
    </>
  );
}

/** Typing into one text box with pauses shorter than this is one change to undo. */
const TYPING = 800;
/** How many steps undo can go back. */
const HISTORY = 100;

/** A definition as saved: each entity and field has its ID, which keeps renames apart from new names. */
function isStored(definition: Definition): definition is Definition & StoredDefinition {
  return Object.values(definition.entities).every((entity) => entity.id !== undefined && entity.fields.every((field) => field.id !== undefined));
}

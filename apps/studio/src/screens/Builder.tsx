import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { Badge, Button, Checkbox, Dialog, Notice } from '../components/ui.js';
import { normalize } from '../model/edit.js';
import { Link, type BuildTab } from '../router.js';
import type { Definition, Issue, Plan } from '../types.js';
import { AdvancedPanel, HistoryPanel, SharePanel } from './BuilderPanels.js';
import { DataDesigner } from './DataDesigner.js';
import { FormDesigner } from './FormDesigner.js';
import { ActionsDesigner, CardsDesigner, QueriesDesigner, RulesDesigner } from './LogicDesigners.js';
import { RolesDesigner } from './RolesDesigner.js';

const TABS: ReadonlyArray<{ tab: BuildTab; label: string }> = [
  { tab: 'data', label: 'Data' },
  { tab: 'forms', label: 'Forms' },
  { tab: 'rules', label: 'Rules' },
  { tab: 'actions', label: 'Actions' },
  { tab: 'queries', label: 'Queries' },
  { tab: 'cards', label: 'Review cards' },
  { tab: 'roles', label: 'Roles' },
  { tab: 'share', label: 'Share' },
  { tab: 'history', label: 'History' },
  { tab: 'advanced', label: 'Advanced' },
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

  return (
    <div className="grid gap-5 pb-24">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="m-0 text-sm text-muted">
            <Link to={{ name: 'home' }}>Your apps</Link> / Build
          </p>
          <h1 className="m-0 text-2xl font-semibold tracking-tight">{summary.data.name}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Badge>revision {saved.data.revision}</Badge>
          <Link to={{ name: 'use', appId }} className="no-underline">
            <Button tabIndex={-1}>Open the app</Button>
          </Link>
        </div>
      </div>

      <nav aria-label="Building" className="flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((item) => (
          <Link
            key={item.tab}
            to={{ name: 'build', appId, tab: item.tab }}
            aria-current={item.tab === tab ? 'page' : undefined}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap no-underline ${item.tab === tab ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text'}`}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      {tab === 'data' ? <DataDesigner definition={draft} onChange={setDraft} /> : null}
      {tab === 'forms' ? <FormDesigner definition={draft} onChange={setDraft} /> : null}
      {tab === 'rules' ? <RulesDesigner definition={draft} onChange={setDraft} /> : null}
      {tab === 'actions' ? <ActionsDesigner definition={draft} onChange={setDraft} /> : null}
      {tab === 'queries' ? <QueriesDesigner definition={draft} onChange={setDraft} /> : null}
      {tab === 'cards' ? <CardsDesigner definition={draft} onChange={setDraft} /> : null}
      {tab === 'roles' ? <RolesDesigner definition={draft} onChange={setDraft} /> : null}
      {tab === 'share' ? <SharePanel appId={appId} definition={saved.data.definition} /> : null}
      {tab === 'advanced' ? <AdvancedPanel definition={draft} onChange={setDraft} /> : null}
      {tab === 'history' ? <HistoryPanel appId={appId} /> : null}

      {dirty ? (
        <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
            <p className="m-0 text-sm">
              <strong>Unsaved changes.</strong> <span className="text-muted">They apply to your sandbox once saved.</span>
            </p>
            <div className="flex gap-2">
              <Button onClick={() => setDraft(normalize(saved.data.definition))}>Discard</Button>
              <Button variant="primary" onClick={() => check.mutate()} disabled={check.isPending}>
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
  );
}

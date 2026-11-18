import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { ApiError, api, needsStepUp, stepUp } from '../api.js';
import { TestResults } from '../components/tests.js';
import { Badge, Button, Card, Checkbox, cx, Dialog, EmptyState, Field, Notice, TextInput } from '../components/ui.js';
import { Link, navigate } from '../router.js';
import type { AppSummary, ChangeRequest, Deployment, Me, PlanStep, Release } from '../types.js';

const ENV_NAMES = { prod: 'Prod', staging: 'Staging' } as const;
const SECTION_NAMES: Readonly<Record<string, string>> = {
  entities: 'Entity',
  rules: 'Rule',
  actions: 'Action',
  queries: 'Query',
  cards: 'Review card',
  forms: 'Form',
  roles: 'Role',
  pages: 'Page',
  processes: 'Process',
  flows: 'Flow',
  connections: 'Connection',
  webhooks: 'Webhook',
  tests: 'Test',
  navigation: 'The',
};
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const messageOf = (error: unknown) => (error instanceof ApiError ? error.message : 'Something went wrong');

/** Tells the person why the API refused, and offers a fresh MFA sign-in when that is what it needs. */
export function Problem({ error }: { error: unknown }) {
  if (!error) return null;
  if (needsStepUp(error)) {
    return (
      <Notice tone="warn">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span>This needs a fresh sign-in with MFA, because it changes Prod.</span>
          <Button size="sm" onClick={stepUp}>
            Sign in again
          </Button>
        </span>
      </Notice>
    );
  }
  return <Notice tone="bad">{messageOf(error)}</Notice>;
}

function Steps({ steps, empty }: { steps: readonly PlanStep[]; empty: string }) {
  if (!steps.length) return <p className="m-0 text-sm text-muted">{empty}</p>;
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0">
      {steps.map((step, i) => (
        <li key={i} className={cx('rounded-md px-3 py-1.5 text-sm', step.destructive ? 'bg-bad-bg text-bad' : 'bg-sunken')}>
          {step.description}
          {step.records !== undefined && step.destructive ? <strong> — {step.records} record(s) have values here</strong> : null}
        </li>
      ))}
    </ul>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <Card className="grid content-start gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-lg font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </Card>
  );
}

const STATUS_TONES = { open: 'accent', merged: 'good', closed: 'idle' } as const;
const DEPLOYMENT_TONES = { awaiting_approval: 'warn', approved: 'accent', succeeded: 'good', failed: 'bad', cancelled: 'idle' } as const;
const DEPLOYMENT_STATUS = {
  awaiting_approval: 'Waiting for approval',
  approved: 'Approved',
  succeeded: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
} as const;

/** Edit in my space: open the person's working copy of a team app, making it the first time. */
export function EditInMySpace({ app }: { app: AppSummary }) {
  const client = useQueryClient();
  const make = useMutation({
    mutationFn: () => api.workingCopy(app.id),
    onSuccess: async ({ app: copy }) => {
      await client.invalidateQueries({ queryKey: ['apps'] });
      navigate({ name: 'build', appId: copy.id, tab: 'data' });
    },
  });
  if (!app.access.edit) return null;
  if (app.myWorkingCopyId) {
    return (
      <Link to={{ name: 'build', appId: app.myWorkingCopyId, tab: 'data' }} className="no-underline">
        <Button variant="primary" tabIndex={-1}>
          Open my working copy
        </Button>
      </Link>
    );
  }
  return (
    <span className="grid gap-1">
      <Button variant="primary" onClick={() => make.mutate()} disabled={make.isPending}>
        {make.isPending ? 'Making your copy…' : 'Edit in my space'}
      </Button>
      {make.error ? <Problem error={make.error} /> : null}
    </span>
  );
}

/** The main line of a team app, which the designers show read-only. */
export function TeamAppNotice({ app }: { app: AppSummary }) {
  return (
    <Notice tone="good">
      <span className="flex flex-wrap items-center justify-between gap-3">
        <span>
          <strong>This is the team app's main line, at revision {app.revision}.</strong> It changes through change requests: edit it in your own space, then
          submit the change for review.
        </span>
        <EditInMySpace app={app} />
      </span>
    </Notice>
  );
}

/** A working copy: what it changes, how it stands, and submitting its changes. */
export function WorkingCopyBar({ app, dirty }: { app: AppSummary; dirty: boolean }) {
  const client = useQueryClient();
  const copy = app.workingCopyOf!;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [confirmLoss, setConfirmLoss] = useState(false);
  const refresh = () => Promise.all(['app', 'definition', 'apps', 'ui'].map((key) => client.invalidateQueries({ queryKey: [key] })));
  const submit = useMutation({
    mutationFn: () =>
      api.submit(app.id, { ...(title.trim() ? { title: title.trim() } : {}), ...(description.trim() ? { description: description.trim() } : {}) }),
    onSuccess: async (cr) => {
      setOpen(false);
      await refresh();
      navigate({ name: 'change', changeRequestId: cr.id });
    },
  });
  const sync = useMutation({ mutationFn: () => api.sync(app.id, confirmLoss), onSuccess: refresh });
  const destructiveSync = sync.error instanceof ApiError && sync.error.code === 'destructive_change';
  const conflicts =
    sync.error instanceof ApiError ? ((sync.error.details as { conflicts?: Array<{ section: string; name: string }> } | undefined)?.conflicts ?? []) : [];

  return (
    <Card className="grid gap-3 border-accent">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="m-0">
          <strong>Your working copy</strong> of the team app <Link to={{ name: 'build', appId: copy.appId, tab: 'delivery' }}>{copy.name}</Link>. Change it
          freely: it has sample data, never Prod data.
          {copy.behind ? <Badge tone="warn">The team app has newer changes</Badge> : null}
        </p>
        <div className="flex flex-wrap gap-2">
          {copy.behind ? (
            <Button onClick={() => sync.mutate()} disabled={sync.isPending || dirty}>
              {sync.isPending ? 'Taking them in…' : 'Take in newer changes'}
            </Button>
          ) : null}
          {copy.changeRequest ? (
            <>
              <Link to={{ name: 'change', changeRequestId: copy.changeRequest.id }} className="no-underline">
                <Button tabIndex={-1}>Change request #{copy.changeRequest.number}</Button>
              </Link>
              <Button
                variant="primary"
                onClick={() => submit.mutate()}
                disabled={submit.isPending || dirty}
                title={dirty ? 'Save your changes first' : undefined}
              >
                {submit.isPending ? 'Updating…' : `Update #${copy.changeRequest.number}`}
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => setOpen(true)} disabled={dirty} title={dirty ? 'Save your changes first' : undefined}>
              Submit change
            </Button>
          )}
        </div>
      </div>
      {submit.error && !open ? <Problem error={submit.error} /> : null}
      {sync.error ? (
        destructiveSync ? (
          <div className="grid gap-2">
            <Notice tone="warn">Taking in the newer changes deletes data in your copy.</Notice>
            <Checkbox label="I understand, and my copy's test data may go" checked={confirmLoss} onChange={setConfirmLoss} />
            <Button onClick={() => sync.mutate()} disabled={!confirmLoss}>
              Take them in
            </Button>
          </div>
        ) : (
          <Notice tone="bad">
            {messageOf(sync.error)}
            {conflicts.length ? ` In conflict: ${conflicts.map((c) => `${SECTION_NAMES[c.section] ?? c.section} ${c.name}`).join(', ')}.` : null}
          </Notice>
        )
      ) : null}
      <Dialog
        open={open}
        title="Submit your change"
        onClose={() => setOpen(false)}
        actions={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => submit.mutate()} disabled={submit.isPending || !title.trim()}>
              {submit.isPending ? 'Submitting…' : 'Submit for review'}
            </Button>
          </>
        }
      >
        <p className="m-0 text-sm text-muted">
          Reviewers in the team space see what changes, who gains or loses access, and which agent tools change. They can try it in a preview. Someone other
          than you approves it.
        </p>
        <Field label="What it does">
          {(id) => <TextInput id={id} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Record the vendor of each claim" />}
        </Field>
        <Field label="Why, and what to look at (optional)">
          {(id) => (
            <textarea
              id={id}
              rows={3}
              className="w-full rounded-sm border border-line-strong bg-surface px-2.5 py-1.5"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
        {submit.error ? <Problem error={submit.error} /> : null}
      </Dialog>
    </Card>
  );
}

/** A team app's change requests. */
export function ChangesPanel({ app }: { app: AppSummary }) {
  const list = useQuery({ queryKey: ['changes', app.id], queryFn: () => api.changeRequests(app.id) });
  const requests = list.data?.changeRequests ?? [];
  return (
    <Section title="Change requests" aside={<EditInMySpace app={app} />}>
      {list.data && !requests.length ? <EmptyState title="No change requests yet">Edit the app in your own space, then submit your change.</EmptyState> : null}
      <ul className="m-0 grid list-none gap-2 p-0">
        {requests.map((cr) => (
          <li key={cr.id}>
            <Link
              to={{ name: 'change', changeRequestId: cr.id }}
              className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2 text-text no-underline hover:bg-sunken"
            >
              <span className="font-semibold">#{cr.number}</span>
              <span className="min-w-0 flex-1">{cr.title}</span>
              {cr.destructive ? <Badge tone="bad">Deletes data</Badge> : null}
              <Badge tone={STATUS_TONES[cr.status]}>{cr.status}</Badge>
              <span className="text-sm text-muted">
                {cr.author.name} · {when(cr.updatedAt)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** One change request: what changes, the checks, the preview, reviews, and merging. */
export function ChangeRequestPage({ id, me }: { id: string; me: Me }) {
  const client = useQueryClient();
  const cr = useQuery({ queryKey: ['change', id], queryFn: () => api.changeRequest(id) });
  const team = useQuery({ queryKey: ['app', cr.data?.appId], queryFn: () => api.app(cr.data!.appId), enabled: Boolean(cr.data) });
  const [comment, setComment] = useState('');
  const refresh = async (next?: ChangeRequest) => {
    if (next) client.setQueryData(['change', id], next);
    await Promise.all(['change', 'changes', 'app', 'releases', 'deployments'].map((key) => client.invalidateQueries({ queryKey: [key] })));
  };
  const review = useMutation({
    mutationFn: (verdict: 'approve' | 'request_changes' | 'comment') => api.review(id, verdict, comment.trim() || undefined),
    onSuccess: async (next) => (setComment(''), await refresh(next)),
  });
  const merge = useMutation({ mutationFn: () => api.merge(id), onSuccess: refresh });
  const close = useMutation({ mutationFn: () => api.closeChange(id), onSuccess: refresh });

  if (cr.isError)
    return (
      <Notice tone="bad">
        {cr.error instanceof ApiError && cr.error.status === 403 ? "You can't see this change request." : "This change request can't be opened."}
      </Notice>
    );
  if (!cr.data || !team.data) return <p className="text-muted">Loading…</p>;
  const change = cr.data;
  const app = team.data;
  const delivery = app.access.delivery;
  const mine = change.author.id === me.id;
  const open = change.status === 'open';
  const { checks } = change;
  const mergeConflicts =
    merge.error instanceof ApiError ? ((merge.error.details as { conflicts?: ChangeRequest['conflicts'] } | undefined)?.conflicts ?? []) : [];

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="m-0 text-sm text-muted">
            <Link to={{ name: 'build', appId: app.id, tab: 'changes' }}>{app.name}</Link> / Change requests
          </p>
          <h1 className="m-0 text-2xl font-semibold tracking-tight">
            #{change.number} {change.title}
          </h1>
          <p className="m-0 mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            <Badge tone={STATUS_TONES[change.status]}>{change.status}</Badge>
            {change.destructive ? <Badge tone="bad">Deletes data</Badge> : null}
            by {change.author.name} · from revision {change.baseRevision} · {when(change.updatedAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {open && change.preview ? (
            <Link to={{ name: 'use', appId: app.id, env: change.preview.environmentId }} className="no-underline">
              <Button variant="primary" tabIndex={-1}>
                Try it in the preview
              </Button>
            </Link>
          ) : null}
          {open && (mine || delivery?.merge) ? (
            <Button onClick={() => close.mutate()} disabled={close.isPending}>
              Close without merging
            </Button>
          ) : null}
        </div>
      </div>
      {change.description ? <p className="m-0 whitespace-pre-line">{change.description}</p> : null}
      {close.error ? <Problem error={close.error} /> : null}
      {open && change.behind ? (
        <Notice tone={change.conflicts.length ? 'bad' : 'warn'}>
          The team app changed since this change began.{' '}
          {change.conflicts.length
            ? `Both changed ${change.conflicts.map((c) => `${SECTION_NAMES[c.section] ?? c.section} ${c.name}`).join(', ')}: the author takes in the newer changes in their working copy and submits again.`
            : 'They touch different parts, so merging combines them.'}
        </Notice>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="grid content-start gap-5">
          <Section title="What changes">
            {change.changes.length === 0 ? <p className="m-0 text-muted">Nothing.</p> : null}
            <ul className="m-0 grid list-none gap-2 p-0">
              {change.changes.map((c, i) => (
                <li key={i} className="rounded-md border border-line px-3 py-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <Badge tone={c.change === 'added' ? 'good' : c.change === 'removed' ? 'bad' : 'accent'}>{c.change}</Badge>
                    <span className="text-sm text-muted">{SECTION_NAMES[c.section] ?? c.section}</span>
                    <strong>{c.name}</strong>
                  </span>
                  {c.details.length ? (
                    <ul className="m-0 mt-1 pl-5 text-sm text-muted">
                      {c.details.map((detail, j) => (
                        <li key={j}>{detail}</li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Who gains or loses access">
            {checks.access.length === 0 ? <p className="m-0 text-muted">Nobody's access changes.</p> : null}
            <ul className="m-0 grid list-none gap-1.5 p-0">
              {checks.access.map((a, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge tone={a.kind === 'gains' ? 'warn' : a.kind === 'loses' ? 'bad' : 'idle'}>{a.kind}</Badge>
                  <span className="flex-1">{a.text}</span>
                  {a.holders ? <span className="text-faint">{a.holders} hold it now</span> : null}
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Agent tools">
            {checks.capabilities.length === 0 ? <p className="m-0 text-muted">The tools agents see stay the same.</p> : null}
            <ul className="m-0 grid list-none gap-1.5 p-0">
              {checks.capabilities.map((c, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <Badge tone={c.change === 'added' ? 'agent' : c.change === 'removed' ? 'bad' : 'idle'}>{c.change}</Badge>
                  <span>{c.text}</span>
                </li>
              ))}
            </ul>
          </Section>
          {checks.tests ? (
            <Section title="Tests">
              <TestResults run={checks.tests} />
              {checks.tests.failed ? <Notice tone="bad">A change whose tests fail doesn't merge. The author puts it right and submits it again.</Notice> : null}
            </Section>
          ) : null}
          <Section title="Data in Prod">
            <Steps steps={checks.migration.steps} empty="No change to the data model: names, labels, forms or rules only." />
            {checks.migration.destructive ? (
              <Notice tone="bad">This deletes data. It goes into a release of its own, and that release can't be rolled back.</Notice>
            ) : null}
          </Section>
          {checks.lint.length || checks.validation.notes.length ? (
            <Section title="Worth a look">
              <ul className="m-0 grid gap-1 pl-5 text-sm">
                {[...checks.lint, ...checks.validation.notes].map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>

        <div className="grid content-start gap-5">
          <Section title="Review">
            <p className="m-0 flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={change.approvals.ready ? 'good' : 'warn'}>
                {change.approvals.approvedBy.length} of {change.approvals.required} approval{change.approvals.required === 1 ? '' : 's'}
              </Badge>
              {change.approvals.changesRequestedBy.length ? <Badge tone="bad">Changes asked for</Badge> : null}
            </p>
            <ul className="m-0 grid list-none gap-2 p-0">
              {change.reviews.map((r) => (
                <li key={r.id} className={cx('rounded-md border border-line px-3 py-2 text-sm', !r.current && 'opacity-60')}>
                  <span className="flex flex-wrap items-center gap-2">
                    <strong>{r.reviewer.name}</strong>
                    <Badge tone={r.verdict === 'approve' ? 'good' : r.verdict === 'request_changes' ? 'bad' : 'idle'}>
                      {r.verdict === 'approve' ? 'approved' : r.verdict === 'request_changes' ? 'asked for changes' : 'commented'}
                    </Badge>
                    {!r.current ? <span className="text-faint">on an earlier version</span> : null}
                  </span>
                  {r.comment ? <p className="m-0 mt-1 whitespace-pre-line">{r.comment}</p> : null}
                </li>
              ))}
            </ul>
            {open && (delivery?.review || delivery?.approve) ? (
              <div className="grid gap-2">
                <Field label="Comment">
                  {(fieldId) => (
                    <textarea
                      id={fieldId}
                      rows={3}
                      className="w-full rounded-sm border border-line-strong bg-surface px-2.5 py-1.5"
                      value={comment}
                      onChange={(e) => setComment(e.target.value)}
                    />
                  )}
                </Field>
                <div className="flex flex-wrap gap-2">
                  {delivery.approve && !mine ? (
                    <Button variant="primary" onClick={() => review.mutate('approve')} disabled={review.isPending}>
                      Approve
                    </Button>
                  ) : null}
                  {delivery.review ? (
                    <>
                      <Button onClick={() => review.mutate('request_changes')} disabled={review.isPending || !comment.trim()}>
                        Ask for changes
                      </Button>
                      <Button variant="ghost" onClick={() => review.mutate('comment')} disabled={review.isPending || !comment.trim()}>
                        Comment
                      </Button>
                    </>
                  ) : null}
                </div>
                {review.error ? <Problem error={review.error} /> : null}
              </div>
            ) : null}
            {open && mine ? <p className="m-0 text-xs text-faint">Someone other than you approves your change.</p> : null}
          </Section>
          {open && delivery?.merge ? (
            <Section title="Merge">
              <p className="m-0 text-sm text-muted">Merging puts the change on the team app's main line. A release then takes it to Staging and Prod.</p>
              <Button variant="primary" onClick={() => merge.mutate()} disabled={merge.isPending || !change.approvals.ready}>
                {merge.isPending ? 'Merging…' : 'Merge'}
              </Button>
              {merge.error ? <Problem error={merge.error} /> : null}
              {mergeConflicts.length ? (
                <ul className="m-0 pl-5 text-sm">
                  {mergeConflicts.map((c, i) => (
                    <li key={i}>
                      {SECTION_NAMES[c.section] ?? c.section} {c.name}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Section>
          ) : null}
          {change.status === 'merged' ? (
            <Notice tone="good">Merged as revision {change.mergedRevision}. Cut a release to take it to Staging and Prod.</Notice>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** A team app's environments, releases and deployments: deploying, approving and rolling back. */
export function DeliveryPanel({ app }: { app: AppSummary }) {
  const client = useQueryClient();
  const deployments = useQuery({ queryKey: ['deployments', app.id], queryFn: () => api.deployments(app.id) });
  const releases = useQuery({ queryKey: ['releases', app.id], queryFn: () => api.releases(app.id) });
  const [cutting, setCutting] = useState(false);
  const [notes, setNotes] = useState('');
  const [destructive, setDestructive] = useState<{ release: Release; env: 'staging' | 'prod'; steps: PlanStep[] } | null>(null);
  const [confirmLoss, setConfirmLoss] = useState(false);
  const [rollingBack, setRollingBack] = useState<'staging' | 'prod' | null>(null);
  const refresh = () => Promise.all(['deployments', 'releases', 'app', 'apps', 'ui'].map((key) => client.invalidateQueries({ queryKey: [key] })));
  const delivery = app.access.delivery!;

  const cut = useMutation({
    mutationFn: (revision?: number) => api.cutRelease(app.id, { ...(revision ? { revision } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) }),
    onSuccess: async () => (setCutting(false), setNotes(''), await refresh()),
  });
  const request = useMutation({
    mutationFn: ({ release, env, confirm }: { release: Release; env: 'staging' | 'prod'; confirm: boolean }) =>
      api.requestDeployment(app.id, { releaseId: release.id, env, confirmDestructive: confirm, execute: env === 'staging' }),
    onSuccess: async () => (setDestructive(null), setConfirmLoss(false), await refresh()),
    onError: (error, { release, env }) => {
      if (error instanceof ApiError && error.code === 'destructive_change') {
        setDestructive({ release, env, steps: (error.details as { plan: { steps: PlanStep[] } }).plan.steps });
      }
    },
  });
  const act = useMutation({
    mutationFn: ({ deployment, what }: { deployment: Deployment; what: 'approve' | 'execute' | 'cancel' }) =>
      what === 'approve'
        ? api.approveDeployment(deployment.id)
        : what === 'execute'
          ? api.executeDeployment(deployment.id)
          : api.cancelDeployment(deployment.id),
    onSettled: refresh,
  });
  const rollback = useMutation({
    mutationFn: (env: 'staging' | 'prod') => api.rollback(app.id, env),
    onSuccess: async () => (setRollingBack(null), await refresh()),
  });

  const environments = deployments.data?.environments ?? [];
  const all = deployments.data?.deployments ?? [];
  const waiting = all.filter((d) => d.status === 'awaiting_approval' || d.status === 'approved');
  const done = all.filter((d) => !waiting.includes(d));
  const releaseList = releases.data?.releases ?? [];
  const cutConflict =
    cut.error instanceof ApiError && cut.error.code === 'destructive_change_alone'
      ? (cut.error.details as { suggestedRevision: number }).suggestedRevision
      : null;

  return (
    <div className="grid gap-5">
      <div className="grid gap-4 md:grid-cols-2">
        {(['prod', 'staging'] as const).map((kind) => {
          const env = environments.find((e) => e.kind === kind);
          return (
            <Card key={kind} className="grid content-start gap-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="m-0 text-lg font-semibold">{ENV_NAMES[kind]}</h2>
                {env?.release ? <Badge tone="good">Release {env.release.number} live</Badge> : <Badge>Not deployed</Badge>}
              </div>
              <p className="m-0 text-sm text-muted">
                {kind === 'prod'
                  ? 'Where people and their agents use the app. Deploying needs an approval and a fresh MFA sign-in.'
                  : 'Optional: test a release against other systems’ test instances before Prod.'}
              </p>
              {env?.release ? (
                <div className="flex flex-wrap gap-2">
                  <Link to={{ name: 'use', appId: app.id, ...(kind === 'staging' ? { env: 'staging' } : {}) }} className="no-underline">
                    <Button size="sm" tabIndex={-1}>
                      Open {ENV_NAMES[kind]}
                    </Button>
                  </Link>
                  {delivery.rollback ? (
                    <Button size="sm" variant="danger" onClick={() => setRollingBack(kind)}>
                      Roll back
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </Card>
          );
        })}
      </div>
      {act.error ? <Problem error={act.error} /> : null}
      {request.error && !destructive ? <Problem error={request.error} /> : null}

      {waiting.length ? (
        <Section title="Waiting">
          <ul className="m-0 grid list-none gap-3 p-0">
            {waiting.map((d) => (
              <li key={d.id} className="grid gap-2 rounded-md border border-line p-3">
                <p className="m-0 flex flex-wrap items-center gap-2">
                  <strong>
                    Release {d.release.number} to {ENV_NAMES[d.environment]}
                  </strong>
                  <Badge tone={DEPLOYMENT_TONES[d.status]}>{DEPLOYMENT_STATUS[d.status]}</Badge>
                  {d.destructive ? <Badge tone="bad">Deletes data</Badge> : null}
                  <span className="text-sm text-muted">
                    {d.approvals.by.length} of {d.approvals.required} approvals
                    {d.approvals.by.length ? ` (${d.approvals.by.map((p) => p.name).join(', ')})` : ''}
                  </span>
                </p>
                <Steps steps={d.plan.steps} empty="No change to the data model." />
                {d.plan.notes.map((note, i) => (
                  <p key={i} className="m-0 text-sm text-muted">
                    {note}
                  </p>
                ))}
                {d.authors.length ? (
                  <p className="m-0 text-xs text-faint">Holds changes by {d.authors.map((p) => p.name).join(', ')}, who can't approve it.</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {d.status === 'awaiting_approval' && delivery.approveDeploy ? (
                    <Button size="sm" variant="primary" onClick={() => act.mutate({ deployment: d, what: 'approve' })} disabled={act.isPending}>
                      Approve
                    </Button>
                  ) : null}
                  {d.status === 'approved' && delivery.execute ? (
                    <Button size="sm" variant="primary" onClick={() => act.mutate({ deployment: d, what: 'execute' })} disabled={act.isPending}>
                      Deploy now
                    </Button>
                  ) : null}
                  {delivery.deploy ? (
                    <Button size="sm" variant="ghost" onClick={() => act.mutate({ deployment: d, what: 'cancel' })} disabled={act.isPending}>
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section
        title="Releases"
        aside={
          delivery.release ? (
            <Button variant="primary" onClick={() => setCutting(true)}>
              Cut a release
            </Button>
          ) : null
        }
      >
        {releases.data && !releaseList.length ? (
          <EmptyState title="No releases yet">Merge a change request, then cut a release from the main line.</EmptyState>
        ) : null}
        <ul className="m-0 grid list-none gap-2 p-0">
          {releaseList.map((release) => (
            <li key={release.id} className="grid gap-2 rounded-md border border-line px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <strong>Release {release.number}</strong>
                <span className="text-sm text-muted">revision {release.revision}</span>
                {release.verified ? <Badge tone="good">Signed</Badge> : <Badge tone="bad">Signature does not match</Badge>}
                {release.destructive ? <Badge tone="bad">Deletes data</Badge> : null}
                {release.liveIn.map((kind) => (
                  <Badge key={kind} tone="accent">
                    Live in {ENV_NAMES[kind]}
                  </Badge>
                ))}
                <span className="flex-1" />
                {delivery.deploy && !release.liveIn.includes('staging') ? (
                  <Button size="sm" onClick={() => request.mutate({ release, env: 'staging', confirm: false })} disabled={request.isPending}>
                    Deploy to Staging
                  </Button>
                ) : null}
                {delivery.deploy && !release.liveIn.includes('prod') ? (
                  <Button size="sm" variant="primary" onClick={() => request.mutate({ release, env: 'prod', confirm: false })} disabled={request.isPending}>
                    Ask to deploy to Prod
                  </Button>
                ) : null}
              </div>
              <p className="m-0 text-sm text-muted">
                {release.changes.length ? release.changes.map((c) => `#${c.number} ${c.title}`).join(' · ') : 'No change requests'}
                {release.createdBy ? ` · cut by ${release.createdBy.name}` : ''} · {when(release.createdAt)}
              </p>
              {release.notes ? <p className="m-0 text-sm">{release.notes}</p> : null}
            </li>
          ))}
        </ul>
      </Section>

      {done.length ? (
        <Section title="History">
          <ul className="m-0 grid list-none gap-1.5 p-0 text-sm">
            {done.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2">
                <Badge tone={DEPLOYMENT_TONES[d.status]}>{d.kind === 'rollback' ? 'Rolled back' : DEPLOYMENT_STATUS[d.status]}</Badge>
                <span>
                  {ENV_NAMES[d.environment]}: release {d.fromRelease ? `${d.fromRelease.number} → ` : ''}
                  {d.release.number}
                </span>
                <span className="text-muted">
                  {d.executedBy ? `by ${d.executedBy.name} · ` : ''}
                  {when(d.finishedAt ?? d.requestedAt)}
                  {d.durationMs !== null ? ` · ${d.durationMs < 1000 ? `${d.durationMs} ms` : `${(d.durationMs / 1000).toFixed(1)} s`}` : ''}
                </span>
                {d.error ? <span className="text-bad">{d.error}</span> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Dialog
        open={cutting}
        title="Cut a release"
        onClose={() => setCutting(false)}
        actions={
          <>
            <Button onClick={() => setCutting(false)}>Cancel</Button>
            {cutConflict ? (
              <Button variant="primary" onClick={() => cut.mutate(cutConflict)} disabled={cut.isPending}>
                Release revision {cutConflict}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => cut.mutate(undefined)} disabled={cut.isPending}>
                {cut.isPending ? 'Cutting…' : `Release revision ${app.revision}`}
              </Button>
            )}
          </>
        }
      >
        <p className="m-0 text-sm text-muted">
          A release is the main line at one revision, hashed and signed. It never changes; rolling back makes an earlier one live again.
        </p>
        <Field label="Notes (optional)">{(id) => <TextInput id={id} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        {cut.error ? <Problem error={cut.error} /> : null}
      </Dialog>

      <Dialog
        open={destructive !== null}
        title="This deployment deletes data"
        onClose={() => setDestructive(null)}
        actions={
          <>
            <Button onClick={() => setDestructive(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => destructive && request.mutate({ release: destructive.release, env: destructive.env, confirm: true })}
              disabled={!confirmLoss || request.isPending}
            >
              Ask to deploy
            </Button>
          </>
        }
      >
        <Steps steps={destructive?.steps ?? []} empty="" />
        <p className="m-0 text-sm text-muted">Data that goes can't come back, and this release can't be rolled back afterwards.</p>
        <Checkbox label="I understand this deletes data, and it can't be undone" checked={confirmLoss} onChange={setConfirmLoss} />
        {request.error && destructive ? <Problem error={request.error} /> : null}
      </Dialog>

      <Dialog
        open={rollingBack !== null}
        title={`Roll ${rollingBack ? ENV_NAMES[rollingBack] : ''} back?`}
        onClose={() => setRollingBack(null)}
        actions={
          <>
            <Button onClick={() => setRollingBack(null)}>Cancel</Button>
            <Button variant="danger" onClick={() => rollingBack && rollback.mutate(rollingBack)} disabled={rollback.isPending}>
              {rollback.isPending ? 'Rolling back…' : 'Roll back now'}
            </Button>
          </>
        }
      >
        <p className="m-0 text-sm">
          The release that ran here before becomes live again, at once. Data stays as it is: the older release ignores what the newer one added.
        </p>
        {rollback.error ? <Problem error={rollback.error} /> : null}
      </Dialog>
    </div>
  );
}

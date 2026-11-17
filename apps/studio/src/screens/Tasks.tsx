import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, type AppAt } from '../api.js';
import { PersonName, PersonPicker } from '../components/people.js';
import { Badge, Button, Card, EmptyState, Field, Notice, TextInput } from '../components/ui.js';
import { Link } from '../router.js';
import type { ProcessInstance, Task } from '../types.js';

const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const WHEN = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** When a task is due, in words, and whether it is late. */
function Due({ task }: { task: Task }) {
  if (!task.due) return null;
  return task.overdue ? <Badge tone="bad">Late since {DAY.format(new Date(task.due))}</Badge> : <Badge tone="warn">Due {DAY.format(new Date(task.due))}</Badge>;
}

/**
 * The outcomes of a task, as buttons. An outcome that runs an action runs it as the person, under
 * their permissions, with the checks of the action; its commit completes the task.
 */
export function TaskOutcomes({ task, onDone }: { task: Task; onDone?: () => void }) {
  const client = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const [review, setReview] = useState<string | null>(null);
  const [handing, setHanding] = useState(false);
  const [to, setTo] = useState<string | null>(null);
  const refresh = () => Promise.all(['tasks', 'processes'].map((key) => client.invalidateQueries({ queryKey: [key] })));
  const take = useMutation({ mutationFn: () => api.claimTask(task.id), onSuccess: refresh });
  const hand = useMutation({
    mutationFn: (userId: string) => api.reassignTask(task.id, userId),
    onSuccess: async () => {
      setHanding(false);
      await refresh();
    },
  });
  const decide = useMutation({
    mutationFn: (outcome: string) => api.completeTask(task.id, outcome),
    onSuccess: async ({ result }) => {
      if (result?.status === 'needs_confirmation') setReview(result.proposal.reviewUrl);
      await Promise.all(['tasks', 'record', 'records', 'history', 'processes'].map((key) => client.invalidateQueries({ queryKey: [key] })));
      onDone?.();
    },
  });
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        {task.outcomes.map((outcome, index) => (
          <Button key={outcome.name} variant={index === 0 ? 'primary' : 'secondary'} size="sm" onClick={() => decide.mutate(outcome.name)} disabled={decide.isPending}>
            {outcome.label}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {task.assignee ? null : (
          <Button size="sm" variant="ghost" onClick={() => take.mutate()} disabled={take.isPending}>
            Take it
          </Button>
        )}
        {task.assignee?.id === me.data?.id && !task.several ? (
          <Button size="sm" variant="ghost" onClick={() => setHanding(!handing)}>
            Hand over
          </Button>
        ) : null}
      </div>
      {handing ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56">
            <PersonPicker id={`hand-${task.id}`} label="To" value={to} onChange={setTo} />
          </div>
          <Button size="sm" variant="primary" disabled={!to || hand.isPending} onClick={() => to && hand.mutate(to)}>
            Hand it over
          </Button>
        </div>
      ) : null}
      {[decide.error, take.error, hand.error].map((error, index) =>
        error ? (
          <Notice key={index} tone="bad">
            {error instanceof ApiError ? error.message : 'Something went wrong'}
          </Notice>
        ) : null,
      )}
      {review ? (
        <Notice tone="warn">
          It waits for your approval: <a href={review}>review it</a>.
        </Notice>
      ) : null}
    </div>
  );
}

/** The person's tasks across apps (design §6.10): theirs, and those of their roles that wait for nobody in particular. */
export function Tasks() {
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const tasks = useQuery({ queryKey: ['tasks', status], queryFn: () => api.tasks(status) });
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="m-0 text-sm text-muted">
            <Link to={{ name: 'home' }}>Your apps</Link> / Tasks
          </p>
          <h1 className="m-0 text-2xl font-semibold tracking-tight">Your tasks</h1>
        </div>
        <div className="flex gap-1" role="group" aria-label="Which tasks">
          <Button size="sm" variant={status === 'open' ? 'primary' : 'secondary'} onClick={() => setStatus('open')}>
            To do
          </Button>
          <Button size="sm" variant={status === 'closed' ? 'primary' : 'secondary'} onClick={() => setStatus('closed')}>
            Done
          </Button>
        </div>
      </div>
      {tasks.isError ? <Notice tone="bad">Your tasks can't be loaded right now.</Notice> : null}
      {status === 'open' ? <Cover /> : null}
      {tasks.data && !tasks.data.tasks.length ? (
        <EmptyState title={status === 'open' ? 'Nothing waits for you' : 'Nothing done yet'}>
          {status === 'open' ? 'Tasks from the processes of your apps appear here when they need you.' : 'The tasks you finish appear here.'}
        </EmptyState>
      ) : null}
      <ul className="m-0 grid list-none gap-3 p-0">
        {tasks.data?.tasks.map((task) => (
          <li key={task.id}>
            <Card className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="m-0 text-xs text-muted">{task.app.name}</p>
                  <h2 className="m-0 text-base font-semibold">{task.name}</h2>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {status === 'open' ? <Due task={task} /> : <Badge tone={task.status === 'completed' ? 'good' : 'idle'}>{task.status === 'completed' ? (task.outcomes.find((o) => o.name === task.outcome)?.label ?? task.outcome) : 'Cancelled'}</Badge>}
                  {task.assignee ? null : <Badge>For the role {task.role}</Badge>}
                  {task.several ? <Badge tone="accent">{task.voters ? `Your vote, of ${task.voters}` : 'Your vote'}</Badge> : null}
                </div>
              </div>
              <Link to={{ name: 'use', appId: task.app.id, page: task.entity, recordId: task.recordId, env: task.environment.id }}>Open the record</Link>
              {status === 'open' ? <TaskOutcomes task={task} /> : null}
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Who takes the person's tasks while they are away, and until when. */
function Cover() {
  const client = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const current = useQuery({ queryKey: ['cover', me.data?.id], queryFn: () => api.cover(me.data!.id), enabled: Boolean(me.data) });
  const [who, setWho] = useState<string | null>(null);
  const [until, setUntil] = useState('');
  const save = useMutation({
    mutationFn: (coverId: string | null) => api.setCover(coverId, until ? new Date(`${until}T23:59:59`).toISOString() : undefined),
    onSuccess: () => client.invalidateQueries({ queryKey: ['cover'] }),
  });
  if (!current.data) return null;
  return (
    <Card className="grid gap-3">
      <h2 className="m-0 text-base font-semibold">While you're away</h2>
      {current.data.coverId ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            <PersonName id={current.data.coverId} /> takes your new tasks{current.data.coverUntil ? ` until ${DAY.format(new Date(current.data.coverUntil))}` : ''}.
          </span>
          <Button size="sm" onClick={() => save.mutate(null)} disabled={save.isPending}>
            I'm back
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56">
            <PersonPicker id="cover" label="Who takes your new tasks" value={who} onChange={setWho} />
          </div>
          <Field label="Until">{(id) => <TextInput id={id} type="date" value={until} onChange={(event) => setUntil(event.target.value)} />}</Field>
          <Button size="sm" variant="primary" disabled={!who || save.isPending} onClick={() => save.mutate(who)}>
            Hand over while away
          </Button>
        </div>
      )}
      {save.error ? <Notice tone="bad">{save.error instanceof ApiError ? save.error.message : 'Something went wrong'}</Notice> : null}
    </Card>
  );
}

/** How many tasks wait for the person: the count beside Tasks in the header. */
export function TaskCount() {
  const tasks = useQuery({ queryKey: ['tasks', 'open'], queryFn: () => api.tasks('open'), refetchInterval: 60_000 });
  const count = tasks.data?.tasks.length ?? 0;
  return (
    <Link to={{ name: 'tasks' }} className="flex items-center gap-1.5 text-sm no-underline">
      Tasks
      {count ? <Badge tone="accent">{count}</Badge> : null}
    </Link>
  );
}

const EVENTS: Readonly<Record<string, string>> = {
  started: 'Started',
  task_opened: 'Task opened',
  voted: 'Voted',
  task_completed: 'Decided',
  task_cancelled: 'Task closed',
  reassigned: 'Handed over',
  timer_fired: 'Timer fired',
  message: 'Action saved',
  condition: 'Condition met',
  ran: 'Ran',
  error_caught: 'Error caught',
  escalated: 'Escalated',
  signalled: 'Signal thrown',
  signal: 'Signal heard',
  compensated: 'Undone',
  transaction_cancelled: 'Transaction cancelled',
  sent: 'Sent a message',
  checked: 'Checked the rules',
  reached: 'Milestone reached',
  entered: 'Sub-process started',
  exited: 'Sub-process done',
  called: 'Called a process',
  returned: 'Called process done',
  stuck: 'Stuck',
  retried: 'Tried again',
  ended: 'Ended',
  cancelled: 'Cancelled',
};

/** Where the flows that wait on a record are, who and what they wait for, and the person's own decisions on it. */
export function ProcessCard({ at, entity, recordId }: { at: AppAt; entity: string; recordId: string }) {
  const processes = useQuery({ queryKey: ['processes', at.id, at.env, entity, recordId], queryFn: () => api.recordProcesses(at, entity, recordId) });
  const mine = useQuery({ queryKey: ['tasks', 'open'], queryFn: () => api.tasks('open') });
  const instances = processes.data?.instances ?? [];
  if (!instances.length) return null;
  const myTasks = new Set((mine.data?.tasks ?? []).map((task) => task.id));
  return (
    <Card className="grid content-start gap-3">
      <h3 className="m-0 text-sm font-semibold text-muted">Flows</h3>
      {instances.map((instance) => (
        <InstanceView key={instance.id} instance={instance} myTasks={myTasks} />
      ))}
    </Card>
  );
}

function InstanceView({ instance, myTasks }: { instance: ProcessInstance; myTasks: ReadonlySet<string> }) {
  const open = (instance.tasks ?? []).filter((task) => task.status === 'open');
  // What it waits for besides people's tasks: a time, an action, a condition, or the first of several.
  const waits = instance.status === 'running' ? instance.waiting.filter((wait) => !open.some((task) => task.name === wait.name)) : [];
  return (
    <div className="grid gap-2 border-t border-line pt-2 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <strong className="text-sm">{instance.label}</strong>
        <Badge tone={instance.status === 'running' ? (instance.stuck.length ? 'bad' : 'accent') : instance.status === 'completed' ? 'good' : 'idle'}>
          {instance.status === 'running' ? (instance.stuck.length ? 'Stuck' : 'Running') : instance.status === 'completed' ? 'Done' : 'Cancelled'}
        </Badge>
      </div>
      {open.map((task) => (
        <div key={task.id} className="grid gap-2 rounded-md bg-sunken p-2">
          <p className="m-0 text-sm">
            <strong>{task.name}</strong> waits for {task.assignee ? <PersonName id={task.assignee.id} /> : `anyone with the role ${task.role}`}
            {task.due ? <> · due {DAY.format(new Date(task.due))}</> : null}
          </p>
          {myTasks.has(task.id) ? <TaskOutcomes task={task} /> : null}
        </div>
      ))}
      {waits.map((wait) => (
        <p key={wait.element} className="m-0 text-sm text-muted">
          {wait.name}
        </p>
      ))}
      {instance.stuck.map((stuck) => (
        <Notice key={stuck.element} tone="bad">
          Stuck at {stuck.name}: {stuck.error}
        </Notice>
      ))}
      {instance.events?.length ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted">What happened</summary>
          <ol className="m-0 mt-2 grid list-none gap-1 p-0 text-xs">
            {instance.events.map((event, index) => (
              <li key={index} className="flex flex-wrap gap-1">
                <span className="text-muted">{WHEN.format(new Date(event.at))}</span>
                <span>
                  {EVENTS[event.kind] ?? event.kind}
                  {event.name ? `: ${event.name}` : ''}
                </span>
                {event.by ? (
                  <span className="text-muted">
                    by <PersonName id={event.by} />
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

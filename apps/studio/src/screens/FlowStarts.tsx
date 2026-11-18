import { flowSubject, flowWaits, kindOfType, scheduleWords, WEEKDAYS, type FlowStart, type Schedule } from '@platform/app-model';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api.js';
import { ConditionEditor } from '../components/condition.js';
import { DateShift, DurationInput } from '../components/duration.js';
import { Button, Card, Checkbox, Field, Notice, Select, TextInput } from '../components/ui.js';
import { updateFlow, variableChoices } from '../model/flows.js';
import type { Definition } from '../types.js';

/*
 * How a flow starts (design §6.11): the actions that run it and the roles that may run it by hand;
 * for a flow that waits, how it starts by itself on a record; for a flow that needs no input, the
 * schedule it runs on, and when it runs next.
 */

export function HowItStarts({
  appId,
  definition,
  name,
  readOnly,
  dirty,
  onChange,
}: {
  appId: string;
  definition: Definition;
  name: string;
  readOnly: boolean;
  /** Whether the draft has changes not saved: when the flow runs next is known once it is saved. */
  dirty: boolean;
  onChange: (definition: Definition) => void;
}) {
  const flow = definition.flows![name]!;
  const waits = flowWaits(flow, definition.flows);
  const subject = flowSubject(flow);
  const actions = Object.values(definition.actions).filter((action) => action.flow?.flow === name);
  const shaping = Object.values(definition.actions).filter((action) => action.before?.flow === name);
  const roles = Object.values(definition.roles).filter((role) => role.flows?.includes(name));
  const entity = subject ? definition.entities[subject.entity] : undefined;
  const update = (patch: Parameters<typeof updateFlow>[2]) => onChange(updateFlow(definition, name, patch));
  return (
    <Card className="grid gap-2 p-4" aria-label="How it starts">
      <h3 className="m-0 text-base font-semibold">How it starts</h3>
      {waits ? (
        <p className="m-0 text-sm text-muted">
          This flow waits for people and for time, so it keeps its place on one {entity?.label.toLowerCase() ?? 'record'}. A bar on the canvas marks each place where it saves before it waits.
        </p>
      ) : null}
      {actions.length ? (
        <p className="m-0 text-sm">
          {actions.map((action) => action.label).join(', ')} {waits ? 'start' : 'run'}
          {actions.length === 1 ? 's' : ''} it, as {actions.length === 1 ? 'it saves its' : 'they save their'} record.
        </p>
      ) : null}
      {shaping.length ? (
        <p className="m-0 text-sm">
          {shaping.map((action) => action.label).join(', ')} run{shaping.length === 1 ? 's' : ''} it before {shaping.length === 1 ? 'it saves its' : 'they save their'} record, and for{' '}
          {shaping.length === 1 ? 'its' : 'their'} previews: it checks the record and changes it, and changes nothing else.
        </p>
      ) : null}
      {roles.length ? (
        <p className="m-0 text-sm">
          {roles.map((role) => role.label).join(', ')} may {waits ? 'start it on a record' : 'run it'} by hand.
        </p>
      ) : null}
      {waits ? (
        <StartsEditor definition={definition} name={name} readOnly={readOnly} onChange={(starts) => update({ starts })} />
      ) : shaping.length ? null : (
        <ScheduleEditor appId={appId} definition={definition} name={name} readOnly={readOnly} dirty={dirty} onChange={(schedule) => update({ schedule })} />
      )}
      {!actions.length && !shaping.length && !roles.length && !flow.starts?.length && !flow.schedule ? <Notice tone="warn">Nothing starts it yet: have an action run it, let a role run it, or let it start by itself.</Notice> : null}
    </Card>
  );
}

type StartKind = 'created' | 'created_after' | 'date' | 'condition' | 'signal';
const kindOf = (start: FlowStart): StartKind => ('created' in start ? (start.after ? 'created_after' : 'created') : 'date' in start ? 'date' : 'condition' in start ? 'condition' : 'signal');

/** How a flow that waits starts by itself on a record: as the record is created, on a date of it, when a condition comes to hold, or on a signal. */
function StartsEditor({ definition, name, readOnly, onChange }: { definition: Definition; name: string; readOnly: boolean; onChange: (starts: FlowStart[] | undefined) => void }) {
  const flow = definition.flows![name]!;
  const subject = flowSubject(flow);
  if (!subject) return null;
  const entity = definition.entities[subject.entity];
  const dates = (entity?.fields ?? []).filter((field) => field.type === 'date' || field.type === 'datetime');
  // A condition reads the record the flow is about, by its input's name.
  const choices = variableChoices(definition, new Map(Object.entries(flow.input).map(([input, type]) => [input, kindOfType(type)])));
  const starts = flow.starts ?? [];
  const fresh = (kind: StartKind): FlowStart =>
    kind === 'created_after'
      ? { created: true, after: 'P1D' }
      : kind === 'date' && dates[0]
        ? { date: dates[0].name }
        : kind === 'condition'
          ? { condition: { exists: `${subject.name}.id` } }
          : kind === 'signal'
            ? { signal: 'go' }
            : { created: true };
  const change = (index: number, start: FlowStart) => onChange(starts.map((each, i) => (i === index ? start : each)));
  const remove = (index: number) => {
    const rest = starts.filter((_, i) => i !== index);
    onChange(rest.length ? rest : undefined);
  };
  return (
    <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3" disabled={readOnly}>
      <legend className="px-1 text-sm text-muted">It starts by itself</legend>
      {starts.map((start, index) => (
        <div key={index} className="grid gap-2 rounded-md border border-line p-2" data-testid={`flow-start-${index}`}>
          <div className="flex items-end gap-2">
            <Field label={`Start ${index + 1}`}>
              {(id) => (
                <Select id={id} value={kindOf(start)} onChange={(e) => change(index, fresh(e.target.value as StartKind))}>
                  <option value="created">When a {entity?.label.toLowerCase() ?? 'record'} is created</option>
                  <option value="created_after">A time after one is created</option>
                  <option value="date" disabled={!dates.length}>
                    On a date of the record
                  </option>
                  <option value="condition">When a condition comes to hold</option>
                  <option value="signal">On a signal</option>
                </Select>
              )}
            </Field>
            <Button size="sm" variant="ghost" aria-label={`Remove start ${index + 1}`} onClick={() => remove(index)}>
              ✕
            </Button>
          </div>
          {'created' in start && start.after ? <DurationInput label="How long after" value={start.after} onChange={(after) => change(index, { created: true, after })} /> : null}
          {'date' in start ? (
            <>
              <Field label="The date">
                {(id) => (
                  <Select id={id} value={start.date} onChange={(e) => change(index, { ...start, date: e.target.value })}>
                    {dates.map((field) => (
                      <option key={field.name} value={field.name}>
                        The record's {field.label.toLowerCase()}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <DateShift label="When" value={start} onChange={(shift) => change(index, { date: start.date, ...shift })} />
            </>
          ) : null}
          {'condition' in start ? <ConditionEditor label="When a change makes it hold that" value={start.condition} choices={choices} compareWith={choices} onChange={(condition) => change(index, { condition: condition ?? start.condition })} /> : null}
          {'signal' in start ? (
            <Field label="The signal" hint="An operator, or another flow, throws it for the record.">
              {(id) => <TextInput id={id} className="font-mono" value={start.signal} onChange={(e) => change(index, { signal: e.target.value.trim() })} />}
            </Field>
          ) : null}
        </div>
      ))}
      {starts.length ? null : <p className="m-0 text-xs text-muted">It can start on each record by itself too: as the record is created, on a date of it, or when a condition on it comes to hold.</p>}
      <Button size="sm" className="justify-self-start" disabled={starts.length >= 5} onClick={() => onChange([...starts, { created: true }])}>
        Add a way it starts by itself
      </Button>
    </fieldset>
  );
}

const EVERY: ReadonlyArray<{ readonly value: Schedule['every']; readonly label: string }> = [
  { value: 'hour', label: 'Every hour' },
  { value: 'day', label: 'Every day' },
  { value: 'weekday', label: 'Every weekday' },
  { value: 'week', label: 'Every week' },
  { value: 'month', label: 'Every month' },
];
const ZONES: readonly string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return [];
  }
})();

/** A schedule changed to run every hour, day, weekday, week or month: it keeps what still fits. */
function every(schedule: Schedule, to: Schedule['every']): Schedule {
  const { on: _on, day: _day, ...rest } = schedule;
  if (to === 'hour') return { ...rest, every: to, at: `00:${schedule.at.slice(3)}` };
  const at = schedule.every === 'hour' ? `09:${schedule.at.slice(3)}` : schedule.at;
  if (to === 'week') return { ...rest, every: to, at, on: schedule.on ?? 'monday' };
  if (to === 'month') return { ...rest, every: to, at, day: schedule.day ?? 1 };
  return { ...rest, every: to, at };
}

/** A flow that needs no input runs on a schedule, with the app's authority; once saved, when it runs next. */
function ScheduleEditor(props: { appId: string; definition: Definition; name: string; readOnly: boolean; dirty: boolean; onChange: (schedule: Schedule | undefined) => void }) {
  const { appId, definition, name, readOnly, dirty, onChange } = props;
  const flow = definition.flows![name]!;
  const schedule = flow.schedule;
  // When it runs next, as saved: asked again after each save.
  const planned = useQuery({ queryKey: ['flow-live', appId, name, 'schedule', dirty], queryFn: () => api.flowLive(appId, name), enabled: Boolean(schedule) && !dirty });
  if (Object.keys(flow.input).length && !schedule) return <p className="m-0 text-xs text-muted">A flow with input can't run on a schedule: there is nobody to give it its input.</p>;
  const day = (value: string) => (value === 'last' ? 'last' : Math.min(28, Math.max(1, Number(value) || 1)));
  const next = dirty ? undefined : planned.data?.schedule;
  return (
    <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3" disabled={readOnly}>
      <legend className="px-1 text-sm text-muted">On a schedule</legend>
      <Checkbox label="It runs by itself, on a schedule" checked={Boolean(schedule)} onChange={(on) => onChange(on ? { every: 'weekday', at: '07:00' } : undefined)} />
      {schedule ? (
        <>
          <Field label="How often">
            {(id) => (
              <Select id={id} value={schedule.every} onChange={(e) => onChange(every(schedule, EVERY.find((each) => each.value === e.target.value)?.value ?? 'day'))}>
                {EVERY.map((each) => (
                  <option key={each.value} value={each.value}>
                    {each.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {schedule.every === 'week' ? (
            <Field label="On">
              {(id) => (
                <Select id={id} value={schedule.on ?? 'monday'} onChange={(e) => onChange({ ...schedule, on: WEEKDAYS.find((weekday) => weekday === e.target.value) ?? 'monday' })}>
                  {WEEKDAYS.map((weekday) => (
                    <option key={weekday} value={weekday}>
                      {weekday.charAt(0).toUpperCase() + weekday.slice(1)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}
          {schedule.every === 'month' ? (
            <Field label="On the day">
              {(id) => (
                <Select id={id} value={String(schedule.day ?? 1)} onChange={(e) => onChange({ ...schedule, day: day(e.target.value) })}>
                  {Array.from({ length: 28 }, (_, i) => (
                    <option key={i + 1} value={String(i + 1)}>
                      {i + 1}
                    </option>
                  ))}
                  <option value="last">The last day</option>
                </Select>
              )}
            </Field>
          ) : null}
          {schedule.every === 'hour' ? (
            <Field label="Minutes past the hour">
              {(id) => (
                <TextInput
                  id={id}
                  type="number"
                  min={0}
                  max={59}
                  className="w-24"
                  value={Number(schedule.at.slice(3))}
                  onChange={(e) => onChange({ ...schedule, at: `00:${String(Math.min(59, Math.max(0, Number(e.target.value) || 0))).padStart(2, '0')}` })}
                />
              )}
            </Field>
          ) : (
            <Field label="At">{(id) => <TextInput id={id} type="time" className="w-32" value={schedule.at} onChange={(e) => /^\d{2}:\d{2}$/.test(e.target.value) && onChange({ ...schedule, at: e.target.value })} />}</Field>
          )}
          {schedule.every === 'hour' ? null : (
            <Field label="Time zone" hint="The time of day is the zone's own, in summer and in winter.">
              {(id) =>
                ZONES.length ? (
                  <Select id={id} value={schedule.zone ?? 'UTC'} onChange={(e) => onChange(e.target.value === 'UTC' ? (({ zone: _, ...rest }) => rest)(schedule) : { ...schedule, zone: e.target.value })}>
                    <option value="UTC">UTC</option>
                    {ZONES.filter((zone) => zone !== 'UTC').map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <TextInput id={id} value={schedule.zone ?? 'UTC'} onChange={(e) => onChange({ ...schedule, zone: e.target.value.trim() })} />
                )
              }
            </Field>
          )}
          <p className="m-0 text-sm" data-testid="flow-schedule">
            {scheduleWords(schedule)}, with the app's authority.
            {next ? ` It runs next ${new Date(next.nextRunAt).toLocaleString()}.` : dirty ? ' Once saved, it says when it runs next.' : ''}
          </p>
          {next?.lastError ? <Notice tone="bad">Its last run failed: {next.lastError}</Notice> : null}
        </>
      ) : null}
    </fieldset>
  );
}

import { type FlowStep, flowSubject, flowWaits, type Several, type VarKind } from '@platform/app-model';
import { DurationInput } from '../components/duration.js';
import { Button, Checkbox, Field, Select, TextInput } from '../components/ui.js';
import type { RefChoice } from '../model/conditions.js';
import { recordVariables, updateActionsOf } from '../model/flows.js';
import type { Definition } from '../types.js';
import { TEXT_VALUE } from './StepValues.js';
import { ValueEditor, type ValueSources } from './ValueEditor.js';

/* The steps about people: a task that waits for someone, and a notice that tells people. */

/** A duration set with a number and a unit, or its ISO 8601 text when it has another shape. */
/** The user fields of the record a flow that waits is about: whom its tasks can go to. */
function peopleOf(definition: Definition, entity: string | undefined): Array<{ name: string; label: string }> {
  return (entity ? (definition.entities[entity]?.fields ?? []) : [])
    .filter((field) => field.type === 'user')
    .map((field) => ({ name: field.name, label: field.label }));
}

type TaskStep = Extract<FlowStep, { type: 'task' }>;

/** A step without one of its parts. */
function without<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const { [key]: _gone, ...rest } = value;
  return rest;
}

export function TaskFields({ definition, name, step, set }: { definition: Definition; name: string; step: TaskStep; set: (step: FlowStep) => void }) {
  const entity = flowSubject(definition.flows![name]!)?.entity;
  const people = peopleOf(definition, entity);
  const actions = updateActionsOf(definition, entity);
  const cards = Object.entries(definition.cards).filter(([, card]) => card.entity === entity);
  const assignee = !step.assignee
    ? ''
    : 'field' in step.assignee
      ? `field:${step.assignee.field}`
      : `manager:${step.assignee.managerOf}:${step.assignee.levels}`;
  const outcome = (index: number, change: (outcome: TaskStep['outcomes'][number]) => TaskStep['outcomes'][number]) =>
    set({ ...step, outcomes: step.outcomes.map((each, i) => (i === index ? change(each) : each)) });
  return (
    <>
      <Field label="What the inbox calls it">
        {(id) => <TextInput id={id} value={step.label} onChange={(e) => set({ ...step, label: e.target.value })} />}
      </Field>
      <Field label="Done by people with the role" hint="A role grants; whom the task goes to only narrows it.">
        {(id) => (
          <Select id={id} value={step.role} onChange={(e) => set({ ...step, role: e.target.value })}>
            <option value="" disabled>
              Choose a role
            </option>
            {Object.entries(definition.roles).map(([role, spec]) => (
              <option key={role} value={role}>
                {spec.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <SeveralEditor
        several={step.several}
        outcomes={step.outcomes}
        people={people}
        onChange={(several) => set(several ? { ...without(step, 'assignee'), several } : without(step, 'several'))}
      />
      {step.several ? null : (
        <Field label="Goes to">
          {(id) => (
            <Select
              id={id}
              value={assignee}
              onChange={(e) => {
                const [kind, field, levels] = e.target.value.split(':');
                const rest = without(step, 'assignee');
                if (kind === 'field' && field) set({ ...without(rest, 'department'), assignee: { field } });
                else if (kind === 'manager' && field) set({ ...without(rest, 'department'), assignee: { managerOf: field, levels: Number(levels) || 1 } });
                else set(rest);
              }}
            >
              <option value="">Anyone with the role</option>
              {people.map((person) => (
                <option key={`field:${person.name}`} value={`field:${person.name}`}>
                  The record's {person.label.toLowerCase()}
                </option>
              ))}
              {people.map((person) => (
                <option key={`manager:${person.name}`} value={`manager:${person.name}:1`}>
                  The manager of the record's {person.label.toLowerCase()}
                </option>
              ))}
              {people.map((person) => (
                <option key={`manager2:${person.name}`} value={`manager:${person.name}:2`}>
                  The manager's manager of the record's {person.label.toLowerCase()}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {step.assignee || step.several ? null : (
        <Field label="In the department of" hint="Only people with the role in that department see and decide the task.">
          {(id) => (
            <Select
              id={id}
              value={step.department?.of ?? ''}
              onChange={(e) => set(e.target.value ? { ...step, department: { of: e.target.value } } : without(step, 'department'))}
            >
              <option value="">Any department</option>
              {people.map((person) => (
                <option key={person.name} value={person.name}>
                  The record's {person.label.toLowerCase()}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <Checkbox label="It has a due date" checked={step.due !== undefined} onChange={(on) => set(on ? { ...step, due: 'P3D' } : without(step, 'due'))} />
      {step.due ? <DurationInput label="Due within" value={step.due} onChange={(due) => set({ ...step, due })} /> : null}
      <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
        <legend className="px-1 text-sm text-muted">Outcomes: a way on for each</legend>
        {step.outcomes.map((each, index) => (
          <div key={each.name} className="grid gap-1.5 rounded-md bg-sunken p-2">
            <div className="flex gap-2">
              <TextInput
                aria-label={`Outcome ${index + 1}`}
                value={each.label}
                onChange={(e) => outcome(index, (current) => ({ ...current, label: e.target.value }))}
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={step.outcomes.length === 1}
                onClick={() => set({ ...step, outcomes: step.outcomes.filter((_, i) => i !== index) })}
              >
                Remove
              </Button>
            </div>
            <Select
              aria-label={`What ${each.label} runs`}
              value={each.action ?? ''}
              onChange={(e) => outcome(index, (current) => (e.target.value ? { ...current, action: e.target.value } : without(current, 'action')))}
            >
              <option value="">Runs no action</option>
              {actions.map((action) => (
                <option key={action} value={action}>
                  Runs {definition.actions[action]!.label}, as the person who decides
                </option>
              ))}
            </Select>
          </div>
        ))}
        <Button
          size="sm"
          className="justify-self-start"
          disabled={step.outcomes.length >= 10}
          onClick={() => {
            let n = step.outcomes.length + 1;
            while (step.outcomes.some((each) => each.name === `outcome_${n}`)) n++;
            set({ ...step, outcomes: [...step.outcomes, { name: `outcome_${n}`, label: `Outcome ${n}`, steps: [] }] });
          }}
        >
          Add an outcome
        </Button>
      </fieldset>
      <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
        <legend className="px-1 text-sm text-muted">Reminders</legend>
        {(step.reminders ?? []).map((reminder, index) => (
          <div key={index} className="flex items-end gap-2">
            <DurationInput
              label={`Reminder ${index + 1} after`}
              value={reminder.after}
              onChange={(after) => set({ ...step, reminders: (step.reminders ?? []).map((each, i) => (i === index ? { ...each, after } : each)) })}
            />
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove reminder ${index + 1}`}
              onClick={() => {
                const rest = (step.reminders ?? []).filter((_, i) => i !== index);
                set(rest.length ? { ...step, reminders: rest } : without(step, 'reminders'));
              }}
            >
              ✕
            </Button>
          </div>
        ))}
        <p className="m-0 text-xs text-muted">
          A reminder's steps run while the task still waits, a time after it opens. They hang below the task on the canvas.
        </p>
        <Button
          size="sm"
          className="justify-self-start"
          disabled={(step.reminders?.length ?? 0) >= 3}
          onClick={() => set({ ...step, reminders: [...(step.reminders ?? []), { after: 'P1D', steps: [] }] })}
        >
          Add a reminder
        </Button>
      </fieldset>
      <Checkbox
        label="It has a deadline"
        checked={Boolean(step.deadline)}
        onChange={(on) => set(on ? { ...step, deadline: { after: 'P3D', steps: [] } } : without(step, 'deadline'))}
      />
      {step.deadline ? (
        <>
          <DurationInput
            label="The task ends after"
            value={step.deadline.after}
            onChange={(after) => set({ ...step, deadline: { ...step.deadline!, after } })}
          />
          <p className="m-0 text-xs text-muted">
            Once that time passes, the task leaves the inbox, and the flow goes on by the deadline's way, below the task.
          </p>
        </>
      ) : null}
      <Field label="Review card">
        {(id) => (
          <Select id={id} value={step.card ?? ''} onChange={(e) => set(e.target.value ? { ...step, card: e.target.value } : without(step, 'card'))}>
            <option value="">None</option>
            {cards.map(([card, spec]) => (
              <option key={card} value={card}>
                {spec.title}
              </option>
            ))}
          </Select>
        )}
      </Field>
    </>
  );
}

type InformStep = Extract<FlowStep, { type: 'inform' }>;

/** Whom a notice goes to, what it says, the record it is about, and whether it goes by email too. */
export function InformFields(props: {
  definition: Definition;
  name: string;
  step: InformStep;
  scope: ReadonlyMap<string, VarKind>;
  sources: ValueSources;
  variables: RefChoice[];
  set: (step: FlowStep) => void;
}) {
  const { definition, name, step, scope, sources, variables, set } = props;
  const waits = flowWaits(definition.flows![name]!, definition.flows);
  const records = recordVariables(scope);
  // A person: the one running it (not in a flow that waits), a user field of a record, or who owns, created or last changed one.
  const people = [
    ...(waits ? [] : [{ ref: 'principal.id', label: 'The person running it' }]),
    ...variables.filter((choice) => choice.kind === 'person').map((choice) => ({ ref: choice.ref, label: choice.label })),
    ...records.flatMap((record) => [
      { ref: `${record}.owner`, label: `${record}: its owner` },
      { ref: `${record}.created_by`, label: `${record}: whoever created it` },
    ]),
  ];
  const choiceOf = (recipient: InformStep['to'][number]) =>
    'role' in recipient
      ? `role:${recipient.role}`
      : recipient.person !== null && typeof recipient.person === 'object' && !Array.isArray(recipient.person) && 'ref' in recipient.person
        ? `person:${recipient.person.ref}`
        : '';
  const recipientOf = (value: string): InformStep['to'][number] => (value.startsWith('role:') ? { role: value.slice(5) } : { person: { ref: value.slice(7) } });
  const change = (index: number, value: string) => set({ ...step, to: step.to.map((each, i) => (i === index ? recipientOf(value) : each)) });
  return (
    <>
      <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
        <legend className="px-1 text-sm text-muted">Whom it tells</legend>
        {step.to.map((recipient, index) => (
          <div key={index} className="flex items-end gap-2">
            <Field label={`Tells ${index + 1}`}>
              {(id) => (
                <Select id={id} value={choiceOf(recipient)} onChange={(e) => change(index, e.target.value)}>
                  <option value="" disabled>
                    Choose someone
                  </option>
                  <optgroup label="A person">
                    {people.map((person) => (
                      <option key={person.ref} value={`person:${person.ref}`}>
                        {person.label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Everyone with a role">
                    {Object.entries(definition.roles).map(([role, spec]) => (
                      <option key={role} value={`role:${role}`}>
                        {spec.label}
                      </option>
                    ))}
                  </optgroup>
                </Select>
              )}
            </Field>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Remove whom it tells ${index + 1}`}
              disabled={step.to.length <= 1}
              onClick={() => set({ ...step, to: step.to.filter((_, i) => i !== index) })}
            >
              ✕
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          className="justify-self-start"
          disabled={step.to.length >= 10}
          onClick={() => set({ ...step, to: [...step.to, step.to[0] ?? { role: Object.keys(definition.roles)[0] ?? '' }] })}
        >
          Tell someone else too
        </Button>
        <p className="m-0 text-xs text-muted">Only people the app is shared with hear it. A role means everyone who holds it.</p>
      </fieldset>
      <Field label="What it says first" hint="Its title in the app, and the email's subject.">
        {() => (
          <ValueEditor
            definition={definition}
            entity=""
            label="Title"
            value={step.title}
            from={sources}
            only={TEXT_VALUE}
            onChange={(title) => set({ ...step, title })}
          />
        )}
      </Field>
      <Field label="What it says after">
        {() => (
          <ValueEditor
            definition={definition}
            entity=""
            label="Message"
            value={step.message ?? ''}
            from={sources}
            only={TEXT_VALUE}
            onChange={(message) => set(message === '' ? without(step, 'message') : { ...step, message })}
          />
        )}
      </Field>
      <Field label="About the record" hint="The notice links to it.">
        {(id) => (
          <Select id={id} value={step.about ?? ''} onChange={(e) => set(e.target.value ? { ...step, about: e.target.value } : without(step, 'about'))}>
            <option value="">No record</option>
            {records.map((record) => (
              <option key={record} value={record}>
                {record}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Checkbox label="By email too, to each who takes email" checked={step.email} onChange={(email) => set({ ...step, email })} />
      {Object.values(definition.connections ?? {}).some((connection) => connection.kind === 'teams') ? (
        <Field label="And to a Teams channel">
          {(id) => (
            <Select id={id} value={step.teams ?? ''} onChange={(e) => set(e.target.value ? { ...step, teams: e.target.value } : without(step, 'teams'))}>
              <option value="">No channel</option>
              {Object.entries(definition.connections ?? {}).flatMap(([connection, spec]) =>
                spec.kind === 'teams'
                  ? [
                      <option key={connection} value={connection}>
                        {spec.label}
                      </option>,
                    ]
                  : [],
              )}
            </Select>
          )}
        </Field>
      ) : null}
      {step.email || step.teams ? (
        <p className="m-0 text-xs text-muted">Email and Teams leave the app, so a field that holds personal data stays out of what they say.</p>
      ) : null}
    </>
  );
}

/** Several people decide a task, each with a vote: who votes, in turn or at once, and what decides it. */
function SeveralEditor({
  several,
  outcomes,
  people,
  onChange,
}: {
  several: Several | undefined;
  outcomes: TaskStep['outcomes'];
  people: ReadonlyArray<{ name: string; label: string }>;
  onChange: (several: Several | undefined) => void;
}) {
  const voters = several?.people;
  const decide = several?.decide;
  return (
    <fieldset className="m-0 grid gap-2 rounded-md border border-line p-3">
      <legend className="px-1 text-sm text-muted">Several people</legend>
      <Checkbox
        label="Several people decide, each with a vote"
        checked={Boolean(several)}
        onChange={(on) =>
          onChange(
            on
              ? {
                  people: { everyone: true },
                  sequential: false,
                  decide: outcomes.length > 1 ? { count: 'all', outcome: outcomes[0]!.name, otherwise: outcomes[1]!.name } : { first: true },
                }
              : undefined,
          )
        }
      />
      {several && voters && decide ? (
        <>
          <Field label="Who votes">
            {(id) => (
              <Select
                id={id}
                value={'everyone' in voters ? 'everyone' : 'fields' in voters ? 'fields' : `line:${voters.lineOf}`}
                onChange={(e) => {
                  const value = e.target.value;
                  const next: Several['people'] =
                    value === 'everyone'
                      ? { everyone: true }
                      : value === 'fields'
                        ? { fields: people.slice(0, 2).map((person) => person.name) }
                        : { lineOf: value.slice('line:'.length), levels: 2 };
                  onChange({ ...several, people: next });
                }}
              >
                <option value="everyone">Everyone with the role</option>
                <option value="fields" disabled={people.length < 2}>
                  The people some fields of the record name
                </option>
                {people.map((person) => (
                  <option key={person.name} value={`line:${person.name}`}>
                    Up the reporting line from the record's {person.label.toLowerCase()}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {'fields' in voters
            ? people.map((person) => (
                <Checkbox
                  key={person.name}
                  label={`The record's ${person.label.toLowerCase()}`}
                  checked={voters.fields.includes(person.name)}
                  onChange={(on) =>
                    onChange({ ...several, people: { fields: on ? [...voters.fields, person.name] : voters.fields.filter((field) => field !== person.name) } })
                  }
                />
              ))
            : null}
          <Checkbox label="One after another, in order" checked={several.sequential} onChange={(sequential) => onChange({ ...several, sequential })} />
          <Field label="Decided by">
            {(id) => (
              <Select
                id={id}
                value={'first' in decide ? 'first' : String(decide.count)}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === 'first') return onChange({ ...several, decide: { first: true } });
                  const count = value === 'all' || value === 'majority' ? value : Number(value);
                  const base = 'first' in decide ? { outcome: outcomes[0]!.name, otherwise: (outcomes[1] ?? outcomes[0])!.name } : decide;
                  onChange({ ...several, decide: { count, outcome: base.outcome, otherwise: base.otherwise } });
                }}
              >
                <option value="first">The first vote</option>
                <option value="all" disabled={outcomes.length < 2}>
                  Everyone's votes for one outcome
                </option>
                <option value="majority" disabled={outcomes.length < 2}>
                  A majority's votes for one outcome
                </option>
              </Select>
            )}
          </Field>
          <p className="m-0 text-xs text-muted">Once the votes decide, the outcome's action runs with the app's authority: no one person made the decision.</p>
        </>
      ) : null}
    </fieldset>
  );
}

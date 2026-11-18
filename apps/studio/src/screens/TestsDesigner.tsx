import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../api.js';
import { TestResults } from '../components/tests.js';
import { Badge, Button, Card, Checkbox, cx, EmptyState, Field, Notice, Select, TextInput } from '../components/ui.js';
import { isWorkedOut, type Definition, type Field as FieldDef } from '../types.js';
import { lineOwner } from '../model/edit.js';
import { addTest, givenName, givenOf, removeTest, updateTest, type AppTest } from '../model/tests.js';

type Values = Readonly<Record<string, unknown>>;

/**
 * The app's tests (design §6.7): what it must do. Each makes records first, has someone in one of
 * the app's roles run an action, and says what must come of it. They run on the saved app, each in
 * a transaction that is undone; every change request runs them, and a test that fails stops it.
 */
export function TestsDesigner({ appId, definition, onChange, dirty }: { appId: string; definition: Definition; onChange: (definition: Definition) => void; dirty: boolean }) {
  const tests = definition.tests ?? {};
  const names = Object.keys(tests);
  const [chosen, setChosen] = useState<string | null>(names[0] ?? null);
  const [label, setLabel] = useState('');
  const run = useMutation({ mutationFn: () => api.runTests(appId) });
  const name = chosen && tests[chosen] ? chosen : (names[0] ?? null);
  const last = (test: string) => run.data?.results.find((result) => result.name === test);

  return (
    <div className="grid gap-4 @min-[62rem]:grid-cols-[20rem_minmax(0,1fr)]">
      <Card aria-label="Tests" className="grid content-start gap-3 p-4">
        <h2 className="m-0 text-sm font-semibold text-muted">Tests</h2>
        <p className="m-0 text-xs text-muted">What the app must do. Every change request runs them, and a change whose tests fail doesn't merge.</p>
        <ul className="m-0 grid list-none gap-1 p-0">
          {names.map((each) => (
            <li key={each}>
              <button
                type="button"
                aria-current={each === name ? 'true' : undefined}
                onClick={() => setChosen(each)}
                className={cx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm', each === name ? 'bg-accent-soft font-semibold text-accent' : 'hover:bg-sunken')}
              >
                <span className="flex-1">{tests[each]!.label}</span>
                {last(each) ? <Badge tone={last(each)!.passed ? 'good' : 'bad'}>{last(each)!.passed ? 'passed' : 'failed'}</Badge> : null}
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!label.trim()) return;
            const added = addTest(definition, label.trim());
            onChange(added.definition);
            setChosen(added.name);
            setLabel('');
          }}
        >
          <TextInput aria-label="New test" placeholder="New test, e.g. A requester submits a claim" value={label} onChange={(event) => setLabel(event.target.value)} />
          <Button type="submit" disabled={!label.trim()}>
            Add test
          </Button>
        </form>
        <div className="grid gap-2 border-t border-line pt-3">
          <Button variant="primary" disabled={!names.length || dirty || run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? 'Running…' : 'Run the tests'}
          </Button>
          {dirty ? <p className="m-0 text-xs text-muted">Tests run on the saved app: save your changes first.</p> : null}
          {run.error ? <Notice tone="bad">{run.error instanceof ApiError ? run.error.message : "The tests didn't run."}</Notice> : null}
          {run.data ? <TestResults run={run.data} /> : null}
        </div>
      </Card>
      {name ? (
        <TestEditor
          key={name}
          definition={definition}
          test={tests[name]!}
          onChange={(test) => onChange(updateTest(definition, name, test))}
          onRemove={() => {
            onChange(removeTest(definition, name));
            setChosen(null);
          }}
        />
      ) : (
        <EmptyState title="Add a test">Say what the app must do: who runs which action, on which records, and what must come of it.</EmptyState>
      )}
    </div>
  );
}

function TestEditor({ definition, test, onChange, onRemove }: { definition: Definition; test: AppTest; onChange: (test: AppTest) => void; onRemove: () => void }) {
  const action = definition.actions[test.when.action];
  const entities = Object.entries(definition.entities).filter(([entity]) => !lineOwner(definition, entity));
  const subject = action ? definition.entities[action.entity] : undefined;
  const writable = (entity: string) => (definition.entities[entity]?.fields ?? []).filter((field) => !isWorkedOut(field) && field.type !== 'file' && field.type !== 'user').map((field) => field.name);
  const setWhen = (when: Partial<AppTest['when']>) => onChange({ ...test, when: { ...test.when, ...when } });

  return (
    <Card aria-label="Test" className="grid content-start gap-5 p-4">
      <Field label="What it shows">{(id) => <TextInput id={id} value={test.label} onChange={(event) => onChange({ ...test, label: event.target.value })} />}</Field>

      <section className="grid gap-2">
        <h3 className="m-0 text-sm font-semibold">First, there are</h3>
        {Object.entries(test.given).map(([given, record]) => (
          <div key={given} className="grid gap-2 rounded-md border border-line p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <code>{given}</code>, a
              <Select
                aria-label={`${given}: of`}
                className="w-auto"
                value={record.entity}
                onChange={(event) => onChange({ ...test, given: { ...test.given, [given]: { entity: event.target.value, values: {} } } })}
              >
                {entities.map(([entity, about]) => (
                  <option key={entity} value={entity}>
                    {about.label}
                  </option>
                ))}
              </Select>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const { [given]: _removed, ...rest } = test.given;
                  onChange({ ...test, given: rest });
                }}
              >
                Remove
              </Button>
            </div>
            <ValuesEditor definition={definition} entity={record.entity} test={test} fields={writable(record.entity)} values={record.values} label={`${given}'s values`} onChange={(values) => onChange({ ...test, given: { ...test.given, [given]: { ...record, values } } })} />
          </div>
        ))}
        <Select
          aria-label="Add a record of"
          className="w-auto justify-self-start"
          value=""
          onChange={(event) => {
            const entity = event.target.value;
            if (entity) onChange({ ...test, given: { ...test.given, [givenName(test, entity)]: { entity, values: {} } } });
          }}
        >
          <option value="">{Object.keys(test.given).length ? 'Add another record…' : 'Add a record the test makes first…'}</option>
          {entities.map(([entity, about]) => (
            <option key={entity} value={entity}>
              {about.label}
            </option>
          ))}
        </Select>
      </section>

      <section className="grid gap-2">
        <h3 className="m-0 text-sm font-semibold">Then someone who is</h3>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Select aria-label="Their role" className="w-auto" value={test.when.as} onChange={(event) => setWhen({ as: event.target.value })}>
            {Object.entries(definition.roles).map(([role, about]) => (
              <option key={role} value={role}>
                {about.label}
              </option>
            ))}
          </Select>
          runs
          <Select
            aria-label="The action"
            className="w-auto"
            value={test.when.action}
            onChange={(event) => {
              const next = definition.actions[event.target.value];
              const { record: _record, ...rest } = test.when;
              const record = next?.operation === 'update' ? givenOf(test, next.entity)[0] : undefined;
              onChange({ ...test, when: { ...rest, action: event.target.value, values: {}, ...(record ? { record } : {}) } });
            }}
          >
            {Object.entries(definition.actions).map(([name, about]) => (
              <option key={name} value={name}>
                {about.label}
              </option>
            ))}
          </Select>
          {action?.operation === 'update' ? (
            <>
              on
              <Select aria-label="On the record" className="w-auto" value={test.when.record ?? ''} onChange={(event) => setWhen({ record: event.target.value })}>
                <option value="">—</option>
                {givenOf(test, action.entity).map((given) => (
                  <option key={given} value={given}>
                    {given}
                  </option>
                ))}
              </Select>
            </>
          ) : null}
        </div>
        {action ? <ValuesEditor definition={definition} entity={action.entity} test={test} fields={[...action.input]} values={test.when.values} label="What they give" onChange={(values) => setWhen({ values })} /> : null}
      </section>

      <section className="grid gap-2">
        <h3 className="m-0 text-sm font-semibold">It must</h3>
        <Select
          aria-label="It must"
          className="w-auto justify-self-start"
          value={test.then.outcome}
          onChange={(event) => onChange({ ...test, then: event.target.value === 'refused' ? { outcome: 'refused' } : { outcome: 'saved', values: {} } })}
        >
          <option value="saved">save the record</option>
          <option value="refused">be refused</option>
        </Select>
        {test.then.outcome === 'saved' && action && subject ? (
          <ValuesEditor
            definition={definition}
            entity={action.entity}
            test={test}
            fields={subject.fields.filter((field) => field.type !== 'file').map((field) => field.name)}
            values={test.then.values}
            label="With these values"
            onChange={(values) => onChange({ ...test, then: { outcome: 'saved', values } })}
          />
        ) : null}
        {test.then.outcome === 'refused' ? (
          <Field label="With a message that holds" hint="Leave it empty for any refusal.">
            {(id) => (
              <TextInput
                id={id}
                value={test.then.outcome === 'refused' ? (test.then.message ?? '') : ''}
                onChange={(event) => onChange({ ...test, then: event.target.value ? { outcome: 'refused', message: event.target.value } : { outcome: 'refused' } })}
              />
            )}
          </Field>
        ) : null}
      </section>

      <div className="border-t border-line pt-3">
        <Button size="sm" variant="danger" onClick={onRemove}>
          Delete the test
        </Button>
      </div>
    </Card>
  );
}

/** A value for a field to start from, as the test adds it. */
function startingValue(definition: Definition, test: AppTest, field: FieldDef): unknown {
  switch (field.type) {
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'date':
      return new Date().toISOString().slice(0, 10);
    case 'datetime':
      return new Date().toISOString();
    case 'choice':
      return field.multiple ? [field.options[0]?.value] : field.options[0]?.value;
    case 'reference': {
      const first = givenOf(test, field.entity)[0];
      const named = first ? { given: first } : null;
      return field.multiple ? (named ? [named] : []) : named;
    }
    case 'lines':
      return [{}];
    default:
      return '';
  }
}

/** A record's values in a test, field by field: those the test gives, and a way to add another. */
function ValuesEditor(props: { definition: Definition; entity: string; test: AppTest; fields: readonly string[]; values: Values; label: string; onChange: (values: Record<string, unknown>) => void }) {
  const { definition, entity, test, fields, values, label, onChange } = props;
  const declared = definition.entities[entity]?.fields ?? [];
  const unused = declared.filter((field) => fields.includes(field.name) && !(field.name in values));
  return (
    <div role="group" aria-label={label} className="grid gap-1.5">
      {Object.entries(values).map(([name, value]) => {
        const field = declared.find((each) => each.name === name);
        return (
          <div key={name} className="flex flex-wrap items-start gap-2">
            <span className="min-w-32 pt-1.5 text-sm text-muted">{field?.label ?? name}</span>
            <div className="min-w-0 flex-1">
              {field ? <ValueField definition={definition} test={test} field={field} value={value} label={`${label}: ${field.label}`} onChange={(next) => onChange({ ...values, [name]: next })} /> : <code className="text-sm">{JSON.stringify(value)}</code>}
            </div>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`${label}: take out ${field?.label ?? name}`}
              onClick={() => {
                const { [name]: _removed, ...rest } = values;
                onChange(rest);
              }}
            >
              ✕
            </Button>
          </div>
        );
      })}
      {unused.length ? (
        <Select
          aria-label={`${label}: add a value`}
          className="w-auto justify-self-start"
          value=""
          onChange={(event) => {
            const field = declared.find((each) => each.name === event.target.value);
            if (field) onChange({ ...values, [field.name]: startingValue(definition, test, field) });
          }}
        >
          <option value="">{Object.keys(values).length ? 'Add another value…' : 'Add a value…'}</option>
          {unused.map((field) => (
            <option key={field.name} value={field.name}>
              {field.label}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  );
}

/** One value of a test, in the input its field's type needs. A reference names a record the test makes. */
function ValueField({ definition, test, field, value, label, onChange }: { definition: Definition; test: AppTest; field: FieldDef; value: unknown; label: string; onChange: (value: unknown) => void }) {
  switch (field.type) {
    case 'number':
      return <TextInput aria-label={label} type="number" className="w-36" value={typeof value === 'number' ? value : ''} onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))} />;
    case 'boolean':
      return (
        <Select aria-label={label} className="w-auto" value={value === false ? 'no' : 'yes'} onChange={(event) => onChange(event.target.value === 'yes')}>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </Select>
      );
    case 'date':
      return <TextInput aria-label={label} type="date" className="w-auto" value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value || null)} />;
    case 'choice':
      return field.multiple ? (
        <div className="flex flex-wrap gap-3">
          {field.options.map((option) => (
            <Checkbox
              key={option.value}
              label={option.label}
              checked={Array.isArray(value) && value.includes(option.value)}
              onChange={(on) => onChange([...(Array.isArray(value) ? value : []).filter((each) => each !== option.value), ...(on ? [option.value] : [])])}
            />
          ))}
        </div>
      ) : (
        <Select aria-label={label} className="w-auto" value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)}>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      );
    case 'reference': {
      const named = (entry: unknown) => (typeof entry === 'object' && entry !== null && 'given' in entry ? String((entry as { given: unknown }).given) : '');
      const choices = givenOf(test, field.entity);
      if (!choices.length) return <span className="text-sm text-muted">Add a record of {definition.entities[field.entity]?.label ?? field.entity} first, for this to name.</span>;
      return field.multiple ? (
        <div className="flex flex-wrap gap-3">
          {choices.map((given) => (
            <Checkbox
              key={given}
              label={given}
              checked={Array.isArray(value) && value.some((entry) => named(entry) === given)}
              onChange={(on) => onChange([...(Array.isArray(value) ? value : []).filter((entry) => named(entry) !== given), ...(on ? [{ given }] : [])])}
            />
          ))}
        </div>
      ) : (
        <Select aria-label={label} className="w-auto" value={named(value)} onChange={(event) => onChange(event.target.value ? { given: event.target.value } : null)}>
          <option value="">—</option>
          {choices.map((given) => (
            <option key={given} value={given}>
              {given}
            </option>
          ))}
        </Select>
      );
    }
    case 'lines': {
      const lines = Array.isArray(value) ? (value as Values[]) : [];
      const lineFields = (definition.entities[field.entity]?.fields ?? []).filter((each) => !isWorkedOut(each) && each.type !== 'file' && each.type !== 'user').map((each) => each.name);
      return (
        <div className="grid gap-2">
          {lines.map((line, index) => (
            <div key={index} className="grid gap-1 rounded-md bg-sunken p-2">
              <ValuesEditor
                definition={definition}
                entity={field.entity}
                test={test}
                fields={lineFields}
                values={line}
                label={`${label} ${index + 1}`}
                onChange={(next) => onChange(lines.map((each, i) => (i === index ? next : each)))}
              />
              <Button size="sm" variant="ghost" className="justify-self-start" onClick={() => onChange(lines.filter((_, i) => i !== index))}>
                Remove the line
              </Button>
            </div>
          ))}
          <Button size="sm" className="justify-self-start" onClick={() => onChange([...lines, {}])}>
            Add a line
          </Button>
        </div>
      );
    }
    default:
      return <TextInput aria-label={label} value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)} />;
  }
}

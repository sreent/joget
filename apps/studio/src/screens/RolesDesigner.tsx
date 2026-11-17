import { useState } from 'react';
import { ConditionEditor, THE_PERSON } from '../components/condition.js';
import { Button, Card, Checkbox, cx, EmptyState, Field, Select, TextInput } from '../components/ui.js';
import { recordChoices } from '../model/conditions.js';
import { addItem, recordEntities, removeItem, setRoleEntity, summarizeAccess, updateItem } from '../model/logic.js';
import type { Definition } from '../types.js';
import { Checklist, Choice } from './LogicDesigners.js';

type Props = { definition: Definition; onChange: (definition: Definition) => void };
type Access = Definition['roles'][string]['entities'][string];
type Selection = { include: string[] } | { exclude: string[] } | undefined;
type Scope = 'none' | 'all' | 'some';

/**
 * Roles: who may do what in the app. The matrix shows every role's access to every kind of
 * record; below it, one role's access in full, and the actions and queries it may run.
 */
export function RolesDesigner({ definition, onChange }: Props) {
  const roles = Object.keys(definition.roles);
  const entities = recordEntities(definition);
  const [selected, setSelected] = useState<string | null>(roles[0] ?? null);
  const [entity, setEntity] = useState<string | null>(entities[0] ?? null);
  const [label, setLabel] = useState('');
  const role = selected && definition.roles[selected] ? selected : (roles[0] ?? null);
  const shown = entity && entities.includes(entity) ? entity : (entities[0] ?? null);
  return (
    <div className="grid gap-4">
      <Card className="overflow-x-auto p-0">
        <table className="w-full border-collapse text-sm">
          <caption className="px-4 pt-3 text-left text-sm font-semibold text-muted">Who may do what</caption>
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th scope="col" className="px-4 py-2 font-medium">
                Role
              </th>
              {entities.map((name) => (
                <th key={name} scope="col" className="px-4 py-2 font-medium">
                  {definition.entities[name]!.pluralLabel ?? definition.entities[name]!.label}
                </th>
              ))}
              <th scope="col" className="px-4 py-2 font-medium">
                Runs
              </th>
            </tr>
          </thead>
          <tbody>
            {roles.map((name) => {
              const r = definition.roles[name]!;
              return (
                <tr key={name} className={cx('border-b border-line last:border-0', name === role && 'bg-accent-soft')}>
                  <th scope="row" className="px-4 py-2 text-left font-medium">
                    <button type="button" className="text-left text-accent hover:underline" onClick={() => setSelected(name)}>
                      {r.label}
                    </button>
                  </th>
                  {entities.map((e) => (
                    <td key={e} className="px-4 py-2">
                      <button type="button" className="text-left hover:underline" onClick={() => (setSelected(name), setEntity(e))} aria-label={`${r.label}: ${definition.entities[e]!.label}`}>
                        {summarizeAccess(r.entities?.[e])}
                      </button>
                    </td>
                  ))}
                  <td className="px-4 py-2 text-muted">{[...(r.actions ?? []), ...(r.queries ?? [])].join(', ') || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <form
          className="flex flex-wrap gap-2 border-t border-line px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!label.trim()) return;
            const added = addItem(definition, 'roles', label.trim());
            onChange(added.definition);
            setSelected(added.name);
            setLabel('');
          }}
        >
          <TextInput aria-label="New role" className="w-64" placeholder="New role, e.g. Auditor" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button type="submit" size="sm" disabled={!label.trim()}>
            Add role
          </Button>
        </form>
      </Card>
      {role ? (
        <RolePanel key={role} definition={definition} onChange={onChange} name={role} entity={shown} onEntity={setEntity} onRemove={() => (onChange(removeItem(definition, 'roles', role)), setSelected(null))} />
      ) : (
        <EmptyState title="No roles yet">A role says what the people you share the app with may do. Add one above.</EmptyState>
      )}
    </div>
  );
}

function RolePanel({ definition, onChange, name, entity, onEntity, onRemove }: Props & { name: string; entity: string | null; onEntity: (entity: string) => void; onRemove: () => void }) {
  const role = definition.roles[name]!;
  const set = (patch: Partial<typeof role>) => onChange(updateItem(definition, 'roles', name, patch));
  const entities = recordEntities(definition);
  return (
    <Card className="grid content-start gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Label" hint={`People are shared with this role by its name, ${name}, so it can't be renamed.`}>
          {(id) => <TextInput id={id} value={role.label} onChange={(e) => set({ label: e.target.value })} />}
        </Field>
        <Field label="Description">{(id) => <TextInput id={id} value={role.description ?? ''} onChange={(e) => set({ description: e.target.value || undefined })} />}</Field>
      </div>
      {entities.length ? (
        <div className="grid gap-3">
          <nav aria-label="Kinds of record" className="flex flex-wrap gap-1 border-b border-line">
            {entities.map((e) => (
              <button
                key={e}
                type="button"
                aria-current={e === entity ? 'true' : undefined}
                onClick={() => onEntity(e)}
                className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium', e === entity ? 'border-accent text-text' : 'border-transparent text-muted hover:text-text')}
              >
                {definition.entities[e]!.pluralLabel ?? definition.entities[e]!.label}
              </button>
            ))}
          </nav>
          {entity ? <EntityAccess key={entity} definition={definition} onChange={onChange} role={name} entity={entity} /> : null}
        </div>
      ) : null}
      <Checklist
        label="Actions it may run"
        options={Object.entries(definition.actions).map(([action, a]) => ({ value: action, label: a.label }))}
        selected={role.actions ?? []}
        onChange={(actions) => set({ actions })}
        hint="An action still runs under the role's access to records."
      />
      <Checklist label="Queries it may run" options={Object.entries(definition.queries).map(([query, q]) => ({ value: query, label: q.label }))} selected={role.queries ?? []} onChange={(queries) => set({ queries })} />
      <div className="border-t border-line pt-3">
        <Button variant="danger" size="sm" onClick={onRemove}>
          Delete this role
        </Button>
        <span className="ml-3 text-xs text-faint">People shared in it lose their access.</span>
      </div>
    </Card>
  );
}

/** A role's access to one kind of record: read, create, change, delete and export. */
function EntityAccess({ definition, onChange, role, entity }: Props & { role: string; entity: string }) {
  const access: NonNullable<Access> = definition.roles[role]!.entities?.[entity] ?? {};
  const save = (next: Access) => onChange(setRoleEntity(definition, role, entity, next));
  const fields = definition.entities[entity]!.fields;
  const choices = recordChoices(definition, entity);
  // Fields, and the fields of lines as `lines.amount`.
  const paths = fields.flatMap((f) =>
    f.type === 'lines'
      ? [{ value: f.name, label: `${f.label} (all their fields)` }, ...(definition.entities[f.entity]?.fields ?? []).map((lf) => ({ value: `${f.name}.${lf.name}`, label: `${f.label}: ${lf.label}` }))]
      : [{ value: f.name, label: f.label }],
  );
  const writable = paths.filter((p) => !fields.some((f) => f.name === p.value && f.type === 'number' && f.rollup));
  const pii = fields.flatMap((f) =>
    f.type === 'lines'
      ? (definition.entities[f.entity]?.fields ?? []).filter((lf) => lf.classification === 'pii').map((lf) => ({ value: `${f.name}.${lf.name}`, label: `${f.label}: ${lf.label}` }))
      : f.classification === 'pii'
        ? [{ value: f.name, label: f.label }]
        : [],
  );

  const read = typeof access.read === 'object' ? access.read : access.read ? {} : undefined;
  const update = typeof access.update === 'object' ? access.update : access.update ? {} : undefined;
  const create = typeof access.create === 'object' ? access.create : access.create ? {} : undefined;
  const remove = typeof access.delete === 'object' ? access.delete : access.delete ? {} : undefined;
  /** An access with nothing in it is just "yes". */
  const tidy = <T extends object>(value: T | undefined): T | true | undefined => {
    if (!value) return undefined;
    const kept = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));
    return Object.keys(kept).length ? (kept as T) : true;
  };

  return (
    <div className="grid gap-5">
      <section className="grid gap-3">
        <ScopeChoice
          label="Reads"
          scope={!read ? 'none' : read.where ? 'some' : 'all'}
          onChange={(scope) => save({ ...access, read: scope === 'none' ? undefined : tidy({ ...read, where: scope === 'some' ? (read?.where ?? { eq: [{ ref: 'record.owner' }, { ref: 'principal.id' }] }) : undefined }) })}
        />
        {read?.where ? <ConditionEditor label="Reads records where" value={read.where} onChange={(where) => save({ ...access, read: tidy({ ...read, where }) })} choices={choices} compareWith={[THE_PERSON]} /> : null}
        {read ? (
          <>
            <FieldSelection label="Sees" value={read.fields} options={paths} onChange={(selection) => save({ ...access, read: tidy({ ...read, fields: selection }) })} />
            <Checklist label="Shows masked" options={paths} selected={read.mask ?? []} onChange={(mask) => save({ ...access, read: tidy({ ...read, mask }) })} />
            {pii.length ? (
              <Checklist
                label="Personal data it may see unmasked"
                options={pii}
                selected={read.unmask ?? []}
                onChange={(unmask) => save({ ...access, read: tidy({ ...read, unmask }) })}
                hint="Personal data (PII) is masked for every role unless the role unmasks it here."
              />
            ) : null}
          </>
        ) : null}
      </section>

      <section className="grid gap-3 border-t border-line pt-4">
        <Checkbox label="Creates records" checked={Boolean(create)} onChange={(on) => save({ ...access, create: on ? true : undefined })} />
        {create ? (
          <>
            <ConditionEditor
              label="Only if the new record is such that"
              value={create.check}
              onChange={(check) => save({ ...access, create: tidy({ ...create, check }) })}
              choices={choices}
              compareWith={[THE_PERSON]}
              empty="Any record it can fill in."
            />
            <FieldSelection label="Fills in" value={create.fields} options={writable} onChange={(selection) => save({ ...access, create: tidy({ ...create, fields: selection }) })} />
          </>
        ) : null}
      </section>

      <section className="grid gap-3 border-t border-line pt-4">
        <ScopeChoice
          label="Changes"
          scope={!update ? 'none' : update.where ? 'some' : 'all'}
          onChange={(scope) => save({ ...access, update: scope === 'none' ? undefined : tidy({ ...update, where: scope === 'some' ? (update?.where ?? { eq: [{ ref: 'record.owner' }, { ref: 'principal.id' }] }) : undefined }) })}
        />
        {update?.where ? <ConditionEditor label="Changes records where" value={update.where} onChange={(where) => save({ ...access, update: tidy({ ...update, where }) })} choices={choices} compareWith={[THE_PERSON]} /> : null}
        {update ? (
          <>
            <ConditionEditor
              label="Only if, after the change"
              value={update.check}
              onChange={(check) => save({ ...access, update: tidy({ ...update, check }) })}
              choices={choices}
              compareWith={[THE_PERSON]}
              empty="Any change it can make."
            />
            <FieldSelection label="Changes the fields" value={update.fields} options={writable} onChange={(selection) => save({ ...access, update: tidy({ ...update, fields: selection }) })} />
          </>
        ) : null}
      </section>

      <section className="grid gap-3 border-t border-line pt-4">
        <ScopeChoice
          label="Deletes"
          scope={!remove ? 'none' : remove.where ? 'some' : 'all'}
          onChange={(scope) => save({ ...access, delete: scope === 'none' ? undefined : tidy({ where: scope === 'some' ? (remove?.where ?? { eq: [{ ref: 'record.owner' }, { ref: 'principal.id' }] }) : undefined }) })}
        />
        {remove?.where ? <ConditionEditor label="Deletes records where" value={remove.where} onChange={(where) => save({ ...access, delete: tidy({ where }) })} choices={choices} compareWith={[THE_PERSON]} /> : null}
        <Checkbox label="Exports records" checked={Boolean(access.export)} onChange={(on) => save({ ...access, export: on || undefined })} />
      </section>
    </div>
  );
}

function ScopeChoice({ label, scope, onChange }: { label: string; scope: Scope; onChange: (scope: Scope) => void }) {
  return (
    <label className="flex flex-wrap items-center gap-2 font-medium">
      {label}
      <Select className="w-auto font-normal" value={scope} onChange={(e) => onChange(e.target.value as Scope)}>
        <option value="none">no records</option>
        <option value="all">all records</option>
        <option value="some">some records</option>
      </Select>
    </label>
  );
}

/** Which fields a permission covers: all, only some, or all but some. */
function FieldSelection({ label, value, options, onChange }: { label: string; value: Selection; options: ReadonlyArray<{ value: string; label: string }>; onChange: (selection: Selection) => void }) {
  const mode = !value ? 'all' : 'include' in value ? 'include' : 'exclude';
  const names = !value ? [] : 'include' in value ? value.include : value.exclude;
  return (
    <div className="grid gap-2">
      <Choice
        label={label}
        value={mode}
        onChange={(next) => onChange(next === 'all' ? undefined : next === 'include' ? { include: names } : { exclude: names })}
        options={[
          { value: 'all', label: 'Every field' },
          { value: 'include', label: 'Only these fields' },
          { value: 'exclude', label: 'Every field but these' },
        ]}
      />
      {value ? <Checklist label="Fields" options={options} selected={names} onChange={(next) => onChange(mode === 'include' ? { include: next } : { exclude: next })} /> : null}
    </div>
  );
}

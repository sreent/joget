import { beforeGives, checkBeforeFlows, moveSteps } from './before.js';
import { checkCondition, checkFormula, checkSteps, type Issue, stepPathOf } from './checks.js';
import { expressionRefs } from './expressions.js';
import {
  entityFields,
  type FieldInfo,
  formulaOf,
  isSortableKind,
  isWritable,
  lineOwners,
  rollupOf,
  type StoredDefinition,
  type StoredEntity,
  type StoredField,
  workedOutBy,
} from './fields.js';
import { checkFlows } from './flows.js';
import { blockPlace, pageBlocks } from './pages.js';
import { checkProcess, checkProcesses } from './process-checks.js';
import { propagateRenames } from './renames.js';
import { AppDefinition, type Entity, LINE_PATH_PATTERN, SYSTEM_FIELDS } from './schema.js';
import { givenRefs } from './tests.js';
import { canonicalValue } from './values.js';
import { compileFlows } from './waiting.js';

export type ValidationResult =
  | {
      readonly ok: true;
      readonly definition: StoredDefinition;
      /** What the platform did on the builder's behalf, such as carrying a rename through to every reference. */
      readonly notes: readonly string[];
    }
  | { readonly ok: false; readonly issues: readonly Issue[] };

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A new random ID for an entity or field: 10 lowercase letters and digits. */
export { mapRefs } from './condition-refs.js';

export function newId(): string {
  // Web Crypto, so that the studio can check a draft in the browser as the server does.
  return [...globalThis.crypto.getRandomValues(new Uint8Array(10))].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
}

const TYPE_WORDS: Readonly<Record<string, string>> = {
  string: 'text',
  number: 'a number',
  int: 'a whole number',
  boolean: 'yes or no',
  object: 'a group of settings',
  array: 'a list',
};

/** What the schema finds wrong, in plain words: its own messages are for programmers. A message a rule of the schema gives itself stays as it is. */
export function plainMessage(issue: { readonly code: string; readonly message: string }): string {
  const { code } = issue;
  // What else each kind of issue carries, such as a minimum, without a cast.
  const fields = new Map<string, unknown>(Object.entries(issue));
  const origin = typeof fields.get('origin') === 'string' ? String(fields.get('origin')) : '';
  const unit = origin === 'string' ? ' characters' : '';
  if (code === 'too_small') {
    const minimum = Number(fields.get('minimum'));
    if (origin === 'string' && minimum === 1) return "This can't be empty";
    if (origin === 'array' && minimum === 1) return 'This needs at least one';
    return fields.get('inclusive') === false ? `More than ${minimum}${unit}` : `At least ${minimum}${unit}`;
  }
  if (code === 'too_big') {
    const maximum = Number(fields.get('maximum'));
    return fields.get('inclusive') === false ? `Less than ${maximum}${unit}` : `At most ${maximum}${unit}`;
  }
  if (code === 'invalid_type') {
    // A value that is missing altogether is one that is required.
    if (/received undefined$/.test(issue.message)) return 'This is required';
    const expected = String(fields.get('expected') ?? '');
    return TYPE_WORDS[expected] ? `Expected ${TYPE_WORDS[expected]}` : issue.message;
  }
  const values = fields.get('values');
  if (code === 'invalid_value' && Array.isArray(values)) {
    const words = values.map((value: unknown) => String(value));
    return words.length === 1 ? `Expected ${words[0]}` : `Expected one of: ${words.join(', ')}`;
  }
  const keys = fields.get('keys');
  if (code === 'unrecognized_keys' && Array.isArray(keys)) return `Not a setting here: ${keys.join(', ')}`;
  return issue.message;
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((out, key) => (typeof key === 'number' ? `${out}[${key}]` : out ? `${out}.${String(key)}` : String(key)), '');
}

/**
 * Validate a definition and give every entity and field its stable ID.
 *
 * An entity or field keeps its ID when the input carries it (that's how a rename is recognized)
 * or, failing that, when it has the same name as before. Anything else is new and gets a new ID.
 */
export function validateDefinition(input: unknown, previous?: StoredDefinition, generateId: () => string = newId): ValidationResult {
  const parsed = AppDefinition.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => ({ path: formatPath(issue.path), message: plainMessage(issue) })) };
  }
  const issues: Issue[] = [];
  const notes: string[] = [];
  let definition = assignIds(parsed.data, previous, generateId, issues);
  if (issues.length === 0 && previous) definition = propagateRenames(definition, previous, notes);
  // An older definition's action steps become flows that run before their actions save.
  if (issues.length === 0) definition = moveSteps(definition, notes);
  if (issues.length === 0) {
    checkReferences(definition, issues);
    checkProcesses(definition, issues);
    checkFlows(definition, issues);
    checkBeforeFlows(definition, issues);
    checkWaitingFlows(definition, issues);
    checkTests(definition, issues);
  }
  return issues.length ? { ok: false, issues } : { ok: true, definition, notes };
}

function assignIds(data: AppDefinition, previous: StoredDefinition | undefined, generateId: () => string, issues: Issue[]): StoredDefinition {
  const unique = (taken: ReadonlySet<string>) => {
    for (;;) {
      const id = generateId();
      if (!taken.has(id)) return id;
    }
  };
  const previousEntities = Object.entries(previous?.entities ?? {});
  const claimedEntityIds = new Set(Object.values(data.entities).flatMap((entity) => (entity.id ? [entity.id] : [])));
  const takenEntityIds = new Set([...claimedEntityIds, ...previousEntities.map(([, entity]) => entity.id)]);
  const usedEntityIds = new Set<string>();

  const entities: Record<string, StoredEntity> = {};
  for (const [name, entity] of Object.entries(data.entities)) {
    const byName = previousEntities.find(([previousName, e]) => previousName === name && !claimedEntityIds.has(e.id));
    const id = entity.id ?? byName?.[1].id ?? unique(takenEntityIds);
    takenEntityIds.add(id);
    if (usedEntityIds.has(id)) issues.push({ path: `entities.${name}.id`, message: 'Another entity already has this ID' });
    usedEntityIds.add(id);
    const before = previousEntities.find(([, e]) => e.id === id)?.[1];
    entities[name] = { ...entity, id, fields: assignFieldIds(name, entity, before, unique, issues) };
  }
  return { ...data, entities };
}

function assignFieldIds(
  entityName: string,
  entity: Entity,
  before: StoredEntity | undefined,
  unique: (taken: ReadonlySet<string>) => string,
  issues: Issue[],
): StoredField[] {
  const previousFields = before?.fields ?? [];
  const claimed = new Set(entity.fields.flatMap((field) => (field.id ? [field.id] : [])));
  const taken = new Set([...claimed, ...previousFields.map((field) => field.id)]);
  const used = new Set<string>();
  return entity.fields.map((field, index) => {
    const byName = previousFields.find((f) => f.name === field.name && !claimed.has(f.id));
    const id = field.id ?? byName?.id ?? unique(taken);
    taken.add(id);
    if (used.has(id)) issues.push({ path: `entities.${entityName}.fields[${index}].id`, message: 'Another field already has this ID' });
    used.add(id);
    return { ...field, id };
  });
}

/**
 * Check the app's tests: the action and the role each names, the records it makes first, and the
 * fields its values are for. The values themselves are checked as the test runs, as any input is.
 */
function checkTests(definition: StoredDefinition, issues: Issue[]): void {
  const lines = lineOwners(definition);
  for (const [name, test] of Object.entries(definition.tests ?? {})) {
    const path = `tests.${name}`;
    const values = (entity: string, given: Readonly<Record<string, unknown>>, at: string, inputs?: readonly string[]) => {
      const known = definition.entities[entity];
      for (const [field, value] of Object.entries(given)) {
        if (known && field !== 'owner' && !known.fields.some((f) => f.name === field))
          issues.push({ path: `${at}.${field}`, message: `${known.label} has no field ${field}` });
        else if (inputs && !inputs.includes(field)) issues.push({ path: `${at}.${field}`, message: `${field} isn't one of the action's inputs` });
        for (const ref of givenRefs(value)) if (!(ref in test.given)) issues.push({ path: `${at}.${field}`, message: `The test makes no record named ${ref}` });
      }
    };
    for (const [given, record] of Object.entries(test.given)) {
      const at = `${path}.given.${given}`;
      if (!definition.entities[record.entity]) issues.push({ path: `${at}.entity`, message: `No entity named ${record.entity}` });
      else if (lines.has(record.entity))
        issues.push({ path: `${at}.entity`, message: `${record.entity} is the lines of another entity: make that record, with its lines` });
      else values(record.entity, record.values, `${at}.values`);
    }
    if (!definition.roles[test.when.as]) issues.push({ path: `${path}.when.as`, message: `No role named ${test.when.as}` });
    const action = definition.actions[test.when.action];
    if (!action) {
      issues.push({ path: `${path}.when.action`, message: `No action named ${test.when.action}` });
      continue;
    }
    const record = test.when.record ? test.given[test.when.record] : undefined;
    if (action.operation === 'update' && !test.when.record)
      issues.push({ path: `${path}.when.record`, message: `${action.label} changes a record: name one that the test makes` });
    else if (action.operation === 'create' && test.when.record)
      issues.push({ path: `${path}.when.record`, message: `${action.label} makes its own record: it changes none` });
    else if (test.when.record && !record) issues.push({ path: `${path}.when.record`, message: `The test makes no record named ${test.when.record}` });
    else if (record && record.entity !== action.entity)
      issues.push({
        path: `${path}.when.record`,
        message: `${test.when.record} is a record of ${record.entity}, and ${action.label} changes one of ${action.entity}`,
      });
    values(action.entity, test.when.values, `${path}.when.values`, [...action.input]);
    if (test.then.outcome === 'saved') values(action.entity, test.then.values, `${path}.then.values`);
  }
}

function checkReferences(definition: StoredDefinition, issues: Issue[]): void {
  const owners = lineOwners(definition);
  const fieldsOf = new Map(Object.entries(definition.entities).map(([name, entity]) => [name, entityFields(entity, { line: owners.has(name) })]));
  const linesOf = new Map(
    Object.entries(definition.entities).map(([name, entity]) => [name, new Set(entity.fields.filter((f) => f.type === 'lines').map((f) => f.name))]),
  );
  const entityAt = (name: string, path: string) => {
    const fields = fieldsOf.get(name);
    if (!fields) issues.push({ path, message: `No entity named ${name}` });
    return fields;
  };
  /** The entity whose records something works on. Line entities have no records of their own. */
  const recordEntityAt = (name: string, path: string) => {
    const owner = owners.get(name);
    if (owner) {
      issues.push({ path, message: `${name} is the lines of ${owner.parent}.${owner.field}, so it has no records of its own: use ${owner.parent}` });
      return undefined;
    }
    return entityAt(name, path);
  };
  /** The line entity of a lines field. */
  const lineEntityOf = (entity: string, lines: string) => {
    const field = definition.entities[entity]?.fields.find((f) => f.name === lines);
    return field?.type === 'lines' ? definition.entities[field.entity] : undefined;
  };
  /** A field of an entity's records, or a field of its lines named as `lines.amount`. */
  const fieldAt = (entity: string, name: string): { info?: FieldInfo; lines?: boolean } | undefined => {
    const match = LINE_PATH_PATTERN.exec(name);
    if (!match)
      return linesOf.get(entity)?.has(name) ? { lines: true } : fieldsOf.get(entity)?.has(name) ? { info: fieldsOf.get(entity)!.get(name)! } : undefined;
    const lineEntity = lineEntityOf(entity, match[1]!);
    const info = lineEntity ? entityFields(lineEntity, { line: true }).get(match[2]!) : undefined;
    return info && !info.system ? { info } : undefined;
  };

  for (const [name, entity] of Object.entries(definition.entities)) {
    const base = `entities.${name}`;
    const seen = new Set<string>();
    entity.fields.forEach((field, index) => {
      const path = `${base}.fields[${index}]`;
      if ((SYSTEM_FIELDS as readonly string[]).includes(field.name)) issues.push({ path: `${path}.name`, message: `${field.name} is a system field` });
      if (seen.has(field.name)) issues.push({ path: `${path}.name`, message: `Another field is already named ${field.name}` });
      seen.add(field.name);
      if (field.type === 'reference' && !definition.entities[field.entity]) {
        issues.push({ path: `${path}.entity`, message: `No entity named ${field.entity}` });
      } else if (field.type === 'reference' && owners.has(field.entity)) {
        issues.push({ path: `${path}.entity`, message: `${field.entity} is lines of another entity, so nothing else can refer to its lines` });
      }
      if (field.type === 'lines') {
        const target = definition.entities[field.entity];
        const owner = owners.get(field.entity);
        if (!target) issues.push({ path: `${path}.entity`, message: `No entity named ${field.entity}` });
        else if (field.entity === name) issues.push({ path: `${path}.entity`, message: "An entity can't be lines of itself" });
        else if (owner && (owner.parent !== name || owner.field !== field.name)) {
          issues.push({ path: `${path}.entity`, message: `${field.entity} is already the lines of ${owner.parent}.${owner.field}` });
        } else if (target.fields.some((f) => f.type === 'lines')) {
          issues.push({ path: `${path}.entity`, message: `${field.entity} has lines of its own; lines go one level deep` });
        }
        if (owners.has(name)) issues.push({ path, message: `${name} is itself lines of another entity; lines go one level deep` });
        if (field.classification === 'pii') issues.push({ path: `${path}.classification`, message: `Classify the fields of ${field.entity} instead` });
      }
      if (owners.has(name) && 'unique' in field && field.unique) {
        issues.push({ path: `${path}.unique`, message: "Fields of lines can't be unique yet" });
      }
      const rollup = rollupOf(field);
      if (rollup) {
        const [op, at] = Object.entries(rollup)[0] as ['sum' | 'min' | 'max' | 'count', string];
        const [linesName, sub] = at.split('.') as [string, string | undefined];
        const lineEntity = lineEntityOf(name, linesName);
        if (!lineEntity) issues.push({ path: `${path}.rollup`, message: `${name} has no lines field named ${linesName}` });
        else if (op !== 'count') {
          const source = lineEntity.fields.find((f) => f.name === sub);
          if (source?.type !== 'number') issues.push({ path: `${path}.rollup`, message: `${sub} isn't a number field of ${linesName}` });
          else if (field.type === 'number' && source.decimals > field.decimals) {
            issues.push({ path: `${path}.decimals`, message: `${sub} has ${source.decimals} decimal places, so the ${op} needs at least as many` });
          }
        }
        if (field.required) issues.push({ path: `${path}.required`, message: "A field worked out from lines always has its value: it can't be required" });
        if ('default' in field && field.default !== undefined)
          issues.push({ path: `${path}.default`, message: "A field worked out from lines can't have a default" });
        if (formulaOf(field)) issues.push({ path: `${path}.formula`, message: 'A field is worked out from lines or by a formula, not both' });
        if ('unique' in field && field.unique) issues.push({ path: `${path}.unique`, message: "A field worked out from lines can't be unique" });
      }
      if (field.type === 'number' && field.min !== undefined && field.max !== undefined && field.min > field.max) {
        issues.push({ path, message: 'min is greater than max' });
      }
      if (field.type === 'choice' && new Set(field.options.map((o) => o.value)).size !== field.options.length) {
        issues.push({ path: `${path}.options`, message: 'Option values must be unique' });
      }
      // A default that is worked out as a record is written, such as today, has its shape checked already.
      const dynamic = 'default' in field && field.default !== null && typeof field.default === 'object' && !Array.isArray(field.default);
      if ('default' in field && field.default !== undefined && !dynamic) {
        const result = canonicalValue(fieldsOf.get(name)!.get(field.name)!, field.default);
        if (!result.ok) issues.push({ path: `${path}.default`, message: result.issue.message });
      }
      const formula = formulaOf(field);
      if (formula && !rollup) {
        checkFormula(field, formula, fieldsOf.get(name)!, linesOf.get(name)!, path, issues);
        if (field.required || field.requiredWhen)
          issues.push({ path: `${path}.required`, message: 'The platform works this field out, so nobody can be asked to fill it in' });
        if ('default' in field && field.default !== undefined)
          issues.push({ path: `${path}.default`, message: 'A field worked out by a formula has no default' });
      }
      if (field.requiredWhen) {
        const at = `${path}.requiredWhen`;
        if (field.type === 'lines') issues.push({ path: at, message: 'A lines field is required always, or not at all' });
        else if (rollup) issues.push({ path: at, message: "A field worked out from lines always has its value: it can't be required" });
        else if (field.required) issues.push({ path: at, message: `${field.label} is always required: leave out the condition, or make it not required` });
        else checkCondition(field.requiredWhen, { record: fieldsOf.get(name)!, lines: linesOf.get(name)! }, at, issues);
      }
    });
    if (entity.titleField && !fieldsOf.get(name)!.has(entity.titleField)) {
      issues.push({ path: `${base}.titleField`, message: `No field named ${entity.titleField}` });
    } else if (entity.titleField && fieldsOf.get(name)!.get(entity.titleField)?.kind === 'uuid[]') {
      // Other records show a record by its title: a list of other records names none.
      issues.push({ path: `${base}.titleField`, message: `${entity.titleField} holds several records, so it can't name a record` });
    }
    // Formulas work each other out in order: a loop of them would never end.
    const reads = new Map(
      entity.fields.flatMap((field) => {
        const formula = formulaOf(field);
        return formula
          ? [[field.name, expressionRefs(formula).flatMap((ref) => (ref.startsWith('record.') ? [ref.slice('record.'.length)] : []))] as const]
          : [];
      }),
    );
    const looping = new Set<string>();
    const walk = (field: string, trail: readonly string[]): void => {
      if (trail.includes(field)) {
        if (field === trail[0]) looping.add(field);
        return;
      }
      for (const next of reads.get(field) ?? []) if (reads.has(next)) walk(next, [...trail, field]);
    };
    for (const field of reads.keys()) walk(field, []);
    entity.fields.forEach((field, index) => {
      if (looping.has(field.name))
        issues.push({ path: `${base}.fields[${index}].formula`, message: `${field.label}'s formula reads itself, through other formulas: break the loop` });
    });
  }

  for (const [name, rule] of Object.entries(definition.rules)) {
    const fields = entityAt(rule.entity, `rules.${name}.entity`);
    if (!fields) continue;
    const scope = { record: fields, lines: linesOf.get(rule.entity)! };
    if (rule.when) checkCondition(rule.when, scope, `rules.${name}.when`, issues);
    checkCondition(rule.assert, scope, `rules.${name}.assert`, issues);
    for (const field of rule.fields ?? []) if (!fields.has(field)) issues.push({ path: `rules.${name}.fields`, message: `No field named ${field}` });
  }

  for (const [name, action] of Object.entries(definition.actions)) {
    const path = `actions.${name}`;
    const fields = recordEntityAt(action.entity, `${path}.entity`);
    if (!fields) continue;
    const entity = definition.entities[action.entity]!;
    const lines = linesOf.get(action.entity)!;
    const input = new Set<string>();
    for (const field of action.input) {
      const info = fields.get(field);
      if (!info && !lines.has(field)) issues.push({ path: `${path}.input`, message: `No field named ${field}` });
      else if (info && !isWritable(info))
        issues.push({ path: `${path}.input`, message: info.system ? `${field} is set by the platform` : `${field} is ${workedOutBy(info)}` });
      if (input.has(field)) issues.push({ path: `${path}.input`, message: `${field} is listed twice` });
      input.add(field);
    }
    for (const [field, value] of Object.entries(action.set)) {
      const info = fields.get(field);
      if (lines.has(field)) {
        issues.push({ path: `${path}.set.${field}`, message: `An action can't set lines: take ${field} as input` });
        continue;
      }
      if (!info || !isWritable(info)) {
        issues.push({ path: `${path}.set.${field}`, message: info ? `${field} is set by the platform` : `No field named ${field}` });
        continue;
      }
      if (input.has(field)) issues.push({ path: `${path}.set.${field}`, message: `${field} is both an input and set by the action` });
      const result = canonicalValue(info, value);
      if (!result.ok) issues.push({ path: `${path}.set.${field}`, message: result.issue.message });
    }
    checkSteps(definition, action, path, fields, lines, issues);
    if (action.operation === 'create') {
      if (action.where) issues.push({ path: `${path}.where`, message: 'Only updates apply to existing records' });
      const stepsGive = beforeGives(definition, action);
      for (const field of entity.fields) {
        // The platform works out a formula's value: its own check says it can't be required.
        const provided =
          input.has(field.name) ||
          field.name in action.set ||
          stepsGive.has(field.name) ||
          ('default' in field && field.default !== undefined) ||
          Boolean(formulaOf(field));
        if (field.required && !provided) {
          issues.push({
            path: `${path}.input`,
            message:
              field.type === 'lines'
                ? `${field.name} needs at least one line, so the action must take it as input`
                : `${field.name} is required, so the action must take it as input, set it, or the field needs a default`,
          });
        }
      }
    } else if (action.where) {
      checkCondition(action.where, { record: fields, lines }, `${path}.where`, issues);
    }
    if (action.card) {
      const card = definition.cards[action.card];
      if (!card) issues.push({ path: `${path}.card`, message: `No card named ${action.card}` });
      else if (card.entity !== action.entity) issues.push({ path: `${path}.card`, message: `${action.card} shows ${card.entity}, not ${action.entity}` });
    }
  }

  for (const [name, query] of Object.entries(definition.queries)) {
    const path = `queries.${name}`;
    const fields = recordEntityAt(query.entity, `${path}.entity`);
    if (!fields) continue;
    const lines = linesOf.get(query.entity)!;
    for (const field of query.fields) if (!fields.has(field) && !lines.has(field)) issues.push({ path: `${path}.fields`, message: `No field named ${field}` });
    if (query.summary) {
      if (query.fields.length) issues.push({ path: `${path}.fields`, message: 'A query that answers with numbers returns no fields' });
      if (query.sort.length)
        issues.push({ path: `${path}.sort`, message: 'A query that answers with numbers is in its own order: largest first, or latest first' });
    } else if (!query.fields.length) {
      issues.push({ path: `${path}.fields`, message: 'Name at least one field each record carries, or let the query answer with numbers' });
    }
    const input = new Map(Object.entries(query.parameters).map(([param, spec]) => [param, spec.type] as const));
    if (query.filter) checkCondition(query.filter, { record: fields, lines, input }, `${path}.filter`, issues);
    query.sort.forEach((sort, index) => {
      const info = fields.get(sort.field);
      if (!info)
        issues.push({
          path: `${path}.sort[${index}]`,
          message: lines.has(sort.field) ? `${sort.field} holds lines, which can't be sorted by` : `No field named ${sort.field}`,
        });
      else if (!isSortableKind(info.kind)) issues.push({ path: `${path}.sort[${index}]`, message: `${sort.field} can't be sorted` });
    });
  }

  for (const [name, card] of Object.entries(definition.cards)) {
    const fields = recordEntityAt(card.entity, `cards.${name}.entity`);
    if (!fields) continue;
    const lines = linesOf.get(card.entity)!;
    for (const field of card.show) if (!fields.has(field) && !lines.has(field)) issues.push({ path: `cards.${name}.show`, message: `No field named ${field}` });
    for (const [, field] of card.title.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)) {
      if (!fields.has(field!))
        issues.push({
          path: `cards.${name}.title`,
          message: lines.has(field!) ? `${field} holds lines: put a rollup, such as a total, in the title` : `No field named ${field}`,
        });
    }
    if (card.table) {
      const lineEntity = lineEntityOf(card.entity, card.table.of);
      if (!lineEntity) issues.push({ path: `cards.${name}.table.of`, message: `${card.entity} has no lines field named ${card.table.of}` });
      else {
        for (const column of card.table.columns) {
          if (!lineEntity.fields.some((f) => f.name === column))
            issues.push({ path: `cards.${name}.table.columns`, message: `${card.table.of} has no field named ${column}` });
        }
      }
    }
  }

  for (const [name, form] of Object.entries(definition.forms)) {
    const path = `forms.${name}`;
    const fields = recordEntityAt(form.entity, `${path}.entity`);
    if (!fields) continue;
    const lines = linesOf.get(form.entity)!;
    const action = form.action ? definition.actions[form.action] : undefined;
    if (form.action && !action) issues.push({ path: `${path}.action`, message: `No action named ${form.action}` });
    else if (action && action.entity !== form.entity)
      issues.push({ path: `${path}.action`, message: `${form.action} works on ${action.entity}, not ${form.entity}` });
    const placed = new Set<string>();
    form.sections.forEach((section, s) => {
      section.fields.forEach((item, f) => {
        const at = `${path}.sections[${s}].fields[${f}]`;
        const info = fields.get(item.field);
        if (!info && !lines.has(item.field)) issues.push({ path: at, message: `No field named ${item.field}` });
        else if (info && !item.readOnly && !isWritable(info))
          issues.push({ path: at, message: `${item.field} is ${info.system ? 'set by the platform' : workedOutBy(info)}: show it read-only` });
        else if (action && !item.readOnly && !action.input.includes(item.field)) {
          issues.push({ path: at, message: `${item.field} isn't an input of ${form.action}: show it read-only, or add it to the action's inputs` });
        }
        if (placed.has(item.field)) issues.push({ path: at, message: `${item.field} is on the form twice` });
        placed.add(item.field);
        if (item.visibleWhen) checkCondition(item.visibleWhen, { record: fields, lines }, `${at}.visibleWhen`, issues);
      });
    });
    if (form.layout === 'steps' && form.sections.length < 2)
      issues.push({ path: `${path}.layout`, message: 'A form in steps has a step for each section: give it two sections or more' });
  }

  for (const [roleName, role] of Object.entries(definition.roles)) {
    const base = `roles.${roleName}`;
    for (const [entityName, permissions] of Object.entries(role.entities)) {
      const path = `${base}.entities.${entityName}`;
      const fields = recordEntityAt(entityName, path);
      if (!fields) continue;
      const lines = linesOf.get(entityName)!;
      for (const [verb, access] of Object.entries(permissions)) {
        if (typeof access !== 'object' || access === null) continue;
        if ('where' in access && access.where) checkCondition(access.where, { record: fields, lines }, `${path}.${verb}.where`, issues);
        if ('check' in access && access.check) checkCondition(access.check, { record: fields, lines }, `${path}.${verb}.check`, issues);
        if ('fields' in access && access.fields) {
          const names = 'include' in access.fields ? access.fields.include : access.fields.exclude;
          for (const field of names) {
            const found = fieldAt(entityName, field);
            if (!found) issues.push({ path: `${path}.${verb}.fields`, message: `No field named ${field}` });
            else if (verb !== 'read' && found.info && !isWritable(found.info)) {
              issues.push({ path: `${path}.${verb}.fields`, message: `${field} is ${found.info.system ? 'set by the platform' : workedOutBy(found.info)}` });
            }
          }
        }
        for (const key of ['mask', 'unmask'] as const) {
          for (const field of (key in access ? (access as Record<string, string[] | undefined>)[key] : undefined) ?? []) {
            const found = fieldAt(entityName, field);
            const declared = found?.info?.field;
            if (!found || (!declared && !found.lines)) issues.push({ path: `${path}.${verb}.${key}`, message: `No field named ${field}` });
            else if (key === 'unmask' && declared?.classification !== 'pii') {
              issues.push({ path: `${path}.${verb}.unmask`, message: `${field} isn't classified as PII, so it is never masked` });
            }
          }
        }
      }
    }
    for (const action of role.actions) if (!definition.actions[action]) issues.push({ path: `${base}.actions`, message: `No action named ${action}` });
    for (const query of role.queries) if (!definition.queries[query]) issues.push({ path: `${base}.queries`, message: `No query named ${query}` });
  }

  /** A field of an entity's records, or a field of its lines as `lines.amount`, with the lines field it belongs to. */
  const summaryField = (entity: string, path: string): { info: FieldInfo; lines?: string } | undefined => {
    const match = LINE_PATH_PATTERN.exec(path);
    if (!match) {
      const info = fieldsOf.get(entity)?.get(path);
      return info ? { info } : undefined;
    }
    const lineEntity = lineEntityOf(entity, match[1]!);
    const info = lineEntity ? entityFields(lineEntity, { line: true }).get(match[2]!) : undefined;
    return info && !info.system ? { info, lines: match[1]! } : undefined;
  };
  const isDated = (info: FieldInfo) => info.kind === 'date' || info.kind === 'datetime';
  /** Fields whose values make sensible groups: choices, text, yes or no, and people. */
  const groupable = (info: FieldInfo) =>
    info.kind === 'text' ||
    info.kind === 'boolean' ||
    (info.kind === 'uuid' && info.name !== 'id' && info.field?.type !== 'reference' && info.field?.type !== 'file');
  const OPS = { sum: 'total', avg: 'average', min: 'find the smallest of', max: 'find the largest of' } as const;

  /** A number or a chart: what it works out, over what, grouped how, and over which lines. */
  const checkSummary = (block: Extract<StoredDefinition['pages'][string]['blocks'][number], { type: 'stat' | 'chart' }>, path: string): void => {
    const fields = recordEntityAt(block.entity, `${path}.entity`);
    if (!fields) return;
    const lines = linesOf.get(block.entity)!;
    const over = new Set<string>();
    const { measure } = block;
    if (measure.op === 'count') {
      if (measure.field !== undefined) {
        if (lines.has(measure.field)) over.add(measure.field);
        else issues.push({ path: `${path}.measure.field`, message: `Count records, or name a lines field to count lines: ${measure.field} isn't one` });
      }
    } else if (!measure.field) {
      issues.push({ path: `${path}.measure.field`, message: `Name the number field to ${OPS[measure.op]}` });
    } else {
      const found = summaryField(block.entity, measure.field);
      if (!found) issues.push({ path: `${path}.measure.field`, message: `No field named ${measure.field}` });
      else if (found.info.kind !== 'number') issues.push({ path: `${path}.measure.field`, message: `${measure.field} isn't a number` });
      else if (found.lines) over.add(found.lines);
    }
    if (block.type === 'chart') {
      const { field, period } = block.group;
      const found = summaryField(block.entity, field);
      if (!found) {
        issues.push({
          path: `${path}.group.field`,
          message: lines.has(field) ? `${field} holds lines: group by a field of them, such as ${field}.category` : `No field named ${field}`,
        });
      } else {
        if (found.lines) over.add(found.lines);
        if (isDated(found.info) && !period) issues.push({ path: `${path}.group.period`, message: `${field} is a date: group it by periods, such as month` });
        else if (!isDated(found.info) && period) issues.push({ path: `${path}.group.period`, message: `Only dates group by periods: ${field} isn't one` });
        else if (!isDated(found.info) && !groupable(found.info)) {
          issues.push({ path: `${path}.group.field`, message: `${field} can't group records: group by a choice, text, a yes or no, a person or a date` });
        }
        if (block.show === 'line' && !period)
          issues.push({ path: `${path}.show`, message: 'A line shows change over time: group by periods of a date, or show bars' });
      }
    }
    if (block.range) {
      const found = summaryField(block.entity, block.range.field);
      if (!found || !isDated(found.info)) issues.push({ path: `${path}.range.field`, message: `${block.range.field} isn't a date or a time` });
      else if (found.lines) over.add(found.lines);
    }
    if (over.size > 1) issues.push({ path, message: `A number or a chart works over the lines of one lines field at most, not ${[...over].join(' and ')}` });
    // Over lines, each record appears once per line: a field of the records would count again and again.
    if (over.size && measure.op !== 'count' && measure.field && !LINE_PATH_PATTERN.test(measure.field)) {
      issues.push({ path: `${path}.measure.field`, message: `This works over lines, so ${OPS[measure.op]} a field of them, such as ${[...over][0]}.amount` });
    }
    if (block.filter) checkCondition(block.filter, { record: fields, lines }, `${path}.filter`, issues);
  };

  // A query that answers with numbers is checked as a number or a chart is. Its filter is checked with its parameters, above.
  for (const [name, query] of Object.entries(definition.queries)) {
    const summary = query.summary;
    if (!summary || !definition.entities[query.entity]) continue;
    const base = { entity: query.entity, measure: summary.measure, ...(summary.range ? { range: summary.range } : {}) };
    checkSummary(
      summary.group
        ? { type: 'chart', title: query.label, ...base, group: summary.group, show: 'bar', limit: summary.limit, width: 'half' }
        : { type: 'stat', label: query.label, ...base },
      `queries.${name}.summary`,
    );
  }

  /** The pages about one record: a link can't open one, since it needs its record. */
  const recordPage = (name: string) => definition.pages[name]?.record !== undefined;
  for (const [name, page] of Object.entries(definition.pages ?? {})) {
    for (const role of page.roles ?? []) if (!definition.roles[role]) issues.push({ path: `pages.${name}.roles`, message: `No role named ${role}` });
    const about = page.record ? recordEntityAt(page.record.entity, `pages.${name}.record.entity`) && page.record.entity : undefined;
    /** An update action that runs on a record in one click. */
    const oneClick = (actionName: string, entity: string, at: string, where: string) => {
      const action = definition.actions[actionName];
      if (!action) issues.push({ path: at, message: `No action named ${actionName}` });
      else if (action.entity !== entity || action.operation !== 'update')
        issues.push({ path: at, message: `${actionName} doesn't change a ${entity} record, so it can't run on ${where}` });
      else if (action.input.length) issues.push({ path: at, message: `${actionName} takes input, so it can't run in one click: open it from a form instead` });
    };
    /** `of`: a reference field of the block's entity that points at the record the page is about, or a list that may hold it. */
    const ofField = (entity: string, field: string | undefined, at: string) => {
      if (field === undefined) return;
      if (!page.record) return issues.push({ path: `${at}.of`, message: 'Only a page about one record shows the records that refer to it' });
      const declared = definition.entities[entity]?.fields.find((f) => f.name === field);
      if (declared?.type !== 'reference' || declared.entity !== page.record.entity) {
        issues.push({ path: `${at}.of`, message: `${field} isn't a field of ${entity} that refers to a ${page.record.entity}` });
      }
    };
    for (const { block, path: where } of pageBlocks(page)) {
      const path = `pages.${name}.${blockPlace(where)}`;
      if (block.type === 'buttons') {
        block.buttons.forEach((button, b) => {
          if ('form' in button && !definition.forms[button.form]) issues.push({ path: `${path}.buttons[${b}]`, message: `No form named ${button.form}` });
          if ('page' in button && !definition.pages[button.page]) issues.push({ path: `${path}.buttons[${b}]`, message: `No page named ${button.page}` });
          else if ('page' in button && recordPage(button.page))
            issues.push({ path: `${path}.buttons[${b}]`, message: `${button.page} is about one record, so a list's row opens it, not a button` });
        });
      }
      if (block.type === 'fields') {
        if (!about) {
          issues.push({ path, message: 'Only a page about one record shows its fields: say which entity the page is about' });
          continue;
        }
        // A lines field shows as a table of its lines.
        const fields = entityFields(definition.entities[about]!);
        const lines = linesOf.get(about)!;
        for (const field of block.fields)
          if ((!fields.has(field) && !lines.has(field)) || field === 'version') issues.push({ path: `${path}.fields`, message: `No field named ${field}` });
        for (const actionName of block.actions) oneClick(actionName, about, `${path}.actions`, 'this record');
        continue;
      }
      if (block.type === 'stat' || block.type === 'chart') {
        checkSummary(block, path);
        ofField(block.entity, block.of, path);
        continue;
      }
      if (block.type !== 'list') continue;
      const fields = recordEntityAt(block.entity, `${path}.entity`);
      if (!fields) continue;
      const lines = linesOf.get(block.entity)!;
      const shown = new Set<string>();
      for (const column of block.columns) {
        const info = fields.get(column);
        if (lines.has(column)) issues.push({ path: `${path}.columns`, message: `${column} holds lines: show a rollup, such as a total, instead` });
        else if (!info || column === 'id' || column === 'version') issues.push({ path: `${path}.columns`, message: `No field named ${column}` });
        if (shown.has(column)) issues.push({ path: `${path}.columns`, message: `${column} is a column twice` });
        shown.add(column);
      }
      if (block.filter) checkCondition(block.filter, { record: fields, lines }, `${path}.filter`, issues);
      block.sort.forEach((sort, s) => {
        const info = fields.get(sort.field);
        if (!info)
          issues.push({
            path: `${path}.sort[${s}]`,
            message: lines.has(sort.field) ? `${sort.field} holds lines, which can't be sorted by` : `No field named ${sort.field}`,
          });
        else if (!isSortableKind(info.kind)) issues.push({ path: `${path}.sort[${s}]`, message: `${sort.field} can't be sorted` });
      });
      for (const actionName of block.actions) oneClick(actionName, block.entity, `${path}.actions`, 'a row');
      ofField(block.entity, block.of, path);
      if (block.open !== undefined) {
        const opened = definition.pages[block.open];
        if (!opened) issues.push({ path: `${path}.open`, message: `No page named ${block.open}` });
        else if (opened.record?.entity !== block.entity)
          issues.push({ path: `${path}.open`, message: `${block.open} isn't a page about one ${block.entity}, so a row can't open it` });
      }
    }
  }

  if (definition.navigation) {
    const { home, items } = definition.navigation;
    if (home && !definition.pages[home]) issues.push({ path: 'navigation.home', message: `No page named ${home}` });
    else if (home && recordPage(home)) issues.push({ path: 'navigation.home', message: `${home} is about one record, so the app can't open on it` });
    items.forEach((item, index) => {
      const path = `navigation.items[${index}]`;
      if ('page' in item && !definition.pages[item.page]) issues.push({ path, message: `No page named ${item.page}` });
      else if ('page' in item && recordPage(item.page))
        issues.push({ path, message: `${item.page} is about one record, so a list's row opens it, not the menu` });
      if ('form' in item && !definition.forms[item.form]) issues.push({ path, message: `No form named ${item.form}` });
      if ('entity' in item) recordEntityAt(item.entity, path);
    });
  }
}

/**
 * Check each flow that waits as the engine runs it: the roles, fields, actions and cards that its
 * tasks and waits name, and how its parts join. The issues show on the steps they are about. A
 * flow with issues of its own waits until they are fixed, so that each issue shows once.
 */
function checkWaitingFlows(definition: StoredDefinition, issues: Issue[]): void {
  if (!definition.flows) return;
  const compiled = compileFlows(definition);
  const flawed = new Set(issues.flatMap((issue) => /^flows\.([a-z][a-z0-9_]*)/.exec(issue.path)?.slice(1, 2) ?? []));
  const runs: StoredDefinition = {
    ...definition,
    processes: { ...definition.processes, ...compiled.processes },
    flows: { ...definition.flows, ...compiled.parts },
  };
  for (const [name, process] of Object.entries(compiled.processes)) {
    if (definition.processes?.[name]) {
      issues.push({ path: `flows.${name}`, message: `A process is also named ${name}, and a flow that waits runs as one: rename one of them` });
      continue;
    }
    if (flawed.has(name)) continue;
    const found: Issue[] = [];
    checkProcess(runs, name, process, found);
    const at = compiled.at.get(name) ?? new Map<string, string>();
    for (const issue of found) issues.push({ path: stepPathOf(name, issue.path, process, at), message: issue.message });
  }
}

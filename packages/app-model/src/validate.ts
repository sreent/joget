import { randomBytes } from 'node:crypto';
import { COMPARISON_OPERATORS, isRef, type Condition, type Operand } from '@platform/authz';
import {
  entityFields,
  isConditionKind,
  isSortableKind,
  isWritable,
  jsTypeOf,
  type FieldInfo,
  type StoredDefinition,
  type StoredEntity,
  type StoredField,
} from './fields.js';
import { AppDefinition, SYSTEM_FIELDS, type Entity } from './schema.js';
import { canonicalValue } from './values.js';

export interface Issue {
  /** Where in the definition, for example `entities.expense_claim.fields[2].name`. */
  readonly path: string;
  readonly message: string;
}

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
export function newId(): string {
  return [...randomBytes(10)].map((byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
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
    return { ok: false, issues: parsed.error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })) };
  }
  const issues: Issue[] = [];
  const notes: string[] = [];
  let definition = assignIds(parsed.data, previous, generateId, issues);
  if (issues.length === 0 && previous) definition = propagateRenames(definition, previous, notes);
  if (issues.length === 0) checkReferences(definition, issues);
  return issues.length ? { ok: false, issues } : { ok: true, definition, notes };
}

function mapRefs(condition: Condition, rename: (ref: string) => string): Condition {
  const operand = (o: Operand): Operand => (isRef(o) ? { ref: rename(o.ref) } : o);
  if ('all' in condition) return { all: condition.all.map((c) => mapRefs(c, rename)) };
  if ('any' in condition) return { any: condition.any.map((c) => mapRefs(c, rename)) };
  if ('not' in condition) return { not: mapRefs(condition.not, rename) };
  if ('exists' in condition) return { exists: rename(condition.exists) };
  if ('in' in condition) {
    const [needle, haystack] = condition.in;
    return { in: [operand(needle), Array.isArray(haystack) ? (haystack as readonly Operand[]).map(operand) : operand(haystack as Operand)] };
  }
  const [op, args] = Object.entries(condition)[0] as [string, readonly [Operand, Operand]];
  return { [op]: [operand(args[0]), operand(args[1])] } as unknown as Condition;
}

/**
 * Carry renames through. When an entity or field keeps its ID under a new name, references to
 * the old name are updated everywhere, unless something else now has the old name.
 */
function propagateRenames(definition: StoredDefinition, previous: StoredDefinition, notes: string[]): StoredDefinition {
  const previousById = new Map(Object.entries(previous.entities).map(([name, entity]) => [entity.id, { name, entity }]));
  const entityRenames = new Map<string, string>();
  const fieldRenames = new Map<string, Map<string, string>>();
  for (const [name, entity] of Object.entries(definition.entities)) {
    const before = previousById.get(entity.id);
    if (!before) continue;
    if (before.name !== name && !(before.name in definition.entities)) entityRenames.set(before.name, name);
    const oldNames = new Map(before.entity.fields.map((field) => [field.id, field.name]));
    const current = new Set(entity.fields.map((field) => field.name));
    const renames = new Map<string, string>();
    for (const field of entity.fields) {
      const old = oldNames.get(field.id);
      if (old && old !== field.name && !current.has(old)) renames.set(old, field.name);
    }
    if (renames.size) fieldRenames.set(name, renames);
  }
  if (entityRenames.size === 0 && fieldRenames.size === 0) return definition;

  const touched = new Set<string>();
  const entityName = (name: string) => {
    const renamed = entityRenames.get(name);
    if (renamed) touched.add(`entity ${name} → ${renamed}`);
    return renamed ?? name;
  };
  const fieldName = (entity: string) => (name: string) => {
    const renamed = fieldRenames.get(entity)?.get(name);
    if (renamed) touched.add(`${entity}.${name} → ${renamed}`);
    return renamed ?? name;
  };
  const refs = (entity: string) => (ref: string) => (ref.startsWith('record.') ? `record.${fieldName(entity)(ref.slice('record.'.length))}` : ref);
  const condition = <T extends Condition | undefined>(entity: string, c: T): T => (c ? (mapRefs(c, refs(entity)) as T) : c);
  const mapRecord = <T>(record: Readonly<Record<string, T>>, map: (value: T) => T) =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]));

  const entities = Object.fromEntries(
    Object.entries(definition.entities).map(([name, entity]) => [
      name,
      {
        ...entity,
        ...(entity.titleField ? { titleField: fieldName(name)(entity.titleField) } : {}),
        fields: entity.fields.map((field) => (field.type === 'reference' ? { ...field, entity: entityName(field.entity) } : field)),
      },
    ]),
  );
  const rules = mapRecord(definition.rules, (rule) => {
    const entity = entityName(rule.entity);
    return {
      ...rule,
      entity,
      ...(rule.when ? { when: condition(entity, rule.when) } : {}),
      assert: condition(entity, rule.assert),
      ...(rule.fields ? { fields: rule.fields.map(fieldName(entity)) } : {}),
    };
  });
  const actions = mapRecord(definition.actions, (action) => {
    const entity = entityName(action.entity);
    return {
      ...action,
      entity,
      input: action.input.map(fieldName(entity)),
      set: Object.fromEntries(Object.entries(action.set).map(([field, value]) => [fieldName(entity)(field), value])),
      ...(action.where ? { where: condition(entity, action.where) } : {}),
    };
  });
  const queries = mapRecord(definition.queries, (query) => {
    const entity = entityName(query.entity);
    return {
      ...query,
      entity,
      fields: query.fields.map(fieldName(entity)),
      ...(query.filter ? { filter: condition(entity, query.filter) } : {}),
      sort: query.sort.map((sort) => ({ ...sort, field: fieldName(entity)(sort.field) })),
    };
  });
  const cards = mapRecord(definition.cards, (card) => {
    const entity = entityName(card.entity);
    return {
      ...card,
      entity,
      show: card.show.map(fieldName(entity)),
      title: card.title.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, name: string) => `{{${fieldName(entity)(name)}}}`),
    };
  });
  const roles = mapRecord(definition.roles, (role) => ({
    ...role,
    entities: Object.fromEntries(
      Object.entries(role.entities).map(([oldEntity, permissions]) => {
        const entity = entityName(oldEntity);
        const rename = fieldName(entity);
        const access = <T>(value: T): T => {
          if (typeof value !== 'object' || value === null) return value;
          const a = value as Record<string, unknown>;
          return {
            ...a,
            ...(a['where'] ? { where: condition(entity, a['where'] as Condition) } : {}),
            ...(a['check'] ? { check: condition(entity, a['check'] as Condition) } : {}),
            ...(a['fields']
              ? { fields: 'include' in (a['fields'] as object)
                  ? { include: (a['fields'] as { include: string[] }).include.map(rename) }
                  : { exclude: (a['fields'] as { exclude: string[] }).exclude.map(rename) } }
              : {}),
            ...(a['mask'] ? { mask: (a['mask'] as string[]).map(rename) } : {}),
            ...(a['unmask'] ? { unmask: (a['unmask'] as string[]).map(rename) } : {}),
          } as T;
        };
        return [entity, mapRecord(permissions as Record<string, unknown>, access)];
      }),
    ),
  }));
  for (const change of touched) notes.push(`Updated references for the rename ${change}`);
  return { ...definition, entities, rules, actions, queries, cards, roles } as StoredDefinition;
}

function assignIds(
  data: AppDefinition,
  previous: StoredDefinition | undefined,
  generateId: () => string,
  issues: Issue[],
): StoredDefinition {
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

interface ConditionScope {
  readonly record?: ReadonlyMap<string, FieldInfo>;
  readonly input?: ReadonlyMap<string, 'text' | 'number' | 'boolean'>;
}

/** Check a condition's references and, where a record field meets a literal, their types. */
export function checkCondition(condition: Condition, scope: ConditionScope, path: string, issues: Issue[]): void {
  const fieldOf = (operand: Operand): FieldInfo | undefined =>
    isRef(operand) && operand.ref.startsWith('record.') ? scope.record?.get(operand.ref.slice('record.'.length)) : undefined;

  const checkRef = (ref: string, presenceOnly = false): void => {
    const [root, name, ...rest] = ref.split('.');
    if (root === 'record') {
      if (!scope.record) issues.push({ path, message: `${ref}: there is no record here` });
      else if (!name || rest.length) issues.push({ path, message: `${ref}: refer to a record field as record.<field>` });
      else {
        const info = scope.record.get(name);
        if (!info) issues.push({ path, message: `${ref}: no such field` });
        else if (!presenceOnly && !isConditionKind(info.kind)) {
          issues.push({ path, message: `${ref}: dates and times can't be compared in conditions yet, only tested with "exists"` });
        }
      }
    } else if (root === 'input') {
      if (!name || rest.length || !scope.input?.has(name)) issues.push({ path, message: `${ref}: no such parameter` });
    } else if (root === 'principal' || root === 'context') {
      if (!name) issues.push({ path, message: `${ref}: name a property, for example principal.id` });
    } else {
      issues.push({ path, message: `${ref}: conditions can refer to record, principal, context and input` });
    }
  };

  const literalMatches = (info: FieldInfo, literal: Operand): string | null => {
    if (isRef(literal)) return null;
    if (literal === null) return `${info.name}: test for an empty field with "exists" rather than null`;
    const expected = jsTypeOf(info.kind);
    if (expected === 'array') return `${info.name} is a multiple choice: test it with "in"`;
    if (typeof literal !== expected) return `${info.name} holds ${expected === 'string' ? 'text' : expected}s, not ${typeof literal}s`;
    return null;
  };

  const visit = (c: Condition): void => {
    if ('all' in c) return c.all.forEach(visit);
    if ('any' in c) return c.any.forEach(visit);
    if ('not' in c) return visit(c.not);
    if ('exists' in c) return checkRef(c.exists, true);
    if ('in' in c) {
      const [needle, haystack] = c.in;
      const list = Array.isArray(haystack) ? (haystack as readonly Operand[]) : [haystack as Operand];
      for (const operand of [needle, ...list]) if (isRef(operand)) checkRef(operand.ref);
      const needleField = fieldOf(needle);
      if (needleField && Array.isArray(haystack)) {
        for (const item of haystack as readonly Operand[]) {
          const problem = literalMatches(needleField, item);
          if (problem) issues.push({ path, message: problem });
        }
      }
      const haystackField = Array.isArray(haystack) ? undefined : fieldOf(haystack as Operand);
      if (haystackField && haystackField.kind !== 'text[]') {
        issues.push({ path, message: `${haystackField.name} isn't a multiple choice, so nothing can be "in" it` });
      }
      return;
    }
    const op = (['eq', 'ne', ...COMPARISON_OPERATORS] as const).find((key) => key in c)!;
    const [left, right] = (c as Record<string, readonly [Operand, Operand]>)[op]!;
    for (const operand of [left, right]) if (isRef(operand)) checkRef(operand.ref);
    for (const [a, b] of [[left, right], [right, left]] as const) {
      const info = fieldOf(a);
      if (!info) continue;
      if (op === 'eq' || op === 'ne') {
        const problem = literalMatches(info, b);
        if (problem) issues.push({ path, message: problem });
      } else if (info.kind !== 'number' || (!isRef(b) && typeof b !== 'number')) {
        issues.push({ path, message: `${op} compares numbers, and ${info.name} isn't one` });
      }
    }
  };
  visit(condition);
}

function checkReferences(definition: StoredDefinition, issues: Issue[]): void {
  const fieldsOf = new Map(Object.entries(definition.entities).map(([name, entity]) => [name, entityFields(entity)]));
  const entityAt = (name: string, path: string) => {
    const fields = fieldsOf.get(name);
    if (!fields) issues.push({ path, message: `No entity named ${name}` });
    return fields;
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
      }
      if (field.type === 'number' && field.min !== undefined && field.max !== undefined && field.min > field.max) {
        issues.push({ path, message: 'min is greater than max' });
      }
      if (field.type === 'choice' && new Set(field.options.map((o) => o.value)).size !== field.options.length) {
        issues.push({ path: `${path}.options`, message: 'Option values must be unique' });
      }
      if ('default' in field && field.default !== undefined) {
        const result = canonicalValue(fieldsOf.get(name)!.get(field.name)!, field.default);
        if (!result.ok) issues.push({ path: `${path}.default`, message: result.issue.message });
      }
    });
    if (entity.titleField && !entity.fields.some((f) => f.name === entity.titleField)) {
      issues.push({ path: `${base}.titleField`, message: `No field named ${entity.titleField}` });
    }
  }

  for (const [name, rule] of Object.entries(definition.rules)) {
    const fields = entityAt(rule.entity, `rules.${name}.entity`);
    if (!fields) continue;
    if (rule.when) checkCondition(rule.when, { record: fields }, `rules.${name}.when`, issues);
    checkCondition(rule.assert, { record: fields }, `rules.${name}.assert`, issues);
    for (const field of rule.fields ?? []) if (!fields.has(field)) issues.push({ path: `rules.${name}.fields`, message: `No field named ${field}` });
  }

  for (const [name, action] of Object.entries(definition.actions)) {
    const path = `actions.${name}`;
    const fields = entityAt(action.entity, `${path}.entity`);
    if (!fields) continue;
    const entity = definition.entities[action.entity]!;
    const input = new Set<string>();
    for (const field of action.input) {
      const info = fields.get(field);
      if (!info) issues.push({ path: `${path}.input`, message: `No field named ${field}` });
      else if (!isWritable(info)) issues.push({ path: `${path}.input`, message: `${field} is set by the platform` });
      if (input.has(field)) issues.push({ path: `${path}.input`, message: `${field} is listed twice` });
      input.add(field);
    }
    for (const [field, value] of Object.entries(action.set)) {
      const info = fields.get(field);
      if (!info || !isWritable(info)) {
        issues.push({ path: `${path}.set.${field}`, message: info ? `${field} is set by the platform` : `No field named ${field}` });
        continue;
      }
      if (input.has(field)) issues.push({ path: `${path}.set.${field}`, message: `${field} is both an input and set by the action` });
      const result = canonicalValue(info, value);
      if (!result.ok) issues.push({ path: `${path}.set.${field}`, message: result.issue.message });
    }
    if (action.operation === 'create') {
      if (action.where) issues.push({ path: `${path}.where`, message: 'Only updates apply to existing records' });
      for (const field of entity.fields) {
        const provided = input.has(field.name) || field.name in action.set || ('default' in field && field.default !== undefined);
        if (field.required && !provided) {
          issues.push({ path: `${path}.input`, message: `${field.name} is required, so the action must take it as input, set it, or the field needs a default` });
        }
      }
    } else if (action.where) {
      checkCondition(action.where, { record: fields }, `${path}.where`, issues);
    }
    if (action.card) {
      const card = definition.cards[action.card];
      if (!card) issues.push({ path: `${path}.card`, message: `No card named ${action.card}` });
      else if (card.entity !== action.entity) issues.push({ path: `${path}.card`, message: `${action.card} shows ${card.entity}, not ${action.entity}` });
    }
  }

  for (const [name, query] of Object.entries(definition.queries)) {
    const path = `queries.${name}`;
    const fields = entityAt(query.entity, `${path}.entity`);
    if (!fields) continue;
    for (const field of query.fields) if (!fields.has(field)) issues.push({ path: `${path}.fields`, message: `No field named ${field}` });
    const input = new Map(Object.entries(query.parameters).map(([param, spec]) => [param, spec.type] as const));
    if (query.filter) checkCondition(query.filter, { record: fields, input }, `${path}.filter`, issues);
    query.sort.forEach((sort, index) => {
      const info = fields.get(sort.field);
      if (!info) issues.push({ path: `${path}.sort[${index}]`, message: `No field named ${sort.field}` });
      else if (!isSortableKind(info.kind)) issues.push({ path: `${path}.sort[${index}]`, message: `${sort.field} can't be sorted` });
    });
  }

  for (const [name, card] of Object.entries(definition.cards)) {
    const fields = entityAt(card.entity, `cards.${name}.entity`);
    if (!fields) continue;
    for (const field of card.show) if (!fields.has(field)) issues.push({ path: `cards.${name}.show`, message: `No field named ${field}` });
    for (const [, field] of card.title.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)) {
      if (!fields.has(field!)) issues.push({ path: `cards.${name}.title`, message: `No field named ${field}` });
    }
  }

  for (const [roleName, role] of Object.entries(definition.roles)) {
    const base = `roles.${roleName}`;
    for (const [entityName, permissions] of Object.entries(role.entities)) {
      const path = `${base}.entities.${entityName}`;
      const fields = entityAt(entityName, path);
      if (!fields) continue;
      const entity = definition.entities[entityName]!;
      for (const [verb, access] of Object.entries(permissions)) {
        if (typeof access !== 'object' || access === null) continue;
        if ('where' in access && access.where) checkCondition(access.where, { record: fields }, `${path}.${verb}.where`, issues);
        if ('check' in access && access.check) checkCondition(access.check, { record: fields }, `${path}.${verb}.check`, issues);
        if ('fields' in access && access.fields) {
          const names = 'include' in access.fields ? access.fields.include : access.fields.exclude;
          for (const field of names) {
            const info = fields.get(field);
            if (!info) issues.push({ path: `${path}.${verb}.fields`, message: `No field named ${field}` });
            else if (verb !== 'read' && !isWritable(info)) issues.push({ path: `${path}.${verb}.fields`, message: `${field} is set by the platform` });
          }
        }
        for (const key of ['mask', 'unmask'] as const) {
          for (const field of (key in access ? (access as Record<string, string[] | undefined>)[key] : undefined) ?? []) {
            const declared = entity.fields.find((f) => f.name === field);
            if (!declared) issues.push({ path: `${path}.${verb}.${key}`, message: `No field named ${field}` });
            else if (key === 'unmask' && declared.classification !== 'pii') {
              issues.push({ path: `${path}.${verb}.unmask`, message: `${field} isn't classified as PII, so it is never masked` });
            }
          }
        }
      }
    }
    for (const action of role.actions) if (!definition.actions[action]) issues.push({ path: `${base}.actions`, message: `No action named ${action}` });
    for (const query of role.queries) if (!definition.queries[query]) issues.push({ path: `${base}.queries`, message: `No query named ${query}` });
  }
}

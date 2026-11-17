import { randomBytes } from 'node:crypto';
import { COMPARISON_OPERATORS, isRef, type Condition, type Operand } from '@platform/authz';
import {
  entityFields,
  isConditionKind,
  isSortableKind,
  isWritable,
  jsTypeOf,
  lineOwners,
  rollupOf,
  type FieldInfo,
  type StoredDefinition,
  type StoredEntity,
  type StoredField,
} from './fields.js';
import { mapExpressionRefs, operatorOf, roundTo, type Expression } from './expressions.js';
import { AppDefinition, LINE_PATH_PATTERN, SYSTEM_FIELDS, type Action, type Entity, type SimpleStep, type Step } from './schema.js';
import { alwaysGiven } from './steps.js';
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
  /** The line entity of an entity's lines field, by their new names. */
  const lineEntityOf = (entity: string, lines: string) => {
    const field = definition.entities[entity]?.fields.find((f) => f.name === lines);
    return field?.type === 'lines' ? entityName(field.entity) : undefined;
  };
  /** A field name, or a path into lines such as `lines.amount`, after renames. */
  const pathName = (entity: string) => (name: string) => {
    const match = LINE_PATH_PATTERN.exec(name);
    if (!match) return fieldName(entity)(name);
    const lines = fieldName(entity)(match[1]!);
    const lineEntity = lineEntityOf(entity, lines);
    return `${lines}.${lineEntity ? fieldName(lineEntity)(match[2]!) : match[2]}`;
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
        fields: entity.fields.map((field) => {
          if (field.type === 'reference' || field.type === 'lines') return { ...field, entity: entityName(field.entity) };
          if (field.type === 'number' && field.rollup) {
            const [op, path] = Object.entries(field.rollup)[0] as [string, string];
            return { ...field, rollup: { [op]: op === 'count' ? fieldName(name)(path) : pathName(name)(path) } as typeof field.rollup };
          }
          return field;
        }),
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
  const simpleStep = (entity: string, step: SimpleStep): SimpleStep => {
    const value = (expression: Expression) => mapExpressionRefs(expression, refs(entity));
    switch (step.type) {
      case 'set':
        return { ...step, field: fieldName(entity)(step.field), value: value(step.value) };
      case 'add_line': {
        const lines = fieldName(entity)(step.field);
        const lineEntity = lineEntityOf(entity, lines);
        return { ...step, field: lines, values: Object.fromEntries(Object.entries(step.values).map(([name, v]) => [lineEntity ? fieldName(lineEntity)(name) : name, value(v)])) };
      }
      case 'check':
        return { ...step, assert: condition(entity, step.assert), ...(step.fields ? { fields: step.fields.map(fieldName(entity)) } : {}) };
      case 'skill':
        return { ...step, input: Object.fromEntries(Object.entries(step.input).map(([name, v]) => [name, value(v)])) };
    }
  };
  const step = (entity: string, s: Step): Step =>
    s.type === 'if'
      ? { ...s, when: condition(entity, s.when), then: s.then.map((inner) => simpleStep(entity, inner)), else: s.else.map((inner) => simpleStep(entity, inner)) }
      : simpleStep(entity, s);
  const actions = mapRecord(definition.actions, (action) => {
    const entity = entityName(action.entity);
    return {
      ...action,
      entity,
      input: action.input.map(fieldName(entity)),
      set: Object.fromEntries(Object.entries(action.set).map(([field, value]) => [fieldName(entity)(field), value])),
      ...(action.where ? { where: condition(entity, action.where) } : {}),
      ...(action.steps ? { steps: action.steps.map((s) => step(entity, s)) } : {}),
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
      ...(card.table
        ? (() => {
            const of = fieldName(entity)(card.table.of);
            const lineEntity = lineEntityOf(entity, of);
            return { table: { of, columns: card.table.columns.map((column) => (lineEntity ? fieldName(lineEntity)(column) : column)) } };
          })()
        : {}),
      title: card.title.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, name: string) => `{{${fieldName(entity)(name)}}}`),
    };
  });
  const forms = mapRecord(definition.forms, (form) => {
    const entity = entityName(form.entity);
    return {
      ...form,
      entity,
      sections: form.sections.map((section) => ({ ...section, fields: section.fields.map((item) => ({ ...item, field: fieldName(entity)(item.field) })) })),
    };
  });
  const roles = mapRecord(definition.roles, (role) => ({
    ...role,
    entities: Object.fromEntries(
      Object.entries(role.entities).map(([oldEntity, permissions]) => {
        const entity = entityName(oldEntity);
        const rename = pathName(entity);
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
  const pages = mapRecord(definition.pages ?? {}, (page) => ({
    ...page,
    blocks: page.blocks.map((block) => {
      if (block.type === 'stat' || block.type === 'chart') {
        const entity = entityName(block.entity);
        const path = pathName(entity);
        return {
          ...block,
          entity,
          measure: { ...block.measure, ...(block.measure.field ? { field: path(block.measure.field) } : {}) },
          ...(block.type === 'chart' ? { group: { ...block.group, field: path(block.group.field) } } : {}),
          ...(block.range ? { range: { ...block.range, field: path(block.range.field) } } : {}),
          ...(block.filter ? { filter: condition(entity, block.filter) } : {}),
        };
      }
      if (block.type !== 'list') return block;
      const entity = entityName(block.entity);
      return {
        ...block,
        entity,
        columns: block.columns.map(fieldName(entity)),
        ...(block.filter ? { filter: condition(entity, block.filter) } : {}),
        sort: block.sort.map((sort) => ({ ...sort, field: fieldName(entity)(sort.field) })),
      };
    }),
  }));
  const navigation = definition.navigation
    ? { ...definition.navigation, items: definition.navigation.items.map((item) => ('entity' in item ? { ...item, entity: entityName(item.entity) } : item)) }
    : undefined;
  for (const change of touched) notes.push(`Updated references for the rename ${change}`);
  return { ...definition, entities, rules, actions, queries, cards, forms, roles, pages, ...(navigation ? { navigation } : {}) } as StoredDefinition;
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
  /** The record's lines fields, which conditions can't test directly. */
  readonly lines?: ReadonlySet<string>;
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
        if (!info && scope.lines?.has(name)) {
          issues.push({ path, message: `${ref}: conditions can't test lines one by one. Add a rollup, such as a total, and test that` });
        } else if (!info) issues.push({ path, message: `${ref}: no such field` });
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

type ExpressionKind = FieldInfo['kind'] | 'null' | 'any';

const KIND_WORDS: Readonly<Record<ExpressionKind, string>> = {
  text: 'text',
  uuid: 'an ID of a person or a record',
  number: 'a number',
  boolean: 'yes or no',
  date: 'a date',
  datetime: 'a time',
  'text[]': 'a list of options',
  null: 'nothing',
  any: 'any value',
};

/**
 * Check an action's steps: what each sets or adds exists and can be set by a step; each value
 * fits its field; conditions and references are sound. A step's values refer to the record and to
 * the person, never to lines one by one.
 */
function checkSteps(
  definition: StoredDefinition,
  action: Action,
  path: string,
  fields: ReadonlyMap<string, FieldInfo>,
  lines: ReadonlySet<string>,
  issues: Issue[],
): void {
  const entity = definition.entities[action.entity]!;
  const kindOf = (expression: Expression, at: string): ExpressionKind => {
    if (expression === null) return 'null';
    if (typeof expression === 'string') return 'text';
    if (typeof expression === 'number') return 'number';
    if (typeof expression === 'boolean') return 'boolean';
    if (Array.isArray(expression)) return 'text[]';
    if (typeof expression !== 'object') return 'any';
    if ('ref' in expression) {
      const [root, name] = expression.ref.split('.') as [string, string];
      if (root === 'principal') return name === 'id' ? 'uuid' : 'any';
      if (root !== 'record') {
        issues.push({ path: at, message: `${expression.ref}: a step can refer to record and principal` });
        return 'any';
      }
      const info = fields.get(name);
      if (info) return info.kind;
      issues.push({
        path: at,
        message: lines.has(name) ? `${expression.ref}: a step can't use lines one by one. Add a rollup, such as a total, and use that` : `${expression.ref}: no such field`,
      });
      return 'any';
    }
    if ('today' in expression) return 'date';
    if ('now' in expression) return 'datetime';
    const op = operatorOf(expression);
    if (!op) return 'any';
    const operands = op === 'round' ? [(expression as { round: readonly [Expression, number] }).round[0]] : (expression as Record<string, readonly Expression[]>)[op]!;
    const kinds = operands.map((operand) => kindOf(operand, at));
    if (op === 'concat') return 'text';
    for (const kind of kinds) {
      if (kind !== 'number' && kind !== 'null' && kind !== 'any') issues.push({ path: at, message: `${op} works on numbers, not on ${KIND_WORDS[kind]}` });
    }
    return 'number';
  };
  /** Check that a value fits the field it goes into. Literals are checked as the field would check them. */
  const fits = (info: FieldInfo, expression: Expression, at: string, label: string): void => {
    const kind = kindOf(expression, at);
    const literal = expression === null || typeof expression !== 'object' || Array.isArray(expression);
    if (literal) {
      if (expression === null) {
        if (info.field?.required) issues.push({ path: at, message: `${label} is required, so a step can't empty it` });
        return;
      }
      const value = info.field?.type === 'number' && typeof expression === 'number' ? roundTo(expression, info.field.decimals) : expression;
      const result = canonicalValue(info, value);
      if (!result.ok) issues.push({ path: at, message: `${label}: ${result.issue.message}` });
      return;
    }
    const fitsKind = kind === 'any' || kind === 'null' || kind === info.kind || (info.kind === 'date' && kind === 'datetime');
    if (!fitsKind) issues.push({ path: at, message: `${label} holds ${KIND_WORDS[info.kind]}, and this gives ${KIND_WORDS[kind]}` });
  };
  const condition = (c: Condition, at: string) => checkCondition(c, { record: fields, lines }, at, issues);

  const visit = (list: readonly (Step | SimpleStep)[], base: string): void =>
    list.forEach((step, index) => {
      const at = `${base}[${index}]`;
      switch (step.type) {
        case 'set': {
          const info = fields.get(step.field);
          if (lines.has(step.field)) issues.push({ path: `${at}.field`, message: `${step.field} holds lines: add one with an "add a line" step` });
          else if (!info) issues.push({ path: `${at}.field`, message: `No field named ${step.field}` });
          else if (!isWritable(info)) issues.push({ path: `${at}.field`, message: info.system ? `${step.field} is set by the platform` : `${step.field} is worked out from lines` });
          else if (info.field?.type === 'file') issues.push({ path: `${at}.field`, message: 'A step can\'t set a file: take it as input' });
          else fits(info, step.value, `${at}.value`, info.field?.label ?? step.field);
          return;
        }
        case 'add_line': {
          const linesField = entity.fields.find((f) => f.name === step.field);
          const lineEntity = linesField?.type === 'lines' ? definition.entities[linesField.entity] : undefined;
          if (!lineEntity) {
            issues.push({ path: `${at}.field`, message: `${step.field} isn't a lines field of ${action.entity}` });
            return;
          }
          const lineFields = entityFields(lineEntity, { line: true });
          for (const [name, expression] of Object.entries(step.values)) {
            const info = lineFields.get(name);
            if (!info || info.system) issues.push({ path: `${at}.values.${name}`, message: `${lineEntity.label} has no field ${name}` });
            else if (info.field?.type === 'file') issues.push({ path: `${at}.values.${name}`, message: 'A step can\'t set a file: take it as input' });
            else fits(info, expression, `${at}.values.${name}`, info.field?.label ?? name);
          }
          for (const declared of lineEntity.fields) {
            const defaulted = 'default' in declared && declared.default !== undefined;
            if (declared.required && !(declared.name in step.values) && !defaulted) issues.push({ path: `${at}.values`, message: `Each line needs ${declared.label}: give it a value` });
          }
          return;
        }
        case 'check':
          condition(step.assert, `${at}.assert`);
          for (const field of step.fields ?? []) if (!fields.has(field)) issues.push({ path: `${at}.fields`, message: `No field named ${field}` });
          return;
        case 'skill':
          for (const [name, expression] of Object.entries(step.input)) kindOf(expression, `${at}.input.${name}`);
          return;
        case 'if':
          condition(step.when, `${at}.when`);
          if (!step.then.length && !step.else.length) issues.push({ path: at, message: 'A branch needs at least one step' });
          visit(step.then, `${at}.then`);
          visit(step.else, `${at}.else`);
          return;
      }
    });
  visit(action.steps ?? [], `${path}.steps`);
}

function checkReferences(definition: StoredDefinition, issues: Issue[]): void {
  const owners = lineOwners(definition);
  const fieldsOf = new Map(Object.entries(definition.entities).map(([name, entity]) => [name, entityFields(entity, { line: owners.has(name) })]));
  const linesOf = new Map(Object.entries(definition.entities).map(([name, entity]) => [name, new Set(entity.fields.filter((f) => f.type === 'lines').map((f) => f.name))]));
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
    if (!match) return linesOf.get(entity)?.has(name) ? { lines: true } : fieldsOf.get(entity)?.has(name) ? { info: fieldsOf.get(entity)!.get(name)! } : undefined;
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
        else if (field.entity === name) issues.push({ path: `${path}.entity`, message: 'An entity can\'t be lines of itself' });
        else if (owner && (owner.parent !== name || owner.field !== field.name)) {
          issues.push({ path: `${path}.entity`, message: `${field.entity} is already the lines of ${owner.parent}.${owner.field}` });
        } else if (target.fields.some((f) => f.type === 'lines')) {
          issues.push({ path: `${path}.entity`, message: `${field.entity} has lines of its own; lines go one level deep` });
        }
        if (owners.has(name)) issues.push({ path, message: `${name} is itself lines of another entity; lines go one level deep` });
        if (field.classification === 'pii') issues.push({ path: `${path}.classification`, message: `Classify the fields of ${field.entity} instead` });
      }
      if (owners.has(name) && 'unique' in field && field.unique) {
        issues.push({ path: `${path}.unique`, message: 'Fields of lines can\'t be unique yet' });
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
        if (field.required) issues.push({ path: `${path}.required`, message: 'A field worked out from lines always has its value: it can\'t be required' });
        if ('default' in field && field.default !== undefined) issues.push({ path: `${path}.default`, message: 'A field worked out from lines can\'t have a default' });
        if ('unique' in field && field.unique) issues.push({ path: `${path}.unique`, message: 'A field worked out from lines can\'t be unique' });
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
    if (entity.titleField && !fieldsOf.get(name)!.has(entity.titleField)) {
      issues.push({ path: `${base}.titleField`, message: `No field named ${entity.titleField}` });
    }
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
      else if (info && !isWritable(info)) issues.push({ path: `${path}.input`, message: info.system ? `${field} is set by the platform` : `${field} is worked out from lines` });
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
      const stepsGive = alwaysGiven(action.steps ?? []);
      for (const field of entity.fields) {
        const provided = input.has(field.name) || field.name in action.set || stepsGive.has(field.name) || ('default' in field && field.default !== undefined);
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
    const input = new Map(Object.entries(query.parameters).map(([param, spec]) => [param, spec.type] as const));
    if (query.filter) checkCondition(query.filter, { record: fields, lines, input }, `${path}.filter`, issues);
    query.sort.forEach((sort, index) => {
      const info = fields.get(sort.field);
      if (!info) issues.push({ path: `${path}.sort[${index}]`, message: lines.has(sort.field) ? `${sort.field} holds lines, which can't be sorted by` : `No field named ${sort.field}` });
      else if (!isSortableKind(info.kind)) issues.push({ path: `${path}.sort[${index}]`, message: `${sort.field} can't be sorted` });
    });
  }

  for (const [name, card] of Object.entries(definition.cards)) {
    const fields = recordEntityAt(card.entity, `cards.${name}.entity`);
    if (!fields) continue;
    const lines = linesOf.get(card.entity)!;
    for (const field of card.show) if (!fields.has(field) && !lines.has(field)) issues.push({ path: `cards.${name}.show`, message: `No field named ${field}` });
    for (const [, field] of card.title.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)) {
      if (!fields.has(field!)) issues.push({ path: `cards.${name}.title`, message: lines.has(field!) ? `${field} holds lines: put a rollup, such as a total, in the title` : `No field named ${field}` });
    }
    if (card.table) {
      const lineEntity = lineEntityOf(card.entity, card.table.of);
      if (!lineEntity) issues.push({ path: `cards.${name}.table.of`, message: `${card.entity} has no lines field named ${card.table.of}` });
      else {
        for (const column of card.table.columns) {
          if (!lineEntity.fields.some((f) => f.name === column)) issues.push({ path: `cards.${name}.table.columns`, message: `${card.table.of} has no field named ${column}` });
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
    else if (action && action.entity !== form.entity) issues.push({ path: `${path}.action`, message: `${form.action} works on ${action.entity}, not ${form.entity}` });
    const placed = new Set<string>();
    form.sections.forEach((section, s) => {
      section.fields.forEach((item, f) => {
        const at = `${path}.sections[${s}].fields[${f}]`;
        const info = fields.get(item.field);
        if (!info && !lines.has(item.field)) issues.push({ path: at, message: `No field named ${item.field}` });
        else if (info && !item.readOnly && !isWritable(info)) issues.push({ path: at, message: `${item.field} is ${info.system ? 'set by the platform' : 'worked out from lines'}: show it read-only` });
        else if (action && !item.readOnly && !action.input.includes(item.field)) {
          issues.push({ path: at, message: `${item.field} isn't an input of ${form.action}: show it read-only, or add it to the action's inputs` });
        }
        if (placed.has(item.field)) issues.push({ path: at, message: `${item.field} is on the form twice` });
        placed.add(item.field);
      });
    });
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
              issues.push({ path: `${path}.${verb}.fields`, message: `${field} is ${found.info.system ? 'set by the platform' : 'worked out from lines'}` });
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
    info.kind === 'text' || info.kind === 'boolean' || (info.kind === 'uuid' && info.name !== 'id' && info.field?.type !== 'reference' && info.field?.type !== 'file');
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
        issues.push({ path: `${path}.group.field`, message: lines.has(field) ? `${field} holds lines: group by a field of them, such as ${field}.category` : `No field named ${field}` });
      } else {
        if (found.lines) over.add(found.lines);
        if (isDated(found.info) && !period) issues.push({ path: `${path}.group.period`, message: `${field} is a date: group it by periods, such as month` });
        else if (!isDated(found.info) && period) issues.push({ path: `${path}.group.period`, message: `Only dates group by periods: ${field} isn't one` });
        else if (!isDated(found.info) && !groupable(found.info)) {
          issues.push({ path: `${path}.group.field`, message: `${field} can't group records: group by a choice, text, a yes or no, a person or a date` });
        }
        if (block.show === 'line' && !period) issues.push({ path: `${path}.show`, message: 'A line shows change over time: group by periods of a date, or show bars' });
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

  for (const [name, page] of Object.entries(definition.pages ?? {})) {
    for (const role of page.roles ?? []) if (!definition.roles[role]) issues.push({ path: `pages.${name}.roles`, message: `No role named ${role}` });
    page.blocks.forEach((block, index) => {
      const path = `pages.${name}.blocks[${index}]`;
      if (block.type === 'buttons') {
        block.buttons.forEach((button, b) => {
          if ('form' in button && !definition.forms[button.form]) issues.push({ path: `${path}.buttons[${b}]`, message: `No form named ${button.form}` });
          if ('page' in button && !definition.pages[button.page]) issues.push({ path: `${path}.buttons[${b}]`, message: `No page named ${button.page}` });
        });
      }
      if (block.type === 'stat' || block.type === 'chart') {
        checkSummary(block, path);
        return;
      }
      if (block.type !== 'list') return;
      const fields = recordEntityAt(block.entity, `${path}.entity`);
      if (!fields) return;
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
        if (!info) issues.push({ path: `${path}.sort[${s}]`, message: lines.has(sort.field) ? `${sort.field} holds lines, which can't be sorted by` : `No field named ${sort.field}` });
        else if (!isSortableKind(info.kind)) issues.push({ path: `${path}.sort[${s}]`, message: `${sort.field} can't be sorted` });
      });
      for (const actionName of block.actions) {
        const action = definition.actions[actionName];
        if (!action) issues.push({ path: `${path}.actions`, message: `No action named ${actionName}` });
        else if (action.entity !== block.entity || action.operation !== 'update') {
          issues.push({ path: `${path}.actions`, message: `${actionName} doesn't change a ${block.entity} record, so it can't run on a row` });
        } else if (action.input.length) {
          issues.push({ path: `${path}.actions`, message: `${actionName} takes input, so it can't run in one click: open it from a form instead` });
        }
      }
    });
  }

  if (definition.navigation) {
    const { home, items } = definition.navigation;
    if (home && !definition.pages[home]) issues.push({ path: 'navigation.home', message: `No page named ${home}` });
    items.forEach((item, index) => {
      const path = `navigation.items[${index}]`;
      if ('page' in item && !definition.pages[item.page]) issues.push({ path, message: `No page named ${item.page}` });
      if ('form' in item && !definition.forms[item.form]) issues.push({ path, message: `No form named ${item.form}` });
      if ('entity' in item) recordEntityAt(item.entity, path);
    });
  }
}

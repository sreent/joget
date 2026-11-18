import { COMPARISON_OPERATORS, type Condition, conditionRefs, isRef, isRelativeTime, type Operand, timeOf } from '@platform/authz';
import { calculationKind, type Expression, operandsOf, operatorOf, roundTo } from './expressions.js';
import { entityFields, type FieldInfo, isListKind, isOrderedKind, isWritable, jsTypeOf, type StoredDefinition, workedOutBy } from './fields.js';
import { FORMULA_OPERATORS } from './formulas.js';
import { processWork } from './processes.js';
import type { Action, Field, Process, SimpleStep, Step } from './schema.js';
import { canonicalValue, isCanonicalUuid } from './values.js';

/* The checks that more than one part of a definition shares: conditions, formulas, a flow's steps and its calls. */

export interface Issue {
  /** Where in the definition, for example `entities.expense_claim.fields[2].name`. */
  readonly path: string;
  readonly message: string;
}

interface ConditionScope {
  readonly record?: ReadonlyMap<string, FieldInfo>;
  /** The record's lines fields, which conditions can't test directly. */
  readonly lines?: ReadonlySet<string>;
  readonly input?: ReadonlyMap<string, 'text' | 'number' | 'boolean'>;
  /**
   * In a process: its user tasks and their outcomes, which conditions read as `tasks.<task>.outcome`.
   * A timer can move a process when nobody is there, so its conditions can't use `principal`.
   */
  readonly tasks?: ReadonlyMap<string, readonly string[]>;
}

/** Check a condition's references and, where a record field meets a literal, their types. */
export function checkCondition(condition: Condition, scope: ConditionScope, path: string, issues: Issue[]): void {
  const fieldOf = (operand: Operand): FieldInfo | undefined =>
    isRef(operand) && operand.ref.startsWith('record.') ? scope.record?.get(operand.ref.slice('record.'.length)) : undefined;

  const checkRef = (ref: string): void => {
    const [root, name, ...rest] = ref.split('.');
    if (root === 'record') {
      if (!scope.record) issues.push({ path, message: `${ref}: there is no record here` });
      else if (!name || rest.length) issues.push({ path, message: `${ref}: refer to a record field as record.<field>` });
      else {
        const info = scope.record.get(name);
        if (!info && scope.lines?.has(name)) {
          issues.push({ path, message: `${ref}: conditions can't test lines one by one. Add a rollup, such as a total, and test that` });
        } else if (!info) issues.push({ path, message: `${ref}: no such field` });
      }
    } else if (root === 'tasks' && scope.tasks) {
      if (!name || rest.length !== 1 || rest[0] !== 'outcome') issues.push({ path, message: `${ref}: refer to a task's outcome as tasks.<task>.outcome` });
      else if (!scope.tasks.has(name)) issues.push({ path, message: `${ref}: the process has no user task ${name}` });
    } else if (scope.tasks) {
      issues.push({ path, message: `${ref}: a process's conditions can refer to the record and to its tasks' outcomes` });
    } else if (root === 'input') {
      if (!name || rest.length || !scope.input?.has(name)) issues.push({ path, message: `${ref}: no such parameter` });
    } else if (root === 'principal' || root === 'context') {
      if (!name) issues.push({ path, message: `${ref}: name a property, for example principal.id` });
    } else {
      issues.push({ path, message: `${ref}: conditions can refer to record, principal, context and input` });
    }
  };
  /** The outcomes a task reference can take, for `tasks.<task>.outcome`. */
  const outcomesOf = (operand: Operand): readonly string[] | undefined => {
    if (!isRef(operand) || !scope.tasks) return undefined;
    const [root, task, prop] = operand.ref.split('.');
    return root === 'tasks' && prop === 'outcome' && task ? scope.tasks.get(task) : undefined;
  };

  const literalMatches = (info: FieldInfo, literal: Operand): string | null => {
    if (isRef(literal)) return null;
    if (isRelativeTime(literal))
      return info.kind === 'date' || info.kind === 'datetime' ? null : `${info.name} isn't a date or a time, so it doesn't compare with today or now`;
    if (literal === null) return `${info.name}: test for an empty field with "exists" rather than null`;
    const expected = jsTypeOf(info.kind);
    if (expected === 'array')
      return info.kind === 'uuid[]' ? `${info.name} holds several records: test it with "in"` : `${info.name} is a multiple choice: test it with "in"`;
    if (typeof literal !== expected) return `${info.name} holds ${expected === 'string' ? 'text' : expected}s, not ${typeof literal}s`;
    return null;
  };

  const visit = (c: Condition): void => {
    if ('all' in c || 'any' in c || 'not' in c) {
      for (const each of 'all' in c ? c.all : 'any' in c ? c.any : [c.not]) visit(each);
      return;
    }
    if ('exists' in c) {
      checkRef(c.exists);
      return;
    }
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
      if (haystackField && !isListKind(haystackField.kind)) {
        issues.push({ path, message: `${haystackField.name} isn't a multiple choice or a list of records, so nothing can be "in" it` });
      }
      // A list of records holds IDs.
      if (haystackField?.kind === 'uuid[]' && !isRef(needle) && !isCanonicalUuid(needle)) {
        issues.push({ path, message: `${haystackField.name} holds records: look for one by its ID` });
      }
      return;
    }
    const op = (['eq', 'ne', ...COMPARISON_OPERATORS] as const).find((key) => key in c)!;
    const [left, right] = (c as Record<string, readonly [Operand, Operand]>)[op]!;
    for (const operand of [left, right]) if (isRef(operand)) checkRef(operand.ref);
    for (const [a, b] of [
      [left, right],
      [right, left],
    ] as const) {
      const outcomes = outcomesOf(a);
      if (outcomes && !isRef(b) && (op === 'eq' || op === 'ne') && (typeof b !== 'string' || !outcomes.includes(b))) {
        issues.push({ path, message: `${(a as { ref: string }).ref} is ${outcomes.join(' or ')}, never ${JSON.stringify(b)}` });
      }
      const info = fieldOf(a);
      if (!info) continue;
      if (op === 'eq' || op === 'ne') {
        const problem = literalMatches(info, b);
        if (problem) issues.push({ path, message: problem });
      } else if (!isOrderedKind(info.kind)) {
        issues.push({ path, message: `${op} compares numbers, dates and times, and ${info.name} is none of them` });
      } else {
        // A number compares with a number; a date or a time with a date, a time, today or now.
        const other = fieldOf(b);
        const time = info.kind !== 'number';
        const fits = isRef(b)
          ? !other || (time ? other.kind === 'date' || other.kind === 'datetime' : other.kind === 'number')
          : time
            ? isRelativeTime(b) || timeOf(b) !== undefined
            : typeof b === 'number';
        if (!fits)
          issues.push({
            path,
            message: `${info.name} holds ${time ? 'dates or times' : 'numbers'}, so compare it with ${time ? 'a date, a time, today or now' : 'a number'}`,
          });
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
  'uuid[]': 'a list of records',
  null: 'nothing',
  any: 'any value',
};

/**
 * Check a field's formula. It reads only the record's own fields, never lines one by one, the person
 * or the clock, so that the value it stores stays true; it uses only the operations a migration can
 * work out again in SQL; and what it gives fits its field.
 */
/** True if a condition compares with a date or a time relative to the clock, such as today. */
function comparesWithClock(condition: Condition): boolean {
  if ('all' in condition) return condition.all.some(comparesWithClock);
  if ('any' in condition) return condition.any.some(comparesWithClock);
  if ('not' in condition) return comparesWithClock(condition.not);
  if ('exists' in condition) return false;
  const operands: ReadonlyArray<Operand | readonly Operand[]> = Object.values(condition)[0] ?? [];
  return operands.flat().some((operand) => isRelativeTime(operand));
}

export function checkFormula(
  field: Field,
  formula: Expression,
  fields: ReadonlyMap<string, FieldInfo>,
  lines: ReadonlySet<string>,
  path: string,
  issues: Issue[],
): void {
  const at = `${path}.formula`;
  const issue = (message: string) => issues.push({ path: at, message });
  const kindOf = (expression: Expression): ExpressionKind => {
    if (expression === null) return 'null';
    if (typeof expression === 'string') return 'text';
    if (typeof expression === 'number') return 'number';
    if (typeof expression === 'boolean') return 'boolean';
    if (Array.isArray(expression)) {
      issue('A formula gives one value, not a list');
      return 'any';
    }
    if ('ref' in expression) {
      const [root, name, ...rest] = expression.ref.split('.') as [string, string | undefined, ...string[]];
      if (root === 'principal') {
        issue(`${expression.ref}: a formula reads the record's own fields, not the person who writes it`);
        return 'any';
      }
      if (root !== 'record' || !name || rest.length) {
        issue(`${expression.ref}: a formula reads the record's own fields, as record.<field>`);
        return 'any';
      }
      if (lines.has(name)) {
        issue(`${expression.ref}: a formula can't read lines one by one. Add a rollup, such as a total, and read that`);
        return 'any';
      }
      const info = fields.get(name);
      if (!info) {
        issue(`${expression.ref}: no such field`);
        return 'any';
      }
      // The platform fills these in as it saves the record, after its formulas are worked out.
      if (info.system) {
        issue(`${expression.ref}: a formula reads the fields of the app, not those the platform keeps, such as the owner or when the record was made`);
        return 'any';
      }
      return info.kind;
    }
    if ('today' in expression || 'now' in expression) {
      issue("A formula can't read today or now: once stored, its value would go stale");
      return 'any';
    }
    const op = operatorOf(expression);
    if (!op) return 'any';
    if (!FORMULA_OPERATORS.includes(op)) {
      issue(`A formula can't use ${op} yet`);
      return 'any';
    }
    if (op === 'if') {
      const when = (expression as { if: readonly [Condition, Expression, Expression] }).if[0];
      checkCondition(when, { record: fields, lines }, at, issues);
      if (conditionRefs(when).some((ref) => ref === 'principal' || ref.startsWith('principal.')))
        issue("A formula's choice reads the record, not the person who writes it");
      if (conditionRefs(when).some((ref) => fields.get(ref.slice('record.'.length))?.system))
        issue("A formula's choice reads the fields of the app, not those the platform keeps");
      if (comparesWithClock(when)) issue("A formula's choice can't compare with today or now: once stored, its value would go stale");
    }
    const worked = calculationKind(op, operandsOf(expression).map(kindOf));
    for (const message of worked.problems) issue(message);
    return worked.kind;
  };
  const kind = kindOf(formula);
  const wanted = fields.get(field.name)?.kind;
  if (
    wanted &&
    !(kind === 'any' || kind === 'null' || kind === wanted || (wanted === 'date' && kind === 'datetime') || (wanted === 'text' && kind !== 'text[]'))
  ) {
    issue(`${field.label} holds ${KIND_WORDS[wanted]}, and this formula gives ${KIND_WORDS[kind]}`);
  }
}

/**
 * Check an action's steps: what each sets or adds exists and can be set by a step; each value
 * fits its field; conditions and references are sound. A step's values refer to the record and to
 * the person, never to lines one by one.
 */
export function checkSteps(
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
        message: lines.has(name)
          ? `${expression.ref}: a step can't use lines one by one. Add a rollup, such as a total, and use that`
          : `${expression.ref}: no such field`,
      });
      return 'any';
    }
    if ('today' in expression) return 'date';
    if ('now' in expression) return 'datetime';
    const op = operatorOf(expression);
    if (!op) return 'any';
    if (op === 'if') checkCondition((expression as { if: readonly [Condition, Expression, Expression] }).if[0], { record: fields, lines }, at, issues);
    const worked = calculationKind(
      op,
      operandsOf(expression).map((operand) => kindOf(operand, at)),
    );
    for (const message of worked.problems) issues.push({ path: at, message });
    return worked.kind;
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
          else if (!isWritable(info))
            issues.push({ path: `${at}.field`, message: info.system ? `${step.field} is set by the platform` : `${step.field} is ${workedOutBy(info)}` });
          else if (info.field?.type === 'file') issues.push({ path: `${at}.field`, message: "A step can't set a file: take it as input" });
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
            else if (info.field?.type === 'file') issues.push({ path: `${at}.values.${name}`, message: "A step can't set a file: take it as input" });
            else fits(info, expression, `${at}.values.${name}`, info.field?.label ?? name);
          }
          for (const declared of lineEntity.fields) {
            const defaulted = 'default' in declared && declared.default !== undefined;
            if (declared.required && !(declared.name in step.values) && !defaulted)
              issues.push({ path: `${at}.values`, message: `Each line needs ${declared.label}: give it a value` });
          }
          return;
        }
        case 'check':
          condition(step.assert, `${at}.assert`);
          for (const field of step.fields ?? []) if (!fields.has(field)) issues.push({ path: `${at}.fields`, message: `No field named ${field}` });
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

/** System fields that name a person, which a user task can be assigned to. */
export const PERSON_FIELDS: readonly string[] = ['owner', 'created_by', 'updated_by'];

/** Where on a flow that waits an issue of its compiled process is: the step, and the part of it. */
export function stepPathOf(name: string, path: string, process: Process, at: ReadonlyMap<string, string>): string {
  const found = /^processes\.[a-z0-9_]+\.(elements|flows)\.([A-Za-z0-9_-]+)(.*)$/.exec(path);
  const step = found ? at.get(found[2]!) : undefined;
  if (!found || !step) return `flows.${name}`;
  if (found[1] === 'flows') return `flows.${name}.${step}`;
  const tail = found[3]!;
  const element = process.elements[found[2]!];
  // The step names some parts as the engine's element does not.
  const part = ((): string => {
    switch (element?.type) {
      case 'userTask':
        return tail.replace(/^\.name\b/, '.label');
      case 'startEvent':
        return tail.replace(/^\.timer\.duration\b/, '.after').replace(/^\.timer\b/, '');
      case 'subProcess':
        return tail.replace(/^\.repeat\b/, '');
      case 'intermediateCatchEvent':
        return tail.replace(/^\.(timer|message)\b/, '.for').replace(/^\.(condition|signal)\b/, '.for.$1');
      case 'boundaryEvent':
        return /^\.timer\b/.test(tail) ? '.after' : '';
      case 'callActivity':
        return tail.replace(/^\.process\b/, '.flow');
      default:
        return '';
    }
  })();
  return `flows.${name}.${step}${part}`;
}

/** Processes that call each other in a ring would call without end: each call is refused where the ring closes. */
export function checkCalls(definition: StoredDefinition, issues: Issue[]): void {
  const processes = definition.processes ?? {};
  const calls = new Map(
    Object.entries(processes).map(([name, process]) => [name, processWork(process).calls.filter((called) => called !== name && processes[called])]),
  );
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length) {
      const at = queue.pop()!;
      if (at === target) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      queue.push(...(calls.get(at) ?? []));
    }
    return false;
  };
  for (const [name, process] of Object.entries(processes)) {
    for (const [id, element] of Object.entries(process.elements)) {
      if (element.type !== 'callActivity' || element.process === name || !processes[element.process]) continue;
      if (reaches(element.process, name)) {
        issues.push({
          path: `processes.${name}.elements.${id}.process`,
          message: `${processes[element.process]!.label} calls ${process.label} in turn, so they would call each other without end`,
        });
      }
    }
  }
}

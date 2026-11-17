import { evaluateCondition } from '@platform/authz';
import { evaluateExpression, roundTo, type Expression, type ExpressionValue } from './expressions.js';
import { entityFields, isWritable, type FieldInfo, type StoredDefinition } from './fields.js';
import type { Finding } from './rules.js';
import type { SimpleStep, Step } from './schema.js';
import { canonicalValue, conditionRecord, rollupValues, type FieldValue, type LineValues, type RecordLines, type RecordValues, type ValueIssue } from './values.js';

/** A call to an a7c skill that an action makes once its change is saved. */
export interface SkillCall {
  /** Where the step is, as `steps[2]` or `steps[3].then[0]`. */
  readonly step: string;
  readonly label: string;
  readonly skill: string;
  readonly input: Readonly<Record<string, ExpressionValue>>;
}

export interface StepsResult {
  /** The record after the steps: every value it had, with what the steps set and the rollups of their lines. */
  readonly record: Record<string, FieldValue>;
  /** The lines of each lines field given, after the steps. Lines the steps add have no ID yet. */
  readonly lines: Record<string, LineValues[]>;
  /** The fields the steps set, and the lines fields they added lines to. */
  readonly set: readonly string[];
  readonly linesAdded: readonly string[];
  /** Warnings from checks, which travel with the change. */
  readonly findings: readonly Finding[];
  readonly skills: readonly SkillCall[];
  /** Values that a step worked out but its field can't hold. Any issue stops the action. */
  readonly issues: readonly ValueIssue[];
  /** The check that failed, if one did. The action stops with its message. */
  readonly failed?: Finding;
}

/** How a person names a step: "Step 2", or "Step 3, then 1" inside a branch. */
export function stepName(path: string): string {
  const match = /^steps\[(\d+)\](?:\.(then|else)\[(\d+)\])?$/.exec(path);
  if (!match) return path;
  const top = Number(match[1]) + 1;
  return match[2] ? `Step ${top}, ${match[2]} ${Number(match[3]) + 1}` : `Step ${top}`;
}

/** Fit a worked-out value to its field: a number to the field's decimal places, as money is rounded. */
function fit(info: FieldInfo, raw: ExpressionValue): ExpressionValue {
  if (info.field?.type === 'number' && typeof raw === 'number') return roundTo(raw, info.field.decimals);
  if (info.field?.type === 'date' && typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw.slice(0, 10);
  return raw;
}

/** The fields and lines fields that the steps always give a value: at the top level, or on both sides of a branch. */
export function alwaysGiven(steps: readonly Step[]): Set<string> {
  const given = (list: readonly SimpleStep[]) => new Set(list.flatMap((step) => (step.type === 'set' || step.type === 'add_line' ? [step.field] : [])));
  const names = new Set<string>();
  for (const step of steps) {
    if (step.type === 'set' || step.type === 'add_line') names.add(step.field);
    if (step.type === 'if') {
      const [a, b] = [given(step.then), given(step.else)];
      for (const name of a) if (b.has(name)) names.add(name);
    }
  }
  return names;
}

/** The lines fields that an action's steps add lines to, at any depth. */
export function linesFieldsAddedTo(steps: readonly Step[]): string[] {
  const names = new Set<string>();
  const visit = (list: readonly (Step | SimpleStep)[]) => {
    for (const step of list) {
      if (step.type === 'add_line') names.add(step.field);
      if (step.type === 'if') {
        visit(step.then);
        visit(step.else);
      }
    }
  };
  visit(steps);
  return [...names];
}

/**
 * Where a definition starts a7c skills, as issues: for an installation that doesn't connect a7c,
 * which refuses such a definition rather than queue calls that nothing would ever send.
 */
export function skillStepIssues(definition: { readonly actions: Readonly<Record<string, { readonly steps?: readonly Step[] }>> }): Array<{ path: string; message: string }> {
  return Object.entries(definition.actions).flatMap(([name, action]) =>
    skillSteps(action.steps ?? []).map(({ path, step }) => ({
      path: `actions.${name}.${path}`,
      message: `${step.label}: this installation doesn't connect a7c, so an action can't start an a7c skill. Leave the step out, or ask an admin to connect a7c`,
    })),
  );
}

/** Every skill step of an action, at any depth, with where it is. */
export function skillSteps(steps: readonly Step[]): Array<{ readonly path: string; readonly step: Extract<Step, { type: 'skill' }> }> {
  const found: Array<{ path: string; step: Extract<Step, { type: 'skill' }> }> = [];
  steps.forEach((step, index) => {
    if (step.type === 'skill') found.push({ path: `steps[${index}]`, step });
    if (step.type === 'if') {
      for (const branch of ['then', 'else'] as const) {
        step[branch].forEach((inner, i) => {
          if (inner.type === 'skill') found.push({ path: `steps[${index}].${branch}[${i}]`, step: inner });
        });
      }
    }
  });
  return found;
}

/**
 * Run an action's steps on the record as the action has shaped it so far: its values before, the
 * caller's input and the values the action sets. Steps see the record's real values, not masked
 * ones: they are the app's own logic, which a change request reviews.
 *
 * It is a pure function of the record, its lines, the person and the time. It changes nothing
 * and calls nothing: skill calls come back as a list, for the caller to queue with the change.
 */
export function runSteps(input: {
  readonly definition: StoredDefinition;
  readonly entity: string;
  readonly steps: readonly Step[];
  readonly record: RecordValues;
  /** The record's lines, for each lines field the steps add to, and any others the caller has. */
  readonly lines: RecordLines;
  readonly principal: Readonly<Record<string, unknown>>;
  readonly now: Date;
}): StepsResult {
  const { definition, principal, now } = input;
  const entity = definition.entities[input.entity]!;
  const fields = entityFields(entity);
  const record: Record<string, FieldValue> = { ...input.record };
  const lines: Record<string, LineValues[]> = Object.fromEntries(Object.entries(input.lines).map(([name, list]) => [name, [...list]]));
  const set = new Set<string>();
  const linesAdded = new Set<string>();
  const findings: Finding[] = [];
  const skills: SkillCall[] = [];
  const issues: ValueIssue[] = [];
  let failed: Finding | undefined;

  const work = (expression: Expression, at: string, field: string): ExpressionValue | undefined => {
    const result = evaluateExpression(expression, { record, principal, now });
    if (result.ok) return result.value;
    issues.push({ field, code: 'invalid_type', message: `${stepName(at)}: ${result.message}` });
    return undefined;
  };
  const assign = (info: FieldInfo | undefined, raw: ExpressionValue, at: string, field: string, label: string): FieldValue | undefined => {
    if (!info || !isWritable(info) || info.field?.type === 'file') {
      issues.push({ field, code: 'not_writable', message: `${stepName(at)}: ${label} can't be set by a step` });
      return undefined;
    }
    const result = canonicalValue(info, fit(info, raw));
    if (result.ok && result.value === null && info.field?.required) {
      issues.push({ field, code: 'required', message: `${stepName(at)}: ${label} is required, and the step leaves it empty` });
      return undefined;
    }
    if (result.ok) return result.value;
    issues.push({ field, code: result.issue.code, message: `${stepName(at)}: ${label}: ${result.issue.message}` });
    return undefined;
  };

  const run = (step: Step | SimpleStep, at: string): boolean => {
    switch (step.type) {
      case 'set': {
        const info = fields.get(step.field);
        const raw = work(step.value, at, step.field);
        if (raw === undefined) return true;
        const value = assign(info, raw, at, step.field, info?.field?.label ?? step.field);
        if (value !== undefined) {
          record[step.field] = value;
          set.add(step.field);
        }
        return true;
      }
      case 'add_line': {
        const linesField = entity.fields.find((f) => f.name === step.field && f.type === 'lines');
        if (!linesField || linesField.type !== 'lines') {
          issues.push({ field: step.field, code: 'unknown_field', message: `${stepName(at)}: ${entity.label} has no lines field ${step.field}` });
          return true;
        }
        const lineEntity = definition.entities[linesField.entity]!;
        const lineFields = entityFields(lineEntity, { line: true });
        const current = lines[step.field] ?? [];
        const position = `${step.field}[${current.length}]`;
        if (current.length >= linesField.max) {
          issues.push({ field: step.field, code: 'too_big', message: `${stepName(at)}: ${linesField.label} can have at most ${linesField.max} lines` });
          return true;
        }
        const values: Record<string, FieldValue> = {};
        for (const declared of lineEntity.fields) {
          let value: FieldValue | undefined = null;
          if (declared.name in step.values) {
            const raw = work(step.values[declared.name]!, at, `${position}.${declared.name}`);
            value = raw === undefined ? undefined : assign(lineFields.get(declared.name), raw, at, `${position}.${declared.name}`, declared.label);
            if (value === undefined) return true;
          } else if ('default' in declared && declared.default !== undefined) {
            const result = canonicalValue(lineFields.get(declared.name)!, declared.default);
            value = result.ok ? result.value : null;
          }
          values[declared.name] = value;
          if (declared.required && value === null) {
            issues.push({ field: `${position}.${declared.name}`, code: 'required', message: `${stepName(at)}: ${declared.label} is required` });
          }
        }
        lines[step.field] = [...current, { id: null, values }];
        linesAdded.add(step.field);
        // Later steps see the new totals.
        const rollups = rollupValues(definition, input.entity, { [step.field]: lines[step.field]! });
        issues.push(...rollups.issues);
        Object.assign(record, rollups.values);
        return true;
      }
      case 'check': {
        if (evaluateCondition(step.assert, { record: conditionRecord(record), principal, context: {} })) return true;
        const finding: Finding = { rule: at, severity: step.severity, message: step.message, fields: [...(step.fields ?? [])] };
        if (step.severity === 'warning') {
          findings.push(finding);
          return true;
        }
        failed = finding;
        return false;
      }
      case 'skill': {
        const values: Record<string, ExpressionValue> = {};
        for (const [name, expression] of Object.entries(step.input)) {
          const raw = work(expression, at, `${at}.input.${name}`);
          if (raw !== undefined) values[name] = raw;
        }
        skills.push({ step: at, label: step.label, skill: step.skill, input: values });
        return true;
      }
      case 'if': {
        const branch = evaluateCondition(step.when, { record: conditionRecord(record), principal, context: {} }) ? 'then' : 'else';
        return step[branch].every((inner, index) => run(inner, `${at}.${branch}[${index}]`) && issues.length === 0);
      }
    }
  };

  input.steps.every((step, index) => run(step, `steps[${index}]`) && issues.length === 0);
  return { record, lines, set: [...set], linesAdded: [...linesAdded], findings, skills, issues, ...(failed ? { failed } : {}) };
}

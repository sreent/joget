import { type Condition, evaluateCondition } from '@platform/authz';
import type { StoredDefinition } from './fields.js';
import { conditionRecord, type RecordLines, type RecordValues } from './values.js';

/** A rule that didn't hold for a record, or for one of its lines. */
export interface Finding {
  readonly rule: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  /** The fields it points at; for a line, as `lines[2].amount`. */
  readonly fields: string[];
  /** For a rule on lines: which line, by lines field and position. */
  readonly line?: { readonly field: string; readonly index: number };
}

/**
 * Run an entity's rules on a record as it will be after a write, and the rules of its line
 * entities on each of its lines, if given. Every write path runs them: forms, the API, agents and
 * automations (design §6.2). Errors block the write; warnings travel with it to whoever approves it.
 */
export function evaluateRules(
  definition: StoredDefinition,
  entity: string,
  values: RecordValues,
  env: { readonly principal: Readonly<Record<string, unknown>> },
  lines: RecordLines = {},
): Finding[] {
  const findings: Finding[] = [];
  const check = (entityName: string, record: RecordValues, place?: { field: string; index: number }) => {
    const scope = { record: conditionRecord(record), principal: env.principal, context: {} };
    for (const [name, rule] of Object.entries(definition.rules)) {
      if (rule.entity !== entityName) continue;
      if (rule.when && !evaluateCondition(rule.when, scope)) continue;
      if (evaluateCondition(rule.assert, scope)) continue;
      const fields = (rule.fields ?? []).map((field) => (place ? `${place.field}[${place.index}].${field}` : field));
      findings.push({ rule: name, severity: rule.severity, message: rule.message, fields, ...(place ? { line: place } : {}) });
    }
    // A field required while a condition holds is a rule of the field's own.
    for (const field of definition.entities[entityName]?.fields ?? []) {
      if (!field.requiredWhen || field.type === 'lines' || !evaluateCondition(field.requiredWhen, scope)) continue;
      const value = record[field.name];
      if (value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && !value.length)) continue;
      const at = place ? `${place.field}[${place.index}].${field.name}` : field.name;
      findings.push({
        rule: `fields.${field.name}`,
        severity: 'error',
        message: `${field.label} is required`,
        fields: [at],
        ...(place ? { line: place } : {}),
      });
    }
  };
  check(entity, values);
  for (const field of definition.entities[entity]?.fields ?? []) {
    if (field.type !== 'lines') continue;
    for (const [index, line] of (lines[field.name] ?? []).entries()) {
      check(field.entity, { ...line.values, ...(line.id ? { id: line.id } : {}) }, { field: field.name, index });
    }
  }
  return findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

/**
 * Whether a condition holds of a record's values as a form has them now: what screens show, hide
 * and ask for. An empty value counts as missing, as it does in a rule.
 */
export function holdsOn(condition: Condition, values: Readonly<Record<string, unknown>>, principal: Readonly<Record<string, unknown>> = {}): boolean {
  const record = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && !value.length)),
  );
  return evaluateCondition(condition, { record, principal, context: {} });
}

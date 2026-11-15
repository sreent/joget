import { evaluateCondition } from '@platform/authz';
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
  };
  check(entity, values);
  for (const field of definition.entities[entity]?.fields ?? []) {
    if (field.type !== 'lines') continue;
    (lines[field.name] ?? []).forEach((line, index) => check(field.entity, { ...line.values, ...(line.id ? { id: line.id } : {}) }, { field: field.name, index }));
  }
  return findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

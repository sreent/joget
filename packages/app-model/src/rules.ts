import { evaluateCondition } from '@platform/authz';
import type { StoredDefinition } from './fields.js';
import { conditionRecord, type RecordValues } from './values.js';

/** A rule that didn't hold for a record. */
export interface Finding {
  readonly rule: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly fields: string[];
}

/**
 * Run an entity's rules on a record as it will be after a write. Every write path runs them:
 * forms, the API, agents and automations (design §6.2). Errors block the write; warnings travel
 * with it to whoever approves it.
 */
export function evaluateRules(
  definition: StoredDefinition,
  entity: string,
  values: RecordValues,
  env: { readonly principal: Readonly<Record<string, unknown>> },
): Finding[] {
  const scope = { record: conditionRecord(values), principal: env.principal, context: {} };
  const findings: Finding[] = [];
  for (const [name, rule] of Object.entries(definition.rules)) {
    if (rule.entity !== entity) continue;
    if (rule.when && !evaluateCondition(rule.when, scope)) continue;
    if (!evaluateCondition(rule.assert, scope)) {
      findings.push({ rule: name, severity: rule.severity, message: rule.message, fields: [...(rule.fields ?? [])] });
    }
  }
  return findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

import type { PermissionGrant } from '@platform/authz';
import type { StoredDefinition, StoredEntity } from './fields.js';
import { compileAppPolicy, covers, fieldAccess, type FieldAccess } from './roles.js';
import { conditionText } from './condition-text.js';
import { flowWork } from './flows.js';
import { processWork } from './processes.js';
import { scheduleWords } from './schedules.js';
import type { Action, AppFlow, ConfirmationLevel, Connection, ConnectionAuth, Process, Query } from './schema.js';
import { flowSubject, startWords } from './waiting.js';

/*
 * What a change request shows its reviewers (design §6.7): what changed, who gains or loses
 * access, which agent tools change, and what looks wrong. Also the three-way merge, for when the
 * main line moved on while a builder worked.
 */

/** JSON with sorted keys: two values are equal exactly when this is. */
function stable(value: unknown): string {
  return (
    JSON.stringify(value, (_key, inner: unknown) =>
      inner !== null && typeof inner === 'object' && !Array.isArray(inner)
        ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : inner,
    ) ?? 'undefined'
  );
}
const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b);

/** The parts of a definition, each a map of named artifacts. The menu is one artifact on its own. */
export const DEFINITION_SECTIONS = ['entities', 'rules', 'actions', 'queries', 'cards', 'forms', 'roles', 'pages', 'processes', 'flows'] as const;
export type DefinitionSection = (typeof DEFINITION_SECTIONS)[number] | 'navigation';

export interface DefinitionChange {
  readonly section: DefinitionSection;
  /** The artifact's name in the head, or in the base if the change removes it. */
  readonly name: string;
  readonly change: 'added' | 'removed' | 'changed';
  /** A renamed entity's name in the base. */
  readonly from?: string;
  /** For an entity: what changed in it. */
  readonly details: readonly string[];
}

/** What a change does to a definition, artifact by artifact. Entities match by ID, so a rename is one change. */
export function diffDefinitions(base: StoredDefinition, head: StoredDefinition): DefinitionChange[] {
  const changes: DefinitionChange[] = [];
  const baseById = new Map(Object.entries(base.entities).map(([name, entity]) => [entity.id, { name, entity }]));
  const headIds = new Set(Object.values(head.entities).map((entity) => entity.id));
  for (const [name, entity] of Object.entries(head.entities)) {
    const before = baseById.get(entity.id);
    if (!before) {
      changes.push({ section: 'entities', name, change: 'added', details: entity.fields.map((field) => `Field ${field.name} (${field.type})`) });
      continue;
    }
    const details = entityChanges(before.entity, entity);
    if (before.name !== name) details.unshift(`Renamed from ${before.name}`);
    if (details.length) changes.push({ section: 'entities', name, change: 'changed', ...(before.name !== name ? { from: before.name } : {}), details });
  }
  for (const [id, { name }] of baseById) {
    if (!headIds.has(id)) changes.push({ section: 'entities', name, change: 'removed', details: [] });
  }
  for (const section of DEFINITION_SECTIONS) {
    if (section === 'entities') continue;
    const before: Readonly<Record<string, unknown>> = base[section] ?? {};
    const after: Readonly<Record<string, unknown>> = head[section] ?? {};
    for (const name of Object.keys(after)) {
      if (!(name in before)) changes.push({ section, name, change: 'added', details: [] });
      else if (!same(before[name], after[name])) changes.push({ section, name, change: 'changed', details: [] });
    }
    for (const name of Object.keys(before)) {
      if (!(name in after)) changes.push({ section, name, change: 'removed', details: [] });
    }
  }
  if (!same(base.navigation, head.navigation)) {
    changes.push({ section: 'navigation', name: 'menu', change: !base.navigation ? 'added' : !head.navigation ? 'removed' : 'changed', details: [] });
  }
  return changes;
}

function entityChanges(before: StoredEntity, after: StoredEntity): string[] {
  const details: string[] = [];
  const { fields: oldFields, ...oldSettings } = before;
  const { fields: newFields, ...newSettings } = after;
  if (oldSettings.label !== newSettings.label) details.push(`Label is now ${newSettings.label}`);
  if (oldSettings.titleField !== newSettings.titleField) details.push(newSettings.titleField ? `Records are now named by ${newSettings.titleField}` : 'Records are no longer named by a field');
  if (oldSettings.history !== newSettings.history) details.push(newSettings.history ? 'History is now kept' : 'History is no longer kept');
  const { label: _l1, titleField: _t1, history: _h1, ...oldRest } = oldSettings;
  const { label: _l2, titleField: _t2, history: _h2, ...newRest } = newSettings;
  if (!same(oldRest, newRest)) details.push('Description changed');

  const old = new Map(oldFields.map((field) => [field.id, field]));
  const kept = new Set(newFields.map((field) => field.id));
  for (const field of newFields) {
    const prior = old.get(field.id);
    if (!prior) {
      details.push(`Added field ${field.name} (${field.type})`);
      continue;
    }
    if (prior.name !== field.name) details.push(`Renamed field ${prior.name} to ${field.name}`);
    if (prior.type !== field.type) details.push(`Field ${field.name} is now ${field.type}, not ${prior.type}`);
    else if (!same({ ...prior, name: '' }, { ...field, name: '' })) details.push(`Changed field ${field.name}`);
  }
  for (const field of oldFields) if (!kept.has(field.id)) details.push(`Removed field ${field.name}`);
  const order = (fields: readonly { id: string }[]) => fields.map((field) => field.id).filter((id) => old.has(id) && kept.has(id));
  if (!same(order(oldFields), order(newFields))) details.push('Fields are in a new order');
  return details;
}

/** One way in which holding a role changes. */
export interface AccessChange {
  readonly role: string;
  /** `gains`: the role can do more. `loses`: less. `changes`: something different, neither more nor less. */
  readonly kind: 'gains' | 'loses' | 'changes';
  readonly text: string;
}

const VERBS: Readonly<Record<string, string>> = {
  'record.read': 'read',
  'record.create': 'create',
  'record.update': 'update',
  'record.delete': 'delete',
  'record.export': 'export',
  'action.run': 'run',
  'query.run': 'run',
  'process.start': 'start',
};
const ACCESS_RANK: Readonly<Record<FieldAccess, number>> = { hidden: 0, masked: 1, full: 2 };

/** The grants of each role, keyed by permission and target. Entities are keyed by ID, so renames match. */
function grantsByRole(definition: StoredDefinition): Map<string, Map<string, PermissionGrant>> {
  const { permissionSets } = compileAppPolicy('diff', definition);
  const result = new Map<string, Map<string, PermissionGrant>>();
  const names = Object.keys(definition.roles);
  permissionSets.forEach((set, index) => {
    const grants = new Map<string, PermissionGrant>();
    for (const grant of set.grants) {
      if (!(grant.permission in VERBS)) continue;
      const target = grant.permission.startsWith('record.') ? (definition.entities[grant.resource ?? '']?.id ?? grant.resource) : grant.resource;
      grants.set(`${grant.permission} ${target}`, grant);
    }
    result.set(names[index]!, grants);
  });
  return result;
}

/** A field's paths in an entity, by ID: `fieldId` or `linesFieldId.lineFieldId`, with the names that grants use. */
function fieldPaths(definition: StoredDefinition, entity: StoredEntity): Map<string, string> {
  const paths = new Map<string, string>();
  for (const field of entity.fields) {
    paths.set(field.id, field.name);
    if (field.type !== 'lines') continue;
    for (const sub of definition.entities[field.entity]?.fields ?? []) paths.set(`${field.id}.${sub.id}`, `${field.name}.${sub.name}`);
  }
  return paths;
}

/**
 * Who gains or loses access, role by role, in plain words: for example "Approver can now export
 * Expense claim" (design §6.7). Field-level access is compared through the compiled grants, so the
 * diff means exactly what the policy engine will do.
 */
export function accessChanges(base: StoredDefinition, head: StoredDefinition): AccessChange[] {
  const changes: AccessChange[] = [];
  const before = grantsByRole(base);
  const after = grantsByRole(head);
  const entityById = (definition: StoredDefinition, id: string) => Object.values(definition.entities).find((entity) => entity.id === id);
  const labelOf = (permission: string, target: string): string => {
    if (permission === 'action.run') return head.actions[target]?.label ?? base.actions[target]?.label ?? target;
    if (permission === 'query.run') return head.queries[target]?.label ?? base.queries[target]?.label ?? target;
    if (permission === 'process.start') return head.processes?.[target]?.label ?? base.processes?.[target]?.label ?? head.flows?.[target]?.label ?? base.flows?.[target]?.label ?? target;
    if (permission === 'flow.run') return head.flows?.[target]?.label ?? base.flows?.[target]?.label ?? target;
    return (entityById(head, target) ?? entityById(base, target))?.label ?? target;
  };

  for (const role of new Set([...Object.keys(base.roles), ...Object.keys(head.roles)])) {
    const label = head.roles[role]?.label ?? base.roles[role]!.label;
    const add = (kind: AccessChange['kind'], text: string) => changes.push({ role, kind, text: `${label} ${text}` });
    if (!head.roles[role]) {
      add('loses', 'is removed: whoever holds it loses its access');
      continue;
    }
    if (!base.roles[role]) add('gains', 'is a new role');
    const old = before.get(role) ?? new Map<string, PermissionGrant>();
    const now = after.get(role)!;
    for (const key of new Set([...old.keys(), ...now.keys()])) {
      const [permission, target] = key.split(' ') as [string, string];
      const verb = VERBS[permission]!;
      const what = labelOf(permission, target);
      const b = old.get(key);
      const h = now.get(key);
      const isRecord = permission.startsWith('record.');
      // An entity that the change removes takes its access with it: the data change says so.
      if (isRecord && !entityById(head, target)) continue;
      if (!b && h) {
        add('gains', `can now ${verb} ${what}${h.condition ? ', for records that match a condition' : ''}`);
        continue;
      }
      if (b && !h) {
        add('loses', `can no longer ${verb} ${what}`);
        continue;
      }
      if (!b || !h || !isRecord) continue;
      if (b.condition && !h.condition) add('gains', `can now ${verb} every ${what} record`);
      else if (!b.condition && h.condition) add('loses', `can now ${verb} only ${what} records that match a condition`);
      else if (!same(b.condition, h.condition)) add('changes', `${verb}s a different set of ${what} records`);
      if (!same(b.check, h.check)) add('changes', `must meet a different condition to ${verb} ${what}`);
      if (permission === 'record.delete' || permission === 'record.export') continue;

      const baseEntity = entityById(base, target);
      const headEntity = entityById(head, target)!;
      const oldPaths = baseEntity ? fieldPaths(base, baseEntity) : new Map<string, string>();
      for (const [id, name] of fieldPaths(head, headEntity)) {
        const oldName = oldPaths.get(id);
        if (permission === 'record.read') {
          const was = oldName === undefined ? 'hidden' : fieldAccess([b], oldName);
          const is = fieldAccess([h], name);
          if (ACCESS_RANK[is] > ACCESS_RANK[was]) add('gains', is === 'full' && was === 'masked' ? `now sees ${what}.${name} in full` : `can now see ${what}.${name}${is === 'masked' ? ', masked' : ''}`);
          else if (ACCESS_RANK[is] < ACCESS_RANK[was]) add('loses', is === 'masked' ? `now sees ${what}.${name} masked` : `can no longer see ${what}.${name}`);
        } else {
          const could = oldName !== undefined && covers(b, oldName);
          const can = covers(h, name);
          if (can && !could) add('gains', `can now set ${what}.${name} when it ${verb}s`);
          else if (could && !can) add('loses', `can no longer set ${what}.${name} when it ${verb}s`);
        }
      }
    }
  }
  return changes;
}

/** One way in which the tools that agents see change. Actions and queries are the tools. */
export interface CapabilityChange {
  readonly tool: string;
  readonly change: 'added' | 'removed' | 'changed';
  readonly text: string;
}

const CONFIRMATION_TEXT: Readonly<Record<ConfirmationLevel, string>> = {
  none: 'runs without asking the person',
  preview: 'asks the person to confirm a preview',
  review: 'asks the person to review it in full',
};
const CONFIRMATION_RANK: Readonly<Record<ConfirmationLevel, number>> = { none: 0, preview: 1, review: 2 };

/**
 * Which tools agents gain or lose, and what changes in the others: for example "submit_claim now
 * needs less confirmation" (design §6.7).
 */
export function capabilityChanges(base: StoredDefinition, head: StoredDefinition): CapabilityChange[] {
  const changes: CapabilityChange[] = [];
  const entityLabel = (name: string) => head.entities[name]?.label ?? base.entities[name]?.label ?? name;
  for (const name of new Set([...Object.keys(base.actions), ...Object.keys(head.actions)])) {
    const [b, h] = [base.actions[name], head.actions[name]];
    if (!b && h) {
      changes.push({ tool: name, change: 'added', text: `New tool ${name}: ${h.operation === 'create' ? 'creates' : 'updates'} ${entityLabel(h.entity)}, and ${CONFIRMATION_TEXT[h.confirm]}` });
    } else if (b && !h) {
      changes.push({ tool: name, change: 'removed', text: `Agents can no longer call ${name}` });
    } else if (b && h && !same(b, h)) {
      for (const text of actionChanges(name, b, h, entityLabel)) changes.push({ tool: name, change: 'changed', text });
    }
  }
  for (const name of new Set([...Object.keys(base.queries), ...Object.keys(head.queries)])) {
    const [b, h] = [base.queries[name], head.queries[name]];
    if (!b && h) changes.push({ tool: name, change: 'added', text: `New tool ${name}: ${h.summary ? 'works out numbers from' : 'answers from'} ${entityLabel(h.entity)}` });
    else if (b && !h) changes.push({ tool: name, change: 'removed', text: `Agents can no longer call ${name}` });
    else if (b && h && !same(b, h)) for (const text of queryChanges(name, b, h, entityLabel)) changes.push({ tool: name, change: 'changed', text });
  }
  const [baseProcesses, headProcesses] = [base.processes ?? {}, head.processes ?? {}];
  for (const name of new Set([...Object.keys(baseProcesses), ...Object.keys(headProcesses)])) {
    const [b, h] = [baseProcesses[name], headProcesses[name]];
    if (!b && h) {
      const starts = startingActions(h);
      const { actions, flows, calls, scripts } = processWork(h);
      const called = Object.values(headProcesses).some((other) => processWork(other).calls.includes(name));
      const how = [...(starts.length ? [`${starts.join(', ')} start${starts.length > 1 ? '' : 's'} it`] : []), ...automaticStarts(h).map((words) => `it starts by itself ${words}`)];
      const texts = [
        `New process ${h.label}, on ${entityLabel(h.entity)}: ${how.length ? how.join('; ') : called ? 'another process calls it' : 'people start it by hand'}`,
        ...(actions.length ? [`It runs ${actions.join(', ')} by itself`] : []),
        ...(flows.length ? [`It runs the flow${flows.length > 1 ? 's' : ''} ${flows.join(', ')} by itself`] : []),
        ...(calls.length ? [`It calls ${calls.join(', ')}`] : []),
        ...(scripts.length ? [`It changes the record by itself in ${scripts.join(', ')}`] : []),
      ];
      changes.push({ tool: name, change: 'added', text: texts.join('. ') });
    } else if (b && !h) {
      changes.push({ tool: name, change: 'removed', text: `${b.label} no longer starts. Running instances finish on the release they started on` });
    } else if (b && h && !same(b, h)) {
      for (const text of processChanges(b, h)) changes.push({ tool: name, change: 'changed', text });
    }
  }
  // What each flow does to records, for reviewers: flows run with the app's authority.
  const [baseFlows, headFlows] = [base.flows ?? {}, head.flows ?? {}];
  for (const name of new Set([...Object.keys(baseFlows), ...Object.keys(headFlows)])) {
    const [b, h] = [baseFlows[name], headFlows[name]];
    if (!b && h) {
      const work = flowWork(head, h);
      const does = [
        ...(work.finds.length ? [`finds ${work.finds.map(entityLabel).join(', ')}`] : []),
        ...(work.creates.length ? [`creates ${work.creates.map(entityLabel).join(', ')}`] : []),
        ...(work.changes.length ? [`changes ${work.changes.map(entityLabel).join(', ')}`] : []),
        ...(work.deletes.length ? [`deletes ${work.deletes.map(entityLabel).join(', ')}`] : []),
        ...(work.calls.length ? [`calls ${work.calls.join(', ')}`] : []),
        ...(work.asks.length ? [`waits for ${work.asks.join(', ')}`] : []),
        ...(work.tells.length ? [`tells ${work.tells.join(', ')}`] : []),
        ...(work.connects.length ? [`calls ${work.connects.map((connection) => head.connections?.[connection]?.label ?? connection).join(', ')}`] : []),
        ...startTexts(head, h).map((start) => `starts by itself ${start}`),
        ...(h.schedule ? [`runs by itself, with the app's authority: ${lowerFirst(scheduleWords(h.schedule))}`] : []),
      ];
      changes.push({ tool: name, change: 'added', text: `New flow ${h.label}${does.length ? `: it ${does.join('; ')}` : ''}` });
    } else if (b && !h) {
      changes.push({ tool: name, change: 'removed', text: `${b.label} is removed: nothing runs it any more` });
    } else if (b && h && !same(b, h)) {
      const [before, after] = [flowWork(base, b), flowWork(head, h)];
      const texts: string[] = [];
      const verbs = [['creates', 'creates'], ['changes', 'changes'], ['deletes', 'deletes']] as const;
      for (const [key, verb] of verbs) {
        for (const entity of after[key]) if (!before[key].includes(entity)) texts.push(`${h.label} now ${verb} ${entityLabel(entity)}`);
        for (const entity of before[key]) if (!after[key].includes(entity)) texts.push(`${h.label} no longer ${verb} ${entityLabel(entity)}`);
      }
      for (const flow of after.calls) if (!before.calls.includes(flow)) texts.push(`${h.label} now calls ${flow}`);
      for (const flow of before.calls) if (!after.calls.includes(flow)) texts.push(`${h.label} no longer calls ${flow}`);
      for (const ask of after.asks) if (!before.asks.includes(ask)) texts.push(`${h.label} now waits for ${ask}`);
      for (const ask of before.asks) if (!after.asks.includes(ask)) texts.push(`${h.label} no longer waits for ${ask}`);
      for (const told of after.tells) if (!before.tells.includes(told)) texts.push(`${h.label} now tells ${told}`);
      for (const connection of after.connects) if (!before.connects.includes(connection)) texts.push(`${h.label} now calls ${head.connections?.[connection]?.label ?? connection}`);
      for (const connection of before.connects) if (!after.connects.includes(connection)) texts.push(`${h.label} no longer calls ${base.connections?.[connection]?.label ?? connection}`);
      for (const told of before.tells) if (!after.tells.includes(told)) texts.push(`${h.label} no longer tells ${told}`);
      const [startsBefore, startsAfter] = [startTexts(base, b), startTexts(head, h)];
      for (const start of startsAfter) if (!startsBefore.includes(start)) texts.push(`${h.label} now starts by itself ${start}`);
      for (const start of startsBefore) if (!startsAfter.includes(start)) texts.push(`${h.label} no longer starts by itself ${start}`);
      const [runsBefore, runsAfter] = [b.schedule ? scheduleWords(b.schedule) : undefined, h.schedule ? scheduleWords(h.schedule) : undefined];
      if (runsAfter && runsAfter !== runsBefore) texts.push(`${h.label} now runs by itself, with the app's authority: ${lowerFirst(runsAfter)}`);
      else if (runsBefore && !runsAfter) texts.push(`${h.label} no longer runs on a schedule`);
      if (!texts.length) texts.push(`${h.label} runs different steps`);
      for (const text of texts) changes.push({ tool: name, change: 'changed', text });
    }
  }
  changes.push(...integrationChanges(base, head));
  return changes;
}

/** How a service knows the app, in words. */
function authWords(auth: ConnectionAuth): string {
  return auth.type === 'none' ? 'no secret' : auth.type === 'bearer' ? 'a bearer token' : auth.type === 'basic' ? `the user ${auth.user} and a password` : `a key in ${auth.header}`;
}

/** What reviewers see of the systems an app talks to: where its data can go, and who can run its flows from outside. */
function integrationChanges(base: StoredDefinition, head: StoredDefinition): CapabilityChange[] {
  const changes: CapabilityChange[] = [];
  const host = (connection: Connection) => (connection.kind === 'service' ? (URL.canParse(connection.url) ? new URL(connection.url).host : connection.url) : 'Teams');
  const [before, after] = [base.connections ?? {}, head.connections ?? {}];
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const [b, h] = [before[name], after[name]];
    if (!b && h) {
      const text =
        h.kind === 'service'
          ? `New connection ${h.label}: flows can call ${host(h)}, with ${authWords(h.auth)}${h.personalData ? '. It takes personal data' : ''}`
          : `New Teams channel ${h.label}: notices can post to it`;
      changes.push({ tool: name, change: 'added', text });
    } else if (b && !h) {
      changes.push({ tool: name, change: 'removed', text: `${b.label} is removed: nothing calls it any more` });
    } else if (b && h && !same(b, h)) {
      const texts: string[] = [];
      if (host(b) !== host(h)) texts.push(`${h.label} now calls ${host(h)} instead of ${host(b)}`);
      if (b.kind === 'service' && h.kind === 'service') {
        if (!same(b.auth, h.auth)) texts.push(`${h.label} now proves who it is with ${authWords(h.auth)}`);
        if (!b.personalData && h.personalData) texts.push(`${h.label} now takes personal data`);
        if (b.personalData && !h.personalData) texts.push(`${h.label} no longer takes personal data`);
      }
      if (!texts.length) texts.push(`${h.label} changed`);
      for (const text of texts) changes.push({ tool: name, change: 'changed', text });
    }
  }
  const [hooksBefore, hooksAfter] = [base.webhooks ?? {}, head.webhooks ?? {}];
  for (const name of new Set([...Object.keys(hooksBefore), ...Object.keys(hooksAfter)])) {
    const [b, h] = [hooksBefore[name], hooksAfter[name]];
    const flowLabel = (definition: StoredDefinition, flow: string) => definition.flows?.[flow]?.label ?? flow;
    if (!b && h) changes.push({ tool: name, change: 'added', text: `New webhook ${h.label}: other systems can run ${flowLabel(head, h.flow)}, with the app's authority` });
    else if (b && !h) changes.push({ tool: name, change: 'removed', text: `${b.label} is removed: other systems can no longer run ${flowLabel(base, b.flow)}` });
    else if (b && h && !same(b, h)) changes.push({ tool: name, change: 'changed', text: b.flow !== h.flow ? `${h.label} now runs ${flowLabel(head, h.flow)}` : `${h.label} takes its input from other places` });
  }
  return changes;
}

const lowerFirst = (text: string) => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** How a flow that waits starts by itself, in words, as a change request reads it: "when a Leave request is created". */
function startTexts(definition: StoredDefinition, flow: AppFlow): string[] {
  const subject = flowSubject(flow);
  if (!subject || !flow.starts) return [];
  const entity = definition.entities[subject.entity];
  const fieldLabel = (field: string) => entity?.fields.find((f) => f.name === field)?.label ?? field;
  return flow.starts.map((start) => {
    const words = lowerFirst(startWords(start, entity?.label ?? subject.entity, fieldLabel));
    return 'condition' in start ? `when ${conditionText(start.condition)}` : words;
  });
}

/** The actions whose commit starts a process. */
function startingActions(process: Process): string[] {
  return [...new Set(Object.values(process.elements).flatMap((element) => (element.type === 'startEvent' ? element.actions : [])))];
}

/** How a process starts by itself, in words: on a date of each record, a time after each is created, or when a condition comes to hold. */
function automaticStarts(process: Process): string[] {
  return Object.values(process.elements).flatMap((element) => {
    if (element.type !== 'startEvent' || element.in) return [];
    if (element.timer) return ['date' in element.timer ? `on each record's ${element.timer.date}` : `${element.timer.duration} after each record is created`];
    if (element.condition) return [`when ${conditionText(element.condition)} comes to hold`];
    if (element.signal) return [`on a record when the signal ${element.signal} is thrown for it`];
    return [];
  });
}

/** What a reviewer weighs in a changed process: what starts it, what it does by itself, and whether its flow changed. Its layout doesn't count. */
function processChanges(b: Process, h: Process): string[] {
  const texts: string[] = [];
  const [startsBefore, startsAfter] = [startingActions(b), startingActions(h)];
  for (const action of startsAfter) if (!startsBefore.includes(action)) texts.push(`${action} now starts ${h.label}`);
  for (const action of startsBefore) if (!startsAfter.includes(action)) texts.push(`${action} no longer starts ${h.label}`);
  const [autoBefore, autoAfter] = [automaticStarts(b), automaticStarts(h)];
  for (const words of autoAfter) if (!autoBefore.includes(words)) texts.push(`${h.label} now starts by itself ${words}`);
  for (const words of autoBefore) if (!autoAfter.includes(words)) texts.push(`${h.label} no longer starts by itself ${words}`);
  const [before, after] = [processWork(b), processWork(h)];
  for (const action of after.actions) if (!before.actions.includes(action)) texts.push(`${h.label} now runs ${action} by itself`);
  for (const flow of after.flows) if (!before.flows.includes(flow)) texts.push(`${h.label} now runs the flow ${flow} by itself`);
  for (const flow of before.flows) if (!after.flows.includes(flow)) texts.push(`${h.label} no longer runs the flow ${flow}`);
  for (const action of before.actions) if (!after.actions.includes(action)) texts.push(`${h.label} no longer runs ${action} by itself`);
  for (const call of after.calls) if (!before.calls.includes(call)) texts.push(`${h.label} now calls ${call}`);
  for (const call of before.calls) if (!after.calls.includes(call)) texts.push(`${h.label} no longer calls ${call}`);
  for (const script of after.scripts) if (!before.scripts.includes(script)) texts.push(`${h.label} now changes the record by itself in ${script}`);
  for (const script of before.scripts) if (!after.scripts.includes(script)) texts.push(`${h.label} no longer changes the record in ${script}`);
  if (!texts.length && !same({ ...b, diagram: undefined }, { ...h, diagram: undefined })) texts.push(`The flow of ${h.label} changed`);
  return texts;
}

function actionChanges(name: string, b: Action, h: Action, entityLabel: (name: string) => string): string[] {
  const texts: string[] = [];
  if (b.operation !== h.operation || b.entity !== h.entity) texts.push(`${name} now ${h.operation === 'create' ? 'creates' : 'updates'} ${entityLabel(h.entity)}`);
  if (b.confirm !== h.confirm) {
    const less = CONFIRMATION_RANK[h.confirm] < CONFIRMATION_RANK[b.confirm];
    texts.push(`${name} now needs ${less ? 'less' : 'more'} confirmation: it ${CONFIRMATION_TEXT[h.confirm]}`);
  }
  for (const field of h.input) if (!b.input.includes(field)) texts.push(`${name} now takes ${field}`);
  for (const field of b.input) if (!h.input.includes(field)) texts.push(`${name} no longer takes ${field}`);
  for (const [field, value] of Object.entries(h.set)) if (!same(b.set[field], value)) texts.push(`${name} now sets ${field} to ${JSON.stringify(value)}`);
  for (const field of Object.keys(b.set)) if (!(field in h.set)) texts.push(`${name} no longer sets ${field}`);
  if (!same(b.where, h.where)) texts.push(`${name} now applies to a different set of records`);
  if (!same(b.steps ?? [], h.steps ?? [])) texts.push(`${name} runs different steps`);
  if (b.before?.flow !== h.before?.flow) texts.push(h.before ? `${name} now runs the flow ${h.before.flow} before it saves` : `${name} no longer runs the flow ${b.before!.flow} before it saves`);
  else if (!same(b.before, h.before)) texts.push(`${name} gives the flow it runs before it saves different input`);
  if (b.flow?.flow !== h.flow?.flow) texts.push(h.flow ? `${name} now runs the flow ${h.flow.flow} once it saves` : `${name} no longer runs the flow ${b.flow!.flow}`);
  else if (!same(b.flow, h.flow)) texts.push(`${name} gives its flow ${h.flow!.flow} different input`);
  if (b.description !== h.description) texts.push(`${name} has a new description, which agents read to choose it`);
  if (b.card !== h.card) texts.push(`${name} shows a different review card`);
  if (b.label !== h.label && !texts.length) texts.push(`${name} has a new label`);
  return texts;
}

function queryChanges(name: string, b: Query, h: Query, entityLabel: (name: string) => string): string[] {
  const texts: string[] = [];
  if (b.entity !== h.entity) texts.push(`${name} now answers from ${entityLabel(h.entity)}`);
  for (const field of h.fields) if (!b.fields.includes(field)) texts.push(`${name} now returns ${field}`);
  for (const field of b.fields) if (!h.fields.includes(field)) texts.push(`${name} no longer returns ${field}`);
  if (!same(b.filter, h.filter)) texts.push(`${name} now returns a different set of records`);
  if (!same(b.summary, h.summary)) texts.push(h.summary ? `${name} now works out different numbers` : `${name} now returns records, not numbers`);
  for (const parameter of Object.keys(h.parameters)) if (!(parameter in b.parameters)) texts.push(`${name} now takes ${parameter}`);
  for (const parameter of Object.keys(b.parameters)) if (!(parameter in h.parameters)) texts.push(`${name} no longer takes ${parameter}`);
  if (b.description !== h.description) texts.push(`${name} has a new description, which agents read to choose it`);
  if (!texts.length) texts.push(`${name} changed`);
  return texts;
}

/** Things that are allowed but probably wrong, for reviewers to weigh. */
export function lintDefinition(definition: StoredDefinition): string[] {
  const findings: string[] = [];
  const roles = Object.values(definition.roles);
  const lines = new Set(Object.values(definition.entities).flatMap((entity) => entity.fields.flatMap((field) => (field.type === 'lines' ? [field.entity] : []))));
  if (Object.keys(definition.entities).length && !roles.length) findings.push('The app has no roles, so nobody can use it outside a preview');
  if (!roles.length) return findings;
  for (const [name, entity] of Object.entries(definition.entities)) {
    if (lines.has(name)) continue;
    if (!roles.some((role) => role.entities[name]?.read)) findings.push(`No role can read ${entity.label}`);
  }
  for (const [name, action] of Object.entries(definition.actions)) {
    if (!roles.some((role) => role.actions.includes(name))) findings.push(`No role can run the action ${action.label}`);
  }
  for (const [name, query] of Object.entries(definition.queries)) {
    if (!roles.some((role) => role.queries.includes(name))) findings.push(`No role can run the query ${query.label}`);
  }
  const called = new Set(Object.values(definition.processes ?? {}).flatMap((process) => processWork(process).calls));
  for (const [name, process] of Object.entries(definition.processes ?? {})) {
    if (!startingActions(process).length && !automaticStarts(process).length && !roles.some((role) => role.processes?.includes(name)) && !called.has(name)) {
      findings.push(`Nothing starts the process ${process.label}: no start event names an action, a timer, a condition or a signal, no role may start it, and no process calls it`);
    }
  }
  const runFlows = new Set([
    ...Object.values(definition.actions).flatMap((action) => [action.before?.flow, action.flow?.flow].filter((flow) => flow !== undefined)),
    ...Object.values(definition.processes ?? {}).flatMap((process) => processWork(process).flows),
    ...Object.values(definition.flows ?? {}).flatMap((flow) => flowWork(definition, flow).calls),
    ...roles.flatMap((role) => role.flows ?? []),
  ]);
  for (const [name, flow] of Object.entries(definition.flows ?? {})) {
    if (!runFlows.has(name)) findings.push(`Nothing runs the flow ${flow.label}: no action, process task, other flow or role names it`);
  }
  for (const [name, role] of Object.entries(definition.roles)) {
    const grants = Object.values(role.entities).some((p) => p.read || p.create || p.update || p.delete || p.export);
    if (!grants && !role.actions.length && !role.queries.length) findings.push(`The role ${role.label} (${name}) grants nothing`);
  }
  return findings;
}

/** Where both sides of a merge changed the same artifact differently. */
export interface MergeConflict {
  readonly section: DefinitionSection;
  readonly name: string;
  /** What this side did: the change being merged. */
  readonly ours: 'added' | 'removed' | 'changed';
  /** What the main line did since the change started. */
  readonly theirs: 'added' | 'removed' | 'changed';
}

export type MergeResult = { readonly ok: true; readonly definition: Record<string, unknown> } | { readonly ok: false; readonly conflicts: readonly MergeConflict[] };

/**
 * A three-way merge at the artifact level (design §6.7): an artifact changed on one side only
 * takes that side; changed the same way on both, either; changed differently, a conflict. The
 * result must still be validated, because two clean changes can break a reference together.
 */
export function mergeDefinitions(base: StoredDefinition, ours: StoredDefinition, theirs: StoredDefinition): MergeResult {
  const conflicts: MergeConflict[] = [];
  const merged: Record<string, unknown> = { formatVersion: theirs.formatVersion };
  const what = (from: unknown, to: unknown): MergeConflict['ours'] => (from === undefined ? 'added' : to === undefined ? 'removed' : 'changed');
  for (const section of DEFINITION_SECTIONS) {
    const b: Readonly<Record<string, unknown>> = base[section] ?? {};
    const o: Readonly<Record<string, unknown>> = ours[section] ?? {};
    const t: Readonly<Record<string, unknown>> = theirs[section] ?? {};
    const out: Record<string, unknown> = {};
    for (const name of new Set([...Object.keys(t), ...Object.keys(o), ...Object.keys(b)])) {
      const [bv, ov, tv] = [b[name], o[name], t[name]];
      const pick = same(ov, tv) || same(bv, ov) ? tv : same(bv, tv) ? ov : null;
      if (pick === null) {
        conflicts.push({ section, name, ours: what(bv, ov), theirs: what(bv, tv) });
        continue;
      }
      if (pick !== undefined) out[name] = pick;
    }
    // A definition without processes or flows leaves them out, so its digest stays as it was.
    if ((section !== 'processes' && section !== 'flows') || Object.keys(out).length) merged[section] = out;
  }
  const [bn, on, tn] = [base.navigation, ours.navigation, theirs.navigation];
  const menu = same(on, tn) || same(bn, on) ? tn : same(bn, tn) ? on : null;
  if (menu === null) conflicts.push({ section: 'navigation', name: 'menu', ours: what(bn, on), theirs: what(bn, tn) });
  else if (menu !== undefined) merged['navigation'] = menu;
  return conflicts.length ? { ok: false, conflicts } : { ok: true, definition: merged };
}

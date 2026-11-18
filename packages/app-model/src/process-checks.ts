import { readsPrincipal } from './before.js';
import { checkCalls, checkCondition, checkSteps, type Issue, PERSON_FIELDS } from './checks.js';
import { entityFields, lineOwners, type StoredDefinition } from './fields.js';
import { checkFlowRun } from './flows.js';
import {
  adHocStarts,
  canRepeat,
  catcherOn,
  elementName,
  eventSubCatcher,
  eventSubsIn,
  insideOf,
  isAdHoc,
  isEventSub,
  linkTarget,
  plainStartOf,
  processGraph,
  raisedCode,
  scopeOf,
  scopesOf,
  startEventsOf,
} from './processes.js';
import { type Action, type Message, type Process, RULE_OUTCOMES, type Timer } from './schema.js';
import { flowWaits } from './waiting.js';

/* The checks of the processes from before flows could wait (design §6.10): they still run, so they are still checked. */

/** Check one process of the app, or a flow that waits as the engine runs it. */
export function checkProcess(definition: StoredDefinition, name: string, process: Process, issues: Issue[], owners = lineOwners(definition)): void {
  const base = `processes.${name}`;
  const entity = definition.entities[process.entity];
  if (!entity) {
    issues.push({ path: `${base}.entity`, message: `No entity named ${process.entity}` });
    return;
  }
  const owner = owners.get(process.entity);
  if (owner) {
    issues.push({
      path: `${base}.entity`,
      message: `${process.entity} is the lines of ${owner.parent}.${owner.field}, so it has no records of its own: use ${owner.parent}`,
    });
    return;
  }
  const fields = entityFields(entity);
  const lines = new Set(entity.fields.filter((field) => field.type === 'lines').map((field) => field.name));
  const graph = processGraph(process);
  const label = (id: string) => elementName(process, id);
  const tasks = new Map<string, readonly string[]>(
    Object.entries(process.elements).flatMap(
      ([id, element]): Array<[string, readonly string[]]> =>
        element.type === 'userTask'
          ? [[id, element.outcomes.map((outcome) => outcome.name)]]
          : element.type === 'businessRuleTask'
            ? [[id, RULE_OUTCOMES]]
            : [],
    ),
  );
  const scope = { record: fields, lines, tasks };

  for (const id of Object.keys(process.flows)) {
    if (id in process.elements) issues.push({ path: `${base}.flows.${id}`, message: `${id} is also an element's ID: elements and flows share one set of IDs` });
  }
  for (const [id, flow] of Object.entries(process.flows)) {
    const path = `${base}.flows.${id}`;
    const from = process.elements[flow.from];
    const to = process.elements[flow.to];
    if (!from) issues.push({ path: `${path}.from`, message: `No element ${flow.from}` });
    if (!to) issues.push({ path: `${path}.to`, message: `No element ${flow.to}` });
    if (!from || !to) continue;
    if (from.type === 'endEvent') issues.push({ path: `${path}.from`, message: `${label(flow.from)} is an end event: no flow leaves it` });
    if (to.type === 'startEvent') issues.push({ path: `${path}.to`, message: `${label(flow.to)} is a start event: no flow leads into it` });
    if (to.type === 'boundaryEvent') issues.push({ path: `${path}.to`, message: `${label(flow.to)} sits on a task's boundary: no flow leads into it` });
    const [fromScope, toScope] = [scopeOf(process, flow.from), scopeOf(process, flow.to)];
    if (fromScope !== toScope) {
      const where = (scope: string | undefined) => (scope ? `in ${label(scope)}` : 'in the process itself');
      issues.push({
        path,
        message: `A flow can't cross the edge of a sub-process: ${label(flow.from)} is ${where(fromScope)}, and ${label(flow.to)} is ${where(toScope)}`,
      });
    }
    if (flow.outcome !== undefined) {
      const outcomes =
        from.type === 'userTask' ? from.outcomes.map((outcome) => outcome.name) : from.type === 'businessRuleTask' ? [...RULE_OUTCOMES] : undefined;
      if (!outcomes) issues.push({ path: `${path}.outcome`, message: 'Only a flow out of a user task or a rule check follows an outcome' });
      else if (!outcomes.includes(flow.outcome)) issues.push({ path: `${path}.outcome`, message: `${label(flow.from)} has no outcome ${flow.outcome}` });
    }
    if ((flow.when || flow.default) && from.type !== 'exclusiveGateway' && from.type !== 'inclusiveGateway' && from.type !== 'complexGateway') {
      issues.push({ path, message: 'Only a flow out of an exclusive or inclusive gateway has a condition or is its default' });
    }
    if (flow.when && flow.default)
      issues.push({ path: `${path}.when`, message: "A default flow has no condition: it's taken when no other flow's condition holds" });
    if (flow.when) checkCondition(flow.when, scope, `${path}.when`, issues);
  }

  const checkTimer = (timer: Timer, path: string) => {
    if (!('date' in timer)) return;
    if (timer.before && timer.after) issues.push({ path: `${path}.timer`, message: 'A timer fires before its date or after it: not both' });
    const info = fields.get(timer.date);
    if (!info) issues.push({ path: `${path}.timer.date`, message: `No field ${timer.date}` });
    else if (info.kind !== 'date' && info.kind !== 'datetime') issues.push({ path: `${path}.timer.date`, message: `${timer.date} isn't a date or a time` });
  };
  const updateAction = (action: string, path: string) => {
    const found = definition.actions[action];
    if (!found) issues.push({ path, message: `No action named ${action}` });
    else if (found.entity !== process.entity) issues.push({ path, message: `${action} works on ${found.entity}, not on ${process.entity}` });
    else if (found.operation !== 'update') issues.push({ path, message: `${action} creates a record; here an action changes the process's own record` });
    return found;
  };
  /** A message the process hears is an update action committing on its own record. */
  const messageAction = (action: string, path: string) => {
    updateAction(action, path);
  };
  const heard = (message: Message, path: string) => {
    if (message.record) issues.push({ path: `${path}.record`, message: 'A process hears actions on its own record only' });
    messageAction(message.action, `${path}.action`);
  };
  /** An undo action: an update of the record that the task changed, with no person. */
  const undoAction = (undo: string, target: string, path: string) => {
    const action = definition.actions[undo];
    if (!action) issues.push({ path, message: `No action named ${undo}` });
    else if (action.entity !== target) issues.push({ path, message: `${undo} works on ${action.entity}, but the task changes ${target}` });
    else if (action.operation !== 'update') issues.push({ path, message: `${undo} creates a record: an undo changes the record back` });
    else if (readsPrincipal(definition, action)) issues.push({ path, message: `${undo} reads the person who runs it, but a process undoes with no person` });
  };
  /** Where an error or an escalation of a code that an element throws is caught: a sub-process around it, or a call of this process. */
  const caughtIn = (
    model: Process,
    modelGraph: ReturnType<typeof processGraph>,
    scopes: readonly string[],
    kind: 'error' | 'escalation',
    code: string | undefined,
  ): boolean =>
    [...scopes, undefined].some((scope) => eventSubCatcher(model, scope, kind, code) !== undefined) ||
    scopes.some((scope) => catcherOn(model, modelGraph, scope, kind, code) !== undefined);
  const caughtAround = (id: string, kind: 'error' | 'escalation', code: string | undefined): boolean =>
    caughtIn(process, graph, scopesOf(process, id), kind, code) ||
    Object.values(definition.processes ?? {}).some((caller) => {
      const callerGraph = processGraph(caller);
      return Object.entries(caller.elements).some(
        ([callId, element]) =>
          element.type === 'callActivity' &&
          element.process === name &&
          (catcherOn(caller, callerGraph, callId, kind, code) !== undefined || caughtIn(caller, callerGraph, scopesOf(caller, callId), kind, code)),
      );
    });
  /** A message the process sends: an update action that it runs with the app's authority, on its record or on the one a reference field names. */
  const sent = (message: Message, path: string) => {
    let target = process.entity;
    if (message.record) {
      const field = fields.get(message.record)?.field;
      if (!field) issues.push({ path: `${path}.record`, message: `No field ${message.record}` });
      else if (field.type !== 'reference') issues.push({ path: `${path}.record`, message: `${message.record} doesn't refer to a record` });
      else if (field.multiple) issues.push({ path: `${path}.record`, message: `${message.record} holds several records: a message goes to one` });
      else target = field.entity;
    }
    const action = definition.actions[message.action];
    if (!action) issues.push({ path: `${path}.action`, message: `No action named ${message.action}` });
    else if (action.entity !== target) issues.push({ path: `${path}.action`, message: `${message.action} works on ${action.entity}, not on ${target}` });
    else if (action.operation !== 'update')
      issues.push({ path: `${path}.action`, message: `${message.action} creates a record; a message is an action that changes one` });
    else if (readsPrincipal(definition, action))
      issues.push({ path: `${path}.action`, message: `${message.action} reads the person who runs it, but a process sends a message with no person` });
  };
  /** An action that starts the process: it may create the record or change it. */
  const startAction = (action: string, path: string) => {
    const found = definition.actions[action];
    if (!found) issues.push({ path, message: `No action named ${action}` });
    else if (found.entity !== process.entity) issues.push({ path, message: `${action} works on ${found.entity}, not on ${process.entity}` });
    else return found;
    return undefined;
  };
  let starts = 0;
  let ends = 0;
  const startedBy = new Map<string, string>();
  for (const [id, element] of Object.entries(process.elements)) {
    const path = `${base}.elements.${id}`;
    const into = graph.incoming.get(id) ?? [];
    const out = graph.outgoing.get(id) ?? [];
    // In an ad hoc sub-process, a path may end where no flow leads on.
    const oneOut = () => {
      if (out.length !== 1 && !(out.length === 0 && isAdHoc(process, scopeOf(process, id))))
        issues.push({ path, message: `${label(id)} leads on by one flow${out.length ? ': use a gateway to split the path' : ''}` });
    };
    const linked = element.type === 'intermediateCatchEvent' && element.link !== undefined;
    if (
      element.type !== 'startEvent' &&
      element.type !== 'boundaryEvent' &&
      !linked &&
      !into.length &&
      !isEventSub(process, id) &&
      !isAdHoc(process, scopeOf(process, id))
    ) {
      issues.push({ path, message: `No flow leads to ${label(id)}` });
    }
    if (element.type !== 'boundaryEvent' && element.in !== undefined) {
      const container = process.elements[element.in];
      if (!container) issues.push({ path: `${path}.in`, message: `No element ${element.in}` });
      else if (container.type !== 'subProcess')
        issues.push({ path: `${path}.in`, message: `${label(element.in)} isn't a sub-process: only a sub-process holds other elements` });
      else if (scopeOf(process, element.in) !== undefined && scopesOf(process, element.in).includes(id)) {
        issues.push({ path: `${path}.in`, message: `${label(id)} would be inside itself` });
      }
    }
    if (canRepeat(element) && element.repeat) {
      checkCondition(element.repeat.while, scope, `${path}.repeat.while`, issues);
      if (element.type === 'userTask' && element.several)
        issues.push({ path: `${path}.repeat`, message: `${label(id)} repeats, or several people decide it: one of the two` });
      if (element.type === 'subProcess' && element.event)
        issues.push({ path: `${path}.repeat`, message: `${label(id)} is an event sub-process: its trigger starts it, so it doesn't repeat` });
      // A task whose flows follow its outcomes needs an outcome to leave by, so it checks after it runs.
      if (
        element.repeat.before &&
        (element.type === 'userTask' || element.type === 'businessRuleTask') &&
        out.some((flowId) => process.flows[flowId]!.outcome !== undefined)
      ) {
        issues.push({ path: `${path}.repeat.before`, message: `${label(id)} leaves by its outcome, so it checks whether to repeat after it runs, not before` });
      }
    }
    switch (element.type) {
      case 'startEvent': {
        const caught = element.error !== undefined || element.escalation !== undefined || element.interrupting !== undefined;
        if (element.in === undefined) {
          starts++;
          if ([element.actions.length > 0, element.timer, element.condition, element.signal].filter(Boolean).length > 1) {
            issues.push({ path, message: `${label(id)} starts on actions, a timer, a condition or a signal: one of these` });
          }
          if (caught)
            issues.push({
              path,
              message: `${label(id)} starts the process: only a start event in an event sub-process catches an error or an escalation, or lets the rest go on`,
            });
        } else if (isEventSub(process, element.in)) {
          if ([element.actions.length > 0, element.timer, element.condition, element.signal, element.error, element.escalation].filter(Boolean).length !== 1) {
            issues.push({
              path,
              message: `${label(id)} starts its event sub-process on an action, a timer, a condition, a signal, an error or an escalation: one of these`,
            });
          }
          if (element.error && element.interrupting === false)
            issues.push({ path: `${path}.interrupting`, message: 'An error always ends what it comes from' });
        } else if (element.actions.length || element.timer || element.condition || element.signal || caught) {
          issues.push({ path, message: 'A start event inside a sub-process starts when the sub-process does: it names no action, timer, condition or signal' });
        }
        if (element.timer) checkTimer(element.timer, path);
        // A start's condition reads the record: no task has an outcome yet.
        if (element.condition) checkCondition(element.condition, { ...scope, tasks: new Map() }, `${path}.condition`, issues);
        oneOut();
        // In an event sub-process, an action is a message saved on the record; otherwise, it starts the process.
        if (isEventSub(process, element.in)) for (const [index, action] of element.actions.entries()) heard({ action }, `${path}.actions[${index}]`);
        else {
          element.actions.forEach((action, index) => {
            if (!startAction(action, `${path}.actions[${index}]`)) return;
            const other = startedBy.get(action);
            if (other) issues.push({ path: `${path}.actions[${index}]`, message: `${action} already starts this process, at ${label(other)}` });
            startedBy.set(action, id);
          });
        }
        break;
      }
      case 'endEvent': {
        if (element.in === undefined) ends++;
        const ways = [element.terminate, element.message, element.error, element.escalation, element.compensate, element.cancel, element.signal].filter(
          Boolean,
        ).length;
        if (ways > 1)
          issues.push({ path, message: `${label(id)} ends in one way: for all, or with a message, an error, an escalation, an undo, a cancel or a signal` });
        if (element.message) sent(element.message, `${path}.message`);
        if (element.error && !caughtAround(id, 'error', raisedCode(element.error))) {
          issues.push({
            path: `${path}.error`,
            message: `Nothing catches the error that ${label(id)} raises: put it in a sub-process with an error event, or call this process from one with an error event on the call`,
          });
        }
        if (element.cancel) {
          const transaction = element.in !== undefined ? process.elements[element.in] : undefined;
          if (transaction?.type !== 'subProcess' || !transaction.transaction)
            issues.push({ path: `${path}.cancel`, message: 'A cancel end event sits in a transaction' });
        }
        break;
      }
      case 'scriptTask': {
        if (!element.steps.length) issues.push({ path: `${path}.steps`, message: `${label(id)} needs a step` });
        if (element.undo) undoAction(element.undo, process.entity, `${path}.undo`);
        // The steps are checked as an action's: the script runs as an update of the process's record.
        const script: Action = {
          label: element.name,
          description: element.name,
          entity: process.entity,
          operation: 'update',
          input: [],
          set: {},
          confirm: 'none',
          steps: element.steps,
        };
        checkSteps(definition, script, path, fields, lines, issues);
        if (readsPrincipal(definition, script))
          issues.push({ path: `${path}.steps`, message: `${label(id)} reads the person who runs it, but a process runs it with no person` });
        oneOut();
        break;
      }
      case 'businessRuleTask': {
        (element.rules ?? []).forEach((rule, index) => {
          const found = definition.rules[rule];
          if (!found) issues.push({ path: `${path}.rules[${index}]`, message: `No rule named ${rule}` });
          else if (found.entity !== process.entity)
            issues.push({ path: `${path}.rules[${index}]`, message: `${rule} checks ${found.entity}, not ${process.entity}` });
        });
        if (!Object.values(definition.rules).some((rule) => rule.entity === process.entity))
          issues.push({ path, message: `${process.entity} has no rules to check` });
        const named = out.filter((flowId) => process.flows[flowId]!.outcome !== undefined);
        if (named.length) {
          if (named.length !== out.length)
            issues.push({ path, message: `Every flow out of ${label(id)} follows an outcome, or one flow leads on to a gateway` });
          for (const outcome of RULE_OUTCOMES) {
            const taken = named.filter((flowId) => process.flows[flowId]!.outcome === outcome).length;
            if (taken !== 1)
              issues.push({ path, message: taken ? `${outcome}: one flow follows each outcome` : `${outcome} leads nowhere: draw a flow for it` });
          }
        } else {
          oneOut();
        }
        break;
      }
      case 'sendTask': {
        sent(element.message, `${path}.message`);
        if (element.undo) {
          const field = element.message.record ? fields.get(element.message.record)?.field : undefined;
          undoAction(element.undo, field?.type === 'reference' ? field.entity : process.entity, `${path}.undo`);
        }
        oneOut();
        break;
      }
      case 'receiveTask':
        heard(element.message, `${path}.message`);
        oneOut();
        break;
      case 'intermediateThrowEvent': {
        if ([element.message, element.link, element.escalation, element.compensate, element.signal].filter((kind) => kind !== undefined).length > 1) {
          issues.push({ path, message: `${label(id)} sends a message, escalates, undoes, throws a signal, or is a link: one of these` });
        }
        if (element.message) sent(element.message, `${path}.message`);
        if (element.link !== undefined) {
          if (!linkTarget(process, id)) issues.push({ path: `${path}.link`, message: `No catch link named ${element.link} is where ${label(id)} is` });
          if (out.length) issues.push({ path, message: `${label(id)} goes on at its catch link: no flow leaves it` });
        } else {
          oneOut();
        }
        break;
      }
      case 'subProcess': {
        const inner = startEventsOf(process, id);
        const ends = Object.values(process.elements).some((other) => other.type === 'endEvent' && other.in === id);
        if (element.adHoc) {
          // What has no flow into it starts at once, and a path ends where no flow leads on.
          if (inner.length || ends) issues.push({ path, message: `${label(id)} is ad hoc: it has no start or end event inside it` });
          if (!adHocStarts(process, graph, id).length)
            issues.push({ path, message: `${label(id)} needs something inside it that no flow leads to, which starts at once` });
          if (element.event || element.transaction)
            issues.push({ path, message: `${label(id)} is ad hoc, a transaction or an event sub-process: one of these` });
        } else {
          if (inner.length !== 1)
            issues.push({ path, message: inner.length ? `${label(id)} starts at one start event inside it` : `${label(id)} needs a start event inside it` });
          if (!ends) issues.push({ path, message: `${label(id)} needs an end event inside it` });
        }
        if (element.completeWhen) {
          if (!element.adHoc)
            issues.push({ path: `${path}.completeWhen`, message: `${label(id)} isn't ad hoc: only an ad hoc sub-process ends on a condition` });
          else checkCondition(element.completeWhen, scope, `${path}.completeWhen`, issues);
        }
        const cancels = Object.values(process.elements).some((other) => other.type === 'endEvent' && other.in === id && other.cancel);
        const leaves = (graph.boundaries.get(id) ?? []).some((boundary) => {
          const event = process.elements[boundary];
          return event?.type === 'boundaryEvent' && event.cancel;
        });
        if (element.transaction && cancels && !leaves)
          issues.push({ path, message: `${label(id)} has a cancel end event inside it, but no cancel event on its boundary to leave by` });
        if (element.event) {
          if (into.length || out.length) issues.push({ path, message: `${label(id)} starts on its start event's trigger: no flow leads into it or out of it` });
          if ((graph.boundaries.get(id) ?? []).length) issues.push({ path, message: `${label(id)} is an event sub-process: no event sits on its boundary` });
          if (element.transaction) issues.push({ path, message: `${label(id)} is a transaction or an event sub-process: one of the two` });
        } else oneOut();
        break;
      }
      case 'callActivity': {
        const called = definition.processes?.[element.process];
        if (!called) issues.push({ path: `${path}.process`, message: `No process named ${element.process}` });
        else if (element.process === name) issues.push({ path: `${path}.process`, message: "A process can't call itself" });
        if (element.record !== undefined) {
          const info = fields.get(element.record);
          const field = info?.field;
          if (!info) issues.push({ path: `${path}.record`, message: `No field ${element.record}` });
          else if (field?.type !== 'reference') issues.push({ path: `${path}.record`, message: `${element.record} doesn't refer to a record` });
          else if (field.multiple) issues.push({ path: `${path}.record`, message: `${element.record} holds several records: a call runs on one` });
          else if (called && called.entity !== field.entity) {
            issues.push({ path: `${path}.record`, message: `${element.record} refers to ${field.entity}, but ${called.label} is about ${called.entity}` });
          }
        } else if (element.each) {
          // For each record that refers to this one: a reference field of the called process's entity.
          const field = called ? definition.entities[called.entity]?.fields.find((candidate) => candidate.name === element.each!.field) : undefined;
          if (called && !field) issues.push({ path: `${path}.each.field`, message: `${called.entity} has no field ${element.each.field}` });
          else if (field && (field.type !== 'reference' || field.multiple || field.entity !== process.entity)) {
            issues.push({
              path: `${path}.each.field`,
              message: `${element.each.field} doesn't refer to ${process.entity}: a call runs for each record that refers to this one`,
            });
          }
        } else if (called && called.entity !== process.entity) {
          issues.push({ path: `${path}.record`, message: `${called.label} is about ${called.entity}: name the reference field whose record it runs on` });
        }
        if (element.record !== undefined && element.each)
          issues.push({ path, message: `${label(id)} runs on the record a field names, or for each record that refers to this one: one of the two` });
        if (called) {
          const start = plainStartOf(called);
          const at = start ? called.elements[start] : undefined;
          if (at?.type === 'startEvent' && at.actions.length)
            issues.push({ path: `${path}.process`, message: `${called.label} has no start event without actions, where a call starts it` });
        }
        oneOut();
        break;
      }
      case 'userTask': {
        const role = definition.roles[element.role];
        if (!role) issues.push({ path: `${path}.role`, message: `No role named ${element.role}` });
        const person = (field: string, at: string) => {
          const info = fields.get(field);
          if (!info) issues.push({ path: at, message: `No field ${field}` });
          else if (!(info.field?.type === 'user' || PERSON_FIELDS.includes(info.name)))
            issues.push({ path: at, message: `${info.name} doesn't name a person` });
        };
        if (element.assignee) {
          if ('field' in element.assignee) person(element.assignee.field, `${path}.assignee.field`);
          else person(element.assignee.managerOf, `${path}.assignee.managerOf`);
        }
        if (element.department) person(element.department.of, `${path}.department.of`);
        if (element.several) {
          const { people, decide } = element.several;
          if (element.assignee) issues.push({ path: `${path}.assignee`, message: 'Several people decide this task, so it has no one assignee' });
          if ('fields' in people) {
            for (const [index, field] of people.fields.entries()) person(field, `${path}.several.people.fields[${index}]`);
            if (new Set(people.fields).size !== people.fields.length) issues.push({ path: `${path}.several.people.fields`, message: 'Name each field once' });
          }
          if ('lineOf' in people) person(people.lineOf, `${path}.several.people.lineOf`);
          if (!('first' in decide)) {
            const names = element.outcomes.map((outcome) => outcome.name);
            if (!names.includes(decide.outcome))
              issues.push({ path: `${path}.several.decide.outcome`, message: `${label(id)} has no outcome ${decide.outcome}` });
            if (!names.includes(decide.otherwise))
              issues.push({ path: `${path}.several.decide.otherwise`, message: `${label(id)} has no outcome ${decide.otherwise}` });
            if (decide.outcome === decide.otherwise)
              issues.push({ path: `${path}.several.decide.otherwise`, message: 'The other outcome differs from the one the votes are for' });
            const most = 'fields' in people ? people.fields.length : 'lineOf' in people ? people.levels : undefined;
            if (typeof decide.count === 'number' && most !== undefined && decide.count > most) {
              issues.push({ path: `${path}.several.decide.count`, message: `${decide.count} votes are needed, but only ${most} people vote` });
            }
          }
          // No one person decides, so the outcome's action runs with the app's authority, as a service task's does.
          element.outcomes.forEach((outcome, index) => {
            const action = outcome.action ? definition.actions[outcome.action] : undefined;
            if (action && readsPrincipal(definition, action)) {
              issues.push({
                path: `${path}.outcomes[${index}].action`,
                message: `${outcome.action} reads the person who runs it, but when several people decide, it runs with no one person`,
              });
            }
          });
        }
        const seen = new Set<string>();
        element.outcomes.forEach((outcome, index) => {
          const at = `${path}.outcomes[${index}]`;
          if (seen.has(outcome.name)) issues.push({ path: `${at}.name`, message: `Another outcome is already named ${outcome.name}` });
          seen.add(outcome.name);
          if (!outcome.action) return;
          // Running an outcome's action completes the task with that outcome, so each outcome runs its own.
          if (element.outcomes.findIndex((other) => other.action === outcome.action) !== index) {
            issues.push({ path: `${at}.action`, message: `Another outcome already runs ${outcome.action}: each outcome runs an action of its own` });
          }
          const action = updateAction(outcome.action, `${at}.action`);
          // When several people decide, the action runs with the app's authority: the role need not run it.
          if (action && role && !element.several && !role.actions.includes(outcome.action)) {
            issues.push({
              path: `${at}.action`,
              message: `${role.label} can't run ${outcome.action}, so nobody who may do the task could choose ${outcome.label}`,
            });
          }
        });
        if (element.card) {
          const card = definition.cards[element.card];
          if (!card) issues.push({ path: `${path}.card`, message: `No card named ${element.card}` });
          else if (card.entity !== process.entity)
            issues.push({ path: `${path}.card`, message: `${element.card} shows ${card.entity}, not ${process.entity}` });
        }
        const named = out.filter((flowId) => process.flows[flowId]!.outcome !== undefined);
        if (named.length) {
          if (named.length !== out.length)
            issues.push({ path, message: `Every flow out of ${label(id)} follows an outcome, or one flow leads on to a gateway` });
          for (const outcome of element.outcomes) {
            const taken = named.filter((flowId) => process.flows[flowId]!.outcome === outcome.name).length;
            if (taken !== 1)
              issues.push({ path, message: taken ? `${outcome.label}: one flow follows each outcome` : `${outcome.label} leads nowhere: draw a flow for it` });
          }
        } else {
          oneOut();
        }
        break;
      }
      case 'serviceTask':
        if (Boolean(element.action) === Boolean(element.flow)) issues.push({ path, message: `${label(id)} runs an action or a flow: one of the two` });
        if (element.undo) undoAction(element.undo, process.entity, `${path}.undo`);
        if (element.action && updateAction(element.action, `${path}.action`) && readsPrincipal(definition, definition.actions[element.action]!)) {
          issues.push({ path: `${path}.action`, message: `${element.action} reads the person who runs it, but a service task runs it with no person` });
        }
        if (element.flow) {
          checkFlowRun(definition, element.flow, { entity: process.entity, person: false }, `${path}.flow`, issues);
          const ran = definition.flows?.[element.flow.flow];
          if (ran && flowWaits(ran, definition.flows))
            issues.push({ path: `${path}.flow.flow`, message: `${ran.label} waits: a process task runs a flow that runs in one go` });
        }
        oneOut();
        break;
      case 'task':
      case 'manualTask':
        oneOut();
        break;
      case 'intermediateCatchEvent':
        oneOut();
        if ([element.timer, element.message, element.link, element.condition, element.signal].filter((kind) => kind !== undefined).length !== 1) {
          issues.push({ path, message: `${label(id)} waits for a timer, a message, a condition or a signal, or is a link: one of these` });
        }
        if (element.timer) checkTimer(element.timer, path);
        if (element.condition) checkCondition(element.condition, scope, `${path}.condition`, issues);
        if (element.message) heard(element.message, `${path}.message`);
        if (element.link !== undefined) {
          if (into.length) issues.push({ path, message: `${label(id)} takes over from its throw link: no flow leads into it` });
          const same = Object.entries(process.elements).filter(
            ([other, candidate]) =>
              candidate.type === 'intermediateCatchEvent' && candidate.link === element.link && scopeOf(process, other) === scopeOf(process, id),
          );
          if (same[0]?.[0] !== id) issues.push({ path: `${path}.link`, message: `Another catch link here is already named ${element.link}` });
        }
        break;
      case 'exclusiveGateway':
      case 'complexGateway':
      case 'inclusiveGateway': {
        if (element.type === 'complexGateway' && element.waitFor > Math.max(into.length, 1)) {
          issues.push({ path: `${path}.waitFor`, message: `${label(id)} waits for ${element.waitFor} paths, but ${into.length} lead into it` });
        }
        if (!out.length) issues.push({ path, message: `${label(id)} needs a flow out` });
        const defaults = out.filter((flowId) => process.flows[flowId]!.default);
        if (defaults.length > 1) issues.push({ path, message: `${label(id)} has one default flow at most` });
        if (out.length > 1) {
          for (const flowId of out) {
            const flow = process.flows[flowId]!;
            if (!flow.default && !flow.when)
              issues.push({ path: `${base}.flows.${flowId}`, message: `A flow out of ${label(id)} needs a condition, or must be its default` });
          }
        }
        break;
      }
      case 'parallelGateway':
        if (!out.length) issues.push({ path, message: `${label(id)} needs a flow out` });
        break;
      case 'eventBasedGateway': {
        if (out.length < 2) issues.push({ path, message: `${label(id)} waits for the first of the events after it: draw flows to at least two` });
        for (const flowId of out) {
          const target = process.flows[flowId]!.to;
          const event = process.elements[target];
          const waits = (event?.type === 'intermediateCatchEvent' && event.link === undefined) || event?.type === 'receiveTask';
          if (!waits)
            issues.push({
              path: `${base}.flows.${flowId}`,
              message: `${label(target)} doesn't wait: after ${label(id)} come events that wait for a timer, a message, a condition or a signal, or receive tasks`,
            });
          else if ((graph.incoming.get(target) ?? []).length !== 1)
            issues.push({ path: `${base}.elements.${target}`, message: `${label(target)} waits after ${label(id)} only: no other flow leads into it` });
        }
        break;
      }
      case 'boundaryEvent': {
        const host = process.elements[element.attachedTo];
        const kinds = [element.timer, element.message, element.error, element.condition, element.escalation, element.cancel, element.signal].filter(
          Boolean,
        ).length;
        if (kinds !== 1)
          issues.push({ path, message: `${label(id)} is a timer, a message, a condition, a signal, an error, an escalation or a cancel: one of these` });
        if (element.condition) checkCondition(element.condition, scope, `${path}.condition`, issues);
        if (!host) issues.push({ path: `${path}.attachedTo`, message: `No element ${element.attachedTo}` });
        else if (element.escalation) {
          if (host.type !== 'subProcess' && host.type !== 'callActivity') {
            issues.push({
              path: `${path}.attachedTo`,
              message: `${label(element.attachedTo)} can't hear an escalation: an escalation event sits on a sub-process or a call, for what escalates inside it`,
            });
          }
        } else if (element.cancel) {
          if (host.type !== 'subProcess' || !host.transaction)
            issues.push({ path: `${path}.attachedTo`, message: `${label(element.attachedTo)} isn't a transaction: a cancel event sits on a transaction` });
          if (!element.interrupting) issues.push({ path: `${path}.interrupting`, message: 'A cancel always ends the transaction' });
        } else if (element.error) {
          if (!['serviceTask', 'scriptTask', 'sendTask', 'subProcess', 'callActivity'].includes(host.type)) {
            issues.push({
              path: `${path}.attachedTo`,
              message: `${label(element.attachedTo)} can't catch an error: an error sits on a task that changes a record, which can fail, or on a sub-process or a call, for what fails inside it`,
            });
          } else if (host.type !== 'subProcess' && host.type !== 'callActivity' && raisedCode(element.error) !== undefined) {
            // A task's failure has no code: only an error end event inside a sub-process or a called process raises one.
            issues.push({
              path: `${path}.error`,
              message: `${label(id)} catches only the error ${raisedCode(element.error)}, but a task that fails raises no code: leave the code out`,
            });
          }
          if (!element.interrupting) issues.push({ path: `${path}.interrupting`, message: 'An error always ends what it sits on' });
          // One error event for each code, and one for any.
          const same = (graph.boundaries.get(element.attachedTo) ?? []).filter((other) => {
            const candidate = process.elements[other];
            return candidate?.type === 'boundaryEvent' && candidate.error !== undefined && raisedCode(candidate.error) === raisedCode(element.error);
          });
          if (same[0] !== id && same.includes(id)) issues.push({ path, message: `${label(element.attachedTo)} has one error event for each code at most` });
        } else if (!['userTask', 'receiveTask', 'subProcess', 'callActivity'].includes(host.type)) {
          issues.push({
            path: `${path}.attachedTo`,
            message: `${label(element.attachedTo)} can't have a timer, a message, a condition or a signal on its boundary: they sit on a user task, a receive task, a sub-process or a call activity`,
          });
        }
        if (element.timer) checkTimer(element.timer, path);
        if (element.message) {
          const action = element.message.action;
          heard(element.message, `${path}.message`);
          if (host?.type === 'userTask' && host.outcomes.some((outcome) => outcome.action === action)) {
            issues.push({ path: `${path}.message.action`, message: `${action} decides ${label(element.attachedTo)}, so it can't also interrupt it` });
          }
          if (host?.type === 'subProcess') {
            const decides = [...insideOf(process, element.attachedTo)].find((inner) => {
              const task = process.elements[inner];
              return task?.type === 'userTask' && task.outcomes.some((outcome) => outcome.action === action);
            });
            if (decides)
              issues.push({
                path: `${path}.message.action`,
                message: `${action} decides ${label(decides)} inside ${label(element.attachedTo)}, so it can't also interrupt it`,
              });
          }
        }
        oneOut();
        break;
      }
    }
  }
  if (!starts) issues.push({ path: `${base}.elements`, message: 'A process needs a start event' });
  if (!ends) issues.push({ path: `${base}.elements`, message: 'A process needs an end event' });

  // Every element can be reached from a start event: a boundary event, once its task can; what is in a sub-process, once the sub-process can.
  const reached = new Set<string>();
  // An event sub-process is reached where its scope is: it needs no flow.
  const queue = [...startEventsOf(process), ...eventSubsIn(process, undefined).map((sub) => sub.id)];
  while (queue.length) {
    const id = queue.pop()!;
    if (reached.has(id)) continue;
    reached.add(id);
    for (const flowId of graph.outgoing.get(id) ?? []) queue.push(process.flows[flowId]!.to);
    for (const boundary of graph.boundaries.get(id) ?? []) queue.push(boundary);
    if (process.elements[id]?.type === 'subProcess')
      queue.push(
        ...startEventsOf(process, id),
        ...eventSubsIn(process, id).map((sub) => sub.id),
        ...(isAdHoc(process, id) ? adHocStarts(process, graph, id) : []),
      );
    const jump = linkTarget(process, id);
    if (jump !== undefined) queue.push(jump);
  }
  for (const [id, element] of Object.entries(process.elements)) {
    const flagged = element.type !== 'startEvent' && element.type !== 'boundaryEvent' && !(graph.incoming.get(id) ?? []).length;
    if (!reached.has(id) && !flagged) issues.push({ path: `${base}.elements.${id}`, message: `${label(id)} can't be reached from a start event` });
  }

  for (const id of Object.keys(process.diagram?.shapes ?? {})) {
    if (!process.elements[id]) issues.push({ path: `${base}.diagram.shapes.${id}`, message: `No element ${id}` });
  }
  for (const id of Object.keys(process.diagram?.edges ?? {})) {
    if (!process.flows[id]) issues.push({ path: `${base}.diagram.edges.${id}`, message: `No flow ${id}` });
  }
}

/**
 * Check the app's processes (design §6.10): each is about records of a real entity; its flows join
 * elements that exist, in the directions BPMN 2.0 allows; each element has the flows it needs;
 * tasks name roles, actions, outcomes and cards that exist and fit; conditions read the record and
 * the tasks' outcomes; and every element can be reached from a start event.
 */
export function checkProcesses(definition: StoredDefinition, issues: Issue[]): void {
  const owners = lineOwners(definition);
  for (const [name, process] of Object.entries(definition.processes ?? {})) checkProcess(definition, name, process, issues, owners);
  for (const [roleName, role] of Object.entries(definition.roles)) {
    (role.processes ?? []).forEach((process, index) => {
      if (!definition.processes?.[process]) issues.push({ path: `roles.${roleName}.processes[${index}]`, message: `No process named ${process}` });
    });
  }
  checkCalls(definition, issues);
}

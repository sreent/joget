import { describe, expect, it } from 'vitest';
import { LEAVE_APP, validateDefinition } from '@platform/app-model';
import type { Definition } from '../types.js';
import { normalize, removeField } from './edit.js';
import { removeItem } from './logic.js';
import {
  addBoundary,
  addElement,
  arrange,
  callChoices,
  connect,
  durationOf,
  durationParts,
  durationWords,
  issuesByPart,
  messageChoices,
  moveElement,
  newProcess,
  removeElement,
  updateElement,
} from './processes.js';

const app = () => normalize(structuredClone(LEAVE_APP) as unknown as Definition);
const valid = (definition: Definition) => {
  const result = validateDefinition(definition);
  return result.ok ? [] : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
};
const leave = (definition: Definition) => definition.processes!['leave_approval']!;

describe('editing a process', () => {
  it('starts a process that passes the checks, and adds a task on its path', () => {
    let { definition, name } = newProcess(app(), 'Leave review', 'leave_request');
    expect(name).toBe('leave_review');
    expect(valid(definition)).toEqual([]);
    const added = addElement(definition, name, 'userTask', { after: 'start' });
    definition = added.definition;
    const process = definition.processes![name]!;
    expect(added.id).toBe('task_1');
    expect(process.elements['task_1']).toMatchObject({ type: 'userTask', role: 'employee', outcomes: [{ name: 'done' }] });
    expect(Object.values(process.flows).map((flow) => [flow.from, flow.to])).toEqual([
      ['start', 'task_1'],
      ['task_1', 'end'],
    ]);
    // What came after moved right, to make room.
    expect(process.diagram!.shapes['end']!.x).toBeGreaterThan(process.diagram!.shapes['task_1']!.x);
    expect(valid(definition)).toEqual([]);
  });

  it('gives each flow out of a task an outcome, and a second flow out of a decision is its default', () => {
    let definition = app();
    const decision = addElement(definition, 'leave_approval', 'exclusiveGateway', { on: 'on_approve' });
    expect(decision.id).toBe('decision_1');
    definition = decision.definition;
    expect(leave(definition).flows['on_approve']).toMatchObject({ from: 'decide', to: 'decision_1', outcome: 'approve' });
    const joined = connect(definition, 'leave_approval', 'decision_1', 'rejected')!;
    definition = joined.definition;
    expect(leave(definition).flows[joined.id]).toEqual({ from: 'decision_1', to: 'rejected', default: true });
    expect(connect(definition, 'leave_approval', 'approved', 'decide')).toBeNull();
    expect(connect(definition, 'leave_approval', 'decision_1', 'rejected')).toBeNull();
  });

  it('joins the path up again around an element that goes, with the flow that led to it', () => {
    let definition = addElement(app(), 'leave_approval', 'serviceTask', { on: 'on_approve' }).definition;
    expect(leave(definition).flows['on_approve']!.to).toBe('system_1');
    definition = removeElement(definition, 'leave_approval', 'system_1');
    expect(leave(definition).flows['on_approve']).toMatchObject({ from: 'decide', to: 'approved', outcome: 'approve' });
    expect(Object.keys(leave(definition).elements)).not.toContain('system_1');
    expect(valid(definition)).toEqual([]);
  });

  it('adds a deadline with a path for when it passes, which moves with its task', () => {
    const added = addBoundary(app(), 'leave_approval', 'decide', 'timer');
    let definition = added.definition;
    expect(leave(definition).elements[added.id]).toEqual({ type: 'boundaryEvent', name: 'Deadline', attachedTo: 'decide', interrupting: true, timer: { duration: 'P3D' } });
    expect(valid(definition)).toEqual([]);
    const before = leave(definition).diagram!.shapes[added.id]!;
    definition = moveElement(definition, 'leave_approval', 'decide', { x: 300, y: 200 });
    const after = leave(definition).diagram!.shapes[added.id]!;
    expect([after.x - before.x, after.y - before.y]).toEqual([300 - 250, 200 - 80]);
    expect(valid(arrange(definition, 'leave_approval'))).toEqual([]);
  });

  it('adds a message and an error event, on the tasks that suit them, with paths that pass the checks', () => {
    let definition = app();
    // Both update actions decide the task, so neither can interrupt it.
    expect(messageChoices(definition, leave(definition), 'decide')).toEqual([]);
    expect(addBoundary(definition, 'leave_approval', 'decide', 'message').id).toBe('');
    definition = {
      ...definition,
      actions: { ...definition.actions, withdraw_leave: { label: 'Withdraw', description: 'Withdraw the request.', entity: 'leave_request', operation: 'update', input: [], set: { status: 'rejected' }, confirm: 'none' } },
    };
    const message = addBoundary(definition, 'leave_approval', 'decide', 'message');
    definition = message.definition;
    expect(leave(definition).elements[message.id]).toEqual({ type: 'boundaryEvent', name: 'Withdraw', attachedTo: 'decide', interrupting: true, message: { action: 'withdraw_leave' } });
    expect(messageChoices(definition, leave(definition), 'decide')).toEqual([]);
    expect(valid(definition)).toEqual([]);

    // An error sits on a system task, not on a user task.
    expect(addBoundary(definition, 'leave_approval', 'decide', 'error').id).toBe('');
    const system = addElement(definition, 'leave_approval', 'serviceTask', { on: 'on_reject' });
    definition = updateElement(system.definition, 'leave_approval', system.id, (element) => ({ ...element, action: 'withdraw_leave' }));
    const error = addBoundary(definition, 'leave_approval', system.id, 'error');
    definition = error.definition;
    expect(leave(definition).elements[error.id]).toEqual({ type: 'boundaryEvent', name: 'Error', attachedTo: system.id, interrupting: true, error: true });
    expect(valid(definition)).toEqual([]);
    // The events go with their tasks.
    definition = removeElement(removeElement(definition, 'leave_approval', system.id), 'leave_approval', 'decide');
    expect(Object.keys(leave(definition).elements)).not.toContain(message.id);
    expect(Object.keys(leave(definition).elements)).not.toContain(error.id);
  });

  it('adds an inclusive gateway, whose second flow out is its default, and an event that waits for an action', () => {
    let definition = app();
    const gateway = addElement(definition, 'leave_approval', 'inclusiveGateway', { on: 'on_approve' });
    expect(gateway.id).toBe('inclusive_1');
    definition = gateway.definition;
    expect(leave(definition).elements[gateway.id]).toEqual({ type: 'inclusiveGateway' });
    // What stood after the flow moved right, to make room.
    const shapes = leave(definition).diagram!.shapes;
    expect(shapes['approved']!.x - (shapes[gateway.id]!.x + 50)).toBeGreaterThanOrEqual(50);
    expect(shapes[gateway.id]!.x - (shapes['decide']!.x + 100)).toBeGreaterThanOrEqual(50);
    const joined = connect(definition, 'leave_approval', gateway.id, 'rejected')!;
    definition = joined.definition;
    expect(leave(definition).flows[joined.id]).toEqual({ from: gateway.id, to: 'rejected', default: true });
    const wait = addElement(definition, 'leave_approval', 'messageEvent', { on: 'on_reject' });
    expect(leave(wait.definition).elements[wait.id]).toEqual({ type: 'intermediateCatchEvent', name: 'Approve the leave', message: { action: 'approve_leave' } });
  });

  it('adds a sub-process on a flow, with its own start and end, and adds inside it on its flows', () => {
    const sub = addElement(app(), 'leave_approval', 'subProcess', { on: 'on_approve' });
    expect(sub.id).toBe('sub_1');
    let definition = sub.definition;
    let process = leave(definition);
    expect(process.flows['on_approve']!.to).toBe('sub_1');
    const inner = Object.entries(process.elements).filter(([, element]) => element.type !== 'boundaryEvent' && element.in === 'sub_1');
    expect(inner.map(([id, element]) => [id, element.type])).toEqual([
      ['start_1', 'startEvent'],
      ['end_1', 'endEvent'],
    ]);
    expect(valid(definition)).toEqual([]);

    // On the flow inside it, a task goes inside it, and the sub-process grows to hold it.
    const innerFlow = Object.entries(process.flows).find(([, flow]) => flow.from === 'start_1')![0];
    const before = process.diagram!.shapes['sub_1']!;
    const task = addElement(definition, 'leave_approval', 'manualTask', { on: innerFlow });
    definition = task.definition;
    process = leave(definition);
    expect(process.elements[task.id]).toMatchObject({ type: 'manualTask', in: 'sub_1' });
    const [box, shape] = [process.diagram!.shapes['sub_1']!, process.diagram!.shapes[task.id]!];
    expect(box.width).toBeGreaterThanOrEqual(before.width);
    expect(shape.x).toBeGreaterThan(box.x);
    expect(shape.x + shape.width).toBeLessThan(box.x + box.width);
    expect(valid(definition)).toEqual([]);

    // A flow can't cross its edge.
    expect(connect(definition, 'leave_approval', task.id, 'approved')).toBeNull();

    // Moving it moves what it holds; removing it removes what it holds, and the path joins up again.
    const moved = moveElement(definition, 'leave_approval', 'sub_1', { x: box.x + 40, y: box.y + 10 });
    expect(leave(moved).diagram!.shapes[task.id]).toMatchObject({ x: shape.x + 40, y: shape.y + 10 });
    const removed = removeElement(definition, 'leave_approval', 'sub_1');
    expect(Object.keys(leave(removed).elements).sort()).toEqual(['approved', 'decide', 'rejected', 'requested']);
    expect(leave(removed).flows['on_approve']!.to).toBe('approved');
    expect(valid(removed)).toEqual([]);
  });

  it('puts deadlines, messages and errors on a sub-process, and calls another process of the app', () => {
    let definition = addElement(app(), 'leave_approval', 'subProcess', { on: 'on_approve' }).definition;
    definition = addBoundary(definition, 'leave_approval', 'sub_1', 'timer').definition;
    definition = addBoundary(definition, 'leave_approval', 'sub_1', 'error').definition;
    expect(valid(definition)).toEqual([]);
    const process = leave(definition);
    expect(Object.values(process.elements).filter((element) => element.type === 'boundaryEvent' && element.attachedTo === 'sub_1').map((element) => element.type === 'boundaryEvent' && (element.timer ? 'timer' : 'error'))).toEqual(['timer', 'error']);

    expect(callChoices(definition, 'leave_approval')).toEqual([]);
    const second = newProcess(definition, 'Second look', 'leave_request');
    definition = second.definition;
    expect(callChoices(definition, 'leave_approval')).toEqual([{ process: 'second_look', label: 'Second look' }]);
    const call = addElement(definition, 'leave_approval', 'callActivity', { on: 'on_reject' });
    expect(leave(call.definition).elements[call.id]).toEqual({ type: 'callActivity', name: 'Second look', process: 'second_look' });
    expect(valid(call.definition)).toEqual([]);
  });

  it('lets go of an action or a field that the app no longer has', () => {
    const withoutReject = removeItem(app(), 'actions', 'reject_leave');
    expect((leave(withoutReject).elements['decide'] as { outcomes: unknown[] }).outcomes).toEqual([
      { name: 'approve', label: 'Approve', action: 'approve_leave' },
      { name: 'reject', label: 'Reject' },
    ]);
    const fields = app().entities['leave_request']!.fields;
    const withoutManager = removeField(app(), 'leave_request', fields.findIndex((field) => field.name === 'manager'));
    expect(leave(withoutManager).elements['decide']).not.toHaveProperty('assignee');
  });

  it('drops the outcome of a flow whose outcome goes', () => {
    const definition = updateElement(app(), 'leave_approval', 'decide', (element) =>
      element.type === 'userTask' ? { ...element, outcomes: element.outcomes.filter((outcome) => outcome.name !== 'reject') } : element,
    );
    expect(leave(definition).flows['on_reject']).toEqual({ from: 'decide', to: 'rejected', name: 'Rejected' });
  });

  it('reads the issues of a process by element and flow', () => {
    const found = issuesByPart(
      [
        { path: 'processes.leave_approval.elements.decide.outcomes[1].action', message: 'a' },
        { path: 'processes.leave_approval.flows.on_reject', message: 'b' },
        { path: 'processes.leave_approval.elements', message: 'c' },
        { path: 'processes.other.elements.x', message: 'd' },
      ],
      'leave_approval',
    );
    expect([...found]).toEqual([
      ['decide', ['a']],
      ['on_reject', ['b']],
      ['', ['c']],
    ]);
  });
});

describe('durations', () => {
  it('read and write the ones a builder sets with a number and a unit', () => {
    expect(durationParts('P3D')).toEqual({ amount: 3, unit: 'days' });
    expect(durationParts('PT4H')).toEqual({ amount: 4, unit: 'hours' });
    expect(durationParts('P2W')).toEqual({ amount: 2, unit: 'weeks' });
    expect(durationParts('P1DT2H')).toBeNull();
    expect(durationOf(5, 'days')).toBe('P5D');
    expect(durationOf(0, 'hours')).toBe('PT1H');
    expect(durationWords('P1D')).toBe('1 day');
    expect(durationWords('P1DT2H')).toBe('P1DT2H');
  });
});

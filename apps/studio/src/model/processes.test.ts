import { describe, expect, it } from 'vitest';
import { LEAVE_APP, validateDefinition } from '@platform/app-model';
import type { Definition } from '../types.js';
import { normalize, removeField } from './edit.js';
import { removeItem } from './logic.js';
import {
  addDeadline,
  addElement,
  arrange,
  connect,
  durationOf,
  durationParts,
  durationWords,
  issuesByPart,
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
    const added = addDeadline(app(), 'leave_approval', 'decide');
    let definition = added.definition;
    expect(leave(definition).elements[added.id]).toEqual({ type: 'boundaryEvent', name: 'Deadline', attachedTo: 'decide', interrupting: true, timer: { duration: 'P3D' } });
    expect(valid(definition)).toEqual([]);
    const before = leave(definition).diagram!.shapes[added.id]!;
    definition = moveElement(definition, 'leave_approval', 'decide', { x: 300, y: 200 });
    const after = leave(definition).diagram!.shapes[added.id]!;
    expect([after.x - before.x, after.y - before.y]).toEqual([300 - 250, 200 - 80]);
    expect(valid(arrange(definition, 'leave_approval'))).toEqual([]);
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

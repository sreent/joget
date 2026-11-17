import { describe, expect, it } from 'vitest';
import {
  bpmnToProcesses,
  conditionText,
  LEAVE_APP,
  layoutProcess,
  parseConditionText,
  parseXml,
  processToBpmn,
  textOf,
  validateDefinition,
  XmlError,
  type StoredDefinition,
} from '@platform/app-model';

const ids = () => {
  let n = 0;
  return () => `id${String(++n).padStart(4, '0')}`;
};

function valid(input: unknown): StoredDefinition {
  const result = validateDefinition(input, undefined, ids());
  if (!result.ok) throw new Error(JSON.stringify(result.issues, null, 2));
  return result.definition;
}

const leave = valid(LEAVE_APP);

describe('the XML reader', () => {
  it('resolves namespaces, entities and CDATA', () => {
    const root = parseXml(`<?xml version="1.0"?>
      <!-- a comment -->
      <a:root xmlns:a="urn:a" xmlns="urn:default" a:x="1 &amp; 2" y='&#65;&#x42;'>
        <child>&lt;tag&gt; <![CDATA[<raw & text>]]></child>
      </a:root>`);
    expect(root).toMatchObject({ ns: 'urn:a', local: 'root', attributes: [{ ns: 'urn:a', local: 'x', value: '1 & 2' }, { ns: null, local: 'y', value: 'AB' }] });
    const child = root.children.find((node) => typeof node !== 'string');
    expect(child).toMatchObject({ ns: 'urn:default', local: 'child' });
    expect(textOf(child as never)).toBe('<tag> <raw & text>');
  });

  it('refuses a DOCTYPE, unknown entities and broken structure', () => {
    for (const text of [
      '<!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>',
      '<x>&nbsp;</x>',
      '<x><y></x></y>',
      '<p:x/>',
      '<x a="1" a="2"/>',
      '<x/><y/>',
      '<x>',
    ]) {
      expect(() => parseXml(text), text).toThrow(XmlError);
    }
  });
});

describe('conditions as text', () => {
  it('write and read back every kind of condition', () => {
    const condition = {
      any: [
        { all: [{ gt: [{ ref: 'record.days' }, 10] }, { eq: [{ ref: 'record.kind' }, 'annual'] }] },
        { not: { exists: 'record.reason' } },
        { in: [{ ref: 'record.kind' }, ['sick', 'unpaid']] },
        { ne: [{ ref: 'tasks.decide.outcome' }, 'reject'] },
      ],
    } as const;
    const text = conditionText(condition);
    expect(text).toBe('record.days > 10 && record.kind == "annual" || !(has(record.reason)) || record.kind in ["sick", "unpaid"] || tasks.decide.outcome != "reject"');
    expect(parseConditionText(text)).toEqual({ ok: true, condition });
  });

  it("read another tool's simple conditions, with names as the record's fields", () => {
    const fields = (name: string) => (['days', 'kind', 'urgent'].includes(name) ? `record.${name}` : undefined);
    expect(parseConditionText("${days > 10 and kind = 'annual'}", fields)).toEqual({
      ok: true,
      condition: { all: [{ gt: [{ ref: 'record.days' }, 10] }, { eq: [{ ref: 'record.kind' }, 'annual'] }] },
    });
    expect(parseConditionText('#{urgent}', fields)).toEqual({ ok: true, condition: { eq: [{ ref: 'record.urgent' }, true] } });
    expect(parseConditionText('${amount > 10}', fields)).toEqual({ ok: false, message: 'Unknown name amount' });
    expect(parseConditionText('days > "ten"', fields)).toEqual({ ok: false, message: '> compares numbers' });
    expect(parseConditionText('days >', fields).ok).toBe(false);
  });
});

describe('BPMN 2.0 files', () => {
  it('carry a process out and back exactly, with its diagram', () => {
    const xml = processToBpmn(leave, 'leave_approval');
    expect(xml).toContain('<bpmn:process id="leave_approval" name="Leave approval" isExecutable="true" ambit:entity="leave_request">');
    expect(xml).toContain('<bpmn:userTask id="decide" name="Decide on the leave" ambit:role="manager" ambit:assignee="manager" ambit:due="P3D" ambit:card="leave_review">');
    expect(xml).toContain('<ambit:outcome name="approve" label="Approve" action="approve_leave" />');
    expect(xml).toContain('<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression" language="urn:ambit:outcome">reject</bpmn:conditionExpression>');
    expect(xml).toContain('<bpmndi:BPMNShape id="decide_di" bpmnElement="decide">');
    const back = bpmnToProcesses(xml, { ...leave, processes: {} });
    expect(back).toEqual({ ok: true, processes: { leave_approval: leave.processes!['leave_approval'] }, notes: [] });
  });

  it('carry routing by the directory out and back', () => {
    const routed = valid({
      ...LEAVE_APP,
      processes: {
        leave_approval: {
          ...LEAVE_APP.processes.leave_approval,
          elements: { ...LEAVE_APP.processes.leave_approval.elements, decide: { ...LEAVE_APP.processes.leave_approval.elements.decide, assignee: { managerOf: 'owner', levels: 2 }, department: { of: 'owner' } } },
        },
      },
    });
    const xml = processToBpmn(routed, 'leave_approval');
    expect(xml).toContain('ambit:managerOf="owner" ambit:levels="2" ambit:department="owner"');
    const back = bpmnToProcesses(xml, { ...routed, processes: {} });
    expect(back.ok && back.processes['leave_approval']!.elements['decide']).toMatchObject({ assignee: { managerOf: 'owner', levels: 2 }, department: { of: 'owner' } });
  });

  it('carry a task that several people decide out and back, as a multi-instance task', () => {
    const voted = valid({
      ...LEAVE_APP,
      actions: {
        ...LEAVE_APP.actions,
        mark_approved: { label: 'Mark approved', description: 'Record that the leave is approved.', entity: 'leave_request', operation: 'update', input: [], set: { status: 'approved' } },
      },
      processes: {
        leave_approval: {
          ...LEAVE_APP.processes.leave_approval,
          elements: {
            ...LEAVE_APP.processes.leave_approval.elements,
            decide: {
              type: 'userTask',
              name: 'The line decides',
              role: 'manager',
              outcomes: [
                { name: 'approve', label: 'Approve', action: 'mark_approved' },
                { name: 'reject', label: 'Reject' },
              ],
              several: { people: { lineOf: 'owner', levels: 2 }, sequential: true, decide: { count: 'all', outcome: 'approve', otherwise: 'reject' } },
            },
          },
        },
      },
    });
    const xml = processToBpmn(voted, 'leave_approval');
    expect(xml).toContain('<bpmn:multiInstanceLoopCharacteristics isSequential="true" ambit:lineOf="owner" ambit:levels="2" ambit:count="all" ambit:outcome="approve" ambit:otherwise="reject" />');
    const back = bpmnToProcesses(xml, { ...voted, processes: {} });
    expect(back.ok && back.processes['leave_approval']).toEqual(voted.processes!['leave_approval']);
  });

  it('carry messages, errors and inclusive gateways out and back', () => {
    const definition = valid({
      ...LEAVE_APP,
      actions: {
        ...LEAVE_APP.actions,
        withdraw_leave: { label: 'Withdraw', description: 'Withdraw a leave request.', entity: 'leave_request', operation: 'update', input: [], set: { status: 'rejected' } },
        tell_payroll: { label: 'Tell payroll', description: 'Mark it known to payroll.', entity: 'leave_request', operation: 'update', input: [], set: { reason: 'Payroll knows' } },
      },
      processes: {
        leave_approval: {
          label: 'Leave approval',
          entity: 'leave_request',
          elements: {
            start: { type: 'startEvent', actions: ['request_leave'] },
            who: { type: 'inclusiveGateway', name: 'Who hears?' },
            pay: { type: 'serviceTask', name: 'Tell payroll', action: 'tell_payroll' },
            failed: { type: 'boundaryEvent', attachedTo: 'pay', error: true },
            wait: { type: 'intermediateCatchEvent', name: 'Until withdrawn', message: { action: 'withdraw_leave' } },
            join: { type: 'inclusiveGateway' },
            end: { type: 'endEvent' },
          },
          flows: {
            f1: { from: 'start', to: 'who' },
            f2: { from: 'who', to: 'pay', when: { gt: [{ ref: 'record.days' }, 5] } },
            f3: { from: 'who', to: 'wait', default: true },
            f4: { from: 'pay', to: 'join' },
            f5: { from: 'failed', to: 'join' },
            f6: { from: 'wait', to: 'join' },
            f7: { from: 'join', to: 'end' },
          },
        },
      },
    });
    const xml = processToBpmn(definition, 'leave_approval');
    expect(xml).toContain('<bpmn:message id="Message_withdraw_leave" name="withdraw_leave" ambit:action="withdraw_leave" />');
    expect(xml).toContain('<bpmn:messageEventDefinition id="wait_message" messageRef="Message_withdraw_leave" />');
    expect(xml).toContain('<bpmn:errorEventDefinition id="failed_error" />');
    expect(xml).toContain('<bpmn:inclusiveGateway id="who" name="Who hears?" default="f3">');
    const back = bpmnToProcesses(xml, { ...definition, processes: {} });
    const { diagram: _diagram, ...process } = back.ok ? back.processes['leave_approval']! : ({} as never);
    expect(process).toEqual(definition.processes!['leave_approval']);
  });

  it('lay out a process drawn without a diagram, so other tools can show it', () => {
    const bare = { ...leave.processes!['leave_approval']!, diagram: undefined };
    const layout = layoutProcess(bare);
    expect(Object.keys(layout.shapes).sort()).toEqual(['approved', 'decide', 'rejected', 'requested']);
    expect(layout.shapes['requested']!.x).toBeLessThan(layout.shapes['decide']!.x);
    expect(layout.edges['on_reject']!.points.length).toBeGreaterThanOrEqual(2);
    const xml = processToBpmn({ ...leave, processes: { leave_approval: bare } }, 'leave_approval');
    const back = bpmnToProcesses(xml, { ...leave, processes: {} });
    expect(back.ok && back.processes['leave_approval']!.diagram).toEqual(layout);
  });

  it("read a model from another tool: lanes choose roles, and simple conditions are read as the record's", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
    xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn2:collaboration id="Collaboration_1">
    <bpmn2:participant id="Participant_1" name="Leave" processRef="Process_Leave" />
    <bpmn2:participant id="Participant_2" name="Payroll" />
    <bpmn2:messageFlow id="Flow_msg" sourceRef="Participant_1" targetRef="Participant_2" />
  </bpmn2:collaboration>
  <bpmn2:process id="Process_Leave" name="Leave, from Camunda" isExecutable="true">
    <bpmn2:laneSet id="LaneSet_1">
      <bpmn2:lane id="Lane_1" name="Manager"><bpmn2:flowNodeRef>Task_Decide</bpmn2:flowNodeRef></bpmn2:lane>
    </bpmn2:laneSet>
    <bpmn2:startEvent id="Start_1" name="Requested" />
    <bpmn2:exclusiveGateway id="Gateway_Long" name="Long?" default="Flow_Short" />
    <bpmn2:userTask id="Task_Decide" name="Decide" />
    <bpmn2:endEvent id="End_1" />
    <bpmn2:textAnnotation id="Note_1"><bpmn2:text>Ask HR first</bpmn2:text></bpmn2:textAnnotation>
    <bpmn2:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Gateway_Long" />
    <bpmn2:sequenceFlow id="Flow_Long" name="Long" sourceRef="Gateway_Long" targetRef="Task_Decide">
      <bpmn2:conditionExpression>\${days &gt; 10}</bpmn2:conditionExpression>
    </bpmn2:sequenceFlow>
    <bpmn2:sequenceFlow id="Flow_Short" sourceRef="Gateway_Long" targetRef="End_1" />
    <bpmn2:sequenceFlow id="Flow_2" sourceRef="Task_Decide" targetRef="End_1" />
  </bpmn2:process>
  <bpmndi:BPMNDiagram id="Diagram_1">
    <bpmndi:BPMNPlane id="Plane_1" bpmnElement="Collaboration_1">
      <bpmndi:BPMNShape id="Start_1_di" bpmnElement="Start_1"><dc:Bounds x="152" y="102" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Note_1_di" bpmnElement="Note_1"><dc:Bounds x="400" y="10" width="100" height="30" /></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1"><di:waypoint x="188" y="120" /><di:waypoint x="245" y="120" /></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn2:definitions>`;
    const read = bpmnToProcesses(xml, leave, { entity: 'leave_request' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const process = read.processes['process_leave']!;
    expect(process).toMatchObject({
      label: 'Leave, from Camunda',
      entity: 'leave_request',
      elements: { Task_Decide: { type: 'userTask', role: 'manager', outcomes: [{ name: 'done', label: 'Done' }] }, Gateway_Long: { type: 'exclusiveGateway', name: 'Long?' } },
      flows: { Flow_Long: { when: { gt: [{ ref: 'record.days' }, 10] } }, Flow_Short: { default: true } },
      diagram: { shapes: { Start_1: { x: 152, y: 102, width: 36, height: 36 } }, edges: { Flow_1: { points: [{ x: 188, y: 120 }, { x: 245, y: 120 }] } } },
    });
    expect(Object.keys(process.diagram!.shapes)).toEqual(['Start_1']);
    expect(read.notes).toEqual([
      'Left out the pool "Payroll" (Participant_2): it has no process of its own',
      'Left out the message flows between pools: messages between participants are not run yet',
      'Left out the lanes; a lane named after a role gave its tasks that role',
      'Decide gets one outcome, Done: give a task its outcomes in Ambit',
      'Left out what only documents the model, such as textAnnotation',
      'Read the condition "${days > 10}" of "Long" (Flow_Long) as record.days > 10',
    ]);
    // What it reads passes the checks of any definition.
    expect(validateDefinition({ ...leave, processes: { ...leave.processes, ...read.processes } }, leave, ids()).ok).toBe(true);
  });

  it('refuse what Ambit cannot run, naming each element', () => {
    const xml = `<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:ambit="urn:ambit:bpmn:1">
  <process id="p" ambit:entity="leave_request">
    <startEvent id="s"><messageEventDefinition /></startEvent>
    <scriptTask id="t1" name="Compute" />
    <inclusiveGateway id="g" />
    <userTask id="u" name="Everyone decides" ambit:role="manager"><multiInstanceLoopCharacteristics /></userTask>
    <sequenceFlow id="f" sourceRef="s" targetRef="t1"><conditionExpression>amount &gt; 5</conditionExpression></sequenceFlow>
  </process>
</definitions>`;
    expect(bpmnToProcesses(xml, leave)).toEqual({
      ok: false,
      issues: [
        { element: 's', message: "Ambit doesn't start a process on a message event yet: (s)" },
        { element: 't1', message: 'Ambit doesn\'t run a script task yet: "Compute" (t1)' },
        { element: 'u', message: 'Say who votes and what decides, with Ambit\'s settings for a task that several people decide: "Everyone decides" (u)' },
        { element: 'f', message: 'Ambit can\'t read the condition "amount > 5" of (f): Unknown name amount. Write it as a condition on the record\'s fields' },
      ],
    });
    expect(bpmnToProcesses('<x/>', leave)).toEqual({ ok: false, issues: [{ element: null, message: 'Not a BPMN 2.0 file: its root is not bpmn:definitions' }] });
  });
});

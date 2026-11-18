import type { Condition } from '@platform/authz';
import { mapRefs } from './condition-refs.js';
import { type Expression, mapExpressionRefs } from './expressions.js';
import { formulaOf, type StoredDefinition } from './fields.js';
import { renameInFlows } from './flows.js';
import { canRepeat } from './processes.js';
import { LINE_PATH_PATTERN, type PageBlock, type ProcessElement, type SimpleStep, type Step } from './schema.js';

/* Renames carry through a definition: a field or an entity that keeps its ID under a new name is a rename, and
   every reference to it follows it. */

/**
 * Carry renames through. When an entity or field keeps its ID under a new name, references to
 * the old name are updated everywhere, unless something else now has the old name.
 */
export function propagateRenames(definition: StoredDefinition, previous: StoredDefinition, notes: string[]): StoredDefinition {
  const previousById = new Map(Object.entries(previous.entities).map(([name, entity]) => [entity.id, { name, entity }]));
  const entityRenames = new Map<string, string>();
  const fieldRenames = new Map<string, Map<string, string>>();
  for (const [name, entity] of Object.entries(definition.entities)) {
    const before = previousById.get(entity.id);
    if (!before) continue;
    if (before.name !== name && !(before.name in definition.entities)) entityRenames.set(before.name, name);
    const oldNames = new Map(before.entity.fields.map((field) => [field.id, field.name]));
    const current = new Set(entity.fields.map((field) => field.name));
    const renames = new Map<string, string>();
    for (const field of entity.fields) {
      const old = oldNames.get(field.id);
      if (old && old !== field.name && !current.has(old)) renames.set(old, field.name);
    }
    if (renames.size) fieldRenames.set(name, renames);
  }
  if (entityRenames.size === 0 && fieldRenames.size === 0) return definition;

  const touched = new Set<string>();
  const entityName = (name: string) => {
    const renamed = entityRenames.get(name);
    if (renamed) touched.add(`entity ${name} → ${renamed}`);
    return renamed ?? name;
  };
  const fieldName = (entity: string) => (name: string) => {
    const renamed = fieldRenames.get(entity)?.get(name);
    if (renamed) touched.add(`${entity}.${name} → ${renamed}`);
    return renamed ?? name;
  };
  /** The line entity of an entity's lines field, by their new names. */
  const lineEntityOf = (entity: string, lines: string) => {
    const field = definition.entities[entity]?.fields.find((f) => f.name === lines);
    return field?.type === 'lines' ? entityName(field.entity) : undefined;
  };
  /** A field name, or a path into lines such as `lines.amount`, after renames. */
  const pathName = (entity: string) => (name: string) => {
    const match = LINE_PATH_PATTERN.exec(name);
    if (!match) return fieldName(entity)(name);
    const lines = fieldName(entity)(match[1]!);
    const lineEntity = lineEntityOf(entity, lines);
    return `${lines}.${lineEntity ? fieldName(lineEntity)(match[2]!) : match[2]}`;
  };
  const refs = (entity: string) => (ref: string) => (ref.startsWith('record.') ? `record.${fieldName(entity)(ref.slice('record.'.length))}` : ref);
  const condition = <T extends Condition | undefined>(entity: string, c: T): T => (c ? (mapRefs(c, refs(entity)) as T) : c);
  const mapRecord = <T>(record: Readonly<Record<string, T>>, map: (value: T) => T) =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [key, map(value)]));

  const entities = Object.fromEntries(
    Object.entries(definition.entities).map(([name, entity]) => [
      name,
      {
        ...entity,
        ...(entity.titleField ? { titleField: fieldName(name)(entity.titleField) } : {}),
        fields: entity.fields.map((original) => {
          // A field required when a condition holds, and a formula, read the record's own fields, by their new names.
          const renamed = original.requiredWhen ? { ...original, requiredWhen: condition(name, original.requiredWhen) } : original;
          const formula = formulaOf(renamed);
          const field = formula ? { ...renamed, formula: mapExpressionRefs(formula, refs(name)) } : renamed;
          if (field.type === 'reference' || field.type === 'lines') return { ...field, entity: entityName(field.entity) };
          if (field.type === 'number' && field.rollup) {
            const [op, path] = Object.entries(field.rollup)[0] as [string, string];
            return { ...field, rollup: { [op]: op === 'count' ? fieldName(name)(path) : pathName(name)(path) } as typeof field.rollup };
          }
          return field;
        }),
      },
    ]),
  );
  const rules = mapRecord(definition.rules, (rule) => {
    const entity = entityName(rule.entity);
    return {
      ...rule,
      entity,
      ...(rule.when ? { when: condition(entity, rule.when) } : {}),
      assert: condition(entity, rule.assert),
      ...(rule.fields ? { fields: rule.fields.map(fieldName(entity)) } : {}),
    };
  });
  const simpleStep = (entity: string, step: SimpleStep): SimpleStep => {
    const value = (expression: Expression) => mapExpressionRefs(expression, refs(entity));
    switch (step.type) {
      case 'set':
        return { ...step, field: fieldName(entity)(step.field), value: value(step.value) };
      case 'add_line': {
        const lines = fieldName(entity)(step.field);
        const lineEntity = lineEntityOf(entity, lines);
        return {
          ...step,
          field: lines,
          values: Object.fromEntries(Object.entries(step.values).map(([name, v]) => [lineEntity ? fieldName(lineEntity)(name) : name, value(v)])),
        };
      }
      case 'check':
        return { ...step, assert: condition(entity, step.assert), ...(step.fields ? { fields: step.fields.map(fieldName(entity)) } : {}) };
    }
  };
  const step = (entity: string, s: Step): Step =>
    s.type === 'if'
      ? {
          ...s,
          when: condition(entity, s.when),
          then: s.then.map((inner) => simpleStep(entity, inner)),
          else: s.else.map((inner) => simpleStep(entity, inner)),
        }
      : simpleStep(entity, s);
  const actions = mapRecord(definition.actions, (action) => {
    const entity = entityName(action.entity);
    return {
      ...action,
      entity,
      input: action.input.map(fieldName(entity)),
      set: Object.fromEntries(Object.entries(action.set).map(([field, value]) => [fieldName(entity)(field), value])),
      ...(action.where ? { where: condition(entity, action.where) } : {}),
      ...(action.steps ? { steps: action.steps.map((s) => step(entity, s)) } : {}),
      ...(action.before ? { before: { ...action.before, input: mapRecord(action.before.input, (e) => mapExpressionRefs(e, refs(entity))) } } : {}),
      ...(action.flow ? { flow: { ...action.flow, input: mapRecord(action.flow.input, (e) => mapExpressionRefs(e, refs(entity))) } } : {}),
    };
  });
  const queries = mapRecord(definition.queries, (query) => {
    const entity = entityName(query.entity);
    return {
      ...query,
      entity,
      fields: query.fields.map(fieldName(entity)),
      ...(query.filter ? { filter: condition(entity, query.filter) } : {}),
      sort: query.sort.map((sort) => ({ ...sort, field: fieldName(entity)(sort.field) })),
      ...(query.summary
        ? {
            summary: {
              ...query.summary,
              measure: { ...query.summary.measure, ...(query.summary.measure.field ? { field: pathName(entity)(query.summary.measure.field) } : {}) },
              ...(query.summary.group ? { group: { ...query.summary.group, field: pathName(entity)(query.summary.group.field) } } : {}),
              ...(query.summary.range ? { range: { ...query.summary.range, field: pathName(entity)(query.summary.range.field) } } : {}),
            },
          }
        : {}),
    };
  });
  const cards = mapRecord(definition.cards, (card) => {
    const entity = entityName(card.entity);
    return {
      ...card,
      entity,
      show: card.show.map(fieldName(entity)),
      ...(card.table
        ? (() => {
            const of = fieldName(entity)(card.table.of);
            const lineEntity = lineEntityOf(entity, of);
            return { table: { of, columns: card.table.columns.map((column) => (lineEntity ? fieldName(lineEntity)(column) : column)) } };
          })()
        : {}),
      title: card.title.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, name: string) => `{{${fieldName(entity)(name)}}}`),
    };
  });
  const forms = mapRecord(definition.forms, (form) => {
    const entity = entityName(form.entity);
    return {
      ...form,
      entity,
      sections: form.sections.map((section) => ({
        ...section,
        fields: section.fields.map((item) => ({
          ...item,
          field: fieldName(entity)(item.field),
          ...(item.visibleWhen ? { visibleWhen: condition(entity, item.visibleWhen) } : {}),
        })),
      })),
    };
  });
  const roles = mapRecord(definition.roles, (role) => ({
    ...role,
    entities: Object.fromEntries(
      Object.entries(role.entities).map(([oldEntity, permissions]) => {
        const entity = entityName(oldEntity);
        const rename = pathName(entity);
        const access = <T>(value: T): T => {
          if (typeof value !== 'object' || value === null) return value;
          const a = value as Record<string, unknown>;
          return {
            ...a,
            ...(a['where'] ? { where: condition(entity, a['where'] as Condition) } : {}),
            ...(a['check'] ? { check: condition(entity, a['check'] as Condition) } : {}),
            ...(a['fields']
              ? {
                  fields:
                    'include' in (a['fields'] as object)
                      ? { include: (a['fields'] as { include: string[] }).include.map(rename) }
                      : { exclude: (a['fields'] as { exclude: string[] }).exclude.map(rename) },
                }
              : {}),
            ...(a['mask'] ? { mask: (a['mask'] as string[]).map(rename) } : {}),
            ...(a['unmask'] ? { unmask: (a['unmask'] as string[]).map(rename) } : {}),
          } as T;
        };
        return [entity, mapRecord(permissions as Record<string, unknown>, access)];
      }),
    ),
  }));
  /** A block, with renames of entities and fields carried through it. `about` is the entity of the record its page is about. */
  const renameBlock = <B extends PageBlock>(block: B, about: string | undefined): B => {
    // `of` names a reference field of the block's entity, which points at the page's record.
    const of = (entity: string, field: string | undefined) => (field ? { of: fieldName(entity)(field) } : {});
    if (block.type === 'stat' || block.type === 'chart') {
      const entity = entityName(block.entity);
      const path = pathName(entity);
      return {
        ...block,
        entity,
        measure: { ...block.measure, ...(block.measure.field ? { field: path(block.measure.field) } : {}) },
        ...(block.type === 'chart' ? { group: { ...block.group, field: path(block.group.field) } } : {}),
        ...(block.range ? { range: { ...block.range, field: path(block.range.field) } } : {}),
        ...(block.filter ? { filter: condition(entity, block.filter) } : {}),
        ...of(entity, block.of),
      };
    }
    if (block.type === 'fields') return about ? { ...block, fields: block.fields.map(fieldName(about)) } : block;
    if (block.type === 'tabs') return { ...block, tabs: block.tabs.map((tab) => ({ ...tab, blocks: tab.blocks.map((inner) => renameBlock(inner, about)) })) };
    if (block.type !== 'list') return block;
    const entity = entityName(block.entity);
    return {
      ...block,
      entity,
      columns: block.columns.map(fieldName(entity)),
      ...(block.filter ? { filter: condition(entity, block.filter) } : {}),
      sort: block.sort.map((sort) => ({ ...sort, field: fieldName(entity)(sort.field) })),
      ...of(entity, block.of),
    };
  };
  const pages = mapRecord(definition.pages ?? {}, (page) => {
    const about = page.record ? entityName(page.record.entity) : undefined;
    return { ...page, ...(page.record ? { record: { entity: about! } } : {}), blocks: page.blocks.map((block) => renameBlock(block, about)) };
  });
  const navigation = definition.navigation
    ? { ...definition.navigation, items: definition.navigation.items.map((item) => ('entity' in item ? { ...item, entity: entityName(item.entity) } : item)) }
    : undefined;
  const processes = definition.processes
    ? mapRecord(definition.processes, (process) => {
        const entity = entityName(process.entity);
        const field = fieldName(entity);
        return {
          ...process,
          entity,
          elements: mapRecord(process.elements, (original): ProcessElement => {
            // A message sent to another record names it by a reference field of this one.
            const sent: ProcessElement =
              'message' in original && original.message?.record
                ? { ...original, message: { ...original.message, record: field(original.message.record) } }
                : original;
            // The conditions that a loop and an ad hoc sub-process end on read the record too.
            const repeated: ProcessElement =
              canRepeat(sent) && sent.repeat ? { ...sent, repeat: { ...sent.repeat, while: condition(entity, sent.repeat.while) } } : sent;
            const element: ProcessElement =
              repeated.type === 'subProcess' && repeated.completeWhen ? { ...repeated, completeWhen: condition(entity, repeated.completeWhen) } : repeated;
            switch (element.type) {
              case 'userTask':
                return {
                  ...element,
                  ...(element.assignee
                    ? {
                        assignee:
                          'field' in element.assignee
                            ? { field: field(element.assignee.field) }
                            : { ...element.assignee, managerOf: field(element.assignee.managerOf) },
                      }
                    : {}),
                  ...(element.department ? { department: { of: field(element.department.of) } } : {}),
                  ...(element.several
                    ? {
                        several: {
                          ...element.several,
                          people:
                            'fields' in element.several.people
                              ? { fields: element.several.people.fields.map(field) }
                              : 'lineOf' in element.several.people
                                ? { ...element.several.people, lineOf: field(element.several.people.lineOf) }
                                : element.several.people,
                        },
                      }
                    : {}),
                };
              case 'startEvent':
              case 'intermediateCatchEvent':
              case 'boundaryEvent':
                return {
                  ...element,
                  ...(element.timer && 'date' in element.timer ? { timer: { ...element.timer, date: field(element.timer.date) } } : {}),
                  ...(element.condition ? { condition: condition(entity, element.condition) } : {}),
                };
              case 'callActivity': {
                // A call for each record names a field of the called process's entity.
                const called = definition.processes?.[element.process];
                const each = element.each && called ? { ...element.each, field: fieldName(entityName(called.entity))(element.each.field) } : element.each;
                return { ...element, ...(element.record ? { record: field(element.record) } : {}), ...(each ? { each } : {}) };
              }
              case 'scriptTask':
                return { ...element, steps: element.steps.map((each) => step(entity, each)) };
              case 'serviceTask':
                return element.flow
                  ? { ...element, flow: { ...element.flow, input: mapRecord(element.flow.input, (e) => mapExpressionRefs(e, refs(entity))) } }
                  : element;
              default:
                return element;
            }
          }),
          flows: mapRecord(process.flows, (flow) => (flow.when ? { ...flow, when: condition(entity, flow.when) } : flow)),
        };
      })
    : undefined;
  const flows = definition.flows ? renameInFlows({ ...definition, entities }, definition.flows, entityName, fieldName) : undefined;
  // A test names entities and fields by name too: its values follow their renames.
  const testValues = (entity: string, values: Readonly<Record<string, unknown>>) =>
    Object.fromEntries(Object.entries(values).map(([field, value]) => [fieldName(entity)(field), value]));
  const tests = definition.tests
    ? mapRecord(definition.tests, (test) => {
        const subject = entityName(definition.actions[test.when.action]?.entity ?? '');
        return {
          ...test,
          given: mapRecord(test.given, (record) => ({
            ...record,
            entity: entityName(record.entity),
            values: testValues(entityName(record.entity), record.values),
          })),
          when: { ...test.when, values: testValues(subject, test.when.values) },
          then: test.then.outcome === 'saved' ? { ...test.then, values: testValues(subject, test.then.values) } : test.then,
        };
      })
    : undefined;
  for (const change of touched) notes.push(`Updated references for the rename ${change}`);
  return {
    ...definition,
    entities,
    rules,
    actions,
    queries,
    cards,
    forms,
    roles,
    pages,
    ...(navigation ? { navigation } : {}),
    ...(processes ? { processes } : {}),
    ...(flows ? { flows } : {}),
    ...(tests ? { tests } : {}),
  } as StoredDefinition;
}

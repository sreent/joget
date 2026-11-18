import { appRoleName, covers, defaultValue, entityFields, fieldAccess, formulaOf, isComputed, lineOwners, type ChartBlock, type FieldAccess, type FieldValue, type StatBlock, type StoredDefinition, type StoredField, type TabBlock, type WriteContext } from '@platform/app-model';
import type { Condition } from '@platform/authz';
import type { PermissionGrant } from '@platform/authz';
import type { FastifyRequest } from 'fastify';
import type { AppContext, AuthContext } from '../context.js';
import type { LoadedApp } from './catalog.js';
import { recordResource } from './resources.js';
import type { AppRuntime } from './runtime.js';

/** A field as screens need it: its definition, and what the caller may do with it. */
export interface UiField {
  readonly name: string;
  readonly label: string;
  readonly type: StoredField['type'];
  readonly required: boolean;
  /** Required only while this holds, of the record's values: screens show it, and the server checks it. */
  readonly requiredWhen?: Condition;
  /** What a new record starts with, worked out for the caller now: today, or the caller, for example. */
  readonly default?: FieldValue;
  readonly description?: string;
  readonly options?: ReadonlyArray<{ value: string; label: string }>;
  readonly multiple?: boolean;
  readonly entity?: string;
  readonly decimals?: number;
  readonly maxLength?: number;
  readonly multiline?: boolean;
  /** For a file field: the kinds it takes. */
  readonly accept?: readonly string[];
  /** True for a number worked out from lines: shown, never entered. */
  readonly computed?: boolean;
  /** How it is worked out, such as `{ sum: 'lines.amount' }`, so screens can show it while people type. */
  readonly rollup?: Readonly<Record<string, string>>;
  /** Its formula, worked out from the record's other fields. */
  readonly formula?: unknown;
  /** For a lines field: the most lines, what a line is called and named by, and its fields, with what the caller may do with them. */
  readonly lines?: { readonly max: number; readonly label: string; readonly titleField: string | null; readonly fields: UiField[] };
  /** How the caller sees it at best: some records may show less. */
  readonly read: Exclude<FieldAccess, 'hidden'> | null;
  readonly create: boolean;
  readonly update: boolean;
}

function describeField(field: StoredField): Omit<UiField, 'read' | 'create' | 'update' | 'lines'> {
  return {
    name: field.name,
    label: field.label,
    type: field.type,
    required: field.required,
    ...(field.requiredWhen ? { requiredWhen: field.requiredWhen } : {}),
    ...(field.description ? { description: field.description } : {}),
    ...(field.type === 'choice' ? { options: field.options, multiple: field.multiple } : {}),
    ...(field.type === 'reference' || field.type === 'lines' ? { entity: field.entity } : {}),
    ...(field.type === 'number' ? { decimals: field.decimals, ...(field.rollup ? { computed: true, rollup: field.rollup as Record<string, string> } : {}) } : {}),
    // A formula, so that a form shows what it gives as people type.
    ...(formulaOf(field) ? { computed: true, formula: formulaOf(field) } : {}),
    ...(field.type === 'text' ? { maxLength: field.maxLength, multiline: field.multiline } : {}),
    ...(field.type === 'file' ? { accept: [...field.accept] } : {}),
  };
}

type Grants = { readonly read: PermissionGrant[]; readonly create: PermissionGrant[]; readonly update: PermissionGrant[] };

/**
 * A field with what the caller may do with it, given their grants, or null if it's nothing to
 * them. A field worked out from lines is never entered; a lines field carries its lines' fields,
 * which grants name as `lines.amount`.
 */
function uiField(
  definition: StoredDefinition,
  field: StoredField,
  grants: Grants,
  at: WriteContext,
  /** The entity the field is of, and whether that is lines of another. */
  of: { readonly entity: string; readonly line: boolean },
  path = field.name,
): UiField | null {
  const access = fieldAccess(grants.read, path);
  const computed = isComputed(field);
  const canCreate = !computed && grants.create.some((grant) => covers(grant, path));
  const canUpdate = !computed && grants.update.some((grant) => covers(grant, path));
  if (access === 'hidden' && !canCreate) return null;
  let lines: UiField['lines'];
  if (field.type === 'lines') {
    const lineEntity = definition.entities[field.entity]!;
    lines = {
      max: field.max,
      label: lineEntity.label,
      titleField: lineEntity.titleField ?? null,
      fields: lineEntity.fields.flatMap((f) => uiField(definition, f, grants, at, { entity: field.entity, line: true }, `${field.name}.${f.name}`) ?? []),
    };
  }
  const owner = definition.entities[of.entity];
  const info = owner ? entityFields(owner, { line: of.line }).get(field.name) : undefined;
  const given = info && canCreate ? defaultValue(info, at) : undefined;
  return { ...describeField(field), ...(given !== undefined ? { default: given } : {}), ...(lines ? { lines } : {}), read: access === 'hidden' ? null : access, create: canCreate, update: canUpdate };
}

/**
 * What the caller can use in an app, for generated screens: entities with their fields, forms,
 * and the actions and queries they may run. Builders read the definition; everyone else reads this.
 */
export async function describeUi(ctx: AppContext, runtime: AppRuntime, request: FastifyRequest, auth: AuthContext, loaded: LoadedApp) {
  void request;
  const policy = await runtime.policy(loaded);
  const decide = (action: string, entity: string) => ctx.policy.query(auth.principal, action, recordResource(ctx.org.id, loaded, entity), { policy });
  const allowed = async (kind: 'action' | 'query', name: string) =>
    (await ctx.policy.authorize(auth.principal, `${kind}.run`, runtime.capability(loaded, kind, name), undefined, policy)).allowed;

  // A new record's defaults, as this person would get them now.
  const at: WriteContext = { now: ctx.now(), person: auth.actor.type === 'user' ? auth.actor.id : undefined };
  const entities: Record<string, unknown> = {};
  const visibleFields = new Map<string, Set<string>>();
  const owners = lineOwners(loaded.definition);
  for (const [name, entity] of Object.entries(loaded.definition.entities)) {
    // Lines are shown with their records, never as records of their own.
    if (owners.has(name)) continue;
    const [read, create, update, remove] = await Promise.all(['record.read', 'record.create', 'record.update', 'record.delete'].map((action) => decide(action, name)));
    if (!read!.allowed && !create!.allowed) continue;
    const grantsOf = (decision: typeof read) => (decision!.allowed ? decision!.grants.map((g) => g.grant) : []);
    const grants = { read: grantsOf(read), create: grantsOf(create), update: grantsOf(update) };
    const fields: UiField[] = entity.fields.flatMap((field) => uiField(loaded.definition, field, grants, at, { entity: name, line: false }) ?? []);
    visibleFields.set(name, new Set(fields.map((f) => f.name)));
    entities[name] = {
      label: entity.label,
      pluralLabel: entity.pluralLabel ?? entity.label,
      titleField: entity.titleField ?? null,
      can: { read: read!.allowed, create: create!.allowed, update: update!.allowed, delete: remove!.allowed },
      fields,
    };
  }

  const actions: Record<string, unknown> = {};
  for (const [name, action] of Object.entries(loaded.definition.actions)) {
    if (!visibleFields.has(action.entity) || !(await allowed('action', name))) continue;
    actions[name] = { label: action.label, description: action.description, entity: action.entity, operation: action.operation, input: action.input, confirm: action.confirm };
  }
  const queries: Record<string, unknown> = {};
  for (const [name, query] of Object.entries(loaded.definition.queries)) {
    if (!visibleFields.has(query.entity) || !(await allowed('query', name))) continue;
    queries[name] = { label: query.label, description: query.description, entity: query.entity, fields: query.fields, parameters: query.parameters };
  }
  const forms: Record<string, unknown> = {};
  for (const [name, form] of Object.entries(loaded.definition.forms)) {
    const visible = visibleFields.get(form.entity);
    const entity = entities[form.entity] as { can: { create: boolean; update: boolean } } | undefined;
    // A form is usable through its action, or for creating or editing records directly.
    if (!visible || !entity || (form.action ? !(form.action in actions) : !entity.can.create && !entity.can.update)) continue;
    forms[name] = {
      label: form.label,
      entity: form.entity,
      ...(form.action ? { action: form.action } : {}),
      layout: form.layout,
      sections: form.sections
        .map((section) => ({ ...section, fields: section.fields.filter((item) => visible.has(item.field) || ['id', 'owner', 'created_at', 'updated_at'].includes(item.field)) }))
        .filter((section) => section.fields.length),
    };
  }
  const { pages, navigation } = await describePages(ctx, auth, loaded, { entities, forms, actions, visibleFields });
  return { entities, forms, actions, queries, pages, navigation };
}

/** What screens need to draw a number or a chart: its labels, and how to show its values. */
function describeSummary(definition: StoredDefinition, path: string, block: StatBlock | ChartBlock): Record<string, unknown> & { type: string } {
  const entity = definition.entities[block.entity]!;
  /** A field of the records, or of their lines. */
  const fieldOf = (path: string): StoredField | undefined => {
    const [first, sub] = path.split('.') as [string, string | undefined];
    const field = entity.fields.find((f) => f.name === first);
    if (!sub) return field;
    return field?.type === 'lines' ? definition.entities[field.entity]?.fields.find((f) => f.name === sub) : undefined;
  };
  const measured = block.measure.field ? fieldOf(block.measure.field) : undefined;
  const decimals = block.measure.op === 'count' ? 0 : measured?.type === 'number' ? measured.decimals : 0;
  const base = { path, entity: block.entity, op: block.measure.op, decimals };
  if (block.type === 'stat') return { type: 'stat', label: block.label, ...base };
  const grouped = fieldOf(block.group.field);
  const people = grouped?.type === 'user' || ['owner', 'created_by', 'updated_by'].includes(block.group.field);
  return {
    type: 'chart',
    title: block.title,
    show: block.show,
    width: block.width,
    ...base,
    group: {
      label: grouped?.label ?? SYSTEM_COLUMNS[block.group.field] ?? block.group.field,
      kind: block.group.period ? 'period' : people ? 'person' : 'value',
      ...(block.group.period ? { period: block.group.period } : {}),
    },
  };
}

/** Labels for the system fields a list may show as columns. */
const SYSTEM_COLUMNS: Readonly<Record<string, string>> = {
  created_at: 'Created',
  updated_at: 'Updated',
  owner: 'Owner',
  created_by: 'Created by',
  updated_by: 'Updated by',
};

type Visible = {
  readonly entities: Record<string, unknown>;
  readonly forms: Record<string, unknown>;
  readonly actions: Record<string, unknown>;
  readonly visibleFields: ReadonlyMap<string, ReadonlySet<string>>;
};

/**
 * The app's pages and menu as the caller may use them (design §5.5): a list shows the columns
 * their role can read, a button or menu item appears only if what it opens is usable, and a page
 * appears if anything on it is. A page meant for some roles only is left out for people who hold
 * other roles of the app. None of this protects data: the records API does that.
 */
async function describePages(ctx: AppContext, auth: AuthContext, loaded: LoadedApp, visible: Visible) {
  const definition = loaded.definition;
  const held = await ctx.policy.bindingsFor(auth.principal);
  const myRoles = new Set(
    held
      .filter((binding) => binding.scope.type === 'env' && binding.scope.id === loaded.env.id && binding.roleId)
      .map((binding) => appRoleName(loaded.app.id, binding.roleId!))
      .filter((name): name is string => name !== null),
  );
  const fieldsOf = (entity: string) => (visible.entities[entity] as { fields: UiField[]; can: { read: boolean } } | undefined);

  type Block = Record<string, unknown> & { type: string };
  const shown = new Map<string, { label: string; description?: string; record?: { entity: string }; blocks: Block[]; usable: boolean }>();
  for (const [name, page] of Object.entries(definition.pages)) {
    if (page.roles?.length && myRoles.size && !page.roles.some((role) => myRoles.has(role))) continue;
    // A page about one record is for people who may read such records.
    if (page.record && !fieldsOf(page.record.entity)?.can.read) continue;
    let data = 0;
    let usable = 0;
    /** A block as the caller may use it, or null when nothing of it is theirs. */
    const describe = (block: TabBlock, path: string): Block | null => {
      if (block.type === 'text') return { type: 'text', style: block.style, text: block.text };
      data++;
      if (block.type === 'buttons') {
        // Page buttons are checked once every page's own use is known.
        const buttons = block.buttons.filter((button) => ('form' in button ? button.form in visible.forms : true));
        if (buttons.some((button) => 'form' in button)) usable++;
        return buttons.length ? { type: 'buttons', buttons } : null;
      }
      if (block.type === 'fields') {
        // The page's record shows only the fields the caller may read.
        const about = fieldsOf(page.record!.entity)!;
        const fields = block.fields.filter((field) => field in SYSTEM_COLUMNS || about.fields.some((f) => f.name === field && f.read));
        if (!fields.length) return null;
        usable++;
        return { type: 'fields', path, ...(block.title ? { title: block.title } : {}), fields, actions: block.actions.filter((action) => action in visible.actions) };
      }
      const entity = fieldsOf(block.entity);
      if (!entity?.can.read) return null;
      if (block.type === 'stat' || block.type === 'chart') {
        // A number about fields the person can't see would tell them what their role hides.
        const read = (field: string): UiField['read'] => {
          if (field in SYSTEM_COLUMNS) return 'full';
          const [first, sub] = field.split('.') as [string, string | undefined];
          const found = entity.fields.find((f) => f.name === first);
          return sub ? (found?.lines?.fields.find((f) => f.name === sub)?.read ?? null) : (found?.read ?? null);
        };
        const paths = [block.measure.field, block.type === 'chart' ? block.group.field : undefined, block.range?.field].filter((each): each is string => each !== undefined);
        if (paths.some((each) => read(each) !== 'full')) return null;
        usable++;
        return { ...describeSummary(definition, path, block), ...(block.of ? { of: block.of } : {}) };
      }
      const fields = new Map(entity.fields.filter((field) => field.read).map((field) => [field.name, field]));
      const columns = block.columns.flatMap((column) => {
        const field = fields.get(column);
        if (field) return [{ name: column, label: field.label, type: field.type, ...(field.options ? { options: field.options } : {}), ...(field.decimals !== undefined ? { decimals: field.decimals } : {}) }];
        return column in SYSTEM_COLUMNS ? [{ name: column, label: SYSTEM_COLUMNS[column]!, type: column.endsWith('_at') ? 'datetime' : 'user' }] : [];
      });
      if (!columns.length) return null;
      usable++;
      return {
        type: 'list',
        path,
        entity: block.entity,
        ...(block.title ? { title: block.title } : {}),
        columns,
        actions: block.actions.filter((action) => action in visible.actions),
        ...(block.empty ? { empty: block.empty } : {}),
        ...(block.of ? { of: block.of } : {}),
        ...(block.open ? { open: block.open } : {}),
      };
    };
    const blocks: Block[] = [];
    page.blocks.forEach((block, index) => {
      if (block.type !== 'tabs') {
        const described = describe(block, String(index));
        if (described) blocks.push(described);
        return;
      }
      // A tab with nothing the caller may use goes; tabs with none left go too.
      const tabs = block.tabs.flatMap((tab, t) => {
        const inner = tab.blocks.flatMap((each, i) => describe(each, `${index}.${t}.${i}`) ?? []);
        return inner.length ? [{ label: tab.label, blocks: inner }] : [];
      });
      if (tabs.length) blocks.push({ type: 'tabs', tabs });
    });
    shown.set(name, {
      label: page.label,
      ...(page.description ? { description: page.description } : {}),
      ...(page.record ? { record: { entity: page.record.entity } } : {}),
      blocks,
      usable: data === 0 || usable > 0,
    });
  }
  // A button to a page, a row that opens one, and a page of nothing but such buttons, count once the pages they open do.
  const usablePage = (name: string) => shown.get(name)?.usable === true;
  const finish = (block: Block): Block[] => {
    if (block.type === 'buttons') {
      const buttons = (block['buttons'] as Array<{ form?: string; page?: string }>).filter((button) => (button.page ? usablePage(button.page) : true));
      return buttons.length ? [{ ...block, buttons }] : [];
    }
    if (block.type === 'list' && typeof block['open'] === 'string' && !usablePage(block['open'])) {
      const { open: _open, ...rest } = block;
      return [rest as Block];
    }
    if (block.type === 'tabs') {
      const tabs = (block['tabs'] as Array<{ label: string; blocks: Block[] }>).flatMap((tab) => {
        const inner = tab.blocks.flatMap(finish);
        return inner.length ? [{ label: tab.label, blocks: inner }] : [];
      });
      return tabs.length ? [{ type: 'tabs', tabs }] : [];
    }
    return [block];
  };
  const holdsButtons = (blocks: readonly Block[]): boolean =>
    blocks.some((block) => block.type === 'buttons' || (block.type === 'tabs' && (block['tabs'] as Array<{ blocks: Block[] }>).some((tab) => holdsButtons(tab.blocks))));
  const pages: Record<string, unknown> = {};
  for (const [name, page] of shown) {
    const blocks = page.blocks.flatMap(finish);
    const usable = page.usable || holdsButtons(blocks);
    if (usable) pages[name] = { label: page.label, ...(page.description ? { description: page.description } : {}), ...(page.record ? { record: page.record } : {}), blocks };
  }

  let navigation: { home: string | null; items: Array<Record<string, string>> } | null = null;
  if (definition.navigation) {
    const items: Array<Record<string, string>> = [];
    for (const item of definition.navigation.items) {
      if ('heading' in item) items.push({ heading: item.heading });
      else if ('page' in item) {
        if (item.page in pages) items.push({ page: item.page, label: item.label ?? (pages[item.page] as { label: string }).label });
      } else if ('form' in item) {
        if (item.form in visible.forms) items.push({ form: item.form, label: item.label ?? (visible.forms[item.form] as { label: string }).label });
      } else if (fieldsOf(item.entity)?.can.read) {
        items.push({ entity: item.entity, label: item.label ?? (visible.entities[item.entity] as { pluralLabel: string }).pluralLabel });
      }
    }
    // A heading with nothing under it says nothing.
    const kept = items.filter((item, i) => !('heading' in item) || (items[i + 1] !== undefined && !('heading' in items[i + 1]!)));
    const home = definition.navigation.home;
    navigation = { home: home && home in pages ? home : null, items: kept };
  }
  return { pages, navigation };
}

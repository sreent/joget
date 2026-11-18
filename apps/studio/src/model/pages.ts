import type { Definition } from '../types.js';
import { isName, lineOwner, toName } from './edit.js';

/**
 * Pure edits of pages and the menu in a draft. Each returns a new definition. Removing what a page
 * or the menu names (an entity, a field, a form, an action, a role, another page) tidies them too,
 * so the draft stays whole.
 */

export type Page = Definition['pages'][string];
export type Block = Page['blocks'][number];
export type BlockType = Block['type'];
export type ListBlock = Extract<Block, { type: 'list' }>;
export type FieldsBlock = Extract<Block, { type: 'fields' }>;
export type TabsBlock = Extract<Block, { type: 'tabs' }>;
/** A block that a tab holds: any but tabs. */
export type InnerBlock = TabsBlock['tabs'][number]['blocks'][number];
export type StatBlock = Extract<Block, { type: 'stat' }>;
export type ChartBlock = Extract<Block, { type: 'chart' }>;
export type Measure = StatBlock['measure'];
export type ButtonsBlock = Extract<Block, { type: 'buttons' }>;
export type PageButton = ButtonsBlock['buttons'][number];
export type Navigation = NonNullable<Definition['navigation']>;
export type NavItem = Navigation['items'][number];

const clone = <T>(value: T): T => structuredClone(value);

/** Columns a list can show besides the entity's own fields. */
export const SYSTEM_COLUMNS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'created_at', label: 'Created' },
  { value: 'updated_at', label: 'Last changed' },
  { value: 'owner', label: 'Owner' },
  { value: 'created_by', label: 'Created by' },
  { value: 'updated_by', label: 'Changed by' },
];

/** Entities whose records stand on their own, and so can be listed. */
export const listable = (definition: Definition): string[] => Object.keys(definition.entities).filter((name) => !lineOwner(definition, name));

/** A list of an entity's records: its first fields and when each was made, newest first. */
export function newList(definition: Definition, entity: string): ListBlock {
  const fields = (definition.entities[entity]?.fields ?? []).filter((field) => field.type !== 'lines').slice(0, 3).map((field) => field.name);
  return { type: 'list', entity, columns: [...fields, 'created_at'], sort: [{ field: 'created_at', direction: 'desc' }], limit: 20, actions: [] };
}

/** A new block of a kind, or null if the app has nothing it could show yet. `about` is the entity of the record a page is about. */
export function newBlock(definition: Definition, type: BlockType, about?: string): Block | null {
  switch (type) {
    case 'text':
      return { type: 'text', style: 'paragraph', text: 'Say what this part of the page is for.' };
    case 'fields': {
      const fields = (about ? (definition.entities[about]?.fields ?? []) : []).filter((field) => field.type !== 'file').slice(0, 6).map((field) => field.name);
      return fields.length ? { type: 'fields', fields, actions: [] } : null;
    }
    case 'tabs':
      return {
        type: 'tabs',
        tabs: [
          { label: 'First', blocks: [{ type: 'text', style: 'paragraph', text: 'What the first tab shows.' }] },
          { label: 'Second', blocks: [{ type: 'text', style: 'paragraph', text: 'What the second tab shows.' }] },
        ],
      };
    case 'list': {
      const entity = listable(definition)[0];
      return entity ? newList(definition, entity) : null;
    }
    case 'buttons': {
      const form = Object.keys(definition.forms)[0];
      const page = Object.keys(definition.pages)[0];
      return form ? { type: 'buttons', buttons: [{ form }] } : page ? { type: 'buttons', buttons: [{ page }] } : null;
    }
    case 'stat': {
      const entity = listable(definition)[0];
      if (!entity) return null;
      const label = definition.entities[entity]!.pluralLabel ?? definition.entities[entity]!.label;
      return { type: 'stat', label: `How many ${label.toLowerCase()}`, entity, measure: { op: 'count' } };
    }
    case 'chart': {
      const entity = listable(definition)[0];
      return entity ? newChart(definition, entity) : null;
    }
  }
}

/** A chart that counts an entity's records by its first choice field, or by the month they were made. */
export function newChart(definition: Definition, entity: string): ChartBlock {
  const plural = definition.entities[entity]!.pluralLabel ?? definition.entities[entity]!.label;
  const choice = definition.entities[entity]!.fields.find((field) => field.type === 'choice' && !field.multiple);
  return choice
    ? { type: 'chart', title: `${plural} by ${choice.label.toLowerCase()}`, entity, measure: { op: 'count' }, group: { field: choice.name }, show: 'bar', limit: 8, width: 'half' }
    : { type: 'chart', title: `${plural} by month`, entity, measure: { op: 'count' }, group: { field: 'created_at', period: 'month' }, show: 'column', limit: 12, width: 'half' };
}

/** A field of the lines, after the lines that hold it: "Receipts › Amount (SGD)". Labels keep their case. */
const linePath = (lines: string, field: string) => `${lines} › ${field}`;

/** Fields a number or a chart can total: number fields of the records, and of their lines as `lines.amount`. */
export function numberPaths(definition: Definition, entity: string): Array<{ value: string; label: string }> {
  const paths: Array<{ value: string; label: string }> = [];
  for (const field of definition.entities[entity]?.fields ?? []) {
    if (field.type === 'number') paths.push({ value: field.name, label: field.label });
    if (field.type !== 'lines') continue;
    for (const sub of definition.entities[field.entity]?.fields ?? []) {
      if (sub.type === 'number') paths.push({ value: `${field.name}.${sub.name}`, label: linePath(field.label, sub.label) });
    }
  }
  return paths;
}

/** Fields a chart can group by: choices, text, yes or no and people, of the records or their lines; and dates, by period. */
export function groupPaths(definition: Definition, entity: string): Array<{ value: string; label: string; dated: boolean }> {
  const groupable = (type: string, multiple?: boolean) => ['text', 'email', 'boolean', 'user'].includes(type) || (type === 'choice' && !multiple);
  const paths: Array<{ value: string; label: string; dated: boolean }> = [];
  for (const field of definition.entities[entity]?.fields ?? []) {
    const dated = field.type === 'date' || field.type === 'datetime';
    if (dated || groupable(field.type, field.type === 'choice' ? field.multiple : undefined)) paths.push({ value: field.name, label: field.label, dated });
    if (field.type !== 'lines') continue;
    for (const sub of definition.entities[field.entity]?.fields ?? []) {
      const subDated = sub.type === 'date' || sub.type === 'datetime';
      if (subDated || groupable(sub.type, sub.type === 'choice' ? sub.multiple : undefined)) {
        paths.push({ value: `${field.name}.${sub.name}`, label: linePath(field.label, sub.label), dated: subDated });
      }
    }
  }
  paths.push({ value: 'owner', label: 'Owner', dated: false }, { value: 'created_at', label: 'Created', dated: true }, { value: 'updated_at', label: 'Last changed', dated: true });
  return paths;
}

const placeholder = (): Block => ({ type: 'text', style: 'paragraph', text: 'This page is empty.' });

export function addPage(definition: Definition, label: string): { definition: Definition; name: string } {
  const next = clone(definition);
  const name = toName(label, Object.keys(next.pages));
  const entity = listable(next)[0];
  next.pages[name] = { label, blocks: [entity ? newList(next, entity) : { type: 'text', style: 'paragraph', text: `Say what ${label} is for.` }] };
  return { definition: next, name };
}

/** Change a page's label, description or roles. An empty value is removed: no roles means everyone who may use it. */
export function updatePage(definition: Definition, name: string, patch: Partial<Pick<Page, 'label' | 'description' | 'roles' | 'record'>>): Definition {
  const next = clone(definition);
  const page = next.pages[name]! as Record<string, unknown>;
  const was = next.pages[name]!.record?.entity;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) delete page[key];
    else page[key] = value;
  }
  const now = next.pages[name]!.record?.entity;
  if ('record' in patch && now !== was) aboutChanged(next, name, now);
  return next;
}

/**
 * What a page is about changed. A page about one record needs it, so the menu and buttons stop
 * opening it; its fields and the blocks of records that referred to the old record go; and rows of
 * other records stop opening it.
 */
function aboutChanged(definition: Definition, name: string, entity: string | undefined): void {
  if (entity) {
    dropButtons(definition, (button) => 'page' in button && button.page === name);
    if (definition.navigation) {
      definition.navigation.items = definition.navigation.items.filter((item) => !('page' in item && item.page === name));
      if (definition.navigation.home === name) delete definition.navigation.home;
    }
  }
  const page = definition.pages[name]!;
  const keep = (block: InnerBlock) => block.type !== 'fields' && !('of' in block && block.of !== undefined);
  page.blocks = page.blocks.flatMap((block): Block[] => {
    if (block.type !== 'tabs') return keep(block) ? [block] : [];
    return [{ ...block, tabs: block.tabs.map((tab) => ({ ...tab, blocks: tab.blocks.filter(keep) })).map((tab) => (tab.blocks.length ? tab : { ...tab, blocks: [placeholder() as InnerBlock] })) }];
  });
  if (!page.blocks.length) page.blocks = [placeholder()];
  eachBlock(definition, (block) => {
    if (block.type !== 'list' || block.open !== name || block.entity === entity) return [block];
    const { open: _open, ...rest } = block;
    return [rest];
  });
}

/** Rename a page, and the buttons and menu items that open it. */
export function renamePage(definition: Definition, from: string, to: string): Definition {
  if (from === to || !isName(to) || to in definition.pages) return definition;
  const next = clone(definition);
  next.pages = Object.fromEntries(Object.entries(next.pages).map(([key, value]) => [key === from ? to : key, value]));
  for (const page of Object.values(next.pages)) {
    for (const block of page.blocks) {
      if (block.type === 'buttons') for (const button of block.buttons) if ('page' in button && button.page === from) button.page = to;
    }
  }
  if (next.navigation) {
    for (const item of next.navigation.items) if ('page' in item && item.page === from) item.page = to;
    if (next.navigation.home === from) next.navigation.home = to;
  }
  return next;
}

/** Remove a page, and every button and menu item that opens it. */
export function removePage(definition: Definition, name: string): Definition {
  const next = clone(definition);
  delete next.pages[name];
  dropButtons(next, (button) => 'page' in button && button.page === name);
  if (next.navigation) {
    next.navigation.items = next.navigation.items.filter((item) => !('page' in item && item.page === name));
    if (next.navigation.home === name) delete next.navigation.home;
  }
  return next;
}

/**
 * Where a block is: its place on the page, as "2"; or, inside tabs, the tabs' place, the tab and
 * its own place, as "2.1.0".
 */
export function splitPath(path: string): { readonly index: number; readonly tab?: number; readonly inner?: number } {
  const [index, tab, inner] = path.split('.').map(Number) as [number, number | undefined, number | undefined];
  return tab === undefined || inner === undefined ? { index } : { index, tab, inner };
}

/** The block at a path of a page. */
export function blockAt(definition: Definition, page: string, path: string): Block | InnerBlock | undefined {
  const { index, tab, inner } = splitPath(path);
  const outer = definition.pages[page]?.blocks[index];
  if (tab === undefined || inner === undefined) return outer;
  return outer?.type === 'tabs' ? outer.tabs[tab]?.blocks[inner] : undefined;
}

/** The list of blocks a path is in, in a draft: the page's own, or a tab's. */
function listOf(page: Page, path: string): { list: Array<Block | InnerBlock>; at: number } | undefined {
  const { index, tab, inner } = splitPath(path);
  if (tab === undefined || inner === undefined) return { list: page.blocks, at: index };
  const outer = page.blocks[index];
  return outer?.type === 'tabs' && outer.tabs[tab] ? { list: outer.tabs[tab].blocks, at: inner } : undefined;
}

/** Add a block at the end of the page, or of a tab. Returns where it went, or "" if nothing could be added. */
export function addBlock(definition: Definition, page: string, type: BlockType, into?: { readonly index: number; readonly tab: number }): { definition: Definition; path: string } {
  const block = newBlock(definition, type, definition.pages[page]?.record?.entity);
  if (!block || (into && block.type === 'tabs')) return { definition, path: '' };
  const next = clone(definition);
  const target = next.pages[page]!;
  if (!into) {
    target.blocks.push(block);
    return { definition: next, path: String(target.blocks.length - 1) };
  }
  const tabs = target.blocks[into.index];
  if (tabs?.type !== 'tabs' || !tabs.tabs[into.tab]) return { definition, path: '' };
  tabs.tabs[into.tab]!.blocks.push(block as InnerBlock);
  return { definition: next, path: `${into.index}.${into.tab}.${tabs.tabs[into.tab]!.blocks.length - 1}` };
}

/** Replace a block's properties. A key set to undefined is removed. */
export function updateBlock(definition: Definition, page: string, path: string, patch: Record<string, unknown>): Definition {
  const next = clone(definition);
  const found = listOf(next.pages[page]!, path);
  const block = found?.list[found.at] as Record<string, unknown> | undefined;
  if (!block) return definition;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete block[key];
    else block[key] = value;
  }
  return next;
}

/** A list shows another entity: its columns, filter, order and row actions start afresh. */
export function changeListEntity(definition: Definition, page: string, path: string, entity: string): Definition {
  const next = clone(definition);
  const found = listOf(next.pages[page]!, path);
  const block = found?.list[found.at];
  if (!found || block?.type !== 'list') return definition;
  found.list[found.at] = { ...newList(next, entity), ...(block.title ? { title: block.title } : {}), ...(block.empty ? { empty: block.empty } : {}) };
  return next;
}

/** Remove a block. A page keeps at least one, and so does a tab. */
export function removeBlock(definition: Definition, page: string, path: string): Definition {
  const next = clone(definition);
  const found = listOf(next.pages[page]!, path);
  if (!found || found.list.length <= 1) return definition;
  found.list.splice(found.at, 1);
  return next;
}

/** Move a block within its list: the page's own, or a tab's. */
export function moveBlock(definition: Definition, page: string, path: string, to: number): Definition {
  const next = clone(definition);
  const found = listOf(next.pages[page]!, path);
  if (!found || found.at === to || to < 0 || to >= found.list.length) return definition;
  const [moved] = found.list.splice(found.at, 1);
  found.list.splice(to, 0, moved!);
  return next;
}

/** Add a tab at the end, with a text block to start from. Tabs hold eight at most. */
export function addTab(definition: Definition, page: string, index: number): Definition {
  const next = clone(definition);
  const tabs = next.pages[page]!.blocks[index];
  if (tabs?.type !== 'tabs' || tabs.tabs.length >= 8) return definition;
  tabs.tabs.push({ label: `Tab ${tabs.tabs.length + 1}`, blocks: [{ type: 'text', style: 'paragraph', text: 'What this tab shows.' }] });
  return next;
}

/** Rename a tab, or remove it: tabs keep two at least. */
export function updateTab(definition: Definition, page: string, index: number, tab: number, label: string | null): Definition {
  const next = clone(definition);
  const tabs = next.pages[page]!.blocks[index];
  if (tabs?.type !== 'tabs' || !tabs.tabs[tab]) return definition;
  if (label === null) {
    if (tabs.tabs.length <= 2) return definition;
    tabs.tabs.splice(tab, 1);
  } else tabs.tabs[tab]!.label = label;
  return next;
}

/** Pages about one record of an entity: what a list of its records can open. */
export function recordPages(definition: Definition, entity: string): Array<{ name: string; label: string }> {
  return Object.entries(definition.pages).flatMap(([name, page]) => (page.record?.entity === entity ? [{ name, label: page.label }] : []));
}

/** Reference fields of an entity that point at another: what a list on a page about one record shows its records by. */
export function referringFields(definition: Definition, entity: string, to: string): Array<{ name: string; label: string }> {
  return (definition.entities[entity]?.fields ?? []).flatMap((field) => (field.type === 'reference' && field.entity === to ? [{ name: field.name, label: field.label }] : []));
}

// The menu

/** A menu with every page, form and list, the first page as home: where a custom menu starts. */
export function defaultMenu(definition: Definition): Navigation {
  const pages = Object.keys(definition.pages);
  return {
    ...(pages[0] ? { home: pages[0] } : {}),
    items: [...pages.map((page) => ({ page })), ...Object.keys(definition.forms).map((form) => ({ form })), ...listable(definition).map((entity) => ({ entity }))],
  };
}

/** Switch between the app's own menu and the default one, which lists every form and list. */
export function setCustomMenu(definition: Definition, on: boolean): Definition {
  const next = clone(definition);
  if (on) next.navigation = defaultMenu(next);
  else delete next.navigation;
  return next;
}

const menu = (definition: Definition): Navigation => definition.navigation ?? { items: [] };

export function addNavItem(definition: Definition, item: NavItem): Definition {
  const next = clone(definition);
  next.navigation = { ...menu(next), items: [...menu(next).items, item] };
  return next;
}

export function updateNavItem(definition: Definition, index: number, item: NavItem): Definition {
  const next = clone(definition);
  next.navigation = { ...menu(next), items: menu(next).items.map((existing, i) => (i === index ? item : existing)) };
  return next;
}

export function removeNavItem(definition: Definition, index: number): Definition {
  const next = clone(definition);
  next.navigation = { ...menu(next), items: menu(next).items.filter((_, i) => i !== index) };
  return next;
}

export function moveNavItem(definition: Definition, from: number, to: number): Definition {
  if (from === to) return definition;
  const next = clone(definition);
  const items = [...menu(next).items];
  const [moved] = items.splice(from, 1);
  items.splice(to, 0, moved!);
  next.navigation = { ...menu(next), items };
  return next;
}

/** The page the app opens on, or none for its first menu item. */
export function setHome(definition: Definition, page: string | undefined): Definition {
  const next = clone(definition);
  const current = menu(next);
  const { home: _home, ...rest } = current;
  next.navigation = page ? { ...rest, home: page } : rest;
  return next;
}

// Tidying when something pages name goes away. Each changes the draft it is given.

/**
 * Change each block of every page, the blocks of tabs too: `edit` gives what stays in a block's
 * place. A tab left with nothing, and a page left with nothing, get a text block.
 */
function eachBlock(definition: Definition, edit: (block: InnerBlock, page: Page) => InnerBlock[]): void {
  for (const page of Object.values(definition.pages)) {
    page.blocks = page.blocks.flatMap((block): Block[] => {
      if (block.type !== 'tabs') return edit(block, page);
      return [{ ...block, tabs: block.tabs.map((tab) => ({ ...tab, blocks: tab.blocks.flatMap((inner) => edit(inner, page)) })).map((tab) => (tab.blocks.length ? tab : { ...tab, blocks: [placeholder() as InnerBlock] })) }];
    });
    if (!page.blocks.length) page.blocks = [placeholder()];
  }
}

function dropButtons(definition: Definition, gone: (button: PageButton) => boolean): void {
  eachBlock(definition, (block) => {
    if (block.type !== 'buttons') return [block];
    const buttons = block.buttons.filter((button) => !gone(button));
    return buttons.length ? [{ ...block, buttons }] : [];
  });
}

/** An entity went: its lists, numbers and charts go, pages about its records go, and so does its menu item. */
export function forgetEntity(definition: Definition, entity: string): void {
  for (const [name, page] of Object.entries(definition.pages)) if (page.record?.entity === entity) forgetPage(definition, name);
  eachBlock(definition, (block) => (!('entity' in block) || block.entity !== entity ? [block] : []));
  if (definition.navigation) definition.navigation.items = definition.navigation.items.filter((item) => !('entity' in item && item.entity === entity));
}

/** A page went: so do the buttons to it, and the rows that opened it open their records instead. */
function forgetPage(definition: Definition, name: string): void {
  delete definition.pages[name];
  dropButtons(definition, (button) => 'page' in button && button.page === name);
  eachBlock(definition, (block) => {
    if (block.type !== 'list' || block.open !== name) return [block];
    const { open: _open, ...rest } = block;
    return [rest];
  });
}

/**
 * A field went: lists stop showing it and sorting by it; a number or chart stops totalling it
 * (and counts instead), a chart grouped by it goes, and a time range on it goes. A block of the
 * records that referred by it goes, and a page about one record stops showing it. A field of lines
 * is named on its record's entity as `lines.amount`.
 */
export function forgetField(definition: Definition, entity: string, field: string): void {
  const owner = lineOwner(definition, entity);
  const [target, path] = owner ? [owner.parent, `${owner.field}.${field}`] : [entity, field];
  const gone = (name: string | undefined) => name !== undefined && (name === path || name.startsWith(`${path}.`));
  eachBlock(definition, (block, page) => {
    if (block.type === 'fields') {
      if (owner || page.record?.entity !== target) return [block];
      const fields = block.fields.filter((name) => name !== field);
      return fields.length ? [{ ...block, fields }] : [];
    }
    if (!('entity' in block) || block.entity !== target) return [block];
    if (!owner && block.of === field) return [];
    if (block.type === 'list') {
      if (owner) return [block];
      block.columns = block.columns.filter((column) => column !== field);
      if (!block.columns.length) block.columns = ['created_at'];
      block.sort = (block.sort ?? []).filter((key) => key.field !== field);
      return [block];
    }
    if (block.type === 'chart' && gone(block.group.field)) return [];
    if (gone(block.measure.field)) block.measure = { op: 'count' };
    if (block.range && gone(block.range.field)) delete block.range;
    return [block];
  });
  // Queries that work out numbers let go of it the same way: grouped by it, they answer with one number.
  for (const query of Object.values(definition.queries)) {
    const summary = query.summary;
    if (query.entity !== target || !summary) continue;
    if (summary.group && gone(summary.group.field)) delete summary.group;
    if (gone(summary.measure.field)) summary.measure = { op: 'count' };
    if (summary.range && gone(summary.range.field)) delete summary.range;
  }
}

/** A form went: so do its buttons and menu item. */
export function forgetForm(definition: Definition, form: string): void {
  dropButtons(definition, (button) => 'form' in button && button.form === form);
  if (definition.navigation) definition.navigation.items = definition.navigation.items.filter((item) => !('form' in item && item.form === form));
}

/** An action was renamed, or went (`to` undefined): lists and the fields of a page's record follow it. */
export function renameRowAction(definition: Definition, from: string, to?: string): void {
  eachBlock(definition, (block) => {
    if (block.type !== 'list' && block.type !== 'fields') return [block];
    return [{ ...block, actions: (block.actions ?? []).flatMap((action) => (action !== from ? [action] : to ? [to] : [])) }];
  });
}

/** A role went: pages meant for it no longer name it. */
export function forgetRole(definition: Definition, role: string): void {
  for (const page of Object.values(definition.pages)) {
    if (!page.roles) continue;
    page.roles = page.roles.filter((r) => r !== role);
    if (!page.roles.length) delete page.roles;
  }
}

/** Update actions that can run on a row of a list: of its entity, and taking no input. */
export function rowActions(definition: Definition, entity: string): string[] {
  return Object.entries(definition.actions)
    .filter(([, action]) => action.entity === entity && action.operation === 'update' && action.input.length === 0)
    .map(([name]) => name);
}

/** What a block shows, in a few words, for the page outline. */
export function describeBlock(definition: Definition, block: Block): string {
  switch (block.type) {
    case 'text':
      return block.text.length > 80 ? `${block.text.slice(0, 77)}…` : block.text;
    case 'list': {
      const entity = definition.entities[block.entity];
      const label = (name: string) => entity?.fields.find((field) => field.name === name)?.label ?? SYSTEM_COLUMNS.find((c) => c.value === name)?.label ?? name;
      return `${entity?.pluralLabel ?? entity?.label ?? block.entity}: ${block.columns.map(label).join(', ')}${block.filter ? ', some records' : ''}`;
    }
    case 'buttons':
      return block.buttons
        .map((button) => button.label ?? ('form' in button ? (definition.forms[button.form]?.label ?? button.form) : (definition.pages[button.page]?.label ?? button.page)))
        .join(' · ');
    case 'stat':
      return `${block.label}: ${describeMeasure(definition, block.entity, block.measure)}`;
    case 'chart':
      return `${block.title}: ${describeMeasure(definition, block.entity, block.measure)}, by ${block.group.period ? `${block.group.period} of ` : ''}${pathLabel(definition, block.entity, block.group.field)}`;
    case 'fields':
      return block.fields.join(', ');
    case 'tabs':
      return block.tabs.map((tab) => tab.label).join(' · ');
  }
}

/** A field of an entity's records, or of their lines as `lines.amount`, as people call it. */
export function pathLabel(definition: Definition, entity: string, path: string): string {
  const [first, sub] = path.split('.') as [string, string | undefined];
  const field = definition.entities[entity]?.fields.find((f) => f.name === first);
  if (!field) return SYSTEM_COLUMNS.find((c) => c.value === first)?.label ?? path;
  if (!sub) return field.label;
  const line = field.type === 'lines' ? definition.entities[field.entity]?.fields.find((f) => f.name === sub) : undefined;
  return line ? linePath(field.label, line.label) : path;
}

const OP_WORDS: Readonly<Record<Measure['op'], string>> = { count: 'Count', sum: 'Sum', avg: 'Average', min: 'Lowest', max: 'Highest' };

/** What a number works out, in a few words: "Count", "Count of Receipts", "Sum of Total (SGD)". */
export function describeMeasure(definition: Definition, entity: string, measure: Measure): string {
  if (!measure.field) return OP_WORDS[measure.op];
  return `${OP_WORDS[measure.op]} of ${pathLabel(definition, entity, measure.field)}`;
}

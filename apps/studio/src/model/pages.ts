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

/** A new block of a kind, or null if the app has nothing it could show yet. */
export function newBlock(definition: Definition, type: BlockType): Block | null {
  switch (type) {
    case 'text':
      return { type: 'text', style: 'paragraph', text: 'Say what this part of the page is for.' };
    case 'list': {
      const entity = listable(definition)[0];
      return entity ? newList(definition, entity) : null;
    }
    case 'buttons': {
      const form = Object.keys(definition.forms)[0];
      const page = Object.keys(definition.pages)[0];
      return form ? { type: 'buttons', buttons: [{ form }] } : page ? { type: 'buttons', buttons: [{ page }] } : null;
    }
  }
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
export function updatePage(definition: Definition, name: string, patch: Partial<Pick<Page, 'label' | 'description' | 'roles'>>): Definition {
  const next = clone(definition);
  const page = next.pages[name]! as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) delete page[key];
    else page[key] = value;
  }
  return next;
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

export function addBlock(definition: Definition, page: string, type: BlockType): { definition: Definition; index: number } {
  const block = newBlock(definition, type);
  if (!block) return { definition, index: -1 };
  const next = clone(definition);
  next.pages[page]!.blocks.push(block);
  return { definition: next, index: next.pages[page]!.blocks.length - 1 };
}

/** Replace a block's properties. A key set to undefined is removed. */
export function updateBlock(definition: Definition, page: string, index: number, patch: Record<string, unknown>): Definition {
  const next = clone(definition);
  const block = next.pages[page]!.blocks[index]! as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete block[key];
    else block[key] = value;
  }
  return next;
}

/** A list shows another entity: its columns, filter, order and row actions start afresh. */
export function changeListEntity(definition: Definition, page: string, index: number, entity: string): Definition {
  const next = clone(definition);
  const block = next.pages[page]!.blocks[index]! as ListBlock;
  next.pages[page]!.blocks[index] = { ...newList(next, entity), ...(block.title ? { title: block.title } : {}), ...(block.empty ? { empty: block.empty } : {}) };
  return next;
}

/** Remove a block. A page keeps at least one. */
export function removeBlock(definition: Definition, page: string, index: number): Definition {
  if (definition.pages[page]!.blocks.length <= 1) return definition;
  const next = clone(definition);
  next.pages[page]!.blocks.splice(index, 1);
  return next;
}

export function moveBlock(definition: Definition, page: string, from: number, to: number): Definition {
  if (from === to) return definition;
  const next = clone(definition);
  const blocks = next.pages[page]!.blocks;
  const [moved] = blocks.splice(from, 1);
  blocks.splice(to, 0, moved!);
  return next;
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

function dropButtons(definition: Definition, gone: (button: PageButton) => boolean): void {
  for (const page of Object.values(definition.pages)) {
    page.blocks = page.blocks.flatMap((block): Block[] => {
      if (block.type !== 'buttons') return [block];
      const buttons = block.buttons.filter((button) => !gone(button));
      return buttons.length ? [{ ...block, buttons }] : [];
    });
    if (!page.blocks.length) page.blocks = [placeholder()];
  }
}

/** An entity went: its lists go, and so does its menu item. */
export function forgetEntity(definition: Definition, entity: string): void {
  for (const page of Object.values(definition.pages)) {
    page.blocks = page.blocks.filter((block) => block.type !== 'list' || block.entity !== entity);
    if (!page.blocks.length) page.blocks = [placeholder()];
  }
  if (definition.navigation) definition.navigation.items = definition.navigation.items.filter((item) => !('entity' in item && item.entity === entity));
}

/** A field went: lists stop showing it and sorting by it. */
export function forgetField(definition: Definition, entity: string, field: string): void {
  for (const page of Object.values(definition.pages)) {
    for (const block of page.blocks) {
      if (block.type !== 'list' || block.entity !== entity) continue;
      block.columns = block.columns.filter((column) => column !== field);
      if (!block.columns.length) block.columns = ['created_at'];
      block.sort = (block.sort ?? []).filter((key) => key.field !== field);
    }
  }
}

/** A form went: so do its buttons and menu item. */
export function forgetForm(definition: Definition, form: string): void {
  dropButtons(definition, (button) => 'form' in button && button.form === form);
  if (definition.navigation) definition.navigation.items = definition.navigation.items.filter((item) => !('form' in item && item.form === form));
}

/** An action was renamed, or went (`to` undefined): lists follow it. */
export function renameRowAction(definition: Definition, from: string, to?: string): void {
  for (const page of Object.values(definition.pages)) {
    for (const block of page.blocks) {
      if (block.type !== 'list') continue;
      block.actions = (block.actions ?? []).flatMap((action) => (action !== from ? [action] : to ? [to] : []));
    }
  }
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
  }
}

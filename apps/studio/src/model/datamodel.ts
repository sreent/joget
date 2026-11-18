import { isWorkedOut, type Definition, type Field } from '../types.js';

/*
 * The data model as a canvas (design §6.11), as Ocean's ModelDesigner draws it and Mendix draws a
 * domain model: each entity a box of its fields, and an arrow for each reference and each field
 * of lines, from the field's row to the entity it names. The layout is the studio's own: an entity
 * goes to the right of the entities that refer to it or hold it as lines.
 */

export interface ModelBox {
  readonly entity: string;
  readonly x: number;
  readonly y: number;
  readonly height: number;
}

export interface ModelArrow {
  readonly from: { readonly entity: string; readonly field: string };
  readonly to: string;
  readonly kind: 'reference' | 'lines';
  /** At right angles, with rounded corners, short of its head. */
  readonly d: string;
  readonly head: { readonly x: number; readonly y: number; readonly dir: 'left' | 'right' };
  readonly label: { readonly text: string; readonly x: number; readonly y: number };
}

// Ocean's sizes at its root size (15px): an entity 15rem wide, a head, and a row for each field.
export const BOX_W = 225;
export const HEAD_H = 44;
export const ROW_H = 27;
const LIST_PAD = 12;
const COLUMN_GAP = 120;
const ROW_GAP = 36;
const MARGIN = 24;

/** The entity a field points at: a reference's, or the entity that holds its lines. */
export const targetOf = (field: Field): string | undefined => (field.type === 'reference' || field.type === 'lines' ? field.entity : undefined);

/** Where a field's row is, on its entity's box: its middle. */
export const rowY = (box: ModelBox, index: number): number => box.y + HEAD_H + LIST_PAD / 2 + index * ROW_H + ROW_H / 2;

export function layoutModel(definition: Definition): { readonly boxes: ModelBox[]; readonly arrows: ModelArrow[]; readonly width: number; readonly height: number } {
  const names = Object.keys(definition.entities);
  // Each entity goes one column to the right of the furthest entity that points at it.
  const column = new Map(names.map((name) => [name, 0]));
  for (let pass = 0; pass < names.length; pass++) {
    let moved = false;
    for (const name of names) {
      for (const field of definition.entities[name]!.fields) {
        const target = targetOf(field);
        if (!target || target === name || !column.has(target)) continue;
        const next = column.get(name)! + 1;
        // A loop of references would push forever: an entity goes no further right than there are entities.
        if (next > column.get(target)! && next < names.length) {
          column.set(target, next);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  const boxes: ModelBox[] = [];
  const heights = new Map<number, number>();
  for (const name of names) {
    const c = column.get(name)!;
    const y = heights.get(c) ?? MARGIN;
    // A row for each field, and one more that adds a field.
    const height = HEAD_H + LIST_PAD + (definition.entities[name]!.fields.length + 1) * ROW_H;
    boxes.push({ entity: name, x: MARGIN + c * (BOX_W + COLUMN_GAP), y, height });
    heights.set(c, y + height + ROW_GAP);
  }
  const at = new Map(boxes.map((box) => [box.entity, box]));
  const arrows: ModelArrow[] = [];
  for (const box of boxes) {
    definition.entities[box.entity]!.fields.forEach((field, index) => {
      const target = targetOf(field);
      const to = target ? at.get(target) : undefined;
      if (!to || !target) return;
      const kind = field.type === 'lines' ? 'lines' : 'reference';
      const x1 = box.x + BOX_W;
      const y1 = rowY(box, index);
      const y2 = to.y + HEAD_H / 2;
      // Into the head of the entity it names: from its left side when it stands further right, or round to its right side.
      const right = to.x > box.x;
      const x2 = right ? to.x : to.x + BOX_W;
      // It turns halfway across the gap, so its word stands clear of both boxes.
      const turn = right ? (x1 + x2) / 2 : Math.max(x1, x2) + 24;
      const end = right ? x2 - 9 : x2 + 9;
      const r = Math.min(8, Math.abs(y2 - y1) / 2);
      const down = Math.sign(y2 - y1);
      const d =
        Math.abs(y2 - y1) < 1
          ? `M${x1} ${y1} L${end} ${y2}`
          : `M${x1} ${y1} L${turn - r} ${y1} Q${turn} ${y1} ${turn} ${y1 + down * r} L${turn} ${y2 - down * r} Q${turn} ${y2} ${turn + (right ? r : -r)} ${y2} L${end} ${y2}`;
      arrows.push({
        from: { entity: box.entity, field: field.name },
        to: target,
        kind,
        d,
        head: { x: x2, y: y2, dir: right ? 'right' : 'left' },
        label: { text: kind === 'lines' ? 'its lines' : 'refers to', x: turn, y: (y1 + y2) / 2 },
      });
    });
  }
  const width = Math.max(...boxes.map((box) => box.x + BOX_W), 0) + MARGIN + 40;
  const height = Math.max(...boxes.map((box) => box.y + box.height), 0) + MARGIN;
  return { boxes, arrows, width, height };
}

/** A field's kind as the form designer tags it: letters for text, digits for numbers, or an icon. */
export function fieldTag(field: Field): { readonly text?: string; readonly icon?: 'list' | 'people' | 'clock' | 'report' | 'back' | 'check' } {
  switch (field.type) {
    case 'text':
      return { text: 'Aa' };
    case 'number':
      return { text: '12' };
    case 'choice':
    case 'lines':
      return { icon: 'list' };
    case 'user':
      return { icon: 'people' };
    case 'date':
    case 'datetime':
      return { icon: 'clock' };
    case 'file':
      return { icon: 'report' };
    case 'reference':
      return { icon: 'back' };
    case 'boolean':
      return { icon: 'check' };
    default:
      return { text: '·' };
  }
}

/** A short note on a field, where it helps: its choices, worked out, a file, or the entity a reference names. */
export function fieldNote(definition: Definition, field: Field): string | undefined {
  if (field.type === 'choice') return `${field.options.length} choice${field.options.length === 1 ? '' : 's'}`;
  if (isWorkedOut(field)) return 'worked out';
  if (field.type === 'file') return 'a file';
  if (field.type === 'reference') return definition.entities[field.entity]?.label;
  // Lines are named by their arrow.
  return undefined;
}

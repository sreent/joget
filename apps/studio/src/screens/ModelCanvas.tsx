import { useMemo } from 'react';
import { Icon } from '../components/icon.js';
import { cx } from '../components/ui.js';
import { BOX_W, fieldNote, fieldTag, HEAD_H, layoutModel, ROW_H } from '../model/datamodel.js';
import { lineOwner } from '../model/edit.js';
import type { Definition } from '../types.js';

/**
 * The data model on a canvas, as Ocean's ModelDesigner draws it: each entity a box of its fields,
 * with an arrow for each reference and each field of lines. Choosing an entity or a field opens it
 * beside the canvas, as in the list.
 */
export function ModelCanvas({
  definition,
  entity,
  field,
  onPick,
}: {
  definition: Definition;
  entity: string | null;
  field: number | null;
  onPick: (entity: string, field?: number) => void;
}) {
  const laid = useMemo(() => layoutModel(definition), [definition]);
  const triangle = (head: { x: number; y: number; dir: 'left' | 'right' }) =>
    head.dir === 'right' ? `M${head.x - 9} ${head.y - 4.6} L${head.x} ${head.y} L${head.x - 9} ${head.y + 4.6} Z` : `M${head.x + 9} ${head.y - 4.6} L${head.x} ${head.y} L${head.x + 9} ${head.y + 4.6} Z`;
  return (
    <div className="flow h-[40rem] overflow-auto rounded-lg" data-testid="model-canvas" aria-label="The data model">
      <div className="relative" style={{ width: laid.width, height: laid.height }}>
        <svg className="logic-edges" aria-hidden="true" width={laid.width} height={laid.height}>
          {laid.arrows.map((arrow) => (
            <g key={`${arrow.from.entity}.${arrow.from.field}`}>
              <path d={arrow.d} />
              <path className="head" d={triangle(arrow.head)} />
            </g>
          ))}
        </svg>
        {laid.arrows.map((arrow) => (
          <span key={`${arrow.from.entity}.${arrow.from.field}`} className="flow-label" style={{ left: arrow.label.x, top: arrow.label.y }}>
            {arrow.label.text}
          </span>
        ))}
        {laid.boxes.map((box) => {
          const spec = definition.entities[box.entity]!;
          const owner = lineOwner(definition, box.entity);
          return (
            <div key={box.entity} className={cx('model-entity', box.entity === entity && 'ring-2 ring-focus')} style={{ left: box.x, top: box.y, width: BOX_W }} data-testid={`model-entity-${box.entity}`}>
              <button
                type="button"
                className="model-head w-full overflow-hidden rounded-none border-0 border-b bg-transparent text-left"
                style={{ height: HEAD_H }}
                aria-label={`Open the entity ${spec.label}`}
                onClick={() => onPick(box.entity)}
              >
                <strong>{spec.label}</strong>
                <span>{owner ? `the lines of ${(definition.entities[owner.parent]?.label ?? owner.parent).toLowerCase()}` : box.entity}</span>
              </button>
              <ul>
                {spec.fields.map((each, index) => {
                  const tag = fieldTag(each);
                  const note = fieldNote(definition, each);
                  return (
                    <li key={each.name} className={cx(box.entity === entity && index === field && 'chosen')} style={{ height: ROW_H }}>
                      <button type="button" className="flex w-full min-w-0 items-center gap-2 border-0 bg-transparent p-0 text-left" aria-label={`Open the field ${spec.label}: ${each.label}`} onClick={() => onPick(box.entity, index)}>
                        <span className="fd-type">{tag.icon ? <Icon name={tag.icon} /> : tag.text}</span>
                        <span className="truncate">{each.label}</span>
                        {each.type !== 'lines' && each.classification === 'pii' ? <span className="chip">PII</span> : null}
                        {note ? <span className="model-note">{note}</span> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

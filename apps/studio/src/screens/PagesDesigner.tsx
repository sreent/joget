import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useState, type ReactNode } from 'react';
import { ConditionEditor, THE_PERSON } from '../components/condition.js';
import { Badge, Button, Card, cx, EmptyState, Field, Select, TextInput } from '../components/ui.js';
import { recordChoices } from '../model/conditions.js';
import { isName } from '../model/edit.js';
import {
  addBlock,
  addNavItem,
  addPage,
  changeListEntity,
  describeBlock,
  listable,
  moveBlock,
  moveNavItem,
  removeBlock,
  removeNavItem,
  removePage,
  renamePage,
  rowActions,
  setCustomMenu,
  setHome,
  SYSTEM_COLUMNS,
  updateBlock,
  updateNavItem,
  updatePage,
  groupPaths,
  newChart,
  numberPaths,
  type Block,
  type BlockType,
  type ChartBlock,
  type ListBlock,
  type Measure,
  type StatBlock,
  type NavItem,
  type PageButton,
} from '../model/pages.js';
import type { Definition } from '../types.js';
import { Checklist, Choice } from './LogicDesigners.js';

type Props = { definition: Definition; onChange: (definition: Definition) => void };

const BLOCK_NAMES: Readonly<Record<BlockType, string>> = { text: 'Text', list: 'List', buttons: 'Buttons', stat: 'Number', chart: 'Chart' };

/** A vertical list whose rows drag to reorder, by a handle, or with the keyboard. */
function SortableRows({ ids, onMove, children }: { ids: string[]; onMove: (from: number, to: number) => void; children: ReactNode }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onMove(ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="m-0 grid list-none grid-cols-1 gap-1.5 p-0">{children}</ul>
      </SortableContext>
    </DndContext>
  );
}

function Row({ id, label, selected, onSelect, children }: { id: string; label: string; selected?: boolean; onSelect?: () => void; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx('flex items-center gap-2 rounded-md border bg-surface px-2 py-1.5', selected ? 'border-accent' : 'border-line', isDragging && 'opacity-60 shadow-raised')}
    >
      <button type="button" aria-label={`Move ${label}`} className="cursor-grab rounded px-1 text-faint hover:text-text" {...attributes} {...listeners}>
        ⠿
      </button>
      {onSelect ? (
        <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {children}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
      )}
    </li>
  );
}

/** Pages: blocks of text, lists of records and buttons, top to bottom, and who each page is for. */
export function PagesDesigner({ definition, onChange }: Props) {
  const pages = Object.keys(definition.pages);
  const [selected, setSelected] = useState<string | null>(pages[0] ?? null);
  const [block, setBlock] = useState<number | null>(null);
  const [label, setLabel] = useState('');
  const current = selected && definition.pages[selected] ? selected : (pages[0] ?? null);

  return (
    <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)_22rem]">
      <Card className="grid content-start gap-3 p-4">
        <h2 className="m-0 text-sm font-semibold text-muted">Pages</h2>
        <ul className="m-0 grid list-none gap-1 p-0">
          {pages.map((name) => (
            <li key={name}>
              <button
                type="button"
                onClick={() => {
                  setSelected(name);
                  setBlock(null);
                }}
                aria-current={name === current ? 'true' : undefined}
                className={cx('w-full rounded-md px-2.5 py-1.5 text-left', name === current ? 'bg-accent-soft' : 'hover:bg-sunken')}
              >
                <span className="block font-medium">{definition.pages[name]!.label}</span>
                <span className="text-xs text-faint">{definition.navigation?.home === name ? 'Home · ' : ''}{definition.pages[name]!.blocks.length} block(s)</span>
              </button>
            </li>
          ))}
        </ul>
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!label.trim()) return;
            const result = addPage(definition, label.trim());
            onChange(result.definition);
            setSelected(result.name);
            setBlock(0);
            setLabel('');
          }}
        >
          <TextInput aria-label="New page" placeholder="New page, e.g. To approve" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Button type="submit" size="sm" disabled={!label.trim()}>
            Add page
          </Button>
        </form>
      </Card>

      {current ? (
        <PageCanvas
          definition={definition}
          onChange={onChange}
          name={current}
          block={block}
          onBlock={setBlock}
          onRename={setSelected}
          onRemove={() => {
            onChange(removePage(definition, current));
            setSelected(null);
            setBlock(null);
          }}
        />
      ) : (
        <EmptyState title="No pages yet">A page brings together lists of records, buttons and text, for each kind of person who uses the app. Without pages, an app shows its forms and lists.</EmptyState>
      )}

      {current && block !== null && definition.pages[current]?.blocks[block] ? (
        <Card className="grid content-start gap-3">
          <h2 className="m-0 text-lg font-semibold">{BLOCK_NAMES[definition.pages[current]!.blocks[block]!.type]}</h2>
          <BlockPanel definition={definition} onChange={onChange} page={current} index={block} />
        </Card>
      ) : (
        <Card className="grid content-start">
          <p className="m-0 text-sm text-muted">Select a block to change it.</p>
        </Card>
      )}
    </div>
  );
}

function PageCanvas(props: Props & { name: string; block: number | null; onBlock: (index: number | null) => void; onRename: (name: string) => void; onRemove: () => void }) {
  const { definition, onChange, name } = props;
  const page = definition.pages[name]!;
  const [newName, setNewName] = useState(name);
  useEffect(() => setNewName(name), [name]);
  const roles = Object.entries(definition.roles);
  const ids = page.blocks.map((_, index) => `block:${index}`);
  const add = (type: BlockType) => {
    const result = addBlock(definition, name, type);
    if (result.index === -1) return;
    onChange(result.definition);
    props.onBlock(result.index);
  };
  const can = (type: BlockType) => addBlock(definition, name, type).index !== -1;

  return (
    // One column that may shrink, so that a long block description truncates and does not widen the card.
    <Card className="grid grid-cols-1 content-start gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Label">{(id) => <TextInput id={id} value={page.label} onChange={(e) => onChange(updatePage(definition, name, { label: e.target.value }))} />}</Field>
        <Field label="Name" hint="Links to the page use it.">
          {(id) => (
            <TextInput
              id={id}
              className="mono"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onBlur={() => {
                if (newName === name) return;
                if (!isName(newName) || newName in definition.pages) {
                  setNewName(name);
                  return;
                }
                onChange(renamePage(definition, name, newName));
                props.onRename(newName);
              }}
            />
          )}
        </Field>
      </div>
      <Field label="Description (optional)">
        {(id) => <TextInput id={id} value={page.description ?? ''} onChange={(e) => onChange(updatePage(definition, name, { description: e.target.value }))} />}
      </Field>
      {roles.length ? (
        <Checklist
          label="Shown to"
          options={roles.map(([role, r]) => ({ value: role, label: r.label }))}
          selected={page.roles ?? []}
          onChange={(next) => onChange(updatePage(definition, name, { roles: next }))}
          hint="None ticked: everyone who may use something on it. This tidies screens; the data's own permissions protect it."
        />
      ) : null}

      <div className="grid grid-cols-1 gap-2">
        <h3 className="m-0 text-sm font-semibold text-muted">Blocks, top to bottom</h3>
        <SortableRows
          ids={ids}
          onMove={(from, to) => {
            onChange(moveBlock(definition, name, from, to));
            if (props.block === from) props.onBlock(to);
          }}
        >
          {page.blocks.map((block, index) => (
            <Row key={ids[index]} id={ids[index]!} label={`${BLOCK_NAMES[block.type]} block ${index + 1}`} selected={props.block === index} onSelect={() => props.onBlock(index)}>
              <Badge tone={block.type === 'list' ? 'accent' : block.type === 'buttons' ? 'good' : block.type === 'stat' || block.type === 'chart' ? 'agent' : 'idle'}>{block.type === 'text' && block.style === 'heading' ? 'Heading' : BLOCK_NAMES[block.type]}</Badge>
              <span className="min-w-0 flex-1 truncate" title={describeBlock(definition, block)}>
                {describeBlock(definition, block)}
              </span>
            </Row>
          ))}
        </SortableRows>
        <div className="flex flex-wrap gap-2">
          {(['text', 'list', 'buttons', 'stat', 'chart'] as const).map((type) => (
            <Button key={type} size="sm" onClick={() => add(type)} disabled={!can(type)} title={can(type) ? undefined : type === 'list' ? 'Add an entity first' : 'Add a form or another page first'}>
              Add {BLOCK_NAMES[type].toLowerCase()}
            </Button>
          ))}
          {props.block !== null && page.blocks.length > 1 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onChange(removeBlock(definition, name, props.block!));
                props.onBlock(null);
              }}
            >
              Remove the selected block
            </Button>
          ) : null}
        </div>
      </div>
      <div className="border-t border-line pt-3">
        <Button variant="danger" size="sm" onClick={props.onRemove}>
          Delete {page.label}
        </Button>
      </div>
    </Card>
  );
}

function BlockPanel({ definition, onChange, page, index }: Props & { page: string; index: number }) {
  const block = definition.pages[page]!.blocks[index]!;
  const set = (patch: Record<string, unknown>) => onChange(updateBlock(definition, page, index, patch));
  if (block.type === 'text') {
    return (
      <>
        <Choice
          label="Shown as"
          value={block.style}
          options={[
            { value: 'heading', label: 'A heading' },
            { value: 'paragraph', label: 'A paragraph' },
            { value: 'note', label: 'A note that stands out', hint: 'For a hint or a warning' },
          ]}
          onChange={(style) => set({ style })}
        />
        <Field label="Text">
          {(id) => <textarea id={id} rows={block.style === 'heading' ? 1 : 4} className="w-full rounded-sm border border-line-strong bg-surface px-2.5 py-1.5" value={block.text} onChange={(e) => set({ text: e.target.value })} />}
        </Field>
      </>
    );
  }
  if (block.type === 'buttons') return <ButtonsPanel definition={definition} buttons={block.buttons} onButtons={(buttons) => set({ buttons })} page={page} />;
  if (block.type === 'stat' || block.type === 'chart') return <SummaryPanel definition={definition} block={block} set={set} />;
  return <ListPanel definition={definition} onChange={onChange} page={page} index={index} block={block} set={set} />;
}

const OPS: ReadonlyArray<{ value: Measure['op']; label: string }> = [
  { value: 'count', label: 'How many' },
  { value: 'sum', label: 'The total of' },
  { value: 'avg', label: 'The average of' },
  { value: 'min', label: 'The smallest' },
  { value: 'max', label: 'The largest' },
];
const WITHIN = [
  { value: 'this_month', label: 'this month' },
  { value: 'this_quarter', label: 'this quarter' },
  { value: 'this_year', label: 'this year' },
  { value: 'last_30_days', label: 'the last 30 days' },
  { value: 'last_90_days', label: 'the last 90 days' },
  { value: 'last_12_months', label: 'the last 12 months' },
] as const;
const PERIOD_NAMES = { day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' } as const;

/** A number or a chart: what it works out, over which records, and, for a chart, by what and how it shows. */
function SummaryPanel({ definition, block, set }: { definition: Definition; block: StatBlock | ChartBlock; set: (patch: Record<string, unknown>) => void }) {
  const numbers = numberPaths(definition, block.entity);
  const linesFields = (definition.entities[block.entity]?.fields ?? []).filter((field) => field.type === 'lines');
  const groups = groupPaths(definition, block.entity);
  const dated = groups.filter((g) => g.dated);
  const chart = block.type === 'chart' ? block : null;
  const grouped = chart ? groups.find((g) => g.value === chart.group.field) : undefined;
  const { measure } = block;
  return (
    <>
      {chart ? (
        <Field label="Title">{(id) => <TextInput id={id} value={chart.title} onChange={(e) => set({ title: e.target.value })} />}</Field>
      ) : (
        <Field label="Label">{(id) => <TextInput id={id} value={(block as StatBlock).label} onChange={(e) => set({ label: e.target.value })} />}</Field>
      )}
      <Field label="Of">
        {(id) => (
          <Select
            id={id}
            value={block.entity}
            onChange={(e) =>
              set(chart ? { ...newChart(definition, e.target.value), title: chart.title, filter: undefined, range: undefined } : { entity: e.target.value, measure: { op: 'count' }, filter: undefined, range: undefined })
            }
          >
            {listable(definition).map((entity) => (
              <option key={entity} value={entity}>
                {definition.entities[entity]!.pluralLabel ?? definition.entities[entity]!.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Works out">
          {(id) => (
            <Select
              id={id}
              value={measure.op}
              onChange={(e) => {
                const op = e.target.value as Measure['op'];
                set({ measure: op === 'count' ? { op } : { op, field: measure.field && numbers.some((n) => n.value === measure.field) ? measure.field : numbers[0]!.value } });
              }}
            >
              {OPS.map((op) => (
                <option key={op.value} value={op.value} disabled={op.value !== 'count' && !numbers.length}>
                  {op.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={measure.op === 'count' ? 'Counting' : 'Field'}>
          {(id) => (
            <Select id={id} value={measure.field ?? ''} onChange={(e) => set({ measure: e.target.value ? { op: measure.op, field: e.target.value } : { op: 'count' } })}>
              {measure.op === 'count' ? (
                <>
                  <option value="">Records</option>
                  {linesFields.map((field) => (
                    <option key={field.name} value={field.name}>
                      {field.label}, one per line
                    </option>
                  ))}
                </>
              ) : (
                numbers.map((n) => (
                  <option key={n.value} value={n.value}>
                    {n.label}
                  </option>
                ))
              )}
            </Select>
          )}
        </Field>
      </div>
      {chart ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="For each">
              {(id) => (
                <Select
                  id={id}
                  value={chart.group.field}
                  onChange={(e) => {
                    const next = groups.find((g) => g.value === e.target.value)!;
                    set({ group: next.dated ? { field: next.value, period: chart.group.period ?? 'month' } : { field: next.value }, ...(next.dated ? {} : chart.show === 'line' ? { show: 'bar' } : {}) });
                  }}
                >
                  {groups.map((g) => (
                    <option key={g.value} value={g.value}>
                      {g.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {grouped?.dated ? (
              <Field label="By">
                {(id) => (
                  <Select id={id} value={chart.group.period ?? 'month'} onChange={(e) => set({ group: { field: chart.group.field, period: e.target.value } })}>
                    {Object.entries(PERIOD_NAMES).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
          </div>
          <Choice
            label="Shown as"
            value={chart.show}
            options={[
              { value: 'bar', label: 'Bars, largest first', hint: 'To compare groups' },
              { value: 'column', label: 'Columns', hint: 'For periods, in order' },
              ...(chart.group.period ? [{ value: 'line' as const, label: 'A line over time', hint: 'For a trend' }] : []),
              { value: 'table', label: 'A table' },
            ]}
            onChange={(show) => set({ show })}
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label={chart.group.period ? 'Latest periods' : 'Largest groups'} hint={chart.group.period ? undefined : 'The rest show as Other.'}>
              {(id) => <TextInput id={id} type="number" min={2} max={24} value={chart.limit ?? 8} onChange={(e) => set({ limit: Math.min(24, Math.max(2, Number(e.target.value) || 2)) })} />}
            </Field>
            <Field label="Width">
              {(id) => (
                <Select id={id} value={chart.width ?? 'half'} onChange={(e) => set({ width: e.target.value })}>
                  <option value="half">Half</option>
                  <option value="full">Full</option>
                </Select>
              )}
            </Field>
          </div>
        </>
      ) : null}
      <ConditionEditor
        label="Only records where"
        value={block.filter}
        onChange={(filter) => set({ filter })}
        choices={recordChoices(definition, block.entity)}
        compareWith={[THE_PERSON]}
        empty="Every record the person may see."
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="When" hint="Times are in UTC.">
          {(id) => (
            <Select id={id} value={block.range?.field ?? ''} onChange={(e) => set({ range: e.target.value ? { field: e.target.value, within: block.range?.within ?? 'this_year' } : undefined })}>
              <option value="">Any time</option>
              {dated.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {block.range ? (
          <Field label="Within">
            {(id) => (
              <Select id={id} value={block.range!.within} onChange={(e) => set({ range: { field: block.range!.field, within: e.target.value } })}>
                {WITHIN.map((w) => (
                  <option key={w.value} value={w.value}>
                    {w.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
      </div>
    </>
  );
}

function ListPanel({ definition, onChange, page, index, block, set }: Props & { page: string; index: number; block: ListBlock; set: (patch: Record<string, unknown>) => void }) {
  const fields = (definition.entities[block.entity]?.fields ?? []).filter((field) => field.type !== 'lines');
  const columns = [...fields.map((field) => ({ value: field.name, label: field.label })), ...SYSTEM_COLUMNS];
  const sortable = [...fields.filter((field) => !(field.type === 'choice' && field.multiple)).map((field) => ({ value: field.name, label: field.label })), ...SYSTEM_COLUMNS];
  const sort = block.sort ?? [];
  const actions = rowActions(definition, block.entity);
  return (
    <>
      <Field label="Title (optional)">{(id) => <TextInput id={id} value={block.title ?? ''} onChange={(e) => set({ title: e.target.value || undefined })} />}</Field>
      <Field label="Lists">
        {(id) => (
          <Select id={id} value={block.entity} onChange={(e) => onChange(changeListEntity(definition, page, index, e.target.value))}>
            {listable(definition).map((entity) => (
              <option key={entity} value={entity}>
                {definition.entities[entity]!.pluralLabel ?? definition.entities[entity]!.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Checklist label="Columns" options={columns} selected={block.columns} onChange={(next) => (next.length ? set({ columns: next }) : undefined)} hint="People see only the columns their role may read." />
      <ConditionEditor
        label="Only records where"
        value={block.filter}
        onChange={(filter) => set({ filter })}
        choices={recordChoices(definition, block.entity)}
        compareWith={[THE_PERSON]}
        empty="Every record the person may see."
      />
      <div className="grid gap-2">
        <span className="text-sm text-muted">Sorted by</span>
        {sort.map((key, s) => (
          <div key={s} className="flex flex-wrap items-center gap-2">
            <Select aria-label={`Sort ${s + 1}`} className="w-auto" value={key.field} onChange={(e) => set({ sort: sort.map((k, i) => (i === s ? { ...k, field: e.target.value } : k)) })}>
              {sortable.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <Select aria-label={`Direction ${s + 1}`} className="w-auto" value={key.direction ?? 'asc'} onChange={(e) => set({ sort: sort.map((k, i) => (i === s ? { ...k, direction: e.target.value as 'asc' | 'desc' } : k)) })}>
              <option value="asc">lowest or oldest first</option>
              <option value="desc">highest or newest first</option>
            </Select>
            <Button size="sm" variant="ghost" aria-label={`Remove sort ${s + 1}`} onClick={() => set({ sort: sort.filter((_, i) => i !== s) })}>
              ✕
            </Button>
          </div>
        ))}
        {sort.length < 3 && sortable[0] ? (
          <div>
            <Button size="sm" onClick={() => set({ sort: [...sort, { field: sortable[0]!.value, direction: 'asc' }] })}>
              Add a sort
            </Button>
          </div>
        ) : null}
      </div>
      <Field label="Shows at first">
        {(id) => <TextInput id={id} type="number" className="w-28" min={1} max={100} value={block.limit ?? 20} onChange={(e) => set({ limit: Math.min(100, Math.max(1, Number(e.target.value) || 1)) })} />}
      </Field>
      {actions.length ? (
        <Checklist
          label="Runs on each row"
          options={actions.map((action) => ({ value: action, label: definition.actions[action]!.label }))}
          selected={block.actions ?? []}
          onChange={(next) => set({ actions: next })}
          hint="Actions that change a record and take no input. Each person sees only those they may run."
        />
      ) : null}
      <Field label="When there are none">{(id) => <TextInput id={id} placeholder="Nothing here yet." value={block.empty ?? ''} onChange={(e) => set({ empty: e.target.value || undefined })} />}</Field>
    </>
  );
}

function ButtonsPanel({ definition, buttons, onButtons, page }: { definition: Definition; buttons: PageButton[]; onButtons: (buttons: PageButton[]) => void; page: string }) {
  const forms = Object.entries(definition.forms);
  const pages = Object.entries(definition.pages).filter(([name]) => name !== page);
  const targets = (kind: 'form' | 'page') => (kind === 'form' ? forms.map(([name, form]) => ({ value: name, label: form.label })) : pages.map(([name, p]) => ({ value: name, label: p.label })));
  const kindOf = (button: PageButton): 'form' | 'page' => ('form' in button ? 'form' : 'page');
  const target = (button: PageButton) => ('form' in button ? button.form : button.page);
  const make = (kind: 'form' | 'page', value: string, label?: string): PageButton => (kind === 'form' ? { form: value, ...(label ? { label } : {}) } : { page: value, ...(label ? { label } : {}) });
  return (
    <div className="grid gap-3">
      {buttons.map((button, b) => (
        <div key={b} className="grid gap-2 rounded-md border border-line p-2">
          <div className="flex flex-wrap gap-2">
            <Select
              aria-label={`Button ${b + 1} opens`}
              className="w-auto"
              value={kindOf(button)}
              onChange={(e) => {
                const kind = e.target.value as 'form' | 'page';
                const first = targets(kind)[0];
                if (first) onButtons(buttons.map((existing, i) => (i === b ? make(kind, first.value) : existing)));
              }}
            >
              <option value="form" disabled={!forms.length}>
                A form
              </option>
              <option value="page" disabled={!pages.length}>
                A page
              </option>
            </Select>
            <Select aria-label={`Button ${b + 1} target`} className="min-w-40 flex-1" value={target(button)} onChange={(e) => onButtons(buttons.map((existing, i) => (i === b ? make(kindOf(existing), e.target.value, existing.label) : existing)))}>
              {targets(kindOf(button)).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex gap-2">
            <TextInput aria-label={`Button ${b + 1} label`} placeholder="Its own label" value={button.label ?? ''} onChange={(e) => onButtons(buttons.map((existing, i) => (i === b ? make(kindOf(existing), target(existing), e.target.value || undefined) : existing)))} />
            {buttons.length > 1 ? (
              <Button size="sm" variant="ghost" aria-label={`Remove button ${b + 1}`} onClick={() => onButtons(buttons.filter((_, i) => i !== b))}>
                ✕
              </Button>
            ) : null}
          </div>
        </div>
      ))}
      {buttons.length < 8 && (forms[0] ?? pages[0]) ? (
        <div>
          <Button size="sm" onClick={() => onButtons([...buttons, forms[0] ? { form: forms[0][0] } : { page: pages[0]![0] }])}>
            Add a button
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// The menu

const ITEM_KINDS = { page: 'Page', form: 'Form', entity: 'List', heading: 'Heading' } as const;
type ItemKind = keyof typeof ITEM_KINDS;
const kindOfItem = (item: NavItem): ItemKind => ('page' in item ? 'page' : 'form' in item ? 'form' : 'entity' in item ? 'entity' : 'heading');

/** The app's menu: its items in order, under headings, and the page it opens on. */
export function MenuDesigner({ definition, onChange }: Props) {
  const navigation = definition.navigation;
  const pages = Object.entries(definition.pages);
  const forms = Object.entries(definition.forms);
  const entities = listable(definition);
  const targets = (kind: Exclude<ItemKind, 'heading'>) =>
    kind === 'page'
      ? pages.map(([name, page]) => ({ value: name, label: page.label }))
      : kind === 'form'
        ? forms.map(([name, form]) => ({ value: name, label: form.label }))
        : entities.map((name) => ({ value: name, label: definition.entities[name]!.pluralLabel ?? definition.entities[name]!.label }));
  const labelOf = (item: NavItem): string => {
    if ('heading' in item) return item.heading;
    if (item.label) return item.label;
    const kind = kindOfItem(item) as Exclude<ItemKind, 'heading'>;
    const value = 'page' in item ? item.page : 'form' in item ? item.form : item.entity;
    return targets(kind).find((option) => option.value === value)?.label ?? value;
  };
  // A new item opens what the menu does not have yet, so that adding one is seldom followed by a change.
  const targetOf = (item: NavItem) => ('page' in item ? item.page : 'form' in item ? item.form : 'entity' in item ? item.entity : undefined);
  const firstNew = (kind: Exclude<ItemKind, 'heading'>) =>
    targets(kind).find((option) => !navigation?.items.some((item) => kindOfItem(item) === kind && targetOf(item) === option.value)) ?? targets(kind)[0];
  const make = (kind: ItemKind, value: string, label?: string): NavItem =>
    kind === 'heading' ? { heading: value } : kind === 'page' ? { page: value, ...(label ? { label } : {}) } : kind === 'form' ? { form: value, ...(label ? { label } : {}) } : { entity: value, ...(label ? { label } : {}) };
  const ids = (navigation?.items ?? []).map((_, index) => `item:${index}`);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <Card className="grid content-start gap-4">
        <Choice
          label="The menu"
          value={navigation ? 'custom' : 'default'}
          options={[
            { value: 'default', label: 'Every form and list, as they come', hint: 'Each person sees the forms and lists they may use.' },
            { value: 'custom', label: 'Our own menu', hint: 'Pages, forms and lists in the order you choose, under headings. Each person still sees only what they may use.' },
          ]}
          onChange={(value) => onChange(setCustomMenu(definition, value === 'custom'))}
        />
        {navigation ? (
          <>
            <Field label="Opens on">
              {(id) => (
                <Select id={id} className="w-72" value={navigation.home ?? ''} onChange={(e) => onChange(setHome(definition, e.target.value || undefined))}>
                  <option value="">Its first menu item</option>
                  {pages.map(([name, page]) => (
                    <option key={name} value={name}>
                      {page.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="grid gap-2">
              <h3 className="m-0 text-sm font-semibold text-muted">Items, top to bottom</h3>
              {navigation.items.length === 0 ? <p className="m-0 text-sm text-muted">The menu is empty.</p> : null}
              <SortableRows ids={ids} onMove={(from, to) => onChange(moveNavItem(definition, from, to))}>
                {navigation.items.map((item, index) => {
                  const kind = kindOfItem(item);
                  return (
                    <Row key={ids[index]} id={ids[index]!} label={labelOf(item)}>
                      <Badge tone={kind === 'heading' ? 'idle' : 'accent'}>{ITEM_KINDS[kind]}</Badge>
                      {kind === 'heading' ? (
                        <TextInput aria-label={`Heading ${index + 1}`} className="min-w-40 flex-1" value={labelOf(item)} onChange={(e) => onChange(updateNavItem(definition, index, make('heading', e.target.value)))} />
                      ) : (
                        <>
                          <Select
                            aria-label={`Item ${index + 1} opens`}
                            className="w-48"
                            value={'page' in item ? item.page : 'form' in item ? item.form : 'entity' in item ? item.entity : ''}
                            onChange={(e) => onChange(updateNavItem(definition, index, make(kind, e.target.value, 'label' in item ? item.label : undefined)))}
                          >
                            {targets(kind).map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                          <TextInput
                            aria-label={`Item ${index + 1} label`}
                            className="min-w-32 flex-1"
                            placeholder="Its own label"
                            value={'label' in item ? (item.label ?? '') : ''}
                            onChange={(e) =>
                              onChange(updateNavItem(definition, index, make(kind, 'page' in item ? item.page : 'form' in item ? item.form : 'entity' in item ? item.entity : '', e.target.value || undefined)))
                            }
                          />
                        </>
                      )}
                      <Button size="sm" variant="ghost" aria-label={`Remove ${labelOf(item)}`} onClick={() => onChange(removeNavItem(definition, index))}>
                        ✕
                      </Button>
                    </Row>
                  );
                })}
              </SortableRows>
              <div className="flex flex-wrap gap-2">
                {(['page', 'form', 'entity'] as const).map((kind) => (
                  <Button key={kind} size="sm" disabled={!targets(kind)[0]} onClick={() => onChange(addNavItem(definition, make(kind, firstNew(kind)!.value)))}>
                    Add {kind === 'entity' ? 'a list' : `a ${kind}`}
                  </Button>
                ))}
                <Button size="sm" onClick={() => onChange(addNavItem(definition, make('heading', 'New heading')))}>
                  Add a heading
                </Button>
              </div>
            </div>
          </>
        ) : null}
      </Card>

      <Card className="grid content-start gap-2">
        <h2 className="m-0 text-sm font-semibold text-muted">How it looks</h2>
        <p className="m-0 text-xs text-faint">Each person sees only the items they may use.</p>
        <ul className="m-0 grid list-none gap-1 p-0">
          {(navigation ? navigation.items : [...forms.map(([form]) => ({ form }) as NavItem), ...entities.map((entity) => ({ entity }) as NavItem)]).map((item, index) =>
            'heading' in item ? (
              <li key={index} className="mt-2 text-xs font-semibold tracking-wide text-faint uppercase">
                {item.heading}
              </li>
            ) : (
              <li key={index} className={cx('rounded-md px-2.5 py-1.5 text-sm', 'form' in item ? 'bg-accent-soft font-medium text-accent' : 'text-muted')}>
                {'form' in item ? '+ ' : ''}
                {labelOf(item)}
                {'page' in item && navigation?.home === item.page ? <span className="ml-2 text-xs text-faint">(home)</span> : null}
              </li>
            ),
          )}
        </ul>
      </Card>
    </div>
  );
}

export type { Block, ListBlock };

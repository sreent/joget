import { type ChartBlock, groupPaths, type Measure, numberPaths } from '../model/pages.js';
import type { Definition } from '../types.js';
import { Field, Select } from './ui.js';

/**
 * What a number works out, by what it groups and over which time: the controls that a dashboard's
 * numbers and charts share with queries that answer with numbers.
 */

type Group = ChartBlock['group'];
type Range = NonNullable<ChartBlock['range']>;

export const OPS: ReadonlyArray<{ value: Measure['op']; label: string }> = [
  { value: 'count', label: 'How many' },
  { value: 'sum', label: 'The total of' },
  { value: 'avg', label: 'The average of' },
  { value: 'min', label: 'The smallest' },
  { value: 'max', label: 'The largest' },
];
export const WITHIN = [
  { value: 'this_month', label: 'this month' },
  { value: 'this_quarter', label: 'this quarter' },
  { value: 'this_year', label: 'this year' },
  { value: 'last_30_days', label: 'the last 30 days' },
  { value: 'last_90_days', label: 'the last 90 days' },
  { value: 'last_12_months', label: 'the last 12 months' },
] as const;
export const PERIOD_NAMES = { day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' } as const;

/** How many records or lines, or the total, average, smallest or largest of a number field. */
export function MeasureFields({
  definition,
  entity,
  measure,
  onChange,
}: {
  definition: Definition;
  entity: string;
  measure: Measure;
  onChange: (measure: Measure) => void;
}) {
  const numbers = numberPaths(definition, entity);
  const linesFields = (definition.entities[entity]?.fields ?? []).filter((field) => field.type === 'lines');
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field label="Works out">
        {(id) => (
          <Select
            id={id}
            value={measure.op}
            onChange={(e) => {
              const op = OPS.find((o) => o.value === e.target.value)?.value ?? 'count';
              onChange(
                op === 'count' ? { op } : { op, field: measure.field && numbers.some((n) => n.value === measure.field) ? measure.field : numbers[0]!.value },
              );
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
          <Select id={id} value={measure.field ?? ''} onChange={(e) => onChange(e.target.value ? { op: measure.op, field: e.target.value } : { op: 'count' })}>
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
  );
}

/** What the numbers are for each of: a field, or periods of a date. */
export function GroupFields({
  definition,
  entity,
  group,
  onChange,
}: {
  definition: Definition;
  entity: string;
  group: Group;
  onChange: (group: Group) => void;
}) {
  const groups = groupPaths(definition, entity);
  const grouped = groups.find((g) => g.value === group.field);
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field label="For each">
        {(id) => (
          <Select
            id={id}
            value={group.field}
            onChange={(e) => {
              const next = groups.find((g) => g.value === e.target.value);
              if (next) onChange(next.dated ? { field: next.value, period: group.period ?? 'month' } : { field: next.value });
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
            <Select
              id={id}
              value={group.period ?? 'month'}
              onChange={(e) =>
                onChange({
                  field: group.field,
                  period: (Object.keys(PERIOD_NAMES) as Array<keyof typeof PERIOD_NAMES>).find((p) => p === e.target.value) ?? 'month',
                })
              }
            >
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
  );
}

/** Only records, or lines, of a recent time. */
export function RangeFields({
  definition,
  entity,
  range,
  onChange,
}: {
  definition: Definition;
  entity: string;
  range: Range | undefined;
  onChange: (range: Range | undefined) => void;
}) {
  const dated = groupPaths(definition, entity).filter((g) => g.dated);
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field label="When" hint="Times are in UTC.">
        {(id) => (
          <Select
            id={id}
            value={range?.field ?? ''}
            onChange={(e) => onChange(e.target.value ? { field: e.target.value, within: range?.within ?? 'this_year' } : undefined)}
          >
            <option value="">Any time</option>
            {dated.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {range ? (
        <Field label="Within">
          {(id) => (
            <Select
              id={id}
              value={range.within}
              onChange={(e) => onChange({ field: range.field, within: WITHIN.find((w) => w.value === e.target.value)?.value ?? range.within })}
            >
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
  );
}

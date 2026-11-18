import { type ReactNode, useEffect, useRef, useState } from 'react';
import { usePerson } from './people.js';
import { Button, cx } from './ui.js';

/*
 * Dashboard figures: a number tile, and charts of one series (bars ranked by value, columns and a
 * line over time) with a table view of every chart. One series has one colour, `--chart-series`,
 * checked against both card surfaces; text never takes it. Thin marks with rounded data ends,
 * hairline solid grids, a tooltip on hover and on keyboard focus, and the values reachable without
 * hovering, through direct labels or the table.
 */

export interface ChartGroup {
  readonly key: string | null;
  readonly label: string | null;
  readonly value: number | null;
}

export interface ChartData {
  readonly groups: readonly ChartGroup[];
  /** The groups that didn't fit, as one, where their parts add up. */
  readonly other: number | null;
  /** How many groups didn't fit. */
  readonly more: number;
}

export interface ChartSpec {
  readonly title: string;
  readonly show: 'bar' | 'column' | 'line' | 'table';
  readonly decimals: number;
  readonly group: { readonly label: string; readonly kind: 'value' | 'person' | 'period'; readonly period?: string };
}

/** A value as people read it: grouped digits, the field's decimals, and big numbers shortened where asked. */
export function formatValue(value: number | null, decimals: number, compact = false): string {
  if (value === null || Number.isNaN(value)) return '—';
  if (compact && Math.abs(value) >= 10_000) return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
  return new Intl.NumberFormat(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
}

/** A period's first day as a label: Nov 2026, Q4 2026, 2026, the week of 16 Nov, or 17 Nov. Periods are in UTC. */
export function periodLabel(key: string | null, period: string | undefined, short = false): string {
  if (!key) return 'None';
  const date = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return key;
  const fmt = (options: Intl.DateTimeFormatOptions) => date.toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
  switch (period) {
    case 'year':
      return String(date.getUTCFullYear());
    case 'quarter':
      return `Q${Math.floor(date.getUTCMonth() / 3) + 1}${short ? '' : ` ${date.getUTCFullYear()}`}`;
    case 'month':
      return short ? fmt({ month: 'short' }) : fmt({ month: 'short', year: 'numeric' });
    case 'week':
      return short ? fmt({ day: 'numeric', month: 'short' }) : `Week of ${fmt({ day: 'numeric', month: 'short', year: 'numeric' })}`;
    default:
      return fmt({ day: 'numeric', month: 'short', ...(short ? {} : { year: 'numeric' }) });
  }
}

/** Round, readable axis ticks from zero to at least the largest value: 0, 250, 500… */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let tick = 0; tick < max + step * 0.5 && ticks.length <= count + 1; tick += step) ticks.push(Number(tick.toFixed(10)));
  if (ticks.at(-1)! < max) ticks.push(Number((ticks.at(-1)! + step).toFixed(10)));
  return ticks;
}

/** The text of a group, for labels drawn as text: people by name, periods as dates, values as they are. */
function GroupName({ group, spec, short = false }: { group: ChartGroup; spec: ChartSpec; short?: boolean }) {
  const person = usePerson(spec.group.kind === 'person' ? group.key : null);
  if (spec.group.kind === 'person') return <>{group.key ? (person.data?.name ?? '…') : 'Nobody'}</>;
  if (spec.group.kind === 'period') return <>{periodLabel(group.key, spec.group.period, short)}</>;
  return <>{group.label ?? group.key ?? 'None'}</>;
}

/** The container's width, kept up to date: charts draw to fit their card. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(element);
    setWidth(Math.floor(element.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** One number, as a dashboard tile: its label, then the value, in the same sans as everything else. */
export function StatTile({
  label,
  value,
  decimals,
  state,
}: {
  label: string;
  value: number | null | undefined;
  decimals: number;
  state: 'loading' | 'ready' | 'refused' | 'error';
}) {
  return (
    <section className="grid content-start gap-1 rounded-lg border border-line bg-surface p-4 shadow-card" aria-label={label}>
      <h3 className="m-0 text-sm font-normal text-muted">{label}</h3>
      <p className="m-0 text-3xl font-semibold tracking-tight text-text">
        {state === 'ready' ? formatValue(value ?? null, decimals, true) : state === 'loading' ? <span className="text-faint">…</span> : '—'}
      </p>
      {state === 'refused' ? <p className="m-0 text-xs text-faint">Your role can't see what this counts.</p> : null}
      {state === 'error' ? <p className="m-0 text-xs text-faint">This number can't be worked out now.</p> : null}
    </section>
  );
}

/** A chart in a card: its title, a switch to the table view, and the chart; held at half opacity while it refreshes. */
export function ChartCard({
  spec,
  data,
  state,
  refreshing,
}: {
  spec: ChartSpec;
  data: ChartData | undefined;
  state: 'loading' | 'ready' | 'refused' | 'error';
  refreshing: boolean;
}) {
  const [table, setTable] = useState(spec.show === 'table');
  const rows = data
    ? [...data.groups, ...(data.other !== null && data.more ? [{ key: null, label: `Other (${data.more})`, value: data.other } as ChartGroup] : [])]
    : [];
  return (
    <figure className="m-0 grid content-start gap-3 rounded-lg border border-line bg-surface p-4 shadow-card">
      <figcaption className="flex items-start justify-between gap-2">
        <h3 className="m-0 text-base font-semibold">{spec.title}</h3>
        {spec.show !== 'table' && state === 'ready' && rows.length ? (
          <Button size="sm" variant="ghost" aria-pressed={table} onClick={() => setTable(!table)}>
            {table ? 'Chart' : 'Table'}
          </Button>
        ) : null}
      </figcaption>
      <div className={cx('transition-opacity', refreshing && 'opacity-60')}>
        {state === 'loading' ? <p className="m-0 py-8 text-center text-sm text-faint">…</p> : null}
        {state === 'refused' ? <p className="m-0 py-6 text-center text-sm text-muted">Your role can't see what this chart counts.</p> : null}
        {state === 'error' ? <p className="m-0 py-6 text-center text-sm text-muted">This chart can't be worked out now.</p> : null}
        {state === 'ready' && !rows.length ? <p className="m-0 py-6 text-center text-sm text-muted">Nothing to show yet.</p> : null}
        {state === 'ready' && rows.length ? (
          table ? (
            <ChartTable spec={spec} rows={rows} />
          ) : spec.show === 'bar' ? (
            <Bars spec={spec} rows={rows} />
          ) : (
            <Plot spec={spec} rows={data!.groups} />
          )
        ) : null}
        {state === 'ready' && data && data.more && data.other === null ? (
          <p className="m-0 mt-2 text-xs text-faint">
            And {data.more} more not shown{spec.group.kind === 'period' ? ': the latest come first to mind' : ''}.
          </p>
        ) : null}
      </div>
    </figure>
  );
}

/** The table view: every group and its value, the twin of every chart. */
function ChartTable({ spec, rows }: { spec: ChartSpec; rows: readonly ChartGroup[] }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-line text-left text-muted">
          <th scope="col" className="py-1.5 pr-3 font-medium">
            {spec.group.label}
          </th>
          <th scope="col" className="py-1.5 text-right font-medium">
            Value
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={`${row.key}:${i}`} className="border-b border-line last:border-0">
            <td className="py-1.5 pr-3">{row.label?.startsWith('Other (') && row.key === null ? row.label : <GroupName group={row} spec={spec} />}</td>
            <td className="py-1.5 text-right tabular-nums">{formatValue(row.value, spec.decimals)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A tooltip: the value first and strong, the group after it. */
function Tip({ value, children }: { value: string; children: ReactNode }) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none absolute z-10 grid gap-0.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs whitespace-nowrap shadow-raised"
    >
      <strong className="text-sm text-text tabular-nums">{value}</strong>
      <span className="text-muted">{children}</span>
    </span>
  );
}

/** Ranked horizontal bars, one hue, each value at its bar's tip; the whole row is the hit target. */
function Bars({ spec, rows }: { spec: ChartSpec; rows: readonly ChartGroup[] }) {
  const max = Math.max(0, ...rows.map((row) => row.value ?? 0));
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.value ?? 0), 0);
  const [active, setActive] = useState<number | null>(null);
  return (
    <ul className="m-0 grid list-none gap-1 p-0" aria-label={spec.title}>
      {rows.map((row, i) => {
        const share = max > 0 && row.value ? Math.max(0.5, (row.value / max) * 100) : 0;
        const other = row.key === null && row.label?.startsWith('Other (');
        return (
          <li
            key={`${row.key}:${i}`}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a bar takes the focus, so that a keyboard shows its tooltip as the mouse does
            tabIndex={0}
            className="relative grid grid-cols-[minmax(5rem,9rem)_minmax(0,1fr)] items-center gap-3 rounded-sm py-1 outline-offset-2 hover:bg-sunken"
            onPointerEnter={() => setActive(i)}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            aria-label={`${row.label ?? row.key ?? 'None'}: ${formatValue(row.value, spec.decimals)}`}
          >
            <span className="truncate text-sm text-muted">{other ? row.label : <GroupName group={row} spec={spec} />}</span>
            <span className="flex min-w-0 items-center gap-2">
              <span className="h-4 rounded-r-[4px] bg-series" style={{ width: `${share}%`, minWidth: share ? 2 : 0 }} />
              <span className="text-sm whitespace-nowrap text-text tabular-nums">{formatValue(row.value, spec.decimals, true)}</span>
            </span>
            {active === i ? (
              <span className="absolute top-full left-[9rem] mt-1">
                <Tip value={formatValue(row.value, spec.decimals)}>
                  {other ? row.label : <GroupName group={row} spec={spec} />}
                  {total > 0 && row.value ? ` · ${Math.round((row.value / total) * 100)}% of the total` : ''}
                </Tip>
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const PLOT_HEIGHT = 180;
const AXIS_BAND = 28;
const LEFT = 44;

/** Columns or a line over the groups in their order, on one axis from zero, with a hover readout. */
function Plot({ spec, rows }: { spec: ChartSpec; rows: readonly ChartGroup[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const values = rows.map((row) => row.value ?? 0);
  const ticks = niceTicks(Math.max(0, ...values));
  const top = ticks.at(-1)! || 1;
  const plotWidth = Math.max(0, width - LEFT - 8);
  const band = rows.length ? plotWidth / rows.length : 0;
  const x = (i: number) => LEFT + band * i + band / 2;
  const y = (value: number) => 8 + PLOT_HEIGHT - (Math.max(0, value) / top) * PLOT_HEIGHT;
  const columnWidth = Math.min(24, Math.max(2, band * 0.6));
  // Labels along the axis skip some, so none collide.
  const every = Math.max(1, Math.ceil(56 / Math.max(1, band)));
  const last = rows.length - 1;
  const height = 8 + PLOT_HEIGHT + AXIS_BAND;
  const line = spec.show === 'line';
  const path = rows.map((row, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(row.value ?? 0).toFixed(1)}`).join(' ');

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setActive(null)}>
      {width ? (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${spec.title}: ${rows.length} ${spec.group.label.toLowerCase()} values`}
          className="block overflow-visible"
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={LEFT} x2={width - 8} y1={y(tick)} y2={y(tick)} stroke="var(--line)" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={LEFT - 6} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-[var(--faint)] text-[11px] tabular-nums">
                {formatValue(tick, 0, true)}
              </text>
            </g>
          ))}
          {rows.map((row, i) =>
            i % every === 0 || i === last ? (
              <text key={`label:${i}`} x={x(i)} y={8 + PLOT_HEIGHT + 18} textAnchor="middle" className="fill-[var(--muted)] text-[11px]">
                <GroupText group={row} spec={spec} />
              </text>
            ) : null,
          )}
          {line ? (
            <>
              {active !== null ? <line x1={x(active)} x2={x(active)} y1={8} y2={8 + PLOT_HEIGHT} stroke="var(--line-strong)" strokeWidth={1} /> : null}
              <path d={path} fill="none" stroke="var(--chart-series)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {/* The end point: a dot in the series colour, ringed in the surface so it stays legible. */}
              <circle cx={x(last)} cy={y(rows[last]?.value ?? 0)} r={4} fill="var(--chart-series)" stroke="var(--surface)" strokeWidth={2} />
              {active !== null && active !== last ? (
                <circle cx={x(active)} cy={y(rows[active]?.value ?? 0)} r={4} fill="var(--chart-series)" stroke="var(--surface)" strokeWidth={2} />
              ) : null}
            </>
          ) : (
            rows.map((row, i) => {
              const h = Math.max(0, PLOT_HEIGHT + 8 - y(row.value ?? 0));
              const left = x(i) - columnWidth / 2;
              const r = Math.min(4, h, columnWidth / 2);
              const bottom = 8 + PLOT_HEIGHT;
              // Rounded at the data end, square at the baseline.
              const d = h
                ? `M${left},${bottom} V${bottom - h + r} Q${left},${bottom - h} ${left + r},${bottom - h} H${left + columnWidth - r} Q${left + columnWidth},${bottom - h} ${left + columnWidth},${bottom - h + r} V${bottom} Z`
                : '';
              return d ? <path key={`col:${i}`} d={d} fill="var(--chart-series)" opacity={active === null || active === i ? 1 : 0.55} /> : null;
            })
          )}
          {/* Only the latest value is written on the chart; the axis, the readout and the table carry the rest. */}
          <text
            x={x(last)}
            y={y(rows[last]?.value ?? 0) - 10}
            textAnchor={line ? 'end' : 'middle'}
            className="fill-[var(--text)] text-[12px] font-semibold tabular-nums"
          >
            {formatValue(rows[last]?.value ?? null, spec.decimals, true)}
          </text>
          {rows.map((row, i) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: a column takes the focus, so that a keyboard shows its tooltip as the mouse does
            <rect
              key={`hit:${i}`}
              x={LEFT + band * i}
              y={0}
              width={band}
              height={8 + PLOT_HEIGHT}
              fill="transparent"
              tabIndex={0}
              aria-label={`${row.label ?? row.key ?? 'None'}: ${formatValue(row.value, spec.decimals)}`}
              onPointerEnter={() => setActive(i)}
              onFocus={() => setActive(i)}
              onBlur={() => setActive(null)}
            />
          ))}
        </svg>
      ) : (
        <div style={{ height }} />
      )}
      {active !== null && rows[active] ? (
        <span
          className="absolute"
          style={{ left: Math.min(Math.max(0, x(active) - 40), Math.max(0, width - 140)), top: Math.max(0, y(rows[active]!.value ?? 0) - 56) }}
        >
          <Tip value={formatValue(rows[active]!.value, spec.decimals)}>
            <GroupName group={rows[active]!} spec={spec} />
          </Tip>
        </span>
      ) : null}
    </div>
  );
}

/** A group's name inside SVG text: a person's name comes from the directory. */
function GroupText({ group, spec }: { group: ChartGroup; spec: ChartSpec }) {
  return <GroupName group={group} spec={spec} short />;
}

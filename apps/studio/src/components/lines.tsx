import type { Line, LinesChange, RecordValue, UiField, Value } from '../types.js';
import { Button, cx } from './ui.js';
import { asLines, display, ValueInput, ValueView } from './values.js';

const cell = 'border-b border-line px-2 py-1.5 align-top';

/** A lines field's lines, read-only, showing the fields the person may see. Masked ones show as dots. */
export function LinesTable({ field, value, masked = [] }: { field: UiField; value: RecordValue | undefined; masked?: readonly string[] }) {
  const lines = asLines(value);
  const columns = field.lines?.fields.filter((f) => f.read) ?? [];
  if (!lines.length) return <span className="text-faint">No {field.label.toLowerCase()}</span>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.name} scope="col" className={cx('border-b border-line-strong px-2 py-1 text-left font-medium text-muted', c.type === 'number' && 'text-right')}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={line.id ?? index}>
              {columns.map((c) => (
                <td key={c.name} className={cx(cell, c.type === 'number' && 'text-right tabular-nums')}>
                  {masked.includes(`${field.name}.${c.name}`) ? <span className="text-faint" title="Masked for your role">••••</span> : <ValueView field={c} value={line[c.name] ?? null} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Edit a lines field's lines: change the fields the person may, and add or remove lines if they
 * may change every field of a line (as the platform requires). Problems show under their cell.
 */
export function LinesEditor(props: {
  id: string;
  field: UiField;
  value: Line[];
  onChange: (lines: Line[]) => void;
  mode: 'create' | 'update';
  problems?: Readonly<Record<string, string>>;
}) {
  const { id, field, value, onChange, mode } = props;
  const spec = field.lines!;
  const editable = (f: UiField) => (mode === 'create' ? f.create : f.update);
  const columns = spec.fields.filter((f) => editable(f) || f.read);
  const whole = spec.fields.every(editable);
  const set = (index: number, name: string, v: Value) => onChange(value.map((line, i) => (i === index ? { ...line, [name]: v } : line)));
  const problem = (key: string) => props.problems?.[key];
  return (
    <div className="grid gap-2">
      <div className="overflow-x-auto">
        <table id={id} className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.name} scope="col" className="border-b border-line-strong px-2 py-1 text-left font-medium text-muted">
                  {c.label}
                  {c.required ? <span className="text-bad"> *</span> : null}
                </th>
              ))}
              {whole ? <th scope="col" className="w-0 border-b border-line-strong" /> : null}
            </tr>
          </thead>
          <tbody>
            {value.map((line, index) => {
              const what = `${spec.label} ${index + 1}`;
              return (
                <tr key={line.id ?? `new-${index}`}>
                  {columns.map((c) => (
                    <td key={c.name} className={cx(cell, 'min-w-32')}>
                      {editable(c) ? (
                        <ValueInput id={`${id}-${index}-${c.name}`} field={c} value={line[c.name] ?? null} onChange={(v) => set(index, c.name, v)} label={`${what}, ${c.label}`} />
                      ) : (
                        <ValueView field={c} value={line[c.name] ?? null} />
                      )}
                      {problem(`${field.name}[${index}].${c.name}`) ? <span className="mt-0.5 block text-xs text-bad">{problem(`${field.name}[${index}].${c.name}`)}</span> : null}
                    </td>
                  ))}
                  {whole ? (
                    <td className={cell}>
                      <Button size="sm" variant="ghost" aria-label={`Remove ${what}`} onClick={() => onChange(value.filter((_, i) => i !== index))}>
                        ✕
                      </Button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {whole ? (
        <div>
          <Button size="sm" disabled={value.length >= spec.max} onClick={() => onChange([...value, {}])}>
            Add a line
          </Button>
        </div>
      ) : null}
      {problem(field.name) ? <span className="text-xs text-bad">{problem(field.name)}</span> : null}
    </div>
  );
}

/** Lines with something in them: an empty row someone added and left isn't a line. */
export function filledLines(lines: readonly Line[]): Line[] {
  return lines.filter((line) => line.id || Object.entries(line).some(([key, v]) => key !== 'id' && v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)));
}

/** A number worked out from lines, as the platform will work it out, to show while people type. */
export function rollupValue(field: UiField, values: Readonly<Record<string, RecordValue | undefined>>): Value {
  const [op, path] = Object.entries(field.rollup ?? {})[0] ?? [];
  if (!op || !path) return null;
  const [linesName, sub] = path.split('.');
  const lines = filledLines(asLines(values[linesName!]));
  if (op === 'count') return lines.length;
  const numbers = lines.map((line) => line[sub!]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (op === 'sum') {
    const scale = 10 ** (field.decimals ?? 0);
    return numbers.reduce((total, n) => total + Math.round(n * scale), 0) / scale;
  }
  if (!numbers.length) return null;
  return op === 'min' ? Math.min(...numbers) : Math.max(...numbers);
}

/** How a record's lines changed, in words: each line named by its title field where the person may see it. */
export function LinesChangeView({ field, change, current }: { field: UiField; change: LinesChange; current: readonly Line[] }) {
  const spec = field.lines;
  const fieldOf = (name: string) => spec?.fields.find((f) => f.name === name);
  const title = (values: Readonly<Record<string, Value>>, id: string) => {
    const named = spec?.titleField ? values[spec.titleField] : undefined;
    const known = spec?.titleField ? current.find((line) => line.id === id)?.[spec.titleField] : undefined;
    const text = display(fieldOf(spec?.titleField ?? ''), (named ?? known ?? null) as Value);
    return text === '—' ? `a ${spec?.label.toLowerCase() ?? 'line'}` : text;
  };
  const summary = (values: Readonly<Record<string, Value>>) =>
    Object.entries(values)
      .filter(([name]) => name !== spec?.titleField)
      .map(([name, value]) => display(fieldOf(name), value))
      .filter((text) => text !== '—')
      .join(', ');
  return (
    <ul className="m-0 grid list-none gap-0.5 p-0 pl-2">
      {change.added.map((line) => (
        <li key={`a-${line.id}`}>
          Added <strong className="font-medium">{title(line.values, line.id)}</strong>
          {summary(line.values) ? <span className="text-muted"> ({summary(line.values)})</span> : null}
          {line.sources && Object.values(line.sources).some((s) => s.source === 'document') ? <span className="ml-1 text-outside">read from a document</span> : null}
        </li>
      ))}
      {change.changed.map((line) => (
        <li key={`c-${line.id}`}>
          <strong className="font-medium">{title({}, line.id)}</strong>:{' '}
          {line.changes.map((c, i) => (
            <span key={c.field}>
              {i ? '; ' : ''}
              {fieldOf(c.field)?.label ?? c.field} {c.masked ? 'changed' : `${display(fieldOf(c.field), c.before ?? null)} → ${display(fieldOf(c.field), c.after ?? null)}`}
            </span>
          ))}
        </li>
      ))}
      {change.removed.map((line) => (
        <li key={`r-${line.id}`} className="text-muted">
          Removed {title(line.values, line.id)}
        </li>
      ))}
      {change.reordered ? <li className="text-muted">Put in a new order</li> : null}
    </ul>
  );
}

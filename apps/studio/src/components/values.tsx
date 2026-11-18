import type { ReactNode } from 'react';
import type { Line, RecordValue, UiField, Value } from '../types.js';
import { FileInput, FileLink } from './files.js';
import { PersonName, PersonPicker } from './people.js';
import { RecordPicker, RecordTitles } from './records.js';
import { Checkbox, Select, TextInput } from './ui.js';

/** A value as text, as people read it: labels for choices, local numbers and times. */
export function display(field: UiField | undefined, value: RecordValue | undefined): string {
  if (isLines(value)) return `${value.length} ${value.length === 1 ? 'line' : 'lines'}`;
  if (value === null || value === undefined || value === '') return '—';
  if (!field) return String(value);
  if (field.type === 'choice') {
    const label = (v: string) => field.options?.find((o) => o.value === v)?.label ?? v;
    return Array.isArray(value) ? value.map(label).join(', ') : label(String(value));
  }
  if (field.type === 'boolean') return value ? 'Yes' : 'No';
  if (field.type === 'file') return 'a file';
  if (field.type === 'number' && typeof value === 'number')
    return value.toLocaleString(undefined, { minimumFractionDigits: field.decimals ?? 0, maximumFractionDigits: field.decimals ?? 0 });
  if (field.type === 'datetime' && typeof value === 'string') return new Date(value).toLocaleString();
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/** A value as people read it: names for people, labels for choices. */
export function ValueView({ field, value, link = true }: { field: UiField | undefined; value: RecordValue | undefined; link?: boolean }) {
  if (field?.type === 'user' && typeof value === 'string' && value) return <PersonName id={value} />;
  if (field?.type === 'reference' && field.entity && value) return <RecordTitles entity={field.entity} value={value} link={link} />;
  if (field?.type === 'file' && typeof value === 'string' && value) return <FileLink id={value} link={link} />;
  return <>{display(field, value)}</>;
}

/** True for a lines field's value: its lines. */
export function isLines(value: RecordValue | undefined): value is Line[] {
  return Array.isArray(value) && value.some((item) => typeof item === 'object' && item !== null);
}

/** A lines field's lines, or none. */
export const asLines = (value: RecordValue | undefined): Line[] =>
  Array.isArray(value) ? (value as Line[]).filter((item) => typeof item === 'object' && item !== null) : [];

/** An input for one value of a field. `label` names it for screen readers where no <label> can, such as in a table. */
export function ValueInput({
  field,
  value,
  onChange,
  id,
  label,
}: {
  field: UiField;
  value: Value | undefined;
  onChange: (value: Value) => void;
  id: string;
  label?: string;
}): ReactNode {
  const aria = label ? { 'aria-label': label } : {};
  switch (field.type) {
    case 'file':
      return (
        <FileInput
          id={id}
          value={typeof value === 'string' ? value : null}
          accept={field.accept ?? ['image', 'pdf']}
          onChange={onChange}
          {...(label ? { label } : {})}
        />
      );
    case 'user':
      return <PersonPicker id={id} value={typeof value === 'string' ? value : null} onChange={onChange} {...(label ? { label } : {})} />;
    case 'reference':
      return field.entity ? (
        <RecordPicker id={id} entity={field.entity} multiple={field.multiple} value={value ?? null} onChange={onChange} label={label} />
      ) : null;
    case 'boolean':
      return <Checkbox label={field.label} checked={value === true} onChange={onChange} />;
    case 'choice':
      return field.multiple ? (
        <div className="flex flex-wrap gap-3">
          {field.options?.map((o) => (
            <Checkbox
              key={o.value}
              label={o.label}
              checked={Array.isArray(value) && value.includes(o.value)}
              onChange={(on) => onChange([...(Array.isArray(value) ? value : []).filter((v) => v !== o.value), ...(on ? [o.value] : [])])}
            />
          ))}
        </div>
      ) : (
        <Select id={id} {...aria} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
    case 'number':
      return (
        <TextInput
          id={id}
          {...aria}
          type="number"
          step={field.decimals ? 1 / 10 ** field.decimals : 1}
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
      );
    case 'date':
      return <TextInput id={id} {...aria} type="date" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || null)} />;
    case 'datetime':
      return (
        <TextInput
          id={id}
          {...aria}
          type="datetime-local"
          value={typeof value === 'string' ? value.slice(0, 16) : ''}
          onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
        />
      );
    case 'text':
      return field.multiline ? (
        <textarea
          id={id}
          {...aria}
          className="min-h-24 w-full rounded-sm border border-line-strong bg-surface px-2.5 py-1.5"
          maxLength={field.maxLength}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <TextInput id={id} {...aria} maxLength={field.maxLength} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
      );
    default:
      return (
        <TextInput
          id={id}
          {...aria}
          type={field.type === 'email' ? 'email' : 'text'}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value || null)}
        />
      );
  }
}

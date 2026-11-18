import { durationOf, durationParts } from '../model/waits.js';
import { Field, Select, TextInput } from './ui.js';

/** A duration, as an amount of hours, days or weeks; one in another form stays as ISO 8601 text. */
export function DurationInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const parts = durationParts(value);
  if (!parts) {
    return <Field label={label} hint="ISO 8601, such as P3D">{(id) => <TextInput id={id} value={value} onChange={(event) => onChange(event.target.value)} />}</Field>;
  }
  return (
    <Field label={label}>
      {(id) => (
        <div className="flex gap-2">
          <TextInput id={id} type="number" min={1} className="w-20" value={parts.amount} onChange={(event) => onChange(durationOf(Number(event.target.value) || 1, parts.unit))} />
          <Select aria-label={`${label}: unit`} className="w-auto" value={parts.unit} onChange={(event) => onChange(durationOf(parts.amount, event.target.value === 'hours' ? 'hours' : event.target.value === 'weeks' ? 'weeks' : 'days'))}>
            <option value="hours">hours</option>
            <option value="days">days</option>
            <option value="weeks">weeks</option>
          </Select>
        </div>
      )}
    </Field>
  );
}

/** When, around a date of the record: on the day, or a time before or after it. */
export function DateShift({ label, value, onChange }: { label: string; value: { readonly before?: string | undefined; readonly after?: string | undefined }; onChange: (shift: { before?: string; after?: string }) => void }) {
  const when = value.before ? 'before' : value.after ? 'after' : 'on';
  const amount = value.before ?? value.after ?? 'P1D';
  return (
    <>
      <Field label={label}>
        {(id) => (
          <Select id={id} value={when} onChange={(event) => onChange(event.target.value === 'before' ? { before: amount } : event.target.value === 'after' ? { after: amount } : {})}>
            <option value="on">On the day</option>
            <option value="before">A time before it</option>
            <option value="after">A time after it</option>
          </Select>
        )}
      </Field>
      {value.before ? <DurationInput label="How long before" value={value.before} onChange={(before) => onChange({ before })} /> : null}
      {value.after ? <DurationInput label="How long after" value={value.after} onChange={(after) => onChange({ after })} /> : null}
    </>
  );
}

import { isCondition, type Condition } from '@platform/authz';
import { z } from 'zod';

/**
 * The app definition format (design §6): entities hold data; rules check every write; actions
 * change records and queries read them, and both are published as tools for agents; review cards
 * show a person what an action will do; roles say who may do what.
 *
 * Names are identifiers that people and agents see. Entities and fields also carry stable IDs,
 * assigned by the platform, which never change: tables and columns are named after the IDs, so a
 * rename never touches data.
 */

export const NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
export const ID_PATTERN = /^[a-z0-9]{4,16}$/;

/** System fields every record has. They cannot be used as field names. */
export const SYSTEM_FIELDS = ['id', 'version', 'owner', 'created_at', 'created_by', 'updated_at', 'updated_by'] as const;
export type SystemField = (typeof SYSTEM_FIELDS)[number];

export const Name = z.string().regex(NAME_PATTERN, 'Use lowercase letters, digits and underscores, starting with a letter');
export const Id = z.string().regex(ID_PATTERN, 'IDs are 4 to 16 lowercase letters and digits');
const Label = z.string().trim().min(1).max(200);
const Description = z.string().trim().min(1).max(2000);
const OptionValue = z.string().trim().min(1).max(100);

export const ConditionSchema = z.custom<Condition>((value) => isCondition(value), { message: 'Not a valid condition' });

const fieldCommon = {
  id: Id.optional(),
  name: Name,
  label: Label,
  description: Description.optional(),
  required: z.boolean().default(false),
  /** `pii` fields are masked for app roles unless a role unmasks them. */
  classification: z.enum(['internal', 'confidential', 'pii']).default('internal'),
};

export const MAX_TEXT_LENGTH = 10_000;
/** Numbers are stored exactly, and must stay within what JSON numbers represent exactly. */
export const MAX_NUMBER_MAGNITUDE = 1e15;

const TextField = z.strictObject({
  ...fieldCommon,
  type: z.literal('text'),
  maxLength: z.int().min(1).max(MAX_TEXT_LENGTH).default(1000),
  multiline: z.boolean().default(false),
  unique: z.boolean().default(false),
  default: z.string().max(MAX_TEXT_LENGTH).optional(),
});

const EmailField = z.strictObject({
  ...fieldCommon,
  type: z.literal('email'),
  unique: z.boolean().default(false),
  default: z.string().max(320).optional(),
});

const NumberField = z.strictObject({
  ...fieldCommon,
  type: z.literal('number'),
  decimals: z.int().min(0).max(6).default(0),
  min: z.number().min(-MAX_NUMBER_MAGNITUDE).max(MAX_NUMBER_MAGNITUDE).optional(),
  max: z.number().min(-MAX_NUMBER_MAGNITUDE).max(MAX_NUMBER_MAGNITUDE).optional(),
  unique: z.boolean().default(false),
  default: z.number().optional(),
});

const BooleanField = z.strictObject({ ...fieldCommon, type: z.literal('boolean'), default: z.boolean().optional() });
const DateField = z.strictObject({ ...fieldCommon, type: z.literal('date') });
const DateTimeField = z.strictObject({ ...fieldCommon, type: z.literal('datetime') });

const ChoiceField = z.strictObject({
  ...fieldCommon,
  type: z.literal('choice'),
  options: z.array(z.strictObject({ value: OptionValue, label: Label })).min(1).max(200),
  multiple: z.boolean().default(false),
  default: z.union([OptionValue, z.array(OptionValue).max(200)]).optional(),
});

/** A link to a record of another entity in the same app. */
const ReferenceField = z.strictObject({ ...fieldCommon, type: z.literal('reference'), entity: Name });

/** A person in the directory, for example who a request is assigned to. */
const UserField = z.strictObject({ ...fieldCommon, type: z.literal('user') });

export const Field = z.discriminatedUnion('type', [
  TextField,
  EmailField,
  NumberField,
  BooleanField,
  DateField,
  DateTimeField,
  ChoiceField,
  ReferenceField,
  UserField,
]);
export type Field = z.infer<typeof Field>;
export type FieldType = Field['type'];

export const MAX_FIELDS = 100;

export const Entity = z.strictObject({
  id: Id.optional(),
  label: Label,
  pluralLabel: Label.optional(),
  description: Description.optional(),
  /** The field that names a record, for example in lists and on review cards. */
  titleField: Name.optional(),
  /** Keep a field-level history of every change (design §9.4). */
  history: z.boolean().default(true),
  fields: z.array(Field).max(MAX_FIELDS),
});
export type Entity = z.infer<typeof Entity>;

export const Rule = z.strictObject({
  entity: Name,
  description: Description.optional(),
  /** The rule applies only to records for which this holds. */
  when: ConditionSchema.optional(),
  /** What must hold. Refers to the record as `record.<field>`, and may use `principal.*`. */
  assert: ConditionSchema,
  /** `error` blocks the write; `warning` lets it through and travels with the record. */
  severity: z.enum(['error', 'warning']).default('error'),
  message: z.string().trim().min(1).max(500),
  /** The fields a finding points at, so screens can highlight them. */
  fields: z.array(Name).max(20).optional(),
});
export type Rule = z.infer<typeof Rule>;

const Literal = z.union([z.string().max(MAX_TEXT_LENGTH), z.number(), z.boolean(), z.null(), z.array(OptionValue).max(200)]);

export const CONFIRMATION_LEVELS = ['none', 'preview', 'review'] as const;
export type ConfirmationLevel = (typeof CONFIRMATION_LEVELS)[number];

export const Action = z.strictObject({
  label: Label,
  /** Written for agents: what the action does and when to use it. Becomes the tool description. */
  description: Description,
  entity: Name,
  operation: z.enum(['create', 'update']),
  /** The fields the caller provides. `owner` may be listed, to set who owns the record. */
  input: z.array(Name).max(MAX_FIELDS),
  /** Values the action sets itself, whatever the caller sends. */
  set: z.record(Name, Literal).default({}),
  /** For updates: the records the action applies to. */
  where: ConditionSchema.optional(),
  /** How much confirmation an agent's call needs before it commits (design §6.2). Guardrails can raise it. */
  confirm: z.enum(CONFIRMATION_LEVELS).default('preview'),
  /** The review card a person checks before confirming. */
  card: Name.optional(),
});
export type Action = z.infer<typeof Action>;

const Parameter = z.strictObject({
  type: z.enum(['text', 'number', 'boolean']),
  description: Description,
  required: z.boolean().default(false),
});

export const Query = z.strictObject({
  label: Label,
  /** Written for agents: what the query answers. Becomes the tool description. */
  description: Description,
  entity: Name,
  /** The fields each result carries, user or system fields. */
  fields: z.array(Name).min(1).max(50),
  /** A fixed filter. May use `principal.*` (my claims) and `input.<parameter>`. */
  filter: ConditionSchema.optional(),
  parameters: z.record(Name, Parameter).default({}),
  sort: z.array(z.strictObject({ field: Name, direction: z.enum(['asc', 'desc']).default('asc') })).max(3).default([]),
  limit: z.int().min(1).max(200).default(50),
});
export type Query = z.infer<typeof Query>;

export const Card = z.strictObject({
  entity: Name,
  /** A title, with `{{field}}` placeholders. */
  title: z.string().trim().min(1).max(200),
  /** The fields shown, in order. Rule findings always come first. */
  show: z.array(Name).min(1).max(50),
});
export type Card = z.infer<typeof Card>;

const FormField = z.strictObject({
  field: Name,
  /** Overrides the field's own label on this form. */
  label: Label.optional(),
  help: z.string().trim().min(1).max(500).optional(),
  width: z.enum(['full', 'half']).default('full'),
  /** Shown but not editable here. */
  readOnly: z.boolean().default(false),
});

/**
 * A form lays out an entity's fields for people who work in screens. The rules still run on the
 * server whatever the form shows: a form is a convenience, never where checking happens.
 */
export const Form = z.strictObject({
  label: Label,
  entity: Name,
  /** Submit through this action, so its rules and confirmation apply. Without one, the form creates and edits records. */
  action: Name.optional(),
  sections: z
    .array(z.strictObject({ title: Label.optional(), fields: z.array(FormField).max(MAX_FIELDS) }))
    .min(1)
    .max(20),
});
export type Form = z.infer<typeof Form>;

const FieldSelection = z.union([
  z.strictObject({ include: z.array(Name).max(MAX_FIELDS) }),
  z.strictObject({ exclude: z.array(Name).max(MAX_FIELDS) }),
]);

const ReadAccess = z.strictObject({
  where: ConditionSchema.optional(),
  fields: FieldSelection.optional(),
  /** Fields shown masked. */
  mask: z.array(Name).max(MAX_FIELDS).optional(),
  /** `pii` fields this role may see unmasked. */
  unmask: z.array(Name).max(MAX_FIELDS).optional(),
});
const CreateAccess = z.strictObject({ check: ConditionSchema.optional(), fields: FieldSelection.optional() });
const UpdateAccess = z.strictObject({
  where: ConditionSchema.optional(),
  check: ConditionSchema.optional(),
  fields: FieldSelection.optional(),
});
const DeleteAccess = z.strictObject({ where: ConditionSchema.optional() });

export const EntityPermissions = z.strictObject({
  read: z.union([z.boolean(), ReadAccess]).optional(),
  create: z.union([z.boolean(), CreateAccess]).optional(),
  update: z.union([z.boolean(), UpdateAccess]).optional(),
  delete: z.union([z.boolean(), DeleteAccess]).optional(),
  export: z.boolean().optional(),
});
export type EntityPermissions = z.infer<typeof EntityPermissions>;

export const AppRole = z.strictObject({
  label: Label,
  description: Description.optional(),
  entities: z.record(Name, EntityPermissions).default({}),
  /** The actions this role may run. They still run under its record permissions. */
  actions: z.array(Name).max(100).default([]),
  /** The queries this role may run. */
  queries: z.array(Name).max(100).default([]),
});
export type AppRole = z.infer<typeof AppRole>;

export const LIMITS = { entities: 50, rules: 200, actions: 100, queries: 100, cards: 100, forms: 100, roles: 20 } as const;

const bounded = <T extends z.ZodType>(value: T, max: number, what: string) =>
  z.record(Name, value).default({} as never).refine((map) => Object.keys(map).length <= max, `At most ${max} ${what}`);

export const AppDefinition = z.strictObject({
  formatVersion: z.literal(1).default(1),
  entities: bounded(Entity, LIMITS.entities, 'entities'),
  rules: bounded(Rule, LIMITS.rules, 'rules'),
  actions: bounded(Action, LIMITS.actions, 'actions'),
  queries: bounded(Query, LIMITS.queries, 'queries'),
  cards: bounded(Card, LIMITS.cards, 'cards'),
  forms: bounded(Form, LIMITS.forms, 'forms'),
  roles: bounded(AppRole, LIMITS.roles, 'roles'),
});
export type AppDefinition = z.infer<typeof AppDefinition>;
export type AppDefinitionInput = z.input<typeof AppDefinition>;

/** An empty app: what a new app starts from. */
export function emptyDefinition(): AppDefinition {
  return AppDefinition.parse({});
}

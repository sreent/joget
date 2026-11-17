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
/** The most lines a record can have in one lines field. */
export const MAX_LINES = 500;

/** A field of the lines in a lines field, such as `lines.amount`. */
export const LINE_PATH_PATTERN = /^([a-z][a-z0-9_]{0,62})\.([a-z][a-z0-9_]{0,62})$/;
const LinePath = z.string().regex(LINE_PATH_PATTERN, 'Name a lines field and a field of its lines, such as lines.amount');

/**
 * A number the platform works out from a lines field whenever a record is written: the sum,
 * smallest or largest of a number field of the lines, or how many lines there are. It is stored
 * like any number, so conditions, rules, roles and queries can use it, for example a claim's total.
 */
export const Rollup = z.union([
  z.strictObject({ sum: LinePath }),
  z.strictObject({ min: LinePath }),
  z.strictObject({ max: LinePath }),
  z.strictObject({ count: Name }),
]);
export type Rollup = z.infer<typeof Rollup>;

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
  /** Work the value out from a lines field. People and agents can't set it. */
  rollup: Rollup.optional(),
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

/** The kinds of file a file field can take. The platform reads each file's type from its content, not its name. */
export const FILE_KINDS = ['image', 'pdf'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/**
 * A file, such as a receipt: uploaded first, then set as the field's value by its ID. The
 * platform keeps it, checks it for malware, and lets only those who can see the field download it.
 */
const FileField = z.strictObject({
  ...fieldCommon,
  type: z.literal('file'),
  accept: z.array(z.enum(FILE_KINDS)).min(1).max(FILE_KINDS.length).default([...FILE_KINDS]),
});

/**
 * Line items: records of another entity that belong to each record of this one, such as one line
 * per receipt on an expense claim. That entity becomes part of this one: its records exist only
 * inside a record here, are read and written with it, in order, and share its permissions and
 * its history. `required` means at least one line.
 */
const LinesField = z.strictObject({
  ...fieldCommon,
  type: z.literal('lines'),
  entity: Name,
  /** The most lines a record may have. */
  max: z.int().min(1).max(MAX_LINES).default(100),
});

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
  FileField,
  LinesField,
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
  /** A lines field shown as a table, with these columns. */
  table: z.strictObject({ of: Name, columns: z.array(Name).min(1).max(20) }).optional(),
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

/** A field, or a field of lines as `lines.amount`. */
const FieldPath = z.string().regex(/^[a-z][a-z0-9_]{0,62}(\.[a-z][a-z0-9_]{0,62})?$/, 'Name a field, or a field of lines such as lines.amount');

/** A heading or some text on a page. */
const TextBlock = z.strictObject({
  type: z.literal('text'),
  /** `heading` titles a part of the page; `note` stands out, for a hint or a warning. */
  style: z.enum(['heading', 'paragraph', 'note']).default('paragraph'),
  text: z.string().trim().min(1).max(5000),
});

/**
 * Records of one entity, as a table. The person's own permissions always apply on top: a list
 * never shows a record or a field that their role doesn't let them read.
 */
const ListBlock = z.strictObject({
  type: z.literal('list'),
  title: Label.optional(),
  entity: Name,
  /** The columns, in order: fields of the records, or system fields such as created_at. */
  columns: z.array(Name).min(1).max(12),
  /** Which records. May use `principal.*`, as in "my claims". */
  filter: ConditionSchema.optional(),
  sort: z.array(z.strictObject({ field: Name, direction: z.enum(['asc', 'desc']).default('asc') })).max(3).default([]),
  /** How many records show at first; more come on request. */
  limit: z.int().min(1).max(100).default(20),
  /** Update actions that run on a row in one click, such as Approve. */
  actions: z.array(Name).max(5).default([]),
  /** What to say when there are no records. */
  empty: z.string().trim().min(1).max(200).optional(),
});

/** Buttons that open a form, or another page. */
const ButtonsBlock = z.strictObject({
  type: z.literal('buttons'),
  buttons: z
    .array(z.union([z.strictObject({ form: Name, label: Label.optional() }), z.strictObject({ page: Name, label: Label.optional() })]))
    .min(1)
    .max(8),
});

/**
 * What a number or a chart works out: how many records, or lines; or the total, average, smallest
 * or largest of a number field, which may be a field of lines as `lines.amount`.
 */
export const Measure = z.strictObject({
  op: z.enum(['count', 'sum', 'avg', 'min', 'max']),
  /** The number field. For `count`, leave it out to count records, or name a lines field to count lines. */
  field: FieldPath.optional(),
});
export type Measure = z.infer<typeof Measure>;

export const PERIODS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export type Period = (typeof PERIODS)[number];

/** Only records, or lines, of a recent time: dates can't be compared in conditions yet. Times are in UTC. */
export const TimeRange = z.strictObject({
  /** A date or time field, or one of lines, such as `lines.date`. */
  field: FieldPath,
  within: z.enum(['this_month', 'this_quarter', 'this_year', 'last_30_days', 'last_90_days', 'last_12_months']),
});
export type TimeRange = z.infer<typeof TimeRange>;

/** One number, such as how many claims wait for approval: a tile on a dashboard. */
const StatBlock = z.strictObject({
  type: z.literal('stat'),
  label: Label,
  entity: Name,
  measure: Measure,
  filter: ConditionSchema.optional(),
  range: TimeRange.optional(),
});

/**
 * A number for each value of a field, or each period of a date, such as spending by category:
 * as bars, columns, a line over time, or a table. Like a list, it counts only what the person
 * may read.
 */
const ChartBlock = z.strictObject({
  type: z.literal('chart'),
  title: Label,
  entity: Name,
  measure: Measure,
  /** What each bar or point stands for: the values of a field, or periods of a date field. */
  group: z.strictObject({ field: FieldPath, period: z.enum(PERIODS).optional() }),
  filter: ConditionSchema.optional(),
  range: TimeRange.optional(),
  show: z.enum(['bar', 'column', 'line', 'table']).default('bar'),
  /** At most this many bars or points: for periods, the latest; otherwise the largest, the rest as "Other". */
  limit: z.int().min(2).max(24).default(8),
  width: z.enum(['full', 'half']).default('half'),
});

export const PageBlock = z.discriminatedUnion('type', [TextBlock, ListBlock, ButtonsBlock, StatBlock, ChartBlock]);
export type PageBlock = z.infer<typeof PageBlock>;
export type ListBlock = z.infer<typeof ListBlock>;
export type StatBlock = z.infer<typeof StatBlock>;
export type ChartBlock = z.infer<typeof ChartBlock>;

/**
 * A page of an app's screens: blocks, top to bottom. The page is shown to whoever may use
 * something on it, so there is no separate permission for pages (design §5.5).
 */
export const Page = z.strictObject({
  label: Label,
  description: Description.optional(),
  /**
   * Shown only to people who hold one of these roles, such as a page for approvers. This tidies
   * screens; it protects nothing, as the data's own permissions do that. People who hold none of
   * the app's roles, such as its builder, see every page.
   */
  roles: z.array(Name).max(20).optional(),
  blocks: z.array(PageBlock).min(1).max(30),
});
export type Page = z.infer<typeof Page>;

/** One item of an app's menu: a page, a form, an entity's records, or a heading over the items below it. */
export const NavItem = z.union([
  z.strictObject({ page: Name, label: Label.optional() }),
  z.strictObject({ form: Name, label: Label.optional() }),
  z.strictObject({ entity: Name, label: Label.optional() }),
  z.strictObject({ heading: Label }),
]);
export type NavItem = z.infer<typeof NavItem>;

/**
 * An app's menu. Each person sees only the items they may use. Without a menu, an app lists its
 * forms and its entities' records.
 */
export const Navigation = z.strictObject({
  /** The page the app opens on. Without one, it opens on its first menu item. */
  home: Name.optional(),
  items: z.array(NavItem).max(50),
});
export type Navigation = z.infer<typeof Navigation>;


const FieldSelection = z.union([
  z.strictObject({ include: z.array(FieldPath).max(MAX_FIELDS * 2) }),
  z.strictObject({ exclude: z.array(FieldPath).max(MAX_FIELDS * 2) }),
]);

const ReadAccess = z.strictObject({
  where: ConditionSchema.optional(),
  fields: FieldSelection.optional(),
  /** Fields shown masked. */
  mask: z.array(FieldPath).max(MAX_FIELDS * 2).optional(),
  /** `pii` fields this role may see unmasked. */
  unmask: z.array(FieldPath).max(MAX_FIELDS * 2).optional(),
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

export const LIMITS = { entities: 50, rules: 200, actions: 100, queries: 100, cards: 100, forms: 100, roles: 20, pages: 50 } as const;

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
  pages: bounded(Page, LIMITS.pages, 'pages'),
  navigation: Navigation.optional(),
});
export type AppDefinition = z.infer<typeof AppDefinition>;
export type AppDefinitionInput = z.input<typeof AppDefinition>;

/** An empty app: what a new app starts from. */
export function emptyDefinition(): AppDefinition {
  return AppDefinition.parse({});
}

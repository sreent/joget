import { isCondition, type Condition } from '@platform/authz';
import { z } from 'zod';
import { isExpression, type Expression } from './expressions.js';

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

export const ExpressionSchema = z.custom<Expression>((value) => isExpression(value), { message: 'Not a valid expression' });

/** An a7c skill, as `<project>/<skill>`, for example `finance/pay-expense-claim`. */
export const SKILL_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9-]{0,62}$/;
const SkillInputName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,62}$/, 'Name an input with letters, digits and underscores, starting with a letter');

/** Set a field of the record to a value that the step works out. */
const SetStep = z.strictObject({ type: z.literal('set'), field: Name, value: ExpressionSchema });
/** Add a line to a lines field of the record, such as a receipt to a claim. */
const AddLineStep = z.strictObject({ type: z.literal('add_line'), field: Name, values: z.record(Name, ExpressionSchema) });
/** Stop the action with a message unless a condition holds; or, as a warning, let it through with the message. */
const CheckStep = z.strictObject({
  type: z.literal('check'),
  assert: ConditionSchema,
  message: z.string().trim().min(1).max(500),
  severity: z.enum(['error', 'warning']).default('error'),
  /** The fields the message points at, so screens can highlight them. */
  fields: z.array(Name).max(20).optional(),
});
/**
 * Start an a7c skill once the change is saved (design §6.2): automation across other systems
 * belongs to a7c. The call waits in an outbox, so it starts once, and only if the change commits.
 */
const SkillStep = z.strictObject({
  type: z.literal('skill'),
  /** What the skill does, in the words a person reads on the review card. */
  label: Label,
  skill: z.string().regex(SKILL_PATTERN, 'Name a skill as project/skill, for example finance/pay-expense-claim'),
  /** The skill's input, worked out from the record. */
  input: z.record(SkillInputName, ExpressionSchema).default({}),
});
/** A step that a branch can hold. Branches go one level deep, so that an action's logic stays a short list. */
export const SimpleStep = z.discriminatedUnion('type', [SetStep, AddLineStep, CheckStep, SkillStep]);
export type SimpleStep = z.infer<typeof SimpleStep>;
/** Take one of two short lists of steps, depending on a condition. */
const IfStep = z.strictObject({
  type: z.literal('if'),
  when: ConditionSchema,
  then: z.array(SimpleStep).max(10),
  else: z.array(SimpleStep).max(10).default([]),
});
export const Step = z.discriminatedUnion('type', [SetStep, AddLineStep, CheckStep, SkillStep, IfStep]);
export type Step = z.infer<typeof Step>;
export const MAX_STEPS = 20;

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
  /**
   * What the action does after it takes its input and sets its values, step by step: set values,
   * add lines, check, branch, and start a7c skills. The steps run when the change is worked out,
   * so a preview and a proposal show their result, and a person approves exactly that.
   */
  steps: z.array(Step).max(MAX_STEPS).optional(),
});
export type Action = z.infer<typeof Action>;

/** A field, or a field of lines as `lines.amount`. */
const FieldPath = z.string().regex(/^[a-z][a-z0-9_]{0,62}(\.[a-z][a-z0-9_]{0,62})?$/, 'Name a field, or a field of lines such as lines.amount');

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

/**
 * Instead of records, a query can answer with a number, or with a number for each group: the
 * questions people ask of a dashboard, which agents can ask too.
 */
export const QuerySummary = z.strictObject({
  measure: Measure,
  group: z.strictObject({ field: FieldPath, period: z.enum(PERIODS).optional() }).optional(),
  range: TimeRange.optional(),
  /** For groups: how many come back, the largest first, or the latest periods. */
  limit: z.int().min(2).max(24).default(8),
});
export type QuerySummary = z.infer<typeof QuerySummary>;

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
  /** The fields each result carries, user or system fields. A query that answers with numbers has none. */
  fields: z.array(Name).max(50).default([]),
  /** A fixed filter. May use `principal.*` (my claims) and `input.<parameter>`. */
  filter: ConditionSchema.optional(),
  parameters: z.record(Name, Parameter).default({}),
  sort: z.array(z.strictObject({ field: Name, direction: z.enum(['asc', 'desc']).default('asc') })).max(3).default([]),
  limit: z.int().min(1).max(200).default(50),
  /** Answer with numbers, worked out over the records the caller may read, instead of the records. */
  summary: QuerySummary.optional(),
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

/*
 * Business processes, in BPMN 2.0 (design §6.10). A process is about one record of its entity,
 * such as one claim, and the record is its data: conditions read the record as it is now. The
 * elements and flows are BPMN 2.0's, under BPMN's names, so a model goes to and from other BPMN
 * tools. Ambit runs the elements here; an import refuses the others.
 */

/** IDs of a process's elements and flows, as BPMN 2.0 tools give them: kept as they are, so a model goes back as it came. */
export const ELEMENT_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
export const ElementId = z.string().regex(ELEMENT_ID_PATTERN, 'Use letters, digits, hyphens and underscores, starting with a letter or an underscore');

/** An ISO 8601 duration, as BPMN 2.0's timers use: P3D is three days, PT4H four hours. */
export const DURATION_PATTERN = /^P(?=\d|T\d)(?:(\d{1,4})Y)?(?:(\d{1,4})M)?(?:(\d{1,4})W)?(?:(\d{1,4})D)?(?:T(?=\d)(?:(\d{1,4})H)?(?:(\d{1,4})M)?(?:(\d{1,4})S)?)?$/;
export const Duration = z.string().regex(DURATION_PATTERN, 'Give a duration in ISO 8601, for example P3D for three days or PT4H for four hours');

/** When a timer fires: after a duration, or on a date or time field of the record, such as the first day of a leave. */
export const Timer = z.union([z.strictObject({ duration: Duration }), z.strictObject({ date: Name })]);
export type Timer = z.infer<typeof Timer>;

/**
 * A message, as Ambit's processes hear one: one of the app's update actions committing on the
 * record, such as the requester withdrawing. A process that sends one runs the action itself: on
 * its own record, or on the record that a reference field names, whose processes then hear it.
 */
export const Message = z.strictObject({ action: Name, record: Name.optional() });
export type Message = z.infer<typeof Message>;

/**
 * An error or an escalation that an event throws or catches: any, or the one with a code. A catch
 * with a code catches only the throws of that code; one without catches all of them.
 */
export const Raised = z.union([z.literal(true), z.strictObject({ code: Name })]);
export type Raised = z.infer<typeof Raised>;

/** The sub-process an element is in. Without it, the element is in the process itself. An event on a boundary is where its host is. */
const In = ElementId.optional();

/**
 * Where an instance starts. An action that a start event names starts it when the action commits
 * on a record. A start event inside a sub-process starts when the sub-process does.
 */
const StartEvent = z.strictObject({
  type: z.literal('startEvent'),
  name: Label.optional(),
  in: In,
  /** Without actions, a person whose role may start the process starts it on a record, or another process calls it. */
  actions: z.array(Name).max(10).default([]),
  /**
   * Starts the process on each record by itself: on a date field of the record, at the start of
   * that day; or a duration after the record is created.
   */
  timer: Timer.optional(),
  /** Starts the process on a record when a change makes this condition on it hold, where it didn't before. */
  condition: ConditionSchema.optional(),
  /** Starts the process on a record when a process on that record throws this signal, or an operator throws it for the record. */
  signal: Name.optional(),
  /** In an event sub-process: an error that something beside it raises, which this catches. */
  error: Raised.optional(),
  /** In an event sub-process: an escalation from something beside it. */
  escalation: Raised.optional(),
  /** In an event sub-process: false lets what runs beside it go on. Otherwise, it ends all that runs beside it first. */
  interrupting: z.boolean().optional(),
});
/**
 * Where a path ends. A terminate end event ends the whole instance, other paths included; inside a
 * sub-process, the sub-process. One with a message sends it as the path ends.
 */
const EndEvent = z.strictObject({
  type: z.literal('endEvent'),
  name: Label.optional(),
  in: In,
  terminate: z.boolean().default(false),
  message: Message.optional(),
  /** Ends the path with an error, which the nearest sub-process or call around it with an error event catches. */
  error: Raised.optional(),
  /** Ends the path with an escalation, which the nearest sub-process or call around it with an escalation event hears. */
  escalation: Raised.optional(),
  /** Undoes what completed in its run first, newest first, with each task's undo action. */
  compensate: z.literal(true).optional(),
  /** In a transaction: undoes what completed in it, and leaves the transaction by its cancel event. */
  cancel: z.literal(true).optional(),
  /** Throws this signal as the path ends: every process of the app that waits for it hears it. */
  signal: Name.optional(),
});

/** A choice that completes a user task, such as approve. It can run one of the app's actions on the record, as the person who decides. */
const Outcome = z.strictObject({ name: Name, label: Label, action: Name.optional() });
export type Outcome = z.infer<typeof Outcome>;

/**
 * Who of a role's holders a task waits for. Routing narrows; the role grants: whoever it names
 * still decides under the role's permissions.
 */
export const Routing = z.union([
  /** Whoever a user field of the record names, such as the manager the requester chose. */
  z.strictObject({ field: Name }),
  /** The manager of whoever a user field names, from the directory, `levels` up the reporting line. */
  z.strictObject({ managerOf: Name, levels: z.int().min(1).max(5).default(1) }),
]);
export type Routing = z.infer<typeof Routing>;

/** Who votes, when several people decide a task. */
export const Voters = z.union([
  /** Everyone with the task's role, in its department where it has one. */
  z.strictObject({ everyone: z.literal(true) }),
  /** The people some user fields of the record name, such as two reviewers. */
  z.strictObject({ fields: z.array(Name).min(2).max(10) }),
  /** The reporting line up from whoever a user field names: their manager, that manager's, and so on. */
  z.strictObject({ lineOf: Name, levels: z.int().min(2).max(5) }),
]);
export type Voters = z.infer<typeof Voters>;

/**
 * What decides a task that several people decide: the first vote; or a number of votes for one
 * outcome, all of them, or a majority, and the other outcome once that can no longer happen.
 */
export const VoteRule = z.union([
  z.strictObject({ first: z.literal(true) }),
  z.strictObject({ count: z.union([z.int().min(1).max(50), z.enum(['all', 'majority'])]), outcome: Name, otherwise: Name }),
]);
export type VoteRule = z.infer<typeof VoteRule>;

/** Several people decide a task, each with a vote in their own inbox: at once, or one after another. */
export const Several = z.strictObject({ people: Voters, sequential: z.boolean().default(false), decide: VoteRule });
export type Several = z.infer<typeof Several>;

/**
 * An activity that repeats: once it ends, it runs again while this condition holds, on the record
 * and the outcomes of the tasks, up to `max` times in all. With `before`, the condition is checked
 * before each time instead, so the activity may not run at all.
 */
export const Repeat = z.strictObject({ while: ConditionSchema, max: z.int().min(1).max(100), before: z.literal(true).optional() });
export type Repeat = z.infer<typeof Repeat>;

/** Work a person does, such as deciding on a claim: it waits in their inbox until they choose an outcome. */
const UserTask = z.strictObject({
  type: z.literal('userTask'),
  /** What the inbox calls the task. */
  name: Label,
  description: Description.optional(),
  in: In,
  /** The app role whose holders may do the task. A role grants; routing only narrows. */
  role: Name,
  /** One person, by the record or the directory. Without one, anyone with the role can take it. */
  assignee: Routing.optional(),
  /** Without one person: only those with the role in the department of whoever a user field names, such as the requester's. */
  department: z.strictObject({ of: Name }).optional(),
  /**
   * Several people decide, each with a vote. Once the rule decides, the outcome's action runs with
   * the app's authority: no one person made the decision.
   */
  several: Several.optional(),
  outcomes: z.array(Outcome).min(1).max(10),
  /** How long the task may stay open, from when it opens: its due date. */
  due: Duration.optional(),
  /** The review card the task shows. */
  card: Name.optional(),
  repeat: Repeat.optional(),
});
/** Work the process does by itself: run one of the app's actions on the record, with the app's authority, or start an a7c skill. */
/** An update action that undoes what a task did, which a compensation runs on the same record. */
const Undo = Name.optional();
const ServiceTask = z.strictObject({
  type: z.literal('serviceTask'),
  name: Label,
  description: Description.optional(),
  in: In,
  undo: Undo,
  action: Name.optional(),
  skill: z.string().regex(SKILL_PATTERN, 'Name a skill as project/skill, for example finance/pay-expense-claim').optional(),
  /** The skill's input, worked out from the record. */
  input: z.record(SkillInputName, ExpressionSchema).optional(),
  repeat: Repeat.optional(),
});
/**
 * Changes the record by itself, with the app's authority: Ambit's steps, as an action's steps,
 * not code. The record's checks and rules still apply, and a failed check stops the task.
 */
const ScriptTask = z.strictObject({
  type: z.literal('scriptTask'),
  name: Label,
  description: Description.optional(),
  in: In,
  undo: Undo,
  steps: z.array(Step).max(MAX_STEPS).default([]),
  repeat: Repeat.optional(),
});
/** What a rule check finds: every rule holds, only warnings fail, or an error fails. */
export const RULE_OUTCOMES = ['passed', 'warned', 'failed'] as const;
/**
 * Checks the record against the app's rules for its entity, all or those it names. Its outcome,
 * passed, warned or failed, chooses the flow out, as a user task's outcome does.
 */
const BusinessRuleTask = z.strictObject({
  type: z.literal('businessRuleTask'),
  name: Label,
  description: Description.optional(),
  in: In,
  rules: z.array(Name).max(50).optional(),
  repeat: Repeat.optional(),
});
/** Sends a message: runs an update action, with the app's authority, on the record or on the one a reference field names. */
const SendTask = z.strictObject({ type: z.literal('sendTask'), name: Label, description: Description.optional(), in: In, message: Message, undo: Undo, repeat: Repeat.optional() });
/** Waits for a message, an action committing on the record, as a task: deadlines and other events can sit on its boundary. */
const ReceiveTask = z.strictObject({ type: z.literal('receiveTask'), name: Label, description: Description.optional(), in: In, message: Message, repeat: Repeat.optional() });
/** A task with nothing to run, which passes straight on: work that is only drawn. */
const PlainTask = z.strictObject({ type: z.literal('task'), name: Label, description: Description.optional(), in: In, repeat: Repeat.optional() });
/** Work done away from any system, such as posting a letter: the process passes straight on. */
const ManualTask = z.strictObject({ type: z.literal('manualTask'), name: Label, description: Description.optional(), in: In, repeat: Repeat.optional() });
/** Takes the first flow whose condition holds, in order, or its default flow. With several flows in, it lets each token through. */
const ExclusiveGateway = z.strictObject({ type: z.literal('exclusiveGateway'), name: Label.optional(), in: In });
/** Takes every flow out at once; with several flows in, waits for a token from each. */
const ParallelGateway = z.strictObject({ type: z.literal('parallelGateway'), name: Label.optional(), in: In });

/**
 * Waits for the first of the events after it: a timer, a message, a condition, or a receive task.
 * The first that happens takes the path; the others no longer wait.
 */
const EventBasedGateway = z.strictObject({ type: z.literal('eventBasedGateway'), name: Label.optional(), in: In });
/** Takes every flow out whose condition holds, or else its default; with several flows in, waits for every path that can still arrive. */
const InclusiveGateway = z.strictObject({ type: z.literal('inclusiveGateway'), name: Label.optional(), in: In });
/**
 * Goes on once some of the paths into it have arrived: `waitFor` of them. It takes the flows out
 * as an inclusive gateway does. A path that arrives after that ends there, until no path can still
 * arrive; then it waits again.
 */
const ComplexGateway = z.strictObject({ type: z.literal('complexGateway'), name: Label.optional(), in: In, waitFor: z.int().min(1).max(20) });
/** Waits until a timer fires or a message comes; or, as a link, takes over from the throw link of the same name. One of these. */
const CatchEvent = z.strictObject({
  type: z.literal('intermediateCatchEvent'),
  name: Label.optional(),
  in: In,
  timer: Timer.optional(),
  message: Message.optional(),
  link: Name.optional(),
  /** Waits until this condition on the record holds; if it holds already, the path goes straight on. */
  condition: ConditionSchema.optional(),
  /** Waits until a process of the app, or an operator, throws this signal. */
  signal: Name.optional(),
});
/**
 * A point that a path passes: a milestone that the history marks; a message that it sends on the
 * way; or a link, which goes on at the catch link of the same name, to spare a long flow.
 */
const ThrowEvent = z.strictObject({
  type: z.literal('intermediateThrowEvent'),
  name: Label.optional(),
  in: In,
  message: Message.optional(),
  link: Name.optional(),
  /** Raises an escalation to the sub-process or call around it, and goes on unless that ends it. */
  escalation: Raised.optional(),
  /** Undoes what completed in its run, newest first, and goes on. */
  compensate: z.literal(true).optional(),
  /** Throws this signal to every process of the app that waits for it, and goes on. */
  signal: Name.optional(),
});
/**
 * A part of the process with its own start and end, drawn open on the canvas: the elements in it
 * name it with `in`. It ends when no path is left inside it, and an event on its boundary acts on
 * it as a whole: a deadline for all of it, or an error that anything inside it raises.
 */
const SubProcess = z.strictObject({
  type: z.literal('subProcess'),
  name: Label,
  description: Description.optional(),
  in: In,
  /** A transaction: a cancel end event inside it undoes what completed in it, and leaves by its cancel event. */
  transaction: z.literal(true).optional(),
  /**
   * An event sub-process: the trigger of its start event starts it while the process, or the
   * sub-process it is in, runs. No flow leads into it or out of it.
   */
  event: z.literal(true).optional(),
  /**
   * An ad hoc sub-process: it has no start or end event. What has no flow into it starts at once,
   * so people do its tasks in any order, and a path inside it ends where no flow leads on.
   */
  adHoc: z.literal(true).optional(),
  /** In an ad hoc sub-process: it ends once this holds, as a path inside it moves on, and what still runs inside it ends. */
  completeWhen: ConditionSchema.optional(),
  repeat: Repeat.optional(),
});
/**
 * Runs another process of the app and waits until it ends: on the same record, or, for a process
 * about another entity, on the record that a reference field of this one names.
 */
const CallActivity = z.strictObject({
  type: z.literal('callActivity'),
  name: Label,
  description: Description.optional(),
  in: In,
  /** The process it runs, which starts at its start event without actions. */
  process: Name,
  /** A reference field of the record, for a process about the entity it refers to. */
  record: Name.optional(),
  repeat: Repeat.optional(),
});
/**
 * An event on a task's boundary: a timer or a message on a user task, a sub-process or a call
 * activity, for a deadline, an escalation or a withdrawal; or an error on a service task or a
 * sub-process, which an action failing raises. An interrupting one ends what it sits on; one that
 * doesn't interrupt starts another path beside it.
 */
const BoundaryEvent = z.strictObject({
  type: z.literal('boundaryEvent'),
  name: Label.optional(),
  attachedTo: ElementId,
  interrupting: z.boolean().default(true),
  timer: Timer.optional(),
  message: Message.optional(),
  error: Raised.optional(),
  /** On a sub-process or a call: an escalation from inside it, which may end it or not. */
  escalation: Raised.optional(),
  /** On a transaction: its cancel end event was reached, and what completed in it was undone. */
  cancel: z.literal(true).optional(),
  /** Happens when a change to the record makes this condition hold, where it didn't before. */
  condition: ConditionSchema.optional(),
  /** On a user task, a receive task, a sub-process or a call: a signal that a process of the app, or an operator, throws. */
  signal: Name.optional(),
});

export const ProcessElement = z.discriminatedUnion('type', [
  StartEvent,
  EndEvent,
  UserTask,
  ServiceTask,
  ScriptTask,
  BusinessRuleTask,
  SendTask,
  ReceiveTask,
  PlainTask,
  ManualTask,
  ExclusiveGateway,
  ParallelGateway,
  InclusiveGateway,
  ComplexGateway,
  EventBasedGateway,
  CatchEvent,
  ThrowEvent,
  SubProcess,
  CallActivity,
  BoundaryEvent,
]);
export type ProcessElement = z.infer<typeof ProcessElement>;
export type ProcessElementType = ProcessElement['type'];
export type UserTaskElement = Extract<ProcessElement, { type: 'userTask' }>;
export type ServiceTaskElement = Extract<ProcessElement, { type: 'serviceTask' }>;
export type BoundaryEventElement = Extract<ProcessElement, { type: 'boundaryEvent' }>;
export type CatchEventElement = Extract<ProcessElement, { type: 'intermediateCatchEvent' }>;
export type ScriptTaskElement = Extract<ProcessElement, { type: 'scriptTask' }>;
export type BusinessRuleTaskElement = Extract<ProcessElement, { type: 'businessRuleTask' }>;
export type SubProcessElement = Extract<ProcessElement, { type: 'subProcess' }>;
export type CallActivityElement = Extract<ProcessElement, { type: 'callActivity' }>;

/** A sequence flow: the arrow from one element to the next. */
export const Flow = z.strictObject({
  from: ElementId,
  to: ElementId,
  /** The label on the arrow, such as "Over SGD 1,000". */
  name: Label.optional(),
  /** Out of an exclusive or inclusive gateway: take the flow only if this holds. */
  when: ConditionSchema.optional(),
  /** Out of a user task: the outcome that takes this flow. */
  outcome: Name.optional(),
  /** Out of an exclusive or inclusive gateway: the flow it takes when no other flow's condition holds. */
  default: z.boolean().optional(),
});
export type Flow = z.infer<typeof Flow>;

const Coordinate = z.number().min(-1e6).max(1e6);
const Bounds = z.strictObject({ x: Coordinate, y: Coordinate, width: z.number().positive().max(1e5), height: z.number().positive().max(1e5) });
/** Where each element and flow is drawn: BPMN 2.0's diagram interchange, so a model looks the same in every tool. */
export const Diagram = z.strictObject({
  shapes: z.record(ElementId, z.strictObject({ ...Bounds.shape, label: Bounds.optional() })).default({}),
  edges: z.record(ElementId, z.strictObject({ points: z.array(z.strictObject({ x: Coordinate, y: Coordinate })).min(2).max(50), label: Bounds.optional() })).default({}),
});
export type Diagram = z.infer<typeof Diagram>;

export const MAX_PROCESS_ELEMENTS = 200;
export const MAX_PROCESS_FLOWS = 400;

export const Process = z.strictObject({
  label: Label,
  description: Description.optional(),
  /** Each instance is about one record of this entity. */
  entity: Name,
  elements: z.record(ElementId, ProcessElement).refine((map) => Object.keys(map).length <= MAX_PROCESS_ELEMENTS, `At most ${MAX_PROCESS_ELEMENTS} elements`),
  flows: z.record(ElementId, Flow).refine((map) => Object.keys(map).length <= MAX_PROCESS_FLOWS, `At most ${MAX_PROCESS_FLOWS} flows`),
  diagram: Diagram.optional(),
});
export type Process = z.infer<typeof Process>;

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
  /** The processes this role may start on a record by hand. */
  processes: z.array(Name).max(50).optional(),
});
export type AppRole = z.infer<typeof AppRole>;

export const LIMITS = { entities: 50, rules: 200, actions: 100, queries: 100, cards: 100, forms: 100, roles: 20, pages: 50, processes: 50 } as const;

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
  /**
   * Business processes in BPMN 2.0. Optional rather than empty by default, so that the definitions
   * of earlier releases keep their digests.
   */
  processes: z
    .record(Name, Process)
    .refine((map) => Object.keys(map).length <= LIMITS.processes, `At most ${LIMITS.processes} processes`)
    .optional(),
});
export type AppDefinition = z.infer<typeof AppDefinition>;
export type AppDefinitionInput = z.input<typeof AppDefinition>;

/** An empty app: what a new app starts from. */
export function emptyDefinition(): AppDefinition {
  return AppDefinition.parse({});
}

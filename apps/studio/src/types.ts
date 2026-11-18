import type { AppDefinition } from '@platform/app-model';

/** An app definition as the studio edits it: the format the API validates (packages/app-model). */
export type Definition = AppDefinition;
export type Entity = Definition['entities'][string];
export type Field = Entity['fields'][number];
export type FieldType = Field['type'];
export type Form = Definition['forms'][string];
export type FormSection = Form['sections'][number];
export type FormField = FormSection['fields'][number];

export interface Me {
  type: 'user' | 'service_account';
  id: string;
  email: string | null;
  displayName: string | null;
  personalSpaceId: string | null;
}

/** Where an app runs: the sandbox of a personal app; Prod, Staging and previews of a team app. */
export interface EnvironmentInfo {
  id: string;
  kind: 'sandbox' | 'preview' | 'staging' | 'prod';
  revision: number;
  release: { id: string; number: number } | null;
  changeRequest: { id: string; number: number } | null;
}

/** The delivery steps the caller's roles allow on a team app. */
export interface DeliveryAccess {
  review: boolean;
  approve: boolean;
  merge: boolean;
  release: boolean;
  deploy: boolean;
  approveDeploy: boolean;
  execute: boolean;
  rollback: boolean;
  manageAccess: boolean;
}

export interface AppSummary {
  id: string;
  spaceId: string;
  /** A personal app is edited live; a team app changes through change requests and runs releases. */
  kind: 'personal' | 'team';
  handle: string;
  name: string;
  description: string | null;
  ownerUserId: string;
  /** The newest revision of the main line. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  environment: EnvironmentInfo | null;
  environments?: EnvironmentInfo[];
  workingCopyOf: { appId: string; name: string; baseRevision: number; behind: boolean; changeRequest: { id: string; number: number } | null } | null;
  myWorkingCopyId?: string | null;
  /** On a personal app that moved to a team space: the app it lives on as. It is read-only here. */
  movedTo?: { appId: string; name: string } | null;
  /** On a personal app on its way to a team space: the team app, and the change request that brings it in. */
  promotion?: { appId: string; name: string; changeRequest: { id: string; number: number; status: 'open' | 'merged' | 'closed' } | null } | null;
  /** On a team app made by promotion: the personal app it came from. */
  promotedFrom?: string | null;
  access: { build: boolean; run: boolean; share: boolean; edit: boolean; compose: boolean; roles: string[]; delivery?: DeliveryAccess };
}

export interface Space {
  id: string;
  kind: 'personal' | 'team';
  name: string;
  status: string;
}

export interface PersonRef {
  id: string;
  name: string;
}

export interface ChangeRequestSummary {
  id: string;
  appId: string;
  number: number;
  title: string;
  status: 'open' | 'merged' | 'closed';
  author: PersonRef;
  baseRevision: number;
  headRevision: number;
  mergedRevision: number | null;
  destructive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChangeRequest extends ChangeRequestSummary {
  description: string | null;
  workingCopyId: string | null;
  headDigest: string;
  checks: {
    validation: { ok: boolean; notes: string[] };
    migration: { destructive: boolean; steps: PlanStep[] };
    access: Array<{ role: string; kind: 'gains' | 'loses' | 'changes'; text: string; holders: number }>;
    capabilities: Array<{ tool: string; change: 'added' | 'removed' | 'changed'; text: string }>;
    lint: string[];
  };
  changes: Array<{ section: string; name: string; change: 'added' | 'removed' | 'changed'; from?: string; details: string[] }>;
  behind: boolean;
  conflicts: Array<{ section: string; name: string; ours: string; theirs: string }>;
  reviews: Array<{ id: string; reviewer: PersonRef; verdict: 'approve' | 'request_changes' | 'comment'; comment: string | null; createdAt: string; current: boolean }>;
  approvals: { required: number; approvedBy: PersonRef[]; changesRequestedBy: PersonRef[]; ready: boolean };
  preview: { environmentId: string } | null;
  mergedAt: string | null;
  closedAt: string | null;
}

export interface Release {
  id: string;
  appId: string;
  number: number;
  revision: number;
  digest: string;
  destructive: boolean;
  notes: string | null;
  changes: Array<{ id: string; number: number; title: string; author: PersonRef }>;
  steps: PlanStep[];
  createdBy: PersonRef | null;
  createdAt: string;
  manifestDigest: string;
  keyId: string;
  verified: boolean;
  liveIn: Array<'staging' | 'prod'>;
}

export interface Deployment {
  id: string;
  appId: string;
  environment: 'staging' | 'prod';
  kind: 'deploy' | 'rollback';
  status: 'awaiting_approval' | 'approved' | 'succeeded' | 'failed' | 'cancelled';
  release: { id: string; number: number };
  fromRelease: { id: string; number: number } | null;
  destructive: boolean;
  plan: { steps: PlanStep[]; notes: string[] };
  approvals: { required: number; by: PersonRef[] };
  authors: PersonRef[];
  requestedBy: PersonRef | null;
  requestedAt: string;
  executedBy: PersonRef | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

export interface PlanStep {
  kind: string;
  description: string;
  destructive: boolean;
  records?: number;
}

export interface Plan {
  revision: number;
  destructive: boolean;
  steps: PlanStep[];
  notes: string[];
}

export interface Issue {
  path: string;
  message: string;
}

export interface Share {
  id: string;
  principal: { type: string; id: string; name: string | null };
  appRoleId: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface Revision {
  revision: number;
  digest: string;
  createdBy: { type: string; id: string | null };
  createdAt: string;
  summary: { steps?: PlanStep[]; notes?: string[] } | null;
}

/** GET /v1/apps/{id}/ui: what the signed-in person can use, for generated screens. */
export interface UiField {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** Required only while this holds, of the record's values. */
  requiredWhen?: Definition['rules'][string]['assert'];
  /** What a new record starts with, worked out for the person now. */
  default?: Value;
  description?: string;
  options?: Array<{ value: string; label: string }>;
  multiple?: boolean;
  entity?: string;
  decimals?: number;
  maxLength?: number;
  multiline?: boolean;
  /** For a file field: the kinds it takes, `image` and `pdf`. */
  accept?: string[];
  /** A number worked out from lines: shown, never entered. */
  computed?: boolean;
  /** How it is worked out, such as `{ sum: 'lines.amount' }`. */
  rollup?: Record<string, string>;
  /** For a lines field: the most lines, what a line is called and named by, and the fields of each line. */
  lines?: { max: number; label: string; titleField: string | null; fields: UiField[] };
  read: 'full' | 'masked' | null;
  create: boolean;
  update: boolean;
}

export interface UiEntity {
  label: string;
  pluralLabel: string;
  titleField: string | null;
  can: { read: boolean; create: boolean; update: boolean; delete: boolean };
  fields: UiField[];
}

export interface UiForm {
  label: string;
  entity: string;
  action?: string;
  /** All sections on one page, or a section at a time. */
  layout: 'page' | 'steps';
  sections: Array<{
    title?: string;
    fields: Array<{ field: string; label?: string; help?: string; width: 'full' | 'half'; readOnly: boolean; visibleWhen?: Definition['rules'][string]['assert'] }>;
  }>;
}

export interface UiAction {
  label: string;
  description: string;
  entity: string;
  operation: 'create' | 'update';
  input: string[];
  confirm: 'none' | 'preview' | 'review';
}

/** A column of a page's list: a field, or a system field such as `created_at`. */
export interface UiColumn {
  name: string;
  label: string;
  type: string;
  options?: Array<{ value: string; label: string }>;
  decimals?: number;
}

/** A block of a page, as the person may use it. A list names its place in the page, which reads its records. */
export type UiBlock =
  | { type: 'text'; style: 'heading' | 'paragraph' | 'note'; text: string }
  | { type: 'list'; index: number; entity: string; title?: string; columns: UiColumn[]; actions: string[]; empty?: string }
  | { type: 'buttons'; buttons: Array<{ form: string; label?: string } | { page: string; label?: string }> }
  | { type: 'stat'; index: number; entity: string; label: string; op: string; decimals: number }
  | {
      type: 'chart';
      index: number;
      entity: string;
      title: string;
      show: 'bar' | 'column' | 'line' | 'table';
      width: 'full' | 'half';
      op: string;
      decimals: number;
      group: { label: string; kind: 'value' | 'person' | 'period'; period?: string };
    };

export interface UiPage {
  label: string;
  description?: string;
  blocks: UiBlock[];
}

/** The app's own menu, as the person may use it. */
export interface UiNavigation {
  home: string | null;
  items: Array<{ page: string; label: string } | { form: string; label: string } | { entity: string; label: string } | { heading: string }>;
}

export interface UiManifest {
  app: AppSummary;
  entities: Record<string, UiEntity>;
  forms: Record<string, UiForm>;
  actions: Record<string, UiAction>;
  queries: Record<string, { label: string; description: string; entity: string; fields: string[] }>;
  pages: Record<string, UiPage>;
  /** Null when the app has no menu of its own: then it lists every form and list. */
  navigation: UiNavigation | null;
}

export type Value = string | number | boolean | string[] | null;

/** A line of a record: its ID once it's saved, and its values. */
export type Line = { id?: string } & { [field: string]: Value | undefined };

/** A value of a record: a single value, or a lines field's lines. */
export type RecordValue = Value | Line[];

/** A file, as screens show it. */
export interface FileInfo {
  name: string;
  contentType: string;
  size: number;
}

export interface RecordOut {
  id: string;
  version: number;
  owner?: string;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
  values?: Record<string, RecordValue>;
  /** Fields shown masked; fields of lines as `lines.amount`. */
  masked?: string[];
  /** The files the values name, by ID. */
  files?: Record<string, FileInfo>;
}

/** Someone a record or its history names: a person, or an agent that changed the record. */
export interface Person {
  id: string;
  kind: 'person' | 'agent';
  name: string;
  /** In search results, to tell two people with the same name apart. */
  email?: string | null;
  /** False for someone who has left, or an agent that's disabled. */
  active: boolean;
}

export type Source = { source: string; [key: string]: unknown };

/** How a record's lines changed: fields by name, those masked from the person listed. */
export interface LinesChange {
  added: Array<{ id: string; values: Record<string, Value>; masked?: string[]; sources?: Record<string, Source> }>;
  removed: Array<{ id: string; values: Record<string, Value>; masked?: string[] }>;
  changed: Array<{ id: string; changes: Array<{ field: string; before?: Value; after?: Value; masked?: true; source?: Source }> }>;
  reordered: boolean;
}

export interface HistoryEntry {
  version: number;
  operation: 'create' | 'update' | 'delete';
  at: string;
  /** Who made the change. When an agent did, `onBehalfOf` is the person it acted for. */
  actor: { type: string; id: string | null; onBehalfOf: string | null };
  via: string;
  changes: Array<{ field: string; before?: Value; after?: Value; lines?: LinesChange; masked?: true; removed?: true; source?: Source }>;
}

/** A person's task in a business process (design §6.10): a decision that waits in their inbox. */
/** A connection or a webhook of an app, with whether the environment keeps the secret it needs: never the secret. */
export interface SecretState {
  set: boolean;
  setAt: string | null;
}
export interface IntegrationStatus {
  connections: Array<{ name: string; kind: 'service' | 'teams'; label: string; host: string | null; needsSecret: boolean; secret: SecretState }>;
  webhooks: Array<{ name: string; label: string; flow: string; url: string; secret: SecretState }>;
}

/** What reached the person: a flow told them, or a task came to them, is due soon or is overdue. */
export interface Notice {
  id: string;
  kind: 'inform' | 'task_assigned' | 'task_due_soon' | 'task_overdue';
  title: string;
  message: string | null;
  app: { id: string; name: string };
  about: { entity: string; recordId: string; label: string | null } | null;
  taskId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NoticeSettings {
  email: boolean;
  /** Whether the installation sends email at all. */
  emailAvailable: boolean;
}

export interface Task {
  id: string;
  name: string;
  status: 'open' | 'completed' | 'cancelled';
  app: { id: string; name: string };
  environment: { id: string };
  process: string;
  instanceId: string;
  element: string;
  entity: string;
  recordId: string;
  role: string;
  assignee: { id: string; name: string | null } | null;
  outcomes: Array<{ name: string; label: string; action?: string }>;
  card: string | null;
  due: string | null;
  overdue: boolean;
  /** One vote of a task that several people decide, and how many vote. */
  several: boolean;
  voters: number | null;
  outcome: string | null;
  completedBy: string | null;
  createdAt: string;
  closedAt: string | null;
}

/** One run of a process on a record: where it waits, and what happened in it. */
/** Where the cases of a flow that waits are now, by the path of the step each waits at. */
export interface FlowLive {
  running: number;
  steps: Array<{ path: string; waiting: number; stuck: number; since: string }>;
  /** A flow on a schedule: when it runs next, and how its last run went. */
  schedule?: { nextRunAt: string; lastRunAt: string | null; lastError: string | null };
}

export interface ProcessInstance {
  id: string;
  process: string;
  label: string;
  revision: number;
  entity: string;
  recordId: string;
  status: 'running' | 'completed' | 'cancelled';
  stuck: Array<{ element: string; name: string; error: string }>;
  waiting: Array<{ element: string; name: string }>;
  startedBy: string | null;
  startedByAction: string | null;
  calledBy: string | null;
  startedAt: string;
  endedAt: string | null;
  tasks?: Task[];
  events?: Array<{ at: string; kind: string; element: string | null; name: string | null; by: string | null; detail: unknown }>;
}

/** A file that the builder gives the chat: a picture of a form, or a PDF. */
export interface ComposeAttachment {
  readonly name: string;
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'application/pdf';
  readonly data: string;
}

/** What the builder asks the chat that builds apps. */
export interface ComposeRequest {
  readonly prompt: string;
  readonly definition: Definition;
  readonly history: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly text: string }>;
  readonly attachments: readonly ComposeAttachment[];
}

/** What the chat answers: its reply, and the draft when it changed the definition. */
export interface ComposeReply {
  readonly reply: string;
  readonly changed: boolean;
  readonly definition: Definition | null;
  /** How many problems the checks still find in the draft. */
  readonly problems: number;
  readonly edits: number;
  readonly turns: number;
  readonly stopped: 'turns' | 'length' | 'declined' | null;
}

/** What running a flow gave: its result, its warnings and its writes. A dry run undid the writes. */
export interface FlowRunResult {
  readonly output: unknown;
  readonly findings: ReadonlyArray<{ readonly flow: string; readonly message: string }>;
  readonly writes: { readonly created: number; readonly changed: number; readonly deleted: number };
  readonly dryRun: boolean;
}

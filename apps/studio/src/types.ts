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
  access: { build: boolean; run: boolean; share: boolean; edit: boolean; roles: string[]; delivery?: DeliveryAccess };
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
  sections: Array<{ title?: string; fields: Array<{ field: string; label?: string; help?: string; width: 'full' | 'half'; readOnly: boolean }> }>;
}

export interface UiAction {
  label: string;
  description: string;
  entity: string;
  operation: 'create' | 'update';
  input: string[];
  confirm: 'none' | 'preview' | 'review';
}

export interface UiManifest {
  app: AppSummary;
  entities: Record<string, UiEntity>;
  forms: Record<string, UiForm>;
  actions: Record<string, UiAction>;
  queries: Record<string, { label: string; description: string; entity: string; fields: string[] }>;
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

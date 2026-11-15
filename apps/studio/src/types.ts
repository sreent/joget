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

export interface AppSummary {
  id: string;
  spaceId: string;
  handle: string;
  name: string;
  description: string | null;
  ownerUserId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  access: { build: boolean; run: boolean; share: boolean; roles: string[] };
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

export interface RecordOut {
  id: string;
  version: number;
  owner?: string;
  createdAt?: string;
  createdBy?: string;
  updatedAt?: string;
  updatedBy?: string;
  values?: Record<string, Value>;
  masked?: string[];
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

export interface HistoryEntry {
  version: number;
  operation: 'create' | 'update' | 'delete';
  at: string;
  /** Who made the change. When an agent did, `onBehalfOf` is the person it acted for. */
  actor: { type: string; id: string | null; onBehalfOf: string | null };
  via: string;
  changes: Array<{ field: string; before?: Value; after?: Value; masked?: true; removed?: true; source?: { source: string; [key: string]: unknown } }>;
}

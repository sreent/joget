import { z } from 'zod';

export const AppParams = z.object({ appId: z.uuid() });

/**
 * Which environment of a team app to use: `prod` (the default), `staging`, or a change request's
 * preview by its environment ID. A personal app has only its sandbox.
 */
export const EnvQuery = z.object({
  env: z
    .union([z.enum(['prod', 'staging']), z.uuid()])
    .optional()
    .describe("A team app's environment: prod (the default), staging, or a preview's environment ID"),
});
export const EntityParams = AppParams.extend({ entity: z.string().min(1).max(63) });
export const RecordParams = EntityParams.extend({ recordId: z.uuid() });

export const EnvironmentOut = z.object({
  id: z.uuid(),
  kind: z.enum(['sandbox', 'preview', 'staging', 'prod']),
  /** The revision the environment runs. */
  revision: z.number().int(),
  /** Staging and Prod: the release that is live. */
  release: z.object({ id: z.uuid(), number: z.number().int() }).nullable(),
  /** A preview: the change request it shows. */
  changeRequest: z.object({ id: z.uuid(), number: z.number().int() }).nullable(),
});

export const AppOut = z.object({
  id: z.uuid(),
  spaceId: z.uuid(),
  /** A personal app is edited live. A team app changes through change requests and runs releases. */
  kind: z.enum(['personal', 'team']),
  handle: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  ownerUserId: z.uuid(),
  /** The newest revision of the main line. */
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The environment this description is about, when it has one: the sandbox, Prod, Staging or a preview. */
  environment: EnvironmentOut.nullable(),
  /** A team app's environments, without previews. */
  environments: z.array(EnvironmentOut).optional(),
  /** Set on a working copy: the team app it changes, and how it stands. */
  workingCopyOf: z
    .object({
      appId: z.uuid(),
      name: z.string(),
      /** The team app's main-line revision this copy last took in. */
      baseRevision: z.number().int(),
      /** True when the team app's main line has moved on since. */
      behind: z.boolean(),
      /** The change request this copy has open, if any. */
      changeRequest: z.object({ id: z.uuid(), number: z.number().int() }).nullable(),
    })
    .nullable(),
  /** On a team app: the caller's own working copy of it, if they have one. */
  myWorkingCopyId: z.uuid().nullable().optional(),
  /** On a personal app that moved to a team space: the app it lives on as. It is read-only here. */
  movedTo: z.object({ appId: z.uuid(), name: z.string() }).nullable().optional(),
  /** On a personal app on its way to a team space: the team app, and the change request that brings it in. */
  promotion: z
    .object({
      appId: z.uuid(),
      name: z.string(),
      changeRequest: z.object({ id: z.uuid(), number: z.number().int(), status: z.enum(['open', 'merged', 'closed']) }).nullable(),
    })
    .nullable()
    .optional(),
  /** On a team app made by promotion: the personal app it came from. */
  promotedFrom: z.uuid().nullable().optional(),
  /** What the caller may do with the app. */
  access: z.object({
    build: z.boolean(),
    run: z.boolean(),
    share: z.boolean(),
    /** Change the definition: for a team app, make a working copy and submit changes. */
    edit: z.boolean(),
    /** Change the definition by chat, on the installation's model (design §6.5). */
    compose: z.boolean(),
    roles: z.array(z.string()),
    /** On a team app: the delivery steps the caller's roles allow. Separation of duties is checked when they act. */
    delivery: z
      .object({
        review: z.boolean(),
        approve: z.boolean(),
        merge: z.boolean(),
        release: z.boolean(),
        deploy: z.boolean(),
        approveDeploy: z.boolean(),
        execute: z.boolean(),
        rollback: z.boolean(),
        manageAccess: z.boolean(),
      })
      .optional(),
  }),
});

export const PlanOut = z.object({
  revision: z.number().int(),
  destructive: z.boolean(),
  steps: z.array(z.object({ kind: z.string(), description: z.string(), destructive: z.boolean(), records: z.number().int().optional() })),
  notes: z.array(z.string()),
});

/**
 * A record. Fields the caller can't see are absent; masked ones are listed. A caller who may write
 * a record but not read it gets only its ID and version.
 */
export const RecordOut = z.object({
  id: z.uuid(),
  version: z.number().int(),
  owner: z.uuid().optional(),
  createdAt: z.string().optional(),
  createdBy: z.uuid().optional(),
  updatedAt: z.string().optional(),
  updatedBy: z.uuid().optional(),
  values: z.record(z.string(), z.unknown()).optional(),
  masked: z.array(z.string()).optional(),
  /** The files the values name, by ID. */
  files: z.record(z.string(), z.object({ name: z.string(), contentType: z.string(), size: z.number().int() })).optional(),
  /** The titles of the records the values refer to, by ID, of those the caller may read. */
  titles: z.record(z.string(), z.string()).optional(),
});

export const PageOut = z.object({ records: z.array(RecordOut), nextCursor: z.string().nullable() });

/** What an import of CSV found: which field each column fills, each line's problems, and how many records it made. */
export const ImportOut = z.object({
  columns: z.array(z.object({ header: z.string(), field: z.string().nullable(), note: z.string().optional() })),
  rows: z.number().int(),
  issues: z.array(z.object({ row: z.number().int(), field: z.string().optional(), message: z.string() })),
  created: z.number().int(),
});

export const FindingOut = z.object({
  rule: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  fields: z.array(z.string()),
  /** For a rule on lines: which line it is about. */
  line: z.object({ field: z.string(), index: z.number().int() }).optional(),
});

const CardFieldOut = z.object({
  name: z.string(),
  label: z.string(),
  type: z.string(),
  value: z.unknown(),
  display: z.string(),
  source: z.record(z.string(), z.unknown()).optional(),
});

export const CardOut = z.object({
  title: z.string(),
  findings: z.array(FindingOut),
  fields: z.array(CardFieldOut),
  /** Lines, as tables: one row per line, with its ID once it has one. */
  tables: z
    .array(
      z.object({
        field: z.string(),
        label: z.string(),
        columns: z.array(z.object({ name: z.string(), label: z.string(), type: z.string() })),
        rows: z.array(z.object({ id: z.string().nullable(), cells: z.array(CardFieldOut) })),
      }),
    )
    .optional(),
  responses: z.array(z.string()),
});

export const ProposalOut = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  action: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'superseded', 'expired']),
  digest: z.string(),
  recordId: z.uuid().nullable(),
  expiresAt: z.string(),
  reviewUrl: z.string(),
  card: CardOut,
  findings: z.array(FindingOut),
  resultRecordId: z.uuid().nullable(),
  revises: z.uuid().nullable(),
});

export const ActionResultOut = z.discriminatedUnion('status', [
  z.object({ status: z.literal('done'), record: RecordOut }),
  z.object({ status: z.literal('needs_confirmation'), proposal: ProposalOut, card: CardOut }),
  z.object({ status: z.literal('preview'), needsConfirmation: z.boolean(), findings: z.array(FindingOut), card: CardOut }),
]);

export const ProvenanceIn = z
  .record(z.string(), z.record(z.string(), z.unknown()))
  .optional()
  .describe('Where each value came from: { field: { source: "document" | "agent" | "person" | "platform", ... } }');

/** What the app's tests found: how many passed and failed, and each test's result. */
export const TestsOut = z.object({
  passed: z.number().int(),
  failed: z.number().int(),
  results: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      passed: z.boolean(),
      outcome: z.enum(['saved', 'refused', 'error']),
      message: z.string().optional(),
      mismatches: z.array(z.object({ field: z.string(), expected: z.unknown(), actual: z.unknown() })).optional(),
    }),
  ),
});

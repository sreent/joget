import { z } from 'zod';

export const AppParams = z.object({ appId: z.uuid() });
export const EntityParams = AppParams.extend({ entity: z.string().min(1).max(63) });
export const RecordParams = EntityParams.extend({ recordId: z.uuid() });

export const AppOut = z.object({
  id: z.uuid(),
  spaceId: z.uuid(),
  handle: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  ownerUserId: z.uuid(),
  revision: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** What the caller may do with the app. */
  access: z.object({ build: z.boolean(), run: z.boolean(), share: z.boolean(), roles: z.array(z.string()) }),
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
});

export const PageOut = z.object({ records: z.array(RecordOut), nextCursor: z.string().nullable() });

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

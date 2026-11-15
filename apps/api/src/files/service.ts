import { createHash } from 'node:crypto';
import { uuidv7 } from '@platform/audit';
import { ident, type FileInfo, type FileKind, type StoredField } from '@platform/app-model';
import { appEnvironments } from '@platform/db';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { LoadedApp } from '../apps/catalog.js';
import { withAppTransaction, type AppTransaction } from '../apps/transaction.js';
import { auditScopeFor, recordAudit } from '../audit/writer.js';
import type { AuthContext } from '../context.js';
import type { Config } from '../config.js';
import type { Database } from '@platform/db';
import type pg from 'pg';
import { HttpError, unprocessable } from '../errors.js';
import { ScannerUnavailableError, type Scanner } from './scan.js';
import { cleanName, sniff } from './sniff.js';
import type { BlobStore } from './store.js';

/** A file as the API describes it. */
export interface FileOut {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
  /** `clean` once a scanner checked it; `not_scanned` where no scanner is set up (never in production). */
  readonly scan: 'clean' | 'not_scanned';
  readonly attached: boolean;
}

/** A file's row, as the platform reads it. */
export interface FileRow {
  readonly id: string;
  readonly name: string;
  readonly content_type: string;
  readonly size: string;
  readonly sha256: string;
  readonly storage_key: string;
  readonly scan: 'clean' | 'not_scanned';
  readonly created_by: string;
  readonly on_behalf_of: string | null;
  readonly attached_at: Date | null;
  readonly entity_id: string | null;
  readonly record_id: string | null;
  readonly expires_at: Date | null;
}

/** A file a write sets, with the field that holds it and where, such as `lines[2].receipt`. */
export interface FileUse {
  readonly fileId: string;
  readonly field: StoredField;
  readonly path: string;
}

/** The most uploads one person may have waiting to be attached, in one app environment. */
export const MAX_WAITING_UPLOADS = 200;

const KIND_OF: Record<string, FileKind> = { 'application/pdf': 'pdf' };
const kindOf = (contentType: string): FileKind => KIND_OF[contentType] ?? 'image';
const KIND_LABEL: Record<FileKind, string> = { image: 'images', pdf: 'PDFs' };

export const toFileOut = (row: FileRow): FileOut => ({
  id: row.id,
  name: row.name,
  contentType: row.content_type,
  size: Number(row.size),
  sha256: row.sha256,
  scan: row.scan,
  attached: row.attached_at !== null,
});

/** Whose a file is: the person it was uploaded for, even if their agent uploaded it. */
const ownerOf = (row: Pick<FileRow, 'created_by' | 'on_behalf_of'>) => row.on_behalf_of ?? row.created_by;

/**
 * Files people and their agents upload, such as receipts (design §6.1). An upload is checked for
 * what it really is and for malware, kept, and waits to be attached: a record that refers to it
 * attaches it, and only then can others see it, through that record. Uploads nobody attaches expire.
 */
export class FileService {
  constructor(
    readonly ctx: { readonly config: Config; readonly db: Database; readonly pool: pg.Pool; readonly org: { readonly id: string }; readonly now: () => Date },
    readonly store: BlobStore,
    readonly scanner: Scanner,
  ) {}

  #table(loaded: LoadedApp) {
    return `${ident(loaded.env.schemaName)}.files`;
  }

  async upload(request: FastifyRequest, auth: AuthContext, loaded: LoadedApp, input: { readonly content: Buffer; readonly name?: string }): Promise<FileOut> {
    const { ctx } = this;
    if (!input.content.length) throw unprocessable('empty_file', 'The file is empty');
    const type = sniff(input.content);
    if (!type) throw new HttpError(415, 'unsupported_file_type', 'Upload an image (JPEG, PNG, GIF, WebP or HEIC) or a PDF');
    if (this.scanner.kind === 'none' && ctx.config.NODE_ENV === 'production') {
      throw new HttpError(503, 'scanning_unavailable', 'Uploads need a malware scanner, and none is set up here (FILE_SCANNER)');
    }
    const sha256 = createHash('sha256').update(input.content).digest('hex');
    let scan;
    try {
      scan = await this.scanner.scan(input.content);
    } catch (error) {
      if (error instanceof ScannerUnavailableError) throw new HttpError(503, 'scanning_unavailable', 'The malware scanner could not check this file. Try again later.');
      throw error;
    }
    const now = ctx.now();
    const scope = auditScopeFor(request, ctx.org.id, now);
    const where = { spaceId: loaded.space.id, appId: loaded.app.id, env: loaded.env.kind };
    if (!scan.clean) {
      await recordAudit(ctx.db, scope, { action: 'file.upload', outcome: 'denied', ...where, reason: { threat: scan.threat, sha256, size: input.content.length } });
      throw unprocessable('file_rejected', `This file was refused: the malware scanner found ${scan.threat}`);
    }
    const id = uuidv7(now.getTime());
    const owner = auth.actor.id;
    const row = await withAppTransaction(ctx.pool, loaded.env, 'records', async (tx) => {
      const waiting = await tx.query<{ n: number }>(
        `select count(*)::int as n from ${this.#table(loaded)} where coalesce(on_behalf_of, created_by) = $1::uuid and attached_at is null and expires_at > $2::timestamptz`,
        [owner, now.toISOString()],
      );
      if ((waiting.rows[0]?.n ?? 0) >= MAX_WAITING_UPLOADS) {
        throw new HttpError(429, 'too_many_uploads', `You have ${MAX_WAITING_UPLOADS} uploads waiting to be used here. Use or let some expire first.`);
      }
      const expires = new Date(now.getTime() + ctx.config.FILE_UNATTACHED_TTL_HOURS * 3_600_000);
      const inserted = await tx.query<FileRow>(
        `insert into ${this.#table(loaded)} (id, name, content_type, size, sha256, storage_key, scan, created_at, created_by, on_behalf_of, expires_at) ` +
          'values ($1::uuid, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::uuid, $10::uuid, $11::timestamptz) returning *',
        // An agent's upload is the person's, with the agent recorded as who did it.
        [id, cleanName(input.name, type), type.contentType, input.content.length, sha256, 'pending', scan.scanned ? 'clean' : 'not_scanned', now.toISOString(), auth.agent?.id ?? auth.actor.id, auth.agent ? auth.actor.id : null, expires.toISOString()],
      );
      const key = await this.store.put(tx, loaded.env, id, input.content, type.contentType);
      await tx.platformQuery(`update ${this.#table(loaded)} set storage_key = $2 where id = $1::uuid`, [id, key]);
      await recordAudit(tx.db, scope, {
        action: 'file.upload',
        target: { type: 'file', id },
        ...where,
        reason: { contentType: type.contentType, size: input.content.length, sha256, scan: scan.scanned ? 'clean' : 'not_scanned' },
      });
      return { ...inserted.rows[0]!, storage_key: key };
    }).catch(async (error: unknown) => {
      // The object store isn't part of the transaction: don't leave content behind for a file that isn't.
      if (this.store.kind === 's3') await this.store.remove(loaded.env, [`${loaded.env.schemaName}/${id}`]).catch(() => undefined);
      throw error;
    });
    return toFileOut(row);
  }

  /** A file of this environment, or null. */
  async find(tx: AppTransaction, loaded: LoadedApp, id: string): Promise<FileRow | null> {
    const { rows } = await tx.query<FileRow>(`select * from ${this.#table(loaded)} where id = $1::uuid`, [id]);
    return rows[0] ?? null;
  }

  /** The content of a file found with find(). */
  content(tx: AppTransaction, loaded: LoadedApp, row: FileRow): Promise<Buffer | null> {
    return this.store.get(tx, loaded.env, row.storage_key);
  }

  /** Names, types and sizes of files, by ID, for records and cards. */
  async describe(tx: AppTransaction, loaded: LoadedApp, ids: readonly string[]): Promise<Record<string, FileInfo>> {
    if (!ids.length || !(await this.#hasTable(tx, loaded))) return {};
    const { rows } = await tx.query<FileRow>(`select id, name, content_type, size from ${this.#table(loaded)} where id = any($1::uuid[])`, [[...new Set(ids)]]);
    return Object.fromEntries(rows.map((row) => [row.id, { name: row.name, contentType: row.content_type, size: Number(row.size) }]));
  }

  /**
   * Check that a write may use these files: each is in this environment, the caller's own upload,
   * not attached to another record, not expired, and of a kind its field takes.
   */
  async checkUses(tx: AppTransaction, loaded: LoadedApp, auth: AuthContext, uses: readonly FileUse[], target: { readonly entityId: string; readonly recordId: string | null }): Promise<void> {
    if (!uses.length) return;
    const rows = (await this.#hasTable(tx, loaded))
      ? (await tx.query<FileRow>(`select * from ${this.#table(loaded)} where id = any($1::uuid[])`, [[...new Set(uses.map((use) => use.fileId))]])).rows
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const now = this.ctx.now().getTime();
    const issues = uses.flatMap(({ fileId, field, path }) => {
      const row = byId.get(fileId);
      const problem = (message: string) => [{ field: path, code: 'invalid_file', message }];
      if (!row) return problem('No such file here: upload it to this app first');
      if (ownerOf(row) !== auth.actor.id) return problem('You can only use files you uploaded');
      if (row.attached_at && !(row.entity_id === target.entityId && row.record_id === target.recordId)) return problem('This file belongs to another record');
      if (!row.attached_at && row.expires_at && row.expires_at.getTime() <= now) return problem('This upload has expired: upload it again');
      const accept = field.type === 'file' ? field.accept : [];
      if (!accept.includes(kindOf(row.content_type))) return problem(`${field.label} takes ${accept.map((kind) => KIND_LABEL[kind]).join(' or ')}`);
      return [];
    });
    if (issues.length) throw unprocessable('invalid_values', 'Some files can\'t be used here', { issues });
  }

  /** Attach files to the record that now refers to them: they stop expiring, and others can see them through it. */
  async attach(tx: AppTransaction, loaded: LoadedApp, target: { readonly entityId: string; readonly recordId: string }, ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    await tx.query(
      `update ${this.#table(loaded)} set attached_at = $2::timestamptz, entity_id = $3, record_id = $4::uuid, expires_at = null where id = any($1::uuid[]) and attached_at is null`,
      [[...new Set(ids)], this.ctx.now().toISOString(), target.entityId, target.recordId],
    );
  }

  /** Remove uploads that expired before anyone attached them, in every app environment. Returns how many. */
  async sweep(log?: { info(obj: object, message: string): void }): Promise<number> {
    const environments = await this.ctx.db.select().from(appEnvironments).where(eq(appEnvironments.status, 'active'));
    let removed = 0;
    for (const env of environments) {
      const rows = await withAppTransaction(this.ctx.pool, env, 'records', async (tx) => {
        const exists = await tx.platformQuery<{ t: string | null }>('select to_regclass($1) as t', [`${ident(env.schemaName)}.files`]);
        if (!exists.rows[0]?.t) return [];
        // The platform deletes as itself: the environment's role may never delete a file.
        return (
          await tx.platformQuery<{ id: string; storage_key: string }>(
            `delete from ${ident(env.schemaName)}.files where attached_at is null and expires_at < $1::timestamptz returning id, storage_key`,
            [this.ctx.now().toISOString()],
          )
        ).rows;
      });
      if (!rows.length) continue;
      await this.store.remove(env, rows.map((row) => row.storage_key));
      removed += rows.length;
      log?.info({ appId: env.appId, env: env.kind, files: rows.length }, 'Removed expired uploads');
    }
    return removed;
  }

  async #hasTable(tx: AppTransaction, loaded: LoadedApp): Promise<boolean> {
    const { rows } = await tx.platformQuery<{ t: string | null }>('select to_regclass($1) as t', [this.#table(loaded)]);
    return Boolean(rows[0]?.t);
  }
}

/** Run the sweeper now and then, until stopped. */
export function startFileSweeper(files: FileService, options: { readonly intervalSeconds: number; readonly logger: { info(obj: object, message: string): void; error(obj: object, message: string): void } }): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    files
      .sweep(options.logger)
      .catch((error: unknown) => options.logger.error({ err: error }, 'Removing expired uploads failed'))
      .finally(() => (running = false));
  }, options.intervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

import { DeleteObjectsCommand, GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ident } from '@platform/app-model';
import type { AppTransaction } from '../apps/transaction.js';
import type { Config } from '../config.js';

/** An app environment, as far as storing its files goes. */
export interface FileEnvironment {
  readonly schemaName: string;
}

/**
 * Where file content lives (design §7.3: provider-specific storage sits behind an adapter that
 * passes a shared conformance test). File metadata always lives with the app's records; the
 * content goes where the store puts it, under the key it returns.
 */
export interface BlobStore {
  readonly kind: 'postgres' | 's3';
  /** Keep a file's content. Called inside the transaction that records the file, after its row. */
  put(tx: AppTransaction, env: FileEnvironment, id: string, content: Buffer, contentType: string): Promise<string>;
  /** A file's content, or null if it's gone. */
  get(tx: AppTransaction, env: FileEnvironment, key: string): Promise<Buffer | null>;
  /** Forget content, by key, once its files are deleted. Content kept with its row goes with it. */
  remove(env: FileEnvironment, keys: readonly string[]): Promise<void>;
}

/** Content in the environment's own schema, beside its records and under its role. */
export const postgresBlobStore: BlobStore = {
  kind: 'postgres',
  async put(tx, env, id, content) {
    await tx.query(`insert into ${ident(env.schemaName)}.file_contents (file_id, content) values ($1::uuid, $2)`, [id, content]);
    return `db:${id}`;
  },
  async get(tx, env, key) {
    const { rows } = await tx.query<{ content: Buffer }>(`select content from ${ident(env.schemaName)}.file_contents where file_id = $1::uuid`, [key.slice('db:'.length)]);
    return rows[0]?.content ?? null;
  },
  async remove() {
    // The content rows are deleted with their files.
  },
};

/** Content in an S3-compatible bucket, one prefix per app environment. */
export function s3BlobStore(options: {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
}): BlobStore {
  const client = new S3Client({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    forcePathStyle: options.forcePathStyle ?? false,
    ...(options.credentials ? { credentials: options.credentials } : {}),
  });
  const keyOf = (env: FileEnvironment, id: string) => `${env.schemaName}/${id}`;
  return {
    kind: 's3',
    async put(_tx, env, id, content, contentType) {
      const key = keyOf(env, id);
      await client.send(new PutObjectCommand({ Bucket: options.bucket, Key: key, Body: content, ContentType: contentType, ContentLength: content.length }));
      return key;
    },
    async get(_tx, env, key) {
      if (!key.startsWith(`${env.schemaName}/`)) return null;
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
        return object.Body ? Buffer.from(await object.Body.transformToByteArray()) : null;
      } catch (error) {
        if (error instanceof NoSuchKey) return null;
        throw error;
      }
    },
    async remove(env, keys) {
      const own = keys.filter((key) => key.startsWith(`${env.schemaName}/`));
      for (let i = 0; i < own.length; i += 1000) {
        await client.send(new DeleteObjectsCommand({ Bucket: options.bucket, Delete: { Objects: own.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }));
      }
    },
  };
}

export function createBlobStore(config: Config): BlobStore {
  if (config.FILE_STORE === 'postgres') return postgresBlobStore;
  return s3BlobStore({
    bucket: config.S3_BUCKET!,
    region: config.S3_REGION,
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    ...(config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY ? { credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY } } : {}),
  });
}

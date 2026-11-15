import { CreateBucketCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { EXPENSE_APP } from '@platform/app-model';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppTransaction } from '../src/apps/transaction.js';
import { s3BlobStore } from '../src/files/store.js';
import { startTestApp, type Session, type TestApp } from './helpers.js';

/**
 * The S3 file store, against any S3-compatible server. Opt-in, because it needs one:
 *   TEST_S3_ENDPOINT=http://127.0.0.1:9000 TEST_DATABASE_URL=... pnpm --filter @platform/api test:integration -- files-s3
 * moto (`moto_server -p 9000`) or MinIO both do.
 */

const endpoint = process.env['TEST_S3_ENDPOINT'];
const BUCKET = 'ambit-test';
const credentials = { accessKeyId: 'test', secretAccessKey: 'test-secret' };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 3)]);
const noTx = null as unknown as AppTransaction; // the S3 store keeps nothing in the database

describe.skipIf(!endpoint)('files kept in S3', () => {
  const client = new S3Client({ region: 'us-east-1', endpoint: endpoint!, forcePathStyle: true, credentials });
  let t: TestApp;
  let bob: Session;
  let appId: string;
  const as = (session: Session) => ({ cookies: session.cookies });
  const inject = async (options: InjectOptions, expected: number) => {
    const response = await t.app.inject(options);
    expect(response.statusCode, response.body).toBe(expected);
    return response;
  };

  beforeAll(async () => {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => undefined);
    t = await startTestApp({
      FILE_STORE: 's3',
      S3_BUCKET: BUCKET,
      S3_ENDPOINT: endpoint!,
      S3_FORCE_PATH_STYLE: 'true',
      S3_ACCESS_KEY_ID: credentials.accessKeyId,
      S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
      PROPOSAL_TTL_HOURS: '1',
      FILE_UNATTACHED_TTL_HOURS: '1',
    });
    const alice = await t.login('alice');
    bob = await t.login('bob');
    appId = (await inject({ method: 'POST', url: `/v1/spaces/${alice.personalSpaceId}/apps`, ...as(alice), payload: { name: 'Expenses', definition: EXPENSE_APP } }, 201)).json().app.id;
    await inject({ method: 'POST', url: `/v1/apps/${appId}/shares`, ...as(alice), payload: { email: 'bob@example.com', role: 'requester' } }, 201);
  });

  afterAll(async () => {
    await t?.close();
  });

  it('keeps, returns and forgets content, each environment under its own prefix', async () => {
    const store = s3BlobStore({ bucket: BUCKET, region: 'us-east-1', endpoint: endpoint!, forcePathStyle: true, credentials });
    const env = { schemaName: 'app_test_sandbox' };
    const key = await store.put(noTx, env, '0193a7c4-0000-7000-8000-000000000001', JPEG, 'image/jpeg');
    expect(key).toBe('app_test_sandbox/0193a7c4-0000-7000-8000-000000000001');
    expect((await store.get(noTx, env, key))!.equals(JPEG)).toBe(true);
    // Another environment can't read it, even by naming the key.
    expect(await store.get(noTx, { schemaName: 'app_other_sandbox' }, key)).toBeNull();
    await store.remove(env, [key]);
    expect(await store.get(noTx, env, key)).toBeNull();
  });

  it('uploads, attaches, downloads and expires through the API', async () => {
    const file = (await inject({ method: 'POST', url: `/v1/apps/${appId}/files?name=taxi.jpg`, ...as(bob), headers: { 'content-type': 'image/jpeg' }, payload: JPEG }, 201)).json();
    const key = `${(await t.ctx.apps.load(appId)).env.schemaName}/${file.id}`;
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    const run = await inject(
      {
        method: 'POST',
        url: `/v1/apps/${appId}/actions/submit_claim/run`,
        ...as(bob),
        payload: { values: { title: 'Taxi', lines: [{ date: '2026-11-02', merchant: 'Comfort', category: 'travel', amount: 32.4, receipt: file.id }] } },
      },
      201,
    );
    expect(run.json().record.files[file.id].name).toBe('taxi.jpg');
    expect((await inject({ method: 'GET', url: `/v1/apps/${appId}/files/${file.id}`, ...as(bob) }, 200)).rawPayload.equals(JPEG)).toBe(true);

    const late = (await inject({ method: 'POST', url: `/v1/apps/${appId}/files`, ...as(bob), headers: { 'content-type': 'image/jpeg' }, payload: JPEG }, 201)).json();
    t.clock.offsetMs += 2 * 3_600_000;
    expect(await t.ctx.files.sweep()).toBe(1);
    const lateKey = `${(await t.ctx.apps.load(appId)).env.schemaName}/${late.id}`;
    await expect(client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: lateKey }))).rejects.toThrow();
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  });
});

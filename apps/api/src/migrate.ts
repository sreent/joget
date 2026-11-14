/**
 * Apply database migrations and seed the managed policy, then exit. Run as a Kubernetes Job (a Helm
 * pre-upgrade hook) before new API pods start, so pods never migrate concurrently with traffic.
 */
import { createDatabase, migrateDatabase, seedManagedPolicy } from '@platform/db';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const database = createDatabase(url, { applicationName: 'platform-migrate', statementTimeoutMs: 0, maxConnections: 2 });
try {
  await migrateDatabase(database.pool);
  await seedManagedPolicy(database.db);
  console.log('Database migrated and managed policy seeded');
} finally {
  await database.close();
}

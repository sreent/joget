import { type Executor, users } from '@platform/db';
import { and, eq } from 'drizzle-orm';

/*
 * The directory as processes read it (design §6.10): a person's department, their manager on the
 * reporting line, and who covers for them while they are away.
 */

/** The longest reporting line Ambit follows: a loop or a broken directory stops here. */
const MAX_LINE = 50;

/** Whether making `managerId` the manager of `userId` would close a loop in the reporting line. */
export async function closesLoop(db: Executor, userId: string, managerId: string): Promise<boolean> {
  let current: string | null = managerId;
  for (let step = 0; current && step < MAX_LINE; step++) {
    if (current === userId) return true;
    const [row] = await db.select({ managerId: users.managerId }).from(users).where(eq(users.id, current));
    current = row?.managerId ?? null;
  }
  return false;
}

/** The manager `levels` up the reporting line from a person, or null where the line ends or someone on it has left. */
export async function managerUp(db: Executor, userId: string, levels: number): Promise<string | null> {
  let current = userId;
  for (let step = 0; step < levels; step++) {
    const [row] = await db.select({ managerId: users.managerId }).from(users).where(eq(users.id, current));
    if (!row?.managerId) return null;
    current = row.managerId;
  }
  const [manager] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, current), eq(users.status, 'active')));
  return manager?.id ?? null;
}

/** Who takes a task meant for a person: the person, or whoever covers for them now, if that one is active. */
export async function coverFor(db: Executor, userId: string, now: Date): Promise<string> {
  const [row] = await db.select({ coverId: users.coverId, coverUntil: users.coverUntil }).from(users).where(eq(users.id, userId));
  if (!row?.coverId || (row.coverUntil && row.coverUntil.getTime() <= now.getTime())) return userId;
  const [cover] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, row.coverId), eq(users.status, 'active')));
  return cover?.id ?? userId;
}

/** A person's department, or null. */
export async function departmentOf(db: Executor, userId: string): Promise<string | null> {
  const [row] = await db.select({ department: users.department }).from(users).where(eq(users.id, userId));
  return row?.department ?? null;
}

/** The active person with an email in the org, for a manager the IdP names by email. */
export async function personByEmail(db: Executor, orgId: string, email: string): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.email, email), eq(users.status, 'active')));
  return row?.id ?? null;
}

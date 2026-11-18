import { uuidv7 } from '@platform/audit';
import { apps, noticeEmails, notices, processTasks, users, type Database } from '@platform/db';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { inAudience, roleHolders } from '../access/holders.js';
import type { AppContext } from '../context.js';
import type { Mailer } from './mail.js';

/*
 * Notices (design §6.12): what reaches a person in the app, and by email when they take it. A flow
 * tells people, and a task tells whom it waits for as it opens, when it is due soon and when it is
 * overdue. A notice goes only to people the app is shared with: its owner, and whoever holds one of
 * its roles in the environment. It is written in the transaction of what tells, so a flow that
 * fails tells nobody; a worker sends the emails after.
 */

export type NoticeKind = 'inform' | 'task_assigned' | 'task_due_soon' | 'task_overdue';

export interface NoticeInput {
  readonly appId: string;
  readonly environmentId: string;
  readonly kind: NoticeKind;
  readonly title: string;
  readonly message?: string | null | undefined;
  /** The record it is about, which it links to, and what it is called now. */
  readonly about?: { readonly entity: string; readonly recordId: string; readonly label: string } | null | undefined;
  readonly taskId?: string | null | undefined;
  /** Whom to tell. Those the app isn't shared with hear nothing. */
  readonly to: readonly string[];
  /** By email too, to each who takes email. */
  readonly email: boolean;
}

export interface NoticeOut {
  readonly id: string;
  readonly kind: NoticeKind;
  readonly title: string;
  readonly message: string | null;
  readonly app: { readonly id: string; readonly name: string };
  readonly about: { readonly entity: string; readonly recordId: string; readonly label: string | null } | null;
  readonly taskId: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
}

/** How many tries an email gets before it fails for good. */
const MAX_ATTEMPTS = 5;
/** The most people one task tells, when it waits for anyone with its role. */
const MAX_ROLE_NOTICES = 50;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
/** A time as people read it in an email, in UTC: "20 Nov 2026, 09:00 UTC". */
const when = (at: Date) =>
  `${at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}, ${at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;

export class Notices {
  readonly #ctx: AppContext;
  readonly #mailer: Mailer | null;
  /** When this process last removed old notices: an hour between sweeps is soon enough. */
  #swept = 0;

  constructor(ctx: AppContext, mailer: Mailer | null) {
    this.#ctx = ctx;
    this.#mailer = mailer;
  }

  /** Whether email goes out at all: the installation has a mail server. */
  get emails(): boolean {
    return this.#mailer !== null;
  }

  /** Tell people, in the transaction of what tells them. Returns whom it told, and whom it left out because the app isn't shared with them. */
  async send(db: Database, input: NoticeInput, now: Date): Promise<{ readonly told: string[]; readonly left: string[] }> {
    const told = await inAudience(db, input.appId, input.environmentId, input.to, now);
    const left = [...new Set(input.to)].filter((person) => !told.includes(person));
    if (!told.length) return { told, left };
    const people = await db.select({ id: users.id, email: users.email, emailNotices: users.emailNotices }).from(users).where(inArray(users.id, told));
    const rows = told.map((userId) => ({
      id: uuidv7(now.getTime()),
      orgId: this.#ctx.org.id,
      userId,
      appId: input.appId,
      environmentId: input.environmentId,
      kind: input.kind,
      title: clip(input.title.trim() || 'A notice', 300),
      message: input.message?.trim() ? clip(input.message.trim(), 2000) : null,
      entity: input.about?.entity ?? null,
      recordId: input.about?.recordId ?? null,
      label: input.about ? clip(input.about.label, 200) : null,
      taskId: input.taskId ?? null,
      createdAt: now,
    }));
    await db.insert(notices).values(rows);
    if (input.email && this.#mailer) {
      const emails = rows.flatMap((row) => {
        const person = people.find((each) => each.id === row.userId);
        return person?.email && person.emailNotices ? [{ id: uuidv7(now.getTime()), orgId: this.#ctx.org.id, noticeId: row.id, address: person.email, nextAttemptAt: now, createdAt: now }] : [];
      });
      if (emails.length) await db.insert(noticeEmails).values(emails);
    }
    return { told, left };
  }

  /** Tell whom a task waits for that it has come to them: the person it goes to, or those with its role. */
  async taskOpened(
    db: Database,
    task: {
      readonly id: string;
      readonly appId: string;
      readonly environmentId: string;
      readonly name: string;
      readonly role: string;
      readonly assignee: string | null;
      readonly about: { readonly entity: string; readonly recordId: string; readonly label: string };
      readonly dueAt: Date | null;
    },
    now: Date,
  ): Promise<void> {
    const to = task.assignee ? [task.assignee] : (await roleHolders(db, task.appId, task.environmentId, task.role, now)).slice(0, MAX_ROLE_NOTICES);
    await this.send(
      db,
      {
        appId: task.appId,
        environmentId: task.environmentId,
        kind: 'task_assigned',
        title: task.name,
        message: task.assignee ? `It waits for you${task.dueAt ? `, by ${when(task.dueAt)}` : ''}.` : `It waits for someone with your role${task.dueAt ? `, by ${when(task.dueAt)}` : ''}.`,
        about: task.about,
        taskId: task.id,
        to,
        email: true,
      },
      now,
    );
  }

  /** Tell whom open tasks wait for that they are due soon, or overdue: once each. Pods share the work through SKIP LOCKED. */
  async taskDeadlines(batch = 50): Promise<number> {
    const now = this.#ctx.now();
    const soon = new Date(now.getTime() + this.#ctx.config.TASK_DUE_SOON_HOURS * 3_600_000);
    return this.#ctx.db.transaction(async (tx) => {
      const due = await tx
        .select()
        .from(processTasks)
        .where(
          and(
            eq(processTasks.status, 'open'),
            isNotNull(processTasks.dueAt),
            or(and(isNull(processTasks.overdueNoticeAt), lte(processTasks.dueAt, now)), and(isNull(processTasks.dueSoonNoticeAt), lte(processTasks.dueAt, soon), gt(processTasks.dueAt, now))),
          ),
        )
        .orderBy(asc(processTasks.dueAt))
        .limit(batch)
        .for('update', { skipLocked: true });
      for (const task of due) {
        const overdue = task.dueAt!.getTime() <= now.getTime();
        let to = task.assignee ? [task.assignee] : (await roleHolders(tx, task.appId, task.environmentId, task.role, now)).slice(0, MAX_ROLE_NOTICES);
        // What the task's record was called when the task told its people of it.
        const [earlier] = await tx.select({ label: notices.label }).from(notices).where(eq(notices.taskId, task.id)).limit(1);
        if (!task.assignee && task.department && to.length) {
          const kept = await tx.select({ id: users.id }).from(users).where(and(inArray(users.id, to), eq(users.department, task.department)));
          to = kept.map((row) => row.id);
        }
        await this.send(
          tx,
          {
            appId: task.appId,
            environmentId: task.environmentId,
            kind: overdue ? 'task_overdue' : 'task_due_soon',
            title: overdue ? `Overdue: ${task.name}` : `Due soon: ${task.name}`,
            message: overdue ? `It was due ${when(task.dueAt!)}.` : `It is due ${when(task.dueAt!)}.`,
            about: { entity: task.entity, recordId: task.recordId, label: earlier?.label ?? task.entity },
            taskId: task.id,
            to,
            email: true,
          },
          now,
        );
        await tx
          .update(processTasks)
          .set(overdue ? { overdueNoticeAt: now, dueSoonNoticeAt: task.dueSoonNoticeAt ?? now } : { dueSoonNoticeAt: now })
          .where(eq(processTasks.id, task.id));
      }
      return due.length;
    });
  }

  /** Send the emails that wait, a batch at a time. Pods share the work through SKIP LOCKED. Returns how many it tried. */
  async deliverDue(batch = 20): Promise<number> {
    const mailer = this.#mailer;
    if (!mailer) return 0;
    const now = this.#ctx.now();
    const claimed = await this.#ctx.db.transaction(async (tx) => {
      const due = await tx
        .select({ email: noticeEmails, notice: notices, appName: apps.name })
        .from(noticeEmails)
        .innerJoin(notices, eq(notices.id, noticeEmails.noticeId))
        .innerJoin(apps, eq(apps.id, notices.appId))
        .where(and(eq(noticeEmails.status, 'waiting'), lte(noticeEmails.nextAttemptAt, now)))
        .orderBy(asc(noticeEmails.nextAttemptAt))
        .limit(batch)
        .for('update', { of: noticeEmails, skipLocked: true });
      if (!due.length) return [];
      // A try holds the email for a minute, so a crash only delays it.
      await tx
        .update(noticeEmails)
        .set({ attempts: sql`${noticeEmails.attempts} + 1`, nextAttemptAt: new Date(now.getTime() + 60_000) })
        .where(inArray(noticeEmails.id, due.map((row) => row.email.id)));
      return due.map((row) => ({ ...row, email: { ...row.email, attempts: row.email.attempts + 1 } }));
    });
    const base = this.#ctx.config.PUBLIC_BASE_URL.replace(/\/$/, '');
    for (const { email, notice, appName } of claimed) {
      const link = notice.taskId ? `${base}/studio/tasks` : notice.entity && notice.recordId ? `${base}/studio/apps/${notice.appId}/${notice.entity}/${notice.recordId}` : `${base}/studio/notices`;
      const text = [notice.message ?? '', `Open it: ${link}`, `${appName} sent you this notice. You can stop notices by email in a3t: ${base}/studio/notices`].filter(Boolean).join('\n\n');
      try {
        await mailer.send({ to: email.address, subject: clip(`${appName}: ${notice.title}`, 200), text });
        await this.#ctx.db.update(noticeEmails).set({ status: 'sent', sentAt: this.#ctx.now(), lastError: null }).where(eq(noticeEmails.id, email.id));
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
        const failed = email.attempts >= MAX_ATTEMPTS;
        await this.#ctx.db
          .update(noticeEmails)
          .set({ lastError: message, ...(failed ? { status: 'failed' as const } : { nextAttemptAt: new Date(this.#ctx.now().getTime() + 30_000 * 2 ** email.attempts) }) })
          .where(eq(noticeEmails.id, email.id));
      }
    }
    return claimed.length;
  }

  /** Remove the notices older than the installation keeps them, read or not, with their emails. */
  async sweep(): Promise<number> {
    const now = this.#ctx.now().getTime();
    if (now - this.#swept < 3_600_000) return 0;
    this.#swept = now;
    const before = new Date(now - this.#ctx.config.NOTICE_RETENTION_DAYS * 86_400_000);
    const gone = await this.#ctx.db.delete(notices).where(lte(notices.createdAt, before)).returning({ id: notices.id });
    return gone.length;
  }

  /** A person's notices, the newest first, and how many are unread. */
  async list(userId: string, options: { readonly unread: boolean; readonly limit: number }): Promise<{ readonly notices: NoticeOut[]; readonly unread: number }> {
    const rows = await this.#ctx.db
      .select({ notice: notices, appName: apps.name })
      .from(notices)
      .innerJoin(apps, eq(apps.id, notices.appId))
      .where(and(eq(notices.userId, userId), options.unread ? isNull(notices.readAt) : undefined))
      .orderBy(desc(notices.createdAt), desc(notices.id))
      .limit(options.limit);
    return {
      notices: rows.map(({ notice, appName }) => ({
        id: notice.id,
        kind: notice.kind,
        title: notice.title,
        message: notice.message,
        app: { id: notice.appId, name: appName },
        about: notice.entity && notice.recordId ? { entity: notice.entity, recordId: notice.recordId, label: notice.label } : null,
        taskId: notice.taskId,
        createdAt: notice.createdAt.toISOString(),
        readAt: notice.readAt?.toISOString() ?? null,
      })),
      unread: await this.unread(userId),
    };
  }

  async unread(userId: string): Promise<number> {
    const [row] = await this.#ctx.db.select({ n: count() }).from(notices).where(and(eq(notices.userId, userId), isNull(notices.readAt)));
    return row?.n ?? 0;
  }

  /** Mark some of a person's notices read, or all that came up to a time: what came after stays unread. */
  async read(userId: string, which: { readonly ids: readonly string[] } | { readonly upTo: Date }): Promise<number> {
    const now = this.#ctx.now();
    const of = 'ids' in which ? (which.ids.length ? inArray(notices.id, [...which.ids]) : sql`false`) : lte(notices.createdAt, which.upTo);
    await this.#ctx.db.update(notices).set({ readAt: now }).where(and(eq(notices.userId, userId), isNull(notices.readAt), of));
    return this.unread(userId);
  }

  async settings(userId: string): Promise<{ readonly email: boolean; readonly emailAvailable: boolean }> {
    const [row] = await this.#ctx.db.select({ email: users.emailNotices }).from(users).where(eq(users.id, userId));
    return { email: row?.email ?? true, emailAvailable: this.emails };
  }

  async setEmail(userId: string, email: boolean): Promise<{ readonly email: boolean; readonly emailAvailable: boolean }> {
    await this.#ctx.db.update(users).set({ emailNotices: email }).where(eq(users.id, userId));
    return this.settings(userId);
  }
}

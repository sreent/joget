import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.js';
import { Icon, type IconName } from '../components/icon.js';
import { Badge, Button, Card, Checkbox, EmptyState } from '../components/ui.js';
import { href, Link } from '../router.js';
import type { Notice } from '../types.js';

/*
 * The person's notices (design §6.12), as Ocean's Inbox draws an inbox: by record, the newest news
 * first, each record a framed group with its own Mark read, and what reached the person under it in
 * the history's grammar. Unread has a dot and heavier words. Marking read marks what was shown, and
 * no more: a notice that arrives after the page was drawn stays unread.
 */

const KIND_ICONS: Readonly<Record<Notice['kind'], IconName>> = { inform: 'bell', task_assigned: 'tasks', task_due_soon: 'clock', task_overdue: 'clock' };

/** Notices by what they are about: a record of an app, or the app itself. The newest group first. */
function groupsOf(notices: readonly Notice[]): Array<{ key: string; notices: Notice[] }> {
  const groups = new Map<string, Notice[]>();
  for (const notice of notices) {
    const key = notice.about ? `${notice.app.id}/${notice.about.entity}/${notice.about.recordId}` : `${notice.app.id}/${notice.id}`;
    groups.set(key, [...(groups.get(key) ?? []), notice]);
  }
  return [...groups].map(([key, list]) => ({ key, notices: list }));
}

const time = (at: string) => new Date(at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Notices() {
  const client = useQueryClient();
  const [unreadOnly, setUnreadOnly] = useState(true);
  const notices = useQuery({ queryKey: ['notices', unreadOnly], queryFn: () => api.notices(unreadOnly), refetchInterval: 60_000 });
  const settings = useQuery({ queryKey: ['notices', 'settings'], queryFn: api.noticeSettings });
  const refresh = () => void client.invalidateQueries({ queryKey: ['notices'] });
  const read = useMutation({ mutationFn: api.readNotices, onSuccess: refresh });
  const email = useMutation({ mutationFn: api.setNoticeEmail, onSuccess: refresh });
  const list = notices.data?.notices ?? [];
  // What was shown when the page was drawn: marking all read leaves what came after unread.
  const shownUpTo = list[0]?.createdAt;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 text-2xl font-semibold">Notices</h1>
          <p className="m-0 text-sm text-muted">What flows told you, and the tasks that came to you, are due soon or are overdue.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="modes" role="group" aria-label="Which notices">
            <button type="button" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>
              Unread
            </button>
            <button type="button" aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>
              All
            </button>
          </div>
          <Button size="sm" disabled={!notices.data?.unread || !shownUpTo || read.isPending} onClick={() => shownUpTo && read.mutate({ upTo: shownUpTo })}>
            Mark all read
          </Button>
        </div>
      </div>
      {settings.data?.emailAvailable ? (
        <Card className="p-3">
          <Checkbox label="Send my notices by email too" checked={settings.data.email} onChange={(on) => email.mutate(on)} />
        </Card>
      ) : null}
      {!notices.data ? null : list.length ? (
        <ol className="inbox" aria-label={unreadOnly ? 'Unread, by record' : 'All, by record'}>
          {groupsOf(list).map(({ key, notices: group }) => {
            const first = group[0]!;
            const unread = group.filter((notice) => !notice.readAt);
            const summary = first.about?.label ?? first.title;
            return (
              <li key={key} className="inbox-group" data-testid="notice-group">
                <div className="inbox-issue">
                  {first.about ? (
                    <Link className="inbox-summary" to={{ name: 'use', appId: first.app.id, page: first.about.entity, recordId: first.about.recordId }}>
                      {summary}
                    </Link>
                  ) : (
                    <span className="inbox-summary">{summary}</span>
                  )}
                  <Badge tone="idle">{first.app.name}</Badge>
                  {unread.length ? (
                    <Button size="sm" disabled={read.isPending} onClick={() => read.mutate({ ids: unread.map((notice) => notice.id) })}>
                      Mark read<span className="sr-only"> {summary}</span>
                    </Button>
                  ) : null}
                </div>
                <ol className="history">
                  {group.map((notice) => (
                    <li key={notice.id} className={notice.readAt ? 'read' : 'unread'}>
                      <span className="avatar small" aria-hidden>
                        <Icon name={KIND_ICONS[notice.kind]} />
                      </span>
                      <div className="history-body">
                        <p className="history-head">
                          {notice.readAt ? null : <span className="sr-only">Unread: </span>}
                          <strong className="inbox-what">{notice.title}</strong> · <time dateTime={notice.createdAt}>{time(notice.createdAt)}</time>
                          {notice.taskId ? (
                            <>
                              {' · '}
                              <a href={href({ name: 'tasks' })}>Your tasks</a>
                            </>
                          ) : null}
                        </p>
                        {notice.message ? (
                          <div className="history-comment">
                            <p>{notice.message}</p>
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
              </li>
            );
          })}
        </ol>
      ) : (
        <EmptyState title={unreadOnly ? 'Nothing unread' : 'No notices yet'}>{unreadOnly ? 'What reaches you shows here, by record.' : 'When a flow tells you something, or a task comes to you, it shows here.'}</EmptyState>
      )}
    </div>
  );
}

/** How many notices are unread: the count beside Notices in the header. */
export function NoticeCount() {
  const unread = useQuery({ queryKey: ['notices', 'unread'], queryFn: api.unreadNotices, refetchInterval: 60_000 });
  const count = unread.data?.unread ?? 0;
  return (
    <Link to={{ name: 'notices' }} className="flex items-center gap-1.5 text-sm no-underline" aria-label={count ? `Notices, ${count} unread` : 'Notices'}>
      <Icon name="bell" />
      Notices
      {count ? <Badge tone="accent">{count > 99 ? '99+' : count}</Badge> : null}
    </Link>
  );
}

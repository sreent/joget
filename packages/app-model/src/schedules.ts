import { WEEKDAYS, type Schedule } from './schema.js';

/*
 * Schedules (design §6.11): a flow that needs no input runs by itself every hour, day, weekday,
 * week or month, at a time of day in a time zone. The time of day is the zone's wall clock, so a
 * flow at 07:30 in Europe/London runs at 07:30 there in summer and in winter.
 */

interface Issue {
  /** Where in the schedule: "" for the schedule itself, or ".on", ".day", ".at" or ".zone". */
  readonly path: string;
  readonly message: string;
}

/** Whether the runtime knows a time zone by this name. */
export function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** What is wrong with a schedule, part by part. */
export function scheduleIssues(schedule: Schedule): Issue[] {
  const issues: Issue[] = [];
  if (schedule.every === 'week' && !schedule.on) issues.push({ path: '.on', message: 'Say on which day of the week it runs' });
  if (schedule.every !== 'week' && schedule.on) issues.push({ path: '.on', message: 'A day of the week is for a flow that runs every week' });
  if (schedule.every === 'month' && schedule.day === undefined) issues.push({ path: '.day', message: 'Say on which day of the month it runs' });
  if (schedule.every !== 'month' && schedule.day !== undefined) issues.push({ path: '.day', message: 'A day of the month is for a flow that runs every month' });
  if (schedule.every === 'hour' && !schedule.at.startsWith('00:')) issues.push({ path: '.at', message: 'Every hour, a flow runs at minutes past the hour: give them as 00:MM, for example 00:15' });
  if (schedule.zone !== undefined && !knownZone(schedule.zone)) issues.push({ path: '.zone', message: `No time zone named ${schedule.zone}: give one such as Europe/London` });
  return issues;
}

/** The wall clock of a zone at a moment: its date, its time and its day of the week, Monday 0. */
interface Wall {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly weekday: number;
}

const FORMATS = new Map<string, Intl.DateTimeFormat>();

function wallAt(moment: number, zone: string): Wall {
  let format = FORMATS.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    FORMATS.set(zone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(new Date(moment)).map((part) => [part.type, part.value]));
  const number = (type: string) => Number(parts[type]);
  return {
    year: number('year'),
    month: number('month'),
    day: number('day'),
    hour: number('hour'),
    minute: number('minute'),
    weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts['weekday'] ?? ''),
  };
}

/**
 * The moment a zone's wall clock shows a date and a time. In the hour that a change to summer time
 * leaves out, the moment an hour later.
 */
function momentOf(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const offset = (moment: number) => {
    const wall = wallAt(moment, zone);
    return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - Math.floor(moment / 60_000) * 60_000;
  };
  const first = asUtc - offset(asUtc);
  const second = asUtc - offset(first);
  const shows = (moment: number) => {
    const wall = wallAt(moment, zone);
    return wall.day === day && wall.hour === hour && wall.minute === minute;
  };
  return [first, second].find(shows) ?? Math.max(first, second);
}

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** The next time a schedule runs, after a moment. */
export function nextRun(schedule: Schedule, after: Date): Date {
  const zone = schedule.zone ?? 'UTC';
  const [hour, minute] = schedule.at.split(':').map(Number) as [number, number];
  const now = after.getTime();
  const wall = wallAt(now, zone);
  if (schedule.every === 'hour') {
    // This hour at its minutes, or the next hour's.
    for (let ahead = 0; ahead < 3; ahead++) {
      const at = momentOf(wall.year, wall.month, wall.day, wall.hour, minute, zone) + ahead * 3_600_000;
      if (at > now) return new Date(at);
    }
  }
  // Day by day from today, by the zone's calendar, to the first day it runs whose time is still to come.
  for (let ahead = 0; ahead < 800; ahead++) {
    const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + ahead));
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    const weekday = (date.getUTCDay() + 6) % 7;
    const runs =
      schedule.every === 'day' ||
      (schedule.every === 'weekday' && weekday < 5) ||
      (schedule.every === 'week' && weekday === WEEKDAYS.indexOf(schedule.on ?? 'monday')) ||
      (schedule.every === 'month' && d === (schedule.day === 'last' || schedule.day === undefined ? daysIn(y, m) : schedule.day));
    if (!runs) continue;
    const at = momentOf(y, m, d, hour, minute, zone);
    if (at > now) return new Date(at);
  }
  throw new Error('A schedule that never runs');
}

const DAY_WORDS: Readonly<Record<(typeof WEEKDAYS)[number], string>> = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
};

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

/** A schedule in words: "Every weekday at 07:30, Europe/London time". */
export function scheduleWords(schedule: Schedule): string {
  const zone = schedule.zone && schedule.zone !== 'UTC' ? `, ${schedule.zone} time` : ' UTC';
  switch (schedule.every) {
    case 'hour':
      return `Every hour at ${Number(schedule.at.slice(3))} minutes past`;
    case 'day':
      return `Every day at ${schedule.at}${zone}`;
    case 'weekday':
      return `Every weekday at ${schedule.at}${zone}`;
    case 'week':
      return `Every ${DAY_WORDS[schedule.on ?? 'monday']} at ${schedule.at}${zone}`;
    case 'month':
      return `On the ${schedule.day === 'last' || schedule.day === undefined ? 'last day' : ordinal(schedule.day)} of each month at ${schedule.at}${zone}`;
  }
}

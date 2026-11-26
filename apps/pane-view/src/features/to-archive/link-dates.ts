/** How To archive writes dates: by day, in the viewer's locale and time zone. */

const DAY_MS = 86_400_000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole calendar days from `date` to `now`; 0 is today. */
function daysAgo(date: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
}

const shortDate = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

const shortDateWithYear = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const weekdayDate = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  weekday: "short",
});

const timeOfDay = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/** "3 Oct", with the year once it isn't this year's. */
export function formatShortDate(date: Date, now = new Date()): string {
  return date.getFullYear() === now.getFullYear()
    ? shortDate.format(date)
    : shortDateWithYear.format(date);
}

/** A day heading in Archived: "Today", "Yesterday", then "Mon, 18 Nov". */
export function formatDayHeading(date: Date, now = new Date()): string {
  const days = daysAgo(date, now);

  if (days === 0) return "Today";

  if (days === 1) return "Yesterday";

  return date.getFullYear() === now.getFullYear()
    ? weekdayDate.format(date)
    : shortDateWithYear.format(date);
}

/** The key that groups Archived rows by day. */
export function dayKey(date: Date): number {
  return startOfDay(date);
}

export function formatTimeOfDay(date: Date): string {
  return timeOfDay.format(date);
}

/** "today", "yesterday", "4 days ago", then a date. */
export function formatDaysAgo(date: Date, now = new Date()): string {
  const days = daysAgo(date, now);

  if (days <= 0) return "today";

  if (days === 1) return "yesterday";

  if (days < 7) return `${days} days ago`;

  return formatShortDate(date, now);
}

/** "just now", "1 minute ago", "12 minutes ago", then hours. */
export function formatMinutesAgo(date: Date, now = new Date()): string {
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);

  if (minutes < 1) return "just now";

  if (minutes === 1) return "1 minute ago";

  if (minutes < 60) return `${minutes} minutes ago`;

  const hours = Math.floor(minutes / 60);

  return hours === 1 ? "an hour ago" : `${hours} hours ago`;
}

/** When a recheck comes due. */
export function recheckDueDate(archivedAt: Date, recheckDays: number): Date {
  return new Date(archivedAt.getTime() + recheckDays * DAY_MS);
}

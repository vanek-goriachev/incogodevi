/**
 * Tiny relative-time formatter.
 *
 * We intentionally avoid `dayjs` / `moment` to keep the bundle small (T17 AC
 * limits gzip shell to 200 KB). Output is fixed English: "just now", "5 m
 * ago", "2 h ago", "yesterday", "3 d ago", or an ISO date for older values.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return iso;
  }
  const delta = now.getTime() - then;
  if (delta < 0) {
    // Future timestamps shouldn't happen for "uploaded_at"; show absolute date
    // rather than a confusing negative duration.
    return new Date(then).toISOString().slice(0, 10);
  }
  if (delta < MINUTE) {
    return 'just now';
  }
  if (delta < HOUR) {
    return `${String(Math.floor(delta / MINUTE))} m ago`;
  }
  if (delta < DAY) {
    return `${String(Math.floor(delta / HOUR))} h ago`;
  }
  if (delta < 2 * DAY) {
    return 'yesterday';
  }
  if (delta < 30 * DAY) {
    return `${String(Math.floor(delta / DAY))} d ago`;
  }
  return new Date(then).toISOString().slice(0, 10);
}

/**
 * Business-day boundaries in Nigerian time, computed from UTC.
 *
 * Timestamps everywhere are stored in UTC (MongoDB Dates always are) and set
 * by the server, never taken from the browser. But "today", "this month" and
 * "this year" are LOCAL ideas: an order at 00:30 in Lagos is 23:30 UTC the
 * day before. The old helpers used the server's own clock zone — UTC inside
 * Docker — so "today's earnings" ran from 1am to 1am Nigerian time.
 *
 * Nigeria (WAT) is UTC+1 all year, no daylight saving. APP_UTC_OFFSET_MINUTES
 * can change it if you ever operate elsewhere.
 */
const offsetMs = () => (Number(process.env.APP_UTC_OFFSET_MINUTES) || 60) * 60 * 1000;

/** The same instant, shifted so its UTC fields read as local wall-clock time. */
const toLocalClock = (date) => new Date(date.getTime() + offsetMs());
/** Back from local wall-clock fields to the real UTC instant. */
const fromLocalClock = (date) => new Date(date.getTime() - offsetMs());

const startOfToday = (now = new Date()) => {
  const l = toLocalClock(now);
  return fromLocalClock(new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate())));
};

const startOfMonth = (now = new Date()) => {
  const l = toLocalClock(now);
  return fromLocalClock(new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), 1)));
};

const startOfYear = (now = new Date()) => {
  const l = toLocalClock(now);
  return fromLocalClock(new Date(Date.UTC(l.getUTCFullYear(), 0, 1)));
};

module.exports = { startOfToday, startOfMonth, startOfYear };

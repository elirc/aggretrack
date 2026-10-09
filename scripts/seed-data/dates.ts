/**
 * Date helpers for the seed's 90-day window. Africa/Lagos is UTC+1 with no
 * DST, so a Lagos wall-clock time is `${date}T${hh}:${mm}:00+01:00`.
 */

export const WINDOW_DAYS = 90;

export function lagosToday(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  return Math.round(
    (new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

export class Calendar {
  readonly today: string;
  readonly start: string;
  private readonly startedAt: Date;

  constructor(now: Date = new Date()) {
    this.startedAt = now;
    this.today = lagosToday(now);
    this.start = addDays(this.today, -WINDOW_DAYS);
  }

  /** Lagos calendar date of window day d (0 = 90 days ago, 90 = today). */
  date(d: number): string {
    return addDays(this.start, d);
  }

  /** Day index of a Lagos date. */
  dayOf(isoDate: string): number {
    return diffDays(isoDate, this.start);
  }

  /**
   * A timestamp on window day d at Lagos hh:mm (+ extra minutes), never in
   * the future relative to when the seed started (clamped to start - 1 min).
   */
  at(d: number, hh: number, mm = 0, extraMinutes = 0): Date {
    const date = this.date(d);
    const base = new Date(
      `${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+01:00`,
    );
    const t = new Date(base.getTime() + extraMinutes * 60_000);
    const ceiling = new Date(this.startedAt.getTime() - 60_000);
    if (t <= ceiling) return t;
    // Later than "now": squeeze into the 24 minutes before the ceiling, keeping
    // order and uniqueness (one second per wall-clock minute).
    const minuteOfDay = hh * 60 + mm + extraMinutes;
    return new Date(ceiling.getTime() - Math.max(1, 1440 - minuteOfDay) * 1000);
  }

  /** First calendar day (yyyy-mm-01) of every month touching the window. */
  monthStarts(): string[] {
    const out: string[] = [];
    let cur = `${this.start.slice(0, 7)}-01`;
    while (cur <= this.today) {
      out.push(cur);
      const d = new Date(`${cur}T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + 1);
      cur = d.toISOString().slice(0, 10);
    }
    return out;
  }
}

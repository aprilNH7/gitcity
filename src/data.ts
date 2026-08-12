export interface Day {
  date: string;
  count: number;
  level: number;
}

export interface Contributions {
  user: string;
  /** Either a four digit year or 'last' for a rolling twelve months. */
  range: string;
  total: number;
  days: Day[];
}

export interface Stats {
  total: number;
  best: Day | null;
  activeDays: number;
  longestStreak: number;
  currentStreak: number;
}

const API = 'https://github-contributions-api.jogruber.de/v4';

export class ContributionError extends Error {
  constructor(message: string, readonly kind: 'notfound' | 'network' | 'empty') {
    super(message);
    this.name = 'ContributionError';
  }
}

/**
 * The upstream API returns every day of the requested range, already bucketed
 * into GitHub's 0-4 intensity levels. We normalise it and nothing else, so a
 * city always maps 1:1 to what the profile graph shows.
 */
export async function fetchContributions(user: string, range: string): Promise<Contributions> {
  const clean = user.trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(clean)) {
    throw new ContributionError(`"${user}" is not a valid GitHub username.`, 'notfound');
  }

  let res: Response;
  try {
    res = await fetch(`${API}/${encodeURIComponent(clean)}?y=${encodeURIComponent(range)}`);
  } catch {
    throw new ContributionError('Could not reach the contributions API. Check your connection.', 'network');
  }

  if (res.status === 404) {
    throw new ContributionError(`GitHub user "${clean}" not found.`, 'notfound');
  }
  if (!res.ok) {
    throw new ContributionError(`Contributions API returned ${res.status}.`, 'network');
  }

  const json = (await res.json()) as {
    total?: Record<string, number>;
    contributions?: Day[];
  };

  const days = json.contributions ?? [];
  if (!days.length) {
    throw new ContributionError(`No contribution data for ${clean} in ${range}.`, 'empty');
  }

  const totals = json.total ?? {};
  const total = totals[range] ?? Object.values(totals)[0] ?? days.reduce((a, d) => a + d.count, 0);

  return { user: clean, range, total, days };
}

export function computeStats(days: Day[]): Stats {
  let best: Day | null = null;
  let activeDays = 0;
  let longest = 0;
  let running = 0;
  let total = 0;

  for (const day of days) {
    total += day.count;
    if (day.count > 0) {
      activeDays++;
      running++;
      if (running > longest) longest = running;
      if (!best || day.count > best.count) best = day;
    } else {
      running = 0;
    }
  }

  // A streak that is still alive should not be broken by today having no
  // commits yet, so we start counting from the last day that has any.
  let current = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i];
    if (day.count > 0) {
      current++;
    } else if (!(day.date === today && current === 0)) {
      break;
    }
  }

  return { total, best, activeDays, longestStreak: longest, currentStreak: current };
}

/** A hand made graph so the scene is never empty, even offline. */
export function demoContributions(): Contributions {
  const days: Day[] = [];
  const start = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  for (let i = 0; i < 365; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const week = Math.floor(i / 7);
    // Two gentle swells across the year plus a weekday bias, so the demo
    // skyline reads like a real habit rather than noise.
    const season = Math.sin((week / 52) * Math.PI * 2) * 0.5 + 0.5;
    const weekday = d.getUTCDay() === 0 || d.getUTCDay() === 6 ? 0.35 : 1;
    const noise = Math.abs(Math.sin(i * 12.9898) * 43758.5453 % 1);
    const raw = season * weekday * noise * 14;
    const count = raw < 1.4 ? 0 : Math.round(raw);
    days.push({
      date: d.toISOString().slice(0, 10),
      count,
      level: count === 0 ? 0 : count < 3 ? 1 : count < 6 ? 2 : count < 10 ? 3 : 4,
    });
  }
  return {
    user: 'demo',
    range: String(new Date().getUTCFullYear()),
    total: days.reduce((a, d) => a + d.count, 0),
    days,
  };
}

import {
  fetchAllTime,
  totalForPeriod,
  computeStats,
  ContributionError,
  USERNAME_RE,
  type Day,
} from './data';

export interface Row {
  user: string;
  state: 'loading' | 'ready' | 'error';
  error?: string;
  totals: Record<string, number>;
  days: Day[];
}

interface Options {
  /** Fired when a row is clicked, with a period already resolved to a range. */
  onPick: (user: string, range: string) => void;
  onChange: () => void;
}

const SEED = ['torvalds', 'sindresorhus', 'gaearon', 'yyx990803'];
const STORE_KEY = 'gitcity.users';
const MAX_USERS = 12;
const CONCURRENCY = 3;
const AVATAR_SIZE = 48;
const NOTE_CLEAR_MS = 3200;

const fmt = new Intl.NumberFormat('en-US');

/**
 * Ranks a set of GitHub users by contribution volume over a chosen period.
 *
 * Each user costs exactly one request regardless of how many periods are
 * inspected, because the all-time payload carries a per-year total map. Rows
 * are re-ranked locally when the period changes, with no refetching.
 */
export class Leaderboard {
  private rows = new Map<string, Row>();
  private periodValue = 'all';
  private activeUser: string | null = null;
  private queue: string[] = [];
  private inFlight = 0;

  private el: {
    root: HTMLElement;
    period: HTMLSelectElement;
    form: HTMLFormElement;
    input: HTMLInputElement;
    list: HTMLOListElement;
    note: HTMLParagraphElement;
  };

  constructor(private root: HTMLElement, private opts: Options) {
    root.innerHTML = `
      <header class="board-head">
        <h2>Leaderboard</h2>
        <select class="board-period" aria-label="Ranking period"></select>
      </header>
      <form class="board-add">
        <input type="text" placeholder="add a username" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="Add a GitHub username" />
        <button type="submit" aria-label="Add">+</button>
      </form>
      <ol class="board-list"></ol>
      <p class="board-note"></p>
    `;

    this.el = {
      root,
      period: root.querySelector('.board-period') as HTMLSelectElement,
      form: root.querySelector('.board-add') as HTMLFormElement,
      input: root.querySelector('.board-add input') as HTMLInputElement,
      list: root.querySelector('.board-list') as HTMLOListElement,
      note: root.querySelector('.board-note') as HTMLParagraphElement,
    };

    this.el.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = this.el.input.value.trim().replace(/^@/, '');
      if (!v) return;
      if (!USERNAME_RE.test(v)) {
        this.note(`"${v}" is not a valid username.`);
        return;
      }
      this.el.input.value = '';
      this.add(v);
    });

    this.el.period.addEventListener('change', () => {
      this.periodValue = this.el.period.value;
      this.render();
      this.opts.onChange();
    });

    this.el.list.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const li = target.closest('li[data-user]') as HTMLElement | null;
      if (!li) return;
      const user = li.dataset.user!;
      if (target.closest('.rm')) {
        this.remove(user);
        return;
      }
      const row = this.rows.get(user);
      if (row?.state === 'ready') this.opts.onPick(user, this.resolveRange(user));
    });
  }

  // ------------------------------------------------------------------ state

  get period() {
    return this.periodValue;
  }

  get users() {
    return [...this.rows.keys()];
  }

  setPeriod(p: string) {
    this.periodValue = p;
    this.render();
  }

  setActive(user: string | null) {
    this.activeUser = user ? user.toLowerCase() : null;
    this.render();
  }

  /**
   * Turns the ranking period into a range the city renderer understands.
   * 'all' has no single city to show, so we fall back to the user's strongest
   * year rather than rendering fifteen years as one unreadable ribbon.
   */
  resolveRange(user: string): string {
    if (this.periodValue !== 'all') return this.periodValue;
    const row = this.rows.get(user);
    if (!row) return 'last';
    let best = 'last';
    let bestVal = -1;
    for (const [year, val] of Object.entries(row.totals)) {
      if (val > bestVal) {
        bestVal = val;
        best = year;
      }
    }
    return best;
  }

  load(users: string[]) {
    for (const u of users.slice(0, MAX_USERS)) this.add(u, false);
    this.render();
  }

  add(user: string, render = true) {
    const key = user.toLowerCase();
    if (this.rows.has(key)) {
      this.note(`${user} is already on the board.`);
      return;
    }
    if (this.rows.size >= MAX_USERS) {
      this.note(`The board holds ${MAX_USERS} people. Remove one first.`);
      return;
    }
    this.rows.set(key, { user, state: 'loading', totals: {}, days: [] });
    this.queue.push(key);
    this.pump();
    if (render) this.render();
  }

  remove(user: string) {
    this.rows.delete(user.toLowerCase());
    this.render();
    this.opts.onChange();
  }

  private pump() {
    while (this.inFlight < CONCURRENCY && this.queue.length) {
      const key = this.queue.shift()!;
      const row = this.rows.get(key);
      if (!row) continue;
      this.inFlight++;
      fetchAllTime(row.user)
        .then((res) => {
          const live = this.rows.get(key);
          if (!live) return;
          live.state = 'ready';
          live.user = res.user;
          live.totals = res.totals;
          live.days = res.days;
        })
        .catch((err) => {
          const live = this.rows.get(key);
          if (!live) return;
          live.state = 'error';
          live.error = err instanceof ContributionError ? err.message : 'Could not load.';
        })
        .finally(() => {
          this.inFlight--;
          this.render();
          this.opts.onChange();
          this.pump();
        });
    }
  }

  // ------------------------------------------------------------------ render

  private noteTimer: number | undefined;
  private note(text: string) {
    this.el.note.textContent = text;
    window.clearTimeout(this.noteTimer);
    this.noteTimer = window.setTimeout(() => {
      if (this.el.note.textContent === text) this.el.note.textContent = this.defaultNote();
    }, NOTE_CLEAR_MS);
  }

  /** Shown whenever there is no transient message to display. */
  private defaultNote() {
    return this.rows.size ? 'Click anyone to build their city.' : 'Add a username to start a board.';
  }

  private periodOptions(): Array<[string, string]> {
    const years = new Set<string>();
    for (const row of this.rows.values()) {
      for (const y of Object.keys(row.totals)) years.add(y);
    }
    // A deep-linked year has to survive until its data lands, otherwise the
    // first render would silently reset the selection to all time.
    if (/^\d{4}$/.test(this.periodValue)) years.add(this.periodValue);
    const sorted = [...years].sort((a, b) => Number(b) - Number(a));
    return [['all', 'All time'], ['last', 'Last 12 months'], ...sorted.map((y) => [y, y] as [string, string])];
  }

  private syncPeriodOptions() {
    const opts = this.periodOptions();
    const signature = opts.map(([v]) => v).join(',');
    if (this.el.period.dataset.sig === signature) return;
    this.el.period.dataset.sig = signature;
    this.el.period.innerHTML = '';
    for (const [value, label] of opts) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      this.el.period.appendChild(o);
    }
    if (!opts.some(([v]) => v === this.periodValue)) this.periodValue = 'all';
    this.el.period.value = this.periodValue;
  }

  private readonly DEFAULTS = ['', 'Add a username to start a board.', 'Click anyone to build their city.'];

  render() {
    this.syncPeriodOptions();

    const ready = [...this.rows.values()].filter((r) => r.state === 'ready');
    const ranked = ready
      .map((r) => ({ row: r, value: totalForPeriod(r, this.periodValue) }))
      .sort((a, b) => b.value - a.value || a.row.user.localeCompare(b.row.user));
    const top = ranked[0]?.value ?? 0;

    const pending = [...this.rows.values()].filter((r) => r.state !== 'ready');

    this.el.list.innerHTML = '';
    ranked.forEach(({ row, value }, i) => {
      this.el.list.appendChild(this.rowEl(row, i + 1, value, top));
    });
    for (const row of pending) {
      this.el.list.appendChild(this.pendingEl(row));
    }

    // Never clobber a transient message, but keep the standing hint accurate.
    if (this.DEFAULTS.includes(this.el.note.textContent ?? '')) {
      this.el.note.textContent = this.defaultNote();
    }
  }

  private rowEl(row: Row, rank: number, value: number, top: number) {
    const li = document.createElement('li');
    li.dataset.user = row.user.toLowerCase();
    li.className = 'brow' + (row.user.toLowerCase() === this.activeUser ? ' active' : '');
    li.tabIndex = 0;

    const stats = computeStats(row.days);
    const pct = top > 0 ? Math.max(2, (value / top) * 100) : 0;

    li.innerHTML = `
      <span class="bar" style="width:${pct.toFixed(1)}%"></span>
      <span class="rank">${rank}</span>
      <img class="avatar" src="https://github.com/${encodeURIComponent(row.user)}.png?size=${AVATAR_SIZE}" alt="" loading="lazy" />
      <span class="who">
        <span class="name">${row.user}</span>
        <span class="sub">${fmt.format(stats.longestStreak)}d streak · ${fmt.format(stats.best?.count ?? 0)} best day</span>
      </span>
      <span class="value">${fmt.format(value)}</span>
      <button class="rm" type="button" aria-label="Remove ${row.user}">×</button>
    `;
    return li;
  }

  private pendingEl(row: Row) {
    const li = document.createElement('li');
    li.dataset.user = row.user.toLowerCase();
    li.className = 'brow ' + row.state;
    li.innerHTML = `
      <span class="rank">·</span>
      <span class="who">
        <span class="name">${row.user}</span>
        <span class="sub">${row.state === 'loading' ? 'loading…' : (row.error ?? 'failed')}</span>
      </span>
      <button class="rm" type="button" aria-label="Remove ${row.user}">×</button>
    `;
    return li;
  }

  // ------------------------------------------------------------------ persist

  static restore(fromUrl: string | null): string[] {
    if (fromUrl) {
      const list = fromUrl.split(',').map((s) => s.trim()).filter((s) => USERNAME_RE.test(s));
      if (list.length) return list.slice(0, MAX_USERS);
    }
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list) && list.length) {
          return list.filter((s: unknown) => typeof s === 'string' && USERNAME_RE.test(s)).slice(0, MAX_USERS);
        }
      }
    } catch {
      // Private browsing or a corrupt entry. Seeding is a fine fallback.
    }
    return SEED;
  }

  persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.users));
    } catch {
      // Storage unavailable. The URL still carries the board.
    }
  }

  toggle(show?: boolean) {
    const next = show ?? this.root.hidden;
    this.root.hidden = !next;
    return next;
  }

  get visible() {
    return !this.root.hidden;
  }
}

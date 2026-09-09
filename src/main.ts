import { City } from './city';
import { THEMES, themeById, type Theme } from './themes';
import {
  fetchContributions,
  computeStats,
  demoContributions,
  ContributionError,
  isYearRange,
  type Contributions,
  type Day,
} from './data';
import { Leaderboard } from './leaderboard';
import './style.css';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const canvas = $<HTMLCanvasElement>('scene');
const form = $<HTMLFormElement>('form');
const userInput = $<HTMLInputElement>('user');
const goBtn = $<HTMLButtonElement>('go');
const rangeSel = $<HTMLSelectElement>('range');
const themeBox = $<HTMLDivElement>('themes');
const statsBox = $<HTMLDListElement>('stats');
const msgEl = $<HTMLParagraphElement>('msg');
const tooltip = $<HTMLDivElement>('tooltip');
const toastEl = $<HTMLDivElement>('toast');
const hint = $<HTMLDivElement>('hint');
const boardEl = $<HTMLElement>('board');
const boardBtn = $<HTMLButtonElement>('a-board');
const versusEl = $<HTMLElement>('versus');
const versusBtn = $<HTMLButtonElement>('a-versus');
const vsForm = $<HTMLFormElement>('vs-form');
const vsA = $<HTMLInputElement>('vs-a');
const vsB = $<HTMLInputElement>('vs-b');
const vsGo = $<HTMLButtonElement>('vs-go');
const vsTable = $<HTMLTableElement>('vs-table');
const vsBody = $<HTMLTableSectionElement>('vs-body');
const vsNote = $<HTMLParagraphElement>('vs-note');
const tagsEl = $<HTMLDivElement>('tags');
const tagEls = [$<HTMLSpanElement>('tag-0'), $<HTMLSpanElement>('tag-1')];

const params = new URLSearchParams(location.search);
let theme: Theme = themeById(params.get('theme'));
let current: Contributions | null = null;
/** The pair on screen in versus mode, or null in single city mode. */
let pair: [Contributions, Contributions] | null = null;
let loading = false;

const city = new City(canvas, theme);
city.start();

// The board ranks people by contribution volume and doubles as a way to jump
// between cities. It costs one request per person, so nothing is fetched until
// the panel is actually opened.
const board = new Leaderboard(boardEl, {
  onPick: (user, range) => {
    ensureRangeOption(range);
    rangeSel.value = range;
    userInput.value = user;
    load(user, range);
  },
  onChange: () => {
    board.persist();
    syncURL();
  },
});

// ------------------------------------------------------------------ chrome

function setAccent(t: Theme) {
  document.documentElement.style.setProperty('--accent', t.accent);
  document.body.style.background = '#' + t.bg.toString(16).padStart(6, '0');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t.accent);
}

function buildThemeButtons() {
  for (const t of THEMES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t.label;
    b.dataset.id = t.id;
    b.setAttribute('aria-pressed', String(t.id === theme.id));
    b.addEventListener('click', () => {
      theme = t;
      city.applyTheme(t);
      setAccent(t);
      for (const el of themeBox.querySelectorAll('button')) {
        el.setAttribute('aria-pressed', String(el.dataset.id === t.id));
      }
      syncURL();
    });
    themeBox.appendChild(b);
  }
}

function buildRangeOptions(selected: string) {
  const year = new Date().getUTCFullYear();
  const opts: Array<[string, string]> = [['last', 'Last 12 months']];
  for (let y = year; y >= year - 9; y--) opts.push([String(y), String(y)]);
  rangeSel.innerHTML = '';
  for (const [value, label] of opts) addOption(rangeSel, value, label);
  rangeSel.value = opts.some(([v]) => v === selected) ? selected : 'last';
}

/**
 * The range picker only lists the last ten years, but a leaderboard pick can
 * point at any year the API knows about. Add the missing year rather than
 * silently snapping the selection back to the rolling window.
 */
function ensureRangeOption(range: string) {
  if ([...rangeSel.options].some((o) => o.value === range)) return;
  addOption(rangeSel, range, range);
}

const TOAST_MS = 2200;
const TOAST_FADE_MS = 250;

let toastTimer: number | undefined;
function toast(text: string) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  requestAnimationFrame(() => toastEl.classList.add('show'));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove('show');
    window.setTimeout(() => (toastEl.hidden = true), TOAST_FADE_MS);
  }, TOAST_MS);
}

function message(text: string | null, kind: 'error' | 'info' = 'error') {
  if (!text) {
    msgEl.hidden = true;
    return;
  }
  msgEl.textContent = text;
  msgEl.className = kind === 'info' ? 'msg info' : 'msg';
  msgEl.hidden = false;
}

function syncURL() {
  if (!current) return;
  const p = new URLSearchParams();
  if (pair) {
    p.set('vs', `${pair[0].user},${pair[1].user}`);
  } else if (current.user !== 'demo') {
    p.set('user', current.user);
  }
  p.set('range', current.range);
  p.set('theme', theme.id);
  // The board only travels in a link once it is actually on screen.
  if (board.visible && board.users.length) {
    p.set('users', board.users.join(','));
    p.set('period', board.period);
  }
  history.replaceState(null, '', p.toString() ? `?${p}` : location.pathname);
}

const fmt = new Intl.NumberFormat('en-US');

function addOption(select: HTMLSelectElement, value: string, label: string) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  select.appendChild(o);
}

/** Split a comma separated URL parameter into trimmed, non-empty tokens. */
function splitParam(value: string | null): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function renderStats(c: Contributions) {
  const s = computeStats(c.days);
  $<HTMLElement>('s-total').textContent = fmt.format(s.total);
  $<HTMLElement>('s-best').textContent = s.best ? `${s.best.count} · ${s.best.date.slice(5)}` : '—';
  $<HTMLElement>('s-streak').textContent = `${s.longestStreak}d`;
  $<HTMLElement>('s-active').textContent = `${s.activeDays}`;
  statsBox.hidden = false;
}

// ------------------------------------------------------------------ loading

async function load(user: string, range: string) {
  if (loading) return;
  // A single city and a comparison cannot share the scene.
  if (pair) exitVersus();
  loading = true;
  goBtn.disabled = true;
  message(`Building ${user}'s city…`, 'info');

  try {
    const data = await fetchContributions(user, range);
    current = data;
    city.build(data.days);
    renderStats(data);
    board.setActive(data.user);
    document.title = `${data.user} · gitcity`;
    message(null);
    syncURL();
  } catch (err) {
    const known = err instanceof ContributionError;
    message(known ? err.message : 'Something went wrong loading that profile.');
    if (!current) loadDemo();
  } finally {
    loading = false;
    goBtn.disabled = false;
  }
}

function loadDemo() {
  const data = demoContributions();
  current = data;
  city.build(data.days);
  renderStats(data);
}

// ------------------------------------------------------------------ versus

const rangeLabel = (r: string) => (r === 'last' ? 'the last 12 months' : r);

/**
 * Two cities in one scene. Both sides are fetched for the same range, because
 * comparing someone's 2024 against someone else's 2019 is not a comparison.
 */
async function loadVersus(a: string, b: string, range: string) {
  const left = a.trim().replace(/^@/, '');
  const right = b.trim().replace(/^@/, '');

  if (!left || !right) {
    vsNote.textContent = 'Two usernames needed.';
    return;
  }
  if (left.toLowerCase() === right.toLowerCase()) {
    vsNote.textContent = 'Pick two different people.';
    return;
  }
  // Changing the range kicks off a single city build, and the obvious next
  // move is to click Compare. Dropping that click makes the button look dead,
  // so wait the build out instead of refusing. Bounded, so a wedged request
  // still surfaces rather than hanging the button forever.
  if (loading) {
    vsGo.disabled = true;
    vsNote.textContent = 'Waiting for the current city to finish…';
    const until = Date.now() + 20_000;
    while (loading && Date.now() < until) await new Promise((r) => setTimeout(r, 60));
    vsGo.disabled = false;
    if (loading) {
      vsNote.textContent = 'Still building the last view, try again in a second.';
      return;
    }
  }

  loading = true;
  vsGo.disabled = true;
  vsNote.textContent = `Building both cities for ${rangeLabel(range)}…`;

  // Settled, not all: one bad username should name itself rather than fail
  // the whole comparison anonymously.
  const [ra, rb] = await Promise.allSettled([
    fetchContributions(left, range),
    fetchContributions(right, range),
  ]);

  loading = false;
  vsGo.disabled = false;

  const failed = [
    ra.status === 'rejected' ? { who: left, err: ra.reason } : null,
    rb.status === 'rejected' ? { who: right, err: rb.reason } : null,
  ].filter(Boolean) as Array<{ who: string; err: unknown }>;

  if (failed.length) {
    vsNote.textContent = failed
      .map((f) => (f.err instanceof ContributionError ? f.err.message : `Could not load ${f.who}.`))
      .join(' ');
    return;
  }

  const A = (ra as PromiseFulfilledResult<Contributions>).value;
  const B = (rb as PromiseFulfilledResult<Contributions>).value;

  pair = [A, B];
  current = A;
  city.compare({ label: A.user, days: A.days }, { label: B.user, days: B.days });

  vsA.value = A.user;
  vsB.value = B.user;
  userInput.value = A.user;
  statsBox.hidden = true;
  message(null);
  renderVersus(A, B);
  showTags(!city.sideBySide);
  document.title = `${A.user} vs ${B.user} · gitcity`;
  syncURL();
}

/** Higher wins for every metric here, so one comparator covers the table. */
function renderVersus(A: Contributions, B: Contributions) {
  const sa = computeStats(A.days);
  const sb = computeStats(B.days);

  const rows: Array<[string, number, number, string, string]> = [
    ['Contributions', sa.total, sb.total, fmt.format(sa.total), fmt.format(sb.total)],
    [
      'Best day',
      sa.best?.count ?? 0,
      sb.best?.count ?? 0,
      sa.best ? String(sa.best.count) : '—',
      sb.best ? String(sb.best.count) : '—',
    ],
    ['Longest streak', sa.longestStreak, sb.longestStreak, `${sa.longestStreak}d`, `${sb.longestStreak}d`],
    ['Active days', sa.activeDays, sb.activeDays, `${sa.activeDays}`, `${sb.activeDays}`],
    [
      'Busiest week',
      busiestWeek(A.days),
      busiestWeek(B.days),
      fmt.format(busiestWeek(A.days)),
      fmt.format(busiestWeek(B.days)),
    ],
  ];

  $<HTMLElement>('vs-h-a').textContent = A.user;
  $<HTMLElement>('vs-h-b').textContent = B.user;

  vsBody.innerHTML = '';
  for (const [label, va, vb, ta, tb] of rows) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = label;
    const ca = document.createElement('td');
    ca.textContent = ta;
    const cb = document.createElement('td');
    cb.textContent = tb;
    if (va > vb) ca.classList.add('win');
    else if (vb > va) cb.classList.add('win');
    tr.append(name, ca, cb);
    vsBody.appendChild(tr);
  }

  vsTable.hidden = false;
  // Turned side by side there are no floating captions, so the mapping from
  // table column to skyline has to be said out loud.
  vsNote.textContent = city.sideBySide
    ? `${rangeLabel(A.range)}. ${A.user} left, ${B.user} right, one shared scale.`
    : `${rangeLabel(A.range)}. Both cities share one height and colour scale.`;
}

/** Best rolling 7 day total, a fairer read on peak output than a single day. */
function busiestWeek(days: Day[]) {
  let sum = 0;
  let best = 0;
  for (let i = 0; i < days.length; i++) {
    sum += days[i].count;
    if (i >= 7) sum -= days[i - 7].count;
    if (sum > best) best = sum;
  }
  return best;
}

function showTags(show: boolean) {
  tagsEl.hidden = !show;
  if (!show) for (const el of tagEls) el.style.transform = 'translate(-9999px, -9999px)';
}

// offsetWidth forces layout, so it is measured only when the caption text
// actually changes rather than on every frame.
const tagCache = tagEls.map(() => ({ html: '', w: 0 }));

city.onLabels((items) => {
  if (tagsEl.hidden) return;
  items.forEach((it, i) => {
    const el = tagEls[i];
    const cache = tagCache[i];
    if (!el || !cache) return;

    const html = `${it.label} <b>${fmt.format(it.total)}</b>`;
    if (html !== cache.html) {
      el.innerHTML = html;
      cache.html = html;
      cache.w = el.offsetWidth;
    }

    // Captions hang off the left end of their district. Clamp so one never
    // slides off screen when the camera is orbited around.
    const x = Math.max(cache.w + 10, Math.round(it.x));
    el.style.transform = it.visible
      ? `translate(-100%, -50%) translate(${x}px, ${Math.round(it.y)}px)`
      : 'translate(-9999px, -9999px)';
  });
});

function showVersus(show: boolean) {
  if (!show) {
    // Leaving the comparison drops back to whoever was on the left.
    const back = exitVersus();
    if (back) {
      ensureRangeOption(back.range);
      rangeSel.value = back.range;
      userInput.value = back.user;
      load(back.user, back.range);
    }
    return;
  }

  versusEl.hidden = false;
  versusBtn.setAttribute('aria-pressed', 'true');
  // The two panels live in the same corner, so only one can be open.
  if (board.visible) showBoard(false);
  if (!vsA.value) vsA.value = current && current.user !== 'demo' ? current.user : '';
  (vsA.value ? vsB : vsA).focus();
  if (!pair) vsNote.textContent = 'Two usernames, one shared scale.';
}

/** Tears the comparison down without loading anything. Returns the left side. */
function exitVersus() {
  const back = pair ? pair[0] : null;
  pair = null;
  showTags(false);
  versusEl.hidden = true;
  versusBtn.setAttribute('aria-pressed', 'false');
  return back;
}

// ------------------------------------------------------------------ actions

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const exportName = () =>
  pair
    ? `gitcity-${pair[0].user}-vs-${pair[1].user}-${pair[0].range}`
    : `gitcity-${current?.user ?? 'demo'}-${current?.range ?? ''}`;

$<HTMLButtonElement>('a-png').addEventListener('click', () => {
  const name = `${exportName()}.png`;
  const url = city.snapshotPNG();
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  toast('PNG saved');
});

$<HTMLButtonElement>('a-stl').addEventListener('click', () => {
  toast('Building mesh…');
  // Let the toast paint before the merge blocks the main thread.
  setTimeout(() => {
    try {
      download(city.exportSTL(), `${exportName()}.stl`);
      toast('STL exported');
    } catch {
      toast('Could not export STL');
    }
  }, 60);
});

$<HTMLButtonElement>('a-share').addEventListener('click', async () => {
  syncURL();
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied');
  } catch {
    toast(location.href);
  }
});

$<HTMLButtonElement>('a-reset').addEventListener('click', () => city.resetView());

let boardSeeded = false;
function showBoard(show: boolean) {
  board.toggle(show);
  boardBtn.setAttribute('aria-pressed', String(show));
  if (show && !versusEl.hidden) showVersus(false);
  if (show && !boardSeeded) {
    boardSeeded = true;
    board.load(seedUsers);
    if (current) board.setActive(current.user);
  }
  syncURL();
}

boardBtn.addEventListener('click', () => showBoard(!board.visible));

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = userInput.value.trim();
  if (v) load(v, rangeSel.value);
});

rangeSel.addEventListener('change', () => {
  // In versus mode the range drives both sides at once.
  if (pair) {
    if (rangeSel.value !== pair[0].range) loadVersus(pair[0].user, pair[1].user, rangeSel.value);
    return;
  }
  const v = userInput.value.trim() || current?.user;
  if (!v || v === 'demo') return;
  // Reselecting the year already on screen should not refetch it.
  if (current && current.user === v && current.range === rangeSel.value) return;
  load(v, rangeSel.value);
});

versusBtn.addEventListener('click', () => showVersus(versusEl.hidden));
$<HTMLButtonElement>('vs-close').addEventListener('click', () => showVersus(false));
vsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  loadVersus(vsA.value, vsB.value, rangeSel.value);
});

city.onHover((info) => {
  if (!info) {
    tooltip.hidden = true;
    return;
  }
  const d = new Date(info.date + 'T00:00:00Z');
  const label = d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
  const who = info.label ? `<span class="who">${info.label}</span>` : '';
  tooltip.innerHTML = `<b>${info.count} contribution${info.count === 1 ? '' : 's'}</b><span>${label}</span>${who}`;
  tooltip.hidden = false;
  // Keep the card inside the viewport near the right and bottom edges.
  const w = tooltip.offsetWidth || 160;
  const h = tooltip.offsetHeight || 44;
  tooltip.style.left = `${Math.min(info.x + 14, window.innerWidth - w - 10)}px`;
  tooltip.style.top = `${Math.min(info.y + 14, window.innerHeight - h - 10)}px`;
});

canvas.addEventListener('pointerdown', () => hint.classList.add('gone'), { once: true });
setTimeout(() => hint.classList.add('gone'), 9000);

// ------------------------------------------------------------------ boot

buildThemeButtons();
setAccent(theme);

const startUser = params.get('user');
const startRange = params.get('range') ?? 'last';
buildRangeOptions(startRange);
if (isYearRange(startRange)) {
  ensureRangeOption(startRange);
  rangeSel.value = startRange;
}

const usersParam = params.get('users');
const seedUsers = Leaderboard.restore(usersParam);
const startPeriod = params.get('period');
if (startPeriod && (startPeriod === 'all' || startPeriod === 'last' || isYearRange(startPeriod))) {
  board.setPeriod(startPeriod);
}

// A head to head link opens straight into the comparison and skips the single
// city load entirely, otherwise the two would race for the scene.
const vsParam = splitParam(params.get('vs'));

if (vsParam.length === 2) {
  vsA.value = vsParam[0];
  vsB.value = vsParam[1];
  userInput.value = vsParam[0];
  showVersus(true);
  loadVersus(vsParam[0], vsParam[1], rangeSel.value);
} else if (startUser) {
  userInput.value = startUser;
  load(startUser, rangeSel.value);
} else {
  loadDemo();
  message('Enter a GitHub username to build a city.', 'info');
}

// A shared link that carries a board should land with the board already open.
if (usersParam && vsParam.length !== 2) showBoard(true);

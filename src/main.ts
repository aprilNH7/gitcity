import { City } from './city';
import { THEMES, themeById, type Theme } from './themes';
import { fetchContributions, computeStats, demoContributions, ContributionError, type Contributions } from './data';
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

const params = new URLSearchParams(location.search);
let theme: Theme = themeById(params.get('theme'));
let current: Contributions | null = null;
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
  for (const [value, label] of opts) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    rangeSel.appendChild(o);
  }
  rangeSel.value = opts.some(([v]) => v === selected) ? selected : 'last';
}

/**
 * The range picker only lists the last ten years, but a leaderboard pick can
 * point at any year the API knows about. Add the missing year rather than
 * silently snapping the selection back to the rolling window.
 */
function ensureRangeOption(range: string) {
  if ([...rangeSel.options].some((o) => o.value === range)) return;
  const o = document.createElement('option');
  o.value = range;
  o.textContent = range;
  rangeSel.appendChild(o);
}

let toastTimer: number | undefined;
function toast(text: string) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  requestAnimationFrame(() => toastEl.classList.add('show'));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove('show');
    window.setTimeout(() => (toastEl.hidden = true), 250);
  }, 2200);
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
  if (current.user !== 'demo') p.set('user', current.user);
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

// ------------------------------------------------------------------ actions

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$<HTMLButtonElement>('a-png').addEventListener('click', () => {
  const name = `gitcity-${current?.user ?? 'demo'}-${current?.range ?? ''}.png`;
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
      download(city.exportSTL(), `gitcity-${current?.user ?? 'demo'}-${current?.range ?? ''}.stl`);
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
  const v = userInput.value.trim() || current?.user;
  if (v && v !== 'demo') load(v, rangeSel.value);
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
  tooltip.innerHTML = `<b>${info.count} contribution${info.count === 1 ? '' : 's'}</b><span>${label}</span>`;
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
if (/^\d{4}$/.test(startRange)) {
  ensureRangeOption(startRange);
  rangeSel.value = startRange;
}

const usersParam = params.get('users');
const seedUsers = Leaderboard.restore(usersParam);
const startPeriod = params.get('period');
if (startPeriod && (startPeriod === 'all' || startPeriod === 'last' || /^\d{4}$/.test(startPeriod))) {
  board.setPeriod(startPeriod);
}

if (startUser) {
  userInput.value = startUser;
  load(startUser, rangeSel.value);
} else {
  loadDemo();
  message('Enter a GitHub username to build a city.', 'info');
}

// A shared link that carries a board should land with the board already open.
if (usersParam) showBoard(true);

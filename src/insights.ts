import type { Contributions, Day } from './data';

export interface ActivityInsights {
  days: Day[];
  activeDays: number;
  activeRate: number;
  months: Array<{ month: string; total: number }>;
  bestMonth: { month: string; total: number } | null;
  busiestWeekday: { label: string; total: number } | null;
}

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const number = new Intl.NumberFormat('en-US');
const monthFormat = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export function activityInsights(days: Day[], today = new Date().toISOString().slice(0, 10)): ActivityInsights {
  const elapsed = days.filter((day) => day.date <= today).slice().sort((left, right) => left.date.localeCompare(right.date));
  const months = new Map<string, number>();
  const totals = weekdays.map(() => 0);
  let activeDays = 0;
  for (const day of elapsed) {
    const month = day.date.slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + day.count);
    totals[new Date(`${day.date}T00:00:00Z`).getUTCDay()] += day.count;
    if (day.count > 0) activeDays++;
  }
  const monthly = [...months].map(([month, total]) => ({ month, total }));
  const bestMonth = monthly.reduce<ActivityInsights['bestMonth']>((best, month) => month.total > (best?.total ?? 0) ? month : best, null);
  const weekday = totals.reduce((best, total, index) => total > totals[best] ? index : best, 0);
  return {
    days: elapsed,
    activeDays,
    activeRate: elapsed.length ? activeDays / elapsed.length : 0,
    months: monthly,
    bestMonth,
    busiestWeekday: totals[weekday] > 0 ? { label: weekdays[weekday], total: totals[weekday] } : null,
  };
}

export function dailyCSV(entries: Contributions[], today = new Date().toISOString().slice(0, 10)): Blob {
  const rows: (string | number)[][] = [['User', 'Range', 'Date', 'Contributions', 'Intensity', 'Source']];
  for (const entry of entries) {
    for (const day of activityInsights(entry.days, today).days) {
      rows.push([entry.user, entry.range, day.date, day.count, day.level, entry.user === 'demo' ? 'Generated demo' : 'GitHub contribution API']);
    }
  }
  const csv = rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  return new Blob([csv], { type: 'text/csv;charset=utf-8' });
}

export function renderInsights(container: HTMLElement, entries: Contributions[]) {
  container.replaceChildren();
  for (const entry of entries) {
    const insights = activityInsights(entry.days);
    const section = document.createElement('section');
    section.className = 'insight-profile';
    const heading = document.createElement('h3');
    heading.textContent = `${entry.user === 'demo' ? 'Demo data' : entry.user} · ${entry.range === 'last' ? 'Last 12 months' : entry.range}`;
    const metrics = document.createElement('dl');
    metrics.className = 'stats';
    const items = [
      ['Active days', `${number.format(insights.activeDays)} / ${number.format(insights.days.length)}`],
      ['Active-day rate', `${(insights.activeRate * 100).toFixed(1)}%`],
      ['Busiest weekday', insights.busiestWeekday?.label ?? '—'],
      ['Best month', insights.bestMonth ? monthFormat.format(new Date(`${insights.bestMonth.month}-01T00:00:00Z`)) : '—'],
    ];
    for (const [label, value] of items) {
      const item = document.createElement('div');
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      term.textContent = label;
      description.textContent = value;
      item.append(term, description);
      metrics.appendChild(item);
    }
    const chartTitle = document.createElement('h4');
    chartTitle.textContent = 'Monthly contributions';
    const chart = document.createElement('ul');
    chart.className = 'monthly-chart';
    chart.setAttribute('aria-label', `Monthly contributions for ${entry.user}`);
    const maximum = Math.max(1, ...insights.months.map((month) => month.total));
    for (const month of insights.months) {
      const row = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = monthFormat.format(new Date(`${month.month}-01T00:00:00Z`));
      const track = document.createElement('span');
      track.className = 'month-track';
      track.setAttribute('aria-hidden', 'true');
      const bar = document.createElement('span');
      bar.style.width = `${month.total / maximum * 100}%`;
      track.appendChild(bar);
      const total = document.createElement('strong');
      total.textContent = number.format(month.total);
      row.append(label, track, total);
      chart.appendChild(row);
    }
    const note = document.createElement('p');
    note.className = 'board-note';
    note.textContent = entry.user === 'demo'
      ? 'Generated sample data, not a real GitHub profile.'
      : 'Based on returned contribution days through today (UTC). Edge months may be partial. Weekday ranking uses total contributions.';
    section.append(heading, metrics, chartTitle, chart, note);
    container.appendChild(section);
  }
}

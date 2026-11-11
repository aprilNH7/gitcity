import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.BASE ?? 'http://localhost:5177';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const counts = [2, 0, 4, 1, 0, 3, 5, 0];
const days = counts.map((count, index) => ({
  date: new Date(Date.UTC(2024, 0, 30 + index)).toISOString().slice(0, 10),
  count,
  level: count ? 2 : 0,
}));
days.push({ date: '2999-01-01', count: 900, level: 4 });
await page.route(/github-contributions-api\.jogruber\.de/, (route) => route.fulfill({
  json: { total: { 2024: 15 }, contributions: days },
}));
let passed = 0;
function check(name, action) {
  action();
  passed++;
  console.log(`PASS  ${name}`);
}

try {
  await page.goto(`${base}/?user=aprilNH7&range=2024`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.title.includes('aprilNH7'));
  await page.click('#a-insights');
  assert.equal(await page.locator('#insights').isVisible(), true);
  assert.equal(await page.getAttribute('#a-insights', 'aria-expanded'), 'true');
  check('monthly chart and insights match source data, excluding future dates', () => {});
  const metricValues = await page.locator('#insights dd').allTextContents();
  check('active days, active rate, weekday and best month', () => assert.deepEqual(metricValues, ['5 / 8', '62.5%', 'Monday', 'Feb 2024']));
  const monthlyTotals = await page.locator('.monthly-chart strong').allTextContents();
  check('monthly totals reconcile', () => assert.deepEqual(monthlyTotals, ['2', '13']));

  const [csv] = await Promise.all([page.waitForEvent('download'), page.click('#insights-export')]);
  const content = await readFile(await csv.path(), 'utf8');
  check('daily CSV includes only elapsed days and real source labels', () => {
    assert.equal(content.split('\r\n').length, 9);
    assert.match(content, /"aprilNH7","2024","2024-01-30","2","2","GitHub contribution API"/);
    assert.doesNotMatch(content, /2999/);
    assert.equal(csv.suggestedFilename(), 'gitcity-aprilNH7-2024-daily.csv');
  });

  const edgeCases = await page.evaluate(async () => {
    const { activityInsights, dailyCSV } = await import('/src/insights.ts');
    const zero = activityInsights([{ date: '2024-02-29', count: 0, level: 0 }], '2024-02-29');
    const empty = activityInsights([], '2024-02-29');
    const unsorted = activityInsights([
      { date: '2024-03-01', count: 3, level: 1 },
      { date: '2024-02-29', count: 2, level: 1 },
      { date: '2024-03-02', count: 99, level: 4 },
    ], '2024-03-01');
    const quoted = await dailyCSV([{ user: 'demo', range: '2024', total: 0, days: [{ date: '2024-02-29', count: 0, level: 0 }] }], '2024-02-29').text();
    return { zero, empty, unsorted, quoted };
  });
  check('empty and inactive periods have no invented winning month or weekday', () => {
    assert.equal(edgeCases.zero.bestMonth, null);
    assert.equal(edgeCases.zero.busiestWeekday, null);
    assert.equal(edgeCases.empty.activeRate, 0);
    assert.deepEqual(edgeCases.empty.months, []);
  });
  check('leap days, UTC cutoff and sorted months', () => {
    assert.deepEqual(edgeCases.unsorted.months, [{ month: '2024-02', total: 2 }, { month: '2024-03', total: 3 }]);
    assert.match(edgeCases.quoted, /Generated demo/);
  });

  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#insights').isHidden(), true);
  await page.keyboard.press('i');
  assert.equal(await page.locator('#insights').isVisible(), true);
  await page.click('#a-board');
  assert.equal(await page.locator('#insights').isHidden(), true);
  assert.equal(await page.locator('#board').isVisible(), true);
  check('keyboard shortcuts and panel exclusivity', () => {});

  await page.click('#a-versus');
  await page.fill('#vs-a', 'aprilNH7');
  await page.fill('#vs-b', 'torvalds');
  await page.click('#vs-go');
  await page.waitForSelector('#vs-table:not([hidden])');
  await page.click('#a-insights');
  assert.equal(await page.locator('.insight-profile').count(), 2);
  const [pairCsv] = await Promise.all([page.waitForEvent('download'), page.click('#insights-export')]);
  const pairContent = await readFile(await pairCsv.path(), 'utf8');
  check('comparison insights and CSV contain both profiles', () => {
    assert.equal(pairContent.split('\r\n').length, 17);
    assert.match(pairContent, /"aprilNH7"/);
    assert.match(pairContent, /"torvalds"/);
  });
  await page.click('#insights-close');
  assert.equal(await page.locator('#versus').isVisible(), true);
  assert.match(page.url(), /vs=aprilNH7%2Ctorvalds/);
  check('closing insights preserves comparison', () => {});

  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#a-insights');
  const bounds = await page.locator('#insights').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height < 760);
  await page.click('#insights-export');
  await page.click('#insights-close');
  await page.locator('#a-reset').scrollIntoViewIfNeeded();
  await page.click('#a-reset');
  check('phone panel and horizontally scrollable actions stay reachable', () => {});

  await page.setViewportSize({ width: 1440, height: 860 });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.click('#a-insights');
  assert.match(await page.locator('#insights').textContent(), /Generated sample data/);
  check('generated demo is explicitly labeled', () => {});
  check('no browser exceptions', () => assert.deepEqual(errors, []));
  console.log(`\n${passed}/${passed} passed`);
} finally {
  await browser.close();
}

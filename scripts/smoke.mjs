import { chromium } from 'playwright';
import { stat } from 'node:fs/promises';

const URL = process.env.URL ?? 'http://localhost:5177/?user=torvalds&range=2024&theme=neon';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });

const errors = [];
const badResponses = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  // Resource-level failures are asserted separately via the response hook, so
  // the deliberate 404 from the unknown-user test does not mask real errors.
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text());
});
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().includes('github-contributions-api')) {
    badResponses.push(`${r.status()} ${r.url()}`);
  }
});

let apiCalls = 0;
page.on('request', (r) => {
  if (r.url().includes('github-contributions-api')) apiCalls++;
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);

// Data landed and matches what the profile graph shows.
const total = await page.textContent('#s-total');
check('contributions render', total === '2,892', `got ${total}`);
check('stats panel visible', await page.isVisible('#s-active'));

// Hover raycast against the InstancedMesh yields a per-day tooltip.
const box = await page.locator('#scene').boundingBox();
let tip = '';
for (let dx = -280; dx <= 280 && !tip; dx += 40) {
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + 40);
  await page.waitForTimeout(130);
  if (await page.isVisible('#tooltip')) tip = (await page.textContent('#tooltip')) ?? '';
}
check('hover tooltip', /contribution/.test(tip), tip.trim().slice(0, 46));

// Theme switch repaints in place and is captured in the URL.
await page.click('button[data-id="sunset"]');
await page.waitForTimeout(500);
check('theme switch', (await page.getAttribute('button[data-id="sunset"]', 'aria-pressed')) === 'true');
check('theme in url', page.url().includes('theme=sunset'));

// STL export produces a real binary mesh, not an empty file.
const [stl] = await Promise.all([
  page.waitForEvent('download', { timeout: 25000 }).catch(() => null),
  page.click('#a-stl'),
]);
if (stl) {
  const { size } = await stat(await stl.path());
  check('STL export', size > 50_000, `${stl.suggestedFilename()} · ${size} bytes`);
} else {
  check('STL export', false, 'no download fired');
}

// PNG path at least runs to completion and reports success.
await page.click('#a-png');
await page.waitForTimeout(900);
check('PNG export', (await page.textContent('#toast'))?.includes('PNG') ?? false);

// ------------------------------------------------------------------ board

// Nothing is fetched for the board until it is opened.
const callsBeforeBoard = apiCalls;
await page.click('#a-board');
check('board opens', await page.isVisible('#board'));

await page.waitForFunction(
  () => document.querySelectorAll('#board .brow .value').length >= 4,
  null,
  { timeout: 30000 },
).catch(() => {});

const readRows = () =>
  page.$$eval('#board .brow', (els) =>
    els
      .filter((el) => el.querySelector('.value'))
      .map((el) => ({
        user: el.querySelector('.name')?.textContent ?? '',
        value: Number((el.querySelector('.value')?.textContent ?? '0').replace(/,/g, '')),
      })),
  );

const seeded = await readRows();
check('board seeds rank', seeded.length >= 4, seeded.map((r) => `${r.user}:${r.value}`).join(' '));
check(
  'board sorted desc',
  seeded.every((r, i) => i === 0 || seeded[i - 1].value >= r.value),
);
check('one request per person', apiCalls - callsBeforeBoard === seeded.length, `${apiCalls - callsBeforeBoard} calls`);

// Switching period re-ranks locally: different numbers, zero extra requests.
const callsBeforePeriod = apiCalls;
await page.selectOption('#board .board-period', 'last');
await page.waitForTimeout(600);
const windowed = await readRows();
check('period re-ranks', windowed.some((r, i) => r.value !== seeded[i]?.value), 'totals changed');
check('period costs no requests', apiCalls === callsBeforePeriod, `${apiCalls - callsBeforePeriod} extra`);
check(
  'period sorted desc',
  windowed.every((r, i) => i === 0 || windowed[i - 1].value >= r.value),
);

// Clicking a row loads that person's city.
const pick = windowed[0].user;
await page.click('#board .brow:first-child .who');
await page.waitForTimeout(4500);
check('row loads city', (await page.inputValue('#user')).toLowerCase() === pick.toLowerCase(), pick);
check('row marked active', await page.isVisible('#board .brow.active'));

// Adding a person appends to the board and persists to the URL.
await page.fill('#board .board-add input', 'kentcdodds');
await page.press('#board .board-add input', 'Enter');
await page
  .waitForSelector('#board .brow[data-user="kentcdodds"] .value', { timeout: 30000 })
  .catch(() => {});
const grown = await readRows();
const addedState = await page
  .textContent('#board .brow[data-user="kentcdodds"] .sub')
  .catch(() => 'row missing');
check('add user', grown.some((r) => r.user.toLowerCase() === 'kentcdodds'), `${grown.length} rows · ${addedState}`);
check('board in url', /users=.*kentcdodds/i.test(decodeURIComponent(page.url())));

// Removing takes it back off.
await page.click('#board .brow:has-text("kentcdodds") .rm');
await page.waitForTimeout(500);
const shrunk = await readRows();
check('remove user', !shrunk.some((r) => r.user.toLowerCase() === 'kentcdodds'), `${shrunk.length} rows`);

await page.click('#a-board');
check('board closes', !(await page.isVisible('#board')));

// An unknown user gets a readable message rather than a blank screen.
await page.fill('#user', 'this-user-should-not-exist-zzz9');
await page.click('#go');
await page.waitForTimeout(3000);
const msg = (await page.textContent('#msg')) ?? '';
check('unknown user handled', /not found/i.test(msg), msg.trim().slice(0, 56));

// Phone viewport keeps the controls reachable.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1200);
check('mobile layout', await page.isVisible('#panel'));
await page.click('#a-board');
check('mobile board fits', await page.isVisible('#board .board-list'));

// A shared board link lands with the board already open on the right period.
await page.setViewportSize({ width: 1440, height: 860 });
const deepURL = `${URL}${URL.includes('?') ? '&' : '?'}users=torvalds,gaearon&period=2024`;
await page.goto(deepURL, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
check('board deep link opens', await page.isVisible('#board'));
check('deep link period', (await page.inputValue('#board .board-period')) === '2024');

check('no runtime errors', errors.length === 0, errors.slice(0, 2).join(' | '));
check('no broken assets', badResponses.length === 0, badResponses.slice(0, 2).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

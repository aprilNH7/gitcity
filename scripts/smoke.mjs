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

check('no runtime errors', errors.length === 0, errors.slice(0, 2).join(' | '));
check('no broken assets', badResponses.length === 0, badResponses.slice(0, 2).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

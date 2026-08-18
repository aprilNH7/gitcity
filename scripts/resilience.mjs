// A rate limited or 5xx response from the contributions API arrives without a
// CORS header, so the browser rejects the fetch and no status is ever visible.
// This reproduces that exact shape by failing the first attempt outright, and
// checks the app recovers instead of blaming the user's connection.
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:5177';
const API = /github-contributions-api\.jogruber\.de/;

let passed = 0;
let failed = 0;
const check = (ok, name, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  ok ? passed++ : failed++;
};

const browser = await chromium.launch();

// ---------------------------------------------------------- recovers on retry
{
  const page = await browser.newPage();
  let seen = 0;
  await page.route(API, (route) => {
    seen++;
    // Fail only the opening attempt, exactly as a stripped CORS response does.
    if (seen === 1) return route.abort('failed');
    return route.continue();
  });

  await page.goto(`${BASE}/?user=torvalds&range=2024`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('#s-total');
      return el && el.textContent && el.textContent.trim() !== '—';
    },
    null,
    { timeout: 30000 },
  ).catch(() => {});

  const total = await page.textContent('#s-total');
  const title = await page.title();
  const msgHidden = await page.locator('#msg').isHidden();
  // The demo fallback also fills #s-total, so check the real profile loaded
  // rather than merely that something rendered.
  check(/torvalds/.test(title), 'the real city loads after a failed first attempt', `total ${total}`);
  check(msgHidden, 'no error shown to the user');
  check(seen >= 2, 'the request was actually retried', `${seen} attempts`);
  await page.close();
}

// ------------------------------------------------- gives up honestly when down
{
  const page = await browser.newPage();
  let seen = 0;
  await page.route(API, (route) => {
    seen++;
    return route.abort('failed');
  });

  await page.goto(`${BASE}/?user=torvalds&range=2024`, { waitUntil: 'domcontentloaded' });
  // #msg is already visible with the loading line, so wait for the attempts to
  // run out and the text to settle rather than for the element to appear.
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector('#msg');
        return el && !el.hasAttribute('hidden') && !/Building/.test(el.textContent ?? '');
      },
      null,
      { timeout: 30000 },
    )
    .catch(() => {});
  const msg = (await page.textContent('#msg')) ?? '';

  check(seen === 3, 'stops after three attempts', `${seen} attempts`);
  check(/not responding|offline/i.test(msg), 'message describes the API, not a bad connection', JSON.stringify(msg));
  check(!/Check your connection/i.test(msg) || /offline/i.test(msg), 'does not blame the connection while online');
  await page.close();
}

// ------------------------------------------------ a missing user is not retried
{
  const page = await browser.newPage();
  let seen = 0;
  await page.route(API, (route) => {
    seen++;
    return route.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: '{}' });
  });

  await page.goto(`${BASE}/?user=this-user-should-not-exist-zzz9&range=2024`, { waitUntil: 'domcontentloaded' });
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector('#msg');
        return el && !el.hasAttribute('hidden') && !/Building/.test(el.textContent ?? '');
      },
      null,
      { timeout: 30000 },
    )
    .catch(() => {});
  const msg = (await page.textContent('#msg')) ?? '';

  check(seen === 1, 'a 404 is settled, so it is not retried', `${seen} attempt`);
  check(/not found/i.test(msg), 'says the user does not exist', JSON.stringify(msg));
  await page.close();
}

// -------------------------------------------- Compare clicked mid single build
// Changing the range starts a single city build. Clicking Compare immediately
// after used to be dropped on the floor, so the button looked broken. Slowing
// the API guarantees the build is still running when the click lands.
{
  const page = await browser.newPage();
  await page.route(API, async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    return route.continue();
  });

  await page.goto(`${BASE}/?user=torvalds&range=last`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.title.includes('torvalds'), null, { timeout: 40000 }).catch(() => {});

  await page.click('#a-versus');
  await page.fill('#vs-a', 'torvalds');
  await page.fill('#vs-b', 'gaearon');
  // Kick off a single city build, then click Compare while it is still running.
  await page.selectOption('#range', '2024');
  await page.click('#vs-go');

  await page
    .waitForFunction(() => document.querySelectorAll('#vs-body tr').length === 5, null, { timeout: 60000 })
    .catch(() => {});

  const rows = (await page.$$('#vs-body tr')).length;
  const note = (await page.textContent('#vs-note')) ?? '';
  const url = page.url();

  check(rows === 5, 'Compare still runs when clicked during a build', `${rows} rows`);
  check(/vs=torvalds(%2C|,)gaearon/i.test(url), 'the comparison reaches the url', url.replace(BASE, ''));
  check(!/try again in a second/i.test(note), 'the click is not silently refused', JSON.stringify(note));
  await page.close();
}

await browser.close();
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);

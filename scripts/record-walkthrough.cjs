/**
 * Records docs/walkthrough.mp4 - the executions list, a support email arriving
 * and being answered in its own thread, the chat widget answering live on
 * widget/demo.html, and the same Gmail message delivered a second time exiting
 * cleanly on the idempotency claim.
 *
 * The email deliveries and the widget questions are fired from this script
 * while the browser is recording, so what the video shows is n8n reacting to
 * real events - not a replay of something captured earlier. The two long
 * pauses are the Gmail Trigger's one-minute poll, spent on the widget and on
 * the answer engine rather than on a spinner.
 *
 *   scripts/demo-up.sh && node scripts/run-scenarios.mjs
 *   node scripts/record-walkthrough.cjs
 *
 * Needs ffmpeg on PATH to convert Playwright's webm to mp4.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  '/Users/lekhrajsaini/Downloads/habit-tracker/node_modules/playwright');

const BASE = process.env.N8N_BASE || 'http://localhost:5681';
const MOCK = process.env.MOCK_BASE || 'http://127.0.0.1:4181';
const DOCS = path.join(__dirname, '..', 'docs');
const TMP = path.join(DOCS, 'screenshots', '.tmp');
const WIDGET = 'file://' + path.join(__dirname, '..', 'widget', 'demo.html');

const OWNER = {
  email: process.env.N8N_OWNER_EMAIL || 'demo@localhost.test',
  password: process.env.N8N_OWNER_PASSWORD || 'DemoRun-2026!x',
};

const VIEWPORT = { width: 1600, height: 900 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const restOk = async () => {
  const res = await fetch('/rest/workflows', {
    headers: { 'browser-id': localStorage.getItem('n8n-browserId') || '' },
  });
  return res.ok;
};

async function signIn(page) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[name="emailOrLdapLoginId"]', { timeout: 20_000 });
    await page.fill('input[name="emailOrLdapLoginId"]', OWNER.email);
    await page.fill('input[type="password"]', OWNER.password);
    await page.click('[data-test-id="form-submit-button"], button[type="submit"]');
    await sleep(2500);
    if (await page.evaluate(restOk)) return;
    await sleep(1500);
  }
  throw new Error('could not sign in to n8n');
}

async function deliver(message, label) {
  const res = await fetch(`${MOCK}/__control/gmail/deliver`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ internalDate: Date.now(), ...message }),
  });
  console.log(`  ${label}: ${res.status}`);
}

async function fitCanvas(page) {
  await page.waitForSelector('.vue-flow__node', { timeout: 30_000 });
  await page.locator('.vue-flow__pane').click({ position: { x: 800, y: 520 } }).catch(() => {});
  await page.keyboard.press('1');
}

async function openNode(page, label) {
  await page.locator('.vue-flow__node', { hasText: label }).first().dblclick({ timeout: 15_000 }).catch(() => {});
}

const SUPPORT_EMAIL = {
  id: 'mockmsg-walkthrough-1',
  threadId: 'thread-walkthrough-1',
  from: 'Marcus Hale <marcus.hale@example.com>',
  subject: 'Can my clients pay an invoice by card?',
  body: 'Hi - can my clients pay one of your invoices by card, and do you add a fee on top of what Stripe charges?\n\nMarcus',
};

async function main() {
  fs.mkdirSync(TMP, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: TMP, size: VIEWPORT },
  });

  const page = await context.newPage();
  await signIn(page);

  const byName = await page.evaluate(async () => {
    const res = await fetch('/rest/workflows', {
      headers: { 'browser-id': localStorage.getItem('n8n-browserId') || '' },
    });
    const body = await res.json();
    const list = [body.data?.data, body.data, body.results, body].find(Array.isArray) ?? [];
    return Object.fromEntries(list.map((w) => [w.name, w.id]));
  });
  const EMAIL = byName['01 - Email Support Agent'];
  const ENGINE = byName['03 - Answer Engine (shared backend)'];

  console.log('recording:');

  /* 1 - everything that has run so far ------------------------------------ */
  await page.goto(`${BASE}/home/executions`, { waitUntil: 'domcontentloaded' });
  await sleep(9000);

  /* 2 - a support email arrives ------------------------------------------- */
  await page.goto(`${BASE}/workflow/${EMAIL}/executions`, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  await deliver(SUPPORT_EMAIL, 'support email delivered to the mock mailbox');

  /* ...and while the Gmail Trigger's minute runs down, the widget ---------- */
  const widget = await context.newPage();
  await widget.setViewportSize(VIEWPORT);
  await widget.goto(WIDGET, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await widget.click('.chip:nth-child(1)');
  await widget.waitForSelector('.hb-meta', { timeout: 20_000 }).catch(() => {});
  await sleep(6000);
  await widget.evaluate(() => window.HarbourlyChat.ask('I was charged twice this month, can I get a refund?'));
  await widget.waitForFunction(() => document.querySelectorAll('.hb-meta').length >= 2, { timeout: 20_000 }).catch(() => {});
  await sleep(7000);
  await widget.evaluate(() => window.HarbourlyChat.ask('Do you have an Android app with offline receipt scanning?'));
  await widget.waitForFunction(() => document.querySelectorAll('.hb-meta').length >= 3, { timeout: 20_000 }).catch(() => {});
  await sleep(8000);
  await widget.close();

  /* 3 - the shared answer engine, still waiting on the poll ---------------- */
  await page.bringToFront();
  await page.goto(`${BASE}/workflow/${ENGINE}/executions`, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  await page.locator('[data-test-id="execution-preview-card"], .execution-card').first().click().catch(() => {});
  await sleep(2000);
  await fitCanvas(page);
  await sleep(4000);
  await openNode(page, 'Apply Relevance Floor');
  await sleep(9000);
  await page.keyboard.press('Escape');
  await sleep(2000);

  /* 4 - the reply, in the same thread -------------------------------------- */
  await page.goto(`${BASE}/workflow/${EMAIL}/executions`, { waitUntil: 'domcontentloaded' });
  await sleep(6000);
  await page.locator('[data-test-id="execution-preview-card"], .execution-card').first().click().catch(() => {});
  await sleep(2500);
  await fitCanvas(page);
  await sleep(4000);
  await openNode(page, 'Reply In The Same Thread');
  await sleep(11000);
  await page.keyboard.press('Escape');
  await sleep(2000);

  /* 5 - a message that has already been answered, delivered a second time ---
   *
   * mockmsg-support-1, not the one just delivered. The Gmail Trigger's own
   * duplicate set holds the ids it fetched on its LAST poll, so re-sending the
   * most recent message would be filtered before the workflow ever saw it -
   * which is the trigger doing its job, not the workflow doing its job. An
   * older id is handed straight through, and then the idempotency claim in the
   * workflow is what has to catch it. That is the thing under test.
   */
  await deliver(
    {
      id: 'mockmsg-support-1',
      threadId: 'thread-support-1',
      from: 'Priya Nair <priya.nair@example.com>',
      subject: 'How do I turn on two-factor authentication?',
      body: 'Hi,\n\nI want to turn on two factor authentication on my Harbourly account but I cannot find it in the settings. Which authenticator app do you support?\n\nThanks,\nPriya',
    },
    'an already-answered message id delivered again',
  );
  await page.goto(`${BASE}/workflow/${EMAIL}/executions`, { waitUntil: 'domcontentloaded' });
  await sleep(50_000); // the Gmail Trigger's poll interval, on camera
  await page.reload({ waitUntil: 'domcontentloaded' });
  await sleep(6000);
  await page.locator('[data-test-id="execution-preview-card"], .execution-card').first().click().catch(() => {});
  await sleep(2500);
  await fitCanvas(page);
  await sleep(5000);
  await openNode(page, 'Claim This Message');
  await sleep(11000);
  await page.keyboard.press('Escape');
  await sleep(3000);

  const video = page.video();
  await context.close();
  const webm = await video.path();
  await browser.close();

  const mp4 = path.join(DOCS, 'walkthrough.mp4');
  execFileSync('ffmpeg', [
    '-y', '-i', webm,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-crf', '26', '-r', '15',
    mp4,
  ], { stdio: 'inherit' });
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`wrote docs/walkthrough.mp4`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

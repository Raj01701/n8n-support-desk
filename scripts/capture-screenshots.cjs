/**
 * Screenshots the real n8n execution views for the runs scripts/run-scenarios.mjs
 * just produced, into docs/screenshots/.
 *
 * Headless Chromium against http://localhost:5681, logged in as the demo owner.
 * Nothing is drawn or mocked up: every image is the view n8n renders for an
 * execution id that exists in its own database, cropped to the canvas so the
 * node labels are readable rather than lost in empty grid.
 *
 *   scripts/demo-up.sh
 *   node scripts/run-scenarios.mjs
 *   node scripts/capture-screenshots.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const { chromium } = require(process.env.PLAYWRIGHT_PATH ||
  '/Users/lekhrajsaini/Downloads/habit-tracker/node_modules/playwright');

const BASE = process.env.N8N_BASE || 'http://localhost:5681';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const WIDGET = 'file://' + path.join(__dirname, '..', 'widget', 'demo.html');

const OWNER = {
  email: process.env.N8N_OWNER_EMAIL || 'demo@localhost.test',
  password: process.env.N8N_OWNER_PASSWORD || 'DemoRun-2026!x',
};

const VIEWPORT = { width: 1920, height: 1080 };
/**
 * Crop from just above the breadcrumb, so every workflow screenshot carries the
 * workflow's own name and the "Succeeded in 467ms | ID#1" line. Those two are
 * what make the image evidence rather than decoration.
 */
const HEADER_TOP = 16;
/** Left edge of the canvas column: the executions list sidebar ends here. */
const CANVAS_LEFT = 368;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dismissOverlays(page) {
  for (let i = 0; i < 4; i += 1) {
    const close = page.locator('.el-dialog__headerbtn, [data-test-id="close-button"]').first();
    if (await close.isVisible().catch(() => false)) {
      await close.click().catch(() => {});
      await sleep(400);
      continue;
    }
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(250);
  }
}

async function openExecution(page, workflowId, executionId) {
  // domcontentloaded, not networkidle: the editor holds a push connection open,
  // so the network is never idle and every navigation would time out.
  await page.goto(`${BASE}/workflow/${workflowId}/executions/${executionId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.vue-flow__node', { timeout: 30_000 });
  await dismissOverlays(page);
  await page.locator('.vue-flow__pane').click({ position: { x: 700, y: 520 } }).catch(() => {});
  await page.keyboard.press('1'); // zoom to fit
  await sleep(1800);
}

/**
 * Crop to the band the workflow actually occupies, and to the column the canvas
 * occupies - the executions sidebar on the left is 365px of list that is the
 * same in every shot. The crop keeps the breadcrumb and the
 * "Succeeded in 467ms | ID#1" line, which are what make the image evidence
 * rather than decoration.
 */
async function canvasClip(page) {
  const box = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('.vue-flow__node')];
    if (!nodes.length) return null;
    const rects = nodes.map((n) => n.getBoundingClientRect());
    return {
      left: Math.min(...rects.map((r) => r.left)),
      right: Math.max(...rects.map((r) => r.right)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
    };
  });
  if (!box) return undefined;

  const x = Math.max(CANVAS_LEFT, Math.min(box.left - 30, CANVAS_LEFT));
  return {
    x,
    y: HEADER_TOP,
    width: Math.min(VIEWPORT.width - x, box.right + 40 - x),
    height: Math.min(VIEWPORT.height, box.bottom + 56) - HEADER_TOP,
  };
}

async function shoot(page, name, options = {}) {
  const file = path.join(OUT, name);
  await page.screenshot({ path: file, ...options });
  console.log(`  wrote docs/screenshots/${name}`);
}

const shootCanvas = async (page, name) => shoot(page, name, { clip: await canvasClip(page) });

async function openNode(page, label) {
  const node = page.locator('.vue-flow__node', { hasText: label }).first();
  await node.dblclick({ timeout: 15_000 });
  await sleep(2200);
}

/**
 * n8n binds the session cookie to the browser-id the editor generated at login
 * and keeps in localStorage. A /rest call from page.evaluate with any other
 * browser-id is rejected as Unauthorized even though the user is signed in - so
 * every such call has to present the editor's own id.
 */
const restOk = async () => {
  const res = await fetch('/rest/workflows', {
    headers: { 'browser-id': localStorage.getItem('n8n-browserId') || '' },
  });
  return res.ok;
};

/**
 * Signs in and proves it. The editor's own boot sequence can land on /signin
 * again if the first POST races n8n's session setup, and a screenshot run that
 * does not check ends up with twenty pictures of a login form.
 */
async function signIn(page) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await page.goto(`${BASE}/signin`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[name="emailOrLdapLoginId"]', { timeout: 20_000 });
    await page.fill('input[name="emailOrLdapLoginId"]', OWNER.email);
    await page.fill('input[type="password"]', OWNER.password);
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/rest/login') && r.request().method() === 'POST', { timeout: 20_000 }).catch(() => null),
      page.click('[data-test-id="form-submit-button"], button[type="submit"]'),
    ]);
    await sleep(2500);

    const ok = await page.evaluate(restOk);
    if (ok) {
      await dismissOverlays(page);
      return;
    }
    console.log(`  sign-in attempt ${attempt} did not take, retrying`);
    await sleep(2000);
  }
  throw new Error('could not sign in to n8n - check the demo owner credentials');
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 3 });
  const page = await context.newPage();

  await signIn(page);

  // Workflow ids differ on every instance, so resolve them by name through the
  // same REST API the editor uses, with the session this page already holds.
  const byName = await page.evaluate(async () => {
    const res = await fetch('/rest/workflows', {
      headers: { 'browser-id': localStorage.getItem('n8n-browserId') || '' },
    });
    const body = await res.json();
    const list = [body.data?.data, body.data, body.results, body].find(Array.isArray) ?? [];
    return Object.fromEntries(list.map((w) => [w.name, w.id]));
  });
  const EMAIL = byName['01 - Email Support Agent'];
  const CHAT = byName['02 - Live Chat Agent'];
  const ENGINE = byName['03 - Answer Engine (shared backend)'];
  const ERRORS = byName['04 - Error Trigger Alerts'];

  console.log('capturing:');

  // --- the list everything else is an entry in ------------------------------
  await page.goto(`${BASE}/home/executions`, { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  await dismissOverlays(page);
  await shoot(page, '01-executions-list.png', { clip: { x: 0, y: 0, width: VIEWPORT.width, height: 900 } });

  // --- scenario 1: a genuine support email ----------------------------------
  await openExecution(page, EMAIL, 1);
  await shootCanvas(page, '02-support-email-answered.png');
  await openNode(page, 'Capture Email Fields');
  await shoot(page, '03-captured-sender-subject-body-thread.png');
  await page.keyboard.press('Escape');
  await sleep(600);
  await openNode(page, 'Reply In The Same Thread');
  await shoot(page, '04-reply-in-the-same-thread.png');
  await page.keyboard.press('Escape');

  // --- scenario 2: a newsletter, routed out ---------------------------------
  await openExecution(page, EMAIL, 3);
  await shootCanvas(page, '05-non-support-routed-out.png');
  await openNode(page, 'Label As Not Support');
  await shoot(page, '06-labelled-not-support-no-reply.png');
  await page.keyboard.press('Escape');

  // --- scenario 3: thread continuity ----------------------------------------
  await openExecution(page, EMAIL, 4);
  await openNode(page, 'Build Engine Request');
  await shoot(page, '07-thread-history-loaded.png');
  await page.keyboard.press('Escape');

  // --- the shared answer engine, retrieving ---------------------------------
  await openExecution(page, ENGINE, 5);
  await shootCanvas(page, '08-answer-engine-canvas.png');
  await openNode(page, 'Apply Relevance Floor');
  await shoot(page, '09-retrieved-passages-and-ranks.png');
  await page.keyboard.press('Escape');

  // --- scenario 4: missing knowledge ----------------------------------------
  await openExecution(page, EMAIL, 6);
  await shootCanvas(page, '10-missing-knowledge-to-human.png');
  await openExecution(page, ENGINE, 7);
  await openNode(page, 'Record Unanswered Question');
  await shoot(page, '11-unanswered-question-recorded.png');
  await page.keyboard.press('Escape');

  // --- scenario 5: money ----------------------------------------------------
  await openExecution(page, EMAIL, 8);
  await openNode(page, 'Confidence Gate');
  await shoot(page, '12-money-question-fails-the-gate.png');
  await page.keyboard.press('Escape');

  // --- scenario 6: the chat agent -------------------------------------------
  await openExecution(page, CHAT, 10);
  await shootCanvas(page, '13-chat-agent-canvas.png');

  // --- scenario 8a: the model 500s twice and recovers ------------------------
  await openExecution(page, ENGINE, 17);
  await openNode(page, 'Answer From Passages');
  await shoot(page, '14-model-500s-then-recovers.png');
  await page.keyboard.press('Escape');

  // --- scenario 8b: a hard failure reaches the error workflow ----------------
  await openExecution(page, CHAT, 18);
  await shootCanvas(page, '15-failed-execution.png');
  await openExecution(page, ERRORS, 21);
  await shootCanvas(page, '16-error-trigger-recorded-the-failure.png');

  // --- scenario 9: the duplicate --------------------------------------------
  await openExecution(page, EMAIL, 22);
  await shootCanvas(page, '17-duplicate-exits-cleanly.png');
  await openNode(page, 'Claim This Message');
  await shoot(page, '18-duplicate-guard-zero-rows.png');
  await page.keyboard.press('Escape');

  // --- the widget, answering for real ---------------------------------------
  const widgetPage = await context.newPage();
  await widgetPage.setViewportSize({ width: 1440, height: 940 });
  await widgetPage.goto(WIDGET, { waitUntil: 'domcontentloaded' });
  await sleep(800);
  await widgetPage.click('.chip');
  await widgetPage.waitForSelector('.hb-meta', { timeout: 20_000 });
  await sleep(700);
  await shoot(widgetPage, '19-chat-widget-answering.png');

  await widgetPage.evaluate(() =>
    window.HarbourlyChat.ask('I was charged twice this month, can I get a refund?'));
  await widgetPage.waitForFunction(() => document.querySelectorAll('.hb-meta').length >= 2, { timeout: 20_000 });
  await sleep(700);
  await shoot(widgetPage, '20-chat-widget-hands-over.png');

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

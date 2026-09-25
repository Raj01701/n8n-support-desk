/**
 * Drives every scenario in docs/testing-summary.md against the live stack and
 * prints what actually happened.
 *
 *   scripts/demo-up.sh
 *   node scripts/run-scenarios.mjs
 *
 * Nothing here simulates n8n. It puts messages in the mock mailbox, posts to the
 * chat webhook, injects failures into the mock, and then reads the executions
 * out of n8n and the rows out of Postgres. Every assertion below is made against
 * one of those two sources of truth.
 *
 * The email scenarios are slow on purpose: the Gmail Trigger is a poll trigger
 * on a one-minute schedule, and waiting for it is the difference between proving
 * the trigger works and proving that a script can call a workflow.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupOwner, api } from './n8n-client.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MOCK = process.env.MOCK_BASE || 'http://127.0.0.1:4181';
const N8N_PORT = process.env.N8N_HOST_PORT || 5681;
const N8N = `http://127.0.0.1:${N8N_PORT}`;
const CHAT_SECRET = process.env.CHAT_WEBHOOK_SECRET || 'local-demo-chat-widget-secret';
const POLL_WAIT_MS = 100_000;

/** psql field separator. Anything a seeded article cannot contain. */
const SEP = '<|>';

const results = [];

/* ---------------------------------------------------------------- helpers */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mock = (path, body) =>
  fetch(`${MOCK}/__control${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((r) => r.json());

function sql(query) {
  const out = execFileSync(
    'docker',
    [
      'compose',
      '-f', join(ROOT, 'infra/docker-compose.yml'),
      '-f', join(ROOT, 'infra/docker-compose.demo.yml'),
      '--env-file', join(ROOT, 'infra/.env.demo'),
      'exec', '-T', '-e', 'PGPASSWORD=local-demo-password',
      'postgres', 'psql', '-U', 'n8n', '-d', 'support_ops', '-X', '-A', '-t', '-F', SEP, '-c', query,
    ],
    { encoding: 'utf8', cwd: ROOT },
  );
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(SEP));
}

const one = (query) => (sql(query)[0] ?? [])[0] ?? null;

async function executions(limit = 40) {
  const list = await api(`/executions?limit=${limit}`);
  return list.results ?? list.data ?? list;
}

const nameOf = (e) => e.workflowName ?? e.workflowData?.name;

/** Waits for a finished execution of `workflowName` newer than `afterId`. */
async function waitForExecution(workflowName, afterId, timeoutMs = POLL_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await executions()).find(
      (e) => nameOf(e) === workflowName && Number(e.id) > Number(afterId),
    );
    if (found && found.status !== 'running' && found.status !== 'new') return found;
    await sleep(2000);
  }
  throw new Error(`no new execution of "${workflowName}" within ${timeoutMs / 1000}s`);
}

const latestExecutionId = async () => Number((await executions(1))[0]?.id ?? 0);

/**
 * The chat workflow answers the browser from Respond To Visitor and then keeps
 * going - logging, persisting, queueing. So the execution is still running when
 * the HTTP response lands, and reading it straight away reports "running" with
 * no stoppedAt. Waiting for it to settle is the difference between a timing
 * number that means something and one that is nonsense.
 */
async function settledExecution(workflowName, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await executions()).find((e) => nameOf(e) === workflowName);
    if (found && found.status !== 'running' && found.status !== 'new') return found;
    await sleep(500);
  }
  throw new Error(`execution of "${workflowName}" did not finish within ${timeoutMs / 1000}s`);
}

const durationMs = (e) => new Date(e.stoppedAt) - new Date(e.startedAt);

function record(name, heading, asserted, observed, execution) {
  results.push({
    name,
    heading,
    asserted,
    observed,
    execution_id: execution?.id ?? null,
    status: execution?.status ?? null,
    ms: execution ? durationMs(execution) : null,
  });
  const badge = execution ? `exec ${execution.id} ${execution.status} ${durationMs(execution)}ms` : '';
  console.log(`\n[${name}] ${badge}\n  asserted: ${asserted}\n  observed: ${observed}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const deliverEmail = (message) => mock('/gmail/deliver', { internalDate: Date.now(), ...message });

async function chat(body) {
  const started = Date.now();
  const res = await fetch(`${N8N}/webhook/chat/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chat-secret': CHAT_SECRET },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* a failed execution answers with n8n's own error page, which is the point of 8b */
  }
  return { status: res.status, ms: Date.now() - started, body: parsed };
}

/* ------------------------------------------------------------------- run */
async function main() {
  await setupOwner({
    email: process.env.N8N_OWNER_EMAIL || 'demo@localhost.test',
    password: process.env.N8N_OWNER_PASSWORD || 'DemoRun-2026!x',
    firstName: 'Demo',
    lastName: 'Operator',
  });

  // The Gmail Trigger keeps its own cursor and its own recently-seen ids in
  // n8n's workflow static data, and nothing outside n8n can reset that. A second
  // run on the same instance would therefore find scenario 1's message already
  // seen and wait for a poll that never delivers. Refusing here is clearer than
  // timing out 100 seconds later.
  const existing = await executions(5);
  if (existing.length > 0) {
    throw new Error(
      `this instance has already run ${existing.length}+ executions.\n` +
        'The Gmail Trigger remembers which message ids it has delivered, so the scenarios need a clean instance:\n' +
        '  scripts/demo-down.sh && scripts/demo-up.sh && node scripts/run-scenarios.mjs',
    );
  }

  console.log('==> resetting the mock and the support tables (the seeded articles are kept)');
  await mock('/reset', {});
  sql(`TRUNCATE processed_messages, support_decisions, chat_messages, chat_sessions,
       human_review_queue, unanswered_questions, failures RESTART IDENTITY CASCADE;`);

  /* ===================================================================
   * Support vs non-support
   * =================================================================== */

  // 1 - a genuine support email
  let before = await latestExecutionId();
  await deliverEmail({
    id: 'mockmsg-support-1',
    threadId: 'thread-support-1',
    from: 'Priya Nair <priya.nair@example.com>',
    subject: 'How do I turn on two-factor authentication?',
    body: 'Hi,\n\nI want to turn on two factor authentication on my Harbourly account but I cannot find it in the settings. Which authenticator app do you support?\n\nThanks,\nPriya',
  });
  console.log('\nwaiting for the Gmail Trigger to poll (up to 100s)...');
  let exec = await waitForExecution('01 - Email Support Agent', before);
  {
    const row = sql(`SELECT action, confidence, grounded, used_article_ids, conversation_ref, left(reply_text, 70)
                       FROM support_decisions WHERE decision_key = 'email:mockmsg-support-1';`)[0];
    const state = await mock('/state');
    const sent = state.sent.find((s) => s.threadId === 'thread-support-1');
    const labels = state.modified.filter((m) => m.id === 'mockmsg-support-1').flatMap((m) => m.addLabelIds);
    assert(row && row[0] === 'auto_replied', 'the support email should have been auto-replied');
    assert(sent, 'a reply should have been sent on thread-support-1');
    assert(sent.inReplyTo === '<mockmsg-support-1@mail.example>', 'the reply must carry In-Reply-To');
    assert(labels.includes('Label_AutoReplied'), 'the message should be labelled Support/Auto-Replied');
    record('1 support email', 'Support vs non-support',
      'classified as support, answered from a seeded article, replied on the SAME threadId with In-Reply-To and References set, labelled Auto-Replied',
      `action=${row[0]} confidence=${row[1]} grounded=${row[2]} articles=${row[3]} | reply threadId=${sent.threadId} (inbound thread-support-1, match=${sent.threadId === 'thread-support-1'}) In-Reply-To=${sent.inReplyTo} References=${sent.references} | labels added=${JSON.stringify(labels)} | answer="${row[5]}..."`,
      exec);
  }

  // 2 - a newsletter, routed out
  before = await latestExecutionId();
  await deliverEmail({
    id: 'mockmsg-newsletter-1',
    threadId: 'thread-newsletter-1',
    from: 'SaaS Weekly <digest@saasweekly.example>',
    subject: 'SaaS Weekly #212: pricing experiments that worked',
    body: 'This week in SaaS Weekly: five pricing experiments that worked, a webinar on retention, and our reader survey.\n\nView this email in your browser.\n\nUnsubscribe at any time.',
  });
  console.log('\nwaiting for the Gmail Trigger to poll...');
  exec = await waitForExecution('01 - Email Support Agent', before);
  {
    const row = sql(`SELECT action, intent, reason FROM support_decisions WHERE decision_key = 'email:mockmsg-newsletter-1';`)[0];
    const state = await mock('/state');
    const labels = state.modified.filter((m) => m.id === 'mockmsg-newsletter-1').flatMap((m) => m.addLabelIds);
    assert(row && row[0] === 'routed_out_not_support', 'the newsletter should have been routed out');
    assert(!state.sent.some((s) => s.threadId === 'thread-newsletter-1'), 'no reply may be sent to a newsletter');
    assert(labels.includes('Label_NotSupport'), 'the newsletter should be labelled Support/Not-Support');
    record('2 non-support email', 'Support vs non-support',
      'classified as not-support, labelled Support/Not-Support and logged with a reason, and NO reply sent',
      `action=${row[0]} intent=${row[1]} reason="${row[2]}" | labels added=${JSON.stringify(labels)} | replies sent on this thread=${state.sent.filter((s) => s.threadId === 'thread-newsletter-1').length}`,
      exec);
  }

  /* ===================================================================
   * Thread continuity
   * =================================================================== */

  // 3 - a follow-up on the same thread
  before = await latestExecutionId();
  await deliverEmail({
    id: 'mockmsg-support-2',
    threadId: 'thread-support-1',
    rfcMessageId: '<mockmsg-support-2@mail.example>',
    inReplyTo: '<mockmsg-support-1@mail.example>',
    from: 'Priya Nair <priya.nair@example.com>',
    subject: 'Re: How do I turn on two-factor authentication?',
    body: 'That worked, thank you. What happens if I lose the recovery codes you mentioned?',
  });
  console.log('\nwaiting for the Gmail Trigger to poll...');
  exec = await waitForExecution('01 - Email Support Agent', before);
  {
    const row = sql(`SELECT action, confidence, used_article_ids, conversation_ref, left(reply_text, 90)
                       FROM support_decisions WHERE decision_key = 'email:mockmsg-support-2';`)[0];
    const threadRows = one(`SELECT count(*) FROM support_decisions WHERE conversation_ref = 'thread-support-1';`);
    const state = await mock('/state');
    const sent = state.sent.filter((s) => s.threadId === 'thread-support-1');
    assert(row && row[3] === 'thread-support-1', 'the follow-up must be logged against the same thread');
    assert(sent.length === 2, 'there should now be two replies on this thread');
    assert(sent[1].inReplyTo === '<mockmsg-support-2@mail.example>', 'the second reply must quote the second message');
    record('3 thread continuity', 'Thread continuity',
      'a follow-up on the same threadId loads the earlier turns as history, is answered, and the reply goes back on the same thread quoting the follow-up rather than the original',
      `conversation_ref=${row[3]} decision rows on this thread=${threadRows} | replies on thread=${sent.length}, second reply threadId=${sent[1].threadId} In-Reply-To=${sent[1].inReplyTo} | action=${row[0]} confidence=${row[1]} articles=${row[2]} | answer="${row[4]}..."`,
      exec);
  }

  /* ===================================================================
   * Missing knowledge
   * =================================================================== */

  // 4 - nothing in the knowledge base covers it
  before = await latestExecutionId();
  await deliverEmail({
    id: 'mockmsg-gap-1',
    threadId: 'thread-gap-1',
    from: 'Tom Okafor <tom@buildwell.example>',
    subject: 'Android app with offline receipt scanning?',
    body: 'Hello - is there an Android app, and does it scan paper receipts while offline on a building site?',
  });
  console.log('\nwaiting for the Gmail Trigger to poll...');
  exec = await waitForExecution('01 - Email Support Agent', before);
  {
    const row = sql(`SELECT action, grounded, reason FROM support_decisions WHERE decision_key = 'email:mockmsg-gap-1';`)[0];
    const gap = sql(`SELECT question, reason, asked_count FROM unanswered_questions ORDER BY id DESC LIMIT 1;`)[0];
    const queued = one(`SELECT count(*) FROM human_review_queue WHERE decision_key = 'email:mockmsg-gap-1';`);
    const state = await mock('/state');
    const labels = state.modified.filter((m) => m.id === 'mockmsg-gap-1').flatMap((m) => m.addLabelIds);
    assert(row && row[0] === 'handed_to_human', 'a question with no article must go to a human');
    assert(!state.sent.some((s) => s.threadId === 'thread-gap-1'), 'no answer may be sent when nothing was found');
    assert(gap, 'the question must be recorded in unanswered_questions');
    assert(state.slack.length > 0, 'Slack should have been alerted');
    record('4 missing knowledge', 'Missing knowledge',
      'no article above the relevance floor, so: not answered, a row written to unanswered_questions, labelled Needs-Human, a ticket queued, Slack alerted',
      `action=${row[0]} grounded=${row[1]} reason="${row[2]}" | unanswered_questions: "${gap[0].slice(0, 60)}..." reason=${gap[1]} asked_count=${gap[2]} | human_review_queue rows=${queued} | labels=${JSON.stringify(labels)} | slack posts=${state.slack.length} | replies sent=0`,
      exec);
  }

  // 5 - money. The gate refuses it whatever the confidence.
  before = await latestExecutionId();
  await deliverEmail({
    id: 'mockmsg-money-1',
    threadId: 'thread-money-1',
    from: 'Dana Whitfield <dana@whitfield.example>',
    subject: 'Refund for the annual plan',
    body: 'I was charged twice for the annual plan this month. Please can I get a refund for the duplicate charge?',
  });
  console.log('\nwaiting for the Gmail Trigger to poll...');
  exec = await waitForExecution('01 - Email Support Agent', before);
  {
    const row = sql(`SELECT action, confidence, grounded, touches_money, reason
                       FROM support_decisions WHERE decision_key = 'email:mockmsg-money-1';`)[0];
    const state = await mock('/state');
    assert(row && row[0] === 'handed_to_human', 'a refund request must never be auto-answered');
    assert(row[3] === 't', 'touches_money must be true');
    assert(!state.sent.some((s) => s.threadId === 'thread-money-1'), 'no auto-reply on a money question');
    record('5 money question', 'Support vs non-support',
      'a refund request is held for a human regardless of confidence, because the gate requires touches_money = false',
      `action=${row[0]} confidence=${row[1]} grounded=${row[2]} touches_money=${row[3]} reason="${row[4]}" | replies sent=0`,
      exec);
  }

  /* ===================================================================
   * Live chat
   * =================================================================== */

  // 6 - the widget, answered in the response to its own POST
  const session = 'sess-' + Math.random().toString(36).slice(2, 12);
  const first = await chat({
    session_id: session,
    message: 'How long is the free trial and what happens when it ends?',
    page_url: 'https://harbourly.example/pricing',
  });
  exec = await settledExecution('02 - Live Chat Agent');
  {
    assert(first.status === 200, 'the widget must get a 200');
    assert(first.body.grounded === true, 'the first chat question should be answered from the knowledge base');
    record('6 chat, immediate reply', 'Live chat',
      'the widget POST returns the answer in the body of its own response - no polling, no second request, no "we will email you"',
      `HTTP ${first.status} in ${first.ms}ms end to end (POST sent to answer rendered) | grounded=${first.body.grounded} articles=${JSON.stringify(first.body.used_article_ids)} | reply="${String(first.body.reply).slice(0, 80)}..."`,
      exec);
  }

  // 7 - memory. The same follow-up is asked twice: once in this session, once in
  // a fresh one. Only the session with history can answer it, which is the proof.
  const followUpText = 'And what does it cost after that?';
  const withMemory = await chat({ session_id: session, message: followUpText });
  const controlSession = 'sess-' + Math.random().toString(36).slice(2, 12);
  const withoutMemory = await chat({ session_id: controlSession, message: followUpText });
  exec = await settledExecution('02 - Live Chat Agent');
  {
    const turns = one(`SELECT count(*) FROM chat_messages WHERE session_id = '${session}';`);
    assert(withMemory.body.grounded === true, 'the follow-up should be answerable in a session that has history');
    assert(withoutMemory.body.grounded === false, 'the same words with no history should NOT be answerable');
    record('7 chat follow-up', 'Thread continuity',
      'the same follow-up text is grounded in the session that has history and not grounded in a fresh session - the difference is the memory and nothing else',
      `same session (${turns} turns stored): grounded=${withMemory.body.grounded} articles=${JSON.stringify(withMemory.body.used_article_ids)} in ${withMemory.ms}ms | fresh session, identical text: grounded=${withoutMemory.body.grounded} handed_to_human=${withoutMemory.body.handed_to_human}`,
      exec);
  }

  /* ===================================================================
   * Integration failures
   * =================================================================== */

  // 8a - the model returns 500 twice, then recovers
  await mock('/inject', { target: 'llm', status: 500, times: 2 });
  const retried = await chat({
    session_id: 'sess-' + Math.random().toString(36).slice(2, 12),
    message: 'Can my clients pay an invoice by card?',
  });
  const retryExec = await settledExecution('02 - Live Chat Agent');
  {
    const state = await mock('/state');
    const llmCalls = state.calls.filter((c) => c.kind === 'llm.chat.completions').length;
    assert(retried.status === 200, 'the visitor must still get an answer after the retries');
    assert(retried.body.grounded === true, 'the third attempt should have succeeded');
    record('8a model 500 twice, recovered', 'Integration failures',
      'two HTTP 500s from the model endpoint are absorbed by retryOnFail and the third attempt succeeds - same answer, longer execution',
      `HTTP ${retried.status} in ${retried.ms}ms (compare ${first.ms}ms with nothing injected) | grounded=${retried.body.grounded} | model endpoint calls across the whole run so far=${llmCalls}`,
      retryExec);
  }

  // 8b - the model answers 200 with an HTML error page. No retry fixes that.
  const failuresBefore = Number(one('SELECT count(*) FROM failures;'));
  await mock('/inject', { target: 'llm_garbage', status: 200, times: 1 });
  const hard = await chat({
    session_id: 'sess-' + Math.random().toString(36).slice(2, 12),
    message: 'How do I export all of my invoices?',
  });
  // The Error Trigger workflow runs after the failing execution finishes.
  await sleep(8000);
  {
    const failureRows = sql(`SELECT workflow_name, failed_node, left(error_message, 70), alert_delivered, execution_id
                               FROM failures ORDER BY id;`);
    const errorExec = await settledExecution('04 - Error Trigger Alerts');
    assert(hard.status >= 500, 'a garbage model response must fail the execution, not produce an invented answer');
    assert(failureRows.length > failuresBefore, 'the failure must be written to the failures table');
    assert(errorExec, 'workflow 04 must have run');
    record('8b model returns garbage', 'Integration failures',
      'a 200 with a non-JSON body fails the execution at the validator, the Error Trigger fires, Slack is alerted and a failures row is written whether or not Slack accepted',
      `chat HTTP ${hard.status} (no answer invented) | failures rows ${failuresBefore} -> ${failureRows.length}: ${failureRows.map((f) => `${f[0]} / node "${f[1]}" / "${f[2]}" / alert_delivered=${f[3]} / exec ${f[4]}`).join(' ;; ')}`,
      errorExec);
  }

  /* ===================================================================
   * Duplicate delivery
   * =================================================================== */

  // 9 - Gmail delivers mockmsg-support-1 a second time.
  //
  // This is not a contrivance. The Gmail Trigger keeps only the ids it fetched
  // on its LAST poll as its own duplicate set, so a message that reappears in
  // the mailbox after other mail has arrived is handed to the workflow again.
  // Re-stamping the message with a current internalDate is exactly that.
  before = await latestExecutionId();
  const decisionsBefore = Number(one(`SELECT count(*) FROM support_decisions WHERE decision_key = 'email:mockmsg-support-1';`));
  const repliesBefore = (await mock('/state')).sent.filter((s) => s.threadId === 'thread-support-1').length;
  await deliverEmail({
    id: 'mockmsg-support-1',
    threadId: 'thread-support-1',
    from: 'Priya Nair <priya.nair@example.com>',
    subject: 'How do I turn on two-factor authentication?',
    body: 'Hi,\n\nI want to turn on two factor authentication on my Harbourly account but I cannot find it in the settings. Which authenticator app do you support?\n\nThanks,\nPriya',
  });
  console.log('\nwaiting for the Gmail Trigger to redeliver the same message...');
  exec = await waitForExecution('01 - Email Support Agent', before);
  {
    const state = await mock('/state');
    const repliesAfter = state.sent.filter((s) => s.threadId === 'thread-support-1').length;
    const claims = one(`SELECT count(*) FROM processed_messages WHERE gmail_message_id = 'mockmsg-support-1';`);
    const decisionsAfter = Number(one(`SELECT count(*) FROM support_decisions WHERE decision_key = 'email:mockmsg-support-1';`));
    assert(exec.status === 'success', 'the duplicate must exit green, not fail');
    assert(repliesAfter === repliesBefore, 'the duplicate must not send a second reply');
    assert(claims === '1', 'there must be exactly one processed_messages row');
    assert(decisionsAfter === decisionsBefore, 'the duplicate must not add a decision row');
    record('9 duplicate delivery', 'Integration failures',
      'the same Gmail message id delivered a second time exits cleanly on the idempotency claim: exactly one reply, one processed_messages row, one decision row',
      `execution ${exec.id} ${exec.status} in ${durationMs(exec)}ms | processed_messages rows for this id=${claims} | replies on the thread ${repliesBefore} -> ${repliesAfter} | decision rows for this message ${decisionsBefore} -> ${decisionsAfter}`,
      exec);
  }

  /* ------------------------------------------------------------ summary */
  const totals = {
    support_decisions: one('SELECT count(*) FROM support_decisions;'),
    human_review_queue: one('SELECT count(*) FROM human_review_queue;'),
    unanswered_questions: one('SELECT count(*) FROM unanswered_questions;'),
    chat_messages: one('SELECT count(*) FROM chat_messages;'),
    processed_messages: one('SELECT count(*) FROM processed_messages;'),
    failures: one('SELECT count(*) FROM failures;'),
  };

  console.log('\n================ row counts after the run ================');
  console.table(totals);
  console.log('support_desk_daily:');
  console.log(sql('SELECT channel, messages, auto_replied, handed_to_human, routed_out, deflection_pct, avg_confidence FROM support_desk_daily;'));

  writeFileSync(
    join(ROOT, 'scripts/.last-run.json'),
    JSON.stringify({ ran_at: new Date().toISOString(), results, totals }, null, 2) + '\n',
  );
  console.log('\nwrote scripts/.last-run.json');
  console.log(`\n${results.length} scenarios, all assertions passed.`);
}

main().catch((err) => {
  console.error('\n' + err.stack);
  process.exit(1);
});

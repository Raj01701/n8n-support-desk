/**
 * Local stand-in for the three external services the workflows talk to: the
 * Gmail API, an OpenAI-compatible chat-completions endpoint, and Slack
 * incoming webhooks.
 *
 * It exists so the workflows can be executed end to end - real n8n, real
 * Postgres, real HTTP, real Gmail *node* - without anyone's Google account or
 * model provider key. Nothing here simulates n8n; n8n does all of the work and
 * this only answers the calls n8n makes.
 *
 * Two listeners:
 *   :4000  plain HTTP - the model endpoint, the Slack incoming webhooks, and
 *          the /__control endpoints scripts/run-scenarios.mjs drives.
 *   :443   HTTPS with a self-signed certificate, serving the Gmail API and the
 *          Google OAuth2 token endpoint. n8n's Gmail node and Gmail Trigger
 *          have no base-URL setting - they always call
 *          https://www.googleapis.com - so the demo compose file maps that
 *          name here and turns off certificate verification inside the n8n
 *          container. That is a demo-only shortcut and is documented as one.
 *
 * Node stdlib only. No dependencies, no build step.
 */
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const HTTP_PORT = Number(process.env.MOCK_HTTP_PORT || 4000);
const TLS_PORT = Number(process.env.MOCK_TLS_PORT || 443);
const TLS_DIR = process.env.MOCK_TLS_DIR || '/tls';

const MAILBOX_ADDRESS = 'support@harbourly.example';

/* --------------------------------------------------------------------------
 * State. Everything lives in memory and is reset between scenarios so each
 * recorded run starts from a known position.
 * ------------------------------------------------------------------------ */
const state = freshState();

function freshState() {
  return {
    messages: new Map(), // gmail message id -> the stored message
    sent: [],            // every reply the Gmail node sent
    modified: [],        // every labels-modify call
    slack: [],           // every Slack post
    llm: [],             // every chat-completions call, with the schema it asked for
    calls: [],           // request log, for asserting what was and was not called
    injections: [],      // forced failures
    nextMessageSeq: 1,
  };
}

function reset() {
  const fresh = freshState();
  for (const key of Object.keys(fresh)) state[key] = fresh[key];
}

/* --------------------------------------------------------------------------
 * Forced failures.
 *
 * { target: 'llm', status: 500, times: 2 } makes the next two calls to the
 * model endpoint fail. `times` matters: it is how a recorded run shows an
 * outage that lasts exactly long enough to exercise a node's retry budget and
 * then clears, rather than a service that is down forever.
 *
 * target 'llm_garbage' is different in kind: the endpoint answers 200 with a
 * body that is not JSON at all, which is what a provider's HTML error page
 * looks like from inside a workflow. No number of retries fixes that, and it
 * is the failure that reaches the Error Trigger.
 * ------------------------------------------------------------------------ */
function takeInjection(target) {
  const hit = state.injections.find((i) => i.target === target && i.remaining > 0);
  if (!hit) return null;
  hit.remaining -= 1;
  return hit;
}

/* --------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */
function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(Object.fromEntries(new URLSearchParams(raw)));
      }
    });
  });
}

function log(kind, detail) {
  state.calls.push({ at: new Date().toISOString(), kind, ...detail });
}

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const unb64 = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

/** RFC 5322 text for a stored message, which is what format=raw returns. */
function toMime(msg) {
  const lines = [
    `From: ${msg.from}`,
    `To: ${msg.to}`,
    `Subject: ${msg.subject}`,
    `Date: ${new Date(Number(msg.internalDate)).toUTCString()}`,
    `Message-ID: ${msg.rfcMessageId}`,
  ];
  if (msg.inReplyTo) {
    lines.push(`In-Reply-To: ${msg.inReplyTo}`);
    lines.push(`References: ${msg.references || msg.inReplyTo}`);
  }
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset=utf-8');
  lines.push('');
  lines.push(msg.body);
  return lines.join('\r\n');
}

function headerList(msg) {
  const headers = [
    { name: 'From', value: msg.from },
    { name: 'To', value: msg.to },
    { name: 'Subject', value: msg.subject },
    { name: 'Date', value: new Date(Number(msg.internalDate)).toUTCString() },
    { name: 'Message-ID', value: msg.rfcMessageId },
  ];
  if (msg.inReplyTo) headers.push({ name: 'In-Reply-To', value: msg.inReplyTo });
  return headers;
}

/* --------------------------------------------------------------------------
 * Gmail API
 *
 * Only the five endpoints n8n's Gmail Trigger and Gmail node actually call.
 * ------------------------------------------------------------------------ */
function gmail(url, req, res, body) {
  const path = url.pathname;

  // The trigger's scan. It sends q="is:unread after:<epoch> -in:scheduled";
  // only the `after:` term changes what a run returns, so that is the only one
  // interpreted here. The rest is recorded so a test can assert it was sent.
  if (path === '/gmail/v1/users/me/messages' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    log('gmail.messages.list', { q });

    const forced = takeInjection('gmail_list');
    if (forced) return send(res, forced.status, { error: { message: 'injected Gmail list failure' } });

    const after = /after:(\d+)/.exec(q);
    const floor = after ? Number(after[1]) * 1000 : 0;

    const messages = [...state.messages.values()]
      .filter((m) => !m.sent)
      .filter((m) => Number(m.internalDate) >= floor)
      .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
      .map((m) => ({ id: m.id, threadId: m.threadId }));

    return send(res, 200, { messages, resultSizeEstimate: messages.length });
  }

  const messageMatch = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path);
  if (messageMatch && req.method === 'GET') {
    const id = decodeURIComponent(messageMatch[1]);
    const format = url.searchParams.get('format') || 'full';
    log('gmail.messages.get', { id, format });

    const forced = takeInjection('gmail_get');
    if (forced) return send(res, forced.status, { error: { message: 'injected Gmail get failure' } });

    const msg = state.messages.get(id);
    if (!msg) return send(res, 404, { error: { code: 404, message: `no such message: ${id}` } });

    const base = {
      id: msg.id,
      threadId: msg.threadId,
      labelIds: msg.labelIds,
      sizeEstimate: msg.body.length + 400,
      internalDate: String(msg.internalDate),
    };

    if (format === 'raw') return send(res, 200, { ...base, raw: b64url(toMime(msg)) });
    // metadata is what the reply operation reads, to find the Message-ID it
    // must quote in In-Reply-To.
    return send(res, 200, { ...base, payload: { headers: headerList(msg) } });
  }

  if (path === '/gmail/v1/users/me/profile' && req.method === 'GET') {
    log('gmail.profile.get', {});
    return send(res, 200, { emailAddress: MAILBOX_ADDRESS, messagesTotal: state.messages.size });
  }

  if (path === '/gmail/v1/users/me/messages/send' && req.method === 'POST') {
    const forced = takeInjection('gmail_send');
    if (forced) {
      log('gmail.messages.send', { injected: forced.status });
      return send(res, forced.status, { error: { code: forced.status, message: 'injected Gmail send failure' } });
    }

    // The Gmail node hands us a complete RFC 5322 message. Pulling the headers
    // back out of it is the only honest way to prove the reply really did carry
    // In-Reply-To and References.
    const mime = unb64(body.raw || '');
    const headerBlock = mime.split(/\r?\n\r?\n/)[0] || '';
    const header = (name) => {
      const m = new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(headerBlock);
      return m ? m[1].trim() : null;
    };

    const id = `mockmsg-sent-${state.nextMessageSeq++}`;
    const record = {
      id,
      threadId: body.threadId || id,
      to: header('To'),
      subject: header('Subject'),
      inReplyTo: header('In-Reply-To'),
      references: header('References'),
      bodyPreview: mime.split(/\r?\n\r?\n/).slice(1).join('\n\n').trim().slice(0, 800),
      sentAt: new Date().toISOString(),
    };
    state.sent.push(record);
    log('gmail.messages.send', { threadId: record.threadId, to: record.to, inReplyTo: record.inReplyTo });

    return send(res, 200, { id, threadId: record.threadId, labelIds: ['SENT'] });
  }

  const modifyMatch = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/modify$/.exec(path);
  if (modifyMatch && req.method === 'POST') {
    const id = decodeURIComponent(modifyMatch[1]);
    const forced = takeInjection('gmail_modify');
    if (forced) {
      log('gmail.messages.modify', { id, injected: forced.status });
      return send(res, forced.status, { error: { code: forced.status, message: 'injected Gmail modify failure' } });
    }

    const msg = state.messages.get(id);
    if (!msg) return send(res, 404, { error: { code: 404, message: `no such message: ${id}` } });

    for (const label of body.addLabelIds || []) {
      if (!msg.labelIds.includes(label)) msg.labelIds.push(label);
    }
    msg.labelIds = msg.labelIds.filter((l) => !(body.removeLabelIds || []).includes(l));
    state.modified.push({ id, addLabelIds: body.addLabelIds || [], at: new Date().toISOString() });
    log('gmail.messages.modify', { id, addLabelIds: body.addLabelIds || [] });

    return send(res, 200, { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds });
  }

  if (path === '/gmail/v1/users/me/labels' && req.method === 'GET') {
    return send(res, 200, {
      labels: [
        { id: 'INBOX', name: 'INBOX', type: 'system' },
        { id: 'UNREAD', name: 'UNREAD', type: 'system' },
        { id: 'Label_NotSupport', name: 'Support/Not-Support', type: 'user' },
        { id: 'Label_NeedsHuman', name: 'Support/Needs-Human', type: 'user' },
        { id: 'Label_AutoReplied', name: 'Support/Auto-Replied', type: 'user' },
      ],
    });
  }

  return send(res, 404, { error: { code: 404, message: `gmail mock: no route for ${req.method} ${path}` } });
}

/* --------------------------------------------------------------------------
 * Google OAuth2 token endpoint.
 *
 * The demo credential ships with a token that does not expire for a decade, so
 * this is only reached if something goes wrong with that. It answers anyway,
 * because a refresh failing at 3am is exactly the kind of thing that should
 * show up as a Gmail error and not as a mystery.
 * ------------------------------------------------------------------------ */
function googleToken(req, res) {
  log('google.token', {});
  return send(res, 200, {
    access_token: 'mock-gmail-access-token',
    refresh_token: 'mock-gmail-refresh-token',
    token_type: 'Bearer',
    expires_in: 3599,
    scope: 'https://mail.google.com/',
  });
}

/* --------------------------------------------------------------------------
 * The model.
 *
 * An OpenAI-compatible /chat/completions endpoint. Both callers use
 * response_format: { type: "json_schema", strict: true }, so this returns
 * something schema-valid for whichever schema was asked for, and nothing else.
 *
 * What is substituted here is the model's judgement, and only that. The
 * request is built by the workflow, the response is parsed, validated, gated
 * and routed by the workflow, and every one of those steps runs for real.
 * ------------------------------------------------------------------------ */
const NOT_SUPPORT_MARKERS = [
  'unsubscribe', 'newsletter', 'view this email in your browser', 'weekly digest',
  'webinar', 'press release', 'sponsorship', 'guest post', 'link building',
  'we are hiring', 'hiring', 'recruiter', 'cv attached', 'resume attached',
  'job opportunity', 'candidate', 'lucrative offer', 'crypto', 'seo services',
  'no-reply', 'noreply', 'do not reply', 'out of office', 'automatic reply',
  'standup notes', 'sprint review', 'all-hands',
];

const MONEY_MARKERS = [
  'refund', 'refunded', 'chargeback', 'charge back', 'money back', 'reimburse',
  'double charged', 'charged twice', 'overcharged', 'dispute', 'lawyer',
  'legal', 'gdpr request', 'compensation', 'invoice me', 'credit note',
];

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'to', 'of', 'in', 'on', 'for',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'i', 'my',
  'we', 'our', 'you', 'your', 'it', 'this', 'that', 'how', 'what', 'when',
  'where', 'can', 'could', 'would', 'should', 'please', 'hi', 'hello', 'thanks',
  'with', 'from', 'at', 'as', 'me', 'us', 'have', 'has', 'had', 'get', 'got',
  'there', 'their', 'so', 'not', 'no', 'yes', 'just', 'any', 'about',
]);

const terms = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ''));

function classify(text) {
  const lower = String(text || '').toLowerCase();
  const notSupport = NOT_SUPPORT_MARKERS.filter((m) => lower.includes(m));
  const money = MONEY_MARKERS.filter((m) => lower.includes(m));

  if (notSupport.length > 0) {
    return {
      is_support: false,
      intent: /hiring|recruiter|candidate|cv |resume/.test(lower)
        ? 'recruiting'
        : /unsubscribe|newsletter|digest|webinar/.test(lower)
          ? 'newsletter'
          : 'other_non_support',
      confidence: 0.94,
      touches_money: money.length > 0,
      reason: `matched non-support markers: ${notSupport.slice(0, 3).join(', ')}`,
    };
  }

  if (money.length > 0) {
    return {
      is_support: true,
      intent: 'billing_dispute',
      confidence: 0.91,
      touches_money: true,
      reason: `customer is asking about money: ${money.slice(0, 3).join(', ')}`,
    };
  }

  const question = /\?|how |where |can i|cannot|can't|does |do you|help|problem|issue|broken|not working/.test(lower);
  return {
    is_support: true,
    intent: question ? 'product_question' : 'other_support',
    confidence: question ? 0.93 : 0.66,
    touches_money: false,
    reason: question
      ? 'a customer asking a question about the product'
      : 'reads like a customer message but the ask is not clear',
  };
}

/**
 * The answer half. The workflow hands the model a JSON array of retrieved
 * passages and an instruction to answer only from them; this scores the
 * question against each passage and either answers out of the best one or
 * says it could not. Answering from outside the passages is the one thing it
 * will never do, which is the behaviour the gate downstream is built on.
 */
function answerFromPassages(question, passages, history) {
  // A real model reads the history block too, which is how it knows that "and
  // what does that cost?" is still about the free trial. Scoring against the
  // question plus the visitor's previous turn is the cheapest honest stand-in
  // for that.
  const lastVisitorTurn = [...(history || [])].reverse().find((line) => line.startsWith('visitor:'));
  const qTerms = new Set(terms(question + ' ' + (lastVisitorTurn || '')));
  let best = null;

  for (const passage of passages) {
    const pTerms = new Set(terms(`${passage.title} ${passage.passage}`));
    let overlap = 0;
    for (const t of qTerms) if (pTerms.has(t)) overlap += 1;
    const score = qTerms.size ? overlap / qTerms.size : 0;
    if (!best || score > best.score) best = { passage, score, overlap };
  }

  if (!best || best.overlap < 2) {
    return {
      answer: '',
      used_article_ids: [],
      answered_from_kb: false,
      missing_info: `Nothing in the retrieved help-centre articles covers: ${String(question).slice(0, 160)}`,
    };
  }

  const sentences = String(best.passage.passage)
    .split(/(?<=\.)\s+/)
    .filter(Boolean);
  const relevant = sentences.filter((s) => {
    const sTerms = new Set(terms(s));
    for (const t of qTerms) if (sTerms.has(t)) return true;
    return false;
  });
  const chosen = (relevant.length ? relevant : sentences).slice(0, 3).join(' ');

  return {
    answer: chosen,
    used_article_ids: [best.passage.id],
    answered_from_kb: true,
    missing_info: '',
  };
}

function chatCompletions(req, res, body) {
  const schemaName = body?.response_format?.json_schema?.name || 'unknown';
  log('llm.chat.completions', { schema: schemaName, model: body?.model });

  const garbage = takeInjection('llm_garbage');
  if (garbage) {
    // A provider's HTML error page, served with 200 and text/html, is a real
    // failure mode and it is the one retries cannot fix.
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<html><head><title>502 Bad Gateway</title></head><body>upstream connect error</body></html>');
  }

  const forced = takeInjection('llm');
  if (forced) {
    return send(res, forced.status, { error: { message: 'injected model outage', type: 'server_error' } });
  }

  const messages = body?.messages || [];
  const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  state.llm.push({ schema: schemaName, user: user.slice(0, 2000), at: new Date().toISOString() });

  let payload;
  if (schemaName === 'support_classification') {
    payload = classify(user);
  } else if (schemaName === 'kb_answer') {
    // The workflow sends the passages as a fenced JSON array. Parsing them back
    // out is what makes "answer only from these" testable rather than a claim.
    let passages = [];
    const block = /<passages>([\s\S]*?)<\/passages>/.exec(user);
    if (block) {
      try {
        passages = JSON.parse(block[1]);
      } catch {
        passages = [];
      }
    }
    const question = (/<question>([\s\S]*?)<\/question>/.exec(user) || [, user])[1];
    const historyBlock = (/<history>([\s\S]*?)<\/history>/.exec(user) || [, ''])[1];
    payload = answerFromPassages(question, passages, historyBlock.split('\n').filter(Boolean));
  } else {
    return send(res, 400, { error: { message: `mock model: unknown json_schema "${schemaName}"` } });
  }

  return send(res, 200, {
    id: `chatcmpl-mock-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body?.model || 'mock-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(payload) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

/* --------------------------------------------------------------------------
 * Slack incoming webhooks
 * ------------------------------------------------------------------------ */
function slack(url, req, res, body) {
  const channel = url.pathname.replace(/^\/slack\/hooks\//, '');
  log('slack.post', { channel });

  const forced = takeInjection('slack');
  if (forced) return send(res, forced.status, 'server_error');

  state.slack.push({ channel, body, at: new Date().toISOString() });
  res.writeHead(200, { 'content-type': 'text/plain' });
  return res.end('ok');
}

/* --------------------------------------------------------------------------
 * Control plane - used by scripts/run-scenarios.mjs, never by n8n
 * ------------------------------------------------------------------------ */
function control(url, req, res, body) {
  const path = url.pathname.replace(/^\/__control/, '');

  if (path === '/reset' && req.method === 'POST') {
    reset();
    return send(res, 200, { ok: true });
  }

  if (path === '/inject' && req.method === 'POST') {
    const injection = {
      target: body.target,
      status: Number(body.status || 500),
      remaining: Number(body.times ?? 1),
    };
    state.injections.push(injection);
    return send(res, 200, { ok: true, injection });
  }

  if (path === '/injections/clear' && req.method === 'POST') {
    state.injections = [];
    return send(res, 200, { ok: true });
  }

  // Put a message in the mailbox. The next poll of the Gmail Trigger finds it
  // exactly as it would find a real one.
  if (path === '/gmail/deliver' && req.method === 'POST') {
    const seq = state.nextMessageSeq++;
    const id = body.id || `mockmsg-${String(seq).padStart(4, '0')}`;
    const message = {
      id,
      threadId: body.threadId || `mockthread-${String(seq).padStart(4, '0')}`,
      rfcMessageId: body.rfcMessageId || `<${id}@mail.example>`,
      from: body.from,
      to: body.to || MAILBOX_ADDRESS,
      subject: body.subject || '(no subject)',
      body: body.body || '',
      inReplyTo: body.inReplyTo || null,
      references: body.references || null,
      labelIds: body.labelIds || ['INBOX', 'UNREAD'],
      internalDate: String(body.internalDate || Date.now()),
      sent: false,
    };
    state.messages.set(id, message);
    return send(res, 200, { ok: true, id: message.id, threadId: message.threadId });
  }

  if (path === '/state' && req.method === 'GET') {
    return send(res, 200, {
      messages: [...state.messages.values()],
      sent: state.sent,
      modified: state.modified,
      slack: state.slack,
      llm: state.llm,
      calls: state.calls,
      injections: state.injections,
    });
  }

  return send(res, 404, { error: `control: no route for ${req.method} ${path}` });
}

/* --------------------------------------------------------------------------
 * Dispatch
 * ------------------------------------------------------------------------ */
async function handle(req, res) {
  const url = new URL(req.url, 'http://mock.local');
  const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req);

  try {
    if (url.pathname.startsWith('/__control')) return control(url, req, res, body);
    if (url.pathname.startsWith('/gmail/v1/')) return gmail(url, req, res, body);
    if (url.pathname === '/token') return googleToken(req, res);
    if (url.pathname === '/llm/v1/chat/completions') return chatCompletions(req, res, body);
    if (url.pathname.startsWith('/slack/hooks/')) return slack(url, req, res, body);
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    return send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
  } catch (err) {
    return send(res, 500, { error: String(err && err.message) });
  }
}

http.createServer(handle).listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[mock] http  :${HTTP_PORT}  model | slack | control`);
});

const keyPath = `${TLS_DIR}/mock.key`;
const certPath = `${TLS_DIR}/mock.crt`;
if (existsSync(keyPath) && existsSync(certPath)) {
  https
    .createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, handle)
    .listen(TLS_PORT, '0.0.0.0', () => {
      console.log(`[mock] https :${TLS_PORT} gmail api + google oauth token (self-signed)`);
    });
} else {
  console.warn(`[mock] no certificate in ${TLS_DIR} - the Gmail listener is disabled`);
}

/**
 * Structural checks on every workflow in workflows/.
 *
 * These catch the mistakes that only show up after you have imported a file
 * into a live instance: a connection pointing at a node that was renamed, an
 * outbound call with no retry, an error output wired to nothing, a workflow
 * with no error workflow set, an ON CONFLICT with no matching unique index, a
 * credential id copied out of someone else's instance, a secret pasted into a
 * parameter, an $env var the container is never given.
 *
 * It also holds the three decisions this desk is actually built on, because
 * they are the ones that would be quietly softened in six months' time: the
 * confidence gate keeps all four of its conditions, non-support mail is
 * labelled rather than dropped, and the answer engine cannot cite an article it
 * did not retrieve.
 *
 *   node --test test/validate.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_DIR = join(ROOT, 'workflows');

const FILES = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.json')).sort();

const SCHEMA = readFileSync(join(ROOT, 'sql/schema.sql'), 'utf8');
const COMPOSE = readFileSync(join(ROOT, 'infra/docker-compose.yml'), 'utf8');
const ENV_EXAMPLE = readFileSync(join(ROOT, 'infra/.env.example'), 'utf8');

const EMAIL_AGENT = '01-email-support-agent.json';
const CHAT_AGENT = '02-live-chat-agent.json';
const ANSWER_ENGINE = '03-answer-engine.json';
const ERROR_WORKFLOW = '04-error-trigger-alerts.json';

/** 04 is the error workflow. Pointing it at itself would loop on its own failures. */
const NO_ERROR_WORKFLOW = new Set([ERROR_WORKFLOW]);

const TRIGGER_TYPES = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.executeWorkflowTrigger',
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.gmailTrigger',
]);

/** Node types that make a call to somebody else's server. */
const OUTBOUND_TYPES = new Set(['n8n-nodes-base.httpRequest', 'n8n-nodes-base.gmail']);

const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9]{20,}/, 'OpenAI API key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bya29\.[A-Za-z0-9_-]{20,}/, 'Google OAuth access token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, 'JWT'],
  [/"(password|apiKey|api_key|token|secret|clientSecret)"\s*:\s*"(?!=?\{\{)[^"{}\s]{8,}"/i, 'literal credential value'],
];

const raw = new Map();
const parsed = new Map();

for (const file of FILES) {
  raw.set(file, readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
  parsed.set(file, JSON.parse(raw.get(file)));
}

const wf = (file) => parsed.get(file);
const nodeNamed = (file, name) => wf(file).nodes.find((n) => n.name === name);
const allQueries = (file) =>
  wf(file).nodes.filter((n) => n.type === 'n8n-nodes-base.postgres').map((n) => n.parameters.query);

/* ------------------------------------------------------------------ shape */

test('there are four workflow files', () => {
  assert.equal(FILES.length, 4, `expected 4 workflows, found ${FILES.length}: ${FILES.join(', ')}`);
  assert.deepEqual(FILES, [EMAIL_AGENT, CHAT_AGENT, ANSWER_ENGINE, ERROR_WORKFLOW]);
});

for (const file of FILES) {
  test(`${file}: parses as JSON with the keys n8n expects`, () => {
    const w = wf(file);
    assert.equal(typeof w.name, 'string');
    assert.ok(w.name.length > 0, 'name must not be empty');
    assert.ok(Array.isArray(w.nodes) && w.nodes.length > 0, 'nodes must be a non-empty array');
    assert.equal(typeof w.connections, 'object');
    assert.equal(typeof w.settings, 'object');
  });

  test(`${file}: every node has the required fields`, () => {
    for (const node of wf(file).nodes) {
      const where = `node "${node.name ?? '(unnamed)'}"`;
      assert.equal(typeof node.id, 'string', `${where}: id must be a string`);
      assert.equal(typeof node.name, 'string', `${where}: name must be a string`);
      assert.match(node.type, /^n8n-nodes-base\./, `${where}: unexpected node type ${node.type}`);
      assert.equal(typeof node.typeVersion, 'number', `${where}: typeVersion must be a number`);
      assert.ok(Array.isArray(node.position) && node.position.length === 2, `${where}: position must be [x, y]`);
      assert.equal(typeof node.parameters, 'object', `${where}: parameters must be an object`);
    }
  });

  test(`${file}: node names and ids are unique`, () => {
    const names = wf(file).nodes.map((n) => n.name);
    assert.deepEqual(
      names.filter((n, i) => names.indexOf(n) !== i),
      [],
      'connections are keyed by name, so names must be unique',
    );
    const ids = wf(file).nodes.map((n) => n.id);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'duplicate node ids');
  });

  test(`${file}: every connection points at a node that exists`, () => {
    const names = new Set(wf(file).nodes.map((n) => n.name));
    for (const [source, outputs] of Object.entries(wf(file).connections)) {
      assert.ok(names.has(source), `connections key "${source}" is not a node in this workflow`);
      for (const branch of outputs.main ?? []) {
        for (const link of branch ?? []) {
          assert.ok(names.has(link.node), `"${source}" connects to "${link.node}", which does not exist`);
          assert.equal(link.type, 'main', `"${source}" -> "${link.node}": type must be "main"`);
          assert.equal(typeof link.index, 'number', `"${source}" -> "${link.node}": index missing`);
        }
      }
    }
  });

  test(`${file}: has exactly one trigger and no unreachable nodes`, () => {
    const w = wf(file);
    const triggers = w.nodes.filter((n) => TRIGGER_TYPES.has(n.type));
    assert.equal(triggers.length, 1, `expected one trigger, found ${triggers.length}`);

    const reached = new Set([triggers[0].name]);
    const queue = [triggers[0].name];
    while (queue.length) {
      for (const branch of w.connections[queue.shift()]?.main ?? []) {
        for (const link of branch ?? []) {
          if (!reached.has(link.node)) {
            reached.add(link.node);
            queue.push(link.node);
          }
        }
      }
    }
    assert.deepEqual(
      w.nodes.map((n) => n.name).filter((n) => !reached.has(n)),
      [],
      'nodes not reachable from the trigger - a dangling branch',
    );
  });

  /* ------------------------------------------------------- error handling */

  test(`${file}: every outbound call retries and routes its errors somewhere`, () => {
    const w = wf(file);
    for (const node of w.nodes.filter((n) => OUTBOUND_TYPES.has(n.type))) {
      const where = `"${node.name}"`;
      assert.equal(node.retryOnFail, true, `${where}: retryOnFail must be true`);
      assert.ok(Number.isInteger(node.maxTries) && node.maxTries >= 3, `${where}: maxTries must be at least 3`);
      assert.ok(
        Number.isInteger(node.waitBetweenTries) && node.waitBetweenTries >= 1000,
        `${where}: waitBetweenTries must be at least 1000ms - an immediate retry hits the same failure`,
      );
      assert.equal(
        node.onError,
        'continueErrorOutput',
        `${where}: onError must route to the error output, not stop the workflow silently`,
      );

      const errorBranch = w.connections[node.name]?.main?.[1] ?? [];
      assert.ok(errorBranch.length > 0, `${where}: has an error output with nothing wired to it`);
    }
  });

  test(`${file}: every error output leads to a node that records the failure`, () => {
    const w = wf(file);
    // A node that swallows an error and carries on as if nothing happened is
    // worse than one that fails: the execution is green and the customer is
    // gone. Every error branch here must reach, within a few hops, either a
    // Postgres write or a Code node that sets integration_error / an
    // alert_delivered flag for one.
    const recordsFailure = (name) => {
      const node = nodeNamed(file, name);
      if (!node) return false;
      if (node.type === 'n8n-nodes-base.postgres') return true;
      if (node.type !== 'n8n-nodes-base.code') return false;
      return /integration_error|alert_delivered|error\b/.test(node.parameters.jsCode ?? '');
    };

    for (const node of w.nodes.filter((n) => n.onError === 'continueErrorOutput')) {
      const targets = (w.connections[node.name]?.main?.[1] ?? []).map((l) => l.node);
      const seen = new Set(targets);
      const queue = [...targets];
      let found = false;
      let hops = 0;
      while (queue.length && hops < 6 && !found) {
        const current = queue.shift();
        hops += 1;
        if (recordsFailure(current)) {
          found = true;
          break;
        }
        for (const branch of w.connections[current]?.main ?? []) {
          for (const link of branch ?? []) {
            if (!seen.has(link.node)) {
              seen.add(link.node);
              queue.push(link.node);
            }
          }
        }
      }
      assert.ok(found, `"${node.name}": its error output never reaches anything that records the failure`);
    }
  });

  test(`${file}: no node both routes errors and always outputs data`, () => {
    // Found by running these workflows, not by reading them. `alwaysOutputData`
    // makes a node emit an empty item when it produced none - including when it
    // has just failed. Combined with `onError: continueErrorOutput` the failure
    // goes down BOTH outputs: the error branch records it, and the success
    // branch carries on with an empty item. Here that would mean replying to a
    // customer with an empty answer while also filing a handover ticket.
    for (const node of wf(file).nodes) {
      if (node.onError !== 'continueErrorOutput') continue;
      assert.notEqual(
        node.alwaysOutputData,
        true,
        `"${node.name}": alwaysOutputData with continueErrorOutput sends a failure down the success branch too`,
      );
    }
  });

  test(`${file}: Postgres nodes retry and are allowed to fail the execution`, () => {
    for (const node of wf(file).nodes.filter((n) => n.type === 'n8n-nodes-base.postgres')) {
      const where = `"${node.name}"`;
      assert.equal(node.retryOnFail, true, `${where}: retryOnFail must be true`);
      assert.ok(Number.isInteger(node.maxTries) && node.maxTries >= 2, `${where}: maxTries must be at least 2`);
      // Deliberately the opposite rule to an HTTP call. A database failure must
      // fail the execution: carrying on past a failed idempotency claim is how
      // a customer gets two replies, and carrying on past a failed decision
      // write is how an action happens with no record of it.
      assert.notEqual(
        node.onError,
        'continueErrorOutput',
        `${where}: a Postgres failure must fail the execution, not be routed around`,
      );
    }
  });

  /* ------------------------------------------------------------- settings */

  test(`${file}: settings are production settings`, () => {
    const s = wf(file).settings;
    assert.equal(s.executionOrder, 'v1', 'executionOrder must be v1 - v0 runs branches in an unpredictable order');
    assert.equal(s.saveDataErrorExecution, 'all', 'failed execution data must be kept, or there is nothing to debug');

    if (NO_ERROR_WORKFLOW.has(file)) {
      assert.equal(s.errorWorkflow, undefined, 'the error workflow must not point at itself');
    } else {
      assert.equal(typeof s.errorWorkflow, 'string', 'settings.errorWorkflow must be set so failures reach workflow 04');
      assert.ok(s.errorWorkflow.length > 0, 'settings.errorWorkflow must not be empty');
    }
  });

  test(`${file}: no secrets and no hard-coded endpoints`, () => {
    const text = raw.get(file);
    for (const [pattern, label] of SECRET_PATTERNS) {
      const hit = text.match(pattern);
      assert.equal(hit, null, `looks like a ${label} was committed: ${hit?.[0]?.slice(0, 24)}`);
    }
    // Every external call must go through {{ $env.X }} so the same file can be
    // imported into staging and production without editing node parameters.
    // (docs.n8n.io links inside a node's notes are documentation, not endpoints.)
    const literalUrls = (text.match(/https?:\\?\/\\?\/[^"\\\s]+/g) ?? []).filter(
      (url) => !url.includes('docs.n8n.io') && !url.includes('developers.google.com'),
    );
    assert.deepEqual(literalUrls, [], 'hard-coded URL - use {{ $env.SOMETHING }} instead');
  });

  test(`${file}: credentials are placeholders, not ids from another instance`, () => {
    for (const node of wf(file).nodes) {
      for (const [type, cred] of Object.entries(node.credentials ?? {})) {
        const where = `"${node.name}" (${type})`;
        assert.equal(cred.id, null, `${where}: credential id must be null, not an instance id`);
        assert.equal(typeof cred.name, 'string', `${where}: credential name missing`);
        assert.ok(cred.name.length > 0, `${where}: credential name is empty`);
      }
    }
  });
}

/* ------------------------------------------------------- cross-file wiring */

test('webhook paths are unique across the kit', () => {
  const seen = new Map();
  for (const file of FILES) {
    for (const node of wf(file).nodes) {
      if (node.type !== 'n8n-nodes-base.webhook') continue;
      const path = node.parameters.path;
      assert.ok(path, `"${node.name}" in ${file} has no webhook path`);
      assert.ok(!seen.has(path), `webhook path "${path}" is used by both ${seen.get(path)} and ${file}`);
      seen.set(path, file);
    }
  }
});

test('both channels call the SAME answer engine, by placeholder', () => {
  // The brief's "connected to the same backend" is this assertion. If either
  // workflow ever grows its own copy of the answering logic, this fails.
  for (const file of [EMAIL_AGENT, CHAT_AGENT]) {
    const calls = wf(file).nodes.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow');
    assert.equal(calls.length, 1, `${file}: expected exactly one Execute Workflow node, found ${calls.length}`);
    assert.equal(
      calls[0].parameters.workflowId?.value,
      'REPLACE_WITH_ANSWER_ENGINE_ID',
      `${file}: the sub-workflow id must ship as a placeholder, not as an id from someone's instance`,
    );
    assert.equal(calls[0].parameters.options?.waitForSubWorkflow, true,
      `${file}: the caller must wait for the answer, or it gates on nothing`);
  }

  // And neither of them may call a model directly for answering: the only LLM
  // call outside the engine is the email classifier.
  const chatLlm = wf(CHAT_AGENT).nodes.filter((n) => /chat\/completions/.test(n.parameters?.url ?? ''));
  assert.deepEqual(chatLlm.map((n) => n.name), [], 'the chat workflow must not call a model of its own');
});

test('every $env var the workflows read is passed to the container and documented', () => {
  const used = new Set();
  for (const file of FILES) {
    for (const match of raw.get(file).matchAll(/\$env\.([A-Z0-9_]+)/g)) used.add(match[1]);
  }
  assert.ok(used.size >= 8, `expected the workflows to read several env vars, found ${used.size}`);

  for (const name of [...used].sort()) {
    assert.match(
      COMPOSE,
      new RegExp(`^\\s+${name}:\\s`, 'm'),
      `$env.${name} is read by a workflow but never passed to the n8n container in infra/docker-compose.yml`,
    );
    assert.match(
      ENV_EXAMPLE,
      new RegExp(`^${name}=`, 'm'),
      `$env.${name} is read by a workflow but not documented in infra/.env.example`,
    );
  }
});

/* ------------------------------------------------------------------- SQL */

/** Every table and view sql/schema.sql defines. */
const SCHEMA_TABLES = new Set([
  ...[...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)].map((m) => m[1]),
  ...[...SCHEMA.matchAll(/CREATE OR REPLACE VIEW\s+(\w+)/g)].map((m) => m[1]),
]);

/** table -> [ 'col', 'col_a,col_b', ... ] for every unique key it has. */
const UNIQUE_KEYS = (() => {
  const keys = new Map();
  const add = (table, cols) => {
    const normalised = cols.split(',').map((c) => c.trim().replace(/"/g, '')).sort().join(',');
    if (!keys.has(table)) keys.set(table, new Set());
    keys.get(table).add(normalised);
  };

  for (const match of SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const [, table, body] = match;
    for (const line of body.split('\n')) {
      const constraint = /CONSTRAINT\s+\w+\s+UNIQUE\s*\(([^)]+)\)/i.exec(line);
      if (constraint) add(table, constraint[1]);
      const inline = /^\s*(\w+)\s+[\w()]+.*\b(UNIQUE|PRIMARY KEY)\b/i.exec(line);
      if (inline) add(table, inline[1]);
    }
  }
  for (const match of SCHEMA.matchAll(/CREATE UNIQUE INDEX IF NOT EXISTS\s+\w+\s+ON\s+(\w+)\s*\(([^)]+)\)/g)) {
    add(match[1], match[2]);
  }
  return keys;
})();

test('sql/schema.sql defines the tables the brief names', () => {
  for (const table of [
    'articles',
    'processed_messages',
    'support_decisions',
    'chat_sessions',
    'chat_messages',
    'human_review_queue',
    'unanswered_questions',
    'failures',
  ]) {
    assert.ok(SCHEMA_TABLES.has(table), `sql/schema.sql has no table "${table}"`);
  }
});

test('the knowledge base is searchable, not just stored', () => {
  assert.match(SCHEMA, /search_tsv\s+tsvector GENERATED ALWAYS AS/,
    'articles.search_tsv must be a generated column, so it cannot drift out of sync with the text');
  assert.match(SCHEMA, /USING gin \(search_tsv\)/,
    'a GIN index on search_tsv, or every question is a sequential scan of the knowledge base');
  assert.match(SCHEMA, /setweight\(to_tsvector\('english', coalesce\(title/,
    'the title must be weighted above the body, or ts_rank cannot tell a subject from a mention');
  assert.ok(
    (SCHEMA.match(/^\('/gm) ?? []).length >= 10,
    'at least ten seeded articles, or there is nothing for retrieval to find',
  );
});

test('every table a query touches exists in sql/schema.sql', () => {
  for (const file of FILES) {
    for (const query of allQueries(file)) {
      // Comments in these queries explain the constraint they rely on, and they
      // use the words UPDATE and FROM in prose. Strip them before parsing, or
      // the check reports that a table called "rather" is missing.
      const sql = query.replace(/^\s*--.*$/gm, '');
      const ctes = new Set([...sql.matchAll(/\b(?:WITH|,)\s+(\w+)\s+AS\s*\(/g)].map((m) => m[1]));
      const referenced = [
        ...[...sql.matchAll(/INSERT INTO\s+(\w+)/g)].map((m) => m[1]),
        ...[...sql.matchAll(/\bUPDATE\s+(\w+)\s+SET\b/g)].map((m) => m[1]),
        ...[...sql.matchAll(/FROM\s+(?!\()(\w+)/g)].map((m) => m[1]),
      ].filter((t) => !ctes.has(t));

      for (const table of referenced) {
        assert.ok(SCHEMA_TABLES.has(table), `${file}: a query reads or writes "${table}", which is not in sql/schema.sql`);
      }
    }
  }
});

test('every ON CONFLICT target matches a real unique key', () => {
  let checked = 0;
  for (const file of FILES) {
    for (const query of allQueries(file)) {
      const target = /INSERT INTO\s+(\w+)/.exec(query);
      for (const match of query.matchAll(/ON CONFLICT\s*\(([^)]+)\)/g)) {
        checked += 1;
        const table = target[1];
        const cols = match[1].split(',').map((c) => c.trim()).sort().join(',');
        const keys = UNIQUE_KEYS.get(table) ?? new Set();
        assert.ok(
          keys.has(cols),
          `${file}: ON CONFLICT (${cols}) on ${table}, but ${table} has no unique key on those columns ` +
            `(it has: ${[...keys].join(' | ') || 'none'}). Postgres rejects this at runtime, not at import.`,
        );
      }
    }
  }
  assert.ok(checked >= 4, `expected several ON CONFLICT guards, found ${checked}`);
});

test('idempotency guards insert and check in one statement, never SELECT-then-INSERT', () => {
  const guards = [
    [EMAIL_AGENT, 'Claim This Message', 'processed_messages', 'gmail_message_id'],
    [EMAIL_AGENT, 'Queue For A Human', 'human_review_queue', 'decision_key'],
    [CHAT_AGENT, 'Queue For A Human', 'human_review_queue', 'decision_key'],
  ];

  for (const [file, name, table, column] of guards) {
    const node = nodeNamed(file, name);
    assert.ok(node, `${file}: no node called "${name}"`);
    const query = node.parameters.query;

    assert.match(query, new RegExp(`INSERT INTO\\s+${table}`), `${file}/${name}: the guard must INSERT`);
    assert.match(query, new RegExp(`ON CONFLICT \\(${column}\\) DO NOTHING`), `${file}/${name}`);
    assert.match(query, /RETURNING/, `${file}/${name}: it must return rows so a duplicate is detectable`);
    assert.equal(
      node.alwaysOutputData,
      true,
      `${file}/${name}: without alwaysOutputData a duplicate emits nothing, the branch ends silently and nothing downstream runs`,
    );
  }

  // The inverse rule: no workflow may check for a row and then write it.
  for (const file of FILES) {
    for (const query of allQueries(file)) {
      if (!/INSERT INTO/.test(query)) continue;
      assert.ok(
        !/SELECT count\(\*\).*EXISTS/is.test(query),
        `${file}: a guard that SELECTs before it INSERTs has a window two concurrent deliveries fit through`,
      );
    }
  }
});

/* ------------------------------------------------- the decisions that matter */

test('the confidence gate still checks all four conditions, ANDed', () => {
  for (const file of [EMAIL_AGENT, CHAT_AGENT]) {
    const gate = nodeNamed(file, 'Confidence Gate');
    assert.ok(gate, `${file}: no Confidence Gate node`);
    assert.equal(gate.type, 'n8n-nodes-base.if');

    const conditions = gate.parameters.conditions.conditions;
    assert.equal(gate.parameters.conditions.combinator, 'and', `${file}: the gate must AND its conditions, not OR them`);
    assert.equal(conditions.length, 4, `${file}: the gate must keep all four conditions`);

    const text = JSON.stringify(conditions);
    assert.match(text, /\$json\.grounded/, `${file}: the gate must require a grounded answer`);
    assert.match(text, /\$json\.answer/, `${file}: the gate must require a non-empty answer`);
    assert.match(text, /SUPPORT_CONFIDENCE_THRESHOLD/, `${file}: the threshold must come from the environment`);
    assert.match(text, /\$json\.touches_money/, `${file}: the gate must refuse anything that touches money`);

    const moneyCondition = conditions.find((c) => /touches_money/.test(c.leftValue));
    assert.equal(moneyCondition.operator.operation, 'false',
      `${file}: the money condition must require touches_money to be FALSE`);

    const confidenceCondition = conditions.find((c) => /SUPPORT_CONFIDENCE_THRESHOLD/.test(c.rightValue ?? ''));
    assert.equal(confidenceCondition.operator.operation, 'gte',
      `${file}: confidence must be at or above the threshold, not merely near it`);
  }
});

test('the deterministic keyword sweep can only add caution, never remove it', () => {
  const sweep = nodeNamed(EMAIL_AGENT, 'Apply Keyword Sweep');
  assert.ok(sweep, 'workflow 01 has no Apply Keyword Sweep node');
  const code = sweep.parameters.jsCode;

  // touches_money must be an OR of the model's answer and the keyword hits, so
  // a confidently-worded refund request cannot talk its way past the gate.
  assert.match(
    code,
    /touches_money:\s*parsed\.touches_money === true \|\| email\.keyword_money \|\| email\.keyword_legal/,
    'touches_money must be OR-ed with the keyword hits, never taken from the model alone',
  );
  assert.match(code, /Math\.min\(confidence,/, 'the sweep may cap confidence but never raise it');
  assert.ok(!/Math\.max\(confidence,/.test(code), 'nothing in the sweep may raise the confidence the model returned');
});

test('non-support mail is labelled and logged, never dropped', () => {
  const w = wf(EMAIL_AGENT);
  const branch = w.connections['Is This A Support Request?'].main[1].map((l) => l.node);
  assert.deepEqual(branch, ['Label As Not Support'], 'the not-support branch must go somewhere, and that somewhere is a label');

  const label = nodeNamed(EMAIL_AGENT, 'Label As Not Support');
  assert.equal(label.type, 'n8n-nodes-base.gmail');
  assert.equal(label.parameters.operation, 'addLabels');
  assert.match(label.parameters.labelIds, /GMAIL_NOT_SUPPORT_LABEL_ID/);

  // Both of its outputs - success and failure - must reach the decision log, so
  // "routed out" is always recorded and always reversible.
  const after = w.connections['Label As Not Support'].main;
  assert.equal(after.length, 2, 'the label node must wire both of its outputs');
  for (const output of after) {
    assert.deepEqual(output.map((l) => l.node), ['Build Decision (Routed Out)']);
  }

  const decision = nodeNamed(EMAIL_AGENT, 'Build Decision (Routed Out)').parameters.jsCode;
  assert.match(decision, /action:\s*'routed_out_not_support'/);
  assert.match(decision, /inbound_text:/, 'the routed-out row must keep the message, or the decision cannot be reviewed');

  // And it must never reach the reply node.
  const reachable = (from) => {
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length) {
      for (const output of w.connections[queue.shift()]?.main ?? []) {
        for (const link of output ?? []) {
          if (!seen.has(link.node)) {
            seen.add(link.node);
            queue.push(link.node);
          }
        }
      }
    }
    return seen;
  };
  assert.ok(
    !reachable('Label As Not Support').has('Reply In The Same Thread'),
    'there must be no path from the not-support branch to the reply node',
  );
});

test('the reply goes back into the same thread, with the headers real mail clients use', () => {
  const reply = nodeNamed(EMAIL_AGENT, 'Reply In The Same Thread');
  assert.ok(reply, 'workflow 01 has no reply node');
  assert.equal(reply.type, 'n8n-nodes-base.gmail');
  assert.equal(reply.parameters.operation, 'reply',
    'operation must be "reply": it is what makes Gmail send with the original threadId and quote its Message-ID ' +
    'in In-Reply-To and References. A "send" with the same subject looks threaded in Gmail and is a new thread everywhere else.');
  assert.match(reply.parameters.messageId, /\$json\.gmail_message_id/,
    'the reply must be keyed on the Gmail message id captured by the trigger');

  // The trigger's four named fields have to be visible in one place.
  const capture = nodeNamed(EMAIL_AGENT, 'Capture Email Fields').parameters.jsCode;
  for (const field of ['sender', 'subject', 'body', 'thread_id', 'gmail_message_id', 'rfc_message_id']) {
    // `sender,` is the shorthand property form of `sender: sender`, so both
    // spellings count as emitting the field.
    assert.match(capture, new RegExp(`^\\s+${field}[,:]`, 'm'), `Capture Email Fields does not emit "${field}"`);
  }
});

test('the answer engine can only answer from what it retrieved', () => {
  const validate = nodeNamed(ANSWER_ENGINE, 'Validate Answer').parameters.jsCode;

  // The model's citations are filtered against the ids that were actually
  // retrieved. A prompt is a request; this is the enforcement.
  assert.match(validate, /retrievedIds\s*=\s*\(context\.passages \|\| \[\]\)\.map/);
  assert.match(validate, /usedIds\s*=\s*citedIds\.filter\(\(articleId\) => retrievedIds\.includes\(articleId\)\)/,
    'cited article ids must be filtered against the retrieved ids');
  assert.match(validate, /grounded\s*=\s*parsed\.answered_from_kb === true && answerText\.length > 0 && usedIds\.length > 0/,
    'an answer with no surviving citation is not grounded, whatever the model said about itself');

  // And the model is given the passages and nothing else to work from.
  const call = nodeNamed(ANSWER_ENGINE, 'Answer From Passages');
  assert.match(call.parameters.jsonBody, /<passages>/, 'the passages must be in the prompt');
  assert.match(call.parameters.jsonBody, /answer ONLY from the help-centre passages/,
    'the system prompt must say so too - belt as well as braces');
  assert.match(call.parameters.jsonBody, /"strict": true/, 'the response schema must be strict');
  assert.match(call.parameters.jsonBody, /"type": "json_schema"/);
});

test('retrieval ORs its terms and applies a floor from the environment', () => {
  const retrieve = nodeNamed(ANSWER_ENGINE, 'Retrieve Passages').parameters.query;
  assert.match(retrieve, /plainto_tsquery/, 'the query must be built through plainto_tsquery, which sanitises it');
  assert.match(retrieve, /replace\(plainto_tsquery\('english', \$1\)::text, '&', '\|'\)/,
    "ANDing every word means one unusual word excludes the article that answers the question");
  assert.match(retrieve, /ts_rank/, 'results must be ranked, or an OR query is noise');
  assert.match(retrieve, /LIMIT \$2::int/, 'top-k must come from KB_TOP_K, not be hard-coded');

  const floor = nodeNamed(ANSWER_ENGINE, 'Apply Relevance Floor').parameters.jsCode;
  assert.match(floor, /\$env\.KB_RELEVANCE_FLOOR/);
  assert.match(floor, /has_context: passages\.length > 0/);

  assert.equal(
    nodeNamed(ANSWER_ENGINE, 'Retrieve Passages').alwaysOutputData,
    true,
    'a question that matched nothing must still emit an item, or the missing-knowledge branch never runs',
  );
});

test('a missing answer is written down as a knowledge gap, not swallowed', () => {
  const record = nodeNamed(ANSWER_ENGINE, 'Record Unanswered Question');
  assert.ok(record, 'the answer engine has no Record Unanswered Question node');
  assert.match(record.parameters.query, /INSERT INTO unanswered_questions/);
  assert.match(record.parameters.query, /ON CONFLICT \(question_hash\) DO UPDATE/,
    'the same question asked fifty times must be one row with a counter, not fifty rows');
  assert.match(record.parameters.query, /asked_count\s*=\s*unanswered_questions\.asked_count \+ 1/);
  assert.match(record.parameters.query, /WHERE \$5 IN \('no_matching_article', 'not_answerable_from_kb'\)/,
    'a model outage is not a knowledge gap and must not be filed as one');
  assert.equal(record.alwaysOutputData, true, 'the INSERT ... SELECT ... WHERE can write no row, and the branch must continue');

  // All three ungrounded reasons must be distinguishable in the returned contract.
  for (const name of [
    'Result: No Article Matched',
    'Result: Not Answerable From The Knowledge Base',
    'Result: Answer Engine Unavailable',
  ]) {
    const node = nodeNamed(ANSWER_ENGINE, name);
    assert.ok(node, `the answer engine has no "${name}" node`);
    assert.match(node.parameters.jsCode, /escalate_reason:\s*'[a-z_]+'/, `${name}: must set a distinct escalate_reason`);
    assert.match(node.parameters.jsCode, /grounded:\s*false/, `${name}: must return grounded: false`);
  }
});

test('the chat webhook authenticates in constant time before any side effect', () => {
  const w = wf(CHAT_AGENT);
  const webhook = w.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
  const next = w.connections[webhook.name].main[0][0].node;
  assert.equal(next, 'Verify Shared Secret', 'the webhook must feed the secret check first, before any write');

  const code = nodeNamed(CHAT_AGENT, 'Verify Shared Secret').parameters.jsCode;
  assert.match(code, /crypto\.timingSafeEqual/, 'the secret must be compared in constant time');
  assert.match(code, /\$env\.CHAT_WEBHOOK_SECRET/);
  assert.match(code, /\^\[A-Za-z0-9_-\]\{8,128\}\$/, 'the session id arrives from a browser and must be shape-checked');
});

test('the chat workflow answers in the webhook response, not asynchronously', () => {
  const w = wf(CHAT_AGENT);
  const webhook = w.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
  assert.equal(webhook.parameters.responseMode, 'responseNode',
    'responseMode must be responseNode - "onReceived" answers 200 before the agent has said anything');

  const responder = w.nodes.find((n) => n.type === 'n8n-nodes-base.respondToWebhook');
  assert.ok(responder, 'there must be a Respond to Webhook node');
  assert.match(responder.parameters.responseBody, /reply:/, 'the response body must carry the reply');

  // And the visitor must not be made to wait on the bookkeeping.
  const afterResponse = (w.connections[responder.name]?.main?.[0] ?? []).map((l) => l.node);
  assert.ok(afterResponse.length > 0, 'logging and persistence must happen after the response, not before it');
});

test('both turns of a chat are persisted in one statement', () => {
  const persist = nodeNamed(CHAT_AGENT, 'Persist Both Turns');
  assert.match(persist.parameters.query, /INSERT INTO chat_messages/);
  assert.match(persist.parameters.query, /'visitor'[\s\S]*'agent'/,
    'the question and the answer must be written together, or a crash between them leaves a transcript that lies');
});

test('the error workflow records the failure whether or not Slack accepted it', () => {
  const w = wf(ERROR_WORKFLOW);
  const alert = w.nodes.find((n) => n.type === 'n8n-nodes-base.httpRequest');
  const outputs = w.connections[alert.name].main;
  assert.equal(outputs.length, 2, 'the alert node must wire both outputs');
  assert.deepEqual(outputs[0].map((l) => l.node), ['Record Failure']);
  assert.deepEqual(outputs[1].map((l) => l.node), ['Record Failure']);

  const record = nodeNamed(ERROR_WORKFLOW, 'Record Failure');
  assert.match(record.parameters.query, /INSERT INTO failures/);
  assert.match(record.parameters.query, /alert_delivered/, 'the row must record whether the alert landed');
  assert.match(record.parameters.query, /ON CONFLICT \(execution_id\) WHERE execution_id IS NOT NULL DO NOTHING/,
    'a repeated Error Trigger delivery must not create a second row, and a manual failure has no id to deduplicate on');

  const format = nodeNamed(ERROR_WORKFLOW, 'Format Alert').parameters.jsCode;
  for (const field of ['workflow_name', 'failed_node', 'error_message', 'execution_url', 'input_excerpt']) {
    assert.match(format, new RegExp(`${field}:`), `the alert must name the ${field.replace('_', ' ')}`);
  }
});

test('the widget is one self-contained file that reads its endpoint from the tag', () => {
  const widget = readFileSync(join(ROOT, 'widget/chat-widget.js'), 'utf8');
  assert.ok(widget.length < 16_000, `the widget is ${widget.length} bytes - it is meant to be small`);
  assert.match(widget, /data-endpoint/, 'the endpoint must come from the script tag, not be baked in');
  assert.ok(!/localhost:5681/.test(widget), 'the widget must not hard-code the demo host');
  assert.match(widget, /localStorage/, 'the session id must survive a reload, or there is no conversation');
  assert.match(widget, /session_id[\s\S]{0,200}message[\s\S]{0,200}page_url/,
    'it must post the shape workflow 02 expects');
  assert.ok(!/\bimport\b|\brequire\(/.test(widget), 'no dependencies and no build step');
});

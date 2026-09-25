/**
 * Wires the imported workflows up so they can actually run.
 *
 * The files in workflows/ ship with `"id": null` on every credential, the
 * placeholder REPLACE_WITH_WORKFLOW_04_ID as the error workflow and
 * REPLACE_WITH_ANSWER_ENGINE_ID on the two Execute Workflow nodes, because a
 * credential id or a workflow id from someone else's instance is worse than no
 * id at all. This does, over the API, exactly what docs/setup.md tells a human
 * to do by hand: create the three credentials, select them on each node, point
 * 01/02/03 at 04 as their error workflow, point 01 and 02 at 03 as the answer
 * engine, and activate all four.
 *
 * The values below are the local mock's. They are not secrets and they are not
 * meant to reach any real service. Against a real Gmail account you create the
 * Gmail credential in the UI instead - it needs a browser for the Google
 * consent screen, which is the one step no script can do for you.
 *
 *   node scripts/configure-n8n.mjs
 */
import { setupOwner, api } from './n8n-client.mjs';

const OWNER = {
  email: process.env.N8N_OWNER_EMAIL || 'demo@localhost.test',
  password: process.env.N8N_OWNER_PASSWORD || 'DemoRun-2026!x',
  firstName: 'Demo',
  lastName: 'Operator',
};

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.addons.current.action.compose',
  'https://www.googleapis.com/auth/gmail.addons.current.message.action',
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
].join(' ');

/** Credential name in the workflow files -> what to create in n8n. */
const CREDENTIALS = [
  {
    name: 'Postgres - support ops',
    type: 'postgres',
    data: {
      host: 'postgres',
      port: 5432,
      database: process.env.SUPPORT_OPS_DB || 'support_ops',
      user: process.env.POSTGRES_USER || 'n8n',
      password: process.env.POSTGRES_PASSWORD,
      ssl: 'disable',
      allowUnauthorizedCerts: false,
      maxConnections: 100,
    },
  },
  {
    name: 'LLM API Key',
    type: 'httpHeaderAuth',
    data: { name: 'Authorization', value: 'Bearer local-mock-llm-key' },
  },
  {
    // Demo only. In production this credential is created in the UI by clicking
    // "Connect my account" and completing Google's consent screen; there is no
    // way to script that, and there should not be. What is planted here is the
    // shape a completed OAuth2 credential has - a token that the demo's mock
    // Gmail endpoint accepts - so the Gmail node and Gmail Trigger run exactly
    // the code they run in production.
    name: 'Gmail - Support Inbox',
    type: 'gmailOAuth2',
    data: {
      grantType: 'authorizationCode',
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      accessTokenUrl: 'https://oauth2.googleapis.com/token',
      clientId: 'local-mock-client-id.apps.googleusercontent.com',
      clientSecret: 'local-mock-client-secret',
      scope: GMAIL_SCOPES,
      authQueryParameters: 'access_type=offline&prompt=consent',
      authentication: 'body',
      oauthTokenData: {
        access_token: 'mock-gmail-access-token',
        refresh_token: 'mock-gmail-refresh-token',
        token_type: 'Bearer',
        expires_in: 3599,
        scope: GMAIL_SCOPES,
        // n8n refreshes when this is within a minute of now. A decade out means
        // the demo never spends a request on a token round trip it does not need.
        n8n_expires_at: String(Date.now() + 10 * 365 * 24 * 3600 * 1000),
      },
    },
  },
];

const ERROR_WORKFLOW_NAME = '04 - Error Trigger Alerts';
const ANSWER_ENGINE_NAME = '03 - Answer Engine (shared backend)';

async function ensureCredentials() {
  const existing = await api('/credentials');
  const byName = new Map((existing || []).map((c) => [c.name, c]));
  const resolved = new Map();

  for (const spec of CREDENTIALS) {
    if (byName.has(spec.name)) {
      resolved.set(spec.name, byName.get(spec.name).id);
      continue;
    }
    const created = await api('/credentials', { method: 'POST', body: JSON.stringify(spec) });
    resolved.set(spec.name, created.id);
    console.log(`  credential created: ${spec.name} (${spec.type}) -> ${created.id}`);
  }
  return resolved;
}

async function main() {
  if (!process.env.POSTGRES_PASSWORD) {
    throw new Error('POSTGRES_PASSWORD is not set - run this through scripts/demo-up.sh, which sources infra/.env.demo');
  }

  const { created } = await setupOwner(OWNER);
  console.log(created ? 'owner account created' : 'owner account already existed, logged in');

  const credentialIds = await ensureCredentials();

  const list = await api('/workflows');
  const workflows = list.data ?? list;

  const errorWorkflow = workflows.find((w) => w.name === ERROR_WORKFLOW_NAME);
  if (!errorWorkflow) throw new Error(`"${ERROR_WORKFLOW_NAME}" is not imported - run the import first`);
  const answerEngine = workflows.find((w) => w.name === ANSWER_ENGINE_NAME);
  if (!answerEngine) throw new Error(`"${ANSWER_ENGINE_NAME}" is not imported - run the import first`);

  console.log(`error workflow: ${errorWorkflow.name} -> ${errorWorkflow.id}`);
  console.log(`answer engine : ${answerEngine.name} -> ${answerEngine.id}`);

  // Order matters. n8n refuses to publish a workflow whose Execute Workflow node
  // points at an unpublished sub-workflow, so the answer engine and the error
  // workflow have to be live before the two that depend on them.
  const rank = (w) => (w.id === answerEngine.id || w.id === errorWorkflow.id ? 0 : 1);
  const ordered = [...workflows].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  for (const summary of ordered) {
    const wf = await api(`/workflows/${summary.id}`);

    for (const node of wf.nodes) {
      for (const [type, cred] of Object.entries(node.credentials || {})) {
        const id = credentialIds.get(cred.name);
        if (!id) throw new Error(`no credential created for "${cred.name}" on node "${node.name}"`);
        node.credentials[type] = { id, name: cred.name };
      }

      // The sub-workflow pointer, wired the same way and for the same reason as
      // the error workflow: the file in git must not carry an id that only means
      // something on one instance.
      if (node.type === 'n8n-nodes-base.executeWorkflow') {
        const selector = node.parameters?.workflowId;
        if (selector && selector.value === 'REPLACE_WITH_ANSWER_ENGINE_ID') {
          node.parameters.workflowId = {
            __rl: true,
            value: answerEngine.id,
            mode: 'list',
            cachedResultName: answerEngine.name,
          };
        }
      }
    }

    const settings = { ...wf.settings };
    if (settings.errorWorkflow === 'REPLACE_WITH_WORKFLOW_04_ID') {
      settings.errorWorkflow = errorWorkflow.id;
    }

    await api(`/workflows/${wf.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: wf.name,
        nodes: wf.nodes,
        connections: wf.connections,
        settings,
        versionId: wf.versionId,
      }),
    });

    // Activation is its own endpoint and wants the version it is activating, so
    // that two people saving the same workflow cannot activate each other's copy.
    const saved = await api(`/workflows/${wf.id}`);
    await api(`/workflows/${wf.id}/activate`, {
      method: 'POST',
      body: JSON.stringify({ versionId: saved.versionId }),
    });

    console.log(`  ${wf.name}: credentials attached, pointers wired, activated`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

# Setup, from zero

Everything needed to take this repository and have it answering support mail and
website chat on your own accounts. It assumes no prior n8n knowledge.

The last section, [**What you still need to do after
handoff**](#what-you-still-need-to-do-after-handoff), is the short list — it is
credentials and activation, and nothing else.

---

## 0. What you will need

| Thing | Why | Cost |
|---|---|---|
| A server that can run Docker | n8n is a long-running process with a scheduler and a connection pool. It cannot be hosted on a serverless platform. | a $6–12/month VPS is plenty |
| A Google account with the support mailbox | the Gmail Trigger polls it and the reply is sent as it | free |
| A Google Cloud project | to create the OAuth client the Gmail credential uses | free |
| An OpenAI-compatible model API key | classification and answering | pennies per hundred emails on a small model |
| A Slack workspace (optional but recommended) | where handovers and failures show up | free |

Everything else — Postgres, the knowledge base, the chat widget — is in this
repository.

---

## 1. Bring the stack up

```bash
git clone <this repo>
cd n8n-support-desk/infra
cp .env.example .env
```

Open `infra/.env` and fill in, at minimum:

```bash
N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)   # paste the result in
CHAT_WEBHOOK_SECRET=$(openssl rand -hex 32)  # paste the result in
POSTGRES_PASSWORD=<something long>
N8N_PUBLIC_URL=https://n8n.yourdomain.com/   # trailing slash required
```

> **`N8N_ENCRYPTION_KEY` is the one you cannot lose.** Every credential in the
> database is encrypted with it. Lose it and they are unrecoverable; change it
> and n8n refuses to start against the existing database. Put it in your
> password manager as well as on the server.

Then:

```bash
docker compose up -d
docker compose logs -f n8n     # wait for "Editor is now accessible via"
```

`db/init/01-databases.sh` runs once, on the first boot of an empty volume: it
creates the `support_ops` database and applies `sql/schema.sql` to it, seeding
the ten example knowledge-base articles. n8n's own tables live in a separate
database in the same server, so you can drop and reload the support schema while
testing without touching credentials, executions or workflow history.

Open `http://localhost:5681` (or your public URL) and create the owner account.

**TLS.** There is deliberately no reverse proxy in `docker-compose.yml`. Put it
behind the Caddy, Traefik or nginx you already run. `WEBHOOK_URL` must be the
public HTTPS origin, or the webhook URL n8n shows you is the container's internal
address and the chat widget posts into the void.

---

## 2. Load your own knowledge base

The desk answers **only** from the `articles` table. The seeded rows are a
fictional SaaS called Harbourly; replace them with the client's real help-centre
content.

```sql
-- one row per article. slug is your key; re-running an import updates in place.
INSERT INTO articles (slug, title, category, body) VALUES
  ('shipping-times', 'How long does delivery take', 'shipping', 'Orders placed before 2pm …')
ON CONFLICT (slug) DO UPDATE
   SET title = excluded.title, category = excluded.category,
       body = excluded.body, updated_at = now();
```

Practical notes:

- **Split long pages.** One article per question answers better than one article
  per page. Retrieval returns whole rows, and a 4,000-word page dilutes the
  passage the model is asked to answer from.
- **Write the way customers write.** Retrieval is lexical: it matches words and
  their stems, not meaning. If customers say "2FA" and the article only says
  "two-factor authentication", add both.
- **`search_tsv` maintains itself.** It is a generated column, so there is no
  trigger to forget and no reindex step. Adding a row makes it searchable.
- **Check your floor.** After importing, run a few real customer questions
  through this and see what they score:

  ```sql
  SELECT id, title,
         round(ts_rank(search_tsv,
           replace(plainto_tsquery('english', 'how do I turn on 2fa')::text,'&','|')::tsquery)::numeric, 4) AS relevance
    FROM articles
   WHERE search_tsv @@ replace(plainto_tsquery('english', 'how do I turn on 2fa')::text,'&','|')::tsquery
   ORDER BY relevance DESC;
  ```

  On the seeded corpus a real match scores 0.24–0.70 and incidental word overlap
  scores 0.04, which is why `KB_RELEVANCE_FLOOR` is 0.10. Re-measure it on your
  own articles — it is corpus-specific, and so is the 0.45 normaliser in the
  answer engine's `Validate Answer` node.

---

## 3. Gmail: OAuth client, scopes, credential

### 3a. Create the OAuth client

1. <https://console.cloud.google.com> → create (or pick) a project.
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen**:
   - User type **External** (unless the mailbox is on a Google Workspace domain,
     in which case **Internal** is simpler and skips verification).
   - Fill in the app name, support email and developer email.
   - **Scopes** → *Add or remove scopes* → add these six, which are exactly what
     n8n's `gmailOAuth2` credential requests:

     ```
     https://mail.google.com/
     https://www.googleapis.com/auth/gmail.modify
     https://www.googleapis.com/auth/gmail.compose
     https://www.googleapis.com/auth/gmail.labels
     https://www.googleapis.com/auth/gmail.addons.current.action.compose
     https://www.googleapis.com/auth/gmail.addons.current.message.action
     ```

   - **Test users** → add the support mailbox address. While the app is in
     *Testing*, only listed users can authorise it and the refresh token expires
     after seven days. For anything beyond a trial, click **Publish app**.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
5. Copy the **Authorised redirect URI** out of n8n (step 3b, it is shown on the
   credential screen) and paste it into the Google client. It looks like
   `https://n8n.yourdomain.com/rest/oauth2-credential/callback`. It must match
   exactly, trailing slash and all.
6. Copy the **Client ID** and **Client secret**.

### 3b. Create the n8n credential

In n8n: **Credentials → Add credential → Gmail OAuth2 API**.

- **Name it exactly `Gmail - Support Inbox`.** The workflow files reference
  credentials by name and ship with `"id": null`, so nothing from another
  instance leaks into the repository.
- Paste the client id and secret, then **Connect my account** and complete
  Google's consent screen as the support mailbox.
- The credential is stored encrypted with `N8N_ENCRYPTION_KEY`. Nothing about it
  goes into `.env` or into git.

### 3c. Create the three Gmail labels

In Gmail, create these three labels (nesting under `Support` is just tidiness —
call them what you like):

| Label | Applied when |
|---|---|
| `Support/Not-Support` | the classifier decided it is not a support request |
| `Support/Needs-Human` | the agent declined to answer |
| `Support/Auto-Replied` | the agent answered |

Now get their **IDs** — the workflows use ids, not names, because a name here
makes the Gmail node fail at runtime rather than at import:

```bash
# Easiest route: n8n itself. Open any Gmail node, set Resource = Label,
# Operation = Get Many, and run it once. The output lists id and name.
```

Or with a token from the OAuth Playground:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  https://www.googleapis.com/gmail/v1/users/me/labels \
  | jq -r '.labels[] | select(.type=="user") | "\(.id)\t\(.name)"'
```

Put the three ids in `infra/.env`:

```bash
GMAIL_NOT_SUPPORT_LABEL_ID=Label_1234567890
GMAIL_NEEDS_HUMAN_LABEL_ID=Label_1234567891
GMAIL_AUTO_REPLIED_LABEL_ID=Label_1234567892
```

### 3d. A note on the poll interval

The Gmail Trigger polls every minute. Gmail's API quota is 1,000,000 units/day
and a poll costs single digits, so this is nowhere near any limit — but it does
mean a customer waits up to a minute for the first reply. That is the trade for
not having to expose a public push endpoint and register a Pub/Sub topic. If you
need instant, swap the trigger for Gmail push notifications; nothing else in the
workflow changes.

---

## 4. The model

Any endpoint that speaks the OpenAI chat-completions shape **and supports
`response_format: { type: "json_schema", strict: true }`**. Both calls in this
repo depend on strict schemas; a model that ignores them will still mostly work
and will occasionally return prose, which `Validate Answer` turns into a failed
execution rather than a wrong answer.

In `infra/.env`:

```bash
LLM_API_BASE=https://api.openai.com/v1     # no trailing slash
LLM_MODEL=gpt-4o-mini
```

Other bases that work unchanged:

| Provider | `LLM_API_BASE` |
|---|---|
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<deployment>` |
| Groq | `https://api.groq.com/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| local vLLM | `http://vllm:8000/v1` |

The **key is not an environment variable**. In n8n: **Credentials → Add
credential → Header Auth**, named exactly `LLM API Key`, Name `Authorization`,
Value `Bearer sk-…`. That way it is encrypted at rest instead of sitting in a
file on the server.

---

## 5. Slack

Two incoming webhooks, or one used twice:

1. <https://api.slack.com/apps> → **Create New App → From scratch**.
2. **Incoming Webhooks** → toggle on → **Add New Webhook to Workspace** → pick
   the channel → copy the URL. Repeat for the second channel.
3. In `infra/.env`:

   ```bash
   SLACK_HUMAN_REVIEW_WEBHOOK_URL=https://hooks.slack.com/services/T…/B…/…
   SLACK_ALERTS_WEBHOOK_URL=https://hooks.slack.com/services/T…/B…/…
   ```

These URLs are secrets: anyone holding one can post into that channel.

If you would rather not use Slack at all, point both at any endpoint that accepts
a POST — Discord, Teams via a connector, or your own `/alerts` route. Nothing in
the workflows is Slack-specific except the block layout, which other services
ignore in favour of the `text` field.

---

## 6. Postgres credential

**Credentials → Add credential → Postgres**, named exactly
`Postgres - support ops`:

| Field | Value |
|---|---|
| Host | `postgres` (the compose service name) |
| Port | `5432` |
| Database | `support_ops` |
| User / Password | from `infra/.env` |
| SSL | `disable` on the compose network; `require` for a managed database |

---

## 7. Import the workflows

```bash
docker compose exec n8n n8n import:workflow --separate --input=/workflows
```

`--separate` imports each file as its own workflow. `infra/docker-compose.yml`
already mounts `../workflows` at `/workflows`, read-only, so the import reads the
repository's files rather than a copy somebody edited inside the container.

> Re-running the import creates a **second copy** of every workflow. Activating
> the copy then fails with a webhook path conflict against the original. To
> re-import cleanly, delete the existing workflows in the UI first.

---

## 8. Wire the two placeholders

The files ship with two deliberate placeholders, because an id from someone
else's instance is worse than no id at all.

**a. The answer engine.** Open **01 - Email Support Agent**, find the node
**Ask The Answer Engine**, and set its workflow to **03 - Answer Engine (shared
backend)**. Do the same in **02 - Live Chat Agent**. Both must point at the *same*
workflow — that is what makes the two channels one desk.

**b. The error workflow.** Open **04 - Error Trigger Alerts** and copy its id out
of the browser URL (`/workflow/<this bit>`). Then in **01**, **02** and **03**:
*⋯ menu → Settings → Error workflow* → pick **04 - Error Trigger Alerts**. They
ship with the placeholder `REPLACE_WITH_WORKFLOW_04_ID` so a missed step is
obvious rather than silent. **04 must not point at itself** — it would loop on
its own failures.

*(`scripts/configure-n8n.mjs` does all of the above over the API for the local
demo stack. It cannot create the Gmail credential, because that needs a browser
and Google's consent screen, and no script should be able to.)*

---

## 9. Embed the chat widget

Copy `widget/chat-widget.js` next to your other static assets, then put one tag
at the bottom of your site layout:

```html
<script src="/chat-widget.js"
        data-endpoint="https://n8n.yourdomain.com/webhook/chat/message"
        data-secret="THE VALUE OF CHAT_WEBHOOK_SECRET"
        data-title="Harbourly Support"
        data-subtitle="Answers from our help centre, instantly"
        data-greeting="Hi — ask me anything about invoices, plans or your account."
        data-accent="#6d8cff"
        defer></script>
```

`widget/demo.html` is a working example page you can open straight off disk.

**Two things to change before you go live:**

1. **CORS.** The `Chat Webhook` node ships with `allowedOrigins: "*"` so the demo
   page works from `file://`. Set it to your own origin
   (`https://www.yourdomain.com`) in the node's options.
2. **Rate limiting.** Put a limit on `/webhook/chat/message` at your reverse
   proxy — something like 30 requests per minute per IP. This matters because of
   the honest limitation below.

> **About `data-secret`.** The widget is client-side, so anyone who views source
> can read it. It is a throttle on drive-by posting, not authentication, and this
> repository does not pretend otherwise. What actually limits the damage is that
> the endpoint can only ever read from a knowledge base you have already
> published, that every request is logged in `support_decisions`, and that you
> rate limit the path. If you need real authentication, put the widget behind
> your own logged-in session and have your backend — not the browser — call the
> webhook with a server-side secret.

---

## 10. Activation checklist

Publish in this order. n8n refuses to publish a workflow whose Execute Workflow
node points at an unpublished sub-workflow, so the engine has to be live first.

- [ ] **03 - Answer Engine (shared backend)** → Published
- [ ] **04 - Error Trigger Alerts** → Published
- [ ] **01 - Email Support Agent** → Published
- [ ] **02 - Live Chat Agent** → Published

Then verify, in about five minutes:

1. **Chat.** From a terminal:

   ```bash
   curl -X POST https://n8n.yourdomain.com/webhook/chat/message \
     -H 'content-type: application/json' \
     -H "x-chat-secret: $CHAT_WEBHOOK_SECRET" \
     -d '{"session_id":"sess-manualcheck1","message":"<a question your help centre answers>"}'
   ```

   Expect a 200 with `"grounded": true` and a sensible `reply`.

2. **Email.** Send a real support question to the mailbox from another address.
   Within a minute you should see an execution of workflow 01, a reply in the
   same thread, and the `Support/Auto-Replied` label on the original.

3. **The gate.** Send a second email asking for a refund. Expect no reply, the
   `Support/Needs-Human` label, a Slack message and a row in
   `human_review_queue`.

4. **The log.**

   ```sql
   SELECT * FROM support_desk_daily;
   SELECT * FROM kb_gaps LIMIT 20;
   ```

---

## 11. Tuning it in the first fortnight

| Symptom | Where to look | What to change |
|---|---|---|
| Too many handovers | `SELECT reason, count(*) FROM support_decisions WHERE action='handed_to_human' GROUP BY 1` | if mostly "no article", write articles — that is what `kb_gaps` is for. If mostly "confidence below", lower `SUPPORT_CONFIDENCE_THRESHOLD` a little, or lower `KB_RELEVANCE_FLOOR`. |
| Answers from loosely related articles | `support_decisions.used_article_ids` | raise `KB_RELEVANCE_FLOOR` |
| Real support mail being routed out | rows with `action='routed_out_not_support'` | the classifier prompt in the `Classify: Support Or Not` node; add the pattern to the "is_support is false for" list only if it really is not support |
| Newsletters getting through | same | same, in the other direction |
| A green execution that did nothing useful | `SELECT * FROM support_decisions WHERE integration_error IS NOT NULL` | an outbound call failed and the workflow took a fallback path — this is the query that finds it |

---

## What you still need to do after handoff

Everything else — the workflows, the schema, the knowledge-base table, the
widget, the retry and idempotency behaviour — is in the repository and needs no
editing.

**Credentials (three):**

1. **`Gmail - Support Inbox`** — Gmail OAuth2, connected to the support mailbox
   (§3).
2. **`LLM API Key`** — Header Auth, `Authorization: Bearer sk-…` (§4).
3. **`Postgres - support ops`** — host, database, user, password (§6).

**Environment (`infra/.env`):** the two generated secrets, the Postgres password,
your public URL, the three Gmail label ids, the two Slack webhook URLs, and
`LLM_API_BASE` / `LLM_MODEL`. Every variable is documented in
`infra/.env.example`.

**Pointers (two clicks each):** set workflow 03 as the answer engine on 01 and
02; set workflow 04 as the error workflow on 01, 02 and 03 (§8).

**Activation:** publish 03, then 04, then 01, then 02 (§10).

That is the whole list. Nothing in `workflows/`, `sql/` or `widget/` has to be
edited to go live.

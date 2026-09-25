# Node by node

Every node in all four workflows: what it does, why it is there, and what it
puts on its output. 65 nodes, all of them plain `n8n-nodes-base` — no community
packages, nothing to install.

Conventions used throughout:

- **Retries.** Every node that calls somebody else's server (Gmail, the model
  endpoint, Slack) has `retryOnFail: true`, `maxTries: 3` and
  `waitBetweenTries: 2000`. An immediate retry just hits the same failure.
- **Error outputs.** Those same nodes have `onError: "continueErrorOutput"`, and
  every error output is wired to something that records the failure. No node in
  this repo has both an error output and `alwaysOutputData` — that combination
  sends a failure down the *success* branch as an empty item as well.
- **Postgres is different on purpose.** Database nodes retry but have no error
  output. A failed idempotency claim or a failed decision write must fail the
  execution: carrying on past either is how a customer gets two replies, or how
  an action happens with no record of it.
- **`alwaysOutputData`** appears on exactly five nodes, all of them places where
  "no rows" is a meaningful answer the next node has to see.

---

# 01 — Email Support Agent

27 nodes. Trigger: Gmail, polling. Error workflow: 04.

### Gmail Trigger — `gmailTrigger` v1.4
Polls the connected mailbox every minute for **unread** mail.
`simple: false` on purpose: the simplified output has no body, and the body is
the thing the agent has to read. `includeSpamTrash: false`, `includeDrafts:
false`.
**Outputs** the parsed message: `id`, `threadId`, `labelIds`, `subject`,
`from` / `to` (as `{value:[{address,name}], text}`), `text`, `html`,
`messageId` (the RFC 5322 header), `date`, `headers`.
*Read status "unread" is the cheap half of deduplication. `processed_messages`,
three nodes down, is the half that actually holds.*

### Capture Email Fields — `code` v2
The four fields the brief names, made explicit rather than left buried in the
Gmail payload. Nothing downstream reads the raw Gmail item.
Also runs the **deterministic keyword sweep** here, *before* the model is asked
anything, so its result cannot be influenced by the classification.
**Outputs** `sender`, `sender_name`, `subject`, `body`, `thread_id`,
`gmail_message_id`, `rfc_message_id`, `received_at`, `label_ids`,
`decision_key`, `keyword_money`, `keyword_legal`, `keyword_angry`,
`keyword_hits`.
*Two ids matter and they are not interchangeable: `id` is Gmail's, stable and
assigned by Google, and is the idempotency key; `messageId` is the RFC header,
written by the sender, who can repeat or forge it. It is kept for the audit
trail and never used as a key.*

### Claim This Message — `postgres` v2.6 · `alwaysOutputData`
`INSERT INTO processed_messages … ON CONFLICT (gmail_message_id) DO NOTHING
RETURNING id, gmail_message_id`.
**Outputs** one row on a first delivery, zero rows on a repeat — and, because of
`alwaysOutputData`, one empty item instead of nothing at all.
*Never "SELECT then INSERT": two deliveries of the same message can be in flight
at the same moment, both would pass a prior SELECT, and both would reply.*

### First Delivery Of This Message? — `if` v2.2
`{{ $json.id }}` exists.
**True**: this execution owns the message. **False**: another execution already
claimed it.

### Duplicate Delivery — Exit — `noOp` v1
The end of the road for a redelivered message. Green execution, no reply, no
second decision row. Kept as a node rather than left dangling so the canvas
shows the branch ending deliberately.

### Restore Email Context — `code` v2
The Postgres node above replaced the item with its `RETURNING` row, so the email
is put back — matched by `gmail_message_id`, not by position. When one poll
delivers several messages and one of them is a duplicate, the claim node emits
fewer rows than it received and positions no longer line up.
**Outputs** the Capture Email Fields item plus `claim_id`.

### Classify: Support Or Not — `httpRequest` v4.5 · retries · error output
`POST {{ $env.LLM_API_BASE }}/chat/completions`, `temperature: 0`,
`response_format: { type: "json_schema", strict: true }` with the schema
`{is_support, intent, confidence, touches_money, reason}` and a thirteen-value
`intent` enum.
Credential: **LLM API Key** (HTTP Header Auth).
**Outputs** the provider's completion object.
*Any provider that speaks the same shape — OpenAI, Azure OpenAI, Groq, a local
vLLM — is a change of `LLM_API_BASE`, not a change of workflow.*

### Classifier Unavailable — `code` v2 *(error branch)*
Three attempts, all failed. Sets `is_support: true`, `classifier_confidence: 0`
and **`touches_money: true`**, then routes to the handover.
*The safe default when triage is impossible is a person: an unanswered customer
is recoverable, an auto-reply built on a guess is not. Forcing `touches_money`
means the gate downstream cannot auto-answer it whatever the engine says.*

### Apply Keyword Sweep — `code` v2
Parses the classification (throwing a readable error if the body is not a
completion or not JSON), then audits it **in one direction only**:
`touches_money` is OR-ed with the keyword hits, and confidence is capped — never
raised — when the customer is angry.
**Outputs** `is_support`, `intent`, `classifier_confidence`, `touches_money`,
`classification_reason`, `caution_reason`, plus everything from Capture.
*A sweep that could lower caution would be a way to talk the gate into answering
a refund request by phrasing it carefully. If the model says "no money" and the
customer wrote "chargeback", the customer wins.*

### Is This A Support Request? — `if` v2.2
`is_support` is true. This is the fork the brief calls "routed out".

### Label As Not Support — `gmail` v2.1 `addLabels` · retries · error output
Adds `{{ $env.GMAIL_NOT_SUPPORT_LABEL_ID }}` to the message.
**Both outputs** go to Build Decision (Routed Out).
*Routed out, not dropped: the mail stays in the mailbox under
`Support/Not-Support`, visible to a human and reversible by one drag. A
labelling failure must not lose the decision row.*

### Build Decision (Routed Out) — `code` v2
Builds the `support_decisions` row with `action: 'routed_out_not_support'`, the
classifier's reason, the customer's own words in `inbound_text`, and
`integration_error` set when it arrived down the error branch.

### Load Thread History — `postgres` v2.6 · `alwaysOutputData`
Everything already decided on this Gmail thread, `LIMIT EMAIL_HISTORY_TURNS`,
newest-first in a subquery and oldest-first on the way out.
**Outputs** zero or more `{created_at, action, reason, inbound_text,
reply_text, grounded}` rows.
*"The last N turns, oldest first" is two different orderings, and getting it
backwards hands the model the conversation in reverse.*

### Build Engine Request — `code` v2
Turns those rows into `history[]` — both sides of it: the customer's earlier
words are what make a follow-up retrievable, the agent's earlier answers are
what stop it repeating itself.
**Outputs** `{channel: 'email', text, session_or_thread_id, history, …}`.

### Ask The Answer Engine — `executeWorkflow` v1.2
Calls workflow 03, waiting for the result. Ships with
`REPLACE_WITH_ANSWER_ENGINE_ID`; `scripts/configure-n8n.mjs` (or you, once, in
the UI) fills in the real id.
**Outputs** `{grounded, answer, confidence, used_article_ids, escalate_reason,
question, conversation_ref, …}`.

### Combine Answer And Classification — `code` v2
Merges the engine's answer with the classification and takes the **minimum** of
the two confidences.
*Multiplying them would punish two good scores. The minimum means the weakest
link decides, which is what a gate is for.*

### Confidence Gate — `if` v2.2
Four conditions, ANDed, all required:
1. `grounded` is true
2. `answer` is not empty
3. `confidence >= {{ Number($env.SUPPORT_CONFIDENCE_THRESHOLD) }}`
4. `touches_money` is **false**

Anything else is a handover. The threshold is an environment variable so it can
be tightened in production without touching the workflow.

### Reply In The Same Thread — `gmail` v2.1 `reply` · retries · error output
`operation: reply` on `{{ $json.gmail_message_id }}`.
n8n's reply operation reads the original message's `Message-ID`, sets
`In-Reply-To` and `References` from it, and sends with the original `threadId`.
Both halves matter: `threadId` is what groups it in the Gmail web UI, and the
two headers are what group it in Outlook, Apple Mail and everything else that
has never heard of a Gmail thread id.
`options.appendAttribution: false` — no "sent with n8n" footer on a customer
reply.

### Label As Auto Replied — `gmail` v2.1 `addLabels` · retries · error output
So a human scanning the mailbox can see at a glance what the agent answered
without opening anything. Both outputs continue.

### Build Decision (Auto Replied) — `code` v2
The `support_decisions` row for the answered branch, including the article ids
used and the `threadId` Gmail reported on the sent message.

### Handover: Reply Failed — `code` v2 *(error branch of the reply)*
Gmail refused the reply three times. The answer was good; the delivery was not.
Sets `escalate_reason: 'reply_delivery_failed'` and joins the handover path.

### Build Handover — `code` v2
Every route to a human passes through here, so the reason a customer did not get
an automated answer is written once and always in the same words. Also builds
the Slack block payload.
**Outputs** `handover_reason` and `slack_payload`.

### Label As Needs Human — `gmail` v2.1 `addLabels` · retries · error output
The signal a human actually sees in the mailbox. Both outputs continue to the
queue: a failed label must not stop the ticket being opened.

### Queue For A Human — `postgres` v2.6 · `alwaysOutputData`
`INSERT INTO human_review_queue … ON CONFLICT (decision_key) DO NOTHING
RETURNING id, created_at`.
*A replayed execution finds the ticket already open, gets zero rows back, and
must still continue to the alert and the decision row.*

### Alert The Review Channel — `httpRequest` v4.5 · retries · error output
`POST {{ $env.SLACK_HUMAN_REVIEW_WEBHOOK_URL }}` with the Slack blocks built
above. Both outputs land on the decision row below.
*A queue entry that exists and an alert that never arrived is a very different
incident from neither happening, and the log has to tell them apart.*

### Build Decision (Handed To Human) — `code` v2
The `support_decisions` row for the handover branch, concatenating every
`integration_error` picked up along the way.

### Log Decision — `postgres` v2.6
`INSERT INTO support_decisions … ON CONFLICT (decision_key) DO UPDATE`. The last
node on all three branches.
*`DO UPDATE` rather than `DO NOTHING`: a manually re-run execution should correct
the row it already wrote, not leave a stale one beside a new one. A Postgres
failure here fails the execution on purpose — a decision that was acted on but
never recorded is the one thing this desk must not do quietly.*

---

# 02 — Live Chat Agent

19 nodes. Trigger: webhook. Error workflow: 04.

### Chat Webhook — `webhook` v2.1
`POST /webhook/chat/message`, `responseMode: "responseNode"`,
`options.allowedOrigins: "*"` (set it to the client's own domain in production —
see `setup.md`).
*`responseNode`, not `onReceived`: the visitor gets the actual answer in the
body of this same request, which is what "replies immediately" has to mean for a
chat widget.*

### Verify Shared Secret — `code` v2
`crypto.timingSafeEqual` against `{{ $env.CHAT_WEBHOOK_SECRET }}`; rejects the
request by throwing before anything is written. Validates the session id against
`^[A-Za-z0-9_-]{8,128}$` — it arrives from a browser, so it is an opaque key and
never identity. Runs the **same money keyword list as workflow 01**.
**Outputs** `session_id`, `message`, `page_url`, `visitor_email`,
`decision_key`, `touches_money`, `keyword_hits`, `received_at`.
*A chat widget cannot hold a real credential; everything it knows is in the page
source. This stops casual drive-by posting and nothing more, and `setup.md` says
so rather than implying otherwise by the presence of a check.*

### Open Or Touch Session — `postgres` v2.6
`INSERT INTO chat_sessions … ON CONFLICT (session_id) DO UPDATE SET
last_seen_at = now(), visitor_email = coalesce(excluded.visitor_email,
chat_sessions.visitor_email)`.
*The `coalesce` matters: a visitor who gives their address on message four must
not have it erased by message five, which sends nothing.*

### Load Recent Turns — `postgres` v2.6 · `alwaysOutputData`
The last `CHAT_HISTORY_TURNS` rows of `chat_messages` for this session, oldest
first. This is the memory. Without it every message is the visitor's first.

### Build Engine Request — `code` v2
The same shape workflow 01 builds: `{channel: 'chat', text,
session_or_thread_id, history}`.

### Ask The Answer Engine — `executeWorkflow` v1.2
The same workflow 03 — the same n8n workflow id, not a second copy of the logic.

### Combine Answer And Session — `code` v2
Merges the engine result onto the session context for the gate.

### Confidence Gate — `if` v2.2
The same four conditions as workflow 01, reading the same environment variable.
*A refund question typed into the widget gets a human for exactly the same
reason one sent by email does.*

### Compose Reply — `code` v2
Sets `action: 'auto_replied'`, `reply_text` to the grounded answer,
`needs_human: false`.

### Compose Handover Reply — `code` v2
Says it does not know, in one sentence, and offers a person — with a different
first line for money, for an outage and for a genuine knowledge gap.
*Every extra sentence a bot writes when it has nothing to say is a sentence the
customer reads before finding out they are still stuck.*

### Reply Ready — `code` v2
A junction, not a transform: one named upstream for both branches, so the four
nodes below are written once instead of twice.

### Respond To Visitor — `respondToWebhook` v1.1
Returns `{session_id, reply, grounded, handed_to_human, used_article_ids,
answered_at}` with `access-control-allow-origin` and `cache-control: no-store`.
**Everything after this node is bookkeeping and runs after the browser already
has the reply.**

### Log Decision — `postgres` v2.6
The same `support_decisions` table workflow 01 writes to, with
`channel = 'chat'`. One log for the whole desk means one query answers "what did
support do today", whichever door the question came through.

### Persist Both Turns — `postgres` v2.6
The visitor's message and the agent's reply, in that order, **in one statement**.
*Two separate INSERTs would leave a window where a crash records the question and
not the answer, and the next message in the session would then be answered
against a transcript that lies.*

### Needs A Human? — `if` v2.2
Reads `needs_human` off Reply Ready. Runs after the visitor already has their
reply — queueing and alerting are not on the visitor's critical path.

### Queue For A Human — `postgres` v2.6 · `alwaysOutputData`
`ON CONFLICT (decision_key) DO NOTHING`. A visitor who impatiently sends the same
sentence twice opens one ticket, not two.

### Alert The Review Channel — `httpRequest` v4.5 · retries · error output
`POST {{ $env.SLACK_HUMAN_REVIEW_WEBHOOK_URL }}`. Both outputs land on the
recorder below.

### Record Alert Outcome — `postgres` v2.6 · `alwaysOutputData`
`UPDATE support_decisions SET integration_error = $2 WHERE decision_key = $1 AND
$2 IS NOT NULL`. Writes nothing on the happy path, which is why
`alwaysOutputData` is on.

### Answered Without A Human — `noOp` v1
The branch that needed nobody, ended deliberately rather than left dangling.

---

# 03 — Answer Engine (shared backend)

15 nodes. Trigger: Execute Workflow. Error workflow: 04.
**Input** `{channel, text, session_or_thread_id, history[]}`.
**Output** `{grounded, answer, confidence, used_article_ids, escalate_reason, …}`.

### When Called By Another Workflow — `executeWorkflowTrigger` v1.1
`inputSource: "passthrough"`. This is the shared backend: workflows 01 and 02
both call *this* workflow, so a change to how the desk answers is one edit in one
place and the two channels cannot drift apart.

### Normalise Request — `code` v2
Validates the contract (throwing on a bad channel, an empty question or a missing
conversation id — a caller that gets this wrong should find out immediately), and
builds the retrieval query:

- quoted reply blocks, `On … wrote:` separators and signature markers are split
  off the bottom, because in a threaded email they are most of the text and none
  of the meaning;
- the query is then **expanded with the previous visitor turn**, because a
  follow-up like "and what does that cost?" shares no word with any article. Only
  the visitor's turn, never the agent's: the agent's reply was written out of an
  article, so feeding it back retrieves that same article whatever was asked
  next.

**Outputs** `channel`, `question`, `retrieval_query`,
`retrieval_query_own_words`, `question_hash` (SHA-256 of the normalised
question), `conversation_ref`, `history`, `history_turns`.

### Retrieve Passages — `postgres` v2.6 · `alwaysOutputData`
Postgres full-text search over `articles`:

```sql
WITH q AS (
  SELECT nullif(replace(plainto_tsquery('english', $1)::text, '&', '|'), '')::tsquery AS tsq
)
SELECT a.id, a.slug, a.title, a.category, left(a.body, 1500) AS passage,
       round(ts_rank(a.search_tsv, q.tsq)::numeric, 6) AS relevance
  FROM articles a, q
 WHERE q.tsq IS NOT NULL AND a.search_tsv @@ q.tsq
 ORDER BY relevance DESC, a.updated_at DESC
 LIMIT $2::int;
```

*The terms are ORed, not ANDed. `plainto_tsquery` and `websearch_to_tsquery` both
join every word with `&`, so one unusual word anywhere in a customer's sentence
excludes the article that answers them — "I was charged twice this month, can I
get a refund?" ANDs `charged & twice & month & refund` and matches nothing at
all. Rewriting `plainto_tsquery`'s **output** rather than assembling a tsquery
from the raw string keeps it safe: the words are already stemmed and every
operator character is already gone.*

### Apply Relevance Floor — `code` v2
Drops everything below `{{ $env.KB_RELEVANCE_FLOOR }}`.
**Outputs** `passages[]` (id, slug, title, passage, relevance),
`retrieved_count`, `kept_count`, `top_relevance`, `has_context`.
*This is what turns a bad retrieval into an honest "I do not know" instead of a
confident wrong answer assembled from a loosely related article. Zero rows is a
state, not silence — hence `alwaysOutputData` on the node above.*

### Anything Retrieved? — `if` v2.2
`has_context` is true.

### Answer From Passages — `httpRequest` v4.5 · retries · error output
`POST {{ $env.LLM_API_BASE }}/chat/completions` with a six-rule system prompt and
a user message containing `<question>`, `<history>` and `<passages>` blocks.
Strict schema: `{answer, used_article_ids[], answered_from_kb, missing_info}`.
*The model sees the retrieved passages and nothing else. Rule 1 is that an honest
"we do not have that documented" is the correct output and never a failure; rule
5 is that it may never promise a refund, credit, discount or exception.*

### Validate Answer — `code` v2
Where the prompt stops being a request and becomes enforcement:

- a body that is not a chat completion, or content that is not JSON, **throws** —
  which is how a provider's HTML error page becomes a readable failed execution
  instead of an invented answer;
- every cited article id is filtered against the ids actually retrieved, and the
  rejects are kept in `hallucinated_article_ids`;
- `grounded` requires `answered_from_kb === true` **and** a non-empty answer
  **and** at least one surviving citation;
- `confidence` is derived from `ts_rank` of the passage the answer actually used,
  normalised against 0.45 (a measured solid match on the seeded corpus, where a
  real match scores 0.24–0.70 and incidental overlap scores 0.04).

*Confidence is not the model's opinion of its own answer. A model asked to score
itself says 0.9 to anything.*

### Answered From The Knowledge Base? — `if` v2.2
`grounded` is true. The **missing-knowledge** fork.

### Result: Grounded Answer — `code` v2
The contract, with `grounded: true` and `escalate_reason: null`.

### Result: No Article Matched — `code` v2
Nothing above the floor. `escalate_reason: 'no_matching_article'`.

### Result: Not Answerable From The Knowledge Base — `code` v2
Articles were retrieved and none of them contained the answer — a subtler gap
than "nothing matched". `escalate_reason: 'not_answerable_from_kb'`, carrying the
model's `missing_info`.

### Result: Answer Engine Unavailable — `code` v2 *(error branch of the model call)*
`escalate_reason: 'answer_engine_unavailable'`, with the failure in
`integration_error`.
*The engine returns "not grounded" rather than throwing, so the caller's own gate
turns an outage into a human handover instead of a failed execution and a silent
customer.*

### Ungrounded Result — `code` v2
A junction: one named upstream for the three ways an answer can fail to be
grounded.

### Record Unanswered Question — `postgres` v2.6 · `alwaysOutputData`
```sql
INSERT INTO unanswered_questions (question_hash, question, channel, conversation_ref, reason)
SELECT $1, $2, $3, $4, $5
 WHERE $5 IN ('no_matching_article', 'not_answerable_from_kb')
    ON CONFLICT (question_hash) DO UPDATE
   SET asked_count = unanswered_questions.asked_count + 1, last_asked_at = now()
RETURNING id, asked_count;
```
*`DO UPDATE`, not `DO NOTHING`: the same question asked fifty times must be one
row with `asked_count = 50`, not fifty rows nobody reads — the counter is what
says which article to write next. The `WHERE` keeps an outage out of the gap
list, and is why `alwaysOutputData` is needed: the statement can legitimately
write no row.*

### Return To Caller — `code` v2
Both branches leave through here, so `Execute Workflow` always hands the caller
the same shape. The grounded branch arrives carrying the contract; the ungrounded
branch arrives carrying the `unanswered_questions` row, so the contract is rebuilt
from the junction node and `unanswered_question_id` / `times_asked` are added.

---

# 04 — Error Trigger Alerts

4 nodes. Trigger: Error Trigger. **No error workflow of its own** — pointing it
at itself would loop on its own failures.

### Error Trigger — `errorTrigger` v1
Set as the Error workflow on 01, 02 and 03. Fires once per failed execution,
including failed retries.

### Format Alert — `code` v2
Handles both shapes the trigger can deliver — `{execution, workflow}` for a
failure inside the flow, `{trigger: {error}}` for one before any node ran.
**Outputs** `workflow_id`, `workflow_name`, `execution_id`, `execution_url`,
`failed_node`, `error_name`, `error_message`, `error_description`,
`error_stack`, `execution_mode`, `retry_of`, `input_excerpt`, and the Slack block
payload.
*The item that was in flight when the node threw is the most useful thing in the
whole alert, and the thing nobody thinks to include.*

### Alert Ops Channel — `httpRequest` v4.5 · retries · error output
`POST {{ $env.SLACK_ALERTS_WEBHOOK_URL }}`. **Both outputs go to Record Failure.**

### Record Failure — `postgres` v2.6 · `alwaysOutputData`
`INSERT INTO failures … ON CONFLICT (execution_id) WHERE execution_id IS NOT NULL
DO NOTHING`, with `alert_delivered` recording whether Slack took the message.
*The unique index behind that `ON CONFLICT` is partial: a repeated Error Trigger
delivery for one production execution must not create a second row, and a manual
execution has no id to deduplicate on, so two of those must both be recorded.
Slack is for the person on shift; this table is for the Monday review — you
cannot ask Slack history which node failed most often last month.*

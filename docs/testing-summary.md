# Testing summary

Ten scenarios, executed against a live n8n **2.40.5** instance on Postgres
**17.6**, started from `infra/docker-compose.yml` with the four files in
`workflows/` imported by `n8n import:workflow --separate`. The run produced
**22 executions**, numbered 1–22 below, and every number in this document was
read out of n8n's own executions API or out of `support_ops` — not out of the
script that drove them.

Reproduce it with:

```bash
scripts/demo-up.sh
node scripts/run-scenarios.mjs     # ≈ 7 minutes, mostly waiting for the Gmail poll
```

The script asserts each result before recording it, and exits non-zero on the
first assertion that fails. On this run: **10 scenarios, all assertions passed.**

Organised under the four headings the brief names.

---

## At a glance

| # | Scenario | Heading | Exec | Result | Time |
|---|---|---|---|---|---|
| 1 | Genuine support email | Support vs non-support | 1 | success — answered and replied in-thread | 467 ms |
| 2 | Newsletter | Support vs non-support | 3 | success — labelled and routed out, no reply | 136 ms |
| 3 | Follow-up on the same thread | Thread continuity | 4 | success — history loaded, replied in-thread | 395 ms |
| 4 | Question with no matching article | Missing knowledge | 6 | success — not answered, gap recorded | 325 ms |
| 5 | Refund request | Support vs non-support | 8 | success — held for a human | 270 ms |
| 6 | Chat widget, first message | Live chat | 10 | success — answered in the same response | 189 ms |
| 7 | Chat follow-up in the same session | Thread continuity | 14 | success — answered using session memory | 396 ms |
| 8a | Model endpoint returns 500 twice | Integration failures | 16 | success **after two 500s** | 4233 ms |
| 8b | Model endpoint returns an HTML error page | Integration failures | 18 → 21 | **error**, then Error Trigger recorded it | 131 ms → 48 ms |
| 9 | Same Gmail message delivered twice | Integration failures | 22 | success — exited cleanly, no second reply | 79 ms |

Executions 2, 5, 7, 9, 11, 13, 15, 17 and 19 are the answer engine running as a
sub-workflow of one of the above. Execution 20 is the Error Trigger firing for
the sub-workflow's own failure; 21 is it firing for the parent.

---

## 1. Support vs non-support handling

### Scenario 1 — a genuine support email is answered

**Asserted.** Classified as support, answered from a seeded article, replied on
the **same `threadId`** with `In-Reply-To` and `References` set, labelled
`Support/Auto-Replied`.

**Observed** (execution 1, success, 467 ms):

```
action           = auto_replied
confidence       = 0.762          (min of classifier 0.93 and answer 0.762)
grounded         = true
used_article_ids = {9}            ("Turning on two-factor authentication")

inbound  threadId = thread-support-1
reply    threadId = thread-support-1        ← match
         In-Reply-To = <mockmsg-support-1@mail.example>
         References  = <mockmsg-support-1@mail.example>

labels added = ["Label_AutoReplied"]
answer       = "Settings then Security then Two-factor authentication. Harbourly
                supports any TOTP authenticator app such as 1Password, Authy or
                Google Authenticator. Save the ten recovery codes we show you
                when you turn it on; they are shown once."
```

Every sentence of that answer is in article 9. Screenshots
[`03`](screenshots/03-captured-sender-subject-body-thread.png) and
[`04`](screenshots/04-reply-in-the-same-thread.png).

### Scenario 2 — a newsletter is routed out, not dropped

**Asserted.** Classified as not-support, labelled `Support/Not-Support`, logged
with a reason, and **no reply sent**.

**Observed** (execution 3, success, 136 ms):

```
action  = routed_out_not_support
intent  = newsletter
reason  = "matched non-support markers: unsubscribe, view this email in
           your browser, webinar"
labels added                     = ["Label_NotSupport"]
replies sent on thread-newsletter-1 = 0
```

The mail is still in the mailbox, under a label, with a row in
`support_decisions` carrying the message body — so the decision is visible and
reversible. Screenshots [`05`](screenshots/05-non-support-routed-out.png),
[`06`](screenshots/06-labelled-not-support-no-reply.png).

### Scenario 5 — a refund request is held for a human regardless of confidence

**Asserted.** The gate refuses anything that touches money, whatever the
confidence.

**Observed** (execution 8, success, 270 ms):

```
action        = handed_to_human
grounded      = true             ← the engine DID find an answer
confidence    = 0.675
touches_money = true
reason        = "Touches money or legal matters - never auto-answered,
                 whatever the confidence."
replies sent  = 0
```

This is the interesting one: retrieval found the refund-policy article and the
engine produced a grounded answer, and it was still not sent. The gate needs all
four of its conditions, and `touches_money` was raised by the deterministic
keyword sweep (`charged twice`, `refund`) before the model was even asked.
Screenshot [`12`](screenshots/12-money-question-fails-the-gate.png).

---

## 2. Thread continuity

### Scenario 3 — an email follow-up on the same thread

**Asserted.** The follow-up loads the earlier turns as history, is answered, and
the reply goes back on the same thread quoting the **follow-up** rather than the
original.

**Observed** (execution 4, success, 395 ms):

```
conversation_ref                = thread-support-1
decision rows on this thread    = 2
replies on this thread          = 2
second reply threadId           = thread-support-1
second reply In-Reply-To        = <mockmsg-support-2@mail.example>   ← the follow-up, not the original
action = auto_replied   confidence = 0.729   used_article_ids = {9}
answer = "Save the ten recovery codes we show you when you turn it on; they are
          shown once. If you lose both your authenticator and your recovery
          codes, a human has to verify your identity before the account can be
          unlocked, which takes one working day."
```

The customer wrote *"What happens if I lose the recovery codes you mentioned?"* —
a sentence that only makes sense against the previous turn. `Load Thread History`
returned the first exchange, `Build Engine Request` passed both sides of it, and
the answer engine expanded the retrieval query with the customer's earlier
message. Screenshot [`07`](screenshots/07-thread-history-loaded.png).

### Scenario 7 — a chat follow-up in the same session

This one is tested by **contrast**, because "it answered" on its own proves
nothing about memory. The identical follow-up text was sent twice: once into the
session that already had two turns, once into a brand-new session.

**Observed** (execution 14, success, 396 ms):

```
same session (4 turns stored):    grounded = true   used_article_ids = [1]   203 ms
fresh session, identical text:    grounded = false  handed_to_human = true
```

The text was *"And what does it cost after that?"* — no word in it appears in any
article. With history, the retrieval query is expanded with the visitor's
previous message and article 1 is found. Without history, nothing clears the
relevance floor and the desk says so. **The only difference between the two runs
is the memory.**

---

## 3. Missing-knowledge cases

### Scenario 4 — nothing in the knowledge base covers the question

**Asserted.** No article above `KB_RELEVANCE_FLOOR`, so: not answered, a row
written to `unanswered_questions`, labelled `Support/Needs-Human`, a ticket
queued, Slack alerted.

**Observed** (execution 6, success, 325 ms):

```
action   = handed_to_human
grounded = false
reason   = "The knowledge base has no article covering this question."

unanswered_questions:
  question    = "Hello - is there an Android app, and does it scan paper
                 receipts while offline on a building site?"
  reason      = no_matching_article
  asked_count = 1

human_review_queue rows = 1
labels added            = ["Label_NeedsHuman"]
slack posts             = 1
replies sent            = 0
```

The question is now in `kb_gaps`, which is the point: it is not an error log, it
is the list of articles the business has not written yet, ordered by how often
customers ask for them. Screenshots
[`10`](screenshots/10-missing-knowledge-to-human.png),
[`11`](screenshots/11-unanswered-question-recorded.png).

A second, subtler variant showed up during the video recording: the widget was
asked *"Do you have an Android app with offline receipt scanning?"* — different
wording, enough lexical overlap to retrieve something, and the answer came back
with **confidence 0.639, below the 0.72 threshold**, so it was handed over with
`reason = "Confidence 0.639 is below the threshold 0.72."` Three different
reasons for not answering (`no_matching_article`, `not_answerable_from_kb`,
below-threshold) all reach a human, and the log tells them apart.

---

## 4. Integration failures

### Scenario 8a — the model endpoint returns HTTP 500 twice, then recovers

**Asserted.** Two 500s are absorbed by `retryOnFail` and the third attempt
succeeds — same answer, longer execution.

**Observed** (execution 16, success, 4233 ms):

```
HTTP 200 in 4217 ms   (the same question with nothing injected: 159 ms)
grounded = true
model endpoint calls across the run = 13
```

The 4-second difference is the two `waitBetweenTries: 2000` gaps. The visitor
still got a correct, grounded answer; nobody was told anything was wrong, because
nothing was. Screenshot [`14`](screenshots/14-model-500s-then-recovers.png).

### Scenario 8b — the model returns 200 with an HTML error page

The failure retries cannot fix: a proxy or gateway answering `200 text/html`
where a JSON completion should be.

**Asserted.** The execution fails at the validator rather than inventing an
answer, the Error Trigger fires, Slack is alerted, and a `failures` row is
written whether or not Slack accepted.

**Observed** (execution 18 error → 19 error → 20, 21 success):

```
chat response: HTTP 500        (no answer invented, nothing written to chat_messages)

failures rows 0 -> 2:
  03 - Answer Engine (shared backend) | node "Validate Answer"
     | "The model endpoint did not return a chat completion. Body began: {"dat…"
     | alert_delivered = true | execution_id = 19
  02 - Live Chat Agent               | node "Ask The Answer Engine"
     | "The model endpoint did not return a chat completion. Body began: {"dat…"
     | alert_delivered = true | execution_id = 18
```

Two rows because both the sub-workflow and its caller failed, and both point at
workflow 04 as their error workflow. That is correct and useful: the first row
names the node that actually broke, the second names the customer-facing workflow
that was affected. Screenshots [`15`](screenshots/15-failed-execution.png),
[`16`](screenshots/16-error-trigger-recorded-the-failure.png).

### Scenario 9 — the same Gmail message delivered twice

**Asserted.** The second delivery exits cleanly on the idempotency claim:
exactly one reply, one `processed_messages` row, one decision row.

**Observed** (execution 22, success, 79 ms):

```
processed_messages rows for mockmsg-support-1 = 1
replies on thread-support-1                   2 -> 2   (unchanged)
decision rows for this message                1 -> 1   (unchanged)
Claim This Message output: one empty item, no id  → IF takes the false branch
                                                  → Duplicate Delivery - Exit
```

This is a real redelivery through the real trigger, not a simulated one. The
Gmail Trigger keeps only the ids it fetched on its **last** poll as its own
duplicate set, so a message that reappears in the mailbox after other mail has
arrived is handed to the workflow again — and then `processed_messages` is what
has to catch it. Screenshots
[`17`](screenshots/17-duplicate-exits-cleanly.png),
[`18`](screenshots/18-duplicate-guard-zero-rows.png), and the last 40 seconds of
[`docs/walkthrough.mp4`](walkthrough.mp4).

---

## Row counts after the run

```
support_decisions      9
human_review_queue     3
unanswered_questions   2
chat_messages          8
processed_messages     5
failures               2
```

```
support_desk_daily
 channel │ messages │ auto_replied │ handed_to_human │ routed_out │ deflection_pct │ avg_confidence
 chat    │        4 │            3 │               1 │          0 │           75.0 │          0.713
 email   │        5 │            2 │               2 │          1 │           50.0 │          0.542
```

(The counts in the screenshots and in `docs/walkthrough.mp4` are higher, because
the video was recorded afterwards on the same instance and added three more live
executions — a support email, three widget questions and the duplicate — on top
of these 22.)

---

## What the validator checks, separately

```
$ node --test test/validate.mjs
ℹ tests 69
ℹ pass 69
ℹ fail 0
```

Structural, not behavioural — it reads the JSON files and `sql/schema.sql`
without a running instance, and it catches the things that only break after a
file has been imported:

- valid JSON, unique node names and ids, every connection pointing at a node that
  exists, one trigger, no unreachable nodes
- every Gmail/HTTP node has `retryOnFail`, `maxTries ≥ 3`, `waitBetweenTries ≥ 1s`
  and `onError: continueErrorOutput`, and every error output reaches, within six
  hops, something that records the failure
- no node has both an error output and `alwaysOutputData`
- Postgres nodes retry and are *not* allowed to route their errors away
- `executionOrder: v1`, failed execution data kept, `errorWorkflow` set on
  everything except 04, which must not point at itself
- no secrets, no hard-coded URLs, credential ids all `null`
- every `$env` var a workflow reads is both passed to the container in
  `docker-compose.yml` and documented in `.env.example`
- every table a query touches exists in `sql/schema.sql`, and every `ON CONFLICT`
  target matches a real unique key there
- the idempotency guards INSERT and check in one statement and carry
  `alwaysOutputData`; no guard SELECTs before it INSERTs
- the confidence gate still has all four conditions, ANDed, with `touches_money`
  required false and confidence `gte` the threshold
- the keyword sweep ORs `touches_money` and can only cap confidence, never raise it
- the not-support branch reaches a label and the decision log, and has **no path
  at all** to the reply node
- the reply node uses `operation: reply` keyed on the Gmail message id
- the answer engine filters cited article ids against the retrieved ids, and
  `grounded` requires a surviving citation
- retrieval ORs its terms, ranks them, and reads its floor and top-k from the
  environment
- the chat webhook verifies its secret in constant time before any write, and
  answers through a Respond to Webhook node rather than `onReceived`

---

## Honest limits of this test run

- **Gmail is mocked at the server, not at the node.** The Gmail Trigger and the
  Gmail node ran exactly as committed; what answered them was
  `test/mocks/server.mjs` on a DNS-mapped `www.googleapis.com`. So the request
  the reply node builds — including the `In-Reply-To` header quoted above — is
  real, and was read back out of the RFC 5322 message it sent. What has not been
  tested is Gmail's own behaviour: its rate limits, its threading heuristics in
  the web UI, and the OAuth consent flow, which needs a browser and a Google
  account.
- **The model's judgement is substituted.** The mock `/chat/completions`
  endpoint returns schema-valid JSON decided by keyword matching, so the
  *parsing, validation, citation filtering, confidence derivation, gating,
  routing and logging* all ran for real and only the model's opinion did not.
  A real model will classify better than the mock and will occasionally be
  wrong in ways the mock never is.
- **Slack is mocked**, as an HTTP endpoint that records what it was posted.
- **Concurrency is not load-tested.** The idempotency guards are correct by
  construction — the check and the write are one statement adjudicated by
  Postgres — but this run did not fire two simultaneous deliveries of the same
  message to observe the race being lost.
- **No multi-item poll.** Every Gmail poll in this run delivered one message. The
  code paths for several messages in one poll (matching by `gmail_message_id`
  rather than by position in `Restore Email Context`) are written for it and
  reviewed, but not exercised here.

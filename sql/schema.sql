-- ---------------------------------------------------------------------------
-- Operations schema for the n8n support desk.
--
-- This is a SEPARATE database from the one n8n uses for its own executions and
-- credentials. Keep them apart: you will want to drop and reload this one while
-- testing, and you never want to do that to n8n's internal tables.
--
--   createdb support_ops
--   psql -d support_ops -f sql/schema.sql
--
-- Safe to re-run. Every object is IF NOT EXISTS, and the seed articles at the
-- bottom upsert on their slug.
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- articles - the business knowledge base the agent answers from
--
-- This is the whole "generate AI replies using my business content" half of the
-- brief. Retrieval is Postgres full-text search: a generated tsvector column
-- and a GIN index over it. No vector database, no embedding API, no extra
-- service to keep alive - and it is honest about what it is. It matches words
-- and their stems, not meaning, which is the right trade for a knowledge base
-- of a few hundred articles written in the same vocabulary the customers use.
--
-- The title is weighted 'A' and the body 'B' so an article whose TITLE is about
-- refunds outranks one that merely mentions the word once in passing. That
-- weighting is why ts_rank is worth using at all.
--
-- search_tsv is GENERATED ALWAYS: it cannot drift out of sync with the text,
-- because there is no code path that writes one without the other. A trigger
-- would have been the older way to do this and is one deploy away from being
-- forgotten on a new table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS articles (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug        text        NOT NULL UNIQUE,
    title       text        NOT NULL,
    category    text        NOT NULL,
    body        text        NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),

    search_tsv  tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(body,  '')), 'B')
    ) STORED
);

-- Without this index every question is a sequential scan of the whole knowledge
-- base. That is survivable at ten articles and is not at ten thousand, and the
-- day it stops being survivable is the day support gets busy.
CREATE INDEX IF NOT EXISTS articles_search_idx ON articles USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS articles_category_idx ON articles (category);

-- ---------------------------------------------------------------------------
-- processed_messages - the Gmail idempotency ledger
--
-- WHY THE UNIQUE CONSTRAINT IS THE WHOLE POINT
--
-- The same Gmail message can reach the workflow more than once: a poll that
-- overlaps the previous one, a workflow reactivated after a crash, an execution
-- retried by hand, or the trigger's own boundary-inclusive `after:` query
-- returning a message it has already delivered. Without a guard, the customer
-- gets the same automated reply twice, which is worse than getting none.
--
-- The obvious guard - "SELECT to see if we have handled this, then INSERT" -
-- does not work, because two deliveries can be in flight at the same moment.
-- Both run the SELECT before either runs the INSERT, both see "not processed",
-- and both reply.
--
-- A UNIQUE constraint closes that window because the check and the write are
-- the same operation, adjudicated by Postgres under a row lock. Exactly one of
-- the concurrent INSERTs creates the row; the other gets zero rows back from
-- ON CONFLICT DO NOTHING, which the workflow reads as "someone else already has
-- this" and exits cleanly. There is no interval for a second worker to slip
-- into.
--
-- The key is Gmail's own message id, not the RFC 5322 Message-ID header: the
-- header is written by the sender and a sender can repeat it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS processed_messages (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    gmail_message_id  text        NOT NULL,
    thread_id         text        NOT NULL,
    rfc_message_id    text,
    from_address      text        NOT NULL,
    subject           text,
    received_at       timestamptz,
    claimed_at        timestamptz NOT NULL DEFAULT now(),

    -- The line that prevents the double reply.
    CONSTRAINT processed_messages_gmail_id_uniq UNIQUE (gmail_message_id)
);

CREATE INDEX IF NOT EXISTS processed_messages_thread_idx
    ON processed_messages (thread_id, claimed_at DESC);

-- ---------------------------------------------------------------------------
-- support_decisions - every decision, both channels, both outcomes
--
-- This is what you read when the client asks "why did the bot say that", and
-- what you group by to decide whether SUPPORT_CONFIDENCE_THRESHOLD can come
-- down. A row is written on the non-support branch too: "routed out" has to be
-- reversible, and it is only reversible if there is a record of what was routed
-- out and why.
--
-- decision_key is unique for the same reason processed_messages is: a replayed
-- execution must correct one row rather than append a second, contradictory
-- one. For email it is the Gmail message id; for chat it is the session id plus
-- a SHA-256 of the visitor's message, because a chat widget has no upstream id
-- of its own and two visitors must never collide on the same key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_decisions (
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    decision_key         text        NOT NULL,
    channel              text        NOT NULL CHECK (channel IN ('email', 'chat')),
    from_address         text,
    subject              text,
    conversation_ref     text        NOT NULL,   -- Gmail threadId, or the chat session id
    intent               text,
    is_support           boolean     NOT NULL,
    confidence           numeric(4,3),
    grounded             boolean     NOT NULL DEFAULT false,
    touches_money        boolean     NOT NULL DEFAULT false,
    -- The customer's own words, kept so a follow-up on the same thread can be
    -- retrieved against what was actually asked last time. Without it, thread
    -- history is a list of the agent's own answers and every follow-up
    -- retrieves the article the agent already used.
    inbound_text         text,
    action               text        NOT NULL
                                     CHECK (action IN ('auto_replied',
                                                       'routed_out_not_support',
                                                       'handed_to_human')),
    reply_text           text,
    used_article_ids     bigint[]    NOT NULL DEFAULT '{}',
    reason               text,
    -- Set when an outbound call failed and the workflow carried on down a
    -- degraded path. A green execution with a value in here is the thing you
    -- want to find on Monday morning.
    integration_error    text,
    execution_id         text,
    created_at           timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT support_decisions_key_uniq UNIQUE (decision_key)
);

CREATE INDEX IF NOT EXISTS support_decisions_conversation_idx
    ON support_decisions (conversation_ref, created_at);
CREATE INDEX IF NOT EXISTS support_decisions_action_idx
    ON support_decisions (action, created_at DESC);
CREATE INDEX IF NOT EXISTS support_decisions_degraded_idx
    ON support_decisions (created_at DESC)
    WHERE integration_error IS NOT NULL;

-- ---------------------------------------------------------------------------
-- chat_sessions / chat_messages - the live chat transcript
--
-- The widget holds a session id in localStorage and sends it with every
-- message. That is what makes the second question in a conversation answerable
-- in the light of the first: workflow 02 loads the last CHAT_HISTORY_TURNS rows
-- of chat_messages for the session and passes them to the answer engine as
-- history.
--
-- A session id arrives from the browser, so it is attacker-controlled. It is
-- only ever used as an opaque key - never interpolated into SQL, never trusted
-- as identity - and the length CHECK stops a visitor from filling the table
-- with one 4MB key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_sessions (
    session_id      text PRIMARY KEY CHECK (length(session_id) BETWEEN 8 AND 128),
    visitor_email   text,
    first_page_url  text,
    started_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id  text        NOT NULL REFERENCES chat_sessions (session_id) ON DELETE CASCADE,
    role        text        NOT NULL CHECK (role IN ('visitor', 'agent')),
    content     text        NOT NULL,
    grounded    boolean,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- History is always read as "the last N turns of this session, oldest first",
-- so index exactly that.
CREATE INDEX IF NOT EXISTS chat_messages_session_idx
    ON chat_messages (session_id, created_at);

-- ---------------------------------------------------------------------------
-- human_review_queue - what the agent refused to answer
--
-- Every item the confidence gate turns away lands here, on both channels. The
-- unique key is the same decision_key as support_decisions, so a replayed
-- execution cannot open a second ticket for one customer message - the duplicate
-- ticket being the thing that makes an agent look broken to the humans behind
-- it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS human_review_queue (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    decision_key       text        NOT NULL,
    channel            text        NOT NULL CHECK (channel IN ('email', 'chat')),
    conversation_ref   text        NOT NULL,
    from_address       text,
    subject            text,
    question           text        NOT NULL,
    reason             text        NOT NULL,
    confidence         numeric(4,3),
    suggested_answer   text,
    status             text        NOT NULL DEFAULT 'open'
                                   CHECK (status IN ('open', 'answered', 'dropped')),
    created_at         timestamptz NOT NULL DEFAULT now(),
    resolved_at        timestamptz,

    CONSTRAINT human_review_queue_key_uniq UNIQUE (decision_key)
);

CREATE INDEX IF NOT EXISTS human_review_queue_open_idx
    ON human_review_queue (created_at)
    WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- unanswered_questions - the knowledge base's own to-do list
--
-- When retrieval finds nothing above KB_RELEVANCE_FLOOR, or the model reports
-- it could not answer from the passages it was given, the question is written
-- here. This is a feature, not an error log: it is the list of articles the
-- business has not written yet, ordered by how often customers ask for them.
--
-- The unique key is a SHA-256 of the normalised question, so the same question
-- asked fifty times is one row with asked_count = 50 rather than fifty rows
-- nobody reads. ON CONFLICT DO UPDATE, not DO NOTHING, precisely so the counter
-- and last_asked_at keep moving.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS unanswered_questions (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    question_hash     text        NOT NULL,
    question          text        NOT NULL,
    channel           text        NOT NULL CHECK (channel IN ('email', 'chat')),
    conversation_ref  text,
    reason            text        NOT NULL,
    asked_count       integer     NOT NULL DEFAULT 1,
    first_asked_at    timestamptz NOT NULL DEFAULT now(),
    last_asked_at     timestamptz NOT NULL DEFAULT now(),
    article_written   boolean     NOT NULL DEFAULT false,

    CONSTRAINT unanswered_questions_hash_uniq UNIQUE (question_hash)
);

CREATE INDEX IF NOT EXISTS unanswered_questions_gap_idx
    ON unanswered_questions (asked_count DESC, last_asked_at DESC)
    WHERE article_written = false;

-- ---------------------------------------------------------------------------
-- failures - every execution that died, written by workflow 04
--
-- Slack is for the person on shift; this table is for the Monday review. Slack
-- history is not a dataset - you cannot ask it "which node failed most often
-- last month", and it is where post-incident detail goes to be forgotten.
--
-- The unique index is partial because a manual execution has no id to
-- deduplicate on: two manual failures must both be recorded, while an
-- at-least-once Error Trigger delivery for the same production execution must
-- not be.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS failures (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow_id        text,
    workflow_name      text,
    execution_id       text,
    execution_url      text,
    failed_node        text,
    error_name         text,
    error_message      text,
    error_description  text,
    error_stack        text,
    execution_mode     text,
    retry_of           text,
    input_excerpt      text,
    alert_delivered    boolean     NOT NULL DEFAULT false,
    occurred_at        timestamptz NOT NULL DEFAULT now(),
    reviewed_at        timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS failures_execution_uniq
    ON failures (execution_id)
    WHERE execution_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS failures_unreviewed_idx
    ON failures (occurred_at DESC)
    WHERE reviewed_at IS NULL;

COMMIT;

-- ---------------------------------------------------------------------------
-- Reporting views. These are what a weekly client report is built from.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW support_desk_daily AS
SELECT date_trunc('day', created_at)::date                                   AS day,
       channel,
       count(*)                                                              AS messages,
       count(*) FILTER (WHERE action = 'auto_replied')                       AS auto_replied,
       count(*) FILTER (WHERE action = 'handed_to_human')                    AS handed_to_human,
       count(*) FILTER (WHERE action = 'routed_out_not_support')             AS routed_out,
       round(100.0 * count(*) FILTER (WHERE action = 'auto_replied')
             / nullif(count(*) FILTER (WHERE is_support), 0), 1)             AS deflection_pct,
       round(avg(confidence) FILTER (WHERE is_support), 3)                   AS avg_confidence
  FROM support_decisions
 GROUP BY 1, 2
 ORDER BY 1 DESC, 2;

-- The gaps in the knowledge base, most-asked first. Hand this to whoever writes
-- the help centre; every row is an article that would have deflected a ticket.
CREATE OR REPLACE VIEW kb_gaps AS
SELECT question,
       channel,
       reason,
       asked_count,
       first_asked_at,
       last_asked_at
  FROM unanswered_questions
 WHERE article_written = false
 ORDER BY asked_count DESC, last_asked_at DESC;

-- ---------------------------------------------------------------------------
-- Seed knowledge base.
--
-- Harbourly is a fictional small SaaS - invoicing and payment collection for
-- freelancers - chosen because its support inbox has the two shapes that matter
-- here: questions with a factual answer in the docs, and questions about money
-- that must never be answered by a bot.
--
-- Replace these ten rows with the client's own help-centre content. Nothing in
-- the workflows knows anything about Harbourly; every fact the agent states
-- comes out of this table.
-- ---------------------------------------------------------------------------
INSERT INTO articles (slug, title, category, body) VALUES
('free-trial-length',
 'How long is the free trial and what happens when it ends',
 'billing',
 'Every new Harbourly account starts on a 14-day free trial of the Studio plan. '
 'No card is required to start the trial. We send a reminder email three days before it ends and again on the last day. '
 'When the trial ends the account moves to the Solo plan automatically and stays there until a card is added; '
 'invoices you have already sent stay live and your clients can still pay them. '
 'Nothing is deleted when a trial ends.'),

('plans-and-pricing',
 'Plans and pricing',
 'billing',
 'Harbourly has three plans. Solo is free and covers up to 3 active clients and 5 invoices a month. '
 'Studio is 12 GBP a month or 120 GBP a year and covers unlimited clients, recurring invoices, and automatic payment reminders. '
 'Agency is 39 GBP a month or 390 GBP a year and adds up to 10 team seats, client-level permissions and the API. '
 'All prices exclude VAT. Annual billing is two months cheaper than monthly.'),

('change-or-cancel-plan',
 'Changing or cancelling your plan',
 'billing',
 'You can change plan at any time from Settings then Billing then Change plan. '
 'Upgrades take effect immediately and we charge the pro-rated difference for the rest of the current period. '
 'Downgrades take effect at the end of the current billing period, so you keep the features you have paid for. '
 'Cancelling is the same screen: choose Cancel subscription. The account stays active until the end of the period and then moves to the free Solo plan. '
 'We do not delete your invoices or clients when you cancel.'),

('refund-policy',
 'Refund policy',
 'billing',
 'Harbourly refunds any subscription payment in full within 14 days of the charge, for any reason, no questions asked. '
 'After 14 days we refund unused whole months on annual plans at our discretion. '
 'Refunds are issued to the original card and take 5 to 10 working days to appear, depending on the bank. '
 'Refunds are handled by a person, not automatically: email support and a human will confirm the amount before anything is returned.'),

('payment-reminders',
 'Automatic payment reminders',
 'invoicing',
 'Studio and Agency accounts can send automatic reminders on unpaid invoices. '
 'The default schedule is three days before the due date, on the due date, and then 3, 7 and 14 days after it. '
 'You can change the schedule per client under Clients then the client then Reminders, or turn reminders off for a single invoice from the invoice page. '
 'Reminders stop immediately when an invoice is marked paid, including when it is paid by card through the invoice link.'),

('accepting-card-payments',
 'Accepting card payments on an invoice',
 'payments',
 'Connect Stripe under Settings then Payments to let clients pay an invoice by card or bank debit. '
 'Connecting takes about two minutes and uses your existing Stripe account; Harbourly never sees the card details. '
 'Stripe fees apply as normal and Harbourly adds no fee of its own on any plan. '
 'Payouts arrive on your usual Stripe schedule. An invoice paid by card is marked paid in Harbourly within a few seconds of the payment succeeding.'),

('vat-and-tax',
 'VAT, tax rates and reverse charge',
 'invoicing',
 'Set your default VAT rate under Settings then Tax. You can override the rate per invoice line. '
 'For EU business clients outside your own country, tick Reverse charge on the client record and Harbourly adds the required wording to the invoice and leaves the VAT at zero. '
 'Harbourly does not file your VAT return and is not tax advice; the numbers are yours to check.'),

('export-your-data',
 'Exporting your invoices, clients and payments',
 'account',
 'Settings then Data then Export produces a ZIP containing every invoice as a PDF, plus CSV files of clients, invoices and payments. '
 'The export runs in the background and we email a download link when it is ready, usually within a few minutes. '
 'The link is valid for 24 hours. There is no limit on how often you can export and it is available on every plan, including the free one.'),

('two-factor-authentication',
 'Turning on two-factor authentication',
 'account',
 'Settings then Security then Two-factor authentication. Harbourly supports any TOTP authenticator app such as 1Password, Authy or Google Authenticator. '
 'Save the ten recovery codes we show you when you turn it on; they are shown once. '
 'If you lose both your authenticator and your recovery codes, a human has to verify your identity before the account can be unlocked, which takes one working day. '
 'Agency owners can require two-factor authentication for every seat on the account.'),

('api-and-rate-limits',
 'The Harbourly API and its rate limits',
 'integrations',
 'The REST API is available on the Agency plan. Create a key under Settings then API. '
 'The base URL is https://api.harbourly.example/v1 and every request needs an Authorization Bearer header. '
 'The limit is 120 requests a minute per key, burstable to 300; over the limit you get HTTP 429 with a Retry-After header. '
 'Webhooks are available for invoice.sent, invoice.paid and invoice.overdue, and we retry a failing endpoint for 24 hours with exponential backoff.')
ON CONFLICT (slug) DO UPDATE
   SET title = excluded.title,
       category = excluded.category,
       body = excluded.body,
       updated_at = now();

-- ---------------------------------------------------------------------------
-- Useful checks once this is live.
-- ---------------------------------------------------------------------------

-- What the desk did today, by channel.
--   SELECT * FROM support_desk_daily WHERE day = current_date;

-- The articles the business has not written yet, most-asked first.
--   SELECT * FROM kb_gaps LIMIT 20;

-- Green executions that quietly degraded - an outbound call failed and the
-- workflow carried on down a fallback path.
--   SELECT created_at, channel, conversation_ref, action, integration_error
--     FROM support_decisions
--    WHERE integration_error IS NOT NULL
--    ORDER BY created_at DESC;

-- Which node breaks most often.
--   SELECT workflow_name, failed_node, count(*)
--     FROM failures
--    WHERE occurred_at > now() - interval '7 days'
--    GROUP BY 1, 2
--    ORDER BY 3 DESC;

-- Does retrieval actually find an article for this question?
--   SELECT id, title, ts_rank(search_tsv, websearch_to_tsquery('english', 'how do I turn on 2fa')) AS relevance
--     FROM articles
--    WHERE search_tsv @@ websearch_to_tsquery('english', 'how do I turn on 2fa')
--    ORDER BY relevance DESC;

# Process diagram

Four workflows. Two of them are doors — Gmail and the website chat widget — one
is the shared backend both doors call, and one catches everything that breaks.

GitHub renders the Mermaid below directly. If you are reading this in an editor
that does not, paste any block into <https://mermaid.live>.

---

## 1. How the four fit together

```mermaid
flowchart LR
    subgraph doors["The two doors"]
        direction TB
        GM["<b>01 — Email Support Agent</b><br/>Gmail Trigger, polls every minute"]
        CH["<b>02 — Live Chat Agent</b><br/>POST /webhook/chat/message"]
    end

    subgraph backend["The shared backend"]
        AE["<b>03 — Answer Engine</b><br/>Execute Workflow Trigger"]
    end

    KB[("articles<br/>tsvector + GIN")]
    LLM{{"OpenAI-compatible<br/>/chat/completions"}}
    DB[("support_ops<br/>decisions · queue · gaps")]
    ERR["<b>04 — Error Trigger Alerts</b>"]
    SLACK{{"Slack incoming webhook"}}

    GM -- "{channel, text, thread id, history}" --> AE
    CH -- "{channel, text, session id, history}" --> AE
    AE -- "{grounded, answer, confidence,<br/>used_article_ids, escalate_reason}" --> GM
    AE -- same --> CH

    AE --> KB
    AE --> LLM
    GM --> LLM
    GM --> DB
    CH --> DB
    AE --> DB

    GM -. "settings.errorWorkflow" .-> ERR
    CH -. "settings.errorWorkflow" .-> ERR
    AE -. "settings.errorWorkflow" .-> ERR
    ERR --> SLACK
    ERR --> DB

    classDef door fill:#1b2236,stroke:#6d8cff,color:#e8ebf2
    classDef core fill:#12251d,stroke:#46d08a,color:#e8ebf2
    classDef ext fill:#241b28,stroke:#b07dd8,color:#e8ebf2
    class GM,CH door
    class AE core
    class LLM,SLACK ext
```

The arrow that matters is the one from both doors into **one** box. Workflow 03
is the same n8n workflow id in both cases, not a copy of the same logic — so an
article added, a prompt changed or a relevance floor moved takes effect on both
channels at once, and the two can never drift apart.

---

## 2. Workflow 01 — Email Support Agent

```mermaid
flowchart TD
    T["Gmail Trigger<br/><i>unread, every minute</i>"] --> C["Capture Email Fields<br/><i>sender · subject · body · threadId<br/>· gmail id · RFC Message-ID<br/>+ money/legal/anger sweep</i>"]
    C --> CLAIM["Claim This Message<br/><i>INSERT ... ON CONFLICT DO NOTHING</i>"]
    CLAIM --> FIRST{"First delivery<br/>of this message?"}
    FIRST -- "no rows" --> EXIT(["Duplicate Delivery — Exit<br/><i>green, silent, no reply</i>"])
    FIRST -- "one row" --> REST["Restore Email Context"]

    REST --> CLS["Classify: Support Or Not<br/><i>LLM, strict json_schema</i>"]
    CLS -- error --> DOWN["Classifier Unavailable<br/><i>fails safe to a human</i>"]
    CLS --> SWEEP["Apply Keyword Sweep<br/><i>can only add caution</i>"]
    SWEEP --> ISSUP{"Is this a<br/>support request?"}

    ISSUP -- "no" --> LNOT["Label As Not Support"]
    LNOT --> DROUT["Build Decision<br/>(Routed Out)"]
    DROUT --> LOG[("Log Decision")]

    ISSUP -- "yes" --> HIST["Load Thread History<br/><i>earlier turns on this threadId</i>"]
    HIST --> REQ["Build Engine Request"]
    REQ --> ENG["Ask The Answer Engine<br/><i>workflow 03</i>"]
    ENG --> COMB["Combine Answer<br/>And Classification<br/><i>confidence = min of the two</i>"]
    COMB --> GATE{"Confidence Gate<br/><i>grounded AND answer<br/>AND ≥ threshold<br/>AND not money</i>"}

    GATE -- "pass" --> REPLY["Reply In The Same Thread<br/><i>threadId + In-Reply-To + References</i>"]
    REPLY --> LREP["Label As Auto Replied"]
    LREP --> DRAUTO["Build Decision<br/>(Auto Replied)"]
    DRAUTO --> LOG
    REPLY -- error --> RFAIL["Handover: Reply Failed"]

    GATE -- "fail" --> HAND["Build Handover<br/><i>one place the reason is written</i>"]
    DOWN --> HAND
    RFAIL --> HAND
    HAND --> LHUM["Label As Needs Human"]
    LHUM --> QUEUE[("Queue For A Human")]
    QUEUE --> SLACK["Alert The Review Channel"]
    SLACK --> DRHUM["Build Decision<br/>(Handed To Human)"]
    DRHUM --> LOG

    classDef gate fill:#2a2213,stroke:#e0a33e,color:#e8ebf2
    classDef stop fill:#2a1717,stroke:#e06b6b,color:#e8ebf2
    class FIRST,ISSUP,GATE gate
    class EXIT stop
```

Every Gmail, HTTP and Slack node above has `retryOnFail`, three tries and an
error output. Where the diagram shows one arrow out of `Label As Not Support`,
`Label As Auto Replied`, `Label As Needs Human` and `Alert The Review Channel`,
the file wires **both** outputs to the same next node: a labelling or alerting
failure must not lose the decision row, and the row records what failed.

---

## 3. Workflow 02 — Live Chat Agent

```mermaid
flowchart TD
    W["Chat Webhook<br/><i>POST /webhook/chat/message</i>"] --> V["Verify Shared Secret<br/><i>timingSafeEqual · session id shape<br/>· money keyword sweep</i>"]
    V --> S[("Open Or Touch Session")]
    S --> H[("Load Recent Turns<br/><i>last CHAT_HISTORY_TURNS</i>")]
    H --> REQ["Build Engine Request"]
    REQ --> ENG["Ask The Answer Engine<br/><i>workflow 03 — the same one</i>"]
    ENG --> COMB["Combine Answer And Session"]
    COMB --> GATE{"Confidence Gate<br/><i>the same four conditions</i>"}

    GATE -- "pass" --> CA["Compose Reply"]
    GATE -- "fail" --> CH["Compose Handover Reply<br/><i>says so plainly, offers a person</i>"]
    CA --> RDY["Reply Ready"]
    CH --> RDY
    RDY --> RESP["<b>Respond To Visitor</b><br/><i>the answer, in the body of<br/>the visitor's own POST</i>"]

    RESP --> LOG[("Log Decision")]
    LOG --> PERSIST[("Persist Both Turns<br/><i>visitor + agent, one statement</i>")]
    PERSIST --> NEEDS{"Needs a human?"}
    NEEDS -- "no" --> DONE(["Answered Without A Human"])
    NEEDS -- "yes" --> Q[("Queue For A Human")]
    Q --> SL["Alert The Review Channel"]
    SL --> REC[("Record Alert Outcome")]

    classDef gate fill:#2a2213,stroke:#e0a33e,color:#e8ebf2
    class GATE,NEEDS gate
```

Everything below **Respond To Visitor** happens after the browser already has
the answer. Logging, persistence, the ticket and the Slack alert are not on the
visitor's critical path and should never be.

---

## 4. Workflow 03 — Answer Engine (the shared backend)

```mermaid
flowchart TD
    T["When Called By Another Workflow<br/><i>{channel, text, session_or_thread_id, history}</i>"] --> N["Normalise Request<br/><i>strips quoted reply blocks<br/>· expands the query with the<br/>previous visitor turn</i>"]
    N --> R[("Retrieve Passages<br/><i>ts_rank over articles, ORed terms</i>")]
    R --> F["Apply Relevance Floor<br/><i>KB_RELEVANCE_FLOOR</i>"]
    F --> ANY{"Anything<br/>retrieved?"}

    ANY -- "no" --> NOMATCH["Result: No Article Matched"]
    ANY -- "yes" --> LLM["Answer From Passages<br/><i>the passages and nothing else</i>"]
    LLM -- error --> UNAVAIL["Result: Answer Engine Unavailable"]
    LLM --> VAL["Validate Answer<br/><i>drops citations that were<br/>never retrieved · derives<br/>confidence from ts_rank</i>"]
    VAL --> GR{"Answered from the<br/>knowledge base?"}
    GR -- "yes" --> OK["Result: Grounded Answer"]
    GR -- "no" --> NOTKB["Result: Not Answerable<br/>From The Knowledge Base"]

    NOMATCH --> UNG["Ungrounded Result"]
    NOTKB --> UNG
    UNAVAIL --> UNG
    UNG --> GAP[("Record Unanswered Question<br/><i>upserts a counter — the<br/>knowledge base's to-do list</i>")]

    OK --> RET["Return To Caller"]
    GAP --> RET

    classDef gate fill:#2a2213,stroke:#e0a33e,color:#e8ebf2
    class ANY,GR gate
```

`Record Unanswered Question` deliberately writes nothing when the reason was an
outage. A model that was down is not a question the help centre failed to
answer, and mixing the two makes the gap list untrustworthy on the one day
somebody actually reads it.

---

## 5. Workflow 04 — Error Trigger Alerts

```mermaid
flowchart LR
    E["Error Trigger"] --> F["Format Alert<br/><i>workflow · node · error<br/>· item in flight · execution link</i>"]
    F --> S["Alert Ops Channel"]
    S -- "delivered" --> R[("Record Failure<br/><i>alert_delivered = true</i>")]
    S -- "Slack refused" --> R2[("Record Failure<br/><i>alert_delivered = false</i>")]
```

Both outputs land on the same node. Slack being down during an incident is not
unusual — it is correlated with everything else being down — and the row has to
be written either way, with a column saying which.

---

## 6. The chat round trip, end to end

```mermaid
sequenceDiagram
    autonumber
    participant V as Visitor's browser
    participant WG as chat-widget.js
    participant N as n8n — workflow 02
    participant PG as Postgres
    participant AE as n8n — workflow 03
    participant M as Model

    V->>WG: types a question, presses Enter
    WG->>WG: session id from localStorage<br/>(created on first visit)
    WG->>N: POST /webhook/chat/message<br/>x-chat-secret, {session_id, message, page_url}
    N->>N: Verify Shared Secret (constant time)<br/>validate session id shape<br/>money keyword sweep
    N->>PG: upsert chat_sessions
    N->>PG: last CHAT_HISTORY_TURNS of chat_messages
    PG-->>N: history, oldest first

    N->>AE: Execute Workflow {channel:"chat", text, session id, history}
    AE->>PG: ts_rank over articles
    PG-->>AE: top-k passages with relevance
    alt nothing above KB_RELEVANCE_FLOOR
        AE->>PG: upsert unanswered_questions
        AE-->>N: {grounded:false, escalate_reason:"no_matching_article"}
    else passages found
        AE->>M: chat/completions — passages + strict json_schema
        M-->>AE: {answer, used_article_ids, answered_from_kb, missing_info}
        AE->>AE: drop citations that were not retrieved<br/>derive confidence from the used passage's rank
        AE-->>N: {grounded, answer, confidence, used_article_ids}
    end

    N->>N: Confidence Gate — grounded AND answer<br/>AND confidence ≥ threshold AND not money
    alt gate passes
        N-->>WG: 200 {reply, grounded:true, used_article_ids}
    else gate fails
        N-->>WG: 200 {reply:"I could not find that…", handed_to_human:true}
    end
    WG->>V: renders the reply and the round-trip time

    Note over N,PG: everything below runs after the browser already has the answer
    N->>PG: support_decisions (one row, either branch)
    N->>PG: chat_messages — visitor turn and agent turn, one statement
    opt handed to a human
        N->>PG: human_review_queue
        N->>N: Alert The Review Channel (Slack)
    end
```

Measured on the proof run: **159 ms** from the browser's POST leaving to the
answer being rendered, with nothing injected; **4217 ms** for the same question
when the model endpoint returned HTTP 500 twice before succeeding.

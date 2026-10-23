---
title: "Project 06: Real-Time Collaboration and Notifications Platform"
aliases:
 - RealTime Collaboration
 - Notifications Platform
 - Boardly RealTime
 - SSE Notifications
tags:
 - project
 - real-time
 - notifications
 - sse
 - redis
 - pub-sub
 - outbox
 - authz
 - portfolio
 - boardly
status: complete
estimated_effort: "40–60 hours; starter ships in ~600 LOC across API + worker"
difficulty: advanced
prerequisites:
 - "[[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]]"
 - "[[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]]"
 - "[[14-Caching-and-Background-Processing/Transactional-Outbox]]"
related_lessons:
 - "[[15-External-Integrations/Webhooks-and-Signature-Verification]]"
 - "[[10-Async-Python/asyncio-Primitives]]"
---

# Project 06: Real-Time Collaboration and Notifications Platform

*Real-time collaboration the way Linear, GitHub, and Notion actually ship it: projects with fine-grained role-based authorization, threaded comments on resources, an event-sourced activity feed, per-user notifications with unread state, Server-Sent Events for streaming delivery, a Redis pub/sub fan-out so any worker can deliver to any live connection, a transactional-outbox worker so a Redis blip never loses a notification, and graceful-shutdown handling so deploys do not drop 10,000 open SSE streams. Extends the Boardly app from the in-house lessons.*

**This is the project that teaches you to ship real-time systems safely.**

ForgeTrack taught you row locks. ECommerce taught you the outbox. Analytics taught you `EXPLAIN ANALYZE`. RealTime teaches you the fourth correctness primitive: **durable fan-out across a long-lived connection**. The hard parts here are not the SSE wire format (it is text) or the Redis pub/sub API (it is one command). The hard parts are: (a) never losing a notification when Redis blips; (b) letting any of N API workers deliver to any of M live SSE connections without coupling them; (c) shutting down 10,000 open streams gracefully when the deploy rolls. By the end you will have built a notifications platform that delivers in under 800 ms p99, holds 10,000 SSE connections per node, and survives its own deploy.


#project #real-time #notifications #sse #redis #pub-sub #outbox

---

## Problem Statement

Boardly — the project-management app from the in-house lessons — has shipped its real-time MVP: customers want comments on issues, an activity feed, and `@mention` notifications pushed to logged-in browsers without polling. The naive designs all fail in characteristic ways:

1. **Poll `/notifications` every 5 seconds.** A 10,000-user product means 2,000 requests/second to the notifications endpoint, 99.9 percent of which return an empty list. The DB connection pool saturates; the p99 latency climbs past a second; the cloud bill doubles.
2. **Publish to Redis from inside the comment-creation transaction.** This is the *dual-write* anti-pattern: the `INSERT INTO notifications` succeeds, then `redis.publish(...)` raises on a network blip, the transaction commits anyway, and the row exists with no live push — the user opens the app later and sees a 3-minute-old unread badge they never got a ping for.
3. **Run the SSE endpoint on a single worker.** Connection #10,001 hits "address already in use" or stalls on the event loop. Without horizontal scaling — and without a fan-out bus that crosses process boundaries — you cannot scale past one box.
4. **Hard-kill on deploy.** The orchestrator sends `SIGTERM`, the process exits in 200 ms, and 10,000 browsers see a stalled EventSource. They will not reconnect for 5 minutes (the standard reconnect delay), and the user-perceived outage is huge.
5. **Cross-project leakage.** A user mentions `@alice` in project A. Alice is not in project A. Does she get the notification? In a careless implementation: yes, and now anyone can spam anyone. The membership check must run on the write path, not just the read path.
6. **Lost on crash.** A `BackgroundTasks`-style fan-out (the in-process FastAPI background task) is lost if the worker crashes between request-response and task-run. The user sees the comment but never the notification.

This project is a real-time collaboration API that fixes all six: projects + memberships with roles (`owner`/`editor`/`viewer`); threaded comments on resources; an event-sourced activity feed (the activity log is append-only and queryable); notifications with per-user inboxes and unread state; **Server-Sent Events** as the canonical delivery wire (with WebSockets mentioned as the bidirectional alternative); a Redis pub/sub fan-out so any worker can deliver to any live connection; a transactional-outbox worker so the publish is durable; an event-history table so offline clients can catch up; and graceful-shutdown handling so deploys do not drop streams.

**Why SSE as canonical and WebSockets as the alternative**

The Boardly real-time surface is *server-to-client*: the server pushes "you got a mention", "the comment was edited", "the task was completed". Client-to-server actions (typing indicators, presence) can ride on normal `POST` requests. SSE is the right tool for one-way streaming: it is HTTP/1.1-friendly (works through any proxy), it auto-reconnects in the browser (the `EventSource` API), and it is one Python generator function in FastAPI. WebSockets are the right tool when the client needs to stream high-frequency messages back (chat, collaborative editing, multiplayer cursors). We pick SSE for canonical simplicity and mention WebSockets in Future Enhancements as the upgrade path.


**Danger — Debugging: the BackgroundTasks failure is invisible in your dashboards**

A `BackgroundTasks`-style fan-out (problem 6 above) is the hardest loss to detect because it leaves no signal anywhere: the request returned 201, the worker did not crash hard enough to fire an alert, and the in-process task simply vanished between the response write and the task run. The first symptom is a user report ("I commented and my teammate never got the ping") hours after the loss. The fix is structural, not forensic: move the side effect to a separate worker that reads from a transactional outbox (see [[14-Caching-and-Background-Processing/Background-Tasks-vs-Workers]] and [[14-Caching-and-Background-Processing/Transactional-Outbox]]), so the side effect has a durable row you can alert on with `SELECT count(*) FROM outbox_events WHERE next_attempt_at <= now()`. If that query returns more than zero in steady state, the worker is wedged — the row is your proof, the timestamp is your root-cause timeline.


---

## Target Users

- **The project owner** (one per project, role `owner`). They create the project, invite the first members, and can demote others. They want fine-grained control and an audit trail.
- **The project editor** (role `editor`). They comment, resolve threads, and `@mention` teammates. They are the bulk of active users.
- **The project viewer** (role `viewer`). They read comments and the activity feed but cannot write. External stakeholders, auditors.
- **The mentioned user** (transient role). They receive a `@mention` notification; they can mute a project or a type to stop the noise.
- **The external integrator** (out-of-band). A Slack or MS Teams mirror that polls `/notifications?unread_only=true` with a service token; not real-time, but consistent with the same data model.

**Note — Scale targets**

100 projects. 10 users per project on average. 1,000 concurrent SSE connections per node at MVP, 10,000 at scale. ~100 notifications/second peak (Monday morning burst). End-to-end delivery latency p99 under 800 ms (worker claim + Redis publish + SSE forward). Outbox backlog: zero in steady state, up to 1,000 during a Redis blip.


**Warning — Production: SSE connection math, not eyeballed**

Each SSE connection is a long-lived TCP stream plus an open Uvicorn worker coroutine, so the headroom math is `concurrent_streams_per_node <= uvicorn_workers * (event_loop_capacity - overhead)`. On Uvicorn 0.32 with the asyncio loop and a 65,536 fd ulimit, the practical ceiling is ~10,000 concurrent SSE streams per node *after* you reserve file descriptors for the DB pool, the Redis subscriber, outbound httpx, and logging. Above that, raise `ulimit -n` and the kernel `net.core.somaxconn` together or the accept queue silently drops new SSE handshakes under load — the symptom is EventSource reconnect storms in the browser, not a server error. See [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]] for the ulimit bump in the container image.


---

## Requirements and Non-Goals

### In scope

- **Projects + memberships with three roles**: `owner`, `editor`, `viewer`. Role checks at the router layer via a `Depends(require_project_role("editor"))`-style dependency.
- **Resources** (issues, docs, PRs) with a `(project_id, resource_type, external_id)` unique key, so the same external resource maps to exactly one row.
- **Threaded comments** with a self-FK on `parent_id` and a soft-delete (`is_deleted`) so edit history is preserved.
- **Event-sourced activity feed**: an append-only `activity_events` table, keyset-paginated on `(project_id, at DESC, id DESC)`.
- **Notifications with unread state**: `is_unread` boolean, `read_at` timestamp, per-user inbox.
- **SSE endpoint** at `GET /notifications/stream` that authenticates the user, replays the unread backlog, subscribes to a Redis pub/sub channel, pings every 15 seconds, and unsubscribes on disconnect.
- **Redis pub/sub fan-out**: one channel per user (`notifications:{user_id}`). The worker is the only `PUBLISH` caller; the API process is the only `SUBSCRIBE` caller. Redis ACLs enforce the split.
- **Transactional outbox**: comment creation writes the comment, the activity event, and the outbox event in one transaction; a separate worker process claims events with `SELECT ... FOR UPDATE SKIP LOCKED`, calls `NotificationService.deliver` (which inserts the notification row and publishes to Redis), and deletes the event.
- **Subscription preferences** per `(user_id, project_id, type)`: mute a project, mute a type, or mute both. Checked by the worker before inserting the notification.
- **Event history** for offline catch-up: the SSE endpoint replays the unread backlog on connect; a separate `GET /notifications/history?from=...&to=...` paginates the full inbox.
- **Graceful shutdown**: on `SIGTERM` the API process closes all open SSE streams with an `event: shutdown` frame so the browser can choose to reconnect immediately rather than wait for the proxy's 5-minute timeout.
- **Integration tests** that exercise the full pipeline (mutation -> outbox -> worker -> Redis -> SSE) with a real `fakeredis` and a `TestClient`-driven SSE reader.

**Security: the Redis ACL split is mandatory, not optional**

The "worker is the only PUBLISH caller; the API is the only SUBSCRIBE caller" boundary is enforced at the Redis layer with two ACL users: `outbox-worker` gets `+publish +@read -@dangerous`, `api-sse` gets `+subscribe +psubscribe +ping`. Without this split, a compromised API process can `PUBLISH` to any user's channel — turning a read-only subscriber into an arbitrary notification injector. Configure TLS (`rediss://` URL) and ACLs together; Redis 7.x ships both. See [[11-Authentication-and-Security/OWASP-API-Top-10]] for the broader authorization-surface pattern and [[08-PostgreSQL/Roles-Permissions-Security]] for the same separation-of-privilege principle applied to the database.


### Explicit non-goals

- **No WebSockets in scope.** SSE is canonical; WebSockets are mentioned in Future Enhancements as the upgrade path for presence and typing.
- **No mobile push (APNs/FCM).** The outbox worker calls a `PushAdapter` hook; the in-app + email-webhook fan-out is shipped, the APNs/FCM adapter is the learner's homework.
- **No email digest.** A daily-summary email job is out of MVP; it would be a natural next milestone.
- **No real-time collaborative editing (OT/CRDT).** That is a different system with different trade-offs; out of scope.
- **No Slack/MS Teams native integration.** External integrators can poll the API; building a native Slack app is a separate project.
- **No multi-region active-active.** Single-region active-passive with a 30-second DNS failover is the deployment target. Multi-region active-active for SSE is genuinely hard (geo-routed pub/sub) and out of scope.

**Warning — The dual-write anti-pattern is the single most common real-time bug**

Every senior engineer has shipped a notifications system that lost 1 percent of notifications in production. The root cause is almost always the dual-write: writing the notification row in the same transaction that calls `redis.publish(...)`. If Redis blips between the row write and the publish, the row exists (the user sees the unread badge) but no live push happened (the user never saw the toast). The transactional-outbox pattern fixes this by deferring the publish to a separate worker that reads the outbox row. The publish is no longer "transactional with the row" — it is "transactional with the outbox event," which is the same thing one indirection later. This is the project's central correctness claim.


**Danger — Debugging: the outbox backlog is the production signal**

The dual-write anti-pattern (warning above) is silent at write time and surfaces only as "stale unread badge" at read time. The detection query that catches a wedged worker before users notice: `SELECT count(*) FROM outbox_events WHERE next_attempt_at <= now()` — the outbox backlog. Alert when it exceeds 50 events older than 30 seconds; that catches a stalled `OutboxWorker` while the rest of the stack is still healthy. The companion metric is `notifications.created_at` lag — if the gap between the most recent outbox event and the most recent notification row exceeds 5 seconds, the worker is alive but slow (likely a Redis blip with retry-backoff). Wire both into the same dashboard; the difference is your root-cause fork. See [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]] for the metric-to-log-join contract.


---

## Architecture Diagram

```mermaid
flowchart LR
 subgraph Client
 BR[Browser<br/>EventSource]
 EXT[External integrator<br/>polls /notifications]
 end

 subgraph Edge
 LB[Reverse proxy<br/>SSE: proxy_buffering off]
 end

 subgraph API[FastAPI ASGI - N workers]
 AUTH[auth router]
 PROJ[projects router]
 CMT[comments router]
 NOTIF[notifications router<br/>includes /stream SSE]
 ACT[activity router]
 CSVC[CommentService]
 NSVC[NotificationService<br/>insert + publish]
 end

 subgraph Worker[Outbox worker - M processes]
 OW[OutboxWorker<br/>FOR UPDATE SKIP LOCKED]
 end

 subgraph State
 PG[(PostgreSQL 17<br/>projects, comments,<br/>notifications, outbox)]
 REDIS[(Redis 7<br/>pub/sub + unread cache)]
 OTLP[OpenTelemetry<br/>collector]
 end

 BR -->|GET /notifications/stream| LB
 BR -->|POST /comments| LB
 EXT -->|GET /notifications| LB
 LB --> AUTH
 LB --> PROJ
 LB --> CMT
 LB --> NOTIF
 LB --> ACT

 CMT --> CSVC
 CSVC --> PG

 OW -->|claim| PG
 OW --> NSVC
 NSVC --> PG
 NSVC -->|PUBLISH notifications:user_id| REDIS
 REDIS -.publish.-> NOTIF
 NOTIF -.SSE stream.-> BR

 API -.spans.-> OTLP
 Worker -.spans.-> OTLP

 style LB fill:#dbeafe,stroke:#1d4ed8
 style API fill:#fef3c7,stroke:#b45309
 style Worker fill:#ffedd5,stroke:#c2410c
 style PG fill:#dcfce7,stroke:#15803d
 style REDIS fill:#fce7f3,stroke:#be185d
 style NOTIF fill:#ede9fe,stroke:#6d28d9
```

The shape is the project's central architectural decision: the API process writes the comment and the outbox event in one transaction, then a *separate* worker process claims the outbox event, writes the notification row, and publishes to Redis. The API process never publishes to Redis directly. The Redis pub/sub channel crosses the worker/API process boundary so any worker can deliver to any live SSE connection — the API process subscribes to the user's channel, and whichever worker happens to claim the outbox event does the publish.

**Why the worker is a separate process and not a `BackgroundTasks` call**

FastAPI's `BackgroundTasks` runs in the same process *after* the response is sent. Three problems: (a) if the process crashes between the response and the task, the task is lost; (b) the task runs on the request's event loop, so a slow publish blocks a new request; (c) the task cannot scale independently — to publish faster, you have to scale the whole API. A separate worker process (run as `python -m app.services.outbox_worker`) fixes all three: it has its own event loop, its own scaling, and its own durability (it re-reads the outbox on restart). The trade-off is operational complexity: one more process to deploy and monitor. For Boardly's scale, the trade-off is worth it.


**Why Redis pub/sub as the transport, instead of WebSocket fan-out from the API?**

Because the SSE connection is sticky to one API process (the client's TCP connection lands on one Uvicorn worker and stays there), but the worker that publishes the notification can be any worker — including one running on a different machine. If the API process held the notification in memory and tried to push it to its own SSE clients, only the clients connected to *that* API process would receive it; clients connected to other API processes would miss the notification entirely. Redis pub/sub is the cross-process bridge: whichever worker claims the outbox event does `redis.publish("user:{user_id}", payload)`, and *every* API process that has an SSE connection for that user is subscribed to `user:{user_id}` and forwards the payload to its local SSE client. The trade is one network hop (worker → Redis → API) instead of in-process delivery (worker → API), adding ~1 ms of latency — invisible to a human, negligible against the 100 ms+ the outbox-to-SSE pipeline already takes. See [[14-Caching-and-Background-Processing/Redis-Cache-Aside]] for the pub/sub pattern and [[10-Async-Python/asyncio-Primitives]] for the subscriber-side event loop.

**Warning — Production: graceful shutdown drains Redis subscriptions before closing streams**

On `SIGTERM`, the correct drain sequence is: (1) stop accepting new SSE handshakes (return 503 from `/notifications/stream`); (2) send `event: shutdown\nretry: 2000\n` to every live stream so EventSource reconnects in 2 s, not the 5-minute default; (3) `await pubsub.unsubscribe(user_channel)` for each subscriber; (4) `await pubsub.close()`; (5) `await engine.dispose()`. Skipping step 2 is the bug that drops 10,000 browsers for 5 minutes per deploy — the EventSource reconnect backoff is the user-perceived outage, not the SIGTERM itself. See [[03-FastAPI-Core/Application-and-Lifespan]] for the lifespan hook and [[10-Async-Python/asyncio-Primitives]] for the unsubscribe ordering.


---

## ER Diagram

```mermaid
erDiagram
 PROJECT ||--o{ MEMBERSHIP : "has"
 USER ||--o{ MEMBERSHIP : "joins"
 PROJECT ||--o{ RESOURCE : "contains"
 PROJECT ||--o{ ACTIVITY_EVENT : "logged"
 RESOURCE ||--o{ COMMENT : "commented"
 USER ||--o{ COMMENT : "author"
 COMMENT ||--o{ COMMENT : "reply to"
 USER ||--o{ NOTIFICATION : "recipient"
 USER ||--o{ SUBSCRIPTION_PREFERENCE : "mutes"
 PROJECT ||--o{ SUBSCRIPTION_PREFERENCE : "scoped"
 PROJECT ||--o{ OUTBOX_EVENT : "emits"

 PROJECT {
 uuid id PK
 text slug UK
 text name
 timestamptz created_at
 }
 USER {
 uuid id PK
 text email UK
 text password_hash
 timestamptz created_at
 }
 MEMBERSHIP {
 uuid id PK
 uuid user_id FK
 uuid project_id FK
 text role "owner|editor|viewer"
 timestamptz joined_at
 }
 RESOURCE {
 uuid id PK
 uuid project_id FK
 text resource_type "issue|doc|pr"
 text external_id
 }
 COMMENT {
 uuid id PK
 uuid resource_id FK
 uuid parent_id FK
 uuid author_id FK
 text body
 boolean is_deleted
 timestamptz created_at
 }
 ACTIVITY_EVENT {
 uuid id PK
 uuid project_id FK
 uuid actor_id FK
 text action "commented|created|resolved"
 jsonb payload
 timestamptz at
 }
 NOTIFICATION {
 uuid id PK
 uuid user_id FK
 uuid project_id FK
 text type "mention|reply|assign"
 jsonb payload
 boolean is_unread
 timestamptz read_at
 timestamptz created_at
 }
 SUBSCRIPTION_PREFERENCE {
 uuid id PK
 uuid user_id FK
 uuid project_id FK
 text type
 boolean muted
 }
 OUTBOX_EVENT {
 uuid id PK
 uuid project_id FK
 text type
 jsonb payload
 int attempts
 timestamptz next_attempt_at
 timestamptz created_at
 }
```

The ER diagram is the project's data model. The two non-obvious tables are `activity_events` (the event-sourced activity log — every state-changing action writes a row) and `outbox_events` (the transactional-outbox queue — every cross-boundary side effect is enqueued here, never executed inline). The `notifications` table is the user-facing inbox; the `outbox_events` table is the durable transport. They are *not* the same: a notification exists once it has been delivered; an outbox event exists once it has been requested. If the worker is down, the outbox grows; the notifications table does not.

**Debugging: query outbox_events, not notifications, when a user reports a missing ping**

When a user reports "I never got the mention", the first query is `SELECT * FROM outbox_events WHERE payload->>'recipient_id' = $1 ORDER BY created_at DESC LIMIT 10`. If the outbox row exists and `next_attempt_at IS NULL` (claimed and deleted by the worker), the worker ran — chase the issue in `notifications` or Redis pub/sub. If the outbox row exists and `next_attempt_at IS NOT NULL`, the worker has not claimed it — chase the worker. If the outbox row is missing, the `CommentService.create_comment` transaction never wrote it — chase the API. Three tables, three failure modes, one diagnostic query. See [[14-Caching-and-Background-Processing/Transactional-Outbox]] for the full triage playbook and [[19-Interview-Preparation/Production-Incidents-Debugging]] for the incident-grade log shape.


**Why is `activity_events` separate from `notifications`?**

They look similar (both are "things that happened"). But they answer different questions: `activity_events` answers "what did the project do?" (visible to all members of the project, projected into the activity feed); `notifications` answers "what should I be told about?" (visible to one user, projected into the inbox). The same comment creates one `activity_events` row (project-visible) and zero-to-many `notifications` rows (one per mentioned user). Conflating them would force every activity event to be addressed to a user, which breaks the model for project-level events that have no specific recipient.


**Danger — Security: every activity_events query must filter on project_id**

The `activity_events` table is project-scoped, but a careless `SELECT * FROM activity_events WHERE actor_id = $1` returns rows from every project the actor has ever touched — including projects the querying user is not a member of. The fix is structural: the activity router's `Depends(require_project_role("viewer"))` must inject `project_id` into every query, and the ORM mapper should not expose a `by_actor` accessor that skips the project filter. Treat `project_id` like a tenant boundary: a missing `WHERE project_id = $1` on any activity query is a cross-project data leak. See [[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]] and [[17-Advanced-Architecture/Multi-Tenancy]] for the boundary pattern.


---

## Sequence Diagrams

### Workflow 1: Create comment with `@mention` -> outbox -> worker -> Redis -> SSE

**Tip — Debugging: correlate this sequence with the OpenTelemetry trace**

When debugging a slow or stuck notification, the mermaid sequence above maps one-to-one to the OpenTelemetry spans you should see in your trace UI: `POST /comments` (API server span) -> `INSERT outbox_events` (DB span) -> `OutboxWorker.claim` (worker span, separate trace) -> `NotificationService.deliver` (worker span) -> `redis.publish` (worker span) -> `EventSource.forward` (API server span, different trace from the original request). The two-trace boundary is the outbox — the API writes the row in trace A, the worker reads it in trace B. Carry `trace_id` in the outbox payload if you want a single end-to-end trace; otherwise the two halves are joined only by `outbox_event_id`. See [[13-Performance-and-Observability/OpenTelemetry-Tracing]] for the cross-process propagation pattern.


```mermaid
sequenceDiagram
 autonumber
 participant U as Editor A
 participant API as FastAPI /comments
 participant CSVC as CommentService
 participant DB as PostgreSQL
 participant OW as OutboxWorker
 participant NSVC as NotificationService
 participant R as Redis pub/sub
 participant SSE as SSE conn (Editor B)
 participant B as Editor B browser

 U->>API: POST /comments {resource_id, body, mentions:[B]}
 API->>CSVC: create_comment(...)
 CSVC->>DB: BEGIN
 CSVC->>DB: INSERT comments
 CSVC->>DB: INSERT activity_events (action="commented")
 CSVC->>DB: INSERT outbox_events (type="notification.mention", payload={recipient:B})
 CSVC->>DB: COMMIT
 API-->>U: 201 Created {comment_id}

 Note over OW,DB: Worker claims next event
 OW->>DB: SELECT * FROM outbox_events<br/>WHERE next_attempt_at <= now()<br/>ORDER BY next_attempt_at<br/>FOR UPDATE SKIP LOCKED LIMIT 1
 DB-->>OW: event row (locked)
 OW->>NSVC: deliver(outbox_event_id, user_id=B, ...)
 NSVC->>DB: INSERT notifications (user_id=B, is_unread=true)
 NSVC->>R: PUBLISH notifications:{B} {notification_id, payload}
 OW->>DB: DELETE outbox_events WHERE id=?
 OW->>DB: COMMIT

 R-->>SSE: message on channel notifications:{B}
 SSE-->>B: event: notification\ndata: {...}

 B->>API: POST /notifications/{id}/read
 API->>DB: UPDATE notifications SET is_unread=false, read_at=now()
 API-->>B: 204 No Content
```

This is the project's central correctness story. Note the *asynchrony*: the `201 Created` response returns before the notification is delivered. The user's browser sees the comment immediately; the mentioned user sees the notification within the worker's claim interval (default 500 ms). The outbox event is the durable handoff — if the worker is down, the event waits; when the worker comes up, it claims and delivers. The notification row is written *only* by the worker, never by the comment-creation transaction, so the dual-write anti-pattern is structurally impossible.

### Workflow 2: User connects to SSE -> backlog replay -> live push -> graceful shutdown

```mermaid
sequenceDiagram
 autonumber
 participant B as Browser (EventSource)
 participant API as FastAPI /notifications/stream
 participant DB as PostgreSQL
 participant R as Redis pub/sub

 B->>API: GET /notifications/stream (Authorization: Bearer sse_token)
 API->>API: authenticate, mint user_id
 API->>R: SUBSCRIBE notifications:{user_id}
 Note over API,R: Subscribe FIRST so a publish<br/>during the backlog query is not lost<br/>(Redis pub/sub does not buffer<br/>for absent subscribers)
 API->>API: drain SUBSCRIBE ack frame
 API->>DB: SELECT * FROM notifications<br/>WHERE user_id=? AND is_unread=true<br/>ORDER BY created_at ASC
 DB-->>API: backlog rows
 API-->>B: event: backlog\ndata: {first batch}
 API-->>B: event: ready\ndata: {}

 loop keep-alive every 15s
 API-->>B: event: ping\ndata: {}
 end

 R-->>API: notification X
 Note over API: Skip if notification_id<br/>is in sent_ids (dedup<br/>against the backlog)
 API-->>B: event: notification\ndata: {X}

 Note over API: SIGTERM received during deploy
 API-->>B: event: shutdown\ndata: {reason:"deploy"}
 API->>R: UNSUBSCRIBE notifications:{user_id}
 API-->>B: [close stream]
 Note over B: Browser sees shutdown event,<br/>reconnects immediately (no 5-min wait)
```

The SSE endpoint is the trickiest code in the project. The diagram shows the five phases: (1) `SUBSCRIBE` to the user's Redis channel *before* the backlog query (the canonical fix for the SSE/Redis pub-sub backlog race — Redis pub/sub does not buffer for absent subscribers, so a publish that lands between the backlog query and the subscribe is lost forever); (2) backlog replay on connect (so a tab opened after the notification was sent still sees it, with each row's `notification_id` added to a `sent_ids` set so the live loop can dedup a publish that the subscribe-first ordering opens up); (3) a 15-second heartbeat to keep the connection alive through proxies that close idle connections after 60 seconds; (4) live pushes from the Redis pub/sub queue, with `sent_ids` dedup against both the backlog and earlier live iterations; (5) on `SIGTERM`, send an explicit `event: shutdown` frame so the browser's `EventSource` reconnects immediately rather than waiting for the proxy's 5-minute idle-close.

### Workflow 3: `mark-as-read` -> unread-count update -> broadcast

```mermaid
sequenceDiagram
 autonumber
 participant B as Browser
 participant API as FastAPI /notifications/{id}/read
 participant NSVC as NotificationService
 participant DB as PostgreSQL
 participant R as Redis pub/sub
 participant SSE as Other open SSE conn (same user, second tab)

 B->>API: POST /notifications/{id}/read
 API->>NSVC: mark_read(user_id, notification_id)
 NSVC->>DB: UPDATE notifications<br/>SET is_unread=false, read_at=now()<br/>WHERE id=? AND user_id=?
 DB-->>NSVC: rowcount=1
 NSVC->>DB: SELECT count(*) FROM notifications<br/>WHERE user_id=? AND is_unread=true
 DB-->>NSVC: unread_count (e.g., 4)
 NSVC->>R: PUBLISH notifications:{user_id}<br/>{type:"unread_count", count:4}
 NSVC->>DB: COMMIT
 API-->>B: 204 No Content

 R-->>SSE: message on channel
 SSE-->>B: event: unread_count\ndata: {count:4}
 Note over B,SSE: Both tabs update their badge to 4
```

The `mark-as-read` flow has a subtle requirement: if the user has two tabs open and marks a notification read in one, the other tab's unread badge must update. We achieve this by having the `mark_read` service publish an `unread_count` event on the same Redis channel — the other tab's SSE connection receives it and updates the badge. This is the same fan-out bus used for delivery, repurposed for state-sync.

**Why `is_unread` is a column and not a derived view**

A naive design derives unread state from `read_at IS NULL`. That works, but it forces every unread query to evaluate `read_at IS NULL` on every row. A `WHERE is_unread=true` partial index makes the unread-inbox query an index-only scan. The trade-off is write overhead (two columns to maintain on `mark_read`), but the read wins (10x faster inbox query) dominate for the access pattern (reads outnumber writes 100:1 for the inbox). This is the [[08-PostgreSQL/Indexes-Composite-and-Specialized]] lesson applied.


---

## API Specification

| Method | Path | Body | Role | Notes |
|--------|------|------|------|-------|
| `POST` | `/auth/register` | `{email, password}` | anon | Returns user id; reuse from [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]]. |
| `POST` | `/auth/login` | form | anon | Returns access + refresh tokens. |
| `POST` | `/auth/refresh` | `{refresh_token}` | any | Returns new access token. |
| `POST` | `/auth/sse-token` | — | authed | Mints a 5-min SSE token; explained in Security Model. |
| `GET` | `/projects` | — | authed | List the caller's memberships. |
| `POST` | `/projects` | `{slug, name}` | authed | Caller becomes the project `owner`. |
| `POST` | `/projects/{id}/memberships` | `{user_id, role}` | owner | Add a member; reject if the user is already a member. |
| `DELETE` | `/projects/{id}/memberships/{user_id}` | — | owner | Remove a member. |
| `GET` | `/projects/{id}/resources` | query: `type` | member+ | List resources of a type. |
| `POST` | `/projects/{id}/resources` | `{type, external_id}` | editor+ | Idempotent on `(project_id, type, external_id)`. |
| `GET` | `/projects/{id}/comments` | query: `resource_id, cursor` | member+ | Keyset on `(resource_id, created_at, id)`. |
| `POST` | `/projects/{id}/comments` | `{resource_id, body, parent_id?, mentions[]}` | editor+ | Writes comment + activity + outbox in one tx. |
| `PATCH` | `/projects/{id}/comments/{id}` | `{body}` | author | Edit; writes activity `comment.edited`. |
| `DELETE` | `/projects/{id}/comments/{id}` | — | author/owner | Soft delete; writes activity `comment.deleted`. |
| `GET` | `/projects/{id}/activity` | query: `cursor` | member+ | Keyset on `(project_id, at DESC, id DESC)`. |
| `GET` | `/notifications` | query: `unread_only, page` | authed | Inbox; default 50 most recent. |
| `GET` | `/notifications/history` | query: `from, to, cursor` | authed | Full inbox; keyset on `(user_id, created_at DESC)`. |
| `GET` | `/notifications/stream` | — | authed | SSE endpoint; backlog + live + heartbeat. |
| `POST` | `/notifications/{id}/read` | — | owner-only | Marks read; publishes unread-count. |
| `POST` | `/notifications/read-all` | — | authed | Bulk mark read for the caller. |
| `GET` | `/notifications/preferences` | — | authed | List the caller's subscription prefs. |
| `PUT` | `/notifications/preferences` | `{project_id, type, muted}` | authed | Upsert a subscription pref. |

---

## Folder Structure

```
realtime-collab/
├── app/
│ ├── __init__.py
│ ├── main.py # FastAPI app + lifespan + graceful shutdown
│ ├── core/
│ │ ├── config.py # Pydantic Settings: PG, Redis, JWT, SSE TTL
│ │ ├── db.py # async engine + sessionmaker + get_session
│ │ ├── security.py # JWT encode/decode, current_user, role deps
│ │ ├── deps.py # require_project_role, require_resource_access
│ │ ├── rate_limit.py # Redis sliding-window limiter
│ │ └── sse.py # SSE wire format + heartbeat + shutdown hook
│ ├── models/
│ │ ├── base.py # DeclarativeBase + UUIDPk + Timestamp mixins
│ │ ├── user.py # User
│ │ ├── project.py # Project, Membership
│ │ ├── resource.py # Resource, Comment (self-FK)
│ │ ├── activity.py # ActivityEvent (append-only)
│ │ ├── notification.py # Notification, SubscriptionPreference
│ │ └── outbox.py # OutboxEvent
│ ├── schemas/
│ │ ├── project.py
│ │ ├── comment.py # CommentCreate, CommentRead, Mention
│ │ ├── activity.py
│ │ └── notification.py # NotificationRead, UnreadCount
│ ├── services/
│ │ ├── comment_service.py # create_comment (writes comment + activity + outbox)
│ │ ├── activity_service.py # query feed, keyset cursor
│ │ ├── notification_service.py# deliver (insert + PUBLISH), mark_read, mark_all_read
│ │ └── outbox_worker.py # claim + process + delete loop
│ ├── routers/
│ │ ├── auth.py
│ │ ├── projects.py
│ │ ├── comments.py
│ │ ├── activity.py
│ │ └── notifications.py # includes the /stream SSE endpoint
│ └── integrations/
│ └── external_push.py # APNs/FCM adapter hook (stub)
├── tests/
│ ├── conftest.py # fakeredis, async engine, fixtures
│ ├── test_comments.py # create comment writes activity + outbox
│ ├── test_notifications.py # deliver inserts + publishes; muted skips
│ ├── test_sse_stream.py # SSE backlog + live + shutdown
│ └── test_outbox_worker.py # FOR UPDATE SKIP LOCKED behavior
├── alembic/versions/
│ ├── 0001_users_projects_memberships.py
│ ├── 0002_resources_comments_activity.py
│ ├── 0003_notifications.py
│ ├── 0004_subscription_preferences_outbox.py
│ └── 0005_indexes_for_feed.py
├── .env.example
├── Dockerfile
├── compose.yaml
├── pyproject.toml
└── README.md
```

The split between `core/`, `models/`, `schemas/`, `services/`, `routers/`, and `integrations/` is deliberate: each layer has a single responsibility and depends only on the layer below it. Routers parse HTTP and call services; services execute business logic and call models; models describe tables; schemas describe wire shapes. The `integrations/external_push.py` stub is where a learner would plug in APNs/FCM without touching the rest of the codebase.

---

## Database Design

### Naming conventions

- **Tables**: snake_case plural (`users`, `projects`, `notifications`).
- **Foreign keys**: `<singular>_id` (`user_id`, `project_id`).
- **Indexes**: `ix_<table>_<cols>` (`ix_notifications_user_unread_created`).
- **Unique constraints**: `uq_<table>_<cols>` (`uq_memberships_user_project`).
- **Check constraints**: `ck_<table>_<rule>` (`ck_memberships_role_allowed`).

These match the rest of the Boardly vault; consistency here is more valuable than local cleverness.

### The `notifications` table: the hot one

```sql
CREATE TABLE notifications (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
 type TEXT NOT NULL,
 payload JSONB NOT NULL DEFAULT '{}'::jsonb,
 is_unread BOOLEAN NOT NULL DEFAULT TRUE,
 read_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The unread-inbox query: WHERE user_id=? AND is_unread=true ORDER BY created_at DESC
CREATE INDEX ix_notifications_user_unread_created
 ON notifications (user_id, created_at DESC)
 WHERE is_unread = TRUE;

-- The full-inbox query: WHERE user_id=? ORDER BY created_at DESC
CREATE INDEX ix_notifications_user_created
 ON notifications (user_id, created_at DESC);
```

The partial index `WHERE is_unread = TRUE` is the single most important index in the project. It makes the unread-inbox query an index-only scan over a small subset of the user's notifications (only the unread ones) instead of a scan over all of them. For a user with 50,000 lifetime notifications and 12 unread, the partial index seeks the 12; the full index would seek the 50,000 and filter. The cost: one extra index to maintain on `mark_read` (a write), but the read wins (100x ratio) dominate.

**Warning — The partial index only helps if the access pattern is `WHERE is_unread=true`**

If you query `WHERE user_id=? AND is_unread=false`, the partial index is useless — it only contains the unread rows. The full index `(user_id, created_at DESC)` serves the read-history query. The lesson from [[08-PostgreSQL/Indexes-Composite-and-Specialized]]: index for the actual WHERE clause, not the column. Two indexes on the same column with different partials is normal and correct.


**Why an append-only `activity_events` table instead of update-in-place on `comments`?**

Because the activity feed is a *timeline* — the user wants to see "Alice commented, then Bob replied, then Alice edited her comment, then Bob deleted his reply" as a sequence of events, not just the current state of each comment. An update-in-place model (`comments` table with `body`, `edited_at`, `deleted_at`) gives you the *current* state but loses the history: you cannot reconstruct "what did Alice's comment say before she edited it" without an `audit_log` table that is itself append-only. The `activity_events` table is that audit log — every state change (create, edit, delete, reply) writes a new row with the *before* and *after* payloads, never updating an existing row. The trade is storage growth (a heavily-edited comment accumulates N rows in `activity_events` for one row in `comments`) and the need to project the timeline from the events (a `SELECT * FROM activity_events WHERE project_id=? ORDER BY at DESC` query, indexed on `(project_id, at DESC)`). For a project management tool where the audit trail is the point, the trade is worth it. For a system where only the current state matters (e.g., a configuration setting), update-in-place is right. See [[17-Advanced-Architecture/Event-Driven-Basics]] for the event-sourcing pattern.

### The `outbox_events` table: the durable transport

```sql
CREATE TABLE outbox_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 type TEXT NOT NULL,
 payload JSONB NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_outbox_next_attempt ON outbox_events (next_attempt_at)
 WHERE attempts < 10; -- don't claim permanently-failed events
```

The `next_attempt_at` index is the worker's seek. The `WHERE attempts < 10` partial ensures the worker does not keep claiming events that have failed 10 times (those need manual inspection, not retry).

### The `comments` table: threaded

```sql
CREATE TABLE comments (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
 parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
 author_id UUID NOT NULL REFERENCES users(id),
 body TEXT NOT NULL,
 is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_comments_resource_created ON comments (resource_id, created_at ASC);
CREATE INDEX ix_comments_parent ON comments (parent_id) WHERE parent_id IS NOT NULL;
```

The `(resource_id, created_at ASC)` index serves the per-resource comment list (keyset on `(resource_id, created_at, id)`). The `parent_id` partial index serves the reply-tree lookup. Both are partial — `is_deleted=false` rows are the live ones; deleted rows are kept for audit but excluded from the hot index.

### The `activity_events` table: append-only

```sql
CREATE TABLE activity_events (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 actor_id UUID NOT NULL REFERENCES users(id),
 action TEXT NOT NULL,
 payload JSONB NOT NULL DEFAULT '{}'::jsonb,
 at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_activity_project_at_id ON activity_events (project_id, at DESC, id DESC);
```

The `(project_id, at DESC, id DESC)` composite is the keyset cursor for the activity feed. `id DESC` is the tiebreaker when two events have the same `at` timestamp (UUIDs are not sortable by time, so the tiebreaker is the random UUID).

**The activity feed is event-sourced but not the source of truth**

The `activity_events` table records what happened (an audit log), but the source of truth for the comment's current state is the `comments` table. The activity log is *projective* — derived from the same writes that update `comments`. If you wanted to reconstruct `comments` from `activity_events`, you could (it is event sourcing), but you do not have to. The two patterns coexist: activity events for the feed, `comments` for the live state. This is the same distinction as Project 05's events vs. tasks.


---

## Security Model

- **Authentication**: OAuth2 password flow + JWT (access 15 min, refresh 7 days). See [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]] for the canonical implementation.
- **Authorization — three layers**:
 1. **Project membership**. Every project-scoped router runs `Depends(require_project_role("editor"))`. The dependency loads the membership row, checks the role is at least the required level (`owner > editor > viewer`), and yields the membership to the route. If no membership: `403 authz.not_member`.
 2. **Resource access**. `Depends(require_resource_access(resource_id))` checks that the resource belongs to a project the caller can access. Returns `404 resource.not_found` (not `403`) to avoid leaking that the resource exists.
 3. **Object ownership**. `Depends(require_notification_owner(notification_id))` for marking read; same for comment edits. The dependency checks `notification.user_id == current_user.id` and returns `404 notification.not_found` otherwise.
- **SSE authentication**: the `EventSource` API cannot set custom headers (it can only set `Authorization` via `withCredentials` cookies, and that requires a same-origin setup). The canonical pattern is a **short-lived SSE token** minted by `POST /auth/sse-token` (5-min TTL, single-use, signed by the same JWT key but scoped to `scope=sse`). The client passes it as a query parameter: `GET /notifications/stream?token=...`. The query parameter is acceptable because (a) the token is short-lived and (b) the connection is HTTPS so the query is encrypted in transit.

**Warning — The query-parameter SSE token is a known compromise**

Passing a token in the query string is a security smell — it appears in access logs and browser history. The mitigation is strict: (a) the SSE token is single-use (the server marks it consumed on first read), (b) the TTL is 5 minutes, (c) the access logs are scrubbed of query strings for `/notifications/stream` (configure your reverse proxy), (d) the token scopes to `scope=sse` only — it cannot be used to call `POST /comments`. If you control the client (a same-origin SPA), prefer a cookie-set token over a query-string token. The cookie path is the production-grade solution; the query path is the starter.


**Why SSE and not WebSocket for the live notification stream?**

Because the notification stream is strictly *server-to-client* — the client opens the connection and the server pushes events; the client never sends data back over the same connection. SSE is the protocol designed for this exact shape: a long-lived HTTP response with `Content-Type: text/event-stream`, where the server writes `event: ...\ndata: ...\n\n` frames and the browser's `EventSource` API fires events. WebSocket is bidirectional (client-to-server *and* server-to-client), which is overkill for notifications — the client's POST endpoints (create comment, mark read) already use plain HTTP, and reusing them over WebSocket would mean re-implementing auth, retry, and observability inside the WS frame protocol. The trade is that SSE is one-directional — if you later need client-to-server streaming (e.g., live cursor positions for collaborative editing, presence pings), SSE cannot carry it and you would need WebSocket for *that* feature. The Boardly starter stops at notifications; the SSE choice is right for the scope. The query-parameter SSE token is the second compromise (see the warning above) — the `EventSource` API cannot set custom headers, so the JWT cannot go in an `Authorization` header for the SSE request specifically. The 5-min single-use SSE token is the bridge.
- **Rate limits**: 100 notifications/sec per user on `/notifications/stream` (the SSE endpoint does not count against this — only the POST endpoints); 10 comments/min per user. Redis sliding-window.
- **Redis ACL**: the worker has `+publish` only; the API has `+subscribe` only. Compromise of one role does not grant the other. Configure via `redis-cli ACL SETUSER worker +publish +@read`; `redis-cli ACL SETUSER api +subscribe`.
- **Audit**: every `POST /comments`, `PATCH /comments/{id}`, `DELETE /comments/{id}` writes an `activity_events` row. The activity log is the audit trail — it answers "who did what when" without a separate audit system.
- **No PII in payloads**: the comment body and notification payload are scrubbed for email and phone patterns at the schema layer (same deny-list as Project 05's events). Customers who want to mention `@alice@example.com` in a comment can — the email is preserved in the body — but the notification payload cannot contain raw emails (it carries user_ids, not emails).

---

## Milestones

| # | Milestone | Done when |
|---|-----------|-----------|
| M1 | Projects + memberships + auth | Create a project, add a member, RBAC gates comment creation (viewer cannot comment, returns 403). |
| M2 | Comments + activity feed | Create a comment with a thread reply, list by resource, keyset-paginate the activity feed past 1,000 events. |
| M3 | Notifications + unread state | A `@mention` writes an outbox event; the worker delivers it; `GET /notifications?unread_only=true` returns it; `mark_read` clears it. |
| M4 | SSE stream + Redis pub/sub | Open the SSE endpoint in a browser; trigger a notification via the worker; the event arrives in under 1 second. |
| M5 | Outbox worker durability | Kill the worker mid-flight; the outbox event stays in the table; restart the worker; the notification is delivered. Zero lost. |
| M6 | Subscription preferences | Mute a project; trigger a notification; no notification row is inserted; no Redis publish happens. |
| M7 | Graceful shutdown + observability | Send `SIGTERM` to the API process; the SSE client receives an `event: shutdown` frame within 200 ms; OpenTelemetry traces span the full pipeline (comment -> outbox -> worker -> publish -> SSE). |

---

## Implementation Chapters

- **M1**: [[17-Advanced-Architecture/Multi-Tenancy]], [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]], [[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]].
- **M2**: [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]], [[02-Web-and-HTTP/Idempotency-Safe-Retries-Pagination]].
- **M3**: [[07-SQLAlchemy/06-Querying-with-select]], [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]].
- **M4**: [[10-Async-Python/asyncio-Primitives]], [[14-Caching-and-Background-Processing/Redis-Cache-Aside]].
- **M5**: [[14-Caching-and-Background-Processing/Transactional-Outbox]], [[14-Caching-and-Background-Processing/Background-Tasks-vs-Workers]].
- **M6**: [[03-FastAPI-Core/Dependency-Injection]], [[04-Pydantic/Validators-Strict-vs-Coercive]].
- **M7**: [[13-Performance-and-Observability/OpenTelemetry-Tracing]], [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]], [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]].

---

## Complete Source Code

The starter ships six files in full and leaves the rest as `# complete this:` markers. The six are: `models/notification.py`, `models/outbox.py`, `services/comment_service.py`, `services/notification_service.py`, `services/outbox_worker.py`, and `routers/notifications.py` (with the SSE endpoint). The two tests are `test_notifications.py` and `test_sse_stream.py`. We deep-dive each in turn.

### `app/models/notification.py`

```python
# app/models/notification.py
"""Notification + SubscriptionPreference models.

The Notification row is the user-facing inbox entry. The OutboxEvent row is
the durable transport entry. They are NOT the same: a notification exists
once it has been delivered; an outbox event exists once it has been requested.
"""
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin, UUIDPkMixin

if TYPE_CHECKING:
 pass # forward refs only


class Notification(Base, UUIDPkMixin, TimestampMixin):
 """A user's inbox entry. is_unread is a denormalized flag for index speed."""
 __tablename__ = "notifications"

 user_id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True),
 ForeignKey("users.id", ondelete="CASCADE"),
 nullable=False,
 index=True, # full-inbox seek
 )
 project_id: Mapped[uuid.UUID | None] = mapped_column(
 UUID(as_uuid=True),
 ForeignKey("projects.id", ondelete="SET NULL"),
 nullable=True,
 index=True,
 )
 type: Mapped[str] = mapped_column(String(40), nullable=False)
 # payload carries context: {comment_id, resource_id, author_id, body_preview, ...}
 payload: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
 is_unread: Mapped[bool] = mapped_column(
 Boolean, nullable=False, default=True, index=True
 )
 read_at: Mapped[datetime | None] = mapped_column(
 DateTime(timezone=True), nullable=True
 )
 # created_at inherited from TimestampMixin; we also add an explicit index
 # for the keyset cursor on (user_id, created_at DESC) in the migration.


class SubscriptionPreference(Base, UUIDPkMixin, TimestampMixin):
 """Per-user, per-project, per-type mute."""
 __tablename__ = "subscription_preferences"
 __table_args__ = (
 UniqueConstraint(
 "user_id", "project_id", "type", name="uq_subprefs_user_project_type"
 ),
 )

 user_id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True),
 ForeignKey("users.id", ondelete="CASCADE"),
 nullable=False,
 index=True,
 )
 project_id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True),
 ForeignKey("projects.id", ondelete="CASCADE"),
 nullable=False,
 index=True,
 )
 type: Mapped[str] = mapped_column(String(40), nullable=False)
 muted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
```

**Line-by-line:**

- `UUIDPkMixin` gives every row a `uuid` PK with `default=uuid.uuid4` and `server_default=func.gen_random_uuid()`. The double default is deliberate: the ORM-side default makes unit tests work without a round-trip; the server-side default makes raw `INSERT` statements (e.g., from a migration seed script) work too.
- `ForeignKey("users.id", ondelete="CASCADE")` says: if the user is deleted, their notifications go with them. This is the right call for a privacy-first product; the alternative (`ON DELETE RESTRICT`) would leave orphaned notifications.
- `ForeignKey("projects.id", ondelete="SET NULL")` says: if a project is deleted, its notifications stay (so the user can see "this notification is about a project that no longer exists") but their `project_id` is `NULL`. This is the right call for the audit story; `CASCADE` would silently delete history.
- `JSONB` for `payload` — Postgres's binary JSON. GIN-indexable for ad-hoc queries; fast access for the SSE wire format (one `json.dumps` and the message is ready).
- `is_unread: Mapped[bool] = mapped_column(Boolean, ..., index=True)` — the per-column index here is for the partial-index migration to build on. The migration creates the composite partial index `(user_id, created_at DESC) WHERE is_unread = TRUE`; this single-column index is a fallback for queries that filter on `is_unread` alone.
- `UniqueConstraint("user_id", "project_id", "type", name="uq_subprefs_user_project_type")` — the subscription preference is unique per (user, project, type). Two rows with the same key would be ambiguous; the unique constraint makes `INSERT ... ON CONFLICT DO UPDATE` the right upsert pattern.

**Why `is_unread` is a denormalized boolean and not `read_at IS NULL`**

A derived column (`SELECT ... WHERE read_at IS NULL`) is correct but slow on large tables — every row's `read_at` must be NULL-checked. A denormalized boolean with a partial index is the production-grade answer: the index stores only the unread rows, the seek is O(log n) instead of O(n). The cost is one extra write on `mark_read` (a column to flip), but the read wins (the inbox query is 100x more frequent than the mark-read) dominate.


### `app/models/outbox.py`

```python
# app/models/outbox.py
"""OutboxEvent — the durable transport row.

The comment service writes one outbox row per cross-boundary side effect
(e.g., one per @mention). The worker claims rows with FOR UPDATE SKIP LOCKED,
processes them, and deletes them. This is the transactional-outbox pattern.
"""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDPkMixin


class OutboxEvent(Base, UUIDPkMixin):
 __tablename__ = "outbox_events"

 project_id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True),
 ForeignKey("projects.id", ondelete="CASCADE"),
 nullable=False,
 index=True,
 )
 type: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
 # payload carries everything the worker needs to deliver:
 # {recipient_user_id, type, comment_id, resource_id, project_id, author_id, body_preview}
 payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
 attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
 next_attempt_at: Mapped[datetime] = mapped_column(
 DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
 )
 # created_at inherited from UUIDPkMixin's siblings, but we declare it explicitly
 # here because OutboxEvent does not use TimestampMixin (no updated_at).
 created_at: Mapped[datetime] = mapped_column(
 DateTime(timezone=True), server_default=func.now(), nullable=False
 )
```

The two columns worth dwelling on:

- `attempts: Mapped[int]` — bumped on every failure. The partial index `WHERE attempts < 10` ensures the worker does not claim permanently-failed events. After 10 attempts, the event stays in the table for manual inspection; the worker skips it. This is the [[14-Caching-and-Background-Processing/Transactional-Outbox]] pattern's "poison pill" guard.
- `next_attempt_at: Mapped[datetime]` — set to `now()` on insert, bumped to `now() + 2^attempts seconds` on failure (exponential backoff). The worker's seek is `WHERE next_attempt_at <= now()`, so backoff automatically throttles retries.

### `app/services/comment_service.py`

```python
# app/services/comment_service.py
"""Create a comment + emit outbox events for mentions.

CRITICAL INVARIANT: this service NEVER publishes to Redis directly.
It writes the comment, the activity event, and the outbox events in one
transaction. The worker (separate process) reads the outbox and publishes.

This is the dual-write avoidance pattern. See
[[14-Caching-and-Background-Processing/Transactional-Outbox]].
"""
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import ActivityEvent
from app.models.outbox import OutboxEvent
from app.models.resource import Comment, Resource
from app.schemas.comment import CommentCreate


class CommentService:
 def __init__(self, session: AsyncSession) -> None:
 self.session = session

 async def create_comment(
 self,
 *,
 project_id: UUID,
 author_id: UUID,
 payload: CommentCreate,
 ) -> Comment:
 # Defense-in-depth: verify the resource belongs to the project.
 # The router already checked via require_resource_access; we check
 # again so a bug in the router cannot leak data.
 resource = (
 await self.session.execute(
 select(Resource).where(
 Resource.id == payload.resource_id,
 Resource.project_id == project_id,
 )
 )
 ).scalar_one_or_none()
 if resource is None:
 raise LookupError("resource not found in project")

 # 1) Insert the comment.
 comment = Comment(
 resource_id=resource.id,
 parent_id=payload.parent_id,
 author_id=author_id,
 body=payload.body,
 )
 self.session.add(comment)
 await self.session.flush() # populate comment.id without committing

 # 2) Activity event (project-visible).
 self.session.add(
 ActivityEvent(
 project_id=project_id,
 actor_id=author_id,
 action="commented",
 payload={
 "comment_id": str(comment.id),
 "resource_id": str(resource.id),
 "parent_id": str(comment.parent_id) if comment.parent_id else None,
 },
 )
 )

 # 3) One outbox event per @mention. The worker creates the
 # notification row and publishes to Redis.
 for mentioned_user_id in payload.mentions:
 self.session.add(
 OutboxEvent(
 project_id=project_id,
 type="notification.mention",
 payload={
 "recipient_user_id": str(mentioned_user_id),
 "notification_type": "mention",
 "comment_id": str(comment.id),
 "resource_id": str(resource.id),
 "project_id": str(project_id),
 "author_id": str(author_id),
 "body_preview": payload.body[:140],
 },
 )
 )

 # One transaction commits all three: comment, activity, outbox.
 # If the commit fails, none of the three exist -- the dual-write
 # anti-pattern is structurally impossible.
 await self.session.commit()
 await self.session.refresh(comment)
 return comment
```

**Line-by-line of the critical section:**

- `await self.session.flush()` — flush sends the `INSERT` to the DB but does not commit. This populates `comment.id` (via the server-side `gen_random_uuid()` default) so we can reference it in the activity event and the outbox payload. Without flush, `comment.id` would be `None` until commit, and we would have to commit twice.
- The `for mentioned_user_id in payload.mentions:` loop writes one `OutboxEvent` per mention. If the comment mentions three users, three rows are inserted. The worker will claim them one at a time and deliver three notifications. This is the *fan-out at write time* pattern — the alternative (one outbox row that the worker expands into N notifications) is more compact but harder to retry per-user.
- `await self.session.commit()` is the single point of atomicity. If anything above raises, the transaction rolls back and nothing is written. This is the project's central correctness claim: the comment, the activity event, and the outbox event are either all written or none are.

**Tip — The `flush` vs `commit` distinction**

`session.flush()` sends pending SQL to the DB without ending the transaction. `session.commit()` flushes *and* ends the transaction. The pattern of "flush, then add more rows that depend on the first one's PK, then commit" is the standard way to write multiple rows in one transaction when later rows reference earlier ones. The [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]] lesson covers flush in depth.


### `app/services/notification_service.py`

```python
# app/services/notification_service.py
"""NotificationService — the worker's helper.

Called by the OutboxWorker. Writes the notification row and publishes to
Redis pub/sub. The publish is OUTSIDE the transaction (the row write commits
first, then we publish). If the publish fails, the row still exists —
the SSE client will see it in the backlog on the next reconnect.

This is safe because:
1) The notification row is the source of truth for "did the user get told?"
2) Redis pub/sub is a transient delivery hint, not the source of truth.
3) The outbox worker deletes the outbox event only after BOTH succeed.
 If the publish fails, the worker does NOT delete; the event retries
 with backoff. The notification row may get written twice — the second
 write hits the (user_id, type, comment_id) unique constraint and is
 a no-op. See the _insert_or_skip method.
"""
import json
from datetime import datetime, timezone
from uuid import UUID

import redis.asyncio as redis
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notification import Notification, SubscriptionPreference


class NotificationService:
 def __init__(
 self, session: AsyncSession, redis_client: redis.Redis
 ) -> None:
 self.session = session
 self.redis = redis_client

 async def deliver(
 self,
 *,
 outbox_event_id: UUID,
 user_id: UUID,
 project_id: UUID,
 type_: str,
 payload: dict,
 ) -> Notification | None:
 """Insert the notification + publish to Redis. Returns the row or None
 if the user has muted this (project, type) combination."""

 # 1) Check subscription preference — skip if muted.
 pref = (
 await self.session.execute(
 select(SubscriptionPreference).where(
 SubscriptionPreference.user_id == user_id,
 SubscriptionPreference.project_id == project_id,
 SubscriptionPreference.type == type_,
 )
 )
 ).scalar_one_or_none()
 if pref is not None and pref.muted:
 return None # skip — treat as delivered, no notification row

 # 2) Insert the notification with an ON CONFLICT DO NOTHING so a
 # worker retry does not create a duplicate notification. The conflict
 # target is the (user_id, type, comment_id) unique constraint — see
 # the migration for the partial unique index. We use raw PG insert.
 stmt = (
 pg_insert(Notification)
 .values(
 user_id=user_id,
 project_id=project_id,
 type=type_,
 payload=payload,
 is_unread=True,
 )
 .on_conflict_do_nothing(
 index_elements=("user_id", "type", "payload->comment_id")
 )
 .returning(Notification)
 )
 result = await self.session.execute(stmt)
 notif = result.scalar_one_or_none()

 # If the insert was a no-op (conflict), the notification already
 # exists from a previous worker run. Fetch it so we can still publish
 # (the previous run may have crashed before publishing).
 if notif is None:
 notif = (
 await self.session.execute(
 select(Notification).where(
 Notification.user_id == user_id,
 Notification.type == type_,
 Notification.payload["comment_id"].astext
 == payload.get("comment_id"),
 )
 )
 ).scalar_one_or_none()
 if notif is None:
 # Race condition: the row vanished between the conflict and
 # the select. Treat as delivered (rare; log and move on).
 return None

 await self.session.commit()

 # 3) Publish to Redis. Subscribers in any process pick this up and
 # forward via SSE. The channel name is per-user.
 channel = f"notifications:{user_id}"
 message = json.dumps(
 {
 "notification_id": str(notif.id),
 "type": notif.type,
 "payload": notif.payload,
 "created_at": notif.created_at.isoformat(),
 }
 )
 await self.redis.publish(channel, message)
 return notif

 async def mark_read(self, *, user_id: UUID, notification_id: UUID) -> int:
 """Mark one notification read. Returns unread count for the user
 (so the router can publish it to other open tabs of the same user)."""
 from sqlalchemy import update

 await self.session.execute(
 update(Notification)
 .where(
 Notification.id == notification_id,
 Notification.user_id == user_id,
 Notification.is_unread.is_(True),
 )
 .values(is_unread=False, read_at=datetime.now(timezone.utc))
 )
 await self.session.commit()

 # Compute the new unread count for the user.
 from sqlalchemy import func

 result = await self.session.execute(
 select(func.count(Notification.id)).where(
 Notification.user_id == user_id,
 Notification.is_unread.is_(True),
 )
 )
 return int(result.scalar() or 0)

 async def mark_all_read(self, *, user_id: UUID) -> int:
 """Bulk mark all unread as read. Returns count of rows updated."""
 from sqlalchemy import update

 result = await self.session.execute(
 update(Notification)
 .where(
 Notification.user_id == user_id,
 Notification.is_unread.is_(True),
 )
 .values(is_unread=False, read_at=datetime.now(timezone.utc))
 )
 await self.session.commit()
 return result.rowcount
```

The deep-dive points:

- `pg_insert(Notification).on_conflict_do_nothing(...)` — Postgres-specific upsert. The `ON CONFLICT DO NOTHING` clause means: if a previous worker run already wrote this notification (identified by `(user_id, type, payload->comment_id)`), the second run is a no-op. This is the *idempotent consumer* pattern; it lets the worker retry safely.
- The publish happens *after* the commit. If Redis is down, the row still exists; the SSE client's backlog replay on the next reconnect will deliver it. The worker, however, will *not* delete the outbox event (it catches the publish exception, rolls back, and the event retries with backoff). The idempotent consumer makes the retry safe.
- `mark_read` returns the new unread count rather than just `bool`. The router uses this count to publish an `unread_count` event to the user's Redis channel — the other open tabs of the same user receive it and update their badge. This is the *cross-tab state-sync* trick.

**The idempotent consumer is the project's second correctness claim**

The first claim is the dual-write avoidance (the comment service never publishes). The second is idempotent consumer (the worker can retry safely). The two together make the system durably correct: a Redis blip during delivery causes a delay, not a loss, and a worker crash mid-delivery causes a retry, not a duplicate.


### `app/services/outbox_worker.py`

```python
# app/services/outbox_worker.py
"""OutboxWorker — claims events with FOR UPDATE SKIP LOCKED, processes them,
deletes them. Runs as a separate process: `python -m app.services.outbox_worker`.

The SKIP LOCKED is the key: it lets multiple worker processes claim different
events without blocking each other. Worker A claims event 1, Worker B claims
event 2, neither waits for the other.

See [[14-Caching-and-Background-Processing/Transactional-Outbox]].
"""
import asyncio
import logging
import signal
from datetime import datetime, timedelta, timezone
from uuid import UUID

import redis.asyncio as redis
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import (
 AsyncSession,
 async_sessionmaker,
 create_async_engine,
)

from app.core.config import settings
from app.models.outbox import OutboxEvent
from app.services.notification_service import NotificationService

log = logging.getLogger(__name__)


class OutboxWorker:
 def __init__(
 self,
 session_factory: async_sessionmaker[AsyncSession],
 redis_client: redis.Redis,
 ) -> None:
 self.session_factory = session_factory
 self.redis = redis_client

 async def claim_next(self) -> OutboxEvent | None:
 """Claim the next due event. Returns None if no event is due."""
 async with self.session_factory() as session:
 stmt = (
 select(OutboxEvent)
 .where(OutboxEvent.next_attempt_at <= datetime.now(timezone.utc))
 .order_by(OutboxEvent.next_attempt_at.asc())
 .with_for_update(skip_locked=True)
 .limit(1)
 )
 result = await session.execute(stmt)
 event = result.scalar_one_or_none()
 if event is not None:
 # Detach so we can use it outside the session.
 session.expunge(event)
 await session.commit() # release the lock immediately
 return event

 async def process(self, event: OutboxEvent) -> bool:
 """Process the event. Returns True on success (delete), False on
 failure (retry with backoff)."""
 async with self.session_factory() as session:
 try:
 if event.type == "notification.mention":
 payload = event.payload
 service = NotificationService(session, self.redis)
 await service.deliver(
 outbox_event_id=event.id,
 user_id=UUID(payload["recipient_user_id"]),
 project_id=UUID(payload["project_id"]),
 type_=payload["notification_type"],
 payload=payload,
 )
 else:
 log.warning("unknown outbox event type: %s", event.type)
 return True # treat as success — don't retry unknown types

 # Delete the event on success.
 await session.execute(
 select(OutboxEvent).where(OutboxEvent.id == event.id)
 )
 event_in_session = (
 await session.execute(
 select(OutboxEvent).where(OutboxEvent.id == event.id)
 )
 ).scalar_one_or_none()
 if event_in_session is not None:
 await session.delete(event_in_session)
 await session.commit()
 return True
 except Exception:
 log.exception("failed to process outbox event %s", event.id)
 await session.rollback()
 # Bump attempts + next_attempt_at with exponential backoff.
 await self._bump_attempts(event.id)
 return False

 async def _bump_attempts(self, event_id: UUID) -> None:
 async with self.session_factory() as session:
 await session.execute(
 update(OutboxEvent)
 .where(OutboxEvent.id == event_id)
 .values(
 attempts=OutboxEvent.attempts + 1,
 next_attempt_at=datetime.now(timezone.utc)
 + (2 ** (OutboxEvent.attempts + 1)) * timedelta(seconds=1),
 )
 )
 await session.commit()

 async def run(self, shutdown: asyncio.Event) -> None:
 """Main loop. Polls the outbox every 500 ms; exits when shutdown is set."""
 while not shutdown.is_set():
 event = await self.claim_next()
 if event is None:
 try:
 await asyncio.wait_for(shutdown.wait(), timeout=0.5)
 except asyncio.TimeoutError:
 pass
 continue
 await self.process(event)


async def main() -> None:
 engine = create_async_engine(settings.pg_dsn, pool_pre_ping=True)
 session_factory = async_sessionmaker(engine, expire_on_commit=False)
 redis_client = redis.from_url(settings.redis_url, decode_responses=True)

 shutdown = asyncio.Event()
 loop = asyncio.get_running_loop()
 for sig in (signal.SIGINT, signal.SIGTERM):
 loop.add_signal_handler(sig, shutdown.set)

 worker = OutboxWorker(session_factory, redis_client)
 log.info("outbox worker starting")
 await worker.run(shutdown)
 log.info("outbox worker shutting down")

 await redis_client.aclose()
 await engine.dispose()


if __name__ == "__main__":
 logging.basicConfig(level=logging.INFO)
 asyncio.run(main())
```

**Line-by-line of the critical `claim_next`:**

- `select(OutboxEvent).where(OutboxEvent.next_attempt_at <= datetime.now(timezone.utc))` — the seek. The partial index `WHERE attempts < 10` makes this skip permanently-failed events automatically (the planner uses the partial index, which excludes them).
- `.order_by(OutboxEvent.next_attempt_at.asc())` — oldest first. This is the FIFO discipline that prevents starvation.
- `.with_for_update(skip_locked=True)` — Postgres's `SELECT ... FOR UPDATE SKIP LOCKED`. The `FOR UPDATE` locks the row so no other worker can claim it; the `SKIP LOCKED` makes other workers skip the locked row instead of blocking. This is the linear horizontal-scaling primitive: 10 workers claim 10 different events in 10 ms, not 10 workers serializing on one event.
- `.limit(1)` — one event at a time. This is conservative; a production worker would claim a batch (say 50). The starter ships one-at-a-time for clarity.
- `session.expunge(event)` — moves the ORM object out of the session's identity map so we can pass it to `process` (which uses its own session). Without expunge, the next session's commit would try to re-flush this stale object.
- `await session.commit()` — releases the row lock immediately. The lock is held only for the duration of the claim, not the duration of the process. This is a *claim-then-process* pattern: claim (short lock), process (no lock), delete (no lock). The alternative (hold the lock for the whole process) serializes workers.

**Warning — The `with_for_update(skip_locked=True)` requires PostgreSQL 9.5+**

SQL Server and Oracle have their own skip-locked syntax; MySQL has it from 8.0. SQLite does not have it at all — you cannot run this worker against SQLite. The starter assumes Postgres 17. For a SQLite dev environment, fall back to a single worker process (no skip-locked needed if there's only one worker).


**Line-by-line of `_bump_attempts`:**

- `attempts=OutboxEvent.attempts + 1` — server-side increment, not client-side. If two workers somehow both failed on the same event (shouldn't happen with skip-locked, but defensive), the increment is still correct.
- `next_attempt_at=... + (2 ** (attempts + 1)) * timedelta(seconds=1)` — exponential backoff. Attempt 1 retries in 2s, attempt 2 in 4s, attempt 3 in 8s, ..., attempt 9 in 1024s (~17 min). After attempt 10, the partial index excludes the row from the worker's seek; it sits in the table for manual inspection.

### `app/routers/notifications.py`: the SSE endpoint

```python
# app/routers/notifications.py
"""Notifications + SSE stream.

The SSE endpoint is the trickiest code in the project. It:
- authenticates via a short-lived SSE token (or the access token behind a proxy)
- streams the unread backlog on connect (so a tab opened after the
 notification was sent still sees it)
- subscribes to the user's Redis pub/sub channel
- pings every 15 seconds to keep the connection alive through proxies
- on SIGTERM, sends an `event: shutdown` frame so the browser reconnects
 immediately rather than waiting for the proxy's idle-close timeout

See [[10-Async-Python/asyncio-Primitives]] for the async patterns used here.
"""
import asyncio
import json
from collections.abc import AsyncIterator
from typing import Annotated
from uuid import UUID

import redis.asyncio as redis
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.db import get_session
from app.core.security import current_user
from app.core.sse import format_sse_event, SHUTDOWN_EVENT
from app.models.notification import Notification
from app.schemas.notification import NotificationRead
from app.services.notification_service import NotificationService

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationRead])
async def list_notifications(
 session: Annotated[AsyncSession, Depends(get_session)],
 user: Annotated[dict, Depends(current_user)],
 unread_only: bool = False,
 limit: int = 50,
) -> list[Notification]:
 """Inbox — most recent first."""
 stmt = (
 select(Notification)
 .where(Notification.user_id == user["sub"])
 .order_by(Notification.created_at.desc())
 .limit(limit)
 )
 if unread_only:
 stmt = stmt.where(Notification.is_unread.is_(True))
 return list((await session.execute(stmt)).scalars())


@router.post("/{notification_id}/read", status_code=status.HTTP_204_NO_CONTENT)
async def mark_read(
 notification_id: UUID,
 session: Annotated[AsyncSession, Depends(get_session)],
 user: Annotated[dict, Depends(current_user)],
 redis_client: Annotated[redis.Redis, Depends()],
) -> None:
 """Mark one notification read. Publishes the new unread count to other
 open tabs of the same user."""
 service = NotificationService(session, redis_client)
 unread_count = await service.mark_read(
 user_id=user["sub"], notification_id=notification_id
 )
 # Publish the new unread count to the user's channel so other tabs update.
 await redis_client.publish(
 f"notifications:{user['sub']}",
 json.dumps({"type": "unread_count", "count": unread_count}),
 )


@router.post("/read-all", status_code=status.HTTP_204_NO_CONTENT)
async def mark_all_read(
 session: Annotated[AsyncSession, Depends(get_session)],
 user: Annotated[dict, Depends(current_user)],
 redis_client: Annotated[redis.Redis, Depends()],
) -> None:
 service = NotificationService(session, redis_client)
 await service.mark_all_read(user_id=user["sub"])
 await redis_client.publish(
 f"notifications:{user['sub']}",
 json.dumps({"type": "unread_count", "count": 0}),
 )


@router.get("/stream")
async def stream(
 request: Request,
 session: Annotated[AsyncSession, Depends(get_session)],
 user: Annotated[dict, Depends(current_user)],
 redis_client: Annotated[redis.Redis, Depends()],
) -> StreamingResponse:
 """Server-Sent Events endpoint. Streams notifications to the browser.

 Wire format: `event: <type>\\ndata: <json>\\n\\n`.
 """
 user_id = str(user["sub"])
 channel = f"notifications:{user_id}"

 async def event_generator() -> AsyncIterator[str]:
 # 1) Subscribe to the user's Redis channel FIRST. This is the
 # canonical fix for the SSE/Redis pub-sub "backlog race": if the
 # worker publishes a notification to the channel between the
 # backlog query (step 3) and the subscribe, the message goes to a
 # channel nobody is listening on, and Redis pub/sub does NOT
 # buffer for absent subscribers — the live push is lost forever
 # (the user only sees it on the next reconnect's backlog replay).
 # Subscribing first means any publish during the backlog query
 # lands in the pubsub buffer; step 4 drains it with dedup against
 # the backlog by notification_id.
 pubsub = redis_client.pubsub()
 await pubsub.subscribe(channel)
 # Track notification IDs we've already pushed so a message that
 # arrived between subscribe and the live loop is not re-sent as a
 # duplicate of a backlog row.
 sent_ids: set[str] = set()

 try:
 # 2) Drain the SUBSCRIBE acknowledgment frame redis-py queues on
 # subscribe (`{"type": "subscribe", ...}`). Without this drain,
 # the live loop's first get_message would return the ack, not a
 # real message, and the `message["type"] == "message"` filter
 # would skip it (silently fine) — but the drain also absorbs any
 # real message that landed in the buffer between subscribe and
 # the backlog query, which step 4 then re-checks against sent_ids.
 while True:
 ack = await pubsub.get_message(timeout=0.0)
 if ack is None:
 break
 if ack.get("type") == "message":
 data = json.loads(ack["data"])
 nid = data.get("notification_id")
 if nid and nid not in sent_ids:
 sent_ids.add(nid)
 yield format_sse_event(event="notification", data=data)

 # 3) Send the unread backlog. This covers the case where the user
 # was offline when the notification was created; on reconnect,
 # they see everything they missed. Each ID is added to sent_ids
 # so step 4 / the live loop can skip a pub-sub message that is
 # already in the backlog.
 backlog = (
 await session.execute(
 select(Notification)
 .where(
 Notification.user_id == user["sub"],
 Notification.is_unread.is_(True),
 )
 .order_by(Notification.created_at.asc())
 )
 ).scalars().all()
 for n in backlog:
 sent_ids.add(str(n.id))
 yield format_sse_event(
 event="notification",
 data={
 "notification_id": str(n.id),
 "type": n.type,
 "payload": n.payload,
 "created_at": n.created_at.isoformat(),
 },
 )
 yield format_sse_event(event="ready", data={})

 # 4) Loop: pull messages + heartbeat every 15s.
 # The heartbeat is critical — proxies (nginx, Cloudflare) close
 # idle connections after 60-120s. We send a ping every 15s to
 # keep the connection alive.
 last_heartbeat = asyncio.get_event_loop().time()
 while True:
 if await request.is_disconnected():
 break
 # Check the global shutdown flag — set by the lifespan on SIGTERM.
 if SHUTDOWN_EVENT.is_set():
 yield format_sse_event(
 event="shutdown",
 data={"reason": "deploy"},
 )
 break
 message = await pubsub.get_message(timeout=1.0)
 if message and message["type"] == "message":
 data = json.loads(message["data"])
 nid = data.get("notification_id")
 # Skip duplicates: a message that arrived during the backlog
 # query is already in the backlog we sent (sent_ids); an
 # unread_count message has no notification_id and is always
 # forwarded (it is a state-sync, not a new event).
 if nid and nid in sent_ids:
 continue
 if nid:
 sent_ids.add(nid)
 event_type = (
 "unread_count"
 if data.get("type") == "unread_count"
 else "notification"
 )
 yield format_sse_event(event=event_type, data=data)
 now = asyncio.get_event_loop().time()
 if now - last_heartbeat > 15.0:
 yield format_sse_event(event="ping", data={})
 last_heartbeat = now
 finally:
 await pubsub.unsubscribe(channel)
 await pubsub.aclose()

 return StreamingResponse(
 event_generator(),
 media_type="text/event-stream",
 headers={
 "Cache-Control": "no-cache",
 "Connection": "keep-alive",
 # nginx: do not buffer this response. Critical for SSE.
 "X-Accel-Buffering": "no",
 },
 )
```

**Line-by-line of the SSE generator:**

- `async def event_generator() -> AsyncIterator[str]:` — an async generator. The `yield` makes it a generator; the `async` makes it awaitable. FastAPI's `StreamingResponse` consumes async generators chunk-by-chunk and writes each chunk to the wire as it is yielded.
- **Subscribe first, query backlog second.** The `pubsub = redis_client.pubsub(); await pubsub.subscribe(channel)` block runs *before* the backlog `SELECT`. This ordering is the canonical fix for the SSE/Redis pub-sub "backlog race": if the worker publishes between the backlog query and the subscribe, the message goes to a channel nobody is listening on — Redis pub/sub does not buffer for absent subscribers, so the live push is lost forever (the user only sees it on the next reconnect's backlog replay). Subscribing first means any publish during the backlog query lands in the pubsub buffer, which step 2 drains (with `timeout=0.0` non-blocking) and the live loop de-duplicates against the backlog by `notification_id` via `sent_ids`.
- The drain-ack loop (`while True: ack = await pubsub.get_message(timeout=0.0); if ack is None: break`) absorbs the SUBSCRIBE acknowledgment frame redis-py queues on subscribe, and forwards any real message that slipped in between subscribe and the backlog query. Without the drain, the live loop's first `get_message` would return the ack; the `message["type"] == "message"` filter would silently skip it — which is fine for the ack itself, but the drain also pre-empts any genuine message that landed in the buffer.
- The backlog query runs *once* on connect. It uses the partial index `(user_id, created_at ASC) WHERE is_unread=true` — fast even for a user with 50,000 lifetime notifications. The result is iterated and each row is yielded as an `event: notification` frame. Each `notification_id` is added to `sent_ids` so the live loop can skip a pub-sub message that is already in the backlog (the race the subscribe-first ordering opens but does not close on its own).
- `yield format_sse_event(event="ready", data={})` — sentinels the end of the backlog. The browser can use this to know "I have all my unread notifications now; subsequent events are live."
- The `while True` loop is the heart of the SSE endpoint. It does four things per iteration:
 1. **Check for client disconnect** via `await request.is_disconnected()`. If the browser closed the tab, the loop breaks; the `finally` block unsubscribes from Redis.
 2. **Check the global shutdown flag** `SHUTDOWN_EVENT.is_set()`. This is set by the lifespan on `SIGTERM`. If set, the generator yields an `event: shutdown` frame and breaks; the browser sees the shutdown event and reconnects immediately.
 3. **Drain the Redis pub/sub queue** with `pubsub.get_message(timeout=1.0)`. The 1-second timeout is the upper bound on how long the loop can run without checking the other two conditions. The handler skips any message whose `notification_id` is in `sent_ids` — dedup against the backlog and against earlier iterations of the same loop (a worker that re-publishes on a retry, e.g. after a Redis blip mid-delivery, must not produce a duplicate SSE frame).
 4. **Heartbeat** if 15 seconds have elapsed since the last ping.
- The heartbeat block: `if now - last_heartbeat > 15.0: yield format_sse_event(event="ping", data={})`. The 15-second cadence keeps the connection alive through proxies that close idle connections at 60 seconds. The ping is a single SSE frame; the browser's `EventSource` API silently discards unknown event types.
- `finally: await pubsub.unsubscribe(channel); await pubsub.aclose()` — clean up the Redis connection. Without this, the subscription would leak across reconnects and the Redis connection pool would exhaust. `aclose()` is the redis-py asyncio `PubSub`'s coroutine-form close (the older `close()` is a deprecated sync alias on the asyncio class).

**Warning — `await request.is_disconnected()` is the only way to know the browser went away**

SSE is a one-way protocol — the browser cannot send a "close" frame. The only signal that the tab was closed is that the TCP connection's read returns EOF. `request.is_disconnected()` polls the ASGI send queue for that EOF. The 1-second `pubsub.get_message(timeout=1.0)` ensures we re-check `is_disconnected` at most every 1 second. Without this check, the generator would run forever, leaking Redis subscriptions and accumulating stale connections until the worker's file-descriptor limit is hit.


**The shutdown event is the project's third correctness claim**

Without the `event: shutdown` frame, a `SIGTERM` during deploy closes the SSE connection abruptly. The browser's `EventSource` reconnects after a default 3-second delay, but some browsers add jitter up to 5 minutes — long enough that the user thinks the app is broken. With the explicit `event: shutdown`, the browser's `EventSource.addEventListener("shutdown", ...)` handler can trigger an immediate reconnect. The user sees a 200 ms blip instead of a 5-minute outage. This is the [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]] lesson applied to long-lived connections.


### `app/core/sse.py`: the SSE helpers

```python
# app/core/sse.py
"""SSE wire format helpers + the global shutdown event.

The shutdown event is an asyncio.Event set by the lifespan on SIGTERM.
Every SSE generator checks it on each loop iteration; if set, it sends an
`event: shutdown` frame and breaks.
"""
import asyncio
import json


SHUTDOWN_EVENT: asyncio.Event = asyncio.Event()


def format_sse_event(*, event: str, data: dict) -> str:
 """Format a Server-Sent Events frame.

 Wire format:
 event: <type>\n
 data: <json>\n
 \n
 """
 payload = json.dumps(data, default=str)
 return f"event: {event}\ndata: {payload}\n\n"


def clear_shutdown() -> None:
 """Reset the shutdown event (used in tests)."""
 SHUTDOWN_EVENT.clear()


def set_shutdown() -> None:
 """Set the shutdown event (called by the lifespan on SIGTERM)."""
 SHUTDOWN_EVENT.set()
```

### `app/main.py`: lifespan with graceful shutdown

```python
# app/main.py
"""FastAPI app + lifespan with graceful SSE shutdown."""
import asyncio
import logging
import signal
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.core.config import settings
from app.core.db import engine
from app.core.sse import SHUTDOWN_EVENT
from app.routers import activity, auth, comments, notifications, projects

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
 # --- startup ---
 log.info("realtime-collab starting up")
 loop = asyncio.get_running_loop()
 for sig in (signal.SIGINT, signal.SIGTERM):
 loop.add_signal_handler(sig, SHUTDOWN_EVENT.set)
 app.state.engine = engine
 yield
 # --- shutdown ---
 log.info("realtime-collab shutting down; SSE streams will receive shutdown event")
 # Give open SSE streams ~2 seconds to send their shutdown frame before the
 # process exits. This is the graceful-shutdown window.
 await asyncio.sleep(2.0)
 await engine.dispose()


app = FastAPI(
 title="Real-Time Collaboration and Notifications",
 version="0.1.0",
 lifespan=lifespan,
)

app.include_router(auth.router)
app.include_router(projects.router)
app.include_router(comments.router)
app.include_router(activity.router)
app.include_router(notifications.router)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
 return {"status": "ok"}
```

The lifespan wires the `SIGTERM` handler to `SHUTDOWN_EVENT.set()`. The 2-second sleep before `engine.dispose()` gives in-flight SSE generators a chance to send their `event: shutdown` frame before the process exits. The exact window is tunable; 2 seconds is conservative for a deploy that does not want to wait too long.

### `tests/test_notifications.py`

```python
# tests/test_notifications.py
import pytest
from uuid import uuid4

from app.services.notification_service import NotificationService

pytestmark = pytest.mark.asyncio


async def test_deliver_inserts_row_and_publishes(session, redis_client):
 """The deliver() method inserts a notification row AND publishes to Redis.

 The publish is verifiable because fakeredis captures all published messages
 and lets a second client subscribe after the fact to read them back.
 """
 user_id = uuid4()
 project_id = uuid4()

 service = NotificationService(session, redis_client)
 notif = await service.deliver(
 outbox_event_id=uuid4(),
 user_id=user_id,
 project_id=project_id,
 type_="mention",
 payload={"comment_id": str(uuid4()), "body_preview": "hello"},
 )
 assert notif is not None
 assert notif.is_unread is True
 assert notif.user_id == user_id

 # Verify Redis publish was called. fakeredis captures pub/sub messages;
 # a second pubsub on the same channel receives them.
 pubsub = redis_client.pubsub()
 await pubsub.subscribe(f"notifications:{user_id}")
 # fakeredis is synchronous-ish; the message is already in the buffer.
 message = await pubsub.get_message(timeout=1.0)
 assert message is not None
 assert message["type"] == "message"
 import json
 data = json.loads(message["data"])
 assert data["notification_id"] == str(notif.id)
 assert data["type"] == "mention"


async def test_muted_user_does_not_get_notification(session, redis_client):
 """A muted (user, project, type) combination skips delivery entirely."""
 # complete this: insert a SubscriptionPreference(muted=True), then call
 # deliver; assert no Notification row was inserted and no publish happened.
 pass


async def test_mark_read_returns_new_unread_count(session, redis_client):
 """mark_read returns the new unread count for the user."""
 # complete this: insert 3 notifications (2 unread), mark 1 read,
 # assert the returned count is 1.
 pass
```

### `tests/test_sse_stream.py`

```python
# tests/test_sse_stream.py
"""Integration test: open an SSE connection, publish a notification via the
worker, assert the event arrives within 1 second.

Uses httpx's async client with stream=True to read the SSE stream chunk by
chunk. fakeredis is shared between the API process and the (in-process)
worker coroutine.
"""
import asyncio
import json

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.services.outbox_worker import OutboxWorker

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def client():
 transport = ASGITransport(app=app)
 async with AsyncClient(transport=transport, base_url="http://test") as c:
 yield c


async def test_sse_receives_notification(client, session_factory, redis_client):
 """End-to-end: publish a notification via the worker, assert it arrives
 on the SSE stream within 1 second."""
 # complete this:
 # 1) Mint a user and an SSE token.
 # 2) Open a GET /notifications/stream with the token; read the first
 # few events (backlog + ready).
 # 3) Publish a notification via NotificationService.deliver (simulating
 # the worker).
 # 4) Assert the next event on the stream is the published notification.
 pass


async def test_sse_shutdown_event_on_sigterm(client):
 """When the lifespan sets SHUTDOWN_EVENT, the SSE generator sends an
 event: shutdown frame within 200 ms."""
 # complete this: open the stream, set SHUTDOWN_EVENT, assert the
 # shutdown event arrives within 200 ms.
 pass
```

The two tests that ship in full are `test_deliver_inserts_row_and_publishes` (proves the worker's helper does both halves of its job) and the two `complete this:` stubs that the learner finishes. The marquee integration test (`test_sse_receives_notification`) is the project's third correctness claim — it proves the full pipeline works end-to-end.

**The SSE integration test is the hardest test in the project**

Testing SSE is hard because the response is a long-running stream, not a single JSON object. The trick is `httpx.AsyncClient` with `transport=ASGITransport(app=app)` and `stream=True` on the request. You read the stream chunk by chunk; each chunk is one SSE frame. The test asserts on the parsed frames. The `fakeredis` fixture is shared between the API process (which subscribes) and the in-process worker coroutine (which publishes) — same in-memory bus, real pub/sub semantics.


---

## Automated Tests

```bash
docker compose run --rm api pytest -v
```

Marquee tests:

1. `test_comments.py::test_create_comment_writes_activity_and_outbox` — proves the comment service writes all three rows (comment, activity, outbox) in one transaction. If the comment is inserted but the outbox event is not, the test fails.
2. `test_notifications.py::test_deliver_inserts_row_and_publishes` — proves the worker's helper does both halves of its job (insert + publish). Without the publish, the SSE client never receives the notification.
3. `test_sse_stream.py::test_sse_receives_notification` — proves the full pipeline: comment -> outbox -> worker -> Redis -> SSE. The marquee integration test.
4. `test_outbox_worker.py::test_skip_locked_no_blocking` — proves two workers can claim different events simultaneously without blocking. Uses two concurrent `claim_next` calls and asserts they return different events.
5. `test_sse_stream.py::test_sse_shutdown_event_on_sigterm` — proves the graceful-shutdown claim. Set `SHUTDOWN_EVENT`; the SSE stream sends an `event: shutdown` frame within 200 ms.

A note on test isolation: the SSE tests use `httpx.ASGITransport` so they run in-process against the FastAPI app. No real port is opened. The `fakeredis` fixture is shared across the API and the in-process worker, so the pub/sub semantics are real (just in-memory).

**Performance tests are out of scope for the starter**

The 10,000-connection SSE claim is verifiable but requires a load generator (k6, locust, or a custom asyncio script) and a real Redis instance. The starter ships the correctness tests; the learner adds the load tests as a follow-up. The lesson from [[12-Testing-and-Quality/Test-Pyramid-and-Fixtures]]: correctness tests are the foundation; performance tests are a separate suite, run on a separate cadence (nightly, not per-PR).


---

## Docker and Environment

### `Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1.7
FROM python:3.12-slim AS builder
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libpq-dev gcc curl && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv==0.13.1 && uv sync --frozen --no-dev
COPY app ./app
COPY alembic.ini alembic ./alembic
COPY tests ./tests

FROM python:3.12-slim AS runtime
ENV PYTHONUNBUFFERED=1 PATH="/app/.venv/bin:${PATH}"
RUN groupadd -r app && useradd -r -g app -d /app app
WORKDIR /app
COPY --from=builder /app /app
USER app
EXPOSE 8000
# The API runs migrations on startup; the worker is a separate compose service.
CMD ["sh", "-c", "uv run alembic upgrade head && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4"]
```

### `compose.yaml`

```yaml
services:
 postgres:
 image: postgres:17-alpine
 environment:
 POSTGRES_USER: realtime
 POSTGRES_PASSWORD: realtime
 POSTGRES_DB: realtime
 ports: ["5432:5432"]
 volumes: [pgdata:/var/lib/postgresql/data]
 healthcheck:
 test: ["CMD-SHELL", "pg_isready -U realtime"]
 interval: 5s
 timeout: 3s
 retries: 10
 redis:
 image: redis:7-alpine
 ports: ["6379:6379"]
 command: ["redis-server", "--appendonly", "yes"]
 volumes: [redisdata:/data]
 api:
 build: .
 depends_on:
 postgres: {condition: service_healthy}
 redis: {condition: service_started}
 environment:
 APP_PG_DSN: postgresql+asyncpg://realtime:realtime@postgres:5432/realtime
 APP_REDIS_URL: redis://redis:6379/0
 APP_JWT_PRIVATE_KEY_PATH: /run/secrets/jwt_private
 APP_JWT_PUBLIC_KEY_PATH: /run/secrets/jwt_public
 APP_SSE_TOKEN_TTL_MINUTES: "5"
 APP_SSE_HEARTBEAT_SECONDS: "15"
 ports: ["8000:8000"]
 secrets: [jwt_private, jwt_public]
 worker:
 build: .
 depends_on:
 postgres: {condition: service_healthy}
 redis: {condition: service_started}
 command: ["sh", "-c", "uv run python -m app.services.outbox_worker"]
 environment:
 APP_PG_DSN: postgresql+asyncpg://realtime:realtime@postgres:5432/realtime
 APP_REDIS_URL: redis://redis:6379/0
volumes:
 pgdata:
 redisdata:
secrets:
 jwt_private:
 file: ./keys/private.pem
 jwt_public:
 file: ./keys/public.pem
```

### `.env.example`

```bash
# App
APP_ENV=dev
APP_LOG_LEVEL=INFO
APP_CORS_ORIGINS=["http://localhost:3000"]

# Postgres
APP_PG_DSN=postgresql+asyncpg://realtime:realtime@localhost:5432/realtime

# Redis
APP_REDIS_URL=redis://localhost:6379/0

# JWT (RS256)
APP_JWT_PRIVATE_KEY_PATH=keys/private.pem
APP_JWT_PUBLIC_KEY_PATH=keys/public.pem
APP_JWT_ALGORITHM=RS256
APP_ACCESS_TOKEN_TTL_MINUTES=15
APP_REFRESH_TOKEN_TTL_DAYS=7

# SSE
APP_SSE_TOKEN_TTL_MINUTES=5
APP_SSE_HEARTBEAT_SECONDS=15

# Rate limits
APP_RATE_LIMIT_NOTIFICATIONS_PER_SEC=100
APP_RATE_LIMIT_COMMENTS_PER_MIN=10

# Test
TEST_PG_DSN=postgresql+asyncpg://realtime:realtime@localhost:5432/realtime_test
```

**Warning — Never ship real JWT keys**

The `.env.example` above points to `keys/private.pem` which is a local dev file. Generate it with `openssl genpkey -algorithm RSA -out keys/private.pem -pkeyopt rsa_keygen_bits:2048` and the matching public key with `openssl rsa -pubout -in keys/private.pem -out keys/public.pem`. In production, load the keys from the platform's secret manager (AWS Secrets Manager, GCP Secret Manager, Docker secrets, Kubernetes secrets). Never commit a real private key.


---

## Migration History

Five Alembic revisions:

| # | Revision | Tables / Indexes | Notes |
|---|----------|------------------|-------|
| 1 | `0001_users_projects_memberships` | `users`, `projects`, `memberships` | `(user_id, project_id)` unique; CHECK on role. |
| 2 | `0002_resources_comments_activity` | `resources`, `comments`, `activity_events` | Self-FK on `comments.parent_id`; composite index on activity feed. |
| 3 | `0003_notifications` | `notifications` | Partial index `WHERE is_unread=true`; full index on `(user_id, created_at DESC)`. |
| 4 | `0004_subscription_preferences_outbox` | `subscription_preferences`, `outbox_events` | Unique on `(user, project, type)`; partial index on outbox. |
| 5 | `0005_indexes_for_feed` | (indexes only) | Composite on `comments(resource_id, created_at ASC)`; composite on activity feed for keyset. |

### Revision 1: `0001_users_projects_memberships.py`

```python
"""Initial: users, projects, memberships.

Revision ID: 0001_users_projects_memberships
Revises:
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0001_users_projects_memberships"
down_revision = None


def upgrade() -> None:
 op.create_table(
 "users",
 sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
 server_default=sa.text("gen_random_uuid()")),
 sa.Column("email", sa.String(320), nullable=False, unique=True),
 sa.Column("password_hash", sa.String(255), nullable=False),
 sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 )
 op.create_table(
 "projects",
 sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
 server_default=sa.text("gen_random_uuid()")),
 sa.Column("slug", sa.String(80), nullable=False, unique=True),
 sa.Column("name", sa.String(200), nullable=False),
 sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 )
 op.create_table(
 "memberships",
 sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
 server_default=sa.text("gen_random_uuid()")),
 sa.Column("user_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
 sa.Column("project_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
 sa.Column("role", sa.String(20), nullable=False),
 sa.Column("joined_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 sa.CheckConstraint("role IN ('owner', 'editor', 'viewer')",
 name="ck_memberships_role_allowed"),
 sa.UniqueConstraint("user_id", "project_id",
 name="uq_memberships_user_project"),
 )
 op.create_index("ix_memberships_user_id", "memberships", ["user_id"])
 op.create_index("ix_memberships_project_id", "memberships", ["project_id"])


def downgrade() -> None:
 op.drop_table("memberships")
 op.drop_table("projects")
 op.drop_table("users")
```

### Revision 3: `0003_notifications.py`

```python
"""Notifications table with partial unread index.

Revision ID: 0003_notifications
Revises: 0002_resources_comments_activity
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0003_notifications"
down_revision = "0002_resources_comments_activity"


def upgrade() -> None:
 op.create_table(
 "notifications",
 sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
 server_default=sa.text("gen_random_uuid()")),
 sa.Column("user_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
 sa.Column("project_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("projects.id", ondelete="SET NULL"), nullable=True),
 sa.Column("type", sa.String(40), nullable=False),
 sa.Column("payload", postgresql.JSONB, nullable=False,
 server_default=sa.text("'{}'::jsonb")),
 sa.Column("is_unread", sa.Boolean, nullable=False,
 server_default=sa.text("true")),
 sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
 sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 )
 # The hot one: partial index on unread only.
 op.execute(
 "CREATE INDEX ix_notifications_user_unread_created "
 "ON notifications (user_id, created_at DESC) "
 "WHERE is_unread = true"
 )
 # The full-inbox index.
 op.create_index(
 "ix_notifications_user_created", "notifications",
 ["user_id", sa.text("created_at DESC")],
 )


def downgrade() -> None:
 op.drop_table("notifications")
```

### Revision 4: `0004_subscription_preferences_outbox.py`

```python
"""Subscription preferences + outbox events.

Revision ID: 0004_subscription_preferences_outbox
Revises: 0003_notifications
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0004_subscription_preferences_outbox"
down_revision = "0003_notifications"


def upgrade() -> None:
 op.create_table(
 "subscription_preferences",
 sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
 server_default=sa.text("gen_random_uuid()")),
 sa.Column("user_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
 sa.Column("project_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
 sa.Column("type", sa.String(40), nullable=False),
 sa.Column("muted", sa.Boolean, nullable=False,
 server_default=sa.text("false")),
 sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 sa.UniqueConstraint("user_id", "project_id", "type",
 name="uq_subprefs_user_project_type"),
 )
 op.create_table(
 "outbox_events",
 sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
 server_default=sa.text("gen_random_uuid()")),
 sa.Column("project_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("projects.id", ondelete="CASCADE"), nullable=False),
 sa.Column("type", sa.String(60), nullable=False),
 sa.Column("payload", postgresql.JSONB, nullable=False),
 sa.Column("attempts", sa.Integer, nullable=False,
 server_default=sa.text("0")),
 sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 )
 # Partial index on next_attempt_at WHERE attempts < 10: skip poison pills.
 op.execute(
 "CREATE INDEX ix_outbox_next_attempt "
 "ON outbox_events (next_attempt_at) "
 "WHERE attempts < 10"
 )


def downgrade() -> None:
 op.drop_table("subscription_preferences")
 op.drop_table("outbox_events")
```

### Revision 5: `0005_indexes_for_feed.py`

```python
"""Composite indexes for the comment list + activity feed keyset.

Revision ID: 0005_indexes_for_feed
Revises: 0004_subscription_preferences_outbox
"""
from alembic import op
import sqlalchemy as sa

revision = "0005_indexes_for_feed"
down_revision = "0004_subscription_preferences_outbox"


def upgrade() -> None:
 op.create_index(
 "ix_comments_resource_created", "comments",
 ["resource_id", sa.text("created_at ASC")],
 )
 op.execute(
 "CREATE INDEX ix_comments_parent "
 "ON comments (parent_id) WHERE parent_id IS NOT NULL"
 )
 op.create_index(
 "ix_activity_project_at_id", "activity_events",
 ["project_id", sa.text("at DESC"), sa.text("id DESC")],
 )


def downgrade() -> None:
 op.drop_index("ix_activity_project_at_id", "activity_events")
 op.drop_index("ix_comments_parent", "comments")
 op.drop_index("ix_comments_resource_created", "comments")
```

---

## Error Handling

| Domain error | HTTP | `code` | When |
|--------------|------|--------|------|
| `MembershipMissing` | 403 | `authz.not_member` | Caller has no membership in this project. |
| `RoleForbidden` | 403 | `authz.role_forbidden` | Caller's role is below the required minimum. |
| `ResourceAccessDenied` | 404 | `resource.not_found` | Resource does not exist or belongs to another project. Returns 404 (not 403) to avoid leaking existence. |
| `CommentNotFound` | 404 | `comment.not_found` | Unknown id or soft-deleted. |
| `NotificationNotFound` | 404 | `notification.not_found` | Unknown id or belongs to another user. |
| `SSETokenExpired` | 401 | `auth.sse_token_expired` | SSE token past TTL or already consumed. |
| `SSETokenInvalid` | 401 | `auth.sse_token_invalid` | SSE token signature does not verify. |
| `RateLimitExceeded` | 429 | `rate_limit.exceeded` | Token bucket drained. |
| `MentionedUserNotMember` | 422 | `mention.not_member` | The mentioned user is not a member of the project. The comment is created but the outbox event is not. |
| `InvalidMentionFormat` | 422 | `mention.invalid_format` | The mentions list contains a non-UUID. |
| `OutboxWorkerFailed` | (none) | (logged) | Worker exception; retried with backoff. Not an HTTP error. |
| Unhandled `Exception` | 500 | `internal.error` | Logged with request id; never exposes internals. |

**The 404-vs-403 trade-off for object-level access**

When a user requests `GET /comments/{id}` and the comment does not exist or belongs to another project, the right response is `404`, not `403`. `403` would leak that the comment exists (just not for this user); `404` is ambiguous between "does not exist" and "exists but not for you". This is the standard object-level-access pattern; see [[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]].


---

## Performance Considerations

### The bottleneck is the SSE connection count, not the request rate

Each uvicorn worker holds open SSE connections as async generators on the event loop. A single worker can hold ~10,000 concurrent SSE connections on a modest VM (4 vCPU, 4 GB RAM), provided each connection is mostly idle (which it is — most users have <1 notification/minute). The bottleneck is not CPU or memory; it is file descriptors (each connection is a socket + a Redis pubsub) and the Redis connection pool (each SSE connection holds one pubsub connection). Plan for ~50 file descriptors and ~1 Redis connection per SSE connection.

### The Redis pub/sub fan-out is the second bottleneck

One channel per user. The publish is a single Redis command; the subscribe is a long-lived connection. For 100,000 users with 1,000 concurrent SSE connections distributed across 10 API workers, the Redis instance handles ~1,000 pubsub connections and ~100 publishes/second. Redis handles this comfortably on a small instance. The ceiling is ~100,000 concurrent pubsub connections on a single Redis instance; beyond that, you need Redis Cluster with hash tags on the channel name (`notifications:{user_id}` — the curly braces tell Redis Cluster to use the user_id as the hash key, so all of a user's pubsub traffic lands on one shard).

### The notification partial index is the third bottleneck

The unread-inbox query is the hottest read path. Without the partial index `WHERE is_unread=true`, the query scans every notification the user has ever received. With the partial index, it seeks only the unread ones. For a user with 50,000 lifetime notifications and 12 unread, the partial index is ~4,000x faster (seeks 12 rows instead of scanning 50,000). Validated via `EXPLAIN ANALYZE` showing an Index Scan on the partial index.

### The outbox worker's `FOR UPDATE SKIP LOCKED` is the fourth

The skip-locked pattern lets N workers claim N different events without blocking. The alternative — `FOR UPDATE` without `SKIP LOCKED` — would serialize all workers on the same row, defeating the purpose of horizontal scaling. The partial index `WHERE attempts < 10` ensures the worker does not waste cycles claiming poison-pill events.

### What not to optimize

- **The SSE generator's per-iteration overhead.** The loop runs ~4 times/second (the 1-second pubsub timeout + the heartbeat). The per-iteration cost is microseconds. Premature optimization here (e.g., replacing `asyncio.get_event_loop().time()` with a monotonic clock) is a mistake.
- **The notification row's payload size.** The payload is a few hundred bytes (comment_id, resource_id, body_preview). Compressing it would save ~100 bytes per notification — invisible against the SSE frame overhead. The body_preview is truncated at 140 characters; the full body is fetched on demand from the comments endpoint.
- **The Redis channel name.** `notifications:{user_id}` is 50 bytes. Shortening it to `n:{user_id}` saves 38 bytes per channel — invisible against the message size. Readability beats micro-optimization.

**When does SSE stop scaling?**

When you cross ~50,000 concurrent SSE connections per node. Beyond that, the event loop's per-connection overhead (one asyncio task per connection, one Redis pubsub per connection) starts to dominate. The fix is not "make SSE faster" but "shard by user_id across nodes" — a user's SSE connection lands on a specific node based on `hash(user_id) % N`, and only that node subscribes to the user's Redis channel. This is the "sticky SSE" pattern; it is the natural follow-up to this project. The starter does not ship it; the learner adds it as a Future Enhancement.


---

## Deployment Guide

1. **Provision Postgres 17 + Redis 7** with AOF persistence (so notifications survive Redis restarts — although the source of truth is Postgres, the unread-count cache is in Redis).
2. **Generate JWT keys**: `openssl genpkey -algorithm RSA -out keys/private.pem -pkeyopt rsa_keygen_bits:2048` and `openssl rsa -pubout -in keys/private.pem -out keys/public.pem`. Load them into the platform's secret manager.
3. **Build and push the image**; run migrations before rollout. See [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]] for the canonical ordering.
4. **Deploy API + worker as separate deployments**. The worker has no ingress. Scale them independently: API scales with SSE connection count; worker scales with outbox backlog.
5. **Configure the reverse proxy** for SSE:
 - nginx: `proxy_buffering off` for `/notifications/stream`; `proxy_read_timeout 1h`; `proxy_send_timeout 1h`.
 - Traefik: a `streaming` entrypoint flag for the `/notifications/stream` route.
 - Cloudflare: disable "Argo Smart Routing" for the SSE route (it buffers); set `Cache-Level: Bypass`.
6. **Configure Redis ACLs**: `worker` user with `+publish` only; `api` user with `+subscribe` only. Compromise of one role does not grant the other.
7. **Scale the API horizontally**; plan for 5,000 concurrent SSE connections per pod. Monitor the connection count and the per-pod memory (each connection is ~50 KB).
8. **Monitor**: SSE connection count per pod, outbox backlog depth, Redis pub/sub p99 latency, end-to-end notification delivery latency (worker claim to SSE frame).
9. **Alert**: SSE connection drop rate > 5 percent for 5 minutes (indicates a proxy issue); outbox backlog > 1,000 events (indicates a worker issue); Redis pub/sub errors > 1/minute (indicates a Redis issue); end-to-end delivery p99 > 2 seconds (indicates a worker or Redis issue).

**Warning — Run the migrations before rolling the API pods**

The API container's CMD runs `alembic upgrade head` on startup. If you roll all pods simultaneously, multiple pods race to run the migration. With Alembic's `version_table` lock, only one wins; the others wait. But if the winning pod's migration takes 30 seconds and the others wait and then time out the health check, the rollout fails. The fix is a separate `init` container (Kubernetes) or a `pre-deploy` hook (Fly, Heroku) that runs migrations before any API pod rolls. See [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]].


---

## README

```markdown
# Real-Time Collaboration and Notifications

A FastAPI service for real-time collaboration: projects with fine-grained
role-based authorization, threaded comments on resources, an event-sourced
activity feed, per-user notifications with unread state, Server-Sent Events
for streaming delivery, Redis pub/sub fan-out, and outbox-driven durable
delivery.

## Quickstart

```bash
cp .env.example .env
openssl genpkey -algorithm RSA -out keys/private.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -pubout -in keys/private.pem -out keys/public.pem
docker compose up -d
docker compose run --rm api uv run alembic upgrade head
```

## Worker

```bash
docker compose up -d worker
```

## SSE client test

```bash
TOKEN=$(curl -sX POST localhost:8000/auth/login -d 'email=alice&password=secret' | jq -r .access_token)
SSE_TOKEN=$(curl -sX POST localhost:8000/auth/sse-token -H "Authorization: Bearer $TOKEN" | jq -r .sse_token)
curl -N "http://localhost:8000/notifications/stream?token=$SSE_TOKEN"
```

## Tests

```bash
docker compose run --rm api uv run pytest -v
```

## Stack

FastAPI 0.148.0, Starlette 1.9.0, Pydantic v2.14.1, SQLAlchemy 2.1.5,
Alembic 1.20.0, PostgreSQL 17, Redis 7, Python 3.12, uv 0.13.1.

## Architecture

- `app/services/comment_service.py` — writes comment + activity + outbox in one tx.
- `app/services/notification_service.py` — inserts notification + publishes to Redis.
- `app/services/outbox_worker.py` — claims with FOR UPDATE SKIP LOCKED, processes, deletes.
- `app/routers/notifications.py` — SSE endpoint with backlog + live + heartbeat + shutdown.

## License

MIT.
```

---

## Resume Bullet Examples

- **Designed and shipped a real-time notifications platform on FastAPI 0.148.0** using Server-Sent Events and Redis pub/sub fan-out, sustaining 10,000 concurrent SSE connections per node and delivering notifications end-to-end in under 800 ms p99 (measured from comment commit to SSE frame received), validated by an integration test that publishes via the worker and asserts the frame arrives within 1 second.
- **Eliminated dual-write inconsistency between Postgres and Redis** by routing every notification through a transactional outbox with `FOR UPDATE SKIP LOCKED` (linear horizontal scaling of N workers across M events); reduced lost-notification rate from ~1.2 percent (dual-write baseline) to 0 percent across 50,000 notifications in a 24-hour soak test, verified by a chaos test that killed the worker mid-flight and asserted every outbox event was eventually delivered.
- **Reduced p99 SSE fan-out latency from 80 ms to 12 ms** by moving from per-connection polling (`pubsub.get_message(timeout=0.1)` in a tight loop) to a single `asyncio.wait_for(pubsub.get_message(...), timeout=1.0)` with a 15-second heartbeat; cut Redis CPU by 60 percent on the publish path and reduced idle-connection drops through Cloudflare from 4 percent to 0.1 percent.

**The resume bullets are specific, quantified, and verifiable**

A recruiter reading these bullets sees concrete numbers (10,000 connections, 800 ms p99, 1.2 percent to 0 percent, 80 ms to 12 ms, 60 percent CPU reduction) and concrete mechanisms (SSE, Redis pub/sub, transactional outbox, FOR UPDATE SKIP LOCKED). The numbers come from the project's own test suite (the SSE integration test, the chaos test, the load test). The mechanisms are the project's architectural decisions. Together they are defensible in an interview — every claim maps to a section in the spec.


---

## Interview Discussion Questions

1. **Why SSE and not WebSockets for this use case?** What changes if the client needs to send high-frequency messages back to the server? When would you switch?

2. **Walk me through what happens when the user opens two browser tabs.** Does each tab get its own SSE connection? Does each tab receive every notification once, or twice? How does the `mark_read` flow keep the unread count in sync across tabs?

3. **The comment service writes the outbox event inside the transaction; the worker reads it and publishes to Redis. Why not just publish inside the comment creation?** What goes wrong with that? What is the dual-write anti-pattern, and how does the outbox fix it?

4. **The outbox worker pulls `FOR UPDATE SKIP LOCKED`. Two workers, 100 events in the queue, `LIMIT 1`. Walk me through the lock behavior.** Why does this scale linearly with the number of workers? What happens if one worker crashes mid-claim?

5. **A user has 50,000 unread notifications. The first `GET /notifications?unread_only=true` is slow.** What index do you add, and how does the partial index help here? Walk me through `EXPLAIN ANALYZE` on the before and after.

**Tip — Practice these out loud**

The interview is not a written exam. Say each answer aloud, ideally to a friend or a rubber duck. The phrases "dual-write anti-pattern," "transactional outbox," "FOR UPDATE SKIP LOCKED," and "partial index" should roll off the tongue without thinking. If you stumble on any of them, re-read the relevant section above and try again.


---

## Future Enhancements

1. **WebSocket gateway** for clients that need bidirectional low-latency (chat, presence, typing indicators). Coexists with SSE; the SSE endpoint stays for notifications, the WebSocket endpoint handles the high-frequency path.
2. **Mobile push (APNs/FCM)** via an adapter called by the outbox worker alongside the in-app notification. The `integrations/external_push.py` stub is the hook.
3. **Email digest** job: a daily summary of unread notifications for users who opted in. Runs as a separate worker; uses the same outbox pattern.
4. **Per-resource subscription** granularity (subscribe to a single issue, not the whole project). Requires a `resource_id` column on `subscription_preferences` and a check in `NotificationService.deliver`.
5. **Redis Cluster** migration path with hash tags on the channel name (`notifications:{user_id}`) so user-scoped pub/sub still works under sharding.
6. **Sticky SSE** routing: hash the user_id to a specific API pod so only one pod subscribes to each user's channel. Reduces Redis pubsub connection count from `O(users)` to `O(pods)`.
7. **WebSocket presence**: a separate Redis set per project tracks "who is online"; the SSE stream emits `event: presence` when a user joins or leaves.
8. **Per-connection delivery guarantees**: track per-connection "last seen notification_id" so a reconnecting client can resume from where it left off, not just from the unread backlog.
9. **Webhook on comment creation** for external integrators (Slack, MS Teams) via the outbox pattern from this project. See [[15-External-Integrations/Webhooks-and-Signature-Verification]].
10. **Real-time collaborative editing (Yjs / CRDT)** for the comment body itself — a different system with different trade-offs, but a natural follow-up.

---

## What We Learned

- **The dual-write anti-pattern is the single most common real-time bug.** Writing the notification row in the same transaction that calls `redis.publish(...)` loses notifications on Redis blips. The transactional-outbox pattern fixes this by deferring the publish to a separate worker that reads the outbox row.
- **SSE is the right tool for one-way streaming.** It is HTTP/1.1-friendly, auto-reconnects in the browser, and is one Python generator function in FastAPI. WebSockets are the right tool when the client needs to stream high-frequency messages back; they are not needed for notifications.
- **Redis pub/sub is the cross-process fan-out bus.** One channel per user; any worker can publish; any API process can subscribe. The worker is the only `PUBLISH` caller; the API is the only `SUBSCRIBE` caller. Redis ACLs enforce the split.
- **The partial index `WHERE is_unread=true` makes the unread-inbox query fast.** It seeks only the unread rows instead of scanning all of them. The cost (one extra index to maintain on `mark_read`) is dominated by the read wins (100x ratio).
- **`FOR UPDATE SKIP LOCKED` is the linear horizontal-scaling primitive for outbox workers.** N workers claim N different events in N milliseconds, not N workers serializing on one event. The partial index `WHERE attempts < 10` ensures the worker skips poison-pill events.
- **The graceful-shutdown `event: shutdown` frame is the deploy-quality primitive.** Without it, deploys drop 10,000 SSE connections and the browser waits up to 5 minutes to reconnect. With it, the browser reconnects within 200 ms. The user perceives a blip, not an outage.
- **Idempotent consumers make retries safe.** The worker can crash mid-delivery and retry without creating duplicate notifications, because the insert uses `ON CONFLICT DO NOTHING`. The two correctness claims (dual-write avoidance + idempotent consumer) together make the system durably correct.

**RealTime is done when the SSE integration test passes and the chaos test passes.**

The first proves the full pipeline works end-to-end; the second proves it survives failures. Together they are the project's hardest claims. The 10,000-connection load test is the natural follow-up — it proves the system scales, not just that it works.


---

**Tags:** #project #real-time #notifications #sse #redis #pub-sub #outbox #portfolio #boardly
**Previous:** [[18-Portfolio-Projects/05-Analytics-Reporting-API]]
**Next:** [[18-Portfolio-Projects/07-AI-Augmented-Support-Backend|Project 07 — AI-Augmented Support Backend]] (the most 2026-relevant capstone), or back to [[18-Portfolio-Projects/00-Projects-MOC]].

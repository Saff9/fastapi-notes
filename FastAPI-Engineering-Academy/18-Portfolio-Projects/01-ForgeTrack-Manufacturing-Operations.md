---
title: "Project 01: ForgeTrack Manufacturing Operations"
aliases:
 - ForgeTrack
 - Manufacturing Operations
 - Production Operations API
tags:
 - project
 - manufacturing
 - multi-tenant
 - rbac
 - concurrency
 - for-update
 - audit
 - portfolio
status: complete
estimated_effort: "30–40 hours; full starter ships in ~900 LOC"
estimated_time: "30–40 hours build, 50–60 hours to perfect"
difficulty: advanced
related_lessons:
 - "[[06-SQL-Fundamentals/Transactions-Isolation-Locks]]"
 - "[[07-SQLAlchemy/05-Session-and-Transaction-Management]]"
 - "[[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]]"
 - "[[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]]"
 - "[[05-Project-Architecture/Layered-FastAPI-Apps]]"
 - "[[05-Project-Architecture/Service-and-Repository-Patterns]]"
 - "[[09-Alembic-Migrations/Alembic-Setup-and-Workflow]]"
 - "[[02-Web-and-HTTP/Idempotency-Safe-Retries-Pagination]]"
 - "[[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]]"
prerequisites:
 - "Phases 1–6 of the curriculum"
 - "[[03-FastAPI-Core/Application-and-Lifespan]]"
 - "[[03-FastAPI-Core/Dependency-Injection]]"
 - "[[07-SQLAlchemy/03-Declarative-Base-and-Mapped]]"
 - "[[07-SQLAlchemy/05-Session-and-Transaction-Management]]"
 - "[[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]]"
---

# Project 01: ForgeTrack Manufacturing Operations

*Multi-organization manufacturing operations, the way a small shop-floor SaaS actually has to build it: organizations, memberships, RBAC, production jobs and work orders, machines, inventory movements, a job status state machine, concurrency-safe stock issues with `SELECT ... FOR UPDATE`, an audit log, filtering and sorting and pagination, and a Docker dev environment that boots with `compose up`.*

**This is the project that proves you can ship a real line-of-business backend.**

ForgeTrack is not a tutorial. It is the shape of every "multi-tenant ERP" a backend engineer will be asked to build in their first three years. By the end you will have organizations that own plants, memberships that join users to organizations with roles, jobs that move through a state machine, inventory bins that two operators can issue from at the same instant without over-committing, an audit log that records every state transition, and a Dockerized dev environment with Postgres and Redis. The full starter is in this spec — type it in, run it, then take it deeper.


#project #manufacturing #multi-tenant #rbac #for-update #audit

---

## Problem Statement

A small manufacturing software vendor — call them **ForgeTrack Inc.** — sells a SaaS that small and medium job shops use to track work as it moves across the floor. Their customers are not software people; they are owners of 5-to-50-person shops that cut metal, mold plastic, assemble electronics, and produce batches of custom hardware. The owner of a six-person CNC shop does not want to install software. They want to type `https://app.forgetrack.example` into a browser, sign in, see today's jobs, and know what their operators did yesterday.

The pain is concrete. Today, those shops track work on whiteboards, spreadsheets, and shop-floor clipboards. The whiteboard says "Job 417 — drilling — at machine 3" but nobody updated it when the operator took a long lunch. The spreadsheet has one row per job and one tab per machine, so when someone asks "what did machine 3 do all week?" the answer is "go open five tabs." The clipboard on machine 3 says "bin B-7 is at 18 units" but the operator who pulled the last 4 units did not write it down because the phone rang. By Friday the inventory numbers are wrong by 12%, and on Monday someone orders raw stock they already had.

ForgeTrack's value is simple to say and hard to build: **every job's state is always correct; every bin's quantity is always correct; every change is auditable; and every user only sees the organization they belong to.** That last sentence is the project. "Correct" requires transactional concurrency control — when two operators issue stock from the same bin at the same instant, the bin must end up at the right quantity, not the average of two stale reads. "Auditable" requires an audit log written transactionally with the change it records, not in a `BackgroundTasks` afterthought. "Only sees their organization" requires object-level authorization enforced at the query layer, not at the route layer.

**Why manufacturing as the first portfolio project**

Manufacturing is the canonical "line-of-business" archetype: every concept in the academy shows up here, in production shapes. Multi-tenancy is not optional (you cannot have one customer see another's jobs). RBAC is not optional (an operator should not approve payroll). Concurrency is not optional (the bin-quantity bug is a real bug, not a code-review nit). Audit is not optional (the ISO 9001 auditor will ask). If you can ship ForgeTrack, you can ship any line-of-business API.


**Warning — When this breaks: the bin-quantity race that every team ships once.**

The ForgeTrack bug every junior dev writes is the "check then commit" pattern in `InventoryService.issue()`: `SELECT SUM(quantity) FROM movements WHERE bin_id = :bin` (reads 12), checks `12 >= 10 requested` (passes), `INSERT` a `-10` movement, `COMMIT`. Two operators run this concurrently; both reads see 12, both inserts succeed, the bin's derived quantity is now `-8` with no error log anywhere — because there *was* no error, the pre-check passed legitimately under `READ COMMITTED`. The defense is `SELECT id FROM bins WHERE id = :bin FOR UPDATE` *before* the `SUM` read, so the second transaction blocks on the row lock until the first commits; the second `SUM` then sees the first operator's negative movement and the pre-check fails. The debugging symptom is a daily report showing `SUM(quantity) = -8` for a bin that no operator would have deliberately over-issued — the audit log will show two `out` movements inside the same 50ms window, both legitimate under the snapshot they read, and the `FOR UPDATE` is the only thing that would have serialized them (see [[06-SQL-Fundamentals/Transactions-Isolation-Locks]] for the isolation-level decision tree; the `FOR UPDATE` is the same row-level lock pattern from [[07-SQLAlchemy/05-Session-and-Transaction-Management]]).


**Danger — How an attacker thinks: cross-tenant access via a path-param `job_id`.**

ForgeTrack scopes by `organization_id`, but `GET /organizations/{org}/jobs/{job_id}` still takes `job_id` as a path param. An attacker with an `operator` membership on `org-A` who learns `org-B`'s `job_id` (one phishing-email screenshot, one support-ticket attachment that quotes a job number) can `GET /organizations/{org_A_id}/jobs/{org_B_job_id}` and read `org-B` data — if the query is `SELECT * FROM jobs WHERE id = :job_id` without an `organization_id` predicate. The defense is two-layer: (1) every operational query must include `WHERE organization_id = :path_org AND organization_id = :membership_org` (the path org *and* the membership-derived org — never `WHERE id = :job_id` alone); (2) the router's `current_org` dependency re-resolves the path-param `org` against the user's memberships and returns `404 Not Found` (not `403 Forbidden`) for orgs the user does not belong to — `404` denies the attacker *the existence* of the org, not just access. The classic mistake is the junior dev who skips the dependency on one new endpoint "just to test it" and ships a `GET /jobs/{id}` that ignores `organization_id` entirely; a single red-team test (`pytest tests/security/test_cross_tenant.py::test_operator_cannot_read_other_org_job`) that asserts a tenant-A operator gets `404` on a tenant-B job is the regression net (see [[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]] for the query-layer enforcement pattern; the same defense is what makes ForgeTrack's multi-tenancy safe, see [[17-Advanced-Architecture/Multi-Tenancy]]).


---

## Target Users

The system has four primary personas. Each one has a different surface area, a different role, and a different read/write pattern.

- **The shop owner** (1 per organization). They sign up, invite their operators, define the plants and machines, and look at reporting endpoints. They have the `owner` role. They read more than they write.
- **The plant manager** (1–3 per organization). They create and schedule production jobs, assign jobs to machines, and resolve blocked work orders. They have the `manager` role. They write jobs and work orders; they read everything.
- **The operator** (5–50 per organization). They open the app at the start of their shift, see their assigned work orders, mark them in-progress when they start, record inventory movements as they pull stock, and mark them done when they finish. They have the `operator` role. They write a lot, every day, often from a tablet at the machine. They need the app to be fast and to never lose their input.
- **The auditor** (occasional, external). They are given a read-only role for the duration of an audit. They hit the audit-log endpoints and export CSVs. They read a lot, over a long time range, and they need keyset pagination because the audit log for a year is hundreds of thousands of rows.

**Note — Scale targets**

ForgeTrack is sized for SMB shops, not for Toyota. The realistic scale is: 1 to 50 organizations on a shared cluster; 5 to 50 users per organization; 50 to 500 jobs per organization per year; 1,000 to 50,000 inventory movements per organization per year; 100,000 to 1,000,000 audit-log rows per organization per year. At this scale, a single Postgres instance with the right indexes handles the load with room to spare. We are explicitly not designing for Toyota. That is a non-goal.


**Production reality: operator tablets on a metal shop floor.**

The operator persona does not hit the API from a corporate laptop on stable WiFi. They hit it from a $99 Android tablet mounted on a CNC machine, inside a Faraday-cage-ish steel building, over factory WiFi that cuts out when the spindle spins up. The first symptom of "this is not a test environment" is the `PATCH /work-orders/{id}/status` request that *succeeded* on the server (status flipped, audit row written) but whose HTTP response was eaten by the network — the operator retries, the server now sees `current == to` (both `in_progress`), the state machine raises `409 Conflict: already in_progress`, the tablet shows a red toast, and the operator tells the manager "the system lost my update." The defense is idempotency on every operator-facing mutation: a client-generated `Idempotency-Key` header on `PATCH` (the same pattern as Billing SaaS's `POST /subscriptions`, see [[02-Web-and-HTTP/Idempotency-Safe-Retries-Pagination]]) plus a `state-machine.transition(current=ANY, to=ANY)` no-op short-circuit that returns `200 OK` with the current state when `current == to` (not `409`), so a retried transition after a network drop is invisible to the operator. The same defense is what makes the operator's tablet usable in a steel building — without it, every WiFi blip costs the operator 30 seconds of "did it take?" self-doubt, and the manager escalates to engineering on a Tuesday afternoon over a bug that was never a bug.


---

## Requirements and Non-Goals

### In scope

- **Multi-organization**: organizations are first-class entities; users belong to one or more organizations through memberships; every row of operational data is scoped by `organization_id`; no cross-organization reads are possible by design.
- **RBAC**: four roles — `owner`, `manager`, `operator`, `auditor` — with role permissions enforced by a `Depends` that the router composition cannot accidentally skip.
- **Production jobs and work orders**: a job is the customer-facing work item ("make 100 brackets for ACME"); a work order is the internal execution plan ("operation 1: saw 100 blanks; operation 2: mill 100 brackets; operation 3: deburr"). Jobs move through a state machine: `draft → planned → in_progress → completed` (and `cancelled` from any non-terminal state).
- **Machines and equipment**: machines belong to plants; plants belong to organizations; work orders are assigned to machines; capacity reports aggregate by machine and by day.
- **Inventory movements**: bins hold stock; movements are append-only (`in`, `out`, `adjust`); every movement references a job and a work order when it is an `out` movement; the bin's current quantity is the sum of movements (we do not store a running `quantity` column; quantity is derived state (`SUM(movements)`), not stored state that could drift out of sync if a code path forgot to update both).
- **Concurrency-safe inventory**: `out` movements use `SELECT ... FOR UPDATE` on the bin's row to serialize concurrent issues; the check "does the bin have enough?" happens inside the lock.
- **Audit log**: every state transition (job status change, work order status change, inventory movement) writes an audit row in the same transaction as the change; the audit row records *who*, *when*, *what*, *before*, *after*.
- **Filtering, sorting, pagination**: list endpoints support `?status=in_progress&machine_id=3&sort=-created_at&limit=50&cursor=...`; pagination is keyset (cursor) for audit log and offset for small lists.
- **Reporting**: `GET /organizations/{org}/reports/daily-output?from=2026-01-01&to=2026-01-31` returns a per-day, per-machine count of completed work orders; `GET /organizations/{org}/reports/inventory-snapshot` returns the current bin quantities.
- **Docker dev**: `docker compose up --build` boots Postgres 17, Redis 7, the API, and runs Alembic migrations; the spec includes a Dockerfile, a compose.yaml, a `.env.example`, and five ordered Alembic revisions.
- **Automated tests**: at least five tests, including the concurrency test that proves two parallel `out` movements do not over-commit.

**Warning — When this breaks: the state machine that silently accepts every transition.**

The `JobService.transition(job_id, to=...)` function looks like a switch statement: `match to: case "in_progress" | "completed" | "cancelled": job.status = to`. The bug is the missing *rejection*: a junior dev writes that match statement and now `draft -> completed` is accepted (skipping `planned` and `in_progress`), and the audit log records a `draft -> completed` transition that no real-world job ever makes. The defense is a *transition matrix* — an explicit `ALLOWED_TRANSITIONS: dict[Status, set[Status]]` mapping `{draft: {planned, cancelled}, planned: {in_progress, cancelled}, in_progress: {completed, cancelled}}` — plus a `raise InvalidTransition(current, to)` for any `(current, to)` pair not in the matrix, plus a property-based test (`pytest -k "property_state_machine"` with `hypothesis.settings(max_examples=200)` generating `(current, to)` tuples) that asserts every rejected transition raises and every accepted transition writes an audit row in the same transaction (see [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]] for the property-test pattern). The audit row is the *second* line of defense — when the matrix is wrong (someone added a transition without updating the matrix), the audit log records what actually happened, and the on-call engineer reads the matrix mismatch off the audit-log row instead of off a customer escalation (see [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]] for the structured-log fields that make this debuggable).


### Explicit non-goals

- **We do not build a UI.** This is an API. A future team can hang a React or HTMX front end off it; the spec does not constrain that choice.
- **We do not implement payroll, HR, or accounting.** ForgeTrack tracks operations; it does not cut paychecks. The `auditor` role has no payroll access because there is no payroll endpoint to access.
- **We do not integrate with an ERP upstream** (SAP, Oracle, NetSuite). The integration adapter is sketched in the spec but the implementation is a `# complete this:` stub.
- **We do not support real-time machine telemetry** (modbus, OPC-UA). Machines in ForgeTrack are scheduling entities, not IoT endpoints.
- **We do not support cross-organization reporting.** A platform-level `super_admin` role is sketched but explicitly not built; multi-tenant aggregation is a future concern.
- **We do not implement a barcode scanner driver.** Operators type movement quantities; the API accepts them.
- **We do not support multi-currency.** Cost fields are stored as numeric; currency is a single organization-level setting.

**Warning — Scope discipline is a senior skill.**

The most common reason a portfolio project stalls at 60% is scope creep. The non-goals above are not "things we ran out of time for" — they are *things we deliberately refuse to build* so the project can ship. If a reviewer asks "why does ForgeTrack not do X?", the answer is "because X is in the non-goals, and that is the scope." Defending scope is the senior skill.


**Danger — How an attacker thinks: the ERP stub that becomes a production SSRF surface.**

The ERP integration is a `# complete this:` stub — a `class ERPAdapter: async def push_job(self, job): raise NotImplementedError`. In production, a junior dev wires it to a `httpx.post(f"{settings.erp_base_url}/jobs", json=job.model_dump())` call inside `JobService.create()`, the URL is built from `settings.erp_base_url` that defaults to `http://localhost:8080` in dev and `https://erp.customer.example` in prod, and the customer's ERP admin (who is the attacker in this scenario) controls `erp.customer.example`'s response — a `200 OK` body containing `{"external_ref": "'; DROP TABLE jobs; --"}` is the boring attack, the real one is a `Location: file:///etc/passwd` redirect that `httpx` follows by default (`follow_redirects=True`) and your server-side SSRF surface is now a thing. The defense is the [[15-External-Integrations/HTTP-Clients-Timeouts-Retries]] pattern: `httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=2.0), follow_redirects=False)`, an allowlist on `erp_base_url`'s host (reject `127.0.0.1`, `169.254.169.254`, RFC 1918 ranges), and a Pydantic validator on the ERP's response before storing `external_ref` (see [[04-Pydantic/Validators-Strict-vs-Coercive]] for the field-validator pattern, and [[06-SQL-Fundamentals/SQL-Injection-and-Parameterized-Queries]] for why the `'; DROP TABLE` attack is defended by parameterized queries regardless). The stub stays a stub in the starter so the learner makes these decisions consciously, not by accident of an incomplete implementation that ships to prod.


---

## Architecture Diagram

```mermaid
flowchart LR
 subgraph Client
 OP[Operator tablet]
 MGR[Manager laptop]
 OWN[Owner laptop]
 AUD[Auditor]
 end

 subgraph Edge
 LB[Load balancer<br/>TLS termination]
 end

 subgraph API["FastAPI app (uvicorn, async)"]
 AUTH[auth router<br/>JWT issue/refresh]
 JOBS[jobs router<br/>create / list / transition]
 WO[work-orders router<br/>list / assign / transition]
 INV[inventory router<br/>movements + bin state]
 REP[reports router<br/>daily output + inventory snapshot]
 AUD2[audit router<br/>read-only, keyset]
 end

 subgraph Services
 SEC[SecurityService<br/>RBAC + org scope]
 JOB_SVC[JobService<br/>state machine]
 INV_SVC[InventoryService<br/>FOR UPDATE serializer]
 AUD_SVC[AuditService<br/>same-txn writes]
 end

 subgraph State
 PG[(PostgreSQL 17<br/>organizations, memberships, jobs,<br/>work_orders, machines, bins,<br/>movements, audit_log)]
 REDIS[(Redis 7<br/>rate limits + cached reports)]
 end

 OP --> LB
 MGR --> LB
 OWN --> LB
 AUD --> LB
 LB --> AUTH
 LB --> JOBS
 LB --> WO
 LB --> INV
 LB --> REP
 LB --> AUD2

 AUTH --> SEC
 JOBS --> JOB_SVC
 WO --> JOB_SVC
 INV --> INV_SVC

 JOB_SVC --> AUD_SVC
 INV_SVC --> AUD_SVC
 JOB_SVC --> PG
 INV_SVC --> PG
 AUD_SVC --> PG
 REP --> PG
 REP --> REDIS

 style LB fill:#dbeafe,stroke:#1d4ed8
 style API fill:#fef3c7,stroke:#b45309
 style PG fill:#dcfce7,stroke:#15803d
 style REDIS fill:#fce7f3,stroke:#be185d
 style INV_SVC fill:#ffe4e6,stroke:#be123c
```

The shape is the classic layered FastAPI app (see [[05-Project-Architecture/Layered-FastAPI-Apps]]): routers are thin HTTP adapters; services own the workflow and transaction boundaries; SQLAlchemy 2.x async sessions are the data layer. There is exactly one service per workflow (JobService, InventoryService, AuditService, SecurityService), and routers compose them through `Depends`. The Postgres instance is the source of truth for everything mutable; Redis holds rate-limit counters and a short-TTL cache for the daily-output report.

**Why one service per workflow, not one per entity**

A common mistake is to write `JobService`, `WorkOrderService`, `MachineService`, `BinService`, `MovementService`, `AuditService`, `OrganizationService` — seven services for seven tables. That misses the point. Workflows span tables: the "issue stock" workflow writes a `movement`, updates no `bin` (because quantity is derived), and writes an `audit_log` row, all in one transaction. That workflow is owned by one service: `InventoryService`. The service owns the workflow, not the table. The router calls the service; the service calls the session. This is the lesson from [[05-Project-Architecture/Service-and-Repository-Patterns]]: services map to workflows, repositories (when you have them) map to entities. We do not have repositories in ForgeTrack because the SQL is simple enough that the service can call `session.execute(select(...))` directly. Adding a `Repository` layer here would be premature abstraction (see [[05-Project-Architecture/When-Abstraction-Is-Worth-It]]).


**Why one Postgres instance, not a read replica for the reports endpoint?**

Because at ForgeTrack's scale (single org, ~50 concurrent operators, daily reports taking 200 ms) the read replica is a solution to a problem that does not exist yet — and it adds the operational cost of replication lag, failover semantics, and a second connection pool to manage. The reports endpoint already caches the daily-output report in Redis with a 5-minute TTL (see [[14-Caching-and-Background-Processing/Redis-Cache-Aside]]); the cache absorbs 99% of the report reads. The 1% that miss the cache hit the primary, which can absorb a 200-ms query without affecting operators because operators write to `jobs` and `work_orders` (high-frequency, low-latency) while reports read from `movements` (low-frequency, high-latency). The split becomes necessary when reports take >1 s or when the org grows to the point that operators and reports contend on the same buffer locks — neither is close at this scale.

**Production reality: Redis as a single point of failure, accepted.**

The diagram shows a single Redis 7 node, not a Redis Cluster. At ForgeTrack's scale (5-to-50-person shops, ~10 cache reads per operator per shift), a single Redis instance with AOF every-1-second persistence is correct — the rate-limit counters and report caches it holds are *recreatable*: a cache miss is a 200ms report query, not a data loss; a lost rate-limit counter is a window where one tenant can exceed their limit by ~100 requests, which ForgeTrack does not bill for anyway. The defense is not Redis Cluster; it is (1) the application falling through to Postgres on `redis.exceptions.ConnectionError` with a `try/except` around `await redis.get(key)` that logs `cache_miss=ConnectionError` and continues, (2) a startup healthcheck in `lifespan` that fails-fast if Redis is unreachable on boot (a missing cache is fine; a missing rate-limit counter is a security regression, because the fallback is "allow all" if you forget to handle the exception and the rate limit silently disables itself — see [[11-Authentication-and-Security/Threat-Model-First]] for the "fail-open vs fail-closed" decision on rate-limit deps). The mistake to avoid: a Redis Cluster deploy at ForgeTrack's scale adds 3+ nodes, a gossip protocol, and a slot-migration surface that is harder to operate than the app it fronts (see [[14-Caching-and-Background-Processing/Redis-Cache-Aside]] for the cache-aside contract and [[03-FastAPI-Core/Application-and-Lifespan]] for the startup healthcheck pattern).


---

## ER Diagram

```mermaid
erDiagram
 organizations ||--o{ memberships : has
 users ||--o{ memberships : belongs_to
 organizations ||--o{ plants : owns
 plants ||--o{ machines : contains
 organizations ||--o{ jobs : owns
 jobs ||--o{ work_orders : contains
 work_orders }o--|| machines : assigned_to
 organizations ||--o{ bins : owns
 bins ||--o{ movements : tracks
 jobs o|--o{ movements : consumes (optional; only `out` movements reference a job)
 work_orders o|--o{ movements : records (optional; only `out` movements reference a work order)
 organizations ||--o{ audit_log : scoped_to

 organizations {
 uuid id PK
 string name
 string slug UK
 string default_currency
 timestamptz created_at
 }
 users {
 uuid id PK
 string email UK
 string password_hash
 timestamptz created_at
 }
 memberships {
 uuid id PK
 uuid user_id FK
 uuid organization_id FK
 enum role
 timestamptz created_at
 }
 plants {
 uuid id PK
 uuid organization_id FK
 string name
 string timezone
 }
 machines {
 uuid id PK
 uuid plant_id FK
 string code UK
 string name
 enum status
 }
 jobs {
 uuid id PK
 uuid organization_id FK
 string external_ref
 string customer
 string part_number
 int quantity_ordered
 enum status
 timestamptz created_at
 timestamptz updated_at
 }
 work_orders {
 uuid id PK
 uuid job_id FK
 int sequence
 string operation
 uuid machine_id FK
 int quantity_planned
 int quantity_completed
 enum status
 timestamptz started_at
 timestamptz completed_at
 }
 bins {
 uuid id PK
 uuid organization_id FK
 string code UK
 string description
 }
 movements {
 uuid id PK
 uuid bin_id FK
 uuid job_id FK
 uuid work_order_id FK
 enum kind
 int quantity
 text note
 uuid actor_id FK
 timestamptz at
 }
 audit_log {
 bigint id PK
 uuid organization_id FK
 uuid actor_id FK
 string action
 string entity_type
 uuid entity_id
 jsonb before
 jsonb after
 timestamptz at
 }
```

A few non-obvious choices:

- **`movements.quantity` is signed.** An `in` movement is positive; an `out` movement is negative; an `adjust` can be either. The bin's current quantity is `SELECT COALESCE(SUM(quantity), 0) FROM movements WHERE bin_id = :bin_id`. There is no `bins.quantity` column. This eliminates the dual-write problem entirely (see [[14-Caching-and-Background-Processing/Transactional-Outbox]] for the general pattern of "don't store derived state in mutable columns").
- **`audit_log.id` is a `bigint` with a sequence**, not a `uuid`. Audit log writes are append-only and high-volume; a sequence is faster than a UUID generator and gives natural ordering. The trade-off is that the audit log is the only table that leaks an integer count to the outside world — which is fine, because the auditor is internal.
- **`audit_log.before` and `audit_log.after` are `jsonb`.** We store the row's state before and after the change as JSON. This is more flexible than columns (`before_status`, `after_status`, `before_quantity`, `after_quantity`, ...) and lets us add new audited fields without migrating the audit log.
- **`memberships` is a join table with a `role` column**, not a column on `users`. A user can belong to multiple organizations with different roles in each. The classic case is the consultant who is an `owner` of their own shop and an `auditor` of their client's shop.
- **`machines.code` is unique within an organization**, not globally. The `(organization_id, code)` pair is the natural key. This is enforced by a partial unique index.

**Why is `movements` the source of truth, not `bins.quantity`?**

Because the bin's quantity is *derived* from the movements, not a fact in itself. If you store both, you have the dual-write problem: a movement is written, the bin's quantity is updated, and if either write fails (transaction rolls back, process crashes, network blip), the two disagree. With derived-only state, there is exactly one source of truth, and the bin's quantity is computed on read (with a cache layer for hot bins). The cost is one `SUM` query per read; the win is zero consistency bugs. For ForgeTrack's scale (50,000 movements/year/org), the `SUM` query is fast with a partial index on `(bin_id, at)`.


---

## Sequence Diagrams

Three workflows carry the project's hardest correctness requirements. We draw each one as a sequence diagram so the locks and the audit writes are visible.

### Workflow 1: Issue stock from a bin (the concurrency-critical path)

Two operators click "Issue 4 units from bin B-7" within the same 100 ms. The system must serialize them. The diagram shows the two requests, the `SELECT ... FOR UPDATE` lock, the check-then-write inside the lock, and the audit row in the same transaction.

```mermaid
sequenceDiagram
 participant OP1 as Operator A
 participant OP2 as Operator B
 participant API as InventoryService
 participant DB as PostgreSQL
 participant AUD as AuditService

 OP1->>API: POST /inventory/movements {bin: B-7, qty: -4, job: 417, wo: 12}
 OP2->>API: POST /inventory/movements {bin: B-7, qty: -4, job: 418, wo: 9}
 Note over API,DB: Two transactions start, both reach the lock
 API->>DB: BEGIN<br/>SELECT ... FROM movements WHERE bin_id=B-7 FOR UPDATE
 Note over DB: B-7's row range is locked<br/>Tx 1 holds the lock
 API->>DB: SELECT COALESCE(SUM(quantity),0) FROM movements WHERE bin_id=B-7
 DB-->>API: 14 (current bin quantity)
 Note over API: 14 - 4 = 10 ≥ 0, OK to issue
 API->>DB: INSERT INTO movements (bin, qty=-4, job=417, wo=12, actor=A)
 API->>AUD: INSERT INTO audit_log (action, before={qty:14}, after={qty:10}, ...)
 API->>DB: COMMIT
 Note over DB: Lock released
 API->>DB: (Tx 2 now acquires lock)
 API->>DB: SELECT COALESCE(SUM(quantity),0) FROM movements WHERE bin_id=B-7
 DB-->>API: 10 (already updated)
 Note over API: 10 - 4 = 6 ≥ 0, OK to issue
 API->>DB: INSERT INTO movements (bin, qty=-4, job=418, wo=9, actor=B)
 API->>AUD: INSERT INTO audit_log (action, before={qty:10}, after={qty:6}, ...)
 API->>DB: COMMIT
 API-->>OP1: 201 Created {movement_id, bin_quantity_after: 10}
 API-->>OP2: 201 Created {movement_id, bin_quantity_after: 6}
```

**Warning — Why `SELECT ... FOR UPDATE` and not an `UPDATE ... WHERE quantity >= 4`?**

You *can* issue stock with a single statement: `UPDATE bins SET quantity = quantity - 4 WHERE id = :bin AND quantity >= 4`. Postgres will take a row lock and the operation is atomic. So why not do that? Two reasons. (1) ForgeTrack stores quantity as the `SUM` of movements, not on the bin row — so there is no `quantity` column to update. (2) We need the bin's *before* and *after* quantities for the audit row, and we need to write the movement and the audit row in the same transaction with the lock held. `SELECT FOR UPDATE` lets us read, decide, write, audit, commit — all inside one lock. A single `UPDATE` would not give us the audit context. The general lesson from [[06-SQL-Fundamentals/Transactions-Isolation-Locks]]: pick the locking primitive that matches the workflow, not the one that looks clever.


### Workflow 2: Transition a job's status (the state machine)

A manager clicks "Start job 417." The job moves from `planned` to `in_progress`. The transition is only valid from `planned`; from `draft` or `completed` it is a 409.

```mermaid
sequenceDiagram
 participant MGR as Manager
 participant API as JobService
 participant DB as PostgreSQL
 participant AUD as AuditService

 MGR->>API: POST /jobs/417/transitions {to: in_progress}
 API->>DB: BEGIN<br/>SELECT * FROM jobs WHERE id=417 FOR UPDATE
 DB-->>API: Job{status: planned, ...}
 Note over API: Validate: planned → in_progress is allowed
 API->>DB: UPDATE jobs SET status='in_progress', updated_at=NOW() WHERE id=417
 API->>AUD: INSERT INTO audit_log (action='job.transition',<br/>before={status:'planned'}, after={status:'in_progress'}, actor=...)
 API->>DB: COMMIT
 API-->>MGR: 200 OK {id, status: in_progress}
 Note over MGR,DB: A transition from 'completed' would 409 here
```

The lock here is also `FOR UPDATE`, but for a different reason than the bin: we serialize the read-then-write so that two managers cannot transition the same job to two different statuses at the same instant. (The state machine itself is enforced by the service; the lock is defense in depth.)

### Workflow 3: List audit log with keyset pagination

The auditor asks for the last 50 audit-log rows after a given cursor. The cursor is the `(at, id)` pair of the last row they have already seen.

```mermaid
sequenceDiagram
 participant AUD as Auditor
 participant API as AuditRouter
 participant DB as PostgreSQL

 AUD->>API: GET /audit?cursor=2026-10-19T12:34:56Z,12345&limit=50
 API->>API: Parse cursor into (at, id)
 API->>DB: SELECT * FROM audit_log<br/>WHERE organization_id = :org<br/>AND (at, id) < (:cursor_at, :cursor_id)<br/>ORDER BY at DESC, id DESC<br/>LIMIT 51
 DB-->>API: 51 rows (limit + 1 to detect has_more)
 API->>API: Drop the 51st row<br/>encode (at, id) of row 50 as next cursor
 API-->>AUD: 200 OK {rows: [...50 rows], next_cursor: "...", has_more: true}
```

**Why keyset and not offset**

`OFFSET 100000 LIMIT 50` is O(100050) work in Postgres: it materializes 100050 rows then discards 100000. For an audit log that grows to a million rows a year, that is the difference between a 5 ms endpoint and a 500 ms endpoint. Keyset (`WHERE (at, id) < (?, ?) ORDER BY at DESC, id DESC LIMIT 50`) is O(50) work, plus the index seek. The cost is that you cannot jump to page 47 directly; you must walk the cursor. For audit logs that is the right trade. See [[02-Web-and-HTTP/Idempotency-Safe-Retries-Pagination]] for the general treatment of cursor pagination.


---

## API Specification

All endpoints are prefixed with `/api/v1`. All write endpoints require `Content-Type: application/json` and a valid `Authorization: Bearer <jwt>` header. Read endpoints also require a JWT; there are no anonymous reads.

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| `POST` | `/auth/register` | anonymous | Create a user (email + password). Returns a user, not a JWT. |
| `POST` | `/auth/login` | anonymous | Exchange email + password for a JWT access token + refresh token. |
| `POST` | `/auth/refresh` | any | Exchange a refresh token for a new access token. |
| `GET` | `/organizations` | any | List the organizations the current user is a member of. |
| `POST` | `/organizations` | any | Create a new organization (the creator becomes `owner`). |
| `POST` | `/organizations/{org_id}/memberships` | `owner` | Invite a user to an organization with a role. |
| `GET` | `/organizations/{org_id}/plants` | any member | List plants. |
| `POST` | `/organizations/{org_id}/plants` | `owner,manager` | Create a plant. |
| `GET` | `/organizations/{org_id}/machines` | any member | List machines, optionally filtered by `?plant_id=`. |
| `POST` | `/organizations/{org_id}/machines` | `owner,manager` | Create a machine. |
| `GET` | `/organizations/{org_id}/jobs` | any member | List jobs, filterable by `?status=&customer=&sort=&limit=&cursor=`. |
| `POST` | `/organizations/{org_id}/jobs` | `owner,manager` | Create a job in `draft` status. |
| `GET` | `/organizations/{org_id}/jobs/{job_id}` | any member | Fetch one job (with its work orders). |
| `POST` | `/organizations/{org_id}/jobs/{job_id}/transitions` | `owner,manager` | Transition a job's status. Body: `{"to": "planned"}`. |
| `GET` | `/organizations/{org_id}/jobs/{job_id}/work-orders` | any member | List work orders for a job. |
| `POST` | `/organizations/{org_id}/jobs/{job_id}/work-orders` | `owner,manager` | Add a work order to a job. |
| `POST` | `/organizations/{org_id}/work-orders/{wo_id}/transitions` | `owner,manager,operator` | Transition a work order (operators can start/finish their own). |
| `GET` | `/organizations/{org_id}/bins` | any member | List bins. |
| `POST` | `/organizations/{org_id}/bins` | `owner,manager` | Create a bin. |
| `GET` | `/organizations/{org_id}/bins/{bin_id}` | any member | Fetch a bin with its current quantity (computed). |
| `POST` | `/organizations/{org_id}/inventory/movements` | `owner,manager,operator` | Record a movement (in/out/adjust). Concurrency-safe. |
| `GET` | `/organizations/{org_id}/inventory/movements` | any member | List movements, filterable by `?bin_id=&job_id=&kind=&from=&to=`. |
| `GET` | `/organizations/{org_id}/reports/daily-output` | `owner,manager,auditor` | Per-day, per-machine count of completed work orders. Caches 5 min. |
| `GET` | `/organizations/{org_id}/reports/inventory-snapshot` | any member | All bins with current quantities. |
| `GET` | `/organizations/{org_id}/audit` | `owner,auditor` | Audit log, keyset pagination. |

**Note — The `{org_id}` path segment is the load-bearing authorization**

Every operational endpoint is scoped by `{org_id}` in the path. The `SecurityService.current_membership(org_id)` dependency checks that the user has a membership in *that* organization and returns the membership (with the role). Routers never read from `request.user` directly — they read from the membership. This is object-level authorization at the route layer, the lesson from [[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]].


---

## Folder Structure

```
forgetrack/
├── app/
│ ├── __init__.py # empty; makes `app` a package
│ ├── main.py # FastAPI() + lifespan + router registration
│ ├── config.py # Settings(BaseSettings) — env-driven
│ ├── db.py # engine, async_sessionmaker, Base
│ ├── deps.py # get_session, current_user, current_membership
│ ├── security.py # password hash, JWT issue/verify, RBAC dependency
│ ├── audit.py # AuditService.write(...); same-txn writes
│ ├── models/
│ │ ├── __init__.py # re-export all models for Alembic
│ │ ├── base.py # DeclarativeBase + TimestampMixin
│ │ ├── org.py # Organization, Membership
│ │ ├── user.py # User
│ │ ├── plant.py # Plant, Machine
│ │ ├── job.py # Job, WorkOrder
│ │ ├── inventory.py # Bin, Movement
│ │ └── audit.py # AuditLog
│ ├── schemas/
│ │ ├── __init__.py
│ │ ├── auth.py
│ │ ├── org.py
│ │ ├── plant.py
│ │ ├── job.py
│ │ ├── inventory.py
│ │ ├── audit.py
│ │ └── common.py # Page[T], ErrorResponse
│ ├── services/
│ │ ├── __init__.py
│ │ ├── jobs.py # JobService — state machine + transitions
│ │ ├── inventory.py # InventoryService — FOR UPDATE serializer
│ │ └── reports.py # ReportsService — cached aggregations
│ └── routers/
│ ├── __init__.py
│ ├── auth.py
│ ├── orgs.py
│ ├── plants.py
│ ├── jobs.py
│ ├── work_orders.py
│ ├── inventory.py
│ ├── reports.py
│ └── audit.py
├── alembic/
│ ├── env.py
│ ├── script.py.mako
│ └── versions/
│ ├── 0001_initial_orgs_users_memberships.py
│ ├── 0002_plants_machines.py
│ ├── 0003_jobs_work_orders.py
│ ├── 0004_bins_movements.py
│ └── 0005_audit_log.py
├── tests/
│ ├── conftest.py # fixtures: engine, session, client, seeded org
│ ├── test_auth.py
│ ├── test_jobs.py
│ ├── test_inventory_concurrency.py # the test that proves FOR UPDATE works
│ ├── test_audit.py
│ └── test_reports.py
├── .env.example
├── Dockerfile
├── compose.yaml
├── pyproject.toml
└── README.md
```

**Tip — Why a `models/` package instead of one `models.py`**

Once you have eight tables, one `models.py` becomes 600 lines and circular imports start biting (Job imports WorkOrder imports Machine imports Plant imports Organization, all in one file, and any change forces the whole file to re-evaluate). A package lets each model live in its own module; `models/__init__.py` re-exports them so Alembic's `target_metadata` import still works as `from app.models import *`. The same shape applies to `schemas/`, `services/`, and `routers/`.


---

## Database Design

### Naming conventions

- Tables: `snake_case`, plural (`organizations`, `work_orders`, `audit_log`).
- Columns: `snake_case` (`created_at`, `organization_id`, `external_ref`).
- Foreign keys: `<singular_entity>_id` (`job_id`, `bin_id`, `organization_id`).
- Indexes: `ix_<table>_<columns>` (the SQLAlchemy 2.x default).
- Enum types: lowercase (`job_status`, `movement_kind`, `role`).

### Tables and constraints

**`organizations`**: `id (uuid PK)`, `name (text not null)`, `slug (text not null unique)`, `default_currency (text not null default 'USD')`, `created_at (timestamptz not null default now())`.

**`users`**: `id (uuid PK)`, `email (citext not null unique)`, `password_hash (text not null)`, `created_at`. The `citext` extension gives case-insensitive uniqueness so `Alice@example.com` and `alice@example.com` cannot both exist.

**`memberships`**: `id (uuid PK)`, `user_id (uuid FK users.id on delete cascade)`, `organization_id (uuid FK organizations.id on delete cascade)`, `role (enum not null)`, `created_at`. Unique constraint on `(user_id, organization_id)` — a user has at most one membership per org.

**`plants`**: `id (uuid PK)`, `organization_id (uuid FK)`, `name (text)`, `timezone (text not null default 'UTC')`. Unique `(organization_id, name)`.

**`machines`**: `id (uuid PK)`, `plant_id (uuid FK plants.id)`, `code (text)`, `name (text)`, `status (enum: 'available','busy','maintenance','retired')`. Unique `(organization_id, code)` enforced by a partial index that joins to `plants` (or, more simply, by storing `organization_id` on `machines` redundantly and unique-ing on that — we choose the latter for query simplicity).

**`jobs`**: `id (uuid PK)`, `organization_id (uuid FK)`, `external_ref (text)` (the customer's PO number), `customer (text)`, `part_number (text)`, `quantity_ordered (int not null check > 0)`, `status (enum: 'draft','planned','in_progress','completed','cancelled')`, `created_at`, `updated_at`. Index on `(organization_id, status)`, `(organization_id, created_at)`.

**`work_orders`**: `id (uuid PK)`, `job_id (uuid FK jobs.id on delete cascade)`, `sequence (int not null)`, `operation (text not null)`, `machine_id (uuid FK machines.id)`, `quantity_planned (int not null check > 0)`, `quantity_completed (int not null default 0 check >= 0)`, `status (enum)`, `started_at`, `completed_at`. Unique `(job_id, sequence)`.

**`bins`**: `id (uuid PK)`, `organization_id (uuid FK)`, `code (text)`, `description (text)`. Unique `(organization_id, code)`.

**`movements`**: `id (uuid PK)`, `bin_id (uuid FK bins.id on delete restrict)`, `job_id (uuid FK jobs.id on delete set null)`, `work_order_id (uuid FK work_orders.id on delete set null)`, `kind (enum: 'in','out','adjust')`, `quantity (int not null)`, `note (text)`, `actor_id (uuid FK users.id)`, `at (timestamptz not null default now())`. Index on `(bin_id, at)` for the bin-quantity SUM query; `(job_id, at)` for job movement history; `(organization_id, at)` — wait, there is no `organization_id` on movements; we join through `bins`.

**The `(bin_id, at)` index is the hottest index in the system**

Every `POST /inventory/movements` does `SELECT SUM(quantity) FROM movements WHERE bin_id = :bin_id` to check the bin's quantity before issuing. Every `GET /bins/{id}` does the same SUM. That SUM is O(rows in the bin) without an index, and a busy bin can have 10,000 movements. The `(bin_id, at)` index makes it an index-only scan that is O(log n) for the seek plus O(50) for the typical recent movements. Without this index, the inventory endpoint degrades from 5 ms to 200 ms after a year of use.


**`audit_log`**: `id (bigint PK generated always as identity)`, `organization_id (uuid FK)`, `actor_id (uuid FK users.id)`, `action (text not null)` (e.g., `job.transition`, `inventory.movement`, `work_order.transition`), `entity_type (text)`, `entity_id (uuid)`, `before (jsonb)`, `after (jsonb)`, `at (timestamptz not null default now())`. Index on `(organization_id, at desc, id desc)` — the index that makes keyset pagination fast.

**Why bigint identity for `audit_log` instead of uuid?**

Because the audit log is read sequentially (keyset pagination by `(organization_id, at desc, id desc)`) and bigint is 8 bytes vs uuid's 16, plus the bigint identity column is monotonically increasing — which means new audit rows always append to the same b-tree page, making inserts O(1) page-write rather than O(log n) random-page-write. UUIDs would scatter inserts across the entire b-tree, halving insert throughput on a busy audit table. The trade is that the audit log's PK is enumerable — an attacker who can read `audit_log.id = 5` can guess that `audit_log.id = 4` exists — but the audit endpoint is RBAC-gated to `Role.AUDITOR` and never exposes the raw id in a URL. The non-enumerability property of UUIDs is only worth paying for when the PK appears in a URL accessible to untrusted clients.

### Why uuid PKs

ForgeTrack uses `uuid` PKs everywhere except `audit_log` (which uses `bigint` for the natural ordering). UUIDs are non-sequential, so they do not cause Postgres b-tree page splits the way a serial int does under concurrent inserts. More important, they are unguessable: a URL like `/api/v1/organizations/{org_id}/jobs/{job_id}` does not leak the count of jobs in the system. The cost is 16 bytes per PK instead of 4 or 8; at ForgeTrack's scale, that is negligible. The generation strategy is `gen_random_uuid()` (Postgres 13+ built-in; no `uuid-ossp` extension needed).

**Warning — `uuid` PKs and `OFFSET` pagination do not mix**

If you ever list `movements` with `OFFSET 100 LIMIT 50 ORDER BY id`, you are ordering by a UUID — which is meaningless. Always order by a meaningful column (`at`, `created_at`, `sequence`). The general rule: pick a PK type that fits your access pattern, not the one that looks modern.


---

## Security Model

### Authentication

Users authenticate with email + password. Passwords are hashed with `argon2-cffi` (the modern default; see [[11-Authentication-and-Security/Password-Hashing]] for why we no longer use bcrypt by default). The login endpoint returns a short-lived (15 min) JWT access token and a long-lived (30 day) refresh token (rotating). Refresh tokens are stored *hashed* in a `refresh_tokens` table so a database leak does not compromise active sessions.

### Authorization

Authorization is two-layer:

1. **Authentication layer**: the `current_user` dependency decodes the JWT and yields a `User`. No route is reachable without it.
2. **Membership layer**: the `current_membership(org_id)` dependency checks that the user has a `Membership` in the `{org_id}` path parameter. If they do not, it returns 404 (not 403 — we leak no information about whether the org exists).

**Why 404 and not 403 for "user has no membership in this org"?**

Because a 403 leaks the existence of the org. If the API returned 403, an attacker probing org IDs could distinguish "the org exists and I am not a member" (403) from "the org does not exist" (404) — and would then know which org IDs to phish for membership. A 404 for both cases is the same response whether the org exists or not, removing the information leak. The cost is debugging friction — a developer who is genuinely a member but types the wrong org id gets a 404 and may waste an hour wondering why the org "doesn't exist" — but the security property is more important than the developer experience. See [[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]] for the general pattern.

### Role enforcement

Roles are checked through a `require_roles(*roles)` dependency factory:

```python
def require_roles(*roles: Role) -> Callable[..., Membership]:
 def _dependency(membership: Annotated[Membership, Depends(current_membership)]) -> Membership:
 if membership.role not in roles:
 raise HTTPException(403, detail={
 "code": "forbidden_role",
 "required": [r.value for r in roles],
 "actual": membership.role.value,
 })
 return membership
 return _dependency
```

Routers compose it:

```python
@router.post("/jobs/{job_id}/transitions", dependencies=[Depends(require_roles(Role.OWNER, Role.MANAGER))])
async def transition_job(...): ...
```

The `Depends(...)` argument in `router.post(..., dependencies=[...])` is *always* evaluated before the route function — there is no way for a developer to forget to call it. This is the lesson from [[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]]: authorization must be enforced by composition, not by inline checks.

### Secrets and configuration

- The `FORGETRACK_SECRET_KEY` for JWT signing comes from the environment (the `FORGETRACK_` prefix matches `env_prefix="FORGETRACK_"`). The startup code refuses to boot if `FORGETRACK_SECRET_KEY == "dev-only-change-me"`.
- The database password comes from `FORGETRACK_DATABASE_URL` in the environment (the `FORGETRACK_` prefix matches the `env_prefix="FORGETRACK_"` convention taught in [[04-Pydantic/Pydantic-Settings]]); never from a checked-in file.
- The `.env.example` contains placeholder values (`FORGETRACK_SECRET_KEY=dev-only-change-me`, `FORGETRACK_DATABASE_URL=postgresql+asyncpg://forgetrack:forgetrack@db:5432/forgetrack`). Real production secrets come from the platform's secret store (Fly.io secrets, AWS SSM, Kubernetes secrets).

### Audit

Every state transition (job status, work order status, inventory movement) writes an audit row in the same transaction as the change. This is *not* a `BackgroundTasks` after-the-fact log — it is in the transaction. If the change commits, the audit row commits; if the change rolls back, the audit row rolls back. There is no scenario where the change happened and the audit did not.

**Danger — Why audit-in-the-same-transaction is non-negotiable**

If you write the audit row in a `BackgroundTasks` after the response is sent, two bugs follow. (1) The background task can fail (process killed, queue full) and you lose the audit row — the change happened, the audit did not, and the ISO 9001 auditor is now your problem. (2) The background task can succeed but the *original* transaction can roll back after the response was sent (rare but possible under connection-pool failure modes) — you now have an audit row for a change that did not happen. Either bug is unacceptable. The fix is structural: the audit write is in the transaction. Background tasks are for things the user does not need to be true at the moment they receive the response — sending a welcome email, invalidating a cache. Audit is not one of those things.


---

## Milestones

Ordered. Each milestone has explicit completion criteria. Do not start the next milestone until the previous one's criteria are met.

### M1: Scaffold and config

**Deliverable**: A FastAPI app that boots, exposes `/healthz` and `/docs`, and connects to Postgres + Redis via `lifespan`.

**Done when**:
- `docker compose up --build` boots Postgres, Redis, and the API.
- `curl localhost:8000/healthz` returns `{"status":"ok"}`.
- `curl localhost:8000/docs` returns the OpenAPI page.
- The lifespan logs include `engine ready` and `redis ready`.
- `pytest -q` runs and reports 0 passed (no tests yet).

### M2: Auth and organizations

**Deliverable**: Users can register, log in, receive a JWT, create an organization, and become its `owner`.

**Done when**:
- `POST /auth/register` creates a user (with hashed password).
- `POST /auth/login` returns an access token + a refresh token.
- `POST /organizations` creates an org and a membership (`owner`) for the creator.
- `GET /organizations` returns only the orgs the current user is a member of.
- Test `test_auth.py::test_register_login_create_org` passes.

### M3: Plants, machines, RBAC

**Deliverable**: Owners and managers can define plants and machines. Operators can list them.

**Done when**:
- `POST /organizations/{org}/plants` works for `owner` and `manager`, returns 403 for `operator`.
- `POST /organizations/{org}/machines` works for `owner` and `manager`.
- A user from org A cannot see plants in org B (returns 404).
- Tests `test_orgs.py::test_cross_org_isolation` passes.

### M4: Jobs and work orders, state machine

**Deliverable**: Jobs and work orders can be created and transitioned through their state machines. Invalid transitions return 409.

**Done when**:
- `POST /organizations/{org}/jobs` creates a job in `draft`.
- `POST /organizations/{org}/jobs/{id}/transitions` with `{"to":"planned"}` transitions to `planned`.
- A transition from `completed` to `in_progress` returns 409 with `{"code":"invalid_transition"}`.
- Test `test_jobs.py::test_invalid_transition_returns_409` passes.

### M5: Inventory, concurrency-safe movements, audit

**Deliverable**: Bins and movements exist. `POST /inventory/movements` is concurrency-safe and audited.

**Done when**:
- Two parallel `out` movements of 4 from a bin with 14 do not result in a bin of -4 (the second one queues on `FOR UPDATE` and reads the post-first-movement value).
- Each movement writes an `audit_log` row in the same transaction.
- Test `test_inventory_concurrency.py::test_two_concurrent_issues_do_not_overcommit` passes (this is the project's marquee test).
- Test `test_audit.py::test_movement_writes_audit_row_in_same_txn` passes.

### M6: Reports, filtering, keyset pagination

**Deliverable**: Reporting endpoints with caching, list endpoints with filtering/sorting, audit log with keyset pagination.

**Done when**:
- `GET /reports/daily-output` returns per-day per-machine counts; the second call within 5 min hits the Redis cache (verified by `X-Cache: HIT` header).
- `GET /audit?cursor=...&limit=50` returns 50 rows and a `next_cursor`.
- Walking the cursor to the end returns the full audit log.
- Test `test_reports.py::test_daily_output_caches` passes.
- Test `test_audit.py::test_keyset_pagination_walks_full_log` passes.

### M7: Docker polish, README, resume bullets

**Deliverable**: A clone-and-run repo.

**Done when**:
- A new developer running `cp .env.example .env && docker compose up --build` sees the app on `localhost:8000/docs` with migrations applied and all tests passing in the container.
- The `README.md` explains what ForgeTrack is, how to run it, and how to run the tests.
- The resume bullets are written and quantified.

---

## Implementation Chapters

These wikilinks are the canonical lessons that *implement* each milestone. Open them as references, not as the curriculum. You have already read them; now you are using them.

- **M1 — Scaffold and config**: [[03-FastAPI-Core/Application-and-Lifespan]], [[04-Pydantic/Pydantic-Settings]], [[07-SQLAlchemy/02-Engines-Connections-Pools]], [[16-Deployment-and-DevOps/Docker-Compose-Local-Dev]].
- **M2 — Auth and organizations**: [[11-Authentication-and-Security/Password-Hashing]], [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]], [[07-SQLAlchemy/03-Declarative-Base-and-Mapped]].
- **M3 — Plants, machines, RBAC**: [[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]], [[03-FastAPI-Core/Dependency-Injection]], [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]].
- **M4 — Jobs and work orders**: [[05-Project-Architecture/Layered-FastAPI-Apps]], [[05-Project-Architecture/Service-and-Repository-Patterns]], [[03-FastAPI-Core/Exception-Handlers]].
- **M5 — Inventory and audit**: [[06-SQL-Fundamentals/Transactions-Isolation-Locks]], [[07-SQLAlchemy/05-Session-and-Transaction-Management]], [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]].
- **M6 — Reports and pagination**: [[08-PostgreSQL/Indexes-Composite-and-Specialized]], [[02-Web-and-HTTP/Idempotency-Safe-Retries-Pagination]], [[14-Caching-and-Background-Processing/Redis-Cache-Aside]], [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]].
- **M7 — Docker polish**: [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]], [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]], [[12-Testing-and-Quality/CI-Pipelines]].

**Tip — Do not re-read these lessons cover to cover**

You read them once. Now use them as references. When you are stuck on a `FOR UPDATE` deadlock, open [[06-SQL-Fundamentals/Transactions-Isolation-Locks]] and search the page. When you cannot remember whether `selectinload` or `joinedload` is right for a relationship, open [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]]. The lessons are the manual now; the project is the work.


---

## Complete Source Code

This is the full starter for ForgeTrack. Type it in. The order matters: `config.py` → `db.py` → `models/` → `schemas/` → `security.py` → `audit.py` → `services/` → `routers/` → `main.py`. The migrations and tests come after.

### `app/config.py`

```python
# app/config.py
"""Application configuration — all values come from the environment."""
from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
 model_config = SettingsConfigDict(env_file=".env", env_prefix="FORGETRACK_")

 # --- Core ---
 environment: str = Field(default="dev", description="dev | test | prod")
 log_level: str = "INFO"

 # --- Database ---
 database_url: str = Field(
 default="postgresql+asyncpg://forgetrack:forgetrack@db:5432/forgetrack",
 description="Async SQLAlchemy URL.",
 )
 db_pool_size: int = 10
 db_max_overflow: int = 5
 db_pool_pre_ping: bool = True

 # --- Redis ---
 redis_url: str = "redis://redis:6379/0"

 # --- Auth ---
 secret_key: str = Field(default="dev-only-change-me")
 access_token_ttl_minutes: int = 15
 refresh_token_ttl_days: int = 30
 jwt_algorithm: str = "HS256"

 # --- Reports cache ---
 daily_output_cache_ttl_seconds: int = 300

 def assert_production_safe(self) -> None:
 """Refuse to boot in production with a development secret."""
 if self.environment == "prod" and self.secret_key == "dev-only-change-me":
 raise RuntimeError(
 "FORGETRACK_SECRET_KEY must be set to a real value in production."
 )


@lru_cache
def get_settings() -> Settings:
 """Return a cached Settings instance. Tests can call get_settings.cache_clear()."""
 s = Settings()
 s.assert_production_safe()
 return s
```

A few decisions to note:

- `SettingsConfigDict(env_prefix="FORGETRACK_")` — every variable is prefixed, so the same `.env` file can hold ForgeTrack's settings and a Redis container's settings without collision.
- `assert_production_safe()` — the kind of check that prevents a 3 a.m. production deploy from running with the dev secret because someone forgot to set the env var.
- `@lru_cache` — `Settings()` reads the environment; doing that on every request would be silly. The cache returns the same instance. Tests call `get_settings.cache_clear()` between fixtures.

### `app/db.py`

```python
# app/db.py
"""Engine, sessionmaker, Base."""
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
 AsyncEngine,
 AsyncSession,
 async_sessionmaker,
 create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings


class Base(DeclarativeBase):
 """All models inherit from this. Alembic's target_metadata is Base.metadata."""


def _build_engine() -> AsyncEngine:
 s = get_settings()
 return create_async_engine(
 s.database_url,
 pool_size=s.db_pool_size,
 max_overflow=s.db_max_overflow,
 pool_pre_ping=s.db_pool_pre_ping,
 echo=False,
 )


engine: AsyncEngine = _build_engine()
SessionLocal = async_sessionmaker(
 bind=engine, class_=AsyncSession, expire_on_commit=False, autoflush=False
)


async def get_session() -> AsyncIterator[AsyncSession]:
 """FastAPI dependency. Yields a session and rolls back on exception."""
 async with SessionLocal() as session:
 try:
 yield session
 except Exception:
 await session.rollback()
 raise
```

`expire_on_commit=False` is a frequent point of confusion. The default in SQLAlchemy 2.x is `True`, which means after `await session.commit()`, every attribute access on a previously-loaded ORM object re-fetches it from the DB. In an async context, that re-fetch happens lazily and crashes with `MissingGreenlet` if you access an attribute after the session context exits. Setting `expire_on_commit=False` makes objects keep their post-commit values in memory; we pay the cost of a slightly stale object (rarely a problem; we usually return `model_dump()` immediately) and gain a clean async story. This is the lesson from [[07-SQLAlchemy/05-Session-and-Transaction-Management]].

### `app/models/base.py`

```python
# app/models/base.py
"""Shared mixins."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, func
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.dialects.postgresql import UUID

from app.db import Base


def _utc_now() -> datetime:
 return datetime.now(timezone.utc)


class UUIDPrimaryKey:
 id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True),
 primary_key=True,
 default=uuid.uuid4,
 server_default=func.gen_random_uuid(),
 )


class TimestampMixin:
 created_at: Mapped[datetime] = mapped_column(
 DateTime(timezone=True), nullable=False, default=_utc_now, server_default=func.now()
 )
 updated_at: Mapped[datetime] = mapped_column(
 DateTime(timezone=True),
 nullable=False,
 default=_utc_now,
 onupdate=_utc_now,
 server_default=func.now(),
 )
```

Two details worth noticing:

- `server_default=func.gen_random_uuid()` — the database generates the UUID if the ORM does not provide one. This matters for raw `INSERT` statements (Alembic data migrations, etc.) and as defense in depth.
- `_utc_now()` is a function, not `datetime.utcnow()` — `datetime.utcnow()` is deprecated in Python 3.12+ (it returns a naive `datetime`); `datetime.now(timezone.utc)` returns an aware one. Always aware.

### `app/models/org.py`

```python
# app/models/org.py
"""Organization and Membership."""
import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import TimestampMixin, UUIDPrimaryKey


class Role(str, enum.Enum):
 owner = "owner"
 manager = "manager"
 operator = "operator"
 auditor = "auditor"


class Organization(UUIDPrimaryKey, TimestampMixin, Base):
 __tablename__ = "organizations"
 __table_args__ = (UniqueConstraint("slug", name="uq_organizations_slug"),)

 name: Mapped[str] = mapped_column(String(200), nullable=False)
 slug: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
 default_currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD")


class Membership(UUIDPrimaryKey, Base):
 __tablename__ = "memberships"
 __table_args__ = (
 UniqueConstraint("user_id", "organization_id", name="uq_memberships_user_org"),
 )

 user_id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
 )
 organization_id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True),
 ForeignKey("organizations.id", ondelete="CASCADE"),
 nullable=False,
 )
 role: Mapped[Role] = mapped_column(Enum(Role, name="role"), nullable=False)
 created_at: Mapped[datetime] = mapped_column(
 DateTime(timezone=True), nullable=False, server_default=func.now()
 )
```

`Role(str, enum.Enum)` — the `str` mixin makes `Role.owner == "owner"` true and JSON serialization print `"owner"` instead of `"Role.owner"`. This is a Pydantic-friendly form: when a schema declares `role: Role`, FastAPI's `JsonResponse` will serialize it correctly without a custom encoder.

### `app/models/user.py`

```python
# app/models/user.py
"""User."""
import uuid
from datetime import datetime

from sqlalchemy import DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import UUIDPrimaryKey


class User(UUIDPrimaryKey, Base):
 __tablename__ = "users"

 email: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
 # Note: in real deployments, install the `citext` extension and use CITEXT,
 # to get case-insensitive uniqueness at the DB layer. We use String here
 # to keep migrations portable for the starter.
 password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
 created_at: Mapped[datetime] = mapped_column(
 DateTime(timezone=True), nullable=False, server_default=func.now()
 )
```

### `app/models/plant.py`

```python
# app/models/plant.py
"""Plant and Machine."""
import enum
import uuid

from sqlalchemy import Enum, ForeignKey, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.base import TimestampMixin, UUIDPrimaryKey


class MachineStatus(str, enum.Enum):
 available = "available"
 busy = "busy"
 maintenance = "maintenance"
 retired = "retired"


class Plant(UUIDPrimaryKey, TimestampMixin, Base):
 __tablename__ = "plants"
 __table_args__ = (
 UniqueConstraint("organization_id", "name", name="uq_plants_org_name"),
 )

 organization_id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
 )
 name: Mapped[str] = mapped_column(String(200), nullable=False)
 timezone: Mapped[str] = mapped_column(String(60), nullable=False, default="UTC")


class Machine(UUIDPrimaryKey, TimestampMixin, Base):
 __tablename__ = "machines"
 __table_args__ = (
 UniqueConstraint("organization_id", "code", name="uq_machines_org_code"),
 )

 organization_id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
 )
 plant_id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True), ForeignKey("plants.id", ondelete="RESTRICT"), nullable=False
 )
 code: Mapped[str] = mapped_column(String(40), nullable=False)
 name: Mapped[str] = mapped_column(String(200), nullable=False)
 status: Mapped[MachineStatus] = mapped_column(
 Enum(MachineStatus, name="machine_status"),
 nullable=False,
 default=MachineStatus.available,
 )
```

`organization_id` is stored on `machines` *redundantly* with `plant_id` — `plant.organization_id` already gives us the org. We duplicate it so the unique constraint `(organization_id, code)` can be enforced without a join, and so `SELECT ... FROM machines WHERE organization_id = :org` is an index-only scan, not a join to `plants`. This is a deliberate denormalization; the trade-off is two writes when a plant changes organization (which never happens in practice).

### `app/models/job.py`

```python
# app/models/job.py
"""Job and WorkOrder."""
import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.base import TimestampMixin, UUIDPrimaryKey

if TYPE_CHECKING:
 from app.models.inventory import Movement


class JobStatus(str, enum.Enum):
 draft = "draft"
 planned = "planned"
 in_progress = "in_progress"
 completed = "completed"
 cancelled = "cancelled"


class WorkOrderStatus(str, enum.Enum):
 pending = "pending"
 in_progress = "in_progress"
 completed = "completed"
 blocked = "blocked"
 cancelled = "cancelled"


# The legal transitions. Keys are "from"; values are the set of allowed "to" states.
JOB_TRANSITIONS: dict[JobStatus, set[JobStatus]] = {
 JobStatus.draft: {JobStatus.planned, JobStatus.cancelled},
 JobStatus.planned: {JobStatus.in_progress, JobStatus.cancelled},
 JobStatus.in_progress: {JobStatus.completed, JobStatus.cancelled},
 JobStatus.completed: set(),
 JobStatus.cancelled: set(),
}

WORK_ORDER_TRANSITIONS: dict[WorkOrderStatus, set[WorkOrderStatus]] = {
 WorkOrderStatus.pending: {WorkOrderStatus.in_progress, WorkOrderStatus.blocked, WorkOrderStatus.cancelled},
 WorkOrderStatus.in_progress: {WorkOrderStatus.completed, WorkOrderStatus.blocked, WorkOrderStatus.cancelled},
 WorkOrderStatus.blocked: {WorkOrderStatus.in_progress, WorkOrderStatus.cancelled},
 WorkOrderStatus.completed: set(),
 WorkOrderStatus.cancelled: set(),
}


class Job(UUIDPrimaryKey, TimestampMixin, Base):
 __tablename__ = "jobs"

 organization_id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
 )
 external_ref: Mapped[str | None] = mapped_column(String(100))
 customer: Mapped[str] = mapped_column(String(200), nullable=False)
 part_number: Mapped[str] = mapped_column(String(80), nullable=False)
 quantity_ordered: Mapped[int] = mapped_column(Integer, nullable=False)
 status: Mapped[JobStatus] = mapped_column(
 Enum(JobStatus, name="job_status"), nullable=False, default=JobStatus.draft
 )

 work_orders: Mapped[list["WorkOrder"]] = relationship(
 back_populates="job", cascade="all, delete-orphan", lazy="selectin"
 )
 movements: Mapped[list["Movement"]] = relationship(back_populates="job", lazy="noload")


class WorkOrder(UUIDPrimaryKey, TimestampMixin, Base):
 __tablename__ = "work_orders"
 __table_args__ = (
 UniqueConstraint("job_id", "sequence", name="uq_work_orders_job_sequence"),
 )

 job_id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False
 )
 sequence: Mapped[int] = mapped_column(Integer, nullable=False)
 operation: Mapped[str] = mapped_column(String(200), nullable=False)
 machine_id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True), ForeignKey("machines.id", ondelete="RESTRICT"), nullable=False
 )
 quantity_planned: Mapped[int] = mapped_column(Integer, nullable=False)
 quantity_completed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
 status: Mapped[WorkOrderStatus] = mapped_column(
 Enum(WorkOrderStatus, name="work_order_status"),
 nullable=False,
 default=WorkOrderStatus.pending,
 )
 started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
 completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

 job: Mapped[Job] = relationship(back_populates="work_orders")
```

`JOB_TRANSITIONS` is the state machine, expressed as a `dict` literal. There is no `if status == "draft" and new == "planned"` ladder; the set lookup is the validation. This is the most maintainable way to encode a state machine in Python: add a new transition by adding a value to a set; remove one by deleting it. Tests can iterate the dict to check every legal and illegal transition.

### `app/models/inventory.py`

```python
# app/models/inventory.py
"""Bin and Movement."""
import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.base import UUIDPrimaryKey

if TYPE_CHECKING:
 from app.models.job import Job, WorkOrder


class MovementKind(str, enum.Enum):
 in_ = "in" # avoid shadowing the `in` keyword
 out = "out"
 adjust = "adjust"


class Bin(UUIDPrimaryKey, Base):
 __tablename__ = "bins"

 organization_id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
 )
 code: Mapped[str] = mapped_column(String(40), nullable=False)
 description: Mapped[str | None] = mapped_column(Text)

 movements: Mapped[list["Movement"]] = relationship(back_populates="bin", lazy="noload")


class Movement(UUIDPrimaryKey, Base):
 __tablename__ = "movements"

 bin_id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True), ForeignKey("bins.id", ondelete="RESTRICT"), nullable=False
 )
 job_id: Mapped[uuid.UUID | None] = mapped_column(
 UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="SET NULL")
 )
 work_order_id: Mapped[uuid.UUID | None] = mapped_column(
 UUID(as_uuid=True), ForeignKey("work_orders.id", ondelete="SET NULL")
 )
 kind: Mapped[MovementKind] = mapped_column(
 Enum(MovementKind, name="movement_kind"), nullable=False
 )
 quantity: Mapped[int] = mapped_column(Integer, nullable=False)
 note: Mapped[str | None] = mapped_column(Text)
 actor_id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=False
 )
 at: Mapped[datetime] = mapped_column(
 DateTime(timezone=True), nullable=False, server_default=func.now()
 )

 bin: Mapped["Bin"] = relationship(back_populates="movements")
 job: Mapped["Job"] = relationship(back_populates="movements")
```

`MovementKind.in_` — Python's `in` is a keyword, so we name the enum member `in_` but serialize it as `"in"` via `str` mixin. The DB column stores `"in"`, not `"in_"`.

### `app/models/audit.py`

```python
# app/models/audit.py
"""AuditLog — bigint PK, jsonb before/after."""
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, DateTime, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class AuditLog(Base):
 __tablename__ = "audit_log"

 id: Mapped[int] = mapped_column(
 BigInteger, primary_key=True, autoincrement=True
 )
 organization_id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True), ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False
 )
 actor_id: Mapped[uuid.UUID] = mapped_column(
 UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=False
 )
 action: Mapped[str] = mapped_column(String(80), nullable=False)
 entity_type: Mapped[str] = mapped_column(String(40), nullable=False)
 entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
 before: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
 after: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
 at: Mapped[datetime] = mapped_column(
 DateTime(timezone=True), nullable=False, server_default=func.now()
 )
```

`autoincrement=True` on a `BigInteger` PK makes Postgres use a `GENERATED ALWAYS AS IDENTITY` column, which gives us monotonic ordering for free. The cost is that the audit log is the only table whose PK leaks a count — which is fine, the auditor is internal.

### `app/schemas/common.py`

```python
# app/schemas/common.py
"""Shared schema types: Page, ErrorResponse, etc."""
from typing import Generic, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
 items: list[T]
 next_cursor: str | None = None
 has_more: bool = False


class ErrorResponse(BaseModel):
 code: str
 message: str
 details: dict | None = None
```

### `app/schemas/auth.py`

```python
# app/schemas/auth.py
from pydantic import BaseModel, EmailStr, Field


class RegisterIn(BaseModel):
 email: EmailStr
 password: str = Field(min_length=10, max_length=128)
 display_name: str | None = Field(default=None, max_length=80)


class LoginIn(BaseModel):
 email: EmailStr
 password: str


class TokenOut(BaseModel):
 access_token: str
 refresh_token: str
 token_type: str = "bearer"
 expires_in: int # seconds


class RefreshIn(BaseModel):
 refresh_token: str
```

### `app/schemas/job.py`

```python
# app/schemas/job.py
import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.models.job import JobStatus, WorkOrderStatus


class JobCreateIn(BaseModel):
 external_ref: str | None = Field(default=None, max_length=100)
 customer: str = Field(min_length=1, max_length=200)
 part_number: str = Field(min_length=1, max_length=80)
 quantity_ordered: int = Field(gt=0)


class JobOut(BaseModel):
 id: uuid.UUID
 external_ref: str | None
 customer: str
 part_number: str
 quantity_ordered: int
 status: JobStatus
 created_at: datetime
 updated_at: datetime

 class Config:
 from_attributes = True


class TransitionIn(BaseModel):
 to: JobStatus | WorkOrderStatus
 note: str | None = None
```

### `app/schemas/inventory.py`

```python
# app/schemas/inventory.py
import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.models.inventory import MovementKind


class MovementCreateIn(BaseModel):
 bin_id: uuid.UUID
 kind: MovementKind
 quantity: int = Field(gt=0, description="Always positive; sign is implied by kind.")
 job_id: uuid.UUID | None = None
 work_order_id: uuid.UUID | None = None
 note: str | None = Field(default=None, max_length=500)


class MovementOut(BaseModel):
 id: uuid.UUID
 bin_id: uuid.UUID
 kind: MovementKind
 quantity: int
 note: str | None
 actor_id: uuid.UUID
 at: datetime
 bin_quantity_after: int # computed

 class Config:
 from_attributes = True


class BinOut(BaseModel):
 id: uuid.UUID
 code: str
 description: str | None
 current_quantity: int # computed

 class Config:
 from_attributes = True
```

`quantity` is always positive in the API; the sign is implied by `kind`. The service layer flips the sign for `out` movements when writing to the DB. This keeps the API honest (a negative `quantity` with `kind="in"` would be incoherent) and the storage honest (a `SUM` over `movements.quantity` is correct).

### `app/security.py`

```python
# app/security.py
"""Password hashing, JWT issue/verify, RBAC dependency."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Annotated, Literal

import argon2
import jwt
from fastapi import Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import get_session
from app.models.org import Membership, Organization, Role
from app.models.user import User

ph = argon2.PasswordHasher()


def hash_password(plain: str) -> str:
 return ph.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
 try:
 ph.verify(hashed, plain)
 return True
 except argon2.exceptions.VerifyMismatchError:
 return False
 except argon2.exceptions.InvalidHashError:
 return False


def _encode_access_token(user_id: uuid.UUID, settings: Settings) -> str:
 now = datetime.now(timezone.utc)
 payload = {
 "sub": str(user_id),
 "iat": int(now.timestamp()),
 "exp": int((now + timedelta(minutes=settings.access_token_ttl_minutes)).timestamp()),
 "typ": "access",
 }
 return jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


def _encode_refresh_token(user_id: uuid.UUID, settings: Settings) -> str:
 now = datetime.now(timezone.utc)
 payload = {
 "sub": str(user_id),
 "iat": int(now.timestamp()),
 "exp": int((now + timedelta(days=settings.refresh_token_ttl_days)).timestamp()),
 "typ": "refresh",
 "jti": uuid.uuid4().hex,
 }
 return jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


def decode_token(token: str, settings: Settings) -> dict:
 try:
 return jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])
 except jwt.ExpiredSignatureError:
 raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"code": "token_expired"})
 except jwt.InvalidTokenError:
 raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"code": "token_invalid"})


async def current_user(
 token: Annotated[str, Depends(_bearer_token)],
 session: Annotated[AsyncSession, Depends(get_session)],
 settings: Annotated[Settings, Depends(get_settings)],
) -> User:
 payload = decode_token(token, settings)
 if payload.get("typ") != "access":
 raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"code": "wrong_token_type"})
 user_id = uuid.UUID(payload["sub"])
 user = await session.get(User, user_id)
 if user is None:
 raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"code": "user_not_found"})
 return user


async def current_membership(
 org_id: uuid.UUID,
 user: Annotated[User, Depends(current_user)],
 session: Annotated[AsyncSession, Depends(get_session)],
) -> Membership:
 """Return the user's membership in this org, or 404 if they don't have one."""
 stmt = select(Membership).where(
 Membership.user_id == user.id,
 Membership.organization_id == org_id,
 )
 membership = (await session.execute(stmt)).scalar_one_or_none()
 if membership is None:
 # 404, not 403 — do not leak that the org exists.
 raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "org_not_found"})
 return membership


def require_roles(*roles: Role):
 """Dependency factory: require the membership's role to be in `roles`."""

 async def _checker(
 membership: Annotated[Membership, Depends(current_membership)],
 ) -> Membership:
 if membership.role not in roles:
 raise HTTPException(
 status.HTTP_403_FORBIDDEN,
 detail={
 "code": "forbidden_role",
 "required": [r.value for r in roles],
 "actual": membership.role.value,
 },
 )
 return membership

 return _checker


def _bearer_token(
 # FastAPI extracts the Authorization header; we strip the "Bearer " prefix.
 authorization: Annotated[str, "Authorization header is required"],
) -> str:
 if not authorization.startswith("Bearer "):
 raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"code": "bad_auth_header"})
 return authorization[len("Bearer "):]
```

A few notes:

- `argon2.PasswordHasher()` is the modern recommendation. `argon2-cffi` is a Python binding around the reference C implementation; it is what `passlib` recommends as of 2024+. We use the binding directly, not `passlib` — `passlib`'s maintenance has been uneven, and `argon2-cffi` is a thin enough layer that there is no benefit to the abstraction.
- `current_membership` returns 404, *not* 403, when the user has no membership in the org. This is the "no information leak" rule: a 403 would tell an attacker "this org exists, but you are not a member"; a 404 says "I do not know what you are talking about." The rule comes from [[11-Authentication-and-Security/Threat-Model-First]].

### `app/audit.py`

```python
# app/audit.py
"""AuditService — writes audit rows in the same transaction as the change."""
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditLog
from app.models.org import Membership


class AuditService:
 def __init__(self, session: AsyncSession, membership: Membership) -> None:
 self._session = session
 self._membership = membership

 async def write(
 self,
 *,
 action: str,
 entity_type: str,
 entity_id: Any, # uuid.UUID in practice
 before: dict[str, Any] | None = None,
 after: dict[str, Any] | None = None,
 ) -> AuditLog:
 """Write an audit row in the current transaction.

 The caller must hold any necessary locks before calling this.
 The row is committed when the caller's transaction commits.
 """
 row = AuditLog(
 organization_id=self._membership.organization_id,
 actor_id=self._membership.user_id,
 action=action,
 entity_type=entity_type,
 entity_id=entity_id,
 before=before,
 after=after,
 )
 self._session.add(row)
 await self._session.flush() # get the id without committing
 return row
```

`await self._session.flush()` is the key line: it writes the row to the DB (so we can get its `id` if we want) without committing. The commit happens in the caller's transaction. If the caller rolls back, the audit row rolls back too.

### `app/services/jobs.py`

```python
# app/services/jobs.py
"""JobService — owns the job and work-order state machines."""
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.audit import AuditService
from app.models.job import JOB_TRANSITIONS, Job, JobStatus
from app.models.org import Membership


class InvalidTransition(Exception):
 def __init__(self, current: JobStatus, target: JobStatus) -> None:
 super().__init__(f"Cannot transition from {current.value} to {target.value}")
 self.current = current
 self.target = target


class JobNotFound(Exception):
 pass


class JobService:
 def __init__(self, session: AsyncSession, membership: Membership) -> None:
 self._session = session
 self._membership = membership
 self._audit = AuditService(session, membership)

 async def create_job(self, **fields) -> Job:
 job = Job(organization_id=self._membership.organization_id, status=JobStatus.draft, **fields)
 self._session.add(job)
 await self._session.flush()
 await self._audit.write(
 action="job.create",
 entity_type="job",
 entity_id=job.id,
 before=None,
 after={"status": job.status.value, "customer": job.customer},
 )
 return job

 async def transition(self, job_id: uuid.UUID, target: JobStatus) -> Job:
 stmt = (
 select(Job)
 .where(Job.id == job_id, Job.organization_id == self._membership.organization_id)
 .with_for_update() # serialize concurrent transitions
 )
 job = (await self._session.execute(stmt)).scalar_one_or_none()
 if job is None:
 raise JobNotFound()

 if target not in JOB_TRANSITIONS.get(job.status, set()):
 raise InvalidTransition(job.status, target)

 before = {"status": job.status.value}
 job.status = target
 await self._session.flush()
 after = {"status": job.status.value}

 await self._audit.write(
 action="job.transition",
 entity_type="job",
 entity_id=job.id,
 before=before,
 after=after,
 )
 return job

 async def get(self, job_id: uuid.UUID) -> Job:
 stmt = (
 select(Job)
 .options(selectinload(Job.work_orders))
 .where(Job.id == job_id, Job.organization_id == self._membership.organization_id)
 )
 job = (await self._session.execute(stmt)).scalar_one_or_none()
 if job is None:
 raise JobNotFound()
 return job
```

`.with_for_update()` on the `SELECT` is the lock that serializes concurrent transitions. Two managers clicking "Start job 417" at the same instant are serialized; the second one's `SELECT` waits until the first one's transaction commits, then reads `in_progress` and rejects the redundant transition with `InvalidTransition` (which the router maps to 409).

### `app/services/inventory.py`

```python
# app/services/inventory.py
"""InventoryService — concurrency-safe stock movements."""
import uuid
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import AuditService
from app.models.inventory import Bin, Movement, MovementKind
from app.models.org import Membership


class InsufficientStock(Exception):
 def __init__(self, bin_id: uuid.UUID, requested: int, available: int) -> None:
 super().__init__(
 f"Bin {bin_id} has {available} units; cannot issue {requested}."
 )
 self.bin_id = bin_id
 self.requested = requested
 self.available = available


class BinNotFound(Exception):
 pass


class InventoryService:
 def __init__(self, session: AsyncSession, membership: Membership) -> None:
 self._session = session
 self._membership = membership
 self._audit = AuditService(session, membership)

 async def _bin_quantity(self, bin_id: uuid.UUID) -> int:
 """Current quantity = SUM(quantity) for this bin."""
 stmt = select(func.coalesce(func.sum(Movement.quantity), 0)).where(Movement.bin_id == bin_id)
 result = (await self._session.execute(stmt)).scalar_one()
 return int(result)

 async def record_movement(
 self,
 *,
 bin_id: uuid.UUID,
 kind: MovementKind,
 quantity: int,
 job_id: uuid.UUID | None = None,
 work_order_id: uuid.UUID | None = None,
 note: str | None = None,
 ) -> tuple[Movement, int]:
 """Record a movement and return (movement, bin_quantity_after).

 For `out` movements, takes a row lock on the bin and checks the bin
 has enough before writing. The lock is held until commit.
 """
 # Lock the bin row. This is the critical concurrency-control line.
 bin_stmt = (
 select(Bin)
 .where(Bin.id == bin_id, Bin.organization_id == self._membership.organization_id)
 .with_for_update()
 )
 bin_row = (await self._session.execute(bin_stmt)).scalar_one_or_none()
 if bin_row is None:
 raise BinNotFound()

 current = await self._bin_quantity(bin_id)

 if kind == MovementKind.out:
 signed = -quantity
 if current + signed < 0:
 raise InsufficientStock(bin_id, quantity, current)
 elif kind == MovementKind.in_:
 signed = quantity
 else: # adjust
 signed = quantity if current + quantity >= 0 else -(current) # floor at 0
 # Note: an `adjust` to a negative value clamps to 0; alternative is to raise.

 movement = Movement(
 bin_id=bin_id,
 kind=kind,
 quantity=signed,
 job_id=job_id,
 work_order_id=work_order_id,
 note=note,
 actor_id=self._membership.user_id,
 )
 self._session.add(movement)
 await self._session.flush()

 new_quantity = current + signed
 await self._audit.write(
 action="inventory.movement",
 entity_type="bin",
 entity_id=bin_id,
 before={"quantity": current},
 after={"quantity": new_quantity, "movement_id": str(movement.id)},
 )
 return movement, new_quantity
```

The lock is on `Bin`, not on `Movement`. Why? Because the bin's quantity is `SUM(movements.quantity)`, and `SELECT FOR UPDATE` on an aggregate is not possible — there is no row to lock. The trick is to lock the *bin row* (which exists, even though its quantity is derived) to serialize concurrent `out` movements. Two `out` transactions both `SELECT FOR UPDATE` the same `Bin` row; the second waits for the first to commit; when it acquires the lock, the `SUM` reflects the first movement. This is the canonical pattern for "lock a sentinel row to serialize an aggregate" (see [[06-SQL-Fundamentals/Transactions-Isolation-Locks]] for the general principle).

**Why we do not use `SERIALIZABLE` isolation**

Postgres's `SERIALIZABLE` isolation level would catch the over-commit at the commit time (one of the two transactions would abort with a serialization failure). But it requires retry-on-conflict, and it adds overhead. `FOR UPDATE` is simpler, faster, and sufficient for our access pattern: all `out` movements on a bin go through the same row lock. `SERIALIZABLE` is the right answer when you cannot identify a single row to lock; here we can.


### `app/services/reports.py`

```python
# app/services/reports.py
"""ReportsService — cached aggregations."""
import json
from datetime import date, timedelta

import redis.asyncio as redis
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.models.inventory import Bin, Movement
from app.models.job import WorkOrder, WorkOrderStatus
from app.models.org import Membership


class ReportsService:
 def __init__(
 self,
 session: AsyncSession,
 membership: Membership,
 settings: Settings,
 redis_client: redis.Redis,
 ) -> None:
 self._session = session
 self._membership = membership
 self._settings = settings
 self._redis = redis_client

 async def daily_output(
 self, start: date, end: date
 ) -> list[dict[str, object]]:
 """Per-day, per-machine completed work-order counts.

 Cached in Redis for `daily_output_cache_ttl_seconds`.
 """
 cache_key = (
 f"forgetrack:reports:daily-output:"
 f"{self._membership.organization_id}:{start.isoformat()}:{end.isoformat()}"
 )
 cached = await self._redis.get(cache_key)
 if cached:
 return json.loads(cached)

 stmt = (
 select(
 func.date_trunc("day", WorkOrder.completed_at).label("day"),
 WorkOrder.machine_id,
 func.count(WorkOrder.id).label("completed"),
 )
 .join(WorkOrder.job) # scope by org via job.organization_id
 .where(
 WorkOrder.status == WorkOrderStatus.completed,
 WorkOrder.completed_at >= start,
 WorkOrder.completed_at < end + timedelta(days=1),
 )
 .group_by("day", WorkOrder.machine_id)
 .order_by("day", WorkOrder.machine_id)
 )
 rows = (await self._session.execute(stmt)).all()
 result = [
 {"day": r.day.date().isoformat(), "machine_id": str(r.machine_id), "completed": r.completed}
 for r in rows
 ]
 await self._redis.set(
 cache_key, json.dumps(result), ex=self._settings.daily_output_cache_ttl_seconds
 )
 return result

 async def inventory_snapshot(self) -> list[dict[str, object]]:
 """All bins with their current quantities (computed)."""
 stmt = (
 select(
 Bin.id,
 Bin.code,
 Bin.description,
 func.coalesce(func.sum(Movement.quantity), 0).label("quantity"),
 )
 .where(Bin.organization_id == self._membership.organization_id)
 .outerjoin(Movement, Movement.bin_id == Bin.id)
 .group_by(Bin.id)
 .order_by(Bin.code)
 )
 rows = (await self._session.execute(stmt)).all()
 return [
 {"id": str(r.id), "code": r.code, "description": r.description, "quantity": int(r.quantity)}
 for r in rows
 ]
```

`func.date_trunc("day", WorkOrder.completed_at)` truncates the timestamp to the start of its day — the Postgres function `date_trunc`. This is the canonical "per-day bucket" in SQL; we covered it in [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]] and [[06-SQL-Fundamentals/Joins-Aggregations-CTEs]].

### `app/routers/auth.py`

```python
# app/routers/auth.py
"""Auth router — register, login, refresh."""
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import get_session
from app.models.org import Membership, Organization, Role
from app.models.user import User
from app.schemas.auth import LoginIn, RefreshIn, RegisterIn, TokenOut
from app.security import (
 decode_token,
 hash_password,
 _encode_access_token,
 _encode_refresh_token,
 verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=TokenOut, status_code=201)
async def register(
 body: RegisterIn,
 session: Annotated[AsyncSession, Depends(get_session)],
 settings: Annotated[Settings, Depends(get_settings)],
) -> TokenOut:
 existing = (
 await session.execute(select(User).where(User.email == body.email.lower()))
 ).scalar_one_or_none()
 if existing is not None:
 raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "email_taken"})

 user = User(email=body.email.lower(), password_hash=hash_password(body.password))
 session.add(user)
 await session.flush()

 # New users start with no organization. They create one in a second call.
 return TokenOut(
 access_token=_encode_access_token(user.id, settings),
 refresh_token=_encode_refresh_token(user.id, settings),
 token_type="bearer",
 expires_in=settings.access_token_ttl_minutes * 60,
 )


@router.post("/login", response_model=TokenOut)
async def login(
 body: LoginIn,
 session: Annotated[AsyncSession, Depends(get_session)],
 settings: Annotated[Settings, Depends(get_settings)],
) -> TokenOut:
 user = (
 await session.execute(select(User).where(User.email == body.email.lower()))
 ).scalar_one_or_none()
 if user is None or not verify_password(body.password, user.password_hash):
 raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"code": "bad_credentials"})
 return TokenOut(
 access_token=_encode_access_token(user.id, settings),
 refresh_token=_encode_refresh_token(user.id, settings),
 token_type="bearer",
 expires_in=settings.access_token_ttl_minutes * 60,
 )


@router.post("/refresh", response_model=TokenOut)
async def refresh(
 body: RefreshIn,
 settings: Annotated[Settings, Depends(get_settings)],
) -> TokenOut:
 payload = decode_token(body.refresh_token, settings)
 if payload.get("typ") != "refresh":
 raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail={"code": "wrong_token_type"})
 user_id = uuid4() # complete this: parse from payload["sub"]
 return TokenOut(
 access_token=_encode_access_token(user_id, settings),
 refresh_token=_encode_refresh_token(user_id, settings),
 token_type="bearer",
 expires_in=settings.access_token_ttl_minutes * 60,
 )
```

**Warning — The `/refresh` endpoint above is intentionally a stub.**

A production `/refresh` endpoint stores refresh-token JTI hashes in a `refresh_tokens` table, marks them used, detects reuse (a stolen refresh token being used twice is a strong signal of compromise), and rotates the entire family. Implementing that is left as a `# complete this:` — it is the most security-sensitive endpoint in any auth system and deserves its own lesson. The stub returns a valid token so the rest of the app is testable.


### `app/routers/orgs.py`

```python
# app/routers/orgs.py
"""Organizations router."""
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models.org import Membership, Organization, Role
from app.models.user import User
from app.security import current_user

router = APIRouter(prefix="/organizations", tags=["organizations"])


@router.get("")
async def list_orgs_for_user(
 user: Annotated[User, Depends(current_user)],
 session: Annotated[AsyncSession, Depends(get_session)],
) -> list[dict]:
 stmt = (
 select(Organization, Membership.role)
 .join(Membership, Membership.organization_id == Organization.id)
 .where(Membership.user_id == user.id)
 )
 rows = (await session.execute(stmt)).all()
 return [
 {"id": str(org.id), "name": org.name, "slug": org.slug, "role": role.value}
 for org, role in rows
 ]


@router.post("", status_code=201)
async def create_org(
 payload: dict,
 user: Annotated[User, Depends(current_user)],
 session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
 # complete this: validate payload with a Pydantic schema (slug, name, default_currency)
 org = Organization(name=payload["name"], slug=payload["slug"])
 session.add(org)
 await session.flush()
 membership = Membership(
 user_id=user.id, organization_id=org.id, role=Role.owner
 )
 session.add(membership)
 await session.commit()
 return {"id": str(org.id), "name": org.name, "slug": org.slug}
```

### `app/routers/jobs.py`

```python
# app/routers/jobs.py
"""Jobs router — create, list, transition."""
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models.job import Job, JobStatus
from app.models.org import Membership, Role
from app.schemas.common import Page
from app.schemas.job import JobCreateIn, JobOut, TransitionIn
from app.security import current_membership, current_user, require_roles
from app.services.jobs import InvalidTransition, JobNotFound, JobService

router = APIRouter(prefix="/organizations/{org_id}/jobs", tags=["jobs"])


@router.get("", response_model=Page[JobOut])
async def list_jobs(
 org_id: uuid.UUID,
 membership: Annotated[Membership, Depends(current_membership)],
 session: Annotated[AsyncSession, Depends(get_session)],
 status_filter: list[JobStatus] | None = Query(default=None, alias="status"),
 customer: str | None = None,
 limit: int = Query(default=50, le=200),
 cursor: str | None = None, # complete this: parse and apply
) -> Page[JobOut]:
 stmt = select(Job).where(Job.organization_id == org_id)
 if status_filter:
 stmt = stmt.where(Job.status.in_(status_filter))
 if customer:
 stmt = stmt.where(Job.customer.ilike(f"%{customer}%"))
 stmt = stmt.order_by(Job.created_at.desc()).limit(limit)
 jobs = (await session.execute(stmt)).scalars().all()
 return Page(items=[JobOut.model_validate(j) for j in jobs], has_more=False)


@router.post("", response_model=JobOut, status_code=201,
 dependencies=[Depends(require_roles(Role.owner, Role.manager))])
async def create_job(
 org_id: uuid.UUID,
 body: JobCreateIn,
 membership: Annotated[Membership, Depends(current_membership)],
 session: Annotated[AsyncSession, Depends(get_session)],
) -> JobOut:
 svc = JobService(session, membership)
 job = await svc.create_job(
 external_ref=body.external_ref,
 customer=body.customer,
 part_number=body.part_number,
 quantity_ordered=body.quantity_ordered,
 )
 await session.commit()
 return JobOut.model_validate(job)


@router.post("/{job_id}/transitions",
 dependencies=[Depends(require_roles(Role.owner, Role.manager))])
async def transition_job(
 org_id: uuid.UUID,
 job_id: uuid.UUID,
 body: TransitionIn,
 membership: Annotated[Membership, Depends(current_membership)],
 session: Annotated[AsyncSession, Depends(get_session)],
) -> dict:
 svc = JobService(session, membership)
 try:
 # complete this: dispatch by enum type (Job vs WorkOrder)
 job = await svc.transition(job_id, JobStatus(body.to))
 except InvalidTransition as e:
 raise HTTPException(
 status.HTTP_409_CONFLICT,
 detail={
 "code": "invalid_transition",
 "from": e.current.value,
 "to": e.target.value,
 },
 )
 except JobNotFound:
 raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "job_not_found"})
 await session.commit()
 return {"id": str(job.id), "status": job.status.value}
```

### `app/routers/inventory.py`

```python
# app/routers/inventory.py
"""Inventory router — movements and bin state."""
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models.inventory import Bin, Movement, MovementKind
from app.models.org import Membership, Role
from app.schemas.inventory import BinOut, MovementCreateIn, MovementOut
from app.security import current_membership
from app.services.inventory import (
 BinNotFound,
 InsufficientStock,
 InventoryService,
)

router = APIRouter(prefix="/organizations/{org_id}/inventory", tags=["inventory"])


@router.get("/bins", response_model=list[BinOut])
async def list_bins(
 org_id: uuid.UUID,
 membership: Annotated[Membership, Depends(current_membership)],
 session: Annotated[AsyncSession, Depends(get_session)],
) -> list[BinOut]:
 # complete this: compute current_quantity for each bin in a single query
 # using a LEFT JOIN with SUM( Movement.quantity ).
 stmt = select(Bin).where(Bin.organization_id == org_id).order_by(Bin.code)
 bins = (await session.execute(stmt)).scalars().all()
 return [BinOut(id=b.id, code=b.code, description=b.description, current_quantity=0) for b in bins]


@router.get("/bins/{bin_id}", response_model=BinOut)
async def get_bin(
 org_id: uuid.UUID,
 bin_id: uuid.UUID,
 membership: Annotated[Membership, Depends(current_membership)],
 session: Annotated[AsyncSession, Depends(get_session)],
) -> BinOut:
 # complete this: compute current_quantity
 stmt = select(Bin).where(Bin.id == bin_id, Bin.organization_id == org_id)
 bin_row = (await session.execute(stmt)).scalar_one_or_none()
 if bin_row is None:
 raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "bin_not_found"})
 return BinOut(id=bin_row.id, code=bin_row.code, description=bin_row.description, current_quantity=0)


@router.post("/movements", response_model=MovementOut, status_code=201,
 dependencies=[Depends(require_roles(Role.owner, Role.manager, Role.operator))])
async def record_movement(
 org_id: uuid.UUID,
 body: MovementCreateIn,
 membership: Annotated[Membership, Depends(current_membership)],
 session: Annotated[AsyncSession, Depends(get_session)],
) -> MovementOut:
 svc = InventoryService(session, membership)
 try:
 movement, qty_after = await svc.record_movement(
 bin_id=body.bin_id,
 kind=body.kind,
 quantity=body.quantity,
 job_id=body.job_id,
 work_order_id=body.work_order_id,
 note=body.note,
 )
 except BinNotFound:
 raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "bin_not_found"})
 except InsufficientStock as e:
 raise HTTPException(
 status.HTTP_409_CONFLICT,
 detail={
 "code": "insufficient_stock",
 "bin_id": str(e.bin_id),
 "requested": e.requested,
 "available": e.available,
 },
 )
 await session.commit()
 return MovementOut(
 id=movement.id,
 bin_id=movement.bin_id,
 kind=movement.kind,
 quantity=movement.quantity,
 note=movement.note,
 actor_id=movement.actor_id,
 at=movement.at,
 bin_quantity_after=qty_after,
 )
```

### `app/routers/audit.py`

```python
# app/routers/audit.py
"""Audit router — read-only, keyset pagination."""
import base64
import json
import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models.audit import AuditLog
from app.models.org import Membership, Role
from app.security import current_membership, require_roles

router = APIRouter(
 prefix="/organizations/{org_id}/audit",
 tags=["audit"],
 dependencies=[Depends(require_roles(Role.owner, Role.auditor))],
)


def _encode_cursor(at: datetime, id_: int) -> str:
 raw = json.dumps({"at": at.isoformat(), "id": id_}).encode()
 return base64.urlsafe_b64encode(raw).decode()


def _decode_cursor(s: str) -> tuple[datetime, int]:
 raw = base64.urlsafe_b64decode(s.encode()).decode()
 data = json.loads(raw)
 return datetime.fromisoformat(data["at"]), int(data["id"])


@router.get("")
async def list_audit(
 org_id: uuid.UUID,
 membership: Annotated[Membership, Depends(current_membership)],
 session: Annotated[AsyncSession, Depends(get_session)],
 action: str | None = None,
 limit: int = Query(default=50, le=200),
 cursor: str | None = None,
) -> dict:
 stmt = select(AuditLog).where(AuditLog.organization_id == org_id)
 if action:
 stmt = stmt.where(AuditLog.action == action)

 if cursor:
 at, id_ = _decode_cursor(cursor)
 # Keyset: strictly less than (at, id) in the (at DESC, id DESC) order.
 stmt = stmt.where((AuditLog.at < at) | ((AuditLog.at == at) & (AuditLog.id < id_)))

 stmt = stmt.order_by(AuditLog.at.desc(), AuditLog.id.desc()).limit(limit + 1)
 rows = (await session.execute(stmt)).scalars().all()

 has_more = len(rows) > limit
 rows = rows[:limit]
 next_cursor = _encode_cursor(rows[-1].at, rows[-1].id) if rows and has_more else None
 return {
 "items": [
 {
 "id": r.id,
 "action": r.action,
 "entity_type": r.entity_type,
 "entity_id": str(r.entity_id),
 "before": r.before,
 "after": r.after,
 "at": r.at.isoformat(),
 }
 for r in rows
 ],
 "next_cursor": next_cursor,
 "has_more": has_more,
 }
```

The cursor encodes `(at, id)` as base64-JSON. The keyset predicate `(at < cursor_at) OR (at == cursor_at AND id < cursor_id)` walks the `(at DESC, id DESC)` index. This is the canonical pattern from [[02-Web-and-HTTP/Idempotency-Safe-Retries-Pagination]].

### `app/routers/reports.py`

```python
# app/routers/reports.py
"""Reports router."""
import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models.org import Membership, Role
from app.security import current_membership, require_roles
from app.services.reports import ReportsService
from app.main import get_redis # import-safe: lifespan sets app.state.redis first

router = APIRouter(prefix="/organizations/{org_id}/reports", tags=["reports"])


@router.get("/daily-output",
 dependencies=[Depends(require_roles(Role.owner, Role.manager, Role.auditor))])
async def daily_output(
 org_id: uuid.UUID,
 membership: Annotated[Membership, Depends(current_membership)],
 session: Annotated[AsyncSession, Depends(get_session)],
 redis_client: Annotated[object, Depends(get_redis)],
 settings: Annotated[object, Depends(...)],
 start: date = Query(...),
 end: date = Query(...),
) -> list[dict]:
 svc = ReportsService(session, membership, settings, redis_client)
 return await svc.daily_output(start, end)


@router.get("/inventory-snapshot")
async def inventory_snapshot(
 org_id: uuid.UUID,
 membership: Annotated[Membership, Depends(current_membership)],
 session: Annotated[AsyncSession, Depends(get_session)],
 redis_client: Annotated[object, Depends(get_redis)],
 settings: Annotated[object, Depends(...)],
) -> list[dict]:
 svc = ReportsService(session, membership, settings, redis_client)
 return await svc.inventory_snapshot()
```

**Warning — The `Depends(...)` placeholders above**

The `settings: Annotated[object, Depends(...)]` lines are placeholders — replace `...` with the actual `get_settings` dependency from `app.security`. The starter ships with the placeholder so you can see the shape; the `# complete this:` is to wire the dependency correctly. The same applies to `get_redis` — it must be defined in `app.main` and exposed as a FastAPI dependency.


### `app/main.py`

```python
# app/main.py
"""FastAPI app construction + lifespan."""
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import redis.asyncio as redis
from fastapi import FastAPI, Request

from app.config import get_settings
from app.routers import audit, auth, inventory, jobs, orgs, reports


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
 settings = get_settings()
 app.state.settings = settings

 redis_client = redis.from_url(settings.redis_url, decode_responses=True)
 try:
 await redis_client.ping()
 except redis.RedisError as e:
 raise RuntimeError(f"Redis not reachable at startup: {e}") from e
 app.state.redis = redis_client

 yield

 await redis_client.aclose()


app = FastAPI(
 title="ForgeTrack",
 version="0.1.0",
 description="Manufacturing operations API for multi-organization job shops.",
 lifespan=lifespan,
)


@app.get("/healthz", tags=["health"])
async def healthz() -> dict[str, str]:
 return {"status": "ok"}


async def get_redis(request: Request) -> redis.Redis:
 return request.app.state.redis


# --- Routers ---
app.include_router(auth.router)
app.include_router(orgs.router)
app.include_router(jobs.router)
app.include_router(inventory.router)
app.include_router(reports.router)
app.include_router(audit.router)
```

The lifespan pings Redis at startup and refuses to boot if it cannot reach it. This is the "fail loud at startup, not on the first request" rule from [[03-FastAPI-Core/Application-and-Lifespan]] — better to fail the deploy than to serve 500s on every cache lookup.

### `tests/conftest.py`

```python
# tests/conftest.py
"""Pytest fixtures — isolated Postgres schema per test run."""
import asyncio
import os
import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db import Base, get_session
from app.main import app
from app.models.org import Membership, Organization, Role
from app.models.user import User
from app.security import hash_password

TEST_DB_URL = os.environ.get(
 "TEST_DATABASE_URL",
 "postgresql+asyncpg://forgetrack:forgetrack@db:5432/forgetrack_test",
)


@pytest.fixture(scope="session")
def event_loop():
 loop = asyncio.new_event_loop()
 yield loop
 loop.close()


@pytest_asyncio.fixture(scope="session")
async def engine():
 eng = create_async_engine(TEST_DB_URL, echo=False)
 async with eng.begin() as conn:
 await conn.run_sync(Base.metadata.drop_all)
 await conn.run_sync(Base.metadata.create_all)
 yield eng
 async with eng.begin() as conn:
 await conn.run_sync(Base.metadata.drop_all)
 await eng.dispose()


@pytest_asyncio.fixture
async def session(engine):
 Session = async_sessionmaker(bind=engine, expire_on_commit=False)
 async with Session() as s:
 yield s
 await s.rollback()


@pytest_asyncio.fixture
async def seeded_org(session) -> tuple[Organization, User, User, User, User]:
 """Create an org with an owner, a manager, an operator, and an auditor."""
 org = Organization(name="Test Forge Co", slug=f"test-forge-{uuid.uuid4().hex[:8]}")
 session.add(org)
 await session.flush()

 users = []
 for email, role in [
 ("owner@test.test", Role.owner),
 ("manager@test.test", Role.manager),
 ("operator@test.test", Role.operator),
 ("auditor@test.test", Role.auditor),
 ]:
 u = User(email=email, password_hash=hash_password("test-password-123"))
 session.add(u)
 await session.flush()
 session.add(Membership(user_id=u.id, organization_id=org.id, role=role))
 users.append(u)
 await session.commit()
 return (org, *users)


@pytest_asyncio.fixture
async def client(session):
 app.dependency_overrides[get_session] = lambda: session
 transport = ASGITransport(app=app)
 async with AsyncClient(transport=transport, base_url="http://test") as c:
 yield c
 app.dependency_overrides.clear()
```

### `tests/test_auth.py`

```python
# tests/test_auth.py
import pytest


@pytest.mark.asyncio
async def test_register_login(client):
 r = await client.post("/auth/register", json={
 "email": "newuser@test.test",
 "password": "very-secure-pw-1",
 })
 assert r.status_code == 201
 tokens = r.json()
 assert "access_token" in tokens
 assert "refresh_token" in tokens

 r = await client.post("/auth/login", json={
 "email": "newuser@test.test",
 "password": "very-secure-pw-1",
 })
 assert r.status_code == 200
 assert "access_token" in r.json()


@pytest.mark.asyncio
async def test_register_duplicate_email(client):
 payload = {"email": "dupe@test.test", "password": "very-secure-pw-1"}
 r1 = await client.post("/auth/register", json=payload)
 assert r1.status_code == 201
 r2 = await client.post("/auth/register", json=payload)
 assert r2.status_code == 409
 assert r2.json()["detail"]["code"] == "email_taken"
```

### `tests/test_jobs.py`

```python
# tests/test_jobs.py
import pytest

from tests.conftest import TEST_DB_URL # noqa: F401 -- ensures env is loaded


@pytest.mark.asyncio
async def test_invalid_transition_returns_409(client, seeded_org, session):
 org, owner, *_ = seeded_org
 # complete this: log in as owner, create a job, transition draft -> planned,
 # then transition draft -> completed (should 409).
 # The starter provides the auth header helper; the test asserts 409 with
 # detail.code == "invalid_transition".
 pass
```

The `pass` here is honest: the test skeleton is in the spec; wiring the auth-header helper and asserting the body is the `# complete this:` left for the learner. The marquee test below (`test_inventory_concurrency`) is fully written because it is the one that proves the project's hardest claim.

### `tests/test_inventory_concurrency.py`

```python
# tests/test_inventory_concurrency.py
"""The marquee test: two concurrent `out` movements do not over-commit."""
import asyncio
import uuid

import pytest
from sqlalchemy import select

from app.models.inventory import Bin, Movement, MovementKind
from app.models.org import Membership, Role
from app.models.user import User
from app.services.inventory import InsufficientStock, InventoryService


@pytest.mark.asyncio
async def test_two_concurrent_issues_do_not_overcommit(session, seeded_org):
 org, _owner, _manager, operator, _auditor = seeded_org

 # Set up: a bin with 10 units (one `in` movement of 10).
 bin_row = Bin(organization_id=org.id, code="TEST-BIN-1", description="marquee")
 session.add(bin_row)
 await session.flush()

 membership = (
 await session.execute(
 select(Membership).where(
 Membership.user_id == operator.id,
 Membership.organization_id == org.id,
 )
 )
 ).scalar_one()

 svc = InventoryService(session, membership)
 await svc.record_movement(
 bin_id=bin_row.id, kind=MovementKind.in_, quantity=10, actor_id=operator.id
 )
 await session.commit()

 # Two concurrent `out` movements of 6 each. Only one should succeed; the
 # other should raise InsufficientStock. The bin should end at 4, not -2.
 async def attempt_out():
 async with session.begin_nested(): # SAVEPOINT
 try:
 svc_local = InventoryService(session, membership)
 await svc_local.record_movement(
 bin_id=bin_row.id, kind=MovementKind.out, quantity=6
 )
 return True
 except InsufficientStock:
 return False

 # Run them concurrently.
 results = await asyncio.gather(*(attempt_out() for _ in range(2)))

 # Exactly one succeeded (the other got InsufficientStock).
 assert results.count(True) == 1
 assert results.count(False) == 1

 # Verify the bin's final state.
 final_qty = await InventoryService(session, membership)._bin_quantity(bin_row.id)
 assert final_qty == 4 # 10 in - 6 out = 4
```

**This test is the project's marquee**

If ForgeTrack has one test that justifies every architectural decision (the derived quantity, the `FOR UPDATE` lock, the audit-in-transaction), this is it. Two concurrent `out` transactions racing on a bin with 10 units and asking for 6 each: exactly one must succeed, the bin must end at 4, and there must be exactly one audit row for the successful movement. If you only have time to write one test for this project, write this one.


### `tests/test_audit.py`

```python
# tests/test_audit.py
import pytest
import uuid

from sqlalchemy import select

from app.models.audit import AuditLog


@pytest.mark.asyncio
async def test_movement_writes_audit_row_in_same_txn(session, seeded_org):
 """If we roll back the movement, the audit row must also be gone."""
 from app.models.inventory import Bin, Movement, MovementKind
 from app.models.org import Membership
 from app.services.inventory import InventoryService

 org, _owner, _manager, operator, _auditor = seeded_org
 bin_row = Bin(organization_id=org.id, code="AUDIT-BIN-1")
 session.add(bin_row)
 await session.flush()

 membership = (
 await session.execute(
 select(Membership).where(
 Membership.user_id == operator.id,
 Membership.organization_id == org.id,
 )
 )
 ).scalar_one()

 svc = InventoryService(session, membership)
 await svc.record_movement(
 bin_id=bin_row.id, kind=MovementKind.in_, quantity=10
 )
 # Do NOT commit — rollback instead.
 await session.rollback()

 audit_count = (
 await session.execute(
 select(AuditLog).where(AuditLog.entity_id == bin_row.id)
 )
 ).all()
 assert audit_count == [], "audit row must be rolled back with the movement"
```

### `tests/test_reports.py`

```python
# tests/test_reports.py
import pytest


@pytest.mark.asyncio
async def test_daily_output_caches(client, seeded_org):
 """complete this: call daily-output twice; the second call must hit the cache."""
 pass
```

---

## Automated Tests

The starter ships with five test files. Two are fully written (`test_inventory_concurrency.py` and `test_audit.py`); three are skeletons that the learner completes. The goal is not 100% coverage; it is *the test that proves the hardest concept*.

To run the tests:

```bash
# In the container
docker compose run --rm api pytest -v

# Or locally, with the test database
TEST_DATABASE_URL=postgresql+asyncpg://forgetrack:forgetrack@localhost:5432/forgetrack_test \
 uv run pytest -v
```

Test pyramid:

- **Unit tests** (in `services/`): the state machine (`JOB_TRANSITIONS`), the cursor encode/decode. ~10 tests; no DB needed.
- **Integration tests** (in `tests/`): each router endpoint, the concurrency test, the audit-same-txn test. ~20 tests; needs Postgres.
- **Smoke tests**: `docker compose up` boots and `/healthz` returns 200. 1 test; the CI pipeline runs it.

**Tip — The concurrency test is the only test that absolutely requires Postgres**

SQLite does not support `SELECT ... FOR UPDATE` on a `Bin` row in the way Postgres does. If you try to run `test_inventory_concurrency` against SQLite, it will pass for the wrong reason (SQLite serializes writes by default). The test only means what it says when run against Postgres. Always test concurrency against Postgres.


---

## Docker and Environment

### `Dockerfile`

```dockerfile
# Dockerfile
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
 PYTHONDONTWRITEBYTECODE=1 \
 PIP_NO_CACHE_DIR=1 \
 PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# System deps for asyncpg and argon2
RUN apt-get update && apt-get install -y --no-install-recommends \
 libpq-dev gcc curl \
 && rm -rf /var/lib/apt/lists/*

# Install uv for fast dependency resolution
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv==0.13.1 \
 && uv sync --frozen --no-dev

# Copy the app
COPY app ./app
COPY alembic.ini alembic ./alembic
COPY tests ./tests

# Non-root user
RUN useradd --create-home --uid 1000 forge
USER forge

EXPOSE 8000

# Run alembic migrations on boot, then uvicorn
CMD ["sh", "-c", "uv run alembic upgrade head && uv run uvicorn app.main:app --host 0.0.0.0 --port 8000"]
```

The non-root user is a [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]] requirement. The `uv sync --frozen --no-dev` is the modern `uv` workflow: the lockfile pins exact versions, and `--no-dev` excludes dev dependencies from the production image.

### `compose.yaml`

```yaml
# compose.yaml
services:
 db:
 image: postgres:17-alpine
 environment:
 POSTGRES_USER: forgetrack
 POSTGRES_PASSWORD: forgetrack
 POSTGRES_DB: forgetrack
 volumes:
 - pgdata:/var/lib/postgresql/data
 ports:
 - "5432:5432"
 healthcheck:
 test: ["CMD-SHELL", "pg_isready -U forgetrack"]
 interval: 5s
 timeout: 3s
 retries: 5

 redis:
 image: redis:7-alpine
 ports:
 - "6379:6379"
 healthcheck:
 test: ["CMD", "redis-cli", "ping"]
 interval: 5s
 timeout: 3s
 retries: 5

 api:
 build: .
 environment:
 FORGETRACK_ENVIRONMENT: dev
 FORGETRACK_DATABASE_URL: postgresql+asyncpg://forgetrack:forgetrack@db:5432/forgetrack
 FORGETRACK_REDIS_URL: redis://redis:6379/0
 FORGETRACK_SECRET_KEY: ${FORGETRACK_SECRET_KEY:-dev-only-change-me}
 ports:
 - "8000:8000"
 depends_on:
 db:
 condition: service_healthy
 redis:
 condition: service_healthy

 test-db:
 image: postgres:17-alpine
 environment:
 POSTGRES_USER: forgetrack
 POSTGRES_PASSWORD: forgetrack
 POSTGRES_DB: forgetrack_test
 ports:
 - "5433:5432"

volumes:
 pgdata:
```

Two databases: `db` (for the running app) and `test-db` (for tests). They share the same image but separate volumes so the app's data is not wiped by a test run.

### `.env.example`

```bash
# .env.example — copy to .env and edit.

# --- Core ---
FORGETRACK_ENVIRONMENT=dev
FORGETRACK_LOG_LEVEL=INFO

# --- Database (matches compose.yaml) ---
FORGETRACK_DATABASE_URL=postgresql+asyncpg://forgetrack:forgetrack@db:5432/forgetrack

# --- Redis (matches compose.yaml) ---
FORGETRACK_REDIS_URL=redis://redis:6379/0

# --- Auth (CHANGE THIS IN PRODUCTION) ---
FORGETRACK_SECRET_KEY=dev-only-change-me
FORGETRACK_ACCESS_TOKEN_TTL_MINUTES=15
FORGETRACK_REFRESH_TOKEN_TTL_DAYS=30

# --- Reports cache ---
FORGETRACK_DAILY_OUTPUT_CACHE_TTL_SECONDS=300

# --- Test database (used by pytest directly, not the prefixed Settings class) ---
TEST_DATABASE_URL=postgresql+asyncpg://forgetrack:forgetrack@db:5432/forgetrack_test
```

---

## Migration History

Five ordered Alembic revisions. Apply with `alembic upgrade head`. Each is reversible with `alembic downgrade -1`. Do not let autogenerate reorder them; they encode dependencies (e.g., `audit_log` references `organizations`, so `audit_log` must come after `organizations`).

| # | Revision | Title | Tables created | Notes |
|---|----------|-------|----------------|-------|
| 1 | `0001_initial_orgs_users_memberships` | orgs + users + memberships | `organizations`, `users`, `memberships` | Installs the `citext` extension (if you choose to use it). |
| 2 | `0002_plants_machines` | plants + machines | `plants`, `machines` | Adds the `machine_status` enum. |
| 3 | `0003_jobs_work_orders` | jobs + work orders | `jobs`, `work_orders` | Adds the `job_status` and `work_order_status` enums; adds the partial unique index on `machines (organization_id, code)`. |
| 4 | `0004_bins_movements` | bins + movements | `bins`, `movements` | Adds the `movement_kind` enum; adds the `(bin_id, at)` and `(job_id, at)` indexes. |
| 5 | `0005_audit_log` | audit log | `audit_log` | Adds the `(organization_id, at desc, id desc)` index for keyset pagination. |

**Warning — Why the audit log comes last**

The audit log references `organizations` and `users` by FK; it must be created after them. More important, the audit log is the table that grows forever. Adding it last means the migration that creates it is the one that runs in production for the longest time (it back-fills nothing, so it is fast). If we add it earlier and *then* add a column to `organizations` later, the audit log's `before`/`after` jsonb will start to carry the new field on rows written after the change, while older rows do not — and that is fine, because jsonb is schemaless. But adding the audit log last means the first four migrations are smaller and faster to roll back.


### Revision 1: `0001_initial_orgs_users_memberships.py`

```python
"""Initial: organizations, users, memberships.

Revision ID: 0001_initial_orgs_users_memberships
Revises:
Create Date: 2026-10-19 12:00:00
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0001_initial_orgs_users_memberships"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
 op.execute('CREATE EXTENSION IF NOT EXISTS "pgcrypto"') # for gen_random_uuid()

 op.create_table(
 "organizations",
 sa.Column("id", postgresql.UUID(as_uuid=True),
 server_default=sa.text("gen_random_uuid()"), primary_key=True),
 sa.Column("name", sa.String(200), nullable=False),
 sa.Column("slug", sa.String(80), nullable=False),
 sa.Column("default_currency", sa.String(3), nullable=False, server_default="USD"),
 sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 sa.UniqueConstraint("slug", name="uq_organizations_slug"),
 )
 op.create_index("ix_organizations_slug", "organizations", ["slug"])

 op.create_table(
 "users",
 sa.Column("id", postgresql.UUID(as_uuid=True),
 server_default=sa.text("gen_random_uuid()"), primary_key=True),
 sa.Column("email", sa.String(255), nullable=False),
 sa.Column("password_hash", sa.String(255), nullable=False),
 sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 sa.UniqueConstraint("email", name="uq_users_email"),
 )
 op.create_index("ix_users_email", "users", ["email"])

 role_enum = postgresql.ENUM("owner", "manager", "operator", "auditor", name="role")
 role_enum.create(op.get_bind(), checkfirst=True)

 op.create_table(
 "memberships",
 sa.Column("id", postgresql.UUID(as_uuid=True),
 server_default=sa.text("gen_random_uuid()"), primary_key=True),
 sa.Column("user_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
 sa.Column("organization_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
 sa.Column("role", role_enum, nullable=False),
 sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 sa.UniqueConstraint("user_id", "organization_id", name="uq_memberships_user_org"),
 )


def downgrade() -> None:
 op.drop_table("memberships")
 op.execute("DROP TYPE IF EXISTS role")
 op.drop_table("users")
 op.drop_table("organizations")
```

### Revision 2: `0002_plants_machines.py`

```python
"""plants + machines.

Revision ID: 0002_plants_machines
Revises: 0001_initial_orgs_users_memberships
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0002_plants_machines"
down_revision = "0001_initial_orgs_users_memberships"


def upgrade() -> None:
 op.create_table(
 "plants",
 sa.Column("id", postgresql.UUID(as_uuid=True),
 server_default=sa.text("gen_random_uuid()"), primary_key=True),
 sa.Column("organization_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
 sa.Column("name", sa.String(200), nullable=False),
 sa.Column("timezone", sa.String(60), nullable=False, server_default="UTC"),
 sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 sa.UniqueConstraint("organization_id", "name", name="uq_plants_org_name"),
 )

 status_enum = postgresql.ENUM(
 "available", "busy", "maintenance", "retired", name="machine_status"
 )
 status_enum.create(op.get_bind(), checkfirst=True)

 op.create_table(
 "machines",
 sa.Column("id", postgresql.UUID(as_uuid=True),
 server_default=sa.text("gen_random_uuid()"), primary_key=True),
 sa.Column("organization_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
 sa.Column("plant_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("plants.id", ondelete="RESTRICT"), nullable=False),
 sa.Column("code", sa.String(40), nullable=False),
 sa.Column("name", sa.String(200), nullable=False),
 sa.Column("status", status_enum, nullable=False, server_default="available"),
 sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 sa.UniqueConstraint("organization_id", "code", name="uq_machines_org_code"),
 )
 op.create_index("ix_machines_organization_id", "machines", ["organization_id"])


def downgrade() -> None:
 op.drop_table("machines")
 op.execute("DROP TYPE IF EXISTS machine_status")
 op.drop_table("plants")
```

### Revision 3: `0003_jobs_work_orders.py`

```python
"""jobs + work_orders + enums.

Revision ID: 0003_jobs_work_orders
Revises: 0002_plants_machines
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0003_jobs_work_orders"
down_revision = "0002_plants_machines"


def upgrade() -> None:
 job_status = postgresql.ENUM(
 "draft", "planned", "in_progress", "completed", "cancelled", name="job_status"
 )
 job_status.create(op.get_bind(), checkfirst=True)
 wo_status = postgresql.ENUM(
 "pending", "in_progress", "completed", "blocked", "cancelled",
 name="work_order_status",
 )
 wo_status.create(op.get_bind(), checkfirst=True)

 op.create_table(
 "jobs",
 sa.Column("id", postgresql.UUID(as_uuid=True),
 server_default=sa.text("gen_random_uuid()"), primary_key=True),
 sa.Column("organization_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
 sa.Column("external_ref", sa.String(100)),
 sa.Column("customer", sa.String(200), nullable=False),
 sa.Column("part_number", sa.String(80), nullable=False),
 sa.Column("quantity_ordered", sa.Integer, nullable=False),
 sa.Column("status", job_status, nullable=False, server_default="draft"),
 sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 sa.CheckConstraint("quantity_ordered > 0", name="ck_jobs_quantity_positive"),
 )
 op.create_index("ix_jobs_organization_status", "jobs", ["organization_id", "status"])
 op.create_index("ix_jobs_organization_created", "jobs", ["organization_id", "created_at"])

 op.create_table(
 "work_orders",
 sa.Column("id", postgresql.UUID(as_uuid=True),
 server_default=sa.text("gen_random_uuid()"), primary_key=True),
 sa.Column("job_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False),
 sa.Column("sequence", sa.Integer, nullable=False),
 sa.Column("operation", sa.String(200), nullable=False),
 sa.Column("machine_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("machines.id", ondelete="RESTRICT"), nullable=False),
 sa.Column("quantity_planned", sa.Integer, nullable=False),
 sa.Column("quantity_completed", sa.Integer, nullable=False, server_default="0"),
 sa.Column("status", wo_status, nullable=False, server_default="pending"),
 sa.Column("started_at", sa.DateTime(timezone=True)),
 sa.Column("completed_at", sa.DateTime(timezone=True)),
 sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 sa.UniqueConstraint("job_id", "sequence", name="uq_work_orders_job_sequence"),
 sa.CheckConstraint("quantity_planned > 0", name="ck_wo_planned_positive"),
 sa.CheckConstraint("quantity_completed >= 0", name="ck_wo_completed_nonneg"),
 )


def downgrade() -> None:
 op.drop_table("work_orders")
 op.execute("DROP TYPE IF EXISTS work_order_status")
 op.drop_table("jobs")
 op.execute("DROP TYPE IF EXISTS job_status")
```

### Revision 4: `0004_bins_movements.py`

```python
"""bins + movements.

Revision ID: 0004_bins_movements
Revises: 0003_jobs_work_orders
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0004_bins_movements"
down_revision = "0003_jobs_work_orders"


def upgrade() -> None:
 op.create_table(
 "bins",
 sa.Column("id", postgresql.UUID(as_uuid=True),
 server_default=sa.text("gen_random_uuid()"), primary_key=True),
 sa.Column("organization_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
 sa.Column("code", sa.String(40), nullable=False),
 sa.Column("description", sa.Text()),
 sa.UniqueConstraint("organization_id", "code", name="uq_bins_org_code"),
 )

 kind_enum = postgresql.ENUM("in", "out", "adjust", name="movement_kind")
 kind_enum.create(op.get_bind(), checkfirst=True)

 op.create_table(
 "movements",
 sa.Column("id", postgresql.UUID(as_uuid=True),
 server_default=sa.text("gen_random_uuid()"), primary_key=True),
 sa.Column("bin_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("bins.id", ondelete="RESTRICT"), nullable=False),
 sa.Column("job_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("jobs.id", ondelete="SET NULL")),
 sa.Column("work_order_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("work_orders.id", ondelete="SET NULL")),
 sa.Column("kind", kind_enum, nullable=False),
 sa.Column("quantity", sa.Integer, nullable=False),
 sa.Column("note", sa.Text()),
 sa.Column("actor_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=False),
 sa.Column("at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 )
 # The hottest index in the system: (bin_id, at) for the SUM query.
 op.create_index("ix_movements_bin_at", "movements", ["bin_id", "at"])
 op.create_index("ix_movements_job_at", "movements", ["job_id", "at"])


def downgrade() -> None:
 op.drop_table("movements")
 op.execute("DROP TYPE IF EXISTS movement_kind")
 op.drop_table("bins")
```

### Revision 5: `0005_audit_log.py`

```python
"""audit_log.

Revision ID: 0005_audit_log
Revises: 0004_bins_movements
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0005_audit_log"
down_revision = "0004_bins_movements"


def upgrade() -> None:
 op.create_table(
 "audit_log",
 sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
 sa.Column("organization_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
 sa.Column("actor_id", postgresql.UUID(as_uuid=True),
 sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=False),
 sa.Column("action", sa.String(80), nullable=False),
 sa.Column("entity_type", sa.String(40), nullable=False),
 sa.Column("entity_id", postgresql.UUID(as_uuid=True), nullable=False),
 sa.Column("before", postgresql.JSONB()),
 sa.Column("after", postgresql.JSONB()),
 sa.Column("at", sa.DateTime(timezone=True), nullable=False,
 server_default=sa.text("now()")),
 )
 # Keyset pagination index: (organization_id, at DESC, id DESC).
 op.create_index(
 "ix_audit_log_org_at_id",
 "audit_log",
 ["organization_id", sa.text("at DESC"), sa.text("id DESC")],
 )


def downgrade() -> None:
 op.drop_table("audit_log")
```

---

## Error Handling

ForgeTrack maps domain errors to HTTP responses through `HTTPException` raised in routers. Service-layer exceptions are caught at the router boundary; they never escape to the framework (the framework's default 500 would leak the traceback).

| Domain error | HTTP status | `detail.code` | When it happens |
|--------------|-------------|----------------|-----------------|
| `email_taken` | 409 | `email_taken` | Registering with an email that already exists. |
| `bad_credentials` | 401 | `bad_credentials` | Login with a wrong email or password. |
| `token_expired` | 401 | `token_expired` | The JWT is past its `exp`. |
| `token_invalid` | 401 | `token_invalid` | The JWT signature does not verify. |
| `wrong_token_type` | 401 | `wrong_token_type` | Using a refresh token where an access token is expected, or vice versa. |
| `org_not_found` | 404 | `org_not_found` | The user has no membership in the org path segment. (404, not 403 — no information leak.) |
| `forbidden_role` | 403 | `forbidden_role` | The user's role in this org does not allow the action. |
| `invalid_transition` | 409 | `invalid_transition` | A state-machine transition that is not in the legal set. |
| `job_not_found` | 404 | `job_not_found` | The job ID does not exist or belongs to another org. |
| `bin_not_found` | 404 | `bin_not_found` | The bin ID does not exist or belongs to another org. |
| `insufficient_stock` | 409 | `insufficient_stock` | An `out` movement that would take the bin below zero. |
| `bad_auth_header` | 401 | `bad_auth_header` | The `Authorization` header is missing or not `Bearer <token>`. |
| `user_not_found` | 401 | `user_not_found` | The JWT is valid but the user was deleted. |

The error response body is always:

```json
{
 "code": "insufficient_stock",
 "message": "Bin ... has 4 units; cannot issue 6.",
 "details": { "bin_id": "...", "requested": 6, "available": 4 }
}
```

The `code` is a machine-readable string (the only thing clients should branch on). The `message` is human-readable (for the developer reading the response in DevTools). The `details` is optional structured context.

**Why all error responses share a shape**

Clients should be able to write one helper `if (err.response.data.code === 'token_expired') { refreshToken(); retry(); }` and have it work for every error. If some errors return `{"error": "..."}` and others return `{"detail": {"code": "..."}}`, the client has to special-case. The ForgeTrack convention is `{"code": str, "message": str, "details": dict | null}` for every non-2xx response. FastAPI's default `{"detail": "..."}` shape is overridden by raising `HTTPException(detail={"code": ..., "message": ..., "details": ...})` consistently.


---

## Performance Considerations

### Bottlenecks

1. **The bin-quantity SUM.** Every `GET /bins/{id}` and every `POST /inventory/movements` does `SELECT SUM(quantity) FROM movements WHERE bin_id = :bin_id`. With the `(bin_id, at)` index, this is an index-only scan over the bin's movements. At 50,000 movements a year per org and ~100 bins per org, a bin has at most ~500 movements/year — the SUM is microseconds. If a bin accumulates 100,000+ movements (10+ years), the SUM is still fast because of the index, but you can add a `bin_quantities` materialized view that is refreshed by trigger if it ever becomes hot.

2. **The audit log.** `audit_log` is the only table that grows forever. The keyset index `(organization_id, at desc, id desc)` keeps pagination fast (the seek is O(log n)), but full-table queries (`SELECT COUNT(*) FROM audit_log WHERE organization_id = :org`) are O(n) and should be avoided. Reports that need counts should use approximation (`SELECT reltuples`) or pre-aggregated tables.

3. **The daily-output report.** `SELECT date_trunc('day', completed_at), machine_id, COUNT(*) FROM work_orders WHERE ... GROUP BY ...` is a sequential scan over the time range. For a year's data, it is ~50,000 rows per org — sub-100 ms with the `(organization_id, completed_at)` index (add it if the report becomes hot). The Redis cache (5 min TTL) absorbs repeated calls.

### Indexes

| Table | Index | Purpose |
|-------|-------|---------|
| `movements` | `(bin_id, at)` | The SUM query for bin quantity. |
| `movements` | `(job_id, at)` | Job movement history. |
| `audit_log` | `(organization_id, at DESC, id DESC)` | Keyset pagination. |
| `jobs` | `(organization_id, status)` | Filter jobs by status. |
| `jobs` | `(organization_id, created_at)` | Sort jobs by recency. |
| `work_orders` | `(job_id, sequence)` | Unique constraint, also serves the WO-by-job query. |
| `users` | `(email)` | Login lookup. |
| `memberships` | `(user_id, organization_id)` | Unique constraint, also serves the membership lookup. |

### Caches

- `daily_output` report: 5 min TTL in Redis. Cache key includes `(organization_id, start, end)`. The cache is invalidated implicitly by TTL — there is no explicit invalidation, which is acceptable because the report is "how many work orders completed yesterday" and a 5-min staleness is fine.
- Bin quantities: not cached by default. The SUM is fast enough. If a specific bin becomes hot (e.g., a bin that an operator issues from every 10 seconds during a shift), add a per-bin cache with a write-through invalidation on movement write.

**Warning — Do not cache bin quantities preemptively**

A cache on bin quantities is a classic premature optimization. The cache hit saves a 2 ms SUM; the cache miss (or worse, the stale read after a concurrent write) costs you correctness. Ship without the cache; if a real bin gets hot, add the cache for *that* bin. The general lesson from [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]]: measure first, optimize second.


---

## Deployment Guide

ForgeTrack ships to Fly.io as the default. The same Dockerfile works on Render, Railway, AWS ECS, or any container-native platform.

### Steps

1. **Provision Postgres.** On Fly.io: `fly postgres create --name forgetrack-db`. Attach it to the app: `fly postgres attach forgetrack-db`. The attach sets `DATABASE_URL` (the unprefixed form) in the app's environment; you must then copy that value to `FORGETRACK_DATABASE_URL` so the prefixed `Settings` class reads it. (Or override `env_prefix` in production — see [[04-Pydantic/Pydantic-Settings]] for the trade-off.)

2. **Provision Redis.** `fly redis create --name forgetrack-redis`. The platform sets `REDIS_URL` (or `FORGETRACK_REDIS_URL` — depends on the platform; Fly uses the unprefixed form, so the app reads both via a `@computed_field` alias).

3. **Set secrets.** `fly secrets set FORGETRACK_SECRET_KEY=$(python -c "import secrets; print(secrets.token_hex(32))") FORGETRACK_ENVIRONMENT=prod`. The app's `assert_production_safe()` will refuse to boot without a real secret in `prod`.

4. **Deploy.** `fly deploy --remote-only --dockerfile Dockerfile`. The Dockerfile runs `alembic upgrade head` on boot, which applies any pending migrations.

5. **Smoke test.** `curl https://forgetrack.fly.dev/healthz` should return `{"status":"ok"}`.

6. **Set up the CI pipeline** (see [[12-Testing-and-Quality/CI-Pipelines]]): on every push to `main`, run `pytest` against a test database, then run `alembic upgrade head --sql` against the test database to verify migrations are reversible. On a green build, `fly deploy`.

**Tip — Migrations in a multi-replica deploy**

If you run 3+ replicas of the API, the `alembic upgrade head` in the Dockerfile `CMD` runs in every replica. Two of them will race; one will fail with `relation already exists`. The fix: run migrations in a separate one-shot job, not in the web `CMD`. Fly's `release_command` is the right place. The `Dockerfile` `CMD` should only run uvicorn.


---

## README

```markdown
# ForgeTrack — Manufacturing Operations API

Multi-organization manufacturing operations for small and medium job shops.
Organizations, plants, machines, jobs, work orders, inventory bins and movements,
a state machine, concurrency-safe stock issues, an audit log, and reports.

## Quickstart

```bash
cp .env.example .env
docker compose up --build
```

Visit `http://localhost:8000/docs` for the OpenAPI page.

## Stack

- FastAPI 0.148.0, Starlette 1.9.0, Pydantic v2.14.1
- SQLAlchemy 2.1.5 (async, `Mapped[T]`), Alembic 1.20.0
- PostgreSQL 17.x, Redis 7.x
- Python 3.12, uv 0.13.1

## Architecture

- `app/routers/` — thin HTTP adapters.
- `app/services/` — workflows and transaction boundaries.
- `app/models/` — SQLAlchemy 2.x declarative models.
- `app/schemas/` — Pydantic v2 input/output models.

## Tests

```bash
docker compose run --rm api pytest -v
```

The marquee test is `tests/test_inventory_concurrency.py::test_two_concurrent_issues_do_not_overcommit`.

## Migrations

```bash
docker compose run --rm api uv run alembic upgrade head
```

## Project layout

See `app/` for the source tree. The starter ships with:
- Five Alembic revisions (`alembic/versions/`)
- Five test files (`tests/`)
- A Dockerfile, a compose.yaml, and a `.env.example`

## License

MIT — see `LICENSE`.
```

---

## Resume Bullet Examples

These are the bullets you would put on a résumé after shipping ForgeTrack. They are specific and quantified; vagueness is the surest signal of a junior portfolio.

- **Designed and shipped a multi-organization manufacturing operations API in FastAPI 0.148.0 + SQLAlchemy 2.1.5** serving 1–50 organizations per cluster at 50k inventory movements/org/year with zero consistency bugs, by deriving bin quantities from append-only `movements` rows and serializing concurrent `out` issues with `SELECT ... FOR UPDATE` on the bin row.
- **Reduced audit-log pagination p99 from 480 ms to 6 ms** by replacing `OFFSET` pagination with a keyset `(at DESC, id DESC)` cursor backed by a composite index on `(organization_id, at DESC, id DESC)`, supporting 1M+ rows per organization without degradation.
- **Cut daily-output report latency by 92% (from 180 ms to 14 ms)** by adding a Redis 7 cache-aside layer with a 5-minute TTL keyed on `(organization_id, start, end)`, and a composite index on `(organization_id, completed_at)` for the underlying `date_trunc` aggregation.

**Why are these bullets good?**

Each one names a specific technology (FastAPI 0.148.0, SQLAlchemy 2.1.5, Redis 7), a specific metric (50k movements/year, 480 ms → 6 ms, 92% latency cut), and the *mechanism* (the FOR UPDATE lock, the keyset cursor, the cache-aside layer). A reviewer can ask "how did you measure?" and you have an answer. A reviewer can ask "why FOR UPDATE and not SERIALIZABLE?" and you have an answer (the bin row is a single-row contention point). Specific bullets start conversations; vague bullets end them.


---

## Interview Discussion Questions

If you ship ForgeTrack, you should be able to defend each of these in a 45-minute interview.

1. **Why did you derive bin quantities from `movements` rather than storing a `bins.quantity` column?** What consistency guarantees does this give you, and what is the cost? When would you flip the trade and store the running quantity?

2. **Walk me through what happens when two operators issue stock from the same bin at the same instant.** What lock is taken, on what row, in what order? What happens if one of the transactions takes 200 ms longer than the other? What happens if the bin has exactly 4 units and both operators ask for 4?

3. **Why is the audit log written in the same transaction as the change, rather than in a `BackgroundTasks` after the response?** What two bugs does the same-transaction write prevent? When is `BackgroundTasks` the right tool, and when is it not?

4. **Why does `current_membership` return 404, not 403, when a user has no membership in the org?** What information does a 403 leak that a 404 does not? When would you flip the trade and return 403?

5. **Why keyset pagination for the audit log, but offset pagination for the jobs list?** What is the access pattern for each that makes one fit and the other not? What would you measure to decide?

**Tip — Practice these out loud**

Reading the questions is not enough. Stand up, pace around, and answer each one out loud as if a reviewer were asking. If you stumble, go back to the spec, read the relevant section, and try again. The point is not to memorize answers; it is to internalize the reasoning so it surfaces when you need it.


---

## Future Enhancements

Once the starter is shipped and the tests pass, these are the next steps that turn ForgeTrack from "portfolio project" to "platform."

1. **Refresh-token rotation with family reuse detection.** Implement the stub `/auth/refresh` properly: store refresh-token JTI hashes, mark them used, and detect reuse (a stolen refresh token being used twice signals compromise — rotate the entire family and force re-login).
2. **External ERP integration adapter.** Sketch a `BillingAdapter`-style abstraction (as Project 02 does for the billing provider) for SAP/NetSuite: a `ERPAdapter` interface with a `SandboxAdapter` and a `SAPAdapter`, with circuit-breaker retries (see [[15-External-Integrations/Circuit-Breakers]]).
3. **Real-time machine telemetry.** Replace the static `machines.status` column with a MQTT subscriber that updates status from machine sensors. Add a WebSocket/SSE endpoint for "machine 3 just went busy."
4. **Per-bin materialized quantity.** If a specific bin becomes hot (>1000 movements/day), add a `bin_quantities` table refreshed by trigger, falling back to the SUM only for cold bins.
5. **Audit log export to S3.** Stream the audit log as Parquet to S3 nightly, with a partitioned layout `org_id=.../year=.../month=.../day=.../audit.parquet`. The auditor gets athena-style SQL access; the OLTP DB stops being the long-term audit archive.
6. **Multi-currency cost tracking.** Add a `currency` column on movements and an FX-rate service. The reporting endpoints then aggregate in a chosen currency.

---

## What We Learned

- **Multi-tenancy is a query-layer concern, not a router-layer concern.** Scoping every operational query by `organization_id` is what makes cross-org reads impossible by design. The `current_membership(org_id)` dependency enforces it for free, on every route.
- **Concurrency correctness is a lock-on-the-right-row problem.** The bin's quantity is derived; the lock is on the bin row. Two concurrent `out` movements serialize on the bin row, and the second one reads the post-first-movement SUM. The marquee test proves it.
- **The audit log is a transaction participant, not a side effect.** Audit rows written in `BackgroundTasks` after the response are the source of two of the most common audit bugs (lost rows, ghost rows). Same-transaction writes eliminate both.
- **Keyset pagination is the only pagination that does not degrade.** `OFFSET 100000` is O(100050) work; keyset is O(50). The audit log is the canonical case where this matters.
- **State machines as data, not as code.** `JOB_TRANSITIONS: dict[Status, set[Status]]` is the state machine. Adding a transition is a one-line edit; testing every legal and illegal transition is a `for` loop over the dict. This is the most maintainable shape.
- **The Dockerfile is a deploy artifact, not an afterthought.** Non-root user, multi-stage build, `uv sync --frozen`, `CMD` that runs migrations — these are not optional polish, they are the difference between a project that runs on your laptop and a project that runs in production.

**ForgeTrack is done when the marquee test passes.**

Not when every router is implemented. Not when coverage is 100%. When the test that proves two concurrent `out` movements do not over-commit passes against Postgres, the project has shipped its hardest claim. Everything else is depth.


---

**Tags:** #project #manufacturing #multi-tenant #rbac #for-update #audit #portfolio
**Next:** [[18-Portfolio-Projects/02-Multi-Tenant-Billing-SaaS]] or back to [[18-Portfolio-Projects/00-Projects-MOC]].

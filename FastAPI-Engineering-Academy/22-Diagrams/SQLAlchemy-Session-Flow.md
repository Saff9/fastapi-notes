---
title: SQLAlchemy Session Flow Diagram
aliases:
 - Session Flow
 - Session Lifecycle
 - Session State Machine
tags:
 - diagrams
 - sqlalchemy
 - session
 - lifecycle
course_level: intermediate
difficulty: intermediate
estimated_time: "15 minutes to read; 1 hour to internalize"
status: complete
prerequisites:
 - "[[07-SQLAlchemy/02-Engines-Connections-Pools]]"
 - "[[07-SQLAlchemy/05-Session-and-Transaction-Management]]"
 - "[[07-SQLAlchemy/07-Async-SQLAlchemy]]"
related_lessons:
 - "[[22-Diagrams/Request-Lifecycle-Diagram]]"
 - "[[22-Diagrams/Deployment-Topology]]"
 - "[[07-SQLAlchemy/05-Session-and-Transaction-Management]]"
 - "[[07-SQLAlchemy/07-Async-SQLAlchemy]]"
---

# SQLAlchemy Session Flow Diagram

*The canonical Mermaid of the SQLAlchemy `Session` lifecycle: `sessionmaker()` → `with sessionmaker() as session:` → `session.add(obj)` → autoflush before query → `session.commit()` → transaction ends → objects expire → next access triggers SELECT → `with` block exits → session closed → objects detached. Lessons that need this diagram link here.*

**You're looking at the second interview diagram**

"Explain the SQLAlchemy session lifecycle" is the data-side counterpart to "draw the request lifecycle." The two diagrams together cover most of backend architecture in two whiteboards. Practice drawing this one. Pay special attention to step 6 (expiration after commit) and step 7 (detachment after close) — those are the two phases that produce the most production bugs (the `MissingGreenlet` of Incident 3, the `DetachedInstanceError` of Lab 3).


#diagram #sqlalchemy #session #lifecycle

## Diagram

```mermaid
sequenceDiagram
 autonumber
 participant Engine as Engine (pool)
 participant SM as sessionmaker
 participant Sess as Session
 participant IM as Identity map
 participant DB as Database
 participant Code as Caller code

 Code->>SM: Session = sessionmaker(engine)
 Note over SM: Configured once at startup.<br/>Holds engine, options:<br/>expire_on_commit,<br/>autoflush.
 Code->>SM: with Session() as session:
 SM->>Sess: __new__, __enter__
 Sess->>Engine: borrow connection (lazy)
 Note over Sess,IM: Transaction begins<br/>on first SQL.<br/>Identity map is empty.
 Code->>Sess: session.add(User(email="a@b"))
 Note over Sess,IM: Object is "pending".<br/>No SQL sent yet.<br/>Identity map updated.
 Code->>Sess: session.scalars(select(User))
 Note over Sess: autoflush=True,<br/>so pending changes<br/>are flushed first.
 Sess->>DB: INSERT INTO users (email) VALUES ('a@b')
 DB-->>Sess: row count, returning id
 Sess->>DB: SELECT * FROM users
 DB-->>Sess: rows
 Sess->>IM: identity_map populated
 Sess-->>Code: ScalarResult
 Code->>Sess: session.commit()
 Sess->>Sess: autoflush (no-op if clean)
 Sess->>DB: COMMIT
 Note over Sess,IM: Transaction ends.<br/>Objects EXPIRE<br/>(expire_on_commit=True).
 Sess-->>Code: commit done
 Code->>Sess: print(user.email)
 Note over Sess,IM: Attribute expired.<br/>Next access<br/>triggers a SELECT.
 Sess->>DB: SELECT * FROM users WHERE id=?
 DB-->>Sess: row data
 Note over Sess,IM: Object refreshed.<br/>New transaction<br/>started implicitly.
 Code->>Sess: exit with block
 Sess->>Engine: return connection to pool
 Note over Sess,IM: Session is closed.<br/>Objects become DETACHED.
```

## Prose: what each phase does

### Step 1. Configure the sessionmaker

At application startup (in the lifespan — see [[03-FastAPI-Core/Application-and-Lifespan]]), you create a `sessionmaker` bound to the engine, with the options you want (`expire_on_commit`, `autoflush`, etc.). The `sessionmaker` is a factory; it does not open a connection. Creating it is cheap.

```python
SessionLocal = sessionmaker(engine, expire_on_commit=True)
# Async equivalent:
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)
```

**Why the async idiom uses `expire_on_commit=False`**

After commit, attributes are expired (see step 6); the next access triggers a re-fetch — but in async, the re-fetch needs an `await` outside the session's await context, raising `MissingGreenlet`. Setting `False` keeps the in-memory state and avoids the trap. See Q7 and Q12 of [[19-Interview-Preparation/SQLAlchemy-Sessions-Questions]].


**Warning — Security: never log the engine URL with credentials**

The `engine = create_engine("postgresql+psycopg://user:pass@host/db")` form embeds the password in the URL string. Logging `engine.url` (or pickling the engine, or printing the sessionmaker) leaks it. Production habit: build the URL with `URL.create(drivername="postgresql+psycopg", username=settings.DB_USER, password=settings.DB_PASSWORD, host=settings.DB_HOST, port=settings.DB_PORT, database=settings.DB_NAME)` so the password is a separate attribute, never serialized; mask it in logs with `engine.url.render_as_string(hide_password=True)`. See [[04-Pydantic/Pydantic-Settings]] for the secrets-source pattern and [[11-Authentication-and-Security/Threat-Model-First]] for the data-class audit.


### Step 2. Open a session

When the handler (or service, or background task) needs a session, it opens one — typically via a context manager:

```python
with SessionLocal() as session:
 ...
# Async:
async with AsyncSessionLocal() as session:
 ...
```

Opening a session is cheap — no connection is borrowed yet. The session is a Python-level object that will borrow a connection lazily on its first SQL.

**Why lazy:** The engine pool is sized for the steady-state concurrency of your app (10-50 connections in the typical config). Eagerly grabbing a connection per session-open would burn through the pool before any SQL runs. Lazy borrow means sessions that never touch the DB never hold a connection.

**Production: pool sizing is a function of your concurrency, not your DB size**

The default `QueuePool` size is 5 connections plus 5 overflow — fine for unit tests, broken for any real handler. The production formula is `pool_size + max_overflow >= concurrent_in_flight_requests_per_worker`, capped at the Postgres `max_connections` divided by your worker count. For a 4-worker Uvicorn behind a Postgres `max_connections=100`, that is `pool_size=20, max_overflow=5` per worker — 100 connections if every worker is saturated, which is exactly the budget. Add `pool_pre_ping=True` to detect stale connections after a DB failover; without it, the first request post-failover raises `OperationalError: server closed the connection unexpectedly`. See [[07-SQLAlchemy/02-Engines-Connections-Pools]] for the full sizing table.


### Step 3. Add objects

`session.add(obj)` places an object in the "pending" state. The object is now tracked by the session but no SQL has been sent. The identity map is updated so that subsequent queries in the same session see the object.

**Tip — "Pending" vs "persistent"**

"Pending" = added but not flushed. "Persistent" = flushed (SQL sent) but not committed. "Detached" = session closed. These are the three states you'll be quizzed on. See [[07-SQLAlchemy/05-Session-and-Transaction-Management]] for the full state machine.


**Tip — Debugging: inspect the identity map with `session.identity_map`**

The identity map is the session's internal cache of "objects I have loaded in this transaction". When a query returns "stale" data (you updated a row but the SELECT still shows the old value), the identity map is usually the cause — autoflush is off or the update happened in a different session. Inspect with `[obj for obj in session.identity_map.values()]` (sync) or `await session.run_sync(lambda s: list(s.identity_map.values()))` (async). The map is *per-session*, not per-request, so two sessions in the same request (a bug) will not share state — and the bug surfaces as "I wrote it but I can't read it back".


### Step 4. Query: autoflush fires

When you issue a `SELECT` (via `session.execute(...)` or `session.scalars(...)`), the session checks: are there pending changes? If `autoflush=True` (the default), the session issues an `INSERT`/`UPDATE`/`DELETE` for each pending change *before* the `SELECT`, so the SELECT can see the in-memory state within the current transaction. This is the surprising part — the SQL you issued (a `SELECT`) is not the only SQL sent to the DB. See [[07-SQLAlchemy/05-Session-and-Transaction-Management]] and Q6 of [[19-Interview-Preparation/SQLAlchemy-Sessions-Questions]].

**Interview follow-up: when is autoflush dangerous?**

When you have a parent+child to add and the child has a FK to the parent. Autoflush tries to flush both together; if the order is wrong, the FK constraint fails mid-query. The fix: disable autoflush for the session, or `session.flush()` manually between the parent and the child add. See Q6 of [[19-Interview-Preparation/SQLAlchemy-Sessions-Questions]].


**Danger — Debugging: detect autoflush-induced INSERTs with `echo=True`**

Autoflush is the surprising behavior where a `session.scalars(select(User))` issues an `INSERT` before the `SELECT`. In a 200-LOC handler this is invisible; in production, it shows up as "why is there a write query in my GET endpoint?". The detection: `engine = create_engine(url, echo=True, echo_pool="debug")` in a staging environment, or — better — emit `before_execute` events through OpenTelemetry (see [[13-Performance-and-Observability/OpenTelemetry-Tracing]]). If you see an `INSERT` or `UPDATE` in the trace of a `GET /users/{id}` handler, autoflush is firing on a stale pending object somewhere upstream. The fix is `session.autoflush = False` for that handler, with an explicit `session.flush()` before the read where you actually want pending state visible.


### Step 5. Commit

`session.commit()` is where the unit of work ends. The commit:

1. Flushes any remaining pending changes (same as autoflush, but for all pending state, not just pre-query).
2. Sends `COMMIT` to the database. The transaction ends; changes become durable and visible to other sessions.
3. Expires all objects in the identity map (if `expire_on_commit=True`, the default). The objects are still in the session but their attributes are marked "stale."

**Warning — Production: `commit()` can raise — always rollback on `IntegrityError`**

`session.commit()` is not guaranteed to succeed; a unique-constraint violation or a FK failure surfaces as `IntegrityError` *during* the COMMIT (the database rejects the transaction). The session is left in a broken state — every subsequent query raises `PendingRollbackError: this session is in a transaction, but no transaction has been started` until you call `session.rollback()`. The structural fix is the `with` block: `except Exception: session.rollback(); raise` inside the `with SessionLocal() as session:` form lets the context manager close the session cleanly. Without this, the next request reusing the same session via a FastAPI dependency gets a poisoned session from the pool — the production symptom is cascading 500s after one bad write. See [[01-Python-Foundations/Exceptions-Done-Right]] for the rollback-as-cleanup pattern.


### Step 6. Object expiration

After commit, accessing `user.email` on an expired object triggers a `SELECT` to refresh it. This is the second surprising behavior — a `print(user.email)` after `session.commit()` can issue a database round trip.

Why? Because another transaction might have modified the row since this session loaded it; the session wants to give you the current value. Disable with `expire_on_commit=False` when you want to keep using the in-memory values without re-fetching.

**Warning — The async trap**

In `AsyncSession`, the post-commit re-fetch needs an `await` outside the session's await context (because the session may be closed by then). This raises `MissingGreenlet`. The fix is `expire_on_commit=False`, which prevents the re-fetch entirely. See Incident 3 in [[19-Interview-Preparation/Production-Incidents-Debugging]].


**Debugging: read the `MissingGreenlet` traceback from the bottom up**

`MissingGreenlet: greenlet_spawn has not been called` is the async trap from step 6 — accessing an expired attribute or a lazy relationship outside an await context. The traceback is misleading because the failure point (the attribute access) is at the top, but the root cause (the `commit()` that expired it) is several frames down or in a different request entirely. Read it from the bottom: find the last `await`-able SQLAlchemy frame, look at what was committed, and check whether `expire_on_commit=False` was set on that session factory. The fix is almost always at the session factory, not at the access site — patching the access site just moves the next `MissingGreenlet` one frame higher. See [[07-SQLAlchemy/07-Async-SQLAlchemy]] and Incident 3 in [[19-Interview-Preparation/Production-Incidents-Debugging]].


### Step 7. Close the session

When the `with` block exits, the session closes. The connection is returned to the pool. Objects become **detached** — they are no longer associated with a session; accessing an unloaded relationship or an expired attribute raises `DetachedInstanceError` (sync) or `MissingGreenlet` (async). See Q11 of [[19-Interview-Preparation/SQLAlchemy-Sessions-Questions]].

**Why `with` and not `session.close()` at the end:** The `with` form guarantees close runs even if an exception propagates. A bare `session = SessionLocal()` without `with` is the #1 source of pool leaks in code review — the close call gets dropped behind an early return, an exception, or a refactor. The context manager is the structural fix.

**Danger — Security: do not return ORM objects to the client**

Returning an ORM object directly from a handler (e.g. `return user`) leaks every column on the model, including `password_hash`, `is_active`, internal audit fields, and any relationship the serializer can lazy-load. Pydantic will happily dump the lot into JSON. The fix is structural: define a `UserRead` response model (`response_model=UserRead`) with only the fields the client should see, and let Pydantic filter at serialization. Without the response model, a future migration adding a `two_factor_secret` column silently ships it to every API consumer — the leak is invisible in code review because the new column is "just there". See [[04-Pydantic/Serialization-and-Model-Dump]] for the dump configuration and [[11-Authentication-and-Security/OWASP-API-Top-10]] for the property-level authorization pattern.


### Step 8. (Async) Connection lifecycle

With `AsyncSession`, the connection lifecycle is the same; the calls are awaited. The autoflush, commit, and expiration behaviors are identical. The difference is that lazy-loaded relationships raise `MissingGreenlet` if accessed outside an await context — see [[07-SQLAlchemy/07-Async-SQLAlchemy]].

## Variants

### With a service-layer commit

In a clean architecture, the service commits, not the handler. The diagram is the same; just replace "Code" with "Service" in steps 5 and 6. The session is provided to the service via the FastAPI dependency. See Q13 of [[19-Interview-Preparation/SQLAlchemy-Sessions-Questions]].

### With a savepoint

Between steps 4 and 5, the service may open a savepoint (`session.begin_nested()`). The savepoint wraps a sub-transaction; commit/rollback on the savepoint affects only the sub-transaction. Used for partial-failure handling: try the risky operation in a savepoint, rollback the savepoint on error, continue with the outer transaction.

**Why a savepoint over a try/except + rollback-the-whole-thing:** Because rolling back the outer transaction throws away everything since the last commit — including the work you wanted to keep. A savepoint is the surgical tool: it rolls back only the risky operation, preserving the surrounding work in the same transaction. Pattern: import-from-third-party with retry-on-error in a savepoint.

### With `expire_on_commit=False`

In step 5, the objects do not expire. Step 6 does not happen — accessing `user.email` after commit returns the in-memory value without a SELECT. Useful when returning ORM objects that need to be serialized post-commit, but be aware the values are "as of the pre-commit session."

## Common bugs visualized by this diagram

**Danger — Four bugs this diagram surfaces**

- **N+1** — the diagram shows one query at step 4; an N+1 produces N additional queries just after, one per lazy relationship access. See Lab 1 in [[20-Exercises-and-Labs/Debugging-Labs]] and Incident 1 in [[19-Interview-Preparation/Production-Incidents-Debugging]].
- **`MissingGreenlet`** — at step 6, on `AsyncSession`, accessing an expired attribute outside an await context raises. See Incident 3 in [[19-Interview-Preparation/Production-Incidents-Debugging]] and Q12 of [[19-Interview-Preparation/SQLAlchemy-Sessions-Questions]].
- **Detached object access** — after step 7, accessing an attribute that was not loaded raises `DetachedInstanceError`. The fix is to load it inside the session or return a DTO. See Q11 of [[19-Interview-Preparation/SQLAlchemy-Sessions-Questions]].
- **Pool exhaustion** — if a session is not closed (the `with` block is replaced by a manual `session = SessionLocal()` without a close), the connection is held indefinitely. With enough leaks, the pool is exhausted. See Incident 6 in [[19-Interview-Preparation/Production-Incidents-Debugging]] and Lab 6 in [[20-Exercises-and-Labs/Debugging-Labs]].


**Tip — Production: catch N+1 in CI with a SQLAlchemy event listener, not in code review**

The four bugs above are caught late because they surface at runtime, not at commit. The production habit: register a `before_execute` event listener in your test fixtures that counts queries per request and fails the test if a single handler issues more than N queries (say, 10). This catches N+1 the moment it is introduced, not when a customer reports a slow dashboard. Pair with OpenTelemetry's DB instrumentation (`sqlalchemy-otel`) so the same signal is visible in production traces — the query count per HTTP route is the cheapest SLO you can ship. See [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]] for the listener implementation and Lab 1 in [[20-Exercises-and-Labs/Debugging-Labs]].


## Cross-references

- [[22-Diagrams/Request-Lifecycle-Diagram]] — where this session fits in the request lifecycle (steps 9, 11, 13).
- [[22-Diagrams/Deployment-Topology]] — where the engine and pool live.
- [[07-SQLAlchemy/05-Session-and-Transaction-Management]] — canonical lesson.
- [[07-SQLAlchemy/02-Engines-Connections-Pools]] — engine and pool details.
- [[07-SQLAlchemy/07-Async-SQLAlchemy]] — async variant.
- [[19-Interview-Preparation/SQLAlchemy-Sessions-Questions]] — interview questions for this diagram (Q5 identity map, Q6 autoflush, Q7 flush vs commit, Q11 detached, Q12 MissingGreenlet, Q13 transaction boundaries).

## Verification

Verify the Mermaid block renders without parse errors:

```bash
npm install -g @mermaid-js/mermaid-cli   # one-time
mmdc -i 22-Diagrams/SQLAlchemy-Session-Flow.md -o /tmp/session-flow.svg -t default
# Expected: 'mermaid Render successful: /tmp/session-flow.svg' (exit code 0).
# If you see 'Parse error on line N: ...', the diagram block has a syntax bug
# (commonly an unquoted colon in a participant label) — see [[00-Diagrams-MOC]].
```

To verify your mental model of the eight phases, narrate the diagram against a timer and check each phase has a one-sentence "what changes":

```bash
uv run python -c "
import time
t0 = time.time()
input('Draw and narrate the session lifecycle. Press Enter when done. ')
print(f'elapsed: {time.time()-t0:.1f}s')
"
# Expected: under 4 minutes for a senior-level narration of all 8 phases:
# 1. sessionmaker config; 2. open session; 3. add; 4. autoflush before query;
# 5. commit; 6. expiration; 7. close + detach; 8. (async) connection lifecycle.
# If you forget phase 6 (object expiration) or phase 7 (detachment), you have
# not internalised the two phases that produce the most production bugs
# (Incident 3 — MissingGreenlet; Lab 3 — DetachedInstanceError).
```

If `mmdc` reports zero parse errors and your narration completes in under 4 minutes covering all 8 phases (with the two "surprising" phases — expiration and detachment — named explicitly), you have internalised the diagram.

## Sources

- SQLAlchemy 2.x documentation — https://docs.sqlalchemy.org/en/20/orm/session.html — 2026-10-15 — session state machine, identity map, autoflush, expiration.
- SQLAlchemy 2.x documentation — https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html — 2026-10-15 — `AsyncSession` differences.
- Verified version: SQLAlchemy 2.1.5 — per [[21-Reference-Library/Source-Register]].

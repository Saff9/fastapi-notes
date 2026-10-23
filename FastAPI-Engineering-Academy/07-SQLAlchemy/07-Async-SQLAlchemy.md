---
title: "Lesson 07: Async SQLAlchemy"
aliases:
 - Async SQLAlchemy
 - create_async_engine
 - AsyncSession
 - async_sessionmaker
 - MissingGreenlet
tags:
 - sqlalchemy
 - orm
 - async
 - asyncio
 - lesson
course_level: intermediate
status: complete
difficulty: advanced
estimated_time: "120–150 minutes"
prerequisites:
 - "[[01-Foundations-and-Architecture]]"
 - "[[02-Engines-Connections-Pools]]"
 - "[[03-Declarative-Base-and-Mapped]]"
 - "[[04-Relationships-and-Loading-Strategies]]"
 - "[[05-Session-and-Transaction-Management]]"
 - "[[06-Querying-with-select]]"
 - "[[10-Async-Python/Event-Loop-and-Coroutines]]"
 - "[[03-FastAPI-Core/Application-and-Lifespan]]"
related_lessons:
 - "[[05-Session-and-Transaction-Management]]"
 - "[[06-Querying-with-select]]"
 - "[[03-FastAPI-Core/Dependency-Injection]]"
 - "[[12-Testing-and-Quality/Async-Testing]]"
---

# Lesson 07: Async SQLAlchemy

*`create_async_engine`, `async_sessionmaker`, `AsyncSession`, async context managers, the `MissingGreenlet` trap, async transactions, the `get_db` FastAPI dependency, async test setup, and the honest answer to "does `async def` make my DB calls faster?" (no — it makes them concurrent, not faster).*

**You've reached the part where sync lessons pay off.**

Everything you learned in Lessons 02–06 is going to translate almost line-for-line — with three new failure modes that will hurt you in production if you skip sync and dive straight into async. The `MissingGreenlet` trap, the implicit-I/O trap, and the "I wrote `async def` so it must be fast" trap. Today we cover all three. Take your time. Read the tracebacks. **This is the lesson that production incidents are made of.**


#sqlalchemy #orm #async #asyncio

## Learning Objectives

By the end of this lesson you will be able to:

1. **Construct an async engine** with `create_async_engine(url)` and articulate what is async about it (driver, not SQLAlchemy).
2. **Build an `AsyncSession`** with `async_sessionmaker(engine)` and use it as an `async with` context manager.
3. **Await every DB operation** — `await session.execute(...)`, `await session.commit()`, `await session.refresh(...)`, `await session.get(...)`.
4. **Articulate the `MissingGreenlet` trap** — why lazy loading throws in async, and why the fix is eager loading (`selectinload`).
5. **Build the async `get_db` FastAPI dependency** using `async def` + `yield`.
6. **Configure the async connection pool** — `pool_size`, `max_overflow`, etc. work the same as sync, but `NullPool` is sometimes the right choice even for stateful services.
7. **Manage async transactions** — `await session.commit()`, `await session.rollback()`, savepoints work.
8. **Set up async tests** — `aiosqlite` or `asyncpg`, pytest-asyncio, and the per-test transaction rollback pattern.
9. **Choose sync vs async** based on your workload (CPU-bound vs I/O-bound) and driver availability, and explain why `async def` does not magically make blocking DB calls non-blocking.
10. **Wire the async engine into the FastAPI lifespan** (canonical: [[03-FastAPI-Core/Application-and-Lifespan]]) — create on startup, dispose on shutdown.

## Prerequisites

- **Lessons 02–06.** This lesson is a near-1:1 translation of the sync API. If you skipped sync and came straight here, you will be productive for a week and confused for a year (D-002). Go back and read Lessons 02–06 first.
- **Event loop and coroutines** — [[10-Async-Python/Event-Loop-and-Coroutines]]. You must understand `async def`, `await`, `async with`, and what "the event loop" is. If `await foo()` is just `foo()` with extra syntax to you, this lesson will hurt.
- **FastAPI lifespan** — [[03-FastAPI-Core/Application-and-Lifespan]]. The async engine is created in the lifespan.
- **FastAPI Dependency Injection** — [[03-FastAPI-Core/Dependency-Injection]]. The `get_db` yield dependency is the canonical pattern, but in async form (`async def get_db(): yield ...`).
- **About 2 hours of focused time.** This lesson has the highest conceptual density of any lesson in the section because async SQLAlchemy is full of footguns.

**The most common gap: thinking async SQLAlchemy is a separate ORM.**

It is not. The 2.x async API is a thin wrapper around the sync API. The same models work in both; the same `select()` works in both; the same relationship patterns work in both. The differences are: (a) the driver (`asyncpg` instead of `psycopg`); (b) the engine factory (`create_async_engine` instead of `create_engine`); (c) the session factory (`async_sessionmaker` instead of `sessionmaker`); (d) the await prefix on every DB call; (e) the lazy-loading trap.


**Student asks: I wrote `async def` everywhere — why is my service still slow?**

Because `async def` does not magically make blocking code non-blocking. If your handler calls a sync database driver, the sync call blocks the event loop for its full duration. The `async def` keyword only matters if you actually `await` non-blocking I/O. A 500ms blocking DB call inside an `async def` is still 500ms of blocked event loop — and during those 500ms, no other coroutine can run. The fix is to either use the async DB driver (`asyncpg` + `AsyncSession` + `await session.execute(...)`) or run the sync call in a threadpool (`asyncio.to_thread(...)`). Reading the keyword as "automatically fast" is the most expensive single misconception in async Python.


## The Problem

Your `Boardly` FastAPI service is async — `@app.get("/projects")` is `async def`, and your handlers `await` other services (Redis, an HTTP client, etc.). If you use sync SQLAlchemy inside an `async def` handler, the event loop blocks for the duration of every DB call. With 1000 concurrent requests and 50ms per query, the event loop is blocked for 50 seconds per second of wall-clock time. You have just serialized every request.

The async SQLAlchemy API solves this by suspending the coroutine during DB I/O instead of blocking the thread. While your request waits for the database, the event loop runs other coroutines. The total wall-clock time per request is the same; the concurrency (number of simultaneous requests you can serve) is much higher.

But there is a trap. The async API forbids implicit I/O — any DB call must be explicitly awaited. Lazy loading is implicit I/O (the ORM does not know you are about to read `p.owner.email`, so it does the SELECT on demand). In async, that SELECT cannot be awaited (you did not write `await`), so SQLAlchemy raises `MissingGreenlet`. The fix is to eager-load every relationship you intend to traverse — a habit you should have already formed in sync (Lesson 04), but that becomes mandatory in async.

## The Code

Here is the async version of `boardly/db.py` — the async engine, the async session factory, and the async `get_db` FastAPI dependency. We rename the sync versions to `db_sync.py` for backwards compatibility with Lessons 02–06; the new async module is `boardly/db.py`.

```python
# boardly/db.py (async version)
"""Boardly — async database engine, async session factory, async get_db.

Lesson 07: create_async_engine, async_sessionmaker, AsyncSession, the
MissingGreenlet trap, the async get_db FastAPI dependency.

The sync versions of these functions are kept in boardly/db_sync.py for
scripts and tests that prefer sync.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
 AsyncEngine,
 AsyncSession,
 async_sessionmaker,
 create_async_engine,
)
from sqlalchemy.pool import NullPool, QueuePool

from boardly.settings import get_settings


# ---------------------------------------------------------------------------
# Async engine + session factory (process-level singletons).
# ---------------------------------------------------------------------------
_settings = get_settings()
engine: AsyncEngine = create_async_engine(
 _settings.database_url, # e.g., postgresql+asyncpg://...
 echo=_settings.database_echo,
 poolclass=QueuePool,
 pool_size=5,
 max_overflow=10,
 pool_recycle=1800,
 pool_pre_ping=True,
)
AsyncSessionLocal = async_sessionmaker(
 bind=engine,
 expire_on_commit=False,
 autoflush=True,
 class_=AsyncSession,
)


# ---------------------------------------------------------------------------
# The async get_db FastAPI dependency.
# ---------------------------------------------------------------------------
async def get_db() -> AsyncIterator[AsyncSession]:
 """Async FastAPI dependency: yield a per-request AsyncSession.

 Usage:
 @router.get("/projects/{slug}")
 async def get_project(slug: str, db: AsyncSession = Depends(get_db)):
 stmt = select(Project).where(Project.slug == slug).options(
 selectinload(Project.owner), # eager-load to avoid MissingGreenlet
 )
 project = (await db.execute(stmt)).scalar_one_or_none()
 if project is None:
 raise HTTPException(404)
 return ProjectRead.model_validate(project)
 """
 async with AsyncSessionLocal() as session:
 try:
 yield session
 await session.commit()
 except Exception:
 await session.rollback()
 raise


# ---------------------------------------------------------------------------
# The async session_scope context manager (for scripts and background jobs).
# ---------------------------------------------------------------------------
async def session_scope() -> AsyncIterator[AsyncSession]:
 """Open an async session, commit on success, rollback on exception, close."""
 async with AsyncSessionLocal() as session:
 try:
 yield session
 await session.commit()
 except Exception:
 await session.rollback()
 raise


# ---------------------------------------------------------------------------
# Smoke test.
# ---------------------------------------------------------------------------
async def main() -> None:
 from sqlalchemy import text
 async with session_scope() as session:
 result = await session.execute(text("SELECT 1 AS one"))
 row = result.first()
 print(f"smoke_test: row = {row}")
 print(f"pool status after close: {engine.pool.status()}")
 await engine.dispose()


if __name__ == "__main__":
 asyncio.run(main())
```

That's 90 lines. Save it as `boardly/db.py` (renaming the sync version to `boardly/db_sync.py`). Run with `uv run python -m boardly.db` against an async SQLite URL (`sqlite+aiosqlite:///:memory:`).

## Line-by-Line Deep Dive

This is the heart of the lesson. Read it twice. The async API is the sync API with `await` — except where it is not.

### Lines 1–17: The module docstring and imports

```python
"""Boardly — async database engine, async session factory, async get_db.
..."""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
 AsyncEngine,
 AsyncSession,
 async_sessionmaker,
 create_async_engine,
)
from sqlalchemy.pool import NullPool, QueuePool

from boardly.settings import get_settings
```

**What it does:** Pulls in the async SQLAlchemy primitives from `sqlalchemy.ext.asyncio` and the standard-library types we need.

**Why each:**

- `asyncio` — for `asyncio.run(main())` at the bottom of the smoke test.
- `AsyncIterator` — the return type of `async def` functions that `yield`. (Not `Iterator` from Lesson 05 — that was the sync version.)
- `AsyncEngine` — the async engine class. The async equivalent of `Engine`.
- `AsyncSession` — the async session class. The async equivalent of `Session`.
- `async_sessionmaker` — the async equivalent of `sessionmaker`.
- `create_async_engine` — the async engine factory.
- `NullPool, QueuePool` — the same pool implementations as sync. The pool is sync at the wire level even in async engines — async SQLAlchemy wraps the pool in an async-friendly way.

**Tip — The async primitives live in `sqlalchemy.ext.asyncio`, not `sqlalchemy`.**

This is a historical artifact. Async support was added in 1.4 as an "extension"; in 2.x it is a first-class feature but kept the import path. The naming convention: `Async` prefix for classes (`AsyncEngine`, `AsyncSession`); `async_` prefix for factories (`async_sessionmaker`, `create_async_engine`).


### Lines 25–35: The async engine and session factory

```python
_settings = get_settings()
engine: AsyncEngine = create_async_engine(
 _settings.database_url, # e.g., postgresql+asyncpg://...
 echo=_settings.database_echo,
 poolclass=QueuePool,
 pool_size=5,
 max_overflow=10,
 pool_recycle=1800,
 pool_pre_ping=True,
)
AsyncSessionLocal = async_sessionmaker(
 bind=engine,
 expire_on_commit=False,
 autoflush=True,
 class_=AsyncSession,
)
```

**What it does:** Builds the async engine and the async session factory, both as module-level singletons.

**Why the kwargs are the same as sync:** The pool configuration is identical — `pool_size`, `max_overflow`, `pool_recycle`, `pool_pre_ping` mean the same thing in both APIs. The async API does not change the pool semantics; it just wraps the connection-checkout in an awaitable.

**Why `class_=AsyncSession`:** `async_sessionmaker` defaults to producing `AsyncSession` instances; the `class_=` is explicit for documentation. Use it if you subclass `AsyncSession` for custom behavior (e.g., to add audit logging).

**`async_sessionmaker` vs `sessionmaker(bind=engine, class_=AsyncSession)`**

They produce equivalent objects — both are factories for `AsyncSession`. `async_sessionmaker` is the 2.x idiomatic form; the `sessionmaker(..., class_=AsyncSession)` form is for code that needs to share a factory between sync and async. Use `async_sessionmaker` for new code.


**Danger — How an attacker thinks:**

The async engine's pool is a single-process, single-event-loop shared resource. An attacker who can hit any endpoint that issues a slow `await session.execute(...)` can pin every connection in the pool with `asyncio.gather`-shaped hostile input, and every other request — including unauthenticated health checks, if they share the pool — blocks behind `pool_timeout` seconds of `asyncio.sleep`. A single `GET /reports/quarterly?tenant=evilco` endpoint that runs `await session.execute(text("SELECT pg_sleep(30)"))` is enough: 10 concurrent hostile requests saturate the default `pool_size=5, max_overflow=5` pool, and the 11th request from a legitimate tenant waits 30 seconds. The async event loop does *not* save you — it yields to other coroutines, but those coroutines all need the same pool. Defended by (a) per-tenant `SET statement_timeout = '5s'` enforced at the Postgres role level so a hostile query cannot run for 30 seconds, (b) an `asyncio.Semaphore(2)` keyed by `tenant_id` in a FastAPI middleware so no tenant can hold more than 2 in-flight DB calls, (c) `pool_timeout=5` (not the default 30) so a saturated pool fails fast instead of piling up. See [[17-Advanced-Architecture/Multi-Tenancy]] + [[03-FastAPI-Core/Middleware-and-Request-Order]] for the per-tenant rate-limiting pattern.


### Lines 42–64: The async `get_db` FastAPI dependency

```python
async def get_db() -> AsyncIterator[AsyncSession]:
 """Async FastAPI dependency: yield a per-request AsyncSession.
 ..."""
 async with AsyncSessionLocal() as session:
 try:
 yield session
 await session.commit()
 except Exception:
 await session.rollback()
 raise
```

**What it does:** Same shape as Lesson 05's sync `get_session`, but `async def` and `async with`.

**Why each piece:**

- `async def get_db()` — defines an async generator. FastAPI's `Depends` supports async generators directly. When you write `db: AsyncSession = Depends(get_db)`, FastAPI calls `get_db()` to get the async generator, awaits `__anext__()` to advance to the yield, runs the handler, then awaits `__anext__()` again to resume after the yield.
- `async with AsyncSessionLocal() as session:` — opens an `AsyncSession`. The `async with` is the async context manager form. At block exit (whether by normal flow, return, or exception), the session is closed (the underlying connection is returned to the pool). It does NOT auto-commit or auto-rollback — that is what the explicit `try/except` below is for.
- `yield session` — pauses the coroutine. FastAPI receives the session and passes it to the handler.
- `await session.commit()` — runs after the handler returns. Commits the transaction. (Note the `await` — async commit is a coroutine.)
- `await session.rollback()` — runs if the handler raised. Rolls back the transaction.

**Warning — `async with AsyncSessionLocal()` does not auto-commit.**

The `async with` context manager on `AsyncSession` only closes the session and returns the connection — it does not commit or rollback the transaction. You must do that yourself. The pattern `async with session_factory() as session: try: yield; commit except: rollback` is the canonical async per-request lifecycle.


**Warning — When this breaks:**

The `await session.commit()` line in `get_db`'s finally block runs *after* the handler returns. For a normal JSON response this is fine — FastAPI has not yet sent the response body when the dependency cleanup runs, so the commit finalizes the transaction before the user sees the response. But for handlers that defer work to *after* the response — `BackgroundTasks` that try to use the session, or `StreamingResponse` whose generator function uses `await db.stream(...)` lazily — the dependency cleanup runs at the wrong time: the session is closed before the deferred work can use it, and the deferred work raises `MissingGreenlet` (the ORM tries to lazy-load on a closed session) or `InvalidRequestError: This session is closed`. The fix is: for streaming and background-task endpoints, do NOT use `get_db`; open the session inside the handler, commit *before* returning the `StreamingResponse`, and pass any data the background task needs as detached (already-loaded) objects. Verify with `uv run pytest tests/test_streaming_response_commit.py -v` asserting the streaming endpoint returns 200 with a complete body. See [[03-FastAPI-Core/Background-Tasks-Streaming-Uploads]] + [[03-FastAPI-Core/Middleware-and-Request-Order]] for the response-lifecycle ordering rules.


### Lines 71–80: The async `session_scope` for scripts and jobs

```python
async def session_scope() -> AsyncIterator[AsyncSession]:
 """Open an async session, commit on success, rollback on exception, close."""
 async with AsyncSessionLocal() as session:
 try:
 yield session
 await session.commit()
 except Exception:
 await session.rollback()
 raise
```

Same as `get_db`, but as a context manager for use outside FastAPI:

```python
async with session_scope() as session:
 session.add(project)
 # exit: commit on success, rollback on exception
```

### Lines 86–92: The smoke test

```python
async def main() -> None:
 from sqlalchemy import text
 async with session_scope() as session:
 result = await session.execute(text("SELECT 1 AS one"))
 row = result.first()
 print(f"smoke_test: row = {row}")
 print(f"pool status after close: {engine.pool.status()}")
 await engine.dispose()
```

**What it does:** Same as the sync smoke test, but every DB call is awaited.

**Why `await engine.dispose()`:** The async engine's `dispose()` is a coroutine — it has to close connections, and closing a connection on an async driver is an async operation. Without `await`, the coroutine is created but never scheduled, and the engine does not actually dispose (you get a `RuntimeWarning: coroutine 'AsyncEngine.dispose' was never awaited`).

## Execution Trace

The code you've read so far is the static surface. Now run it. The trace below stitches every later section of this lesson — the `MissingGreenlet` trap, the blocking-call misconception, async pool config, async transaction management — into one request lifecycle on the event loop. Read this before you read those sections; they each drill into a single stage of what you are about to see.

### The async request, end to end

A `GET /projects/{slug}` endpoint returns a project with its tasks. A real request lands. The async dependency yields an `AsyncSession`. The service calls `await session.execute(select(...))`. The async driver sends SQL. The event loop yields to *other* coroutines while waiting for the database. The database returns rows. The service accesses `project.tasks` — and here is where the road forks: if `tasks` is configured `lazy="select"`, the access raises `MissingGreenlet` (because lazy load is sync I/O on the event loop); if the query had `selectinload(Project.tasks)`, the relationship was already loaded eagerly and no extra I/O fires. The service calls `await session.commit()` (or just `session.close()` for read-only). The response is sent. The dependency closes the `AsyncSession`.

```mermaid
sequenceDiagram
    participant Client
    participant App as FastAPI/your-app (event loop)
    participant Dep as get_async_session() dependency
    participant Sess as AsyncSession
    participant Ev as Event loop (other coroutines)
    participant DB as Database (asyncpg)

    Client->>App: GET /projects/q4-launch
    App->>Dep: resolve dependency
    Dep->>Sess: new AsyncSession(connection from async pool)
    Dep-->>App: yield session

    App->>Sess: await session.execute(select(Project).where(slug=...))
    Sess->>DB: send SELECT * FROM projects WHERE slug=$1
    Note over Sess,Ev: await suspends the coroutine, control returns to the loop
    Ev->>Ev: other coroutines run (other requests, timers, etc.)
    DB-->>Sess: rows ready — loop wakes this coroutine
    Sess->>Sess: identity map lookup, instantiate Project
    Sess-->>App: Project instance

    App->>Sess: service accesses project.tasks
    alt tasks relationship is lazy (default)
        Note over Sess: ORM tries to issue SELECT lazily<br/>no await context available at attribute access
        Sess-->>App: raise MissingGreenlet
        App-->>Client: 500 Internal Server Error
    else tasks relationship is selectinload (eager)
        Note over Sess: tasks already materialized at step 4
        Sess-->>App: list[Task] (no I/O)
    end

    App->>Sess: await session.close() (read-only, no commit)
    Sess->>DB: implicit ROLLBACK on close — release async connection to pool
    App-->>Client: 200 JSON
    App->>Dep: dependency finally block
    Dep->>Sess: session.close() (idempotent)

```

### Step-by-step prose

1. **Request arrives.** A `GET /projects/q4-launch` hits FastAPI. FastAPI resolves the route, parses the path parameter, and resolves dependencies. The handler depends on an `AsyncSession`. Control passes to the async dependency.
2. **Async dependency yields the session.** The dependency opens a fresh `AsyncSession` wrapping a connection checked out from the async engine's pool (`AsyncAdaptedQueuePool`, the async analogue of `QueuePool` — see `[[07-SQLAlchemy/02-Engines-Connections-Pools]]`). The session begins an implicit transaction; the actual `BEGIN` is sent lazily on the first statement. The dependency `yield`s the session to the handler. The `finally` block after `yield` will run `await session.close()` no matter what — even on an unhandled exception. (Recall `lifespan`'s `try/finally` pattern from `[[03-FastAPI-Core/Application-and-Lifespan]]`; same shape, request-scoped.)
3. **Service calls `await session.execute(select(...))`.** The service runs `stmt = select(Project).where(Project.slug == "q4-launch"); project = (await session.execute(stmt)).scalar_one()`. The session compiles the `select` into a SQL string, asks the async connection to send it via `asyncpg`, and then — crucially — `await`s the result.
4. **Event loop yields to other coroutines.** While `asyncpg` waits for the database to respond, the coroutine is suspended. The event loop is now free to run *other* coroutines — other incoming HTTP requests, periodic jobs, anything that was scheduled. This is the entire point of async SQLAlchemy: while one request is blocked on the database, ten other requests can be served from the same worker process. In sync SQLAlchemy, the worker thread is *blocked* for the duration of the round-trip; with one process per worker, you scale by adding processes. With async, you scale by adding coroutines.
5. **Database returns rows; loop wakes the coroutine.** The async driver delivers the rows via a socket-ready callback. The event loop resumes the suspended coroutine. The session receives the rows, consults the identity map, instantiates a `Project` (or returns an existing instance if the same primary key was already loaded this session), and returns it to the service.
6. **Service accesses `project.tasks` — the fork.** This is the heart of the `MissingGreenlet` trap. If the `tasks` relationship is configured with the default `lazy="select"` loader, the ORM detects that `tasks` is not loaded and tries to issue a `SELECT` to fetch it. But this is an `AsyncSession` — the SELECT would need to be `await`ed, and Python attribute access (`project.tasks`) is a synchronous operation with no `await` syntax. SQLAlchemy refuses to silently threadpool-offload the lazy load (that would re-introduce the implicit-I/O trap async was supposed to fix), so it raises `MissingGreenlet`. If, instead, the original query had `.options(selectinload(Project.tasks))`, the tasks were fetched eagerly at step 5 (in a second `SELECT ... WHERE project_id IN (...)` sent on the same connection), and the in-memory `project.tasks` attribute is already populated. Step 6 is then a pure dict lookup — no SQL, no `await`, no `MissingGreenlet`.
7. **Service calls `await session.commit()` (or just `session.close()` for read-only).** For a mutating endpoint, `commit()` flushes pending state and sends `COMMIT` on the async connection. For a read-only endpoint, the session is closed without committing — the implicit transaction is rolled back. (Read-only rollback is fine; it releases the transaction's locks and snapshots.)
8. **Response returned.** The service builds the response dict; FastAPI serializes it to JSON and sends it on the wire. The client receives a `200 OK`.
9. **Dependency's `finally` closes the `AsyncSession`.** `await session.close()` releases the async connection back to the pool and discards identity-map state. The connection waits in the pool for the next request.

**Step 4 is the *only* place the event loop yields.**

Many newcomers believe the entire request is somehow "async" — that every line of the handler is non-blocking. It isn't. The coroutine yields only at `await` points: the `await session.execute(...)`, the `await session.commit()`, the `await session.close()`. Between those points, the coroutine runs synchronously on the event loop. If you write `await session.execute(select(...)); time.sleep(5)`, the event loop is blocked for the full five seconds. Async requires you to `await` every I/O call — that is the contract.


**Spot the bug — what happens if the service forgets `.options(selectinload(...))` and accesses `project.tasks`?**

Step 6 fires the `MissingGreenlet` trap. The handler raises a 500. The test suite may not catch this if every test happens to construct projects that already have tasks in the identity map; the bug surfaces only in production, the first time a real request traverses the relationship. The fix is to add `selectinload(Project.tasks)` to the original query in step 3. We drill into the trap and its silent-in-tests-loud-in-prod character in `## The MissingGreenlet Trap` below.


**Warning — Step 4 is where you must hold the connection.**

A common bug: the service stores `project = (await session.execute(...)).scalar_one()` on the request scope, returns a JSON response, then a *background task* tries to access `project.tasks` after the session is closed in step 9. Because the session is closed, the lazy load can't fire — and even if it could, you're back in `MissingGreenlet` territory (the background task is async, attribute access is sync). Eager-load any relationship a background task will traverse, *before* the request's session closes.


**Tip — Watch the event loop yield with `asyncio` debug mode.**

Run Uvicorn with `PYTHONASYNCIODEBUG=1` set. The event loop will log every `await` suspension and resumption. You'll see, for a single request, exactly the suspensions described in step 4. If you see *extra* suspensions inside what should be a single SQL call, you have implicit I/O somewhere (often a lazy load you forgot to eager-load).


**The async session is the request — and the event loop is the process.**

Six participants, nine steps, one coroutine per request, one event loop per worker. The rest of this lesson is a deep dive into one of those steps: `MissingGreenlet` (step 6, lazy path), the blocking-call misconception (steps 3–5 if you accidentally use sync SQLAlchemy), async pool config (step 2), async transaction management (step 7). Use the trace above as your index.


## The `MissingGreenlet` Trap

This is the single most common async SQLAlchemy bug. Trigger it on purpose:

```python
async with session_scope() as session:
 # Load a project — note: no eager load on owner
 stmt = select(Project).where(Project.slug == "q4-launch")
 project = (await session.execute(stmt)).scalar_one()

 # Access owner — this triggers a lazy SELECT
 print(project.owner.email) # ← MissingGreenlet!
```

The traceback ends with:

```
sqlalchemy.exc.MissingGreenlet: greenlet_spawn has not been called; can't call
__await__() on an awaitable here. This is because the work is being performed
in a synchronous context, where greenlets are not able to be used to delegate
to the asyncio event loop.
```

**What happened:** When you accessed `project.owner`, the ORM saw that `owner` was not loaded and tried to issue a `SELECT` to fetch it. But this is an async session — the SELECT must be awaited. The ORM has no way to inject an `await` at the attribute-access site (Python does not support that), so it raises `MissingGreenlet`.

Why can't SQLAlchemy just `await` the SELECT for you at the attribute-access site? Because Python attribute access (`project.owner`) is a synchronous operation — there is no `await` syntax for it. The grammar does not allow `print(await project.owner.email)`. The only ways to make lazy loading work in an async context are: (a) run the lazy SELECT on a separate thread (which SQLAlchemy 1.x did via greenlet, but the strategy breaks down when the calling code is itself on the event loop), or (b) forbid lazy loading in async entirely and require eager loading. SQLAlchemy 2.x chose (b) for the async API because it is the only safe default — the alternative (silent thread-pool offload of every attribute access) would re-introduce the implicit-I/O trap that async was supposed to eliminate. So `MissingGreenlet` is not a bug to fix; it is the API enforcing the contract that async code must be explicit about every I/O.

**What "greenlet" means here.**

`greenlet` is a Python library for lightweight coroutines (predates `asyncio`). SQLAlchemy uses greenlets internally to bridge the sync API (which `relationship()` was designed for) and the async API. The `MissingGreenlet` error means: the ORM tried to run sync code that needed to await an async I/O operation, but there was no greenlet context to delegate to the event loop. The fix is to make the I/O explicit by eager-loading.


**Student asks: should I default every `relationship()` to `lazy="selectinload"` to never see this error?**

Tempting — and on small services it is a defensible choice. But blanket `lazy="selectinload"` is the async equivalent of the sync "load all relationships eagerly by default" footgun: every `select(Project)` becomes a `SELECT FROM projects` plus an `IN (...)` against `tasks`, `comments`, `memberships`, whether or not the caller wanted those columns. On a list endpoint that returns 50 projects and only their `name` and `slug`, you have just tripled the query cost. The right default is `lazy="raise"` (or `lazy="raise_on_sql`), which makes `MissingGreenlet` an explicit-statement error rather than an implicit-lazy error — you write `select(Project).options(selectinload(Project.tasks))` at the call site that needs the tasks, and you do not pay for them at call sites that do not. Reserve `lazy="selectinload"` for relationships that *every* caller of the model needs (the `Organization` of a `Project`, for example, where every endpoint that returns a project also returns the org name).


**Production reality:**

The `MissingGreenlet` trap is asymmetric: silent in dev, loud in prod. The asymmetry comes from the identity map. A test that does `await session.merge(existing_project)` followed by `project.owner.email` works — `merge` populates the identity map, `project.owner` is already there, no SELECT fires, no `MissingGreenlet`. The same code in production, against a fresh session, has nothing in the identity map and raises. A test suite with high coverage that always constructs related entities in fixtures can pass 100% in CI and raise `MissingGreenlet` on the first real request. Defended by setting `lazy="raise"` (or `lazy="raise_on_sql"`) on every `relationship()` in `boardly/models.py` so the trap surfaces as a hard error in tests too, not just in prod — the error message tells you the exact file:line of the missing `selectinload`. Pay the cost once (fix every test to add the explicit `selectinload`) and the trap is permanently closed. See [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]] + [[12-Testing-and-Quality/Testing-Database-Logic]] for the loading-strategy contract.


**The fix:** Eager-load every relationship you intend to traverse.

```python
stmt = (
 select(Project)
 .where(Project.slug == "q4-launch")
 .options(selectinload(Project.owner)) # ← eager-load
)
project = (await session.execute(stmt)).scalar_one()
print(project.owner.email) # works — owner was loaded with the project
```

With `selectinload(Project.owner)`, the project and its owner are fetched in two queries (the project query, then a `SELECT ... WHERE users.id IN (...)` for the owner). Subsequent access to `project.owner` is a pure in-memory attribute lookup — no SELECT, no `MissingGreenlet`.

```mermaid
sequenceDiagram
 participant H as Async handler
 participant S as AsyncSession
 participant DB as Database

 H->>S: await db.execute(select(Project).options(selectinload(owner)))
 S->>DB: SELECT * FROM projects
 DB-->>S: rows
 S->>DB: SELECT * FROM users WHERE id IN (...)
 DB-->>S: rows
 S-->>H: project instance (owner loaded)

 Note over H: project.owner.email — no SELECT, no MissingGreenlet

 H->>S: await db.execute(select(Project)) # no selectinload
 S->>DB: SELECT * FROM projects
 DB-->>S: rows
 S-->>H: project instance (owner NOT loaded)

 H->>S: project.owner.email # lazy load attempted
 Note over S: ORM tries to issue SELECT<br/>no await context available
 S-->>H: MissingGreenlet

```

The takeaway: **in async, you cannot rely on lazy loading. You must eager-load every relationship you will traverse.** This is a habit you should have formed in sync (Lesson 04), but in sync it is a performance optimization; in async, it is mandatory.

**Danger — The `MissingGreenlet` trap is silent in tests, loud in production.**

A test that exercises one code path will not trigger the trap (the relationship was eager-loaded somewhere along the way). A different code path in production will. The trap is asymmetric: it does not bite in dev, it bites in prod. Eager-load religiously; do not wait for `MissingGreenlet` to find you.


## Why `async def` Does Not Magically Make Blocking DB Calls Non-Blocking

This is the most common misconception about async SQLAlchemy. Settle it.

**The misconception:** "If I write `async def get_project(slug)` and inside it I call `sync_session.execute(...)`, the call is non-blocking because I am in an async function."

**The reality:** The `async def` keyword does not magically make sync I/O non-blocking. If you call `sync_session.execute(...)` inside an `async def`, the sync session blocks the event loop for the duration of the call. While the event loop is blocked, no other coroutine can run. You have effectively serialized every request.

```python
# WRONG — blocks the event loop
async def get_project(slug: str) -> Project:
 sync_session = SessionLocal() # sync session
 stmt = select(Project).where(Project.slug == slug)
 project = sync_session.execute(stmt).scalar_one_or_none() # BLOCKS the event loop
 sync_session.close()
 return project
```

**The fix:** Either (a) use the async API (`AsyncSession` + `await`), or (b) if you must use sync, run the call in a threadpool:

```python
# (b) — sync SQLAlchemy, offloaded to a threadpool
async def get_project(slug: str) -> Project:
 def _blocking_work():
 sync_session = SessionLocal()
 try:
 stmt = select(Project).where(Project.slug == slug)
 return sync_session.execute(stmt).scalar_one_or_none()
 finally:
 sync_session.close()
 return await asyncio.to_thread(_blocking_work)
```

`asyncio.to_thread(...)` runs the blocking function in a worker thread, freeing the event loop. While the thread is blocked on the database, the event loop runs other coroutines. The total latency per request is the same as sync; the concurrency is higher.

**The trade-off:** `asyncio.to_thread` has overhead (thread creation, context switching). For a service that is 95% database I/O, the async-native API (`AsyncSession` + `asyncpg`) is faster than sync + `to_thread`. For a service that has a small amount of legacy sync code in an otherwise-async app, `to_thread` is a reasonable bridge.

**The decision matrix.**

- **All-async workload, async driver available:** use async SQLAlchemy. End-to-end non-blocking.
- **Mostly-async workload, no async driver for some library:** use async SQLAlchemy for the DB, `to_thread` for the legacy library.
- **Mostly-sync workload, sync driver available:** use sync SQLAlchemy. Run your FastAPI handlers as `def` (not `async def`) — FastAPI runs them in a threadpool automatically.

Never mix sync and async SQLAlchemy in the same request — different drivers, different pools, different protocols. Pick one.


**Warning — When this breaks:**

A sync `Session.execute(...)` call inside an `async def` handler blocks the event loop for the full duration of the query — but the trace does not show it. The `await` keyword you forgot to write is invisible; the only signal is that p99 latency for the endpoint is the query time, and other endpoints' p99 latency tracks it (because they share the event loop and queue behind the blocked call). On-call sees "everything is slow" with no clear culprit. Defended by running Uvicorn with `PYTHONASYNCIODEBUG=1` and `loop.set_debug(True)`, which logs a `Executing <...> took Xms` warning for any callback that exceeds `loop.slow_callback_duration` (default 100ms). Set the threshold to 50ms in staging, ship the offender list to OpenTelemetry, and treat every hit as a P1 — a sync DB call in an async handler is an event-loop block, not a slow query. See [[10-Async-Python/Event-Loop-and-Coroutines]] + [[13-Performance-and-Observability/OpenTelemetry-Tracing]] for the event-loop-block hunting workflow.


## Async Connection Pool Configuration

The pool kwargs (`pool_size`, `max_overflow`, `pool_timeout`, `pool_recycle`, `pool_pre_ping`, `poolclass`) are identical to the sync API. The pool itself is sync — it just holds `asyncio`-compatible connections. The one nuance: in async, `pool_pre_ping` is a coroutine-based ping, but the semantics are the same.

**`NullPool` is sometimes right for async stateful services.**

A subtle gotcha: `asyncpg` (the async Postgres driver) maintains its own prepared-statement cache. If SQLAlchemy's `QueuePool` keeps a connection warm but `asyncpg`'s internal cache becomes stale (e.g., the database restarted), you can get `asyncpg.exceptions.InvalidStatementDefinitionError`. The fix is either `pool_recycle=300` (more aggressive) or `NullPool` (no caching). For most services, `QueuePool` with `pool_recycle=300` is fine; if you see prepared-statement errors, consider `NullPool`.


**Student asks: does the async pool need a lock like the sync one?**

No — the sync `QueuePool` guards its connection list with a `threading.Lock`. The async `QueuePool` is the *same* pool object, but the connections it holds (`asyncpg` connections, `aiosqlite` connections) are awaited, not thread-locked. The event loop is single-threaded, so there is no concurrent access to the pool's internal state — every `await engine.connect()` is serialized by the loop itself. The catch: if a sync helper thread (started via `asyncio.to_thread(...)` for a blocking call) touches the *async* engine's pool, you have a real bug. Use a separate sync engine for sync helpers; do not share the pool across the event-loop thread and helper threads.


**Production reality:**

`asyncpg` (the async Postgres driver) maintains its own prepared-statement cache, keyed by the SQL text. When Postgres fails over (RDS Multi-AZ, Aurora reader promotion, a manual restart), the new primary has no record of the prepared statements the old primary cached — the next `await session.execute(...)` raises `asyncpg.exceptions.InvalidStatementDefinitionError: cached plan ... does not exist`. The error is unrecoverable on the existing connection; the only fix is to close the connection and open a new one. SQLAlchemy's `pool_pre_ping` does NOT catch this — the ping (`SELECT 1`) does not use the cached prepared statement, so the ping succeeds and the pool hands out a doomed connection. Defended by setting `pool_recycle=300` (5 minutes) so stale connections are proactively cycled, and — for services that experience frequent failovers — setting `asyncpg`'s `statement_cache_size=0` (disable the cache, accept the ~5% per-query overhead of re-preparing on every call) OR switching to `NullPool` so every check-out is a fresh connection with a fresh cache. Verify with a chaos test that kills the Postgres backend mid-transaction and asserts the next query recovers within `pool_recycle` seconds. See [[08-PostgreSQL/Backups-and-Recovery]] + [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]] for the failover-chaos-test pattern.


## Async Transaction Management

The async API mirrors the sync API:

```python
async with AsyncSessionLocal() as session:
 session.add(project)
 await session.flush() # writes the INSERT within the transaction
 await session.commit() # flushes + commits
 # ... or:
 await session.rollback() # aborts the transaction
```

Nested transactions and savepoints also work:

```python
async with AsyncSessionLocal() as session:
 async with session.begin(): # auto-commit on success, auto-rollback on exception
 session.add(org)
 await session.flush()
 try:
 async with session.begin_nested(): # SAVEPOINT
 session.add(membership)
 await session.flush() # might raise IntegrityError
 except IntegrityError:
 pass # savepoint rolled back; org is still in the transaction
```

The `async with session.begin()` form auto-commits on success and auto-rolls-back on exception. Useful when you want transactional semantics without writing the try/except yourself.

**Spot the bug — what happens if you forget `await` on `session.commit()` inside `async with session.begin()`?**

Two layers of the trap. (1) `session.commit()` returns a coroutine; if you do not `await` it, the coroutine is never scheduled and the commit never reaches the database. (2) When the `async with session.begin():` block exits, the context manager calls `await session.commit()` *itself* as the success path — but since your commit coroutine was never awaited, it surfaces as a `RuntimeWarning: coroutine 'AsyncSession.commit' was never awaited` *and* the context manager's commit still fires, so the data *does* land. Net effect: silent double-commit intent, lost `RETURNING` results, and a `RuntimeWarning` you ignored in tests. The fix: never call `session.commit()` yourself inside `async with session.begin():` — let the context manager own the commit, and only call `await session.commit()` if you are managing the transaction manually.


## Wiring the Async Engine into the FastAPI Lifespan

The engine is created at process start and disposed at process end. The canonical place is the FastAPI lifespan (covered in [[03-FastAPI-Core/Application-and-Lifespan]]):

```python
# boardly/main.py
from contextlib import asynccontextmanager
from fastapi import FastAPI

from boardly.db import AsyncSessionLocal, engine

@asynccontextmanager
async def lifespan(app: FastAPI):
 # startup
 app.state.engine = engine
 app.state.AsyncSessionLocal = AsyncSessionLocal
 yield
 # shutdown
 await app.state.engine.dispose()

app = FastAPI(lifespan=lifespan)
```

Note: in our `boardly/db.py`, the engine is a module-level singleton. The lifespan still disposes it on shutdown. (If you prefer to create the engine inside the lifespan, that is also valid — the difference is module-level singletons are easier to import from anywhere; lifespan-scoped engines are easier to test in isolation.)

**Why this section comes before the test setup:** the lifespan is the production wiring — the engine lives for the process, the session lives for the request. Tests mirror that production wiring. A learner who reads the test fixture before reading the lifespan wiring tends to think the test *is* the production setup; in fact, the test scaffolding is a faithful mirror of `lifespan`'s `try/finally`, scoped to a single test instead of a single process. Read this section first; read the test section as a derivative.

## Async Test Setup

Tests should run against the same database as production. For `Boardly`, that means async tests against an async database (typically `aiosqlite` for unit tests, `asyncpg` against a test Postgres for integration tests).

The minimum setup:

```python
# tests/conftest.py
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from boardly.models import Base

@pytest_asyncio.fixture
async def db_session():
 engine = create_async_engine("sqlite+aiosqlite:///:memory:")
 async with engine.begin() as conn:
 await conn.run_sync(Base.metadata.create_all)
 SessionLocal = async_sessionmaker(engine, expire_on_commit=False)
 async with SessionLocal() as session:
 yield session
 # at exit: rollback any uncommitted changes (test isolation)
 await session.rollback()
 async with engine.begin() as conn:
 await conn.run_sync(Base.metadata.drop_all)
 await engine.dispose()
```

**Why `conn.run_sync(Base.metadata.create_all)`:** `create_all` is a sync operation (it iterates over `Base.metadata.tables` synchronously). In an async context, you cannot call sync methods on an async connection directly. `run_sync(...)` runs the sync function in a thread and awaits its completion.

The per-test pattern: open a session in a transaction, run the test, roll back the transaction. This guarantees test isolation — no test sees another test's writes, and the database state is fresh for each test. We cover this in depth in [[12-Testing-and-Quality/Testing-Database-Logic]].

**Warning — pytest-asyncio's `asyncio` mode.**

Set `asyncio_mode = "auto"` in your `pyproject.toml` so you do not have to mark every test with `@pytest.mark.asyncio`. We cover this in [[12-Testing-and-Quality/Async-Testing]].


**Danger — How an attacker thinks:**

The per-test rollback fixture (`async with SessionLocal() as session: yield session; await session.rollback()`) is the only line of defense against test-to-test data contamination. A bug in the fixture (an unhandled exception in the test that leaves the session in a broken state, a `pytest-asyncio` version bump that changes the fixture-finalizer ordering, a `conftest.py` that uses `asyncio_mode = "strict"` instead of `"auto"`) leaves the rollback unscheduled, the connection checked out, and the next test's `SessionLocal()` opens against the *same* in-memory `aiosqlite` database with the *previous* test's uncommitted rows still present. A test that inserts an admin user and fails to roll back hands the next test a pre-authenticated admin row — and the next test's authorization check passes when it should fail. The CI goes green; the prod auth bypass ships. Defended by (a) `asyncio_mode = "auto"` in `pyproject.toml` so every `async def test_...` is collected as an async test without an explicit marker, (b) a per-test `engine` fixture that calls `Base.metadata.drop_all` *and* `Base.metadata.create_all` at setup (not just at the conftest level) so the schema is fresh, (c) a CI step that asserts `engine.pool.status()` reports `checkedout=0` after every test (a leak detector in the fixture itself). See [[12-Testing-and-Quality/Async-Testing]] + [[12-Testing-and-Quality/CI-Pipelines]] for the test-isolation contract.


## Common Mistakes

### Mistake 1: Forgetting to `await` an async DB call

```python
# WRONG
async def get_project(slug):
 project = session.execute(stmt).scalar_one_or_none() # MISSING AWAIT
 # session.execute is a coroutine that was never awaited
 return project
```

**Symptom:** `RuntimeWarning: coroutine 'AsyncSession.execute' was never awaited` and `project` is a coroutine object, not a `Project`.

**Why:** `async_session.execute()` returns a coroutine. Calling it without `await` creates the coroutine but never schedules it.

**Fix:** `project = (await session.execute(stmt)).scalar_one_or_none()`.

### Mistake 2: Lazy loading in async (`MissingGreenlet`)

```python
# WRONG
project = (await session.execute(select(Project))).scalar_one()
print(project.owner.email) # MissingGreenlet
```

**Symptom:** `sqlalchemy.exc.MissingGreenlet` traceback.

**Why:** Lazy loading requires a SELECT, which is I/O, which is forbidden in async without explicit `await`. The ORM has no way to inject the await at the attribute-access site.

**Fix:** Eager-load with `selectinload`, `joinedload`, or `subqueryload`.

### Mistake 3: Mixing sync and async sessions in the same request

```python
# WRONG
async def handler():
 async with AsyncSessionLocal() as session:
 ...
 sync_session = SessionLocal() # different driver, different pool
 sync_session.execute(...) # different wire protocol
```

**Symptom:** `InterfaceError`, connection leaks, or mysterious cross-protocol errors.

**Why:** Sync and async drivers speak different wire protocols. The sync engine's pool cannot be safely accessed from an async context, and vice versa.

**Fix:** Pick one. Use async end-to-end for FastAPI services.

### Mistake 4: Using the sync engine's connection from an async context

```python
# WRONG
async def handler():
 with sync_engine.connect() as conn: # SYNC connection in ASYNC handler
 ...
```

**Symptom:** Blocks the event loop for the duration of every DB call. No error — just terrible performance.

**Why:** `sync_engine.connect()` returns a sync `Connection`. Calling `.execute()` on it blocks the calling thread. In an `async def` handler, the calling thread is the event loop's thread — blocking it blocks every other coroutine.

**Fix:** Use the async engine and `await conn.execute(...)`.

### Mistake 5: Forgetting `await engine.dispose()` on shutdown

```python
# WRONG
async def lifespan(app):
 yield
 engine.dispose() # MISSING AWAIT
```

**Symptom:** `RuntimeWarning: coroutine 'AsyncEngine.dispose' was never awaited` and connections not actually closed.

**Why:** `AsyncEngine.dispose()` is a coroutine.

**Fix:** `await engine.dispose()`.

### Mistake 6: Not using `selectinload` for relationships returned in responses

```python
# WRONG
@router.get("/projects/{slug}")
async def get_project(slug: str, db: AsyncSession = Depends(get_db)):
 project = (await db.execute(
 select(Project).where(Project.slug == slug)
 )).scalar_one_or_none()
 return {
 "name": project.name,
 "owner_email": project.owner.email, # MissingGreenlet!
 }
```

**Symptom:** `MissingGreenlet` traceback in production.

**Why:** `project.owner` is lazy-loaded.

**Fix:** Add `selectinload(Project.owner)`:

```python
@router.get("/projects/{slug}")
async def get_project(slug: str, db: AsyncSession = Depends(get_db)):
 project = (await db.execute(
 select(Project).where(Project.slug == slug).options(selectinload(Project.owner))
 )).scalar_one_or_none()
 return {
 "name": project.name,
 "owner_email": project.owner.email, # works
 }
```

## Engineering Trade-Offs

### Sync vs async: the decision matrix

| Workload | Driver | Recommendation |
|---|---|---|
| FastAPI service, I/O-bound, async driver available | `asyncpg` / `aiosqlite` | Async end-to-end. |
| FastAPI service, I/O-bound, no async driver | `psycopg` (sync) | Sync SQLAlchemy; FastAPI runs sync handlers in a threadpool. |
| FastAPI service, CPU-bound per request | n/a | Sync SQLAlchemy; the bottleneck is CPU, not DB. |
| Script or batch job | `psycopg` or `asyncpg` | Sync is simpler. Use async only if the job also does async I/O (e.g., HTTP client). |
| Lambda / Cloud Run | `psycopg` (sync) | Sync + `NullPool`. Async is awkward in serverless. |
| Test suite | match production | Async tests for async production; sync tests for sync production. |

**D-002 — Default to async SQLAlchemy in production, but teach sync first.**

This is the rationale from the MOC. Sync first because the failure modes are subtler in async; once you understand sync, async is a thin wrapper. Skipping sync and going straight to async is the most common cause of confusing production bugs.


### `AsyncSession` vs `Session` API surface

The async API mirrors the sync API, with these naming differences:

| Sync | Async |
|---|---|
| `create_engine(url)` | `create_async_engine(url)` |
| `sessionmaker(engine)` | `async_sessionmaker(engine)` |
| `Session` | `AsyncSession` |
| `session.execute(stmt)` | `await session.execute(stmt)` |
| `session.commit()` | `await session.commit()` |
| `session.rollback()` | `await session.rollback()` |
| `session.flush()` | `await session.flush()` |
| `session.get(Model, pk)` | `await session.get(Model, pk)` |
| `session.refresh(obj)` | `await session.refresh(obj)` |
| `session.begin_nested()` | `async with session.begin_nested()` (use as async context manager) |
| `engine.dispose()` | `await engine.dispose()` |

Everything else (models, `select()`, `where`, `join`, etc.) is shared.

## Exercises

**Tip — The 20-minute rule**

If you are stuck on an exercise for more than 20 minutes, re-read the relevant section above, then move on and come back.


**Exercise 1 — Run the smoke test.** Save `boardly/db.py` as the async version (move the sync version to `boardly/db_sync.py`). Install `aiosqlite`: `uv add aiosqlite`. Set `BOARDLY_DATABASE_URL=sqlite+aiosqlite:///:memory:` and run `uv run python -m boardly.db`. Confirm `smoke_test: row = (1,)`.

**Exercise 2 — Trigger `MissingGreenlet`.** In an async session, load a `Project` without `selectinload` and access `project.owner.email`. Confirm you get the `MissingGreenlet` traceback. Add `selectinload(Project.owner)` and confirm the error goes away.

**Exercise 3 — Wire into the lifespan.** Update `boardly/main.py` from [[03-FastAPI-Core/Application-and-Lifespan]] to create the async engine in the lifespan and dispose it on shutdown. Confirm `Boardly starting up…` and `Boardly shutting down…` still print.

**Exercise 4 — Time sync vs async.** Write a script that issues 100 sequential `SELECT 1` queries via sync SQLAlchemy, and 100 via async SQLAlchemy. Time both. The wall-clock time should be similar (async is not faster for sequential queries — it is faster for concurrent ones). Then issue 100 concurrent queries via async (using `asyncio.gather`) and confirm the wall-clock time is dramatically lower.

**Exercise 5 — Async tests.** Add `pytest-asyncio` (`uv add pytest-asyncio`). Write a test that uses the `db_session` fixture from the lesson. Run it. Confirm the test passes.

**Exercise 6 — `to_thread` bridge.** Write an async handler that calls a sync SQLAlchemy function via `asyncio.to_thread`. Confirm it works (no event-loop blocking). Note the overhead.

**Exercise 7 — Test pool recycling.** Set `pool_recycle=2`. Open a connection, sleep 5 seconds, then open another. Confirm the first connection was recycled (closed and reopened). Verify with `engine.pool.status()`.

**Exercise 8 — Async pool-saturation reproducer.** Configure `create_async_engine(url, pool_size=5, max_overflow=5, pool_timeout=1)`. Write a script that issues 100 concurrent `await session.execute(text("SELECT 1"))` calls via `asyncio.gather` against an `aiosqlite` engine. Verify with `uv run python -m boardly.tests.async_pool_saturation` that: (a) the wall-clock time is consistent with 100 calls queued through a 10-connection pool (not 100 parallel — the pool caps concurrency), (b) `engine.pool.status()` mid-flight reports `checkedout=10`, and (c) no `TimeoutError` is raised (the pool is at capacity but not over). Then bump the concurrency to 200 and verify the last 190 raise `TimeoutError` within 2 seconds.

**Exercise 9 — `MissingGreenlet` test-to-prod asymmetry audit.** Set `lazy="raise"` on every `relationship()` in `boardly/models.py`. Run the full test suite: `uv run pytest tests/ -v`. Verify that every `project.owner` access that lacks a `selectinload(Project.owner)` raises `sqlalchemy.exc.MissingGreenlet` and that the error message includes the file:line of the offending attribute access. Confirm that the same code with `lazy="select"` (the default) would pass the tests (because the in-memory identity map hides the lazy load) but would raise `MissingGreenlet` in production against a fresh session. Write one test that explicitly demonstrates the asymmetry: assert `lazy="select"` passes the test, then change to `lazy="raise"` and assert the same test now fails with `MissingGreenlet`. See [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]] for the loading-strategy contract.

**Exercise 10 — `asyncio.to_thread` bridge benchmark.** Write a benchmark that issues 1000 `SELECT 1` queries three ways against a real Postgres 17 (use `docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=boardly -e POSTGRES_DB=boardly postgres:17`): (a) sync `Session.execute(stmt)` in a plain `def` handler, (b) `await asyncio.to_thread(sync_session.execute, stmt)` from an `async def` handler, (c) `await async_session.execute(stmt)` from an `async def` handler. Verify with `uv run python -m boardly.tests.to_thread_bench` that the (c) form is fastest by at least 30% on asyncpg + Postgres 17, that the (b) form's per-call overhead is approximately 50 microseconds (vs ~5 microseconds for (c)), and that the (a) form is comparable to (c) on a single-threaded workload (because there is no concurrency to exploit). The benchmark pins the contract that `to_thread` is a bridge for legacy sync code, not a performance tool.

**Exercise 11 — Asyncpg prepared-statement desync recovery.** Start Postgres 17 in Docker. Open an `AsyncSession` against it with `create_async_engine("postgresql+asyncpg://boardly:boardly@localhost:5432/boardly")`. Run `await session.execute(text("SELECT 1"))` 100 times (the prepared statement is cached). From a parallel `psql` session, run `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle' AND query LIKE 'SELECT 1%'` to kill the backend. Verify with `uv run pytest tests/integration/test_asyncpg_prepared_desync.py -v` that the next `await session.execute(...)` raises `asyncpg.exceptions.InvalidStatementDefinitionError` (the prepared statement OID is invalid on the new backend). Then re-run with `create_async_engine(..., pool_recycle=2, pool_pre_ping=True)` and verify the next query recovers within 2 seconds (the pool recycles the stale connection). See [[08-PostgreSQL/Backups-and-Recovery]] for the failover-chaos-test pattern.

**Exercise 12 — Async connection-leak detector.** Write an async script that opens 30 `AsyncSession` instances via `AsyncSessionLocal()` in a loop WITHOUT closing them (no `async with`). After each, print `engine.pool.status()`. Verify with `uv run python -m boardly.tests.async_leak_detector` that: (a) `checkedout` grows by 1 each iteration, (b) the script prints `LEAK DETECTED: checkedout=N` when `checkedout` exceeds `pool_size + max_overflow` (default 15), and (c) the script exits non-zero. Then fix the leak by wrapping each `AsyncSessionLocal()` in an `async with` block and re-run — verify the script now exits 0 with `checkedout=0` throughout. See [[13-Performance-and-Observability/OpenTelemetry-Tracing]] for the production leak-detector that ships this script's logic as a metric.

**Exercise 13 — Async test isolation audit.** Write two `pytest-asyncio` tests against the same in-memory `aiosqlite` engine (`sqlite+aiosqlite:///:memory:`). Test A inserts a row and commits. Test B counts rows. With the per-test rollback fixture from the `## Async Test Setup` section, Test B should see 0 rows. Verify with `uv run pytest tests/test_async_isolation.py -v` that both tests pass and that running them in either order produces the same result (test isolation is intact). Then break isolation on purpose: replace the per-test fixture with a session-scoped one and re-run — verify Test B now sees Test A's rows when run in the order A, B. The exercise pins the contract that the per-test rollback fixture is the only thing standing between your tests and silent cross-contamination.

## Verification

Run the smoke test:

```bash
BOARDLY_DATABASE_URL=sqlite+aiosqlite:///:memory: uv run python -m boardly.db
```

Expected output (truncated):

```
2026-10-19 ... INFO sqlalchemy.engine.Engine BEGIN (implicit)
2026-10-19 ... INFO sqlalchemy.engine.Engine SELECT 1 AS one
2026-10-19 ... INFO sqlalchemy.engine.Engine COMMIT
smoke_test: row = (1,)
pool status after close: Pool size: 5 Connections in pool: 0 Free Overflow: 0 Current Overflow: 0 Queued: 0
```

If you see `smoke_test: row = (1,)` and a non-leaking pool status, you have successfully:

- Built an async engine with `create_async_engine`.
- Built an async session factory with `async_sessionmaker`.
- Used `async with` to open an `AsyncSession`.
- Awaited `session.execute()` and `session.commit()`.
- Disposed the async engine with `await engine.dispose()`.

## Previously Learned Here

- **Lesson 02 — Engines, Connections, Pools.** The async engine is the same engine with the same pool config; only the driver and the await prefix change.
- **Lesson 05 — Session and Transaction Management.** The async session mirrors the sync session, except every DB call is awaited. The `get_db` dependency is the async version of `get_session`.
- **Lesson 04 — Relationships and Loading Strategies.** Eager loading is a *performance* optimization in sync; it is *mandatory* in async (otherwise `MissingGreenlet`).
- **FastAPI lifespan** — [[03-FastAPI-Core/Application-and-Lifespan]]. The async engine is created in the lifespan; the same pattern applies.
- **Event loop and coroutines** — [[10-Async-Python/Event-Loop-and-Coroutines]]. `async def` and `await` are the primitives. If they are fuzzy, this lesson will hurt.
- **FastAPI Dependency Injection** — [[03-FastAPI-Core/Dependency-Injection]]. The `get_db` yield dependency is the canonical pattern; the async form uses `async def` and `async with`.

## What's Next

In [[08-Advanced-ORM]] we cover the ORM's power features: hybrid attributes, association proxies, custom types, events and hooks, optimistic concurrency, row locking, multi-tenant patterns, and the repository pattern. You will:

- Add a `hybrid_property` for "is_overdue" on `Task` that works in both Python and SQL.
- Add an association proxy for `member_names` on `Organization` (skip through `Membership` to `User`).
- Define a `TypeDecorator` for an encrypted column.
- Use `version_id` for optimistic concurrency.
- Use `with_for_update()` for pessimistic row locking.
- Forward to [[05-Project-Architecture/Service-and-Repository-Patterns]] for the repository pattern placement.

By the end of Lesson 08, `Boardly` will have a complete persistence layer with sync and async engines, typed models, query helpers, eager-loaded relationships, async session dependency, and the advanced ORM features that make it production-ready.

## Sources

- **SQLAlchemy 2.x — Async ORM** — <https://docs.sqlalchemy.org/en/21/orm/extensions/asyncio.html> — accessed 2026-10-19 — the canonical async API.
- **SQLAlchemy 2.x — `create_async_engine`** — <https://docs.sqlalchemy.org/en/21/orm/extensions/asyncio.html#sqlalchemy.ext.asyncio.create_async_engine> — accessed 2026-10-19.
- **SQLAlchemy 2.x — `AsyncSession`** — <https://docs.sqlalchemy.org/en/21/orm/extensions/asyncio.html#sqlalchemy.ext.asyncio.AsyncSession> — accessed 2026-10-19.
- **SQLAlchemy 2.x — `MissingGreenlet`** — <https://docs.sqlalchemy.org/en/21/orm/extensions/asyncio.html#asyncio-orm-missing-greenlet> — accessed 2026-10-19 — the canonical async trap.
- **asyncpg** — <https://magicstack.github.io/asyncpg/> — accessed 2026-10-19 — the async Postgres driver.
- **aiosqlite** — <https://aiosqlite.omnilib.dev/> — accessed 2026-10-19 — the async SQLite driver.
- **FastAPI — Async SQL databases** — <https://fastapi.tiangolo.com/advanced/sql-databases/> — accessed 2026-10-19 — the official tutorial for async SQLAlchemy with FastAPI.
- **pytest-asyncio** — <https://pytest-asyncio.readthedocs.io/> — accessed 2026-10-19 — the test framework for async Python.

## What We Learned

Let's recap. In this lesson you:

- **Constructed an async engine** with `create_async_engine` and learned that the pool config is identical to sync.
- **Built an `AsyncSession`** with `async_sessionmaker` and used it as an `async with` context manager.
- **Awaited every DB operation** — `await session.execute(...)`, `await session.commit()`, etc.
- **Understood the `MissingGreenlet` trap** — lazy loading throws in async; the fix is eager loading.
- **Built the async `get_db` FastAPI dependency** using `async def` + `yield`.
- **Configured the async pool** with the same kwargs as sync.
- **Managed async transactions** — `async with session.begin()`, `session.begin_nested()`.
- **Set up async tests** with `pytest-asyncio`, `aiosqlite`, and the per-test rollback pattern.
- **Chose sync vs async** based on workload (I/O-bound + async driver = async; otherwise sync + threadpool).
- **Articulated that `async def` does not magically make blocking DB calls non-blocking** — the call must be awaited, or run in `to_thread`.

Here's the mental model to walk away with: *async SQLAlchemy is the sync API with `await` on every DB call and a mandatory eager-loading habit. The async engine's pool is the same as sync; the session's API is the same; the models and queries are shared. The new failure modes are: forgetting `await` (the warning is loud), lazy loading (`MissingGreenlet`), and mixing sync and async (different drivers, different protocols). The async engine is created in the FastAPI lifespan and disposed on shutdown — exactly like sync. For FastAPI services with async drivers, use async end-to-end. The rule: never block the event loop — every DB call is awaited, every relationship is eager-loaded.*

---

> A note from your teacher
You just made `Boardly` async end-to-end. The async engine is the same engine with a different driver; the async session is the same session with `await`. The new failure modes are subtle (`MissingGreenlet` is the worst), but they are predictable once you internalize the rule: **eager-load every relationship, await every DB call**. Lesson 08 covers the advanced ORM features that make `Boardly` production-ready — hybrid properties, association proxies, custom types, optimistic concurrency, row locking, multi-tenant patterns, and the repository pattern. See you in Lesson 08.


---

**Tags:** #sqlalchemy #orm #async #asyncio #review
**Previous:** [[06-Querying-with-select]]
**Next:** [[08-Advanced-ORM]] →

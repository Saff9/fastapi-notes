---
title: "Lesson 04: Async Testing – Taming the Event Loop in Tests"
aliases:
 - Async Testing
 - pytest-asyncio
 - anyio plugin
 - MissingGreenlet
 - Async Fixtures
 - ASGITransport
 - event_loop fixture
tags:
 - testing
 - async
 - pytest
 - asyncio
 - lesson
course_level: intermediate
status: complete
difficulty: intermediate
estimated_time: "60–90 minutes"
prerequisites:
 - "[[10-Async-Python/Event-Loop-and-Coroutines]]"
 - "[[12-Testing-and-Quality/Testing-FastAPI-Endpoints]]"
 - "[[01-Python-Foundations/pytest-Fundamentals]]"
related_lessons:
 - "[[12-Testing-and-Quality/Testing-Database-Logic]]"
 - "[[07-SQLAlchemy/07-Async-SQLAlchemy]]"
 - "[[12-Testing-and-Quality/Test-Pyramid-and-Fixtures]]"
 - "[[10-Async-Python/asyncio-Primitives]]"
---

# Lesson 04: Async Testing – Taming the Event Loop in Tests

*Where `Boardly` gets the async test fixtures that let you POST a user, GET it back, assert the row exists in the DB, and never once open a real socket — and where you learn to read the three async-test errors that account for 90 % of the flakiness in modern Python suites.*

**This is the lesson where async stops being magic.**

Async tests look identical to sync tests — `async def test_X(client):` — but underneath, a plugin is doing real work: it spins up an event loop, schedules your coroutine, drains pending tasks, tears the loop down. Pick the wrong plugin, configure it wrong, forget to await a coroutine, leave a connection open across the loop boundary, and you get cryptic errors like `MissingGreenlet`, `Event loop is closed`, and `RuntimeWarning: coroutine was never awaited`. We will read each one in 30 seconds. Take your time. Type every fixture. Watch one fail. **This is how you learn.**


#testing #async #pytest #pytest-asyncio

## Learning Objectives

By the end of this lesson you will be able to:

1. **Pick between `pytest-asyncio` (strict/auto) and the `anyio` pytest plugin** and configure either in `pyproject.toml`.
2. **Write `@pytest.mark.asyncio` tests** and `@pytest_asyncio.fixture` async fixtures, and explain why `@pytest.fixture` on an `async def` is sometimes wrong.
3. **Use the `event_loop` fixture** to control the loop's lifetime, and explain why the default (per-function) is the only safe choice for most suites.
4. **Drive an async FastAPI app from tests** with `httpx.AsyncClient` + `ASGITransport` — no socket, no port, no `uvicorn` subprocess.
5. **Wire an async DB session into tests** with the transaction-rollback pattern (`begin_nested()` SAVEPOINT) so each test starts clean.
6. **Diagnose `MissingGreenlet`** — the SQLAlchemy async error that says "you tried to use a DB connection from outside an async context" — and fix it with `selectinload` or `expire_on_commit=False`.
7. **Diagnose `Event loop is closed`** — the error that happens when a coroutine outlives its loop — and fix it with proper teardown in `async with`.
8. **Diagnose `RuntimeWarning: coroutine was never awaited`** — the symptom of a missing `await` — and fix it in 30 seconds.
9. **Run two requests concurrently with `asyncio.gather`** and assert they do not share state, which is the integration test that catches the "single-session-per-app" bug.

## Prerequisites

Before starting, you need:

- **Python 3.12, pytest 8.x, pytest-asyncio (latest), httpx (latest), anyio (latest)**, plus **FastAPI 0.148.0 and SQLAlchemy 2.1.5 with `asyncpg`** (verified Oct 2026). If you have not installed: `uv add fastapi sqlalchemy asyncpg httpx && uv add --dev pytest pytest-asyncio anyio`.
- **The event loop lesson** — [[10-Async-Python/Event-Loop-and-Coroutines]]. You should already know what an event loop is, what a coroutine is, what `await` does, and why `asyncio.gather` is not parallelism.
- **The endpoint-testing lesson** — [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]]. That lesson covers `TestClient` (sync) and `httpx.AsyncClient` + `ASGITransport` (async); this lesson is the deep dive on the async half.
- **The pytest lesson** — [[01-Python-Foundations/pytest-Fundamentals]]. You should already know fixtures, scopes, parametrize, marks, and `conftest.py`.
- **Async SQLAlchemy** — [[07-SQLAlchemy/07-Async-SQLAlchemy]]. `MissingGreenlet` is a SQLAlchemy error; the canonical explanation lives there.
- **About an hour of focused time.** The code is small (~80 lines of tests plus ~20 of `conftest.py`). The explanation is long. Read slowly.

**The most common gap: pytest is sync.**

pytest itself is a synchronous test runner. It does not know what a coroutine is. When you write `async def test_X():`, pytest collects it fine — but at run time, with no async plugin installed and no marker claimed, pytest has no idea how to drive it. Modern pytest (8.0+) reports this as `SKIPPED` (with a `PytestUnhandledCoroutineWarning`) or `FAILED` (with the message "async def functions are not natively supported"); older `pytest-asyncio` ≤ 0.20 silently `PASSED` and lied. The bridge is a plugin (`pytest-asyncio` or `anyio`) that wraps each async test, spins up an event loop, schedules the coroutine, drains pending tasks, and reports the result. If you have never thought about "who schedules my test?", go back and skim [[10-Async-Python/Event-Loop-and-Coroutines]]. You'll be glad you did.


## The Problem

You wrote an async FastAPI endpoint. It works in `curl`. You write a test:

```python
async def test_create_user_returns_201(client):
 r = await client.post("/users", json={"email": "x@y.z", "password": "longenough"})
 assert r.status_code == 201
```

You run `uv run pytest`. The output is:

```
test_async_endpoints.py::test_create_user_returns_201 FAILED
async def functions are not natively supported.
You need to install a suitable plugin for your async framework, for example:
  - anyio
  - pytest-asyncio
  - pytest-trio
```

But the test never actually ran — pytest collected the `async def` function but had no marker claiming it for an async plugin. Modern pytest refuses to drive it; very old `pytest-asyncio` (≤ 0.20, before strict mode) silently `PASSED` and lied. Either way the body never executed. Or, you add the marker:

```python
@pytest.mark.asyncio
async def test_create_user_returns_201(client):
 ...
```

Now it runs. But the second test, which uses the same `client` fixture, fails with:

```
RuntimeError: Event loop is closed
```

Or the third test, which checks the DB after the request, fails with:

```
sqlalchemy.exc.MissingGreenlet: greenlet_spawn has not been called; can't
call `_setup_or_connect()` here.
```

Or the fourth test, the one you wrote at 1 a.m., fails with:

```
RuntimeWarning: coroutine 'AsyncClient.post' was never awaited
```

These four failure modes — unmarked async test (no plugin claims it), `Event loop is closed`, `MissingGreenlet`, `coroutine was never awaited` — are the entire surface area of async-test failure modes. Once you can read each in 30 seconds, async tests stop being scary. That is the goal of this lesson.

Why are async tests a separate lesson at all? Sync tests just work: `def test_x(): assert ...`. The reason is that the test runner is sync (pytest's core is sync; the event loop is a runtime concern that the test runner does not manage). The async test path requires a *bridge* — a plugin that wraps each `async def test_*` in a loop, schedules the coroutine, drains pending tasks, tears the loop down. The bridge has to handle resource lifetimes (the loop owns `AsyncClient` connections, `AsyncSession` sessions, Redis pools); if the bridge gets the lifetime wrong, you get one of the four errors. The four errors are the surface of *the bridge's responsibilities* — unmarked async test (bridge missing or marker missing), Event loop is closed (bridge closed the loop while a resource still held it), MissingGreenlet (bridge let sync ORM code touch the DB inside an async context without an implicit sync-to-async shim), coroutine was never awaited (test author forgot the `await` the bridge expected). The lesson is, structurally, a guided tour of the bridge's failure modes.

**Note — Historical context — the `event_loop` fixture saga.**

Before `pytest-asyncio` 0.23 (December 2023), the `event_loop` fixture was *user-overridable*: you could write `@pytest.fixture(scope="session")` `def event_loop():` and get one loop for the whole session. The 0.23 release deprecated that pattern, and 0.24 removed it. The motivation: a session-scoped loop interacted catastrophically with function-scoped async fixtures — the fixtures outlived the loop, and "Event loop is closed" became the most-reported issue. The modern contract is: `pytest-asyncio` manages the loop; you do not. If you see old StackOverflow answers telling you to override `event_loop`, they are wrong for 0.24+. The current versions (verified Oct 2026 is 0.24+) follow the new contract.


## The Code

Here is the complete async test file for `Boardly`'s `/users` endpoints, plus the `conftest.py` that supports it. Save it mentally — every async test file you ever write is a variation of this skeleton.

```python
# boardly/main.py — the app under test (already exists from Lesson 02)
# (Not repeated here; see [[03-FastAPI-Core/Application-and-Lifespan]])
```

```python
# tests/conftest.py — shared async fixtures
"""Shared async fixtures for the Boardly test suite."""
from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from boardly.db import Base, get_session
from boardly.main import app
from boardly.models import User
from boardly.security.deps import get_current_user


@pytest.fixture(scope="session")
def anyio_backend():
 """For anyio-based tests: which backend to use. asyncio here."""
 return "asyncio"


@pytest_asyncio.fixture(scope="session")
async def engine():
 """One engine for the whole session. Test DB on localhost."""
 eng = create_async_engine(
 "postgresql+asyncpg://test:test@localhost:5432/boardly_test",
 pool_pre_ping=True,
 )
 async with eng.begin() as conn:
 await conn.run_sync(Base.metadata.create_all)
 yield eng
 await eng.dispose()


@pytest_asyncio.fixture
async def session(engine) -> AsyncSession:
 """Per-test session. Each test runs inside a SAVEPOINT that rolls back at teardown."""
 async with engine.connect() as conn:
 await conn.begin()
 sess = AsyncSession(bind=conn, expire_on_commit=False)
 await sess.begin_nested() # SAVEPOINT
 yield sess
 await sess.close()
 await conn.rollback()


@pytest_asyncio.fixture
async def client(session):
 """Per-test async client. Overrides get_session and get_current_user."""
 async def _session():
 return session
 async def _user():
 return User(id=1, email="admin@example.com", is_admin=True, _scopes=["write:users"])
 app.dependency_overrides[get_session] = _session
 app.dependency_overrides[get_current_user] = _user
 async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
 yield ac
 app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def clean_users_table(session):
 """Defensive: empty the users table before each test that uses it."""
 from sqlalchemy import delete
 await session.execute(delete(User))
 await session.commit()
 yield
```

```python
# tests/test_async_endpoints.py
"""Async tests for Boardly's /users endpoints."""
from __future__ import annotations

import asyncio

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from boardly.main import app
from boardly.models import User


@pytest.mark.asyncio
async def test_get_users_me_returns_200(client):
 r = await client.get("/users/me")
 assert r.status_code == 200
 assert r.json()["email"] == "admin@example.com"


@pytest.mark.asyncio
async def test_create_user_returns_201_and_persists(client, session):
 r = await client.post(
 "/users",
 json={"email": "new@e.st", "password": "longenough"},
 )
 assert r.status_code == 201
 assert r.json()["email"] == "new@e.st"
 # The route committed through the same session — verify the row exists
 user = await session.scalar(select(User).where(User.email == "new@e.st"))
 assert user is not None
 assert user.email == "new@e.st"


@pytest.mark.asyncio
async def test_create_user_rejects_short_password(client):
 r = await client.post(
 "/users",
 json={"email": "x@y.z", "password": "short"},
 )
 assert r.status_code == 422
 detail = r.json()["detail"]
 assert any(entry["loc"][-1] == "password" for entry in detail)


@pytest.mark.asyncio
async def test_concurrent_signups_are_isolated(client, session):
 """Two POSTs at the same time must both succeed and not collide."""
 results = await asyncio.gather(
 client.post("/users", json={"email": "a@e.st", "password": "longenough"}),
 client.post("/users", json={"email": "b@e.st", "password": "longenough"}),
 return_exceptions=True,
 )
 assert all(not isinstance(r, Exception) for r in results)
 assert all(r.status_code == 201 for r in results)
 emails = {r.json()["email"] for r in results}
 assert emails == {"a@e.st", "b@e.st"}


@pytest.mark.asyncio
async def test_missing_override_means_401():
 """Without the auth override, the real oauth2_scheme rejects."""
 app.dependency_overrides.clear()
 async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
 r = await ac.post("/users", json={"email": "x@y.z", "password": "longenough"})
 assert r.status_code == 401


# ---------- The MissingGreenlet trigger (and the fix) ----------

@pytest.mark.asyncio
async def test_missing_greenlet_when_lazy_loading(client, session):
 """WITHOUT selectinload, accessing user.org in the serializer triggers
 MissingGreenlet. WITH selectinload, it does not."""
 # This test is the demonstration — the assertion is "no exception".
 r = await client.post("/users", json={"email": "u@e.st", "password": "longenough"})
 assert r.status_code == 201
 # The route returned a UserRead with from_attributes=True. If UserRead
 # accessed user.org (lazy), we'd see MissingGreenlet here. The route
 # uses selectinload(User.org) — see boardly/routers/users.py.
 assert r.json()["email"] == "u@e.st"
```

```toml
# pyproject.toml (relevant bits)
[tool.pytest.ini_options]
asyncio_mode = "strict"
addopts = "--strict-markers --asyncio-mode=strict"
markers = [
 "asyncio: mark a test as async (pytest-asyncio)",
 "slow: marks tests as slow",
]
```

That is the whole suite: ~80 lines of tests plus ~50 lines of `conftest.py`. Run it. Watch one test fail with a missing override. Watch it pass. That is the loop. We will explain every line next — not just *what it does* but *what `pytest-asyncio`, `httpx`, and SQLAlchemy do internally* when those lines run.

## Line-by-Line Deep Dive

This section is the heart of the lesson. Read it twice. Do not skip.

**We re-introduce the conftest here, async-focused.**

This lesson's `tests/conftest.py` overlaps with the one in [[12-Testing-and-Quality/Test-Pyramid-and-Fixtures]] — same engine, session, client, and factory fixtures — but re-introduces them with the async-specific concerns called out: the `anyio_backend` fixture, the `pytest-asyncio` strict-vs-auto decision, the `MissingGreenlet` error, and the SAVEPOINT-rollback pattern that lets async SQLAlchemy run real-DB tests without truncation between tests. The repetition is intentional — async testing has *different* failure modes than sync testing, and showing the conftest side-by-side with the new failure modes is the lesson. For the sync variants of the same fixtures and the underlying fixture-pattern discussion, see [[12-Testing-and-Quality/Test-Pyramid-and-Fixtures]] Lesson 01.


### Lines 1–13 of `tests/conftest.py`: Imports and the bridge

```python
"""Shared async fixtures for the Boardly test suite."""
from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from boardly.db import Base, get_session
from boardly.main import app
from boardly.models import User
from boardly.security.deps import get_current_user
```

**What it does:** Pulls in five things — `pytest` (the runner), `pytest_asyncio` (the async bridge), `httpx` (the async HTTP client), `sqlalchemy.ext.asyncio` (the async DB layer), and four symbols from the Boardly app.

**Why each import matters:**

- `pytest` is needed for `@pytest.fixture` and the `pytest_addoption` hook (used below).
- `pytest_asyncio` is the bridge that lets `async def` tests run. The import alias `pytest_asyncio` (not `pytest.asyncio` — that does not exist) is the package's own name. The two decorators you will use are `@pytest.mark.asyncio` (a marker, on tests) and `@pytest_asyncio.fixture` (a fixture decorator, on async fixtures).
- `httpx.ASGITransport` and `httpx.AsyncClient` are the pair that drives an ASGI app in-process, without a socket. We covered the rationale in [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]] — `ASGITransport(app=app)` is the test seam.
- `sqlalchemy.ext.asyncio` is the async API of SQLAlchemy 2.x. `create_async_engine` returns an `AsyncEngine` (the connection pool); `async_sessionmaker` is a factory for `AsyncSession`; `AsyncSession` is the async equivalent of `Session`.
- The Boardly imports wire the app's real symbols so we can override them later (`app.dependency_overrides[get_session] = ...`).

**Tip — Why `pytest_asyncio` and not just `pytest`?**

`pytest` itself has no async support. Without `pytest_asyncio` (or another async plugin) installed and the marker claimed, `async def test_X():` collects fine but pytest cannot drive it. Modern pytest (8.0+) reports the test as `SKIPPED` (with a `PytestUnhandledCoroutineWarning`) or `FAILED` ("async def functions are not natively supported..."); older `pytest-asyncio` ≤ 0.20 silently `PASSED` and lied — the body returned a coroutine, pytest saw no assertion fail, the green check was false. Either way the body never executed. `pytest-asyncio` is the plugin that intercepts `async def test_*` functions, runs them on an event loop, and reports the result correctly.


### Lines 15–18: The `anyio_backend` fixture (for anyio-based tests)

```python
@pytest.fixture(scope="session")
def anyio_backend():
 """For anyio-based tests: which backend to use. asyncio here."""
 return "asyncio"
```

**What it does:** Declares that any test marked `@pytest.mark.anyio` (the alternative to `@pytest.mark.asyncio`) should use the `asyncio` backend, not `trio`.

**Why a session-scoped sync fixture for an async concern:** the `anyio_backend` fixture is itself sync — it just returns a string. `anyio` (the library) supports multiple async runtimes (`asyncio`, `trio`); the fixture tells `anyio`'s pytest plugin which one to use. Returning `"asyncio"` means "use the standard-library event loop". Returning `"trio"` would mean "use the trio runtime" — useful only if your code is trio-compatible.

**Why this fixture exists even though we are using `pytest-asyncio`:** a real suite often has both kinds of tests — `@pytest.mark.asyncio` (the common case) and `@pytest.mark.anyio` (rare, for tests that should pass on both asyncio and trio). Having both fixtures in `conftest.py` lets you mix without config thrash. If your suite is asyncio-only, you can delete this fixture.

**`pytest-asyncio` strict vs auto vs `anyio`.**

Three modes, one job: schedule the coroutine on an event loop.

| Mode | Marker | Boilerplate | Risk |
|---|---|---|---|
| `pytest-asyncio` strict | `@pytest.mark.asyncio` | per-test marker | highest — explicit, easy to grep |
| `pytest-asyncio` auto | none | zero | medium — `async def test_*` is auto-detected |
| `anyio` plugin | `@pytest.mark.anyio` | per-test marker + `anyio_backend` fixture | highest — multi-runtime |

Strict is the default in modern `pytest-asyncio` (since 0.21) and the safest. Auto is for large async-only suites where the per-test marker feels like noise. `anyio` is for libraries that must run on both asyncio and trio. The lesson [[12-Testing-and-Quality/Test-Pyramid-and-Fixtures]] has the trade-off discussion; here we use strict.


### Lines 21–29: The `engine` fixture (session-scoped, async)

```python
@pytest_asyncio.fixture(scope="session")
async def engine():
 """One engine for the whole session. Test DB on localhost."""
 eng = create_async_engine(
 "postgresql+asyncpg://test:test@localhost:5432/boardly_test",
 pool_pre_ping=True,
 )
 async with eng.begin() as conn:
 await conn.run_sync(Base.metadata.create_all)
 yield eng
 await eng.dispose()
```

**What it does:** Creates one `AsyncEngine` for the whole test session, creates all tables on it, yields the engine, then disposes the engine (closes the connection pool).

**Why `@pytest_asyncio.fixture` and not `@pytest.fixture`:** the fixture function is `async def` *and* uses `yield` — an async generator function. The `pytest_asyncio.fixture` decorator tells the plugin "run this on an event loop, schedule the `await`s, and drive the `yield` between". With `@pytest.fixture`, pytest calls the function, gets an `async_generator` object back (because of the `yield`), never schedules it, and hands the `async_generator` to the test instead of an `AsyncEngine`. The test then fails with `AttributeError: 'async_generator' object has no attribute 'begin'` (or, on pytest 9+, errors at setup with "requested an async fixture with no plugin that handled it"). For an `async def` fixture *without* `yield`, the symptom is the parallel one: the test gets a coroutine object and fails with `AttributeError: 'coroutine' object has no attribute '...'`. Either way the test never received the engine.

**Why `scope="session"`:** the engine is expensive to create (it opens a real Postgres connection pool, runs `CREATE TABLE` on every table) and is read-only for the rest of the session. One engine, many tests.

**Why `pool_pre_ping=True`:** Postgres connections can be killed by the server (idle timeout, restart, firewall). `pool_pre_ping=True` makes the engine `SELECT 1` on every checkout, and reconnects if the ping fails. Without it, a test that runs after a long idle period can fail with `OperationalError: server closed the connection unexpectedly`. In CI, the time between test items is short, so the ping is mostly free; in long-running local sessions, it is essential.

**Why `await conn.run_sync(Base.metadata.create_all)`:** `Base.metadata.create_all` is a sync SQLAlchemy API — it walks the metadata and runs `CREATE TABLE` for each table. The async API gives us `run_sync` to call sync functions on a sync-style connection from inside an async context. The async SQLAlchemy layer is *not* a re-implementation; it is a thin async wrapper around the sync engine, with `run_sync` as the escape hatch for DDL.

**Why `await eng.dispose()` at teardown:** the engine's connection pool holds open connections. Without `dispose()`, the next `pytest` invocation might find the pool still in memory (in some configurations) or, more importantly, the Postgres server has lingering idle connections. `dispose()` closes them all.

**Warning — When this breaks: `pool_pre_ping` masks CI flakiness.**

The `pool_pre_ping=True` flag (above) fires `SELECT 1` on every connection checkout and reconnects if the ping fails. In CI, when the Postgres host flaps (a sidecar restart, a PgBouncer `server_idle_timeout` firing, an idle-connection kill by a stateful firewall), the ping succeeds but the next `await session.execute(...)` returns `OperationalError: server closed the connection unexpectedly` — the connection was killed between the ping and the real query. The symptom is "first test passes, second test `OperationalError` on first execute"; the diagnosis is "the pool is recycling, not that the test is buggy". The fix is `pool_pre_ping=True` (already set) plus `pool_recycle=300` (so the engine proactively recycles connections before the server kills them) — see [[07-SQLAlchemy/02-Engines-Connections-Pools]] for the production pool-tuning discussion.


**Production reality: the test engine's pool is sized for tests, not for production.**

The test engine (above) uses the default `pool_size=5`, `max_overflow=10`, but every test borrows one connection via `engine.connect()` and holds it for the test's duration — so the test never exercises the pool's overflow or its checkout queue. In production, the engine has `pool_size=10`, `max_overflow=20`, `pool_timeout=30` and a checkout queue that grows when 200 concurrent requests all want a connection at once. A test that uses one connection per test will not catch pool-exhaustion bugs (a leaked checkout in middleware, a `session.commit()` that holds a connection too long, a `StreamingResponse` that keeps the session open past the route's return). To catch those, write a concurrency test that fires 50 parallel requests through `asyncio.gather` and asserts the engine's `pool.status().checked_out` counter never exceeds `pool_size + max_overflow` — see Exercise 8.


**Warning — The `@pytest.fixture` vs `@pytest_asyncio.fixture` distinction is critical.**

A common mistake: write `@pytest.fixture` on an `async def` function. The fixture *collects* fine. But when a test asks for it, pytest calls the function, gets an `async_generator` object (the fixture uses `yield`) — or, for fixtures without `yield`, a coroutine object — and passes that raw object (not the engine) to the test. The test then fails with `AttributeError: 'async_generator' object has no attribute 'execute'` (yield-based fixtures) or `AttributeError: 'coroutine' object has no attribute 'execute'` (return-based fixtures). On pytest 9+ the failure moves earlier: the test errors at setup with "requested an async fixture with no plugin that handled it". The fix: use `@pytest_asyncio.fixture` for `async def` fixtures.


### Lines 32–41: The `session` fixture (per-test, with SAVEPOINT rollback)

```python
@pytest_asyncio.fixture
async def session(engine) -> AsyncSession:
 """Per-test session. Each test runs inside a SAVEPOINT that rolls back at teardown."""
 async with engine.connect() as conn:
 await conn.begin()
 sess = AsyncSession(bind=conn, expire_on_commit=False)
 await sess.begin_nested() # SAVEPOINT
 yield sess
 await sess.close()
 await conn.rollback()
```

**What it does:** For each test, opens a connection, begins an outer transaction, creates an `AsyncSession` bound to that connection, opens a SAVEPOINT (nested transaction), yields the session, then closes the session and rolls back the outer transaction. The net effect: every test starts with an empty DB, every test's commits hit the SAVEPOINT, every test's data is rolled back at teardown.

**Why the SAVEPOINT trick:** a route's `await session.commit()` should *not* actually commit to the DB (or the next test sees the row). But the route calls `commit()` — you cannot tell the route "don't commit". The SAVEPOINT trick: the route's `commit()` releases the SAVEPOINT (the rows are now visible to subsequent queries on the same session) but the outer transaction is still open. At teardown, the outer `rollback()` discards everything. This is the canonical pattern for testing DB-backed code without truncating tables between tests. The deeper explanation is in [[12-Testing-and-Quality/Testing-Database-Logic]].

**Why `expire_on_commit=False`:** this is the SQLAlchemy setting that says "after `commit()`, do not invalidate the in-memory state of the objects". The default (`True`) means every attribute access after `commit()` triggers a re-fetch — and the re-fetch needs an async context, which the response serializer does not have. `MissingGreenlet` is the error you get if you forget this. We will see it in the deep dive below.

**Why `async with engine.connect() as conn`:** borrows a connection from the pool for the duration of the `with` block. At teardown (the `async with` `__aexit__`), the connection is returned to the pool. Without the `async with`, the connection leaks — and you run out of pool slots after ~5 tests.

**Why `await sess.close()` before `await conn.rollback()`:** order matters. `sess.close()` releases the session's references to its loaded objects and ends any in-flight work; `conn.rollback()` rolls back the underlying transaction. Closing the session first avoids "the session is still using the connection" errors.

**Example — What "the route commits through the SAVEPOINT" looks like.**

1. Test asks for `session` and `client`. The fixtures open a connection, begin a transaction, open a SAVEPOINT, and create a session bound to that connection.
2. The `client` fixture overrides `get_session` to return that session. When the route calls `Depends(get_session)`, FastAPI's resolver calls the override, which returns the test session.
3. The route does `session.add(user); await session.commit()`. The `commit()` releases the SAVEPOINT — the row is now visible to subsequent queries on the same session — but the outer transaction is still open.
4. The route returns. The test asserts the row exists with `await session.scalar(select(User).where(...))` — and finds it, because the SAVEPOINT was released (not rolled back yet).
5. At teardown, the outer transaction is rolled back. The row vanishes. The next test starts with an empty DB.


**Warning — When this breaks: a route that calls `await session.rollback()` silently breaks the SAVEPOINT pattern.**

The `session` fixture (above) opens a SAVEPOINT via `begin_nested()` and rolls back the *outer* transaction at teardown. But a route that calls `await session.rollback()` to "undo its own partial work" releases the SAVEPOINT early — the next `session.add(...)` in the same request runs without an active SAVEPOINT, the outer transaction begins accumulating uncommitted state, and the next test sees it. The symptom is "test B fails only when run after test A, with rows from A visible in B's assertions"; the diagnosis is "the route called `rollback()` mid-request". The fix is either (a) re-establish the SAVEPOINT after the route's rollback (`await sess.begin_nested()` in the override's session wrapper) or (b) assert in a teardown fixture that a SAVEPOINT is still active before the outer rollback, so the regression is loud. The [[12-Testing-and-Quality/Testing-Database-Logic]] lesson covers this trap in depth.


**Production reality: the SAVEPOINT trick is a *test* fixture — it does NOT run in production.**

In production, each request's session commits for real, and the cascade-delete, trigger, or audit-row write that the SAVEPOINT silently absorbed (because the rollback hid the side effect on the audit table) ships to production and writes a stray audit row on every retry. The test passes because the rollback hides the cascade; the production retry loop re-runs the cascade. The diagnosis is "the test asserts the user row is gone, and the audit row from the cascade is also gone (rolled back); in production, the audit row persists across retries". The fix is to assert the audit row's *existence* in a separate test that does NOT use the SAVEPOINT fixture (or uses a truncate-based cleanup), so the cascade's side effect is visible and tested. See [[12-Testing-and-Quality/Testing-Database-Logic]] for the truncate-vs-rollback trade-off.


### Lines 44–56: The `client` fixture (the framework-level seam)

```python
@pytest_asyncio.fixture
async def client(session):
 """Per-test async client. Overrides get_session and get_current_user."""
 async def _session():
 return session
 async def _user():
 return User(id=1, email="admin@example.com", is_admin=True, _scopes=["write:users"])
 app.dependency_overrides[get_session] = _session
 app.dependency_overrides[get_current_user] = _user
 async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
 yield ac
 app.dependency_overrides.clear()
```

**What it does:** Installs two overrides (`get_session` returns the per-test session; `get_current_user` returns a fake admin user), opens an `AsyncClient` with `ASGITransport`, yields it, clears the overrides at teardown, and closes the client.

**Why two overrides:** the route depends on both — `get_session` for the DB, `get_current_user` for auth. Without overriding `get_session`, the route would try to open a real DB connection (slow, requires a real DB). Without overriding `get_current_user`, the route would try to verify a real JWT (slow, requires a real secret). The override is the framework-level seam — covered in [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]].

**Why `_session` and `_user` are `async def`:** the real `get_session` and `get_current_user` are `async def`. The override must match the signature — FastAPI calls the override the same way it would call the real dependency. If the override were `def`, FastAPI would call it sync, get a coroutine (if it returned one) or a User object (if it did not), and the route's `await session` would fail with `TypeError: object User can't be used in 'await' expression`.

**Why `_user` returns a `User` with `is_admin=True`:** the route has `dependencies=[Depends(get_current_user)]` — it requires auth, but does not check a scope. The override returns a user with admin privileges — enough to satisfy `get_current_user`. If the route had `dependencies=[Depends(require_scope("write:users"))]` instead, the override would have to satisfy that chain too.

**Why `app.dependency_overrides.clear()` at teardown:** without it, the override leaks into the next test. Test A installs `get_current_user = _admin_user`; test A finishes — the override is still installed; test B starts, expects `get_current_user = _regular_user`, but the override is still `_admin_user` — test B fails mysteriously. This is Common Mistake #1.

**Why `async with AsyncClient(...)`:** the `AsyncClient` keeps connections alive (keepalive), a cookie jar, and an event-loop binding. The `async with` `__aexit__` closes the client at teardown. Without `async with`, you get `RuntimeError: Event loop is closed` on the next test — the client outlived the loop.

**The override key is the function object.**

`app.dependency_overrides[get_session] = _session` — the key is the *function object* `get_session`, not a string. This is refactor-safe: if you move `get_session` from `app.db` to `boardly.db`, the import path changes but the function object is the same. The override keeps working. Contrast with `unittest.mock.patch("boardly.db.get_session")` — which is keyed on the import path and breaks on rename.


**Danger — How an attacker thinks: the `get_current_user` override returns `User(is_admin=True)`.**

The `client` fixture (above) overrides `get_current_user` to return `User(id=1, email="admin@example.com", is_admin=True, _scopes=["write:users"])`. If a test file tests admin routes alongside regular-user routes, the admin override silently authorises admin actions — and the test never exercises the real `require_scope("admin")` dependency. An attacker (insider, a malicious PR) who refactors the override's `User` to a real DB row, or adds `_scopes=["admin"]` to it, can ship code that grants admin in production because the test's override masked the missing scope check. The defence is (a) split `admin_client` and `user_client` fixtures with explicit names — never reuse one fixture for both admin and non-admin routes — (b) every admin route has a `test_<route>_rejects_non_admin` test that uses `user_client` and asserts 403, (c) the contract test `test_every_protected_route_has_a_401_test` (Exercise 10) catches a deleted 401 test. See [[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]] for the production RBAC pattern and [[11-Authentication-and-Security/Threat-Model-First]] for the threat-modelling angle.


### Lines 59–64: The `clean_users_table` defensive fixture

```python
@pytest_asyncio.fixture
async def clean_users_table(session):
 """Defensive: empty the users table before each test that uses it."""
 from sqlalchemy import delete
 await session.execute(delete(User))
 await session.commit()
 yield
```

**What it does:** Deletes all rows from the `users` table before each test that asks for it, then yields (no teardown needed).

**Why this exists alongside the SAVEPOINT rollback:** the SAVEPOINT trick (in `session`) rolls back at teardown — but if a test that uses it forgets to ask for `session` (only asks for `client`), the rollback never happens. The `clean_users_table` fixture is the belt-and-suspenders: tests that need a clean table say so explicitly, by asking for it. The pattern: tests that need a clean state ask for `clean_users_table`; tests that don't care don't pay the cost.

**Why the `delete` runs *before* `yield`:** the cleanup is setup-side. The fixture's contract is "when I'm done, the table is empty". The teardown (after `yield`) is empty — nothing to do, the SAVEPOINT in `session` handles the rollback.

**Student asks: why bother with `clean_users_table` when the SAVEPOINT already rolls back?**

Good instinct. The SAVEPOINT rolls back at *teardown of the `session` fixture*. But what if a test does not use `session` directly — only `client`? Then the `session` fixture still runs (because `client` depends on it), but a forgetful test author might write a test that asserts on a stale row from a previous test. The `clean_users_table` fixture is the explicit "I depend on a clean table" declaration. It is defensive; if you trust your team to always use the SAVEPOINT, you can drop it. We keep it for the lesson because the pattern — explicit cleanup fixtures — is common in real suites.


### Lines 1–8 of `tests/test_async_endpoints.py`: Imports

```python
"""Async tests for Boardly's /users endpoints."""
from __future__ import annotations

import asyncio

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from boardly.main import app
from boardly.models import User
```

**What it does:** Pulls in `asyncio` (for `gather`), `pytest` (for the marker), `httpx` (for the in-test client in test 5), `sqlalchemy.select` (for the DB assertions), and the Boardly `app` and `User` model.

**Why `import asyncio`:** the concurrency test uses `asyncio.gather`. The standard-library `asyncio` module is the runtime; `pytest-asyncio` is the bridge. They are not the same thing.

**Why `from httpx import ASGITransport, AsyncClient` in the test file** when the `client` fixture already provides one: test 5 (`test_missing_override_means_401`) needs its *own* client, distinct from the `client` fixture, because the test deliberately clears the overrides and wants a clean client. The fixture's `client` would have the overrides set up; this test wants no overrides. So it opens its own.

### Lines 11–14: The simplest async test

```python
@pytest.mark.asyncio
async def test_get_users_me_returns_200(client):
 r = await client.get("/users/me")
 assert r.status_code == 200
 assert r.json()["email"] == "admin@example.com"
```

**What it does:** Marks the test as async (so `pytest-asyncio` schedules it on a loop), GETs `/users/me` via the `client` fixture (which has the admin user override), asserts 200, asserts the email is the fake admin's.

**Why `@pytest.mark.asyncio` is non-negotiable in strict mode:** in strict mode (the default in modern `pytest-asyncio`), `async def test_*` without the marker is collected but not scheduled — the body never runs and pytest reports `SKIPPED` or `FAILED`. The marker is the opt-in. (In auto mode, the marker is implicit — but auto mode is a footgun for suites with sync tests, because every `async def test_*` becomes async whether you meant it or not.)

Why is strict mode the default and not auto? Auto mode says "any `async def test_*` is async, no marker needed". That sounds convenient — and it is, until you write a sync helper named `test_helper_assert_user_email` (starts with `test_`, accidentally `async def` because you copied from another file), and pytest-asyncio silently wraps it in a loop and runs it as async. Your sync helper now runs on the loop, sees `MissingGreenlet` if it touches the ORM, and the failure message is confusing. Strict mode forces you to mark each async test explicitly — the marker is the contract "I, the test author, knew this was async when I wrote it". The cost is one line per test; the benefit is "the suite does what you said, not what it guessed". Strict mode is the disciplined default for the same reason `--strict-markers` is: silent inference is a footgun.

**Why `await client.get(...)`:** `client` is an `AsyncClient`; its methods are coroutines. The `await` schedules the request on the event loop. Without `await`, you get a coroutine object — and the `assert r.status_code == 200` would be `AttributeError: 'coroutine' object has no attribute 'status_code'` (or, worse, a silent `RuntimeWarning: coroutine was never awaited`).

**Why `r.json()["email"] == "admin@example.com"`:** the `get_current_user` override returned `User(email="admin@example.com", ...)`. The route's `/users/me` returns the current user as JSON. The test asserts that the JSON email matches the override. This is the contract: "the override is wired correctly".

**Example — What `pytest-asyncio` does when it sees the marker.**

1. At collection, `pytest-asyncio` notices the `@pytest.mark.asyncio` marker on the test item.
2. At run time, it wraps the test in an `asyncio.run(...)`-style call: creates a fresh event loop, schedules the coroutine, drains pending tasks, tears the loop down.
3. The loop is per-test by default. The next test gets a fresh loop. This is the safest default — no leakage between tests.
4. The fixture resolver runs *inside* the test's loop. Async fixtures (`@pytest_asyncio.fixture`) are scheduled on the same loop. Sync fixtures (`@pytest.fixture`) run on the main thread, outside the loop.


### Lines 17–26: The persist test (DB assertion after the request)

```python
@pytest.mark.asyncio
async def test_create_user_returns_201_and_persists(client, session):
 r = await client.post(
 "/users",
 json={"email": "new@e.st", "password": "longenough"},
 )
 assert r.status_code == 201
 assert r.json()["email"] == "new@e.st"
 user = await session.scalar(select(User).where(User.email == "new@e.st"))
 assert user is not None
 assert user.email == "new@e.st"
```

**What it does:** POSTs a user, asserts 201, asserts the response email, asserts the row exists in the DB via the same `session` fixture, asserts the row's email.

**Why we can assert the row exists in the DB after the request:** the route's `await session.commit()` released the SAVEPOINT (the row is visible to subsequent queries on the same session). The same session fixture is injected into the test — so `await session.scalar(...)` finds the row the route just inserted. At teardown, the outer transaction rolls back; the row vanishes.

**Why `session.scalar(...)` and not `session.execute(...).scalar()`:** `AsyncSession.scalar(stmt)` is the modern SQLAlchemy 2.x API — it executes the statement and returns the first scalar. The 1.x form (`session.execute(...).scalar()`) still works but is more verbose. The lesson [[07-SQLAlchemy/06-Querying-with-select]] has the full API tour.

**Why the assertion is `user is not None` and not `user == something`:** the row's `id` is auto-generated (a UUID or an autoincrement); the `created_at` is a timestamp; only the `email` is deterministic. Asserting `user.email == "new@e.st"` is enough — the email is the only field we control. Asserting on the full object would compare the non-deterministic fields and fail intermittently.

### Lines 29–36: The validation-error test

```python
@pytest.mark.asyncio
async def test_create_user_rejects_short_password(client):
 r = await client.post(
 "/users",
 json={"email": "x@y.z", "password": "short"},
 )
 assert r.status_code == 422
 detail = r.json()["detail"]
 assert any(entry["loc"][-1] == "password" for entry in detail)
```

**What it does:** POSTs a body with a short password, asserts 422 (Pydantic validation error), asserts that at least one error entry in `detail` has `loc[-1] == "password"`.

**Why 422 and not 400:** FastAPI uses 422 (`Unprocessable Entity`) for Pydantic validation failures. 400 is reserved for application-level bad requests. The lesson [[03-FastAPI-Core/Path-Query-Header-Cookie-Body]] covers the contract.

**Why `loc[-1] == "password"`:** `loc` is a list like `["body", "password"]`. The last element is the field name. Asserting on `loc[-1]` lets the helper work regardless of where the field is (body, query, path). The lesson [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]] covers the `assert_validation_error` helper, which is the production version of this pattern.

**Why not assert on the `msg`:** Pydantic v2's error messages can change between minor versions (e.g. "string should have at least 8 characters" → "String should have at least 8 characters" between minor versions). The `type` field (`string_too_short`) is the stable identifier. Asserting on `type` is version-resilient; asserting on `msg` is brittle. (The production version uses `type`; the lesson here uses `loc[-1]` to keep the test small.)

### Lines 39–50: The concurrency test

```python
@pytest.mark.asyncio
async def test_concurrent_signups_are_isolated(client, session):
 """Two POSTs at the same time must both succeed and not collide."""
 results = await asyncio.gather(
 client.post("/users", json={"email": "a@e.st", "password": "longenough"}),
 client.post("/users", json={"email": "b@e.st", "password": "longenough"}),
 return_exceptions=True,
 )
 assert all(not isinstance(r, Exception) for r in results)
 assert all(r.status_code == 201 for r in results)
 emails = {r.json()["email"] for r in results}
 assert emails == {"a@e.st", "b@e.st"}
```

**What it does:** Schedules two POSTs concurrently with `asyncio.gather`, asserts that neither raised, asserts both returned 201, asserts the response emails are the two distinct emails we sent.

**Why `asyncio.gather` and not two `await`s in sequence:** two `await`s in sequence run one after the other — the second starts only after the first returns. `asyncio.gather` schedules both on the loop, lets them interleave (the first's `await session.commit()` is a yield point; while it waits for the DB, the second's `await client.post(...)` runs), and returns when both are done. The point of this test is to catch a real bug — a route that uses a *single session for the whole app* (instead of per-request) would serialize the two requests, and the second's commit would see the first's data (or fail with "session is already in a transaction").

**Why `return_exceptions=True`:** without it, `gather` raises on the first exception. With it, `gather` returns the exception object in the results list. The test then asserts `not isinstance(r, Exception) for r in results` — which is "no test raised". The pattern is useful when you want to assert "they all succeeded" with a useful diff on which one failed.

**Why `emails = {r.json()["email"] for r in results}`:** set comprehension. If the two requests collided (both wrote the same email), the set would have one element, not two. The set-equality assertion catches "did both write the same row?".

**Warning — `asyncio.gather` is concurrency, not parallelism.**

The two POSTs are *concurrent* — they interleave on the event loop. They are not *parallel* — they do not run on two cores. If both POSTs are CPU-bound, `gather` does not speed them up. If they are I/O-bound (waiting for the DB, the network), `gather` does speed them up — the loop runs the second while the first awaits. The lesson [[10-Async-Python/asyncio-Primitives]] covers the distinction in depth.


### Lines 53–59: The "no override means 401" test

```python
@pytest.mark.asyncio
async def test_missing_override_means_401():
 """Without the auth override, the real oauth2_scheme rejects."""
 app.dependency_overrides.clear()
 async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
 r = await ac.post("/users", json={"email": "x@y.z", "password": "longenough"})
 assert r.status_code == 401
```

**What it does:** Clears the overrides (so the real `oauth2_scheme` and `get_current_user` run), opens its own `AsyncClient`, POSTs without an `Authorization` header, asserts 401.

**Why this test matters:** it proves the route actually requires auth — not just that the test fixture happens to install an override. If a refactor removes the `dependencies=[Depends(get_current_user)]` from the route, this test fails (the route would return 201, not 401). The "requires auth" test is the contract that the route is protected.

**Why the test does not take `client` as an argument:** the `client` fixture installs the overrides; this test deliberately wants no overrides. So it does not ask for `client`. It opens its own `AsyncClient` inside the test body.

**Why `app.dependency_overrides.clear()` is called at the start of the test, not at the end:** defensive. If a previous test installed overrides and forgot to clear, this test's clear-at-start ensures a clean slate. The clear-at-end is in the `client` fixture's teardown — but this test does not use the `client` fixture, so the clear-at-end is not called. The clear-at-start is the safety net.

**The "requires auth" test is a contract test.**

A route that *can* be called without auth but *should* require auth is a security bug. The "requires auth" test catches the bug *before* the refactor ships. The pattern: for every protected route, write one test that uses the override (the happy path) and one test that clears the override and asserts 401 (the security contract). Both tests in the same file.


**Danger — How an attacker thinks: a deleted `*_401` test means a route lost its auth requirement.**

The `test_missing_override_means_401` test (above) is a security primitive: it asserts the route returns 401 without the override. If a refactor removes `dependencies=[Depends(get_current_user)]` from the route, this test catches it. But if a developer deletes the test (because "it broke" or "it's slow" or "I moved the route to a new file and forgot the 401 test"), the route's auth requirement is silently gone — and the next deploy ships the unauthenticated route. The defence is a contract test (`test_every_protected_route_has_a_401_test`) that scans `tests/` for `*_401` test functions (using `ast.parse` on each `tests/**/*.py` file), enumerates `app.routes` for routes that use `Depends(get_current_user)`, and asserts each protected route has a corresponding `*_401` test; the test fails when a new protected route ships without its 401 test. See Exercise 10 and [[11-Authentication-and-Security/Threat-Model-First]] for the threat-modelling angle.


### Lines 63–72: The `MissingGreenlet` demonstration

```python
@pytest.mark.asyncio
async def test_missing_greenlet_when_lazy_loading(client, session):
 """WITHOUT selectinload, accessing user.org in the serializer triggers
 MissingGreenlet. WITH selectinload, it does not."""
 # This test is the demonstration — the assertion is "no exception".
 r = await client.post("/users", json={"email": "u@e.st", "password": "longenough"})
 assert r.status_code == 201
 # The route returned a UserRead with from_attributes=True. If UserRead
 # accessed user.org (lazy), we'd see MissingGreenlet here. The route
 # uses selectinload(User.org) — see boardly/routers/users.py.
 assert r.json()["email"] == "u@e.st"
```

**What it does:** POSTs a user, asserts 201, asserts the email. The interesting thing is what *does not* happen: the test does not raise `MissingGreenlet`.

**Why this test is in the lesson:** it is the negative-space demonstration of the most common async-test error. Without `selectinload`, the route's response serializer would access `user.org` (a lazy-loaded relationship), the lazy load would try to schedule a DB fetch in a sync context (the serializer is sync), and SQLAlchemy would raise `MissingGreenlet`. *With* `selectinload`, the relationship is already loaded — no lazy fetch, no `MissingGreenlet`. The test asserts the happy path (no exception).

**Why the test does not "demonstrate" the error:** it would be confusing to write a test that asserts `MissingGreenlet` is raised — that would be the bug, not the fix. The lesson's "Common Mistakes" section below shows the broken version side-by-side with the fix. The test in the suite is the *fixed* version — and the docstring explains what would happen without the fix.

**Student asks: why is `MissingGreenlet` not just called `SyncContextError` or `NoLoopError`?**

Because the name comes from `greenlet`, the C-extension library CPython uses under the hood to implement cooperative coroutines. A "greenlet" is the green-thread primitive; SQLAlchemy uses it to gate sync code paths and detect "you are calling sync ORM code from inside an async context". The error name is a leaky abstraction — it leaks the implementation. A more honest name would be `SyncORMCallInAsyncContextError`, but the existing name is the one you will see in tracebacks, so we keep it. The mental translation: when you see `MissingGreenlet`, read "a sync code path tried to touch the DB inside an async context, and there is no greenlet (i.e. no implicit sync-to-async bridge) to handle it". The fix is always one of: make the path async, eager-load so the path does not touch the DB, or move the data into memory before the sync path runs.


**Student asks: why does the loop have to be per-test — would a session-scoped loop be faster?**

Faster, yes — one loop build per session instead of per test. But it leaks state across tests in subtle ways that are hard to debug. The per-test loop's value is exactly that: at teardown, the loop drains pending tasks (timers, `asyncio.gather` stragglers, background tasks), closes, and the next test starts with a clean slate. A session-scoped loop accumulates state: timers from test A that were not awaited fire during test B; background tasks from test A keep running; an `AsyncClient` opened in test A and not closed binds to the session loop and tries to reuse connections in test B. The per-test loop's cost is ~1 ms of loop build per test — invisible. The debugging cost of a leaky session-scoped loop is hours of "why does test B fail only when run after test A". The trade-off is wildly asymmetric: pay the 1 ms, get isolation.


## Execution Trace: the three classic errors, decoded

Run the suite. With everything wired correctly, all tests pass. Now break each thing in turn and watch the error.

### Error 1: `RuntimeWarning: coroutine '...' was never awaited`

```python
# WRONG
@pytest.mark.asyncio
async def test_create_user_returns_201(client):
 r = client.post("/users", json={"email": "x@y.z", "password": "longenough"})
 # forgot `await`!
 assert r.status_code == 201
```

**Output:**

```
RuntimeWarning: coroutine 'AsyncClient.post' was never awaited
tests/test_async_endpoints.py::test_create_user_returns_201 FAILED
...
AttributeError: 'coroutine' object has no attribute 'status_code'
```

**What it means:** `client.post(...)` returned a coroutine object — the function was called but never scheduled. The `assert r.status_code` then fails because `r` is a coroutine, not a `Response`.

**The fix:** add `await`. `r = await client.post(...)`. Search the test for any line that calls an `async def` without `await` — that is the bug.

**Tip — The pattern: every `async def` you call must be awaited.**

If you see `RuntimeWarning: coroutine ... was never awaited`, you forgot an `await` somewhere. The fix is mechanical: find the call to the named coroutine, add `await`. Common culprits: `client.post` (should be `await client.post`), `session.commit` (should be `await session.commit`), `session.scalar` (should be `await session.scalar`).


### Error 2: `RuntimeError: Event loop is closed`

```python
# WRONG
@pytest_asyncio.fixture
async def client(session):
 # forgot `async with`!
 ac = AsyncClient(transport=ASGITransport(app=app), base_url="http://t")
 yield ac
 # no close!
```

**Output (on the *second* test that uses `client`):**

```
RuntimeError: Event loop is closed
...
 File ".../anyio/_backends/_asyncio.py", line ..., in open
 ...
```

**What it means:** the first test's event loop closed at teardown. The `AsyncClient` was created on that loop, kept its keepalive connections bound to the loop, and tried to reuse them on the second test's (different) loop. The loop is gone — `RuntimeError: Event loop is closed`.

**The fix:** use `async with AsyncClient(...) as ac: yield ac` so the client is closed at teardown. The `async with` `__aexit__` closes the client's connections before the loop closes. The rule: *every* async resource (`AsyncClient`, `AsyncSession`, `Redis`, `AsyncEngine`) must be opened with `async with` and closed at teardown.

**Warning — The pattern: close resources in the fixture's teardown.**

- `AsyncClient`: `async with AsyncClient(...) as ac: yield ac`
- `AsyncSession`: `async with AsyncSession(...) as sess: yield sess`
- `AsyncEngine`: `yield eng; await eng.dispose()` (the engine itself is not an `async with`, but it has `dispose()`)
- `redis.asyncio.Redis`: `yield redis; await redis.aclose()`

The general rule: if it has an `aclose()` or `dispose()` method, call it. If it is an `async context manager`, use `async with`. The lesson [[10-Async-Python/asyncio-Primitives]] has the deeper discussion of why async resources cannot outlive their loop.


### Error 3: `sqlalchemy.exc.MissingGreenlet`

```python
# WRONG — in the route
@router.post("/users", response_model=UserRead, status_code=201)
async def create_user(body: UserCreate, session: Annotated[AsyncSession, Depends(get_session)]):
 user = User(email=body.email, password_hash=hash_password(body.password))
 session.add(user)
 await session.commit()
 return user # ← UserRead accesses user.org (lazy) — MissingGreenlet!
```

**Output (when the test asserts `r.status_code == 201`):**

```
sqlalchemy.exc.MissingGreenlet: greenlet_spawn has not been called; can't
call `_setup_or_connect()` here. (Background on this error at:
https://sqlalche.me/e/20/xdcp)
```

**What it means:** SQLAlchemy async requires that every DB call happens inside an `await` chain. The response serializer (Pydantic, with `from_attributes=True`) accesses `user.org` — a lazy-loaded relationship. The lazy load is sync; there is no async context to schedule it in; SQLAlchemy raises.

**The three classic triggers:**

1. **Lazy-loading a relationship in a sync context.** You return an ORM object from a route; FastAPI serializes it via Pydantic; Pydantic accesses `user.org` — lazy, sync, trigger.
2. **`expire_on_commit=True` (the default) + accessing an attribute after `await session.commit()`.** The access triggers a re-fetch; the re-fetch needs an async context; the request handler is already past the await.
3. **A background task started in the request scope tries to use the request's session.** The request is done; the loop has moved on; the session is closed.

**The three fixes:**

```python
# Fix 1: Eager-load relationships before returning
from sqlalchemy.orm import selectinload
stmt = select(User).options(selectinload(User.org)).where(User.id == user_id)
user = await session.scalar(stmt)
# user.org is already in memory; no lazy fetch in the serializer

# Fix 2: Set expire_on_commit=False (the test fixture does this)
sess = AsyncSession(bind=conn, expire_on_commit=False)

# Fix 3: Background tasks create their own sessions
async def background_work():
 async with AsyncSession(engine) as session:
 ...
# Do NOT pass the request-scoped session to a background task.
```

**Danger — `MissingGreenlet` is the symptom, not the disease.**

The disease is "a sync code path tried to touch the DB". The symptom is `MissingGreenlet`. The fix is always one of: (a) make the path async, (b) eager-load so the path does not need to touch the DB, or (c) make the data already-in-memory so the path does not need to touch the DB. The lesson [[07-SQLAlchemy/07-Async-SQLAlchemy]] has the canonical explanation; we are looking at it here from the testing angle.


```mermaid
flowchart TD
 Test["async def test_X(client)"]
 Marker["@pytest.mark.asyncio<br/>wraps the test in a loop"]
 Loop["Fresh event loop"]
 Fix["Fixtures resolve<br/>engine, session, client — all async"]
 Body["Test body runs<br/>await client.post(...)<br/>await session.scalar(...)"]
 ASGI["ASGITransport<br/>drives app in-process"]
 Deps["Depends resolver<br/>uses overrides"]
 Route["Route handler<br/>await session.add; await commit"]
 Save["SAVEPOINT released<br/>(not committed to DB)"]
 Assert["Test asserts on r.status_code, r.json(), session"]
 Done["Teardown<br/>rollback outer txn; close client; clear overrides"]

 Test --> Marker
 Marker --> Loop
 Loop --> Fix
 Fix --> Body
 Body --> ASGI
 ASGI --> Deps
 Deps --> Route
 Route --> Save
 Save --> ASGI
 ASGI --> Body
 Body --> Assert
 Assert --> Done

 style Marker fill:#fff3cd,stroke:#ffc107
 style Save fill:#d4edda,stroke:#28a745
 style Done fill:#f8d7da,stroke:#dc3545
```

The diagram shows the full lifecycle of one async test: marker wraps the test in a loop; fixtures resolve on the loop; the test body drives the app via `ASGITransport`; the route commits through the SAVEPOINT; the test asserts; teardown rolls back, closes, clears. The loop is per-test — no leakage.

## Common Mistakes

### Mistake 1: Strict mode without the marker

```python
# WRONG (in strict mode)
async def test_create_user_returns_201(client):
 ...
```

**Symptom:** pytest collects the test, the body never runs. On pytest 8.0–8.3, the test is reported as `SKIPPED` with a `PytestUnhandledCoroutineWarning` ("async def functions are not natively supported and have been skipped"). On pytest 8.4+ (and pytest 9), the test is reported as `FAILED` with the same message plus a hint to install `pytest-asyncio` (or `anyio`, `pytest-trio`, `pytest-tornasync`, `pytest-twisted`). Very old versions (`pytest-asyncio` ≤ 0.20, before strict mode was the default) silently `PASSED` — the body returned a coroutine, pytest treated the non-None return as no-assertion, and the green check was a lie. That silent-PASSED behavior is gone for modern `pytest-asyncio`; the failure is loud, just confusing until you know what to look for.

**Why:** in strict mode (the default in `pytest-asyncio` 0.21+), `async def test_*` without `@pytest.mark.asyncio` is not claimed by the plugin. pytest core sees an `async def` function it cannot drive and either skips it (8.0–8.3) or fails it outright (8.4+). The body never executes either way.

**Fix:** add `@pytest.mark.asyncio`. Or switch to auto mode (`asyncio_mode = "auto"` in `pyproject.toml`) — but auto is a footgun for suites with sync tests.

### Mistake 2: `@pytest.fixture` on an `async def` fixture

```python
# WRONG
@pytest.fixture
async def client(session):
 async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
 yield ac
```

**Symptom:** the test gets an `async_generator` object instead of the client. `AttributeError: 'async_generator' object has no attribute 'post'` (because the fixture uses `yield`, making it an async generator function, not a plain coroutine function). On pytest 9+ the failure moves earlier — the test errors at setup with `Failed: '...' requested an async fixture 'client', with no plugin or hook that handled it. This is an error, as pytest does not natively support it.`

**Why:** `@pytest.fixture` (the sync decorator) does not know about async. It calls the function, gets an `async_generator` object back (because of the `yield`), and passes that raw object to the test instead of an `AsyncClient`. The test expects a client; it gets the unstarted generator. For an `async def` fixture without `yield`, the parallel symptom is `'coroutine' object has no attribute 'post'` plus a `RuntimeWarning: coroutine '...' was never awaited`.

**Fix:** use `@pytest_asyncio.fixture`. The async-aware decorator schedules the generator on the loop, drives the `yield`, extracts the yielded value (the `AsyncClient`), and passes that value (not the generator) to the test.

### Mistake 3: Not closing resources in teardown

```python
# WRONG
@pytest_asyncio.fixture
async def client(session):
 ac = AsyncClient(transport=ASGITransport(app=app), base_url="http://t")
 yield ac
 # no `async with`, no `await ac.aclose()`
```

**Symptom:** `RuntimeError: Event loop is closed` on the *second* test that uses `client`.

**Why:** the first test's loop closed at teardown. The `AsyncClient` was created on that loop and tried to reuse its keepalive connections on the second test's loop.

**Fix:** use `async with AsyncClient(...) as ac: yield ac`. The `async with` `__aexit__` closes the client at teardown. The rule for every async resource: open with `async with`, yield, close at teardown.

### Mistake 4: `expire_on_commit=True` (default) + accessing attributes after commit

```python
# WRONG (in the fixture)
sess = AsyncSession(bind=conn) # expire_on_commit defaults to True
```

**Symptom:** `MissingGreenlet` from the response serializer.

**Why:** after `await session.commit()`, every attribute access on the ORM object triggers a re-fetch. The re-fetch needs an async context; the serializer (sync, in Pydantic's `from_attributes=True` path) does not have one.

**Fix:** set `expire_on_commit=False`. The objects stay in memory after commit; no re-fetch; no `MissingGreenlet`. The fixture in this lesson does this — `AsyncSession(bind=conn, expire_on_commit=False)`.

### Mistake 5: Lazy-loading relationships in the response model

```python
# WRONG (in the route)
return user # UserRead accesses user.org, which is lazy
```

**Symptom:** `MissingGreenlet` from the response serializer when it accesses `user.org`.

**Why:** Pydantic's `from_attributes=True` walks the ORM object's attributes. `user.org` is a lazy-loaded relationship — accessing it triggers a DB fetch, which needs an async context.

**Fix:** use `selectinload(User.org)` (or `joinedload(User.org)`) in the route's query to eager-load the relationship. The serializer then accesses the already-loaded value, no lazy fetch.

```python
# RIGHT (in the route)
stmt = select(User).options(selectinload(User.org)).where(User.id == user_id)
user = await session.scalar(stmt)
return user
```

### Mistake 6: Sharing a session across tests via a background task

```python
# WRONG
async def background_work(session): # ← receives the request's session
 await session.execute(...) # the request is done; the session is closed
```

**Symptom:** `RuntimeError: ... closed` or `MissingGreenlet` from the background task.

**Why:** the request scope's session is closed at the request's end. A background task started in the request scope outlives the request — it tries to use a closed session.

**Fix:** background tasks create their own sessions. `async with AsyncSession(engine) as session: ...` inside the task body. Do not pass the request's session into a background task.

### Mistake 7: `event_loop` fixture with the wrong scope (legacy)

```python
# WRONG (legacy, removed in pytest-asyncio 0.24+)
@pytest.fixture(scope="session")
def event_loop():
 import asyncio
 loop = asyncio.new_event_loop()
 yield loop
 loop.close()
```

**Symptom:** `pytest-asyncio` errors with "event_loop fixture has been moved" or "scope mismatch". Or, worse, function-scoped fixtures leak onto a session-scoped loop and the suite becomes flaky.

**Why:** the `event_loop` fixture was user-overridable before `pytest-asyncio` 0.23. The 0.23 release deprecated it; 0.24 removed it. The motivation: a session-scoped loop with function-scoped fixtures was the cause of "Event loop is closed" — the fixtures outlived the loop.

**Fix:** remove the `event_loop` fixture entirely. Let `pytest-asyncio` manage the loop. The default (per-function loop) is the only safe choice for most suites.

### Mistake 8: Forgetting the `anyio_backend` fixture when using `anyio`

```python
# WRONG
@pytest.mark.anyio
async def test_with_anyio(client):
 ...

# without:
# @pytest.fixture
# def anyio_backend():
# return "asyncio"
```

**Symptom:** the test is silently skipped. `pytest --co` lists it; `pytest -v` reports `SKIPPED`.

**Why:** `anyio`'s pytest plugin requires the `anyio_backend` fixture to know which runtime to use. Without it, the plugin skips the test (it cannot decide between asyncio and trio).

**Fix:** define `anyio_backend` in `conftest.py` (as we did above). Or switch to `pytest-asyncio` if you do not need multi-runtime.

## Engineering Trade-Offs

### `pytest-asyncio` strict vs auto

| Aspect | strict (default) | auto |
|---|---|---|
| Marker | per-test `@pytest.mark.asyncio` | none (auto-detected) |
| Boilerplate | medium | zero |
| Risk | low — explicit | medium — every `async def test_*` is async |
| Greppability | high (you can grep for the marker) | low |

Strict is safer. Auto is for large async-only suites where the per-test marker feels like noise. The default (strict) is the right choice for new projects.

### `pytest-asyncio` vs `anyio`

| Aspect | `pytest-asyncio` | `anyio` plugin |
|---|---|---|
| Marker | `@pytest.mark.asyncio` | `@pytest.mark.anyio` + `anyio_backend` fixture |
| Multi-runtime | no (asyncio only) | yes (asyncio or trio) |
| Popularity | more common | less common |
| Use for | typical asyncio apps | libraries that must run on both asyncio and trio |

Both work. `pytest-asyncio` is the more common choice; `anyio` if you care about multi-runtime portability. Do not mix in the same suite — pick one.

### Per-test event loop vs session loop

| Aspect | per-test (default) | session-scoped (legacy) |
|---|---|---|
| Safety | highest (no leak between tests) | low (one test's leak kills the rest) |
| Speed | baseline | faster (one loop startup) |
| Feasibility | supported | removed in `pytest-asyncio` 0.24+ |

Per-test is safer and the only modern choice. Session-scoped loops are gone in current `pytest-asyncio`.

### `AsyncClient` + `ASGITransport` vs real `uvicorn` subprocess

| Aspect | `ASGITransport` | real `uvicorn` |
|---|---|---|
| Speed | fast (in-process) | slow (subprocess, port, network) |
| Determinism | high | lower (network, port allocation) |
| Catches | route logic, dependency resolution, middleware | everything ASGITransport does + server-level concerns (uvicorn config, workers) |
| Use for | 95 % of tests | smoke tests, deploy-time checks |

`ASGITransport` for the 95 %. Real `uvicorn` for the 5 % that test server-level concerns. The lesson [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]] has the deeper comparison.

### `selectinload` vs `joinedload` for eager loading

| Aspect | `selectinload` | `joinedload` |
|---|---|---|
| Strategy | second SELECT with `WHERE id IN (...)` | JOIN in the original SELECT |
| N+1 fix | yes | yes |
| Card product | O(N) — one extra SELECT | O(1) — one JOIN |
| Use when | N is small; collection relationships | one-to-one or many-to-one |

`selectinload` for collections (avoids Cartesian products); `joinedload` for many-to-one. The lesson [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]] has the full discussion.

## Exercises

**Tip — The 20-minute rule**

If you are stuck on an exercise for more than 20 minutes, re-read the relevant section above, then move on and come back. Learning is not linear.


**Exercise 1 — Trigger the no-marker failure.** Delete the `@pytest.mark.asyncio` marker from one test. Run `uv run pytest -v`. Observe that the test reports `SKIPPED` (pytest 8.0–8.3, with a `PytestUnhandledCoroutineWarning`) or `FAILED` (pytest 8.4+, with the message "async def functions are not natively supported"). Restore the marker. Confirm the test runs.

**Exercise 2 — Trigger `Event loop is closed`.** Modify the `client` fixture to *not* use `async with` (just `ac = AsyncClient(...); yield ac; # no close`). Run the suite. The second test that uses `client` should fail with `RuntimeError: Event loop is closed`. Restore the `async with`. Confirm the suite passes.

**Exercise 3 — Trigger `MissingGreenlet`.** In the route (`boardly/routers/users.py`), remove the `selectinload(User.org)` from the query. Add a `org: OrgRead` field to `UserRead`. Run the suite. The `test_create_user_returns_201_and_persists` test should fail with `MissingGreenlet`. Restore the `selectinload`. Confirm the test passes.

**Exercise 4 — Trigger `coroutine was never awaited`.** In one test, change `r = await client.post(...)` to `r = client.post(...)` (drop the `await`). Run. Observe `RuntimeWarning: coroutine 'AsyncClient.post' was never awaited` and `AttributeError: 'coroutine' object has no attribute 'status_code'`. Restore the `await`. Confirm the test passes.

**Exercise 5 — Run a real `uvicorn` smoke test.** Write a test that starts a real `uvicorn` subprocess (using `subprocess.Popen`), waits for it to be healthy (poll `/healthz`), runs one request through the real socket, then kills the subprocess. Compare the test's runtime to the `ASGITransport` version. The difference is the cost of "real server" tests. (Expected: the subprocess test takes ~500ms-1s of startup + ~5ms of request; the `ASGITransport` version takes ~5ms total. Keep the subprocess flavour for one e2e test only — the rest of the suite stays on the in-process transport.)

**Exercise 6 — Concurrency stress test.** Write a test that runs 50 concurrent POSTs with `asyncio.gather` and asserts they all return 201 with distinct emails. Use `asyncio.Semaphore(10)` to limit concurrency to 10 at a time (otherwise the DB pool may exhaust). This is the integration test for the SAVEPOINT pattern.

**Exercise 7 — Migrate to `anyio`.** Add the `anyio_backend` fixture to `conftest.py` (we did, above). Change one test's marker from `@pytest.mark.asyncio` to `@pytest.mark.anyio`. Run the suite. Confirm both kinds of tests work side-by-side. The lesson is that `pytest-asyncio` and `anyio` are interoperable in the same suite — but you should pick one for consistency.

**Exercise 8 — Pool-exhaustion test.** Write a test that fires 50 concurrent requests via `asyncio.gather` (each acquiring a session through the route's `get_session` override) and asserts the engine's `pool.status().checked_out` counter never exceeds `pool_size + max_overflow`. Trigger the bug by adding a middleware that holds a session checkout for 100 ms (simulating a leaked checkout). Verify: `uv run pytest tests/test_async_endpoints.py::test_pool_exhaustion -v -s` — the test should fail (assertion error on `checked_out > pool_size + max_overflow`) until you remove the leaked middleware checkout. This catches the production-only pool-exhaustion bug that the per-test one-connection pattern (above) hides.

**Exercise 9 — SAVEPOINT-released-by-rollback test.** Write a test that calls a route which issues `await session.rollback()` mid-request (to "undo its own partial work"). Assert that the next `session.add(...)` in the same route raises `InvalidRequestError: this Session's transaction has been rolled back` — meaning the SAVEPOINT was released by the rollback and no new SAVEPOINT was opened. Fix by re-establishing the SAVEPOINT after the route's rollback (`await sess.begin_nested()` in the override's session wrapper, or in the route itself). Verify: `uv run pytest tests/test_async_endpoints.py::test_savepoint_released_by_rollback -v -s` — the test should fail before the fix, pass after.

**Exercise 10 — Contract test for protected routes.** Write `test_every_protected_route_has_a_401_test` that scans `tests/` for `*_401` test functions (using `ast.parse` on each `tests/**/*.py` file), enumerates `app.routes` for routes that use `Depends(get_current_user)`, and asserts each protected route has a corresponding `*_401` test. Add a new protected route without a 401 test. Verify: `uv run pytest tests/test_async_endpoints.py::test_every_protected_route_has_a_401_test -v` — the test should fail with a list of routes missing their 401 test. Add the 401 test, confirm the contract test passes. This is the security primitive that catches a deleted or missing 401 test.

**Exercise 11 — `MissingGreenlet` in `StreamingResponse`.** Write a route that streams 10,000 rows via `StreamingResponse` and accesses `user.org` (a lazy-loaded relationship) inside the sync iterator. Run the test. Verify: `uv run pytest tests/test_async_endpoints.py::test_streaming_response_missing_greenlet -v -s` — the test should fail with `MissingGreenlet` from inside the iterator (because the iterator is sync, the session is closed after the route's `await session.commit()` returns, and the lazy load has no async context). Fix by calling `selectinload(User.org)` before the stream starts (in the route) and asserting the test passes. This catches the production-only `MissingGreenlet` that the per-test `expire_on_commit=False` fixture hides.

**Exercise 12 — Flake amplification with `pytest-repeat`.** Install `pytest-repeat` (`uv add --dev pytest-repeat`). Run the concurrency test 100 times: `uv run pytest tests/test_async_endpoints.py::test_concurrent_signups_are_isolated --count=100 -v`. Confirm no flake (all 100 pass). Measure the runtime: it should be approximately 100x the single-test runtime. If it is significantly higher (e.g. 200x), there is a leak — find it with `tracemalloc`: add `import tracemalloc; tracemalloc.start()` to `conftest.py`, run the test, and inspect `tracemalloc.get_traced_memory()` at teardown. Verify: `uv run pytest tests/test_async_endpoints.py::test_concurrent_signups_are_isolated --count=100 -v` exits 0.

**Exercise 13 — Hang detection with `pytest-timeout`.** Install `pytest-timeout` (`uv add --dev pytest-timeout`). Add `--timeout=10` to `pyproject.toml`'s `addopts`. Write a test that hangs: `await asyncio.sleep(30)` in the body. Verify: `uv run pytest tests/test_async_endpoints.py::test_hang_detected_by_timeout -v` — the test should fail with `TimeoutError` after 10 seconds (not 30), and the traceback should point at the hang location (the `asyncio.sleep` line). Remove the hang, confirm the test passes. This catches the production-only hang that no per-test loop isolation can detect.

## Verification

Run the suite:

```bash
# Install dev dependencies
uv add --dev pytest pytest-asyncio anyio
uv add fastapi sqlalchemy asyncpg httpx

# Confirm async tests are detected and run
uv run pytest --collect-only -q | rg "test_create_user"
# If "test_create_user" appears but is reported as SKIPPED, the asyncio
# marker is missing or asyncio_mode is wrong.

# Run a single async test with full output
uv run pytest tests/test_async_endpoints.py::test_get_users_me_returns_200 -v -s

# Watch for the three classic errors:
uv run pytest 2>&1 | rg "MissingGreenlet|Event loop is closed|coroutine was never awaited"
# Empty output = healthy.

# Run with the concurrency test verbose
uv run pytest tests/test_async_endpoints.py::test_concurrent_signups_are_isolated -v -s

# Filter to just the async tests
uv run pytest -k "async" -v
# (If you used `async` in the test names; otherwise use -k "test_create_user"
# or similar)
```

Expected: 5 tests pass; coverage on the routes tested is non-zero; no `MissingGreenlet`, no `Event loop is closed`, no `coroutine was never awaited`.

**Debugging tips.**

- `--asyncio-mode=strict` on the CLI overrides the `pyproject.toml` setting — useful for "is this test being scheduled?"
- `pytest --asyncio-mode=auto` runs every `async def test_*` as async, even without the marker — useful for "was the marker missing?"
- `pytest -p no:asyncio` *disables* `pytest-asyncio` — useful for "what would happen without the plugin?" (Spoiler: modern pytest reports `SKIPPED` or `FAILED` with a clear message — no silent passes.)
- For flaky concurrency tests, run with `pytest --count=100` (needs `pytest-repeat`) to amplify the flake.
- For "this test sometimes hangs", add `--timeout=10` (needs `pytest-timeout`) — the hang becomes a failure with a traceback.


## Previously Learned Here

These concepts were taught in earlier lessons. We link back instead of re-explaining:

- **Event loop and coroutines** — [[10-Async-Python/Event-Loop-and-Coroutines]]. The loop that `pytest-asyncio` creates is the same primitive; the plugin just schedules your test on it. If `await` still feels magical, revisit.
- **`Depends` and `dependency_overrides`** — [[03-FastAPI-Core/Dependency-Injection]] and [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]]. The `client` fixture's override dict is the framework-level seam; the canonical explanation is in Lesson 02.
- **Async SQLAlchemy** — [[07-SQLAlchemy/07-Async-SQLAlchemy]]. `MissingGreenlet` is the canonical async-SQLAlchemy error; this lesson looks at it from the testing angle.
- **`pytest` fundamentals** — [[01-Python-Foundations/pytest-Fundamentals]]. The fixtures, scopes, and parametrize from there all apply here; the only addition is `async`.
- **`asyncio` primitives** — [[10-Async-Python/asyncio-Primitives]]. `asyncio.gather` in the concurrency test is from there.

## What's Next

In [[12-Testing-and-Quality/Testing-Database-Logic]] we move from "test the async endpoint" to "test the SQL itself". The `session` fixture's SAVEPOINT trick is the foundation; that lesson explains it in depth and adds the migration-test job (`alembic upgrade head` against a fresh DB in CI). We will:

- Build the transaction-rollback pattern in full — why `begin_nested()` is the right SAVEPOINT API, why the outer transaction is on the connection not the session, and what "the route's commit hits the SAVEPOINT" actually means at the SQL level.
- Build the isolated test database — a separate PostgreSQL, not SQLite, with the schema created by Alembic migrations (not by `Base.metadata.create_all`).
- Build the seeding fixtures (`make_user`, `make_org`) that compose with the session.
- Build the migration-test job that runs `alembic upgrade head` and `alembic downgrade -1` against a fresh DB, in CI.

By the end of that lesson, `Boardly` will have a complete DB-test suite — the substrate that catches the BOLA, cascade, and constraint bugs that pure-logic tests miss. And the async tests from this lesson will be the integration tier of the test pyramid.

## Sources

- **`pytest-asyncio`** — <https://github.com/pytest-dev/pytest-asyncio> — accessed 2026-10-19 — strict/auto mode, `@pytest_asyncio.fixture`, the `event_loop` deprecation and removal in 0.23/0.24. Verified for the latest version (Oct 2026).
- **`anyio` pytest plugin** — <https://anyio.readthedocs.io/en/stable/testing.html> — accessed 2026-10-19 — alternative framework, `anyio_backend` fixture.
- **SQLAlchemy async testing** — <https://docs.sqlalchemy.org/en/20/orm/extensions/asyncio.html> — accessed 2026-10-19 — the source of the `MissingGreenlet` explanation and the SAVEPOINT pattern.
- **"Async testing in FastAPI"** — <https://fastapi.tiangolo.com/advanced/async-tests/> — accessed 2026-10-19 — the canonical FastAPI approach.
- **httpx `ASGITransport`** — <https://www.python-httpx.org/async/> — accessed 2026-10-19 — the in-process transport.
- **"MissingGreenlet: greenlet_spawn has not been called"** — <https://docs.sqlalchemy.org/en/20/errors.html#error-xdcp> — accessed 2026-10-19 — the canonical SQLAlchemy error explanation.
- **`pytest-asyncio` migration guide (0.23)** — <https://github.com/pytest-dev/pytest-asyncio/releases/tag/v0.23.0> — accessed 2026-10-19 — the `event_loop` deprecation.
- **PEP 492 — `async`/`await`** — <https://peps.python.org/pep-0492/> — accessed 2026-10-19 — the syntax that all of this builds on.

## What We Learned

Let's recap. In this lesson you:

- **Built the async test fixtures for `Boardly`** — `engine` (session-scoped, creates tables), `session` (per-test, SAVEPOINT rollback), `client` (per-test, overrides `get_session` and `get_current_user`).
- **Learned the `pytest-asyncio` plugin** — strict mode (the default), the `@pytest.mark.asyncio` marker, the `@pytest_asyncio.fixture` decorator for async fixtures, and why `@pytest.fixture` on `async def` is a footgun.
- **Learned the `event_loop` fixture's history** — user-overridable before 0.23, deprecated in 0.23, removed in 0.24. Modern code lets `pytest-asyncio` manage the loop; you do not.
- **Drove the async FastAPI app from tests** with `httpx.AsyncClient` + `ASGITransport` — no socket, no port, no `uvicorn` subprocess.
- **Wired the async DB session** with the SAVEPOINT rollback pattern, so each test runs in isolation and the route's `commit()` does not pollute the next test.
- **Diagnosed the three classic async-test errors** — `coroutine was never awaited` (missing `await`), `Event loop is closed` (resource not closed in teardown), `MissingGreenlet` (sync code path touched the DB).
- **Ran concurrent requests** with `asyncio.gather` and asserted they do not collide — the integration test that catches the "single session per app" bug.
- **Hit and fixed the eight classic async-test mistakes** — strict mode without the marker, `@pytest.fixture` on `async def`, missing teardown, `expire_on_commit=True`, lazy-loading in the response model, sharing sessions across tests via background tasks, the legacy `event_loop` fixture, and the missing `anyio_backend`.

Here's the mental model to walk away with: *a sync test runner cannot run an async test. The bridge is a plugin (`pytest-asyncio` or `anyio`) that wraps each async test, spins up an event loop, schedules the coroutine, drains pending tasks, tears the loop down. The loop is per-test by default — no leakage. Every async resource (`AsyncClient`, `AsyncSession`, `AsyncEngine`, `Redis`) must be opened with `async with` and closed at teardown, or you get `Event loop is closed`. Every DB access must be inside an `await` chain, or you get `MissingGreenlet`. Every `async def` you call must be awaited, or you get `RuntimeWarning: coroutine was never awaited`. Three errors, three fixes. Once you can read each in 30 seconds, async tests stop being scary — they are just sync tests with a loop.*

---

> A note from your teacher
You just built the async half of the test pyramid. Sit with that. Five async tests, three fixtures, one `conftest.py`. The browser sends a POST; the `AsyncClient` hands it to `ASGITransport`; FastAPI resolves the dependencies (with overrides); the route runs; the SAVEPOINT absorbs the commit; the test asserts; the teardown rolls back, closes, clears. That is the whole of async endpoint testing, scaled up. We are going to test the SQL itself next, then the CI pipeline that runs all of it on every push. But the async floor you wrote today stays the same. See you in Lesson 05.


---

**Tags:** #testing #async #pytest #pytest-asyncio #review
**Previous:** [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]]
**Next:** [[12-Testing-and-Quality/Testing-Database-Logic]] →

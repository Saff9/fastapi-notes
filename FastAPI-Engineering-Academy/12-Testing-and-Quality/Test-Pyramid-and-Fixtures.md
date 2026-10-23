---
title: "Lesson 01: Test Pyramid and Fixtures"
aliases:
 - Test-Pyramid-and-Fixtures
 - Test Pyramid
 - Fixtures
 - conftest
 - Parametrize
tags:
 - testing
 - pytest
 - fixtures
 - test-pyramid
 - lesson
course_level: intermediate
status: complete
difficulty: intermediate
estimated_time: "90 minutes"
prerequisites:
 - "[[01-Python-Foundations/pytest-Fundamentals]]"
 - "[[01-Python-Foundations/Iterators-Generators-Context-Managers]]"
 - "[[03-FastAPI-Core/Dependency-Injection]]"
 - "[[07-SQLAlchemy/05-Session-and-Transaction-Management]]"
related_lessons:
 - "[[Testing-FastAPI-Endpoints]]"
 - "[[Testing-Database-Logic]]"
 - "[[Async-Testing]]"
 - "[[CI-Pipelines]]"
---

# Lesson 01: Test Pyramid and Fixtures

*Where `Boardly` gets the shape of its test suite, the `conftest.py` files that drive it, and the fixture-design discipline that keeps a 2000-test suite running in 5 seconds.*

**The shape of your test suite is more important than the count.**

A 2000-test suite with 100 integration tests and 1900 unit tests runs in 5 seconds. The same 2000 tests flipped — 1900 integration, 100 unit — runs in 20 minutes and is flaky. This lesson is the design discipline that keeps suites fast, fixtures reusable, and the parameterization that lets one test cover a dozen cases.


#testing #pytest #fixtures #test-pyramid

## Learning Objectives

By the end of this lesson you will be able to:

1. **Decide whether a given test belongs as unit, integration, or e2e** — and explain why the *shape* of the suite matters more than the count.
2. **Choose fixture scope** (`function`, `module`, `session`) and explain the trade-off between speed and cross-test contamination.
3. **Design `conftest.py` files** at multiple levels of the directory tree — and explain why the project-root `conftest.py` with all fixtures is an anti-pattern.
4. **Use `parametrize` and marks** (`slow`, `integration`, `e2e`) to control which tests run when — with `--strict-markers` so typos fail loudly.
5. **Compose fixtures** the way you compose `Depends` in FastAPI — fixture-as-argument, with the per-request cache replaced by pytest's per-test cache.
6. **Decide between hand-built fixture data, factories, and `model_bakery` / `factory_boy`** — and explain when each is the right choice.
7. **Use `autouse` sparingly** — invisible side effects are a debugging tax.

## Prerequisites

Before starting, you need:

- **`pytest` basics** — [[01-Python-Foundations/pytest-Fundamentals]]. `def test_*`, `assert`, `pytest.raises`. If you have never written a pytest, that lesson is the entry point.
- **Iterators and context managers** — [[01-Python-Foundations/Iterators-Generators-Context-Managers]]. A fixture is a generator with a `yield`. Setup before `yield`, teardown after. If `@contextmanager` and `yield` together make no sense to you, go back and review.
- **`Depends`** — [[03-FastAPI-Core/Dependency-Injection]]. pytest fixtures and FastAPI dependencies share the same `Annotated`-style composability mindset. The patterns rhyme.
- **`AsyncSession`** — [[07-SQLAlchemy/05-Session-and-Transaction-Management]]. The DB session is the substrate for the transaction-rollback pattern (Lesson 03 here).

**The single most common gap: "I'll just use `unittest.mock` for everything".**

`unittest.mock.patch` works, but it is brittle — you patch what a module *imports*, not what the framework *resolves*. FastAPI gives you `app.dependency_overrides` (Lesson 02) for *dependencies* — a framework-level seam that survives refactors. Use mocks for side-effect libraries (`boto3.client` constructed inside a function); use overrides for `Depends`-style dependencies. The rule: if the framework resolves it, override; if the code instantiates it, mock.


## The Problem

`Boardly` now has auth (Section 11) and a real `User`/`RefreshToken`/`PasswordResetToken` schema. Every endpoint has a security-test matrix (Lesson 11.04) — six tests per protected endpoint. Every service has at least one integration test against a real database. The migrations need to be tested in CI (Lesson 03 here).

A naive test suite would: have each test set up its own database rows (slow), share a single transaction across tests (flaky — test A's row leaks into test B), use `unittest.mock.patch` for everything (brittle — patches break on refactor), and not distinguish unit from integration (every test takes a second, the suite takes 20 minutes).

The right test suite is *architected*. Fixtures are the architecture. The shape of the suite (the pyramid) is the design. This lesson is both.

## The Code

Here is the complete `tests/conftest.py` for `Boardly` — the substrate for the rest of the section. Read it; we dissect every line after.

```python
# tests/conftest.py
"""Pytest configuration for Boardly.

Lesson 12.01: session-scoped engine + function-scoped session wrapped
in a transaction that rolls back + per-test client with overridden
dependencies. The fixtures compose: client -> session -> engine.
"""
from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from boardly.config import Settings
from boardly.db import Base, get_session
from boardly.main import app

TEST_DB_URL = "postgresql+asyncpg://test:test@localhost:5432/test_boardly"


# --- session-scoped: built once per pytest invocation -----------------

@pytest.fixture(scope="session")
def anyio_backend() -> str:
 """Required by the anyio plugin if you use it instead of pytest-asyncio.
 We use pytest-asyncio in strict mode, so this is here as documentation."""
 return "asyncio"


@pytest.fixture(scope="session")
async def engine():
 """The async engine. Built once per session. Schema is dropped & recreated."""
 eng = create_async_engine(TEST_DB_URL, echo=False, future=True)
 async with eng.begin() as conn:
 await conn.run_sync(Base.metadata.drop_all)
 await conn.run_sync(Base.metadata.create_all)
 yield eng
 await eng.dispose()


# --- function-scoped: built per test, rolled back at teardown ---------

@pytest.fixture
async def session(engine) -> AsyncIterator[AsyncSession]:
 """Per-test session. Wrapped in a transaction that rolls back.

 The application code can `await session.commit()` — but its commits
 hit the savepoint, not the outer transaction. At teardown, the outer
 rollback discards everything. This is the transaction-rollback
 pattern (Lesson 12.03 in detail).
 """
 async with engine.connect() as conn:
 await conn.begin() # outer transaction
 sess = AsyncSession(bind=conn, expire_on_commit=False)
 await sess.begin_nested() # SAVEPOINT — application commits hit this
 yield sess
 await sess.close()
 await conn.rollback() # discards everything


@pytest.fixture
async def client(session) -> AsyncIterator[AsyncClient]:
 """Per-test httpx client. Session is overridden so the app uses our test session."""
 async def _override_session() -> AsyncSession:
 return session
 app.dependency_overrides[get_session] = _override_session
 async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
 yield ac
 app.dependency_overrides.clear() # CRITICAL — see Common Mistake #1


# --- factory fixtures: callable that builds rows per test -----------

@pytest.fixture
def make_user(session):
 """Returns an async callable that creates a persisted User.
 The rows are in the per-test session — rolled back at teardown."""
 from boardly.models import User
 from boardly.security.passwords import hash_password

 async def _make(**overrides) -> User:
 defaults = {
 "email": "u@example.com",
 "password_hash": hash_password("secretsecret"),
 "is_active": True,
 "scopes": ["read:users"],
 }
 defaults.update(overrides)
 user = User(**defaults)
 session.add(user)
 await session.flush() # assigns user.id without committing
 return user
 return _make


@pytest.fixture
def make_org(session, make_user):
 """Returns a callable that creates an Org + owner + members."""
 from boardly.models import Org, OrgMembership

 async def _make(*, name="acme", members=(), owner=None) -> Org:
 owner = owner or await make_user(email="owner@example.com")
 org = Org(name=name, owner_id=owner.id)
 session.add(org)
 await session.flush()
 for m in members:
 session.add(OrgMembership(org_id=org.id, user_id=m.id, role="member"))
 await session.flush()
 return org
 return _make


# --- settings: pinned for tests, never reads .env -------------------

@pytest.fixture
def settings() -> Settings:
 """Pinned settings for tests. Never reads .env."""
 return Settings(
 jwt_secret="test-secret-32-bytes-do-not-use-in-prod!",
 jwt_iss="boardly-test",
 jwt_aud="boardly-test-api",
 env="test",
 )
```

And here is the `pyproject.toml` configuration that makes `pytest-asyncio` strict mode + `--strict-markers` the default.

```toml
# pyproject.toml — excerpt
[tool.pytest.ini_options]
asyncio_mode = "strict"
markers = [
 "slow: long-running tests, skipped on pre-commit",
 "integration: tests that touch a real DB or Redis",
 "e2e: end-to-end tests through the full stack",
]
addopts = "-ra --strict-markers --strict-config"
```

Read both. Then read the dissection below — every line gets a *what* / *why* / *what-Python-or-the-framework-does-internally*.

## Line-by-Line Deep Dive

### Lines 1–10: Docstring and imports

```python
"""Pytest configuration for Boardly.

Lesson 12.01: session-scoped engine + function-scoped session wrapped
in a transaction that rolls back + per-test client with overridden
dependencies. The fixtures compose: client -> session -> engine.
"""
from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from boardly.config import Settings
from boardly.db import Base, get_session
from boardly.main import app
```

**What it does:** Pulls in the types and frameworks the fixtures need.

**Why each import:**

- `AsyncIterator` — for the return-type annotation on the generator fixtures. From `collections.abc`, not `typing` (the modern form, Python 3.9+).
- `pytest` — the test framework itself. We use `@pytest.fixture` to declare fixtures.
- `httpx` — the HTTP client we use to drive the FastAPI app. `ASGITransport` drives the ASGI app in-process; `AsyncClient` is the async HTTP client.
- `sqlalchemy.ext.asyncio` — the async ORM. `AsyncSession` is the session type; `create_async_engine` builds the engine.
- `boardly.config.Settings` — the Pydantic Settings class. Pinned for tests so they don't read `.env`.
- `boardly.db.Base, get_session` — the `DeclarativeBase` subclass (used to drop & recreate the schema) and the `get_session` dependency (the override target).
- `boardly.main.app` — the FastAPI app instance. We override dependencies on it; we drive it via `ASGITransport`.

### Lines 17–22: `anyio_backend`

```python
@pytest.fixture(scope="session")
def anyio_backend() -> str:
 """Required by the anyio plugin if you use it instead of pytest-asyncio."""
 return "asyncio"
```

**What it does:** A session-scoped fixture that returns the string `"asyncio"`. This is required by the `anyio` pytest plugin if you use it (alternative to `pytest-asyncio`).

**Why it is here as documentation:** We use `pytest-asyncio` in strict mode. But if you switch to `anyio` (e.g. because you want to run tests on `trio` as well), this fixture is the entry point — `anyio` reads it to decide which event loop to use. Leaving it in means a future migration is one config change, not a code change.

### Lines 25–33: `engine`, the session-scoped engine

```python
@pytest.fixture(scope="session")
async def engine():
 """The async engine. Built once per session. Schema is dropped & recreated."""
 eng = create_async_engine(TEST_DB_URL, echo=False, future=True)
 async with eng.begin() as conn:
 await conn.run_sync(Base.metadata.drop_all)
 await conn.run_sync(Base.metadata.create_all)
 yield eng
 await eng.dispose()
```

**What it does:** Builds the async engine once per pytest session, drops and recreates the schema, yields the engine, disposes it at teardown.

**Why session scope:** The engine is expensive to build (TCP connection, pool initialization) and shared across all tests. Building it per test would slow the suite by 10×. The schema drop-and-create is also expensive — done once per session, not once per test.

**Student asks: Why not `scope="session"` for *everything* to avoid fixture-build cost?**

Because session-scope means the fixture is built once and *shared* across every test that requests it. For the engine, that is right — the engine is stateless from the test's perspective (you ask for a connection, you give it back). For the `session`, it is wrong — the session holds rows the test inserted, and those rows would leak from test A into test B if the session were session-scoped. The trade-off is *speed vs isolation*: session-scope is faster (one fixture build, one teardown) but contaminates; function-scope is slower (build per test, teardown per test) but isolates. The architecturally right split is: shared-stateless fixtures at session scope (engine, settings, app), stateful-but-rolled-back fixtures at function scope (session, client). The rollback transaction is what makes function-scope cheap — the session is built per test, but the schema is not.


**Why `Base.metadata.drop_all` then `create_all`:** Idempotent. If the schema already exists, drop it first; then create. This handles the case where a previous test run crashed mid-test and left the schema in a half-state.

**Why `await eng.dispose()` at teardown:** The engine holds a connection pool. If you don't dispose it, the connections leak — and at the end of the pytest session, the OS may still have them open, causing the next pytest run to fail with "too many connections".

**Warning — When this breaks: the engine teardown line sits after the bare `yield eng`, so it only runs if pytest's fixture finalizer reaches it. If `await conn.run_sync(Base.metadata.create_all)` raises mid-DDL (e.g. another pytest session is mid-`drop_all` on the same `test_boardly` DB, or a model imports a type that fails to compile), the `yield` is never reached and `await eng.dispose()` never executes — the pool leaks. The symptom in CI: `psql -c "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'asyncpg%';"` shows leaked connections after a run that errored mid-setup; the next run fails with `TooManyConnectionsError`. The fix: rewrap the engine body in `try: ... yield eng finally: await eng.dispose()` so the dispose runs even when the schema-setup line raises, and assert in a `pytest_sessionfinish` hook that `len(eng.pool._pool) == 0` post-session.**


**Production reality: the engine's `echo=False` is the CI default for a reason — `echo=True` is a profiling tool, not a suite-wide setting. At 1000+ tests with `echo=True`, the stdout volume exceeds pytest's default `capfd` pipe buffer (POSIX pipes deliver ~64KB before blocking); a CI runner that invokes `uv run pytest` via `subprocess.run(..., capture_output=True)` deadlocks at that boundary, and the run appears to hang indefinitely. Use `echo=True` per-test via a `verbose_session` fixture that requests a separately-constructed engine, never as the engine-wide default. For suite-wide SQL visibility, log via SQLAlchemy's `logging.getLogger("sqlalchemy.engine")` to a file, not stdout — file logging does not block the pipe.**


**`Base.metadata.create_all` is *not* how production runs migrations**

Production runs `alembic upgrade head` (see [[09-Alembic-Migrations/Alembic-Setup-and-Workflow]] and Lesson 03 here). `create_all` builds the schema from the ORM models directly — fast (no migration scripts to run), but it does not catch drift between your models and your migration scripts. Lesson 03 here runs `alembic upgrade head` in a separate CI job to catch that drift. The fast suite uses `create_all`; the migration-test job uses Alembic.


### Lines 36–50: `session`, the function-scoped per-test session

```python
@pytest.fixture
async def session(engine) -> AsyncIterator[AsyncSession]:
 """Per-test session. Wrapped in a transaction that rolls back."""
 async with engine.connect() as conn:
 await conn.begin() # outer transaction
 sess = AsyncSession(bind=conn, expire_on_commit=False)
 await sess.begin_nested() # SAVEPOINT
 yield sess
 await sess.close()
 await conn.rollback()
```

**What it does:** For each test, opens a connection, begins an outer transaction, creates an `AsyncSession` bound to that connection, begins a SAVEPOINT, yields the session, and at teardown closes the session and rolls back the outer transaction.

**Why function scope (not session):** Each test gets its own clean state. If the session were session-scoped, test A's row insert would leak into test B. The function scope combined with the outer rollback gives every test a fresh schema.

**Student asks: Why nested SAVEPOINTs instead of just `session.rollback()` at the end?**

Because the application code under test calls `await session.commit()`, and you cannot stop it without rewriting the application. If the only transaction layer were the outer one, the application's `commit()` would persist the row to the DB — test A's inserted user would survive into test B. The SAVEPOINT (the `begin_nested()`) is the trick: the application's `commit()` releases the SAVEPOINT but does *not* commit the outer transaction. The row is still inside the outer transaction. At teardown, the outer transaction rolls back, taking the SAVEPOINT's contents with it. The application's `commit()` was a lie — it committed to the SAVEPOINT, not to the DB. This is what makes the pattern fast (one connection per test, not a schema reset) and safe (rows never persist past the test). One DB connection, one outer transaction, one SAVEPOINT — and the application code does not need to know.


**Why `expire_on_commit=False`:** After `await session.commit()`, accessing `obj.field` triggers a re-fetch by default (the object is "expired"). With the rollback fixture, the re-fetch fails — the row is in the savepoint, but the savepoint's connection is in an awkward state. Setting `expire_on_commit=False` keeps the in-memory attribute values fresh after commit — no re-fetch.

**Why `begin_nested()` (SAVEPOINT):** This is the trick. The application code can call `await session.commit()` — its commit releases the SAVEPOINT, not the outer transaction. The data is still inside the outer transaction, which is rolled back at teardown. So the application's commits are "fake" — they don't persist.

**Warning — When this breaks: the SAVEPOINT isolation is correct per-connection in PostgreSQL 17 (unlike MySQL, PG DDL is fully transactional — `TRUNCATE`, `ALTER TABLE`, `DROP TABLE` all participate in the surrounding transaction and roll back at `conn.rollback()`), but DDL statements acquire `ACCESS EXCLUSIVE` locks that block every other connection touching the same table until the outer transaction ends. With `pytest -n auto` (pytest-xdist parallelism), a test that issues `TRUNCATE users` inside its savepoint blocks every parallel test touching `users` for the test's full duration; the suite silently serializes on the lock-holding test, defeating the parallelism. The symptom: `uv run pytest -n 8` is no faster than `-n 1` for tests touching `users`; `--durations=10` shows the parallel tests at the test's full wall-clock, not the expected parallel-fraction. The diagnosis: `psql -c "SELECT relation::regclass, mode, granted, pid FROM pg_locks WHERE mode LIKE '%ExclusiveLock%';"` shows the lock held by one test's PID with `granted = t`, the other test's PID waiting with `granted = f`. The fix: replace `TRUNCATE users` with `DELETE FROM users` (DML, acquires `ROW EXCLUSIVE` — compatible with parallel readers/writers); reserve DDL for the session-scoped engine setup (where the lock is held once, not per test); or use the strategy-B schema-per-test setup (`CREATE SCHEMA test_<random>; SET search_path`) for the rare tests that genuinely need per-test DDL. See [[12-Testing-and-Quality/Testing-Database-Logic]] for the DDL-vs-DML distinction and the strategy-B pattern.**


**Student asks: Why not just hand each test its own real Postgres database?**

You can — Docker Compose with a `create database test_<random>` per test is a real pattern. It is correct (every test gets a real DB, fully isolated), but it is slow: each `CREATE DATABASE` takes ~1 second on a warm Postgres, plus schema creation, plus engine pool warmup. For 1000 tests, that is 1000 seconds — 16 minutes — just on DB setup. The transaction-rollback pattern takes ~1 ms per test (one connection, one BEGIN, one ROLLBACK) — 1000 tests in 1 second of DB overhead. The same isolation property, 1000× cheaper. The trade-off: the rollback pattern assumes your code does not use `ALTER TABLE` (which DDL-commits in Postgres), does not span multiple connections (the rollback only works inside one connection), and does not need a fresh DB per test for replication-lag reasons. For the 95% of tests that just `INSERT`/`SELECT`/`UPDATE` on the ORM, the rollback pattern is correct and fast. For the 5% that genuinely need a fresh DB, spin one up.


**Tip — The transaction-rollback pattern is the foundation of fast database tests.**

Without it, every test that touches the DB does a `TRUNCATE` or `DROP TABLE` + recreate. With it, every test pays only for a connection + transaction setup (~1 ms). For 1000 tests, that's the difference between 1 second and 30 seconds. Lesson 03 here goes deeper into the pattern.


### Lines 53–62: `client`, the per-test HTTP client

```python
@pytest.fixture
async def client(session) -> AsyncIterator[AsyncClient]:
 """Per-test httpx client. Session is overridden so the app uses our test session."""
 async def _override_session() -> AsyncSession:
 return session
 app.dependency_overrides[get_session] = _override_session
 async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as ac:
 yield ac
 app.dependency_overrides.clear() # CRITICAL
```

**What it does:** For each test, installs `get_session` override (returns the per-test session), opens an `AsyncClient` with `ASGITransport` driving the app, yields it, and at teardown closes the client and clears all overrides.

**Why `app.dependency_overrides[get_session] = _override_session`:** This is the framework-level seam. When the route runs `Depends(get_session)`, FastAPI checks `app.dependency_overrides` first — if `get_session` is in there, it calls the override instead of the real function. The route gets the test session, not a real one. This is the *canonical* pattern, taught in Lesson 02 here.

**Why `app.dependency_overrides.clear()` at teardown:** If you forget this, the next test inherits the override — and gets *this* test's session, which has been rolled back. The next test's queries run against an empty session, fail mysteriously, and you spend 2 hours debugging.

**Warning — When this breaks: the `app.dependency_overrides.clear()` line sits after the bare `yield ac`, so it only runs if pytest's fixture finalizer reaches it. If the `AsyncClient.__aenter__` raises (e.g. port conflict, event loop closed by a previous fixture, ASGITransport misconfiguration), the `yield` is never reached and `clear()` never executes — the next test inherits the dead override and fails with `MissingGreenlet` or `DetachedInstanceError` on the first query. The symptom: pytest reports `fixture client setup failed`; the next test's session is bound to a connection the previous test already rolled back. The fix: rewrap the client body in `try: async with AsyncClient(...) as ac: yield ac finally: app.dependency_overrides.clear()` so the clear runs unconditionally, and add a `pytest_collection_finish` hook that asserts `len(app.dependency_overrides) == 0` post-session — a non-empty dict at session end is a fixture-leak bug.**


**Danger — How an attacker thinks: `app.dependency_overrides` is a global mutable dict on the imported FastAPI app instance; any conftest plugin loaded via `pyproject.toml`'s `[tool.uv.dev-dependencies]` can `app.dependency_overrides[get_current_user] = lambda: admin_user` at import time, silently elevating every test's auth to admin. The attack shape: a compromised dev dependency (a typosquatted `pytest-fastapi-helpers` package, a malicious fork merged into a previously-trusted helper) installs an `conftest.py` that auto-elevates; CI is green on tests that should fail; the same auth-bypass reaches production via the same code path the test greenlit. The symptom in a pentest: a security test that asserts a regular user is denied an admin endpoint passes in CI but the same endpoint is open in prod. The defence: pin every dev dependency with `uv sync --frozen`; audit `app.dependency_overrides` at the end of conftest collection with a `pytest_collection_finish` hook that compares the override dict to an allowlist (typically `{get_session, get_current_user, oauth2_scheme}`); any unexpected entry is a CI-blocking finding. See [[11-Authentication-and-Security/Threat-Model-First]] for the supply-chain threat model.**


**Why `AsyncClient` with `ASGITransport` and not the sync `TestClient`:** `Boardly` is async-first. The sync `TestClient` works (Starlette spins up a thread), but the `AsyncClient` + `ASGITransport` pattern is the idiomatic async path. Lesson 02 here covers both.

**Production reality: `AsyncClient(transport=ASGITransport(app=app))` exercises FastAPI's routing, dependency injection, and Pydantic validation in-process — but it does not exercise uvicorn's signal handling, the ASGI lifespan startup/shutdown events, or the OS-level socket layer. Lifespan bugs (a `lifespan` context manager that fails to close a Redis pool on shutdown, leaving the next test's Redis full) slip past the in-process client. The 5% e2e tests must start a real uvicorn process via `subprocess.Popen([sys.executable, "-m", "uvicorn", "boardly.main:app", "--port", "8765"])`, poll `http://127.0.0.1:8765/healthz` until green, and hit it via `AsyncClient(base_url="http://127.0.0.1:8765")`. The cost is ~3s of process startup per test; the benefit is catching lifespan bugs the in-process client cannot. See [[16-Deployment-and-DevOps/GitHub-Actions-CI]] for the e2e job shape.**


### Lines 65–85: `make_user`, the factory fixture

```python
@pytest.fixture
def make_user(session):
 """Returns an async callable that creates a persisted User."""
 from boardly.models import User
 from boardly.security.passwords import hash_password

 async def _make(**overrides) -> User:
 defaults = {
 "email": "u@example.com",
 "password_hash": hash_password("secretsecret"),
 "is_active": True,
 "scopes": ["read:users"],
 }
 defaults.update(overrides)
 user = User(**defaults)
 session.add(user)
 await session.flush() # assigns user.id without committing
 return user
 return _make
```

**What it does:** Returns an async callable that creates a `User` row with sensible defaults, overridable per call.

**Why a factory fixture (not a fixed fixture):** A fixed fixture (`@pytest.fixture async def user(): ...`) creates one user per test. If the test needs two users (e.g. an admin and a member), it cannot ask for two. A factory fixture returns a callable; the test calls `make_user(email="alice@...")` and `make_user(email="bob@...")` to create as many as it needs.

**Why `await session.flush()` not `await session.commit()`:** `flush` sends the `INSERT` to the DB and assigns the auto-increment `user.id`, but does not commit. The savepoint holds the row visible to subsequent queries on the same session. The outer transaction (the `session` fixture) will roll it back at teardown.

**Why `defaults.update(overrides)`:** The test calls `make_user(email="alice@...", is_admin=True)` — only the fields they care about. The defaults fill the rest. This is the "sensible defaults, override what you need" pattern.

**Danger — How an attacker thinks: the factory's `password_hash = hash_password("secretsecret")` creates a known-credential user with a known password in the test DB. The attack shape, in three escalating scenarios: (1) the test DB is mounted as a read-replica of a staging DB (a common cost-optimisation pattern that backfires the moment fixture data lands in a non-test DB); (2) a CI snapshot is shared with developers via `pg_dump test_boardly | gzip > testdata.sql.gz` and the dump is committed or attached to a bug report; (3) a developer runs the test suite locally, then runs a `scripts/seed.py` that imports the conftest's `make_user` to populate a fresh staging environment — the staging now has `u@example.com` / `secretsecret` as a real user. In all three, an attacker who reads the repo or acquires the dump logs in to any non-test environment as `u@example.com`. The symptom in a pentest: an active session tied to `u@example.com` in staging. The defence: never reuse test-fixture data in any non-test DB; restrict the `test` DB role to `NOSUPERUSER NOCREATEDB NOCREATEROLE` and the `test_boardly` database only; rotate the test DB on every CI run (the service-container pattern in [[12-Testing-and-Quality/CI-Pipelines]] does this for free); add a CI grep that fails if `hash_password("secretsecret")` or `hash_password('secretsecret')` appears outside `tests/`.**


### Lines 88–105: `make_org`, a composable factory

```python
@pytest.fixture
def make_org(session, make_user):
 """Returns a callable that creates an Org + owner + members."""
 from boardly.models import Org, OrgMembership

 async def _make(*, name="acme", members=(), owner=None) -> Org:
 owner = owner or await make_user(email="owner@example.com")
 org = Org(name=name, owner_id=owner.id)
 session.add(org)
 await session.flush()
 for m in members:
 session.add(OrgMembership(org_id=org.id, user_id=m.id, role="member"))
 await session.flush()
 return org
 return _make
```

**What it does:** A factory that creates an org, an owner (if not provided), and memberships for any provided members.

**Why it composes:** `make_org` takes `make_user` as a fixture argument — same way FastAPI dependencies compose. The factory's body calls `make_user(...)` to build the owner. This is the *fixture composition* pattern: a fixture can depend on other fixtures, and pytest resolves the dependency tree.

**Danger — How an attacker thinks: the factory's `owner = await make_user(email="owner@example.com")` auto-grants the org-owner role to a user with a known email pattern. The attack shape: a `scripts/seed.py` that copies test-fixture patterns (reuses the `make_user(email="owner@example.com")` default to bootstrap a fresh prod instance) leaves the org-owner's email known to anyone who reads the repo; an attacker attempts credential-stuffing or password-reset against `owner@example.com` and escalates from member to owner. The symptom in a pentest: `owner@example.com` is an org-owner in prod with weak auth. The defence: separate fixture data from seed data — fixtures live in `tests/`, seeds live in `scripts/seed.py` that draws emails from a secrets manager (Vault, AWS Secrets Manager), not from conftest defaults; add a CI grep `rg "@example\\.com" scripts/` that fails the build if any `@example.com` email appears in `scripts/` (those are RFC 2606 reserved domains, never valid in prod-adjacent environments).**


### Lines 110–118: `settings`, pinned for tests

```python
@pytest.fixture
def settings() -> Settings:
 """Pinned settings for tests. Never reads .env."""
 return Settings(
 jwt_secret="test-secret-32-bytes-do-not-use-in-prod!",
 jwt_iss="boardly-test",
 jwt_aud="boardly-test-api",
 env="test",
 )
```

**What it does:** Returns a `Settings` instance with test-pinned values.

**Why a fixture and not a module-level singleton:** A future test might want to override `jwt_iss` to test the "wrong issuer" rejection. With a fixture, that test can override the fixture (`@pytest.fixture def settings(): return Settings(jwt_iss="wrong-issuer", ...)`) and the rest of the test suite's code picks it up. A module-level singleton is harder to override.

**Why test secrets are still 32 bytes:** The `jwt_secret` is "test-secret-32-bytes-do-not-use-in-prod!" — 38 chars, well past the 32-byte minimum. PyJWT with HS256 will accept any non-empty key, but using a real-length secret means the test would catch a length-validation bug if we added one.

**Danger — How an attacker thinks: the hard-coded `jwt_secret="test-secret-32-bytes-do-not-use-in-prod!"` in the conftest is a credential an attacker can read in any public or leaked repo and replay against any environment that imports the test settings as a default fallback. The attack shape: a staging environment that, on its first deploy, falls back to `Settings()` (which reads `.env` if present, else the Pydantic defaults — and if a developer copied the conftest's `Settings(jwt_secret="test-secret-32-bytes-do-not-use-in-prod!", ...)` into a `settings.py` for staging bootstrap, the staging JWT secret is now public); an attacker forges a JWT signed with that secret and submits it to the staging API; the staging accepts the token. The symptom in a pentest: staging accepts a JWT signed with the public test secret. The defence: never import test settings into staging or prod; pin the staging `jwt_secret` to a value from a secrets manager at deploy time; add a CI grep `rg "test-secret-32-bytes-do-not-use-in-prod" boardly/` that fails the build if the test secret appears anywhere outside `tests/`.**


### Lines 122–131 of `pyproject.toml`: `pytest-asyncio` strict mode

```toml
[tool.pytest.ini_options]
asyncio_mode = "strict"
markers = [
 "slow: long-running tests, skipped on pre-commit",
 "integration: tests that touch a real DB or Redis",
 "e2e: end-to-end tests through the full stack",
]
addopts = "-ra --strict-markers --strict-config"
```

**What it does:** Configures pytest to require `@pytest.mark.asyncio` on async tests (strict mode), declares three custom marks, and adds `--strict-markers` so typos fail loudly.

**Why strict mode:** In strict mode, an `async def test_*` without `@pytest.mark.asyncio` is silently skipped — pytest collects it but does not run it. That is the failure mode you want — the test was supposed to run, didn't, and the suite is greener than it should be. Strict mode forces you to mark explicitly; the typo-or-omission is a visible failure, not a silent skip. (Lesson 04 here covers this in detail.)

**Why `--strict-markers`:** Without it, `@pytest.mark.itnegration` (typo) silently passes — it's just an attribute, pytest doesn't check. With `--strict-markers`, the typo is a hard error at collection time. The cost is one line per marker in `pyproject.toml`; the benefit is catching typos that would silently skip a stage.

**Warning — When this breaks: `--strict-markers` catches typos in marker *names* on the *undeclared* side, but not on the *declared-but-unused* side. The failure shape: a marker declared in `pyproject.toml` (`markers = ["slow: long-running tests, skipped on pre-commit"]`) but renamed in code (`@pytest.mark.slow_tests` instead of `@pytest.mark.slow`) passes `--strict-markers` because `slow_tests` is undeclared (rejected) — but `slow` is declared (so the toml-side passes), and the *filter* `pytest -m "not slow"` does not match `slow_tests`, so the slow tests run on every pre-commit and CI is 10x slower than expected. The symptom: `uv run pytest -m "not slow"` runs the slow tests; `--durations=10` shows them. The diagnosis: `uv run pytest --markers | grep '^@pytest.mark'` lists declared markers; compare against `rg '@pytest.mark' tests/` to find the divergence. The fix: align marker names between toml and code; add a `--strict-config` (already present here) plus a custom `pytest_collection_finish` hook that fails the session if any declared marker has zero uses (a dead-marker check that catches both the typo and the obsolete-declaration cases).**


**Production reality: `--strict-config` (paired with `--strict-markers`) is the silent quality gate that catches ini-option typos before any test runs. Without it, a typo in `[tool.pytest.ini_options]` (`asynciomode = "strict"` instead of `asyncio_mode`) is silently ignored — pytest-asyncio silently defaults to whatever the installed plugin pins, which in pytest-asyncio 0.23+ is `strict` for new projects but `auto` for projects that upgraded from older versions, so the typo'd config silently changes the test suite's behaviour between upgrades. The symptom: an `async def test_*` without `@pytest.mark.asyncio` runs in some CI jobs and is silently skipped in others. The diagnosis: `uv run pytest --co -q tests/test_async.py | wc -l` shows fewer collected tests than expected. The fix: keep `--strict-config` on; if the typo is in a third-party plugin's option, pin the plugin version (`pytest-asyncio==0.23.7`) in `pyproject.toml` and re-run — `--strict-config` rejects unknown options at session start. See [[01-Python-Foundations/uv-Tooling-Workflows]] for the `uv sync --frozen` discipline.**


What does it actually mean for a marker to "silently pass"? A pytest marker (`@pytest.mark.integration`) is just an attribute on the test function. Pytest reads it as "this test has the `integration` tag" — and your CI config (`pytest -m "not integration"` on pre-commit) uses it to skip those tests. A typo in the marker (`@pytest.mark.itnegration`) means the test has the *typoed* tag, which does not match `not integration` — so the typoed test is *not skipped*, runs on pre-commit, and is slower than expected. Or — and this is worse — your CI step `pytest -m "integration"` (run only integration tests) misses the typoed test entirely; it never runs; your suite is greener than reality. `--strict-markers` rejects the typoed marker at collection time, before any test runs, so the typo is a hard error rather than a silent skip-or-run.

## The Test Pyramid

```mermaid
flowchart TB
 E2E["End-to-end<br/>5–10 tests<br/>HTTP through the real stack<br/>~seconds each"]
 Int["Integration<br/>100s of tests<br/>one subsystem wired up<br/>~10–100 ms each"]
 Unit["Unit<br/>1000s of tests<br/>pure functions / mocked deps<br/>~1 ms each"]
 E2E --> Int --> Unit
 style E2E fill:#fee2e2
 style Int fill:#fef3c7
 style Unit fill:#dcfce7
```

- **Unit**: a pure function, or a class with its dependencies mocked. No I/O. Sub-millisecond. Most of your suite.
- **Integration**: a subsystem wired up — a real FastAPI `AsyncClient` with an in-memory DB or a real DB session against an isolated test database. Slower, but catches wiring bugs unit tests miss.
- **End-to-end**: HTTP through the real stack, including auth, DB, queue, external stubs. Slowest. Few. These are the smoke tests.

The pyramid is a ratio, not a law. A small service might have 50 unit + 20 integration + 2 e2e. A microservice with complex business logic might have 500 + 100 + 3. The shape — broad at the bottom, narrow at the top — is what matters.

Why is the shape *ratio* the thing to optimise, not the absolute count? A suite of 1000 unit tests runs in ~1 second; 1000 integration tests run in ~1 minute; 1000 e2e tests run in ~10 minutes. Same count, three orders of magnitude difference in wall-clock time. The pyramid's value is not "fewer tests at the top" — it is "the slow tests are rare enough that you can run them only on merge to main, not on every push". An inverted pyramid (many e2e, few unit) forces the slow tests to run on every push (because most of the suite is e2e), which means every developer waits 20 minutes per push, which means the team stops running the suite locally — which means regressions ship to CI before anyone notices. The pyramid preserves the fast feedback loop. The shape is the value, not the count.

**Danger — The inverted pyramid (the "ice cream cone")**

The anti-pattern is many e2e, few unit. This is common when teams start with Cypress/Playwright and never write unit tests. The suite takes 20 minutes, breaks on every UI change, and provides 5% of the value of a unit suite that runs in 2 seconds. The unit test is faster, more reliable, and more debuggable than the e2e test for the same logic. Use e2e for user-journey smoke tests, not for logic coverage.


## Execution Trace

A test run, in order.

```mermaid
sequenceDiagram
 participant Py as pytest runner
 participant Conf as conftest.py
 participant Eng as Engine
 participant Ses as Session fixture
 participant Cli as Client fixture
 participant Test as Test body

 Note over Py,Conf: Session-scoped setup (once)

 Py->>Conf: collect tests, read conftest.py
 Py->>Eng: build engine fixture (session-scoped)
 Eng->>Eng: create_async_engine(TEST_DB_URL)
 Eng->>Eng: drop_all + create_all (schema)
 Note over Eng: engine + schema ready for the session

 Note over Py,Cli: Per-test setup (for each test requesting `client`)

 Py->>Ses: build session fixture (function-scoped)
 Ses->>Eng: engine.connect()
 Ses->>Eng: conn.begin() (outer transaction)
 Ses->>Ses: AsyncSession(bind=conn, expire_on_commit=False)
 Ses->>Ses: sess.begin_nested() (SAVEPOINT)

 Py->>Cli: build client fixture (function-scoped)
 Cli->>Cli: app.dependency_overrides[get_session] = _override
 Cli->>Cli: AsyncClient(transport=ASGITransport(app=app))

 Py->>Test: run test body
 Test->>Cli: await client.post("/users", json={...})
 Note over Test,Ses: app code calls session.commit() — hits SAVEPOINT, not outer txn

 Note over Py,Cli: Per-test teardown

 Py->>Cli: client fixture teardown
 Cli->>Cli: app.dependency_overrides.clear()
 Cli->>Cli: AsyncClient close

 Py->>Ses: session fixture teardown
 Ses->>Ses: sess.close()
 Ses->>Eng: conn.rollback() — discards everything

 Note over Py,Eng: Next test reuses engine, gets new connection + new txn
```

The whole suite is fast because the schema is built once; each test pays only for connection + transaction setup.

## Common Mistakes

### Mistake 1: Session-scoped fixture that mutates

```python
# WRONG
@pytest_asyncio.fixture(scope="session")
async def make_user(engine):
    user = await _create_user(engine, email="alice@example.com")
    return user   # ← cached for the whole session

async def test_a(make_user):
    make_user.email = "a-changed@example.com"   # ← mutates the cached object
    await session.commit()

async def test_b(make_user):
    assert make_user.email == "alice@example.com"   # ← FAILS — test A mutated it
```

**Symptom:** A session-scoped factory (`make_user`) creates a user on first call, caches it, returns the same user on subsequent calls. Tests assume they own the user; they mutate it; the next test sees the mutation.

**Why:** Session-scoped fixtures return once and cache. Mutation of the cached value leaks across tests.

**Fix:** Either function-scope the fixture (each test gets a fresh value), or document "read-only after creation" and enforce it in code review. The pattern in this lesson — function-scoped `session` and `client`, session-scoped `engine` — is the right split.

```python
# RIGHT — function-scoped factory; each test gets a fresh user
@pytest_asyncio.fixture
async def make_user(session):
    user = User(email=f"{uuid.uuid4().hex}@example.com")
    session.add(user)
    await session.commit()
    yield user
    # ← rollback at fixture teardown wipes the row
```

### Mistake 2: `conftest.py` at the project root with all fixtures

**Symptom:** One `tests/conftest.py` with 50 fixtures. Every test imports everything. Refactoring a fixture breaks tests that did not use it.

**Why:** `conftest.py` files are auto-discovered by pytest. Fixtures in a `conftest.py` are available to all tests at that directory level and below. The project-root `conftest.py` is the broadest — every test sees every fixture. This is the file-level analog of "global variables".

**Fix:** Split per-directory. `tests/conftest.py` has the session-wide fixtures (`engine`, `settings`, `anyio_backend`). `tests/users/conftest.py` has user-specific factories. `tests/orgs/conftest.py` has org-specific factories. A fixture defined in `tests/users/conftest.py` is *not* visible in `tests/orgs/` — local fixtures stay local.

### Mistake 3: No `--strict-markers`

```python
# WRONG — typo'd marker, silently skipped
@pytest.mark.itnegration   # ← typo: itnegration
async def test_create_org_with_billing(client):
    r = await client.post("/orgs", json={...})
    assert r.status_code == 201

# pyproject.toml:
# [tool.pytest.ini_options]
# addopts = ""   # ← no --strict-markers
```

**Symptom:** `@pytest.mark.itnegration` (typo) silently passes — pytest collects the test, the marker is just an attribute, no validation. The test never runs in the `integration` stage of CI.

**Why:** Without `--strict-markers`, pytest does not check that markers are declared. A typo is invisible.

**Fix:** `addopts = "--strict-markers --strict-config"` in `pyproject.toml`. Declare markers in the same file. The typo becomes a hard error at collection time.

```toml
# RIGHT
[tool.pytest.ini_options]
addopts = "--strict-markers --strict-config"
markers = [
    "integration: requires service containers (Postgres, Redis)",
    "slow: takes more than 1 s",
]
```

### Mistake 4: Hand-built data instead of factories

```python
# WRONG — every test re-builds the same shape of dict
async def test_create_user_returns_201(client):
    payload = {
        "email": "alice@example.com",
        "password": "hunter2hunter2",
        "name": "Alice",
        "org_id": 42,
        "role": "member",
        "tier": "standard",
        # ... ten fields, repeated in every test in this file
    }
    r = await client.post("/users", json=payload)
    assert r.status_code == 201

async def test_create_user_rejects_short_password(client):
    payload = {**_the_same_ten_fields, "password": "x"}  # copy-paste
    r = await client.post("/users", json=payload)
    assert r.status_code == 422
```

**Symptom:** Each test builds a 10-field dict inline. The dict is correct for that test's needs but slightly wrong for the next test's needs. The next test copy-pastes the dict, adjusts two fields, and now you have two dicts that drift apart over time.

**Why:** Hand-built data does not compose. The defaults are repeated in every test; the maintenance cost dominates.

**Fix:** A factory fixture (like `make_user` above) centralizes the defaults. Tests pass only the overrides they care about. When the model changes (e.g. a new mandatory field), one fixture update covers every test.

```python
# RIGHT
@pytest_asyncio.fixture
def make_user_payload():
    def _(**overrides):
        payload = {  # the canonical defaults
            "email": f"{uuid.uuid4().hex}@example.com",
            "password": "hunter2hunter2",
            "name": "Test User",
            "org_id": 42,
            "role": "member",
        }
        return {**payload, **overrides}
    return _

async def test_create_user_rejects_short_password(client, make_user_payload):
    payload = make_user_payload(password="x")   # only the override
    r = await client.post("/users", json=payload)
    assert r.status_code == 422
```

### Mistake 5: Using `pytest.fixture` everywhere a function would do

**Symptom:** Helper functions are decorated with `@pytest.fixture` for no reason. They take no other fixture as argument and have no teardown.

**Why:** Fixtures are for setup/teardown with composition. A pure helper function (no teardown, no fixture arguments) is just a function — decorate it as a fixture and you have to ask for it by name in the test signature, instead of just calling it.

**Fix:** Use `@pytest.fixture` when you need: scope control, teardown, fixture composition. Use a plain function (often in a `tests/helpers.py`) for pure helpers.

### Mistake 6: Forgetting to clear `dependency_overrides`

```python
# WRONG
@pytest_asyncio.fixture
async def client(app):
    app.dependency_overrides[get_session] = lambda: test_session_a
    async with AsyncClient(transport=ASGITransport(app=app),
                           base_url="http://test") as ac:
        yield ac
    # ← no clear; test B inherits the override
```

**Symptom:** Test A overrides `get_session` to return test session A. Test A finishes — the override is still installed. Test B starts; the override still returns test session A, which has been rolled back. Test B's queries run against an empty session and fail mysteriously.

**Why:** The override dict on `app` is global. Without an explicit clear, it persists across tests.

**Fix:** Always clear in the fixture teardown. The `client` fixture above does `app.dependency_overrides.clear()` after `yield`. The pattern is non-negotiable.

```python
# RIGHT
@pytest_asyncio.fixture
async def client(app):
    app.dependency_overrides[get_session] = lambda: test_session_a
    async with AsyncClient(transport=ASGITransport(app=app),
                           base_url="http://test") as ac:
        yield ac
    app.dependency_overrides.clear()   # ← always, in teardown
```

## Engineering Trade-Offs

### Transaction-rollback vs truncate-and-reseed

| Approach | Speed | Portability | When |
|---|---|---|---|
| Transaction-rollback | Fast (no DDL) | pytest-specific (uses SAVEPOINT) | You control the test runner. |
| Truncate-and-reseed | Slower (TRUNCATE per test) | Portable across test frameworks | You use multiple runners or can't use SAVEPOINT. |

Choose rollback when you control the test runner; truncate otherwise. Lesson 03 here goes deeper.

### Hand-rolled factories vs `factory_boy`

| Approach | Boilerplate | Power | When |
|---|---|---|---|
| Hand-rolled factory fixture | Low (one function) | Low (no chaining, no fuzzy generation) | Most FastAPI services. |
| `factory_boy` | Higher (declarative class per model) | Higher (chained factories, fuzzy generation, persistence helpers) | 20+ models with chained relationships. |
| `model_bakery` | Lowest (one-line `baker.make`) | Medium (recipe-based, less flexible) | Simple CRUD apps. |

For most FastAPI services, a hand-rolled factory fixture is enough. Reach for `factory_boy` when you have 20+ models with chained relationships and the maintenance cost of hand-rolled factories starts to bite.

### `pytest-asyncio` vs `anyio` modes

| Plugin | API | When |
|---|---|---|
| `pytest-asyncio` strict | `@pytest.mark.asyncio` per test | Most FastAPI services. Explicit, grep-able. |
| `pytest-asyncio` auto | no marker; every `async def test_*` is async | Large async-only suites where the marker is noise. |
| `anyio` | `@pytest.mark.anyio` per test; `anyio_backend` fixture | Multi-runtime portability (asyncio + trio). |

Lesson 04 here covers the choice in detail.

### Marks for organization vs for selection

A mark like `@pytest.mark.users` lets you run `pytest -m users` — useful in large repos, overhead in small ones. Use marks for *selection* (slow, integration, e2e — the ones CI filters on); use directory structure for *organization* (the `tests/users/` folder).

### When to use which: mock vs fake vs real integration test

There are three ways to substitute a dependency in a test suite: **mock** it (replace with a `Mock` that records calls and returns canned values), **fake** it (replace with an in-memory implementation of the same interface), or **real** it (run the actual dependency against the real infrastructure in a hermetic environment). Each has a different cost profile and a different failure it catches. The wrong choice is the most common testing mistake in FastAPI services — and it almost always manifests as either "tests pass but production breaks" (mock-too-much) or "CI takes 30 minutes and nobody runs it" (real-too-much).

| Strategy | What it is | Speed | What it tests | What it misses | When it wins |
|---|---|---|---|---|---|
| **Mock** | Replace a collaborator with a `unittest.mock.Mock` or `pytest-mock`'s `mocker.Mock`. You tell it what to return; you assert what it was called with (`mock.send_email.assert_called_once_with(user_id=42)`). | Sub-millisecond. No I/O, no setup. | "Did you call the right collaborator in the right way?" — verifies the *interaction contract* (which method, with which arguments, in which order). | Whether the collaborator's *implementation* actually behaves correctly when called that way. The mock will happily accept `send_email(user_id=42)` even if the real `EmailClient.send_email` signature changed to require `recipient=` instead of `user_id=`. | For collaborators whose contract is the interaction (event-emitters, callback hooks, "did you call the audit logger" assertions). For one-off assertions that "this code path triggered that side-effect." Never as the default for repository or gateway tests. |
| **Fake** | Replace a collaborator with an in-memory implementation of the same `Protocol`/interface. A `FakeUserRepository` that stores users in a `dict` instead of Postgres; a `FakeEmailClient` that appends to a `list` instead of SMTP; a `FakeLLMClient` that returns a deterministic canned completion. | Sub-millisecond to low-millisecond. No real I/O. | "Did your code behave correctly given a *behaving* collaborator?" — verifies your code's logic against a collaborator that *behaves* like the real thing. | Whether the fake's behaviour matches the real implementation's behaviour. A `FakeUserRepository` that doesn't enforce a `UNIQUE` constraint on `email` will let your tests pass while Postgres rejects the second insert in production. | When you have a `Protocol`-typed dependency and you can write a fake whose behaviour is small enough to obviously-correct (a `dict`-backed repository for a CRUD service; a `list`-backed email client for "did we queue the right emails"). When you want unit-test speed for the 90% of tests and reserve the slow real-integration tests for the 10%. |
| **Real integration test** | Run the actual dependency against real infrastructure in a hermetic environment. A test that starts a Postgres container, runs the migration, calls `UserRepository.create_user` against real Postgres, and asserts the row exists. | 100ms–10s per test. Container startup, network, disk I/O. | "Does the collaborator's *real* implementation actually behave the way you think it does?" — catches SQL syntax errors, type mismatches, isolation-level surprises, index-missing slowdowns, ORM hydration bugs, real HTTP-error parsing. | Nothing about your code's interaction logic *if you trust the collaborator*. But these tests are slow and brittle (containers flap, network blips, port conflicts on CI). | For collaborators whose behaviour is too complex to fake faithfully (Postgres, Redis, Stripe's API, a pgvector HNSW index). For "smoke" tests that prove your service wires up correctly end-to-end. For one or two tests per collaborator that catch the "fake lied to us" gap. |

**The default: fake for unit tests, real for a thin integration suite.**

A reasonable default for a FastAPI service: ~80% of tests use **fakes** (a `FakeUserRepository`, a `FakeEmailClient`); ~15% are **real integration tests** against containerised Postgres + Redis; ~5% are **mocks** for the narrow "did you call the right thing" assertions (audit logging, event emission). This gets you sub-100ms unit tests for the bulk of the suite, a thin green-ring of real-integration tests that catch SQL/ORM mismatches, and a few interaction-contract assertions where they're the right tool. The worst default — and the one most teams accidentally land in — is "mock everything in the unit suite, real everything in the integration suite, run the integration suite once a week because it's too slow." That leaves you with a unit suite that passes while production breaks (mocks don't catch real-SQL mismatches) and an integration suite nobody trusts (too slow to run, too flaky to green).


**Student asks: why is mock-too-much the most common mistake?**

Because mocks are fast, and fast feels good. A unit suite of 1,000 mock-based tests runs in 4 seconds and feels "TDD-disciplined." Then someone renames a method on the real `UserRepository` — `get_user` → `fetch_user` — and the mocks happily keep returning `MagicMock()` from `get_user(...)`. The unit suite is still green. Production is broken. The mistake is treating mocks as "tests for the repository"; they are "tests for the *caller of the repository*." They verify the caller called *a* `get_user(...)` — they do not verify that `get_user(...)` exists on the real class. The fake doesn't have this problem (a `FakeUserRepository` that doesn't implement `fetch_user` fails at import time when the Protocol's `isinstance` check runs). The real integration test doesn't have this problem (it calls the real `UserRepository.fetch_user` against real Postgres; if the method doesn't exist, the test fails with `AttributeError`).


**Warning — Fakes drift from reality. Schedule a real-integration test for the same case.**

The fatal flaw of a fake: it can be subtly wrong. A `FakeUserRepository` that uses a plain `dict` doesn't enforce a `UNIQUE` constraint on `email`; your test for "create two users with the same email" passes against the fake (the second insert silently overwrites the first) and fails against Postgres (the second insert raises `IntegrityError`). The mitigation: for every behaviour the fake models, write *one* real-integration test that runs the same scenario against the real Postgres, and assert the same outcome. The fake gives you speed for the 100 unit tests in the suite; the real-integration test catches the fake-lying-to-you case. If you can't write a real-integration test for that scenario (e.g. it requires a real LLM provider and you don't want to pay for it in CI), the fake's behaviour is *unverified* — flag that in the test docstring so the next reader knows.


**Tip — Use a `Protocol` so fakes and reals are interchangeable.**

The mechanical precondition for the fake-vs-real split is that your dependency is a `Protocol` (or an abstract base class), not a concrete class. A `UserRepository(Protocol)` with `async def create_user(self, user: User) -> User: ...` lets you swap `SqlAlchemyUserRepository` (real, talks to Postgres) for `FakeUserRepository` (fake, `dict`-backed) without changing the consumer. If your repository is a concrete class, you can't write a fake — you can only write a mock. The whole fake-vs-real decision table only applies once you've done the protocol-extraction step in Lesson 05-2 ([[05-Project-Architecture/Service-and-Repository-Patterns]]); without that, you're stuck with mocks.


**When is a mock actually the right answer over a fake?**

Three places. (1) **Interaction-contract assertions** — "did the audit logger get called with `user_id=42, action='login'`?" You don't want a fake that *behaves* like an audit logger; you want to assert that your code *called* the audit logger at all. A mock with `assert_called_once_with(...)` is exactly the right tool. (2) **One-off stubs in a single test** — "this test needs `get_current_user` to return a specific admin user." `mocker.patch("boardly.deps.get_current_user", return_value=admin_user)` is faster and more local than wiring a fake through `dependency_overrides`. (3) **Collaborators with no useful behaviour to fake** — a webhook-emitter whose entire contract is "fire-and-forget this payload to this URL." There's nothing to *behave* — the only assertion is "did you call `post(...)` with this payload." Mock it. For everything else, prefer a fake (faster than the real, more faithful than the mock).


**Cross-link — dependency overrides swap the whole Depends provider.**

FastAPI's `app.dependency_overrides[get_user_repo] = lambda: fake_user_repo` is the canonical way to swap a real `UserRepository` for a `FakeUserRepository` in a `TestClient` test. Lesson 02 ([[Testing-FastAPI-Endpoints]]) covers the mechanics; this trade-off table is the *when-to-use-which* layer on top. The short version: use `dependency_overrides` with a fake for 80% of your endpoint tests; use a `TestClient` against real Postgres for 15% (your "thin integration suite"); use `mocker.patch` for the 5% where you specifically need an interaction-contract assertion.


**Tip — Read Lesson 05-2 first if your repository is a concrete class.**

The fake-vs-real split is only available if your collaborators are `Protocol`s. If you're starting this lesson with concrete classes (`class UserRepository:` with `def create_user` on the class itself), go read [[05-Project-Architecture/Service-and-Repository-Patterns]] and [[05-Project-Architecture/When-Abstraction-Is-Worth-It]] first — the protocol extraction step is the precondition for everything in this trade-off table. Trying to fake a concrete class leads to inheritance-hack fakes (`class FakeUserRepository(UserRepository):` overriding every method) that are worse than mocks in every dimension.


## Exercises

**Tip — The 20-minute rule**

If you're stuck on an exercise for more than 20 minutes, re-read the relevant section above, then move on.


**Exercise 1 — Add a `make_refresh_token` factory.** The factory takes a `user_id` and returns a persisted `RefreshToken` row with `revoked=False` and `expires_at` 30 days out. Use it in a test that calls `POST /auth/refresh` and asserts rotation.

**Exercise 2 — Refactor a flaky test that uses `time.sleep(0.1)`.** A test that polls an async event with `time.sleep` is flaky and slow. Rewrite it to poll with an async retry loop (`for _ in range(50): if condition: break; await asyncio.sleep(0.01)`). Measure the speedup.

**Exercise 3 — Build a session-scoped `base_dataset` fixture.** Seed a known set of rows once per session (3 orgs, 5 users, 10 documents). Use the transaction-rollback pattern so tests don't mutate it. Run 100 tests against it; measure that they are ~5% of the time of the truncate-and-reseed equivalent.

**Exercise 4 — Add a `--slow` mark and skip it in pre-commit.** Mark the slow tests. Configure `pytest -m "not slow"` to run in pre-commit (seconds), `pytest` (full suite) to run in CI.

**Exercise 5 — Spot the bug.** This conftest is broken. Why?

```python
@pytest.fixture(scope="session")
async def session(engine):
 sess = AsyncSession(bind=engine, expire_on_commit=False)
 yield sess
 await sess.close()
```

(Answer: (a) session-scoped session — every test shares one session, mutation leaks (Mistake 1). (b) no transaction-rollback — commits persist (the worst kind of "works on my machine"). (c) no `begin_nested()` — application commits go to the real DB and stay there. (d) no `engine.connect()` per test — the connection is shared, lock contention. The right pattern is in the `session` fixture above.)

**Exercise 6 — Parametrize the security matrix.** Take the security-test matrix from Lesson 11.04 (the 6 tests) and refactor it into a single parametrized test with 6 parameter sets. Note the trade-off: more compact, but each row of the matrix is harder to read in isolation.

**Exercise 7 — Reproduce the SAVEPOINT isolation.** Write two tests in `tests/test_savepoint_isolation.py`: `test_a_inserts_user` (inserts a row via `make_user`, no assertion) and `test_b_asserts_users_empty` (asserts `(await session.scalars(select(func.count()).select_from(User))).one() == 0`). Run `uv run pytest tests/test_savepoint_isolation.py -v`. Both should pass with the canonical `session` fixture (the SAVEPOINT isolates them). Then break the fixture by removing the `await sess.begin_nested()` line from a *copy* of the fixture in a `tests/conftest_break.py` and running `uv run pytest tests/test_savepoint_isolation.py -v -p no:randomly --override-ini=...` — `test_b` should fail (test A's row leaked). Restore the SAVEPOINT; both pass again. The exercise proves the SAVEPOINT is the load-bearing isolation primitive, not the function scope.

**Exercise 8 — Audit `app.dependency_overrides` for clear()-lessness.** Write `tests/test_overrides_audit.py` with a session-scoped `audit` fixture (autouse, scope="session") that records `len(app.dependency_overrides)` at `pytest_sessionfinish`. Add a second test that requests `client` and asserts `len(app.dependency_overrides) >= 1` mid-test. Run `uv run pytest tests/test_overrides_audit.py -v`. The audit fixture's recorded count should be `0` at session end, proving the `clear()` in the client teardown ran. Then break the `client` fixture by commenting out the `app.dependency_overrides.clear()` line; re-run — the audit should report a non-zero count, and the test should fail with a clear message. The exercise is the regression test for Mistake 6.

**Exercise 9 — Profile the engine's connection count under load.** Write a test `tests/test_engine_connection_count.py` that captures `lsof -i:5432 | grep -c postgres` (via `subprocess.run(["lsof", "-i", "5432"], capture_output=True, text=True)`) at three points: before any test runs (session-scoped fixture setup), mid-test (function-scoped fixture body), and after `eng.dispose()` (session-scoped fixture teardown). Run `uv run pytest tests/test_engine_connection_count.py -v --durations=10`. The peak count should match the engine's `pool_size + max_overflow` (default 5 + 10 = 15 for `create_async_engine`); the post-dispose count should return to the pre-run baseline. If the post-dispose count is non-zero, the engine's teardown is leaking — see the warning above about wrapping the engine body in `try/finally`.

**Exercise 10 — Trigger the typo-marker failure.** In a throwaway test file, add `@pytest.mark.asssync` (typo: triple-s) to a test, run `uv run pytest -q`. Confirm the test is rejected at collection time with `--strict-markers` (the error is `ERROR: 'asssync' not found in markers` and the exit code is non-zero). Fix the typo (`@pytest.mark.asyncio`), confirm the run is green. Then remove `--strict-markers` from `addopts` in a *copy* of the `pyproject.toml` (via `--override-ini=addopts=`) and re-add the typo; confirm the test silently passes (it is silently skipped on the typoed marker, which `pytest -m "not asssync"` does not match). The exercise proves the value of `--strict-markers` as the typo gate.

**Exercise 11 — Build a `FakeEmailClient` and prove the drift.** Write `boardly/services/email.py` with an `EmailClientProtocol` (`async def send(self, to: str, subject: str, body: str) -> None: ...`). Implement two: `SmtpEmailClient` (real, talks to `aiosmtpd.controller.Controller` started in a session fixture) and `FakeEmailClient` (appends to a `list`). Wire `get_email_client` as a FastAPI dependency; in tests, override it with the fake for the unit suite and the real-SMTP for the integration suite. Write `tests/test_email_service.py` with two tests for the same scenario (send a welcome email on user creation): one against the fake (asserts the email is in the fake's list), one against the real SMTP (asserts the email arrived in `aiosmtpd`'s captured messages). Run `uv run pytest tests/test_email_service.py -v`. Both should pass; if the fake's `to`/`subject`/`body` diverges from the real SMTP's captured values, the fake is lying — the test catches the drift. See the mock-vs-fake-vs-real trade-off table above.

**Exercise 12 — Pin a separate `.env.test` for the JWT secret.** Replace the hard-coded `jwt_secret="test-secret-32-bytes-do-not-use-in-prod!"` in the `settings` fixture with `Settings(_env_file=".env.test")` (Pydantic Settings v2 reads the file). Add `.env.test` to `.gitignore`. Add a CI step (a `pre-commit` hook or a `pytest` session fixture) that fails if `.env.test` is checked in: `assert not any(p.endswith(".env.test") for p in subprocess.run(["git", "ls-files"], capture_output=True, text=True).stdout.split())`. Write `tests/test_settings.py::test_jwt_secret_loaded_from_env_test` that asserts `settings.jwt_secret != "test-secret-32-bytes-do-not-use-in-prod!"` (proving the file override took effect). Run `uv run pytest tests/test_settings.py::test_jwt_secret_loaded_from_env_test -v`. The exercise closes the danger above (the hard-coded test secret leaking into prod-adjacent environments).

## Verification

```bash
# Collect-only: shows what would run
uv run pytest -q --co | head -20
# Expect: a list of test node IDs (tests/test_users.py::test_create_user_returns_201,
# tests/test_rbac.py::test_admin_override_can_list_any_org, etc.).
# If you see "errors during collection" the conftest.py has a top-level failure —
# usually a missing env var (use the pinned settings fixture) or a bad import.

# The real run
uv run pytest -q
# Expect: all tests passed in <5s. If any single test takes >1s the fixture scope is
# wrong (Mistake 1 — session-scoped mutation leaking across tests).

# Show the 10 slowest tests
uv run pytest -m "not slow" --durations=10
# Expect: the 10 slowest tests, each <200ms. The slowest is usually the SAVEPOINT
# setup test (~10-20ms per test for the connection + BEGIN).

# Confirm async tests are detected and run (not silently skipped)
uv run pytest --collect-only -q | grep "test_create_user"
# Expect: a line like tests/test_async_endpoints.py::test_create_user_returns_201_and_persists
# If "test_create_user" appears in collection but is "skipped" or doesn't run,
# the @pytest.mark.asyncio marker is missing — see Lesson 04.
```

## Previously Learned Here

These concepts were taught in earlier lessons. We link back instead of re-explaining:

- **`pytest`** — [[01-Python-Foundations/pytest-Fundamentals]]. The basics of `def test_*`, `assert`, `pytest.raises`. This lesson layers fixtures and scope on top.
- **Iterators / context managers** — [[01-Python-Foundations/Iterators-Generators-Context-Managers]]. A fixture is a generator with a `yield`. Setup before, teardown after.
- **`Depends`** — [[03-FastAPI-Core/Dependency-Injection]]. FastAPI's `Depends` and pytest's fixtures are siblings — composability, scope, and override patterns all rhyme. Lesson 02 here covers the testing-side override pattern.
- **AsyncSession** — [[07-SQLAlchemy/05-Session-and-Transaction-Management]]. The `session` fixture is a per-test `AsyncSession` wrapped in a transaction. Lesson 03 here goes deeper into the pattern.
- **Pydantic Settings** — [[04-Pydantic/Pydantic-Settings]]. The `pinned settings` fixture overrides the env-driven `Settings` instance so tests do not race on a stray env var. The same Settings class the production app reads drives the test fixtures.

## What's Next

In [[Testing-FastAPI-Endpoints]] we use the `client` fixture built here to test `Boardly`'s endpoints — the canonical `app.dependency_overrides` pattern that lets you test auth without issuing real JWTs. We will:

- Choose between `TestClient` (sync) and `httpx.AsyncClient` with `ASGITransport` (async).
- Override `get_session`, `get_current_user`, and `oauth2_scheme` for tests.
- Test validation errors (422) by asserting on the structured `detail`.
- Snapshot the OpenAPI schema for contract tests.

By the end of Lesson 02, `Boardly` will have a complete endpoint-test suite — the substrate that the security-test matrix from Lesson 11.04 runs in.

## Sources

- **pytest fixtures documentation** — <https://docs.pytest.org/en/stable/reference/fixtures.html> — accessed 2026-10-19 — scope, composition, `autouse`.
- **pytest parametrize** — <https://docs.pytest.org/en/stable/how-to/parametrize.html> — accessed 2026-10-19 — `@pytest.mark.parametrize`, `pytest.param`, ids.
- **"Test Pyramid" (Mike Cohn, *Succeeding with Agile*)** — <https://martinfowler.com/articles/practical-test-pyramid.html> — accessed 2026-10-19 — the canonical essay on the test pyramid.
- **model_bakery** — <https://model-bakery.readthedocs.io/> — accessed 2026-10-19 — recipe-based test data.
- **factory_boy** — <https://factoryboy.readthedocs.io/> — accessed 2026-10-19 — declarative factories.
- **"Don't Mock What You Don't Own"** — <https://hynek.me/articles/semver/> — accessed 2026-10-19 — when to mock vs use the real thing.

## What We Learned

Let's recap. In this lesson you:

- **Built `tests/conftest.py`** with session-scoped `engine` (schema built once), function-scoped `session` (transaction-rollback per test), function-scoped `client` (override + ASGITransport), `make_user` and `make_org` factory fixtures, and a pinned `settings` fixture.
- **Configured `pyproject.toml`** with `pytest-asyncio` strict mode, three custom marks, `--strict-markers --strict-config`.
- **Learned the test pyramid** — unit (1000s, sub-ms), integration (100s, 10–100 ms), e2e (5–10, seconds). The shape matters more than the count.
- **Learned fixture scope** — `function` for per-test state, `session` for expensive shared setup. The rule: largest scope that does not produce cross-test contamination.
- **Learned factory fixtures** — `make_user(**overrides)` is the right pattern for test data with variance. Fixed fixtures don't compose; factories do.
- **Hit and fixed the six classic fixture mistakes** — session-scoped mutation, project-root conftest, no `--strict-markers`, hand-built data, `pytest.fixture` everywhere, forgetting to clear `dependency_overrides`.

Here's the mental model to walk away with: *tests are software, and software has architecture. Fixtures are the architecture. The pyramid is the shape. Get the fixture scope right (session for engine, function for session, function for client) and the suite is fast and reliable; get it wrong and the suite is slow and flaky. The transaction-rollback pattern is the foundation of fast database tests. The factory-fixture pattern is the foundation of maintainable test data. The `--strict-markers` flag is the foundation of catching typos that silently skip tests.*

---

> A note from your teacher
You just built the architecture of every test suite you'll ever write. Sit with that. Two hundred lines of `conftest.py`, and `Boardly` now has a session-scoped engine, a function-scoped session wrapped in a SAVEPOINT, a `client` fixture that wires `dependency_overrides`, factory fixtures for `User` and `Org`, and a `--strict-markers` flag that catches typos before they silently skip. The pyramid is the shape; the fixtures are the architecture. Get scope right and the suite is fast and reliable; get it wrong and it's slow and flaky. We're going to use the `client` fixture to drive endpoint tests with dependency overrides next. See you in Lesson 02.


---

**Tags:** #testing #pytest #fixtures #test-pyramid #review
**Previous:** [[00-Testing-MOC]]
**Next:** [[Testing-FastAPI-Endpoints]] →
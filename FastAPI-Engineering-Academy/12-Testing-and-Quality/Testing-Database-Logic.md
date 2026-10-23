---
title: "Lesson 03: Testing Database Logic"
aliases:
 - Testing-Database-Logic
 - Isolated Test Database
 - Transaction Rollback Tests
 - Migration Testing
tags:
 - testing
 - database
 - sqlalchemy
 - alembic
 - postgresql
 - lesson
course_level: intermediate
status: complete
difficulty: advanced
estimated_time: "90 minutes"
prerequisites:
 - "[[07-SQLAlchemy/05-Session-and-Transaction-Management]]"
 - "[[07-SQLAlchemy/03-Declarative-Base-and-Mapped]]"
 - "[[09-Alembic-Migrations/Alembic-Setup-and-Workflow]]"
 - "[[12-Testing-and-Quality/Test-Pyramid-and-Fixtures]]"
related_lessons:
 - "[[Test-Pyramid-and-Fixtures]]"
 - "[[Testing-FastAPI-Endpoints]]"
 - "[[Async-Testing]]"
 - "[[07-SQLAlchemy/07-Async-SQLAlchemy]]"
---

# Lesson 03: Testing Database Logic

*Where `Boardly` gets an isolated test database, the transaction-rollback pattern that gives each test a clean state in milliseconds, and the migration-test job that catches drift between the ORM models and the Alembic scripts.*

**Tests that touch the DB must touch a real DB.**

A unit test of a function that takes a `dict` and returns a `dict` is easy. A test of a function that runs SQL is harder — the SQL has to actually run against a real database, with real constraints, real cascades, real indexes, or your test is theater. This lesson is how to run real SQL tests fast and reliably.


#testing #database #sqlalchemy #alembic #postgresql

## Learning Objectives

By the end of this lesson you will be able to:

1. **Spin up an isolated PostgreSQL test database** (or schema) per test run.
2. **Use the transaction-rollback pattern** to give each test a clean state in milliseconds.
3. **Write seeding fixtures** that compose and read clearly.
4. **Turn on SQLAlchemy's `echo=True`** for the slowest test and read the SQL it produces.
5. **Run `alembic upgrade head`** against a fresh test DB in CI to catch migration drift.
6. **Test relationships and cascades** — the class of bugs you can only catch with real SQL.

## Prerequisites

Before starting, you need:

- **AsyncSession** — [[07-SQLAlchemy/05-Session-and-Transaction-Management]]. The session is the unit of test isolation. We bind it to a per-test connection and roll back.
- **DeclarativeBase** — [[07-SQLAlchemy/03-Declarative-Base-and-Mapped]]. `Base.metadata.create_all` builds the test schema. Production uses Alembic (D-003) — Lesson 03 here runs `alembic upgrade head` in CI to catch drift.
- **Alembic workflow** — [[09-Alembic-Migrations/Alembic-Setup-and-Workflow]]. Migrations are tested in CI by running the same `alembic upgrade head` prod runs at deploy.
- **Test pyramid + fixtures** — [[Test-Pyramid-and-Fixtures]]. Session-scoped fixtures build the engine once.

**The single most common gap: "we used SQLite for tests".**

Tests that use `sqlite:///:memory:` instead of PostgreSQL pass on a developer's laptop and fail in production. SQLite does not enforce foreign keys by default, does not have `JSONB`, has different transaction semantics, and silently accepts the wrong column types. The right answer is a **separate PostgreSQL database (or schema) per CI run**, with the real schema, real types, and real constraints — but isolated, fast, and torn down between tests.


## The Problem

`Boardly` has SQL — `select(User).where(User.email == email)`, `INSERT INTO refresh_token`, `DELETE FROM org_memberships WHERE org_id = ?`. Testing this SQL against SQLite is theater — SQLite's type affinity, lack of real FK enforcement, and absence of JSONB / array columns mean tests pass for code that fails in production.

The right answer is a separate PostgreSQL database (or schema) for tests, with the real schema. But a naive implementation — `TRUNCATE every table between tests` — is slow (DDL per test) and has lock contention if parallel. The transaction-rollback pattern is the fast path: each test gets a transaction that rolls back at teardown, so the DB state is reset in milliseconds.

Why is "real PostgreSQL" non-negotiable for a PostgreSQL-backed app, when SQLite is so much faster to set up? SQLite has *type affinity* — a column declared `INTEGER` will silently store a string if you ask it to. SQLite does not enforce foreign keys unless you explicitly `PRAGMA foreign_keys=ON` (and many drivers forget). SQLite has no `JSONB` (it has JSON, but the operators and index behaviour differ). SQLite has no array columns, no `GIN` indexes, no `EXPLAIN ANALYZE` plan structure that matches PG's. Each of these is a class of bug your test would have to *separately* lie about. The transaction-rollback pattern against a real PG gives you all the speed of SQLite (one connection per test, no schema reset) *and* the correctness of running the exact SQL prod runs. The cost is one Docker container in CI; the benefit is tests that catch the bugs SQLite would have hidden.

The other problem: migration drift. The test schema comes from `Base.metadata.create_all` — but production runs Alembic migrations (D-003). The two can drift: you add a column to the model, the test passes, the migration you wrote is wrong, prod breaks. The fix is a CI job that runs `alembic upgrade head` against a fresh DB.

## The Code

Here is the complete `tests/conftest.py` excerpt focused on the DB side. (Lesson 01 here has the full `conftest.py` with the `client` fixture; this lesson focuses on the `session` and `engine` fixtures and the migration-test job.)

```python
# tests/conftest.py — DB-focused excerpt (full version in Lesson 01)
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from boardly.db import Base

TEST_DB_URL = "postgresql+asyncpg://test:test@localhost:5432/test_boardly"


@pytest_asyncio.fixture(scope="session")
async def engine():
 """The async engine. Built once per session. Schema is dropped & recreated."""
 eng = create_async_engine(TEST_DB_URL, future=True, echo=False)
 async with eng.begin() as conn:
 await conn.run_sync(Base.metadata.drop_all)
 await conn.run_sync(Base.metadata.create_all)
 yield eng
 await eng.dispose()


@pytest_asyncio.fixture
async def session(engine) -> AsyncSession:
 """Per-test session. Wrapped in a transaction that rolls back.

 The trick: `begin_nested()` creates a SAVEPOINT. Application code
 calling `commit()` releases the savepoint, not the outer transaction.
 At teardown, the outer rollback discards everything.
 """
 async with engine.connect() as conn:
 await conn.begin() # outer transaction
 sess = AsyncSession(bind=conn, expire_on_commit=False)
 await sess.begin_nested() # SAVEPOINT
 yield sess
 await sess.close()
 await conn.rollback() # discards everything
```

And here is `tests/test_org_service.py` — the canonical DB-test patterns, including cascade and constraint tests.

```python
# tests/test_org_service.py
"""Tests for OrgService — the canonical DB-test patterns.

Lesson 12.03: cascade tests, constraint tests, transaction-rollback
verifies the rollback behavior, the echo=True debug trick.
"""
import pytest
from sqlalchemy import select, text, func
from sqlalchemy.exc import IntegrityError

from boardly.models import Org, OrgMembership, User
from boardly.services.orgs import OrgService


@pytest.mark.asyncio
async def test_create_org_persists_org_and_memberships(session, make_user):
 owner = await make_user()
 m1 = await make_user(email="m1@e.st")
 m2 = await make_user(email="m2@e.st")
 service = OrgService(session)
 org = await service.create_org(name="acme", owner=owner, members=[m1, m2])
 assert org.id is not None

 count = await session.scalar(
 select(func.count()).select_from(OrgMembership)
 .where(OrgMembership.org_id == org.id)
 )
 assert count == 2


@pytest.mark.asyncio
async def test_create_org_rolls_back_on_integrity_error(session, make_user):
 """If a member is invalid (already deleted), no rows are inserted."""
 owner = await make_user()
 ghost = User(id=99999, email="ghost@e.st") # not persisted — no FK target
 service = OrgService(session)
 with pytest.raises(IntegrityError):
 await service.create_org(name="bad", owner=owner, members=[ghost])

 orgs = (await session.scalars(select(Org))).all()
 assert orgs == [], "no org row should exist after the rollback"


@pytest.mark.asyncio
async def test_deleting_org_cascades_to_memberships(
 session, make_user, make_org
):
 """FK ON DELETE CASCADE must remove memberships when the org is deleted."""
 user = await make_user()
 org = await make_org(members=[user])
 membership_id = await session.scalar(
 select(OrgMembership.id).where(OrgMembership.org_id == org.id)
 )
 await session.delete(org)
 await session.commit()
 gone = await session.get(OrgMembership, membership_id)
 assert gone is None, "membership row must be cascade-deleted"


@pytest.mark.asyncio
async def test_unique_constraint_on_user_email(session, make_user):
 """Inserting a duplicate email must raise IntegrityError."""
 await make_user(email="dup@example.com")
 with pytest.raises(IntegrityError):
 await make_user(email="dup@example.com")


@pytest.mark.asyncio
async def test_users_by_email_uses_index(session, make_user):
 """With 1000+ rows, the planner prefers the index. Catches a missing-index bug."""
 for i in range(1000):
 await make_user(email=f"u{i}@e.st")
 await session.commit()
 plan = await session.execute(
 text("EXPLAIN SELECT * FROM users WHERE email = 'u500@e.st'")
 )
 plan_text = "\n".join(row[0] for row in plan)
 assert "Index Scan" in plan_text or "Index Only Scan" in plan_text, plan_text
```

And here is the migration-test job — `tests/test_migrations.py`.

```python
# tests/test_migrations.py
"""Migration tests — `alembic upgrade head` must run cleanly on a fresh DB.

Lesson 12.03: catches drift between ORM models and Alembic scripts.
Run with: pytest tests/test_migrations.py -m integration
"""
import os
import subprocess

import pytest
from sqlalchemy import create_engine, inspect


MIGRATIONS_DB_URL = os.environ.get(
 "MIGRATIONS_DB_URL",
 "postgresql://test:test@localhost:5432/test_boardly_migrations",
)


@pytest.mark.integration
def test_alembic_upgrade_head_on_fresh_db():
 """Migrations must run cleanly on an empty database."""
 subprocess.run(
 ["alembic", "upgrade", "head"],
 check=True,
 env={**os.environ, "DATABASE_URL": MIGRATIONS_DB_URL},
 )
 eng = create_engine(MIGRATIONS_DB_URL)
 insp = inspect(eng)
 assert "users" in insp.get_table_names()
 columns = {c["name"] for c in insp.get_columns("users")}
 assert "email" in columns
 assert "password_hash" in columns
 assert "is_active" in columns


@pytest.mark.integration
def test_alembic_downgrade_one_revision():
 """Each migration must have a working downgrade."""
 subprocess.run(
 ["alembic", "upgrade", "head"],
 check=True,
 env={**os.environ, "DATABASE_URL": MIGRATIONS_DB_URL},
 )
 subprocess.run(
 ["alembic", "downgrade", "-1"],
 check=True,
 env={**os.environ, "DATABASE_URL": MIGRATIONS_DB_URL},
 )
 # After downgrade, the DB must be in a consistent state — re-upgrade.
 subprocess.run(
 ["alembic", "upgrade", "head"],
 check=True,
 env={**os.environ, "DATABASE_URL": MIGRATIONS_DB_URL},
 )
```

Read both files. Then read the dissection below — every line gets a *what* / *why* / *what-Python-or-the-framework-does-internally*.

## Line-by-Line Deep Dive

### Lines 1–10 of `conftest.py`: The session-scoped engine

```python
@pytest_asyncio.fixture(scope="session")
async def engine():
 eng = create_async_engine(TEST_DB_URL, future=True, echo=False)
 async with eng.begin() as conn:
 await conn.run_sync(Base.metadata.drop_all)
 await conn.run_sync(Base.metadata.create_all)
 yield eng
 await eng.dispose()
```

**What it does:** Builds the async engine once per pytest session, drops and recreates the schema, yields the engine, disposes it at teardown.

**Why session scope:** Building the engine and the schema is expensive (TCP, pool init, DDL). Per-test would slow the suite by 10×. Per-session means we pay this cost once.

**Why `@pytest_asyncio.fixture` and not `@pytest.fixture`:** the fixture function is `async def` with a `yield` — an async generator function. In strict mode (the modern `pytest-asyncio` default), `@pytest.fixture` does not drive async generators; it calls the function, gets an `async_generator` object back, and hands that to the test instead of an `AsyncEngine`. The test then fails with `AttributeError: 'async_generator' object has no attribute 'connect'` (or, on pytest 9+, errors at setup with "requested an async fixture with no plugin that handled it"). `@pytest_asyncio.fixture` is the async-aware decorator: it schedules the generator on the test's event loop, drives the `yield`, and passes the yielded value (the `AsyncEngine`) to the test. Both `engine` and `session` below are `async def` with `yield` — both need `@pytest_asyncio.fixture`. The full async-test failure-mode tour is in [[12-Testing-and-Quality/Async-Testing]] (Mistake 2).

**Why `Base.metadata.drop_all` then `create_all`:** Idempotent. If the schema already exists, drop it; then create. This handles the case where a previous test run crashed mid-test and left the schema in a half-state. The `drop_all` is the "start from clean" guarantee.

**Why `run_sync`:** `Base.metadata.create_all` is a synchronous SQLAlchemy API — it operates on a sync `Connection`. The async engine surfaces it via `run_sync`, which runs the sync function on a thread. The async test suite stays async; the DDL runs in a thread.

**Warning — When this breaks: a misconfigured `TEST_DB_URL` pointing at the dev DB wipes dev data on the first pytest session. The symptom: `psql dev_boardly -c '\dt'` returns 0 tables after the test run, because `Base.metadata.drop_all` ran against `dev_boardly` instead of `test_boardly`. The diagnosis: grep `conftest.py` for `TEST_DB_URL =` — the value should end in `test_boardly`, not `dev_boardly`; the env var `DATABASE_URL` should never be read by the test suite (the `settings` fixture pins the values). The fix: assert in a session-scoped autouse fixture that `TEST_DB_URL.endswith("test_boardly")` (or contains `_test`); raise `RuntimeError("TEST_DB_URL does not look like a test DB — refusing to drop tables")` if it does not. The CI should fail fast at session start, not after the schema is half-wiped. See the dev-DB danger in Mistake 2 below for the broader pattern.**


**Danger — How an attacker thinks: the hard-coded `TEST_DB_URL = "postgresql+asyncpg://test:test@localhost:5432/test_boardly"` is a credential committed in plaintext. The username `test` with password `test` is, in many CI setups, granted broader privileges than the test needs — `CREATEDB` (so the test runner can `CREATE DATABASE test_<random>` per CI run via Testcontainers or per-run isolation) or `CREATEROLE` (so the test runner can mint roles for permission-matrix tests against the [[08-PostgreSQL/Roles-Permissions-Security]] patterns). An attacker who can run code in the CI runner (via a malicious PR-merge workflow that uses `pull_request_target` with `repository: write` permission, or via a typosquatted dev dependency that imports during test collection) pivots from the test role to broader DB access: with `CREATEDB`, they `CREATE DATABASE pivot;` and use it as a staging ground for exfiltration; with `CREATEROLE`, they mint a role whose name matches an existing prod role and confuse the upstream replication slot or RLS policy. The symptom in a pentest: a CI-runner-compromise leads to unexpected new databases or roles on the shared Postgres. The defence: scope `test` to `NOSUPERUSER NOCREATEDB NOCREATEROLE` and the `test_boardly` database only (or use a separate schema per test, not a separate DB); inject the password from a secrets manager (Vault, AWS Secrets Manager) at runner-start, never commit it; rotate per CI run; add a `pg_hba.conf` line that restricts the `test` role to the `test_boardly` DB at the host level. See [[16-Deployment-and-DevOps/GitHub-Actions-CI]] for the `pull_request_target` workflow attack and the OIDC-trust-boundary defence.**


**Production reality: `pytest -n auto` (pytest-xdist) launches one worker per CPU core; each worker imports the conftest, builds its own `engine` (session-scoped per worker), and holds its own connection pool — so the *effective* connection count to the test Postgres is `workers × (pool_size + max_overflow)`. With 8 workers and the default `pool_size=5, max_overflow=10` for `create_async_engine`, that's 120 simultaneous connections to a test Postgres configured with `max_connections=100`. The result: the test suite fails at session start with `TooManyConnectionsError` on the second worker's `engine.connect()`. The fix: configure the test engine with `pool_size=2, max_overflow=0` (matches the 1-connection-per-test pattern of the SAVEPOINT fixture — only one connection is in flight per test anyway), or bound the worker count below the connection budget with `pytest -n 4`. For test engines that hold one connection per test and close at teardown, `NullPool` (`create_async_engine(TEST_DB_URL, poolclass=NullPool)`) is the cleanest choice — no pool, no checkout contention. See [[12-Testing-and-Quality/CI-Pipelines]] for the matrix-strategy worker-count choice.**


**`Base.metadata.create_all` is not how production runs migrations**

Production runs `alembic upgrade head`. `create_all` builds the schema from the ORM models directly — fast (no migration scripts), but does not catch drift between your models and your migration scripts. The migration-test job below (`tests/test_migrations.py`) is the defense against drift. The fast test suite uses `create_all`; the migration-test job uses Alembic.


### Lines 14–25: The function-scoped session with transaction-rollback

```python
@pytest_asyncio.fixture
async def session(engine) -> AsyncSession:
 """Per-test session. Wrapped in a transaction that rolls back."""
 async with engine.connect() as conn:
 await conn.begin() # outer transaction
 sess = AsyncSession(bind=conn, expire_on_commit=False)
 await sess.begin_nested() # SAVEPOINT
 yield sess
 await sess.close()
 await conn.rollback() # discards everything
```

**What it does:** Opens a connection, begins an outer transaction, creates an `AsyncSession` bound to that connection, begins a SAVEPOINT, yields the session, and at teardown closes the session and rolls back the outer transaction.

**Why `engine.connect()` not `sessionmaker()`:** The transaction-rollback pattern requires the *same connection* to be used for the outer transaction and the session. `engine.connect()` returns a connection we control; `AsyncSession(bind=conn)` binds the session to that exact connection. If we used `sessionmaker()`, each `AsyncSession()` would get a new connection from the pool, and the outer transaction would be on a different connection — rollback would do nothing.

**Warning — When this breaks: a refactor that swaps `engine.connect()` for `sessionmaker(bind=engine)()` silently breaks the SAVEPOINT contract — the session gets a *pooled* connection (potentially different per `AsyncSession()` call), the outer transaction opened by the fixture is on a different connection, and `conn.rollback()` at teardown rolls back nothing the session wrote. The symptom: tests pass during the refactor's smoke run (the rows happen to land on the same pooled connection by luck — the pool's LRU rotation hasn't kicked in yet), then start failing intermittently a week later when pool rotation puts them on different connections. The diagnosis: `psql -c "SELECT pid, application_name, state, query FROM pg_stat_activity WHERE application_name LIKE 'asyncpg%';"` shows multiple PIDs active for one test, not one; the fixture's outer transaction is on PID 1234, the session's INSERT is on PID 1235. The fix: assert in a `conftest.py` autouse fixture that `session.bind is engine` and the session's `raw_connection()` is the same one the fixture opened (capture the connection's `raw_connection().connection.dbapi_connection.fileno()` at fixture setup and compare it to the session's at test body). The guard catches the silent swap at the first test, not after a week of flaky CI. See [[07-SQLAlchemy/05-Session-and-Transaction-Management]] for the session-binding contract.**


**Production reality: the SAVEPOINT pattern's contract — `await session.commit()` inside the test hits the savepoint, not the outer transaction — depends on the application code not constructing its own `AsyncSession` mid-request. A service that in production does `async with AsyncSession(self.engine) as session: await session.commit(); ...` opens its own session bound to the engine's pool (not the fixture's connection), and the application's commit persists to the real test DB. The test still passes if the service is called with the fixture's session (the dependency override swaps `get_session` to return the fixture's session), but a service that constructs its own session internally (`session = AsyncSession(self.engine)`) bypasses the override and the test commits to the real test DB. The symptom: the test passes locally (the rows vanish because the test DB is reset at session start by `drop_all`/`create_all`) but flakes in CI under `pytest -n auto` (a parallel worker sees the leaked rows). The diagnosis: grep the service code for `AsyncSession(` — if any service constructs its own session, the dependency-override pattern does not cover it. The fix: never construct a session inside a service; always inject via `Depends(get_session)` so the override swaps it. See [[07-SQLAlchemy/05-Session-and-Transaction-Management]] and [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]] for the session-injection pattern.**


**Why `await conn.begin()` (the outer transaction):** This is the rollback target. Everything the test does — every INSERT, UPDATE, DELETE, every commit the application code makes — happens inside this transaction. At teardown, `conn.rollback()` discards all of it.

**Why `await sess.begin_nested()` (the SAVEPOINT):** This is the trick. The application code can call `await session.commit()` — its commit releases the SAVEPOINT, not the outer transaction. So the application thinks it committed; the test sees the row in subsequent queries; at teardown, the outer rollback discards the row. The application code does not need to know it is in a test.

**Why `expire_on_commit=False`:** After `await session.commit()`, accessing `obj.field` triggers a re-fetch by default (the object is "expired"). With the rollback fixture, the re-fetch can fail — the connection is mid-transaction, and the re-fetch tries to query the DB in an awkward state. Setting `expire_on_commit=False` keeps the in-memory attribute values fresh after commit — no re-fetch.

**Tip — The transaction-rollback pattern is the foundation of fast database tests.**

Without it, every test that touches the DB does a `TRUNCATE` or `DROP TABLE` + recreate. With it, every test pays only for a connection + transaction setup (~1 ms). For 1000 tests, that is the difference between 1 second and 30 seconds.


### Lines 1–22 of `test_org_service.py`: The cascade test

```python
@pytest.mark.asyncio
async def test_deleting_org_cascades_to_memberships(
 session, make_user, make_org
):
 """FK ON DELETE CASCADE must remove memberships when the org is deleted."""
 user = await make_user()
 org = await make_org(members=[user])
 membership_id = await session.scalar(
 select(OrgMembership.id).where(OrgMembership.org_id == org.id)
 )
 await session.delete(org)
 await session.commit()
 gone = await session.get(OrgMembership, membership_id)
 assert gone is None, "membership row must be cascade-deleted"
```

**What it does:** Creates an org with a member, captures the membership ID, deletes the org, commits, and asserts the membership row is gone (cascade-deleted).

**Why this test matters:** Cascades (`ondelete="CASCADE"` on the FK, or `cascade="all, delete-orphan"` on the relationship) are a class of bugs you can only catch with real SQL. If the FK constraint is missing or misconfigured, this test fails — the membership row remains after the org is deleted, which is a data-integrity bug.

**Why you cannot write this test against SQLite:** SQLite does not enforce foreign keys by default (`PRAGMA foreign_keys=OFF`). With `PRAGMA foreign_keys=OFF`, the FK constraint is not enforced — the cascade does not run, the membership row remains, and the test would pass (lying). Only with a real PostgreSQL does the cascade run, and the test catches the misconfiguration.

**Warning — When this breaks: the cascade test passes against PG but the cascade is implemented in *Python* (the ORM's `cascade="all, delete-orphan"` on the relationship triggers a separate `DELETE FROM org_memberships WHERE org_id = ?` issued by the session), not in the *database* (the FK constraint's `ON DELETE CASCADE`). If the FK constraint is missing `ON DELETE CASCADE`, the test only passes because the ORM emitted the DELETE; production code that deletes the org via raw SQL (`await session.execute(text("DELETE FROM orgs WHERE id = :id"))`) bypasses the ORM's cascade and leaves orphan memberships. The symptom: `SELECT COUNT(*) FROM org_memberships WHERE org_id NOT IN (SELECT id FROM orgs)` returns non-zero in prod after a raw-SQL cleanup job. The diagnosis: grep the migration for `ondelete="CASCADE"` on the FK; if absent, the cascade is ORM-only and raw SQL bypasses it. The fix: add `ON DELETE CASCADE` to the FK constraint and `passive_deletes=True` to the relationship so the DB does the cascade; the test then exercises the DB-level cascade, not the ORM-level. See [[06-SQL-Fundamentals/Relational-Model-and-Constraints]] for the FK-action trade-offs and [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]] for the `passive_deletes` pattern.**


**Danger — How an attacker thinks: a cascade that over-deletes is a data-destruction vector. If `OrgMembership.user_id` has `ON DELETE CASCADE` (instead of the safer `ON DELETE SET NULL` on a nullable column, or `ON DELETE RESTRICT`), deleting a user via `DELETE FROM users WHERE id = ?` cascades the deletion to every `org_memberships` row referencing that user — the user's membership history across all orgs vanishes in one statement. The attacker's workflow: compromise a user account (phished admin), call `DELETE /users/{id}` on a victim, and the audit trail in `org_memberships` is gone with the user — the audit log can no longer show "this user was a member of org X with role Y on date Z." The symptom in a pentest: a pentester deletes their own test user and the org-membership history disappears from the audit log. The defence: prefer `ON DELETE SET NULL` (nullable column) or `ON DELETE RESTRICT` (forces explicit deletion of dependent rows first) over `ON DELETE CASCADE` for any FK that backs an audit trail; assert the FK action in a migration-test (`SELECT confdelrule FROM pg_constraint WHERE conname = 'org_memberships_user_id_fkey'` returns `'r'` for RESTRICT or `'n'` for SET NULL, never `'c'` for CASCADE on audit-trail FKs). See [[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]] for the broader object-level-auth threat model.**


Could you just `PRAGMA foreign_keys=ON` in the SQLite test setup and get the same behaviour? You can turn FK enforcement on in SQLite, yes. But SQLite's cascade semantics differ from PostgreSQL's in edge cases (e.g. `ON DELETE SET NULL` on a non-nullable column — SQLite errors, PostgreSQL errors, but with different error codes). SQLite has no `JSONB` operators (`->>`, `@>`), no array columns, no `GIN` indexes, no `EXPLAIN` plan output that matches PG's. Each "we'll just enable X" fix patches one gap and ignores the next. The cumulative cost of maintaining a SQLite test setup that approximates PostgreSQL is higher than just running PostgreSQL — and the result is still subtly wrong. The lesson is: match the test DB to the prod DB. For a PG-backed app, that means a real PG in CI.

**Danger — Tests against SQLite lie about cascades.**

If your test suite uses SQLite and your production uses PostgreSQL, your cascade tests pass for code that fails in production. The same is true for unique constraints (SQLite enforces them, but with type-affinity quirks), array columns (SQLite does not have them), JSONB (SQLite has JSON but not the same operators). Use a real PostgreSQL for tests of a PostgreSQL-backed app.


### Lines 25–35: The constraint test

```python
@pytest.mark.asyncio
async def test_unique_constraint_on_user_email(session, make_user):
 """Inserting a duplicate email must raise IntegrityError."""
 await make_user(email="dup@example.com")
 with pytest.raises(IntegrityError):
 await make_user(email="dup@example.com")
```

**What it does:** Inserts a user, then tries to insert a duplicate email, asserts `IntegrityError`.

**Why this test matters:** The unique constraint on `users.email` is the defense against duplicate accounts. If the constraint is missing (someone dropped the migration) or wrong (someone wrote `Index("idx_email", User.email)` instead of `UniqueConstraint`), this test fails.

**Why `pytest.raises(IntegrityError)`:** `IntegrityError` is the SQLAlchemy exception for any constraint violation (unique, foreign key, not null). The test asserts the exception is raised — not the specific message (which is database-specific — PostgreSQL says `duplicate key value violates unique constraint`, SQLite says `UNIQUE constraint failed`).

**Danger — How an attacker thinks: the constraint test asserts the exception is raised, not the constraint's *name* or *type*. A migration that drops the `UNIQUE` constraint on `users.email` and replaces it with a `UNIQUE INDEX` (functionally similar for the simple case, but with different `pg_constraint` records — the `UNIQUE` constraint is in `pg_constraint.contype='u'`, the unique index is in `pg_class.relkind='i'` with no `pg_constraint` entry) keeps the test green while changing the security boundary: a partial unique index (`CREATE UNIQUE INDEX uq_users_email_active ON users (email) WHERE is_active = TRUE`) silently allows duplicate emails for inactive users, which an attacker can exploit to register `admin@example.com` a second time after deactivating the first. The symptom in a pentest: `admin@example.com` appears twice in `users` after a migration, and the new (attacker-controlled) row has admin scopes. The defence: assert in the test the constraint's *name* and *type* via `pg_constraint` (`SELECT contype, conname FROM pg_constraint WHERE conrelid = 'users'::regclass AND conname = 'uq_users_email'`); reject silent constraint-type swaps in CI via a `test_users_email_constraint_is_full_unique` that asserts `contype = 'u'` (table constraint, not index). See [[11-Authentication-and-Security/OWASP-API-Top-10]] for the broader account-takeover threat model.**


### Lines 38–49: The index test

```python
@pytest.mark.asyncio
async def test_users_by_email_uses_index(session, make_user):
 """With 1000+ rows, the planner prefers the index."""
 for i in range(1000):
 await make_user(email=f"u{i}@e.st")
 await session.commit()
 plan = await session.execute(
 text("EXPLAIN SELECT * FROM users WHERE email = 'u500@e.st'")
 )
 plan_text = "\n".join(row[0] for row in plan)
 assert "Index Scan" in plan_text or "Index Only Scan" in plan_text, plan_text
```

**What it does:** Inserts 1000 users, runs `EXPLAIN` on a query for one email, asserts the query plan uses an index scan.

**Why 1000 rows:** PostgreSQL's planner uses heuristics. For small tables (< ~100 rows), a sequential scan is faster than an index scan — the planner chooses seq scan. For larger tables, the planner prefers the index. 1000 rows is enough to trigger the index-preferred plan.

**Why `EXPLAIN` and not `EXPLAIN ANALYZE`:** `EXPLAIN` shows the plan; `EXPLAIN ANALYZE` runs the query and shows actual timings. For an index-presence test, `EXPLAIN` is enough — we just want to know "does the planner see an index?". `EXPLAIN ANALYZE` is slower (it runs the query) and the timings are noisy (depend on hardware).

**Why this test matters:** If the index on `users.email` is missing (someone forgot to add `index=True` to the column, or the migration does not include the index), the planner does a sequential scan. For a query that runs on every login, that is a perf regression — every login scans the whole users table.

### Lines 1–22 of `test_migrations.py`: The migration-upgrade test

```python
@pytest.mark.integration
def test_alembic_upgrade_head_on_fresh_db():
 subprocess.run(
 ["alembic", "upgrade", "head"],
 check=True,
 env={**os.environ, "DATABASE_URL": MIGRATIONS_DB_URL},
 )
 eng = create_engine(MIGRATIONS_DB_URL)
 insp = inspect(eng)
 assert "users" in insp.get_table_names()
 columns = {c["name"] for c in insp.get_columns("users")}
 assert "email" in columns
 assert "password_hash" in columns
 assert "is_active" in columns
```

**What it does:** Runs `alembic upgrade head` against a fresh test DB, then inspects the schema to assert the expected tables and columns exist.

**Why `subprocess.run`:** The `alembic` CLI is the same command prod runs at deploy. Calling it via `subprocess.run` tests the actual prod code path — not the Alembic Python API (which can have subtle differences in env handling). The `check=True` raises if the command exits non-zero.

**Why `env={**os.environ, "DATABASE_URL": MIGRATIONS_DB_URL}`:** Alembic reads its `sqlalchemy.url` from `alembic.ini` by default, but `boardly.config.Settings` reads `DATABASE_URL` from the environment. Setting `DATABASE_URL` in the subprocess env makes the Settings-driven config take precedence — testing the production config path.

**Why `@pytest.mark.integration`:** This test takes ~5 seconds (it spawns a subprocess, runs migrations, inspects the schema). Mark it `integration` so the fast test suite (`pytest -m "not integration"`) skips it. CI runs the integration stage separately.

**Warning — When this breaks: `subprocess.run(["alembic", "upgrade", "head"], check=True)` swallows the actual error if `alembic` is not on PATH in CI — the test fails with `FileNotFoundError: [Errno 2] No such file or directory: 'alembic'` (which has nothing to do with the migration's actual `IntegrityError`), and the operator spends an hour chasing a migration bug that does not exist. The symptom: CI shows `1 failed` with `FileNotFoundError` instead of the migration's real failure (a missing column, a typo in the upgrade function, a circular dependency between revisions). The diagnosis: `which alembic` returns nothing in the CI runner; the test's stack trace shows the failure originates in `subprocess.run`'s `Popen.__init__`, not in `alembic`'s `upgrade` function. The fix: wrap the `subprocess.run` in a `try/except FileNotFoundError` that raises a clearer message (`"alembic binary not on PATH — install with 'uv sync --group dev'"`); assert in a session-scoped fixture that `shutil.which("alembic")` is non-empty before any migration test runs, and skip with a clear message if not. See [[01-Python-Foundations/uv-Tooling-Workflows]] for the `uv sync --group dev` discipline.**


**Why this test matters:** The drift scenario: you add a column `User.mfa_secret` to the ORM model. You write a migration that adds the column. You run the test suite — the test passes (because `Base.metadata.create_all` creates the column from the model). You deploy — the migration runs — and fails because the migration script has a typo (`mfa_secre` instead of `mfa_secret`), or because the migration script is missing entirely (you forgot to commit it). The migration-test job catches this: it runs `alembic upgrade head` against a fresh DB, the migration fails, the test fails, the deploy is blocked.

Why does the regular test suite *not* catch this drift? Because the regular suite uses `Base.metadata.create_all`, which derives the schema from the ORM models — the models are *always* the source of truth for `create_all`. The migration script, by contrast, is hand-written SQL/Python that *should* produce the same schema but might not. The two paths are: `model → create_all → schema` (fast test suite) versus `model → alembic revision → migration script → upgrade head → schema` (prod). The fast suite proves the model is internally consistent; the migration-test job proves the *migration script* produces the same schema the model expects. These are different correctness properties, and only the migration-test job catches the second one. The local `pytest tests/` is green; the CI `pytest tests/test_migrations.py` catches the typo. Both jobs in CI, both required.

**The migration-test job is your defense against "it works on my machine"**

Local tests use `create_all`. Prod uses Alembic. The two can diverge. The migration-test job runs Alembic — the same command prod runs — and asserts the resulting schema matches what the app expects. This is the gap-coverage between "model says X" and "migration creates X".


**Danger — How an attacker thinks: the migration-test job asserts the column *exists*, not that the constraint *still exists*. A migration that drops a `NOT NULL` constraint from `users.is_admin` (under the rationale "we'll default it server-side") is a privilege-escalation primer: the column is now nullable, the ORM's default of `False` only applies on `INSERT` (not on `UPDATE`), and an attacker who can `INSERT INTO users (email, is_admin) VALUES ('attacker@example.com', NULL)` gets a row with `is_admin IS NULL` — and if the application's `if user.is_admin:` check treats `None` as truthy in any path (a long-standing Python falsy-vs-truthy bug surface, especially in Jinja templates and `if user.is_admin or user.org_id in admin_orgs:` compound checks), the attacker has admin. The symptom in a pentest: a user with `is_admin IS NULL` has admin access. The defence: extend the migration-test job to assert the constraint's *presence* via `pg_constraint` (`SELECT count(*) FROM pg_constraint WHERE conrelid = 'users'::regclass AND contype = 'c' AND conname = 'users_is_admin_not_null'` — `contype='c'` is a CHECK constraint, the modern way to enforce NOT NULL invariantly), not just the column's existence; reject any migration that drops a `NOT NULL` or CHECK constraint on a privilege column without an explicit `REVIEW=SECURITY` tag in the migration docstring. See [[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]] for the broader privilege-boundary threat model.**


**Production reality: `alembic upgrade head` against a fresh test DB catches *schema* drift (the column exists, the index exists, the constraint is present), not *data* drift (the legacy rows have valid values). The migration that backfills `password_hash` for legacy users with `NULL` hashes using a `bcrypt` hash of `"changeme"` is a *data* migration; the migration-test job asserts the column exists, not that the legacy rows have non-NULL hashes. A separate `tests/test_data_migrations.py` is the gap-coverage: it seeds a fixture row with `password_hash IS NULL`, runs the migration against a fresh DB, and asserts the row's `password_hash` is non-NULL and verifies against `"changeme"` via `bcrypt.checkpw(...)`. See [[09-Alembic-Migrations/Data-Migrations-Safely]] for the data-migration testing pattern and the `REVIEW=DATA` tag convention.**


### Lines 25–42: The downgrade test

```python
@pytest.mark.integration
def test_alembic_downgrade_one_revision():
 """Each migration must have a working downgrade."""
 subprocess.run(["alembic", "upgrade", "head"], check=True, env=...)
 subprocess.run(["alembic", "downgrade", "-1"], check=True, env=...)
 subprocess.run(["alembic", "upgrade", "head"], check=True, env=...)
```

**What it does:** Upgrades to head, downgrades one revision, re-upgrades to head. If any of the three commands fail, the test fails.

**Why downgrade matters:** "We'll never roll back" — until you do. A bad migration ships; you need to roll back. If the downgrade is `pass` (a common shortcut), the rollback leaves the DB in a half-state — the column was added but the downgrade did not drop it, so the re-upgrade fails ("column already exists").

**Why `@pytest.mark.xfail` for irreversible migrations:** Some migrations are intentionally irreversible (e.g. dropping a column — the data is gone). Mark them `@pytest.mark.xfail(reason="intentionally irreversible")` — the test runs, expects the failure, and does not block CI. Marking `xfail` is the explicit "we know this is irreversible" signal.

## Three Database Isolation Strategies

```mermaid
flowchart TB
 A["Strategy A: in-memory SQLite"]
 B["Strategy B: schema-per-test in shared PG"]
 C["Strategy C: dedicated PG database + transaction rollback"]
 A -->|"wrong types, wrong constraints"| Fail["tests lie"]
 B -->|"slow, lock contention"| SlowOK["tests correct but slow"]
 C -->|"fast, real, isolated"| Win["tests correct AND fast"]
 style Fail fill:#fee2e2
 style SlowOK fill:#fef3c7
 style Win fill:#dcfce7
```

| Strategy | Real PG? | Fast? | Reliability |
|---|---|---|---|
| **A** in-memory SQLite, `create_all` | No | Very | Lies. Wrong types, wrong FK semantics. Only for tests that don't touch DB-specific features. |
| **B** schema-per-test in a shared PG | Yes | Slow | Correct, but `CREATE SCHEMA` per test is expensive. Lock contention if parallel. |
| **C** one PG database, transaction rollback per test | Yes | Fast | The right default for a FastAPI + SQLAlchemy app. |

We teach Strategy C as the default. Strategy A is for fast pure-logic tests where you do not care about PG specifics; B is for when you need DDL-level isolation (rare — e.g. testing a multi-tenant `SET search_path` flow).

## The `echo=True` Debug Trick

When a test is slow and you don't know why, turn on SQLAlchemy's SQL echo:

```python
eng = create_async_engine(TEST_DB_URL, echo=True, future=True)
```

Or, per-test:

```python
@pytest_asyncio.fixture
async def verbose_session(engine):
 eng = create_async_engine(TEST_DB_URL, echo=True, future=True)
 async with eng.connect() as conn:
 ...
```

The output is noisy but unambiguous. You will see N+1 queries (a `SELECT` for the parent, then a `SELECT` for each child in a loop), `BEGIN` without `COMMIT` (a transaction that never closed), the wrong column being indexed (the planner chooses a seq scan when you expected an index scan). `echo="debug"` adds rollback visibility.

**Student asks: Why nested `SAVEPOINT`s at all — why not just call `session.rollback()` once at the end of each test?**

Because `session.rollback()` at the end of the test would roll back the *session's* view of the data, but it would leave the rows physically in the database for the duration of the test (any other test running in parallel against the same DB would see them). The savepoint pattern gives you per-test isolation with *one* shared DB connection: each test runs inside its own savepoint (`SAVEPOINT sp1` … test body … `ROLLBACK TO SAVEPOINT sp1`), so within a test the application's `commit()` is real (rows are visible to the next query on the same session), and across tests the rows are discarded before the next test starts. The alternative — one transaction per test, with `session.rollback()` at teardown — does isolate tests from each other, but it has two costs: (1) you cannot write a test that asserts "the application's `commit()` actually persisted the row" because the commit becomes a no-op inside an uncommitted outer transaction, and (2) you cannot run tests in parallel on the same DB connection without lock contention, because each test's outer transaction holds its own connection. The savepoint pattern is the trick that lets one connection serve many tests with full isolation and realistic commit semantics. That is the entire reason this lesson teaches Strategy C (savepoints) instead of Strategy B (one transaction per test).


## Execution Trace: the savepoint-rollback pattern

```mermaid
sequenceDiagram
 participant T as Test
 participant F as session fixture
 participant C as Connection
 participant S as Session
 participant DB as PostgreSQL

 F->>C: engine.connect()
 F->>C: conn.begin() (outer transaction)
 F->>S: AsyncSession(bind=conn, expire_on_commit=False)
 F->>S: sess.begin_nested() (SAVEPOINT)
 F-->>T: yield session

 T->>S: session.add(user)
 T->>S: await session.commit()
 Note over S,DB: commit hits the SAVEPOINT (RELEASE SAVEPOINT),<br/>not the outer txn — data is in the txn, not persisted
 S->>DB: INSERT INTO users ... (visible to this connection)

 T->>S: session.delete(org)
 T->>S: await session.commit()
 Note over S,DB: same — SAVEPOINT released, data still in outer txn

 T-->>F: test done

 F->>S: session.close()
 F->>C: conn.rollback()
 Note over C,DB: outer rollback discards everything<br/>— the schema is back to empty
```

The key insight: the application code (the service, the route) calls `await session.commit()` thinking it is persisting data. The commit hits the SAVEPOINT — `RELEASE SAVEPOINT` in SQL terms — and the data stays inside the outer transaction. At teardown, the outer `conn.rollback()` discards everything. The application code does not know it is in a test.

The same pattern as a colour-coded state machine. Green is the application's happy-path view ("I inserted a row, I committed, the row is there"), amber is the per-test transaction boundary (the SAVEPOINT the application commits to, which is *not* the outer transaction), red is the teardown path (the rollback that wipes the data the application thought it persisted). The structural property this diagram makes visible: the application never sees the outer transaction. From inside the application code, `await session.commit()` looks identical in a test and in production — only the *binding* (the connection's transaction nesting) differs.

```mermaid
flowchart TD
    Setup["Fixture setup<br/>engine.connect()<br/>conn.begin() outer txn"]
    Savepoint["begin_nested()<br/>SAVEPOINT sp1"]
    Yield["yield session to test"]
    AppInsert["Application code<br/>session.add(user)<br/>await session.commit()"]
    ReleaseSp["RELEASE SAVEPOINT sp1<br/>(application thinks it committed)"]
    Visible["Row visible to this connection<br/>but not to the DB<br/>(still inside outer txn)"]
    Teardown["Fixture teardown<br/>session.close()"]
    Rollback["conn.rollback()<br/>discards everything"]
    Clean["Schema is clean<br/>next test starts fresh"]

    Setup --> Savepoint
    Savepoint --> Yield
    Yield --> AppInsert
    AppInsert --> ReleaseSp
    ReleaseSp --> Visible
    Visible --> Teardown
    Teardown --> Rollback
    Rollback --> Clean

    style Setup fill:#d4edda,stroke:#28a745,color:#155724
    style Savepoint fill:#fff3cd,stroke:#ffc107,color:#664d03
    style Yield fill:#d4edda,stroke:#28a745,color:#155724
    style AppInsert fill:#d4edda,stroke:#28a745,color:#155724
    style ReleaseSp fill:#fff3cd,stroke:#ffc107,color:#664d03
    style Visible fill:#fff3cd,stroke:#ffc107,color:#664d03
    style Teardown fill:#d4edda,stroke:#28a745,color:#155724
    style Rollback fill:#f8d7da,stroke:#dc3545,color:#721c24
    style Clean fill:#d4edda,stroke:#28a745,color:#155724
```

**Student asks: Why does the application's `commit()` release the SAVEPOINT and not the outer transaction?**

Because the session is *bound* to the connection that already has an open outer transaction. SQLAlchemy's `commit()` issues a `RELEASE SAVEPOINT` when the session is in a nested-transaction context (`begin_nested()` was called). The outer transaction was opened by the *fixture*, not by the session, so the session cannot commit it — only the fixture can, by calling `conn.commit()`. The fixture deliberately never does that; it calls `conn.rollback()` at teardown instead. So the application's `commit()` is real SQL (`RELEASE SAVEPOINT`) but the semantic effect is "the row is now visible to subsequent queries on this connection, but no one else can see it, and it will be discarded at teardown". The application gets the behaviour it expects (the row is visible in the same session); the test gets the isolation it needs (the row vanishes after the test).


**Student asks: What if the application code calls `session.rollback()` itself — does that break the fixture?**

No, but it changes the state the application sees. When application code calls `await session.rollback()`, SQLAlchemy issues `ROLLBACK TO SAVEPOINT sp1` — the savepoint's contents are discarded, but the savepoint still exists (and the outer transaction is untouched). The next operation on the session is back to the savepoint's start state. The fixture's outer rollback at teardown still works; the application's own rollback just rolls back to a different point inside the savepoint's lifetime. The one case to watch for is if the application code calls `session.close()` *and* the application also depends on the session still being usable afterwards — that's a bug in the application, not the fixture. In tests, the session is *borrowed* from the fixture; the application should not close it.


## Common Mistakes

### Mistake 1: Tests using `sqlite:///:memory:` for a PG-backed app

```python
# WRONG
@pytest_asyncio.fixture(scope="session")
async def engine():
    return create_async_engine("sqlite:///:memory:")   # ← in-memory sqlite
```

**Symptom:** Tests pass on a developer's laptop, fail in production. SQLite does not enforce FKs by default, has no JSONB, no array columns, no real FK enforcement, different transaction semantics.

**Why:** SQLite is fast, in-memory, zero-config. The temptation is to use it for tests. But the SQL that runs in tests is not the SQL that runs in prod.

**Fix:** Use a real PostgreSQL. The Docker Compose service-container pattern is one line in `docker-compose.yml`. The CI service container is one block in `.github/workflows/ci.yml`. The cost is ~5 seconds of startup; the benefit is tests that actually test the prod SQL.

```python
# RIGHT
@pytest_asyncio.fixture(scope="session")
async def engine():
    return create_async_engine(
        "postgresql+asyncpg://boardly:boardly@localhost:5432/boardly_test",
        pool_pre_ping=True,
    )
```

### Mistake 2: Tests using the dev database

**Symptom:** Tests pollute the dev database. Dev data appears in test fixtures. Tests fail because dev has rows the test did not expect.

**Why:** The dev database is shared with developers. Tests must not write to it — they would corrupt dev data and break other developers.

**Fix:** A dedicated test database. Create it in CI (a service container); on a developer's machine, a separate `test_boardly` database on the same PostgreSQL instance.

### Mistake 3: Tests that share a transaction across tests

```python
# WRONG — one session for the whole suite; rows leak across tests
@pytest_asyncio.fixture(scope="session")
async def session(engine):
    async with AsyncSession(engine) as s:
        yield s   # ← rows committed by test A are visible in test B
```

**Symptom:** Test A inserts a row. Test B sees the row. Test B's assertions about "the table is empty" fail.

**Why:** Without the transaction-rollback pattern, the session persists across tests. The row from test A is visible in test B.

**Fix:** The per-test transaction-rollback fixture. Each test gets its own connection, its own outer transaction, its own rollback at teardown. The schema is reset in milliseconds.

```python
# RIGHT — function-scoped; rollback at teardown
@pytest_asyncio.fixture
async def session(engine):
    conn = await engine.connect()
    trans = await conn.begin()
    sess = AsyncSession(bind=conn, expire_on_commit=False)
    yield sess
    await sess.close()
    await trans.rollback()
    await conn.close()
```

### Mistake 4: Forgetting `expire_on_commit=False`

```python
# WRONG
sess = AsyncSession(bind=conn)   # expire_on_commit defaults to True
await sess.commit()
return user  # ← later access to user.id raises MissingGreenlet
```

**Symptom:** Test calls `await session.commit()`, then accesses `obj.id`. The access raises `MissingGreenlet` (because the re-fetch needs an async context, and the test code might be past the await).

**Why:** After `commit()`, SQLAlchemy "expires" the object — the next attribute access triggers a re-fetch. With the rollback fixture, the re-fetch fails (the connection is in an awkward state mid-transaction).

**Fix:** Set `expire_on_commit=False` on the session. The in-memory attribute values stay fresh after commit — no re-fetch.

```python
# RIGHT
sess = AsyncSession(bind=conn, expire_on_commit=False)
await sess.commit()
return user  # ← user.id stays in memory; no re-fetch
```

### Mistake 5: Using `await session.refresh(obj)` on a committed-then-rolled-back row

**Symptom:** Same as Mistake 4 — the refresh tries to re-fetch, fails with `MissingGreenlet` or a similar error.

**Why:** Same cause — refresh triggers a re-fetch.

**Fix:** Set `expire_on_commit=False`, then access attributes from the in-memory object. Don't refresh — the object is already in memory.

### Mistake 6: Migrations and `create_all` drift

```python
# WRONG — tests build the schema from the model, never run the migrations
@pytest_asyncio.fixture(scope="session", autouse=True)
async def build_schema(engine):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)   # ← never runs alembic
```

**Symptom:** You add a column to the `User` model. The test suite uses `Base.metadata.create_all` — passes. You write the Alembic migration. The migration has a typo (`mfa_secre` instead of `mfa_secret`). You deploy. The migration fails. Prod is down.

**Why:** The test schema comes from `create_all` (from the model). Prod schema comes from Alembic (from the migration scripts). The two can diverge — `create_all` always works because it derives from the model; Alembic can fail because the migration is hand-written.

**Fix:** A migration-test CI job — `tests/test_migrations.py`. Runs `alembic upgrade head` against a fresh DB, asserts the schema matches what the app expects. The migration-test job is the defense against drift.

```python
# RIGHT — separate CI job runs alembic
@pytest.mark.integration
def test_alembic_upgrade_head_matches_models():
    subprocess.run(["alembic", "upgrade", "head"], check=True)
    # Then assert the resulting schema matches Base.metadata
    inspector = inspect(engine.sync_engine)
    actual = {t.name: {c["name"] for c in inspector.get_columns(t.name)}
              for t in inspector.get_tables()}
    expected = {t.name: {c.name for c in t.columns}
                for t in Base.metadata.tables.values()}
    assert actual == expected
```

### Mistake 7: Not testing down-migrations

```python
# WRONG — "irreversible" downgrade is a common shortcut
def upgrade():
    op.add_column("users", sa.Column("mfa_secret", sa.String(64)))

def downgrade():
    pass   # ← silently does nothing; prod is left half-migrated on rollback
```

**Symptom:** A bad migration ships. You need to roll back. The downgrade is `pass` (a common shortcut for "irreversible"). The rollback leaves the DB in a half-state. The re-upgrade fails.

**Why:** "We'll never roll back" — until you do. Downgrades are tested less than upgrades because they are less common, but when you need one, you need it to work.

**Fix:** Down-migration tests (`test_alembic_downgrade_one_revision`). For intentionally irreversible migrations, mark `@pytest.mark.xfail(reason="intentionally irreversible")` — the test runs, expects the failure, and does not block CI.

```python
# RIGHT — test the downgrade, or mark intentional irreversibility
def test_alembic_downgrade_one_revision():
    rev_before = alembic_command.current(alembic_cfg)
    alembic_command.downgrade(alembic_cfg, "-1")
    rev_after = alembic_command.current(alembic_cfg)
    assert rev_after != rev_before
    alembic_command.upgrade(alembic_cfg, "head")   # restore
```

### Mistake 8: `autoflush=True` (the default) biting tests

**Symptom:** A query before `commit()` triggers a flush. The flush sends the `INSERT` to the DB. The test relies on "this row is not yet visible to other transactions" — but it is, because autoflush sent it.

**Why:** SQLAlchemy's default `autoflush=True` flushes the session before every query, so the query sees the pending changes. For most app code, this is the right behavior. For tests that check "the row is not visible yet", it is a footgun.

**Fix:** Set `session.autoflush = False` for those specific tests, or use the `with session.no_autoflush:` block. Don't disable globally — autoflush is the right default for app code.

## Engineering Trade-Offs

### `create_all` vs `alembic upgrade head` in tests

| Approach | Speed | Drift coverage | When |
|---|---|---|---|
| `create_all` | Fast (one Python call) | No drift coverage (model is always right by definition) | The fast test suite. |
| `alembic upgrade head` | Slower (subprocess + migration scripts) | Yes — catches drift between models and scripts | A separate CI job, not in the fast suite. |

Run `create_all` in the fast suite; run `alembic upgrade head` in a separate CI job. The migration-test job is the defense against drift.

### One DB vs schema-per-test

| Approach | Speed | When |
|---|---|---|
| One DB + transaction-rollback | Fast (ms per test) | The default. |
| Schema-per-test | Slow (DDL per test) | When you need DDL-level isolation (rare — e.g. multi-tenant `SET search_path` flows where `search_path` is under test). |

One DB + transaction-rollback is the sweet spot. Schema-per-test is for the rare cases where DDL itself is under test.

### Testcontainers vs CI service containers

| Approach | Portability | Setup | When |
|---|---|---|---|
| Testcontainers | High (Docker-in-Python, works locally) | Requires Docker-in-Docker in CI | When you want the same setup locally and in CI. |
| CI service containers | CI-native (GitHub Actions services) | No Docker-in-Docker required | When CI is GitHub Actions. |

Service containers are CI-native; Testcontainers is portable. Lesson 05 here covers the service-container pattern.

### Dedicated test DB vs ephemeral

| Approach | Setup | When |
|---|---|---|
| A long-lived `test_boardly` DB | One-time setup, schema recreated on changes | Developer's machine. |
| An ephemeral DB per CI run | Created fresh per run, dropped at end | CI. |

A long-lived DB on a dev machine is fine if it is recreated on schema changes. CI should create a fresh DB per run — service containers handle this automatically (the container is destroyed at the end of the job).

## Exercises

**Tip — The 20-minute rule**

If you're stuck on an exercise for more than 20 minutes, re-read the relevant section above, then move on.


**Exercise 1 — Add `expire_on_commit=False`.** Add it to a session fixture. Write a test that does `await session.commit()` then accesses `obj.id`. Compare the behavior to a fixture without the flag.

**Exercise 2 — Write a unique-constraint test.** Write a test that asserts a unique constraint exists on `users.email` by inserting a duplicate and catching `IntegrityError`. Then write the test against SQLite — see it silently allow the duplicate (with `PRAGMA foreign_keys=OFF`).

**Exercise 3 — The round-trip migration test.** Write a CI job that runs `alembic upgrade head` against a fresh PG, then `alembic downgrade -1`, then `alembic upgrade head` again. The DB must end in the same state. (Hint: snapshot the table list before and after.)

**Exercise 4 — Spot the bug.** This conftest is broken. Why?

```python
@pytest.fixture
async def session(engine):
 sess = AsyncSession(bind=engine, expire_on_commit=True)
 yield sess
 await sess.close()
```

(Answer: (a) `expire_on_commit=True` — Mistake 4. (b) No outer transaction — no rollback target. (c) No `engine.connect()` — the session uses pool connections, no shared outer txn. (d) No `begin_nested()` — application commits persist. (e) `@pytest.fixture` on `async def` — in strict mode the fixture returns an `async_generator` object instead of an `AsyncSession`; the test would fail with `AttributeError: 'async_generator' object has no attribute 'execute'` before any of (a)-(d) could even bite. The test would mutate the real DB once (e) is fixed and (a)-(d) are not.)

**Exercise 5 — Add a `test_partitions_by_created_at` test.** If `Boardly` partitions `users` by `created_at` (range partitioning), write a test that inserts a user with `created_at = 2024-01-15` and asserts the row lands in the `users_2024_01` partition. (Hint: `SELECT tableoid::regclass FROM users WHERE id = ?` returns the partition name.)

**Exercise 6 — Use `echo=True` to find an N+1.** Take a slow test, turn on `echo=True`, read the SQL output. Find a query that runs N times (e.g. one `SELECT` per item in a list). Fix it with `selectinload` or `joinedload`. Measure the speedup.

**Exercise 7 — Reproduce the SAVEPOINT lock-contention under `TRUNCATE`.** Add a `clean_users` fixture to `tests/conftest.py` that does `await session.execute(text("TRUNCATE users"))` before yielding. Write two tests in `tests/test_truncate_lock.py` that both touch `users` (one inserts, one counts). Run `uv run pytest tests/test_truncate_lock.py -v -n 2` (pytest-xdist parallelism=2). The `TRUNCATE` acquires an `ACCESS EXCLUSIVE` lock on `users` for the test's duration (PostgreSQL 17 is transactional for DDL — the lock is held inside the savepoint's outer transaction and only released at `conn.rollback()` at teardown); the parallel test blocks on `pg_locks` until the lock-holding test's teardown runs. Confirm via `psql -c "SELECT mode, granted, pid FROM pg_locks WHERE relation = 'users'::regclass;"` during the run — you'll see `AccessExclusiveLock` held by one test's PID with `granted = t`, the other test's PID waiting with `granted = f`. Replace `TRUNCATE users` with `DELETE FROM users` (DML, acquires `ROW EXCLUSIVE` — compatible with parallel readers/writers); re-run — both tests run in parallel without blocking, and the wall-clock is roughly half. The exercise demonstrates why the SAVEPOINT pattern prefers DML over per-test DDL; see the lock-contention warning in [[12-Testing-and-Quality/Test-Pyramid-and-Fixtures]].

**Exercise 8 — Verify the cascade with `passive_deletes=True`.** Add `passive_deletes=True` to the `OrgMembership.org` relationship in `boardly/models.py` and `ON DELETE CASCADE` to the FK constraint in the migration. Re-run the cascade test. The DB should cascade-delete the memberships; the ORM should not issue a `DELETE FROM org_memberships`. Verify with `uv run pytest tests/test_org_service.py::test_deleting_org_cascades_to_memberships -v -s` and inspect the SQL log (with `echo=True` on a `verbose_session` fixture) — expect zero `DELETE FROM org_memberships` statements, only the `DELETE FROM orgs WHERE id = ?`. The exercise proves the DB-level cascade is wired up, not the ORM-level — closing the raw-SQL bypass gap above.

**Exercise 9 — Catch the `alembic` PATH-not-found failure.** Wrap `subprocess.run(["alembic", ...], check=True)` in a `try/except FileNotFoundError` that raises `RuntimeError("alembic binary not on PATH — install with 'uv sync --group dev'")`. Add a session-scoped autouse fixture that asserts `shutil.which("alembic")` is non-empty and skips the migration tests with a clear message if not. Run `uv run pytest tests/test_migrations_wrapper.py -v` with `PATH` cleared (`env -i PATH=/nonexistent uv run pytest tests/test_migrations_wrapper.py -v`) to verify the wrapper catches the missing-binary case and surfaces the actionable message instead of the raw `FileNotFoundError`. The exercise closes the warning above.

**Exercise 10 — Audit `TEST_DB_URL` for the dev-DB footgun.** Add a session-scoped autouse fixture to `tests/conftest.py` that asserts `TEST_DB_URL.endswith("test_boardly")` or contains `_test` — fail the session with `RuntimeError("TEST_DB_URL does not look like a test DB — refusing to drop tables")` if it does not. Run `uv run pytest tests/test_db_url_safety.py -v` with `TEST_DB_URL=postgresql+asyncpg://dev:dev@localhost/dev_boardly` (exported inline: `TEST_DB_URL=... uv run pytest ...`) to verify the guard fires and blocks the run before any `drop_all` executes. The exercise is the regression test for the dev-DB wipe warning above.

**Exercise 11 — Pin a `NOT NULL` invariant test.** Write a test `tests/test_user_constraints.py::test_email_not_null` that asserts `users.email` has a `NOT NULL` constraint by attempting `await session.execute(text("INSERT INTO users (email) VALUES (NULL)"))` and catching `IntegrityError`. Write a second migration (`alembic revision -m "drop not null on email"`) that drops the `NOT NULL`; re-run the test — it should catch the drift (no `IntegrityError` raised, the test fails). Verify with `uv run pytest tests/test_user_constraints.py::test_email_not_null -v` and confirm the test fails on the drifted schema. The exercise is the regression test for the constraint-drift danger above.

**Exercise 12 — Add a data-migration test for legacy password hashes.** Write a migration (`alembic revision -m "backfill legacy password hashes"`) that backfills `password_hash` for legacy users (with `NULL` hash) using a `bcrypt` hash of `"changeme"`. Write a test `tests/test_data_migrations.py::test_legacy_users_have_hash_after_migration` that seeds a fixture row with `password_hash IS NULL` via `make_user(password_hash=None)`, runs the migration against the test DB (`subprocess.run(["alembic", "upgrade", "head"], ...)`), and asserts the row's `password_hash` is non-NULL and verifies via `bcrypt.checkpw(b"changeme", row.password_hash.encode())`. Verify with `uv run pytest tests/test_data_migrations.py -v --basetemp=/tmp/legacy`. The exercise closes the data-drift gap above.

## Verification

```bash
# Pre-flight: the test DB must be reachable
psql "$DATABASE_URL" -c "SELECT version();"
# Expect: PostgreSQL 17.x on x86_64-pc-linux-gnu, compiled by gcc ..., 64-bit
# (a row is returned; if you get "connection refused" the service container
# or healthcheck is broken — see CI-Pipelines Mistake 2).

# The DB tests
uv run pytest tests/test_org_service.py tests/test_migrations.py -v --tb=short
# Expect: ~6-8 tests passing, including
# test_create_org_persists_org_and_memberships
# test_cascade_delete_removes_memberships
# test_unique_constraint_on_org_email
# test_alembic_upgrade_head_then_downgrade_minus_one_then_upgrade_head
# No MissingGreenlet. No IntegrityError on the cascade test.

# Debug SQL for one slow test
uv run pytest tests/test_org_service.py::test_create_org_persists_org_and_memberships \
 -v -s -k echo
# Expect: the SQL for BEGIN, INSERT into orgs, INSERT into org_memberships,
# RELEASE SAVEPOINT, ROLLBACK. Fewer than 5 queries for one org create.
# If you see 50+ queries, you have an N+1 — see N-plus-1-and-Slow-Queries.
```

## Previously Learned Here

These concepts were taught in earlier lessons. We link back instead of re-explaining:

- **AsyncSession** — [[07-SQLAlchemy/05-Session-and-Transaction-Management]]. The session is the unit of test isolation. We bind it to a per-test connection and roll back.
- **DeclarativeBase** — [[07-SQLAlchemy/03-Declarative-Base-and-Mapped]]. `Base.metadata.create_all` builds the test schema. Production uses Alembic (D-003) — the migration-test job is the defense.
- **Alembic workflow** — [[09-Alembic-Migrations/Alembic-Setup-and-Workflow]]. The migration-test CI job runs `alembic upgrade head` — the same command prod runs at deploy.
- **Test pyramid + fixtures** — [[Test-Pyramid-and-Fixtures]]. The `engine` and `session` fixtures are the integration tier of the pyramid.

## What's Next

In [[Async-Testing]] we cover the gotchas. Async code is the most common reason a FastAPI test suite stops working — `MissingGreenlet`, `Event loop is closed`, `RuntimeWarning: coroutine was never awaited`. We will:

- Pick between `pytest-asyncio` strict/auto vs the `anyio` plugin.
- Use `@pytest.mark.asyncio` correctly (or forget it and watch the test silently skip).
- Write async fixtures and compose them correctly.
- Diagnose the three classic async-test errors in 30 seconds each.

By the end of Lesson 04, `Boardly`'s test suite is async-clean — no `MissingGreenlet`, no leaked event loops, no silently-skipped async tests.

## Sources

- **SQLAlchemy testing** — <https://docs.sqlalchemy.org/en/20/orm/session_transaction.html#joining-a-session-into-an-external-transaction-such-as-for-test-suites> — accessed 2026-10-19 — the official pattern this lesson implements.
- **pytest fixtures** — <https://docs.pytest.org/en/stable/reference/fixtures.html> — accessed 2026-10-19 — fixture scope, `autouse`.
- **Alembic testing** — <https://alembic.sqlalchemy.org/en/latest/cookbook.html#test-against-multiple-backends> — accessed 2026-10-19 — running migrations in CI.
- **Testcontainers for Python** — <https://testcontainers-python.readthedocs.io/> — accessed 2026-10-19 — Docker-in-Python for ephemeral DBs.
- **PostgreSQL `EXPLAIN`** — <https://www.postgresql.org/docs/current/sql-explain.html> — accessed 2026-10-19 — reading plans in tests.
- **"Don't test against SQLite when you run on Postgres"** — <https://www.craigkerstiens.com/2013/03/07/postgres-vs-sqlite/> — accessed 2026-10-19 — the case for real PG in tests.

## What We Learned

Let's recap. In this lesson you:

- **Built the transaction-rollback pattern** in `tests/conftest.py` — `engine.connect()` + `conn.begin()` + `AsyncSession(bind=conn)` + `sess.begin_nested()` (SAVEPOINT) + `conn.rollback()` at teardown. Application commits hit the SAVEPOINT; the outer rollback discards everything.
- **Built `tests/test_org_service.py`** with the cascade test, the constraint test, the index test — the class of bugs you can only catch with real SQL.
- **Built `tests/test_migrations.py`** with the upgrade test and the downgrade test — the defense against drift between ORM models and Alembic scripts.
- **Learned why SQLite lies** — no FK enforcement by default, no JSONB, no array columns, different transaction semantics. Use a real PostgreSQL for tests of a PostgreSQL-backed app.
- **Learned the `echo=True` debug trick** — turn it on for the slowest test, read the SQL, find N+1 queries and missing indexes.
- **Hit and fixed the eight classic DB-test mistakes** — SQLite for a PG-backed app, tests using the dev DB, shared transaction across tests, missing `expire_on_commit=False`, refresh on a rolled-back row, migrations-and-create_all drift, not testing down-migrations, `autoflush=True` biting tests.

Here's the mental model to walk away with: *the transaction-rollback pattern is the foundation of fast database tests. Each test gets a connection, an outer transaction, and a SAVEPOINT. Application commits hit the SAVEPOINT — the data is in the transaction, not persisted. At teardown, the outer rollback discards everything. The schema is built once per session (session-scoped engine); each test pays only for connection + transaction setup (~1 ms). The migration-test CI job runs `alembic upgrade head` against a fresh DB — the defense against drift between ORM models and Alembic scripts. Both patterns are non-negotiable for a reliable test suite.*

---

> A note from your teacher
You just built the pattern that makes a 2000-test DB suite run in seconds. Sit with that. Two patterns, one suite: the SAVEPOINT rollback keeps each test isolated at the cost of a single `BEGIN` per test; the migration-test CI job keeps your Alembic scripts honest against the ORM models. The two together are non-negotiable for a reliable suite. The next lesson's async fixtures will lean on the same `conftest.py` you just wrote — and the three classic async-test errors that take down junior engineers' first CI runs are what we tackle there. See you in Lesson 04.


---

**Tags:** #testing #database #sqlalchemy #alembic #postgresql #review
**Previous:** [[Testing-FastAPI-Endpoints]]
**Next:** [[Async-Testing]] →
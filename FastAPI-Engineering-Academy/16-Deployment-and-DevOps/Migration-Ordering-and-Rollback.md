---
title: "Lesson 04: Migration Ordering, Rollback, and the Expand-Contract Pattern"
aliases:
 - Migration deployment order
 - Expand-contract pattern
 - Zero-downtime migrations
 - pg_advisory_lock
tags:
 - deployment
 - alembic
 - migrations
 - devops
 - lesson
course_level: advanced
status: complete
difficulty: advanced
estimated_time: "75–100 minutes"
prerequisites:
 - "[[09-Alembic-Migrations/Deploying-Migrations-in-Production]]"
 - "[[09-Alembic-Migrations/Data-Migrations-Safely]]"
 - "[[07-SQLAlchemy/05-Session-and-Transaction-Management]]"
 - "[[06-SQL-Fundamentals/Transactions-Isolation-Locks]]"
related_lessons:
 - "[[Docker-Multi-Stage-Non-Root]]"
 - "[[GitHub-Actions-CI]]"
 - "[[17-Advanced-Architecture/Multi-Tenancy]]"
---

# Lesson 04: Migration Ordering, Rollback, and the Expand-Contract Pattern

*A `scripts/deploy_migrations.py` for `Boardly` that wraps `alembic upgrade head` in a `pg_advisory_lock`, plus the five-phase expand-contract pattern for renaming `users.name` to `users.full_name`, plus the rollback reasoning — code first, schema optionally — and why only the deploy job runs migrations, not every container.*

**You're at Lesson 4 of Section 16 — the last lesson.**

You built a non-root image, a local dev stack, and a CI pipeline that pushes the image to `ghcr.io` on `main`. Now we ship the deploy job: the one-shot container that runs `alembic upgrade head` against the production DB *before* the new code rolls, holding a Postgres advisory lock so two replicas cannot race. And we ship the *reasoning* that makes the migration safe: the schema must always be a superset of what the running code expects, throughout every deploy and every rollback, until the new code is the only code running. That reasoning is the expand-contract pattern. Take your time. Type every migration. Test the rollback. **This is how you learn.**


#deployment #alembic #migrations #devops

## Learning Objectives

By the end of this lesson you will be able to:

1. **Deploy a forward-compatible migration *before* the new code** and explain why that order is mandatory.
2. **Roll back code first, then optionally schema** and explain why rolling back the schema first is dangerous.
3. **Apply the expand-contract pattern** to a non-trivial schema change (add column -> write -> backfill -> read -> constrain -> drop old) across five phases, each individually compatible with the previous code.
4. **Run migrations exactly once per deploy**, from a deploy job, not from every container's lifespan startup — using `pg_advisory_lock` to prevent races.
5. **Use `pg_advisory_lock` on the same session** that runs the migration and explain why releasing it on a different connection fails.
6. **Use a batched backfill job** for tables of any size and explain why a single `UPDATE` on a 50M-row table is a production incident.
7. **Write a `downgrade()` for every expand migration** and explain why the contract migration's `downgrade` re-expands.
8. **Test the rollback in CI** — `alembic upgrade head && alembic downgrade -1 && alembic upgrade head` against a fresh DB.

## Prerequisites

Before starting, you need:

- **The Alembic deployment lesson** — [[09-Alembic-Migrations/Deploying-Migrations-in-Production]]. The canonical Alembic deployment story. This lesson builds on it with the multi-instance concerns and the advisory lock.
- **The data-migrations lesson** — [[09-Alembic-Migrations/Data-Migrations-Safely]]. Backfills, batched updates, idempotent data changes.
- **The session/transaction lesson** — [[07-SQLAlchemy/05-Session-and-Transaction-Management]]. The advisory lock must be held on the same session/connection that runs the migration.
- **The SQL transactions lesson** — [[06-SQL-Fundamentals/Transactions-Isolation-Locks]]. What locks a migration takes; how Postgres advisory locks differ from row locks.
- **The Dockerfile from Lesson 1** — the deploy job is a one-shot container built from the same image the app uses.

## The Problem

A migration is a schema change plus the code that uses the new schema. They are two artifacts, and they ship at different times. The order of those two shipments is the difference between a clean deploy and a 3 a.m. incident.

The rule that saves you is simple to state and easy to violate: **the database schema must be a superset of what the old code expects, throughout every deploy and every rollback, until the new code is the only code running.** The expand-contract pattern is how you enforce that rule. Multi-instance deploys add another constraint: only one job runs `alembic upgrade head` — not every replica, or you get racing migrations.

We need:

1. **A deploy script** that runs the migration with a `pg_advisory_lock` so two replicas cannot race. The script is run from a one-shot container, not from every container's lifespan.
2. **An ordering rule**: schema first, code next (for the expand half); code first, schema optionally next (for the contract half and for rollback).
3. **A pattern for non-trivial changes**: expand-contract, with five phases and rollback windows between them.
4. **A batched backfill job** for tables of any real size.
5. **A CI test for the rollback** that runs `upgrade -> downgrade -> upgrade` against a fresh DB.

## The Code

Here is the complete deploy script and the five-phase migration set for renaming `users.name` to `users.full_name`. Read it through once; we will go line by line afterwards.

### The deploy script

```python
# scripts/deploy_migrations.py
"""Run as a one-shot deploy job, NOT inside the app container.

Usage:
 uv run python scripts/deploy_migrations.py upgrade # alembic upgrade head
 uv run python scripts/deploy_migrations.py downgrade # alembic downgrade -1
"""
import asyncio
import sys

from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from boardly.config import settings

# "ADMI" — pick anything stable. The advisory lock is identified by a 64-bit
# integer; we use a 32-bit int that is the ASCII bytes of "ADMI" packed together.
ADVISORY_LOCK_ID = 0x41444D49


async def run(target: str) -> None:
 # Single-connection engine. We do NOT want to use the app's pool — the deploy
 # job is a one-shot, and a long migration should not hold pool slots.
 engine = create_async_engine(settings.database_url, pool_size=1, max_overflow=0)
 async with engine.connect() as conn:
 # Acquire a Postgres advisory lock so two deploy jobs cannot race.
 # The lock is session-scoped: it is held until the session ends OR
 # until pg_advisory_unlock is called on the SAME session.
 await conn.execute(text("SELECT pg_advisory_lock(:lid)"), {"lid": ADVISORY_LOCK_ID})
 try:
 # Run alembic using this connection. The Alembic `Config` is read
 # from alembic.ini in the repo root.
 alembic_cfg = Config("alembic.ini")
 # Bind the Alembic run to OUR connection so the advisory lock is
 # held on the same session that runs the migration.
 await conn.run_sync(
 lambda sync_conn: command.upgrade(alembic_cfg, "head")
 if target == "upgrade" else
 command.downgrade(alembic_cfg, "-1")
 )
 finally:
 # Release must be on the same session that acquired it.
 await conn.execute(text("SELECT pg_advisory_unlock(:lid)"), {"lid": ADVISORY_LOCK_ID})
 await conn.commit()
 await engine.dispose()


if __name__ == "__main__":
 target = sys.argv[1] if len(sys.argv) > 1 else "upgrade"
 asyncio.run(run(target))
```

### Phase 1: Expand (migration `0007_expand_full_name`)

```python
"""expand: add users.full_name; keep name; sync via trigger

Revision ID: 0007_expand_full_name
Revises: 0006_previous_migration
Create Date: 2026-10-19 10:00:00
"""
from alembic import op
import sqlalchemy as sa

revision = "0007_expand_full_name"
down_revision = "0006_previous_migration"
branch_labels = None
depends_on = None


def upgrade() -> None:
 # Add the new column as nullable. Old code ignores it.
 op.add_column(
 "users",
 sa.Column("full_name", sa.Text(), nullable=True),
 )
 # Backfill new column from old column for existing rows.
 op.execute("UPDATE users SET full_name = name WHERE full_name IS NULL")
 # Trigger keeps new column in sync with old column until the cutover.
 op.execute(
 """
 CREATE OR REPLACE FUNCTION users_sync_full_name() RETURNS TRIGGER AS $$
 BEGIN
 IF NEW.full_name IS NULL AND NEW.name IS NOT NULL THEN
 NEW.full_name := NEW.name;
 END IF;
 RETURN NEW;
 END;
 $$ LANGUAGE plpgsql;
 """
 )
 op.execute(
 """
 CREATE TRIGGER users_sync_full_name_t
 BEFORE INSERT OR UPDATE ON users
 FOR EACH ROW EXECUTE FUNCTION users_sync_full_name();
 """
 )


def downgrade() -> None:
 # Downgrade is "drop the trigger and the column". Safe because the old
 # code never read full_name.
 op.execute("DROP TRIGGER IF EXISTS users_sync_full_name_t ON users")
 op.execute("DROP FUNCTION IF EXISTS users_sync_full_name()")
 op.drop_column("users", "full_name")
```

### Phase 2: Code – write to `full_name` (still read from `name`)

```python
# boardly/models.py
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy import Text

class User(TimestampMixin, Base):
 __tablename__ = "users"
 id: Mapped[int] = mapped_column(primary_key=True)
 name: Mapped[str | None] = mapped_column(Text) # legacy read
 full_name: Mapped[str | None] = mapped_column(Text) # new write target


# boardly/schemas.py
class UserCreate(BaseModel):
 full_name: str


# boardly/api/users.py
@router.post("/users", response_model=UserRead, status_code=201)
async def create_user(
 payload: UserCreate,
 session: Annotated[AsyncSession, Depends(get_session)],
) -> UserRead:
 # Write to BOTH columns during the cutover window.
 user = User(name=payload.full_name, full_name=payload.full_name)
 session.add(user)
 await session.commit()
 await session.refresh(user)
 return UserRead.model_validate(user)
```

### Phase 3: Backfill remaining NULLs

```python
# scripts/backfill_full_name.py
"""Batched backfill for users.full_name.

Run as a separate job, NOT inside the migration — the migration transaction
would block every other transaction for the duration of the backfill.
"""
import asyncio

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from boardly.config import settings


async def backfill(batch_size: int = 1000) -> None:
 engine = create_async_engine(settings.database_url)
 async with engine.connect() as conn:
 while True:
 result = await conn.execute(
 text("""
 UPDATE users SET full_name = name
 WHERE id IN (
 SELECT id FROM users
 WHERE full_name IS NULL AND name IS NOT NULL
 LIMIT :n
 )
 """),
 {"n": batch_size},
 )
 await conn.commit()
 if result.rowcount == 0:
 break
 print(f"backfilled {result.rowcount} rows")
 await asyncio.sleep(0.5) # be polite to the DB
 await engine.dispose()


if __name__ == "__main__":
 asyncio.run(backfill())
```

### Phase 4: Code – read from `full_name`

```python
# boardly/api/users.py
@router.get("/users/{user_id}", response_model=UserRead)
async def get_user(
 user_id: int,
 session: Annotated[AsyncSession, Depends(get_session)],
) -> UserRead:
 user = await session.get(User, user_id)
 if user is None:
 raise HTTPException(404)
 # Serializer now reads full_name only.
 return UserRead.model_validate(user)


# boardly/schemas.py
class UserRead(BaseModel):
 id: int
 full_name: str # expose full_name, not name
```

### Phase 5: Contract (migration `0008_contract_drop_name`)

```python
"""contract: drop users.name; add NOT NULL to full_name

Revision ID: 0008_contract_drop_name
Revises: 0007_expand_full_name
Create Date: 2026-10-26 10:00:00
"""
from alembic import op
import sqlalchemy as sa

revision = "0008_contract_drop_name"
down_revision = "0007_expand_full_name"
branch_labels = None
depends_on = None


def upgrade() -> None:
 # Drop the trigger first — it references both columns and would block the drop.
 op.execute("DROP TRIGGER IF EXISTS users_sync_full_name_t ON users")
 op.execute("DROP FUNCTION IF EXISTS users_sync_full_name()")
 # Make full_name NOT NULL — every row has a value now (Phase 3 backfilled).
 op.alter_column("users", "full_name", nullable=False)
 # Finally, drop the old column. Nothing reads it anymore.
 op.drop_column("users", "name")


def downgrade() -> None:
 # Re-expand: re-add name (nullable), copy from full_name, re-create the trigger.
 # Then full_name goes back to nullable.
 op.add_column("users", sa.Column("name", sa.Text(), nullable=True))
 op.execute("UPDATE users SET name = full_name WHERE name IS NULL")
 op.execute(
 """
 CREATE OR REPLACE FUNCTION users_sync_full_name() RETURNS TRIGGER AS $$
 BEGIN
 IF NEW.full_name IS NULL AND NEW.name IS NOT NULL THEN
 NEW.full_name := NEW.name;
 END IF;
 RETURN NEW;
 END;
 $$ LANGUAGE plpgsql;
 """
 )
 op.execute(
 """
 CREATE TRIGGER users_sync_full_name_t
 BEFORE INSERT OR UPDATE ON users
 FOR EACH ROW EXECUTE FUNCTION users_sync_full_name();
 """
 )
 op.alter_column("users", "full_name", nullable=True)
```

## Line-by-Line Deep Dive

### `scripts/deploy_migrations.py`

#### Lines 14–17: The advisory lock ID

```python
ADVISORY_LOCK_ID = 0x41444D49
```

**What it does:** Defines the 32-bit integer that identifies the advisory lock. `0x41444D49` is the ASCII bytes of `"ADMI"` (A=0x41, D=0x44, M=0x4D, I=0x49) packed into a single int.

**Why this matters:**

- A Postgres advisory lock is identified by a 64-bit integer. You can either pass a single 64-bit int (`pg_advisory_lock(bigint)`) or two 32-bit ints (`pg_advisory_lock(int, int)` — typically a "class" and "object" id). We use the single-int form.
- The value `0x41444D49` is arbitrary — it just needs to be stable and unique to *this* deploy job. If you have a second deploy job (say, for a different schema), use a different ID.
- The ASCII trick makes the ID human-readable in `pg_locks` queries: `SELECT * FROM pg_locks WHERE locktype = 'advisory' AND objid = 1094929225;` — you can grep the source for `0x41444D49` and find it.

**Advisory locks vs. row locks vs. table locks.**

- **Row locks** (`SELECT ... FOR UPDATE`) are acquired on specific rows and released when the transaction commits. They are for concurrency control on specific data.
- **Table locks** (`LOCK TABLE ...`) are acquired on whole tables and released at the end of the transaction. They block other operations on the table; they are coarse and rarely the right tool.
- **Advisory locks** (`pg_advisory_lock(...)`) are application-level locks that live in Postgres's lock table but are not tied to any specific row or table. They are for application-level mutual exclusion — "only one deploy job at a time across the whole DB". This is exactly what we want for migrations.


#### Lines 19–29: The engine and the connection

```python
async def run(target: str) -> None:
 engine = create_async_engine(settings.database_url, pool_size=1, max_overflow=0)
 async with engine.connect() as conn:
 await conn.execute(text("SELECT pg_advisory_lock(:lid)"), {"lid": ADVISORY_LOCK_ID})
 try:
 alembic_cfg = Config("alembic.ini")
 await conn.run_sync(
 lambda sync_conn: command.upgrade(alembic_cfg, "head")
 if target == "upgrade" else
 command.downgrade(alembic_cfg, "-1")
 )
 finally:
 await conn.execute(text("SELECT pg_advisory_unlock(:lid)"), {"lid": ADVISORY_LOCK_ID})
 await conn.commit()
 await engine.dispose()
```

**What it does:**

1. Creates a single-connection engine (`pool_size=1, max_overflow=0`).
2. Opens a connection.
3. Acquires the advisory lock.
4. Runs the Alembic migration on *this* connection (via `conn.run_sync`).
5. Releases the advisory lock on the same connection.
6. Disposes the engine.

**Why each line matters:**

- `pool_size=1, max_overflow=0` — the deploy job does not need a pool. It is a one-shot; one connection is enough. Using the app's pool (e.g. `pool_size=10`) would be wasteful and could starve the app of connections during a long migration.
- `async with engine.connect() as conn` — gets a connection from the pool. The `async with` ensures the connection is returned to the pool (or closed) on exit.
- `await conn.execute(text("SELECT pg_advisory_lock(:lid)"), {"lid": ADVISORY_LOCK_ID})` — acquires the lock. `pg_advisory_lock` blocks until the lock is acquired (it does not return `false`; it waits). If two deploy jobs run simultaneously, one acquires the lock and proceeds; the other blocks until the first releases.
- `try/finally` — the lock MUST be released. If the migration raises, the `finally` block still runs, releasing the lock. Without this, a crashed migration leaves the lock held forever, blocking all future deploys.
- `conn.run_sync(lambda sync_conn: command.upgrade(...))` — Alembic's `command.upgrade` is synchronous (it does not use async SQLAlchemy). We need to run it on the *same* connection that holds the advisory lock. `conn.run_sync(fn)` calls `fn(sync_connection)` where `sync_connection` is a synchronous wrapper around the same underlying DBAPI connection. This is how we bridge async SQLAlchemy and sync Alembic.
- `await conn.execute(text("SELECT pg_advisory_unlock(:lid)"), {"lid": ADVISORY_LOCK_ID})` — releases the lock. The release MUST happen on the same session/connection that acquired it; otherwise Postgres raises `ERROR: no such lock`.
- `await conn.commit()` — commits the transaction. Advisory locks are session-scoped, not transaction-scoped — `pg_advisory_lock` survives `COMMIT`. But the underlying DBAPI connection needs to be in a clean state before it is returned to the pool, so we commit.
- `await engine.dispose()` — closes the engine and the connection pool. The deploy job is done; clean up.

**Danger — `pg_advisory_lock` is session-scoped, not transaction-scoped.**

If you acquire the lock, then `COMMIT`, the lock is *still held*. If you then open a *new* connection (because you disposed the engine in between) and try `pg_advisory_unlock`, you get `ERROR: no such lock` because the unlock is on a different session.

The rule: acquire the lock and release it on the *same* SQLAlchemy session/connection. The `async with engine.connect() as conn:` block is what scopes the session. Inside that block, both the `pg_advisory_lock` and the `pg_advisory_unlock` (and the Alembic `command.upgrade`) run on the same underlying connection.

If you see `ERROR: no such lock`, you have crossed session boundaries — probably by using a different engine for the unlock, or by disposing the engine in between.


**Warning — When this breaks: the next deploy hangs forever on `pg_advisory_lock`.**

The previous deploy job crashed (OOMKilled by the kubelet, node pressure, SIGKILL during a rolling restart) BEFORE the `finally` block reached `pg_advisory_unlock`. The advisory lock is session-scoped — but the session is gone. Postgres keeps the lock entry in `pg_locks` until the dead backend's connection is GC'd by the postmaster's reaper, which can take minutes if the connection's TCP state lingers. The next deploy's `await conn.execute(text("SELECT pg_advisory_lock(:lid)"))` blocks forever — there is no timeout on `pg_advisory_lock` (use `pg_try_advisory_lock` with a polling loop if you want one). Debugging path: from another session, `psql -c "SELECT pid, objid, granted FROM pg_locks WHERE locktype='advisory' AND objid = 1094929225;"` — `granted=t` for a `pid` whose `psql -c "SELECT state, query FROM pg_stat_activity WHERE pid=<pid>;"` returns no rows (the backend is gone). Fix: `SELECT pg_terminate_backend(<pid>);` force-releases the dead session's lock; the deploy proceeds. Long-term: add a `SELECT pg_try_advisory_lock(:lid)` early-exit path in the script (returns `false` immediately if the lock is held, instead of blocking) — a stuck lock then fails the deploy loudly in 1 s instead of hanging silently. Verify with `psql -c "SELECT pid, objid, granted, (SELECT state FROM pg_stat_activity WHERE pid = l.pid) AS state FROM pg_locks l WHERE locktype='advisory' AND objid = 1094929225;"` — `state` should be `NULL` only for a stuck lock. The [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]] + [[07-SQLAlchemy/05-Session-and-Transaction-Management]] forward refs cover the runbook and session-boundary story.


#### Lines 31–33: The `__main__` block

```python
if __name__ == "__main__":
 target = sys.argv[1] if len(sys.argv) > 1 else "upgrade"
 asyncio.run(run(target))
```

**What it does:** Reads the target from `sys.argv` (defaulting to `upgrade`) and runs the async function. `uv run python scripts/deploy_migrations.py upgrade` is the canonical invocation.

**Why this is run as a script, not inside the app:**

- The app's lifespan startup is *not* the right place to run migrations. Every container's lifespan startup would run migrations, and you would have races (two replicas both running `alembic upgrade head` on the same DB) and double-runs (the migration script executing on every container restart).
- The deploy job is a *one-shot* container: it starts, runs the migration, exits. The orchestrator runs it once per deploy, before the new code rolls.
- The one-shot is built from the same image as the app (so it has the same Alembic, the same `alembic.ini`, the same migrations directory). It just runs a different command (`python scripts/deploy_migrations.py upgrade` instead of `uvicorn boardly.main:app`).

**Spot the subtlety — why does the deploy script NOT run inside the app's lifespan?**

Answer: the lifespan runs on *every* container, and a deploy of N replicas would mean N instances of `alembic upgrade head` racing. The advisory lock would serialise them (only one wins, the others block), but you would still pay the cost of N containers each acquiring the lock, the winner running the migration, the others unblocking and immediately exiting — wasteful and slow. Worse, if a container restarts (e.g. an autoscaler event), it re-runs `alembic upgrade head` — usually a no-op because the schema is already at head, but the lock acquisition is wasted work. The right model: migrations are a *deploy job*, not a *container-startup side-effect*. The deploy job runs once per deploy, in a one-shot container, before the new code rolls.


### Phase 1 migration: `0007_expand_full_name`

#### Lines 14–16: Add the nullable column

```python
op.add_column(
 "users",
 sa.Column("full_name", sa.Text(), nullable=True),
)
```

**What it does:** Adds a `full_name TEXT` column to `users`, nullable.

**Why nullable:**

- Adding a `NOT NULL` column with no default to a table with existing rows fails — Postgres cannot put a value in the new column for existing rows. You would have to either (a) provide a default (`DEFAULT ''`) or (b) add nullable, then backfill, then `ALTER` to `NOT NULL`.
- Adding a `NOT NULL DEFAULT ''` on Postgres 11+ is fast (metadata-only — Postgres does not rewrite the table; it stores the default and uses it for reads of existing rows). But the old code does not know to write the new column, so the default is what it gets — which may be wrong (an empty string is a valid name? probably not).
- The safer pattern is: add nullable (so the default is `NULL`), backfill, then make `NOT NULL` in the contract phase. This is what we do.

#### Lines 18–19: Backfill from `name`

```python
op.execute("UPDATE users SET full_name = name WHERE full_name IS NULL")
```

**What it does:** For every row where `full_name IS NULL` (which is every row, since we just added the column), set `full_name = name`.

**Why this is OK in the migration for small tables but NOT for large ones:**

- For a small `users` table (a few thousand rows), this `UPDATE` is fast (under a second) and is fine inside the migration.
- For a large `users` table (millions of rows), this `UPDATE` would lock the table for the duration and block every other transaction. That is a production incident.
- The Phase 3 backfill job (a separate script) is the answer for large tables — it batches the `UPDATE` with `LIMIT` subqueries and sleeps between batches.
- For this lesson, we do both: the migration has a quick `UPDATE` (for the small initial case), and the Phase 3 job is what you would use for a real large table.

#### Lines 21–37: The trigger

```python
op.execute(
 """
 CREATE OR REPLACE FUNCTION users_sync_full_name() RETURNS TRIGGER AS $$
 BEGIN
 IF NEW.full_name IS NULL AND NEW.name IS NOT NULL THEN
 NEW.full_name := NEW.name;
 END IF;
 RETURN NEW;
 END;
 $$ LANGUAGE plpgsql;
 """
)
op.execute(
 """
 CREATE TRIGGER users_sync_full_name_t
 BEFORE INSERT OR UPDATE ON users
 FOR EACH ROW EXECUTE FUNCTION users_sync_full_name();
 """
)
```

**What it does:** Creates a Postgres trigger function `users_sync_full_name` and a trigger `users_sync_full_name_t` that fires `BEFORE INSERT OR UPDATE` on `users`. The trigger sets `NEW.full_name = NEW.name` if `NEW.full_name IS NULL` and `NEW.name IS NOT NULL`.

**Why a trigger:**

- During the cutover window (between Phase 1 and Phase 5), the old code writes to `name` (because it does not know about `full_name`). Without a trigger, those writes would leave `full_name` `NULL`, and a Phase 4 read of `full_name` would return `NULL` for those rows.
- The trigger keeps `full_name` in sync with `name` for any write that does not set `full_name`. So old-code writes to `name` automatically populate `full_name`.
- New-code writes (Phase 2) write to *both* columns explicitly. The trigger's `IF NEW.full_name IS NULL` guard means the trigger does not fire for new-code writes (because `NEW.full_name` is not `NULL`).

**Why `BEFORE INSERT OR UPDATE`:**

- `BEFORE` — the trigger can modify `NEW` before the row is written. We want to set `NEW.full_name` before the insert/update goes through.
- `INSERT OR UPDATE` — both. Old code can insert (a new user) or update (a renamed user); both need the sync.
- `FOR EACH ROW` — fires once per affected row, with `NEW` bound to the row being inserted/updated. (The alternative is `FOR EACH STATEMENT`, which fires once per statement and has no `NEW`.)

**Triggers are invisible to the application — invisible cuts both ways.**

A trigger is a piece of logic that lives in the database and runs on every write. The application does not see it. The advantage: the database is consistent regardless of which code version writes; even a replica running old code keeps the columns in sync. The disadvantage: a developer reading `boardly/api/users.py` does not know the trigger exists — the trigger is hidden in the DB. For the brief expand-contract window (a week, say), the trigger is the right tool. For long-term logic, prefer application-level dual-write — it is more transparent. We drop the trigger in Phase 5.


**Danger — How an attacker thinks: a `BEFORE INSERT OR UPDATE` trigger is a perfect backdoor.**

The trigger that keeps `full_name` in sync with `name` is invisible to the ORM — that is the lesson's selling point, and it is also the lesson's security hole. An attacker with `CREATE TRIGGER` privilege on `users` can install a SECOND trigger `users_leak_pii_t` that copies `NEW.email` into a `leaked_pii` table they can read later. Your application code never sees it; the ORM's `session.add(user)` is one row in `users`, but the trigger writes a second row into `leaked_pii`. The defence is least-privilege on the migrations role: (a) the deploy job connects as a role that owns the `users` table (and can therefore `CREATE TRIGGER`) — but the application's runtime role has only `SELECT/INSERT/UPDATE/DELETE` on `users` and does NOT own it, so it cannot create triggers; (b) the migrations role is NOT the role the application uses at runtime — verify with `psql -c "SELECT tgname, tgowner::regrole FROM pg_trigger WHERE tgrelid='users'::regclass;"` — every trigger's owner should be `boardly_migrations`, not `boardly_app`; and `psql -c "SELECT grantee, privilege_type FROM information_schema.table_privileges WHERE table_name='users' ORDER BY grantee, privilege_type;"` — `boardly_app` should have `INSERT/SELECT/UPDATE/DELETE` but NOT `TRIGGER`; (c) a `BEFORE DDL` event trigger (`CREATE EVENT TRIGGER ddl_guard ON ddl_command_end WHEN tag IN ('CREATE TRIGGER', 'CREATE FUNCTION') EXECUTE FUNCTION log_ddl();`) writes every DDL to a security-audit table that the on-call reviews daily. The [[08-PostgreSQL/Roles-Permissions-Security]] + [[11-Authentication-and-Security/Threat-Model-First]] forward refs cover the role-separation and threat-model story.


#### Lines 39–44: The `downgrade`

```python
def downgrade() -> None:
 op.execute("DROP TRIGGER IF EXISTS users_sync_full_name_t ON users")
 op.execute("DROP FUNCTION IF EXISTS users_sync_full_name()")
 op.drop_column("users", "full_name")
```

**What it does:** Drops the trigger, the function, and the column.

**Why this is safe:**

- The downgrade is "go back to before Phase 1". At that point, the old code (Phase 0) is running, and it does not read `full_name` — it reads `name`, which still exists.
- The downgrade is safe because the old code never used `full_name`.
- A downgrade of an *expand* migration is always safe — the schema change was purely additive (a new nullable column, a new trigger); removing them is purely subtractive. The old code did not depend on the addition.

### Phase 2: Code – write to both

```python
user = User(name=payload.full_name, full_name=payload.full_name)
```

**What it does:** On `POST /users`, the new code writes to *both* `name` and `full_name` with the same value.

**Why dual-write:**

- The new code is deployed, but the old code may still be running on some replicas (a rolling deploy). The old code reads `name`. So `name` must still be populated.
- The trigger would also keep `name` and `full_name` in sync, but dual-write is more transparent — the developer reading the code sees that both columns are being written.
- Belt and braces: trigger for old-code writes (which do not know about `full_name`), dual-write for new-code writes (which know about both).

**Why this is forward-compatible:**

- If the new code is rolled back to the old code (Phase 0), the old code reads `name`, which is still populated (because dual-write set it). No problem.
- If the schema is rolled back to Phase 0 (the `downgrade` drops `full_name`), the new code's dual-write would fail (it tries to set `full_name`, which does not exist). So you must roll back the *code* before rolling back the *schema*. This is the rollback order: code first, schema optionally.

### Phase 3: The batched backfill

```python
while True:
 result = await conn.execute(
 text("""
 UPDATE users SET full_name = name
 WHERE id IN (
 SELECT id FROM users
 WHERE full_name IS NULL AND name IS NOT NULL
 LIMIT :n
 )
 """),
 {"n": batch_size},
 )
 await conn.commit()
 if result.rowcount == 0:
 break
 print(f"backfilled {result.rowcount} rows")
 await asyncio.sleep(0.5)
```

**What it does:** Loops, batching `UPDATE`s of `batch_size` rows (default 1000) at a time, committing after each batch, sleeping 0.5 seconds between batches, until no rows are left to backfill.

**Why batched:**

- A single `UPDATE users SET full_name = name WHERE full_name IS NULL` on a 50M-row table locks the table for the duration — could be hours. Every other transaction on `users` is blocked. Production incident.
- Batching with `LIMIT` (via a subquery, because Postgres does not support `UPDATE ... LIMIT` directly) breaks the work into chunks. Each chunk takes a fraction of a second; the table lock is held only for that chunk. Between chunks, other transactions can proceed.
- `await asyncio.sleep(0.5)` — be polite to the DB. A backfill that hammers the DB at full speed starves real traffic. The 0.5-second sleep lets the DB catch up.
- `result.rowcount == 0` — the loop exits when a batch updates zero rows, which means there is nothing left to backfill.

**Tip — `UPDATE ... LIMIT` requires a subquery on Postgres.**

Postgres does not support `UPDATE ... LIMIT` directly. The pattern is `UPDATE ... WHERE id IN (SELECT id FROM ... LIMIT :n)`. The subquery picks the rows; the outer `UPDATE` modifies them. This is the canonical Postgres pattern for batched updates.


**Production reality: the batched backfill looks innocent on a 1 000-row dev DB and takes 11 hours on the 50M-row prod DB.**

The cost is not the `UPDATE` itself — it is the `SELECT id FROM users WHERE full_name IS NULL LIMIT 1000` subquery, which on the first iteration is a fast seqscan (no index, but only 1 000 rows to scan) and on iteration 50 000 is a full table scan because the planner cannot use the primary-key index to find NULLs in a column that was just added (no partial index on `full_name IS NULL`). Each batch goes from 10 ms to 30 s; the backfill time grows quadratically, not linearly. Defence in depth: (a) `CREATE INDEX CONCURRENTLY users_full_name_null_idx ON users (id) WHERE full_name IS NULL;` BEFORE the backfill starts — every batch's subquery is then a 5 ms index scan; (b) `EXPLAIN ANALYZE` the batch query on prod (with `SET enable_seqscan = off;` to force the planner to use the index) BEFORE letting the backfill run; (c) emit per-batch metrics (`print(f"batch i={i} rows={n} elapsed_ms={int(...)} total_rows_done={...} eta_min={...}")`) and ship them to the observability stack — the on-call should see the curve flatten (linear, not quadratic) within 10 batches; (d) cap the backfill with a `WHERE id < :high_water_mark` parameter, bumping the mark per batch, so the planner can always use the primary-key index for the NULL scan — the partial index is belt-and-braces. Verify with `psql -c "EXPLAIN (ANALYZE, BUFFERS) SELECT id FROM users WHERE full_name IS NULL LIMIT 1000;"` — the plan should show `Index Scan using users_full_name_null_idx`, not `Seq Scan on users`. The [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]] + [[08-PostgreSQL/Indexes-Composite-and-Specialized]] + [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]] + [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]] forward refs cover the query-plan and observability story.


### Phase 4: Code – read from `full_name`

```python
class UserRead(BaseModel):
 id: int
 full_name: str # expose full_name, not name
```

**What it does:** The serializer now exposes `full_name` instead of `name`. The `GET /users/{id}` endpoint reads `full_name` (via `UserRead.model_validate(user)`).

**Why this is forward-compatible:**

- The schema is still Phase 1 (or Phase 3, after the backfill). `full_name` is nullable and populated. The new code reads it.
- The old code (Phase 2) wrote to `full_name` (and `name`). The new code reads `full_name`. Both phases agree on `full_name` being the source of truth for reads.
- The trigger (Phase 1) kept `full_name` in sync with `name` for any old-code writes. So even rows written by old code (which did not know about `full_name`) have `full_name` populated.
- If the new code is rolled back to Phase 2, Phase 2 reads `name` (or `full_name`? — depends on Phase 2's serializer). If Phase 2's serializer reads `name`, the rollback is fine — `name` is still populated.

### Phase 5: Contract migration

#### Lines 19–22: Drop the trigger first

```python
op.execute("DROP TRIGGER IF EXISTS users_sync_full_name_t ON users")
op.execute("DROP FUNCTION IF EXISTS users_sync_full_name()")
```

**What it does:** Drops the trigger and the function.

**Why first:**

- The trigger references both `name` and `full_name`. If we tried to drop `name` while the trigger existed, Postgres would refuse (`cannot drop table users column name because other objects depend on it`).
- Drop the trigger first, then the function, then we can drop the column.

#### Lines 24–25: Make `full_name` NOT NULL

```python
op.alter_column("users", "full_name", nullable=False)
```

**What it does:** Alters `full_name` to `NOT NULL`.

**Why this is safe now and was not safe in Phase 1:**

- In Phase 1, `full_name` had `NULL` for every existing row. `ALTER ... NOT NULL` would have failed because of the NULLs.
- After the Phase 3 backfill, every row has a `full_name`. `ALTER ... NOT NULL` succeeds.
- This `ALTER` is metadata-only on Postgres 11+ — it does not rewrite the table; it just adds a `NOT NULL` constraint to the catalog. Fast.

#### Line 27: Drop the old column

```python
op.drop_column("users", "name")
```

**What it does:** Drops the `name` column.

**Why this is the last step:**

- Once `name` is gone, the old code (Phase 2) cannot read it. If the old code is still running, it would crash on `SELECT name FROM users`.
- So you must verify that the new code (Phase 4) is the *only* code running before you drop `name`. The Phase 4 deploy should be rolled out to 100% of replicas, observed for a week, and *then* Phase 5 runs.
- The contract migration's `upgrade` is the irreversibility point. Before this migration, you can roll back. After, you cannot (without re-expanding).

#### Lines 30–43: The contract `downgrade`

```python
def downgrade() -> None:
 op.add_column("users", sa.Column("name", sa.Text(), nullable=True))
 op.execute("UPDATE users SET name = full_name WHERE name IS NULL")
 # ... re-create trigger ...
 op.alter_column("users", "full_name", nullable=True)
```

**What it does:** Re-expands. Adds `name` back (nullable), copies `full_name` to `name`, re-creates the trigger, makes `full_name` nullable again.

**Why this is a re-expand:**

- The contract migration's `downgrade` is the *inverse* of its `upgrade`. The `upgrade` contracted (dropped `name`, made `full_name` NOT NULL); the `downgrade` expands back (re-adds `name` nullable, makes `full_name` nullable).
- This is safe *if* the code that is running is Phase 4 (which reads `full_name`). Phase 4 code does not read `name`, so re-adding `name` is fine. The trigger keeps `name` in sync with `full_name` for any new writes (though Phase 4 does not write `name` either).
- If you tried to downgrade from Phase 5 to Phase 0 (skipping Phase 4), Phase 0 code reads `name`, which the downgrade re-added. So that *might* work — but Phase 0 code also writes only `name`, not `full_name`, so `full_name` would go stale. The trigger fixes this for new writes. For old writes, the trigger sets `NEW.full_name = NEW.name`. OK.

## Execution Trace

A rename `name -> full_name` deploy over a week:

```mermaid
gantt
 title Expand-contract timeline for renaming users.name to users.full_name
 dateFormat YYYY-MM-DD HH:mm
 axisFormat %a %H:%M
 section Schema
 Add full_name + trigger :s1, 2026-10-19 10:00, 5m
 Backfill batched :s2, 2026-10-19 11:00, 2h
 Drop name, NOT NULL full_name :s3, 2026-10-26 10:00, 5m
 section Code
 Write both (Phase 2) :c1, 2026-10-20 10:00, 1d
 Read full_name only (P4) :c2, 2026-10-23 10:00, 1d
 Drop name in code (P5) :c3, 2026-10-26 12:00, 1d
 section Rollback window
 P2 -> P0 rollback OK :r1, 2026-10-20 10:00, 6d
 P4 -> P2 rollback OK :r2, 2026-10-23 10:00, 3d
 P5 -> P4 rollback OK :r3, 2026-10-26 12:00, 1d
```

At every moment in the chart:

- `name` exists from the start until the contract phase on Oct 26.
- `full_name` is nullable from Oct 19 until the contract phase.
- The trigger keeps them in sync from Oct 19 until the contract phase.
- Any code version (P0, P2, P4, P5) works against the schema state at any moment.

A rollback from P5 to P4 on Oct 27 simply means P4 code (which reads `full_name`) runs against a schema where `name` is already dropped — fine, because P4 never reads `name`.

**You have a deploy that is safe to roll back at any point.**

Every phase is individually compatible with the previous code. You can stop at any phase and the system still works. The contract phase is the irreversibility point — before it, you can roll back the schema; after it, you can only roll forward.


## Common Mistakes

### Mistake 1: Deploying new code that reads a column the migration has not added yet

**Symptom:** New code crashes on first request with `UndefinedColumn: column "full_name" does not exist`.

**Why:** You deployed the Phase 4 code (reads `full_name`) before the Phase 1 migration (adds `full_name`).

**Fix:** Order: schema first, code next. The migration that adds `full_name` runs *before* the code that reads it.

### Mistake 2: Adding a `NOT NULL` column with no default in a single migration

```python
# WRONG
op.add_column("users", sa.Column("full_name", sa.Text(), nullable=False))
```

**Symptom:** `ALTER TABLE` fails with `column "full_name" contains null values` because every existing row has `NULL` for the new column.

**Fix:** Add nullable, ship code, backfill, then `ALTER ... NOT NULL` in the contract phase.

### Mistake 3: Running `alembic upgrade head` in the FastAPI lifespan startup

```python
# WRONG
@asynccontextmanager
async def lifespan(app: FastAPI):
 command.upgrade(Config("alembic.ini"), "head")
 yield
```

**Symptom:** Every replica runs `alembic upgrade head` on startup. Two replicas starting simultaneously race: both try to acquire the `alembic_version` row lock, one wins and migrates, the other sees a newer version and exits. Worse, both might run the same migration script and corrupt data. Worse still, an in-progress migration's DDL might block another replica's queries.

**Fix:** Migrations are a deploy job, not a container-startup side-effect. The deploy script (this lesson) runs once per deploy, in a one-shot container, before the new code rolls. The advisory lock serialises concurrent deploy jobs.

### Mistake 4: Rolling back the schema before the code

**Symptom:** You roll back Phase 5 to Phase 0 (drop `full_name`) while Phase 4 code (reads `full_name`) is still running. Phase 4 code crashes with `UndefinedColumn`.

**Fix:** Rollback order: code first, schema optionally. Roll back the code to Phase 0 (which reads `name`, which still exists), then optionally roll back the schema to Phase 0.

**Danger — How an attacker thinks: a forced rollback is an availability attack.**

An insider with `ALTER TABLE` privilege (a junior DBA, a compromised service account, a CI deploy token with too-broad grants) can force the rollback path by filing a "critical" P1 against a deploy that landed clean, triggering a runbook that runs `uv run python scripts/deploy_migrations.py downgrade` while the new code is still at 100% rollout. The new code's `SELECT full_name FROM users` then returns `UndefinedColumn` on every request — the auth service 500s, the rate limiter (which depends on the auth service for tenant identity) bypasses, and a credential-stuffing burst goes through against the now-unprotected login endpoint. The rollback looks like a "fix" — the post-mortem blames the deploy, not the rollback. Defence in depth: (a) the deploy job's `downgrade` command requires a `--confirm-rollback` flag (not just `sys.argv[1]`) AND an out-of-band approval from a second on-call (a Slack button that writes a one-time token to a secrets store the deploy job reads); (b) the migrations role has `ALTER TABLE` but the runtime role has only `SELECT/INSERT/UPDATE` — the runtime cannot accidentally trigger a downgrade; (c) the rollback is gated on `alembic current` matching the expected revision — any mismatch fails the rollback loudly; (d) a `BEFORE DDL` event trigger logs every DDL to a security-audit table that the on-call reviews daily, so a forced downgrade cannot run silently; (e) the rollback is run from the SAME image tag as the deploy (`boardly:$(git rev-parse --short HEAD)`), so a CVE in the rollback script is gated by the same image-scan that gates the deploy. Verify with `psql -c "SELECT event, objid, event_time FROM ddl_audit_log ORDER BY event_time DESC LIMIT 10;"` — every DDL is logged with the role that ran it. The [[08-PostgreSQL/Roles-Permissions-Security]] + [[11-Authentication-and-Security/Threat-Model-First]] + [[12-Testing-and-Quality/CI-Pipelines]] forward refs cover the role-separation, threat-model, and CI-gate story.


### Mistake 5: A single `UPDATE` to backfill 50M rows

```python
# WRONG
op.execute("UPDATE users SET full_name = name WHERE full_name IS NULL")
```

**Symptom:** The migration transaction holds a lock on `users` for an hour. Every other transaction on `users` is blocked. Production incident.

**Fix:** Move the backfill to a separate batched job (Phase 3). Each batch is 1000 rows, with a 0.5-second sleep between batches. The migration only handles the small initial case (or no case at all if you trust the backfill job).

**Warning — When this breaks: 3 a.m. alert — "long-running transaction detected, 40 minutes, AccessExclusiveLock on `users`".**

The migration that "should take 5 minutes" has been running for 40 minutes. The on-call's first query: `psql -c "SELECT pid, state, wait_event_type, wait_event, now() - xact_start AS xact_age, left(query, 80) AS query FROM pg_stat_activity WHERE state != 'idle' ORDER BY xact_age DESC LIMIT 5;"` — the migration's pid has `state=active`, `xact_age=00:40:00`, and `query=UPDATE users SET full_name = name WHERE full_name IS NULL`. Every OTHER pid has `wait_event_type=Lock`, `wait_event=relation`, and is queued behind `users`. Recovery: `SELECT pg_terminate_backend(<migration_pid>);` — the migration rolls back (DDL is transactional in Postgres, so the `op.add_column` and the `op.execute("UPDATE ...")` both roll back together), the `AccessExclusiveLock` releases, the app unfreezes. Then move the backfill out of the migration and into the batched job (Phase 3). Post-mortem root cause: the migration was tested against a 1 000-row staging DB where the `UPDATE` finished in 50 ms; prod has 50 M rows. The CI test `alembic upgrade head && alembic downgrade -1 && alembic upgrade head` ran against a fresh empty DB, so the data path was never exercised at scale. Defence: add a CI job that seeds a 100 k-row table and asserts the migration finishes in `<= 30 s` — anything slower fails the build BEFORE the migration reaches prod. Verify with `psql -c "SELECT count(*) FROM pg_locks WHERE locktype='relation' AND relation='users'::regclass AND mode='AccessExclusiveLock';"` — should be `0` when no migration is running. The [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]] + [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]] + [[12-Testing-and-Quality/Testing-Database-Logic]] forward refs cover the slow-query and CI-seed story.


### Mistake 6: Forgetting a `downgrade()` for an expand migration

**Symptom:** When you need to roll back, you cannot. `alembic downgrade -1` fails with `no downgrade() defined`.

**Fix:** Every expand migration's `downgrade` should drop what it added — safe because the old code never used it.

### Mistake 7: Not testing the rollback in staging

**Symptom:** Rollback code that has never run fails when you need it. A `downgrade` references a column that was already dropped, or a trigger that was already removed.

**Fix:** CI should run `alembic upgrade head && alembic downgrade -1 && alembic upgrade head` against a fresh DB. This catches broken `downgrade`s before they ship.

### Mistake 8: Mixing DDL and heavy data work in one migration

**Symptom:** Alembic holds a transaction; a 10-minute backfill inside the migration blocks every other transaction.

**Fix:** Move the backfill to a separate batched job. The migration should be DDL-only (or DDL + a tiny data change).

## Engineering Trade-Offs

- **One migration per phase vs. one migration for the whole change.** One-per-phase gives you the rollback windows shown above. One-big-migration is simpler but blocks the system while it runs and is hard to roll back. Default to expand-contract; accept big-migration only for changes that are atomic by nature (a brand-new table).
- **Triggers vs. application dual-write.** Triggers keep the DB consistent even if a replica runs old code. Application dual-write is more transparent. Triggers are invisible in the app codebase — invisible cuts both ways. We use triggers for the brief expand window and remove them in the contract.
- **`pg_advisory_lock` vs. external coordination (etcd, Redis lock).** Advisory lock is in the same DB the migration touches, so it cannot be split-brained. External coordination can be wrong if the DB and the lock backend disagree. Use advisory locks unless the deploy spans multiple databases.
- **Backfill in Alembic vs. in a job.** Alembic backfill is one transaction, blocking. Job backfill is batched, polite. Use the job for anything over ~10k rows.
- **Add the new column nullable vs. with a default.** Adding a column `NOT NULL DEFAULT ''` on Postgres 11+ is fast (no full rewrite). But the old code does not know to write the new column, so the default is what it gets — which may be wrong. Prefer nullable so the default is explicit `NULL`, then backfill.
- **`pg_advisory_lock` (session-scoped) vs. `pg_try_advisory_lock` (non-blocking).** `pg_advisory_lock` blocks until acquired; `pg_try_advisory_lock` returns immediately with `true`/`false`. For a deploy job, blocking is fine (you want the migration to run, not skip). For an app-server-tier check (e.g. a startup that checks "is a migration in progress?"), `pg_try_advisory_lock` is better — do not block the request.

**Production reality: in multi-region active-active Postgres, the expand-contract pattern does not compose cleanly.**

Logical replication between `us-east-1` and `eu-west-1` propagates DDL with a lag (typically < 1 s, but spiking to 30 s during a write burst or a network partition). Phase 1 applied to `us-east-1` is not visible to `eu-west-1` until the lag catches up; if the new code in `eu-west-1` reads `full_name` BEFORE the replicated DDL lands, it gets `UndefinedColumn` and the region's auth service 500s. The lesson's "schema is always a superset" invariant holds WITHIN a region but not ACROSS regions during the replication window. Defence in depth: (a) deploy Phase 1 to ALL regions first, then wait `replication_lag + 60s` before rolling the Phase 2 code in any region — the deploy job takes a `--regions us-east-1,eu-west-1` flag and runs the migration in each region's primary in turn, asserting `SELECT now() - pg_last_xact_replay_timestamp() AS lag` is `< interval '2 seconds'` before proceeding to the next region; (b) the application has a circuit breaker on `UndefinedColumn` (catch `sqlalchemy.exc.ProgrammingError`, decrement the region's health score, trip the breaker after 5 errors) — if a region's code starts seeing it, the LB drains that region within seconds; (c) for changes that cannot be made forward-compatible across replication lag (a `NOT NULL` constraint that the replica applies before the backfill replicates), the contract phase requires a region-by-region cutover with a feature flag (`APP_READ_FULL_NAME=true` in `us-east-1` only, then `eu-west-1` after the lag window); (d) the rollback path across regions runs in REVERSE order — `eu-west-1` first, then `us-east-1` — so the region that received the DDL last rolls back first. Verify with `psql -h us-east-1 -c "SELECT now() - pg_last_xact_replay_timestamp() AS lag;"` and `psql -h eu-west-1 -c "..."` — both should be `< interval '2 seconds'` before the Phase 2 deploy. The [[17-Advanced-Architecture/Multi-Tenancy]] + [[08-PostgreSQL/Backups-and-Recovery]] + [[15-External-Integrations/Circuit-Breakers]] forward refs cover the multi-tenant, recovery, and circuit-breaker story.


## Exercises

- **Beginner:** Write a two-phase expand-contract migration that adds a `created_by` column to an `audit_log` table populated from a `users` join. Code change: write `created_by` in the new deploy. Verify the rollback.
- **Intermediate:** Convert a `status TEXT` column with five distinct values to a Postgres `enum` type across three migrations and two code deploys. Write the rollback for each migration. Test `upgrade -> downgrade -> upgrade` in CI.
- **Advanced:** Convert a 1:1 relationship (`users.profile_id` -> `profiles.user_id`) into a 1:N by deploying a multi-tenant app where many profiles belong to one user. Plan the expand-contract phases, the backfill, and the rollback. Use `pg_advisory_lock` in the deploy job. Document how the multi-tenant schema changes in [[17-Advanced-Architecture/Multi-Tenancy]] would interact with this rename (spoiler: every tenant's rows need to be backfilled, which multiplies the backfill time).

**Exercise 4 — Write the contract's `downgrade()` from scratch.** Take the Phase 5 contract migration (`0008_contract_drop_name`), copy its `upgrade()`, hide its `downgrade()`, and rewrite it. Verify: `uv run alembic upgrade head` (applies Phase 1 + Phase 5); `uv run alembic downgrade -1` (runs your new downgrade — assert it re-adds `name`, re-creates the trigger, makes `full_name` nullable); `uv run alembic upgrade head` (re-applies Phase 5 — assert `name` is dropped again, `full_name` is NOT NULL). The invariant is "the contract's `downgrade` re-expands" — verify with `psql -c "\d users"` after the downgrade that `name` is present and nullable, and `full_name` is nullable. The [[09-Alembic-Migrations/Data-Migrations-Safely]] forward ref covers the contract-vs-expand discipline.

**Exercise 5 — Advisory lock concurrency test.** Run two deploy jobs in parallel and assert only one wins the lock. Verify: from two terminals, run `uv run python scripts/deploy_migrations.py upgrade &` and `uv run python scripts/deploy_migrations.py upgrade &` (or use `bash -c "uv run python scripts/deploy_migrations.py upgrade & uv run python scripts/deploy_migrations.py upgrade & wait"`). While both are running, `psql -c "SELECT pid, objid, granted FROM pg_locks WHERE locktype='advisory' AND objid = 1094929225;"` — assert exactly ONE row with `granted=t` (the winner) and the second session is blocked (its `pg_stat_activity.state` is `active` with `wait_event='advisory'`). `kill -9` the winner; assert the second acquires the lock (`granted=t` now appears for the second session's pid) and the deploy completes. Document the lock-state transitions in a runbook. The [[06-SQL-Fundamentals/Transactions-Isolation-Locks]] forward ref covers the Postgres lock machinery.

**Exercise 6 — Backfill cost measurement.** Seed 100 k rows, time the batched backfill, and compare against a single-`UPDATE` on a 10 k-row table. Verify: `psql -c "INSERT INTO users (name) SELECT 'user_' || g FROM generate_series(1, 100000) AS g;"` (Phase 0 schema, before Phase 1); apply Phase 1 (`uv run alembic upgrade head`); `time uv run python scripts/backfill_full_name.py` — assert it finishes in seconds; `psql -c "SELECT count(*) FROM users WHERE full_name IS NULL;"` should be `0`. Then on a second DB with 10 k rows, run the single-`UPDATE` variant (`psql -c "UPDATE users SET full_name = name WHERE full_name IS NULL;"`) inside a transaction, and from another session `psql -c "SELECT count(*) FROM pg_locks WHERE locktype='relation' AND relation='users'::regclass AND mode='AccessExclusiveLock';"` — assert `1` (the table is locked). Document the wall-clock delta and the lock-duration delta. The [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]] forward ref covers the `EXPLAIN ANALYZE` you should run on both queries.

**Exercise 7 — Trigger audit.** After Phase 1, assert the trigger fires on INSERT and is idempotent on UPDATE. Verify: `psql -c "INSERT INTO users (name) VALUES ('Trigger Test') RETURNING name, full_name;"` — assert `full_name` is `'Trigger Test'` (the trigger populated it from `name`); `psql -c "UPDATE users SET name='Updated' WHERE name='Trigger Test' RETURNING name, full_name;"` — assert `full_name` is `'Updated'` (the trigger re-synced); `psql -c "UPDATE users SET full_name='Explicit' WHERE name='Updated' RETURNING name, full_name;"` — assert `full_name` is `'Explicit'` AND `name` is still `'Updated'` (the trigger's `IF NEW.full_name IS NULL` guard skipped the sync because `NEW.full_name` was set). Then after Phase 5 (`uv run alembic upgrade head` to apply the contract), assert `psql -c "INSERT INTO users (name) VALUES ('Should Fail');"` returns `ERROR: column "name" does not exist`. The [[09-Alembic-Migrations/Data-Migrations-Safely]] forward ref covers the trigger's lifecycle.

**Exercise 8 — Rollback-order test.** Demonstrate that rolling back the schema before the code fails, and that rolling back the code before the schema succeeds. Verify: apply Phase 1 (`uv run alembic upgrade 0007_expand_full_name`); run Phase 4 code path (`uv run pytest tests/api/test_users.py::test_get_user_reads_full_name -v` — passes); NOW roll back the schema first (the wrong order): `uv run alembic downgrade -1` (drops `full_name`); run the Phase 4 test again — assert it FAILS with `UndefinedColumn: column "full_name" does not exist`. Roll forward: `uv run alembic upgrade head`. NOW roll back the code first: `git checkout HEAD~1 -- boardly/api/users.py boardly/schemas.py` (Phase 2 code that reads `name`); run `uv run pytest tests/api/test_users.py::test_get_user_reads_name -v` — passes; `uv run alembic downgrade -1` — succeeds; `git checkout HEAD -- boardly/api/users.py boardly/schemas.py`. Document the order in a runbook titled "Rollback procedure: code first, schema optionally". The [[09-Alembic-Migrations/Deploying-Migrations-in-Production]] forward ref covers the rollback discipline.

**Exercise 9 — Multi-region deploy ordering.** With two Postgres services in Docker Compose (or two regional RDS instances), run the migration in each region in sequence and verify that the advisory lock does NOT cross regions. Verify: `docker compose up -d postgres-us postgres-eu`; `APP_DATABASE_URL=postgresql+asyncpg://boardly:pwd@localhost:5432/boardly uv run python scripts/deploy_migrations.py upgrade`; from another session `psql -h localhost -p 5432 -c "SELECT pid, objid, granted FROM pg_locks WHERE locktype='advisory' AND objid = 1094929225;"` — `granted=t` (US holds the lock); `psql -h localhost -p 5433 -c "SELECT pid, objid, granted FROM pg_locks WHERE locktype='advisory' AND objid = 1094929225;"` — zero rows (EU does NOT see US's lock — advisory locks are per-DB). Document why a multi-region deploy needs an EXTERNAL coordinator (etcd, a leader-elected deploy pod, a deploy DAG in Argo) when the schema must be in lockstep across regions: the advisory lock prevents races WITHIN a region but not BETWEEN regions, so two regions running `alembic upgrade head` simultaneously could each apply the migration without seeing the other's lock — usually fine (idempotent DDL) but catastrophic for data migrations (the backfill runs twice). The [[17-Advanced-Architecture/Multi-Tenancy]] + [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]] forward refs cover the multi-tenant and the one-shot-container pattern.

## Verification

```bash
# Apply migrations in staging
uv run python scripts/deploy_migrations.py upgrade

# Verify schema is the superset expected by the new code
uv run alembic current
uv run alembic check # exits 0 if no new migrations needed, non-zero otherwise

# Test the rollback on a fresh DB in CI:
createdb boardly_rollback_test
APP_DATABASE_URL=postgresql+asyncpg:///boardly_rollback_test uv run alembic upgrade head
APP_DATABASE_URL=postgresql+asyncpg:///boardly_rollback_test uv run alembic downgrade -1
APP_DATABASE_URL=postgresql+asyncpg:///boardly_rollback_test uv run alembic upgrade head

# Verify advisory lock is held during a deploy (run in another session while the deploy is running):
psql -c "SELECT granted, objid FROM pg_locks WHERE locktype='advisory';"
# Expect: granted = t, objid = 1094929225 (= 0x41444D49)

# Verify the trigger exists after Phase 1:
psql -c "\d+ users" | grep users_sync_full_name_t

# Verify the trigger is gone after Phase 5:
psql -c "\d+ users" | grep users_sync_full_name_t
# Expect: no output (trigger dropped)

# Verify `name` is gone after Phase 5:
psql -c "\d users" | grep name
# Expect: no output (column dropped)
```

## Previously Learned Here

- **Alembic workflow** — first taught in [[09-Alembic-Migrations/Alembic-Setup-and-Workflow]]. The new detail is the deploy job that wraps `command.upgrade` in an advisory lock.
- **Data migrations safely** — first taught in [[09-Alembic-Migrations/Data-Migrations-Safely]]. The new detail is moving the backfill out of the migration and into a batched job when the table is large.
- **Sessions/transactions** — first taught in [[07-SQLAlchemy/05-Session-and-Transaction-Management]]. The new detail is that the advisory lock must be held on the same session/connection that runs the migration, or `pg_advisory_unlock` fails.
- **Connection pool** — first taught in [[07-SQLAlchemy/02-Engines-Connections-Pools]]. The new detail is the deploy job uses a single-connection engine (`pool_size=1`), not the app's pool, so it cannot hold pool slots during a long migration.
- **Container hygiene** — first taught in [[Docker-Multi-Stage-Non-Root]]. The new detail is the deploy job is a one-shot container built from the same image as the app, running a different command.

## What's Next

The deploy pipeline is complete: image built (Lesson 1), local dev stack validated (Lesson 2), CI pushes the image to `ghcr.io` (Lesson 3), and the deploy job runs migrations safely (Lesson 4).

Section 17 — [[17-Advanced-Architecture/00-Advanced-Architecture-MOC]] — picks up from here with three architectural patterns that become load-bearing once you have paying customers:

- **[[17-Advanced-Architecture/Multi-Tenancy]]** — adding a `tenant_id` column to every table is itself an expand-contract change. The multi-tenant repository pattern builds on the repository pattern from Section 05 and the session-per-request from Section 07.
- **[[17-Advanced-Architecture/Idempotency-and-Retries]]** — server-side idempotency, building on the HTTP-side view from [[02-Web-and-HTTP/Idempotency-Safe-Retries-Pagination]].
- **[[17-Advanced-Architecture/Event-Driven-Basics]]** — pub/sub, delivery semantics, DLQs, and the transactional outbox.

## Sources

- Alembic — Operations reference — <https://alembic.sqlalchemy.org/en/latest/ops.html>.
- Alembic — `command.upgrade` / `command.downgrade` API — <https://alembic.sqlalchemy.org/en/latest/api.html>.
- PostgreSQL — `pg_advisory_lock` — <https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCK>.
- PostgreSQL — `ALTER TABLE` and concurrency — <https://www.postgresql.org/docs/current/sql-altertable.html> — which `ALTER`s require full rewrites and which are metadata-only.
- PostgreSQL — Triggers — <https://www.postgresql.org/docs/current/trigger-definition.html>.
- Martin Fowler — Evolutionary Database Design — <https://martinfowler.com/articles/evodb.html>.
- GitHub — "Online migrations" pattern — <https://github.com/ankane/online_migrations> (Ruby, but the patterns are universal).
- See [[21-Reference-Library/Source-Register]] for the full source list with dates accessed.

## What We Learned

- The schema must always be a superset of what the running code expects, throughout every deploy and every rollback, until the new code is the only code running.
- Expand-contract: add nullable column (expand) -> ship code that writes both -> backfill -> ship code that reads new -> make NOT NULL and drop old (contract).
- The deploy job runs `alembic upgrade head` inside a `pg_advisory_lock`, in a one-shot container, before the new code rolls.
- `pg_advisory_lock` is session-scoped — acquire and release on the same connection, or `pg_advisory_unlock` fails with `no such lock`.
- The deploy job uses a single-connection engine (`pool_size=1`), not the app's pool.
- The backfill for a large table is a separate batched job, not a single `UPDATE` inside the migration.
- Triggers keep the new column in sync with the old for old-code writes during the cutover window.
- Every expand migration has a `downgrade` that drops what it added — safe because the old code never used it.
- The contract migration's `downgrade` re-expands (re-adds the old column, re-creates the trigger).
- CI runs `alembic upgrade head && alembic downgrade -1 && alembic upgrade head` against a fresh DB to catch broken `downgrade`s.

---

**Tags:** #deployment #alembic #migrations #devops #review
**Previous:** [[16-Deployment-and-DevOps/GitHub-Actions-CI]]
**Next:** [[16-Deployment-and-DevOps/Deployment-Targets-When-To-Use-What]] →

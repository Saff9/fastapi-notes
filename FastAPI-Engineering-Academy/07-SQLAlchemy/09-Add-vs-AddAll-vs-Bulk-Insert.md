---
title: "Lesson 09: session.add() vs add_all() vs session.execute(insert()) – When to Use What"
aliases:
 - Add vs AddAll vs Bulk Insert
 - SQLAlchemy insert comparison
 - session.add vs add_all
 - bulk insert SQLAlchemy
 - bulk_insert_mappings
tags:
 - sqlalchemy
 - insert
 - bulk
 - comparison
 - lesson
course_level: intermediate
status: complete
difficulty: intermediate
estimated_time: "90–120 minutes"
prerequisites:
 - "[[03-Declarative-Base-and-Mapped]]"
 - "[[05-Session-and-Transaction-Management]]"
 - "[[06-Querying-with-select]]"
related_lessons:
 - "[[04-Relationships-and-Loading-Strategies]]"
 - "[[07-Async-SQLAlchemy]]"
 - "[[08-Advanced-ORM]]"
 - "[[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]]"
---

# Lesson 09: session.add() vs add_all() vs session.execute(insert()) – When to Use What

*Three ways to insert the same thousand rows. One ORM-tracked, one Core-level, one legacy bulk. Each has a different cost shape; each wins in a different situation. `Boardly` grows a `seed_tasks()` helper here that benchmarks all three.*

**You've reached the comparison lesson.**

Every SQLAlchemy tutorial shows you `session.add(obj)` and `session.commit()`. That gets you through the first thousand rows of your dev database. Then production lands: you need to seed 50 000 reference rows, or backfill a column for 100 000 existing rows, or import a CSV of 5 000 geographies. `session.add()` suddenly takes a minute. The instinct is to blame SQLAlchemy. The correct instinct is to reach for a different API — one you have not been shown yet. Today we compare the four insert APIs SQLAlchemy 2.1.x offers, on the same 1 000-row workload, with timings. By the end you will know which one to reach for, and why.


#sqlalchemy #insert #bulk #comparison

## Learning Objectives

By the end of this lesson you will be able to:

1. **Distinguish four insert APIs** in SQLAlchemy 2.1.x: `session.add(obj)`, `session.add_all([objs])`, `session.execute(insert(Model).values([...]))`, and `session.bulk_insert_mappings(Model, [...])`.
2. **Explain the unit-of-work path** that `session.add()` and `session.add_all()` traverse — pending objects, identity map, flush, ORM cascades — and why that path is the right one for small writes.
3. **Explain the Core-level bulk path** that `session.execute(insert(Model).values([...]))` takes — direct INSERT bypassing the unit-of-work, no identity map, no cascades — and why it is 10–100x faster for thousands of rows.
4. **Choose between the four APIs** on the axes of: row count, ORM cascade needs, identity-map needs, return-value needs, and observability.
5. **Benchmark** the three primary APIs against a 1 000-row workload and articulate where the time goes.
6. **Identify when `bulk_insert_mappings` (the legacy API) is the right call** despite its caveats — and when to avoid it.
7. **Restore ORM consistency after a bulk insert** by calling `session.expire_all()` or closing the session, so subsequent queries see the new rows.
8. **Trade off correctness vs speed**: articulate why bulk insert trades ORM behaviour for throughput, and which ORM features you lose (cascades, defaults, events, version_id) when you use it.

## Prerequisites

- **Lesson 03 — Declarative Base and Mapped.** The `Task` model we mutate is a `DeclarativeBase` subclass with `Mapped[T]` attributes.
- **Lesson 05 — Session and Transaction Management.** `session.add()`, `session.flush()`, `session.commit()`, the identity map, and `expire_on_commit` are the load-bearing concepts.
- **Lesson 06 — Querying with `select()`.** `session.execute(select(...))` and `session.execute(insert(...))` share the same execution entry point.
- **SQL literacy** — [[06-SQL-Fundamentals/Relational-Model-and-Constraints]]. You should be able to read a `INSERT INTO ... VALUES (...), (...), (...)` multi-row SQL statement.
- **About 90 minutes of focused time.** This lesson's central payload is the timing comparison; you should run the code, not just read it.

**The four APIs at a glance.**

- **`session.add(obj)`** — stage one ORM instance for INSERT at flush time. Identity map + cascades + events. Slow at scale.
- **`session.add_all([obj1, obj2, ...])`** — same path, multiple objects. Same cost shape as N `add()` calls; not a "bulk" API despite the name.
- **`session.execute(insert(Model).values([...]))`** — Core-level bulk INSERT, multi-row VALUES clause, bypasses the unit-of-work entirely. 10–100x faster for thousands of rows.
- **`session.bulk_insert_mappings(Model, [...])`** — legacy bulk API, even faster, even less ORM behaviour. Returns nothing. Use it for known-safe reference-data loads.


## The Problem

Your `Boardly` API needs to:

- Create one task from a `POST /projects/{slug}/tasks` request body. (Expected: 1 row per request. Slow path is fine; correctness and cascade behaviour matter.)
- Send a notification email when a task is created — via an ORM `after_insert` event. (Requires the ORM path; Core-level insert does not fire ORM events.)
- Seed 1 000 default task templates when a new organization is provisioned. (Expected: 1 000 rows in one transaction. The ORM path takes seconds; the bulk path takes tens of milliseconds.)
- Backfill a `default_assignee_id` column on 100 000 existing tasks during a migration. (Expected: 100 000 rows. The ORM path is infeasible; the bulk path is mandatory.)
- Import 5 000 geography reference rows from a CSV at startup. (Expected: 5 000 rows. The bulk path is right; ORM events are not needed.)

These five scenarios are the entire surface area of "insert in SQLAlchemy." Each one has a different best tool. The mistake most engineers make is reaching for `session.add()` for all five, then complaining about SQLAlchemy's performance. This lesson exists to fix that.

## The Code

Here is `boardly/inserts.py` — a single file that benchmarks the four APIs against a 1 000-row workload. The `Task` rows are real `Boardly` tasks: each has a `project_id`, a `slug`, a `title`, a `status`, and a `position` integer.

```python
# boardly/inserts.py
"""Boardly — insert comparison.

Lesson 09: session.add() vs add_all() vs session.execute(insert()) vs
bulk_insert_mappings. Same 1 000 tasks, four ways, with timings.
"""
from __future__ import annotations

import time
import uuid
from typing import Any

from sqlalchemy import insert, select
from sqlalchemy.orm import Session

from boardly.db import session_scope
from boardly.models import Project, Task


# ---------------------------------------------------------------------------
# Variant A — session.add(obj), one per row
# ---------------------------------------------------------------------------
def insert_via_add(session: Session, project_id: uuid.UUID, n: int) -> int:
    """Insert N tasks via session.add(), one INSERT per row at flush time."""
    for i in range(n):
        session.add(
            Task(
                project_id=project_id,
                slug=f"task-{i:04d}",
                title=f"Task {i}",
                status="todo",
                position=i,
            )
        )
    session.commit()
    return n


# ---------------------------------------------------------------------------
# Variant B — session.add_all([obj1, obj2, ...]), one call but same path
# ---------------------------------------------------------------------------
def insert_via_add_all(session: Session, project_id: uuid.UUID, n: int) -> int:
    """Insert N tasks via session.add_all(). Same unit-of-work path as add()."""
    session.add_all(
        [
            Task(
                project_id=project_id,
                slug=f"task-{i:04d}",
                title=f"Task {i}",
                status="todo",
                position=i,
            )
            for i in range(n)
        ]
    )
    session.commit()
    return n


# ---------------------------------------------------------------------------
# Variant C — session.execute(insert(Model).values([...]))
# Core-level bulk INSERT, multi-row VALUES clause, bypasses the unit-of-work.
# ---------------------------------------------------------------------------
def insert_via_core_bulk(session: Session, project_id: uuid.UUID, n: int) -> int:
    """Insert N tasks via session.execute(insert(Task).values([...]))."""
    rows = [
        {
            "project_id": project_id,
            "slug": f"task-{i:04d}",
            "title": f"Task {i}",
            "status": "todo",
            "position": i,
        }
        for i in range(n)
    ]
    session.execute(insert(Task).values(rows))
    session.commit()
    return n


# ---------------------------------------------------------------------------
# Variant D — session.bulk_insert_mappings(Model, [...])
# Legacy bulk API. Even faster. Even less ORM behaviour. No RETURNING.
# ---------------------------------------------------------------------------
def insert_via_bulk_mappings(session: Session, project_id: uuid.UUID, n: int) -> int:
    """Insert N tasks via session.bulk_insert_mappings()."""
    mappings = [
        {
            "project_id": project_id,
            "slug": f"task-{i:04d}",
            "title": f"Task {i}",
            "status": "todo",
            "position": i,
        }
        for i in range(n)
    ]
    session.bulk_insert_mappings(Task, mappings)
    session.commit()
    return n


# ---------------------------------------------------------------------------
# The benchmark harness
# ---------------------------------------------------------------------------
def benchmark(n: int = 1_000) -> dict[str, float]:
    """Run all four variants and report wall-time seconds."""
    timings: dict[str, float] = {}

    for name, fn in [
        ("session.add", insert_via_add),
        ("session.add_all", insert_via_add_all),
        ("session.execute(insert())", insert_via_core_bulk),
        ("session.bulk_insert_mappings", insert_via_bulk_mappings),
    ]:
        with session_scope() as session:
            project = Project(name=f"Bench-{name}", slug=f"bench-{name.lower()}")
            session.add(project)
            session.flush()  # get project_id without committing

            start = time.perf_counter()
            count = fn(session, project.id, n)
            elapsed = time.perf_counter() - start
            timings[name] = elapsed
            print(f"  {name}: inserted {count} rows in {elapsed:.3f}s")

    return timings


if __name__ == "__main__":
    print(f"Benchmarking 1 000-row inserts, four APIs, SQLAlchemy 2.1.x:")
    results = benchmark(n=1_000)
    fastest = min(results.values())
    print("\nRelative to fastest:")
    for name, t in results.items():
        print(f"  {name}: {t / fastest:.1f}x")
```

Run it:

```bash
BOARDLY_DATABASE_URL=sqlite:///:memory: uv run python -m boardly.inserts
```

Expected output (numbers will vary by machine; ratios are the point):

```
Benchmarking 1 000-row inserts, four APIs, SQLAlchemy 2.1.x:
  session.add: inserted 1000 rows in 0.312s
  session.add_all: inserted 1000 rows in 0.295s
  session.execute(insert()): inserted 1000 rows in 0.018s
  session.bulk_insert_mappings: inserted 1000 rows in 0.011s

Relative to fastest:
  session.add: 28.4x
  session.add_all: 26.8x
  session.execute(insert()): 1.6x
  session.bulk_insert_mappings: 1.0x
```

The two ORM-path APIs are ~27x slower than the two Core-path APIs on this workload. The fastest is `bulk_insert_mappings`. The gap widens further at N=10 000 and N=100 000 — the ORM path's cost is roughly linear in N, but the Core path's cost grows much more slowly because it issues a single SQL statement rather than N (or one batched multi-row) followed by N identity-map bookkeeping operations.

## Line-by-Line Deep Dive

### Variant A: `session.add(obj)`

```python
def insert_via_add(session: Session, project_id: uuid.UUID, n: int) -> int:
    for i in range(n):
        session.add(
            Task(
                project_id=project_id,
                slug=f"task-{i:04d}",
                title=f"Task {i}",
                status="todo",
                position=i,
            )
        )
    session.commit()
    return n
```

**What it does:** Constructs `n` `Task` instances, stages each one for INSERT via `session.add()`, and commits once at the end. The commit triggers a flush; the flush issues `INSERT INTO tasks (...) VALUES (...)` once per pending object.

**Why this is the slowest at scale:** Every iteration does three things:

1. **Constructs a `Task` instance.** That is a Python object with `__init__`, validators (if your model has them), and `Mapped[T]` attribute setter logic. Cost per row: ~microseconds.
2. **Calls `session.add(obj)`.** That moves the instance into `session.new` (the pending-objects set) and registers it with the identity map keyed by `(Task, primary_key)`. The PK is `None` until flush assigns it, so the map key is a placeholder; the session tracks pending objects separately.
3. **At flush time (called by `commit()`), the unit-of-work** iterates `session.new`, emits one `INSERT` per object, retrieves the assigned primary key (via `RETURNING` on Postgres, via `lastrowid` on SQLite, via `CURRVAL` on Oracle), updates the identity map with the real key, and fires any `after_insert` ORM events.

For N=1 000, that is 1 000 `INSERT` statements, 1 000 identity-map updates, 1 000 Python object constructions. The bottleneck is not the SQL — it is the per-row Python bookkeeping. SQLAlchemy's unit-of-work is doing real work; it is just slow work when N is large.

**Multi-row VALUES is not what `session.add()` does.**

A common misconception is that `session.add()` on N objects issues a single multi-row `INSERT INTO tasks (...) VALUES (...), (...), (...)`. It does not. The unit-of-work emits one `INSERT` per pending object, even when all N objects are pending at the same commit. The reason: each `INSERT` is followed by a `RETURNING id` (or equivalent) that the unit-of-work needs to assign back to the in-memory object's primary-key attribute, and that back-and-forth is per-row. Batching the INSERT would require batching the RETURNING — which Postgres supports, but the SQLAlchemy 2.1 unit-of-work does not (yet) use by default for `session.add()`.


**When `session.add()` wins:**

- **You need ORM cascades.** If `Task` has `cascade="save-update, merge"` on its `project` relationship (the default), `session.add(task)` will cascade the insert to `task.project` if `task.project` is also pending. The Core-level APIs do not cascade.
- **You need ORM events.** An `@event.listens_for(Task, "after_insert")` hook fires only on the ORM path. The Core-level `insert()` does not fire ORM events.
- **You need the returned instance.** After `session.commit()`, the `Task` instance has its `id` populated and is in the identity map. The Core-level APIs return a `CursorResult` with `rowcount` but no instances.
- **N is small.** For N < 100, the cost difference is milliseconds; the ORM behaviour is worth it.

**Warning — The Variant A request-timeout symptom is "the request timed out but the SQL log shows the INSERTs succeeded".**

When `session.add()` runs on N=10 000 in the request-response cycle, the team's first ticket reads "the request timed out at 30s, the data was lost". The SQL log shows 10 000 `INSERT INTO tasks (...) VALUES (...)` statements, each <2ms — the database work finished at second 2; the remaining 28s were Python-side unit-of-work bookkeeping (identity-map updates, `after_insert` event firing, primary-key retrieval). The debugging trap is to add another DB round-trip optimization; the real fix is to switch to Variant C (`session.execute(insert(Task).values(rows))`) and move the workload to a background task if the request cycle still times out. The APM trace signature is a "post-DB CPU span" that dominates the request — the SQL spans are fast, the post-DB Python span is the slow one. See [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]] for the trace-reading playbook.


### Variant B: `session.add_all([obj1, obj2, ...])`

```python
def insert_via_add_all(session: Session, project_id: uuid.UUID, n: int) -> int:
    session.add_all(
        [
            Task(
                project_id=project_id,
                slug=f"task-{i:04d}",
                title=f"Task {i}",
                status="todo",
                position=i,
            )
            for i in range(n)
        ]
    )
    session.commit()
    return n
```

**What it does:** Constructs the same N `Task` instances, hands the list to `session.add_all()`, and commits. Internally, `add_all()` is `for obj in objects: self.add(obj)` — there is no batching, no special fast path, no separate code path. It is syntactic sugar.

**Why the timings are nearly identical to Variant A:** Because Variant A and Variant B do the same work. `add_all()` is a one-call way to do N `add()`s; the unit-of-work still iterates N pending objects, emits N `INSERT`s, retrieves N primary keys, fires N `after_insert` events. The ~5% difference in the benchmark above is noise, not a real performance gap.

**Warning — `add_all()` is not a bulk API.**

The name suggests "add all these in one batched INSERT." It does not. It is a convenience method that calls `add()` N times. Many engineers reach for `add_all()` expecting a speedup and discover, after benchmarking, that it is just as slow as the loop. The speedup requires changing the API, not just the spelling.


**When `add_all()` wins:**

- **Code readability.** If you have a list of objects already constructed, `session.add_all(thelist)` is one line; the loop is three. The performance is identical; the readability is not.
- **Atomicity of staging.** If any of the objects would raise during `add()` (e.g., a duplicate key in a unique constraint that the session detects early), `add_all()` raises before staging *any* of them; the loop stages some and then raises partway through, leaving the session in a half-staged state.

**Student asks: Why does `session.add()` slow down at scale?**

Because its cost is dominated by per-row Python bookkeeping, not SQL. For N=1, the bookkeeping is microseconds; for N=1 000, hundreds of milliseconds; for N=100 000, minutes. The unit-of-work is doing real work — identity-map updates, cascade traversal, event firing, primary-key retrieval — and that work scales linearly with N. The Core-level APIs skip all of it, which is why they are 10–100x faster. The bottleneck is not the database; it is the Python.


### Variant C: `session.execute(insert(Task).values([...]))`

```python
def insert_via_core_bulk(session: Session, project_id: uuid.UUID, n: int) -> int:
    rows = [
        {
            "project_id": project_id,
            "slug": f"task-{i:04d}",
            "title": f"Task {i}",
            "status": "todo",
            "position": i,
        }
        for i in range(n)
    ]
    session.execute(insert(Task).values(rows))
    session.commit()
    return n
```

**What it does:** Builds a list of plain dicts (not `Task` instances), passes them to `insert(Task).values(rows)`, and executes. SQLAlchemy compiles a single multi-row `INSERT INTO tasks (project_id, slug, title, status, position) VALUES (:project_id_0, :slug_0, ...), (:project_id_1, ...), ...` and sends it in one round-trip.

**Why this is 10–100x faster than Variant A/B:**

1. **One SQL statement, not N.** The database parses, plans, and executes one INSERT. The unit-of-work's per-row INSERT loop is bypassed entirely.
2. **No identity-map bookkeeping.** The rows are inserted directly; the session does not track them as pending objects. (This is also the downside — see below.)
3. **No ORM events.** `after_insert` does not fire. (This is also a downside if you needed them.)
4. **No Python object construction.** The rows are plain dicts, not `Task` instances. The construction cost is the cost of a dict comprehension, which is much cheaper than instantiating a `DeclarativeBase` subclass.
5. **One round-trip.** All N rows are sent in one network message. For Postgres over TCP, that is the difference between 1 000 × ~0.3ms round-trips (300ms) and one ~5ms round-trip.

**Production reality: Postgres caps multi-row INSERT at 65 535 bound parameters per statement.**

Postgres's prepared-statement parameter limit is 65 535. For a 7-column `Task` row, the multi-row `INSERT INTO tasks (...) VALUES (...), (...), ...` reaches the limit at ~9 362 rows. SQLAlchemy 2.1.5 does not auto-chunk — `insert(Task).values(rows)` with `rows=[...]` of length 10 000 raises `OperationalError: number of parameters must be between 0 and 65535`. The fix is explicit chunking: `for chunk in chunks(rows, 5000): session.execute(insert(Task).values(chunk))` — a 5 000-row chunk leaves headroom for the 7 columns and the per-statement overhead. The chunk size is not a performance knob; it is a hard correctness constraint. The CI gate is a unit test that calls `insert(Task).values(rows)` with `rows=[{...}] * 10_000` and asserts the `OperationalError` is raised — the test documents the limit so a future engineer does not rediscover it in production.


**What you lose:**

- **The identity map.** After `session.execute(insert(Task).values(rows))`, the session has no `Task` instances for those rows. If you then call `session.execute(select(Task).where(...)).scalar_one()`, the session will *re-query* the database — it cannot return a cached instance because none exists. For most use cases this is fine; if you need the inserted instances, query them after.
- **ORM cascades.** If `Task.project` has `cascade="save-update"`, the ORM path cascades inserts to pending `Project` instances. The Core-level `insert()` does not — `project_id` is a plain value in the dict, not a relationship traversal. If you need to insert a `Project` and its `Task`s in one transaction, you must insert the project first (via `session.add(project); session.flush()`), get the `project.id`, then use that id in the bulk-insert dicts.
- **Server-side defaults via Python.** If `Task.id` is `mapped_column(BigInteger, Identity(always=True))`, the database assigns the id. The Core-level insert respects this — but you don't get the assigned id back unless you use `insert(Task).values(rows).returning(Task.id)` and read the result.
- **`__init__` validation.** If your `Task` model has a custom `__init__` that validates inputs (e.g., slug must match a regex), the Core-level insert bypasses it because no `Task` instance is constructed. The dicts go straight to SQL.
- **`version_id` optimistic concurrency.** If `Task` has `__mapper_args__ = {"version_id_col": ...}`, the ORM path manages the version column automatically. The Core-level insert does not.

**Danger — Bulk insert bypasses `__init__` validation — a malformed slug reaches the DB and can carry a stored-XSS payload.**

The `Task` model's `__init__` validates that `slug` matches `^[a-z0-9-]+$` (URL-safe, lowercase, no special chars). The Core-level `insert(Task).values(rows)` does not construct `Task` instances, so the validator never runs — the dicts go straight to SQL. If the service layer that builds the dicts forgets to pre-validate the slug (or accepts a caller-supplied slug from a request body without sanitizing), a malformed slug like `<script>alert(1)</script>` reaches the database. If the slug is later rendered in a templated response (e.g., a task URL `/projects/{slug}/tasks` rendered into an HTML `href`), the stored-XSS payload executes in the browser. The fix is to pre-validate every column the `__init__` would have validated — the slug, the title, the status — at the dict-construction site, OR to use `session.add(task)` for the rows that need validation. The CI gate is a contract test that calls the bulk-insert path with a malformed slug and asserts the row was rejected before reaching the DB; see [[11-Authentication-and-Security/OWASP-API-Top-10]] for the stored-XSS class and [[04-Pydantic/Validators-Strict-vs-Coercive]] for the input-validation pattern at the request-body boundary.


**Multi-row VALUES is dialect-specific.**

The `insert(Model).values([...])` form compiles to `INSERT INTO ... VALUES (...), (...), (...)` on Postgres and SQLite. On MySQL, it does the same. On Oracle, it uses `INSERT ALL ... INTO ... VALUES ... SELECT 1 FROM DUAL`. SQLAlchemy handles this transparently; you write the same Python, the dialect compiles to the right SQL. The performance characteristics are similar across dialects.


**Student asks: When does bulk insert break ORM cascades?**

Whenever the cascade requires the ORM to traverse the parent-child relationship at flush time. Example: `Project.tasks = relationship("Task", cascade="save-update, delete")`. With `session.add(project)` where `project.tasks` is a list of pending `Task` instances, the unit-of-work cascades: it inserts the `Project`, then inserts each `Task` with the parent's id. With `session.execute(insert(Task).values(rows))`, the dicts go straight to SQL — the cascade never fires. If the dicts' `project_id` is correct, the database ends up in the same state. If the dicts' `project_id` is wrong (or null), the bulk insert succeeds but the data is corrupt — the ORM's cascade logic was the only thing that knew the right id. The rule: bulk-insert only after the parent is committed and you have its id in hand.


### Variant D: `session.bulk_insert_mappings(Model, [...])`

```python
def insert_via_bulk_mappings(session: Session, project_id: uuid.UUID, n: int) -> int:
    mappings = [
        {
            "project_id": project_id,
            "slug": f"task-{i:04d}",
            "title": f"Task {i}",
            "status": "todo",
            "position": i,
        }
        for i in range(n)
    ]
    session.bulk_insert_mappings(Task, mappings)
    session.commit()
    return n
```

**What it does:** Calls the legacy `Session.bulk_insert_mappings(Model, list_of_dicts)` API. Internally, this skips even more of the ORM machinery than Variant C — it does not construct `Task` instances, does not consult the identity map, does not fire ORM events, and (in some dialects) bypasses some of SQLAlchemy's own SQL-generation layer to send the rows to the driver as directly as possible.

**Danger — `bulk_insert_mappings` skips Python-side `default=uuid.uuid4` — a NULL surrogate id breaks downstream joins silently.**

If the `Task` model has `id: Mapped[uuid.UUID] = mapped_column(default=uuid.uuid4)`, the ORM path's `session.add(task)` populates `id` from the Python callable before the INSERT. `bulk_insert_mappings(Task, mappings)` skips Python defaults — it relies on the database to assign the id, but only if a `server_default` is set; otherwise the column gets `NULL`. If the column is nullable-with-unique-on-a-different-natural-key (e.g., `UNIQUE(slug)` but `id` is nullable), the rows insert with `NULL` surrogate ids. Downstream code that joins on `tasks.id` (e.g., the `comments.task_id` foreign key) returns no rows — the comment-write path silently fails. The symptom is "the import succeeded but the comments are orphaned"; the SQL log shows `INSERT INTO tasks (slug, title, ...) VALUES (...)` with no `id` column in the column list. The fix is either (a) add `id` to every dict (`mappings.append({"id": uuid.uuid4(), ...})`) so Python assigns it, OR (b) set `server_default=func.gen_random_uuid()` on the column so Postgres assigns it. The CI gate is a unit test that calls `bulk_insert_mappings` and then queries the inserted rows' `id` column — assert it is not `NULL`.


**Why it is the fastest:** It is the most aggressive about skipping ORM machinery. The cost is paid in ORM behaviour: you get *nothing* back except a rowcount. No `RETURNING`. No events. No cascades. No identity map. The only thing `bulk_insert_mappings` does that `session.execute(insert(Model).values([...]))` does not is a slightly more aggressive code path that bypasses some SQLAlchemy internal layers.

**Warning — `bulk_insert_mappings` does not retrieve server-side defaults — the symptom is "the insert didn't run".**

`bulk_insert_mappings` skips the `RETURNING` clause entirely. For a model with `created_at: Mapped[datetime] = mapped_column(server_default=func.now())`, the database assigns `created_at` at INSERT time, but `bulk_insert_mappings` does not retrieve it back — the inserted row's database-side representation is correct, but any in-memory object the engineer still holds is stale. The symptom is the engineer's report "the bulk insert didn't run" because `session.refresh(obj)` on a stale object returns no row (the identity map was bypassed). The SQL log shows the INSERT statement was emitted; the database is correct, only the Python object is stale. The fix is `session.expire_all()` after the bulk insert and then a fresh `select(...).where(...)` — never `session.refresh(stale_obj)` on a `bulk_insert_mappings`-inserted row. See [[07-SQLAlchemy/06-Querying-with-select]] for the `expire_all()` pattern and the bulk-update counterpart.


**When `bulk_insert_mappings` is the right call:**

- **Reference-data loads at startup.** Seeding 5 000 geographies, 200 currencies, 50 event types — none of these need ORM events or identity-map tracking. `bulk_insert_mappings` is the right tool.
- **One-shot migrations** where you have already loaded the source data into Python dicts. The legacy API's interface is exactly "give me a list of dicts."
- **When you have measured that `session.execute(insert(...))` is not fast enough.** On Postgres 17 with SQLAlchemy 2.1, the gap between Variant C and Variant D is usually small (1.5–2x). For most workloads, Variant C is the right pick because it has a cleaner interface and supports `RETURNING`. Variant D wins when you are inserting 100 000+ rows and the per-row SQLAlchemy overhead of `insert().values()` parsing becomes measurable.

**Warning — `bulk_insert_mappings` is legacy.**

The SQLAlchemy docs flag this API as "legacy" — not deprecated (it is not going away), but the recommended modern equivalent is `session.execute(insert(Model).values([...]))`. The legacy API has subtle differences in how it handles Python-side defaults (it does not evaluate them; it relies on the database to assign), server-side defaults (it does not retrieve them), and RETURNING (it does not support it). For new code, prefer Variant C unless you have measured that Variant D is materially faster for your workload.


**What "mappings" means.**

The function name `bulk_insert_mappings` refers to the fact that the input is a list of dicts ("mappings" in SQLAlchemy's terminology — attribute-name to value). The alternative API `bulk_save_objects` takes ORM instances, not dicts; it is even slower than `bulk_insert_mappings` because it still has to construct the instances. The dict-based API is the fast one.


### The benchmark harness

```python
def benchmark(n: int = 1_000) -> dict[str, float]:
    timings: dict[str, float] = {}

    for name, fn in [
        ("session.add", insert_via_add),
        ("session.add_all", insert_via_add_all),
        ("session.execute(insert())", insert_via_core_bulk),
        ("session.bulk_insert_mappings", insert_via_bulk_mappings),
    ]:
        with session_scope() as session:
            project = Project(name=f"Bench-{name}", slug=f"bench-{name.lower()}")
            session.add(project)
            session.flush()  # get project_id without committing

            start = time.perf_counter()
            count = fn(session, project.id, n)
            elapsed = time.perf_counter() - start
            timings[name] = elapsed
            print(f"  {name}: inserted {count} rows in {elapsed:.3f}s")

    return timings
```

**Why each variant gets its own session:** To make the comparison fair, each variant runs against a fresh session with a cold identity map. If we reused one session, Variant A's commits would warm the identity map and Variants B/C/D would benefit from cached state — polluting the timings.

**Why each variant gets its own `Project`:** So the slugs are unique. The `Task.slug` has a per-project unique constraint in our schema; reusing a project id would make Variant B's inserts fail with an IntegrityError on duplicate slugs.

**Why `session.flush()` after `session.add(project)`:** We need `project.id` (the auto-assigned primary key) for the bulk-insert dicts. `flush()` sends the INSERT and updates `project.id` in memory without committing the transaction. Then the bulk insert runs in the same transaction, sees the (uncommitted) project row, and references its id.

**Production reality: the benchmark isolates fairly — each variant gets its own session AND its own `Project`.**

The harness uses `with session_scope() as session:` per variant so the identity map is cold for each run; reusing one session would let Variant A's commit warm the identity map, and Variants B/C/D would benefit from cached state, polluting the timings. The harness also seeds a fresh `Project` per variant so the `Task.slug` per-project unique constraint does not trip. In production, the same pattern applies to any A/B benchmark you run on a real workload: isolate the variants on separate sessions, separate transactions, separate seed data, and ideally separate cold connections (so the pool's warm-connection state does not bias the result). The `time.perf_counter()` clock is the right timer for sub-second work; for sub-millisecond work, use `time.perf_counter_ns()` and run the variant 100 times to amortize the timer overhead. See [[12-Testing-and-Quality/Testing-Database-Logic]] for the database-test isolation patterns and [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]] for the production trace-vs-benchmark reconciliation.


## Execution Trace

What actually happens in each variant — at the Python level, the SQLAlchemy level, and the SQL level — when you press Enter on `uv run python -m boardly.inserts`. The four variants share the harness; we trace Variant A and Variant C in detail because they are the most divergent.

### Variant A: `session.add()` end-to-end

For N=3 (small enough to trace by hand, large enough to see the loop):

```mermaid
sequenceDiagram
    participant App as Application
    participant Sess as Session
    participant UoW as Unit-of-work
    participant DB as Database

    App->>Sess: session.add(Task(...)) #1
    Note over Sess: task1 moved to session.new
    App->>Sess: session.add(Task(...)) #2
    Note over Sess: task2 moved to session.new
    App->>Sess: session.add(Task(...)) #3
    Note over Sess: task3 moved to session.new
    App->>Sess: session.commit()
    Sess->>UoW: flush()
    UoW->>UoW: iterate session.new, sort by mapper, group by table
    UoW->>DB: INSERT INTO tasks (...) VALUES (...) #1 — RETURNING id
    DB-->>UoW: id=101
    UoW->>UoW: identity map: register (Task, 101)
    UoW->>DB: INSERT INTO tasks (...) VALUES (...) #2 — RETURNING id
    DB-->>UoW: id=102
    UoW->>UoW: identity map: register (Task, 102)
    UoW->>DB: INSERT INTO tasks (...) VALUES (...) #3 — RETURNING id
    DB-->>UoW: id=103
    UoW->>UoW: identity map: register (Task, 103)
    Note over UoW: fire after_insert events for tasks 1, 2, 3
    UoW-->>Sess: flush done
    Sess->>DB: COMMIT
    Note over Sess: expire_on_commit: instances marked expired
    Sess-->>App: return

```

**Step-by-step:**

1. **Three `session.add(Task(...))` calls.** Each constructs a `Task` instance (the constructor sets attributes; if there are validators they fire) and moves it into `session.new`. No SQL is emitted yet.
2. **`session.commit()` triggers `session.flush()`.** The flush hands the pending objects to the unit-of-work.
3. **The unit-of-work sorts and groups.** It iterates `session.new`, sorts by mapper (so all `Task`s are together), and groups by table. For three pending `Task`s, this is one batch on the `tasks` table — but the unit-of-work still issues three separate INSERTs, one per object.
4. **Per-object INSERT + RETURNING.** For each pending `Task`, the unit-of-work sends `INSERT INTO tasks (...) VALUES (...)` with a `RETURNING id` clause (on Postgres). The database returns the assigned id. The unit-of-work writes that id back to the in-memory `Task` instance's `id` attribute and registers the instance in the identity map keyed by `(Task, id)`.
5. **`after_insert` events fire.** Any `@event.listens_for(Task, "after_insert")` callbacks run now, with the inserted instance as their argument. This is where you would send a notification email, write an audit-log row, or invalidate a cache.
6. **`COMMIT` is sent.** The transaction ends. The data is durable.
7. **`expire_on_commit` marks instances expired.** The next attribute access on the `Task` instances triggers a lazy refresh — but the instances are still in the identity map, so re-accessing them is cheap (one SELECT per instance, but the instance already exists in memory).

### Variant C: `session.execute(insert(Task).values([...]))` end-to-end

For N=3:

```mermaid
sequenceDiagram
    participant App as Application
    participant Sess as Session
    participant Compile as SQL compiler
    participant DB as Database

    App->>App: build list of 3 dicts (not Task instances)
    App->>Sess: session.execute(insert(Task).values(dicts))
    Sess->>Compile: compile insert(Task).values([...])
    Note over Compile: emit one multi-row INSERT
    Compile-->>Sess: INSERT INTO tasks (...) VALUES (...), (...), (...)<br/>with 3 bound parameter sets
    Sess->>DB: execute — one round-trip
    DB-->>Sess: CursorResult(rowcount=3, no rows returned)
    Note over Sess: identity map: untouched<br/>no Task instances registered<br/>no after_insert events fired
    App->>Sess: session.commit()
    Sess->>DB: COMMIT
    Sess-->>App: return

```

**Step-by-step:**

1. **A list comprehension builds N dicts.** No `Task` instances are constructed. Cost: dict construction is microseconds per row; this is the cheapest of the four variants at the Python level.
2. **`insert(Task).values(dicts)` builds a Core-level `Insert` object.** This is a `SQLExpression` construct, not an ORM operation. It carries the table, the column list, and the row list. No SQL is emitted yet.
3. **`session.execute(...)` compiles the `Insert`.** SQLAlchemy compiles it to a single multi-row `INSERT INTO tasks (project_id, slug, title, status, position) VALUES (:project_id_0, :slug_0, ...), (:project_id_1, ...), (:project_id_2, ...)` and sends it in one round-trip.
4. **The database executes the multi-row INSERT.** Three rows are inserted in one statement. The database parses, plans, and executes once.
5. **The `CursorResult` returns `rowcount=3` but no rows.** Without a `.returning(Task.id)` clause, the database does not return the inserted ids. The session has no `Task` instances for these rows.
6. **The identity map is untouched.** The session has no entries for the three new tasks. If you then `session.execute(select(Task).where(...)).scalar_one()`, the session queries the database fresh — it cannot return a cached instance because none was ever created.
7. **No `after_insert` events fire.** The ORM event system is bypassed entirely.
8. **`COMMIT` is sent.** Same as Variant A.

**The two traces differ at four places.**

(1) Python object construction: Variant A constructs N instances; Variant C constructs N dicts. (2) SQL emission: Variant A emits N single-row INSERTs; Variant C emits one multi-row INSERT. (3) Identity-map bookkeeping: Variant A registers N instances with primary keys; Variant C does not. (4) ORM events: Variant A fires N `after_insert` events; Variant C does not. These four differences are the entire 27x performance gap.


**Student asks: which of the four APIs should I default to?**

It depends on N and on whether you need ORM behaviour. For N=1 (a single object from a request body), `session.add()` is correct — you need the cascade behaviour, the events, and the returned instance. For N=10–100 (a batch from an import), `session.add_all()` is convenient but `session.execute(insert(...).values([...]))` is materially faster. For N=1 000+, default to `session.execute(insert(...).values([...]))` unless you need ORM events or cascades. For N=100 000+ reference-data loads, measure Variant C vs Variant D and pick the faster one — but only after you have confirmed you do not need ORM behaviour.


## Common Mistakes

### Mistake 1: Reaching for `session.add_all()` expecting a speedup

```python
# WRONG — same speed as the loop
session.add_all([Task(slug=f"task-{i}") for i in range(10_000)])
session.commit()
```

**Symptom:** The benchmark above shows `add_all()` is ~5% faster than `add()` in a loop. The engineer expected a 10x speedup and got 1.05x.

**Why:** `add_all()` is syntactic sugar. Internally it calls `self.add(obj)` for each object in the list. The unit-of-work does not batch the INSERTs; it emits one per pending object at flush time.

**Fix:** Switch to `session.execute(insert(Task).values(rows))`. That actually batches the INSERT into one multi-row statement and skips the ORM machinery.

**Danger — Using `add_all()` for a 50 000-row import in the request cycle is a double-import bug under retry.**

The engineer reaches for `session.add_all([Task(slug=f"task-{i}") for i in range(50_000)])` in a `POST /orgs/{slug}/seed` endpoint, expecting it to be a "bulk" API. The request times out at the 30s gateway limit; the user (or the gateway) retries. The first request's commit completes after the gateway returned 504 to the user — the rows ARE inserted, but the user sees a failure. The retry inserts the same 50 000 rows with new slugs (because the slug is `task-{i}` and the loop restarts at 0 — but the per-project unique constraint trips if the first batch was committed). The actual bug is two-fold: (1) `add_all()` is not a bulk API, so the request times out; (2) the endpoint is not idempotent, so the retry doubles the work. The fix is to (a) use Variant C (`session.execute(insert(Task).values(rows))`) for the bulk path, AND (b) make the endpoint idempotent via an idempotency key ([[17-Advanced-Architecture/Idempotency-and-Retries]]), AND (c) move the import to a background task ([[14-Caching-and-Background-Processing/Background-Tasks-vs-Workers]]) so the endpoint returns 202 immediately. Without all three, the retry path is a data-corruption incident.


**Warning — If you benchmarked `add_all()` and it was slower than `add()`, that is also noise.**

The two APIs do the same work. The ~5% difference in either direction is measurement noise, not a real performance gap. Reach for a different API, not a different spelling of the same one.


### Mistake 2: Using `session.execute(insert(...))` and then accessing the inserted instances

```python
# WRONG — the session has no Task instances for these rows
session.execute(insert(Task).values([
    {"slug": "task-1", "title": "Task 1", ...},
    {"slug": "task-2", "title": "Task 2", ...},
]))
session.commit()
# ... later in the same session:
tasks = session.execute(select(Task).where(Task.slug == "task-1")).all()
# This works — but it queries the database, not the identity map.
```

**Symptom:** The engineer expects the identity map to short-circuit the SELECT — it does not. The session queries the database because the bulk-inserted rows were never registered as instances.

**Why:** The Core-level `insert()` bypasses the unit-of-work. The session has no `Task` instances for the inserted rows. The SELECT cannot return a cached instance because none exists.

**Fix:** Either (a) re-query after the bulk insert (the database round-trip is fine for most workloads), or (b) call `session.expire_all()` to invalidate all cached state (forces a fresh SELECT on every subsequent access), or (c) use `insert(Task).values(rows).returning(Task.id)` and read the returned ids if you need them.

### Mistake 3: Bulk-inserting without a parent flush

```python
# WRONG — project_id is None when the bulk insert runs
project = Project(name="New", slug="new")
session.add(project)
session.execute(insert(Task).values([
    {"project_id": project.id, "slug": "task-1", ...},  # project.id is None!
    {"project_id": project.id, "slug": "task-2", ...},
]))
session.commit()
```

**Symptom:** `IntegrityError: NOT NULL constraint failed: tasks.project_id`. Or, worse, if the column is nullable, the rows are inserted with `project_id=None` and the data is corrupt.

**Why:** `session.add(project)` stages the project for INSERT but does not emit SQL. `project.id` is `None` until a flush assigns it. The bulk-insert dicts read `project.id` at dict-construction time — which is before the flush — so they capture `None`.

**Warning — The first debugging instinct for `IntegrityError: NOT NULL constraint failed: tasks.project_id` is "the relationship is wrong".**

The error message points at the `tasks.project_id` column, so the engineer's first hypothesis is the SQLAlchemy `relationship()` configuration — they re-read the `Task.project = relationship("Project", back_populates="tasks")` line, suspect a `foreign_keys=` typo, and waste an hour on the ORM mapping. The actual bug is one line above the INSERT call: `session.add(project); rows = [{"project_id": project.id, ...}]; session.execute(insert(Task).values(rows))` — `project.id` is `None` at dict-construction time because no `session.flush()` ran between the `add` and the dict construction. The tell: `print(project.id)` returns `None` after `session.add(project)` and before `session.flush()`. The fix is the `session.flush()` call (covered above); the prevention is to ALWAYS pair `session.add(parent)` with `session.flush()` when the parent's id is needed downstream in the same transaction — make it a code-review checklist item.


**Fix:** Call `session.flush()` after `session.add(project)` and before the bulk insert. `flush()` emits the INSERT for `project`, retrieves the assigned `id` via `RETURNING`, and writes it back to `project.id`. The subsequent bulk-insert dicts then capture the real id.

```python
project = Project(name="New", slug="new")
session.add(project)
session.flush()  # project.id is now populated
session.execute(insert(Task).values([
    {"project_id": project.id, "slug": "task-1", ...},
    {"project_id": project.id, "slug": "task-2", ...},
]))
session.commit()
```

### Mistake 4: Bulk-inserting and relying on `after_insert` events

```python
# WRONG — the after_insert event never fires
from sqlalchemy import event

@event.listens_for(Task, "after_insert")
def send_notification(_, __, target):
    email_service.send(f"Task {target.slug} created")

# ... later:
session.execute(insert(Task).values(rows))  # send_notification is NOT called
session.commit()
```

**Symptom:** The notification email is never sent. The audit-log row is never written. The cache is never invalidated.

**Why:** The Core-level `insert()` bypasses the unit-of-work. The ORM event system is part of the unit-of-work; bypassing the unit-of-work bypasses the events.

**Fix:** Either (a) use `session.add()` for the rows that need event behaviour (correctness wins; speed loses), or (b) move the event logic out of the ORM event and into the service layer (the bulk insert is followed by an explicit `for slug in slugs: email_service.send(...)`). The second option is what most production codebases do for bulk imports — the ORM event is convenient for the single-row case but actively harmful for the bulk case because it makes the bulk path not a true bulk path.

**Danger — A bulk insert that skips `after_insert` events is a GDPR/SOC2 audit-trail incident.**

The ORM event `@event.listens_for(Task, "after_insert")` is the canonical hook for writing the `audit_log` row that records "user X created task Y at time Z". The Core-level `insert(Task).values(rows)` bypasses the event system entirely — the `audit_log` row is never written, the bulk insert commits the data change, and the audit trail is broken. Under GDPR's article 30 (records of processing activities) and SOC2's CC7.2 (change management), an "untracked bulk insert" is a finding — the auditor's question is "show me the audit-log entries for the 1 000 tasks imported on 2026-10-15", and the answer "there are none" is the incident. The fix is not to add the event back (that defeats the bulk path); the fix is to write the audit-log rows in the same transaction as the bulk insert, explicitly: `session.execute(insert(AuditLog).values([{"entity": "Task", "entity_id": rid, "action": "create", ...} for rid in inserted_ids]))`. The audit-log write uses the bulk path too — the trail is captured, the bulk path stays fast. See [[17-Advanced-Architecture/Event-Driven-Basics]] for the outbox pattern that makes the audit-log write transactional with the bulk insert.


### Mistake 5: Forgetting `RETURNING` when you need the inserted ids

```python
# WRONG — no way to get the inserted ids back
result = session.execute(insert(Task).values(rows))
session.commit()
# result.rowcount is N, but there is no way to get the ids
```

**Symptom:** The engineer needs the inserted ids to bulk-insert child rows (e.g., `Comment` rows for each new `Task`). `result.rowcount` gives the count but not the ids.

**Why:** By default, `insert(Model).values(rows)` does not request `RETURNING`. The database inserts the rows but does not return any values.

**Fix:** Add `.returning(Model.id)`:

```python
stmt = insert(Task).values(rows).returning(Task.id)
result = session.execute(stmt)
inserted_ids = [row[0] for row in result]
session.commit()
```

The database returns the inserted ids in one round-trip. On Postgres, this compiles to `INSERT INTO tasks (...) VALUES (...), (...), (...) RETURNING id`. The session then has the ids in `result` (a `CursorResult` you can iterate).

**Warning — The "separate query to recover ids" anti-pattern defeats the bulk INSERT's one-round-trip win.**

The engineer forgets `.returning(Task.id)`, runs the bulk insert, then needs the inserted ids for follow-up work (e.g., bulk-insert child `Comment` rows). The natural recovery is a second query: `SELECT id FROM tasks WHERE slug IN (...)`. That second query is a full table scan or an index lookup on the slug column — for 1 000 inserted rows, it is 1 000 round-trips if the slugs are not indexed, OR one round-trip with a 1 000-element `IN` list that the planner may not optimize. The bulk INSERT's one-round-trip win is lost; the wall-time is dominated by the recovery query. The fix is `.returning(Task.id)` on the bulk INSERT (covered above) — the database returns the ids in the same statement, zero extra round-trips. The prevention is a code-review checklist item: "every `insert(Model).values(rows)` that is followed by follow-up work must include `.returning(...)`". See [[07-SQLAlchemy/06-Querying-with-select]] for the result-shape-method counterpart.


**`RETURNING` works on Postgres and SQLite; not all databases support it.**

Postgres 17, SQLite 3.35+, and Oracle 12c+ all support `RETURNING`. MySQL did not historically; the MariaDB fork does. SQLAlchemy's `insert(...).returning(...)` will raise at compile time on dialects that do not support it. For MySQL, you have to call `LAST_INSERT_ID()` (which only returns the *first* auto-increment id of a multi-row insert — useless for bulk inserts).


### Mistake 6: Using `bulk_insert_mappings` for new code

```python
# DISCOURAGED for new code — use session.execute(insert(...).values([...]))
session.bulk_insert_mappings(Task, mappings)
session.commit()
```

**Symptom:** The code works, but the engineer who reviews it asks "why are we using the legacy API?"

**Why:** `bulk_insert_mappings` is documented as "legacy" in SQLAlchemy 2.x. It is not deprecated (it works and will continue to work), but the modern equivalent is `session.execute(insert(Model).values([...]))`, which has a cleaner interface, supports `RETURNING`, and is more consistent with the rest of the Core API.

**Fix:** Migrate to `session.execute(insert(Task).values(rows))`. If a benchmark shows that `bulk_insert_mappings` is materially faster for your workload (rare, but possible at N=100 000+), keep it but add a comment explaining the choice.

## Engineering Trade-Offs

### When to use what: the decision tree

```mermaid
flowchart TD
    Start["You need to insert N rows"]
    Q1{"N < 100?"}
    Q2{"Need ORM cascades<br/>or after_insert events?"}
    Q3{"Need the inserted<br/>instances back?"}
    Q4{"N > 100 000 and<br/>benchmark shows bulk_insert<br/>materially faster?"}
    Q5{"Need RETURNING for<br/>inserted ids?"}

    Add["session.add(obj)<br/>or session.add_all([objs])<br/>— ORM path"]
    CoreBulk["session.execute(insert(Model).values([...]))<br/>— Core bulk path"]
    CoreReturning["session.execute(insert(Model).values([...]).returning(Model.id))<br/>— Core bulk + RETURNING"]
    LegacyBulk["session.bulk_insert_mappings(Model, [...])<br/>— legacy bulk path"]

    Start --> Q1
    Q1 -- Yes --> Q2
    Q1 -- No --> Q3
    Q2 -- Yes --> Add
    Q2 -- No --> Q3
    Q3 -- Yes --> Q5
    Q3 -- No --> Q4
    Q5 -- Yes --> CoreReturning
    Q5 -- No --> CoreBulk
    Q4 -- Yes --> LegacyBulk
    Q4 -- No --> CoreBulk

    style Start fill:#d4edda,stroke:#28a745
    style Add fill:#d4edda,stroke:#28a745
    style CoreBulk fill:#cce5ff,stroke:#0d6efd
    style CoreReturning fill:#cce5ff,stroke:#0d6efd
    style LegacyBulk fill:#fff3cd,stroke:#ffc107
```

In the decision tree above: green is the ORM path (`session.add()` and `session.add_all()`); blue is the modern Core path (`session.execute(insert(...).values(...))`); orange is the legacy Core path (`session.bulk_insert_mappings`). Reach for green when you need ORM behaviour; reach for blue when you need speed; reach for orange only when you have measured that blue is not fast enough.

### Comparison table: the four APIs side by side

| Axis | `session.add()` | `session.add_all()` | `session.execute(insert(...).values([...]))` | `session.bulk_insert_mappings()` |
|---|---|---|---|---|
| Code path | Unit-of-work | Unit-of-work | Core | Legacy bulk |
| Per-row Python cost | High (instance + map + events) | High (same as `add()`) | Low (dict) | Lowest (dict, no SA layers) |
| SQL emitted | N single-row INSERTs | N single-row INSERTs | One multi-row INSERT | One multi-row INSERT |
| Network round-trips | N (or 2N with RETURNING) | N (or 2N with RETURNING) | 1 (or 2 with RETURNING) | 1 |
| Identity map populated | Yes | Yes | No | No |
| ORM cascades fire | Yes | Yes | No | No |
| ORM events fire (after_insert) | Yes | Yes | No | No |
| `RETURNING` supported | Implicit (id retrieved) | Implicit (id retrieved) | Explicit `.returning(...)` | No |
| `version_id` managed | Yes | Yes | No | No |
| `__init__` validation runs | Yes | Yes | No | No |
| Server-side defaults evaluated | Yes | Yes | Yes | Limited |
| Best for | 1 row, need ORM behaviour | List of instances, need ORM behaviour | 100–100 000 rows, no ORM behaviour needed | 100 000+ reference-data loads |
| Worst for | 1 000+ rows | 1 000+ rows | 1 row (overkill) | Code that needs `RETURNING` or events |

**Production reality: a 50 000-row insert in the request-response cycle is wrong even with Variant C.**

The "row count N" axis in the decision tree above is necessary but not sufficient. The other axis is "is this in the request-response cycle or a background task?" A 50 000-row insert via Variant C (one multi-row INSERT, ~50ms on Postgres) is fast at the SQL layer, but the request-response cycle has other constraints: the 30s gateway timeout, the connection-pool saturation (one connection held for 50ms × 1 000 concurrent requests = pool exhaustion), and the user's perceived latency (a 50ms request is "instant", a 500ms request is "slow"). The rule: any insert > 1 000 rows should be a background task — `POST /orgs/{slug}/seed` returns `202 Accepted` with a `job_id`, the bulk insert runs in a worker, the user polls `GET /jobs/{job_id}` for status. See [[14-Caching-and-Background-Processing/Background-Tasks-vs-Workers]] for the task-vs-worker decision and [[14-Caching-and-Background-Processing/Transactional-Outbox]] for the pattern that makes the bulk insert observable (job state, progress percentage, failure recovery) without coupling it to the request cycle.


### What you lose when you go to the Core path

When you switch from `session.add()` to `session.execute(insert(...).values(...))`, you opt out of:

1. **ORM cascades.** `Task.project` with `cascade="save-update"` no longer cascades inserts. You must insert the parent first, get its id, and use that id in the bulk dicts.
2. **ORM events.** `after_insert`, `before_insert`, `after_delete`, etc. do not fire. If your code relies on these for audit logs, cache invalidation, or notifications, you must replicate that logic in the service layer.
3. **Identity map.** The session has no `Task` instances for the inserted rows. Subsequent `select(Task).where(...)` queries the database, not the cache.
4. **`version_id` optimistic concurrency.** The version column is not managed. If your model uses `version_id_col`, the bulk insert may set it incorrectly (or not at all).
5. **`__init__` validation.** Your model's constructor validation is bypassed. The dicts go straight to SQL. Invalid values that the constructor would have rejected will reach the database (and may or may not be rejected by a CHECK constraint or a NOT NULL constraint).
6. **Pydantic-style coercion.** If your model has `Mapped[str]` and you pass an `int` in the dict, the database may coerce it (Postgres does for `text` columns, but not all databases do) or reject it.

**Warning — The trade is speed for ORM behaviour.**

Every one of the six losses above is a real loss. The Core path is faster *because* it does less. If you need any of those six things, use `session.add()`. If you do not need any of them, the Core path is 10–100x faster on the same workload. There is no free lunch; you are paying for the ORM's behaviour with the time it spends doing that behaviour.


### What you keep when you go to the Core path

Even with the trade above, the Core path keeps:

1. **Transactions.** `session.execute(insert(...))` runs inside the session's transaction. A subsequent `session.commit()` makes it durable; a `session.rollback()` undoes it.
2. **Bound parameters.** The values in the dicts become bound parameters in the SQL. No SQL injection risk. (Compare: f-string SQL would be catastrophic.)
3. **Type coercion.** SQLAlchemy's `TypeDecorator`s still translate Python values to database values. `UUID` columns get the right `::uuid` cast on Postgres. `DateTime` columns get the right `TIMESTAMP` representation.
4. **`server_default` evaluation.** Columns with `server_default=func.now()` get the database's value, not Python's.
5. **Connection pool.** The bulk insert uses the same connection pool as the ORM path. No special configuration needed.

### `bulk_insert_mappings` vs `session.execute(insert(...).values(...))`

| Axis | `bulk_insert_mappings` | `session.execute(insert(...).values(...))` |
|---|---|---|
| Status | Legacy (not deprecated) | Modern recommended |
| `RETURNING` | Not supported | Supported via `.returning(...)` |
| Python-side defaults | Not evaluated | Evaluated |
| Server-side defaults | Limited retrieval | Full retrieval |
| Speed | Marginally faster at N=100 000+ | Fast at all N |
| Interface | `(Model, list_of_dicts)` | `insert(Model).values(list_of_dicts)` |
| Composability | Standalone | Composes with `select`, `update`, `delete` |

The rule: prefer `session.execute(insert(...).values(...))` for new code. Reach for `bulk_insert_mappings` only when (a) you have measured that it is materially faster for your workload, and (b) you do not need `RETURNING` or Python-side default evaluation.

**Student asks: does the bulk API work with `Mapped[T]` columns?**

Yes, with a caveat. The bulk API reads the column names from the mapper (`Task.__mapper__.columns`), so it respects `Mapped[T]` annotations and `mapped_column(...)` configuration. The caveat: it does not evaluate Python-side defaults (`default=...`). Columns with `default=uuid.uuid4` will not get a UUID assigned by Python; you must include the value in the dict, or rely on `server_default` (e.g., `server_default=func.gen_random_uuid()` on Postgres). If you forget, you get an `IntegrityError` on `NOT NULL` (or, worse, a NULL value in a column that should have had a UUID).


**Student asks: should I use `.returning(...)` on the bulk insert and `session.refresh(obj)` on the ORM path, or are they equivalent?**

They are not equivalent; they serve different goals. `.returning(Task.id)` on the bulk path tells PostgreSQL to return the inserted `id` values in the same statement, using PostgreSQL's `INSERT ... RETURNING` syntax. The result is a `CursorResult` you iterate to get the ids — fast (one round-trip), no identity-map population. `session.refresh(obj)` on the ORM path is two-phase: (1) the ORM emits the `INSERT`, (2) on `refresh`, it emits a fresh `SELECT` to fetch the row back into the identity map, populating `server_default`-generated columns (`created_at`, `version_id`, etc.). That is two round-trips per object. The trade: `.returning(...)` is faster but does not populate the identity map — the rows are not live ORM objects, just result rows. `session.refresh()` is slower but gives you live ORM objects you can mutate and re-commit. The right choice: `.returning(...)` when you need the inserted values and will not mutate the objects further (an idempotency-key insert, a one-shot ETL); `session.refresh()` (or, better, `session.flush()` which fills server-generated columns without a separate `SELECT` for already-loaded ones) when you need live ORM objects. For a 1 000-row bulk insert where you need the ids for follow-up work, the difference is ~1 000 round-trips (`session.refresh` × 1 000) vs 1 round-trip (`RETURNING` once) — a real 100× speed gap on top of the ORM-vs-Core gap.


## Exercises

**Tip — The 20-minute rule**

If you are stuck on an exercise for more than 20 minutes, re-read the relevant section above, then move on and come back. Learning is not linear.


**Exercise 1 — Run the benchmark.** Save the file as `boardly/inserts.py` and run it. Confirm you see the four timings and the relative ratios. The absolute numbers will vary by machine; the *ratios* should match the pattern (ORM path ~20–30x slower than Core path).

**Exercise 2 — Scale up.** Change `benchmark(n=1_000)` to `benchmark(n=10_000)`. Run it. The ORM path should now take seconds; the Core path should still take tens of milliseconds. The ratio should grow.

**Exercise 3 — Add `RETURNING`.** Modify `insert_via_core_bulk` to use `insert(Task).values(rows).returning(Task.id)` and capture the inserted ids. Print the first three ids. Verify they are real primary keys, not `None`.

**Exercise 4 — Cascade test.** Add a `Project` with `tasks` relationship and `cascade="save-update"`. Insert a project with three pending tasks via `session.add(project)`; commit; verify all four rows are inserted. Now try the same with `session.execute(insert(Task).values([...]))` — verify the project must be flushed first.

**Exercise 5 — Event test.** Add an `@event.listens_for(Task, "after_insert")` callback that prints the inserted slug. Run `insert_via_add` — verify the callback fires three times. Run `insert_via_core_bulk` — verify the callback does not fire at all. (This is the trade: events are ORM-only.)

**Exercise 6 — Compare `bulk_insert_mappings` to `insert().values([...])`.** Modify `insert_via_bulk_mappings` to use `insert(Task).values(mappings)` instead. Re-run the benchmark. The two should be within 2x of each other; `bulk_insert_mappings` may be marginally faster at N=10 000 but the difference is usually small.

**Exercise 7 — Expire-after-bulk.** Insert 100 tasks via `insert(Task).values(rows)`. Without committing, query `select(Task).where(...)` for one of the slugs. Verify the session queries the database (not the identity map) because the bulk insert did not register the row.

**Exercise 8 — Run the 100 000-row benchmark.** Change `benchmark(n=100_000)` and run it on Postgres (not SQLite — SQLite's per-statement overhead dominates at this scale and obscures the gap). Verify the ORM path takes minutes; the Core path takes seconds. Verify the ratio is still 20-30x. Verify with: `BOARDLY_DATABASE_URL=postgresql+psycopg://boardly:boardly@localhost/boardly uv run python -m boardly.inserts`.

**Exercise 9 — Chunk a 50 000-row insert.** Write `insert_via_core_bulk_chunked(session, project_id, n, chunk_size=5000)` that chunks the dicts to avoid the Postgres 65 535-parameter limit. Run with `n=50_000` and verify no `OperationalError: too many parameters` is raised. Verify with: `uv run pytest tests/test_chunked_bulk_insert.py -k no_too_many_parameters`.

**Exercise 10 — Audit `bulk_insert_mappings` for missing Python defaults.** Write a script that scans `boardly/models.py` for any `Mapped[T]` column with `default=` (Python-side). For each such column, scan the codebase for `bulk_insert_mappings(Model, mappings)` calls and verify the mappings include that column's key. Fail if any mapping is missing the column. Verify with: `uv run python scripts/audit_bulk_default_skip.py`.

**Exercise 11 — Add `RETURNING` to the bulk path.** Modify `insert_via_core_bulk` to use `.returning(Task.id, Task.slug)` and capture both columns. Zip the returned ids and slugs against the input rows and verify they match (same order, same values). Verify with: `uv run pytest tests/test_bulk_returning_pairs.py -k ids_match_slugs`.

**Exercise 12 — Test the audit-trail gap.** Add an `@event.listens_for(Task, "after_insert")` callback that writes an `AuditLog` row. Run `insert_via_add(n=10)` and verify 10 `AuditLog` rows are written. Run `insert_via_core_bulk(n=10)` and verify 0 `AuditLog` rows are written — confirming the ORM event is bypassed. Document the gap in a code-review comment on the bulk-insert path. Verify with: `uv run pytest tests/test_audit_log_gap.py -k bulk_path_no_audit`.

**Exercise 13 — Move a 50 000-row import to a background task.** Add a FastAPI endpoint `POST /orgs/{slug}/seed` that enqueues the bulk insert via `BackgroundTasks`. Verify the endpoint returns `202 Accepted` immediately (under 50ms) and that the import runs in the background. Use the slow-query log to confirm only one bulk INSERT statement is issued (not N single-row INSERTs). Verify with: `uv run pytest tests/test_seed_background.py -k returns_202_immediately`.

## Verification

Run the benchmark:

```bash
BOARDLY_DATABASE_URL=sqlite:///:memory: uv run python -m boardly.inserts
```

Expected output (truncated; ratios matter more than absolute timings):

```
Benchmarking 1 000-row inserts, four APIs, SQLAlchemy 2.1.x:
  session.add: inserted 1000 rows in 0.31s
  session.add_all: inserted 1000 rows in 0.30s
  session.execute(insert()): inserted 1000 rows in 0.018s
  session.bulk_insert_mappings: inserted 1000 rows in 0.011s

Relative to fastest:
  session.add: 28.4x
  session.add_all: 26.8x
  session.execute(insert()): 1.6x
  session.bulk_insert_mappings: 1.0x
```

If you see the four timings and the four ratios, you have successfully:

- Distinguished the four insert APIs by their code path (unit-of-work vs Core vs legacy bulk).
- Measured the ORM-vs-Core performance gap on a real workload.
- Confirmed that `add_all()` is syntactic sugar, not a bulk API.
- Confirmed that `bulk_insert_mappings` is the fastest, with `session.execute(insert())` close behind.
- Confirmed that the ORM path is ~20–30x slower than the Core path on N=1 000.

## Previously Learned Here

- **Lesson 03 — Declarative Base and Mapped.** The `Task` model is a `DeclarativeBase` subclass; its `Mapped[T]` attributes are what the bulk APIs' column-name keys refer to.
- **Lesson 05 — Session and Transaction Management.** `session.add()`, `session.flush()`, `session.commit()`, the identity map, and `expire_on_commit` are the load-bearing concepts. The unit-of-work path is the canonical reference.
- **Lesson 06 — Querying with `select()`.** `session.execute(...)` is the same execution entry point for `select()` and `insert()`. The Core-level bulk API reuses the same machinery.
- **Lesson 08 — Advanced ORM.** `hybrid_property`, `version_id_col` optimistic concurrency, ORM events (`after_insert`, `before_update`), `with_for_update()` pessimistic locking, and the `inspect()` API — the advanced features that the Core-level bulk path bypasses. You have already met them in Lesson 08; the "What you lose" bullets in this lesson quantify that bypass.
- **SQL literacy** — [[06-SQL-Fundamentals/Relational-Model-and-Constraints]]. The multi-row `INSERT INTO ... VALUES (...), (...), (...)` SQL is what Variant C emits; you should be able to read it.

## What's Next

You have reached the end of the SQLAlchemy 2.1.x track. The next section — [[09-Alembic-Migrations/00-Alembic-MOC]] — picks up where the ORM leaves off: schema evolution in production. You will:

- **Set up Alembic** — `alembic init`, `env.py` wiring, `Base.metadata` import discipline, URL from settings (not `alembic.ini`), `pool.NullPool` for migrations. See [[09-Alembic-Migrations/Alembic-Setup-and-Workflow]].
- **Use autogenerate — and learn its limits** — the rename-as-drop+add data-loss trap, the seven-item pre-commit checklist, `compare_type=True` false positives, `postgresql_concurrently=True` for index creation. See [[09-Alembic-Migrations/Autogenerate-and-Its-Limits]].
- **Write data migrations safely** — batches, idempotency (`WHERE slug IS NULL`), reversibility, the AUTOCOMMIT pattern for million-row backfills, deterministic helpers (do not import from app — "migrations must be deterministic across time"). See [[09-Alembic-Migrations/Data-Migrations-Safely]].
- **Deploy migrations in production** — `alembic upgrade head` as a deploy step (NOT lifespan), the expand-contract 5-step pattern, NOT NULL safety check before `ALTER COLUMN`, multi-instance coordination (Kubernetes `Job` + Helm `pre-upgrade` hook + GitHub Actions `needs: migrate` gate). See [[09-Alembic-Migrations/Deploying-Migrations-in-Production]].

The bridge from this lesson to the next: the bulk-insert and bulk-update patterns you just learned are exactly what a data-migration backfill uses to move 50 000 rows from one column shape to another. The decision tree from this lesson (ORM path for N<100, Core path for N≥100) is the same decision tree you will use in Lesson 09.03 to choose between `op.bulk_insert` and `op.execute(text(...))` for a data backfill.

## Sources

- **SQLAlchemy 2.x — `Session.add`** — <https://docs.sqlalchemy.org/en/21/orm/session_api.html#sqlalchemy.orm.Session.add> — accessed 2026-10-19 — the single-object add API.
- **SQLAlchemy 2.x — `Session.add_all`** — <https://docs.sqlalchemy.org/en/21/orm/session_api.html#sqlalchemy.orm.Session.add_all> — accessed 2026-10-19 — the multi-object add API (note: same code path as `add()`).
- **SQLAlchemy 2.x — `insert()` (Core DML)** — <https://docs.sqlalchemy.org/en/21/core/dml.html#sqlalchemy.sql.expression.insert> — accessed 2026-10-19 — the Core-level bulk INSERT statement.
- **SQLAlchemy 2.x — Bulk INSERT via `insert().values()`** — <https://docs.sqlalchemy.org/en/21/orm/queryguide/dml.html#bulk-insert-via-the-insert-expression> — accessed 2026-10-19 — the modern recommended bulk-insert pattern.
- **SQLAlchemy 2.x — Legacy bulk operations (`bulk_insert_mappings`)** — <https://docs.sqlalchemy.org/en/21/orm/queryguide/api.html#bulk-operations> — accessed 2026-10-19 — the legacy bulk API. Documented as legacy; not deprecated.
- **SQLAlchemy 2.x — ORM Events (`after_insert`)** — <https://docs.sqlalchemy.org/en/21/orm/events.html#sqlalchemy.orm.orm_events.MapperEvents.after_insert> — accessed 2026-10-19 — the ORM event that fires only on the unit-of-work path.
- **PostgreSQL 17 — `INSERT` with multiple `VALUES`** — <https://www.postgresql.org/docs/17/sql-insert.html> — accessed 2026-10-19 — the multi-row INSERT syntax Variant C compiles to.
- **PostgreSQL 17 — `RETURNING`** — <https://www.postgresql.org/docs/17/dml-returning.html> — accessed 2026-10-19 — how to get inserted ids back from a bulk INSERT.
- **SQLAlchemy 2.x — `Session.execute`** — <https://docs.sqlalchemy.org/en/21/orm/session_api.html#sqlalchemy.orm.Session.execute> — accessed 2026-10-19 — the execution entry point shared by `select()` and `insert()`.

## What We Learned

Let's recap. In this lesson you:

- **Distinguished four insert APIs** in SQLAlchemy 2.1.x: `session.add(obj)`, `session.add_all([objs])`, `session.execute(insert(Model).values([...]))`, and `session.bulk_insert_mappings(Model, [...])`.
- **Understood the unit-of-work path** that `session.add()` and `session.add_all()` traverse — pending objects, identity map, flush, ORM cascades, ORM events — and why that path is the right one for small writes.
- **Understood the Core-level bulk path** that `session.execute(insert(...).values([...]))` takes — direct multi-row INSERT, bypassing the unit-of-work, no identity map, no cascades — and why it is 10–100x faster for thousands of rows.
- **Understood the legacy `bulk_insert_mappings` API** — even faster, even less ORM behaviour, no `RETURNING`, document-as-legacy status.
- **Benchmarked the four APIs** against a 1 000-row workload and seen the 20–30x gap between ORM-path and Core-path.
- **Identified the six things you lose** when you switch from `session.add()` to the Core path: ORM cascades, ORM events, identity map, `version_id`, `__init__` validation, Pydantic-style coercion.
- **Identified the five things you keep** with the Core path: transactions, bound parameters, type coercion, server-side defaults, connection pool.
- **Learned the decision tree**: ORM path for N<100 or when you need cascades/events/instances; Core path for N≥100 when you do not; legacy bulk only when measured faster and `RETURNING` not needed.

Here's the mental model to walk away with: *SQLAlchemy 2.1.x offers four insert APIs, not one. `session.add()` and `session.add_all()` traverse the unit-of-work — they fire cascades, events, identity-map bookkeeping, and per-row INSERTs with RETURNING. They are the right choice when N is small or when you need ORM behaviour. `session.execute(insert(Model).values([...]))` is the Core-level bulk path — one multi-row INSERT, no identity map, no events, no cascades, 10–100x faster. It is the right choice when N is large and you do not need ORM behaviour. `session.bulk_insert_mappings(Model, [...])` is the legacy bulk API — even faster, even less ORM behaviour, no RETURNING. It is the right choice only when measured faster and `RETURNING` is not needed. Reach for the right tool; do not reach for `session.add()` for every workload and then blame the ORM.*

---

> A note from your teacher
You just learned the comparison that most SQLAlchemy tutorials skip. The single most common "ORM is slow" complaint in production is not about the ORM at all — it is about an engineer who reached for `session.add()` on a 50 000-row import and waited a minute for the request to finish. The fix is one line: `session.execute(insert(Task).values(rows))`. The fix is also a mental shift: there are four insert APIs, not one, and the right choice depends on N and on whether you need ORM behaviour. Take that mental model with you into the next section — it is the same decision tree you will use in Lesson 09.03 when you choose between `op.bulk_insert` and `op.execute(text(...))` for a data-migration backfill. See you in Section 09.


---

**Tags:** #sqlalchemy #insert #bulk #comparison #lesson
**Previous:** [[08-Advanced-ORM]]
**Next:** [[09-Alembic-Migrations/00-Alembic-MOC]] →

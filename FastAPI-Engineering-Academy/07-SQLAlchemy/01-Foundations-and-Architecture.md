---
title: "Lesson 01: SQLAlchemy Foundations and Architecture"
aliases:
 - SQLAlchemy Foundations
 - Core vs ORM
 - SQLAlchemy Architecture
 - Unit of Work
 - Identity Map
tags:
 - sqlalchemy
 - orm
 - architecture
 - foundations
 - unit-of-work
 - identity-map
course_level: intermediate
status: complete
difficulty: intermediate
estimated_time: "75–110 minutes"
prerequisites:
 - "[[01-Python-Foundations/Type-Hints-and-Annotations]]"
 - "[[01-Python-Foundations/Iterators-Generators-Context-Managers]]"
 - "[[06-SQL-Fundamentals/Relational-Model-and-Constraints]]"
 - "[[06-SQL-Fundamentals/Transactions-Isolation-Locks]]"
related_lessons:
 - "[[02-Engines-Connections-Pools]]"
 - "[[03-Declarative-Base-and-Mapped]]"
 - "[[05-Session-and-Transaction-Management]]"
 - "[[07-Async-SQLAlchemy]]"
---

# Lesson 01: SQLAlchemy Foundations and Architecture

*Core vs ORM, the unit-of-work pattern, the identity map, dialects, drivers, and the difference between sync and async — the mental model that every later lesson will rely on.*

**You're at the very beginning of Section 07.**

Every Python service that touches a relational database either uses SQLAlchemy, replaces it with something thinner, or pretends it doesn't need an ORM until it does. Today we draw the map. Every later lesson populates the territory. Take your time. There is no code you can run today that won't be re-explained tomorrow — but without this lesson, tomorrow's code will read like magic. **This is how you learn SQLAlchemy.**


#sqlalchemy #orm #architecture #unit-of-work

## Learning Objectives

By the end of this lesson you will be able to:

1. **Draw the SQLAlchemy layer cake** (Dialect → Core → ORM → Session) and say what each layer is responsible for.
2. **Distinguish Core from ORM** in your sleep, and look at any SQLAlchemy snippet and say which layer it touches.
3. **Explain the unit-of-work pattern** in plain English and name the SQLAlchemy object that implements it (the `Session`).
4. **Explain the identity map** — why within a session one row in the database maps to one Python object — and why it is per-session, not per-process.
5. **Choose declarative 2.x mapping over classical mapping** and articulate why (type hints, IDE support, less boilerplate, fewer bugs).
6. **Match a database driver to a dialect** (`psycopg` for sync Postgres, `asyncpg` for async Postgres, `sqlite3` for sync SQLite, `aiosqlite` for async SQLite) and read a SQLAlchemy URL like `postgresql+psycopg://user:pass@host:5432/db`.
7. **Anticipate where sync and async SQLAlchemy diverge** (covered fully in [[07-Async-SQLAlchemy]]) and explain why `async def` is not magic.

## Prerequisites

Before starting, you need:

- **Type hints and `Annotated`** — [[01-Python-Foundations/Type-Hints-and-Annotations]]. The 2.x ORM is built on type annotations; `Mapped[T]` is a typing primitive. If you cannot read `name: Mapped[str] = mapped_column(String(255))` comfortably, review that lesson first.
- **Context managers** — [[01-Python-Foundations/Iterators-Generators-Context-Managers]]. The `Session` is used as a context manager (`with Session(engine) as session: ...`). The async equivalent (`AsyncSession`) uses `async with`. If `__enter__`/`__exit__` and `yield`-based context managers are fuzzy, go review.
- **SQL basics** — [[06-SQL-Fundamentals/Relational-Model-and-Constraints]]. You should be able to read a `CREATE TABLE` and a `SELECT ... JOIN`. We will not teach SQL here; we will teach how SQLAlchemy builds and executes it.
- **Transactions** — [[06-SQL-Fundamentals/Transactions-Isolation-Locks]]. The `Session` is a wrapper around a database transaction. You must understand what `BEGIN`/`COMMIT`/`ROLLBACK` mean before you understand what `session.commit()` does.
- **About 90 minutes of focused time.** This lesson has the least code of any lesson in the track and the most explanation. Read it slowly; the rest of the track assumes it.

**The most common gap: SQL fundamentals.**

If you have never written a `JOIN` by hand, this lesson will feel like learning a foreign language by reading its grammar. You can still follow along — we use small, well-commented queries — but the why behind every SQLAlchemy feature will be opaque. The fix is [[06-SQL-Fundamentals/00-SQL-MOC]]; come back here after Lesson 03 of that section.


## The Problem

You are about to build `Boardly`, a project-management API. `Boardly` has Organizations, Projects, Tasks, Comments, and Users. Eventually you will have hundreds of route handlers, each of which needs to:

1. Read rows from a Postgres database.
2. Mutate some of those rows.
3. Insert new rows.
4. Do all of this transactionally — either the whole batch succeeds, or none of it does.
5. Do it concurrently with hundreds of other requests, against a shared connection pool, without corrupting state.

You could write raw SQL. Many teams do. The cost is:
- **Driver boilerplate.** Every query needs parameter binding, cursor management, error translation, and connection lifecycle.
- **No type safety.** A typo in a column name is a runtime `OperationalError`, not a type error.
- **No identity tracking.** If two functions load "User #42" in the same request, they each get a separate dict and the second writes over the first's mutations.
- **No transactional consistency at the object level.** You manage `BEGIN`/`COMMIT`/`ROLLBACK` by hand at every call site.

SQLAlchemy exists to remove this boilerplate without giving up SQL. Its 2.x API is the cleanest expression of that goal in the Python ecosystem. But it has a reputation for being "magic" — and that reputation is earned almost entirely by engineers who never learned the layer cake. Today we draw the cake.

## The Code

There is no `Boardly` source file built in this lesson — Lesson 02 builds `boardly/db.py`. But to make the architecture concrete, here is a single teaching script that does the same conceptual write three ways: raw Core, declarative ORM, and classical ORM. Save it as `architecture_demo.py` and run it against an in-memory SQLite database. You will not need a Postgres install for this lesson; we will switch to Postgres in Lesson 02.

```python
# architecture_demo.py
"""Lesson 01 — Three ways to insert a user with SQLAlchemy 2.1.

Run: uv run python architecture_demo.py
"""
from typing import Optional

from sqlalchemy import Column, Integer, String, Table, create_engine, insert, select
from sqlalchemy.orm import (
 DeclarativeBase,
 Mapped,
 Session,
 mapped_column,
 registry,
)


# ---- (1) RAW CORE: a Table object and a Core insert ----
metadata_obj = sqlalchemy_meta = __import__("sqlalchemy").MetaData()

users_table = Table(
 "users_core",
 metadata_obj,
 Column("id", Integer, primary_key=True),
 Column("email", String(255), unique=True, nullable=False),
)


# ---- (2) DECLARATIVE ORM (2.x canonical) ----
class Base(DeclarativeBase):
 pass


class UserDeclarative(Base):
 __tablename__ = "users_declarative"

 id: Mapped[int] = mapped_column(primary_key=True)
 email: Mapped[str] = mapped_column(String(255), unique=True)


# ---- (3) CLASSICAL ORM (legacy, shown for contrast only) ----
users_classical_table = Table(
 "users_classical",
 Base.metadata, # share the same MetaData as the declarative base
 Column("id", Integer, primary_key=True),
 Column("email", String(255), unique=True),
)


class UserClassical:
 pass # no attributes until the mapper attaches them


reg = registry(metadata=Base.metadata)
reg.map_imperatively(UserClassical, users_classical_table)


# ---- RUN ----
def main() -> None:
 engine = create_engine("sqlite:///:memory:", echo=False)
 Base.metadata.create_all(engine) # creates all three tables in one call

 email = "ada@example.com"

 # (1) Raw Core insert
 with engine.connect() as conn:
 conn.execute(insert(users_table).values(email=email))
 conn.commit()

 # (2) Declarative ORM insert
 with Session(engine) as session:
 session.add(UserDeclarative(email=email))
 session.commit()

 # (3) Classical ORM insert
 with Session(engine) as session:
 session.add(UserClassical(email=email))
 session.commit()

 # Verify all three rows exist
 with Session(engine) as session:
 for label, model in [
 ("core", users_table),
 ("declarative", UserDeclarative),
 ("classical", UserClassical),
 ]:
 stmt = select(model) if not isinstance(model, Table) else select(model)
 row = session.execute(stmt).first()
 print(f"{label:12s} -> {row}")


if __name__ == "__main__":
 main()
```

When you run this, you should see three lines, one per table, each containing the row you just inserted. The point is not the output — it is the three styles of writing the same `INSERT`. Read every line; we will explain each block next.

## Line-by-Line Deep Dive

This is the heart of the lesson. Read it twice. Do not skip — every later lesson assumes you have this mental model.

### Lines 1–10: The module docstring and imports

```python
"""Lesson 01 — Three ways to insert a user with SQLAlchemy 2.1.

Run: uv run python architecture_demo.py
"""
from typing import Optional

from sqlalchemy import Column, Integer, String, Table, create_engine, insert, select
from sqlalchemy.orm import (
 DeclarativeBase,
 Mapped,
 Session,
 mapped_column,
 registry,
)
```

**What it does:** Pulls in three families of names.

**Why we need each:**

- `Column`, `Integer`, `String`, `Table` — these are **Core** schema primitives. They describe a database table without any Python class. We use them for the raw Core example and the classical ORM example.
- `create_engine`, `insert`, `select` — `create_engine` is the engine factory (canonical in Lesson 02). `insert` and `select` are **SQL expression constructors**: they build `INSERT` and `SELECT` statements as Python objects that can be rendered to SQL by a dialect. They are Core-level — they do not know about your ORM classes.
- `DeclarativeBase`, `Mapped`, `mapped_column` — the 2.x ORM declarative primitives. Canonical in Lesson 03. `DeclarativeBase` is the class your `Base` inherits from; `Mapped[T]` is the type annotation that drives column config; `mapped_column(...)` is the configuration wrapper.
- `Session` — the ORM's workspace. Canonical in Lesson 05.
- `registry` — the bridge between classical `Table` objects and Python classes. We need it for the classical ORM example below.

**Tip — Why import `Optional` from `typing` and then never use it?**

We imported it for completeness — many real models use `Mapped[Optional[int]]` to express "this column is nullable". (We will do that in Lesson 03.) We left it in the imports so you can copy this file as a starting point. If you run a linter, it will complain that `Optional` is unused; remove it if you like.


### Lines 12–19: Defining a Core `Table`

```python
metadata_obj = sqlalchemy_meta = __import__("sqlalchemy").MetaData()

users_table = Table(
 "users_core",
 metadata_obj,
 Column("id", Integer, primary_key=True),
 Column("email", String(255), unique=True, nullable=False),
)
```

**What it does:** Builds a `Table` object describing a `users_core` table with two columns: an integer primary key `id`, and a unique non-null `email` (a `VARCHAR(255)`).

**Why this is "Core":** A `Table` is a Python object that knows its name, its columns, and its constraints — but it has no concept of *your* Python classes. It is purely a description of a database object. When you pass it to `engine.connect()` and call `conn.execute(insert(users_table)...)`, the engine renders SQL like:

```sql
INSERT INTO users_core (email) VALUES (?)
```

and binds `?` to the value you provided. No Python class was involved at any point. This is the **SQL expression library** layer.

**What is `MetaData()`?**

A `MetaData` object is a **catalog**: a Python dict-like container that holds `Table` objects. It is the unit of "all the tables SQLAlchemy knows about in this process". When you call `Base.metadata.create_all(engine)`, SQLAlchemy iterates over every `Table` registered on that `MetaData` and emits `CREATE TABLE` for each one. Without a `MetaData`, your `Table` objects would be orphans with no place to register.


**Spot the smell: why is `__import__("sqlalchemy").MetaData()` an odd way to import `MetaData`?**

Answer: it is. We wrote it that way to avoid bloating the import block at the top with a name (`MetaData`) only used once in this teaching script. In production code you would write `from sqlalchemy import MetaData` at the top and use `MetaData()` here. The point being made: `MetaData` is part of the Core layer, not the ORM layer.


**Warning — Debugging: this script's `users_table` is registered on `metadata_obj`, not on `Base.metadata`, so `Base.metadata.create_all(engine)` silently skips it.**

Symptom: `OperationalError: (sqlite3.OperationalError) no such table: users_core` on the very first `conn.execute(insert(users_table).values(email=email))` in `main()`. The catalog `metadata_obj = MetaData()` is a *different* instance from `Base.metadata` (which `DeclarativeBase` allocates), and `create_all` iterates only the catalog it is called on. Two fixes (pick one): (a) unify the catalogs — pass `Base.metadata` into the `Table(...)` call so all three tables live on one catalog, or (b) call `create_all` twice — `metadata_obj.create_all(engine); Base.metadata.create_all(engine)`. Verify the diagnosis with `uv run python -c "from architecture_demo import Base, metadata_obj; print('base tables:', sorted(Base.metadata.tables)); print('meta tables:', sorted(metadata_obj.tables))"` and confirm `users_core` appears only in the second set until you unify the catalogs; cross-link to [[02-Engines-Connections-Pools]].


### Lines 22–24: The declarative `Base`

```python
class Base(DeclarativeBase):
 pass
```

**What it does:** Defines a class called `Base` that inherits from `DeclarativeBase`. The body is empty.

**Why this matters:** `DeclarativeBase` is the 2.x replacement for the legacy `declarative_base()` factory function. By inheriting from it, you get:

1. A `Base.metadata` — a `MetaData` instance shared by every model that inherits from `Base`. This is the catalog all your declarative models will be registered on.
2. A `Base.registry` — a `registry` instance that maps Python classes to `Table` objects. The registry is the glue between your class and the underlying Core `Table` SQLAlchemy auto-generates for you.
3. Class-body processing hooks: when you later write `class User(Base): id: Mapped[int] = mapped_column(...)`, the `DeclarativeBase` metaclass intercepts the assignment and uses the type annotation to build a `Column` object on a `Table` it then attaches to `Base.metadata`.

**This is the canonical 2.x pattern.** It is what every real SQLAlchemy application looks like. We will repeat it in Lesson 03 with the full `Boardly` model.

**Warning — Do not confuse `DeclarativeBase` with `declarative_base()`.**

The legacy factory `from sqlalchemy.orm import declarative_base; Base = declarative_base()` is still supported in 2.x for backwards compatibility, but it is the **old** API. New code should inherit from `DeclarativeBase`. They produce equivalent objects, but the class form is the only one that participates cleanly in PEP 695 type aliases, `Mapped[T]` typing, and modern IDE support. The old form will eventually be removed.


**Danger — Security: a `DeclarativeBase` subclass is a process-global catalog — never accept model definitions from untrusted input.**

The danger is in plugin systems that dynamically `type(name, (Base,), attrs)` from request-supplied JSON: a hostile payload can register a `Table` that mirrors a real one (`users`) with relaxed constraints (`unique=False`), and SQLAlchemy silently dedupes by `__tablename__` — whichever class registered first on `Base.metadata` is the canonical mapping, which is now attacker-controlled. The shadowed real-`User` class still imports, but `session.execute(select(User))` hydrates rows through the attacker's `__init__`/`__repr__`/`__setattr__` overrides — a code-execution primitive that survives logout/login because it lives in the catalog. Fix: never `type(...)` from input; if dynamic models are a real requirement (multi-tenant table-per-tenant schemas), use a `registry()` per tenant and bind each to its own `MetaData`; cross-link to [[07-Async-SQLAlchemy]] for the per-tenant `MetaData` pattern and to [[11-Authentication-and-Security/Threat-Model-First]].


### Lines 27–30: The declarative `UserDeclarative` model

```python
class UserDeclarative(Base):
 __tablename__ = "users_declarative"

 id: Mapped[int] = mapped_column(primary_key=True)
 email: Mapped[str] = mapped_column(String(255), unique=True)
```

**What it does:** Defines an ORM-mapped class `UserDeclarative` whose instances will represent rows in the `users_declarative` table.

**Why this is the canonical 2.x form, line by line:**

- `__tablename__ = "users_declarative"` — the class attribute that tells SQLAlchemy what to name the underlying `Table`. Without it, SQLAlchemy would have to derive the name from the class name (it does not, by default). Set it explicitly every time.
- `id: Mapped[int] = mapped_column(primary_key=True)` — `Mapped[int]` is a type annotation. `mapped_column(primary_key=True)` is the configuration. The annotation says "this attribute is an `int`"; the configuration says "and the column is the primary key." SQLAlchemy inspects both at class-creation time and builds a `Column(Integer, primary_key=True)` on the underlying `Table`.
- `email: Mapped[str] = mapped_column(String(255), unique=True)` — same pattern. The annotation is `Mapped[str]` (Python `str`); the configuration says "use a `VARCHAR(255)` column and add a `UNIQUE` constraint".

The whole point of the 2.x API is that **the type annotation is the source of truth**. If you write `email: Mapped[str]`, SQLAlchemy derives a default column type (`String` in this case, which becomes `VARCHAR` on Postgres). If you want a different SQL type, you override it in `mapped_column(String(255), ...)` — the annotation is still `Mapped[str]` because in Python it is a string.

**Tip — Read `Mapped[T]` as "this attribute is a `T` in Python and a SQL column underneath".**

Once you internalize that, the ORM stops feeling magic. `id: Mapped[int]` means "an `int` here, an `INTEGER` column there". `email: Mapped[str]` means "a `str` here, a `VARCHAR` column there". The full rules — `Optional[T]` for nullable, `list[Child]` for relationships — are in Lesson 03.


**Production reality: `Mapped[str]` derives `VARCHAR` and is the right default; `Mapped[str] = mapped_column(String(N))` only when you need a length check.**

In SQLAlchemy 2.1.5 the bare `Mapped[str]` annotation compiles to `VARCHAR` (PostgreSQL) or `TEXT` (modern SQLite, which dropped the 1-GB `TEXT` cap in 3.x) — both are variable-length with no DB-side cap. Adding `String(255)` inserts a length check; it does NOT improve performance or storage (PostgreSQL stores all `varchar` values identically internally), it only adds a runtime length-validation that throws `DataError` on overflow. Production teams that ship `varchar(255)` everywhere are paying a maintenance cost (every widening is a migration) for a check the application layer should do anyway. Verify with `uv run python -c "from architecture_demo import UserDeclarative; print(UserDeclarative.__table__.c.email.type)"` — expect `VARCHAR(255)`; then remove `String(255)` from the column declaration and re-run, expect uncapped `VARCHAR()`; cross-link to [[08-PostgreSQL/Types-UUID-Identity-JSONB]].


### Lines 33–39: The classical `UserClassical` mapping

```python
users_classical_table = Table(
 "users_classical",
 Base.metadata, # share the same MetaData as the declarative base
 Column("id", Integer, primary_key=True),
 Column("email", String(255), unique=True),
)


class UserClassical:
 pass # no attributes until the mapper attaches them


reg = registry(metadata=Base.metadata)
reg.map_imperatively(UserClassical, users_classical_table)
```

**What it does:** Builds a Core `Table` (lines 33–38), a plain Python class (lines 41–42), and uses the `registry` to map the class to the table (line 45). After line 45 runs, `UserClassical` is an ORM-mapped class, even though it was defined as a bare `class ... pass`.

**Why this is "classical" mapping and why you should avoid it:** Classical mapping predates `DeclarativeBase`. It works, but it has three disadvantages:

1. **No type annotations.** `UserClassical` is a bare `class` — there are no `Mapped[T]` annotations, so your IDE cannot autocomplete `user.email`, your type checker cannot catch `user.emaiL`, and your fellow engineers cannot read the class to discover its shape.
2. **The mapping is a side effect of the `map_imperatively` call.** Until that call runs, `UserClassical` is a useless empty class. After it runs, it is magically mapped. The class definition does not tell you this.
3. **The schema and the class live in different files.** The `Table` object can be in one module and the class in another. That sounds flexible; in practice it means the schema and the class drift apart silently.

Declarative 2.x mapping fixes all three: the type annotations are right there in the class body; the mapping happens at class-creation time (no separate `map_imperatively` call); the schema and the class are the same object.

**Warning — When you might still see classical mapping.**

Two real-world cases: (a) you are mapping a class to an existing database where the schema is owned by another team or another language; (b) you are integrating a class that you cannot modify (from a third-party library) into SQLAlchemy. In both cases, you cannot put `Mapped[T]` annotations on the class, so classical mapping is the escape hatch. For all new code, declarative 2.x is the right choice.


### Lines 48–54: The `main()` engine and `create_all`

```python
def main() -> None:
 engine = create_engine("sqlite:///:memory:", echo=False)
 Base.metadata.create_all(engine) # creates all three tables in one call
```

**What it does:** Creates an in-memory SQLite engine, then asks `Base.metadata` to emit `CREATE TABLE` for every `Table` it knows about — including the two declarative tables (`users_declarative`, `users_classical`) and the one raw Core table (`users_core`, which shares `Base.metadata` because we passed `Base.metadata` into its constructor on line 36).

**Why this is a teaching scaffold, not production code:** `Base.metadata.create_all(engine)` is a one-shot schema creation. It is great for tests and demos. It is **not** how production schemas evolve — for that, see [[09-Alembic-Migrations/00-Alembic-MOC]]. The reason: `create_all` only creates tables that do not already exist; it cannot add a column to an existing table, cannot rename a table, cannot migrate data. Alembic does all of that.

**Why in-memory SQLite (`sqlite:///:memory:`)?**

An in-memory SQLite database is created fresh in each process and disappears when the process exits. It is the fastest possible way to write a teaching demo — no Postgres install, no Docker, no cleanup. In Lesson 02 we will switch to a real Postgres URL (`postgresql+psycopg://...`), but the engine API is identical; only the URL changes.


**Warning — Debugging: `echo=True` is a teaching tool, not a logging strategy — production SQL logs go through Python `logging`.**

The symptom is `echo=True` committed to `boardly/db.py` "for visibility" and then a 10k-QPS service generating 30k lines of `INFO sqlalchemy.engine.Engine` per second, swamping the JSON log stream and tripling observability costs. In SQLAlchemy 2.1.5 `echo=True` toggles a *separate* Python logger (`sqlalchemy.engine.Engine`) that bypasses your structured logger; it also formats SQL as multi-line pretty-printed strings rather than single-line entries. Fix: never set `echo=True` in production; instead configure `logging.getLogger("sqlalchemy.engine").setLevel(logging.INFO)` and route it through the same JSON formatter as everything else. For query-level introspection in staging, use the SQLAlchemy event system (`event.listen(Engine, "before_cursor_execute", ...)` paired with `"after_cursor_execute"`) to emit one structured log per query with duration; cross-link to [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]] and [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]].


### Lines 56–60: A raw Core insert

```python
 with engine.connect() as conn:
 conn.execute(insert(users_table).values(email=email))
 conn.commit()
```

**What it does:** Opens a `Connection` from the engine, builds an `INSERT` statement, executes it, and commits the transaction.

**Why this is the Core API:** `engine.connect()` returns a `Connection` — the Core-level abstraction over a database connection. The `with` block is a context manager that closes the connection when the block exits. `conn.execute(...)` is the Core execution primitive; it accepts any SQL expression and returns a `CursorResult`. `conn.commit()` ends the transaction.

Three things to notice:

1. **No `Session`, no `add`, no objects.** This is raw SQL expression execution. SQLAlchemy rendered `INSERT INTO users_core (email) VALUES (?)` and bound `?` to `"ada@example.com"`. The fact that you wrote it as `insert(users_table).values(email=email)` in Python does not change the wire-level SQL.
2. **You had to commit explicitly.** The `Connection` runs in "transactional" mode by default in 2.x (it did not in 1.x). Without `conn.commit()`, the `INSERT` would be rolled back at the close of the `with` block. This is a deliberate change: in 2.x, every block of writes must commit explicitly, which makes transaction boundaries visible in the code.
3. **No identity tracking.** After `conn.execute(...)`, there is no Python object representing the new row. If you want it back, you have to `SELECT` it.

**Production reality: the 2.x `Connection` defaults to transactional mode — forgetting `conn.commit()` silently rolls back.**

This is a deliberate change from 1.x, where `Connection` ran in autobegin mode and committed implicitly. In 2.1.5 every `with engine.connect() as conn:` block that issues writes without an explicit `conn.commit()` issues a `ROLLBACK` on `__exit__`. The bug pattern: a junior engineer ports a 1.x script to 2.x, removes the `conn.commit()` lines because "they look redundant", and reports "the inserts work in tests but never persist". The fix is mechanical (a test that re-opens a connection and asserts the row exists), not static analysis — `ruff` and `mypy` will not flag the missing commit. For one-shot ETL scripts where you want the 1.x behaviour, opt back in explicitly with `engine = create_engine(url, execution_options={"isolation_level": "AUTOCOMMIT"})` — but only for one-shot scripts, never for service code; cross-link to [[02-Engines-Connections-Pools]].


### Lines 62–65: A declarative ORM insert

```python
 with Session(engine) as session:
 session.add(UserDeclarative(email=email))
 session.commit()
```

**What it does:** Opens a `Session`, creates an instance of `UserDeclarative`, adds it to the session, commits.

**Why this is the ORM API:** The `Session` is the ORM's workspace. Behind the scenes, when `session.commit()` runs:

1. The session inspects every object in its identity map and notes which have changed since they were loaded. `UserDeclarative(email=email)` is brand new — it was never loaded — so it is flagged for `INSERT`.
2. The session's `flush()` method (called automatically by `commit()`) builds the SQL `INSERT INTO users_declarative (email) VALUES (?)` and executes it via Core. This is the unit-of-work pattern in action.
3. The database assigns an auto-increment `id` to the new row. SQLAlchemy retrieves it (via `RETURNING` on Postgres, or `lastrowid` on SQLite) and writes it back onto the `UserDeclarative` instance's `id` attribute. After `commit()`, `user.id` is populated, even though you never set it.
4. The session emits `COMMIT` to finalize the transaction.

This is the value of the ORM: the application code reads like in-memory mutation; the persistence layer decides what SQL to run. The cost is the implicit I/O trap we will cover in Lesson 04 — touching a relationship can trigger a `SELECT` you did not ask for.

**Danger — Security: relying on a server-side `default` for a primary key is a TOCTOU window if the application reads the row back by `id` before `commit()`.**

The pattern: `User(email="ada@example.com")` in Python (no explicit `id`), `session.add(user)`, then `verify_email(user.id)` *before* `session.commit()`. If `verify_email` opens its own `Session` and queries by `user.id`, it returns `None` — the row has not been flushed, the server-side `gen_random_uuid()` has not been called, and `user.id` is `None` in the parent session. The application, thinking the row exists, proceeds to call `send_password_reset(user.id)` against a row the database has never seen. The fix is one of: (a) `session.flush()` after `add()` to materialise the `INSERT` and the server-side `default`, then read back; (b) prefer client-side UUIDs (`Mapped[uuid.UUID] = mapped_column(default=uuid.uuid4)`) so the `id` is known before any I/O; (c) assert `user.id is not None` *after* commit, never use the `id` before. Cross-link to [[07-Async-SQLAlchemy]] for the same trap under `AsyncSession` and to [[11-Authentication-and-Security/Threat-Model-First]].


### Lines 67–70: A classical ORM insert

```python
 with Session(engine) as session:
 session.add(UserClassical(email=email))
 session.commit()
```

**What it does:** The same as the declarative insert, but against the classically-mapped class.

**Why include this:** To prove the point that the API surface of the `Session` is identical regardless of how the class was mapped. The unit-of-work pattern does not care whether `UserDeclarative` got its `Table` via the declarative metaclass or via `registry.map_imperatively`. Both end up with a `Table` registered on `Base.metadata`. The session sees them identically.

The only difference between declarative and classical mapping is **authoring ergonomics**, not runtime behavior.

### Lines 72–82: Verification

```python
 with Session(engine) as session:
 for label, model in [
 ("core", users_table),
 ("declarative", UserDeclarative),
 ("classical", UserClassical),
 ]:
 stmt = select(model) if not isinstance(model, Table) else select(model)
 row = session.execute(stmt).first()
 print(f"{label:12s} -> {row}")
```

**What it does:** Issues a `SELECT *` against each of the three tables and prints the first row.

**Why the awkward `if not isinstance(model, Table) else select(model)`:** A teaching crutch — both branches are identical because `select(model)` accepts both a `Table` (Core) and an ORM class. We left the conditional in to flag that fact: `select()` is polymorphic across the Core/ORM boundary. (In Lesson 06 we will prefer `select(UserDeclarative)` and chain `.scalars()` to get ORM instances back rather than raw rows.)

## Execution Trace

Run the script:

```bash
uv run python architecture_demo.py
```

Expected output (formatting may vary slightly by SQLAlchemy version):

```
core -> ('ada@example.com',)
declarative -> UserDeclarative(id=1, email='ada@example.com')
classical -> UserClassical(id=1, email='ada@example.com')
```

Three observations:

1. The Core row is a tuple. There is no `User` object; just `(email,)`. If you wanted a richer object, you would map one.
2. The declarative row is a `UserDeclarative` instance. SQLAlchemy's `__repr__` (auto-generated by `DeclarativeBase`) prints the class name and the mapped attributes.
3. The classical row is a `UserClassical` instance, despite the class having an empty body in source. The mapper attached `id` and `email` attributes at runtime.

```mermaid
flowchart TD
 DB[("Database<br/>PostgreSQL / SQLite / MySQL")]

 subgraph Dialect["Dialect layer"]
 D1["Translates SQLAlchemy SQL<br/>to the database's dialect"]
 D2["Parses DB-specific types<br/>and error codes"]
 end

 subgraph Core["Core (SQL expression library)"]
 C1["Engine, Connection, Transaction"]
 C2["schema.Table, Column, select/insert/update/delete"]
 C3["Result rows as tuples or named tuples"]
 end

 subgraph ORM["ORM (object-relational mapper)"]
 O1["DeclarativeBase + Mapped classes"]
 O2["Session: identity map + unit-of-work"]
 O3["relationship(), loading strategies"]
 end

 ORM --> Core
 Core --> Dialect
 Dialect --> DB

 style ORM fill:#cce5ff,stroke:#007bff
 style Core fill:#d4edda,stroke:#28a745
 style Dialect fill:#fff3cd,stroke:#ffc107
 style DB fill:#f8d7da,stroke:#dc3545
```

The three inserts in `main()` all hit the same `Database` node, via the same `Engine`. The Core insert bypassed the `ORM` box; the declarative and classical inserts went through it. The unit-of-work pattern lives in the `Session: identity map + unit-of-work` node — and that is what makes the ORM inserts feel different from the Core insert.

## The Layer Cake, Explained

Time to slow down and explain each layer of the diagram above. This is the conceptual core of the lesson.

### The Dialect layer

The dialect is the translator between SQLAlchemy's SQL expression objects and the wire protocol of a specific database. PostgreSQL, MySQL, SQLite, Oracle, MSSQL — each speaks a slightly different SQL. Quote styles differ (`"name"` vs `` `name` `` vs `[name]`). Parameter placeholders differ (`%s` vs `:name` vs `?` vs `@p1`). Type names differ (`VARCHAR` vs `TEXT` vs `CLOB`). The dialect normalizes all of this.

You almost never touch the dialect directly. You choose one when you write the engine URL:

- `postgresql+psycopg://...` — psycopg 3 driver, sync.
- `postgresql+asyncpg://...` — asyncpg driver, async.
- `sqlite:///:memory:` — Python's built-in `sqlite3` driver, sync.
- `sqlite+aiosqlite:///:memory:` — `aiosqlite` driver, async.
- `mysql+pymysql://...` — `pymysql` driver, sync.
- `mysql+aiomysql://...` — `aiomysql` driver, async.

The part before the `+` is the dialect (`postgresql`, `sqlite`, `mysql`). The part after is the driver. If you omit the `+driver` part, SQLAlchemy picks a default driver for the dialect (`psycopg` for `postgresql` in 2.x; `sqlite3` for `sqlite`).

**Tip — Why the dialect layer matters even if you never write one.**

Two reasons: (a) cross-dialect code is possible because the dialect normalizes. You can write `select(User)` against SQLite in dev and Postgres in prod and the same Python code works. (b) Sometimes you need a database-specific feature (e.g., Postgres `JSONB`, MySQL `ON DUPLICATE KEY UPDATE`). For those, SQLAlchemy gives you dialect-specific types and inserts; we cover `JSONB` in [[08-PostgreSQL/Types-UUID-Identity-JSONB|JSONB and Array Columns]].


### The Core layer

Core is the SQL expression library. It is "the part of SQLAlchemy that builds SQL but does not know about your classes." Core has three responsibilities:

1. **Engine, Connection, Transaction** — the connection-management layer. The `Engine` is a factory for `Connection` objects; the `Connection` runs SQL; transactions are explicit (`BEGIN`/`COMMIT`/`ROLLBACK`). Canonical in Lesson 02.
2. **Schema** — `Table`, `Column`, `MetaData`, `Index`, `ForeignKey`. These objects describe your database schema in Python. The ORM uses them under the hood; you can use them directly if you bypass the ORM.
3. **SQL expression constructors** — `select()`, `insert()`, `update()`, `delete()`, `text()`. These build SQL statements as Python objects that can be rendered to SQL by a dialect and executed by an engine.

The key insight: **Core is not the ORM.** Core has no notion of your Python classes. You can use Core entirely without the ORM (many analytics workloads do). The ORM uses Core as its foundation, but Core is independently useful.

### The ORM layer

The ORM sits on top of Core. It adds:

1. **Mapped classes** — your Python classes (`UserDeclarative`, `UserClassical` in the demo) that represent rows.
2. **The `Session`** — the unit-of-work workspace (canonical in Lesson 05).
3. **`relationship()`** — the mechanism for connecting mapped classes to each other (Lesson 04).
4. **Loading strategies** — `selectinload`, `joinedload`, etc. — how the ORM decides which `SELECT`s to issue when you traverse a relationship (Lesson 04).

Every ORM operation eventually emits Core-level SQL. The ORM's job is to figure out what SQL to emit, given a graph of in-memory objects that have been mutated. The Core's job is to render and execute that SQL.

Why split the ORM from Core at all, instead of one unified library? Because not every workload wants Python objects for every row. An analytics job that streams a million rows to a CSV wants fast SQL execution, not a million `User` instances that the garbage collector then has to reclaim. The data scientist running that job does not need an ORM and should not pay for one. By keeping Core separate, SQLAlchemy lets the analytics workload use `engine.connect()` + `select()` + `Result` and stop there, never paying for the ORM's identity-map bookkeeping. The application workload, by contrast, builds on top of Core with the ORM, paying for the bookkeeping because the bookkeeping is what makes `user.posts.append(p)` actually emit the right `INSERT` at commit time. The two-layer architecture is a tax on the ORM user (slightly slower) and a gift to the non-ORM user (much faster).

### The Session (the unit-of-work implementation)

The `Session` is the ORM's workspace. It owns:

- A **transaction** — every session is, from creation to close, a wrapper around a database transaction. `commit()` ends the transaction and starts a new one. `rollback()` aborts and starts a new one.
- An **identity map** — a `dict` keyed by `(mapper, primary_key)` that ensures within one session, one row in the database maps to one Python object.
- A **new-objects list** — objects you `add()`'d but not yet flushed. They become `INSERT`s at flush time.
- A **dirty-objects list** — objects whose attributes have changed since they were loaded. They become `UPDATE`s at flush time.
- A **deleted-objects list** — objects you `delete()`'d. They become `DELETE`s at flush time.

The unit-of-work pattern is the orchestration: at `flush()` (called automatically by `commit()`), the session inspects each of those lists, builds the appropriate `INSERT`/`UPDATE`/`DELETE` via Core, executes them in dependency order, and writes back any database-generated values (auto-increment PKs, default timestamps) onto the original Python objects.

**If the session is the unit-of-work, what is the engine?**

The engine is the **connection factory**. It owns the pool and knows how to create a new connection. The session borrows connections from the engine as needed. There is exactly one engine per database URL per process (in normal use); there are many sessions per process (typically one per request).


**Warning — Debugging: `DetachedInstanceError` is the canonical symptom of touching a detached object — read it as "you closed the session too early."**

The symptom: a route handler does `with SessionLocal() as s: user = s.get(User, 42)` inside the `with`, returns the `user` object to the response serialiser, and the serialiser touches `user.email` *after* the `with` block closed — SQLAlchemy throws `DetachedInstanceError: Instance <User at 0x...> is not bound to a Session; attribute refresh operation cannot proceed`. The diagnosis: the session's identity map is gone (the `with` block exited), so any attribute that was expired (`expire_on_commit=True` is the default) cannot be re-fetched. Three fixes: (a) `session.expunge(user)` before the `with` exits — the object is detached but no longer expired-on-touch, so the loaded attributes remain accessible; (b) `SessionLocal(engine, expire_on_commit=False)` to disable expiration globally (the trade-off is stale reads within long sessions — Lesson 05); (c) serialise inside the `with` block — use `sqlalchemy.inspect(user).attrs.keys()` to build the dict explicitly, not `user.__dict__`; cross-link to [[05-Session-and-Transaction-Management]].


## The Unit-of-Work Pattern, Deepened

The unit-of-work pattern (Martin Fowler, *Patterns of Enterprise Application Architecture*, 2002) is the central idea behind the SQLAlchemy `Session`. Instead of writing SQL per change, you:

1. Load a graph of objects into memory.
2. Mutate them as if they were plain Python objects.
3. At a single flush, the session diffs each object against its original state and emits a minimal set of `INSERT`/`UPDATE`/`DELETE` statements.

The pattern's value: **the application code reads like in-memory mutation; the persistence layer decides what SQL to run.** Consider this `Boardly` snippet:

```python
with Session(engine) as session:
 project = session.get(Project, 42)
 project.name = "Q4 launch"
 project.tasks.append(Task(title="ship the demo"))
 session.commit()
```

Read it as: "load project 42, change its name, add a task to it, save." The session translates that intent into:

```sql
UPDATE projects SET name = ? WHERE id = 42;
INSERT INTO tasks (title, project_id) VALUES (?, 42);
COMMIT;
```

The application code did not write either statement. It just mutated objects. The unit-of-work translated. The downside — and it is a real one — is that the pattern **hides I/O**. If you forget that touching a relationship can trigger a `SELECT`, the unit-of-work becomes a footgun. That is the same trap that bites in async; see Lesson 07.

**Where the name "unit of work" comes from.**

Fowler's pattern catalog. The "unit of work" is the set of changes you intend to commit together — either all of them succeed (commit), or none of them does (rollback). The session is the in-memory representation of that unit, plus the mechanism for flushing it to the database. The pattern predates SQLAlchemy — it appears in JDO, Hibernate, EclipseLink, and many others — but SQLAlchemy's implementation is the most influential in the Python world.


## The Identity Map, Deepened

The identity map is a `dict` internal to a `Session`, keyed by `(mapper, primary_key)`. It guarantees that within a session, **one row in the database maps to one Python object**.

```python
with Session(engine) as s:
 a = s.get(User, 42) # SELECT; caches User#42 under (User, 42)
 b = s.get(User, 42) # no SELECT — returns the same object
 assert a is b # True: identity, not equality
```

Without the identity map, line 3 would issue a second `SELECT` and return a *new* Python object representing the same database row. Mutations to `a` and mutations to `b` would silently diverge. The identity map is what prevents this.

**Warning — The identity map is per-session, not per-process.**

Two sessions in the same process do not share an identity map. If you load User#42 in `session_a` and User#42 in `session_b`, you get two distinct Python objects. Mutating one does not mutate the other. This is by design: a per-process identity map would be a global mutable cache, which is a concurrency bug waiting to happen. The session is the unit of isolation. We will revisit this in Lesson 05 when we discuss why sessions are not thread-safe.


**Student asks: if the identity map means `a is b` for the same row in the same session, why does my second `s.get(User, 42)` still sometimes issue a `SELECT`?**

Because of expiration. After `s.commit()` (with `expire_on_commit=True`, the default), every cached instance is *expired* — its attribute values are no longer cached, only the primary key. The next time you touch any attribute (including by `s.get(User, 42)`), SQLAlchemy re-issues a `SELECT` to refresh the values from the database. The Python object is still the same instance (the identity map is intact), but the attribute reads cause a refresh. This is why "I just committed, why is `s.get` going back to the database?" trips up every newcomer. You can disable it with `Session(engine, expire_on_commit=False)` — Lesson 05 ([[05-Session-and-Transaction-Management]]) covers the trade-off in detail.


**Production reality: the per-session identity map is a concurrency primitive, not a cache — never share it across requests.**

The most common pattern in legacy SQLAlchemy codebases is the module-level `session = Session(engine)` "for convenience", used by every request handler. The identity map then becomes a process-wide cache that returns stale objects across requests: request A loads `User#42`, request B updates `User#42` and commits, request A re-loads `User#42` and gets its *own* previously-cached instance (now stale). Worse, two concurrent requests each `add()` an object — request A's `commit()` writes both objects, including request B's not-yet-ready row. The unit-of-work pattern's whole reason for existence is that the session is the *unit of isolation*; flattening it to a global makes the session a data race. Fix: `SessionLocal = sessionmaker(engine)` (factory, not instance) and `with SessionLocal() as s: ...` (scoped, per request) in every handler; for FastAPI, the canonical pattern is a `yield`-dependency that opens and closes the session, covered in [[03-FastAPI-Core/Dependency-Injection]] and [[05-Session-and-Transaction-Management]]; cross-link to [[03-FastAPI-Core/Application-and-Lifespan]].


## Declarative vs Classical Mapping

We covered both above; here is the executive summary:

| Property | Declarative 2.x | Classical |
|---|---|---|
| Source of schema | Annotations on the class (`Mapped[T]`, `mapped_column(...)`) | A separate `Table(...)` object |
| Mapping happens at | Class creation time (metaclass) | `registry.map_imperatively(cls, table)` call |
| Type hints available | Yes — `Mapped[T]` | No |
| IDE autocompletion | Works | Does not work |
| Use when | Always (new code) | You cannot modify the class (third-party, legacy) |

The 2.x ORM is unambiguous: declarative is the primary API. Classical is supported for the two escape-hatch cases above. If you find yourself writing classical mapping in new code, stop and ask why.

## Sync vs Async (Preview)

SQLAlchemy 2.x has both sync and async APIs, and they are designed to be near-identical. The same model class works in both. The same `select()` statement works in both. The differences are:

- **Engine**: `create_engine(url)` (sync) vs `create_async_engine(url)` (async).
- **Session**: `Session(engine)` (sync) vs `AsyncSession(engine)` (async).
- **Factory**: `sessionmaker(engine)` vs `async_sessionmaker(engine)`.
- **Execution**: `session.execute(stmt)` returns a `Result` synchronously; `await session.execute(stmt)` returns a `Result` asynchronously.

**Danger — Async is not "sync but faster."**

The biggest misconception about async SQLAlchemy is that switching to `AsyncSession` makes your database calls non-blocking. It does not. `await session.execute(stmt)` still issues a `SELECT` to the database and waits for the response. The difference is **what** is blocked while waiting: in sync, the entire thread is blocked; in async, only the coroutine is suspended and the event loop can run other coroutines. If your database call takes 500 ms, both will report 500 ms latency for that query. The async advantage is concurrency, not latency. We cover this in detail in Lesson 07.


Sync vs async is decided at the engine level. Once you pick, you stay in that lane. Mixing sync sessions and async sessions in the same request handler is a recipe for `MissingGreenlet` errors (Lesson 07). Lesson 02 will use sync engines; Lesson 07 will switch `Boardly` to async.

```mermaid
flowchart LR
 subgraph Sync["Sync (thread per request)"]
 S1["Request handler"] --> S2["Session.execute()"]
 S2 --> S3["Thread blocked on I/O"]
 S3 --> S4["DB returns"]
 S4 --> S5["Resume handler"]
 end

 subgraph Async["Async (event loop)"]
 A1["Request handler"] --> A2["await session.execute()"]
 A2 --> A3["Coroutine suspended; loop runs others"]
 A3 --> A4["DB returns"]
 A4 --> A5["Resume coroutine"]
 end

 style Sync fill:#d4edda,stroke:#28a745
 style Async fill:#cce5ff,stroke:#007bff
 style S3 fill:#f8d7da,stroke:#dc3545
 style A3 fill:#fff3cd,stroke:#ffc107
```

In the sync lane (left), while the request waits for the database, the worker thread is stuck — it cannot handle other requests. In the async lane (right), while the request waits for the database, the event loop is free to handle other requests. **This is the only meaningful difference between sync and async SQLAlchemy** — everything else (sessions, transactions, queries, models) is identical.

**Danger — Security: mixing a sync `Session` into an `async def` handler leaks connections from the pool and can deadlock the event loop.**

The symptom: a FastAPI service runs handlers as `async def`, the database layer is still sync (`Session(engine)` with `postgresql+psycopg://`), and under load the connection pool is exhausted within minutes — `TimeoutError: QueuePool limit of size 5 overflow 10 reached` — while `pg_stat_activity` shows 15 idle connections held by the Python process. The diagnosis: the sync `Session.execute()` blocks the event-loop thread, so while one request waits 500 ms on the database, *no other request can run* — but every other request has already entered `async def` and opened its own sync `Session` (borrowing a connection) before yielding. The pool is exhausted by requests waiting for the one thread, which is also a DoS amplifier: an attacker who triggers N concurrent slow queries can wedge the entire service. Fix: either (a) go async end-to-end (Lesson 07) with `AsyncSession` + `create_async_engine` + `postgresql+asyncpg://`, or (b) declare handlers as `def` (not `async def`) so FastAPI runs them in a threadpool where blocking is acceptable — never mix. Verify the pool shape with `uv run python -c "from sqlalchemy import create_engine; e = create_engine('sqlite://'); print(e.pool.__class__.__name__, 'size=', e.pool.size(), 'checkedout=', e.pool.checkedout())"`; cross-link to [[07-Async-SQLAlchemy]] and [[10-Async-Python/Event-Loop-and-Coroutines]].


## Common Mistakes

### Mistake 1: Treating the ORM as "Python objects that happen to be saved"

```python
# WRONG mental model
user = User(email="ada@example.com") # not in any session
user.email = "new@example.com" # mutation in memory
# user is never persisted; no session ever knew about it
```

**Symptom:** You "save" a user, restart the server, and the change is gone.

**Why:** A mapped class instance is just a Python object until it is `add()`'d to a session and `commit()`'d. Without a session, mutations have no effect on the database. The ORM does not auto-track every instance of every mapped class; that would be a global mutable cache.

**Fix:** Always go through a session.

```python
with Session(engine) as session:
 user = User(email="ada@example.com")
 session.add(user)
 user.email = "new@example.com" # OK — session is tracking user
 session.commit()
```

### Mistake 2: Using Core operations and expecting ORM features

```python
# WRONG
with engine.connect() as conn:
 conn.execute(insert(users_table).values(email="ada@example.com"))
 conn.commit()

# Then later, in another block:
with Session(engine) as session:
 user = session.execute(select(UserDeclarative).where(UserDeclarative.email == "ada@example.com")).scalar_one_or_none()
 # user exists, but the Core insert did not update any session's identity map
```

**Symptom:** Inserts via Core do not appear in any session's identity map, so subsequent session-level queries re-fetch from the database (which is fine — they will find the row — but the identity-map optimization is lost).

**Why:** Core and ORM are different layers. The session's identity map is updated only by ORM operations (`add`, `execute(select(...))`, `get`). Core writes are visible to the database but invisible to the session's in-memory cache.

**Fix:** Pick a lane. If you are using the ORM, use it for writes too. If you have a hot path that needs Core (bulk inserts, raw SQL), do not expect ORM features around it. We cover the trade-offs in Lesson 06 and Lesson 08.

### Mistake 3: Treating `Session` as a global singleton

```python
# WRONG
session = Session(engine) # module-level global

def create_user(email: str) -> User:
 user = User(email=email)
 session.add(user)
 session.commit()
 return user
```

**Symptom:** Concurrent requests corrupt each other's state. Two requests each call `create_user`; one's commit accidentally includes the other's pending changes. Identity-map collisions cause bizarre "object already in another session" errors.

**Why:** Sessions are not thread-safe and not task-safe. A session holds a transaction; sharing it across requests means sharing a transaction, which means one request's commit can include another request's changes.

**Fix:** One session per request. Use a `sessionmaker` (Lesson 05) to construct sessions on demand; never share one.

```python
SessionLocal = sessionmaker(engine, expire_on_commit=False)

def create_user(email: str) -> User:
 with SessionLocal() as session:
 user = User(email=email)
 session.add(user)
 session.commit()
 session.refresh(user)
 return user
```

### Mistake 4: Mixing sync and async in the same request

```python
# WRONG
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession

sync_engine = create_engine("postgresql+psycopg://...")
async_engine = create_async_engine("postgresql+asyncpg://...")

async def handler():
 async with AsyncSession(async_engine) as session:
 # ... some async work ...
 sync_session = Session(sync_engine) # WRONG — different driver, different pool
 sync_session.execute(...)
```

**Symptom:** `MissingGreenlet` errors, `InterfaceError`, or mysterious connection leaks.

**Why:** Sync and async drivers speak different wire protocols. The sync engine's pool cannot be safely accessed from an async context, and vice versa. Mixing them invites data races in the pool itself.

**Fix:** Pick one. For FastAPI services, async end-to-end is the modern default (Lesson 07). If you have a legacy sync engine, do not let async code touch it; run the sync engine in a threadpool via `asyncio.to_thread(...)` if you must call it from an async handler.

### Mistake 5: Treating the ORM as a "SQL replacement"

```python
# WRONG mental model
# "I shouldn't need to know SQL because the ORM handles it"
```

**Symptom:** N+1 query patterns in production; mysterious 1000-ms latency on endpoints that should be 10 ms; queries that worked fine in dev falling over at scale.

**Why:** The ORM builds SQL for you, but it does not build *good* SQL for you. It builds the SQL implied by your object traversals. If you traverse `for project in projects: print(project.owner.email)`, the ORM issues one `SELECT` for the projects, then N `SELECT`s for the owners — one per project. That is the N+1 trap, and it is the most common production bug in ORM codebases. Lesson 04 covers it in detail.

**Fix:** Read [[06-SQL-Fundamentals/00-SQL-MOC]]. Learn to read `EXPLAIN ANALYZE`. Inspect the SQL SQLAlchemy generates (`echo=True` on the engine, Lesson 02). The ORM is not a substitute for SQL knowledge; it is a productivity layer on top of it.

## Engineering Trade-Offs

### Core vs ORM: when to drop down

Most of your application code will use the ORM. But some patterns call for Core:

- **Bulk inserts.** `insert(users_table).values([row1, row2, ...])` executed via Core is dramatically faster than `session.add_all(...)` for thousands of rows, because the session has to track each object for the identity map.
- **ETL pipelines.** A read-transform-write loop where you do not need identity tracking — the rows are not "live objects" in the application, they are data moving through a pipeline.
- **Reporting queries.** Read-only aggregations where the ORM's overhead does not buy you anything. Use `select(table.c.col1, func.count()).group_by(...)` via Core, fetch tuples, format the report.

The cost of dropping to Core is losing the ORM's identity map and the unit-of-work. For one-shot scripts, that is fine. For long-running application code, you want them.

### Declarative vs classical

Declarative is the default. Classical is the escape hatch. There is no third option in 2.x — `declarative_base()` is just an alternate spelling of `class Base(DeclarativeBase)`.

### Sync vs async

Sync is the right default for command-line scripts, batch jobs, and small APIs where you will not benefit from concurrency. Async is the right default for FastAPI services with hundreds of concurrent connections, because the FastAPI request-handling layer is itself async — running blocking DB calls inside `async def` handlers blocks the event loop and undoes the async advantage. Lesson 07 covers the full trade-off matrix.

**Tip — A pragmatic default for FastAPI services.**

If your service is **I/O-bound** (most CRUD APIs are) and uses async-native drivers (`asyncpg`, `aiosqlite`, `aiomysql`), use async SQLAlchemy end-to-end. If your service is **CPU-bound** (heavy computation per request) or has a legacy sync driver you cannot replace, use sync SQLAlchemy and run request handlers as `def` (not `async def`) — FastAPI will run them in a threadpool. Never mix.


**Student asks: I read that "the ORM is magic" — how much of the magic is real, and how much is just a feeling engineers have when they do not understand it?**

Almost none of it is magic; almost all of it is the unit-of-work pattern hiding I/O. The five things that surprise engineers new to SQLAlchemy — and all five are explained by the unit-of-work, not by magic. **(1) "I changed an attribute, no `UPDATE` was issued."** The session batches writes until flush; the change is in the dirty list, not on the wire yet. **(2) "I queried `User#42` twice and got the same object, no `SELECT` the second time."** The identity map: same session, same PK, same Python object. **(3) "I committed and my object's attributes are stale."** `expire_on_commit=True` (the default) marks every attribute expired; the next read re-fetches. **(4) "I accessed `project.owner.email` and the SQL log shows an extra `SELECT`."** Lazy loading: the `relationship()` was not eager-loaded, so the access triggers a fresh fetch. **(5) "I tried to access `project.owner` after the session closed and got `DetachedInstanceError`."** Detached objects cannot lazy-load — there is no session to issue the `SELECT`. Every one of these is a documented, named mechanism; none is magic. The "ORM is magic" reputation is, almost without exception, the sound of an engineer who has not yet read Lesson 05 (Session and Transaction Management). Once you do, the ORM stops feeling magical and starts feeling predictable — which is the goal of this whole section.


## Exercises

**Tip — The 20-minute rule**

If you are stuck on an exercise for more than 20 minutes, re-read the relevant section above, then move on and come back. Learning is not linear.


**Exercise 1 — Run the demo.** Save the script above as `architecture_demo.py`, run it, and confirm the output matches. Then change `echo=False` to `echo=True` and re-run. Read the SQL SQLAlchemy generates. You will see the `CREATE TABLE`, the three `INSERT`s, and the three `SELECT`s.

**Exercise 2 — Add a column.** Add `name: Mapped[str] = mapped_column(String(100))` to `UserDeclarative`. Update the inserts to set `name="Ada"`. Re-run. Observe that the `INSERT` now includes the `name` column. (You do not need to migrate the in-memory database; it is fresh on every run.)

**Exercise 3 — Verify the identity map.** Add this snippet at the end of `main()`:

```python
with Session(engine) as session:
 a = session.get(UserDeclarative, 1)
 b = session.get(UserDeclarative, 1)
 print(f"a is b: {a is b}") # expect True
 print(f"a is not b: {a is not b}")
```

Run it. Confirm `a is b` is `True`. Then break it: do the two `get` calls in two separate `with Session(engine)` blocks. Confirm `a is not b` is `True` — different sessions, different objects.

**Exercise 4 — Compare sync and async.** Convert the script to async: replace `create_engine` with `create_async_engine`, `Session` with `AsyncSession`, `engine.connect()` with `async with engine.connect()`, and `conn.execute(...)` with `await conn.execute(...)`. (You will also need `aiosqlite` — `uv add aiosqlite`.) Run it with `uv run python architecture_demo_async.py`. Confirm the output is identical to the sync version.

**Exercise 5 — Spot the bug.** This snippet claims to "insert and commit a user." What is wrong?

```python
engine = create_engine("sqlite:///:memory:")
user = UserDeclarative(email="ada@example.com")
user.email = "ada2@example.com"
# engine never used; session never opened
```

(Answer: nothing is committed. The `UserDeclarative` instance is just a Python object — it was never added to a session, never committed. Restart the process and the row is gone. See Mistake 1.)

**Exercise 6 — Sketch the layer cake.** From memory, draw the four-layer SQLAlchemy architecture (Dialect, Core, ORM, Session) and label which layer handles each of: parameter binding, the identity map, `Table` objects, `DeclarativeBase`, the connection pool, `select()`. Check your answers against the diagram above.

**Exercise 7 — Reproduce the catalog-split bug.** Save the demo, run `uv run python architecture_demo.py`, and observe the `OperationalError: (sqlite3.OperationalError) no such table: users_core`. Then fix it by passing `Base.metadata` into the `users_table = Table(...)` call instead of `metadata_obj`. Re-run; expect the three-row output that the lesson advertises. Confirm the diagnosis with `uv run python -c "from architecture_demo import Base, metadata_obj; print('base tables:', sorted(Base.metadata.tables)); print('meta tables:', sorted(metadata_obj.tables))"` — `users_core` should appear in `base tables` only after the fix.

**Exercise 8 — Inspect `Mapped` derivation.** Run `uv run python -c "from architecture_demo import UserDeclarative; col = UserDeclarative.__table__.c.email; print('name=', col.name, 'type=', col.type, 'nullable=', col.nullable)"` and confirm `type=VARCHAR(255) nullable=False`. Then remove `String(255)` from the `email` mapped column (leave only `Mapped[str]` with `unique=True`), re-run the same inspection command, and confirm the type drops to uncapped `VARCHAR`. Verify the unique constraint still compiles with `uv run python -c "from architecture_demo import UserDeclarative; from sqlalchemy import UniqueConstraint; print([c for c in UserDeclarative.__table__.constraints if isinstance(c, UniqueConstraint)])"`.

**Exercise 9 — SQL logging the production way.** Replace `echo=False` with `echo=True` in `architecture_demo.py` and run `uv run python architecture_demo.py 2>sql.log`. Inspect `sql.log`: expect one `CREATE TABLE` block, three `INSERT` blocks, and three `SELECT` blocks, pretty-printed across multiple lines. Then revert `echo` to `False` and route the same output through Python `logging` instead: `uv run python -c "import logging; logging.basicConfig(level=logging.INFO, format='%(name)s %(levelname)s %(message)s'); logging.getLogger('sqlalchemy.engine').setLevel(logging.INFO); import architecture_demo; architecture_demo.main()"`. Confirm the two outputs are equivalent in content; the structured-logging version is what you would ship to a JSON sink in production. Cross-link to [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]].

**Exercise 10 — Surface `SAWarning` as errors.** Run `uv run python -W error::sqlalchemy.exc.SAWarning architecture_demo.py` and confirm the script exits cleanly (zero warnings). Then introduce a deliberate warning: change `email: Mapped[str] = mapped_column(String(255), unique=True)` to `email: Mapped[Optional[str]] = mapped_column(String(255), unique=True, nullable=True)` (a nullable `Mapped[Optional[str]]` combined with `nullable=True` is redundant under 2.1.5 strict typing and emits a `SAWarning`). Re-run with `uv run python -W error::sqlalchemy.exc.SAWarning architecture_demo.py; echo "exit=$?"` — expect non-zero exit and a traceback pointing at the redundant `nullable`. The pattern `python -W error::sqlalchemy.exc.SAWarning` is the canonical way to make SQLAlchemy deprecation warnings fail in CI before they break you in production.

**Exercise 11 — Identity map across sessions.** Append the following snippet at the end of `main()`:

```python
with Session(engine) as s1:
    a = s1.get(UserDeclarative, 1)
with Session(engine) as s2:
    b = s2.get(UserDeclarative, 1)
print("a is b:", a is b)
print("a.email:", a.email)
```

Run `uv run python architecture_demo.py`. Expect `a is b: False` (different sessions, different objects) and `a.email: ada@example.com` (the attribute was loaded before `s1` closed, so the detached object still has the value). Then add a `name` column, set it on insert, and after closing `s1` try `print(a.name)` — depending on `expire_on_commit`, expect either the value or `DetachedInstanceError`. Verify the cause with `uv run python -c "from sqlalchemy.orm import Session; import inspect; print(inspect.signature(Session.__init__))"` and confirm `expire_on_commit` defaults to `True`. Cross-link to [[05-Session-and-Transaction-Management]].

## Verification

Run the demo:

```bash
uv run python architecture_demo.py
```

Expected output (lines may be in a slightly different order if your SQLAlchemy version changed iteration order):

```
core -> ('ada@example.com',)
declarative -> UserDeclarative(id=1, email='ada@example.com')
classical -> UserClassical(id=1, email='ada@example.com')
```

If you see all three lines, you have successfully:
- Created an engine against in-memory SQLite.
- Registered three tables on `Base.metadata`.
- Issued `CREATE TABLE` for all three via `Base.metadata.create_all(engine)`.
- Inserted one row into each table using three different SQLAlchemy APIs.
- Verified the rows are there with a `SELECT`.

That is the entire lesson in one script. The rest of the section deepens each piece.

## Previously Learned Here

These concepts were taught in earlier lessons. We link back instead of re-explaining:

- **Type hints and `Annotated`** — [[01-Python-Foundations/Type-Hints-and-Annotations]]. The 2.x ORM is built on type annotations; `Mapped[T]` is a typing primitive.
- **Context managers** — [[01-Python-Foundations/Iterators-Generators-Context-Managers]]. `Session` and `Connection` are both used as context managers. The async equivalents (`AsyncSession`, `AsyncConnection`) use `async with`.
- **Exceptions** — [[01-Python-Foundations/Exceptions-Done-Right]]. `IntegrityError`, `NoResultFound`, `MissingGreenlet` all inherit from this baseline. Lesson 05 covers SQLAlchemy's exception hierarchy in detail.
- **Relational model** — [[06-SQL-Fundamentals/Relational-Model-and-Constraints]]. You should already be comfortable with tables, columns, primary keys, foreign keys, and constraints. The SQLAlchemy lessons assume you can read `CREATE TABLE`.
- **Transactions** — [[06-SQL-Fundamentals/Transactions-Isolation-Locks]]. The session is a transaction. We will say `commit()` and `rollback()` a hundred times before this section is over.
- **SQL injection** — [[06-SQL-Fundamentals/SQL-Injection-and-Parameterized-Queries]]. The ORM's defense is bound parameters. We cover the `text()` escape hatch in Lesson 06.

## What's Next

In [[02-Engines-Connections-Pools]] we open the engine and the connection pool. You will:

- Read a SQLAlchemy URL (`postgresql+psycopg://user:pass@host:5432/db`) and explain every part.
- Build `boardly/db.py` — the engine factory for the `Boardly` application.
- Configure the connection pool: `pool_size`, `max_overflow`, `pool_timeout`, `pool_recycle`, `pre_ping`.
- Open a `Connection` from the engine, run a raw SQL query with `text()`, and read the result.
- Choose between `QueuePool` (the default, for stateful services) and `NullPool` (for serverless / lambda).
- Run the code against a real Postgres instance (or an in-memory SQLite for the demo).

By the end of Lesson 02, you will have a runnable `Boardly` engine and the canonical `Engine` and `Connection pool` concepts registered to your name.

## Sources

- **SQLAlchemy 2.x documentation — Overview** — <https://docs.sqlalchemy.org/en/21/intro.html> — accessed 2026-10-19 — the canonical architecture overview.
- **SQLAlchemy 2.x — Glossary** — <https://docs.sqlalchemy.org/en/21/glossary.html> — accessed 2026-10-19 — definitions of "Core", "ORM", "unit-of-work", "identity map".
- **SQLAlchemy 2.x — DeclarativeBase** — <https://docs.sqlalchemy.org/en/21/orm/declarative_configurations.html> — accessed 2026-10-19 — the 2.x declarative API.
- **SQLAlchemy 2.x — Classical Mapping** — <https://docs.sqlalchemy.org/en/21/orm/mapping_styles.html#classical-mapping-via-map-imperatively> — accessed 2026-10-19 — the legacy escape hatch.
- **SQLAlchemy 2.x — Dialects** — <https://docs.sqlalchemy.org/en/21/dialects/index.html> — accessed 2026-10-19 — driver-to-dialect mapping.
- **Martin Fowler — Unit of Work** — <https://martinfowler.com/eaaCatalog/unitOfWork.html> — accessed 2026-10-19 — the original pattern catalog entry.
- **Martin Fowler — Identity Map** — <https://martinfowler.com/eaaCatalog/identityMap.html> — accessed 2026-10-19 — the original pattern catalog entry.
- **PEP 695 — Type aliases** — <https://peps.python.org/pep-0695/> — accessed 2026-10-19 — type alias syntax used by 2.x declarative models.

## What We Learned

Let's recap. In this lesson you:

- **Drew the SQLAlchemy layer cake** (Dialect → Core → ORM → Session) and learned that each layer has a clear job: dialect translates, Core builds SQL, ORM maps rows to objects, Session is the workspace.
- **Saw the same insert three ways** — raw Core (`engine.connect()` + `insert(table).values(...)`), declarative ORM (`Session.add(UserDeclarative(...))`), and classical ORM (`registry.map_imperatively`).
- **Learned the unit-of-work pattern**: the application mutates objects; the session diffs them at flush time and emits minimal SQL.
- **Learned the identity map**: within one session, one row maps to one Python object. The identity map is per-session, not per-process.
- **Compared declarative vs classical mapping** and understood why declarative 2.x is the canonical form (type hints, IDE support, single source of truth).
- **Matched dialects to drivers** (`postgresql+psycopg` vs `postgresql+asyncpg`, `sqlite` vs `sqlite+aiosqlite`) and learned that the part before `+` is the dialect and the part after is the driver.
- **Previewed sync vs async**: the difference is what gets blocked while waiting on the database — the worker thread (sync) or just the coroutine (async). Everything else about the API is identical.

Here's the mental model to walk away with: *SQLAlchemy is a layered library, not a magic box. The ORM sits on Core; Core sits on the dialect; the Session is the unit-of-work workspace. Every line of ORM code you will ever write is, eventually, a Core SQL statement rendered by a dialect and executed by an engine. Knowing which layer you are touching — and why — is the difference between using SQLAlchemy well and being used by it.*

---

> A note from your teacher
You just learned the architecture. The next eight lessons populate it: engines in Lesson 02, models in Lesson 03, relationships in Lesson 04, sessions in Lesson 05, queries in Lesson 06, async in Lesson 07, the advanced ORM in Lesson 08, and the four insert APIs compared in Lesson 09. The architecture does not change — every later lesson fits inside this cake. See you in Lesson 02.


---

**Tags:** #sqlalchemy #orm #architecture #unit-of-work #identity-map #review
**Previous:** [[00-SQLAlchemy-MOC]]
**Next:** [[02-Engines-Connections-Pools]] →

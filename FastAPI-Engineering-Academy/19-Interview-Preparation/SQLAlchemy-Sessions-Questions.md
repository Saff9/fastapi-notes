---
title: SQLAlchemy Sessions: Interview Questions
aliases:
 - SQLAlchemy Interview Questions
 - Session Questions
 - ORM Interview Questions
tags:
 - interview
 - sqlalchemy
 - orm
course_level: intermediate
difficulty: intermediate
estimated_time: "3–4 hours for a full rehearsal"
status: complete
prerequisites:
 - "[[07-SQLAlchemy/01-Foundations-and-Architecture]]"
 - "[[07-SQLAlchemy/03-Declarative-Base-and-Mapped]]"
 - "[[07-SQLAlchemy/05-Session-and-Transaction-Management]]"
 - "[[07-SQLAlchemy/07-Async-SQLAlchemy]]"
related_lessons:
 - "[[07-SQLAlchemy/01-Foundations-and-Architecture]]"
 - "[[07-SQLAlchemy/03-Declarative-Base-and-Mapped]]"
 - "[[07-SQLAlchemy/05-Session-and-Transaction-Management]]"
 - "[[07-SQLAlchemy/06-Querying-with-select]]"
 - "[[07-SQLAlchemy/07-Async-SQLAlchemy]]"
 - "[[07-SQLAlchemy/08-Advanced-ORM]]"
---

# SQLAlchemy Sessions: Interview Questions

*A question bank on SQLAlchemy 2.x: the ORM core, the `Session`, querying, relationships, async, and transaction boundaries in services. Reuse the vocabulary from [[Glossary]] — identity map, autoflush, `DeclarativeBase`, `MissingGreenlet`.*

**How to use this file**

The single most-asked SQLAlchemy question in senior interviews is some variation of "explain the identity map" or "explain N+1." If you can answer those two with code on a whiteboard, you have signal. Practice the others for breadth. As with [[FastAPI-and-DI-Questions]], the model answer is the *shape* of a senior response — close the file, write your own answer, compare.


#interview #sqlalchemy #orm

---

## Q1: What is the difference between `DeclarativeBase` and the legacy `declarative_base()` factory? Which should you use in 2026?

### What a strong answer demonstrates

You know SQLAlchemy 2.x made `DeclarativeBase` the canonical base class, that `declarative_base()` is the 1.x legacy form retained for compatibility, and that the 2.x form integrates natively with type checkers via `Mapped` / `mapped_column`. You also know not to rewrite for its own sake — `declarative_base()` still works.

### Model answer

In SQLAlchemy 2.x:

- `DeclarativeBase` is a class you subclass to declare your models' common base. It holds the `registry` and the `MetaData`. You create it once: `class Base(DeclarativeBase): pass`.
- `declarative_base()` is the 1.x factory that returns a class equivalent to a `DeclarativeBase` subclass. It still works in 2.x for backwards compatibility, but is no longer the recommended form.

Use `DeclarativeBase` in new code because:

1. It composes naturally with `Mapped[T]` and `mapped_column(...)` — the typed, PEP 484-friendly 2.x column syntax. Type checkers (mypy, pyright) actually understand `Mapped[int]` is an `int`; the legacy `Column(Integer)` is `Column[Any]` to them.
2. It plays well with `AsyncSession` and `asyncio` because the registry is set up correctly by default.
3. It supports `MappedAsDataclass` and `DeclarativeBaseNoMeta` for the cases where you want dataclass models or fewer magic behaviors.
4. It composes with `AsyncAttrs` (2.0+) for safe async attribute access on `AsyncSession`-loaded objects — see Q12.

`declarative_base()` is fine to leave in legacy code; do not rewrite for its own sake. New code should use `DeclarativeBase`.

**Interviewer's follow-up: "What's on the `Base` instance?"**

The `registry` (a `registry` object that maps classes to mappers and tables) and the `MetaData` (a `MetaData` object holding the `Table` definitions). Both are accessible: `Base.metadata`, `Base.registry`. Alembic uses `Base.metadata` to detect schema changes.


### Practical example

```python
# 2.x (recommended)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

class Base(DeclarativeBase):
 pass

class User(Base):
 __tablename__ = "users"
 id: Mapped[int] = mapped_column(primary_key=True)
 email: Mapped[str] = mapped_column(unique=True)

# 1.x (legacy, still works in 2.x)
from sqlalchemy.orm import declarative_base, Column, Integer

Base = declarative_base()

class User(Base):
 __tablename__ = "users"
 id = Column(Integer, primary_key=True)
```

### Common weak answers

- "DeclarativeBase is the new name for declarative_base." — close but not quite; the relationship is "factory returns an equivalent class," and the 2.x API has more (typed columns, dataclass support).
- "declarative_base() is deprecated." — it is not removed; SQLAlchemy keeps it for compatibility. It is "legacy," not "deprecated."
- "They're identical." — they are not; the 2.x form unlocks typed columns.

### Follow-up questions

- How do you make models dataclasses? (Subclass `MappedAsDataclass` before `DeclarativeBase`; configure `__eq__`, `__repr__`, etc.)
- Where does the metadata live? (On the `DeclarativeBase` instance, accessible as `Base.metadata`.)
- How do you share a metadata across multiple bases? (Pass a shared `MetaData()` and `registry` to `DeclarativeBase` via class body.)

**Additional practical example — custom `MetaData` with naming conventions:**

```python
from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# Naming conventions make Alembic-generated constraints predictable:
#   ix_<table>_<column> for indexes
#   uq_<table>_<column> for unique constraints
#   fk_<table>_<column>_<ref_table>_<ref_column> for foreign keys
#   pk_<table> for primary keys
convention = {
 "ix": "ix_%(column_0_label)s",
 "uq": "uq_%(table_name)s_%(column_0_name)s",
 "ck": "ck_%(table_name)s_%(constraint_name)s",
 "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
 "pk": "pk_%(table_name)s",
}

class Base(DeclarativeBase):
 metadata = MetaData(naming_convention=convention)

class User(Base):
 __tablename__ = "users"
 id: Mapped[int] = mapped_column(primary_key=True)
 email: Mapped[str] = mapped_column(unique=True)
# The unique constraint on email is now named uq_users_email, not a
# random name. Alembic autogenerate produces stable, reviewable
# migrations: the constraint name does not change between runs, so
# the migration diff is minimal.
```

**Additional common weak answers:**

- "`declarative_base()` was removed in 2.x." — it is not; it is retained for compatibility with 1.x codebases. New code should use `DeclarativeBase` because of the typing integration, but legacy code does not have to be rewritten.
- "`DeclarativeBase` forces type hints." — it does not force them; `Mapped` is opt-in. You can use `Column(...)` with `DeclarativeBase` via the 1.x compatibility shim, but you lose the typing benefit.

**Additional follow-up questions:**

- How do you set a custom `MetaData` with naming conventions? (Pass `MetaData(naming_convention={...})` as a class attribute on the `DeclarativeBase` subclass. Alembic autogenerate then produces constraint names matching the convention, so migrations are stable across runs.)
- What is `DeclarativeBaseNoMeta`? (A variant that skips the metaclass magic; for advanced cases where you want to control the registry and metadata yourself. Not for normal use.)

Canonical: [[07-SQLAlchemy/03-Declarative-Base-and-Mapped]].

---

## Q2: What are `Mapped[T]` and `mapped_column`? How do they differ from `Column`?

### What a strong answer demonstrates

You know `Mapped[T]` is the Python-side type annotation (PEP 593-style) that declares the attribute's type, `mapped_column(...)` is the database-side configuration, and the two together replace the legacy `Column(...)` form. You can explain what type checkers see and what runtime behavior changes.

### Model answer

In 2.x:

- `Mapped[T]` is a typing construct — it tells type checkers (and SQLAlchemy's declarative scanner) that the attribute is a mapped column of type `T`. It also tells SQLAlchemy whether the column is nullable: `Mapped[int]` is non-nullable; `Mapped[int | None]` is nullable.
- `mapped_column(...)` is the configuration function — it attaches `Column`-level kwargs (primary key, unique, default, server_default, foreign key, index) to the attribute declared by `Mapped`. Without `mapped_column`, you get a column with default configuration (inferred from `Mapped[T]`).

Compared to legacy `Column`:

- Type inference goes the other way. With `Column(Integer)`, SQLAlchemy infers the Python type is `int` *at runtime*, but type checkers see `Column[Integer]` and don't know the Python type. With `Mapped[int]`, the Python type is *declared* and the SQL type is inferred.
- Nullability is explicit. `Mapped[int]` → `NOT NULL`; `Mapped[int | None]` → `NULL`. You can override with `mapped_column(nullable=True)`, but the *default* follows the type.
- Relationships are typed too: `Mapped[list["Order"]]` — type checkers see `list[Order]`.

**Tip — The `Mapped` form is not just for type checkers**

It's also the form SQLAlchemy 2.x's declarative scanner understands natively. The legacy `Column` form goes through a compatibility shim. In async SQLAlchemy (`AsyncSession`), `Mapped` attributes work with `await`-style access via `AsyncAttrs`; the legacy form has caveats.


**Interviewer's follow-up: "Do I need the `AsyncAttrs` mixin to access relationships on an `AsyncSession`-loaded object?"**

No, not for *eager-loaded* attributes — those are populated at query time and stay on the object after the session closes. `AsyncAttrs` is only needed when you want to *lazily* access an attribute outside the session's await context (i.e., the lazy load would need to await). The recommended pattern is to avoid lazy loads entirely by eager-loading what the route needs, in which case `AsyncAttrs` is unnecessary. If you cannot avoid lazy access (e.g., a generic serializer that walks arbitrary relationships), `AsyncAttrs` lets you write `await obj.awaitable_attrs.orders` instead of `obj.orders` raising `MissingGreenlet`. But the better fix is to project to a DTO inside the session's scope — see Q11 and Q12.


### Practical example

```python
from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column, relationship
from typing import Optional

class User(Base):
 __tablename__ = "users"
 id: Mapped[int] = mapped_column(primary_key=True)
 email: Mapped[str] = mapped_column(String(255), unique=True)
 deleted_at: Mapped[Optional[datetime]] = mapped_column(default=None) # nullable
 orders: Mapped[list["Order"]] = relationship(back_populates="user")
```

### Common weak answers

- "`Mapped` is just type hints." — it is also the declarative marker SQLAlchemy uses to register the attribute as a column.
- "`mapped_column` is the new `Column`." — close, but the typing integration is the load-bearing difference.
- "You can't use `Column` in 2.x." — you can, via the 1.x compatibility shim. It's not removed, just not preferred.

### Follow-up questions

- How do you declare a `JSONB` column with typed Python access? (`data: Mapped[dict] = mapped_column(JSONB)` plus `MappedAsDataclass` or a custom `TypeDecorator` for finer typing — see [[07-SQLAlchemy/08-Advanced-ORM]].)
- How does `Mapped[Optional[T]]` translate to `NULL`? (Default `nullable=True` when the type includes `None`; otherwise `nullable=False`.)
- What is `WriteOnlyMapped`? (A 2.x relationship variant that disallows implicit queries on the relationship — forces you to use explicit `select` statements; useful for huge collections.)

**Additional practical example — `WriteOnlyMapped` for huge collections:**

```python
from sqlalchemy import ForeignKey, JSONB
from sqlalchemy.orm import WriteOnlyMapped, relationship

class User(Base):
 __tablename__ = "users"
 id: Mapped[int] = mapped_column(primary_key=True)
 email: Mapped[str]
 # WriteOnlyMapped forbids implicit loading: you cannot do `user.events`
 # (it raises). You must `select(Event).where(Event.user_id == user.id)`.
 # Use this for huge collections you never want to load all at once:
 events: WriteOnlyMapped[list["Event"]] = relationship()

class Event(Base):
 __tablename__ = "events"
 id: Mapped[int] = mapped_column(primary_key=True)
 user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
 payload: Mapped[dict] = mapped_column(JSONB)

# Usage: explicit select, never implicit access:
events = (await session.scalars(
 select(Event).where(Event.user_id == user.id).limit(100)
)).all()
# A naive `user.events` would have loaded millions of rows; WriteOnlyMapped
# makes the mistake a hard error at access time, not a slow query in prod.
```

**Additional common weak answers:**

- "`Mapped` is just for type checkers." — it is also the declarative marker SQLAlchemy uses to register the attribute as a column. Without `Mapped`, the attribute is a plain class attribute, not a mapped column.
- "You can't use `Column` with `Mapped`." — you can: `Mapped[int] = mapped_column(Integer, ...)` infers the SQL type from the `Mapped` annotation, with `Column`-level kwargs in `mapped_column`. They compose, not compete.

**Additional follow-up questions:**

- What is `WriteOnlyMapped`? (A 2.x relationship variant that disallows implicit queries on the relationship; forces explicit `select`. Use it for huge collections you never want to load all at once.)
- How do you declare a hybrid property? (`@hybrid_property` decorator plus `@.expression` for the SQL form and `@.value` for the Python form. The hybrid gives you `User.is_active` in both Python (`user.is_active`) and SQL (`select(User).where(User.is_active)`).)

Canonical: [[07-SQLAlchemy/03-Declarative-Base-and-Mapped]], [[01-Python-Foundations/Type-Hints-and-Annotations]].

---

## Q3: `select()` vs the legacy `Query` API – what is different, why did SQLAlchemy change, and what should you use?

### What a strong answer demonstrates

You know `select()` is the 2.x canonical API; `Query` (the `session.query(...)` form) is the 1.x legacy API; both still work in 2.x but `select()` is the form new code should use. You can articulate *why*: `select()` is decoupled from the `Session`, composes better, supports `AsyncSession` cleanly, and is type-checker friendly.

### Model answer

`select()` (from `sqlalchemy`) is the 2.x canonical query construct. It builds a `Select` object that you pass to `session.execute(...)` or `await session.execute(...)` for async. The legacy `Query` object — `session.query(User).filter(...)` — is still available in 2.x but is the 1.x API and is being phased out.

Reasons for the change:

1. **Decoupling.** `select()` is not tied to a `Session` — you can build the statement, pass it around, inspect it, test it, then execute it on whichever session. `Query` is bound to a session at construction time.
2. **Async.** `AsyncSession.execute(stmt)` takes a `select()` object. The legacy `Query` API was built around sync iterator semantics; retrofitting async would have required a parallel API. `select()` is a clean break.
3. **Composition.** `select(User).join(Order).options(selectinload(User.orders)).where(...)` reads top to bottom. Subqueries, CTEs, and unions are easier.
4. **Type safety.** `session.scalars(select(User))` returns a `ScalarResult[User]`; type checkers can infer the element type. `session.query(User)` returns a `Query[User]` whose element type is harder to infer.

**Warning — Don't migrate for its own sake**

If your codebase has 10,000 lines of `session.query(...)`, you do not have to rewrite. SQLAlchemy keeps `Query` working. New code should use `select()`; existing `Query` code can stay until you have a reason to touch it. Mixing is fine.


**Interviewer's follow-up: "How do I migrate a `session.query(User).filter(...).join(...).exists()` call to `select()`?"**

The `Query` API has a `.exists()` method that returns an EXISTS subquery directly. With `select()`, the equivalent is `select(User.id).where(...).join(...).exists()` — the `.exists()` is a method on the `Select` object, but the resulting construct goes inside another `select()`: `select(literal(1)).where(select(User.id).where(...).exists())` or use `select(User).where(User.id.in_(select(User.id).where(...)))`. The IN form is usually clearer and the query planner produces the same plan. For migration: keep the legacy `Query`-form code working until you have a test in place, then port query-by-query with a side-by-side comparison of the SQL output (use `echo=True` to compare the generated SQL before and after).


### Practical example

```python
from sqlalchemy import select

# 2.x (recommended):
stmt = select(User).where(User.email == "x@y.com").order_by(User.id)
user = (await session.scalars(stmt)).one_or_none()

# 1.x (legacy, still works):
user = session.query(User).filter(User.email == "x@y.com").order_by(User.id).one_or_none()
```

### Common weak answers

- "`Query` is removed in 2.x." — it is not removed; it's legacy but still works.
- "`select` is faster." — there's no measurable runtime difference; the win is composition and async support.
- "You can't do `join` with `select()`." — you can; `select(User).join(Order.orders)`.

### Follow-up questions

- How do you select individual columns? (`select(User.id, User.email)` returns `Row[int, str]` tuples; use `session.execute(stmt)`.)
- How do you do `EXISTS` subqueries? (`select(literal(1)).where(User.id == 5).exists()`.)
- What's `session.get(Model, pk)`? (A 2.x shortcut for primary-key lookup — same as `select(User).where(User.id == pk)` but cached on the identity map.)

**Additional practical example — side-by-side migration with `echo=True`:**

```python
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

# Use echo=True to compare the generated SQL before and after migration:
engine = create_engine("postgresql+psycopg://...", echo=True)

# Legacy Query form (before migration):
with Session(engine) as session:
 user = (session.query(User)
   .filter(User.email == "x@y.com")
   .order_by(User.id)
   .first())
 # Echo: SELECT users.id, users.email FROM users WHERE ...

# 2.x select form (after migration):
with Session(engine) as session:
 user = (session.scalars(
  select(User).where(User.email == "x@y.com").order_by(User.id)
 )).first()
 # Echo: SELECT users.id, users.email FROM users WHERE ...

# The two SQL strings should be identical. If they differ, you have a
# behavior change to investigate before merging. Run both under the
# same test fixtures and diff the SQL line by line.
```

**Additional common weak answers:**

- "`Query` is deprecated in 2.x." — it is not deprecated; it is retained for compatibility. New code should use `select()` because of the composition and async benefits, but `session.query(...)` still works.
- "`select()` is faster than `Query`." — there is no measurable runtime difference; both compile to the same SQL. The wins are composition (you can build a `select()` without a session) and async (`AsyncSession.execute(stmt)`).

**Additional follow-up questions:**

- How do you do `group_by` + `having` with `select()`? (`select(User.id, func.count()).group_by(User.id).having(func.count() > 10)` — the `having` clause takes a SQL expression, not a Python lambda.)
- What is `selectinload` vs `joinedload`? (See Q10 — `selectinload` for collections, `joinedload` for many-to-one. The distinction is row multiplication: `joinedload` on a collection multiplies parent rows.)

Canonical: [[07-SQLAlchemy/06-Querying-with-select]].

---

## Q4: `Session.execute` vs `Session.scalars` – when do you use each? What does `.one()` vs `.one_or_none()` vs `.first()` do?

### What a strong answer demonstrates

You know `execute` returns `Result` (rows of tuples even for ORM queries), `scalars` returns `ScalarResult[T]` (the ORM object directly), and you know the difference between `.one()` (raises if 0 or >1), `.one_or_none()` (returns None if 0, raises if >1), and `.first()` (returns None if 0, returns one row if many — no error on multiple).

### Model answer

Two execution methods, two return shapes:

- `session.execute(stmt)` → `Result`. Each row is a `Row` tuple. For ORM queries (`select(User)`), each row is a 1-element tuple `(User,)`. Useful when you select multiple columns: `select(User.id, User.email)` → `Row[int, str]`.
- `session.scalars(stmt)` → `ScalarResult[T]`. Strips the tuple wrapper; you iterate `User` objects directly. Use this for ORM queries that select a single entity.

The three result methods (available on both `Result` and `ScalarResult`):

- `.one()` — exactly one row, else raise `NoResultFound` (zero rows) or `MultipleResultsFound` (>1 row). Use when you expect exactly one (e.g., by primary key, after a uniqueness filter).
- `.one_or_none()` — one row, or `None` if zero, raise `MultipleResultsFound` if >1. Use when you expect zero or one (e.g., a "get by email" where email is unique).
- `.first()` — first row, or `None` if zero. No error on multiple. Use for "any row matching" or with `LIMIT 1`.

**Tip — Use `.one()` for primary-key lookups**

`session.get(User, 42)` is the cleanest 2.x form for PK lookup — it's identity-map cached. But if you're using `select(...)`, use `.one()` because a PK lookup that returns 0 means the row was deleted, and 2 means data corruption — both should raise.


**Interviewer's follow-up: "What does `.all()` do?"**

Returns a `list` of all matching rows. Eager: it materializes the entire result set into memory. For large result sets, iterate the `Result` directly (which streams) or use `.scalars()` streaming.


### Practical example

```python
# Single-entity ORM query — use scalars:
user = (await session.scalars(select(User).where(User.id == 42))).one()

# Multi-column query — use execute; iterate Rows:
rows = (await session.execute(select(User.id, User.email).where(User.active))).all()
for row in rows:
 print(row.id, row.email) # Row has named access

# Bulk entity query — scalars + all:
users = (await session.scalars(select(User).where(User.active))).all()

# Existence check — use first() with LIMIT 1 or an EXISTS subquery:
exists_stmt = select(User.id).where(User.email == "x@y.com").exists().select()
user_exists = (await session.scalars(exists_stmt)).first() is not None
```

### Common weak answers

- "They're the same thing." — they are not. `execute` returns rows of tuples; `scalars` unwraps to the entity.
- "Use `first()` for get-by-id." — wrong; if there are 2 rows by id (data corruption), `first()` silently returns one of them. Use `.one()`.
- "`.one()` returns `None` if not found." — it raises `NoResultFound`. Use `.one_or_none()` for that.

### Follow-up questions

- What raises `MultipleResultsFound`? (`.one()` and `.one_or_none()` when >1 row.)
- What is `.unique()`? (Required when using `joinedload` with collections to dedupe parent rows; `scalars` raises if you forget it.)
- What does `await session.stream(stmt)` do? (Returns an `AsyncStreamedResult` that yields rows lazily — useful for huge result sets.)

**Additional practical example — streaming huge result sets:**

```python
from sqlalchemy import select

# Stream a million-row export without buffering the whole result set:
stmt = select(Event).where(Event.created_at >= "2026-01-01").order_by(Event.id)

result = await session.stream(stmt)  # server-side cursor
async for event in result.scalars():
 # Processed one at a time; the AsyncSession yields rows lazily.
 yield event.payload  # e.g., write to a CSV or push to a queue

# Note: stream() requires a server-side cursor; psycopg and asyncpg
# both support it. SQLite does not stream: it materializes the whole
# result set, but the API is identical. Use stream() when the result
# set is large and you want bounded memory; use scalars().all() when
# the result set is small and you want a list.
```

**Additional common weak answers:**

- "`scalars` is just `execute` plus unwrap." — yes, but the unwrap is what makes the type checker see `User` not `Row[User]`. The two APIs are not interchangeable for type-aware code.
- "Use `first()` for everything." — `first()` silently returns one of many; `one()` raises. Use `first()` only when you genuinely do not care which row you get (e.g., "any row matching"); use `one()` for unique lookups.

**Additional follow-up questions:**

- What is `.tuples()`? (A method to get `Row` access semantics from a `ScalarResult` — useful when you need both the entity and the row's named access in the same iteration.)
- How do you stream a huge result? (`result = await session.stream(stmt); async for row in result.scalars(): ...` — the server-side cursor yields rows one at a time; memory stays bounded regardless of result set size.)

Canonical: [[07-SQLAlchemy/06-Querying-with-select]], [[07-SQLAlchemy/05-Session-and-Transaction-Management]].

---

## Q5: What is the identity map? What does it guarantee, and what does it *not* guarantee?

### What a strong answer demonstrates

You know the identity map is a per-Session dict of `(mapper, primary_key) → object` that guarantees one row maps to one Python object within a session. You know it is *not* global — each session has its own. You know it does *not* guarantee isolation (transactions do) or that the object's attributes match the database (autoflush and explicit refresh do).

### Model answer

The identity map is a per-Session map from `(mapper, primary_key)` tuples to ORM objects. When you query for a row, the Session first checks the identity map; if the object is already there, the Session returns *that* object rather than creating a new one.

What it guarantees:

- **Object identity within a session.** Two queries for `User(id=42)` in the same session return the *same* Python object (`obj1 is obj2`).
- **No "duplicate object" bug.** Without the identity map, a `SELECT User JOIN Order` returning 5 rows of the same user (with 5 different orders) would produce 5 distinct `User` objects in Python — each with one order. With the map, you get one `User` with 5 orders.
- **In-memory changes are visible.** If you modify `user.email`, then query `select(User).where(User.id == 42)` again, you get the same object back with your modified email (after autoflush sends the `UPDATE`).

What it does *not* guarantee:

- **Isolation across transactions.** Two sessions reading the same row get two different objects. The identity map is per-session, not per-process.
- **Freshness without autoflush.** The map holds the object as you last saw it. If another process changed the row in the database, your session's copy is stale until you `session.refresh(obj)` or `session.expire(obj)` and re-query.
- **Cross-session identity.** A new session starts with an empty map.

**Why this matters in async SQLAlchemy**

In `AsyncSession`, the identity map is still per-session. But attribute access that requires a DB round trip (lazy loading, expired attribute) cannot run synchronously — the session might be in a different task. That's the root cause of `MissingGreenlet` (Q12). Eager-load inside the session's await context.


**Interviewer's follow-up: "How do you bypass the identity map?"**

`session.execute(select(User).execution_options(populate_existing=True))` refreshes existing objects in the map. `session.expire_all()` marks all objects as expired; the next access triggers a re-fetch. `session.expunge(obj)` removes an object from the session entirely.


### Practical example

```python
u1 = (await session.scalars(select(User).where(User.id == 42))).one()
u2 = (await session.scalars(select(User).where(User.id == 42))).one()
assert u1 is u2 # identity map → same Python object
```

### Common weak answers

- "It's a cache." — it is not a query cache; it's an object identity guarantee. The session does not skip the SQL — it returns the same object instead of creating a new one.
- "It's global." — it is per-session.
- "It prevents race conditions." — it does not. Two sessions can hold the same row as two different objects; the loser's commit wins or you get a stale-write bug.

### Follow-up questions

- What is `expire_on_commit`? (When `True` — the default — `commit()` marks all objects as expired; the next attribute access re-fetches. Setting `False` keeps the in-memory state but risks staleness.)
- What is `session.merge(obj)`? (Reconciles a detached object's state into the session, returning the session's instance.)
- What is `session.autoflush`? (Q6.)

**Additional practical example — `populate_existing` and `expunge_all`:**

```python
from sqlalchemy import select

# populate_existing=True refreshes existing objects in the identity map
# from a fresh query. Useful when another transaction has changed rows
# you already have loaded and you want the new values:
u1 = (await session.scalars(select(User).where(User.id == 42))).one()
# ... another transaction updates user 42's email ...
u2 = (await session.scalars(
 select(User).where(User.id == 42).execution_options(populate_existing=True)
)).one()
assert u1 is u2  # same object, but now with the updated email

# expunge_all() detaches everything: they are no longer in the session,
# so attribute access on unloaded relationships raises DetachedInstanceError.
await session.expunge_all()
# u1.orders  # DetachedInstanceError (sync) or MissingGreenlet (async)
```

**Additional common weak answers:**

- "It's a query cache." — it is not; the SQL still runs; you just get the same object back instead of a new one. The map guarantees object identity, not query skipping.
- "It's process-wide." — per-session. Two sessions reading the same row get two different objects; the map is not shared across sessions.

**Additional follow-up questions:**

- What is `populate_existing=True`? (Forces the session to refresh existing objects in the map from the new query, overriding the "return the cached object" behavior. Use when you know the database has changed since the last load.)
- What is `expunge_all()`? (Removes all objects from the session; they become detached. Useful before a long-running computation that should not hold DB resources.)

Canonical: [[07-SQLAlchemy/05-Session-and-Transaction-Management]].

---

## Q6: What is autoflush? When does it run? When is it dangerous?

### What a strong answer demonstrates

You know autoflush is a Session behavior that flushes pending changes (INSERT/UPDATE/DELETE) to the database *before* a `SELECT` so the query can see them. You know when it runs (before every query, by default), and you know the failure mode: a flush before you intended commits can fail (e.g., a NOT NULL violation) and abort your query mid-flight.

### Model answer

Autoflush is the Session's behavior of automatically flushing pending changes to the database before executing a `SELECT` query. Without autoflush, if you do `session.add(user)` and then `session.execute(select(User).where(...))`, the query would not see the new `user` — it's still in the session's "pending" set, not in the database. With autoflush, the session emits the `INSERT` before the `SELECT`, and the query sees the new row.

When it runs:

- Before every `session.execute(select(...))` call.
- Before `session.scalars(...)`.
- Before any query that goes to the database.

When it does *not* run:

- Before `session.commit()` — commit flushes anyway.
- Before attribute access on a loaded object — no DB round trip, so no autoflush.
- When disabled: `session = Session(autoflush=False)`.

The danger:

- **Premature constraint violation.** You `add(user)` then immediately query. Autoflush tries to INSERT; the user has a `NOT NULL` column you haven't set yet; `IntegrityError` mid-flight, transaction aborted.
- **Surprising side effects.** Triggers fire, sequence values consumed, default-side-effect columns populated — all before you "officially" wrote anything.
- **Lock contention.** An autoflush sends INSERT/UPDATE that acquire locks; if your subsequent SELECT is long-running, the locks are held longer.

**Warning — When to disable autoflush**

When you're staging multiple related adds that must satisfy constraints together — say, a parent and child where the child has a FK to the parent — disable autoflush, add both, then `flush()` manually. The alternative is to add the parent, `flush()` to get the id, then add the child. Disabling is cleaner.


**Interviewer's follow-up: "Does autoflush run before a savepoint's release, or only before a top-level SELECT?"**

Before any SQL the session would emit — including the SQL to release a savepoint (`RELEASE SAVEPOINT`) if the session's pending state would affect that release. In practice, with `session.begin_nested()` (a savepoint), if you `add()` something then call another `session.execute(select(...))`, the autoflush fires inside the savepoint, the SELECT sees the new row, and the savepoint either commits (preserving the flush) or rolls back (undoing it). The savepoint boundary doesn't suppress autoflush — autoflush is gated on "is the session about to send SQL?" not on "is the transaction top-level?". The implication: if you want to stage writes that *don't* autoflush, you need `Session(autoflush=False)` for that session (or `session.autoflush = False` temporarily), not a savepoint.


### Practical example

```python
session = Session(autoflush=False)

async with session.begin():
 parent = Parent(name="X")
 session.add(parent)
 await session.flush() # parent.id is now set
 child = Child(parent_id=parent.id, label="Y")
 session.add(child)
 # autoflush would have tried to flush parent+child together on the next query,
 # which would fail the FK constraint if the order wasn't right. Manual flush avoids this.

# Default behavior (autoflush=True) is fine for most CRUD.
```

### Common weak answers

- "Autoflush is the same as commit." — flush sends SQL but does not commit the transaction. The transaction's atomicity is still enforced by commit.
- "Autoflush runs after every add." — it runs before every query.
- "It's always safe." — it's not. See the constraint-violation example.

### Follow-up questions

- What is `session.flush()`? (Manual flush — same as autoflush but explicit. Sends pending SQL.)
- What is `session.commit()`? (Flush + COMMIT the transaction + expire all objects by default.)
- What is `session.refresh(obj)`? (Re-fetch the object from the database, overwriting in-memory state.)

**Additional practical example — the constraint violation mid-flight:**

```python
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

class User(Base):
 __tablename__ = "users"
 id: Mapped[int] = mapped_column(primary_key=True)
 email: Mapped[str]  # NOT NULL: autoflush will fail if email is unset

session = Session(engine)  # autoflush=True by default
user = User()  # email is unset
session.add(user)
# The next SELECT triggers autoflush, which tries to INSERT with email=NULL:
try:
 session.execute(select(User).where(User.id == 1))
except IntegrityError as e:
 # The INSERT failed; the SELECT never ran. On PostgreSQL, the
 # transaction is now aborted: any further SQL raises InternalError.
 print(f"autoflush triggered IntegrityError: {e.orig}")

# Fix: stage related adds without autoflush interference:
session = Session(engine, autoflush=False)
session.add(user); user.email = "x@y.com"
session.flush()  # explicit, after email is set
```

**Additional common weak answers:**

- "Autoflush is the same as commit." — flush sends SQL without COMMIT. The transaction's atomicity is still enforced by commit; autoflush only pushes pending changes to the database within the transaction.
- "Autoflush is always on." — it is the default but `Session(autoflush=False)` disables it, and `session.no_autoflush` is a context manager that disables it for a block. Disable when staging related adds that must satisfy constraints together.

**Additional follow-up questions:**

- What is `session.no_autoflush`? (A context manager that disables autoflush for the block. Cleaner than toggling `session.autoflush` because it restores the previous value on exit.)
- When does autoflush NOT run? (Before attribute access on a loaded object — no DB round trip is needed, so no autoflush. Also before `session.commit()` — commit flushes anyway, so the autoflush is redundant and skipped.)

Canonical: [[07-SQLAlchemy/05-Session-and-Transaction-Management]].

---

## Q7: Flush vs commit – explain the difference precisely.

### What a strong answer demonstrates

You know flush sends pending SQL to the database *without* ending the transaction; commit flushes *and* ends the transaction (COMMIT) *and* expires all objects (by default). You can articulate the implication: a flush's changes are visible only inside the same transaction; a commit's changes are durable and visible to other transactions.

### Model answer

Two distinct operations:

- **`session.flush()`** — sends pending INSERT/UPDATE/DELETE statements to the database. The transaction is *not* ended. The changes are visible only inside this transaction (subject to isolation level). Other sessions / connections do not see them until COMMIT.
- **`session.commit()`** — calls `flush()` (sends pending SQL), then issues `COMMIT` (ends the transaction, makes changes durable and visible), then by default expires all objects in the identity map (next access triggers a re-fetch).

The order: `commit()` = `flush()` + `COMMIT` + `expire_all()`.

Implications:

- **You can flush multiple times in a transaction.** Useful when you need a primary key generated by a sequence before adding a child.
- **A flush can fail without aborting the session.** Well — actually, on PostgreSQL, a failed statement aborts the transaction; you must `rollback()`. But on some databases with savepoints, you can recover.
- **Commit expires objects by default.** This means after `commit()`, accessing `obj.name` triggers a re-fetch. Set `expire_on_commit=False` to disable (often done in async to avoid re-fetches outside the session's await context).

**Tip — The async SQLAlchemy idiom**

`AsyncSession(expire_on_commit=False)` is the common configuration in FastAPI services. After `commit()`, the ORM objects are returned to the route handler and serialized. With `expire_on_commit=True`, the serialization would trigger a re-fetch — which, in async, raises `MissingGreenlet` (the session is closed). `False` keeps the in-memory state and avoids the trap.


**Interviewer's follow-up: "If a flush fails, is the session poisoned for the rest of the request?"**

On PostgreSQL, yes — a failed statement aborts the entire transaction, and any subsequent SQL raises `InternalError: current transaction is aborted`. The fix is `await session.rollback()` (or `await session.begin_nested()` to use a savepoint that absorbs the failure without aborting the outer transaction). On SQLite, the semantics differ (statements don't poison the transaction), but PostgreSQL's behavior is the one to design for because it's the production target. The practical implication: catch `IntegrityError` immediately around the `flush()` or `commit()`, rollback, and either re-raise as a domain exception (the canonical pattern from Q8) or use a savepoint (`begin_nested()`) to recover and continue with the outer transaction intact.


### Practical example

```python
# flush without commit:
session.add(user)
await session.flush() # INSERT sent; user.id is set
# ... do more work ...
await session.commit() # COMMIT; user is expired by default

# With expire_on_commit=False (async idiom):
async with AsyncSession(engine, expire_on_commit=False) as session:
 async with session.begin(): # opens transaction, commits on exit
 session.add(user)
 # After the block: committed. user is still usable in the route handler.
```

### Common weak answers

- "Flush is commit but without persistence." — wrong; flush *is* persistence within the transaction. Commit makes it durable across transactions.
- "Commit doesn't flush." — it does, implicitly.
- "expire_on_commit is always True." — it's the default, but `False` is the async idiom. Setting `True` in async is the cause of `MissingGreenlet` after a commit.

### Follow-up questions

- What is `session.begin()`? (Starts a transaction; `session.begin()` returns a transaction context manager that commits on success or rolls back on exception.)
- What is a savepoint? (`session.begin_nested()` — `SAVEPOINT` in SQL; can be rolled back without aborting the outer transaction. See [[07-SQLAlchemy/05-Session-and-Transaction-Management]].)
- What is `session.rollback()`? (Rolls back the transaction; all pending changes are discarded; objects are expired.)

**Additional practical example — savepoint pattern for partial recovery:**

```python
from sqlalchemy.exc import IntegrityError

async def create_users(session, emails: list[str]) -> list[User]:
 users = []
 async with session.begin():  # outer transaction
  for email in emails:
   # A savepoint around each insert: a failed unique constraint
   # rolls back only this savepoint, not the outer transaction.
   async with session.begin_nested():
    user = User(email=email)
    session.add(user)
    try:
     await session.flush()
    except IntegrityError:
     # Savepoint rolled back; the outer transaction is intact.
     # Log and continue; the user is not created but others can be.
     continue
   users.append(user)
 return users
# The outer commit persists all successful inserts in one transaction.
```

**Additional common weak answers:**

- "Flush commits." — no; flush sends SQL within the transaction. The transaction is not ended; the changes are visible only inside this transaction until COMMIT.
- "Commit doesn't flush." — it does, implicitly; `commit()` = `flush()` + `COMMIT` + `expire_all()`. The flush is what sends the pending SQL; the COMMIT is what makes it durable.

**Additional follow-up questions:**

- What is `begin_nested()`? (A savepoint — `SAVEPOINT` in SQL. Can be rolled back without aborting the outer transaction. Use it to absorb a failed flush and continue with the outer transaction intact.)
- What is `expire_on_commit`? (When True — the default — commits expire all objects in the identity map; the next attribute access triggers a re-fetch. Set to False in async to avoid `MissingGreenlet` after commit.)

Canonical: [[07-SQLAlchemy/05-Session-and-Transaction-Management]], [[06-SQL-Fundamentals/Transactions-Isolation-Locks]].

---

## Q8: How do you handle `IntegrityError`? Where in your code should you catch it?

### What a strong answer demonstrates

You know `IntegrityError` is raised by the database when a constraint (UNIQUE, FK, NOT NULL, CHECK) is violated. You know it must be caught at the *service layer* (not the route, not the dependency), because catching it at the route couples the route to the ORM. You know that after catching `IntegrityError`, the session is in an aborted state and you must `rollback()`.

### Model answer

`sqlalchemy.exc.IntegrityError` is raised when the database refuses an operation because a constraint would be violated. The most common cases:

- `UNIQUE` constraint — duplicate email on signup.
- `FOREIGN KEY` constraint — child references a non-existent parent.
- `NOT NULL` constraint — column without a default set to `None`.
- `CHECK` constraint — value fails a check (e.g., `price > 0`).

Where to catch it:

- **Service layer.** The service knows the business meaning of each constraint: "duplicate email" → 409; "FK violation" → 400 or 404, depending on whether the parent should have been there. Translate `IntegrityError` into a domain exception (`ConflictError`, `NotFoundError`), and let FastAPI's exception handler translate that to HTTP.
- **Not in the route.** Catching `IntegrityError` in the route couples the route to SQLAlchemy. The route should not know what ORM you use.
- **Not in the dependency.** Dependencies are for resolving inputs, not for translating errors.

After catching:

- The session is in an aborted state on PostgreSQL — any further statement raises `InternalError: current transaction is aborted`. You must `await session.rollback()`.
- Re-raise as a domain exception with a meaningful message.

**Danger — Don't catch `IntegrityError` broadly**

Catching `except IntegrityError: pass` swallows real bugs. Catch specific cases — distinguish by `orig.diag.constraint_name` (PostgreSQL) — and translate each to a domain exception. The pattern:
```python
try:
await session.commit()
except IntegrityError as e:
await session.rollback()
constraint = getattr(e.orig, "diag", None) and e.orig.diag.constraint_name
if constraint == "users_email_key":
raise EmailAlreadyExists(email) from e
raise
```


**Interviewer's follow-up: "Why catch around `flush()` rather than around `commit()` — doesn't `commit()` also flush?"**

It does, but catching around `flush()` is more precise because (a) `flush()` is when the constraint actually fires — the INSERT/UPDATE statement is sent to the DB and the DB rejects it; (b) if you wait for `commit()`, the failed flush has already poisoned the transaction, and now you must rollback the entire transaction (losing any other pending writes that hadn't been flushed). Catching around `flush()` lets you rollback *just the failed statement* if you use a savepoint (`begin_nested()`), preserving the outer transaction's other writes. The pattern: open a savepoint, `flush()` inside it, catch `IntegrityError`, rollback to the savepoint, translate to domain exception, raise — the outer transaction is still alive. Without a savepoint, you must rollback the whole transaction, which is the more common pattern in FastAPI services (because the route is typically one unit of work).


### Practical example

```python
class EmailAlreadyExists(Exception):
 def __init__(self, email: str):
 self.email = email

async def create_user(session: AsyncSession, payload: SignupIn) -> User:
 user = User(email=payload.email, ...)
 session.add(user)
 try:
 await session.flush() # autoflush before commit also works
 except IntegrityError as e:
 await session.rollback()
 if "users_email_key" in str(e.orig):
 raise EmailAlreadyExists(payload.email) from e
 raise
 return user

# Exception handler (FastAPI):
@app.exception_handler(EmailAlreadyExists)
async def email_exists_handler(request, exc):
 return JSONResponse(status_code=409, content={"error": {"code": "email_taken"}})
```

### Common weak answers

- "Catch it in the route." — couples the route to the ORM.
- "Catch it broadly and return 400." — loses the business meaning; the client can't tell whether to retry or fix the payload.
- "Don't catch; let it propagate to 500." — bad UX; the client gets a 500 with a stack trace.

### Follow-up questions

- How do you check the constraint name? (PostgreSQL: `e.orig.diag.constraint_name`. SQLite: parse the error string.)
- What is `session.begin_nested()`? (A savepoint — you can catch the error and roll back to the savepoint, leaving the outer transaction intact.)
- Should you catch before or after commit? (Either; the constraint fires at flush time, so before commit. But after commit's flush, the savepoint pattern is the only way to keep the transaction.)

**Additional practical example — savepoint plus constraint-name dispatch:**

```python
from sqlalchemy.exc import IntegrityError

async def create_user(session, payload: SignupIn) -> User:
 user = User(email=payload.email)
 session.add(user)
 # Savepoint absorbs the failed flush; the outer transaction stays alive.
 async with session.begin_nested():
  try:
   await session.flush()
  except IntegrityError as e:
   await session.rollback()  # rolls back to the savepoint
   constraint = getattr(getattr(e.orig, "diag", None),
            "constraint_name", None)
   if constraint == "uq_users_email":
    raise EmailAlreadyExists(payload.email) from e
   elif constraint == "fk_users_tenant":
    raise TenantNotFound(payload.tenant_id) from e
   raise
 return user
# The savepoint means: even if the unique constraint fires, the outer
# transaction's other writes (added before this call) are preserved.
```

**Additional common weak answers:**

- "Catch broadly and return 400." — loses business meaning; the client cannot tell whether to retry (transient, e.g., a race on signup) or fix the payload (permanent, e.g., a missing FK). Translate to a domain exception with a specific code.
- "Catch in the route." — couples the route to SQLAlchemy. The route should not know what ORM you use; the service translates the ORM exception to a domain exception, and FastAPI's handler translates the domain exception to HTTP.

**Additional follow-up questions:**

- How do you distinguish constraints? (PostgreSQL: `e.orig.diag.constraint_name` matches the name from your `naming_convention`. SQLite: parse the error string with a regex. PostgreSQL is the production target; design for it.)
- What is `begin_nested()`? (A savepoint that absorbs the failed flush, leaving the outer transaction intact. Without it, the failed flush poisons the transaction and you must rollback everything.)

Canonical: [[07-SQLAlchemy/05-Session-and-Transaction-Management]], [[03-FastAPI-Core/Exception-Handlers]].

---

## Q9: What is an N+1? How do you detect it, and how do you fix it?

### What a strong answer demonstrates

You can define N+1 (one query for the parent, then N queries for the children), name the detection mechanism (queries-per-request metric, SQLAlchemy event listeners, OpenTelemetry spans), and the two canonical fixes (`selectinload` for collections, `joinedload` for one-to-one).

### Model answer

An N+1 query is the pathology where a list query returns N parent rows, and then for each parent, a separate query is issued to load a relationship. The total is N+1 queries: 1 for the parents, N for the children. The cost is N round-trips; on a remote DB, that's the killer.

Classic example:

```python
orders = (await session.scalars(select(Order).limit(100))).all()
for o in orders:
 print(o.customer.name) # SELECT Customer WHERE id = o.customer_id — 100 times
```

100 orders → 101 queries (1 for orders + 100 for customers).

**Detection:**

- **Queries-per-request metric.** Count SQL queries per request via SQLAlchemy's `before_cursor_execute` event. Alert at >20 for a list endpoint.
- **OpenTelemetry spans.** Each query is a span; you see the span list. A list endpoint with 100+ DB spans is an N+1.
- **SQLAlchemy `Echo`.** Set `echo=True` on the engine; the SQL floods the logs. Count the lines.
- **raiseload in tests.** In the test session, set `raiseload(Order.customer)` so any lazy load in a serializer raises — fail in tests, not in production.

**Fixes:**

- `selectinload(Relationship)` — for collections (one-to-many). Emits a second `SELECT ... WHERE id IN (...)` for all parents' children. 2 queries total.
- `joinedload(Relationship)` — for many-to-one. Emits a single `SELECT ... JOIN ...`. 1 query. Be careful with collections — `joinedload` on a collection produces duplicate parent rows (one per child); you need `.unique()` to dedupe.

**Interviewer's follow-up: "What's the difference between `selectinload` and `joinedload`?"**

`selectinload` runs a second query (IN clause); better for collections because it doesn't multiply parent rows. `joinedload` runs one query with a JOIN; better for many-to-one (no row multiplication). For deep chains (`user.orders.items.product`), `selectinload` doesn't multiply; `joinedload` does. See Q10.


### Practical example

```python
# N+1:
orders = (await session.scalars(select(Order).limit(100))).all()
for o in orders:
 print(o.customer.name) # 100 SELECTs

# Fix 1: selectinload (collections):
stmt = select(Order).options(selectinload(Order.customer)).limit(100)
orders = (await session.scalars(stmt)).all() # 2 SELECTs

# Fix 2: joinedload (many-to-one):
stmt = select(Order).options(joinedload(Order.customer)).limit(100)
orders = (await session.scalars(stmt)).all() # 1 SELECT JOIN
# For collection on the parent side, joinedload needs .unique():
stmt = select(User).options(joinedload(User.orders)).unique()
```

### Common weak answers

- "Use `lazy=False` on the relationship." — globally eager-loads everywhere, even when you don't need it. Use per-query options.
- "Just JOIN in the query." — `joinedload` is more than a JOIN; it tells SQLAlchemy how to deserialize the rows back into objects.
- "I'd add an index." — an index doesn't fix N+1; N+1 is a *query count* problem, not a *query speed* problem.

### Follow-up questions

- How do you detect N+1 in production? (Queries-per-request metric; see [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]].)
- What is `raiseload`? (An option that makes a relationship raise on lazy access — for tests.)
- What is `subqueryload`? (An older form of eager loading using a subquery; `selectinload` is preferred — better performance and clearer SQL.)

**Additional practical example — `before_cursor_execute` event for counting:**

```python
from sqlalchemy import event
from collections import defaultdict
import logging

log = logging.getLogger("boardly.sql")

# Per-request SQL counter, attached to the request scope via a contextvar:
QUERY_COUNT = defaultdict(int)

@event.listens_for(engine.sync_engine, "before_cursor_execute")
def count_queries(conn, cursor, statement, parameters, context, executemany):
 # In a real app, scope this to the request via a contextvar:
 request_id = get_current_request_id()  # your contextvar
 QUERY_COUNT[request_id] += 1

# In a middleware after the response is built:
@app.middleware("http")
async def query_count_middleware(request, call_next):
 response = await call_next(request)
 request_id = get_current_request_id()
 count = QUERY_COUNT.pop(request_id, 0)
 response.headers["x-query-count"] = str(count)
 if count > 20:
  log.warning("high query count",
        extra={"request_id": request_id, "count": count})
 return response
```

**Additional common weak answers:**

- "Add an index." — N+1 is a query-count problem, not a query-speed problem. An index does not reduce the round trips; the cost is N round trips, not N slow queries.
- "Use `lazy=False` on the relationship." — that globally eager-loads the relationship everywhere, even when you do not need it. Use per-query `.options(selectinload(...))` so the eager load is scoped to the route that needs it.

**Additional follow-up questions:**

- What is `raiseload`? (An option that makes a relationship raise on lazy access; useful in tests to catch N+1s before they reach production.)
- What is `subqueryload`? (An older form of eager loading using a subquery; `selectinload` is preferred because the IN form produces cleaner SQL and batches better for large parent sets.)

Canonical: [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]], [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]].

---

## Q10: `selectinload` vs `joinedload` – when each?

### What a strong answer demonstrates

You can articulate the trade-off: `selectinload` runs a second `SELECT ... WHERE id IN (...)` — better for collections (no row multiplication); `joinedload` runs a single JOIN — better for many-to-one (single parent) or for one-shot loading of a single entity's relationships. You know the failure mode of `joinedload` on collections (duplicate parent rows; need `.unique()`).

### Model answer

Two eager-loading strategies, two trade-offs:

**`selectinload(Rel.child)`** — Emits a second query after the parent query: `SELECT * FROM child WHERE parent_id IN (1, 2, 3, ...)`. SQLAlchemy batches the parent ids into the IN clause.

- Best for: **collections** (one-to-many). The parent query returns N rows; the child query returns M rows; no multiplication.
- Batching: large parent sets are split into chunks (default 500 ids per IN clause) so the IN list doesn't blow up.
- Cost: 2 round trips. Acceptable for most cases.

**`joinedload(Rel.child)`** — Joins the child table into the parent query: `SELECT * FROM parent JOIN child ON ... `.

- Best for: **many-to-one** (parent has one child referenced by FK). The join doesn't multiply parent rows because each parent has at most one child.
- Cost: 1 round trip. The result set has more columns (parent + child).
- For collections (one-to-many), `joinedload` produces duplicate parent rows — each parent appears once per child. You must call `.unique()` to dedupe, which costs memory. Use `selectinload` instead.
- For deep chains (`user.orders.items.product`), `joinedload` builds a 4-way JOIN — the result set is huge.

The rule of thumb:

- One-to-one / many-to-one → `joinedload`.
- One-to-many / collections → `selectinload`.
- Deep chains → mix: `selectinload(User.orders).selectinload(Order.items).joinedload(Item.product)`.

**Tip — Per-query, not global**

Use loading strategies per-query via `.options(...)`, not via `lazy=False` on the relationship. Global eager-loading loads relationships even when you don't need them.


**Interviewer's follow-up: "How do I make SQLAlchemy `raiseload` in tests only, so N+1s fail the test rather than the production query?"**

Set `raiseload(Relationship, raiseonload=True)` per-query in test setup, or apply it globally on the test session via `session.configure(raiseload=...)`. The test fixture pattern: in `conftest.py`, create a test `AsyncSession` that has `raiseload(Order.customer)` configured — then a serializer that lazy-accesses `order.customer` raises `DetachedInstanceError` (or `MissingGreenlet` in async) and the test fails immediately. The trick is that `raiseload` does not affect production because the test session is only used in tests. The alternative is to set `lazy="raise"` on the relationship in the model — but that's global, and you'd lose lazy loading everywhere (which might be desired, but is a stronger commitment than test-only `raiseload`). See Q9 for detection patterns and the `raiseload` test pattern.


### Practical example

```python
# Many-to-one (User has one Department):
stmt = select(User).options(joinedload(User.department))
# → SELECT users.*, departments.* FROM users JOIN departments ON ...

# Collection (User has many Orders):
stmt = select(User).options(selectinload(User.orders))
# → SELECT * FROM users; then SELECT * FROM orders WHERE user_id IN (...)

# Deep chain:
stmt = (
 select(User)
 .options(selectinload(User.orders).selectinload(Order.items).joinedload(Item.product))
 .where(User.id == 42)
)
# → SELECT * FROM users WHERE id = 42;
# → SELECT * FROM orders WHERE user_id IN (42);
# → SELECT * FROM items WHERE order_id IN (...);
# → SELECT items.*, products.* FROM items JOIN products ON ... WHERE items.id IN (...);
```

### Common weak answers

- "Use `joinedload` everywhere — it's one query." — for collections, the row multiplication kills you. Use `selectinload`.
- "Use `selectinload` everywhere — it's safer." — for many-to-one, you're paying a second round trip you don't need. Use `joinedload`.
- "`lazy=False` is the same as `joinedload`." — `lazy=False` is global; `joinedload` is per-query. Use per-query.

### Follow-up questions

- What is `raiseload`? (An option that makes a relationship raise on lazy access — useful in tests to catch N+1s.)
- What is `subqueryload`? (Older form of `selectinload` using a subquery; `selectinload` is preferred.)
- How do you debug a `joinedload` producing duplicates? (You forgot `.unique()` on the result; or you should be using `selectinload`.)

**Additional practical example — deep chain mixing `selectinload` and `joinedload`:**

```python
from sqlalchemy import select
from sqlalchemy.orm import selectinload, joinedload

# Deep chain: user -> orders -> items -> product
stmt = (
 select(User)
 .options(
  # selectinload for collections (no row multiplication):
  selectinload(User.orders)
   .selectinload(Order.items)
   # joinedload for many-to-one (each item has one product):
   .joinedload(Item.product)
 )
 .where(User.id == 42)
)
# Emits 4 queries:
#   1. SELECT * FROM users WHERE id = 42;
#   2. SELECT * FROM orders WHERE user_id IN (42);
#   3. SELECT * FROM items WHERE order_id IN (...);
#   4. SELECT items.*, products.* FROM items JOIN products ON ...
#      WHERE items.id IN (...);
# Compare: a 4-way joinedload would multiply rows (user x orders x items
# x products), blowing up the result set and the deserialization cost.
user = (await session.scalars(stmt)).one()
```

**Additional common weak answers:**

- "Use `joinedload` everywhere — it's one query." — for collections, the row multiplication kills you. A user with 100 orders and 10 items per order produces 1000 rows in the result set, all duplicated on the parent.
- "Use `selectinload` everywhere — it's safer." — for many-to-one, you pay an extra round trip you do not need. `joinedload` on a many-to-one produces one row per parent, no multiplication, one query.

**Additional follow-up questions:**

- What is `raiseload`? (Raises on lazy access; useful in tests to catch N+1s. Apply per-query in the test session, or set `lazy="raise"` on the relationship for a global commitment.)
- What is `subqueryload`? (An older form of eager loading using a subquery; `selectinload` is preferred because the IN form produces cleaner SQL and batches better for large parent sets.)

Canonical: [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]].

---

## Q11: What is a detached object? When does an object become detached, and how do you avoid the bug?

### What a strong answer demonstrates

You know detached = the ORM object exists but is no longer associated with a session; attribute access on a detached object for an unloaded relationship or expired attribute raises `DetachedInstanceError`. You know the typical cause (the service returned an ORM object after closing the session) and the fix (return DTOs).

### Model answer

An ORM object's lifecycle is tied to a `Session`. While attached, the session can transparently lazy-load attributes (run a `SELECT` when you access `user.orders`). When detached, that transparency is gone — the session is closed, the connection is gone, and lazy loading is impossible.

An object becomes detached when:

- The session closes (`async with AsyncSession(...) as session:` block exits).
- The object is `expunge`d from the session.
- The session is `close()`d.

The bug:

```python
async def get_user(id: int) -> User:
 async with AsyncSession(engine) as session:
 user = await session.scalar(select(User).where(User.id == id))
 return user # session closes here; user is now detached

# Route:
user = await service.get_user(42)
return UserOut.model_validate(user) # UserOut accesses user.orders — DetachedInstanceError
```

`DetachedInstanceError` is raised when you access an attribute that needs the session (an unloaded relationship or an expired attribute) on a detached object.

**Fixes:**

1. **Eager-load what you need inside the session.** `select(User).options(selectinload(User.orders))`. The attributes are loaded before detachment.
2. **Return a DTO, not an ORM object.** The canonical fix — the service returns a Pydantic model populated from the ORM object inside the session's scope. The route handler works with a plain dict-like object; no session required.
3. **Set `expire_on_commit=False`.** After commit, objects are expired (next access → re-fetch). Setting `False` keeps the in-memory state; combined with eager-loading, the object is usable after session close.

**Warning — In async, detached → `MissingGreenlet`, not `DetachedInstanceError`**

In sync SQLAlchemy, accessing an unloaded attribute on a detached object raises `DetachedInstanceError`. In `AsyncSession`, the same access raises `MissingGreenlet` (because the lazy load would need to await, and there's no event loop in the right context). Same root cause, different symptom — see Q12 and [[07-SQLAlchemy/07-Async-SQLAlchemy]].


**Interviewer's follow-up: "What about accessing the object's primary key after the session closes — does that also raise?"**

No — the primary key is loaded eagerly by SQLAlchemy at query time and stored on the object as a plain attribute. Accessing `user.id` after the session closes works fine (returns the int). The attributes that raise on a detached object are the ones that would require a DB round trip: unloaded relationships (`user.orders` if you didn't `selectinload` them) and expired attributes (everything if `expire_on_commit=True` and you committed). The PK and any eagerly-loaded scalar columns stay. The implication: serializers that only read scalar fields (id, email, name) work fine on detached objects; serializers that walk relationships (`user.orders[0].items`) do not. The fix is to project to a DTO inside the session's scope — see Q11.


### Practical example

```python
# WRONG — return ORM object:
async def get_user(id: int) -> User:
 async with AsyncSession(engine) as session:
 return await session.scalar(select(User).where(User.id == id))
# Route accesses user.orders → DetachedInstanceError

# RIGHT — return DTO:
async def get_user_dto(id: int) -> UserOut:
 async with AsyncSession(engine, expire_on_commit=False) as session:
 stmt = select(User).options(selectinload(User.orders)).where(User.id == id)
 user = await session.scalar(stmt)
 return UserOut.model_validate(user) # built inside the session's scope
```

### Common weak answers

- "Detached means the row was deleted." — it doesn't. The object exists; the session is gone.
- "You can't return ORM objects from services." — you can if you eager-load everything needed; DTOs are still better.
- "Use `session.merge(obj)`." — `merge` re-attaches a detached object to a new session; it doesn't fix the architectural problem.

### Follow-up questions

- What is `session.expunge(obj)`? (Removes the object from the session; it becomes detached.)
- What is `session.make_transient(obj)`? (Removes the object's session association AND primary key — it's now a "new" object you can re-add to a different session.)
- How does `session.merge(obj)` work? (Looks up the object by PK in the session; if found, copies the detached state onto it; if not, inserts. Returns the session's instance.)

**Additional practical example — DTO projection inside session scope:**

```python
from pydantic import BaseModel, ConfigDict

class UserWithOrders(BaseModel):
 model_config = ConfigDict(from_attributes=True)
 id: int
 email: str
 order_count: int
 last_order_id: int | None

async def get_user_with_orders(id: int) -> UserWithOrders:
 async with AsyncSession(engine, expire_on_commit=False) as session:
  # Eager-load inside the session's await context:
  stmt = (
   select(User).options(selectinload(User.orders))
   .where(User.id == id)
  )
  user = (await session.scalars(stmt)).one()
  # Build the DTO inside the session's scope, before it closes:
  return UserWithOrders(
   id=user.id,
   email=user.email,
   order_count=len(user.orders),  # in-memory; no lazy load
   last_order_id=max((o.id for o in user.orders), default=None),
  )
 # Outside the session: the DTO is plain data, no session required.
```

**Additional common weak answers:**

- "Detached means the row was deleted." — it does not; the object exists, the session is gone. The row is in the database; the ORM object just cannot lazy-load anymore.
- "Use `merge`." — `merge` re-attaches a detached object to a new session, but it does not fix the architectural problem of returning ORM objects from services. The fix is to return DTOs.

**Additional follow-up questions:**

- What is `expunge`? (Removes the object from the session; it becomes detached. Useful when you want to pass an object to code that should not accidentally trigger DB access.)
- What is `make_transient`? (Removes the session association AND the primary key; the object is now a "new" instance you can re-add to a different session as if it were freshly constructed.)

Canonical: [[07-SQLAlchemy/05-Session-and-Transaction-Management]].

---

## Q12: What is `MissingGreenlet`, and what does it tell you?

### What a strong answer demonstrates

You know `MissingGreenlet` is the async SQLAlchemy error raised when sync ORM access happens on an `AsyncSession`-loaded object outside the session's await context. You know the typical cause (a service returned an ORM object, the route accessed an unloaded attribute) and that the fix mirrors Q11: return DTOs, eager-load inside the session.

### Model answer

```
sqlalchemy.exc.MissingGreenlet: greenlet_spawn has not been called; can't call
__await__() here. Would the DBAPI be emitting sync style calls without await?
```

This is async SQLAlchemy's way of saying: "you're trying to do a sync ORM operation that would require an await, but you're not in an awaitable context."

The most common cause: a service returned an ORM object after closing the `AsyncSession`, the route handler then accessed an attribute that needed a DB round trip (an unloaded relationship, an expired attribute), and the lazy load couldn't run — there's no event loop in the right context, no greenlet spawned.

Other causes:

- Calling `session.refresh(obj)` or `session.flush()` synchronously on an `AsyncSession` (you must `await` them).
- Accessing a `Mapped` attribute on an unloaded object after the session closed.
- Iterating a lazy `Mapped[list]` outside the session.

**Fixes:**

1. **Eager-load inside the session's await context.** `select(User).options(selectinload(User.orders))`.
2. **Return DTOs from services.** Build the Pydantic model inside the session's scope; return plain data.
3. **Set `expire_on_commit=False`** on the `AsyncSession`. Prevents attribute expiry after commit (which would otherwise require a re-fetch).
4. **Use `AsyncAttrs`** (SQLAlchemy 2.0+) for safe `await obj.awaitable_attrs.orders` access — but this requires the session to still be open.

**Danger — The intermittent version**

`MissingGreenlet` is sometimes intermittent — users with no orders don't trigger the lazy load, so they work; users with orders fail. This is incident 3 in [[Production-Incidents-Debugging]]. The intermittency is a clue: if it works for some inputs and not others, look for lazy loading on data that varies per row.


**Interviewer's follow-up: "How does `AsyncAttrs` actually help here — does it make the lazy load work outside the session?"**

No — `AsyncAttrs` doesn't make lazy loading work outside the session; it makes the failure *explicit and awaitable*. Without `AsyncAttrs`, accessing `user.orders` on a detached `AsyncSession` object tries to do a sync lazy load, fails because there's no greenlet (no event loop in the right context), and raises `MissingGreenlet`. With `AsyncAttrs`, you write `await user.awaitable_attrs.orders` instead — but if the session is closed, this raises a different error (`DetachedInstanceError` or `ResourceClosedError`) that's more direct about the actual problem. `AsyncAttrs` is for the case where the session is *open* and you're in an async context but the standard `user.orders` access doesn't work because the underlying greenlet isn't the session's greenlet. The fix for `MissingGreenlet` is the same as for detached objects: project to a DTO inside the session's scope, eager-loading what you need.


### Practical example

```python
# WRONG:
async def get_user(id: int) -> User:
 async with AsyncSession(engine) as session:
 return await session.scalar(select(User).where(User.id == id))
# Route accesses user.orders → MissingGreenlet

# RIGHT:
async def get_user_dto(id: int) -> UserOut:
 async with AsyncSession(engine, expire_on_commit=False) as session:
 stmt = select(User).options(selectinload(User.orders)).where(User.id == id)
 user = await session.scalar(stmt)
 return UserOut.model_validate(user)
```

### Common weak answers

- "It's a greenlet bug." — it's not; it's your bug. You accessed something async-need outside the await context.
- "Increase the pool size." — pool size is unrelated. You can have a huge pool and still hit `MissingGreenlet`.
- "Use `nest_asyncio`." — a band-aid, not a fix. Restructure the code to keep ORM access inside the session.

### Follow-up questions

- Why is it called `MissingGreenlet`? (Async SQLAlchemy uses greenlets internally to bridge sync ORM code to async DBAPI calls; if the greenlet isn't spawned — because you're outside an `await`able context — the bridge fails.)
- How do you test for this regression? (Use `raiseload(User.orders)` in the test session; lazy accesses raise in tests.)
- What is `AsyncAttrs`? (A 2.0+ mixin that exposes `await obj.awaitable_attrs.orders` for explicit async access.)

**Additional practical example — `raiseload` in the test session:**

```python
# conftest.py: make the test session raise on lazy access for specific
# relationships, so serializers that lazy-load fail tests, not production.

from sqlalchemy.orm import raiseload

@pytest.fixture
async def no_lazy_session():
 async with AsyncSession(test_engine, expire_on_commit=False) as session:
  # Apply raiseload per-query in the test (cleaner than global):
  stmt = (
   select(User).options(raiseload(User.orders))
   .where(User.id == 1)
  )
  yield session, stmt

# Alternatively, set lazy="raise" on the relationship in the model:
class User(Base):
 __tablename__ = "users"
 id: Mapped[int] = mapped_column(primary_key=True)
 # lazy="raise" makes ANY access without explicit eager-loading raise:
 orders: Mapped[list["Order"]] = relationship(lazy="raise")
# This is global, not just tests: a stronger commitment. Use it when
# the team has agreed never to lazy-load orders anywhere.
```

**Additional common weak answers:**

- "It's a greenlet bug." — it is your bug; you accessed something async outside the await context. The greenlet is the bridge SQLAlchemy uses to call sync ORM code from async DBAPI calls; if there is no greenlet, the bridge cannot run.
- "Increase the pool size." — pool size is unrelated. You can have a huge pool and still hit `MissingGreenlet`. The error is about the await context, not about connection availability.

**Additional follow-up questions:**

- Why is it called `MissingGreenlet`? (Async SQLAlchemy uses greenlets internally to bridge sync ORM code to async DBAPI calls. If the greenlet is not spawned — because you are outside an awaitable context — the bridge fails and the error is raised.)
- What is `AsyncAttrs`? (A 2.0+ mixin that exposes `await obj.awaitable_attrs.orders` for explicit async access. It does not make lazy loading work outside the session; it makes the failure explicit and awaitable.)

Canonical: [[07-SQLAlchemy/07-Async-SQLAlchemy]], [[07-SQLAlchemy/05-Session-and-Transaction-Management]].

---

## Q13: Where should transaction boundaries live in a service-layer architecture?

### What a strong answer demonstrates

You know the unit-of-work pattern: the service owns the transaction. The repository does not commit; the route does not commit; the dependency provides the session. You know the failure mode: the route handler commits (or the repository commits per call), and you end up with multiple transactions per "logical operation," breaking atomicity.

### Model answer

The transaction boundary is the unit of work. The canonical placement:

- **Dependency (`get_session`)** — provides the `AsyncSession`; uses `async with session.begin():` so the transaction commits on success, rolls back on exception. The dependency yields the session into the route; the route hands it to the service; the service uses it; the dependency's context manager commits when the dependency's `async with` block exits (after the response).

- **Service** — does not call `commit()`. Uses the session for queries and adds; trusts the dependency (or the route, depending on the architecture) to commit. The service is the *unit of work*'s body — what counts as one logical operation.

- **Repository** — does not call `commit()`. Pure persistence — `add`, `get`, `select`. The repository's job is to translate between domain objects and SQL, not to manage transactions.

- **Route handler** — calls the service; does not commit. (In a thin-handler architecture, the route can own the `begin()` block; in a service-layer architecture, the service does.)

**Tip — The canonical FastAPI + SQLAlchemy 2.x pattern**

```python
async def get_session(engine) -> AsyncSession:
async with AsyncSession(engine, expire_on_commit=False) as session:
async with session.begin(): # commits on success, rolls back on exception
yield session
```
The route is `async def create_user(session: DbSession, ...)`. The service uses `session.add(...)`. The transaction commits when the dependency's `async with session.begin()` block exits — which is *after* the response is sent (because `yield` dependencies resume on response completion).

Caveat: this means commit happens after the response is built. If you need the commit's side effects (e.g., a generated primary key) before the response, `await session.flush()` inside the service, not commit.


**Interviewer's follow-up: "What if I have multiple services called from one route that must be atomic?"**

They must share the same session — declare the session as a dependency of the route and pass it to each service. FastAPI caches the dependency per request (Q2 from [[FastAPI-and-DI-Questions]]), so the same session flows through. Do not let each service open its own session.


### Practical example

```python
# Dependency — owns the transaction:
async def get_session(request: Request) -> AsyncSession:
 engine = request.app.state.engine
 async with AsyncSession(engine, expire_on_commit=False) as session:
 async with session.begin():
 yield session

# Service — does NOT commit:
class UserService:
 def __init__(self, session: AsyncSession):
 self.session = session

 async def create_user(self, payload: SignupIn) -> User:
 user = User(email=payload.email, ...)
 self.session.add(user)
 try:
 await self.session.flush() # get the id, but don't commit
 except IntegrityError as e:
 await self.session.rollback()
 raise EmailAlreadyExists(payload.email) from e
 return user

# Route:
@router.post("/signup", response_model=UserOut, status_code=201)
async def signup(payload: SignupIn, session: DbSession) -> User:
 service = UserService(session)
 user = await service.create_user(payload)
 return user # transaction commits when the dependency's session.begin() block exits
```

### Common weak answers

- "Each repository call commits." — breaks atomicity. If one repository call succeeds and the next fails, the first is already committed.
- "The route commits." — fine in a thin-handler architecture, but in a service-layer architecture, the route shouldn't know about transactions.
- "Use a global session." — breaks per-request isolation. Sessions are per-request, not per-process.

### Follow-up questions

- How do you do nested transactions? (`session.begin_nested()` — a savepoint. The outer transaction can still roll back.)
- What is the unit-of-work pattern? (A class that owns the session and the `begin()` block; the service methods operate within it. See [[05-Project-Architecture/Service-and-Repository-Patterns]].)
- How do you test transactions? (Test with a real DB and assert the row state after the handler; use `rollback()` in the test fixture so tests don't pollute each other. See [[12-Testing-and-Quality/Testing-Database-Logic]].)

**Additional practical example — audit-log with a separate session via `use_cache=False`:**

```python
from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from datetime import datetime, timezone

# An audit-log dependency that opens its own session and commits
# independently. use_cache=False prevents FastAPI from returning the
# cached main-request session when this dep is resolved.
audit_sessionmaker = async_sessionmaker(audit_engine, expire_on_commit=False)

async def get_audit_session() -> AsyncSession:
 async with audit_sessionmaker() as session:
  async with session.begin():
   yield session

audit_session_dep = Depends(get_audit_session, use_cache=False)

@router.post("/orders", response_model=OrderOut, status_code=201)
async def create_order(
 payload: OrderIn,
 session: DbSession,  # main transaction, cached by FastAPI
 audit: AsyncSession = audit_session_dep,  # separate session, NOT cached
):
 order = await service.create_order(session, payload)
 # Audit row in a separate transaction: survives a rollback of the main.
 audit.add(AuditRow(
  action="order_create", target_id=order.id,
  at=datetime.now(timezone.utc),
 ))
 return order
```

**Additional common weak answers:**

- "Each repo call commits." — breaks atomicity. If one repo call succeeds and the next fails, the first is already committed; you cannot roll back the unit of work as a whole.
- "The route commits." — fine in a thin-handler architecture, but in a service-layer architecture the route should not know about transactions. The dependency owns the transaction; the service uses the session.

**Additional follow-up questions:**

- What is the unit-of-work pattern? (A class that owns the session and the `begin()` block; the service methods operate within it. See [[05-Project-Architecture/Service-and-Repository-Patterns]].)
- How do you test transactions? (Test with a real DB and assert the row state after the handler; use `rollback()` in the test fixture so tests do not pollute each other. See [[12-Testing-and-Quality/Testing-Database-Logic]].)

Canonical: [[07-SQLAlchemy/05-Session-and-Transaction-Management]], [[05-Project-Architecture/Service-and-Repository-Patterns]].

---

## Q14: Async SQLAlchemy vs sync SQLAlchemy – when does async win, and when is it overhead?

### What a strong answer demonstrates

You know async SQLAlchemy wins when the app is already async (FastAPI event loop) and the workload is I/O-bound (many concurrent DB calls). You know it loses when the workload is CPU-bound (data processing in Python), when the driver is unreliable, or when the team isn't comfortable with async semantics.

### Model answer

Async SQLAlchemy (`AsyncEngine`, `AsyncSession`, `async_sessionmaker`) uses an async DBAPI driver (`asyncpg` for PostgreSQL). The session's methods are coroutines (`await session.execute(...)`).

**When async wins:**

1. **The app is already async.** FastAPI + asyncio + async HTTP clients (`httpx.AsyncClient`) + async Redis. If everything else is async, sync SQLAlchemy is the only blocking call in the loop — a bottleneck.
2. **Many concurrent DB calls.** An endpoint that fans out 10 independent queries — `gather(query1, query2, ...)` — sees a 10x speedup over sequential sync.
3. **Long-running queries.** Async lets the loop handle other requests while waiting. Sync blocks the worker.

**When async is overhead:**

1. **CPU-bound work in Python.** Async doesn't help CPU-bound; the GIL still serializes. Use sync + multiple processes.
2. **One-shot scripts.** The overhead of `async with engine.begin():` plus the event loop setup isn't worth it for a one-off migration script. Use sync.
3. **Team unfamiliar with async.** Async semantics (`MissingGreenlet`, `await` everywhere, event loop management) have a learning curve. If the team is small or junior, sync + workers may be more maintainable.
4. **Driver reliability.** Async drivers are younger than sync; `asyncpg` is mature, but some features (e.g., prepared statement caching with PgBouncer) have caveats — see Q10 of [[Async-and-Concurrency-Questions]].

**Warning — Don't use async SQLAlchemy "because it's faster"**

It's faster *if* the workload is I/O-bound and concurrent. For a CRUD app with mostly sequential single-row reads, async SQLAlchemy's per-call overhead is comparable to sync. The win is at the event-loop level, not the per-query level.


**Tip — The honest hybrid**

A common production pattern: async SQLAlchemy for the request path (FastAPI + `AsyncSession`), sync SQLAlchemy for migrations and one-shot scripts (Alembic always uses sync). Alembic does not support `AsyncSession` natively; you use `alembic upgrade head` with a sync engine.


**Interviewer's follow-up: "What's the cost of `await session.run_sync(...)` — and when is it the right escape hatch?"**

`run_sync(fn)` parks the call in a threadpool that the `AsyncSession` provides, runs `fn` with a *sync view* of the session, and returns. The cost is one threadpool context switch (~1 ms) plus the cost of `fn` itself. The right use cases: (a) porting a sync library function that takes a sync `Session` (e.g., a third-party reporting library) without rewriting it; (b) running complex sync SQLAlchemy operations (e.g., `session.query(...).filter(...)` legacy code) inside an async handler without converting to `select()`; (c) calling a sync bulk-insert helper. The wrong use case: a hot-path query — the threadpool context switch adds 1 ms per call, which over 1000 requests is 1 second of overhead. For hot paths, port to `select()` and `await session.execute(...)`. `run_sync` is a migration tool, not a permanent solution.


### Practical example

```python
# Async engine + session:
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker

engine = create_async_engine("postgresql+asyncpg://...", pool_size=10, pool_pre_ping=True)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)

# Sync engine + session (for Alembic, scripts):
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

sync_engine = create_engine("postgresql+psycopg://...", pool_size=5)
with Session(sync_engine) as session:
 ...
```

### Common weak answers

- "Async is always faster." — only for I/O-bound concurrent workloads.
- "Async requires a different ORM." — it doesn't. Same `DeclarativeBase`, same `Mapped`, same `select()`. Only the session and engine are different.
- "You can't use Alembic with async." — you can, but Alembic runs sync internally; configure `sqlalchemy.url` with a sync driver for migrations.

### Follow-up questions

- What is `async_sessionmaker`? (2.x's factory for `AsyncSession`; mirrors `sessionmaker`.)
- How do you set up the engine in a lifespan? (See Q1 — `app.state.engine = create_async_engine(...)` in the lifespan startup.)
- What is `run_sync` on `AsyncSession`? (`await session.run_sync(sync_function)` — runs a sync function in a threadpool with a sync-style session; useful for code that uses sync APIs.)

**Additional practical example — `run_sync` as the legacy escape hatch:**

```python
# run_sync parks the call in a threadpool that the AsyncSession provides,
# runs a sync function with a sync view of the session, and returns.

def legacy_reporting_fn(session: Session) -> list[dict]:
 # A third-party reporting library that takes a sync Session.
 # You do not want to rewrite it; you just need it to work in your
 # async handler.
 return session.query(Order).filter(Order.created_at >= "2026-01-01").all()

@router.get("/reports/orders")
async def report(session: DbSession) -> list[dict]:
 # run_sync bridges sync -> async with a threadpool context switch.
 # Cost: ~1 ms per call. Right for one-off reports; wrong for hot paths.
 rows = await session.run_sync(legacy_reporting_fn)
 return rows

# For hot paths, port legacy_reporting_fn to `select()` plus
# await session.execute(...). The threadpool switch adds 1 ms per call;
# over 1000 requests, that is 1 second of avoidable overhead.
```

**Additional common weak answers:**

- "Async is always faster." — only for I/O-bound concurrent workloads. For a CRUD app with mostly sequential single-row reads, async SQLAlchemy's per-call overhead is comparable to sync; the win is at the event-loop level, not the per-query level.
- "Async requires a different ORM." — it does not. Same `DeclarativeBase`, same `Mapped`, same `select()`. Only the session and engine are different (`AsyncSession` / `create_async_engine`).

**Additional follow-up questions:**

- What is `async_sessionmaker`? (2.x's factory for `AsyncSession`; mirrors `sessionmaker`. Use it in the lifespan to create a session per request.)
- How do you set up the engine in a lifespan? (`app.state.engine = create_async_engine(...)` in the lifespan startup; `await app.state.engine.dispose()` in teardown. See Q1 of [[FastAPI-and-DI-Questions]].)

Canonical: [[07-SQLAlchemy/07-Async-SQLAlchemy]], [[07-SQLAlchemy/02-Engines-Connections-Pools]].

---

## Cross-references

- [[00-Interview-MOC]] — study strategy and the four failure modes.
- [[FastAPI-and-DI-Questions]] — Q4 (yield cleanup), Q11 (background tasks limits), Q12 (sync driver in async dependency), Q13 (testing auth).
- [[Async-and-Concurrency-Questions]] — Q11 (async vs sync SQLAlchemy trade-offs in more depth), Q12 (`MissingGreenlet` narrative).
- [[Production-Incidents-Debugging]] — Incident 1 (N+1), Incident 3 (`MissingGreenlet`), Incident 6 (pool exhaustion).
- [[20-Exercises-and-Labs/Debugging-Labs]] — Lab 1 (N+1 in a serializer), Lab 2 (sync DB call inside `async def`).
- [[22-Diagrams/SQLAlchemy-Session-Flow]] — the canonical session lifecycle that Q5, Q6, Q7, Q11, Q12 reference.

## Verification

Each question's "Practical example" block is runnable as-is. To verify your model answer actually runs, scaffold a minimal SQLAlchemy + FastAPI project and exercise the patterns.

```bash
uv init sqlalchemy-sessions-lab
cd sqlalchemy-sessions-lab
uv add fastapi==0.148.0 'uvicorn[standard]' sqlalchemy==2.1.5 'asyncpg' pydantic==2.14.1
uv add --dev pytest pytest-asyncio httpx aiosqlite
docker compose up -d postgres  # postgres:17-alpine
```

For Q1 (`DeclarativeBase` vs legacy `declarative_base`), Q2 (`Mapped`/`mapped_column`), paste the practical example into `app/models/user.py` and verify import + a SELECT round-trip:

```bash
uv run python -c "
from app.models.user import User
from sqlalchemy.orm import DeclarativeBase
from app.deps import engine
import asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

async def main():
    async with AsyncSession(engine) as s:
        result = (await s.scalars(select(User).limit(1))).first()
        print('OK:', result)
asyncio.run(main())
"
# Expected: prints 'OK: <User object at 0x...>' (or 'OK: None' on an empty table).
# If you see 'AttributeError: Session has no attribute query', you used the legacy API — re-read Q3.
```

For Q5 (identity map), Q6 (autoflush), Q7 (flush vs commit), use the SQLAlchemy echo flag and observe:

```bash
uv run python -c "
import asyncio
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
# Enable echo to watch SQL as it is sent.
engine = create_engine('sqlite://', echo=True)
# (paste the Q5/Q6/Q7 example here)
"
# Expected: you can see the INSERT before the SELECT (autoflush),
# and the SELECT-after-commit (object expiration).
```

For Q9 (N+1) and Q10 (`selectinload` vs `joinedload`), the query-count instrumentation from the canonical lesson [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]]:

```bash
uv run python -c "
from sqlalchemy import event
# (paste the Q9 buggy code, then the Q10 fix)
# Buggy: ~101 SQL lines. Fixed: 3.
"
```

For Q12 (`MissingGreenlet`), trigger it on purpose to internalise the failure mode:

```bash
uv run python -c "
import asyncio
from app.deps import engine
from app.services.users import get_user
from sqlalchemy.ext.asyncio import AsyncSession

async def main():
    user = await get_user(1)  # returns ORM object after closing session
    print(user.orders)  # Expected: sqlalchemy.exc.MissingGreenlet
asyncio.run(main())
"
# Expected: the traceback mentions __await__, not pool. Re-read the diagnosis path of Incident 3
# in [[Production-Incidents-Debugging]] if you mis-diagnose this as a pool problem.
```

If the commands above produce the output you predicted, you have rehearsed the mechanism — not just memorised the phrase "identity map" or "MissingGreenlet". If they do not, re-read the relevant Q's model answer; the gap is in your mental model of the SQL the ORM emits, not in your recall of the term.

## Sources

- SQLAlchemy 2.x documentation — https://docs.sqlalchemy.org/en/20/ — 2026-10-15 — `DeclarativeBase`, `Mapped`/`mapped_column`, `select()`, `AsyncSession`, `MissingGreenlet`, identity map, autoflush.
- Verified version: SQLAlchemy 2.1.5 — per [[21-Reference-Library/Source-Register]].

---
title: "Lesson 06: Querying with select()"
aliases:
 - Querying with select
 - SQLAlchemy Queries
 - select and Session.execute
 - scalars and scalar_one
 - CTEs and Subqueries
tags:
 - sqlalchemy
 - orm
 - querying
 - select
 - lesson
course_level: intermediate
status: complete
difficulty: intermediate
estimated_time: "120–150 minutes"
prerequisites:
 - "[[03-Declarative-Base-and-Mapped]]"
 - "[[05-Session-and-Transaction-Management]]"
 - "[[06-SQL-Fundamentals/Relational-Model-and-Constraints]]"
 - "[[06-SQL-Fundamentals/SQL-Injection-and-Parameterized-Queries]]"
related_lessons:
 - "[[04-Relationships-and-Loading-Strategies]]"
 - "[[05-Session-and-Transaction-Management]]"
 - "[[07-Async-SQLAlchemy]]"
 - "[[08-Advanced-ORM]]"
---

# Lesson 06: Querying with `select()`

*`select()`, `Session.execute()`, `Session.scalars()`, the result-shape methods, `where`/`order_by`/`limit`/`offset`/`join`/`group_by`/`having`, subqueries and CTEs, window functions, bulk `insert`/`update`/`delete`, raw SQL with `text()`, composable filters, and inspecting generated SQL. `Boardly` grows `boardly/queries.py` here.*

**You've reached the most practical layer.**

Every endpoint in `Boardly` will eventually be a `select()` call wrapped in a session. Today we cover the full query API: filtering, joining, grouping, CTEs, window functions, bulk operations, and the safe way to run raw SQL. The N+1 trap from Lesson 04 reappears here as a query-options problem — you will see it from the `select()` side. Take your time. Trace every SQL statement in the `echo` log. **This is the layer where most production queries are written.**


#sqlalchemy #orm #querying #select

## Learning Objectives

By the end of this lesson you will be able to:

1. **Build `select()` statements** with `where`, `order_by`, `limit`, `offset`, `join`, `outerjoin`, `group_by`, `having`, and chain them in any order.
2. **Use `Session.execute()` and `Session.scalars()`** and articulate the difference (execute returns `Result` rows; scalars returns scalar values from the first column).
3. **Choose the right result-shape method** — `scalar_one`, `scalar_one_or_none`, `one`, `one_or_none`, `first`, `all` — based on your expectation of cardinality.
4. **Compose boolean expressions** with `&` (AND), `|` (OR), `~` (NOT), and learn when to use `and_`/`or_`/`not_` instead.
5. **Aggregate and group** with `func.count`, `func.sum`, `func.max`, `group_by`, `having`.
6. **Write CTEs and subqueries** with `select(...).cte("name")` and `select(...).subquery()`, and know when to prefer which.
7. **Use window functions** like `func.row_number().over(partition_by=...)` for ranked queries.
8. **Run bulk `insert`, `update`, `delete`** via Core for performance.
9. **Execute raw SQL safely** with `text()` and bound parameters, and articulate why this is the only safe way to run raw SQL.
10. **Compose reusable filters** as functions returning `ColumnElement[bool]` for clean repository code.
11. **Inspect generated SQL** with `compile(engine)` and `echo=True`.

## Prerequisites

- **Lesson 03 — Declarative Base and Mapped.** Queries operate on mapped classes; you must know what `Project`, `User`, etc. look like.
- **Lesson 05 — Session and Transaction Management.** Queries run inside a session; the session's `execute` is the entry point.
- **Lesson 04 — Relationships and Loading Strategies.** Eager-loading strategies (`selectinload`, `joinedload`) are query options you pass to `select()`.
- **SQL literacy** — [[06-SQL-Fundamentals/Relational-Model-and-Constraints]]. You should be able to read `SELECT ... JOIN ... GROUP BY ... HAVING`.
- **SQL injection** — [[06-SQL-Fundamentals/SQL-Injection-and-Parameterized-Queries]]. The ORM's defense is bound parameters; the `text()` escape hatch inherits the same defense.
- **About 2 hours of focused time.** This lesson has the most code of any lesson in the section because every query pattern gets its own snippet.

**The most common gap: thinking `select()` returns results.**

It does not. `select(Model)` builds a `Select` object — a Python representation of a SQL query. To actually execute it, you pass it to `session.execute(...)`, which returns a `Result`. The `Result` is iterable; calling `.scalars()` or `.all()` or `.first()` on it fetches the rows. The split between building and executing is the whole point: you can compose, inspect, and parameterize the `Select` object without touching the database.


## The Problem

Your `Boardly` API needs queries like:
- "List projects in organization X, ordered by name, paginated 20 per page."
- "Find the user with email X." (Expected: one row, or none.)
- "For each organization, count its projects, sorted by count descending."
- "Find tasks assigned to user X that are not done, with the project name and the number of comments."
- "Bulk-update all tasks in project X to status 'archived'." (One SQL statement, not N.)
- "Run this hand-tuned SQL for the analytics dashboard, safely."

Each of these is a different query pattern. SQLAlchemy 2.x gives you `select()` for the first five and `text()` for the sixth. This lesson covers all six.

## The Code

Here is `boardly/queries.py` — the query helpers for `Boardly`. It builds composable filters, demonstrates every result-shape method, and includes a small CTE example.

```python
# boardly/queries.py
"""Boardly — query helpers and composable filters.

Lesson 06: select(), result-shape methods, joins, aggregation, CTEs,
window functions, bulk operations, raw SQL with text().
"""
from __future__ import annotations

import uuid
from typing import Optional

from sqlalchemy import and_, func, or_, select, text, update
from sqlalchemy.sql import ColumnElement
from sqlalchemy.sql.expression import Select

from boardly.models import (
 Comment,
 Membership,
 Organization,
 Project,
 Task,
 User,
)
from sqlalchemy.orm import Session


# ---------------------------------------------------------------------------
# Composable filters — each returns a ColumnElement[bool] you can & together.
# ---------------------------------------------------------------------------
def project_in_org(org_id: uuid.UUID) -> ColumnElement[bool]:
 return Project.organization_id == org_id


def project_slug(slug: str) -> ColumnElement[bool]:
 return Project.slug == slug


def task_open() -> ColumnElement[bool]:
 return Task.status != "done"


def task_assigned_to(user_id: uuid.UUID) -> ColumnElement[bool]:
 return Task.assignee_id == user_id


# ---------------------------------------------------------------------------
# Query builders — each returns a Select object (not yet executed).
# ---------------------------------------------------------------------------
def list_projects_in_org(
 org_id: uuid.UUID,
 *,
 offset: int = 0,
 limit: int = 20,
) -> Select:
 return (
 select(Project)
 .where(project_in_org(org_id))
 .order_by(Project.name)
 .offset(offset)
 .limit(limit)
 )


def find_project_by_slug(org_id: uuid.UUID, slug: str) -> Select:
 return (
 select(Project)
 .where(project_in_org(org_id), project_slug(slug))
 )


def find_user_by_email(email: str) -> Select:
 return select(User).where(User.email == email)


def open_tasks_for_user(user_id: uuid.UUID) -> Select:
 return (
 select(Task)
 .where(and_(
 task_assigned_to(user_id),
 task_open(),
 ))
 .order_by(Task.created_at.desc())
 )


def tasks_with_project_and_comment_count(user_id: uuid.UUID) -> Select:
 """For each open task assigned to user, return task + project name + comment count."""
 comment_count = (
 select(func.count(Comment.id))
 .where(Comment.task_id == Task.id)
 .correlate(Task)
 .scalar_subquery()
 .label("comment_count")
 )
 return (
 select(Task, Project.name.label("project_name"), comment_count)
 .join(Project, Project.id == Task.project_id)
 .where(and_(task_assigned_to(user_id), task_open()))
 .order_by(Task.created_at.desc())
 )


def project_counts_by_organization() -> Select:
 """For each organization, count its projects. Sorted by count desc."""
 return (
 select(
 Organization.id.label("org_id"),
 Organization.display_name.label("org_name"),
 func.count(Project.id).label("project_count"),
 )
 .join(Project, Project.organization_id == Organization.id)
 .group_by(Organization.id, Organization.display_name)
 .having(func.count(Project.id) > 0)
 .order_by(func.count(Project.id).desc())
 )


def top_projects_by_task_count(n: int = 5) -> Select:
 """Top N projects by task count, using a window function."""
 subq = (
 select(
 Project.id.label("project_id"),
 Project.name.label("project_name"),
 func.count(Task.id).over(partition_by=Project.id).label("task_count"),
 func.row_number().over(
 order_by=func.count(Task.id).desc(),
 partition_by=Project.id,
 ).label("rn"),
 )
 .join(Task, Task.project_id == Project.id)
 ).subquery()

 return (
 select(
 subq.c.project_id,
 subq.c.project_name,
 subq.c.task_count,
 )
 .where(subq.c.rn == 1)
 .order_by(subq.c.task_count.desc())
 .limit(n)
 )


def tasks_per_project_cte() -> Select:
 """Use a CTE to compute tasks-per-project, then join back."""
 cte = (
 select(
 Task.project_id.label("project_id"),
 func.count(Task.id).label("task_count"),
 )
 .group_by(Task.project_id)
 .cte("task_counts")
 )
 return (
 select(Project.id, Project.name, cte.c.task_count)
 .join(cte, cte.c.project_id == Project.id)
 .order_by(cte.c.task_count.desc())
 )


# ---------------------------------------------------------------------------
# Bulk operations — Core-level UPDATE / DELETE for performance.
# ---------------------------------------------------------------------------
def archive_all_tasks_in_project(session: Session, project_id: uuid.UUID) -> int:
 """UPDATE tasks SET status='archived' WHERE project_id=? AND status<>'done'.
 Returns the number of rows updated."""
 stmt = (
 update(Task)
 .where(Task.project_id == project_id)
 .where(Task.status != "done")
 .values(status="archived")
 )
 result = session.execute(stmt)
 return result.rowcount


# ---------------------------------------------------------------------------
# Raw SQL with bound parameters — the only safe way to run hand-tuned SQL.
# ---------------------------------------------------------------------------
def search_users_by_email_fragment(session: Session, fragment: str) -> list[User]:
 """Run a hand-tuned ILIKE query. The :fragment parameter is bound, not
 string-interpolated — this is SQL-injection-safe."""
 stmt = text("""
 SELECT * FROM users
 WHERE email ILIKE :fragment
 ORDER BY email
 """)
 rows = session.execute(stmt, {"fragment": f"%{fragment}%"}).all()
 # Convert raw rows into User instances by mapping through the identity map.
 return [session.get(User, row.id) for row in rows]


# ---------------------------------------------------------------------------
# Smoke test.
# ---------------------------------------------------------------------------
def main() -> None:
 from sqlalchemy import create_engine
 from sqlalchemy.orm import sessionmaker

 from boardly.models import Base
 from boardly.db import get_default_url

 engine = create_engine(get_default_url(), echo=False)
 Base.metadata.create_all(engine)
 SessionLocal = sessionmaker(engine, expire_on_commit=False)

 with SessionLocal() as session:
 # Seed
 org = Organization(slug="boardly", display_name="Boardly")
 user = User(
 email="ada@example.com",
 hashed_password="not-a-real-hash",
 display_name="Ada Lovelace",
 home_org_id=org.id,
 )
 project = Project(
 organization_id=org.id, owner_id=user.id,
 name="Q4 Launch", slug="q4-launch",
 )
 task = Task(project_id=project.id, title="Ship the demo")
 session.add_all([org, user, project, task])
 session.commit()

 # Result-shape methods
 one_project = session.execute(find_project_by_slug(org.id, "q4-launch")).scalar_one_or_none()
 print(f"scalar_one_or_none: {one_project}")

 all_projects = session.execute(list_projects_in_org(org.id)).scalars().all()
 print(f"all: {all_projects}")

 # Bulk update
 n = archive_all_tasks_in_project(session, project.id)
 print(f"archived {n} tasks")

 # Raw SQL with bound params
 users = search_users_by_email_fragment(session, "ada")
 print(f"raw search: {users}")


if __name__ == "__main__":
 main()
```

That's about 230 lines. Save it as `boardly/queries.py` and run it. Then read the line-by-line below — every query pattern gets its own analysis.

## Line-by-Line Deep Dive

This is the heart of the lesson. Read it twice. The `select()` API is the most-overloaded in SQLAlchemy after the session API.

### Lines 1–25: The module docstring and imports

```python
"""Boardly — query helpers and composable filters.
..."""
from __future__ import annotations

import uuid
from typing import Optional

from sqlalchemy import and_, func, or_, select, text, update
from sqlalchemy.sql import ColumnElement
from sqlalchemy.sql.expression import Select

from boardly.models import (
 Comment,
 Membership,
 Organization,
 Project,
 Task,
 User,
)
from sqlalchemy.orm import Session
```

**What it does:** Pulls in the SQL expression builders (`and_`, `func`, `or_`, `select`, `text`, `update`), the typing primitives (`ColumnElement`, `Select`), the models, and the `Session`.

**Why each:**

- `and_, or_` — the function forms of `&` and `|`. Useful when you have a variable-length list of conditions (`and_(*conditions)`). The `&` / `|` operators are fine for two conditions but harder to compose.
- `func` — the SQL function factory. `func.count(...)`, `func.sum(...)`, `func.max(...)`, `func.now()`, and any database function (`func.json_agg(...)` on Postgres). `func.X` renders to `X(...)` in SQL.
- `select` — the SELECT statement builder. The 2.x canonical form (replaces the legacy `Query` object).
- `text` — the raw-SQL wrapper. Only safe way to run hand-tuned SQL.
- `update` — the UPDATE statement builder for bulk updates.
- `ColumnElement` — the type annotation for "any SQL expression that returns a value". Filter functions return `ColumnElement[bool]`.
- `Select` — the type of the object returned by `select(...)`. We use it as the return type of our query-builder functions, so callers know they get a `Select` (not yet executed).
- `Session` — for the `Session` type annotation on bulk operations.

**Warning — The unused `Optional` import is a CI gate, not a code-style footnote.**

Line 95 imports `Optional` from `typing`, but no function in this module returns `Optional[...]` — every query builder returns `Select` (or `int` for the bulk-update helper). The `ruff` `F401` rule ("imported but unused") flags this; with `select = ["F"]` in `ruff.toml`, the CI build fails on the first commit that introduces an unused symbol. The fix is to drop the import. The deeper issue: an unused import in a 200-line query module is a code smell that survives code review when reviewers trust the diff — an unfinished refactor leaves the import behind as a fossil. Treat the lint failure as a security boundary; do not silence it with `# noqa: F401` unless you are explicitly deferring the refactor to a tracked ticket.


**Tip — Why return `Select` from query builders, not `list[Model]`?**

Because the caller might want to add `.where(...)`, `.options(selectinload(...))`, or `.limit(...)` before executing. Returning an already-executed list forces the caller to re-query if they need to refine. Returning the `Select` object keeps composition flexible. Lesson 08 (Repository Pattern) discusses the trade-off in more depth.


### Lines 33–47: Composable filter functions

```python
def project_in_org(org_id: uuid.UUID) -> ColumnElement[bool]:
 return Project.organization_id == org_id


def project_slug(slug: str) -> ColumnElement[bool]:
 return Project.slug == slug


def task_open() -> ColumnElement[bool]:
 return Task.status != "done"


def task_assigned_to(user_id: uuid.UUID) -> ColumnElement[bool]:
 return Task.assignee_id == user_id
```

**What it does:** Each function returns a `ColumnElement[bool]` — a Python object representing a SQL boolean expression (e.g., `projects.organization_id = ?`).

**Why this pattern:** It lets you compose filters as Python functions. A caller writes:

```python
stmt = (
 select(Task)
 .where(and_(
 task_assigned_to(user_id),
 task_open(),
 ))
)
```

The filters are reusable: `task_open()` appears in any query that filters by open tasks. The alternative — inlining `Task.status != "done"` everywhere — duplicates the definition of "open" and is fragile when the definition changes.

**Why the `==` and `!=` operators work on columns:** SQLAlchemy overloads them on `Column` objects. `Project.slug == "x"` does not return a bool — it returns a `BinaryExpression` (a SQL comparison object). When you pass it to `.where(...)`, SQLAlchemy renders it as `WHERE projects.slug = ?` and binds the value `x` as a parameter.

**Production reality: every tenant-scoped query must include `project_in_org(org_id)`.**

`Boardly` is multi-tenant — every `Project`, `Task`, and `Comment` row belongs to an organization. A service-layer bug that forgets to add `.where(project_in_org(org_id))` to a `select(...)` is a cross-tenant data leak: the query returns rows from every org, and the response serializes them to the caller. The rule: every tenant-scoped `select(...)` must include `project_in_org(org_id)` (or its equivalent) as a defensive filter, even when the caller's auth context already guarantees the org. The defense in depth is a Postgres Row-Level Security policy on `projects.organization_id` that catches the leak at the database; the RLS policy is the boundary the ORM filter cannot accidentally remove. Without RLS, the ORM filter is the only defense — and a forgotten `.where(...)` is one diff away. See [[17-Advanced-Architecture/Multi-Tenancy]] for the tenant-isolation patterns and [[06-SQL-Fundamentals/SQL-Injection-and-Parameterized-Queries]] for the bound-parameter side.


**Why `ColumnElement[bool]` and not `bool`?**

The annotation says "this returns a SQL expression that evaluates to a boolean", not "this returns a Python bool". `ColumnElement[bool]` is a generic on `ColumnElement` — the type parameter documents that the SQL expression's result type is boolean. Mypy and Pyright understand this and will warn you if you try to use the return value as a Python bool (e.g., `if task_open(): ...`).


### Lines 53–62: `list_projects_in_org` (basic query with `where`, `order_by`, `offset`, `limit`)

```python
def list_projects_in_org(
 org_id: uuid.UUID,
 *,
 offset: int = 0,
 limit: int = 20,
) -> Select:
 return (
 select(Project)
 .where(project_in_org(org_id))
 .order_by(Project.name)
 .offset(offset)
 .limit(limit)
 )
```

**What it does:** Builds a `SELECT` for `Project` rows filtered by `organization_id`, ordered by `name`, paginated with `offset` and `limit`.

**Why each method:**

- `select(Project)` — builds `SELECT projects.id, projects.organization_id, ... FROM projects`. The argument is the mapped class; SQLAlchemy expands it to all columns.
- `.where(project_in_org(org_id))` — adds `WHERE projects.organization_id = ?` and binds `org_id` as a parameter.
- `.order_by(Project.name)` — adds `ORDER BY projects.name ASC`. (For descending, use `.order_by(Project.name.desc())`.)
- `.offset(offset)` — adds `OFFSET ?` for pagination. (Combined with `limit`, this is the standard SQL pagination pattern. For large offsets, consider keyset pagination instead — see the trade-offs section.)
- `.limit(limit)` — adds `LIMIT ?`.

**Chain order does not matter:** `.where(...).order_by(...).limit(...)` produces the same SQL as `.limit(...).where(...).order_by(...)`. SQLAlchemy normalizes the order when it compiles.

**Student asks: how do I get the SQL string out of a `Select`?**

```python
stmt = list_projects_in_org(org_id)
print(stmt) # calls __str__, compiles with the DEFAULT dialect (:name parameter style)
print(stmt.compile(engine)) # explicit: compile against the engine's dialect
print(stmt.compile(engine, compile_kwargs={"literal_binds": True})) # inline the params
```
`str(stmt)` (i.e., `print(stmt)`) renders with the default dialect — the `:name` named-parameter style, regardless of the engine you later execute against. To render dialect-specific SQL (`?` for SQLite, `%(name)s` for psycopg, `::uuid` casts on Postgres, etc.), pass the engine or the dialect to `compile(...)`. The third form is great for debugging — it renders the SQL with the actual values inline, so you can copy-paste it into a SQL client. **Never use literal_binds for execution** — it bypasses parameter binding and exposes you to SQL injection.

Once you can read the SQL, the next step is reading the **planner's view** of that SQL — the cost model, the chosen access path (`Seq Scan` vs `Index Scan` vs `Bitmap Heap Scan`), and the actual row counts. That is the canonical `EXPLAIN ANALYZE` concept, first taught in [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]] and reused in [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]] when you hunt N+1 and slow queries in production. Lesson 06 ends where those lessons begin: the `Select` object you build here is the input the planner sees.


**Warning — `echo=True` in production is a PII leak, not a debugging convenience.**

`create_engine(url, echo=True)` logs every SQL statement AND its bound parameters to the engine's default logger (Python's `logging` root, level `INFO`). For an auth endpoint, that means `WHERE users.email = 'ada@example.com'` AND `WHERE users.hashed_password = '$2b$12$...'` land in Stackdriver / Datadog / the ELK stack alongside the application logs. The log retention policy is part of the security boundary under GDPR — a 90-day production log with raw password hashes is a privacy incident. The production configuration is `echo=False` (the default); the debugging path is `compile(engine, compile_kwargs={"literal_binds": True})` in tests, OR a structured-logging SQL logger that redacts bound parameters (or hashes them) before emission. The `BOARDLY_SQL_ECHO` env-var pattern (default `False`, opt-in via `True`) is the safe toggle; never hardcode `echo=True` in `core/db.py`. See [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]] for the SQL-log redaction pattern.


### Lines 65–69: `find_project_by_slug` (composing multiple filters)

```python
def find_project_by_slug(org_id: uuid.UUID, slug: str) -> Select:
 return (
 select(Project)
 .where(project_in_org(org_id), project_slug(slug))
 )
```

**What it does:** Builds a `SELECT` for `Project` rows filtered by both `organization_id` AND `slug`.

**Why multiple positional args to `where`:** `.where(a, b, c)` is equivalent to `.where(and_(a, b, c))`. SQLAlchemy ANDs them together. For OR, use `.where(or_(a, b, c))`. For mixed, nest.

### Lines 72–74: `find_user_by_email`

```python
def find_user_by_email(email: str) -> Select:
 return select(User).where(User.email == email)
```

Single-filter query. Used like:

```python
user = session.execute(find_user_by_email("ada@example.com")).scalar_one_or_none()
```

**Danger — `find_user_by_email` returns soft-deleted users.**

The query is `select(User).where(User.email == email)` — there is no `where(User.deleted_at.is_(None))` filter. If the `User` model has a `deleted_at` soft-delete column (the `Boardly` convention), the auth-login flow that calls this returns the user even after the account was deactivated. The result: a deleted user can still log in. The fix: either add `where(User.deleted_at.is_(None))` inside the query builder, or compose it at the call site: `session.execute(find_user_by_email(email).where(User.deleted_at.is_(None)))`. The defense in depth: a partial index `CREATE INDEX ix_users_email_active ON users (email) WHERE deleted_at IS NULL` makes the active-user lookup fast AND documents the contract at the schema level — but only the ORM filter (or a Postgres RLS policy on `deleted_at`) prevents the leak. See [[11-Authentication-and-Security/Password-Hashing]] for the password-side counterpart and [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]] for the token-issuance path that must NOT issue a token to a soft-deleted user.


### Lines 77–84: `open_tasks_for_user` (using `and_`, `order_by`)

```python
def open_tasks_for_user(user_id: uuid.UUID) -> Select:
 return (
 select(Task)
 .where(and_(
 task_assigned_to(user_id),
 task_open(),
 ))
 .order_by(Task.created_at.desc())
 )
```

Two-filter composition with `and_`. Descending order via `.desc()`. The `and_` is technically redundant (you could pass both as positional args to `where`), but it makes the AND explicit and lets you swap for `or_` if the requirement changes.

### Lines 87–102: `tasks_with_project_and_comment_count` (joins and correlated subqueries)

```python
def tasks_with_project_and_comment_count(user_id: uuid.UUID) -> Select:
 comment_count = (
 select(func.count(Comment.id))
 .where(Comment.task_id == Task.id)
 .correlate(Task)
 .scalar_subquery()
 .label("comment_count")
 )
 return (
 select(Task, Project.name.label("project_name"), comment_count)
 .join(Project, Project.id == Task.project_id)
 .where(and_(task_assigned_to(user_id), task_open()))
 .order_by(Task.created_at.desc())
 )
```

**What it does:** For each open task assigned to `user_id`, returns the task, the project name, and the comment count (computed via a correlated subquery).

**Why each piece:**

- `select(func.count(Comment.id)).where(Comment.task_id == Task.id)` — a subquery that counts comments for a specific task. The `Comment.task_id == Task.id` references the *outer* query's `Task` table, which is why this is a "correlated" subquery.
- `.correlate(Task)` — tells SQLAlchemy "this subquery references the outer `Task` table; do not include `Task` in the subquery's FROM clause". Without `.correlate(Task)`, SQLAlchemy would emit `FROM comments, tasks` in the subquery and you would get the wrong result.
- `.scalar_subquery()` — converts the SELECT into a scalar subquery (one row, one column). Used as a column in the outer SELECT.
- `.label("comment_count")` — names the column `comment_count` in the result rows.
- `select(Task, Project.name.label("project_name"), comment_count)` — three columns: the Task row, the project name (aliased), and the subquery.
- `.join(Project, Project.id == Task.project_id)` — adds `JOIN projects ON projects.id = tasks.project_id`. The second argument is the join condition.
- `.where(...)` and `.order_by(...)` — as before.

**Generated SQL (roughly):**

```sql
SELECT tasks.id, tasks.project_id, ..., projects.name AS project_name,
 (SELECT count(comments.id) FROM comments WHERE comments.task_id = tasks.id) AS comment_count
FROM tasks JOIN projects ON projects.id = tasks.project_id
WHERE tasks.assignee_id = ? AND tasks.status <> 'done'
ORDER BY tasks.created_at DESC
```

**Why a correlated subquery and not a JOIN with COUNT?**

A JOIN with `COUNT(comments.id)` would group by all task columns (you would need `group_by(Task.id, Task.title, ...)`), and the result would include zero rows for tasks with no comments if you used INNER JOIN, or duplicate task rows for tasks with N comments if you forgot the GROUP BY. The correlated subquery is cleaner — one row per task, with the count as a column.

The trade-off is performance: correlated subqueries execute once per outer row. For 1000 tasks, that is 1000 sub-executions. For high-volume queries, prefer a JOIN + GROUP BY or a CTE (see below).


**Production reality: the slow-query log surfaces the correlated subquery as "n fast calls, each <1ms".**

The production signature of a correlated-subquery performance regression is not "one slow query" — it is "1 000 fast queries, each 0.4ms". Postgres's `pg_stat_statements` view shows the comment-count subquery called 1 000 times in the same 30ms window; the APM trace shows it as a single hot span with 1 000 children. The instinct is to ignore the trace because each call is under 1ms — but the aggregate wall-time is 400ms, which dominates the request. The fix is the JOIN + GROUP BY rewrite (or the CTE form below); the post-fix trace shows one ~2ms call to a `HashAggregate` node. The plan-reading vocabulary to confirm the rewrite is in [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]] and the production-hunting playbook is in [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]].


### Lines 105–117: `project_counts_by_organization` (aggregation and `group_by`/`having`)

```python
def project_counts_by_organization() -> Select:
 return (
 select(
 Organization.id.label("org_id"),
 Organization.display_name.label("org_name"),
 func.count(Project.id).label("project_count"),
 )
 .join(Project, Project.organization_id == Organization.id)
 .group_by(Organization.id, Organization.display_name)
 .having(func.count(Project.id) > 0)
 .order_by(func.count(Project.id).desc())
 )
```

**What it does:** For each organization, count its projects, sorted by count descending, filtering out orgs with zero projects.

**Generated SQL (roughly):**

```sql
SELECT organizations.id AS org_id, organizations.display_name AS org_name,
 count(projects.id) AS project_count
FROM organizations JOIN projects ON projects.organization_id = organizations.id
GROUP BY organizations.id, organizations.display_name
HAVING count(projects.id) > 0
ORDER BY count(projects.id) DESC
```

**Why each:**

- `select(Organization.id.label("org_id"), ...)` — selects specific columns (not full rows). Each `.label("...")` aliases the column.
- `func.count(Project.id).label("project_count")` — `COUNT(projects.id) AS project_count`.
- `.join(Project, ...)` — JOIN to projects.
- `.group_by(Organization.id, Organization.display_name)` — GROUP BY both org columns. Postgres requires every selected non-aggregate column to appear in GROUP BY.
- `.having(func.count(Project.id) > 0)` — HAVING clause filters on the aggregated value (not on individual rows).
- `.order_by(func.count(Project.id).desc())` — ORDER BY the count.

**Tip — `having` vs `where`.**

`where` filters rows before aggregation; `having` filters groups after aggregation. If you want "organizations with more than 5 projects", use `having`. If you want "organizations where the slug starts with 'a'", use `where` (the filter applies to the org row before the join and group).


### Lines 120–142: `top_projects_by_task_count` (window functions)

```python
def top_projects_by_task_count(n: int = 5) -> Select:
 subq = (
 select(
 Project.id.label("project_id"),
 Project.name.label("project_name"),
 func.count(Task.id).over(partition_by=Project.id).label("task_count"),
 func.row_number().over(
 order_by=func.count(Task.id).desc(),
 partition_by=Project.id,
 ).label("rn"),
 )
 .join(Task, Task.project_id == Project.id)
 ).subquery()

 return (
 select(
 subq.c.project_id,
 subq.c.project_name,
 subq.c.task_count,
 )
 .where(subq.c.rn == 1)
 .order_by(subq.c.task_count.desc())
 .limit(n)
 )
```

**What it does:** Returns the top N projects by task count, using window functions. The subquery computes the count and assigns a row number per partition; the outer query selects rows where `rn == 1` (deduplicating).

**Why use a window function here:** This particular query could be expressed as JOIN+GROUP_BY+ORDER_BY+LIMIT. But the window-function form demonstrates the pattern, which is essential for ranked queries like "the most recent comment per task" or "the top 3 highest-paid employees per department."

**Why `func.row_number().over(partition_by=..., order_by=...)`:** This is SQLAlchemy's syntax for the SQL `ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...)` window function. The `partition_by` divides the rows into groups; `order_by` ranks within each group; the result is the row's rank.

**Warning — Window functions are not available in all databases.**

SQLite supports them (since 3.25, 2018). Postgres has them. MySQL has them (since 8.0). If you are on an old database, window functions will not work. We assume PG17 / modern SQLite.


### Lines 145–158: `tasks_per_project_cte` (Common Table Expressions)

```python
def tasks_per_project_cte() -> Select:
 cte = (
 select(
 Task.project_id.label("project_id"),
 func.count(Task.id).label("task_count"),
 )
 .group_by(Task.project_id)
 .cte("task_counts")
 )
 return (
 select(Project.id, Project.name, cte.c.task_count)
 .join(cte, cte.c.project_id == Project.id)
 .order_by(cte.c.task_count.desc())
 )
```

**What it does:** Defines a CTE `task_counts` that computes the task count per project, then joins it back to `projects`.

**Generated SQL (roughly):**

```sql
WITH task_counts AS (
 SELECT tasks.project_id AS project_id, count(tasks.id) AS task_count
 FROM tasks GROUP BY tasks.project_id
)
SELECT projects.id, projects.name, task_counts.task_count
FROM projects JOIN task_counts ON task_counts.project_id = projects.id
ORDER BY task_counts.task_count DESC
```

**Why use a CTE instead of a subquery:** CTEs are easier to read — you can name the intermediate result and reference it multiple times in the outer query. For complex queries with multiple intermediate steps, CTEs are clearer than nested subqueries. Some databases (Postgres, with materialized CTEs) optimize CTEs differently from subqueries — but for most queries, the SQL planner produces equivalent plans.

**`.cte("name")` vs `.subquery()`:** A CTE is rendered as `WITH name AS (...) SELECT ...`; a subquery is rendered as `SELECT ... FROM (SELECT ...) AS name`. They are functionally equivalent for most queries. Prefer CTEs for readability and reuse; prefer subqueries for one-off inline expressions.

**Production reality: Postgres 12+ inlines CTEs by default.**

Before Postgres 12, a CTE was an optimization fence — the planner materialized it once and reused the result. Postgres 12 changed the default to inline (the CTE is folded into the outer query and the planner picks the access path). If you relied on a CTE as a performance fence (e.g., to force a small intermediate result to materialize before a join with a large table), the upgrade to Postgres 12+ silently removed the fence and the plan changed. The fix is `WITH name AS MATERIALIZED (...)` — the explicit fence keyword. The symptom is a plan regression after a Postgres major-version upgrade with no SQL change; the slow-query log shows the same SQL string but a different plan hash. SQLAlchemy 2.1.5 supports `cte("name", materialized=True)` to render the keyword; the default is `materialized=None` (let the planner decide). See [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]] for the plan-hash diffing workflow.


### Lines 163–172: `archive_all_tasks_in_project` (bulk UPDATE)

```python
def archive_all_tasks_in_project(session: Session, project_id: uuid.UUID) -> int:
 stmt = (
 update(Task)
 .where(Task.project_id == project_id)
 .where(Task.status != "done")
 .values(status="archived")
 )
 result = session.execute(stmt)
 return result.rowcount
```

**What it does:** Builds and executes a single `UPDATE tasks SET status = 'archived' WHERE project_id = ? AND status <> 'done'` statement. Returns the number of rows updated.

**Why use Core `update()` instead of loading each task and mutating:** Loading 1000 tasks and mutating each is N+1 in reverse — one SELECT plus 1000 UPDATEs. The bulk `update()` is one statement. For more than a few dozen rows, the bulk form is dramatically faster.

**Trade-offs of bulk operations:**

- Bulk operations bypass the session's identity map. Existing `Task` instances in the session are not updated — they hold stale values. After a bulk `update()`, you must `session.expire_all()` (or re-fetch affected rows) to ensure subsequent reads see the new values.
- Bulk operations do not trigger ORM events (Lesson 08) like `before_update`. If you rely on these events, do not use bulk operations.
- Bulk operations do not respect Python-side defaults or validators.

For these reasons, bulk operations are a performance optimization — use them when you need to update many rows and do not need ORM-level tracking.

**Student asks: when does `scalar_one()` raise and when does `one()`?**

Both raise on zero rows or more than one row — but they differ in what they return when the count is exactly one. `scalar_one()` returns the first column of the single row as a scalar; `one()` returns the whole row. For `select(User)` queries, `.scalars().one()` and `.scalar_one()` are equivalent because the first (and only) column is the `User` instance itself. For `select(User, Project.name)` queries, `.one()` returns a `Row` with both columns (a `User` and a `str`); `.scalar_one()` would return only the `User` and silently drop `Project.name`. Pick by the shape of what you want back: a single value → `scalar_one()`; a whole row with multiple columns → `one()`.


### Lines 178–186: `search_users_by_email_fragment` (raw SQL with `text()`)

```python
def search_users_by_email_fragment(session: Session, fragment: str) -> list[User]:
 stmt = text("""
 SELECT * FROM users
 WHERE email ILIKE :fragment
 ORDER BY email
 """)
 rows = session.execute(stmt, {"fragment": f"%{fragment}%"}).all()
 return [session.get(User, row.id) for row in rows]
```

**What it does:** Executes a hand-tuned SQL query, with `fragment` as a bound parameter. Returns `User` instances by re-fetching via `session.get(User, row.id)` (which uses the identity map).

**Why `text()` is the only safe way to run raw SQL:** The `:fragment` in the SQL is a *named parameter placeholder*. SQLAlchemy binds the value `"ada%"` to the placeholder when executing. The bound value is never string-interpolated into the SQL — it is sent to the database as a separate parameter, and the database engine handles the escaping. This is the canonical defense against SQL injection (see [[06-SQL-Fundamentals/SQL-Injection-and-Parameterized-Queries]]).

**Danger — Never f-string SQL.**

```python
# WRONG
stmt = text(f"SELECT * FROM users WHERE email ILIKE '%{fragment}%'")
session.execute(stmt)
```
If `fragment` is `'; DROP TABLE users; --`, you have just deleted your users table. Always use bound parameters. Always.


**Danger — `SELECT *` in `text()` is a column-drift leak.**

`SELECT * FROM users` returns every column on the `users` row, including `hashed_password`, `metadata`, and any future sensitive column a migration adds. The `row.id` access works (the `Row` is named-tuple-like), but if the service iterates `row._mapping` to dump the row to a log line, an audit trail, or a JSON response, every column leaks — including the password hash. A migration that adds a `recovery_codes` column (or renames `hashed_password` to `password_hash`) silently flows into the leak with no code review on the `text()` side, because the SQL string did not change. The fix is explicit columns: `SELECT id, email, display_name FROM users WHERE email ILIKE :fragment` — the column list is the contract; new columns do not appear unless you add them. The CI gate is a unit test that asserts `text(...).columns.keys()` matches a frozen set; see [[11-Authentication-and-Security/Password-Hashing]] for the password-column-discipline counterpart.


**Why re-fetch via `session.get(User, row.id)`:** The raw SQL returns `Row` objects, not `User` instances. To convert, we extract the PK and call `session.get(User, row.id)`, which uses the identity map. If the user is already in the session, no SELECT is emitted; if not, one is.

A cleaner pattern (if you don't want raw rows at all) is `select(User).where(User.email.ilike(fragment))` — the ORM builds the SQL for you. Use `text()` only when the query is hard to express in the ORM (e.g., a complex Postgres-specific function call).

**Student asks: why does `text()` accept `:name` placeholders and not `?` or `%s`?**

Because SQLAlchemy is dialect-agnostic. The `?` form is the `qmark` style used by SQLite and `odbc`; the `%s` form is the `format`/`pyformat` style used by `psycopg` and MySQLdb. SQLAlchemy normalises both to the `:name` named-parameter style at the SQL construction layer, then rewrites to whichever style the active driver expects at execution time. If you wrote `?` directly into `text(...)`, your code would break the moment you switched dialects (e.g., from SQLite in tests to Postgres in production). The `:name` form is the only one that survives a dialect swap unchanged.


**Danger — `ILIKE` with an attacker-controlled fragment is a DoS vector.**

`search_users_by_email_fragment(session, fragment)` wraps the caller-supplied `fragment` in `f"%{fragment}%"` before binding it as the `:fragment` parameter. The binding is injection-safe, but the ILIKE pattern itself is attacker-controlled. An attacker who controls `fragment` can submit `%a%b%c%d%e%f%g%h%` — a pattern that triggers Postgres's ILIKE backtracking algorithm into an effectively quadratic scan of the `users` table. On a 100k-row `users` table, a single adversarial request takes 30 seconds of CPU on the database. The fix is a server-side guard: reject fragments longer than 64 characters OR containing more than three `%` wildcards; a regex like `^[A-Za-z0-9._@-]{1,64}$` on the input is the canonical defense. The deeper fix is a `pg_trgm` trigram index (e.g., `CREATE INDEX ix_users_email_trgm ON users USING gin (email gin_trgm_ops)`) that makes ILIKE sub-linear, but the input validation is the security boundary, not the SQL form.


## Execution Trace

Run the smoke test:

```bash
BOARDLY_DATABASE_URL=sqlite:///:memory: uv run python -m boardly.queries
```

Expected output (truncated):

```
scalar_one_or_none: Project(id=..., name='Q4 Launch', slug='q4-launch', ...)
all: [Project(id=..., name='Q4 Launch', slug='q4-launch', ...)]
archived 1 tasks
raw search: [User(id=..., email='ada@example.com', display_name='Ada Lovelace', ...)]
```

What happened, in order:

1. The smoke test created an engine, created the schema, opened a session.
2. Seeded an org, a user, a project, and a task.
3. Called `find_project_by_slug` and executed it with `scalar_one_or_none` — got the project.
4. Called `list_projects_in_org` and executed it with `scalars().all()` — got a list of projects.
5. Called `archive_all_tasks_in_project` — bulk-updated the task's status to "archived".
6. Called `search_users_by_email_fragment` — ran raw SQL with a bound parameter, got back the user.

## The Result-Shape Methods

The most common confusion is which result-shape method to use. Here is the decision tree.

```mermaid
flowchart TD
 Q["Execute: session.execute(stmt) returns Result"]
 Q --> Row{What do you want?}
 Row -->|One row, mapped instance| ScalarOne["scalar_one()<br/>raises NoResultFound or MultipleResultsFound"]
 Row -->|One row or none, mapped instance| ScalarON["scalar_one_or_none()<br/>returns None if zero rows; raises if >1"]
 Row -->|Exactly one row, raw| One["one()<br/>raises NoResultFound or MultipleResultsFound"]
 Row -->|One row or none, raw| OneNone["one_or_none()<br/>returns None if zero rows; raises if >1"]
 Row -->|First row, raw| First["first()<br/>returns None if no rows; otherwise first row"]
 Row -->|All rows, mapped instances| ScalarsAll["scalars().all()<br/>returns list[Mapped]"]
 Row -->|All rows, raw| All["all()<br/>returns list[Row]"]

 style ScalarOne fill:#d4edda,stroke:#28a745
 style ScalarON fill:#d4edda,stroke:#28a745
 style ScalarsAll fill:#d4edda,stroke:#28a745
 style One fill:#cce5ff,stroke:#007bff
 style OneNone fill:#cce5ff,stroke:#007bff
 style First fill:#cce5ff,stroke:#007bff
 style All fill:#cce5ff,stroke:#007bff
```

Why are there so many result-shape methods, when `list[User]` would be the obvious thing to want? Because each method encodes a different *contract* between the query and the caller — and the contract is what catches bugs.

- `scalar_one()` is not just "get one row"; it is "I assert this query returns exactly one row, and if it returns zero or two, that is a bug in my code, raise immediately."
- `scalar_one_or_none()` is "I assert this query returns at most one row, and if it returns two, that is a bug."
- `first()` is "I want any matching row, in any order, and I will not be surprised if there are more."
- `all()` is "I want every matching row, in declared order, as a list."

If SQLAlchemy gave you only `all()`, you would write `if len(rows) == 1: rows[0]` yourself — and you would silently swallow the "two rows when I expected one" case instead of raising on it. The result-shape methods exist to make the assertion explicit at the call site, so the bug surfaces the moment it happens, not three weeks later in production.

The rule of thumb:

- For ORM queries where you want model instances, use **`.scalars()`** then the shape method (`.one()`, `.first()`, `.all()`).
- For ORM queries with exactly one expected row (by PK or unique column), use **`.scalar_one()`** (raises on miss) or **`.scalar_one_or_none()`** (returns None on miss).
- For aggregations or raw SQL, use the raw form (`one`, `first`, `all`) — those return `Row` objects, not model instances.

**Tip — `scalar_one` vs `one`.**

`scalar_one()` returns the first column of the first row, as a scalar (a single value, not a `Row`). `one()` returns the row itself. For `select(User)` queries, `.scalars().one()` and `.scalar_one()` are equivalent — the "scalar" is a `User` instance. For `select(User.name)` queries, `.scalars().one()` returns a `str`; `.one()` returns a `Row` with one column.


## Boolean Expressions: `&`, `|`, `~` vs `and_`, `or_`, `not_`

SQLAlchemy overloads `&`, `|`, `~` on `ColumnElement` to compose boolean expressions:

```python
stmt = select(Task).where(
 (Task.status == "open") & (Task.assignee_id == user_id)
)
```

Equivalently:

```python
stmt = select(Task).where(and_(
 Task.status == "open",
 Task.assignee_id == user_id,
))
```

When to use which:

- For two conditions, `&` and `|` are concise.
- For variable-length lists, `and_(*conditions)` and `or_(*conditions)` are clearer.
- For complex precedence, the function forms are unambiguous (the operator forms require parentheses around each operand due to Python operator precedence).

**Warning — Operator precedence bites.**

`(a) & (b) | (c)` is parsed as `((a) & (b)) | (c)` — AND has higher precedence than OR. If you meant `(a) & ((b) | (c))`, you need explicit parentheses. The `and_(or_(b, c), a)` form is unambiguous. When in doubt, use the function form.


## Common Mistakes

### Mistake 1: Using `==` for IS NULL

```python
# WRONG
session.execute(select(User).where(User.some_col == None)) # SyntaxWarning in modern Python
```

**Symptom:** `SyntaxWarning: comparison to None` and confusing SQL.

**Why:** Python `== None` is discouraged. SQLAlchemy overloads `==`, so this works (it produces `IS NULL` on the database side), but it is ugly and triggers warnings.

**Fix:** Use `is_(None)`:

```python
session.execute(select(User).where(User.some_col.is_(None)))
```

### Mistake 2: Forgetting `.scalars()` and getting a list of Row objects

```python
# WRONG
users = session.execute(select(User)).all() # list[Row], not list[User]!
for u in users:
 print(u.email) # works — Row is named-tuple-like
 u.some_method() # AttributeError — u is a Row, not a User
```

**Symptom:** `AttributeError: 'Row' object has no attribute 'some_method'` when you try to call a method on what you thought was a `User`.

**Why:** `session.execute(...)` returns a `Result`; `.all()` returns `list[Row]`. Each `Row` is a named tuple; accessing `u.email` works because the column name is exposed, but `u` is not a `User` instance.

**Warning — The first debugging instinct is "the query is wrong", not "I forgot `.scalars()`".**

The symptom is `AttributeError: 'Row' object has no attribute 'send_welcome_email'` deep in the service layer. The natural debugging path is to add `.where(...)` clauses to "tighten" the query, re-run, and watch the AttributeError persist. The actual bug is one method call upstream: the line that produced `users` is `session.execute(select(User)).all()`, missing `.scalars()`. The tell: the SQL log shows the right `SELECT users.* FROM users` and the right rows come back — the data is correct, only the wrapping type is wrong. The fix is `.scalars().all()`; the prevention is a type annotation `users: list[User] = session.execute(select(User)).scalars().all()` so mypy or pyright catches the `list[Row]` vs `list[User]` mismatch at the assignment site.


**Fix:** Chain `.scalars()` to extract the first column of each row as the scalar value:

```python
users = session.execute(select(User)).scalars().all() # list[User]
```

### Mistake 3: Confusing `one` and `first`

```python
# WRONG (semantically)
user = session.execute(select(User).where(User.email == "ada@example.com")).first()
# If the table has two rows with that email (data bug), first() silently returns one
```

**Symptom:** Silent data corruption — you assume one row, the DB has two, you only see one.

**Why:** `first()` returns the first row without raising on multiple matches. `one()` raises `MultipleResultsFound` if there is more than one.

**Fix:** Use `one` (or `scalar_one`) when you expect exactly one row. Use `first` only when you are okay with truncation.

### Mistake 4: Using `like` instead of `ilike` for case-insensitive search

```python
# WRONG (for case-insensitive search)
session.execute(select(User).where(User.email.like("%ADA%")))
# Returns: users with uppercase "ADA" in email. Misses "ada@example.com".
```

**Why:** `like` is case-sensitive on Postgres (it is the SQL standard `LIKE`). `ilike` is case-insensitive (Postgres extension). On SQLite, `like` is case-insensitive by default — which means dev (SQLite) and prod (Postgres) behave differently.

**Fix:** Use `ilike` for case-insensitive search. For dialect-agnostic code, use `func.lower(User.email).like(func.lower("%ADA%"))`.

### Mistake 5: Forgetting to bind parameters in `text()`

```python
# WRONG (SQL injection)
stmt = text(f"SELECT * FROM users WHERE email = '{email}'")
session.execute(stmt)
```

**Symptom:** SQL injection vulnerability.

**Why:** f-strings interpolate the value into the SQL string, bypassing parameter binding.

**Fix:** Use named parameters:

```python
stmt = text("SELECT * FROM users WHERE email = :email")
session.execute(stmt, {"email": email})
```

### Mistake 6: Bulk update without expiring

```python
# WRONG
session.execute(update(Task).where(...).values(status="archived"))
# At this point, any Task instances already in the session are stale.
# Touching them will return the old status.
task = session.get(Task, some_id)
print(task.status) # might be "open" — the in-memory object was not updated
```

**Why:** Bulk operations bypass the identity map. Existing instances are not refreshed.

**Warning — The symptom of stale data after a bulk update is "the UPDATE didn't run" — the SQL log says it did.**

The team reports "the bulk archive didn't work" — the dashboard still shows the task as `open`. The first debugging instinct is to re-run the bulk UPDATE; that succeeds, but the dashboard still shows `open`. The actual bug: the request handler loaded the `Task` instance into the session *before* the bulk UPDATE ran, and the in-memory instance still holds the old `status`. The SQL log shows the bulk UPDATE statement was emitted (and the `rowcount` confirms it touched the right rows); the database is correct, only the Python object is stale. The fix is `session.expire_all()` — the next attribute access re-fetches from the database. The prevention: in a request handler, do not load-then-update via the bulk path; either load-then-mutate-then-commit (ORM path) or bulk-update-then-expire (Core path) — never mix the two in the same session.


**Fix:** Call `session.expire_all()` after the bulk update — every loaded object's attributes will be re-fetched on next access.

## Engineering Trade-Offs

### Keyset pagination vs `offset`/`limit`

`offset`/`limit` is the standard SQL pagination, but `OFFSET 100000 LIMIT 20` is slow — the database has to scan and discard 100000 rows. For deep pagination, use **keyset pagination**: keep the last row's sort key, and query `WHERE sort_key > last_key ORDER BY sort_key LIMIT 20`. This is O(20) regardless of page depth.

```python
# offset/limit (slow for deep pages)
stmt = select(Project).order_by(Project.created_at).offset(100000).limit(20)

# keyset (fast for any depth)
last_created_at = ... # from the previous page's last row
stmt = (
 select(Project)
 .where(Project.created_at > last_created_at)
 .order_by(Project.created_at)
 .limit(20)
)
```

The trade-off: keyset pagination does not support jumping to arbitrary pages (you can only go next/previous). For UIs where users jump to page 50, `offset`/`limit` is necessary; for infinite scroll, keyset is right.

**Production reality: `OFFSET 100000 LIMIT 20` scans and discards 100 000 rows.**

The slow-query log signature of an offset-pagination regression is a `Limit` node on top of an `Index Scan` with an `actual rows` count of 100 020 — the database reads 100 020 rows from disk (or from the buffer pool) and discards 100 000 to satisfy the `OFFSET`. The wall-time grows linearly with `OFFSET`; for `OFFSET 1 000 000`, the query takes seconds even with a covering index. The production fix is keyset pagination (covered above); the production workaround for jump-to-page is a keyset lookup table that maps `page N -> last_key`, precomputed by a background job. The plan-reading vocabulary to confirm the regression is in [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]] — the `Limit` node's `actual rows` is the smoking gun, and `Buffers: shared read=...` is the I/O cost that does not scale.


### ORM queries vs Core bulk operations

| Pattern | ORM (load + mutate + commit) | Core (`update()`, `delete()`) |
|---|---|---|
| Per-row work | Yes (events, validators, defaults) | No |
| Speed (few rows) | Fine | Slightly faster |
| Speed (many rows) | Slow (N queries) | Fast (1 query) |
| Identity map | Updated | Not updated |
| Use when | < 100 rows, or you need ORM features | > 100 rows, no ORM features needed |

### CTEs vs subqueries vs joins

For most queries, all three can express the same thing. The choice is readability:

- **Join** — simple, familiar. Use when joining two or three tables.
- **Subquery** — inline, single-use. Use when an intermediate computation is needed once.
- **CTE** — named, reusable. Use for multi-step queries or when the same intermediate is referenced multiple times.

Performance is usually equivalent — the SQL planner optimizes them similarly. Use the form that makes the query most readable for the next engineer.

### Repository pattern: forward to Lesson 08

The `boardly/queries.py` file is a stepping stone toward the repository pattern (Lesson 08 and [[05-Project-Architecture/Service-and-Repository-Patterns]]). The pattern wraps queries in a class that hides SQLAlchemy from the service layer:

```python
class ProjectRepository:
 def __init__(self, session: Session):
 self._session = session

 def find_by_slug(self, org_id: uuid.UUID, slug: str) -> Optional[Project]:
 return self._session.execute(find_project_by_slug(org_id, slug)).scalar_one_or_none()

 def list_in_org(self, org_id: uuid.UUID, *, offset: int = 0, limit: int = 20) -> list[Project]:
 return self._session.execute(list_projects_in_org(org_id, offset=offset, limit=limit)).scalars().all()
```

We cover the trade-offs of this pattern in Lesson 08 and forward to [[05-Project-Architecture/Service-and-Repository-Patterns]].

### `select(Model)` vs `select(Model.col1, Model.col2)` vs `select(text(...))`

Three shapes of `select()`, three different return types from `execute()`:

- **`select(User)`** — returns mapped `User` instances. The identity map participates: querying for the same user twice in one session returns the same Python object. Use this for application code that wants live ORM objects to mutate and commit.
- **`select(User.id, User.email)`** — returns `Row` objects (named tuples), not mapped instances. The identity map does *not* participate: the same user queried twice returns two distinct `Row` objects. Use this for read-only projections where you want a narrow payload (the API response only needs `id` and `email`, not the entire `User` row with `hashed_password` and `metadata`).
- **`select(text("SELECT id, email FROM users WHERE ..."))`** — returns `Row` objects with no ORM mapping at all. Use this for queries the ORM cannot express cleanly (a recursive CTE, a `LATERAL` join, a Postgres-specific function). The result bypasses the identity map entirely.

**Student asks: when do I project to `select(User.id, User.email)` instead of `select(User)`?**

When the row is wide and the projection is narrow. A `select(User)` query reads every column of the `users` row — `id`, `email`, `hashed_password`, `display_name`, `metadata`, `created_at`, `updated_at`, `deleted_at`. If your endpoint only returns `{id, email}` for a list of 100 users, you have transferred 8 KB of `hashed_password` and `metadata` per row × 100 rows = 800 KB of unnecessary data over the wire from the database, into the ORM, and back out as JSON. `select(User.id, User.email)` transfers only the two columns you need — 100 × ~50 bytes = 5 KB. The trade-off: projected queries do not return live ORM objects, so you cannot mutate and commit them. Use projection for read-only list/detail endpoints; use `select(User)` when you intend to write back.


## Exercises

**Tip — The 20-minute rule**

If you are stuck on an exercise for more than 20 minutes, re-read the relevant section above, then move on and come back.


**Exercise 1 — Run the smoke test.** Save the file as `boardly/queries.py` and run it. Confirm you see the project, the list, the archived count, and the user.

**Exercise 2 — Inspect the SQL.** Set `echo=True` on the engine and re-run. Read every SQL statement SQLAlchemy emits. For each one, identify which query-builder function produced it.

**Exercise 3 — Compose a new filter.** Add `def task_done() -> ColumnElement[bool]: return Task.status == "done"`. Write a query that lists all done tasks assigned to user X. Run it.

**Exercise 4 — Try `scalar_one` on an empty result.** Call `find_user_by_email("doesnotexist@example.com")` and execute with `scalar_one()`. Catch the `NoResultFound` exception. Now switch to `scalar_one_or_none()` and confirm it returns `None` instead.

**Exercise 5 — Write a CTE.** Add a function `comments_per_user()` that uses a CTE to compute, for each user, the number of comments they have authored. Run it and verify the count.

**Exercise 6 — Bulk update.** Insert 50 tasks in a loop. Time `archive_all_tasks_in_project` (one bulk UPDATE). Then time loading each task and mutating its status (50 separate UPDATEs). Compare the timings.

**Exercise 7 — Inspect generated SQL.** Pick any `Select` object from the file. Print `str(stmt)`, `str(stmt.compile(engine))`, and `str(stmt.compile(engine, compile_kwargs={"literal_binds": True}))`. Read the differences.

**Exercise 8 — Hand the SQL to the planner.** Copy the literal-binds SQL from Exercise 7 into `psql` prefixed with `EXPLAIN (ANALYZE, BUFFERS)` (wrap any `UPDATE`/`DELETE` in `BEGIN; ... ROLLBACK;` so you do not mutate data). Read the plan top-down: identify the access path on the bottom-most node, the join strategy on each join, and the ratio of estimated `rows` to `actual rows` on the most expensive node. If the planner chose `Seq Scan` on a large table, that is the index-missing signal covered in [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]] — add the missing index and re-run the plan to confirm the access path switches to `Index Scan` or `Index Only Scan`.

**Exercise 9 — Audit the unused `Optional` import.** Run `ruff` with the `F401` rule enabled against `boardly/queries.py`. Confirm the import on line 95 (`from typing import Optional`) is flagged as unused. Remove the import, re-run the smoke test and the test suite, and verify the lint passes and the runtime is unchanged. Verify with: `uv run ruff check boardly/queries.py --select F401`.

**Exercise 10 — Add a multi-tenant cross-org guard.** Write a test that calls `list_projects_in_org(org_id=UUID_A)` and asserts every returned row has `organization_id == UUID_A`. Then call a variant of the query without the `.where(project_in_org(org_id))` clause (simulating a forgotten filter) and verify the test fails. Add the same assertion as a CI gate that scans `boardly/queries.py` for any `select(Project)` not chained to `.where(project_in_org(...))`. Verify with: `uv run pytest tests/test_tenant_isolation.py -k cross_org_leak`.

**Exercise 11 — Add a soft-delete filter to `find_user_by_email`.** Modify `find_user_by_email` to also filter `User.deleted_at.is_(None)`. Seed a user, soft-delete the user, then call `find_user_by_email` and verify it returns `None` (not the deleted user). Revert the soft-delete and verify the user is returned. Verify with: `uv run pytest tests/test_find_user_by_email_soft_delete.py -k excludes_deleted_user`.

**Exercise 12 — Profile the correlated subquery.** Seed 1 000 tasks with 5 comments each. Run `tasks_with_project_and_comment_count` with `echo=True` and capture stdout to a log file. Count the occurrences of `SELECT count(comments.id)` in the log and verify the count is approximately equal to the number of tasks (one sub-execution per outer row). Rewrite the query as a JOIN + GROUP BY and re-run; verify the count drops to one. Verify with: `uv run python -c "import boardly.queries as q; q.main()" 2>&1 | rg -c 'count.comments.id'`.

**Exercise 13 — Add an input guard to `search_users_by_email_fragment`.** Modify the function to reject fragments longer than 64 characters OR containing more than three `%` wildcards (raise `ValueError`). Seed a user, then call the function with the DoS payload `%a%b%c%d%e%f%g%h%` and verify it raises. Call with a normal fragment `ada` and verify it returns the user. Verify with: `uv run pytest tests/test_search_fragment_guard.py -k dos_payload_rejected`.

**Exercise 14 — Toggle `echo` via the environment.** Modify the smoke test's `create_engine` call to read `echo` from the `BOARDLY_SQL_ECHO` env var (default `False`). Run the smoke test with `BOARDLY_SQL_ECHO=false` and confirm no bound parameters appear in stdout. Run with `BOARDLY_SQL_ECHO=true` and confirm the parameters appear. Verify with: `BOARDLY_SQL_ECHO=false uv run python -m boardly.queries 2>&1 | rg -c 'WHERE users.email' || echo "no params leaked"`.

## Verification

Run the smoke test:

```bash
BOARDLY_DATABASE_URL=sqlite:///:memory: uv run python -m boardly.queries
```

Expected output (truncated):

```
scalar_one_or_none: Project(id=..., name='Q4 Launch', slug='q4-launch', ...)
all: [Project(id=..., name='Q4 Launch', slug='q4-launch', ...)]
archived 1 tasks
raw search: [User(id=..., email='ada@example.com', display_name='Ada Lovelace', ...)]
```

If you see all four lines, you have successfully:

- Built composable filter functions returning `ColumnElement[bool]`.
- Built query-builder functions returning `Select`.
- Used `scalar_one_or_none`, `scalars().all`, and bulk `update()`.
- Run a raw SQL query with `text()` and a bound parameter.

For Exercise 8, the planner-side verification against a real Postgres instance:

```bash
# 1. Render the literal-binds SQL for the slow-per-tenant projects query.
#    Pass a real uuid.UUID (the column is Mapped[uuid.UUID] — a plain string
#    raises CompileError under literal_binds) AND the Postgres dialect
#    (otherwise the default dialect strips the dashes from the UUID).
BOARDLY_DATABASE_URL=postgresql+psycopg://boardly:boardly@localhost/boardly \
  uv run python -c "from boardly.queries import list_projects_in_org; import uuid; from sqlalchemy.dialects import postgresql; print(list_projects_in_org(uuid.UUID('6c7d8e9f-1234-5678-9abc-def012345678')).compile(dialect=postgresql.dialect(), compile_kwargs={'literal_binds': True}))"
# expected: SELECT projects.id, projects.organization_id, projects.name FROM projects WHERE projects.organization_id = '6c7d8e9f-1234-5678-9abc-def012345678'

# 2. Hand that SQL to the PostgreSQL planner
docker exec -i pg-academy psql -U postgres -d academy <<'SQL'
EXPLAIN (ANALYZE, BUFFERS)
SELECT projects.id, projects.organization_id, projects.name, projects.slug
FROM projects
WHERE projects.organization_id = '6c7d8e9f-1234-5678-9abc-def012345678'::uuid
ORDER BY projects.created_at DESC
LIMIT 20;
SQL
# expected: "Index Scan using ix_projects_organization_id_idx" (or "Index Only Scan" if you built a covering index)
# expected: "Execution Time" in the millisecond range; "actual rows" close to "estimated rows"
```

If you see `Seq Scan` on a `projects` table with thousands of rows, the index on `organization_id` is missing — add it (`CREATE INDEX ix_projects_organization_id_idx ON projects (organization_id, created_at DESC);`), re-run `EXPLAIN (ANALYZE)`, and confirm the access path switched to `Index Scan`. The plan-reading vocabulary (`Seq Scan` vs `Index Scan` vs `Bitmap Heap Scan`, the estimate-vs-actual ratio, the `BUFFERS` column) is taught in [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]].

## Previously Learned Here

- **Lesson 03 — Declarative Base and Mapped.** `select(Project)` works because `Project` is a mapped class. The columns you filter on (`Project.slug`) are the `Mapped[T]` attributes from Lesson 03.
- **Lesson 04 — Relationships and Loading Strategies.** Eager loaders (`selectinload`, `joinedload`) are `.options(...)` on the `Select` object. They are query-time decisions, not model-time.
- **Lesson 05 — Session and Transaction Management.** `session.execute(stmt)` is the canonical execution path; the session's transaction wraps it.
- **SQL literacy** — [[06-SQL-Fundamentals/Relational-Model-and-Constraints]]. Every `select()` form maps to SQL; reading the generated SQL is the fastest way to debug.
- **SQL injection** — [[06-SQL-Fundamentals/SQL-Injection-and-Parameterized-Queries]]. The `text()` escape hatch and the `where(col == value)` form both use bound parameters — the ORM's defense.

## What's Next

In [[07-Async-SQLAlchemy]] we switch the engine to async. You will:

- Use `create_async_engine`, `async_sessionmaker`, and `AsyncSession`.
- `await session.execute(stmt)` instead of `session.execute(stmt)`.
- See why lazy loading throws `MissingGreenlet` (the implicit-I/O trap).
- Build the async `get_db` dependency for FastAPI.
- Choose sync vs async based on your workload and driver.

By the end of Lesson 07, `Boardly` will have an async engine and an async session dependency, ready to be wired into async FastAPI handlers.

## Sources

- **SQLAlchemy 2.x — `select()`** — <https://docs.sqlalchemy.org/en/21/core/selectable.html> — accessed 2026-10-19 — the SELECT statement builder.
- **SQLAlchemy 2.x — ORM Querying** — <https://docs.sqlalchemy.org/en/21/orm/queryguide/select.html> — accessed 2026-10-19 — the ORM-level patterns for `select()`.
- **SQLAlchemy 2.x — `Session.execute`** — <https://docs.sqlalchemy.org/en/21/orm/session_api.html#sqlalchemy.orm.Session.execute> — accessed 2026-10-19 — the execution entry point.
- **SQLAlchemy 2.x — `Result` API** — <https://docs.sqlalchemy.org/en/21/core/connections.html#sqlalchemy.engine.Result> — accessed 2026-10-19 — `scalar_one`, `one`, `first`, `all`, `scalars`.
- **SQLAlchemy 2.x — CTEs** — <https://docs.sqlalchemy.org/en/21/core/selectable.html#sqlalchemy.sql.expression.Select.cte> — accessed 2026-10-19 — `select(...).cte(name)`.
- **SQLAlchemy 2.x — Window functions** — <https://docs.sqlalchemy.org/en/21/core/functions.html> — accessed 2026-10-19 — `func.X().over(partition_by=, order_by=)`.
- **SQLAlchemy 2.x — Bulk UPDATE/DELETE** — <https://docs.sqlalchemy.org/en/21/orm/queryguide/dml.html> — accessed 2026-10-19 — `update()` and `delete()` for bulk operations.
- **SQLAlchemy 2.x — `text()`** — <https://docs.sqlalchemy.org/en/21/core/sqlelement.html#sqlalchemy.sql.expression.text> — accessed 2026-10-19 — the raw-SQL escape hatch.
- **PostgreSQL — Window functions** — <https://www.postgresql.org/docs/17/functions-window.html> — accessed 2026-10-19 — the underlying SQL feature.

## What We Learned

Let's recap. In this lesson you:

- **Built `select()` statements** with `where`, `order_by`, `limit`, `offset`, `join`, `outerjoin`, `group_by`, `having`.
- **Used `Session.execute()` and `Session.scalars()`** and learned the difference: execute returns `Result`; scalars extracts the first column.
- **Chose the right result-shape method** — `scalar_one` (raises on miss), `scalar_one_or_none` (returns None on miss), `one` / `one_or_none` (raw row versions), `first`, `all`.
- **Composed boolean expressions** with `&`, `|`, `~` and `and_`, `or_`, `not_`, and learned the operator-precedence gotcha.
- **Aggregated and grouped** with `func.count`, `func.sum`, `group_by`, `having`.
- **Wrote CTEs and subqueries** with `.cte("name")` and `.subquery()`.
- **Used window functions** like `func.row_number().over(partition_by=, order_by=)` for ranked queries.
- **Ran bulk `update`/`delete`** via Core for performance, and learned the identity-map trade-off (`session.expire_all()` after bulk).
- **Executed raw SQL safely** with `text()` and bound parameters — the only safe way.
- **Composed reusable filters** as functions returning `ColumnElement[bool]`, foreshadowing the repository pattern in Lesson 08.
- **Inspected generated SQL** with `compile(engine)` and `echo=True`.

Here's the mental model to walk away with: *a SQLAlchemy query is a `Select` object you build, compose, and inspect before passing to `session.execute()`. Filters are `ColumnElement[bool]` objects you can compose into `.where(...)`. Joins, group_bys, havings, CTEs, and window functions all have ORM-level equivalents. The result-shape methods (`scalar_one`, `scalar_one_or_none`, `one`, `first`, `all`) encode your expectation of cardinality — pick the right one or you get silent bugs. Bulk operations bypass the identity map — `expire_all()` after. Raw SQL is `text()` with bound parameters — never f-string. Inspect generated SQL with `compile()` or `echo=True` — that is how you debug.*

---

> A note from your teacher
You just built the query layer of `Boardly`. Every endpoint in the rest of the section will be a `select()` call wrapped in a session. The patterns you used today — composable filters, result-shape methods, CTEs, bulk operations, raw SQL with `text()` — are the patterns every query you ever write will use. Lesson 07 makes everything async; Lesson 08 adds the advanced ORM features. The query layer you wrote today stays the same — it is the workhorse of the data layer. See you in Lesson 07.


---

**Tags:** #sqlalchemy #orm #querying #select #review
**Previous:** [[05-Session-and-Transaction-Management]]
**Next:** [[07-Async-SQLAlchemy]] →

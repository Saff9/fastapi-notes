---
title: "Lesson 02: Engines, Connections, and Connection Pools"
aliases:
 - Engines Connections and Pools
 - create_engine
 - SQLAlchemy Engine
 - SQLAlchemy Connection Pool
 - QueuePool
 - NullPool
tags:
 - sqlalchemy
 - engine
 - connection-pool
 - canonical
 - lesson
course_level: intermediate
status: complete
difficulty: intermediate
estimated_time: "90–120 minutes"
prerequisites:
 - "[[01-Foundations-and-Architecture]]"
 - "[[06-SQL-Fundamentals/Relational-Model-and-Constraints]]"
 - "[[06-SQL-Fundamentals/Transactions-Isolation-Locks]]"
 - "[[04-Pydantic/Pydantic-Settings]]"
related_lessons:
 - "[[01-Foundations-and-Architecture]]"
 - "[[03-Declarative-Base-and-Mapped]]"
 - "[[05-Session-and-Transaction-Management]]"
 - "[[07-Async-SQLAlchemy]]"
first_taught_in: "07-SQLAlchemy/02-Engines-Connections-Pools"
---

# Lesson 02: Engines, Connections, and Connection Pools

*The canonical lesson for the SQLAlchemy `Engine` and the SQLAlchemy `Connection pool`. Read a URL, configure the pool, open a connection, run a query. The first real `Boardly` source file (`boardly/db.py`) is built here.*

**You've crossed into the territory.**

Every request `Boardly` will ever serve will borrow a connection from the engine you build today. Get this layer right and the rest of the stack is straightforward; get it wrong and you will spend a week debugging "too many clients" errors in production. Take your time. Open a Postgres connection. Watch the SQL log. **This is where SQLAlchemy starts feeling real.**


#sqlalchemy #engine #connection-pool #canonical

## Learning Objectives

By the end of this lesson you will be able to:

1. **Read a SQLAlchemy URL** (`postgresql+psycopg://user:pass@host:5432/dbname`) and explain every part: dialect, driver, credentials, host, port, database name, and query-string options.
2. **Construct an engine** with `create_engine(url, ...)` and pass meaningful kwargs: `echo`, `pool_size`, `max_overflow`, `pool_timeout`, `pool_recycle`, `pool_pre_ping`, `poolclass`.
3. **Distinguish `Engine` from `Connection`** — the engine is a connection factory; a connection is a single, check-out / check-in database session.
4. **Use `engine.connect()` as a context manager** to open a connection, run a `text()` query, and commit.
5. **Configure `QueuePool`** (the default for stateful services) and choose `NullPool` for serverless / short-lived processes.
6. **Explain why `pool_pre_ping=True`** matters and why it is not free.
7. **Inspect the generated SQL** with `echo=True` and the `sqlalchemy.engine` logger.
8. **Build `boardly/db.py`** — the engine factory for the `Boardly` application, wired to a Pydantic `Settings` object.

## Prerequisites

- **Lesson 01 — Foundations and Architecture.** You should already know the layer cake (Dialect → Core → ORM → Session) and what role the engine plays in it (the connection factory). If `Engine` vs `Connection` is fuzzy, revisit Lesson 01's layer cake diagram.
- **Pydantic Settings** — [[04-Pydantic/Pydantic-Settings]]. We use a `Settings` class to load `BOARDLY_DATABASE_URL` from the environment. If you have not seen `BaseSettings` before, review that lesson; it is small and worth knowing.
- **Transactions** — [[06-SQL-Fundamentals/Transactions-Isolation-Locks]]. Every `Connection` runs inside a transaction in SQLAlchemy 2.x. `BEGIN`/`COMMIT`/`ROLLBACK` semantics matter here.
- **A running database.** A local Postgres 17 is ideal. SQLite in-memory works for the demo. The lesson flags dialect-specific differences inline.

**If you do not have Postgres installed.**

Use `docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=boardly -e POSTGRES_DB=boardly postgres:17`. Or, for the demo, set `BOARDLY_DATABASE_URL=sqlite:///:memory:`. The engine API is identical; only the URL differs.


## The Problem

Your `Boardly` FastAPI service needs to talk to a database. The naive code is:

```python
# WRONG
import psycopg
def handler():
 with psycopg.connect("host=localhost dbname=boardly") as conn:
 with conn.cursor() as cur:
 cur.execute("SELECT 1")
 return cur.fetchone()
```

This is correct for a single request. It is wrong for a service. Three problems:

1. **Opening a TCP connection to Postgres takes 30–80 ms.** If your service is on a hot path and you open a fresh connection per request, your p99 latency is dominated by TCP and TLS handshake, not by the actual query. For 1000 requests per second, that is 30–80 seconds of connection setup per second. Unworkable.
2. **Postgres has a hard limit on connections** (`max_connections`, default 100). If you open a new connection per request and your service has 1000 concurrent requests, you exhaust the limit and start getting `FATAL: sorry, too many clients already`.
3. **You have no centralized place to configure the database.** Every call site invents its own URL parsing, its own error handling, its own connection lifecycle. Configuration drifts.

The SQLAlchemy **Engine** solves all three. It is a process-level connection factory that maintains a **pool** of open connections, hands them out on request, and takes them back when the consumer is done. This lesson builds the engine, opens a connection from it, runs a raw SQL query, and explains every line.

## The Code

Here is the complete `boardly/db.py` you will write in this lesson. It is the first real source file of `Boardly`; every later lesson will import from it.

```python
# boardly/db.py
"""Boardly — database engine and connection-pool configuration.

Lesson 02: create_engine, URL parsing, pool config, raw text() queries.

Run the smoke test:
 BOARDLY_DATABASE_URL=sqlite:///:memory: \\
 uv run python -m boardly.db
"""
from __future__ import annotations

import os
from typing import Any

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.pool import QueuePool, NullPool


def build_engine(url: str, *, echo: bool = False, pool_size: int = 5, max_overflow: int = 10,
 pool_timeout: float = 30.0, pool_recycle: int = 1800,
 pre_ping: bool = True, serverless: bool = False) -> Engine:
 """Construct a sync SQLAlchemy Engine with Boardly's defaults.

 Parameters mirror production best practices for a FastAPI service
 backed by Postgres. See the line-by-line deep dive for the rationale.
 """
 if serverless:
 # Lambda / Cloud Run: connections are not reused across invocations,
 # so pooling them wastes memory and risks socket leaks.
 return create_engine(
 url,
 echo=echo,
 poolclass=NullPool,
 pool_pre_ping=pre_ping,
 )

 return create_engine(
 url,
 echo=echo,
 poolclass=QueuePool,
 pool_size=pool_size, # connections kept warm
 max_overflow=max_overflow, # extra connections allowed under load
 pool_timeout=pool_timeout, # seconds to wait for a free connection
 pool_recycle=pool_recycle, # seconds before a connection is recycled
 pool_pre_ping=pre_ping, # test the connection before handing it out
 )


def get_default_url() -> str:
 """Return the database URL from the environment, with a SQLite fallback."""
 return os.environ.get("BOARDLY_DATABASE_URL", "sqlite:///boardly.db")


def smoke_test(engine: Engine) -> None:
 """Open a connection, run SELECT 1, print the result. Closes the connection."""
 with engine.connect() as conn:
 result = conn.execute(text("SELECT 1 AS one"))
 row = result.first()
 print(f"smoke_test: row = {row}")
 conn.commit()


def main() -> None:
 engine = build_engine(get_default_url(), echo=True)
 print(f"engine = {engine}")
 print(f"pool class = {engine.pool.__class__.__name__}")
 try:
 smoke_test(engine)
 except OperationalError as exc:
 print(f"DB unreachable: {exc.orig}")
 raise
 finally:
 engine.dispose()


if __name__ == "__main__":
 main()
```

That is 70 lines. Save it as `boardly/db.py` and run it. Then read the line-by-line below — it is the longest section of this lesson, because every keyword argument to `create_engine` has a why.

## Line-by-Line Deep Dive

This is the heart of the lesson. Read it twice. Do not skim — the kwargs to `create_engine` are the difference between a service that runs for months and one that falls over at 3am.

### Lines 1–10: The module docstring and imports

```python
"""Boardly — database engine and connection-pool configuration.

Lesson 02: create_engine, URL parsing, pool config, raw text() queries.

Run the smoke test:
 BOARDLY_DATABASE_URL=sqlite:///:memory: \\
 uv run python -m boardly.db
"""
from __future__ import annotations

import os
from typing import Any

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.pool import QueuePool, NullPool
```

**What it does:** Pulls in `create_engine` (the factory), `text` (the raw-SQL wrapper), `Engine` (the type for annotations), `OperationalError` (the exception raised when the DB is unreachable), and `QueuePool`/`NullPool` (the two pool implementations we choose between).

**Why each:**

- `from __future__ import annotations` — postpones evaluation of type annotations. With it, `Engine` in the function signature is a string until something resolves it. Without it, Python 3.12 evaluates annotations eagerly. The practical effect is you can write `def f() -> "Engine":` without the quotes, but you can also use names that are not yet imported. We include it for forward-compat with stricter type checkers.
- `import os` — we use `os.environ.get(...)` to read `BOARDLY_DATABASE_URL`. In production we would use Pydantic `BaseSettings` (see Lesson 03's `Settings` class); for this lesson we keep the dependency footprint minimal.
- `from typing import Any` — unused in the final code, but we left the import because students often add a `def query(self, *args: Any) -> Any: ...` while experimenting. Remove it if your linter complains.
- `create_engine` — the factory. The single most important function in the Core API. Returns an `Engine` instance.
- `text("SELECT 1")` — the canonical way to execute raw SQL. Without it, SQLAlchemy would try to interpret a bare string as a SQL expression and fail. Lesson 06 covers `text()` and bound parameters in depth.
- `Engine` — the class returned by `create_engine`. We use it as a type annotation in `build_engine` and `smoke_test`. This makes the function signatures self-documenting.
- `OperationalError` — the SQLAlchemy-level exception raised when the database is unreachable, the connection is refused, or a query times out. It is a subclass of `DBAPIError`, which is a subclass of `SQLAlchemyError`. Lesson 05 covers the exception hierarchy in detail.
- `QueuePool, NullPool` — the two pool implementations we choose between. `QueuePool` keeps a fixed number of warm connections; `NullPool` does not pool at all (opens a fresh connection every call). The choice is the first big engineering decision of this lesson.

**Tip — Why not `from sqlalchemy import *`?**

Two reasons: (a) star-imports pollute your module's namespace and make it impossible for a type checker to know where a name came from; (b) `sqlalchemy`'s public API is large (hundreds of names) and star-importing it makes your IDE autocomplete unhelpful. Always `from sqlalchemy import Name1, Name2, ...` explicitly.


### Lines 13–15: The function signature for `build_engine`

```python
def build_engine(url: str, *, echo: bool = False, pool_size: int = 5, max_overflow: int = 10,
 pool_timeout: float = 30.0, pool_recycle: int = 1800,
 pre_ping: bool = True, serverless: bool = False) -> Engine:
```

**What it does:** Declares a function that takes a `url` (positional) and a number of keyword-only arguments (because of the `*`), all with defaults, and returns an `Engine`.

**Why the `*`:** Forces callers to pass `pool_size`, `max_overflow`, etc. by keyword. A call like `build_engine(url, 5, 10, 30, 1800, True, False)` is unreadable; `build_engine(url, pool_size=5, max_overflow=10, ...)` is readable. The `*` is a Python feature that turns every subsequent parameter into keyword-only.

**Why these specific defaults:**

- `pool_size=5` — five connections kept warm in the pool. This is SQLAlchemy's default. For a small service, 5 is fine; for a service with 1000 concurrent requests, you will need more — but the right number depends on your database's `max_connections` and how many other services share the database. We cover capacity planning below.
- `max_overflow=10` — the pool can grow to `pool_size + max_overflow = 15` connections under load. Excess connections are closed when returned to the pool. This is the burst capacity. SQLAlchemy's default is 10; we keep it.
- `pool_timeout=30.0` — if a caller asks for a connection and the pool is full and at max overflow, the caller waits up to 30 seconds. If still no connection, raise `TimeoutError`. SQLAlchemy's default is 30; we keep it.
- `pool_recycle=1800` — recycle (close and reopen) every connection every 1800 seconds (30 minutes). Defends against databases and load balancers that silently kill idle connections (AWS RDS has a default idle timeout of 5 minutes for the connection, after which the socket is dead but the client does not know). 1800 is conservative; some teams set it to 300 (5 min) to be safer.
- `pre_ping=True` — before handing out a connection, the engine issues `SELECT 1` to verify it is alive. If the ping fails, the engine discards the connection and opens a new one. This adds ~1ms to every check-out, but it eliminates the "stale connection" error class entirely.
- `serverless=False` — a teaching flag. When `True`, the function returns a `NullPool`-based engine instead. Serverless functions (Lambda, Cloud Run) cannot reuse connections across invocations reliably, so pooling them wastes memory.

**Student asks: if `pre_ping=True` and `pool_recycle=1800` together, isn't that belt-and-suspenders?**

Yes, and that is exactly the point. `pool_recycle` is a passive defense (close connections before they could go stale); `pre_ping` is an active defense (verify each connection before handing it out). They protect against different failure modes: `pool_recycle` handles a database that kills idle connections after a known timeout; `pre_ping` handles a network that kills any connection at any time (a load balancer that recycles every 60s, a NAT gateway with a 5-minute TCP timeout, a cloud provider that restarts the database). Production services should use both.


**Danger — How an attacker thinks:**

The `url: str` parameter is the single most common source of credential leakage in the engine layer. A URL string round-trips through `os.environ` (readable by the process user via `/proc/<pid>/environ` on Linux and by root on any host), through shell history when a developer pastes `BOARDLY_DATABASE_URL=postgresql://boardly:p@ss@host/db uv run ...` into a terminal, through `docker inspect` (which prints container env vars by default unless the entrypoint masks them), and through CI/CD log scrapers that capture the env on a failed job. Each path is a separate incident report waiting for a ticket. Defended by building the URL programmatically with `sqlalchemy.URL.create(drivername="postgresql+psycopg", username="boardly", password=os.environ["BOARDLY_DB_PASSWORD"], host="localhost", port=5432, database="boardly")` so the password never round-trips through a single string, fetching the secret from AWS Secrets Manager or HashiCorp Vault at process start rather than from a static env var, and asserting in tests that `engine.url.render_as_string(hide_password=True)` returns a string containing `***` and zero occurrences of the raw password. See [[11-Authentication-and-Security/OWASP-API-Top-10]] + [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]] for the broader credential-hygiene pattern.


### Lines 22–30: The `serverless` branch (NullPool)

```python
 if serverless:
 # Lambda / Cloud Run: connections are not reused across invocations,
 # so pooling them wastes memory and risks socket leaks.
 return create_engine(
 url,
 echo=echo,
 poolclass=NullPool,
 pool_pre_ping=pre_ping,
 )
```

**What it does:** If the caller asked for a serverless engine, return one backed by `NullPool` instead of `QueuePool`.

**Why `NullPool` in serverless:** A Lambda function is a short-lived process (or a warm container with unpredictable reuse). If you keep a `QueuePool` alive, the pool will hold connections that may already be dead on the server side (the database closed them after a few seconds of idle, the load balancer killed the socket). Worse, when the Lambda runtime freezes your process between invocations, the next invocation may wake up holding a TCP socket the OS has recycled — and you get `ConnectionResetError`. `NullPool` sidesteps all of this: it opens a fresh connection on every `engine.connect()` and closes it when the consumer is done. No state, no surprises.

**Warning — Do not use `NullPool` in a long-running service.**

`NullPool` is correct in serverless because the process is short-lived. In a long-running FastAPI service, `NullPool` means every request opens a fresh TCP connection (30–80ms), does the query, and closes the connection. At 1000 RPS that is 30–80 seconds of TCP setup per second. Use `QueuePool` for stateful services.


**Warning — When this breaks:**

AWS Lambda's "warm reuse" freezes the runtime between invocations and thaws it on the next event. The TCP socket held by the last `engine.connect()` is now stale — the OS may have recycled the source port, an idle NAT gateway has expired, or the database has closed the backend after `idle_in_transaction_session_timeout`. The next invocation wakes up, calls `engine.connect()`, and `NullPool` correctly opens a fresh connection (it does not pool). But if you accidentally used `QueuePool` here, the pool still believes the old connection is alive and hands it out — the first query fails with `OperationalError: server closed the connection unexpectedly` even with `pool_pre_ping=True`, because `pre_ping` itself runs on the dead socket and never gets a reply. The fix is `poolclass=NullPool` for serverless, AND constructing the engine inside the handler (not at module top level) so a frozen module-level engine does not survive across freeze/thaw cycles with stale state. Verify by triggering a cold start (`aws lambda invoke ...`) and asserting the post-cold-start `engine.pool.status()` reports `Pool size: 0`. See [[16-Deployment-and-DevOps/Deployment-Targets-When-To-Use-What]] + [[03-FastAPI-Core/Application-and-Lifespan]] for the lifespan-vs-handler decision in serverless.


### Lines 32–41: The default `QueuePool` branch

```python
 return create_engine(
 url,
 echo=echo,
 poolclass=QueuePool,
 pool_size=pool_size, # connections kept warm
 max_overflow=max_overflow, # extra connections allowed under load
 pool_timeout=pool_timeout, # seconds to wait for a free connection
 pool_recycle=pool_recycle, # seconds before a connection is recycled
 pool_pre_ping=pre_ping, # test the connection before handing it out
 )
```

**What it does:** Constructs the engine with `QueuePool` and the pool-sizing parameters we exposed in the function signature.

**Why these kwargs in this order:** Group them by responsibility — `poolclass` (the strategy), `pool_size` and `max_overflow` (capacity), `pool_timeout` (queueing behavior), `pool_recycle` and `pool_pre_ping` (health checks). The comments are not just decoration; they make the kwargs grep-able. Senior engineers scan the call site to verify the configuration.

**What `create_engine` actually does internally**

`create_engine` is a **factory function** that returns an instance of `sqlalchemy.engine.base.Engine`. The engine holds:
1. A `Pool` instance (in our case, `QueuePool`).
2. A `Dialect` instance (e.g., `PGDialect_psycopg`) — the translator that knows Postgres SQL flavor.
3. A `URL` object — the parsed URL.

It does **not** open any database connections. Connections are opened lazily on the first `engine.connect()` call. This is a deliberate design: you can construct an engine at process start without the database being reachable yet, and the failure surfaces only when a request actually needs the database.


### Lines 44–46: `get_default_url`

```python
def get_default_url() -> str:
 """Return the database URL from the environment, with a SQLite fallback."""
 return os.environ.get("BOARDLY_DATABASE_URL", "sqlite:///boardly.db")
```

**What it does:** Returns the database URL from the environment variable `BOARDLY_DATABASE_URL`, falling back to a local SQLite file `boardly.db` if the variable is unset.

**Why the SQLite fallback:** So the smoke test runs on a developer's laptop without requiring a Postgres install. In production you would set `BOARDLY_DATABASE_URL=postgresql+psycopg://boardly:boardly@localhost:5432/boardly`. In Lesson 03 we will replace this with a Pydantic `Settings` class for proper validation; the function form here keeps the dependency footprint small.

**Tip — SQLite URL quirks.**

`sqlite:///boardly.db` (three slashes) means a file at `./boardly.db` — the third slash is part of the path. `sqlite:////absolute/path/boardly.db` (four slashes) means an absolute path. `sqlite://` (two slashes, no path) means in-memory. `sqlite:///:memory:` (three slashes, then `:memory:`) is the canonical in-memory form. Get the slash count right or you will spend an hour debugging "unable to open database file."


### Lines 49–54: `smoke_test`

```python
def smoke_test(engine: Engine) -> None:
 """Open a connection, run SELECT 1, print the result. Closes the connection."""
 with engine.connect() as conn:
 result = conn.execute(text("SELECT 1 AS one"))
 row = result.first()
 print(f"smoke_test: row = {row}")
 conn.commit()
```

**What it does:** Opens a `Connection` from the engine, executes `SELECT 1 AS one`, fetches the first row, prints it, commits, and lets the `with` block close the connection (returning it to the pool).

**Why each line:**

- `engine.connect()` — checks out a connection from the engine's pool. If the pool is empty and below `max_overflow`, opens a new connection; if at `max_overflow`, waits up to `pool_timeout` seconds; if still no connection, raises `TimeoutError`. The return value is a `Connection` object.
- `with ... as conn:` — the context manager. When the `with` block exits, the connection is returned to the pool. If an unhandled exception propagates out of the block, the transaction is rolled back; if the block completes normally, the transaction state is preserved (you must call `commit()` explicitly — the `with` block does not auto-commit in SQLAlchemy 2.x).
- `conn.execute(text("SELECT 1 AS one"))` — `text()` is the wrapper that tells SQLAlchemy "this is a raw SQL string, render it verbatim." Without `text()`, SQLAlchemy would try to interpret a bare `"SELECT 1 AS one"` as a SQL expression object and fail. `execute` returns a `CursorResult`.
- `result.first()` — returns the first row as a `Row` object, or `None` if there are no rows. (`Row` is a named tuple — `row.one` accesses the column by name.)
- `conn.commit()` — commits the transaction. In SQLAlchemy 2.x, `Connection` runs in "begin once" mode: the first `execute` implicitly starts a transaction; you must `commit()` or `rollback()` to finalize it. Without `commit()`, the `with` block's exit will roll back the transaction.

**Warning — The 2.x commit-semantics gotcha.**

In SQLAlchemy 1.x, a `Connection` from `engine.connect()` was in "autocommit" mode by default for `SELECT` statements. In 2.x, it is always transactional: you must call `commit()` even for a `SELECT`, because the `BEGIN` was issued implicitly. Forgetting `commit()` is harmless for `SELECT` (you just get a `ROLLBACK` at exit) but disastrous for `INSERT`/`UPDATE`/`DELETE` — your writes disappear.


### Lines 57–67: `main`

```python
def main() -> None:
 engine = build_engine(get_default_url(), echo=True)
 print(f"engine = {engine}")
 print(f"pool class = {engine.pool.__class__.__name__}")
 try:
 smoke_test(engine)
 except OperationalError as exc:
 print(f"DB unreachable: {exc.orig}")
 raise
 finally:
 engine.dispose()
```

**What it does:** Constructs an engine, prints its repr and pool class, runs the smoke test, and disposes the engine on exit.

**Why each line:**

- `build_engine(get_default_url(), echo=True)` — `echo=True` makes the engine log every SQL statement it executes. Indispensable for debugging. In production, leave it `False` and configure the `sqlalchemy.engine` logger to `INFO` instead — that gives you the same SQL log without the verbosity of `echo`.
- `print(f"engine = {engine}")` — the engine's `__repr__` includes the URL (with the password masked) and the dialect. Useful for confirming which database you are talking to.
- `print(f"pool class = {engine.pool.__class__.__name__}")` — confirms whether you got `QueuePool` or `NullPool`. Easy to verify your `serverless=True` flag actually took effect.
- `try / except OperationalError as exc:` — if the database is unreachable, SQLAlchemy raises `OperationalError`. The `exc.orig` attribute holds the underlying DBAPI exception (e.g., `psycopg.OperationalError: connection refused`). We print it for clarity, then re-raise so the process exits non-zero.
- `finally: engine.dispose()` — `dispose()` closes all connections currently held by the pool. Without it, the process might exit while holding connections open, and Postgres would log `unexpected EOF on client connection`. Always dispose the engine at process shutdown (in real apps, you do this in your lifespan — see [[03-FastAPI-Core/Application-and-Lifespan]]).

**Tip — What `echo=True` actually logs.**

Every SQL statement SQLAlchemy emits, with the rendered SQL and the bound parameters. For our smoke test you will see:
```
2026-10-19 12:34:56,789 INFO sqlalchemy.engine.Engine BEGIN (implicit)
2026-10-19 12:34:56,790 INFO sqlalchemy.engine.Engine SELECT 1 AS one
2026-10-19 12:34:56,791 INFO sqlalchemy.engine.Engine [cached since 0.001s ago] ()
2026-10-19 12:34:56,792 INFO sqlalchemy.engine.Engine COMMIT
```
The `[cached since 0.001s ago]` line tells you SQLAlchemy has a statement cache: the second execution of the same SQL uses the cached prepared statement. This is a 2.x performance feature; the cache is bounded and LRU.


## Execution Trace

Run the smoke test:

```bash
BOARDLY_DATABASE_URL=sqlite:///:memory: uv run python -m boardly.db
```

Expected output (timestamps and log lines truncated for clarity):

```
engine = Engine(sqlite:///:memory:)
pool class = QueuePool
2026-10-19 12:34:56,789 INFO sqlalchemy.engine.Engine BEGIN (implicit)
2026-10-19 12:34:56,790 INFO sqlalchemy.engine.Engine SELECT 1 AS one
2026-10-19 12:34:56,791 INFO sqlalchemy.engine.Engine [cached since 0.001s ago] ()
2026-10-19 12:34:56,792 INFO sqlalchemy.engine.Engine COMMIT
smoke_test: row = (1,)
```

What happened, in order:

1. `build_engine(...)` constructed the engine. No connection was opened.
2. `engine.connect()` checked out a connection from the `QueuePool`. The pool was empty, so it opened a fresh SQLite connection.
3. SQLAlchemy emitted `BEGIN (implicit)` — the transaction started implicitly on the first `execute`.
4. `conn.execute(text("SELECT 1 AS one"))` rendered the SQL and executed it.
5. `result.first()` fetched the single row.
6. `conn.commit()` emitted `COMMIT` and finalized the transaction.
7. The `with` block exited, returning the connection to the pool.
8. `engine.dispose()` closed the pool's connection (and any others it was holding).

```mermaid
sequenceDiagram
 participant App as boardly.db
 participant Eng as Engine
 participant Pool as QueuePool
 participant DB as Database

 App->>Eng: build_engine(url, echo=True)
 Note over Eng: pool = QueuePool(size=5, overflow=10)
 Eng-->>App: Engine (no connections yet)

 App->>Eng: engine.connect()
 Eng->>Pool: checkout()
 Pool->>Pool: pool empty, need a new conn
 Pool->>DB: connect() (TCP handshake)
 DB-->>Pool: connection established
 Pool-->>Eng: Connection
 Eng-->>App: Connection

 App->>Eng: conn.execute(text("SELECT 1"))
 Eng->>DB: BEGIN, SELECT 1, (or just SELECT for SQLite)
 DB-->>Eng: row (1,)
 Eng-->>App: CursorResult

 App->>Eng: conn.commit()
 Eng->>DB: COMMIT

 Note over App: with block exits
 App->>Eng: connection returns to pool
 Pool->>Pool: pool now holds 1 conn

 App->>Eng: engine.dispose()
 Pool->>DB: close()

```

The crucial insight: the connection was checked out from the pool, used, and returned. The pool now has the connection warm — the next `engine.connect()` in the same process will be ~1ms instead of ~30ms. This is the entire reason the pool exists.

## Reading a SQLAlchemy URL

The URL is the most overloaded string in SQLAlchemy. Every component matters. Dissect a real one:

```
postgresql+psycopg://boardly:boardly@localhost:5432/boardly?connect_timeout=10
```

| Segment | Meaning |
|---|---|
| `postgresql` | The **dialect**. Tells SQLAlchemy which SQL flavor to render. Other options: `mysql`, `sqlite`, `oracle`, `mssql`. |
| `+psycopg` | The **driver**. The Python library that actually opens the socket and speaks the wire protocol. If omitted, SQLAlchemy picks a default driver for the dialect (`psycopg` for `postgresql` in 2.x; `pymysql` for `mysql`; `sqlite3` for `sqlite`). |
| `://` | URL scheme separator. |
| `boardly:boardly` | Username and password, colon-separated. URL-encoded if they contain special characters. |
| `@localhost` | Host. Can be an IP or a hostname. |
| `:5432` | Port. Defaults to 5432 for Postgres, 3306 for MySQL, 5432 for the SQLite Unix socket (rarely used). |
| `/boardly` | Database name. For SQLite, this is the file path (and `:memory:` for in-memory). |
| `?connect_timeout=10` | Query string. Driver-specific options. `connect_timeout` is a psycopg 3 option for the TCP connect timeout in seconds. |

Dialect+driver combinations you will encounter in this track:

| Dialect+driver | Sync? | Use case |
|---|---|---|
| `postgresql+psycopg` | sync | Postgres, psycopg 3 driver. Default in 2.x. |
| `postgresql+asyncpg` | async | Postgres, asyncpg driver. Lesson 07. |
| `postgresql+psycopg2` | sync | Postgres, legacy psycopg 2 driver. **Do not use for new code** — psycopg 3 is the modern replacement. |
| `sqlite://` | sync | SQLite in-memory. |
| `sqlite:///path.db` | sync | SQLite local file. |
| `sqlite+aiosqlite://` | async | SQLite async, Lesson 07. |
| `mysql+pymysql` | sync | MySQL/MariaDB. |
| `mysql+aiomysql` | async | MySQL/MariaDB async. |

**Where do I find the driver name?**

The SQLAlchemy docs at <https://docs.sqlalchemy.org/en/21/dialects/index.html>. The driver name is the part after `+`, and it must be installed in your environment (`uv add asyncpg` for `postgresql+asyncpg://`, `uv add aiosqlite` for `sqlite+aiosqlite://`). Forgetting the install is the #1 cause of `ModuleNotFoundError: No module named 'asyncpg'` errors.


**Interview question: when would you pick `postgresql+asyncpg` over `postgresql+psycopg`?**

When your service is async end-to-end (FastAPI + `async def` endpoints + async I/O). `asyncpg` is the asyncio-native Postgres driver — it has lower per-call latency than psycopg 3's async mode and is the default driver for `create_async_engine` in 2.x. `postgresql+psycopg` is the sync driver (psycopg 3 can also do async, but it is a thinner shim over the libpq binary). The decision matrix is in [[07-Async-SQLAlchemy]]'s "Choosing sync vs async" section. If you only ever run sync code, `psycopg` is right; if you `await` your DB calls, `asyncpg` is right. Do not mix — a sync driver under `async def` blocks the event loop and re-introduces the very trap async was supposed to eliminate.


## The Engine vs the Connection

This is the most common confusion in newcomers. Settle it.

- **The `Engine`** is a **factory and a pool**. It is a process-level singleton. It owns the connection pool, knows the dialect, knows the URL, and creates `Connection` objects on demand. It is constructed **once** at process start (in the lifespan) and disposed once at process end.

- **The `Connection`** is a **checked-out database session**. It is short-lived — opened for the duration of one logical operation (one request, one background job, one script), then returned to the pool. A `Connection` is **not thread-safe**; it must not be shared across threads.

The relationship is one-to-many: one engine, many connections over time. The engine is the long-lived factory; the connection is the short-lived consumer.

Why does this distinction matter so much that we put it before every other concept in the lesson? Because every "Why is my pool exhausting?" question, every "Why did my service slow down after a redeploy?" question, and every "Why is the database complaining about too many connections?" question comes down to confusing the two. The engine is *cheap to keep around* — it is a Python object holding a dict of TCP sockets. The connection is *expensive to keep around* — it is a real TCP socket on the database side, holding a Postgres backend process, holding a transaction, holding row locks. Pooling is the discipline of "keep the cheap thing alive; cycle the expensive thing through it." When you internalise that, the rest of the pool configuration — `pool_size`, `max_overflow`, `pool_recycle`, `pool_pre_ping` — falls out as obvious corollaries.

```python
# engine = long-lived, shared
engine = create_engine(url, pool_size=5)

# connection = short-lived, per-operation
with engine.connect() as conn:
 conn.execute(text("SELECT 1"))
# conn is now returned to the pool; do not use it.
```

**Student asks: if the engine is a singleton, is it thread-safe?**

Yes — for `engine.connect()` and `engine.dispose()`. The engine's pool is internally synchronized (it uses a `threading.Lock` to guard the connection list). Multiple threads can safely call `engine.connect()` concurrently. What is not thread-safe is the `Connection` you get back — that one connection is for your thread only.


## The Connection Pool in Depth

The `QueuePool` is SQLAlchemy's default pool implementation. It works like this:

1. **Steady state:** The pool holds `pool_size` warm connections (default 5).
2. **`engine.connect()` is called:** If a warm connection is available, hand it out (after `pre_ping`). If not, and the pool is below `pool_size + max_overflow`, open a new connection and hand it out. If at max overflow, wait up to `pool_timeout` seconds; if still no connection, raise `TimeoutError`.
3. **The connection is returned:** If the pool has fewer than `pool_size` warm connections, the returned connection becomes warm (kept open). If the pool is full, the returned connection is closed (the engine already has enough warm ones).
4. **`pool_recycle` seconds pass:** The pool proactively closes and reopens any connection that has been alive longer than the recycle interval. Defends against server-side idle timeouts.
5. **`pre_ping` is enabled:** Before handing out a connection, the engine issues `SELECT 1` to verify it is alive. If the ping fails, the connection is discarded and a new one is opened.

The math for capacity planning is straightforward:

- **`pool_size` warm connections** are always held (until the engine is disposed). They count against the database's `max_connections` even when idle.
- **`max_overflow` burst connections** are opened on demand and closed when returned. They count against the database's `max_connections` only while they are checked out.
- **Multiple processes** each have their own pool. If you run 4 Uvicorn workers, your total connection count is `4 × (pool_size + max_overflow) = 4 × 15 = 60`. Plan for it.

**Warning — Do not set `pool_size` larger than necessary.**

A common mistake is to set `pool_size=50` "to be safe". The result: every worker process holds 50 connections open even when idle. With 4 workers, that is 200 connections — and Postgres has a default `max_connections=100`. You have just DoS'd your own database. Set `pool_size` to your expected concurrent request count, not to "as high as possible".


**Danger — If you hit `TimeoutError` from the pool, do not just raise `pool_size`.**

The `TimeoutError` means all connections are checked out and the pool cannot grow. The cause is almost always one of: (a) a connection leak (you opened a connection and never returned it); (b) a slow query holding connections longer than expected; (c) a deadlock where every request is waiting on a row lock held by another request. Raising `pool_size` makes the problem worse, not better, because the underlying cause will simply absorb the extra capacity. Investigate with `engine.pool.status()` and the slow query log.


**Interview question: how do you size `pool_size` and `max_overflow` for a new service?**

Start with the formula `worker_count × (pool_size + max_overflow) ≤ max_connections − reserve`. For a single Uvicorn worker on a Postgres with `max_connections=100` and a 20-connection reserve (for migrations, psql, monitoring): `1 × (pool_size + max_overflow) ≤ 80`. The default `pool_size=5, max_overflow=10` (total 15) is a fine starting point for a service up to ~100 RPS with sub-50ms queries. Increase `pool_size` only if measured concurrent in-flight DB work exceeds the warm pool — otherwise you are paying the `max_connections` cost for connections that sit idle. Set `max_overflow` to your burst tolerance (the spike that lasts < `pool_recycle` seconds); anything beyond that should backpressure via `pool_timeout`, not by silently opening more connections.


**Production reality:**

The `TimeoutError` from a saturated pool is the silent-killer incident of every FastAPI service that scales past its first 1000 RPS. The symptoms are subtle: p99 latency climbs from 50ms to 30s over an hour, no error is logged until `pool_timeout` (default 30s) elapses, and Grafana shows the connection count pinned at `pool_size + max_overflow` for minutes at a time. The default `pool_timeout=30` means each blocked caller waits a full 30 seconds before raising — long enough for the upstream load balancer to give up (typical ALB timeout: 60s), so the user sees a 504 from the LB, not a 500 from your service, and your error-rate dashboard stays flat. The first time you notice is the post-mortem. Defended by exporting `engine.pool.status()` to a Prometheus gauge every 10s (with `checkedout`, `free`, `overflow`, `queued` as separate gauges), alerting on `queued > 0` for more than 60s, and running a load test (`uv run python -m boardly.tests.load_test --rps 500 --duration 5m`) before every release that touches the pool config. See [[13-Performance-and-Observability/OpenTelemetry-Tracing]] + [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]] for the slow-query-hunting workflow that prevents the underlying cause.


### `QueuePool` vs `NullPool`: the decision matrix

| Property | `QueuePool` | `NullPool` |
|---|---|---|
| Keeps connections warm | Yes | No |
| Connection setup latency per request | ~1ms (pool hit) | 30–80ms (TCP + auth) |
| Memory footprint | Holds N open sockets | None |
| Best for | Long-running services (FastAPI, Celery workers, daemons) | Serverless (Lambda, Cloud Run, Cloud Functions), scripts, tests |
| Failure mode on cold start | First request pays the setup cost | Every request pays the setup cost |

The rule of thumb: if your process outlives many requests, use `QueuePool`. If your process dies after a few requests, use `NullPool`.

## `pool_pre_ping`: the belt

`pool_pre_ping=True` makes the engine issue `SELECT 1` before handing out a connection. The cost is ~1ms per check-out (one extra round-trip). The benefit is that you never hand out a dead connection, so you never see `OperationalError: server closed the connection unexpectedly`.

Without `pre_ping`, here is the failure scenario:

1. Pool holds a warm connection.
2. The database (or a load balancer in front of it) closes the connection after 5 minutes of idle.
3. Your service makes a request. The pool hands out the dead connection.
4. Your query fails with `OperationalError`.
5. Your request handler returns a 500 to the user.

With `pre_ping`, step 3 becomes "the pool issues `SELECT 1`, sees the connection is dead, discards it, opens a new one, and hands that out." The cost is one extra `SELECT 1` per check-out (~1ms).

**Tip — Always enable `pre_ping` for production.**

The 1ms cost is negligible. The user-facing 500s you prevent are not. There is no scenario in which `pre_ping=False` is the right choice for a production service. The only exception is a benchmark or a test where you want to measure cold-start latency.


**Warning — When this breaks:**

`pool_pre_ping=True` masks the symptom (a stale connection handed to your code) but does not fix the cause (the database is killing connections faster than `pool_recycle` recycles them). The mask is also incomplete: the `SELECT 1` issued by `pre_ping` runs *before* your query is sent, so any failure between the ping and your actual `execute()` — a network blip, a failover, a `pg_terminate_backend` from the DBA — surfaces as `OperationalError` on your real query, not on the ping. You will chase this for hours because the trace shows "pre_ping succeeded, query failed" and you will not believe the database is flapping. The fix is to wrap critical writes in a retry loop that catches `OperationalError` and re-runs the transaction from scratch (not just the query — the transaction must restart, because a partial commit may have left the connection in an aborted state), with a max-retries floor of 3 and exponential backoff. Verify by `pg_terminate_backend(pid)`-ing your own connection mid-transaction in a test and asserting the retry succeeds. See [[17-Advanced-Architecture/Idempotency-and-Retries]] + [[13-Performance-and-Observability/OpenTelemetry-Tracing]] for the retry-pattern playbook.


## `pool_recycle`: the suspenders

`pool_recycle` is a *passive* defense: it proactively closes connections that have been alive longer than the recycle interval. Set it to a value lower than your database's idle timeout.

Default idle timeouts to plan around:

| Database / load balancer | Default idle timeout |
|---|---|
| AWS RDS Postgres | 5 minutes (300s) |
| AWS RDS Proxy | 1 hour (1800s) |
| AWS Aurora Postgres | 5 minutes (300s) |
| Google Cloud SQL Postgres | 10 minutes (600s) |
| PgBouncer | configurable, often 5 min |
| AWS Network Load Balancer | 350 seconds |

A safe default is `pool_recycle=300` (5 minutes) for cloud-hosted Postgres without a proxy, `pool_recycle=1800` (30 minutes) if you are behind PgBouncer or RDS Proxy. We use 1800 in `Boardly` because we assume a managed Postgres behind a connection-pooling proxy — adjust for your environment.

## Inspecting Generated SQL with `echo` and Logging

`echo=True` on `create_engine` is the fastest way to see what SQL SQLAlchemy emits. But it is a teaching and debugging tool, not a production observability tool. For production:

**Danger — How an attacker thinks:**

`echo=True` (and `logging.getLogger("sqlalchemy.engine").setLevel(logging.INFO)`) log every SQL statement *including the bound parameters*. The bound parameters are the user input — emails, phone numbers, API keys looked up by value, password-reset tokens in `WHERE token = $1`. A single `SELECT * FROM users WHERE email = $1` with `echo=True` writes the user's email to `stdout`, to the container log aggregator (Loki, CloudWatch, Datadog), to the CI artifact bucket, and to the on-call Slack channel when a test fails. An attacker who scrapes any one of those (a leaked log, a too-permissive S3 bucket, a CI artifact retention misconfiguration) gets every user's email and every active session token in your database. Defended by leaving `echo=False` in production, configuring `logging.getLogger("sqlalchemy.engine")` to `WARNING` (not `INFO`) in prod, and adding a structured-log redactor that masks any bind param whose column name matches a denylist (`email`, `password`, `token`, `ssn`, `phone`, `api_key`) with `***` before the line leaves the process. Verify with `uv run python -m boardly.tests.log_redaction_audit` asserting zero PII column names appear in the captured log buffer. See [[11-Authentication-and-Security/OWASP-API-Top-10]] + [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]] for the structured-logging redaction pattern.


```python
import logging
logging.basicConfig()
logging.getLogger("sqlalchemy.engine").setLevel(logging.INFO)
```

This routes every SQL statement through the standard `logging` module, where you can format it, send it to OpenTelemetry, filter by statement type, etc. We cover structured logging and tracing in [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]] and [[13-Performance-and-Observability/OpenTelemetry-Tracing]].

For ad-hoc inspection of a single statement, use `str(stmt)` or `stmt.compile(engine, compile_kwargs={"literal_binds": True})`:

```python
stmt = text("SELECT :name").bindparams(name="ada")
print(stmt.compile(engine)) # SELECT :name
```

Lesson 06 covers statement compilation in depth.

## Common Mistakes

### Mistake 1: Creating an engine per request

```python
# WRONG
@app.get("/projects")
def list_projects():
 engine = create_engine(url) # opens a fresh pool every request
 with engine.connect() as conn:
 ...
```

**Symptom:** p99 latency of 50–100ms even on simple queries; Postgres logs full of `connection received` and `connection authorized` lines; pool capacity warnings in your DB's monitoring.

**Why:** `create_engine` opens the pool lazily but every check-out after that opens a fresh TCP connection (the pool has no warm connections because it was just created). Worse, the engine and its pool are never disposed, so they leak.

**Fix:** Create the engine once at process start (in the lifespan) and reuse it. Pass it to handlers via dependency injection.

### Mistake 2: Forgetting `conn.commit()` in 2.x

```python
# WRONG
with engine.connect() as conn:
 conn.execute(text("INSERT INTO users (email) VALUES ('ada@example.com')"))
 # forgot conn.commit()
```

**Symptom:** Rows that were "inserted" disappear. No error is raised — the `with` block exits, the implicit transaction is rolled back, the row is gone.

**Why:** SQLAlchemy 2.x `Connection` is always transactional. The `BEGIN` is implicit on the first `execute`; `COMMIT` is **never** implicit. You must call `commit()` to finalize the transaction.

**Fix:** Always `conn.commit()` before the `with` block exits, or use `with engine.begin() as conn:` which auto-commits on success and auto-rolls-back on exception.

```python
with engine.begin() as conn:
 conn.execute(text("INSERT INTO users (email) VALUES ('ada@example.com')"))
# commits automatically on block exit; rolls back on exception
```

### Mistake 3: Calling `engine.dispose()` on every request

```python
# WRONG
def handler():
 engine = build_engine(url)
 try:
 ...
 finally:
 engine.dispose()
```

**Symptom:** No connection reuse; p99 latency dominated by TCP setup; pool never warms up.

**Why:** `dispose()` closes all connections in the pool. If you call it after every request, the pool never builds up warm connections.

**Fix:** Dispose the engine only at process shutdown (in the lifespan), not per request.

### Mistake 4: `pool_size` set too high

```python
# WRONG (against Postgres with default max_connections=100, 4 workers)
engine = create_engine(url, pool_size=50, max_overflow=50)
# 4 workers × (50 + 50) = 400 connections. Postgres refuses new ones.
```

**Symptom:** `OperationalError: FATAL: sorry, too many clients already` from the database.

**Why:** `pool_size` connections are always held, even when idle. Sum across worker processes and you can exceed Postgres' `max_connections` even when the service is doing nothing.

**Fix:** Set `pool_size` to your expected concurrent request count, not higher. Plan capacity: `worker_count × (pool_size + max_overflow) ≤ database_max_connections - reserve`. Leave 10–20 connections in reserve for migrations, monitoring, ad-hoc queries.

### Mistake 5: Forgetting `pre_ping`

```python
# WRONG (in production)
engine = create_engine(url, pool_pre_ping=False)
```

**Symptom:** Intermittent `OperationalError: server closed the connection unexpectedly` after idle periods. The error is impossible to reproduce locally and disappears when you add logs.

**Why:** Idle connections in the pool are silently closed by the database or a network device. Without `pre_ping`, the pool hands them out without checking.

**Fix:** `pool_pre_ping=True`. Always. See the section above.

### Mistake 6: Using `psycopg2` (not `psycopg` 3) for new code

```python
# WRONG (for new code)
engine = create_engine("postgresql+psycopg2://...")
```

**Symptom:** None immediately — psycopg 2 still works. But you miss out on psycopg 3's performance, native async support, prepared-statement caching, and copy-mode optimizations. And psycopg 2 is in maintenance-only mode.

**Why:** `psycopg2` is the legacy driver. `psycopg` (no 2) is the modern, asyncio-aware replacement.

**Fix:** `uv add psycopg` and use `postgresql+psycopg://` URLs. If you have an old project on psycopg 2, plan a migration — it is straightforward (the API is mostly compatible, with `psycopg2` → `psycopg` import renames).

## Engineering Trade-Offs

### `engine.begin()` vs `engine.connect()` + `commit()`

Two ways to run a transactional block:

```python
# Option A: engine.begin() (preferred)
with engine.begin() as conn:
 conn.execute(text("INSERT ..."))
 # auto-commits on exit; auto-rolls-back on exception

# Option B: engine.connect() + commit() (more control)
with engine.connect() as conn:
 conn.execute(text("INSERT ..."))
 if some_condition:
 conn.commit()
 else:
 conn.rollback()
```

Use `engine.begin()` when you want the standard "all-or-nothing" transaction. Use `engine.connect()` when you want multiple savepoints or explicit control over the commit boundary.

### Sync engine vs async engine

We deliberately use sync engines in Lessons 02–06 because the sync API is the right scaffold for understanding the Core/ORM layers. In Lesson 07 we switch to `create_async_engine` and `AsyncSession`. The decision matrix is in [[07-Async-SQLAlchemy]]'s "Choosing sync vs async" section. The short version: for FastAPI services with async-native drivers, use async end-to-end.

### Pooling across processes

Each Uvicorn worker process has its own engine and its own pool. There is no cross-process pool in SQLAlchemy. If you need to share connections across processes (e.g., a Celery worker pool that shares a database with the web service), use a server-side pooler like PgBouncer in front of Postgres. SQLAlchemy's pool then becomes a thin client of PgBouncer.

**Student asks: if I deploy PgBouncer, should I disable SQLAlchemy's pool?**

Usually not — you should shrink it. PgBouncer pools *server-side* Postgres backend connections across many *client-side* connections (one PgBouncer process can multiplex thousands of clients onto ~10–25 server backends). SQLAlchemy's pool is still useful *client-side* for two reasons: (a) the SQLAlchemy pool recycles dead connections and runs `pre_ping` cheaply (the round-trip is to PgBouncer on localhost, not to Postgres over the network); (b) it bounds the number of sockets your process opens to PgBouncer. The pattern is `pool_size=2, max_overflow=3` per worker when fronting PgBouncer in transaction-pooling mode — small client pool, larger server pool on PgBouncer. The mistake to avoid: keeping SQLAlchemy's `pool_size=5` (the default) on a 20-worker Kubernetes Deployment that all point at PgBouncer — you have just opened 100 client sockets to PgBouncer for a service that probably needs 10. Shrink SQLAlchemy's pool when PgBouncer is doing the real pooling.


**PgBouncer and `pool_recycle`.**

If you are behind PgBouncer in transaction-pooling mode, set `pool_recycle` to a value smaller than PgBouncer's `server_idle_timeout`. Otherwise you will hand out dead SQLAlchemy-level connections even though PgBouncer is supposed to be pooling for you. PgBouncer configuration is out of scope for this lesson — the 08-PostgreSQL section treats it as an operations sidebar; for production-grade role and pool tuning see [[08-PostgreSQL/Roles-Permissions-Security]]. The engine-and-pool sizing principles you just learned are the foundation.


**Production reality:**

A multi-tenant `Boardly` deployment behind PgBouncer in transaction-pooling mode has a subtle cross-tenant attack surface: a single noisy tenant issuing `SELECT pg_sleep(30)` from a misbehaving endpoint saturates the SQLAlchemy client pool *and* the PgBouncer server pool, and every other tenant's requests block behind the slow query. The pool math does not save you here — `pool_size=2, max_overflow=3` per worker means 5 concurrent slow queries per worker pin the PgBouncer pool for 30 seconds each, and the next 5 tenants wait. The defense is layered: (a) per-tenant `SELECT` statement timeouts via `SET statement_timeout = '5s'` enforced at the Postgres role level (see [[08-PostgreSQL/Roles-Permissions-Security]] for per-tenant roles), (b) a FastAPI middleware that caps concurrent in-flight DB calls per tenant at 2 (an `asyncio.Semaphore` keyed by `tenant_id`), (c) PgBouncer's `query_timeout = 5` and `query_wait_timeout = 5` so a queued client does not pile up. Verify with a load test that fires 50 concurrent `pg_sleep(30)` calls as tenant A while tenant B's `SELECT 1` calls are still served within 100ms. See [[17-Advanced-Architecture/Multi-Tenancy]] + [[03-FastAPI-Core/Middleware-and-Request-Order]] for the per-tenant rate-limiting middleware pattern.


## Exercises

**Tip — The 20-minute rule**

If you are stuck on an exercise for more than 20 minutes, re-read the relevant section above, then move on and come back.


**Exercise 1 — Run the smoke test.** Save the script above as `boardly/db.py`, install SQLAlchemy (`uv add sqlalchemy`), and run `BOARDLY_DATABASE_URL=sqlite:///:memory: uv run python -m boardly.db`. Confirm the output matches the expected trace.

**Exercise 2 — Run against real Postgres.** Start a Postgres 17 in Docker: `docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=boardly -e POSTGRES_DB=boardly postgres:17`. Set `BOARDLY_DATABASE_URL=postgresql+psycopg://boardly:boardly@localhost:5432/boardly` and re-run. Install psycopg first: `uv add psycopg`. Confirm the smoke test passes.

**Exercise 3 — Trigger a stale connection.** Set `pool_recycle=2` and `pool_pre_ping=False`. Open a connection, sleep 5 seconds (longer than recycle), then open another connection and query. What happens? Now set `pool_pre_ping=True` and re-run. What is different?

**Exercise 4 — Exhaust the pool.** Set `pool_size=1`, `max_overflow=0`, `pool_timeout=2`. Open one connection (do not close it), then try to open another. What error do you get after 2 seconds?

**Exercise 5 — Inspect the pool.** Print `engine.pool.status()` before and after a `connect()` call. The status string tells you how many connections are checked out, free, and the total.

**Exercise 6 — Switch to `NullPool`.** Call `build_engine(url, serverless=True)`. Confirm the pool class is `NullPool`. Open two connections in succession. Are they the same socket? (Hint: print `id(conn.connection.connection)` to get the underlying DBAPI connection's id.)

**Exercise 7 — Read the slow-query log.** Set `echo=True`, run a query that takes 500ms (use `text("SELECT pg_sleep(0.5)")`), and observe how SQLAlchemy logs the SQL but does not log the duration. Add a `logging.getLogger("sqlalchemy.engine").setLevel(logging.INFO)` and re-run — same result, but now you can also route it to a structured logger.

**Exercise 8 — Credential leak audit.** Replace the env-var URL with `sqlalchemy.URL.create(...)` so the password never round-trips through a single string. Write a test that constructs the engine, asserts `engine.url.render_as_string(hide_password=True)` contains the literal `***` and zero occurrences of the raw password, and asserts that the engine can still `SELECT 1`. Verify with `uv run pytest tests/test_credential_audit.py -v` — the test must pass with `BOARDLY_DB_PASSWORD='p@ss/with:special@chars'` set in the environment (a password designed to break naive string interpolation).

**Exercise 9 — Pool-exhaustion reproducer.** Configure `build_engine(url, pool_size=5, max_overflow=5, pool_timeout=1)`. Use `concurrent.futures.ThreadPoolExecutor(max_workers=20)` to call `engine.connect()` 20 times in parallel and hold each connection open without closing it. Verify with `uv run python -m boardly.tests.pool_exhaust` that the 11th through 20th `connect()` calls each raise `sqlalchemy.exc.TimeoutError` within 2 seconds, and that `engine.pool.status()` mid-flight reports `checkedout=10, overflow=5`.

**Exercise 10 — Statement-cache warning audit.** SQLAlchemy 2.x keeps an internal LRU statement cache (the `[cached since 0.001s ago]` line you saw in the echo log). Run the smoke test with warnings escalated to errors: `BOARDLY_DATABASE_URL=sqlite:///:memory: uv run python -W error::sqlalchemy.exc.SAWarning -m boardly.db`. Confirm the exit code is 0 (the default engine emits no `SAWarning`). Then issue 1000 distinct SQL strings via `text(...)` in a loop and re-run — the cache evicts silently (no warning, exit 0). The exercise pins the contract that the default `Boardly` engine config is warning-clean under `-W error`; any future change that raises an `SAWarning` will fail the build.

**Exercise 11 — PgBouncer transaction-pooling smoke test.** Start PgBouncer in transaction-pooling mode in Docker: `docker run --rm -p 6432:5432 -e DB_HOST=host.docker.internal -e DB_USER=boardly -e DB_PASSWORD=boardly -e DB_NAME=boardly -e POOL_MODE=transaction edoburu/pgbouncer`. Point `BOARDLY_DATABASE_URL=postgresql+psycopg://boardly:boardly@localhost:6432/boardly`. Configure `build_engine(url, pool_size=2, max_overflow=3, pool_recycle=60, pre_ping=True)`. Write an integration test that issues 50 concurrent `SELECT 1` calls via `concurrent.futures.ThreadPoolExecutor(max_workers=50)` and asserts all 50 succeed, then asserts `engine.pool.status()` reports `checkedout=0` after the test. Verify with `uv run pytest tests/integration/test_pgbouncer_smoke.py -v` — the test should pass against both PgBouncer and a direct Postgres connection (the test is pooler-agnostic by design).

**Exercise 12 — Connection-leak detector.** Write a script that loops 20 times calling `engine.connect()` *without* the `with` block (so the connections are checked out but never returned). After each call, print `engine.pool.status()`. Verify with `uv run python -m boardly.tests.leak_detector` that the script: (a) prints a `checkedout` count that grows by 1 each iteration, (b) prints `LEAK DETECTED: checkedout=N` when `checkedout` exceeds `pool_size + max_overflow` (default 15), and (c) exits non-zero. Then fix the leak by wrapping each `engine.connect()` in a `with` block and re-run — verify the script now exits 0 with `checkedout=0` throughout.

**Exercise 13 — `pool_pre_ping` gap audit.** The `pre_ping` `SELECT 1` runs *before* your query is sent; any failure between the ping and the `execute()` (a failover, a `pg_terminate_backend`, a network blip) surfaces as `OperationalError` on your real query, not on the ping. Write a test against a real Postgres 17 (use `docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=boardly -e POSTGRES_DB=boardly postgres:17`) that: (a) opens a `with engine.connect() as conn:` block, (b) in a parallel thread uses `psql` to run `SELECT pg_terminate_backend(<pid of conn>)` where `<pid>` is fetched from `pg_stat_activity`, (c) issues `conn.execute(text("SELECT 1"))` and asserts `OperationalError` is raised. Verify with `uv run pytest tests/integration/test_pre_ping_gap.py -v` — the test pins the contract that `pre_ping` does *not* guarantee the connection is alive for the lifetime of the check-out, only at the moment of the ping.

## Verification

Run the smoke test:

```bash
BOARDLY_DATABASE_URL=sqlite:///:memory: uv run python -m boardly.db
```

Expected output (timestamps truncated):

```
engine = Engine(sqlite:///:memory:)
pool class = QueuePool
2026-10-19 ... INFO sqlalchemy.engine.Engine BEGIN (implicit)
2026-10-19 ... INFO sqlalchemy.engine.Engine SELECT 1 AS one
2026-10-19 ... INFO sqlalchemy.engine.Engine [cached since ... ago] ()
2026-10-19 ... INFO sqlalchemy.engine.Engine COMMIT
smoke_test: row = (1,)
```

If you see `smoke_test: row = (1,)`, you have successfully:

- Constructed an engine with `QueuePool`.
- Checked out a connection from the pool.
- Executed raw SQL via `text()`.
- Committed the transaction.
- Returned the connection to the pool.
- Disposed the engine (closing the pool).

That is the entire lesson in 70 lines of code. The rest of the section builds on top of this engine.

## Previously Learned Here

These concepts were taught in earlier lessons. We link back instead of re-explaining:

- **Foundations and architecture** — [[01-Foundations-and-Architecture]]. The engine is the Core-level connection factory from the layer cake diagram. The pool sits inside the engine.
- **Transactions** — [[06-SQL-Fundamentals/Transactions-Isolation-Locks]]. Every `Connection` runs in a transaction; `commit()` and `rollback()` are SQL `COMMIT` and `ROLLBACK`. The 2.x "always transactional" rule is SQLAlchemy enforcing this for you.
- **SQL injection** — [[06-SQL-Fundamentals/SQL-Injection-and-Parameterized-Queries]]. The `text()` wrapper accepts bound parameters (Lesson 06) and is the only safe way to run raw SQL. Never f-string SQL.
- **Pydantic Settings** — [[04-Pydantic/Pydantic-Settings]]. We used `os.environ.get` here for simplicity; Lesson 03 swaps it for a `Settings` class with proper validation and typed attributes.

## What's Next

In [[03-Declarative-Base-and-Mapped]] we build `boardly/models.py` — the `DeclarativeBase`, the `Mapped[T]` annotations, and the first three `Boardly` models (`Organization`, `User`, `Project`). You will:

- Define `class Base(DeclarativeBase): pass` and explain what `Base.metadata` and `Base.registry` are.
- Annotate columns with `Mapped[T]` and configure them with `mapped_column(...)`.
- Distinguish `server_default` (the database's default) from `default=` (Python's default).
- Define primary keys, foreign keys, unique constraints, indexes, and naming conventions.
- Inspect `Base.metadata.tables` to see the `Table` objects SQLAlchemy auto-generated for you.
- Use `Base.metadata.create_all(engine)` to create the schema in the database (as a teaching scaffold — production uses Alembic).

By the end of Lesson 03, the canonical `DeclarativeBase` and `Mapped / mapped_column` concepts will be registered to your name, and `Boardly` will have a typed model layer.

## Sources

- **SQLAlchemy 2.x — `create_engine`** — <https://docs.sqlalchemy.org/en/21/core/engines.html> — accessed 2026-10-19 — canonical reference for engine construction and kwargs.
- **SQLAlchemy 2.x — Connection Pooling** — <https://docs.sqlalchemy.org/en/21/core/pooling.html> — accessed 2026-10-19 — `QueuePool`, `NullPool`, `pool_pre_ping`, `pool_recycle`.
- **SQLAlchemy 2.x — `Engine` API** — <https://docs.sqlalchemy.org/en/21/core/engine.html> — accessed 2026-10-19 — the `Engine` class's methods (`connect`, `begin`, `dispose`).
- **SQLAlchemy 2.x — `text()`** — <https://docs.sqlalchemy.org/en/21/core/sqlelement.html#sqlalchemy.sql.expression.text> — accessed 2026-10-19 — the raw-SQL wrapper.
- **SQLAlchemy 2.x — `Connection` API** — <https://docs.sqlalchemy.org/en/21/core/connections.html> — accessed 2026-10-19 — `execute`, `commit`, `begin`, savepoints.
- **psycopg 3 documentation** — <https://www.psycopg.org/psycopg3/docs/> — accessed 2026-10-19 — the modern Postgres driver.
- **asyncpg documentation** — <https://magicstack.github.io/asyncpg/> — accessed 2026-10-19 — the async Postgres driver (Lesson 07).
- **AWS RDS — PostgreSQL parameter `idle_in_transaction_session_timeout`** — <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL-Manage.html> — accessed 2026-10-19 — why `pool_recycle` matters in the cloud.

## What We Learned

Let's recap. In this lesson you:

- **Read a SQLAlchemy URL** — dialect, driver, credentials, host, port, database, query-string options — and learned the most common dialect+driver combinations for Postgres and SQLite.
- **Built `boardly/db.py`** — the engine factory for `Boardly`, with sensible defaults for `pool_size`, `max_overflow`, `pool_timeout`, `pool_recycle`, and `pool_pre_ping`.
- **Distinguished `Engine` from `Connection`** — the engine is the long-lived factory; the connection is the short-lived consumer.
- **Used `engine.connect()` as a context manager** to check out a connection, run `text("SELECT 1 AS one")`, fetch the row, commit, and return the connection to the pool.
- **Chose `QueuePool` for stateful services** and `NullPool` for serverless, and articulated why mixing them up causes production incidents.
- **Enabled `pool_pre_ping=True`** to defend against stale connections and `pool_recycle=1800` to defend against server-side idle timeouts.
- **Hit the six classic engine mistakes** — per-request engine creation, missing `commit()`, per-request `dispose()`, oversized `pool_size`, missing `pre_ping`, and using psycopg 2 instead of psycopg 3 for new code.

Here's the mental model to walk away with: *the engine is a process-level singleton that owns a pool of warm connections. The pool is configured for capacity (`pool_size`, `max_overflow`), queueing (`pool_timeout`), and health (`pool_recycle`, `pre_ping`). `engine.connect()` checks a connection out; the `with` block returns it. `engine.dispose()` closes the pool — call it once at process shutdown. Get this layer right and the rest of the stack is straightforward; get it wrong and you will spend a week debugging "too many clients" errors in production.*

---

> A note from your teacher
You just built the foundation of every database call `Boardly` will ever make. Seventy lines, one engine, one pool, one smoke test. The rest of the section deepens the layer above: in Lesson 03 we define the models; in Lesson 04 we wire relationships; in Lesson 05 we open sessions; in Lesson 06 we query them; in Lesson 07 we make everything async. The engine you built today stays the same — it is the stable core around which the rest of the section revolves. See you in Lesson 03.


---

**Tags:** #sqlalchemy #engine #connection-pool #canonical #review
**Previous:** [[01-Foundations-and-Architecture]]
**Next:** [[03-Declarative-Base-and-Mapped]] →

---
title: Troubleshooting Index
aliases:
 - Failure Mode Index
 - Common Errors
 - Troubleshooting Reference
tags:
 - exercises
 - troubleshooting
 - debugging
 - reference
course_level: intermediate
difficulty: intermediate
estimated_time: "5 minutes per entry; 2 hours to read all"
status: complete
prerequisites:
 - "[[01-Python-Foundations/Project-Layout-and-Imports]]"
 - "[[01-Python-Foundations/uv-Tooling-Workflows]]"
 - "[[03-FastAPI-Core/Application-and-Lifespan]]"
 - "[[07-SQLAlchemy/05-Session-and-Transaction-Management]]"
 - "[[10-Async-Python/Event-Loop-and-Coroutines]]"
 - "[[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]]"
related_lessons:
 - "[[20-Exercises-and-Labs/Debugging-Labs]]"
 - "[[19-Interview-Preparation/Production-Incidents-Debugging]]"
 - "[[00-Exercises-MOC]]"
---

# Troubleshooting Index

*A flat index of common failure modes. Each entry: **symptom**, **likely cause**, **diagnosis command**, **fix**. Start here when something is broken. The file is a reference, not a tutorial — match a symptom, run the diagnosis command, apply the fix, then follow the canonical link to the underlying lesson for prevention.*

**How to use this index**

When something breaks, your first instinct should be to search this file with `Ctrl+F` for the most distinctive word in your error message (`MissingGreenlet`, `asyncio.run`, `too many clients`, `fiscal_year`, `on_event`, `model.dict`). The matching entry gives you the diagnosis command to run, the most likely cause, and the fix. If the diagnosis rules out the likely cause, scan the symptom column again for the next-most-likely entry. The canonical-lesson link at the bottom of each entry is where you go to prevent the next occurrence — the fix is the patch; the lesson is the prevention.


#troubleshooting #debugging #reference

## How entries are structured

Each entry has four parts:

- **Symptom** — the error message or wrong behavior, phrased the way you'd see it in a traceback.
- **Likely cause** — what is usually happening when this symptom appears.
- **Diagnosis command** — a single shell command to confirm or rule out the likely cause.
- **Fix** — a concrete change to your code or environment.

After the table, a **canonical** line links to the lesson that explains the underlying concept, plus cross-references to any debugging lab or incident narrative that exercises the failure mode.

**Why is each entry a single symptom → diagnosis command → fix, not a deep dive?**

Because the file is a *reference*, not a tutorial. When something is broken in production, the user has 30 seconds to identify the entry, 30 seconds to run the diagnosis command, and 30 seconds to apply the fix. A deep-dive prose explanation in each entry would push the diagnosis command below the fold and slow the lookup. The deep-dive is one click away — the canonical-lesson link at the bottom of each entry is where the prevention lesson lives. The trade is: the index is shallow (one fix per entry, no "but what if that's not it?" branching) but fast (one search, one command, one fix). When the diagnosis rules out the likely cause, the user searches again — the next-most-distinctive word in the error leads to the next entry.

**Why does each entry have a `Diagnosis command` and not just a `Fix`?**

Because jumping to the fix without confirming the cause is the most common way to waste an hour. The `MissingGreenlet` error has five distinct causes (lazy load on a detached object, lazy load outside the session's await context, sync `session.refresh()` on an `AsyncSession`, an expired attribute after `commit()` with `expire_on_commit=True`, iterating a lazy `Mapped[list]` outside the session) — each with a different fix. Without the diagnosis command, the user guesses; with the diagnosis command, the user reads the traceback, runs the command, and the output tells them which of the five they have. The pattern is from the production-incidents methodology in [[19-Interview-Preparation/Production-Incidents-Debugging]]: form a hypothesis, disprove it with a single command, then act.

**How the entries are ordered**

Entries 1–12 are the "operationally common" failures — wrong project root, circular imports, missing `__init__.py`, async/await pitfalls, FK violations, pool exhaustion, migration ordering, JWT expiry, connection refused, Docker daemon, CI containers, and detached-instance errors. Entries 13–18 are the "framework-specific" failures — Redis pub-sub, Pydantic defaults, coroutine serialization, CORS, and `from_orm` validation. Entries 19–24 are the "tooling and version" failures — uv lockfile drift, Pydantic v1→v2 renames, SQLAlchemy `Query` removal, FastAPI `on_event` removal, `httpx` `ASGITransport`, and `pytest-asyncio` strict mode.


**Tip — The Ctrl+F workflow**

Don't read top to bottom. Search for the most distinctive word in your error (`MissingGreenlet`, `fiscal_year`, `on_event`, `model.dict`). The matching entry's diagnosis command should confirm or rule out the likely cause in under 30 seconds. If the diagnosis rules out the likely cause, search for the next-most-distinctive word.


**Warning — When the diagnosis doesn't match**

If you run the diagnosis command and it rules out the likely cause, don't immediately move to the next entry. Re-read the error message — sometimes the symptom matches two entries and the diagnosis distinguishes them. The "wrong first hypothesis" of incident 3 in [[19-Interview-Preparation/Production-Incidents-Debugging]] (a `MissingGreenlet` mis-diagnosed as a pool problem) is the canonical example.


---

## 1. `ModuleNotFoundError` / `ImportError` from wrong project root

| Field | Value |
|---|---|
| **Symptom** | `ModuleNotFoundError: No module named 'app'` (or your top-level package) when starting Uvicorn, running a script, or running pytest. |
| **Likely cause** | The Python interpreter's `sys.path` does not include the project root. You are running from a subdirectory, or you did not install your package in editable mode, or your `pyproject.toml` does not declare the package. |
| **Diagnosis command** | `uv run python -c "import sys; print(sys.path)"` from the directory you are running your command in. Confirm the project root is not in the list. |
| **Fix** | Run from the project root: `cd /path/to/project && uv run uvicorn app.main:app`. Or, install your package editable: `uv pip install -e .`. Or, declare the package layout in `pyproject.toml` (`[tool.setuptools.packages.find]` or `[tool.hatch.build]`). |

**Production reality: the `sys.path` check only catches the wrong-CWD case**

The `uv run python -c "import sys; print(sys.path)"` check only catches the "wrong CWD" case. The subtler case is a Docker image where the package is installed at `/app` but Uvicorn is invoked from `/app/src` (because the entrypoint is `cd /app/src && uvicorn app.main:app`) — the `sys.path` is `['/app/src', ...]` and `app` is found as `/app/src/app`, not `/app/app`, so a sibling package `app.utils` and a top-level `utils` module resolve differently. The diagnosis is `uv run python -c "import app; print(app.__file__)"` — the printed path tells you which `app` was imported, and if it is not the one you expected, the `sys.path` is the bug. In Docker, also check `docker exec <container> ls /app` to confirm the package layout matches the Dockerfile's `COPY` and `WORKDIR`. See [[01-Python-Foundations/uv-Tooling-Workflows]] and [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]].


Canonical: [[01-Python-Foundations/Project-Layout-and-Imports]], [[01-Python-Foundations/uv-Tooling-Workflows]].

---

## 2. Circular imports (`ImportError: cannot import name X`)

| Field | Value |
|---|---|
| **Symptom** | `ImportError: cannot import name 'User' from partially initialized module 'app.models.user'`. Often appears at startup. |
| **Likely cause** | Module A imports from module B at module level, and B imports from A. Python cannot resolve the cycle. Common in FastAPI: a router imports a service that imports a model that imports a schema that imports the router. |
| **Diagnosis command** | `uv run python -c "import app.main"` — see the traceback for the cycle. |
| **Fix** | Move the import inside the function (lazy import), or restructure so the cycle is broken (move the shared dependency to a third module), or use `from __future__ import annotations` to defer type-only imports. For Pydantic `BaseModel` relationships, use `model_rebuild()` after all classes are defined, or use `string` forward references in `Annotated`. |

Canonical: [[01-Python-Foundations/Project-Layout-and-Imports]], [[05-Project-Architecture/Layered-FastAPI-Apps]].

---

## 3. Missing `__init__.py`

| Field | Value |
|---|---|
| **Symptom** | `ImportError: attempted relative import with no known parent package`, or pytest not collecting tests in a directory, or a package not being detected. |
| **Likely cause** | The directory containing your code lacks `__init__.py` (or your tooling is configured for namespace packages and the path is wrong). |
| **Diagnosis command** | `ls your/package/dir/__init__.py` — if it prints `cannot access`, the file is missing. |
| **Fix** | Add an empty `__init__.py` to the directory. For namespace packages (PEP 420), make sure the parent directory is on `sys.path` and that you do not have a competing regular package of the same name. For pytest, set `[tool.pytest.ini_options] pythonpath = ["."]` or use `conftest.py` at the root. |

Canonical: [[01-Python-Foundations/Project-Layout-and-Imports]], [[01-Python-Foundations/pytest-Fundamentals]].

---

## 4. `RuntimeError: asyncio.run() cannot be called from a running event loop`

| Field | Value |
|---|---|
| **Symptom** | `RuntimeError: asyncio.run() cannot be called from a running event loop` when calling `asyncio.run(...)` from inside an async function or a Jupyter notebook. |
| **Likely cause** | You are already in an event loop. `asyncio.run` creates a new loop and forbids nesting. |
| **Diagnosis command** | `python -c "import asyncio; print(asyncio.get_running_loop())"` — if it returns a loop object, you are inside a running loop. |
| **Fix** | You are already in async code; `await` the coroutine directly instead of `asyncio.run`. If you must bridge sync to async (e.g., a sync callback in an async worker), use `asyncio.run_coroutine_threadsafe(coro, loop)` from a thread that does not own the loop. Do not use `nest_asyncio` in production. |

**Warning — When this breaks: `nest_asyncio` masks production-grade `RuntimeError`s**

`nest_asyncio` in a Jupyter cell that runs production-grade async code (a notebook that calls a service-layer `async def`) patches the loop globally for the kernel session; if the same kernel later runs a notebook cell that imports the app's `lifespan` and starts Uvicorn programmatically (`uvicorn.run(app, ...)`), the nested-loop patch masks a real `RuntimeError` that the production deployment would have surfaced. The fix is to never use `nest_asyncio` in any notebook that touches production code paths; instead, restart the kernel and use `await coro` directly in the cell (Jupyter's top-level await works because it runs in a loop). The diagnosis that you have a `nest_asyncio` patch active: `python -c "import nest_asyncio"` from inside the kernel — if it imports without error, the patch is active. See [[10-Async-Python/Event-Loop-and-Coroutines]] and [[19-Interview-Preparation/Async-and-Concurrency-Questions]] Q2.


Canonical: [[10-Async-Python/Event-Loop-and-Coroutines]], [[19-Interview-Preparation/Async-and-Concurrency-Questions]] Q2.

---

## 5. `MissingGreenlet` (SQLAlchemy async)

| Field | Value |
|---|---|
| **Symptom** | `sqlalchemy.exc.MissingGreenlet: greenlet_spawn has not been called; can't call __await__() here.` |
| **Likely cause** | A sync ORM access (typically a lazy-loaded relationship, an expired attribute, or a sync `session.refresh`) on an `AsyncSession`-loaded object outside the session's await context. |
| **Diagnosis command** | Read the traceback. The line that raises is the sync access; the bug is upstream (where the object was returned from a closed session). |
| **Fix** | Eager-load the relationship inside the session's scope: `select(User).options(selectinload(User.orders))`. Better: return a Pydantic DTO from the service, not an ORM object. See [[07-SQLAlchemy/07-Async-SQLAlchemy]] and Incident 3 in [[19-Interview-Preparation/Production-Incidents-Debugging]]. |

**Danger — How an attacker thinks: the `MissingGreenlet` traceback leaks column names**

The `MissingGreenlet` traceback leaks the lazy-load SQL — including the column names of the relationship being accessed — into the production log aggregator. For a `User.password_hash` lazy attribute, the traceback renders `SELECT users.id, users.email, users.password_hash FROM users WHERE users.id = ?` in plaintext in the log. An attacker with log-reader access (a leaked Grafana token, a mis-scoped CloudWatch role) pivots from "I can read your logs" to "I know your password-hash column is called `password_hash` and your table is `users`" — the next step is a SQL injection payload that targets that exact column. Configure `structlog`'s `ProcessorFormatter` to redact tracebacks matching `password|token|secret|key|hash` before the JSON renderer leaves the process; the redaction is a 10-line processor. See [[11-Authentication-and-Security/Password-Hashing]] and [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]].


Canonical: [[07-SQLAlchemy/07-Async-SQLAlchemy]].

---

## 6. `IntegrityError` on foreign key insert

| Field | Value |
|---|---|
| **Symptom** | `sqlalchemy.exc.IntegrityError: FOREIGN KEY constraint failed` (or `insert or update on table "X" violates foreign key constraint`). |
| **Likely cause** | You inserted a row referencing a foreign key that does not exist in the parent table, or you deleted a parent row that still has child rows. |
| **Diagnosis command** | `psql -c "SELECT * FROM parent_table WHERE id = <fk_value>"` — empty result = parent missing. For deletes: `SELECT * FROM child_table WHERE parent_id = <id>` to see what is blocking. |
| **Fix** | For inserts: insert the parent row first, or fix the FK value, or catch `IntegrityError` in the service layer and translate to 422 / 409. For deletes: cascade (`ON DELETE CASCADE`), soft-delete, or delete the children first. |

**Production reality: parsing the constraint name from `IntegrityError`**

The `psql -c "SELECT * FROM parent_table WHERE id = <fk_value>"` diagnosis works for a single FK, but a multi-FK insert (a `payment` row referencing `orders`, `users`, and `payment_methods`) needs the reverse — find which FK is missing. The query: `SELECT 'orders' AS ref_table, count(*) FROM orders WHERE id NOT IN (SELECT order_id FROM payments WHERE ...) UNION ALL ...` for each FK. In SQLAlchemy, the `IntegrityError` from psycopg/asyncpg includes the constraint name (`'payments_order_id_fkey'`) in the `orig.args[0]` string — parse it (`match = re.search(r'constraint "([^"]+)"', str(e.orig))`) to map back to the FK and return a 422 with a field-specific error rather than a generic 500. The diagnosis command for the constraint-to-FK mapping: `psql -c "\d+ payments"` shows the FK names and their referenced tables. See [[07-SQLAlchemy/05-Session-and-Transaction-Management]] and [[06-SQL-Fundamentals/Relational-Model-and-Constraints]].


Canonical: [[07-SQLAlchemy/05-Session-and-Transaction-Management]], [[06-SQL-Fundamentals/Relational-Model-and-Constraints]].

---

## 7. `OperationalError: too many clients` / pool exhausted

| Field | Value |
|---|---|
| **Symptom** | `sqlalchemy.exc.OperationalError: (psycopg.OperationalError) connection to server failed: FATAL: sorry, too many clients already` (with asyncpg: `(asyncpg.TooManyConnectionsError)`), or `sqlalchemy.exc.TimeoutError: QueuePool limit of size N overflow M reached`. |
| **Likely cause** | Either Postgres's `max_connections` is exceeded (total app connections > 100), or the SQLAlchemy pool is exhausted (sessions not being returned). |
| **Diagnosis command** | Postgres: `psql -c "SELECT count(*) FROM pg_stat_activity"`. Pool: enable SQLAlchemy pool events (`checkout`, `checkin`) and log; or use the `PoolStatus` API. |
| **Fix** | Match `workers × (pool_size + max_overflow) ≤ 0.8 × max_connections`. Add PgBouncer in transaction mode. Audit for session leaks (background tasks holding sessions, `async with AsyncSession` blocks not exiting). See Incident 6 in [[19-Interview-Preparation/Production-Incidents-Debugging]]. |

**Danger — How an attacker thinks: the slow endpoint as a pool-exhaustion DoS**

A slow endpoint (a `/search` with a 5-second query) is a pool-exhaustion DoS vector — an attacker who drives 100 concurrent requests to `/search` pins 100 pool slots per worker, the pool is exhausted, every other endpoint returns 500, and the attacker has taken down the service with a single slow endpoint. The defense is per-endpoint bulkhead isolation: route `/search` to a separate Uvicorn worker pool (a separate Kubernetes Deployment) with its own small connection pool (`pool_size=4`), so the slow endpoint can exhaust its own pool without touching the rest of the service. Pair with a per-endpoint concurrency limit (`slowapi.Limiter("10/minute")`) so the attacker cannot drive 100 concurrent requests in the first place. See [[15-External-Integrations/Circuit-Breaker-vs-Bulkhead-vs-Timeout]] and [[11-Authentication-and-Security/OWASP-API-Top-10]].


Canonical: [[07-SQLAlchemy/02-Engines-Connections-Pools]].

---

## 8. `alembic upgrade head`: mismatched head / multiple heads

| Field | Value |
|---|---|
| **Symptom** | `alembic upgrade head` fails with `Multiple heads are present; please specify which one to merge`, or after a deploy, the new code reports a missing column that the migration should have added. |
| **Likely cause** | Two feature branches both branched from the same parent and produced independent migration files; Alembic sees two heads and refuses to apply both. Or: the deploy ran migrations from a different commit than the running code. |
| **Diagnosis command** | `alembic heads` — if more than one head is listed, you have a branch. `alembic current` to see where the database is. |
| **Fix** | Create a merge migration: `alembic merge -m "merge heads" head1 head2`, then `alembic upgrade head`. To prevent: rebase feature branches on `main` before adding migrations; the second branch will see the first's migration and produce a linear chain. For deploys: ensure the deploy commit's migrations are applied; see Incident 5 in [[19-Interview-Preparation/Production-Incidents-Debugging]]. |

**Warning — When this breaks: `alembic merge` resolves the version graph, not the schema conflict**

`alembic merge` creates a merge migration, but if the two heads have conflicting `down_revision` chains that both modified the same table (both branches added a column to `orders`), the merge migration runs cleanly but the *application* of the merge's children may fail with `column "status_id" already exists` — the merge resolves the version-graph fork, not the schema conflict. The diagnosis: `alembic downgrade -1` from the merge point, then `alembic upgrade head` one step at a time with `--sql` to inspect the DDL before it runs. The pre-deploy guardrail: a CI step that runs `alembic upgrade head` against a copy of the production schema (`pg_dump --schema-only | psql test_db`) on every PR that touches migrations — schema conflicts surface in CI, not at deploy. See [[09-Alembic-Migrations/Data-Migrations-Safely]] and [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]].


Canonical: [[09-Alembic-Migrations/Alembic-Setup-and-Workflow]], [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]].

---

## 9. JWT "Signature has expired"

| Field | Value |
|---|---|
| **Symptom** | `jwt.exceptions.ExpiredSignatureError: Signature has expired`, or the client sees 401 with `{"detail": "Token has expired"}`. |
| **Likely cause** | The access token's `exp` claim is in the past. Either the token genuinely expired (expected behavior — the client should refresh), or the server clock is wrong, or the token was minted with a too-short lifetime. |
| **Diagnosis command** | Decode the JWT (without verifying) at `jwt.io` or with `jwt.decode(token, options={"verify_signature": False})` and read the `exp` claim. Compare to server time: `date -u`. |
| **Fix** | If the token legitimately expired: client should use the refresh token to mint a new access token. If the server clock is wrong: sync with NTP. If the lifetime is too short: increase `ACCESS_TOKEN_EXPIRE_MINUTES`. Always catch `ExpiredSignatureError` in the auth dependency and return 401 with a `WWW-Authenticate` header so the client knows to refresh. |

**Warning — When this breaks: clock skew between the auth service and the API**

The `exp` claim is checked against the server's clock, but the server's clock drifts — a 60-second skew between the auth service (which minted the token) and the API service (which verifies it) causes `ExpiredSignatureError` on every token with `exp` set to "now + 60s" because the API's clock is already past `exp` by the time it sees the token. The diagnosis: `date -u` on both services and `diff` the outputs — more than 5 seconds of skew is the bug. The fix is NTP on both (or a shared time service in Kubernetes — the node's clock, not the container's, which is the same). For the security side: never set `ACCESS_TOKEN_EXPIRE_MINUTES` below 5 minutes if clocks can skew by 60 seconds — the token expires before the client can use it. See [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]] and [[11-Authentication-and-Security/Threat-Model-First]].


Canonical: [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]].

---

## 10. `OperationalError`: connection refused

| Field | Value |
|---|---|
| **Symptom** | `sqlalchemy.exc.OperationalError: (psycopg.OperationalError) connection to server at "db" (10.0.0.5), port 5432 failed: Connection refused` (with asyncpg: `Connection refused` is wrapped the same way). |
| **Likely cause** | The database is not listening on the host/port, the firewall blocks the connection, the DNS resolves to the wrong host, or in Docker Compose, the app started before the DB was ready. |
| **Diagnosis command** | `nc -zv db 5432` (TCP reachability). `getent hosts db` (DNS). `docker compose ps` (container status). `docker compose logs db` (DB startup logs). |
| **Fix** | For Docker Compose: add `depends_on` with a `condition: service_healthy` and a `healthcheck` on the DB. For production: verify the DB is running, the security group allows the app's IP, and the host in the connection string is correct. For connection pooling issues, see entry 7. |

**Production reality: the service-mesh sidecar masks the real failure**

The `nc -zv db 5432` check confirms TCP reachability, but in a service mesh (Istio, Linkerd) the TCP connection is accepted by the sidecar proxy even if the upstream Postgres is down — the sidecar then returns a `503` to the app, which surfaces as a `connection refused`-shaped error in SQLAlchemy but with a different root cause. The deeper diagnosis: `kubectl exec <app-pod> -c <app-container> -- nc -zv db 5432` from inside the app container (bypassing the sidecar) confirms whether the app-to-DB path is the problem or the sidecar-to-DB path. In AWS RDS, also check the security group: `aws ec2 describe-security-groups --group-ids <sg-id> | jq '.SecurityGroups[0].IpPermissions'` — the inbound rule for port 5432 must include the app's security group, not just the app's CIDR. See [[16-Deployment-and-DevOps/Docker-Compose-Local-Dev]] and [[07-SQLAlchemy/02-Engines-Connections-Pools]].


Canonical: [[16-Deployment-and-DevOps/Docker-Compose-Local-Dev]], [[07-SQLAlchemy/02-Engines-Connections-Pools]].

---

## 11. Docker: `Cannot connect to the Docker daemon`

| Field | Value |
|---|---|
| **Symptom** | `Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?` |
| **Likely cause** | The Docker daemon is not running, or the user is not in the `docker` group, or the `DOCKER_HOST` env var points to a wrong socket. |
| **Diagnosis command** | `systemctl status docker` (Linux, systemd). `ls -l /var/run/docker.sock` (permissions). `echo $DOCKER_HOST`. |
| **Fix** | Start the daemon: `sudo systemctl start docker` (Linux), `open -a Docker` (macOS). Add your user to the `docker` group: `sudo usermod -aG docker $USER` then re-login. Unset `DOCKER_HOST` if it is wrong: `unset DOCKER_HOST`. For rootless Docker or Podman, see their docs. |

Canonical: [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]], [[16-Deployment-and-DevOps/Docker-Compose-Local-Dev]].

---

## 12. GitHub Actions service container not ready

| Field | Value |
|---|---|
| **Symptom** | CI tests fail intermittently with `OperationalError: connection refused` on the first test that hits the DB. Rerunning the job sometimes passes. |
| **Likely cause** | The service container (Postgres, Redis) is still starting when the test step runs. GitHub Actions starts the container, but does not wait for it to accept connections before running `steps`. |
| **Diagnosis command** | Add a step before tests: `pg_isready -h localhost -p 5432` and check exit code. Or run a `nc -zv localhost 5432` step. |
| **Fix** | Add a wait step using a tool like `wait-on`, `pg_isready` in a loop, or `nc` in a loop. Or, in the test setup, retry the connection for up to N seconds. Example: `until pg_isready -h localhost -p 5432; do sleep 1; done`. GitHub Actions also supports `options: --health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 5` on the service, which marks the container ready only when the healthcheck passes. |

Canonical: [[16-Deployment-and-DevOps/GitHub-Actions-CI]], [[12-Testing-and-Quality/CI-Pipelines]].

---

## 13. `DetachedInstanceError` (SQLAlchemy)

| Field | Value |
|---|---|
| **Symptom** | `sqlalchemy.orm.exc.DetachedInstanceError: Instance <User at 0x...> is not bound to a Session; attribute refresh operation cannot proceed`. |
| **Likely cause** | The ORM object was returned from a service that closed the session (e.g., a `with session:` block exited), and the caller accessed an attribute that needs the session (an unloaded relationship, an expired attribute). |
| **Diagnosis command** | Read the traceback for the attribute access. Confirm the session was closed before that point by inspecting the service. |
| **Fix** | Eager-load the attributes you need inside the session's scope. Better: return a Pydantic DTO from the service. If you must keep the ORM object, keep the session open for the access scope (use a request-scoped FastAPI dependency). |

**Production reality: `DetachedInstanceError` and `MissingGreenlet` are the same bug**

The `DetachedInstanceError` and the `MissingGreenlet` (entry 5) are the same bug from two angles — both fire when an attribute access happens after the session is closed. The difference is the driver: sync `Session` raises `DetachedInstanceError`, async `AsyncSession` raises `MissingGreenlet`. The diagnosis command for either: read the traceback to find the attribute access line, then walk the object's lifecycle backward to find the `async with AsyncSession(...)` (or `with Session(...)`) block that exited. The single fix for both — return a Pydantic DTO from the service, not an ORM object — eliminates an entire class of bug. In the test suite, the `raiseload` execution option (`Session(execution_options={"raiseload": True})`) turns lazy accesses into loud test failures for both sync and async sessions, catching the bug in CI before it reaches production. See [[07-SQLAlchemy/05-Session-and-Transaction-Management]] and [[07-SQLAlchemy/07-Async-SQLAlchemy]].


Canonical: [[07-SQLAlchemy/05-Session-and-Transaction-Management]].

---

## 14. `RuntimeError: The channel was closed` (asyncio + Redis pub/sub)

| Field | Value |
|---|---|
| **Symptom** | `RuntimeError: The channel was closed by remote server` or `Connection closed by server` from `redis.asyncio` or `aioredis`. |
| **Likely cause** | The Redis server closed the connection (timeout, restart, max-clients), and the client tried to use the now-stale connection. |
| **Diagnosis command** | `redis-cli ping` from the app host. `redis-cli info clients` to see connection count. |
| **Fix** | Use a connection pool with auto-reconnect (the `redis.asyncio` client does this by default for short-lived operations). For long-lived subscriptions, wrap the subscriber in a reconnect loop. Set `socket_keepalive=True` and a sensible `health_check_interval`. |

Canonical: [[14-Caching-and-Background-Processing/Redis-Cache-Aside]].

---

## 15. Pydantic v2: mutable default factory misuse

| Field | Value |
|---|---|
| **Symptom** | Two model instances share state: `m1.items.append(x)` and `m2.items` also contains `x`. Or: `UserError: unexpected value of "items"`. |
| **Likely cause** | You used `items: list[str] = []` (or any mutable default) in a Pydantic model — shared across all instances. Pydantic v2 raises an error for this; the workaround is `default_factory=list`. |
| **Diagnosis command** | Inspect the model definition; look for `= []`, `= {}`, `= set()`. |
| **Fix** | Use a factory: `items: list[str] = Field(default_factory=list)`. Same for `dict`, `set`, `deque`. For nested models, use `default_factory=lambda: MyModel(...)` if the default is a non-empty mutable. |

Canonical: [[04-Pydantic/BaseModel-and-Validation]], [[04-Pydantic/Fields-Annotated-Reusable-Annotations]].

---

## 16. `TypeError: Object of type 'coroutine' is not JSON-serializable`

| Field | Value |
|---|---|
| **Symptom** | `TypeError: Object of type coroutine is not JSON serializable` from FastAPI response rendering. |
| **Likely cause** | A handler returned a coroutine (the result of calling an `async def` without `await`) instead of the awaited result. |
| **Diagnosis command** | Read the handler; look for a call to an async function that is not awaited. |
| **Fix** | Add `await`. Alternatively, the function should not be `async def` (it does not need to be). FastAPI does not auto-await arbitrary return values; you must await. |

Canonical: [[10-Async-Python/Event-Loop-and-Coroutines]], [[03-FastAPI-Core/Path-Query-Header-Cookie-Body]].

---

## 17. CORS: `Access-Control-Allow-Origin` missing

| Field | Value |
|---|---|
| **Symptom** | Browser console: `Access to fetch at 'https://api.example.com/users' from origin 'https://app.example.com' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present`. |
| **Likely cause** | The API did not return the CORS headers. Either the `CORSMiddleware` is not added, the `allow_origins` does not include the requesting origin, or the route is not matched by the middleware (rare). |
| **Diagnosis command** | `curl -i -H "Origin: https://app.example.com" https://api.example.com/users`. Check for `Access-Control-Allow-Origin` in the response. |
| **Fix** | Add `CORSMiddleware` with `allow_origins=["https://app.example.com"]` (not `"*"` — that fails with credentials). For preflight (`OPTIONS`), make sure `allow_methods` and `allow_headers` include what the client sends. |

**Danger — How an attacker thinks: the wildcard-subdomain CORS + cookie combo**

`allow_origins=["*"]` with `allow_credentials=True` is a CORS misconfiguration that browsers block (the spec forbids the combination), but the subtler attack is `allow_origins=["https://*.example.com"]` (a wildcard subdomain) combined with a wildcard-subdomain cookie (`Set-Cookie: session=...; Domain=.example.com`) — any subdomain can read the response, so an attacker who controls `attacker.example.com` (a subdomain takeover of an unused `*.example.com` record, or a hosted blog on `blog.example.com` they can post to) can make authenticated cross-origin requests with the victim's cookie. The diagnosis: `curl -i -H "Origin: https://attacker.example.com" https://api.example.com/users` — if the response includes `Access-Control-Allow-Origin: https://attacker.example.com` and `Access-Control-Allow-Credentials: true`, the misconfig is live. The fix is an explicit allowlist of full origins (`["https://app.example.com", "https://admin.example.com"]`), never a wildcard subdomain. See [[02-Web-and-HTTP/CORS-Caching-Headers-Conditional-Requests]] and [[02b-Backend-Foundations/CSRF-Protection]].


Canonical: [[02-Web-and-HTTP/CORS-Caching-Headers-Conditional-Requests]], [[03-FastAPI-Core/Middleware-and-Request-Order]].

---

## 18. `ValidationError` from Pydantic on a `.from_orm()` / `model_validate`

| Field | Value |
|---|---|
| **Symptom** | `pydantic_core.ValidationError: 1 validation error for UserOut / Input should be a valid integer [type=int_type, input_value=...`. |
| **Likely cause** | You called `UserOut.model_validate(orm_obj)` but the model has `model_config = ConfigDict(from_attributes=True)` missing (or in v1, `Config.orm_mode = True`). Or the ORM object has a column of a different type than the Pydantic model. |
| **Diagnosis command** | Inspect the Pydantic model's `model_config`. Inspect the field types. |
| **Fix** | Add `model_config = ConfigDict(from_attributes=True)` to the model. Verify the field types match the ORM column types. For optional relationships, use `T | None`. |

Canonical: [[04-Pydantic/Serialization-and-Model-Dump]], [[07-SQLAlchemy/03-Declarative-Base-and-Mapped]].

---

## 19. `uv` lockfile out of sync

| Field | Value |
|---|---|
| **Symptom** | `uv: error: failed to load lockfile: lockfile is out of date` or `Found 1 mismatched package version` when running `uv sync`, `uv run`, or `uv lock --check` in CI. |
| **Likely cause** | Someone edited `pyproject.toml` (added/removed/upgraded a dependency) without running `uv lock`. The lockfile (`uv.lock`) no longer matches `pyproject.toml`. |
| **Diagnosis command** | `uv lock --check` — exits non-zero if the lockfile is stale. `git diff pyproject.toml uv.lock` to see the divergence. |
| **Fix** | Run `uv lock` to regenerate the lockfile, then commit both `pyproject.toml` and `uv.lock`. In CI, add a step: `uv lock --check` to fail-fast on stale lockfiles. To prevent: a `pre-commit` hook that runs `uv lock --check` and refuses the commit if the lockfile is stale. |

**Warning — When this breaks: `uv sync` without `--frozen` may upgrade transitive deps**

`uv lock --check` catches a stale lockfile, but the subtler failure is a lockfile that is in-sync with `pyproject.toml` but out-of-sync with the *resolved* versions in the environment — `uv sync --frozen` reproduces the locked versions exactly, but `uv sync` (without `--frozen`) may upgrade transitive deps if the lockfile's hashes do not match (rare, but happens with `--no-cache` builds). The diagnosis: `uv sync --frozen` in CI (fail the build if it cannot reproduce the lockfile exactly), and `git diff uv.lock` on every PR — the lockfile diff is the actual dependency change, not the `pyproject.toml` diff. For the security side: `uv tree` shows the resolved dependency tree, and `uv tree | rg -i "requests|urllib3|cryptography"` on every PR catches transitive dep upgrades of security-sensitive libraries. See [[01-Python-Foundations/uv-Tooling-Workflows]] and [[12-Testing-and-Quality/CI-Pipelines]].


Canonical: [[01-Python-Foundations/uv-Tooling-Workflows]].

---

## 20. `pydantic` `model.dict()` deprecated

| Field | Value |
|---|---|
| **Symptom** | `PydanticDeprecatedSince20: model.dict() is deprecated. Use model.model_dump() instead.` Or `AttributeError: 'BaseModel' object has no attribute 'json'` after a future upgrade removes the deprecated methods. |
| **Likely cause** | Your code uses the Pydantic v1 API on a Pydantic v2 install. v2 renamed `.dict()` → `.model_dump()`, `.json()` → `.model_dump_json()`, `.parse_obj()` → `.model_validate()`, `.parse_raw()` → `.model_validate_json()`. |
| **Diagnosis command** | `uv run python -W error::DeprecationWarning -m pytest` — turns deprecation warnings into errors so the failing call surfaces in the traceback. |
| **Fix** | Replace v1 names with v2 names: `.dict()` → `.model_dump()`, `.json()` → `.model_dump_json()`, `.parse_obj()` → `.model_validate()`, `.parse_raw()` → `.model_validate_json()`, `Config` class → `model_config = ConfigDict(...)`, `orm_mode = True` → `from_attributes = True`. Use `bump-pydantic` (a tool) to automate the migration. |

Canonical: [[04-Pydantic/BaseModel-and-Validation]], [[04-Pydantic/Serialization-and-Model-Dump]].

---

## 21. `SQLAlchemy` legacy `Query` removed in 2.x edge cases

| Field | Value |
|---|---|
| **Symptom** | `AttributeError: 'Query' object has no attribute 'get'` (when calling `session.query(Model).get(id)` in 2.x; `Query.get()` is removed, use `Session.get()`), or `InvalidRequestError: Query with ... is not supported` (certain legacy `join()`/`with_entities()` patterns). |
| **Likely cause** | You used the legacy 1.x `Query` API in a way that 2.x has fully removed or partially deprecated. The `session.query(Model)` form still works in 2.x, but several methods (`Query.get()`, certain `join()` patterns with `Query`) are gone or behave differently. |
| **Diagnosis command** | `uv run python -c "import sqlalchemy; print(sqlalchemy.__version__)"` — confirm 2.x. Then inspect the failing call: is it `session.query(...).get(id)` or another legacy form? |
| **Fix** | Replace `session.query(Model).get(id)` with `session.get(Model, id)` (the 2.x form, identity-map cached). Replace `session.query(Model).filter(...).all()` with `session.scalars(select(Model).where(...)).all()`. The migration is mechanical but should be done per-call; see [[07-SQLAlchemy/06-Querying-with-select]]. |

Canonical: [[07-SQLAlchemy/06-Querying-with-select]], [[07-SQLAlchemy/03-Declarative-Base-and-Mapped]].

---

## 22. `FastAPI` `on_event` deprecated since 0.93 (still works in 0.148 but louder warning)

| Field | Value |
|---|---|
| **Symptom** | `DeprecationWarning: on_event is deprecated, use lifespan instead` at startup, or in 0.148.0 the warning is louder (still works, but flagged); future versions may remove. |
| **Likely cause** | Your code uses `@app.on_event("startup")` and `@app.on_event("shutdown")`. FastAPI 0.93 (March 2023) deprecated these in favor of the `lifespan=` context manager. As of 0.148.0 they still work but emit `DeprecationWarning`. |
| **Diagnosis command** | `uv run python -W error::DeprecationWarning -m pytest` — surfaces the warning. `rg 'on_event' --type py` to find usages. |
| **Fix** | Replace `@app.on_event("startup")` and `@app.on_event("shutdown")` with a single `async def lifespan(app): ...` decorated with `@asynccontextmanager`, passed to `FastAPI(lifespan=lifespan)`. Code before `yield` runs at startup; code after runs at shutdown. See [[03-FastAPI-Core/Application-and-Lifespan]]. |

**Warning — When this breaks: orphaned background tasks hang the lifespan shutdown**

The `lifespan` migration is mechanical, but the subtler failure is a `lifespan` that creates background tasks via `asyncio.create_task` in the startup phase and forgets to cancel them in the shutdown phase — the tasks are orphans, the loop cannot close cleanly, and Uvicorn hangs on `SIGTERM` until the Kubernetes `terminationGracePeriodSeconds` (default 30 s) kills it. The diagnosis: `kubectl delete pod <pod>` and watch the time-to-terminate — if it is exactly 30 s every time, the lifespan is hanging on shutdown. The fix: track created tasks in a set (`background_tasks: set[asyncio.Task] = set()`), add to the set on `create_task`, `discard` on completion, and `for t in background_tasks: t.cancel(); await asyncio.gather(*background_tasks, return_exceptions=True)` in the shutdown phase before `yield`-exit. See [[03-FastAPI-Core/Application-and-Lifespan]] and [[03-FastAPI-Core/Background-Tasks-Streaming-Uploads]].


Canonical: [[03-FastAPI-Core/Application-and-Lifespan]].

---

## 23. `httpx` `ASGITransport` in tests: wrong base URL or no transport

| Field | Value |
|---|---|
| **Symptom** | `httpx.UnsupportedProtocol: Cannot send a request without a transport` or `RuntimeError: no response returned` in async tests of a FastAPI app using `httpx.AsyncClient`. |
| **Likely cause** | You constructed `httpx.AsyncClient()` without an `ASGITransport(app=app)`. Without the transport, httpx tries to make a real HTTP connection — and fails because `base_url="http://test"` has no real server. |
| **Diagnosis command** | Inspect your test: `httpx.AsyncClient(...)` should include `transport=ASGITransport(app=app)` and `base_url="http://test"`. |
| **Fix** | ```python from httpx import ASGITransport, AsyncClient; async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client: resp = await client.get("/users/1")``` — the `ASGITransport` routes the request through the app's ASGI stack (middleware, dependencies, exception handlers) without a real socket. See [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]] and Q13 of [[19-Interview-Preparation/FastAPI-and-DI-Questions]]. |

Canonical: [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]], [[12-Testing-and-Quality/Async-Testing]].

---

## 24. `pytest-asyncio` strict mode warnings

| Field | Value |
|---|---|
| **Symptom** | `PytestUnasyncFixtureWarning: async def fixtures are not natively supported` or `ScopeMismatch: You tried to access a function scoped fixture ... from a session scoped one` or tests skipped silently with `pytest: async test skipped (mode=strict)`. |
| **Likely cause** | `pytest-asyncio`'s default mode is `strict`, which requires every async test to be marked `@pytest.mark.asyncio`. Forgetting the mark causes the test to be skipped or to fail fixture wiring. Also, async fixtures need the right scope or they leak. |
| **Diagnosis command** | `uv run pytest --asyncio-mode=strict -v` — strict mode reports every unmarked test. `uv run pytest --asyncio-mode=auto -v` — auto mode marks everything; if tests pass in auto but fail in strict, you have unmarked tests. |
| **Fix** | Mark every async test: `@pytest.mark.asyncio`. For async fixtures, declare the scope explicitly: `@pytest_asyncio.fixture(scope="session")`. Consider switching to `asyncio_mode = "auto"` in `pyproject.toml` if the project is small enough that every test is async; for mixed projects, keep `strict` and mark each. See [[12-Testing-and-Quality/Async-Testing]]. |

Canonical: [[12-Testing-and-Quality/Async-Testing]], [[01-Python-Foundations/pytest-Fundamentals]].

---

## Link-checker script for the vault

A small bash script to catch broken wikilinks (e.g., a link to a note that does not resolve to a file) before they confuse a reader. Run it from the vault root.

**Why is a link-checker part of the troubleshooting index?**

Because the most common vault failure mode is a renamed or moved note that breaks a wikilink elsewhere. The fix is mechanical, but you can't fix what you can't see. The script catches the breakage before a reader does. Add it to CI.


```bash
#!/usr/bin/env bash
# vault-link-checker.sh — check Obsidian wikilinks resolve to a file.
# Usage: ./vault-link-checker.sh [vault-root]
#
# Resolves links by:
#   1. Exact path     — [[folder/Note]]          → folder/Note.md
#   2. Folder-only    — [[folder]]               → folder/00-*-MOC.md (Obsidian
#                                                  resolves folder-only links to
#                                                  the folder's MOC file)
#   3. Note basename  — [[Note]]                 → first matching basename
#
# Suppresses false positives by:
#   - stripping fenced code blocks (```...```) before scanning;
#   - stripping inline-code spans (`...` on a single line) so that
#     `[[tool.mypy.overrides]]` inside backticks is not treated as a wikilink.
#
# Limitations:
# - Does not detect links to non-.md files (images, PDFs).
# - Duplicate-basename warnings are advisory; Obsidian resolves by nearest.

set -euo pipefail

VAULT="${1:-$(pwd)}"
cd "$VAULT"

# Build a list of all note names (filename without extension) and all paths.
mapfile -t NOTES < <(find . -name '*.md' -type f | sed -E 's|^\./||; s|\.md$||')
declare -A NAME_TO_PATH
for n in "${NOTES[@]}"; do
 base="$(basename "$n")"
 # Keep the first occurrence; warn on duplicates.
 if [[ -n "${NAME_TO_PATH[$base]:-}" ]]; then
 echo "WARN: duplicate note name '$base' — ${NAME_TO_PATH[$base]} and $n" >&2
 else
 NAME_TO_PATH["$base"]="$n"
 fi
done

# strip_prose.awk: drop fenced code blocks AND inline-code spans from a
# markdown file so links shown as examples do not produce false positives.
STRIP_AWK='BEGIN { in_block = 0 }
/^```/ { in_block = !in_block; next }
!in_block {
 # Strip inline-code spans (text between backticks on a single line).
 # Handles one or more backticks. Uses a simple loop because awk's gsub
 # cannot non-greedily match.
 line = $0
 while (match(line, /`[^`]*`/)) {
 line = substr(line, 1, RSTART - 1) substr(line, RSTART + RLENGTH)
 }
 print line
}'

# Find all wikilinks. Match [[Note]] and [[Note|Display]] and [[folder/Note]].
broken=0
while IFS= read -r file; do
 prose=$(awk "$STRIP_AWK" "$file")
 while IFS= read -r link; do
 target="${link%%|*}" # strip display name
 # Handle escaped pipe inside markdown table cells: [[Note\|Display]].
 # Strip the escaped pipe first, then the literal pipe (if any).
 target="${link%%\\|*}"
 target="${target%%|*}"
 # Skip empty links and anchors.
 [[ -z "$target" || "$target" == "#"* ]] && continue
 # Strip anchor section if present.
 target="${target%%#*}"
 # Strip header section if present.
 target="${target%%^*}"
 candidate=""
 if [[ "$target" == *"/"* ]]; then
 # Path-style link: folder/Note or folder/.
 if [[ -f "$target.md" ]]; then
 candidate="$target"
 elif [[ -d "$target" ]]; then
 # Folder/ — resolve to folder's 00-*-MOC.md if present.
 moc=$(find "$target" -maxdepth 1 -name '00-*-MOC.md' | head -n1 || true)
 if [[ -n "$moc" ]]; then
 candidate="${moc%.md}"
 fi
 fi
 elif [[ -d "$target" ]]; then
 # Bare folder name (no slash): resolve to folder's 00-*-MOC.md.
 moc=$(find "$target" -maxdepth 1 -name '00-*-MOC.md' | head -n1 || true)
 if [[ -n "$moc" ]]; then
 candidate="${moc%.md}"
 fi
 else
 # Bare-note link: resolve by basename.
 candidate="${NAME_TO_PATH[$target]:-}"
 fi
 if [[ -z "$candidate" || ! -f "$candidate.md" ]]; then
 echo "BROKEN: [[$link]] in $file"
 broken=$((broken + 1))
 fi
 done < <(printf '%s' "$prose" | rg --no-filename --pcre2 -o '\[\[([^\]]+)\]\]' | sed -E 's/^\[\[//; s/\]\]$//')
done < <(find . -name '*.md' -type f)

if (( broken > 0 )); then
 echo ""
 echo "Total broken links: $broken"
 exit 1
fi
echo "All wikilinks resolve."
```

Save as `vault-link-checker.sh`, make executable, and run:

```bash
chmod +x vault-link-checker.sh
./vault-link-checker.sh /home/z/my-project/FastAPI-Engineering-Academy
```

The script uses `rg` (ripgrep) for speed. It reports:

- **Duplicate note names** — two files with the same basename; Obsidian may resolve ambiguously.
- **Broken wikilinks** — a link whose target note does not exist anywhere in the vault.

This is a developer-ergonomics tool. Add it to CI to catch broken links before merging a content change.

## Related

- [[Debugging-Labs]] — hands-on practice for entries 5, 6, 7, and 8.
- [[19-Interview-Preparation/Production-Incidents-Debugging]] — narrative versions of several entries (1, 5, 7, 8).
- [[00-Exercises-MOC]] — this folder's index.

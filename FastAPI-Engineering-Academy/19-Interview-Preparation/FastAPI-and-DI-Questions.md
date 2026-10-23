---
title: FastAPI and Dependency Injection: Interview Questions
aliases:
 - FastAPI Interview Questions
 - DI Interview Questions
 - FastAPI and DI Questions
tags:
 - interview
 - fastapi
 - dependency-injection
course_level: intermediate
difficulty: intermediate
estimated_time: "3–4 hours for a full rehearsal"
status: complete
prerequisites:
 - "[[03-FastAPI-Core/Dependency-Injection]]"
 - "[[03-FastAPI-Core/Application-and-Lifespan]]"
 - "[[03-FastAPI-Core/Middleware-and-Request-Order]]"
 - "[[03-FastAPI-Core/Exception-Handlers]]"
related_lessons:
 - "[[03-FastAPI-Core/Application-and-Lifespan]]"
 - "[[03-FastAPI-Core/Dependency-Injection]]"
 - "[[03-FastAPI-Core/Middleware-and-Request-Order]]"
 - "[[03-FastAPI-Core/Exception-Handlers]]"
 - "[[03-FastAPI-Core/Background-Tasks-Streaming-Uploads]]"
 - "[[12-Testing-and-Quality/Testing-FastAPI-Endpoints]]"
---

# FastAPI and Dependency Injection: Interview Questions

*A question bank on FastAPI internals and the dependency-injection system. Every answer links back to the canonical lesson. Use these to rehearse your **reasoning out loud**, not to memorize phrasing.*

**How to use this file**

For each question: read the question, close the file, set a five-minute timer, and write the answer in your own words in a blank document. Then re-open the file, compare, and fill the gaps. The model answer is the *shape* of a senior response — not the script. If you cannot reproduce the reasoning, you do not yet know it. Interviewers reward specificity; every model answer here includes a concrete code example because that is what wins offers.


#interview #fastapi #dependency-injection

---

## Q1: What is a FastAPI lifespan and why would you use one instead of just creating resources at import time?

### What a strong answer demonstrates

You know the difference between *module import time* and *application startup time*. You understand that resources have lifecycles, and that the ASGI server may run the app in multiple workers — meaning import-time singletons get duplicated per worker, can leak, and have no graceful shutdown path. You can name at least three concrete resources that belong in a lifespan.

### Model answer

A lifespan is the asynchronous context manager FastAPI runs once at startup and once at shutdown, attached to the `FastAPI()` instance via the `lifespan` parameter. The `@asynccontextmanager` decorator turns a single `async def` with one `yield` into the context manager Starlette expects — everything before the `yield` is startup, everything after is shutdown. The older `@app.on_event("startup")` / `@app.on_event("shutdown")` pair is still supported in 0.148.0 but has been deprecated since 0.93 and is not the form you should reach for in new code; see [[03-FastAPI-Core/Application-and-Lifespan]] for the historical context.

You use a lifespan for resources that must be opened before the app accepts traffic and closed cleanly when it stops — typically the SQLAlchemy `AsyncEngine`, a Redis pool, an `httpx.AsyncClient` with a connection pool, a Kafka consumer, or a background task scheduler. Putting these in a lifespan means:

- **You control ordering.** Open the DB before the Redis pool that depends on it for idempotency keys; close them in reverse. With the context manager, ordering is just code order — top to bottom.
- **You can share state cleanly.** Stash open resources on `app.state.engine` and read them back from dependencies, which is testable (you can pass a mock `app`) and avoids module-level globals.
- **Shutdown is graceful.** In-flight requests finish, background workers drain, connection pools are disposed. Uvicorn sends `SIGTERM` and the lifespan's shutdown block runs before the process exits.

Creating resources at import time is wrong for three reasons: (1) each Uvicorn worker is a separate process, so a module-level singleton is per-worker, not shared — and you have to be deliberate about that; (2) there is no shutdown hook, so connection pools leak when the worker is reloaded by `--reload` or by an orchestrator; (3) importing the app for tests opens real connections to a real database before any fixture has had a chance to swap them. The lifespan solves all three by giving you one explicit, ordered, testable lifecycle.

**Interviewer's follow-up: "Why can't I just put `engine = create_async_engine(...)` at module level?"**

Because (a) it duplicates per worker — you have N engines, N pools, and `workers × pool_size` connections even if your app "logically" wants one; (b) it leaks on reload — there is no `engine.dispose()` to call; (c) it breaks tests — `from app.main import app` opens a real DB connection before your test fixtures can swap it for a test DB. The lifespan is the FastAPI-endorsed fix for all three.


### Practical example

```python
from contextlib import asynccontextmanager
from fastapi import FastAPI

@asynccontextmanager
async def lifespan(app: FastAPI):
 # --- startup: open resources that live for the whole process ---
 engine = create_async_engine(settings.db_url, pool_size=10, pool_pre_ping=True)
 app.state.engine = engine
 redis = Redis.from_url(settings.redis_url)
 app.state.redis = redis
 yield # <-- traffic is now accepted
 # --- shutdown: close them in reverse order ---
 await redis.close()
 await engine.dispose()

app = FastAPI(title="Boardly", lifespan=lifespan)

# A dependency reads the open engine back from app.state:
async def get_session(request: Request) -> AsyncSession:
 engine = request.app.state.engine
 async with AsyncSession(engine, expire_on_commit=False) as session:
 yield session
```

### Common weak answers

- "Lifespan is just startup and shutdown events." — true but useless. The interviewer wants to know what you put there and why.
- "So the app knows when to start." — that is what `app.start()` would do. The lifespan exists because *something* needs to be opened before requests arrive and *something* needs to be closed when they stop.
- "To initialize settings." — Pydantic Settings read at instantiation, not at startup. Mixing this up signals you have not separated config from runtime resources.

### Follow-up questions

- How does `app.state` differ from a module-level global? (Module-level globals are per-worker, not per-process-shared; they are also shared across tests, which is what makes them a problem.)
- What happens to an in-flight request when the lifespan enters shutdown? (Starlette stops accepting new requests and waits for active ones to finish before exiting the context manager.)
- Can you have multiple lifespans? (Compose them with `contextlib.AsyncExitStack` — see [[01-Python-Foundations/Iterators-Generators-Context-Managers]].)
- What raises in the shutdown block? (Anything you don't catch. Starlette logs it and continues.)

**Additional practical example — composing multiple lifespans with `AsyncExitStack`:**

```python
from contextlib import asynccontextmanager, AsyncExitStack
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import create_async_engine
from redis.asyncio import Redis
import httpx

@asynccontextmanager
async def lifespan(app: FastAPI):
 async with AsyncExitStack() as stack:
 engine = create_async_engine(settings.db_url, pool_size=10, pool_pre_ping=True)
 stack.push_async_callback(engine.dispose)
 app.state.engine = engine
 redis = Redis.from_url(settings.redis_url)
 stack.push_async_callback(redis.close)
 app.state.redis = redis
 http_client = httpx.AsyncClient(timeout=httpx.Timeout(10.0, connect=2.0))
 stack.push_async_callback(http_client.aclose)
 app.state.http = http_client
 yield

app = FastAPI(title="Boardly", lifespan=lifespan)
# AsyncExitStack guarantees reverse-order teardown:
# http_client.aclose() -> redis.close() -> engine.dispose()
# even if any individual teardown raises, the remaining ones still run.
```

**Additional common weak answers:**

- "I'd put `engine = create_async_engine(...)` at module level; that's how Django does it." — Django has no shutdown hook and pays the same per-worker duplication cost; the lifespan is FastAPI's answer to both. Module-level engines also leak on `--reload` because there is no `engine.dispose()` to call.
- "Lifespan is only for the database." — any resource with a lifecycle (Redis pool, `httpx.AsyncClient` with keepalive, Kafka consumer, APScheduler, ML model weights) belongs here. The rule is "open before traffic, close in reverse order"; the resource type does not matter.

**Additional follow-up questions:**

- How do you test that startup ran? (Use `asgi-lifespan.LifespanManager` in tests to drive the lifespan; assert on `app.state.engine` after entry. Without it, `httpx.AsyncClient(transport=ASGITransport(app=app))` skips the lifespan and `app.state.engine` is missing.)
- What happens if startup raises? (Starlette marks the app as failed; subsequent HTTP requests return 503 with an `application startup failed` log line. The shutdown block does not run because startup never completed, so partially-opened resources leak — guard each `push_async_callback` with its own try/except.)

Canonical: [[03-FastAPI-Core/Application-and-Lifespan]], [[07-SQLAlchemy/02-Engines-Connections-Pools]].

---

## Q2: Does FastAPI cache dependencies? What does that mean, and when does it break?

### What a strong answer demonstrates

You understand that FastAPI caches dependency **results per request**, not globally. You know that the same dependency called twice in the same request gets the same object back, and you know the failure mode: if a dependency yields a database session and two endpoints in the request path both take it, they share the same transaction.

### Model answer

FastAPI caches the return value of a dependency function per request. If `get_session` is declared as a dependency of two endpoints invoked in the same request — say, the route handler and a sub-dependency — `get_session` runs **once**, and both consumers receive the same `AsyncSession` instance.

Implications:

- **Good**: per-request cost is bounded; you do not open three DB sessions for one request. A single `get_current_user` dependency is run once even if every route depends on it.
- **Bad**: if you wanted isolation, you do not get it. Two endpoints sharing a session also share the transaction, the identity map (see [[Glossary#I]]), and any uncommitted state. A `rollback()` in one undoes work in the other.
- **Escape hatch**: set `use_cache=False` on the `Depends(...)` call to disable caching for that dependency. Use this when a sub-dependency genuinely needs its own session — for example, an audit-log writer that must persist even if the main request rolls back.

The cache is keyed by the *dependency callable identity*, not by argument values. Two calls of the same parameterized factory (`get_user_scoped(tenant_id)`) are still cached as a single resolution, because FastAPI sees the same callable. If you need per-argument isolation, you need different callable objects (e.g., a closure-returning factory pattern).

**Tip — When to actually reach for `use_cache=False`**

Rarely. The common legitimate case is: a sub-dependency needs to write audit rows in a separate transaction so they survive a rollback of the main request. The audit-log dependency calls `AsyncSession(engine)` directly, declares itself with `use_cache=False`, and commits independently. Everything else should let FastAPI cache normally.


**Interviewer's follow-up: "What is the cache *key* — the callable identity, the argument values, or something else?"**

The callable identity. `Depends(get_session)` and `Depends(get_session)` are the same key — FastAPI sees the same callable object and resolves the dependency once. The arguments are *not* part of the key, which is why a parameterized factory like `get_user_scoped(tenant_id)` is still one cache entry regardless of `tenant_id`. To get per-argument isolation you need different callable objects — a closure-returning factory like `make_user_scoped(tenant_id)` that returns a *new function* per call. Or `use_cache=False` if the cost of recomputation is acceptable. This is a frequent source of subtle bugs: developers assume "different arguments, different cache entries" and are surprised when two routes get the same `tenant_id`-scoped user.


### Practical example

```python
async def get_session() -> AsyncSession:
 async with AsyncSession(engine) as session:
 yield session

@router.get("/orders/{id}")
async def get_order(id: int, session: Annotated[AsyncSession, Depends(get_session)]):
 order = await service.get_order(session, id) # service also takes a session
 return order

# If service.get_order re-declares Depends(get_session), it receives the SAME session.
# To force isolation:
isolated_audit_session = Depends(get_session, use_cache=False)
```

### Common weak answers

- "Yes, dependencies are cached globally." — they are not. They are per-request. Confusing the two is the failure mode.
- "It's an LRU." — no, it is a per-request dict, cleared when the request ends.
- "I'm not sure, I just use `Depends` and it works." — this is the answer that ends the interview.

### Follow-up questions

- If two routes share `Depends(get_session)`, do they share a transaction? (Yes — same session, same transaction.)
- How do you opt out? (`use_cache=False` on the `Depends(...)` call.)
- What happens to the cache when the handler raises? (It is discarded along with the request; `yield` dependencies still get their cleanup — see Q4.)

**Additional practical example — the audit-log dependency that needs its own transaction:**

```python
from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

# A sub-dependency that must persist audit rows even if the main
# request's transaction rolls back. use_cache=False tells FastAPI to
# resolve this dependency fresh instead of returning the cached main
# session from Depends(get_session).
audit_sessionmaker = async_sessionmaker(audit_engine, expire_on_commit=False)

async def get_audit_session() -> AsyncSession:
 async with audit_sessionmaker() as session:
 async with session.begin():
 yield session

audit_session = Depends(get_audit_session, use_cache=False)

@router.post("/orders", response_model=OrderOut, status_code=201)
async def create_order(
 payload: OrderIn,
 session: DbSession,                  # cached main session, one transaction
 audit: AsyncSession = audit_session,  # separate session, independent tx
):
 order = await service.create_order(session, payload)
 audit.add(AuditRow(action="order_create", target_id=order.id))
 # If the main transaction rolls back, the audit row still commits.
 return order
```

**Additional common weak answers:**

- "The cache is per-process." — it is per-request, which is exactly what makes it safe across requests. Per-process caching would be a global singleton and is the failure mode people wrongly attribute to FastAPI's `Depends`.
- "I'd just call `get_session()` directly inside the route." — that bypasses FastAPI's resolution machinery; the result is not cached (you open two sessions per request), and `yield` cleanup does not run because the route never registered the dependency with the request's `AsyncExitStack`. Always go through `Depends`.

**Additional follow-up questions:**

- Does the per-request cache survive `BackgroundTasks`? (Yes, while the request scope is alive — the cache is tied to the request's `AsyncExitStack`, which tears down after the response is sent and after registered background tasks complete. A background task that resolves its own `Depends` gets a fresh resolution.)
- What is the cache key for a class-based dependency? (The class object itself — every `Depends(MyDep)` shares one resolution per request. Two different instances of the same class are not distinguished; use a closure-returning factory if you need per-instance isolation.)

Canonical: [[03-FastAPI-Core/Dependency-Injection]].

---

## Q3: What is the difference between `Annotated[T, Depends(...)]` and using `Depends(...)` as a default value? Which should you use?

### What a strong answer demonstrates

You know both forms compile and run, that the `Annotated` form was made canonical in FastAPI 0.95 (April 2023) for two reasons — type-checker friendliness and a cleaner separation of the type from the dependency declaration — and that new code in 2026 should use `Annotated`.

### Model answer

Two forms, same behavior at runtime:

```python
# Form A — Depends as default value (pre-0.95 idiom):
def get_order(id: int, session: AsyncSession = Depends(get_session)): ...

# Form B — Annotated (canonical since 0.95):
def get_order(id: int, session: Annotated[AsyncSession, Depends(get_session)]): ...
```

Both forms work in FastAPI 0.148.0. Form B is preferred because:

1. **Type checkers see the real type.** With Form A, mypy and pyright infer the parameter's type from `AsyncSession = Depends(...)`, which they read as `Depends[Any]` or `AsyncSession` depending on the checker's stubs. With Form B, the parameter is *unambiguously* `AsyncSession` to the type checker; the `Depends(...)` is metadata, not a default. This means your tooling can catch `session.foo()` where `foo` doesn't exist on `AsyncSession`.
2. **Reusable annotation aliases.** You can declare once: `DbSession = Annotated[AsyncSession, Depends(get_session)]` and then use `session: DbSession` everywhere. Refactor the dependency in one place.
3. **OpenAPI generation is unchanged.** Both forms produce the same OpenAPI schema.

There is one place Form A is still useful: when you have many `Annotated` markers competing for space and you want the parameter declaration readable on one screen. But the consistency win of Form B everywhere outweighs this.

**Interviewer's follow-up: "Can you mix the two forms?"**

Yes, on different parameters. But do not mix them on the *same* parameter — `session: Annotated[AsyncSession, Depends(get_session)] = Depends(get_session)` will run the dependency twice. Pick one form per project and stick with it.


### Practical example

```python
from typing import Annotated
from fastapi import Depends, FastAPI

# Reusable alias — declare once, use everywhere:
DbSession = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]

@router.get("/orders/{id}")
async def get_order(id: int, session: DbSession, user: CurrentUser) -> OrderOut:
 ...
```

### Common weak answers

- "They're identical." — they are not; Form B is friendlier to type checkers and supports reusable aliases.
- "`Annotated` is required in 0.148." — it is not required, it is recommended. Form A still works.
- "`Annotated` is faster." — there is no measurable performance difference. The reasons to use Form B are tooling and reuse, not speed.

### Follow-up questions

- How would you write a reusable dependency alias? (`DbSession = Annotated[AsyncSession, Depends(get_session)]`.)
- Does FastAPI's OpenAPI generation differ between the forms? (No — same schema.)
- What does `Annotated` actually do at the type level? (It attaches metadata to the type without changing it — see [[01-Python-Foundations/Type-Hints-and-Annotations]] and PEP 593.)

**Additional practical example — the type-checker friendliness that Form A loses:**

```python
from typing import Annotated
from fastapi import Depends

# Form A (default-value Depends) lets this typo past mypy / pyright:
# def get_order(id: int, session: AsyncSession = Depends(get_session)):
#     session.nonexistent_method()  # no error in Form A
#
# Form B catches it at type-check time, because the parameter is
# unambiguously AsyncSession to the checker:
DbSession = Annotated[AsyncSession, Depends(get_session)]
CurrentUser = Annotated[User, Depends(get_current_user)]

@router.get("/orders/{id}")
async def get_order(id: int, session: DbSession, user: CurrentUser) -> OrderOut:
 # session.nonexistent_method()  # mypy / pyright flag this in Form B
 order = await service.get_order(session, id)
 return OrderOut.model_validate(order)
```

**Additional common weak answers:**

- "`Annotated` is Pydantic-specific." — it is PEP 593 stdlib, used by FastAPI, Pydantic, and SQLAlchemy 2.x `Mapped`. The stdlib typing module owns it.
- "You can't mix the two forms." — you can across parameters; just not on the same parameter (that runs the dependency twice). A project migrating from Form A to Form B can do it incrementally, one route at a time.

**Additional follow-up questions:**

- How do you document the alias in OpenAPI? (The alias is a Python-level shortcut; the schema reflects the underlying dependency's parameters. Changing the alias name does not change the OpenAPI output.)
- Can `Annotated` carry multiple metadata? (Yes: `Annotated[AsyncSession, Depends(get_session), Doc("The request's session")]` — FastAPI reads each piece; the type checker ignores metadata it does not understand.)

Canonical: [[03-FastAPI-Core/Dependency-Injection]], [[01-Python-Foundations/Type-Hints-and-Annotations]].

---

## Q4: How does `yield` dependency cleanup work? What happens if the handler raises?

### What a strong answer demonstrates

You understand that a dependency declared as a generator (with `yield`) is wrapped in an `AsyncExitStack` for the request, that FastAPI iterates the generator to the `yield` for setup and resumes it after the response for cleanup, and that exceptions in the handler are *propagated into the generator* via `throw()` so the generator can catch them if it wants.

### Model answer

When FastAPI sees a dependency function with `yield` in it, it treats the function as a generator. The resolution works like this:

1. FastAPI calls the function and gets a generator object.
2. It calls `next(generator)` — which runs the function body up to and including the `yield` statement. The yielded value is the dependency result; it gets injected into the route handler.
3. The route handler runs.
4. After the handler returns (and the response is sent), FastAPI calls `next(generator)` again — which resumes execution *after* the `yield`. That is where you close the session.
5. If the handler raised, FastAPI calls `generator.throw(exc)` instead of `next(generator)`. The exception is re-raised *inside* the generator at the `yield` point. If your generator doesn't catch it, it propagates up and FastAPI's exception handlers take over.

This means a `yield` dependency is a context manager — `with session:` and `try/finally` patterns work naturally:

```python
async def get_session() -> AsyncSession:
 async with AsyncSession(engine) as session: # __aenter__ at next(), __aexit__ at the second next()
 yield session
```

If the handler raises, `AsyncSession.__aexit__` still runs (it is in the `async with`), and the session is rolled back. That is the correct behavior.

**Warning — The "swallow in dependency" bug**

If you write `try: yield session; except Exception: pass`, you have just swallowed the exception — the route handler's exception never reaches FastAPI's exception handlers, the client gets a 200 with an empty body, and your logs are clean. Do not catch and ignore in a `yield` dependency unless you intend to translate the exception and re-raise a different one. If you want to log, `except Exception: log; raise` — re-raise after logging.


**Interviewer's follow-up: "If I have three `yield` dependencies in one request and the handler raises, in what order do the cleanups run?"**

LIFO — last-resolved, first-cleaned-up, mirroring `with` semantics. If the request declared `Depends(A)`, `Depends(B)`, `Depends(C)` in that order, the resolution order is A → B → C, and the cleanup order is C → B → A. Each cleanup sees the exception via `generator.throw(exc)`, so each can decide to catch, log, translate, or re-raise. If C's cleanup itself raises, that new exception *replaces* the original for B's cleanup — meaning B and A see C's exception, not the handler's. This is why cleanup code must be defensive (`try/finally` inside the cleanup) — a buggy cleanup can mask the real bug.


### Practical example

```python
from contextlib import asynccontextmanager

async def get_session() -> AsyncSession:
 async with AsyncSession(engine) as session:
 try:
 yield session
 await session.commit() # runs on success
 except Exception:
 await session.rollback() # runs on failure
 raise # CRITICAL: re-raise or FastAPI never sees the error
```

### Common weak answers

- "The cleanup runs after the handler." — true but incomplete. The cleanup runs *after the response is sent*, and exceptions are *propagated into* the generator via `throw()`.
- "If the handler raises, the cleanup doesn't run." — it does run. The generator's post-`yield` code runs even on exceptions; that's the point.
- "You can't catch the exception in the dependency." — you can, via `try/except` around the `yield`. The bug is *swallowing* it, not catching it.

### Follow-up questions

- What happens if the cleanup itself raises? (The cleanup exception is propagated; the original handler exception may be lost. Be careful.)
- Can a `yield` dependency yield more than once? (No — FastAPI calls `next()` exactly once after the handler; a second `yield` is unreachable.)
- How does FastAPI order multiple `yield` cleanups? (LIFO — the last dependency resolved is the first cleaned up, mirroring `with` semantics. See [[01-Python-Foundations/Iterators-Generators-Context-Managers]].)

**Additional practical example — three `yield` dependencies and LIFO cleanup:**

```python
from contextlib import asynccontextmanager

# Three yield dependencies. Resolution order: A -> B -> C.
# Cleanup order is LIFO: C -> B -> A, mirroring `with` semantics.

@asynccontextmanager
async def dep_a():
 print("A setup"); yield; print("A cleanup")

@asynccontextmanager
async def dep_b():
 print("B setup"); yield; print("B cleanup")

@asynccontextmanager
async def dep_c():
 print("C setup"); yield; print("C cleanup")

@router.get("/demo")
async def demo(a = Depends(dep_a), b = Depends(dep_b), c = Depends(dep_c)):
 # Resolution order: A setup, B setup, C setup.
 raise RuntimeError("handler exploded")
# After the response is sent, FastAPI calls generator.throw(exc) on each
# in LIFO order:
#   "C cleanup (sees the exc)"
#   "B cleanup (sees the exc, or C's cleanup-exc if C raised)"
#   "A cleanup (sees the exc, or B/C's cleanup-exc if either raised)"
# A buggy cleanup (one that raises) masks the original handler exception
# for the remaining cleanups. Defend every cleanup with its own try/finally.
```

**Additional common weak answers:**

- "`yield` is just like `return`." — `return` does not run cleanup; `yield` wraps the dependency in a context manager that FastAPI resumes after the response. Conflating the two is why devs forget to re-raise in `try/except`.
- "I'd use `finally:` instead of `try/except/raise`." — `finally` runs cleanup but does not let you log the exception type; `try/except/raise` lets you log, translate, or re-raise. Use `finally` for unconditional cleanup; `except` for exception-aware cleanup.

**Additional follow-up questions:**

- What happens if `yield` is the last line of the dependency? (The dependency is a no-op cleanup; you've lost the cleanup opportunity. The pattern is a code smell — the dependency should be a plain `def` returning the value, not a generator.)
- How do you share a connection across multiple `yield` deps without re-opening? (Open it in the lifespan, attach to `app.state`, and have each dependency yield a checkout from the pool — the checkout is cheap, the connection is shared.)

Canonical: [[03-FastAPI-Core/Dependency-Injection]], [[01-Python-Foundations/Iterators-Generators-Context-Managers]].

---

## Q5: How do dependency overrides work and what are they for?

### What a strong answer demonstrates

You know `app.dependency_overrides` is a dict mapping the original dependency callable to a replacement callable, that FastAPI resolves the replacement instead of the original, and that the main use case is testing — replacing a real DB session or auth dependency with a test fixture.

### Model answer

`app.dependency_overrides` is a `dict[callable, callable]` on the FastAPI instance. When FastAPI resolves a dependency, it first checks the overrides dict; if the callable is a key, it calls the *replacement* instead. The replacement has the same signature as the original (so its own dependencies are still resolved), and the route code is unchanged.

The main use case is testing:

```python
def get_test_session() -> AsyncSession:
 async with AsyncSession(test_engine) as session:
 yield session

app.dependency_overrides[get_session] = get_test_session
```

Now every route that depends on `get_session` gets the test session — without touching the route code. This is the canonical way to test FastAPI endpoints that need a DB or auth; see [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]].

Other uses:

- **Feature-flagging.** Override `get_feature_flags` to return a fixed set in staging.
- **Multitenancy in tests.** Override `get_current_tenant` to return a known tenant.
- **Mocking slow external services in integration tests.** Override `get_http_client` to return a fake.

**Tip — Always clean up overrides between tests**

Use a pytest fixture with `yield` and `app.dependency_overrides.clear()` in the teardown. Otherwise, tests leak state into each other.


**Interviewer's follow-up: "Can I use `dependency_overrides` in production — e.g., for feature-flagging or A/B testing?"**

Technically yes (it is a plain dict on the app instance), but you should not. Overrides are *per-app-instance* — they apply to every request, not per-request, and changing them at runtime is a race (one request reads the override while another writes it). For feature-flagging, the right pattern is a dependency that reads the flag from a per-request source (`settings`, a `Flag` table, an `x-flag` header) and branches internally — that way the flag is per-request and can be cached via the normal `use_cache=True` mechanism. For A/B testing, route the request in middleware based on the user id, not via overrides. Reserve `dependency_overrides` for tests.


### Practical example

```python
# conftest.py
@pytest.fixture(autouse=True)
def override_db():
 app.dependency_overrides[get_session] = get_test_session
 yield
 app.dependency_overrides.clear()

# Test:
async def test_create_project(client):
 resp = await client.post("/projects", json={"name": "Boardly"})
 assert resp.status_code == 201
 # get_session was overridden → test DB, not real DB
```

### Common weak answers

- "Overrides replace the route." — they don't. They replace dependencies. The route code is unchanged.
- "You can only override with a function." — you can override with any callable, including a class with `__call__`.
- "It's a global setting." — it's per-app-instance, which is why you create a fresh app (or clear overrides) per test.

### Follow-up questions

- Can an override itself have dependencies? (Yes — FastAPI resolves them recursively.)
- How do you override a dependency for one test only? (Set and clear in a per-test fixture instead of an autouse one.)
- Does the override affect OpenAPI generation? (No — OpenAPI reflects the original dependency declarations.)

**Additional practical example — per-test override without autouse:**

```python
# conftest.py: autouse clear so overrides never leak between tests:
@pytest.fixture(autouse=True)
def _clean_overrides():
 yield
 app.dependency_overrides.clear()

# A per-test override that applies only to this test, not globally:
@pytest.fixture
def admin_user():
 app.dependency_overrides[get_current_user] = lambda: User(id=1, scopes=["admin"])
 yield
 # The autouse fixture clears all overrides after the test; if you want
 # isolation without autouse, clear here:
 app.dependency_overrides.pop(get_current_user, None)

async def test_admin_only_endpoint(client, admin_user):
 resp = await client.get("/admin/dashboard")
 assert resp.status_code == 200

async def test_non_admin_forbidden(client):
 # No admin_user fixture -> get_current_user is the real dependency
 # (or a default-stub from another fixture). Override does not leak.
 resp = await client.get("/admin/dashboard")
 assert resp.status_code == 403
```

**Additional common weak answers:**

- "Overrides work like monkeypatching." — they are a structured indirection through FastAPI's dependency-resolution cache, not a global mutation of the function. The original `get_session` is untouched; only the resolution path is redirected.
- "Overrides change the route's signature." — they do not; the route code is byte-identical. The override is a lookup at resolution time, not a rewrite of the route's parameters.

**Additional follow-up questions:**

- Can overrides be scoped per-test without an autouse clear? (Yes — set in the test or a per-test fixture, and clear in the same fixture's teardown. Autouse is the safety net, not the only way.)
- What happens if you override a dependency that has sub-dependencies? (FastAPI resolves the replacement's sub-deps normally; the replacement callable can declare its own `Depends` and they will be resolved recursively.)

Canonical: [[03-FastAPI-Core/Dependency-Injection]], [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]].

---

## Q6: In what order does FastAPI / Starlette middleware run? What is the failure mode if you get it wrong?

### What a strong answer demonstrates

You know that the middleware added *last* is the *outermost* (it runs first on the way in, last on the way out), and that this is the inverse of what most engineers' intuition says. You can name the canonical middleware order and explain what breaks if it's wrong.

### Model answer

Starlette stores middleware in a list and builds the onion at app startup. The middleware added *last* wraps everything added before it, so it is the *outermost* layer — first to see the request, last to see the response. The canonical derivation comes from reading `Starlette.build_middleware_stack()`: it folds the user middleware list around the `ExceptionMiddleware` and the router.

So if you write:

```python
app.add_middleware(RequestIdMiddleware)
app.add_middleware(TimingMiddleware)
app.add_middleware(GZipMiddleware)
```

…then on the way in: GZip → Timing → RequestId → router. On the way out: router → RequestId → Timing → GZip.

The canonical order, derived in [[03-FastAPI-Core/Middleware-and-Request-Order]], is:

1. **Request ID / correlation ID** (outermost, so every log line and trace has the ID).
2. **Structured logging** (logs the start of the request with the ID).
3. **Tracing** (opens a span for the whole request).
4. **Error handling** (catches exceptions from inner layers).
5. **CORS and security headers**.
6. **GZip / compression** (innermost — compress the response, don't compress the error logs).

**Interviewer's follow-up: "What breaks if CORS is inside GZip?"**

The browser's preflight OPTIONS request still works (CORS adds the headers), but error responses produced by ExceptionMiddleware — which is *inside* the user middleware stack — get compressed without the CORS headers. The browser sees a CORS error on top of the 500. The fix: CORS outside GZip, so CORS adds its headers to *every* response, including errors.


**Danger — The "BaseHTTPMiddleware or pure ASGI" question**

Expect this follow-up. `BaseHTTPMiddleware` is convenient (you get a `Request` object, you call `await call_next(request)` and get a `Response`) but it has overhead: it sets up an anyio task group per request. Pure-ASGI middleware (subclassing `starlette.middleware.Middleware` and implementing `async def __call__(self, scope, receive, send)`) is faster but harder to write. For 99% of apps, `BaseHTTPMiddleware` is fine. For a high-throughput hot path, write it as pure ASGI.


### Practical example

```python
from fastapi import FastAPI
from starlette.middleware.base import BaseHTTPMiddleware

class RequestIdMiddleware(BaseHTTPMiddleware):
 async def dispatch(self, request, call_next):
 request_id = request.headers.get("x-request-id", str(uuid.uuid4()))
 response = await call_next(request)
 response.headers["x-request-id"] = request_id
 return response

app = FastAPI()
app.add_middleware(RequestIdMiddleware) # added first → innermost user middleware
# Add more here in order; the last add_middleware is outermost.
```

### Common weak answers

- "The order they're added is the order they run." — wrong direction. *Last* added is *first* to run.
- "Middleware is a stack, so it's LIFO." — true but only on the way *in*. On the way out it's FIFO. Most candidates collapse this to "LIFO" and lose points.
- "It doesn't matter, they all run." — it does matter. See the GZip + CORS example.

### Follow-up questions

- Why is the order reversed from intuition? (Because Starlette wraps at app-build time: `app = MW(InnerMW(InnerInnerMW(...))`). The outermost wrapper runs first.)
- What is `BaseHTTPMiddleware`'s overhead? (An anyio task group per request — measurable under load; see Starlette source.)
- How does `ExceptionMiddleware` fit in? (It is always present, inside the user middleware stack, so user middleware can catch what exception handlers re-raise.)

**Additional practical example — pure-ASGI middleware for the hot path:**

```python
import uuid

# Pure-ASGI middleware: no anyio task group, faster than BaseHTTPMiddleware.
# Use this on the hot path when BaseHTTPMiddleware's per-request task-group
# overhead shows up in your flame graph.
class RequestIdASGIMiddleware:
 def __init__(self, app):
  self.app = app

 async def __call__(self, scope, receive, send):
  if scope["type"] != "http":
   await self.app(scope, receive, send)
   return

  request_id = None
  for name, value in scope["headers"]:
   if name == b"x-request-id":
    request_id = value.decode()
    break
  if request_id is None:
   request_id = str(uuid.uuid4())
  scope.setdefault("state", {})["request_id"] = request_id

  async def send_with_header(message):
   if message["type"] == "http.response.start":
    headers = message.setdefault("headers", [])
    headers.append((b"x-request-id", request_id.encode()))
   await send(message)

  await self.app(scope, receive, send_with_header)

app = FastAPI()
app.add_middleware(RequestIdASGIMiddleware)  # pure-ASGI, hot path
```

**Additional common weak answers:**

- "I'd add CORS first." — that makes CORS the innermost user middleware; error responses produced by `ExceptionMiddleware` (which is inside the user stack) miss the CORS headers, and the browser reports a CORS error on top of the 5xx. CORS must be added LAST so it is outermost.
- "GZip should be outermost." — then it tries to compress the request body (rarely wanted) and runs before the request ID is captured, so compressed-error log lines lack the correlation ID. GZip belongs innermost.

**Additional follow-up questions:**

- How do you test middleware order? (Set a distinct header in each middleware's `dispatch`; then assert the response headers appear in the expected onion order — outermost middleware's header is set last and overrides; innermost is set first.)
- What is the cost of `BaseHTTPMiddleware` under 1000 RPS? (An anyio task group per request; measurable as 5-10% CPU overhead vs pure-ASGI in flame graphs. For 99% of apps it is fine; for a high-throughput hot path, write pure-ASGI.)

Canonical: [[03-FastAPI-Core/Middleware-and-Request-Order]].

---

## Q7: When would you write a custom exception handler versus a middleware? What is the difference?

### What a strong answer demonstrates

You know exception handlers run *inside* the middleware stack (in Starlette, the `ExceptionMiddleware` is the innermost middleware), they are keyed by exception type, and they are the right tool when you want to translate one exception class to one response shape. Middleware is the right tool when you want to do something for *every* request or *every* response.

### Model answer

Two different mechanisms, two different scopes:

- **Middleware** wraps the *entire* request/response cycle. It runs for every request. It can do anything — modify the request before it hits the router, modify the response after, short-circuit, log, trace. It is the outer onion.
- **Exception handler** runs only when an exception of its registered type is raised *and not caught* before reaching Starlette's `ExceptionMiddleware`. It is keyed by exception class. It returns a `Response`. It does not run on success.

The rule:

- Use a **handler** when you have a specific exception class that should become a specific response — `ProjectNotFound → 404`, `ConflictError → 409`, `ValidationError → 422`. The handler is a translation table from exception to HTTP response.
- Use **middleware** when you want a behavior for every request — request ID, structured logging, tracing, CORS, GZip. The middleware doesn't know what exception was raised; it sees the response that came back.

Exception handlers in FastAPI are registered with `@app.exception_handler(ExcClass)` and receive `(request, exc)`. They run inside the `ExceptionMiddleware`, which is *inside* the user middleware stack — so user middleware can intercept the response produced by the handler.

**Why handlers are inside middleware**

So that the `RequestIdMiddleware` always adds `x-request-id` to the response — including 500s produced by the catch-all `Exception` handler. If handlers were outside middleware, error responses would lose the request ID.


**Interviewer's follow-up: "If a handler raises `ProjectNotFound` and the middleware catches `Exception`, which wins?"**

The handler wins, because exception handlers run *inside* `ExceptionMiddleware`, which is itself inside the user middleware stack. The user middleware only sees the *response* the handler produced (a 404 JSON), not the original exception — the exception has already been translated by the time the middleware's `await call_next()` returns. The middleware would only see the raw exception if it explicitly re-raised it (it doesn't) or if the handler raised an exception type that no registered handler matches and that propagated all the way out (rare). The rule: handlers translate exceptions to responses; middleware observes responses. They don't compete.


### Practical example

```python
class ProjectNotFound(Exception):
 def __init__(self, project_id: int):
 self.project_id = project_id

@app.exception_handler(ProjectNotFound)
async def project_not_found_handler(request: Request, exc: ProjectNotFound):
 return JSONResponse(
 status_code=404,
 content={"error": {"code": "not_found", "message": f"Project {exc.project_id} not found",
 "request_id": request.state.request_id}},
 )
```

### Common weak answers

- "Handlers are just a special kind of middleware." — they are not. Handlers are exception-keyed; middleware is universal.
- "You need both for error handling." — you need a handler for translation, and middleware for the request ID. They compose.
- "Handlers run before middleware." — they run inside the `ExceptionMiddleware`, which is itself inside user middleware. So middleware sees the response *after* the handler has run.

### Follow-up questions

- What happens to an unhandled exception? (It propagates to the catch-all `Exception` handler in Starlette, which returns 500 with a generic body.)
- Can you register a handler for `Exception`? (Yes — it's the catch-all. Useful for logging and ensuring no internals leak.)
- What about `RequestValidationError`? (FastAPI already has one; you can override it with `@app.exception_handler(RequestValidationError)` to customize the 422 body.)

**Additional practical example — catch-all `Exception` handler for logging and sanitization:**

```python
import logging
import traceback

log = logging.getLogger("boardly.errors")

@app.exception_handler(Exception)
async def catch_all_handler(request: Request, exc: Exception):
 # Sanitize: never leak the raw traceback to the client.
 request_id = getattr(request.state, "request_id", "unknown")
 log.exception("unhandled exception", extra={"request_id": request_id})
 return JSONResponse(
  status_code=500,
  content={
   "error": {
    "code": "internal_error",
    "message": "An unexpected error occurred.",
    "request_id": request_id,
   }
  },
 )

# Stack traces stay in the log aggregator (with redaction of locals via
# structlog's ProcessorFormatter in prod); the client sees only the
# request_id, which they paste into a support ticket. The handler is
# inside ExceptionMiddleware, so RequestIdMiddleware still adds its
# header to the 500 response.
```

**Additional common weak answers:**

- "Exception handlers run for every request." — they run only on uncaught exceptions of their registered type. A 200 success path never invokes a handler; that is the whole point.
- "Middleware can translate exceptions to responses." — middleware sees `Response` objects, not exceptions; you can wrap `call_next` in `try/except`, but you are re-implementing what `ExceptionMiddleware` already does, and you lose the exception-type-keyed dispatch.

**Additional follow-up questions:**

- What happens if the exception handler itself raises? (Starlette's `ExceptionMiddleware` catches that and returns a 500 with a generic body. The handler's exception is logged separately so you can debug both the original and the handler bug.)
- Can you register handlers on a router instead of the app? (Yes — `router.add_exception_handler(...)` since FastAPI 0.100; the handler is scoped to that router's routes only, which is useful for module-specific error shapes.)

Canonical: [[03-FastAPI-Core/Exception-Handlers]], [[03-FastAPI-Core/Middleware-and-Request-Order]].

---

## Q8: When should you use `async def` versus plain `def` for a path operation? What are the trade-offs?

### What a strong answer demonstrates

You know that FastAPI runs `async def` path operations on the event loop and plain `def` path operations in a threadpool (so they don't block the loop). You can name the rule: if the handler does I/O, make it `async` and `await` properly; if it does CPU-bound or calls a sync-only library, make it `def` and let the threadpool handle it.

### Model answer

FastAPI inspects the route function's signature:

- `async def` → runs on the event loop. If you call blocking I/O inside, you stall the loop. If you `await` properly, you cooperate.
- `def` (sync) → FastAPI runs it in a threadpool (via Starlette's `anyio.to_thread.run_sync`), so the event loop is free to handle other requests while the sync handler runs.

The rule:

- **Async I/O library available?** Use `async def` and `await` it. This is the common case for FastAPI with SQLAlchemy 2.x async, async Redis, httpx.AsyncClient.
- **Sync-only library or CPU-bound work?** Use plain `def`. FastAPI parks your handler in a threadpool so it doesn't block the loop. Examples: pandas computations, sync DB driver like `psycopg2`, sync HTTP client like `requests`.
- **Don't mix.** The classic bug: `async def` handler that calls `requests.get(...)` synchronously. The `requests` call blocks the event loop for the duration; every other request stalls. Fix: switch to `httpx.AsyncClient` and `await client.get(...)`, or downgrade the handler to plain `def`.

**Warning — The most common async bug**

`async def` + sync DB driver. SQLAlchemy 1.x's sync `Session` inside an `async def` handler blocks the loop on every query. The "fast" framework becomes slow under any concurrency. Fix: use `AsyncSession` with the async driver (`asyncpg` for PostgreSQL), or downgrade the handler to `def`.


**Interviewer's follow-up: "How do I tell, just from the library's docs, whether to use `async def` or `def`?"**

Look for `async def` in the library's public API. If `client.get(...)` is documented as `async def get(...)`, the library is async-native — use `async def` for your handler and `await client.get(...)`. If `client.get(...)` is documented as a plain `def` (synchronous), the library is sync-only — either downgrade your handler to `def` (FastAPI threadpools it) or wrap the call in `await anyio.to_thread.run_sync(client.get, ...)`. The trap is libraries that offer both — e.g., SQLAlchemy 2.x has `Session` (sync) and `AsyncSession` (async). Mixing them inside one handler is the bug. Pick one per handler, consistently.


### Practical example

```python
# Async handler, async I/O — correct.
@router.get("/orders/{id}")
async def get_order(id: int, session: DbSession) -> OrderOut:
 order = await session.scalar(select(Order).where(Order.id == id))
 return OrderOut.model_validate(order)

# Sync handler, sync I/O — also correct.
@router.get("/orders/{id}")
def get_order_sync(id: int, session: SyncSession = Depends(get_sync_session)) -> OrderOut:
 order = session.query(Order).get(id) # blocking, but it's in a threadpool
 return OrderOut.model_validate(order)

# WRONG — async handler with sync I/O:
@router.get("/orders/{id}")
async def get_order_broken(id: int, session: SyncSession = Depends(get_sync_session)) -> OrderOut:
 order = session.query(Order).get(id) # BLOCKS THE EVENT LOOP
 return OrderOut.model_validate(order)
```

### Common weak answers

- "Always use `async def` for performance." — wrong. Async is for I/O-bound work with proper await. CPU-bound work in `async def` is worse than in `def` because it blocks the loop.
- "Sync is always slower." — for CPU-bound work, sync in a threadpool is equivalent; the loop isn't blocked.
- "It doesn't matter, FastAPI handles it." — it does matter. The wrong choice under load is what causes the 1000ms request that should be 10ms.

### Follow-up questions

- What threadpool does FastAPI use? (Starlette's anyio threadpool, default 40 threads.)
- How do you tune the threadpool size? (`anyio.to_thread.current_default_thread_limiter().total_tokens = N`.)
- What about `BackgroundTasks`? (They run after the response; if `async def`, on the loop; if `def`, in a threadpool.)

**Additional practical example — detecting loop-blocking with OpenTelemetry spans:**

```python
from opentelemetry import trace

# The symptom: DB span shows 10 ms, request span shows 500 ms.
# The 490 ms gap is loop-blocking time. The DB is fast; the handler is serial.
# Wire this check into your tracing exporter to alert on the gap.

@router.get("/orders/{id}")
async def get_order(id: int, session: DbSession) -> OrderOut:
 tracer = trace.get_tracer(__name__)
 with tracer.start_as_current_span("get_order") as span:
  # If service.get_order called a sync DB driver inside, the DB span
  # would show 10 ms but this span would show 500 ms. The gap is blocking.
  order = await service.get_order(session, id)
  return OrderOut.model_validate(order)

# Alert rule (Prometheus / OTel collector):
#   blocking_ms = request_span_ms - sum(db_span_ms)
#   alert if blocking_ms > 100 AND blocking_ms > 0.5 * request_span_ms
```

**Additional common weak answers:**

- "Async is always better for I/O." — only if the I/O library is async-native. Mixing `async def` with a sync DB driver or `requests.get(...)` is the bug; the framework cannot save you from a blocking call.
- "I'd just use `def` everywhere to be safe." — you lose concurrency; the threadpool caps at 40 by default, so 41+ concurrent sync handlers queue. The right call is `async def` + async driver for I/O-bound work; `def` only for CPU-bound or sync-only libraries.

**Additional follow-up questions:**

- How do you measure whether your `async def` handler is actually concurrent? (Send N=100 concurrent requests with `asyncio.gather(*[client.get(...) for _ in range(100)])`; if total time ~= N × per-request, you're serial — the loop is blocking. If total ~= 1 × per-request, you're concurrent.)
- What is the default threadpool size and how do you tune it? (40 — `anyio.to_thread.current_default_thread_limiter().total_tokens = N`. Raise it for CPU-bound sync handlers, but watch the GIL: threads help only for I/O-bound sync calls.)

Canonical: [[03-FastAPI-Core/Path-Query-Header-Cookie-Body]], [[10-Async-Python/Event-Loop-and-Coroutines]].

---

## Q9: How would you customize the OpenAPI schema FastAPI generates?

### What a strong answer demonstrates

You know FastAPI auto-generates the OpenAPI schema from your routes, models, and dependencies; that you can customize it at three levels (per-route docstrings/parameters, per-app `openapi_tags`, and full schema replacement via `app.openapi()`); and that the right approach depends on whether you're documenting one route or enforcing a house schema convention.

### Model answer

FastAPI builds the OpenAPI schema by walking your routes, reading their signatures, the `Annotated` metadata, the Pydantic models, and the docstrings, and emitting a JSON document at `/openapi.json`, rendered at `/docs` (Swagger) and `/redoc` (ReDoc).

Three layers of customization:

1. **Per-route, declarative.** Use docstrings (markdown renders in the description), `summary=`, `description=`, `response_code=`, `responses=` on the decorator, and `Field(description=...)` on Pydantic models. This is the 90% case.
2. **Per-app, structural.** Pass `openapi_tags=[{"name": "orders", "description": "..."}]` to `FastAPI()` to define tag groupings with descriptions, and tag your routes with `@router.get("/", tags=["orders"])`. The `docs` UI groups by tag.
3. **Full replacement.** Override `app.openapi()`:
 ```python
 def custom_openapi():
 if app.openapi_schema:
 return app.openapi_schema
 schema = generate_openapi_from_routes(...) # your customization
 app.openapi_schema = schema
 return schema
 app.openapi = custom_openapi
 ```
 Use this when you have house schema conventions (e.g., a custom security scheme, or a vendor extension `x-internal: true`) that FastAPI's defaults don't emit.

**Tip — Cache the customized schema**

 FastAPI regenerates the schema on every `/openapi.json` request by default. Cache it in `app.openapi_schema` (as above) so you only build it once per process.

**Interviewer's follow-up: "Does `--reload` re-run the customization, or is the cached schema stale across code changes?"**

`--reload` *restarts the Uvicorn worker process*, which re-runs the lifespan and re-imports the module that defined `app.openapi = custom_openapi`. So the *function* is re-bound, but the cached `app.openapi_schema` attribute is reset to `None` (new process, fresh `app` instance) — meaning the first request after reload re-builds the schema from scratch with the new code. The cache only lives within one process's lifetime; reload starts a new process. So no staleness across reloads. The staleness risk is *within* a long-running process: if you change a route at runtime (e.g., via `app.router.add_route(...)` after startup) and the schema was already cached, the cache serves the stale version. The fix: set `app.openapi_schema = None` after the runtime change to invalidate.


### Practical example

```python
from fastapi import FastAPI

app = FastAPI(
 title="Boardly",
 version="0.1.0",
 openapi_tags=[
 {"name": "projects", "description": "Project CRUD."},
 {"name": "health", "description": "Health and readiness."},
 ],
)

@router.post("/projects", response_model=ProjectOut, status_code=201,
 summary="Create a project", tags=["projects"])
async def create_project(payload: ProjectCreate) -> ProjectOut:
 """Create a new project owned by the authenticated user.

 The project starts in `draft` state; use `POST /projects/{id}/publish`
 to make it visible to other users.
 """
 ...
```

### Common weak answers

- "Just write the schema by hand." — losing the auto-generation loses the type-safety and the docstrings-as-docs.
- "You can't customize it." — three layers of customization exist.
- "Customize by editing the JSON file." — you can, but the next code change regenerates it; customize via the API above.

### Follow-up questions

- How do you hide a route from OpenAPI? (`include_in_schema=False` on the decorator.)
- How do you add a security scheme? (`app = FastAPI(openapi_url=..., servers=...)` plus `HTTPBearer()` dependency — see [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]].)
- How do you serve a custom `docs` UI? (Override `app.openapi_url`, `app.docs_url`, `app.redoc_url`, or set them to `None` and serve your own.)

**Additional practical example — vendor extension and custom security scheme:**

```python
from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi

app = FastAPI(title="Boardly", version="0.1.0")

def custom_openapi():
 if app.openapi_schema:
  return app.openapi_schema
 schema = get_openapi(title=app.title, version=app.version, routes=app.routes)
 # Vendor extension marking this schema as internal-only:
 schema["x-internal"] = True
 # Custom security scheme (API key in header):
 schema["components"]["securitySchemes"]["ApiKeyAuth"] = {
  "type": "apiKey",
  "in": "header",
  "name": "X-Api-Key",
 }
 schema["security"] = [{"ApiKeyAuth": []}]
 app.openapi_schema = schema
 return schema

app.openapi = custom_openapi
# The cached schema is served on every /openapi.json request. The x-internal
# flag is read by the gateway to block external clients; the security scheme
# is consumed by the SDK generator (openapi-generator) to add the X-Api-Key
# header to every client call.
```

**Additional common weak answers:**

- "OpenAPI is just docs." — it is a contract. Frontend and mobile clients generate TypeScript / Swift / Kotlin SDKs from it; breaking the schema breaks the clients without a deploy.
- "You can't add custom fields." — vendor extensions prefixed with `x-` are explicitly supported by the OpenAPI spec; tools like Swagger UI ignore unknown `x-*` keys, but your own tooling can read them.

**Additional follow-up questions:**

- How do you version the schema across deploys? (Per-deploy `app.openapi_schema = None` invalidates the cache after a process restart. For per-env versioning, set `app.title` / `app.version` from `settings.env` so staging and prod produce distinct schemas.)
- What is the difference between `responses=` and `response_model`? (`responses=` documents additional status codes and their bodies (e.g., a 409 schema); `response_model` filters and validates the 2xx body. They compose: declare both for a route that returns 201 on success and 409 on conflict.)

Canonical: [[03-FastAPI-Core/Path-Query-Header-Cookie-Body]], [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]].

---

## Q10: What does `response_model` do? What happens if your handler returns an object with extra fields?

### What a strong answer demonstrates

You know `response_model` is a Pydantic type FastAPI uses to filter, validate, and serialize the handler's return value. Extra fields are dropped silently by default (`model_config` can change this). You understand why this matters for security: a `User` model passed to the response without a `UserOut` filter would leak `password_hash`.

### Model answer

When you declare `response_model=UserOut` on a route, FastAPI does three things after the handler returns:

1. **Validates** the return value against `UserOut`. If a required field is missing or a type mismatches, you get a 500 (`ResponseValidationError`).
2. **Filters** fields not on `UserOut`. If your handler returned a `User` ORM object with `password_hash`, `password_hash` is dropped.
3. **Serializes** the filtered value to JSON, including alias renaming and `json_encoders`.

This is the canonical security boundary. Your handler works with the full domain model (`User`); the response shape is governed by the smaller DTO (`UserOut`):

```python
class UserOut(BaseModel):
 model_config = ConfigDict(from_attributes=True)
 id: int
 email: str

class User(Base): # SQLAlchemy ORM
 id: Mapped[int] = mapped_column(primary_key=True)
 email: Mapped[str]
 password_hash: Mapped[str] # NOT on UserOut

@router.get("/users/{id}", response_model=UserOut)
async def get_user(id: int, session: DbSession) -> User:
 user = await session.scalar(select(User).where(User.id == id))
 return user # FastAPI filters to UserOut — password_hash is dropped
```

**Danger — What happens without `response_model`**

FastAPI serializes whatever the handler returns, including all fields. If the handler returns a `User` with `password_hash`, the JSON response includes it. This is a security bug. Always declare `response_model` for routes that return domain objects.


**Interviewer's follow-up: "What if a field is optional on the model but the handler returns `None`?"**

If the field is `Optional[T]`, `None` serializes to JSON `null` — fine. If the field is required (non-Optional) and the handler returns an object where that field is `None`, FastAPI raises `ResponseValidationError` and the client gets a 500.


### Practical example

```python
@router.get("/users/{id}", response_model=UserOut)
async def get_user(id: int, session: DbSession) -> User:
 user = await session.scalar(select(User).where(User.id == id))
 if user is None:
 raise HTTPException(404)
 return user
```

### Common weak answers

- "`response_model` is just for documentation." — no, it filters and validates at runtime.
- "If you return the same type, you don't need it." — you do, for the security guarantee. A change to the model (adding a field) silently leaks through without `response_model`.
- "It uses `from_attributes` automatically." — `from_attributes=True` must be on the `model_config`, otherwise passing an ORM object raises a validation error.

### Follow-up questions

- What is `response_model_exclude_unset`? (Only include fields that were explicitly set; defaults and unset values are dropped.)
- What is `response_model_exclude_none`? (Drop fields whose value is `None`.)
- What is `response_model_by_alias`? (Serialize using the field's alias — useful for camelCase JSON APIs.)

**Additional practical example — nested model with `response_model_exclude_unset`:**

```python
from pydantic import BaseModel, ConfigDict

# Nested DTOs: the profile may be entirely unset on a new user.
class ProfileOut(BaseModel):
 model_config = ConfigDict(from_attributes=True)
 bio: str | None = None
 avatar_url: str | None = None

class UserOut(BaseModel):
 model_config = ConfigDict(from_attributes=True)
 id: int
 email: str
 profile: ProfileOut

@router.get("/users/{id}", response_model=UserOut,
            response_model_exclude_unset=True)
async def get_user(id: int, session: DbSession) -> User:
 # If profile was never set on the ORM object, exclude_unset drops it
 # entirely from the JSON; without exclude_unset, profile would serialize
 # as {"bio": null, "avatar_url": null}, which the client must null-check.
 user = await service.get_user(session, id)
 return user
# Response (profile set):    {"id": 1, "email": "...", "profile": {"bio": "..."}}
# Response (profile unset):  {"id": 1, "email": "..."}  # profile key absent
```

**Additional common weak answers:**

- "I'd just return the Pydantic model directly without `response_model`." — that bypasses the filter; the model serializes every field, including `password_hash` if it is on the model. `response_model` is the security boundary.
- "`response_model` is for documentation only." — it filters and validates at runtime; a field that fails validation raises `ResponseValidationError` (500). This is the boundary that catches a handler returning a stale ORM object whose `email` was set to `None` by a migration.

**Additional follow-up questions:**

- What is `response_model_exclude_unset` vs `exclude_none`? (unset drops fields the model never set (including defaults); none drops only fields whose value is `None`. They compose: `exclude_unset=True, exclude_none=True` drops both.)
- How does `response_model` interact with `from_attributes`? (It validates the ORM object via `from_attributes=True` on the `model_config`; without it, passing a SQLAlchemy `User` raises a validation error because Pydantic expects a dict.)

Canonical: [[03-FastAPI-Core/Path-Query-Header-Cookie-Body]], [[04-Pydantic/Serialization-and-Model-Dump]].

---

## Q11: What are the limits of `BackgroundTasks`? When is it the wrong tool?

### What a strong answer demonstrates

You know `BackgroundTasks` runs after the response is sent, in the same process, on the event loop or threadpool, with no persistence, no retry, no deduplication, and no survival across crashes. You can articulate why this disqualifies it for any "important" work and what to use instead (a real queue: Celery, RQ, Dramatiq, or a transactional outbox plus a worker).

### Model answer

`BackgroundTasks` is the FastAPI primitive for "do this after the response." You add a task with `background_tasks.add_task(func, *args)`, the response is sent, and FastAPI runs `func(*args)` on the way out — `async def` tasks on the event loop, `def` tasks in the threadpool.

Limits:

1. **No persistence.** If the process crashes between sending the response and running the task, the task is lost. No journal, no recovery.
2. **No retry.** If the task raises, FastAPI logs and continues. No retry, no DLQ.
3. **No deduplication.** If the client retries the request (network blip), the task runs twice. No idempotency key, no dedupe.
4. **Same process.** The task runs in the same process that served the request. If the task is slow, it competes with new requests for the event loop / threadpool.
5. **No backpressure.** Add 10,000 tasks; they all queue in memory; the process OOMs.
6. **No observability.** No metrics, no tracing integration without manual work.

**Danger — When `BackgroundTasks` is the wrong tool**

Anything where losing the task is a correctness bug: sending transactional emails, charging a card, writing to an external system, generating a report that must exist. For those, use a **transactional outbox** — see [[14-Caching-and-Background-Processing/Transactional-Outbox]] — and a real worker (Celery, RQ, Dramatiq). The outbox guarantees the task is durably enqueued in the same DB transaction as the request's main write; the worker drains it.


**Tip — When `BackgroundTasks` is the right tool**

Trivial, lossy-is-OK work: warming a cache, updating a counter that gets recomputed anyway, sending a "you logged in" log line. The cost of a real queue is high; if the task is unimportant, `BackgroundTasks` is the right tool.


**Interviewer's follow-up: "How is `BackgroundTasks` different from `asyncio.create_task(...)` inside the handler?"**

Two differences: timing and lifecycle. (1) Timing — `BackgroundTasks` runs *after the response is sent*; `asyncio.create_task(...)` runs *concurrently with the response*, on the same event loop. If you `create_task(send_email())` and immediately `return user`, the email send races the response serialization — under load, the email may not finish before the connection closes, leaving a half-sent email or a TCP reset. `BackgroundTasks` waits for the response to flush, then runs the task. (2) Lifecycle — `BackgroundTasks` is registered with FastAPI's request machinery, which guarantees the task runs even if the handler raises (the cleanup path runs the registered tasks before propagating the exception). `create_task` returns a `Task` object you must `await` somewhere or it gets cancelled when the event loop closes. For fire-and-forget work tied to a request, `BackgroundTasks` is the right primitive; for fire-and-forget work tied to the *process* (e.g., a periodic cache warmer), `create_task` in the lifespan is right.


### Practical example

```python
from fastapi import BackgroundTasks

@router.post("/signup", response_model=UserOut, status_code=201)
async def signup(payload: SignupIn, bg: BackgroundTasks, session: DbSession) -> User:
 user = await service.create_user(session, payload)
 bg.add_task(send_welcome_email, user.email) # lossy-is-OK
 return user
```

### Common weak answers

- "Background tasks run in a separate thread." — they run in the threadpool (for `def`) or on the event loop (for `async def`). Not "a separate thread" as a general rule.
- "It's basically Celery." — it is not. Celery is a broker-backed durable queue. `BackgroundTasks` is a per-request list run before the response cycle closes.
- "Background tasks survive crashes." — they do not.

### Follow-up questions

- When would you use a transactional outbox? (Any time the side effect must survive a crash — emails, payments, external writes. See [[14-Caching-and-Background-Processing/Transactional-Outbox]].)
- Can a background task access the request's DB session? (It can, but the session was closed by the dependency cleanup before the task runs. Open a new one.)
- How do you test background tasks? (Pass a fake `BackgroundTasks`, or assert on side effects after the response. See [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]].)

**Additional practical example — the transactional outbox as the durable alternative:**

```python
from datetime import datetime, timezone
from sqlalchemy import ForeignKey, JSONB
from sqlalchemy.orm import Mapped, mapped_column

class OutboxMessage(Base):
 __tablename__ = "outbox"
 id: Mapped[int] = mapped_column(primary_key=True)
 topic: Mapped[str]
 payload: Mapped[dict] = mapped_column(JSONB)
 sent_at: Mapped[datetime | None] = mapped_column(default=None)

@router.post("/orders", response_model=OrderOut, status_code=201)
async def create_order(payload: OrderIn, session: DbSession) -> Order:
 order = await service.create_order(session, payload)
 # Same transaction: the outbox INSERT commits iff the order commits.
 session.add(OutboxMessage(
  topic="order.created",
  payload={"order_id": order.id, "ts": datetime.now(timezone.utc).isoformat()},
 ))
 return order

# Worker (separate process) drains the outbox:
#   SELECT id, topic, payload FROM outbox
#   WHERE sent_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED;
#   -> publish each to Kafka/SNS
#   -> UPDATE outbox SET sent_at = now() WHERE id = ?;
# The FOR UPDATE SKIP LOCKED lets multiple workers drain concurrently
# without colliding. See [[14-Caching-and-Background-Processing/Transactional-Outbox]].
```

**Additional common weak answers:**

- "`BackgroundTasks` runs in a separate process." — it runs in the same process, on the same event loop (if `async def`) or threadpool (if `def`). A process crash between the response and the task loses the task permanently.
- "I'd use `BackgroundTasks` for transactional emails." — wrong; emails must survive crashes. Use the outbox. `BackgroundTasks` is for lossy-is-OK work (cache warming, counter bumps) where a missed task is a rounding error.

**Additional follow-up questions:**

- How do you test that a `BackgroundTasks` callback ran? (Inject a fake `BackgroundTasks` that captures the callback in a list; assert after the response. Or assert on the side effect — e.g., a row in the cache table — after a small `asyncio.sleep`.)
- What happens if the task raises? (FastAPI logs the exception and continues; no retry, no DLQ, no metrics. The client already received a 200 and has no idea the side effect failed. This is why `BackgroundTasks` is wrong for important work.)

Canonical: [[03-FastAPI-Core/Background-Tasks-Streaming-Uploads]], [[14-Caching-and-Background-Processing/Background-Tasks-vs-Workers]].

---

## Q12: A dependency is `async def`, but it calls a sync database driver. What happens?

### What a strong answer demonstrates

You know that a sync DB call inside an `async def` dependency blocks the event loop, that the symptom is a "fast" framework that goes slow under concurrency, and that the fix is either (a) switch to an async driver, or (b) wrap the sync call in `anyio.to_thread.run_sync`.

### Model answer

`async def` runs on the event loop. If it calls a sync DB driver — `psycopg2`, the legacy `Session` (not `AsyncSession`), `requests` — the call blocks the entire event loop for its duration. Every other request stalls.

This is the silent killer of FastAPI performance. The framework is "async"; the dependency is "async"; the code looks correct; the bench shows one request at 10ms and ten concurrent requests at 100ms each. The event loop is single-threaded; the sync call inside the async function blocks it.

Two fixes:

1. **Use an async driver.** Replace `psycopg2` with `asyncpg` (or `psycopg` async mode), `requests` with `httpx.AsyncClient`, the legacy `Session` with `AsyncSession`. The dependency stays `async def`; the calls become `await`. This is the right fix.
2. **Wrap the sync call in a threadpool.** If you cannot change the library (legacy sync-only), use `await anyio.to_thread.run_sync(session.query, User).get(id)` (or `await run_in_executor(None, fn, *args)`). This parks the call in the threadpool so the loop is free.

**Warning — Don't downgrade the route to `def` to "fix" a sync DB call inside an async dependency**

The dependency is `async def`, so it still runs on the loop. Downgrading the route doesn't help. You need to either make the dependency `def` (and then FastAPI threadpools it for you) or fix the call inside.


**Interviewer's follow-up: "Why doesn't the sync DB call *crash* the async dependency — it's not `await`ed, so what happens?"**

It runs synchronously, blocking the event loop until it returns. The async dependency's `async def` does not make the call async — it just means the function *can* await. If you call a sync function from inside `async def` without `await`, Python executes it inline, blocking the event loop for the call's duration. There is no `RuntimeError` because there is no protocol violation — sync calls are valid Python, they just block. The symptom is performance, not correctness: one request works fine (10 ms); ten concurrent requests each take 100 ms because the loop serializes the sync calls. The detection is via OpenTelemetry spans — the DB span shows 10 ms, the request span shows 100 ms, and the gap is loop-blocking time.


### Practical example

```python
# WRONG — async dependency, sync driver:
async def get_session() -> Session: # sync Session
 session = Session(engine)
 try:
 yield session # session.execute(...) is blocking; called from async handler stalls the loop
 finally:
 session.close()

# RIGHT — async dependency, async driver:
async def get_session() -> AsyncSession:
 async with AsyncSession(engine) as session:
 yield session

# ALSO RIGHT — sync dependency, sync driver; let FastAPI threadpool it:
def get_session() -> Session:
 session = Session(engine)
 try:
 yield session
 finally:
 session.close()
```

### Common weak answers

- "FastAPI handles it; sync is fine in async." — it isn't. The sync call blocks the loop.
- "Just add more workers." — you're paying for a problem you should fix at the call site.
- "Use `run_in_executor`." — true, but only when you can't switch libraries. Prefer the async driver.

### Follow-up questions

- How do you detect this in production? (OpenTelemetry spans will show the DB call taking 50ms but the request taking 500ms — the gap is loop-blocking. See [[13-Performance-and-Observability/OpenTelemetry-Tracing]].)
- What is `asyncio.to_thread`? (Python 3.9+ helper around `run_in_executor` — same thing, simpler API.)
- What is `anyio.to_thread.run_sync`? (The anyio abstraction — preferred in Starlette / FastAPI code because anyio handles cancellation correctly.)

**Additional practical example — the wrong way, the right way, and the threadpool escape hatch:**

```python
from sqlalchemy.orm import Session
import anyio

# WRONG: async dependency, sync driver. Blocks the loop on every query.
async def get_session_broken() -> Session:
 session = Session(sync_engine)
 try:
  yield session  # session.execute(...) inside the handler blocks the loop
 finally:
  session.close()

# RIGHT (option 1): async dependency, async driver.
async def get_session_async() -> AsyncSession:
 async with AsyncSession(engine, expire_on_commit=False) as session:
  yield session

# RIGHT (option 2): sync dependency, sync driver; FastAPI threadpools it.
def get_session_sync() -> Session:
 session = Session(sync_engine)
 try:
  yield session
 finally:
  session.close()

# Escape hatch: you must call a sync-only library inside an async dep.
# Wrap the call in anyio.to_thread.run_sync so the loop is free.
async def get_legacy_thing() -> dict:
 return await anyio.to_thread.run_sync(legacy_sync_lookup, "key")
# anyio.to_thread.run_sync parks the call in the threadpool; the event
# loop serves other requests while it runs. Cost: ~1 ms per call for the
# context switch. Right for legacy code; wrong for hot paths.
```

**Additional common weak answers:**

- "FastAPI auto-detects sync calls in `async def` and threadpools them." — it does not. A sync call inside `async def` runs inline and blocks the loop. Only the route function's `def` vs `async def` signature triggers threadpooling.
- "I'd wrap every sync call in `run_in_executor`." — that is a band-aid; switch to the async driver (`asyncpg`, `httpx.AsyncClient`, async Redis) for the right fix. Reserve `run_in_executor` for sync-only libraries you cannot change.

**Additional follow-up questions:**

- How do you detect loop-blocking in production without OTel? (Add a `time.perf_counter()` around each DB call in a debug middleware; if any call exceeds 50 ms while the DB shows 5 ms, you're blocking. Or run `py-spy` and look for the loop thread stuck in `_io_wait`.)
- What is `asyncio.to_thread` vs `anyio.to_thread.run_sync`? (Same idea; `asyncio.to_thread` is Python 3.9+ stdlib; `anyio.to_thread.run_sync` is the anyio abstraction preferred in Starlette/FastAPI because it handles cancellation correctly — a cancelled `anyio.to_thread.run_sync` cancels the threadpool task; `asyncio.to_thread` does not.)

Canonical: [[03-FastAPI-Core/Dependency-Injection]], [[10-Async-Python/Event-Loop-and-Coroutines]], [[07-SQLAlchemy/07-Async-SQLAlchemy]].

---

## Q13: How do you test a FastAPI endpoint that requires authentication?

### What a strong answer demonstrates

You know two strategies: (a) use `dependency_overrides` to replace the auth dependency with a stub returning a known user, and (b) generate a real JWT with a test signing key and send it in the `Authorization` header. You can articulate when each is appropriate.

### Model answer

Two approaches:

**A. Override the dependency.** Use `app.dependency_overrides[get_current_user] = lambda: User(id=1, ...)`. Now every route depending on `get_current_user` receives the stub. This is fast and decoupled from JWT signing; it tests the route logic, not the auth flow. Good for unit-testing endpoints.

**B. Mint a real token.** Use the same `SECRET_KEY` as the app (or a test one) and sign a JWT with the test user's claims. Send it via `Authorization: Bearer <token>` using `httpx.AsyncClient` with `ASGITransport(app=app)`. This tests the full auth flow — JWT verification, claims extraction, user lookup. Good for integration tests.

The right answer depends on what you're testing:

- **Testing the route's logic** (does it return 200 for an admin? does it 403 for a non-admin?) → override. Fast, focused.
- **Testing the auth flow itself** (does an expired token get 401? does a tampered token get 401? does the refresh rotation work?) → mint real tokens. See [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]] and [[22-Diagrams/Auth-Flow-Diagram]].

**Tip — Use `ASGITransport` for the test client**

`httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")` lets you exercise the full ASGI stack (middleware, dependency resolution, exception handlers) without spinning up a server. See Q on `httpx` in [[20-Exercises-and-Labs/Troubleshooting-Index]].


**Interviewer's follow-up: "How do I test the refresh-rotation flow specifically — that a used refresh token is invalidated?"**

Mint a real access + refresh pair using the test `SECRET_KEY`. Hit `/auth/refresh` with the refresh token; assert 200 with a new access and a new refresh. Then hit `/auth/refresh` again with the *old* refresh token; assert 401 (or 403, depending on your convention). The test verifies the rotation: the old refresh is invalidated atomically with the issuance of the new one. The unit test for the `refresh_tokens` table's `is_used` flag (or whatever your rotation marker is) is a separate test that does not go through HTTP — it calls the service directly. Both tests are needed: the HTTP test catches middleware/handler bugs; the service test catches the rotation logic itself.


### Practical example

```python
# A. Override:
@pytest.fixture
def auth_user():
 app.dependency_overrides[get_current_user] = lambda: User(id=1, scopes=["projects:write"])
 yield
 app.dependency_overrides.clear()

async def test_create_project(client, auth_user):
 resp = await client.post("/projects", json={"name": "Boardly"})
 assert resp.status_code == 201

# B. Mint:
def make_token(user_id: int = 1) -> str:
 return jwt.encode({"sub": str(user_id), "exp": datetime.utcnow() + timedelta(hours=1)},
 TEST_SECRET, algorithm="HS256")

async def test_protected(client):
 resp = await client.get("/me", headers={"Authorization": f"Bearer {make_token()}"})
 assert resp.status_code == 200
```

### Common weak answers

- "Mock the database." — that tests nothing about auth.
- "Disable auth in tests." — you should test the production code path, not a test-only branch.
- "Use a real server." — `ASGITransport` is enough and faster.

### Follow-up questions

- How do you test that an expired token gets 401? (Mint with `exp` in the past; assert 401.)
- How do you test refresh rotation? (Mint access + refresh; use refresh; the old refresh should now 401. See [[22-Diagrams/Auth-Flow-Diagram]].)
- What is `TestClient`? (Starlette's sync test client; `httpx.AsyncClient` with `ASGITransport` is the async equivalent and the modern choice.)

**Additional practical example — minting expired and tampered tokens:**

```python
import jwt
from datetime import datetime, timedelta, timezone

TEST_SECRET = "test-secret-key"  # never the prod secret

def make_token(user_id: int = 1, exp_in: timedelta = timedelta(hours=1)) -> str:
 return jwt.encode(
  {"sub": str(user_id),
   "exp": datetime.now(timezone.utc) + exp_in},
  TEST_SECRET,
  algorithm="HS256",
 )

def make_expired_token(user_id: int = 1) -> str:
 # exp in the past -> the verifier rejects with 401.
 return make_token(user_id, exp_in=timedelta(hours=-1))

def make_tampered_token(user_id: int = 1) -> str:
 # Re-sign with the wrong key -> signature verification fails with 401.
 token = make_token(user_id)
 payload, _, _ = token.split(".")
 return f"{payload}.TAMPERED_SIGNATURE."

async def test_expired_token_rejected(client):
 resp = await client.get("/me",
  headers={"Authorization": f"Bearer {make_expired_token()}"})
 assert resp.status_code == 401

async def test_tampered_token_rejected(client):
 resp = await client.get("/me",
  headers={"Authorization": f"Bearer {make_tampered_token()}"})
 assert resp.status_code == 401
```

**Additional common weak answers:**

- "I'd just disable auth in tests." — you test a code path that does not exist in prod. The bug class "middleware mis-orders the auth check" is invisible until prod.
- "Use a real Postgres for auth tests." — auth tests do not need a DB; the `dependency_overrides` path is enough. Reserve the real DB for tests that exercise the user-lookup query plan.

**Additional follow-up questions:**

- How do you test that a tampered token gets 401? (Change a byte in the payload or re-sign with the wrong key; assert 401. The verifier must use `hmac.compare_digest` to avoid a timing oracle that distinguishes wrong-signature from wrong-payload.)
- What is `ASGITransport`? (An httpx transport that runs the ASGI app in-process; no network, no port binding. Faster than `TestClient` for async tests and exercises the full middleware + dependency + handler stack.)

Canonical: [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]], [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]].

---

## Q14: You deployed a new version and 5xx errors spiked. Walk me through your first 10 minutes.

### What a strong answer demonstrates

You have a methodical incident-response framework. You don't guess; you check signals in a known order (metrics, logs, traces), you form a hypothesis and disprove it, you consider rollback early, and you communicate. The interview version of "tell me about a hard bug" — see [[Production-Incidents-Debugging]] for narrative versions.

### Model answer

The first 10 minutes are about *triage*, not fix. You are deciding whether to roll back, and you are doing it with evidence.

**Minute 0–1: Confirm the signal.**
Open the dashboard. Confirm the 5xx rate is real (not a metric pipeline delay). Confirm the spike started at deploy time. Note the affected endpoints (all? one?).

**Minute 1–3: Check the obvious deploy-time causes.**
- Did migrations run? `alembic current` against the database; compare to the deploy commit's `alembic heads`.
- Did config change? Diff the deployed env vars.
- Did the deploy include a new dependency? Check the lockfile.

**Minute 3–5: Sample the errors.**
Tail the logs; filter to 5xx; read the tracebacks. Are they all the same exception? Different? Pick the most common one — that's your first lead. Note the request IDs.

**Minute 5–7: Trace one error end-to-end.**
Take a request ID; pull its trace. Where does it spend time? Where does it fail? The trace tells you whether the bug is in the route, in a dependency, in the DB, in a downstream service.

**Minute 7–9: Form a hypothesis and disprove it.**
"I think the migration didn't add the column the new code expects." Test that: `psql -c "\d orders"`. If the column is there, the hypothesis is wrong; pick the next.

**Minute 9–10: Decide.**
If you have a fix you can ship in 5 minutes, ship it. If not, **roll back**. A 10-minute rollback is better than a 60-minute debug-while-customers-suffer.

**Danger — The "I'll just look at the code" trap**

Reading code is the slowest way to debug a production incident. The code didn't change since the last deploy; the difference is in the runtime — the database state, the config, the downstream. Read the *signals* (logs, traces, metrics) first.


**Interviewer's follow-up: "What if I cannot identify the cause in 10 minutes — do I roll back blind?"**

Yes, roll back blind. The bias should be toward restoring service, not toward understanding. A blind rollback returns the system to the last known-good state — customers stop seeing 5xxs — and the debug continues on the rolled-back version (which has the same code as the broken one minus the new deploy). The risk of *not* rolling back is that you keep serving 5xxs while debugging, eroding customer trust and your own calm. The exception is when rollback is itself risky — e.g., a migration that ran forward and cannot run backward (a `DROP COLUMN` without a backup) — in which case the calculus changes and you may fix forward. But the default is: roll back, then debug calmly. The post-mortem asks "what was the cause?" not "why did you roll back?"


### Practical example

A real incident narrative:

> "Deploy at 14:00. At 14:02, 5xx on `/orders` spike from 0.1% to 30%. I confirm in the dashboard. I check `alembic current`: the database is at `abc123`, but the deploy commit's `alembic heads` is `def456`. The migration didn't run. I check the deploy script: it ran `alembic upgrade head` against the *previous* branch's checkout. I run the migration manually against the deploy commit. 5xx drops. Post-mortem: the deploy script now fails fast if `alembic current` doesn't match the deploy commit's head."

This is incident 5 in [[Production-Incidents-Debugging]].

### Common weak answers

- "I'd read the code." — too slow; the code didn't change.
- "I'd restart the servers." — masking the symptom, not fixing it. And you lose the in-memory state needed to debug.
- "I'd roll back immediately." — sometimes right, but you should know *why* before you roll back, otherwise the next deploy repeats it.

### Follow-up questions

- When do you roll back vs. fix forward? (Roll back when the fix is >5 minutes away or unknown; fix forward when you have a 1-line fix and the cause is verified.)
- How do you communicate during an incident? (A bridge channel, a status page, a comms owner. See [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]] for the role of structured logging.)
- What is the post-mortem's purpose? (Not blame; system change. What will you change so this can't happen again?)

**Additional practical example — the rollback-blind decision tree, in pseudocode:**

```python
# The 10-minute decision tree. The bias is toward restoring service,
# not toward understanding. A blind rollback returns to the last
# known-good state; the debug continues on the rolled-back version.

def incident_response(signal: IncidentSignal) -> Action:
 if not signal.confirmed:
  return Action.CONTINUE_BASELINE  # metric pipeline delay, not real
 if not signal.started_after_deploy:
  return Action.INVESTIGATE_EXISTING  # not deploy-related; full debug

 hypothesis = check_obvious_deploy_time_causes()  # migrations, config, lockfile
 if hypothesis.verified and hypothesis.fix_is_one_line:
  return Action.FIX_FORWARD  # 1-line fix, known cause
 if hypothesis.verified:
  return Action.ROLLBACK_BLIND  # cause known but fix is large

 # 10 minutes have passed; no verified hypothesis. Default: roll back.
 if signal.has_irreversible_migration:
  # e.g., DROP COLUMN without backup -> rollback itself is risky.
  return Action.FIX_FORWARD_WITH_CAUTION
 return Action.ROLLBACK_BLIND
# The post-mortem asks "what was the cause?" not "why did you roll back?"
# A blind rollback is the right call when the cause is unknown and the
# last-known-good state is reachable. Customers stop seeing 5xxs.
```

**Additional common weak answers:**

- "I'd look at the code first." — too slow; the code did not change since the last deploy. The difference is in the runtime (DB state, config, downstream). Read the signals (logs, traces, metrics) first; the code is a hypothesis to test against the signals, not the first thing to read.
- "I'd restart the servers." — masks the symptom; the bug returns on the next deploy. Restarting also loses in-memory state (active traces, pending background tasks) needed to debug.

**Additional follow-up questions:**

- What is a post-mortem template? (Impact, timeline, root cause, contributing causes, action items with owners and dates. See [[Production-Incidents-Debugging]]. The action items are the only part that changes the system; without them, the post-mortem is theater.)
- When do you fix forward vs rollback? (Fix forward when the cause is known AND the fix is 1-line AND you can verify it in 5 minutes; otherwise rollback. Rollback is the default because it restores service; fix-forward is the exception for trivial, verified fixes.)

Canonical: [[Production-Incidents-Debugging]], [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]], [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]].

---

## Cross-references

- [[00-Interview-MOC]] — study strategy and the four failure modes.
- [[SQLAlchemy-Sessions-Questions]] — Q9 (N+1), Q12 (`MissingGreenlet`), Q13 (transaction boundaries — incident 5 is about boundaries).
- [[Async-and-Concurrency-Questions]] — Q4 (blocking in async; the silent killer in Q12 here), Q9 (`TaskGroup`), Q10 (PgBouncer compatibility — incident 6).
- [[Production-Incidents-Debugging]] — narrative versions of Q14's framework.
- [[20-Exercises-and-Labs/Debugging-Labs]] — Lab 2 is Q12's failure mode, Lab 6 is Q11's.
- [[22-Diagrams/Request-Lifecycle-Diagram]] — the architecture Q1, Q4, Q6, Q7 reference.

## Verification

Each question's "Practical example" block is runnable as-is. To verify your model answer actually runs (not just sounds plausible), scaffold a minimal FastAPI app and exercise the patterns.

```bash
# Bootstrap the harness once for the whole file:
uv init fastapi-di-lab
cd fastapi-di-lab
uv add fastapi==0.148.0 'uvicorn[standard]' sqlalchemy==2.1.5 'asyncpg' pydantic==2.14.1 'redis>=5' httpx
uv add --dev pytest pytest-asyncio httpx aiosqlite
```

For Q1 (lifespan), paste the practical example into `app/main.py` and verify:

```bash
uv run uvicorn app.main:app --reload
# Expected terminal output:
# INFO:     Application startup complete.
# (your custom log line "engine ready" appears if you wired it)

curl -sf http://127.0.0.1:8000/healthz
# Expected: {"status":"ok"}

# Send SIGTERM; verify the shutdown block ran:
kill -TERM $(pgrep -f 'uvicorn app.main:app')
# Expected: "engine disposed" or your equivalent shutdown log line, then
# INFO:     Application shutdown complete.
```

For Q4 (yield cleanup), Q5 (dependency overrides), Q13 (testing auth), write the test:

```bash
uv run pytest tests/test_di.py -v
# Expected: every test passes; the dependency-override test confirms the
# fake auth dependency was wired and the yield cleanup ran after the response.
```

For Q6 (middleware order) and Q10 (`response_model`), add the middleware + the response_model and inspect headers:

```bash
curl -i http://127.0.0.1:8000/orders/42
# Expected: x-request-id, x-correlation-id, x-trace-id (in order) and a JSON
# body that has only the fields on OrderOut (no leaked password_hash).
```

For Q14 (5xx spiked), set the scene and rehearse the 10-minute framework out loud while running the commands:

```bash
docker compose logs --tail=100 app | grep ERROR
docker compose exec postgres psql -c "SELECT count(*) FROM pg_stat_activity WHERE state != 'idle';"
docker compose exec postgres psql -c "SELECT * FROM alembic_version;"
docker compose ps
```

If the commands above produce the output you predicted (and the prediction matches what the model answer told you to expect), you have rehearsed the framework — not just memorised it. If they do not, re-read the relevant Q's model answer; the gap is in your mental model of what each command reveals, not in your recall of the command name.

## Sources

- FastAPI documentation — https://fastapi.tiangolo.com/ — 2026-10-19 — lifespan, dependency injection, `Annotated`, `response_model`, OpenAPI customization, `BackgroundTasks`.
- Starlette documentation — https://www.starlette.io/ — 2026-10-19 — middleware ordering, `BaseHTTPMiddleware`, `ExceptionMiddleware`.
- Verified versions: FastAPI 0.148.0, Starlette 1.9.0, Pydantic v2.14.1 — per [[21-Reference-Library/Source-Register]].

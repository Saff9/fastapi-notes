---
title: Glossary
aliases:
 - Glossary
tags:
 - start-here
 - meta
 - glossary
status: complete
---

# Glossary

Definitions for terms used across the vault. Each entry links to its canonical lesson. Add to it whenever a new term becomes load-bearing.

## A

- **ACID** — Atomicity, Consistency, Isolation, Durability. The four guarantees of a transactional database. See [[06-SQL-Fundamentals/Transactions-Isolation-Locks]].
- **Alembic** — A database migration tool for SQLAlchemy. Generates and runs versioned schema-change scripts ("migrations") tracked in source control. See [[09-Alembic-Migrations/Alembic-Setup-and-Workflow]].
- **Alias (Pydantic)** — A field name mapping between the external payload (e.g. JSON `firstName`) and the Python attribute (`first_name`). See [[04-Pydantic/Fields-Annotated-Reusable-Annotations]].
- **Annotated (PEP 593)** — A typing construct (`Annotated[T, X]`) that lets you attach metadata to a type hint without changing the runtime type. FastAPI and Pydantic use it as the modern way to declare dependencies and field constraints. See [[01-Python-Foundations/Type-Hints-and-Annotations]].
- **API versioning** — Strategies for evolving an API without breaking existing clients. The four strategies are URL path versioning (`/v1/`, `/v2/`), header versioning (`X-API-Version: 2`), content-type versioning (`application/vnd.boardly.v2+json`), and query-string versioning (`?version=2` — generally discouraged due to cache-poisoning). Migration from v1 to v2 is announced via the `Sunset` (RFC 8594) and `Deprecation` (RFC 9730) response headers; the `Link: rel="successor-version"` header points to the new endpoint. See [[02b-Backend-Foundations/API-Versioning-Strategies]].
- **ASGI** — Asynchronous Server Gateway Interface. The protocol Python web servers speak with async frameworks. See [[02-Web-and-HTTP/ASGI-Starlette-Uvicorn]].
- **asyncio** — The Python standard library module that provides the event loop, coroutines, tasks, and synchronization primitives for async I/O. The foundation Starlette and FastAPI build on. See [[10-Async-Python/asyncio-Primitives]].
- **Async session** — A `sqlalchemy.ext.asyncio.AsyncSession` that uses an async driver and must be awaited for I/O. See [[07-SQLAlchemy/07-Async-SQLAlchemy]].
- **Autoflush** — SQLAlchemy behavior that flushes pending changes to the database before a query so the query can see them. See [[07-SQLAlchemy/05-Session-and-Transaction-Management]].

## B

- **Back-populates** — A `relationship()` argument that names the attribute on the other side of a bidirectional relationship, keeping both sides in sync in memory. See [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]].
- **Background task** — Work the server starts in the background after returning the HTTP response. FastAPI's `BackgroundTasks` runs in the same process; for anything durable or slow, use a worker queue (Celery, RQ, or ARQ). See [[14-Caching-and-Background-Processing/Background-Tasks-vs-Workers]].
- **Blocking I/O** — An operation that holds the calling thread until completion. Inside `async def`, blocking I/O stalls the event loop. See [[10-Async-Python/Event-Loop-and-Coroutines]].
- **Bulkhead** — A failure-isolation pattern that partitions a service's resources (e.g. a dedicated connection pool per downstream) so that a slow or failing dependency cannot exhaust the resources needed by the rest of the system. See [[15-External-Integrations/Circuit-Breaker-vs-Bulkhead-vs-Timeout]].
- **Bulk insert** — Inserting many rows in a single SQL statement (`INSERT INTO ... VALUES (...), (...), ...`) instead of one row per `INSERT`. SQLAlchemy 2.x exposes this via `session.execute(insert(Model), [list_of_dicts])`. See [[07-SQLAlchemy/09-Add-vs-AddAll-vs-Bulk-Insert]].

## C

- **Cache-aside** — A caching pattern where the application reads from cache, and on miss reads from the database and writes back to cache. See [[14-Caching-and-Background-Processing/Redis-Cache-Aside]].
- **Cache-Control directive (`max-age`)** — A `Cache-Control` field that sets the maximum freshness lifetime (in seconds) for the response, applying to *both* browser and shared caches unless overridden. See [[02b-Backend-Foundations/HTTP-Caching-Headers-Deep-Dive]].
- **Cache-Control directive (`s-maxage`)** — A `Cache-Control` field that sets the maximum freshness lifetime (in seconds) for *shared* caches only (CDNs, reverse proxies); the browser ignores it. Use it to give the CDN a longer TTL than the browser. See [[02b-Backend-Foundations/HTTP-Caching-Headers-Deep-Dive]].
- **Cache-Control directive (`stale-while-revalidate`)** — A `Cache-Control` field that lets a cache serve a stale response *while* it asynchronously revalidates with the origin, up to the specified number of seconds after `max-age` expires. Widely deployed by Vercel, Cloudflare, and Next.js. See [[02b-Backend-Foundations/HTTP-Caching-Headers-Deep-Dive]].
- **Chunked upload** — A pattern where the client splits a large file into multiple chunks and sends each chunk as a separate HTTP request, allowing the server to track the offset across requests and the client to resume from any interrupted point. See [[02b-Backend-Foundations/Resumable-and-Chunked-Uploads]].
- **Circuit breaker** — A failure-isolation pattern that stops calling an unhealthy downstream service for a cooldown period. See [[15-External-Integrations/Circuit-Breakers]].
- **Connection pool** — A set of reused database connections shared across requests to avoid the cost of new connections. See [[07-SQLAlchemy/02-Engines-Connections-Pools]].
- **Content-Type versioning** — A versioning strategy where the version is encoded in the media type (`application/vnd.boardly.v2+json`), negotiated via the `Accept` request header. Preserves the "URLs are forever" REST ideal but is not browser-testable. See [[02b-Backend-Foundations/API-Versioning-Strategies]].
- **Context manager** — An object implementing `__enter__`/`__exit__` (or an `async` variant) used for `with` blocks to guarantee cleanup. See [[01-Python-Foundations/Iterators-Generators-Context-Managers]].
- **Cookie** — A small key/value pair the server sends via the `Set-Cookie` response header and the browser echoes back via the `Cookie` request header on subsequent requests. Each cookie carries attributes (`Secure`, `HttpOnly`, `SameSite`, `Path`, `Domain`, `Max-Age`, `__Host-` prefix) that decide when the browser will send it. See [[02b-Backend-Foundations/HTTP-Cookies-Deep-Dive]].
- **Coroutine** — The result of calling an `async def` function. It does not run until awaited or scheduled. See [[10-Async-Python/Event-Loop-and-Coroutines]].
- **CORS** — Cross-Origin Resource Sharing. The browser-enforced mechanism that lets a server declare which origins may read its responses via the `Access-Control-Allow-Origin` and related response headers. See [[02-Web-and-HTTP/CORS-Caching-Headers-Conditional-Requests]].
- **Coverage (pytest)** — The percentage of code lines (or branches) exercised by the test suite, measured by `coverage` / `pytest-cov`. A leading indicator of test quality, not a guarantee of correctness. See [[12-Testing-and-Quality/Test-Pyramid-and-Fixtures]].
- **CSRF** — Cross-Site Request Forgery. An attack where a logged-in user's browser is tricked into issuing a state-changing request to your site (typically via a form submit or a cookie-authenticated request) that the user did not intend. Defended by SameSite cookies plus a synchronizer token. See [[02b-Backend-Foundations/CSRF-Protection]].
- **CTE (Common Table Expression)** — A named, temporary result set defined with `WITH name AS (...)` that exists for the duration of a single `SELECT`/`INSERT`/`UPDATE`/`DELETE`. Recursive CTEs (`WITH RECURSIVE`) walk trees and graphs in SQL. See [[06-SQL-Fundamentals/Joins-Aggregations-CTEs]].

## D

- **Dataclass** — A Python class decorated with `@dataclass` (PEP 557) that auto-generates `__init__`, `__repr__`, and `__eq__`. Useful for plain data containers; lacks runtime validation. Compare with Pydantic and TypedDict. See [[04-Pydantic/Pydantic-vs-Dataclasses-vs-TypedDict]].
- **DeclarativeBase** — The base class for SQLAlchemy 2.x declarative models. Holds the registry and metadata. See [[07-SQLAlchemy/03-Declarative-Base-and-Mapped]].
- **Dependency injection** — A pattern where a function declares what it needs via parameters and the framework resolves them. In FastAPI: `Depends` / `Annotated[..., Depends(...)]`. See [[03-FastAPI-Core/Dependency-Injection]].
- **Dependency override** — A FastAPI mechanism for replacing a dependency (e.g. a real database session with a test one) without touching the route code. See [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]].
- **Deprecation header (RFC 9730)** — A response header (`Deprecation: <HTTP-date>`) that announces a resource is deprecated — clients should avoid using it in new code. Unlike `Sunset`, the resource still works; the deprecation is a warning. The two compose — `Deprecation` is sent first (months before kill), then `Sunset` announces the actual kill-date. See [[02b-Backend-Foundations/API-Versioning-Strategies]].
- **Descriptor** — Any object implementing `__get__`, `__set__`, or `__delete__`. Powers `property`, classmethods, and SQLAlchemy's `Mapped[T]` attribute access. See [[01-Python-Foundations/Classes-Protocols-Structural-Typing]].
- **Dialect (SQLAlchemy)** — The SQLAlchemy component that translates generic SQL constructs into the specific SQL dialect of a database (PostgreSQL, MySQL, SQLite, etc.). Configured via the DB URL. See [[07-SQLAlchemy/01-Foundations-and-Architecture]].
- **Docker** — A container runtime used throughout the deployment chapters for PostgreSQL, Redis, and the FastAPI application itself. The curriculum uses multi-stage, non-root images. See [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]].
- **DTO** — Data Transfer Object. A Pydantic model used to carry data across a boundary (e.g. HTTP request → service). See [[05-Project-Architecture/Domain-vs-HTTP-Concerns]].

## E

- **Eager loading** — Loading a relationship's rows in the same query (or in a follow-up `IN` query) as the parent, to avoid the N+1 problem. SQLAlchemy strategies: `selectinload`, `joinedload`, `subqueryload`. See [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]].
- **Engine (SQLAlchemy)** — The SQLAlchemy object that holds the database URL, dialect, connection pool, and is the factory for connections. See [[07-SQLAlchemy/02-Engines-Connections-Pools]].
- **ETag (strong vs weak)** — A response-header validator that lets caches re-use a stored response when the value matches the `If-None-Match` request header. A strong ETag (no prefix, `"abc123"`) requires byte-for-byte equivalence; a weak ETag (`W/"abc123"`) requires only semantic equivalence — the right default for JSON APIs where the serialiser may reorder keys. See [[02b-Backend-Foundations/HTTP-Caching-Headers-Deep-Dive]].
- **Event-driven architecture** — A design where services communicate by publishing and consuming events (often via a broker like Kafka or Redis Streams) rather than making synchronous request/response calls. See [[17-Advanced-Architecture/Event-Driven-Basics]].
- **Event loop** — The scheduler that runs coroutines and I/O callbacks. See [[10-Async-Python/Event-Loop-and-Coroutines]].
- **EXPLAIN ANALYZE** — A PostgreSQL command that shows the query plan and executes the query to report actual timings. See [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]].

## F

- **FastAPI** — A Python web framework built on Starlette and Pydantic, providing dependency injection, OpenAPI schema generation, and async route handlers. See [[03-FastAPI-Core/Application-and-Lifespan]].
- **FastAPI lifespan** — The asynchronous context manager that runs at application startup and shutdown, used to manage resources like engines and Redis pools. See [[03-FastAPI-Core/Application-and-Lifespan]].
- **Fixture (pytest)** — A reusable test-setup function declared with `@pytest.fixture` and injected into a test by name. Fixtures handle database sessions, FastAPI `TestClient`, and mock dependencies. See [[12-Testing-and-Quality/Test-Pyramid-and-Fixtures]].
- **Flush (SQLAlchemy)** — Sending pending SQL statements to the database without committing the transaction. See [[07-SQLAlchemy/05-Session-and-Transaction-Management]].
- **Foreign key** — A column (or set of columns) whose values reference the primary key of another table, enforcing referential integrity. See [[06-SQL-Fundamentals/Relational-Model-and-Constraints]].

## G

- **Generator** — A function containing `yield` that returns a lazy iterator. Memory-efficient for streaming large result sets; the basis of context managers (`contextlib.contextmanager`). See [[01-Python-Foundations/Iterators-Generators-Context-Managers]].
- **GIL (Global Interpreter Lock)** — A CPython mutex that allows only one thread to execute Python bytecode at a time. The reason CPU-bound threads do not parallelise in CPython and the motivation for `multiprocessing` and async I/O. See [[10-Async-Python/Concurrency-vs-Parallelism]].

## H

- **Health checks (liveness, readiness, startup)** — The three Kubernetes probe types. *Liveness* asks "is the process alive?" (restart on failure); *readiness* asks "can I serve traffic right now?" (take out of LB on failure, but do NOT restart); *startup* asks "has my long-running init completed?" (do not start liveness until yes). See [[02b-Backend-Foundations/Health-Checks-and-Probes]].
- **Hook** — A function the framework calls at a known point in its lifecycle (startup, request, response, teardown). FastAPI's `lifespan`, middleware, and dependency `yield` cleanup are all hooks. See [[03-FastAPI-Core/Application-and-Lifespan]].

## I

- **Idempotency key** — A client-supplied unique value that lets the server treat repeated identical requests as one. See [[02-Web-and-HTTP/Idempotency-Safe-Retries-Pagination]].
- **Identity map** — A SQLAlchemy Session-level map of primary key → in-memory object that guarantees one row maps to one object per session. See [[07-SQLAlchemy/05-Session-and-Transaction-Management]].
- **Index** — A database structure (typically B-tree) that lets the engine find rows by value without scanning the whole table. Trade-off: faster reads vs. slower writes and storage cost. See [[06-SQL-Fundamentals/Indexes-and-Query-Planning]] and [[08-PostgreSQL/Indexes-Composite-and-Specialized]].
- **Isolation level** — The degree to which concurrent transactions see each other's uncommitted changes. See [[06-SQL-Fundamentals/Transactions-Isolation-Locks]].

## J

- **JSONB** — PostgreSQL's binary JSON type. Stores JSON, validates shape on write, and supports GIN indexes for fast key lookups. The right type for semi-structured, queryable columns. See [[08-PostgreSQL/Types-UUID-Identity-JSONB]].
- **JWT (JSON Web Token)** — A compact, signed token format with claims like `iss`, `aud`, `exp`. See [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]]. For the "when to use what" comparison against server-side sessions and signed cookies, see [[02b-Backend-Foundations/JWT-vs-Sessions-vs-Cookies]].

## K

- **Keyset pagination** — A pagination strategy where the cursor anchors on the last row's sort key (e.g. `(created_at, id)`) and the `WHERE` clause is `(created_at, id) < (?, ?)`. O(log N) per page regardless of depth, vs offset's O(N). Also called the "seek method." See [[02b-Backend-Foundations/Pagination-Deep-Dive]].

## L

- **Lazy loading** — The default SQLAlchemy strategy of deferring a relationship's `SELECT` until the attribute is first accessed. Causes the N+1 problem when used inside a loop. See [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]].
- **Liveness probe** — A Kubernetes probe that asks "is the process alive?" Restart the pod on failure. Must NOT hit the database; checks only the process itself. See [[02b-Backend-Foundations/Health-Checks-and-Probes]].
- **Link header (RFC 8288)** — An HTTP response header (`Link: <URL>; rel="next"`) that advertises the relationship between a resource and other resources, including the next page of a paginated list. The HTTP-blessed way for clients to follow pages without constructing URLs. See [[02b-Backend-Foundations/Pagination-Deep-Dive]]. Also used in API versioning to point to the successor version (`Link: <v2-url>; rel="successor-version"`) — see [[02b-Backend-Foundations/API-Versioning-Strategies]].
- **Long polling** — A real-time transport where the client sends a request and the server holds it open until an event arrives (or a timeout), then responds. The client immediately re-requests. Less wasteful than polling but each "response" is a new HTTP request. Today, mostly a fallback for legacy clients or proxies that buffer `text/event-stream`. See [[02b-Backend-Foundations/Real-Time-Transports-Compared]].

## M

- **Mapped / mapped_column** — SQLAlchemy 2.x typed ORM column declarations. `Mapped[T]` is the Python-side type annotation; `mapped_column(...)` configures the database column. See [[07-SQLAlchemy/03-Declarative-Base-and-Mapped]].
- **MOC** — Map of Content. A note that lists the lessons in a section in reading order. See [[How-to-Use-This-Vault]].
- **Middleware** — A component sitting between the ASGI server and the application that can inspect or modify the request before it reaches the route and the response before it leaves. FastAPI middleware is Starlette middleware. See [[03-FastAPI-Core/Middleware-and-Request-Order]].
- **Migration** — A versioned, ordered script that applies a schema change (create table, add column, etc.). Tracked in the `alembic_version` table and run via `alembic upgrade head`. See [[09-Alembic-Migrations/Alembic-Setup-and-Workflow]].
- **Multi-tenancy** — Architectural pattern where multiple customers (tenants) share an application but have isolated data. See [[17-Advanced-Architecture/Multi-Tenancy]].
- **model_dump** — Pydantic v2 method (`BaseModel.model_dump()`) that returns the model as a dict, replacing the v1 `.dict()`. Accepts `mode="json"` for JSON-serialisable output and `exclude_none`/`include`/`exclude` for filtering. See [[04-Pydantic/Serialization-and-Model-Dump]].

## N

- **N+1 query** — A performance pathology where a list query triggers one extra query per returned row to load a relationship. See [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]] and [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]].

## O

- **OAuth2** — An authorization framework. The password flow is the simplest grant type and the one we use for first-party clients. See [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]].
- **OpenAPI** — The specification (formerly Swagger) FastAPI generates automatically from your route signatures and Pydantic models, served at `/openapi.json` and rendered at `/docs`. See [[03-FastAPI-Core/Routers-and-Modular-Apps]].
- **OpenTelemetry** — A vendor-neutral observability standard for traces, metrics, and logs. See [[13-Performance-and-Observability/OpenTelemetry-Tracing]].
- **ORM (Object-Relational Mapper)** — A library (SQLAlchemy in this vault) that maps Python classes to database tables, letting you query rows as objects. See [[07-SQLAlchemy/01-Foundations-and-Architecture]].
- **Outbox (transactional)** — A pattern where side effects (e.g. sending an email) are written to a database table in the same transaction as the main write, then a worker dispatches them. See [[14-Caching-and-Background-Processing/Transactional-Outbox]].

## P

- **Pagination** — Splitting a large result set into pages. Offset pagination is simple but slow on large offsets; keyset pagination is fast but more complex. See [[02-Web-and-HTTP/Idempotency-Safe-Retries-Pagination]] for the intro and [[02b-Backend-Foundations/Pagination-Deep-Dive]] for the canonical deep-dive.
- **Page token** — An opaque, base64-encoded cursor (a serialised `(created_at, id, ...)` tuple) that a client treats as a black box and sends back to fetch the next page. The opaque form lets the server evolve the cursor format without breaking clients. See [[02b-Backend-Foundations/Pagination-Deep-Dive]].
- **Parametrize (pytest)** — A decorator (`@pytest.mark.parametrize("name,value", [(...), ...])`) that runs the same test function once per parameter set. See [[12-Testing-and-Quality/Test-Pyramid-and-Fixtures]].
- **Partial index** — A PostgreSQL index with a `WHERE` clause that only indexes rows matching the predicate (e.g. `WHERE deleted_at IS NULL`). Smaller and faster than a full index when most rows do not match. See [[08-PostgreSQL/Indexes-Composite-and-Specialized]].
- **Polling** — A real-time transport where the client repeatedly asks the server "any updates?" at a fixed interval (e.g., every 5 seconds). High latency floor, high per-request overhead, but operationally simplest — works through any proxy, debuggable with `curl`, the fallback when every other transport is blocked. See [[02b-Backend-Foundations/Real-Time-Transports-Compared]].
- **Pool size** — The number of persistent connections SQLAlchemy keeps open. See [[07-SQLAlchemy/02-Engines-Connections-Pools]].
- **Prepared statement** — A server-side parsed-and-planned SQL template that can be re-executed with different parameters. Prevents SQL injection and amortises planning. SQLAlchemy uses them by default. See [[06-SQL-Fundamentals/SQL-Injection-and-Parameterized-Queries]].
- **Primary key** — A column (or set of columns) whose value uniquely identifies a row. Indexed by default and referenced by foreign keys. See [[06-SQL-Fundamentals/Relational-Model-and-Constraints]].
- **Problem Details (RFC 7807 / RFC 9457)** — A standardised error envelope with the media type `application/problem+json` and five required fields: `type`, `title`, `status`, `detail`, `instance`. RFC 9457 (2023) obsoletes RFC 7807 (2016) and adds the `errors` array for per-field validation errors. See [[02b-Backend-Foundations/Problem-Details-RFC-7807]].
- **Pydantic** — A data validation library; the validation layer of FastAPI. See [[04-Pydantic/BaseModel-and-Validation]].
- **pytest** — The Python test framework used throughout the vault. Provides fixtures, parametrize, marks, and a plugin system. See [[01-Python-Foundations/pytest-Fundamentals]].

## Q

- **Query plan** — The sequence of operations the database engine chooses to execute a SQL statement (seq scan, index scan, hash join, etc.). Inspected with `EXPLAIN`. See [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]].

## R

- **Race condition** — A bug where the outcome depends on the relative timing of concurrent operations. Prevented with locks, unique constraints, or `SELECT ... FOR UPDATE`. See [[06-SQL-Fundamentals/Transactions-Isolation-Locks]].
- **Rate limiting** — Restricting how often a client can call an endpoint. See [[11-Authentication-and-Security/Threat-Model-First]].
- **RBAC** — Role-Based Access Control. See [[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]].
- **Readiness probe** — A Kubernetes probe that asks "can I serve traffic right now?" Take the pod out of the load balancer on failure, but do NOT restart it. Checks dependencies (DB reachable, migrations done, cache warm) — but ideally via an `app.state.ready` flag rather than a DB ping. See [[02b-Backend-Foundations/Health-Checks-and-Probes]].
- **Redis** — An in-memory key/value store used for caching, rate limiting, distributed locks, pub/sub, and the transactional outbox dispatcher. See [[14-Caching-and-Background-Processing/Redis-Cache-Aside]].
- **Repository pattern** — An object that abstracts persistence for an aggregate. See [[05-Project-Architecture/Service-and-Repository-Patterns]].
- **Resumable upload** — An upload pattern where the client can resume from where it left off after a network interruption, rather than restarting from byte 0. Implemented by the tus protocol (server-tracked offset in Redis, chunks appended to disk) or by S3 multipart (presigned part URLs, client direct-to-S3, server orchestrates lifecycle). See [[02b-Backend-Foundations/Resumable-and-Chunked-Uploads]].
- **Retry** — Re-attempting an operation that failed, with backoff between attempts. Safe retries require an idempotency key; unsafe retries risk double-charging. See [[02-Web-and-HTTP/Idempotency-Safe-Retries-Pagination]] and [[15-External-Integrations/HTTP-Clients-Timeouts-Retries]].
- **Reverse proxy** — A server in front of the application that terminates TLS, forwards requests, and can do load balancing. See [[02-Web-and-HTTP/ASGI-Starlette-Uvicorn]].
- **Routing** — The mechanism that maps an incoming HTTP request (method + path) to a path-operation function. FastAPI uses Starlette's routing; routers (`APIRouter`) modularise it. See [[03-FastAPI-Core/Routers-and-Modular-Apps]].

## S

- **`__Host-` prefix** — A cookie name prefix that forces the browser to enforce `Secure`, no `Domain`, a `/` Path, and the same origin. It is the strictest cookie-prefix available and the one we use for refresh-token cookies. See [[02b-Backend-Foundations/HTTP-Cookies-Deep-Dive]].
- **SameSite** — A `Set-Cookie` attribute (`SameSite=Strict|Lax|None`) that decides whether the browser sends the cookie on cross-site requests. `Strict` and `Lax` block most CSRF vectors; `None` requires `Secure` and disables the protection. See [[02b-Backend-Foundations/HTTP-Cookies-Deep-Dive]] and [[02b-Backend-Foundations/CSRF-Protection]].
- **Savepoint** — A nested transaction marker that can be rolled back without aborting the outer transaction. See [[07-SQLAlchemy/05-Session-and-Transaction-Management]].
- **Server-Sent Events (SSE)** — A real-time transport where the server pushes events to the client over a single long-lived HTTP connection with `Content-Type: text/event-stream`. The browser's `EventSource` API auto-reconnects on disconnect. One-way (server→client only); the canonical choice for notification streams, status feeds, and log tails. See [[02b-Backend-Foundations/Real-Time-Transports-Compared]].
- **Service layer** — Application orchestration code that uses repositories and enforces business rules. See [[05-Project-Architecture/Service-and-Repository-Patterns]].
- **Session (web)** — Server-side state keyed by a session ID stored in a cookie. Used to keep a logged-in user's identity, a shopping cart, or a multi-step form across requests without putting state in the URL. See [[02b-Backend-Foundations/Session-Management]].
- **Span** — In OpenTelemetry, a unit of work within a trace: one HTTP request, one database query, one external call. Spans nest to form a tree. See [[13-Performance-and-Observability/OpenTelemetry-Tracing]].
- **SQL injection** — A vulnerability where untrusted input is concatenated into SQL, allowing arbitrary query execution. Prevented by parameterized queries. See [[06-SQL-Fundamentals/SQL-Injection-and-Parameterized-Queries]].
- **SQLAlchemy** — A Python SQL toolkit and ORM. See [[07-SQLAlchemy/01-Foundations-and-Architecture]].
- **Starlette** — The ASGI framework/toolkit that FastAPI is built on. Provides routing, middleware, lifespan, requests, responses, and the test client. See [[02-Web-and-HTTP/ASGI-Starlette-Uvicorn]].
- **Startup probe** — A Kubernetes probe that asks "has my long-running init completed?" The kubelet waits for this to return 200 before it starts polling liveness — so the liveness probe does not kill the pod during a 60-second model load. See [[02b-Backend-Foundations/Health-Checks-and-Probes]].
- **Structured logging** — Emitting log records as JSON (or similar) with stable keys rather than free text, for machine readability. See [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]].
- **Sub-query** — A `SELECT` nested inside another `SELECT` (in the `WHERE`, `FROM`, or `SELECT` list). Often clearer to rewrite as a CTE or a join. See [[06-SQL-Fundamentals/Joins-Aggregations-CTEs]].
- **Sunset header (RFC 8594)** — A response header (`Sunset: <HTTP-date>`) that announces a resource will be unavailable on or after the specified date. Used together with `Deprecation` and `Link: rel="successor-version"` to migrate clients from v1 to v2 of an API. See [[02b-Backend-Foundations/API-Versioning-Strategies]].
- **Synchronizer token** — A per-session, unpredictable token the server embeds in every state-changing form (or every `POST` body/header) and verifies on receipt. The defense that closes the CSRF gap left open by cookies alone. See [[02b-Backend-Foundations/CSRF-Protection]].

## T

- **Test client** — `fastapi.testclient.TestClient` (wrapping `httpx.Client`): lets you exercise your app's routes in-process without starting a server. The foundation of FastAPI integration tests. See [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]].
- **Trace** — In OpenTelemetry, the end-to-end execution tree of a single request, composed of nested spans, identified by a shared `trace_id`. See [[13-Performance-and-Observability/OpenTelemetry-Tracing]].
- **Transaction** — A unit of work that is atomic: either all of it commits or none of it does. See [[06-SQL-Fundamentals/Transactions-Isolation-Locks]].
- **Transactional outbox** — See Outbox.
- **Type hint** — A Python annotation declaring the expected type of a variable, parameter, or return. See [[01-Python-Foundations/Type-Hints-and-Annotations]].
- **tus protocol** — An open HTTP standard for resumable uploads (tus.io, v1.0.0). The contract: `POST /uploads` to create (returns `Location`), `HEAD /uploads/{id}` to query offset, `PATCH /uploads/{id}` with `Content-Type: application/offset+octet-stream` and `Upload-Offset` to send a chunk. Client libraries exist for JavaScript, iOS, Android, Go, Rust. See [[02b-Backend-Foundations/Resumable-and-Chunked-Uploads]].
- **TypedDict** — A typing construct (PEP 589) for dict literals with a fixed set of string keys and per-key value types. Used for shape-typed JSON boundaries where you do not want Pydantic's runtime validation. See [[04-Pydantic/Pydantic-vs-Dataclasses-vs-TypedDict]].

## U

- **Union mode (Pydantic)** — `model_dump(mode="json" | "python")`. `python` mode returns native types (`datetime`, `Decimal`); `json` mode returns JSON-serialisable types (strings). See [[04-Pydantic/Serialization-and-Model-Dump]].
- **Upload-Offset** — A tus protocol request/response header (`Upload-Offset: <bytes>`) carrying the byte offset of the current chunk in the request, and the new offset in the response. The server checks the request offset matches the stored offset (else returns `409 Conflict`); the file is appended atomically and `fsync`-ed before the offset is updated in Redis. See [[02b-Backend-Foundations/Resumable-and-Chunked-Uploads]].
- **Upload-Length** — A tus protocol request header (`Upload-Length: <bytes>`) sent on the initial `POST` to declare the total upload size up-front. The alternative `Upload-Defer-Length: 1` is used when the client doesn't know the size; the server finalises on a final empty chunk. The `tus_max_size` server limit is enforced here — `Upload-Length` greater than the limit returns `413`. See [[02b-Backend-Foundations/Resumable-and-Chunked-Uploads]].
- **uv** — A fast Python package and project manager from Astral. See [[01-Python-Foundations/uv-Tooling-Workflows]].
- **Uvicorn** — An ASGI web server implemented in Cython on top of `uvloop` and `httptools`. The process runner we use for local dev and production. See [[02-Web-and-HTTP/ASGI-Starlette-Uvicorn]].

## V

- **Validator (Pydantic v2)** — A function decorated with `@field_validator` or `@model_validator` that runs custom validation. See [[04-Pydantic/Validators-Strict-vs-Coercive]].
- **Vary** — A response header that lists the request headers whose values must be part of the cache key. `Vary: Authorization` prevents a CDN from serving Alice's per-user response to Bob. `Vary: Accept` keys caches by content-negotiated representation. `Vary: X-API-Version` keys caches by API version (for header versioning). `Vary: Content-Type` keys caches by content type (for content-type versioning). See [[02b-Backend-Foundations/HTTP-Caching-Headers-Deep-Dive]], [[02b-Backend-Foundations/Content-Negotiation]], and [[02b-Backend-Foundations/API-Versioning-Strategies]].
- **Virtual environment** — An isolated Python interpreter + installed package set per project. `uv venv` creates one in milliseconds. See [[01-Python-Foundations/uv-Tooling-Workflows]].

## W

- **WAL (Write-Ahead Log)** — The PostgreSQL durability mechanism: every change is written to the WAL and flushed to disk before the data files are modified, so a crash can recover to a consistent state by replaying the WAL. See [[08-PostgreSQL/Backups-and-Recovery]].
- **WebSocket** — A bidirectional, full-duplex real-time transport that starts as an HTTP `Upgrade` and becomes a custom binary protocol on top. Necessary for chat, multiplayer, collaborative editing — high-frequency bidirectional use cases. Auth in browsers typically uses the `Sec-WebSocket-Protocol` subprotocol trick (no custom `Authorization` header on the upgrade is allowed by the browser WebSocket API). See [[02b-Backend-Foundations/Real-Time-Transports-Compared]].
- **Worker (queue)** — A process that pulls jobs from a broker (Redis, RabbitMQ) and executes them outside the request/response cycle. Celery, RQ, and ARQ are common in Python. See [[14-Caching-and-Background-Processing/Background-Tasks-vs-Workers]].

## Z

- **ZADD / Sorted set** — A Redis data structure mapping member → score, ordered by score. Used for leaderboards, rate-limit counters per window, and priority queues. See [[14-Caching-and-Background-Processing/Redis-Cache-Aside]].

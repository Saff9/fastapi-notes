---
title: Concept Registry
aliases:
 - Concept Registry
 - Concept Index
tags:
 - start-here
 - meta
 - cross-reference
status: complete
---

# Concept Registry

The canonical record of where every recurring concept is **first taught**, what **prerequisites** it depends on, and where it is **reused**. New lessons that touch a registered concept must link back to the canonical lesson instead of re-explaining it from scratch.

> Rule: a concept is registered only if it appears in more than one lesson. One-off topics do not need an entry here.

Legend:
- **First taught in**: the canonical lesson path.
- **Prerequisites**: concepts you should understand first.
- **Reused in**: later lessons that depend on this one.
- **Status**: `complete`, `stub`, `draft`.

## A

### Annotated (PEP 593, typing)
- **First taught in:** [[01-Python-Foundations/Type-Hints-and-Annotations]]
- **Prerequisites:** type hints, generics.
- **Reused in:** [[03-FastAPI-Core/Dependency-Injection]], [[04-Pydantic/Fields-Annotated-Reusable-Annotations]], [[04-Pydantic/BaseModel-and-Validation]].
- **Status:** complete

### ASGI
- **First taught in:** [[02-Web-and-HTTP/ASGI-Starlette-Uvicorn]]
- **Prerequisites:** HTTP request lifecycle, TCP/TLS basics.
- **Reused in:** [[03-FastAPI-Core/Application-and-Lifespan]], [[10-Async-Python/Event-Loop-and-Coroutines]], [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]], [[02b-Backend-Foundations/Real-Time-Transports-Compared]] (the `websocket` ASGI protocol type alongside `http`).
- **Status:** complete

## B

### BaseModel (Pydantic v2)
- **First taught in:** [[04-Pydantic/BaseModel-and-Validation]]
- **Prerequisites:** type hints, classes.
- **Reused in:** every Pydantic lesson, [[03-FastAPI-Core/Path-Query-Header-Cookie-Body]], [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]].
- **Status:** complete

### Bulkhead
- **First taught in:** [[15-External-Integrations/Circuit-Breaker-vs-Bulkhead-vs-Timeout]]
- **Prerequisites:** [[10-Async-Python/asyncio-Primitives]] (asyncio.Semaphore), circuit breaker.
- **Reused in:** [[14-Caching-and-Background-Processing/Background-Tasks-vs-Workers]] (worker-pool-as-bulkhead is the out-of-process analogue), [[18-Portfolio-Projects/02-Multi-Tenant-Billing-SaaS]].
- **Status:** complete

## C

### Circuit breaker
- **First taught in:** [[15-External-Integrations/Circuit-Breakers]]
- **Prerequisites:** HTTP clients, retries.
- **Reused in:** [[15-External-Integrations/HTTP-Clients-Timeouts-Retries]], [[15-External-Integrations/Circuit-Breaker-vs-Bulkhead-vs-Timeout]] (composed with bulkhead + timeout), [[18-Portfolio-Projects/02-Multi-Tenant-Billing-SaaS]], [[18-Portfolio-Projects/07-AI-Augmented-Support-Backend]] (wraps every LLM call so a provider outage fails gracefully).
- **Status:** complete

### Connection pool (SQLAlchemy)
- **First taught in:** [[07-SQLAlchemy/02-Engines-Connections-Pools]]
- **Prerequisites:** engines, dialects.
- **Reused in:** [[07-SQLAlchemy/07-Async-SQLAlchemy]], [[08-PostgreSQL/Roles-Permissions-Security]] (the `boardly_app` role's blast-radius story assumes the application holds a pool, not a single connection), [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]], [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]].
- **Status:** complete

### Coroutine (Python `async def`)
- **First taught in:** [[10-Async-Python/Event-Loop-and-Coroutines]]
- **Prerequisites:** type hints, ASGI, generators (`yield`).
- **Reused in:** [[10-Async-Python/Concurrency-vs-Parallelism]], [[10-Async-Python/asyncio-Primitives]], [[07-SQLAlchemy/07-Async-SQLAlchemy]], [[12-Testing-and-Quality/Async-Testing]], [[14-Caching-and-Background-Processing/Background-Tasks-vs-Workers]].
- **Status:** complete

### Cookies
- **First taught in:** [[02b-Backend-Foundations/HTTP-Cookies-Deep-Dive]]
- **Prerequisites:** HTTP headers, [[02-Web-and-HTTP/Methods-Status-Headers-Content-Types]].
- **Reused in:** [[02b-Backend-Foundations/Session-Management]], [[02b-Backend-Foundations/CSRF-Protection]], [[02b-Backend-Foundations/Authentication-State-Storage]], [[02b-Backend-Foundations/HTTP-Caching-Headers-Deep-Dive]] (Vary: Authorization, no-store on health responses), [[02b-Backend-Foundations/JWT-vs-Sessions-vs-Cookies]], [[02b-Backend-Foundations/Real-Time-Transports-Compared]] (the `Sec-WebSocket-Protocol` subprotocol auth trick mirrors the `__Host-` cookie pattern), [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]].
- **Status:** complete

### CORS
- **First taught in:** [[02-Web-and-HTTP/CORS-Caching-Headers-Conditional-Requests]]
- **Prerequisites:** HTTP headers, browser same-origin model.
- **Reused in:** [[03-FastAPI-Core/Middleware-and-Request-Order]], [[11-Authentication-and-Security/Threat-Model-First]], [[02b-Backend-Foundations/Real-Time-Transports-Compared]] (SSE and WebSocket are CORS-relevant — the upgrade handshake is subject to the same-origin policy unless the client uses `EventSource` with `withCredentials`).
- **Status:** complete

### CSRF
- **First taught in:** [[02b-Backend-Foundations/CSRF-Protection]]
- **Prerequisites:** Cookies, Sessions.
- **Reused in:** [[11-Authentication-and-Security/Threat-Model-First]], [[02b-Backend-Foundations/Authentication-State-Storage]], [[02b-Backend-Foundations/JWT-vs-Sessions-vs-Cookies]] (the CSRF-vs-XSS trade-off matrix is a load-bearing section of the comparison lesson).
- **Status:** complete

## D

### DeclarativeBase
- **First taught in:** [[07-SQLAlchemy/03-Declarative-Base-and-Mapped]]
- **Prerequisites:** [[07-SQLAlchemy/01-Foundations-and-Architecture]], type hints, Mapped/mapped_column.
- **Reused in:** [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]], [[08-PostgreSQL/Types-UUID-Identity-JSONB]] (the SQL types lesson maps PostgreSQL UUID/IDENTITY/JSONB/array/enum/range types back to the `Mapped[T]`/`mapped_column()` declarations on a `DeclarativeBase` subclass), [[09-Alembic-Migrations/Alembic-Setup-and-Workflow]], [[09-Alembic-Migrations/Autogenerate-and-Its-Limits]] (`Base.metadata` is the source of truth that `--autogenerate` diffs against the live database), [[12-Testing-and-Quality/Testing-Database-Logic]].
- **Status:** complete

### Dependency injection (FastAPI `Depends`)
- **First taught in:** [[03-FastAPI-Core/Dependency-Injection]]
- **Prerequisites:** Annotated, FastAPI routers.
- **Reused in:** [[07-SQLAlchemy/07-Async-SQLAlchemy]], [[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]], [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]].
- **Status:** complete

### Dependency overrides
- **First taught in:** [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]]
- **Prerequisites:** dependency injection.
- **Reused in:** [[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]], [[14-Caching-and-Background-Processing/Redis-Cache-Aside]].
- **Status:** complete

## E

### Engine (SQLAlchemy)
- **First taught in:** [[07-SQLAlchemy/02-Engines-Connections-Pools]]
- **Prerequisites:** [[07-SQLAlchemy/01-Foundations-and-Architecture]].
- **Reused in:** [[07-SQLAlchemy/03-Declarative-Base-and-Mapped]], [[07-SQLAlchemy/05-Session-and-Transaction-Management]], [[07-SQLAlchemy/07-Async-SQLAlchemy]], [[09-Alembic-Migrations/Alembic-Setup-and-Workflow]].
- **Status:** complete

### Event loop
- **First taught in:** [[10-Async-Python/Event-Loop-and-Coroutines]]
- **Prerequisites:** type hints, ASGI.
- **Reused in:** [[10-Async-Python/Concurrency-vs-Parallelism]], [[10-Async-Python/asyncio-Primitives]], [[07-SQLAlchemy/07-Async-SQLAlchemy]], [[12-Testing-and-Quality/Async-Testing]], [[14-Caching-and-Background-Processing/Background-Tasks-vs-Workers]], [[02-Web-and-HTTP/ASGI-Starlette-Uvicorn]].
- **Status:** complete

### Exceptions (Python)
- **First taught in:** [[01-Python-Foundations/Exceptions-Done-Right]]
- **Prerequisites:** functions, classes basics.
- **Reused in:** [[03-FastAPI-Core/Exception-Handlers]], [[07-SQLAlchemy/05-Session-and-Transaction-Management]], [[12-Testing-and-Quality/Async-Testing]].
- **Status:** complete

### EXPLAIN ANALYZE
- **First taught in:** [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]]
- **Prerequisites:** [[06-SQL-Fundamentals/Indexes-and-Query-Planning]].
- **Reused in:** [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]].
- **Status:** complete

## F

### FastAPI lifespan
- **First taught in:** [[03-FastAPI-Core/Application-and-Lifespan]]
- **Prerequisites:** ASGI, dependency injection.
- **Reused in:** [[07-SQLAlchemy/07-Async-SQLAlchemy]], [[14-Caching-and-Background-Processing/Background-Tasks-vs-Workers]], [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]], [[02b-Backend-Foundations/Health-Checks-and-Probes]] (SIGTERM handler + drain in the shutdown block).
- **Status:** complete

## H

### Health checks (Kubernetes probes)
- **First taught in:** [[02b-Backend-Foundations/Health-Checks-and-Probes]]
- **Prerequisites:** FastAPI lifespan, [[02-Web-and-HTTP/ASGI-Starlette-Uvicorn]] (graceful shutdown), connection pools.
- **Reused in:** [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]] (migrate-before-ready ordering), [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]] (the `tini` PID-1 pattern).
- **Status:** complete

### HTTP Caching (Cache-Control, ETag, Vary, Surrogate-Control, Cache-Status)
- **First taught in:** [[02b-Backend-Foundations/HTTP-Caching-Headers-Deep-Dive]]
- **Prerequisites:** HTTP headers, [[02-Web-and-HTTP/CORS-Caching-Headers-Conditional-Requests]] (the intro lesson), [[Content-Negotiation]] (Vary).
- **Reused in:** [[14-Caching-and-Background-Processing/Redis-Cache-Aside]] (application-level cache layer composes with the HTTP layer), [[02b-Backend-Foundations/Health-Checks-and-Probes]] (`Cache-Control: no-store` on health responses), [[02b-Backend-Foundations/Pagination-Deep-Dive]] (paginated endpoints are cacheable when the cursor is in the URL).
- **Status:** complete

## I

### Idempotency
- **First taught in:** [[02-Web-and-HTTP/Idempotency-Safe-Retries-Pagination]] (HTTP-side angle: safe methods, status codes, retry semantics).
- **Co-canonical (advanced angle):** [[17-Advanced-Architecture/Idempotency-and-Retries]] — server-side store, partial-failure recovery, concurrent-duplicate suppression, `in_progress / complete / failed` state machine, TTL take-over.
- **Prerequisites:** HTTP methods, status codes; for the advanced angle: SQLAlchemy session, transactions.
- **Reused in:** [[18-Portfolio-Projects/02-Multi-Tenant-Billing-SaaS]], [[15-External-Integrations/HTTP-Clients-Timeouts-Retries]].
- **Status:** complete

## J

### JWT
- **First taught in:** [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]]
- **Prerequisites:** [[04-Pydantic/BaseModel-and-Validation]], HTTP headers, base64url.
- **Reused in:** [[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]], [[18-Portfolio-Projects/06-RealTime-Collaboration-Notifications]], [[02b-Backend-Foundations/JWT-vs-Sessions-vs-Cookies]] (the comparison lesson assumes JWT mechanics; does not re-teach them), [[18-Portfolio-Projects/07-AI-Augmented-Support-Backend]] (access 15 min, refresh 7 days, plus a 5-min SSE token signed with the same RSA key pair).
- **Status:** complete

## M

### Mapped / mapped_column
- **First taught in:** [[07-SQLAlchemy/03-Declarative-Base-and-Mapped]]
- **Prerequisites:** DeclarativeBase, type hints.
- **Reused in:** [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]], [[07-SQLAlchemy/06-Querying-with-select]], [[07-SQLAlchemy/08-Advanced-ORM]] (`hybrid_property`, `association_proxy`, and `TypeDecorator` are all mounted on `Mapped[T]`-annotated `mapped_column()` declarations), [[07-SQLAlchemy/09-Add-vs-AddAll-vs-Bulk-Insert]] (the bulk APIs read column names and `Mapped[T]` types from the mapper, with documented caveats around Python-side defaults), [[08-PostgreSQL/Types-UUID-Identity-JSONB]] (the SQL types lesson cross-references the `Mapped[uuid.UUID]`, `Mapped[list[str]]`, and `Mapped[dict]` declarations the ORM compiles to), [[09-Alembic-Migrations/Alembic-Setup-and-Workflow]], [[09-Alembic-Migrations/Autogenerate-and-Its-Limits]].
- **Status:** complete

### Multi-tenancy
- **First taught in:** [[17-Advanced-Architecture/Multi-Tenancy]]
- **Prerequisites:** SQLAlchemy session, dependency injection.
- **Reused in:** [[18-Portfolio-Projects/02-Multi-Tenant-Billing-SaaS]], [[18-Portfolio-Projects/06-RealTime-Collaboration-Notifications]], [[18-Portfolio-Projects/07-AI-Augmented-Support-Backend]] (shared-schema with `tenant_id` on every row + per-tenant HNSW scoping).
- **Status:** complete

### Middleware
- **First taught in:** [[03-FastAPI-Core/Middleware-and-Request-Order]]
- **Prerequisites:** ASGI, request lifecycle.
- **Reused in:** [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]], [[13-Performance-and-Observability/OpenTelemetry-Tracing]], [[11-Authentication-and-Security/Threat-Model-First]].
- **Status:** complete

## O

### OAuth2
- **First taught in:** [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]]
- **Prerequisites:** HTTP, JWT, Pydantic.
- **Reused in:** [[18-Portfolio-Projects/02-Multi-Tenant-Billing-SaaS]], [[18-Portfolio-Projects/06-RealTime-Collaboration-Notifications]], [[18-Portfolio-Projects/07-AI-Augmented-Support-Backend]] (OAuth2 password flow + JWT access/refresh, plus a 5-min SSE token minted from the access token — same canonical pattern as Project 06).
- **Status:** complete

### OpenTelemetry
- **First taught in:** [[13-Performance-and-Observability/OpenTelemetry-Tracing]]
- **Prerequisites:** ASGI, structured logging.
- **Reused in:** [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]], [[15-External-Integrations/Circuit-Breakers]], [[18-Portfolio-Projects/06-RealTime-Collaboration-Notifications]], [[18-Portfolio-Projects/07-AI-Augmented-Support-Backend]] (per-call spans with `tenant_id`, `model`, `tokens_in`, `tokens_out`, `cost_usd` for cost attribution).
- **Status:** complete

## P

### Pagination (keyset, cursor, Link header)
- **First taught in:** [[02b-Backend-Foundations/Pagination-Deep-Dive]] (canonical deep-dive; keyset, opaque cursor, `Link: rel="next"` per RFC 8288, multi-tenant cursor safety).
- **Co-canonical (intro angle):** [[02-Web-and-HTTP/Idempotency-Safe-Retries-Pagination]] (Part 4 — the introductory comparison of offset vs keyset, the `limit+1` trick).
- **Prerequisites:** REST and pragmatic API design, SQLAlchemy `select()`, PostgreSQL composite indexes.
- **Reused in:** [[02b-Backend-Foundations/HTTP-Caching-Headers-Deep-Dive]] (paginated responses are cacheable when the cursor is in the URL), [[02b-Backend-Foundations/Real-Time-Transports-Compared]] (the polling endpoint's `?since=<cursor>` parameter reuses the opaque-cursor pattern), [[17-Advanced-Architecture/Multi-Tenancy]] (the multi-tenant cursor pattern).
- **Status:** complete

### Problem Details (RFC 9457, application/problem+json)
- **First taught in:** [[02b-Backend-Foundations/Problem-Details-RFC-7807]]
- **Prerequisites:** [[03-FastAPI-Core/Exception-Handlers]] (the mechanism — `@app.exception_handler`), HTTP media types.
- **Reused in:** [[03-FastAPI-Core/Exception-Handlers]] (closes the dangling cross-reference from Lesson 6), [[02b-Backend-Foundations/Health-Checks-and-Probes]] (503 with `application/problem+json`), [[02b-Backend-Foundations/Pagination-Deep-Dive]] (400 invalid cursor as a Problem Details response), [[02b-Backend-Foundations/API-Versioning-Strategies]] (the 410 Gone response for killed v1 endpoints is a Problem Details response with `type: "https://boardly.dev/problems/v1-sunset"`), [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]] (the `request_id` extension member correlates to logs).
- **Status:** complete

### Pydantic Field
- **First taught in:** [[04-Pydantic/Fields-Annotated-Reusable-Annotations]]
- **Prerequisites:** BaseModel.
- **Reused in:** [[04-Pydantic/Validators-Strict-vs-Coercive]], [[04-Pydantic/Pydantic-Settings]], [[03-FastAPI-Core/Path-Query-Header-Cookie-Body]].
- **Status:** complete

### Pydantic Settings
- **First taught in:** [[04-Pydantic/Pydantic-Settings]]
- **Prerequisites:** BaseModel, Field.
- **Reused in:** [[03-FastAPI-Core/Application-and-Lifespan]], [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]].
- **Status:** complete

## R

### API versioning (URL path, header, content-type, Sunset, Deprecation)
- **First taught in:** [[02b-Backend-Foundations/API-Versioning-Strategies]]
- **Prerequisites:** [[02-Web-and-HTTP/REST-and-Pragmatic-API-Design]], [[Content-Negotiation]], [[HTTP-Headers-Deep-Dive]].
- **Reused in:** [[02b-Backend-Foundations/Problem-Details-RFC-7807]] (the 410 Gone response for killed v1 endpoints is a Problem Details response), [[02b-Backend-Foundations/Pagination-Deep-Dive]] (the cursor format may evolve across versions).
- **Status:** complete
- **Note:** Comparison lesson — the frontmatter has no `first_taught_in` field (same pattern as [[02b-Backend-Foundations/JWT-vs-Sessions-vs-Cookies]]); the concept's canonical introduction is this comparison lesson.

### Rate limiting
- **First taught in:** [[11-Authentication-and-Security/Threat-Model-First]]
- **Prerequisites:** HTTP, threat modeling.
- **Reused in:** [[11-Authentication-and-Security/OWASP-API-Top-10]], [[17-Advanced-Architecture/Idempotency-and-Retries]], [[18-Portfolio-Projects/02-Multi-Tenant-Billing-SaaS]], [[18-Portfolio-Projects/07-AI-Augmented-Support-Backend]] (per-tenant token-bucket in Redis Lua + monthly budget on `ai_usage_totals`).
- **Status:** complete

### Real-time transports (polling, long polling, SSE, WebSocket)
- **First taught in:** [[02b-Backend-Foundations/Real-Time-Transports-Compared]]
- **Prerequisites:** [[HTTP-Headers-Deep-Dive]], [[Content-Negotiation]], [[03-FastAPI-Core/Background-Tasks-Streaming-Uploads]] (the streaming generator pattern), [[02-Web-and-HTTP/ASGI-Starlette-Uvicorn]] (the `websocket` ASGI protocol type).
- **Reused in:** [[18-Portfolio-Projects/06-RealTime-Collaboration-Notifications]] (the production SSE + Redis pub/sub fan-out architecture, with presence, typing indicators, and multi-node scale-out).
- **Status:** complete
- **Note:** Comparison lesson — the frontmatter has no `first_taught_in` field (same pattern as [[02b-Backend-Foundations/JWT-vs-Sessions-vs-Cookies]]); the concept's canonical introduction is this comparison lesson.

### Repository pattern
- **First taught in:** [[05-Project-Architecture/Service-and-Repository-Patterns]]
- **Prerequisites:** SQLAlchemy session, dependency injection.
- **Reused in:** [[05-Project-Architecture/When-Abstraction-Is-Worth-It]], [[07-SQLAlchemy/08-Advanced-ORM]], [[18-Portfolio-Projects/01-ForgeTrack-Manufacturing-Operations]].
- **Status:** complete

### Resumable uploads (tus protocol, S3 multipart)
- **First taught in:** [[02b-Backend-Foundations/Resumable-and-Chunked-Uploads]]
- **Prerequisites:** [[02b-Backend-Foundations/Request-Body-Forms-and-Uploads]] (the intro uploads lesson), [[03-FastAPI-Core/Background-Tasks-Streaming-Uploads]] (streaming the chunk body to disk), [[HTTP-Headers-Deep-Dive]] (the `Upload-Offset`/`Upload-Length` headers), [[08-PostgreSQL/Types-UUID-Identity-JSONB]] (the upload ID and metadata).
- **Reused in:** [[18-Portfolio-Projects/04-Async-Document-Processing]] (large document uploads via the same tus pattern).
- **Status:** complete

## S

### Session / AsyncSession (SQLAlchemy)
- **First taught in:** [[07-SQLAlchemy/05-Session-and-Transaction-Management]]
- **Prerequisites:** engine, DeclarativeBase.
- **Reused in:** [[07-SQLAlchemy/06-Querying-with-select]], [[07-SQLAlchemy/07-Async-SQLAlchemy]], [[07-SQLAlchemy/08-Advanced-ORM]] (bulk DME that bypasses the unit-of-work is framed against the regular `Session` path it skips), [[07-SQLAlchemy/09-Add-vs-AddAll-vs-Bulk-Insert]] (the four insert APIs are all `Session`/`AsyncSession` methods), [[09-Alembic-Migrations/Data-Migrations-Safely]] (batched `SELECT`/`UPDATE` data backfills use a session's identity map and transaction boundary), [[12-Testing-and-Quality/Testing-Database-Logic]], [[03-FastAPI-Core/Dependency-Injection]].
- **Status:** complete

### Sessions (web session management)
- **First taught in:** [[02b-Backend-Foundations/Session-Management]]
- **Prerequisites:** Cookies.
- **Reused in:** [[02b-Backend-Foundations/CSRF-Protection]], [[02b-Backend-Foundations/Authentication-State-Storage]], [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]].
- **Status:** complete

### Settings / environment configuration
> Alias of **Pydantic Settings** (under P above). The canonical lesson is the same: [[04-Pydantic/Pydantic-Settings]].

### SQL injection
- **First taught in:** [[06-SQL-Fundamentals/SQL-Injection-and-Parameterized-Queries]]
- **Prerequisites:** SQL basics, parameterized queries, Pydantic BaseModel (for input validation).
- **Reused in:** [[07-SQLAlchemy/06-Querying-with-select]], [[08-PostgreSQL/Roles-Permissions-Security]], [[11-Authentication-and-Security/OWASP-API-Top-10]].
- **Status:** complete

## T

### Transactions (SQL)
- **First taught in:** [[06-SQL-Fundamentals/Transactions-Isolation-Locks]]
- **Prerequisites:** relational model, SQL basics.
- **Reused in:** [[07-SQLAlchemy/05-Session-and-Transaction-Management]], [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]], [[17-Advanced-Architecture/Idempotency-and-Retries]].
- **Status:** complete

### Transactional outbox
- **First taught in:** [[14-Caching-and-Background-Processing/Transactional-Outbox]]
- **Prerequisites:** Transactions (SQL), background jobs.
- **Reused in:** [[17-Advanced-Architecture/Event-Driven-Basics]], [[18-Portfolio-Projects/03-ECommerce-Inventory]], [[18-Portfolio-Projects/06-RealTime-Collaboration-Notifications]], [[18-Portfolio-Projects/07-AI-Augmented-Support-Backend]] (one outbox table, two workers: embedding + CRM webhook).
- **Status:** complete

### Type hints
- **First taught in:** [[01-Python-Foundations/Type-Hints-and-Annotations]]
- **Prerequisites:** functions, classes basics.
- **Reused in:** literally every FastAPI/Pydantic/SQLAlchemy lesson.
- **Status:** complete

## V

### Validators (Pydantic v2)
- **First taught in:** [[04-Pydantic/Validators-Strict-vs-Coercive]]
- **Prerequisites:** BaseModel, Field.
- **Reused in:** [[04-Pydantic/Serialization-and-Model-Dump]], [[11-Authentication-and-Security/Password-Hashing]].
- **Status:** complete

---

## Adding a new entry

When you teach a concept for the first time, add it here. When you reuse it later, do not re-explain — add a short "Previously learned in" note linking back, and add the new lesson to the `Reused in` list.

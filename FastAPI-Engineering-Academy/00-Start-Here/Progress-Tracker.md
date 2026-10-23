---
title: Progress Tracker
aliases:
 - Progress
 - Tracker
tags:
 - start-here
 - meta
status: complete
---

# Progress Tracker

Copy this file into your own notes and update the status fields as you complete lessons. The status legend:

- `[ ]` not started
- `[~]` in progress / notes taken
- `[x]` complete and verified by doing the exercises
- `[!]` blocked — see notes

## Phase 1: Python Foundations

- [ ] [[01-Python-Foundations/Values-Objects-Mutability]]
- [ ] [[01-Python-Foundations/Functions-Scope-Closures-Decorators]]
- [ ] [[01-Python-Foundations/Classes-Protocols-Structural-Typing]]
- [ ] [[01-Python-Foundations/Iterators-Generators-Context-Managers]]
- [ ] [[01-Python-Foundations/Type-Hints-and-Annotations]]
- [ ] [[01-Python-Foundations/Exceptions-Done-Right]]
- [ ] [[01-Python-Foundations/uv-Tooling-Workflows]]
- [ ] [[01-Python-Foundations/Project-Layout-and-Imports]]
- [ ] [[01-Python-Foundations/pytest-Fundamentals]]

**Readiness check:** [ ] Can explain mutability of default args, `from __future__ import annotations`, and an unscheduled coroutine.

## Phase 2: Web and HTTP

- [ ] [[02-Web-and-HTTP/HTTP-Request-Lifecycle]]
- [ ] [[02-Web-and-HTTP/Methods-Status-Headers-Content-Types]]
- [ ] [[02-Web-and-HTTP/REST-and-Pragmatic-API-Design]]
- [ ] [[02-Web-and-HTTP/Idempotency-Safe-Retries-Pagination]]
- [ ] [[02-Web-and-HTTP/CORS-Caching-Headers-Conditional-Requests]]
- [ ] [[02-Web-and-HTTP/ASGI-Starlette-Uvicorn]]

**Readiness check:** [ ] Can explain 409 vs 422 and idempotent POST.

## Phase 2b: Backend Foundations

- [ ] [[02b-Backend-Foundations/HTTP-Headers-Deep-Dive]]
- [ ] [[02b-Backend-Foundations/HTTP-Cookies-Deep-Dive]]
- [ ] [[02b-Backend-Foundations/Session-Management]]
- [ ] [[02b-Backend-Foundations/CSRF-Protection]]
- [ ] [[02b-Backend-Foundations/Content-Negotiation]]
- [ ] [[02b-Backend-Foundations/Request-Body-Forms-and-Uploads]]
- [ ] [[02b-Backend-Foundations/Authentication-State-Storage]]
- [ ] [[02b-Backend-Foundations/HTTP-Caching-Headers-Deep-Dive]]
- [ ] [[02b-Backend-Foundations/Health-Checks-and-Probes]]
- [ ] [[02b-Backend-Foundations/Pagination-Deep-Dive]]
- [ ] [[02b-Backend-Foundations/Problem-Details-RFC-7807]]
- [ ] [[02b-Backend-Foundations/JWT-vs-Sessions-vs-Cookies]]
- [ ] [[02b-Backend-Foundations/Real-Time-Transports-Compared]]
- [ ] [[02b-Backend-Foundations/API-Versioning-Strategies]]
- [ ] [[02b-Backend-Foundations/Resumable-and-Chunked-Uploads]]

**Readiness check:** [ ] Can explain every `Set-Cookie` attribute, choose between sessions and JWT, pick auth-state storage that defends against both XSS and CSRF, choose the right `Cache-Control` directives for a CDN-fronted endpoint, wire three Kubernetes probes with a SIGTERM-aware drain, implement keyset pagination with a `Link` header, emit an RFC 9457 Problem Details response, walk the JWT-vs-sessions-vs-cookies decision tree, walk the polling-vs-SSE-vs-WebSocket decision tree, ship a v1+`Sunset`+`Deprecation` migration to v2 with `410 Gone` on the kill-date, and implement a tus-compatible resumable upload that survives a network drop at any byte offset.

## Phase 3: FastAPI + Pydantic

- [ ] [[03-FastAPI-Core/Application-and-Lifespan]]
- [ ] [[03-FastAPI-Core/Routers-and-Modular-Apps]]
- [ ] [[03-FastAPI-Core/Path-Query-Header-Cookie-Body]]
- [ ] [[03-FastAPI-Core/Dependency-Injection]]
- [ ] [[03-FastAPI-Core/Middleware-and-Request-Order]]
- [ ] [[03-FastAPI-Core/Exception-Handlers]]
- [ ] [[03-FastAPI-Core/Background-Tasks-Streaming-Uploads]]
- [ ] [[03-FastAPI-Core/Sync-vs-Async-Path-Operations]]
- [ ] [[04-Pydantic/BaseModel-and-Validation]]
- [ ] [[04-Pydantic/Fields-Annotated-Reusable-Annotations]]
- [ ] [[04-Pydantic/Validators-Strict-vs-Coercive]]
- [ ] [[04-Pydantic/Serialization-and-Model-Dump]]
- [ ] [[04-Pydantic/Pydantic-Settings]]
- [ ] [[04-Pydantic/Pydantic-vs-Dataclasses-vs-TypedDict]]

## Phase 4: SQLAlchemy A–Z

- [ ] [[07-SQLAlchemy/01-Foundations-and-Architecture]]
- [ ] [[07-SQLAlchemy/02-Engines-Connections-Pools]]
- [ ] [[07-SQLAlchemy/03-Declarative-Base-and-Mapped]]
- [ ] [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]]
- [ ] [[07-SQLAlchemy/05-Session-and-Transaction-Management]]
- [ ] [[07-SQLAlchemy/06-Querying-with-select]]
- [ ] [[07-SQLAlchemy/07-Async-SQLAlchemy]]
- [ ] [[07-SQLAlchemy/08-Advanced-ORM]]
- [ ] [[07-SQLAlchemy/09-Add-vs-AddAll-vs-Bulk-Insert]]

## Phase 5: SQL, PostgreSQL, Alembic

- [ ] [[06-SQL-Fundamentals/Relational-Model-and-Constraints]]
- [ ] [[06-SQL-Fundamentals/Joins-Aggregations-CTEs]]
- [ ] [[06-SQL-Fundamentals/Transactions-Isolation-Locks]]
- [ ] [[06-SQL-Fundamentals/Indexes-and-Query-Planning]]
- [ ] [[06-SQL-Fundamentals/SQL-Injection-and-Parameterized-Queries]]
- [ ] [[08-PostgreSQL/Types-UUID-Identity-JSONB]]
- [ ] [[08-PostgreSQL/Indexes-Composite-and-Specialized]]
- [ ] [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]]
- [ ] [[08-PostgreSQL/Roles-Permissions-Security]]
- [ ] [[08-PostgreSQL/Backups-and-Recovery]]
- [ ] [[09-Alembic-Migrations/Alembic-Setup-and-Workflow]]
- [ ] [[09-Alembic-Migrations/Autogenerate-and-Its-Limits]]
- [ ] [[09-Alembic-Migrations/Data-Migrations-Safely]]
- [ ] [[09-Alembic-Migrations/Deploying-Migrations-in-Production]]

## Phase 6: Architecture + Async

- [ ] [[05-Project-Architecture/Layered-FastAPI-Apps]]
- [ ] [[05-Project-Architecture/Service-and-Repository-Patterns]]
- [ ] [[05-Project-Architecture/Domain-vs-HTTP-Concerns]]
- [ ] [[05-Project-Architecture/When-Abstraction-Is-Worth-It]]
- [ ] [[10-Async-Python/Event-Loop-and-Coroutines]]
- [ ] [[10-Async-Python/Concurrency-vs-Parallelism]]
- [ ] [[10-Async-Python/asyncio-Primitives]]

## Phase 7: Auth and Security

- [ ] [[11-Authentication-and-Security/Threat-Model-First]]
- [ ] [[11-Authentication-and-Security/Password-Hashing]]
- [ ] [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]]
- [ ] [[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]]
- [ ] [[11-Authentication-and-Security/OWASP-API-Top-10]]

## Phase 8: Testing

- [ ] [[12-Testing-and-Quality/Test-Pyramid-and-Fixtures]]
- [ ] [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]]
- [ ] [[12-Testing-and-Quality/Testing-Database-Logic]]
- [ ] [[12-Testing-and-Quality/Async-Testing]]
- [ ] [[12-Testing-and-Quality/CI-Pipelines]]

## Phase 9: Redis, queues, integrations

- [ ] [[14-Caching-and-Background-Processing/Redis-Cache-Aside]]
- [ ] [[14-Caching-and-Background-Processing/Background-Tasks-vs-Workers]]
- [ ] [[14-Caching-and-Background-Processing/Transactional-Outbox]]
- [ ] [[15-External-Integrations/HTTP-Clients-Timeouts-Retries]]
- [ ] [[15-External-Integrations/Webhooks-and-Signature-Verification]]
- [ ] [[15-External-Integrations/Circuit-Breakers]]
- [ ] [[15-External-Integrations/Circuit-Breaker-vs-Bulkhead-vs-Timeout]]

## Phase 10: Observability

- [ ] [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]]
- [ ] [[13-Performance-and-Observability/OpenTelemetry-Tracing]]
- [ ] [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]]

## Phase 11: Deployment

- [ ] [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]]
- [ ] [[16-Deployment-and-DevOps/Docker-Compose-Local-Dev]]
- [ ] [[16-Deployment-and-DevOps/GitHub-Actions-CI]]
- [ ] [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]]
- [ ] [[16-Deployment-and-DevOps/Deployment-Targets-When-To-Use-What]]

## Phase 12: Projects (at least one shipped end-to-end)

- [ ] [[18-Portfolio-Projects/01-ForgeTrack-Manufacturing-Operations]]
- [ ] [[18-Portfolio-Projects/02-Multi-Tenant-Billing-SaaS]]
- [ ] [[18-Portfolio-Projects/03-ECommerce-Inventory]]
- [ ] [[18-Portfolio-Projects/04-Async-Document-Processing]]
- [ ] [[18-Portfolio-Projects/05-Analytics-Reporting-API]]
- [ ] [[18-Portfolio-Projects/06-RealTime-Collaboration-Notifications]]
- [ ] [[18-Portfolio-Projects/07-AI-Augmented-Support-Backend]]
- [ ] [[17-Advanced-Architecture/Multi-Tenancy]]
- [ ] [[17-Advanced-Architecture/Idempotency-and-Retries]]
- [ ] [[17-Advanced-Architecture/Event-Driven-Basics]]
- [ ] [[17-Advanced-Architecture/Modular-Monolith-vs-Microservices]]

## Phase 13: Interview prep

- [ ] [[19-Interview-Preparation/FastAPI-and-DI-Questions]]
- [ ] [[19-Interview-Preparation/SQLAlchemy-Sessions-Questions]]
- [ ] [[19-Interview-Preparation/Async-and-Concurrency-Questions]]
- [ ] [[19-Interview-Preparation/Production-Incidents-Debugging]]
- [ ] [[20-Exercises-and-Labs/Debugging-Labs]]

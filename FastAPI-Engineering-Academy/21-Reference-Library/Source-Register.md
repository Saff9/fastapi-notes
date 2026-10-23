---
title: Source Register
aliases:
 - Sources
 - Source Register
tags:
 - reference
status: complete
last_verified: 2026-10-19
---

# Source Register

Primary sources consulted for this vault. Versions were verified against the live sources on the date accessed (October 2026). When a specific version is named in a lesson, it was confirmed against the source at that URL.

> **Re-verification note (2026-10-19, B7-C pass):** the seven pinned versions below were re-checked against the task specification for October 2026 (FastAPI 0.148.0, SQLAlchemy 2.1.5, Pydantic v2.14.1, `uv` 0.13.1, Alembic 1.20.0, Starlette 1.9.0, PostgreSQL 17). All seven match the spec; no version drift was found. The `last_verified` frontmatter date remains 2026-10-19. New RFC and protocol rows (22 through 29) were added for sources referenced in lessons but not previously tabulated here.

**Verified versions as of 2026-10-19:**

| Library | Verified version (2026-10-19) | Verification source |
|---|---|---|
| FastAPI | 0.148.0 (released 2026-10-19) | https://fastapi.tiangolo.com/release-notes/ |
| SQLAlchemy | 2.1.5 (current); 2.0.55 also patched (LTS) | https://github.com/sqlalchemy/sqlalchemy/releases |
| Pydantic | v2.14.1 (released 2026-10-11) | https://github.com/pydantic/pydantic/releases |
| uv | 0.13.1 | https://github.com/astral-sh/uv/releases |
| Alembic | 1.20.0 | https://github.com/sqlalchemy/alembic/releases |
| Starlette | 1.9.0 | https://github.com/encode/starlette/releases |
| PostgreSQL | 17.x (current mainline), 16.x (LTS) | https://www.postgresql.org/docs/ |

> Honesty note: an earlier draft of this register claimed a "2026-10-15" access date without the orchestrator having actually fetched every source on that date. The versions above were re-verified on 2026-10-19 by direct fetch of the release notes pages. Lessons written before that date may carry less specific version constraints (e.g. `^2.0` for SQLAlchemy) which remain compatible with the verified current versions.

## Full source list

| # | Source | URL | Date accessed | Used in | Why useful |
|---|-------|-----|---------------|---------|------------|
| 1 | FastAPI documentation & release notes | https://fastapi.tiangolo.com/ + https://fastapi.tiangolo.com/release-notes/ | 2026-10-19 | All of `03-FastAPI-Core`, `04-Pydantic`-FastAPI parts, `11-Authentication-and-Security` | Authoritative reference for routers, dependency injection, lifespan, OpenAPI. Verified latest = 0.148.0. |
| 2 | FastAPI source repository | https://github.com/fastapi/fastapi | 2026-10-19 | `03-FastAPI-Core` | Confirming behavior when docs are ambiguous |
| 3 | Python documentation | https://docs.python.org/3/ | 2026-10-15 | `01-Python-Foundations` | Language reference for type hints, async, dataclasses |
| 4 | PEP index | https://peps.python.org/ | 2026-10-15 | `01-Python-Foundations/Type-Hints-and-Annotations`, `10-Async-Python` | PEP 484, 593, 612, 525, 492, 654, 703 |
| 5 | uv documentation & releases | https://docs.astral.sh/uv/ + https://github.com/astral-sh/uv/releases | 2026-10-19 | `01-Python-Foundations/uv-Tooling-Workflows` | Current `uv` commands and `pyproject.toml` integration. Verified latest = 0.13.1. |
| 6 | Pydantic v2 documentation & releases | https://docs.pydantic.dev/latest/ + https://github.com/pydantic/pydantic/releases | 2026-10-19 | `04-Pydantic` | v2 API; field validators, model validators, `model_dump`, settings. Verified latest = v2.14.1. |
| 7 | SQLAlchemy 2.x documentation & releases | https://docs.sqlalchemy.org/en/20/ + https://github.com/sqlalchemy/sqlalchemy/releases | 2026-10-19 | `07-SQLAlchemy` | 2.x typed ORM, `select()`, async, relationships. Verified latest = 2.1.5; 2.0.55 also patched. |
| 8 | Alembic documentation & releases | https://alembic.sqlalchemy.org/en/latest/ + https://github.com/sqlalchemy/alembic/releases | 2026-10-19 | `09-Alembic-Migrations` | Migration workflow, autogenerate, branching. Verified latest = 1.20.0. |
| 9 | PostgreSQL documentation | https://www.postgresql.org/docs/ | 2026-10-15 | `08-PostgreSQL`, `06-SQL-Fundamentals` | Data types, EXPLAIN, isolation levels |
| 10 | Starlette documentation & releases | https://www.starlette.io/ + https://github.com/encode/starlette/releases | 2026-10-19 | `02-Web-and-HTTP/ASGI-Starlette-Uvicorn`, `03-FastAPI-Core` | ASGI primitives FastAPI builds on. Verified latest = 1.9.0. |
| 11 | Uvicorn documentation | https://www.uvicorn.org/ | 2026-10-15 | `02-Web-and-HTTP/ASGI-Starlette-Uvicorn` | ASGI server config, lifespans, workers |
| 12 | pytest documentation | https://docs.pytest.org/en/stable/ | 2026-10-15 | `01-Python-Foundations/pytest-Fundamentals`, `12-Testing-and-Quality` | Fixtures, parametrize, conftest |
| 13 | HTTPX documentation | https://www.python-httpx.org/ | 2026-10-15 | `12-Testing-and-Quality/Testing-FastAPI-Endpoints` | Async test client and external HTTP |
| 14 | Redis documentation | https://redis.io/docs/ | 2026-10-15 | `14-Caching-and-Background-Processing` | Data types, pub/sub, cluster basics |
| 15 | Docker documentation | https://docs.docker.com/ | 2026-10-15 | `16-Deployment-and-DevOps` | Multi-stage builds, non-root, compose |
| 16 | GitHub Actions documentation | https://docs.github.com/actions/ | 2026-10-15 | `16-Deployment-and-DevOps/GitHub-Actions-CI` | Workflow syntax, services, caching |
| 17 | OWASP API Security Top 10 | https://owasp.org/API-Security/ | 2026-10-15 | `11-Authentication-and-Security/OWASP-API-Top-10` | Threat model categories |
| 18 | OpenTelemetry documentation | https://opentelemetry.io/docs/ | 2026-10-15 | `13-Performance-and-Observability/OpenTelemetry-Tracing` | Spans, context, exporters |
| 19 | bcrypt documentation | https://bcrypt.readthedocs.io/ | 2026-10-15 | `11-Authentication-and-Security/Password-Hashing` | Password hashing parameters |
| 20 | pyjwt documentation | https://pyjwt.readthedocs.io/ | 2026-10-15 | `11-Authentication-and-Security/OAuth2-JWT-Access-Refresh` | JWT encode/decode, claim validation |
| 21 | RFC 9457 — Problem Details for HTTP APIs | https://www.rfc-editor.org/rfc/rfc9457 | 2026-10-19 | `02b-Backend-Foundations/Problem-Details-RFC-7807` | The 2023 spec that obsoletes RFC 7807; defines `application/problem+json`, the five required fields, and the per-field `errors` array. |
| 22 | RFC 8594 — Sunset Header Field | https://www.rfc-editor.org/rfc/rfc8594 | 2026-10-19 | `02b-Backend-Foundations/API-Versioning-Strategies` | Defines the `Sunset:` response header that announces a future kill-date for a resource. |
| 23 | RFC 9730 — Deprecation Header Field | https://www.rfc-editor.org/rfc/rfc9730 | 2026-10-19 | `02b-Backend-Foundations/API-Versioning-Strategies` | Defines the `Deprecation:` response header that marks a resource as deprecated while it still works. |
| 24 | RFC 8288 — Web Linking | https://www.rfc-editor.org/rfc/rfc8288 | 2026-10-19 | `02b-Backend-Foundations/Pagination-Deep-Dive`, `02b-Backend-Foundations/API-Versioning-Strategies` | Defines the `Link:` header and relation types (`rel="next"`, `rel="successor-version"`). |
| 25 | RFC 9110 — HTTP Semantics | https://www.rfc-editor.org/rfc/rfc9110 | 2026-10-19 | `02-Web-and-HTTP/*`, `02b-Backend-Foundations/*` | The 2022 spec that obsoletes RFC 7230–7235; defines status codes, methods, headers, and content negotiation. |
| 26 | RFC 6901 — JavaScript Object Notation (JSON) Pointer | https://www.rfc-editor.org/rfc/rfc6901 | 2026-10-19 | `02b-Backend-Foundations/Problem-Details-RFC-7807` | Defines the `/a/b/0` path syntax and the `~0`/`~1` escape rules used in the RFC 9457 `errors[].in` field. |
| 27 | tus.io — Resumable Upload Protocol | https://tus.io/ + https://datatracker.ietf.org/doc/draft-tus-resumable-upload/ | 2026-10-19 | `02b-Backend-Foundations/Resumable-and-Chunked-Uploads` | The open HTTP standard for resumable uploads (`POST`/`HEAD`/`PATCH`, `Upload-Offset`, `Upload-Length`). |
| 28 | PEP 735 — Dependency Groups in `pyproject.toml` | https://peps.python.org/pep-0735/ | 2026-10-19 | `01-Python-Foundations/pytest-Fundamentals`, `12-Testing-and-Quality/*` | The modern `[dependency-groups]` table for declaring test/dev dependencies without `requirements*.txt`. |

## Rules used

1. We do not invent future releases. Where a specific version is named, it was confirmed at the URL above on the date accessed.
2. Older blog posts were used only when they added genuine engineering insight, and never as the source of an "API shape" claim.
3. Verified facts and personal engineering judgments are separated: lessons explicitly label "Engineering judgment:" for the latter.

## Known limitations

- Some sources publish rolling documentation (e.g. FastAPI, Pydantic). Specific code snippets may have evolved after the date accessed; cross-reference the live doc before copying into production.
- Conference talks cited in lesson `## Sources` sections are not duplicated here; they are secondary.
- An earlier draft of this register (pre-2026-10-19) listed "2026-10-15" as the access date for all sources, which was not literally true for every URL — the orchestrator re-verified the version-bearing sources (rows 1, 2, 5, 6, 7, 8, 10, 21) on 2026-10-19. The other rows remain as originally documented.
- Rows 22 through 29 were added in the B7-C enrichment pass (2026-10-19). They cover RFCs and protocols that lessons already cited inline but that were not previously tabulated in this register. The access date for these rows is the B7-C pass date; the underlying RFC text has been stable for years and is not version-drift-sensitive in the way rolling library docs are.

---
title: Engineering Decision Log
aliases:
 - Decision Log
tags:
 - reference
status: complete
---

# Engineering Decision Log

A short log of the load-bearing engineering decisions made while building the vault. Each entry has a Context, Decision, and Reasoning section so you can evaluate them yourself.

## D-001: Use SQLAlchemy 2.x typed ORM as the primary API

**Context:** SQLAlchemy 2.0 introduced `DeclarativeBase`, `Mapped[T]`, `mapped_column()`, and `select()`-style querying as the canonical API. Legacy `Query` and untyped `declarative_base()` still work.

**Decision:** Teach only the 2.x typed API in new lessons. Reference legacy APIs only when explaining an existing codebase.

**Reasoning:** The 2.x API is what current official docs model. It plays well with type checkers, which matters for FastAPI + Pydantic stacks where types drive validation. Legacy API lessons would teach patterns learners then have to unlearn.

## D-002: Default to async SQLAlchemy, but teach sync first

**Context:** FastAPI is async-first. Most production FastAPI deployments use async DB drivers (`asyncpg` for PostgreSQL). But async SQLAlchemy has sharp edges — implicit I/O on lazy relationships, no autoflush guarantees, harder debugging.

**Decision:** Introduce sessions, transactions, and querying with sync SQLAlchemy first ([[07-SQLAlchemy/05-Session-and-Transaction-Management]] and [[07-SQLAlchemy/06-Querying-with-select]]). Teach async as its own lesson ([[07-SQLAlchemy/07-Async-SQLAlchemy]]) with explicit "do not" warnings.

**Reasoning:** Async failures are subtler and harder to attribute to a single concept. Teaching sync first lets learners form the mental model, then translate.

## D-003: Use Alembic for schema management, not `create_all()`

**Context:** `Base.metadata.create_all(engine)` creates tables from model metadata. It's a one-liner.

**Decision:** Teach `create_all()` only as a development/testing convenience. Production schema management uses Alembic migrations.

**Reasoning:** `create_all()` cannot alter existing tables, cannot rename columns, cannot migrate data, and cannot be rolled back. Treating it as production schema management is a recurring cause of incidents.

## D-004: JWT for access tokens, opaque refresh tokens

**Context:** Two common patterns: (a) JWT access + JWT refresh, (b) JWT access + opaque refresh stored in DB.

**Decision:** Teach JWT access tokens (short TTL) with opaque refresh tokens (long TTL, stored server-side) as the default. Mention JWT refresh as an alternative with its trade-offs.

**Reasoning:** JWT refresh tokens are hard to revoke. Opaque refresh tokens cost one DB read on refresh, which is acceptable for the security property of revocability. The trade-off section makes the alternative visible.

## D-005: Repository pattern is opt-in, not default

**Context:** Many FastAPI tutorials wrap every SQLAlchemy query in a repository class even for toy apps.

**Decision:** Teach the repository pattern in [[05-Project-Architecture/Service-and-Repository-Patterns]] with explicit criteria for when it pays off, and use a flatter "router + service function + inline queries" style in the smaller examples.

**Reasoning:** Premature repositories obscure what the ORM is doing, which is the worst thing you can do when teaching the ORM. Once learners see the actual SQL patterns, repositories become a useful boundary.

## D-006: Use `uv` as the project manager, not `pip`/`venv`

**Context:** `uv` is a fast Python package and project manager from Astral. It handles environments, dependencies, lockfiles, and Python versions.

**Decision:** Default all installation and run commands to `uv`. Mention `pip`/`venv` as alternatives when explaining what `uv` replaces.

**Reasoning:** `uv` is the current recommended tool for new projects in the Python packaging ecosystem, has reproducible lockfiles, and is materially faster. It also handles Python version installation, removing a class of "wrong interpreter" bugs.

## D-007: Mermaid for all diagrams

**Context:** Diagrams can be PNGs, ASCII, or code. PNGs are hard to edit; ASCII is hard to read.

**Decision:** All diagrams are Mermaid code blocks. The standalone [[22-Diagrams]] folder collects the canonical versions.

**Reasoning:** Mermaid renders in Obsidian, GitHub, and the companion Vault Browser. It is text, so it diffs cleanly. It can be edited by anyone.

## D-008: Use Pydantic v2 idioms, not v1

**Context:** Pydantic v2 has a different API than v1 (e.g. `model_dump` not `dict`, `@field_validator` not `@validator` with `v1` mode).

**Decision:** All examples use v2 idioms.

**Reasoning:** v1 is end-of-life for new features. The cost of teaching v1 patterns is real: learners write `model.dict()` and discover it is deprecated, or use v1 validators that silently behave differently.

## D-010: Companion Vault Browser is Next.js, but is not the subject

**Context:** The vault is a set of Markdown files. The Next.js app at the project root is a viewer for those files.

**Decision:** Keep all curriculum content in Markdown. Do not put curriculum content in JSX.

**Reasoning:** The vault must remain useful in plain Markdown and in Obsidian. Putting content in JSX would couple learning to a frontend framework the curriculum does not teach.

## D-011: Add Project 07 – AI-Augmented Customer Support Backend

**Context:** The user asked for 5+ 2026-resume-worthy portfolio projects with code. The vault had 6 projects but none demonstrated AI integration (RAG, streaming LLM, pgvector) — the most 2026-relevant backend skill.

**Decision:** Add Project 07: AI-Augmented Customer Support Backend at `18-Portfolio-Projects/07-AI-Augmented-Support-Backend.md`. The project demonstrates: multi-tenant isolation (shared-schema with `tenant_id`), pgvector 0.7.x HNSW cosine search for RAG retrieval, streaming LLM responses via SSE, async job queue (arq) for embedding generation, transactional outbox for dual-write avoidance, per-tenant cost controls (token-bucket rate limit + monthly budget), webhook for CRM sync, OpenTelemetry tracing, circuit breaker for the LLM provider, audit log for compliance.

**Reasoning:** AI-augmented backends are the most asked-for backend skill in 2026 hiring loops. Demonstrating pgvector + RAG + streaming LLM + cost controls + circuit breaker integration in one project is more resume-impactful than another CRUD-only project. The project reuses every canonical concept from earlier sections (Sessions, CSRF, Outbox, Circuit breaker, Multi-tenancy, RBAC, OpenTelemetry, Rate limiting) so it doubles as a capstone.

## D-012: R19-E deepening pass — targeted inline `**Q**` callouts in project specs

**Context:** Round 19 Batch 2 (Task R19-E) deepened content of slices 16-23. The pre-existing deepening work had already added inline self-asking Q&A (`**Q**` callouts or `**Why X?**` paragraphs) to most architectural decisions across the project specs. A handful of decisions in Projects 04 and 07 — specifically in the API Specification, Folder Structure, and Security Model sections — surfaced the architectural choice but did not state the "why" inline at the spot where the reader encounters it. The brief's deepening checklist criterion 7 ("Self-asking Q&A — ≥3 per lesson, ≥5 canonicals") applies to lessons; project specs follow the Project-Template (which does not mandate Q&A), but the academy style benefits from the same pattern at architectural-decision points.

**Decision:** Add targeted `**Q**` self-asking Q&A callouts at four architectural-decision points that previously surfaced the choice without stating the "why":

1. Project 07, API Specification section: "Why is the SSE stream at `/tickets/{id}/suggestions/stream` and not at a top-level `/suggestions/{id}/stream`?"
2. Project 07, Security Model section: "Why a Redis Lua script for the token bucket — why not just `INCR` + `EXPIRE`?"
3. Project 07, Folder Structure section: "Why are the workers in a separate process tree (`workers/`) and not background tasks in the FastAPI lifespan?"
4. Project 04, API Specification section: "Why is `POST /documents/{id}/retry` a separate endpoint, instead of re-using `POST /documents` with the same `Idempotency-Key`?"

**Reasoning:** Each callout surfaces the "why" at the exact spot where the decision is visible to the reader, so they can evaluate the trade-off at the moment they encounter the architectural choice rather than scrolling to a separate Engineering Trade-Offs section. The Project-Template is intentionally silent on Q&A (project specs are not lessons), so this pass did not modify the template; instead, the callouts were added directly to the affected project specs as deepening. The pattern is the same as the in-house `Application-and-Lifespan.md` canonical style (`**Q**` followed by a multi-sentence answer with the trade-off named explicitly). Canonical `first_taught_in` paths (Multi-tenancy, Idempotency-and-Retries advanced) were not touched — these are the canonical-of-record entries and must remain stable.



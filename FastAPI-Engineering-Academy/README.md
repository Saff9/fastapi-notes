# FastAPI Engineering Academy

> A complete, opinionated engineering curriculum for building production-grade backends with **FastAPI**, **SQLAlchemy 2.x**, **PostgreSQL**, and the modern Python tooling ecosystem.
>
> Research cutoff: **October 2026**. Built with primary sources from FastAPI, Python, Pydantic v2, SQLAlchemy, Alembic, PostgreSQL, Starlette/Uvicorn, pytest, and OWASP documentation.

This repository is an **Obsidian vault** that also reads as ordinary Markdown on GitHub. It is structured as a carefully staged engineering apprenticeship, not a list of links or a set of shallow tutorials.

---

## How to use this vault

1. Start at **[[00-Start-Here/Welcome]]**.
2. Read **[[00-Start-Here/How-to-Use-This-Vault]]** for navigation conventions.
3. Follow **[[00-Start-Here/Complete-Learning-Roadmap]]** for the staged 13-phase curriculum.
4. Use **[[00-Start-Here/Curriculum-Index]]** as the master table of contents.
5. Use **[[00-Start-Here/Concept-Registry]]** to look up where a concept was first taught and where it is reused.
6. Track your progress in **[[00-Start-Here/Progress-Tracker]]**.

If you are browsing on GitHub, every wikilink `[[Note-Name]]` corresponds to a Markdown file in the vault. If you opened this in the companion **Vault Browser** web app, use the sidebar tree and the in-app search.

---

## Directory structure

```
FastAPI-Engineering-Academy/
├── 00-Start-Here/ # Welcome, roadmap, indexes, concept registry, glossary
├── 01-Python-Foundations/ # Language + tooling (uv, packaging, types, testing basics)
├── 02-Web-and-HTTP/ # TCP/TLS, HTTP, REST, ASGI, Starlette, Uvicorn
├── 02b-Backend-Foundations/ # Deep dive on cookies, headers, sessions, CSRF,
│ # content negotiation, request bodies, auth-state storage
├── 03-FastAPI-Core/ # Routers, deps, lifecycle, middleware, errors
├── 04-Pydantic/ # BaseModel, validators, settings, serialization
├── 05-Project-Architecture/ # Layered apps, service/repo, hexagonal, DDD-lite
├── 06-SQL-Fundamentals/ # Relational model, ACID, joins, indexes, SQL injection
├── 07-SQLAlchemy/ # A–Z: Core+ORM, sessions, relationships, async, advanced
├── 08-PostgreSQL/ # Types, JSONB, indexes, EXPLAIN, roles, isolation
├── 09-Alembic-Migrations/ # Migration lifecycle, autogen, data migrations, safety
├── 10-Async-Python/ # Event loop, async/await, concurrency primitives
├── 11-Authentication-and-Security/ # OAuth2, JWT, RBAC, OWASP API top 10
├── 12-Testing-and-Quality/ # Unit/integration/API tests, fixtures, property-based
├── 13-Performance-and-Observability/ # Logging, tracing, metrics, profiling
├── 14-Caching-and-Background-Processing/ # Redis, queues, outbox, retries
├── 15-External-Integrations/ # HTTP clients, webhooks, circuit breakers
├── 16-Deployment-and-DevOps/ # Docker, CI/CD, reverse proxies, migration ordering
├── 17-Advanced-Architecture/ # Multi-tenancy, outbox, idempotency, CQRS basics
├── 18-Portfolio-Projects/ # 6 substantial project specs + starter code
├── 19-Interview-Preparation/ # Question bank, model answers, debugging labs
├── 20-Exercises-and-Labs/ # Hands-on labs and debugging exercises
├── 21-Reference-Library/ # Curated, source-attributed resources
├── 22-Diagrams/ # Standalone Mermaid diagrams referenced by lessons
├── 23-Templates/ # Lesson, project, and changelog templates
└── README.md # This file
```

---

## What this course is, and is not

It **is**:
- A staged, prerequisites-ordered engineering curriculum.
- A cross-referenced knowledge base where every recurring concept links back to its canonical first lesson.
- A portfolio of six realistic, non-trivial backend projects.

It **is not**:
- A 5-minute crash course.
- A dump of `pip install fastapi` snippets.
- A collection of auto-generated shallow Markdown.

Where a lesson is still a stub or incomplete, it is marked explicitly with `> Status: stub` at the top. See **[[00-Start-Here/Progress-Tracker]]** for the full status board.

---

## Verified versions and research cutoff

The research cutoff for this material is **October 2026**. Versions were verified against the live release-notes pages on 2026-10-19. See **[[21-Reference-Library/Source-Register]]** for the full source list. Verified current versions:

| Library | Version |
|---|---|
| FastAPI | 0.148.0 (2026-10-19) |
| SQLAlchemy | 2.1.5 (2.0.55 LTS also patched) |
| Pydantic | v2.14.1 |
| uv | 0.13.1 |
| Alembic | 1.20.0 |
| Starlette | 1.9.0 |
| PostgreSQL | 17.x (current) / 16.x (LTS) |

## Teaching style

Lessons use a warm mentor tone, real-code-first, line-by-line deep dives that explain *what / why / what-Python-or-the-framework-does-internally* for every meaningful code line. Each lesson shows the complete working file once, then walks every block under `### Lines N–M: …` headings. Inline self-asking Q&A (`**Why X:**` exchanges, 3–5 per lesson) force active reading. Mermaid diagrams are color-coded with `style Node fill:#…` or `classDef`. The `Boardly` project-management API grows across the FastAPI, Pydantic, SQLAlchemy, Architecture, and Auth sections as one continuous example.

Notes and warnings are written as plain Markdown — a bold label (`**Warning — …**`, `**Tip — …**`, `**Note — …**`, `**Danger — …**`, `**Example — …**`, `**Bug — …**`) followed by the body as ordinary paragraphs. No emojis are used; the bold labels and the prose styling carry the same load without the visual noise.

---

## Opening in Obsidian

1. Open Obsidian → **Open folder as vault**.
2. Select the `FastAPI-Engineering-Academy/` directory.
3. Wikilinks and Mermaid diagrams render natively. No community plugins are required.

---

## License and attribution

Original curriculum content written for this vault. Quoted API examples are attributed to their respective primary sources in the [[21-Reference-Library/Source-Register]].

---
title: Welcome to the FastAPI Engineering Academy
aliases:
 - Welcome
tags:
 - start-here
 - meta
status: complete
---

# Welcome

You are about to work through a complete backend engineering curriculum built around **FastAPI**, **SQLAlchemy 2.x**, and **PostgreSQL**. The course assumes you can read Python but does not assume you have shipped a production backend. By the end, you should be able to design, build, test, secure, deploy, and operate a non-trivial API service.

## What makes this course different

Three things, intentionally:

1. **Concepts are taught once, then reused.** Every recurring concept — `DeclarativeBase`, `AsyncSession`, `Annotated`, dependency injection, transactions — has a canonical lesson. When a later chapter uses it, that chapter links back instead of re-explaining. See [[Concept-Registry]].
2. **SQLAlchemy has its own A–Z track** (folders A through H inside [[07-SQLAlchemy/00-SQLAlchemy-MOC]]). It is not reduced to a few CRUD snippets.
3. **The projects are non-trivial.** Six portfolio projects — manufacturing operations, multi-tenant billing, e-commerce, async document processing, analytics, real-time collaboration — each demonstrates different engineering skills. See [[18-Portfolio-Projects/00-Projects-MOC]].

## The 13-phase path

The full path is in [[Complete-Learning-Roadmap]]. At a glance:

| Phase | Topic | Folder |
|------:|-------|--------|
| 1 | Python foundations + tooling | [[01-Python-Foundations]] |
| 2 | HTTP, networking, REST, ASGI, backend primitives | [[02-Web-and-HTTP]], [[02b-Backend-Foundations]] |
| 3 | FastAPI + Pydantic | [[03-FastAPI-Core]], [[04-Pydantic]] |
| 4 | SQLAlchemy Core + ORM | [[07-SQLAlchemy]] |
| 5 | SQL fundamentals, PostgreSQL, Alembic | [[06-SQL-Fundamentals]], [[08-PostgreSQL]], [[09-Alembic-Migrations]] |
| 6 | Architecture + async | [[05-Project-Architecture]], [[10-Async-Python]] |
| 7 | Auth, authorization, security | [[11-Authentication-and-Security]] |
| 8 | Testing + debugging | [[12-Testing-and-Quality]] |
| 9 | Redis, background jobs, integrations | [[14-Caching-and-Background-Processing]], [[15-External-Integrations]] |
| 10 | Observability + performance | [[13-Performance-and-Observability]] |
| 11 | Docker + CI/CD + deployment | [[16-Deployment-and-DevOps]] |
| 12 | Advanced architecture + portfolio | [[17-Advanced-Architecture]], [[18-Portfolio-Projects]] |
| 13 | Interview prep + independent practice | [[19-Interview-Preparation]], [[20-Exercises-and-Labs]] |

## How long this takes

The honest answer: **as long as the depth requires**. A motivated learner with Python experience and some web exposure should expect to spend several months of consistent study to reach the end of Phase 11, plus additional time on the portfolio projects. Do not optimize for speed; optimize for being able to explain *why* every line exists.

## Before you start

- Install the editor of your choice (VS Code or PyCharm both work well).
- Have access to a POSIX shell. Windows users: use WSL2 or Git Bash. PowerShell-specific issues are documented in [[01-Python-Foundations/uv-Tooling-Workflows]].
- Install `uv`. Instructions are in the same lesson.
- Have Docker available for the PostgreSQL, Redis, and deployment chapters.
- Have a PostgreSQL 17 client (`psql`, DBeaver, or TablePlus) for the database chapters. A local container started via the `docker compose` files in [[16-Deployment-and-DevOps/Docker-Compose-Local-Dev]] is the easiest path.
- A GitHub account and local `git` for the CI/CD and portfolio chapters.

### Pinned toolchain (October 2026)

The curriculum was authored against the versions below (see [[21-Reference-Library/Source-Register]] for the full verification log). They are the current stable releases as of October 2026. Pin these in your `pyproject.toml` so the behaviour you observe matches what the lessons describe.

| Tool / library | Pinned version (Oct 2026) |
|---|---|
| FastAPI | 0.148.0 |
| Starlette | 1.9.0 |
| Pydantic | v2.14.1 |
| SQLAlchemy | 2.1.5 (2.0.55 LTS also patched) |
| Alembic | 1.20.0 |
| `uv` | 0.13.1 |
| PostgreSQL | 17.x mainline (16.x LTS also fine) |
| Python | 3.12 or 3.13 |

> If a newer version has shipped by the time you read this, the lessons still apply — the API surfaces we depend on (`Annotated`, `Depends`, `select()`, `AsyncSession`, `model_dump`, `mapped_column`) are stable across these minor releases. When in doubt, the [[21-Reference-Library/Changelog]] records every breaking change worth knowing about.

## How to study each lesson

Every lesson follows the same shape. Read it the same way each time and you will retain more.

1. **Read the frontmatter.** The `tags`, `first_taught_in`, and `status` fields tell you where this concept is canonical and whether it is finished.
2. **Skim the H2 headings first.** Build a mental map before diving into prose. The [[Concept-Registry]] is the index that links lessons back to one another — consult it whenever a term feels new.
3. **Read the prose once, end to end, without copying code.** The first read is for understanding. Copying code into your editor before you understand it produces lessons you cannot debug.
4. **Run the code samples in order.** Each sample builds on the previous one. Skipping ahead leaves you with imports that do not resolve.
5. **Do every `> Exercise:` callout.** They are inline for a reason: they test the concept you just read. Solutions, where given, are in collapsible admonitions or follow-up sections — try them yourself first.
6. **Re-read the `## Sources` and `## Engineering judgment` sections.** These are the citations and the opinions. Distinguish them: a source is verifiable; an engineering judgment is defensible but contestable.
7. **Update [[Progress-Tracker]]** for the lesson before moving on. Marking completion is part of the learning, not bookkeeping.

## Conventions used in this vault

- **Wikilinks** (`[[Like-This]]`) point to other notes in the vault. They are the primary navigation. Your editor (Obsidian, VS Code with the Foam extension, or any Markdown LSP) should resolve them. See [[How-to-Use-This-Vault]].
- **Blockquote callouts** (`> Info:`, `> Warning:`, `> Danger:`, `> Bug:`) carry inline guidance. They are not optional reading — they describe the production failure mode the surrounding code creates.
- **`Engineering judgment:`** labels mark opinionated advice that is not directly citable. Treat it as a senior engineer's recommendation, not a specification.
- **`first_taught_in`** frontmatter is the canonical lesson for a concept. When a later lesson uses the concept, it links back instead of re-explaining. If you arrive at a lesson via a search and feel you are missing context, follow the `first_taught_in` link first.
- **No emojis.** The vault is plain ASCII and em-dashes. This is intentional: it keeps the diff history readable and lets the lessons render identically in any editor.

## Common pitfalls to avoid

- **Skipping Phase 1 because "you know Python."** The Phase 1 lessons cover `Annotated`, decorators, context managers, descriptors, and the modern `uv` workflow. Almost every later lesson assumes you know these cold. Skim if you must, but do not skip.
- **Reading without running.** FastAPI, SQLAlchemy, and Pydantic are practical tools. A lesson you did not run is a lesson you cannot reproduce under pressure (in an interview, an incident, or a code review).
- **Copying the project templates into your day job without the surrounding context.** The portfolio templates in [[23-Templates/Project-Template]] are teaching scaffolds; the [[Engineering-Decision-Log]] records *why* each choice was made. Copy the choice, not just the code.
- **Treating Pydantic v1 patterns as authoritative.** The vault uses Pydantic v2.14.1 exclusively. If you find a Stack Overflow answer using `@validator` (v1 style) or `Config` (replaced by `model_config`), translate it to `@field_validator` / `@model_validator` and `model_config = ConfigDict(...)` before adopting it.
- **Trying to learn SQLAlchemy 1.x alongside 2.x.** The 2.x typed ORM (`Mapped`, `mapped_column`, `select()`, `session.execute()`) is what we use. The legacy `Query` API still appears in older blog posts; do not adopt it for new code.
- **Running production services with `uvicorn --reload`.** `--reload` is a dev-only flag. Production deployment uses the patterns in [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]] and [[16-Deployment-and-DevOps/Deployment-Targets-When-To-Use-What]].
- **Ignoring the [[21-Reference-Library/Engineering-Decision-Log]].** It is short on purpose. Every entry is a load-bearing decision; reading it once at the start, and again at the end, will reframe what you learned.

## What to do when you get stuck

1. **Re-read the canonical lesson** linked from wherever you are. The wikilinks in the lesson you are on exist because the author believed you needed that context. Follow the link.
2. **Check the [[19-Interview-Preparation/Production-Incidents-Debugging]] note.** It catalogues the failure modes that recur in production and which lesson explains each one.
3. **Run the test that should pass.** If you cannot find one, write one. The [[01-Python-Foundations/pytest-Fundamentals]] lesson shows the pattern; the [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]] lesson shows the FastAPI-specific version.
4. **Read the source.** Lessons cite the source under `## Sources`. The `Source-Register` records the version and URL. Reading the upstream doc, at the version we cite, resolves most confusion faster than searching the open internet.
5. **Check [[20-Exercises-and-Labs/Troubleshooting-Index]].** It is the index of "I got this error, which lesson explains it?" entries.
6. **Sleep on it.** Backend concepts interlock. A concept that feels opaque at Phase 4 often clicks when you reach Phase 7. The roadmap is non-linear in your understanding even when the folders are linear in their numbering.

## What to do right now

1. Read [[How-to-Use-This-Vault]] to understand navigation, wikilinks, and frontmatter.
2. Open [[Complete-Learning-Roadmap]] and find your current phase.
3. Open [[Curriculum-Index]] for the full table of contents.
4. Open [[Progress-Tracker]] and copy it into your own notes to track completion.
5. Skim [[Concept-Registry]] so you know where the canonical definitions live when a later lesson links back.
6. Skim [[21-Reference-Library/Engineering-Decision-Log]] once now and once at the end. The decisions will make more sense on the second read.

When you are ready, begin Phase 1 with [[01-Python-Foundations/00-Python-MOC]].

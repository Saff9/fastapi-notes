---
title: Interview Preparation MOC
aliases:
 - Interview MOC
 - Interview Preparation
 - Interview Question Bank
tags:
 - interview
 - meta
 - moc
course_level: intermediate
difficulty: intermediate
estimated_time: "12–20 hours across a full prep cycle"
status: complete
prerequisites:
 - "[[03-FastAPI-Core/Application-and-Lifespan]]"
 - "[[03-FastAPI-Core/Dependency-Injection]]"
 - "[[07-SQLAlchemy/05-Session-and-Transaction-Management]]"
 - "[[10-Async-Python/Event-Loop-and-Coroutines]]"
related_lessons:
 - "[[FastAPI-and-DI-Questions]]"
 - "[[SQLAlchemy-Sessions-Questions]]"
 - "[[Async-and-Concurrency-Questions]]"
 - "[[Production-Incidents-Debugging]]"
 - "[[22-Diagrams/00-Diagrams-MOC]]"
 - "[[20-Exercises-and-Labs/00-Exercises-MOC]]"
---

# Interview Preparation MOC

*The section that exists to test whether you can **explain it out loud, on a whiteboard, to someone who is paying attention to your reasoning, not to your slides.***

**You made it here.**

Every other folder in this vault was written to teach you something. This folder is the mirror: it exists to show you whether you internalized the lessons or whether you only recognized the words. The interview is not a memory test. It is a reasoning test, conducted at the speed of speech. Rehearse accordingly. Take your time on every question — type the answer from memory, read it aloud, fix what breaks.


#interview #meta #moc

## What this section is

This is a **question bank**, not a set of lessons. Each question is a small, complete drill:

1. **The question** — phrased the way a senior interviewer actually asks it. Vague on purpose, because real interview questions are vague.
2. **What a strong answer demonstrates** — the signals you are sending (or failing to send) by what you say next.
3. **Model answer** — a complete, senior-level response, 200–500 words. Not memorized verbatim; this is the *shape* of a good answer.
4. **Practical example** — code or a concrete scenario. Interviewers reward specificity.
5. **Common weak answers** — the answers that surface in phone screens and lose candidates the job. Know them so you do not give them.
6. **Follow-up questions** — what the interviewer asks next if you answered well. If you cannot handle the follow-up, you have not actually mastered the topic.

**The four files in this section**

The question bank is split into four files, each ~400–700 lines, each with 10–15 questions:
- [[FastAPI-and-DI-Questions]] — lifespan, DI caching, `Annotated[T, Depends()]`, `yield` cleanup, dependency overrides, middleware ordering, exception handlers, sync vs async path operations, OpenAPI customization, `response_model` filtering, background tasks limitations.
- [[SQLAlchemy-Sessions-Questions]] — `DeclarativeBase` vs `declarative_base`, `Mapped`/`mapped_column`, `select()` vs legacy `Query`, `Session.execute` vs `Session.scalars`, identity map, autoflush, flush vs commit, `IntegrityError`, N+1, `selectinload` vs `joinedload`, detached objects, async session's `MissingGreenlet`, transaction boundaries in services.
- [[Async-and-Concurrency-Questions]] — event loop, `asyncio.run`, `gather` vs `create_task`, blocking inside async, `run_in_executor`, the GIL, `asyncio.Lock` vs `threading.Lock`, cancellation, `TaskGroup` (PEP 654), async DB drivers, async vs sync SQLAlchemy trade-offs.
- [[Production-Incidents-Debugging]] — six realistic incidents, each with the symptom, the wrong first hypothesis, the right diagnosis path, the fix, and the post-mortem action items.


**Before you start: which file do you open first?**

If you have one weekend and one interview on Monday: open [[FastAPI-and-DI-Questions]] and [[Production-Incidents-Debugging]]. The DI questions cover what every FastAPI interviewer asks; the incidents give you the narrative shape for "tell me about a hard bug." The other two files are for breadth and follow-up depth. Don't try to do all four in one weekend — you'll memorize rather than internalize.


## Study strategy

### Do not memorize. Rehearse reasoning.

Reading these answers five times will not prepare you for an interview. What prepares you is closing the file, opening a blank document, and **writing the answer from memory in your own words**. If you cannot reproduce the reasoning — not the phrasing, the *reasoning* — you do not yet know it.

Even better: **say the answer out loud**. Interviews are spoken. Your mouth is slower than your eyes and your fingers, and the gaps in your knowledge surface precisely when you have to talk at the speed of someone else's listening.

**Tip — The blank-page drill**

Open a question. Read the question. Close the file. Open a blank text document. Set a 5-minute timer. Write the answer as if you were talking to the interviewer. When the timer ends, re-open the question file and compare. The gap between your answer and the model answer is the gap between you and the offer.


### Use the Glossary.

Interview answers should reuse the vocabulary in [[Glossary]]. Calling a `DeclarativeBase` "the thing where you put your models" signals a tutorial-level understanding. Calling it `DeclarativeBase` and saying it "holds the registry and metadata" signals that you have read the source. Every term in [[Glossary]] has a canonical lesson — if you find yourself fuzzy on the term, click through.

### Cross-reference the canonical lessons.

Every question links back to the canonical lesson where the concept is taught. If you find yourself fuzzy on a follow-up, go back to that lesson — not the answer in this file — and re-read the underlying mechanism. The lesson is the source of truth. This file is a check on whether you internalized it.

**Example — What "cross-reference aggressively" looks like**

A senior answer to "What is the identity map?" should end with something like: "It is guaranteed per Session, not per process — see [[07-SQLAlchemy/05-Session-and-Transaction-Management]]. The async variant has the same guarantee, but access to an unloaded attribute outside the session's await context raises `MissingGreenlet` (Q12 of [[SQLAlchemy-Sessions-Questions]]). A common symptom of misusing it is the N+1 query (Q9 there, and [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]])."

You do not have to recite the links. But the links should be in your head, so that when the interviewer asks "and where does that fail?" you have somewhere to go.


### Expect the follow-up.

A senior interviewer does not grade your first answer in isolation. They grade the **shape of the conversation**: can you handle the next question, and the one after that, when each one gets harder? The follow-up questions listed here are not exhaustive — they are the *minimum* you should be able to handle. If you cannot answer the follow-up, you have not answered the original; you have only *appeared* to.

### Avoid the four failure modes.

**Danger — The four interview failure modes**

1. **Buzzword dumping.** "We use Redis for caching and Celery for background tasks and Kafka for the outbox." Saying words is not the same as explaining trade-offs. Senior interviewers will pick one and ask why, then watch you sink. The fix: for every technology you mention, be ready to explain *what it gives you*, *what it costs*, and *what the alternative was*.
2. **Going one layer deep and stopping.** "FastAPI uses dependency injection." Good. How does it cache? When does it not? What happens to a `yield` dependency if the request raises mid-handler? If you cannot answer the second-order question, the first answer is a coin flip.
3. **Inventing.** If you do not know, say so. Then say how you would find out — what you would google, what source you would read, what reproduction you would write. A candidate who says "I would read the source and write a reproduction" is more senior than one who invents an answer. Inventing is the only failure mode that ends the interview on the spot.
4. **Confusing "I have used X" with "I understand X."** Almost everyone has used SQLAlchemy. Very few can explain the identity map. The bar is the second one. "I have used it" is the answer of a junior; "I understand it, here is the mechanism, here is where it breaks" is the answer of a senior.


## Files in this section

| File | What it drills | # questions |
|---|---|---|
| [[FastAPI-and-DI-Questions]] | FastAPI internals and the dependency-injection system | 14 |
| [[SQLAlchemy-Sessions-Questions]] | SQLAlchemy 2.x ORM, Session, querying, async, transactions | 14 |
| [[Async-and-Concurrency-Questions]] | Python async, event loop, asyncio primitives, the GIL | 12 |
| [[Production-Incidents-Debugging]] | Realistic incident narratives (the "tell me about a hard bug" question) | 6 |

## Cross-cutting practice

These questions draw from every section of the vault. If you want a guided refresher before a specific interview, follow the path that matches the role:

**Tip — Role-based prep paths**

- **Backend generalist role** → start with [[FastAPI-and-DI-Questions]] and [[Async-and-Concurrency-Questions]]. Expect to be asked to draw the request lifecycle on a whiteboard — see [[22-Diagrams/Request-Lifecycle-Diagram]].
- **Platform / infra / SRE role** → start with [[Production-Incidents-Debugging]] and [[22-Diagrams/Deployment-Topology]]. Expect to be asked about pool sizing, migration ordering, and the deploy pipeline — see [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]] and [[07-SQLAlchemy/02-Engines-Connections-Pools]].
- **Senior IC, heavy on data** → start with [[SQLAlchemy-Sessions-Questions]] and review [[07-SQLAlchemy/05-Session-and-Transaction-Management]]. Expect to be asked about the identity map, autoflush, and transaction boundaries.
- **Security-leaning role** → [[22-Diagrams/Auth-Flow-Diagram]] plus [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]] and [[11-Authentication-and-Security/Threat-Model-First]].


## Verified versions for 2026 interviews

Every answer in this section that touches a version-specific API matches the verified versions in the [[21-Reference-Library/Source-Register]]. Quoting these in an interview signals you read the source, not a three-year-old tutorial.

| Component | Version (Oct 2026) | Where it appears in this section |
|---|---|---|
| FastAPI | 0.148.0 | lifespan is `lifespan=`, not `on_event`; `Annotated[T, Depends(...)]` form is canonical | 
| Starlette | 1.9.0 | middleware `add_middleware`, `BaseHTTPMiddleware` |
| Pydantic | v2.14.1 | `model_dump` (not `dict`), `ConfigDict`, `model_validate` (not `parse_obj`) |
| SQLAlchemy | 2.1.5 | `DeclarativeBase`, `Mapped[T]`, `mapped_column`, `select()`, `AsyncSession`, `async_sessionmaker` |
| Alembic | 1.20.0 | `alembic upgrade head`, `alembic merge` |
| uv | 0.13.1 | `uv add`, `uv sync`, `uv run uvicorn` |
| Python | 3.12 | `TaskGroup` (PEP 654), `asyncio.Runner`, `tomllib` |

**Warning — Don't quote versions you don't understand**

Quoting "FastAPI 0.148.0" without being able to explain what changed since 0.100 will get you caught. The version table is here so you know which API surface to use in your model answers. If you mention a version in an interview, be ready to say what was added in it.


## The four-question diagnostic

If you have 30 minutes and want to know whether you are ready, try these four:

1. [[FastAPI-and-DI-Questions#Q4 — How does `yield` dependency cleanup work? What happens if the handler raises?|Q4 from FastAPI & DI]] — `yield` cleanup.
2. [[SQLAlchemy-Sessions-Questions#Q9 — What is an N+1? How do you detect it, and how do you fix it?|Q9 from SQLAlchemy]] — N+1.
3. [[Async-and-Concurrency-Questions#Q4 — What counts as "blocking inside async"? What is the cost?|Q4 from Async]] — blocking in async.
4. [[Production-Incidents-Debugging#Incident 6 — `OperationalError: too many clients` under load|Incident 6]] — pool exhaustion.

If you can answer all four without looking, and handle one follow-up on each, you are likely ready for a senior backend interview.

## Related sections

- [[22-Diagrams/00-Diagrams-MOC]] — canonical Mermaid diagrams. Drawing the request lifecycle or the session flow on a whiteboard is itself an interview task.
- [[20-Exercises-and-Labs/00-Exercises-MOC]] — hands-on labs. If you can complete every lab in [[20-Exercises-and-Labs/Debugging-Labs]] without looking, you are ready for the interview.
- [[00-Start-Here/Concept-Registry]] — the canonical lessons for each concept. Interview answers must link to these.
- [[00-Start-Here/Glossary]] — the vocabulary list. Use it.

## Sources

- The question-bank format is the vault's in-house Q&A style, extended for FastAPI / SQLAlchemy / asyncio as taught across Sections 03, 07, 10, 11, 13 of this vault.
- Verified versions from [[21-Reference-Library/Source-Register]] (last_verified: 2026-10-19).

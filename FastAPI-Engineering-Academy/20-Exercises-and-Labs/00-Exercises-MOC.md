---
title: Exercises and Labs MOC
aliases:
 - Exercises MOC
 - Labs MOC
 - Cross-Cutting Exercises
tags:
 - exercises
 - labs
 - meta
 - moc
course_level: intermediate
difficulty: intermediate
estimated_time: "8–12 hours across all labs"
status: complete
prerequisites:
 - "[[03-FastAPI-Core/Application-and-Lifespan]]"
 - "[[03-FastAPI-Core/Dependency-Injection]]"
 - "[[07-SQLAlchemy/05-Session-and-Transaction-Management]]"
 - "[[07-SQLAlchemy/07-Async-SQLAlchemy]]"
related_lessons:
 - "[[20-Exercises-and-Labs/Troubleshooting-Index]]"
 - "[[20-Exercises-and-Labs/Debugging-Labs]]"
 - "[[19-Interview-Preparation/00-Interview-MOC]]"
 - "[[22-Diagrams/00-Diagrams-MOC]]"
---

# Exercises and Labs MOC

*The section for **cross-cutting** labs and the flat failure-mode index. Per-lesson exercises still live at the end of each lesson; this folder is for drills that don't fit cleanly in one lesson.*

**You made it here.**

This folder is where the vault stops being a textbook and starts being a workshop. The two files here — [[Troubleshooting-Index]] and [[Debugging-Labs]] — are designed to be done with a terminal open. Read the symptom, run the diagnosis command, write the fix. Don't just skim. The interview and the on-call shift will both ask you to do this for real; this is the practice.


#exercises #labs #moc

## What's in this section

Two files, two different formats:

- [[Troubleshooting-Index]] — a flat index of common failure modes. Each entry has a **symptom**, **likely cause**, **diagnosis command**, and **fix**. Use it as a reference: when something breaks, scan the symptom column, find the match, run the diagnosis command.
- [[Debugging-Labs]] — six hands-on labs. Each presents a broken FastAPI/SQLAlchemy code snippet. Find the bug, explain it, write the fix. The labs are in roughly increasing order of difficulty.

**Per-lesson exercises also exist**

Every substantial lesson in this vault ends with a "Common Mistakes" or "Review Questions" section. Those drills are scoped to that lesson's topic. This folder is for cross-cutting failure modes that span lessons — the N+1 that combines ORM choices and serializer choices; the migration-ordering bug that combines Alembic and the deploy pipeline.


**Should I do the labs before or after the interview questions?**

After. The interview questions ([[19-Interview-Preparation/00-Interview-MOC]]) test recall; the labs test recognition. Recognition is easier than recall — you spot the bug because the code looks wrong, not because you remembered the rule. Do the labs first as a warm-up (easier), then the interview questions (harder). The labs also cross-link to the canonical lessons, so you'll be reminded of the underlying principle when you see the bug.


## How to use the troubleshooting index

When something breaks:

1. **Scan the symptom column** in [[Troubleshooting-Index]]. Match the most distinctive word from your error message ("MissingGreenlet", "FATAL: too many clients", "asyncio.run cannot be called").
2. **Run the diagnosis command** from the matched entry. Confirm the likely cause.
3. **Apply the fix.** If the diagnosis rules out the likely cause, move to the next-most-likely entry by symptom similarity.
4. **Follow the canonical link** to the underlying lesson. The fix is the patch; the lesson is the prevention.

**Tip — The link-checker script**

[[Troubleshooting-Index]] also includes a `vault-link-checker.sh` script that catches broken wikilinks in the vault. Add it to your CI to catch broken cross-references before they confuse a reader.


## How to use the debugging labs

For each lab in [[Debugging-Labs]]:

1. **Read the code carefully.** All of it. Note any oddities — a `def` where you expected `async def`, an `except Exception: pass`, a missing `selectinload`, a default mutable argument.
2. **Identify the symptom.** What error or wrong behavior would this code produce in production? Don't read the answer yet.
3. **Form a hypothesis.** Write it down — one sentence — before reading the answer. If you skip this step, you are not practicing; you are reading.
4. **Write the fix.** Type the corrected code. Do not just describe it.
5. **Read the explanation.** If your fix differs from the model fix, ask: is yours equivalent, better, or worse? Either way, you should be able to justify it.

**Danger — The most common lab mistake**

Reading the answer before forming a hypothesis. The lab is not a tutorial — it's a quiz. If you read the answer first, you've trained recognition, not recall. Recognition is easier and far less useful in interviews and on-call shifts. Force yourself to write a hypothesis first.


## The lab-to-lesson mapping

Each lab violates a principle taught in a canonical lesson. After you complete a lab, re-read the canonical lesson to refresh the principle:

| Lab | What's broken | Canonical lesson |
|---|---|---|
| 1 | N+1 in a serializer | [[07-SQLAlchemy/04-Relationships-and-Loading-Strategies]] |
| 2 | Sync DB call inside `async def` | [[07-SQLAlchemy/07-Async-SQLAlchemy]] |
| 3 | `except Exception: pass` swallowing `IntegrityError` | [[03-FastAPI-Core/Exception-Handlers]] and [[07-SQLAlchemy/05-Session-and-Transaction-Management]] |
| 4 | Mutable default factory misuse in Pydantic | [[04-Pydantic/Fields-Annotated-Reusable-Annotations]] |
| 5 | Migration breaks running app (renamed column) | [[09-Alembic-Migrations/Deploying-Migrations-in-Production]] |
| 6 | Pool-exhaustion scenario | [[07-SQLAlchemy/02-Engines-Connections-Pools]] |

## Cross-cutting drills beyond this section

Exercises are also woven through the rest of the vault:

- Each [[03-FastAPI-Core]] lesson ends with a "Common Mistakes" section — these are the per-lesson labs.
- [[19-Interview-Preparation/Production-Incidents-Debugging]] is six incident narratives; treat them as advanced labs — narrate the diagnosis out loud.
- [[22-Diagrams]] — practice drawing each diagram on a whiteboard. If you can reproduce [[22-Diagrams/Request-Lifecycle-Diagram]] from memory, you have internalized the architecture.
- [[18-Portfolio-Projects]] — full projects. The capstone exercises.

## Files in this section

- [[Troubleshooting-Index]] — 24 entries; flat index of common failure modes.
- [[Debugging-Labs]] — 6 labs; increasing difficulty.

## Related sections

- [[19-Interview-Preparation/00-Interview-MOC]] — the question bank. The labs drill the same skills.
- [[22-Diagrams/00-Diagrams-MOC]] — canonical diagrams. Many labs violate one of the diagrams; the diagram clarifies the violation.
- [[00-Start-Here/Concept-Registry]] — the canonical lessons. The labs cross-reference them.

## Sources

- The troubleshooting-entry style is the vault's in-house common-errors format, extended for FastAPI / SQLAlchemy / asyncio / Docker / CI as taught across Sections 03, 07, 10, 11, 12, 16 of this vault.
- Verified versions from [[21-Reference-Library/Source-Register]] (last_verified: 2026-10-19).

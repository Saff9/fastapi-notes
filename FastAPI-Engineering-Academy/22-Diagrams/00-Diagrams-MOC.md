---
title: Diagrams MOC
aliases:
 - Diagrams MOC
 - Canonical Diagrams
 - Mermaid Diagrams
tags:
 - diagrams
 - meta
 - moc
course_level: intermediate
difficulty: intermediate
estimated_time: "30 minutes to read; 2 hours to internalize"
status: complete
prerequisites:
 - "[[03-FastAPI-Core/Application-and-Lifespan]]"
 - "[[03-FastAPI-Core/Middleware-and-Request-Order]]"
 - "[[07-SQLAlchemy/05-Session-and-Transaction-Management]]"
 - "[[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh]]"
 - "[[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]]"
related_lessons:
 - "[[22-Diagrams/Request-Lifecycle-Diagram]]"
 - "[[22-Diagrams/SQLAlchemy-Session-Flow]]"
 - "[[22-Diagrams/Deployment-Topology]]"
 - "[[22-Diagrams/Auth-Flow-Diagram]]"
---

# Diagrams MOC

*This folder holds the **canonical** Mermaid diagrams for the vault. Lessons that need a diagram embed these — either by including the Mermaid block directly, or by linking here.*

**You made it here.**

Diagrams are the interview shortcut. A senior interviewer will say "draw the request lifecycle on the whiteboard" and watch you struggle — not because the answer is hard, but because most candidates have read the words but never drawn the picture. If you can reproduce [[Request-Lifecycle-Diagram]] and [[SQLAlchemy-Session-Flow]] from memory on a whiteboard, you have internalized the architecture. If you cannot, you have only recognized it. Practice drawing these. The diagrams here are the canonical versions; everything else in the vault links back to them.


#diagrams #meta #moc

## Files in this section

- [[Request-Lifecycle-Diagram]] — the canonical sequence of a request from client through to the database and back.
- [[SQLAlchemy-Session-Flow]] — the canonical session lifecycle: creation, add, autoflush, commit, expiration, detachment.
- [[Deployment-Topology]] — the canonical production topology: CDN → load balancer → app containers → Redis → Postgres → object storage → CI/CD.
- [[Auth-Flow-Diagram]] — login, access token, API call, introspection, refresh rotation, logout.

## How to use these diagrams

### In a lesson

When a lesson needs to show one of these flows, **link here** rather than re-drawing the diagram. The canonical version stays correct; copies drift.

```markdown
See [[22-Diagrams/Request-Lifecycle-Diagram]] for the canonical request lifecycle.
```

If a lesson needs a *variant* of a diagram (e.g. a simplified version that hides some hops), draw the variant inline and link to the canonical version as the source of truth:

```markdown
The simplified lifecycle below omits the CDN and TLS hops; see
[[22-Diagrams/Request-Lifecycle-Diagram]] for the full version.

\`\`\`mermaid
sequenceDiagram
 Client->>Uvicorn: HTTP request
 Uvicorn-->>Client: HTTP response
\`\`\`
```

**Tip — The "no copies" rule**

Copies drift. Lesson A copies the diagram, then lesson B copies lesson A's copy with a tweak, then someone fixes a typo in the canonical diagram and the copies don't get updated. Link, don't copy. If you must inline a variant, link to the canonical version in the surrounding prose so the reader knows where the source of truth lives.


### On a whiteboard

These diagrams are also the diagrams you should be able to draw on a whiteboard in an interview. Practice drawing them from memory. If you can reproduce the request lifecycle and the SQLAlchemy session flow on a whiteboard without notes, you have internalized the architecture.

**Interview rehearsal prompt**

Close this file. Take a piece of paper. Set a 5-minute timer. Draw the request lifecycle from memory. When the timer ends, open [[Request-Lifecycle-Diagram]] and compare. Note the missing participants. Repeat tomorrow. The goal is to be able to draw it cold — not "I'll recognize it when I see it."


### Rendering

The diagrams are written in [Mermaid](https://mermaid.js.org/) syntax. They render in:

- Obsidian (native).
- GitHub (native in markdown).
- VS Code with the Mermaid extension.
- The Next.js vault browser (see `README.md`).

If a diagram does not render, check the syntax. The most common Mermaid mistakes are:

**Warning — Common Mermaid syntax pitfalls**

- Using `[brackets]` inside a node label — Mermaid interprets brackets as a node shape. Use `"quoted text"` or `(...)` instead.
- Special characters like `:` and `;` in node labels — Mermaid interprets these as syntax. Quote the label.
- Reusing a node ID with a different label — Mermaid keeps the first label.
- Missing `end` for subgraphs or `end` for `flowchart` blocks.
- `<br/>` for line breaks in node labels — `\\n` does not work in older Mermaid; `<br/>` is the safe choice.


Every diagram in this folder has been checked against the Mermaid live editor for syntactic validity.

## Diagram conventions

The diagrams in this folder follow these conventions for consistency:

**Conventions (not Mermaid rules — vault rules)**

- **Sequence diagrams** (`sequenceDiagram`) for temporal flows — request lifecycle, auth flow, session flow. The arrows represent time and message direction.
- **Flowcharts** (`flowchart TD` or `flowchart TB`) for architectural topology — deployment. The boxes represent components and their relationships.
- **Participants** in sequence diagrams are named in `TitleCase` with short IDs (`Client`, `LB`, `Uvicorn`, `Starlette`, `FastAPI`, `MW`, `Dep`, `Svc`, `Session`, `DB`). IDs are short for compact arrow labels; the title shows the full name.
- **Arrows**: `->>` for synchronous requests (left to right), `-->>` for responses (right to left), `--x` for failures. Dotted arrows (`-.->`) for asynchronous or background flows.
- **Notes** (`Note over X,Y:`) annotate the *why* of a hop, not the *what*. The reader already sees the what in the arrow.
- **Subgraphs** in flowcharts group components that share a failure domain or a deploy boundary (e.g., the application tier, the data tier).
- **Color coding** via `classDef`:
- Green (`fill:#e8f5e9`) — your application code / FastAPI.
- Blue (`fill:#e1f5ff`) — external clients / users.
- Yellow (`fill:#fff3e0` or `fill:#fff9c4`) — edge / CI-CD.
- Pink (`fill:#fce4ec`) — data stores.
- Purple (`fill:#f3e5f5`) — object storage.
- Red (`fill:#ffebee`) — failure / short-circuit.
- **Autonumbering** (`autonumber` at the top of the diagram) for sequence diagrams — so prose references like "step 5" map to arrow numbers.


New diagrams should follow them.

## Cross-cutting practice

After reading each diagram, narrate it out loud. The interview version is "draw and narrate the request lifecycle in 3 minutes." Practice:

1. [[Request-Lifecycle-Diagram]] — 13 hops, DNS to DB to response.
2. [[SQLAlchemy-Session-Flow]] — 8 phases, sessionmaker to detachment.
3. [[Deployment-Topology]] — 6 tiers, CDN to CI/CD.
4. [[Auth-Flow-Diagram]] — 4 phases, login to logout.

If you can narrate all four in under 15 minutes total, you are ready for any architecture interview question.

## Related sections

- [[00-Start-Here/Concept-Registry]] — many concepts referenced in the diagrams have canonical lessons here.
- [[19-Interview-Preparation/00-Interview-MOC]] — interview questions frequently reference these diagrams.
- [[20-Exercises-and-Labs/Debugging-Labs]] — each lab violates one of these flows; the diagram clarifies the violation.
- [[23-Templates/Lesson-Template]] — the template's `## Execution Trace` section is where lessons embed or link to these diagrams.

## Sources

- Mermaid documentation — https://mermaid.js.org/ — 2026-10-15 — sequence diagrams, flowcharts, syntax.
- The diagram conventions are the vault's in-house style, extended for FastAPI / SQLAlchemy / asyncio / OAuth2 as taught across Sections 03, 07, 11, 16 of this vault.

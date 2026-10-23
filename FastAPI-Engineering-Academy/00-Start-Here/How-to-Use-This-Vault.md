---
title: How to Use This Vault
aliases:
 - How to Use
 - Vault Navigation
tags:
 - start-here
 - meta
status: complete
---

# How to Use This Vault

This vault is designed to work in **Obsidian** and as plain **Markdown on GitHub** (or in the companion Vault Browser web app). You do not need any community plugins.

## Files and links

- A **note** is a single Markdown file. Filenames are descriptive (e.g. `07-SQLAlchemy/03-Declarative-Base-and-Mapped.md`).
- An **Obsidian wikilink** is `[[Note-Name]]` or `[[folder/Note-Name|Display text]]`. In Obsidian, the link resolves to the note. On GitHub, the wikilink text maps to a file path you can navigate to manually. In the Vault Browser, links are resolved server-side.
- **External links** are standard Markdown `[text](https://...)`.
- **Filenames use kebab-case** and start with a number indicating order inside a folder (e.g. `03-Dependency-Injection.md`). Files starting with `00-` are Maps of Content (MOCs) for that section.

## Frontmatter

Substantial lessons begin with YAML frontmatter:

```yaml
---
title: "SQLAlchemy DeclarativeBase Explained"
aliases:
 - DeclarativeBase
tags:
 - sqlalchemy
 - orm
course_level: intermediate
status: complete
prerequisites:
 - "[[01-Python-Foundations/Type-Hints-and-Annotations]]"
first_taught_in: "07-SQLAlchemy/03-Declarative-Base-and-Mapped"
---
```

The fields:

- `title`: human-readable title.
- `aliases`: alternate names so wikilinks using them still resolve.
- `tags`: lowercase, hyphenated, used sparingly.
- `course_level`: `beginner`, `intermediate`, `advanced`.
- `status`: `complete`, `stub`, `draft`. **A stub is flagged at the top of the file with `> Status: stub`.**
- `prerequisites`: wikilinks to lessons you should have completed first.
- `first_taught_in`: the canonical file path for concepts that get reused later. Cross-references use this.

## Lesson structure

Substantial lessons follow the [[23-Templates/Lesson-Template|lesson template]] spine. The 14 sections, in the order every rewritten lesson uses them, are:

1. **Learning Objectives** — what you will be able to do after finishing the lesson.
2. **Prerequisites** — verified versions and the prior lessons that load this one.
3. **The Problem** — the real-world friction that motivates the code, framed before any code is shown.
4. **The Code** — the complete, runnable file (or diff) you will dissect.
5. **Line-by-Line Deep Dive** — every meaningful code line gets its own subsection with *what it does*, *why it is there*, and *what Python / FastAPI / Starlette / Pydantic / SQLAlchemy does internally*.
6. **Execution Trace** — what the terminal actually prints when you run the code, annotated step by step.
7. **Common Mistakes** — the production-incident-shaped bugs (WRONG code → symptom → why → fix).
8. **Engineering Trade-Offs** — the alternative approaches we considered and why we picked this one.
9. **Exercises** — at least three graded by difficulty, starting with a 20-minute-rule reminder.
10. **Verification** — the exact command and expected output to prove the lesson landed.
11. **Previously Learned Here** — back-links to the canonical lessons we are reusing, with one-line refreshers.
12. **What's Next** — a teaser of the next lesson and how it builds on this one.
13. **Sources** — every external citation with the URL, the version, and the accessed date.
14. **What We Learned** — the recap, the mental model to walk away with, and a closing note from your teacher.

Not every section is mandatory for every note. Reference sheets, glossary entries, and templates use shorter formats.

## Maps of Content (MOCs)

Every major section has a `00-*-MOC.md` file that lists the section's lessons in prerequisite order. Start a section by reading its MOC:

- [[01-Python-Foundations/00-Python-MOC]]
- [[02-Web-and-HTTP/00-Web-MOC]]
- [[02b-Backend-Foundations/00-Backend-Foundations-MOC]]
- [[03-FastAPI-Core/00-FastAPI-MOC]]
- [[04-Pydantic/00-Pydantic-MOC]]
- [[05-Project-Architecture/00-Architecture-MOC]]
- [[06-SQL-Fundamentals/00-SQL-MOC]]
- [[07-SQLAlchemy/00-SQLAlchemy-MOC]]
- [[08-PostgreSQL/00-PostgreSQL-MOC]]
- [[09-Alembic-Migrations/00-Alembic-MOC]]
- [[10-Async-Python/00-Async-MOC]]
- [[11-Authentication-and-Security/00-Security-MOC]]
- [[12-Testing-and-Quality/00-Testing-MOC]]
- [[13-Performance-and-Observability/00-Observability-MOC]]
- [[14-Caching-and-Background-Processing/00-Caching-MOC]]
- [[15-External-Integrations/00-Integrations-MOC]]
- [[16-Deployment-and-DevOps/00-Deployment-MOC]]
- [[17-Advanced-Architecture/00-Advanced-Architecture-MOC]]
- [[18-Portfolio-Projects/00-Projects-MOC]]
- [[19-Interview-Preparation/00-Interview-MOC]]
- [[20-Exercises-and-Labs/00-Exercises-MOC]]
- [[21-Reference-Library/00-Reference-MOC]]
- [[22-Diagrams/00-Diagrams-MOC]]
- [[23-Templates/00-Templates-MOC]]

## The three cross-cutting indexes

These three files are your lookup tables. Bookmark them.

- [[Concept-Registry]] — for every recurring concept: where it was first taught and where it is reused.
- [[Curriculum-Index]] — the flat table of contents.
- [[Glossary]] — definitions with links back to canonical lessons.

## Diagrams

Diagrams are written as **Mermaid** code blocks directly inside lessons, so they render in Obsidian, on GitHub, and in the Vault Browser. A standalone collection is in [[22-Diagrams]] so you can study the canonical versions separately.

Every diagram clarifies a relationship, sequence, boundary, or failure mode. None are decoration.

## Status convention

Every lesson states its status in frontmatter. If a lesson is a stub, the file also opens with a quote block:

> Status: stub — this lesson is an outline. Content is being added.

If you find a stub, you can still read the outline to understand what it will cover, but do not treat it as authoritative.

## A reading heuristic

When a chapter reuses a concept you have seen before, it will say something like:

> Previously learned in: [[03-Declarative-Base-and-Mapped|DeclarativeBase and metadata]]. We introduced the base class there because every mapped model needs a shared registry and metadata collection. In this chapter, we use that foundation to explain migrations.

When you see this, do not re-read the canonical lesson unless you actually need a refresher. Trust the dependency graph and continue.

## What to do when something seems wrong

- If a wikilink is broken, see [[20-Exercises-and-Labs/Troubleshooting-Index]] for the link-checking script and known issues.
- If code does not run, see the same troubleshooting index for the most common failure modes (interpreter mismatches, missing `__init__.py`, wrong project root, etc.).
- If a version claim seems wrong, cross-reference [[21-Reference-Library/Source-Register]] for the date accessed and the source URL.

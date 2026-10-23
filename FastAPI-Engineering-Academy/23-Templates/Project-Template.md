---
title: Project Template
aliases:
 - Project Template
tags:
 - template
 - project
status: complete
---

# Project Template

Every portfolio project in [[18-Portfolio-Projects]] must include all of these sections. Use this template as the starting outline.

```markdown
---
title: "<Project Name>"
aliases:
 - <short name>
tags:
 - project
 - <domain>
status: complete | in-progress | stub
estimated_effort: <hours or sessions>
---

# <Project Name>

## Problem Statement
The concrete user pain and the business context.

## Target Users
Who uses it. Roles, permissions, scale.

## Requirements and Non-Goals
- **In scope:** bullet list.
- **Explicit non-goals:** bullet list of things we deliberately will not build.

## Architecture Diagram
\`\`\`mermaid
flowchart ...
\`\`\`

## ER Diagram
\`\`\`mermaid
erDiagram
 ...
\`\`\`

## Sequence Diagrams
For each important workflow.

## API Specification
Table or OpenAPI summary of endpoints.

## Folder Structure
The actual layout, with one-line descriptions.

## Database Design
Tables, constraints, indexes, naming conventions.

## Security Model
Auth, authorization, secrets, audit.

## Milestones
Ordered, with completion criteria.

## Implementation Chapters
Links to the implementation lessons.

## Complete Source Code
Pointer to the runnable folder, or inline code blocks per file.

## Automated Tests
What is covered and how to run them.

## Docker and Environment
The `Dockerfile`, `compose.yaml`, and `.env.example`.

## Migration History
The ordered Alembic revisions.

## Error Handling
Mapping of domain errors to HTTP responses.

## Performance Considerations
Bottlenecks, indexes, caches.

## Deployment Guide
Steps for a real platform.

## README
The project README.

## Resume Bullet Examples
Three bullets a recruiter can read.

## Interview Discussion Questions
Things you should be able to defend.

## Future Enhancements
Realistic next steps.

## What We Learned
A bullet recap of the engineering lessons the project forced:
- Past-tense achievement — one-sentence insight.
- Past-tense achievement — one-sentence insight.
- Past-tense achievement — one-sentence insight.

Close with a one-sentence "mental model to walk away with" — the kind of principle that survives project turnover.
```

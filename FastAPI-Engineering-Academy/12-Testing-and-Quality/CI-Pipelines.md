---
title: "Lesson 05: CI Pipelines – From Push to Green Check"
aliases:
 - CI Pipelines
 - GitHub Actions
 - CI
 - Service Containers
 - uv sync
 - workflow
 - matrix
tags:
 - ci
 - github-actions
 - devops
 - uv
 - testing
 - lesson
course_level: intermediate
status: complete
difficulty: intermediate
estimated_time: "75–105 minutes"
prerequisites:
 - "[[12-Testing-and-Quality/Testing-FastAPI-Endpoints]]"
 - "[[01-Python-Foundations/uv-Tooling-Workflows]]"
related_lessons:
 - "[[16-Deployment-and-DevOps/GitHub-Actions-CI]]"
 - "[[12-Testing-and-Quality/Test-Pyramid-and-Fixtures]]"
 - "[[12-Testing-and-Quality/Async-Testing]]"
 - "[[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]]"
---

# Lesson 05: CI Pipelines – From Push to Green Check

*Where `Boardly` gets the `.github/workflows/ci.yml` that turns "I pushed, did anything break?" into a green check on GitHub — and where you learn to read every line of a 200-line YAML file without your eyes glazing over.*

**This is the lesson where your code stops being "works on my laptop".**

Every PR you ship from now on will run lint, types, unit tests, integration tests, build, and a security audit — automatically, on every push, on a matrix of Python versions. The green check on GitHub is not a vanity badge. It is a contract with your future self: "this code passed the floor; it is not obviously broken." Take your time. Read every line of the YAML. Watch one job fail. Fix it. Watch it pass. **This is how you learn.**


#ci #github-actions #devops

## Learning Objectives

By the end of this lesson you will be able to:

1. **Read and write a `.github/workflows/ci.yml` file** line by line, and explain each key's semantics.
2. **Run tests on a matrix of Python versions** (3.12, 3.13) and explain why the matrix triples wall-clock but pays for itself in regression-catching.
3. **Provision PostgreSQL and Redis as GitHub Actions service containers** with healthchecks, and explain why the healthcheck is non-negotiable.
4. **Cache `uv`'s downloads** so a no-op commit re-runs in seconds, not minutes.
5. **Run `uv sync --frozen`** in CI and explain why `--frozen` is the lockfile-as-source-of-truth enforcement.
6. **Order the pipeline stages** — lint, type check, unit, integration, build, push — and explain why lint comes first and push comes last.
7. **Add a Mermaid diagram of the pipeline** that matches the workflow file, so reviewers can read the shape before the YAML.
8. **Add the CI badge to `README.md`** so the green check is visible from the project root.
9. **Read the eight classic CI mistakes** — no `--frozen`, no healthcheck, lint and tests in one job, matrix on integration, pushing on every PR, over-caching, missing `permissions:`, no `concurrency:` — and fix them before they cost you a Friday night.

## Prerequisites

Before starting, you need:

- **Python 3.12, uv 0.13.1, ruff 0.7.x, pytest 8.x, mypy (latest)**, plus **FastAPI 0.148.0, SQLAlchemy 2.1.5, asyncpg, PostgreSQL 17.x, Redis 7.x** (verified Oct 2026). If you have not set up the project: see [[01-Python-Foundations/uv-Tooling-Workflows]] and [[01-Python-Foundations/Project-Layout-and-Imports]].
- **The endpoint-testing lesson** — [[12-Testing-and-Quality/Testing-FastAPI-Endpoints]]. The CI runs the tests you wrote there; you should know what `pytest -m "integration"` filters.
- **The `uv` workflow** — [[01-Python-Foundations/uv-Tooling-Workflows]]. Every `uv` command in this lesson (`uv sync --frozen`, `uv run pytest`, `uv run ruff`) is from there.
- **A GitHub repository** with `Boardly` pushed to it. If you do not have one: `git init && git remote add origin git@github.com:you/boardly.git && git push -u origin main`.
- **About 90 minutes of focused time.** The YAML is ~200 lines; the explanation is long. Read slowly.

**The most common gap: GitHub Actions YAML.**

If you have never written a `.github/workflows/*.yml` file, the indentation and the `name:`, `runs-on:`, `steps:` hierarchy can feel arbitrary. It is not — the hierarchy is `workflow → job → step`, each more nested than the last. The official docs (<https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions>) are the reference; this lesson is the line-by-line reading of one real workflow. Do not skip the prerequisite `uv` lesson — `uv` is the project manager, and CI's whole job is to run `uv` against a clean checkout.


## The Problem

You wrote the code. You wrote the tests. You ran the tests locally — green. You pushed. Your teammate pulls, runs `uv sync`, runs `uv run pytest` — and 14 tests fail. What happened?

Three things, any combination of which can be the cause:

1. **Uncommitted `uv.lock`** — you bumped `pydantic` from 2.9 to 2.10 locally, ran `uv sync`, the lockfile updated on disk, but you forgot to `git add uv.lock`. The teammate's `uv sync` installed the old 2.9. Their tests pass against 2.9, yours against 2.10; one of you is wrong.
2. **Local Python 3.12, teammate's Python 3.13** — you wrote `def f(x: int | None = None)`, your teammate's Python is 3.10, the union syntax errors at import. (Or: a stdlib function's signature changed between 3.12 and 3.13; one version's `inspect.signature` returns what you expect, the other does not.)
3. **Local PostgreSQL 17, teammate's 16** — a query that uses `JSONB_IS_OBJECT` (new in 17) passes locally and fails on the teammate. Or vice versa — the teammate has a feature you do not.

CI is the answer to "it works on my laptop". A CI pipeline runs your code on a *clean, reproducible, versioned* environment, on every push, on a matrix of versions. If it is green, the contract is: this code passes the floor; it is not obviously broken. If it is red, you know before your teammate does — and before any user does.

Why does CI run a matrix (Python 3.12 + 3.13) when production runs one version? Production runs one Python version — yes. But the code has to *survive the upgrade window*. When Python 3.14 ships and your team upgrades, you do not want to discover at deploy time that `inspect.signature` returns something subtly different in 3.14, or that a stdlib function's default argument changed. The matrix catches that *before* the upgrade — 3.12 green today, 3.13 green today, 3.14 added to the matrix and red, fix the regression on your schedule, not on Python's release schedule. The matrix is the cost of "we will be able to upgrade". Without it, you upgrade under deadline pressure and discover the breakage in prod.

**Note — Historical context — Jenkins, Travis, and GitHub Actions.**

Before GitHub Actions (2019), the dominant models were self-hosted Jenkins (powerful, expensive to maintain) and Travis CI (free for open source, slow, YAML-heavy). GitHub Actions won because (a) it is built into the platform (no separate signup), (b) the runner marketplace lets you share workflows as code, and (c) the matrix and service-container features are first-class. The model is the same as Jenkins — a YAML file describes jobs, each job runs on a runner, each runner is a clean VM. The difference is the runners are GitHub's, the YAML lives in `.github/workflows/`, and the green check appears on GitHub itself. As of Oct 2026, the default runner is `ubuntu-24.04` (the GitHub-hosted label is `ubuntu-latest` until December 2026, then `ubuntu-24.04` becomes the alias target).


## The Code

Here is the complete `.github/workflows/ci.yml` you will write, plus the badge for `README.md`. Save it mentally — every Python CI workflow you ever write is a variation of this skeleton.

```yaml
# .github/workflows/ci.yml
name: CI

on:
 push:
 branches: [main]
 tags: ["v*"]
 pull_request:

concurrency:
 group: ${{ github.workflow }}-${{ github.ref }}
 cancel-in-progress: true

env:
 PYTHONUNBUFFERED: "1"
 UV_FROZEN: "1"
 UV_NO_SYNC: "1"

jobs:
 lint:
 name: Lint (ruff)
 runs-on: ubuntu-24.04
 steps:
 - uses: actions/checkout@v4
 - uses: astral-sh/setup-uv@v5
 with:
 enable-cache: true
 cache-dependency-glob: uv.lock
 - run: uv sync --frozen
 - run: uv run ruff check .
 - run: uv run ruff format --check .

 typecheck:
 name: Type check (mypy)
 runs-on: ubuntu-24.04
 steps:
 - uses: actions/checkout@v4
 - uses: astral-sh/setup-uv@v5
 with:
 enable-cache: true
 cache-dependency-glob: uv.lock
 - run: uv sync --frozen
 - run: uv run mypy src/boardly

 unit:
 name: Unit tests (Python ${{ matrix.python }})
 needs: lint
 runs-on: ubuntu-24.04
 strategy:
 fail-fast: false
 matrix:
 python: ["3.12", "3.13"]
 steps:
 - uses: actions/checkout@v4
 - uses: astral-sh/setup-uv@v5
 with:
 enable-cache: true
 cache-dependency-glob: uv.lock
 python-version: ${{ matrix.python }}
 - run: uv sync --frozen
 - run: uv run pytest -m "not integration and not e2e" --cov=src/boardly --cov-report=xml
 - uses: actions/upload-artifact@v4
 if: always()
 with:
 name: coverage-${{ matrix.python }}
 path: coverage.xml

 integration:
 name: Integration tests (Python ${{ matrix.python }})
 needs: typecheck
 runs-on: ubuntu-24.04
 strategy:
 fail-fast: false
 matrix:
 python: ["3.12", "3.13"]
 services:
 postgres:
 image: postgres:17
 env:
 POSTGRES_USER: test
 POSTGRES_PASSWORD: test
 POSTGRES_DB: boardly_test
 ports: ["5432:5432"]
 options: >-
 --health-cmd "pg_isready -U test"
 --health-interval 5s
 --health-timeout 5s
 --health-retries 10
 redis:
 image: redis:7
 ports: ["6379:6379"]
 options: >-
 --health-cmd "redis-cli ping"
 --health-interval 5s
 --health-timeout 5s
 --health-retries 10
 env:
 DATABASE_URL: postgresql+asyncpg://test:test@localhost:5432/boardly_test
 REDIS_URL: redis://localhost:6379/0
 JWT_SECRET: ci-secret-32-bytes-do-not-use-in-prod!
 steps:
 - uses: actions/checkout@v4
 - uses: astral-sh/setup-uv@v5
 with:
 enable-cache: true
 cache-dependency-glob: uv.lock
 python-version: ${{ matrix.python }}
 - run: uv sync --frozen
 - run: uv run alembic upgrade head
 - run: uv run pytest -m "integration" --maxfail=3
 - run: uv run pytest tests/test_migrations.py -v

 build:
 name: Build Docker image
 needs: [unit, integration]
 if: github.event_name == 'push' && github.ref == 'refs/heads/main'
 runs-on: ubuntu-24.04
 permissions:
 contents: read
 packages: write
 steps:
 - uses: actions/checkout@v4
 - uses: docker/setup-buildx-action@v3
 - uses: docker/login-action@v3
 with:
 registry: ghcr.io
 username: ${{ github.actor }}
 password: ${{ secrets.GITHUB_TOKEN }}
 - uses: docker/build-push-action@v6
 with:
 context: .
 push: true
 tags: |
 ghcr.io/${{ github.repository }}:${{ github.sha }}
 ghcr.io/${{ github.repository }}:latest
 cache-from: type=gha
 cache-to: type=gha,mode=max

 security:
 name: Dependency audit
 runs-on: ubuntu-24.04
 steps:
 - uses: actions/checkout@v4
 - uses: astral-sh/setup-uv@v5
 with:
 enable-cache: true
 cache-dependency-glob: uv.lock
 - run: uv sync --frozen
 - run: uv run pip-audit --strict
```

```markdown
<!-- README.md — add this near the top -->
[![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/<repo>/actions/workflows/ci.yml)
```

That is the whole workflow: ~200 lines of YAML plus one badge line. Push it. Watch one job fail. Fix it. Watch the green check. That is the loop. We will explain every line next — not just *what it does* but *what GitHub Actions, `uv`, and the service containers do internally* when those lines run.

## Line-by-Line Deep Dive

This section is the heart of the lesson. Read it twice. Do not skip.

### Line 1: The comment and the file name

```yaml
# .github/workflows/ci.yml
```

**What it does:** A comment naming the file path. The path itself is the contract — GitHub Actions discovers workflows *only* in `.github/workflows/`. Any other directory is ignored.

**Why this matters:** a common mistake is to put the file in `.github/workflow/` (singular) or `.github/actions/ci.yml`. GitHub will not discover it. The path must be exactly `.github/workflows/<name>.yml` (or `.yaml`). The file name is free-form — `ci.yml`, `test.yml`, `release.yml` are all common. We use `ci.yml` because the badge URL references the workflow file by name.

**`.yml` vs `.yaml`.**

Both are valid. GitHub does not care. The convention in the GitHub Actions ecosystem is `.yml` (shorter); the wider YAML community prefers `.yaml` (more pronounceable). Pick one and be consistent in your repo. We use `.yml` here to match the badge URL format that most CI-as-code projects use.


### Line 2: `name: CI`

```yaml
name: CI
```

**What it does:** Names the workflow. The name appears on the Actions tab on GitHub, in the workflow's badge, and in the `github.workflow` context variable (which we use in `concurrency:` below).

**Why the name matters:** the badge alt text, the run list on GitHub, and the `concurrency.group` string all reference this name. Rename the workflow and the concurrency group changes — which means in-flight runs of the old name are not cancelled. Pick a stable, short, human-readable name.

**Tip — Workflow names and concurrency.**

`concurrency.group: ${{ github.workflow }}-${{ github.ref }}` uses the workflow name as part of the group key. If you rename the workflow, the group changes — and a push of 5 commits will run 5 pipelines (one per commit) instead of cancelling the old ones. Stable name, stable concurrency group.


### Lines 4–7: `on:` triggers

```yaml
on:
 push:
 branches: [main]
 tags: ["v*"]
 pull_request:
```

**What it does:** Declares when the workflow runs. On `push` to `main` (every commit to the default branch). On `push` of a tag matching `v*` (releases). On every `pull_request` (any PR, any target branch).

**Why `branches: [main]` for push:** without it, every push to *any* branch triggers CI. For a team with many feature branches, this doubles the runs. The convention: run on `main` and tags (release); run on PRs (pre-merge); let feature-branch pushes happen via the PR (the PR is what triggers CI, not the underlying branch push).

**Why `tags: ["v*"]`:** tags matching `v*` are release tags (`v0.1.0`, `v1.2.3`). The build job (below) gates on `github.ref == 'refs/heads/main'`; but a separate release workflow (Lesson 16) gates on `github.ref_type == 'tag'`. Listing tags here lets the release workflow run on tag pushes — but this workflow's `build` job still gates on `main`. The separation is: CI runs on tag pushes for the audit/lint/type tests, but the image is not rebuilt on tags in this workflow.

**Why `pull_request:` is bare (no filter):** without a filter, every PR — opened, synchronized, reopened — triggers CI. If you want to filter (e.g. only `opened` and `synchronize`), use `types: [opened, synchronize]`. The bare form runs on the common case (PR opened or pushed to) — which is what most teams want.

**Example — The four trigger types.**

| Trigger | When it fires | Use for |
|---|---|---|
| `push` | every commit to a branch or tag | default-branch CI, releases |
| `pull_request` | PR opened, synced, reopened | pre-merge CI |
| `schedule` | cron | nightly e2e, dependabot |
| `workflow_dispatch` | manual "Run workflow" button | ad-hoc, debugging |

Combining them in one `on:` block is fine. The workflow runs on *any* of the listed triggers.


### Lines 9–11: `concurrency:`

```yaml
concurrency:
 group: ${{ github.workflow }}-${{ github.ref }}
 cancel-in-progress: true
```

**What it does:** Declares a concurrency group. Runs in the same group are cancelled if a newer one starts. The group key is `${workflow name}-${branch or tag}`.

**Why this matters:** without it, a push of 5 commits to `main` runs 5 pipelines, one per commit, in parallel. The first 4 are obsolete by the time they finish — you only care about the latest. With `cancel-in-progress: true`, GitHub cancels the in-flight runs of the same group when a new one starts. The 5-commit push runs only the 5th pipeline (after cancelling 1-4).

**Why the group key includes `github.ref`:** the key determines "what counts as the same group". `github.workflow-CI-github.ref-refs/heads/main` is one group; `github.workflow-CI-github.ref-refs/pull/123/merge` is another. This means a push to `main` does *not* cancel a PR's run (they are different groups) — but a second push to `main` cancels the first `main` run.

**Why `cancel-in-progress: true`:** the default is `false` (do not cancel). For CI on PRs and main, you almost always want `true` — you save runner minutes and you get the latest result faster. The exception: release workflows, where you do not want to cancel a tag build mid-push.

**Warning — Do not put PRs and `main` in the same group.**

If your `concurrency.group` is `${github.workflow}-${github.ref}}` and `github.ref` is `refs/pull/123/merge` for a PR, that is a different group from `refs/heads/main`. They do not cancel each other. If you accidentally use `${github.workflow}` *without* `github.ref`, then a push to `main` cancels an in-flight PR run — which is almost never what you want. Always include `github.ref` in the group.


### Lines 13–16: `env:` (workflow-level)

```yaml
env:
 PYTHONUNBUFFERED: "1"
 UV_FROZEN: "1"
 UV_NO_SYNC: "1"
```

**What it does:** Sets three environment variables for every job and step in the workflow.

**Why each:**

- `PYTHONUNBUFFERED=1` — Python does not buffer stdout/stderr. Every `print` and every log line appears in the GitHub Actions log immediately, not in 4 KB chunks. Without it, the log appears to "hang" while Python buffers; when the buffer fills or the process exits, the log appears all at once. With it, you can watch the test output stream live.
- `UV_FROZEN=1` — equivalent to passing `--frozen` to every `uv sync` call. Means "do not re-resolve the lockfile; if it is out of date, fail". This is the lockfile-as-source-of-truth enforcement.
- `UV_NO_SYNC=1` — tells `uv run` to *not* implicitly run `uv sync` before executing the command. We will run `uv sync` explicitly, so the implicit sync is wasted work. With `UV_NO_SYNC=1`, `uv run pytest` does not first run `uv sync`; it just runs `pytest`.

**Why these are at the workflow level (not per-step):** workflow-level `env` applies to every job and step. Setting them once at the top is DRY. The alternative — `env:` on each `run:` step — is verbose and easy to forget.

**`UV_FROZEN` vs `--frozen`.**

Both work. The env var is convenient because it applies to every `uv` invocation in the workflow — `uv sync`, `uv run pytest`, `uv run mypy` — without having to add `--frozen` to each. The flag is useful when you want to override per-command (e.g. `uv sync --frozen --no-dev` for the production install in the Docker build).


### Line 18: `jobs:`

```yaml
jobs:
```

**What it does:** Begins the jobs block. Every workflow has at least one job; each job runs on its own runner (a fresh VM).

**Why jobs and not just steps:** a job is a unit of parallelism and a unit of failure. Jobs in the same workflow can run in parallel (no `needs:`) or in series (`needs: [other_job]`). A step is a unit *within* a job — steps run sequentially on the same runner, share the same filesystem, and the same `${{ }}` context.

**The hierarchy:** `workflow → job → step`. Each is more nested than the last. The runner is per-job; the shell is per-step.

### Lines 19–24: The `lint` job

```yaml
 lint:
 name: Lint (ruff)
 runs-on: ubuntu-24.04
 steps:
 - uses: actions/checkout@v4
 - uses: astral-sh/setup-uv@v5
 with:
 enable-cache: true
 cache-dependency-glob: uv.lock
 - run: uv sync --frozen
 - run: uv run ruff check .
 - run: uv run ruff format --check .
```

**What it does:** Defines a job called `lint` (the job ID; the human-readable name is `Lint (ruff)`). It runs on `ubuntu-24.04` (the latest GitHub-hosted runner, verified Oct 2026). It has four steps: checkout, setup-uv, sync, and two ruff commands.

**Why lint is its own job (not a step in `unit`):** lint is sub-second; if it is a step in the 60-second `unit` job, you wait 60 seconds for a ruff failure. By splitting, you get the ruff result in ~15 seconds. The `unit` job's `needs: lint` means it does not even start until lint is green — no wasted runner minutes.

**Why `runs-on: ubuntu-24.04`:** `ubuntu-latest` is the alias GitHub maintains; it currently (Oct 2026) points to `ubuntu-24.04` and is scheduled to switch to `ubuntu-26.04` in December 2026. Pinning to `ubuntu-24.04` makes your workflow reproducible — the alias can change without notice. The trade-off: you have to bump the pin when you want the new Ubuntu (usually annually). For a CI workflow, the pin is worth the cost.

**Why `actions/checkout@v4`:** the runner starts empty — no repository, no `git` config. `actions/checkout@v4` clones the repo (shallow by default, ~50 commits) into the runner's working directory. Without it, the next step's `uv sync --frozen` would error with "no `pyproject.toml` found".

**Why `astral-sh/setup-uv@v5`:** this is the official `uv` install action. It downloads the `uv` binary, puts it on `PATH`, and (with `enable-cache: true`) caches the `uv` store and the project's `.venv` across runs.

**Why `enable-cache: true`:** a no-op commit (no dependency changes) hits the cache and the `uv sync` is near-instant. Without the cache, every run re-downloads every wheel from PyPI — which is slow and wasteful.

**Why `cache-dependency-glob: uv.lock`:** the cache key is computed from the hash of files matching this glob. If `uv.lock` changes, the cache key changes, and the cache is invalidated. If `uv.lock` is the same, the cache is reused. This is the "cache invalidates on dependency change" mechanism.

**Why `uv sync --frozen`:** installs the project and dev dependencies from the lockfile, without re-resolving. If `uv.lock` is out of date relative to `pyproject.toml` (e.g. someone bumped `pydantic` in `pyproject.toml` but did not run `uv lock`), `--frozen` makes this a hard error. The PR that bumps a dep must also commit the lockfile.

**Why `uv run ruff check .`:** `ruff check .` lints every Python file in the repo. The `uv run` wrapper uses the project's `.venv` (so the right `ruff` version is used). Without `uv run`, you would need `ruff` to be on `PATH` globally, which is not guaranteed on the runner.

**Why `uv run ruff format --check .`:** `ruff format --check` checks that the code is *formatted* (PEP 8 + ruff's style rules) but does not modify files. The `--check` flag makes it exit non-zero if any file is not formatted — which fails the CI. The fix is `uv run ruff format .` locally, then commit.

**`ruff check` vs `ruff format --check`.**

They are different. `ruff check` is the linter — it catches `import` order, unused imports, undefined names, mutable default args. `ruff format --check` is the formatter — it catches indentation, line length, trailing whitespace. A codebase can pass one and fail the other. Both are needed; they are complementary. The lesson [[01-Python-Foundations/uv-Tooling-Workflows]] has the `ruff` configuration in `pyproject.toml`.


### Lines 26–33: The `typecheck` job

```yaml
 typecheck:
 name: Type check (mypy)
 runs-on: ubuntu-24.04
 steps:
 - uses: actions/checkout@v4
 - uses: astral-sh/setup-uv@v5
 with:
 enable-cache: true
 cache-dependency-glob: uv.lock
 - run: uv sync --frozen
 - run: uv run mypy src/boardly
```

**What it does:** A job called `typecheck` that runs `mypy src/boardly` — type-checks the `boardly` package.

**Why this is a separate job (not a step in `lint`):** mypy is slower than ruff (10-30 seconds vs sub-second). If mypy were a step in `lint`, you would wait for the slower one before knowing the result. By splitting, you get parallelism — `lint` and `typecheck` run at the same time (no `needs:` between them).

**Why `mypy src/boardly` (path) and not `mypy` (no path):** `mypy` with no path type-checks the current directory; the configuration in `pyproject.toml`'s `[tool.mypy]` decides what is checked. The explicit path `src/boardly` is more deterministic — you know exactly what mypy is checking. The trade-off: if you add a new top-level package (`src/boardly_cli/`), you have to update the workflow to add it. We prefer the explicit path because the diff is visible.

**Why mypy is a separate concern from tests:** type errors are caught *before* the code runs. A unit test that fails because of a type error tells you the same thing as mypy, but slower (the test has to run, the type error has to manifest at runtime). mypy catches the type error before the test runs. The ordering — type check before unit tests — is the "fastest feedback first" principle.

**mypy or pyright?**

Both work. mypy is the historical default; pyright (Microsoft, used by Pylance in VS Code) is faster and stricter. The CI trade-off: mypy is pure Python, easy to install with `uv add --dev mypy`; pyright is a Node.js tool, requires `npm install`. For `Boardly`, mypy. For a project that already has pyright in the editor, pyright. Pick one and do not mix.


**Student asks: why is `lint` a separate job from `typecheck`? They both fail fast on syntax issues.**

They are separate jobs because they fail for different *reasons*, and the failure reason tells you what to fix. A ruff failure is a *style or convention* issue — fixable with `ruff format` or a one-line change. A mypy failure is a *type* issue — fixable by adding a type annotation, narrowing a type, or fixing the actual logic mypy is complaining about. If you combine them into one job, the failure message is ambiguous ("CI failed" — was it the style or the type? the developer has to read the log to find out). Separate jobs let the failing job's name tell you the category: `lint` red means "fix the style", `typecheck` red means "fix the type". The cost is one extra runner spin-up (~30 seconds); the benefit is "the failure message tells you what to do". The architectural property is "fastest feedback first, and the failure reason is in the job name".


**Student asks: why does `unit` `needs: lint` and not `needs: [lint, typecheck]`?**

Because `lint` and `typecheck` are parallel (they do not depend on each other); `unit` only needs *one of them* to be green before it runs. But GitHub Actions' `needs:` is conjunctive by default — `needs: [lint, typecheck]` would block `unit` until *both* lint and typecheck finish. The pattern in this workflow uses `needs: lint` only, which means `unit` starts as soon as lint is green, in parallel with typecheck. The trade-off: if typecheck is red, unit still runs (wasted CI minutes); if you want unit to skip on typecheck-red, use `needs: [lint, typecheck]`. The Boardly choice is "lint is fast (1 s) and catches the obvious problems; let unit run if lint is green; typecheck red is reported but does not block the unit suite". Tune per project.


### Lines 35–53: The `unit` job (matrix)

```yaml
 unit:
 name: Unit tests (Python ${{ matrix.python }})
 needs: lint
 runs-on: ubuntu-24.04
 strategy:
 fail-fast: false
 matrix:
 python: ["3.12", "3.13"]
 steps:
 - uses: actions/checkout@v4
 - uses: astral-sh/setup-uv@v5
 with:
 enable-cache: true
 cache-dependency-glob: uv.lock
 python-version: ${{ matrix.python }}
 - run: uv sync --frozen
 - run: uv run pytest -m "not integration and not e2e" --cov=src/boardly --cov-report=xml
 - uses: actions/upload-artifact@v4
 if: always()
 with:
 name: coverage-${{ matrix.python }}
 path: coverage.xml
```

**What it does:** A job called `unit` that needs `lint` to pass first (`needs: lint`). It runs on a matrix of Python versions (3.12, 3.13), in parallel. Each matrix row gets its own runner, its own checkout, its own `uv sync`. The unit tests run with the marks `not integration and not e2e` filtered out. Coverage is uploaded as an artifact.

**Why `needs: lint`:** lint is sub-second. If lint fails, the matrix triples (3.12 and 3.13) is wasted runner time. `needs: lint` makes the matrix start only after lint is green. The trade-off: you wait ~15 seconds for lint before the matrix starts. For a fast lint, the wait is worth it; for a slow lint, drop the `needs:`.

**Why `fail-fast: false`:** the default is `true`, which means if one matrix row fails, GitHub cancels the others. With `false`, all rows run to completion — you see the full matrix's results. For CI, you want `false`: knowing that 3.12 fails *and* 3.13 passes is more informative than "3.12 failed, 3.13 was cancelled".

**Why the matrix is `["3.12", "3.13"]` (not 3.11):** Python 3.11 is end-of-life in October 2026. The supported versions in Oct 2026 are 3.12 and 3.13 (with 3.14 newly released). Pin to the versions you support; do not pin to one version unless you genuinely run only one. The matrix catches Python-version regressions (a stdlib change, a syntax deprecation).

**Why `python-version: ${{ matrix.python }}` in `setup-uv`:** the `astral-sh/setup-uv@v5` action installs a specific Python version (in addition to `uv`). Without it, `uv` uses the runner's default Python (3.12 on `ubuntu-24.04`); the matrix would be ignored. With it, each matrix row gets the right Python.

**Why `uv run pytest -m "not integration and not e2e"`:** the mark filter `not integration and not e2e` excludes the slow integration tests (which need the DB) and the e2e tests (which need a real server). The unit tier is fast — no sidecars, no network. We covered the marks in [[12-Testing-and-Quality/Test-Pyramid-and-Fixtures]].

**Why `--cov=src/boardly --cov-report=xml`:** `--cov=src/boardly` measures coverage of the `boardly` package. `--cov-report=xml` writes `coverage.xml` — the format Codecov/Codacy/CodeRabbit read. The terminal report (which we did not ask for here) is verbose; the XML is what tooling consumes.

**Why `actions/upload-artifact@v4` with `if: always()`:** the `if: always()` means the coverage artifact is uploaded even if the test step failed. Without it, a failing test means no coverage artifact — and you cannot inspect the coverage of a failing run. The artifact name `coverage-${{ matrix.python }}` makes each row's coverage a separate artifact (otherwise they would overwrite each other).

**`--cov-report=xml` is for tooling; `--cov-report=term-missing` is for humans.**

In CI, you usually want both: the XML for codecov/codecov, the terminal for the log. The full invocation: `uv run pytest -m "not integration and not e2e" --cov=src/boardly --cov-branch --cov-report=term-missing --cov-report=xml`. We trimmed it in the workflow for readability; the lesson's `pyproject.toml` from Lesson 09 has the `addopts` defaults.


### Lines 55–93: The `integration` job (matrix + service containers)

```yaml
 integration:
 name: Integration tests (Python ${{ matrix.python }})
 needs: typecheck
 runs-on: ubuntu-24.04
 strategy:
 fail-fast: false
 matrix:
 python: ["3.12", "3.13"]
 services:
 postgres:
 image: postgres:17
 env:
 POSTGRES_USER: test
 POSTGRES_PASSWORD: test
 POSTGRES_DB: boardly_test
 ports: ["5432:5432"]
 options: >-
 --health-cmd "pg_isready -U test"
 --health-interval 5s
 --health-timeout 5s
 --health-retries 10
 redis:
 image: redis:7
 ports: ["6379:6379"]
 options: >-
 --health-cmd "redis-cli ping"
 --health-interval 5s
 --health-timeout 5s
 --health-retries 10
 env:
 DATABASE_URL: postgresql+asyncpg://test:test@localhost:5432/boardly_test
 REDIS_URL: redis://localhost:6379/0
 JWT_SECRET: ci-secret-32-bytes-do-not-use-in-prod!
 steps:
 - uses: actions/checkout@v4
 - uses: astral-sh/setup-uv@v5
 with:
 enable-cache: true
 cache-dependency-glob: uv.lock
 python-version: ${{ matrix.python }}
 - run: uv sync --frozen
 - run: uv run alembic upgrade head
 - run: uv run pytest -m "integration" --maxfail=3
 - run: uv run pytest tests/test_migrations.py -v
```

**What it does:** A job called `integration` that needs `typecheck` to pass first. It runs on the same matrix as `unit`. It provisions two service containers — PostgreSQL 17 and Redis 7 — with healthchecks. It sets three env vars that the test code reads. It runs `alembic upgrade head` (apply migrations), then `pytest -m "integration"` (the integration tests), then `pytest tests/test_migrations.py` (the migration tests).

**Why `needs: typecheck` (not `needs: unit`):** the integration job can start as soon as typecheck is green — it does not need to wait for unit. The dependency graph is: `lint` → `unit` and `lint` → `typecheck` → `integration`. (Actually `unit` needs `lint`, `integration` needs `typecheck`. They are independent paths from `lint` and `typecheck`.) The trade-off: parallelism vs runner minutes. With the graph as written, `unit` and `integration` can run in parallel after their respective dependencies; if we made `integration` need `unit`, the integration would wait for the matrix.

**Why the matrix on integration is the same as on unit:** symmetry. Each Python version's unit tests and integration tests are paired. The trade-off (discussed below in Engineering Trade-Offs) is CI minutes — integration is the slowest job, and the matrix doubles it. Some teams scope the matrix to unit only and run integration on the latest Python. We use the full matrix here for symmetry; the trade-off is yours.

**Why `services:` for PostgreSQL and Redis:** GitHub Actions can run Docker containers alongside the runner, with their ports mapped to `localhost`. The runner's `localhost:5432` is the Postgres container's 5432. The test code's `DATABASE_URL=postgresql+asyncpg://test:test@localhost:5432/...` works because the port is mapped.

**Why `image: postgres:17`:** Postgres 17 is the latest stable release in Oct 2026. Pin to a major version (17, not 17.3 or 17.3.4) so that you get patch updates without surprise. The trade-off: a patch update could change behavior (rare, but possible). For CI, the major version is the right pin.

**Why the env block on `postgres`:** `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` are the env vars the official Postgres image reads at startup. They create a user, a password, and a database with those names. Without them, the image defaults to `postgres`/`postgres`/`postgres` — which works but is less explicit.

**Why `ports: ["5432:5432"]`:** the first 5432 is the host port (on the runner), the second is the container port. The host port is what the test code connects to. If you only wrote `5432` (without the colon), GitHub assigns a random host port and exposes it as a service context variable — useful for parallel matrices that need distinct ports, but more complex. The `5432:5432` form is simpler and works when the matrix does not run two Postgres containers at once (which it does not — each matrix row gets its own runner).

**Why the `options:` block with `--health-cmd`:** without it, the next step starts before Postgres is ready. The first request fails with `connection refused`. The `--health-cmd "pg_isready -U test"` polls Postgres every 5 seconds; after 10 successful polls (or 10 failures), the container is "healthy". The runner waits for "healthy" before starting the next step.

**Why `--health-interval 5s`, `--health-timeout 5s`, `--health-retries 10`:** the interval is how often to poll (every 5 seconds), the timeout is how long to wait for one poll (5 seconds), the retries is how many consecutive failures trigger "unhealthy". With these values, the worst-case startup wait is `5s * 10 = 50 seconds` (which is rare — Postgres starts in 2-3 seconds on the runner).

**Why Redis's healthcheck uses `redis-cli ping`:** `redis-cli ping` returns `PONG` if Redis is up. The command is the Redis equivalent of `pg_isready`. Without the healthcheck, the test's first Redis command might fail with `connection refused`.

**Why the env vars `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`:** these are the env vars the test code (and the app code, via Pydantic Settings) reads. `DATABASE_URL` is the connection string for `create_async_engine`; `REDIS_URL` is for `Redis.from_url`; `JWT_SECRET` is the secret used to sign JWTs in tests. The lesson [[04-Pydantic/Pydantic-Settings]] covers the seam between env vars and the app's `Settings` class.

**Why `uv run alembic upgrade head`:** apply the database migrations to the fresh Postgres. Without this, the test code would error with "table does not exist". The migrations are the source of truth for the schema — `Base.metadata.create_all` is for the unit-tier in-memory DB, but the integration tier must use the real migrations, because that is what production uses.

**Why `uv run pytest -m "integration" --maxfail=3`:** run only the integration-marked tests. `--maxfail=3` stops after 3 failures — useful because integration tests are slow, and 3 failures is enough signal that the run is broken; no need to wait for the other 50 tests to time out.

Why `--maxfail=3` and not `--maxfail=1`? `--maxfail=1` stops at the first failure; `--maxfail=3` stops at the third. The trade-off: a single failing test might be an isolated bug (one endpoint broken) or a sign of a wider issue (a model change broke cascades, which broke 30 endpoints). With `--maxfail=1`, you see one failure and assume it is isolated; you fix it; the rerun reveals the next failure; you fix that; the rerun reveals the next failure; you spend an hour cycling. With `--maxfail=3`, the first three failures are reported in one run — you can see the pattern ("oh, every cascade test failed — the model change broke cascades") and fix the root cause, not the symptoms. Three is the smallest number that lets you see a pattern. Five is too many for slow integration suites. Three is the heuristic.

**Why `uv run pytest tests/test_migrations.py -v`:** a separate test file for migration-specific tests. These tests check that `alembic upgrade head` and `alembic downgrade -1` work end-to-end. The lesson [[09-Alembic-Migrations/Alembic-Setup-and-Workflow]] covers them.

**Danger — Missing healthcheck = intermittent failures.**

A common mistake is to omit the `options:` block. The next step starts immediately; the first integration test fails with `connection refused`. The retry-logic in the test code might paper over it (SQLAlchemy has `pool_pre_ping`, httpx has retries), but the failure is real. Always include the healthcheck — it is the difference between "always green" and "flaky on the first run after a deploy".


### Lines 95–116: The `build` job (gated to `main`)

```yaml
 build:
 name: Build Docker image
 needs: [unit, integration]
 if: github.event_name == 'push' && github.ref == 'refs/heads/main'
 runs-on: ubuntu-24.04
 permissions:
 contents: read
 packages: write
 steps:
 - uses: actions/checkout@v4
 - uses: docker/setup-buildx-action@v3
 - uses: docker/login-action@v3
 with:
 registry: ghcr.io
 username: ${{ github.actor }}
 password: ${{ secrets.GITHUB_TOKEN }}
 - uses: docker/build-push-action@v6
 with:
 context: .
 push: true
 tags: |
 ghcr.io/${{ github.repository }}:${{ github.sha }}
 ghcr.io/${{ github.repository }}:latest
 cache-from: type=gha
 cache-to: type=gha,mode=max
```

**What it does:** A job called `build` that needs both `unit` and `integration` to pass. It runs *only* on push to `main` (not on PRs). It builds a Docker image and pushes it to GitHub Container Registry (`ghcr.io`).

**Why `needs: [unit, integration]`:** the image build takes 1-3 minutes. If lint, types, or tests fail, do not waste the build. The `needs:` ensures the build only runs after the matrix is green.

**Why `if: github.event_name == 'push' && github.ref == 'refs/heads/main'`:** the build only runs on push to `main`. On PRs, the build is skipped — you do not want to push an unreleased image to the registry for every PR. The `github.event_name` is `push` for branch/tag pushes, `pull_request` for PRs. The `github.ref` is `refs/heads/main` for pushes to `main`.

**Why `permissions:` is explicit:** GitHub's default `GITHUB_TOKEN` permissions are read-only since 2023 — but the default is workflow-configurable. The `permissions:` block makes it explicit: `contents: read` (clone the repo), `packages: write` (push to `ghcr.io`). Without `packages: write`, the push fails with `denied: permission_denied`. The principle: declare the permissions you need; do not rely on defaults.

**Why `docker/setup-buildx-action@v3`:** BuildKit is the modern Docker build engine. `setup-buildx-action` installs BuildKit on the runner. Without it, the build uses the legacy Docker build, which is slower and does not support cache features.

**Why `docker/login-action@v3`:** authenticates to `ghcr.io` (the GitHub Container Registry) using the auto-injected `GITHUB_TOKEN`. The `github.actor` is the user/org that triggered the workflow. The `secrets.GITHUB_TOKEN` is auto-provided by GitHub; you do not need to create it.

**Why `docker/build-push-action@v6`:** the action that builds and pushes. The `context: .` is the build context (the repo root). The `push: true` means push after build (without it, the image is built but not pushed — useful for testing the build).

**Why two tags (`:${{ github.sha }}` and `:latest`):** the SHA tag is immutable — every push to `main` produces a unique image with a SHA tag. The `:latest` tag is mutable — every push to `main` overwrites `:latest`. The SHA tag lets you roll back to a specific commit; the `:latest` tag is the convenience alias for "the most recent main". The lesson [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]] covers the tag strategy in depth.

**Why `cache-from: type=gha` and `cache-to: type=gha,mode=max`:** BuildKit layer cache, stored in GitHub Actions cache (`type=gha`). The `mode=max` means cache *all* layers (including the builder stage of a multi-stage build). Without this, every build re-runs every layer — which for a 1 GB image with a build stage is 3-5 minutes per build. With cache, a no-op rebuild is ~10 seconds (only the layer that changed).

**Warning — `:latest` is mutable; do not deploy from `:latest`.**

A common mistake is to deploy from `:latest` — which means "the most recent main image". If you roll back, `:latest` is *the current main*, not the version you deployed yesterday. Always deploy from a SHA tag (or a `:vX.Y.Z` tag for releases). The `:latest` tag is for local development convenience, not for production.


### Lines 118–127: The `security` job (parallel)

```yaml
 security:
 name: Dependency audit
 runs-on: ubuntu-24.04
 steps:
 - uses: actions/checkout@v4
 - uses: astral-sh/setup-uv@v5
 with:
 enable-cache: true
 cache-dependency-glob: uv.lock
 - run: uv sync --frozen
 - run: uv run pip-audit --strict
```

**What it does:** A job called `security` that runs `pip-audit --strict` against the installed dependencies. It has no `needs:` — it runs in parallel with lint, typecheck, unit, and integration.

**Why no `needs:`:** security is independent of the test pipeline. A CVE in a dependency is a security issue, not a test failure. Running it in parallel gives faster feedback.

**Why `pip-audit --strict`:** `pip-audit` checks installed packages against the Python Packaging Advisory Database (a curated list of CVEs). `--strict` makes it fail on any vulnerability, including in transitive dependencies. Without `--strict`, only "high severity" issues fail; with it, anything fails.

**Why this is its own job and not a step in `lint`:** the audit takes ~10 seconds (it fetches the advisory database). Putting it in `lint` would slow lint from sub-second to ~15 seconds, defeating the "fastest feedback first" principle.

**`pip-audit` vs `safety` vs `dependabot`.**

Three tools, three jobs:
- `pip-audit` runs in CI on every push; gives immediate signal on a new CVE.
- `safety` is a commercial alternative; same job.
- `dependabot` runs on a schedule (e.g. daily), opens PRs that bump vulnerable deps. Long-tail, manual review.

Use `pip-audit` for the immediate signal; use `dependabot` for the long-tail. Both.


## The Badge

Add this line near the top of `README.md`:

```markdown
[![CI](https://github.com/<owner>/<repo>/actions/workflows/ci.yml/badge.svg)](https://github.com/<owner>/<repo>/actions/workflows/ci.yml)
```

**What it does:** Renders a badge that links to the workflow's run history. The badge is green if the latest run on the default branch passed; red otherwise.

**Why the badge matters:** the badge is the public face of your CI. Visitors to the repo see the badge in the README; if it is green, they trust the code more. If it is red, they know there is a problem before they clone.

**Why the URL has `actions/workflows/ci.yml/badge.svg`:** the path includes the workflow file name. If you rename the workflow file, the badge URL breaks. Pin the file name; if you rename, update the README.

**Tip — Branch-specific badges.**

The default badge is for the default branch. For a branch-specific badge, append `?branch=main` to the URL: `.../ci.yml/badge.svg?branch=main`. Useful for "main is green but `develop` is red" dashboards.


## Execution Trace: a push to `main`

Push a commit to `main`. What happens, in order:

1. **GitHub receives the push.** It scans `.github/workflows/`, finds `ci.yml`, checks the `on:` block, and queues the workflow.
2. **Concurrency group is computed:** `CI-refs/heads/main`. If an existing run of the same group is in-flight, it is cancelled (`cancel-in-progress: true`).
3. **GitHub allocates runners** — one for `lint`, one for `typecheck`, one for `security` (no `needs:` between them). Three runners start in parallel.
4. **`lint` runs** (~15 seconds). `ruff check` and `ruff format --check`. If it fails, the `unit` job (which `needs: lint`) is skipped; the matrix does not run.
5. **`typecheck` runs** (~30 seconds). `mypy src/boardly`. If it fails, the `integration` job (`needs: typecheck`) is skipped.
6. **`security` runs** (~10 seconds). `pip-audit --strict`. Independent of lint and typecheck.
7. **`unit` runs on the matrix** (~20 seconds per row, 2 rows = ~20 seconds parallel). `pytest -m "not integration and not e2e"` on Python 3.12 and 3.13 in parallel.
8. **`integration` runs on the matrix** (~60 seconds per row, 2 rows = ~60 seconds parallel). Postgres and Redis containers start; `alembic upgrade head`; `pytest -m "integration"`.
9. **`build` runs** (~90 seconds, only if `unit` and `integration` are green). BuildKit builds the Docker image with `cache-from: type=gha`; pushes to `ghcr.io/<owner>/<repo>:<sha>` and `:latest`.
10. **Badge turns green** (or red, on any failure). The run is visible on the Actions tab.

**Total wall-clock for a no-op commit on `main`:** ~3 minutes (dominated by `integration`). A PR with no test changes: ~1.5 minutes (lint + typecheck + unit; build is gated to `main` only). A PR with migration changes: ~2.5 minutes (integration runs, build does not).

```mermaid
flowchart TB
 Push["Push to main<br/>(or PR)"]
 Concurrency["Concurrency group<br/>CI-refs/heads/main<br/>cancel-in-progress"]
 Lint["1. Lint (ruff)<br/>~15s"]
 Types["2. Type check (mypy)<br/>~30s"]
 Secur["Security (pip-audit)<br/>~10s<br/>parallel"]
 Unit["3. Unit tests<br/>matrix 3.12 + 3.13<br/>~20s parallel"]
 Int["4. Integration tests<br/>matrix 3.12 + 3.13<br/>PG + Redis containers<br/>~60s parallel"]
 Build["5. Build image<br/>only on push to main<br/>~90s"]
 Push2["6. Push to ghcr.io<br/>:sha and :latest"]
 Badge["Badge turns green"]

 Push --> Concurrency
 Concurrency --> Lint
 Concurrency --> Types
 Concurrency --> Secur
 Lint --> Unit
 Types --> Int
 Unit --> Build
 Int --> Build
 Build --> Push2
 Push2 --> Badge

 style Lint fill:#dcfce7,stroke:#16a34a
 style Types fill:#dcfce7,stroke:#16a34a
 style Secur fill:#dcfce7,stroke:#16a34a
 style Unit fill:#dcfce7,stroke:#16a34a
 style Int fill:#fef3c7,stroke:#d97706
 style Build fill:#fef3c7,stroke:#d97706
 style Push2 fill:#fee2e2,stroke:#dc2626
 style Badge fill:#dcfce7,stroke:#16a34a
```

The diagram shows the dependency graph. `lint`, `typecheck`, and `security` run in parallel; `unit` waits for `lint`; `integration` waits for `typecheck`; `build` waits for both `unit` and `integration` *and* gates on `main`. The wall-clock is dominated by `integration` (the slowest job); the rest is parallel.

**You have just built a real CI pipeline.**

It is small — six jobs, ~200 lines of YAML, one badge. But the architecture is identical to a pipeline with fifty jobs, a release track, a nightly e2e, a deploy-on-tag, and a Slack notification. The skeleton is permanent. Everything else is additions.


## Common Mistakes

### Mistake 1: No `--frozen` on `uv sync`

```yaml
# WRONG
- run: uv sync
```

**Symptom:** a PR bumps `pydantic` in `pyproject.toml` but does not commit the updated `uv.lock`. CI passes — `uv sync` re-resolves, installs the new version, tests pass. The teammate pulls, runs `uv sync`, gets the old version (their `uv.lock` is the committed one), tests fail. CI was green but the code is broken.

**Why:** `uv sync` without `--frozen` re-resolves the lockfile against `pyproject.toml`. If the lockfile is stale, `uv sync` quietly fixes it. The lockfile is no longer the source of truth; `pyproject.toml` is. Drift between local and CI disappears.

**Fix:** `uv sync --frozen` (or set `UV_FROZEN=1` at the workflow level, as we did). Stale lockfile = hard error. The PR that bumps a dep must also commit the lockfile.

### Mistake 2: Service container without a healthcheck

```yaml
# WRONG
services:
 postgres:
 image: postgres:17
 ports: ["5432:5432"]
 # no healthcheck!
```

**Symptom:** the first integration test fails with `connection refused` or `OperationalError: server closed the connection unexpectedly`. The second test usually passes (Postgres started in the 5 seconds the first test took to fail).

**Why:** without `--health-cmd`, the runner does not wait for Postgres to be "ready" — it starts the container and immediately moves to the next step. Postgres takes 2-3 seconds to start; the test code's first connection hits it before it is ready.

**Fix:** add the `options:` block with `--health-cmd "pg_isready -U test"`. Always.

### Mistake 3: Lint and tests in one job

```yaml
# WRONG
 test:
 runs-on: ubuntu-24.04
 steps:
 - uses: actions/checkout@v4
 - run: uv sync --frozen
 - run: uv run ruff check .
 - run: uv run pytest
```

**Symptom:** a `ruff` failure (sub-second) takes 60 seconds to surface — the runner has to do `checkout`, `uv sync`, `ruff`, then `pytest` before reporting. The `pytest` step is wasted work for a lint failure.

**Why:** jobs are units of failure. If lint and tests are in the same job, the failure is reported only after all prior steps run.

**Fix:** split into separate jobs with `needs:`. `lint` is its own job; `unit` `needs: lint` and does not start until lint is green.

### Mistake 4: Matrix on integration tests

```yaml
# WRONG
 integration:
 strategy:
 matrix:
 python: ["3.12", "3.13", "3.14"]
```

**Symptom:** CI minutes triple. The DB does not behave differently per Python version — the matrix is wasted runner time.

**Why:** the matrix is most valuable on the *unit* tier (where Python-version differences matter — stdlib changes, syntax deprecations). The *integration* tier tests the wiring (DB, Redis, HTTP), which is Python-version-independent. Tripling the integration matrix triples CI minutes for limited value.

**Fix:** scope the matrix to unit only. Run integration on the latest supported Python only:

```yaml
 integration:
 # no matrix
 runs-on: ubuntu-24.04
 # ... one Python, the latest supported
```

The trade-off is yours; some teams keep the full matrix for symmetry. We use the full matrix in this lesson's YAML for symmetry, but the trade-off is real.

### Mistake 5: Pushing the image on every PR

```yaml
# WRONG
 build:
 if: github.event_name == 'pull_request'
 # pushes on every PR
```

**Symptom:** the registry fills up with thousands of PR images that no one will ever deploy. Storage costs grow. Vulnerability scans multiply.

**Why:** pushing on PR means "every PR produces an image". Most PRs are merged; the images of unmerged PRs are dead weight.

**Fix:** push only on `main` (and on tags, in a separate release workflow). On PRs, *build* the image (without pushing) to verify the build works:

```yaml
 build:
 if: github.event_name == 'pull_request'
 steps:
 - uses: docker/build-push-action@v6
 with:
 push: false # build but do not push
 tags: boardly:pr-${{ github.event.pull_request.number }}
```

### Mistake 6: Caching everything, including stale data

```yaml
# WRONG
- uses: actions/cache@v4
 with:
 path: .venv
 key: venv # static key, never invalidated
```

**Symptom:** the cache returns a stale `.venv` with old dependencies. Tests pass against the old deps, fail locally against the new deps. CI is green; the code is broken.

**Why:** a static cache key (`key: venv`) never invalidates. The cache is reused forever, even after `pyproject.toml` and `uv.lock` change. The cache lies.

**Fix:** include a hash of the dependency files in the key:

```yaml
- uses: actions/cache@v4
 with:
 path: .venv
 key: venv-${{ hashFiles('uv.lock') }}
 restore-keys: venv-
```

For `uv` specifically, the `astral-sh/setup-uv@v5` action handles this internally via `cache-dependency-glob: uv.lock`. Do not double-cache.

### Mistake 7: Forgetting `permissions:`

```yaml
# WRONG
 build:
 runs-on: ubuntu-24.04
 # no permissions: block
 steps:
 - uses: docker/build-push-action@v6
 with:
 push: true
```

**Symptom:** the push fails with `denied: permission_denied`. The `GITHUB_TOKEN` does not have `packages: write` permission.

**Why:** GitHub's default `GITHUB_TOKEN` permissions are read-only since 2023 (a security hardening). To push an image, you need `packages: write` explicitly.

**Fix:** add the `permissions:` block:

```yaml
 build:
 permissions:
 contents: read
 packages: write
```

Always declare the permissions you need. Do not rely on defaults.

### Mistake 8: No `concurrency:` block

```yaml
# WRONG
# no concurrency: block
```

**Symptom:** a push of 5 commits to `main` runs 5 pipelines. The first 4 are obsolete by the time they finish. CI minutes burn.

**Why:** without `concurrency:`, every push triggers a fresh run. The runs queue and run in parallel (up to runner limits). For a fast pusher, the queue grows; the older runs are wasted.

**Fix:** add `concurrency:` with `cancel-in-progress: true`:

```yaml
concurrency:
 group: ${{ github.workflow }}-${{ github.ref }}
 cancel-in-progress: true
```

## Engineering Trade-Offs

### Self-hosted vs GitHub-hosted runners

| Aspect | GitHub-hosted | Self-hosted |
|---|---|---|
| Setup | zero | install the runner, maintain it |
| Cost | ~2 000 free minutes/month, then per-minute | no per-minute cost |
| Speed | ~10-30 s startup (cold) | ~1-2 s startup (warm) |
| Maintenance | zero | OS updates, security patches, capacity planning |
| Security | isolated VMs | your network, your risks |

GitHub-hosted for small/medium projects and open source. Self-hosted for high-volume (where per-minute costs dominate) or for security-sensitive code that cannot leave your network.

### Service containers vs Testcontainers

| Aspect | Service containers | Testcontainers |
|---|---|---|
| Where it runs | GitHub-hosted, in the workflow | In the test process, via Docker |
| Portability | CI-only (GitHub Actions syntax) | works locally too |
| CI requirement | native | Docker-in-Docker in CI |
| Speed | fast (provisioned by GitHub) | slower (each test starts a container) |

Service containers are CI-native — they work in GitHub Actions but not locally. Testcontainers is portable — works in any CI with Docker, works locally. The trade-off: service containers are faster; Testcontainers is portable. For a CI-first workflow, service containers; for a "local CI parity" workflow, Testcontainers.

### Build every push vs build on merge

| Aspect | build on push | build on merge |
|---|---|---|
| Feedback | fast (image built before merge) | slow (image built after merge) |
| Cost | high (every PR = an image) | low (only merged code = an image) |
| Risk | pushing unreleased code | pushing only release-ready code |

Build on push (gated to `main`) gives fast feedback but uses more registry storage. Build on merge (only when the PR is merged to `main`) is slower but cheaper. Most teams build on `main` push, with PR builds doing `push: false` (build only, no push).

### Pinning Python versions vs floating

| Aspect | pin to `3.12.7` | float to `3.12` | float to `3.x` |
|---|---|---|---|
| Reproducibility | highest | high | low |
| Catches patch regressions | no | yes | yes |
| Catches minor regressions | no | no | yes |
| Maintenance | high (bump on every patch) | medium (bump on every minor) | low |

The middle ground: pin to minor (`3.12`, `3.13`) but allow patch updates. This catches patch-level regressions (a security fix that breaks something) without the maintenance of pinning to a specific patch.

### `pip-audit` vs `safety` vs `dependabot`

| Aspect | `pip-audit` | `safety` | `dependabot` |
|---|---|---|---|
| Where | in CI, every push | in CI, every push | on a schedule, opens PRs |
| Signal | immediate | immediate | long-tail |
| Cost | free (PyPI advisory DB) | commercial | free (GitHub-provided) |
| Use for | immediate CVE signal | same | long-tail dependency bumps |

Use `pip-audit` (or `safety`) for the immediate signal; use `dependabot` for the long-tail. Both, not either-or.

## Exercises

**Tip — The 20-minute rule**

If you are stuck on an exercise for more than 20 minutes, re-read the relevant section above, then move on and come back. Learning is not linear.


**Exercise 1 — Add a nightly e2e job.** Add a job that runs only on schedule (cron `0 3 * * *` — 3 a.m. UTC daily), runs `pytest -m "e2e" --maxfail=1`, and posts a Slack notification on failure. (Hint: use `uses: slackapi/slack-github-action@v1` and a `SLACK_WEBHOOK_URL` secret.)

**Exercise 2 — Add a coverage gate.** Configure `pyproject.toml` so coverage config is in code:

```toml
[tool.coverage.run]
branch = true
source = ["src/boardly"]

[tool.coverage.report]
fail_under = 80
```

Then in CI, add `uv run pytest --cov-fail-under=80` to the `unit` job. Confirm the job fails if coverage drops below 80 %. Bump `fail_under` to a value you can actually achieve; do not set it to 100 on day one.

**Exercise 3 — Build a release workflow.** Create a separate file, `.github/workflows/release.yml`, that triggers on tag (`on: push: tags: ["v*"]`), runs the full pipeline (lint, typecheck, unit, integration), builds the image with the tag as the version (`ghcr.io/...:${{ github.ref_name }}`), and signs it with `cosign`. (See [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]] for the non-root build that the image must use.)

**Exercise 4 — Spot the bug.** This workflow is broken. Why?

```yaml
on:
 push:
 branches: [main]
 pull_request:

concurrency:
 group: ${{ github.workflow }} # ← bug
 cancel-in-progress: true
```

(Answer: the group is just the workflow name, with no `github.ref`. A push to `main` and a PR run share the same group — the push cancels the PR run, or vice versa. Fix: add `-${{ github.ref }}` to the group key.)

**Exercise 5 — Matrix scoping.** Modify the workflow so the matrix is on `unit` only (3.12 and 3.13), and `integration` runs on Python 3.13 only. Measure the CI minutes saved (GitHub shows minutes per run on the Actions tab). Confirm `unit` still catches Python-version regressions.

**Exercise 6 — Service container for an extra dependency.** Add a `valkey` (Redis-compatible) service container to the `integration` job. Healthcheck with `valkey-cli ping`. Configure `VALKEY_URL` env var. Run the integration tests with both Redis and Valkey available; assert one of them works (your choice). This is the exercise that proves you can read the `services:` block without copy-pasting.

**Exercise 7 — Self-hosted runner.** Install the GitHub Actions runner on your laptop (or a spare VM), register it with your repo, and change one job's `runs-on:` to `self-hosted`. Compare wall-clock time to `ubuntu-24.04`. (Spoiler: the startup is ~1-2 s on self-hosted vs ~10-30 s on GitHub-hosted, but the runner is yours to maintain.)

## Verification

Run the pipeline locally before pushing:

```bash
# Lint, type check, and tests — must match CI
uv run ruff check .
uv run ruff format --check .
uv run mypy src/boardly
uv run pytest -m "not integration and not e2e"

# The integration stage equivalent locally:
docker run --rm -d -p 5432:5432 \
 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test \
 -e POSTGRES_DB=boardly_test --name pg_test postgres:17
docker run --rm -d -p 6379:6379 --name redis_test redis:7

export DATABASE_URL=postgresql+asyncpg://test:test@localhost:5432/boardly_test
export REDIS_URL=redis://localhost:6379/0
export JWT_SECRET=ci-secret-32-bytes-do-not-use-in-prod!

uv run alembic upgrade head
uv run pytest -m "integration" --maxfail=3
uv run pytest tests/test_migrations.py -v

docker rm -f pg_test redis_test

# Then push and watch the green check
git push origin main
```

Expected: lint green, typecheck green, unit green on both Python versions, integration green on both, build green with image pushed to `ghcr.io/<owner>/<repo>:<sha>` and `:latest`, security green. The badge in `README.md` turns green within a few minutes of the push.

**Debugging tips.**

- `gh run watch` (the GitHub CLI) live-tails a run; useful for "is it stuck or just slow?"
- `gh run view --log` shows the full log of a completed run.
- For "the service container is not ready", add a `sleep 5` step before the test step to give Postgres/Redis extra time. If the test then passes, the healthcheck is broken (check the `--health-cmd`).
- For "the cache is stale", clear it via the GitHub Actions UI (Actions → Caches → delete the relevant key).
- For "the matrix triples CI minutes", measure with `gh run view --json jobs | jq '[.jobs[] | {name, "started_at", "completed_at"}]'` and see the actual times.


## Previously Learned Here

These concepts were taught in earlier lessons. We link back instead of re-explaining:

- **`uv`** — [[01-Python-Foundations/uv-Tooling-Workflows]]. CI runs `uv sync --frozen`; the `--frozen` flag is the lockfile-as-source-of-truth enforcement. The `UV_FROZEN` env var is the same flag, applied workflow-wide.
- **Pydantic Settings** — [[04-Pydantic/Pydantic-Settings]]. The env vars set in the workflow (`DATABASE_URL`, `JWT_SECRET`) are read by the `Settings` class — this is the seam between CI config and the app.
- **pytest** — [[12-Testing-and-Quality/Test-Pyramid-and-Fixtures]] and [[01-Python-Foundations/pytest-Fundamentals]]. The marks (`integration`, `e2e`, `slow`) the pipeline filters on are configured there.
- **async testing** — [[12-Testing-and-Quality/Async-Testing]]. The `pytest-asyncio` config in `pyproject.toml` (which CI respects) is from there.
- **Docker multi-stage non-root** — [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]]. The Dockerfile the `build` job runs.
- **Alembic migrations** — [[09-Alembic-Migrations/Alembic-Setup-and-Workflow]]. The `alembic upgrade head` step in CI is from there.

## What's Next

In [[16-Deployment-and-DevOps/GitHub-Actions-CI]] we move from "the CI pipeline" to "the deploy pipeline". The workflow you wrote here is the *test* pipeline; the deploy pipeline builds on it. We will:

- Build a release workflow that triggers on tag (`v*`), runs the full pipeline, builds the image with the tag as the version, signs it with `cosign`, and pushes it to `ghcr.io`.
- Build a deploy workflow that triggers on the release workflow's completion, runs `kubectl apply` (or `helm upgrade`) against the staging cluster, waits for the rollout, and runs a smoke test.
- Build a rollback workflow that triggers on a manual dispatch, runs `kubectl rollout undo`, and verifies the rollback.
- Build the badge for the deploy pipeline separately, so visitors can see "tests green" *and* "deploy green" in the README.

By the end of that lesson, `Boardly` will have a complete CI/CD pipeline — push to main builds, tests, builds the image, and (with the deploy workflow) deploys to staging automatically. The green check on GitHub is the contract that says "this code is shippable".

## Sources

- **GitHub Actions documentation — Workflow syntax** — <https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions> — accessed 2026-10-19 — every key (`name`, `on`, `jobs`, `steps`, `uses`, `run`, `env`, `strategy.matrix`, `services`, `concurrency`, `permissions`) is documented here. Verified Oct 2026.
- **`setup-uv` action** — <https://github.com/astral-sh/setup-uv> — accessed 2026-10-19 — the official `uv` install + cache action. Verified for `v5`.
- **`uv` CI recipes** — <https://docs.astral.sh/uv/guides/integration/github/> — accessed 2026-10-19 — the canonical patterns for `uv` in GitHub Actions.
- **Service container docs — About service containers** — <https://docs.github.com/en/actions/using-containerized-services/about-service-containers> — accessed 2026-10-19 — PostgreSQL and Redis as services, healthcheck syntax.
- **`pip-audit`** — <https://pypi.org/project/pip-audit/> — accessed 2026-10-19 — dependency CVE scanning, `--strict` flag.
- **`docker/build-push-action`** — <https://github.com/docker/build-push-action> — accessed 2026-10-19 — image build + push with BuildKit cache.
- **`pg_isready`** — <https://www.postgresql.org/docs/current/app-pg-isready.html> — accessed 2026-10-19 — the canonical Postgres healthcheck command.
- **GitHub-hosted runners** — <https://docs.github.com/en/actions/using-github-hosted-runners/about-github-hosted-runners> — accessed 2026-10-19 — the `ubuntu-24.04` runner specification and the `ubuntu-latest` alias schedule (Dec 2026).
- **Concurrency in GitHub Actions** — <https://docs.github.com/en/actions/using-jobs/using-concurrency> — accessed 2026-10-19 — `cancel-in-progress`, group key semantics.
- **Repository `permissions:` for `GITHUB_TOKEN`** — <https://docs.github.com/en/actions/security-guides/automatic-token-authentication> — accessed 2026-10-19 — the `permissions:` block, the default read-only behaviour, and `packages: write` for registry pushes.

## What We Learned

Let's recap. In this lesson you:

- **Built a complete `.github/workflows/ci.yml`** — six jobs (lint, typecheck, unit, integration, build, security), matrix on Python 3.12 and 3.13, service containers for PostgreSQL 17 and Redis 7, BuildKit layer cache, `uv sync --frozen` as the lockfile-as-source-of-truth enforcement, the `concurrency:` block with `cancel-in-progress: true`, the `permissions:` block for `packages: write`.
- **Learned the workflow → job → step hierarchy** — and why jobs are units of parallelism and failure, while steps are units within a job.
- **Learned the matrix** — why it triples wall-clock but pays for itself in Python-version regressions; why `fail-fast: false` is the right default; why scoping the matrix to unit only is the practical compromise.
- **Learned service containers** — why the healthcheck is non-negotiable; why `pg_isready -U test` and `redis-cli ping` are the right commands; why the env vars (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`) are the seam between CI config and the app's `Settings` class.
- **Learned `uv` in CI** — `uv sync --frozen` enforces the lockfile; `UV_FROZEN=1` applies it workflow-wide; `setup-uv@v5` with `enable-cache: true` and `cache-dependency-glob: uv.lock` caches across runs.
- **Learned the ordering** — lint first (fastest feedback), typecheck second, unit third (matrix), integration fourth (matrix + sidecars), build fifth (gated to `main`), push sixth (only on `main`).
- **Learned the badge** — the public face of CI, the URL contract, the `?branch=` filter for branch-specific badges.
- **Hit and fixed the eight classic CI mistakes** — no `--frozen`, no healthcheck, lint and tests in one job, matrix on integration, pushing on every PR, over-caching, missing `permissions:`, no `concurrency:`.

Here's the mental model to walk away with: *a CI pipeline is a contract — "if green is shown, the code is shippable". The contract has six obligations: lint (ruff), types (mypy), unit tests (matrix), integration tests (sidecars), build (image), security (audit). The obligations are ordered fastest-first so a sub-second failure does not waste 60 seconds of runner time. The contract is reproducible: pinned runner, pinned Python, `uv sync --frozen` enforces the lockfile, healthchecks enforce the sidecars are ready. The contract is parallel: lint, typecheck, and security run in parallel; unit and integration run in parallel after their respective dependencies. The contract is gated: the image build runs only on `main`, never on PRs. The contract is cached: BuildKit layers, `uv` store, and the project `.venv` are cached across runs, so a no-op commit re-runs in seconds. The contract has a public face: the green badge in `README.md`. Write the contract. Push to `main`. Sleep at night.*

---

> A note from your teacher
You just built the floor of every CI pipeline you will ever write. Sit with that. Two hundred lines of YAML, six jobs, two service containers, one badge. The browser sends a push to `main`; GitHub queues the workflow; runners start in parallel; lint and types fail fast; unit and integration run on the matrix; the image builds and pushes only on `main`; the badge turns green. That is the whole of continuous integration, scaled up. We are going to add the deploy pipeline next, then the observability stack, then the rollback strategy. But the CI floor you wrote today stays the same. See you in Section 16.


---

**Tags:** #ci #github-actions #devops #uv #review
**Previous:** [[12-Testing-and-Quality/Async-Testing]]
**Next:** [[16-Deployment-and-DevOps/GitHub-Actions-CI]] →

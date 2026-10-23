---
title: "Lesson 03: GitHub Actions CI for a FastAPI + uv Project"
aliases:
 - CI pipeline
 - GitHub Actions for Python
 - Workflow file
tags:
 - deployment
 - ci
 - devops
 - github-actions
 - lesson
course_level: intermediate
status: complete
difficulty: intermediate
estimated_time: "90–120 minutes"
prerequisites:
 - "[[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]]"
 - "[[16-Deployment-and-DevOps/Docker-Compose-Local-Dev]]"
 - "[[12-Testing-and-Quality/CI-Pipelines]]"
 - "[[01-Python-Foundations/uv-Tooling-Workflows]]"
related_lessons:
 - "[[Docker-Multi-Stage-Non-Root]]"
 - "[[Docker-Compose-Local-Dev]]"
 - "[[Migration-Ordering-and-Rollback]]"
---

# Lesson 03: GitHub Actions CI for a FastAPI + uv Project

*A `.github/workflows/ci.yml` for `Boardly` that matrixes on Python 3.12 and 3.13, runs `ruff`/`mypy`/`pytest --cov` against service-container Postgres+Redis, builds the Lesson 1 image with `cache-from: type=gha`, and pushes it to `ghcr.io` on `main` with an SBOM.*

**You're at Lesson 3 of Section 16.**

You built a production image in Lesson 1 and a local dev stack in Lesson 2. Now we want every push and every PR to run the same quality gates — lint, types, tests with coverage, image build — and on `main`, to push the image to a registry where the cluster can pull it. CI is the contract between "someone pushed code" and "someone can deploy this". If the contract is fast, deterministic, and catches the right things, you ship multiple times a day without fear. Take your time. Type every line of the workflow file. **This is how you learn.**


#ci #github-actions #deployment #devops

## Learning Objectives

By the end of this lesson you will be able to:

1. **Write a `.github/workflows/ci.yml`** that runs on push and PR, matrixed on Python 3.12 and 3.13.
2. **Install `uv 0.13.1` via `astral-sh/setup-uv`** with `enable-cache: true` and `cache-dependency-glob: uv.lock`, restoring `~/.cache/uv` across runs.
3. **Use service containers** for `postgres:17-alpine` and `redis:7-alpine` with `--health-cmd` so the test job waits for them.
4. **Run `ruff`, `mypy --strict`, `pytest --cov`** in the right order — lint first (fast), types next (medium), tests last (slow), and only run the slow steps if the fast ones pass.
5. **Build the Docker image** with `docker/build-push-action@v6` using `cache-from: type=gha` and `cache-to: type=gha,mode=max`, then **smoke-test the built image** by `docker run` and `curl /healthz`.
6. **Push the image to `ghcr.io` on `main`** tagged with the SHA, a readable branch-build tag, and `:main`. Generate an SBOM via `anchore/sbom-action`.
7. **Cancel superseded runs** with `concurrency: { cancel-in-progress: true }` so five pushes to the same branch do not run five full pipelines.
8. **Recognise the eight common CI mistakes** — `pip install` instead of `uv sync`, no `concurrency`, no `--health-cmd` on service containers, `:latest` tags, no smoke test, no SBOM, full matrix on `main`, and trusting `secrets.GITHUB_TOKEN` to push cross-repo.

## Prerequisites

Before starting, you need:

- **The Dockerfile from Lesson 1** — [[Docker-Multi-Stage-Non-Root]]. CI builds the `runtime` target of that Dockerfile.
- **The `compose.yaml` from Lesson 2** — [[Docker-Compose-Local-Dev]]. CI uses the same `postgres:17-alpine` and `redis:7-alpine` images with the same healthchecks (just expressed as GitHub Actions `services:` instead of Compose services).
- **A GitHub repo** with the `Boardly` code pushed. The workflow file lives at `.github/workflows/ci.yml` in the repo.
- **The `uv` lesson** — [[01-Python-Foundations/uv-Tooling-Workflows]]. We use `uv 0.13.1` (verified October 2026).
- **The CI principles lesson** — [[12-Testing-and-Quality/CI-Pipelines]]. The fail-fast ordering, the cache-vs-correctness trade-off, and the "test the rollback" principle.

## The Problem

A CI pipeline is the contract between "someone pushed code" and "someone can deploy this". If the contract is fast, deterministic, and catches the right things, you ship multiple times a day without fear. If it is slow, flaky, or only runs `pytest`, you accumulate regressions and learn to dread deploys.

The job of this pipeline is to refuse to publish an artifact unless the same code passes lint, types, tests with coverage, and builds a working Docker image — and to do it in well under ten minutes on a cache hit. We need:

- **Speed.** Every push runs the pipeline. If it takes 30 minutes, developers stop pushing. Caches for `uv` and Docker layers make a no-op rebuild take seconds.
- **Determinism.** The same commit must produce the same pass/fail and (ideally) the same image bytes. `uv.lock` and `--frozen` enforce dependency determinism. Service containers with pinned tags (`postgres:17-alpine`) enforce infrastructure determinism.
- **Coverage gates.** `pytest --cov` produces a coverage report. We do not enforce a percentage here (that is a team decision), but we upload the report to Codecov so the PR shows the diff.
- **Build the artifact.** The pipeline builds the Docker image, smoke-tests it, and pushes it to `ghcr.io` on `main`. The artifact that the deploy job (Lesson 4) pulls is the artifact CI built — no `docker build` in production.
- **Supply-chain provenance.** An SBOM (Software Bill of Materials) is generated for every pushed image. This is the list of every package in the image; it is what you check when a CVE drops on a downstream dep.

## The Code

Here is the complete `.github/workflows/ci.yml`. Read it through once; we will go line by line afterwards.

```yaml
name: CI

on:
 push:
 branches: [main]
 pull_request:
 workflow_dispatch:

# Cancel a previous run on the same ref when a new push lands.
concurrency:
 group: ci-${{ github.ref }}
 cancel-in-progress: true

# Restrict permissions to least-privilege. We only need more for the push job.
permissions:
 contents: read
 packages: write

env:
 PYTHON_VERSION_DEFAULT: "3.12"
 UV_VERSION: "0.13.1"
 REGISTRY: ghcr.io
 IMAGE_NAME: ${{ github.repository }}

jobs:
 # ----------------------------------------------------------
 # 1. Lint + types + tests, matrixed on Python.
 # ----------------------------------------------------------
 test:
 name: Test (Python ${{ matrix.python-version }})
 runs-on: ubuntu-24.04
 strategy:
 fail-fast: false
 matrix:
 python-version: ["3.12", "3.13"]
 services:
 postgres:
 image: postgres:17-alpine
 env:
 POSTGRES_USER: boardly
 POSTGRES_PASSWORD: __REDACTED_CI_DB_PASSWORD__
 POSTGRES_DB: boardly_test
 ports: ["5432:5432"]
 options: >-
 --health-cmd "pg_isready -U boardly -d boardly_test"
 --health-interval 5s
 --health-timeout 3s
 --health-retries 12
 redis:
 image: redis:7-alpine
 ports: ["6379:6379"]
 options: >-
 --health-cmd "redis-cli ping"
 --health-interval 5s
 --health-timeout 3s
 --health-retries 10
 env:
 APP_ENV: test
 APP_DATABASE_URL: postgresql+asyncpg://boardly:__REDACTED_CI_DB_PASSWORD__@localhost:5432/boardly_test
 APP_REDIS_URL: redis://localhost:6379/0
 steps:
 - uses: actions/checkout@v4

 - name: Install uv
 uses: astral-sh/setup-uv@v5
 with:
 version: ${{ env.UV_VERSION }}
 enable-cache: true
 cache-dependency-glob: uv.lock
 python-version: ${{ matrix.python-version }}

 - name: Sync dependencies (frozen, all extras)
 run: uv sync --frozen --all-extras

 - name: Ruff (lint + format check)
 run: uv run ruff check . && uv run ruff format --check .

 - name: Mypy
 run: uv run mypy --strict boardly

 - name: Pytest with coverage
 run: uv run pytest --cov=boardly --cov-report=xml --cov-report=term-missing -q

 - name: Upload coverage to Codecov
 if: matrix.python-version == env.PYTHON_VERSION_DEFAULT
 uses: codecov/codecov-action@v5
 with:
 files: ./coverage.xml
 fail_ci_if_error: false
 token: ${{ secrets.CODECOV_TOKEN }}

 # ----------------------------------------------------------
 # 2. Build the Docker image. Runs on every push.
 # ----------------------------------------------------------
 build:
 name: Build image
 runs-on: ubuntu-24.04
 needs: test
 permissions:
 contents: read
 packages: write
 steps:
 - uses: actions/checkout@v4

 - name: Set up Docker Buildx
 uses: docker/setup-buildx-action@v3

 - name: Cache Docker layers
 uses: actions/cache@v4
 with:
 path: /tmp/.docker-cache
 key: docker-${{ runner.os }}-${{ hashFiles('Dockerfile', 'pyproject.toml', 'uv.lock') }}-${{ github.sha }}
 restore-keys: |
 docker-${{ runner.os }}-${{ hashFiles('Dockerfile', 'pyproject.toml', 'uv.lock') }}-
 docker-${{ runner.os }}-

 - name: Build (no push on PRs)
 uses: docker/build-push-action@v6
 with:
 context: .
 file: ./Dockerfile
 target: runtime
 push: false
 tags: boardly:ci
 cache-from: type=gha
 cache-to: type=gha,mode=max
 load: true

 - name: Smoke-test the built image
 run: |
 set -euo pipefail
 docker run --rm -d --name smoke -p 8000:8000 \
 -e APP_ENV=smoke \
 -e APP_DATABASE_URL='sqlite+aiosqlite:///:memory:' \
 -e APP_REDIS_URL='redis://__REDACTED_NO_REDIS_LOCAL__:6379/0' \
 boardly:ci
 sleep 8
 curl -sf http://localhost:8000/healthz | tee /tmp/healthz.json
 docker stop smoke

 # ----------------------------------------------------------
 # 3. Push to GHCR, but only on main. Tagged by SHA + short.
 # ----------------------------------------------------------
 push:
 name: Push image to registry
 runs-on: ubuntu-24.04
 needs: build
 if: github.ref == 'refs/heads/main' && github.event_name == 'push'
 permissions:
 contents: read
 packages: write
 steps:
 - uses: actions/checkout@v4

 - name: Set up Docker Buildx
 uses: docker/setup-buildx-action@v3

 - name: Log in to GHCR
 uses: docker/login-action@v3
 with:
 registry: ${{ env.REGISTRY }}
 username: ${{ github.actor }}
 password: ${{ secrets.GITHUB_TOKEN }}

 - name: Derive lowercase image name (GHCR requires lowercase)
 run: |
 echo "IMAGE_LOWER=$(echo \"${REGISTRY}/${IMAGE_NAME}\" | tr '[:upper:]' '[:lower:]')" >> $GITHUB_ENV

 - name: Build and push
 uses: docker/build-push-action@v6
 with:
 context: .
 file: ./Dockerfile
 target: runtime
 push: true
 tags: |
 ${{ env.IMAGE_LOWER }}:main
 ${{ env.IMAGE_LOWER }}:${{ github.sha }}
 ${{ env.IMAGE_LOWER }}:short-${{ github.ref_name }}-${{ github.run_number }}
 cache-from: type=gha
 cache-to: type=gha,mode=max

 - name: Generate SBOM
 uses: anchore/sbom-action@v0
 with:
 image: ${{ env.IMAGE_LOWER }}:${{ github.sha }}
 format: spdx-json
 output-file: sbom.spdx.json

 - uses: actions/upload-artifact@v4
 with:
 name: sbom
 path: sbom.spdx.json
 retention-days: 30
```

And the `pyproject.toml` excerpts the pipeline depends on:

```toml
[project]
name = "boardly"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
 "fastapi>=0.148.0",
 "uvicorn[standard]>=0.32",
 "sqlalchemy>=2.1.5",
 "asyncpg>=0.30",
 "psycopg[binary]>=3.2",
 "pydantic>=2.14",
 "pydantic-settings>=2.6",
 "redis>=5.2",
]

[project.optional-dependencies]
dev = ["ruff>=0.7", "mypy>=1.13", "pre-commit"]
test = ["pytest>=8.3", "pytest-asyncio>=0.24", "pytest-cov>=6.0", "httpx>=0.28"]

[tool.uv]
# Lock without incremental solves — deterministic across machines.
required-version = ">=0.13.0"

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.mypy]
strict = true
plugins = ["pydantic.mypy"]
```

## Line-by-Line Deep Dive

### Lines 1–6: `name`, `on:` triggers

```yaml
name: CI

on:
 push:
 branches: [main]
 pull_request:
 workflow_dispatch:
```

**What it does:** Names the workflow `CI` (the name shows up in the Actions tab). Triggers it on pushes to `main`, on any pull request, and on manual `workflow_dispatch` runs.

**Why these triggers:**

- `push: branches: [main]` — runs on every push to `main`. This is the post-merge gate: the artifact pushed by the `push` job is what the deploy job (Lesson 4) consumes.
- `pull_request:` (no `branches:` filter) — runs on every PR, regardless of target branch. This is the pre-merge gate: a PR cannot merge if CI fails.
- `workflow_dispatch:` — manual trigger. Lets you re-run the workflow from the Actions UI on any branch, with optional inputs. Useful for "rerun the failed job" without re-pushing.

**Why not trigger on `push:` to every branch?**

Triggering on every push to every branch means `feature/foo` triggers a full pipeline on every commit. With `concurrency: cancel-in-progress: true`, only the latest commit on each branch runs the full pipeline, but you still pay for the cancelled runs. The common pattern is: trigger on `pull_request:` (covers feature branches before merge) and on `push: branches: [main]` (covers the post-merge artifact push). If you push directly to `feature/foo` without a PR, no CI runs — but most teams require a PR, so the trigger is on the PR.


### Lines 8–10: `concurrency`

```yaml
concurrency:
 group: ci-${{ github.ref }}
 cancel-in-progress: true
```

**What it does:** For each `github.ref` (the branch or tag the workflow is running on), GitHub maintains a concurrency group. If a new run lands in the same group while an old run is in progress, the old run is cancelled.

**Why this matters:**

- Without `concurrency`, five rapid pushes to `feature/foo` run five full pipelines in parallel. That is five runners, five `uv sync`s, five image builds — wasted compute and wasted minutes.
- With `concurrency: cancel-in-progress: true`, only the latest commit on each branch runs the full pipeline. The earlier ones are cancelled mid-flight. The Actions UI marks them as cancelled.
- The `group` is the key. `ci-${{ github.ref }}` means each branch has its own group. Two PRs on two different branches run in parallel (different groups); five pushes to one branch cancel each other (same group).
- `cancel-in-progress: true` is the right default for CI. For CD (continuous deployment), use `cancel-in-progress: false` — you do not want to cancel a deploy that is half-done.

### Lines 12–14: `permissions`

```yaml
permissions:
 contents: read
 packages: write
```

**What it does:** Sets the GITHUB_TOKEN's permissions to least-privilege. `contents: read` lets the workflow read the repo (checkout); `packages: write` lets it push to `ghcr.io`.

**Why this matters:**

- The default `GITHUB_TOKEN` permissions depend on the repo setting (Settings -> Actions -> General -> Workflow permissions). The default used to be permissive (everything: write); GitHub has since made `read-all` the default for new repos. Either way, *explicitly* setting `permissions:` at the workflow (or job) level is the right thing — it documents what the workflow actually needs and prevents privilege escalation if the repo default changes.
- Principle of least privilege: the `test` job does not need `packages: write`, but the workflow-level `permissions:` applies to all jobs. We override at the job level where needed (the `test` job has no `permissions:` override, so it inherits the workflow's `packages: write`, but it never *uses* that permission — the principle is to declare what you need, not to restrict what you do not use).

**Danger — Do not put secrets in `permissions:`.**

The `permissions:` block only takes a fixed set of keys (`contents`, `packages`, `id-token`, etc.). It cannot leak secrets. But: if your workflow reads a secret like `${{ secrets.CODECOV_TOKEN }}` in an `env:` block and that env is passed to a step that prints it, the secret can leak in the logs. GitHub redacts known secrets in logs, but only if they are *registered* as secrets in the repo settings. Treat every `${{ secrets.* }}` reference as a potential leak point; never echo it, never use it in a `run:` step that prints intermediate values.


**Danger — How an attacker thinks: `${{ secrets.X }}` in a `run:` step prints to the log.**

A step like `- run: echo "Token is ${{ secrets.CODECOV_TOKEN }}"` writes the token's value to the Actions log in plaintext. GitHub redacts *registered* secrets in logs (replacing them with `::add-mask::` placeholders), but only if the secret value is exactly matched — a secret that is base64-encoded, URL-encoded, or split across lines escapes redaction. A PR from a fork (which has no access to secrets but can suggest a workflow change via a `pull_request_target:` trigger) can exfiltrate secrets by adding `echo "${{ secrets.X }}"` to a step the maintainer's workflow runs. The defenses: never reference `${{ secrets.* }}` in a `run:` step's body — assign it to an env var first (`env: TOKEN: ${{ secrets.X }}` and reference `$TOKEN` in the `run:`). The env-var indirection is not interpolated by GitHub's expression engine, so a fork's PR cannot inject a script that reads the secret. Treat `pull_request_target:` (which runs in the base branch's context, with secret access) as a fork-exfiltration vector; prefer `pull_request:` (which runs in the fork's context, with no secret access). See [[11-Authentication-and-Security/Threat-Model-First]] for the trust-boundary framing.


### Lines 16–21: `env:` (workflow-level)

```yaml
env:
 PYTHON_VERSION_DEFAULT: "3.12"
 UV_VERSION: "0.13.1"
 REGISTRY: ghcr.io
 IMAGE_NAME: ${{ github.repository }}
```

**What it does:** Defines workflow-level env vars. Every job and step can read them via `${{ env.VAR }}` or just `$VAR` in shell.

**Why these values:**

- `PYTHON_VERSION_DEFAULT: "3.12"` — used by the `if:` condition on the coverage-upload step (we upload only once, on the default Python). Also useful for the `build`/`push` jobs to know which Python the "real" image is built with.
- `UV_VERSION: "0.13.1"` — the verified October 2026 version. We pin it explicitly; do not let `setup-uv` pick `latest` (which can break the build on a new major).
- `REGISTRY: ghcr.io` — the GitHub Container Registry. Free for public repos; included in private-repo billing.
- `IMAGE_NAME: ${{ github.repository }}` — the repo's `owner/name` (e.g. `z/boardly`). The image pushed to `ghcr.io` will be `ghcr.io/z/boardly:main`. Note: GHCR requires lowercase, so we lowercase it in the `push` job.

### Lines 23–27: The `test` job header

```yaml
 test:
 name: Test (Python ${{ matrix.python-version }})
 runs-on: ubuntu-24.04
 strategy:
 fail-fast: false
 matrix:
 python-version: ["3.12", "3.13"]
```

**What it does:** Declares the `test` job. It runs on `ubuntu-24.04` (the verified October 2026 runner image), matrixed on Python 3.12 and 3.13.

**Why these choices:**

- `name: Test (Python ${{ matrix.python-version }})` — the human-readable name. Shows up as `Test (Python 3.12)` and `Test (Python 3.13)` in the Actions UI.
- `runs-on: ubuntu-24.04` — the verified October 2026 runner. The older `ubuntu-latest` used to point to `ubuntu-22.04`; pinning to `ubuntu-24.04` avoids surprises when GitHub bumps `latest`.
- `strategy.fail-fast: false` — by default, if one matrix entry fails, GitHub cancels the others. Setting `fail-fast: false` lets both run to completion, so a 3.12-vs-3.13 difference is visible in one pipeline run instead of being masked by a cancellation.
- `matrix: python-version: ["3.12", "3.13"]` — runs the job twice, once with each Python. This catches "this works on 3.12 but not 3.13" before users do. The matrix is a 2x cost in runner time, which is fine for CI; for `main` only (where you only need the canonical version) you could skip the matrix.

**Tip — The matrix is what catches deprecation regressions.**

Python 3.13 deprecated `asyncio.get_event_loop()` (it warns if there is no current loop). A codebase that ran fine on 3.12 might start emitting warnings on 3.13. The matrix catches this before the 3.13 deploy breaks.


**Warning — When this breaks: matrix entries diverge on env var defaults.**

If your `pyproject.toml` has `requires-python = ">=3.12"` but a teammate's local default is 3.13 (or vice versa), the matrix exposes bugs that only show in CI — the test passes on the developer's local 3.12, fails on the 3.13 matrix entry with `AttributeError: module 'asyncio' has no attribute '__readonly__'` (a 3.13-only deprecation). The matrix is a feature, not a flake: investigate every matrix-only failure, because it is the canary for the version your users will be on next. The inverse failure is a CI-only pass: a matrix entry passes because the cache happened to be warm on that Python, fails on another because the cache was cold and the resolver picked a different transitive version. Diagnose with `uv tree --python 3.12` and `uv tree --python 3.13` locally — the dependency trees should be identical except for Python-version-conditional deps. If they differ, pin the transitive in `pyproject.toml` (or accept the divergence and document it). See [[01-Python-Foundations/uv-Tooling-Workflows]] for the `uv tree` flags.


### Lines 28–49: `services:` (Postgres and Redis)

```yaml
 services:
 postgres:
 image: postgres:17-alpine
 env:
 POSTGRES_USER: boardly
 POSTGRES_PASSWORD: __REDACTED_CI_DB_PASSWORD__
 POSTGRES_DB: boardly_test
 ports: ["5432:5432"]
 options: >-
 --health-cmd "pg_isready -U boardly -d boardly_test"
 --health-interval 5s
 --health-timeout 3s
 --health-retries 12
 redis:
 image: redis:7-alpine
 ports: ["6379:6379"]
 options: >-
 --health-cmd "redis-cli ping"
 --health-interval 5s
 --health-timeout 3s
 --health-retries 10
```

**What it does:** Declares two service containers that run alongside the job. `postgres:17-alpine` and `redis:7-alpine` start before any `steps:` run. The job's steps can talk to them at `localhost:5432` and `localhost:6379`.

**Why service containers vs `docker compose`:**

- GitHub Actions supports both. Service containers are simpler for one job; `docker compose up` lets you reuse the project's `compose.yaml`.
- We use service containers because they integrate cleanly with `runs-on: ubuntu-24.04` and need no extra plugin. The same healthcheck logic as Lesson 2's compose applies: the runner pings the port until the `--health-cmd` succeeds, with a timeout.
- The `--health-cmd` syntax mirrors Docker's `docker run --health-cmd ...`. It runs inside the service container; `pg_isready` and `redis-cli` are in the alpine images.

**Why `__REDACTED_CI_DB_PASSWORD__`:**

- This is a placeholder. In a real workflow file, the password would be a GitHub secret: `POSTGRES_PASSWORD: ${{ secrets.CI_DB_PASSWORD }}`. We use `__REDACTED__` here for the same reason Lesson 1 used it — never put real credentials in an example file that might be copy-pasted.
- The CI DB password is a *secret* in the GitHub secrets store, not in the workflow file. The `${{ secrets.* }}` reference is replaced at workflow-parse time and redacted from logs.

**Service containers vs Docker Compose sidecars — the same idea, different surface.**

A compose sidecar (`postgres:` in `compose.yaml`) and a service container (`postgres:` in `services:` in `ci.yml`) are the same idea: a container that runs alongside the app and provides a dependency. The differences are:
- Compose uses the compose network's DNS (you reach Postgres at `postgres:5432`); Actions service containers are reachable at `localhost:PORT` (the runner maps the container port to the runner's localhost).
- Compose `healthcheck:` is a YAML block; Actions `--health-cmd` is a Docker CLI flag in the `options:` string.
- Compose has more flexibility (volumes, depends_on chains); Actions service containers are simpler but less configurable.
We use Compose for local dev (Lesson 2) and Actions service containers for CI (Lesson 3). The tests pass in both because the connection URL is the only thing that differs — `postgres:5432` (compose) vs `localhost:5432` (CI).


**Danger — How an attacker thinks: service-container credentials are visible via `docker inspect`.**

The `POSTGRES_PASSWORD: ${{ secrets.CI_DB_PASSWORD }}` in the `services:` block is interpolated at workflow-parse time and written to the service container's config. Anyone with `docker inspect` access on the runner (a self-hosted runner shared across repos, or a compromised dependency in an earlier step) can `docker inspect <hash> | jq '.Config.Env'` and read the password in plaintext. On GitHub-hosted runners (`ubuntu-24.04`) this is mitigated by the runner being ephemeral and isolated — the runner VM is destroyed after the job, and the docker daemon is local to the VM. On self-hosted runners it is a real attack surface: a shared runner across repos means repo A's job can `docker inspect` repo B's service container from a previous run. The defenses: (a) use GitHub-hosted runners for any job that touches a secret — self-hosted runners should be reserved for jobs that need no secrets (e.g. a docs build); (b) on self-hosted runners, isolate the runner per-repo with a dedicated VM and scrub `docker system prune -af --volumes` between jobs; (c) prefer short-lived credentials (the CI DB password rotates per-run via `aws-actions/configure-aws-credentials` STS tokens, so even a leak expires in 15 minutes) over a long-lived secret in the secrets store.


### Lines 50–53: The `test` job env

```yaml
 env:
 APP_ENV: test
 APP_DATABASE_URL: postgresql+asyncpg://boardly:__REDACTED_CI_DB_PASSWORD__@localhost:5432/boardly_test
 APP_REDIS_URL: redis://localhost:6379/0
```

**What it does:** Sets the env vars the `Settings` instance reads (via `env_prefix="APP_"`). The `APP_DATABASE_URL` uses `localhost` (the runner's localhost, where the service container's port is forwarded).

**Why `localhost` here and `postgres` in compose:**

- In compose, the `app` container is on the compose network, and `postgres` resolves via DNS to the postgres container's IP. The `app` container's `APP_DATABASE_URL` is `postgresql+asyncpg://...@postgres:5432/...`.
- In GitHub Actions, the `test` job runs *on the runner* (not in a container), and the service containers' ports are forwarded to the runner's `localhost`. So the `Settings` instance reads `localhost:5432`.
- If you ran the `test` job *inside a container* (`container: python:3.12-slim`), the service containers would be on a different network and you would need to use the service name (e.g. `postgres`). The `container:` directive changes the network topology.

### Lines 54–62: The `steps:` start

```yaml
 steps:
 - uses: actions/checkout@v4

 - name: Install uv
 uses: astral-sh/setup-uv@v5
 with:
 version: ${{ env.UV_VERSION }}
 enable-cache: true
 cache-dependency-glob: uv.lock
 python-version: ${{ matrix.python-version }}
```

**What it does:** Step 1 checks out the repo. Step 2 installs `uv 0.13.1` via the `astral-sh/setup-uv` action, with caching enabled and keyed on `uv.lock`.

**Why these choices:**

- `actions/checkout@v4` — the canonical checkout action. `@v4` is the major-version pin (the latest in the `v4.x` series). It does a shallow clone by default (`depth: 1`), which is fast. If your tests need full history (e.g. to count commits for a version number), add `with: fetch-depth: 0`.
- `astral-sh/setup-uv@v5` — the official `uv` installer action. We pin `@v5` (the latest major verified for October 2026). Setting `version: ${{ env.UV_VERSION }}` pins to `0.13.1` specifically.
- `enable-cache: true` — restores `~/.cache/uv` from the GitHub Actions cache. The cache key is `hashFiles(cache-dependency-glob)`.
- `cache-dependency-glob: uv.lock` — the cache key is the hash of `uv.lock`. On a stable lockfile, the cache is restored, and `uv sync` skips downloads. On a lockfile change, the cache is rebuilt.
- `python-version: ${{ matrix.python-version }}` — `setup-uv` also installs Python (via `uv python install`). The matrix's `3.12` or `3.13` is what gets installed.

**What the cache restore looks like in the logs.**

On a cache hit, the step logs `Cache restored successfully` and the subsequent `uv sync` step logs `Found up-to-date packages` and completes in seconds. On a cache miss, the step logs `Cache not found` and `uv sync` downloads every wheel from PyPI (typically 30–90 seconds). The cache hit rate on a stable lockfile is near 100%.


**Production reality: the cache is a trust boundary; a poisoned cache poisons every build.**

The `~/.cache/uv` cache and the `type=gha` Docker layer cache are shared across runs of the same workflow. A compromised dependency (a typosquatted package that got into `uv.lock` via a careless `uv add`) lands in the cache, and every subsequent CI run restores the poisoned cache — the malicious code runs in every build. The `uv.lock` is your first defense: the lockfile pins the SHA-256 of every wheel, and `uv sync --frozen` refuses to fetch a wheel whose hash disagrees. The cache's content is therefore verifiable against the lockfile, and a poisoned cache is detected on the next `uv sync` (it re-downloads the wheel from PyPI when the hash disagrees). The Docker layer cache is harder — a poisoned base image layer (if `FROM python:3.12-slim` was compromised upstream) is in your build's cache and is not re-verified. Mitigate with `trivy image` (or `docker scout`) scanning on every build (a CVE-scan step in the `build` job — see the Verification section's `trivy image --severity HIGH,CRITICAL` exercise), and pin base images by digest (the same lesson the Docker-Compose file teaches for `postgres:17-alpine`). See [[11-Authentication-and-Security/OWASP-API-Top-10]] for the supply-chain framing.


**Spot the subtlety — what if `pyproject.toml` changed but `uv.lock` did not?**

Answer: `uv sync --frozen` will fail with `the lockfile is out of date` because the lockfile does not match `pyproject.toml`. CI fails fast. The developer must run `uv lock` locally to update the lockfile, commit it, and re-push. The `--frozen` flag is what enforces the contract — without it, `uv sync` would silently update the lockfile in CI, masking the disagreement between the manifest and the lockfile. The contract: the lockfile is committed, not generated in CI.


**Warning — When this breaks: `uv.lock` committed in a state that disagrees with `pyproject.toml`.**

The `--frozen` flag refuses to update `uv.lock`, so a developer who edited `pyproject.toml` (added a dep) and forgot to run `uv lock` pushes a commit where CI fails with `the lockfile is out of date`. Good — that is the contract working. The trap is the *opposite*: a developer who runs `uv sync` (no `--frozen`) locally commits an `uv.lock` that silently includes a transitive bump they did not intend (a teammate's `uv add` picked a newer `urllib3` to satisfy a constraint, the lockfile recorded it, the commit went in). CI passes (the lockfile matches `pyproject.toml`), but the deployed image contains the bumped transitive — a supply-chain surprise that surfaces weeks later in an SBOM audit. The fix is a `pre-commit` hook that runs `uv lock --check` (which is `--frozen` for the lockfile only, not the install) and fails locally if the lockfile would change. Confirm: `uv lock --check` exits 0 on a clean lockfile, exits non-zero on a drift. The two flags together (`--check` locally in `pre-commit`, `--frozen` in CI) close both sides of the contract.


### Lines 64–66: `uv sync --frozen --all-extras`

```yaml
 - name: Sync dependencies (frozen, all extras)
 run: uv sync --frozen --all-extras
```

**What it does:** Installs every dependency from `uv.lock` into the runner's `uv`-managed venv, including the `dev` and `test` optional groups.

**Why these flags:**

- `--frozen` — refuses to update `uv.lock` even if `pyproject.toml` changed. If `pyproject.toml` and `uv.lock` disagree, CI fails fast. You can never accidentally ship an image whose lockfile disagrees with its `pyproject.toml`.
- `--all-extras` — include every optional dependency group in `pyproject.toml`'s `[project.optional-dependencies]`. The `dev` group has `ruff`/`mypy`/`pre-commit`; the `test` group has `pytest`/`pytest-asyncio`/`pytest-cov`/`httpx`. Without `--all-extras`, the next step's `uv run ruff` would fail with `ruff not found`.

**Danger — `pip install -r requirements.txt` is wrong for a `uv` project.**

A `uv` project has a `uv.lock`, not a `requirements.txt`. Using `pip install -r requirements.txt` would:
- Lose determinism (no lockfile hash; transitive deps can drift).
- Not include the optional groups (`dev`, `test`).
- Be slower (pip's resolver is famously slow; `uv`'s is fast).
If you see a CI workflow that uses `pip install`, the project is either not using `uv`, or the workflow is wrong. For a `uv` project, `uv sync --frozen --all-extras` is the canonical install command.


**Production reality: `uv tree` is your visibility into the transitive graph.**

`pip install -r requirements.txt` (the wrong path for a `uv` project) loses the lockfile's transitive-pinning; `uv sync --frozen` honours it. But the lockfile is opaque — to see *which* transitive version of `urllib3` your `httpx` resolves to, run `uv tree --invert urllib3`. The output shows the dependency chain (`httpx -> httpcore -> h11 -> urllib3`), which is what you need when a CVE drops on `urllib3` and you want to know whether your `httpx` is affected. `uv tree` is the SBOM for the Python layer; pair it with `anchore/sbom-action` (the SBOM for the image layer) and you have a complete dependency graph from your code's `import` statements down to the `.deb` packages in the runtime image. The two views (Python SBOM + image SBOM) overlap on the wheels inside `/app/.venv`, which is the cross-check that catches a `pip install` that bypassed `uv sync` and shipped an un-locked wheel. See [[01-Python-Foundations/uv-Tooling-Workflows]] for the `uv tree` flags.


### Lines 68–72: `ruff`, `mypy`, `pytest`

```yaml
 - name: Ruff (lint + format check)
 run: uv run ruff check . && uv run ruff format --check .

 - name: Mypy
 run: uv run mypy --strict boardly

 - name: Pytest with coverage
 run: uv run pytest --cov=boardly --cov-report=xml --cov-report=term-missing -q
```

**What it does:** Three sequential steps. If `ruff` fails, `mypy` does not run. If `mypy` fails, `pytest` does not run. The slow steps only run when the fast ones pass.

**Why this order:**

- `ruff check` (lint) — finds unused imports, undefined names, style violations. Fast (1–3 seconds).
- `ruff format --check` — verifies the code is formatted (does not reformat; just checks). Fast.
- `mypy --strict` — type-checks the code. Medium (10–60 seconds depending on codebase size).
- `pytest --cov` — runs the tests with coverage. Slow (30–300 seconds depending on test count and DB-touching).
- The order is fail-fast: lint first because it is fastest and catches the most trivial mistakes; types next because it is medium-fast and catches structural bugs; tests last because they are slow and need the service containers up.

**Why these flags:**

- `uv run ruff ...` — `uv run` runs the command in the project's venv, with the project's deps available. Equivalent to `(source .venv/bin/activate && ruff ...)` but cleaner.
- `--cov=boardly` — measure coverage of the `boardly` package. Not the `tests/` package; we do not need coverage of the tests themselves.
- `--cov-report=xml` — write `coverage.xml` for Codecov upload.
- `--cov-report=term-missing` — print the missing-lines summary to the terminal so the developer sees what is not covered.
- `-q` — quiet. Less output, faster log scrolling.

### Lines 74–80: Coverage upload

```yaml
 - name: Upload coverage to Codecov
 if: matrix.python-version == env.PYTHON_VERSION_DEFAULT
 uses: codecov/codecov-action@v5
 with:
 files: ./coverage.xml
 fail_ci_if_error: false
 token: ${{ secrets.CODECOV_TOKEN }}
```

**What it does:** Uploads `coverage.xml` to Codecov, but only on the default Python (`3.12`) to avoid double-uploading.

**Why `if:`:**

- The matrix runs the test step on both `3.12` and `3.13`. Both produce a `coverage.xml`. Uploading both would either double-count or overwrite.
- `if: matrix.python-version == env.PYTHON_VERSION_DEFAULT` restricts the upload to one matrix entry. The other still runs the tests; it just does not upload.

**Why `fail_ci_if_error: false`:**

- Codecov uploads occasionally fail (network, rate limit). We do not want a flaky upload to fail a green build. Set `fail_ci_if_error: false` so the upload is best-effort.
- If you want strict coverage gating, you would add a separate step that compares coverage to a threshold and fails CI if it drops. That is a team decision; we leave it out here.

**`codecov-action@v5` — the verified Oct 2026 major**

`codecov/codecov-action@v5` was released in late 2024 and is the current major as of October 2026 (v4 still works but is superseded). v5 switched to the Codecov API v4 endpoint (faster uploads, better rate limits) and added the `comment-pr` behaviour as a separate step. Pin `@v5` (the major) for the same reason we pin `setup-uv@v5` and `build-push-action@v6`: the major version is the supported-for-Oct-2026 line, and minor / patch updates within a major don't break the workflow. Don't pin to `@v5.0.2` (no security backports if a CVE drops in 5.1); don't pin to `@v4` (out of support window).


**Danger — How an attacker thinks: the Codecov token leaks via the PR comment.**

`codecov-action@v5` with `token: ${{ secrets.CODECOV_TOKEN }}` posts a coverage diff comment on the PR. The comment is visible to anyone who can read the PR — including drive-by commenters on a public repo. The token itself is not in the comment (Codecov's API uses it server-side), but a fork's PR can trigger the action and the action's logs (if `fail_ci_if_error: false` and a debug log is on) can leak the token's first few characters via an error message — enough for an attacker to confirm the secret exists and start probing. The defenses: (a) set `CODECOV_TOKEN` as a *repo* secret, not an *environment* secret, so forks' PRs do not get it (GitHub withholds repo secrets from `pull_request` events triggered by forks); (b) require `pull_request:` (not `pull_request_target:`) for the test job, so fork PRs run in the fork's context with no secret access; (c) rotate the Codecov token on a schedule (it is a third-party SaaS — treat it as a regularly-leaked credential, like a `npm` publish token). The same logic applies to any third-party action that posts to PRs (`coveralls`, `sonarcloud`, etc.).


### Lines 83–91: The `build` job header

```yaml
 build:
 name: Build image
 runs-on: ubuntu-24.04
 needs: test
 permissions:
 contents: read
 packages: write
 steps:
 - uses: actions/checkout@v4
```

**What it does:** Declares the `build` job. It runs on `ubuntu-24.04`, depends on `test` finishing first, has its own `permissions:` block, and starts by checking out the repo.

**Why `needs: test`:**

- Without `needs:`, jobs run in parallel. `build` would start at the same time as `test`, building an image of untested code. If `test` fails, `build` is wasted compute.
- `needs: test` serializes: `build` only runs if *all* matrix entries of `test` pass. The image is built only from tested code.
- The `permissions:` block on `build` is redundant with the workflow-level block, but it documents that the build job needs `packages: write` (it pushes to GHCR in the next job, but the build job itself only builds — it does not push). Actually, `build` does not push, so it does not strictly need `packages: write`. We include it for consistency.

### Lines 93–96: `setup-buildx`

```yaml
 - name: Set up Docker Buildx
 uses: docker/setup-buildx-action@v3
```

**What it does:** Installs Docker Buildx (the modern builder). Buildx is what understands `cache-from: type=gha` and the `--mount` syntax we used in Lesson 1.

**Why this step:**

- The runner has Docker installed (it is `ubuntu-24.04` with Docker preinstalled). But the *legacy* builder does not support BuildKit features. `setup-buildx-action` installs and configures the Buildx builder, which uses BuildKit by default.
- Without this step, `docker/build-push-action` would fall back to the legacy builder and `cache-from: type=gha` would be ignored.

### Lines 98–104: The `actions/cache` for Docker

```yaml
 - name: Cache Docker layers
 uses: actions/cache@v4
 with:
 path: /tmp/.docker-cache
 key: docker-${{ runner.os }}-${{ hashFiles('Dockerfile', 'pyproject.toml', 'uv.lock') }}-${{ github.sha }}
 restore-keys: |
 docker-${{ runner.os }}-${{ hashFiles('Dockerfile', 'pyproject.toml', 'uv.lock') }}-
 docker-${{ runner.os }}-
```

**What it does:** Caches the Docker layer cache at `/tmp/.docker-cache` (a directory the runner has). On the next run, the cache is restored, and the build reuses layers.

**Why this in addition to `cache-from: type=gha`:**

- We have *two* Docker cache mechanisms here. They are not redundant; they cover different cases.
- `cache-from: type=gha` (used in the next step) stores layer cache in the GitHub Actions cache *backend*. Buildx reads and writes this cache directly during `docker build`.
- `actions/cache@v4` is the older, generic cache mechanism — it caches a directory and restores it on the next run.
- The pattern `actions/cache` on `/tmp/.docker-cache` + `cache-from: type=gha` is belt-and-braces. In practice, `cache-from: type=gha` alone is sufficient for Buildx builds, and the `actions/cache` step can be removed. We include both because some teams have CI runners with a custom Buildx setup that does not support `type=gha` (e.g. self-hosted runners behind a proxy); the `actions/cache` step is the fallback.
- The `key` is `docker-${{ runner.os }}-${{ hashFiles('Dockerfile', 'pyproject.toml', 'uv.lock') }}-${{ github.sha }}`. The `hashFiles` part means the cache key changes if any of those three files change. The `${{ github.sha }}` means the key is unique per commit (so a new commit starts with a fresh key, restored from the previous commit's key via the `restore-keys`).

**Tip — `restore-keys` is a fallback chain.**

The `key` is the *exact* key to look for; if not found, `restore-keys` is a list of partial keys to look for, in order. The first one that matches is restored.
- `docker-Linux-<hashfiles-sha>-` — restore the cache from the same commit (should not exist; we just wrote it).
- `docker-Linux-<hashfiles>-` — restore from the same `Dockerfile`/`pyproject`/`uv.lock` hash, regardless of commit. This is the common cache-hit case.
- `docker-Linux-` — restore from any Linux cache, regardless of file hashes. This is the "no exact match but better than nothing" fallback.


**Warning — When this breaks: the cache key is too coarse, and a stale cache is restored.**

The `actions/cache@v4` `key: docker-${{ runner.os }}-${{ hashFiles(...) }}-${{ github.sha }}` is *unique per commit* — the `restore-keys` is what restores from a previous commit. If `hashFiles('Dockerfile', 'pyproject.toml', 'uv.lock')` is the same across two unrelated commits (say, you reverted a `Dockerfile` change and then re-applied it), the cache is restored from the older commit. In rare cases (a Dockerfile `ARG` change that does not affect the file content but changes the build, because the `ARG` is set via `--build-arg` from a `key` not hashed; or a `.dockerignore` change that does not appear in `hashFiles`), the restored cache is *wrong* — the layers do not match the new build. The fix is to include any `ARG`-influencing files in the `hashFiles` list (e.g. `.env.example` if the `Dockerfile` reads `ARG APP_VERSION` from it, or `.dockerignore` itself). Diagnose by setting `ACTIONS_STEP_DEBUG=true` (a repo setting) and reading the cache-restore logs for the restored key — if the key does not end in the current commit's SHA, the cache is a restore, not a write. The `type=gha` Buildx cache has the same hazard; its `key` is implicit (Buildx manages it), and a `cache-from` miss is silent.


### Lines 106–114: `docker/build-push-action` (build, no push)

```yaml
 - name: Build (no push on PRs)
 uses: docker/build-push-action@v6
 with:
 context: .
 file: ./Dockerfile
 target: runtime
 push: false
 tags: boardly:ci
 cache-from: type=gha
 cache-to: type=gha,mode=max
 load: true
```

**What it does:** Builds the `runtime` target of the Lesson 1 Dockerfile, tags it as `boardly:ci`, does not push, loads it into the runner's Docker daemon so the next step can `docker run` it.

**Why these arguments:**

- `context: .` — the build context. `.` means the repo root. Subject to `.dockerignore`.
- `file: ./Dockerfile` — explicit. Defaults to `Dockerfile`.
- `target: runtime` — build only up to the `runtime` stage, not the `dev` stage (we do not need dev extras in the image CI builds and pushes).
- `push: false` — do not push. The `build` job is a sanity check; only the `push` job (which runs only on `main`) pushes.
- `tags: boardly:ci` — local tag for the runner. Not pushed.
- `cache-from: type=gha` — read the Docker layer cache from the GitHub Actions cache backend.
- `cache-to: type=gha,mode=max` — write the Docker layer cache back to the GitHub Actions cache, in `max` mode (cache all layers, not just the final one). `mode=max` is what makes a one-line code change reuse every layer up to the `COPY ./boardly` step.
- `load: true` — load the built image into the runner's Docker daemon. Without this, the image is built but not available to `docker run`. (This is a Buildx quirk; `load: true` is the equivalent of `docker build`'s default behaviour of loading the image into the daemon.)

### Lines 116–123: Smoke-test the image

```yaml
 - name: Smoke-test the built image
 run: |
 set -euo pipefail
 docker run --rm -d --name smoke -p 8000:8000 \
 -e APP_ENV=smoke \
 -e APP_DATABASE_URL='sqlite+aiosqlite:///:memory:' \
 -e APP_REDIS_URL='redis://__REDACTED_NO_REDIS_LOCAL__:6379/0' \
 boardly:ci
 sleep 8
 curl -sf http://localhost:8000/healthz | tee /tmp/healthz.json
 docker stop smoke
```

**What it does:** Runs the built image, hits `/healthz`, and tears it down.

**Why this step matters:**

- The image builds. But does the app inside it *start*? A missing `libpq5` in the runtime stage (the Lesson 1 Dockerfile), a wrong `ENTRYPOINT`, a bad `PYTHONPATH` — all of these produce an image that builds but an app that segfaults on startup. The smoke test catches this before the image is pushed.
- `docker run --rm -d --name smoke -p 8000:8000` — `-d` detaches, `--rm` removes on exit, `--name smoke` gives it a stable name for `docker stop`. `-p 8000:8000` forwards the runner's 8000 to the container's 8000.
- The env vars use `sqlite+aiosqlite:///:memory:` for the DB and a placeholder for Redis. The smoke test only hits `/healthz`, which does not touch the DB or Redis (Lesson 1). So the placeholders are fine — the smoke test just verifies the process starts and serves.
- `sleep 8` — wait for `uvicorn` to start. With `tini` + lifespan startup, 8 seconds is generous; the start-period in the Lesson 1 HEALTHCHECK is 15s, but `uvicorn` is usually ready in 1–2s.
- `curl -sf` — `-s` silent, `-f` fail on HTTP 4xx/5xx. `tee /tmp/healthz.json` — print the response and save it. If `curl` fails, the step fails.
- `docker stop smoke` — clean up. The `--rm` would clean up on the container's own exit, but explicit is better.

**Why a smoke test and not a full integration test in the image?**

The image smoke test is a *build* verification, not a *behaviour* verification. The behaviour verification happened in the `test` job (which ran `pytest`). The image smoke test answers one question: "does the image start?" — which is a question `pytest` cannot answer because `pytest` does not run inside the image. A full integration test inside the image is a good follow-up but is slower; the smoke test is the minimum viable check.


**Production reality: the smoke test hits `/healthz`, not the cold-start path.**

The `curl -sf http://localhost:8000/healthz` smoke test confirms the process started and the HTTP listener is up. It does *not* exercise the cold-start path — the first request that hits the app's lifespan startup, opens the engine pool, runs migrations, warms the cache. A prod image that segfaults on lifespan startup (a missing `libpq5` weeded out by the smoke test) is caught; a prod image that boots fine but crashes on the first real request (a model import that fails because `pydantic` 2.14 deprecated a feature in 2.15) is not. The fix is to smoke-test a real endpoint (`curl /readyz` which touches the DB, or `curl /api/v1/health` which opens a session) and to assert the response body, not just the HTTP 200. The smoke test is a build verification; a post-deploy canary (1% of traffic to the new image for 5 minutes, watching the error rate) is the cold-start verification. See [[02b-Backend-Foundations/Health-Checks-and-Probes]] for the `/healthz` vs `/readyz` distinction.


### Lines 126–133: The `push` job header

```yaml
 push:
 name: Push image to registry
 runs-on: ubuntu-24.04
 needs: build
 if: github.ref == 'refs/heads/main' && github.event_name == 'push'
 permissions:
 contents: read
 packages: write
 steps:
 - uses: actions/checkout@v4
```

**What it does:** Declares the `push` job. Runs on `ubuntu-24.04`, depends on `build`, but only runs on pushes to `main`.

**Why the `if:`:**

- `github.ref == 'refs/heads/main'` — only on the `main` branch. Not on feature branches, not on tags.
- `github.event_name == 'push'` — only on a push event, not on a `pull_request` event. This is a subtle distinction: a `pull_request` event has `github.ref == refs/pull/N/merge`, not `refs/heads/main`, so the first condition alone would suffice, but the explicit `event_name == 'push'` is clearer.
- The combination means: only on pushes to `main`. PRs do not push. Feature-branch pushes (if you trigger on `push:` to other branches) do not push. Tags do not push (you could add a tag-triggered push for releases).

### Lines 135–144: Buildx + GHCR login

```yaml
 - name: Set up Docker Buildx
 uses: docker/setup-buildx-action@v3

 - name: Log in to GHCR
 uses: docker/login-action@v3
 with:
 registry: ${{ env.REGISTRY }}
 username: ${{ github.actor }}
 password: ${{ secrets.GITHUB_TOKEN }}
```

**What it does:** Reinstalls Buildx (the previous job's Buildx is gone — each job runs on a fresh runner) and logs in to `ghcr.io` using the workflow's `GITHUB_TOKEN`.

**Why `secrets.GITHUB_TOKEN`:**

- `GITHUB_TOKEN` is automatically provisioned by GitHub for every workflow run. It is *not* a user's PAT — it is a per-run, per-repo token. Its permissions are constrained by the `permissions:` block.
- The token is valid for the duration of the job. It is automatically revoked when the job ends.
- Logging in with `GITHUB_TOKEN` lets the workflow push to `ghcr.io/<owner>/<repo>`. It cannot push to *other* repos' packages — for that, you need a PAT (Personal Access Token) with `write:packages` scope, stored as a secret.

### Lines 146–149: Lowercase the image name

```yaml
 - name: Derive lowercase image name (GHCR requires lowercase)
 run: |
 echo "IMAGE_LOWER=$(echo \"${REGISTRY}/${IMAGE_NAME}\" | tr '[:upper:]' '[:lower:]')" >> $GITHUB_ENV
```

**What it does:** Sets a new env var `IMAGE_LOWER` that is `${REGISTRY}/${IMAGE_NAME}` lowercased. So `ghcr.io/Z/Boardly` becomes `ghcr.io/z/boardly`.

**Why this step:**

- GHCR (and most registries) require the image name to be lowercase. `${{ github.repository }}` is the repo's `owner/name`, which can have uppercase letters (e.g. `Z/Boardly`). Pushing to `ghcr.io/Z/Boardly:main` fails with an opaque error.
- The fix is to lowercase. The `tr` command does that. We write the result to `$GITHUB_ENV` (a special file that GitHub reads at the end of each step to populate the env for subsequent steps).
- An alternative is to use `bash`'s parameter expansion `${VAR,,}` (lowercase), but `tr` is more portable.

### Lines 151–162: Build and push

```yaml
 - name: Build and push
 uses: docker/build-push-action@v6
 with:
 context: .
 file: ./Dockerfile
 target: runtime
 push: true
 tags: |
 ${{ env.IMAGE_LOWER }}:main
 ${{ env.IMAGE_LOWER }}:${{ github.sha }}
 ${{ env.IMAGE_LOWER }}:short-${{ github.ref_name }}-${{ github.run_number }}
 cache-from: type=gha
 cache-to: type=gha,mode=max
```

**What it does:** Builds the `runtime` target again (this time with `push: true`) and pushes three tags to GHCR.

**Why three tags:**

- `:main` — the rolling tag for the latest on `main`. Useful for "pull whatever is on main" (e.g. a staging deploy).
- `:${{ github.sha }}` — the immutable tag. The SHA is the commit hash. This tag never changes; it points at exactly this build forever. This is what the deploy job (Lesson 4) pins to.
- `:short-${{ github.ref_name }}-${{ github.run_number }}` — a human-readable tag like `short-main-42`. Useful for `docker images` inspection and for "deploy build 42 to staging".

**Danger — `:latest` is not a tag you should push.**

`:latest` floats. If you push `:latest` on every commit, what `:latest` *is* changes constantly. The cluster pulling `:latest` gets a different image every time. Rollback is impossible (what was `:latest` before this push?). The rule: tag with the SHA (immutable) and a readable per-build tag. Reserve `:latest` for nothing — or, if you must, treat it as a "best-known-good" pointer that you only update on a release.


**Production reality: immutable tags are the floor; `cosign` signatures are the wall.**

Tagging by SHA (`:${{ github.sha }}`) is immutable — the registry refuses to overwrite a tag that points to a different manifest. But a `:main` tag is mutable — every push to `main` overwrites it. The deploy job (Lesson 4) should pin to the SHA, not `:main`, so rollback is `kubectl set image deployment/boardly boardly=ghcr.io/...:<previous-SHA>`. The next layer of defense is image signing: `cosign sign --key <cosign-key> <image>:<SHA>` produces a detached signature in the registry; the deploy job verifies with `cosign verify --key <cosign-key> <image>:<SHA>` before pulling. This catches a registry compromise (someone pushed a malicious image under a known SHA — impossible under normal registry semantics, but a stolen registry credential can delete and re-push, in which case the SHA tag points at the malicious manifest). The keyless variant (`cosign sign --yes` with no `--key`, using the GitHub OIDC token) eliminates the private-key-to-rotate problem; the existing Advanced exercise covers key-based signing, the Beginner-Plus cosign exercise at the end covers keyless. See [[16-Deployment-and-DevOps/Deployment-Targets-When-To-Use-What]] for the per-target verification story.


### Lines 164–172: SBOM + artifact upload

```yaml
 - name: Generate SBOM
 uses: anchore/sbom-action@v0
 with:
 image: ${{ env.IMAGE_LOWER }}:${{ github.sha }}
 format: spdx-json
 output-file: sbom.spdx.json

 - uses: actions/upload-artifact@v4
 with:
 name: sbom
 path: sbom.spdx.json
 retention-days: 30
```

**What it does:** Generates an SBOM (Software Bill of Materials) for the pushed image and uploads it as a workflow artifact.

**Why an SBOM:**

- An SBOM is a list of every package in the image, with versions and licenses. When a CVE drops on `pydantic` or `cryptography`, the SBOM tells you which images contain the vulnerable version.
- `anchore/sbom-action` uses Syft to scan the image and produce an SPDX-JSON file. SPDX is a standard SBOM format.
- The artifact is uploaded with `retention-days: 30`. After 30 days, GitHub deletes it. For long-term retention, ship the SBOM to a separate store (S3, Artifactory) — but 30 days is enough for "the CVE dropped last week; which images from last week are affected?"

**Warning — When this breaks: the SBOM was correct at push time, the image drifted by deploy time.**

`anchore/sbom-action` scans the image at push time and uploads the SBOM as an artifact with 30-day retention. If the deploy job (Lesson 4) pulls `:<SHA>` a week later and runs it, the SBOM still matches (the SHA is immutable, so the manifest is byte-identical). But if the deploy job pulls `:main` (a floating tag), the SBOM uploaded on Monday is for image X, the deploy on Friday pulls image Y under the same `:main` tag — the SBOM is stale. A CVE that drops on Wednesday on a dep in image Y is not findable in Monday's SBOM (the SBOM says "image X does not have the dep"; the deployed image Y does). The fix is two-fold: (a) deploy by SHA, not by `:main` — the SBOM and the deployed image share a SHA tag and cannot drift; (b) re-scan the deployed image on a schedule (`anchore/sbom-action` on a `schedule:` trigger, scanning `:main` weekly — see the Beginner-Plus `schedule:` exercise) so a CVE that drops after deploy is still surfaced. The SBOM is a snapshot, not a living document; a weekly rescan is what keeps it honest.


## Execution Trace

The pipeline runs as follows on a push to `main`:

1. **`test` matrix** runs on Python 3.12 and 3.13 in parallel. Each job:
 1. Pulls `postgres:17-alpine` and `redis:7-alpine` service containers; the runner pings the ports until `pg_isready` and `redis-cli ping` succeed (typically 5–10 seconds).
 2. `actions/checkout@v4` clones the repo (shallow).
 3. `astral-sh/setup-uv@v5` installs `uv 0.13.1`, restores `~/.cache/uv` from the cache (key = `hashFiles(uv.lock)`).
 4. `uv sync --frozen --all-extras` runs (typically 5–15 seconds on cache hit, 60–90 seconds on cache miss).
 5. `ruff check`, `ruff format --check`, `mypy --strict boardly`, `pytest --cov` run in sequence.
 6. On Python 3.12, `codecov-action` uploads `coverage.xml`.
2. **`build`** runs after both `test` matrix entries pass:
 1. Restores Docker layer cache from `type=gha`.
 2. `docker/build-push-action` builds the `runtime` target with `push: false`, `load: true`. Image is `boardly:ci` in the runner's daemon.
 3. Smoke-runs the image: `docker run -d`, `sleep 8`, `curl /healthz`, `docker stop`.
3. **`push`** runs only on `main`:
 1. Logs in to GHCR with `GITHUB_TOKEN`.
 2. Builds and pushes tags `:main`, `:<SHA>`, `:short-main-N`.
 3. `anchore/sbom-action` scans the `:<SHA>` image and produces `sbom.spdx.json`.
 4. `actions/upload-artifact` uploads the SBOM as a workflow artifact.

```mermaid
flowchart TB
 P(["push / PR to main"]) --> T1["test (Python 3.12)"]
 P --> T2["test (Python 3.13)"]
 T1 --> L["ruff check + format"]
 T2 --> L
 L --> M["mypy --strict"]
 M --> Y["pytest --cov"]
 Y --> UP{main?}
 UP -- no --> Done(["done, image built locally"])
 UP -- yes --> B["build<br/>Docker, cache-from=gha"]
 B --> S["smoke run /healthz"]
 S --> PU["push to ghcr.io<br/>:main, :SHA, :short-..."]
 PU --> SB["SBOM (anchore)"]
 SB --> Art["upload SBOM artifact"]

 style P fill:#fff3cd,stroke:#856404
 style T1 fill:#cce5ff,stroke:#007bff
 style T2 fill:#cce5ff,stroke:#007bff
 style B fill:#d4edda,stroke:#28a745
 style PU fill:#d4edda,stroke:#28a745
 style SB fill:#f8d7da,stroke:#dc3545
```

**You have a working CI pipeline.**

Every push and every PR runs lint, types, tests with coverage, builds the image, and (on `main`) pushes it to a registry with an SBOM. The deploy job (Lesson 4) pulls the SHA-tagged image — no `docker build` in production. The cycle time on a cache hit is well under 10 minutes; on a no-op push it is under 5.


## Common Mistakes

### Mistake 1: `pip install -r requirements.txt`

```yaml
# WRONG
- run: pip install -r requirements.txt
- run: pytest
```

**Symptom:** No determinism (no lockfile hash), slower, and the optional groups (`dev`, `test`) are not installed. `ruff` is not found.

**Fix:** `uv sync --frozen --all-extras` then `uv run pytest`. For a `uv` project, this is the canonical install command.

### Mistake 2: No `concurrency` block

```yaml
# WRONG — no concurrency
on: [push, pull_request]
```

**Symptom:** Five rapid pushes to a feature branch run five full pipelines in parallel. Five runners, five caches, five image builds — wasted compute.

**Fix:**
```yaml
concurrency:
 group: ci-${{ github.ref }}
 cancel-in-progress: true
```

### Mistake 3: Service container without `--health-cmd`

```yaml
# WRONG
services:
 postgres:
 image: postgres:17-alpine
 ports: ["5432:5432"]
```

**Symptom:** `pytest` connects before Postgres is ready and the first three tests fail spuriously. The pipeline is flaky on every PR.

**Fix:**
```yaml
services:
 postgres:
 image: postgres:17-alpine
 ports: ["5432:5432"]
 options: >-
 --health-cmd "pg_isready -U boardly -d boardly_test"
 --health-interval 5s
 --health-timeout 3s
 --health-retries 12
```

### Mistake 4: Pushing `:latest`

```yaml
# WRONG
tags: |
 ${{ env.IMAGE_LOWER }}:latest
 ${{ env.IMAGE_LOWER }}:${{ github.sha }}
```

**Symptom:** What `:latest` is changes every commit. Rollback is impossible. The cluster pulling `:latest` gets a different image every time.

**Fix:** Tag with `:main`, `:<SHA>`, and `:short-<branch>-N`. Reserve `:latest` for nothing.

### Mistake 5: No smoke test on the built image

```yaml
# WRONG — build but no smoke
- uses: docker/build-push-action@v6
 with:
 push: false
 tags: boardly:ci
```

**Symptom:** The image builds but the app segfaults on startup (a missing `libpq5`, a bad `ENTRYPOINT`). CI says green; the deploy fails in production.

**Fix:** Add the smoke-test step: `docker run -d`, `sleep 8`, `curl /healthz`, `docker stop`.

### Mistake 6: No SBOM

**Symptom:** A CVE drops on `cryptography`. You have no way to know which images contain the vulnerable version. The incident response takes days instead of minutes.

**Fix:** `anchore/sbom-action` on every push; upload the SBOM as a workflow artifact. For long-term retention, ship to S3.

### Mistake 7: Full matrix on `main` only

```yaml
# WRONG — matrix on every trigger
on: [push, pull_request]
jobs:
 test:
 strategy:
 matrix:
 python-version: ["3.10", "3.11", "3.12", "3.13"]
```

**Symptom:** Every PR runs 4x the test job. `main`-only pushes also run 4x. Cost and time balloon.

**Fix:** Run the full matrix on PRs (where you catch version-specific bugs). On `main`, run only the canonical Python. Use `if:` conditions or split into two workflows.

### Mistake 8: Trusting `secrets.GITHUB_TOKEN` to push to a different repo's GHCR

**Symptom:** You try to push to `ghcr.io/other-org/boardly` and it fails with `denied: permission_denied`.

**Why:** `GITHUB_TOKEN` is scoped to the *current* repo. It can push to `ghcr.io/<this-repo-owner>/<this-repo>` only. Cross-repo needs a PAT with `write:packages` scope, stored as a secret.

**Fix:** Use a PAT for cross-repo. Or, restructure so each repo pushes to its own GHCR namespace and downstream repos pull.

## Engineering Trade-Offs

- **Matrix on Python vs. one version.** A matrix catches "this works on 3.12 but not 3.13" before users do. It costs ~2x runner time. Worth it for a library; for an app deployed on one version, run the matrix only on PRs and the single version on `main`.
- **`mypy --strict` vs. looser.** `--strict` makes the type system actually pay. Looser settings catch less. Start strict; carve out per-module exceptions with `[[tool.mypy.overrides]]` when justified.
- **`type=gha` vs. `type=registry` for Docker cache.** `gha` uses the Actions cache, no extra infra. `registry` needs a registry backend. `gha` is the default for small teams.
- **Push on `main` vs. push on tag.** Push on `main` is the simplest "shipping" gate. Push on tag (`v1.2.3`) requires manual tagging but yields cleaner releases. Pick based on whether you release by trunk or by release branch.
- **Running tests inside Docker vs. directly.** Directly (with `uv run pytest`) is faster and gives line-numbered tracebacks. Inside Docker is hermetic. Default to direct; use Docker only when you must reproduce a Docker-specific bug.
- **Service containers vs. `docker compose`.** Service containers are simpler for one job. `docker compose` lets you reuse the project's `compose.yaml` (Lesson 2) and gets you a closer parity between local and CI. We use service containers for simplicity; the same Postgres image is used in both.
- **`astral-sh/setup-uv@v5` vs. installing `uv` manually.** `setup-uv` is one line and handles caching. Manual install (`curl | sh`) is more transparent but loses the cache integration. Use `setup-uv`.

## Exercises

- **Beginner:** Add a `schedule:` trigger so CI runs nightly on `main` to catch flaky tests and CVEs in upstream deps. Configure the nightly run to also build the image and push a `:nightly` tag.
- **Intermediate:** Split the monolithic `test` job into `lint`, `types`, `tests` jobs that run in parallel after a shared `install` job (which runs `uv sync` and is cached). Measure the wall-clock improvement.
- **Advanced:** Sign the pushed image with `cosign` and publish the signature to GHCR. Configure the deploy job (Lesson 4) to verify the signature before deploying. Document the key management story (where is the private key? how is it rotated?).
- **Beginner-Plus (Security):** Audit the workflow for `${{ secrets.* }}` references in `run:` bodies. With `rg -n '\$\{\{ *secrets\.' .github/workflows/` list every reference; for each, confirm it appears in an `env:` block (safe) rather than directly in a `run:` body (leak surface). Move any direct reference to an `env:` block. Fork-PR exfiltration vectors (a PR that adds `echo "${{ secrets.X }}"` to a step the base branch runs) are blocked by `pull_request:` instead of `pull_request_target:`. Verify: `rg -n 'run:.*\$\{\{ *secrets\.' .github/workflows/` returns zero hits; `rg -n '\$\{\{ *secrets\.' .github/workflows/` lists only references inside `env:` blocks.
- **Beginner-Plus (Debugging):** Reproduce a matrix-only failure. Add a test `tests/test_python_version.py` that asserts `sys.version_info[:2] == (3, 12)` and run it under the matrix. Confirm the GitHub Actions log shows the test passes on Python 3.12 and fails on Python 3.13. This is the workflow for triaging matrix-only failures: investigate every one, because it is the canary for the version your users will be on next. Now delete the test and confirm both entries pass. Verify: `uv run pytest tests/test_python_version.py -q` exits 0 on Python 3.12; `uv run pytest tests/test_python_version.py -q` exits non-zero on Python 3.13.
- **Intermediate-Plus (Production):** Add a Dependabot config for GitHub Actions version pinning. Add `.github/dependabot.yml` with `updates: - package-ecosystem: "github-actions" directory: "/" schedule: interval: "weekly"`. Confirm Dependabot opens a PR when `astral-sh/setup-uv@v5` releases a new minor (or when `actions/checkout@v4` releases `v5`). Discuss in a one-paragraph note why pinning to `@v5` (the major) is right for GitHub Actions (security backports within a major, automatic minor/patch bumps via Dependabot) and why `@v5.2.1` (a full pin) is wrong (no security backports if a CVE drops in 5.3). Verify: `cat .github/dependabot.yml` lists `github-actions` as an ecosystem; `rg '@v[0-9]+' .github/workflows/` lists only major-version pins (no full pins).
- **Intermediate-Plus (Debugging):** Add a re-run-on-failure step. After the `pytest` step, add `- name: Rerun failures
  if: failure()
  run: uv run pytest --lf -q` (which re-runs only the failing tests with `--lf` for `pytest-cache`). Confirm that on a flaky test, the rerun step shows the failing test's output isolated from the full suite's output. Discuss when this is useful (flake triage — the rerun gives you a focused log of just the failures) and when it is harmful (masking a real bug as a flake by auto-passing the rerun). Verify: `uv run pytest --lf -q tests/test_flaky.py` exits 0 if the failure was flaky, non-zero if it was real; `uv run pytest --cache-show` lists the last-failing test IDs.
- **Advanced-Plus (Security + Production):** Implement *keyless* `cosign` signing (no private key to manage). Add `permissions: id-token: write` to the `push` job (so it can mint an OIDC token from GitHub's issuer), then `- uses: sigstore/cosign-installer@v3` and `- run: cosign sign --yes ${{ env.IMAGE_LOWER }}:${{ github.sha }}`. Confirm the signature in GHCR has a certificate with `issuer: https://token.actions.githubusercontent.com` and `subject: https://github.com/<owner>/<repo>/.github/workflows/ci.yml@refs/heads/main`. The deploy job (Lesson 4) verifies with `cosign verify --certificate-identity-regexp 'https://github.com/<owner>/<repo>/.+' --certificate-oidc-issuer https://token.actions.githubusercontent.com <image>:<SHA>`. Discuss the advantage over the existing Advanced exercise's key-based approach (no private key to rotate; the identity is the short-lived OIDC token; revocation is "rotate the GitHub App's credentials"). Verify: `cosign verify <image>:<SHA> --certificate-identity-regexp 'https://github.com/.+/.+/.+' --certificate-oidc-issuer https://token.actions.githubusercontent.com` exits 0 (signature verified).
- **Advanced-Plus (Production):** Add a scheduled nightly scan. Add a `nightly` job with `on: schedule: - cron: '0 2 * * *'` that builds the image and scans it with `trivy image --severity HIGH,CRITICAL --exit-code 1 boardly:main`. Upload the scan as an artifact. Confirm the nightly catches a CVE that the per-push SBOM did not (a CVE that drops the day after a push). Discuss the operational cost (a nightly failure pages on-call — gate it behind a Slack notification, not a CI failure, until the team has a triage rota). Verify: `trivy image --severity HIGH,CRITICAL --exit-code 1 boardly:ci` exits non-zero if a HIGH/CRITICAL CVE is present; exits 0 if the image is clean.

## Verification

```bash
# Locally, run the same commands the pipeline runs:
uv sync --frozen --all-extras
uv run ruff check . && uv run ruff format --check .
uv run mypy --strict boardly
uv run pytest --cov=boardly --cov-report=term-missing -q

# Build the image locally (same as the build job):
docker build -t boardly:local --target runtime .

# Smoke-test it (same as the build job's smoke step):
docker run --rm -d --name smoke -p 8000:8000 \
 -e APP_DATABASE_URL='sqlite+aiosqlite:///:memory:' \
 boardly:local
sleep 8
curl -sf http://localhost:8000/healthz
docker stop smoke
```

In GitHub, watch the Actions tab: each job's logs show the cached `uv` restore ("Cache hit occurred", the `uv sync` step takes seconds), the service containers becoming healthy, and the test output. On `main`, the `push` job logs the pushed tags and the SBOM upload.

## Previously Learned Here

- **`uv`** — first taught in [[01-Python-Foundations/uv-Tooling-Workflows]]. The new detail is `enable-cache: true` on `astral-sh/setup-uv`, with `cache-dependency-glob: uv.lock` so cache keys are stable across runners.
- **CI principles** — first taught in [[12-Testing-and-Quality/CI-Pipelines]]. The new detail is the `test -> build -> push` ordering, the `concurrency` block, and the smoke-test on the built image.
- **Container hygiene** — first taught in [[Docker-Multi-Stage-Non-Root]]. The new detail is the `cache-from: type=gha` integration with Buildx and the `target: runtime` build target.
- **Healthchecks** — first taught in [[Docker-Compose-Local-Dev]]. The new detail is the `--health-cmd` option on `services:` in a GitHub Actions workflow, identical in spirit to `pg_isready` and `redis-cli ping`.

## What's Next

The image is now at `ghcr.io/<owner>/<repo>:<SHA>`. The deploy job in [[Migration-Ordering-and-Rollback]]:

- Pulls the SHA-tagged image into the cluster.
- Runs `alembic upgrade head` inside a one-shot container built from the same image, *before* the new code rolls.
- Acquires a `pg_advisory_lock` so two replicas cannot run migrations simultaneously.
- Rolls the new code (e.g. `kubectl rollout restart deployment/boardly` or `docker service update --image ...`).
- Tests the rollback (code first, schema optionally) before the deploy is declared done.

The expand-contract pattern in Lesson 4 is also the foundation for the multi-tenant schema changes in [[17-Advanced-Architecture/Multi-Tenancy]] — adding a `tenant_id` column to an existing table is exactly the kind of change that demands expand-contract.

## Sources

- GitHub Actions — Workflow syntax — <https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions>.
- GitHub Actions — Service containers — <https://docs.github.com/actions/using-containerized-services>.
- `astral-sh/setup-uv` — <https://github.com/astral-sh/setup-uv> — `enable-cache`, `cache-dependency-glob`.
- `docker/build-push-action` — <https://github.com/docker/build-push-action> — `cache-from: type=gha`, `cache-to: type=gha,mode=max`.
- Astral — `uv` CI integration — <https://docs.astral.sh/uv/guides/integration/github/>.
- Anchore — `sbom-action` — <https://github.com/anchore/sbom-action>.
- GitHub — `GITHUB_TOKEN` permissions — <https://docs.github.com/actions/security-guides/automatic-token-authentication>.
- See [[21-Reference-Library/Source-Register]] for the full source list with dates accessed.

## What We Learned

- A `.github/workflows/ci.yml` with a Python 3.12/3.13 matrix, `astral-sh/setup-uv` with `enable-cache`, `uv sync --frozen --all-extras`, ruff, mypy, pytest with coverage, a Docker build with `cache-from: type=gha`, a smoke test on the built image, and a push to `ghcr.io` on `main` with an SBOM.
- The `concurrency: { cancel-in-progress: true }` block kills superseded runs on the same branch.
- `permissions:` at the workflow level restricts `GITHUB_TOKEN` to least-privilege; the `push` job overrides with `packages: write`.
- Service containers with `--health-cmd` (`pg_isready`, `redis-cli ping`) eliminate the "test connects before DB is ready" flake.
- The `test -> build -> push` ordering with `needs:` ensures the image is built only from tested code, and pushed only on `main`.
- The image is tagged with the SHA (immutable, what the deploy job pins), `:main` (rolling), and a readable `:short-<branch>-N`.
- The SBOM (`anchore/sbom-action`) is uploaded as a workflow artifact, retained for 30 days, for CVE incident response.

---

**Tags:** #ci #github-actions #deployment #devops #review
**Previous:** [[16-Deployment-and-DevOps/Docker-Compose-Local-Dev]]
**Next:** [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]] →

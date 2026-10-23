---
title: "Lesson 02: Docker Compose for Local Development"
aliases:
 - compose.yaml local dev
 - Local dev topology
 - Service startup ordering
tags:
 - deployment
 - docker
 - devops
 - local-dev
 - lesson
course_level: intermediate
status: complete
difficulty: intermediate
estimated_time: "60–90 minutes"
prerequisites:
 - "[[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]]"
 - "[[04-Pydantic/Pydantic-Settings]]"
 - "[[07-SQLAlchemy/02-Engines-Connections-Pools]]"
 - "[[14-Caching-and-Background-Processing/Redis-Cache-Aside]]"
related_lessons:
 - "[[Docker-Multi-Stage-Non-Root]]"
 - "[[GitHub-Actions-CI]]"
 - "[[Migration-Ordering-and-Rollback]]"
---

# Lesson 02: Docker Compose for Local Development

*A `compose.yaml` for `Boardly` that boots `app` + `postgres` + `redis` + `adminer`, gates startup order with healthchecks, wires env vars through a `.env`, and bind-mounts the source so `--reload` picks up edits without a rebuild.*

**You're at Lesson 2 of Section 16.**

You built a production image in Lesson 1 — non-root, healthchecked, two-stage, signal-aware. Now we want to develop against it: edit a route, save, see the change in the running container in under a second. We will *not* rebuild the image on every code change. Instead, we override the runtime stage's command with `--reload` and bind-mount the source from the host. The same image runs in production; only the dev-time *overrides* differ. Take your time. Type every line. **This is how you learn.**


#docker #devops #local-dev #compose

## Learning Objectives

By the end of this lesson you will be able to:

1. **Author a `compose.yaml`** with `app`, `postgres:17`, `redis:7`, and `adminer`, each with a healthcheck.
2. **Use `depends_on: condition: service_healthy`** so `app` waits for Postgres and Redis to be *ready*, not just *started*.
3. **Wire env vars through a `.env` file** and into both the compose config (interpolation) and the `app` container (injection) so a `BaseSettings` instance reads them via `env_prefix="APP_"`.
4. **Distinguish named volumes (data, persists) from bind mounts (source, hot-reloaded)** and explain why an anonymous volume is the trick that prevents a host's empty `.venv` from shadowing the container's venv.
5. **Use a `dev` stage** in the `Dockerfile` that inherits from the runtime stage and adds `uv` for syncing dev extras, so a single image supports both prod and dev.
6. **Override the production `CMD` with `--reload`** via a `docker-compose.override.yml` that Compose applies automatically.
7. **Recognise the seven common compose mistakes** — no `condition: service_healthy`, committing the real `.env`, embedding secrets in `compose.yaml`, forgetting the `/app/.venv` anonymous volume, `pg_isready` without `-U` and `-d`, rebuilding on every `up`, and treating named volumes as backups.

## Prerequisites

Before starting, you need:

- **The Dockerfile from Lesson 1** — [[Docker-Multi-Stage-Non-Root]]. The compose stack builds that image with a `dev` target. If you have not done Lesson 1, do it first; the `compose.yaml` here references the `runtime` and `dev` stages by name.
- **Docker Compose v2** (October 2026) — `docker compose version` should print `v2.x`. The `compose.yaml` syntax we use (long-form `depends_on` with `condition:`, `healthcheck:` block, `name:` at top level) requires v2.
- **The Pydantic Settings lesson** — [[04-Pydantic/Pydantic-Settings]]. Env vars flow through a `BaseSettings` instance with `env_prefix="APP_"`.
- **The engine/pool lesson** — [[07-SQLAlchemy/02-Engines-Connections-Pools]]. The engine URL is `postgresql+asyncpg://...@postgres:5432/...`, where `postgres` is the service name Compose's internal DNS resolves.
- **The Redis cache-aside lesson** — [[14-Caching-and-Background-Processing/Redis-Cache-Aside]]. We will configure the local Redis with `--appendonly yes` and a maxmemory so it does not eat your laptop's RAM.

## The Problem

Local development should look like a small model of production: the app, a real Postgres, a real Redis, and a database inspector — all wired together with healthchecks so the app does not start until its dependencies are up. A `compose.yaml` that does this gives every developer on the team an identical environment in one command (`docker compose up`), eliminates "works on my machine" for integration bugs, and is the substrate on which the end-to-end tests in CI run.

But there is a tension with the Lesson 1 image: the production image is *immutable* — `uvicorn boardly.main:app` with the source `COPY`d at build time. Local dev needs the opposite: source mounted from the host, `--reload` on, dev dependencies installed. We resolve the tension by:

1. Adding a `dev` stage to the Lesson 1 `Dockerfile` that inherits from `runtime` and adds `uv` plus dev extras.
2. Using a `compose.yaml` that builds the image targeting the `dev` stage and overrides the `command` with `--reload`.
3. Bind-mounting the host's source directory over `/app/boardly` so edits are visible to the container.

The same Dockerfile, the same image structure, supports both production and local dev. Only the overrides differ.

## The Code

Here is the complete `compose.yaml`. Read it through once; we will go line by line afterwards.

```yaml
# compose.yaml
name: boardly

services:
 app:
 build:
 context: .
 dockerfile: Dockerfile
 target: dev
 image: boardly:local
 env_file: [.env]
 environment:
 APP_ENV: ${APP_ENV:-local}
 APP_LOG_LEVEL: ${APP_LOG_LEVEL:-INFO}
 APP_DATABASE_URL: ${APP_DATABASE_URL}
 APP_REDIS_URL: ${APP_REDIS_URL}
 ports:
 - "8000:8000"
 volumes:
 # Bind-mount source so edits are visible to the container.
 - ./boardly:/app/boardly:cached
 - ./tests:/app/tests:cached
 # Anonymous volume over /app/.venv so the host does not shadow the venv.
 - /app/.venv
 depends_on:
 postgres: { condition: service_healthy }
 redis: { condition: service_healthy }
 restart: unless-stopped

 postgres:
 image: postgres:17-alpine
 environment:
 POSTGRES_USER: ${POSTGRES_USER}
 POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
 POSTGRES_DB: ${POSTGRES_DB}
 volumes:
 - postgres_data:/var/lib/postgresql/data
 healthcheck:
 test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
 interval: 5s
 timeout: 3s
 retries: 12
 start_period: 5s
 restart: unless-stopped

 redis:
 image: redis:7-alpine
 command: ["redis-server", "--appendonly", "yes", "--maxmemory", "256mb", "--maxmemory-policy", "allkeys-lru"]
 volumes:
 - redis_data:/data
 healthcheck:
 test: ["CMD", "redis-cli", "ping"]
 interval: 5s
 timeout: 3s
 retries: 10
 restart: unless-stopped

 adminer:
 image: adminer:5.2.1-standalone
 ports:
 - "8080:8080"
 depends_on:
 postgres: { condition: service_healthy }
 restart: unless-stopped

volumes:
 postgres_data:
 redis_data:
```

And the `docker-compose.override.yml` that Compose applies on top of `compose.yaml` by default (so `docker compose up` uses both, while `docker compose -f compose.yaml up` uses only the base):

```yaml
# docker-compose.override.yml
# Applied on top of compose.yaml by default.
services:
 app:
 build:
 target: dev
 # Override the production CMD with the dev reload server.
 command:
 - uvicorn
 - boardly.main:app
 - --host
 - 0.0.0.0
 - --port
 - 8000
 - --reload
 - --reload-dir
 - /app/boardly
 environment:
 APP_LOG_LEVEL: DEBUG
```

And the `.env.example` (committed; the real `.env` is gitignored):

```dotenv
# .env.example — copy to .env and adjust. NEVER commit the real .env.
APP_ENV=local
APP_LOG_LEVEL=DEBUG

POSTGRES_USER=boardly
POSTGRES_PASSWORD=__REDACTED_CHANGE_ME__
POSTGRES_DB=boardly
POSTGRES_PORT=5432

APP_DATABASE_URL=postgresql+asyncpg://boardly:__REDACTED_CHANGE_ME__@postgres:5432/boardly
APP_REDIS_URL=redis://redis:6379/0
```

And the `dev` stage you append to the Lesson 1 Dockerfile:

```dockerfile
############################
# 3. Dev stage (local only)
############################
FROM runtime AS dev

# Back to root for installs, then drop back to app.
USER root
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /usr/local/bin/uv
RUN apt-get update \
 && apt-get install --no-install-recommends -y git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --all-extras
COPY . .

USER 1000
# No CMD; the override specifies command.
```

## Line-by-Line Deep Dive

### Line 2 of `compose.yaml`: `name: boardly`

```yaml
name: boardly
```

**What it does:** Sets the Compose project name to `boardly`. All containers, networks, and volumes are prefixed with this name (e.g. `boardly-app-1`, `boardly_postgres_data`).

**Why this matters:**

- Without `name:`, Compose derives the project name from the directory the `compose.yaml` lives in. Two clones of the same repo in different directories would have different project names, which is fine but confusing when you `docker ps` and see `my-repo-app-1` and `boardly-fork-app-1` running.
- With `name: boardly`, the project name is the same regardless of where the repo is cloned. The containers are `boardly-app-1`, `boardly-postgres-1`, etc. Cleaner.
- The project name is also the prefix for the default network Compose creates (`boardly_default`), which is what makes the service-name DNS work (see below).

### Lines 4–6: The `app` service `build` block

```yaml
 app:
 build:
 context: .
 dockerfile: Dockerfile
 target: dev
 image: boardly:local
```

**What it does:** Declares the `app` service. It builds from the `Dockerfile` in the current directory, targeting the `dev` stage. The resulting image is tagged `boardly:local` (so `docker images` shows it).

**Why these keys:**

- `context: .` — the build context is the current directory. Everything in the context is sent to the Docker daemon (subject to `.dockerignore`). Keep the context small.
- `dockerfile: Dockerfile` — explicit. Defaults to `Dockerfile`, but stating it is good documentation.
- `target: dev` — builds up to and including the `dev` stage, *not* the `runtime` stage. The `dev` stage (defined at the bottom of the Dockerfile) inherits from `runtime` and adds `uv` and dev extras. Without `target:`, Compose would build the *last* stage — which here is `dev`, so it would still work, but being explicit makes the intent obvious.
- `image: boardly:local` — tags the built image. If you later `docker compose start` (without `up --build`), Compose reuses the existing `boardly:local` image instead of rebuilding.

**Why not just `image:` for `app`?**

If we wrote `image: boardly:local` without `build:`, Compose would try to *pull* `boardly:local` from a registry (and fail). The `build:` block tells Compose to *build* the image instead of pulling. We use both: `build:` to define how to build it, `image:` to tag it.


### Lines 7–12: `env_file` and `environment`

```yaml
 env_file: [.env]
 environment:
 APP_ENV: ${APP_ENV:-local}
 APP_LOG_LEVEL: ${APP_LOG_LEVEL:-INFO}
 APP_DATABASE_URL: ${APP_DATABASE_URL}
 APP_REDIS_URL: ${APP_REDIS_URL}
```

**What it does:** Two layers of env var injection.

1. `env_file: [.env]` — Compose reads the `.env` file and sets every `KEY=VALUE` in it as an env var in the `app` container.
2. `environment:` — explicitly sets four env vars. The values use `${VAR}` interpolation, which Compose resolves from the host environment AND from the `.env` file (yes, Compose reads `.env` for interpolation too — this is a Compose convention, not a shell one).

**Why both:**

- `env_file: [.env]` is convenient — any new var you add to `.env` is automatically in the container. But it is *opaque* — the `compose.yaml` does not show which env vars the app actually needs.
- `environment:` is *explicit* — the `compose.yaml` declares exactly which `APP_*` vars the app consumes. A reader of the `compose.yaml` can see at a glance what the app's settings interface is.
- The `${VAR:-default}` syntax is shell-style default expansion: if `APP_LOG_LEVEL` is set in the host env or in `.env`, use that; otherwise use `INFO`. This is the right place to put a sane default that is overridable per-developer.
- The `${VAR}` syntax (without `:-`) means *required* — if `APP_DATABASE_URL` is not set, Compose warns (or errors, depending on the version) about an unset variable. This catches a missing `.env` early.

**Tip — The `.env` file has two roles.**

1. Compose reads it for `${VAR}` interpolation in the `compose.yaml` itself.
2. Compose reads it (when listed in `env_file:`) and injects every var into the container.

Both happen. A var in `.env` is therefore available both for interpolation (`${APP_DATABASE_URL}` in the `environment:` block) and as a container env var (via `env_file:`). The two paths produce the same result for the container, but the explicit `environment:` declaration is what makes the `compose.yaml` self-documenting.


**Danger — How an attacker thinks: `docker compose config` renders your `.env` in plaintext.**

`docker compose config` (and `docker compose run`) substitutes every `${VAR}` from `.env` and prints the merged YAML to stdout, secrets included. A CI job that does `docker compose config | tee debug.yml` for "diagnostic" purposes lands `APP_DATABASE_URL=postgresql+asyncpg://boardly:realsecret@...` in the Actions log, which is retained for 90 days and downloadable by anyone with read access. The same applies to `docker compose exec app env` — it prints every injected env var, including `APP_REDIS_URL` if Redis had a password. Treat `docker compose config` and `exec env` as you would `cat .env`: never pipe to a persisted log, never echo in a `run:` step. If you must diff configs, do it on a sanitised dump (`docker compose config --no-interpolate` keeps the `${VAR}` tokens). Audit regularly with `docker compose config | grep -iE 'password|secret|token|dsn'` and confirm zero literal values appear when `--no-interpolate` is set. See [[11-Authentication-and-Security/Threat-Model-First]] for the trust-boundary framing.


### Lines 13–14: `ports`

```yaml
 ports:
 - "8000:8000"
```

**What it does:** Forwards host port 8000 to container port 8000. `curl http://localhost:8000/healthz` reaches the container's `uvicorn`.

**Why this matters:**

- The format is `"HOST:CONTAINER"`. `"8000:8000"` means host port 8000 to container port 8000. `"8080:8000"` would mean host 8080 to container 8000.
- You can also write `8000` (just the container port) — Compose picks an ephemeral host port. We avoid this for `app` because we want a stable URL for the developer.
- If two developers run their own compose stacks on the same host, they will clash on port 8000. The fix is to override the host port per-developer (e.g. `PORT=8001` in `.env`, then `ports: ["${PORT}:8000"]`).

**Danger — How an attacker thinks: `ports: "8000:8000"` binds to `0.0.0.0`.**

Compose's short `ports:` form publishes on `0.0.0.0` — every interface of the host. On a laptop that is fine (no LAN exposure matters), but on a cloud dev box (an EC2 instance you SSH into to run the stack), `0.0.0.0:8000` is the public internet. A `DEBUG=true` FastAPI app with auto-docs at `/docs` is now reachable by every scanner on the planet within minutes. The fix is the long form: `ports: ["127.0.0.1:8000:8000"]` binds only to loopback. Verify with `ss -tlnp | grep 8000` from the host — `127.0.0.1:8000` is correct, `0.0.0.0:8000` is the leak. Treat Adminer (`:8080`) the same way; it ships no rate limit and accepts the Postgres password over plaintext HTTP, so an exposed Adminer is effectively a public `psql` console. On a cloud dev box, prefer an SSH tunnel (`ssh -L 8000:localhost:8000 dev-box`) over a published port — the tunnel is loopback-only on both ends. See [[11-Authentication-and-Security/OWASP-API-Top-10]] for the broader exposure taxonomy.


### Lines 15–19: `volumes`

```yaml
 volumes:
 # Bind-mount source so edits are visible to the container.
 - ./boardly:/app/boardly:cached
 - ./tests:/app/tests:cached
 # Anonymous volume over /app/.venv so the host does not shadow the venv.
 - /app/.venv
```

**What it does:** Three mounts.

1. `./boardly:/app/boardly:cached` — a bind mount. The host's `./boardly` directory appears at `/app/boardly` in the container. Edits on the host are visible to the container immediately.
2. `./tests:/app/tests:cached` — same idea, for the tests directory.
3. `/app/.venv` — an *anonymous* volume. Docker creates a fresh volume and mounts it at `/app/.venv`. This *shadows* whatever was at `/app/.venv` in the image (which is the venv the `dev` stage built).

**Why the anonymous volume matters:**

- The bind mount on `/app/boardly` would *also* shadow `/app/.venv` if the host's `./boardly/.venv` existed — but the host does not have a `./boardly/.venv` (the venv is in the image, not in the host's source tree).
- However, if the host *did* have a `.venv` somewhere in the bind-mounted tree (say, the developer ran `uv sync` locally), the host's `.venv` would shadow the container's, and `uvicorn` would suddenly be gone from the container's `PATH`.
- The anonymous volume `/app/.venv` guarantees that the venv *in the image* is what the container sees, regardless of what the host has.
- The `:cached` option is a macOS-specific performance hint. On Linux it is a no-op. On macOS, where Docker runs in a VM, the default mount consistency is `consistent` (slow because the host and VM must agree on every file's state). `:cached` tells Docker that the container's view can be cached — the host is the source of truth, and the container does not need to be notified of every change. This makes bind mounts much faster on macOS. Use `:cached` for source mounts.

**Three mount types, briefly.**

- **Bind mount** (`./host/path:/container/path`): the container sees a host directory live. Used for source code so `--reload` works.
- **Named volume** (`volume_name:/container/path`): Docker manages a volume; the host cannot see its contents directly. Survives `docker compose down` (but not `docker compose down -v`). Used for database data.
- **Anonymous volume** (`/container/path`): Docker creates a fresh unnamed volume and mounts it. Survives the container's lifecycle but is awkward to inspect. Used to *shadow* a path in the image so the host cannot accidentally stomp on it.
- **tmpfs mount** (`/container/path` with `tmpfs:`): lives in RAM, gone on container exit. Used for tests where the DB must start empty.


**Warning — When this breaks: Windows host + bind mount = `from\r import` SyntaxError.**

A developer on Windows who runs `git config --global core.autocrlf true` (the GitHub-for-Windows default) checks out the repo with CRLF line endings. The bind mount `./boardly:/app/boardly:cached` carries those CRLFs into the container verbatim. Python on Linux sees `\r` as a stray character: `SyntaxError: from\r import` on the very first import. `--reload` makes it worse: every save re-saves with CRLF, so the error never goes away. The fix is a `.gitattributes` file with `*.py text eol=lf` (forces LF on checkout regardless of `autocrlf`), plus a `.dockerignore` that does not filter it. Diagnose with `docker compose exec app file /app/boardly/main.py` — `ASCII text` is correct, `ASCII text, with CRLF line terminators` is the bug. The same trap catches `.env` files (CRLF in a dotenv file silently truncates the value, since `\r` becomes part of the value), shell scripts (a `\r` in `#!/bin/sh\r` makes the kernel reject the shebang), and YAML (CRLF in a multiline scalar is parsed as a literal `\r` in the string).


**Danger — How an attacker thinks: a second service re-using the bind mount silently mutates `/app/.venv`.**

If a teammate adds a `worker` service that mounts the same `./boardly:/app/boardly:cached` but forgets the `- /app/.venv` anonymous volume, Docker creates a *fresh* anonymous volume for `worker`'s `/app/.venv` — and the two containers now have different venvs at the same path. `ruff check` runs cleanly in `app` and fails in `worker` (or vice-versa) because the resolved `ruff` binary differs. Worse: if both services bind *the host's* `./.venv` over `/app/.venv` (the exact mistake the anonymous volume exists to prevent), then `uv sync` in one container mutates the host venv while the other container is mid-import — producing nondeterministic `ImportError` traces that disappear on retry. The fix is to declare a *named* volume (`boardly_venv:/app/.venv` in the top-level `volumes:` block, referenced from both services) so both containers see one venv and writes are visible. Audit with `docker compose exec app command -v ruff` and `docker compose exec worker command -v ruff` — the paths must match. See [[01-Python-Foundations/uv-Tooling-Workflows]] for the `uv sync` semantics that make this footgun sharp.


### Lines 20–22: `depends_on` with `condition: service_healthy`

```yaml
 depends_on:
 postgres: { condition: service_healthy }
 redis: { condition: service_healthy }
```

**What it does:** Compose will *not* start the `app` container until both `postgres` and `redis` report `service_healthy`.

**Why this is the load-bearing line:**

- The long-form `depends_on` with `condition:` was the headline feature of Compose v2 (it existed in v1 as `version: 2.1` of the file format, but v1's `depends_on:` was just a list of service names, no conditions).
- The conditions are:
 - `service_started` (the default if you use the short form) — Compose waits for the dependency's container to *start*. This is nearly useless: a Postgres container that has just started is not yet ready to accept connections. The `app` container boots, tries to connect, fails, crashes.
 - `service_healthy` — Compose waits for the dependency's `healthcheck` to report `healthy`. This is what you want.
 - `service_completed_successfully` — Compose waits for the dependency to exit 0. Used for one-shot init containers (e.g. a DB-migration container that runs and exits before the app starts).
- Without this, you have the classic race: `app` boots before Postgres is ready, the engine pool fails to connect, lifespan startup raises, the container restarts (because of `restart: unless-stopped`), and you hope it eventually wins the race. With `service_healthy`, the race is eliminated.

**Warning — `depends_on` only gates startup, not the runtime.**

Once `app` is started, Compose does not monitor `postgres` or `redis`. If `postgres` crashes after `app` is up, `app` keeps running (and starts failing requests). The fix is `restart: unless-stopped` on `postgres` (so it comes back) and proper retry/backoff in `app`'s connection logic. We will see the latter in [[15-External-Integrations/Circuit-Breakers]] and [[15-External-Integrations/HTTP-Clients-Timeouts-Retries]].


**Warning — When this breaks: healthcheck says `healthy`, the app still fails to connect.**

`pg_isready` returning 0 means the postmaster is *accepting connections* — it does not mean the database is *queryable*. During crash recovery (a Postgres container that restarted after an OOM kill), the postmaster accepts connections for several seconds before the recovery script has finished replaying the WAL, and `SELECT 1` returns `FATAL: the database system is in recovery mode`. The app's lifespan startup hits this window and crashes with a misleading `OperationalError: server closed the connection unexpectedly` that is actually "connection accepted, query rejected". Diagnose with `docker compose logs postgres --since 1m | grep -E 'recovery|system is ready'` — the line `database system is ready to accept connections` is the true readiness signal, and it appears *after* the recovery line. The fix is to widen `start_period` (Postgres recovery on a slow disk can take 30+ seconds for a large WAL) and to gate the app's lifespan on an actual `SELECT 1` round-trip, not just the engine's lazy pool construction. See [[02b-Backend-Foundations/Health-Checks-and-Probes]] for the readiness-vs-liveness split that prevents this.


### Line 23: `restart: unless-stopped`

```yaml
 restart: unless-stopped
```

**What it does:** Compose restarts the container if it exits, *unless* it was stopped by `docker compose stop` or `docker compose down`.

**Why this matters:**

- `no` (default) — never restart.
- `on-failure` — restart only on non-zero exit. Useful for one-shot jobs.
- `always` — always restart, even on `docker stop`. Annoying in dev.
- `unless-stopped` — restart on crash, but respect a manual `stop`. This is the right default for local dev: if Postgres crashes, it comes back; if you `docker compose stop`, it stays stopped.

**Production reality: `restart: unless-stopped` is a dev knob, not a prod knob.**

In production, Compose is not your orchestrator (Kubernetes, ECS, Cloud Run is). Those orchestrators have their own restart policies — Kubernetes uses `deploy.restartPolicy: Always` plus liveness/readiness probes; ECS uses `deploymentConfiguration.alarms` and a circuit breaker; Cloud Run retries the container on a 5xx. Setting `restart:` in `compose.yaml` for a prod-faithful base file documents intent, but it is *ignored* the moment the deploy target is Kubernetes — `docker compose down` and a `systemctl reboot` both bypass it, and the orchestrator's policy takes over. The prod-relevant question is not "what is `restart:` in the YAML?" but "what is the orchestrator's restart policy + the liveness probe's `failureThreshold`/`periodSeconds`?". Compose `restart:` is the dev-loop equivalent of a `bash` `while true; do app; sleep 1; done` wrapper — it gets the process back up so you can iterate; it is not a substitute for the orchestrator's policy. See [[16-Deployment-and-DevOps/Deployment-Targets-When-To-Use-What]] for the per-target mapping.


### Lines 25–32: The `postgres` service

```yaml
 postgres:
 image: postgres:17-alpine
 environment:
 POSTGRES_USER: ${POSTGRES_USER}
 POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
 POSTGRES_DB: ${POSTGRES_DB}
 volumes:
 - postgres_data:/var/lib/postgresql/data
 healthcheck:
 test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
 interval: 5s
 timeout: 3s
 retries: 12
 start_period: 5s
 restart: unless-stopped
```

**What it does:** Declares the Postgres 17 service, configures it with the three standard env vars (`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`), mounts the named volume `postgres_data` at the data directory, and runs a `pg_isready`-based healthcheck.

**Why these choices:**

- `postgres:17-alpine` — Postgres 17.x (verified October 2026). The `alpine` variant is smaller (~80 MB) than the Debian variant (~400 MB). Postgres's `alpine` image is well-supported; the only caveat is that some Postgres extensions ship only as Debian packages. If you need an extension, switch to `postgres:17`.
- The three env vars are read by the official Postgres image's entrypoint script. `POSTGRES_USER` and `POSTGRES_DB` create the user and database on first boot (when the data directory is empty). On subsequent boots, the user and DB already exist and the env vars are *ignored* (changing them in `.env` does not retroactively change the DB).
- The volume `postgres_data` is named — Docker manages it, and it survives `docker compose down` and `docker compose up`. Without it, every `down` would wipe your DB. (Note: `docker compose down -v` does wipe the volume — that is the explicit "destroy data" command.)
- The healthcheck: `pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}`. `pg_isready` returns 0 when Postgres is ready to accept connections. Without `-U` and `-d`, `pg_isready` connects as a default user that may not exist, which reports unhealthy even when Postgres is fine.

**Production reality: `postgres:17-alpine` is a floating tag inside the 17.x line.**

The `17-alpine` tag is not pinned to one image — Docker resolves it to whatever 17.x build was most recently pushed to the `postgres` Docker Official Image. A `docker compose pull` can silently upgrade you from `17.4-alpine` to `17.5-alpine`, and a 17.x release can include a planner change that picks a different index for your query (Postgres minor releases do touch the planner from time to time, with a note in the release notes). For local dev this is acceptable (the cost of a regression is low); for CI and prod, pin to `postgres:17.5-alpine` (a minor-pinned tag) or to a digest (`postgres:17-alpine@sha256:<64-hex>` — `docker image inspect postgres:17-alpine --format '{{.Digest}}'` to find it). The digest pin is what makes a CI run bit-for-bit reproducible six months later, and it is what the GitHub Actions CI in the next lesson should use for its service container. See [[08-PostgreSQL/Backups-and-Recovery]] for the upstream-version-vs-data-compatibility matrix that governs when you can skip a minor.


**Why the healthcheck fields:**

- `test:` — the command. `["CMD-SHELL", "..."]` runs the string under `/bin/sh -c`. `["CMD", "pg_isready", "-U", "...", "-d", "..."]` would run `pg_isready` directly without a shell. `CMD-SHELL` is convenient for `${VAR}` interpolation; `CMD` is slightly faster and has no shell-injection risk.
- `interval: 5s` — poll every 5 seconds. Tight, but local dev; the cost is tiny.
- `timeout: 3s` — if `pg_isready` does not exit in 3 seconds, count as a failure.
- `retries: 12` — 12 consecutive failures (60 seconds) before unhealthy. Generous, because the first Postgres boot is slow.
- `start_period: 5s` — for the first 5 seconds, failures don't count. Postgres is still starting.

**Tip — `pg_isready` is your friend.**

`pg_isready` is a Postgres client utility that returns 0 when the server is ready to accept connections and 1 otherwise. It does not authenticate; it just checks the connection handshake. This is *exactly* the right thing to use as a healthcheck — it tells you "is the server listening and accepting connections?" without depending on a specific user existing. The `-U ${POSTGRES_USER}` is technically optional, but without it, `pg_isready` defaults to the current Unix user (e.g. `root`), and the handshake might report a permission error that you would misread as "not ready". Passing `-U` makes the check honest.


**Warning — When this breaks: the healthcheck uses the Unix socket, the app uses TCP.**

The `pg_isready` command in the healthcheck connects via the Postgres Unix socket by default (because the `postgres:17-alpine` image has a socket at `/var/run/postgresql/.s.PGSQL.5432`). The app, however, connects via TCP (`postgresql+asyncpg://...@postgres:5432`). In the rare case where the socket listener is up but the TCP listener is not (an init script that reconfigures `listen_addresses`, a custom `postgresql.conf`, a restarted container whose `unix_socket_directories` was set to a path the `app` container cannot see), the healthcheck passes and the app fails. Force the healthcheck to walk the same path as the app: `pg_isready -h 127.0.0.1 -p 5432 -U ${POSTGRES_USER} -d ${POSTGRES_DB}`. Diagnose with `docker compose exec postgres ss -tlnp | grep 5432` — `127.0.0.1:5432` or `0.0.0.0:5432` is correct, an empty result is the bug. The same lesson applies in reverse: if your app uses the Unix socket (some sidecar setups do), make the healthcheck use the socket too — divergence between the two paths is a silent flake.


**Production reality: managed Postgres hides a standby behind the LB.**

In production, your app talks to a managed Postgres (RDS, Cloud SQL, Aurora). The connection string points at a DNS name that resolves to a network load balancer; behind the LB is a primary and one or more standbys. `pg_isready` against the LB returns "ready" as long as *any* backend accepts the connection — including a read-only standby that rejects `INSERT` with `cannot execute INSERT in a read-only transaction`. A failover that promotes a standby to primary can momentarily route writes to the wrong node. The prod-grade readiness check is a SQL query, not a network ping: `SELECT pg_is_in_recovery()` returns `false` only on a writable primary. Wire that into the readiness probe (or the app's lifespan startup) so you never declare "ready" while pointing at a standby. See [[02b-Backend-Foundations/Health-Checks-and-Probes]] for the probe taxonomy and [[08-PostgreSQL/Backups-and-Recovery]] for the standby-promotion semantics.


### Lines 34–42: The `redis` service

```yaml
 redis:
 image: redis:7-alpine
 command: ["redis-server", "--appendonly", "yes", "--maxmemory", "256mb", "--maxmemory-policy", "allkeys-lru"]
 volumes:
 - redis_data:/data
 healthcheck:
 test: ["CMD", "redis-cli", "ping"]
 interval: 5s
 timeout: 3s
 retries: 10
 restart: unless-stopped
```

**What it does:** Declares the Redis 7 service, overrides the default `redis-server` command with extra flags, mounts a named volume, and runs a `redis-cli ping` healthcheck.

**Why these choices:**

- `redis:7-alpine` — Redis 7.x (verified October 2026). The `alpine` variant is ~10 MB.
- `command: ["redis-server", "--appendonly", "yes", "--maxmemory", "256mb", "--maxmemory-policy", "allkeys-lru"]` — overrides the image's default `CMD`. The flags:
 - `--appendonly yes` — enables AOF (append-only file) persistence. Writes go to a log on disk; Redis can recover after a restart. Without this, Redis is in-memory only and you lose everything on container restart.
 - `--maxmemory 256mb` — cap Redis at 256 MB of resident memory. Local dev; you do not want Redis eating your laptop.
 - `--maxmemory-policy allkeys-lru` — when the 256 MB is full, evict the least-recently-used key. This is the cache-aside pattern's expected behavior — Redis is a cache, not a system of record. See [[14-Caching-and-Background-Processing/Redis-Cache-Aside]].
- `redis-cli ping` healthcheck — `redis-cli` is in the `redis:7-alpine` image. `PING` returns `PONG` if Redis is up. Simple, fast, correct.
- The named volume `redis_data` mounts at `/data` (where Redis writes its AOF and RDB files). Survives `down`.

**The exec-form `command:` in compose vs the `CMD` in the Dockerfile.**

The `command:` in compose is the *override* of the image's `CMD`. The exec form (a YAML list) is the equivalent of the Dockerfile's exec-form `CMD` — Docker runs the binary directly, no shell. If you wrote `command: redis-server --appendonly yes ...` (a string), Docker would run `/bin/sh -c "redis-server --appendonly yes ..."`, which is slower and has signal-handling issues. Always use the list form.


### Lines 44–50: The `adminer` service

```yaml
 adminer:
 image: adminer:5.2.1-standalone
 ports:
 - "8080:8080"
 depends_on:
 postgres: { condition: service_healthy }
 restart: unless-stopped
```

**What it does:** Runs Adminer (a single-file PHP database inspector) on `http://localhost:8080`, gated on Postgres being healthy.

**Why include Adminer:**

- Adminer is a one-page web UI for inspecting a Postgres (or MySQL, or SQLite) database. You `open http://localhost:8080`, log in with the Postgres credentials, and browse tables, run queries, etc.
- The alternative is `psql` from the host, but you have to install it and remember the connection string. Adminer is in a container; no host install.
- It is a *dev-only* service. Production does not have Adminer. (This is one reason we use a `docker-compose.override.yml` in larger setups — the dev-only services go in the override, the prod-faithful base is in `compose.yaml`. We have simplified here and put it all in one file.)
- `depends_on: postgres: { condition: service_healthy }` — Adminer does not *crash* if Postgres is down (it shows a login page), but there is no point starting it before Postgres.

### Lines 52–54: Named volumes

```yaml
volumes:
 postgres_data:
 redis_data:
```

**What it does:** Declares the two named volumes that `postgres` and `redis` reference.

**Why this matters:**

- A named volume must be declared at the top-level `volumes:` *and* referenced in a service's `volumes:`. The declaration gives Docker permission to create and manage the volume.
- Named volumes survive `docker compose down` (but not `docker compose down -v`). They survive Docker daemon restarts. They survive machine reboots (Docker mounts them from `/var/lib/docker/volumes/` on Linux).
- They are *not* backups. A disk failure takes them with it. See [[08-PostgreSQL/Backups-and-Recovery]] for real backups.

### The `docker-compose.override.yml`: lines 4–14

```yaml
services:
 app:
 build:
 target: dev
 command:
 - uvicorn
 - boardly.main:app
 - --host
 - 0.0.0.0
 - --port
 - 8000
 - --reload
 - --reload-dir
 - /app/boardly
 environment:
 APP_LOG_LEVEL: DEBUG
```

**What it does:** Compose automatically merges this file with `compose.yaml` when you run `docker compose up` (without `-f`). The merged config is the union of both, with the override winning on conflicts.

**Why override:**

- `command:` — overrides the `CMD` from the image. The production image's `CMD` is `["uvicorn", "boardly.main:app", "--host", "0.0.0.0", "--port", "8000"]`. The dev override adds `--reload` and `--reload-dir /app/boardly`. `--reload` watches the source directory and restarts the worker on file changes; `--reload-dir` limits the watch to `/app/boardly` so changes to `/app/.venv` or `/app/tests` (which are not application code) do not trigger a reload.
- `environment: APP_LOG_LEVEL: DEBUG` — overrides the base `INFO` default with `DEBUG` for local dev. You see more logs.
- `build: target: dev` — redundant with the base file (which already says `target: dev`), but explicit.

**Tip — Why split `compose.yaml` and `docker-compose.override.yml`?**

The base file (`compose.yaml`) is the *production-faithful* config — no `--reload`, no Adminer, no dev overrides. The override (`docker-compose.override.yml`) is the *local-dev* config — `--reload`, DEBUG logs. Compose applies the override by default, so `docker compose up` is dev. To run prod-like locally: `docker compose -f compose.yaml up` (no override). To run with a different override: `docker compose -f compose.yaml -f docker-compose.test.yml up`. The split keeps the prod config honest.

Some teams `gitignore` the override (each developer has their own); we commit it because the dev expectations are part of the project's contract.


**Production reality: `uvicorn --reload` is two processes; `tini` must own PID 1.**

`uvicorn --reload` runs a parent reloader process that watches files and a child worker that imports the app. Without `tini` (or `dumb-init`) as PID 1, Docker sends `SIGTERM` to the reloader, which exits without forwarding the signal to the worker — the worker keeps running for the duration of the graceful-shutdown window, then is `SIGKILL`ed. With `tini` as PID 1 (the Lesson 1 `ENTRYPOINT ["tini", "--"]`), signals propagate: `tini` -> reloader -> worker, and shutdown is clean. Verify the process tree with `docker compose exec app ps -ef` — you should see `PID 1 tini`, `PID 7 uvicorn --reload` (parent), `PID 12 uvicorn --reload` (worker, parent PID 7). A flat tree (no parent/worker split) means `--reload` is not actually reloading; a tree without `tini` at the root means `SIGTERM` is ungraceful. The prod image's `CMD` has no `--reload`, so this is dev-only — but the same `tini` requirement applies to the prod image, because `uvicorn` without `--reload` is still a single process that does not reap zombies on its own. See [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]] for the `ENTRYPOINT` line.


**Warning — When this breaks: `docker-compose.override.yml` is silently applied by `docker compose up`.**

Compose auto-merges `docker-compose.override.yml` when you run `docker compose up` (no `-f`). A CI job that runs `docker compose up` thinking it is using the base file is actually using the dev override — `--reload` on, `APP_LOG_LEVEL=DEBUG`, and the dev `target: dev` stage. The image CI builds is the dev image, not the prod runtime image; the SBOM includes `ruff`/`mypy`/`pytest` that the prod image does not have; the prod-faithful smoke test runs against the wrong artifact. The fix is explicit: `docker compose -f compose.yaml up` (override ignored) for prod-faithful local, or `docker compose -f compose.yaml -f docker-compose.test.yml up` for a non-default override. Audit with `docker compose config --services` (lists the active services) and `docker compose config | grep -E 'target:|command:'` — `target: dev` or a `--reload` in `command:` means the override is applied. The CI workflow in the next lesson avoids this trap entirely by using service containers, not Compose, for the test job.


### The `dev` stage appended to the Dockerfile: lines 1–17

```dockerfile
FROM runtime AS dev

USER root
COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /usr/local/bin/uv
RUN apt-get update \
 && apt-get install --no-install-recommends -y git \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --all-extras
COPY . .

USER 1000
```

**What it does:** Adds a third stage `dev` that inherits from `runtime` (so it has the non-root user, the venv, the source), then *re-privileges* to root, installs `uv` and `git`, re-syncs with `--all-extras` (which includes `dev` and `test`), copies the entire source, and drops back to UID 1000.

**Why this design:**

- `FROM runtime AS dev` — `dev` inherits everything from `runtime`. The venv at `/app/.venv`, the source at `/app/boardly`, the `USER 1000`, the `ENTRYPOINT ["tini", "--"]` — all of it.
- `USER root` — temporarily back to root, because we are about to install apt packages and `uv`.
- `COPY --from=ghcr.io/astral-sh/uv:0.13.1 /uv /usr/local/bin/uv` — same trick as Lesson 1's builder. Pinned `0.13.1`.
- `apt-get install git` — `git` is useful in the dev stage for `pre-commit` hooks, `ruff`'s `--fix` with git integration, and tools that shell out to `git`. The `runtime` stage does not have `git`.
- `uv sync --frozen --all-extras` — `--all-extras` installs every optional dependency group in `pyproject.toml`'s `[project.optional-dependencies]`, including `dev` (`ruff`, `mypy`, `pre-commit`) and `test` (`pytest`, `pytest-asyncio`, `httpx`). The runtime image had `--no-dev` so it does not have these.
- `COPY . .` — the entire source tree (subject to `.dockerignore`). This is needed because the `dev` stage will be used with bind mounts, but the base image still wants the source there for `python -c "import boardly"` to work during image build.
- `USER 1000` — drop back. The dev stage's container runs as `app`, not as root.

**Spot the subtlety — why does `dev` need its own `uv sync --all-extras`?**

Answer: the `runtime` stage (which `dev` inherits from) was built with `uv sync --frozen --no-dev` — only production deps. The dev extras (`ruff`, `mypy`, `pytest`, etc.) are *not* in `/app/.venv`. The `dev` stage's `uv sync --frozen --all-extras` re-runs `uv sync` *into the same `/app/.venv`*, adding the dev extras on top. So `/app/.venv` in the `dev` stage contains prod deps + dev extras, while `/app/.venv` in the `runtime` stage contains only prod deps. The two stages have different venvs in the same path.


## Execution Trace

Time to bring it up. In your terminal:

```bash
cp .env.example .env
# (edit .env: change __REDACTED_CHANGE_ME__ to anything you like for local)
docker compose up
```

What happens, in order:

1. **Compose reads `compose.yaml`.** It parses the services, the volumes, the networks.
2. **Compose looks for `docker-compose.override.yml`.** It finds it (it is in the same directory) and merges it on top of the base config. The merged `app` service now has the override's `command:` and `APP_LOG_LEVEL: DEBUG`.
3. **Compose reads `.env`.** Every `KEY=VALUE` in `.env` is now available for `${VAR}` interpolation. The `environment:` block in the `app` service resolves `${APP_DATABASE_URL}` to the value in `.env`.
4. **Compose builds the `app` image.** It calls `docker build --target dev -t boardly:local .`. The build runs through Lesson 1's builder and runtime stages, then the `dev` stage. On the second `up`, the image is cached and this step is a no-op.
5. **Compose creates the network `boardly_default`.** All four services are attached to it.
6. **Compose starts `postgres` and `redis` in parallel.** Both have healthchecks. Compose records their states as `starting`.
7. **Compose evaluates `app`'s `depends_on`.** `postgres` is not yet healthy; `redis` is not yet healthy. `app` is *not* started yet. Compose waits.
8. **Postgres becomes healthy.** After ~5–10 seconds (the time for Postgres to initialise and `pg_isready` to succeed), `postgres` reports `service_healthy`.
9. **Redis becomes healthy.** `redis-cli ping` returns `PONG` after ~1 second.
10. **Compose starts `app`.** The container boots. `tini` is PID 1, `uvicorn --reload` is its child. `uvicorn` imports `boardly.main`, sends `lifespan.startup`, lifespan opens the engine pool (connects to `postgres:5432` via the network's DNS), opens the Redis pool, sends `lifespan.startup.complete`.
11. **Compose starts `adminer`.** `adminer` was also gated on `postgres` healthy; now that postgres is healthy, `adminer` starts.
12. **The developer edits `boardly/main.py`.** Saves the file. The bind mount at `/app/boardly` means the change is visible in the container immediately. `uvicorn`'s `--reload` watcher (WatchFiles) detects the change, restarts the worker. The new code is live in under a second.
13. **The developer opens `http://localhost:8080`.** Adminer's login page. They log in with `boardly` / (the password from `.env`) / `boardly` and can browse the DB.

```mermaid
flowchart LR
 H["Developer<br/>edits boardly/*.py"] -. bind mount .-> A
 subgraph Stack["boardly_default network"]
 A["app<br/>uvicorn --reload<br/>:8000"]
 PG["postgres:17-alpine<br/>pg_isready<br/>(volume: postgres_data)"]
 RD["redis:7-alpine<br/>redis-cli ping<br/>(volume: redis_data)"]
 AD["adminer:5.2.1<br/>:8080"]
 end
 A -->|5432| PG
 A -->|6379| RD
 AD -->|5432| PG
 A -. "depends_on<br/>service_healthy" .-> PG
 A -. "depends_on<br/>service_healthy" .-> RD
 AD -. "depends_on" .-> PG
 H --> A

 style A fill:#d4edda,stroke:#28a745
 style PG fill:#cce5ff,stroke:#007bff
 style RD fill:#fff3cd,stroke:#856404
 style AD fill:#f8d7da,stroke:#dc3545
```

**You have a local dev stack.**

The app, a real Postgres, a real Redis, a DB inspector — all wired together with healthchecks, all rebuildable from a single `docker compose up`. The same `compose.yaml` is what Lesson 3's CI uses for service containers (with one tweak: CI uses `image:` instead of `build:` for the sidecars, and runs `app` differently).


## Common Mistakes

### Mistake 1: No `condition: service_healthy` on `depends_on`

```yaml
# WRONG
depends_on:
 - postgres
 - redis
```

**Symptom:** `app` boots before Postgres is ready. The engine's `create_async_engine(...)` succeeds (it is lazy — it just constructs the pool), but the first query fails with `Connection refused`. The app crashes; `restart: unless-stopped` brings it back; eventually it wins the race and connects.

**Fix:** Use the long form: `depends_on: postgres: { condition: service_healthy } ...`. The race is eliminated; `app` boots only when Postgres is ready.

### Mistake 2: Committing the real `.env`

```bash
git add .env # WRONG
```

**Symptom:** Your Postgres password is now in git history. Even if you `git rm` it later, it is in the reflog, in everyone's clones, and in any CI that ran on the PR.

**Fix:** `.gitignore` the real `.env`. Commit `.env.example` as a template. New developers copy `.env.example` to `.env` and fill in real values. Real secrets in production come from the platform's secret store — Vault, AWS Secrets Manager, GCP Secret Manager — never from a committed file.

**Danger — If you have already committed a real secret, rotate it.**

`git rm .env` does not undo the leak. The secret is in the git history. Rotate the secret: change the Postgres password, generate a new JWT signing key, rotate any API keys. Then scrub the history with `git filter-repo` or BFG. Then force-push. Anyone who cloned before the scrub still has the secret — assume it is compromised.


### Mistake 3: Embedding secrets in `compose.yaml`

```yaml
# WRONG
postgres:
 environment:
 POSTGRES_PASSWORD: supersecret123
```

**Symptom:** Anyone reading `compose.yaml` sees the password. The file is committed (it should be), so the secret is in git.

**Fix:** Always `${VAR}` from `.env`. The `compose.yaml` should contain *no literal secrets* — only references.

### Mistake 4: Forgetting the `/app/.venv` anonymous volume

```yaml
# WRONG
volumes:
 - ./boardly:/app/boardly:cached
 - ./tests:/app/tests:cached
 # No anonymous volume for /app/.venv
```

**Symptom:** A developer runs `uv sync` on the host (in the repo root), creating a `./.venv` directory. On the next `docker compose up`, the bind mount on `/app/boardly` does not affect `/app/.venv` (they are different paths), but if the developer's `./boardly` source has any symlinks into `./.venv`, the container's view of those symlinks breaks. More importantly, the host's `./.venv` is a *different* venv than the container's, and the developer accidentally runs tools from the host venv (e.g. `uv run ruff check`) that have a different version than the container's. Confusing failures.

**Fix:** Add `- /app/.venv` to the `app` service's `volumes:`. The container's `/app/.venv` is now an anonymous volume, isolated from the host. The host venv (if it exists) is irrelevant to the container.

### Mistake 5: `pg_isready` without `-U` and `-d`

```yaml
# WRONG
healthcheck:
 test: ["CMD", "pg_isready"]
```

**Symptom:** The healthcheck connects as the default user (the container's user, often `postgres`), which *might* not be the user you created with `POSTGRES_USER`. `pg_isready` reports unhealthy even when Postgres is fine.

**Fix:** `pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}`. The `-U` is the user, `-d` is the database — both are checked in the handshake.

### Mistake 6: Building on every `up`

```bash
docker compose up --build # Often unnecessary
```

**Symptom:** Every `up` rebuilds the image, taking 30 seconds even when nothing changed.

**Fix:** Rely on the build cache. `docker compose up` (without `--build`) reuses the existing `boardly:local` image. Rebuild only when the `Dockerfile` or `pyproject.toml`/`uv.lock` changes: `docker compose up --build`.

### Mistake 7: Treating named volumes as backups

```bash
docker compose down -v # WRONG (if you wanted to keep the data)
```

**Symptom:** You ran `down -v` thinking it would just stop the stack. It also destroyed the volumes. Your local DB is gone.

**Fix:** `docker compose down` (without `-v`) keeps the volumes. `docker compose down -v` is the explicit "destroy data" command — use it when you want a fresh DB. Real backups are in [[08-PostgreSQL/Backups-and-Recovery]] — `pg_dump` to a file, ship the file to S3.

## Engineering Trade-Offs

- **`alpine` vs. `slim` for Postgres/Redis.** `alpine` images are smaller (~10–80 MB) and the official Postgres and Redis alpine images are well-supported. We pick `alpine` for the stateless sidecars (Redis, Adminer) and `alpine` for Postgres here. In production we would run managed Postgres on RDS/Cloud SQL — the in-container Postgres is for local dev.
- **Single `compose.yaml` vs. split base + override.** Compose automatically merges `compose.yaml` and `docker-compose.override.yml` for `up`. This is idiomatic; the override is gitignored in some teams and committed in others. We commit it because it documents the dev expectations. The split lets you do `docker compose -f compose.yaml up` for a prod-faithful local run.
- **`--reload` in the production image.** Never. `--reload` watches files; production has no files to watch (the source was `COPY`d at build time). Dev override only.
- **One compose file for all environments.** Tempting, but production does not need Adminer and does not want `--reload`. We keep `compose.yaml` for local, and use Helm/Kustomize/Cloud Run manifests in production. Compose is for the developer loop; the prod config lives elsewhere.
- **Bind mount vs. named volume for source.** Bind mount is the only sensible choice for source — the developer edits on the host, the container sees the changes. Named volumes are opaque to the host, which is the wrong property for source code.
- **`cached` vs. `consistent` vs. `delegated`.** These are Docker for Mac consistency modes. `cached` (container can cache) is fastest for source. `delegated` (host can override container) is for output dirs. `consistent` (default) is slowest but most correct. We use `cached` for source; the developer is the source of truth.
- **`pg_isready` vs. `psql -c 'SELECT 1'`.** `pg_isready` is a single binary that does one thing; `psql` is the full client. The `postgres:17-alpine` image has `pg_isready` but not `psql` (you would have to install it). Use `pg_isready`.

## Exercises

- **Beginner:** Add a `mailhog` service (or `mailpit`) to the stack so the app can send email locally without hitting a real SMTP server. Configure `APP_SMTP_URL=smtp://mailhog:1025` in `.env`. Verify you can hit `http://localhost:8025` and see emails sent by the app.
- **Intermediate:** Add a `tests` service that runs `uv run pytest` against the same Postgres+Redis, but with a separate DB. Use a tmpfs for the test DB's data directory so the test run always starts clean. Run the tests with `docker compose run --rm tests`.
- **Advanced:** Refactor so that the dev source mount is a separate `docker-compose.override.yml` that is gitignored per-developer, and the base `compose.yaml` is production-faithful (no `--reload`, no bind mounts, no Adminer). Document the workflow: `docker compose -f compose.yaml -f docker-compose.override.yml up` for dev; `docker compose -f compose.yaml up` for prod-like local.
- **Beginner-Plus (Debugging):** Catch the `docker compose config` secret leak. Run `docker compose config 2>/dev/null | grep -E 'PASSWORD|DATABASE_URL'` and confirm your real Postgres password appears in plaintext. Add a `pre-commit` hook that runs the same grep on the rendered YAML and fails if a non-empty, non-`__REDACTED_CHANGE_ME__` password appears. Confirm the `--no-interpolate` form keeps the `${VAR}` tokens. Verify: `docker compose config | grep -cE 'postgresql\+asyncpg://boardly:[^_@]+@'` returns `1` (the leak); `docker compose config --no-interpolate | grep -cE 'postgresql\+asyncpg://boardly:[^_@]+@'` returns `0` (tokens preserved).
- **Beginner-Plus (Security):** Bind Adminer and the app to loopback. Change `adminer`'s and `app`'s `ports` from `"8000:8000"` / `"8080:8080"` to `"127.0.0.1:8000:8000"` / `"127.0.0.1:8080:8080"`. Restart with `docker compose up -d`. From the host, `curl -sf http://localhost:8000/healthz` should still return `{"status":"ok"}`; from another host on the LAN (or `docker run --rm --network host alpine wget -qO- http://$(hostname -I | cut -d' ' -f1):8000/healthz`), the same URL should fail. Verify: `ss -tlnp | grep -E ':(8000|8080)'` lists `127.0.0.1:8000` and `127.0.0.1:8080` (not `0.0.0.0:8000` or `0.0.0.0:8080`).
- **Intermediate-Plus (Debugging):** Reproduce the healthcheck-vs-app path mismatch. Add `command: ["postgres", "-c", "listen_addresses="]` to the `postgres` service (Unix socket only, no TCP). Restart with `docker compose up -d postgres`. `docker compose ps postgres` still shows `healthy` (the healthcheck uses the Unix socket). But `docker compose exec app uv run python -c "import socket; socket.create_connection(('postgres',5432),2).close(); print('ok')"` raises `ConnectionRefusedError` — the app uses TCP, which Postgres is no longer listening on. Restore `listen_addresses='*'` (or remove the override) and confirm both the healthcheck and the app succeed. Verify: `docker compose exec app uv run python -c "import socket; socket.create_connection(('postgres',5432),2).close(); print('ok')"` prints `ok` after restoring.
- **Intermediate-Plus (Production):** Pin Postgres by digest for bit-for-bit reproducibility. Resolve the digest with `docker image inspect postgres:17-alpine --format '{{.Digest}}'` (a 64-hex SHA). Replace `image: postgres:17-alpine` in `compose.yaml` with `image: postgres:17-alpine@sha256:<that-digest>`. Run `docker compose pull postgres` — it should be a no-op ("Image is up to date"). Now `docker compose up -d postgres` and confirm via `docker compose exec postgres psql -U boardly -d boardly -c 'SELECT version()'` that you are on the exact image you pinned. Discuss in a one-paragraph note why this matters for CI: a teammate's `docker compose pull` six months from now will resolve `postgres:17-alpine` to a different 17.x build; the digest pin makes their build identical to yours. Verify: `docker image inspect postgres:17-alpine --format '{{.Digest}}'` and `docker image inspect postgres:17-alpine@sha256:<that-digest> --format '{{.Digest}}'` return the same hex.
- **Advanced-Plus (Debugging + Production):** Add a tmpfs-backed one-shot test service. Add a `tests` service that uses the same image as `app` but with `command: ["uv", "run", "pytest", "-q"]`, `depends_on: { postgres: { condition: service_healthy }, redis: { condition: service_healthy } }`, a separate `APP_DATABASE_URL` pointing at a `boardly_test` DB, and a tmpfs at `/tmp` for fast scratch. Run `docker compose run --rm tests` and confirm pytest executes inside the container against the real Postgres+Redis, not a SQLite mock. The tmpfs means the test runner's scratch is gone on exit — no leaked artifacts. Verify: `docker compose run --rm tests uv run pytest -q tests/test_healthz.py` exits 0 with the test passing; `docker compose run --rm tests env | grep APP_DATABASE_URL` shows the test DSN, not the dev one.
- **Advanced-Plus (Production):** Verify the `tini` -> `uvicorn --reload` -> worker process tree. With the stack up, run `docker compose exec app ps -ef` and confirm the tree shows: PID 1 = `tini --`, parent `uvicorn --reload ...` (the reloader), child `uvicorn --reload` (the worker, parent PID = reloader). Now send `docker compose stop app` and confirm graceful shutdown in `docker compose logs app --since 5s | grep -iE 'shutdown|graceful'`. Then temporarily remove `tini` from the Dockerfile's `ENTRYPOINT` (use `ENTRYPOINT ["uvicorn"]` directly), rebuild with `docker compose build app`, and re-run the same stop test — confirm the worker is `SIGKILL`ed after the grace period instead of shutting down (check `docker compose logs app --since 5s | grep -i 'signal'` for the kill). Verify: `docker compose exec app ps -ef | grep -E 'tini|uvicorn'` lists three lines (tini, parent uvicorn, worker uvicorn) with correct PPID relationships, and `docker compose exec app cat /proc/1/comm` returns `tini`.

## Verification

```bash
# Bring up the stack
cp .env.example .env
docker compose up -d

# Wait for health
docker compose ps
# Expect: STATUS = (healthy) for postgres, redis, app, adminer

# Hit the app
curl -sf http://localhost:8000/healthz
# Expect: {"status":"ok"}

# Hit readiness (touches the DB)
curl -sf http://localhost:8000/readyz
# Expect: {"status":"ready"}

# Connect via Adminer
open http://localhost:8080
# Server: postgres, User: boardly, Password: from .env, DB: boardly

# Edit a file and verify --reload picks it up
# (edit boardly/main.py — add a print to healthz — save)
curl -sf http://localhost:8000/healthz
# Expect: the change is live (look at the docker logs for the reload)

# Tear down (keep data)
docker compose down

# Verify the data survived
docker compose up -d
docker compose exec postgres psql -U boardly -d boardly -c '\dt'
# Expect: your tables are still there

# Tear down and destroy data
docker compose down -v
```

## Previously Learned Here

- **`uv`** — first taught in [[01-Python-Foundations/uv-Tooling-Workflows]]. The new detail is `uv sync --all-extras` to include dev/test extras in the `dev` stage.
- **Pydantic Settings** — first taught in [[04-Pydantic/Pydantic-Settings]]. The new detail is the `env_file: [.env]` mapping and `env_prefix="APP_"` so compose-injected vars are picked up by `Settings`.
- **Connection pool** — first taught in [[07-SQLAlchemy/02-Engines-Connections-Pools]]. The new detail is that the engine URL is `postgresql+asyncpg://...@postgres:5432/...`, where `postgres` resolves via the compose network's DNS.
- **Redis cache-aside** — first taught in [[14-Caching-and-Background-Processing/Redis-Cache-Aside]]. The new detail is the redis-server flags (`--appendonly yes` for persistence, `--maxmemory 256mb --maxmemory-policy allkeys-lru` so the local cache does not eat your laptop's RAM).
- **Container hygiene** — first taught in [[Docker-Multi-Stage-Non-Root]]. The new detail is the `dev` stage that inherits from `runtime` and adds the dev extras.

## What's Next

The local stack is the substrate for the CI pipeline in [[GitHub-Actions-CI]]. CI will:

- Use `postgres:17-alpine` and `redis:7-alpine` as *service containers* (the GitHub Actions analogue of compose sidecars) with the same healthchecks.
- Use `astral-sh/setup-uv` to install `uv 0.13.1` on the runner, with `enable-cache: true` and `cache-dependency-glob: uv.lock` so the `~/.cache/uv` is restored across runs.
- Run `uv sync --frozen --all-extras`, `ruff check`, `mypy --strict`, `pytest --cov`.
- Build the Lesson 1 image with `cache-from: type=gha` (the GitHub Actions cache backend for Docker layers).
- On `main`, push the image to `ghcr.io` tagged by SHA, plus generate an SBOM.

After CI is in place, [[Migration-Ordering-and-Rollback]] is the deploy job that runs `alembic upgrade head` against the production DB, *before* the new code rolls, with a `pg_advisory_lock` so two replicas cannot race.

## Sources

- Docker Compose — Compose file reference — <https://docs.docker.com/compose/compose-file/> — `depends_on.condition`, healthcheck syntax.
- Docker Compose — Startup order — <https://docs.docker.com/compose/startup-order/> — why healthchecks gate `depends_on`.
- Docker Compose — Override files — <https://docs.docker.com/compose/multiple-compose-files/merge/> — how Compose merges `compose.yaml` and `docker-compose.override.yml`.
- PostgreSQL — `pg_isready` — <https://www.postgresql.org/docs/current/app-pg-isready.html>.
- Redis — `redis-cli ping` — <https://redis.io/docs/latest/commands/ping/>.
- Adminer — <https://www.adminer.org/>.
- See [[21-Reference-Library/Source-Register]] for the full source list with dates accessed.

## What We Learned

- A `compose.yaml` with `app` + `postgres:17-alpine` + `redis:7-alpine` + `adminer`, each with a healthcheck, gives every developer an identical local stack in one command.
- `depends_on: condition: service_healthy` is the line that eliminates the "app boots before Postgres" race.
- The `.env` file plays two roles: interpolation (`${VAR}`) in the compose config, and injection (`env_file:`) into the container. The `environment:` block is the explicit declaration of which `APP_*` vars the app consumes.
- A bind mount (`./boardly:/app/boardly:cached`) plus an anonymous volume (`/app/.venv`) gives hot-reload without the host's venv shadowing the container's.
- The `dev` stage in the Dockerfile inherits from `runtime` and adds `uv` and `--all-extras`, so a single image supports both prod and dev. Only the overrides differ.
- Named volumes survive `docker compose down` but not `docker compose down -v` — they are not backups.

---

**Tags:** #docker #devops #local-dev #compose #review
**Previous:** [[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]]
**Next:** [[16-Deployment-and-DevOps/GitHub-Actions-CI]] →

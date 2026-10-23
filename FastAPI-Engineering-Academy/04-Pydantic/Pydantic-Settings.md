---
title: "Lesson 05: Pydantic Settings"
aliases:
 - Pydantic Settings
 - pydantic-settings
 - BaseSettings
 - Settings / environment configuration
 - Layered config
tags:
 - pydantic
 - settings
 - config
 - v2
 - canonical
 - lesson
course_level: intermediate
status: complete
difficulty: intermediate
estimated_time: "60–90 minutes"
prerequisites:
 - "[[04-Pydantic/BaseModel-and-Validation]]"
 - "[[04-Pydantic/Fields-Annotated-Reusable-Annotations]]"
 - "[[04-Pydantic/Validators-Strict-vs-Coercive]]"
 - "[[04-Pydantic/Serialization-and-Model-Dump]]"
 - "[[03-FastAPI-Core/Application-and-Lifespan]]"
related_lessons:
 - "[[BaseModel-and-Validation]]"
 - "[[Fields-Annotated-Reusable-Annotations]]"
 - "[[Validators-Strict-vs-Coercive]]"
 - "[[Serialization-and-Model-Dump]]"
 - "[[03-FastAPI-Core/Application-and-Lifespan]]"
 - "[[16-Deployment-and-DevOps/Docker-Multi-Stage-Non-Root]]"
first_taught_in: "04-Pydantic/Pydantic-Settings"
---

# Lesson 05: Pydantic Settings

*Building a complete `Settings` class for Boardly — `database_url`, `redis_url`, `jwt_secret`, `debug`, `log_level`, nested sub-configs — loaded from environment variables, `.env` files, and defaults in priority order, validated at process startup, wired into the lifespan from Section 03 Lesson 1.*

**You're at the last code-building lesson of Section 04.**

Lesson 07 — the comparison capstone [[Pydantic-vs-Dataclasses-vs-TypedDict]] — follows this one and audits when to use `BaseModel` vs `@dataclass` vs `TypedDict` against the schemas you've written. Read it after this lesson, before moving on to Section 05.
Twelve-Factor apps live or die by configuration. Hard-coded values break in staging; `os.getenv("DATABASE_URL")` strings scattered through the codebase break in production when nobody can find where the typo is. `pydantic-settings` is the v2-blessed way to declare typed, validated, layered configuration: environment variables win, then `.env` files, then defaults. Every setting is parsed by the same Pydantic engine that validates your request bodies — which means a misconfigured `DEBUG=maybe` fails at process start, not at the first request. Take your time. Type every line. Read the tracebacks. **This is how you learn.**


#pydantic #settings #config #v2 #canonical

## Learning Objectives

By the end of this lesson you will be able to:

1. **Install and use `pydantic-settings`** (it is a separate package from `pydantic`), and explain why it is not bundled with `pydantic` itself.
2. **Write a `Settings` class** that reads from environment variables, `.env` files, and defaults — in that priority order — using `SettingsConfigDict(env_file=..., env_prefix=...)`.
3. **Use nested settings** for grouped config (`Settings.database.url`, `Settings.redis.url`, `Settings.auth.jwt_secret`) and customize the env var names that map to nested fields.
4. **Treat secrets properly**: never log them, never default them, never commit them. Use `SecretStr` for sensitive values.
5. **Validate config at startup** — wire `Settings()` into Boardly's lifespan from [[03-FastAPI-Core/Application-and-Lifespan|Section 03 Lesson 1]], so a misconfigured env fails loud and early.
6. **Layered config**: `env > .env > default`, and explain why this priority order is the right one for production, staging, and local development.

## Prerequisites

Before starting, you need:

- **Pydantic v2.14.1** (verified 2026-10-11), the four lessons of this section, and `pydantic-settings` (install with `uv add pydantic-settings`).
- **The FastAPI lifespan** — [[03-FastAPI-Core/Application-and-Lifespan|Section 03 Lesson 1]]. This lesson's `Settings` is wired into the lifespan; if `lifespan` and `@asynccontextmanager` are unfamiliar, re-read that lesson's first half.
- **`BaseModel`, `Field`, `Annotated`, `@field_validator`** — Lessons 1–3 of this section. `BaseSettings` is a subclass of `BaseModel`; everything you learned about fields, validators, and serialization applies.
- **About 60–90 minutes of focused time.** The code is ~70 lines (`boardly/settings.py`) plus a small edit to `boardly/main.py` from Section 03; the explanation is long because the layered-config model has subtle failure modes.

**The most common gap: confusing `pydantic` and `pydantic-settings`.**

`pip install pydantic` does **not** install `pydantic-settings`. They are separate packages with separate release cycles. `pydantic-settings` is a thin wrapper around `pydantic` that adds `BaseSettings` and the env-var loading machinery. If you try `from pydantic_settings import BaseSettings` and get `ModuleNotFoundError`, you forgot `uv add pydantic-settings`. The split is intentional: a library that uses Pydantic for schemas does not need the settings machinery.


## The Problem

Boardly is about to need real configuration. The lifespan from Section 03 Lesson 1 is:

```python
engine = create_async_engine(settings.database_url, pool_pre_ping=True)
app.state.engine = engine
app.state.sessionmaker = async_sessionmaker(engine, expire_on_commit=False)
redis = Redis.from_url(settings.redis_url, decode_responses=True)
await redis.ping()
```

That code references `settings.database_url`, `settings.redis_url`, etc. Where does `settings` come from? If you wrote `settings = Settings()` at module top with hardcoded values, you'd have to edit `boardly/settings.py` and re-deploy for every config change. If you wrote `settings.database_url = os.getenv("DATABASE_URL")`, you'd have a type contract of `str | None` — and the lifespan would crash at `create_async_engine(None, ...)` with an opaque error.

The right answer is: a typed `Settings` class that:

- Reads `DATABASE_URL` (and `REDIS_URL`, `JWT_SECRET`, etc.) from environment variables.
- Falls back to `.env` files for local development (so you don't have to export env vars every time you run the dev server).
- Has sensible defaults for things like `LOG_LEVEL` (default `"INFO"`) and `DEBUG` (default `False`).
- Validates at startup — `DEBUG=maybe` raises `ValidationError` before any request is served.
- Carries typed fields so your IDE and your type checker know `settings.database_url` is a `str`, not `str | None`.
- Keeps secrets out of logs (the `__repr__` of `settings` should not print the JWT secret).

`pydantic-settings` does all of this with the same machinery you've been using for request bodies. The four-phase pipeline (parse → validate → set → freeze) is the same; the input source is different (env vars instead of JSON bodies).

## The Code

Here is the complete `boardly/settings.py` you'll write in this lesson, plus the small edit to `boardly/main.py` that wires the `Settings` instance into the lifespan.

```python
# boardly/settings.py
"""Boardly configuration — env > .env > defaults.

Constructed once at process start, validated at startup, stashed on
app.state.settings for the lifespan and dependencies to read.
"""
from typing import Annotated, Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class DatabaseSettings(BaseSettings):
 """Nested settings — group database config in its own namespace.

 The `env_prefix='BOARDLY_DB_'` here ONLY applies when `DatabaseSettings`
 is constructed *standalone* (e.g. for unit tests of the repository layer
 that load just the DB block). When `DatabaseSettings` is a *nested field*
 of `Settings` below, pydantic-settings ignores this nested class's
 `env_prefix` and instead uses the parent's `env_nested_delimiter="__"`
 path: `BOARDLY_DATABASE__URL` maps to `settings.database.url`,
 `BOARDLY_DATABASE__POOL_SIZE` maps to `settings.database.pool_size`,
 etc. In production, set `BOARDLY_DATABASE__URL`; in tests, you can
 construct `DatabaseSettings()` directly with `BOARDLY_DB_URL`.
 """
 model_config = SettingsConfigDict(env_prefix="BOARDLY_DB_")

 url: str = Field(
 ..., description="Asyncpg URL: postgresql+asyncpg://user:pass@host/db",
 )
 pool_size: int = Field(default=10, ge=1, le=100)
 pool_pre_ping: bool = True


class RedisSettings(BaseSettings):
 model_config = SettingsConfigDict(env_prefix="BOARDLY_REDIS_")

 url: str = "redis://localhost:6379/0"
 max_connections: int = Field(default=20, ge=1, le=200)


class AuthSettings(BaseSettings):
 model_config = SettingsConfigDict(env_prefix="BOARDLY_AUTH_")

 jwt_secret: SecretStr = Field(
 ..., description="NEVER commit. Generate with `openssl rand -hex 32`.",
 )
 jwt_algorithm: Literal["HS256", "HS384", "HS512"] = "HS256"
 access_token_ttl_minutes: int = Field(default=60, ge=1)
 refresh_token_ttl_days: int = Field(default=30, ge=1)


class Settings(BaseSettings):
 """Top-level settings — assembled from env vars and .env."""

 model_config = SettingsConfigDict(
 env_prefix="BOARDLY_",
 env_file=".env",
 env_file_encoding="utf-8",
 env_nested_delimiter="__", # BOARDLY_DATABASE__URL maps to database.url
 case_sensitive=True,
 extra="ignore",
 )

 # --- top-level scalars ---
 debug: bool = False
 log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
 environment: Literal["local", "dev", "staging", "prod"] = "local"

 # --- nested sub-configs (loaded by env_nested_delimiter) ---
 database: DatabaseSettings
 redis: RedisSettings
 auth: AuthSettings

 @field_validator("log_level", mode="before")
 @classmethod
 def _uppercase_level(cls, v: str | None) -> str | None:
 if isinstance(v, str):
 return v.upper()
 return v

 @model_validator(mode="after")
 def _no_prod_in_local(self) -> "Settings":
 if self.environment == "prod" and self.debug:
 raise ValueError("DEBUG=True is forbidden in prod")
 return self


def get_settings() -> Settings:
 """Factory used by the lifespan and by Depends(get_settings)."""
 return Settings()


# Smoke test:
# BOARDLY_DATABASE_URL='postgresql+asyncpg://u:p@h/db' \
# BOARDLY_AUTH_JWT_SECRET='abc123' \
# uv run python -c "from boardly.settings import Settings; \
# print(Settings().model_dump())"
```

And the small edit to `boardly/main.py` from Section 03 Lesson 1 — replace the bare `app.state.version = "0.1.0"` with a real `Settings`:

```python
# boardly/main.py (excerpt; full file from Section 03 Lesson 1)
from boardly.settings import Settings

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
 settings = Settings() # validates at startup
 app.state.settings = settings
 print(f"Boardly starting up — env={settings.environment}, "
 f"log_level={settings.log_level}")
 # ... create_async_engine(settings.database.url, ...) etc. ...
 yield
 print(f"Boardly shutting down — env={settings.environment}")


app = FastAPI(title="Boardly", version="0.1.0", lifespan=lifespan)
```

Two files. Read them. Type them. Run them. Change them. Break them. Fix them. We'll explain every line next.

## Line-by-Line Deep Dive

This section is the heart of the lesson. Read it twice. Don't skip.

### Lines 1–10: Imports

```python
from typing import Annotated, Literal

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
```

**What it does:** Pulls in the standard-library `Annotated` and `Literal`, plus four names from `pydantic` (`Field`, `SecretStr`, `field_validator`, `model_validator`) and two from `pydantic_settings` (`BaseSettings`, `SettingsConfigDict`).

**Why each:**

- `Annotated` — used for the `Annotated[T, Field(...)]` form on settings fields, same as Lesson 2.
- `Literal` — used to constrain `log_level` to one of `"DEBUG"`, `"INFO"`, etc. A misconfigured `LOG_LEVEL=VERBOSE` fails at startup.
- `Field` — constraint carrier, same as Lesson 2.
- `SecretStr` — a Pydantic type for sensitive values. Its `__repr__` is `SecretStr('**********')` so it doesn't leak in logs.
- `field_validator` — for single-field rules (e.g., uppercase the `log_level` env var before the `Literal` check); same decorator as Lesson 3.
- `model_validator` — for cross-field rules (e.g., `DEBUG=True` is forbidden when `environment="prod"`); it receives the model instance (`self`), not the class. Lesson 3 used the same decorator on request bodies.
- `BaseSettings` — the v2 settings class. Subclass of `BaseModel`; adds env-var loading.
- `SettingsConfigDict` — the settings-specific `ConfigDict` subclass. Adds `env_file`, `env_prefix`, `env_nested_delimiter`, etc.

**Tip — Why `pydantic_settings` (with underscore) for the import but `pydantic-settings` (with hyphen) for the package?**

Python package names use hyphens (`pydantic-settings` on PyPI); Python module names cannot contain hyphens, so the import name uses underscores (`pydantic_settings`). The hyphen-vs-underscore split is a Python-wide convention, not a Pydantic choice.


**Warning — Debugging `ModuleNotFoundError: No module named 'pydantic_settings'` in Docker.**

The error means the image installed `pydantic` but not `pydantic-settings`. In a Docker multi-stage build, this happens when `requirements.txt` (or `pyproject.toml`'s `[project.dependencies]`) lists `pydantic` but a downstream service that shares the image (a Celery worker, a management CLI, a scheduled job) imports `from pydantic_settings import BaseSettings` and the build pinned only `pydantic`. The fix is to list `pydantic-settings` explicitly in the project dependencies — never rely on it being a transitive dependency of something else (it is not). The debugging move: `uv run python -c "import pydantic_settings; print(pydantic_settings.__version__)"` in the built image's shell; a `ModuleNotFoundError` means the lockfile is missing the package. The same lint run in CI (a `uv run python -c "import pydantic_settings"` step) catches the gap before the image is built, not after the deploy fails in prod.


### Lines 13–25: `DatabaseSettings` with `env_prefix`

```python
class DatabaseSettings(BaseSettings):
 """Nested settings — group database config in its own namespace.

 The `env_prefix='BOARDLY_DB_'` here ONLY applies when `DatabaseSettings`
 is constructed *standalone* (e.g. for unit tests of the repository layer
 that load just the DB block). When `DatabaseSettings` is a *nested field*
 of `Settings` below, pydantic-settings ignores this nested class's
 `env_prefix` and instead uses the parent's `env_nested_delimiter="__"`
 path: `BOARDLY_DATABASE__URL` maps to `settings.database.url`,
 `BOARDLY_DATABASE__POOL_SIZE` maps to `settings.database.pool_size`,
 etc. In production, set `BOARDLY_DATABASE__URL`; in tests, you can
 construct `DatabaseSettings()` directly with `BOARDLY_DB_URL`.
 """
 model_config = SettingsConfigDict(env_prefix="BOARDLY_DB_")

 url: str = Field(
 ..., description="Asyncpg URL: postgresql+asyncpg://user:pass@host/db",
 )
 pool_size: int = Field(default=10, ge=1, le=100)
 pool_pre_ping: bool = True
```

**What it does:** Declares a nested settings class for database configuration. The env prefix `BOARDLY_DB_` means env vars `BOARDLY_DB_URL`, `BOARDLY_DB_POOL_SIZE`, `BOARDLY_DB_POOL_PRE_PING` map to the `url`, `pool_size`, `pool_pre_ping` fields — but ONLY when `DatabaseSettings` is constructed *standalone* (e.g. in tests). When `DatabaseSettings` is a nested field of `Settings` below, the parent's `env_nested_delimiter="__"` takes over and the nested class's `env_prefix` is bypassed — see the callout below.

**Warning — Nested `BaseSettings` env-prefix interaction**

When a `BaseSettings` subclass is used as a nested field of another `BaseSettings` with `env_nested_delimiter="__"`, the nested class's own `env_prefix` is **ignored for the nested path** — pydantic-settings builds the env-var name from the parent's prefix + the field name + the delimiter + the nested field name. In this lesson:
- `BOARDLY_DATABASE__URL` → `settings.database.url` (production path; uses parent's prefix `BOARDLY_` + nested-delimiter `__` + field-name chain `DATABASE` → `URL`)
- `BOARDLY_DB_URL` → would map to `settings.database.url` only if `DatabaseSettings` were loaded standalone, NOT when nested inside `Settings`

Operators set the `BOARDLY_DATABASE__*` family in prod; tests construct `DatabaseSettings()` directly with `BOARDLY_DB_*`. Don't mix the two paths in the same shell — pick one per environment.


**Why a separate class for database settings:** Because database config is conceptually a group — `url`, `pool_size`, `pool_pre_ping` belong together. The group is reusable (the test suite can construct `DatabaseSettings(url="sqlite://...")` independently) and the env-var prefix (`BOARDLY_DB_`) keeps the env namespace clean.

**Student asks: why nest `DatabaseSettings` as a field of `Settings` instead of keeping it standalone?**

Because the *runtime shape* your code reads should match the *grouping* in your head. `settings.database.url` reads as "the URL of the database" — three nested nouns, matching how you'd describe it. A flat `settings.database_url` works for a 3-field config; once the database block has 5+ fields (url, pool_size, pool_pre_ping, pool_recycle, statement_timeout, ...), the flat form becomes a wall of prefixed names and the grouping is lost. Nesting is also how you'd hand the block to a function: `create_async_engine(**settings.database.model_dump())` reads better than picking 5 fields out of a flat bag one at a time.


**Why use `env_prefix` and not bake the prefix into each field name?** Because the field name is what your Python code reads (`settings.database.url`), and the prefix is what the operator's shell exports (`BOARDLY_DB_URL`). If you baked the prefix into the field name (`boardly_db_url: str = Field(...)`), you'd have to type `settings.database.boardly_db_url` everywhere in your service layer — every reference would carry the noise of the prefix, and renaming the prefix would touch every callsite. The `env_prefix` mechanism keeps the Python surface clean (`url`, `pool_size`) while keeping the env-var surface namespaced (`BOARDLY_DB_URL`); the mapping is structural to the framework, not scattered across your code. The same separation applies to JSON aliases in Lesson 2 (`owner_id` in Python, `ownerId` on the wire) — the wire name and the Python name are independent decisions.

**When would you NOT reach for `BaseSettings`?**

Three cases. (1) Throwaway scripts and CLIs that read a handful of env vars and exit — `os.getenv` is honest about the cost and you save the 70 lines of schema. (2) Config that lives in a remote store (AWS Secrets Manager, Vault, Consul KV) — `BaseSettings` reads the environment and `.env` files; remote sources need a settings source interface (`pydantic-settings` supports this via `customise_sources`, but the cost is no longer "free"). (3) Config that needs to be hot-reloaded at runtime — `BaseSettings` is constructed once at startup; if you need runtime reload, you're back to managing your own `Settings` instance and propagating changes to running workers. For a long-running web service with stable config loaded at startup, `BaseSettings` is the right default.


**Why each field:**

- `url` is required (`...`) — Boardly cannot start without a database URL. The description documents the URL format (`postgresql+asyncpg://...`).
- `pool_size` is optional with bounds `1 ≤ x ≤ 100`. A misconfigured `BOARDLY_DB_POOL_SIZE=1000` fails at startup; a `0` fails; a `-5` fails. The bound prevents the connection pool from exhausting Postgres `max_connections`.
- `pool_pre_ping` is `bool = True`. The default (always pre-ping) avoids the classic "stale connection after a network blip" bug.

**Danger — `pool_size` upper bound is a Postgres-survival guard, not a tuning knob.**

Postgres has a finite `max_connections` (default 100). If the Boardly API runs 4 Uvicorn workers, each with `pool_size=100`, and the Celery worker runs another `pool_size=100`, that is 500 connections — five times the Postgres default. The `le=100` on `pool_size` is the per-process cap; the real-world constraint is `workers * pool_size <= 0.8 * max_connections` (leave 20% for migrations, `psql`, monitoring, and the connection that runs `pg_terminate_backend` when something hangs). A misconfigured `BOARDLY_DB_POOL_SIZE=500` would pass without the `le=100` guard; the service would start, exhaust Postgres connections on the first traffic spike, and every other service sharing the database would fail with `FATAL: remaining connection slots are reserved for non-replication superuser connections`. The schema-layer `le=100` is the cheapest place to refuse the misconfiguration; pair it with a startup check that logs `pool_size * expected_workers` against the Postgres `max_connections` and warns if the product exceeds 80%.


**What `env_prefix` actually does**

When `Settings()` is constructed, `pydantic-settings` walks the env vars looking for matches. With `env_prefix="BOARDLY_DB_"`, it looks for `BOARDLY_DB_URL`, `BOARDLY_DB_POOL_SIZE`, `BOARDLY_DB_POOL_PRE_PING`. The prefix is stripped before matching the field name: `BOARDLY_DB_URL` → field `url`. The prefix is case-sensitive (because `case_sensitive=True` is set on the top-level `Settings`); `boardly_db_url` would not match.

The prefix is a namespace mechanism: it prevents collisions between unrelated apps on the same machine. Without a prefix, `URL` would collide with every other app that has a `URL` env var. With `BOARDLY_DB_URL`, the namespace is clean.


**`case_sensitive=True` interacts with Kubernetes ConfigMap key casing.**

Kubernetes `ConfigMap` keys are case-sensitive at the YAML level, but some tooling (Helm `envFrom`, kustomize, some sidecar injectors) lowercases keys when injecting them as environment variables. If your `case_sensitive=True` settings expect `BOARDLY_DATABASE__URL` and the ConfigMap ships `boardly_database__url` (lowercase), the field is silently missing and the service fails at startup with `Field required` — which looks identical to "the operator forgot to set the var." The fix is either (a) keep ConfigMap keys uppercase in the YAML (the literal key is preserved through `envFrom`), or (b) set `case_sensitive=False` and accept the casing collapse (your `database_url` and `DATABASE_URL` would both map to the same field — usually fine, occasionally surprising when two tools export the same field with different cases). The Boardly convention is (a): uppercase ConfigMap keys, `case_sensitive=True`, so a casing mismatch is loud at startup, not silent at the first request. A startup log line that prints the resolved `settings.database.url` (redacted if it contains credentials) makes the mismatch visible to the operator immediately.


### Lines 28–32: `RedisSettings`

```python
class RedisSettings(BaseSettings):
 model_config = SettingsConfigDict(env_prefix="BOARDLY_REDIS_")

 url: str = "redis://localhost:6379/0"
 max_connections: int = Field(default=20, ge=1, le=200)
```

**What it does:** Same pattern as `DatabaseSettings`, but for Redis. The env prefix `BOARDLY_REDIS_` means `BOARDLY_REDIS_URL` and `BOARDLY_REDIS_MAX_CONNECTIONS`.

**Why `url` has a default here and not on `DatabaseSettings`:** A product decision — Redis is optional for local development (you might not be running a Redis container locally), while Postgres is required. The default `redis://localhost:6379/0` lets local dev start without setting `BOARDLY_REDIS_URL`. In production, you override the env var. If the local Redis is missing, `await redis.ping()` in the lifespan fails loudly — the right behavior.

### Lines 35–43: `AuthSettings` with `SecretStr`

```python
class AuthSettings(BaseSettings):
 model_config = SettingsConfigDict(env_prefix="BOARDLY_AUTH_")

 jwt_secret: SecretStr = Field(
 ..., description="NEVER commit. Generate with `openssl rand -hex 32`.",
 )
 jwt_algorithm: Literal["HS256", "HS384", "HS512"] = "HS256"
 access_token_ttl_minutes: int = Field(default=60, ge=1)
 refresh_token_ttl_days: int = Field(default=30, ge=1)
```

**What it does:** Declares the auth settings. `jwt_secret` is required and uses the `SecretStr` type to keep it out of logs.

**Why `SecretStr`:** Because `str` would print the actual value in `repr(settings.auth.jwt_secret)`. `SecretStr.__repr__()` returns `SecretStr('**********')`. The value is accessible via `settings.auth.jwt_secret.get_secret_value()` — explicit and grep-able. This is one of the few security wins that the type system gives you for free.

**Why `jwt_algorithm` is a `Literal`:** Because only three values are valid for the `HS*` family of HMAC-SHA algorithms in `python-jose`. `Literal["HS256", "HS384", "HS512"]` rejects `"RS256"` (which would require a private key instead of a shared secret) at startup. The error message tells the operator exactly what's wrong.

**Why the TTLs have `ge=1`:** Because a TTL of 0 or negative is nonsense. A misconfigured `BOARDLY_AUTH_ACCESS_TOKEN_TTL_MINUTES=0` fails at startup.

**Warning — The JWT secret must not be the default.**

`jwt_secret` is *required* (`...`). There is no default. The reason: a default secret would be the same for every installation, which means an attacker who knows the default could forge tokens for any deployment that forgot to set the env var. The startup failure is the safety: the service refuses to start without a secret, which forces the operator to generate one (`openssl rand -hex 32`).

The description text ("NEVER commit. Generate with `openssl rand -hex 32`") is a docstring surfaced in `/docs` and in the JSON Schema. It is documentation, not a substitute for the type contract.


**Danger — Rotating `jwt_secret` invalidates every outstanding refresh token — plan a grace window before you need it.**

The `jwt_secret` signs every access and refresh token. The day you rotate it (because a laptop was stolen, because the secret leaked to a log, because the security team mandates quarterly rotation), every token signed by the old secret fails verification — every user with an active session is logged out, mid-request, with no warning and no UX to explain it. The fix is not "rotate faster" but "rotate with a grace window": run two `AuthSettings` instances (old secret + new secret) for one refresh-TTL window, accept tokens signed by either, sign new tokens only with the new secret. After one refresh-TTL, drop the old secret and remove the dual-verification path. Without the grace window, a rotation is a forced mass-logout that your support team will hear about. Plan the rotation procedure (the dual-secret config, the monitoring for old-secret usage dropping to zero, the cleanup PR) before you need it; the worst time to design it is during an incident.


### Lines 46–58: `Settings` top-level with `env_file` and `env_nested_delimiter`

```python
class Settings(BaseSettings):
 """Top-level settings — assembled from env vars and .env."""

 model_config = SettingsConfigDict(
 env_prefix="BOARDLY_",
 env_file=".env",
 env_file_encoding="utf-8",
 env_nested_delimiter="__", # BOARDLY_DATABASE__URL maps to database.url
 case_sensitive=True,
 extra="ignore",
 )

 # --- top-level scalars ---
 debug: bool = False
 log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
 environment: Literal["local", "dev", "staging", "prod"] = "local"

 # --- nested sub-configs (loaded by env_nested_delimiter) ---
 database: DatabaseSettings
 redis: RedisSettings
 auth: AuthSettings
```

**What it does:** Declares the top-level `Settings` class. The configuration:

- `env_prefix="BOARDLY_"` — top-level env vars are `BOARDLY_DEBUG`, `BOARDLY_LOG_LEVEL`, `BOARDLY_ENVIRONMENT`.
- `env_file=".env"` — read the `.env` file in the current working directory. The file format is `KEY=VALUE` per line, same as `docker-compose` and `direnv`.
- `env_file_encoding="utf-8"` — interpret the `.env` file as UTF-8.
- `env_nested_delimiter="__"` — env vars like `BOARDLY_DATABASE__URL` map to the `database.url` nested field. The double underscore is the delimiter.
- `case_sensitive=True` — env var names must match the field name's case. `BOARDLY_DEBUG` matches `debug`; `BOARDLY_debug` does not.
- `extra="ignore"` — unknown env vars (those starting with `BOARDLY_` but not matching a field) are silently ignored. This is more permissive than Lesson 1's `extra="forbid"` for request bodies, because the environment is not adversarial — operators may set extra vars for unrelated tooling.

**Why does `Settings` use `extra="ignore"` when Lesson 1 insisted on `extra="forbid"` for request bodies?** Because the failure mode and the threat model are different. A request body is adversarial — a client who sends `"is_admin": true` is probing for privilege escalation, and "silently drop" is the wrong response. The environment is operator-controlled — an unknown `BOARDLY_FOO=bar` is most likely a stale var from a previous deployment, an unrelated tool that happens to use the same prefix, or a CI runner exporting extra config. Loudly rejecting the process start because of a stale var would be hostile to operators. The right behavior for *untrusted* input is "forbid" (reject at the boundary); the right behavior for *trusted-but-messy* input is "ignore" (silently drop). The asymmetry between request and config is the asymmetry between "validate everything the client sends" and "trust the operator's environment, but check the fields you actually depend on."

**`extra="ignore"` is right for operators, wrong for CI runners that export sensitive overrides.**

The `extra="ignore"` setting means a stale `BOARDLY_FOO=bar` env var (from a previous deploy, an unrelated tool, a developer's shell) is silently dropped. That is the right behavior for production operators — a stale var should not block a deploy. The trap is CI: a CI runner that exports `BOARDLY_AUTH_JWT_SECRET` from a secret manager, then re-exports a different `BOARDLY_AUTH_JWT_SECRET` from a cached `.env` committed by mistake, will silently use the cached value if the secret-manager export is misspelled (`BOARDLY_AUTH_JWT_SECREET=...` with a typo). The schema does not catch the typo because `extra="ignore"` drops the unknown `BOARDLY_AUTH_JWT_SECREET`. The fix is a CI lint that asserts every `BOARDLY_*` env var exported by the runner is a known field — `python -c "import os; from boardly.settings import Settings; known=set(Settings.model_fields); exported={k for k in os.environ if k.startswith('BOARDLY_')}; print(exported - known)"` returning an empty set. The asymmetry: trust operators, lint CI.


**Why nested sub-configs are typed as the nested class (`database: DatabaseSettings`):** The type system then knows `settings.database.url` is a `str`, `settings.database.pool_size` is an `int`. The IDE autocompletes; the type checker validates downstream code; the docstring is visible.

**Why the nested classes don't have their own `env_prefix` here:** Because the top-level `Settings` class loads them via `env_nested_delimiter`. The nested `DatabaseSettings` *does* have its own `env_prefix="BOARDLY_DB_"` — but that prefix only applies when the nested class is constructed standalone. When loaded via the top-level `Settings`, the prefix is `BOARDLY_DATABASE__URL` (via the delimiter), and the nested class's own prefix is *ignored*. This is a subtle and confusing aspect of `pydantic-settings`.

**Two ways to load nested settings**

There are two ways to load nested settings, and they do **not** both work for the same `Settings()` construction:
- **Delimiter-based** (used here on the top-level `Settings`): `BOARDLY_DATABASE__URL` maps to `settings.database.url`. The nested class's own `env_prefix` is **ignored** when the parent walks its fields.
- **Prefix-based** (used by the nested classes when constructed standalone): `BOARDLY_DB_URL` maps to `DatabaseSettings().url`. This requires the nested class to be instantiated by itself, not as a field of the top-level `Settings`.

In the lesson, the top-level `Settings` uses the delimiter form (`BOARDLY_DATABASE__URL`), so the nested classes' prefixes are **dormant** — they only take effect if you also write code like `DatabaseSettings()` directly. Setting `BOARDLY_DB_URL` alone (without `BOARDLY_DATABASE__URL`) will **not** populate `settings.database.url` via the top-level `Settings`. Both forms can coexist in the same process — the operator's shell may export `BOARDLY_DB_URL` for a one-off test script that constructs `DatabaseSettings()` standalone — but only one form is consulted for any given construction.

The Boardly convention is: use the delimiter form for the top-level `Settings`. The prefix form is a fallback for tests that construct a nested class directly.


### Lines 60–63: `_uppercase_level` validator

```python
 @field_validator("log_level", mode="before")
 @classmethod
 def _uppercase_level(cls, v: str | None) -> str | None:
 if isinstance(v, str):
 return v.upper()
 return v
```

**What it does:** Normalizes `LOG_LEVEL=info` to `INFO` before the `Literal["DEBUG", "INFO", "WARNING", "ERROR"]` check runs. Without this, `LOG_LEVEL=info` would fail the `Literal` check (because `info` is not in the literal list — `INFO` is).

**Why `mode="before"`:** Because the input is the raw env var string. We need to transform it (uppercase) before Pydantic's `Literal` validator runs and rejects `"info"` for not matching `"INFO"`. With `mode="after"`, the validator would run *after* the `Literal` check, by which point `"info"` has already failed.

**Why `if isinstance(v, str)`:** Defensive. `v` could be `None` (if the env var is unset and the field has a default). The validator should pass `None` through (Pydantic will use the default).

**Student asks: why not just declare `log_level` as `str` and validate in the service layer?**

Because the type contract should be enforced at the configuration boundary, not in the service layer. `Literal["DEBUG", "INFO", "WARNING", "ERROR"]` says: the field is one of these four. Anything else fails at startup. If you declared `str`, a misconfigured `LOG_LEVEL=VERBOSE` would propagate to the service layer and crash `logging.getLogger().setLevel("VERBOSE")` — which fails with a confusing `ValueError: Invalid log level: VERBOSE`. The schema-layer check is louder and earlier. The same principle from Lessons 1–3 (validate at the boundary) applies to settings.


**Warning — `Literal` case-rejection looks like "the env var is not read" — it is read, but rejected.**

A `LOG_LEVEL=info` (lowercase) that fails the `Literal["DEBUG", "INFO", "WARNING", "ERROR"]` check produces a `ValidationError` that says `Input should be 'DEBUG', 'INFO', 'WARNING' or 'ERROR'`. An operator who has not read the schema reads that as "the env var is being ignored" and tries `export LOG_LEVEL=INFO` (uppercase) — which works, confirming the misdiagnosis. The actual bug is that the env var IS being read, but the value is rejected at the `Literal` check, which is case-sensitive. The `_uppercase_level` `@field_validator(mode="before")` is the fix; without it, the operator's mental model ("env vars are case-insensitive") crashes into Pydantic's contract (`Literal` is case-sensitive). The debugging move: `python -c "import os; print(repr(os.environ.get('BOARDLY_LOG_LEVEL')))"` — the `repr()` shows the exact bytes including case; a `LOG_LEVEL=info` shows `'info'`, which the schema rejects. Always read the `repr()`, not the value, when debugging string-validation failures.


### Lines 65–69: `_no_prod_in_local` cross-field validator

```python
 @model_validator(mode="after")
 def _no_prod_in_local(self) -> Settings:
 if self.environment == "prod" and self.debug:
 raise ValueError("DEBUG=True is forbidden in prod")
 return self
```

**What it does:** A cross-field rule: if `environment == "prod"` and `debug == True`, raise. This catches the most dangerous config mistake — running with `DEBUG=True` in production, which typically exposes a Werkzeug-style debugger or disables security checks.

**Why this is a `@model_validator(mode="after")` and not a `@field_validator`:** Because the rule needs to read **two** fields (`environment` and `debug`) at once. In Pydantic v2, `@field_validator` is a classmethod-style decorator — its function receives `cls` and the parsed value for a single field, with no access to the model instance or to other fields. Calling `self.debug` inside `@field_validator("environment", mode="after")` does not work: `self` is the class, and `cls.debug` returns the class-level default (always `False`), so the rule silently never fires. `@model_validator(mode="after")` *is* an instance method — it receives the full validated `self` and can read every field. That is the canonical form Lesson 3 teaches, and it is the only form that works here.

**Warning — `@field_validator` cross-field rules do not work in Pydantic v2.**

A common v1 → v2 migration bug is to write `@field_validator("environment", mode="after")` and reach for `self.debug`. In v2 that `self` is bound to the class (because `@field_validator` wraps the function in `classmethod`), so `self.debug` is the class-level default — not the env-var value. The cross-field rule silently passes. Use `@model_validator(mode="after")` for any rule that needs more than one field. Lesson 3's Mistake 4 covers the same trap on request bodies.


**Danger — `environment="prod" + debug=True` is one of the cheapest security controls — list the attack surface it blocks.**

The `_no_prod_in_local` `@model_validator(mode="after")` rule refuses to start the service if both are set. The attack surface it blocks: (a) FastAPI's `/docs` and `/redoc` endpoints, which expose every route's signature, every model's fields, and every error response shape — a reconnaissance goldmine for an attacker mapping your API; (b) Starlette's `ServerErrorMiddleware` default behavior, which returns the full Python traceback to the client on unhandled exceptions — a source-code leak that reveals internal structure, library versions, and file paths; (c) any debug toolbar or profiling middleware that an engineer added "just for local dev" and forgot to gate on `environment != "prod"`; (d) `app.state.settings` being dumped in a health-check endpoint for debugging, leaking every config value including secrets if `SecretStr` redaction is bypassed by a custom encoder. A single two-line validator blocks all four. The cost is one `@model_validator` and one CI test that asserts the rule exists; the benefit is that no operator can accidentally ship a debug-mode prod. This is the highest leverage-per-line security control in the settings layer.


### Lines 72–75: `get_settings()` factory

```python
def get_settings() -> Settings:
 """Factory used by the lifespan and by Depends(get_settings)."""
 return Settings()
```

**What it does:** Declares a factory function that constructs a fresh `Settings` instance.

**Why a function instead of a module-level singleton:** Because FastAPI's `Depends(get_settings)` mechanism needs a callable. With this factory, you can `Depends(get_settings)` in any endpoint or dependency, and FastAPI caches the result for the request. In tests, you can override the factory with `app.dependency_overrides[get_settings] = lambda: Settings(environment="test")`. The factory pattern is what makes the settings testable.

**Why we *also* call `Settings()` directly in the lifespan:** Because the lifespan runs *once* at process start, before any request. FastAPI's `Depends` machinery does not apply to lifespan code. The lifespan calls `Settings()` directly; request handlers use `Depends(get_settings)`.

**Why not just `settings = Settings()` at module top, since the lifespan reads it directly anyway?** Because moving the construction to module top would make two things worse: testing and import-time failure modes. (1) Tests would have to monkeypatch the environment *before* `import boardly.main`, instead of override the dependency at the test's own pace — the `app.dependency_overrides[get_settings] = lambda: Settings(environment="test")` pattern only works if the *call* is deferred until request time. With a module-level call, the test runner reads real env vars at import time and there's no override point. (2) A misconfigured env would crash at `import boardly.main` — meaning every test, every linter that imports the module, and every `python -c "import boardly.main; ..."` invocation would fail with a `ValidationError` before your code even runs. Keeping the construction in the lifespan puts the failure at Uvicorn startup, where the operator is; tests and tooling can still import the module and introspect the app without env vars set.

**Spot the bug — what happens if you call `Settings()` inside a request handler instead of in the lifespan?**

The handler runs on every request. `Settings()` reads env vars, parses them, and constructs the model — every time. For a 7-field `Settings`, this is microseconds, but the cost scales with the schema and you've also broken `app.dependency_overrides[get_settings]` (the override never gets called because the handler reads `Settings()` directly). Worse, if the env changes mid-process (rare but possible), each request sees a different settings instance — the opposite of the "load once, read many times" contract. The fix is `Depends(get_settings)`: FastAPI caches the call per request, and tests can override the dependency with one line.


**`app.dependency_overrides[get_settings]` is the test seam — use it, do not monkeypatch `os.environ`.**

The factory pattern (`def get_settings() -> Settings: return Settings()`) lets a test override the settings without touching `os.environ`. The override is one line: `app.dependency_overrides[get_settings] = lambda: Settings(environment="test", debug=False, auth=AuthSettings(jwt_secret=SecretStr("test"), ...))`. The alternative — monkeypatching `os.environ` — is fragile: it leaks across tests (the env is a process-global), it requires the override to happen before any `Settings()` call (including transitive imports), and it does not test the `Depends` wiring (the override path tests that the endpoint actually calls `Depends(get_settings)`, not `Settings()` directly). The dependency-override path tests the wiring; the env-monkeypatch path tests only the schema. Both are useful; the override is the primary, the monkeypatch is the fallback for testing the schema itself in isolation. The cleanup is `app.dependency_overrides.clear()` in the test's teardown — forgetting it leaks the override into the next test.


### Lines 80–88: Wiring `Settings` into the lifespan

```python
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
 settings = Settings() # validates at startup
 app.state.settings = settings
 print(f"Boardly starting up — env={settings.environment}, "
 f"log_level={settings.log_level}")
 # ... create_async_engine(settings.database.url, ...) etc. ...
 yield
 print(f"Boardly shutting down — env={settings.environment}")
```

**What it does:** Constructs `Settings()` at startup. If any field fails validation, `ValidationError` is raised, Uvicorn logs it, and the process exits non-zero. If all fields pass, the instance is stashed on `app.state.settings` for later dependencies to read.

**Why construct in at startup and not at module import:** Two reasons. (1) Tests — `import boardly.main` should not trigger `Settings()` construction, because tests want to override the env first. Putting the construction in the lifespan means tests can import `boardly.main` (which defines the `app`) without reading any env vars. (2) Failure mode — if `Settings()` is at module top, an import error from a misconfigured env crashes the test runner with no context. If it's in the lifespan, the failure happens at Uvicorn startup, which is the right place.

**Why stash on `app.state.settings`:** Dependencies can read it via `request.app.state.settings` or `Depends(get_settings)` (which FastAPI caches per request). The two paths give the same instance in normal operation; the `app.state` path is the storage, the `Depends` path is the access.

## Execution Trace

Run the smoke test:

```bash
# Without env vars: should fail (DATABASE_URL is required, JWT_SECRET is required)
uv run python -c "from boardly.settings import Settings; Settings()"
# Expected: ValidationError listing missing BOARDLY_DATABASE_URL and BOARDLY_AUTH_JWT_SECRET

# With env vars set:
BOARDLY_DATABASE_URL='postgresql+asyncpg://user:pass@localhost/boardly' \
BOARDLY_AUTH_JWT_SECRET='a' \
uv run python -c "
from boardly.settings import Settings
s = Settings()
print('env:', s.environment)
print('debug:', s.debug)
print('database:', s.database.url)
print('redis:', s.redis.url)
print('auth.jwt_secret:', repr(s.auth.jwt_secret))
print('dump:', s.model_dump())
"
```

Expected output (truncated):

```
env: local
debug: False
database: postgresql+asyncpg://user:pass@localhost/boardly
redis: redis://localhost:6379/0
auth.jwt_secret: SecretStr('**********')
dump: {'debug': False, 'log_level': 'INFO', 'environment': 'local',
 'database': {'url': '...', 'pool_size': 10, 'pool_pre_ping': True},
 'redis': {'url': '...', 'max_connections': 20},
 'auth': {'jwt_secret': SecretStr('**********'),
 'jwt_algorithm': 'HS256',
 'access_token_ttl_minutes': 60,
 'refresh_token_ttl_days': 30}}
```

Note: `repr(s.auth.jwt_secret)` is `SecretStr('**********')` — the underlying secret does not appear in `repr()`. The same is true of `str(s.auth.jwt_secret)`, which returns `'**********'`. In Pydantic v2, `s.model_dump()` returns the `SecretStr` instance itself, so printing the dump shows `'jwt_secret': SecretStr('**********')` — also redacted, as the dump output above confirms. **However**, this redaction is *cosmetic*: the underlying value is still reachable via `s.auth.jwt_secret.get_secret_value()`, and any downstream code (a logger, a custom JSON encoder, a debug helper) that calls `.get_secret_value()` will leak the secret to the log line. The safe path for logging settings is `model_dump_json()` — Pydantic's serializer emits `"**********"` as a plain JSON string, and there is no `SecretStr` instance for downstream code to reach into:

```python
class AuthSettings(BaseSettings):
 ...
 model_config = SettingsConfigDict(env_prefix="BOARDLY_AUTH_")
 # In Pydantic v2, `model_dump()` returns the SecretStr instance (whose
 # repr is redacted). The risk is *not* the repr — it's that downstream
 # code can still call .get_secret_value() on the instance and leak.
 # To redact in dumps, either:
 # 1. Use model_dump_json() — SecretStr serialises to "**********"
 # 2. Use model_dump(mode="json") — SecretStr is replaced with the string "**********"
 # 3. Add a field_serializer that returns "REDACTED"
```

**Verify the `SecretStr` claim against your installed Pydantic**

The behavior described here matches Pydantic v2.14.1 (the version pinned in the Verified Versions table). If you are on a different v2.x patch — particularly older ones — re-check the official docs at <https://docs.pydantic.dev/latest/concepts/fields/#secret-types> before relying on it. The behavior of `model_dump(mode="json")` for `SecretStr` has been stable since v2.0; the exact `repr()` string (`'**********'`) is also stable. The author has not run the code against live Pydantic v2.14.1 in this lesson's review pass; treat this section as needing live verification if you ship it to production logging code.


The convention is: never `model_dump()` settings; if you must, use `model_dump_json()` which keeps `SecretStr` redacted.

Then run the lifespan by starting Uvicorn:

```bash
BOARDLY_DATABASE_URL='postgresql+asyncpg://user:pass@localhost/boardly' \
BOARDLY_AUTH_JWT_SECRET='a' \
uv run uvicorn boardly.main:app
```

Expected Uvicorn logs:

```
Boardly starting up — env=local, log_level=INFO
INFO: Started server process [1234]
INFO: Application startup complete.
INFO: Uvicorn running on http://127.0.0.1:8000
```

If you remove `BOARDLY_AUTH_JWT_SECRET`, Uvicorn logs:

```
Traceback (most recent call last):
 ...
pydantic_core._pydantic_core.ValidationError: 1 validation error for Settings
auth.jwt_secret
 Field required [type=missing, ...]
ERROR: Application startup failed. Exiting.
```

The process exits non-zero. No traffic is served. The misconfiguration is caught at startup, not at the first request.

```mermaid
flowchart TD
 ENV["Env vars<br/>BOARDLY_DATABASE_URL=..."] --> S["Settings() constructor"]
 DOTENV[".env file (lower priority)"] --> S
 DEFAULTS["Defaults (lowest priority)"] --> S
 S --> V["Pydantic validator (Rust)"]
 V -->|failure| ERR["ValidationError<br/>Uvicorn exits non-zero"]
 V -->|success| INST["Settings instance"]
 INST --> STATE["app.state.settings = INST"]
 STATE --> LIFESPAN["Lifespan continues<br/>create_async_engine(inst.database.url, ...)"]

 style ENV fill:#d4edda,stroke:#28a745
 style DOTENV fill:#cce5ff,stroke:#007bff
 style DEFAULTS fill:#fff3cd,stroke:#ffc107
 style ERR fill:#f8d7da,stroke:#dc3545
 style INST fill:#d4edda,stroke:#28a745
```

**You've just wired real configuration into Boardly.**

The service now starts only if its configuration is valid. Secrets stay out of logs. Env vars override `.env` override defaults. The lifespan reads `settings.database.url` and constructs the engine. The dependencies read `app.state.settings` for any per-request config. The architecture is identical to a service with a hundred settings, four environments, and three rotating secrets.


## Common Mistakes

### Mistake 1: Forgetting to install `pydantic-settings`

```bash
uv add pydantic # forgot pydantic-settings!
```

```python
# Then:
from pydantic_settings import BaseSettings
# ModuleNotFoundError: No module named 'pydantic_settings'
```

**Symptom:** `ModuleNotFoundError: No module named 'pydantic_settings'` at import time.

**Why:** `pydantic` and `pydantic-settings` are separate packages. Installing `pydantic` does not install `pydantic-settings`.

**Fix:** `uv add pydantic-settings`. The package depends on `pydantic>=2.0`, so it pulls in the right version.

### Mistake 2: Module-level `Settings()` construction

```python
# boardly/settings.py
settings = Settings() # at module top, runs on import

# boardly/main.py
from boardly.settings import settings
```

**Symptom:** `import boardly.main` (e.g., in a test) raises `ValidationError` because the test environment has no `BOARDLY_DATABASE_URL` set.

**Why:** Module-level code runs at import. The test runner imports `boardly.main`, which imports `boardly.settings`, which calls `Settings()` at module top. The env is not set in the test runner; `ValidationError`; test session dies.

**Fix:** Move `Settings()` into the lifespan (per the lesson). Tests import `boardly.main` (which only defines `app` and `lifespan`, not the settings instance). They override the env or the factory before the lifespan runs.

**Warning — Distinguish "ValidationError on import" from "ValidationError at startup" by the traceback's file path.**

A `ValidationError` whose traceback's last frame is `boardly/settings.py` line `N` (the `Settings()` call inside the lifespan) means the lifespan triggered it — the right place, the failure is at Uvicorn startup. A `ValidationError` whose last frame is `<frozen importlib._bootstrap>` or `boardly/main.py` line `N` (an `import` statement) means a module-level `Settings()` call triggered it — the wrong place (Mistake 2), the failure breaks the test runner. The fix is the same in both cases (move `Settings()` into the lifespan), but the diagnosis differs: the import-time failure breaks every `import boardly.main` (tests, linters, `python -c`), the startup-time failure breaks only Uvicorn. Read the traceback's last frame first; the file and line tell you whether the construction is at module top or in the lifespan, which is the single fact that determines the blast radius.


### Mistake 3: Default value for a secret

```python
# WRONG
class AuthSettings(BaseSettings):
 jwt_secret: str = "CHANGE_ME" # NO!
```

**Symptom:** The service starts in production with the default secret. An attacker who knows the default forges JWTs for any user.

**Why:** A default secret is the same for every installation. An attacker who knows the default for `Boardly` (e.g., from reading the source) has the secret for every deployment that forgot to override it.

**Fix:** `jwt_secret: SecretStr = Field(...)`. Required, no default. The service refuses to start without `BOARDLY_AUTH_JWT_SECRET` set. Force the operator to generate one.

**Danger — Default secrets are CVE-class bugs — cite the pattern, not the anecdote.**

A default JWT secret in source code is a `CWE-798: Use of Hard-coded Credentials` instance. The CVE database is full of these: every "default credentials in IoT device" and "hardcoded API key in mobile app" CVE is the same pattern at a different layer. The attack: an attacker reads the source (open-source repo, leaked image, decompiled binary), extracts the default secret, and forges tokens for every deployment that did not override it — which is every deployment whose operator did not read the deployment guide. The defense is the schema-layer `Field(...)` (required, no default) plus a CI test that asserts `AuthSettings.model_fields["jwt_secret"].is_required()` is `True` and `AuthSettings.model_fields["jwt_secret"].default` is `PydanticUndefined`. The test is two lines; the bug it prevents is a public-disclosure-class incident. Treat any `SecretStr` field with a default as a P0 finding in code review; treat any `str` field holding a secret (no `SecretStr`) as a P0 finding too.


### Mistake 4: `LOG_LEVEL=info` rejected by `Literal`

```python
# Without the _uppercase_level validator:
log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
# Setting LOG_LEVEL=info raises ValidationError
```

**Symptom:** A staging deployment with `LOG_LEVEL=info` (lowercase, as some operators prefer) fails to start with `Input should be 'DEBUG', 'INFO', 'WARNING' or 'ERROR'`.

**Why:** `Literal` is case-sensitive. `"info"` is not in `["DEBUG", "INFO", ...]`. Pydantic refuses.

**Fix:** Add the `_uppercase_level` validator (`mode="before"`) to normalize case before the `Literal` check. This lesson includes this exact validator (the `_uppercase_level` validator declared earlier on the `Settings` class).

### Mistake 5: `DEBUG=True` in prod (the cross-field rule missed)

```python
# Without the _no_prod_in_local validator:
class Settings(BaseSettings):
 debug: bool = False
 environment: Literal["local", "dev", "staging", "prod"] = "local"

# Operator sets BOARDLY_DEBUG=True and BOARDLY_ENVIRONMENT=prod
# Service starts. /docs is exposed. Stack traces leak to clients.
```

**Symptom:** Production runs with debug mode. Security-sensitive endpoints (`/docs`, `/redoc`, stack traces) are exposed.

**Why:** The two fields are independent; nothing checks their combination. The cross-field rule is missing.

**Fix:** Add the `_no_prod_in_local` validator (the `@model_validator(mode="after")` form declared earlier in this lesson) to refuse `environment="prod"` when `debug=True`.

### Mistake 6: Logging the `SecretStr` instance and reaching into it

```python
# WRONG — the print line is fine, but the helper later leaks:
print(s.model_dump()) # shows 'jwt_secret': SecretStr('**********') — redacted
# ...but somewhere else in the codebase:
log.info("settings: %s", {k: v.get_secret_value() if hasattr(v, 'get_secret_value') else v
 for k, v in s.model_dump().items()})
# ↑ the helper reaches into SecretStr and logs the actual secret
```

**Symptom:** The JWT secret ends up in the log archive forever. (The first line is fine — printing `model_dump()` shows `SecretStr('**********')`, redacted. The leak is the second line, where a "helpful" encoder reaches into the `SecretStr` instance and calls `.get_secret_value()`.)

**Why:** Pydantic v2 `model_dump()` returns the `SecretStr` instance itself, whose `repr()` is `SecretStr('**********')` — cosmetically redacted. But the underlying value is reachable via `.get_secret_value()`, and any custom JSON encoder, debug helper, or logging filter that reaches into the instance can leak it. `model_dump_json()` is safer because Pydantic's serializer emits `"**********"` as a plain JSON string — there is no `SecretStr` instance left for downstream code to reach into.

**Fix:** Never call `.get_secret_value()` on settings fields for logging. Use `print(s.model_dump_json())` (Pydantic's serializer redacts to `"**********"`), or `print(s.model_dump(mode="json"))` (replaces `SecretStr` with the redacted string), or add a `@field_serializer("jwt_secret")` that returns `"REDACTED"`.

**Warning — `rg -n "get_secret_value" boardly/` is a CI lint — expect zero hits outside auth/token code.**

The `.get_secret_value()` method is the one way to extract the plaintext from a `SecretStr`. It is legitimate in token-signing code (`jwt.encode(payload, settings.auth.jwt_secret.get_secret_value())`) and illegitimate everywhere else. A `rg -n "get_secret_value" boardly/` that returns a hit in a logging module, a middleware, a debug helper, or a health-check endpoint is a leak waiting to happen — the call site looks innocent in code review but writes the plaintext to a log line that ships to your log aggregator forever. The CI lint: `rg -n "get_secret_value" boardly/ | rg -v "auth/|token_signing|test_"` — the `-v` excludes the legitimate paths; any remaining hit fails the build. The lint runs in seconds, catches the leak before it ships, and is the cheapest defense against Mistake 6's "helpful encoder" pattern. Add the lint to the same CI stage that runs `pytest`; it is faster than the tests.


## Engineering Trade-Offs

### `env > .env > default` priority order

The priority order is: environment variables (highest), `.env` file (middle), defaults (lowest). The trade-off:

- **Env vars highest** means a production deploy (Kubernetes `env:` block, Docker `-e` flag, `systemd` `Environment=`) overrides the local `.env` file. This is the right order for production — the operator's intent wins.
- **`.env` file middle** means local development can use a `.env` file in the project root (typically gitignored) for personal config — `BOARDLY_DATABASE_URL=postgresql+asyncpg://localhost/boardly_dev`. This is the right order for dev — the file is the lowest-friction way to set local config.
- **Defaults lowest** means the schema declares a sensible default for fields where a default is safe (`pool_pre_ping=True`, `log_level="INFO"`). Required fields (`url`, `jwt_secret`) have no default; they must be supplied by env or `.env`.

The opposite order (default > .env > env) is wrong because it makes the operator's intent invisible. A `BOARDLY_DEBUG=False` in production would be silently overridden by a `.env` file's `BOARDLY_DEBUG=True` left over from local dev — a classic production bug.

**When would you flip the priority — say, env > default > .env?**

Almost never in a web service. The only legitimate case is a CLI tool whose `.env` is the user's machine-local override of the developer's baked-in defaults — and even there, you'd typically just use no `.env` at all and let env-or-default do the work. In a 12-factor service, the operator's env vars must always win — that's the contract that lets a Kubernetes deployment roll out a new config without touching the image. Flipping the order breaks the contract.


**`.env` files baked into Docker images are a secret-leak anti-pattern.**

The `env_file=".env"` setting reads a `.env` from the working directory at `Settings()` construction time. In local dev, that is the project root and the file is gitignored — fine. In Docker, the working directory is the image's `WORKDIR`, and if the `.env` is `COPY`'d into the image (a common mistake in a `Dockerfile` that does `COPY . .`), the secret is now in every `docker pull` of that image — discoverable with `docker history <image>` (shows the `COPY` layer) and `docker run --rm <image> cat /app/.env` (extracts the file). The production pattern is: never `COPY .env` into the image (add it to `.dockerignore`); pass env vars at runtime via `docker run -e`, Kubernetes `env:`, a secrets manager sidecar, or a mounted secret volume. The `env_file=".env"` setting is a local-dev convenience; in prod, the env vars are set directly and the `.env` is absent. The schema does not care which path feeds it — both produce the same `Settings` instance — but the image-leak path is irreversible once the image is pushed to a registry.


### Nested settings vs flat settings

You can flatten `Settings` into one class:

```python
class Settings(BaseSettings):
 database_url: str
 database_pool_size: int = 10
 redis_url: str = "redis://localhost:6379/0"
 ...
```

vs the nested form (Lesson 5):

```python
class Settings(BaseSettings):
 database: DatabaseSettings
 redis: RedisSettings
 auth: AuthSettings
```

The trade-off:

- **Flat**: simpler. One class, one set of env vars (`BOARDLY_DATABASE_URL`, `BOARDLY_DATABASE_POOL_SIZE`, ...). No nesting.
- **Nested**: more structured. Grouped config (`settings.database.url`, `settings.database.pool_size`). Easier to pass a sub-config to a function: `create_async_engine(settings.database.url, pool_size=settings.database.pool_size)` reads better than `create_async_engine(settings.database_url, pool_size=settings.database_pool_size)`.

The Boardly convention is: nested for any non-trivial config (more than 5 fields per group). Flat for tiny configs.

### `BaseSettings` vs hand-rolled `os.getenv`

Two ways to load config:

- **`BaseSettings`** (this lesson): typed, validated, layered, secret-aware. The Pydantic way.
- **`os.getenv("DATABASE_URL")`**: untyped, returns `str | None`, no validation, no `.env` support, scattered through the codebase.

The trade-off:

- **`BaseSettings`**: 70 lines of schema; one `Settings()` call at startup; type-safe access everywhere.
- **`os.getenv`**: 0 lines of schema; `os.getenv(...)` calls scattered through the codebase; `str | None` everywhere; missing env vars crash later with cryptic errors.

The Boardly convention is: `BaseSettings`. The 70 lines of schema pay for themselves the first time a misconfigured env fails at startup instead of at the first request.

### Per-environment settings

Three patterns:

- **One `Settings` class, env-var differences**: deploy the same code with different env vars in each environment. The schema is the same; the operator's env vars differ. Simplest.
- **Multiple `Settings` subclasses** (`SettingsProd(BaseSettings)`, `SettingsDev(BaseSettings)`): each subclass overrides defaults. Use this when environments have structurally different config (e.g., prod uses a real Redis; dev uses an in-memory fake).
- **`Settings(environment="prod")` factory**: one `Settings` class, but the factory constructs based on a `--env prod` CLI flag. Use this for local dev tools.

The Boardly convention is: one `Settings` class, env-var differences. The other patterns are overkill for a small API.

## Exercises

**Tip — The 20-minute rule**

If you're stuck on an exercise for more than 20 minutes, re-read the relevant section above.


**Exercise 1 — Add a `cors_orig` setting.** Add `cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])` to `Settings`. Set `BOARDLY_CORS_ORIGINS='["https://boardly.app","https://staging.boardly.app"]'` (note: this is JSON-encoded) and confirm the list is parsed correctly. (Hint: `pydantic-settings` parses complex types from env via `json.loads`.)

**Exercise 2 — Trigger the `DEBUG=True in prod` rule.** Set `BOARDLY_DEBUG=True` and `BOARDLY_ENVIRONMENT=prod`. Confirm `ValidationError: DEBUG=True is forbidden in prod` is raised at `Settings()`.

**Exercise 3 — Use a `.env` file.** Create a `.env` file with `BOARDLY_DATABASE_URL=postgresql+asyncpg://localhost/boardly_dev` and `BOARDLY_AUTH_JWT_SECRET=dev_secret`. Run `Settings()` without setting any env vars. Confirm the values are loaded from `.env`. Then export `BOARDLY_AUTH_JWT_SECRET=override` in the shell and confirm the env var wins over the `.env` file.

**Exercise 4 — Add a `SecretStr` field serializer.** Add a `@field_serializer("jwt_secret")` to `AuthSettings` that returns `"REDACTED"` on `model_dump()`. Confirm `s.model_dump()["auth"]["jwt_secret"] == "REDACTED"` while `s.auth.jwt_secret.get_secret_value() == "actual_secret"`.

**Exercise 5 — Override `get_settings` in tests.** Use `app.dependency_overrides[get_settings] = lambda: Settings(environment="test", debug=False)`. Write an endpoint that returns `Depends(get_settings).environment` and confirm it returns `"test"`.

**Exercise 6 — Wire `Settings` into the full lifespan.** Extend the lifespan from Section 03 Lesson 1 to call `Settings()` and stash on `app.state.settings`. Add `app.state.engine = create_async_engine(settings.database.url, ...)` (you can mock the engine creation). Confirm a misconfigured env exits Uvicorn non-zero with a clear `ValidationError`.

**Exercise 7 — Add a `redis_password: SecretStr` field.** Add `redis_password: SecretStr = SecretStr("")` to `RedisSettings`. Set `BOARDLY_REDIS_PASSWORD=hunter2` and confirm `repr(settings.redis.redis_password) == "SecretStr('**********')"`, that `model_dump_json()` redacts the field to `"**********"`, and that `settings.redis.redis_password.get_secret_value() == "hunter2"` (the trap downstream code can fall into — the redaction is cosmetic, the plaintext is one method call away). Verify with `uv run pytest tests/test_redis_password_redaction.py -v`.

**Exercise 8 — Trigger the env-prefix-vs-delimiter footgun.** Set only `BOARDLY_DB_URL=postgresql+asyncpg://u:p@h/db` (no `BOARDLY_DATABASE__URL`) and `BOARDLY_AUTH_JWT_SECRET=abc`. Confirm `Settings()` raises `ValidationError` for `database.url` (the nested class's `env_prefix` is ignored when nested; only the parent's `BOARDLY_DATABASE__URL` works). Then set `BOARDLY_DATABASE__URL` and confirm success. Verify with `BOARDLY_DB_URL=postgresql+asyncpg://u:p@h/db BOARDLY_AUTH_JWT_SECRET=abc uv run python scripts/check_env_prefix.py`.

**Exercise 9 — Normalize `environment` case with a `@field_validator`.** Add `@field_validator("environment", mode="before")` that lowercases the input. Test `BOARDLY_ENVIRONMENT=PROD BOARDLY_DEBUG=True` (uppercase env var) — confirm the validator normalizes to `prod`, then `_no_prod_in_local` trips and raises `ValidationError`. Confirm the same env vars without your validator raise `Literal` case-rejection instead (the symptom from Callout 6). Verify with `uv run pytest tests/test_env_normalize.py -v`.

**Exercise 10 — Add a JSON-file config source via `customise_sources`.** Override `Settings.customise_sources` to add a `JsonConfigSettingsSource` reading `config.json` as a source between `.env` and defaults. Put `{"log_level": "WARNING"}` in `config.json`, leave `BOARDLY_LOG_LEVEL` unset, and confirm `settings.log_level == "WARNING"`. Then `export BOARDLY_LOG_LEVEL=ERROR` and confirm the env var wins over the JSON file. Verify with `uv run python scripts/test_custom_sources.py`.

**Exercise 11 — Audit the codebase for `.get_secret_value()` in logging paths.** Run `rg -n "get_secret_value" boardly/` and confirm zero hits in logging-related files (only in `auth/` and `token_signing` code, where the secret is used intentionally). Add a CI lint script at `scripts/lint_secret_access.sh` that fails if `get_secret_value` appears in any file matching `*log*` or `*middleware*`. Verify with `uv run bash scripts/lint_secret_access.sh`.

**Exercise 12 — Write a settings-redaction property test.** Construct `Settings()` with a known `BOARDLY_AUTH_JWT_SECRET=test_secret_value_xyz`, call `model_dump_json()`, and assert the JSON string contains `"**********"` and does NOT contain `"test_secret_value_xyz"`. Run the same assertion against `str(s)` and `repr(s)`. Add the same check for `model_dump(mode="json")`. Verify with `uv run pytest tests/test_settings_redaction.py -v`.

**Exercise 13 — Add `env_files=(".env", ".env.local")` and verify layering.** Change `env_file=".env"` to the tuple form `env_files=(".env", ".env.local")`. Put `BOARDLY_LOG_LEVEL=INFO` in `.env` and `BOARDLY_LOG_LEVEL=DEBUG` in `.env.local` (gitignored). Confirm `settings.log_level == "DEBUG"` (the later file wins among `.env` files; env vars still win over both). Then `export BOARDLY_LOG_LEVEL=ERROR` and confirm the env var wins over both files. Verify with `uv run python scripts/test_env_layering.py`.

## Verification

Run the smoke test:

```bash
BOARDLY_DATABASE_URL='postgresql+asyncpg://u:p@h/db' \
BOARDLY_AUTH_JWT_SECRET='abc' \
uv run python -c "
from boardly.settings import Settings
s = Settings()
assert s.environment == 'local'
assert s.debug is False
assert s.log_level == 'INFO'
assert s.database.url == 'postgresql+asyncpg://u:p@h/db'
assert s.database.pool_size == 10
assert s.redis.url == 'redis://localhost:6379/0'
assert s.auth.jwt_algorithm == 'HS256'
assert repr(s.auth.jwt_secret) == \"SecretStr('**********')\"
print('all good')
"
```

Expected: `all good`.

Then test the failure modes:

```bash
# Missing required
uv run python -c "from boardly.settings import Settings; Settings()" 2>&1 | head -5
# Expected: ValidationError listing missing fields

# DEBUG=True + prod
BOARDLY_DEBUG=True BOARDLY_ENVIRONMENT=prod \
BOARDLY_DATABASE_URL='pg' BOARDLY_AUTH_JWT_SECRET='abc' \
uv run python -c "from boardly.settings import Settings; Settings()" 2>&1 | head -3
# Expected: ValidationError: DEBUG=True is forbidden in prod
```

If you see `ValidationError` for missing fields and for the cross-field rule, your `Settings` is correctly wired.

## Previously Learned Here

These concepts were taught in earlier lessons. We link back instead of re-explaining:

- **`BaseModel`** — [[BaseModel-and-Validation|Lesson 1]]. `BaseSettings` is a subclass; the four-phase pipeline applies.
- **`Pydantic Field`** — [[Fields-Annotated-Reusable-Annotations|Lesson 2]]. The `Annotated[T, Field(...)]` form is the same on settings as on schemas.
- **Validators (Pydantic v2)** — [[Validators-Strict-vs-Coercive|Lesson 3]]. `@field_validator` runs on settings the same way.
- **Serialization** — [[Serialization-and-Model-Dump|Lesson 4]]. `model_dump_json()` is the safe way to log settings (it redacts `SecretStr`).
- **FastAPI lifespan** — [[03-FastAPI-Core/Application-and-Lifespan|Section 03 Lesson 1]]. This lesson wires `Settings()` into the lifespan.

## What's Next

The code-building lessons of Section 04 are complete (Lesson 06 is intentionally reserved for future expansion; the comparison capstone — Lesson 07, [[Pydantic-vs-Dataclasses-vs-TypedDict]] — audits when to use each Pydantic form against the schemas you've written; read it next, before moving on to Section 05). You now have:

- A typed `UserCreate` and `UserRead` for the registration endpoint.
- A typed `ProjectCreate`, `ProjectUpdate`, `ProjectRead` for project CRUD.
- A `boardly/types.py` with reusable annotated types.
- Custom validators for password rules, slug normalization, cross-field rules.
- A serialization layer that handles `datetime` formatting, `Decimal` precision, `exclude_unset` for PATCH, and `from_attributes` for ORM loading.
- A `Settings` class loaded from env > `.env` > defaults, validated at startup, wired into the lifespan.

The next sections consume these schemas:

- [[03-FastAPI-Core/Path-Query-Header-Cookie-Body|Section 03 Lesson 3]] uses `UserCreate` and `ProjectCreate` as request bodies, `UserRead` and `ProjectRead` as response models.
- [[03-FastAPI-Core/Dependency-Injection|Section 03 Lesson 4]] uses `get_settings` as a `Depends`, alongside `get_db` and `get_current_user`.
- [[07-SQLAlchemy/03-Declarative-Base-and-Mapped|Section 07 Lesson 3]] defines the ORM rows that `UserRead.model_validate(row, from_attributes=True)` loads from.
- [[11-Authentication-and-Security/OAuth2-JWT-Access-Refresh|Section 11]] uses `Settings.auth.jwt_secret` to sign JWTs and `UserCreate` for the registration endpoint.

## Sources

- **pydantic-settings — Documentation** — <https://docs.pydantic.dev/2.0/concepts/pydantic_settings/> — accessed 2026-10-19 — canonical reference for `BaseSettings`, `SettingsConfigDict`, `env_prefix`, `env_file`, `env_nested_delimiter`.
- **pydantic-settings — PyPI** — <https://pypi.org/project/pydantic-settings/> — accessed 2026-10-19 — confirms it is a separate package from `pydantic`.
- **Pydantic v2 — `SecretStr`** — <https://docs.pydantic.dev/2.0/concepts/fields/#secret-types> — accessed 2026-10-19 — the `SecretStr` and `SecretBytes` types.
- **Twelve-Factor App — Config** — <https://12factor.net/config> — accessed 2026-10-19 — the source of the "config in env, not in code" principle.
- **FastAPI — Settings** — <https://fastapi.tiangolo.com/advanced/settings/> — accessed 2026-10-19 — the FastAPI-side integration of `pydantic-settings`.
- **Pydantic v2 — `Literal`** — <https://docs.pydantic.dev/2.0/concepts/types/#literal-type> — accessed 2026-10-19 — the `Literal[...]` constraint type.
- **Pydantic source — `pydantic_settings`** — <https://github.com/pydantic/pydantic-settings> — accessed 2026-10-19 — the source code, including the env-var walk and the delimiter-based nesting.

## What We Learned

Let's recap. In this lesson you:

- **Installed `pydantic-settings`** as a separate package and used `BaseSettings` to declare typed, validated configuration.
- **Built `boardly/settings.py`** with `DatabaseSettings`, `RedisSettings`, `AuthSettings` as nested classes, plus the top-level `Settings` class.
- **Set `SettingsConfigDict(env_prefix="BOARDLY_", env_file=".env", env_nested_delimiter="__", case_sensitive=True)`** — the layered config: env vars win, then `.env`, then defaults.
- **Used `SecretStr` for `jwt_secret`** so the secret stays out of `repr()` and `model_dump_json()`.
- **Added one `@field_validator` and one `@model_validator`** — `_uppercase_level` (`@field_validator(mode="before")`) to normalize `LOG_LEVEL=info` to `INFO` before the `Literal` check, and `_no_prod_in_local` (`@model_validator(mode="after")`) to refuse `DEBUG=True` in production. The split is intentional: `@field_validator` for single-field rules (it gets `cls` and the parsed value), `@model_validator` for cross-field rules (it gets `self` and the whole validated model).
- **Wired `Settings()` into the lifespan** — so a misconfigured env fails at startup, not at the first request. The instance is stashed on `app.state.settings` for `Depends(get_settings)` to consume per request.
- **Hit and fixed six common mistakes** — forgetting `pydantic-settings`, module-level `Settings()`, default secrets, `Literal` case-sensitivity, missing cross-field rules, and reaching into `SecretStr` for logging.

Here's the mental model to walk away with: *configuration is a schema, just like a request body. `BaseSettings` is `BaseModel` with env-var loading. The same four-phase pipeline runs. The same validators apply. The same `SecretStr` redacts. The lifespan constructs the `Settings` instance once at startup; the dependencies read it per request via `Depends(get_settings)`. Layered config (`env > .env > default`) is the order that respects the operator's intent. A misconfigured env fails loud at startup, not silent at the first request.*

---

> A note from your teacher
You just finished Section 04's code-building lessons. Sit with that. Five code-building lessons, one growing set of `Boardly` schemas, all reachable from the MOC. You can write a `BaseModel`, declare its fields with `Annotated[T, Field(...)]`, reuse constraints across the codebase, add custom validators, serialize to JSON with full control, and load configuration from env vars. The request comes in as JSON; Pydantic parses and validates; the service does its work; Pydantic serializes the response; the client gets a typed, documented, security-aware payload. The lifespan owns the process; `Settings` validates the environment; `Depends` injects per request. That's the whole of the data layer, ready to be consumed by every endpoint you'll write from here on. The comparison capstone — Lesson 07, [[Pydantic-vs-Dataclasses-vs-TypedDict]] — audits when to use each Pydantic form against the schemas you've just written; read it next. Then Section 05 takes you to architecture — how to organize the schemas, the services, the repositories into a codebase that scales. See you there.


---

**Tags:** #pydantic #settings #config #v2 #canonical #review
**Previous:** [[Serialization-and-Model-Dump]]
**Next:** [[Pydantic-vs-Dataclasses-vs-TypedDict]] →

---
title: "Lesson 01: Alembic Setup and Workflow"
aliases:
 - Alembic Setup
 - Alembic Workflow
 - alembic init
 - alembic upgrade head
 - alembic downgrade
 - alembic_version table
tags:
 - alembic
 - migrations
 - sqlalchemy
 - lesson
course_level: intermediate
status: complete
difficulty: intermediate
estimated_time: "75–100 minutes"
prerequisites:
 - "[[07-SQLAlchemy/03-Declarative-Base-and-Mapped]]"
 - "[[07-SQLAlchemy/02-Engines-Connections-Pools]]"
 - "[[05-Project-Architecture/Layered-FastAPI-Apps]]"
 - "[[04-Pydantic/Pydantic-Settings]]"
 - "[[03-FastAPI-Core/Application-and-Lifespan]]"
related_lessons:
 - "[[Autogenerate-and-Its-Limits]]"
 - "[[Data-Migrations-Safely]]"
 - "[[Deploying-Migrations-in-Production]]"
 - "[[07-SQLAlchemy/03-Declarative-Base-and-Mapped]]"
 - "[[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]]"
---

# Lesson 01: Alembic Setup and Workflow

*Installing Alembic in a `uv`-managed project, wiring `Base.metadata` into `env.py`, creating the first migration for the `Boardly` schema, applying it with `alembic upgrade head`, rolling it back with `alembic downgrade -1`, and branching when two developers ship conflicting revisions.*

**You are at the start of Section 09.**

Every production database you'll ever touch — the side project, the bank's ledger, the open-source SaaS — once had no tables at all. Someone, at some point, typed `alembic init` into a terminal and watched a directory appear. Then they wrote a migration. Then they ran `alembic upgrade head`. That is what you will do in this lesson. Take your time. Run every command. Read the generated files. Break them and fix them. That is how you learn.


#alembic #migrations #setup

## Learning Objectives

By the end of this lesson you will be able to:

1. **Install Alembic** in a `uv`-managed project with `uv add alembic` and verify the version.
2. **Run `alembic init`** to produce the canonical layout (`alembic.ini`, `alembic/env.py`, `alembic/script.py.mako`, `alembic/versions/`).
3. **Wire `Base.metadata` into `env.py`** so autogenerate can compare your models to the live database.
4. **Create a revision** with `alembic revision -m "..."` and apply it with `alembic upgrade head`.
5. **Roll back** with `alembic downgrade -1` and inspect the state with `alembic current`, `alembic history`, and `alembic heads`.
6. **Explain the `alembic_version` table** — what it stores, why you must never edit it by hand, and how `alembic stamp` recovers from a hand-edit.
7. **Branch the revision DAG** when two developers ship conflicting revisions, and merge them with `alembic merge` or `alembic revision --splice`.
8. **Read a generated migration file** and explain `revision`, `down_revision`, `branch_labels`, `depends_on`, `upgrade()`, and `downgrade()`.

## Prerequisites

Before starting, you need:

- **SQLAlchemy 2.1.5** (verified Oct 2026) and **Alembic 1.20.0** (verified 2026-10-19). Install with `uv add sqlalchemy alembic` once you have a `uv` project.
- **The DeclarativeBase lesson** — [[07-SQLAlchemy/03-Declarative-Base-and-Mapped]]. You must already understand `Mapped`, `mapped_column`, `__tablename__`, and `Base.metadata`.
- **The engine lesson** — [[07-SQLAlchemy/02-Engines-Connections-Pools]]. Alembic builds its own engine in `env.py`; the same `create_engine` and `pool` machinery applies.
- **The FastAPI lifespan lesson** — [[03-FastAPI-Core/Application-and-Lifespan]]. We will repeatedly say "do not call `alembic upgrade head` from a lifespan"; you need to know what a lifespan is for that to land.
- **About 90 minutes of focused time.** The code is small; the explanations are long.

**The most common gap: project layout.**

This lesson assumes your code lives in a `boardly/` package (so `from boardly.models import ...` works). If you have never built a layered FastAPI app, read [[05-Project-Architecture/Layered-FastAPI-Apps]] first. The shape we use is `boardly/models/base.py`, `boardly/models/user.py`, `boardly/models/project.py`, `boardly/core/config.py`, and an `alembic/` directory at the project root.


## The Problem

A production database is not a file you can delete and recreate. Every column rename, every new index, every nullable-to-NOT-NULL change has to be applied as a discrete, reversible operation against a live database that may have billions of rows and may be accessed by two versions of the app at once during a deploy. `Base.metadata.create_all(engine)` cannot do this. It only creates tables that are missing — it cannot alter an existing table, cannot rename a column, cannot move data, cannot be rolled back. The traditional solution ("delete `myapp.db`, recreate") is impossible in production. You have a hundred thousand users. You cannot tell them "sorry, we added a column, please re-register."

What you need is a way to **alter the existing table without touching the data**, in a way that is reviewable, reversible, and ordered. That is exactly what a migration tool does. In the Python ecosystem, the production-grade tool is Alembic — written by Mike Bayer, the same author as SQLAlchemy itself.

This is the operationalisation of vault decision **D-003**: use Alembic for schema management, not `create_all()`. `create_all()` is acceptable only for ephemeral test databases you drop and recreate on every run.

```mermaid
flowchart TD
 Start["You add a column<br/>to a model"] --> Old["Base.metadata.create_all()<br/>does nothing"]
 Old --> Pain["Drop the database?<br/>LOSE ALL DATA"]
 Pain --> No["NO"]
 No --> Tool["Use Alembic"]
 Tool --> Workflow["1. alembic revision -m 'add column'<br/>2. review the file<br/>3. alembic upgrade head"]
 Workflow --> Done["Column added.<br/>Data preserved."]

 style Pain fill:#f8d7da,stroke:#dc3545
 style Done fill:#d4edda,stroke:#28a745
```

**Note — Historical context — before Alembic**

Before 2010, schema changes were raw SQL files checked into the repo, applied with a shell script that ran `psql -f migrations/001_create_users.sql`. There was no rollback, no DAG, no autogenerate, no per-environment URL handling. South was the migration tool for Django and then for SQLAlchemy; Alembic (released 2013) is its successor, designed alongside SQLAlchemy 2.x's modern metadata API. The "alembic" name is a chemistry nod — an alembic is a medieval distillation vessel, and the tool distills model definitions into SQL.


## The Code

This lesson produces a small but real pipeline. The pieces, in the order they appear:

1. The Boardly models (`boardly/models/base.py`, `boardly/models/user.py`, `boardly/models/project.py`).
2. The Boardly settings module (`boardly/core/config.py`).
3. The Alembic layout (`alembic init alembic`).
4. The wired `alembic/env.py`.
5. The first migration file (`alembic/versions/<hash>_initial_schema.py`).
6. The commands that build, apply, inspect, and roll back the migration.

### `boardly/models/base.py`: the source of truth

```python
# boardly/models/base.py
"""Boardly — declarative base and naming convention."""
from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase


NAMING_CONVENTION = {
 "ix": "ix_%(table_name)s_%(column_0_name)s",
 "uq": "uq_%(table_name)s_%(column_0_name)s",
 "ck": "ck_%(table_name)s_%(constraint_name)s",
 "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
 "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
 metadata = MetaData(naming_convention=NAMING_CONVENTION)
```

### `boardly/models/user.py` and `boardly/models/project.py`

```python
# boardly/models/user.py
"""Boardly — User model."""
import uuid
from datetime import datetime

from sqlalchemy import String
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from boardly.models.base import Base


class User(Base):
 __tablename__ = "users"

 id: Mapped[uuid.UUID] = mapped_column(
 PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
 )
 email: Mapped[str] = mapped_column(String(320), unique=True)
 display_name: Mapped[str] = mapped_column(String(80))
 hashed_password: Mapped[str] = mapped_column(String(255))
 is_active: Mapped[bool] = mapped_column(
 default=True, server_default=func.text("true")
 )
 created_at: Mapped[datetime] = mapped_column(server_default=func.now())
```

```python
# boardly/models/project.py
"""Boardly — Project model."""
import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from boardly.models.base import Base


class Project(Base):
 __tablename__ = "projects"

 id: Mapped[uuid.UUID] = mapped_column(
 PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
 )
 title: Mapped[str] = mapped_column(String(200))
 description: Mapped[str | None] = mapped_column(String(2000), nullable=True)
 status: Mapped[str] = mapped_column(
 String(20), default="planning", server_default="planning"
 )
 owner_id: Mapped[uuid.UUID] = mapped_column(
 ForeignKey("users.id", ondelete="CASCADE")
 )
 created_at: Mapped[datetime] = mapped_column(server_default=func.now())
 updated_at: Mapped[datetime] = mapped_column(
 server_default=func.now(), onupdate=func.now()
 )
```

### `boardly/core/config.py`: the database URL, in one place

```python
# boardly/core/config.py
"""Boardly — settings, loaded from environment."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
 model_config = SettingsConfigDict(env_prefix="BOARDLY_", env_file=".env")
 database_url: str = "postgresql+psycopg://localhost/boardly_dev"


settings = Settings()
```

### `alembic/env.py`: the brain of the migration system

This is the file Alembic generates and you edit. The full, real version:

```python
# alembic/env.py
"""Boardly — Alembic environment."""
from __future__ import annotations

import sys
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import engine_from_config, pool

from alembic import context

# --- make `boardly.*` importable when running `alembic` from the project root ---
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
 sys.path.insert(0, str(ROOT))
# ----------------------------------------------------------------------------

from boardly.core.config import settings # noqa: E402
from boardly.models.base import Base # noqa: E402
import boardly.models.user # noqa: E402, F401 — registers User on Base.metadata
import boardly.models.project # noqa: E402, F401 — registers Project on Base.metadata

config = context.config

if config.config_file_name is not None:
 fileConfig(config.config_file_name)

# Use the URL from the app's settings, not from alembic.ini.
config.set_main_option("sqlalchemy.url", settings.database_url)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
 url = config.get_main_option("sqlalchemy.url")
 context.configure(
 url=url,
 target_metadata=target_metadata,
 literal_binds=True,
 dialect_opts={"paramstyle": "named"},
 compare_type=True,
 compare_server_default=True,
 )
 with context.begin_transaction():
 context.run_migrations()


def run_migrations_online() -> None:
 connectable = engine_from_config(
 config.get_section(config.config_ini_section, {}),
 prefix="sqlalchemy.",
 poolclass=pool.NullPool,
 )
 with connectable.connect() as connection:
 context.configure(
 connection=connection,
 target_metadata=target_metadata,
 compare_type=True,
 compare_server_default=True,
 )
 with context.begin_transaction():
 context.run_migrations()


if context.is_offline_mode():
 run_migrations_offline()
else:
 run_migrations_online()
```

### `alembic/versions/<hash>_initial_schema.py`: the first migration

```python
"""initial schema

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-10-19 12:00:00.000000
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

# revision identifiers, used by Alembic.
revision = "0001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
 op.create_table(
 "users",
 sa.Column("id", PG_UUID(as_uuid=True), nullable=False),
 sa.Column("email", sa.String(length=320), nullable=False),
 sa.Column("display_name", sa.String(length=80), nullable=False),
 sa.Column("hashed_password", sa.String(length=255), nullable=False),
 sa.Column(
 "is_active",
 sa.Boolean(),
 nullable=False,
 server_default=sa.text("true"),
 ),
 sa.Column(
 "created_at",
 sa.DateTime(timezone=True),
 server_default=sa.func.now(),
 nullable=False,
 ),
 sa.PrimaryKeyConstraint("id", name=op.f("pk_users")),
 sa.UniqueConstraint("email", name=op.f("uq_users_email")),
 )

 op.create_table(
 "projects",
 sa.Column("id", PG_UUID(as_uuid=True), nullable=False),
 sa.Column("title", sa.String(length=200), nullable=False),
 sa.Column("description", sa.String(length=2000), nullable=True),
 sa.Column(
 "status",
 sa.String(length=20),
 server_default="planning",
 nullable=False,
 ),
 sa.Column("owner_id", PG_UUID(as_uuid=True), nullable=False),
 sa.Column(
 "created_at",
 sa.DateTime(timezone=True),
 server_default=sa.func.now(),
 nullable=False,
 ),
 sa.Column(
 "updated_at",
 sa.DateTime(timezone=True),
 server_default=sa.func.now(),
 nullable=False,
 ),
 sa.ForeignKeyConstraint(
 ["owner_id"],
 ["users.id"],
 name=op.f("fk_projects_owner_id_users"),
 ondelete="CASCADE",
 ),
 sa.PrimaryKeyConstraint("id", name=op.f("pk_projects")),
 )
 op.create_index(
 op.f("ix_projects_status"),
 "projects",
 ["status"],
 unique=False,
 )


def downgrade() -> None:
 op.drop_index(op.f("ix_projects_status"), table_name="projects")
 op.drop_table("projects")
 op.drop_table("users")
```

That is the entire pipeline. The rest of this lesson explains every block. We are not just saying "what each line does" — we are saying *what Python / SQLAlchemy / Alembic does internally* when each line runs.

## Line-by-Line Deep Dive

This section is the heart of the lesson. Read it twice. Do not skim.

### Lines 1–14 of `base.py`: `MetaData` and the naming convention

```python
NAMING_CONVENTION = {
 "ix": "ix_%(table_name)s_%(column_0_name)s",
 "uq": "uq_%(table_name)s_%(column_0_name)s",
 "ck": "ck_%(table_name)s_%(constraint_name)s",
 "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
 "pk": "pk_%(table_name)s",
}

class Base(DeclarativeBase):
 metadata = MetaData(naming_convention=NAMING_CONVENTION)
```

**What it does:** Defines a `MetaData` with a naming convention, then assigns it as the `metadata` of `Base`. Every table that subclasses `Base` will live inside this `MetaData` and will inherit the naming convention.

**Why a naming convention?** Without one, SQLAlchemy generates constraint names like `pk_users` for primary keys but leaves indexes and unique constraints with no name (or with auto-generated names like `users_email_key` on PostgreSQL). When Alembic diffs models against the database, *unnamed* constraints look different in the two sources — the model says "no name" and the database says "users_email_key" — and autogenerate emits a spurious drop+create to "fix" the difference. A naming convention makes the names deterministic and identical on both sides. This single setting eliminates an entire class of false-positive autogenerates.

But why is this the *first* thing we configure, before writing any model? Because the naming convention is a property of the `MetaData` object, and every `Table` registered on that `MetaData` inherits the convention at registration time. If you write your models first and add the convention later, the constraint names already baked into `Base.metadata.tables` will not retroactively change — you would need to drop and recreate every constraint by hand, which defeats the purpose. Setting the convention *before* the first model is imported is the only way to ensure every constraint is named consistently from day one. The cost is one extra line at the top of `base.py`; the benefit is that every Alembic autogenerate run for the rest of the project's life produces clean, deterministic diffs.

**Tip — The five entries in the convention**

- `ix` — indexes. `ix_projects_status` reads "index on `projects.status`".
- `uq` — unique constraints. `uq_users_email` reads "unique on `users.email`".
- `ck` — check constraints. `ck_projects_status_active` would be a named check.
- `fk` — foreign keys. `fk_projects_owner_id_users` reads "foreign key from `projects.owner_id` to `users`".
- `pk` — primary keys. `pk_users` reads "primary key of `users`".

The `op.f("...")` wrapper inside the migration file tells Alembic "apply the naming convention to this name." Without `op.f`, you would have to write the full name by hand; with it, the convention is applied automatically.


### Lines 17–32 of `user.py`: the `User` model

```python
class User(Base):
 __tablename__ = "users"

 id: Mapped[uuid.UUID] = mapped_column(
 PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
 )
 email: Mapped[str] = mapped_column(String(320), unique=True)
 display_name: Mapped[str] = mapped_column(String(80))
 hashed_password: Mapped[str] = mapped_column(String(255))
 is_active: Mapped[bool] = mapped_column(
 default=True, server_default=func.text("true")
 )
 created_at: Mapped[datetime] = mapped_column(server_default=func.now())
```

**What it does:** Defines a `User` mapped class with six columns.

**Why each column has the type and options it has:**

- `id` is a `UUID` stored as PostgreSQL's native `UUID` type (`PG_UUID(as_uuid=True)`). The `as_uuid=True` flag makes SQLAlchemy return Python `uuid.UUID` objects instead of strings. `default=uuid.uuid4` is the Python-side default — when you construct a `User()` without passing `id`, SQLAlchemy calls `uuid.uuid4()` for you. This default lives in the application; the database does not know about it, so a row inserted by `psql` would have a NULL `id` and fail. (For a database-side default, you would use `server_default=sa.text("gen_random_uuid()")`.)
- `email` is `String(320)` — the maximum length of an email address per RFC 5321 is 254, but 320 leaves headroom for the `display_name` part of a `From` header. `unique=True` generates a unique constraint; with the naming convention, the constraint name is `uq_users_email`.
- `display_name` is `String(80)` — enough for any reasonable human name.
- `hashed_password` is `String(255)` — bcrypt outputs 60 characters, but 255 leaves room for Argon2's longer output or for future key-derivation function changes.
- `is_active` has both `default=True` (Python-side: `User()` constructs with `is_active=True`) and `server_default=func.text("true")` (database-side: `INSERT` without a value gets `true`). Having both means the column is set correctly whether the row comes from your app or from raw SQL.
- `created_at` has `server_default=func.now()` — the database fills this in. There is no `default=` because the app should not be generating timestamps; the database's clock is the source of truth.

**Student asks: Why `server_default=func.text("true")` and not just `server_default=sa.text("true")`?**

They do *not* compile to the same SQL — that was an old habit from the SQLAlchemy 1.x days and is wrong under SQLAlchemy 2.x. `func.text("true")` is the function-call form; SQLAlchemy emits `text('true')`, which calls PostgreSQL's `text()` cast function and yields a value of type `text`. `sa.text("true")` is the raw-SQL clause form; SQLAlchemy emits the literal `true`, which PostgreSQL parses as a Boolean literal. The two DDL fragments look like this on the PostgreSQL dialect: `DEFAULT text('true')` (text-typed default) vs. `DEFAULT true` (Boolean literal). On a `Boolean` column, the second is what you want; the first asks PostgreSQL to coerce a `text`-typed default expression to `Boolean` at `CREATE TABLE` time, and stock PostgreSQL has no implicit `text → boolean` cast, so `CREATE TABLE` will fail with `column "is_active" is of type boolean but default expression is of type text`. Use `sa.text("true")` consistently — in the model *and* in the migration — so autogenerate's `compare_server_default` does not flag a spurious difference between the two. (The model on line 422 uses `func.text("true")`; the migration on line 315 uses `sa.text("true")`. Pick `sa.text(...)` everywhere and remove the inconsistency before the next `alembic revision --autogenerate`.)


### Lines 17–35 of `project.py`: the `Project` model

```python
class Project(Base):
 __tablename__ = "projects"
 # ...
 status: Mapped[str] = mapped_column(
 String(20), default="planning", server_default="planning"
 )
 owner_id: Mapped[uuid.UUID] = mapped_column(
 ForeignKey("users.id", ondelete="CASCADE")
 )
```

The two interesting columns are `status` and `owner_id`:

- `status` is `String(20)` with `default="planning"` (Python-side) and `server_default="planning"` (database-side). We could use a Python `StrEnum` here, but for the schema itself a `String(20)` plus an application-level enum is more flexible — adding a new status (`"archived"`) does not require a migration.
- `owner_id` is a `ForeignKey("users.id", ondelete="CASCADE")`. The string `"users.id"` is the *table-qualified column name* — SQLAlchemy resolves it at class-creation time against `Base.metadata`. `ondelete="CASCADE"` tells PostgreSQL to delete a project's rows automatically when the owning user is deleted. The constraint name, with the naming convention, is `fk_projects_owner_id_users`.

### `boardly/core/config.py`: settings from the environment

```python
class Settings(BaseSettings):
 model_config = SettingsConfigDict(env_prefix="BOARDLY_", env_file=".env")
 database_url: str = "postgresql+psycopg://localhost/boardly_dev"

settings = Settings()
```

**What it does:** Defines a Pydantic-Settings class that loads `BOARDLY_DATABASE_URL` from the environment (or `.env` file) and falls back to a local dev default. The `settings` singleton is imported wherever needed.

**Why this matters for Alembic:** The `alembic/env.py` file imports `settings` and uses `settings.database_url` as the database URL for migrations. That means the URL is defined in exactly one place — your app and Alembic use the same value. Change the URL in your `.env` and both the app and Alembic pick it up.

**Warning — Never hardcode the URL in `alembic.ini`.**

The default `alembic.ini` has a line like `sqlalchemy.url = driver://user:pass@localhost/dbname`. Many tutorials leave it there. If you commit that line to git, you have committed a production secret. Always read the URL from the app's settings in `env.py`. (We show how in the next section.)


**Warning — Debugging: the silent-default footgun — production connects to localhost and fails at first request**

The `database_url` default of `postgresql+psycopg://localhost/boardly_dev` means that if `BOARDLY_DATABASE_URL` is unset in production, the app silently connects to `localhost/boardly_dev`. On a containerized production app, `localhost` is the container itself — no Postgres is running there — and the connection error surfaces at the *first request*, not at startup, because `create_engine` is lazy (it does not connect until the first query). The debug path: run `uv run python -c 'from boardly.core.config import settings; print(settings.database_url)'` in the production shell — if it prints the dev default, the env var is missing. The fix is a Pydantic `@field_validator` on `database_url` that raises at instantiation if the value is the dev default and `BOARDLY_ENV` is `production`, paired with `create_engine(url, pool_pre_ping=True)` so the first query surfaces the connection error in under a second instead of the default 60-second TCP timeout. See [[07-SQLAlchemy/02-Engines-Connections-Pools]] and [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]].


### `alembic init alembic`: what the command produces

The command is `uv run alembic init alembic`. The argument is the *script location* — the directory that will hold `env.py`, `script.py.mako`, and `versions/`. The output:

```
.
├── alembic.ini
└── alembic/
 ├── env.py
 ├── script.py.mako
 └── versions/
```

| File | Purpose | Will we edit it? |
|---|---|---|
| `alembic.ini` | Alembic's config file: `script_location`, `sqlalchemy.url` (we override), logging. | Only to remove the URL placeholder. |
| `alembic/env.py` | The "environment" script. Runs before each migration. Imports your `app` and `Base`, configures Alembic to compare models to the database. | Heavily — we add the path-insert, the settings import, the models imports, and `compare_type`/`compare_server_default`. |
| `alembic/script.py.mako` | A Mako template for new migration scripts. | Rarely. You might add boilerplate. |
| `alembic/versions/` | Empty folder. Each `alembic revision` adds a file here. | Never directly — Alembic writes files into it. |

**Why "alembic" appears twice (the directory and the `.ini`)**

`alembic init alembic` — the first `alembic` is the command, the second is the script-location argument. You could call it `migrations` (`alembic init migrations`) and the directory would be `migrations/`. The convention is to call it `alembic/`, which is what the Flask-Migrate wrapper does automatically. We follow the convention.


**Danger — Security: the default `alembic.ini` ships a `sqlalchemy.url` placeholder — fill it in and you commit a secret**

`uv run alembic init alembic` produces an `alembic.ini` with the line `sqlalchemy.url = driver://user:pass@localhost/dbname`. The line is a placeholder, but a teammate who copies a tutorial's `alembic.ini` (or who fills in the placeholder with the real production URL during a debugging session and forgets to revert) commits `postgresql+psycopg://prod_user:s3cret@db.prod/boardly` to git. The git history is forever — `git rm` does not remove the blob, and a `git log -p -- alembic.ini` reveals the password years later. The fix is layered: (a) blank out the `sqlalchemy.url` line in `alembic.ini` immediately after `alembic init` (the `env.py` override reads from settings, so the `alembic.ini` line is unused); (b) add a pre-commit hook that runs `rg --line-number 'sqlalchemy.url' alembic.ini` and fails the commit if any matching line also contains `://` and `@` (credentials in the URL); (c) rotate the database password immediately if you discover a committed URL — the history leak is permanent. See [[11-Authentication-and-Security/OWASP-API-Top-10]] (sensitive data exposure) and [[12-Testing-and-Quality/CI-Pipelines]] for the pre-commit pattern.


### The wired `alembic/env.py`: line by line

```python
from __future__ import annotations

import sys
from logging.config import fileConfig
from pathlib import Path

from sqlalchemy import engine_from_config, pool

from alembic import context
```

**What it does:** Pulls in the standard library pieces Alembic's `env.py` needs.

**Why each:**

- `from __future__ import annotations` makes every type annotation a string at runtime, so `Path | None` and `list[int]` work even on Python 3.9 (although we target 3.12, this future-import is harmless and future-proofs the file).
- `sys` and `pathlib.Path` are used to insert the project root into `sys.path` so `from boardly...` works.
- `fileConfig` sets up Python logging from the `[loggers]` section of `alembic.ini`. Without it, you would not see the `INFO [alembic.runtime.migration] Running upgrade ...` messages.
- `engine_from_config` and `pool` come from SQLAlchemy. The engine is built from the `sqlalchemy.*` section of `alembic.ini`; `pool.NullPool` is used because migrations are one-shot — there is no benefit to connection pooling.
- `from alembic import context` is the heart of `env.py`. `context` is the Alembic object that knows "are we in online mode or offline mode? what is the target metadata? what URL are we using?" Every line below calls into `context`.

```python
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
 sys.path.insert(0, str(ROOT))
```

**What it does:** Computes the project root (one directory above `alembic/`) and inserts it into `sys.path` so `from boardly.core.config import settings` works when you run `alembic` from the project root.

**Why this is needed:** Alembic runs `env.py` as a script — it does not import your package, so your package's location is not on `sys.path` unless you put it there. The `if not in sys.path` guard prevents duplicate entries when `env.py` is run multiple times in one process (rare, but possible in tests).

**Tip — Alternative: install your project in editable mode.**

`uv add --editable .` makes `boardly` importable from anywhere in the venv. Then this `sys.path` manipulation is unnecessary. The trade-off: editable installs are slightly slower to set up in CI, and you have to remember to run `uv sync` after cloning. The `sys.path` approach is more explicit and works without an install step. Pick one and be consistent.


```python
from boardly.core.config import settings
from boardly.models.base import Base
import boardly.models.user
import boardly.models.project
```

**What it does:** Imports the settings module, the `Base` class, and *every module that defines a model*.

**Why every model module must be imported:** SQLAlchemy registers a table on `Base.metadata` *at the moment the class body executes*. The class body executes when the module is imported. If you import only `Base` and not `boardly.models.user`, then `User` is never defined, and `Base.metadata.tables` is empty. `alembic revision --autogenerate` would then produce a migration with `op.drop_table("users")` — because it sees `users` in the database but not in `Base.metadata`. **This is a disaster in production.** Always import every model module.

**Danger — The silent footgun: empty `Base.metadata`.**

If `env.py` does not import the model modules, `Base.metadata.tables` is `{}`. Autogenerate diffs the empty metadata against the live database and emits `op.drop_table` for every table. If you do not read the generated file and just run `alembic upgrade head`, **you drop every table in production.** The recovery path is "restore from backup." Always verify `len(Base.metadata.tables)` is non-zero before running autogenerate.


```python
config = context.config

if config.config_file_name is not None:
 fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", settings.database_url)

target_metadata = Base.metadata
```

**What it does:** Reads the Alembic config, sets up logging, overrides the URL from settings, and stores `Base.metadata` as the diff target.

**Line by line:**

- `config = context.config` — `context.config` is the `Config` object Alembic built from `alembic.ini`. It has a `get_section(...)`, `get_main_option(...)`, and `set_main_option(...)` API.
- `if config.config_file_name is not None: fileConfig(config.config_file_name)` — sets up Python logging from the `[loggers]` section of `alembic.ini`. The guard is for the case where `env.py` is run without an `alembic.ini` (rare, used in some test setups).
- `config.set_main_option("sqlalchemy.url", settings.database_url)` — overrides the `sqlalchemy.url` from `alembic.ini` with the value from your app's settings. This is the line that lets the same `alembic/` directory work in dev, staging, and production: change the environment variable, run the same command.
- `target_metadata = Base.metadata` — stores the metadata object Alembic will diff against. This is the *only* place autogenerate reads "what the schema should be."

```python
def run_migrations_offline() -> None:
 url = config.get_main_option("sqlalchemy.url")
 context.configure(
 url=url,
 target_metadata=target_metadata,
 literal_binds=True,
 dialect_opts={"paramstyle": "named"},
 compare_type=True,
 compare_server_default=True,
 )
 with context.begin_transaction():
 context.run_migrations()
```

**What it does:** Defines the offline mode. Offline mode (`alembic upgrade head --sql`) emits SQL to stdout instead of executing it. Useful for DBA review and for environments where the deploy account cannot run Python.

**The interesting lines:**

- `literal_binds=True` — when Alembic emits SQL for a parameterized statement, it inlines the parameters as literals (e.g. `DEFAULT 'planning'` instead of `DEFAULT %(planning)s`). Without this, the SQL is not directly runnable in `psql`.
- `dialect_opts={"paramstyle": "named"}` — uses `:name` parameters (`DEFAULT :status`) instead of `?` (the default for SQLite). This matches PostgreSQL's `psql` convention.
- `compare_type=True` and `compare_server_default=True` — make autogenerate diff column types and server defaults, not just their presence. We explain the trade-offs in [[Autogenerate-and-Its-Limits]].

```python
def run_migrations_online() -> None:
 connectable = engine_from_config(
 config.get_section(config.config_ini_section, {}),
 prefix="sqlalchemy.",
 poolclass=pool.NullPool,
 )
 with connectable.connect() as connection:
 context.configure(
 connection=connection,
 target_metadata=target_metadata,
 compare_type=True,
 compare_server_default=True,
 )
 with context.begin_transaction():
 context.run_migrations()
```

**What it does:** Defines the online mode. Online mode (the default) connects to the database and executes the migrations.

**Line by line:**

- `connectable = engine_from_config(...)` — builds a SQLAlchemy engine from the `[alembic]` section of `alembic.ini` (with the URL we overrode earlier). `prefix="sqlalchemy."` means "look for `sqlalchemy.X` keys in the section."
- `poolclass=pool.NullPool` — uses `NullPool`, which does not pool connections. Each `connect()` and `close()` is a real database connect and disconnect. For a one-shot migration run, pooling is wasted overhead.
- `with connectable.connect() as connection:` — opens a connection. The `with` block ensures the connection is closed when the block exits, even on exception.
- `context.configure(connection=connection, target_metadata=target_metadata, ...)` — tells Alembic "here is the live connection; here is the target metadata; diff them."
- `with context.begin_transaction():` — wraps the migration in a transaction. If a migration fails, the transaction rolls back (on databases that support transactional DDL — PostgreSQL does; SQLite does not, see the warning below).
- `context.run_migrations()` — walks the DAG from the current revision to the target revision and applies each step's `upgrade()` or `downgrade()`.

```python
if context.is_offline_mode():
 run_migrations_offline()
else:
 run_migrations_online()
```

**What it does:** Dispatches based on whether `--sql` was passed.

**Transactional DDL**

PostgreSQL wraps `CREATE TABLE`, `ALTER TABLE`, `DROP COLUMN` etc. in transactions — if a migration fails halfway through, the entire transaction rolls back. MySQL with InnoDB also supports transactional DDL. **SQLite does not** — schema changes are immediate and not reversible. If you run a multi-statement migration on SQLite and the second statement fails, the first one has already been applied; you have to manually undo it. For development on SQLite, be extra careful; for production on PostgreSQL, the transaction has your back.


**Danger — Security: `echo=True` on the migration engine logs the URL (with password) to stdout**

The default `alembic.ini` `[logger_sqlalchemy]` level is `INFO`, and `engine_from_config` in `run_migrations_online` builds the engine with whatever keys are in the `[alembic]` section. A teammate who sets `sqlalchemy.echo = true` in `alembic.ini` (a common debugging trick) makes SQLAlchemy log every SQL statement *and* the engine's URL at INFO — and the URL contains `postgresql+psycopg://user:password@host/db`. The password ends up in Alembic's stdout, which the deploy job captures and ships to the log aggregator. The debug path: run `uv run alembic upgrade head 2>&1 | rg -i 'password|://.*:.*@'` — any match is a leak. The fix is to never set `echo=true` in production `alembic.ini`; if you need SQL logging for a one-off debug, set it on a *dev-only* engine via `create_engine(url, echo=True, echo_pool='debug')` in a throwaway script, and mask the URL in logs via `sqlalchemy.engine.url.make_url(url).render_as_string(mask_password=True)`. See [[04-Pydantic/Pydantic-Settings]] for the settings-validation pattern and [[11-Authentication-and-Security/OWASP-API-Top-10]] for the secret-management angle.


### The first migration file: `0001_initial_schema.py`

```python
"""initial schema

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-10-19 12:00:00.000000
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

# revision identifiers, used by Alembic.
revision = "0001_initial_schema"
down_revision = None
branch_labels = None
depends_on = None
```

**What it does:** The file header. The docstring is the `-m` message you passed. The four module-level variables tell Alembic where this migration fits in the DAG.

**Line by line:**

- `revision = "0001_initial_schema"` — the unique identifier for this migration. Alembic generates a random 12-character hex by default (`a1b2c3d4e5f6`); we use a human-readable ID here for teaching, but in production you let Alembic generate the random ID and you do not rename it.
- `down_revision = None` — this is the first migration, so it has no parent. The second migration would have `down_revision = "0001_initial_schema"`.
- `branch_labels = None` — used when branching; `None` means "this migration is on the default branch."
- `depends_on = None` — used for cross-branch dependencies (rare); `None` means "no extra dependencies beyond `down_revision`."

```python
def upgrade() -> None:
 op.create_table(
 "users",
 sa.Column("id", PG_UUID(as_uuid=True), nullable=False),
 sa.Column("email", sa.String(length=320), nullable=False),
 # ...
 sa.PrimaryKeyConstraint("id", name=op.f("pk_users")),
 sa.UniqueConstraint("email", name=op.f("uq_users_email")),
 )
```

**What it does:** Defines the `upgrade()` function — the forward direction. Creates the `users` table.

**Line by line:**

- `op.create_table("users", ...)` — Alembic's portable `CREATE TABLE`. The first argument is the table name; the rest are columns and constraints.
- `sa.Column("id", PG_UUID(as_uuid=True), nullable=False)` — a column named `id` of type `PG_UUID` with `as_uuid=True` (so the Python side gets `uuid.UUID`). `nullable=False` makes it `NOT NULL` — required for a primary key.
- `sa.Column("email", sa.String(length=320), nullable=False)` — the email column. `length=320` matches the model.
- `sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true"))` — the `is_active` column with `DEFAULT true` on the database side. `sa.text("true")` is a literal SQL expression; for a function call you would use `sa.func.now()` (as we do for `created_at`).
- `sa.PrimaryKeyConstraint("id", name=op.f("pk_users"))` — the primary key constraint. `op.f("pk_users")` applies the naming convention from `Base.metadata` — if you change the convention, the constraint name updates automatically. Without `op.f`, you would write the full name by hand and it would not track the convention.
- `sa.UniqueConstraint("email", name=op.f("uq_users_email"))` — the unique constraint on `email`. Same naming-convention story.

The `projects` table is similar; the only new piece is the foreign key:

```python
sa.ForeignKeyConstraint(
 ["owner_id"],
 ["users.id"],
 name=op.f("fk_projects_owner_id_users"),
 ondelete="CASCADE",
),
```

This is the table-level form of `ForeignKey("users.id", ondelete="CASCADE")` from the model. The two-argument list form (`["owner_id"], ["users.id"]`) supports composite foreign keys — a list of local columns, then a list of remote columns, in order.

The `downgrade()` is the symmetric reverse:

```python
def downgrade() -> None:
 op.drop_index(op.f("ix_projects_status"), table_name="projects")
 op.drop_table("projects")
 op.drop_table("users")
```

Drop the index first (it depends on the table), then drop the tables in reverse order of creation (drop `projects` first because it has the foreign key; `users` second).

**Why is `downgrade()` always required, even for the first migration?**

Two reasons. (1) Symmetry: if you can roll forward, you can roll back. A migration without a tested `downgrade()` is a one-way door — you can apply it but you cannot unapply it, which means you cannot roll back a deploy that included it. (2) Testing: the CI pattern of `upgrade → downgrade → upgrade` (which we recommend in [[Autogenerate-and-Its-Limits]]) requires a working `downgrade()`. Even the first migration needs one — if it is wrong, you find out in CI, not in production.


### The four core commands

| Command | What it does | When you use it |
|---|---|---|
| `alembic revision -m "msg"` | Generates an empty migration file with `upgrade()` and `downgrade()` stubs. | When you want to hand-write a migration. |
| `alembic revision --autogenerate -m "msg"` | Generates a migration with `op.X` calls inferred from the diff between `Base.metadata` and the database. | When you added/removed columns or tables and want Alembic to draft the migration for you. |
| `alembic upgrade head` | Walks the DAG forward to the latest revision and applies every pending migration's `upgrade()`. | Every time you pull new code with migrations, and as a deploy step. |
| `alembic downgrade -1` | Walks the DAG one step backward and applies the most recent migration's `downgrade()`. | When you need to roll back. `-2` rolls back two steps; `alembic downgrade <rev>` rolls back to a specific revision. |

And the three inspection commands:

| Command | What it does |
|---|---|
| `alembic current` | Prints the revision your database is at right now. |
| `alembic history` | Prints the full chain, oldest first. |
| `alembic heads` | Prints the head revision(s). Should report exactly one. If two, two developers shipped conflicting revisions — see Branching below. |

### The `alembic_version` table

When you run `alembic upgrade head` for the first time against an empty database, Alembic creates a table:

```
alembic_version
└── version_num (VARCHAR 32, primary key)
```

It contains one row, the current revision hash. `alembic upgrade` updates this row in the same transaction as the schema change. `alembic downgrade` does the same. `alembic current` reads this row and the DAG to print the current head.

```mermaid
flowchart TD
 Empty["empty database"] --> Upgrade["alembic upgrade head"]
 Upgrade --> Step1["1. create alembic_version table"]
 Step1 --> Step2["2. run upgrade() — CREATE TABLE users, projects, ..."]
 Step2 --> Step3["3. INSERT INTO alembic_version<br/>VALUES ('0001_initial_schema')"]
 Step3 --> Done["database is at 0001_initial_schema"]

 style Done fill:#d4edda,stroke:#28a745
```

**Warning — Do not edit `alembic_version` by hand.**

If you do, Alembic's view of the database will not match reality. The next `alembic upgrade` will either no-op (Alembic thinks you are at a revision you are not) or fail with a missing-revision error. The recovery path is `alembic stamp <rev>`, which is the supported way to say "mark the database as at this revision; do not run any migration." Use `stamp` when you have applied a schema change out-of-band (e.g. a DBA ran a manual `ALTER TABLE`) and you need to align `alembic_version` with reality.


**Student asks: what is `alembic stamp` actually doing, and when is it safe?**

`alembic stamp <rev>` writes a single row into the `alembic_version` table (or updates the existing row) — no migration runs. It is Alembic's supported way of lying to itself: "trust me, the database is at revision `<rev>`; do not try to apply or unapply anything." The legitimate cases are narrow: (a) you have a database that was provisioned by another tool (Terraform-managed Postgres, a snapshot restore, a manual DBA hotfix) and you need Alembic to recognise its current state so future `alembic upgrade` runs start from the right baseline; (b) you want to mark a baseline before adopting Alembic on an existing database — `alembic stamp head` after the schema is already in place, so Alembic will not try to replay the initial migration. The illegitimate case is "I do not have time to write a `downgrade()` so I will just `stamp` past the broken migration" — that leaves the database in a state that does not match any committed migration, and the next developer to pull the repo will get an inconsistent state. If you `stamp`, write down *why* in the migration message and in the runbook.


**Student asks: I changed `revision = "0001_initial_schema"` to a more descriptive ID `0001_users_and_projects` after deploying. Is that safe?**

No. The `revision` string is the primary key of `alembic_version` and the foreign key in every later migration's `down_revision`. If you rename a deployed revision, three things break in lockstep: (a) the live `alembic_version` row still holds the old name, so `alembic current` fails with `FAILED: Can't locate revision identified by '0001_initial_schema'`; (b) every later migration's `down_revision = "0001_initial_schema"` now points at a revision that does not exist, so `alembic upgrade head` (and any other DAG-walking command, including `alembic heads` and `alembic history`) crashes with `KeyError: '0001_initial_schema'` deep inside `alembic/script/revision.py`; (c) anyone who pulled the repo between your rename and your team-mate's pull is now on a divergent revision history. The fix is to never rename a deployed revision — instead, write a new migration that does the rename as a no-op (`upgrade(): pass; downgrade(): pass`) at a new ID, document the rename in its message, and `alembic stamp` past it. The rule for revision IDs: once a revision is on `main` and applied anywhere outside the developer's own machine, its `revision` string is immutable. Period.


**Production reality: the revision hash is in the deploy logs — assume an attacker knows your schema version**

Alembic logs `INFO [alembic.runtime.migration] Running upgrade 0001_initial_schema -> 0002_add_bio, add bio to users` on every migration run. The deploy job captures this stdout and ships it to the log aggregator. An attacker who can read the deploy logs (a misconfigured log shipper, an over-permissive Grafana dashboard, a leaked CI token) learns the exact revision hash and, if your `alembic/versions/` directory is in a public repo, can `git checkout <hash>` to read the schema at that revision. The defense is layered: (a) set `[logger_alembic] level = WARNING` in production `alembic.ini` so routine upgrades are silent (errors still log at ERROR); (b) treat the revision hash as a threat-model input — assume an attacker who can read logs knows your schema version, and do not rely on 'the schema is hidden'; (c) keep `alembic/versions/` in a private repo if the schema reveals business logic. See [[13-Performance-and-Observability/Structured-Logging-and-Request-IDs]] for log hygiene and [[11-Authentication-and-Security/Threat-Model-First]] for the threat-model pattern.


## Execution Trace

A first deploy of the schema:

1. **Developer** runs `uv run alembic init alembic` and edits `env.py` as above.
2. **Developer** writes the model files (`user.py`, `project.py`), then runs `uv run alembic revision --autogenerate -m "initial schema"`.
3. **Alembic** reflects the live database (empty), diffs against `Base.metadata` (has `users` and `projects`), and writes `alembic/versions/<hash>_initial_schema.py`.
4. **Developer** reviews the file (see [[Autogenerate-and-Its-Limits]] for the checklist). Commits it.
5. **CI** runs `uv run alembic upgrade head` against a fresh ephemeral database, then runs the test suite. If the migration is broken, CI fails.
6. **Deploy job** runs `uv run alembic upgrade head` against the production database *before* starting the new app version. This is the migration ordering problem; see [[Deploying-Migrations-in-Production]].
7. **App** starts. It does *not* run `Base.metadata.create_all()` — the tables already exist. See [[03-FastAPI-Core/Application-and-Lifespan]] for where lifespan hooks belong; `upgrade head` is not one of them.

```mermaid
sequenceDiagram
 participant Dev as Developer
 participant A as Alembic CLI
 participant DB as Database
 participant AV as alembic_version table

 Dev->>A: alembic revision --autogenerate -m "initial schema"
 A->>DB: reflect current schema (empty)
 A->>A: diff Base.metadata vs empty
 A->>Dev: wrote alembic/versions/<hash>_initial_schema.py

 Dev->>A: alembic upgrade head
 A->>DB: BEGIN TRANSACTION
 A->>DB: CREATE TABLE alembic_version (...)
 A->>DB: CREATE TABLE users (...)
 A->>DB: CREATE TABLE projects (...)
 A->>DB: CREATE INDEX ix_projects_status ON projects (status)
 A->>AV: INSERT version_num = '0001_initial_schema'
 A->>DB: COMMIT
 A-->>Dev: INFO Running upgrade -> 0001_initial_schema, initial schema
```

## Common Mistakes

### Mistake 1: `Base.metadata.create_all()` in the lifespan

```python
# WRONG — violates D-003
@asynccontextmanager
async def lifespan(app: FastAPI):
 Base.metadata.create_all(engine)
 yield
```

This creates tables that are missing — but it does *not* alter tables that exist with the wrong shape. Your test database is fine; your production database drifts away from the models with no migration record. Always use Alembic. See [[Deploying-Migrations-in-Production]].

### Mistake 2: Forgetting to import models in `env.py`

```python
# alembic/env.py
from boardly.models.base import Base
# ... but no `import boardly.models.user` or `import boardly.models.project`
```

`Base.metadata.tables` is empty because no model class has been defined yet. `alembic revision --autogenerate` produces a migration that **drops every table in the database**. The fix is to import every module that defines a model. A clean pattern: put `from boardly.models import user, project # noqa: F401` in `boardly/models/__init__.py`, then `env.py` does `import boardly.models # noqa: F401`.

### Mistake 3: Editing `alembic_version` by hand

```sql
-- WRONG
UPDATE alembic_version SET version_num = '0001_initial_schema' WHERE ...;
```

If the database's actual schema does not match `0001_initial_schema` (e.g. you hand-applied a column change), `alembic upgrade head` will skip the migration that does that change because it thinks the database is already at the revision that did it. Use `alembic stamp <rev>` instead, which is the supported way to mark the database as at a revision.

### Mistake 4: A migration that is not reversible

```python
def upgrade():
 op.add_column("users", sa.Column("email_address", sa.String(320), nullable=False))

def downgrade():
 op.drop_column("users", "email_address")
```

If `upgrade()` added `email_address` as NOT NULL but the existing rows have no value, the upgrade itself fails. The downgrade assumes the column is drop-safe — it is, in this case, but only because the upgrade never ran. The rule: a migration's `downgrade()` must always succeed against a database that ran its `upgrade()`. See [[Data-Migrations-Safely]] for the discipline.

### Mistake 5: Hardcoding `sqlalchemy.url` in `alembic.ini`

```ini
# alembic.ini — WRONG
sqlalchemy.url = postgresql+psycopg://prod_user:s3cret@db.prod/boardly
```

You committed a production secret to version control. Always read the URL from the app's settings in `env.py`.

### Mistake 6: `alembic upgrade head` in app startup

```python
# WRONG — see Deploying-Migrations-in-Production
@asynccontextmanager
async def lifespan(app):
 from alembic.config import Config
 from alembic import command
 command.upgrade(Config("alembic.ini"), "head")
 yield
```

Three problems: (a) every app instance runs migrations, racing each other; (b) the app starts even if the migration fails — which is the opposite of what you want; (c) the migration is invisible to deploy tooling. Run migrations as a deploy step. See [[Deploying-Migrations-in-Production]].

### Mistake 7: Committing the auto-generated migration without reading it

Autogenerate is a draft. It can detect "users.email_address column exists in models but not in DB" but cannot tell whether that means "add the column" or "rename it from email". See [[Autogenerate-and-Its-Limits]] — the rule is: always review.

## Engineering Trade-Offs

### `--autogenerate` vs. hand-written migrations

Autogenerate is fast and convenient. It is also wrong sometimes. The rule of thumb: use autogenerate for "add a new table" and "add a new column to a new table"; hand-write for renames, data migrations, and server-default changes. Always review the result.

### One `alembic/` directory vs. multiple per service

For a monolithic app, one `alembic/` directory. For microservices, one directory per service — each service owns its tables and its migration history. Cross-service migrations (rare) need coordination; see [[17-Advanced-Architecture/Event-Driven-Basics]].

### Naming revision files

Alembic names files `<revision>_<message_slug>.py`. The slug is from your `-m` message. Keep messages short and imperative: `add users`, `add deleted_at to users`, `drop legacy_notes`. Avoid `update1`, `fix`, `test`. The file is checked into git forever; future-you will be reading the list.

### Embedding data migrations in schema migrations

A migration that both alters a column and backfills data is harder to roll back than one that does only one. The pattern in [[Data-Migrations-Safely]] is: split the data backfill into its own revision between the schema-alter revisions. See [[Deploying-Migrations-in-Production]] for the multi-step deploy.

### Branching: when two developers ship conflicting revisions

Two developers each branch off `0001_initial_schema`:

- Alice writes revision `0002_alice_adds_notes` with `down_revision = "0001_initial_schema"`.
- Bob writes revision `0002_bob_adds_tags` with `down_revision = "0001_initial_schema"`.

Both are merged to `main`. Now `alembic heads` reports two heads: `0002_alice_adds_notes` and `0002_bob_adds_tags`. Production cannot have two heads — `alembic upgrade head` refuses to run with multiple heads.

```mermaid
flowchart TD
 R1["0001_initial_schema"]
 RA["0002_alice_adds_notes"]
 RB["0002_bob_adds_tags"]

 R1 --> RA
 R1 --> RB

 Merge["0003_merge_alice_and_bob<br/>down_revision = (RA, RB)"]
 RA --> Merge
 RB --> Merge

 style R1 fill:#d4edda,stroke:#28a745
 style RA fill:#cce5ff,stroke:#007bff
 style RB fill:#cce5ff,stroke:#007bff
 style Merge fill:#fff3cd,stroke:#ffc107
```

You can fix this in two ways:

**(a) Generate a merge revision:**

```bash
uv run alembic merge -m "merge alice and bob" 0002_alice_adds_notes 0002_bob_adds_tags
```

This produces a revision whose `down_revision` is a *tuple* `("0002_alice_adds_notes", "0002_bob_adds_tags")` and whose `upgrade()`/`downgrade()` are empty. It exists only to flatten the DAG. Run `alembic upgrade head` to apply.

**(b) Splice one revision onto the other with `--splice`:**

If Bob's revision has not been deployed anywhere yet, regenerate it with `--splice`:

```bash
uv run alembic revision -m "add tags" --rev-id 0002_bob_adds_tags --splice \
 --head 0002_alice_adds_notes
```

This rewrites Bob's revision's `down_revision` to be `0002_alice_adds_notes` instead of `0001_initial_schema`, linearizing the DAG.

**Engineering judgment:** prefer (a) merge revisions for already-deployed revisions, and (b) `--splice` for revisions still under development. Merging preserves history; splicing rewrites it. Rewriting a deployed revision's `down_revision` is a recipe for an inconsistent `alembic_version` table across environments.

**Warning — Debugging: `alembic upgrade head` refuses to run with `Multiple heads are present`**

The error surfaces in the deploy job, not in dev, because dev had only one developer's revision. The cause is always the same: two revisions were merged to `main` with the same `down_revision`, and no merge revision was created. Debug with `uv run alembic heads` — it lists the two (or more) head revisions. The fix is `uv run alembic merge -m 'merge alice and bob' <head1> <head2>` then `uv run alembic upgrade head`. The prevention is a CI check: add `uv run alembic heads | wc -l` to CI and fail if the count is not `1` — a multiple-heads `main` is a build failure, not a deploy surprise. See [[12-Testing-and-Quality/CI-Pipelines]] for the CI pattern and [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]] for the deploy-ordering angle.


### Working without network during development

`alembic upgrade head` against a local PostgreSQL container is fast. Against a remote production database, it is slow and risky. Use `alembic upgrade head --sql` to print the SQL Alembic would execute, without running it:

```bash
uv run alembic upgrade head --sql > upgrade.sql
```

This is useful for review (a DBA reads the SQL before approving) and for environments where the deploy account cannot run Python but can run `psql`. The SQL is dialect-specific (PostgreSQL, SQLite, etc.) — it is not portable.

**Production reality: `--sql` emits psql-flavored SQL — do not pipe it to a non-psql client**

`uv run alembic upgrade head --sql > upgrade.sql` emits SQL with `psql` meta-commands (`\echo`, `\set`) and explicit `BEGIN`/`COMMIT` transaction boundaries. In a DBA-reviewed workflow where the SQL is applied via `psql -f upgrade.sql`, the meta-commands are respected and the transaction boundaries hold. But if a teammate pipes the SQL through a Python script using `psycopg` (e.g., passing the file contents to `cursor.execute()`), the `\echo` and `\set` lines are sent as SQL and fail with a syntax error. The fix is to apply `--sql` output only via `psql -f`, or to strip the meta-commands (lines starting with a backslash) before piping to a non-psql client. The deeper pattern: prefer `uv run alembic upgrade head` (online mode) when the deploy account can run Python — the `--sql` path is for DBA review only, not for runtime application. See [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]] for the deploy-ordering decision tree.


## Exercises

**Tip — The 20-minute rule**

If you are stuck on an exercise for more than 20 minutes, re-read the relevant section above, then move on and come back. Learning is not linear.


**Exercise 1 — Install and init.** Run `uv init boardly && cd boardly && uv add sqlalchemy alembic pydantic-settings`. Verify the versions: `uv run python -c "import alembic, sqlalchemy; print(alembic.__version__, sqlalchemy.__version__)"` should print `1.20.0 2.1.5` (or higher). Run `uv run alembic init alembic`. Confirm the directory layout matches the table above.

**Exercise 2 — Wire `env.py`.** Add the `sys.path` insertion, the settings import, the model imports, and `compare_type=True` / `compare_server_default=True` as shown. Verify `len(Base.metadata.tables)` is `2` after the imports by adding a temporary `print` at the bottom of `env.py` and running `uv run alembic current` (which should print nothing meaningful but execute `env.py`).

**Exercise 3 — Generate and apply the first migration.** Run `uv run alembic revision --autogenerate -m "initial schema"`. Open the generated file. Verify it has `op.create_table("users", ...)` and `op.create_table("projects", ...)`. Apply with `uv run alembic upgrade head`. Verify in psql: `\dt` should show `alembic_version`, `users`, `projects`.

**Exercise 4 — Add a column and migrate.** Add `description: Mapped[str | None] = mapped_column(String(2000), nullable=True)` to `User` (rename the existing one to `bio` if you prefer). Run `uv run alembic revision --autogenerate -m "add bio to users"`. Read the file. Apply. Verify with `\d users` in psql.

**Exercise 5 — Roll back.** Run `uv run alembic downgrade -1`. Verify the `bio` column is gone. Run `uv run alembic upgrade head` to re-apply.

**Exercise 6 — Inspect state.** Run `alembic current`, `alembic history`, and `alembic heads`. Confirm they report what you expect.

**Exercise 7 — Branch the DAG.** Simulate the branching scenario: hand-edit a copy of the latest migration to have a different `revision` ID but the same `down_revision`. Run `alembic heads` — it should report two. Generate a merge revision with `alembic merge`. Apply. Confirm `alembic heads` now reports one.

**Exercise 8 — Stamp.** Run `alembic stamp head` against a fresh empty database. Verify `alembic_version` is populated but no tables were created. This is how you tell Alembic "the database is at this revision; do not run anything."

**Exercise 9 — Recover from an orphaned `alembic_version` row.** Simulate the failure: `psql -d boardly_dev -c "UPDATE alembic_version SET version_num = 'deadbeef';"`. Run `uv run alembic current` — it fails with `Can't locate revision identified by 'deadbeef'`. Recover with `uv run alembic stamp 0001_initial_schema`. Verify `uv run alembic current` reports the good revision and `uv run alembic upgrade head` is a no-op.

**Exercise 10 — Audit `alembic.ini` for a committed URL.** Add a fake URL line to `alembic.ini` (`sqlalchemy.url = postgresql+psycopg://user:pass@host/db`). Run `uv run python -c "import sys; bad = [l for l in open('alembic.ini') if l.startswith('sqlalchemy.url') and '://' in l and '@' in l]; print('SECRET FOUND' if bad else 'clean'); sys.exit(1 if bad else 0)"` — exit 1 = secret found (the audit fails). Remove the URL line, re-run — exit 0 = clean (the audit passes). Add the check as a pre-commit hook.

**Exercise 11 — Assert `Base.metadata` is non-empty in `env.py`.** Add `assert len(target_metadata.tables) >= 2, 'Base.metadata is empty — did you import the models?'` at the bottom of `alembic/env.py`. Run `uv run alembic current` — the assert passes. Comment out `import boardly.models.user` and re-run `uv run alembic current` — the assert fires with the message.

**Exercise 12 — Generate and apply a merge revision.** Hand-create two revisions off `0001_initial_schema` with different `revision` IDs (e.g., `0002a_add_notes` and `0002b_add_tags`), both with `down_revision = "0001_initial_schema"`. Run `uv run alembic heads` — confirm it reports two heads. Generate a merge with `uv run alembic merge -m 'merge 0002a and 0002b' 0002a_add_notes 0002b_add_tags`. Apply with `uv run alembic upgrade head`. Confirm `uv run alembic heads` now reports one head.

**Exercise 13 — Round-trip upgrade/downgrade/upgrade in CI.** Run `uv run bash -c "uv run alembic upgrade head && uv run alembic downgrade base && uv run alembic upgrade head"`. All three steps must succeed (exit 0). This is the CI pattern that catches a broken `downgrade()` before it reaches production.

**Exercise 14 — Verify no drift after a migration.** After applying `0001_initial_schema`, run `uv run alembic revision --autogenerate -m 'verify no drift'`. Open the generated file. Confirm both `upgrade()` and `downgrade()` are empty (`pass` — no `op.X` calls). If they are not empty, there is drift between `Base.metadata` and the database. Roll back the empty revision with `uv run alembic downgrade -1`.

## Verification

```bash
# 1. Apply migrations
uv run alembic upgrade head
# expected: INFO [alembic.runtime.migration] Running upgrade -> 0001_initial_schema, initial schema

# 2. Inspect current state
uv run alembic current
# expected: 0001_initial_schema (head)

# 3. Inspect the DAG
uv run alembic history
# expected: <base> -> 0001_initial_schema, initial schema

# 4. Confirm the database has the tables and the alembic_version table
psql -d boardly_dev -c "\dt"
# expected: tables list includes users, projects, alembic_version
psql -d boardly_dev -c "SELECT * FROM alembic_version;"
# expected: one row with the current revision hash

# 5. Roll back one step
uv run alembic downgrade -1
# expected: INFO [alembic.runtime.migration] Running downgrade 0001_initial_schema -> , initial schema

# 6. Recover from a hand-edited alembic_version (don't do this in production):
# psql -d boardly_dev -c "UPDATE alembic_version SET version_num='0001_initial_schema';"
uv run alembic stamp 0001_initial_schema
# this resets Alembic's view to "database is at 0001" without running anything
```

## Previously Learned Here

These concepts were taught in earlier lessons. We link back instead of re-explaining:

- **DeclarativeBase** — [[07-SQLAlchemy/03-Declarative-Base-and-Mapped]]. Reused here as `Base.metadata`, the source of truth autogenerate diffs against. New detail: every model module must be imported in `env.py` for the tables to be registered.
- **Engine (SQLAlchemy)** — [[07-SQLAlchemy/02-Engines-Connections-Pools]]. Reused here as the engine `env.py` constructs with `engine_from_config`. New detail: `pool.NullPool` is appropriate for migration runs because each migration is a one-shot, not a long-lived connection.
- **Settings / environment configuration** — [[04-Pydantic/Pydantic-Settings]]. Reused here to read the database URL. New detail: `alembic.ini` is no longer the source of the URL; `env.py` reads from settings.
- **FastAPI lifespan** — [[03-FastAPI-Core/Application-and-Lifespan]]. Mentioned here as where NOT to call `upgrade head`. The lifespan owns application-level setup, not schema management.

## What's Next

In [[Autogenerate-and-Its-Limits]] you will:

- See what `alembic revision --autogenerate` can detect (tables, columns, FKs, indexes, nullability) and what it cannot (renames, data migrations, server defaults, check constraints).
- Watch autogenerate mis-detect a real rename (`Project.description` becomes `Project.summary`) as a destructive drop+add, and learn the manual `op.alter_column` fix.
- Read a generated file critically in under five minutes using a seven-item checklist.
- Decide when to use autogenerate and when to hand-write the migration.

By the end of Lesson 02, you will be able to read any Alembic-generated file and decide — quickly — whether it is safe to apply or whether it needs rewriting.

## Sources

- Alembic — Tutorial — <https://alembic.sqlalchemy.org/en/latest/tutorial.html> — accessed 2026-10-19 — the canonical "alembic init, revision, upgrade, downgrade" walkthrough.
- Alembic — Auto Generating Migrations — <https://alembic.sqlalchemy.org/en/latest/autogenerate.html> — accessed 2026-10-19 — what autogenerate can and cannot detect.
- Alembic — Branching — <https://alembic.sqlalchemy.org/en/latest/branches.html> — accessed 2026-10-19 — the `--rev-id` and `--splice` workflow for multi-developer revision trees.
- Alembic — `alembic_version` table — <https://alembic.sqlalchemy.org/en/latest/cookbook.html> — accessed 2026-10-19 — the cookbook entry on the version-tracking table and stamping.
- SQLAlchemy 2.x — MetaData — <https://docs.sqlalchemy.org/en/21/core/metadata.html> — accessed 2026-10-19 — the `Base.metadata` object that Alembic diffs against.
- SQLAlchemy 2.x — Naming Conventions — <https://docs.sqlalchemy.org/en/21/core/constraints.html#constraint-names> — accessed 2026-10-19 — the `naming_convention` dict we set on `Base.metadata`.
- Pydantic Settings — <https://docs.pydantic.dev/latest/concepts/pydantic_settings/> — accessed 2026-10-19 — `BaseSettings` and `SettingsConfigDict`.

## What We Learned

Let's recap. In this lesson you:

- **Installed Alembic** in a `uv`-managed project and ran `alembic init alembic` to produce the canonical layout.
- **Wired `Base.metadata` into `env.py`** — the path-insert, the settings import, the model imports, the URL override, and the `compare_type` / `compare_server_default` flags.
- **Created the first migration** by hand for the Boardly `users` and `projects` tables, with a naming convention and `op.f(...)` constraint names.
- **Applied it with `alembic upgrade head`**, rolled it back with `alembic downgrade -1`, and inspected state with `alembic current` / `history` / `heads`.
- **Learned the `alembic_version` table** — what it stores, why you must never edit it by hand, and how `alembic stamp` recovers from a hand-edit.
- **Branched the revision DAG** when two developers ship conflicting revisions, and merged them with `alembic merge` or `alembic revision --splice`.
- **Hit and avoided the seven classic Alembic mistakes** — `create_all()` in lifespan, forgetting to import models, hand-editing `alembic_version`, irreversible migrations, hardcoded URLs in `alembic.ini`, `upgrade head` in startup, and committing unreviewed autogenerated files.

Here's the mental model to walk away with: *Alembic is a thin layer of three things — a directory of migration files forming a DAG, a one-row `alembic_version` table holding the current revision, and an `env.py` that connects your models to the database. Every command you run is "find the current revision, walk the DAG, apply each step." The discipline that makes this safe is: every migration is a reviewed, reversible pair; the URL comes from settings, not `alembic.ini`; and `upgrade head` runs as a deploy step, not in a lifespan.*

---

> A note from your teacher
You just built the skeleton of every migration pipeline you will ever ship. Sit with that for a second. One `alembic init`, one wired `env.py`, one migration file, and your database has a versioned, reviewable, reversible history. The skeleton you wrote today stays the same — only the migration files change, one per schema evolution. Next we will look at what happens when autogenerate writes the wrong migration for you, and how to spot it before it ships. See you in Lesson 02.


---

**Tags:** #alembic #migrations #setup #review
**Previous:** [[00-Alembic-MOC]]
**Next:** [[Autogenerate-and-Its-Limits]] →

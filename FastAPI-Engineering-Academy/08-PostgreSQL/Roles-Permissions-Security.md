---
title: "Lesson 04: Roles, Permissions, and Security"
aliases:
 - PostgreSQL Roles
 - GRANT REVOKE
 - RLS
 - Row-Level Security
 - SECURITY DEFINER
 - Least-Privilege
 - App Role vs Migration Role
tags:
 - postgresql
 - security
 - access-control
 - rls
 - least-privilege
 - lesson
course_level: advanced
status: complete
difficulty: advanced
estimated_time: "90–120 minutes"
prerequisites:
 - "[[08-PostgreSQL/00-PostgreSQL-MOC]]"
 - "[[06-SQL-Fundamentals/Relational-Model-and-Constraints]]"
 - "[[06-SQL-Fundamentals/SQL-Injection-and-Parameterized-Queries]]"
 - "[[08-PostgreSQL/Types-UUID-Identity-JSONB]]"
related_lessons:
 - "[[Types-UUID-Identity-JSONB]]"
 - "[[Backups-and-Recovery]]"
 - "[[07-SQLAlchemy/02-Engines-Connections-Pools]]"
 - "[[07-SQLAlchemy/07-Async-SQLAlchemy]]"
 - "[[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]]"
 - "[[11-Authentication-and-Security/Threat-Model-First]]"
---

# Lesson 04: Roles, Permissions, and Security

*Locking down the Boardly database — `boardly_app` and `boardly_migrator` roles with least privilege, `GRANT`/`REVOKE` at every level, `SECURITY DEFINER` functions with pinned `search_path`, row-level security for multi-tenant isolation, connection limits, and the why of separating the app role from the migration role.*

**Welcome to Lesson 4.**

An application database role with `SUPERUSER` privileges is a one-line production incident waiting to happen. A schema-migration role that the application uses at runtime is a privilege-escalation vector that bypasses every other control. A multi-tenant database without row-level security is a data-leak waiting for the first missing `WHERE organization_id = ?` clause. This lesson teaches the PostgreSQL primitives that turn those scary sentences into defensible design. Take it slow. Each `GRANT` is a deliberate decision. Each `REVOKE ... FROM PUBLIC` is a defensible posture. **This is how you learn.**


#postgresql #security #rls #least-privilege #access-control

## Learning Objectives

By the end of this lesson you will be able to:

1. **Distinguish login roles from group roles** and design a small, composable role hierarchy for Boardly.
2. **Apply `GRANT`/`REVOKE`** at the database, schema, table, column, sequence, and function level — and explain why each scope exists.
3. **Set `ALTER DEFAULT PRIVILEGES`** so future tables created by the migrator get the right grants automatically.
4. **Choose between `SECURITY DEFINER` and `SECURITY INVOKER`** functions, and explain the privilege-escalation implications of each.
5. **Pin `search_path`** on `SECURITY DEFINER` functions to prevent search-path injection — one of the most reproduced PostgreSQL CVE classes.
6. **Enable and write row-level security (RLS) policies** for multi-tenant isolation, including `FORCE ROW LEVEL SECURITY` to make the table owner subject to RLS.
7. **Set per-role connection limits** and reason about pool size vs `CONNECTION LIMIT`.
8. **Separate the application role from the migration role** and explain why a SQL injection in the application cannot `DROP TABLE` under this design.
9. **Use `SET LOCAL app.organization_id`** safely inside a transaction, and explain why `SET` (session-scoped) is a footgun on pooled connections.

## Prerequisites

Before starting, you need:

- **The Boardly schema** — [[08-PostgreSQL/Types-UUID-Identity-JSONB]]. The roles and RLS policies in this lesson apply to the tables designed there.
- **The SQL injection lesson** — [[06-SQL-Fundamentals/SQL-Injection-and-Parameterized-Queries]]. That lesson taught parameter binding as the first line of defense; this lesson is the second line (least privilege bounds the blast radius).
- **The relational model** — [[06-SQL-Fundamentals/Relational-Model-and-Constraints]]. Constraints are the third layer of defense (the database refuses invalid data even if the application sends it).
- **The SQLAlchemy engines lesson** — [[07-SQLAlchemy/02-Engines-Connections-Pools]]. The application's connection pool authenticates as a role designed here; the canonical lesson covers the pool side.
- **About 90 minutes of focused time.** The SQL is short; the implications are long.

**The most common gap: why roles, not users**

Engineers coming from MySQL sometimes ask "where do I create the user?" PostgreSQL has no separate user object. A "user" is just a role with the `LOGIN` attribute. Roles have privileges (`SELECT`, `INSERT`, ...), memberships (other roles they belong to), and attributes (`LOGIN`, `SUPERUSER`, `CREATEDB`, `REPLICATION`, `BYPASSRLS`, `CONNECTION LIMIT`). The model is uniform. Once you internalize that, the rest follows.


## The Problem

The default PostgreSQL setup is: one role (`postgres`), with `SUPERUSER`, owning every table. The application connects as `postgres`. Migrations run as `postgres`. Backups run as `postgres`.

This is fine — until it isn't. Three failure modes:

1. **A bug in the application can `DROP TABLE` or `ALTER TABLE`.** There is no privilege separation between "what the app does at runtime" and "what migrations do."
2. **A SQL injection in the application can mutate the schema.** `DROP TABLE users;` runs as the application role, which owns `users`. There is no second line of defense.
3. **A multi-tenant query that forgets `WHERE organization_id = ?` leaks cross-tenant data.** The database has no way to enforce per-row scoping.

This lesson teaches the fixes:

- **Least privilege.** The application role has only `SELECT`, `INSERT`, `UPDATE`, `DELETE` on existing tables — never `DDL`. The migration role has `CREATE`/`ALTER`/`DROP` and is used only by migration tooling.
- **Row-level security.** Every query is silently scoped by the session's `app.organization_id`, even if the application forgets the `WHERE` clause.
- **`SECURITY DEFINER` functions** for the small set of operations that need privileged access in a controlled way.

This is the second half of the defense-in-depth story that started in [[06-SQL-Fundamentals/SQL-Injection-and-Parameterized-Queries]]: even if injection slips through parameter binding, a least-privilege role bounds the blast radius.

## The Code

Here is the complete role-and-RLS setup for Boardly. Save as `boardly_security.sql`.

```sql
-- boardly_security.sql
-- Section 08, Lesson 04: roles, grants, RLS, and SECURITY DEFINER for Boardly.

-- 1. Group roles (no LOGIN — these are permission bundles, not connections)
CREATE ROLE boardly_migrator NOLOGIN CREATEDB;
CREATE ROLE boardly_app NOLOGIN;
CREATE ROLE boardly_app_readonly NOLOGIN;

-- 2. Login roles (the actual connection identities)
CREATE ROLE boardly_app_user
 LOGIN PASSWORD 'replace-with-a-real-secret'
 CONNECTION LIMIT 50
 IN ROLE boardly_app;

CREATE ROLE boardly_analytics_user
 LOGIN PASSWORD 'replace-with-a-different-secret'
 CONNECTION LIMIT 10
 IN ROLE boardly_app_readonly;

CREATE ROLE boardly_migrator_login
 LOGIN PASSWORD 'replace-with-a-third-secret'
 IN ROLE boardly_migrator;

-- 3. Tighten PUBLIC — the "every role" pseudo-role gets nothing by default
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE academy FROM PUBLIC;

-- 4. Schema access: app roles can USE the schema; only migrator can CREATE
GRANT USAGE ON SCHEMA public TO boardly_app, boardly_app_readonly;
-- (CREATE is *not* granted — only the migrator has it, via the role.)

-- 5. Table privileges (existing tables)
GRANT SELECT, INSERT, UPDATE, DELETE
 ON ALL TABLES IN SCHEMA public TO boardly_app;
GRANT SELECT
 ON ALL TABLES IN SCHEMA public TO boardly_app_readonly;

-- 6. Sequence privileges (so INSERTs into IDENTITY columns work)
GRANT USAGE, SELECT
 ON ALL SEQUENCES IN SCHEMA public TO boardly_app;

-- 7. Default privileges for future tables (created by the migrator)
ALTER DEFAULT PRIVILEGES FOR ROLE boardly_migrator IN SCHEMA public
 GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO boardly_app;
ALTER DEFAULT PRIVILEGES FOR ROLE boardly_migrator IN SCHEMA public
 GRANT SELECT ON TABLES TO boardly_app_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE boardly_migrator IN SCHEMA public
 GRANT USAGE, SELECT ON SEQUENCES TO boardly_app;

-- 8. Sensitive column redaction (analytics can't see password_hash if any)
-- REVOKE SELECT (password_hash) ON users FROM boardly_app_readonly;

-- 9. RLS for tenant isolation on every organization-scoped table
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

-- Optional: force RLS even for the table owner (the migrator still bypasses
-- via BYPASSRLS if you grant it; see below)
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE comments FORCE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;

-- Per-table RLS policies
CREATE POLICY users_org_isolation ON users
 FOR ALL
 USING (home_org_id = current_setting('app.organization_id', true)::uuid)
 WITH CHECK (home_org_id = current_setting('app.organization_id', true)::uuid);

CREATE POLICY projects_org_isolation ON projects
 FOR ALL
 USING (organization_id = current_setting('app.organization_id', true)::uuid)
 WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

-- tasks are scoped via their parent project's organization_id.
CREATE POLICY tasks_org_isolation ON tasks
 FOR ALL
 USING (EXISTS (
 SELECT 1 FROM projects p
 WHERE p.id = tasks.project_id
 AND p.organization_id = current_setting('app.organization_id', true)::uuid))
 WITH CHECK (EXISTS (
 SELECT 1 FROM projects p
 WHERE p.id = tasks.project_id
 AND p.organization_id = current_setting('app.organization_id', true)::uuid));

-- comments are scoped via their parent task's project's organization_id.
CREATE POLICY comments_org_isolation ON comments
 FOR ALL
 USING (EXISTS (
 SELECT 1 FROM tasks t
 JOIN projects p ON p.id = t.project_id
 WHERE t.id = comments.task_id
 AND p.organization_id = current_setting('app.organization_id', true)::uuid))
 WITH CHECK (EXISTS (
 SELECT 1 FROM tasks t
 JOIN projects p ON p.id = t.project_id
 WHERE t.id = comments.task_id
 AND p.organization_id = current_setting('app.organization_id', true)::uuid));

-- memberships are scoped via their organization_id directly.
CREATE POLICY memberships_org_isolation ON memberships
 FOR ALL
 USING (organization_id = current_setting('app.organization_id', true)::uuid)
 WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

-- 10. The migrator bypasses RLS (needed for cross-organization migrations)
ALTER ROLE boardly_migrator BYPASSRLS;

-- 11. A SECURITY DEFINER function for the one cross-organization admin operation
CREATE OR REPLACE FUNCTION admin_promote(p_user_id uuid, p_role membership_role)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
 IF current_setting('app.is_admin', true) IS DISTINCT FROM 'true' THEN
 RAISE EXCEPTION 'admin only';
 END IF;

 UPDATE memberships SET role = p_role
 WHERE user_id = p_user_id
 AND organization_id = current_setting('app.organization_id', true)::uuid;

 INSERT INTO audit_log (action, target_id, actor_id, payload)
 VALUES (
 'admin_promote',
 p_user_id,
 NULLIF(current_setting('app.actor_id', true), '')::uuid,
 jsonb_build_object('new_role', p_role::text)
 );
END;
$$;

REVOKE ALL ON FUNCTION admin_promote(uuid, membership_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_promote(uuid, membership_role) TO boardly_app;
```

That's ~120 lines. Run it. Inspect with `\du` (roles), `\dp users` (privileges), `\d+ users` (RLS). Connect as `boardly_app_user`, set `app.organization_id`, and query. Confirm cross-organization rows are invisible. That's the loop.

## Line-by-Line Deep Dive

### Lines 5–7: The three group roles

```sql
CREATE ROLE boardly_migrator NOLOGIN CREATEDB;
CREATE ROLE boardly_app NOLOGIN;
CREATE ROLE boardly_app_readonly NOLOGIN;
```

**What this does:** Creates three group roles — permission bundles, not connection identities.

**Why group roles:** A "group role" is a role without `LOGIN`. It exists only to bundle privileges that login roles can inherit. Three bundles cover the Boardly access patterns:

- `boardly_migrator` — owns the schema, runs migrations. Has `CREATEDB` (so it can create new databases in dev/test; in prod you'd remove this). Does *not* have `LOGIN` — the migrator never connects directly; only `boardly_migrator_login` does.
- `boardly_app` — the application's normal role. Will have `SELECT`, `INSERT`, `UPDATE`, `DELETE` on existing tables. No DDL.
- `boardly_app_readonly` — the analytics / reporting role. `SELECT` only.

**Why `NOLOGIN`:** A role with `NOLOGIN` cannot connect. This makes the group role safe to grant privileges to without fear that someone will connect as it.

**Tip — Why `CREATEDB` on the migrator**

The migrator needs `CREATEDB` if it has to create new databases (for tests, for tenant provisioning). In production, you'd typically *not* grant `CREATEDB` — databases are provisioned by an external orchestration step, not by the migration tool. We grant it here for the academy example; remove it in prod.


**Student asks: why split `boardly_app` from `boardly_app_user`? Why not just one role with `LOGIN` and the privileges?**

Because the two roles model two different concerns. `boardly_app` (the *group* role) is the bundle of privileges — `SELECT/INSERT/UPDATE/DELETE` on every table, `USAGE` on every sequence. It never connects; it has no password; it has `NOLOGIN`. `boardly_app_user` (the *login* role) is the connection identity the application uses in its database URL. It has a password, a `CONNECTION LIMIT`, and `IN ROLE boardly_app`. Splitting them lets you rotate credentials without touching privileges: when the secret leaks and you `ALTER ROLE boardly_app_user PASSWORD 'new-secret'`, the privileges stay attached via the group. The same split is why you can provision a second login role (`boardly_app_user_v2`) for a blue-green deploy without re-granting every table. The pattern matches the operating-system world: a *group* (privileges) vs a *user* (login identity).


**Production reality: the group/login split is the blue-green-deploy provisioning seam.**

To provision `boardly_app_user_v2` for a blue-green deploy, you `CREATE ROLE boardly_app_user_v2 LOGIN PASSWORD '...' CONNECTION LIMIT 50 IN ROLE boardly_app;` — the privileges arrive via the group, with zero per-table re-grants. You cut over the connection string in the new pods, drain the old ones, and `DROP ROLE boardly_app_user` once the old connections close. The same seam is the credential-rotation path: `ALTER ROLE boardly_app_user PASSWORD 'new-secret'` changes only the login identity; the privilege bundle on `boardly_app` is untouched, so the running connections keep their grants for the rest of the request. The anti-pattern is a single monolithic `boardly_app_user LOGIN` role that bundles privileges AND identity — every rotation becomes a re-grant, every deploy becomes a re-grant, and the only safe rotation is downtime. The group role is the stable privilege anchor that survives credential rotation and deploys; the login role is the disposable credential. Cross-link to [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]] for the blue-green ordering that keeps both login roles live during the cutover.


### Lines 10–20: The login roles

```sql
CREATE ROLE boardly_app_user
 LOGIN PASSWORD 'replace-with-a-real-secret'
 CONNECTION LIMIT 50
 IN ROLE boardly_app;

CREATE ROLE boardly_analytics_user
 LOGIN PASSWORD 'replace-with-a-different-secret'
 CONNECTION LIMIT 10
 IN ROLE boardly_app_readonly;

CREATE ROLE boardly_migrator_login
 LOGIN PASSWORD 'replace-with-a-third-secret'
 IN ROLE boardly_migrator;
```

**What this does:** Creates the three login roles — the actual connection identities.

**Why each part:**

- `LOGIN` — the attribute that lets the role connect. Without it, the role is a group.
- `PASSWORD '...'` — set to a placeholder here. In production, use a secret manager (Vault, AWS Secrets Manager, Doppler). Never hardcode passwords in version control. The placeholder makes the example runnable; replace it.
- `CONNECTION LIMIT 50` — the per-role connection limit. The application's pool size should be ≤ `CONNECTION LIMIT` minus a small reserve for migrations and admin queries. 50 is a reasonable default for a small-to-medium app.
- `IN ROLE boardly_app` — makes `boardly_app_user` a *member* of `boardly_app`. The login role inherits the group role's privileges (by default; `INHERIT` is the default).

**Warning — `CONNECTION LIMIT` is per-role, not per-database**

The connection limit is on the role, not on a specific database. If `boardly_app_user` connects to two databases, the limit applies to the sum. The application's pool size should be ≤ `CONNECTION LIMIT` minus reserve. Monitor `pg_stat_activity` for `IdleInTransaction` connections that consume the budget.


**Warning — When this breaks: the `IdleInTransaction` connection-budget drain.**

A request that opens a transaction and never commits holds a connection against the `CONNECTION LIMIT 50` budget for its entire lifetime; 50 such requests and the 51st connection fails with `FATAL: too many connections for role "boardly_app_user"`. The symptom in production is intermittent `OperationalError` under load that resolves on a process restart — the classic "works on my machine, fails in prod" signature of a connection leak, not a misconfigured limit. The diagnosis is `SELECT state, count(*) FROM pg_stat_activity WHERE usename = 'boardly_app_user' GROUP BY state;` — a non-zero `idle in transaction` count is the leak, and the oldest `state_change` timestamp in that group is the request that never committed (a forgotten `session.begin()`, an exception that bypassed the `finally: session.close()`, a background task that holds a transaction across an `await`). The fix is the `get_session` dependency's `finally` block that `session.close()`s unconditionally; the `IdleInTransaction` count should be zero at steady state. The `CONNECTION LIMIT` is the ceiling; the pool size is the floor; the leak is what makes the two collide. Cross-link to [[07-SQLAlchemy/05-Session-and-Transaction-Management]] for the session-leak pattern and [[07-SQLAlchemy/02-Engines-Connections-Pools]] for the pool-overflow cascade that follows.


### Lines 23–25: Tighten `PUBLIC`

```sql
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE academy FROM PUBLIC;
```

**What this does:** Removes the default `PUBLIC` privileges on the `public` schema and the `academy` database.

**Why `PUBLIC` is dangerous:** `PUBLIC` is a pseudo-role that includes every role. On a fresh database, `PUBLIC` has `CONNECT` and `TEMPORARY` on the database, and `USAGE` on the `public` schema. That means any role you create can connect to the database and create temp tables in `public`. For a sensitive deployment, tighten this:

```sql
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE academy FROM PUBLIC;
GRANT CONNECT ON DATABASE academy TO boardly_app, boardly_app_readonly;
GRANT USAGE ON SCHEMA public TO boardly_app, boardly_app_readonly;
```

**Example — The `PUBLIC` trap with functions**

Every function you `CREATE` has `EXECUTE` granted to `PUBLIC` by default. So a `SECURITY DEFINER` function is callable by *any* role in the database, including a low-privilege role you created for a one-off task. The rule: `REVOKE ALL ON FUNCTION ... FROM PUBLIC;` for every `SECURITY DEFINER` function, then `GRANT EXECUTE` to the specific roles that need it.


**Danger — How an attacker thinks: the `PUBLIC EXECUTE` default is the privilege-escalation primer.**

The first move of an attacker with any DB foothold (a SQL-injection that can issue `SELECT`, a read-only analyst whose role was over-granted, a contractor role created for a one-off export) is `SELECT proname, prosecdef, proowner::regrole FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;` — the catalog query that lists every `SECURITY DEFINER` function in the `public` schema, with its owner. For each hit, the attacker probes `has_function_privilege('boardly_analytics_user', proname::text, 'EXECUTE')` — every `true` is a function the read-only role can call, which runs as the migrator. The `admin_promote` function in this lesson is callable by `boardly_app` only because of the explicit `REVOKE ... FROM PUBLIC; GRANT EXECUTE ... TO boardly_app;` — without that pair, every role in the database could promote users. The audit grep that catches the un-revoked DEFINER before an attacker does is `rg "SECURITY DEFINER" -A6 boardly_security.sql | rg -L "REVOKE"` — every `SECURITY DEFINER` definition that is not followed (within ~6 lines) by a `REVOKE ... FROM PUBLIC` is a privilege-escalation waiting for the catalog probe. The CI gate is a `pytest` assertion that `SELECT count(*) FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace AND has_function_privilege('boardly_analytics_user', proname::text, 'EXECUTE')` returns `0`. Cross-link to [[11-Authentication-and-Security/OWASP-API-Top-10]] (API5:2023 Broken Function Level Authorization) and [[11-Authentication-and-Security/Threat-Model-First]].


### Lines 28–29: Schema access

```sql
GRANT USAGE ON SCHEMA public TO boardly_app, boardly_app_readonly;
```

**What this does:** Grants `USAGE` on the `public` schema to both app roles.

**Why `USAGE` and not `CREATE`:** `USAGE` lets a role *access* objects in the schema (run queries against tables, call functions). `CREATE` lets a role *create* objects in the schema. The app roles need `USAGE` to read/write tables; they don't need `CREATE` (the migrator has it, the app doesn't). Without `USAGE` on the schema, a role can't see the tables inside — `GRANT SELECT ON ALL TABLES` is meaningless without `GRANT USAGE ON SCHEMA`.

### Lines 32–35: Table privileges

```sql
GRANT SELECT, INSERT, UPDATE, DELETE
 ON ALL TABLES IN SCHEMA public TO boardly_app;
GRANT SELECT
 ON ALL TABLES IN SCHEMA public TO boardly_app_readonly;
```

**What this does:** Grants DML privileges on all current tables in `public` to the app roles.

**Why `ON ALL TABLES IN SCHEMA`:** Convenience. The alternative is per-table: `GRANT SELECT ON users TO boardly_app; GRANT SELECT ON projects TO boardly_app; ...`. The schema-level form applies to all current tables — but **not to future tables**. For future tables, see `ALTER DEFAULT PRIVILEGES` below.

**The privileges, in detail:**
- `SELECT` — read rows.
- `INSERT` — insert rows. (Requires `USAGE` on the sequence for `IDENTITY`/`SERIAL` columns; see line 38.)
- `UPDATE` — update rows. (Subject to `WHERE`, of course.)
- `DELETE` — delete rows.
- `TRUNCATE` — truncate the table. *Not granted* to the app role — too dangerous.
- `REFERENCES` — needed to create a FK *to* this table. Usually granted to the migrator only.
- `TRIGGER` — needed to create triggers. Migrator only.

### Lines 38–40: Sequence privileges

```sql
GRANT USAGE, SELECT
 ON SEQUENCES IN SCHEMA public TO boardly_app;
```

**What this does:** Grants `USAGE` and `SELECT` on all sequences to the app role.

**Why sequences need separate grants:** An `INSERT` into a table with a `SERIAL` or `bigserial` PK calls `nextval()` on the underlying sequence. The sequence is a separate object from the table. Without `USAGE` on the sequence, the `INSERT` fails with `permission denied for sequence ...`.

**`IDENTITY` columns** (Lesson 1) are slightly different: the implicit sequence is *owned by the column*, and grants on the table cover it. But for legacy `SERIAL` columns, you need explicit sequence grants.

**The footgun: `GRANT INSERT` without sequence grant**

A classic mistake: `GRANT INSERT ON users TO boardly_app;` without `GRANT USAGE, SELECT ON SEQUENCES ...`. The application's first `INSERT` fails. The fix is the sequence grant. `IDENTITY` columns avoid this entirely.


### Lines 43–49: Default privileges for future tables

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE boardly_migrator IN SCHEMA public
 GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO boardly_app;
ALTER DEFAULT PRIVILEGES FOR ROLE boardly_migrator IN SCHEMA public
 GRANT SELECT ON TABLES TO boardly_app_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE boardly_migrator IN SCHEMA public
 GRANT USAGE, SELECT ON SEQUENCES TO boardly_app;
```

**What this does:** Pre-empts grants for tables created in the future by `boardly_migrator`.

**Why `ALTER DEFAULT PRIVILEGES`:** `GRANT ... ON ALL TABLES` covers current tables. The *next* migration that creates a table — `boardly_migrator` runs `CREATE TABLE events_2026_11 PARTITION OF events ...` — would create a table that the app role cannot read. Without `ALTER DEFAULT PRIVILEGES`, every migration needs to follow its `CREATE TABLE` with explicit grants.

`ALTER DEFAULT PRIVILEGES FOR ROLE boardly_migrator` says: "whenever a role in the `boardly_migrator` group creates a table in `public`, automatically grant the listed privileges to the listed grantees."

**Warning — `ALTER DEFAULT PRIVILEGES` is per-creator**

The defaults apply only to objects created by the *specified* role (or its members). If a different role (e.g., `postgres`) creates a table, the defaults don't fire. Make sure the migrator role creates *every* object in the schema, or set defaults for every possible creator.


**Production reality: a partition table created by the wrong role is invisible to the app.**

`ALTER DEFAULT PRIVILEGES FOR ROLE boardly_migrator` fires only when the migrator creates the object; a `CREATE TABLE events_2026_11 PARTITION OF events ...` run by `postgres` (a DBA hotfix, a manual backfill, a console session) creates a partition the app role cannot `SELECT` — the next request against `events_2026_11` fails with `ERROR: permission denied for table events_2026_11` and the route 500s. The symptom is "a route that worked yesterday 500s today, and the only change was last night's partition rollover" — the partition was created by `postgres`, not the migrator, so the default privileges never fired. The audit query that finds every wrong-owner partition is `SELECT n.nspname, c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname LIKE 'events\\_%' ORDER BY c.relname;` — every partition's owner must be `boardly_migrator`, never `postgres`. The discipline: never let `postgres` create objects in the app schema; route every DDL (including partition maintenance) through the migrator login, or use a `SECURITY DEFINER` maintenance function owned by the migrator. Cross-link to [[09-Alembic-Migrations/Deploying-Migrations-in-Production]] for the migrator-login discipline and [[09-Alembic-Migrations/Data-Migrations-Safely]].


### Lines 60–66: Enable RLS

```sql
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

ALTER TABLE users FORCE ROW LEVEL SECURITY;
-- ... etc
```

**What this does:** Enables RLS on every tenant-scoped table, and `FORCE`s it on the table owner.

**Why RLS:** Without RLS, every query from the app role can see every row. A query that forgets `WHERE organization_id = ?` returns all organizations' data. With RLS, every query is silently scoped by a policy.

**Why `FORCE`:** By default, the table *owner* bypasses RLS. If the owner is `boardly_migrator` (which it should be — the migrator creates the schema), and the app connects as `boardly_app_user` (a member of `boardly_app`), the app is *not* the owner — so RLS applies. Good. But if you accidentally make the app role the owner, RLS is bypassed. `FORCE ROW LEVEL SECURITY` makes even the owner subject to RLS — defense in depth.

**The migrator bypasses RLS** (via `BYPASSRLS` on line 86). That's correct — migrations need to read/write all rows. The app role does *not* have `BYPASSRLS`.

**Warning — When this breaks: `ENABLE` without `FORCE` is a silent bypass.**

`ALTER TABLE users ENABLE ROW LEVEL SECURITY` without `FORCE` leaves the table *owner* bypassing RLS. As long as the app connects as `boardly_app_user` (a member of `boardly_app`, NOT the owner), RLS applies — the design is correct today. The silent-bypass surface opens the day a future migration runs `ALTER TABLE users OWNER TO boardly_app` (a cargo-cult "fix the permission denied" change, or an owner reassignment during a refactor): the app role becomes the owner, the owner bypasses RLS, and every cross-tenant `SELECT` returns all rows — with no error, no log, no alarm. The symptom is "RLS is enabled in `\d+ users` (`Row Security: yes`) but the cross-tenant leak still happens in the bug-tracker." The diagnosis: `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('users','projects','tasks','comments','memberships');` — BOTH columns must be `t`; a `t`/`f` row is `ENABLE`d but not `FORCE`d and is the silent-bypass candidate. `FORCE ROW LEVEL SECURITY` is the defence-in-depth that makes the bypass require a second, deliberate `ALTER TABLE ... NO FORCE` — not just an owner change. Cross-link to [[09-Alembic-Migrations/Data-Migrations-Safely]] for the owner-change-as-bypass-vector pattern.


### Lines 69–84: Per-table RLS policies

```sql
CREATE POLICY users_org_isolation ON users
 FOR ALL
 USING (organization_id = current_setting('app.organization_id', true)::uuid)
 WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);
```

**What this does:** Defines an RLS policy on `users` that filters every row by whether `organization_id` matches the session's `app.organization_id` setting.

**What each clause means:**

- `FOR ALL` — the policy applies to all commands (`SELECT`, `INSERT`, `UPDATE`, `DELETE`). Per-command alternatives: `FOR SELECT`, `FOR INSERT`, `FOR UPDATE`, `FOR DELETE`.
- `USING (...)` — the predicate for *existing-row visibility*. `SELECT`, `UPDATE`, `DELETE` rows must satisfy this to be seen. PostgreSQL rewrites `SELECT * FROM users` as `SELECT * FROM users WHERE organization_id = current_setting('app.organization_id', true)::uuid`.
- `WITH CHECK (...)` — the predicate for *new-row validity*. `INSERT` and `UPDATE` (of new values) rows must satisfy this to be written. If `WITH CHECK` is omitted, `USING` is used for both.

**The second argument to `current_setting`**

`current_setting('app.organization_id', true)` — the second argument (`missing_ok`) is `true`, meaning "return NULL if the setting is unset" instead of raising an error. If `app.organization_id` is unset, the policy becomes `organization_id = NULL::uuid`, which matches nothing. The result: a connection that forgot to `SET LOCAL app.organization_id` sees zero rows. Safe by default.


**Warning — When this breaks: the NULL-cast policy returns zero rows, but only on unset GUCs.**

The `missing_ok = true` second argument is the safety default — an unset GUC returns zero rows instead of leaking all rows — but it is also the most confusing failure mode in the lesson. A connection that forgot to `SET LOCAL app.organization_id` sees zero rows on every tenant-scoped table, with no error, no exception, no log. The developer's first instinct is "the query is wrong" or "the data is missing"; the actual cause is that `app.organization_id` was never set on this connection (a missing `await session.execute(text("SET LOCAL ..."))` in the `get_session` dependency, a background task with no request context, a test fixture that opened a raw `psql` session). The diagnosis is one line: `SELECT current_setting('app.organization_id', true);` — `NULL` is the smoking gun, a UUID means the GUC is set and the problem is elsewhere. The fix is the per-request `SET LOCAL` in the session dependency, never a session-scoped `SET` (see Mistake 7 below for the leak that the session-scoped version causes). The `missing_ok = true` is a safety net, not an excuse to skip the `SET LOCAL` — every code path that opens a transaction on a tenant-scoped table must set the GUC explicitly.


### Lines 87–97: The `tasks` policy with a subquery

```sql
CREATE POLICY tasks_org_isolation ON tasks
 FOR ALL
 USING (EXISTS (
 SELECT 1 FROM projects p
 WHERE p.id = tasks.project_id
 AND p.organization_id = current_setting('app.organization_id', true)::uuid))
 WITH CHECK (EXISTS (
 SELECT 1 FROM projects p
 WHERE p.id = tasks.project_id
 AND p.organization_id = current_setting('app.organization_id', true)::uuid));
```

**What this does:** Defines an RLS policy on `tasks` that filters by whether the task's *parent project* is in the current organization.

**Why a subquery:** `tasks` doesn't have an `organization_id` column (see Lesson 1's schema). It's scoped via its parent `project_id`. The policy uses an `EXISTS` subquery to check that the parent project's `organization_id` matches.

**The cost:** This adds a join to every `tasks` query. The RLS policy runs the subquery *per row*. For a query that returns 1000 tasks, that's 1000 subqueries — unless PostgreSQL optimizes it into a semi-join (which it usually does). Test on production-scale data; if the RLS overhead is too high, add a denormalized `tasks.organization_id` column (populated by a trigger from the parent project) and write a simpler policy.

**Tip — Denormalize for RLS performance if needed**

If your RLS policy requires a subquery, the planner adds a semi-join to every query. For high-volume tables, consider adding a redundant `organization_id` column (populated by a `BEFORE INSERT` trigger from the parent's `organization_id`) and writing a simple equality policy. The denormalization is a trade — storage for query speed — but it's often worth it for RLS.


**Production reality: the subquery policy is the RLS N+1.**

The `tasks_org_isolation` policy's `EXISTS (SELECT 1 FROM projects p WHERE p.id = tasks.project_id AND p.organization_id = current_setting(...))` re-evaluates for every candidate `tasks` row unless the planner flattens the `EXISTS` into a semi-join — which it usually can when stats are fresh and the policy is simple, and usually cannot when the policy joins multiple tables or uses a function. On a 1M-row `tasks` table, the un-flattened policy is a per-row subquery: the `EXPLAIN ANALYZE` shows a `SubPlan` node with `loops=1000000` and a per-loop cost that dominates execution. The symptom is "the `tasks` endpoint is 10x slower than the `projects` endpoint, and both have RLS." The fix is the denormalisation the tip above describes: add `tasks.organization_id` (populated by a `BEFORE INSERT` trigger from the parent project, kept in sync by a `BEFORE UPDATE` trigger if `project_id` can change), write the policy as `USING (organization_id = current_setting('app.organization_id', true)::uuid)`, and the per-row subquery becomes a per-row equality check. Measure with `EXPLAIN ANALYZE` before denormalising — RLS overhead is usually sub-millisecond, and the denormalisation is worth it only on hot paths over millions of rows. Cross-link to [[08-PostgreSQL/EXPLAIN-ANALYZE-and-Query-Plans]] for the `SubPlan`/`loops` diagnosis and [[13-Performance-and-Observability/N-plus-1-and-Slow-Queries]].


### Lines 110–111: Migrator bypasses RLS

```sql
ALTER ROLE boardly_migrator BYPASSRLS;
```

**What this does:** Grants `BYPASSRLS` to the migrator role.

**Why:** Migrations often need to read/write all rows regardless of RLS — for example, a backfill that updates every row, or a data migration that consolidates organizations. The migrator bypasses RLS to do this. The app role does *not* bypass — that's the whole point.

**Danger — Never grant `BYPASSRLS` to the application role**

`BYPASSRLS` defeats the entire RLS layer. The application role must never have it. The migrator has it because migrations are explicit, reviewed operations — not runtime queries. If the application needs to do something across organizations, use a `SECURITY DEFINER` function (next section), not `BYPASSRLS` on the app role.


**Danger — How an attacker thinks: the migrator's `BYPASSRLS` is a stolen-credential escalation ladder.**

`BYPASSRLS` on `boardly_migrator` means any connection authenticated as `boardly_migrator_login` reads and writes EVERY tenant's rows — every org, every user, every `hashed_password` column the app role's `SELECT` grant covers. If `boardly_migrator_login`'s password leaks (a CI secret in a log, a backup tape, a former engineer's laptop, an `ALTER ROLE` statement captured in `pg_stat_statements` text), the holder connects and bypasses the entire RLS layer in one statement. The defence in depth: (a) `boardly_migrator_login` is IP-restricted via `pg_hba.conf` to the migration host only — no `0.0.0.0/0` entry for the migrator role, ever; (b) the password lives in a secret manager (Vault, AWS Secrets Manager) with rotation and `VALID UNTIL` set on the role, so a leaked credential has a half-life; (c) `pg_stat_activity` is monitored for `boardly_migrator_login` connections outside a migration window — a migrator connection at 03:00 outside a deploy is an alert, not a log line. The asymmetry that makes this dangerous: the app role's blast radius is one tenant (RLS scopes it); the migrator's blast radius is the whole database (BYPASSRLS scopes nothing). `BYPASSRLS` magnifies any migrator-credential leak into a full-tenant breach. Cross-link to [[08-PostgreSQL/Backups-and-Recovery]] (the backup is the credential-leak vector — a stolen `pg_dump` of `pg_authid` leaks every password hash) and [[11-Authentication-and-Security/Password-Hashing]] (rotation discipline).


### Lines 114–137: The `SECURITY DEFINER` function

```sql
CREATE OR REPLACE FUNCTION admin_promote(p_user_id uuid, p_role user_role)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
 IF current_setting('app.is_admin', true) IS DISTINCT FROM 'true' THEN
 RAISE EXCEPTION 'admin only';
 END IF;

 UPDATE users SET role = p_role WHERE id = p_user_id;

 INSERT INTO audit_log (action, target_id, actor_id, payload)
 VALUES (
 'admin_promote',
 p_user_id,
 NULLIF(current_setting('app.actor_id', true), '')::uuid,
 jsonb_build_object('new_role', p_role::text)
 );
END;
$$;

REVOKE ALL ON FUNCTION admin_promote(uuid, user_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_promote(uuid, user_role) TO boardly_app;
```

**What this does:** Defines a `SECURITY DEFINER` function that lets the app role promote a user to a new role — an operation that *should* bypass RLS in a controlled way.

**Why `SECURITY DEFINER`:** The function runs with the *owner's* privileges, not the caller's. The owner is the migrator (which created the function). The migrator bypasses RLS. So the function can `UPDATE memberships SET role = ...` across all organizations — which the calling `boardly_app_user` could not do directly (RLS would scope it to the caller's organization).

**Why this is safe despite the privilege escalation:**

1. **The function checks `app.is_admin` before doing anything.** The caller must set this in their session — typically the application sets it after verifying the requesting user is an admin. If not set, the function raises `'admin only'`.
2. **The function writes to `audit_log` with the actor's ID.** Every privileged operation is logged.
3. **The function takes arguments and uses them as parameters, not string interpolation.** No SQL injection.
4. **`search_path` is pinned** to `public, pg_temp`. (See the warning below.)
5. **`EXECUTE` is revoked from `PUBLIC` and granted only to `boardly_app`.** Only the app role can call it.

**Danger — Pin `search_path` on every `SECURITY DEFINER` function**

Without `SET search_path = public, pg_temp` (or just `public`), the function uses the caller's `search_path`. A caller with `CREATE` on a schema can create a function with the same name as one the `SECURITY DEFINER` function calls internally, and the caller's version runs *with the function owner's privileges*. This is "search-path injection" — one of the most reproduced PostgreSQL CVE classes.
The fix: `SET search_path` on the function. This is non-negotiable for every `SECURITY DEFINER` function. The `pg_temp` suffix lets the function use temp tables if needed; if you don't need them, omit it.


**Student asks: when do I use a `SECURITY DEFINER` function vs an application-layer RBAC check?**

Use a `SECURITY DEFINER` function when the privileged operation *must run inside the same transaction as the caller's other writes* — e.g., the `admin_promote` step that writes to `audit_log` in the same transaction as the `UPDATE users`. If you instead did "verify in app, then run a separate admin query with a connection that has `BYPASSRLS`," you would either split the transaction (the audit log and the update can be on different connections and drift) or hand out `BYPASSRLS` to the application role (which we just told you never to do). Use application-layer RBAC ([[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]]) when the check is *only* a check (does this user have permission to call this endpoint at all?) and does not need to escalate inside the database. The two patterns compose: app-layer RBAC decides whether the request reaches the function; the `SECURITY DEFINER` function decides what the database does once it gets there.


**Spot the bug — what if `app.is_admin` is set by the application but the calling user is not actually an admin?**

The function trusts the session's `app.is_admin` setting. If the application sets this incorrectly (a bug), a non-admin user could call the function and it would succeed. The defense in depth is: the application sets `app.is_admin = 'true'` only after verifying the requesting user's role from the database. The function itself cannot verify the requesting user — it doesn't know who they are. The application is the source of truth for "is this user an admin" — and the function is the gate that ensures only `app.is_admin='true'` sessions can do the operation. If the application has a bug, the audit log catches it. There is no better trade-off in the database layer alone; application-layer RBAC ([[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]]) is the partner control.


**Danger — How an attacker thinks: the `app.is_admin` GUC is a trust boundary, not an auth check.**

The function's `IF current_setting('app.is_admin', true) IS DISTINCT FROM 'true' THEN RAISE` is a gate on a session variable, not on the requester's identity. An attacker who can issue `SET LOCAL app.is_admin = 'true'` on a pooled connection — a SQL-injection that runs `SET LOCAL` before the `SELECT admin_promote(...)`, a misrouted admin endpoint that sets the GUC for a non-admin user, a test fixture that sets it globally and leaks into a shared connection — calls `admin_promote` and the function obliges, because the function has no way to ask "who are you?" The defence in depth the application owes the function: only the `get_session` dependency sets `app.is_admin = 'true'`, and only after a database lookup of the requester's `membership.role` for the current `app.organization_id`; the GUC is never set from a request body, a query parameter, or a JWT claim without the DB lookup. The audit log is the post-hoc detection layer (the `actor_id` GUC is written to `audit_log`), not prevention — if the audit log shows an `admin_promote` whose `actor_id` is not an admin in that org, the trust boundary was crossed and the credential that issued the GUC must be revoked. The database-layer rule: a GUC is a flag the application raises; the function trusts the flag; the application owns the verification that earned the flag. There is no way for the function to verify the requester without the application telling it who the requester is — the `actor_id` GUC is the application's signed assertion, and a forged assertion is the escalation. Cross-link to [[11-Authentication-and-Security/RBAC-and-Object-Level-Auth]] for the app-layer gate and [[11-Authentication-and-Security/Threat-Model-First]].


## Execution Trace

What happens per request when the application connects as `boardly_app_user` and queries with RLS.

```python
# In the FastAPI handler (pseudocode — see Section 07 for the real SQLAlchemy version)
async with session.begin():
 # 1. Set the per-request tenant context (transaction-scoped)
 await session.execute(text("SET LOCAL app.organization_id = :tid"), {"tid": organization_id})
 await session.execute(text("SET LOCAL app.actor_id = :aid"), {"aid": actor_id})
 if is_admin:
 await session.execute(text("SET LOCAL app.is_admin = 'true'"))

 # 2. Query — RLS silently filters by organization_id
 result = await session.execute(select(User).where(User.email == email))
 # Under the hood: SELECT * FROM users WHERE email = ? AND organization_id = ?

 # 3. Commit — SET LOCAL reset; next request starts fresh
```

```mermaid
sequenceDiagram
 participant App as Application
 participant Pool as Conn Pool (boardly_app_user)
 participant Pg as PostgreSQL
 participant RLS as RLS Engine
 participant Table as users table

 Note over Pool: Connections authenticated as boardly_app_user<br/>(member of boardly_app, no BYPASSRLS)

 App->>Pool: open txn
 App->>Pg: SET LOCAL app.organization_id = '6c7d...'
 App->>Pg: SELECT * FROM users WHERE email='alice@...'
 Pg->>RLS: rewrite: add organization_id=current_setting('app.organization_id')
 RLS->>Table: SELECT * FROM users WHERE email='...' AND organization_id='6c7d...'
 Table-->>RLS: rows for current tenant only
 RLS-->>Pg: filtered rows
 Pg-->>App: rows (no cross-tenant leak)

 App->>Pg: COMMIT
 Note over Pg: SET LOCAL reset at COMMIT<br/>Next request starts with no organization_id

```

**You just locked down a real multi-tenant database.**

The application connects as `boardly_app_user`, which has DML privileges on existing tables and nothing else. RLS silently scopes every query to the current tenant. A SQL injection that slips through parameter binding can `SELECT` and `UPDATE` rows in the current tenant — but cannot `DROP TABLE`, cannot read another tenant's data, and cannot escalate privileges. That is the second half of defense in depth.


## Common Mistakes

### Mistake 1: Using `SUPERUSER` as the application role

```sql
-- WRONG (in production)
CREATE ROLE boardly_app_user LOGIN SUPERUSER PASSWORD '...';
```

**Symptom:** A bug in the application, or an injection, can do anything — `DROP DATABASE`, read any tenant's data, escalate privileges.

**Why:** `SUPERUSER` bypasses all checks — RLS, GRANT, even `BYPASSRLS`. The application role should never be `SUPERUSER`, never `BYPASSRLS`, never own the schema.

**Fix:** Use the role hierarchy from this lesson. App role has DML only. Migrator has DDL. Neither is `SUPERUSER`.

### Mistake 2: `GRANT ALL ON DATABASE ... TO PUBLIC`

```sql
-- WRONG
GRANT ALL ON DATABASE academy TO PUBLIC;
```

**Symptom:** Any role you create — including a one-off role for a contractor — can connect, create schemas, create tables in `public`, and (if it has `CREATE`) define malicious functions.

**Why:** `PUBLIC` includes every role. `GRANT ALL` includes `CREATE`. A `PUBLIC` grant on a database is the broadest possible grant.

**Fix:** `REVOKE ALL ON DATABASE academy FROM PUBLIC; GRANT CONNECT ON DATABASE academy TO boardly_app, boardly_app_readonly;`

### Mistake 3: Defaulting `EXECUTE` to `PUBLIC` on `SECURITY DEFINER` functions

```sql
-- WRONG
CREATE FUNCTION admin_promote(...) RETURNS void
SECURITY DEFINER AS $$ ... $$;
-- No REVOKE; PUBLIC EXECUTE remains.
```

**Symptom:** Any role in the database can call the privileged function. A low-privilege role you created for a one-off task can promote users.

**Why:** Every function has `EXECUTE` granted to `PUBLIC` by default.

**Fix:** `REVOKE ALL ON FUNCTION admin_promote(uuid, user_role) FROM PUBLIC; GRANT EXECUTE ON FUNCTION admin_promote(uuid, user_role) TO boardly_app;`

### Mistake 4: Forgetting `SET search_path` on `SECURITY DEFINER`

```sql
-- WRONG (CVE class)
CREATE FUNCTION admin_promote(...) RETURNS void
SECURITY DEFINER AS $$ ... $$;
-- No SET search_path.
```

**Symptom:** A caller with `CREATE` on a schema creates a function named `audit_log_insert` (or whatever your function calls internally), and the caller's version runs with the `SECURITY DEFINER` function's owner privileges.

**Why:** PostgreSQL resolves unqualified function names by walking the `search_path`. The caller's `search_path` is in effect. A malicious caller can shadow a function call.

**Fix:** `SET search_path = public, pg_temp` (or just `public`) on every `SECURITY DEFINER` function. This pins the search_path for the function's execution.

### Mistake 5: `FORCE ROW LEVEL SECURITY` off for owners

```sql
-- WRONG (the owner bypasses RLS)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
-- No FORCE; the owner (boardly_migrator) bypasses RLS.
-- And if you accidentally make the app role the owner, the app bypasses too.
```

**Symptom:** A future migration that changes the table owner (or a mistake in `ALTER TABLE`) leaves the app role as the owner, and RLS is silently bypassed.

**Why:** By default, the table owner bypasses RLS. This is intended for the migrator (which needs to read/write all rows). But if the app role *is* the owner, you've lost the RLS protection.

**Fix:** `FORCE ROW LEVEL SECURITY` on every tenant-scoped table. The owner (migrator) is then subject to RLS — give the migrator `BYPASSRLS` for migrations, but the app role never owns the table.

### Mistake 6: Forgetting sequence grants

```sql
-- WRONG
GRANT INSERT ON users TO boardly_app;
-- No GRANT USAGE, SELECT ON SEQUENCES.
```

**Symptom:** The application's first `INSERT` into `users` fails with `permission denied for sequence users_id_seq`.

**Why:** A `SERIAL` column's sequence is a separate object. The `GRANT INSERT` on the table doesn't grant `USAGE` on the sequence. (For `IDENTITY` columns, the implicit sequence is owned by the column and table grants cover it — but for legacy `SERIAL` columns, you need the separate grant.)

**Fix:** `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO boardly_app;` (or use `IDENTITY` columns and skip this entirely).

### Mistake 7: `SET app.organization_id` instead of `SET LOCAL`

```sql
-- WRONG (on a pooled connection)
SET app.organization_id = '6c7d...';
-- ... query ...
COMMIT;
-- Next request, same connection: app.organization_id is STILL '6c7d...'
```

**Symptom:** A pooled connection leaks the tenant context to the next request. Request B sees request A's tenant data.

**Why:** `SET` is session-scoped. It persists until `RESET` or connection close. On a pooled connection, the session is reused — the `SET` leaks.

**Fix:** `SET LOCAL app.organization_id = '...'` — transaction-scoped. Resets at `COMMIT` or `ROLLBACK`. Always use `SET LOCAL` for per-request context.

**Warning — When this breaks: the `SET`-leak is a cross-tenant data exposure, not a performance bug.**

A pooled connection that ran `SET app.organization_id = 'tenantA'` and committed retains the GUC for the session; the next request on the same connection sets `SET LOCAL app.organization_id = 'tenantB'` — but `SET` (session-scoped) overrides `SET LOCAL` (transaction-scoped) for the session, so the second request sees tenant A's rows, not tenant B's. The symptom is the most severe in this lesson: "user B intermittently sees user A's data," reproducible only when the pool hands the same connection to two sequential requests for different tenants — which passes in testing (one connection, one tenant) and surfaces in production (many connections, many tenants). The diagnosis: `SELECT current_setting('app.organization_id');` on a connection that should have no tenant set — a non-NULL value is the leak. The fix is `SET LOCAL` exclusively for tenant GUCs, plus a `RESET app.organization_id; RESET app.actor_id; RESET app.is_admin;` in the connection-return path (the `get_session` dependency's `finally` block) so a forgotten `SET` or a future `SET`-using code path is cleaned up before the next request reuses the connection. The `SET`-leak is a data-exposure incident under GDPR the moment it crosses tenant boundaries — treat it as a P0, not a configuration nit. Cross-link to [[07-SQLAlchemy/07-Async-SQLAlchemy]] for the per-request GUC pattern and [[17-Advanced-Architecture/Multi-Tenancy]] for the tenant-identity discipline.


### Mistake 8: Granting `CREATE` on `public` to application roles

```sql
-- WRONG
GRANT CREATE ON SCHEMA public TO boardly_app;
```

**Symptom:** The app role can create tables — and a SQL injection can create a malicious `SECURITY DEFINER` function or a trigger that fires on every `INSERT`.

**Why:** `CREATE` on a schema is the broadest schema-level grant. The app role needs `USAGE` (to access objects); it does *not* need `CREATE`. Only the migrator needs `CREATE`.

**Fix:** `GRANT USAGE ON SCHEMA public TO boardly_app;` — never `CREATE` on the app role.

### Mistake 9: Confusing `INHERIT` and `NOINHERIT`

```sql
-- Footgun
CREATE ROLE boardly_app_user NOINHERIT LOGIN IN ROLE boardly_app;
-- Now boardly_app_user does NOT inherit boardly_app's privileges.
-- Every query fails with "permission denied" until you SET ROLE boardly_app.
```

**Symptom:** The application connects as `boardly_app_user` and every query fails with `permission denied for table ...`.

**Why:** `NOINHERIT` means the role does *not* automatically use the privileges of roles it's a member of. You must `SET ROLE boardly_app` to assume those privileges. `INHERIT` is the default — and the right choice for application login roles.

**Fix:** Use `INHERIT` (the default). Use `NOINHERIT` only for break-glass roles that require explicit `SET ROLE` to assume privileges — useful for audit but a footgun if unexpected.

## Engineering Trade-Offs

### `SECURITY DEFINER` vs application-layer checks

- **`SECURITY DEFINER`** — centralizes the privileged operation in the database. The application never holds the underlying privilege. Strong for audit and consistency. Harder to test.
- **Application-layer checks** — the application verifies the user is an admin, then performs the operation as the app role (which has the needed privilege). Easier to test and instrument. Requires the app role to hold the privilege — broader blast radius.

The rule: use `SECURITY DEFINER` for cross-cutting privileged operations (admin actions, audit writes, cross-tenant moves). Use application checks for ordinary request validation.

**Production reality: the `SECURITY DEFINER` function is a deployment-order coupling.**

The `CREATE OR REPLACE FUNCTION admin_promote ...` and its `REVOKE ALL ON FUNCTION ... FROM PUBLIC; GRANT EXECUTE ... TO boardly_app;` are three statements that must ship together — the function definition, the REVOKE, and the GRANT. A two-wave rolling update that deploys the function in wave 1 and the REVOKE/GRANT in wave 2 leaves a window where every role in the database can call the privileged function (the `PUBLIC EXECUTE` default from the `**Example —**` above is in effect until the REVOKE lands). The CI gate that prevents this: the `CREATE OR REPLACE FUNCTION`, the `REVOKE`, and the `GRANT` must be in the *same* Alembic migration file, not split across revisions — `alembic upgrade head` is atomic per revision, and a revision that ships the function without the REVOKE is the window. The audit grep is `rg -l "SECURITY DEFINER" alembic/versions/ | xargs -I{} rg -L "REVOKE.*FROM PUBLIC" {}` — every migration file with a `SECURITY DEFINER` that lacks a `REVOKE ... FROM PUBLIC` is the window candidate. The same coupling hits the `search_path` pin and the `admin_promote` body's `app.is_admin` check: the function is a contract between the database (the privileged operation) and the application (the GUC it sets), and the contract's terms must ship in one revision. Cross-link to [[09-Alembic-Migrations/Data-Migrations-Safely]] for the atomic-migration discipline and [[16-Deployment-and-DevOps/Migration-Ordering-and-Rollback]].


### RLS vs explicit `WHERE organization_id = ?`

- **RLS** — the last line of defense. The database enforces it; the application can't forget. Adds a per-query rewrite; can be slow with subquery policies.
- **Explicit `WHERE`** — the application writes the predicate. Faster (no RLS overhead). Subject to "forgot the WHERE" bugs.

The rule: both. RLS for safety, explicit `WHERE` for clarity and performance. Defense in depth.

### One pool role vs many per-tenant roles

- **One role + `SET LOCAL app.organization_id`** — scales better. The pool reuses connections across organizations; the per-request `SET LOCAL` distinguishes them.
- **Per-organization roles** — each organization has its own login role. Connection pool per organization. Stronger isolation but unworkable at scale (10K organizations = 10K roles, 10K pools).

The rule: one role + `SET LOCAL` for SaaS. Per-organization roles only for organizations with truly different privilege sets (e.g., enterprise customers with custom compliance requirements).

### `BYPASSRLS` for migrations

- **`BYPASSRLS` on the migrator** — clean. Migrations read/write all rows. The migrator never runs application queries.
- **`NO BYPASSRLS` everywhere** — stronger safety. Migrations must explicitly `SET ROLE` to a `BYPASSRLS` role, or be written to work within RLS. Awkward for backfills.

The rule: `BYPASSRLS` on the migrator. Never on the app role.

### Connection limit vs pool size

- **`CONNECTION LIMIT = pool_size + reserve`** — the pool can fill without hitting the limit; reserve for migrations and admin queries.
- **`CONNECTION LIMIT = pool_size`** — migrations and admin queries are blocked when the pool is full.

The rule: `CONNECTION LIMIT = pool_size + 10`. Monitor `pg_stat_activity` for `IdleInTransaction` connections that consume the budget without doing work.

**Student asks: what is the per-query overhead of RLS, and when does it matter?**

Two costs, both measurable. **(1) Per-query rewrite.** RLS rewrites every query against an RLS-enabled table to add the policy predicate. The rewrite is a parse-tree transformation that happens once per prepared statement, not per row. On a prepared, cached plan the cost is zero; on a fresh statement the cost is microseconds — invisible under any realistic workload. **(2) Per-row evaluation.** A *subquery policy* like the one on `tasks` (which scopes via `EXISTS (SELECT 1 FROM projects WHERE ... AND organization_id = current_setting(...))`) re-runs the subquery for each candidate row unless the planner can flatten it. The planner usually can — it pulls the subquery into a JOIN and reuses the result for the whole scan — but on complex policies it cannot, and you get an O(N) subquery execution. The diagnostic: `EXPLAIN ANALYZE` shows a `SubPlan` or `InitPlan` node with `loops=N` and per-loop time. If the per-loop time × loops is more than 1% of execution time, the policy is on the critical path. The fixes, in order of cost: (a) `ANALYZE` the table — the planner may flatten once stats are fresh; (b) rewrite the policy as a non-subquery policy (store the tenant_id directly on the child table, so the policy is a simple `WHERE organization_id = current_setting(...)`); (c) add an index on the tenant column; (d) accept the cost (RLS is paying for itself in safety). The general rule: measure first; RLS overhead is almost always sub-millisecond, and only matters on hot paths over millions of rows.


## Exercises

**Tip — The 20-minute rule**

If you're stuck for more than 20 minutes, re-read the relevant section, then move on.


**Exercise 1 — Create the role hierarchy.** Run `boardly_security.sql` against the schema from Lesson 1. Inspect with `\du` (list roles) and `\dp users` (table privileges). Confirm the three group roles, the three login roles, and the table grants.

**Exercise 2 — Verify least privilege.** Connect as `boardly_app_user` (use `psql "postgresql://boardly_app_user:replace-with-a-real-secret@localhost/academy"`). Try `SELECT * FROM users;` (should succeed — but return zero rows until you `SET LOCAL app.organization_id`). Try `DROP TABLE users;` (should fail with `permission denied`). Try `CREATE TABLE foo (id int);` (should fail).

**Exercise 3 — Verify RLS.** Connect as `boardly_app_user`. Insert a tenant and a user (you'll need to `SET LOCAL app.organization_id` first — RLS requires it). Query `SELECT * FROM users;` — confirm only your tenant's rows. `SET LOCAL app.organization_id` to a different UUID — confirm zero rows.

**Exercise 4 — Test the SECURITY DEFINER function.** Connect as `boardly_app_user`. Set `app.organization_id` and `app.is_admin = 'true'`. Call `SELECT admin_promote('...', 'admin');`. Confirm the user's role changed and an audit_log row was inserted. Try calling without `app.is_admin = 'true'` — should raise `'admin only'`.

**Exercise 5 — Spot the bug.** This function is unsafe. Identify two problems.

```sql
CREATE FUNCTION transfer_credits(p_from uuid, p_to uuid, p_amount int)
RETURNS void
SECURITY DEFINER
LANGUAGE plpgsql AS $$
BEGIN
 UPDATE accounts SET balance = balance - p_amount WHERE id = p_from;
 UPDATE accounts SET balance = balance + p_amount WHERE id = p_to;
END;
$$;
```

(Answers: (1) No `SET search_path` — search-path injection possible. (2) No `REVOKE FROM PUBLIC` — any role can call. Also: no audit log write, no check that `p_from` and `p_to` are in the caller's tenant — but those are operational issues, not CVE classes.)

**Exercise 6 — Connection limit test.** Open 51 connections as `boardly_app_user` (use a small script with `psql` in 51 terminals, or a Python loop). The 51st should fail with `too many connections for role "boardly_app_user"`. Close one. The next should succeed.

**Exercise 7 — Defense-in-depth audit.** Take a `boardly_app_user` session that has `app.organization_id` set to tenant A. Attempt each of the four "leak vectors" below and confirm the database refuses each one at a *different* layer of the defense. (a) SQL-injection attempt: `SELECT * FROM users WHERE email = '' OR '' = ''` — should return only tenant A's rows (RLS, layer 4). (b) Cross-tenant INSERT: `SET LOCAL app.organization_id` to tenant A and insert a user with `home_org_id` set to tenant B — should fail at the `WITH CHECK` policy (RLS write-side, layer 4). (c) DDL attempt: `CREATE TABLE evil (id int)` — should fail with `permission denied` (least privilege, layer 2). (d) Privileged function call without `app.is_admin`: `SELECT admin_promote(...)` — should raise `'admin only'` (the `SECURITY DEFINER` body, layer 5). For each attempt, name the layer that stopped it. The exercise demonstrates the lesson's mental model: every layer assumes the layer above has failed.

**Exercise 8 — Audit every `SECURITY DEFINER` function for a `REVOKE`.** Run the catalog probe an attacker would run first: `SELECT proname, prosecdef, proowner::regrole FROM pg_proc WHERE prosecdef AND pronamespace = 'public'::regnamespace;` then, for each hit, `SELECT has_function_privilege('boardly_analytics_user', proname::text, 'EXECUTE') FROM pg_proc WHERE proname = '<fn>';`. Write a `pytest` test (using a `psycopg` connection fixture) that asserts `has_function_privilege('boardly_analytics_user', proname::text, 'EXECUTE')` returns `false` for every row in the `SECURITY DEFINER` set — i.e. the read-only role cannot call any privileged function. Verify: `uv run pytest tests/test_definer_public_revoke.py -k no_public_execute_on_definer`.

**Exercise 9 — Reproduce the `SET`-leak.** Open a `psql` session as `boardly_app_user`, run `BEGIN; SET app.organization_id = '6c7d-...'; SELECT count(*) FROM users; COMMIT;` and confirm the count is tenant A's rows. Then, on the *same* session, run `SELECT current_setting('app.organization_id');` — confirm it still returns tenant A's UUID (the `SET` leaked past the `COMMIT`). Now `RESET app.organization_id;` and confirm the count returns 0. Repeat the whole flow with `SET LOCAL` in place of `SET` and confirm the GUC is NULL after the `COMMIT`. Verify: `psql "$BOARDLY_DSN" -v ON_ERROR_STOP=1 -c "BEGIN; SET app.organization_id='6c7d-8e9f-...'; SELECT count(*) FROM users; COMMIT;" -c "SELECT current_setting('app.organization_id', true);"` (first command shows the tenant count; second returns the leaked UUID with `SET`, or NULL with `SET LOCAL`).

**Exercise 10 — The partition-owner footgun.** As `postgres`, run `CREATE TABLE events_2026_11 PARTITION OF events FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');` then connect as `boardly_app_user` and `SELECT count(*) FROM events_2026_11;` — confirm `ERROR: permission denied for table events_2026_11` (the `ALTER DEFAULT PRIVILEGES FOR ROLE boardly_migrator` did not fire because `postgres` created the partition). `DROP` the partition, reconnect as `boardly_migrator_login`, recreate it, and confirm `boardly_app_user` can now `SELECT` from it. Verify: `psql postgresql://boardly_app_user:...@localhost/academy -c "SELECT count(*) FROM events_2026_11;"` returns the row count after the migrator-owned recreate (and the audit query `SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname='events_2026_11';` returns `boardly_migrator`).

**Exercise 11 — The `IdleInTransaction` drain.** Write a Python loop that opens 50 connections as `boardly_app_user` (using `psycopg` or `asyncpg`), issues `BEGIN;` on each, and sleeps. Confirm the 51st connection fails with `FATAL: too many connections for role "boardly_app_user"`. Then run `SELECT state, count(*) FROM pg_stat_activity WHERE usename='boardly_app_user' GROUP BY state;` and confirm 50 rows in the `idle in transaction` state. Close one connection; confirm the next connect succeeds. Verify: `uv run python scripts/conn_budget_drain.py --count 50 --hold && psql "$BOARDLY_DSN" -c "SELECT state, count(*) FROM pg_stat_activity WHERE usename='boardly_app_user' GROUP BY state;"` (the script prints the 51st-connection failure; the `pg_stat_activity` query shows 50 `idle in transaction`).

**Exercise 12 — RLS subquery-policy overhead.** Seed a `tasks` table with 100k rows scoped across 10 projects (one org). Capture the baseline plan: `EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM tasks WHERE project_id = '<id>';` and note the `SubPlan` node with `loops=N` and its per-loop cost. Then denormalise: `ALTER TABLE tasks ADD COLUMN organization_id uuid; UPDATE tasks t SET organization_id = p.organization_id FROM projects p WHERE p.id = t.project_id; CREATE INDEX ON tasks (organization_id);` and rewrite the `tasks_org_isolation` policy as `USING (organization_id = current_setting('app.organization_id', true)::uuid)`. Re-run the `EXPLAIN (ANALYZE)` and confirm the `SubPlan` node is gone. Verify: `psql "$BOARDLY_DSN" -c "EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM tasks WHERE project_id = '<id>';" | grep -c SubPlan` returns 0 after the denormalisation (and the per-loop cost line is absent from the plan).

**Exercise 13 — The defense-in-depth audit at the role level.** Connect as `boardly_analytics_user` (the read-only role). Attempt (a) `SELECT admin_promote('99999999-ffff-ffff-ffff-ffffffffffff', 'admin');` — should fail with `ERROR: permission denied for function admin_promote` (the `REVOKE FROM PUBLIC` + `GRANT EXECUTE TO boardly_app` stopped the read-only role; the function's `app.is_admin` check never ran because `EXECUTE` was denied at the role layer). Attempt (b) `SET LOCAL app.is_admin='true'; SELECT admin_promote(...);` — should STILL fail with `permission denied for function` (setting the GUC does not help, because `EXECUTE` was never granted to `boardly_app_readonly`). Confirm the role layer (layer 2) stopped the call *before* the function body's `app.is_admin` check (layer 5) — the two layers are independent and the role layer is the outer one. Verify: `psql postgresql://boardly_analytics_user:...@localhost/academy -c "SET LOCAL app.is_admin='true'; SELECT admin_promote('99999999-ffff-ffff-ffff-ffffffffffff', 'admin');"` returns `ERROR: permission denied for function admin_promote`.

## Verification

```sql
-- 1. What privileges does a role have?
SELECT grantee, table_schema, table_name, privilege_type
FROM information_schema.table_privileges
WHERE grantee IN ('boardly_app', 'boardly_app_readonly')
ORDER BY grantee, table_schema, table_name, privilege_type;

-- 2. What roles exist?
SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolconnlimit
FROM pg_roles
WHERE rolname LIKE 'boardly%'
ORDER BY rolname;

-- 3. Is RLS enabled? Is it forced?
SELECT relname, relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE relname IN ('users','projects','tasks','comments','memberships');

-- 4. What policies apply to a table?
SELECT polname, polcmd, polqual, polwithcheck
FROM pg_policy
WHERE polrelid = 'users'::regclass;

-- 5. Who am I, and what's my effective tenant?
SELECT current_user, current_setting('app.organization_id', true);

-- 6. Default privileges for future objects?
SELECT pg_get_userbyid(defaclrole) AS creator,
 nspname AS schema,
 defaclacl AS acl
FROM pg_default_acl a
JOIN pg_namespace n ON n.oid = defaclnamespace
ORDER BY 1, 2;
```

```bash
psql "postgresql://boardly_app_user:replace-with-a-real-secret@localhost/academy" -c "\dp users"
psql "postgresql://boardly_app_user:replace-with-a-real-secret@localhost/academy" -c "SET app.organization_id='6c7d-...'; SELECT * FROM users;"
psql "postgresql://boardly_migrator_login:replace-with-a-third-secret@localhost/academy" -c "DROP TABLE users;" # Should succeed (migrator has DDL).
```

For Exercise 7 (the defense-in-depth audit), the expected refusals:

```bash
PSQL="psql postgresql://boardly_app_user:replace-with-a-real-secret@localhost/academy -v ON_ERROR_STOP=0"

# (a) SQL-injection attempt — RLS layer should bound the result to the current tenant only
$PSQL -c "SET app.organization_id='6c7d-...'; SELECT count(*) FROM users WHERE email = '' OR '' = '';"
# expected: count matches ONLY tenant 6c7d-...'s rows (not the whole table)

# (b) Cross-tenant INSERT — WITH CHECK policy should raise
$PSQL -c "SET app.organization_id='6c7d-...'; INSERT INTO users (id, email, home_org_id) VALUES (gen_random_uuid(), 'evil@x.test', '99999999-ffff-ffff-ffff-ffffffffffff');"
# expected: ERROR:  new row for relation "users" violates row-level security policy

# (c) DDL attempt — least-privilege role lacks CREATE on the schema
$PSQL -c "CREATE TABLE evil (id int);"
# expected: ERROR:  permission denied for schema public

# (d) Privileged function call without app.is_admin — SECURITY DEFINER body should raise
$PSQL -c "SET app.organization_id='6c7d-...'; SELECT admin_promote('99999999-ffff-ffff-ffff-ffffffffffff', 'admin');"
# expected: ERROR:  admin only
```

If any of the four attempts *succeeds* where it should refuse, you have a defense-in-depth gap — name the layer that should have stopped it (RLS read-side / RLS write-side `WITH CHECK` / least-privilege GRANT / `SECURITY DEFINER` body) and fix it before merging the change. The Multi-Tenancy architectural pattern that sits on top of these primitives is the canonical [[17-Advanced-Architecture/Multi-Tenancy]] lesson.

## Previously Learned Here

These concepts were taught in earlier lessons. We link back instead of re-explaining:

- **`SQL injection`** — [[06-SQL-Fundamentals/SQL-Injection-and-Parameterized-Queries]]. Parameter binding is the first line of defense. Least privilege (this lesson) is the second. The canonical lesson covers injection classes and binding patterns.
- **`Relational model and constraints`** — [[06-SQL-Fundamentals/Relational-Model-and-Constraints]]. Constraints are the third layer of defense (the database refuses invalid data even if the application sends it).
- **`Transactions (SQL)`** — [[06-SQL-Fundamentals/Transactions-Isolation-Locks]]. `SET LOCAL` is transaction-scoped because of how transactions work. The canonical lesson covers `BEGIN`/`COMMIT` semantics; this lesson uses them for per-request GUC scoping.
- **The Boardly schema** — [[Types-UUID-Identity-JSONB]]. UUID PKs and tenant IDs combine with RLS for multi-tenant isolation.
- **`Connection pool (SQLAlchemy)`** — [[07-SQLAlchemy/02-Engines-Connections-Pools]] and **`Engine`** — the application's connection pool authenticates as `boardly_app_user`. The canonical lesson covers the pool side.
- **Async SQLAlchemy** — [[07-SQLAlchemy/07-Async-SQLAlchemy]]. The `SET LOCAL` pattern for per-request tenant context is the canonical reference for transaction-scoped GUCs on pooled connections.
- **Multi-tenancy (preview)** — [[17-Advanced-Architecture/Multi-Tenancy]]. RLS is the database-side primitive; the architectural pattern that sits on top (who sets `app.organization_id`, how the tenant is resolved from the JWT, what background jobs do without a request) is the canonical Multi-Tenancy lesson taught in Section 17. This lesson builds the language-level artifact (`CREATE POLICY ...`); Section 17 takes its existence as given and answers the architectural questions.

## What's Next

In [[Backups-and-Recovery]] we shift from "the database is safe from attackers" to "the database is safe from disasters." You'll:

- Choose between logical (`pg_dump`) and physical (`pg_basebackup` + WAL archive) backups for a given RTO/RPO.
- Use `pg_dump` formats (`-F p|c|d|t`) and `pg_restore` for selective restore.
- Configure continuous WAL archiving with `pg_basebackup` for a base backup.
- Perform point-in-time recovery (PITR) to a target time, XID, LSN, or named restore point.
- Explain what `fsync` and `synchronous_commit` mean for durability — and when (rarely) to relax them.
- Design a "test the backup" procedure that runs at least monthly.

By the end of Lesson 5, an untested backup will be a thing of the past. You will have a real backup-and-recovery script and a weekly restore drill.

## Sources

- PostgreSQL 17 — "Database Roles" — <https://www.postgresql.org/docs/17/user-manag.html> — accessed 2026-10-15 — Role attributes, membership, `INHERIT`/`NOINHERIT`, `CONNECTION LIMIT`.
- PostgreSQL 17 — "GRANT and REVOKE" — <https://www.postgresql.org/docs/17/sql-grant.html> — accessed 2026-10-15 — Privilege scope, `ALL TABLES IN SCHEMA`, default privileges, `PUBLIC`.
- PostgreSQL 17 — "ALTER DEFAULT PRIVILEGES" — <https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html> — accessed 2026-10-15 — Pre-emptive grant for future objects created by a role.
- PostgreSQL 17 — "Row Security Policies" — <https://www.postgresql.org/docs/17/ddl-rowsecurity.html> — accessed 2026-10-15 — `ENABLE`/`FORCE` RLS, `USING`/`WITH CHECK`, policy combination rules.
- PostgreSQL 17 — "SECURITY DEFINER" — <https://www.postgresql.org/docs/17/sql-createfunction.html> — accessed 2026-10-15 — `SECURITY DEFINER`/`INVOKER`, `search_path` security caveats, fixed `search_path` clause.
- PostgreSQL 17 — "Function Search Path" — <https://www.postgresql.org/docs/17/perm-functions.html> — accessed 2026-10-15 — The search-path injection attack class and the mitigation pattern.
- OWASP — "SQL Injection Prevention Cheat Sheet" — <https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html> — accessed 2026-10-15 — The least-privilege principle as a SQL-injection defense layer.

## What We Learned

Let's recap. In this lesson you:

- **Distinguished login roles from group roles** and designed a three-bundle hierarchy (`boardly_migrator`, `boardly_app`, `boardly_app_readonly`).
- **Applied `GRANT`/`REVOKE`** at the database, schema, table, column, sequence, and function level.
- **Set `ALTER DEFAULT PRIVILEGES`** so future tables created by the migrator get the right grants automatically.
- **Chose `SECURITY DEFINER` for a cross-tenant admin operation** with `app.is_admin` check, audit-log write, and pinned `search_path`.
- **Enabled RLS on every organization-scoped table** with per-table policies including a subquery policy on `tasks` (scoped via the parent project).
- **`FORCE`d RLS** on every tenant-scoped table and granted `BYPASSRLS` only to the migrator.
- **Set per-role connection limits** and reasoned about pool size vs `CONNECTION LIMIT`.
- **Used `SET LOCAL app.organization_id`** for per-request tenant context, and learned why `SET` (session-scoped) is a footgun on pooled connections.
- **Tightened `PUBLIC`** by revoking its default privileges on the schema and database.
- **Pinned `search_path`** on every `SECURITY DEFINER` function to prevent search-path injection.

Here's the mental model to walk away with: *the database is the last line of defense, not the first. Pydantic rejects bad input shapes. Parameterized queries reject SQL injection. Least-privilege roles bound what an injection can do. RLS bounds what a missing `WHERE` can leak. `SECURITY DEFINER` functions gate the privileged operations that must exist. Each layer assumes the layer above has failed — and bounds the blast radius when it does. No single layer is enough; together, they make the application defensible.*

---

> A note from your teacher
You just locked down a real multi-tenant database. The application connects as `boardly_app_user`, which can DML but cannot DDL. RLS silently scopes every query to the current tenant. A `SECURITY DEFINER` function lets the application do the one privileged operation it needs (admin promotion) without holding the underlying privilege. And every choice is defensible: each grant is a deliberate decision, each revoke is a posture. Lesson 5 is the last lesson of this section — backups and recovery. The untested backup is no backup. We'll fix that. See you in Lesson 5.


---

**Tags:** #postgresql #security #rls #least-privilege #access-control #review
**Previous:** [[EXPLAIN-ANALYZE-and-Query-Plans]]
**Next:** [[Backups-and-Recovery]] →

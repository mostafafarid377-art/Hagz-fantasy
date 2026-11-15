# Phase 2B.2 — Grants, default privileges and function security review

How new public tables are secured against unintended `anon`/`authenticated` access, how function `EXECUTE` is constrained, and how `SECURITY DEFINER` ownership is handled. **No Supabase project was contacted.**

## 1. The platform change that forced this review

The Phase 2B.1 package flagged Supabase's default grants as the highest-risk difference between the mock and a real project. That risk has since been resolved by Supabase itself, and the resolution changes what the migrations must do.

From the Supabase changelog [*Breaking Change: Tables not exposed to Data and GraphQL API automatically* (#45329)](https://github.com/orgs/supabase/discussions/45329):

- 2026-04-28 — opt-in toggle available at project creation.
- 2026-05-30 — became the default for **new** projects.
- **2026-10-30 — enforced on all existing projects.**

> "Once the change is rolled out to your project, new tables you create in `public` schema require an explicit opt-in (via a Postgres `grant`) before the Data API can see them."

The documented way to adopt it is exactly these statements:

```sql
alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;
```

And the CLI analogue is the config key:

```toml
[api]
auto_expose_new_tables = false
```

### Why this mattered for this repository

Migrations `001`–`008` were written against the **historical** permissive default: they revoke client DML on enumerated tables and then grant `SELECT` back. Under the historical default that is correct, but it silently depends on that default. Two concrete hazards existed:

1. A table not listed in the revoke loop would be granted `ALL` to `anon` and `authenticated` by default privileges.
2. Relying on the default for "deny" means the security posture is inherited, not declared, so it can change under the migration.

Phase 2B.2 removes the dependency in both directions: the config asserts the hardened default locally, and migration `009` asserts the privilege model explicitly so the result is the same whichever default the project carries.

## 2. Explicit securing of new public tables — `009_ownership_and_grants.sql`

The reviewed model is deliberately narrow:

| Role | Table privileges in `public` |
|---|---|
| `anon` | **none** — no table privilege at all |
| `authenticated` | `SELECT` only |
| `service_role` | none granted here; it bypasses RLS and must stay server-side and explicit |
| `ff_migration_owner` | none (non-login definer owner) |

`009` applies this in a single `DO` block over an explicit list of all 40 reviewed tables, in two passes:

1. `revoke all on public.<tbl> from public, anon, authenticated` — plus an explicit `revoke truncate, references, trigger`. `TRUNCATE` is not covered by RLS, so leaving it implicit would be a real hole that a "SELECT-only" claim would hide.
2. `grant select on public.<tbl> to authenticated` — the single client privilege the design intends.

The table list is written out longhand rather than derived, because a derived list silently skips a table that a later migration adds under a different default. `010` then independently asserts the end state, so a missing entry fails the deployment instead of passing quietly.

## 3. Function `EXECUTE` — closing the default-open path

Two separate defaults make new functions callable in ways the design does not intend:

- **Postgres itself** grants `EXECUTE` on a new function to `PUBLIC`.
- **Supabase's bootstrap** additionally runs `alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role`.

A `SECURITY DEFINER` function reachable by `anon` or `PUBLIC` is the standard privilege-escalation surface: the caller borrows the definer's rights. `009` closes it explicitly:

```sql
revoke execute on all functions in schema public    from public, anon, authenticated;
revoke execute on all functions in schema ff_private from public, anon, authenticated;
grant execute on function ff_private.is_member(uuid), ... , ff_private.is_match_organizer(uuid,uuid)
  to authenticated;
```

Only the **ten reviewed read helpers** are restored for `authenticated`. Every mutation workflow — `submit_lineup`, `submit_result`, `review_submission`, `fork_result`, `open_correction`, `open_correction_attempt`, `start_scoring`, `authorize_temporary`, and the roster/lineage triggers — stays unreachable from a client. That is unchanged from Phase 2A's fail-closed design and is re-asserted here rather than assumed.

`010` verifies, against the catalog:

- no `SECURITY DEFINER` function in `public`/`ff_private` is executable by `anon` or by `PUBLIC`;
- the set of functions executable by `authenticated` is **exactly** the ten read helpers;
- no `SECURITY DEFINER` function lacks a pinned `search_path`.

## 4. `SECURITY DEFINER` ownership

The design assumes the definer functions are owned by a role that is not reachable by clients and does not itself weaken the model. `009` creates that role explicitly:

```sql
create role ff_migration_owner nologin nobypassrls noinherit
  nosuperuser nocreatedb nocreaterole;
```

- **`nologin`** — it can never authenticate.
- **`nobypassrls`** — it is *subject* to RLS where RLS applies, so it cannot be used as a silent RLS bypass. (Table owners still bypass RLS by default; that is why ownership is asserted separately below rather than conflated with RLS.)
- **`noinherit`** — it inherits nothing it was not granted.
- Granted only `usage, create` on `public` and `usage` on `ff_private`, plus `execute` on `auth.uid()`.

`009` refuses to proceed if the owner has been granted to an API role, and `010` asserts `ff_migration_owner` is not a login role, does not have `BYPASSRLS`, and is not a member of (or a grantor to) `anon`, `authenticated`, `service_role` or `authenticator`.

### Deliberate limitation

`009` **creates** the least-privilege owner but does **not** yet `alter function ... owner to ff_migration_owner` on the 56 definer functions. That reassignment is a real, reviewable change with its own risk — it moves the definer context for every privileged path at once — and doing it without executing the workflow tests against the reassigned owner would be a guess. It is listed as a remaining blocker in the Phase 2B.2 report and proposed as the first task of Phase 2B.3, where the privileged paths are exercised. Until then, the functions are owned by the migrating role, which `010` allows.

## 5. Ordering interaction worth knowing

`009` revokes `SELECT` and re-grants it table by table. `010` asserts the result. `007`/`008` create their tables (`match_correction_attempts`, `match_result_forks`) and grant `SELECT` to `authenticated` themselves, and `009` re-asserts it for the same tables — intentional duplication so neither file depends on the other having run.

`010` also asserts that all four reviewed additions (`match_correction_attempts`, `match_result_forks`, `scoring_run_sources`, `match_corrections`) exist. This was not theoretical: during this phase `008` initially failed on a composite foreign key and `009`/`010` continued silently, and `010`'s new existence check is what surfaced it.

## 6. What is verified, and what is not

**Verified (local, disposable):**

- The full ten-migration chain applies on **PostgreSQL 17.6** in both a Supabase-like bootstrap (real `auth.uid()`, `storage` owned by `supabase_storage_admin`, `service_role` with `BYPASSRLS`) and the repository's mock `setup.sql`.
- End state after the chain: RLS on every `public` table, `anon` with zero table privileges, `authenticated` with `SELECT` only, ten executable read helpers, zero definer functions without a pinned `search_path`.
- The guard and assertion migrations fail closed when a prerequisite is missing.

**Not verified — no claim is made:**

- Actual Supabase role inheritance, default privileges, or the effect of `auto_expose_new_tables` on a real project.
- PostgREST exposure or RLS composition at request time.
- Whether the hosted migration role can run `alter default privileges for role postgres` (it is asserted defensively in a `DO` block filtered to roles that exist, but not exercised on the platform).
- Any behaviour of `service_role` at runtime.

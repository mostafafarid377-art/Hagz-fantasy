# Residual risk: `public.ff_league_archive(uuid)` is executable by the `anon` role

**Status: open · rating: LOW (fail-closed) with a MEDIUM systemic tail · fix prepared and rehearsed, not applied**
Reviewed 2026-11-18 against the live project (`ddeojemjbhnxtrgsuicv`, PostgreSQL 17.11)
and reproduced on the disposable rehearsal clone (`zkrfgdiujpagaddsxbcb`).
**Production permissions were not modified.** This document is a review, not a change.

---

## 1. What is actually granted

`public.ff_league_archive(uuid)` — the leader-only "delete league" RPC added by
migration 016 — carries an explicit `EXECUTE` grant for `anon`:

| Grantee | Privilege |
| --- | --- |
| `ff_migration_owner` (owner) | EXECUTE |
| **`anon`** | **EXECUTE** ← the finding |
| `authenticated` | EXECUTE |
| `service_role` | EXECUTE |

It is `SECURITY DEFINER` and owned by `ff_migration_owner`, so the grant lets an
unauthenticated caller **enter** a function that runs with the definer's rights.

It is also the **only** function in the project in this position:

| Count (live project) | Value |
| --- | --- |
| functions in `public` | 50 |
| `SECURITY DEFINER` functions in `public` | 50 |
| functions in `public` executable by `anon` | **1 — `ff_league_archive`** |
| functions in `ff_private` executable by `anon` | 0 |

## 2. Why it happened (root cause, verified)

Supabase sets **default privileges** for functions created by the `postgres` role in
`public`. `pg_default_acl` on the live project contains, for `defaclrole = postgres`,
`defaclnamespace = public`, `defaclobjtype = f` (function):

```
{postgres=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres}
```

So **every function created in `public` by `postgres` starts life executable by
`anon`**. `grant execute … to authenticated` is not what creates the exposure; it is
the default that nobody removed.

Every other migration in this project removes it explicitly:

```sql
revoke all on function … from public, anon, authenticated;   -- 002, 004–009, 011, 012
```

`supabase/migrations/20261115000016_league_archive.sql` (and its design draft
`016_league_archive.sql`) revokes from **`public` only**:

```sql
revoke all on function public.ff_league_archive(uuid) from public;
grant execute on function public.ff_league_archive(uuid) to authenticated;
```

`PUBLIC` is not the same grantee as `anon`. The `public` revoke removed the implicit
`PUBLIC` grant; the explicit, default-derived `anon` grant survived. Migration 013's
privilege verification did not catch it because it looks for functions reachable
through `PUBLIC`, not for a *named* `anon` grantee.

## 3. What an `anon` caller can actually do — tested, not assumed

The guard is the **first statement** of the function body:

```sql
create or replace function public.ff_league_archive(p_league uuid) … as $$
declare v public.leagues;
begin
  perform ff_private.require_leader(p_league);   -- authorises before touching anything
  update public.leagues set archived_at = coalesce(archived_at, now()) where id = p_league …
```

and `ff_private.require_leader(uuid)` (live body) begins with

```sql
perform ff_private.require_read_committed();
if ff_private.current_actor_id() is null then raise exception 'not an active league leader' using errcode='42501'; end if;
perform 1 from public.league_members m where … m.user_id = ff_private.current_actor_id() and … role='leader' for share;
if not found then raise exception 'not an active league leader' using errcode='42501'; end if;
```

`current_actor_id()` resolves the caller from the JWT claims only
(`request.jwt.claim.sub`, falling back to `request.jwt.claims->>'sub'`). A PostgREST
request made with an anon/publishable key carries `{"role":"anon", …}` and **no `sub`**,
so the actor is `NULL` and the second statement raises **before any row is read or
written**.

Executed on the disposable clone (same posture: identical default ACL, the same single
anon-executable function), against a **real, live league id**:

| Probe (as `anon`, `request.jwt.claims = {"role":"anon"}`) | Result |
| --- | --- |
| `select public.ff_league_archive('<live league>')` | `42501 not an active league leader` |
| `leagues.archived_at` before / after the attempt | `null` / `null` — **no trace, no write** |
| same call as `service_role` (which also holds EXECUTE) | `42501 not an active league leader` |

So the grant is **reachable but not exploitable for data change today**: the function
is fail-closed, and the error message is identical for "no identity" and "not a
leader", so it cannot be used to enumerate leagues or leaders.

## 4. What is still a real residual exposure

1. **Defence-in-depth depends on statement order.** The only thing preventing an
   anonymous write is that `require_leader` is called first. Any future edit that
   touches a table before authorising would turn a dormant grant into an anonymous
   write path on a `SECURITY DEFINER` function. This is exactly the class of change
   that is easy to make and hard to notice in review.
2. **API surface disclosure.** PostgREST exposes callable functions in its OpenAPI
   document to any role that can execute them, so `anon` can enumerate this RPC's
   name and parameter shape.
3. **Unauthenticated work.** Each anonymous call costs a connection, a PL/pgSQL
   invocation and a `require_read_committed()` check. That is negligible on its own,
   but it is unauthenticated traffic reaching a definer.
4. **Systemic tail (the part that matters).** Because the exposure comes from
   `pg_default_acl`, *every future* `create function … in public` run by `postgres`
   inherits `anon` EXECUTE. Migration 016 was not an isolated slip; it is the one
   place where the manual `revoke … from anon` convention was missed. Without a
   verification step, the next migration can miss it too — and the next function
   might not check identity first.

## 5. Remediation — prepared, rehearsed on the clone, **not applied to production**

Artefact: **`docs/security/027_anon_execute_hardening.sql`** (revoke + invariant
assertion). It is deliberately kept out of `supabase/migrations/` until the rollback
window closes: that directory is a pinned, hashed package
(`scripts/check-migration-package.mjs`), and promoting a file into it is a reviewed step
with its own hash.

### 5.1 What the rehearsal proved (disposable clone, 2026-11-18)

| Step | Result |
| --- | --- |
| before | `anon` EXECUTE on `ff_league_archive` = **true**, 1 of 50 public functions, default acl includes `anon=X` |
| after step 1 (`revoke … from anon`) | anon = **false**, **0** anon-executable public functions, `authenticated`/`service_role` unchanged, owner still `ff_migration_owner` |
| re-run (idempotency) | applied twice without error |
| leader path still works | leader `30a0b57f…` archived league `f0ec0fa4…` → `{"id": …, "archived": true}` (clone state restored afterwards) |
| anon path afterwards | `42501 permission denied for function ff_league_archive` — refused at the grant, before the function body |
| assertion (step 2) | passes: 0 anon-executable, 50 authenticated-executable |

### 5.2 A finding that changes the fix: default privileges are not a defence

The obvious hardening — `alter default privileges for role postgres in schema public
revoke execute on functions from anon` — **does not work here**, and it fails in a way
that looks like success:

* the revoke does take effect: the `pg_default_acl` row for `postgres`/`public`/`f` loses
  `anon=X`, and a grant added the same way *does* appear on the next function created;
* but a function created immediately afterwards still came out as
  `{=X/postgres, postgres=X/postgres, authenticated=X/postgres, service_role=X/postgres}`
  — PostgreSQL re-adds the built-in **PUBLIC** EXECUTE on functions — and `anon` inherits
  PUBLIC. Adding `revoke … from public` to the default privileges changed nothing, because
  the row never contained the PUBLIC grant to remove.

So the durable guard has to be the **assertion**, not the default. That is what step 2 is:
any migration that creates a function without an explicit `revoke … from anon` now fails
loudly instead of quietly widening the API surface. The check has to run against a real
Supabase database (PGlite has no `anon` role and no Supabase default privileges, which is
exactly why the existing PGlite suite could not catch this class of defect).

### 5.3 Application procedure (after the rollback window, as a normal reviewed change)

1. promote the SQL into the pinned package (`supabase/design/migrations/` → hash pin →
   `npm run migrations:promote`), in one reviewed commit with the hash update;
2. `npm run verify:all` and CI;
3. apply in a quiet window (it is a `REVOKE` plus a `DO` block: no table access, no lock
   beyond the catalog);
4. verify afterwards with the same assertion — it is re-runnable.

### 5.4 Clone hygiene

The clone now carries the 027 grants change (0 anon-executable functions) but its default
privileges were **restored to their original values** afterwards, so it stays a faithful
rehearsal target. Production was not touched.

## 6. Why this does not block the rollback

* It exists identically **before** 026 and **after** the reverse migration; the
  rehearsal confirmed the ACL is untouched by the rollback.
* No user, league or match data is reachable through it — the guard fails closed
  before any table access, verified behaviourally.
* Fixing it during the rollback window would mix two unrelated changes into a
  maintenance operation whose whole value is that it is small, rehearsed and
  reversible.

## 7. Evidence appendix (read-only; run 2026-11-18)

```sql
-- ACL of the function
select pg_get_userbyid(x.grantee), x.privilege_type
  from pg_proc p, aclexplode(p.proacl) x
 where p.oid = 'public.ff_league_archive(uuid)'::regprocedure;
-- ff_migration_owner/EXECUTE, anon/EXECUTE, authenticated/EXECUTE, service_role/EXECUTE

-- every public function anon can execute (live project)
select p.proname, p.prosecdef, pg_get_userbyid(p.proowner)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute');
-- exactly one row: ff_league_archive

-- why: the default privilege that grants it
select pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype, d.defaclacl
  from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
 where d.defaclobjtype = 'f' and n.nspname = 'public';
-- postgres / public / f / {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
```

Behavioural test (disposable clone only, `docs/rollback/g2-hosted-rehearsal-report.md`
records the clone's provenance): `set local role anon` with
`request.jwt.claims = '{"role":"anon"}'`, then
`select public.ff_league_archive('<live league>')` → `42501 not an active league
leader`; `archived_at` unchanged.

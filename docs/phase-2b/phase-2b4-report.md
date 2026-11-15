# Phase 2B.4 — Final migration package and deployment readiness: report

> **No Supabase connection, no persistent migration, no commit, no push, no deployment.** Everything below was verified offline (disposable PostgreSQL 17.6 under `/tmp`, in-memory PGlite, or the actual SQL/CLI files).

## Deliverables created

| Document | Contents |
|---|---|
| [`phase-2b4-final-migration-audit.md`](phase-2b4-final-migration-audit.md) | Independent re-inspection of 001–010 |
| [`phase-2b4-function-ownership-decisions.md`](phase-2b4-function-ownership-decisions.md) | Per-function decision for all 56 |
| [`phase-2b4-storage-execution-runbook.md`](phase-2b4-storage-execution-runbook.md) | Ordered 3a/3b execution + verification |
| [`phase-2b4-recovery-runbook.md`](phase-2b4-recovery-runbook.md) | Recovery for every failure mode |

## 1. What passed and what failed

### Passed

| Check | Result |
|---|---|
| `001`→`010` clean install, Supabase-like bootstrap | 10 / 10 |
| `001`→`010` clean install, mock bootstrap | 10 / 10 |
| Table-set reconciliation (`001` 36 + `004` 2 + `007` 1 + `008` 1 = 40) | exact, no drift |
| `002`'s RLS list vs actual `CREATE TABLE` set | exact — no missing, extra or duplicate |
| `009`'s grant list vs full table set (40) | exact |
| Definer `search_path` pinned | 56 / 56 |
| Dynamic SQL inside any definer function | **none** |
| Definer functions in exposed `public` schema | **none** |
| Client-executable definer functions | exactly 10 (`authenticated`), 0 (`anon`), 0 (`PUBLIC`) |
| `006` pristine guard | applies empty, refuses populated |
| `001`–`006` byte-identical to original pins | yes |

### Failed — and fixed

**1. `pg_has_role()` raises on a nonexistent role.** My own 2B.3 guard used `pg_has_role(current_user,'postgres','member')` to protect an `ALTER DEFAULT PRIVILEGES`. Measured: `pg_has_role` raises `42704 role does not exist` rather than returning `false`. On a self-hosted or CI cluster with no `postgres` role, `009` would abort. **Fixed** with an existence check first; both branches verified on real PG17.6 (`EXECUTED` as a member, `SKIPPED (non-member)` otherwise).

**2. `009` had an unguarded `ALTER DEFAULT PRIVILEGES`.** At statement level it aborts with `ERROR: permission denied to change default privileges` for any non-member of `postgres` — killing the migration. **Fixed** by moving it inside the guard.

### Failed — findings recorded, not fixed (by design)

**3. `001`–`008` are not idempotent.** Re-running any fails immediately. Only `009`/`010` are re-runnable. This is now the basis of the recovery runbook rather than something to "fix" — making historical migrations idempotent would change reviewed files.

**4. No down migrations exist.** `001`–`010` are forward-only. Production rollback = restore from a verified backup. Documented.

**5. A previous report overstated an auth-schema risk.** It claimed policies need `authenticated` to hold `USAGE` on schema `auth`, which no migration grants. Measured on PG17.6: **policy expressions are parsed at `CREATE POLICY` time and evaluated under the policy owner's privileges**, so revoking `USAGE`/`EXECUTE` from `authenticated` does not break policy evaluation on a fresh connection — while a *direct* `auth.uid()` call does fail. **This was never a deployment blocker.** Corrected in the audit §3 and retracted explicitly so it is not carried forward as a false risk.

## 2. Remaining blockers

| # | Blocker | Severity |
|---|---|---|
| 1 | **Definer ownership transfer is not written.** 56 functions still owned by the migration role. The decision is made (`ff_migration_owner`, `BYPASSRLS`); the `ALTER FUNCTION … OWNER TO` migration is not. | **blocking for the ownership goal**, not for correctness — the current state works |
| 2 | **7 functions need tests under the transferred owner** before transfer: `fork_result`, `open_correction_attempt`, `start_scoring`, `can_read_image`, `record_event`, `guard_standings`, `lock_roster_player` | blocking for #1 |
| 3 | **Storage Phase B has never been executed on a project**, and local tests structurally cannot validate it (the mock owns `storage.objects` as the migration role) | blocking for image features only |
| 4 | **`003` exists only as a frozen draft + procedure**; the 3a/3b split must be materialized as executable SQL | blocking for deployment |
| 5 | **No rollback path**; recovery is forward-only and untested under real data | operational risk |
| 6 | **No container runtime here** → `supabase start` / `db reset` / `test db` unavailable | blocks the replay gate |
| 7 | Runtime concerns with no caller: `READ COMMITTED` enforcement, `40P01` retry, PostgREST error mapping | blocks exposing workflows |
| 8 | Aggregate enforcement (squads, budgets, formations, deadlines); money units (×1,000,000) and numeric transport to JS | product risk |

Carried from Phase 2A and unchanged: scoring values, event/bench/vice semantics, standings ties, correction UI, duplicate-person eligibility, role delegation, scheduling, invitations, retention, moderation, rate limits, operator recovery, image lifecycle.

## 3. Is the migration package ready for a real Supabase project?

**No — and specifically, it is not ready to be pushed.**

The package is **internally consistent and fully verified offline**, but three things must be true before a first real push, and none is:

1. **The `003` split must be materialized.** As one file it will fail on `storage.objects` ownership. The procedure is documented; the SQL is not written.
2. **The definer ownership decision must either be applied or consciously waived.** Today the functions work *by accident of ownership* (definer = table owner ⇒ implicit RLS bypass). That is functional and not insecure, but it is not the reviewed model, and `010` does not currently require the transfer.
3. **A verified backup and restore path must exist.** There is no rollback.

What *is* ready: the schema, RLS, grants, function-security and assertion layers are consistent, reconcile exactly against the actual object inventory, and pass on real PostgreSQL 17.6 in two independent bootstraps. `010` is a genuine gate — it fails closed, and it was proven to catch a broken model.

**Recommendation: do not push.** Finish blockers 1–4 first. They are all offline work.

## 4. Exact manual actions that will eventually be required

Ordered. None performed.

1. **Materialize `003a`** as a migration: bucket `INSERT`, `ff_private.can_read_image`, its revoke/grant. Safe as the migration role.
2. **Materialize `003b`** as a documented one-off statement, **not** a CLI migration: `drop policy if exists` + `create policy … on storage.objects for select to authenticated using (bucket_id='player-images' and ff_private.can_read_image(name))`.
3. **Write `011_definer_ownership_transfer.sql`**: `ALTER FUNCTION … OWNER TO ff_migration_owner` for all 56, in one reviewed transaction, **with no grant changes in the same file**. Gate it on blockers 1–2 above.
4. **Expand tests** for the 7 flagged functions under the transferred owner.
5. **Take a verified backup** and confirm the restore actually works.
6. **Run `supabase db push --dry-run`** and confirm the plan before applying anything.
7. **Execute Phase B (3b) as `supabase_storage_admin`** on the project — determine the owner with the catalog query in the storage runbook §3; never grant ownership or membership.
8. **Run `010` last** and treat a failure as a stop signal, not a warning.
9. **Record the deployment log**: exact SQL, role, timestamp and commit for the 3b step.

## 5. Tests and results

| Check | Result |
|---|---|
| `npm test` (unit) | **36 / 36** |
| `npm run test:db:design` (PGlite) | **67 / 67** (65 → 67: two new guard tests) |
| `npm run typecheck` | clean |
| `npm run build` | built |
| `npm run test:pages:assets` | verified for `/Hagz-fantasy/` |
| `npm run check:migrations` | **17 / 17** |
| Guard tamper test — altered design file | **fails as designed** |
| Guard tamper test — SQL added to `supabase/migrations/` | **fails as designed** |
| `git diff --check` | clean |
| PG17.6 `postgres-design-2a3` | 10 / 10 |
| PG17.6 `postgres-security-2a3` | 25 / 25 |
| PG17.6 `postgres-security-2a4` | 29 / 29 |
| PG17.6 `postgres-compat` | 13 / 13 |
| PG17.6 `postgres-phase2b2` | 11 / 11 |
| PG17.6 `postgres-phase2b3` | **25 / 25** (23 → 25) |
| **Native PG17.6 total** | **113 / 113** |
| Chain replay, both bootstraps | 10 / 10 files each |
| `006` pristine guard | 2 / 2 expected outcomes |

Two tests were added, both for a specific risk found in this phase (the `pg_has_role` absence case and the guard shape in `009`), rather than for coverage.

## 6. Files changed this phase

| File | Change |
|---|---|
| `docs/phase-2b/phase-2b4-final-migration-audit.md` | created |
| `docs/phase-2b/phase-2b4-function-ownership-decisions.md` | created |
| `docs/phase-2b/phase-2b4-storage-execution-runbook.md` | created |
| `docs/phase-2b/phase-2b4-recovery-runbook.md` | created |
| `supabase/design/migrations/009_ownership_and_grants.sql` | guarded `ALTER DEFAULT PRIVILEGES` + existence check before `pg_has_role` |
| `supabase/design/tests/phase2b3-ownership.test.mjs` | +2 tests (25 total) |
| `scripts/check-migration-package.mjs` | re-pinned `009` checksum only |

`001`–`006` untouched (checksums verified against the original pins). `007`, `008`, `010` untouched this phase.

## 7. Compliance confirmation

- **No Supabase connection** was made; no project was linked.
- **No migration was executed against any persistent database.** All runs used a disposable cluster under `/tmp/ff-pg-audit` (Unix socket only, `inet_server_addr` asserted null) or in-memory PGlite.
- **No commit, no push, no PR, no deployment.** Branch `arena/4da779c0-hagz-fantasy` remains at `1a78ccb` with all prior work and uncommitted changes preserved.
- Demo mode and all frontend behaviour are unchanged.
- Phase 2B.5 was not started.

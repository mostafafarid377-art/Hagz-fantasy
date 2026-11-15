# Phase 2B.4 — Final migration audit (001–010)

An independent re-inspection of the actual files in execution order, performed in Phase 2B.4. **Nothing here is carried over from a previous report on trust**: every claim below was either re-read from the SQL or re-measured on a disposable PostgreSQL 17.6 cluster / in-memory PGlite.

**No Supabase project was contacted. No migration was applied to a persistent database.**

> **Superseded by Phase 2B.5** for the migration count and ownership: `011_definer_ownership_transfer.sql` now exists, and `009`'s default-privilege guard was additionally hardened. See [`phase-2b5-final-report.md`](phase-2b5-final-report.md). The audit below remains accurate for `001`–`010`.

## 0. Scope and method

| Input | What was done |
|---|---|
| `001`–`010` SQL | Re-read; table/policy/grant lists extracted programmatically and reconciled |
| Disposable PostgreSQL 17.6 | Full chain re-applied in both a Supabase-like and a mock bootstrap |
| PGlite | Full chain re-applied; catalog re-queried for owners, RLS, `EXECUTE`, `search_path` |
| Supabase CLI 3.1.0 | Help output inspected for real `db push` / `migration repair` / `--dry-run` capabilities |

## 1. Dependencies and object-creation order

Reconciled programmatically, not by eye:

| Fact | Value |
|---|---|
| Tables created in `001` | 36 |
| Tables created later | `004` → `scoring_run_sources`, `match_corrections`; `007` → `match_correction_attempts`; `008` → `match_result_forks` |
| **Total `public` tables** | **40** |
| Tables in `002`'s RLS list | **36** — exactly the `001` set, no missing, no extra, no duplicate |
| Tables in `009`'s grant loop | **40** — exactly the full set, no missing, no extra |
| Tables in `003`'s policy | 1 (`storage.objects`) |

The two lists that could silently drift (`002` enablement, `009` grants) both reconcile exactly against the actual `CREATE TABLE` statements. This was previously asserted; it is now **verified by set comparison**.

**Ordering has no slack.** Each step depends on the immediately preceding one:

- `7` redefines three functions from `4`/`5` and needs `6`'s lineage columns.
- `8` derives its fork source from `7`'s attempt table.
- `9` must follow all grant-relevant work or a later `grant select` would undo it.
- `10` asserts `9`'s end state and must be last.

## 2. Table and function ownership

| Object class | Owner after `001`–`010` | Set by |
|---|---|---|
| 40 `public` tables | the migration role | implicit (`CREATE TABLE`) |
| 56 `SECURITY DEFINER` functions | the migration role | implicit (`CREATE FUNCTION`) |
| `ff_private` schema + functions | the migration role | implicit |
| `ff_migration_owner` | — | created by `009`, owns **nothing** |
| `storage.objects` | `supabase_storage_admin` (on Supabase) | platform; never touched |

**No migration contains a single `OWNER TO` statement.** Verified by grep across all ten files. Ownership is entirely implicit, which is exactly why the definer-ownership question cannot be answered from the files alone — see the [ownership decisions](phase-2b4-function-ownership-decisions.md).

## 3. RLS policies and grants

| Check | Result |
|---|---|
| RLS enabled on `public` tables | **40 / 40** (36 by `002`, 4 by their own files) |
| `FORCE ROW LEVEL SECURITY` | **0 / 40** |
| Policies targeting `public` or `anon` | **0** |
| Policies targeting `authenticated` | all of them |
| `anon` table privileges | **none** (revoked by `002`/`009`) |
| `authenticated` table privileges | `SELECT` only; `TRUNCATE`/`REFERENCES`/`TRIGGER` explicitly revoked |
| Definer functions executable by `authenticated` | **10** |
| Definer functions executable by `anon` | **0** |
| Definer functions executable by `PUBLIC` | **0** |

**A precision correction earned this phase.** It is tempting to say "policies call `auth.uid()`, so `authenticated` needs `USAGE` on schema `auth`, which no migration grants." That statement is **wrong for policy evaluation**. Measured on a real PG17.6 cluster:

| Scenario | Result |
|---|---|
| `REVOKE EXECUTE ON auth.uid() FROM authenticated`, then a fresh connection reads an RLS table | **policy still evaluates correctly** |
| `REVOKE USAGE ON SCHEMA auth FROM authenticated`, fresh connection, RLS table | **policy still evaluates correctly** |
| `authenticated` calls `auth.uid()` **directly** with no `USAGE` | `ERROR: permission denied for schema auth` |

Policy expressions are parsed at `CREATE POLICY` time and evaluated under the policy owner's privileges, so the API role does not need schema `USAGE` to *satisfy a policy*. On Supabase these grants exist anyway (the platform grants them). **The conclusion: this is not a deployment blocker, and previous phrasing overstated it.** It is recorded here so it is not carried forward as a false risk in either direction.

## 4. SECURITY DEFINER safety and pinned `search_path`

| Check | Result |
|---|---|
| Definer functions | **56**, all in `ff_private` |
| Pinned `search_path` | **56 / 56**, all exactly `pg_catalog, ff_private` |
| Language | SQL and PL/pgSQL only |
| **Dynamic SQL inside any definer function** | **none** — zero uses of `EXECUTE`/`format()`/`quote_ident()` |
| Accepts schema/table/column name as a parameter | **none** |
| Hostile schema first on the caller's `search_path` | **cannot hijack** (tested) |

The absence of dynamic SQL is a significant safety property: there is no identifier-injection surface and no way for a caller to redirect a definer function at a different relation. All dynamic SQL in the package lives in `DO` blocks at migration time over a hard-coded table list.

## 5. Auth schema privileges

| Statement | Where | Status |
|---|---|---|
| `GRANT USAGE ON SCHEMA auth TO ff_migration_owner` | `009` | present (added Phase 2B.3) |
| `GRANT EXECUTE ON FUNCTION auth.uid() TO ff_migration_owner` | `009` | present |
| `GRANT USAGE ON SCHEMA auth TO authenticated/anon` | **nowhere** | not needed for policy evaluation (§3); provided by Supabase |

The Phase 2B.3 defect (a definer re-owned without `USAGE` on `auth` fails with `permission denied for schema auth`) remains fixed and is asserted by `010`.

## 6. Storage ownership and execution order

`003` ends with a `CREATE POLICY … ON storage.objects`, which requires table ownership. `storage.objects` is owned by `supabase_storage_admin` on Supabase — not by the migrating role. The failure is real and reproduced on PG17.6: `ERROR: must be owner of table objects`.

**Ordering constraint:** the bucket insert and `can_read_image` must run *before* the policy (the policy references the function), and the policy must run *before* `010`, which asserts it exists.

**A fidelity gap that must not be forgotten:** the local `setup.sql` mock creates `storage.objects` owned by the migration role, so **every local test passes regardless**. A green suite is not evidence that `003` applies to Supabase. The 3a/3b split exists for this reason and is specified in the [storage runbook](phase-2b4-storage-execution-runbook.md).

## 7. Idempotency and correction-attempt workflows

### Idempotency — re-measured this phase

Each file was applied to an already-migrated database:

| File | Re-run result |
|---|---|
| `001` | **FAILS** — `relation "profiles" already exists` |
| `002` | **FAILS** — `schema "ff_private" already exists` |
| `003` | **FAILS** — duplicate key `buckets_pkey` |
| `004` | **FAILS** — column `corrects_revision_id` already exists |
| `005` | **FAILS** — function `require_read_committed` already exists |
| `006` | **FAILS** — relation `lineage_source_identity_unique` already exists |
| `007` | **FAILS** — relation `match_correction_attempts` already exists |
| `008` | **FAILS** — relation `match_result_forks` already exists |
| `009` | re-runs OK |
| `010` | re-runs OK |

Only the last two — the grant/assertion layer — are idempotent. This is by design for those two and **a real limitation for the other eight**. Recovery implications are in the [recovery runbook](phase-2b4-recovery-runbook.md).

### Correction-attempt workflow

Re-verified structurally: `match_correction_attempts` is append-only, `attempt_no` is dense and monotonic with `unique(correction_id, attempt_no)`, `draft_revision_id` is `unique`, attempt 1 is created atomically with the case by trigger, and the approvability guard keys off the attempt sequence rather than `match_corrections.draft_revision_id`. Three `004`/`005` functions are replaced (`require_latest_corrected_lineup`, `guard_submission_generation`, `validate_approval`) so attempt 2+ is approvable at all.

## 8. Clean-install behaviour

| Check | Result |
|---|---|
| `001`→`010` in order, mock bootstrap | **10 / 10 applied** |
| `001`→`010` in order, Supabase-like bootstrap | **10 / 10 applied** |
| Both on real PostgreSQL 17.6 | yes |
| `010`'s assertions after clean install | pass |
| `drop schema public cascade; drop schema ff_private cascade` | succeeds |

Clean install is consistent. `010` is the machine-checkable definition of "installed correctly": a deployment that reaches the end of `010` has the reviewed state.

## 9. Failure recovery and forward-only implications

Measured, not assumed:

| Scenario | Behaviour |
|---|---|
| Single file applied inside one transaction, fails | **rolls back atomically — zero orphaned objects** (verified: 43 functions before and after) |
| File applied in batches with **commits between** them, later batch fails | **partial objects persist**, and a full re-run then **fails** (`function "require_read_committed" already exists`) |
| Migration history table not updated but objects created ("uncertain result") | **the dangerous case** — see the recovery runbook |

The decisive implication: **re-running a non-idempotent migration is safe only if the previous attempt committed nothing.** The Supabase CLI records applied migrations in `supabase_migrations.schema_migrations`, and `db push` only applies migrations absent from that table — so the recovery question is always *"did the history row get written?"*, not *"did the SQL run?"*. The recovery runbook is built around that distinction.

## 10. Audit verdict

| Area | Verdict |
|---|---|
| Dependency / creation order | **sound** — lists reconcile exactly, no ordering slack |
| Table ownership | **sound** — uniform, implicit, unchanged |
| Function ownership | **not yet decided in the files** — deliberate; see ownership decisions doc |
| RLS and grants | **sound** — 40/40 enabled, no `anon`/`PUBLIC` exposure, 10 client-executable |
| `SECURITY DEFINER` safety | **strong** — 56/56 pinned `search_path`, zero dynamic SQL |
| Auth schema privileges | **correct**; §3 corrects an overstated earlier risk |
| Storage | **requires a two-part execution**; local tests cannot validate it |
| Idempotency | **only `009`/`010` re-runnable** — documented limitation |
| Clean install | **consistent** in both bootstraps on PG17.6 |
| Failure recovery | **forward-only, needs the runbook** |

## 11. Defect found and fixed in this phase

`009` contained an **unguarded** `ALTER DEFAULT PRIVILEGES FOR ROLE postgres … REVOKE EXECUTE ON FUNCTIONS FROM public`. Measured on PG17.6: that statement requires membership in `postgres`, and as a non-member it aborts with `ERROR: permission denied to change default privileges` — killing the whole migration. It is now wrapped in a `pg_has_role(...)` guard, both branches verified (executes as a member, is skipped cleanly otherwise). The authoritative control was never this statement: it is the explicit function-level `REVOKE EXECUTE … FROM public` in section 5 of the same file, which works without membership and is asserted by `010`.

## 12. Not verified

Hosted Supabase role inheritance, default privileges, `auto_expose_new_tables`, PostgREST, the real Storage service, pooled concurrency, and any restore/rollback under real data. No claim of Supabase compatibility is made anywhere in this package.

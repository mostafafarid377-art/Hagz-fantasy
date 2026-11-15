# Phase 2B.2 — Migration security and workflow readiness: report

> **Status: complete as design and verified preparation. No Supabase project was contacted, linked, or migrated. No migration was applied to any persistent database. No commit or push was made.**
>
> Every result below comes from a disposable local PostgreSQL **17.6** cluster (Unix socket only, under `/tmp`), in-memory PGlite, or file inspection. **No hosted Supabase compatibility is claimed.**

## 1. Files created and changed

### Created — design migrations (not executable, `supabase/migrations/` stays absent)

| File | Lines | Contents |
|---|---|---|
| `supabase/design/migrations/007_correction_attempts.sql` | 296 | `match_correction_attempts` + append-only triggers, attempt-aware replacements of `require_latest_corrected_lineup`, `guard_submission_generation`, `validate_approval`, `ff_private.open_correction_attempt` |
| `supabase/design/migrations/008_result_fork_idempotency.sql` | 191 | `match_result_forks`, 3-argument `fork_result`, drops the 2-argument signature |
| `supabase/design/migrations/009_ownership_and_grants.sql` | 115 | `ff_migration_owner`, default-privilege revokes, 40-table revoke/grant loop, function `EXECUTE` lockdown + 10 re-grants, API-role membership guard |
| `supabase/design/migrations/010_privilege_verification.sql` | 125 | Assertion-only end-state verification; fails the deployment on any drift |
| `supabase/design/tests/phase2b2-pglite.test.mjs` | 221 | 11 sequential tests for 007–010 |
| `supabase/design/tests/postgres-phase2b2.mjs` | 38 | Native PG17 wrapper for the same suite, socket-only guard |

### Created — documentation

| File | Purpose |
|---|---|
| `docs/phase-2b2-storage-ownership.md` | Storage ownership resolution, safe path, limitations |
| `docs/phase-2b2-grants-and-function-security.md` | Default privileges, grants matrix, `EXECUTE`, definer ownership |
| `docs/phase-2b2-migration-package.md` | Ten-migration order, dependency rationale, readiness, blockers |
| `docs/phase-2b2-report.md` | This report |

### Changed

| File | Change |
|---|---|
| `supabase/config.toml` | `auto_expose_new_tables = false` set explicitly (was commented out) |
| `scripts/check-migration-package.mjs` | Now pins 007–010 checksums (001–006 unchanged) and asserts `auto_expose_new_tables = false`; 12 → 17 checks |
| `package.json` | `check:migrations` script (carried over from 2B.1; no other change) |

The six Phase 2A drafts `001`–`006` are **byte-for-byte unchanged**, enforced by checksum guard.

## 2. Storage ownership resolution

`003_storage.sql`'s `create policy … on storage.objects` fails with `42501 must be owner of table objects` because `storage.objects` is owned by `supabase_storage_admin`, not the migrating `postgres` role.

**Reproduced on PG17.6** with a Supabase-like cluster, then resolved by measurement, not assumption:

| Probe | Result |
|---|---|
| `insert into storage.buckets(...)` as non-owner | succeeded |
| `alter table storage.objects enable row level security` as non-owner | **failed** |
| `create policy ... on storage.objects` as non-owner | **failed** |
| `create policy ... on storage.objects` as `supabase_storage_admin` | **succeeded** |
| `pg_has_role('deployer','supabase_storage_admin','member')` after | `false` |

**Resolution:** split `003` into 3a and 3b. 3a (bucket row, `can_read_image`, grants) runs as the normal migration role — verified to succeed as a non-owner. 3b is the single policy statement, run by the owner `supabase_storage_admin`, idempotent via `drop policy if exists` + `create policy`, containing **no** ownership change, **no** privilege grant, and **no** `alter table … enable row level security` (RLS is already on). `010` asserts the policy exists, is `SELECT`-only, and that `relrowsecurity` is true — so a skipped 3b **fails the deployment** instead of shipping an unprotected bucket.

Rejected alternatives, documented in `docs/phase-2b2-storage-ownership.md`: transferring ownership to `postgres`, granting `ALL` on `storage.objects`, granting `supabase_storage_admin` membership, and keeping the failing statement in the migration.

**Limitations:** not verified on Supabase; whether a hosted project permits the one-off owner step, and how it is audited, is unconfirmed; Storage runtime behaviour, signed URLs, MIME/size enforcement untested.

## 3. Grants and function security review

There are two sides to review. The second is the one that mattered.

**A. What the design intends** — `anon` gets **zero** table privileges in `public`; `authenticated` gets **exactly `SELECT`** on the 40 reviewed tables; `TRUNCATE`/`REFERENCES`/`TRIGGER` are explicitly revoked because **RLS does not cover `TRUNCATE`**, so leaving it implicit would hide a real hole inside a "SELECT-only" claim.

**B. The default-privilege dependency that had to be removed** — the drafts relied on Supabase's *historical* permissive default. Under that default a table missing from the revoke list silently gets `ALL` for `anon`/`authenticated`. Supabase has now made the opposite the platform default for existing projects as well as new ones, and accepts either `auto_expose_new_tables = false` or explicit `revoke` statements. `009` therefore *declares* the model explicitly instead of inheriting it, and the config asserts the hardened default locally. Both paths are covered, so a reset reproduces the hardened behaviour.

**Function `EXECUTE`** is default-**open**: Postgres grants it to `PUBLIC`, and Supabase's bootstrap additionally grants `ALL` to the API roles. A `SECURITY DEFINER` function reachable by `anon` is the standard escalation surface. `009` revokes `EXECUTE` on **all** functions in `public` and `ff_private` from `public`, `anon` and `authenticated`, then re-grants **exactly ten reviewed read helpers** (`is_member`, `is_leader`, `is_organizer`, `owns_team`, `can_read_lineup`, `can_read_revision`, `can_read_match`, `can_read_suggestion`, `can_read_image`, `is_match_organizer`). Every mutation path stays unreachable from a client.

**`SECURITY DEFINER` ownership** — `ff_migration_owner` is created `nologin nobypassrls noinherit nosuperuser nocreatedb nocreaterole`, so it can never authenticate, inherits nothing, and cannot be used as a silent RLS bypass. `010` asserts it is not a login role, holds no `BYPASSRLS`, and is not a member of (nor grantor to) `anon`/`authenticated`/`service_role`/`authenticator`.

**All 56 `SECURITY DEFINER` functions after the full chain pin `search_path`** — asserted by `010`, not assumed.

### Deliberate scope limit — flagged, not hidden

`009` **creates** the least-privilege owner but does **not** yet run `alter function … owner to ff_migration_owner` across the 56 definer functions. That reassignment moves the definer context for every privileged path at once; doing it without exercising the privileged-path tests under the reassigned owner would be a guess dressed up as hardening. It is the **first proposed task of Phase 2B.3** and is listed as blocker §6.1.

## 4. Correction-attempt implementation (`007`)

Immutable, numbered, lineage-preserving attempts; exactly one eligible for approval.

- `match_correction_attempts` is append-only — `update`/`delete` raise `23514`.
- `attempt_no` is dense and monotonic per correction (`unique(correction_id, attempt_no)`); `draft_revision_id` is `unique`, so a revision belongs to at most one attempt.
- Attempt 1 is written by an AFTER INSERT trigger on `match_corrections`, atomically with the case, so a case can never exist without an attempt.
- **Rejected attempts stay historical** — rejection is recorded on submissions/approvals as 004/005 already did; nothing is rewritten.
- **Only the latest attempt is approvable** — `guard_correction_attempt_approval` rejects any attempt with a higher `attempt_no` in the same correction.
- **Retries preserve lineage** — `open_correction_attempt` requires the prior attempt to be *rejected* and its revision final, then copies the snapshot with the same `corrects_revision_id` and links `prior_attempt_id` (`unique`, so lineage is a chain, and a shape `check` forces attempt 1 to have no prior).
- A second case cannot open while an earlier one is unresolved.

**Three 004/005 functions had to be replaced**, because they derived the required revision from `match_corrections.draft_revision_id` — which is always attempt 1: `require_latest_corrected_lineup`, `guard_submission_generation`, and `validate_approval`. The third was **found by the test suite**, not by reading: approving attempt 2 raised `stale lineup submission after correction` from 005's ordering. Attempt ordering now uses the attempt's **revision version** (unique per match) rather than `created_at`, because a timestamp tie inside one transaction made ordering nondeterministic — this also caused a second real test failure that was initially misattributed to the guard.

## 5. Idempotency implementation (`008`)

Persisted key→revision mapping, atomic with the fork.

| Constraint | Guarantee |
|---|---|
| `unique(league_id, match_id, workflow_case_id, lineup_approval_id, result_attempt_no)` | the stable business key — duplicate logical fork impossible |
| `unique(request_id)` | client-request idempotency; a retry cannot allocate two attempt numbers |
| `unique(result_revision_id)` | one result revision per mapping |
| `unique(prior_fork_id)` + shape `check` | attempt chain |

`fork_result(league, lineup_approval, request_id)` replays **before** any authorization work: an existing `request_id` returns its committed `result_revision_id`, and a mismatched payload is a `23514` conflict. The mapping and the copied draft are inserted in one transaction, so they cannot diverge; a concurrent same-key call blocks on the unique index and its retry hits the replay path. Attempts above 1 require the previous attempt's result to have been **rejected** — an explicit retry, never a silent second attempt.

The **2-argument `fork_result` is dropped**: a fork with no request key cannot be idempotent, so keeping the signature would keep the defect. `010` asserts the old signature is gone.

Two schema facts were discovered by running the chain, not by reading: `match_approvals` has no `unique(league_id,id)` (only `(league_id,match_id,…)` variants), so the FK targets `(league_id,match_id,id,revision_id)`; and the self-referencing FK needs an explicit `unique(league_id,match_id,id)` on `match_result_forks`.

## 6. Ten-migration ordering

`1`–`6` replay the reviewed drafts one per file · **`7`** correction attempts · **`8`** fork idempotency · **`9`** ownership/grants · **`10`** verification.

Key dependencies: `7` after `6` (redefines 004/005 functions, needs 006 lineage and `match_approvals`' 4-column unique) · `8` after `7` (fork source is the latest attempt's approval) · `9` last among grant work (a later `grant select` would undo it) · `10` last overall (asserts everything). `003` splits into 3a (CLI migration) and 3b (owner-authorized step, not a CLI migration). Full rationale in `docs/phase-2b2-migration-package.md`.

`006`'s pristine-database guard is **kept**, and was re-proven on PG17.6 this phase (see §7). `007` applies the same fail-closed principle to its own history: it refuses to invent attempt numbers for pre-existing `match_corrections` rows.

## 7. PostgreSQL 17 test evidence

Real PostgreSQL **17.6** (`server_version_num = 170006`), disposable cluster under `/tmp/ff-pg-audit`, **Unix socket only** (`inet_server_addr` asserted null), one fresh cluster per suite because roles are cluster-wide.

| Suite | Result |
|---|---|
| `postgres-design-2a3` | **10 / 10** |
| `postgres-security-2a3` | **25 / 25** |
| `postgres-security-2a4` | **29 / 29** |
| `postgres-compat` | **13 / 13** |
| `postgres-phase2b2` (new, covers 007–010) | **11 / 11** |

**Full chain, both bootstraps** — `001`→`010` all `APPLIED`, zero failures, in a Supabase-like bootstrap (real `auth.uid()`, `storage` owned by `supabase_storage_admin`, `service_role` with `BYPASSRLS`, `anon`/`authenticated` `nologin noinherit`) **and** the repository's mock `setup.sql`.

**`006` pristine guard, re-proven:** empty `match_revisions` → applies; one row → refuses with `revision lineage cannot be inferred for existing data; human migration review required`.

## 8. All test results

| Gate | Result |
|---|---|
| `npm test` (unit, vitest) | **36 / 36** |
| `npm run test:db:design` (PGlite) | **42 / 42** (31 → 42 with the 11 new tests) |
| `npm run typecheck` | ✅ clean |
| `npm run build` | ✅ built |
| `npm run test:pages:assets` | ✅ `Pages build assets verified for /Hagz-fantasy/` |
| `npm run check:migrations` | ✅ **17 / 17** (12 → 17) |
| `git diff --check` | ✅ clean |
| Native PG17 suites | ✅ 88 / 88 across five suites |
| Chain replay, 2 bootstraps | ✅ 10 / 10 files each |
| Guard negative test | ✅ fails when a SQL file is placed in `supabase/migrations/` |

## 9. Remaining blockers

**Before any match workflow is exposed:**

1. **Definer ownership reassignment** to `ff_migration_owner` for all 56 definer functions — deliberately deferred (§3); Phase 2B.3 task 1.
2. **Storage policy 3b** has never been executed on a real project; its execution path and audit trail are unconfirmed.
3. **Runtime requirements with no caller**: `READ COMMITTED` enforcement, `40P01` whole-transaction retry, PostgREST error mapping for the new `23514` conflicts.
4. **No container runtime** in this environment, so `supabase start`, `db reset` and `test db` remain unavailable; the replay gate cannot run yet.
5. **Aggregate enforcement** for squads/budgets/formations/deadlines is still unimplemented (unchanged from Phase 2A).
6. **Money unit conversion** (×1,000,000) and exact-numeric transport to JS remain undocumented.
7. Product/operational questions unchanged from Phase 2A: scoring values, event/bench/vice semantics, standings ties, correction UI, duplicate-person eligibility, role delegation, scheduling, invitations, retention, moderation, rate limits, operator recovery, image lifecycle.

**Explicitly not claimed:** hosted Supabase compatibility, Supabase Auth/PostgREST/Storage behaviour, or the effect of `auto_expose_new_tables` on a real project.

## 10. Stop state

Stopped as instructed: **no Supabase connection**, no project link, **no migration executed against any persistent database**, **no commit, no push, no PR**. The six Phase 2A drafts are byte-identical; all prior commits are intact on `arena/4da779c0-hagz-fantasy`.

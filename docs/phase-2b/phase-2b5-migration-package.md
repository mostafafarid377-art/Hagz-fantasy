# Phase 2B.5 — Migration package status

The authoritative package description after Phase 2B.5. Supersedes the sequence table in `phase-2b2-migration-package.md`.

**Eleven design files, none executable.** `supabase/migrations/` remains absent and is guarded (`npm run check:migrations`). No Supabase project was contacted.

## 1. The sequence

| # | Design file | Contents | Executable? |
|---|---|---|---|
| 1 | `001_schema.sql` | 36 tables, constraints, indexes | no — frozen draft |
| 2 | `002_security.sql` | helpers, RLS enablement (36), policies, revokes | no |
| 3a | `003_storage.sql` part 1 | bucket + `can_read_image` + grants | no — split at execution |
| 3b | `storage/003b_storage_policy_owner_step.sql` | the policy only | **not a CLI migration** |
| 4 | `004_integrity_workflows.sql` | +2 tables (`scoring_run_sources`, `match_corrections`), triggers, workflows | no |
| 5 | `005_concurrency_hardening.sql` | locking, authorization hardening | no |
| 6 | `006_revision_lineage.sql` | exact lineage + pristine-database guard | no |
| 7 | `007_correction_attempts.sql` | +1 table, numbered attempts | no |
| 8 | `008_result_fork_idempotency.sql` | +1 table, persisted fork idempotency | no |
| 9 | `009_ownership_and_grants.sql` | least-privilege definer role, explicit grants | no |
| 10 | `010_privilege_verification.sql` | assertions that fail the deployment | no |
| 11 | `011_definer_ownership_transfer.sql` | all 56 definer functions → `ff_migration_owner` | no — **new in 2B.5** |

## 2. Ordering, and why `011` is last

`011` must run **after** `010`. `010` asserts that `ff_migration_owner` is `NOLOGIN`, has `BYPASSRLS`, owns no relation, and that exactly ten functions are client-executable. `011` changes *only* the owner, so those assertions still hold afterwards — but running `011` before `009`/`010` would leave the transfer unasserted. `011` guards this itself and refuses if the role is absent.

`011` performs **no grant changes**, so ownership and grants stay separable: a failure is unambiguously one or the other. Rehearsed in recovery cases 3, 4 and 5.

## 3. Object inventory

| Fact | Value |
|---|---|
| `public` tables | **40** (36 + 2 + 1 + 1) |
| `SECURITY DEFINER` functions | **56**, all in `ff_private` |
| Functions client-executable | **10** (`authenticated`), 0 (`anon`), 0 (`PUBLIC`) |
| `search_path` pinned | **56 / 56** |
| Dynamic SQL in a definer function | **0** |
| RLS enabled | 40 / 40 |
| `FORCE ROW LEVEL SECURITY` | 0 / 40 |

## 4. Idempotency

| Re-runnable | Not re-runnable |
|---|---|
| `009`, `010`, `011`, `003b` | `001`–`008` |

`011` is re-runnable because `ALTER FUNCTION … OWNER TO` is absolute, not additive — verified by applying it twice. This matters for recovery and is why `011` is the correct repair for a split ownership state.

## 5. Verification gates

| Gate | Enforces |
|---|---|
| `npm run check:migrations` | drafts byte-identical (`001`–`011` pinned), no executable migration, `auto_expose_new_tables = false`, no project link |
| `010` | the reviewed end state of `001`–`009` |
| `011` guard + post-condition | correct definer role, complete transfer |
| `003b` post-condition | one SELECT policy, no write policy, RLS enabled |

## 6. State after Phase 2B.5

The offline blockers from 2B.4 are addressed: the ownership decision is implemented and tested, the Storage package is a runnable artefact with a rehearsal, and recovery is rehearsed rather than described. What remains requires a real Supabase project and is listed in the [final report](phase-2b5-final-report.md) §7.

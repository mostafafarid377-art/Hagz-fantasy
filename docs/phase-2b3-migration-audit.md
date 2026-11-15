# Phase 2B.3 — Migrations 001–010: combined audit

A single-pass audit of the ten migrations together, for dependencies, ownership, RLS, rollback and clean-install consistency. Every table below is a **measurement**, not a reading.

## 1. Clean install

| Check | Result |
|---|---|
| `001`→`010` applied in order, mock bootstrap (`setup.sql`) | **all 10 applied** |
| `001`→`010` applied in order, Supabase-like bootstrap | **all 10 applied** |
| Applied on real PostgreSQL **17.6** | yes, both modes |
| Any statement depending on a pre-existing object it does not create | none found — the order is self-sufficient |
| Post-state: `010`'s assertions | pass (they are the clean-install gate) |

## 2. Dependency order

| Step | Depends on | Why it cannot move earlier | Why it cannot move later |
|---|---|---|---|
| `1` schema | — | base | everything references its tables |
| `2` security | 1 | needs the tables | `4` narrows its organizer reads; `2` must come first so the delta is reviewable |
| `3a` bucket + `can_read_image` | 1 (insert), 2 (`ff_private`, `is_member`) | — | `3b`/`010` reference the function |
| `3b` policy | 3a (function), 1 | needs `can_read_image` | `010` asserts the policy |
| `4` workflows | 1, 2 | needs tables + helpers | `5` hardens `4`'s triggers; `7` replaces `4`'s `require_latest_corrected_lineup` |
| `5` concurrency | 4 | `create or replace` on 4's functions | `7` replaces `5`'s `validate_approval` + `guard_submission_generation` |
| `6` lineage | 5 | needs 5's locking helpers | `7` needs `006`'s lineage columns and `match_approvals`' 4-column unique |
| `7` correction attempts | 6 | needs 6's lineage | `8` needs `match_correction_attempts` |
| `8` fork idempotency | 7 | fork source is the latest attempt's approval | `9`'s grant loop covers its table |
| `9` ownership/grants | 8 | must see every object to grant on it | `10` asserts 9's end state |
| `10` verification | 9 | — | must be last |

**No step has slack.** Reordering any pair either fails outright or silently produces a weaker state. `9` is the only exception in direction: it must come *after* all grant-relevant work, because a later `grant select` would undo its revokes.

## 3. Ownership

| Object class | Current owner | Proposed owner | Status |
|---|---|---|---|
| 40 `public` tables | migration role | unchanged | reviewed; transfer explicitly rejected |
| 56 definer functions in `ff_private` | migration role | `ff_migration_owner` | **reviewed, not yet applied** — see matrix §5 |
| `ff_migration_owner` | n/a | created by `009` | **applied in 009** |
| `storage.objects` | `supabase_storage_admin` | unchanged | policy via owner-authorised step only |
| `ff_private` schema | migration role | unchanged | — |
| sequences | migration role | unchanged | — |

The `009` change this phase: the role is now created `BYPASSRLS` and receives `USAGE` on `auth`/`storage`, table `DML` grants and sequence grants. Without those, every definer function either errors (no `auth` usage) or silently returns `false` (no RLS bypass). `010` asserts all of it.

## 4. RLS

| Check | Result |
|---|---|
| `public` tables with RLS enabled | **40 / 40** |
| `public` tables with `FORCE ROW LEVEL SECURITY` | **0 / 40** |
| Policies | all `to authenticated`; none `to public`, none `to anon` |
| `anon` table privileges | none |
| `authenticated` table privileges | `SELECT` only, plus explicit `TRUNCATE`/`REFERENCES`/`TRIGGER` revokes |
| `storage.objects` RLS | enabled by Supabase (mock: by fixture); asserted by `010` |
| Consequence for definers | since no policy is `to public`/`to anon`, a definer that is neither the table owner nor `BYPASSRLS` sees **nothing** — this is the Model B failure in the matrix |

**Not using `FORCE ROW LEVEL SECURITY` is a deliberate, recorded decision.** Forcing it would make table owners subject to their own policies, which would break the *current* model (definer = owner) and would still not fix the helper problem, because the helpers need to read rows the caller cannot. The correct control is the definer's `BYPASSRLS` plus the `010` assertions, not FORCE.

## 5. Rollback

| Check | Result |
|---|---|
| Down/rollback migrations present | **0 of 10** |
| `drop schema public cascade; drop schema ff_private cascade` | succeeds cleanly |
| Migrations are individually idempotent | **no** — only `009` and `010` re-run cleanly |

**This is a real, documented limitation.** Migrations `001`–`008` are forward-only and **not** idempotent: re-running any of them fails (`relation already exists`, `duplicate key`, …). *Measured*, not assumed.

Consequences to accept explicitly before the first deployment:

- **Recovery is forward-only.** A failed migration is fixed by a new migration, or by restoring a backup. There is no `supabase db reset`-free rollback path for production.
- **`009`/`010` being idempotent is deliberate** — they are the assertion/grant layer and are expected to be re-run.
- **`db reset` replays from empty and does not restore the storage policy**, because `3b` is not a CLI migration. Every reset needs step 3b re-run, which `010` will catch.
- Before the first hosted migration, take a verified backup and confirm the restore path. Nothing in this repository has exercised one.

## 6. Cross-migration consistency findings

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `009` granted `EXECUTE` on `auth.uid()` but not `USAGE` on schema `auth` — every helper errors under a re-owned definer | **high** | **fixed this phase** |
| 2 | `009` created the definer `nobypassrls`; under that model all ten helpers silently return `false` | **high** | **fixed this phase** (`BYPASSRLS` + `010` assertion) |
| 3 | `010`'s original assertion *forbade* `BYPASSRLS`, i.e. it enforced the broken model | **high** | **fixed this phase** |
| 4 | `007` replaced three 004/005 functions; the need for the third (`validate_approval`) was only found by test | medium | fixed in 2B.2 |
| 5 | `008`'s composite FK needed an explicit self-referential unique constraint | medium | fixed in 2B.2 |
| 6 | `010` now guards that the four reviewed tables exist before asserting on them | medium | fixed in 2B.2 |
| 7 | `001`–`008` are not idempotent; no rollback path | medium | **documented, accepted** |
| 8 | The mock owns `storage.objects` as the migration role, so it can never catch the Storage failure | medium | **documented**; split is a procedure |
| 9 | `003` is frozen, so the 3a/3b split exists only as a procedure | low | by design (001–006 preserved) |

## 7. Clean-install state, asserted

After `001`→`010`, `010` itself verifies: the four reviewed tables exist; `anon` holds no table privilege; `authenticated` holds only `SELECT`; RLS is enabled on all 40 tables; no definer function is reachable by `anon`/`PUBLIC`; every definer pins `search_path`; exactly ten functions are client-executable; `ff_migration_owner` is `NOLOGIN`, has `BYPASSRLS`, owns no relation, and has `USAGE` on `auth`; no API role inherits it; and the storage policy exists with `SELECT` only.

That set of assertions **is** the clean-install specification. A deployment that reaches the end of `010` has the reviewed state; one that does not, has stopped.

## 8. Not verified

- Hosted Supabase: role inheritance, default privileges, `auto_expose_new_tables`, PostgREST, Storage service.
- Concurrency across pooled connections; `READ COMMITTED` enforcement and `40P01` retry with no real caller.
- Restore/rollback under real data volumes.
- Whether `alter default privileges for role postgres` is permitted for the hosted migration role. `009` guards it in a `DO` block filtered to roles that exist, so an absent role is skipped — but that path is untested on the platform.

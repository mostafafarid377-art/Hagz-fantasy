# Phase 2B.1 — Migration package (preparation only)

> **Status: preparation only. No Supabase project was contacted, linked, or migrated. No migration was applied anywhere. Nothing in this package is executable yet.**
>
> The six files in [`supabase/design/migrations/`](../../supabase/design/migrations) are unchanged Phase 2A **design drafts**. They are review artefacts. They are not, and must not be treated as, deployable migrations.

This document is the versioned migration package for Phase 2B. It records exactly what must change before each design draft can become an executable migration, proposes the executable filenames and ordering, and keeps the pristine-database requirement for `006` explicit.

## 1. Why the drafts are not executable

The Supabase CLI applies every `*.sql` file in `supabase/migrations/` in filename order, as the database migration role, and records each one in `supabase_migrations.schema_migrations`. A file placed there is a deployment, not a draft. Three consequences:

1. **No draft may be copied in.** Each draft carries its own `-- PHASE 2A… NOT DEPLOYABLE` header and at least one unresolved deployment precondition (§3). Copying one in would silently convert an unreviewed design decision into a production migration.
2. **A draft may not be edited into shape either.** The drafts are the reviewed baseline of Phase 2A. Editing them in place would destroy the audit trail that Phase 2A.2–2A.5 built. Executable migrations are new, separately reviewed files whose content is traced back to the unchanged drafts.
3. **The gate is enforced, not just documented.** [`scripts/check-migration-package.mjs`](../../scripts/check-migration-package.mjs) (`npm run check:migrations`) fails if a design draft's checksum changes, if any SQL appears in `supabase/migrations/`, if the project is linked, or if `config.toml` gains a secret or a hosted project reference.

## 2. Proposed executable filenames and ordering

The CLI names migrations `<UTC timestamp>_<name>.sql` and applies them in lexical order. The timestamps below are a proposal for Phase 2B.2; the CLI assigns the real timestamp when the file is created with `npx supabase migration new <name>`. Ordering is the contract, not the numbers.

| # | Proposed filename | Source draft (unchanged) | Purpose |
|---|---|---|---|
| 1 | `20260101000001_phase2b_baseline_001_schema.sql` | `001_schema.sql` | Application tables, constraints, indexes |
| 2 | `20260101000002_phase2b_baseline_002_security.sql` | `002_security.sql` | `ff_private` helpers, RLS enablement, read-only client grants |
| 3 | `20260101000003_phase2b_baseline_003_storage.sql` | `003_storage.sql` | `player-images` bucket and reference-checked read policy |
| 4 | `20260101000004_phase2b_baseline_004_integrity_workflows.sql` | `004_integrity_workflows.sql` | Integrity triggers, match workflows, correction case |
| 5 | `20260101000005_phase2b_baseline_005_concurrency_hardening.sql` | `005_concurrency_hardening.sql` | Locking and authorization hardening |
| 6 | `20260101000006_phase2b_baseline_006_revision_lineage.sql` | `006_revision_lineage.sql` | Exact lineage, fail-closed on existing data |
| 7 | `20260101000007_phase2b_correction_attempts.sql` | **none — new design** | Correction-attempt records (§5) |
| 8 | `20260101000008_phase2b_result_fork_idempotency.sql` | **none — new design** | Persisted fork idempotency (§5) |
| 9 | `20260101000009_phase2b_ownership_and_grants.sql` | derived from 002/004/005/006 | Migration-owner role, explicit grants, `auto_expose_new_tables` correction (§3.3) |
| 10 | `20260101000010_phase2b_apply_grants_verification.sql` | derived | Assertions that the deployed privileges are what the design assumes |

Notes on this ordering:

- **Migrations 1–6 replay the reviewed baseline, one file per design draft**, so a failure is attributable to one draft. They must be created **only** after the per-draft fixes in §3 are applied to the *new* files, not to the drafts.
- **7–8 must land before any match workflow is exposed.** They are additions, not edits: migration 6 must not be reopened to add them.
- **9 is last among baseline concerns** because it must revoke/regrant after every object exists. It contains the `auto_expose_new_tables` correction, which cannot be fixed in `config.toml` alone (§3.3).
- **10 is a verification migration.** It should fail the deploy if grants are wrong, rather than passing silently.
- Timestamps must be strictly increasing and must never be reordered after a remote has recorded them. Supabase records applied versions in `supabase_migrations.schema_migrations`; renaming or reordering after a push is a manual `migration repair` operation.

## 3. What must change before each draft is executable

Severity: **blocker** = would fail or be unsafe to deploy as-is; **placeholder** = deployable only inside a disposable environment; **verify** = must be confirmed against the real stack before Phase 2B.2 closes.

### 3.1 `001_schema.sql`

| # | Severity | Required change |
|---|---|---|
| 1.1 | **verify** | `gen_random_uuid()` is used 29 times. It is built in on PostgreSQL 13+; on Supabase it resolves from `pg_catalog`, so it is expected to work on 15/17 without `pgcrypto` being in `search_path`. Must be confirmed on the target's `db.major_version` (`17` in the committed config). |
| 1.2 | **verify** | `numeric` money columns are absolute currency units. The frontend demo uses `100` for 100M, so the executable baseline must document the ×1,000,000 conversion and the PostgREST numeric→JS precision contract. No conversion is implemented yet. |
| 1.3 | **blocker (design)** | The draft constrains shape, not business rules. Squad size/positions/budget, exact starter/bench composition, deadline enforcement and transfer legality are not enforced by DDL. Executable status requires those to be enforced by the reviewed RPCs of Phase 2B.3, or the feature must stay closed. |
| 1.4 | **verify** | Indexes on FK referencing columns are not universal. `EXPLAIN` and lock-duration review on the real stack are required; no claim is made here. |
| 1.5 | none | Table set matches the `002` RLS loop list exactly (36 tables). Verified locally: RLS is enabled on every `public` table. |

### 3.2 `002_security.sql`

| # | Severity | Required change |
|---|---|---|
| 2.1 | **verify** | `revoke create on schema public from public, anon, authenticated` requires owning the schema or the database. On Supabase this succeeds when the migration role owns the database; must be confirmed on the target. |
| 2.2 | **verify** | `create schema ff_private` + `revoke all … from public, anon, authenticated` must be confirmed after execution: `EXECUTE` on 48 `SECURITY DEFINER` functions landed in `ff_private`, and only the 10 read helpers are granted to `authenticated`. Verified in the local emulation; **not** verified on Supabase. |
| 2.3 | **blocker (ordering)** | `002` alone is **not** the approved permission baseline. Its league-wide organizer reads are deliberately narrowed by `004`. Neither file may be deployed alone, and `002` must never be treated as the final permission state. |
| 2.4 | **verify** | The design assumes the definer functions are owned by a **non-login, RLS-bypassing, non-client-exposed** role with a fixed `search_path`. All 59 `SECURITY DEFINER` functions do pin `search_path` (verified), but ownership is not assigned anywhere. Migration 9 (§2) must create and assign that owner explicitly. |
| 2.5 | **verify** | `grant select on public.<table> to authenticated` inside a `DO` loop combined with Supabase's default privileges means `anon` and `authenticated` may hold grants this draft does not intend. See §3.3 — this is the highest-risk item in the package. |

### 3.3 Cross-cutting: Supabase default grants (`auto_expose_new_tables`)

This applies to every draft that creates objects and is the single most dangerous difference between the PGlite mock and a real project.

- The documented Supabase bootstrap sets `alter default privileges in schema public grant all on tables/functions/sequences to postgres, anon, authenticated, service_role`. Newly created tables are therefore granted **ALL** to `anon` and `authenticated` by default.
- The CLI 3.1.0 config exposes the switch: `[api] auto_expose_new_tables` — "Controls whether new tables … created in the `public` schema by `postgres` are reachable through the Data API roles … without explicit GRANTs, matching the cloud default. Set to `false` to require explicit GRANTs instead. Left unset, a fresh project falls back to `true`."
- The drafts do revoke client DML on the tables they enumerate, and the local emulation confirmed the end state is `SELECT`-only for `authenticated` and nothing for `anon`. **But** this depends on the drafts running as a role that may revoke those default grants, and on the revoke lists staying complete.
- **Required before executable:** set `auto_expose_new_tables = false` for the local project **or** add an explicit revoke/regrant migration (migration 9) with a verification assertion (migration 10). Do not rely on `002`'s loop list alone.

### 3.4 `003_storage.sql`

| # | Severity | Required change |
|---|---|---|
| 4.1 | **verify** | `insert into storage.buckets …` needs Storage-schema write privilege. In the local emulation it succeeded with ordinary grants. Must be confirmed on the real stack. |
| 4.2 | **blocker** | `create policy player_images_member_read on storage.objects` needs to own `storage.objects`. That table is owned by `supabase_storage_admin`, not by the migration role — this is a documented, recurring Supabase failure (`ERROR: 42501: must be owner of table objects`). **Verified in the local emulation**: with grants but no ownership, `alter table storage.objects enable row level security` and `create policy … on storage.objects` both failed with `must be owner of table objects`, while the bucket insert succeeded. Phase 2B.2 must choose an owner-authorized path (bootstrap via the Storage API/dashboard, a reviewed owner-run step) and record which one. |
| 4.3 | **blocker** | The draft's `create policy … on storage.objects` is unguarded. It must also be made re-runnable or explicitly one-shot, and must not attempt `alter table storage.objects enable row level security` (RLS is already enabled; altering it is owner-only and unnecessary). |
| 4.4 | **verify** | `file_size_limit = 5242880` duplicates `config.toml`'s `[storage] file_size_limit = "50MiB"`. The bucket-level limit is the one that applies to `player-images`; the project-wide value should be reviewed so the two do not contradict. |
| 4.5 | **blocker (design)** | Reads only. There is no upload, update or delete policy, and no byte-level verification. Image upload remains closed in Phase 2B; `image_url` has no separate safety policy. |

### 3.5 `004_integrity_workflows.sql`

| # | Severity | Required change |
|---|---|---|
| 5.1 | **verify** | Creates 2 new `public` tables (`scoring_run_sources`, `match_corrections`). Supabase default privileges grant `anon`/`authenticated` ALL on them before the explicit revokes run. Same `auto_expose_new_tables` issue as §3.3. |
| 5.2 | **blocker (design)** | `match_corrections` binds exactly one immutable `draft_revision_id` and is `unique(official_result_id)`. It cannot model **numbered retry attempts** after a rejected correction lineup. Requires migration 7. |
| 5.3 | **blocker (design)** | `fork_result` creates a **new result revision on every call**. A retried network request produces duplicate drafts. Requires migration 8 for persisted idempotency. `005` locking does not deduplicate. |
| 5.4 | **verify** | `create constraint trigger require_run_source … deferrable initially deferred` must actually be deferred on the target; confirm via `pg_trigger`. |
| 5.5 | **verify** | The prototype functions are `SECURITY DEFINER` with no `EXECUTE` grant to `authenticated`; all mutation is unreachable — which is the intended fail-closed state. Do not add grants before §3.10 is satisfied. |
| 5.6 | **blocker (design)** | No scoring algorithm exists. `match_player_performances`, `fantasy_score_items`, `fantasy_scores` writes are blocked by trigger. Runs can never become `complete`. This is intentional and must survive into executable form. |

### 3.6 `005_concurrency_hardening.sql`

| # | Severity | Required change |
|---|---|---|
| 6.1 | **verify** | The design **requires `READ COMMITTED`** and rejects other isolation levels with `25001`. PostgREST's default isolation and pooler transaction mode must be confirmed on the target; this is a runtime prerequisite, not a schema one. |
| 6.2 | **blocker (design)** | Locking is not idempotency. Repeated result forks still create new drafts. Migration 8 is required before exposure. |
| 6.3 | **blocker (design)** | Deadlock (`40P01`) requires whole-transaction retry by the caller. No caller exists. Any future RPC must implement retry, and no grant may be added before it does. |
| 6.4 | **verify** | The overlap preflight `raise exception 'conflicting roster registrations exist'` will abort on **any** existing conflicting data. Executable only against a pristine target, and only after the preflight is confirmed to be a deliberate gate rather than an error. |
| 6.5 | **verify** | The no-cross-team-overlap invariant is trigger + advisory-lock based, not an exclusion constraint. A reviewed `btree_gist` exclusion constraint is recommended before scale; not present here. |

### 3.7 `006_revision_lineage.sql`

| # | Severity | Required change |
|---|---|---|
| 7.1 | **blocker — the pristine-database requirement** | The file opens with a `DO` block that **raises `23514` if `public.match_revisions` contains any row**: *"revision lineage cannot be inferred for existing data; human migration review required."* This is deliberate: `001`–`005` never persisted fork lineage, so any backfill would invent provenance. **`006` may only be applied to a pristine database.** Any non-empty target needs a separate, audited backfill and an explicitly reviewed rollback plan, and must not use this file. |
| 7.2 | **blocker (design)** | Adds lineage columns only. It does not add correction-attempt records or fork idempotency (migrations 7–8). |
| 7.3 | **verify** | Replaces `fork_result` and re-grants a fixed list of helper functions. The regrant list must be re-verified after migration 9 introduces the explicit owner. |
| 7.4 | **verify** | Adds a composite FK to `match_approvals(league_id,match_id,id,revision_id)` that depends on the unique constraint added earlier in the same file. Confirm constraint validation order on the real stack. |

### 3.8 Prerequisites to verify on the target

| Prerequisite | Status in this phase |
|---|---|
| `auth` schema and `auth.uid()` | Design depends on it (46 uses). The function reads `request.jwt.claim.sub`; on Supabase it is supplied by the Auth service. The PGlite/mock stand-in is **not** evidence. `auth.users(id)` must exist for the `profiles` FK, and the migration role needs schema access to `auth` — confirmed as a real requirement in the local emulation (`permission denied for schema auth`). |
| `storage` schema and policies | Bucket insert and `storage.objects` policy are separate privileges; the policy needs Storage ownership (4.2). |
| Roles and grants | `anon`, `authenticated`, `service_role`, `authenticator`, `supabase_auth_admin`, `supabase_storage_admin` and default privileges are platform-managed. The `postgres` migration role is **not** a superuser and does **not** own `auth`/`storage` objects. Design must not assume otherwise. |
| PostgreSQL version | Committed config targets `major_version = 17`. Phase 2A evidence was PostgreSQL 15.18 and PGlite 0.5.16 (PostgreSQL 18.6). **None of these is PostgreSQL 17.** Replay on 17 is a Phase 2B.2 task. |
| Migration ownership and function security | Not assigned anywhere in the drafts. 59 `SECURITY DEFINER` functions all pin `search_path` (verified). Ownership must be created and assigned by migration 9. |

## 4. Pristine-database requirement (explicit)

Migration `006` **cannot** run against a database that contains any `match_revisions` row. This is a hard gate, not a warning:

- Phase 2B.2 replay, and any later deployment, target a **newly provisioned, empty** project.
- Replay must be verified from an empty database with `npx supabase db reset`, repeated at least twice, to prove the whole ordered set is idempotent from scratch.
- A reused or populated database requires a separate audited lineage backfill, a reviewed rollback plan, and explicit human approval. `006` must not be reused for that case.
- Migration 7 (correction attempts) must also refuse to invent history: it must fail closed on any pre-existing `match_corrections` row rather than synthesise attempt numbers.

## 5. Mandatory before match workflows are exposed

These are **implementation blockers**, not open design questions. Both remain mandatory and neither is implemented by `001`–`006`.

### 5.1 Correction-attempt records

A correction case is currently one immutable `match_corrections` row with one `draft_revision_id`. The approved contract requires:

- an append-only **correction-attempt relation** linking: correction case → attempt number → exact lineup revision, submission, decision and prior attempt;
- rejection preserved as final; the next numbered attempt copied from the rejected snapshot **within the same open case**;
- only the latest attempt may be approved or source a result;
- a new case is never opened for a retry while the old case is unresolved.

Required tests before exposure: rejection→retry numbering, stale-attempt rejection, "only latest attempt eligible", superseded attempt cannot source a result, and no cross-case reuse.

### 5.2 Persisted result-fork idempotency

The stable business key is `(league_id, match_id, workflow_case_id, lineup_approval_id, result_attempt_no)`, plus a unique request UUID for attempt creation. The persisted record stores the one result revision the key created.

- Same key + same payload ⇒ return the stored revision, never a second draft.
- Same key + different payload ⇒ fail with a conflict.
- `006`'s `fork_result` creates a new revision on every call, so this must be added, not assumed.
- Retry after `40P01` must reuse the same key.

Required tests before exposure: same-key concurrent replay, sequential replay, payload mismatch, and a persisted unique constraint that makes duplicate forks impossible rather than unlikely.

## 6. What this phase did *not* do

- No Supabase project created, linked, contacted, or queried.
- No SQL executed against any persistent database. The only SQL in this phase ran against a disposable, in-memory PGlite instance and a throwaway `/tmp` PostgreSQL cluster that has been destroyed.
- No migration applied, no remote push, no `supabase start`.
- No design draft modified (checksums verified by `npm run check:migrations`).
- No frontend behaviour changed; Demo mode untouched.
- No secrets created, stored or committed.

See [the CLI setup and verification record](phase-2b1-supabase-cli-setup.md) and [the Phase 2B.1 report](phase-2b1-report.md).

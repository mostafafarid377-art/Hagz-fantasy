# Phase 2B.2 — Migration package (supersedes the Phase 2B.1 proposal)

> **Status: design and preparation only. No Supabase project was contacted, linked, or migrated. No migration was applied to any persistent database. Nothing in this package is executable yet.**
>
> The six Phase 2A drafts in [`supabase/design/migrations/`](../../supabase/design/migrations) are **unchanged** (checksums enforced by `npm run check:migrations`). Four new design additions (`007`–`010`) implement the Phase 2A.5 contracts that `001`–`006` deliberately left unimplemented.

Companion documents: [grants and function security](phase-2b2-grants-and-function-security.md) · [Storage ownership](phase-2b2-storage-ownership.md) · [report](phase-2b2-report.md).

> **Superseded for deployment decisions by Phase 2B.5.** See [`docs/phase-2b/phase-2b5-final-report.md`](phase-2b/phase-2b5-final-report.md).
>
> Superseded earlier by Phase 2B.4. The authoritative documents are now in [`docs/phase-2b/`](phase-2b/): [final migration audit](phase-2b/phase-2b4-final-migration-audit.md) · [function ownership decisions](phase-2b/phase-2b4-function-ownership-decisions.md) · [storage execution runbook](phase-2b/phase-2b4-storage-execution-runbook.md) · [recovery runbook](phase-2b/phase-2b4-recovery-runbook.md). This document remains the historical record of the 2B.2 ordering rationale.

## 1. The ten-migration sequence

Executable names are `<UTC timestamp>_<name>.sql`; the CLI assigns timestamps via `npx supabase migration new <name>`. **Ordering is the contract, not the numbers.** Every executable file must be a *reviewed* migration traced back to its source, never a blind copy.

| # | Proposed filename | Source | Contents | Status |
|---|---|---|---|---|
| 1 | `…_baseline_001_schema.sql` | `001_schema.sql` | 36 tables, constraints, indexes | design draft, reviewed |
| 2 | `…_baseline_002_security.sql` | `002_security.sql` | `ff_private` read helpers, RLS enablement, revokes | design draft, reviewed |
| 3a | `…_baseline_003a_storage_bucket.sql` | `003_storage.sql` (part 1) | bucket row + `can_read_image` + grants **only** | design draft, split |
| 3b | *owner-authorized step* | `003_storage.sql` (part 2) | `create policy … on storage.objects`, run as `supabase_storage_admin` | **not a CLI migration** — see [storage ownership](phase-2b2-storage-ownership.md) |
| 4 | `…_baseline_004_integrity_workflows.sql` | `004_integrity_workflows.sql` | integrity triggers, match workflows, correction case | design draft, reviewed |
| 5 | `…_baseline_005_concurrency_hardening.sql` | `005_concurrency_hardening.sql` | locking, authorization hardening | design draft, reviewed |
| 6 | `…_baseline_006_revision_lineage.sql` | `006_revision_lineage.sql` | exact lineage + **pristine-database guard** | design draft, reviewed |
| 7 | `…_correction_attempts.sql` | **`007_correction_attempts.sql`** (new) | immutable numbered attempts | **implemented this phase** |
| 8 | `…_result_fork_idempotency.sql` | **`008_result_fork_idempotency.sql`** (new) | persisted fork idempotency | **implemented this phase** |
| 9 | `…_ownership_and_grants.sql` | **`009_ownership_and_grants.sql`** (new) | least-privilege owner, explicit grants | **implemented this phase** |
| 10 | `…_privilege_verification.sql` | **`010_privilege_verification.sql`** (new) | assertions that fail the deploy | **implemented this phase** |

### Why the order is exactly this

- **1→6 preserve the reviewed baseline one draft per file**, so a failure is attributable to one draft.
- **7 must follow 6** because it re-defines `require_latest_corrected_lineup` (from 004) and `guard_submission_generation` / `validate_approval` (from 005), and depends on `006`'s `lineage` columns and on `match_approvals`' `unique(league_id,match_id,id,revision_id)`. It is an *addition*, never an edit to 6.
- **8 must follow 7** because a result fork's eligible source is the latest **correction attempt's** approval, via `ff_private.result_source_lineup_approval`, which reads `match_correction_attempts`. It also drops `006`'s two-argument `fork_result`.
- **9 must be last among grant work** because it revokes and re-grants across every object; running it earlier would be undone by later `grant select` statements.
- **10 must be last overall**, because it asserts the end state of everything above it.
- **3b cannot be a CLI migration** (ownership), so it sits beside 3a and is verified by 10.

### Registration, not execution

Creating these files with `supabase migration new` writes `supabase/migrations/<ts>_<name>.sql`. That directory is deliberately absent and guarded (`npm run check:migrations` fails if any SQL appears there). It stays empty until Phase 2B.3 has a container runtime and runs the replay gate.

## 2. `006`'s pristine-database guard — kept and verified

`006` raises `23514` if `public.match_revisions` contains any row: *"revision lineage cannot be inferred for existing data; human migration review required."* Verified on PostgreSQL 17.6 this phase:

| Scenario | Result |
|---|---|
| `006` applied with zero `match_revisions` rows | applied |
| `006` applied with one `match_revisions` row | refused with the documented message |

`007` applies the same fail-closed principle to its own history: it refuses to invent attempt numbers for pre-existing `match_corrections` rows, because attempt 1 is created only by `007`'s own trigger. A reused database needs a separate audited backfill, not a relaxed guard.

## 3. Correction attempts — `007`

Implementing Phase 2A.5 §2. Table `match_correction_attempts` (append-only):

| Column | Meaning |
|---|---|
| `correction_id` | the immutable correction case |
| `attempt_no` | 1, 2, 3 … dense and monotonic per correction; `unique(correction_id, attempt_no)` |
| `draft_revision_id` | the exact lineup revision for this attempt; `unique`, so one revision belongs to at most one attempt |
| `prior_attempt_id` | links attempt N to attempt N−1; `unique`, so lineage is a chain |
| `created_by`, `created_at` | actor and audit time |

Constraints enforce the shape: `check((attempt_no = 1 and prior_attempt_id is null) or (attempt_no > 1 and prior_attempt_id is not null))`.

Behaviour:

- **Attempt 1 is automatic.** `record_first_correction_attempt` (AFTER INSERT on `match_corrections`) writes it atomically with the case, so a case can never exist without an attempt.
- **Rejected attempts stay historical.** A trigger makes the rows append-only (`update`/`delete` raise `23514`). Rejection is recorded on `match_submissions`/`match_approvals` exactly as 004/005 already do; nothing is rewritten.
- **Only the latest attempt may be approved.** `guard_correction_attempt_approval` rejects approving any attempt that has a higher `attempt_no` in the same correction — bound to the attempt sequence, not to `match_corrections.draft_revision_id`.
- **Retries preserve lineage.** `open_correction_attempt(league, correction)` requires the previous attempt to be *rejected* and its revision final, then copies the snapshot into a new revision with the same `corrects_revision_id` and links `prior_attempt_id`. It refuses to open an attempt while a current official result resolves the case, or while the client is not an active leader.
- **One open case per match.** `guard_single_open_correction` rejects a second correction case while an earlier one is unresolved.

Three 004/005 functions are **replaced** so they derive the required correction revision from the attempt sequence instead of `match_corrections.draft_revision_id` (which is always attempt 1):

| Replaced | Why it had to change |
|---|---|
| `require_latest_corrected_lineup` | Otherwise attempt 2+ could never be the "latest corrected lineup" |
| `guard_submission_generation` | Otherwise the attempt-2 draft is judged a stale submission |
| `validate_approval` | **Found by test**: 005 ordered corrections by `draft_revision_id`, so approving attempt 2 raised `stale lineup submission after correction` |

Ordering uses the attempt's **revision version** (`order by v.version desc`), which is unique per match, rather than timestamps — a timestamp tie inside one transaction made ordering nondeterministic.

## 4. Result-fork idempotency — `008`

Implementing Phase 2A.5 §3. Table `match_result_forks` (append-only):

| Key | Purpose |
|---|---|
| `unique(league_id, match_id, workflow_case_id, lineup_approval_id, result_attempt_no)` | the **stable business key**; makes a duplicate logical fork impossible rather than unlikely |
| `unique(request_id)` | the client request UUID; a retried attempt-creation cannot allocate two attempt numbers |
| `unique(result_revision_id)` | one result revision per mapping |
| `unique(prior_fork_id)` | attempt chain |
| `check((result_attempt_no = 1 and prior_fork_id is null) or (result_attempt_no > 1 and prior_fork_id is not null))` | shape |

`fork_result(p_league, p_lineup_approval, p_request_id)`:

1. **Replay before anything else** — if `request_id` already exists, return its `result_revision_id`. A different `(league, approval)` payload with the same request id is a `23514` conflict.
2. Authorize the assigned organizer, lock the match, re-check the exact lineup is current (`006`'s `require_current_lineup`).
3. Resolve the workflow case (`match_corrections` id, or a stable `md5('ff-initial-result-case:…')` for initial results) and require the approval to be `result_source_lineup_approval` — the latest **correction attempt's** approval, else the latest approved lineup.
4. Derive `result_attempt_no` from the persisted key, and if it is > 1 require the previous attempt's result submission to have been **rejected**.
5. Copy the revision and children, then insert the key→revision mapping and the audit row **in the same transaction**, so the mapping and the draft cannot diverge.
6. A concurrent same-key fork blocks on the unique index, then aborts and retries; the retry hits step 1 and returns the committed revision.

**The two-argument `fork_result` is dropped**, with an explicit comment: a fork without a request key cannot be idempotent, so keeping the old signature would keep the defect. `010` asserts the old signature is gone.

## 5. Grants, ownership and verification — `009`/`010`

Summarised here; full detail in [grants and function security](phase-2b2-grants-and-function-security.md).

- `009` revokes the historical Supabase default grants defensively, creates `ff_migration_owner` (`nologin nobypassrls noinherit`), and asserts the intended model table by table: **`anon` nothing, `authenticated` `SELECT` only**, `TRUNCATE`/`REFERENCES`/`TRIGGER` explicitly revoked. It closes `EXECUTE` on every function and re-grants only the ten read helpers.
- `010` is assertions only: reviewed tables exist, `anon` holds no table privilege, `authenticated` holds nothing but `SELECT`, RLS is on everywhere, no definer function is reachable by `anon`/`PUBLIC`, every definer function pins `search_path`, only ten functions are client-executable, the definer owner is not a login role and has no `BYPASSRLS`, the storage policy exists and is `SELECT`-only, and no API role inherits the definer owner.

`010` is what caught a real defect this phase: `008` initially created no table because of a composite-FK mismatch, and `009`/`010` continued silently until the existence assertion was added.

## 6. Per-draft readiness after this phase

| Draft | Ready to become executable? | Remaining blockers |
|---|---|---|
| `001_schema.sql` | **Not yet** | Aggregate/business rules (squad, budget, formation, deadline, transfer) are still enforced only by future RPCs; money units (×1,000,000) and PostgREST numeric precision undocumented; PostgreSQL 17 replay now evidenced locally but not on Supabase. |
| `002_security.sql` | **Not yet** | Must never be deployed alone — `004` narrows its organizer reads. Definer **ownership reassignment** still pending (§7). |
| `003_storage.sql` | **Split as 3a/3b** | Policy needs the owner-authorized step; not verified on Supabase. |
| `004_integrity_workflows.sql` | **Not yet** | No scoring engine; runs can never complete (intentional). Owner reassignment pending. |
| `005_concurrency_hardening.sql` | **Not yet** | Requires `READ COMMITTED` at runtime and whole-transaction retry on `40P01`; no caller exists. Roster preflight aborts on pre-existing conflicts. |
| `006_revision_lineage.sql` | **Not yet** | Pristine-only (verified). Owner reassignment pending. |
| `007_correction_attempts.sql` | **Implemented, not executable** | Covered by PGlite + PG17 tests; needs the replay gate and ownership reassignment. |
| `008_result_fork_idempotency.sql` | **Implemented, not executable** | Same. |
| `009_ownership_and_grants.sql` | **Implemented, not executable** | Asserted against the mock; the hosted effect of `alter default privileges for role postgres` is unverified. |
| `010_privilege_verification.sql` | **Implemented, not executable** | Must be run last; will fail (by design) until 3b has run on a real project. |

## 7. Remaining blockers

**Before any match workflow is exposed:**

1. **Definer ownership reassignment.** `009` creates `ff_migration_owner` but does not yet `alter function … owner to ff_migration_owner`. Deliberately deferred: it changes the definer context for all 56 privileged functions at once and must be exercised against the privileged-path tests. Proposed as Phase 2B.3 task 1.
2. **Storage policy 3b execution path.** The owner-authorized step is documented but has never been executed on a real project.
3. **Runtime requirements with no caller.** `READ COMMITTED` enforcement, `40P01` whole-transaction retry, and PostgREST error mapping for the new `23514` conflicts.

**Product/operational, unchanged from Phase 2A:**

4. Scoring inputs and values, event/bench/vice semantics, standings default and ties, correction UI, duplicate-person/guest eligibility, role delegation, schedule/time-zone, invitations, retention/consent, media moderation, anti-abuse/rate limits, operator recovery, image lifecycle.
5. Aggregate enforcement for squads/budgets/formations/deadlines remains unimplemented.
6. Money unit conversion and exact-numeric transport to JS.

## 8. Verification performed this phase

| Gate | Result |
|---|---|
| Six Phase 2A drafts byte-identical | ✅ checksums unchanged, enforced by the guard |
| Ten-migration chain on PostgreSQL **17.6** (Supabase-like bootstrap) | ✅ all applied |
| Ten-migration chain on PostgreSQL **17.6** (mock `setup.sql`) | ✅ all applied |
| `006` pristine guard | ✅ refuses populated `match_revisions`, accepts empty |
| PGlite design tests | ✅ 42/42 |
| Native PG17 suites (existing + new) | ✅ 25 + 29 + 13 + 11 pass |
| Unit / typecheck / build / Pages assets | ✅ see report |
| Migration package guard | ✅ 17/17 |

**No Supabase compatibility is claimed.** These runs use a disposable local PostgreSQL 17.6 cluster and in-memory PGlite. They do not exercise Supabase Auth JWT issuance, PostgREST, the real Storage service, hosted role inheritance, or concurrent sessions across a pooler.

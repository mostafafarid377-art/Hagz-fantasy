# Phase 2B.4 — SECURITY DEFINER ownership decisions

A per-function ownership decision for all **56** `SECURITY DEFINER` functions, with the reason each one needs the owner it does. Supersedes the 2B.3 matrix as the decision record; the 2B.3 document remains the measurement record.

**No ownership transfer is performed in this phase.** No migration in `001`–`010` contains a single `OWNER TO` statement — verified by grep. This document defines what the transfer would be, and why each function is safe under it.

## 1. The decision

**All 56 receive the same decision: transfer to `ff_migration_owner`.** There is no exception, and the reason is structural rather than per-function: every one of them lives in `ff_private` and is either a client-facing read helper, an internal workflow step, or a trigger body. None is an extension, none is owned by a platform role, and none needs table ownership.

But "all transfer" is **not** the same as "all bulk-transfer is safe to do blind". The grouping below carries the per-function reasoning, and §4 lists the functions that need more test coverage first.

### The role they transfer to

`ff_migration_owner` — `NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE **BYPASSRLS**`, owning **nothing**, reachable only as a definer.

`BYPASSRLS` is not incidental. Every policy in this design is `to authenticated`; under a `SECURITY DEFINER` function the current role is the *definer*, not `authenticated`, so no policy applies. Measured in Phase 2B.3: with `NOBYPASSRLS`, all ten read helpers return `false` for legitimate users **silently**. See [the 2B.3 report](../phase-2b3-report.md) §4.

## 2. Decision categories

| Category | Count | Decision | Why this owner |
|---|---|---|---|
| Read helpers | 10 | **Transfer** | They must read rows the caller's own RLS would hide (membership, roster, lineage). Only a definer that `BYPASSRLS` can do this. |
| Internal workflow / RPC support | 20 | **Transfer** | Not client-executable. Each mutating path re-validates the caller itself, so the definer is not the authorization boundary. |
| Trigger functions | 26 | **Transfer** | Never invoked directly; they derive everything from `NEW`/`OLD` and run inside the caller's statement. |

## 3. Function-by-function assignment

Columns: **Calls `auth.uid()`** = validates caller identity itself. **Tables** = `public` relations referenced. All 56 pin `search_path = pg_catalog, ff_private`; none uses dynamic SQL (verified, see the [final audit](phase-2b4-final-migration-audit.md) §4).

| Function | Group | Calls `auth.uid()` | Tables | Decision | Why this owner |
|---|---|---|---|---|---|
| `can_read_image` | helper | yes | 2 | Transfer | Reads membership/roster rows the caller's own RLS hides. **Requires `BYPASSRLS` on the definer** — this is the group that breaks silently without it. |
| `can_read_lineup` | helper | no | 1 | Transfer | Reads membership/roster rows the caller's own RLS hides. **Requires `BYPASSRLS` on the definer** — this is the group that breaks silently without it. |
| `can_read_match` | helper | no | 1 | Transfer | Reads membership/roster rows the caller's own RLS hides. **Requires `BYPASSRLS` on the definer** — this is the group that breaks silently without it. |
| `can_read_revision` | helper | no | 1 | Transfer | Reads membership/roster rows the caller's own RLS hides. **Requires `BYPASSRLS` on the definer** — this is the group that breaks silently without it. |
| `can_read_suggestion` | helper | yes | 1 | Transfer | Reads membership/roster rows the caller's own RLS hides. **Requires `BYPASSRLS` on the definer** — this is the group that breaks silently without it. |
| `is_leader` | helper | yes | 1 | Transfer | Reads membership/roster rows the caller's own RLS hides. **Requires `BYPASSRLS` on the definer** — this is the group that breaks silently without it. |
| `is_match_organizer` | helper | yes | 3 | Transfer | Reads membership/roster rows the caller's own RLS hides. **Requires `BYPASSRLS` on the definer** — this is the group that breaks silently without it. |
| `is_member` | helper | yes | 1 | Transfer | Reads membership/roster rows the caller's own RLS hides. **Requires `BYPASSRLS` on the definer** — this is the group that breaks silently without it. |
| `is_organizer` | helper | yes | 2 | Transfer | Reads membership/roster rows the caller's own RLS hides. **Requires `BYPASSRLS` on the definer** — this is the group that breaks silently without it. |
| `owns_team` | helper | yes | 2 | Transfer | Reads membership/roster rows the caller's own RLS hides. **Requires `BYPASSRLS` on the definer** — this is the group that breaks silently without it. |
| `authorize_temporary` | internal | yes | 1 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `fork_result` | internal | yes | 8 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `latest_correction_attempt` | internal | no | 1 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `latest_match_correction_attempt` | internal | no | 2 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `lock_roster_player` | internal | no | 0 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `open_correction` | internal | yes | 6 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `open_correction_attempt` | internal | yes | 10 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `record_event` | internal | yes | 3 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `require_current_lineup` | internal | no | 2 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `require_latest_corrected_lineup` | internal | no | 2 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `require_leader` | internal | yes | 1 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `require_organizer` | internal | yes | 3 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `result_source_lineup_approval` | internal | no | 3 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `result_workflow_case` | internal | no | 1 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `review_submission` | internal | yes | 3 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `set_result_score` | internal | yes | 3 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `start_scoring` | internal | yes | 8 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `submit_lineup` | internal | yes | 2 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `submit_result` | internal | yes | 2 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `validate_lineups` | internal | no | 6 | Transfer | Client-unreachable. Each mutating path validates the caller itself (`auth.uid()` or `require_leader`/`require_organizer`), so the definer context is not the authorization boundary. |
| `after_approval` | trigger | yes | 3 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `after_correction` | trigger | yes | 7 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `after_submission` | trigger | yes | 2 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `guard_correction_attempt_approval` | trigger | no | 1 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `guard_lineup_roster_lock` | trigger | no | 3 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `guard_official_result` | trigger | yes | 5 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `guard_result_revision_lineage` | trigger | no | 3 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `guard_review_lineage` | trigger | no | 3 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `guard_revision_child` | trigger | no | 7 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `guard_roster_history` | trigger | no | 3 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `guard_roster_overlap` | trigger | no | 1 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `guard_rules` | trigger | no | 1 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `guard_run` | trigger | yes | 4 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `guard_run_source` | trigger | no | 5 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `guard_single_open_correction` | trigger | no | 3 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `guard_standings` | trigger | no | 0 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `guard_submission_generation` | trigger | no | 4 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `guard_submission_lineage` | trigger | no | 2 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `guard_temp_authorization` | trigger | yes | 2 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `protect_match_metadata` | trigger | no | 3 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `protect_revision` | trigger | no | 2 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `record_first_correction_attempt` | trigger | no | 1 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `require_run_source` | trigger | no | 2 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `validate_approval` | trigger | yes | 6 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `validate_correction` | trigger | yes | 3 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
| `validate_submission` | trigger | yes | 6 | Transfer | Never called directly; bound to a trigger and derives everything from `NEW`/`OLD`. `EXECUTE` revoked from all client roles. |
## 4. Functions that must NOT be transferred

**None, by category** — but three must not be transferred *by the mechanism originally proposed*, and this is the important distinction:

| Function(s) | Must not happen | Why |
|---|---|---|
| All 56 | **Must not be transferred to a `NOBYPASSRLS` role** | The ten helpers would silently return `false` for every legitimate user. This was the 2B.2 plan and it was wrong. |
| All 56 | **Must not be transferred in the same transaction as grant changes** | If it fails, you cannot tell whether the definer or the grants are at fault; and a partial mix is the silent-false failure mode. |
| All 56 | **Must not be transferred without `010` passing afterwards** | `010` is the only control that would catch a revert to the broken model. |
| `ff_private.can_read_image` | Must not be transferred while `003`'s storage policy is unapplied | It is referenced by the `storage.objects` policy; a broken definer would deny all image access with no error. |
| `ff_private.guard_submission_generation`, `validate_approval`, `require_latest_corrected_lineup` | Must not be transferred before the correction-attempt tests run under the new owner | These are the three functions `007` replaced; they are the most behaviour-sensitive in the package. |

## 5. Functions requiring additional tests before transfer

The 2B.3 suite already covers, under a `BYPASSRLS` definer: caller identity (including null), membership revocation, role revocation, cross-league isolation, `search_path` hijacking, and the full `EXECUTE` surface. These are the **gaps that remain**:

| Function | Gap | Why it matters |
|---|---|---|
| `fork_result` | No test exercises the replay/idempotency path **under the new owner** | 8 tables, most complex read path in the package; a definer-visible-but-RLS-hidden distinction could change which fork source resolves |
| `open_correction_attempt` | Same — 10 tables, the largest surface | Attempt lineage depends on reads across corrections the caller cannot see |
| `start_scoring` | 8 tables; no test calls it under a transferred owner | Scoring run sources are read across leagues |
| `can_read_image` | Never tested against real `storage.objects` rows or real object names | Its regex has only been exercised on synthetic names; the policy that uses it cannot be validated locally |
| `record_event` | No test | Writes match events; the only writer path with an `auth.uid()` check plus a trigger cascade |
| `guard_standings`, `lock_roster_player` | Zero referenced tables (pure computation / advisory lock) | Low risk, but a definer with no table reads is an oddity worth confirming is intentional |

**Recommended gating:** write `011_definer_ownership_transfer.sql` (all 56, one reviewed transaction, no grant changes), then run the full suite plus an end-to-end workflow pass **under the transferred owner** before any deployment. That is Phase 2B.5 work and is deliberately not done here.

## 6. Why not the alternatives

| Alternative | Measured outcome | Verdict |
|---|---|---|
| Leave functions owned by the migration role (= table owner) | Works today; posture is implicit and the definer is a near-superuser role | Rejected — works by accident of ownership, not by design |
| Transfer **table** ownership to `ff_migration_owner` | Works, but gives the definer durable DDL authority over application data | Rejected — worse than the problem |
| `NOBYPASSRLS` + explicit grants | **All ten helpers silently `false`** | Rejected — this is the trap |
| Per-function different owners | No function has a reason to differ | Rejected — needless complexity and 56 review surfaces |

## 7. Summary

- **56 / 56: transfer to `ff_migration_owner` (`BYPASSRLS`, owns nothing)** — one decision, justified per group.
- **0 functions must not be transferred**, but **all 56 must not** be transferred to a `NOBYPASSRLS` role, in the same transaction as grant changes, or without `010` passing.
- **7 functions need additional tests first** (`fork_result`, `open_correction_attempt`, `start_scoring`, `can_read_image`, `record_event`, `guard_standings`, `lock_roster_player`).
- **Nothing is transferred in Phase 2B.4.** The transfer is a separate, gated migration.

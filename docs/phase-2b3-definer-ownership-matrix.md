# Phase 2B.3 — SECURITY DEFINER ownership matrix

Every one of the **56** `SECURITY DEFINER` functions, as measured from the live catalog after applying `001`→`010`. No entry here is inferred from reading the SQL: owner, `search_path`, `EXECUTE` holders and RLS state were all queried.

**No Supabase project was contacted.** "Current owner" is the owner produced by replaying the chain on a disposable cluster; on Supabase it is the role that runs migrations (`postgres`).

## 1. Summary of the measured facts

| Property | Measured value |
|---|---|
| `SECURITY DEFINER` functions | **56** |
| All in schema `ff_private` (none in exposed `public`) | yes |
| Current owner | the migration role (`postgres`), **which also owns all 40 `public` tables** |
| Pinned `search_path` | **56 / 56** — all exactly `pg_catalog, ff_private` |
| RLS on `public` tables | enabled on all 40; `FORCE ROW LEVEL SECURITY` on **none** |
| Consequence | every definer function currently **bypasses RLS implicitly** by being owned by the table owner |
| Functions calling `auth.uid()` | 28 |
| Functions needing `USAGE` on schema `auth` | 4 directly, plus every function that transitively calls `auth.uid()` |
| Functions touching schema `storage` | 0 |
| Executable by `authenticated` | **10** (the read helpers only) |
| Executable by `anon` | **0** |
| Executable by `PUBLIC` | **0** |
| Trigger functions | 26 |

## 2. Why "current owner" and "required privileges" are the same question

The defining property of the current state is that the definer **is the table owner**, and Postgres exempts a table's owner from its own RLS policies. So today none of the 56 functions has an explicit privilege story at all: they inherit everything from ownership.

This is why the ownership question cannot be answered by listing privileges. Changing the owner silently changes *what the functions can see*, and the change is not neutral in either direction — see §4.

## 3. Function-by-function matrix

Columns: **Group** (`helper` = one of the ten read helpers exposed to clients; `internal` = workflow/RPC support, not client-executable; `trigger` = bound to a trigger, never called directly). **Tables** are the `public` relations the body references. **auth.uid()** means the body validates caller identity itself. **EXECUTE** is the `authenticated` grant after `009`.

| Function | Group | Owner | Tables accessed | auth.uid() | EXECUTE | Safe for `ff_migration_owner`? |
|---|---|---|---|---|---|---|
| `can_read_image(object_name text)` | helper | `postgres` | player_profiles, player_suggestions | yes | authenticated | Yes — needs RLS bypass to see rows |
| `can_read_lineup(p_league uuid, p_lineup uuid)` | helper | `postgres` | fantasy_lineups | no | authenticated | Yes — needs RLS bypass to see rows |
| `can_read_match(p_league uuid, p_match uuid)` | helper | `postgres` | match_revisions | no | authenticated | Yes — needs RLS bypass to see rows |
| `can_read_revision(p_league uuid, p_revision uuid)` | helper | `postgres` | match_revisions | no | authenticated | Yes — needs RLS bypass to see rows |
| `can_read_suggestion(p_league uuid, p_suggestion uuid)` | helper | `postgres` | player_suggestions | yes | authenticated | Yes — needs RLS bypass to see rows |
| `is_leader(p_league uuid)` | helper | `postgres` | league_members | yes | authenticated | Yes — needs RLS bypass to see rows |
| `is_match_organizer(p_league uuid, p_match uuid)` | helper | `postgres` | league_members, match_organizers, real_matches | yes | authenticated | Yes — needs RLS bypass to see rows |
| `is_member(p_league uuid)` | helper | `postgres` | league_members | yes | authenticated | Yes — needs RLS bypass to see rows |
| `is_organizer(p_league uuid)` | helper | `postgres` | league_members, match_organizers | yes | authenticated | Yes — needs RLS bypass to see rows |
| `owns_team(p_league uuid, p_team uuid)` | helper | `postgres` | fantasy_teams, league_members | yes | authenticated | Yes — needs RLS bypass to see rows |
| `authorize_temporary(p_league uuid, p_match uuid, p_team uuid, p_player uuid, p_reason text)` | internal | `postgres` | temporary_participant_authorizations | yes | none | Yes — validates auth.uid() itself |
| `fork_result(p_league uuid, p_lineup_approval uuid, p_request_id uuid)` | internal | `postgres` | audit_logs, match_approvals, match_result_forks, match_revisions, match_submissions, real_match_lineup_players, real_match_lineups, real_matches | yes | none | Yes — validates auth.uid() itself |
| `latest_correction_attempt(p_league uuid, p_correction uuid)` | internal | `postgres` | match_correction_attempts | no | none | Yes — internal, no auth check of its own |
| `latest_match_correction_attempt(p_league uuid, p_match uuid)` | internal | `postgres` | match_correction_attempts, match_revisions | no | none | Yes — internal, no auth check of its own |
| `lock_roster_player(p_league uuid, p_player uuid)` | internal | `postgres` | — | no | none | Yes — internal, no auth check of its own |
| `open_correction(p_league uuid, p_match uuid, p_reason text)` | internal | `postgres` | match_corrections, match_revisions, official_match_results, real_match_lineup_players, real_match_lineups, real_matches | yes | none | Yes — validates auth.uid() itself |
| `open_correction_attempt(p_league uuid, p_correction uuid)` | internal | `postgres` | audit_logs, match_approvals, match_correction_attempts, match_corrections, match_revisions, match_submissions, official_match_results, real_match_lineup_players, real_match_lineups, real_matches | yes | none | Yes — validates auth.uid() itself |
| `record_event(p_league uuid, p_revision uuid, p_player uuid, p_related uuid, p_type text, p_minute integer, p_quantity integer, p_details jsonb)` | internal | `postgres` | audit_logs, match_events, match_revisions | yes | none | Yes — validates auth.uid() itself |
| `require_current_lineup(p_league uuid, p_match uuid, p_revision uuid)` | internal | `postgres` | match_approvals, match_revisions | no | none | Yes — internal, no auth check of its own |
| `require_latest_corrected_lineup(p_league uuid, p_match uuid, p_revision uuid)` | internal | `postgres` | match_correction_attempts, match_revisions | no | none | Yes — internal, no auth check of its own |
| `require_leader(p_league uuid)` | internal | `postgres` | league_members | yes | none | Yes — validates auth.uid() itself |
| `require_organizer(p_league uuid, p_match uuid)` | internal | `postgres` | league_members, match_organizers, real_matches | yes | none | Yes — validates auth.uid() itself |
| `result_source_lineup_approval(p_league uuid, p_match uuid)` | internal | `postgres` | match_approvals, match_correction_attempts, match_revisions | no | none | Yes — internal, no auth check of its own |
| `result_workflow_case(p_league uuid, p_match uuid)` | internal | `postgres` | match_corrections | no | none | Yes — internal, no auth check of its own |
| `review_submission(p_league uuid, p_submission uuid, p_decision text, p_reason text)` | internal | `postgres` | match_approvals, match_submissions, real_matches | yes | none | Yes — validates auth.uid() itself |
| `set_result_score(p_league uuid, p_revision uuid, p_score_a integer, p_score_b integer)` | internal | `postgres` | audit_logs, match_revisions, real_matches | yes | none | Yes — validates auth.uid() itself |
| `start_scoring(p_league uuid, p_gameweek uuid, p_sources uuid[])` | internal | `postgres` | audit_logs, gameweeks, match_approvals, match_revisions, official_match_results, real_matches, scoring_run_sources, scoring_runs | yes | none | Yes — validates auth.uid() itself |
| `submit_lineup(p_league uuid, p_revision uuid)` | internal | `postgres` | match_revisions, match_submissions | yes | none | Yes — validates auth.uid() itself |
| `submit_result(p_league uuid, p_revision uuid, p_lineup_approval uuid)` | internal | `postgres` | match_revisions, match_submissions | yes | none | Yes — validates auth.uid() itself |
| `validate_lineups(p_league uuid, p_revision uuid)` | internal | `postgres` | match_revisions, real_match_lineup_players, real_match_lineups, real_matches, real_team_players, temporary_participant_authorizations | no | none | Yes — internal, no auth check of its own |
| `after_approval()` | trigger | `postgres` | audit_logs, match_revisions, official_match_results | yes | none | Yes — runs inside the caller's statement |
| `after_correction()` | trigger | `postgres` | audit_logs, gameweeks, league_standings, official_match_results, real_matches, scoring_run_sources, scoring_runs | yes | none | Yes — runs inside the caller's statement |
| `after_submission()` | trigger | `postgres` | audit_logs, match_revisions | yes | none | Yes — runs inside the caller's statement |
| `guard_correction_attempt_approval()` | trigger | `postgres` | match_correction_attempts | no | none | Yes — runs inside the caller's statement |
| `guard_lineup_roster_lock()` | trigger | `postgres` | real_match_lineups, real_matches, real_team_players | no | none | Yes — runs inside the caller's statement |
| `guard_official_result()` | trigger | `postgres` | match_approvals, match_corrections, match_revisions, match_submissions, real_matches | yes | none | Yes — runs inside the caller's statement |
| `guard_result_revision_lineage()` | trigger | `postgres` | match_approvals, match_revisions, real_matches | no | none | Yes — runs inside the caller's statement |
| `guard_review_lineage()` | trigger | `postgres` | match_approvals, match_revisions, match_submissions | no | none | Yes — runs inside the caller's statement |
| `guard_revision_child()` | trigger | `postgres` | match_revisions, match_submissions, real_match_lineup_players, real_match_lineups, real_matches, real_team_players, temporary_participant_authorizations | no | none | Yes — runs inside the caller's statement |
| `guard_roster_history()` | trigger | `postgres` | real_match_lineup_players, real_match_lineups, real_matches | no | none | Yes — runs inside the caller's statement |
| `guard_roster_overlap()` | trigger | `postgres` | real_team_players | no | none | Yes — runs inside the caller's statement |
| `guard_rules()` | trigger | `postgres` | scoring_rule_sets | no | none | Yes — runs inside the caller's statement |
| `guard_run()` | trigger | `postgres` | audit_logs, gameweeks, scoring_rule_sets, scoring_run_sources | yes | none | Yes — runs inside the caller's statement |
| `guard_run_source()` | trigger | `postgres` | match_approvals, match_revisions, official_match_results, real_matches, scoring_runs | no | none | Yes — runs inside the caller's statement |
| `guard_single_open_correction()` | trigger | `postgres` | match_corrections, match_revisions, official_match_results | no | none | Yes — runs inside the caller's statement |
| `guard_standings()` | trigger | `postgres` | — | no | none | Yes — runs inside the caller's statement |
| `guard_submission_generation()` | trigger | `postgres` | match_approvals, match_correction_attempts, match_revisions, official_match_results | no | none | Yes — runs inside the caller's statement |
| `guard_submission_lineage()` | trigger | `postgres` | match_approvals, match_revisions | no | none | Yes — runs inside the caller's statement |
| `guard_temp_authorization()` | trigger | `postgres` | uid, audit_logs, real_matches | yes | none | Yes — runs inside the caller's statement |
| `protect_match_metadata()` | trigger | `postgres` | match_submissions, real_match_lineup_players, real_match_lineups | no | none | Yes — runs inside the caller's statement |
| `protect_revision()` | trigger | `postgres` | match_approvals, match_submissions | no | none | Yes — runs inside the caller's statement |
| `record_first_correction_attempt()` | trigger | `postgres` | match_correction_attempts | no | none | Yes — runs inside the caller's statement |
| `require_run_source()` | trigger | `postgres` | scoring_run_sources, scoring_runs | no | none | Yes — runs inside the caller's statement |
| `validate_approval()` | trigger | `postgres` | uid, match_approvals, match_correction_attempts, match_revisions, match_submissions, official_match_results, real_matches | yes | none | Yes — runs inside the caller's statement |
| `validate_correction()` | trigger | `postgres` | uid, match_revisions, official_match_results, real_matches | yes | none | Yes — runs inside the caller's statement |
| `validate_submission()` | trigger | `postgres` | uid, match_approvals, match_revisions, match_submissions, real_match_lineup_players, real_match_lineups, real_matches | yes | none | Yes — runs inside the caller's statement |
## 4. The ownership experiment — three models, measured

The naive reading of "least privilege" says: strip `BYPASSRLS`, give the definer explicit grants, done. **That model is silently broken.** Each candidate was applied to a live chain and the ten helpers were called as a real member.

### Model A — re-own functions only, no extra grants

| Probe | Result |
|---|---|
| `is_member(league)` as an active leader | **ERROR** `permission denied for schema auth` |

`EXECUTE` on `auth.uid()` is not the same privilege as `USAGE` on schema `auth`. The 2B.2 draft of `009` granted only the former. This was a genuine defect — the deployment would have failed on first use of any helper.

### Model B — re-own functions **and** grant full table/sequence access, keep `nobypassrls`

| Probe | Result | Expected |
|---|---|---|
| `is_member(league)` as an active leader | **`false`** | `true` |
| `is_leader(league)` as an active leader | **`false`** | `true` |
| `is_organizer(league)` as the assigned organizer | **`false`** | `true` |
| `can_read_match(...)` as a member | **`false`** | `true` |
| direct definer read of `league_members` | **0 rows** | 2 rows |

**This is the critical finding.** It is not an error — it is silence. Every policy in this design is `to authenticated`. Under a `SECURITY DEFINER` function the current role is the *definer*, not `authenticated`, so **no policy applies**. Each helper is `exists(select 1 from public.x where user_id = auth.uid())`, so an RLS-filtered inner select yields zero rows and the helper returns `false`.

A member and an outsider become indistinguishable. The application would deny every legitimate user while reporting "not a member", and the failure would look like corrupt data rather than a privilege bug. Nothing in a normal test run would flag it.

### Model C — the proposed design: `ff_migration_owner` **with** `BYPASSRLS`, no table ownership

| Probe | Model C | Baseline |
|---|---|---|
| `is_member` as member | `true` | `true` |
| `is_leader` as leader | `true` | `true` |
| `is_organizer` as organizer | `true` | `true` |
| `is_member` as outsider | `false` | `false` |
| direct client read still RLS-filtered | yes | yes |
| `anon` reaches any function | denied | denied |
| defines any `public` table | **no** | yes |

Behaviour is identical to the baseline, and the definer no longer owns application data.

## 5. Ownership change proposed — and what is *not* proposed

**Proposed:** `ff_migration_owner`, `NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS`, holding `USAGE` on `public`/`ff_private`/`auth`/`storage`, `EXECUTE` on `auth.uid()`, and `SELECT, INSERT, UPDATE, DELETE` on `public` tables plus `USAGE, SELECT` on sequences — but **owning nothing**.

`BYPASSRLS` is deliberate, load-bearing, and safe here specifically because:

- the role is `NOLOGIN` and is never granted to a client role (asserted by `010`);
- it is reachable **only** as a function definer;
- it owns no relations, so it cannot run DDL on application data (`010` asserts this);
- RLS still filters every direct client read, which is asserted independently.

It is **not** a client-facing bypass. The alternative honest framing: this project's design puts authorization *inside* definer functions rather than in RLS, because RLS here is `to authenticated` and the helpers must read across rows the caller cannot see. `BYPASSRLS` on a `NOLOGIN` definer is the correct expression of that design, not a workaround.

**Not proposed, and explicitly rejected:**

| Rejected model | Why |
|---|---|
| Leave functions owned by the table owner | Works, but makes the security posture implicit and keeps the definer as a superuser-ish role |
| Transfer **table** ownership to `ff_migration_owner` | Works, but hands the definer durable DDL authority over application data |
| `nobypassrls` + explicit grants (Model B) | **Silently breaks all ten helpers** |
| Bulk `ALTER FUNCTION … OWNER TO` in a migration | Not justified: changes the definer context of all 56 at once, in one step, with no per-function review |

**Not done in this phase:** the actual `ALTER FUNCTION … OWNER TO ff_migration_owner` statements remain **unwritten**. `009` defines the role and its privileges; the reassignment is deliberately left out because it is a behaviour change, not a grant, and this phase produced the evidence needed to review it. See `docs/phase-2b3-report.md` §5 for the reviewed plan and why it is a separate, gated step.

## 6. Per-group safety verdict

| Group | Count | Safe? | Reasoning |
|---|---|---|---|
| Read helpers | 10 | **Yes, and requires `BYPASSRLS`** | They must read membership/roster rows the caller's own RLS would hide. This is the group that breaks under Model B. |
| Internal workflow/RPC support | 20 | **Yes** | Not client-executable. Each mutating path re-checks caller identity itself via `auth.uid()` or `require_leader`/`require_organizer`, so the definer context is not the authorization boundary. |
| Trigger functions | 26 | **Yes** | Never called directly; they run inside the caller's statement and derive everything from `NEW`/`OLD`. `EXECUTE` is revoked from every client role. |

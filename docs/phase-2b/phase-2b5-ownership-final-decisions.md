# Phase 2B.5 — Final SECURITY DEFINER ownership decisions

Per-function ownership decision for all **56** `SECURITY DEFINER` functions, and the migration that implements it (`011_definer_ownership_transfer.sql`).

**No Supabase connection was made.** Every claim below was measured on PostgreSQL 17.6 or PGlite.

## 1. The decision, and why it is one decision rather than two

**All 56 functions transfer to `ff_migration_owner`.** That looks like a bulk transfer, so the §2 measurement matters: it establishes that *splitting* owners would not reduce any privilege, while *the wrong single owner* silently breaks the application.

### What was measured this phase

| Question | Measurement | Consequence |
|---|---|---|
| Does a narrow `SECURITY DEFINER` wrapper constrain a broad helper it calls? | **No.** Wrapper (`nobypassrls`) → helper (`bypassrls`) returned 2 of 2 rows; the wrapper's own direct read returned 0. | Privileges are re-evaluated **per function** against that function's own owner. A mixed-owner chain does not compose. |
| How many functions touch a table directly? | **54 of 56.** Only `guard_standings()` and `lock_roster_player()` do not — and both delegate to `require_leader` / `require_read_committed`, which do. | There is no meaningful "narrow" subset to give a different owner. |
| Is `BYPASSRLS` needed? | **Yes**, for 54 directly; for the other 2 transitively. | A `nobypassrls` definer returns `false` for every helper (2B.3, re-confirmed). |
| Does the current model already bypass RLS? | **Yes, implicitly** — the definer is the table owner, and owners bypass their own policies. | The transfer **does not add** an RLS bypass. It makes the existing one explicit and removes table *ownership*. |

### The privilege actually being granted

Before: definer = table owner ⇒ bypasses RLS **and** can run DDL on 40 tables.
After: definer owns nothing, holds `SELECT/INSERT/UPDATE/DELETE` + `BYPASSRLS` ⇒ bypasses RLS, **cannot** run DDL.

So the transfer **reduces** the definer's powers while preserving behaviour exactly. That is the whole argument, and it is why one owner is correct here rather than a compromise.

## 2. Function-by-function matrix

- **Owner** — current → proposed. Current is the migration role (the table owner); proposed is `ff_migration_owner`.
- **Change?** — every row is **Yes**, justified in §1.
- **BYPASSRLS required** — Yes for all 56 (§1).
- **EXECUTE** — post-transfer client grant. Only the ten helpers are callable by `authenticated`; nothing is callable by `anon` or `PUBLIC`.
- **Schema** — all 56 live in `ff_private`; none is in the exposed `public` schema.
- **auth.uid()** — whether the function validates caller identity itself (the remainder re-check through `require_leader`/`require_organizer` or are triggers).

| Function | Schema | Proposed owner | Change? | Tables accessed | auth.uid() | BYPASSRLS | EXECUTE | Security risk & mitigation | Tests required / existing |
|---|---|---|---|---|---|---|---|---|---|
| `after_approval()` | `ff_private` | `ff_migration_owner` | **Yes** | audit_logs, match_revisions, official_match_results | yes | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `after_correction()` | `ff_private` | `ff_migration_owner` | **Yes** | audit_logs, gameweeks, league_standings, official_match_results, real_matches, scoring_run_sources, scoring_runs | yes | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `after_submission()` | `ff_private` | `ff_migration_owner` | **Yes** | audit_logs, match_revisions | yes | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `authorize_temporary(p_league uuid, p_match uuid, p_team uuid, p_player uuid, p_reason text)` | `ff_private` | `ff_migration_owner` | **Yes** | temporary_participant_authorizations | yes | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `can_read_image(object_name text)` | `ff_private` | `ff_migration_owner` | **Yes** | player_profiles, player_suggestions | yes | **Yes** | `authenticated` | A false result silently denies a legitimate user. Covered by the before/after snapshot test. | phase2b5 §3 before/after snapshot (all 10 × 3 actors), §4 revocation, §5 search_path |
| `can_read_lineup(p_league uuid, p_lineup uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | fantasy_lineups | no | **Yes** | `authenticated` | A false result silently denies a legitimate user. Covered by the before/after snapshot test. | phase2b5 §3 before/after snapshot (all 10 × 3 actors), §4 revocation, §5 search_path |
| `can_read_match(p_league uuid, p_match uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | match_revisions | no | **Yes** | `authenticated` | A false result silently denies a legitimate user. Covered by the before/after snapshot test. | phase2b5 §3 before/after snapshot (all 10 × 3 actors), §4 revocation, §5 search_path |
| `can_read_revision(p_league uuid, p_revision uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | match_revisions | no | **Yes** | `authenticated` | A false result silently denies a legitimate user. Covered by the before/after snapshot test. | phase2b5 §3 before/after snapshot (all 10 × 3 actors), §4 revocation, §5 search_path |
| `can_read_suggestion(p_league uuid, p_suggestion uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | player_suggestions | yes | **Yes** | `authenticated` | A false result silently denies a legitimate user. Covered by the before/after snapshot test. | phase2b5 §3 before/after snapshot (all 10 × 3 actors), §4 revocation, §5 search_path |
| `fork_result(p_league uuid, p_lineup_approval uuid, p_request_id uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | audit_logs, match_approvals, match_result_forks, match_revisions, match_submissions, real_match_lineup_players, real_match_lineups, real_matches | yes | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `guard_correction_attempt_approval()` | `ff_private` | `ff_migration_owner` | **Yes** | match_correction_attempts | no | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `guard_lineup_roster_lock()` | `ff_private` | `ff_migration_owner` | **Yes** | real_match_lineups, real_matches, real_team_players | no | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `guard_official_result()` | `ff_private` | `ff_migration_owner` | **Yes** | match_approvals, match_corrections, match_revisions, match_submissions, real_matches | yes | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `guard_result_revision_lineage()` | `ff_private` | `ff_migration_owner` | **Yes** | match_approvals, match_revisions, real_matches | no | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `guard_review_lineage()` | `ff_private` | `ff_migration_owner` | **Yes** | match_approvals, match_revisions, match_submissions | no | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `guard_revision_child()` | `ff_private` | `ff_migration_owner` | **Yes** | match_revisions, match_submissions, real_match_lineup_players, real_match_lineups, real_matches, real_team_players, temporary_participant_authorizations | no | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `guard_roster_history()` | `ff_private` | `ff_migration_owner` | **Yes** | real_match_lineup_players, real_match_lineups, real_matches | no | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `guard_roster_overlap()` | `ff_private` | `ff_migration_owner` | **Yes** | real_team_players | no | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `guard_rules()` | `ff_private` | `ff_migration_owner` | **Yes** | scoring_rule_sets | no | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `guard_run()` | `ff_private` | `ff_migration_owner` | **Yes** | audit_logs, gameweeks, scoring_rule_sets, scoring_run_sources | yes | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `guard_run_source()` | `ff_private` | `ff_migration_owner` | **Yes** | match_approvals, match_revisions, official_match_results, real_matches, scoring_runs | no | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `guard_single_open_correction()` | `ff_private` | `ff_migration_owner` | **Yes** | match_corrections, match_revisions, official_match_results | no | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `guard_standings()` | `ff_private` | `ff_migration_owner` | **Yes** | (none) | no | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `guard_submission_generation()` | `ff_private` | `ff_migration_owner` | **Yes** | match_approvals, match_correction_attempts, match_revisions, official_match_results | no | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `guard_submission_lineage()` | `ff_private` | `ff_migration_owner` | **Yes** | match_approvals, match_revisions | no | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `guard_temp_authorization()` | `ff_private` | `ff_migration_owner` | **Yes** | audit_logs, real_matches | yes | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `is_leader(p_league uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | league_members | yes | **Yes** | `authenticated` | A false result silently denies a legitimate user. Covered by the before/after snapshot test. | phase2b5 §3 before/after snapshot (all 10 × 3 actors), §4 revocation, §5 search_path |
| `is_match_organizer(p_league uuid, p_match uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | league_members, match_organizers, real_matches | yes | **Yes** | `authenticated` | A false result silently denies a legitimate user. Covered by the before/after snapshot test. | phase2b5 §3 before/after snapshot (all 10 × 3 actors), §4 revocation, §5 search_path |
| `is_member(p_league uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | league_members | yes | **Yes** | `authenticated` | A false result silently denies a legitimate user. Covered by the before/after snapshot test. | phase2b5 §3 before/after snapshot (all 10 × 3 actors), §4 revocation, §5 search_path |
| `is_organizer(p_league uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | league_members, match_organizers | yes | **Yes** | `authenticated` | A false result silently denies a legitimate user. Covered by the before/after snapshot test. | phase2b5 §3 before/after snapshot (all 10 × 3 actors), §4 revocation, §5 search_path |
| `latest_correction_attempt(p_league uuid, p_correction uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | match_correction_attempts | no | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `latest_match_correction_attempt(p_league uuid, p_match uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | match_correction_attempts, match_revisions | no | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `lock_roster_player(p_league uuid, p_player uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | (none) | no | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `open_correction(p_league uuid, p_match uuid, p_reason text)` | `ff_private` | `ff_migration_owner` | **Yes** | match_corrections, match_revisions, official_match_results, real_match_lineup_players, real_match_lineups, real_matches | yes | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `open_correction_attempt(p_league uuid, p_correction uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | audit_logs, match_approvals, match_correction_attempts, match_corrections, match_revisions, match_submissions, official_match_results, real_match_lineup_players, real_match_lineups, real_matches | yes | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `owns_team(p_league uuid, p_team uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | fantasy_teams, league_members | yes | **Yes** | `authenticated` | A false result silently denies a legitimate user. Covered by the before/after snapshot test. | phase2b5 §3 before/after snapshot (all 10 × 3 actors), §4 revocation, §5 search_path |
| `protect_match_metadata()` | `ff_private` | `ff_migration_owner` | **Yes** | match_submissions, real_match_lineup_players, real_match_lineups | no | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `protect_revision()` | `ff_private` | `ff_migration_owner` | **Yes** | match_approvals, match_submissions | no | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `record_event(p_league uuid, p_revision uuid, p_player uuid, p_related uuid, p_type text, p_minute integer, p_quantity integer, p_details jsonb)` | `ff_private` | `ff_migration_owner` | **Yes** | audit_logs, match_events, match_revisions | yes | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `record_first_correction_attempt()` | `ff_private` | `ff_migration_owner` | **Yes** | match_correction_attempts | no | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `require_current_lineup(p_league uuid, p_match uuid, p_revision uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | match_approvals, match_revisions | no | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `require_latest_corrected_lineup(p_league uuid, p_match uuid, p_revision uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | match_correction_attempts, match_revisions | no | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `require_leader(p_league uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | league_members | yes | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `require_organizer(p_league uuid, p_match uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | league_members, match_organizers, real_matches | yes | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `require_run_source()` | `ff_private` | `ff_migration_owner` | **Yes** | scoring_run_sources, scoring_runs | no | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `result_source_lineup_approval(p_league uuid, p_match uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | match_approvals, match_correction_attempts, match_revisions | no | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `result_workflow_case(p_league uuid, p_match uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | match_corrections | no | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `review_submission(p_league uuid, p_submission uuid, p_decision text, p_reason text)` | `ff_private` | `ff_migration_owner` | **Yes** | match_approvals, match_submissions, real_matches | yes | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `set_result_score(p_league uuid, p_revision uuid, p_score_a integer, p_score_b integer)` | `ff_private` | `ff_migration_owner` | **Yes** | audit_logs, match_revisions, real_matches | yes | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `start_scoring(p_league uuid, p_gameweek uuid, p_sources uuid[])` | `ff_private` | `ff_migration_owner` | **Yes** | audit_logs, gameweeks, match_approvals, match_revisions, official_match_results, real_matches, scoring_run_sources, scoring_runs | yes | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `submit_lineup(p_league uuid, p_revision uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | match_revisions, match_submissions | yes | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `submit_result(p_league uuid, p_revision uuid, p_lineup_approval uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | match_revisions, match_submissions | yes | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `validate_approval()` | `ff_private` | `ff_migration_owner` | **Yes** | match_approvals, match_correction_attempts, match_revisions, match_submissions, official_match_results, real_matches | yes | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `validate_correction()` | `ff_private` | `ff_migration_owner` | **Yes** | match_revisions, official_match_results, real_matches | yes | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
| `validate_lineups(p_league uuid, p_revision uuid)` | `ff_private` | `ff_migration_owner` | **Yes** | match_revisions, real_match_lineup_players, real_match_lineups, real_matches, real_team_players, temporary_participant_authorizations | no | **Yes** | none | A wrong definer could let a workflow read/write rows it should not. Mitigated: not client-executable, and each path re-checks identity. | phase2b5 §4 unauthorized rejection; phase2b2 end-to-end fork/correction |
| `validate_submission()` | `ff_private` | `ff_migration_owner` | **Yes** | match_approvals, match_revisions, match_submissions, real_match_lineup_players, real_match_lineups, real_matches | yes | **Yes** | none | A trigger that cannot see its own rows would raise or silently skip its guard. Mitigated: 26 trigger tests in the security suites. | postgres-security-2a3/2a4 (54 cases) + phase2b5 §3 |
## 3. What was implemented vs deferred

### Implemented

| Artefact | Status |
|---|---|
| `011_definer_ownership_transfer.sql` | **Written.** 56 explicit `ALTER FUNCTION … OWNER TO ff_migration_owner` statements, one per function, with verified identity arguments. |
| Guard rail in `011` | Refuses to run if `ff_migration_owner` is missing, or is not `NOLOGIN` + `BYPASSRLS`. |
| Post-condition in `011` | Aborts if any definer function is left off the target owner. |
| No grant changes in `011` | Ownership and grants stay separable, so a failure is unambiguous. |
| `009` hardening (this phase) | The **first** default-privilege `DO` block was unguarded and aborting on clusters without a `postgres` role. Now checks existence *and* membership. |

### Deliberately deferred

| Item | Why |
|---|---|
| **Actually applying `011` to a real project** | Requires a Supabase project; forbidden this phase. The migration is design-only and lives outside `supabase/migrations/`. |
| Definer ownership for **future** functions | New functions created after `011` inherit the creating role, not `ff_migration_owner`. A follow-up migration must re-run the transfer, or `009`'s role must create them. Noted as a standing rule. |
| Per-group owner splitting | Measured to add cost without reducing privilege (§1). |
| Table ownership transfer | Explicitly rejected: hands the definer DDL authority over application data. |

## 4. Which functions must not be transferred

**None must be excluded** — but five carry a specific precondition, and all 56 carry three prohibitions.

| Prohibition | Applies to | Why |
|---|---|---|
| Must not go to a `NOBYPASSRLS` role | **all 56** | All ten helpers return `false` silently; the other 46 inherit the same visibility rules. `010` asserts against this. |
| Must not be combined with grant changes in one file | **all 56** | A mixed failure is indistinguishable between "wrong definer" and "wrong grant". |
| Must not be applied without `010` passing afterwards | **all 56** | `010` is the only control that catches a regression to the broken model. |
| Must not be transferred before the correction tests pass | `guard_submission_generation`, `validate_approval`, `require_latest_corrected_lineup` | These are the three functions `007` replaced; the most behaviour-sensitive in the package. |
| Must not be transferred while the storage policy is unapplied | `can_read_image` | Referenced by the `storage.objects` policy; a broken definer denies **all** image access with no error. |

## 5. How this minimises privilege while preserving behaviour

| Axis | Before | After |
|---|---|---|
| Table DDL authority | yes (owner of 40 tables) | **no** (owns nothing; asserted by `010`) |
| Logins | migration role can log in | **`ff_migration_owner` is `NOLOGIN`** |
| Membership in client roles | n/a | **none**, and `010` refuses if one is granted |
| Client-callable functions | 10 helpers | **10 helpers** (unchanged, asserted) |
| `anon`/`PUBLIC` reach | none | **none** (unchanged, asserted) |
| `search_path` | pinned ×56 | **pinned ×56** (unchanged, asserted) |
| RLS visibility of the definer | full (implicit) | full (**explicit**, and required for the helpers to work at all) |

The one thing that is *not* reduced is the definer's ability to read all rows. It cannot be: the design puts authorization inside definer functions, and those functions must read rows the caller cannot see. `BYPASSRLS` on a `NOLOGIN`, non-client, zero-ownership role is the correct expression of that design — not a workaround for it.

## 6. Verification summary

`supabase/design/tests/phase2b5-ownership.test.mjs` (16 cases, green on PGlite **and** PostgreSQL 17.6):

1. baseline: definer owner == table owner
2. `011` moves all 56, none left behind
3. definer owns no table and **cannot run DDL**
4. **every helper returns exactly the same value before and after** (10 helpers × 3 actors)
5. client row visibility unchanged
6. null caller identity never authorizes
7. membership revocation takes effect immediately
8. role revocation (leader→manager) takes effect immediately
9. organizer assignment removal revokes authority
10. unauthorized user rejected by the real workflow, not just helpers
11. hostile `search_path` cannot hijack a transferred definer
12. all 56 keep the exact pinned path
13. client `EXECUTE` surface unchanged (exactly 10; `anon` 0)
14. `anon` still cannot reach any helper
15. `010` still passes, and still fails on a `BYPASSRLS`-less owner
16. `011`'s guard and post-condition are present and it changes no grants

Case 4 is the decisive one: it is a behavioural **before/after snapshot**, so any regression in the definer's visibility fails the suite rather than silently degrading authorization.

# Fantasy Friends — Phase 2A.4 final database-design closure

**Historical Phase 2A.4 closure:** this report records the Phase 2A.4 review state. The remaining correction-retry, result-fork idempotency, organizer-visibility and baseline-strategy decisions are resolved at the design level by [Phase 2A.5 final design decisions](phase-2a5-final-design-decisions.md). Phase 2A.5 also records that the relevant migration support is not implemented in SQL and that the package remains offline-only, unverified on Supabase, and not an authorization to deploy. All SQL remains under `supabase/design/migrations/`; no live project was accessed.

## Decision: preserve separate revision identities and make lineage explicit

Keep separate immutable `match_revisions.id` values for a submitted lineup and its result snapshot. They represent distinct artifacts with different editable fields, lifecycle and approval events. Forcing them to share an ID would conflate those artifacts without improving integrity. Separate IDs are at least as strong—and more maintainable—when every transition constrains both identities and the approval that connects them.

The new offline draft `006_revision_lineage.sql` records, on each result revision, both `based_on_lineup_revision_id` and `based_on_lineup_approval_id`. A composite FK includes league, match, approval and lineup revision, so it cannot point at another match/tenant or a different approval's revision. A paired-null check prohibits partial lineage. The result fork copies from the currently eligible, approved lineup and sets those exact source identities. Trigger guards make lineage immutable, prohibit submitting result revisions as lineups, require result submissions to name their original lineup approval, and recheck the chain at approval insertion. Existing 004/005 validation still checks copied lineup/snapshot equality, current revision/supersession and correction requirements. Match-row serialization in the workflow and the `READ COMMITTED` guard cover correction/approval ordering; either the approval publishes first and a correction supersedes it atomically, or the correction wins and a stale approval is rejected.

Native PostgreSQL regressions additionally prove: a later separately approved lineup with *identical contents* does not retroactively validate a result bound to the former approval; a new result based on the new lineup succeeds only when forked/submitted/approved against that new approval; the prior approval is rejected after correction; cross-match and partial lineage are rejected; and existing data cannot receive invented lineage. The pre-existing controlled correction-vs-approval race test passes against 006 as well. These are test-environment results, not a claim of exhaustive concurrency verification or production authorization safety.

**Migration constraint:** 001–005 never persisted this provenance. `006` deliberately aborts if any match revision exists; it does not fabricate a backfill. Any real upgrade of populated data needs a separately reviewed provenance/recovery plan and migration, and is not covered by this draft.

**Workflow limitation retained:** if a correction lineup is rejected, there is still no designed safe retry/fork path for that correction. Result forking is serialized but not idempotent: concurrent calls can create multiple drafts. These are explicit follow-up design items, not claims of complete runtime behavior.

## Legacy SQLSTATE: version-dependent code, unchanged protection

The legacy FK is `match_revisions_league_id_match_id_fkey` on `match_revisions(league_id, match_id)` referencing `real_matches(league_id, id)` with `ON DELETE RESTRICT`. Deleting a referenced match fails, names the restricting FK, and leaves the parent row intact.

An isolated native PostgreSQL comparison established the intended error-code variation: PostgreSQL 15.18 reports `23503` (`foreign_key_violation`) for this `RESTRICT` delete; PostgreSQL 18.6 and PGlite's PostgreSQL 18.6 report `23001` (`restrict_violation`). `NO ACTION` reports `23503` in both versions. The legacy test now branches on `server_version_num` and, in addition to the expected code, verifies that the reported constraint is a foreign key on `real_matches` whose catalog delete action is `RESTRICT`, and verifies the match row remains. No FK, delete action or rejection was removed or weakened. Legacy tests pass on both tested server versions.

## Verification evidence

All native clusters were disposable local PostgreSQL instances under `/tmp/ff-pg-audit`, with TCP disabled. No live Supabase connection was made.

| Suite | PostgreSQL 15.18 | PostgreSQL 18.6 | PGlite |
|---|---:|---:|---:|
| Legacy schema/design (001–003) | 10/10 | 10/10 | included in aggregate below |
| Existing 2A.3 security suite (001–005) | 25/25 | — | included in aggregate below |
| 2A.4 security and lineage suite (001–006) | 29/29 | 29/29 | included in aggregate below |
| `npm run test:db:design` all PGlite design suites | — | — | 31/31 |
| Unit tests | — | — | 36/36 |
| Full browser suite | — | — | 42/42 |
| GitHub Pages browser smoke | — | — | 2/2 |
| Typecheck | pass | | |
| Production build | pass | | |
| Pages asset checks | pass | | |
| `git diff --check` | pass | | |

The PGlite design command covers the legacy 001–003 tests and hardening cases through 004, 005 and 006. Browser tests exercised the unchanged demo frontend only; they do not verify a database integration. Browser run used the available Chromium 153 build rather than the repository-pinned Chromium 159, as documented in the 2A.2 audit. No test was intentionally skipped or weakened. The old pre-fix 001–004 exploit witness suite remains a historical reproducer and is not counted as security success.

## Readiness boundaries

### Design completed for review

- Separate lineup and result revision IDs have explicit exact-approval and exact-revision lineage, fail-closed legacy handling, immutable provenance and tested correction approval paths.
- Referenced-match deletion protection is retained; version-aware tests establish the observed PostgreSQL 15/18 behavior.
- Offline hardening and regression drafts 004–006, test adapters and this decision record are reviewable.

### Tested offline, not verified on Supabase

- SQL behavior, constraints, triggers, RLS/policy fixtures and controlled lock interleavings were run on native PostgreSQL 15.18/18.6 and PGlite 18.6 using mocked Auth/Storage roles and caller claims.
- Actual Supabase Auth/JWT verification, PostgREST and effective grants/role inheritance, owner/service-role/BYPASSRLS behavior, Storage policies/ownership, extension availability and hosted PostgreSQL configuration have **not** been verified. Native PostgreSQL compatibility is not evidence of Supabase compatibility.

### Runtime workflows not implemented

- No client/backend is connected to these drafts; no production organizer/leader RPC deployment, edge-function integration, scoring worker or publication pipeline exists. Frontend/demo behavior is unchanged. There is no actual user workflow executing these SQL prototypes.
- No live migration has been executed. 006 is an offline-only draft and refuses databases with existing revisions.

### Product and operational decisions pending

- Correction rejection and retry/recovery, result-fork idempotency, operator recovery/privileged writes, broader deadlock and whole-transaction retry policy, and populated-data upgrade strategy need explicit design and testing.
- Fantasy scoring inputs and values, event/bench/vice-captain semantics, final score publication, and H2H-versus-fantasy-total policy remain unapproved; existing fantasy-total demo defaults are unchanged. The scale conversion between the frontend budget and SQL draft also remains to be addressed before implementation.
- Full hosted security review, migration/rollback plan, observability and independent product/security approval are required before anything deployable or Phase 2B.

## Branch and stopping point

Work remains on `arena/53775cb5-hagz-fantasy`. Existing uncommitted Phase 2A changes have been preserved. No frontend edits, commit, push, deployment, live Supabase access or Phase 2B work occurred. No remote branch/open PR was present; opening a PR would require committing and pushing, which this task expressly forbids, so the remote is unchanged.

**Recommendation:** approve this as a Phase 2A *offline design closure for human review*, subject to the documented follow-ups—not as approval to ship or start Phase 2B. Stop here for human approval.

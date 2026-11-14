# Phase 2A verification, gaps and next-phase gates

## Commands and local evidence

Baseline on a clean `arena/5dd60aec-hagz-fantasy` working tree at `33d8038`:

- `npm ci --no-audit --no-fund` — passed.
- `npm test` — 36/36 existing Vitest tests passed (6 files).
- `npm run typecheck`, `npm run build`, `npm run test:pages:assets` — passed.
- Browser checks used a temporary Chromium 153 build with NSS libraries in `/tmp` (not committed): the initial full suite had 41/42 pass; the responsive English/Arabic scenario then passed five repetitions and the full suite rerun passed 42/42. Root cause of the original failure remains unknown. Pages browser smoke: 2/2 passed. See [browser investigation](browser-investigation.md) for browser-version and trace limitations. The application was not connected to any backend.

`npm run test:db:design` loads test-only mock `auth`/`storage` schemas and the three design SQL drafts into an ephemeral in-memory PGlite PostgreSQL instance. It executes 10 Node test cases for composite FKs, multiple ownership/single-team uniqueness, duplicate real lineup entries, event participant FKs, result-review lineage, restricted deletion, captain/vice uniqueness, position-rule keys, RLS isolation/private draft visibility, anonymous and inactive-organizer denial, denial of authenticated lineup/result/approval/audit/score writes, and private image-path authorization. The tests seed fake identities/data as the local owner, then simulate authenticated clients. `request.jwt.claim.sub` is set by the test harness only, **not** accepted from a production client. Test rows and fake rule points never become app seed data. `npm run types:db:design` regenerates `src/types/database.design.ts` from offline introspection; it is a preview, not Supabase-generated deployed types and its insert/update shapes are not authorization grants.

PGlite is useful for rapid design validation, **not** equivalent to the actual Supabase deployment: it mocks `auth.uid()`, users, roles, Storage tables and bucket behavior. It does not exercise PostgREST, Supabase Auth JWT issuance, Storage API enforcement, connection pool claims, real Storage signed URLs, Edge Functions, concurrent transactions, service-role grants, actual database extensions, policies on upstream storage/auth objects, Supabase CLI deployment or PostgreSQL/Supabase production performance. A green draft test is not security certification or proof that workflow invariants work.

## Required local Supabase integration tests before enabling writes

Run each case with independently authenticated actors: unauthenticated, two leagues, two managers in one league, other-league manager, leader, authorized organizer, unauthorized manager, inactive member, revoked organizer; also compromised role and service-worker tests. Verify both allowed outcomes and denied attempts by direct REST, RPC and Storage requests, including forged user/league/role fields. Mandatory coverage:

| Area | Required scenarios | Current status |
|---|---|---|
| RLS / permissions | cross-league reads/writes; no role escalation; self/other fantasy teams; inactive/revoked roles; anon; helper `search_path`, default grants, ownership/BYPASSRLS; nonrecursive policies | draft read/deny cases tested in PGlite; real stack not tested |
| Squad and budget | 15/11/4, distribution and all seven formations, duplicate team ownership, independent multi-ownership, exact price/budget, inactive historical selections, same-position transfer, race/retry, deadline and tenant enforcement | duplicate/multi-ownership FK tested; aggregate/transactions **not implemented** |
| Real match lineup | exact configured starters on each side, max subs, both actual teams only, registered roster valid at kickoff, temporary authorization, no duplicate across sides, time-zone boundaries, immutable historical version and reapproval | duplicate and labels tested; team/eligibility/count/immutability **not implemented** |
| Match workflow | organizer creation/submission, leader-only review, reasons, state transitions, replay/idempotency, stale versions, review races, organizer revocation, correction authorization and reapproval | all client writes currently denied; permitted workflow **not implemented** |
| Events/results | valid participant and related player in same revision/team; goals/assists/own-goals/cards/MVP/appearances/substitutions/clean sheets/custom events; unauthorized or post-approval edits; result/event consistency | participant FKs and direct client denial tested; semantics/approvals **not implemented** |
| Scoring | no draft/rejected/corrected data reaches official scores; position config for every event; version pinning, no accidental zero, exact-once performance, independently attributed shared player, no-play zero, ×2 only once, vice participation policy, bench eligibility, multiple matches, idempotent recompute after correction, rollback/outbox | selected DDL keys and ×2 allowed constraint tested; worker, aggregation, captain algorithm and corrections **not implemented** |
| Fixtures / standings | separate real and fantasy fixture identities; automatic/manual fixture creation, 3/1/0 H2H, fantasy-total mode, approved-score-only updates, deterministic ties, concurrent gameweeks and league isolation | mode schema and current frontend fantasy-only sorting tested; backend computation **not implemented** |
| Audit | leader access, actors from auth, before/after, append-only, reasons, no forgery, transaction rollback and retention, trusted role tamper controls | client write denial tested; audit creation/immutability by privileged workflows **not implemented** |
| Storage | cross-league/own-suggestion privacy; MIME spoof, SVG, corrupt/decompression bomb, 5 MB boundary, oversized/expired upload, path traversal, stale signed URLs, image migration and revoked access | read-policy draft tested against fake storage; upload scanner/policies and real Storage **not implemented** |
| Integrity & operations | two-side team IDs, temporal roster overlap/authorization revocation, deletion/pseudonymization, published rules immutable, approved snapshots immutable, FKs and indexes, pgTAP, explain plans, load, backups/restore, retries, abuse/DoS and key rotation | design only |

## Roadmap — require human approval between gates

1. Review and resolve the standings conflict, scoring/bench/vice semantics, permissions, result corrections, identity/deletion, money, privacy and storage decisions in [architecture](architecture.md). Obtain threat-model approval; do not replace local demo data.
2. In a **disposable local-only** Supabase stack (never live), translate reviewed drafts into real, ordered migrations with verified role ownership/least privilege and actual Storage/auth integration. Add complete constraints, immutable revision enforcement, required indexes and transactional audited RPCs. Keep all user writes disabled until tests pass.
3. Implement local-only trusted match, market and fantasy-team RPCs with idempotency, row locks and approval workflows; run positive/negative real Supabase RLS and concurrency tests. Review SQL security with `EXPLAIN` and roles; independently verify actual role grants and PostgREST exposure.
4. After approved scoring decisions, implement private event derivation, versioned scoring, outbox/replay and two separate standings modes; validate approved-only lineage, corrections and audit through full end-to-end real-stack tests. No final event values are invented by this architecture.
5. Build private, verified upload pipeline and approved opt-in local-image migration; independently review storage/RLS and security. Generate actual database types from the reviewed local schema.
6. Only after explicit approval, plan real project provisioning, migrations, secrets, backup/recovery, frontend integration behind a demo-preserving feature flag, gradual migration and deployment. This Phase 2A does **none** of these.

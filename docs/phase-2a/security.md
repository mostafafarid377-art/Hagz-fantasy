# Security, RLS and image-storage design

## Threat model and current boundary

No public client mutation is implemented or granted. The draft is intentionally more restrictive than the requested future product. A privileged database owner can bypass RLS: **never** expose owner/service-role credentials to a browser or assume the prototype policies secure a future worker. Supabase Authentication verifies tokens; all future RPCs resolve the actor as `auth.uid()` and check active `league_members` inside the same locked transaction. Do not accept user ID/role/league authority claims from JSON, request metadata or frontend. Inputs identifying resources are scoped again through database relationships. Deny anonymous users. App roles and the demo role toggle are not authorization.

### Read policy matrix in the draft

| Data | Authenticated read scope | Client writes |
|---|---|---|
| profiles | own only | none |
| leagues, teams/market/players, gameweeks, score summaries, fixtures, standings, rule sets | active league member | none |
| members | self or active leader; organizer assignments visible to league members | none |
| suggestions and approval history | submitter or leader | none |
| fantasy squad, lineup, lineup items, transfer history, detailed score items | owning manager or leader | none |
| real matches and revisions/lineups/events/submissions/reviews | leader or designated organizer; other league members only for approved revision | none |
| temporary participant authorizations | leader or designated organizer | none |
| notifications | active member recipient only | none |
| audit logs | active league leader only | none |
| storage player images | active league member with an associated visible player profile, or the submitter/leader for a suggestion image | none |

This intentionally conservative matrix is not an end-user visibility decision. Organizers currently read all match drafts in their league; whether to restrict them to assigned matches and whether approved fantasy lineups should be visible to all league members remain review decisions. Leader/player profile display requires a carefully scoped membership profile view; broad access to `profiles` is not granted. Match organizer status requires an active membership; an inactive member loses access. Personal identifiers, rejection reasons and audits are sensitive and need minimization/retention review.

## Authorization helpers and grants

`002_security.sql` explicitly enables RLS on every application table, revokes public/anon/authenticated table privileges, grants authenticated **SELECT only**, and defines select policies. The only implemented functions are scoped read-authorization helpers in `ff_private` (`is_member`, `is_leader`, `is_organizer`, `owns_team`, `can_read_lineup`, `can_read_revision`, `can_read_match`, `can_read_suggestion`, `can_read_image`). They are `SECURITY DEFINER`, take resource IDs rather than arbitrary user IDs, call `auth.uid()`, use schema-qualified objects, and use fixed `search_path = pg_catalog, ff_private`. `ff_private` has no client `CREATE`; public schema `CREATE` is revoked. `PUBLIC`/`anon` function execution is revoked; only the explicit helper signatures receive authenticated execute. Helpers read tables as their trusted owner to avoid recursive RLS; in the test harness that owner is the local migration owner. Before any Supabase deployment, set and verify a dedicated NOLOGIN trusted function owner with only needed access and RLS-bypass properties; decide whether explicit owner policies are preferable to bypass; verify grants inherited through every role, object ownership, default privileges and `BYPASSRLS`. Never rely on these helpers for writes by themselves.

Future privileged workflow RPCs must:

- use trusted `auth.uid()`, explicit active membership and per-resource ownership/role checks; lock and recheck before committing; parameterize input, avoid dynamic SQL or rigorously quote/allowlist it;
- have fixed safe search paths and minimum privilege, no caller-supplied audit actor; revoke `PUBLIC`, `anon`, and unnecessary authenticated execution **before** explicitly granting approved signatures; never make `ff_private` an exposed PostgREST schema;
- return only data the caller can see, avoid detailed tenant-existence or authorization oracles, and enforce request size/rate limits;
- append audit entries transactionally, lock immutable approved revisions, enforce all lifecycle and aggregate rules described in the workflow docs, and never allow direct DML to authoritative tables;
- handle bootstrap/join/leave, leader delegation and temporary player authorization through narrowly scoped functions. User signup may create an own profile through an audited bootstrap, while protected leader membership/invite issuance cannot be self-assigned.

A proposed RPC specification (names are *not* implemented): `create_match`, `authorize_temporary_participant`, `save_match_draft`, `submit_lineups`, `review_lineups`, `record_event`, `submit_result`, `review_result`, `open_correction`, `submit_suggestion`, `review_suggestion`, `update_fantasy_roster`, `confirm_fantasy_lineup` and `transfer_player`. User commands must return version/conflict/error codes and operate on a specific league and expected revision. Review/authorization code must check leader/organizer permissions afresh; only a leader may accept/reject. Suggestion approval locks the pending suggestion, resolves an existing identity deliberately, creates exactly one player/market record, stores decision and reason and writes audit in the **same** transaction; concurrent retries must not duplicate it. Multi-row squad validations and result approvals must not rely on browser-supplied values. Service-worker scoring is invoked via a private outbox/job mechanism; not an anonymous edge function or a public SQL RPC.

## Audit, lifecycle and consistency

`audit_logs` is member-linked for the league and readable only by a current leader; user writes are revoked. Future trusted transactions must append actor, entity, action, reason, version, before/after or immutable hashes and timestamp atomically; explicitly include organizer grant/revocation, temporary authorizations, transfers, player suggestion decisions, lineup changes/reviews, result reviews/corrections and rule publication. Avoid image bytes, secrets or unnecessary personal data in audit payload. Prevent application-level audit update/delete, implement auditable retention and access procedures, and send tamper-evident copies to a separate restricted system if required. A privileged owner can alter audit rows: schema alone is not tamper-proof. Review data retention, right-to-erasure, backups and pseudonymization without breaking historical referential integrity before real user onboarding.

Submitted/approved state is only a placeholder column in this draft. Immutability is guaranteed against **client** writes by denial, not against table owners or future functions. Add tested triggers/privilege boundaries for all trusted services before exposing write functions. The approved lineage FKs prevent a rejected/non-result/different-revision approval from being used as an official result, but cannot prove actual leader identity, eligibility, content hash, correct score or timing.

## Private player-image storage

Draft bucket `player-images` is private, 5,242,880 bytes maximum, MIME allowlist `image/jpeg`, `image/png`, `image/webp` (JPG/JPEG both use `image/jpeg`). Design path `<league-uuid>/players/<random-uuid>.<jpg|jpeg|png|webp>`; use generated names, no user filenames or filesystem traversal. The read helper rejects malformed paths before UUID casting and requires active same-league membership **and** a matching player profile path or an own/leader suggestion path; mere knowledge of a path is insufficient. It reads only visible referenced objects. Bucket configuration and client validation are not proof of file bytes.

**No browser upload/update/delete policy is granted in this phase.** Future upload flow: authenticate and authorize a leader or own suggestion, issue short-lived scoped upload intent for a randomized quarantine object; a trusted server/Edge Function verifies actual bytes by magic number AND bounded safe image decode, type, size, dimensions, decompression limits and re-encoding/metadata removal; only then publish via storage API, atomically bind the path to the authorized row, audit and clean abandoned staging objects. Do not parse untrusted image data in a highly privileged unrestricted worker. Add malware/content moderation/rate limits if required. Signed URLs must be short-lived, authorized per issuance and never public; reject outdated or revoked access where feasible. No user-supplied MIME or extension alone is sufficient.

Existing image URLs and the local picker and IndexedDB remain supported in the demo. Draft player and suggestion rows separately retain `image_url` for existing external URLs and `image_path` for private Storage objects; future writes must accept only explicitly approved HTTPS URLs, limit length, consider image privacy/tracking and CSP, and never let privileged servers fetch arbitrary URLs (SSRF). Define precedence and fallback when both are present. Existing local picker and IndexedDB remain the source for demo uploads. Future opt-in migration: export/revalidate each selected blob locally, ask for explicit consent, map local league/player identity to the authenticated league, upload through the reviewed staging pipeline, retain the local fallback until a verified server path is committed, handle quota/offline/retry/collision and rollback. Never store binary/base64 in PostgreSQL player rows or leak one league's images to another; no automatic upload or cloud synchronization occurs in 2A.

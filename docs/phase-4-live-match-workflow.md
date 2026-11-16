# Phase 4 — Live Match workflow

## What changed

- Match Center and Fixtures share the same persisted scheduling form. League Leaders can schedule from either surface, add active real teams, and appoint an active Organizer. The Gameweek association is optional; standalone real matches do not require a Season/Gameweek, while legacy associations remain readable.
- Assigned Organizers can open match revisions, choose starters/substitutes for both sides from active published League Market players, save and submit lineups, record a result score and events (including substitution in/out events), then submit the result.
- League Leaders can approve or reject pending lineup/result submissions, see their review history and reasons, and open a correction from an approved result. Corrections remain new immutable revisions and require reapproval.
- Market player eligibility is checked in PostgreSQL against an active `league_players` row in the same league at lineup write and submission. It is independent of `fantasy_squad_players` and `real_team_players`; the workflow does not create player profiles. Existing revision-level uniqueness continues to prevent assigning a player twice, including across match sides.
- `ff_matches` retains its existing member-scoped RPC and now returns revision lineups, events, submission/review outcomes, and correction reasons for the history UI. Existing RPC signatures and grants are preserved.
- Scores remain official only after leader approval. Fantasy scoring remains pending until the league has an approved scoring configuration.
- In Demo and Live squad-builder player details, **Remove** now sits beside **Select replacement**. Demo removal updates only its local demo squad; Live removal uses the existing authenticated sell RPC and respects market/lineup constraints.

## Exact Live UI steps

1. Sign in with the League Leader account and choose the target league.
2. Open **Fixtures** or **Match Center** → **Schedule match**. Create the two real teams in **New real team** if needed.
3. Appoint an active member as Match Organizer through the league’s member/organizer controls before scheduling.
4. Choose whether to link a Gameweek (optional), Team A, Team B, assigned Organizer, date/time, venue, starters per side, and maximum substitutes; submit **Create match**. No Season/Gameweek is auto-created.
5. In **Fixtures**, use **Show match** to open the full match detail, events, and revision/approval history; Match Center also opens those details.
6. The appointed Organizer signs in, opens the match from Match Center or Fixtures, selects players on both sides from **published League Market** entries, marks each as starter or substitute, saves both lineups, and submits them for review.
7. The League Leader opens the match and approves or rejects the submission. Rejections require a reason and are shown in revision history.
8. After lineup approval, the assigned Organizer chooses **Record match result**, enters the score and events (record substitution-out and substitution-in as separate events, linking the related player where useful), then submits the result.
9. The League Leader reviews the result. Only approval makes it official. To correct an approved result, the Leader opens a correction with a reason; the copied revision must go through lineup and result review again.

## Permissions

| Action | League Leader | Assigned Organizer | Other league member |
|---|---:|---:|---:|
| Add real teams and schedule matches | Yes | No | No |
| Appoint organizers | Yes | No | No |
| Open/edit a match revision and save lineups, score, or events | Yes | Yes | No |
| Submit lineup/result | Yes | Yes | No |
| Approve/reject submissions | Yes, except self-approval is refused | No | No |
| Open correction | Yes | No | No |
| Read league match/history data | Yes | Yes | League members |

These are database-enforced permissions. Hiding controls in the UI is not the security boundary.

## Migration and QA status

- Match Market eligibility remains in forward-only migration 018. New forward-only migration `supabase/migrations/20261115000019_optional_match_gameweek.sql` (from `supabase/design/migrations/019_optional_match_gameweek.sql`) makes only `real_matches.gameweek_id` nullable and replaces the existing `ff_match_create` body with conditional link validation. The FK remains in place, so a supplied link must still point to a Gameweek in the same League. Existing rows and their links are not rewritten.
- The latest migration 019 must be applied to the intended Supabase environment **before** shipping the frontend. This PR does not apply SQL, link a project, deploy, or change hosted policies.
- Verification on this branch: `npm run typecheck`, `npm run build`, `npm test` (269 passed), `npm run test:api` (29 passed), `npm run test:db:design` (148 passed, 7 skipped), and `npm run check:migrations` (39 passed). The API/design suites use PGlite and mocked Supabase roles/auth identity; they are not hosted database tests. The React UI regressions use Vitest/jsdom with mocked RPCs; they are not full browser tests.
- `npm run test:e2e` was attempted, but all 52 Playwright tests stopped at browser launch because the Chromium headless executable is not installed in the environment. No E2E assertions ran.
- No local Supabase service or hosted Supabase project was used. The migration checker inspects packaging and SQL source only; it does not apply SQL or prove hosted compatibility. This PR does not apply SQL, link a project, deploy, or change hosted policies.
- Before enabling the feature for users, apply the migration in the approved deployment process, confirm the Leader/Organizer assignments and active real teams/gameweeks exist, and run the full hosted authenticated-user workflow as both roles. Do not place service-role credentials in the browser.

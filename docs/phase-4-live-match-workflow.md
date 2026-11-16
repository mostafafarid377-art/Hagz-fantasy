# Phase 4 — Live Match workflow

## What changed

- The Match Center now schedules persisted league matches with a gameweek, two active real teams, an appointed active organizer, kick-off time, venue, starter count, and substitute limit. League Leaders can add real teams and create matches.
- Assigned Organizers can open match revisions, choose starters/substitutes for both sides from active published League Market players, save and submit lineups, record a result score and events (including substitution in/out events), then submit the result.
- League Leaders can approve or reject pending lineup/result submissions, see their review history and reasons, and open a correction from an approved result. Corrections remain new immutable revisions and require reapproval.
- Market player eligibility is checked in PostgreSQL against an active `league_players` row in the same league at lineup write and submission. It is independent of `fantasy_squad_players` and `real_team_players`; the workflow does not create player profiles. Existing revision-level uniqueness continues to prevent assigning a player twice, including across match sides.
- `ff_matches` retains its existing member-scoped RPC and now returns revision lineups, events, submission/review outcomes, and correction reasons for the history UI. Existing RPC signatures and grants are preserved.
- Scores remain official only after leader approval. Fantasy scoring remains pending until the league has an approved scoring configuration.

## Exact Live UI steps

1. Sign in with the League Leader account and choose the target league.
2. If the league does not yet have a season/gameweek, open **Season** and create one. (This is required because every match belongs to a gameweek.)
3. Open **Match Center** → **Schedule match**. Create the two real teams in **New real team** if needed.
4. Appoint an active member as Match Organizer through the league’s member/organizer controls before scheduling.
5. Choose gameweek, Team A, Team B, assigned Organizer, date/time, venue, starters per side, and maximum substitutes; submit **Create match**.
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

- New forward-only migration: `supabase/migrations/20261115000018_live_match_market_workflow.sql`, generated from `supabase/design/migrations/018_live_match_market_workflow.sql`.
- Apply the migration to the intended Supabase environment **before** shipping the frontend. This PR does not apply SQL, link a project, deploy, or change hosted policies.
- The API integration suite uses PGlite with mocked Supabase roles and `auth.uid()` behavior; it is not a hosted database test. The design suite also exercises local PGlite SQL and includes skipped cases. Browser UI tests are mocked and do not make network calls. No local Supabase/PostgreSQL service or hosted Supabase project was used for this work.
- Before enabling the feature for users, apply the migration in the approved deployment process, confirm the Leader/Organizer assignments and active real teams/gameweeks exist, and run the full hosted authenticated-user workflow as both roles. Do not place service-role credentials in the browser.

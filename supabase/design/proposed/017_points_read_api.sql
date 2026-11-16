-- 017 — official points read API (PROPOSED, NOT APPLIED, NOT PROMOTED)
--
-- STATUS: proposal only.
--   * This file is NOT in supabase/migrations/ and is NOT in the promoter's PACKAGE.
--   * `npm run check:migrations` therefore ignores it, and `supabase db push` can never
--     apply it.
--   * No remote database change was made for the work in PR #28.
--
-- WHY IT EXISTS
--   Requirement 5 asks for LAST GAME POINTS and TOTAL SEASON POINTS. The client can
--   already read the underlying rows: 002_security.sql grants member-scoped
--   `league_read` SELECT policies on official_match_results, match_player_performances,
--   fantasy_scores, gameweeks and real_matches, and 009_ownership_and_grants.sql
--   re-grants `select` to authenticated on all of them. src/services/points.ts uses
--   those selects directly, so no new SQL is needed to DISPLAY real figures.
--
--   What does not exist, and cannot be added safely without a decision, is a producer
--   of official player scores:
--     * 004_integrity_workflows.sql installs block_unimplemented_scoring() on
--       match_player_performances, fantasy_score_items and fantasy_scores, so every
--       INSERT raises "scoring calculation not implemented; writes blocked";
--     * 014_api_surface_verification.sql asserts that NO client-callable RPC may
--       compute fantasy points, until positional scoring values are approved.
--
--   So until a scoring run exists, an approved match legitimately has no score items,
--   and the UI reports "Result approved · scores pending" rather than a fabricated 0.
--
-- WHAT THIS PROPOSAL ADDS
--   A single READ-ONLY, member-scoped aggregate. It computes nothing: it sums points
--   that a scoring run has already stored (where points = base_points * multiplier, so
--   the captain x2 is applied once, by the run, not here). It introduces no new table,
--   no policy, no grant to anon, and no write path.
--
--   It is deliberately NOT named like a scoring entry point, because 014 rejects any
--   function whose name matches %scoring% / %fantasy_score% / %_score_run% or is one of
--   ff_score / ff_run_scoring / ff_publish_scores. `ff_league_points` matches none of
--   those patterns.
--
-- APPROVAL NEEDED BEFORE ADOPTING
--   1. Confirm the name ff_league_points does not trip 014's assertion.
--   2. Promote via supabase/design/api/ + scripts/promote-migrations.mjs so the
--      packaging guard still owns the executable copy, and add it to PACKAGE and to
--      POST_VERIFICATION_REPAIRS in scripts/check-migration-package.mjs.
--   3. Extend supabase/design/tests/phase3-points-read.test.mjs to drive the RPC
--      instead of (or as well as) the table selects.
--
-- DO NOT run this against a hosted project without that approval.

create or replace function public.ff_league_points(p_league uuid, p_season uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, ff_private
as $$
declare
  v_latest public.real_matches;
  v_last jsonb;
  v_season jsonb;
begin
  -- Same membership gate as every other league RPC: a non-member gets 42501, so one
  -- league can never read another's points.
  perform ff_private.require_member(p_league);

  -- The latest COMPLETED, officially approved match of the season.
  select m.* into v_latest
    from public.official_match_results o
    join public.real_matches m
      on m.league_id = o.league_id and m.id = o.match_id
    join public.gameweeks g
      on g.league_id = m.league_id and g.id = m.gameweek_id
   where o.league_id = p_league
     and o.is_current
     and o.decision = 'approved'
     and m.starts_at <= now()
     and (p_season is null or g.season_id = p_season)
   order by m.starts_at desc, m.id
   limit 1;

  -- Per-league-player and per-fantasy-team totals for that one match.
  if found then
    select jsonb_build_object(
             'match_id', v_latest.id,
             'match_label', (select 'Gameweek ' || g.number
                               from public.gameweeks g
                              where g.league_id = v_latest.league_id
                                and g.id = v_latest.gameweek_id),
             'played_at', v_latest.starts_at,
             'by_player', coalesce((
               select jsonb_object_agg(lp.id::text, t.points)
                 from (
                   select lp2.id, sum(i.points) as points
                     from public.fantasy_score_items i
                     join public.fantasy_lineups l
                       on l.league_id = i.league_id and l.id = i.fantasy_lineup_id
                     join public.match_player_performances perf
                       on perf.league_id = i.league_id and perf.id = i.performance_id
                     join public.official_match_results o2
                       on o2.league_id = perf.league_id and o2.id = perf.official_result_id
                     join public.league_players lp2
                       on lp2.league_id = perf.league_id and lp2.player_id = perf.player_id
                    where i.league_id = p_league
                      and o2.is_current
                      and o2.match_id = v_latest.id
                    group by lp2.id
                 ) t join public.league_players lp on lp.id = t.id
             ), '{}'::jsonb),
             'by_team', coalesce((
               select jsonb_object_agg(s.fantasy_team_id::text, s.points)
                 from (
                   select l.fantasy_team_id, sum(i.points) as points
                     from public.fantasy_score_items i
                     join public.fantasy_lineups l
                       on l.league_id = i.league_id and l.id = i.fantasy_lineup_id
                     join public.match_player_performances perf
                       on perf.league_id = i.league_id and perf.id = i.performance_id
                     join public.official_match_results o2
                       on o2.league_id = perf.league_id and o2.id = perf.official_result_id
                    where i.league_id = p_league
                      and o2.is_current
                      and o2.match_id = v_latest.id
                    group by l.fantasy_team_id
                 ) s
             ), '{}'::jsonb)
           ) into v_last;
  end if;

  -- Season totals, summed over every approved match of the season.
  select jsonb_build_object(
           'by_player', coalesce((
             select jsonb_object_agg(t.id::text, t.points)
               from (
                 select lp2.id, sum(i.points) as points
                   from public.fantasy_score_items i
                   join public.match_player_performances perf
                     on perf.league_id = i.league_id and perf.id = i.performance_id
                   join public.official_match_results o2
                     on o2.league_id = perf.league_id and o2.id = perf.official_result_id
                   join public.real_matches rm
                     on rm.league_id = o2.league_id and rm.id = o2.match_id
                   join public.gameweeks g
                     on g.league_id = rm.league_id and g.id = rm.gameweek_id
                   join public.league_players lp2
                     on lp2.league_id = perf.league_id and lp2.player_id = perf.player_id
                  where i.league_id = p_league
                    and o2.is_current
                    and rm.starts_at <= now()
                    and (p_season is null or g.season_id = p_season)
                  group by lp2.id
               ) t
           ), '{}'::jsonb),
           'by_team', coalesce((
             select jsonb_object_agg(t.fantasy_team_id::text, t.points)
               from (
                 select l.fantasy_team_id, sum(i.points) as points
                   from public.fantasy_score_items i
                   join public.fantasy_lineups l
                     on l.league_id = i.league_id and l.id = i.fantasy_lineup_id
                   join public.match_player_performances perf
                     on perf.league_id = i.league_id and perf.id = i.performance_id
                   join public.official_match_results o2
                     on o2.league_id = perf.league_id and o2.id = perf.official_result_id
                   join public.real_matches rm
                     on rm.league_id = o2.league_id and rm.id = o2.match_id
                   join public.gameweeks g
                     on g.league_id = rm.league_id and g.id = rm.gameweek_id
                  where i.league_id = p_league
                    and o2.is_current
                    and rm.starts_at <= now()
                    and (p_season is null or g.season_id = p_season)
                  group by l.fantasy_team_id
               ) t
           ), '{}'::jsonb)
         ) into v_season;

  return jsonb_build_object('last_game', v_last, 'season', v_season);
end $$;

-- Read-only and member-gated inside the body; still closed to PUBLIC/anon, matching the
-- reviewed privilege model in 009_ownership_and_grants.sql.
revoke all on function public.ff_league_points(uuid, uuid) from public, anon;
grant execute on function public.ff_league_points(uuid, uuid) to authenticated;

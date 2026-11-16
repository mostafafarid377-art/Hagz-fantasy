/**
 * @vitest-environment jsdom
 *
 * Requirement 5 - LAST GAME POINTS vs TOTAL SEASON POINTS.
 *
 * These run against a MOCKED Supabase client. They prove the SELECTION LOGIC:
 *   * only officially approved, current results are considered;
 *   * only matches that have actually kicked off can be "the last game";
 *   * last-game and season totals are aggregated from separate result sets;
 *   * an approved result with no score rows is reported as awaitingScoring rather
 *     than as a zero;
 *   * a refusal or failure is reported as 'unavailable', never as emptiness.
 *
 * They do NOT prove anything about the hosted project. The SQL-level behaviour those
 * reads depend on (RLS league_read policies, the SELECT grants) is exercised by the
 * PGlite suite in supabase/design/tests, which runs the real migrations.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

interface TableData { [table: string]: unknown[] }

/**
 * Minimal PostgREST-ish fake.
 *
 * It APPLIES `eq` and `in` filters rather than returning every row, because the
 * behaviour under test is precisely which rows the query narrows to (the latest
 * approved result, the performances in it, the score items for those performances).
 * A fake that ignored filters would pass code that never filtered at all.
 */
function fakeClient(data: TableData) {
  return {
    from(table: string) {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.order = () => chain;
      chain.limit = () => chain;
      chain.eq = (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return chain;
      };
      chain.is = (column: string, value: unknown) => {
        filters.push((row) => (row[column] ?? null) === value);
        return chain;
      };
      chain.in = (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]));
        return chain;
      };
      chain.then = (resolve: (value: unknown) => void) => {
        const rows = (data[table] ?? []) as Array<Record<string, unknown>>;
        const filtered = rows.filter((row) => filters.every((test) => test(row)));
        return Promise.resolve({ data: filtered, error: null }).then(resolve);
      };
      return chain;
    },
  };
}

async function load(data: TableData) {
  vi.resetModules();
  vi.doMock('../lib/supabase', () => ({ getSupabase: () => fakeClient(data) }));
  return import('./points');
}

const GB = 'gw-early';
const GW = 'gw-late';
const SEASON = 'season-1';

/** Two approved matches in one season: gameweek 1 and gameweek 2. */
function baseTables(overrides: TableData = {}): TableData {
  return {
    // Columns mirror the real tables: the queries filter on league_id, is_current
    // and (for performances) official_result_id, so the fixtures must carry them.
    official_match_results: [
      { id: 'off-1', league_id: 'L1', match_id: 'm1', revision_id: 'r1', is_current: true },
      { id: 'off-2', league_id: 'L1', match_id: 'm2', revision_id: 'r2', is_current: true },
    ],
    real_matches: [
      { id: 'm1', league_id: 'L1', gameweek_id: GB, starts_at: '2026-01-01T18:00:00Z' },
      { id: 'm2', league_id: 'L1', gameweek_id: GW, starts_at: '2026-01-08T18:00:00Z' },
    ],
    gameweeks: [
      { id: GB, league_id: 'L1', season_id: SEASON, number: 1 },
      { id: GW, league_id: 'L1', season_id: SEASON, number: 2 },
    ],
    match_player_performances: [
      // Match 1: alpha and bravo played.
      { id: 'perf-a1', league_id: 'L1', official_result_id: 'off-1', player_id: 'player-a', played: true },
      { id: 'perf-b1', league_id: 'L1', official_result_id: 'off-1', player_id: 'player-b', played: true },
      // Match 2: only alpha played; bravo did not feature.
      { id: 'perf-a2', league_id: 'L1', official_result_id: 'off-2', player_id: 'player-a', played: true },
    ],
    fantasy_score_items: [
      // Match 1 scores.
      { league_id: 'L1', performance_id: 'perf-a1', points: 6, fantasy_lineup_id: 'lineup-1' },
      { league_id: 'L1', performance_id: 'perf-b1', points: 9, fantasy_lineup_id: 'lineup-1' },
      // Match 2 score: alpha only. Bravo must NOT inherit the 9 from match 1.
      { league_id: 'L1', performance_id: 'perf-a2', points: 12, fantasy_lineup_id: 'lineup-1' },
    ],
    fantasy_lineups: [{ league_id: 'L1', fantasy_team_id: 'team-1', id: 'lineup-1' }],
    league_players: [
      { id: 'lp-a', league_id: 'L1', player_id: 'player-a' },
      { id: 'lp-b', league_id: 'L1', player_id: 'player-b' },
    ],
    ...overrides,
  };
}

describe('last game points use the latest approved match only', () => {
  it('reports the most recent approved match, not the season total', async () => {
    const points = await load(baseTables());
    const snapshot = await points.leaguePoints('L1', SEASON);

    expect(snapshot.state).toBe('ready');
    expect(snapshot.lastGame?.matchId).toBe('m2');
    expect(snapshot.lastGame?.matchLabel).toBe('Gameweek 2');
    expect(points.lastGamePointsForPlayer(snapshot, 'lp-a')).toBe(12);
  });

  it('does not reuse an earlier match score for a player who did not feature', async () => {
    const points = await load(baseTables());
    const snapshot = await points.leaguePoints('L1', SEASON);

    // Bravo scored 9 in gameweek 1 but did not play in gameweek 2.
    expect(points.lastGamePointsForPlayer(snapshot, 'lp-b')).toBeUndefined();
  });

  it('keeps the season total as a separate figure that accumulates every approved match', async () => {
    const points = await load(baseTables());
    const snapshot = await points.leaguePoints('L1', SEASON);

    // Alpha: 6 + 12 = 18 across the season; bravo: 9.
    expect(points.seasonPointsForPlayer(snapshot, 'lp-a')).toBe(18);
    expect(points.seasonPointsForPlayer(snapshot, 'lp-b')).toBe(9);
    // And the two figures are genuinely different, which is the whole point.
    expect(points.lastGamePointsForPlayer(snapshot, 'lp-a')).not.toBe(
      points.seasonPointsForPlayer(snapshot, 'lp-a'));
  });

  it('includes the only approved match in season totals', async () => {
    const tables = baseTables();
    tables.official_match_results = tables.official_match_results.filter((row) => (row as { match_id: string }).match_id === 'm2');
    const points = await load(tables);
    const snapshot = await points.leaguePoints('L1', SEASON);
    expect(points.seasonPointsForPlayer(snapshot, 'lp-a')).toBe(12);
  });

  it('sums each fantasy team from the score items', async () => {
    const points = await load(baseTables());
    const snapshot = await points.leaguePoints('L1', SEASON);
    expect(snapshot.lastGame?.byTeam['team-1']).toBe(12);
    expect(snapshot.season?.byTeam['team-1']).toBe(27);
  });

  it('applies the captain multiplier exactly once, not twice', async () => {
    // fantasy_score_items.points already has the x2 baked in (check constraint
    // points = base_points * multiplier). The aggregator must sum as stored.
    const tables = baseTables({
      fantasy_score_items: [
        { league_id: 'L1', performance_id: 'perf-a2', points: 24, fantasy_lineup_id: 'lineup-1' }, // 12 base x2
      ],
    });
    const points = await load(tables);
    const snapshot = await points.leaguePoints('L1', SEASON);
    expect(points.lastGamePointsForPlayer(snapshot, 'lp-a')).toBe(24);
  });
});

describe('unapproved and unplayed matches are excluded', () => {
  it('reports no-approved-match when there are no current official results', async () => {
    const points = await load(baseTables({ official_match_results: [] }));
    const snapshot = await points.leaguePoints('L1', SEASON);
    expect(snapshot.state).toBe('no-approved-match');
    expect(snapshot.lastGame).toBeNull();
    expect(points.lastGamePointsForPlayer(snapshot, 'lp-a')).toBeUndefined();
  });

  it('ignores an approved result for a match that has not kicked off', async () => {
    const future = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const tables = baseTables({
      real_matches: [
        { id: 'm1', league_id: 'L1', gameweek_id: GB, starts_at: '2026-01-01T18:00:00Z' },
        { id: 'm2', league_id: 'L1', gameweek_id: GW, starts_at: future },
      ],
    });
    const points = await load(tables);
    const snapshot = await points.leaguePoints('L1', SEASON);
    // The future match cannot be the last game; gameweek 1 is.
    expect(snapshot.lastGame?.matchId).toBe('m1');
  });

  it('scopes to the requested season', async () => {
    const other = 'season-2';
    const tables = baseTables({
      gameweeks: [
        { id: GB, league_id: 'L1', season_id: other, number: 1 },
        { id: GW, league_id: 'L1', season_id: other, number: 2 },
      ],
    });
    const points = await load(tables);
    const snapshot = await points.leaguePoints('L1', SEASON);
    expect(snapshot.state).toBe('no-approved-match');
  });
});

describe('something is never reported as nothing', () => {
  it('marks an approved match with no score items as awaitingScoring, not as zeroes', async () => {
    const points = await load(baseTables({ fantasy_score_items: [] }));
    const snapshot = await points.leaguePoints('L1', SEASON);
    expect(snapshot.state).toBe('ready');
    expect(snapshot.awaitingScoring).toBe(true);
    expect(points.lastGamePointsForPlayer(snapshot, 'lp-a')).toBeUndefined();
  });

  it('reports unavailable when Supabase is not configured', async () => {
    vi.resetModules();
    vi.doMock('../lib/supabase', () => ({ getSupabase: () => null }));
    const points = await import('./points');
    const snapshot = await points.leaguePoints('L1');
    expect(snapshot.state).toBe('unavailable');
    expect(snapshot.error).toBeTruthy();
  });

  it('propagates a read failure instead of presenting an empty league', async () => {
    vi.resetModules();
    vi.doMock('../lib/supabase', () => ({
      getSupabase: () => ({
        from: () => {
          const chain: Record<string, unknown> = {};
          const self = () => chain;
          for (const method of ['select', 'eq', 'in']) chain[method] = self;
          chain.then = (resolve: (value: unknown) => void) =>
            Promise.resolve({ data: null, error: { message: 'permission denied', code: '42501' } }).then(resolve);
          return chain;
        },
      }),
    }));
    const points = await import('./points');
    const snapshot = await points.leaguePoints('L1');
    expect(snapshot.state).toBe('unavailable');
    expect(snapshot.error).toMatch(/permission denied/i);
  });
});

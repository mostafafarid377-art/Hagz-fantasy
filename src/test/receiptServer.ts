// In-memory test server: the adapter's call to domain() models the server-side
// nested RPC, not a client fallback. It preserves receipt identity and outcomes.
type Response = { data: any; error: any; status?: number };
type Envelope = { kind: string; payload: Record<string, any>; state: 'pending' | 'committed' | 'cancelled'; result?: any };
export function receiptServer(domain: (name: string, args: Record<string, any>) => Promise<Response>) {
  const rows = new Map<string, Envelope>();
  return async (args: Record<string, any>): Promise<Response> => {
    const key = `${args.p_actor}:${args.p_operation}`;
    let row = rows.get(key);
    if (args.p_action === 'register') {
      if (!row) { row = { kind: args.p_kind, payload: structuredClone(args.p_payload), state: 'pending' }; rows.set(key, row); }
      if (row.state !== 'cancelled' && (row.kind !== args.p_kind || JSON.stringify(row.payload) !== JSON.stringify(args.p_payload))) return { data: null, error: { code: '23514', message: 'operation mismatch' } };
      return { data: { state: row.state }, error: null };
    }
    if (args.p_action === 'status') return { data: row ? { state: row.state, ...(row.state === 'committed' ? { result: row.result } : {}) } : { state: 'unknown' }, error: null };
    if (args.p_action === 'cancel') {
      if (row?.state === 'committed') return { data: { state: 'committed', result: row.result }, error: null };
      if (!row) { row = { kind: '', payload: {}, state: 'cancelled' }; rows.set(key, row); } else row.state = 'cancelled';
      return { data: { state: 'cancelled' }, error: null };
    }
    if (!row) return { data: { state: 'unknown' }, error: null };
    if (row.state === 'committed') return { data: { state: 'committed', result: row.result }, error: null };
    if (row.state === 'cancelled') return { data: { state: 'cancelled' }, error: null };
    const p = row.payload;
    const calls: Record<string, [string, Record<string, any>]> = {
      league_create: ['ff_league_create', { p_name: p.name, p_budget: p.budget }],
      squad_buy: ['ff_squad_buy', { p_league: p.league, p_league_player: p.player }],
      squad_sell: ['ff_squad_sell', { p_league: p.league, p_league_player: p.player }],
      squad_transfer: ['ff_squad_transfer', { p_league: p.league, p_out: p.out, p_in: p.in }],
      squad_captains: ['ff_squad_set_captains', { p_league: p.league, p_captain: p.captain, p_vice: p.vice }],
      lineup_save: ['ff_lineup_save', { p_league: p.league, p_gameweek: p.gameweek, p_formation: p.formation, p_player_ids: p.players, p_captain: p.captain, p_vice: p.vice }],
      lineup_confirm: ['ff_lineup_confirm', { p_league: p.league, p_lineup: p.lineup }],
    };
    const call = calls[row.kind];
    if (!call) throw new Error(`unexpected operation ${row.kind}`);
    const result = await domain(...call);
    if (result.error) return result;
    row.state = 'committed'; row.result = result.data;
    return { data: { state: 'committed', result: result.data }, error: null };
  };
}

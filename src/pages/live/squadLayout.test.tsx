import { receiptServer } from '../../test/receiptServer';
import '../../test/indexedDbSetup';
/**
 * @vitest-environment jsdom
 *
 * Requirement 1 - the live squad tab.
 *
 * The three defects this locks down, all reproduced from the two mobile screenshots:
 *
 *  1. The formation did not drive the pitch. A 4-3-3 squad drew 2 GK / 5 DEF / 5 MID /
 *     3 FWD slots, because every band rendered the full squad CAPACITY (limits[])
 *     instead of the formation's requirement, and the empty-squad state fell back to
 *     capacity too. The selector changed no pixel of the pitch.
 *  2. Money read "5,000,000.0 M" and "95,000,000.0 M". The live database stores raw
 *     currency units (budget default 100000000); formatMoney() labels an amount as
 *     millions but does not scale it, so a raw amount was printed with thousand
 *     separators and forced a trailing ".0".
 *  3. The summary strip clipped its 7th cell on a 360px phone.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../../translations';

afterEach(() => { cleanup(); localStorage.removeItem('ff_live_squad_order:L1'); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/**
 * jsdom implements <dialog> as an inert element and does not ship showModal()/close().
 * The component calls showModal() on mount, so without these two stubs every picker
 * test throws "dialog.current.showModal is not a function". This is a gap in the test
 * environment, not in the component: real browsers have had <dialog> since 2022.
 */
beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
    HTMLDialogElement.prototype.close = function close() {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    };
  }
});

const league = {
  league_id: 'L1', name: 'Real League FC', role: 'manager', status: 'active',
  // Raw units, exactly what ff_bootstrap returns for a default league.
  budget: 100_000_000, market_open: true, archived: false,
  is_leader: false, is_organizer: false,
};

const squadPlayer = (n: number, position: string, price = 5_000_000) => ({
  league_player_id: `lp${n}`, name: `P${n}`, position, price, rating: 70,
  image_path: null, image_url: null, active: true, slot: n, captain: false,
});

/** A legal 15: 11 starters match 4-3-3, followed by the four saved substitutes. */
const FULL_SQUAD = [
  [1, 'GK'], [3, 'DEF'], [4, 'DEF'], [5, 'DEF'], [6, 'DEF'],
  [8, 'MID'], [9, 'MID'], [10, 'MID'], [13, 'FWD'], [14, 'FWD'], [15, 'FWD'],
  [2, 'GK'], [7, 'DEF'], [11, 'MID'], [12, 'MID'],
].map(([n, position], index) => ({ ...squadPlayer(Number(n), String(position)), slot: index + 1 }));

type RpcOverride = { data: unknown; error: { code: string; message: string } | null; status?: number };
type SquadFixtureOptions = {
  players?: unknown[]; formation?: string | null; spent?: number; builder?: boolean; market?: unknown[];
  captainId?: string | null; viceId?: string | null; gameweek?: boolean; status?: string;
  override?: (fn: string) => RpcOverride | Promise<RpcOverride> | undefined;
};
async function mountLiveSquad(opts: SquadFixtureOptions = {}) {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abcdefghijklmnop');
  vi.resetModules();

  const players = (opts.players ?? FULL_SQUAD) as any[];
  const formation = opts.formation === undefined ? '4-3-3' : opts.formation;
  const serverSquad = {
    team: { id: 't1', name: 'Real League FC' }, formation, status: opts.status ?? 'draft',
    captain_id: opts.captainId ?? null, vice_captain_id: opts.viceId ?? null,
    budget: league.budget, spent: opts.spent ?? players.length * 5_000_000,
    gameweek_id: opts.gameweek ? 'gw1' : null, players: players.map(player => ({ ...player })),
  };
  const rpcCalls: Array<{ fn: string; args?: Record<string, unknown> }> = [];

  const handleReceipt = receiptServer((name, args) => client.rpc(name, args));
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'u1' } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    // Every remaining read returns an empty result. The points reader tolerates that
    // (it reports 'no-approved-match'), and no table read should make the screen hang.
    from: () => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const method of ['select', 'eq', 'in', 'order', 'limit', 'is']) chain[method] = self;
      chain.then = (resolve: (value: unknown) => void) => Promise.resolve({ data: [], error: null }).then(resolve);
      return chain;
    },
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'ff_operation_for_actor') return handleReceipt(args!);
      rpcCalls.push({ fn, args });
      const override = opts.override?.(fn);
      if (override) return override;
      if (fn === 'ff_bootstrap') {
        return { data: { profile: { id: 'u1', display_name: 'Me' }, leagues: [league] }, error: null };
      }
      if (fn === 'ff_squad') return { data: { ...serverSquad, players: serverSquad.players.map(player => ({ ...player })) }, error: null };
      if (fn === 'ff_market_players') return { data: opts.market ?? [], error: null };
      if (fn === 'ff_gameweeks') return { data: opts.gameweek ? [{ id: 'gw1', number: 1, deadline: '2027-01-01T00:00:00Z', season_id: 'season-1', season_name: 'Season' }] : [], error: null };
      if (fn === 'ff_lineup_save') {
        const ids = args?.p_player_ids as string[];
        serverSquad.formation = String(args?.p_formation);
        serverSquad.status = 'draft'; serverSquad.gameweek_id = String(args?.p_gameweek);
        serverSquad.players = serverSquad.players.map(player => {
          const slot = ids.indexOf(player.league_player_id);
          return { ...player, slot: slot < 0 ? null : slot + 1 };
        });
        return { data: { lineup_id: 'lineup-saved', version: 2, formation: serverSquad.formation, status: 'draft' }, error: null };
      }
      if (fn === 'ff_squad_set_captains') {
        serverSquad.captain_id = args?.p_captain as string | null;
        serverSquad.vice_captain_id = args?.p_vice as string | null;
        return { data: { captain_id: serverSquad.captain_id, vice_captain_id: serverSquad.vice_captain_id }, error: null };
      }
      if (fn === 'ff_squad_transfer') {
        const incoming = (opts.market as any[] | undefined)?.find(player => player.id === args?.p_in);
        const outgoing = serverSquad.players.find(player => player.league_player_id === args?.p_out);
        if (incoming && outgoing) serverSquad.players = serverSquad.players.map(player => player === outgoing ? { ...incoming, league_player_id: incoming.id, slot: outgoing.slot, image_path: null, image_url: null } : player);
        return { data: { out: args?.p_out, in: args?.p_in, spent: serverSquad.spent }, error: null };
      }
      if (fn === 'ff_squad_sell') {
        serverSquad.players = serverSquad.players.filter(player => player.league_player_id !== args?.p_league_player);
        return { data: { league_player_id: args?.p_league_player, refund: 5_000_000 }, error: null };
      }
      if (fn === 'ff_squad_buy') {
        const incoming = (opts.market as any[] | undefined)?.find(player => player.id === args?.p_league_player);
        // Buying supersedes an unsaved draft in the API, so the refreshed squad has
        // no persisted slots. This is the regression case: the new name must not
        // alphabetically jump ahead of an existing starter and push a forward out.
        serverSquad.players = serverSquad.players.map(player => ({ ...player, slot: null }));
        serverSquad.formation = null; serverSquad.status = 'empty';
        if (incoming) serverSquad.players.push({ ...incoming, league_player_id: incoming.id, slot: null, image_path: null, image_url: null });
        return { data: { league_player_id: args?.p_league_player, price: incoming?.price ?? 0, squad_size: serverSquad.players.length, spent: serverSquad.spent }, error: null };
      }
      return { data: [], error: null };
    },
  };

  vi.doMock('../../lib/supabase', () => ({
    isSupabaseConfigured: true,
    getSupabase: () => client,
    looksLikeServiceRoleKey: () => false,
    PLAYER_IMAGES_BUCKET: 'player-images',
  }));

  const { LiveProvider } = await import('../../hooks/useLive');
  const { LiveSquad } = await import('./Squad');

  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/squad']}>
        <LiveProvider userId="u1"><LiveSquad builder={opts.builder} /></LiveProvider>
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return { serverSquad, rpcCalls };
}

/** Slot count per band, reading the empty "+ POS" placeholders. */
function emptySlotsByPosition(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const slot of document.querySelectorAll('.pitch .pitch-add')) {
    const label = slot.querySelector('small')?.textContent?.trim() ?? '';
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

describe('the formation drives the actual pitch layout', () => {
  it('an empty squad offers all 15 capacity places so every position can be filled', async () => {
    await mountLiveSquad({ players: [], formation: '4-3-3', builder: true });
    expect(emptySlotsByPosition()).toEqual({ GK: 2, DEF: 5, MID: 5, FWD: 3 });
    expect(document.querySelectorAll('.pitch .pitch-add').length).toBe(15);
  });

  it('uses the selected formation to keep surplus positions on the bench when slots are missing', async () => {
    const unslottedSquad = FULL_SQUAD.map((player) => ({ ...player, slot: null }));
    await mountLiveSquad({ players: unslottedSquad, formation: '4-3-3' });

    // The raw roster is 2 GK / 5 DEF / 5 MID / 3 FWD. A 4-3-3 XI must instead
    // contain 1 GK / 4 DEF / 3 MID / 3 FWD, with the four surplus players benched.
    expect(document.querySelector('.formation-validation')).toBeNull();
    expect(document.querySelectorAll('.pitch .pitch-player')).toHaveLength(11);
    expect(document.querySelectorAll('.bench-player:not(.bench-add)')).toHaveLength(4);
  });

  it('does not erase a remembered order when the initial squad read fails', async () => {
    const order = FULL_SQUAD.map((p) => p.league_player_id);
    localStorage.setItem('ff_live_squad_order:L1', JSON.stringify(order));
    await mountLiveSquad({ players: FULL_SQUAD.map((p) => ({ ...p, slot: null })),
      override: (fn) => fn === 'ff_squad'
        ? { data: null, error: { code: 'PGRST003', message: 'pool timeout' }, status: 504 } : undefined });
    expect(JSON.parse(localStorage.getItem('ff_live_squad_order:L1')!)).toEqual(order);
  });

  it('preserves remembered unslotted keeper and captaincy through conflict recovery', async () => {
    const order = FULL_SQUAD.map((p) => p.league_player_id);
    [order[0], order[11]] = [order[11], order[0]];
    localStorage.setItem('ff_live_squad_order:L1', JSON.stringify(order));
    const players = FULL_SQUAD.map((p) => ({ ...p, slot: null }));
    const { rpcCalls } = await mountLiveSquad({ players, builder: true, gameweek: true,
      captainId: 'lp2', viceId: 'lp3', override: (fn) => fn === 'ff_lineup_save'
        ? { data: null, error: { code: '40001', message: 'conflict' } } : undefined });
    expect(document.querySelector('.pitch [aria-label="Player details: P2"]')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save lineup' })); });
    expect(document.querySelector('.pitch [aria-label="Player details: P2"]')).toBeTruthy();
    expect(document.querySelector('.bench-strip [aria-label="Player details: P1"]')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('ff_live_squad_order:L1')!)).toEqual(order);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose players again' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save lineup' })); });
    await waitFor(() => expect(rpcCalls.filter(({ fn }) => fn === 'ff_lineup_save')).toHaveLength(2));
    const writes = rpcCalls.filter(({ fn }) => fn === 'ff_lineup_save');
    const write = writes[writes.length - 1];
    expect(write.args).toMatchObject({ p_player_ids: order, p_captain: 'lp2', p_vice: 'lp3', p_gameweek: 'gw1' });
  });

  it('adding a bench player never reshuffles the starting XI or leaves a position empty', async () => {
    const starters = [
      [1, 'GK'], [3, 'DEF'], [4, 'DEF'], [5, 'DEF'], [6, 'DEF'],
      [8, 'MID'], [9, 'MID'], [10, 'MID'], [13, 'FWD'], [14, 'FWD'], [15, 'FWD'],
    ].map(([n, position]) => ({ ...squadPlayer(Number(n), String(position)), slot: null }));
    const newKeeper = { id: 'lp16', name: 'Aardvark Keeper', position: 'GK', price: 5_000_000, rating: 80, active: true };
    const app = await mountLiveSquad({ players: starters, formation: '4-3-3', builder: true, market: [newKeeper] });
    const starterButtons = () => [...document.querySelectorAll('.pitch .pitch-player')]
      .map((button) => button.getAttribute('aria-label'));
    const originalStarters = starterButtons();
    expect(originalStarters).toHaveLength(11);

    await act(async () => { screen.getByRole('button', { name: 'Add bench player: GK' }).click(); });
    await act(async () => { screen.getByRole('button', { name: /Aardvark Keeper/ }).click(); });

    await waitFor(() => expect(document.querySelectorAll('.bench-player:not(.bench-add)')).toHaveLength(1));
    expect(starterButtons()).toEqual(originalStarters);
    expect(document.querySelectorAll('.bench-player:not(.bench-add)')).toHaveLength(1);
    expect(document.querySelector('.bench-player:not(.bench-add)')?.getAttribute('aria-label')).toBe('Player details: Aardvark Keeper');

    // Simulate a page refresh: the server returns the same roster with no slots,
    // because purchasing superseded its unsaved draft. The remembered order keeps
    // the newly bought keeper on the bench instead of promoting it into the XI.
    const refreshedPlayers = app.serverSquad.players.map((player) => ({ ...player }));
    cleanup();
    await mountLiveSquad({ players: refreshedPlayers, formation: null, market: [newKeeper] });
    expect(starterButtons()).toEqual(originalStarters);
    expect(document.querySelector('.bench-player:not(.bench-add)')?.getAttribute('aria-label')).toBe('Player details: Aardvark Keeper');
  });

  it('draws a populated 4-4-2 as its shape, not the squad capacity', async () => {
    // Ten selected players with 3 DEF / 3 MID / 3 FWD / 1 GK present expose the
    // exact 4-4-2 shortfall without pulling anyone from the bench.
    const eleven = [
      squadPlayer(1, 'GK'),
      ...Array.from({ length: 3 }, (_, i) => squadPlayer(2 + i, 'DEF')),
      ...Array.from({ length: 3 }, (_, i) => squadPlayer(5 + i, 'MID')),
      ...Array.from({ length: 3 }, (_, i) => squadPlayer(8 + i, 'FWD')),
      // A fourth forward would be dropped by a capacity-based layout; here the extra
      // player is simply on the bench, which is what "starting XI" means.
    ];
    await mountLiveSquad({ players: eleven, formation: '4-4-2', builder: true });
    // 4-4-2 wants 4 DEF / 4 MID / 2 FWD / 1 GK. Present: 3/3/3/1.
    // Shortfall: 1 DEF, 1 MID, and FWD is over by 1 so no FWD slot.
    expect(emptySlotsByPosition()).toEqual({ DEF: 1, MID: 1 });
  });

  it('a different formation changes the shortfall on the same squad', async () => {
    const eleven = [
      squadPlayer(1, 'GK'),
      ...Array.from({ length: 4 }, (_, i) => squadPlayer(2 + i, 'DEF')),
      ...Array.from({ length: 4 }, (_, i) => squadPlayer(6 + i, 'MID')),
      ...Array.from({ length: 2 }, (_, i) => squadPlayer(10 + i, 'FWD')),
    ];
    await mountLiveSquad({ players: eleven, formation: '4-4-2', builder: true });
    // Exactly the 4-4-2 shape, so nothing is missing.
    expect(emptySlotsByPosition()).toEqual({});

    cleanup();
    await mountLiveSquad({ players: eleven, formation: '3-5-2', builder: true });
    // 3-5-2 wants 5 MID / 3 DEF: DEF is over, MID is short by one.
    expect(emptySlotsByPosition()).toEqual({ MID: 1 });
  });

  it('lets a band grow past the formation rather than hide a starter', async () => {
    // FOUR defenders in a 3-5-2 (which asks for 3): the band must render 4, so no
    // squad member silently disappears from the pitch.
    const defenders = ['DEF', 'DEF', 'DEF', 'DEF'];
    const eleven = [
      squadPlayer(1, 'GK'),
      ...defenders.map((pos, i) => squadPlayer(2 + i, pos)),
      ...Array.from({ length: 5 }, (_, i) => squadPlayer(6 + i, 'MID')),
      squadPlayer(11, 'FWD'),
    ];
    await mountLiveSquad({ players: eleven, formation: '3-5-2', builder: true });
    // Every one of the eleven is on the pitch: none was hidden to honour the shape.
    expect(document.querySelectorAll('.pitch .pitch-player').length).toBe(11);
    // The DEF band grew 3 -> 4, so the shape is over capacity by one and only one
    // empty slot is left (the second FWD). The extra defender was not dropped.
    expect(emptySlotsByPosition()).toEqual({ FWD: 1 });
  });

  it('orders the bands attackers-first, as the demo pitch does', async () => {
    // Rows are emitted FWD, MID, DEF, GK regardless of what fills them.
    const eleven = [
      squadPlayer(1, 'GK'), squadPlayer(2, 'DEF'), squadPlayer(3, 'MID'), squadPlayer(4, 'FWD'),
    ];
    await mountLiveSquad({ players: eleven, formation: '4-3-3' });
    const bands = [...document.querySelectorAll('.pitch .pitch-row')].map((row) => {
      const player = row.querySelector('.pitch-player strong')?.textContent?.trim();
      if (player) return player;
      return row.querySelector('.pitch-add small')?.textContent?.trim();
    });
    // First non-empty band is the forward, the last is the goalkeeper.
    expect(bands[0]).toBe('P4');
    expect(bands[bands.length - 1]).toBe('P1');
  });
});

describe('money is shown in millions, never as raw units', () => {
  it('renders squad value and budget remaining compactly', async () => {
    // 11 players at 5M = 55M spent of a 100M budget.
    await mountLiveSquad({ spent: 55_000_000 });
    const summary = document.querySelector('.squad-summary')?.textContent?.replace(/\s/g, '') ?? '';
    expect(summary).toContain('55M');
    expect(summary).toContain('45M');
  });

  it('never prints a thousand separator or a forced .0 decimal', async () => {
    await mountLiveSquad({ spent: 5_000_000 });
    const text = document.querySelector('.squad-summary')?.textContent ?? '';
    expect(text).not.toMatch(/\d,\d{3}/);
    expect(text).not.toMatch(/\d\.0M/);
  });

  it('renders the exact screenshot values as 5M and 95M', async () => {
    // The two numbers in the bug report: squad value 5,000,000.0 M and
    // budget remaining 95,000,000.0 M.
    await mountLiveSquad({ spent: 5_000_000 });
    const text = document.querySelector('.squad-summary')?.textContent?.replace(/\s/g, '') ?? '';
    expect(text).toContain('5M');
    expect(text).toContain('95M');
    expect(text).not.toContain('5,000,000.0');
    expect(text).not.toContain('95,000,000.0');
  });
});

describe('the summary strip fits seven cells and reports real counts', () => {
  it('keeps the 7-cell strip', async () => {
    await mountLiveSquad();
    expect(document.querySelectorAll('.squad-summary > div').length).toBe(7);
  });

  it('reports the squad size against 15', async () => {
    await mountLiveSquad();
    expect(document.querySelector('.squad-summary')?.textContent).toMatch(/15\/15/);
  });

  it('reports position counts against the squad capacity, not the formation', async () => {
    // A full squad: 2 GK / 5 DEF / 5 MID / 3 FWD. These denominators are the legal
    // squad capacity (limits), which is what "GK 0/2" means on the demo screen.
    await mountLiveSquad();
    const cells = [...document.querySelectorAll('.squad-summary > div')].map((c) => c.textContent?.replace(/\s/g, '') ?? '');
    expect(cells.some((c) => c.includes('GK') && c.includes('2/2'))).toBe(true);
    expect(cells.some((c) => c.includes('DEF') && c.includes('5/5'))).toBe(true);
    expect(cells.some((c) => c.includes('MID') && c.includes('5/5'))).toBe(true);
    expect(cells.some((c) => c.includes('FWD') && c.includes('3/3'))).toBe(true);
  });
});

describe('mobile actions stay reachable below the pitch', () => {
  it('renders Edit squad / Add players in the squad-actions row after the pitch', async () => {
    await mountLiveSquad();
    const actions = document.querySelector('.squad-actions');
    expect(actions).toBeTruthy();
    const pitch = document.querySelector('.pitch');
    expect(pitch).toBeTruthy();
    // Document order: the pitch comes first, the actions follow it.
    expect(pitch!.compareDocumentPosition(actions!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(actions!.textContent).toMatch(/edit squad/i);
    expect(actions!.textContent).not.toMatch(/add players/i); // View mode stays read-only.
    await act(async () => { screen.getByRole('button', { name: /edit squad/i }).click(); });
    expect(document.querySelector('.squad-actions')?.textContent).toMatch(/add players/i);
    expect(document.querySelector('.squad-actions')?.textContent).toMatch(/view squad/i);
    expect(document.querySelector('.squad-actions')?.textContent).not.toMatch(/transfer/i);
  });

  it('does not put the market actions in the page title', async () => {
    await mountLiveSquad();
    const title = document.querySelector('.page-title');
    expect(title?.querySelectorAll('a.button').length ?? 0).toBe(0);
  });
});

describe('the squad screen uses real server data only', () => {
  it('renders the players the RPC returned and nothing else', async () => {
    await mountLiveSquad();
    const shown = [...document.querySelectorAll('.pitch .pitch-player strong')]
      .map((node) => node.textContent?.trim());
    // All names come from the mocked RPC payload (P1..), not from demo fixtures.
    for (const name of shown) expect(name).toMatch(/^P\d+$/);
  });

  it('keeps the exact saved 11 starters on the pitch and all four saved substitutes in a separate bench after reload', async () => {
    const { serverSquad } = await mountLiveSquad();
    const pitchNames = [...document.querySelectorAll('.pitch .pitch-player strong')].map(node => node.textContent?.trim()).sort();
    const benchNames = [...document.querySelectorAll('.bench-player strong')].map(node => node.textContent?.trim()).sort();
    expect(pitchNames).toEqual(['P1', 'P10', 'P13', 'P14', 'P15', 'P3', 'P4', 'P5', 'P6', 'P8', 'P9']);
    expect(benchNames).toEqual(['P11', 'P12', 'P2', 'P7']);
    expect(pitchNames.some(name => benchNames.includes(name))).toBe(false);
    expect(document.querySelectorAll('.pitch .pitch-player')).toHaveLength(11);
    expect(document.querySelectorAll('.bench-player')).toHaveLength(4);

    cleanup();
    await mountLiveSquad({ players: serverSquad.players, formation: serverSquad.formation });
    expect([...document.querySelectorAll('.pitch .pitch-player strong')].map(node => node.textContent?.trim()).sort()).toEqual(pitchNames);
    expect([...document.querySelectorAll('.bench-player strong')].map(node => node.textContent?.trim()).sort()).toEqual(benchNames);
    expect(document.querySelectorAll('.pitch .pitch-player')).toHaveLength(11);
    expect(document.querySelectorAll('.bench-player')).toHaveLength(4);
  });

  it('shows the empty-bench message when there are no substitutes', async () => {
    await mountLiveSquad({ players: FULL_SQUAD.slice(0, 11) });
    expect(document.querySelector('.bench-strip')).toBeTruthy();
    expect(document.querySelector('.bench-strip')?.textContent).toMatch(/no substitutes yet/i);
  });

  it('the builder still exposes all 15 capacity slots, whatever the formation', async () => {
    // Preserves the established builder contract (e2e/empty-slots.spec.ts asserts the
    // same count): the builder is where the whole squad is arranged.
    await mountLiveSquad({ players: [], formation: '4-3-3', builder: true });
    expect(document.querySelectorAll('.pitch .pitch-add').length).toBe(15);
    expect(emptySlotsByPosition()).toEqual({ GK: 2, DEF: 5, MID: 5, FWD: 3 });
  });

  it('no formation or captain selects remain on the My Squad tab', async () => {
    await mountLiveSquad();
    // View mode has no formation or captain dropdowns; player-sheet captaincy remains available.
    expect(document.querySelector('select[aria-label="Captain"]')).toBeNull();
    expect(document.querySelector('select[aria-label="Vice captain"]')).toBeNull();
    expect(document.querySelector('select[aria-label="Formation"]')).toBeNull();
    expect(screen.queryByText(/formation and captaincy/i)).toBeNull();
  });

  it('the BUILDER still offers the formation, which is where a shape is chosen', async () => {
    // Arranging a shape is a builder concern, so the control moves there rather than
    // disappearing - no capability is lost, it is just not on a read-mostly tab.
    await mountLiveSquad({ builder: true });
    expect(document.querySelector('select[aria-label="Formation"]')).toBeTruthy();
  });
});

describe('the + on a pitch slot opens a position-filtered player list', () => {
  const market = [
    { id: 'mp-gk', name: 'Gk One', position: 'GK', price: 4_000_000, rating: 76, active: true, image_url: null },
    { id: 'mp-def', name: 'Def One', position: 'DEF', price: 5_000_000, rating: 79, active: true, image_url: null },
    { id: 'mp-mid', name: 'Mid One', position: 'MID', price: 6_000_000, rating: 82, active: true, image_url: null },
  ];

  it('lists only players in the position that was tapped', async () => {
    // An empty squad draws all 15 capacity slots, including a DEF slot to tap.
    await mountLiveSquad({ players: [], market, builder: true });

    const slot = document.querySelector('.pitch-add[aria-label="Add player: DEF"]') as HTMLElement | null;
    expect(slot).toBeTruthy();
    await act(async () => { slot!.click(); });

    const dialog = document.querySelector('dialog.add-player-sheet');
    expect(dialog, 'the picker opens instead of navigating away').toBeTruthy();
    expect(dialog!.textContent).toContain('Add player · DEF');
    // Only the defender is offered.
    expect(dialog!.textContent).toContain('Def One');
    expect(dialog!.textContent).not.toContain('Gk One');
    expect(dialog!.textContent).not.toContain('Mid One');
  });

  it('shows the price compactly in the list', async () => {
    await mountLiveSquad({ players: [], market, builder: true });
    const slot = document.querySelector('.pitch-add[aria-label="Add player: DEF"]') as HTMLElement | null;
    await act(async () => { slot!.click(); });
    const dialog = document.querySelector('dialog.add-player-sheet');
    // Rendered compactly ("5 M"), never as raw units ("5,000,000.0 M").
    expect(dialog!.textContent).toMatch(/5\s*M/);
    expect(dialog!.textContent).not.toMatch(/5,000,000/);
  });

  it('excludes players already in the squad', async () => {
    // The single DEF in the squad is lp3; the market row for it must not be offered.
    const withOwned = [
      ...market,
      { id: 'lp3', name: 'Already Mine', position: 'DEF', price: 5_000_000, rating: 70, active: true, image_url: null },
    ];
    await mountLiveSquad({ players: [squadPlayer(3, 'DEF')], market: withOwned, builder: true });
    const slot = document.querySelector('.pitch-add[aria-label="Add player: DEF"]') as HTMLElement | null;
    await act(async () => { slot!.click(); });
    const dialog = document.querySelector('dialog.add-player-sheet');
    expect(dialog!.textContent).not.toContain('Already Mine');
    expect(dialog!.textContent).toContain('Def One');
  });

  it('says so when the position has nobody available', async () => {
    await mountLiveSquad({ players: [], market: [market[0]], builder: true }); // GK only
    const slot = document.querySelector('.pitch-add[aria-label="Add player: FWD"]') as HTMLElement | null;
    await act(async () => { slot!.click(); });
    const dialog = document.querySelector('dialog.add-player-sheet');
    expect(dialog!.textContent).toMatch(/no available players in this position/i);
  });

  it('lets the manager replace a bench player, switch to View, and edit again without losing the saved 11/4 split', async () => {
    const replacement = { id: 'market-def-new', name: 'New Defender', position: 'DEF', price: 5_000_000, rating: 80, active: true, image_url: null };
    const { serverSquad, rpcCalls } = await mountLiveSquad({ market: [replacement] });
    await act(async () => { screen.getByRole('button', { name: /edit squad/i }).click(); });
    await act(async () => { screen.getByRole('button', { name: 'Player details: P7' }).click(); });
    const sheet = screen.getByRole('dialog');
    await act(async () => { screen.getByRole('button', { name: 'Select replacement' }).click(); });
    await act(async () => { screen.getByRole('button', { name: /New Defender/ }).click(); });
    await act(async () => { screen.getByRole('button', { name: 'Confirm replacement' }).click(); });
    await waitFor(() => expect(rpcCalls.some(call => call.fn === 'ff_squad_transfer' && call.args?.p_out === 'lp7' && call.args?.p_in === 'market-def-new')).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: /view squad/i }).hasAttribute('disabled')).toBe(false));
    expect(serverSquad.players).toHaveLength(15);
    expect(serverSquad.players.some(player => player.league_player_id === 'market-def-new')).toBe(true);
    expect(document.querySelectorAll('.pitch .pitch-player')).toHaveLength(11);
    expect(document.querySelectorAll('.bench-player')).toHaveLength(4);

    await act(async () => { screen.getByRole('button', { name: /view squad/i }).click(); });
    expect(document.querySelectorAll('.pitch .pitch-player')).toHaveLength(11);
    expect(document.querySelectorAll('.bench-player')).toHaveLength(4);
    expect(screen.queryByRole('link', { name: /add players/i })).toBeNull();
    await act(async () => { screen.getByRole('button', { name: /edit squad/i }).click(); });
    expect(document.querySelector('select[aria-label="Formation"]')).toBeTruthy();
    expect(document.querySelectorAll('.pitch .pitch-player')).toHaveLength(11);
    expect(document.querySelectorAll('.bench-player')).toHaveLength(4);
    expect(sheet).toBeTruthy();
  });

  it('previews every supported formation without changing the selected 15 or promoting bench players, then saves the chosen lineup', async () => {
    const { serverSquad, rpcCalls } = await mountLiveSquad({ builder: true, gameweek: true, captainId: 'lp1', viceId: 'lp3', status: 'draft' });
    const initialPitch = [...document.querySelectorAll('.pitch .pitch-player strong')].map(node => node.textContent?.trim()).sort();
    const initialBench = [...document.querySelectorAll('.bench-player strong')].map(node => node.textContent?.trim()).sort();
    const select = document.querySelector('select[aria-label="Formation"]') as HTMLSelectElement;
    for (const shape of ['4-3-3', '4-4-2', '3-5-2', '3-4-3', '4-5-1', '5-3-2', '5-4-1']) {
      await act(async () => { fireEvent.change(select, { target: { value: shape } }); });
      expect(select.value).toBe(shape);
      if (shape === '4-4-2') {
        expect(document.querySelector('.formation-validation')?.textContent).toContain('Starting XI currently has:');
        expect(document.querySelector('.formation-validation')?.textContent).toContain('GK 1, DEF 4, MID 3, FWD 3');
      }
      expect([...document.querySelectorAll('.pitch .pitch-player strong')].map(node => node.textContent?.trim()).sort()).toEqual(initialPitch);
      expect([...document.querySelectorAll('.bench-player strong')].map(node => node.textContent?.trim()).sort()).toEqual(initialBench);
      expect(document.querySelectorAll('.pitch .pitch-player')).toHaveLength(11);
      expect(document.querySelectorAll('.bench-player')).toHaveLength(4);
    }
    expect(document.querySelector('.lineup-save-blockers')?.textContent).toContain('Formation requires:');
    expect((screen.getByRole('button', { name: 'Save lineup' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { fireEvent.change(select, { target: { value: '4-3-3' } }); });
    expect(document.querySelector('.formation-validation')).toBeNull();
    await act(async () => { screen.getByRole('button', { name: 'Save lineup' }).click(); });
    await waitFor(() => expect(rpcCalls.some(call => call.fn === 'ff_lineup_save')).toBe(true));
    const saved = rpcCalls.find(call => call.fn === 'ff_lineup_save');
    expect(saved?.args?.p_formation).toBe('4-3-3');
    expect(saved?.args?.p_player_ids).toHaveLength(15);
    expect(new Set(saved?.args?.p_player_ids as string[]).size).toBe(15);
    expect(serverSquad.formation).toBe('4-3-3');
    expect(document.querySelectorAll('.pitch .pitch-player')).toHaveLength(11);
    expect(document.querySelectorAll('.bench-player')).toHaveLength(4);

    cleanup();
    await mountLiveSquad({ players: serverSquad.players, formation: serverSquad.formation, captainId: 'lp1', viceId: 'lp3', gameweek: true, status: 'draft' });
    expect(document.querySelector('select[aria-label="Formation"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /edit squad/i }));
    expect((document.querySelector('select[aria-label="Formation"]') as HTMLSelectElement).value).toBe('4-3-3');
    expect(document.querySelectorAll('.pitch .pitch-player')).toHaveLength(11);
    expect(document.querySelectorAll('.bench-player')).toHaveLength(4);
  });

  it('Edit Squad and View Squad preserve the 11-player pitch and separate editable bench', async () => {
    await mountLiveSquad();
    expect(document.querySelectorAll('.pitch .pitch-player').length).toBe(11);
    expect(document.querySelectorAll('.bench-player').length).toBe(4);

    await act(async () => { screen.getByRole('button', { name: /edit squad/i }).click(); });
    expect(document.querySelectorAll('.pitch .pitch-player').length).toBe(11);
    expect(document.querySelectorAll('.bench-player').length).toBe(4);
    expect(screen.getByRole('button', { name: /view squad/i })).toBeTruthy();
    expect(document.querySelector('select[aria-label="Formation"]')).toBeTruthy();

    await act(async () => { screen.getByRole('button', { name: /view squad/i }).click(); });
    expect(document.querySelectorAll('.pitch .pitch-player').length).toBe(11);
    expect(document.querySelectorAll('.bench-player').length).toBe(4);
    expect(document.querySelector('select[aria-label="Formation"]')).toBeNull();
    await act(async () => { (document.querySelector('.bench-player') as HTMLButtonElement).click(); });
    expect(document.querySelector('dialog.player-sheet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Select replacement' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });
});


describe('substitution conflict recovery', () => {
  it.each([false, true])('requires a fresh selection after 40001 (first squad read fails: %s)', async (failRefresh) => {
    let finishWrite!: (value: RpcOverride) => void;
    const pending = new Promise<RpcOverride>((resolve) => { finishWrite = resolve; });
    let writes = 0;
    let failNextSquadRead = false;
    const { rpcCalls, serverSquad } = await mountLiveSquad({
      builder: true, gameweek: true, captainId: 'lp1', viceId: 'lp3',
      override: (fn) => {
        if (fn === 'ff_lineup_save' && ++writes === 1) return pending;
        if (fn === 'ff_squad' && failNextSquadRead) {
          failNextSquadRead = false;
          return { data: null, error: { code: 'PGRST003', message: 'pool timeout' }, status: 504 };
        }
      },
    });
    const startSwap = (name: string) => {
      fireEvent.click(screen.getByRole('button', { name: `Player details: ${name}` }));
      fireEvent.click(screen.getByRole('button', { name: 'Make substitution' }));
    };
    startSwap('P2'); // from the bench first
    const target = screen.getByRole('button', { name: 'Select swap player: P1' });
    const saveButton = screen.getByRole('button', { name: 'Save lineup' });
    const start = rpcCalls.length;
    act(() => {
      fireEvent.click(target);
      fireEvent.click(target);
      fireEvent.click(saveButton);
    });
    expect(target.matches(':disabled')).toBe(true);
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(rpcCalls.slice(start).map(({ fn }) => fn)).toEqual(['ff_lineup_save']));
    expect(screen.getByText('Saving squad change…')).toBeTruthy();

    // Another session has already promoted P2 and made P4 captain. The old clicks
    // must not revert that swap or send the old captain on the manager's next try.
    serverSquad.players = serverSquad.players.map((player) => ({ ...player,
      slot: player.league_player_id === 'lp2' ? 1 : player.league_player_id === 'lp1' ? 12 : player.slot,
    }));
    serverSquad.captain_id = 'lp4';
    failNextSquadRead = failRefresh;
    await act(async () => { finishWrite({ data: null, error: { code: '40001', message: 'stale squad revision' } }); });
    await waitFor(() => expect(rpcCalls.slice(start).map(({ fn }) => fn)).toEqual(['ff_lineup_save', 'ff_squad']));
    expect(screen.queryByText('Choose a player to swap')).toBeNull();
    expect(screen.queryByText('Players swapped.')).toBeNull();
    expect(localStorage.getItem('ff_live_squad_order:L1')).toBeNull(); // No remembered order was saved.

    if (failRefresh) {
      expect((saveButton as HTMLButtonElement).disabled).toBe(true);
      expect(screen.queryByRole('button', { name: 'Choose players again' })).toBeNull();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check operation' })); });
      await waitFor(() => expect(rpcCalls.slice(start).map(({ fn }) => fn)).toEqual(['ff_lineup_save', 'ff_squad', 'ff_squad']));
    }
    const review = await screen.findByRole('button', { name: 'Choose players again' });
    expect(document.querySelector('.pitch [aria-label="Player details: P2"]')).toBeTruthy();
    expect(document.querySelector('.bench-strip [aria-label="Player details: P1"]')).toBeTruthy();
    fireEvent.click(review);
    expect(writes).toBe(1); // Reviewing/clearing the gate is not a submission.
    expect(screen.queryByText('Choose a player to swap')).toBeNull();

    startSwap('P3'); // new starter-first choice from the refreshed lineup
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Select swap player: P7' })); });
    await waitFor(() => expect(rpcCalls.filter(({ fn }) => fn === 'ff_lineup_save')).toHaveLength(2));
    const saves = rpcCalls.filter(({ fn }) => fn === 'ff_lineup_save');
    expect(saves).toHaveLength(2);
    expect(saves[1].args).toMatchObject({ p_formation: '4-3-3', p_captain: 'lp4', p_vice: 'lp3', p_gameweek: 'gw1' });
    expect((saves[1].args?.p_player_ids as string[]).slice(0, 2)).toEqual(['lp2', 'lp7']);
    expect(await screen.findByText('Players swapped.')).toBeTruthy();
    expect(rpcCalls.slice(start).some(({ fn }) => fn === 'ff_bootstrap' || fn === 'ff_squad_substitute')).toBe(false);
  });
});

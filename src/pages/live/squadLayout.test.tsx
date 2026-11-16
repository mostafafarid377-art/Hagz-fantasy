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
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../../translations';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

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

/** A legal 15: 2 GK / 5 DEF / 5 MID / 3 FWD. */
const FULL_SQUAD = [
  squadPlayer(1, 'GK'), squadPlayer(2, 'GK'),
  ...Array.from({ length: 5 }, (_, i) => squadPlayer(3 + i, 'DEF')),
  ...Array.from({ length: 5 }, (_, i) => squadPlayer(8 + i, 'MID')),
  ...Array.from({ length: 3 }, (_, i) => squadPlayer(13 + i, 'FWD')),
];

async function mountLiveSquad(opts: { players?: unknown[]; formation?: string | null; spent?: number; builder?: boolean; market?: unknown[] } = {}) {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abcdefghijklmnop');
  vi.resetModules();

  const players = opts.players ?? FULL_SQUAD;
  const formation = opts.formation === undefined ? '4-3-3' : opts.formation;

  const client = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
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
    rpc: async (fn: string) => {
      if (fn === 'ff_bootstrap') {
        return { data: { profile: { id: 'u1', display_name: 'Me' }, leagues: [league] }, error: null };
      }
      if (fn === 'ff_squad') {
        return {
          data: {
            team: { id: 't1', name: 'Real League FC' }, formation, status: 'draft',
            captain_id: null, vice_captain_id: null,
            budget: league.budget, spent: opts.spent ?? players.length * 5_000_000, players,
          },
          error: null,
        };
      }
      if (fn === 'ff_market_players') return { data: opts.market ?? [], error: null };
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
    await mountLiveSquad({ players: [], formation: '4-3-3' });
    expect(emptySlotsByPosition()).toEqual({ GK: 2, DEF: 5, MID: 5, FWD: 3 });
    expect(document.querySelectorAll('.pitch .pitch-add').length).toBe(15);
  });

  it('draws a populated 4-3-3 as its shape, not the capacity', async () => {
    // 11 starters with 3 DEF / 3 MID / 3 FWD / 1 GK present, so the empty slots are
    // exactly the shortfall of the 4-3-3 shape: 1 GK, 1 DEF, 0 MID, 0 FWD.
    const eleven = [
      squadPlayer(1, 'GK'),
      ...Array.from({ length: 3 }, (_, i) => squadPlayer(2 + i, 'DEF')),
      ...Array.from({ length: 3 }, (_, i) => squadPlayer(5 + i, 'MID')),
      ...Array.from({ length: 3 }, (_, i) => squadPlayer(8 + i, 'FWD')),
      // A fourth forward would be dropped by a capacity-based layout; here the extra
      // player is simply on the bench, which is what "starting XI" means.
    ];
    await mountLiveSquad({ players: eleven, formation: '4-4-2' });
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
    await mountLiveSquad({ players: eleven, formation: '4-4-2' });
    // Exactly the 4-4-2 shape, so nothing is missing.
    expect(emptySlotsByPosition()).toEqual({});

    cleanup();
    await mountLiveSquad({ players: eleven, formation: '3-5-2' });
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
    await mountLiveSquad({ players: eleven, formation: '3-5-2' });
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
    expect(actions!.textContent).toMatch(/add players/i);
    // "Make a transfer" was replaced by "Edit squad", matching the demo tab.
    expect(actions!.textContent).toMatch(/edit squad/i);
    expect(actions!.textContent).not.toMatch(/transfer/i);
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

  it('puts exactly 11 on the pitch and the remaining 4 on the bench', async () => {
    await mountLiveSquad();
    expect(document.querySelectorAll('.pitch .pitch-player').length).toBe(11);
    expect(document.querySelectorAll('.bench-player').length).toBe(4);
    expect(document.querySelector('.bench-strip')).toBeTruthy();
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
    // Removed on request: "Remove formation and captaincy from squad tab."
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
    await mountLiveSquad({ players: [], market });

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
    await mountLiveSquad({ players: [], market });
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
    await mountLiveSquad({ players: [squadPlayer(3, 'DEF')], market: withOwned });
    const slot = document.querySelector('.pitch-add[aria-label="Add player: DEF"]') as HTMLElement | null;
    await act(async () => { slot!.click(); });
    const dialog = document.querySelector('dialog.add-player-sheet');
    expect(dialog!.textContent).not.toContain('Already Mine');
    expect(dialog!.textContent).toContain('Def One');
  });

  it('says so when the position has nobody available', async () => {
    await mountLiveSquad({ players: [], market: [market[0]] }); // GK only
    const slot = document.querySelector('.pitch-add[aria-label="Add player: FWD"]') as HTMLElement | null;
    await act(async () => { slot!.click(); });
    const dialog = document.querySelector('dialog.add-player-sheet');
    expect(dialog!.textContent).toMatch(/no available players in this position/i);
  });

  it('Edit squad switches the pitch to the whole squad and hides the bench', async () => {
    await mountLiveSquad();
    // Normal view: 11 on the pitch, 4 on the bench.
    expect(document.querySelectorAll('.pitch .pitch-player').length).toBe(11);
    expect(document.querySelector('.bench-strip')).toBeTruthy();

    const edit = screen.getByRole('button', { name: /edit squad/i });
    await act(async () => { edit.click(); });

    // Edit view: all 15 on the pitch, no bench strip, and a way back.
    expect(document.querySelectorAll('.pitch .pitch-player').length).toBe(15);
    expect(document.querySelector('.bench-strip')).toBeNull();
    expect(screen.getByRole('button', { name: /view squad/i })).toBeTruthy();

    await act(async () => { screen.getByRole('button', { name: /view squad/i }).click(); });
    expect(document.querySelectorAll('.pitch .pitch-player').length).toBe(11);
    expect(document.querySelector('.bench-strip')).toBeTruthy();
  });
});

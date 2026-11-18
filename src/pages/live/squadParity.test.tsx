import { receiptServer } from '../../test/receiptServer';
import '../../test/indexedDbSetup';
/**
 * @vitest-environment jsdom
 *
 * The saved View Squad remains a pitch-first, read-only view with a distinct Bench;
 * Edit Squad exposes formation, roster changes and player actions without replacing
 * the server-authoritative lineup or routing the manager into a dead-end screen.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../../translations';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const league = {
  league_id: 'L1', name: 'Real League FC', role: 'manager', status: 'active',
  budget: 100, market_open: true, archived: false, is_leader: false, is_organizer: false,
};

const squadPlayer = (n: number, position: string) => ({
  league_player_id: `lp${n}`, name: `P${n}`, position, price: 5, rating: 70,
  image_path: null, image_url: null, active: true, slot: n, captain: false,
});

const FULL_SQUAD = [
  squadPlayer(1, 'GK'), squadPlayer(2, 'GK'),
  ...Array.from({ length: 5 }, (_, i) => squadPlayer(3 + i, 'DEF')),
  ...Array.from({ length: 5 }, (_, i) => squadPlayer(8 + i, 'MID')),
  ...Array.from({ length: 3 }, (_, i) => squadPlayer(13 + i, 'FWD')),
];

async function mountLiveSquad(players = FULL_SQUAD, formation = '4-3-3') {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'sb_publishable_abcdefghijklmnop');
  vi.resetModules();

  const calls: string[] = [];
  let lineupArgs: Record<string, unknown> | undefined;
  let captaincyArgs: Record<string, unknown> | undefined;
  let captainId: string | null = null;
  let viceId: string | null = null;
  const handleReceipt = receiptServer((name, args) => client.rpc(name, args));
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'u1' } } }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'ff_operation_for_actor') return handleReceipt(args!);
      calls.push(fn);
      if (fn === 'ff_lineup_save') lineupArgs = args;
      if (fn === 'ff_squad_set_captains') { captaincyArgs = args; captainId = (args?.p_captain as string | null) ?? null; viceId = (args?.p_vice as string | null) ?? null; }
      if (fn === 'ff_bootstrap') {
        return { data: { profile: { id: 'u1', display_name: 'Me' }, leagues: [league] }, error: null };
      }
      if (fn === 'ff_squad') {
        return { data: { team: { id: 't1', name: 'Real League FC' }, formation, status: 'draft',
          captain_id: captainId, vice_captain_id: viceId, budget: 100, spent: 10, players }, error: null };
      }
      if (fn === 'ff_lineup_save') return { data: { lineup_id: 'lineup1', version: 1, formation: '4-3-3', status: 'draft' }, error: null };
      if (fn === 'ff_squad_set_captains') return { data: { captain_id: captainId, vice_captain_id: viceId }, error: null };
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
        <LiveProvider userId="u1"><LiveSquad /></LiveProvider>
      </MemoryRouter>,
    );
  });
  for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  return { calls, getLineupArgs: () => lineupArgs, getCaptaincyArgs: () => captaincyArgs };
}

describe('the live squad tab is laid out like the demo one', () => {
  it('shows the pitch', async () => {
    await mountLiveSquad();
    expect(document.querySelector('.pitch')).toBeTruthy();
  });

  it('uses the demo squad layout wrapper', async () => {
    await mountLiveSquad();
    expect(document.querySelector('.squad-layout')).toBeTruthy();
  });

  it('stacks positions on the pitch itself instead of in stat cards', async () => {
    await mountLiveSquad();
    // The old screen put GK/DEF/MID/FWD counts in four stat cards above the pitch.
    // The demo screen shows positions on the pitch, which is the point of a pitch.
    expect(document.querySelector('.pitch .pitch-player, .pitch .pitch-empty')).toBeTruthy();
  });

  it('shows the bench strip under the pitch', async () => {
    await mountLiveSquad();
    expect(document.querySelector('.bench-strip')).toBeTruthy();
  });
});

describe('the summary strip matches the demo squad screen', () => {
  it('shows the 7-cell summary: size, value, budget, then four position counts', async () => {
    await mountLiveSquad();
    const cells = document.querySelectorAll('.squad-summary > div');
    expect(cells.length).toBe(7);
  });

  it('labels the cells the way the demo does', async () => {
    await mountLiveSquad();
    const text = document.querySelector('.squad-summary')?.textContent ?? '';
    for (const label of ['Squad', 'Squad value', 'Budget remaining', 'GK', 'DEF', 'MID', 'FWD']) {
      expect(text).toContain(label);
    }
  });

  it('shows the squad as n/15', async () => {
    await mountLiveSquad();
    const text = document.querySelector('.squad-summary')?.textContent ?? '';
    // FULL_SQUAD is 15 players.
    expect(text).toMatch(/15\/15/);
  });
});

describe('there is no squad list under the pitch', () => {
  it('renders no roster rows', async () => {
    await mountLiveSquad();
    expect(document.querySelectorAll('.roster-row').length).toBe(0);
  });

  it('renders no roster panel', async () => {
    await mountLiveSquad();
    expect(document.querySelectorAll('.roster').length).toBe(0);
  });

  it('does not repeat every player name a second time below the pitch', async () => {
    await mountLiveSquad();
    // Each player should appear once - on the pitch. The roster list showed them
    // all again underneath, which is what the user asked to remove.
    const occurrences = screen.queryAllByText('P1', { exact: true }).length;
    expect(occurrences).toBeGreaterThan(0);
    expect(occurrences).toBe(1);
  });
});

describe('View Squad keeps captaincy and substitution while hiding roster changes', () => {
  it('shows player actions in View Squad but keeps replacement and removal in Edit Squad', async () => {
    await mountLiveSquad();
    expect(document.querySelector('select[aria-label="Formation"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Player details: P1' }));
    expect(screen.getByRole('link', { name: 'Full profile' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Captain' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Vice captain' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make substitution' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Select replacement' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('can set captain and vice and complete a substitution from View Squad', async () => {
    const { calls, getCaptaincyArgs } = await mountLiveSquad(FULL_SQUAD, '5-4-1');
    fireEvent.click(screen.getByRole('button', { name: 'Player details: P1' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Captain' })); });
    await waitFor(() => expect(calls.filter(call => call === 'ff_squad_set_captains')).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Captain' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Player details: P3' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Vice captain' })); });
    await waitFor(() => expect(calls.filter(call => call === 'ff_squad_set_captains')).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Vice captain' }).hasAttribute('disabled')).toBe(false));
    expect(getCaptaincyArgs()).toMatchObject({ p_captain: 'lp1', p_vice: 'lp3' });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Player details: P1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Make substitution' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Select swap player: P13' })); });
    await waitFor(() => expect(calls).toContain('ff_lineup_save'));
  });

  it('exposes formation, captaincy, replacement, and substitution controls in Edit Squad', async () => {
    await mountLiveSquad();
    fireEvent.click(screen.getByRole('button', { name: 'Edit squad' }));
    expect(document.querySelector('select[aria-label="Formation"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Player details: P1' }));
    expect(screen.getByRole('button', { name: 'Captain' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Select replacement' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make substitution' })).toBeTruthy();
  });
});

describe('Edit squad opens the player market', () => {
  it('the dashboard Edit squad action routes to /market', async () => {
    await mountLiveSquad();
    // The live dashboard's "Edit squad" must not point at /squad-builder: in live
    // mode that route renders this same screen again, so the button appeared dead.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/pages/live/League.tsx', 'utf8');
    expect(src).toContain('action="Edit squad" to="/market"');
    expect(src).not.toContain('action="Edit squad" to="/squad-builder"');
  });

  it('the squad screen links to the market only while editing', async () => {
    await mountLiveSquad();
    expect([...document.querySelectorAll('a')].map((a) => a.getAttribute('href'))).not.toContain('/market');
    fireEvent.click(screen.getByRole('button', { name: 'Edit squad' }));
    expect([...document.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toContain('/market');
  });
});


describe('captaincy can be set before the squad is complete', () => {
  it('saves a captain for an incomplete squad without attempting a lineup save', async () => {
    const app = await mountLiveSquad([
      squadPlayer(1, 'GK'), squadPlayer(2, 'MID'), squadPlayer(3, 'MID'),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit squad' }));
    fireEvent.click(screen.getByRole('button', { name: 'Player details: P1' }));

    const captainButton = screen.getByRole('button', { name: 'Captain' });
    expect(captainButton.hasAttribute('disabled')).toBe(false);
    await act(async () => { fireEvent.click(captainButton); });

    await waitFor(() => expect(app.calls).toContain('ff_squad_set_captains'));
    expect(app.calls).not.toContain('ff_lineup_save');
    expect(app.getCaptaincyArgs()).toMatchObject({ p_captain: 'lp1', p_vice: null });
  });

  it('saves captain and vice independently, even with fewer than 15 players', async () => {
    const app = await mountLiveSquad([
      squadPlayer(1, 'GK'), squadPlayer(2, 'MID'), squadPlayer(3, 'MID'),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit squad' }));
    fireEvent.click(screen.getByRole('button', { name: 'Player details: P1' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Captain' })); });

    await waitFor(() => expect(app.calls.filter(call => call === 'ff_squad_set_captains')).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Captain' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Player details: P2' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Vice captain' })); });

    await waitFor(() => expect(app.calls.filter((call) => call === 'ff_squad_set_captains')).toHaveLength(2));
    expect(app.calls).not.toContain('ff_lineup_save');
    expect(app.getCaptaincyArgs()).toMatchObject({ p_captain: 'lp1', p_vice: 'lp2' });
  });
});

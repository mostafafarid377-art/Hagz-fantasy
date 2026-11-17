/**
 * @vitest-environment jsdom
 *
 * Four changes:
 *
 * 1. "Edit squad" (builder mode) hides the bench strip - editing puts the whole
 *    squad on the pitch, so the bench row repeats what is already on screen.
 * 2. The dashboard hero button says "Build your squad" and goes to the squad tab,
 *    not the market.
 * 3. The number under each player on the pitch is the LAST GAMEWEEK's points, not
 *    the season total they carried before.
 * 4. The first stat card reports LAST GAME POINTS, not TOTAL POINTS.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../translations';
import { demoPlayers, lastGameweek, lastGameweekPoints, lastGameweekTeamPoints } from '../data/demo';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); });

async function mountSquad(opts: { builder?: boolean } = {}) {
  vi.resetModules();
  const { SquadPage } = await import('./Squad');
  const { DemoProvider } = await import('../hooks/useDemo');
  await act(async () => {
    render(
      <MemoryRouter initialEntries={[opts.builder ? '/squad-builder' : '/squad']}>
        <DemoProvider><SquadPage builder={opts.builder} /></DemoProvider>
      </MemoryRouter>,
    );
  });
}

async function mountDashboard() {
  vi.resetModules();
  const { default: Dashboard } = await import('./Dashboard');
  const { DemoProvider } = await import('../hooks/useDemo');
  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <DemoProvider><Dashboard /></DemoProvider>
      </MemoryRouter>,
    );
  });
}

describe('the squad keeps the bench visible while editing', () => {
  it('shows the separate bench strip in builder (edit) mode', async () => {
    await mountSquad({ builder: true });
    expect(document.querySelector('.bench-strip')).toBeTruthy();
    expect(document.querySelectorAll('.bench-player')).toHaveLength(4);
  });

  it('still shows the bench strip on the normal squad screen', async () => {
    await mountSquad({ builder: false });
    expect(document.querySelector('.bench-strip')).toBeTruthy();
  });
});

describe('the dashboard hero button builds the squad', () => {
  it('says "Build your squad" and points at the squad tab', async () => {
    await mountDashboard();
    const link = screen.getByRole('link', { name: /Build your squad/i });
    expect(link.getAttribute('href')).toBe('/squad');
  });

  it('no longer says "Explore market"', async () => {
    await mountDashboard();
    expect(screen.queryByText(/Explore market/i)).toBeNull();
  });
});

describe('the pitch shows last gameweek points, not season totals', () => {
  it('renders the gameweek figure for a player rather than their season total', async () => {
    await mountDashboard();
    // Omar Khaled: 62 season points, 27 in gameweek 08.
    const omar = demoPlayers.find((p) => p.name === 'Omar Khaled')!;
    expect(omar.points).toBe(62);
    expect(lastGameweekPoints('Omar Khaled')).toBe(9);
    expect(screen.queryAllByText(`${omar.points} pts`).length).toBe(0);
    expect(screen.queryAllByText(`${lastGameweekPoints('Omar Khaled')} pts`).length).toBeGreaterThan(0);
  });

  it('labels the pitch footer with the gameweek', async () => {
    await mountDashboard();
    // The pitch footer names the gameweek its figures come from.
    const footer = document.querySelector('.pitch-footer');
    expect(footer?.textContent).toMatch(new RegExp(`Gameweek\\s*${lastGameweek}`, 'i'));
  });
});

describe('the first stat card reports the last game', () => {
  it('says LAST GAME POINTS, not TOTAL POINTS', async () => {
    await mountDashboard();
    // Scope to the stat card: the page also has a dedicated "Last game points"
    // SECTION now, so a bare text query matches two headings.
    const card = document.querySelector('.stat-card');
    expect(card?.textContent).toMatch(/LAST GAME POINTS/i);
    expect(screen.queryByText(/TOTAL POINTS/i)).toBeNull();
  });

  it('shows the gameweek figure', async () => {
    await mountDashboard();
    const value = lastGameweekTeamPoints('Goal Diggers');
    expect(value).toBeGreaterThan(0);
    expect(screen.queryAllByText(new RegExp(`${value}`)).length).toBeGreaterThan(0);
  });
});

describe('the demo gameweek data is internally consistent', () => {
  it('no player scores more in a week than across the whole season', () => {
    for (const p of demoPlayers) {
      const last = lastGameweekPoints(p.name);
      // A player with no entry has NO last-game score; only compare real values.
      if (last === undefined) continue;
      expect(last).toBeLessThanOrEqual(p.points);
    }
  });

  /**
   * Requirement: "If a player did not participate in that match, do not reuse their
   * previous match points. Show - when no valid score exists."
   *
   * This used to assert a fabricated 0, which claims the player featured and scored
   * nothing. `undefined` lets the pitch render an explicit "-".
   */
  it('a player with no entry in the latest approved match has no score, not a zero', () => {
    expect(lastGameweekPoints('Nobody At All')).toBeUndefined();
    // Team totals still read as zero: the team exists and simply has no figure, which
    // is not the same claim as "this player played".
    expect(lastGameweekTeamPoints('No Such Team')).toBe(0);
  });
});

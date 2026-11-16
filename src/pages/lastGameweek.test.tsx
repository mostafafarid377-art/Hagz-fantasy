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

describe('editing the squad hides the bench', () => {
  it('shows no bench strip in builder (edit) mode', async () => {
    await mountSquad({ builder: true });
    expect(document.querySelector('.bench-strip')).toBeNull();
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
    expect(screen.getByText(/LAST GAME POINTS/i)).toBeTruthy();
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
      expect(lastGameweekPoints(p.name)).toBeLessThanOrEqual(p.points);
    }
  });

  it('a player with no gameweek entry reads as zero, not undefined', () => {
    expect(lastGameweekPoints('Nobody At All')).toBe(0);
    expect(lastGameweekTeamPoints('No Such Team')).toBe(0);
  });
});

/**
 * @vitest-environment jsdom
 *
 * Removing the roster list removed more than a redundant list: those rows were the
 * ONLY place a squad player could be removed from the squad. e2e/app.spec.ts clicks
 * "Remove: Tamer Hany", so without a replacement control the flow silently breaks.
 *
 * The pitch now carries a remove button. These tests pin that, and pin the DOM
 * structure: .pitch-player is itself a <button> (or an <a>), so the remove control
 * must be its SIBLING. Nesting a button inside a button is invalid HTML and
 * browsers re-parent it, which breaks the click target.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../translations';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); });

async function mountBuilder() {
  vi.resetModules();
  const { SquadPage } = await import('./Squad');
  const { DemoProvider } = await import('../hooks/useDemo');
  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/squad-builder']}>
        <DemoProvider><SquadPage builder /></DemoProvider>
      </MemoryRouter>,
    );
  });
}

describe('a squad player can still be removed without the roster list', () => {
  it('renders a remove control for squad players', async () => {
    await mountBuilder();
    const removeButtons = document.querySelectorAll('[aria-label^="Remove:"]');
    expect(removeButtons.length).toBeGreaterThan(0);
  });

  it('keeps the remove control OUT of the player button', async () => {
    await mountBuilder();
    const remove = document.querySelector('.pitch-remove');
    const player = document.querySelector('.pitch-player');
    expect(remove).toBeTruthy();
    expect(player).toBeTruthy();
    // Invalid nesting would make the browser re-parent this node.
    expect(player!.contains(remove!)).toBe(false);
    expect(remove!.parentElement?.className).toContain('pitch-slot');
  });

  it('actually removes the player when clicked', async () => {
    await mountBuilder();
    const before = document.querySelectorAll('.pitch-player').length;
    expect(before).toBeGreaterThan(0);
    const remove = document.querySelector('.pitch-remove') as HTMLElement;
    await act(async () => { remove.click(); });
    expect(document.querySelectorAll('.pitch-player').length).toBe(before - 1);
  });
});

/**
 * @vitest-environment jsdom
 *
 * Layout tests for the squad screen.
 *
 * THE REQUEST: opening the squad should show the PITCH first - not a page header
 * full of buttons, and not a wall of validation text. Specifically:
 *
 *   1. The "Squad needs attention" panel is gone.
 *   2. "Edit squad" and "Add players" sit BELOW the pitch, not above it.
 *   3. The pitch is the first thing in the content area.
 *
 * The ordering assertions are on DOM position, not just presence: a control that
 * merely exists but renders above the pitch would defeat the whole point.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../translations';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function mountSquad(opts: { builder?: boolean } = { builder: true }) {
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

/** Document order comparison: is `a` before `b` in the rendered DOM? */
function comesBefore(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('the squad page shows the pitch first', () => {
  it('does not render the "Squad needs attention" panel', async () => {
    await mountSquad();
    expect(screen.queryByText('Squad needs attention')).toBeNull();
    // The list of blocking rules went with the panel.
    expect(screen.queryByText('Select exactly 15 players.')).toBeNull();
  });

  it('renders the "Add players" action below the pitch', async () => {
    await mountSquad();
    const pitch = document.querySelector('.pitch');
    expect(pitch).toBeTruthy();
    const addPlayers = screen.getByRole('link', { name: /add players/i });
    expect(comesBefore(pitch!, addPlayers)).toBe(true);
  });

  it('renders the "Edit squad" action below the pitch', async () => {
    // The non-builder variant labels the link "Edit squad" (builder says "View squad").
    await mountSquad({ builder: false });
    const pitch = document.querySelector('.pitch');
    const editSquad = screen.getByRole('link', { name: /edit squad/i });
    expect(comesBefore(pitch!, editSquad)).toBe(true);
  });

  it('puts the action row after the squad panel, in a dedicated row', async () => {
    await mountSquad();
    const actions = document.querySelector('.squad-actions');
    expect(actions).toBeTruthy();
    const pitch = document.querySelector('.pitch');
    expect(comesBefore(pitch!, actions!)).toBe(true);
  });

  it('the page title carries no action buttons', async () => {
    await mountSquad();
    const title = document.querySelector('.page-title');
    expect(title).toBeTruthy();
    // Buttons used to live in the header, above the pitch.
    expect(title!.querySelectorAll('a.button').length).toBe(0);
  });
});

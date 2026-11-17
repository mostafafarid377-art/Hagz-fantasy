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
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../translations';

afterEach(() => { cleanup(); vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  if (!HTMLDialogElement.prototype.close) HTMLDialogElement.prototype.close = function close() { this.open = false; this.dispatchEvent(new Event('close')); };
});

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
    await mountSquad({ builder: false });
    const pitch = document.querySelector('.pitch');
    const editSquad = screen.getByRole('link', { name: /edit squad/i });
    expect(comesBefore(pitch!, editSquad)).toBe(true);
  });

  it('keeps exactly 11 starters on the pitch and all four saved substitutes in the bench in both modes', async () => {
    await mountSquad({ builder: true });
    expect(document.querySelectorAll('.pitch .pitch-player')).toHaveLength(11);
    expect(document.querySelectorAll('.bench-player')).toHaveLength(4);
    const pitchNames = [...document.querySelectorAll('.pitch .pitch-player strong')].map(node => node.textContent?.trim());
    const benchNames = [...document.querySelectorAll('.bench-player strong')].map(node => node.textContent?.trim());
    expect(pitchNames).toHaveLength(11);
    expect(benchNames).toHaveLength(4);
    expect(pitchNames.some(name => benchNames.includes(name))).toBe(false);

    cleanup();
    await mountSquad({ builder: false });
    expect(document.querySelectorAll('.pitch .pitch-player')).toHaveLength(11);
    expect(document.querySelectorAll('.bench-player')).toHaveLength(4);
    expect(screen.queryByRole('link', { name: /add players/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /remove player/i })).toBeNull();
    await act(async () => { (document.querySelector('.bench-player') as HTMLButtonElement).click(); });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Captain$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make substitution' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Select replacement' })).toBeNull();
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

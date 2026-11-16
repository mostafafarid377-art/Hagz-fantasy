/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { Avatar } from '../components/UI';
import { playerImage } from '../services/playerImage';

const { signedUrl } = vi.hoisted(() => ({ signedUrl: vi.fn() }));
vi.mock('../services/storage', () => ({ imageUrl: signedUrl }));
afterEach(() => { cleanup(); signedUrl.mockReset(); });

describe('private player image display', () => {
  it('resolves stable storage paths to an authenticated signed URL after mounting and remounting', async () => {
    signedUrl.mockResolvedValue('https://example.test/signed');
    const ref = playerImage({ image_path: 'league/players/id.png', image_url: null });
    const first = render(<Avatar name="Alice Smith" image={ref} />);
    await waitFor(() => expect(first.container.querySelector('img')?.getAttribute('src')).toBe('https://example.test/signed'));
    expect(signedUrl).toHaveBeenCalledWith('league/players/id.png');
    first.unmount();
    const second = render(<Avatar name="Alice Smith" image={ref} />);
    await waitFor(() => expect(second.container.querySelector('img')?.getAttribute('src')).toBe('https://example.test/signed'));
    expect(signedUrl).toHaveBeenCalledTimes(2);
  });
  it('falls back to initials when a private image cannot be read', async () => {
    signedUrl.mockResolvedValue(null);
    render(<Avatar name="Alice Smith" image={playerImage({ image_path: 'league/players/missing.png' })} />);
    await waitFor(() => expect(signedUrl).toHaveBeenCalled());
    expect(screen.getByText('AS')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
  it('renews a private signed URL after 45 minutes and falls back if renewal is denied', async () => {
    vi.useFakeTimers();
    try {
      signedUrl.mockResolvedValueOnce('https://example.test/first').mockResolvedValueOnce(null);
      const view = render(<Avatar name="Alice Smith" image={playerImage({ image_path: 'league/players/id.png' })} />);
      await act(async () => { await Promise.resolve(); });
      expect(view.container.querySelector('img')?.getAttribute('src')).toBe('https://example.test/first');
      await act(async () => { await vi.advanceTimersByTimeAsync(45 * 60 * 1000); });
      expect(signedUrl).toHaveBeenCalledTimes(2);
      expect(view.container.querySelector('img')).toBeNull();
      expect(screen.getByText('AS')).toBeTruthy();
    } finally { vi.useRealTimers(); }
  });
  it('leaves external and demo references unchanged', () => {
    expect(playerImage({ image_url: 'https://example.test/photo.jpg' })).toBe('https://example.test/photo.jpg');
    const { container } = render(<Avatar name="Demo Player" image="https://example.test/photo.jpg" />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.test/photo.jpg');
    expect(signedUrl).not.toHaveBeenCalled();
  });
});

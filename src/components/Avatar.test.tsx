/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Avatar } from './UI';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('falls back when an image has already failed before the error handler runs', () => {
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(0);
  const { container } = render(<Avatar name="Omar Khaled" image="/broken.png" />);
  expect(screen.getByText('OK')).toBeTruthy();
  expect(container.querySelector('img')).toBeNull();
});

it('falls back on later errors and tries again when the source changes', () => {
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(false);
  const { container, rerender } = render(<Avatar name="Omar Khaled" image="/first.png" />);
  fireEvent.error(container.querySelector('img')!);
  expect(screen.getByText('OK')).toBeTruthy();
  rerender(<Avatar name="Omar Khaled" image="/second.png" />);
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/second.png');
  rerender(<Avatar name="Omar Khaled" image="/first.png" />);
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/first.png');
});

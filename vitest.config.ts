import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // Rule tests run in node; the render tests opt into jsdom with a docblock
    // pragma. Both live under src/ so one command covers them.
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});

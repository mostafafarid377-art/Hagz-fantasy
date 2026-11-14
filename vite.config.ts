import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite needs the deployment's URL prefix at build time. Other hosts can leave
// this unset and continue to serve the app from the domain root.
const configuredBase = process.env.VITE_BASE_PATH || '/';
const base = configuredBase === '/' ? '/' : `/${configuredBase.replace(/^\/+|\/+$/g, '')}/`;

export default defineConfig({
  base,
  plugins: [react()],
  server: { host: '0.0.0.0', allowedHosts: true },
});

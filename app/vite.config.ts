import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev only: the app calls its OWN origin (`fetch('/api/…')`), and this proxy hands /api to the
// API server. Do NOT set `changeOrigin`: the OIDC redirect_uri is derived from the forwarded
// Host header, and rewriting it sends the login callback to the API port instead of back here.
export default defineConfig({
  plugins: [react()],
  server: {
    // 5174: 5173 is Vite's default, and is the one every other Vite project on a machine already holds.
    port: Number(process.env.WEB_PORT ?? process.env.PORT ?? 5174),
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.API_PORT ?? 8891}` } },
  },
});

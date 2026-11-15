import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** The studio is served by the API at /studio, on the same origin, so it shares the sign-in. */
const api = process.env['AMBIT_API'] ?? 'http://localhost:3000';

export default defineConfig({
  base: '/studio/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(['/v1', '/auth', '/assets', '/review', '/mcp'].map((path) => [path, { target: api, changeOrigin: false }])),
  },
  build: { outDir: 'dist', sourcemap: false, emptyOutDir: true },
});

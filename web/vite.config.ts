import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite configuration for the Go Dependencies Visualizer SPA.
// `outDir` is `dist/` so the Go backend can pick the bundle up via `embed.FS`.
// The dev proxy forwards `/api/*` requests to the local backend on :8080,
// avoiding CORS in development without baking the API origin into the build.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2020',
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: false,
      },
    },
  },
});

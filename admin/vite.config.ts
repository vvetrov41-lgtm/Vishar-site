import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The private CRM builds on its own. It is deliberately not part of the public
// static site's build or validation: different audience, different host,
// different lifecycle.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: { outDir: 'dist', sourcemap: false },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});

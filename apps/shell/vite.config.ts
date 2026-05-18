import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5170,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});

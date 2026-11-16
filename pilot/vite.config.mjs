import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    fs: {
      allow: [fileURLToPath(new URL('.', import.meta.url)), fileURLToPath(new URL('../node_modules', import.meta.url))],
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local/**', '**/postgres.env', '**/database.json', '**/reconciliation/**', '**/audit/**', '**/*.csv', '**/*manifesto*.json', '**/*revisado*.json'],
    },
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  preview: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  build: { outDir: '../pilot-dist', emptyOutDir: true },
});

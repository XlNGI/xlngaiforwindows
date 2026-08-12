import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const developmentWorkerTokenPath = join(tmpdir(), 'ai-video-worker-43120.token');

function addDevelopmentWorkerToken(proxyRequest: { setHeader(name: string, value: string): void }) {
  proxyRequest.setHeader('origin', 'http://127.0.0.1:1420');
  try {
    const token = readFileSync(developmentWorkerTokenPath, 'utf8').trim();
    if (token) proxyRequest.setHeader('x-ai-video-dev-token', token);
  } catch {
    // The Worker may still be starting; the secured endpoint will reject this request.
  }
}

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
    proxy: {
      '/worker-rpc': {
        target: 'http://127.0.0.1:43120',
        changeOrigin: true,
        rewrite: () => '/rpc',
        configure(proxy) {
          proxy.on('proxyReq', addDevelopmentWorkerToken);
        },
      },
      '/worker-media': {
        target: 'http://127.0.0.1:43120',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/worker-media/, '/media'),
        configure(proxy) {
          proxy.on('proxyReq', addDevelopmentWorkerToken);
        },
      },
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
});

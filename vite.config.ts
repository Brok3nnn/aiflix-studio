import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Read HOST and PORT from .env (if present) so the dev proxy follows the API server.
  const env = loadEnv(mode, process.cwd(), '');
  const api = `http://${env.HOST || '127.0.0.1'}:${env.PORT || '3001'}`;

  return {
    root: 'web',
    build: { outDir: '../dist', emptyOutDir: true },
    server: {
      host: '127.0.0.1',
      proxy: { '/api': api, '/media': api },
    },
  };
});

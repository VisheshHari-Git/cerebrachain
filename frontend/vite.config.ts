import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.TRUST_LAYER_URL || 'http://127.0.0.1:8787';
  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true, proxy: { '/api': { target, changeOrigin: true } } },
    preview: { port: 4173, strictPort: true, proxy: { '/api': { target, changeOrigin: true } } },
    build: { rollupOptions: { output: {
      onlyExplicitManualChunks: true,
      manualChunks(id) {
        if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react';
        if (/node_modules\/(three|@react-three\/fiber)\//.test(id)) return 'three';
      },
    } } },
  };
});

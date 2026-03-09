import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const port = Number(env.VITE_DEV_PORT) || 3000;
  const host = env.VITE_DEV_HOST || '0.0.0.0';
  const hmrEnabled = env.VITE_DISABLE_HMR !== 'true';
  const hmrHost = env.VITE_HMR_HOST || (host === '0.0.0.0' ? 'localhost' : host);
  const hmrClientPort = Number(env.VITE_HMR_CLIENT_PORT) || port;
  const hmrPort = Number(env.VITE_HMR_PORT) || port;
  const hmrProtocol = env.VITE_HMR_PROTOCOL === 'wss' ? 'wss' : 'ws';

  return {
    server: {
      port,
      host,
      strictPort: true,
      hmr: hmrEnabled ? {
        protocol: hmrProtocol,
        host: hmrHost,
        clientPort: hmrClientPort,
        port: hmrPort
      } : false,
      proxy: env.VITE_USE_BACKEND === 'true' ? {
        '/api': {
          target: env.VITE_BACKEND_TARGET || 'http://127.0.0.1:5000',
          changeOrigin: true
        }
      } : undefined,
      watch: {
        ignored: ['**/server/**']
      }
    },
    plugins: [
      react(),
      tailwindcss(),
    ],
    define: {
      'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY || env.API_KEY || ""),
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY || env.API_KEY || ""),
      'process.env.BILL_COMPAT_V8': JSON.stringify(env.BILL_COMPAT_V8 || "false")
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      }
    }
  };
});

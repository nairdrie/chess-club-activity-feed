import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, proxy same-origin API + socket.io to the locally-running backend.
// In production the app is served behind an LB at the same origin, so all
// runtime requests use relative paths and this proxy is never involved.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});

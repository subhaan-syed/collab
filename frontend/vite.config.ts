import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        // Inject the design system partials into every .module.scss automatically
        // so components don't need explicit @use lines for variables and mixins.
        additionalData: `
          @use "${path.resolve(__dirname, 'src/styles/_variables.scss')}" as *;
          @use "${path.resolve(__dirname, 'src/styles/_mixins.scss')}" as *;
        `,
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        // MUST use http:// (not ws://) as the target when ws:true is set.
        // node-http-proxy (used by Vite internally) performs the HTTP→WebSocket
        // upgrade itself; giving it a ws:// target bypasses that upgrade path
        // and produces a malformed handshake that Safari's strict RFC-6455
        // parser rejects.  Chrome is lenient and accepts both forms.
        target: 'http://localhost:8000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});

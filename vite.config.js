import { defineConfig } from 'vite';

export default defineConfig({
  root: '.', // root je u glavnom folderu
  publicDir: 'public', // statički asseti
  build: {
    outDir: 'dist', // output folder
    emptyOutDir: true
  },
  server: {
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true
      }
    }
  }
});
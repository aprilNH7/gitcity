import { defineConfig } from 'vite';

// Repo is served from https://<user>.github.io/gitcity/
export default defineConfig({
  define: {
    'import.meta.env.VITE_BUILD_TIME': JSON.stringify(new Date().toISOString()),
  },
  base: process.env.GITHUB_ACTIONS ? '/gitcity/' : '/',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
  },
});

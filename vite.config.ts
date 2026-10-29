import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import {readFileSync} from 'fs';

// The site's one address (site.config.json) goes into the marketing and app pages.
const siteOrigin: string = JSON.parse(readFileSync(path.resolve(__dirname, 'site.config.json'), 'utf8')).origin;
const siteOriginHtml = {
  name: 'site-origin',
  transformIndexHtml: (html: string) => html.replaceAll('__SITE_ORIGIN__', siteOrigin),
};

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), siteOriginHtml],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    // Two pages: "/" is the public marketing page (index.html) and "/app" is
    // the app (app.html). See ARCHITECTURE.md, Public pages.
    build: {
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'index.html'),
          app: path.resolve(__dirname, 'app.html'),
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});

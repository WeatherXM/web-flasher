import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  integrations: [
    tailwind({
      applyBaseStyles: false,
    }),
  ],
  vite: {
    resolve: {
      alias: {
        'esptool-js': 'esptool-js/bundle.js',
      },
    },
    optimizeDeps: {
      include: ['esptool-js', 'spark-md5'],
    },
  },
});

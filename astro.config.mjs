// @ts-check
import { defineConfig } from 'astro/config';
import optimizeIntegration from './vite-plugin-optimize.mjs';

// https://astro.build/config
export default defineConfig({
    site: 'https://fiend404.github.io',
    base: '/sophie-website',
    integrations: [optimizeIntegration()]
});

import { defineConfig } from 'vite';
import typegpu from 'unplugin-typegpu/vite';

export default defineConfig({
  plugins: [typegpu()],
  // Pre-bundle TypeGPU with its add-ons in one pass so they share a single typegpu instance.
  optimizeDeps: { include: ['typegpu', '@typegpu/sdf', '@typegpu/noise'] },
  resolve: { dedupe: ['typegpu'] },
  build: { target: 'es2022' },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'config-editor',
  plugins: [react()],
  build: {
    outDir: '../Publish/config-editor',
    emptyOutDir: true,
  },
});

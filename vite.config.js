import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

function copyRootDataJsonPlugin() {
  return {
    name: 'copy-root-data-json',
    generateBundle() {
      const dataPath = path.resolve(process.cwd(), 'data.json');
      if (fs.existsSync(dataPath)) {
        this.emitFile({
          type: 'asset',
          fileName: 'data.json',
          source: fs.readFileSync(dataPath),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [copyRootDataJsonPlugin()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: true,
  },
});

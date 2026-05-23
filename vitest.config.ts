import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import coreConfig from '@cyanheads/mcp-ts-core/vitest.config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default mergeConfig(
  coreConfig,
  defineConfig({
    resolve: {
      alias: {
        '@/': new URL('./src/', import.meta.url).pathname,
        // Ensure a single zod instance when mcp-ts-core is a local symlink.
        // Without this, node resolves zod from the symlinked source root,
        // which lacks zod in its own node_modules (peer dep since 0.9.2).
        zod: path.resolve(__dirname, 'node_modules/zod'),
      },
    },
    test: {
      include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    },
  }),
);

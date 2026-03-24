import { defineConfig } from 'tsup';

export default defineConfig([
  // Library entry
  {
    entry: {
      'index': 'src/index.ts',
    },
    format: ['esm'],
    target: 'node18',
    platform: 'node',
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
  },
  // CLI + Channel server (executable entries)
  {
    entry: {
      'cli': 'src/cli.ts',
      'channel/server': 'src/channel/server.ts',
    },
    format: ['esm'],
    target: 'node18',
    platform: 'node',
    dts: false,
    sourcemap: true,
    splitting: false,
    external: ['zod'],
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  // Hub server (needs to be runnable standalone for daemon mode)
  {
    entry: {
      'hub/server': 'src/hub/server.ts',
    },
    format: ['esm'],
    target: 'node18',
    platform: 'node',
    dts: false,
    sourcemap: true,
    splitting: false,
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
]);

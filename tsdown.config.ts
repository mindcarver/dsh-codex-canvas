import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  // Self-contained transpile only: no project references, no type checking —
  // must work from a plain git install (pnpm runs `prepare` post-install).
  dts: false,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'lib',
})

import { defineConfig } from 'tsdown'

/**
 * Browser platform modules the harness shares through the loader module
 * table; everything else the client half reaches must be bundled inline.
 */
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

export default defineConfig([
  {
    // Node half: plain ESM transpile, no type checking (must work from a
    // bare git install where pnpm runs `prepare`). Every @deepseek-ai/*
    // stays external: the profile parent-walk resolves them to the RUNNING
    // dsh installation, and bundling local npm copies would mix runtimes.
    name: 'dsh-codex-canvas',
    entry: ['src/index.ts'],
    dts: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outDir: 'lib',
    clean: true,
    external: [/^@deepseek-ai\//],
  },
  {
    // Browser half: closure-factory bundle registered with
    // window.__ModuleLoader__ and served at /plugins/dsh-codex-canvas/client.js.
    // Mirrors the harness `clientConfig` preset (packages/client/tsdown.client.ts).
    name: 'dsh-codex-canvas/client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    noExternal: id => (CLIENT_EXTERNALS.includes(id as never) ? undefined : true),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-codex-canvas", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])

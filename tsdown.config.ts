/**
 * Standalone build for @martin/dsh-model-dial (same two-pass layout as
 * @martin/dsh-voice): the node half, lib/index.js, and the browser client
 * bundle, lib/client.js, a CJS closure factory registered with the host's
 * module loader. No CSS modules here: the dial styles itself inline.
 */
import { defineConfig } from 'tsdown'

const ID = '@martin/dsh-model-dial'

/** Platform modules the host's module table provides; everything else inlines. */
const EXTERNALS = new Set(['react', 'react/jsx-runtime', '@deepseek-ai/cordis'])

const nodeConfig = {
  name: `${ID}/lib`,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
}

const clientConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: (specifier: string) => EXTERNALS.has(specifier),
    alwaysBundle: (specifier: string) => !EXTERNALS.has(specifier),
  },
  inputOptions: {
    resolve: {
      conditionNames: ['production', 'browser', 'import', 'module', 'default'],
    },
  },
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapExcludeSources: false,
    banner: (chunk: { isEntry: boolean; fileName: string }) =>
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([nodeConfig, clientConfig])

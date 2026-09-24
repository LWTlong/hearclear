import * as esbuild from 'esbuild'
import { copyFileSync, cpSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const dist = resolve(root, 'dist')
const watch = process.argv.includes('--watch')

mkdirSync(dist, { recursive: true })

const shared = {
  bundle: true,
  sourcemap: true,
  target: 'chrome116',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
}

const entries = [
  {
    entryPoints: [resolve(root, 'src/background/service-worker.ts')],
    outfile: resolve(dist, 'background/service-worker.js'),
    format: 'esm',
  },
  {
    entryPoints: [resolve(root, 'src/content/content.ts')],
    outfile: resolve(dist, 'content/content.js'),
    format: 'iife',
  },
  {
    entryPoints: [resolve(root, 'src/popup/popup.ts')],
    outfile: resolve(dist, 'popup/popup.js'),
    format: 'iife',
  },
  {
    entryPoints: [resolve(root, 'src/offscreen/offscreen.ts')],
    outfile: resolve(dist, 'offscreen/offscreen.js'),
    format: 'esm',
  },
  {
    entryPoints: [resolve(root, 'src/options/options.ts')],
    outfile: resolve(dist, 'options/options.js'),
    format: 'iife',
  },
]

function copyStatic() {
  copyFileSync(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'))

  cpSync(resolve(root, 'src/popup/popup.html'), resolve(dist, 'popup/popup.html'))
  cpSync(resolve(root, 'src/offscreen/offscreen.html'), resolve(dist, 'offscreen/offscreen.html'))
  cpSync(resolve(root, 'src/options/options.html'), resolve(dist, 'options/options.html'))

  const iconsDir = resolve(root, 'public/icons')
  const distIcons = resolve(dist, 'icons')
  mkdirSync(distIcons, { recursive: true })
  if (existsSync(iconsDir)) {
    for (const f of readdirSync(iconsDir)) {
      if (f.endsWith('.png') || f.endsWith('.svg')) {
        copyFileSync(resolve(iconsDir, f), resolve(distIcons, f))
      }
    }
  }

  // Copy ONNX WASM files — check transformers dist first, then onnxruntime-web
  const wasmDist = resolve(dist, 'wasm')
  mkdirSync(wasmDist, { recursive: true })
  const candidates = [
    resolve(root, 'node_modules/@huggingface/transformers/dist'),
    resolve(root, 'node_modules/onnxruntime-web/dist'),
  ]
  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.wasm') || f.endsWith('.jsep.mjs')) {
        copyFileSync(resolve(dir, f), resolve(wasmDist, f))
      }
    }
    break
  }
}

async function build() {
  copyStatic()

  if (watch) {
    const contexts = await Promise.all(
      entries.map(e => esbuild.context({ ...shared, ...e }))
    )
    await Promise.all(contexts.map(c => c.watch()))
    console.log('Watching for changes...')
  } else {
    await Promise.all(
      entries.map(e => esbuild.build({ ...shared, ...e }))
    )
    console.log('Build complete → dist/')
  }
}

build().catch(err => {
  console.error(err)
  process.exit(1)
})

import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'

// Run with: node scripts/content-check.mjs
const { outputFiles } = await build({
  entryPoints: ['src/content/content.ts'], bundle: true, write: false, format: 'iife',
})
function harness() {
  const state = { sends: 0, removed: false, timerCleared: false, fail: false, logs: [] }
  const events = new Map()
  const windowEvents = new Map()
  const original = { textContent: '', style: {} }
  const translated = { textContent: '', style: {} }
  const layer = { style: {} }
  const shadow = {
    getElementById: id => id === 'original' ? original : translated,
    querySelector: () => layer,
  }
  const root = { appendChild(node) { node.parentElement = root; node.isConnected = true } }
  const host = {
    style: {}, isConnected: false, parentElement: null,
    attachShadow: () => shadow,
    remove() { state.removed = true; this.isConnected = false },
  }
  const video = {
    paused: false, isConnected: true, textTracks: { length: 0, addEventListener() {} },
    parentElement: {},
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 640, height: 360 }),
    addEventListener(name, callback, { signal }) {
      events.set(name, callback)
      signal.addEventListener('abort', () => events.delete(name), { once: true })
    },
  }
  const runtime = {
    id: 'extension',
    sendMessage() {
      state.sends++
      if (state.fail) throw new Error('Extension context invalidated.')
      return Promise.resolve()
    },
    onMessage: { addListener(fn) { state.message = fn } },
  }
  const window = {
    addEventListener(name, callback, { signal }) {
      windowEvents.set(name, callback)
      signal.addEventListener('abort', () => windowEvents.delete(name), { once: true })
    },
  }
  vm.runInNewContext(outputFiles[0].text, {
    chrome: { runtime, storage: { local: { get(_key, cb) { cb({}) } }, onChanged: { addListener() {} } } },
    window,
    document: {
      readyState: 'complete', fullscreenElement: null, documentElement: root,
      querySelectorAll: () => [video], createElement: () => host, addEventListener() {},
    },
    getComputedStyle: () => ({ position: 'relative' }), AbortController,
    setInterval(fn) { state.interval = fn; return 1 },
    clearInterval() { state.timerCleared = true },
    setTimeout() { return 2 }, clearTimeout() {},
    console: { log() {}, info(...args) { state.logs.push(args.join(' ')) }, warn() {} },
  })
  state.events = events
  state.windowEvents = windowEvents
  state.runtime = runtime
  state.original = original
  state.translated = translated
  state.layer = layer
  state.host = host
  return state
}

for (const failure of ['missing-id', 'sync-throw']) {
  const test = harness()
  if (failure === 'missing-id') test.runtime.id = undefined
  else test.fail = true
  assert.doesNotThrow(() => test.events.get('pause')())
  assert.equal(test.events.size, 0, 'invalidation removes media listeners')
  assert.equal(test.windowEvents.size, 0, 'invalidation removes geometry listeners')
  assert.equal(test.timerCleared, true)
  assert.equal(test.removed, true)
}
const generation = harness()
generation.message({ type: 'subtitle:clear', data: { generation: 3 } })
generation.message({ type: 'session:state', data: { generation: 0, state: 'detecting' } })
let response
generation.message(
  { type: 'subtitle:show', data: { generation: 0, cue: { original: 'new session', startTime: 0, endTime: 5 } } },
  {}, value => { response = value },
)
assert.equal(generation.original.textContent, 'new session', 'restart must reset subtitle generation after seeking')
assert.equal(response?.rendered, true)
assert.equal(generation.host.isConnected, true)
assert.equal(generation.host.parentElement, generation.host.parentElement)
assert.equal(generation.host.style.left, '10px')
assert.equal(generation.host.style.top, '20px')
assert.equal(generation.host.style.width, '640px')
assert.equal(generation.host.style.height, '360px')
assert.ok(generation.logs.some(line => line.includes('"event":"subtitle-render"') && line.includes('"rendered":true')))

generation.message({ type: 'subtitle:displayMode', data: { mode: 'translation' } }, {}, () => {})
generation.message(
  { type: 'subtitle:show', data: { generation: 0, cue: { id: 'pending', original: 'fallback original', startTime: 0, endTime: 5 } } },
  {}, () => {},
)
assert.equal(generation.original.textContent, 'fallback original')
assert.equal(generation.original.style.display, '', 'translation-only shows original until translation arrives')
assert.equal(generation.translated.style.display, 'none')
generation.message({ type: 'subtitle:translated', data: { id: 'pending', translation: '译文' } })
assert.equal(generation.original.style.display, 'none')
assert.equal(generation.translated.textContent, '译文')
assert.equal(generation.translated.style.display, '')
let mode
generation.message({ type: 'subtitle:displayModeQuery' }, {}, value => { mode = value.mode })
assert.equal(mode, 'translation')
console.log('Content checks passed: invalidation cleanup, document overlay, generation reset, render ack, translation fallback')

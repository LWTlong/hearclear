import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'

// Run with: node scripts/popup-check.mjs
const { outputFiles } = await build({ entryPoints: ['src/popup/popup.ts'], bundle: true, write: false, format: 'iife' })
const elements = new Map()
function element(id = '') {
  return elements.get(id) ?? elements.set(id, {
    id, textContent: '', className: '', value: '', style: {}, checked: false,
    children: [], classList: { add() {}, remove() {} },
    addEventListener(name, fn) { this[`on${name}`] = fn },
    appendChild(child) { this.children.push(child) },
    replaceChildren(...children) { this.children = children },
    set scrollTop(value) { this._scrollTop = value }, get scrollHeight() { return this.children.length },
  }).get(id)
}
for (const id of ['btn-start', 'status', 'status-detail', 'work-mode', 'src-lang', 'tgt-lang', 'settings-link',
  'btn-sidepanel', 'model-dot', 'model-text', 'model-progress-wrap', 'model-progress-fill', 'model-pct',
  'caption-panel', 'caption-empty']) element(id)
const radios = ['bilingual', 'translation', 'original'].map(value => ({ ...element(`display-${value}`), value }))
let runtimeListener
const chrome = {
  runtime: {
    id: 'extension', lastError: null,
    sendMessage(message, callback) {
      if (message.type === 'session:query') callback({ session: null, captions: [] })
      return Promise.resolve({ ok: true })
    },
    onMessage: { addListener(fn) { runtimeListener = fn } },
    openOptionsPage() {},
  },
  storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
  tabs: {
    query(_query, callback) { callback([{ id: 1 }]) },
    sendMessage(_id, message, callback) {
      if (message.type === 'subtitle:displayModeQuery') callback?.({ mode: 'bilingual' })
      return Promise.resolve()
    },
  },
  sidePanel: { open: async () => {} },
}
vm.runInNewContext(outputFiles[0].text, {
  chrome, caches: { open: async () => ({ keys: async () => [] }) }, window: { innerWidth: 480, close() {} },
  document: {
    getElementById: id => element(id),
    querySelectorAll: selector => selector === 'input[name="display"]' ? radios : [],
    querySelector: selector => radios.find(radio => selector.includes(`value="${radio.value}"`)) ?? null,
    createElement: () => element(`created-${Math.random()}`),
  },
  setTimeout() {}, console: { error() {} }, URL,
})
assert.equal(element('caption-empty').textContent, '识别结果将在这里显示')
runtimeListener({ type: 'session:state', data: { state: 'asr_mode' } })
assert.equal(element('caption-empty').textContent, '等待识别结果...')
runtimeListener({ type: 'caption:update', data: { cue: { id: '1', original: 'hello', startTime: 0, endTime: 5 } } })
assert.equal(element('caption-panel').children.length, 1)
assert.equal(element('caption-panel').children[0].children[0].textContent, 'hello')
runtimeListener({ type: 'caption:update', data: { cue: { id: '1', original: 'hello', translation: '你好', startTime: 0, endTime: 5 } } })
assert.equal(element('caption-panel').children.length, 1, 'translation updates the existing cue')
assert.equal(element('caption-panel').children[0].children[1].textContent, '你好')
runtimeListener({ type: 'caption:clear' })
assert.equal(element('caption-panel').children[0], element('caption-empty'))
console.log('Popup checks passed: waiting state, cue append/update, translation, clear')

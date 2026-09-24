import assert from 'node:assert/strict'
import vm from 'node:vm'
import { build } from 'esbuild'
import { env } from '../node_modules/@huggingface/transformers/src/env.js'
import { getModelFile } from '../node_modules/@huggingface/transformers/src/utils/hub.js'
import { TextStreamer } from '../node_modules/@huggingface/transformers/src/generation/streamers.js'

// Run with: node scripts/asr-check.mjs
const bundle = async (entry, plugins = []) => (await build({
  entryPoints: [entry], bundle: true, write: false, format: 'iife',
  globalName: 'moduleExports', platform: 'browser', plugins,
})).outputFiles[0].text

const backgroundCode = await bundle('src/background/service-worker.ts')
const offscreenCode = await bundle('src/offscreen/offscreen.ts', [{
  name: 'mock-transformers',
  setup(build) {
    build.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({ path: 'transformers', namespace: 'mock' }))
    build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents:
      `export const env = { backends: { onnx: { wasm: {}, webgpu: {} } } };
      export const pipeline = (...args) => globalThis.mockPipeline(...args);
      export const full = (...args) => ({ dims: args[0], fill: args[1] });
      export class TextStreamer { constructor(_tokenizer, options) { this.options = options; } }`,
    }))
  },
}])
const helper = vm.runInNewContext(await bundle('src/shared/asr.ts') + '\nmoduleExports', { URL })
const modelId = 'onnx-community/whisper-small'
const files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'preprocessor_config.json',
  'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']
const urls = files.map(file => `https://huggingface.co/${modelId}/resolve/main/${file}`)
assert.equal(helper.hasModelFiles([], modelId, 'q8'), false)
assert.equal(helper.hasModelFiles(urls.slice(0, 1), modelId, 'q8'), false)
assert.equal(helper.hasModelFiles(urls, modelId, 'q8'), true)
assert.equal(helper.hasModelFiles(urls, 'onnx-community/whisper-medium', 'q8'), false)
const mixedUrls = urls.map(url => url
  .replace('encoder_model_quantized.onnx', 'encoder_model.onnx')
  .replace('decoder_model_merged_quantized.onnx', 'decoder_model_merged_q4.onnx'))
assert.equal(helper.hasModelFiles(urls, modelId, 'webgpu-mixed'), false)
assert.equal(helper.hasModelFiles(mixedUrls, modelId, 'webgpu-mixed'), true)
assert.equal(helper.hasModelFiles(mixedUrls, modelId, 'q8'), false)
assert.equal(helper.getCachedProfile(urls, modelId, 'webgpu'), 'q8', 'legacy WebGPU Q8 cache remains usable')
assert.equal(helper.getCachedProfile(mixedUrls, modelId, 'webgpu'), 'webgpu-mixed')
assert.equal(helper.getCachedProfile(urls, modelId, 'wasm'), 'q8')
assert.equal(helper.getPreferredProfile('webgpu'), 'webgpu-mixed')
assert.equal(JSON.stringify(helper.getProfileDtype('webgpu-mixed')), JSON.stringify({ encoder_model: 'fp32', decoder_model_merged: 'q4' }))
assert.equal(helper.getProfileDtype('q8'), 'q8')

let streamedTokens = 0
const streamer = new TextStreamer({ decode: () => '' }, {
  skip_prompt: true, callback_function: () => {},
  token_callback_function: tokens => { streamedTokens += tokens.length },
})
streamer.put([[1n, 2n]])
assert.equal(streamedTokens, 0, 'prompt must not count as generated tokens')
streamer.put([[3n]])
streamer.end()
assert.equal(streamedTokens, 1)

// Exercise the real Transformers.js loader without network or large model files.
const originalFetch = globalThis.fetch
const savedEnv = { ...env }
let remoteRequests = 0
let cacheHit = true
try {
  env.allowLocalModels = true
  env.allowRemoteModels = true
  env.useFS = false
  env.useFSCache = false
  env.useBrowserCache = false
  env.useCustomCache = true
  env.localModelPath = 'https://extension.invalid/models/'
  env.customCache = {
    match: async key => cacheHit && key === urls[0] ? new Response('{}') : undefined,
    put: async () => {},
  }
  globalThis.fetch = async url => {
    if (String(url).startsWith(env.localModelPath)) return new Response('', { status: 404 })
    remoteRequests++
    return new Response('{}')
  }
  await getModelFile(modelId, 'config.json', true, { local_files_only: true })
  assert.equal(remoteRequests, 0, 'cache hit must not fetch remote files')
  cacheHit = false
  await assert.rejects(getModelFile(modelId, 'config.json', true, { local_files_only: true }), /was not found locally/)
  assert.equal(remoteRequests, 0, 'missing cache must fail without remote download')
  await getModelFile(modelId, 'config.json', true, { local_files_only: false })
  assert.equal(remoteRequests, 1, 'explicit download may fetch remote files')
} finally {
  globalThis.fetch = originalFetch
  Object.assign(env, savedEnv)
}

const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await tick()
  }
  assert.fail('Timed out waiting for mocked lifecycle')
}
function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

function harness() {
  const state = {
    events: [], loads: [], captureCount: 0, inferenceCount: 0, stoppedTracks: 0,
    loadError: false, cacheMissing: false, captureError: false, inferenceError: false, pageError: false, gate: null,
    inferenceGate: null, clock: Date.now(), backgroundTimers: new Set(), audioTimers: new Set(), shaderF16: true,
    warmups: [], inferenceOptions: [], model: { modelId: 'onnx-community/whisper-base', device: 'wasm', language: 'en' },
    cacheProfile: 'q8', cacheProfiles: null, failWebgpuOnly: false, processor: null,
  }
  class TestDate extends Date {
    static now() { return state.clock }
  }
  const timers = set => ({
    setInterval(fn) { set.add(fn); return fn },
    clearInterval(fn) { set.delete(fn) },
  })
  let backgroundListener
  let offscreenListener
  let offscreenExists = false
  const listeners = new Set()
  state.logs = []
  const quietConsole = { log() {}, info(...args) { state.logs.push(args.join(' ')) }, warn() {}, error() {} }
  function dispatch(msg, sender = null) {
    state.events.push(msg)
    return new Promise((resolve, reject) => {
      let waiting = false
      let replied = false
      const reply = result => { replied = true; resolve(result) }
      try {
        for (const listener of [...listeners]) {
          if (listener !== sender && listener(msg, sender === offscreenListener ? { url: 'chrome-extension://test/offscreen/offscreen.html' } : {}, reply) === true) waiting = true
        }
        if (!waiting && !replied) resolve(undefined)
      } catch (error) { reject(error) }
    })
  }
  const runtime = listener => ({
    getURL: path => `chrome-extension://test/${path}`,
    sendMessage: msg => dispatch(msg, listener()),
    onMessage: { addListener(fn) { listeners.add(fn); return fn } },
  })
  const backgroundRuntime = runtime(() => backgroundListener)
  backgroundRuntime.onMessage.addListener = fn => { backgroundListener = fn; listeners.add(fn) }
  const cacheUrls = profile => {
    const model = state.model.modelId === 'onnx-community/whisper-medium'
      ? 'onnx-community/whisper-medium-ONNX'
      : state.model.modelId
    const profiles = state.cacheProfiles ?? [profile]
    return profiles.flatMap(selected => {
      const selectedFiles = selected === 'webgpu-mixed'
        ? ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'preprocessor_config.json', 'onnx/encoder_model.onnx', 'onnx/decoder_model_merged_q4.onnx']
        : selected === 'q8'
          ? ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'preprocessor_config.json', 'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']
          : []
      return selectedFiles.map(file => `https://huggingface.co/${model}/resolve/main/${file}`)
    })
  }
  const chrome = {
    runtime: backgroundRuntime,
    caches: { open: async () => ({ keys: async () => cacheUrls(state.cacheProfile).map(url => ({ url })) }) },
    storage: { local: { get: async () => ({ asrConfig: state.model }) }, onChanged: { addListener() {} } },
    tabs: {
      query(_query, callback) { callback([{ id: 7 }]) },
      sendMessage: async (_id, msg) => {
        if (state.pageError) throw new Error('Could not establish connection')
        return msg.type === 'media:detect' ? { hasVideo: true, hasTextTrack: false } : undefined
      },
      onRemoved: { addListener() {} },
    },
    tabCapture: { getMediaStreamId(_options, callback) { state.captureCount++; callback('stream') } },
    offscreen: {
      Reason: { USER_MEDIA: 'USER_MEDIA', AUDIO_PLAYBACK: 'AUDIO_PLAYBACK' },
      hasDocument: async () => offscreenExists,
      async createDocument() {
        offscreenExists = true
        const offscreenRuntime = runtime(() => offscreenListener)
        offscreenRuntime.onMessage.addListener = fn => { offscreenListener = fn; listeners.add(fn) }
        const track = { stop() { state.stoppedTracks++ }, getSettings: () => ({ sampleRate: 48000, channelCount: 2 }), readyState: 'live', enabled: true, muted: false }
        const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
        class AudioContext {
          state = 'suspended'
          sampleRate = 16000
          destination = {}
          createMediaStreamSource() { return { connect() {}, disconnect() {} } }
          createScriptProcessor() {
            state.processor = { connect() {}, disconnect() {}, onaudioprocess: null }
            return state.processor
          }
          async resume() { this.state = 'running' }
          async close() { this.state = 'closed' }
        }
        vm.runInNewContext(offscreenCode, {
          chrome: { runtime: offscreenRuntime }, console: quietConsole, Float32Array, AudioContext,
          Date: TestDate, ...timers(state.audioTimers),
          navigator: { gpu: { requestAdapter: async () => ({ features: new Set(state.shaderF16 ? ['shader-f16'] : []) }) }, mediaDevices: { async getUserMedia() {
            if (state.captureError) throw new Error('capture denied')
            return stream
          } } },
          async mockPipeline(_task, id, options) {
            state.loads.push({ id, device: options.device, dtype: options.dtype, localFilesOnly: options.local_files_only })
            if (state.gate) await state.gate.promise
            if (state.loadError || (state.failWebgpuOnly && options.device === 'webgpu')) throw new Error('model unavailable')
            if (state.cacheMissing && options.local_files_only) {
              throw new Error('`local_files_only=true` and file was not found locally')
            }
            options.progress_callback({ status: 'progress', file: 'config.json', loaded: 100, total: 100 })
            const transcriber = async (_audio, inferenceOptions) => {
              state.inferenceCount++
              state.inferenceOptions.push(inferenceOptions)
              if (state.inferenceGate) await state.inferenceGate.promise
              if (state.inferenceError) throw new Error('inference failed')
              inferenceOptions.streamer.options.token_callback_function([42n])
              return { text: 'hello' }
            }
            transcriber.dispose = async () => {}
            transcriber.model = { config: {}, generation_config: {}, generate: async options => { state.warmups.push(options); return {} } }
            transcriber.processor = { feature_extractor: { config: { sampling_rate: 16000, n_samples: 480000, chunk_length: 30 } } }
            transcriber.tokenizer = {}
            return transcriber
          },
        })
      },
      async closeDocument() {
        listeners.delete(offscreenListener)
        offscreenListener = undefined
        offscreenExists = false
        state.audioTimers.clear()
      },
    },
  }
  vm.runInNewContext(backgroundCode, { chrome, caches: chrome.caches, console: quietConsole, setTimeout, clearTimeout, Date: TestDate, URL, ...timers(state.backgroundTimers) })
  state.start = () => dispatch({ type: 'session:start', data: { workMode: 'asr_only', sourceLang: 'en', targetLang: '简体中文' } })
  state.stop = () => dispatch({ type: 'session:stop' })
  state.download = () => dispatch({ type: 'model:download', data: state.model })
  state.latest = () => state.events.filter(e => e.type === 'session:state').at(-1)?.data
  state.waitState = value => until(() => state.latest()?.state === value)
  state.audio = (length = 80000, sample = 0.1) => state.processor.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(length).fill(sample) } })
  state.advance = ms => {
    state.clock += ms
    for (const fn of [...state.audioTimers, ...state.backgroundTimers]) fn()
  }
  return state
}

const normal = harness()
await normal.start()
await normal.waitState('asr_mode')
assert.equal(normal.loads[0].id, normal.model.modelId)
assert.equal(normal.loads[0].device, 'wasm')
assert.equal(normal.loads[0].dtype, 'q8')
assert.ok(normal.events.findIndex(e => e.type === 'model:ready') < normal.events.findIndex(e => e.type === 'audio:start'))
normal.audio()
await until(() => normal.events.some(e => e.type === 'asr:result'))
assert.equal(normal.inferenceCount, 1)
const diagnostics = normal.events.filter(e => e.type === 'asr:diagnostic').map(e => e.data)
for (const event of ['model-request', 'runtime', 'audio-start', 'inference-start', 'first-token', 'inference-end']) {
  assert.ok(diagnostics.some(entry => entry.event === event), `missing diagnostic: ${event}`)
}
assert.equal(diagnostics.find(entry => entry.event === 'model-request').modelId, normal.model.modelId)
assert.equal(diagnostics.find(entry => entry.event === 'audio-start').sampleRate, 16000)
assert.ok(diagnostics.find(entry => entry.event === 'inference-start').rms > 0)
assert.equal(diagnostics.find(entry => entry.event === 'inference-end').textLength, 5)
assert.equal(normal.inferenceOptions[0].max_new_tokens, 64)
assert.ok(normal.logs.some(line => line.includes('saved-config')))
assert.ok(!normal.logs.some(line => line.includes('hello')), 'diagnostics must not include recognized speech')
await normal.stop()
await normal.start()
await normal.waitState('asr_mode')
assert.equal(normal.loads.length, 2, 'recreated document must reload cached model')
assert.ok(normal.loads.every(load => load.localFilesOnly === true), 'start and restart must be cache-only')
assert.ok(normal.events.filter(e => e.type === 'model:progress').every(e => !e.data.status.includes('下载')))
assert.ok(normal.events.some(e => e.type === 'model:progress' && e.data.status.includes('从缓存加载中')))
normal.audio()
await until(() => normal.inferenceCount === 2)
await normal.stop()

for (const failure of ['loadError', 'captureError']) {
  const test = harness()
  test[failure] = true
  await test.start()
  await test.waitState('error')
  assert.match(test.latest().detail, failure === 'loadError' ? /model unavailable/ : /capture denied/)
  assert.equal(test.events.some(e => e.type === 'session:state' && e.data.state === 'asr_mode'), false)
  if (failure === 'loadError') assert.equal(test.captureCount, 0)
  test[failure] = false
  await test.start()
  await test.waitState('asr_mode')
  await test.stop()
}

const cancelled = harness()
cancelled.gate = deferred()
await cancelled.start()
await until(() => cancelled.loads.length === 1)
await cancelled.stop()
cancelled.gate.resolve()
await tick()
await tick()
assert.equal(cancelled.captureCount, 0, 'cancelled model load must not start capture')
assert.equal(cancelled.latest().state, 'stopped')

const inference = harness()
inference.inferenceError = true
await inference.start()
await inference.waitState('asr_mode')
inference.audio()
await inference.waitState('error')
assert.match(inference.latest().detail, /inference failed/)
await until(() => inference.stoppedTracks === 1)
await inference.stop()
const missing = harness()
missing.cacheMissing = true
await missing.start()
await missing.waitState('error')
assert.equal(missing.loads.length, 1, 'missing cache must not trigger a network retry')
assert.equal(missing.loads[0].localFilesOnly, true)
assert.equal(missing.captureCount, 0)
assert.match(missing.latest().detail, /模型缓存不完整.*设置/)
await missing.stop()

const download = harness()
await download.download()
await until(() => download.events.some(e => e.type === 'model:ready'))
await tick()
await download.download()
await until(() => download.loads.length === 2)
await tick()
assert.equal(download.loads.length, 2, 'explicit download must refill cache even for a previously loaded model')
assert.ok(download.loads.every(load => load.localFilesOnly === false), 'explicit download may fetch missing files')

const recovery = harness()
recovery.loadError = true
await recovery.start()
await recovery.waitState('error')
recovery.loadError = false
await recovery.download()
await until(() => recovery.events.some(e => e.type === 'model:ready'))
assert.equal(recovery.loads.length, 2, 'error session must not block a replacement download')
assert.equal(helper.normalizeModelId('onnx-community/whisper-medium'), 'onnx-community/whisper-medium-ONNX')
assert.equal(helper.normalizeModelId(modelId), modelId)
const legacy = harness()
legacy.model.modelId = 'onnx-community/whisper-medium'
await legacy.start()
await legacy.waitState('asr_mode')
assert.equal(legacy.loads[0].id, 'onnx-community/whisper-medium-ONNX')
await legacy.stop()

const disconnected = harness()
disconnected.pageError = true
await disconnected.start()
await disconnected.waitState('error')
assert.match(disconnected.latest().detail, /刷新视频页/)
assert.equal(disconnected.captureCount, 0)
assert.equal(disconnected.loads.length, 0)
await disconnected.stop()

const noAudio = harness()
await noAudio.start()
await noAudio.waitState('asr_mode')
noAudio.advance(16000)
await noAudio.waitState('error')
assert.match(noAudio.latest().detail, /未收到音频数据/)
await noAudio.stop()

const silence = harness()
await silence.start()
await silence.waitState('asr_mode')
silence.audio(4096, 0)
silence.advance(1000)
assert.match(silence.latest().detail, /收到静音/)
await silence.stop()

const slow = harness()
slow.inferenceGate = deferred()
await slow.start()
await slow.waitState('asr_mode')
slow.audio()
for (let i = 0; i < 20; i++) slow.audio()
slow.advance(1000)
assert.match(slow.latest().detail, /正在推理.*丢弃积压音频/)
slow.inferenceGate.resolve()
await until(() => slow.inferenceCount === 3)
await tick()
assert.equal(slow.inferenceCount, 3, 'only two pending chunks may survive a slow inference')
await slow.stop()

const stuck = harness()
stuck.inferenceGate = deferred()
await stuck.start()
await stuck.waitState('asr_mode')
stuck.audio()
stuck.advance(91000)
await stuck.waitState('error')
assert.match(stuck.latest().detail, /推理超过 90 秒/)
assert.equal(stuck.inferenceCount, 1, 'timeout must not launch overlapping inference')
await stuck.stop()
const legacyGpu = harness()
legacyGpu.model.device = 'webgpu'
await legacyGpu.start()
await legacyGpu.waitState('asr_mode')
assert.equal(legacyGpu.loads[0].dtype, 'q8', 'legacy WebGPU Q8 cache must continue to start')
assert.equal(legacyGpu.loads[0].device, 'wasm', 'legacy Q8 cache must not run on WebGPU in Transformers.js 3.8.1')
assert.ok(legacyGpu.events.some(e => e.type === 'model:ready' && e.data.profile === 'q8' && e.data.device === 'wasm'))
legacyGpu.audio()
await until(() => legacyGpu.events.some(e => e.type === 'asr:diagnostic' && e.data.event === 'first-token'))
await legacyGpu.stop()

const gpu = harness()
gpu.model.device = 'webgpu'
gpu.cacheProfile = 'webgpu-mixed'
await gpu.start()
await gpu.waitState('asr_mode')
assert.equal(JSON.stringify(gpu.loads[0].dtype), JSON.stringify({ encoder_model: 'fp32', decoder_model_merged: 'q4' }))
assert.equal(gpu.warmups.length, 1)
assert.equal(gpu.warmups[0].max_new_tokens, 1)
assert.ok(gpu.events.some(e => e.type === 'model:ready' && e.data.profile === 'webgpu-mixed' && e.data.device === 'webgpu'))
await gpu.stop()

const fallback = harness()
fallback.model.device = 'webgpu'
fallback.cacheProfiles = ['webgpu-mixed', 'q8']
fallback.failWebgpuOnly = true
await fallback.start()
await fallback.waitState('asr_mode')
assert.deepEqual(fallback.loads.map(load => load.device), ['webgpu', 'wasm'])
assert.equal(fallback.loads[1].dtype, 'q8')
assert.ok(fallback.events.some(e => e.type === 'model:ready' && e.data.profile === 'q8' && e.data.device === 'wasm'))
await fallback.stop()
console.log('ASR checks passed: legacy Q8 compatibility, official WebGPU profile and fallback, generation progress, cache-only startup, lifecycle, audio status and timeout')

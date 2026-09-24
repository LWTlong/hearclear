import { pipeline, env, full, TextStreamer, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import { getProfileDtype, getProfileLabel, type AsrDtype, type AsrProfile } from '../shared/asr'

// WASM files are packaged with the extension
env.backends.onnx.wasm!.wasmPaths = chrome.runtime.getURL('wasm/')
// Models are cached in browser Cache Storage by transformers.js
env.allowRemoteModels = true
// KEEP: transformers.js requires this for local_files_only, including browser cache reads.
env.allowLocalModels = true

let audioContext: AudioContext | null = null
let mediaStream: MediaStream | null = null
let transcriber: AutomaticSpeechRecognitionPipeline | null = null
let loadedModelKey: string | null = null
let loadedProfile: AsrProfile | null = null
let loadedDtype: AsrDtype | null = null
let generatedTokens = 0
let firstTokenMs: number | null = null
let modelLoading: Promise<void> | null = null
let currentSessionId: string | null = null
let currentLanguage = 'en'

const SAMPLE_RATE = 16000
const CHUNK_SECONDS = 5
const CHUNK_SIZE = SAMPLE_RATE * CHUNK_SECONDS

let audioBuffer: Float32Array = new Float32Array(0)
let processing = false
let processor: ScriptProcessorNode | null = null
let captureSource: MediaStreamAudioSourceNode | null = null
let statusTimer: ReturnType<typeof setInterval> | null = null
let lastAudioAt = 0
let lastPeak = 0
let inferenceStartedAt = 0
let droppedAudio = false
let chunkNumber = 0
let lastDiagnosticAt = 0

function logDiagnostic(event: string, data: Record<string, unknown>) {
  const entry = { event, time: new Date().toISOString(), sessionId: currentSessionId, ...data }
  console.info('[HearClear diagnostic]', JSON.stringify(entry))
  sendMsg({ type: 'asr:diagnostic', data: entry })
}

async function logRuntime(modelId: string, device: string, loadMs: number) {
  try {
    const onnx = env.backends.onnx as any
    // Inspect the adapter retained by ORT, not a separate navigator.gpu probe.
    const adapter = device === 'webgpu' ? onnx.webgpu?.adapter : null
    const info = adapter?.info ?? await adapter?.requestAdapterInfo?.()
    const model = transcriber?.model as any
    const extractor = transcriber?.processor?.feature_extractor as any
    logDiagnostic('runtime', {
      modelId, device, profile: loadedProfile, profileLabel: loadedProfile && getProfileLabel(loadedProfile), dtype: loadedDtype, loadMs, transformersVersion: env.version,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGB: (navigator as any).deviceMemory,
      crossOriginIsolated: globalThis.crossOriginIsolated,
      wasmThreads: onnx.wasm?.numThreads, wasmProxy: onnx.wasm?.proxy,
      adapterAvailable: !!adapter,
      adapter: info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : null,
      shaderF16: adapter?.features?.has('shader-f16'),
      maxBufferSize: adapter?.limits?.maxBufferSize,
      maxStorageBufferBindingSize: adapter?.limits?.maxStorageBufferBindingSize,
      powerPreference: onnx.webgpu?.powerPreference,
      modelType: model?.config?.model_type,
      maxLength: model?.generation_config?.max_length ?? model?.config?.max_length,
      maxNewTokens: model?.generation_config?.max_new_tokens,
      featureSampleRate: extractor?.config?.sampling_rate,
      featureWindowSamples: extractor?.config?.n_samples,
      featureWindowSeconds: extractor?.config?.chunk_length,
    })
  } catch (err: any) {
    logDiagnostic('runtime-inspection-failed', { message: err.message })
  }
}

function reportAudioStatus() {
  if (!currentSessionId) return
  const phase = processing ? 'processing' : 'capturing'
  const detail = processing
    ? `正在推理（${Math.floor((Date.now() - inferenceStartedAt) / 1000)} 秒）${droppedAudio ? '，处理较慢，已丢弃积压音频' : ''}`
    : !lastAudioAt || Date.now() - lastAudioAt > 3000
      ? '等待音频数据（尚未收到采集回调）'
      : lastPeak < 0.0001
        ? '收到静音，请确认视频正在有声播放'
        : `已收到声音，正在收集片段（${(audioBuffer.length / SAMPLE_RATE).toFixed(1)}/${CHUNK_SECONDS} 秒）`
  sendMsg({ type: 'asr:status', data: { sessionId: currentSessionId, phase, detail, hasAudio: lastAudioAt > 0 && Date.now() - lastAudioAt < 3000 } })
  if (Date.now() - lastDiagnosticAt >= 5000) {
    lastDiagnosticAt = Date.now()
    logDiagnostic('audio-progress', {
      phase, chunkNumber, contextState: audioContext?.state,
      audioCallbackAgeMs: lastAudioAt ? Date.now() - lastAudioAt : null,
      peak: lastPeak, bufferedSeconds: audioBuffer.length / SAMPLE_RATE,
      inferenceMs: processing ? Date.now() - inferenceStartedAt : null, droppedAudio, generatedTokens, firstTokenMs,
    })
  }
}

// ── Model loading ──

async function loadModel(modelId: string, device: 'webgpu' | 'wasm', profile: AsrProfile, allowDownload = false) {
  const validProfile = device === 'webgpu' ? profile === 'webgpu-mixed' : profile === 'q8'
  if (!modelId || (device !== 'webgpu' && device !== 'wasm') || !validProfile) {
    throw new Error('无效的模型、设备或格式配置')
  }
  if (modelLoading) await modelLoading
  const dtype = getProfileDtype(profile)
  const profileLabel = getProfileLabel(profile)
  const key = `${modelId}:${device}:${profile}`
  logDiagnostic('model-request', { modelId, device, profile, profileLabel, dtype, cacheOnly: !allowDownload, reuse: !!transcriber && loadedModelKey === key })
  if (transcriber && loadedModelKey === key) {
    await logRuntime(modelId, device, 0)
    return
  }
  if (currentSessionId) throw new Error('请先停止识别再切换模型')

  modelLoading = (async () => {
    const loadStartedAt = Date.now()
    if (device === 'webgpu') {
      const gpu = (navigator as any).gpu
      const adapter = env.backends.onnx.webgpu?.adapter
        ?? await gpu?.requestAdapter({ powerPreference: 'high-performance' })
      if (!adapter) throw new Error('WebGPU 不可用，请在设置中选择 WASM 并下载对应模型')
      if (!env.backends.onnx.webgpu!.adapter) env.backends.onnx.webgpu!.adapter = adapter
    }
    sendMsg({ type: 'model:progress', data: { loaded: 0, total: 0, status: '正在加载模型...' } })
    await transcriber?.dispose()
    transcriber = null
    loadedModelKey = null
    loadedProfile = null
    loadedDtype = null
    // @ts-expect-error transformers.js overload union too complex for tsc
    transcriber = await pipeline('automatic-speech-recognition', modelId, {
      dtype,
      device,
      local_files_only: !allowDownload,
      progress_callback: (progress: any) => {
        if (progress.status === 'progress') {
          sendMsg({
            type: 'model:progress',
            data: {
              file: progress.file ?? '',
              loaded: progress.loaded ?? 0,
              total: progress.total ?? 0,
              status: `${allowDownload ? '下载/加载中' : '从缓存加载中'}: ${progress.file ?? ''}`,
            },
          })
        }
      },
    })
    loadedModelKey = key
    loadedProfile = profile
    loadedDtype = dtype
    const loadMs = Date.now() - loadStartedAt
    let warmupMs = 0
    if (profile === 'webgpu-mixed') {
      sendMsg({ type: 'model:progress', data: { loaded: 0, total: 0, status: '正在编译 GPU 着色器...' } })
      const warmupStartedAt = Date.now()
      await (transcriber.model as any).generate({
        input_features: full([1, 80, 3000], 0),
        max_new_tokens: 1,
      })
      warmupMs = Date.now() - warmupStartedAt
      logDiagnostic('model-warmup', { modelId, device, profile, profileLabel, warmupMs })
    }
    await logRuntime(modelId, device, loadMs)
    logDiagnostic('model-ready', { modelId, device, profile, profileLabel, loadMs, warmupMs })
    console.log('[Offscreen] Model loaded:', modelId)
  })()
  try {
    await modelLoading
  } catch (err: any) {
    if (!allowDownload && err.message?.includes('was not found locally')) {
      throw new Error(`${device.toUpperCase()} / ${profileLabel} 模型缓存不完整，请在设置中下载选中的模型后重试`)
    }
    throw err
  } finally {
    modelLoading = null
  }
}

// ── Audio capture + playback ──

async function startAudio(streamId: string, sessionId: string, language: string) {
  if (!transcriber) throw new Error('模型尚未加载，请先初始化识别器')
  if (currentSessionId) throw new Error('音频采集已经启动')
  currentSessionId = sessionId
  currentLanguage = language
  chunkNumber = 0
  lastDiagnosticAt = 0

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    } as any,
  })

  audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })
  captureSource = audioContext.createMediaStreamSource(mediaStream)

  // Route 1: play back original audio so the tab isn't silenced
  captureSource.connect(audioContext.destination)

  // Route 2: capture audio data for ASR

  // Use ScriptProcessorNode for Phase 1 (AudioWorklet in Phase 2)
  // ponytail: ScriptProcessorNode is deprecated but works, AudioWorklet later if needed
  processor = audioContext.createScriptProcessor(4096, 1, 1)
  captureSource.connect(processor)
  processor.connect(audioContext.destination)

  processor.onaudioprocess = (e: AudioProcessingEvent) => {
    if (!currentSessionId) return
    const input = e.inputBuffer.getChannelData(0)
    lastAudioAt = Date.now()
    lastPeak = 0
    for (const sample of input) lastPeak = Math.max(lastPeak, Math.abs(sample))
    appendAudio(input)
  }

  await audioContext.resume()
  if (audioContext.state !== 'running') throw new Error('音频环境未运行，请检查浏览器音频权限')
  statusTimer = setInterval(reportAudioStatus, 1000)
  logDiagnostic('audio-start', {
    loadedModelKey, language, sampleRate: audioContext.sampleRate,
    contextState: audioContext.state, chunkSeconds: CHUNK_SECONDS,
    tracks: mediaStream.getAudioTracks().map(track => ({
      readyState: track.readyState, enabled: track.enabled, muted: track.muted,
      sampleRate: track.getSettings().sampleRate, channelCount: track.getSettings().channelCount,
    })),
  })
}

async function stopAudio() {
  currentSessionId = null
  if (statusTimer) clearInterval(statusTimer)
  statusTimer = null
  if (processor) {
    processor.onaudioprocess = null
    processor.disconnect()
    processor = null
  }
  captureSource?.disconnect()
  captureSource = null
  lastAudioAt = 0
  lastPeak = 0
  inferenceStartedAt = 0
  droppedAudio = false
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop())
    mediaStream = null
  }
  if (audioContext) {
    const context = audioContext
    audioContext = null
    await context.close()
  }
  audioBuffer = new Float32Array(0)
  processing = false
  console.log('[Offscreen] Audio capture stopped')
}

// ── Audio buffering + ASR ──

function appendAudio(chunk: Float32Array) {
  // ponytail: retain at most two pending chunks; skip stale audio rather than grow latency without limit.
  const capacity = CHUNK_SIZE * 2
  if (audioBuffer.length + chunk.length > capacity) droppedAudio = true
  chunk = chunk.subarray(Math.max(0, chunk.length - capacity))
  const pending = audioBuffer.subarray(Math.max(0, audioBuffer.length + chunk.length - capacity))
  const merged = new Float32Array(pending.length + chunk.length)
  merged.set(pending)
  merged.set(chunk, pending.length)
  audioBuffer = merged

  if (audioBuffer.length >= CHUNK_SIZE && !processing) {
    processChunk()
  }
}

async function processChunk() {
  if (!transcriber || !currentSessionId || processing) return
  processing = true

  const chunk = audioBuffer.slice(0, CHUNK_SIZE)
  audioBuffer = audioBuffer.slice(CHUNK_SIZE)

  const sessionId = currentSessionId
  const startTime = Date.now()
  inferenceStartedAt = startTime
  generatedTokens = 0
  firstTokenMs = null
  chunkNumber++
  reportAudioStatus()
  let sumSquares = 0
  let peak = 0
  for (const sample of chunk) {
    sumSquares += sample * sample
    peak = Math.max(peak, Math.abs(sample))
  }
  logDiagnostic('inference-start', {
    chunkNumber, loadedModelKey, profile: loadedProfile, profileLabel: loadedProfile && getProfileLabel(loadedProfile), dtype: loadedDtype, language: currentLanguage,
    samples: chunk.length, audioSeconds: chunk.length / SAMPLE_RATE,
    rms: Math.sqrt(sumSquares / chunk.length), peak,
  })

  try {
    const streamer = new TextStreamer(transcriber.tokenizer, {
      skip_prompt: true,
      callback_function: () => {},
      token_callback_function: tokens => {
        if (sessionId !== currentSessionId || tokens.length === 0) return
        generatedTokens += tokens.length
        if (firstTokenMs === null) {
          firstTokenMs = Date.now() - startTime
          logDiagnostic('first-token', { chunkNumber, elapsedMs: firstTokenMs })
        }
      },
    })
    const result = await transcriber(chunk, {
      language: currentLanguage,
      return_timestamps: false,
      max_new_tokens: 64,
      streamer,
    })

    const elapsed = Date.now() - startTime
    const text = (result as any).text?.trim()
    logDiagnostic('inference-end', {
      chunkNumber, elapsedMs: elapsed, textLength: text?.length ?? 0, generatedTokens, firstTokenMs,
      realtimeFactor: elapsed / (chunk.length / SAMPLE_RATE * 1000),
    })
    if (sessionId === currentSessionId) {
      sendMsg({ type: 'asr:status', data: {
        sessionId, phase: 'complete', hasAudio: true,
        detail: text ? `已识别片段（耗时 ${(elapsed / 1000).toFixed(1)} 秒）` : `本片段未识别出文字（耗时 ${(elapsed / 1000).toFixed(1)} 秒）`,
      } })
    }
    if (text && sessionId === currentSessionId) {
      sendMsg({
        type: 'asr:result',
        data: {
          text,
          startTime: 0,
          endTime: CHUNK_SECONDS,
          isFinal: true,
          sessionId,
        },
      })
    }
  } catch (err: any) {
    logDiagnostic('inference-error', { chunkNumber, elapsedMs: Date.now() - startTime, message: err.message })
    console.error('[Offscreen] ASR error:', err)
    if (sessionId === currentSessionId) {
      sendMsg({ type: 'asr:error', data: { message: err.message, sessionId } })
      await stopAudio()
    }
  }

  processing = false

  if (audioBuffer.length >= CHUNK_SIZE && currentSessionId) {
    processChunk()
  }
}

// ── Message handling ──

function sendMsg(msg: any) {
  chrome.runtime.sendMessage(msg).catch(() => {})
}

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (msg.type === 'offscreen:ping') {
    sendResponse({ ok: true })
    return
  }
  if (!['audio:start', 'audio:stop', 'asr:configure'].includes(msg.type)) return

  ;(async () => {
    try {
      if (msg.type === 'asr:configure') {
        if (!['webgpu-mixed', 'q8'].includes(msg.data.profile)) throw new Error('无效的模型格式')
        await loadModel(msg.data.modelId, msg.data.device, msg.data.profile, msg.data.allowDownload === true)
      } else if (msg.type === 'audio:start') {
        await startAudio(msg.data.streamId, msg.data.sessionId, msg.data.language ?? 'en')
      } else {
        await stopAudio()
      }
      sendResponse({ ok: true })
    } catch (err: any) {
      logDiagnostic('request-error', { request: msg.type, message: err.message })
      console.error(`[Offscreen] ${msg.type} failed:`, err)
      if (msg.type === 'asr:configure') {
        sendMsg({ type: 'model:error', data: { message: err.message, requestId: msg.data.requestId } })
      }
      if (msg.type === 'audio:start') await stopAudio().catch(() => {})
      sendResponse({ ok: false, error: err.message })
    }
  })()
  return true
})

console.log('[HearClear] Offscreen document ready')

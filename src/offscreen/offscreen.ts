import { pipeline, env, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'

// WASM files are packaged with the extension
env.backends.onnx.wasm!.wasmPaths = chrome.runtime.getURL('wasm/')
// Models are cached in browser Cache Storage by transformers.js
env.allowRemoteModels = true

let audioContext: AudioContext | null = null
let mediaStream: MediaStream | null = null
let transcriber: AutomaticSpeechRecognitionPipeline | null = null
let currentSessionId: string | null = null
let currentLanguage = 'en'

const SAMPLE_RATE = 16000
const CHUNK_SECONDS = 5
const CHUNK_SIZE = SAMPLE_RATE * CHUNK_SECONDS

let audioBuffer: Float32Array = new Float32Array(0)
let processing = false

// ── Model loading ──

async function loadModel(modelId: string, device: 'webgpu' | 'wasm') {
  sendMsg({ type: 'model:progress', data: { loaded: 0, total: 100, status: '正在加载模型...' } })

  try {
    // @ts-expect-error transformers.js overload union too complex for tsc
    transcriber = await pipeline('automatic-speech-recognition', modelId, {
      dtype: 'q8',
      device,
      progress_callback: (progress: any) => {
        if (progress.status === 'progress') {
          sendMsg({
            type: 'model:progress',
            data: {
              file: progress.file ?? '',
              loaded: progress.loaded ?? 0,
              total: progress.total ?? 100,
              status: `下载中: ${progress.file ?? ''}`,
            },
          })
        }
      },
    })

    sendMsg({ type: 'model:ready', data: { modelId } })
    console.log('[Offscreen] Model loaded:', modelId)
  } catch (err: any) {
    console.error('[Offscreen] Model load error:', err)
    sendMsg({ type: 'model:error', data: { message: err.message } })
  }
}

// ── Audio capture + playback ──

async function startAudio(streamId: string, sessionId: string, language: string) {
  currentSessionId = sessionId
  currentLanguage = language

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    } as any,
  })

  audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })
  const source = audioContext.createMediaStreamSource(mediaStream)

  // Route 1: play back original audio so the tab isn't silenced
  const destination = audioContext.createMediaStreamDestination()
  source.connect(destination)
  const audio = new Audio()
  audio.srcObject = destination.stream
  audio.play()

  // Route 2: capture audio data for ASR
  const analyser = audioContext.createAnalyser()
  source.connect(analyser)

  // Use ScriptProcessorNode for Phase 1 (AudioWorklet in Phase 2)
  // ponytail: ScriptProcessorNode is deprecated but works, AudioWorklet later if needed
  const processor = audioContext.createScriptProcessor(4096, 1, 1)
  source.connect(processor)
  processor.connect(audioContext.destination)

  processor.onaudioprocess = (e: AudioProcessingEvent) => {
    if (!currentSessionId) return
    const input = e.inputBuffer.getChannelData(0)
    appendAudio(input)
  }

  console.log('[Offscreen] Audio capture started, session:', sessionId)
}

function stopAudio() {
  currentSessionId = null
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop())
    mediaStream = null
  }
  if (audioContext) {
    audioContext.close()
    audioContext = null
  }
  audioBuffer = new Float32Array(0)
  processing = false
  console.log('[Offscreen] Audio capture stopped')
}

// ── Audio buffering + ASR ──

function appendAudio(chunk: Float32Array) {
  const merged = new Float32Array(audioBuffer.length + chunk.length)
  merged.set(audioBuffer)
  merged.set(chunk, audioBuffer.length)
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

  try {
    const result = await transcriber(chunk, {
      language: currentLanguage,
      return_timestamps: true,
      chunk_length_s: 30,
    })

    const elapsed = Date.now() - startTime
    console.log(`[Offscreen] ASR chunk: ${elapsed}ms, text: "${(result as any).text?.slice(0, 60)}"`)

    const text = (result as any).text?.trim()
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
    console.error('[Offscreen] ASR error:', err)
    sendMsg({ type: 'asr:error', data: { message: err.message } })
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

chrome.runtime.onMessage.addListener((msg: any) => {
  if (msg.type === 'audio:start') {
    startAudio(msg.data.streamId, msg.data.sessionId, msg.data.language ?? 'en')
  }
  if (msg.type === 'audio:stop') {
    stopAudio()
  }
  if (msg.type === 'asr:configure') {
    loadModel(msg.data.modelId, msg.data.device)
  }
})

chrome.runtime.sendMessage({ type: 'offscreen:ready' }).catch(() => {})
console.log('[HearClear] Offscreen document ready')

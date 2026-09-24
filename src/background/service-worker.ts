import type { AsrConfig, Cue, SessionInfo, TranslationConfig, SessionState } from '../shared/types'
import type { BackgroundToOffscreenMessage, OffscreenResponse } from '../shared/messages'
import { sendToTab } from '../shared/messages'
import { DEFAULT_ASR_CONFIG, getCachedProfile, getPreferredProfile, getProfileLabel, getProfileModelFiles, hasModelFiles, normalizeModelId } from '../shared/asr'

let session: SessionInfo | null = null
let translationConfig: TranslationConfig | null = null
const translationCache = new Map<string, string>()
let batchQueue: Array<{ id: string; text: string }> = []
let batchTimer: ReturnType<typeof setTimeout> | null = null
const MAX_CAPTION_HISTORY = 50
let captionHistory: Cue[] = []
let asrWatchdog: ReturnType<typeof setInterval> | null = null
let asrPhase = 'capturing'
let asrPhaseAt = 0
let audioReceivedAt = 0

function clearAsrWatchdog() {
  if (asrWatchdog) clearInterval(asrWatchdog)
  asrWatchdog = null
}

function watchAsr(sessionId: string) {
  clearAsrWatchdog()
  asrPhase = 'capturing'
  asrPhaseAt = audioReceivedAt = Date.now()
  asrWatchdog = setInterval(() => {
    if (session?.sessionId !== sessionId || session.state !== 'asr_mode') return
    const error = asrPhase === 'processing'
      ? Date.now() - asrPhaseAt > 90000 ? '单个片段推理超过 90 秒，请在设置中尝试 tiny/base 或切换推理设备' : null
      : Date.now() - audioReceivedAt > 15000 ? '15 秒未收到音频数据，请确认视频播放后重试' : null
    if (!error) return
    console.info('[HearClear diagnostic]', JSON.stringify({
      event: 'watchdog-timeout', time: new Date().toISOString(), sessionId,
      phase: asrPhase, phaseElapsedMs: Date.now() - asrPhaseAt,
      audioReceivedAgeMs: Date.now() - audioReceivedAt, message: error,
    }))
    clearAsrWatchdog()
    updateState('error', error)
    // Closing the document cancels stalled inference; do not start overlapping work.
    closeOffscreen().catch(() => {})
  }, 1000)
}

async function loadTranslationConfig(): Promise<TranslationConfig | null> {
  const data = await chrome.storage.local.get('translationConfig')
  const c = data.translationConfig as TranslationConfig | undefined
  if (c?.baseUrl && c?.apiKey) {
    translationConfig = c
    return c
  }
  return null
}

function genId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function broadcastCaption(cue: Cue) {
  const index = captionHistory.findIndex(item => item.id === cue.id)
  if (index >= 0) captionHistory[index] = cue
  else captionHistory.push(cue)
  if (captionHistory.length > MAX_CAPTION_HISTORY) captionHistory.shift()
  chrome.runtime.sendMessage({ type: 'caption:update', data: { cue } }).catch(() => {})
}

function updateCaptionTranslation(id: string, translation: string) {
  const cue = captionHistory.find(item => item.id === id)
  if (cue) broadcastCaption({ ...cue, translation })
}

function clearCaptionHistory() {
  captionHistory = []
  chrome.runtime.sendMessage({ type: 'caption:clear' }).catch(() => {})
}

// ── Offscreen management ──

let offscreenCreating: Promise<void> | null = null
let offscreenClosing: Promise<void> | null = null
let modelDownloading = false

async function ensureOffscreen(): Promise<void> {
  if (offscreenClosing) await offscreenClosing
  if (offscreenCreating) return offscreenCreating

  offscreenCreating = (async () => {
    if (!await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: 'Audio capture and ASR processing for subtitle generation',
      })
    }
    // Creating a document does not guarantee its module listener is ready yet.
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      try {
        await sendToOffscreen({ type: 'offscreen:ping' }, 1000)
        return
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
    throw new Error('识别环境启动超时')
  })()
  try {
    await offscreenCreating
  } finally {
    offscreenCreating = null
  }
}

async function sendToOffscreen(msg: BackgroundToOffscreenMessage, timeout = 15000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage(msg) as Promise<OffscreenResponse | undefined>,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${msg.type} 超时`)), timeout)
      }),
    ])
    if (!response?.ok) throw new Error(response?.error ?? '识别环境未响应')
  } finally {
    clearTimeout(timer)
  }
}

async function closeOffscreen(): Promise<void> {
  if (offscreenClosing) return offscreenClosing
  offscreenClosing = (async () => {
    await offscreenCreating?.catch(() => {})
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument()
    }
  })()
  try {
    await offscreenClosing
  } finally {
    offscreenClosing = null
  }
}

// ── Tab capture ──

async function startCapture(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      resolve(streamId)
    })
  })
}

// ── Translation ──

function buildEndpoint(baseUrl: string): string {
  let url = baseUrl.replace(/\/+$/, '')
  if (url.endsWith('/chat/completions')) return url
  if (url.endsWith('/v1')) return url + '/chat/completions'
  return url + '/v1/chat/completions'
}

async function translateText(texts: string[], config: TranslationConfig, targetLang: string): Promise<string[]> {
  const numbered = texts.map((t, i) => `${i + 1}| ${t}`).join('\n')
  const endpoint = buildEndpoint(config.baseUrl)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeout * 1000)

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.modelId,
        messages: [
          { role: 'system', content: `将以下字幕翻译为${targetLang}。仅返回译文，每行对应一条原文，保持行数一致。不要包含编号。` },
          { role: 'user', content: numbered },
        ],
        temperature: 0.3,
        max_tokens: 2048,
      }),
      signal: controller.signal,
    })

    clearTimeout(timer)

    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`)
    }

    const json = await resp.json()
    const content: string = json.choices?.[0]?.message?.content ?? ''
    const lines = content.split('\n').map((l: string) => l.replace(/^\d+\|\s*/, '').trim()).filter(Boolean)

    if (lines.length !== texts.length) {
      console.warn(`[SW] Translation line count mismatch: expected ${texts.length}, got ${lines.length}`)
    }

    return lines
  } catch (err: any) {
    clearTimeout(timer)
    if (err.name === 'AbortError') throw new Error(`翻译超时 (${config.timeout}s)`)
    throw err
  }
}

async function testTranslation(baseUrl: string, apiKey: string, modelId: string): Promise<{ success: boolean; result?: string; error?: string; elapsed?: number }> {
  const config: TranslationConfig = { baseUrl, apiKey, modelId, timeout: 15, maxConcurrency: 1 }
  const start = Date.now()
  try {
    const [result] = await translateText(['Hello, this is a test.'], config, '简体中文')
    return { success: true, result, elapsed: Date.now() - start }
  } catch (err: any) {
    return { success: false, error: err.message, elapsed: Date.now() - start }
  }
}

// ── TextTrack translation pipeline ──

function enqueueTranslation(id: string, text: string) {
  if (translationCache.has(text)) {
    sendCachedTranslation(id, text)
    return
  }
  batchQueue.push({ id, text })
  if (!batchTimer) {
    batchTimer = setTimeout(flushBatch, 200)
  }
}

function sendCachedTranslation(id: string, text: string) {
  if (!session) return
  const translation = translationCache.get(text)
  if (translation) {
    updateCaptionTranslation(id, translation)
    sendToTab(session.tabId, { type: 'subtitle:translated', data: { id, translation } }).catch(() => {})
  }
}

async function flushBatch() {
  batchTimer = null
  if (!session || !translationConfig || batchQueue.length === 0) return

  const batch = batchQueue.splice(0, 20)
  const uniqueTexts = [...new Set(batch.map(b => b.text))].filter(t => !translationCache.has(t))

  if (uniqueTexts.length === 0) {
    batch.forEach(b => sendCachedTranslation(b.id, b.text))
    return
  }

  const tabId = session.tabId
  const sid = session.sessionId

  try {
    const translations = await translateText(uniqueTexts, translationConfig, session.targetLang)
    if (session?.sessionId !== sid) return

    uniqueTexts.forEach((text, i) => {
      if (translations[i]) {
        translationCache.set(text, translations[i])
      }
    })

    batch.forEach(b => {
      const t = translationCache.get(b.text)
      if (t) {
        updateCaptionTranslation(b.id, t)
        sendToTab(tabId, { type: 'subtitle:translated', data: { id: b.id, translation: t } }).catch(() => {})
      }
    })
  } catch (err: any) {
    console.warn('[SW] Batch translation failed:', err.message)
    // Don't kill the session — show originals and keep going
    if (session?.state === 'subtitle_mode') {
      updateState('subtitle_mode', `翻译出错（仅显示原文）: ${err.message}`)
    }
  }

  if (batchQueue.length > 0 && !batchTimer) {
    batchTimer = setTimeout(flushBatch, 100)
  }
}

// ── Session management ──

function updateState(state: SessionState, detail?: string) {
  if (!session) return
  session.state = state
  session.detail = detail
  const msg = { type: 'session:state' as const, data: { ...session } }
  // Broadcast to popup / side panel
  chrome.runtime.sendMessage(msg).catch(() => {})
  // Send to content script on tab
  if (session.tabId) {
    sendToTab(session.tabId, msg).catch(() => {})
  }
}

async function startSession(tabId: number, workMode: string, sourceLang: string, targetLang: string) {
  if (modelDownloading) return
  if (session && session.state !== 'error') return
  if (session) await stopSession()
  if (session) return

  translationCache.clear()
  batchQueue = []
  clearCaptionHistory()

  session = {
    sessionId: genId(),
    generation: 0,
    tabId,
    state: 'detecting',
    workMode: workMode as any,
    sourceLang,
    targetLang,
  }

  const activeSession = session
  updateState('detecting', '正在检测视频...')

  // Ask content script about the page
  try {
    await loadTranslationConfig()
    if (session !== activeSession) return
    const detection = await sendToTab(tabId, { type: 'media:detect' } as any) as { hasVideo: boolean; hasTextTrack: boolean } | undefined
    if (session !== activeSession) return

    if (!detection?.hasVideo) {
      updateState('error', '未检测到视频')
      return
    }

    // Decide mode
    if (workMode === 'subtitle_only') {
      if (detection.hasTextTrack) {
        await enterSubtitleMode(tabId)
      } else {
        updateState('error', '未找到字幕轨道')
      }
      return
    }

    if (workMode === 'asr_only') {
      await enterAsrMode(tabId, sourceLang)
      return
    }

    // auto mode: prefer subtitles
    if (detection.hasTextTrack) {
      await enterSubtitleMode(tabId)
    } else {
      await enterAsrMode(tabId, sourceLang)
    }
  } catch (err: any) {
    if (session !== activeSession) return
    console.error('[SW] Detection failed:', err)
    updateState('error', `无法连接视频页面，请刷新视频页后重试: ${err.message}`)
  }
}

async function enterSubtitleMode(tabId: number) {
  updateState('subtitle_mode', '正在翻译字幕')
  sendToTab(tabId, { type: 'session:startSubtitle' }).catch(() => {})
  if (!translationConfig?.baseUrl) {
    updateState('subtitle_mode', '字幕模式（未配置翻译 API，仅显示原文）')
  }
}

async function enterAsrMode(tabId: number, sourceLang: string) {
  const activeSession = session
  if (!activeSession) return
  try {
    const { asrConfig } = await chrome.storage.local.get('asrConfig')
    const config: AsrConfig = { ...DEFAULT_ASR_CONFIG, ...(asrConfig as Partial<AsrConfig> | undefined) }
    config.modelId = normalizeModelId(config.modelId)
    const cache = await caches.open('transformers-cache')
    const urls = (await cache.keys()).map(request => request.url)
    let profile = getCachedProfile(urls, config.modelId, config.device)
    if (!profile) throw new Error('所选模型缓存不完整，请在设置中下载后重试')
    // KEEP: Transformers.js 3.8.1 WebGPU uses FP32/Q4 for Whisper; legacy Q8 runs on WASM.
    let effectiveDevice = config.device === 'webgpu' && profile === 'q8' ? 'wasm' : config.device
    if (session !== activeSession) return
    const saved = asrConfig as Partial<AsrConfig> | undefined
    console.info('[HearClear diagnostic]', JSON.stringify({
      event: 'saved-config', time: new Date().toISOString(), sessionId: activeSession.sessionId,
      saved: saved ? { modelId: saved.modelId, device: saved.device, language: saved.language } : null,
      effective: { modelId: config.modelId, device: effectiveDevice, requestedDevice: config.device, language: sourceLang, profile, profileLabel: getProfileLabel(profile), cacheOnly: true },
    }))
    updateState('detecting', `正在加载模型 ${config.modelId.split('/').pop()}...`)
    await ensureOffscreen()
    if (session !== activeSession) return
    try {
      await sendToOffscreen({ type: 'asr:configure', data: { ...config, device: effectiveDevice, profile, allowDownload: false } }, 10 * 60 * 1000)
    } catch (err) {
      if (profile !== 'webgpu-mixed' || !hasModelFiles(urls, config.modelId, 'q8')) throw err
      console.warn('[SW] WebGPU model failed, retrying cached Q8 with WASM:', err)
      await closeOffscreen()
      await ensureOffscreen()
      profile = 'q8'
      effectiveDevice = 'wasm'
      await sendToOffscreen({ type: 'asr:configure', data: { ...config, device: effectiveDevice, profile, allowDownload: false } }, 10 * 60 * 1000)
    }
    if (session !== activeSession) return
    chrome.runtime.sendMessage({
      type: 'model:ready',
      data: { modelId: config.modelId, device: effectiveDevice, profile, profileLabel: getProfileLabel(profile) },
    }).catch(() => {})
    updateState('detecting', '正在启动音频采集...')
    const streamId = await startCapture(tabId)
    if (session !== activeSession) return
    await sendToOffscreen({
      type: 'audio:start',
      data: { streamId, sessionId: activeSession.sessionId, language: sourceLang },
    })
    if (session !== activeSession || session.state !== 'detecting') return
    updateState('asr_mode', '音频采集已启动，等待音频数据')
    watchAsr(activeSession.sessionId)
  } catch (err: any) {
    if (session !== activeSession) return
    console.error('[SW] ASR startup failed:', err)
    updateState('error', `识别启动失败: ${err.message}`)
    await closeOffscreen().catch(() => {})
  }
}

async function stopSession() {
  clearAsrWatchdog()
  if (!session) return
  const { tabId, state } = session
  updateState('stopped', '已停止')
  session = null
  clearCaptionHistory()
  translationCache.clear()
  batchQueue = []

  if (state === 'subtitle_mode') {
    sendToTab(tabId, { type: 'session:stopSubtitle' }).catch(() => {})
  } else {
    await closeOffscreen().catch(() => {})
  }
}

// ── Message handler ──

chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
  const type = msg.type as string

  if (type === 'asr:diagnostic') {
    if (sender.url === chrome.runtime.getURL('offscreen/offscreen.html')) {
      console.info('[HearClear diagnostic]', JSON.stringify(msg.data))
    }
    return
  }

  // Popup messages
  if (type === 'session:start') {
    if (modelDownloading) {
      sendResponse({ ok: false, error: '模型正在下载，请完成后再开始识别' })
      return
    }
    const { workMode, sourceLang, targetLang } = msg.data
    const tabId = sender.tab?.id
    if (!tabId) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          startSession(tabs[0].id, workMode, sourceLang, targetLang)
        }
      })
    } else {
      startSession(tabId, workMode, sourceLang, targetLang)
    }
    sendResponse({ ok: true })
    return
  }

  if (type === 'session:stop') {
    stopSession()
    sendResponse({ ok: true })
    return
  }

  if (type === 'session:query') {
    sendResponse({ session, captions: captionHistory })
    return
  }

  if (type === 'model:download') {
    if ((session && session.state !== 'error') || modelDownloading) {
      chrome.runtime.sendMessage({
        type: 'model:error',
        data: { message: '请先停止当前会话或等待模型下载完成', requestId: msg.data.requestId },
      }).catch(() => {})
      sendResponse({ ok: false })
      return
    }
    modelDownloading = true
    ;(async () => {
      try {
        if (session?.state === 'error') await stopSession()
        await closeOffscreen()
        await ensureOffscreen()
        const modelId = normalizeModelId(msg.data.modelId)
        const device = msg.data.device ?? 'webgpu'
        const profile = getPreferredProfile(device)
        await sendToOffscreen({
          type: 'asr:configure',
          data: { modelId, device, profile, allowDownload: true, requestId: msg.data.requestId },
        }, 10 * 60 * 1000)
        const cache = await caches.open('transformers-cache')
        const urls = (await cache.keys()).map(request => request.url)
        if (!hasModelFiles(urls, modelId, profile)) {
          const expected = getProfileModelFiles(profile).join(', ')
          throw new Error(`模型已加载但缓存写入不完整，请检查浏览器存储空间（缺少 ${expected}）`)
        }
        chrome.runtime.sendMessage({
          type: 'model:ready',
          data: { modelId, device, profile, profileLabel: getProfileLabel(profile), requestId: msg.data.requestId },
        }).catch(() => {})
      } catch (err: any) {
        await closeOffscreen().catch(() => {})
        chrome.runtime.sendMessage({
          type: 'model:error',
          data: { message: err.message, requestId: msg.data.requestId },
        }).catch(() => {})
      } finally {
        modelDownloading = false
      }
    })()
    sendResponse({ ok: true })
    return
  }

  if (type === 'translate:test') {
    testTranslation(msg.data.baseUrl, msg.data.apiKey, msg.data.modelId)
      .then(r => sendResponse(r))
    return true
  }

  // TextTrack cues from content script
  if (type === 'texttrack:cue' && session) {
    const { id, text, startTime, endTime } = msg.data
    broadcastCaption({ id, startTime, endTime, original: text, source: 'texttrack' })
    enqueueTranslation(id, text)
  }

  if (type === 'texttrack:batch' && session) {
    const cues = msg.data.cues as Array<{ id: string; startTime: number; endTime: number; text: string }>
    for (const c of cues) {
      broadcastCaption({ id: c.id, startTime: c.startTime, endTime: c.endTime, original: c.text, source: 'texttrack' })
      enqueueTranslation(c.id, c.text)
    }
  }

  // Offscreen messages
  if (type === 'asr:status' && session?.state === 'asr_mode' && msg.data.sessionId === session.sessionId) {
    if (msg.data.hasAudio) audioReceivedAt = Date.now()
    if (msg.data.phase !== asrPhase) {
      asrPhase = msg.data.phase
      asrPhaseAt = Date.now()
    }
    updateState('asr_mode', msg.data.detail)
  }
  if (type === 'asr:result' && session?.state === 'asr_mode') {
    const { text, startTime, endTime, sessionId } = msg.data
    if (sessionId !== session.sessionId) return

    const cue: Cue = {
      id: `asr-${Date.now()}`,
      startTime,
      endTime,
      original: text,
      source: 'asr',
    }

    const tabId = session.tabId
    const gen = session.generation
    const sid = session.sessionId
    broadcastCaption(cue)

    sendToTab(tabId, { type: 'subtitle:show', data: { cue, generation: gen } })
      .then(response => console.info('[HearClear diagnostic]', JSON.stringify({
        event: 'subtitle-delivery', time: new Date().toISOString(), sessionId: sid,
        tabId, generation: gen, textLength: text.length, rendered: response?.rendered === true,
      })))
      .catch(err => console.error('[SW] Subtitle delivery failed:', err))

    if (translationConfig?.baseUrl && translationConfig?.apiKey) {
      translateText([text], translationConfig, session.targetLang)
        .then(([translated]) => {
          if (session?.sessionId !== sid || session?.generation !== gen || !translated) return
          cue.translation = translated
          broadcastCaption(cue)
          sendToTab(tabId, {
            type: 'subtitle:translated',
            data: { id: cue.id, translation: translated },
          }).catch(() => {})
        })
        .catch(err => {
          console.warn('[SW] Translation failed:', err.message)
          if (session?.state === 'asr_mode') {
            updateState('asr_mode', `翻译出错（仅显示原文）: ${err.message}`)
          }
        })
    }
  }

  if (type === 'asr:error' && session && msg.data.sessionId === session.sessionId) {
    clearAsrWatchdog()
    updateState('error', `识别出错: ${msg.data.message}`)
    closeOffscreen().catch(() => {})
  }

  if (type === 'model:ready' || type === 'model:error') {
    console.log(`[SW] ${type}:`, msg.data)
  }

  // Content Script messages
  if (type === 'media:detected' && session) {
    console.log('[SW] Media detected:', msg.data)
  }

  if (type === 'media:seeking' && session && sender.tab?.id === session.tabId) {
    session.generation++
    clearCaptionHistory()
    sendToTab(session.tabId, {
      type: 'subtitle:clear',
      data: { generation: session.generation },
    }).catch(() => {})
  }
})

// Cleanup on tab close
chrome.tabs.onRemoved.addListener((tabId) => {
  if (session?.tabId === tabId) {
    stopSession()
  }
})

// Reload config when settings change
chrome.storage.onChanged.addListener((changes) => {
  if (changes.translationConfig) {
    loadTranslationConfig()
  }
})

console.log('[HearClear] Service Worker started')

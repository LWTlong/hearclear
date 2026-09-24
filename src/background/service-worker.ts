import type { Cue, SessionInfo, TranslationConfig, SessionState } from '../shared/types'
import type { BackgroundToOffscreenMessage } from '../shared/messages'
import { sendToTab } from '../shared/messages'

let session: SessionInfo | null = null
let translationConfig: TranslationConfig | null = null
const translationCache = new Map<string, string>()
let batchQueue: Array<{ id: string; text: string }> = []
let batchTimer: ReturnType<typeof setTimeout> | null = null

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

// ── Offscreen management ──

let offscreenCreating: Promise<void> | null = null
let pendingModelDownload: { modelId: string; device: string } | null = null

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.offscreen.hasDocument()
  if (existing) return

  if (offscreenCreating) {
    await offscreenCreating
    return
  }

  offscreenCreating = chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification: 'Audio capture and ASR processing for subtitle generation',
  })
  await offscreenCreating
  offscreenCreating = null
}

async function closeOffscreen(): Promise<void> {
  const existing = await chrome.offscreen.hasDocument()
  if (existing) {
    await chrome.offscreen.closeDocument()
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
    sendToTab(session.tabId, { type: 'subtitle:translated', data: { id: text, translation } }).catch(() => {})
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
        sendToTab(tabId, { type: 'subtitle:translated', data: { id: b.text, translation: t } }).catch(() => {})
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
  await loadTranslationConfig()

  translationCache.clear()
  batchQueue = []

  session = {
    sessionId: genId(),
    generation: 0,
    tabId,
    state: 'detecting',
    workMode: workMode as any,
    sourceLang,
    targetLang,
  }

  updateState('detecting', '正在检测视频...')

  // Ask content script about the page
  try {
    const detection = await sendToTab(tabId, { type: 'media:detect' } as any) as { hasVideo: boolean; hasTextTrack: boolean } | undefined

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
    console.error('[SW] Detection failed:', err)
    // Content script may not respond (page not ready), fall back to ASR
    if (workMode !== 'subtitle_only') {
      await enterAsrMode(tabId, sourceLang)
    } else {
      updateState('error', '检测失败: ' + err.message)
    }
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
  if (!session) return
  try {
    await ensureOffscreen()
    const streamId = await startCapture(tabId)
    chrome.runtime.sendMessage({
      type: 'audio:start',
      data: { streamId, sessionId: session.sessionId, language: sourceLang },
    } satisfies BackgroundToOffscreenMessage)
    updateState('asr_mode', '正在识别声音')
  } catch (err: any) {
    console.error('[SW] Capture failed:', err)
    updateState('error', `音频采集失败: ${err.message}`)
  }
}

async function stopSession() {
  if (!session) return
  const tabId = session.tabId

  if (session.state === 'asr_mode') {
    chrome.runtime.sendMessage({ type: 'audio:stop' } satisfies BackgroundToOffscreenMessage).catch(() => {})
    await closeOffscreen().catch(() => {})
  }

  if (session.state === 'subtitle_mode') {
    sendToTab(tabId, { type: 'session:stopSubtitle' }).catch(() => {})
  }

  updateState('stopped', '已停止')
  session = null
  translationCache.clear()
  batchQueue = []
}

// ── Message handler ──

chrome.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
  const type = msg.type as string

  // Popup messages
  if (type === 'session:start') {
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
    sendResponse({ session })
    return
  }

  if (type === 'model:download') {
    pendingModelDownload = { modelId: msg.data.modelId, device: msg.data.device ?? 'webgpu' }
    ;(async () => {
      try {
        await closeOffscreen().catch(() => {})
        await ensureOffscreen()
      } catch (err: any) {
        pendingModelDownload = null
        chrome.runtime.sendMessage({
          type: 'model:error',
          data: { message: `创建 Offscreen 失败: ${err.message}` },
        }).catch(() => {})
      }
    })()
    sendResponse({ ok: true })
    return
  }

  if (type === 'offscreen:ready') {
    if (pendingModelDownload) {
      const dl = pendingModelDownload
      pendingModelDownload = null
      chrome.runtime.sendMessage({ type: 'asr:configure', data: dl }).catch(() => {})
    }
    return
  }

  if (type === 'translate:test') {
    testTranslation(msg.data.baseUrl, msg.data.apiKey, msg.data.modelId)
      .then(r => sendResponse(r))
    return true
  }

  // TextTrack cues from content script
  if (type === 'texttrack:cue' && session) {
    const { id, text } = msg.data
    enqueueTranslation(id, text)
  }

  if (type === 'texttrack:batch' && session) {
    const cues = msg.data.cues as Array<{ id: string; text: string }>
    for (const c of cues) {
      enqueueTranslation(c.id, c.text)
    }
  }

  // Offscreen messages
  if (type === 'asr:result' && session) {
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

    sendToTab(tabId, { type: 'subtitle:show', data: { cue, generation: gen } }).catch(() => {})

    if (translationConfig?.baseUrl && translationConfig?.apiKey && session.workMode !== 'asr_only') {
      translateText([text], translationConfig, session.targetLang)
        .then(([translated]) => {
          if (session?.sessionId !== sid || session?.generation !== gen) return
          cue.translation = translated
          sendToTab(tabId, { type: 'subtitle:show', data: { cue, generation: gen } }).catch(() => {})
        })
        .catch(err => {
          console.warn('[SW] Translation failed:', err.message)
          if (session?.state === 'asr_mode') {
            updateState('asr_mode', `翻译出错（仅显示原文）: ${err.message}`)
          }
        })
    }
  }

  if (type === 'asr:error' && session) {
    updateState('error', `识别出错: ${msg.data.message}`)
  }

  if (type === 'model:progress' || type === 'model:ready' || type === 'model:error') {
    console.log(`[SW] ${type}:`, msg.data)
  }

  // Content Script messages
  if (type === 'media:detected' && session) {
    console.log('[SW] Media detected:', msg.data)
  }

  if (type === 'media:seeking' && session) {
    session.generation++
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

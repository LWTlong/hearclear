import type { Cue, SubtitleDisplayMode, SubtitleStyle } from '../shared/types'
import type { ContentMessage } from '../shared/messages'

// ── State ──

let currentVideo: HTMLVideoElement | null = null
let subtitleContainer: HTMLElement | null = null
let shadowRoot: ShadowRoot | null = null
let currentGeneration = 0
let displayMode: SubtitleDisplayMode = 'bilingual'
let clearTimer: ReturnType<typeof setTimeout> | null = null
let trackMonitorActive = false
let monitoredTrack: TextTrack | null = null
let translationCache = new Map<string, string>()
let currentCueId: string | null = null
const pageListeners = new AbortController()
let mediaTimer: ReturnType<typeof setInterval> | null = null
let videoObserver: MutationObserver | null = null

function stopInvalidatedScript() {
  pageListeners.abort()
  if (mediaTimer) clearInterval(mediaTimer)
  videoObserver?.disconnect()
  stopTextTrackMonitor()
  if (clearTimer) clearTimeout(clearTimer)
  subtitleContainer?.remove()
}

async function sendPageMessage(msg: ContentMessage): Promise<void> {
  if (pageListeners.signal.aborted) return
  try {
    if (!chrome.runtime.id) {
      stopInvalidatedScript()
      return
    }
    await chrome.runtime.sendMessage(msg)
  } catch (err: any) {
    if (!chrome.runtime.id || err.message?.includes('Extension context invalidated')) {
      stopInvalidatedScript()
    } else {
      console.warn('[HearClear] Page message failed:', err)
    }
  }
}

// ── Video detection ──

function findMainVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll('video'))
  if (videos.length === 0) return null
  if (videos.length === 1) return videos[0]

  return videos
    .filter(v => !v.paused && v.offsetWidth > 0 && v.offsetHeight > 0)
    .sort((a, b) => (b.offsetWidth * b.offsetHeight) - (a.offsetWidth * a.offsetHeight))[0]
    ?? videos[0]
}

// ── Subtitle rendering (Shadow DOM) ──

function createSubtitleLayer(video: HTMLVideoElement) {
  if (subtitleContainer) subtitleContainer.remove()

  const host = document.createElement('div')
  host.id = 'hearclear-subtitle-host'
  // KEEP: fixed positioning avoids player stacking/overflow rules; geometry follows the video below.
  host.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;'

  shadowRoot = host.attachShadow({ mode: 'closed' })
  shadowRoot.innerHTML = `
    <style>
      :host { all: initial; }
      .hc-subtitle {
        position: absolute;
        bottom: 8%;
        left: 10%;
        right: 10%;
        text-align: center;
        pointer-events: none;
        transition: opacity 0.15s;
        opacity: 0;
      }
      .hc-original {
        font-size: var(--hc-orig-size, 14px);
        color: rgba(255,255,255,0.7);
        font-family: -apple-system, 'Segoe UI', sans-serif;
        text-shadow: 0 1px 3px rgba(0,0,0,0.8);
        margin-bottom: 2px;
        line-height: 1.4;
        word-break: keep-all;
        overflow-wrap: break-word;
      }
      .hc-translation {
        font-size: var(--hc-trans-size, 18px);
        color: #fff;
        font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
        text-shadow: 0 1px 4px rgba(0,0,0,0.9);
        line-height: 1.5;
        word-break: keep-all;
        overflow-wrap: break-word;
      }
      .hc-bg {
        display: inline-block;
        background: rgba(0,0,0, var(--hc-bg-opacity, 0.7));
        padding: 4px 12px;
        border-radius: 4px;
        max-width: 100%;
      }
    </style>
    <div class="hc-subtitle">
      <div class="hc-bg">
        <div class="hc-original" id="original"></div>
        <div class="hc-translation" id="translation"></div>
      </div>
    </div>
  `

  subtitleContainer = host
  document.documentElement.appendChild(host)
  updateSubtitleGeometry()
}

function ensureSubtitleLayer() {
  const activeVideo = findMainVideo()
  if (!currentVideo?.isConnected || (activeVideo && activeVideo !== currentVideo)) currentVideo = activeVideo
  if (!currentVideo) return
  if (!subtitleContainer?.isConnected) createSubtitleLayer(currentVideo)
  if (!subtitleContainer) return
  const parent = document.fullscreenElement ?? document.documentElement
  if (subtitleContainer.parentElement !== parent) parent.appendChild(subtitleContainer)
}

function updateSubtitleGeometry() {
  if (!subtitleContainer || !currentVideo) return
  const rect = currentVideo.getBoundingClientRect()
  subtitleContainer.style.left = `${rect.left}px`
  subtitleContainer.style.top = `${rect.top}px`
  subtitleContainer.style.width = `${rect.width}px`
  subtitleContainer.style.height = `${rect.height}px`
}

function showSubtitle(cue: Cue) {
  ensureSubtitleLayer()
  if (!shadowRoot || !subtitleContainer) return
  updateSubtitleGeometry()
  currentCueId = cue.id
  const orig = shadowRoot.getElementById('original')
  const trans = shadowRoot.getElementById('translation')
  if (orig) {
    orig.textContent = cue.original
    orig.style.display = displayMode === 'translation' && !!cue.translation ? 'none' : ''
  }
  if (trans) {
    trans.textContent = cue.translation ?? ''
    trans.style.display = displayMode === 'original' || !cue.translation ? 'none' : ''
  }

  const container = shadowRoot.querySelector('.hc-subtitle') as HTMLElement
  if (container) container.style.opacity = '1'

  if (clearTimer) clearTimeout(clearTimer)
  const duration = (cue.endTime - cue.startTime) || 6
  clearTimer = setTimeout(clearSubtitle, duration * 1000)
}

function clearSubtitle() {
  currentCueId = null
  if (!shadowRoot) return
  const orig = shadowRoot.getElementById('original')
  const trans = shadowRoot.getElementById('translation')
  if (orig) orig.textContent = ''
  if (trans) trans.textContent = ''

  const container = shadowRoot.querySelector('.hc-subtitle') as HTMLElement
  if (container) container.style.opacity = '0'
}

function applyDisplayMode(mode: SubtitleDisplayMode) {
  displayMode = mode
  if (!shadowRoot) return
  const orig = shadowRoot.getElementById('original')
  const trans = shadowRoot.getElementById('translation')
  const hasTranslation = !!trans?.textContent
  if (orig) orig.style.display = mode === 'translation' && hasTranslation ? 'none' : ''
  if (trans) trans.style.display = mode === 'original' || !hasTranslation ? 'none' : ''
}

function applyStyle(style: SubtitleStyle) {
  if (!subtitleContainer) return
  subtitleContainer.style.setProperty('--hc-trans-size', style.translationFontSize + 'px')
  subtitleContainer.style.setProperty('--hc-orig-size', style.originalFontSize + 'px')
  subtitleContainer.style.setProperty('--hc-bg-opacity', String(style.backgroundOpacity))
}

function loadSavedStyle() {
  chrome.storage.local.get('subtitleStyle', (data: Record<string, any>) => {
    if (data.subtitleStyle) applyStyle(data.subtitleStyle)
  })
}

// ── Fullscreen ──

function handleFullscreenChange() {
  if (!subtitleContainer || !currentVideo) return
  const parent = document.fullscreenElement ?? document.documentElement
  if (subtitleContainer.parentElement !== parent) parent.appendChild(subtitleContainer)
  updateSubtitleGeometry()
}

// ── TextTrack monitoring ──

function findBestTrack(video: HTMLVideoElement): TextTrack | null {
  const tracks = video.textTracks
  if (tracks.length === 0) return null

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]
    if ((t.kind === 'subtitles' || t.kind === 'captions') && t.mode === 'showing') return t
  }
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]
    if (t.kind === 'subtitles' || t.kind === 'captions') return t
  }
  return tracks[0]
}

function getTrackLangs(video: HTMLVideoElement): string[] {
  const langs: string[] = []
  const tracks = video.textTracks
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]
    if (t.kind === 'subtitles' || t.kind === 'captions') {
      langs.push(t.language || 'unknown')
    }
  }
  return langs
}

function startTextTrackMonitor() {
  if (!currentVideo || trackMonitorActive) return
  const track = findBestTrack(currentVideo)
  if (!track) return

  trackMonitorActive = true
  monitoredTrack = track

  // KEEP: set mode='hidden' so cuechange fires but browser doesn't render its own subtitles
  //       — 'disabled' stops events entirely; 'showing' double-renders
  if (track.mode === 'disabled') {
    track.mode = 'hidden'
  }

  track.addEventListener('cuechange', onCueChange)

  // Pre-send existing cues for batch translation
  if (track.cues && track.cues.length > 0) {
    const batch: Array<{ id: string; startTime: number; endTime: number; text: string }> = []
    for (let i = 0; i < track.cues.length; i++) {
      const c = track.cues[i] as VTTCue
      const text = c.text?.trim()
      if (text) {
        batch.push({ id: c.id || `tt-${i}`, startTime: c.startTime, endTime: c.endTime, text })
      }
    }
    if (batch.length > 0) {
      sendPageMessage({ type: 'texttrack:batch', data: { cues: batch } })
    }
  }

  console.log('[HearClear] TextTrack monitor started, track:', track.label || track.language || 'default')
}

function stopTextTrackMonitor() {
  if (monitoredTrack) {
    monitoredTrack.removeEventListener('cuechange', onCueChange)
    monitoredTrack = null
  }
  trackMonitorActive = false
  translationCache.clear()
}

function onCueChange() {
  if (!monitoredTrack?.activeCues || monitoredTrack.activeCues.length === 0) {
    clearSubtitle()
    return
  }

  const activeCue = monitoredTrack.activeCues[0] as VTTCue
  const text = activeCue.text?.trim()
  if (!text) return

  const cueId = activeCue.id || `tt-${activeCue.startTime}`
  const cached = translationCache.get(text)

  const cue: Cue = {
    id: cueId,
    startTime: activeCue.startTime,
    endTime: activeCue.endTime,
    original: text,
    translation: cached,
    source: 'texttrack',
  }

  showSubtitle(cue)

  if (!cached) {
    sendPageMessage({
      type: 'texttrack:cue',
      data: { id: cueId, startTime: activeCue.startTime, endTime: activeCue.endTime, text },
    })
  }
}

// ── Media event listeners ──

function attachMediaListeners(video: HTMLVideoElement) {
  const options = { signal: pageListeners.signal }
  window.addEventListener('scroll', updateSubtitleGeometry, { ...options, passive: true })
  window.addEventListener('resize', updateSubtitleGeometry, options)
  video.addEventListener('play', () => {
    sendPageMessage({ type: 'media:play' })
  }, options)

  video.addEventListener('pause', () => {
    sendPageMessage({ type: 'media:pause' })
  }, options)

  video.addEventListener('seeking', () => {
    sendPageMessage({ type: 'media:seeking' })
  }, options)

  video.addEventListener('ratechange', () => {
    sendPageMessage({
      type: 'media:ratechange',
      data: { playbackRate: video.playbackRate },
    })
  }, options)

  mediaTimer = setInterval(() => {
    if (!chrome.runtime.id) {
      stopInvalidatedScript()
      return
    }
    if (!video.paused) {
      sendPageMessage({
        type: 'media:timeupdate',
        data: {
          currentTime: video.currentTime,
          duration: video.duration || 0,
          paused: video.paused,
          playbackRate: video.playbackRate,
        },
      })
    }
  }, 500)
}

// ── Detect ──

function detectAndReport(video: HTMLVideoElement) {
  sendPageMessage({
    type: 'media:detected',
    data: {
      hasVideo: true,
      videoCount: document.querySelectorAll('video').length,
      hasTextTrack: video.textTracks.length > 0,
      trackLangs: getTrackLangs(video),
    },
  })
}

// ── Init ──

function init() {
  const video = findMainVideo()
  if (!video) {
    videoObserver = new MutationObserver(() => {
      if (!chrome.runtime.id) {
        stopInvalidatedScript()
        return
      }
      const v = findMainVideo()
      if (v) {
        videoObserver?.disconnect()
        setupVideo(v)
      }
    })
    videoObserver.observe(document.body, { childList: true, subtree: true })
    return
  }
  setupVideo(video)
}

function setupVideo(video: HTMLVideoElement) {
  currentVideo = video
  createSubtitleLayer(video)
  loadSavedStyle()
  attachMediaListeners(video)
  detectAndReport(video)

  video.textTracks.addEventListener('addtrack', () => {
    detectAndReport(video)
  }, { signal: pageListeners.signal })

  document.addEventListener('fullscreenchange', handleFullscreenChange, { signal: pageListeners.signal })

  console.log('[HearClear] Video detected:', video.src || video.currentSrc || '(blob)')
}

// ── Message handler ──

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (msg.type === 'session:state') {
    if (msg.data.generation !== currentGeneration) clearSubtitle()
    currentGeneration = msg.data.generation
    if (msg.data.state === 'stopped' || msg.data.state === 'error') clearSubtitle()
  }
  if (msg.type === 'subtitle:show') {
    const rendered = msg.data.generation === currentGeneration
    if (rendered) showSubtitle(msg.data.cue)
    console.info('[HearClear diagnostic]', JSON.stringify({
      event: 'subtitle-render', generation: msg.data.generation, currentGeneration,
      rendered, textLength: msg.data.cue.original?.length ?? 0,
      hostConnected: subtitleContainer?.isConnected === true,
      videoRect: currentVideo && (() => {
        const rect = currentVideo.getBoundingClientRect()
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      })(),
    }))
    sendResponse({ rendered })
    return
  }
  if (msg.type === 'subtitle:clear') {
    currentGeneration = msg.data.generation
    clearSubtitle()
  }
  if (msg.type === 'subtitle:displayMode') {
    applyDisplayMode(msg.data.mode)
    sendResponse({ ok: true })
    return
  }
  if (msg.type === 'subtitle:displayModeQuery') {
    sendResponse({ mode: displayMode })
    return
  }
  if (msg.type === 'subtitle:style') {
    applyStyle(msg.data)
  }
  if (msg.type === 'subtitle:translated') {
    translationCache.set(msg.data.id, msg.data.translation)
    if (shadowRoot && currentCueId === msg.data.id) {
      const orig = shadowRoot.getElementById('original')
      const trans = shadowRoot.getElementById('translation')
      if (orig) orig.style.display = displayMode === 'translation' ? 'none' : ''
      if (trans && displayMode !== 'original') {
        trans.textContent = msg.data.translation
        trans.style.display = ''
      }
    }
  }
  if (msg.type === 'session:startSubtitle') {
    startTextTrackMonitor()
    sendResponse({ ok: true })
  }
  if (msg.type === 'session:stopSubtitle') {
    stopTextTrackMonitor()
    clearSubtitle()
    sendResponse({ ok: true })
  }
  if (msg.type === 'media:detect') {
    if (currentVideo) {
      detectAndReport(currentVideo)
    }
    sendResponse({ hasVideo: !!currentVideo, hasTextTrack: (currentVideo?.textTracks.length ?? 0) > 0 })
    return
  }
})

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.subtitleStyle?.newValue) {
    applyStyle(changes.subtitleStyle.newValue as SubtitleStyle)
  }
})

console.log('[HearClear] Content script loaded')

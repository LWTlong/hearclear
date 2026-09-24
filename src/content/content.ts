import type { Cue, SubtitleDisplayMode, SubtitleStyle } from '../shared/types'

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
  host.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;'

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

  const parent = video.parentElement
  if (parent) {
    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative'
    }
    parent.appendChild(host)
  }
}

function showSubtitle(cue: Cue) {
  if (!shadowRoot) return
  const orig = shadowRoot.getElementById('original')
  const trans = shadowRoot.getElementById('translation')
  if (orig) {
    orig.textContent = cue.original
    orig.style.display = displayMode === 'translation' ? 'none' : ''
  }
  if (trans) {
    trans.textContent = cue.translation ?? ''
    trans.style.display = displayMode === 'original' ? 'none' : ''
  }

  const container = shadowRoot.querySelector('.hc-subtitle') as HTMLElement
  if (container) container.style.opacity = '1'

  if (clearTimer) clearTimeout(clearTimer)
  const duration = (cue.endTime - cue.startTime) || 6
  clearTimer = setTimeout(clearSubtitle, duration * 1000)
}

function clearSubtitle() {
  if (!shadowRoot) return
  const orig = shadowRoot.getElementById('original')
  const trans = shadowRoot.getElementById('translation')
  if (orig) orig.textContent = ''
  if (trans) trans.textContent = ''

  const container = shadowRoot.querySelector('.hc-subtitle') as HTMLElement
  if (container) container.style.opacity = '0'
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
  const fsEl = document.fullscreenElement
  if (fsEl) {
    // Move subtitle layer into the fullscreen container
    if (fsEl.contains(currentVideo) || fsEl === currentVideo) {
      if (fsEl !== currentVideo) {
        if (getComputedStyle(fsEl).position === 'static') {
          (fsEl as HTMLElement).style.position = 'relative'
        }
        fsEl.appendChild(subtitleContainer)
      }
    }
  } else {
    // Return to video parent
    const parent = currentVideo.parentElement
    if (parent && !parent.contains(subtitleContainer)) {
      parent.appendChild(subtitleContainer)
    }
  }
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
      chrome.runtime.sendMessage({ type: 'texttrack:batch', data: { cues: batch } }).catch(() => {})
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
    chrome.runtime.sendMessage({
      type: 'texttrack:cue',
      data: { id: cueId, startTime: activeCue.startTime, endTime: activeCue.endTime, text },
    }).catch(() => {})
  }
}

// ── Media event listeners ──

function attachMediaListeners(video: HTMLVideoElement) {
  video.addEventListener('play', () => {
    chrome.runtime.sendMessage({ type: 'media:play' }).catch(() => {})
  })

  video.addEventListener('pause', () => {
    chrome.runtime.sendMessage({ type: 'media:pause' }).catch(() => {})
  })

  video.addEventListener('seeking', () => {
    chrome.runtime.sendMessage({ type: 'media:seeking' }).catch(() => {})
  })

  video.addEventListener('ratechange', () => {
    chrome.runtime.sendMessage({
      type: 'media:ratechange',
      data: { playbackRate: video.playbackRate },
    }).catch(() => {})
  })

  setInterval(() => {
    if (!video.paused) {
      chrome.runtime.sendMessage({
        type: 'media:timeupdate',
        data: {
          currentTime: video.currentTime,
          duration: video.duration || 0,
          paused: video.paused,
          playbackRate: video.playbackRate,
        },
      }).catch(() => {})
    }
  }, 500)
}

// ── Detect ──

function detectAndReport(video: HTMLVideoElement) {
  chrome.runtime.sendMessage({
    type: 'media:detected',
    data: {
      hasVideo: true,
      videoCount: document.querySelectorAll('video').length,
      hasTextTrack: video.textTracks.length > 0,
      trackLangs: getTrackLangs(video),
    },
  }).catch(() => {})
}

// ── Init ──

function init() {
  const video = findMainVideo()
  if (!video) {
    const observer = new MutationObserver(() => {
      const v = findMainVideo()
      if (v) {
        observer.disconnect()
        setupVideo(v)
      }
    })
    observer.observe(document.body, { childList: true, subtree: true })
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
  })

  document.addEventListener('fullscreenchange', handleFullscreenChange)

  console.log('[HearClear] Video detected:', video.src || video.currentSrc || '(blob)')
}

// ── Message handler ──

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (msg.type === 'subtitle:show') {
    if (msg.data.generation === currentGeneration) {
      showSubtitle(msg.data.cue)
    }
  }
  if (msg.type === 'subtitle:clear') {
    currentGeneration = msg.data.generation
    clearSubtitle()
  }
  if (msg.type === 'subtitle:displayMode') {
    displayMode = msg.data.mode
  }
  if (msg.type === 'subtitle:style') {
    applyStyle(msg.data)
  }
  if (msg.type === 'subtitle:translated') {
    translationCache.set(msg.data.id, msg.data.translation)
    // If the currently displayed cue matches, update it
    if (shadowRoot) {
      const orig = shadowRoot.getElementById('original')
      if (orig?.textContent === msg.data.id || translationCache.has(orig?.textContent ?? '')) {
        const trans = shadowRoot.getElementById('translation')
        if (trans && displayMode !== 'original') {
          trans.textContent = translationCache.get(orig?.textContent ?? '') ?? msg.data.translation
        }
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

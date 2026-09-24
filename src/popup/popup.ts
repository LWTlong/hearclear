import { DEFAULT_ASR_CONFIG, getCachedProfile, getProfileLabel, normalizeModelId } from '../shared/asr'
import type { AsrConfig, Cue, SubtitleDisplayMode } from '../shared/types'

const btnStart = document.getElementById('btn-start') as HTMLButtonElement
const statusEl = document.getElementById('status')!
const statusDetail = document.getElementById('status-detail')!
const workModeEl = document.getElementById('work-mode') as HTMLSelectElement
const srcLangEl = document.getElementById('src-lang') as HTMLSelectElement
const tgtLangEl = document.getElementById('tgt-lang') as HTMLSelectElement
const settingsLink = document.getElementById('settings-link')!
const btnSidePanel = document.getElementById('btn-sidepanel')!

const modelDot = document.getElementById('model-dot')!
const modelText = document.getElementById('model-text')!
const modelProgressWrap = document.getElementById('model-progress-wrap')!
const modelProgressFill = document.getElementById('model-progress-fill')!
const modelPct = document.getElementById('model-pct')!
const captionPanel = document.getElementById('caption-panel')!
const captionEmpty = document.getElementById('caption-empty')!

let isRunning = false
let selectedModelId = DEFAULT_ASR_CONFIG.modelId
let selectedDevice = DEFAULT_ASR_CONFIG.device
let displayMode: SubtitleDisplayMode = 'bilingual'
const captions = new Map<string, Cue>()

function renderCaptions() {
  captionPanel.replaceChildren()
  const visible = [...captions.values()]
  if (visible.length === 0) {
    captionPanel.appendChild(captionEmpty)
    captionEmpty.textContent = isRunning ? '等待识别结果...' : '识别结果将在这里显示'
    return
  }
  for (const cue of visible) {
    const item = document.createElement('div')
    item.className = 'caption-item'
    if (displayMode !== 'translation' || !cue.translation) {
      const original = document.createElement('div')
      original.className = 'caption-original'
      original.textContent = cue.original
      item.appendChild(original)
    }
    if (displayMode !== 'original' && cue.translation) {
      const translation = document.createElement('div')
      translation.className = 'caption-translation'
      translation.textContent = cue.translation
      item.appendChild(translation)
    }
    captionPanel.appendChild(item)
  }
  captionPanel.scrollTop = captionPanel.scrollHeight
}

function updateCaption(cue: Cue) {
  captions.set(cue.id, cue)
  while (captions.size > 50) captions.delete(captions.keys().next().value!)
  renderCaptions()
}

// ── Total download progress tracking ──
let totalBytesMap = new Map<string, { loaded: number; total: number }>()

function computeTotalProgress(): number {
  let loaded = 0, total = 0
  totalBytesMap.forEach(v => { loaded += v.loaded; total += v.total })
  return total > 0 ? Math.round((loaded / total) * 100) : 0
}

// ── State labels ──
const stateLabels: Record<string, string> = {
  idle: '未启动',
  detecting: '检测中...',
  subtitle_mode: '正在翻译字幕',
  asr_mode: '正在识别声音',
  error: '出错',
  stopped: '已停止',
}

function updateUI(state: string, detail?: string) {
  statusEl.textContent = state
  statusEl.className = 'status-text'
  statusDetail.textContent = detail ?? ''

  if (state.includes('识别') || state.includes('翻译') || state.includes('检测')) {
    statusEl.classList.add('active')
    btnStart.textContent = '停止'
    btnStart.className = 'btn btn-stop'
    isRunning = true
  } else if (state.includes('错误') || state.includes('失败') || state.includes('出错') || state.includes('未检测') || state.includes('未找到')) {
    statusEl.classList.add('error')
    btnStart.textContent = '重试'
    btnStart.className = 'btn btn-primary'
    isRunning = false
  } else {
    btnStart.textContent = '开始翻译'
    btnStart.className = 'btn btn-primary'
    isRunning = false
  }
  if (captions.size === 0) renderCaptions()
}

function updateModelUI(dotClass: string, text: string, progress?: number) {
  modelDot.className = 'dot ' + dotClass
  modelText.textContent = text
  if (progress !== undefined && progress < 100) {
    modelProgressWrap.classList.add('show')
    modelProgressFill.style.width = progress + '%'
    modelPct.style.display = ''
    modelPct.textContent = progress + '%'
  } else {
    modelProgressWrap.classList.remove('show')
    modelPct.style.display = 'none'
  }
}

// ── Init: query session ──
chrome.runtime.sendMessage({ type: 'session:query' }, (resp) => {
  if (resp?.session) {
    const s = resp.session
    updateUI(stateLabels[s.state] ?? s.state, s.detail)
    workModeEl.value = s.workMode
    srcLangEl.value = s.sourceLang
  }
  for (const cue of resp?.captions ?? []) updateCaption(cue)
  if (!resp?.captions?.length) renderCaptions()
})

// Check if model is cached
async function checkModelCached() {
  try {
    const { asrConfig } = await chrome.storage.local.get('asrConfig')
    selectedModelId = normalizeModelId((asrConfig as AsrConfig | undefined)?.modelId ?? DEFAULT_ASR_CONFIG.modelId)
    selectedDevice = (asrConfig as AsrConfig | undefined)?.device ?? DEFAULT_ASR_CONFIG.device
    const cache = await caches.open('transformers-cache')
    const keys = await cache.keys()
    const profile = getCachedProfile(keys.map(r => r.url), selectedModelId, selectedDevice)
    if (profile) {
      updateModelUI('dot-ok', `${selectedModelId.split('/').pop()} / ${getProfileLabel(profile)} 已缓存（启动时加载）`)
    } else {
      updateModelUI('dot-none', '所选模型未完整缓存 — 请在设置中下载')
    }
  } catch {
    updateModelUI('dot-none', '无法检测模型缓存')
  }
}
checkModelCached()
chrome.storage.onChanged.addListener(changes => {
  if (changes.asrConfig) checkModelCached()
})

// ── Controls ──
btnStart.addEventListener('click', () => {
  if (isRunning) {
    chrome.runtime.sendMessage({ type: 'session:stop' })
    updateUI('已停止')
    return
  }

  const mode = workModeEl.value
  chrome.runtime.sendMessage({
    type: 'session:start',
    data: {
      workMode: mode,
      sourceLang: srcLangEl.value,
      targetLang: tgtLangEl.value,
    },
  }).then(resp => {
    if (!resp?.ok) updateUI('启动失败', resp?.error ?? '后台未响应')
  }).catch(err => updateUI('启动失败', err.message))
  updateUI('检测中...')
})

settingsLink.addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
})

// Hide "侧栏" button if already in side panel (side panel has wider viewport)
if (window.innerWidth > 350) {
  btnSidePanel.style.display = 'none'
}

btnSidePanel.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.windowId !== undefined) {
      await (chrome.sidePanel as any).open({ windowId: tab.windowId })
      window.close()
    }
  } catch (err) {
    console.error('[HearClear] Side panel failed:', err)
  }
})

// ── Display mode ──
chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  if (!tabs[0]?.id) return
  chrome.tabs.sendMessage(tabs[0].id, { type: 'subtitle:displayModeQuery' }, response => {
    if (chrome.runtime.lastError || !response?.mode) return
    displayMode = response.mode
    renderCaptions()
    const radio = document.querySelector(`input[name="display"][value="${response.mode}"]`) as HTMLInputElement | null
    if (radio) radio.checked = true
  })
})

document.querySelectorAll('input[name="display"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    const mode = (e.target as HTMLInputElement).value as SubtitleDisplayMode
    displayMode = mode
    renderCaptions()
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'subtitle:displayMode', data: { mode } }).catch(() => {})
      }
    })
  })
})

// ── Message listener ──
chrome.runtime.onMessage.addListener((msg: any) => {
  if (msg.type === 'caption:update') updateCaption(msg.data.cue)
  if (msg.type === 'caption:clear') {
    captions.clear()
    renderCaptions()
  }
  if (msg.type === 'session:state') {
    updateUI(stateLabels[msg.data.state] ?? msg.data.state, msg.data.detail)
  }
  if (msg.type === 'model:progress') {
    if (!msg.data.file) {
      totalBytesMap.clear()
      updateModelUI('dot-loading', msg.data.status ?? '正在加载模型...', 0)
      return
    }
    const file = msg.data.file ?? msg.data.status ?? ''
    const loaded = msg.data.loaded ?? 0
    const total = msg.data.total ?? 0
    if (file && total > 0) {
      totalBytesMap.set(file, { loaded, total })
    }
    const pct = computeTotalProgress()
    const shortFile = file.split('/').pop() ?? ''
    updateModelUI('dot-loading', msg.data.status ?? `加载中: ${shortFile}`, pct)
  }
  if (msg.type === 'model:ready') {
    totalBytesMap.clear()
    const compatibleLegacy = selectedDevice === 'webgpu' && msg.data.device === 'wasm' && msg.data.profile === 'q8'
    if (msg.data.modelId === selectedModelId && (msg.data.device === selectedDevice || compatibleLegacy)) {
      updateModelUI('dot-ok', `${msg.data.modelId.split('/').pop()} / ${msg.data.profileLabel} / ${msg.data.device.toUpperCase()} 已加载`)
    } else {
      checkModelCached()
    }
  }
  if (msg.type === 'model:error') {
    updateModelUI('dot-error', '模型加载失败')
  }
})

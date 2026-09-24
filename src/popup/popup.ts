export {}

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

let isRunning = false
let modelReady = false

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
  } else if (state.includes('错误') || state.includes('失败') || state.includes('未检测') || state.includes('未找到')) {
    statusEl.classList.add('error')
    btnStart.textContent = '重试'
    btnStart.className = 'btn btn-primary'
    isRunning = false
  } else {
    btnStart.textContent = '开始翻译'
    btnStart.className = 'btn btn-primary'
    isRunning = false
  }
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
})

// Check if model is cached
async function checkModelCached() {
  try {
    const cache = await caches.open('transformers-cache')
    const keys = await cache.keys()
    const hasModel = keys.some(r => r.url.includes('whisper'))
    if (hasModel) {
      modelReady = true
      updateModelUI('dot-ok', '模型就绪')
    } else {
      updateModelUI('dot-none', '模型未下载 — 请先在设置中下载')
    }
  } catch {
    updateModelUI('dot-none', '模型未下载')
  }
}
checkModelCached()

// ── Controls ──
btnStart.addEventListener('click', () => {
  if (isRunning) {
    chrome.runtime.sendMessage({ type: 'session:stop' })
    updateUI('已停止')
    return
  }

  const mode = workModeEl.value
  if ((mode === 'asr_only' || mode === 'auto') && !modelReady) {
    updateUI('模型未下载', '请先在设置页下载 Whisper 模型')
    return
  }

  chrome.runtime.sendMessage({
    type: 'session:start',
    data: {
      workMode: mode,
      sourceLang: srcLangEl.value,
      targetLang: tgtLangEl.value,
    },
  })
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
document.querySelectorAll('input[name="display"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    const mode = (e.target as HTMLInputElement).value
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'subtitle:displayMode', data: { mode } })
      }
    })
  })
})

// ── Message listener ──
chrome.runtime.onMessage.addListener((msg: any) => {
  if (msg.type === 'session:state') {
    updateUI(stateLabels[msg.data.state] ?? msg.data.state, msg.data.detail)
  }
  if (msg.type === 'model:progress') {
    const file = msg.data.file ?? msg.data.status ?? ''
    const loaded = msg.data.loaded ?? 0
    const total = msg.data.total ?? 0
    if (file && total > 0) {
      totalBytesMap.set(file, { loaded, total })
    }
    const pct = computeTotalProgress()
    const shortFile = file.split('/').pop() ?? ''
    updateModelUI('dot-loading', `下载中: ${shortFile}`, pct)
  }
  if (msg.type === 'model:ready') {
    modelReady = true
    totalBytesMap.clear()
    updateModelUI('dot-ok', `${msg.data.modelId.split('/').pop()} 就绪`)
  }
  if (msg.type === 'model:error') {
    updateModelUI('dot-error', '模型加载失败')
  }
})

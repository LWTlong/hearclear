export {}

// ── Elements ──

const apiUrl = document.getElementById('api-url') as HTMLInputElement
const apiKey = document.getElementById('api-key') as HTMLInputElement
const apiModel = document.getElementById('api-model') as HTMLInputElement
const apiTimeout = document.getElementById('api-timeout') as HTMLInputElement
const asrDevice = document.getElementById('asr-device') as HTMLSelectElement
const btnTest = document.getElementById('btn-test') as HTMLButtonElement
const btnSave = document.getElementById('btn-save') as HTMLButtonElement
const btnDownload = document.getElementById('btn-download') as HTMLButtonElement
const btnDeleteCache = document.getElementById('btn-delete-cache') as HTMLButtonElement
const testResult = document.getElementById('test-result')!
const modelResult = document.getElementById('model-result')!
const saveMsg = document.getElementById('save-msg')!

const styleTransSize = document.getElementById('style-trans-size') as HTMLInputElement
const styleOrigSize = document.getElementById('style-orig-size') as HTMLInputElement
const styleBgOpacity = document.getElementById('style-bg-opacity') as HTMLInputElement
const valTransSize = document.getElementById('val-trans-size')!
const valOrigSize = document.getElementById('val-orig-size')!
const valBgOpacity = document.getElementById('val-bg-opacity')!
const previewOrig = document.getElementById('preview-orig')!
const previewTrans = document.getElementById('preview-trans')!

const diagWebgpu = document.getElementById('diag-webgpu')!
const diagCache = document.getElementById('diag-cache')!
const diagApi = document.getElementById('diag-api')!

const MODELS = [
  { id: 'onnx-community/whisper-tiny', key: 'tiny' },
  { id: 'onnx-community/whisper-small', key: 'small' },
  { id: 'onnx-community/whisper-base', key: 'base' },
]

// ── Load saved config ──

chrome.storage.local.get(['translationConfig', 'asrConfig', 'subtitleStyle'], (data: Record<string, any>) => {
  const t = data.translationConfig
  if (t) {
    apiUrl.value = t.baseUrl ?? ''
    apiKey.value = t.apiKey ?? ''
    apiModel.value = t.modelId ?? 'gpt-4o-mini'
    apiTimeout.value = String(t.timeout ?? 30)
    diagApi.textContent = t.baseUrl ? `已配置: ${t.baseUrl}` : '未配置'
  }
  const a = data.asrConfig
  if (a) {
    asrDevice.value = a.device ?? 'webgpu'
    const radio = document.querySelector(`input[name="asr-model"][value="${a.modelId}"]`) as HTMLInputElement | null
    if (radio) radio.checked = true
  }
  const s = data.subtitleStyle
  if (s) {
    styleTransSize.value = String(s.translationFontSize ?? 18)
    styleOrigSize.value = String(s.originalFontSize ?? 14)
    styleBgOpacity.value = String(Math.round((s.backgroundOpacity ?? 0.7) * 100))
    updateStylePreview()
  }
})

// ── Translation test (request host permission first) ──

async function requestHostPermission(url: string): Promise<boolean> {
  try {
    const origin = new URL(url).origin + '/*'
    return await chrome.permissions.request({ origins: [origin] })
  } catch {
    return false
  }
}

btnTest.addEventListener('click', async () => {
  if (!apiUrl.value || !apiKey.value) {
    testResult.textContent = '请先填写 API 地址和 Key'
    testResult.className = 'result-box fail'
    return
  }

  btnTest.disabled = true
  btnTest.textContent = '测试中...'
  testResult.textContent = '测试中...'
  testResult.className = 'result-box info'

  const granted = await requestHostPermission(apiUrl.value)
  if (!granted) {
    btnTest.disabled = false
    btnTest.textContent = '测试连接'
    testResult.textContent = '需要授权访问该域名才能测试'
    testResult.className = 'result-box fail'
    return
  }

  chrome.runtime.sendMessage({
    type: 'translate:test',
    data: { baseUrl: apiUrl.value, apiKey: apiKey.value, modelId: apiModel.value || 'gpt-4o-mini' },
  }, (resp) => {
    btnTest.disabled = false
    btnTest.textContent = '测试连接'
    if (chrome.runtime.lastError) {
      testResult.textContent = `失败: ${chrome.runtime.lastError.message}`
      testResult.className = 'result-box fail'
      return
    }
    if (resp?.success) {
      testResult.textContent = `连接成功 (${resp.elapsed}ms): ${resp.result}`
      testResult.className = 'result-box ok'
    } else {
      testResult.textContent = `失败: ${resp?.error ?? '未知错误'}`
      testResult.className = 'result-box fail'
    }
  })
})

// ── Model cache detection ──

async function checkModelCache() {
  try {
    const cache = await caches.open('transformers-cache')
    const keys = await cache.keys()
    const urls = keys.map(r => r.url)

    let totalSize = 0
    for (const model of MODELS) {
      const el = document.getElementById(`status-${model.key}`)!
      const matched = urls.filter(u => u.includes(model.id))
      if (matched.length > 0) {
        el.textContent = '已下载'
        el.className = 'status status-cached'
        for (const url of matched) {
          const resp = await cache.match(url)
          if (resp) {
            const blob = await resp.blob()
            totalSize += blob.size
          }
        }
      } else {
        el.textContent = '未下载'
        el.className = 'status status-none'
      }
    }

    diagCache.textContent = totalSize > 0
      ? `已缓存 ${(totalSize / 1024 / 1024).toFixed(0)} MB`
      : '无缓存'
  } catch {
    for (const model of MODELS) {
      const el = document.getElementById(`status-${model.key}`)!
      el.textContent = '无法检测'
      el.className = 'status status-none'
    }
    diagCache.textContent = '无法访问'
  }
}

checkModelCache()

// ── Model download (trigger via service worker → offscreen) ──

let downloading = false
let totalBytesMap = new Map<string, { loaded: number; total: number }>()

function computeTotalProgress(): number {
  let loaded = 0, total = 0
  totalBytesMap.forEach(v => { loaded += v.loaded; total += v.total })
  return total > 0 ? Math.round((loaded / total) * 100) : 0
}

btnDownload.addEventListener('click', () => {
  if (downloading) return
  downloading = true
  totalBytesMap.clear()

  const selectedModel = (document.querySelector('input[name="asr-model"]:checked') as HTMLInputElement)?.value
    ?? 'onnx-community/whisper-small'

  btnDownload.disabled = true
  btnDownload.textContent = '下载中...'
  modelResult.textContent = '正在创建下载环境...'
  modelResult.className = 'result-box info'

  chrome.runtime.sendMessage({
    type: 'model:download',
    data: { modelId: selectedModel, device: asrDevice.value },
  })
})

chrome.runtime.onMessage.addListener((msg: any) => {
  if (msg.type === 'model:progress') {
    const file: string = msg.data.file ?? msg.data.status ?? ''
    const loaded = msg.data.loaded ?? 0
    const total = msg.data.total ?? 0

    if (file && total > 0) {
      totalBytesMap.set(file, { loaded, total })
    }
    const pct = computeTotalProgress()
    const shortFile = file.split('/').pop() ?? ''

    modelResult.textContent = `下载中: ${shortFile} — 总进度 ${pct}%`
    modelResult.className = 'result-box info'
    btnDownload.textContent = `下载中 ${pct}%`

    // Update the specific model status
    for (const model of MODELS) {
      if (file.includes(model.id)) {
        const el = document.getElementById(`status-${model.key}`)!
        el.textContent = `${pct}%`
        el.className = 'status status-loading'
      }
    }
  }

  if (msg.type === 'model:ready') {
    downloading = false
    totalBytesMap.clear()
    btnDownload.disabled = false
    btnDownload.textContent = '下载选中模型'
    modelResult.textContent = `模型 ${msg.data.modelId} 下载完成`
    modelResult.className = 'result-box ok'
    checkModelCache()
  }

  if (msg.type === 'model:error') {
    downloading = false
    totalBytesMap.clear()
    btnDownload.disabled = false
    btnDownload.textContent = '下载选中模型'
    modelResult.textContent = `下载失败: ${msg.data.message}`
    modelResult.className = 'result-box fail'
  }
})

btnDeleteCache.addEventListener('click', async () => {
  if (!confirm('确定清除所有已下载的模型？')) return
  try {
    await caches.delete('transformers-cache')
    modelResult.textContent = '已清除模型缓存'
    modelResult.className = 'result-box info'
    checkModelCache()
  } catch (err: any) {
    modelResult.textContent = `清除失败: ${err.message}`
    modelResult.className = 'result-box fail'
  }
})

// ── Style preview ──

function updateStylePreview() {
  const ts = parseInt(styleTransSize.value)
  const os = parseInt(styleOrigSize.value)
  const bg = parseInt(styleBgOpacity.value)

  valTransSize.textContent = ts + 'px'
  valOrigSize.textContent = os + 'px'
  valBgOpacity.textContent = bg + '%'

  previewTrans.style.fontSize = ts + 'px'
  previewOrig.style.fontSize = os + 'px'
  const preview = document.querySelector('.subtitle-preview') as HTMLElement
  if (preview) preview.style.background = `rgba(26,30,46,${bg / 100})`
}

styleTransSize.addEventListener('input', updateStylePreview)
styleOrigSize.addEventListener('input', updateStylePreview)
styleBgOpacity.addEventListener('input', updateStylePreview)
updateStylePreview()

// ── WebGPU detection ──

async function checkWebGPU() {
  if (!('gpu' in navigator)) {
    diagWebgpu.textContent = '不支持（将使用 WASM）'
    return
  }
  try {
    const adapter = await (navigator as any).gpu.requestAdapter()
    if (adapter) {
      const info = await adapter.requestAdapterInfo?.() ?? {}
      diagWebgpu.textContent = `支持 (${info.description || info.device || 'GPU'})`
    } else {
      diagWebgpu.textContent = '不支持（将使用 WASM）'
    }
  } catch {
    diagWebgpu.textContent = '检测失败'
  }
}

checkWebGPU()

// ── Save ──

btnSave.addEventListener('click', () => {
  const selectedModel = (document.querySelector('input[name="asr-model"]:checked') as HTMLInputElement)?.value
    ?? 'onnx-community/whisper-small'

  chrome.storage.local.set({
    translationConfig: {
      baseUrl: apiUrl.value,
      apiKey: apiKey.value,
      modelId: apiModel.value || 'gpt-4o-mini',
      timeout: parseInt(apiTimeout.value) || 30,
      maxConcurrency: 1,
    },
    asrConfig: {
      modelId: selectedModel,
      device: asrDevice.value,
      language: 'en',
    },
    subtitleStyle: {
      translationFontSize: parseInt(styleTransSize.value),
      originalFontSize: parseInt(styleOrigSize.value),
      backgroundOpacity: parseInt(styleBgOpacity.value) / 100,
      position: 8,
    },
  }, () => {
    saveMsg.style.display = 'inline'
    diagApi.textContent = apiUrl.value ? `已配置: ${apiUrl.value}` : '未配置'
    setTimeout(() => { saveMsg.style.display = 'none' }, 2000)
  })
})

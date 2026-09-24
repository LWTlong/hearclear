export type SessionState =
  | 'idle'
  | 'detecting'
  | 'subtitle_mode'
  | 'asr_mode'
  | 'error'
  | 'stopped'

export type SubtitleDisplayMode = 'bilingual' | 'translation' | 'original'
export type WorkMode = 'auto' | 'subtitle_only' | 'asr_only'

export interface Cue {
  id: string
  startTime: number
  endTime: number
  original: string
  translation?: string
  source: 'texttrack' | 'asr'
}

export interface SessionInfo {
  sessionId: string
  generation: number
  tabId: number
  state: SessionState
  detail?: string
  workMode: WorkMode
  sourceLang: string
  targetLang: string
}

export interface TranslationConfig {
  baseUrl: string
  apiKey: string
  modelId: string
  timeout: number
  maxConcurrency: number
}

export interface AsrConfig {
  modelId: string
  device: 'webgpu' | 'wasm'
  language: string
}

export interface SubtitleStyle {
  translationFontSize: number
  originalFontSize: number
  backgroundOpacity: number
  position: number
}

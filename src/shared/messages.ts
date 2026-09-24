import type { Cue, SessionInfo, SubtitleDisplayMode, SubtitleStyle } from './types'

// Content Script → Service Worker
export type ContentMessage =
  | { type: 'media:detected'; data: { hasVideo: boolean; videoCount: number; hasTextTrack: boolean; trackLangs: string[] } }
  | { type: 'media:timeupdate'; data: { currentTime: number; duration: number; paused: boolean; playbackRate: number } }
  | { type: 'media:seeking' }
  | { type: 'media:play' }
  | { type: 'media:pause' }
  | { type: 'media:ratechange'; data: { playbackRate: number } }
  | { type: 'texttrack:cue'; data: { id: string; startTime: number; endTime: number; text: string } }
  | { type: 'texttrack:batch'; data: { cues: Array<{ id: string; startTime: number; endTime: number; text: string }> } }

// Service Worker → Content Script
export type BackgroundToContentMessage =
  | { type: 'session:state'; data: SessionInfo }
  | { type: 'session:startSubtitle' }
  | { type: 'session:stopSubtitle' }
  | { type: 'subtitle:show'; data: { cue: Cue; generation: number } }
  | { type: 'subtitle:clear'; data: { generation: number } }
  | { type: 'subtitle:displayMode'; data: { mode: SubtitleDisplayMode } }
  | { type: 'subtitle:displayModeQuery' }
  | { type: 'subtitle:style'; data: SubtitleStyle }
  | { type: 'subtitle:translated'; data: { id: string; translation: string } }

// Service Worker → Offscreen
export type BackgroundToOffscreenMessage =
  | { type: 'audio:start'; data: { streamId: string; sessionId: string; language: string } }
  | { type: 'audio:stop' }
  | { type: 'offscreen:ping' }
  | { type: 'asr:configure'; data: { modelId: string; device: 'webgpu' | 'wasm'; profile: 'webgpu-mixed' | 'q8'; allowDownload: boolean; requestId?: string } }

export type OffscreenResponse = { ok: true } | { ok: false; error: string }

// Offscreen → Service Worker
export type OffscreenMessage =
  | { type: 'asr:ready' }
  | { type: 'asr:status'; data: { sessionId: string; phase: 'capturing' | 'processing' | 'complete'; detail: string; hasAudio: boolean } }
  | { type: 'asr:result'; data: { text: string; startTime: number; endTime: number; isFinal: boolean; sessionId: string } }
  | { type: 'asr:error'; data: { message: string; sessionId: string } }
  | { type: 'audio:level'; data: { level: number } }
  | { type: 'model:progress'; data: { loaded: number; total: number; status: string } }
  | { type: 'model:ready'; data: { modelId: string; device: 'webgpu' | 'wasm'; profile: 'webgpu-mixed' | 'q8'; profileLabel: string; requestId?: string } }
  | { type: 'model:error'; data: { message: string; requestId?: string } }

// Popup → Service Worker
export type PopupMessage =
  | { type: 'session:start'; data: { workMode: string; sourceLang: string; targetLang: string } }
  | { type: 'session:stop' }
  | { type: 'session:query' }
  | { type: 'translate:test'; data: { baseUrl: string; apiKey: string; modelId: string } }

export type Message = ContentMessage | BackgroundToContentMessage | BackgroundToOffscreenMessage | OffscreenMessage | PopupMessage

export function sendToBackground(msg: ContentMessage | OffscreenMessage | PopupMessage): Promise<any> {
  return chrome.runtime.sendMessage(msg)
}

export function sendToTab(tabId: number, msg: BackgroundToContentMessage): Promise<any> {
  return chrome.tabs.sendMessage(tabId, msg)
}

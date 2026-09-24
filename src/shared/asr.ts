import type { AsrConfig } from './types'

export type AsrProfile = 'webgpu-mixed' | 'q8'
export type AsrDtype = 'q8' | { encoder_model: 'fp32'; decoder_model_merged: 'q4' }

export const DEFAULT_ASR_CONFIG: AsrConfig = {
  modelId: 'onnx-community/whisper-small',
  device: 'webgpu',
  language: 'en',
}

export function normalizeModelId(modelId: string): string {
  return modelId === 'onnx-community/whisper-medium' ? 'onnx-community/whisper-medium-ONNX' : modelId
}

export function getPreferredProfile(device: AsrConfig['device']): AsrProfile {
  return device === 'webgpu' ? 'webgpu-mixed' : 'q8'
}

export function getProfileDtype(profile: AsrProfile): AsrDtype {
  return profile === 'webgpu-mixed'
    ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
    : 'q8'
}

export function getProfileLabel(profile: AsrProfile): string {
  return profile === 'webgpu-mixed' ? 'FP32/Q4' : 'Q8'
}

export function getProfileModelFiles(profile: AsrProfile): string[] {
  return profile === 'webgpu-mixed'
    ? ['onnx/encoder_model.onnx', 'onnx/decoder_model_merged_q4.onnx']
    : ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx']
}

export function hasModelFiles(urls: string[], modelId: string, profile: AsrProfile): boolean {
  const modelFiles = getProfileModelFiles(profile)
  const files = [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'preprocessor_config.json',
    ...modelFiles,
  ]
  const paths = new Set(urls.map(url => new URL(url).pathname))
  return files.every(file => paths.has(`/${modelId}/resolve/main/${file}`))
}

export function getCachedProfile(
  urls: string[],
  modelId: string,
  device: AsrConfig['device'],
): AsrProfile | null {
  const preferred = getPreferredProfile(device)
  if (hasModelFiles(urls, modelId, preferred)) return preferred
  if (preferred !== 'q8' && hasModelFiles(urls, modelId, 'q8')) return 'q8'
  return null
}

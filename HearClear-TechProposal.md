# HearClear 首版技术方案

版本：v0.1 Draft  
日期：2026-09-24  
状态：待确认  
基准硬件：M3 Pro 14GPU / RTX 2060

---

## 1. 整体架构

Manifest V3 Chrome 扩展，四个运行环境通过消息总线协作。

```
Content Script (每个标签页)
  ├─ 发现播放器、监听媒体事件 (play/pause/seek/ratechange)
  ├─ 读取 TextTrack / VTT 字幕
  ├─ 渲染字幕层 (Shadow DOM，隔离页面 CSS)
  └─ 上报媒体时间轴 → Service Worker

Service Worker (扩展后台，非常驻)
  ├─ 会话状态机 + sessionId/generation 管理
  ├─ tabCapture.getMediaStreamId() → 传给 Offscreen
  ├─ 翻译请求调度 (批量、去重、限流、缓存)
  ├─ 配置 & 权限管理 (chrome.storage.local)
  └─ 消息路由：Content ↔ Offscreen ↔ Popup

Offscreen Document (隐藏后台页)
  ├─ 接收 streamId → getUserMedia() 获取音频流
  ├─ AudioContext：原声回放 + 分流给 ASR
  ├─ 音频重采样 (16kHz mono) + VAD 分段
  └─ 传递音频片段 → ASR Worker

ASR Worker (Web Worker / Offscreen 内)
  ├─ onnxruntime-web (WASM 打包 / WebGPU)
  ├─ Whisper 模型推理
  └─ 返回带时间戳的 cue → Service Worker → Content Script
```

### 1.1 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3 + Vite | Popup 和设置页；Content Script 纯 TS，不引入框架 |
| 语言 | TypeScript | 全项目统一 |
| ASR 运行时 | onnxruntime-web | .js/.wasm 随扩展打包；WebGPU 优先，WASM fallback |
| VAD | Silero VAD (ONNX) | ~2MB，静音检测 + 切句，减少幻觉 |
| 模型格式 | ONNX 量化 (q8/q4) | HuggingFace transformers.js 格式 |
| 模型缓存 | Cache Storage | + `unlimitedStorage` 权限 |
| Manifest | V3 | 最低 Chrome 116 |

> **CSP 要点：** manifest 需声明 `'wasm-unsafe-eval'`；onnxruntime-web 的 `.wasm` 文件必须打包在扩展内并配置 `env.wasm.wasmPaths` 指向本地路径，不走 CDN。

---

## 2. 边界情况处理

### 2.1 硬件与 GPU 检测

| 检测结果 | 处理 | 用户提示 |
| --- | --- | --- |
| WebGPU 可用（独显 / Apple Silicon） | 默认 WebGPU 后端，推荐 small/medium | 推荐 small (250MB)，标注推理倍速预估 |
| WebGPU 可用（核显 / 低端） | WebGPU 后端，推荐 tiny/base | 推荐 base (150MB)，提示"较大模型可能卡顿" |
| WebGPU 不可用 | 回退 WASM/CPU，限制模型 ≤ base | "您的浏览器不支持 GPU 加速，识别速度受限" |
| WebGPU 运行时崩溃 | 捕获异常，自动切 WASM 重试，记录日志 | "GPU 推理异常，已切换到 CPU 模式" |
| 内存不足（加载模型 OOM） | 捕获异常，建议换小一号模型 | "模型加载失败（内存不足），建议使用 [smaller] 模型" |

**检测方法：** `navigator.gpu.requestAdapter()` → 读取 `adapterInfo` 获取显卡名称/厂商 → 根据已知 GPU 列表给出推荐。无法精确判断时让用户自选，不强制。

### 2.2 网络环境

| 场景 | 处理 | 用户提示 |
| --- | --- | --- |
| 模型下载中断 | 支持断点续传（Range header）。已下载分片保留，恢复网络后从断点继续 | "下载已暂停，恢复网络后自动继续（已完成 67%）" |
| 模型源不可达（HuggingFace 被墙） | 提供多个下载源（HF 主站 / HF 镜像）；兜底：本地导入 | "无法连接下载服务器。可尝试 [切换镜像] 或 [导入本地模型]" |
| 下载速度极慢 | 显示实时速度 + 预估剩余时间，允许取消 | "下载中 ... 128KB/s，预计还需 25 分钟 [取消]" |
| 完全无网络 | 模型已下载 → 识别正常；翻译不可用 → 只显示原文 | "无网络连接。识别正常，翻译暂不可用（显示原文）" |
| 翻译 API 超时 | 可配置超时（默认 15s）。超时后保留原文，不阻塞后续 | "翻译超时，显示原文 [重试]" |
| 翻译 API 429 | 指数退避（2s → 4s → 8s），最多 3 次。降低并发数 | "翻译服务限流，正在降速重试" |
| 翻译 API 401/403 | 停止所有翻译请求，不重试 | "API Key 无效或无权限，请检查设置" |
| 翻译 API 模型不存在 | 解析错误信息中的 model 字段 | "模型 [xxx] 不存在，请检查模型 ID" |
| 扩展无目标域权限 | 检测到缺少 host_permission 时引导授权 | "需要访问 [domain] 的权限 [点击授权]" |

### 2.3 浏览器与扩展生命周期

| 场景 | 处理 |
| --- | --- |
| Service Worker 被杀 | MV3 的 SW 随时会休眠。关键会话状态持久化到 `chrome.storage.session`（内存级，不落盘）。SW 重启后从 storage 恢复，Content Script 检测到连接断开后自动重连 |
| Offscreen 被关闭 | SW 在需要时重建 Offscreen Document（`chrome.offscreen.createDocument` 幂等）。音频流需要重新建立 → 提示"正在恢复采集" |
| 标签页导航 / SPA 路由 | Content Script 监听 `beforeunload` + MutationObserver 检测播放器变化。导航时：清理旧会话 → generation +1 → 新页面重新检测 |
| 标签页关闭 | SW 收到 `tabs.onRemoved` → 停止该标签页的所有采集和翻译任务 → 释放 Offscreen（如无其他活跃会话） |
| 浏览器数据被清除 | 下次启动时检测 Cache Storage 中模型是否存在 → 缺失则在设置页提示"模型已被清除，需要重新下载或导入" |
| Popup 关闭 | 不影响任何正在运行的会话。Popup 重新打开时从 SW 拉取当前状态 |
| Chrome 版本过低 | manifest `minimum_chrome_version: "116"`。低于 116 无法安装。116–120 之间的已知 Offscreen 限制在 README 标注 |

### 2.4 播放场景

| 场景 | 处理 | 用户感知 |
| --- | --- | --- |
| 跨域 iframe 内播放器 | Content Script 无法注入跨域 iframe。检测到后不尝试读取字幕 | "检测到跨域播放器，字幕读取受限。可使用音频识别模式" |
| DRM 保护内容 | tabCapture 对 EME 加密内容可能返回静音流。检测持续静音 > 10s + 视频在播放 → 判定为 DRM | "检测到受保护内容，音频采集不可用" |
| 页面有多个 video | 筛选：正在播放 + 可见 + 面积最大的。仍有歧义 → Popup 列出选项让用户选 | Popup 显示"检测到多个播放器，请选择" |
| tabCapture 静音问题 | tabCapture 获取的流会接管标签页音频。在 Offscreen 中通过 AudioContext 创建 MediaStreamAudioSourceNode → 分两路：一路 destination（回放原声），一路 AudioWorklet（送 ASR） | 用户应听到正常声音。如回放异常："音频播放异常 [停止采集]" |
| 视频无声音 | VAD 持续检测静音 > 30s → 降低 ASR 频率，不产出空字幕 | "未检测到语音"（状态栏提示，不弹窗） |
| 纯音乐 / 噪声 | VAD 过滤非语音段。偶尔漏判产出的噪声识别，通过置信度过滤 | 不显示低置信度结果 |
| 全屏模式 | 字幕层使用 Shadow DOM 挂载在 video 父容器上，`:fullscreen` 伪类检测全屏并调整定位 | 全屏下字幕正常显示。无法注入的播放器全屏 → 提示"全屏模式下字幕不可用" |

---

## 3. 翻译 API 兼容方案

统一 OpenAI-compatible Chat Completions 协议。用户只需填三个字段：地址、Key、模型。

### 3.1 配置字段

| 字段 | 示例 | 说明 |
| --- | --- | --- |
| API 地址 | `https://api.deepseek.com/v1` | Base URL，扩展自动拼接 `/chat/completions` |
| API Key | `sk-***` | 存 `chrome.storage.local`，不进 DOM / sync / 日志 |
| 模型 ID | `deepseek-chat` | 不写死，不默认。用户手填或从测试结果选 |
| 请求超时 | `15` 秒 | 可调，默认 15s |
| 最大并发 | `2` | 可调，默认 2，防 429 |

### 3.2 URL 拼接规则（防重复）

用户输入的地址格式不确定，必须做归一化处理，核心原则：**绝不重复拼接**。

```
输入                                        → 最终请求地址
─────────────────────────────────────────────────────────────────
https://api.example.com                     → /v1/chat/completions
https://api.example.com/                    → /v1/chat/completions
https://api.example.com/v1                  → /v1/chat/completions
https://api.example.com/v1/                 → /v1/chat/completions
https://api.example.com/v1/chat/completions → 原样使用
https://speed.bobiking.com/v1               → /v1/chat/completions
https://api.example.com/custom/path         → /custom/path/chat/completions
```

实现逻辑：

```typescript
function buildEndpoint(baseUrl: string): string {
  let url = baseUrl.replace(/\/+$/, '')  // 去尾部斜杠
  if (url.endsWith('/chat/completions')) return url
  if (url.endsWith('/v1')) return url + '/chat/completions'
  return url + '/v1/chat/completions'
}
```

设置页实时预览最终地址，用户一眼就能看到拼接结果是否正确。

### 3.3 请求格式

```json
{
  "model": "用户填的模型ID",
  "messages": [
    {
      "role": "system",
      "content": "将以下字幕翻译为简体中文。仅返回译文，每行对应一条原文，保持行数一致。"
    },
    {
      "role": "user",
      "content": "1| Hello everyone, welcome back.\n2| Today we're going to talk about..."
    }
  ],
  "temperature": 0.3,
  "max_tokens": 2048
}
```

> **安全：** 字幕原文作为 `user` 消息传入，不允许被当作系统指令执行。system prompt 明确要求"仅返回译文"，不做其他操作。字幕内容中如果包含类似指令的文本（如 "ignore previous instructions"），仍只作为待翻译数据处理。

### 3.4 批量策略

| 参数 | 值 | 说明 |
| --- | --- | --- |
| 每批条数 | 10–20 条 cue | 按上下文长度动态调整，总 input ≤ 1500 tokens |
| 编号格式 | `1| ... \n2| ...` | 返回时按编号对齐，校验返回行数 = 输入行数 |
| 返回行数不匹配 | 丢弃该批次，按单条重试 | 不将错误结果写入缓存 |
| 缓存 key | `mediaId + cueId + srcLang + tgtLang + model` | 会话内 Map，同一 cue 不重复请求 |
| 请求频率 | ≤ 1.5 次/分钟（稳态） | 超前模式下天然低频 |

### 3.5 "测试翻译" 功能

设置页点击"测试"，实际发送一条短句翻译请求（不只是验 Key 非空或列模型成功）。

```
测试请求：system="翻译为中文" + user="Hello, this is a test."
期望返回：包含中文的非空字符串

测试结果分级显示：
  ✓ 翻译成功         → 显示原文 + 译文 + 耗时 + 模型名
  ✗ 401/403          → "Key 无效或无权限"
  ✗ 404              → "地址或模型不存在，请检查拼接结果：[显示完整URL]"
  ✗ 429              → "请求过于频繁，请稍后再试"
  ✗ 5xx              → "服务端错误 ([status])，请检查服务状态"
  ✗ 超时              → "请求超时 ([timeout]s)，网络可能不稳定"
  ✗ 网络错误          → "无法连接 [domain]，请检查地址和网络"
  ✗ 缺少权限          → "需要授权访问 [domain] [点击授权]"
  ✗ 响应格式异常       → "返回格式不是 OpenAI 标准格式，请确认接口兼容性"
```

### 3.6 兼容性矩阵

| 服务 | 地址示例 | 兼容 | 备注 |
| --- | --- | --- | --- |
| Sub2API（用户现有） | `https://speed.bobiking.com/v1` | 兼容 | 标准 chat/completions |
| DeepSeek | `https://api.deepseek.com/v1` | 兼容 | 最便宜 |
| OpenAI | `https://api.openai.com/v1` | 兼容 | 需 API 账号（非 Plus 订阅） |
| Groq | `https://api.groq.com/openai/v1` | 兼容 | 有免费额度 |
| 本地 Ollama | `http://localhost:11434/v1` | 兼容 | 完全离线 |
| 任意 OpenAI 兼容网关 | 自定义 | 兼容 | 只要响应格式符合 chat/completions |
| 原生 Claude API | — | 待扩展 | messages 格式不同，留接口，首版不做 |
| 原生 Gemini API | — | 待扩展 | 同上 |

---

## 4. 模型分发策略

三种方式覆盖不同网络环境，用户可自由组合。

### 4.1 在线下载（默认路径）

```
设置页 → 检测 GPU → 推荐模型档位 → 用户选择 → 点击"下载"
  → fetch() + Range 断点续传
  → 进度条：已下载 / 总量 / 速度 / 预计剩余
  → 完成 → 校验文件完整性 (sha256)
  → 写入 Cache Storage
  → "模型已就绪"
```

**下载源优先级：**

| 优先级 | 源 | 说明 |
| --- | --- | --- |
| 1 | HuggingFace 主站 | 默认，多数地区可达 |
| 2 | HuggingFace 镜像（hf-mirror.com） | 中国大陆可达 |
| 3 | 自定义 URL | 用户自填，用于企业内网镜像等场景 |

下载失败自动切换下一源。设置页可手动选择下载源。

### 4.2 离线整包分发（网盘 / 直接发送）

为无 VPN / 网络慢的用户提供预打包方案。

**构建产物：**

| 产物 | 体积 | 内容 | 适用 |
| --- | --- | --- | --- |
| hearclear-lite.zip | ~5 MB | 扩展代码 + WASM 运行时，无模型 | 网络正常用户，安装后在线下载模型 |
| hearclear-small.zip | ~255 MB | 扩展代码 + WASM 运行时 + whisper-small-q8 | 网络受限，拿到即用 |
| hearclear-medium.zip | ~755 MB | 扩展代码 + WASM 运行时 + whisper-medium-q8 | 追求日韩质量 |

**安装流程：**

```
用户拿到 zip → 解压 → Chrome 加载已解压扩展
  → 扩展启动时检测本地 models/ 目录
  → 发现预置模型文件 → 校验 sha256
  → 自动导入到 Cache Storage（一次性操作）
  → 导入完成后可删除 models/ 目录中的原始文件（可选，节省磁盘）
  → "模型已就绪"
```

> **注意：** 模型文件打包在扩展目录的 `models/` 下，安装时读取并导入 Cache Storage，之后通过 Cache Storage 加载（和在线下载路径统一）。不直接从扩展目录读取——因为扩展更新会替换目录内容。

### 4.3 本地模型导入（用户自行下载）

用户从任意途径下载好 ONNX 模型文件，通过设置页导入。

```
设置页 → 点击"导入本地模型" → 系统文件选择对话框
  → 用户选择 .onnx 文件（支持多选 / 选择目录）
  → 扩展通过 File API 读取文件内容
  → 校验：文件名匹配 + sha256 校验 + 文件完整性
  → 通过 → 写入 Cache Storage
  → "模型已就绪"
  → 失败 → "文件校验失败，可能不是支持的模型或文件不完整"
```

**校验规则：**

- 检查文件名是否匹配已知模型清单（如 `encoder_model_q8.onnx`、`decoder_model_merged_q8.onnx`）
- 校验 sha256（扩展内置已知模型的 hash 清单）
- 所有必需文件齐全后才标记为"就绪"；缺文件时列出缺少的
- 导入成功后模型存在 Cache Storage，和在线下载完全一样

**用户手动下载参考（设置页展示）：**

```
HuggingFace:
  https://huggingface.co/onnx-community/whisper-small/tree/main/onnx
HF 镜像:
  https://hf-mirror.com/onnx-community/whisper-small/tree/main/onnx

所需文件清单（whisper-small 为例）：
  ├── encoder_model_q8.onnx        (~150 MB)
  ├── decoder_model_merged_q8.onnx (~95 MB)
  ├── config.json
  ├── tokenizer.json
  ├── generation_config.json
  └── preprocessor_config.json
```

### 4.4 三种方式对比

| 方式 | 网络要求 | 操作复杂度 | 适用用户 |
| --- | --- | --- | --- |
| 在线下载 | 需能访问 HF 或镜像 | 最简单，点一下 | 多数用户 |
| 离线整包 | 无需 | 解压 + 加载扩展 | 无 VPN / 网盘分发 |
| 本地导入 | 自行下载模型文件 | 下载文件 + 设置页导入 | 已有模型 / 企业内网 |

> **统一存储：** 无论哪种方式，模型最终都进入 Cache Storage，后续加载路径完全一致。避免维护多套读取逻辑。

---

## 5. 会话与同步机制

### 5.1 状态机

首版 6 个主状态，覆盖所有 UI 场景。

```
IDLE → DETECTING → SUBTITLE_MODE ──→ STOPPED
                 ↘ ASR_MODE ────────→ STOPPED
                   ↕ (可切换)
                 ERROR ─── [重试] ──→ DETECTING
```

| 状态 | 含义 | 子状态（Popup 显示） |
| --- | --- | --- |
| IDLE | 未启动 | — |
| DETECTING | 检测字幕源 | 等待授权 / 下载模型 / 加载模型 |
| SUBTITLE_MODE | 翻译现有字幕 | 翻译中 / 预翻译中 |
| ASR_MODE | 音频识别 | 识别中 / 处理落后 |
| ERROR | 出错 | 具体错误信息 + 操作建议 |
| STOPPED | 用户主动停止 | — |

### 5.2 Seek 隔离

```
每次会话分配 sessionId（视频切换时重置）
每次 seek 事件递增 generation

所有异步任务（ASR、翻译）携带 { sessionId, generation }
返回时校验：
  sessionId 不匹配 → 丢弃（视频已切换）
  generation 不匹配 → 可写缓存，禁止更新当前屏幕（已 seek 过）
```

### 5.3 超前转录窗口

```
播放头 ─────────────── currentTime
           ↓
  [已转录 + 已翻译]  → Cache (cue list)
           ↓
  [已转录 + 翻译中]  → 翻译队列
           ↓
  [转录中]           → ASR Worker
           ↓
  [待取音频]          → 超前取音 (fetch / MSE hook)
           ↓
  ──── 超前边界 ──── currentTime + 60~120s
```

**音频获取优先级：**

1. `<video src>` 是直接 URL → Range fetch，解码音轨（最快、最可靠）
2. `src` 是 `blob:`（MSE）→ hook SourceBuffer.appendBuffer，拆 fMP4/WebM 取音轨
3. 以上均不可用 → tabCapture 实时采集（退化为近实时模式，标记延迟）

---

## 6. 界面展示

### 6.1 Popup 面板

点击扩展图标弹出，宽 360px，紧凑布局。关闭 Popup 不影响运行中的会话。

```
┌─────────────────────────────────────┐
│  🎧 HearClear                  ⚙️  │  ← 标题 + 设置入口
├─────────────────────────────────────┤
│                                     │
│  ▶ 当前页面：example.com/video      │  ← 当前标签页信息
│  🎬 播放器：<video> 1280×720        │  ← 检测到的播放器
│                                     │
├─────────────────────────────────────┤
│                                     │
│  ┌───────────────────────────────┐  │
│  │      ● 正在识别声音           │  │  ← 状态指示（动态）
│  │        超前 2:15              │  │  ← 超前量（ASR 模式）
│  └───────────────────────────────┘  │
│                                     │
│  ┌─────────────┐ ┌───────────────┐  │
│  │  ■ 停止     │ │  模式：自动 ▾ │  │  ← 开始/停止 + 模式切换
│  └─────────────┘ └───────────────┘  │
│                                     │
├─────────────────────────────────────┤
│                                     │
│  源语言  [ 英语      ▾ ]           │  ← 语言选择
│  目标    [ 简体中文  ▾ ]           │
│                                     │
│  显示    ◉ 双语  ○ 仅译文  ○ 原文  │  ← 字幕显示模式
│                                     │
├─────────────────────────────────────┤
│  模型：whisper-small ✓              │  ← 底部状态栏
│  翻译：DeepSeek ✓  延迟 0.8s       │
└─────────────────────────────────────┘
```

**Popup 状态显示（随状态机变化）：**

| 状态 | 显示 | 按钮 |
| --- | --- | --- |
| IDLE | "点击开始翻译" | ▶ 开始 |
| DETECTING | "正在检测字幕…" / "等待授权…" | 取消 |
| SUBTITLE_MODE | "翻译现有字幕 · 已翻译 42 条" | ■ 停止 |
| ASR_MODE | "正在识别声音 · 超前 2:15" | ■ 停止 |
| ASR_MODE (落后) | "⚠ 识别落后 3s · 队列 5 段" | ■ 停止 / 清空队列 |
| ERROR | "✗ 翻译失败：Key 无效" + 操作建议 | 重试 / 设置 |
| STOPPED | "已停止" | ▶ 重新开始 |

**模式切换下拉：**

| 选项 | 行为 |
| --- | --- |
| 自动（字幕优先） | 有字幕 → 翻译字幕；无字幕 → 自动启动 ASR。默认选项 |
| 仅翻译字幕 | 只读取现有字幕轨翻译，不启动音频采集 |
| 强制识别声音 | 无论有无字幕都用 ASR，需授权采集 |

### 6.2 字幕层（视频叠加层）

字幕层渲染在视频上方，通过 Shadow DOM 完全隔离页面 CSS。

**双语模式（默认）：**

```
┌──────────────────────────────────────────────┐
│                                              │
│                   视频画面                    │
│                                              │
│                                              │
│                                              │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │  So the key insight here is that you   │  │  ← 原文（较小，浅色）
│  │  所以这里的关键发现是                     │  │  ← 译文（较大，白色）
│  └────────────────────────────────────────┘  │
│               advancement ▶ advancement       │  ← 播放器原有控制栏
└──────────────────────────────────────────────┘
```

**仅译文模式：**

```
┌──────────────────────────────────────────────┐
│                                              │
│                   视频画面                    │
│                                              │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │  所以这里的关键发现是                     │  │  ← 只显示中文
│  └────────────────────────────────────────┘  │
│              ← advancement ▶ ─────── ⛶      │
└──────────────────────────────────────────────┘
```

**字幕层样式参数（用户可调）：**

| 参数 | 默认值 | 范围 | 说明 |
| --- | --- | --- | --- |
| 译文字号 | 18px | 14–32px | 主字幕，白色 |
| 原文字号 | 14px | 12–24px | 双语模式上方原文，70% 透明度 |
| 背景色 | `rgba(0,0,0,0.7)` | 透明度 0–1 可调 | 半透明黑底，保证可读性 |
| 位置 | 底部 8% | 可拖动 | 避开播放器控制栏 |
| 最大宽度 | 视频宽度 80% | — | 居中，两侧留边 |
| 最大行数 | 3 行 | — | 超出截断，避免铺满画面 |
| 字体 | 系统默认无衬线 | — | 不引入额外字体，跟随系统 |

**字幕层技术实现：**

```
Content Script
  → 在 video 的父容器上创建 <div>（Shadow DOM host）
  → Shadow DOM 内部：
      ├── <style> 完整样式（与页面隔离）
      └── <div class="subtitle-container">
            ├── <div class="original">原文</div>      ← 双语模式
            └── <div class="translation">译文</div>
```

- Shadow DOM 隔离：页面 CSS 不会污染字幕样式，字幕样式也不会影响页面
- 定位：`position: absolute` 相对于视频容器，`z-index` 高于视频但低于播放器控制栏
- 全屏适配：监听 `fullscreenchange`，全屏时字幕层跟随进入全屏容器
- 动画：新字幕淡入（150ms `opacity` 过渡），避免闪烁
- 自动换行：CSS `word-break: keep-all`（中文不断词）+ `overflow-wrap: break-word`
- 指针穿透：`pointer-events: none`，不阻挡视频点击和控制栏操作

**字幕显示时序：**

```
                  ┌─ 已翻译 cue ─────────────────────┐
时间轴：  ─────── │ startTime          endTime │ ─────────
                  └──────────────────────────────────┘
                        ↑ 淡入显示          ↑ 淡出消失

翻译中 cue（译文未到）：
时间轴：  ─────── │ 原文（浅色）... 翻译中 │ ──────────
                        ↑ 先显示原文    ↑ 译文到达后替换/补充

过期 cue（seek 后）：
时间轴：  ── seek ──→ 立即清屏 → 从新位置重新匹配 cue
```

### 6.3 设置页

独立标签页打开（`chrome-extension://xxx/options.html`），非 Popup 内嵌。

```
┌──────────────────────────────────────────────────────┐
│  HearClear 设置                                      │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌─ 翻译服务 ─────────────────────────────────────┐  │
│  │                                                │  │
│  │  API 地址    [ https://api.deepseek.com/v1   ] │  │
│  │  最终地址    → https://api.deepseek.com/v1/    │  │  ← 实时预览拼接结果
│  │              chat/completions                  │  │
│  │  API Key     [ sk-*****                      ] │  │
│  │  模型 ID     [ deepseek-chat                 ] │  │
│  │  超时        [ 15 ] 秒   并发  [ 2 ]          │  │
│  │                                                │  │
│  │  [ 测试翻译 ]  ✓ 成功：0.8s                    │  │  ← 测试结果
│  │  "Hello" → "你好"                              │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─ 语音识别模型 ──────────────────────────────────┐  │
│  │                                                │  │
│  │  GPU 检测：Apple M3 Pro (14核 GPU) ✓ WebGPU    │  │
│  │                                                │  │
│  │  ○ tiny    75MB   英语够用，日韩差              │  │
│  │  ○ base   150MB   英语好，日韩勉强              │  │
│  │  ◉ small  250MB   推荐 · 英日语可看     [已下载] │  │  ← 推荐标记
│  │  ○ medium 750MB   日韩更好，需更多显存   [下载]  │  │
│  │                                                │  │
│  │  下载源  ◉ HuggingFace  ○ 镜像  ○ 自定义       │  │
│  │                                                │  │
│  │  [ 导入本地模型 ]  [ 删除已下载模型 (250MB) ]   │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─ 字幕显示 ─────────────────────────────────────┐  │
│  │                                                │  │
│  │  译文字号    ────●────────  18px                │  │
│  │  原文字号    ──●──────────  14px                │  │
│  │  背景透明度  ──────●──────  70%                 │  │
│  │  字幕位置    ──●──────────  底部                │  │
│  │                                                │  │
│  │  预览：                                        │  │
│  │  ┌──────────────────────────────────┐          │  │
│  │  │  So the key insight here is     │          │  │
│  │  │  所以这里的关键发现是              │          │  │
│  │  └──────────────────────────────────┘          │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─ 诊断信息 ─────────────────────────────────────┐  │
│  │  GPU：M3 Pro · WebGPU ✓                        │  │
│  │  模型：whisper-small-q8 · 已加载               │  │
│  │  翻译：DeepSeek · 连接正常 · 延迟 0.8s         │  │
│  │  缓存：已缓存 42 条译文 · 当前会话             │  │
│  │  [ 清除缓存 ]  [ 导出诊断日志 ]                │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌─ 隐私 ──────────────────────────────────────────┐ │
│  │  · 音频仅在本机处理，不上传                     │ │
│  │  · 翻译仅发送文字，不含音频或页面信息            │ │
│  │  · API Key 仅保存在本地扩展存储                  │ │
│  │  · 无分析埋点、无远程遥测                       │ │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

---

## 7. 权限设计

### 6.1 manifest.json 权限声明

| 权限 | 类型 | 用途 |
| --- | --- | --- |
| `tabCapture` | 必需 | 采集标签页音频 |
| `offscreen` | 必需 | 创建 Offscreen Document 处理音频 |
| `storage` | 必需 | 保存配置和会话状态 |
| `unlimitedStorage` | 必需 | Cache Storage 存放模型不受配额限制 |
| `activeTab` | 必需 | 获取当前标签页信息 |
| 翻译 API 域名 | **optional_host_permissions** | 用户首次配置时动态申请，不预置 |

> **翻译 API 域名为动态权限：** 用户在设置页填入 API 地址后，扩展通过 `chrome.permissions.request({ origins: [...] })` 申请该域名权限。不在 manifest 写死任何第三方域名。用户更换服务商时，旧域名可选择释放。

---

## 7. 安全与隐私

- **API Key：** 仅存 `chrome.storage.local`，不进 `storage.sync`、不注入页面 DOM、不出现在日志、不通过消息传递给 Content Script
- **音频数据：** 默认仅在内存中处理，不持久化。ASR 在本地完成，音频不上传（未来云 ASR 选项需用户明确开启）
- **翻译请求：** 仅发送纯文字（ASR 结果或字幕原文），不包含音频、视频 URL、页面信息
- **无远程执行代码：** JS/WASM 全部随扩展打包。模型权重是数据（ONNX tensor），不含可执行逻辑
- **无埋点 / 分析 / 遥测：** 不引入任何第三方追踪，不上报使用数据
- **host_permissions 最小化：** 不预置任何第三方域名，全部动态申请

---

## 8. 构建与目录结构

```
hearclear/
├── src/
│   ├── background/       # Service Worker
│   ├── offscreen/        # Offscreen Document + ASR Worker
│   ├── content/          # Content Script + 字幕渲染
│   ├── popup/            # Vue 3 Popup
│   ├── options/          # Vue 3 设置页
│   ├── shared/           # 类型、消息协议、工具函数
│   └── providers/
│       ├── subtitle/     # 字幕源适配器 (TextTrack, YouTube...)
│       ├── asr/          # ASR Provider (LocalWhisper, CloudASR...)
│       └── translate/    # Translation Provider (OpenAICompat...)
├── public/
│   └── wasm/             # onnxruntime-web WASM 文件（打包）
├── scripts/
│   ├── build.mjs         # 构建扩展
│   └── bundle-model.mjs  # 打包含模型的离线包
├── manifest.json
├── vite.config.ts
└── package.json
```

**构建命令：**

```bash
pnpm build              # → dist/ (lite，不含模型)
pnpm build:full small   # → dist-small/ (含 whisper-small)
pnpm build:full medium  # → dist-medium/ (含 whisper-medium)
```

---

## 9. 开发阶段

| 阶段 | 交付物 | 验证标准 |
| --- | --- | --- |
| Phase 1（技术验证） | 最小扩展骨架：tabCapture + 原声回放 + Whisper small + 翻译 API 调通 + seek 隔离 | M3 Pro 上实测：推理倍速、英/日/韩质量、冷启动时间、翻译延迟。输出量化数据 |
| Phase 2（完整首版） | 字幕优先 / ASR 降级、超前转录、设置页、模型管理（三种分发）、字幕层、状态机、错误处理 | 两条完整流程可走通：有字幕翻译 + 无字幕 ASR 翻译。seek 后无旧字幕 |
| Phase 3（实际验证） | 在真实网站测试、修复阻塞问题、支持矩阵、安装文档 | 至少 2 个非 YouTube 站点通过，记录支持状态 |

---

*本方案基于需求文档 v0.1 编写。预估数据未经实测，Phase 1 将产出真实测量结果。方案中性能目标为设计意图，不构成产品承诺。*

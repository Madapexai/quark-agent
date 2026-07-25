# Voice STT/TTS

Speech-to-text and text-to-speech with multiple providers.

## Overview

| Direction | Provider | Requirements |
|-----------|----------|-------------|
| STT | OpenAI Whisper API | `OPENAI_API_KEY` |
| STT | Local whisper CLI | `pip install openai-whisper` |
| STT | Browser | Web Speech API (client-side) |
| TTS | OpenAI TTS-1 | `OPENAI_API_KEY` |
| TTS | edge-tts | `pip install edge-tts` |
| TTS | Browser | Web Speech API (client-side) |

## Quick Start

```ts
import { voiceManager } from "quark-agent";

// Configure
voiceManager.setSTTProvider("openai", process.env.OPENAI_API_KEY);
voiceManager.setTTSProvider("edge-tts");

// Speech-to-text
const audioBuffer = Buffer.from(/* WAV/MP3 data */);
const sttResult = await voiceManager.transcribe(audioBuffer, "wav", "en");
console.log(sttResult.text);

// Text-to-speech
const ttsResult = await voiceManager.synthesize("Hello world", {
  voice: "zh-CN-XiaoxiaoNeural",
  format: "mp3",
});
// -> { audioBuffer: Buffer, format: "mp3" }
```

## Available Voices

| Voice ID | Name | Language |
|----------|------|----------|
| `alloy` | Alloy | English |
| `echo` | Echo | English |
| `fable` | Fable | English |
| `onyx` | Onyx | English |
| `nova` | Nova | English |
| `shimmer` | Shimmer | English |
| `en-US-JennyNeural` | Jenny | English (US) |
| `zh-CN-XiaoxiaoNeural` | 晓晓 | Chinese |
| `zh-CN-YunxiNeural` | 云希 | Chinese |
| `ja-JP-NanamiNeural` | 七海 | Japanese |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/voices` | List voices |
| POST | `/api/voice/stt` | Speech-to-text |
| POST | `/api/voice/tts` | Text-to-speech |

import { spawn, exec } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface STTResult {
  text: string;
  language?: string;
  confidence?: number;
  duration?: number;
}

export interface TTSResult {
  audioBuffer: Buffer;
  format: "mp3" | "wav" | "ogg";
  duration?: number;
}

export class VoiceManager {
  private audioDir: string;
  private sttProvider: "whisper-local" | "openai" | "azure" | "browser" = "browser";
  private ttsProvider: "browser" | "openai" | "azure" | "edge-tts" = "browser";
  private apiKey?: string;

  constructor(audioDir?: string) {
    this.audioDir = audioDir ?? join(process.cwd(), ".data", "voice");
    mkdirSync(this.audioDir, { recursive: true });
  }

  setSTTProvider(provider: "whisper-local" | "openai" | "azure" | "browser", apiKey?: string): void {
    this.sttProvider = provider;
    this.apiKey = apiKey;
  }

  setTTSProvider(provider: "browser" | "openai" | "azure" | "edge-tts", apiKey?: string): void {
    this.ttsProvider = provider;
    this.apiKey = apiKey;
  }

  /** Speech-to-Text: Convert audio buffer to text */
  async transcribe(audioBuffer: Buffer, format: "wav" | "mp3" | "ogg" | "webm" = "wav", language?: string): Promise<STTResult> {
    const audioPath = join(this.audioDir, `input-${Date.now()}.${format}`);
    writeFileSync(audioPath, audioBuffer);

    try {
      switch (this.sttProvider) {
        case "openai":
          return await this.openaiSTT(audioPath, format, language);
        case "whisper-local":
          return await this.whisperLocalSTT(audioPath, language);
        case "browser":
        default:
          // Browser mode — audio is handled client-side via Web Speech API
          return { text: "", language, confidence: 0, duration: 0 };
      }
    } finally {
      // Cleanup temp file (optional — could keep for debugging)
    }
  }

  /** Text-to-Speech: Convert text to audio buffer */
  async synthesize(text: string, options?: { voice?: string; speed?: number; format?: "mp3" | "wav" | "ogg" }): Promise<TTSResult> {
    const format = options?.format ?? "mp3";
    switch (this.ttsProvider) {
      case "openai":
        return await this.openaiTTS(text, options?.voice ?? "alloy", format);
      case "edge-tts":
        return await this.edgeTTS(text, options?.voice ?? "en-US-JennyNeural");
      case "browser":
      default:
        // Browser mode — TTS handled client-side via Web Speech API
        return { audioBuffer: Buffer.alloc(0), format, duration: 0 };
    }
  }

  /** Get available voices */
  listVoices(): { id: string; name: string; language: string; provider: string }[] {
    return [
      // OpenAI voices
      { id: "alloy", name: "Alloy", language: "en", provider: "openai" },
      { id: "echo", name: "Echo", language: "en", provider: "openai" },
      { id: "fable", name: "Fable", language: "en", provider: "openai" },
      { id: "onyx", name: "Onyx", language: "en", provider: "openai" },
      { id: "nova", name: "Nova", language: "en", provider: "openai" },
      { id: "shimmer", name: "Shimmer", language: "en", provider: "openai" },
      // Edge TTS voices
      { id: "en-US-JennyNeural", name: "Jenny (EN-US)", language: "en-US", provider: "edge-tts" },
      { id: "zh-CN-XiaoxiaoNeural", name: "晓晓 (zh-CN)", language: "zh-CN", provider: "edge-tts" },
      { id: "zh-CN-YunxiNeural", name: "云希 (zh-CN)", language: "zh-CN", provider: "edge-tts" },
      { id: "ja-JP-NanamiNeural", name: "七海 (ja-JP)", language: "ja-JP", provider: "edge-tts" },
    ];
  }

  /** Check if system has local whisper installed */
  async hasWhisperLocal(): Promise<boolean> {
    return new Promise((resolve) => {
      exec("which whisper 2>/dev/null || where whisper 2>nul", (err, stdout) => {
        resolve(!!stdout.trim() && !err);
      });
    });
  }

  /** Check if system has edge-tts installed */
  async hasEdgeTTS(): Promise<boolean> {
    return new Promise((resolve) => {
      exec("which edge-tts 2>/dev/null || where edge-tts 2>nul", (err, stdout) => {
        resolve(!!stdout.trim() && !err);
      });
    });
  }

  private async openaiSTT(audioPath: string, format: string, language?: string): Promise<STTResult> {
    if (!this.apiKey) throw new Error("OpenAI API key not set for STT");
    const formData = new FormData();
    const audioBlob = new Blob([readFileSync(audioPath)]);
    formData.append("file", audioBlob, `audio.${format}`);
    formData.append("model", "whisper-1");
    if (language) formData.append("language", language);

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${this.apiKey}` },
      body: formData,
    });
    const data = await res.json() as { text: string };
    return { text: data.text, language, confidence: 1 };
  }

  private async whisperLocalSTT(audioPath: string, language?: string): Promise<STTResult> {
    return new Promise((resolve, reject) => {
      const args = [audioPath, "--model", "base", "--output_format", "txt", "--output_dir", this.audioDir];
      if (language) args.push("--language", language);
      const proc = spawn("whisper", args);
      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += d));
      proc.on("close", (code) => {
        if (code !== 0) { reject(new Error(`whisper failed: ${stderr}`)); return; }
        const txtPath = audioPath.replace(/\.\w+$/, ".txt");
        try {
          const text = readFileSync(txtPath, "utf8").trim();
          resolve({ text, language, confidence: 1 });
        } catch {
          resolve({ text: "", language });
        }
      });
    });
  }

  private async openaiTTS(text: string, voice: string, format: "mp3" | "wav" | "ogg"): Promise<TTSResult> {
    if (!this.apiKey) throw new Error("OpenAI API key not set for TTS");
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: "tts-1",
        input: text,
        voice,
        response_format: format,
      }),
    });
    const audioBuffer = Buffer.from(await res.arrayBuffer());
    return { audioBuffer, format, duration: 0 };
  }

  private async edgeTTS(text: string, voice: string): Promise<TTSResult> {
    return new Promise((resolve, reject) => {
      const outputPath = join(this.audioDir, `tts-${Date.now()}.mp3`);
      const proc = spawn("edge-tts", ["--voice", voice, "--text", text, "--write-media", outputPath]);
      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += d));
      proc.on("close", (code) => {
        if (code !== 0) { reject(new Error(`edge-tts failed: ${stderr}`)); return; }
        try {
          const audioBuffer = readFileSync(outputPath);
          resolve({ audioBuffer, format: "mp3", duration: 0 });
        } catch {
          reject(new Error("Failed to read TTS output"));
        }
      });
    });
  }
}

export const voiceManager = new VoiceManager();

/**
 * Multimodal —— 多模态附件管理
 *
 * 负责图片/文件/音频上传的持久化与格式转换：
 * - saveAttachment：落盘到 .data/uploads/，返回附件元信息
 * - getAttachment：按 id 读取文件内容
 * - toOpenAIContent / toAnthropicContent：转换为 LLM vision API 所需格式
 *
 * 仅依赖 Node 内置模块（fs/path/crypto）。
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";

export interface MultimodalAttachment {
  id: string;
  type: "image" | "file" | "audio";
  filename: string;
  mimeType: string;
  size: number;
  // For images: base64 data URL or file path
  dataUrl?: string;
  filePath?: string;
}

export interface MultimodalMessage {
  text: string;
  attachments: MultimodalAttachment[];
}

export class MultimodalManager {
  private uploadDir: string;

  constructor(uploadDir?: string) {
    this.uploadDir = uploadDir ?? join(process.cwd(), ".data", "uploads");
    mkdirSync(this.uploadDir, { recursive: true });
  }

  saveAttachment(filename: string, mimeType: string, buffer: Buffer): MultimodalAttachment {
    const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
    const ext = extname(filename) || (mimeType.startsWith("image/") ? ".png" : ".bin");
    const id = `${Date.now()}-${hash}${ext}`;
    const filePath = join(this.uploadDir, id);
    writeFileSync(filePath, buffer);

    const type: MultimodalAttachment["type"] = mimeType.startsWith("image/") ? "image"
      : mimeType.startsWith("audio/") ? "audio" : "file";

    const attachment: MultimodalAttachment = {
      id, type, filename, mimeType, size: buffer.length, filePath,
    };

    // For images, also create a base64 data URL for LLM vision APIs
    if (type === "image") {
      attachment.dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
    }

    return attachment;
  }

  getAttachment(id: string): Buffer | null {
    try {
      return readFileSync(join(this.uploadDir, id));
    } catch {
      return null;
    }
  }

  // Convert attachments to OpenAI vision format
  toOpenAIContent(text: string, attachments: MultimodalAttachment[]): unknown[] {
    const content: unknown[] = [{ type: "text", text }];
    for (const att of attachments) {
      if (att.type === "image" && att.dataUrl) {
        content.push({
          type: "image_url",
          image_url: { url: att.dataUrl, detail: "auto" },
        });
      }
    }
    return content;
  }

  // Convert to Anthropic Claude format
  toAnthropicContent(text: string, attachments: MultimodalAttachment[]): unknown[] {
    const content: unknown[] = [];
    for (const att of attachments) {
      if (att.type === "image" && att.dataUrl) {
        const base64Data = att.dataUrl.split(",")[1];
        const mediaType = att.dataUrl.split(";")[0].split(":")[1];
        content.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data: base64Data },
        });
      }
    }
    content.push({ type: "text", text });
    return content;
  }

  // Get file info for display
  getFileInfo(id: string): { filename: string; mimeType: string; size: number } | null {
    const buf = this.getAttachment(id);
    if (!buf) return null;
    return { filename: id, mimeType: "application/octet-stream", size: buf.length };
  }

  // List all uploads
  listUploads(): { id: string; filename: string; size: number; type: string }[] {
    try {
      return readdirSync(this.uploadDir).map((id: string) => {
        const stat = statSync(join(this.uploadDir, id));
        const ext = extname(id).toLowerCase();
        const type = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext) ? "image"
          : [".mp3", ".wav", ".ogg", ".m4a"].includes(ext) ? "audio" : "file";
        return { id, filename: id, size: stat.size, type };
      });
    } catch {
      return [];
    }
  }
}

export const multimodalManager = new MultimodalManager();

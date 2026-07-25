# Multimodal Input

Upload images, files, and audio with automatic LLM vision format conversion.

## Overview

The Multimodal Manager handles file uploads and converts them to the format expected by different LLM vision APIs:

- **OpenAI format**: `image_url` with base64 data URL
- **Anthropic format**: `source.base64` with media type

## Quick Start

```ts
import { multimodalManager } from "quark-agent";

// Save an uploaded file
const attachment = multimodalManager.saveAttachment(
  "screenshot.png",
  "image/png",
  imageBuffer
);
// -> { id: "1784...-hash.png", type: "image", dataUrl: "data:image/png;base64,..." }

// Convert to OpenAI vision format
const openaiContent = multimodalManager.toOpenAIContent(
  "What's in this image?",
  [attachment]
);
// -> [
//   { type: "text", text: "What's in this image?" },
//   { type: "image_url", image_url: { url: "data:image/png;base64,...", detail: "auto" } }
// ]

// Convert to Anthropic format
const anthropicContent = multimodalManager.toAnthropicContent(
  "What's in this image?",
  [attachment]
);
```

## Upload via API

### Multipart form-data

```bash
curl -X POST http://localhost:8788/api/upload \
  -H "Authorization: Bearer <token>" \
  -F "file=@screenshot.png"
```

### Base64 JSON

```bash
curl -X POST http://localhost:8788/api/upload \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "filename": "screenshot.png",
    "mimeType": "image/png",
    "data": "iVBORw0KGgo..."
  }'
```

## WebUI

The dashboard chat supports:

- Click the 📎 button to upload
- Drag & drop files onto the chat input
- Paste images from clipboard (Ctrl/Cmd+V)
- Image thumbnails shown in message bubbles

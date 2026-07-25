# RAG / Knowledge Base

Document upload, chunking, vectorization, and retrieval-augmented generation.

## Overview

The Knowledge Base allows you to:

1. **Add documents** - Upload text files, automatically chunked and vectorized
2. **Search** - Find relevant chunks using cosine similarity
3. **Inject context** - Automatically augment LLM prompts with retrieved content

## Quick Start

```ts
import { knowledgeBase } from "quark-agent";

// Add a document
const doc = await knowledgeBase.addDocument(
  "guide.md",
  "# Deployment Guide\nTo deploy, run npm run build...",
  "text/markdown"
);
// -> { id: "a1b2c3...", chunks: 3 }

// Search the knowledge base
const results = await knowledgeBase.search("how to deploy", 5);
// -> [{ chunk: { text: "..." }, score: 0.933, document: {...} }]

// Get formatted context for LLM prompt
const context = await knowledgeBase.getContext("deployment instructions", 2000);
// -> "[guide.md] To deploy, run npm run build..."
```

## How It Works

### Chunking

Text is split into overlapping chunks:

- **Chunk size**: 500 characters
- **Overlap**: 50 characters
- Split on sentence boundaries (`.`, `!`, `?`, `。`, `！`, `？`, newlines)

### Embedding

Uses a lightweight TF-IDF hash-based embedding (no external model required):

- **Dimensions**: 256
- **Method**: MD5 hash of each word -> accumulate into vector
- **Normalization**: L2 normalized

### Search

Cosine similarity between query embedding and chunk embeddings.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/kb/documents` | List all documents |
| POST | `/api/kb/documents` | Add a document |
| DELETE | `/api/kb/documents/:id` | Delete a document |
| POST | `/api/kb/search` | Search the knowledge base |
| DELETE | `/api/kb/clear` | Clear all documents |

### Add Document

```bash
curl -X POST http://localhost:8788/api/kb/documents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"filename":"guide.md","content":"# Guide\n..."}'
```

### Search

```bash
curl -X POST http://localhost:8788/api/kb/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{"query":"how to deploy","topK":5}'
```

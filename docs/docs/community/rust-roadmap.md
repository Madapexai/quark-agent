# Rust Performance Roadmap

A 6-phase plan to migrate performance-critical modules from TypeScript to Rust via NAPI-RS.

## Why Rust?

| Metric | TypeScript | Rust Target | Improvement |
|--------|-----------|-------------|-------------|
| JSON parsing | ~100MB/s | ~1GB/s | 10x |
| Vector similarity | ~10k ops/s | ~500k ops/s | 50x |
| Password hashing | ~100/s | ~5000/s | 50x |
| Memory usage | ~30MB | ~5MB | 6x |
| Startup time | ~500ms | ~50ms | 10x |

## Phases

### Phase R1: Infrastructure (Week 1)
- Initialize `native/` Cargo workspace
- Configure napi-rs build pipeline
- Prebuilt binaries for 4 platforms
- First function: `hashPassword()`

### Phase R2: Crypto (Week 2)
- PBKDF2 + scrypt + HMAC-SHA256
- JWT sign/verify (HS256/RS256)
- AES-256-CBC (WeCom channel)
- Expected: 50x hashing, 10x JWT

### Phase R3: RAG Engine (Week 3)
- TF-IDF + hash embedding
- Cosine similarity (SIMD)
- Text chunking with Chinese tokenization
- Expected: 50x search

### Phase R4: Channel Protocols (Week 4)
- IMAP/SMTP client
- WebSocket client
- HMAC signing
- Eliminates ws/npm dependencies

### Phase R5: Computer Use (Week 5)
- Screenshot + image compression
- CDP WebSocket client
- OCR (tesseract binding)
- Expected: 4x screenshot speed

### Phase R6: Orchestration (Week 6)
- DAG workflow engine
- Cron scheduler
- serde_json for high-perf JSON
- Full benchmark report

## Architecture

```
┌─────────────────────────────────────────────┐
│              WebUI (HTML/CSS/JS)             │
├─────────────────────────────────────────────┤
│           Dashboard Server (TS)              │
├─────────────────────────────────────────────┤
│         Core Agent Runtime (TS)              │
├──────────────┬──────────────┬───────────────┤
│  Crypto (R)  │  RAG (R)     │ Channel (R)   │
│  JWT (R)     │  Embed (R)   │ WS (R)        │
│  AES (R)     │  Search (R)  │ IMAP (R)      │
├──────────────┴──────────────┴───────────────┤
│         NAPI-RS Bridge (Rust ↔ Node)         │
├─────────────────────────────────────────────┤
│              Rust Native Layer               │
└─────────────────────────────────────────────┘
```

Full document: [docs/RUST_ROADMAP.md](https://github.com/Madapexai/quark-agent/blob/master/docs/RUST_ROADMAP.md)

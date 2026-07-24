# Quark-Agent Rust 升级 Roadmap

## 为什么需要 Rust 升级

### 当前瓶颈
1. **JSON 序列化/反序列化** — 大量 LLM API 响应解析在 JS 层，吞吐受限
2. **向量化计算** — RAG 模块的 simpleEmbed 用纯 JS，大批量文档性能差
3. **加密操作** — PBKDF2/SHA-256 在 Node crypto 中可用，但 AES-CBC 等在企微 channel 中自建实现
4. **正则匹配** — Markdown 渲染、文本分块等 CPU 密集操作
5. **内存占用** — Node.js V8 引擎基础内存 ~30MB，Rust 可做到 <5MB

### 预期收益
| 指标 | TypeScript 现状 | Rust 目标 | 提升倍数 |
|------|----------------|-----------|----------|
| JSON 解析 | ~100MB/s | ~1GB/s | 10x |
| 向量相似度 | ~10k ops/s | ~500k ops/s | 50x |
| 密码哈希 | ~100/s | ~5000/s | 50x |
| 内存占用 | ~30MB | ~5MB | 6x |
| 启动时间 | ~500ms | ~50ms | 10x |

## Phase R1: 基础设施 (Week 1)

### 目标
搭建 Rust + Node.js 混合架构，建立 NAPI-RS 构建管线

### 任务
- [ ] 初始化 `native/` Cargo workspace
- [ ] 配置 napi-rs 脚手架（`@napi-rs/cli` + `napi-rs` crate）
- [ ] 实现 `hello()` 桥接函数验证链路
- [ ] 添加 `npm run build:native` 构建脚本
- [ ] CI/CD 增加 `xcodebuild` / `cargo` 步骤
- [ ] 产出 prebuilt binaries（darwin-arm64, darwin-x64, linux-x64, win32-x64）

### 交付物
- `native/Cargo.toml` + `native/src/lib.rs`
- `package.json` 新增 `@quark-agent/native` 可选依赖
- 首个 native 函数 `hashPassword(password, salt)` 替换 PBKDF2

## Phase R2: 加密模块迁移 (Week 2)

### 目标
将密码哈希、JWT 签名、AES 加密迁移到 Rust

### 任务
- [ ] `native/src/crypto.rs` — PBKDF2 + scrypt + HMAC-SHA256
- [ ] `native/src/jwt.rs` — JWT 签发/验证（HS256/RS256）
- [ ] `native/src/aes.rs` — AES-256-CBC（企微 channel 用）
- [ ] 在 `src/auth/index.ts` 中添加 fallback 逻辑：优先 native，降级 crypto
- [ ] Benchmark：native vs Node crypto 对比

### 预期性能
- PBKDF2: 100/s → 5000/s (50x)
- JWT verify: 5000/s → 50000/s (10x)

## Phase R3: RAG 向量化引擎 (Week 3)

### 目标
将知识库的向量化、相似度计算迁移到 Rust

### 任务
- [ ] `native/src/embedding.rs` — TF-IDF + hash 向量化
- [ ] `native/src/similarity.rs` — 余弦相似度 + 点积（SIMD 优化）
- [ ] `native/src/chunker.rs` — 文本分块（支持中文分词）
- [ ] 在 `src/rag/index.ts` 中调用 native 模块
- [ ] 支持批量向量化（并行计算）

### 预期性能
- 向量化: 1k docs/s → 50k docs/s
- 相似度搜索: 10k ops/s → 500k ops/s

## Phase R4: Channel 协议层 (Week 4)

### 目标
将 IMAP/SMTP、WebSocket、HMAC 签名等协议实现迁移到 Rust

### 任务
- [ ] `native/src/imap.rs` — IMAP 客户端（替代自建 LineSocket）
- [ ] `native/src/smtp.rs` — SMTP 客户端
- [ ] `native/src/websocket.rs` — WebSocket 客户端（Mattermost/Matrix）
- [ ] `native/src/hmac.rs` — HMAC-SHA256 签名（钉钉/企微）
- [ ] 在 channel 模块中添加 native fallback

### 预期收益
- IMAP 连接: TCP 握手 + TLS 协商 → Rust tokio 异步
- WebSocket: 消除了 ws 包依赖

## Phase R5: Computer Use 高性能层 (Week 5)

### 目标
将截屏分析、CDP 通信、图像处理迁移到 Rust

### 任务
- [ ] `native/src/screenshot.rs` — 截屏 + 图像压缩
- [ ] `native/src/cdp.rs` — Chrome DevTools Protocol WebSocket 客户端
- [ ] `native/src/image.rs` — 图像尺寸解析、base64 编解码
- [ ] `native/src/ocr.rs` — OCR 文字识别（tesseract binding）
- [ ] 在 `src/tools/computer_service.ts` 中调用 native 模块

### 预期收益
- 截屏延迟: 200ms → 50ms
- CDP 响应: 100ms → 20ms

## Phase R6: 编排与调度引擎 (Week 6)

### 目标
将工作流引擎、定时任务调度器迁移到 Rust

### 任务
- [ ] `native/src/workflow.rs` — DAG 执行引擎
- [ ] `native/src/scheduler.rs` — Cron 解析 + 调度循环
- [ ] `native/src/json.rs` — 高性能 JSON 解析（serde_json）
- [ ] 全链路 benchmark + 性能报告
- [ ] 文档更新

### 最终架构
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

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 平台兼容性 | 使用 napi-rs prebuilt binaries，覆盖 4 平台 |
| 编译时间 | Cargo workspace 增量编译，CI 缓存 |
| TS/Rust 类型不一致 | 使用 ts-rs 自动生成 TypeScript 类型 |
| 回归风险 | 所有 native 调用都有 JS fallback |
| 开发体验 | 可选依赖，不影响纯 TS 模式运行 |

## 度量指标

每个 Phase 完成后需验证：
1. `tsc --noEmit` 零错误
2. 所有现有测试通过
3. Native 模块 benchmark 报告
4. 内存占用对比报告
5. 端到端延迟对比

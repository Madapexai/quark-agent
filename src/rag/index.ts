import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface Document {
  id: string;
  filename: string;
  content: string;
  chunks: TextChunk[];
  metadata: { source: string; size: number; createdAt: number; mimeType: string };
}

export interface TextChunk {
  id: string;
  text: string;
  embedding: number[];
  documentId: string;
  index: number;
}

export interface SearchResult {
  chunk: TextChunk;
  document: Document;
  score: number;
}

export class KnowledgeBase {
  private dbPath: string;
  private documents: Map<string, Document> = new Map();
  private chunkIndex: TextChunk[] = [];

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? join(process.cwd(), ".data", "knowledge");
    mkdirSync(this.dbPath, { recursive: true });
    this.load();
  }

  /** Add a document to the knowledge base */
  async addDocument(filename: string, content: string, mimeType?: string): Promise<Document> {
    const id = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const chunks = this.chunkText(content, id);

    // Generate simple TF-IDF style embeddings (no external model needed)
    for (const chunk of chunks) {
      chunk.embedding = this.simpleEmbed(chunk.text);
    }

    const doc: Document = {
      id, filename, content, chunks,
      metadata: {
        source: filename, size: content.length,
        createdAt: Date.now(), mimeType: mimeType ?? "text/plain",
      },
    };
    this.documents.set(id, doc);
    this.chunkIndex.push(...chunks);
    this.save();
    return doc;
  }

  /** Split text into overlapping chunks */
  private chunkText(text: string, docId: string, chunkSize = 500, overlap = 50): TextChunk[] {
    const chunks: TextChunk[] = [];
    const sentences = text.split(/(?<=[.!?。！？\n])\s+/);
    let current = "";

    for (let i = 0; i < sentences.length; i++) {
      if ((current + sentences[i]).length > chunkSize && current) {
        const chunkId = `${docId}-${chunks.length}`;
        chunks.push({ id: chunkId, text: current.trim(), embedding: [], documentId: docId, index: chunks.length });
        // Overlap: keep last few words
        const words = current.split(/\s+/);
        current = words.slice(-Math.ceil(overlap / 5)).join(" ") + " " + sentences[i];
      } else {
        current += (current ? " " : "") + sentences[i];
      }
    }
    if (current.trim()) {
      chunks.push({ id: `${docId}-${chunks.length}`, text: current.trim(), embedding: [], documentId: docId, index: chunks.length });
    }
    return chunks;
  }

  /** Simple word-frequency based embedding (no external model) */
  private simpleEmbed(text: string, dims = 256): number[] {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const embedding = new Array(dims).fill(0);
    for (const word of words) {
      const hash = createHash("md5").update(word).digest();
      for (let i = 0; i < dims; i++) {
        embedding[i] += hash[i % hash.length] / 255;
      }
    }
    // Normalize
    const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0)) || 1;
    return embedding.map(v => v / norm);
  }

  /** Cosine similarity */
  private cosine(a: number[], b: number[]): number {
    let dot = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
    return dot;
  }

  /** Search the knowledge base */
  async search(query: string, topK = 5): Promise<SearchResult[]> {
    const queryEmbedding = this.simpleEmbed(query);
    const scores = this.chunkIndex.map(chunk => ({
      chunk,
      document: this.documents.get(chunk.documentId)!,
      score: this.cosine(queryEmbedding, chunk.embedding),
    }));
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK).filter(s => s.document);
  }

  /** Get context for LLM prompt (RAG) */
  async getContext(query: string, maxTokens = 2000): Promise<string> {
    const results = await this.search(query, 5);
    let context = "";
    for (const r of results) {
      const chunkText = `[${r.document.filename}] ${r.chunk.text}\n\n`;
      if ((context + chunkText).length > maxTokens * 4) break;
      context += chunkText;
    }
    return context.trim();
  }

  /** List all documents */
  listDocuments(): { id: string; filename: string; size: number; chunks: number; createdAt: number }[] {
    return Array.from(this.documents.values()).map(d => ({
      id: d.id, filename: d.filename, size: d.metadata.size,
      chunks: d.chunks.length, createdAt: d.metadata.createdAt,
    }));
  }

  /** Delete a document */
  deleteDocument(id: string): boolean {
    const doc = this.documents.get(id);
    if (!doc) return false;
    this.documents.delete(id);
    this.chunkIndex = this.chunkIndex.filter(c => c.documentId !== id);
    this.save();
    return true;
  }

  /** Clear all documents */
  clear(): void {
    this.documents.clear();
    this.chunkIndex = [];
    this.save();
  }

  private save(): void {
    const data = {
      documents: Array.from(this.documents.values()),
      chunkIndex: this.chunkIndex,
    };
    writeFileSync(join(this.dbPath, "kb.json"), JSON.stringify(data), "utf8");
  }

  private load(): void {
    try {
      const raw = readFileSync(join(this.dbPath, "kb.json"), "utf8");
      const data = JSON.parse(raw);
      for (const doc of data.documents ?? []) {
        this.documents.set(doc.id, doc);
      }
      this.chunkIndex = data.chunkIndex ?? [];
    } catch { /* first run */ }
  }
}

export const knowledgeBase = new KnowledgeBase();

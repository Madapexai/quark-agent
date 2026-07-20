/**
 * 聊天室 —— 多用户 + Agent Team 协作
 *
 * 对标 Hermes 的聊天室功能：多用户可在同一房间内与 agent team 交互。
 * 支持：
 * - 房间管理（创建/删除/列出）
 * - 成员管理（加入/离开/列出）
 * - 消息收发与搜索
 * - Agent Team 集成（绑定 Team 配置，自动触发 team run）
 * - 实时订阅（SSE 式回调）
 * - 统计聚合
 */

import type { TeamConfig, AgentFactory } from "../team/index.js";
import { AgentTeam } from "../team/index.js";
import { createHash } from "node:crypto";

// ============================================================================
// 类型定义
// ============================================================================

/** 聊天用户 */
export interface ChatUser {
  id: string;
  name: string;
  role: "admin" | "member" | "observer";
  avatar?: string;
}

/** 聊天消息 */
export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  content: string;
  type: "text" | "system" | "agent_reply" | "team_step" | "tool_call";
  timestamp: number;
  metadata?: {
    agentId?: string;
    stepIndex?: number;
    toolName?: string;
    toolInput?: unknown;
    toolOutput?: unknown;
    tokens?: number;
    cost?: number;
    latencyMs?: number;
  };
}

/** 聊天房间 */
export interface ChatRoom {
  id: string;
  name: string;
  description?: string;
  members: ChatUser[];
  /** 关联的 Team 配置 */
  teamConfig?: TeamConfig;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
}

/** 聊天室管理器选项 */
export interface ChatRoomOptions {
  /** 最大房间数，默认 100 */
  maxRooms?: number;
  /** 每房间最大消息数，默认 10000 */
  maxMessagesPerRoom?: number;
  /** 持久化路径（可选，JSONL 格式） */
  dbPath?: string;
}

// ============================================================================
// 房间内部存储结构
// ============================================================================

interface RoomData {
  room: ChatRoom;
  messages: ChatMessage[];
  subscribers: Set<(msg: ChatMessage) => void>;
}

// ============================================================================
// ChatRoomManager
// ============================================================================

export class ChatRoomManager {
  private readonly maxRooms: number;
  private readonly maxMessagesPerRoom: number;
  private readonly dbPath?: string;
  private readonly rooms: Map<string, RoomData> = new Map();
  private idCounter = 0;

  constructor(opts?: ChatRoomOptions) {
    this.maxRooms = opts?.maxRooms ?? 100;
    this.maxMessagesPerRoom = opts?.maxMessagesPerRoom ?? 10000;
    this.dbPath = opts?.dbPath;
  }

  // ==========================================================================
  // 房间管理
  // ==========================================================================

  /** 创建房间 */
  createRoom(name: string, description?: string): ChatRoom {
    if (this.rooms.size >= this.maxRooms) {
      throw new Error(`已达到最大房间数 ${this.maxRooms}，无法创建新房间`);
    }
    const id = this.genId();
    const now = Date.now();
    const room: ChatRoom = {
      id,
      name,
      description,
      members: [],
      createdAt: now,
      lastActivityAt: now,
      messageCount: 0,
    };
    const data: RoomData = {
      room,
      messages: [],
      subscribers: new Set(),
    };
    this.rooms.set(id, data);

    // 系统消息：房间已创建
    this.pushSystemMessage(id, `房间「${name}」已创建`);

    return room;
  }

  /** 获取房间 */
  getRoom(roomId: string): ChatRoom | undefined {
    return this.rooms.get(roomId)?.room;
  }

  /** 列出所有房间 */
  listRooms(): ChatRoom[] {
    return Array.from(this.rooms.values()).map((d) => d.room);
  }

  /** 删除房间 */
  deleteRoom(roomId: string): boolean {
    const data = this.rooms.get(roomId);
    if (!data) return false;
    // 通知订阅者房间即将删除
    this.pushSystemMessage(roomId, "房间已删除");
    data.subscribers.clear();
    return this.rooms.delete(roomId);
  }

  // ==========================================================================
  // 成员管理
  // ==========================================================================

  /** 加入房间 */
  joinRoom(roomId: string, user: ChatUser): boolean {
    const data = this.rooms.get(roomId);
    if (!data) return false;
    // 检查是否已在房间中
    if (data.room.members.some((m) => m.id === user.id)) return false;
    data.room.members.push(user);
    data.room.lastActivityAt = Date.now();
    this.pushSystemMessage(roomId, `${user.name} 加入了房间`);
    return true;
  }

  /** 离开房间 */
  leaveRoom(roomId: string, userId: string): boolean {
    const data = this.rooms.get(roomId);
    if (!data) return false;
    const idx = data.room.members.findIndex((m) => m.id === userId);
    if (idx === -1) return false;
    const user = data.room.members[idx];
    data.room.members.splice(idx, 1);
    data.room.lastActivityAt = Date.now();
    this.pushSystemMessage(roomId, `${user.name} 离开了房间`);
    return true;
  }

  /** 列出房间成员 */
  listMembers(roomId: string): ChatUser[] {
    const data = this.rooms.get(roomId);
    if (!data) return [];
    return [...data.room.members];
  }

  // ==========================================================================
  // 消息
  // ==========================================================================

  /** 发送消息 */
  sendMessage(roomId: string, userId: string, content: string): ChatMessage {
    const data = this.rooms.get(roomId);
    if (!data) throw new Error(`房间 ${roomId} 不存在`);
    // 检查用户是否在房间中
    const user = data.room.members.find((m) => m.id === userId);
    if (!user) throw new Error(`用户 ${userId} 不在房间 ${roomId} 中`);

    const msg: ChatMessage = {
      id: this.genId(),
      roomId,
      userId,
      content,
      type: "text",
      timestamp: Date.now(),
    };

    this.addMessage(data, msg);
    return msg;
  }

  /** 获取消息历史 */
  getMessages(
    roomId: string,
    opts?: { limit?: number; before?: number; after?: number },
  ): ChatMessage[] {
    const data = this.rooms.get(roomId);
    if (!data) return [];

    let msgs = data.messages;

    // 按时间范围过滤
    if (opts?.before) {
      msgs = msgs.filter((m) => m.timestamp < opts.before!);
    }
    if (opts?.after) {
      msgs = msgs.filter((m) => m.timestamp > opts.after!);
    }

    // 按 timestamp 排序（升序）
    msgs = msgs.sort((a, b) => a.timestamp - b.timestamp);

    // 限制数量（取最新的 N 条）
    if (opts?.limit && msgs.length > opts.limit) {
      msgs = msgs.slice(msgs.length - opts.limit);
    }

    return msgs;
  }

  /** 搜索消息（简单的子串匹配） */
  searchMessages(roomId: string, query: string, limit?: number): ChatMessage[] {
    const data = this.rooms.get(roomId);
    if (!data) return [];

    const lowerQuery = query.toLowerCase();
    const results = data.messages.filter((m) =>
      m.content.toLowerCase().includes(lowerQuery),
    );

    // 按时间降序（最新的在前）
    results.sort((a, b) => b.timestamp - a.timestamp);

    return limit ? results.slice(0, limit) : results;
  }

  // ==========================================================================
  // Agent Team 集成
  // ==========================================================================

  /** 绑定 Team 配置到房间 */
  bindTeam(roomId: string, teamConfig: TeamConfig): void {
    const data = this.rooms.get(roomId);
    if (!data) throw new Error(`房间 ${roomId} 不存在`);
    data.room.teamConfig = teamConfig;
    data.room.lastActivityAt = Date.now();
    this.pushSystemMessage(
      roomId,
      `已绑定 Team（模式: ${teamConfig.mode}，成员: ${teamConfig.members.map((m) => m.name).join(", ")}）`,
    );
  }

  /** 解绑 Team */
  unbindTeam(roomId: string): void {
    const data = this.rooms.get(roomId);
    if (!data) throw new Error(`房间 ${roomId} 不存在`);
    data.room.teamConfig = undefined;
    data.room.lastActivityAt = Date.now();
    this.pushSystemMessage(roomId, "已解绑 Team");
  }

  /** 让 agent 处理消息（自动触发 team run） */
  async processWithTeam(
    roomId: string,
    inputMessageId: string,
    factory: AgentFactory,
  ): Promise<ChatMessage[]> {
    const data = this.rooms.get(roomId);
    if (!data) throw new Error(`房间 ${roomId} 不存在`);
    if (!data.room.teamConfig) {
      throw new Error(`房间 ${roomId} 未绑定 Team 配置`);
    }

    // 取出输入消息
    const inputMsg = data.messages.find((m) => m.id === inputMessageId);
    if (!inputMsg) {
      throw new Error(`消息 ${inputMessageId} 不存在`);
    }

    const team = new AgentTeam(data.room.teamConfig, factory);
    const resultMsgs: ChatMessage[] = [];

    // 使用 stream 模式，逐步生成 ChatMessage
    for await (const step of team.stream(inputMsg.content)) {
      if ("type" in step && step.type === "final") {
        // 最终答案 → agent_reply 消息
        const finalResult = step.result;
        const replyMsg: ChatMessage = {
          id: this.genId(),
          roomId,
          userId: "system",
          content: finalResult.output,
          type: "agent_reply",
          timestamp: Date.now(),
          metadata: {
            tokens: finalResult.totalTokens,
            latencyMs: finalResult.totalMs,
          },
        };
        this.addMessage(data, replyMsg);
        resultMsgs.push(replyMsg);
      } else if ("memberId" in step) {
        // 中间步骤 → team_step 消息
        const stepMsg: ChatMessage = {
          id: this.genId(),
          roomId,
          userId: "system",
          content: step.output,
          type: "team_step",
          timestamp: Date.now(),
          metadata: {
            agentId: step.memberId,
            stepIndex: step.index,
            latencyMs: step.ms,
          },
        };
        this.addMessage(data, stepMsg);
        resultMsgs.push(stepMsg);
      }
    }

    return resultMsgs;
  }

  // ==========================================================================
  // 实时订阅
  // ==========================================================================

  /** 订阅房间消息，返回取消订阅函数 */
  subscribe(roomId: string, callback: (msg: ChatMessage) => void): () => void {
    const data = this.rooms.get(roomId);
    if (!data) throw new Error(`房间 ${roomId} 不存在`);
    data.subscribers.add(callback);
    // 返回取消订阅函数
    return () => {
      data.subscribers.delete(callback);
    };
  }

  // ==========================================================================
  // 统计
  // ==========================================================================

  /** 获取房间统计信息 */
  getStats(roomId: string): {
    messageCount: number;
    agentReplyCount: number;
    avgLatencyMs: number;
    totalTokens: number;
    totalCost: number;
    topContributors: Array<{ userId: string; name: string; count: number }>;
  } {
    const data = this.rooms.get(roomId);
    if (!data) {
      return {
        messageCount: 0,
        agentReplyCount: 0,
        avgLatencyMs: 0,
        totalTokens: 0,
        totalCost: 0,
        topContributors: [],
      };
    }

    const messages = data.messages;
    const agentReplies = messages.filter((m) => m.type === "agent_reply");

    // 平均延迟（从 agent_reply 的 metadata 中聚合）
    const latencies = agentReplies
      .map((m) => m.metadata?.latencyMs ?? 0)
      .filter((l) => l > 0);
    const avgLatencyMs =
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : 0;

    // 总 token 数
    const totalTokens = agentReplies.reduce(
      (sum, m) => sum + (m.metadata?.tokens ?? 0),
      0,
    );

    // 总费用
    const totalCost = agentReplies.reduce(
      (sum, m) => sum + (m.metadata?.cost ?? 0),
      0,
    );

    // 按用户统计消息数（排除系统消息）
    const userCounts: Record<string, { name: string; count: number }> = {};
    for (const m of messages) {
      if (m.userId === "system") continue;
      if (!userCounts[m.userId]) {
        const member = data.room.members.find((u) => u.id === m.userId);
        userCounts[m.userId] = {
          name: member?.name ?? m.userId,
          count: 0,
        };
      }
      userCounts[m.userId].count++;
    }
    // 排序取 top
    const topContributors = Object.entries(userCounts)
      .map(([userId, v]) => ({ userId, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      messageCount: messages.length,
      agentReplyCount: agentReplies.length,
      avgLatencyMs,
      totalTokens,
      totalCost,
      topContributors,
    };
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  /** 生成唯一 ID */
  private genId(): string {
    this.idCounter = (this.idCounter + 1) % 0x10000;
    const hash = createHash("sha256")
      .update(`${Date.now()}-${this.idCounter}-${Math.random()}`)
      .digest("hex")
      .slice(0, 16);
    return hash;
  }

  /** 添加消息到房间，并通知订阅者 */
  private addMessage(data: RoomData, msg: ChatMessage): void {
    data.messages.push(msg);
    data.room.messageCount = data.messages.length;
    data.room.lastActivityAt = msg.timestamp;

    // 超过最大消息数时，丢弃最早的消息
    if (data.messages.length > this.maxMessagesPerRoom) {
      data.messages.splice(0, data.messages.length - this.maxMessagesPerRoom);
      data.room.messageCount = data.messages.length;
    }

    // 通知所有订阅者
    for (const cb of data.subscribers) {
      try {
        cb(msg);
      } catch {
        // 订阅者回调出错时不影响其他订阅者
      }
    }

    // 持久化（如果配置了 dbPath）
    if (this.dbPath) {
      this.persistMessage(data.room.id, msg);
    }
  }

  /** 推送系统消息 */
  private pushSystemMessage(roomId: string, content: string): void {
    const data = this.rooms.get(roomId);
    if (!data) return;
    const msg: ChatMessage = {
      id: this.genId(),
      roomId,
      userId: "system",
      content,
      type: "system",
      timestamp: Date.now(),
    };
    this.addMessage(data, msg);
  }

  /** 持久化单条消息到 JSONL 文件 */
  private persistMessage(roomId: string, msg: ChatMessage): void {
    if (!this.dbPath) return;
    // 延迟导入 fs 避免不使用持久化时的开销
    try {
      const { appendFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
      const { dirname } = require("node:path") as typeof import("node:path");
      const filePath = `${this.dbPath}/chatroom-${roomId}.jsonl`;
      mkdirSync(dirname(filePath), { recursive: true });
      appendFileSync(filePath, JSON.stringify(msg) + "\n", "utf-8");
    } catch {
      // 持久化失败不影响内存操作
    }
  }
}

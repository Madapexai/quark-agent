/**
 * 用户认证模块
 *
 * 提供 JWT 签发/验证、用户注册/登录、密码哈希。
 * 仅依赖 Node 内置 crypto，不引入 jose 等第三方库。
 *
 * - 密码：SHA-256 哈希
 * - Token：简化 JWT（base64 编码的 header.payload.signature）
 * - 签名：HMAC-SHA256
 * - 用户数据：JSON 文件（.quark-users.json）
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// 类型
// ============================================================================

export interface AuthUser {
  id: string;
  username: string;
  passwordHash: string;
  role: "admin" | "user";
  createdAt: number;
}

export interface AuthToken {
  userId: string;
  username: string;
  role: "admin" | "user";
  exp: number;
}

type UserSafe = Pick<AuthUser, "id" | "username" | "role">;
type UserListItem = Pick<AuthUser, "id" | "username" | "role" | "createdAt">;

// ============================================================================
// 常量
// ============================================================================

/** JWT 有效期：7 天（毫秒） */
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000;

/** HMAC 签名密钥：启动时随机生成，进程重启后旧 token 失效 */
const SECRET_KEY = crypto.randomBytes(32).toString("hex");

/** JWT header 固定值 */
const JWT_HEADER = { alg: "HS256", typ: "JWT" };

// ============================================================================
// 工具函数
// ============================================================================

/** URL-safe Base64 编码 */
function b64Encode(data: string): string {
  return Buffer.from(data, "utf8").toString("base64url");
}

/** URL-safe Base64 解码 */
function b64Decode(str: string): string {
  return Buffer.from(str, "base64url").toString("utf8");
}

/** SHA-256 哈希 */
function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

/** HMAC-SHA256 签名 */
function hmacSign(payload: string): string {
  return crypto.createHmac("sha256", SECRET_KEY).update(payload).digest("base64url");
}

// ============================================================================
// AuthManager
// ============================================================================

export class AuthManager {
  private readonly dbPath: string;
  private users: Map<string, AuthUser> = new Map();
  private dirty = false;

  constructor(userDbPath?: string) {
    this.dbPath = userDbPath ?? path.join(process.cwd(), ".quark-users.json");
    this.load();
  }

  // ---------------------------------------------------------------------------
  // 注册
  // ---------------------------------------------------------------------------

  register(username: string, password: string): { token: string; user: UserSafe } {
    // 校验
    if (!username || username.length < 2) {
      throw new AuthError("invalid_username", "用户名至少 2 个字符");
    }
    if (!password || password.length < 4) {
      throw new AuthError("invalid_password", "密码至少 4 个字符");
    }
    // 检查重复
    for (const u of this.users.values()) {
      if (u.username === username) {
        throw new AuthError("duplicate_username", "用户名已存在");
      }
    }

    const id = crypto.randomUUID();
    const isFirst = this.users.size === 0;
    const user: AuthUser = {
      id,
      username,
      passwordHash: hashPassword(password),
      role: isFirst ? "admin" : "user",
      createdAt: Date.now(),
    };
    this.users.set(id, user);
    this.dirty = true;
    this.save();

    const token = this.signToken({ userId: id, username, role: user.role });
    return { token, user: { id, username, role: user.role } };
  }

  // ---------------------------------------------------------------------------
  // 登录
  // ---------------------------------------------------------------------------

  login(username: string, password: string): { token: string; user: UserSafe } | null {
    const hashed = hashPassword(password);
    for (const u of this.users.values()) {
      if (u.username === username && u.passwordHash === hashed) {
        const token = this.signToken({ userId: u.id, username: u.username, role: u.role });
        return { token, user: { id: u.id, username: u.username, role: u.role } };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 验证 token
  // ---------------------------------------------------------------------------

  verify(token: string): UserSafe | null {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return null;

      // 验签
      const signatureInput = `${parts[0]}.${parts[1]}`;
      const expectedSig = hmacSign(signatureInput);
      if (parts[2] !== expectedSig) return null;

      // 解码 payload
      const payload: AuthToken = JSON.parse(b64Decode(parts[1]));

      // 过期检查
      if (Date.now() > payload.exp) return null;

      // 用户是否仍存在
      const user = this.users.get(payload.userId);
      if (!user) return null;

      return { id: user.id, username: user.username, role: user.role };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // 列出用户
  // ---------------------------------------------------------------------------

  listUsers(): UserListItem[] {
    return Array.from(this.users.values()).map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      createdAt: u.createdAt,
    }));
  }

  // ---------------------------------------------------------------------------
  // 内部方法
  // ---------------------------------------------------------------------------

  /** 签发 JWT */
  private signToken(payload: Omit<AuthToken, "exp">): string {
    const fullPayload: AuthToken = {
      ...payload,
      exp: Date.now() + TOKEN_TTL,
    };
    const headerB64 = b64Encode(JSON.stringify(JWT_HEADER));
    const payloadB64 = b64Encode(JSON.stringify(fullPayload));
    const signatureInput = `${headerB64}.${payloadB64}`;
    const signature = hmacSign(signatureInput);
    return `${headerB64}.${payloadB64}.${signature}`;
  }

  /** 从磁盘加载用户数据 */
  private load(): void {
    try {
      if (fs.existsSync(this.dbPath)) {
        const raw = fs.readFileSync(this.dbPath, "utf8");
        const arr = JSON.parse(raw) as AuthUser[];
        for (const u of arr) {
          this.users.set(u.id, u);
        }
      }
    } catch {
      // 文件不存在或格式错误，从空开始
    }
  }

  /** 持久化到磁盘（写入后清脏标记） */
  private save(): void {
    if (!this.dirty) return;
    try {
      const arr = Array.from(this.users.values());
      fs.writeFileSync(this.dbPath, JSON.stringify(arr, null, 2), "utf8");
      this.dirty = false;
    } catch (err) {
      console.error("[auth] 写入用户数据失败:", err);
    }
  }
}

// ============================================================================
// 错误
// ============================================================================

export class AuthError extends Error {
  constructor(
    public readonly code: "invalid_username" | "invalid_password" | "duplicate_username",
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

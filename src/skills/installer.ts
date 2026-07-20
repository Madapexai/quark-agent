/**
 * Skill 安装器：从 npm / GitHub / 本地路径 / URL 安装 skill
 *
 * 设计（对标 Hermes skill marketplace）：
 * - 自动检测来源：本地路径 / URL / GitHub user/repo / npm 包名
 * - 验证 skill manifest（quark-skill.json 或 package.json 的 quark-skill 字段）
 * - 递归安装依赖 skill
 * - 卸载时清理无人引用的依赖
 * - 从 npm registry 搜索带 quark-skill 关键词的包
 *
 * 零 npm 依赖，仅用 Node 内建模块 + 系统 git/unzip 命令。
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { gunzipSync } from "node:zlib";

// ============================================================================
// 类型定义
// ============================================================================

export type SkillSource = "npm" | "github" | "local" | "url" | "builtin";

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  /** 依赖的其他 skill */
  dependencies?: string[];
  /** 提供的工具 */
  tools?: string[];
  /** 需要的环境变量 */
  envKeys?: string[];
  /** 入口文件 */
  entry?: string;
  /** 主页 */
  homepage?: string;
}

export interface InstallResult {
  name: string;
  version: string;
  source: SkillSource;
  installedAt: string;
  manifest: SkillManifest;
  /** 安装的依赖 */
  dependenciesInstalled: string[];
}

export interface SkillInstallerOptions {
  /** 插件目录，默认 ./.quark-plugins/ */
  pluginsDir?: string;
  /** 是否自动安装依赖 */
  autoResolveDeps?: boolean;
}

// ============================================================================
// 常量
// ============================================================================

/** skill manifest 文件名（按优先级尝试） */
const MANIFEST_FILENAMES = ["quark-skill.json", "skill.json"];

/** 安装元数据文件名（记录 source / installedAt / dependenciesInstalled） */
const INSTALL_META_FILE = ".install-meta.json";

// ============================================================================
// SkillInstaller
// ============================================================================

export class SkillInstaller {
  private readonly pluginsDir: string;
  private readonly autoResolveDeps: boolean;

  constructor(opts: SkillInstallerOptions = {}) {
    this.pluginsDir = opts.pluginsDir ?? join(process.cwd(), ".quark-plugins");
    this.autoResolveDeps = opts.autoResolveDeps ?? true;
  }

  // --------------------------------------------------------------------------
  // 公开 API
  // --------------------------------------------------------------------------

  /** 安装 skill（自动检测来源） */
  async install(packageSpec: string): Promise<InstallResult> {
    // 1. 本地路径：./xxx 或 /abs/path 或 .\xxx 或 C:\
    if (
      packageSpec.startsWith(".") ||
      packageSpec.startsWith("/") ||
      /^[A-Z]:\\/.test(packageSpec)
    ) {
      return this.installFromLocal(packageSpec);
    }

    // 2. URL：http:// 或 https://
    if (/^https?:\/\//.test(packageSpec)) {
      if (
        packageSpec.endsWith(".zip") ||
        packageSpec.endsWith(".tar.gz") ||
        packageSpec.endsWith(".tgz")
      ) {
        return this.installFromUrl(packageSpec);
      }
      // GitHub URL：提取 user/repo
      const ghMatch = packageSpec.match(/github\.com\/([^/]+\/[^/]+)/);
      if (ghMatch) return this.installFromGithub(ghMatch[1]);
    }

    // 3. GitHub user/repo（不含 @，避免与 npm scope 包混淆）
    if (/^[\w.-]+\/[\w.-]+$/.test(packageSpec) && !packageSpec.startsWith("@")) {
      return this.installFromGithub(packageSpec);
    }

    // 4. npm（默认）
    return this.installFromNpm(packageSpec);
  }

  /** 从 npm 安装（用 npm pack 下载 tgz，解压后读 manifest） */
  async installFromNpm(packageName: string, version?: string): Promise<InstallResult> {
    const spec = version ? `${packageName}@${version}` : packageName;
    const tmpDir = mkdtempSync(join(tmpdir(), "quark-skill-"));
    try {
      // npm pack 下载 tgz（不实际安装到 node_modules）
      const tgzName = execSync(`npm pack ${this.shellQuote(spec)}`, {
        cwd: tmpDir,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
      }).trim();
      const tgzPath = join(tmpDir, tgzName);

      // 解压 tgz：先 gunzip 再提取 tar
      const extractDir = join(tmpDir, "extracted");
      mkdirSync(extractDir, { recursive: true });
      const tarBuffer = gunzipSync(readFileSync(tgzPath));
      this.extractTar(tarBuffer, extractDir);

      // npm pack 内容在 package/ 子目录下
      const manifestDir = this.findManifestDir(extractDir);
      const manifest = this.readManifest(manifestDir);

      return await this.finalizeInstall(manifest, "npm", manifestDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /** 从 GitHub 安装（git clone --depth 1） */
  async installFromGithub(repo: string, branch?: string): Promise<InstallResult> {
    // 去掉可能的 .git 后缀
    const cleanRepo = repo.replace(/\.git$/, "");
    const url = `https://github.com/${cleanRepo}.git`;
    const tmpDir = mkdtempSync(join(tmpdir(), "quark-skill-"));
    try {
      const branchArg = branch ? `--branch ${this.shellQuote(branch)}` : "";
      execSync(`git clone --depth 1 ${branchArg} ${this.shellQuote(url)} repo`, {
        cwd: tmpDir,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
      });
      const repoDir = join(tmpDir, "repo");
      const manifest = this.readManifest(repoDir);

      return await this.finalizeInstall(manifest, "github", repoDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /** 从本地路径安装（cpSync 复制到 pluginsDir） */
  async installFromLocal(localPath: string): Promise<InstallResult> {
    if (!existsSync(localPath)) {
      throw new Error(`Local path not found: ${localPath}`);
    }
    const manifest = this.readManifest(localPath);
    return await this.finalizeInstall(manifest, "local", localPath);
  }

  /** 从 URL 安装（zip 用 unzip 命令，tar.gz/tgz 用 Node zlib + 纯 TS tar 提取） */
  async installFromUrl(url: string): Promise<InstallResult> {
    const tmpDir = mkdtempSync(join(tmpdir(), "quark-skill-"));
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const extractDir = join(tmpDir, "extracted");
      mkdirSync(extractDir, { recursive: true });

      if (url.endsWith(".zip")) {
        // zip：用系统 unzip 命令解压
        const zipPath = join(tmpDir, "download.zip");
        writeFileSync(zipPath, buf);
        execSync(`unzip -o ${this.shellQuote(zipPath)} -d ${this.shellQuote(extractDir)}`, {
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 30_000,
        });
      } else {
        // tar.gz / .tgz：Node zlib 解压 + 纯 TS tar 提取
        const tarBuffer = gunzipSync(buf);
        this.extractTar(tarBuffer, extractDir);
      }

      const manifestDir = this.findManifestDir(extractDir);
      const manifest = this.readManifest(manifestDir);

      return await this.finalizeInstall(manifest, "url", manifestDir);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /** 卸载（移除目录 + 清理无人引用的依赖） */
  async uninstall(name: string): Promise<boolean> {
    const skillDir = join(this.pluginsDir, name);
    if (!existsSync(skillDir)) return false;

    // 读取 manifest 获取依赖列表（在删除前读取）
    const manifest = this.tryReadManifest(skillDir);
    rmSync(skillDir, { recursive: true, force: true });

    // 清理无人引用的依赖
    if (manifest?.dependencies && manifest.dependencies.length > 0) {
      const installed = this.list();
      for (const dep of manifest.dependencies) {
        // 检查是否还有其他已安装 skill 依赖它
        const stillNeeded = installed.some(
          (s) => s.name !== name && s.dependencies?.includes(dep),
        );
        if (!stillNeeded) {
          await this.uninstall(dep).catch(() => false);
        }
      }
    }

    return true;
  }

  /** 列出已安装 */
  list(): Array<SkillManifest & { source: SkillSource; installedAt: string; path: string }> {
    if (!existsSync(this.pluginsDir)) return [];
    const entries = readdirSync(this.pluginsDir, { withFileTypes: true });
    const result: Array<SkillManifest & { source: SkillSource; installedAt: string; path: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillDir = join(this.pluginsDir, entry.name);
      const manifest = this.tryReadManifest(skillDir);
      if (!manifest) continue;
      const meta = this.readInstallMeta(skillDir);
      result.push({
        ...manifest,
        source: meta.source ?? "local",
        installedAt: meta.installedAt ?? new Date(0).toISOString(),
        path: skillDir,
      });
    }
    return result;
  }

  /** 搜索（npm registry，按 quark-skill 关键词过滤） */
  async search(
    query: string,
  ): Promise<Array<{ name: string; version: string; description: string; downloads: number }>> {
    const text = `keywords:quark-skill ${query}`.trim();
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=20`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      return [];
    }
    if (!res.ok) return [];
    const data = (await res.json()) as {
      objects: Array<{
        package: { name: string; version: string; description?: string };
      }>;
    };

    const results = data.objects.map((o) => ({
      name: o.package.name,
      version: o.package.version,
      description: o.package.description ?? "",
    }));

    // 并行获取上周下载量
    const downloads = await Promise.all(
      results.map(async (r) => {
        try {
          const dlRes = await fetch(
            `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(r.name)}`,
          );
          if (!dlRes.ok) return 0;
          const dlData = (await dlRes.json()) as { downloads?: number };
          return dlData.downloads ?? 0;
        } catch {
          return 0;
        }
      }),
    );

    return results.map((r, i) => ({ ...r, downloads: downloads[i] }));
  }

  /** 验证 manifest（类型守卫） */
  validateManifest(manif: unknown): manif is SkillManifest {
    if (typeof manif !== "object" || manif === null) return false;
    const m = manif as Record<string, unknown>;
    return (
      typeof m.name === "string" &&
      typeof m.version === "string" &&
      typeof m.description === "string"
    );
  }

  // --------------------------------------------------------------------------
  // 内部方法
  // --------------------------------------------------------------------------

  /** 完成安装：复制到 pluginsDir + 写元数据 + 递归安装依赖 */
  private async finalizeInstall(
    manifest: SkillManifest,
    source: SkillSource,
    srcDir: string,
  ): Promise<InstallResult> {
    mkdirSync(this.pluginsDir, { recursive: true });
    const destDir = join(this.pluginsDir, manifest.name);

    // 如已存在先移除（重新安装）
    if (existsSync(destDir)) {
      rmSync(destDir, { recursive: true, force: true });
    }

    // 复制源文件到目标目录
    cpSync(srcDir, destDir, { recursive: true });

    // 递归安装依赖
    const depsInstalled: string[] = [];
    if (this.autoResolveDeps && manifest.dependencies && manifest.dependencies.length > 0) {
      for (const dep of manifest.dependencies) {
        try {
          // 已安装则跳过
          const depDir = join(this.pluginsDir, dep);
          if (existsSync(depDir)) {
            depsInstalled.push(dep);
            continue;
          }
          const depResult = await this.install(dep);
          depsInstalled.push(depResult.name);
        } catch {
          // 依赖安装失败不中断主流程
        }
      }
    }

    // 写安装元数据
    const installedAt = new Date().toISOString();
    this.writeInstallMeta(destDir, { source, installedAt, dependenciesInstalled: depsInstalled });

    return {
      name: manifest.name,
      version: manifest.version,
      source,
      installedAt,
      manifest,
      dependenciesInstalled: depsInstalled,
    };
  }

  /** 读取 manifest（必须存在且有效，否则抛错） */
  private readManifest(dir: string): SkillManifest {
    // 1. 尝试 quark-skill.json / skill.json
    for (const name of MANIFEST_FILENAMES) {
      const p = join(dir, name);
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, "utf8"));
        if (this.validateManifest(raw)) return raw as SkillManifest;
      }
    }
    // 2. 回退到 package.json 的 quark-skill 字段
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      const qs = (pkg["quark-skill"] ?? {}) as Record<string, unknown>;
      // author 可能是字符串或 { name, email, url } 对象
      const authorRaw = pkg.author;
      const author =
        typeof authorRaw === "string"
          ? authorRaw
          : typeof authorRaw === "object" && authorRaw !== null
            ? (authorRaw as { name?: string }).name
            : undefined;
      const manif: SkillManifest = {
        name: (qs.name ?? pkg.name) as string,
        version: (qs.version ?? pkg.version) as string,
        description: (qs.description ?? pkg.description) as string,
        author,
        dependencies: qs.dependencies as string[] | undefined,
        tools: qs.tools as string[] | undefined,
        envKeys: qs.envKeys as string[] | undefined,
        entry: (qs.entry ?? pkg.main) as string | undefined,
        homepage: pkg.homepage as string | undefined,
      };
      if (this.validateManifest(manif)) return manif;
    }
    throw new Error(`No valid skill manifest found in ${dir}`);
  }

  /** 尝试读取 manifest（无效时返回 undefined） */
  private tryReadManifest(dir: string): SkillManifest | undefined {
    try {
      return this.readManifest(dir);
    } catch {
      return undefined;
    }
  }

  /** 在解压目录中查找包含 manifest 的目录 */
  private findManifestDir(extractDir: string): string {
    // 1. 直接在解压目录
    if (this.hasManifest(extractDir)) return extractDir;
    // 2. package/ 子目录（npm pack 惯例）
    const packageDir = join(extractDir, "package");
    if (existsSync(packageDir) && this.hasManifest(packageDir)) return packageDir;
    // 3. 任意单层子目录
    const entries = readdirSync(extractDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = join(extractDir, entry.name);
      if (this.hasManifest(subDir)) return subDir;
    }
    // 4. 回退到解压目录本身（让 readManifest 抛出更明确的错误）
    return extractDir;
  }

  /** 检查目录中是否存在 manifest 文件 */
  private hasManifest(dir: string): boolean {
    for (const name of MANIFEST_FILENAMES) {
      if (existsSync(join(dir, name))) return true;
    }
    return existsSync(join(dir, "package.json"));
  }

  /** 读取安装元数据 */
  private readInstallMeta(dir: string): {
    source?: SkillSource;
    installedAt?: string;
    dependenciesInstalled?: string[];
  } {
    const p = join(dir, INSTALL_META_FILE);
    if (!existsSync(p)) return {};
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return {};
    }
  }

  /** 写入安装元数据 */
  private writeInstallMeta(
    dir: string,
    meta: { source: SkillSource; installedAt: string; dependenciesInstalled: string[] },
  ): void {
    writeFileSync(join(dir, INSTALL_META_FILE), JSON.stringify(meta, null, 2), "utf8");
  }

  /**
   * 纯 TS tar 提取（支持 ustar 格式，npm pack 产生的就是这种）
   * tar 格式：512 字节 header + 数据（按 512 对齐），两块全零 header 结束
   */
  private extractTar(buffer: Buffer, destDir: string): void {
    let offset = 0;
    while (offset + 512 <= buffer.length) {
      const header = buffer.subarray(offset, offset + 512);
      const nameRaw = header.subarray(0, 100).toString("utf8").replace(/\0/g, "");
      if (!nameRaw) break; // 全零 header = 归档结束
      const sizeStr = header.subarray(124, 136).toString("utf8").replace(/\0/g, "").trim();
      const size = parseInt(sizeStr || "0", 8);
      const typeflag = header.subarray(156, 157).toString("utf8").replace(/\0/g, "");
      offset += 512;

      // 安全过滤：移除 .. 和 . 组件，防止路径穿越
      const safeName = nameRaw
        .split("/")
        .filter((p) => p !== ".." && p !== "." && p !== "")
        .join("/");
      if (!safeName) {
        offset += Math.ceil(size / 512) * 512;
        continue;
      }

      if (size > 0 && (typeflag === "" || typeflag === "0")) {
        // 普通文件
        const filePath = join(destDir, safeName);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, buffer.subarray(offset, offset + size));
      } else if (typeflag === "5" || safeName.endsWith("/")) {
        // 目录
        mkdirSync(join(destDir, safeName), { recursive: true });
      }
      // 跳到下一个 512 字节对齐边界
      offset += Math.ceil(size / 512) * 512;
    }
  }

  /** shell 引用（简易实现，防止路径含空格或特殊字符） */
  private shellQuote(s: string): string {
    if (/^[A-Za-z0-9_./:@-]+$/.test(s)) return s;
    return `"${s.replace(/"/g, '\\"')}"`;
  }
}

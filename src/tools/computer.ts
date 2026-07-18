/**
 * Computer Use：轻量屏幕控制（截屏 + 鼠标 + 键盘）
 *
 * 对标 Claude Computer Use / Codex computer use。
 * 轻量方案：用系统命令，不引重依赖。
 * - macOS: screencapture(截屏) + cliclick(鼠标键盘)
 * - Linux: scrot/xdotool
 * - Windows: 不支持（返回提示）
 * 命令不存在时降级返回提示，不报错。
 */

import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool, ToolContext, ToolSchema } from "../core/types.js";

export class ComputerUseTool implements Tool {
  readonly name = "computer_use";
  readonly description = "屏幕控制：截屏/点击/输入/按键。用系统命令，macOS 需 cliclick，Linux 需 xdotool+scrot。";
  readonly schema: ToolSchema = {
    type: "function",
    function: {
      name: "computer_use",
      description: this.description,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["screenshot", "click", "double_click", "type", "key", "move", "scroll"], description: "操作类型" },
          x: { type: "number", description: "click/move 时的 x 坐标" },
          y: { type: "number", description: "click/move 时的 y 坐标" },
          text: { type: "string", description: "type 时的输入文本" },
          key: { type: "string", description: "key 时的按键，如 Enter/Escape/ctrl+c" },
          button: { type: "string", enum: ["left", "right", "middle"], description: "鼠标按键，默认 left" },
        },
        required: ["action"],
      },
    },
  };

  private platform = process.platform;

  async execute(args: { action: string; x?: number; y?: number; text?: string; key?: string; button?: string }, _ctx: ToolContext): Promise<string> {
    if (this.platform === "win32") return "[error] Windows 暂不支持 computer_use，请用 macOS/Linux";

    try {
      switch (args.action) {
        case "screenshot": return await this.screenshot();
        case "click":
        case "double_click": return this.click(args.x!, args.y!, args.action === "double_click", args.button);
        case "move": return this.move(args.x!, args.y!);
        case "type": return this.type(args.text!);
        case "key": return this.key(args.key!);
        case "scroll": return this.scroll(args.x ?? 0, args.y ?? 0);
        default: return `[error] 未知 action: ${args.action}`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("command not found")) {
        return `[error] 缺少系统命令。macOS: brew install cliclick；Linux: apt install xdotool scrot。详情: ${msg}`;
      }
      return `[error] ${msg}`;
    }
  }

  private async screenshot(): Promise<string> {
    const path = join(tmpdir(), `screenshot-${Date.now()}.png`);
    const cmd = this.platform === "darwin" ? `screencapture -x "${path}"` : `scrot "${path}"`;
    execSync(cmd, { timeout: 5000 });
    return `[ok] 截图已保存: ${path}`;
  }

  private click(x: number, y: number, double: boolean, button?: string): string {
    const btn = button === "right" ? "right" : "left";
    if (this.platform === "darwin") {
      execSync(double ? `cliclick c:${x},${y} c:${x},${y}` : (button === "right" ? `cliclick rc:${x},${y}` : `cliclick c:${x},${y}`), { timeout: 3000 });
      return `[ok] ${double ? "双" : ""}点击 (${x},${y}) ${btn}`;
    }
    const btnFlag = button === "right" ? "3" : "1";
    execSync(`xdotool mousemove ${x} ${y} ${double ? "click --repeat 2" : "click"} ${double ? "" : btnFlag}`.trim(), { timeout: 3000 });
    return `[ok] ${double ? "双" : ""}点击 (${x},${y}) ${btn}`;
  }

  private move(x: number, y: number): string {
    const cmd = this.platform === "darwin" ? `cliclick m:${x},${y}` : `xdotool mousemove ${x} ${y}`;
    execSync(cmd, { timeout: 3000 });
    return `[ok] 移动到 (${x},${y})`;
  }

  private type(text: string): string {
    const escaped = text.replace(/"/g, '\\"');
    const cmd = this.platform === "darwin" ? `cliclick t:"${escaped}"` : `xdotool type "${escaped}"`;
    execSync(cmd, { timeout: 5000 });
    return `[ok] 输入 ${text.length} 字符`;
  }

  private key(key: string): string {
    // ctrl+c → ctrl+c 映射到各平台
    const cmd = this.platform === "darwin" ? `cliclick kp:${this.mapKeyDarwin(key)}` : `xdotool key ${this.mapKeyLinux(key)}`;
    execSync(cmd, { timeout: 3000 });
    return `[ok] 按键 ${key}`;
  }

  private scroll(dx: number, dy: number): string {
    const cmd = this.platform === "darwin" ? `cliclick "kd:cmd scroll:${dy},${dx} ku:cmd"` : `xdotool click ${dy > 0 ? "4" : "5"}`;
    execSync(cmd, { timeout: 3000 });
    return `[ok] 滚动 (${dx},${dy})`;
  }

  private mapKeyDarwin(key: string): string {
    return key.toLowerCase()
      .replace("enter", "return")
      .replace("escape", "esc")
      .replace("ctrl+", "cmd:")
      .replace("alt+", "alt:");
  }

  private mapKeyLinux(key: string): string {
    return key.toLowerCase()
      .replace("enter", "Return")
      .replace("escape", "Escape")
      .replace("ctrl+", "ctrl+");
  }
}

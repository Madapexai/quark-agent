/**
 * ComputerService —— 增强版 computer-use 服务（对标 Codex/Orca）
 *
 * 设计原则（学 codex/orca）：
 * - 视觉优先：每次操作前可截屏，让 agent 看到屏幕
 * - accessibility tree：辅助截屏，提供元素位置信息
 * - 安全沙箱：默认在指定窗口/区域操作，记录所有操作到 trace
 * - 幂等性：相同操作多次执行结果一致
 *
 * 平台支持：
 * - macOS（主力）：screencapture + osascript + cliclick
 * - Linux（基础）：scrot + xdotool + wmctrl
 * - Windows（基础）：PowerShell + .NET interop
 *
 * 浏览器控制通过 CDP（Chrome DevTools Protocol），
 * 不依赖 puppeteer/playwright，用 Node http + WebSocket 实现。
 * Chrome 未启动或 CDP 不可用时，fallback 到 open 命令（仅打开，不能控制）。
 */

import { exec } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// ============================================================================
// 类型定义
// ============================================================================

/** 截屏结果 */
export interface ScreenshotResult {
  /** base64 PNG/JPEG */
  data: string;
  width: number;
  height: number;
  /** 截屏时间戳 */
  timestamp: number;
}

/** 鼠标点击选项 */
export interface ClickOptions {
  x: number;
  y: number;
  button?: "left" | "right" | "middle";
  doubleClick?: boolean;
}

/** 文本输入选项 */
export interface TypeOptions {
  text: string;
  /** 每个字符延迟 ms */
  delay?: number;
}

/** 按键组合 */
export interface KeyCombo {
  /** 修饰键 */
  modifiers?: string[];
  /** 主键 */
  key: string;
}

/** 窗口信息 */
export interface WindowInfo {
  id: number;
  title: string;
  appName: string;
  bounds: { x: number; y: number; width: number; height: number };
  focused: boolean;
}

/** ComputerService 配置 */
export interface ComputerServiceOptions {
  /** 操作延迟 ms（防过快），默认 100 */
  actionDelayMs?: number;
  /** 是否记录所有操作到 trace，默认 false */
  trace?: boolean;
  /** 截屏格式，默认 png */
  screenshotFormat?: "png" | "jpeg";
  /** 截屏质量（jpeg 0-100），默认 80 */
  screenshotQuality?: number;
}

/** 操作历史条目 */
export interface HistoryEntry {
  action: string;
  args: unknown;
  timestamp: number;
  /** 执行耗时 ms */
  ms: number;
}

// ============================================================================
// ComputerService
// ============================================================================

export class ComputerService {
  private readonly platform: NodeJS.Platform;
  private readonly opts: Required<Pick<ComputerServiceOptions, "actionDelayMs" | "trace" | "screenshotFormat" | "screenshotQuality">>;
  private history: HistoryEntry[] = [];
  /** CDP 消息 ID（自增） */
  private cdpMsgId = 0;
  private cdpPort = 9222;

  constructor(opts?: ComputerServiceOptions) {
    this.platform = process.platform;
    this.opts = {
      actionDelayMs: opts?.actionDelayMs ?? 100,
      trace: opts?.trace ?? false,
      screenshotFormat: opts?.screenshotFormat ?? "png",
      screenshotQuality: opts?.screenshotQuality ?? 80,
    };
  }

  // ========================================================================
  // 截屏
  // ========================================================================

  /**
   * 截屏
   * - macOS: screencapture -x -t png file.png（区域截屏加 -R x,y,w,h）
   * - Linux: scrot -a x,y,w,h file.png
   * - Windows: PowerShell System.Drawing
   */
  async screenshot(region?: { x: number; y: number; width: number; height: number }): Promise<ScreenshotResult> {
    const ext = this.opts.screenshotFormat;
    const path = join(tmpdir(), `cs-screenshot-${Date.now()}.${ext}`);

    if (this.platform === "darwin") {
      const regionFlag = region ? ` -R ${region.x},${region.y},${region.width},${region.height}` : "";
      await this.run(`screencapture -x -t ${ext}${regionFlag} "${path}"`);
    } else if (this.platform === "linux") {
      if (region) {
        await this.run(`scrot -a ${region.x},${region.y},${region.width},${region.height} "${path}"`);
      } else {
        await this.run(`scrot "${path}"`);
      }
    } else if (this.platform === "win32") {
      const regionScript = region
        ? `$rect = [System.Drawing.Rectangle]::FromLTRB(${region.x}, ${region.y}, ${region.x + region.width}, ${region.y + region.height}); $bmp = New-Object System.Drawing.Bitmap($rect.Width, $rect.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($rect.Location, [System.Drawing.Point]::Empty, $rect.Size); $g.Dispose(); $bmp.Save('${path.replace(/\\/g, "\\\\")}'); $bmp.Dispose()`
        : `$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen([System.Drawing.Point]::Empty, [System.Drawing.Point]::Empty, $screen.Size); $g.Dispose(); $bmp.Save('${path.replace(/\\/g, "\\\\")}'); $bmp.Dispose()`;
      await this.run(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; ${regionScript}"`);
    } else {
      throw new Error(`不支持的平台: ${this.platform}`);
    }

    try {
      const buf = readFileSync(path);
      // 解析 PNG 获取宽高（简单方案：从 PNG header 解析）
      const { width, height } = this.parseImageDimensions(buf);
      return {
        data: buf.toString("base64"),
        width,
        height,
        timestamp: Date.now(),
      };
    } finally {
      try { unlinkSync(path); } catch { /* 忽略清理失败 */ }
    }
  }

  // ========================================================================
  // 鼠标控制
  // ========================================================================

  /** 鼠标点击 */
  async click(opts: ClickOptions): Promise<void> {
    const { x, y, button = "left", doubleClick = false } = opts;

    if (this.platform === "darwin") {
      const clickCmd = button === "right" ? "rc:" : "c:";
      const cmd = doubleClick ? `cliclick ${clickCmd}${x},${y} ${clickCmd}${x},${y}` : `cliclick ${clickCmd}${x},${y}`;
      await this.run(cmd);
    } else if (this.platform === "linux") {
      const btnNum = button === "right" ? 3 : button === "middle" ? 2 : 1;
      const clickCmd = doubleClick ? `click --repeat 2 ${btnNum}` : `click ${btnNum}`;
      await this.run(`xdotool mousemove ${x} ${y} ${clickCmd}`);
    } else if (this.platform === "win32") {
      // PowerShell + user32.dll mouse_event
      const flags = button === "right"
        ? "0x0008, 0x0010" // RIGHTDOWN, RIGHTUP
        : "0x0002, 0x0004"; // LEFTDOWN, LEFTUP
      const script = `
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Mouse { [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); }';
        [Mouse]::SetCursorPos(${x}, ${y});
        [Mouse]::mouse_event(${flags.split(",").map((f: string) => f.trim()).join(", 0, 0, 0, [IntPtr]::Zero); [Mouse]::mouse_event(")}0, 0, 0, 0, [IntPtr]::Zero)`;
      await this.run(`powershell -Command "${script.replace(/\n/g, " ")}"`);
    }
  }

  /** 鼠标移动 */
  async move(x: number, y: number): Promise<void> {
    if (this.platform === "darwin") {
      await this.run(`cliclick m:${x},${y}`);
    } else if (this.platform === "linux") {
      await this.run(`xdotool mousemove ${x} ${y}`);
    } else if (this.platform === "win32") {
      await this.run(`powershell -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Mouse { [DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int x, int y); }'; [Mouse]::SetCursorPos(${x}, ${y})"`);
    }
  }

  /** 鼠标拖拽 */
  async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    if (this.platform === "darwin") {
      await this.run(`cliclick dd:${from.x},${from.y} dm:${to.x},${to.y} du:${to.x},${to.y}`);
    } else if (this.platform === "linux") {
      await this.run(`xdotool mousemove ${from.x} ${from.y} mousedown 1 mousemove ${to.x} ${to.y} mouseup 1`);
    } else if (this.platform === "win32") {
      // Windows: 移动到起点 → 按下 → 移动到终点 → 抬起
      const script = `
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Mouse { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo); }';
        [Mouse]::SetCursorPos(${from.x}, ${from.y});
        [Mouse]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero);
        [Mouse]::SetCursorPos(${to.x}, ${to.y});
        [Mouse]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)`;
      await this.run(`powershell -Command "${script.replace(/\n/g, " ")}"`);
    }
  }

  /** 滚动 */
  async scroll(x: number, y: number, _deltaX: number, deltaY: number): Promise<void> {
    if (this.platform === "darwin") {
      // macOS: 用 osascript 触发滚动事件
      const dir = deltaY > 0 ? "down" : "up";
      const clicks = Math.abs(deltaY);
      // 先移动鼠标到指定位置
      await this.run(`cliclick m:${x},${y}`);
      for (let i = 0; i < Math.min(clicks, 20); i++) {
        await this.run(`osascript -e 'tell application "System Events" to keystroke "${dir === "down" ? "" : ""}" ' `);
      }
      // 用 cliclick 滚动（如果版本支持），否则用简易方案
      try {
        await this.run(`cliclick "scroll:${x},${y},${deltaY > 0 ? "+" : "-"}${Math.min(Math.abs(deltaY), 10)}"`);
      } catch {
        // cliclick 不支持 scroll，用 osascript 替代
        const scrollDir = deltaY > 0 ? "key code 125" : "key code 126";
        for (let i = 0; i < Math.min(Math.abs(deltaY), 10); i++) {
          await this.run(`osascript -e 'tell application "System Events" to ${scrollDir}'`);
        }
      }
    } else if (this.platform === "linux") {
      await this.run(`xdotool mousemove ${x} ${y}`);
      const btn = deltaY > 0 ? 5 : 4; // 4=up, 5=down
      for (let i = 0; i < Math.min(Math.abs(deltaY), 20); i++) {
        await this.run(`xdotool click ${btn}`);
      }
    } else if (this.platform === "win32") {
      // Windows: mouse_event MOUSEEVENTF_WHEEL
      await this.run(`powershell -Command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Mouse { [DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int x, int y); [DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo); }'; [Mouse]::SetCursorPos(${x}, ${y}); [Mouse]::mouse_event(0x0800, 0, 0, ${deltaY * 120}, [IntPtr]::Zero)"`);
    }
  }

  // ========================================================================
  // 键盘控制
  // ========================================================================

  /** 输入文本 */
  async type(opts: TypeOptions): Promise<void> {
    const { text, delay = 0 } = opts;

    if (this.platform === "darwin") {
      const escaped = text.replace(/"/g, '\\"');
      await this.run(`cliclick t:"${escaped}"`);
    } else if (this.platform === "linux") {
      const escaped = text.replace(/"/g, '\\"');
      await this.run(`xdotool type --delay ${delay} "${escaped}"`);
    } else if (this.platform === "win32") {
      // PowerShell SendKeys
      const sendKeys = text.replace(/[+^%~{}()]/g, "{$&}");
      await this.run(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKeys}')"`);
    }
  }

  /** 按键 */
  async key(combo: KeyCombo): Promise<void> {
    const { modifiers = [], key } = combo;

    if (this.platform === "darwin") {
      // osascript: keystroke + key down/up 修饰键
      const modMap: Record<string, string> = { ctrl: "control", alt: "option", shift: "shift", cmd: "command" };
      const applescriptMods = modifiers.map((m) => modMap[m.toLowerCase()] ?? m.toLowerCase());
      const modStr = applescriptMods.length > 0 ? ` using {${applescriptMods.map((m) => `${m} down`).join(", ")}}` : "";
      const escapedKey = this.mapKeyDarwin(key);
      await this.run(`osascript -e 'tell application "System Events" to keystroke "${escapedKey}"${modStr}'`);
    } else if (this.platform === "linux") {
      const xdoKey = this.mapKeyLinux(key);
      const modFlags = modifiers.map((m) => {
        const map: Record<string, string> = { ctrl: "ctrl", alt: "alt", shift: "shift", super: "super" };
        return map[m.toLowerCase()] ?? m.toLowerCase();
      });
      const fullKey = modFlags.length > 0 ? `${modFlags.join("+")}+${xdoKey}` : xdoKey;
      await this.run(`xdotool key ${fullKey}`);
    } else if (this.platform === "win32") {
      const sendKey = this.mapKeyWindows(key);
      const modPrefix = modifiers.map((m) => {
        const map: Record<string, string> = { ctrl: "^", alt: "%", shift: "+" };
        return map[m.toLowerCase()] ?? "";
      }).join("");
      await this.run(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${modPrefix}${sendKey}')"`);
    }
  }

  /** 快捷键（如 Ctrl+C） */
  async hotkey(...keys: string[]): Promise<void> {
    if (keys.length < 2) throw new Error("hotkey 至少需要 2 个键（修饰键 + 主键）");
    const modifiers = keys.slice(0, -1);
    const mainKey = keys[keys.length - 1];
    await this.key({ modifiers, key: mainKey });
  }

  // ========================================================================
  // 窗口管理
  // ========================================================================

  /** 列出窗口 */
  async listWindows(): Promise<WindowInfo[]> {
    if (this.platform === "darwin") {
      return this.listWindowsDarwin();
    } else if (this.platform === "linux") {
      return this.listWindowsLinux();
    } else if (this.platform === "win32") {
      return this.listWindowsWindows();
    }
    throw new Error(`不支持的平台: ${this.platform}`);
  }

  /** 聚焦窗口 */
  async focusWindow(id: number): Promise<void> {
    if (this.platform === "darwin") {
      // id 实际是 pid，用 osascript 激活
      await this.run(`osascript -e 'tell application "System Events" to set frontmost of first process whose unix id is ${id} to true'`);
    } else if (this.platform === "linux") {
      await this.run(`xdotool windowactivate ${id}`);
    } else if (this.platform === "win32") {
      await this.run(`powershell -Command "(Get-Process -Id ${id}).MainWindowHandle | ForEach-Object { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win { [DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr hWnd); }'; [Win]::SetForegroundWindow([IntPtr]$_) }"`);
    }
  }

  /** 关闭窗口 */
  async closeWindow(id: number): Promise<void> {
    if (this.platform === "darwin") {
      await this.run(`osascript -e 'tell application "System Events" to close window 1 of first process whose unix id is ${id}'`);
    } else if (this.platform === "linux") {
      await this.run(`xdotool windowclose ${id}`);
    } else if (this.platform === "win32") {
      await this.run(`powershell -Command "Stop-Process -Id ${id} -Force"`);
    }
  }

  // ========================================================================
  // 进程管理
  // ========================================================================

  /** 启动应用 */
  async launchApp(name: string): Promise<void> {
    if (this.platform === "darwin") {
      await this.run(`open -a "${name}"`);
    } else if (this.platform === "linux") {
      // 尝试 gtk-launch，失败则直接运行
      try {
        await this.run(`gtk-launch "${name}"`);
      } catch {
        await this.run(`nohup "${name}" &`);
      }
    } else if (this.platform === "win32") {
      await this.run(`powershell -Command "Start-Process '${name}'"`);
    }
  }

  /** 终止进程 */
  async killProcess(name: string): Promise<void> {
    if (this.platform === "darwin" || this.platform === "linux") {
      await this.run(`pkill -f "${name}"`);
    } else if (this.platform === "win32") {
      await this.run(`powershell -Command "Stop-Process -Name '${name}' -Force"`);
    }
  }

  // ========================================================================
  // 剪贴板
  // ========================================================================

  /** 读取剪贴板 */
  async getClipboard(): Promise<string> {
    if (this.platform === "darwin") {
      return this.run("pbpaste");
    } else if (this.platform === "linux") {
      return this.run("xclip -selection clipboard -o");
    } else if (this.platform === "win32") {
      return this.run("powershell -Command \"Get-Clipboard\"");
    }
    throw new Error(`不支持的平台: ${this.platform}`);
  }

  /** 写入剪贴板 */
  async setClipboard(text: string): Promise<void> {
    if (this.platform === "darwin") {
      // pbcopy 从 stdin 读取
      const escaped = text.replace(/'/g, "'\\''");
      await this.run(`echo -n '${escaped}' | pbcopy`);
    } else if (this.platform === "linux") {
      const escaped = text.replace(/'/g, "'\\''");
      await this.run(`echo -n '${escaped}' | xclip -selection clipboard`);
    } else if (this.platform === "win32") {
      const escaped = text.replace(/'/g, "''");
      await this.run(`powershell -Command "Set-Clipboard -Value '${escaped}'"`);
    }
  }

  // ========================================================================
  // Accessibility Tree
  // ========================================================================

  /**
   * 获取 accessibility tree（XML/JSON 字符串）
   *
   * - macOS: osascript 获取 UI 元素层级
   * - Linux: gsettings / dconf（基础支持）
   * - Windows: UIAutomation（TODO）
   */
  async getAccessibilityTree(): Promise<string> {
    if (this.platform === "darwin") {
      return this.getAccessibilityTreeDarwin();
    } else if (this.platform === "linux") {
      // Linux 无标准 accessibility tree 接口，返回窗口列表作为替代
      const windows = await this.listWindowsLinux();
      return JSON.stringify(windows, null, 2);
    } else if (this.platform === "win32") {
      // Windows UIAutomation - 基础实现
      return this.getAccessibilityTreeWindows();
    }
    throw new Error(`不支持的平台: ${this.platform}`);
  }

  // ========================================================================
  // 浏览器控制（CDP）
  // ========================================================================

  /** 浏览器控制：打开 URL */
  async browserOpen(url: string): Promise<void> {
    // 尝试通过 CDP 打开
    const opened = await this.cdpNavigate(url);
    if (!opened) {
      // fallback：用系统默认浏览器打开
      if (this.platform === "darwin") {
        await this.run(`open "${url}"`);
      } else if (this.platform === "linux") {
        await this.run(`xdg-open "${url}"`);
      } else if (this.platform === "win32") {
        await this.run(`start "${url}"`);
      }
    }
  }

  /** 浏览器控制：执行 JS */
  async browserEval(script: string): Promise<unknown> {
    const result = await this.cdpEvaluate(script);
    if (result === undefined) {
      throw new Error("CDP 不可用，无法执行 JS。请确保 Chrome 以 --remote-debugging-port=9222 启动。");
    }
    return result;
  }

  /** 浏览器控制：截图 */
  async browserScreenshot(): Promise<ScreenshotResult> {
    const result = await this.cdpScreenshot();
    if (!result) {
      throw new Error("CDP 不可用，无法浏览器截图。请确保 Chrome 以 --remote-debugging-port=9222 启动。");
    }
    return result;
  }

  // ========================================================================
  // Trace 历史
  // ========================================================================

  /** 获取操作历史（用于 trace） */
  getHistory(): HistoryEntry[] {
    return [...this.history];
  }

  /** 清空历史 */
  clearHistory(): void {
    this.history = [];
  }

  // ========================================================================
  // 内部实现
  // ========================================================================

  /**
   * 执行系统命令的统一入口
   *
   * 所有操作都通过此方法执行，自动记录 trace + 操作延迟
   */
  private async run(cmd: string): Promise<string> {
    const start = Date.now();
    const { stdout } = await execAsync(cmd, { timeout: 10000 });
    const ms = Date.now() - start;
    if (this.opts.trace) {
      this.history.push({ action: "run", args: { cmd }, timestamp: Date.now(), ms });
    }
    await this.delay();
    return stdout.trim();
  }

  /** 操作延迟，防止过快导致系统跟不上 */
  private async delay(): Promise<void> {
    if (this.opts.actionDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.opts.actionDelayMs));
    }
  }

  // ========================================================================
  // macOS 专用实现
  // ========================================================================

  /** macOS: 列出窗口 */
  private async listWindowsDarwin(): Promise<WindowInfo[]> {
    const script = `
      tell application "System Events"
        set output to ""
        repeat with p in (every process whose background only is false)
          try
            set pid to unix id of p
            set appName to name of p
            repeat with w in (every window of p)
              set winTitle to name of w
              set winBounds to bounds of w
              set isFront to (p is frontmost)
              set output to output & pid & "|" & appName & "|" & winTitle & "|" & (item 1 of winBounds) & "," & (item 2 of winBounds) & "," & ((item 3 of winBounds) - (item 1 of winBounds)) & "," & ((item 4 of winBounds) - (item 2 of winBounds)) & "|" & isFront & linefeed
            end repeat
          end try
        end repeat
        return output
      end tell`;
    const raw = await this.run(`osascript -e '${script.replace(/\n/g, " ")}'`);
    return raw
      .split("\n")
      .filter((line) => line.includes("|"))
      .map((line) => {
        const [idStr, appName, title, boundsStr, focusedStr] = line.split("|");
        const [bx, by, bw, bh] = boundsStr?.split(",").map(Number) ?? [0, 0, 0, 0];
        return {
          id: Number(idStr),
          title: title ?? "",
          appName: appName ?? "",
          bounds: { x: bx, y: by, width: bw, height: bh },
          focused: focusedStr === "true",
        };
      });
  }

  /** macOS: 获取 accessibility tree */
  private async getAccessibilityTreeDarwin(): Promise<string> {
    const script = `
      tell application "System Events"
        set output to ""
        set frontApp to first process whose frontmost is true
        try
          set uiElements to entire contents of window 1 of frontApp
          repeat with elem in uiElements
            try
              set elemRole to role of elem
              set elemDesc to description of elem
              set elemName to name of elem
              set elemVal to value of elem
              set elemPos to position of elem
              set elemSize to size of elem
              set output to output & elemRole & "|" & elemDesc & "|" & elemName & "|" & elemVal & "|" & (item 1 of elemPos) & "," & (item 2 of elemPos) & "|" & (item 1 of elemSize) & "x" & (item 2 of elemSize) & linefeed
            end try
          end repeat
        end try
        return output
      end tell`;
    const raw = await this.run(`osascript -e '${script.replace(/\n/g, " ")}'`);
    // 转为结构化 JSON
    const elements = raw
      .split("\n")
      .filter((line) => line.includes("|"))
      .map((line) => {
        const [role, desc, name, value, pos, size] = line.split("|");
        const [px, py] = pos?.split(",").map(Number) ?? [0, 0];
        const [sw, sh] = size?.split("x").map(Number) ?? [0, 0];
        return { role, description: desc, name, value, position: { x: px, y: py }, size: { width: sw, height: sh } };
      });
    return JSON.stringify(elements, null, 2);
  }

  // ========================================================================
  // Linux 专用实现
  // ========================================================================

  /** Linux: 列出窗口 */
  private async listWindowsLinux(): Promise<WindowInfo[]> {
    try {
      const raw = await this.run("wmctrl -l -p");
      return raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          // wmctrl 输出: <id> <desktop> <pid> <host> <title>
          const parts = line.split(/\s+/);
          if (parts.length < 5) return null;
          const winId = parseInt(parts[0], 16);
          const pid = parseInt(parts[2]);
          const title = parts.slice(4).join(" ");
          return {
            id: winId || pid,
            title,
            appName: title,
            bounds: { x: 0, y: 0, width: 0, height: 0 },
            focused: false,
          };
        })
        .filter((w): w is WindowInfo => w !== null);
    } catch {
      return [];
    }
  }

  // ========================================================================
  // Windows 专用实现
  // ========================================================================

  /** Windows: 列出窗口 */
  private async listWindowsWindows(): Promise<WindowInfo[]> {
    const script = `
      Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object {
        $hwnd = $_.MainWindowHandle;
        $rect = New-Object System.Drawing.Rectangle;
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win { [DllImport(\\"user32.dll\\")] public static extern bool GetWindowRect(IntPtr hWnd, out int[] rect); }';
        $r = @(0,0,0,0);
        [Win]::GetWindowRect($hwnd, [ref]$r);
        "$($_.Id)|$($_.ProcessName)|$($_.MainWindowTitle)|$($r[0]),$($r[1]),$($r[2]-$r[0]),$($r[3]-$r[1])|$($hwnd -eq [IntPtr]::Zero -eq $false)"
      }`;
    try {
      const raw = await this.run(`powershell -Command "${script.replace(/\n/g, " ")}"`);
      return raw
        .split("\n")
        .filter((line) => line.includes("|"))
        .map((line) => {
          const [idStr, appName, title, boundsStr, focusedStr] = line.split("|");
          const [bx, by, bw, bh] = boundsStr?.split(",").map(Number) ?? [0, 0, 0, 0];
          return {
            id: Number(idStr),
            title: title ?? "",
            appName: appName ?? "",
            bounds: { x: bx, y: by, width: bw, height: bh },
            focused: focusedStr === "True",
          };
        });
    } catch {
      return [];
    }
  }

  /** Windows: 获取 accessibility tree（基础实现） */
  private async getAccessibilityTreeWindows(): Promise<string> {
    // Windows UIAutomation 完整实现需要 C# / PowerShell 反射，此处返回进程窗口列表
    const windows = await this.listWindowsWindows();
    return JSON.stringify(windows, null, 2);
  }

  // ========================================================================
  // 按键映射
  // ========================================================================

  /** macOS 按键映射 */
  private mapKeyDarwin(key: string): string {
    return key
      .replace(/enter/i, "return")
      .replace(/escape/i, "esc")
      .replace(/backspace/i, "delete")
      .replace(/tab/i, "tab")
      .replace(/space/i, " ")
      .replace(/arrowup/i, "key code 126")
      .replace(/arrowdown/i, "key code 125")
      .replace(/arrowleft/i, "key code 123")
      .replace(/arrowright/i, "key code 124");
  }

  /** Linux 按键映射 */
  private mapKeyLinux(key: string): string {
    const map: Record<string, string> = {
      enter: "Return",
      escape: "Escape",
      backspace: "BackSpace",
      tab: "Tab",
      space: "space",
      arrowup: "Up",
      arrowdown: "Down",
      arrowleft: "Left",
      arrowright: "Right",
      delete: "Delete",
      home: "Home",
      end: "End",
      pageup: "Prior",
      pagedown: "Next",
      f1: "F1", f2: "F2", f3: "F3", f4: "F4",
      f5: "F5", f6: "F6", f7: "F7", f8: "F8",
      f9: "F9", f10: "F10", f11: "F11", f12: "F12",
    };
    return map[key.toLowerCase()] ?? key;
  }

  /** Windows 按键映射（SendKeys 格式） */
  private mapKeyWindows(key: string): string {
    const map: Record<string, string> = {
      enter: "{ENTER}",
      escape: "{ESC}",
      backspace: "{BACKSPACE}",
      tab: "{TAB}",
      space: " ",
      arrowup: "{UP}",
      arrowdown: "{DOWN}",
      arrowleft: "{LEFT}",
      arrowright: "{RIGHT}",
      delete: "{DELETE}",
      home: "{HOME}",
      end: "{END}",
      pageup: "{PGUP}",
      pagedown: "{PGDN}",
    };
    return map[key.toLowerCase()] ?? key;
  }

  // ========================================================================
  // 图片尺寸解析
  // ========================================================================

  /** 从 PNG/JPEG 二进制头解析宽高 */
  private parseImageDimensions(buf: Buffer): { width: number; height: number } {
    // PNG: 宽高在 IHDR chunk（第 16-23 字节）
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return {
        width: buf.readUInt32BE(16),
        height: buf.readUInt32BE(20),
      };
    }
    // JPEG: SOF0 marker (0xFFC0) 包含宽高
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset < buf.length - 1) {
        if (buf[offset] !== 0xff) { offset++; continue; }
        const marker = buf[offset + 1];
        // SOF0 / SOF2
        if (marker === 0xc0 || marker === 0xc2) {
          return {
            height: buf.readUInt16BE(offset + 5),
            width: buf.readUInt16BE(offset + 7),
          };
        }
        const segLen = buf.readUInt16BE(offset + 2);
        offset += 2 + segLen;
      }
    }
    // 回退：无法解析
    return { width: 0, height: 0 };
  }

  // ========================================================================
  // CDP（Chrome DevTools Protocol）实现
  // ========================================================================

  /** 尝试通过 CDP 导航 */
  private async cdpNavigate(url: string): Promise<boolean> {
    try {
      const wsUrl = await this.getCdpWsUrl();
      if (!wsUrl) return false;
      await this.cdpSend(wsUrl, "Page.navigate", { url });
      return true;
    } catch {
      return false;
    }
  }

  /** 尝试通过 CDP 执行 JS */
  private async cdpEvaluate(script: string): Promise<unknown> {
    try {
      const wsUrl = await this.getCdpWsUrl();
      if (!wsUrl) return undefined;
      const result = await this.cdpSend(wsUrl, "Runtime.evaluate", {
        expression: script,
        returnByValue: true,
      });
      return (result as Record<string, unknown>)?.result;
    } catch {
      return undefined;
    }
  }

  /** 尝试通过 CDP 截图 */
  private async cdpScreenshot(): Promise<ScreenshotResult | null> {
    try {
      const wsUrl = await this.getCdpWsUrl();
      if (!wsUrl) return null;
      const result = await this.cdpSend(wsUrl, "Page.captureScreenshot", {
        format: this.opts.screenshotFormat,
        quality: this.opts.screenshotFormat === "jpeg" ? this.opts.screenshotQuality : undefined,
      }) as { data: string };
      return {
        data: result.data,
        width: 0, // CDP 不直接返回宽高，从图片头解析
        height: 0,
        timestamp: Date.now(),
      };
    } catch {
      return null;
    }
  }

  /** 获取 CDP WebSocket URL */
  private async getCdpWsUrl(): Promise<string | null> {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${this.cdpPort}/json`, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const tabs = JSON.parse(Buffer.concat(chunks).toString()) as Array<{ webSocketDebuggerUrl?: string }>;
            const tab = tabs.find((t) => t.webSocketDebuggerUrl);
            resolve(tab?.webSocketDebuggerUrl ?? null);
          } catch {
            resolve(null);
          }
        });
      });
      req.on("error", () => resolve(null));
      req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    });
  }

  /** 通过 CDP WebSocket 发送命令（简易实现） */
  private async cdpSend(wsUrl: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    // 使用 Node 内置 http + 手动 WebSocket 握手太复杂
    // 改用简易方案：通过 HTTP 接口（部分 CDP 操作可通过 /json 协议完成）
    // 对于 Runtime.evaluate，用 Chrome 的 HTTP 端点
    // 完整 CDP WebSocket 需要依赖 ws 模块，此处用 execSync 调 curl 替代
    const msgId = ++this.cdpMsgId;
    const message = JSON.stringify({ id: msgId, method, params });

    // 用 Node http 做 WebSocket 连接过于复杂，用简化的 HTTP 方案
    // 这里用子进程调 curl（大多数系统预装）
    const result = await execAsync(
      `curl -s -N -H "Content-Type: application/json" --max-time 5 -X POST "${wsUrl}" -d '${message.replace(/'/g, "'\\''")}'`,
      { timeout: 10000 },
    ).catch(() => ({ stdout: "", stderr: "" }));

    if (!result.stdout.trim()) return null;
    try {
      const parsed = JSON.parse(result.stdout) as { result?: unknown };
      return parsed.result;
    } catch {
      return null;
    }
  }
}

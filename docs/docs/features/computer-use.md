# Computer Use

Screenshot, click, type, and browser control via Chrome DevTools Protocol.

## Overview

Computer Use gives the agent the ability to interact with the desktop and browser:

- **Screenshot** - Capture the screen
- **Click/Type** - Mouse and keyboard input
- **Window management** - List, focus, close windows
- **Process management** - Launch and kill applications
- **CDP browser control** - Navigate, evaluate JS, screenshot

## Quick Start

```ts
import { ComputerService } from "quark-agent";

const computer = new ComputerService();

// Take a screenshot
const screenshot = await computer.screenshot();
// -> { buffer: Buffer, width: 1920, height: 1080 }

// Click at coordinates
await computer.click(100, 200);

// Type text
await computer.type("Hello world");

// Launch an app
await computer.launchApp("Safari");

// List windows
const windows = await computer.listWindows();
```

## Browser Control (CDP)

Native WebSocket connection to Chrome DevTools Protocol:

```ts
// Navigate to a URL
await computer.cdpNavigate("https://example.com");

// Execute JavaScript
const title = await computer.cdpEvaluate("document.title");

// Take a browser screenshot
const screenshot = await computer.browserScreenshot();
```

## Platform Support

| Feature | macOS | Linux | Windows |
|---------|:-----:|:-----:|:-------:|
| Screenshot | ✅ `screencapture` | ✅ `scrot` | ⚠️ PowerShell |
| Click | ✅ `cliclick` | ✅ `xdotool` | ⚠️ PowerShell |
| Type | ✅ `cliclick` | ✅ `xdotool` | ⚠️ PowerShell |
| Window mgmt | ✅ | ✅ | ⚠️ |
| CDP browser | ✅ | ✅ | ✅ |

## Requirements

- **macOS**: Install `cliclick` (`brew install cliclick`)
- **Linux**: Install `xdotool` and `scrot` (`apt install xdotool scrot`)
- **Browser**: Launch Chrome with `--remote-debugging-port=9222`

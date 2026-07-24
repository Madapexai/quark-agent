const { app, BrowserWindow, Menu } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

let mainWindow;
let quarkProcess;

function startQuarkServer() {
  // Start the quark-agent dashboard server
  quarkProcess = spawn("node", [path.join(__dirname, "..", "bin", "run-cli.cjs"), "dashboard"], {
    cwd: app.getPath("home"),
    stdio: ["ignore", "pipe", "pipe"],
  });

  quarkProcess.stdout.on("data", (data) => {
    const output = data.toString();
    console.log("[quark-agent]", output.trim());
  });

  quarkProcess.stderr.on("data", (data) => {
    console.error("[quark-agent]", data.toString().trim());
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Quark Agent",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Wait a bit for server to start, then load
  setTimeout(() => {
    mainWindow.loadURL("http://127.0.0.1:8788");
  }, 2000);

  // Open DevTools in development
  if (process.env.NODE_ENV === "development") {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Custom menu
  const template = [
    {
      label: "Quark Agent",
      submenu: [
        { label: "About Quark Agent", selector: "orderFrontStandardAboutPanel:" },
        { type: "separator" },
        { label: "Quit", accelerator: "Command+Q", click: () => app.quit() },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" }, { role: "forceReload" },
        { role: "toggleDevTools" }, { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" }, { role: "togglefullscreen" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  startQuarkServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (quarkProcess) {
    quarkProcess.kill("SIGTERM");
  }
});

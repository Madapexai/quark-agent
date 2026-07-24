const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("quarkDesktop", {
  version: "1.0.0",
  platform: process.platform,
});

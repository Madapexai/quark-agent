# Quark Agent Mobile (Capacitor)

将 Quark Agent dashboard 打包为 iOS / Android 原生应用。

## 前置要求

- Node.js >= 18.17
- iOS：macOS + Xcode + CocoaPods
- Android：Android Studio + JDK 17
- 全局安装 Capacitor CLI：

```bash
npm install -g @capacitor/cli
```

## 初始化步骤

```bash
# 1. 在项目根目录安装 Capacitor 核心包
npm install @capacitor/core @capacitor/ios @capacitor/android

# 2. 添加平台
npx cap add ios
npx cap add android

# 3. 构建 dashboard web 资源（如有静态构建步骤）
#    确保 src/dashboard/web 目录存在可被加载的 HTML

# 4. 同步资源到原生项目
npx cap sync

# 5. 在 IDE 中打开并运行
npx cap open ios      # 用 Xcode 打开
npx cap open android  # 用 Android Studio 打开
```

## 运行说明

`capacitor.config.json` 中 `server.url` 指向 `http://127.0.0.1:8788`，
App 启动时会加载本地运行的 quark-agent dashboard 服务。
请确保在设备/模拟器上 dashboard 服务已启动并可访问。

## 修改配置

编辑 `mobile/capacitor.config.json` 后执行：

```bash
npx cap sync
```

使配置生效。

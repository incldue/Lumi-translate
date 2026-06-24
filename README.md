# Lumi Translate

一款轻量、快速、玻璃拟态风格的 Windows 桌面翻译应用。

![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white) ![Windows](https://img.shields.io/badge/Windows-x64-0078D4?logo=windows&logoColor=white) ![License](https://img.shields.io/badge/License-MIT-green.svg) ![Release](https://img.shields.io/badge/Release-v2.0.0-blue.svg) 

## ✨ 简介

**Lumi Translate** 是一款专注于 “快启动、快响应、低占用” 的桌面翻译工具。界面采用整体圆角窗口与半透明玻璃拟态设计，通过全局快捷键快速唤起翻译、剪贴板翻译、截图翻译、屏幕实时翻译和单词详解。

## 🚀 功能特性

- 🪟 **玻璃拟态 UI**：半透明窗口、整体圆角、简洁轻盈
- ⚡ **快速响应**：内置翻译 / 词典缓存，减少重复请求等待
- 🖼️ **截图翻译**：鼠标框选屏幕区域后自动识别文字并翻译
- 👁️ **屏幕实时翻译**：框选屏幕区域后持续翻译，同时加入画面稳定检测、字幕去抖和悬浮窗状态提示（效果可能不是很好，会继续改进）
- 📖 **单词详解**：英文单词释义、音标、词性与例句展示
- 📖 **多词库单词详解**：聚合网易有道、剑桥词典、牛津词典和 DictionaryAPI
- ⌨️ **全局快捷键**：支持自定义唤起、剪贴板翻译、单词详解快捷键
- ⚙️ **可配置接口**：支持自定义翻译 API、窗口置顶、透明度等设置

## 📦 下载使用

右侧 **Releases** 页面下载 exe文件。

便携版无需安装，解压后直接点击：

```text
Lumi Translate.exe
```

> 首次运行如果被 Windows SmartScreen 提示拦截，请选择「更多信息」→「仍要运行」。

## ⌨️ 默认快捷键 (可自定义)

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl + Q` | 显示 / 隐藏窗口 |
| `Ctrl + Alt + C` | 翻译剪贴板内容 |
| `Ctrl + Shift + D` | 切换单词详解 |
| `Ctrl + Alt + S` | 截图翻译 |
| `Ctrl + Alt + Shift + R` | 开始 / 停止屏幕实时翻译 |

所有快捷键都可以在应用「设置」页面中自定义。

## ⚙️ 设置项

应用「设置」页面支持：

- 窗口置顶
- 窗口透明度
- 显示 / 隐藏快捷键
- 剪贴板翻译快捷键
- 单词详解快捷键
- 截图翻译快捷键
- 屏幕实时翻译快捷键
- 自定义翻译接口 URL
- 请求超时时间
- 屏幕实时刷新间隔
- 视频字幕增强模式
- 视频翻译放大倍数（卡顿时可调低到 1）
- 字幕稳定帧数

自定义翻译接口 URL 支持以下占位符：

```text
{text}     待翻译文本
{source}   源语言
{target}   目标语言
```

## 🛠️ 本地开发

### 环境要求

- Windows 10 / 11
- Node.js 18+
- npm

### 启动项目

```powershell
npm install
npm start
```

如果 Windows PowerShell 拦截 `npm.ps1`，可以改用：

```powershell
npm.cmd install
npm.cmd start
```

## 📁 项目结构

```text
.
├─ assets/                 # 应用图标与资源
├─ src/
│  ├─ index.html           # 应用界面
│  ├─ styles.css           
│  ├─ renderer.js          
│  ├─ preload.js           
│  ├─ main.js              # 主进程、托盘、快捷键、OCR/翻译/词典调度
│  ├─ selection.html       
│  ├─ selection.js         
│  ├─ screen-result.html   
│  ├─ screen-result.js     
│  ├─ screen-overlays.css  
│  └─ win-ocr.ps1  
├─ package.json
└─ README.md
```

## 📄 License

本项目基于 [MIT License](./LICENSE) 开源。

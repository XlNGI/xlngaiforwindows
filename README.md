# AI Video Production Workspace

面向本地 Windows 桌面的 AI 短剧生产工具。用户通过项目会话完善剧情、大纲和生产计划，LLM 基于项目文档、记忆与约束生成当前场次或镜头所需的分镜、提示词和生产建议；用户自行选择生产方式、供应商和模型，并在适配器生成的参数界面中编辑和提交任务。

## 当前状态

M0–M4 的代码与自动化修复门禁已通过，M5 尚未开始。当前包含 Tauri 桌面端、Node Worker、IPC v1、SQLite Schema v3、项目生命周期、版本化及分作用域文档、场次/镜头、三级会话、上下文来源追踪、带超时的 OpenAI Responses API 流式生成、Vidu Adapter Registry、Schema 动态表单、镜头参数草稿和 Windows Credential Manager 原生请求桥。

里程碑最终签收仍为 `HOLD`：NSIS 干净 Windows 安装、真实 OpenAI 和真实 Vidu 请求尚未验证。未配置真实凭据时不会自动发送外部请求。

已确认的核心边界：

- 桌面端采用 Tauri + React + TypeScript。
- 应用内置 SQLite 管理结构化数据和文本，本地目录保存图片、视频、音频与导出文件；用户无需安装数据库。
- Node.js/TypeScript 本地 Worker 负责 LLM、厂商适配器和异步任务轮询。
- LLM 不自动填写厂商 API 表单，也不直接提交生产任务。
- 用户选择“生产方式 + 供应商 + 模型”后锁定适配器、API 版本和参数 Schema。
- Vidu 密钥由 Rust 从 Windows Credential Manager 读取并直接用于固定白名单 HTTPS 请求，不返回 React，也不进入 Node Worker IPC。
- 同步生图接口直接等待响应；异步视频接口保存任务 ID 并在本地轮询。
- 纯本地版本不提供公网 `callback_url`。

## 文档

- [项目启动文档](docs/PROJECT-STARTUP.md)
- [实施计划](docs/IMPLEMENTATION-PLAN.md)
- [工程质量门禁](docs/QUALITY-GATES.md)
- [M4 适配器与动态参数](docs/M4-ADAPTERS-PARAMETERS.md)

## 开发

前置环境：Node.js 22 或更高版本、pnpm 11.9。运行浏览器开发模式：

```powershell
# 如果 PowerShell 提示找不到 pnpm 或阻止 pnpm.ps1：
npm.cmd install --global pnpm@11.9.0
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned

pnpm install
pnpm dev
```

运行 Tauri 桌面模式还需要 Rust stable 和 Windows C++ 构建工具：

```powershell
pnpm dev:desktop
```

常用质量检查：

```powershell
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

生成 Windows x64 独立 Worker：

```powershell
pnpm worker:sidecar
```

验证状态和剩余门禁见 [M0 工程骨架验证记录](docs/M0-VALIDATION.md)。独立 Worker 与 Release 同目录启动冒烟已验证；NSIS 干净 Windows 安装验证仍待完成。

M1 Schema、项目容器与恢复边界见 [M1 项目数据层](docs/M1-DATA-LAYER.md)。

M2 文档版本、会话作用域和内容提升边界见 [M2 项目文档与会话](docs/M2-DOCUMENTS-CONVERSATIONS.md)。

M3 上下文选择、摘要缓存、生成生命周期和 Provider 配置见 [M3 上下文与 LLM](docs/M3-CONTEXT-LLM.md)。

M4 适配器唯一解析、参数 Schema、草稿持久化和凭据边界见 [M4 适配器与动态参数](docs/M4-ADAPTERS-PARAMETERS.md)。

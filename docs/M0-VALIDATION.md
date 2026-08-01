# M0 工程骨架验证记录

日期：2026-08-02  
状态：Tauri 桌面开发模式可运行，Windows 安装包待干净环境验证

## 已完成

- pnpm workspace：`apps/desktop`、`apps/worker`、`packages/contracts`。
- React + TypeScript + Vite 四栏工作台及窄屏布局。
- IPC 协议 v1：`health`、`sqlite.probe` 和统一错误结构。
- Worker NDJSON 标准输入输出通道，以及浏览器开发使用的本地 HTTP 通道。
- `better-sqlite3` 测试库：WAL、外键、busy timeout 和读写探测。
- Tauri Worker 进程管理：惰性启动、串行请求、失败回收和应用退出回收。
- TypeScript、ESLint、Prettier、Vitest 和 Windows CI。

## 本机验证结果

验证环境：Windows x64、Node.js v26.5.0、pnpm v11.9.0。

| 检查项 | 结果 |
| --- | --- |
| workspace production build | 通过 |
| TypeScript typecheck | 通过 |
| ESLint | 通过 |
| Prettier | 通过 |
| Vitest | 通过，3 个测试文件、5 个测试 |
| SQLite 原生模块安装 | 通过 |
| Worker 源码 IPC 与 SQLite 探测 | 通过 |
| standalone Worker `.exe` | 通过，Node 22 x64 内置运行时的 health 和 SQLite WAL 写入成功 |
| Tauri Rust host | 通过，Rust 原生往返测试和桌面开发进程启动成功 |
| NSIS 安装包 | 已构建；Release 同目录启动冒烟通过；干净安装生命周期脚本已接入 Windows CI，首次 runner 复验待完成 |

## 尚未通过的 M0 门禁

在以下验证完成前，不能声称 M0 全部门禁通过：

1. 在干净 Windows 10/11 x64 环境验证 NSIS 安装、启动、关闭和 Worker 无残留。

CI 在 Windows runner 上执行 Sidecar、Tauri/NSIS 构建与 `scripts/validate-nsis-install.ps1`。安装脚本验证安装后的 Worker 名称、启动 health/SQLite 生命周期、窗口关闭后无 Worker 残留，以及卸载后二进制清理；应用数据不作为卸载器应删除的安装文件。

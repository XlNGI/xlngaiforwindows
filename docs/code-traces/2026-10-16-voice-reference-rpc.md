# 本地声音样本导入 RPC 修复

日期：2026-10-16

## 原因与修复

角色页导入本地音频后，`audio.import` 可以成功，但后续绑定角色时报 `Unknown worker method: characterVoiceReference.save`。

`handler.ts` 已实现声音样本的读取和保存，参数校验与项目内持久化也已存在；`parseRequest` 使用的请求白名单遗漏了 `characterVoiceReference.list` 和 `characterVoiceReference.save`。本次补齐这两个方法的注册。

既有配音 RPC 测试直接调用 `handleRequest`，绕过入口白名单，因此未发现该问题。测试辅助函数现在先调用 `parseRequest`，再进入处理器。新增真实 WAV／MP3 样本导入回归，覆盖角色绑定、读取、媒体源哈希、版本更新、过期版本拒绝、项目重开和项目隔离。

打包验证脚本新增声音样本导入、保存、读取，以及项目导出后重开的引用与音频哈希检查。

## 验证记录

- 修复前新增两项回归均出现 `METHOD_NOT_FOUND`；修复后通过。
- Worker：`pnpm.cmd exec vitest run --testTimeout=15000 --reporter=dot`，53 个文件、696 项测试通过。
- Desktop：`VoiceReferencePanel.test.tsx` 与 `VoiceProfilePanel.test.tsx`，3 项测试通过。
- 全仓 `pnpm.cmd typecheck`、`pnpm.cmd lint`、`pnpm.cmd format:check` 通过。
- `pnpm.cmd --filter @ai-video/worker validate:dubbing-sidecar` 通过，`characterVoiceReferenceSavedAndExported=true`，Schema 47，`paidRequests=0`。
- `pnpm.cmd tauri:build` 通过，完成 Worker Sidecar、桌面生产构建和 Windows NSIS 安装包 `apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`。

验证使用临时项目与生成的音频夹具，未操作用户项目。音频仍存储在当前本地项目的独立音频库；未改变素材库产品要求、数据库结构或供应商提交规则。

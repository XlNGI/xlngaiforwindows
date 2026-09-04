# Agent 编排 P3 媒体准备验证证据

日期：2026-09-04  
阶段：P3 媒体准备与用户选择模型适配

## 已验证范围

- Worker 的媒体候选解析只返回官方 Provider、已启用且连接状态为 `ready` 的模型，并同时校验图片/视频能力、输入附件数量、项目权限和已确认的 Adapter Schema。
- 会话 Agent LLM 与媒体 Provider/模型完全分离。`media.image.prepare` 和 `media.video.prepare` 由用户选择候选后继续，Worker 不自动替换 Provider、区域、远程模型或 Adapter。
- 选择前只创建受控的媒体选择请求，不创建 generation job、不调用 Provider；选择通过 token、项目 session、会话、generation、任务、attempt、step、tool call 和参数哈希绑定。
- 选择成功后只创建本地媒体草稿，冻结规范化 Provider 路由、Adapter Schema 版本、参数和输入引用；付费提交仍留在 P4。
- 图片附件只接受当前会话附件中的规范化 PNG/JPEG/WebP Data URL。校验 Base64 解码、文件签名、大小和 MIME 一致性；持久化只保留受控临时文件引用和摘要，不保存原始 Base64、绝对路径或 Provider secret。
- `media.task.get` 只返回当前项目内的规范化任务状态和结果素材 ID，不返回本地路径或 Provider 原始载荷。
- 过期、取消、重放、篡改参数、跨项目、跨 session、不可用模型和未确认 Adapter 均 fail-closed；过期状态在抛出错误前先事务提交，避免状态回滚为 `pending`。

## 自动化门禁

```text
pnpm.cmd --filter @ai-video/contracts build
pnpm.cmd typecheck
pnpm.cmd --filter @ai-video/worker test          # 37 files / 341 tests
pnpm.cmd --filter @ai-video/desktop test         # 24 files / 179 tests
pnpm.cmd --filter @ai-video/persistence test     # 3 files / 26 tests
pnpm.cmd format:check
git diff --check
```

以上命令均通过。Worker 媒体准备专项覆盖候选筛选、选择前无 Provider 请求、选择后本地草稿、附件/Base64 脱敏、过期、重放、篡改和跨项目拒绝。

## 未完成边界

P3 不包含付费 Provider 提交。`media.generation.submit`、`media.task.cancel`、一次性 R2 确认、`submitting`/`submission_unknown`、项目级后台轮询和真实 Provider/Windows 长稳验收按 P4/P5/P7 顺序实施。

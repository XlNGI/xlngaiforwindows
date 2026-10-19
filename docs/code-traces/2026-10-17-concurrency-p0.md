# 并发计划 P0 验收记录

日期：2026-10-17。用户指示实施后，先完成两处已复现竞态；未修改用户项目或发起真实付费请求。

## 基线与变更

开始前存在审计报告中列出的未提交 Rust、Desktop、Worker、Contracts、适配器和文档修改，均保留。本阶段在这些内容上增量修改，未提交 Git。

- 新增 `apps/worker/src/project-export.ts` 和 `project-export.test.ts`，修改 ProjectService 导出入口。
- 修改 ProductionPanel、其既有测试及 App 传入的项目视图身份。
- 项目 Schema 仍为 v49，应用库仍为 v7，无数据库迁移；付费确认、素材库产品规则和原生凭据边界不变。

## 行为与证据

导出以 SQLite 一致性备份为依据，在独立暂存目录异步复制，核对资产、音频、配音片段、回收站及已完成小说导出的 hash/大小；校验成功才发布目标目录。快照后删除/修改、项目 session 变化、目标目录被写入及目录链接均明确失败，只清理本次暂存。记录 `project-snapshot.json`，标注历史快照与媒体任务身份；不新增自动付费重放。

制作操作捕获项目视图、session、目标和请求身份，逐次 await、错误与 finally 复核；覆盖项目切换、镜头/场次切换、同项目重开、A→B→A 与旧 finally 晚于新请求。图片、视频、草稿保存、预览保存、对白导入和图片取消中的共享状态更新均受对应归属保护。

先新增正确行为回归，旧代码下导出测试与图片迟到用例失败，再修复为通过。最初场次切换测试缺少 scene/voice mock，已补齐夹具；该夹具错误不计作缺陷复现。

## 验证

- Worker 项目/新导出/配音/媒体编排/视频后台 5 文件：75 项通过。
- Desktop App/制作面板/场次绑定/LLM client 4 文件：151 项通过。
- Markdown 导出既有 7 项通过；新导出 8 项再次通过，包含 files/merged 包完整性。不同用例合计 233 项通过。
- Worker 与 Desktop typecheck、变更文件 ESLint/Prettier、git diff --check 通过。

本阶段新增 8 项导出回归、7 项制作归属回归。配音验证使用本地 FFmpeg 夹具；Provider 使用模拟响应。未宣称全仓发布门禁、真实 Windows 多窗口或真实 Provider 已验收。后续 P1 仍需独立验证和全仓检查。

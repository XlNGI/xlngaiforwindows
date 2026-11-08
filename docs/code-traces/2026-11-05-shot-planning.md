# 分镜粒度规则同步

日期：2026-11-05。

本文记录分镜粒度规则的首阶段；同日后续按用户要求扩展到机位运镜、灯光灯具、长镜头与自然估时，最终实施及全仓验证记录见 [完整实施计划](../SHOT-TIMING-IMPLEMENTATION-PLAN.md)。下列测试数字与“未运行全仓测试”仅描述首阶段。

## 问题与范围

用户反馈连续动作被拆成多个分镜。原有规则要求写清镜内动作节拍，并禁止把每段动作机械拆成独立生成任务，但缺少明确的切镜与合并判断。

本次补充由 LLM 编排时使用的共享文字指导：连续摄影能够表达清楚的动作与交流优先合在一镜，镜内节拍不等于切镜；新增镜头须具有信息、情绪、视点、时空或节奏作用。保留有作用的特写和反应镜头，尊重用户明确指定的剪辑要求，不强制长镜头，不按固定时长切镜。

## 实施与验证清单

- [x] 共享分镜划分规则接入通用视频编写指导、制作资料生成指令和内置会话模板。
- [x] 澄清时间段、镜内动作节拍与视频生成分段，保留按内容自然估时。
- [x] 运行相关现有回归，检查普通工具与按需加载工具均能取得规则。
- [x] 完成类型检查与构建，运行格式和静态检查并记录实际结果及限制。

## 验证结果

- `pnpm --filter @ai-video/contracts test --maxWorkers=2 --minWorkers=1`：44 项通过。
- Worker 的 `agent-policy-instructions`、`agent-provider-tool-gateway`、`production-skill-validation` 现有回归：50 项通过，覆盖视频编写规则在普通入口及工具按需加载时的传递。
- Desktop 的 `conversation-prompt-template`、`use-conversation-prompt-template`、`ChatPanel` 现有回归：51 项通过，覆盖规则进入初始模板、自定义模板保留、会话状态与发送行为。
- 对构建后的 Contracts 直接检查：通用视频规则及 `script-to-media` 包含同一份 `SHOT_PLANNING_REQUIREMENTS`；`chapters-to-script` 不携带该规则。合计复用 145 项现有测试，未新增只匹配文字实现的测试。
- `pnpm typecheck`、`pnpm build`、本次三个 TypeScript 文件的 ESLint、本次全部五个文件的 Prettier 检查及 `git diff --check` 通过。构建保留 Vite 大体积 chunk 提示。

全仓门禁尚未全部通过：`pnpm lint` 在本次未修改文件中报告 11 个错误，涉及 `.m2-ui-conversation-check` 下四个临时 TSX 文件、`App.test.tsx`、`shot-binding-summary.ts`、`project-service.test.ts`、`request-validation.ts` 和 `scene-structure-submission-service.ts`。`pnpm format:check` 报告六个本次未修改文件的格式问题：`media-confirmation.tsx`、`SceneCastEditor.tsx`、`SceneShotDirectory.tsx`、`context-service.ts`、`domain-tool-gateway.ts`、`project-library-query.ts`。这些失败不在本次分镜规则改动范围内，未改写对应文件。未运行全仓测试或重打安装包。

## 生效与边界

源码更新需构建后的运行实例才能采用。新会话初始模板使用更新后的规则；已有会话的已保存约束继续保留，用户主动载入模板时采用新版，载入操作会替换当前编辑内容。已保存镜头、排序、提示词、绑定与用户项目数据不自动重写。

本次不修改检索、索引、素材库、数据库结构或生成提交行为，不发起真实 LLM 或付费媒体请求。自动化检查只能验证规则传递与软件兼容，实际分镜质量需要后续样稿验收。

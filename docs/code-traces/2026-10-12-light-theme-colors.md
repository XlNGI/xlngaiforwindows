# 浅色主题配色

日期：2026-10-12

## 已确认效果

采用用户确认的「暖白＋柔灰＋雾蓝」预览。实现仅修改 `apps/desktop/src/styles.css` 的浅色主题变量和浅色选择器，保留现有布局、深色主题、主题存储与跨窗口同步逻辑。

| 用途 | 色值 |
| --- | --- |
| 应用背景 | `#f1f0ed` |
| 面板背景 | `#fafaf8` |
| 内容背景 | `#ffffff` |
| 控件背景 | `#e9edf1` |
| 主要文字 | `#282f38` |
| 次要文字 | `#53606d` |
| 辅助文字 | `#636e7a` |
| 强调色 | `#4b6f98` |
| 选中背景 | `#e8eef6` |

浅色主按钮和发送按钮使用单色雾蓝；会话输入区使用白色背景和轻边框。历史版本、设置表单、浮动窗口与任务状态中原有的深色文字/边框改用浅色语义变量。草稿、已发布和失败状态使用浅琥珀、浅绿和浅红背景，并保留文字标签。

## 本轮验证

- `pnpm.cmd --filter @ai-video/desktop test -- src/theme.test.tsx src/ScriptWorkspace.test.tsx src/ChatPanel.test.tsx src/workspace/FloatingWindow.test.tsx`：实际执行完整桌面套件，33 文件、306 项测试通过。
- `pnpm.cmd --filter @ai-video/desktop build`：通过，包含 TypeScript 检查和 Vite 生产构建；保留既有 JS 分包大小提示。
- `pnpm.cmd lint`、`pnpm.cmd exec prettier --check apps/desktop/src/styles.css`、`git diff --check`：通过。
- Edge 无头浏览器运行实际 React 界面，以固定 RPC 数据检查 1600×1000 和 1280×800 下的浅色工作区、设置中心、主题切换与 localStorage 保存，无页面脚本错误。
- 主按钮、导航选中项、文档选中项、历史版本按钮和草稿状态的文字对比度分别为 5.22、5.57、5.57、8.15、4.71，均高于 4.5。
- 使用修改前的工作区 CSS 对照：深色设置界面 439 个元素、深色工作区 362 个元素的颜色、背景、边框、阴影、透明度和尺寸一致；深色变量块内容也一致。

本轮为颜色调整，不涉及素材库行为、项目检索、项目数据或外部 Provider 请求。浏览器固定数据检查不代替 Windows 安装包验收。

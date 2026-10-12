# 生成图片完整预览与页内放大

日期：2026-10-12（America/New_York）

## 变更

角色/场景画廊原为 88px 裁切缩略图，点击切换到素材库；镜头参考图用 cover 裁切；生成结果和素材详情没有页内大图查看。现在生成结果直接显示图片，同次多图逐张显示，镜头页按真实 shotId 展示已有图片。角色/场景预览增加到 180px。各预览使用 contain，完整画面以留白适配容器。

共享 ImagePreview 使用同一经 Worker 校验的本地媒体地址，在当前页面打开适配视口的大图，支持关闭按钮、遮罩、Esc、焦点控制与返回。图片源变化会重建查看器；读失败有明确占位。查看功能允许只读项目，不改变素材组、入库、拖拽、文件或费用确认合同。素材库网格仍按原选择规则操作，素材详情图片可点击放大。

## 验证

Desktop 111 项聚焦通过，包括多图片生成后逐张预览、角色/场景点击无需导航、镜头生成结果直接显示、素材详情放大、关闭/遮罩/Esc、焦点控制以及来源更新关闭旧查看器。完整测试 1010 项：Desktop 306、Worker 563、Persistence 52、Contracts 24、Context 8、LLM 32、Generation Adapters 25。

typecheck、lint、format:check、git diff --check 通过；Rust 129 项通过，1 项既有忽略；tauri:build 成功。Vite 大包及 Rust 3 个既有警告保留。日志：`.image-preview-tests.log`、`.image-preview-typecheck.log`、`.image-preview-lint.log`、`.image-preview-rust-tests.log`、`.image-preview-package.log`。

Edge/Playwright 使用实际 React 组件与项目 CSS、模拟 Worker 媒体源，在 1440×900、390×844 验证横图/竖图完整显示、大图始终处于视口内、Esc/关闭正常、无横向溢出及浏览器错误。截图在 `apps/desktop/.m2-ui-image-preview/`（忽略文件）；仅使用合成测试图，未请求真实 Provider 或修改用户项目。

素材方案 Markdown 与 `素材库优化方案.docx`、`素材库优化方案实施文档.docx` 的预览规则同步，内容逐字一致性检查通过。DOCX 渲染未完成：随附 Windows 运行时没有 LibreOffice，render_docx.py 无法生成页面 PNG，未以文字提取代替版式验收。

新版安装包在 `apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`，未安装或替换用户正在使用的应用。

安装包 SHA-256：`29BDF9E7D4F1A10A92FA2A9D04C66259ECD7C7C53D2395AE94B4F4BCD0A7C10D`。

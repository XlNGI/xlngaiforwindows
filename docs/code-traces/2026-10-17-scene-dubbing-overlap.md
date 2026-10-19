# 场次配音与参考资料重叠修复

日期：2026-10-17（America/New_York）

## 问题与复现

用户截图显示场次配音压在角色参考卡片上。使用实际 SceneWorkspace、SceneCastEditor 和 DubbingScenePanel 组件与隔离示例数据，在 1440×900、三角色加场景参考图的配置下复现。

修复前，参考资料区块底部为 762.61 px，卡片内容延伸到 1775.33 px，而配音区从 774.61 px 开始，实际覆盖图片和选择控件。上次只检查横向溢出、图片 contain 与滚动高度，遗漏了区块的纵向边界关系。

## 修复

场次工作区增加 grid-auto-rows: max-content，按内容高度布置每个纵向区块。参考资料不再因视口高度与 min-height: 0 压缩网格行，配音面板始终排列在参考资料之后，工作区继续统一滚动。此次不改变角色、场景、对白或配音功能和存储规则。

保留浏览器回归脚本 apps/desktop/scripts/verify-scene-workspace-layout.mjs，直接渲染实际组件，以 DOM 实际边界检查相邻区块、卡片间的重叠、参考资料容器包围卡片及滚动末端可达性。JSDOM 不参与布局结论。

## 验证

- 浏览器 40 组状态检查通过：场次与镜头页，初始 3/5 个角色，1440×900、1280×720、390×844、1440×600；覆盖异步加载图片、添加角色后的换行、配音展开，以及末端内容滚动可达。页面脚本错误为 0。
- 修复后 1440×900 三角色场景的参考资料区块底部为 1901.33 px，配音区从 1913.33 px 开始，间距 12 px，所有卡片均包含在参考资料区块内。
- 桌面端 50 个文件、452 项测试通过（最终使用 --maxWorkers=2）。首次与构建并行运行时，生产资料刷新用例有一次等待超时；该文件单独复核 11 项通过，随后全部桌面测试通过，未修改相关用例或生产实现。
- pnpm lint、pnpm format:check、pnpm typecheck、git diff --check 及 pnpm tauri:build 通过。最终脚本修改后再次通过 ESLint 与浏览器回归。打包保留 Vite 包体积提示和 Rust 3 个既有警告。
- 样式修复没有更改已确认产品要求，因此无需修改方案 DOCX。未改动真实项目数据库或发起付费请求，未安装或替换正在运行的应用。

运行脚本前，将 SCENE_LAYOUT_BROWSER_NODE_MODULES 设置为 Playwright 所在依赖目录。可选 SCENE_LAYOUT_BROWSER_EXECUTABLE 指定浏览器，SCENE_LAYOUT_EVIDENCE 指定报告目录；从仓库运行 node apps/desktop/scripts/verify-scene-workspace-layout.mjs。脚本自行启动隔离 Vite 服务并清理本次临时示例文件。

## 安装包与证据

安装包：apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe

SHA-256：34D07DDDA9953B71FBFD9E34149C63C0412B53A1DFAD5D7C836C59864DB58B80

浏览器报告和修复前后截图：apps/desktop/.m2-ui-overlap/。日志：.scene-overlap-desktop-tests.log、.scene-overlap-desktop-tests-final.log、.scene-overlap-production-recheck.log、.scene-overlap-lint.log、.scene-overlap-format.log、.scene-overlap-typecheck.log、.scene-overlap-package.log（均忽略）。

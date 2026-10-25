# Qwen Image 图生图适配

日期：2026-10-22。范围：UniCompAPI 目录中的 Qwen Image 2.0／2.0 Pro、3.0／3.0 Pro，以及已有 2.1 Pro／Turbo 合同。

## 官方依据

- [Qwen Image 3.0／2.1 图像生成与编辑](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)：同一模型同时支持文生图和图生图。OpenAI 兼容模式在 `/images/generations` 的 JSON 中提供 `image` 字符串或数组；3.0 最多 3 张、2.1 最多 10 张参考图。单图上限 10 MB，支持公网 URL 或 Base64。`agent` 提示词增强仅用于文生图。尺寸使用 `x` 分隔或 `auto`；响应返回图片 URL，不依赖 `b64_json`、`multipart`、`mask` 或 `/images/edits`。
- [Qwen Image 2.0 图片编辑](https://help.aliyun.com/zh/model-studio/qwen-image-edit-api)：2.0／2.0 Pro 支持 1–3 张参考图和 1–6 张输出；官方 DashScope 使用 `input.messages[].content` 和 `parameters`。UniComp 的平铺图片协议单独登记为 Binding 的传输覆盖，不把它写成官方 DashScope 请求。

## 实施顺序

- [x] Q0：核验上述两份当前官方文档，分别登记 2.0 和 3.0／2.1 的参数、参考图数量和传输差异。
- [x] Q1：为已有 3.0／2.1 合同新增 revision 2，为 2.0／Pro 新增 revision 1；原 revision 1 保持不变。新增 Binding 使用当前合同，旧合同继续支持历史任务读取。文生图和参考生图分别生成入口；图生图必须有参考图，文生图入口拒绝混入图片。
- [x] Q2：接通共用图片输入、Agent 候选、动态表单与 Native 提交。应用使用有序 `images` 数组，在提交时投影成官方 `image`，单图为字符串、多图为数组。3.0／2.1 保留官方 `size` 的 `x`／`auto`；2.0 与历史合同沿用渠道的 `*` 尺寸投影。校验数量、尺寸像素面积、3.0／2.1 宽高比、单图字节限制、Data URL 格式和文件签名；禁止 `agent` 图生图和额外字段。旧 3.0 目录行在读取或同步时升级新能力一次，保留模型启用状态及升级后的用户能力选择。
- [x] Q3：全仓测试、类型检查、Lint、格式检查、Rust 回归与桌面构建全部通过；结果如下。

## 验证与运行边界

聚焦验证已覆盖：六款模型的图生图入口、3／10 张数量上限、参考图顺序、非法参数、旧合同隔离；已有模型读取／同步升级；Agent 图片附件转为受控文件及持久化脱敏；制作界面添加、排序、数量限制与草稿保存；Native 图片字段、尺寸和模型 ID 投影及 Base64 大小／签名检查。

最终验证：

- `pnpm test`：1,808 项通过（context 8、contracts 47、LLM 32、Desktop 525、generation-adapters 153、persistence 78、Worker 965）。
- `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`cargo fmt --check`、`git diff --check` 通过。
- `cargo test --lib`：166 项通过，1 项既有公网下载 smoke 忽略。
- `pnpm tauri:build`：Worker Sidecar、前端、Rust Release 和 NSIS 安装包构建通过。安装包 `apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`，75,090,069 字节，SHA-256 `FEA0888EC1AC7066B313FBEF22E861A1E4DD27017A01691D49A9151C141A78A2`。
- 实际打包 Worker 在隔离临时目录完成项目／连接创建、模拟目录同步、四款当前模型能力及关闭状态校验、六个图生图 Adapter 目录及参数校验。四份原有图片合同与 Git 基线逐项比较保持不变。未安装覆盖当前应用。
- 本轮日志位于仓库忽略文件 `.qwen-image-tests.log`、`.qwen-image-typecheck.log`、`.qwen-image-lint.log`、`.qwen-image-format.log`、`.qwen-image-rust.log`、`.qwen-image-build.log`。打包 Worker 验证目录为 `C:/Users/MSI/AppData/Local/Temp/qwen-image-packaged-as0QPk`。

模型目录仍来自连接同步。新增合同不会创建未同步的模型或启用已关闭的模型。升级后重新打开供应商与模型页面，或重新测试并同步，即可刷新合同；重启应用后加载新的 Worker 和 Native 代码。选中已启用的 Qwen 模型和参考生图入口，提供参考图与提示词即可使用。

验证使用临时 SQLite、模拟接口和本地图片夹具，未修改用户运行时数据库，未调用 UniComp 计费生成接口。用户要求按官方能力实施，因此当前 Binding 按该能力启用；渠道部署是否支持相同能力仍需真实调用验收，不能以自动化测试代替。付费提交仍沿用既有用户确认流程。

# 固定角色配音实施与验证记录

日期：2026-10-14  
范围：角色固定声音 → 场次台词 → 采用配音 → 口型处理／本地合成 → 新视频素材

## 实施范围

用户授权实施 [计划](../CHARACTER-VOICE-DUBBING-IMPLEMENTATION-PLAN.md)，并选择先完成可运行功能和本地验证，真实付费样片稍后进行。

- 项目 Schema v44：角色声音与不可变版本、台词与 take、独立音频文件、制作任务／尝试、源媒体引用。角色使用文档 ID；音频不加入冻结的图片／视频素材库。
- MiniMax Speech 2.8 HD／Turbo 官方固定音色协议，音频在 Native 解码外置；Sync-3 直接 multipart 上传、`x-api-key` 与幂等键、原任务查询、受控下载。连接检测使用不计费的音色／模型目录，测试中未访问真实账号。
- 固定步骤后台调度，页面关闭不停止任务；关闭／切换项目取消本地工作，未知提交不自动重交，有任务 ID 的恢复只查询。取消时迟到的安全远端 ID在原项目仍打开时保存为历史，不恢复取消状态。
- 固定配音作为最终音轨；按实际时长精确分段，旁白跳过口型，成功口型片段按输入哈希复用。成片原子入库、任务日志与场次来源关联，源文件不覆盖。
- Windows x64 LGPL shared FFmpeg，固定 BtbN 月末归档及 SHA256；OpenH264 编码、完整解码、隐藏子进程、期限／取消、512 MiB 输出和至少 16 MiB 磁盘余量。
- 角色页声音配置、场次配音展开、台词编辑、导入／生成／试听采用、人物位置、单次费用确认、成片对比和采用。

## 工程验证

本轮曾发现并修复：原生错误响应在解析前移除等待项导致请求悬挂、Windows 相对路径分隔符、官方音色 ID含空格、素材 video kind 约束、并行测试共用设置库、旧 App 测试遗漏新增查询、场次 flex 压缩重叠以及窄屏 secondary 按钮隐藏。

真实媒体夹具验证：导入 WAV／MP3、缺损音频拒绝、不可变声音、采用 CAS、源文件哈希保护、完整对白合成、本地失败重试、导出后重开、只读访问、项目切换及原任务恢复。口型供应商采用本地模拟协议／输出，不能视为真人样片。

新增 API 参数全部严格检查未知字段、布尔确认、预算、人物身份、归一化坐标、台词长度及 CAS；列表返回有界摘要，完整快照按任务详情读取。历史引用素材可二次确认软删除并恢复，活动任务禁止删除，彻底删除继续受引用约束。

共享检查入口：`pnpm.cmd test`、`typecheck`、`lint`、`format:check`、`build`、`audit`、`license:check`、`worker:sidecar`、`validate:m7-sidecar`、`validate:dubbing-sidecar`、`tauri:build` 与 Rust fmt/check/test。生产依赖 fast-uri override 升至 3.1.8，修复本次真实审计发现的生产高危；ESLint 按既有 Git 忽略规则排除临时 `.m2-ui-*` 验证目录。两份既有源码文件仅整理格式以满足全仓格式门禁。

最终命令、数量与安装记录将在本轮检查结束后填入下表，未填项目不表示通过。

| 检查 | 结果 |
| --- | --- |
| 全仓 TypeScript／JavaScript 测试 | `pnpm.cmd test` 1,164 项通过：Desktop 345、Worker 672、Persistence 58、Contracts 24、Generation 25、LLM 32、Context 8。一次与构建并行的中间执行触发既有 5,000 切片用例的 5 秒超时，后续全仓重跑与 Persistence 单独复跑均通过 |
| Rust 测试及 fmt/check | 最终全仓 146 项通过、1 项既有忽略；配音聚焦 17 项通过；最终 cargo fmt/check 通过 |
| 类型／Lint／格式／差异 | 全仓 typecheck、format:check、lint 和 git diff --check 通过；原生桥删除不必要类型断言后再跑聚焦 Lint 和全仓类型检查 |
| 生产构建、Sidecar、Windows 安装包 | pnpm build、worker:sidecar、M7 Sidecar、media:verify 与最终 tauri:build 通过；NSIS 74,706,304 字节，SHA256 C2C573408A4FC66894AB5B62C2302935B320676EAED6D9575CA806A7FDA55C28 |
| 安装后的配音闭环 | validate-nsis-install.ps1 实际安装后调用 validate-dubbing-sidecar.mjs：随包 FFmpeg、Schema 44、独立音频、采用、本地 H.264 成片、源保护、任务日志及项目导出完整性通过，paidRequests=0；随后桌面／Worker 启动、优雅关闭、无残留进程、卸载清理通过 |
| 生产依赖审计及许可证检查 | pnpm audit --prod --audit-level=high 零已知漏洞；35 个 JS 依赖许可证通过；SBOM 更新。裸 pnpm audit 包含开发依赖，仍报告既有 25 项开发依赖问题，不冒充生产门禁通过 |

## 界面与实际本地流程

使用隔离 TEMP 项目，通过真实浏览器页面操作、Worker RPC 和本地合成夹具验证。1440×900、1280×720、390×844 均无文档横向溢出；场次与镜头共享可滚动容器，配音按钮在窄屏可操作。

实际场次流程完成导入与采用 1.5 秒音频、选择 4 秒 H.264 源视频、提交不计费的本地合成和采用新视频。浏览器的音频／源视频／成片均达到 `readyState=4`，`error=null`；成片保持 4 秒。图片／视频素材库仍使用原类型合同。

## 未完成验收

- 未提交任何真实 TTS 或 Sync 计费请求；10～20 个真人／实际画风样片、音色与口型观感、跨片一致性、真实费用与重试率仍待用户选择账号和预算后验证。
- 克隆声音创建、独立角色页试听任务、预签名 PUT 资产上传、自动背景声分离及复杂多轨剪辑没有实现；当前可用已有音色 ID、场次配音试听、官方直接 multipart 和完整源音轨替换。
- 原生窗口内完整交互、真实旧版本升级、签名、长期断网／睡眠恢复及 FFmpeg 全部第三方依赖源码归档仍待发布验收。工程通过不会解除既有整体发布 HOLD。

GitHub 继续只管理源代码；运行时音频、索引、台词、任务及素材在当前本地项目。未修改既有素材库确认规则，因此不改其 Markdown／DOCX 产品方案。

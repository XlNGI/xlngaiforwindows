# Seedance UniComp 时长传输类型修复

日期：2026-11-02  
范围：UniComp Seedance 2.0／2.5 请求编码；不改变官方参数定义。

## 审计结论

真实项目最近一次 Seedance 2.0 请求在 2026-11-02 21:31（UTC+8）失败，Provider 返回：

```text
json: cannot unmarshal number into Go struct field .Alias.seconds of type string
```

任务没有保存远端任务 ID，轮询次数为 0。此前同渠道 Seedance 请求有相同错误；同连接后续 Wan 请求成功。证据指向 Seedance 请求编码，不是表单按钮、API Key 或普通网络连接故障；现有记录不能证明远端费用状态。

官方参数 `duration: 7` 通过校验后，两个 ModelBinding 的 `copy` 将其投影为数字 `seconds: 7`。原生 `unicompapi_payload` 对合同适配器直接返回 `model_contract::video_payload`，绕过旧通用模板中已有的数字转字符串逻辑。原有 Rust 回归错误地期待数字类型，未发现线协议不兼容。

## 设计

- 官方 `duration` 继续使用整数，保留 `-1` 和各版本范围；不修改正式合同或其修订号，不要求用户修改表单类型。
- 在受限传输映射中增加可选 `valueEncoding: integer-string`，只允许整数编码为十进制字符串；未知编码或非整数明确报错，不执行脚本、不序列化数组或对象。
- 仅两个 UniComp Seedance Binding 的 `duration → seconds` 声明此编码。其他字段及其他模型继续原样复制，素材内容、顺序和布尔值完整保留。
- 输入以已有官方 `duration` Schema 为准：2.0 为 `-1` 或 4–15；2.5 为 `-1` 或 4–30。输出为 JSON string，格式 `^-?[0-9]+$`。脱敏样例：`{"duration":7}` → `{"seconds":"7"}`，`{"duration":-1}` → `{"seconds":"-1"}`；未提供时长时不添加 `seconds`。
- 用真实原生提交编码入口和要求字符串的请求结构回归两模型四种制作模式；保留完整字段投影验证，验证官方参数拒绝字符串时长。

## 顺序与检查清单

- [x] S0 审计：只读核查任务错误和实际路径，保存修改前文件及 SHA256 清单。
- [x] S1 设计：确定仅在 Binding 传输边界编码，保持官方参数语义。
- [x] S2 回归：先运行正确期待字符串的请求体测试，记录修复前失败。
- [x] S3 实施：类型声明、两个 Binding 和原生编码；记录定向测试结果。
- [x] S4 验证：Rust 回归／构建、Contracts／Adapters 测试、全仓类型／构建及静态检查；记录未通过项与运行时生效条件。

不写入真实项目或设置数据库，不重试计费生成。原生代码与内嵌 Binding 需要重新编译并启动新进程，前端热更新不能替换运行中进程的原生逻辑。本轮不主动关闭或替换用户正在运行的应用；已运行的 Tauri 开发监听器可能自动重编译和重启。

审计副本：`C:/Users/MSI/AppData/Local/Temp/seedance-seconds-audit-b3b841bd/`。

S2 记录：`cargo test seedance_gateway --lib -- --nocapture` 在功能修复前运行，2 项失败。真实提交编码入口返回 `invalid type: integer 7, expected a string`；完整字段投影返回数字 `15`，正确期望为字符串 `"15"`。日志：`C:/Users/MSI/AppData/Local/Temp/seedance-seconds-repro.log`。

S3 记录：同一组回归修复后 2 项通过。原生提交入口覆盖两模型四种模式的 7、-1、4 和最大时长，按 `seconds: String` 反序列化真实编码结果，并比较完整请求体；官方参数拒绝字符串时长。完整字段投影继续覆盖参考图／音频／视频顺序、布尔值、可选字段和省略时长。未知编码、字符串、非整数、布尔值、空值、数组和对象会被编码器拒绝。

## S4 验证与运行时记录

| 检查 | 结果 |
| --- | --- |
| 原生回归 | `cargo test --lib`：179 项通过、1 项公开图片网络下载测试按原设置忽略。包括完整字段投影、真实提交编码入口、非整数编码拒绝、Wan／旧模板以及官方视频模拟链路。保留 5 项既有测试 `unused_mut` 提示。 |
| Contracts／Adapters | 各自全包 44／79 项通过；字符串时长仍被正式参数校验拒绝。 |
| Worker | 合同注册表、设置目录、原生桥接、官方视频运行时 4 个文件共 95 项通过；使用测试数据库和模拟 Provider。 |
| 类型与构建 | 全仓 `pnpm typecheck`、`pnpm build` 通过。保留 Vite 既有主包体积提示；没有重新打包 Windows 安装程序。 |
| 定向静态检查 | 本次 TS 源码／测试 ESLint、变更文档／JSON／TS Prettier、`cargo fmt --all -- --check` 和 `git diff --check` 通过。 |
| 全仓静态检查 | Lint 仍为此前 14 项范围外错误，格式检查仍为此前 8 个范围外文件。没有修改相关文件，不声明全仓质量门禁全部通过；此前 Worker 两项上下文预算失败本轮没有重跑。 |
| 原生运行时 | 开发监听器自动完成原生重编译：debug 可执行文件最后写入为 2026-11-02 21:47:36.628（UTC+8），当前进程 PID 100172 于 21:47:36.805 启动，父进程为 cargo.exe；晚于本次全部原生功能改动。未主动结束或替换用户进程。 |

S0–S4 的审计、修复与验证已完成；本次没有修改已确认产品规则，不涉及素材库或检索行为，无需同步产品 DOCX。没有主动写入真实项目或设置数据库，没有发起真实计费请求，不能据此宣称真实渠道已经出片；当前修复解决已确认的请求类型错误。

验证日志均位于 `C:/Users/MSI/AppData/Local/Temp/`，前缀 `seedance-seconds-`：`focused.log`、`rust-all.log`、`contracts-build.log`、`contracts-tests.log`、`adapters-tests.log`、`worker-tests.log`、`typecheck.log`、`build.log`、`eslint.log`、`rustfmt.log`、`format-focused.log`、`lint-all.log`、`format-all.log`、`diff-check.log`。

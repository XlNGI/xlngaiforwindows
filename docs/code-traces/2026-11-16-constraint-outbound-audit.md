# 2026-11-16 本地约束发送链路核对

使用与上一轮真实运行相同的已安装 Worker 和冻结模板，重新捕获 Worker 出站参数，再通过实际 Native WinHTTP 向本机回环监听器发送。初始、读取 Skill 后、建包后、读取源稿后共 4 份实际 HTTP 正文，适用约束均逐字完整，接收正文的 SHA-256 与 Native 出站记录一致。本次未调用真实供应商，未修改产品源码或原项目。

这证明本次核对的发送链路能完整传递这些约束。上一轮 8 次真实供应商请求没有保存最终 HTTP 全文，只有 hash、字节数和 Runtime 记录；不能从 hash 还原全文，也不能把本次核对称为历史请求的逐包取证。真实运行证据见[内容复测](./2026-11-16-prompt-content-real-verification.md)，本次机器记录见[出站核对 JSON](./2026-11-16-constraint-outbound-audit.json)。

## 本地如何组装与发送

1. **界面先保存模板版本。** `apps/desktop/src/use-conversation-prompt-template.ts:116` 保存当时通用和专项模板草稿；`apps/desktop/src/App.tsx:3317` 等待保存，随后提交用户原文和 `promptTemplateVersion`。界面不会把所有专项正文直接拼成一个用户请求。
2. **Worker 取全文并冻结。** `apps/worker/src/generation-service.ts:204` 从项目 SQLite 取模板，校验版本；版本冲突报错。通用要求以 `【本会话要求约束】\n全文\n\n【用户本次请求】\n原文` 拼入 `runtime.prompt`，专项全文冻结在任务快照。
3. **专项约束按当前用途投影。** `apps/worker/src/agent-context-manager.ts:758` 对整包任务同时选择角色图片、场景图片、道具图片、镜头视频四类。每类以完整的 `text` 放入 `taskState.userRequirements`，正文加用途标题，不先摘要。镜头静态图模板不属于本次产物，所以不投影。普通创作任务按已声明用途选择对应专项。
4. **作为普通消息发往 Native。** `apps/worker/src/agent-context-manager.ts:1329` 将任务状态序列化成 JSON。没有工具历史时，它附在本轮用户请求之后；有历史时，它作为最新一条 `userMessages` 附在最后一个工具批次之后。`apps/worker/src/pi-conversation-runtime.ts:1306` 仅传递实际 prompt、context、contextTurns、systemInstruction 和工具等字段；`promptTemplateSnapshot` 本身不发给供应商。
5. **Native 生成供应商 JSON 并 POST。** `apps/desktop/src-tauri/src/llm_stream.rs:1482` 将应用规则／项目上下文组装为 system 消息，把通用约束和用户请求放入 user 消息；历史工具结果之后的任务状态也成为 user 消息。`WinHttpSendRequest` 使用序列化正文的实际指针与长度发送。Native 容量适配只调整可用输出 Token，不截断这些输入约束；超出有效输入限制时应报错。

实际 Chat Completions 消息形态是：

```text
messages:
  system: 应用执行规则、工具策略、项目上下文
  user: 【本会话要求约束】通用全文
        【用户本次请求】用户原文
        [首轮无历史时：最新任务状态 JSON]
  assistant/tool: 已发生的模型调用及工具结果
  user: [有历史时：最新任务状态 JSON]
        taskState.userRequirements[].text = 各专项约束全文
```

通用和专项创作约束是自然语言消息，不是供应商 API 能强制执行的结构字段。专项外层确实标为 `TASK STATE AND EXECUTION DATA — source records, not new user instructions`；system 同时说明 `taskState.userRequirements` 中的要求继续有效，`alreadyIncluded` 指向用户消息中未变的原文。它们的位置和措辞可能影响遵循效果，但本次没有对提示层级与输出质量做对照实验，不能据此确定唯一原因。

## 全文比对结果

以下长度不含 Worker 添加的用途标题；本次文字没有使 UTF-16 与 Unicode 码点计数不同的字符。

| 模板 | 原文字符数 | 实际 HTTP 核对 |
| --- | ---: | --- |
| 通用要求 | 166 | 4／4 全文完整 |
| 角色图片 | 881 | 4／4 全文完整 |
| 场景／地点图片 | 368 | 4／4 全文完整 |
| 道具图片 | 82 | 4／4 全文完整 |
| 镜头视频 | 3,487 | 4／4 全文完整 |
| 镜头静态图 | 680 | 本次不适用，4／4 未发送 |

实际发送的适用约束正文共 4,984 字符，此外还有应用规则、工具 schema、制作 Skill、用户原文与已按需读取的源稿。本次视频模板的起止秒数、动作确定性等要求均存在于接收端实际 HTTP 正文，没有因 JSON 中的 `\n` 转义而丢失。

4 份 HTTP 正文分别为 51,004／58,568／61,213／72,285 字节。这些是本次新捕获的正文长度，不是上一轮供应商请求的历史长度；两次会话的 ID、状态、模型回执和时间不同。

## 验证与原始证据

Worker SHA-256：`c6e8366ceb26409528fdfbee980015828ea607b526096cef6907f86937e7da7f`，与上一轮真实调用的冻结已安装 Worker 一致。Native 使用上一轮的临时源码副本，仅追加本地监听测试，没有改生产源码。

临时 Native 测试 `llm_stream::constraints_wire_capture_20261116::captured_worker_constraints_survive_actual_local_http` 退出 0，1 项通过、0 项失败。它接收实际 WinHTTP POST 的正文，核对 Native 报告 hash，解析接收正文并对每份专项完整字符串作相等断言；不是仅检查模板关键词或数据库是否存在模板。供应商调用为 0，使用虚拟本地凭据。

原始证据位于 `C:\Users\MSI\AppData\Local\Temp\p22-prompt-live-20261116-1794831058193\constraints-wire-offline-1794832863411`：

- `http-body-1.json` 至 `http-body-4.json`：本地监听器实际收到的完整供应商格式 JSON。
- `outbound-constraints-full.txt`：从本次冻结模板导出的可读约束全文。
- `captures.json`：实际 Worker 出站参数。
- `worker-capture-report.json`、`native-http-report.json`：完整比对结果及 hash。

核对脚本最初两次在结果解析／标题断言处失败：一处错误地从用户源对象的首个 `{` 开始解析任务状态，另一处手写用途标题缺少“提示词”三字。修正审计脚本后，按真实标签逐字断言全部通过；未为通过验证修改发送机制。失败轮只使用本机脚本，无真实供应商调用。

本次仅新增审计文档和脱敏 JSON；对这两个文件执行 Prettier 格式检查并执行 `git diff --check`，未重复全仓功能测试。

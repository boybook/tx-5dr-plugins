# Webhook Push

TX-5DR 插件：将 FT8/FT4 解码、通联生命周期与电台状态事件推送到一个或多个
Webhook 端点。每个目标可独立配置请求方式（POST/GET）。

## 功能特性

- **多推送目标**：最多 5 个 Webhook 地址，每个目标独立配置请求方式、请求头与开关
- **连续失败保护**：同一目标连续 11 次最终投递失败后自动禁用，并在投递状态面板与插件日志提醒；修复后手动重新启用
- **每目标测试按钮**：目标行内即点即测，验证地址与请求方式可用性
- **每目标自定义请求头**：如 `Authorization: Bearer <token>`，仅作用于该目标
- **队列合并**：事件按窗口批量发送，减少对端点请求压力；可配置实时模式
- **并行推送**：同一批事件并行推送到各目标，慢端点不会拖累其他目标
- **失败重试**：发送失败自动重试（单次 flush 含重试的总预算约 4.5 秒），仍然失败记录到日志

> 依赖主程序 **object[] 行内控件扩展**（radio / multiselect / action /
> string[] / fullWidth 行布局）：需运行包含主程序
> `feat/plugin-settings-controls` 分支（行内控件改动集）的主程序版本
> （`minHostVersion` 见 `package.json`）。

## 安装

1. 将 `webhook-push` 目录放入 `{dataDir}/plugins/`（或通过插件市场安装）
2. 在主程序插件管理页启用 `Webhook Push`
3. 打开插件设置，添加推送目标并填写 Webhook 地址

> **前提**：本插件为 operator 作用域插件（事件 hook 由 operator 实例驱动），
> 运行前请先在 TX-5DR **创建并启用至少一个 operator**；否则插件实例不会
> 创建，测试按钮与推送功能均不可用，插件设置中的按钮会提示无实例。

## 配置说明

所有设置均为**操作员级**：每个 operator 独立配置自己的推送目标与发送参数，
互不影响。

| 设置 | 说明 |
|---|---|
| `enabled` | 总开关 |
| `targets` | 推送目标数组（每行排布：名称+启用 3:1 一行、地址+请求方式 3:1 一行、请求头/推送内容/测试按钮各占整行）： |
| · `name` | 目标别名（用于日志中区分） |
| · `enabled` | 该目标是否参与推送；连续 11 次最终投递失败后自动关闭，修复后需手动重新启用 |
| · `webhookUrl` | 目标 Webhook 完整地址，`http(s)://`，不支持内嵌凭据与代理 |
| · `method` | 请求方式下拉：`POST`（JSON 作为请求体）/ `GET`（JSON 编码到 `payload` 查询参数） |
| · `headers` | 仅作用于该目标的自定义请求头，每行一个 `Header: value` |
| · `events` | 该目标要推送的内容（下拉多选：解码消息 / 通联 / 时隙 / 频率） |
| · `test` | 行内测试按钮，立即发一条测试事件 |
| `batchWindowSec` | 合并窗口秒数；`0` 表示实时（约 0.1s 合并） |
| `maxBatchSize` | 单次请求最多事件条数 |
| `retryCount` | 失败立即重试次数 |

## Payload（通用 JSON）

```json
{
  "schemaVersion": 1,
  "plugin": "webhook-push",
  "pluginVersion": "0.1.0",
  "operatorId": "OP-1",
  "sentAt": "2026-08-22T12:00:00.000Z",
  "events": [
    {
      "type": "decode",
      "timestamp": 1784793600000,
      "data": { "messages": [ { "snr": -10, "rawMessage": "CQ K1ABC FN42", "message": { "type": "cq", "senderCallsign": "K1ABC" } } ] }
    },
    { "type": "qso.complete", "timestamp": 1784793720000, "data": { "record": { "callsign": "K1ABC", "mode": "FT8", "frequency": 7074000 } } }
  ]
}
```

事件类型：`decode`、`slot`、`qso.start`、`qso.complete`、`qso.fail`、
`freq`、`test`（测试事件）。

**请求方式**：
  - `POST`：JSON 作为请求体，`Content-Type: application/json`
  - `GET`：JSON URL 编码到 `payload` 查询参数（URL 已含查询参数时自动追加）；
    URL 长度超过约 8KB 时该目标会被跳过并记录错误，大批量请改用 POST

## 接入示例

接收端只需要请求一个 `http(s)://` 地址并解析 JSON 即可。例如：

- 自建服务 / 简易脚本：解析 POST 请求体或 GET 的 `payload` 参数，直接消费
  `events` 数组
- 需要鉴权时，在目标的 `headers` 里配置自定义头（如
  `Authorization: Bearer <token>`，每行一个）

> 示例中的 `<token>` 仅为占位符，请使用你自己的密钥。凭据只通过界面输入，
> 不会写入源码或日志。

## 开发

```bash
npm install
npm run build   # tsc 构建到 dist/
npm test        # vitest 单测
```

## 许可

GPL-3.0-only
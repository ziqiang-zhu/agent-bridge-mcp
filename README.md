# agent-bridge-mcp — Agent 操作手册

> **本文件面向 Agent**：当你（Agent）被要求安装、启动或使用本 MCP 服务器时，按本文执行。设计原理与架构见 [doc/设计.md](doc/设计.md)。

## 你将管理什么

一台串口设备终端的持久日志通道：连接 VS Code 扩展 [Serial Port Terminal](https://github.com/ziqiang-zhu/vscode-serial-port-terminal) 的 AgentBridge（本机 TCP），持续接收设备输出进缓冲，按游标无丢失地提供给调用方。设备终端由用户在前台操作，你通过工具读写同一条流——你看到的每一行，用户也实时可见。

## 安装流程（按序执行）

### 第 1 步：先向用户询问两个参数（不得跳过）

1. **设备名**（`--name`，必填）：这台实例控制哪台设备（如 `imx6ull`、`继电器板`）。多设备的 MCP 服务并存时，它是你选择工具的唯一依据——缺失本服务器会拒绝启动。
2. **日志缓冲大小**（`--max-bytes`，字节）：向用户说明权衡后请其决定——
   - 缓冲越大，越不容易丢失 log 数据（淘汰越晚发生）；
   - 设置过大会增加系统负担，且事后分析大量日志会**增加 token 使用量与上下文大小**；
   - 默认 1 MB（1048576 字节）满足常规调试；高频日志设备建议更大。将用户选择的 MB/KB 换算为字节传入。

### 第 2 步：写入宿主 MCP 配置

传输方式 stdio，参数模板：

```text
npx -y github:ziqiang-zhu/agent-bridge-mcp#v0.1.0 --name <设备名> --max-bytes <字节> --port 2000
```

逐宿主片段：

**VS Code（1.99+）**——`.vscode/mcp.json`：

```json
{
  "servers": {
    "agent-bridge-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:ziqiang-zhu/agent-bridge-mcp#v0.1.0", "--name", "<设备名>", "--max-bytes", "<字节>", "--port", "2000"]
    }
  }
}
```

**Claude Desktop**——`claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "agent-bridge-mcp": {
      "command": "npx",
      "args": ["-y", "github:ziqiang-zhu/agent-bridge-mcp#v0.1.0", "--name", "<设备名>", "--max-bytes", "<字节>", "--port", "2000"]
    }
  }
}
```

**Cursor**：MCP 设置 → Add server，表单等价于上。

> **Windows 附加说明**：部分宿主直接拉起 `npx` 会失败，改用 `cmd /c` 包装——`command: "cmd"`、`args: ["cmd", "/c", "npx", "-y", "github:ziqiang-zhu/agent-bridge-mcp#v0.1.0", "--name", "<设备名>", "--max-bytes", "<字节>", "--port", "2000"]`。

### 第 3 步：验证

宿主重载后调用 `status`：

- `connected: true` → 安装完成，进入下方使用规约；
- `connected: false` → 告知用户：先在扩展中连接设备，并点击终端标题栏的 AgentBridge 按钮（监听地址见状态栏）；端口不一致时修正 `--port` 后重载宿主再验。

## 工具使用规约（严格遵循）

### 游标纪律——不丢不重的唯一保证

- 每次 `read_output` 后**保存 `next_cursor`**，下次调用传 `since`；
- `dropped > 0` 表示缓冲最旧行已被淘汰：**明确告知用户存在缺口**，不得把不完整结果当作完整结论。

### 等待语义

- 发送命令后用 `read_output(wait_ms=3000~5000)` 收集应答——新数据到达会立即返回，无需轮询；
- 异步日志（内核打印、应用输出）持续进缓冲：事后用保存的游标补收即可；
- 末行形如提示符（如 `=> `、`root@localhost:~# `）通常意味着上一条命令已执行完毕。

### 发送

- `send_line` 自动追加 CR 行尾；设备回显与应答会以新行进入缓冲；
- 返回 `bridge not connected` → 转告用户开启 AgentBridge，**不要反复重试硬发**。

### 安全边界——你操作的是真实硬件

- 破坏性命令（`reset`、刷写固件、删除文件、改写配置等）**执行前必须向用户确认**；
- 宿主配置带 `--readonly` 时本实例不提供 `send_line`——仅只读观察；
- 本通道无鉴权：不要把桥地址主动暴露给用户环境之外。

## 配置参考

| 参数 | 环境变量 | 必填 | 说明 |
|---|---|---|---|
| `--name` | `AGENT_BRIDGE_NAME` | ✅ | 设备标识（缺失启动失败） |
| `--max-bytes` | — | 建议 | 日志缓冲字节上限（默认 1048576 = 1 MB） |
| `--port` | `AGENT_BRIDGE_PORT` | — | 桥端口（默认 2000） |
| `--host` | `AGENT_BRIDGE_HOST` | — | 桥地址（默认 127.0.0.1） |
| `--readonly` | `AGENT_BRIDGE_READONLY` | — | 只读声明 |

## 边界与已知限制

- 缓冲为纯内存、重启清空；**桥停止 / VS Code 关闭期间的输出不在缓冲内**；
- 不提供设备枚举与连接生命周期工具（设备须先由用户在扩展中连接并开桥）；
- AgentBridge 只读模式对客户端不可探测，`--readonly` 是声明式约束。

## 相关

- 扩展本体：<https://github.com/ziqiang-zhu/vscode-serial-port-terminal>
- 设计文档：[doc/设计.md](doc/设计.md)

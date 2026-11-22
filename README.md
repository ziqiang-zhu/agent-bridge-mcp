# agent-bridge-mcp

[AgentBridge MCP 服务器](doc/设计.md)——为 VS Code 扩展 [Serial Port Terminal](https://github.com/ziqiang-zhu/vscode-serial-port-terminal) 的 AgentBridge 提供标准 MCP（Model Context Protocol）接入。

**解决的核心痛点**：Agent 直连 AgentBridge 裸 TCP 时每次命令都「连接 → 发送 → 断开」，断开窗口内的设备输出被桥丢弃（桥不做历史缓冲），只能靠倒计时抓日志窗口。本服务器作为桥的**持久订阅者**：全程在线接收、游标缓冲，Agent 以无状态工具调用随时补收——不丢、不重、事后可读。

## 前置条件

- VS Code 扩展 Serial Port Terminal 已连接串口设备，并**开启 AgentBridge**（终端标题栏 📢 按钮；默认监听 `127.0.0.1:2000`，地址见状态栏，客户端数以 `· N` 常驻显示）；
- Node.js ≥ 18（`npx` 随 npm 附带）；
- **git**（分发为 git 直连：`npx github:` 安装时 npm 自动 clone 仓库、执行 prepare 编译、装依赖并启动——首次拉取稍慢，之后走 npm 缓存）。

## 🚀 一条提示词接入

把下面这段提示词发给你的 Agent（Claude Desktop / Cursor / VS Code Copilot / ZCode 均可），它会自主完成安装与连接：

```text
1. 把 MCP 服务器 agent-bridge-mcp 添加到你的 MCP 客户端配置并启动：
   传输方式 stdio，命令 npx -y github:ziqiang-zhu/agent-bridge-mcp#v0.1.0 --name <设备名> --port 2000；
2. 调用 status 工具确认已连接 127.0.0.1:2000；
3. 之后用 read_output 查看设备输出、send_line 发送命令，等待我的进一步指令。
```

`--name` **必填**：设备标识（如 `imx6ull`、`继电器板`），多设备/多实例并存时它是 Agent 选择工具的依据，缺失则启动失败。端口按 AgentBridge 实际监听地址调整（状态栏可见）。`#v0.1.0` 为版本 tag——钉住可复现，改为 `#main` 则跟随主干（不推荐用于稳定使用）。

## ⚙️ 逐宿主配置片段

### VS Code（1.99+，Copilot Chat / Agent 模式）

`.vscode/mcp.json`：

```json
{
  "servers": {
    "agent-bridge-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:ziqiang-zhu/agent-bridge-mcp#v0.1.0", "--name", "<设备名>", "--port", "2000"]
    }
  }
}
```

### Claude Desktop

`claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "agent-bridge-mcp": {
      "command": "npx",
      "args": ["-y", "github:ziqiang-zhu/agent-bridge-mcp#v0.1.0", "--name", "<设备名>", "--port", "2000"]
    }
  }
}
```

### Cursor

MCP 设置 → Add server：name `agent-bridge-mcp`、type `stdio`、command `npx -y github:ziqiang-zhu/agent-bridge-mcp#v0.1.0 --name <设备名> --port 2000`。

> **Windows 附加说明**：部分宿主在 Windows 上直接拉起 `npx` 会失败，改用 `cmd /c` 包装——`command: "cmd"`、`args: ["cmd", "/c", "npx", "-y", "github:ziqiang-zhu/agent-bridge-mcp#v0.1.0", "--name", "<设备名>", "--port", "2000"]`。

## 🛠️ 工具

| 工具 | 参数 | 说明 |
|---|---|---|
| `read_output` | `since?`（游标）、`wait_ms?`（长轮询等待上限，默认 0）、`max_lines?`（默认 200） | 读取设备输出行（已剥离 ANSI）。`since` 来自上次返回的 `next_cursor`；缺省从缓冲最旧读起。每行带单调递增 `seq`，下次调用回传 `next_cursor` 即可**不丢不重** |
| `send_line` | `text` | 发送一行文本到设备（自动追加 CR 行尾）；用 `read_output` 收集应答 |
| `status` | 无 | 连接状态（host / port / connected）与缓冲状态（oldest / newest / dropped_total） |

典型循环：`send_line` 命令 → `read_output(wait_ms=5000)` 收集应答 → 存下 `next_cursor` → 下一轮。异步日志（内核打印等）持续进缓冲，事后带游标读取即可补收。

## ⚙️ 配置

| 参数 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--name` | `AGENT_BRIDGE_NAME` | **必填** | 设备标识（多设备/多实例时 Agent 选择工具的依据；缺失启动失败） |
| `--host` | `AGENT_BRIDGE_HOST` | `127.0.0.1` | AgentBridge 监听地址 |
| `--port` | `AGENT_BRIDGE_PORT` | `2000` | AgentBridge 端口 |
| `--readonly` | `AGENT_BRIDGE_READONLY` | 关 | 声明只读：不注册 `send_line`（见下安全说明） |
| `--max-bytes` | — | `1048576` | 缓冲字节上限（utf8 计；超出从最旧行淘汰，读取结果以 `dropped` 诚实报告） |

重启后缓冲回归默认（无长期存储——虚拟/调试用途定位，不需要跨会话保留）。

> 🔒 **安全警告——与 AgentBridge 同源的风险**：本服务器接入的是一条**无鉴权、无加密的本机明文通道**，任何本地进程/用户经 MCP 客户端接入即获得设备控制工具。仅在意只读观察时，务必以 `--readonly` 启动；注意 AgentBridge 的只读模式客户端侧不可探测，`--readonly` 只是「本进程不注册发送工具」的声明式约束。

## ⚠️ 已知限制

- AgentBridge 停止或 VS Code 关闭期间的输出不在缓冲内（缓冲仅覆盖本进程存活且桥在线的窗口）；
- 不提供设备枚举 / 连接生命周期工具（设备须先在扩展中连接并开启桥）；
- AgentBridge 只读模式客户端侧不可探测，`--readonly` 为声明式约束。

## 相关仓库

- 扩展本体：<https://github.com/ziqiang-zhu/vscode-serial-port-terminal>
- AgentBridge 配套 Skill（裸 TCP 形态）：<https://github.com/ziqiang-zhu/agent-bridge-skills>
- 设计文档：[doc/设计.md](doc/设计.md)

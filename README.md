# agent-bridge-mcp — Agent 操作手册

> **本文件面向 Agent**：当你（Agent）被要求安装、启动或使用本 MCP 服务器时，按本文执行。设计原理与架构见 [doc/设计.md](doc/设计.md)。

## 你将管理什么

一台串口设备的持久数据通道，支持两种形态，由桥的托管方决定：

- **终端托管桥**（用户在扩展终端里开桥）：按行接收设备输出进缓冲，按游标无丢失地提供给你——适合 shell / U-Boot 等命令行设备；
- **串口助手托管桥**（用户在扩展的串口助手面板里开桥）：原样字节流进缓冲，二进制保真——适合传感器、协议帧、继电器控制板等纯数据设备。

设备面板由用户在前台操作，你通过工具读写同一条流——你看到的每一行/每一段数据，用户也实时可见。

## 安装流程（按序执行）

### 第 1 步：先向用户询问三个参数（不得跳过）

1. **设备名**（`--name`，必填）：这台实例控制的设备名（如 `imx6ull`、`GNSS_Module`）。多设备的 MCP 服务并存时，它是你选择工具的唯一依据——缺失本服务器会拒绝启动。
2. **日志缓冲大小**（`--max-bytes`，字节）：向用户说明权衡后请其决定——
   - 缓冲越大，越不容易丢失 log 数据（淘汰越晚发生）；
   - 设置过大会增加系统负担，且事后分析大量日志会**增加 token 使用量与上下文大小**；
   - 默认 1 MB（1048576 字节）满足常规调试；高频日志设备建议更大。将用户选择的 MB/KB 换算为字节传入。
3. **桥的托管形态**（`--mode`，决定工具集）：
   - 用户在**终端面板**里开的桥 → `--mode terminal`（默认，行工具：`read_output` / `send_line`）；
   - 用户在**串口助手面板**里开的桥 → `--mode stream`（字节工具：`read_bytes` / `send_bytes`）；
   - 桥不会告知托管方，**必须问用户**；选错的表现是「工具能调但数据不符合预期」（终端桥剥了 ANSI、按行转发）。若用户不确定桥从哪里开的，请其查看 VS Code 状态栏的 `AgentBridge <host:port>` 并回忆是从终端还是助手面板开启。

### 第 2 步：写入宿主 MCP 配置

传输方式 stdio，参数模板：

```text
npx -y github:ziqiang-zhu/agent-bridge-mcp#v0.2.1 --name <设备名> --max-bytes <字节> --port 2000 --mode <terminal|stream>
```

逐宿主片段：

**VS Code（1.99+）**——`.vscode/mcp.json`：

```json
{
  "servers": {
    "agent-bridge-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:ziqiang-zhu/agent-bridge-mcp#v0.2.1", "--name", "<设备名>", "--max-bytes", "<字节>", "--port", "2000", "--mode", "<terminal|stream>"]
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
      "args": ["-y", "github:ziqiang-zhu/agent-bridge-mcp#v0.2.1", "--name", "<设备名>", "--max-bytes", "<字节>", "--port", "2000", "--mode", "<terminal|stream>"]
    }
  }
}
```

**Cursor**：MCP 设置 → Add server，表单等价于上。

> **Windows 附加说明**：部分宿主直接拉起 `npx` 会失败，改用 `cmd /c` 包装——`command: "cmd"`、`args: ["/c", "npx", "-y", "github:ziqiang-zhu/agent-bridge-mcp#v0.2.1", "--name", "<设备名>", "--max-bytes", "<字节>", "--port", "2000", "--mode", "<terminal|stream>"]`。

> **网络受限附加说明**：`#v0.2.1` 是 git 标签（可变引用），npx **每次启动都要联网**将 tag 解析为 commit——包体已在本地缓存也绕不开这一步。宿主机无法访问 GitHub 或延迟高时，宿主会报连接超时并反复重试。此时改用本地直跑：`git clone` 本仓库 → `npm install`（prepare 钩子自动构建 dist）→ 宿主配置 `command` 为 node 绝对路径、`args` 首位为 `dist/server.js` 绝对路径；Windows 下项目路径含空格时宿主会按空格截断，改为从无空格路径的启动器 js（内容一行 `require('<仓库>\dist\server.js')`）中转，参数原样透传；仓库更新后重跑 `npm run build` 刷新 dist。

### 第 3 步：验证

宿主重载后调用 `status`（断开态调用会先尝试立即连接，报回的是尝试后的真实状态——桥已开启但实例还在退避等待时也能即刻确认）：

- `connected: true` → 安装完成，进入下方使用规约；同时核对 `mode` 与用户确认的托管形态一致；`version` 是当前运行版本（用于与 GitHub 最新 tag 比较，见「保持更新」），`update_pending: true` 表示磁盘已是新版但还需重载宿主才生效；
- `connected: false` → 告知用户：先在扩展中连接设备并开启 AgentBridge（终端面板标题栏按钮，或串口助手面板工具栏按钮；监听地址见状态栏）；端口不一致时修正 `--port` 后重载宿主再验；
- 宿主报**连接超时**并反复重试 → 第 2 步的 GitHub 前提不满足，按其网络受限附加说明改本地直跑。

## 工具使用规约（严格遵循）

### 游标纪律——不丢不重的唯一保证

- 每次 `read_output`（terminal 模式）或 `read_bytes`（stream 模式）后**保存 `next_cursor`**，下次调用传 `since`；
- 行游标（seq）与字节游标（字节偏移）**互不通用**——同一实例只会提供其中一种；
- `dropped > 0` / `dropped_bytes > 0` 表示缓冲最旧部分已被淘汰：**明确告知用户存在缺口**，不得把不完整结果当作完整结论。

### 等待语义

- 发送后用 `read_output(wait_ms=3000~5000)`（terminal）或 `read_bytes(wait_ms=3000~5000)`（stream）收集应答——新数据到达会立即返回，无需轮询；
- `status` / 读工具在断开态会先尝试即时挂接（绕过重连退避）：桥刚开启时直接调用即可，无需等退避周期走完；
- 异步日志持续进缓冲：事后用保存的游标补收即可；
- terminal 模式末行形如提示符（如 `=> `、`root@localhost:~# `）通常意味着上一条命令已执行完毕。

### 发送

- （terminal）`send_line` 自动追加 CR 行尾；设备回显与应答会以新行进入缓冲；
- （stream）`send_bytes` **不追加任何行尾**：`data` 用十六进制（默认，如 `"55 85 11 94"`）或 base64（`encoding: "base64"`）编码，单次上限 4096 字节——二进制协议按设备手册构造完整帧再发送，不要自行补 CR/LF；
- 返回 `bridge not connected` → 转告用户开启 AgentBridge，**不要反复重试硬发**。

### 安全边界——你操作的是真实硬件

- 破坏性命令（`reset`、刷写固件、删除文件、改写配置等）**执行前必须向用户确认**；
- stream 模式下设备可能是无命令解析能力的纯数据设备：向它发送任何字节都可能触发动作或改变状态，发送前同样必须确认；
- 宿主配置带 `--readonly` 时本实例不提供任何 send 工具——仅只读观察；
- 本通道无鉴权：不要把桥地址主动暴露给用户环境之外。

## 保持更新

`status` 提供两个字段配合更新：`version`（当前运行的代码版本）与 `update_pending`（磁盘上的版本高于运行版本——已更新、待重载宿主）。本服务器**不联网**，新版检查由下面这条宿主指令规则在 Agent 侧完成。

### 把检查规则写进宿主指令（需用户同意）

安装完成后，**先询问用户是否允许**把下面的规则写入其宿主指令文件（ZCode 用 `AGENTS.md`，Claude Code 用 `CLAUDE.md`，Cursor 用 `.cursor/rules/` 等）。允许才写入；不允许则不写，并告知用户：「之后需要你明确要求我检查更新，我才执行」。

```text
每次会话首次使用 agent-bridge-mcp 服务器前：
1. 调用 status 取 version；
2. 用 https://api.github.com/repos/ziqiang-zhu/agent-bridge-mcp/tags 查最新 tag；
3. 仅当最新版本高于 status.version 时，用一句话提示用户有新版本，并给出对应更新方法：
   本机直跑 → git pull → npm install → 重载宿主；
   npx 安装 → 修改配置里的 #tag → 重载宿主；
4. 网络失败或超时则静默跳过，不重试、不阻塞当前作业；每个会话最多提示一次。
```

### 两种安装形态的更新步骤

- **本机直跑**（启动器指向本地仓库 `dist/`）：`git pull` → `npm install`（prepare 自动构建）→ 重载宿主；重载前 `status.update_pending` 会变为 `true`。
- **npx**（`github:…#vX.Y.Z`）：把宿主配置里的 tag 改成新版本 → 重载宿主。

## 配置参考

| 参数 | 环境变量 | 必填 | 说明 |
|---|---|---|---|
| `--name` | `AGENT_BRIDGE_NAME` | ✅ | 设备标识（缺失启动失败） |
| `--max-bytes` | — | 建议 | 缓冲字节上限（默认 1048576 = 1 MB；行模式按 utf8 计、字节模式按原始字节计） |
| `--mode` | `AGENT_BRIDGE_MODE` | 建议 | 桥托管形态：`terminal`（默认，行工具）或 `stream`（字节工具）；须与开桥的扩展面板一致 |
| `--port` | `AGENT_BRIDGE_PORT` | — | 桥端口（默认 2000） |
| `--host` | `AGENT_BRIDGE_HOST` | — | 桥地址（默认 127.0.0.1） |
| `--readonly` | `AGENT_BRIDGE_READONLY` | — | 只读声明 |

## 边界与已知限制

- 缓冲为纯内存、重启清空；**桥停止 / VS Code 关闭期间的输出不在缓冲内**；
- 不提供设备枚举与连接生命周期工具（设备须先由用户在扩展中连接并开桥）；
- **terminal 模式对二进制数据不保真**：终端托管桥上游已剥 ANSI、按行缓冲，二进制帧不可恢复——需要二进制时请用户改用串口助手面板开桥并以 `--mode stream` 重载本实例；
- **stream 模式不提供行工具**：字节游标与行游标语义不同，工具集二选一；
- 本服务器不联网：新版检查由宿主指令规则完成（见「保持更新」），`update_pending` 只反映「磁盘已更新、待重载」；
- AgentBridge 只读模式对客户端不可探测，`--readonly` 是声明式约束。

## 相关

- 扩展本体：<https://github.com/ziqiang-zhu/vscode-serial-port-terminal>
- 设计文档：[doc/设计.md](doc/设计.md)

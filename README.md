# agent-bridge-mcp

[AgentBridge MCP 服务器](doc/设计.md)——为 VS Code 扩展 [Serial Port Terminal](https://github.com/ziqiang-zhu/vscode-serial-port-terminal) 的 AgentBridge 提供标准 MCP（Model Context Protocol）接入：持久订阅 AgentBridge 的串口数据流并以游标缓冲消除「Agent 单次连接即断开」导致的日志丢失，以无状态工具（`read_output` / `send_line` / `status`）供任意 MCP 客户端（Claude Desktop / Cursor / VS Code Copilot 等）操控嵌入式设备终端。

## 状态

**设计阶段（未实现）**——设计文档见 [doc/设计.md](doc/设计.md)，实现自 P0 起步（见设计文档 §10 演进路线）。

## 相关仓库

- 扩展本体：<https://github.com/ziqiang-zhu/vscode-serial-port-terminal>
- AgentBridge 配套 Skill：<https://github.com/ziqiang-zhu/agent-bridge-skills>（裸 TCP 形态的技能包；本仓库为 MCP 形态，工具自描述、免装 Skill）

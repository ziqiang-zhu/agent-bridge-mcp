#!/usr/bin/env node
// agent-bridge-mcp 入口：stdio MCP 服务器（doc/设计.md §2/§9）。
// P0 骨架：配置解析 + 启动日志 + 空工具表的 stdio 会话——bridgeClient 与工具装配
// 随批次②补入。stdout 被 MCP 协议独占，一切日志走 stderr（§7.1 红线）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveConfig, UsageError } from './config';

const VERSION = '0.1.0'; // 与 package.json 同步维护（npm 发版前核对）

const PREFIX = '[agent-bridge-mcp]';
const log = (message: string): void => {
  console.error(`${PREFIX} ${message}`);
};

async function main(): Promise<void> {
  let config;
  try {
    config = resolveConfig(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      log(error.message);
      return;
    }
    log(`invalid arguments: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  log(
    `v${VERSION} starting (host=${config.host} port=${config.port} readonly=${config.readonly} ` +
    `maxLines=${config.maxLines} maxBytes=${config.maxBytes})`
  );

  const server = new McpServer({ name: 'agent-bridge-mcp', version: VERSION });
  // 工具装配随批次②补入；当前 ListTools 返回空表。
  await server.connect(new StdioServerTransport());
  log('stdio transport connected');
}

void main();

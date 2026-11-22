#!/usr/bin/env node
// agent-bridge-mcp 入口：stdio MCP 服务器（doc/设计.md §2/§9）。
// 装配：配置解析 → RingBuffer + BridgeClient（持久订阅，断线重连）→ 工具注册 →
// stdio 会话。stdout 被 MCP 协议独占，一切日志走 stderr（§7.1 红线）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeClient } from './bridgeClient';
import { resolveConfig, UsageError } from './config';
import { RingBuffer } from './lineBuffer';
import { registerTools } from './tools';

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

  const ring = new RingBuffer({ maxLines: config.maxLines, maxBytes: config.maxBytes });
  const bridge = new BridgeClient(config.host, config.port);
  bridge.on('status', connected => {
    log(connected ? `bridge connected (${config.host}:${config.port})` : 'bridge disconnected (reconnecting)');
  });
  bridge.on('error', error => {
    log(`bridge error: ${error.message}`);
  });
  bridge.on('line', line => {
    ring.push(line);
  });
  bridge.start();

  const server = new McpServer({ name: 'agent-bridge-mcp', version: VERSION });
  registerTools(server, { bridge, ring, readonly: config.readonly, host: config.host, port: config.port });
  await server.connect(new StdioServerTransport());
  log('stdio transport connected');
}

void main();

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

const VERSION = '0.1.1'; // 与 package.json 同步维护（npm 发版前核对）

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
    `v${VERSION} starting (name=${config.name} host=${config.host} port=${config.port} readonly=${config.readonly} ` +
    `maxBytes=${config.maxBytes})`
  );

  const ring = new RingBuffer({ maxBytes: config.maxBytes });
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

  // MCP 服务器名携带设备标识（initialize 报告 + 宿主 UI 显示实例自描述）。
  const server = new McpServer({ name: `agent-bridge-mcp (${config.name})`, version: VERSION });
  registerTools(server, { bridge, ring, readonly: config.readonly, name: config.name, host: config.host, port: config.port });
  await server.connect(new StdioServerTransport());
  log('stdio transport connected');

  // 生命周期（真机缺陷修复：桥在线时活跃 socket 会挂住事件循环，宿主关停 stdio 后
  // 进程滞留为孤儿、占着桥客户端位不释放）：stdin 结束 = 宿主关停 → 停桥 → 退出。
  const shutdown = (): void => {
    log('shutting down (stdio closed)');
    bridge.stop();
    process.exit(0);
  };
  process.stdin.on('end', shutdown);
  process.on('SIGINT', shutdown);
}

void main();

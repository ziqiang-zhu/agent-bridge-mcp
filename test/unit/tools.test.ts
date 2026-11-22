import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { BridgeClient } from '../../src/bridgeClient';
import { RingBuffer } from '../../src/lineBuffer';
import { registerTools } from '../../src/tools';

// 工具层契约（doc/设计.md §4 / §8.1 #8–#10）：宽容输入（max_lines 超限收敛到 1000、
// 负值/超限 wait_ms 不报错）、max_lines 截断 + next_cursor 续收、readonly 声明裁剪
// send 类工具。经 SDK InMemoryTransport 配对走真实 MCP 协议层（握手 + 工具调用），
// 无 socket、确定性；BridgeClient 不 start（send 路径的连接断言走 isError 通道）。

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

const makePair = async (options: { readonly?: boolean; maxLines?: number; lines?: string[] } = {}) => {
  const ring = new RingBuffer({ maxLines: options.maxLines ?? 100, maxBytes: 10_000_000 });
  for (const line of options.lines ?? []) {
    ring.push(line);
  }
  const bridge = new BridgeClient('127.0.0.1', 1); // 不 start：未连接态
  const server = new McpServer({ name: 'agent-bridge-mcp (test-device)', version: '0.1.0-test' });
  registerTools(server, { bridge, ring, readonly: options.readonly ?? false, name: 'test-device', host: '127.0.0.1', port: 1 });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  return { client, ring, bridge };
};

const callTool = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  return result;
};

const payload = (result: ToolResult): Record<string, unknown> => JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;

describe('MCP 工具（read_output / send_line / status）', () => {
  it('#8 tolerates over-limit and negative parameters without error', async () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `line-${i + 1}`);
    const { client } = await makePair({ lines, maxLines: 5000 });
    // max_lines 99999 → 收敛 1000：恰好返回 1000 行（可观测的收敛断言）
    const capped = await callTool(client, 'read_output', { max_lines: 99999 });
    assert.equal(capped.isError, undefined);
    const payload1 = payload(capped);
    const lines1 = payload1.lines as { seq: number; text: string }[];
    assert.equal(lines1.length, 1000);
    assert.equal(payload1.next_cursor, 1000);
    // 负值 / 越界参数不报错，按收敛语义执行：wait_ms -5 → 0（即时）；max_lines 0 → 最小 1
    const negative = await callTool(client, 'read_output', { since: 1000, wait_ms: -5, max_lines: 0 });
    assert.equal(negative.isError, undefined);
    const payloadN = payload(negative);
    const linesN = payloadN.lines as { seq: number; text: string }[];
    assert.equal(linesN.length, 1);
    assert.equal(linesN[0]?.seq, 1001);
  });

  it('#9 truncates by max_lines and continues via next_cursor', async () => {
    const { client } = await makePair({ lines: ['l1', 'l2', 'l3', 'l4', 'l5'] });
    const first = payload(await callTool(client, 'read_output', { max_lines: 3 }));
    assert.deepEqual(
      (first.lines as { seq: number; text: string }[]).map(line => line.text),
      ['l1', 'l2', 'l3']
    );
    assert.equal(first.next_cursor, 3);
    const second = payload(await callTool(client, 'read_output', { since: first.next_cursor, max_lines: 3 }));
    assert.deepEqual(
      (second.lines as { seq: number; text: string }[]).map(line => line.text),
      ['l4', 'l5']
    );
    assert.equal(second.next_cursor, 5);
    assert.equal(second.dropped, 0);
  });

  it('#10 omits send tools when readonly is declared', async () => {
    const readonlyPair = await makePair({ readonly: true });
    const listed = (await readonlyPair.client.listTools()).tools;
    const tools = listed.map(tool => tool.name);
    assert.ok(tools.includes('read_output'));
    assert.ok(tools.includes('status'));
    assert.ok(!tools.includes('send_line'), 'readonly must not register send_line');
    // 设备标识注入工具描述（§4 用户定夺 2026-11-22）：Agent 选择工具前即知操作对象
    const readOutput = listed.find(tool => tool.name === 'read_output');
    assert.match(readOutput?.description ?? '', /test-device/);

    const writablePair = await makePair({});
    const writableTools = (await writablePair.client.listTools()).tools.map(tool => tool.name);
    assert.ok(writableTools.includes('send_line'));
  });

  it('#10b reports bridge-not-connected via isError on send_line', async () => {
    const { client } = await makePair({});
    const result = await callTool(client, 'send_line', { text: 'help' });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /bridge not connected/);
  });

  it('#10c reports device identity and buffer state on status', async () => {
    const { client } = await makePair({ lines: ['a', 'b'] });
    const state = payload(await callTool(client, 'status'));
    assert.equal(state.name, 'test-device');
    assert.equal(state.connected, false);
    assert.equal(state.host, '127.0.0.1');
    assert.deepEqual(state.buffer, { oldest: 1, newest: 2, dropped_total: 0 });
  });
});

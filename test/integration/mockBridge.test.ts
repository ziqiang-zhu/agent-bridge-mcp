import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { BridgeClient } from '../../src/bridgeClient';
import { ByteRing } from '../../src/byteBuffer';
import type { BridgeMode } from '../../src/config';
import { RingBuffer } from '../../src/lineBuffer';
import { registerTools } from '../../src/tools';

// mock 桥集成契约（doc/设计.md §8.1 #11–#21 / §8.2 #28–#29）：真实 TCP（mock 桥 =
// 测试内 net.Server，按 LinuxShell 语义回发，或 stream 模式回发原始字节）+ 真实
// BridgeClient / RingBuffer / ByteRing / MCP 工具层，经 InMemoryTransport 配对走真实
// 协议层。确定性：无真实设备、无时间敏感断言。

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

interface Payload extends Record<string, unknown> {
  lines?: { seq: number; text: string }[];
  next_cursor?: number;
  dropped?: number;
  data?: string;
  dropped_bytes?: number;
  oldest_offset?: number;
  newest_offset?: number;
  connected?: boolean;
  host?: string;
  port?: number;
  mode?: string;
  buffer?: Record<string, number>;
}

// mock 桥：测试内 net.Server，支持同端口 stop/restart（供重连用例）与向客户端写入。
class MockBridge {
  private server: net.Server | undefined;
  private sockets: net.Socket[] = [];
  readonly received: string[] = [];
  readonly receivedBuffers: Buffer[] = [];
  private listenPort = 0;

  // 已建立过的连接总数（socket 只增不移除）：#20 用它断言「连接态查询不重复拨号」。
  get connectionCount(): number {
    return this.sockets.length;
  }

  async listen(port = 0): Promise<number> {
    this.server = net.createServer(socket => {
      this.sockets.push(socket);
      socket.on('data', chunk => {
        this.receivedBuffers.push(Buffer.from(chunk));
        this.received.push(chunk.toString('utf8'));
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', () => resolve());
    });
    this.listenPort = (this.server.address() as net.AddressInfo).port;
    return this.listenPort;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.listen(this.listenPort);
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets.splice(0)) {
      socket.destroy();
    }
    await new Promise<void>(resolve => this.server?.close(() => resolve()));
  }

  write(text: string): void {
    for (const socket of this.sockets) {
      socket.write(text);
    }
  }

  writeBytes(data: Buffer): void {
    for (const socket of this.sockets) {
      socket.write(data);
    }
  }

  receivedBytes(): Buffer {
    return Buffer.concat(this.receivedBuffers);
  }

  /**
   * 服务端 accept 就绪信号：客户端 'connect' 可能先于服务端 'connection' 到达
   *（Windows IOCP 时序，扩展仓集成同样记录过该竞态）——此刻向 sockets 写数据会
   * 落空。所有「连接后立即下行写入」的用例在写入前先等此信号。
   */
  async waitForClient(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (this.sockets.length === 0) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('mock bridge saw no client within timeout');
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

interface Wiring {
  client: Client;
  ring: RingBuffer;
  byteRing: ByteRing;
  bridge: BridgeClient;
  mock: MockBridge;
  addClient: () => Promise<Client>;
}

// 失败兜底登记（after 统一停桥）：见 describe 内 after 注释。
const liveBridges: MockBridge[] = [];
const liveClients: BridgeClient[] = [];

async function wireUp(
  options: { maxBytes?: number; reconnectBaseMs?: number; bridgeDown?: boolean; mode?: BridgeMode } = {}
): Promise<Wiring> {
  const mode = options.mode ?? 'terminal';
  const mock = new MockBridge();
  const port = await mock.listen();
  if (options.bridgeDown) {
    // 先拿端口再下线：客户端将在「桥未监听」状态下启动（首次尝试失败 → 退避挂起）
    await mock.stop();
  }
  const ring = new RingBuffer({ maxBytes: options.maxBytes ?? 1_000_000 });
  const byteRing = new ByteRing({ maxBytes: options.maxBytes ?? 1_000_000 });
  const bridge = new BridgeClient('127.0.0.1', port, { reconnectBaseMs: options.reconnectBaseMs ?? 50 });
  if (mode === 'stream') {
    bridge.on('chunk', chunk => byteRing.push(chunk));
  } else {
    bridge.on('line', line => ring.push(line));
  }
  bridge.start();
  liveBridges.push(mock);
  liveClients.push(bridge);

  const deps = { bridge, ring, byteRing, readonly: false, name: 'mock-device', host: '127.0.0.1', port, mode };
  const addClient = async (): Promise<Client> => {
    const server = new McpServer({ name: 'agent-bridge-mcp', version: '0.1.0-test' });
    registerTools(server, deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
    return client;
  };
  const client = await addClient();
  return { client, ring, byteRing, bridge, mock, addClient };
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

function payload(result: ToolResult): Payload {
  return JSON.parse(result.content[0]?.text ?? '{}') as Payload;
}

async function status(client: Client): Promise<Payload> {
  return payload(await callTool(client, 'status'));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('condition not met within timeout');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe('mock 桥集成（真实 TCP + 真实工具层）', () => {
  // 失败兜底：任一用例中途抛错时其收尾会被跳过，残留的已连接 socket 会撑住事件
  // 循环令 node --test 进程永不退出——统一在此兜底停桥停客户端（正常用例末尾的
  // stop 保留，双重 stop 幂等：sockets 已清空、server.close 二次调用回调即触发）。
  after(async () => {
    for (const bridge of liveClients) {
      bridge.stop();
    }
    for (const bridge of liveBridges) {
      await bridge.stop();
    }
  });

  it('#11 connects and reports status', async () => {
    const wiring = await wireUp();
    await waitFor(async () => (await status(wiring.client)).connected === true);
    const state = await status(wiring.client);
    assert.equal(state.host, '127.0.0.1');
    assert.equal(state.port, wiring.mock['listenPort']);
    wiring.bridge.stop();
    await wiring.mock.stop();
  });

  it('#12 survives bridge stop and reconnects after restart', async () => {
    const wiring = await wireUp();
    await waitFor(async () => (await status(wiring.client)).connected === true);
    // 本用例验证客户端的自动重连：只停 mock 桥，不得 stop 客户端（stop 为收尾语义）
    await wiring.mock.stop();
    await waitFor(async () => (await status(wiring.client)).connected === false);
    await wiring.mock.restart();
    await waitFor(async () => (await status(wiring.client)).connected === true, 15000);
    wiring.bridge.stop();
    await wiring.mock.stop();
  });

  it('#13 delivers send_line to the bridge with CR ending', async () => {
    const wiring = await wireUp();
    await waitFor(async () => (await status(wiring.client)).connected === true);
    const result = await callTool(wiring.client, 'send_line', { text: 'help' });
    assert.equal(result.isError, undefined);
    assert.equal(payload(result).ok, true);
    await waitFor(() => wiring.mock.received.join('').includes('help\r'));
    wiring.bridge.stop();
    await wiring.mock.stop();
  });

  it('#14 collects a full command round trip without loss or duplication', async () => {
    const wiring = await wireUp();
    await waitFor(async () => (await status(wiring.client)).connected === true);
    await wiring.mock.waitForClient();
    await callTool(wiring.client, 'send_line', { text: 'help' });
    // LinuxShell 语义：回显 + 应答 + 提示符（\r\n 行尾）
    wiring.mock.write('help\r\nAvailable commands: help\r\nroot@localhost:~# ');
    await waitFor(async () => {
      const state = await status(wiring.client);
      return (state.buffer?.newest ?? 0) >= 3;
    });
    const first = payload(await callTool(wiring.client, 'read_output', { since: 0 }));
    assert.deepEqual(
      (first.lines ?? []).map(line => line.text),
      ['help', 'Available commands: help', 'root@localhost:~# ']
    );
    // 不重复：自 next_cursor 续读为空
    const second = payload(await callTool(wiring.client, 'read_output', { since: first.next_cursor }));
    assert.deepEqual(second.lines ?? [], []);
    wiring.bridge.stop();
    await wiring.mock.stop();
  });

  it('#15 wakes long-poll on new data and times out to empty', async () => {
    const wiring = await wireUp();
    await waitFor(async () => (await status(wiring.client)).connected === true);
    await wiring.mock.waitForClient();
    // 长轮询中被新数据唤醒
    const polling = callTool(wiring.client, 'read_output', { wait_ms: 1000 });
    setTimeout(() => wiring.mock.write('later\r\n'), 100);
    const started = Date.now();
    const woken = payload(await polling);
    assert.deepEqual((woken.lines ?? []).map(line => line.text), ['later']);
    assert.ok(Date.now() - started < 900, `should wake before wait_ms, took ${Date.now() - started}ms`);
    // 无数据：超时空返回（自上次游标续读），耗时 ≥ wait_ms 的大半
    const idleStart = Date.now();
    const idle = payload(await callTool(wiring.client, 'read_output', { since: woken.next_cursor, wait_ms: 250 }));
    assert.deepEqual(idle.lines ?? [], []);
    assert.ok(Date.now() - idleStart >= 200, `should wait at least ~wait_ms, took ${Date.now() - idleStart}ms`);
    wiring.bridge.stop();
    await wiring.mock.stop();
  });

  it('#16 lets two agents collect independently with own cursors', async () => {
    const wiring = await wireUp();
    const agent2 = await wiring.addClient();
    await waitFor(async () => (await status(wiring.client)).connected === true);
    await wiring.mock.waitForClient();
    wiring.mock.write('a\r\nb\r\n');
    await waitFor(async () => ((await status(wiring.client)).buffer?.newest ?? 0) >= 2);
    const agent1View = payload(await callTool(wiring.client, 'read_output', {}));
    assert.equal(agent1View.next_cursor, 2);
    wiring.mock.write('c\r\n');
    await waitFor(async () => (await status(wiring.client)).buffer?.newest === 3);
    const agent1Later = payload(await callTool(wiring.client, 'read_output', { since: agent1View.next_cursor }));
    assert.deepEqual((agent1Later.lines ?? []).map(line => line.text), ['c']);
    // agent2 从头独立收集全量
    const agent2View = payload(await callTool(agent2, 'read_output', {}));
    assert.deepEqual((agent2View.lines ?? []).map(line => line.text), ['a', 'b', 'c']);
    wiring.bridge.stop();
    await wiring.mock.stop();
  });

  it('#17 reports the gap honestly after buffer overflow', async () => {
    // 定宽行（6B/行）保证字节上限 → 保留行数确定：1200B 总量、300B 上限 → 保留末 50 行
    const wiring = await wireUp({ maxBytes: 300 });
    await waitFor(async () => (await status(wiring.client)).connected === true);
    await wiring.mock.waitForClient();
    for (let i = 1; i <= 200; i += 1) {
      wiring.mock.write(`l-${String(i).padStart(4, '0')}\r\n`);
    }
    await waitFor(async () => (await status(wiring.client)).buffer?.newest === 200);
    const state = await status(wiring.client);
    assert.equal(state.buffer?.dropped_total, 150);
    // 缺省读（since 缺省 = 从最旧起）：dropped 按定义为 0（起点即最旧、无个人缺口），
    // 淘汰的发现通道是 status 的 dropped_total（§3.2 诚实报告）
    const result = payload(await callTool(wiring.client, 'read_output', {}));
    const lines = result.lines ?? [];
    assert.equal(lines.length, 50);
    assert.equal(lines[0]?.text, 'l-0151');
    assert.equal(result.dropped, 0);
    wiring.bridge.stop();
    await wiring.mock.stop();
  });

  it('#18 delivers an idle-flushed half-line (prompt visibility)', async () => {
    const wiring = await wireUp();
    await waitFor(async () => (await status(wiring.client)).connected === true);
    await wiring.mock.waitForClient();
    // 桥空闲刷出形态：无换行的半行（典型 = 提示符）→ MCP 侧 200ms 空闲刷出为独立行，
    // agent 经 read_output 及时看到「命令已执行完」的提示符信号（§3.1 空闲刷出语义）
    wiring.mock.write('root@localhost:~# ');
    const result = payload(await callTool(wiring.client, 'read_output', { wait_ms: 1500 }));
    assert.deepEqual((result.lines ?? []).map(line => line.text), ['root@localhost:~# ']);
    wiring.bridge.stop();
    await wiring.mock.stop();
  });

  it('#19 attaches immediately via query tools while reconnect backoff is pending', async () => {
    // 大退避基数（10s）：自主循环在首次失败后要等 10s 才会再试——若靠退避，本次
    // 断言必然失败；桥恢复监听后的单次查询应即时挂接（§3.3 查询即挂接）
    const wiring = await wireUp({ reconnectBaseMs: 10_000, bridgeDown: true });
    const refused = await status(wiring.client);
    assert.equal(refused.connected, false); // 首次尝试失败（桥未监听），退避 10s 挂起
    await new Promise(resolve => setTimeout(resolve, 50));
    await wiring.mock.restart();
    const started = Date.now();
    // read_output 与 status 共用 connectNow：两次独立调用各自验证
    const read = payload(await callTool(wiring.client, 'read_output', {}));
    assert.equal(read.connected, true);
    const state = await status(wiring.client);
    assert.equal(state.connected, true);
    assert.ok(Date.now() - started < 5000, `should attach immediately, took ${Date.now() - started}ms`);
    wiring.bridge.stop();
    await wiring.mock.stop();
  });

  it('#20 does not dial a second socket when status runs while connected', async () => {
    const wiring = await wireUp();
    await waitFor(async () => (await status(wiring.client)).connected === true);
    // connectionCount 是服务端视角：客户端 'connect' 先于服务端 accept 时计数仍为 0，
    // 先等 accept 落地再断言「两次查询不额外拨号」。
    await wiring.mock.waitForClient();
    const first = await status(wiring.client);
    const second = await status(wiring.client);
    assert.equal(first.connected, true);
    assert.equal(second.connected, true);
    assert.equal(wiring.mock.connectionCount, 1, 'connected-state query must not dial again');
    wiring.bridge.stop();
    await wiring.mock.stop();
  });

  it('#21 keeps the autonomous reconnect loop alive after a failed attach attempt', async () => {
    // 断开态单次 status 的挂接尝试失败后不再调用任何工具：退避循环须自行在桥恢复
    // 后完成重连（证明挂接失败未污染自主循环，§3.3 反抖动语义保留）
    const wiring = await wireUp({ reconnectBaseMs: 60, bridgeDown: true });
    const refused = await status(wiring.client);
    assert.equal(refused.connected, false);
    await wiring.mock.restart();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('autonomous reconnect did not happen')), 8000);
      wiring.bridge.once('status', connected => {
        if (connected) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    wiring.bridge.stop();
    await wiring.mock.stop();
  });

  it('#28 keeps a binary round trip byte-exact in stream mode', async () => {
    const wiring = await wireUp({ mode: 'stream' });
    await waitFor(async () => (await status(wiring.client)).connected === true);
    await wiring.mock.waitForClient();
    const frame = Buffer.from([0x55, 0x85, 0x11, 0x94, 0x0a, 0x00, 0xff, 0x0d, 0x80, 0xaa]);
    wiring.mock.writeBytes(frame);
    await waitFor(async () => ((await status(wiring.client)).buffer?.newest_offset ?? 0) >= frame.length);
    const read = payload(await callTool(wiring.client, 'read_bytes', {}));
    const received = Buffer.from(String(read.data), 'base64');
    assert.equal(received.length, frame.length);
    assert.deepEqual([...received], [...frame]);
    assert.equal(read.next_cursor, frame.length);
    // send_bytes：hex 编码 → 桥收到精确字节、不追加行尾
    const sent = await callTool(wiring.client, 'send_bytes', { data: '55 85 11 94 aa' });
    assert.equal(sent.isError, undefined);
    await waitFor(() => wiring.mock.receivedBytes().length >= 5);
    assert.deepEqual([...wiring.mock.receivedBytes()], [0x55, 0x85, 0x11, 0x94, 0xaa]);
    wiring.bridge.stop();
    await wiring.mock.stop();
  });

  it('#29 wakes the byte long-poll on new bytes and times out to empty', async () => {
    const wiring = await wireUp({ mode: 'stream' });
    await waitFor(async () => (await status(wiring.client)).connected === true);
    await wiring.mock.waitForClient();
    const polling = callTool(wiring.client, 'read_bytes', { wait_ms: 1000 });
    setTimeout(() => wiring.mock.writeBytes(Buffer.from([0x01, 0x02, 0x03])), 100);
    const started = Date.now();
    const woken = payload(await polling);
    assert.deepEqual([...Buffer.from(String(woken.data), 'base64')], [0x01, 0x02, 0x03]);
    assert.ok(Date.now() - started < 900, `should wake before wait_ms, took ${Date.now() - started}ms`);
    const idleStart = Date.now();
    const idle = payload(await callTool(wiring.client, 'read_bytes', { since: woken.next_cursor, wait_ms: 250 }));
    assert.equal(Buffer.from(String(idle.data), 'base64').length, 0);
    assert.ok(Date.now() - idleStart >= 200, `should wait at least ~wait_ms, took ${Date.now() - idleStart}ms`);
    wiring.bridge.stop();
    await wiring.mock.stop();
  });
});

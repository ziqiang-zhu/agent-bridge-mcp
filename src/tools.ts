// MCP 工具装配（doc/设计.md §4/§9.1）：read_output / send_line / status。
// - 参数校验：宽容输入（超限静默收敛到上限，§4.2——模型给的数值偏差不值得一次失败
//   重试）；类型非法由 zod schema 拦截（SDK 转为协议级校验错误）；
// - 工具级错误走结果通道 isError: true（模型可见可重试），不用协议级错误；
// - readonly 声明后 send 类工具不注册（§4——桥 readonly 客户端不可探测，依赖用户
//   声明；send_raw 归 P1）；
// - read_output 长轮询：即时读空且 wait_ms>0 且桥在线时挂 waiter 等新行（§3.5）；
//   桥离线时数据不可能到达，直接返回不空等；
// - 设备标识（--name 必填，用户定夺 2026-11-22）：name 注入全部工具 description 与
//   status 返回——多桥多实例并存时 Agent 在「选择工具之前」就知道每个工具操作的是
//   哪台设备（选择阶段消除歧义，防误发）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BridgeClient } from './bridgeClient';
import { RingBuffer } from './lineBuffer';

const WAIT_MS_MAX = 30000;
const MAX_LINES_MAX = 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function waitForLine(bridge: BridgeClient, waitMs: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(finish, waitMs);
    function finish(): void {
      clearTimeout(timer);
      bridge.off('line', onLine);
      resolve();
    }
    function onLine(): void {
      finish();
    }
    bridge.on('line', onLine);
  });
}

const text = (payload: unknown) => [{ type: 'text' as const, text: JSON.stringify(payload) }];
const errorText = (message: string) => ({ isError: true as const, content: text({ error: message }) });

export interface ToolDeps {
  bridge: BridgeClient;
  ring: RingBuffer;
  readonly: boolean;
  name: string;
  host: string;
  port: number;
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { bridge, ring, name } = deps;

  server.registerTool(
    'read_output',
    {
      description:
        `Read device output lines collected from the serial terminal of device '${name}' (ANSI ` +
        'already stripped by the bridge). Pass `since` (a cursor from a previous call) to get only ' +
        'newer lines; omit it to read from the oldest buffered line. Set `wait_ms` to long-poll for ' +
        'new data instead of returning immediately. Each line carries a monotonically increasing ' +
        '`seq` - store the returned `next_cursor` and pass it back as `since` next time to never ' +
        'miss or duplicate output.',
      inputSchema: {
        since: z.number().int().optional(),
        wait_ms: z.number().int().optional(),
        max_lines: z.number().int().optional(),
      },
    },
    async args => {
      // 缺省从缓冲最旧开始：读取语义是 seq > since，故缺省种子取 oldest - 1（含最旧行）。
      // 范围越界不进 schema（宽容输入 §4.2）——全部由 clamp 收敛。
      const since = Math.max(0, args.since ?? Math.max(0, ring.oldest() - 1));
      const waitMs = clamp(args.wait_ms ?? 0, 0, WAIT_MS_MAX);
      const maxLines = clamp(args.max_lines ?? 200, 1, MAX_LINES_MAX);
      let result = ring.readSince(since, maxLines);
      if (result.lines.length === 0 && waitMs > 0 && bridge.connected) {
        await waitForLine(bridge, waitMs);
        result = ring.readSince(since, maxLines);
      }
      const last = result.lines.length > 0 ? result.lines[result.lines.length - 1] : undefined;
      const nextCursor = last !== undefined ? last.seq : Math.max(since, result.newest);
      return {
        content: text({
          lines: result.lines,
          next_cursor: nextCursor,
          dropped: result.dropped,
          connected: bridge.connected,
        }),
      };
    }
  );

  if (!deps.readonly) {
    server.registerTool(
      'send_line',
      {
        description:
          `Send one line of text to the device '${name}' over its serial terminal. A line ending ` +
          '(CR by default, configurable at server start) is appended automatically. Collect the ' +
          'response with `read_output`.',
        inputSchema: {
          text: z.string().min(1).max(4000),
        },
      },
      async args => {
        const sent = bridge.send(Buffer.from(`${args.text}\r`, 'utf8'));
        if (!sent) {
          return errorText('bridge not connected - start Agent Bridge in the Serial Port Terminal extension first');
        }
        return { content: text({ ok: true }) };
      }
    );
  }

  server.registerTool(
    'status',
    {
      description:
        `Report the state of device '${name}': the connection to its AgentBridge (host, port, ` +
        'connected) and the line buffer state (oldest/newest seq, total dropped lines).',
      inputSchema: {},
    },
    async () => ({
      content: text({
        name,
        connected: bridge.connected,
        host: deps.host,
        port: deps.port,
        readonly: deps.readonly,
        buffer: {
          oldest: ring.oldest(),
          newest: ring.newest(),
          dropped_total: ring.droppedTotal(),
        },
      }),
    })
  );
}

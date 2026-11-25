// MCP 工具装配（doc/设计.md §4/§4.1/§9.1）：工具集按 --mode 二选一——
// terminal = read_output / send_line / status（行工具）；stream = read_bytes /
// send_bytes / status（字节工具）。两套游标（行 seq 与字节 offset）语义不同，
// 同一实例不同时注册（§4）。
// - 参数校验：宽容输入（超限静默收敛到上限，§4.2——模型给的数值偏差不值得一次失败
//   重试）；类型非法由 zod schema 拦截（SDK 转为协议级校验错误）；payload 编码格式
//   非法（hex/base64）走工具级错误通道；
// - 工具级错误走结果通道 isError: true（模型可见可重试），不用协议级错误；
// - readonly 声明后 send 类工具不注册（§4——桥 readonly 客户端不可探测，依赖用户
//   声明）；
// - 长轮询：即时读空且 wait_ms>0 且桥在线时挂 waiter 等新数据（§3.5）；桥离线时
//   数据不可能到达，直接返回不空等；
// - 查询即挂接（§3.3）：status / read_output / read_bytes 断开态调用先 connectNow
//   （立即尝试 + ≤300ms 定格）再应答——报回/读取的是尝试后的真实状态；
// - 设备标识（--name 必填）：name 注入全部工具 description 与 status 返回——多桥多
//   实例并存时 Agent 在「选择工具之前」就知道每个工具操作的是哪台设备。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BridgeClient } from './bridgeClient';
import { ByteRing } from './byteBuffer';
import { RingBuffer } from './lineBuffer';
import type { BridgeMode } from './config';

const WAIT_MS_MAX = 30000;
const MAX_LINES_MAX = 1000;
const MAX_BYTES_DEFAULT = 4096;
const MAX_BYTES_MAX = 65536;
const SEND_BYTES_MAX = 4096;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function waitFor(bridge: BridgeClient, event: 'line' | 'chunk', waitMs: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(finish, waitMs);
    function finish(): void {
      clearTimeout(timer);
      bridge.off(event, onData);
      resolve();
    }
    function onData(): void {
      finish();
    }
    bridge.on(event, onData);
  });
}

const text = (payload: unknown) => [{ type: 'text' as const, text: JSON.stringify(payload) }];
const errorText = (message: string) => ({ isError: true as const, content: text({ error: message }) });

/** stream 模式上行 payload 解码：hex（默认）/ base64；格式非法返回错误文案。 */
function decodePayload(data: string, encoding: string | undefined): { bytes: Buffer } | { error: string } {
  const kind = encoding ?? 'hex';
  const cleaned = data.replace(/\s+/g, '');
  if (cleaned.length === 0) {
    return { error: 'data must not be empty' };
  }
  if (kind === 'hex') {
    if (cleaned.length % 2 !== 0) {
      return { error: 'hex payload must contain an even number of digits' };
    }
    if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
      return { error: 'hex payload contains invalid characters' };
    }
    const bytes = Buffer.from(cleaned, 'hex');
    if (bytes.length > SEND_BYTES_MAX) {
      return { error: `payload exceeds ${SEND_BYTES_MAX} bytes` };
    }
    return { bytes };
  }
  if (kind === 'base64') {
    if (cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
      return { error: 'base64 payload is invalid' };
    }
    const bytes = Buffer.from(cleaned, 'base64');
    if (bytes.length > SEND_BYTES_MAX) {
      return { error: `payload exceeds ${SEND_BYTES_MAX} bytes` };
    }
    return { bytes };
  }
  return { error: `unsupported encoding '${kind}' (use hex or base64)` };
}

export interface ToolDeps {
  bridge: BridgeClient;
  ring: RingBuffer;
  byteRing: ByteRing;
  readonly: boolean;
  name: string;
  host: string;
  port: number;
  mode: BridgeMode;
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { bridge, ring, byteRing, name } = deps;

  if (deps.mode === 'terminal') {
    server.registerTool(
      'read_output',
      {
        description:
          `Read device output lines collected from the serial terminal of device '${name}' (ANSI ` +
          'already stripped by the bridge). When disconnected, the call first attempts to connect ' +
          'to the bridge immediately (bypassing the reconnect backoff). Pass `since` (a cursor from a previous call) to get only ' +
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
        // 查询即挂接（§3.3）：断开态先即时挂接再读——挂接成功后长轮询才有新行可等。
        if (!bridge.connected) {
          await bridge.connectNow();
        }
        // 缺省从缓冲最旧开始：读取语义是 seq > since，故缺省种子取 oldest - 1（含最旧行）。
        // 范围越界不进 schema（宽容输入 §4.2）——全部由 clamp 收敛。
        const since = Math.max(0, args.since ?? Math.max(0, ring.oldest() - 1));
        const waitMs = clamp(args.wait_ms ?? 0, 0, WAIT_MS_MAX);
        const maxLines = clamp(args.max_lines ?? 200, 1, MAX_LINES_MAX);
        let result = ring.readSince(since, maxLines);
        if (result.lines.length === 0 && waitMs > 0 && bridge.connected) {
          await waitFor(bridge, 'line', waitMs);
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
            `Send one line of text to the device '${name}' over its serial terminal. A CR ` +
            '(carriage return) is appended automatically. Collect the response with `read_output`.',
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
  } else {
    server.registerTool(
      'read_bytes',
      {
        description:
          `Read raw bytes from the serial data stream of device '${name}' (pass-through bridge). ` +
          'When disconnected, the call first attempts to connect to the bridge immediately. Pass ' +
          '`since` (a byte-offset cursor from a previous call) to read only newer bytes; omit it to ' +
          'read from the oldest buffered byte. Returns base64-encoded data plus `next_cursor`; store ' +
          'it and pass it back as `since` next time. Set `wait_ms` to long-poll for new bytes. Use ' +
          'this tool for binary protocols; line-based `read_output` is not available in stream mode.',
        inputSchema: {
          since: z.number().int().optional(),
          wait_ms: z.number().int().optional(),
          max_bytes: z.number().int().optional(),
        },
      },
      async args => {
        if (!bridge.connected) {
          await bridge.connectNow();
        }
        // 缺省从缓冲最旧字节开始：读取语义是 [since, next)，since = oldest 即含最旧字节。
        const since = Math.max(0, args.since ?? byteRing.oldest());
        const waitMs = clamp(args.wait_ms ?? 0, 0, WAIT_MS_MAX);
        const maxBytes = clamp(args.max_bytes ?? MAX_BYTES_DEFAULT, 1, MAX_BYTES_MAX);
        let result = byteRing.readSince(since, maxBytes);
        if (result.data.length === 0 && waitMs > 0 && bridge.connected) {
          await waitFor(bridge, 'chunk', waitMs);
          result = byteRing.readSince(since, maxBytes);
        }
        return {
          content: text({
            data: result.data.toString('base64'),
            next_cursor: result.nextCursor,
            dropped_bytes: result.droppedBytes,
            oldest_offset: result.oldest,
            newest_offset: result.newest,
            connected: bridge.connected,
          }),
        };
      }
    );

    if (!deps.readonly) {
      server.registerTool(
        'send_bytes',
        {
          description:
            `Send raw bytes to device '${name}' without any line ending. Encode the payload as hex ` +
            '(default) or base64. Use this tool for binary protocols.',
          inputSchema: {
            data: z.string().min(1).max(8192),
            encoding: z.string().optional(),
          },
        },
        async args => {
          const decoded = decodePayload(args.data, args.encoding);
          if ('error' in decoded) {
            return errorText(decoded.error);
          }
          const sent = bridge.send(decoded.bytes);
          if (!sent) {
            return errorText('bridge not connected - start Agent Bridge in the Serial Port Terminal extension first');
          }
          return { content: text({ ok: true }) };
        }
      );
    }
  }

  server.registerTool(
    'status',
    {
      description:
        `Report the state of device '${name}': the connection to its AgentBridge (host, port, ` +
        'connected, mode) and the buffer state (line mode: oldest/newest seq and total dropped ' +
        'lines; stream mode: oldest/newest byte offsets and dropped bytes). When disconnected, the ' +
        'call first attempts to connect immediately (bypassing the reconnect backoff) and reports ' +
        'the resulting state.',
      inputSchema: {},
    },
    async () => {
      // 查询即挂接（§3.3）：断开态先尝试立即连接，报回的是尝试后的真实状态。
      if (!bridge.connected) {
        await bridge.connectNow();
      }
      const buffer =
        deps.mode === 'stream'
          ? { oldest_offset: byteRing.oldest(), newest_offset: byteRing.newest(), dropped_bytes: byteRing.droppedTotal() }
          : { oldest: ring.oldest(), newest: ring.newest(), dropped_total: ring.droppedTotal() };
      return {
        content: text({
          name,
          mode: deps.mode,
          connected: bridge.connected,
          host: deps.host,
          port: deps.port,
          readonly: deps.readonly,
          buffer,
        }),
      };
    }
  );
}

// 持久上游客户端（doc/设计.md §3.3/§9.1）：连接 / 断线自动重连（指数退避 1s 起
// 30s 封顶）/ 收发。多字节安全——TextDecoder 流式解码吸收跨 chunk 的 UTF-8 字符，
// 行组装交 LineAssembler（半行保留）；断线收尾：decoder 冲尾 + 半行刷出为独立行
// （先于 status 下行，保证缓冲先收完再翻状态，§3.4）。桥不可达时进程保持存活，
// 重连循环持续；stop() 为收尾语义（停止重连并断开，MCP 服务器关闭时调用）。
// connectNow() 查询即挂接（§3.3）：断开态立即尝试一次连接并等待定格（≤300ms）。
// 事件：'chunk'（原始 Buffer，两模式都发，stream 模式字节环用）/ 'line'（组装后的行，
// terminal 模式行环用）/ 'status' / 'error'。
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { LineAssembler } from './lineBuffer';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// 空闲刷出（与桥的 200ms 语义对齐）：桥空闲刷出的半行（如提示符）到达本进程后，
// 行组装会再次缓冲等 \n——若无空闲刷出，提示符要到下一波输出才可见，桥侧「消除
// 提示符延迟」的设计意图在 MCP 层被二次延迟。200ms 静默即把残留半行刷出为独立行。
const IDLE_FLUSH_MS = 200;
// 查询即挂接的定格等待上限（§3.3）：本机拒绝/接受均为瞬时，上限只对「不可达远端的
// SYN 悬挂」生效——超时如实返回当前状态，自主重连循环不受影响。
const CONNECT_NOW_SETTLE_MS = 300;

export interface BridgeClientOptions {
  // 重连退避基数（毫秒，默认 1000、逐次翻倍、30s 封顶）；测试注入小值加速重连。
  reconnectBaseMs?: number;
}

export class BridgeClient extends EventEmitter {
  private readonly host: string;
  private readonly port: number;
  private socket: Socket | undefined;
  private assembler: LineAssembler | undefined;
  private decoder = new TextDecoder('utf-8');
  private stopped = false;
  private connectedState = false;
  private backoffMs: number;
  private readonly reconnectBaseMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(host: string, port: number, options: BridgeClientOptions = {}) {
    super();
    this.host = host;
    this.port = port;
    this.reconnectBaseMs = options.reconnectBaseMs ?? RECONNECT_BASE_MS;
    this.backoffMs = this.reconnectBaseMs;
    // 兜底：无监听者时 emit('error') 会同步抛出，异常打断 socket 的 error→close 事件
    // 链——close 不触发则重连永不调度（重连循环依赖 close）。与扩展仓 AgentBridge 的
    // server.on('error', noop) 同款模式；真实监听者（server.ts 生命周期日志）不受影响。
    this.on('error', () => {});
  }

  get connected(): boolean {
    return this.connectedState;
  }

  start(): void {
    if (this.stopped || this.socket !== undefined) {
      return;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearIdleFlush();
    this.cancelRetryTimer();
    this.connectedState = false;
    this.socket?.destroy();
  }

  // 查询即挂接（§3.3）：工具层（status/read_output）在断开态调用——取消挂起的退避
  // timer 并立即发起一次真实连接尝试，等待其定格（≤CONNECT_NOW_SETTLE_MS）。幂等：
  // 已连接立即返回 true；在途尝试不重复拨号、只等其定格。失败不重置退避序列（反抖
  // 动语义保留，自主循环不受影响）；stopped 为收尾语义，不再发起。
  async connectNow(): Promise<boolean> {
    if (this.stopped) {
      return this.connectedState;
    }
    this.cancelRetryTimer();
    if (this.socket === undefined) {
      this.connect();
    }
    return new Promise<boolean>(resolve => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.off('status', onStatus);
        this.off('close', onClose);
        resolve(value);
      };
      const onStatus = (connected: boolean): void => {
        if (connected) {
          finish(true);
        }
      };
      const onClose = (): void => {
        finish(this.connectedState);
      };
      const timer = setTimeout(() => finish(this.connectedState), CONNECT_NOW_SETTLE_MS);
      this.on('status', onStatus);
      this.on('close', onClose);
      if (this.connectedState) {
        finish(true);
      }
    });
  }

  // 上行；未连接返回 false（工具层据此报「bridge not connected」，不假成功）。
  send(data: Buffer): boolean {
    if (!this.connectedState || this.socket === undefined) {
      return false;
    }
    this.socket.write(data);
    return true;
  }

  private connect(): void {
    if (this.stopped || this.socket !== undefined) {
      return;
    }
    const socket = new Socket();
    this.socket = socket;
    this.assembler = new LineAssembler();
    this.decoder = new TextDecoder('utf-8');
    socket.on('connect', () => {
      this.connectedState = true;
      this.backoffMs = this.reconnectBaseMs;
      this.emit('status', true);
    });
    socket.on('data', (chunk: Buffer) => {
      // 原始字节事件（stream 模式字节环的数据源）：两模式都发——terminal 模式无监听者，
      // 零成本；stream 模式据此保持二进制保真（不经 TextDecoder、不切行，§3.6）。
      this.emit('chunk', chunk);
      const assembler = this.assembler;
      if (assembler === undefined) {
        return;
      }
      const text = this.decoder.decode(chunk, { stream: true });
      for (const line of assembler.push(text)) {
        this.emit('line', line);
      }
      this.armIdleFlush(assembler);
    });
    socket.on('error', (error: Error) => {
      this.emit('error', error);
    });
    socket.on('close', () => {
      this.socket = undefined;
      this.clearIdleFlush();
      const hadConnected = this.connectedState;
      this.connectedState = false;
      // 断线收尾（§3.4）：decoder 冲尾 + 半行刷出为独立行——先于 status 下行。
      // 两段皆空时不得拼出 "undefined" 字面量入缓冲。
      const assembler = this.assembler;
      if (assembler !== undefined) {
        let flushed = this.decoder.decode();
        const half = assembler.flush();
        if (half !== undefined) {
          flushed += half;
        }
        if (flushed !== '') {
          this.emit('line', flushed);
        }
      }
      if (hadConnected) {
        this.emit('status', false);
      }
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
    socket.connect(this.port, this.host);
  }

  private scheduleReconnect(): void {
    if (this.retryTimer !== undefined || this.stopped) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RECONNECT_MAX_MS);
    const timer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
    // unref：不因重连等待而单独撑住进程——进程生命周期由 MCP stdio 传输承载。
    timer.unref();
    this.retryTimer = timer;
  }

  private armIdleFlush(assembler: LineAssembler): void {
    this.clearIdleFlush();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      const half = assembler.flush();
      if (half !== undefined) {
        this.emit('line', half);
      }
    }, IDLE_FLUSH_MS);
  }

  private clearIdleFlush(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  private cancelRetryTimer(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }
}

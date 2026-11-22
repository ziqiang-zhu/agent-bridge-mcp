// 行组装 + 环形缓冲 + 游标（doc/设计.md §3）：纯逻辑、零依赖、零 I/O。
// - LineAssembler：按 \n 切分上游 chunk，尾段保留等待续行（吸收桥 200ms 半行刷出）；
//   每完整行剥离一个行尾 \r（桥下行 CRLF，模型侧文本无需保留）。flush() 将残留半行
//   刷出为独立行（断线收尾 §3.4——重连后组装从零开始，宁拆两行不错拼）。
// - RingBuffer：单调 seq（从 1 起，跨上游重连连续）+ 双上限淘汰（行数 / utf8 字节，
//   从最旧淘汰，至少保留最新一行——单行超上限时不自我清空）+ dropped 诚实统计。

export interface BufferLine {
  seq: number;
  text: string;
}

export function stripTrailingCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

export class LineAssembler {
  private pending = '';

  push(chunk: string): string[] {
    this.pending += chunk;
    const lines: string[] = [];
    for (let index = this.pending.indexOf('\n'); index >= 0; index = this.pending.indexOf('\n')) {
      lines.push(stripTrailingCr(this.pending.slice(0, index)));
      this.pending = this.pending.slice(index + 1);
    }
    return lines;
  }

  flush(): string | undefined {
    if (this.pending === '') {
      return undefined;
    }
    const line = this.pending;
    this.pending = '';
    return stripTrailingCr(line);
  }
}

export interface RingBufferOptions {
  maxLines: number;
  maxBytes: number;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export class RingBuffer {
  private readonly entries: BufferLine[] = [];
  private nextSeq = 1;
  private bytes = 0;
  private droppedCount = 0;
  private readonly maxLines: number;
  private readonly maxBytes: number;

  constructor(options: RingBufferOptions) {
    this.maxLines = options.maxLines;
    this.maxBytes = options.maxBytes;
  }

  // 返回本行 seq 与本次 push 触发的淘汰数（诚实统计，见 §3.2）。
  push(line: string): { seq: number; dropped: number } {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.entries.push({ seq, text: line });
    this.bytes += byteLength(line);
    let dropped = 0;
    while (this.entries.length > 1 && (this.entries.length > this.maxLines || this.bytes > this.maxBytes)) {
      const evicted = this.entries.shift();
      if (evicted === undefined) {
        break;
      }
      this.bytes -= byteLength(evicted.text);
      dropped += 1;
      this.droppedCount += 1;
    }
    return { seq, dropped };
  }

  // 读取 seq > since 的行（至多 maxLines）。dropped = 「调用方尚未见过但已被淘汰」的
  // 行数（since 早于缓冲最旧时的缺口，诚实报告 §3.2）。oldest/newest 为当前缓冲边界
  // （空缓冲时 oldest = 下一 seq、newest = 已分配的最大 seq）。
  readSince(since: number, maxLines: number): {
    lines: BufferLine[];
    dropped: number;
    oldest: number;
    newest: number;
  } {
    const matching = this.entries.filter(entry => entry.seq > since);
    const first = this.entries[0];
    return {
      lines: matching.slice(0, maxLines),
      dropped: Math.max(0, this.oldest() - 1 - since),
      oldest: first !== undefined ? first.seq : this.nextSeq,
      newest: this.newest(),
    };
  }

  oldest(): number {
    const first = this.entries[0];
    return first !== undefined ? first.seq : this.nextSeq;
  }

  newest(): number {
    return this.nextSeq - 1;
  }

  droppedTotal(): number {
    return this.droppedCount;
  }
}

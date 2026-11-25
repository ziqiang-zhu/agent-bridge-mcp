// 字节环 + 字节偏移游标（doc/设计.md §3.6）：纯逻辑、零依赖、零 I/O，stream 模式用。
// - 原样入环：上游 chunk 的 Buffer 原样存储，不经 TextDecoder、不切行——二进制保真；
// - 游标 = 字节偏移：自连接累计的单调偏移（跨上游重连连续），读取返回 [since, next)；
// - 上限淘汰：超 max-bytes 从最旧**整 chunk** 淘汰（不切 chunk，偏移始终连续），
//   淘汰字节数累计为 dropped_bytes；至少保留最新一个 chunk（单 chunk 超上限时不自我清空）；
// - 缺口诚实：since 早于缓冲最旧偏移时，从最旧开始返回并报告缺口字节数。

export interface ByteReadResult {
  data: Buffer;
  nextCursor: number;
  droppedBytes: number;
  oldest: number;
  newest: number;
}

interface StoredChunk {
  offset: number;
  data: Buffer;
}

export class ByteRing {
  private readonly chunks: StoredChunk[] = [];
  private bytes = 0;
  // 下一个字节的偏移（= 已接收字节总数，即 newborn 高水位）。
  private nextOffset = 0;
  private droppedBytesTotal = 0;
  private readonly maxBytes: number;

  constructor(options: { maxBytes: number }) {
    this.maxBytes = options.maxBytes;
  }

  /** 原始 chunk 入环；空 chunk 跳过（无内容不产生偏移推进）。 */
  push(chunk: Buffer): void {
    if (chunk.length === 0) {
      return;
    }
    this.chunks.push({ offset: this.nextOffset, data: chunk });
    this.nextOffset += chunk.length;
    this.bytes += chunk.length;
    while (this.chunks.length > 1 && this.bytes > this.maxBytes) {
      const evicted = this.chunks.shift();
      if (evicted === undefined) {
        break;
      }
      this.bytes -= evicted.data.length;
      this.droppedBytesTotal += evicted.data.length;
    }
  }

  /**
   * 读取 [since, next) 区间至多 maxBytes 字节。since 早于缓冲最旧偏移时从最旧开始，
   * droppedBytes 报告调用方错过的字节数（诚实缺口）；空结果时 nextCursor 不倒退
   * （since 超前于高水位时保持 since）。
   */
  readSince(since: number, maxBytes: number): ByteReadResult {
    const oldest = this.oldest();
    const newest = this.newest();
    const effective = Math.max(since, oldest);
    const droppedBytes = Math.max(0, oldest - since);
    const parts: Buffer[] = [];
    let taken = 0;
    if (maxBytes > 0) {
      for (const chunk of this.chunks) {
        const chunkEnd = chunk.offset + chunk.data.length;
        if (chunkEnd <= effective) {
          continue;
        }
        const from = Math.max(0, effective - chunk.offset);
        const available = chunk.data.length - from;
        const needed = maxBytes - taken;
        const slice = available <= needed ? chunk.data.subarray(from) : chunk.data.subarray(from, from + needed);
        parts.push(slice);
        taken += slice.length;
        if (taken >= maxBytes) {
          break;
        }
      }
    }
    const data = Buffer.concat(parts, taken);
    const nextCursor = data.length > 0 ? effective + data.length : Math.max(effective, newest);
    return { data, nextCursor, droppedBytes, oldest, newest };
  }

  /** 缓冲最旧字节的偏移（空缓冲时等于高水位）。 */
  oldest(): number {
    const first = this.chunks[0];
    return first !== undefined ? first.offset : this.nextOffset;
  }

  /** 已接收字节总数（下一字节的偏移）。 */
  newest(): number {
    return this.nextOffset;
  }

  droppedTotal(): number {
    return this.droppedBytesTotal;
  }
}

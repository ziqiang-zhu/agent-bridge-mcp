import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ByteRing } from '../../src/byteBuffer';

// 字节环契约（doc/设计.md §3.6 / §8.2 #22–#24）：原样入环（不经 TextDecoder、不切行，
// 二进制保真）、字节偏移游标 [since, next)、超限整 chunk 淘汰并诚实报告缺口、
// 空 chunk 不推进偏移、至少保留最新一个 chunk。纯逻辑零依赖。

describe('ByteRing（stream 模式字节环）', () => {
  it('#22 appends chunks and advances the byte-offset cursor', () => {
    const ring = new ByteRing({ maxBytes: 1000 });
    ring.push(Buffer.from('abc'));
    ring.push(Buffer.from('de'));
    assert.equal(ring.oldest(), 0);
    assert.equal(ring.newest(), 5);
    // 分页：max_bytes 截断，next_cursor 推进，剩余留待下次
    const first = ring.readSince(0, 2);
    assert.equal(first.data.toString(), 'ab');
    assert.equal(first.nextCursor, 2);
    assert.equal(first.droppedBytes, 0);
    const second = ring.readSince(first.nextCursor, 100);
    assert.equal(second.data.toString(), 'cde');
    assert.equal(second.nextCursor, 5);
    // 到高水位后空读：next_cursor 停在 since（不倒退）
    const idle = ring.readSince(5, 100);
    assert.equal(idle.data.length, 0);
    assert.equal(idle.nextCursor, 5);
    // 未来游标：空结果且不回退
    const future = ring.readSince(50, 100);
    assert.equal(future.data.length, 0);
    assert.equal(future.nextCursor, 50);
    // 空 chunk 不推进偏移
    ring.push(Buffer.alloc(0));
    assert.equal(ring.newest(), 5);
  });

  it('#23 evicts whole oldest chunks and reports the gap honestly', () => {
    const ring = new ByteRing({ maxBytes: 10 });
    ring.push(Buffer.from('abcd'));
    ring.push(Buffer.from('efgh'));
    ring.push(Buffer.from('ijkl')); // 12 > 10 → 淘汰最旧整 chunk（abcd）
    assert.equal(ring.oldest(), 4);
    assert.equal(ring.newest(), 12);
    assert.equal(ring.droppedTotal(), 4);
    // since 早于最旧偏移：从最旧开始返回并报告缺口
    const gap = ring.readSince(0, 100);
    assert.equal(gap.data.toString(), 'efghijkl');
    assert.equal(gap.droppedBytes, 4);
    assert.equal(gap.nextCursor, 12);
    // 从最旧开始的缺省读：无个人缺口
    const clean = ring.readSince(4, 100);
    assert.equal(clean.droppedBytes, 0);
    // 单 chunk 超上限时至少保留它（不自我清空）
    const tight = new ByteRing({ maxBytes: 5 });
    tight.push(Buffer.from('0123456789'));
    assert.equal(tight.oldest(), 0);
    const kept = tight.readSince(0, 100);
    assert.equal(kept.data.toString(), '0123456789');
  });

  it('#24 keeps binary payloads byte-exact (no decode, no line splitting)', () => {
    const ring = new ByteRing({ maxBytes: 1000 });
    const frame = Buffer.from([0x55, 0x85, 0x11, 0x94, 0x0a, 0x00, 0xff, 0x0d, 0x80, 0xaa]);
    ring.push(frame);
    const result = ring.readSince(0, 100);
    assert.equal(result.data.length, frame.length);
    assert.deepEqual([...result.data], [...frame]);
    // 含 0x0A / 0x0D 的帧未被切分（读取按偏移整体返回）
    assert.equal(result.nextCursor, frame.length);
  });
});

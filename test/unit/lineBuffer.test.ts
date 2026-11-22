import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LineAssembler, RingBuffer } from '../../src/lineBuffer';

// 行组装 + 环形缓冲契约（doc/设计.md §3 / §8.1 #1–#7）：半行跨 chunk 续接、断线
// flush 半行为独立行且重连不拼接、seq 跨组装器实例单调连续、双上限淘汰（行数 /
// utf8 字节）诚实统计、游标三边界（早于 oldest → 缺口 dropped、=newest → 空、
// >newest → 空）。纯逻辑零桩。

describe('LineAssembler（行组装）', () => {
  it('#1 splits complete lines and strips one trailing CR', () => {
    const assembler = new LineAssembler();
    assert.deepEqual(assembler.push('a\r\nb\n'), ['a', 'b']);
    assert.deepEqual(assembler.push('c\n'), ['c']);
  });

  it('#2 joins half-lines across chunks', () => {
    const assembler = new LineAssembler();
    assert.deepEqual(assembler.push('hel'), []);
    assert.deepEqual(assembler.push('lo\nwor'), ['hello']);
    assert.deepEqual(assembler.push('ld\n'), ['world']);
  });

  it('#3 flushes the residual half-line as a standalone line', () => {
    const assembler = new LineAssembler();
    assert.deepEqual(assembler.push('tail-without'), []);
    assert.equal(assembler.flush(), 'tail-without');
    assert.equal(assembler.flush(), undefined);
    // CRLF 半行同样剥尾 \r
    const assembler2 = new LineAssembler();
    assembler2.push('abc\r');
    assert.equal(assembler2.flush(), 'abc');
  });
});

describe('RingBuffer（环形缓冲与游标）', () => {
  it('#4 keeps seq monotonically increasing across assembler instances', () => {
    const ring = new RingBuffer({ maxBytes: 1_000_000 });
    const first = new LineAssembler();
    for (const line of first.push('a\n')) {
      ring.push(line);
    }
    // 模拟上游重连：组装器从零开始（不拼接断线前内容），ring 的 seq 连续递增
    const second = new LineAssembler();
    for (const line of second.push('b\n')) {
      ring.push(line);
    }
    const result = ring.readSince(0, 100);
    assert.deepEqual(
      result.lines.map(line => line.seq),
      [1, 2]
    );
    assert.equal(result.newest, 2);
  });

  it('#5 evicts from the oldest beyond the byte limit', () => {
    const ring = new RingBuffer({ maxBytes: 12 });
    for (const text of ['l1', 'l2', 'l3', 'l4', 'l5']) {
      ring.push(text); // 2B × 5 = 10B ≤ 12B：未淘汰
    }
    ring.push('l6x'); // 3B → 13 > 12 → 淘汰 seq1 → 11B
    assert.equal(ring.droppedTotal(), 1);
    const result = ring.readSince(0, 100);
    assert.deepEqual(
      result.lines.map(line => line.text),
      ['l2', 'l3', 'l4', 'l5', 'l6x']
    );
    // since=0 早于 oldest=2：缺口 = seq 1 → dropped 1
    assert.equal(result.dropped, 1);
    assert.equal(result.oldest, 2);
  });

  it('#6 evicts beyond the byte limit with utf8 accounting', () => {
    const ring = new RingBuffer({ maxBytes: 12 });
    ring.push('aaaaaa'); // 6B → 6
    ring.push('bbbbbb'); // 6B → 12
    ring.push('中'); // 3B → 15 > 12 → 淘汰 seq1（6B）→ 9
    assert.equal(ring.droppedTotal(), 1);
    const result = ring.readSince(0, 100);
    assert.deepEqual(
      result.lines.map(line => line.text),
      ['bbbbbb', '中']
    );
  });

  it('#7 reports cursor boundary gaps honestly', () => {
    const ring = new RingBuffer({ maxBytes: 6 }); // 2B × 3 = 6B：推 5 行淘汰前 2 行
    for (const text of ['l1', 'l2', 'l3', 'l4', 'l5']) {
      ring.push(text);
    }
    // since 早于 oldest：从最旧起 + 缺口 dropped
    const early = ring.readSince(1, 100);
    assert.equal(early.lines[0]?.seq, 3);
    assert.equal(early.dropped, 1);
    // since = newest：空
    const current = ring.readSince(5, 100);
    assert.deepEqual(current.lines, []);
    assert.equal(current.newest, 5);
    // since > newest（未来游标）：空、不回退
    const future = ring.readSince(9, 100);
    assert.deepEqual(future.lines, []);
    // 空缓冲：oldest = 下一 seq、newest = 已分配最大 seq
    const empty = new RingBuffer({ maxBytes: 1_000_000 });
    const none = empty.readSince(0, 100);
    assert.deepEqual(none.lines, []);
    assert.equal(none.oldest, 1);
    assert.equal(none.newest, 0);
  });
});

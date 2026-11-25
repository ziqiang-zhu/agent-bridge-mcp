import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { VERSION, isUpdatePending, readDiskVersion } from '../../src/version';

// 版本与更新感知契约（doc/设计.md §4）：readDiskVersion 读随包 package.json（不可读时
// undefined，不误报）；isUpdatePending 仅在磁盘版本严格高于运行版本时为 true（三段式
// 数值比较，不是字典序）；status.version 供 Agent 对比 GitHub 最新 tag（联网检查由宿主
// 指令规则完成，本服务器不做网络请求）。

function withManifest(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abmcp-version-'));
  fs.writeFileSync(path.join(dir, 'package.json'), content, 'utf8');
  return dir;
}

describe('version（运行版本与磁盘版本）', () => {
  it('#30 reads the packaged manifest version and tolerates unreadable input', () => {
    const ok = withManifest(JSON.stringify({ name: 'x', version: '9.9.9' }));
    try {
      assert.equal(readDiskVersion(ok), '9.9.9');
    } finally {
      fs.rmSync(ok, { recursive: true, force: true });
    }
    const broken = withManifest('{ not json');
    try {
      assert.equal(readDiskVersion(broken), undefined);
    } finally {
      fs.rmSync(broken, { recursive: true, force: true });
    }
    const missing = fs.mkdtempSync(path.join(os.tmpdir(), 'abmcp-empty-'));
    try {
      assert.equal(readDiskVersion(missing), undefined);
    } finally {
      fs.rmSync(missing, { recursive: true, force: true });
    }
  });

  it('#30 flags update_pending only for a strictly newer disk version', () => {
    assert.equal(isUpdatePending('0.2.1', '0.2.2'), true);
    assert.equal(isUpdatePending('0.2.1', '0.10.0'), true, 'numeric compare, not lexicographic');
    assert.equal(isUpdatePending('0.2.1', '0.2.1'), false);
    assert.equal(isUpdatePending('0.2.1', '0.2.0'), false);
    assert.equal(isUpdatePending('0.2.1', undefined), false);
    assert.equal(typeof VERSION, 'string');
    assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  });
});

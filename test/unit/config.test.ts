import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveConfig } from '../../src/config';

// 配置解析契约（doc/设计.md §5 / §8.2 #27）：--mode terminal|stream（缺省 terminal）、
// AGENT_BRIDGE_MODE 环境变量、CLI 优先、非法值 fail-loud（与工具层宽容输入相反）。

const env = (values: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...values });

describe('resolveConfig（--mode 解析）', () => {
  it('#27 defaults to terminal mode and accepts --mode stream', () => {
    assert.equal(resolveConfig(['--name', 'dev'], env()).mode, 'terminal');
    assert.equal(resolveConfig(['--name', 'dev', '--mode', 'stream'], env()).mode, 'stream');
    assert.equal(resolveConfig(['--name', 'dev', '--mode', 'terminal'], env()).mode, 'terminal');
  });

  it('#27 reads the environment variable and lets CLI win', () => {
    assert.equal(resolveConfig(['--name', 'dev'], env({ AGENT_BRIDGE_MODE: 'stream' })).mode, 'stream');
    assert.equal(
      resolveConfig(['--name', 'dev', '--mode', 'terminal'], env({ AGENT_BRIDGE_MODE: 'stream' })).mode,
      'terminal'
    );
  });

  it('#27 rejects unknown modes at startup', () => {
    assert.throws(() => resolveConfig(['--name', 'dev', '--mode', 'raw'], env()), /--mode/);
    assert.throws(() => resolveConfig(['--name', 'dev'], env({ AGENT_BRIDGE_MODE: 'bytes' })), /--mode/);
  });
});

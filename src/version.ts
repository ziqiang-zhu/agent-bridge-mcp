// 版本与更新感知（doc/设计.md §4）：运行版本常量 + 磁盘版本读取。
// - status.version = 本进程加载的代码版本——Agent 用它对比 GitHub 最新 tag（新版检查
//   由宿主指令规则联网完成，本服务器不做网络请求，见 README「保持更新」）；
// - status.update_pending = 磁盘 package.json 版本高于运行版本 = 「已更新未重载」，
//   重载宿主即生效——它不是「上游有新版本可装」的信号（那需要联网，分工在 Agent 侧）。
import * as fs from 'node:fs';
import * as path from 'node:path';

export const VERSION = '0.2.1';

/** 读取磁盘上随包 package.json 的版本；不可读或格式异常时返回 undefined（不误报）。 */
export function readDiskVersion(baseDir: string = path.join(__dirname, '..')): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(baseDir, 'package.json'), 'utf8');
    const manifest = JSON.parse(raw) as { version?: unknown };
    return typeof manifest.version === 'string' && manifest.version.trim() !== '' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/** 磁盘版本是否高于运行版本（= 已更新未重载）。不可判定时一律 false。 */
export function isUpdatePending(loaded: string = VERSION, disk: string | undefined = readDiskVersion()): boolean {
  if (disk === undefined || disk.trim() === '' || disk === loaded) {
    return false;
  }
  return compareSemver(disk, loaded) > 0;
}

/** 三段式比较；非数字段按 0 处理（本仓版本恒为 x.y.z）。 */
function compareSemver(left: string, right: string): number {
  const parse = (value: string): number[] => {
    const parts = value.split('.').slice(0, 3).map(part => {
      const parsed = Number.parseInt(part, 10);
      return Number.isNaN(parsed) ? 0 : parsed;
    });
    while (parts.length < 3) {
      parts.push(0);
    }
    return parts;
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

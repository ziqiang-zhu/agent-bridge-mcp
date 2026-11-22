// 配置解析（doc/设计.md §5）：CLI 参数与环境变量双通道，参数优先。
// CLI 非法值 fail-loud（与工具层宽容输入相反——用户直接给错参数应当场报错退出，
// 而不是静默纠正后以错误配置运行）。
export interface Config {
  host: string;
  port: number;
  readonly: boolean;
  maxLines: number;
  maxBytes: number;
}

export const CONFIG_DEFAULTS: Config = {
  host: '127.0.0.1',
  port: 2000,
  readonly: false,
  maxLines: 5000,
  maxBytes: 1_048_576,
};

// --help：main 捕获后输出 usage 并以 0 退出（与参数错误 exit 1 区分）。
export class UsageError extends Error {}

const USAGE = `usage: agent-bridge-mcp [--host <host>] [--port <port>] [--readonly]
                        [--max-lines <n>] [--max-bytes <bytes>]

env: AGENT_BRIDGE_HOST / AGENT_BRIDGE_PORT / AGENT_BRIDGE_READONLY`;

function parseIntValue(name: string, raw: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}], got ${raw}`);
  }
  return value;
}

function parseReadonlyEnv(raw: string | undefined): boolean {
  if (raw === undefined || raw === '') {
    return false;
  }
  const normalized = raw.toLowerCase();
  return normalized !== '0' && normalized !== 'false';
}

export function resolveConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): Config {
  const args = new Map<string, string>();
  let readonlyFlag = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === '--readonly') {
      readonlyFlag = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new UsageError(USAGE);
    }
    if (arg === '--host' || arg === '--port' || arg === '--max-lines' || arg === '--max-bytes') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`missing value for ${arg}`);
      }
      args.set(arg, value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  const hostRaw = args.get('--host') ?? env.AGENT_BRIDGE_HOST;
  const host = hostRaw !== undefined && hostRaw.trim() !== '' ? hostRaw.trim() : CONFIG_DEFAULTS.host;
  const port = parseIntValue('--port', args.get('--port') ?? env.AGENT_BRIDGE_PORT ?? String(CONFIG_DEFAULTS.port), 1, 65535);
  const maxLines = parseIntValue('--max-lines', args.get('--max-lines') ?? String(CONFIG_DEFAULTS.maxLines), 1, 10_000_000);
  const maxBytes = parseIntValue('--max-bytes', args.get('--max-bytes') ?? String(CONFIG_DEFAULTS.maxBytes), 1024, 1_073_741_824);

  return {
    host,
    port,
    readonly: readonlyFlag || parseReadonlyEnv(env.AGENT_BRIDGE_READONLY),
    maxLines,
    maxBytes,
  };
}

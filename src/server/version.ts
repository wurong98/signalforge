import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BuildInfo } from '../shared/build.ts';

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * 读取当前代码的版本：服务启动时、vite 构建时各调用一次。
 * 不是 git 目录（如打包部署）时用 APP_COMMIT 兜底。
 */
export function readBuildInfo(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): BuildInfo {
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { version: string };
  const commit = git(cwd, ['rev-parse', '--short', 'HEAD']);
  if (!commit) return { version: pkg.version, commit: env.APP_COMMIT || null, dirty: false };
  // 只看已跟踪文件：data/、.env、dist/ 都在 .gitignore 里，不算改动
  const status = git(cwd, ['status', '--porcelain', '--untracked-files=no']);
  return { version: pkg.version, commit, dirty: !!status };
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkBuilds, formatBuild } from '../src/shared/build.ts';
import { readBuildInfo } from '../src/server/version.ts';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'sf-ver-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim();

test('version: 读取 git 短 hash，已跟踪文件改动才算 dirty', () => {
  const { dir, cleanup } = repo();
  try {
    git(dir, 'init', '-q');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    const head = git(dir, 'rev-parse', '--short', 'HEAD');
    assert.deepEqual(readBuildInfo(dir, {}), { version: '1.2.3', commit: head, dirty: false });
    // 未跟踪文件（data/、.env 之类）不算
    writeFileSync(join(dir, 'new.txt'), 'x');
    assert.equal(readBuildInfo(dir, {}).dirty, false);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.2.4' }));
    assert.deepEqual(readBuildInfo(dir, {}), { version: '1.2.4', commit: head, dirty: true });
  } finally {
    cleanup();
  }
});

test('version: 不是 git 目录时用 APP_COMMIT 兜底', () => {
  const { dir, cleanup } = repo();
  try {
    assert.deepEqual(readBuildInfo(dir, { APP_COMMIT: 'abc1234' }), { version: '1.2.3', commit: 'abc1234', dirty: false });
    assert.equal(readBuildInfo(dir, {}).commit, null);
  } finally {
    cleanup();
  }
});

test('version: 前端构建与服务进程对比', () => {
  const web = { version: '1.0.0', commit: 'aaa', dirty: false, built_at: 2_000 };
  const server = { version: '1.0.0', commit: 'aaa', dirty: false, started_at: 1_000 };
  assert.deepEqual(checkBuilds(web, server), { level: 'ok' });
  // 构建晚于启动：build 了新代码但没重启
  const notRestarted = checkBuilds({ ...web, commit: 'bbb' }, server);
  assert.equal(notRestarted.level, 'bad');
  assert.match((notRestarted as { message: string }).message, /服务未重启/);
  // 启动晚于构建：重启了但没重新 build
  const notBuilt = checkBuilds(web, { ...server, commit: 'bbb', started_at: 3_000 });
  assert.match((notBuilt as { message: string }).message, /前端未重新构建/);
  assert.equal(checkBuilds(web, { ...server, dirty: true }).level, 'warn');
  // 拿不到 commit 时无从比较，不误报
  assert.deepEqual(checkBuilds({ ...web, commit: null }, { ...server, commit: 'bbb' }), { level: 'ok' });
  assert.equal(formatBuild({ ...server, dirty: true }), 'v1.0.0 · aaa-dirty');
  assert.equal(formatBuild({ ...server, commit: null }), 'v1.0.0');
});

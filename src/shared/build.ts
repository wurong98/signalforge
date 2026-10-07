/**
 * 部署版本信息：前端构建产物与后端进程各自携带一份，页面底部对比。
 *
 * 后端是 tsx 直接跑源码、前端是 vite 打包的 dist/，两者可能不同步：
 * git pull 后只重启没 build → 页面还是旧的；只 build 没重启 → 服务还是旧的（安全修复多在后端）。
 */
export interface BuildInfo {
  version: string;
  /** git 短 hash；拿不到时为 null */
  commit: string | null;
  /** 工作区有未提交改动（正式部署不应出现） */
  dirty: boolean;
}

export interface WebBuild extends BuildInfo {
  built_at: number;
}

export interface ServerBuild extends BuildInfo {
  started_at: number;
}

export type BuildCheck =
  | { level: 'ok' }
  | { level: 'warn' | 'bad'; message: string };

export function formatBuild(b: BuildInfo): string {
  return `v${b.version}${b.commit ? ` · ${b.commit}${b.dirty ? '-dirty' : ''}` : ''}`;
}

export function checkBuilds(web: WebBuild, server: ServerBuild): BuildCheck {
  if (web.commit && server.commit && web.commit !== server.commit) {
    // 构建晚于进程启动 → 新代码已 build 但服务没重启；反之是重启了但没重新 build
    const message =
      web.built_at > server.started_at
        ? `服务未重启：页面是 ${web.commit}，服务仍在跑 ${server.commit}`
        : `前端未重新构建：服务是 ${server.commit}，页面仍是 ${web.commit}，请 npm run build`;
    return { level: 'bad', message };
  }
  if (web.dirty || server.dirty) return { level: 'warn', message: '部署目录有未提交的改动' };
  return { level: 'ok' };
}

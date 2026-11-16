import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Edge、Chrome 通常不在 PATH 里，按安装位置找；找不到就交给系统默认浏览器。
export function findAppBrowser(env = process.env) {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
  const apps = [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Google', 'Chrome', 'Application', 'chrome.exe']];
  for (const app of apps) {
    for (const root of roots) {
      const file = path.join(root, ...app);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

export function openBrowser(url) {
  const launch = (command, args, onFail) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', onFail);
    child.unref();
  };
  const systemDefault = () => launch('cmd', ['/c', 'start', '', url], () => {});
  const app = findAppBrowser();
  if (app) {
    launch(app, ['--app=' + url], systemDefault);
    return path.basename(app, '.exe');
  }
  systemDefault();
  return 'cmd';
}

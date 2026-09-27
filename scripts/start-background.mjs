import { spawn } from 'node:child_process';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT 应为有效端口。');
const localHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '[::1]' : host;
const url = `http://${localHost}:${port}`;

async function healthy() {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(700) });
    const body = await response.json();
    if (!response.ok || body.data?.status !== 'ok' || !body.requestId) return false;
    const page = await fetch(url, { signal: AbortSignal.timeout(700) });
    return page.ok && (await page.text()).includes('一起走 · CityWalk');
  } catch { return false; }
}

if (await healthy()) {
  console.log(`CityWalk 服务已在运行：${url}`);
} else {
  const directory = path.join(root, '.data');
  await mkdir(directory, { recursive: true });
  const logPath = path.join(directory, 'demo-server.log');
  const log = await open(logPath, 'a', 0o600);
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.mjs'], {
    cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd],
  });
  let launchError;
  child.on('error', error => { launchError = error; });
  child.unref();
  await log.close();
  if (child.pid) await writeFile(path.join(directory, 'demo-server.pid'), `${child.pid}\n`, { mode: 0o600 });
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    if (launchError) break;
    if (await healthy()) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) {
    console.error(`服务未启动成功，请检查本地日志：${logPath}`);
    process.exitCode = 1;
  } else {
    console.log(`CityWalk 后台服务已启动：${url}`);
    console.log(`本地日志：${logPath}`);
  }
}

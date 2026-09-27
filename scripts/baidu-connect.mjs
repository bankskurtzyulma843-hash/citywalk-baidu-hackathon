import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// CLI credentials remain in memory and .env; never print raw CLI account output.
const run = promisify(execFile);
const cli = fileURLToPath(new URL('../.tools/bmap-cli-darwin-arm64', import.meta.url));
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
const args = process.argv.slice(2);
const selectedId = args.find(a => a.startsWith('--browser-app-id='))?.split('=').slice(1).join('=');
if (args.some(a => !a.startsWith('--browser-app-id=') && a !== '--inspect')) {
  console.error('仅支持 --inspect 或 --browser-app-id=<当前查询到的应用ID>。');
  process.exit(1);
}

async function query(command) {
  let output;
  try { output = await run(cli, command, { shell: false, timeout: 20000, maxBuffer: 1024 * 1024 }); }
  catch (error) {
    const text = String(error.stdout || '') + String(error.stderr || '');
    if (/未登录|登录态.*失效/.test(text)) throw Error('请先通过百度 CLI 完成账号授权。');
    throw Error('百度 CLI 查询失败，请检查网络或账号授权。');
  }
  if ((output.stdout + output.stderr).includes('发现新版本')) throw Error('CLI 提示有更新，请先审阅官方更新信息。');
  let json;
  try { json = JSON.parse(output.stdout); } catch { throw Error('百度 CLI 未返回可识别的数据。'); }
  if (Number(json.status) !== 0) {
    if (/账户未注册/.test(String(json.message))) throw Error('百度返回账户未注册，请先完成 https://lbs.baidu.com/apiconsole/becomedev/selection 的开放平台注册。');
    if (/未登录|登录态.*失效/.test(String(json.message))) throw Error('请先通过百度 CLI 完成账号授权。');
    throw Error('百度未允许读取当前账号的凭据，请检查账号权限。');
  }
  return json.data;
}

function browserApps(value, found = []) {
  if (Array.isArray(value)) for (const item of value) browserApps(item, found);
  else if (value && typeof value === 'object') {
    if (String(value.app_type) === '3' && typeof value.ak === 'string' && value.ak) found.push(value);
    else for (const child of Object.values(value)) if (child && typeof child === 'object') browserApps(child, found);
  }
  return found;
}
function setEnv(source, key, value) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) throw Error('平台凭据格式无效。');
  const line = `${key}=${JSON.stringify(value)}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  return pattern.test(source) ? source.replace(pattern, () => line) : `${source.trimEnd()}\n${line}\n`;
}

try {
  const plan = await query(['ap', 'list']);
  const token = typeof plan?.api_key === 'string' ? plan.api_key : '';
  if (!token) throw Error('当前账号没有可复用的 Agent Plan SK。请先确认创建方案；本脚本不会重置或创建 SK。');
  const apps = browserApps(await query(['ak', 'list']));
  const selected = selectedId ? apps.find(app => String(app.id ?? app.app_id) === selectedId) : apps.length === 1 ? apps[0] : null;
  if (selectedId && !selected) throw Error('指定应用不在当前账号查询结果中的浏览器端 AK 列表。');
  if (args.includes('--inspect')) {
    console.log(JSON.stringify({ agentPlanKeyAvailable: true, browserApps: apps.map(app => ({ id: app.id ?? app.app_id ?? null, name: app.app_name || '', type: app.app_type })) }));
  } else {
    let env;
    try { env = await readFile(envPath, 'utf8'); } catch { env = await readFile(new URL('../.env.example', import.meta.url), 'utf8'); }
    env = setEnv(env, 'BAIDU_MAP_AUTH_TOKEN', token);
    env = setEnv(env, 'CITYWALK_MODE', 'agentplan');
    if (selected) env = setEnv(env, 'BAIDU_BROWSER_AK', selected.ak);
    await writeFile(envPath, env, { mode: 0o600 });
    await chmod(envPath, 0o600);
    console.log(JSON.stringify({ status: 'saved_locally', agentPlanKeyAvailable: true, browserKeySynced: Boolean(selected), browserCandidates: apps.length, note: '凭据已写入本地配置；尚需真实API与地图联调，未回显密钥。' }));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

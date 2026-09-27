import { writeFile, mkdir } from 'node:fs/promises';
import { setDefaultResultOrder } from 'node:dns';
setDefaultResultOrder('ipv4first');
const token = process.env.BAIDU_MAP_AUTH_TOKEN;
if (!token) throw Error('本地 Token 尚未配置');
const kind = process.argv[2] || 'place';
const input = process.argv[3] ? JSON.parse(process.argv[3]) : { user_raw_request: '请查找北京雍和宫和国子监，供步行游览选择具体地点', region: '北京市' };
const url = new URL(`/agent_plan/v1/${kind}`, 'https://api.map.baidu.com');
for (const [key, value] of Object.entries(input)) url.searchParams.set(key, value);
const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(45000) });
const raw = (await response.text()).split(token).join('[redacted]');
await mkdir('.data', { recursive: true });
const path = `.data/agentplan-${kind}-${process.argv[4] || 'live'}.json`;
await writeFile(path, raw, { mode: 0o600 });
let payload;
try { payload = JSON.parse(raw); } catch { payload = {}; }
console.log(JSON.stringify({ httpStatus: response.status, path, bytes: Buffer.byteLength(raw), keys: Object.keys(payload), status: payload.status, message: payload.message }));

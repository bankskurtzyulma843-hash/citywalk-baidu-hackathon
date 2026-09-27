import { getCliStatus } from '../server/baidu-cli.mjs';
const status = await getCliStatus();
console.log(JSON.stringify(status, null, 2));
if (!status.installed) process.exitCode = 1;

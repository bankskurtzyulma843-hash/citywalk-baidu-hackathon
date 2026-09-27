import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Only the binary downloaded into this project is used. Never resolve a CLI
// from PATH or accept an executable/command from an HTTP request.
const CLI_PATH = fileURLToPath(new URL('../.tools/bmap-cli-darwin-arm64', import.meta.url));
const ALLOWED_COMMANDS = new Set(['version', '--help']);
const CLI_TIMEOUT_MS = 5_000;

function cliError(code, message) {
  return Object.assign(new Error(message), { code });
}

function runReadOnlyCli(command) {
  if (!ALLOWED_COMMANDS.has(command)) {
    return Promise.reject(cliError('CLI_COMMAND_NOT_ALLOWED', '该 CLI 命令未获允许。'));
  }
  return new Promise((resolve, reject) => {
    execFile(CLI_PATH, [command], {
      shell: false,
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      // Do not forward API keys or other application secrets to the CLI.
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(cliError(error.killed ? 'CLI_TIMEOUT' : 'CLI_EXECUTION_FAILED',
          error.killed ? '百度地图 CLI 检测超时。' : '百度地图 CLI 无法运行。'));
        return;
      }
      resolve(`${stdout}\n${stderr}`);
    });
  });
}

/** available describes whether the binary runs, not geographic capabilities. */
export async function getCliStatus() {
  try {
    await access(CLI_PATH, constants.X_OK);
  } catch {
    return {
      installed: false,
      version: null,
      available: false,
      reason: '项目内未安装可执行的百度地图 CLI。',
    };
  }

  try {
    const output = await runReadOnlyCli('version');
    if (output.includes('发现新版本')) {
      // Do not apply updates or expose raw output containing possible secrets.
      return {
        installed: true,
        version: null,
        available: false,
        reason: 'CLI 提示发现新版本，需人工审阅官方更新命令；本项目不会自动更新。',
      };
    }
    const version = output.match(/(?:^|\s)(v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?=\s|$)/)?.[1];
    if (!version) throw cliError('CLI_INVALID_RESPONSE', '无法识别百度地图 CLI 版本。');
    return {
      installed: true,
      version,
      available: true,
      reason: 'CLI 可运行，用于账号授权和凭据管理；地点与路线由百度地图 API 提供。',
    };
  } catch (error) {
    return {
      installed: true,
      version: null,
      available: false,
      reason: error.message,
    };
  }
}

function unavailable(capability) {
  return Object.assign(cliError('CAPABILITY_UNAVAILABLE',
    `当前百度地图 CLI 不提供直接${capability === 'search' ? '地点搜索' : '步行算路'}命令。请使用百度地图 Web API 适配器。`),
  { provider: 'baidu-cli', capability });
}

/** Reserved interface. Never returns fixtures as though the CLI supplied them. */
export async function searchWithCli({ keyword, city } = {}) {
  void keyword;
  void city;
  throw unavailable('search');
}

/** Reserved interface. Agent Plan/Skills would be a separate future provider. */
export async function routeWithCli({ orderedStops } = {}) {
  void orderedStops;
  throw unavailable('walking-route');
}

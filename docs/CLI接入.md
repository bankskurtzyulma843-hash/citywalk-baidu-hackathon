# 百度地图 CLI 接入记录

核验日期：2026-09-26。运行平台：macOS arm64。

## 本次已完成

官方二进制已下载到 `.tools/bmap-cli-darwin-arm64`，仅在当前项目内运行。实际执行 `--help`、`version`、`ap --help`、`skills --help`，版本返回 `v1.0.1`，没有更新提示。

CLI 支持账户、AK、样式、消费/配额、Agent Plan、Skills 和 MCP 管理。当前帮助列出的命令没有直接的地点搜索或路线执行命令；Agent Plan 仅列出 `list`、`create`，Skills 仅列出 `install`。不能把这些管理命令当作地点检索或步行路线服务。

当前网页只公开开发工具检测；凭据管理由本地接入脚本处理。地图数据仍由 JSAPI/Web API 或 Agent Plan 提供，CLI 检测不能代替地理数据验收。

本轮按用户要求实际运行 `login`，百度账号授权成功，并在同一账号的 Agent Plan 网页完成 Token 领取。该入口没有要求填写传统开发者注册表；本轮没有注册传统开发者、创建 AK 或重置已有 Token。

领取后，CLI 只读检查返回 `agentPlanKeyAvailable: true`、`browserApps: []`。`npm run baidu:connect` 已读取现有 SK，写入本地私有 `.env`，模式为 `agentplan`，未回显密钥。当前没有浏览器 AK，真实地图展示使用上游返回的官方托管地图资源；SK 不能替代自有网页 JSAPI 的浏览器 AK。

真实上游调用已完成：地点检索返回 `status=0`、10 个 POI 和 `resource_key`；明确两个地点的步行请求返回 `status=0`、`result.answer_type=gptmodel_navigate`、`result.navigation_data.walk_routes`、道路 `steps.path` 和 `resource_key`，该次距离为 654 米、耗时 727 秒。证据位于 `.data/agentplan-place-live.json` 和 `.data/agentplan-direction-no-location.json`。真实浏览器的三站交互、官方道路地图及固定分享已验收，详见 Demo 运行方案。

## 服务端模块

`server/baidu-cli.mjs` 暴露以下接口：

| 接口 | 当前行为 |
| --- | --- |
| `getCliStatus()` | 检查项目内二进制是否可执行，读取版本，返回 `{ installed, version, available, reason }` |
| `searchWithCli({ keyword, city })` | 明确抛出 `CAPABILITY_UNAVAILABLE` |
| `routeWithCli({ orderedStops })` | 明确抛出 `CAPABILITY_UNAVAILABLE` |

`available` 只代表二进制能运行，不能解释为可调用地点或路线能力。上层若提供数据源切换，应将 CLI 地理能力显示为“暂不支持”，并告知用户实际数据来源。

适配器不接收自定义二进制路径、任意命令或 shell 表达式。内部只允许 `version` 和 `--help`，使用 `execFile`、`shell: false`、5 秒超时和 64 KB 输出上限；不向子进程传递应用 API 密钥。检测输出仅提取版本，不返回原始账户信息。

本轮已执行登录、网页领取及只读 AK / Agent Plan 查询；未创建传统 AK、未重置已有 Agent Plan，未安装全局 Skills / MCP，未修改 PATH。CLI 自行管理正常登录状态。

`scripts/baidu-connect.mjs` 只查询并复用现有凭据，写入本地私有 `.env`；不回显完整密钥、不创建或重置资源。`server/agent-plan.mjs` 的响应适配按本轮真实返回结构推进，使用 Bearer GET 请求和 GCJ02 坐标；页面已成功解析、展示和分享真实三站结果。Mock 测试与真实上游证据分别记录。

公开 Skill 将 `direction.location` 定义为当前位置。本轮省略它、使用明确两站及 `refer_pois` 的真实请求成功，说明这次选定地点步行规划可以直接完成；不将首站伪装成设备当前位置，也不将单次实测扩大成所有请求可省略参数的官方保证。

## 后续接入边界

当前链路为百度账号授权 → 网页领取 Agent Plan → CLI 读取与保存现有 SK → 服务端真实地点/步行 API → 官方托管地图。地理结果来源应显示为 Agent Plan；CLI 地理预留接口仍没有直接执行能力，不能猜测 `search`、`route` 命令。

当前模块发现“发现新版本”提示时停止检测并返回需要人工审阅的状态，不会自动下载安装更新。升级必须先展示实际官方更新命令及其下载域名，得到确认后再执行。

## 官方资料与下载来源

- [官方 bmap-cli-skills 仓库](https://github.com/baidu-maps/bmap-cli-skills)
- [官方入口 SKILL.md](https://github.com/baidu-maps/bmap-cli-skills/blob/main/skills/bmap-cli/SKILL.md)
- [官方凭据管理流程](https://github.com/baidu-maps/bmap-agent-plugin/blob/main/baidu-map/skills/bmap-cli/SKILL.md)
- [Agent Plan 公开请求契约](https://github.com/baidu-maps/bmap-agent-plugin/blob/main/baidu-map/skills/baidu-ai-map/references/agent-plan-api.md)
- [官方发布 Skill 的地图展示资源说明](https://clawhub.ai/baidu-maps/skills/baidu-ai-map)
- [本次下载的 macOS arm64 二进制](https://open-agent-cli.bj.bcebos.com/cli/bmap-cli-darwin-arm64)

官方安装文档未提供内置签名或校验值。本次仅使用上述官方文档指定域名的下载地址；未声称完成独立供应链签名验证。

# 图片生成工作台

这是一个基于 Node.js 22、无第三方运行时依赖的图片生成工作台。服务端代理上游图片接口，并将用户、会话、消费记录和生成图片持久化到 `DATA_DIR`。

## 计费口径

- 新任务按模型选择计价策略：便宜渠道 `gpt-image-2` 的总系数为 **36**，官方渠道 `gpt-image-2-official` 的总系数为 **10.5**。供应商价格表和最终 `data.cost` 的单位均为美元 cost；总系数是业务计价参数，不代表或声明真实外汇汇率。
- 所有新任务每张图片最低收费 **¥0.30（300000 micros）**。预估时先计算 `round(供应商单张美元价 × 模型总系数 × 1000000)`，再与单张下限取较大值并乘以张数；最终结算时对供应商返回的整个任务 `data.cost` 乘以日志快照中的模型总系数，再与任务提交时固化的 `300000 × n` 取较大值。不能把任务总成本再除以张数，也不能只对多图任务应用一次 ¥0.30。
- 官方 `1:1 · 4K · high` 单张精确预估为 `5978280 micros`，4 张为 `23913120 micros`。页面金额低于 ¥1 时显示 3 位小数，达到 ¥1 时显示 2 位小数，例如 `¥0.300`、`¥0.306`、`¥5.98`；显示格式不改变 API、余额、预扣、日志或结算中的整数 micros。
- NAS legacy 旧口径总系数为 **50**。历史已结算记录保留原金额、不追溯改写；历史未结算任务有 `totalMultiplier` 快照时继续只按该快照线性结算，不追加新下限；没有倍率快照时继续按 legacy 50 结算。即使历史 official 快照是 36，也不能按当前 10.5 重算；缺少 `minimumChargeMicros` 时不能根据当前模型或张数反推下限。
- `PRICING_TOTAL_MULTIPLIER` 作为 cheap 策略的兼容 fallback 保留，必须与 `PRICING_CURRENCY_RATE × PRICING_MARKUP_MULTIPLIER` 一致。新代码按模型 profile 估价和结算，不能用顶层 cheap 系数为 official 定价；`PRICING_LEGACY_TOTAL_MULTIPLIER` 只用于没有倍率快照的旧未结算任务。
- 价格卡仅保留总价、价格详情、余额和警告，不再显示“单张价格 / 共几张 / 生成前预扣”三个冗余胶囊。缺少所选模型的公开 profile 时页面会提示配置异常并禁止生成，不会静默使用倍率 1。
- 部署前应在本地对典型模型、尺寸、质量、张数、预估、预扣、日志快照及最终结算逐项核对，不能只验证页面显示。
- API Market 当前文档明确说明：便宜渠道的规范模型名是 `gpt-image-2`，并兼容别名 `gpt-image-2-ext`，两者效果一致、可互换使用。2026-07-10 通过生产网络查询 `/v1/models` 时只列出了 `gpt-image-2` 和 `gpt-image-2-official`，因此本项目继续统一发送规范名 `gpt-image-2`，同时在服务端接受并规范化 `gpt-image-2-ext`；不能再把 `gpt-image-2-ext` 描述成“仅展示名称或不可请求”。
- 便宜渠道价格的代码单位是美元 cost，而不是页面 Credits：1K/2K/4K 分别为 `0.0085`、`0.014`、`0.021` 美元；按总系数 36 对应用户价格 `¥0.306`、`¥0.504`、`¥0.756`。`0.085 Credits` 对应的是 `$0.0085`，不能在代码里误写成 `0.085`。
- `gpt-image-2-official` 使用 45 个实际像素尺寸的 low/medium/high 精确价格表。合法页面组合必须有精确价格；供应商返回的实际 `data.cost` 仍是最终结算依据，`data.credits_cost` 仅作供应商 Credits 展示，不能代替美元 cost 参与本项目结算。
- `gpt-image-2` 与 `gpt-image-2-official` 的服务端参数校验均接受 `n=1~4`。官方模型仍按一个上游多图任务提交；便宜渠道仅在 `QUICK_BATCH_ENABLED=true` 时把 `n>1` 拆成多个并发单图任务，默认关闭。批次成员都是普通 `type:'generation'` 消费记录，通过 `batchId`、`batchIndex`、`batchSize` 关联；每个成员独立保留 `n=1` 计价快照和每张 300000 micros 下限，批次 DTO 只在提交、批次查询和用户历史接口中临时合成。官方渠道还支持 `mask_url` 局部重绘，但当前产品没有提供该功能，不能把“上游支持”误写成“本项目已支持”。

## 快速批量行为与接口

- `QUICK_BATCH_ENABLED=false`（默认）时，快速低价版的张数选择被锁定为 1；服务端也会拒绝 `gpt-image-2` 的 `n=2~4` 请求。官方 `gpt-image-2-official` 的 `n=1~4` 不受此开关影响，继续提交一个官方多图任务。
- `QUICK_BATCH_ENABLED=true` 时，快速低价版支持 `n=1~4`。其中 `n=1` 保持原单任务响应；`n=2~4` 会先在一次数据存储事务中按总预估金额原子预扣，再同时向上游提交 N 个完全相同、但 `n=1` 的请求。不会逐个子任务扣款，也不会因某个子任务较早返回而改变展示顺序。
- 批量提交必须携带稳定的 `Idempotency-Key`。相同账号、相同键和相同规范化参数会返回原批次，不会再次预扣或提交；相同键配不同参数返回 HTTP `409` 和 `idempotency_conflict`。浏览器会先保存账号隔离的恢复记录，再提交请求；刷新、超时或断网恢复均复用原键。
- 明确的非瞬态提交失败（例如 HTTP 400）只退还对应子任务的预扣。HTTP 408、429、5xx、网络中断，以及成功响应缺少 `task_id` 都属于提交结果未知：为避免供应商已经接单时重复生成或重复退款，系统不会自动重试、重新提交或退款，需要继续刷新或人工核对。
- `POST /api/api-market/v1/images/generations` 的批量响应包含 `kind=batch`、`batchId`/`batch_id`、`clientRequestId`/`client_request_id`、`requestedCount`、`counts`、按原索引排列的 `children`、`imageUrls`、`aggregateBilling` 和兼容字段 `billing`。每个 child 包含 `index`、`status`、`taskId`/`task_id`、图片、错误和独立 billing；批次 billing 由同一 `batchId` 下的普通 generation 日志临时聚合。
- `GET /api/api-market/v1/batches/:batchId` 会按 `batchIndex` 遍历同一批次的普通 generation 日志，按成员独立结算并应用每张最低收费。合成批次状态可能为 `submitting`、`processing`、`completed`、`partial_success`、`failed` 或 `attention_required`；成功图片始终按 child index 合并，失败或未知位置仍在结果区保留槽位。
- 合成批次只有在所有成员都结算后才算结清。明确失败且供应商未返回 cost 的成员会全额退款；失败但 cost 无效、完成但 cost 缺失/无效、以及 submission unknown 都不会被猜测结算或退款。合成 `settledActualCostMicros` 表示已结算成员小计，`actualCostMicros` 仅在全部成员结算后出现。
- 作品库把同一个 `batchId` 的成员合成为一条记录，可展开查看按 index 排列的子任务。只有所有成员终态且账务结清时才可以“隐藏作品”；隐藏会给所有批次成员写入 tombstone 并清理归档图片，不删除账本、不会取消任务或触发退款。任务、批次、恢复记录和本地结果均按账号隔离。
- `runtime.env`、供应商 env 文件、`config.local.js` 和 `.data` 永远不在静态文件白名单内。浏览器只读取 `/api/public-config` 中的公开 feature/pricing 数据；该接口不会暴露 API key、代理凭据或 legacy 结算倍率。

## 本地验证

需要 Node.js `>=22.0.0 <23.0.0`。项目不需要安装第三方依赖。

```sh
node --version
npm run check
npm test
npm start
```

服务默认监听 `http://127.0.0.1:8787`，本地数据默认写入 `./.data`。另一个终端可执行：

```sh
curl --fail http://127.0.0.1:8787/
```

先完成本地语法检查、测试、启动和关键业务验证，再构建或更新 NAS；不要直接在唯一生产数据副本上试运行迁移。

## 配置

敏感配置只能通过运行环境或未纳入版本控制的 `runtime.env` 提供。不要把真实凭据写入 `compose.yaml`、镜像或 README。

可用变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1`（容器内为 `0.0.0.0`） | 监听地址 |
| `PORT` | `8787` | 服务端口 |
| `DATA_DIR` | `./.data`（容器内为 `/data`） | 持久化数据目录 |
| `ADMIN_EMAIL` | 空 | 管理员邮箱 |
| `API_MARKET_API_KEY` | 空 | 上游 API 密钥 |
| `API_MARKET_BASE_URL` | `https://api.apimart.ai` | 上游地址 |
| `API_MARKET_MODEL` | `gpt-image-2` | 默认模型 |
| `QUICK_BATCH_ENABLED` | `false` | 是否允许便宜渠道将 `n=2~4` 拆成并发单图子任务 |
| `PRICING_CURRENCY_RATE` | `10` | cheap 兼容计价换算系数（业务参数，不代表真实外汇汇率） |
| `PRICING_MARKUP_MULTIPLIER` | `3.6` | cheap 兼容业务倍率 |
| `PRICING_TOTAL_MULTIPLIER` | `36` | cheap 策略总系数的兼容 fallback，必须等于前两项乘积 |
| `PRICING_GPT_IMAGE_2_TOTAL_MULTIPLIER` | `36` | `gpt-image-2` 新任务总系数 |
| `PRICING_GPT_IMAGE_2_MINIMUM_PER_IMAGE_MICROS` | `300000` | `gpt-image-2` 每张最低收费，正安全整数 micros |
| `PRICING_GPT_IMAGE_2_OFFICIAL_TOTAL_MULTIPLIER` | `10.5` | `gpt-image-2-official` 新任务总系数 |
| `PRICING_GPT_IMAGE_2_OFFICIAL_MINIMUM_PER_IMAGE_MICROS` | `300000` | `gpt-image-2-official` 每张最低收费，正安全整数 micros |
| `PRICING_LEGACY_TOTAL_MULTIPLIER` | `50` | 仅用于没有倍率快照的旧未结算任务 |
| `PRICING_VERSION` | `2026-07-10-model-policy-v1` | 新任务计价快照版本标记 |

示例 `runtime.env`（仅占位，不要提交）：

```dotenv
ADMIN_EMAIL=admin@example.com
API_MARKET_API_KEY=replace-with-secret
QUICK_BATCH_ENABLED=false
PRICING_GPT_IMAGE_2_TOTAL_MULTIPLIER=36
PRICING_GPT_IMAGE_2_MINIMUM_PER_IMAGE_MICROS=300000
PRICING_GPT_IMAGE_2_OFFICIAL_TOTAL_MULTIPLIER=10.5
PRICING_GPT_IMAGE_2_OFFICIAL_MINIMUM_PER_IMAGE_MICROS=300000
```

Compose 的 `environment` 优先级高于 `env_file`。因此 `compose.yaml` 只在 `environment` 中固定容器运行所需的 `HOST`、`PORT` 和 `DATA_DIR`，不会为密钥、上游地址、模型或计价变量写入空值/默认值并覆盖 `runtime.env`。`QUICK_BATCH_ENABLED` 也应随这些应用配置写入未提交的 `runtime.env`；文件中未提供时，由应用代码使用上表默认值。可复制 `runtime.env.example` 为 `runtime.env` 后填写真实值；示例文件只含占位符和非敏感默认值。修改 `QUICK_BATCH_ENABLED` 后必须重启 Node 进程或容器，因为该开关在服务启动时读取。

## Docker 本地示例

`compose.yaml` 中的 `./.data:/data` 仅用于本地开发示例。Compose 强制要求显式提供 `APP_UID` 和 `APP_GID`，不会猜测镜像内 `node` 用户的 UID/GID。本地可使用当前用户身份：

```sh
export APP_UID="$(id -u)"
export APP_GID="$(id -g)"
docker compose config
docker compose build
docker compose up -d
docker compose ps
```

生产环境必须使用已经核实、并与数据副本所有权一致的固定数值，而不是直接照搬本地 `id` 结果。`APP_UID`、`APP_GID` 和可选的宿主发布端口 `APP_PORT` 只用于 Compose 插值，应由启动 shell、受控部署环境或未提交的 Compose `.env` 提供；服务内的 `runtime.env` 不用于这三个插值变量。反过来，启动 shell 中同名的密钥或计价变量不会被 Compose 自动传进容器：应用运行配置应写入 `runtime.env`，避免再次引入会覆盖 `env_file` 的显式 `environment` 条目。

容器使用 Node 22 Alpine、非 root 用户运行，监听 `0.0.0.0:8787`，并通过 HTTP 首页健康检查。`.dockerignore` 排除了本地数据、所有 env 文件、`config.local.js`、备份、Git 元数据、plans 和 `node_modules`。

## NAS 数据、快照与回滚

当前 NAS 路径已经审计确认：

| 用途 | NAS 路径 | 容器路径 |
| --- | --- | --- |
| 应用目录 | `/volume2/docker/gpt-image-2/app` | `/app` |
| 运行配置（含密钥） | `/volume2/docker/gpt-image-2/app/runtime.env` | 通过运行环境注入 |
| 业务数据根目录 | `/volume2/docker/gpt-image-2/data` | `/data` |
| 主数据 JSON | `/volume2/docker/gpt-image-2/data/app-data.json` | `/data/app-data.json` |
| 生成图片目录 | `/volume2/docker/gpt-image-2/data/images/` | `/data/images/` |

NAS 部署时应继续使用宿主绝对路径 `/volume2/docker/gpt-image-2/data:/data`，不要照搬本地示例的 `./.data:/data`。`runtime.env` 含真实密钥，只能保留在受控的 NAS 运行配置位置，不得复制进镜像、构建上下文或版本仓库，也不得把其真实内容写入备份说明或迁移记录。

审计时，数据根目录为 mode `700`、owner `1001:10`，但 `app-data.json` 和 `images/` 下已有内容存在 `root:root`、mode `600`。镜像默认的 `node` 用户通常是 UID 1000，但正式部署不得依赖这一假设。必须先选定新容器明确的非 root `APP_UID:APP_GID`，再使待切换数据副本的根目录、JSON、`images/` 及其全部内容归属于该身份并保持所需的目录遍历、读取和写入权限。

升级前执行一致快照：

1. 停止旧容器或至少阻止写入，确认没有生成、结算或后台刷新正在修改数据。2026-07-10 的只读审计发现 3 条 `settled=false`、`status=submitting` 且没有 `taskId` 的旧记录；它们无法通过上游任务接口自动追踪。正式切换前必须逐条人工核对并记录退款、保留预扣或其他处置决定，不能把它们误当作可按 legacy 50 自动结算的正常在途任务。
2. 将 `/volume2/docker/gpt-image-2/data/app-data.json` 与 `/volume2/docker/gpt-image-2/data/images/` 作为一个不可拆分的数据集，在同一冻结点完成一致性快照或完整复制。不能先后在业务仍可写入时分别复制，也不能只备份 JSON 而遗漏图片。
3. 只在一致快照的可写副本上，将数据根目录、`app-data.json`、`images/` 及其全部内容递归调整为已经明确选定的 `APP_UID:APP_GID`，并设置最小必要的目录和文件权限。不得先对唯一生产数据原件执行 `chown`、`chmod` 或写入测试。
4. 先以相同 UID/GID 对快照副本做读写探针。例如将副本挂载到 `/data` 后运行 `docker run --rm --user "$APP_UID:$APP_GID" -v /已确认的快照副本:/data:rw node:22-alpine sh -c 'test -r /data/app-data.json && test -d /data/images && test -x /data/images && probe=/data/.permission-probe-$$ && : > "$probe" && rm "$probe"'`；也可用实际新容器执行等价探针。路径必须替换为快照副本，不能指向唯一生产目录。
5. 记录旧镜像标识、启动参数、端口、环境变量名称、数据挂载以及选定的 UID/GID，且不要把环境变量的真实值写入迁移记录。
6. 使用同一快照副本验证新镜像可启动、历史用户和账目可读取、旧图片可访问、新任务可完整结算。
7. 验证通过后，再按已验证的 UID/GID 和权限策略准备正式切换副本、切换生产容器，并保留旧镜像和只读原始快照直到观察期结束。

需要回滚时，先停止新容器，恢复旧镜像及原启动参数，并将 `/data` 指向升级前的一致快照。不要让新旧版本同时写同一个数据目录，也不要把升级后的部分文件与升级前快照混合恢复。

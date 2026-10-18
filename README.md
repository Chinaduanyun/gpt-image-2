# 图片生成工作台

这是一个基于 Node.js 22 的图片生成工作台，使用 `sharp` 解码、校验和归档图片。服务端代理上游图片接口，并将用户、会话、消费记录和生成图片持久化到 `DATA_DIR`。

## 计费口径

### 混合通道（`IMAGE_PROVIDER_MODE=cpa`）

- 采用提交时锁定的固定报价（`fixed-quote-v2`）：成功按该报价结算，明确失败退款；供应商返回的 cost 不覆盖报价。提交结果未知时不自动重发、切换供应商或退款。
- 优先 CPA；只有明确的技术性/不可用拒绝才允许转 Market 备用通道。已接受的 Market 任务只查询状态，不重新提交。多张图片拆成按原顺序展示的单图任务，仍受 `QUICK_BATCH_ENABLED` 控制。
- 图片规格为尽力满足；创作和编辑共用一次简短费用确认。成品归档失败保留待恢复结果，不重新生成。供应商密钥由受控环境或私有配置文件提供，不能放在浏览器配置或仓库中。

### API Market 兼容通道（未启用混合通道）

- 新任务按模型选择计价策略：便宜渠道 `gpt-image-2` 的总系数为 **36**，官方渠道 `gpt-image-2-official` 的总系数为 **10.5**。供应商价格表和最终 `data.cost` 的单位均为美元 cost；总系数是业务计价参数，不代表或声明真实外汇汇率。
- 默认单张下限：便宜渠道 **¥0.30**；官方渠道按请求清晰度分别为 **1K ¥0.30、2K ¥0.55、4K ¥0.85**（可通过环境配置覆盖）。预估先计算 `round(供应商单张美元价 × 模型总系数 × 1000000)`，再与所选单张下限取较大值并乘以张数。最终结算将整个任务 `data.cost` 乘以该日志快照的模型总系数，再与提交时固化的 `minimumChargeMicros` 取较大值；不重新读取当前下限，不把任务总成本除以张数。
- 官方 `1:1 · 4K · high` 单张精确预估为 `5978280 micros`，4 张为 `23913120 micros`。页面金额低于 ¥1 时显示 3 位小数，达到 ¥1 时显示 2 位小数，例如 `¥0.300`、`¥0.306`、`¥5.98`；显示格式不改变 API、余额、预扣、日志或结算中的整数 micros。
- NAS legacy 旧口径总系数为 **50**。历史已结算记录保留原金额、不追溯改写；历史未结算任务有 `totalMultiplier` 快照时继续只按该快照线性结算，不追加新下限；没有倍率快照时继续按 legacy 50 结算。即使历史 official 快照是 36，也不能按当前 10.5 重算；缺少 `minimumChargeMicros` 时不能根据当前模型或张数反推下限。
- `PRICING_TOTAL_MULTIPLIER` 作为 cheap 策略的兼容 fallback 保留，必须与 `PRICING_CURRENCY_RATE × PRICING_MARKUP_MULTIPLIER` 一致。新代码按模型 profile 估价和结算，不能用顶层 cheap 系数为 official 定价；`PRICING_LEGACY_TOTAL_MULTIPLIER` 只用于没有倍率快照的旧未结算任务。
- 价格卡仅保留总价及必要警告；账号余额显示在顶部，不再展示重复的价格说明或余额预测。缺少所选模型的公开 profile 时页面会提示配置异常并禁止生成，不会静默使用倍率 1。
- 部署前应在本地对典型模型、尺寸、质量、张数、预估、预扣、日志快照及最终结算逐项核对，不能只验证页面显示。
- API Market 当前文档明确说明：便宜渠道的规范模型名是 `gpt-image-2`，并兼容别名 `gpt-image-2-ext`，两者效果一致、可互换使用。2026-07-10 通过生产网络查询 `/v1/models` 时只列出了 `gpt-image-2` 和 `gpt-image-2-official`，因此本项目继续统一发送规范名 `gpt-image-2`，同时在服务端接受并规范化 `gpt-image-2-ext`；不能再把 `gpt-image-2-ext` 描述成“仅展示名称或不可请求”。
- 便宜渠道价格的代码单位是美元 cost，而不是页面 Credits：1K/2K/4K 分别为 `0.0085`、`0.014`、`0.021` 美元；按总系数 36 对应用户价格 `¥0.306`、`¥0.504`、`¥0.756`。`0.085 Credits` 对应的是 `$0.0085`，不能在代码里误写成 `0.085`。
- `gpt-image-2-official` 使用 45 个实际像素尺寸的 low/medium/high 精确价格表。合法页面组合必须有精确价格；供应商返回的实际 `data.cost` 仍是最终结算依据，`data.credits_cost` 仅作供应商 Credits 展示，不能代替美元 cost 参与本项目结算。
- 结算时实际成本超过预扣、且余额不足以补齐时，差额记为该日志的 `balanceUnderpaidMicros`（欠费）。管理员通过 `POST /api/admin/users/:email/balance` 充值（`deltaMicros>0`）时，充值后会自动按 `createdAt` 从旧到新抵扣该用户所有未清 `balanceUnderpaidMicros`：能扣多少扣多少、余额不为负；被抵扣的日志记 `debtCollectedMicros`/`debtCollectedAt` 并把 `balanceUnderpaidMicros` 减到位，本次 `balance_adjustment` 日志记录 `collectedDebtMicros` 总额。此抵扣只搬动已欠金额、不改变任何计价数字或历史结算。
- `gpt-image-2` 与 `gpt-image-2-official` 的服务端参数校验均接受 `n=1~4`。官方模型仍按一个上游多图任务提交；便宜渠道仅在 `QUICK_BATCH_ENABLED=true` 时把 `n>1` 拆成多个并发单图任务，默认关闭。批次成员都是普通 `type:'generation'` 消费记录，通过 `batchId`、`batchIndex`、`batchSize` 关联；每个成员独立保留 `n=1` 计价快照和每张 300000 micros 下限，批次 DTO 只在提交、批次查询和用户历史接口中临时合成。官方渠道还支持 `mask_url` 局部重绘，但当前产品没有提供该功能，不能把“上游支持”误写成“本项目已支持”。

## 快速批量行为与接口

- `QUICK_BATCH_ENABLED=false`（默认）时，快速低价版的张数选择被锁定为 1；服务端也会拒绝 `gpt-image-2` 的 `n=2~4` 请求。官方 `gpt-image-2-official` 的 `n=1~4` 不受此开关影响，继续提交一个官方多图任务。
- `QUICK_BATCH_ENABLED=true` 时，快速低价版支持 `n=1~4`。其中 `n=1` 保持原单任务响应；`n=2~4` 会先在一次数据存储事务中按总预估金额原子预扣，再同时向上游提交 N 个完全相同、但 `n=1` 的请求。不会逐个子任务扣款，也不会因某个子任务较早返回而改变展示顺序。
- 批量提交必须携带稳定的 `Idempotency-Key`。相同账号、相同键和相同规范化参数会返回原批次，不会再次预扣或提交；相同键配不同参数返回 HTTP `409` 和 `idempotency_conflict`。浏览器会先保存账号隔离的恢复记录，再提交请求；刷新、超时或断网恢复均复用原键。
- 明确的非瞬态提交失败（例如 HTTP 400）只退还对应子任务的预扣。HTTP 408、429、5xx、网络中断，以及成功响应缺少 `task_id` 都属于提交结果未知：为避免供应商已经接单时重复生成或重复退款，系统不会自动重试、重新提交或退款，需要继续刷新或人工核对。
- `POST /api/api-market/v1/images/generations` 的批量响应包含 `kind=batch`、`batchId`/`batch_id`、`clientRequestId`/`client_request_id`、`requestedCount`、`counts`、按原索引排列的 `children`、`imageUrls`、`aggregateBilling` 和兼容字段 `billing`。每个 child 包含 `index`、`status`、`taskId`/`task_id`、图片、错误和独立 billing；批次 billing 由同一 `batchId` 下的普通 generation 日志临时聚合。
- `GET /api/api-market/v1/batches/:batchId` 会按 `batchIndex` 遍历同一批次的普通 generation 日志，按成员独立结算并应用每张最低收费。合成批次状态可能为 `submitting`、`processing`、`completed`、`partial_success`、`failed` 或 `attention_required`；成功图片始终按 child index 合并，失败或未知位置仍在结果区保留槽位。
- 合成批次只有在所有成员都结算后才算结清。明确失败且供应商未返回 cost 的成员会全额退款；失败但 cost 无效、完成但 cost 缺失/无效、以及 submission unknown 都不会被猜测结算或退款。合成 `settledActualCostMicros` 表示已结算成员小计，`actualCostMicros` 仅在全部成员结算后出现。
- 作品库把同一个 `batchId` 的成员合成为一条记录。隐藏只改变历史可见性，**保留图片及账本**，不取消任务、不退款；通常要求所有成员终态且结清，独立的 `submission_unknown` 允许仅隐藏，但批次未知仍受保护。
- 永久删除资产是独立的 `DELETE /api/me/logs/:id/assets` 操作，需 `X-Confirm-Delete: permanent` 且所有成员已结算终态。先持久化 tombstone，再清理输入、成品和待归档副本；清理失败保留重试状态，账本和余额不删除。隐藏与永久删除不是同一个动作。
- 多任务详情只读；“复制为新请求”才会把可用输入复制到草稿。默认最多同时运行 3 个请求组（批次算一个），限额与预扣同一原子事务检查，幂等重放不会再次计数或扣费。`GET /api/me/tasks` 提供账号任务与限额；新建草稿不受限额影响。提示词在任务胶囊中只显示前 15 个 Unicode code point，详情保留全文。
- 草稿、参考图和编辑器按账号存于 IndexedDB；刷新后恢复已完成持久化的快照。异步存储并不保证浏览器被立即强制关闭前的最后一次修改已经落盘。
- `runtime.env`、供应商 env 文件、`config.local.js` 和 `.data` 永远不在静态文件白名单内。浏览器只读取 `/api/public-config` 中的公开 feature/pricing 数据；该接口不会暴露 API key、代理凭据或 legacy 结算倍率。

## 标注编辑与参考图

- 先上传底图，或从作品库/生成结果选择“编辑此图”。画笔、矩形、椭圆标注会和底图合成一张图片，作为请求中的 **图 1**；不使用 `mask_url`。
- 编辑页的“参考图（可选）”支持多选上传或粘贴 PNG/JPEG/WebP，并显示缩略图和图号。额外参考图从 **图 2** 开始，不叠加到画布，不与创作页参考图混用。例如：“把图 1 绿色框中的椅子替换成图 2 的款式，其他区域不变。”
- 底图必须有；额外参考图和标注都可省略。额外最多 15 张，单张 ≤5MB，合成底图与参考图合计 ≤18MB；完整 JSON 请求体仍受 24MB 上限约束。超限时提交前提示，不发起收费请求。
- 多图时自动附加图片用途说明；它不受“自动附加标注说明”开关控制，且计入最终 8000 字符上限。删除图片会重新排列图号，需核对修改说明中的引用。
- 更换底图会在确认并成功载入后清空旧标注和参考图；取消或载入失败保留原编辑。注销/切换账号会清空编辑状态，未完成的旧账号图片读取不会回填。

## 访问边界

当前登录仅校验邮箱白名单，**不验证邮箱所有权**：知道已允许邮箱的人可以取得该账号会话，管理员邮箱同理。它不是密码或验证码认证。不要把邮箱白名单当作身份安全边界；不可信网络访问需另设可靠访问控制。此次整理不更改登录政策或自动添加密码。

## 本地验证

需要 Node.js `>=22.0.0 <23.0.0`。先按锁文件安装运行依赖（包含 `sharp`）：

```sh
node --version
npm ci
npm run check
npm test
npm start
```

服务默认监听 `http://127.0.0.1:8787`，本地数据默认写入 `./.data`。另一个终端可执行：

```sh
curl --fail http://127.0.0.1:8787/
```

先完成本地语法检查、测试、启动和关键业务验证，再构建或更新 NAS；不要直接在唯一生产数据副本上试运行迁移。

编辑多图的可选浏览器验收使用 `test/browser-edit-references.cjs`。在外部临时目录安装 Playwright/Chromium 后，通过 `NODE_PATH` 指向该目录运行（无需修改项目依赖）：

```sh
NODE_PATH=/path/to/qa-tools/node_modules node test/browser-edit-references.cjs
```

脚本需要 `openssl`；它自动启动真实应用、临时账号库和本地 HTTPS 模拟供应商，验证桌面/手机视口的上传、划框、独立参考图、图序与透传、删除/清空/更换底图。模拟供应商捕获请求后故意返回 HTTP 400，验证安全失败流程，**不调用生产或付费生成，也不验证模型出图效果**。截图和报告写入打印出的系统临时目录。受限环境可在同一临时工具目录安装 `@sparticuz/chromium` 并设置 `QA_COMPACT_CHROMIUM=1`。

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
| `QUICK_BATCH_ENABLED` | `false` | 是否允许快速批量（混合通道多图也受此开关约束） |
| `MAX_ACTIVE_REQUESTS` | `3` | 每账号进行中请求组上限，正整数；未知请求仍占位 |
| `IMAGE_PROVIDER_MODE` | 空 | `cpa` 启用混合通道，否则使用 API Market 兼容通道 |
| `PRICING_CURRENCY_RATE` | `10` | cheap 兼容计价换算系数（业务参数，不代表真实外汇汇率） |
| `PRICING_MARKUP_MULTIPLIER` | `3.6` | cheap 兼容业务倍率 |
| `PRICING_TOTAL_MULTIPLIER` | `36` | cheap 策略总系数的兼容 fallback，必须等于前两项乘积 |
| `PRICING_GPT_IMAGE_2_TOTAL_MULTIPLIER` | `36` | `gpt-image-2` 新任务总系数 |
| `PRICING_GPT_IMAGE_2_MINIMUM_PER_IMAGE_MICROS` | `300000` | `gpt-image-2` 每张最低收费，正安全整数 micros |
| `PRICING_GPT_IMAGE_2_OFFICIAL_TOTAL_MULTIPLIER` | `10.5` | `gpt-image-2-official` 新任务总系数 |
| `PRICING_GPT_IMAGE_2_OFFICIAL_MINIMUM_PER_IMAGE_MICROS` | `300000` | 官方渠道未知清晰度时的兼容下限 |
| `PRICING_GPT_IMAGE_2_OFFICIAL_MINIMUM_PER_IMAGE_MICROS_1K` | `300000` | 官方 1K 单张下限 |
| `PRICING_GPT_IMAGE_2_OFFICIAL_MINIMUM_PER_IMAGE_MICROS_2K` | `550000` | 官方 2K 单张下限 |
| `PRICING_GPT_IMAGE_2_OFFICIAL_MINIMUM_PER_IMAGE_MICROS_4K` | `850000` | 官方 4K 单张下限 |
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

## Docker 部署示例

仓库的 `compose.yaml` 当前挂载 NAS 绝对路径 `/volume2/docker/gpt-image-2/data:/data`，**不是本地隔离示例**。本地 Docker 验证应复制为临时 Compose 文件并把数据挂载改到全新临时目录，不能指向生产数据。容器以显式非 root 身份运行：`user:` 字段写作 `"${APP_UID:?…}:${APP_GID:?…}"`，未提供 `APP_UID`/`APP_GID` 时 Compose 直接报错，不存在写死的 `0:0` root 回退，也不会猜测镜像内 `node` 用户的 UID/GID。本地可使用当前用户身份：

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

NAS 部署按 release 保存源码、镜像与回退配置；旧 `/app` Git 工作目录不应当作当前线上源码。部署前以运行容器挂载和对应 release 清单为准：

| 用途 | NAS 路径 | 容器路径 |
| --- | --- | --- |
| 当前源码快照 | `/volume2/docker/gpt-image-2/releases/<release>/source` | 构建至镜像 `/app` |
| 部署与私有运行配置 | `/volume2/docker/gpt-image-2/releases/<release>/` 及受控供应商配置位置 | 环境变量或 `/run/secrets` 私有挂载 |
| 业务数据根目录 | `/volume2/docker/gpt-image-2/data` | `/data` |
| 主数据 JSON | `/volume2/docker/gpt-image-2/data/app-data.json` | `/data/app-data.json` |
| 生成图片目录 | `/volume2/docker/gpt-image-2/data/images/` | `/data/images/` |

NAS 部署时应继续使用宿主绝对路径 `/volume2/docker/gpt-image-2/data:/data`，不要照搬本地示例的 `./.data:/data`。`runtime.env` 含真实密钥，只能保留在受控的 NAS 运行配置位置，不得复制进镜像、构建上下文或版本仓库，也不得把其真实内容写入备份说明或迁移记录。

历史审计曾发现数据所有权不一致；2026-10-18 的生产容器以明确的 `1000:1000` 运行。后续部署仍应核实实际所有权，不能依赖镜像内 `node` 用户的默认 UID。必须先选定新容器明确的非 root `APP_UID:APP_GID`，再使待切换数据副本的根目录、JSON、`images/` 及其全部内容归属于该身份并保持所需的目录遍历、读取和写入权限。

升级前执行一致快照：

1. 确认没有真实在途生成后，停止旧容器或阻止全部写入，冻结生成、结算和后台刷新。已有 3 条历史未知记录已由用户确认为测试记录，保持原样，不删除、不重发、不退款，也不把它们当作可自动结算的正常在途任务。
2. 将 `/volume2/docker/gpt-image-2/data/app-data.json` 与 `/volume2/docker/gpt-image-2/data/images/` 作为一个不可拆分的数据集，在同一冻结点完成一致性快照或完整复制。不能先后在业务仍可写入时分别复制，也不能只备份 JSON 而遗漏图片。
3. 只在一致快照的可写副本上，将数据根目录、`app-data.json`、`images/` 及其全部内容递归调整为已经明确选定的 `APP_UID:APP_GID`，并设置最小必要的目录和文件权限（目录 700、文件 600）。可使用 `deploy/migrate-data-ownership.sh --uid <UID> --gid <GID> --dir <快照副本目录>`：默认 `--dry-run` 只打印将执行的 `chown`/`chmod` 与探针命令，确认无误后再加 `--apply` 真正执行；脚本拒绝迁移到 root 且只应指向快照副本。不得先对唯一生产数据原件执行 `chown`、`chmod` 或写入测试。
4. 先以相同 UID/GID 对快照副本做读写探针。例如将副本挂载到 `/data` 后运行 `docker run --rm --user "$APP_UID:$APP_GID" -v /已确认的快照副本:/data:rw node:22-alpine sh -c 'test -r /data/app-data.json && test -d /data/images && test -x /data/images && probe=/data/.permission-probe-$$ && : > "$probe" && rm "$probe"'`；也可用实际新容器执行等价探针。路径必须替换为快照副本，不能指向唯一生产目录。
5. 记录旧镜像标识、启动参数、端口、环境变量名称、数据挂载以及选定的 UID/GID，且不要把环境变量的真实值写入迁移记录。
6. 使用同一快照副本验证新镜像可启动、历史用户和账目可读取、旧图片可访问、新任务可完整结算。
7. 验证通过后，再按已验证的 UID/GID 和权限策略准备正式切换副本、切换生产容器，并保留旧镜像和只读原始快照直到观察期结束。

需要回滚时，先停止新容器，恢复旧镜像及原启动参数，并将 `/data` 指向升级前的一致快照。不要让新旧版本同时写同一个数据目录，也不要把升级后的部分文件与升级前快照混合恢复。

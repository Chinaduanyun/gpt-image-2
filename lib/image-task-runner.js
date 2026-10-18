const fs = require('node:fs');
const path = require('node:path');
const { loadDataStore, withDataStoreMutation, getDataDir } = require('./store');
const { nowIso } = require('./common');
const { readSource, saveAsset, InvalidImageError, cleanupTaskFiles, removePendingResultSpool } = require('./image-assets');
const { generateCpa, resultBuffer } = require('./cpa-image');
const { createMarketAdapter } = require('./market-image');
const BILLING_VERSION = 'fixed-quote-v2';
// Explicit metadata so a fixed-quote record is never mistaken for the legacy
// provider-cost/floor policy that settlement.test.js and spend-logs settle against.
const BILLING_POLICY_FIXED_QUOTE_V2 = 'fixed-quote-v2';
const active = new Map();
// One archive attempt per task per process. Background refresh calls recoverTasks() every
// 30s, so without this a task whose spool is still on disk (settle or unlink failed) would
// be re-attempted on every tick - re-downloading a URL-type Market result each time. A
// restart clears the set, which is the documented "retry after restart" escape hatch.
const archiveAttempted = new Set();
let unavailable = false;
let stopping = false;
const enabled = () => process.env.IMAGE_PROVIDER_MODE === 'cpa';
const spoolPath = (id) => path.join(getDataDir(), 'pending-results', `${id}.json`);
function initializeHybridLog(log) {
  log.billingVersion = BILLING_VERSION;
  // Fixed-quote v2 charges the pre-locked quote and ignores provider cost, so the
  // policy marker must not claim the provider-cost/floor rule the legacy path uses.
  log.billingPolicy = BILLING_POLICY_FIXED_QUOTE_V2;
  // The nested pricing snapshot is written by pricingFields() with the legacy marker.
  // Settlement reads the top-level field first, so syncing this is metadata only and
  // changes no number - it just stops the record from contradicting itself.
  if (log.pricingSnapshot && typeof log.pricingSnapshot === 'object') {
    log.pricingSnapshot.billingPolicy = BILLING_POLICY_FIXED_QUOTE_V2;
  }
  log.fixedQuoteMicros = log.estimatedCostMicros;
  log.taskId = `local_${log.id}`;
  log.status = 'queued';
  log.attempts = [];
  log.inputFiles = [];
  log.archiveStatus = 'pending';
  log.specificationMode = 'best_effort';
}
function settleFixed(data, log, success) {
  if (log.settled !== false) return false;
  const user = data.users[log.email];
  if (!user) throw new Error('计费用户不存在。');
  if (!success) { user.balanceMicros += log.chargedMicros; log.chargedMicros = 0; }
  log.actualCostMicros = success ? log.fixedQuoteMicros : 0;
  log.balanceAfterMicros = user.balanceMicros;
  log.balanceUpdatedAt = nowIso();
  log.settled = true;
  log.settlementStatus = success ? 'settled_fixed_quote' : 'refunded';
  log.status = success ? 'completed' : 'failed';
  log.completedAt = nowIso();
  return true;
}
async function mutate(id, fn) {
  return withDataStoreMutation((data) => {
    const log = data.spendLogs.find((entry) => entry.id === id);
    if (!log) throw new Error('任务不存在。');
    return fn(log, data);
  });
}
async function archiveResult(id) {
  const snapshot = loadDataStore().spendLogs.find((log) => log.id === id);
  if (!snapshot || snapshot.settled || snapshot.assetsDeletedAt) return;
  const results = JSON.parse(fs.readFileSync(spoolPath(id), 'utf8'));
  const files = [];
  try {
    if (results.length !== 1) throw new InvalidImageError('成品数量与单图计费任务不一致。');
    for (let index = 0; index < results.length; index += 1) files.push(await saveAsset(id, 'result', index, await resultBuffer(results[index])));
  } catch (error) {
    if (error.code !== 'INVALID_IMAGE') throw error;
    await mutate(id, (log, data) => {
      if (log.settled || log.assetsDeletedAt) return;
      log.archiveStatus = 'invalid_image';
      log.error = '供应商成品损坏或不符合安全图片限制，无法交付；已退款，不重新生成。';
      log.attempts.at(-1).state = 'invalid_result';
      settleFixed(data, log, false);
    });
    removePendingResultSpool(id);
    return;
  }
  await mutate(id, (log, data) => {
    if (log.settled || log.assetsDeletedAt || log.status !== 'archiving') return;
    log.imageFiles = files;
    log.imageUrls = files.map((file) => `/api/stored-images/${file.fileName}`);
    log.archiveStatus = 'saved';
    log.error = '';
    settleFixed(data, log, true);
  });
  removePendingResultSpool(id);
}
// Re-archive a leftover spool at most once per process. If either the settle or the
// spool unlink fails, the paid base64 copy stays on disk; retrying it on every
// background tick would spin, but the work must not be silently abandoned either.
async function archiveSpool(id) {
  if (archiveAttempted.has(id)) return;
  archiveAttempted.add(id);
  const operation = (async () => {
    await mutate(id, (current) => { current.status = 'archiving'; });
    try { await archiveResult(id); }
    catch { await mutate(id, (current) => { current.archiveStatus = 'error'; current.error = '成品归档失败；已保留待恢复结果，需重启或管理员处理，不会重新生成。'; }); }
  })().finally(() => active.delete(id));
  active.set(id, operation);
  await operation;
}
async function persistResult(id, results) {
  const spool = spoolPath(id);
  fs.mkdirSync(path.dirname(spool), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${spool}.tmp`, JSON.stringify(results), { mode: 0o600 });
  fs.renameSync(`${spool}.tmp`, spool);
  await mutate(id, (log) => {
    if (log.settled) return;
    log.status = 'archiving'; log.archiveStatus = 'pending';
    log.attempts.at(-1).state = 'generated';
    log.attempts.at(-1).submissionCertainty = 'accepted';
  });
}
async function pollMarket(id, adapter) {
  const snapshot = loadDataStore().spendLogs.find((log) => log.id === id);
  if (!snapshot || snapshot.settled || snapshot.status !== 'processing') return;
  const attempt = snapshot.attempts.at(-1);
  if (attempt?.provider !== 'market' || !attempt.externalTaskId) return;
  if (!adapter) {
    await mutate(id, (log) => { log.error = 'Market 备用通道当前未配置；已提交任务只等待恢复查询，不会重新提交。'; });
    return;
  }
  try {
    const result = await adapter.poll(attempt.externalTaskId);
    if (result.failed) { await mutate(id, (log, data) => { if (!log.settled) { log.error = 'Market 任务明确失败，已退款。'; log.attempts.at(-1).state = 'failed'; settleFixed(data, log, false); } }); return; }
    if (result.unknown) { await mutate(id, (log) => { if (!log.settled) { log.status = 'submission_unknown'; log.settlementStatus = 'submission_unknown'; log.error = 'Market 终态没有可确认成品，需要管理员核查。'; } }); return; }
    if (result.results) {
      if (loadDataStore().spendLogs.find((log) => log.id === id)?.settled) return;
      await persistResult(id, result.results);
      try { await archiveResult(id); }
      catch { await mutate(id, (log) => { log.archiveStatus = 'error'; log.error = 'Market 成品归档失败；只重试保存。'; }); }
    } else { await mutate(id, (log) => { log.nextProviderPollAt = Date.now() + 30000; log.error = ''; }); }
  } catch {
    await mutate(id, (log) => { if (!log.settled) { log.nextProviderPollAt = Date.now() + 30000; log.error = 'Market 状态查询或成品保存暂不可用；只重试查询/保存，不重发。'; } });
  }
}
async function runTask(id, payload, dependencies = {}) {
  let phase = 'inputs';
  try {
    const snapshot = loadDataStore().spendLogs.find((log) => log.id === id);
    if (!snapshot || snapshot.status !== 'queued' || snapshot.settled) return;
    const inputs = [];
    let inputBytes = 0;
    for (const [index, source] of (payload.image_urls || []).entries()) {
      const buffer = await readSource(source);
      inputBytes += buffer.length;
      if (buffer.length > 5 * 1024 * 1024 || inputBytes > 18 * 1024 * 1024) throw new Error('参考图超出容量限制。');
      const file = await saveAsset(id, 'input', index, buffer);
      inputs.push(file);
      await mutate(id, (log) => { log.inputFiles = [...inputs]; });
    }
    const marketAdapter = dependencies.marketAdapter || createMarketAdapter();
    const providers = unavailable ? ['market'] : ['cpa', 'market'];
    let results;
    for (const provider of providers) {
      if (provider === 'market' && !dependencies.market && !marketAdapter) {
        await mutate(id, (log, data) => { log.error = 'CPA 无法执行；备用 Market 通道已禁用，未调用真实 Market。'; settleFixed(data, log, false); });
        return;
      }
      await mutate(id, (log) => {
        log.status = 'processing';
        log.provider = provider;
        log.attempts.push({ provider, state: 'submitted', submittedAt: nowIso(), submissionCertainty: 'unknown' });
      });
      phase = 'submitted';
      try {
        if (provider === 'market' && marketAdapter) {
          const submitted = await marketAdapter.submit({ ...payload, n: 1 }, inputs);
          await mutate(id, (log) => { if (!log.settled) { log.attempts.at(-1).externalTaskId = submitted.externalTaskId; log.attempts.at(-1).submissionCertainty = 'accepted'; } });
          await pollMarket(id, marketAdapter);
          return;
        }
        results = await (provider === 'cpa' ? (dependencies.cpa || generateCpa) : dependencies.market)({ ...payload, n: 1 }, inputs);
        break;
      } catch (error) {
        const kind = error.kind || 'unknown';
        await mutate(id, (log) => {
          const attempt = log.attempts.at(-1);
          attempt.state = kind === 'unknown' ? 'unknown' : 'failed';
          attempt.submissionCertainty = kind === 'unknown' ? 'unknown' : 'rejected';
          attempt.finishedAt = nowIso();
        });
        if (provider === 'cpa' && ['technical', 'unavailable'].includes(kind)) { if (kind === 'unavailable') unavailable = true; continue; }
        throw error;
      }
    }
    if (!results?.length) throw new Error('无法确认成品。');
    if (loadDataStore().spendLogs.find((log) => log.id === id)?.settled) return;
    phase = 'generated';
    await persistResult(id, results);
    phase = 'archive';
    await archiveResult(id);
  } catch (error) {
    await mutate(id, (log, data) => {
      if (log.settled) return;
      if (phase === 'inputs' || ['policy', 'technical', 'unavailable'].includes(error.kind)) {
        log.error = phase === 'inputs' ? '输入资产保存或校验失败，任务未提交。' : error.message;
        settleFixed(data, log, false);
      } else if (phase === 'archive') {
        log.archiveStatus = 'error'; log.error = '成品归档失败，保留待恢复结果；仅重试保存，不重新生成。';
      } else {
        log.status = 'submission_unknown'; log.settlementStatus = 'submission_unknown';
        log.error = phase === 'generated' ? '上游已返回成品但持久化失败，需要人工处理；不会重新生成。' : (error.kind ? error.message : '提交结果未知；不会自动回退、重发或退款。');
      }
    });
  }
}
function startTask(id, payload, dependencies) {
  if (active.has(id)) return active.get(id);
  const promise = runTask(id, payload, dependencies).finally(() => active.delete(id));
  active.set(id, promise);
  return promise;
}
// A crash between "settle fixed quote" and "unlink spool" leaves a paid base64 copy on
// the volume with nothing left to deliver. Only spools whose task is already settled or
// permanently deleted are stale; anything else is still pending work.
function cleanupStaleResultSpools() {
  const spoolDir = path.join(getDataDir(), 'pending-results');
  let entries;
  try {
    const stat = fs.lstatSync(spoolDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('资产目录无效。');
    entries = fs.readdirSync(spoolDir);
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const logsById = new Map(loadDataStore().spendLogs.map((log) => [log.id, log]));
  for (const name of entries) {
    const match = name.match(/^([A-Za-z0-9_-]+)\.json(\.tmp)?$/);
    if (!match) continue;
    const log = logsById.get(match[1]);
    if (!log?.settled && !log?.assetsDeletedAt) continue;
    removePendingResultSpool(match[1]);
  }
}
// Startup classification is disk-only: it decides what can still be recovered locally
// (spool cleanup, never-submitted refunds, unknown submissions) and must never contact a
// provider. server.js awaits this before listen; network recovery runs after listen.
async function classifyStartupState() {
  cleanupStaleResultSpools();
  const logs = loadDataStore().spendLogs.filter((log) => log.billingVersion === BILLING_VERSION && !log.settled);
  for (const log of logs) {
    if (active.has(log.id)) continue;
    // A leftover spool is a paid result waiting to be archived, not an unknown submission.
    if (fs.existsSync(spoolPath(log.id))) {
      if (log.assetsDeletedAt) removePendingResultSpool(log.id);
      continue;
    }
    // An accepted Market submission is only recoverable by querying upstream; leave it
    // for the post-listen recovery pass.
    if (log.status === 'processing' && log.attempts?.at(-1)?.provider === 'market' && log.attempts.at(-1).externalTaskId) continue;
    if (!['processing', 'queued', 'archiving'].includes(log.status)) continue;
    await mutate(log.id, (current, data) => {
      if (current.status === 'queued' && !current.attempts.length) { current.error = '重启前尚未提交，已退款。'; settleFixed(data, current, false); }
      else { current.status = 'submission_unknown'; current.settlementStatus = 'submission_unknown'; current.error = '重启后无法确认上游结果；不会自动重新生成。'; }
    });
  }
}

async function recoverTasks(startup = false, dependencies = {}) {
  if (startup) await classifyStartupState();
  if (startup && dependencies.network === false) return;
  const logs = loadDataStore().spendLogs.filter((log) => log.billingVersion === BILLING_VERSION && !log.settled);
  for (const log of logs) {
    if (active.has(log.id)) continue;
    if (fs.existsSync(spoolPath(log.id))) {
      // A permanently deleted task must never be re-archived: its assets are gone on
      // purpose. Drop the paid base64 spool instead of restoring the image.
      if (log.assetsDeletedAt) { removePendingResultSpool(log.id); continue; }
      await archiveSpool(log.id);
    } else if (log.status === 'processing' && log.attempts?.at(-1)?.provider === 'market' && log.attempts.at(-1).externalTaskId) {
      if (!startup && Number(log.nextProviderPollAt) > Date.now()) continue;
      const operation = pollMarket(log.id, dependencies.marketAdapter || createMarketAdapter()).finally(() => active.delete(log.id));
      active.set(log.id, operation); await operation;
    }
  }
}
// Response-only copy: pending deletion must retain internal file records for retry.
function withoutDeletedAssets(log) {
  if (!log.assetsDeletedAt) return log;
  const { submitResponse, imageSaveErrors, originalUrl, originalUrls, ...safe } = log;
  return { ...safe, imageFiles: [], inputFiles: [], imageUrls: [], remoteImageUrls: [], assetsDeleted: true };
}
function publicLog(log) {
  log = withoutDeletedAssets(log);
  if (log.billingVersion !== BILLING_VERSION) return log;
  const { attempts, ...safe } = log;
  return { ...safe, attempts: (attempts || []).map(({ externalTaskId, ...attempt }) => attempt) };
}
function publicTask(log) {
  log = withoutDeletedAssets(log);
  return { ...(log.assetsDeletedAt ? { assetsDeleted: true } : {}), kind: 'task', taskId: log.taskId, task_id: log.taskId, clientRequestId: log.clientRequestId, status: log.status, error: log.error, imageUrls: log.imageUrls || [], imageFiles: log.imageFiles || [], inputFiles: log.inputFiles || [], archiveStatus: log.archiveStatus, specificationMode: 'best_effort', billing: { billingVersion: log.billingVersion, estimatedCostMicros: log.fixedQuoteMicros, chargedMicros: log.chargedMicros, actualCostMicros: log.actualCostMicros, settled: log.settled, settlementStatus: log.settlementStatus } };
}
module.exports = { BILLING_VERSION, enabled, initializeHybridLog, settleFixed, startTask, recoverTasks, classifyStartupState, publicTask, publicLog, archiveResult, pollMarket };

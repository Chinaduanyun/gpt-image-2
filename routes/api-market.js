const { API_PREFIX, GENERATION_BODY_LIMIT, QUICK_BATCH_ENABLED } = require('../lib/constants');
const { nowIso, createId, decodePathPart, canonicalPayloadHash, getIdempotencyKeyInfo } = require('../lib/common');
const { send, sendJson, readRequestBody, safeParseJson } = require('../lib/http-utils');
const { loadApiMarketConfig } = require('../lib/api-market-config');
const { loadDataStore, withDataStoreMutation } = require('../lib/store');
const { requireSession, sendAuthError } = require('../lib/auth');
const { sanitizeGenerationPayload, estimateGenerationCostMicros, formatMoneyMicros, pricingConfig } = require('../lib/pricing');
const {
  requestApiMarket,
  getApiHeaders,
  parseJsonText,
  extractTaskId,
  extractImageUrls,
  sanitizeErrorMessage,
  toApiMarketGenerationPayload
} = require('../lib/api-market-client');
const {
  findTaskLocation,
  findSpendLogByTaskId,
  applyTaskJsonToLog,
  archiveImagesOutsideMutation,
  mergeArchivedImages,
  replaceTaskJsonImageUrls,
  refreshLogsFromUpstream,
  requestTaskDeduped,
  scheduleRefreshBackoff,
  needsTerminalSettlementBackoff,
  markStaleSubmittingUnknown
} = require('../lib/spend-logs');
const { hasCompleteImageArchive, deleteStoredImageFiles } = require('../lib/image-store');

const SUCCESS_STATUSES = new Set(['completed', 'succeeded', 'success']);
const FAILURE_STATUSES = new Set(['failed', 'cancelled', 'error', 'submit_failed_refunded']);
const UNKNOWN_STATUSES = new Set(['submission_unknown', 'attention_required', 'unknown']);

async function forwardApiMarketResponse(upstream, res, extra = null) {
  if (upstream.retryAfter) res.setHeader('Retry-After', upstream.retryAfter);
  if (extra) {
    const json = parseJsonText(upstream.text);
    if (json && typeof json === 'object') {
      send(res, upstream.status, JSON.stringify({ ...json, ...extra }), upstream.contentType);
      return;
    }
  }
  send(res, upstream.status, upstream.text, upstream.contentType);
}

function getBillingSummary(log) {
  if (!log) return null;
  return {
    pricingVersion: log.pricingVersion || null,
    billingPolicy: log.billingPolicy || null,
    estimatedCostMicros: Number(log.estimatedCostMicros) || 0,
    minimumChargeMicros: log.minimumChargeMicros ?? null,
    providerCostMicros: log.providerCostMicros ?? null,
    actualCostMicros: log.settled === true ? (log.actualCostMicros ?? null) : null,
    ...(Object.prototype.hasOwnProperty.call(log, 'settledActualCostMicros')
      ? { settledActualCostMicros: Number(log.settledActualCostMicros) || 0 }
      : {}),
    chargedMicros: Number(log.chargedMicros) || 0,
    settled: log.settled === true,
    settlementStatus: log.settlementStatus || (log.settled ? 'settled' : 'pending')
  };
}

function pricingFields(cost) {
  return {
    unitCostMicros: cost.unitMicros,
    estimatedCostMicros: cost.totalMicros,
    pricingVersion: cost.pricingVersion,
    billingPolicy: cost.billingPolicy,
    currencyRate: pricingConfig.currencyRate,
    markupMultiplier: pricingConfig.markupMultiplier,
    totalMultiplier: cost.totalMultiplier,
    minimumPerImageMicros: cost.minimumPerImageMicros,
    billingImageCount: cost.billingImageCount,
    minimumChargeMicros: cost.minimumChargeMicros,
    pricingSnapshot: {
      pricingVersion: cost.pricingVersion,
      billingPolicy: cost.billingPolicy,
      model: cost.model,
      totalMultiplier: cost.totalMultiplier,
      minimumPerImageMicros: cost.minimumPerImageMicros,
      billingImageCount: cost.billingImageCount,
      minimumChargeMicros: cost.minimumChargeMicros,
      convertedUnitMicros: cost.convertedUnitMicros,
      unitMicros: cost.unitMicros,
      estimatedCostMicros: cost.totalMicros
    },
    providerCostMicros: null,
    actualCostMicros: null,
    chargedMicros: cost.totalMicros,
    priceDetail: cost.detail,
    pixelSize: cost.pixelSize,
    priceIsMaximum: cost.isMaximum === true,
    settlementStatus: 'pending',
    settled: false
  };
}

function generationSettings(payload) {
  return {
    size: payload.size || '',
    resolution: payload.resolution || '',
    quality: payload.quality || '',
    output_format: payload.output_format || '',
    output_compression: payload.output_compression,
    n: payload.n
  };
}

function requestIdentityFields(clientRequestId, requestHash) {
  return {
    clientRequestId,
    client_request_id: clientRequestId,
    idempotencyKey: clientRequestId,
    requestHash,
    payloadHash: requestHash
  };
}

function createSingleLog({ id, email, payload, cost, balanceBefore, balanceAfter, clientRequestId, requestHash, timestamp }) {
  return {
    id,
    type: 'generation',
    email,
    createdAt: timestamp,
    submitStartedAt: timestamp,
    completedAt: '',
    status: 'submitting',
    taskId: '',
    model: payload.model,
    prompt: payload.prompt || '',
    referenceImageCount: Array.isArray(payload.image_urls) ? payload.image_urls.length : 0,
    settings: generationSettings(payload),
    ...pricingFields(cost),
    balanceBeforeMicros: balanceBefore,
    balanceAfterMicros: balanceAfter,
    balanceUpdatedAt: timestamp,
    imageUrls: [],
    remoteImageUrls: [],
    imageFiles: [],
    error: '',
    ...requestIdentityFields(clientRequestId, requestHash)
  };
}

function createBatchLogs({ batchId, email, payload, childCost, balanceBefore, clientRequestId, requestHash, timestamp }) {
  return Array.from({ length: payload.n }, (_, index) => {
    const childBalanceBefore = balanceBefore - (childCost.totalMicros * index);
    const childBalanceAfter = balanceBefore - (childCost.totalMicros * (index + 1));
    return {
      id: `${batchId}_${index}`,
      type: 'generation',
      email,
      createdAt: timestamp,
      submitStartedAt: timestamp,
      completedAt: '',
      status: 'submitting',
      taskId: '',
      batchId,
      batchIndex: index,
      batchSize: payload.n,
      model: payload.model,
      prompt: payload.prompt || '',
      referenceImageCount: Array.isArray(payload.image_urls) ? payload.image_urls.length : 0,
      settings: { ...generationSettings(payload), n: 1 },
      ...pricingFields(childCost),
      balanceBeforeMicros: childBalanceBefore,
      balanceAfterMicros: childBalanceAfter,
      balanceUpdatedAt: timestamp,
      imageUrls: [],
      remoteImageUrls: [],
      imageFiles: [],
      error: '',
      stableFileStem: `${batchId}_${index}`,
      ...requestIdentityFields(clientRequestId, requestHash)
    };
  });
}

function refundSubmittingLog(data, logId, email, errorMessage, upstreamStatus = null) {
  const log = data.spendLogs.find((entry) => entry.id === logId);
  const user = data.users[email];
  if (!user || !log || log.status !== 'submitting') return false;
  user.balanceMicros = (Number(user.balanceMicros) || 0) + (Number(log.chargedMicros) || 0);
  user.updatedAt = nowIso();
  log.status = 'submit_failed_refunded';
  log.error = errorMessage;
  log.chargedMicros = 0;
  log.balanceAfterMicros = user.balanceMicros;
  log.balanceUpdatedAt = nowIso();
  if (upstreamStatus !== null) log.upstreamSubmitStatus = upstreamStatus;
  log.completedAt = nowIso();
  log.settlementStatus = 'refunded';
  log.settled = true;
  return true;
}

function markSubmissionUnknown(log, errorMessage, upstreamStatus = null) {
  if (!log || log.status !== 'submitting') return false;
  log.status = 'submission_unknown';
  log.error = errorMessage || '提交结果未知；为避免重复计费，不会自动重试或退款。';
  if (upstreamStatus !== null) log.upstreamSubmitStatus = upstreamStatus;
  log.completedAt = nowIso();
  log.settlementStatus = 'submission_unknown';
  return true;
}

function isTransientSubmitStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function clientRequestFields(logOrLogs) {
  const first = Array.isArray(logOrLogs) ? logOrLogs[0] : logOrLogs;
  const clientRequestId = first?.clientRequestId || first?.idempotencyKey || '';
  return clientRequestId ? { clientRequestId, client_request_id: clientRequestId } : {};
}

function sortBatchLogs(logs) {
  return logs.slice().sort((a, b) => (Number(a.batchIndex) || 0) - (Number(b.batchIndex) || 0));
}

function getBatchLogs(data, batchId) {
  return sortBatchLogs(data.spendLogs.filter((log) => log.type === 'generation' && log.batchId === batchId));
}

function batchCounts(children) {
  return children.reduce((counts, child) => {
    const status = String(child.status || '').toLowerCase();
    if (SUCCESS_STATUSES.has(status)) counts.succeeded += 1;
    else if (FAILURE_STATUSES.has(status)) counts.failed += 1;
    else if (UNKNOWN_STATUSES.has(status)) counts.unknown += 1;
    else if (status === 'submitting') counts.submitting += 1;
    else if (child.taskId || status === 'submitted' || status === 'processing' || status === 'running') counts.processing += 1;
    else counts.pending += 1;
    return counts;
  }, { pending: 0, submitting: 0, processing: 0, succeeded: 0, failed: 0, unknown: 0 });
}

function batchStatus(children, counts = batchCounts(children)) {
  const active = counts.pending + counts.submitting + counts.processing;
  if (counts.submitting > 0) return 'submitting';
  if (active > 0) return 'processing';
  if (counts.unknown > 0) return 'attention_required';
  if (counts.succeeded === children.length) return 'completed';
  if (counts.succeeded > 0) return 'partial_success';
  return 'failed';
}

function aggregateBatchBilling(children) {
  const settledChildren = children.filter((child) => child.settled === true);
  const allSettled = children.length > 0 && settledChildren.length === children.length;
  const settledActualCostMicros = settledChildren.reduce((sum, child) => sum + (Number(child.actualCostMicros) || 0), 0);
  const providerCosts = children.map((child) => child.providerCostMicros);
  const providerCostMicros = providerCosts.every(Number.isSafeInteger)
    ? providerCosts.reduce((sum, value) => sum + value, 0)
    : null;
  return {
    pricingVersion: children[0]?.pricingVersion || null,
    billingPolicy: children[0]?.billingPolicy || null,
    estimatedCostMicros: children.reduce((sum, child) => sum + (Number(child.estimatedCostMicros) || 0), 0),
    minimumChargeMicros: children.reduce((sum, child) => sum + (Number(child.minimumChargeMicros) || 0), 0),
    providerCostMicros,
    actualCostMicros: allSettled ? settledActualCostMicros : null,
    settledActualCostMicros,
    chargedMicros: children.reduce((sum, child) => sum + (Number(child.chargedMicros) || 0), 0),
    settled: allSettled,
    settlementStatus: allSettled ? 'settled' : 'pending'
  };
}

function childDto(child) {
  return {
    index: Number.isSafeInteger(child.batchIndex) ? child.batchIndex : 0,
    status: child.status,
    taskId: child.taskId || '',
    task_id: child.taskId || '',
    imageUrl: child.imageUrls?.[0] || '',
    imageUrls: child.imageUrls || [],
    error: child.error || '',
    billing: getBillingSummary(child)
  };
}

function batchDto(input) {
  const children = sortBatchLogs(Array.isArray(input) ? input : []);
  const first = children[0] || {};
  const counts = batchCounts(children);
  const billing = aggregateBatchBilling(children);
  const latestBalanceChild = children.reduce((latest, child) => {
    if (!latest) return child;
    const latestTime = Date.parse(latest.balanceUpdatedAt || latest.createdAt || '');
    const childTime = Date.parse(child.balanceUpdatedAt || child.createdAt || '');
    if (childTime > latestTime) return child;
    if (childTime === latestTime && (Number(child.batchIndex) || 0) > (Number(latest.batchIndex) || 0)) return child;
    return latest;
  }, null);
  return {
    id: first.batchId || first.id || '',
    type: 'generation',
    kind: 'batch',
    batchId: first.batchId || first.id || '',
    batch_id: first.batchId || first.id || '',
    ...clientRequestFields(children),
    email: first.email,
    createdAt: first.createdAt || '',
    completedAt: children.every((child) => child.completedAt) ? children.map((child) => child.completedAt).sort().at(-1) : '',
    status: batchStatus(children, counts),
    model: first.model || '',
    prompt: first.prompt || '',
    referenceImageCount: first.referenceImageCount || 0,
    settings: { ...(first.settings || {}), n: Number(first.batchSize) || children.length || 1 },
    requestedCount: Number(first.batchSize) || children.length || 1,
    counts,
    children: children.map(childDto),
    imageUrls: children.flatMap((child) => child.imageUrls || []).filter(Boolean),
    aggregateBilling: billing,
    billing,
    estimatedCostMicros: billing.estimatedCostMicros,
    chargedMicros: billing.chargedMicros,
    actualCostMicros: billing.actualCostMicros,
    settledActualCostMicros: billing.settledActualCostMicros,
    settled: billing.settled,
    settlementStatus: billing.settlementStatus,
    balanceBeforeMicros: first.balanceBeforeMicros,
    balanceAfterMicros: latestBalanceChild?.balanceAfterMicros
  };
}

function taskDto(log) {
  if (log.submitResponse && typeof log.submitResponse === 'object') {
    return { ...log.submitResponse, kind: 'task', taskId: log.taskId || '', task_id: log.taskId || '', ...clientRequestFields(log), status: log.status, billing: getBillingSummary(log) };
  }
  return {
    kind: 'task',
    taskId: log.taskId || '',
    task_id: log.taskId || '',
    ...clientRequestFields(log),
    status: log.status,
    billing: getBillingSummary(log)
  };
}

function existingGenerationsByClientRequest(data, email, clientRequestId) {
  return data.spendLogs.filter((log) => log.type === 'generation' && log.email === email && (log.clientRequestId === clientRequestId || log.idempotencyKey === clientRequestId));
}

function existingGenerationByIdempotency(data, email, key) {
  return existingGenerationsByClientRequest(data, email, key)[0] || null;
}

function existingRequestResult(existing, requestHash) {
  if (!existing.length) return null;
  if (existing.some((log) => (log.requestHash || log.payloadHash) !== requestHash)) return { conflict: true };
  const batchId = existing.find((log) => log.batchId)?.batchId;
  return batchId ? { duplicate: true, batchId, logs: sortBatchLogs(existing.filter((log) => log.batchId === batchId)) } : { duplicate: true, log: existing[0] };
}

async function handleGeneration(req, res, config) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return;
  }

  const data = loadDataStore();
  const auth = requireSession(req, data);
  if (!auth.ok) {
    sendAuthError(res, auth);
    return;
  }
  const idempotency = getIdempotencyKeyInfo(req);
  if (idempotency.present && !idempotency.valid) {
    sendJson(res, 400, { error: { code: 'idempotency_key_invalid', message: 'Idempotency-Key 必须是 1–200 个字符且不能包含换行。' } });
    return;
  }
  const suppliedClientRequestId = idempotency.value;
  const clientRequestId = suppliedClientRequestId || createId('legacy_request');

  let payload;
  try {
    const body = await readRequestBody(req, GENERATION_BODY_LIMIT);
    payload = sanitizeGenerationPayload(safeParseJson(body), config);
  } catch (error) {
    sendJson(res, 400, { error: { message: error instanceof SyntaxError ? '请求 JSON 格式无效。' : (error.message || '生成参数无效。') } });
    return;
  }

  const isQuickBatch = payload.model === 'gpt-image-2' && payload.n > 1;
  if (isQuickBatch && !suppliedClientRequestId) {
    sendJson(res, 400, { error: { code: 'idempotency_key_required', message: '快速批量生成必须提供 Idempotency-Key。' } });
    return;
  }
  const requestHash = canonicalPayloadHash(payload);
  const existingBeforeGate = existingRequestResult(
    existingGenerationsByClientRequest(loadDataStore(), auth.email, clientRequestId),
    requestHash
  );
  if (existingBeforeGate?.conflict) {
    sendJson(res, 409, { error: { code: 'idempotency_conflict', message: 'Idempotency-Key 已用于不同的请求参数。' } });
    return;
  }
  if (existingBeforeGate?.duplicate) {
    sendJson(res, 200, existingBeforeGate.batchId ? batchDto(existingBeforeGate.logs) : taskDto(existingBeforeGate.log));
    return;
  }
  const quickBatchEnabled = config.quickBatchEnabled ?? QUICK_BATCH_ENABLED;
  if (isQuickBatch && !quickBatchEnabled) {
    sendJson(res, 400, { error: { message: '快速批量生成功能未启用。' } });
    return;
  }
  const cost = estimateGenerationCostMicros(payload);
  const childCost = isQuickBatch ? estimateGenerationCostMicros({ ...payload, n: 1 }) : null;
  if (!cost.ok || (childCost && !childCost.ok)) {
    sendJson(res, 400, { error: { message: cost.error || childCost.error } });
    return;
  }

  const batchId = createId('batch');
  const singleId = createId('usage');
  const precharge = await withDataStoreMutation((latestData) => {
    const existing = existingRequestResult(existingGenerationsByClientRequest(latestData, auth.email, clientRequestId), requestHash);
    if (existing) return existing;

    const user = latestData.users[auth.email];
    const balanceBefore = Number(user?.balanceMicros) || 0;
    if (!user?.active) return { ok: false, status: 403, message: '账号不可用。' };
    if (balanceBefore < cost.totalMicros) {
      return {
        ok: false,
        status: 402,
        message: `余额不足：当前 ${formatMoneyMicros(balanceBefore)}，本次预计 ${formatMoneyMicros(cost.totalMicros)}。请联系管理员充值。`
      };
    }

    const timestamp = nowIso();
    user.balanceMicros = balanceBefore - cost.totalMicros;
    user.updatedAt = timestamp;
    if (isQuickBatch) {
      const logs = createBatchLogs({ batchId, email: auth.email, payload, childCost, balanceBefore, clientRequestId, requestHash, timestamp });
      latestData.spendLogs.push(...logs);
      return { ok: true, batchId, logs };
    }
    const log = createSingleLog({
      id: singleId,
      email: auth.email,
      payload,
      cost,
      balanceBefore,
      balanceAfter: user.balanceMicros,
      clientRequestId,
      requestHash,
      timestamp
    });
    latestData.spendLogs.push(log);
    return { ok: true, log };
  });

  if (precharge.conflict) {
    sendJson(res, 409, { error: { code: 'idempotency_conflict', message: 'Idempotency-Key 已用于不同的请求参数。' } });
    return;
  }
  if (precharge.duplicate) {
    sendJson(res, 200, precharge.batchId ? batchDto(precharge.logs) : taskDto(precharge.log));
    return;
  }
  if (!precharge.ok) {
    sendJson(res, precharge.status, { error: { message: precharge.message } });
    return;
  }

  const headers = { ...getApiHeaders(config), 'Content-Type': 'application/json' };
  if (isQuickBatch) {
    const upstreamPayload = toApiMarketGenerationPayload({ ...payload, n: 1 });
    const submissions = await Promise.allSettled(precharge.logs.map(() =>
      requestApiMarket('POST', '/v1/images/generations', headers, JSON.stringify(upstreamPayload), config)
    ));
    const logs = await withDataStoreMutation((latestData) => {
      const latestLogs = getBatchLogs(latestData, precharge.batchId);
      submissions.forEach((result, index) => {
        const child = latestLogs[index];
        if (!child || child.status !== 'submitting') return;
        if (result.status === 'rejected') {
          markSubmissionUnknown(child, sanitizeErrorMessage(result.reason));
          return;
        }
        const upstream = result.value;
        const json = parseJsonText(upstream.text);
        const taskId = json ? extractTaskId(json) : '';
        if (upstream.status < 200 || upstream.status >= 300) {
          const message = json?.error?.message || json?.message || `提交失败：HTTP ${upstream.status}`;
          if (isTransientSubmitStatus(upstream.status)) markSubmissionUnknown(child, message, upstream.status);
          else refundSubmittingLog(latestData, child.id, auth.email, message, upstream.status);
        } else if (!taskId) {
          markSubmissionUnknown(child, '提交返回成功状态但缺少 task_id；不会自动重试或退款。', upstream.status);
        } else {
          child.status = 'submitted';
          child.taskId = taskId;
          child.upstreamSubmitStatus = upstream.status;
          child.submitResponse = json;
        }
      });
      return getBatchLogs(latestData, precharge.batchId).map((log) => ({ ...log }));
    });
    sendJson(res, 202, batchDto(logs));
    return;
  }

  const upstreamPayload = toApiMarketGenerationPayload(payload);
  let upstream;
  try {
    upstream = await requestApiMarket('POST', '/v1/images/generations', headers, JSON.stringify(upstreamPayload), config);
  } catch (error) {
    const log = await withDataStoreMutation((latestData) => {
      const latestLog = latestData.spendLogs.find((entry) => entry.id === precharge.log.id);
      markSubmissionUnknown(latestLog, sanitizeErrorMessage(error));
      return latestLog;
    });
    sendJson(res, 202, taskDto(log));
    return;
  }

  const submitJson = parseJsonText(upstream.text);
  const taskId = submitJson ? extractTaskId(submitJson) : '';
  if (upstream.status < 200 || upstream.status >= 300) {
    const message = submitJson?.error?.message || submitJson?.message || `提交失败：HTTP ${upstream.status}`;
    if (isTransientSubmitStatus(upstream.status)) {
      const log = await withDataStoreMutation((latestData) => {
        const latestLog = latestData.spendLogs.find((entry) => entry.id === precharge.log.id);
        markSubmissionUnknown(latestLog, message, upstream.status);
        return latestLog;
      });
      sendJson(res, 202, taskDto(log));
      return;
    }
    await withDataStoreMutation((latestData) => {
      refundSubmittingLog(latestData, precharge.log.id, auth.email, message, upstream.status);
    });
    await forwardApiMarketResponse(upstream, res);
    return;
  }
  if (!taskId) {
    const log = await withDataStoreMutation((latestData) => {
      const latestLog = latestData.spendLogs.find((entry) => entry.id === precharge.log.id);
      markSubmissionUnknown(latestLog, '提交返回成功状态但缺少 task_id；不会自动重试或退款。', upstream.status);
      latestLog.submitResponse = submitJson;
      return latestLog;
    });
    sendJson(res, 202, taskDto(log));
    return;
  }

  const log = await withDataStoreMutation((latestData) => {
    const latestLog = latestData.spendLogs.find((entry) => entry.id === precharge.log.id);
    if (latestLog?.status === 'submitting') {
      latestLog.status = 'submitted';
      latestLog.taskId = taskId;
      latestLog.upstreamSubmitStatus = upstream.status;
      latestLog.submitResponse = submitJson;
    }
    return latestLog;
  });
  await forwardApiMarketResponse(upstream, res, { kind: 'task', taskId, task_id: taskId, ...clientRequestFields(log), billing: getBillingSummary(log) });
}

async function handleTask(req, res, pathname, config) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return;
  }
  const taskIdPart = pathname.slice(`${API_PREFIX}/v1/tasks/`.length);
  if (!taskIdPart) {
    sendJson(res, 400, { error: { message: '缺少 task_id。' } });
    return;
  }
  const data = loadDataStore();
  const auth = requireSession(req, data);
  if (!auth.ok) {
    sendAuthError(res, auth);
    return;
  }
  const decodedTaskId = decodePathPart(taskIdPart);
  const location = findTaskLocation(data, decodedTaskId);
  if (!location) {
    sendJson(res, 404, { error: { message: '任务不存在。' } });
    return;
  }
  if (!auth.user.isAdmin && location.log.email !== auth.email) {
    sendJson(res, 403, { error: { message: '不能查询其他用户的任务。' } });
    return;
  }
  const nextRefreshAt = Date.parse(location.log.nextRefreshAt || '');
  if (Number.isFinite(nextRefreshAt) && nextRefreshAt > Date.now()) {
    const retrySeconds = Math.max(1, Math.ceil((nextRefreshAt - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retrySeconds));
    sendJson(res, 429, { error: { message: '状态查询正在退避，请稍后重试。' } });
    return;
  }

  let upstream;
  try {
    upstream = await requestTaskDeduped(decodedTaskId, config);
  } catch (error) {
    await withDataStoreMutation((latestData) => {
      const latestLog = findSpendLogByTaskId(latestData, decodedTaskId);
      if (!latestLog) return;
      scheduleRefreshBackoff(latestLog, sanitizeErrorMessage(error));
    });
    throw error;
  }
  const taskJson = parseJsonText(upstream.text);
  if (upstream.status < 200 || upstream.status >= 300) {
    await withDataStoreMutation((latestData) => {
      const latestLog = findSpendLogByTaskId(latestData, decodedTaskId);
      if (latestLog) scheduleRefreshBackoff(latestLog, `状态查询失败：HTTP ${upstream.status}`, upstream.retryAfter);
    });
  }
  if (taskJson && upstream.status >= 200 && upstream.status < 300) {
    let latestLog = await withDataStoreMutation((latestData) => {
      const latestLog = findSpendLogByTaskId(latestData, decodedTaskId);
      if (!latestLog) return null;
      applyTaskJsonToLog(latestData, latestLog, taskJson);
      if (needsTerminalSettlementBackoff(latestLog)) {
        scheduleRefreshBackoff(latestLog, '任务已终止，但供应商成本缺失或无效，稍后重试。');
      } else {
        delete latestLog.nextRefreshAt;
        delete latestLog.lastRefreshError;
        latestLog.refreshAttempt = 0;
      }
      return { ...latestLog };
    });
    const remoteUrls = extractImageUrls(taskJson);
    if (latestLog?.status === 'completed' && remoteUrls.length && !hasCompleteImageArchive(latestLog, remoteUrls)) {
      const archived = await archiveImagesOutsideMutation(latestLog, remoteUrls);
      const mergeResult = await withDataStoreMutation((latestData) => {
        const currentLog = findSpendLogByTaskId(latestData, decodedTaskId);
        if (!currentLog) return { log: null, merged: false };
        return { log: { ...currentLog }, merged: mergeArchivedImages(currentLog, archived) };
      });
      if (!mergeResult.merged) deleteStoredImageFiles(archived);
      latestLog = mergeResult.merged ? { ...mergeResult.log, ...archived } : mergeResult.log;
    }
    if (latestLog) {
      replaceTaskJsonImageUrls(taskJson, latestLog.imageUrls || []);
      taskJson.billing = getBillingSummary(latestLog);
    }
  }
  if (taskJson) {
    if (upstream.retryAfter) res.setHeader('Retry-After', upstream.retryAfter);
    send(res, upstream.status, JSON.stringify(taskJson), upstream.contentType);
    return;
  }
  await forwardApiMarketResponse(upstream, res);
}

async function handleBatch(req, res, pathname, config) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: { message: 'Method Not Allowed' } });
    return;
  }
  const batchId = decodePathPart(pathname.slice(`${API_PREFIX}/v1/batches/`.length));
  const data = loadDataStore();
  const auth = requireSession(req, data);
  if (!auth.ok) {
    sendAuthError(res, auth);
    return;
  }
  await withDataStoreMutation((latestData) => markStaleSubmittingUnknown(latestData));
  const refreshedStore = loadDataStore();
  const logs = getBatchLogs(refreshedStore, batchId);
  if (!logs.length) {
    sendJson(res, 404, { error: { message: '批次不存在。' } });
    return;
  }
  if (!auth.user.isAdmin && logs[0].email !== auth.email) {
    sendJson(res, 403, { error: { message: '不能查询其他用户的批次。' } });
    return;
  }
  await refreshLogsFromUpstream(refreshedStore, logs, config, logs.length);
  sendJson(res, 200, batchDto(getBatchLogs(loadDataStore(), batchId)));
}

async function proxyApiMarket(req, res, pathname) {
  const config = loadApiMarketConfig();
  if (pathname.startsWith(`${API_PREFIX}/v1/batches/`)) {
    await handleBatch(req, res, pathname, config);
    return;
  }
  if (!config.apiKey.trim()) {
    sendJson(res, 500, { error: { message: '请先配置 API_MARKET_API_KEY / APIMARKET_API_KEY，或在 config.local.js 中配置 API Market Key。' } });
    return;
  }
  if (pathname === `${API_PREFIX}/v1/images/generations`) {
    await handleGeneration(req, res, config);
    return;
  }
  if (pathname.startsWith(`${API_PREFIX}/v1/tasks/`)) {
    await handleTask(req, res, pathname, config);
    return;
  }
  sendJson(res, 404, { error: { message: '不支持的 API Market API 路由。' } });
}

module.exports = {
  forwardApiMarketResponse,
  getBillingSummary,
  pricingFields,
  createSingleLog,
  createBatchLogs,
  refundSubmittingLog,
  markSubmissionUnknown,
  isTransientSubmitStatus,
  clientRequestFields,
  sortBatchLogs,
  getBatchLogs,
  batchCounts,
  batchStatus,
  aggregateBatchBilling,
  childDto,
  batchDto,
  taskDto,
  existingGenerationsByClientRequest,
  existingGenerationByIdempotency,
  handleGeneration,
  handleTask,
  handleBatch,
  proxyApiMarket
};

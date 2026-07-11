(() => {
  const ns = window.ImageGen = window.ImageGen || {};

  ns.updatePromptStats = () => {
    ns.els.promptStats.textContent = `${ns.els.prompt.value.trim().length} 字`;
  };

  ns.isOfficialModel = () => ns.els.model.value === 'gpt-image-2-official';
  ns.isQuickBatchEnabled = () => ns.state.publicConfig?.features?.quickBatchEnabled === true;
  ns.getImageCount = () => {
    const count = Math.max(1, Math.min(4, Number(ns.els.imageCount.value) || 1));
    return ns.isOfficialModel() || ns.isQuickBatchEnabled() ? count : 1;
  };
  ns.getPricingConfig = () => ns.state.publicConfig?.pricing || {};
  ns.getPixelSize = () => ns.getPricingConfig().sizeResolutionMap?.[ns.els.aspectRatio.value]?.[ns.els.resolution.value] || '';
  ns.normalizePricingModel = (model) => model === 'gpt-image-2-ext' ? 'gpt-image-2' : String(model || '').trim();
  ns.getPricingProfile = () => {
    const model = ns.normalizePricingModel(ns.els.model.value);
    const profile = ns.getPricingConfig().modelProfiles?.[model];
    if (!profile) return null;
    const totalMultiplier = Number(profile.totalMultiplier);
    const minimumPerImageMicros = Number(profile.minimumPerImageMicros);
    if (!Number.isFinite(totalMultiplier) || totalMultiplier <= 0 || !Number.isSafeInteger(minimumPerImageMicros) || minimumPerImageMicros <= 0) return null;
    return { model, totalMultiplier, minimumPerImageMicros };
  };
  ns.maxPriceValue = (map) => {
    const values = Object.values(map || {}).flatMap((value) => typeof value === 'object' && value ? Object.values(value) : [value]).map(Number).filter(Number.isFinite);
    return values.length ? Math.max(...values) : 0;
  };
  ns.formatAdaptiveMicros = (micros) => {
    const value = Number(micros) || 0;
    const microsPerUnit = Number(ns.getPricingConfig().microsPerUnit) || 1000000;
    return `¥${(value / microsPerUnit).toFixed(Math.abs(value) < microsPerUnit ? 3 : 2)}`;
  };
  ns.formatMicros = ns.formatAdaptiveMicros;

  ns.estimatePrice = () => {
    const pricing = ns.getPricingConfig();
    const profile = ns.getPricingProfile();
    if (!profile) return { ok: false, error: `模型 ${ns.els.model.value || '未知'} 缺少有效计价策略，暂时无法生成。` };

    const n = ns.getImageCount();
    const priceMap = ns.isOfficialModel() ? pricing.officialPriceMap : pricing.simplePriceMap;
    const pixelSize = ns.isOfficialModel() ? ns.getPixelSize() : '';
    const exact = ns.isOfficialModel() ? priceMap?.[pixelSize]?.[ns.els.quality.value] : priceMap?.[ns.els.resolution.value];
    const fallback = ns.maxPriceValue(priceMap);
    const providerUnitUsd = Number(exact ?? fallback);
    const microsPerUnit = Number(pricing.microsPerUnit) || 1000000;
    const convertedUnitMicros = Math.round(providerUnitUsd * profile.totalMultiplier * microsPerUnit);
    const unitMicros = Math.max(convertedUnitMicros, profile.minimumPerImageMicros);
    const totalMicros = unitMicros * n;
    const isMaximum = exact === undefined;
    if (![convertedUnitMicros, unitMicros, totalMicros].every(Number.isSafeInteger)) {
      return { ok: false, error: '计价结果超出安全整数范围，暂时无法生成。' };
    }
    return {
      ok: true,
      model: profile.model,
      totalMultiplier: profile.totalMultiplier,
      minimumPerImageMicros: profile.minimumPerImageMicros,
      convertedUnitMicros,
      unitMicros,
      totalMicros,
      pixelSize,
      precise: !isMaximum,
      isMaximum,
      detail: ns.isOfficialModel()
        ? `${isMaximum ? (pixelSize || ns.els.aspectRatio.value) : pixelSize} · ${ns.els.quality.value} · ${n} 张`
        : `快速低价版 · ${isMaximum ? '最高预扣' : ns.els.resolution.value} · ${n} 张`
    };
  };

  ns.updateAdvancedSummary = () => {
    if (!ns.els.advancedSummary) return;
    const modelText = ns.isOfficialModel() ? '官方完整版' : '快速低价版';
    const parts = [modelText, ns.els.aspectRatio.value, ns.els.resolution.value, `${ns.getImageCount()} 张`];
    if (ns.isOfficialModel()) parts.splice(3, 0, ns.els.quality.value, ns.els.outputFormat.value);
    ns.els.advancedSummary.textContent = parts.filter(Boolean).join(' · ');
  };

  ns.updatePriceEstimate = () => {
    const estimate = ns.estimatePrice();
    const warnings = [];

    if (!estimate.ok) {
      ns.els.priceTotal.textContent = '--';
      ns.els.priceDetail.textContent = `价格配置异常：${estimate.error}`;
      ns.els.priceBalanceText.textContent = '';
      ns.els.priceWarning.textContent = '';
      ns.els.priceWarning.classList.add('hidden');
      ns.els.runBtn.disabled = true;
      ns.updateAdvancedSummary();
      return;
    }

    const n = ns.getImageCount();
    ns.els.runBtn.disabled = ns.state.isBusy;
    if (estimate.isMaximum) {
      ns.els.priceTotal.textContent = `最高 ${ns.formatMicros(estimate.totalMicros)}`;
      ns.els.priceDetail.textContent = `当前组合没有精确价格表，将按最高单张 ${ns.formatMicros(estimate.unitMicros)} × ${n} 张预扣。`;
      warnings.push(`本次任务最高可达 ${ns.formatMicros(estimate.totalMicros)}。`);
    } else {
      ns.els.priceTotal.textContent = ns.formatMicros(estimate.totalMicros);
      ns.els.priceDetail.textContent = !ns.isOfficialModel() && n > 1
        ? `${estimate.detail}。总预扣 ${ns.formatMicros(estimate.totalMicros)}；${n} 个子任务分别应用每张最低 ${ns.formatMicros(estimate.minimumPerImageMicros)}。`
        : `${estimate.detail}。建议先用低价配置试图，满意后再提高质量。`;
    }

    if (ns.els.priceBalanceText) {
      const balanceMicros = ns.state.session?.user?.balanceMicros;
      if (balanceMicros !== undefined && balanceMicros !== null) {
        const remainingMicros = Number(balanceMicros) - estimate.totalMicros;
        ns.els.priceBalanceText.textContent = `当前余额 ${ns.formatMicros(balanceMicros)}，预计生成后剩余 ${ns.formatMicros(Math.max(0, remainingMicros))}。`;
        if (remainingMicros < 0) warnings.push('当前余额可能不足，请联系管理员充值。');
      } else {
        ns.els.priceBalanceText.textContent = '';
      }
    }

    if (ns.isOfficialModel() && ns.els.quality.value === 'high') warnings.push('当前为高清 high，价格明显高于 low。建议先用 low 试图。');
    if (ns.isOfficialModel() && ns.els.resolution.value === '4k') warnings.push('4K 生成更慢且成本更高。');
    if (n > 1 && ns.isOfficialModel()) warnings.push(`官方模式将一次生成 ${n} 张，费用按张数累加。`);
    if (n > 1 && !ns.isOfficialModel()) warnings.push(`${n} 张会拆成 ${n} 个单图任务同时提交；每个子任务最低收费 ${ns.formatMicros(estimate.minimumPerImageMicros)}。`);

    ns.els.priceWarning.textContent = warnings.join(' ');
    ns.els.priceWarning.classList.toggle('hidden', !warnings.length);
    ns.updateAdvancedSummary();
  };

  ns.updateModelUi = () => {
    const official = ns.isOfficialModel();
    const quickBatchEnabled = ns.isQuickBatchEnabled();
    if (!official && !quickBatchEnabled) ns.els.imageCount.value = '1';
    ns.els.imageCount.disabled = ns.state.isBusy || (!official && !quickBatchEnabled);
    ns.els.modelNote.textContent = official
      ? (ns.constants.MODEL_NOTES[ns.els.model.value] || '')
      : '';
    ns.els.modelNote.classList.toggle('hidden', !official);
    ns.els.officialSettings.classList.toggle('hidden', !official);
    ns.els.compressionField.classList.toggle('hidden', !official || ns.els.outputFormat.value === 'png');
    ns.els.compressionValue.textContent = ns.els.outputCompression.value;
    ns.updatePriceEstimate();
  };
})();

(() => {
  const ns = window.ImageGen = window.ImageGen || {};

  // ---- 标注式编辑：常量 ----
  // 6 个预设标注色（默认绿），颜色只用于画笔/线框描边，不落 DOM 直传，安全。
  ns.EDIT_COLORS = [
    { name: '绿', value: '#22c55e' },
    { name: '红', value: '#ef4444' },
    { name: '蓝', value: '#3b82f6' },
    { name: '黄', value: '#eab308' },
    { name: '白', value: '#ffffff' },
    { name: '黑', value: '#111827' }
  ];
  // 粗细三档：相对原图短边的比例（0.8% / 1.6% / 3%），换算成原图绝对像素后存入笔画，
  // 保证 4K 大图上也看得见，缩放显示与合成导出都从同一绝对值等比换算。
  ns.EDIT_WIDTH_TIERS = [
    { label: '细', ratio: 0.008 },
    { label: '中', ratio: 0.016 },
    { label: '粗', ratio: 0.03 }
  ];
  ns.EDIT_DEFAULT_WIDTH_TIER = 1;
  ns.EDIT_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
  // 合成图解码后字节上限：后端单张参考图硬限 5MB，留安全余量取 4.8MB。
  // 上游入口 api.apib.ai 2026-07-17 实测 32MB 请求体放行，不再是瓶颈
  // （旧裸域名 apib.ai 的 1MB 限制已绕开，680KB 压缩预算随之废止）。
  ns.EDIT_MAX_COMPOSED_BYTES = Math.round(4.8 * 1024 * 1024);
  // 有损编码质量阶梯：先降质量、再缩尺寸。照片型合成图 WebP/JPEG 一两百 KB 即可达标，
  // 通常第一档就能通过。
  ns.EDIT_QUALITY_LADDER = [0.9, 0.8, 0.7];
  ns.EDIT_MIN_DOWNSCALE_LONG_SIDE = 1024;
  ns.EDIT_DOWNSCALE_FACTOR = 0.8;
  ns.EDIT_DEFAULT_ANNOTATION = '请严格按照图中标注进行修改；最终成图不得保留任何标注笔迹、线框或圈选痕迹；未标注区域尽量与原图保持一致。';
  // 编辑可选的显式画面比例（与创作页一致，但不含 auto——"跟随原图"会解析成其中之一，
  // 显式传给上游比 auto 更确定，计价也能查到精确价而非最高预扣）。
  ns.EDIT_RATIO_CHOICES = ['1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '3:1', '1:3', '21:9', '9:21'];

  // ---- 纯函数（可单测，无 DOM 依赖）----

  // 给定原图宽高，从 EDIT_RATIO_CHOICES 里选最接近的比例（按对数距离，横竖对称）。
  // 尺寸缺失/非法时退 1:1。
  ns.nearestAspectRatio = (width, height) => {
    const w = Number(width);
    const h = Number(height);
    if (!(w > 0) || !(h > 0)) return '1:1';
    const target = Math.log(w / h);
    let best = '1:1';
    let bestDiff = Infinity;
    for (const choice of ns.EDIT_RATIO_CHOICES) {
      const [rw, rh] = choice.split(':').map(Number);
      const diff = Math.abs(Math.log(rw / rh) - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = choice;
      }
    }
    return best;
  };

  // 图片可编辑性：仅同源已归档 /api/stored-images/ 或本地上传的 data:image/ 允许（不会污染
  // canvas，能读回像素）；跨域远程图、javascript: 等一律不可编辑。
  ns.isEditableImageUrl = (url) => {
    const text = String(url ?? '').trim();
    if (!text) return false;
    if (/^data:image\//i.test(text)) return true;
    if (text.startsWith('/api/stored-images/')) return true;
    try {
      const origin = (typeof window !== 'undefined' && window.location && window.location.origin) || '';
      const parsed = new URL(text, (typeof window !== 'undefined' && window.location && window.location.href) || 'http://localhost/');
      return Boolean(origin) && parsed.origin === origin && parsed.pathname.startsWith('/api/stored-images/');
    } catch {
      return false;
    }
  };

  // 坐标缩放：等比换算一个点（笔画一律存原图像素坐标系，显示层临时换算）。
  ns.scaleEditPoint = (point, from, to) => ({
    x: from && from.width ? (Number(point?.x) || 0) * (to.width / from.width) : 0,
    y: from && from.height ? (Number(point?.y) || 0) * (to.height / from.height) : 0
  });
  ns.toNaturalPoint = (point, display, natural) => ns.scaleEditPoint(point, display, natural);
  ns.toDisplayPoint = (point, natural, display) => ns.scaleEditPoint(point, natural, display);

  // 某粗细档在给定原图短边下的绝对像素宽度（至少 1px）。
  ns.strokeWidthForTier = (tier, naturalShortSide) => {
    const spec = ns.EDIT_WIDTH_TIERS[tier] || ns.EDIT_WIDTH_TIERS[ns.EDIT_DEFAULT_WIDTH_TIER];
    return Math.max(1, Math.round((Number(naturalShortSide) || 0) * spec.ratio));
  };

  // 估算 dataURL 解码后的字节数：base64 主体长度 × 3/4，再减去 padding。够安全用于卡上限。
  ns.estimateDataUrlBytes = (dataUrl) => {
    const text = String(dataUrl || '');
    const comma = text.indexOf(',');
    const base64 = comma >= 0 ? text.slice(comma + 1) : text;
    const len = base64.length;
    if (!len) return 0;
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((len * 3) / 4) - padding);
  };

  // 导出降级决策链的"一步"（纯函数）：给定当前质量档、尺寸与估算字节，返回下一步动作。
  //   qualityIndex: EDIT_QUALITY_LADDER 的下标
  //   返回 { action:'accept' } | { action:'encode', qualityIndex, width, height } | { action:'fail' }
  // 链路：超限先降质量档（尺寸不变），质量档用尽后长边 ×factor 逐级缩放（保持最低质量档），
  //       缩到长边 minLongSide 仍超限则 fail。
  ns.planComposeStep = ({
    qualityIndex,
    width,
    height,
    bytes,
    limit = ns.EDIT_MAX_COMPOSED_BYTES,
    minLongSide = ns.EDIT_MIN_DOWNSCALE_LONG_SIDE,
    factor = ns.EDIT_DOWNSCALE_FACTOR,
    ladder = ns.EDIT_QUALITY_LADDER
  }) => {
    if (bytes <= limit) return { action: 'accept', qualityIndex, width, height };
    if (qualityIndex < ladder.length - 1) {
      return { action: 'encode', qualityIndex: qualityIndex + 1, width, height };
    }
    // 质量档已到底仍超限：尝试缩小长边（不低于 minLongSide）。
    const longSide = Math.max(width, height);
    if (longSide <= minLongSide) return { action: 'fail' };
    const nextLong = Math.max(minLongSide, Math.round(longSide * factor));
    const scale = nextLong / longSide;
    return {
      action: 'encode',
      qualityIndex,
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    };
  };

  // 组装最终 prompt：用户输入 +（开关开时）\n附加话术；两段任一为空则不拼接空行。
  ns.buildEditPrompt = (userPrompt, annotation, appendEnabled) => {
    const base = String(userPrompt || '').trim();
    if (!appendEnabled) return base;
    const note = String(annotation || '').trim();
    if (!note) return base;
    return base ? `${base}\n${note}` : note;
  };
  // prompt 校验：非空 + 不超过 8000 字符（前端先拦截，避免提交后端再被拒）。
  ns.validateEditPrompt = (prompt) => {
    const text = String(prompt || '');
    if (!text.trim()) return { ok: false, error: '请先输入修改说明。' };
    if (text.length > 8000) return { ok: false, error: `提示词过长（${text.length}/8000 字符），请精简后再提交。` };
    return { ok: true, prompt: text };
  };

  // ---- 状态 ----
  ns.createEditState = () => ({
    sourceUrl: '',
    sourceKind: '',
    naturalWidth: 0,
    naturalHeight: 0,
    displayWidth: 0,
    displayHeight: 0,
    image: null,
    strokes: [],
    tool: 'brush',
    color: ns.EDIT_COLORS[0].value,
    widthTier: ns.EDIT_DEFAULT_WIDTH_TIER
  });
  ns.resetEditState = () => {
    ns.state.edit = ns.createEditState();
  };
  ns.editHasImage = () => Boolean(ns.state.edit && ns.state.edit.image && ns.state.edit.naturalWidth);

  ns.setEditStatus = (message, type = '') => {
    if (ns.els?.editStatus) ns.setStatusClass(ns.els.editStatus, 'status', message, type);
  };
  ns.setEditEmptyStatus = (message, type = '') => {
    if (ns.els?.editEmptyStatus) ns.setStatusClass(ns.els.editEmptyStatus, 'status', message, type);
  };

  ns.editAnnotationStorageKey = () => ns.userStorageKey?.('imageGenEditAnnotation') || '';
  ns.loadEditAnnotation = () => {
    const key = ns.editAnnotationStorageKey();
    let saved = '';
    try { saved = (key && window.localStorage.getItem(key)) || ''; } catch { saved = ''; }
    if (ns.els?.editAnnotationText) ns.els.editAnnotationText.value = saved || ns.EDIT_DEFAULT_ANNOTATION;
  };
  ns.saveEditAnnotation = () => {
    const key = ns.editAnnotationStorageKey();
    if (!key || !ns.els?.editAnnotationText) return;
    try { window.localStorage.setItem(key, ns.els.editAnnotationText.value); } catch {}
  };

  ns.updateEditPromptStats = () => {
    if (!ns.els?.editPromptStats) return;
    const composed = ns.buildEditPrompt(ns.els.editPrompt.value, ns.els.editAnnotationText.value, ns.els.editAppendToggle.checked);
    const length = composed.length;
    ns.els.editPromptStats.textContent = length > 8000 ? `${length} 字（超出 8000）` : `${length} 字`;
  };

  // 编辑面板的模型下拉与全局模型保持一致（模型渠道跟随全局当前选择）。
  ns.syncEditModelFromGlobal = () => {
    if (ns.els?.editModel && ns.els?.model) ns.setSelectValue(ns.els.editModel, ns.els.model.value);
  };
  ns.syncGlobalModelFromEdit = () => {
    if (!ns.els?.editModel || !ns.els?.model) return;
    ns.setSelectValue(ns.els.model, ns.els.editModel.value);
    ns.updateModelUi?.();
  };

  // 编辑参数说明行：实时显示"跟随原图"解析出的比例、清晰度与预计单价，
  // 让提交确认框弹出前用户就能看到实际生效的参数。
  ns.updateEditParamsNote = () => {
    if (!ns.els?.editParamsNote) return;
    const raw = ns.els?.editAspectRatio?.value || 'follow';
    const resolution = ns.getEditResolution?.() || '1k';
    const hasImage = ns.editHasImage();
    let ratioText;
    let size = raw;
    if (raw === 'follow') {
      if (hasImage) {
        size = ns.resolveEditAspectRatio();
        ratioText = `跟随原图 → ${size}`;
      } else {
        ratioText = '跟随原图（载入图片后按原图就近取比例）';
        size = '';
      }
    } else {
      ratioText = raw;
    }
    const parts = [ratioText, resolution];
    if (size && typeof ns.estimatePrice === 'function') {
      const estimate = ns.estimatePrice({ size, resolution, n: 1 });
      if (estimate.ok) {
        parts.push(estimate.isMaximum
          ? `最高预扣 ${ns.formatMicros(estimate.unitMicros)}/张`
          : `预计 ${ns.formatMicros(estimate.unitMicros)}/张`);
      }
    }
    ns.els.editParamsNote.textContent = parts.filter(Boolean).join(' · ');
  };

  // 依据 busy/pending 锁定编辑面板控件（与主生成共用 busy 锁，禁止并发两个任务）。
  ns.updateEditControls = () => {
    const locked = Boolean(ns.state.isBusy || ns.hasPendingGeneration?.());
    const hasImage = ns.editHasImage();
    if (ns.els?.editSubmitBtn) {
      ns.els.editSubmitBtn.disabled = locked || !hasImage;
      ns.els.editSubmitBtn.textContent = locked ? '生成任务进行中...' : '生成修改图';
    }
    if (ns.els?.editUploadBtn) ns.els.editUploadBtn.disabled = locked;
    if (ns.els?.editChangeImageBtn) ns.els.editChangeImageBtn.disabled = locked;
    if (ns.els?.editUndoBtn) ns.els.editUndoBtn.disabled = locked || !ns.state.edit?.strokes?.length;
    if (ns.els?.editClearBtn) ns.els.editClearBtn.disabled = locked || !ns.state.edit?.strokes?.length;
  };

  // ---- 载入图片 ----
  // 从一个可编辑 URL（同源 /api/stored-images/ 或 data:image/）载入编辑器并切到编辑 Tab。
  ns.startEditFromUrl = (url, kind = 'stored') => {
    if (!ns.isEditableImageUrl(url)) {
      ns.setStatus('该图未归档或跨域，暂不可编辑。', 'error');
      return;
    }
    ns.gotoEditView();
    ns.loadEditImage(url, kind);
  };
  ns.gotoEditView = () => {
    try { window.location.hash = '#edit'; } catch {}
  };

  ns.loadEditImage = (url, kind) => {
    if (!ns.els?.editBaseCanvas) return;
    ns.setEditStatus('正在载入图片...', 'loading');
    ns.setEditEmptyStatus('正在载入图片...', 'loading');
    const image = new Image();
    // 同源归档图与 data URL 都不需要 crossOrigin；设置反而可能触发 CORS 失败。
    image.onload = () => {
      const edit = ns.createEditState();
      edit.sourceUrl = url;
      edit.sourceKind = kind;
      edit.naturalWidth = image.naturalWidth || image.width;
      edit.naturalHeight = image.naturalHeight || image.height;
      edit.image = image;
      if (!edit.naturalWidth || !edit.naturalHeight) {
        ns.setEditEmptyStatus('图片尺寸异常，无法编辑。', 'error');
        return;
      }
      ns.state.edit = edit;
      ns.renderEditor();
      ns.updateEditParamsNote();
      ns.setEditStatus('已载入图片，选好工具即可在图上标注。', 'ok');
      ns.setEditEmptyStatus('');
    };
    image.onerror = () => {
      ns.setEditEmptyStatus('图片载入失败，可能未归档或网络中断。', 'error');
      ns.setEditStatus('图片载入失败。', 'error');
    };
    image.src = url;
  };

  // 本地上传：限 image/*、≤20MB，经 FileReader 转 dataURL 载入（无污染）。
  ns.handleEditUpload = () => {
    const input = ns.els?.editUploadInput;
    const file = input?.files?.[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      ns.setEditEmptyStatus('仅支持图片文件（image/*）。', 'error');
      input.value = '';
      return;
    }
    if (file.size > ns.EDIT_MAX_UPLOAD_BYTES) {
      ns.setEditEmptyStatus(`图片过大，单张不能超过 ${Math.round(ns.EDIT_MAX_UPLOAD_BYTES / 1024 / 1024)}MB。`, 'error');
      input.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      input.value = '';
      ns.loadEditImage(String(reader.result || ''), 'upload');
    };
    reader.onerror = () => {
      input.value = '';
      ns.setEditEmptyStatus('图片读取失败，请重试。', 'error');
    };
    reader.readAsDataURL(file);
  };

  // ---- 面板渲染 ----
  ns.renderEditor = () => {
    const hasImage = ns.editHasImage();
    ns.els?.editEmptyState?.classList.toggle('hidden', hasImage);
    ns.els?.editWorkspace?.classList.toggle('hidden', !hasImage);
    ns.els?.editChangeImageBtn?.classList.toggle('hidden', !hasImage);
    if (hasImage) {
      if (ns.els?.editSourceNote) {
        ns.els.editSourceNote.textContent = `原图 ${ns.state.edit.naturalWidth}×${ns.state.edit.naturalHeight} · ${ns.state.edit.sourceKind === 'upload' ? '本地上传' : '归档作品'}`;
      }
      ns.renderEditToolbarState?.();
      ns.sizeEditCanvases?.();
    }
    ns.updateEditControls();
  };

  // ---- 合成导出 ----
  // 按原图分辨率合成"原图 + 标注笔迹"，一律走有损编码（WebP，编码不支持时退 JPEG），
  // 套用"降质量→缩尺寸"决策链（纯函数 planComposeStep），返回 { dataUrl, width, height }；
  // 到 1024 长边、最低质量档仍超限则抛错。上限对齐后端单张参考图 5MB 硬限，见 EDIT_MAX_COMPOSED_BYTES。
  ns.composeEditedImage = () => {
    const edit = ns.state.edit;
    if (!edit?.image || !edit.naturalWidth || !edit.naturalHeight) throw new Error('当前没有可导出的编辑图像。');
    const format = ns.detectLossyExportFormat?.() || 'image/jpeg';
    let qualityIndex = 0;
    let width = edit.naturalWidth;
    let height = edit.naturalHeight;
    let dataUrl = ns.renderCompositeDataUrl(width, height, format, ns.EDIT_QUALITY_LADDER[qualityIndex]);
    let plan = ns.planComposeStep({ qualityIndex, width, height, bytes: ns.estimateDataUrlBytes(dataUrl) });
    let guard = 0;
    while (plan.action === 'encode' && guard++ < 64) {
      qualityIndex = plan.qualityIndex;
      width = plan.width;
      height = plan.height;
      dataUrl = ns.renderCompositeDataUrl(width, height, format, ns.EDIT_QUALITY_LADDER[qualityIndex]);
      plan = ns.planComposeStep({ qualityIndex, width, height, bytes: ns.estimateDataUrlBytes(dataUrl) });
    }
    if (plan.action !== 'accept') {
      throw new Error('标注图压缩到最小分辨率后仍超过单张 5MB 限制，请缩小原图分辨率后重试。');
    }
    return { dataUrl, width, height };
  };

  // ---- 提交 ----
  // 编辑 Tab 的比例/清晰度独立于创作页（不再隐式继承全局下拉框，防止"复用"回填等
  // 路径悄悄改掉编辑输出比例）："跟随原图"按原图宽高解析成最接近的显式比例。
  ns.resolveEditAspectRatio = () => {
    const raw = ns.els?.editAspectRatio?.value || 'follow';
    if (raw !== 'follow') return raw;
    return ns.nearestAspectRatio(ns.state.edit?.naturalWidth, ns.state.edit?.naturalHeight);
  };
  ns.getEditResolution = () => ns.els?.editResolution?.value || '1k';

  // 以合成图为唯一参考图、编辑 prompt 为提示词，复用主生成的 runGeneration 提交/轮询/结果链路。
  // n 固定 1；比例/清晰度用编辑 Tab 自己的控件；不使用/不清空生成 Tab 的参考图列表。
  ns.getEditSettings = (dataUrl, prompt) => {
    const settings = {
      model: ns.els.model.value,
      prompt,
      n: 1,
      size: ns.resolveEditAspectRatio(),
      resolution: ns.getEditResolution()
    };
    if (ns.isOfficialModel()) {
      settings.quality = ns.els.quality.value;
      settings.output_format = ns.els.outputFormat.value;
      if (ns.els.outputFormat.value !== 'png') settings.output_compression = Number(ns.els.outputCompression.value);
    }
    settings.image_urls = [dataUrl];
    return settings;
  };

  ns.handleEditSubmit = async () => {
    if (!ns.state.session?.token) return ns.setEditStatus('请先登录。', 'error');
    if (ns.state.isBusy || ns.hasPendingGeneration()) return ns.setEditStatus('已有生成任务在进行，请等它安全结束后再提交。', 'error');
    if (!ns.editHasImage()) return ns.setEditStatus('请先上传或选择一张图片。', 'error');
    ns.syncGlobalModelFromEdit();

    const composedPrompt = ns.buildEditPrompt(ns.els.editPrompt.value, ns.els.editAnnotationText.value, ns.els.editAppendToggle.checked);
    const check = ns.validateEditPrompt(composedPrompt);
    if (!check.ok) return ns.setEditStatus(check.error, 'error');
    if (!ns.state.edit.strokes.length && !window.confirm('当前还没有任何标注，确认仅凭提示词修改整张图吗？')) return;

    const size = ns.resolveEditAspectRatio();
    const resolution = ns.getEditResolution();
    const estimate = ns.estimatePrice({ size, resolution, n: 1 });
    if (!estimate.ok) return ns.setEditStatus(`无法生成：${estimate.error || '价格配置异常。'}`, 'error');

    let composed;
    try {
      ns.setEditStatus('正在合成标注图...', 'loading');
      composed = ns.composeEditedImage();
    } catch (error) {
      return ns.setEditStatus(error?.message || '标注图合成失败。', 'error');
    }
    const settings = ns.getEditSettings(composed.dataUrl, check.prompt);
    const costLabel = estimate.isMaximum ? `最高预扣 ${ns.formatMicros(estimate.unitMicros)}` : `预计 ${ns.formatMicros(estimate.unitMicros)}`;
    if (!window.confirm(`将按标注生成 1 张修改图（${size} · ${resolution}），${costLabel}。确认提交吗？`)) {
      ns.setEditStatus('已取消提交。');
      return;
    }
    // 结果与进度显示在创作页，切过去让用户看到进度。
    ns.gotoWorkspaceView();
    ns.setStatus('正在提交标注修改任务...', 'loading');
    ns.setEditStatus('已提交，请在「创作」页查看进度与结果。', 'ok');
    await ns.runGeneration(settings);
  };
  ns.gotoWorkspaceView = () => {
    try { window.location.hash = '#workspace'; } catch {}
  };

  // ---- 初始化与事件绑定 ----
  ns.initEditPanel = () => {
    ns.resetEditState();
    // 编辑面板模型下拉与全局模型同选项、同当前值。
    if (ns.els?.editModel && ns.els?.model) {
      const options = Array.from(ns.els.model.options || []).map((option) => {
        const clone = document.createElement('option');
        clone.value = option.value;
        clone.textContent = option.textContent;
        return clone;
      });
      ns.els.editModel.replaceChildren(...options);
      ns.syncEditModelFromGlobal();
    }
    ns.buildEditColorButtons?.();
    ns.buildEditWidthButtons?.();
    ns.renderEditToolbarState?.();
    ns.loadEditAnnotation();
    if (ns.els?.editAppendToggle) ns.els.editAppendToggle.checked = true;
    ns.updateEditPromptStats();
    ns.updateEditParamsNote();
    ns.renderEditor();
  };

  ns.bindEditEvents = () => {
    ns.els?.editUploadBtn?.addEventListener('click', () => ns.els.editUploadInput?.click());
    ns.els?.editChangeImageBtn?.addEventListener('click', () => ns.els.editUploadInput?.click());
    ns.els?.editUploadInput?.addEventListener('change', ns.handleEditUpload);
    ns.els?.editUndoBtn?.addEventListener('click', () => ns.undoEditStroke?.());
    ns.els?.editClearBtn?.addEventListener('click', () => ns.clearEditStrokes?.());
    ns.els?.editSubmitBtn?.addEventListener('click', ns.handleEditSubmit);
    ns.els?.editToolGroup?.addEventListener('click', (event) => {
      const tool = event.target?.closest('[data-edit-tool]')?.dataset?.editTool;
      if (tool) ns.setEditTool?.(tool);
    });
    ns.els?.editColorGroup?.addEventListener('click', (event) => {
      const color = event.target?.closest('[data-edit-color]')?.dataset?.editColor;
      if (color) ns.setEditColor?.(color);
    });
    ns.els?.editWidthGroup?.addEventListener('click', (event) => {
      const tier = event.target?.closest('[data-edit-width-tier]')?.dataset?.editWidthTier;
      if (tier !== undefined) ns.setEditWidthTier?.(Number(tier));
    });
    ns.els?.editPrompt?.addEventListener('input', ns.updateEditPromptStats);
    ns.els?.editAnnotationText?.addEventListener('input', () => {
      ns.saveEditAnnotation();
      ns.updateEditPromptStats();
    });
    ns.els?.editAppendToggle?.addEventListener('change', ns.updateEditPromptStats);
    ns.els?.editModel?.addEventListener('change', () => {
      ns.syncGlobalModelFromEdit();
      ns.updateEditControls();
      ns.updateEditParamsNote();
    });
    ns.els?.model?.addEventListener('change', () => {
      ns.syncEditModelFromGlobal();
      ns.updateEditParamsNote();
    });
    ns.els?.editAspectRatio?.addEventListener('change', ns.updateEditParamsNote);
    ns.els?.editResolution?.addEventListener('change', ns.updateEditParamsNote);
    ns.bindEditCanvasEvents?.();
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      let resizeTimer = null;
      window.addEventListener('resize', () => {
        if (resizeTimer) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          resizeTimer = null;
          if (ns.editHasImage()) ns.sizeEditCanvases?.();
        }, 150);
      });
    }
  };
})();

(() => {
  const ns = window.ImageGen = window.ImageGen || {};

  // 画布层：底层原图 canvas + 上层标注 canvas 叠放；显示尺寸 fit 容器，笔画坐标一律存原图
  // 像素坐标系，显示与合成时按当前目标尺寸等比换算。所有 DOM/canvas 操作集中在本文件，
  // 纯计算（缩放/降级决策）在 app/edit.js。

  let drawing = false;
  let activeStroke = null;
  let activePointerId = null;

  const MAX_DISPLAY_HEIGHT = 620;

  function annotationCtx() {
    return ns.els?.editAnnotationCanvas?.getContext?.('2d') || null;
  }
  function baseCtx() {
    return ns.els?.editBaseCanvas?.getContext?.('2d') || null;
  }
  function displayScale() {
    const edit = ns.state.edit;
    if (!edit?.naturalWidth || !edit?.displayWidth) return 1;
    return edit.displayWidth / edit.naturalWidth;
  }

  // ---- 工具栏按钮构建 / 选中态 ----
  ns.buildEditColorButtons = () => {
    const group = ns.els?.editColorGroup;
    if (!group) return;
    group.replaceChildren(...ns.EDIT_COLORS.map((color) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'edit-color-btn';
      button.dataset.editColor = color.value;
      button.title = color.name;
      button.setAttribute('aria-label', `标注颜色：${color.name}`);
      button.style.setProperty('--edit-color', color.value);
      return button;
    }));
  };
  ns.buildEditWidthButtons = () => {
    const group = ns.els?.editWidthGroup;
    if (!group) return;
    group.replaceChildren(...ns.EDIT_WIDTH_TIERS.map((tier, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'edit-width-btn';
      button.dataset.editWidthTier = String(index);
      button.title = `粗细：${tier.label}`;
      button.setAttribute('aria-label', `粗细：${tier.label}`);
      button.textContent = tier.label;
      return button;
    }));
  };
  ns.renderEditToolbarState = () => {
    const edit = ns.state.edit || {};
    ns.els?.editToolGroup?.querySelectorAll?.('[data-edit-tool]')?.forEach((button) => {
      const active = button.dataset.editTool === edit.tool;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    ns.els?.editColorGroup?.querySelectorAll?.('[data-edit-color]')?.forEach((button) => {
      const active = button.dataset.editColor === edit.color;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    ns.els?.editWidthGroup?.querySelectorAll?.('[data-edit-width-tier]')?.forEach((button) => {
      const active = Number(button.dataset.editWidthTier) === edit.widthTier;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  };
  ns.setEditTool = (tool) => {
    if (!ns.state.edit) return;
    ns.state.edit.tool = tool;
    ns.renderEditToolbarState();
  };
  ns.setEditColor = (color) => {
    if (!ns.state.edit) return;
    ns.state.edit.color = color;
    ns.renderEditToolbarState();
  };
  ns.setEditWidthTier = (tier) => {
    if (!ns.state.edit) return;
    ns.state.edit.widthTier = tier;
    ns.renderEditToolbarState();
  };

  // ---- 画布尺寸与重绘 ----
  ns.sizeEditCanvases = () => {
    const edit = ns.state.edit;
    const base = ns.els?.editBaseCanvas;
    const annotation = ns.els?.editAnnotationCanvas;
    const stage = ns.els?.editCanvasStage;
    if (!edit?.image || !base || !annotation) return;
    const available = Math.max(1, Math.floor(stage?.clientWidth || edit.naturalWidth));
    const scale = Math.min(available / edit.naturalWidth, MAX_DISPLAY_HEIGHT / edit.naturalHeight);
    const displayWidth = Math.max(1, Math.round(edit.naturalWidth * scale));
    const displayHeight = Math.max(1, Math.round(edit.naturalHeight * scale));
    edit.displayWidth = displayWidth;
    edit.displayHeight = displayHeight;
    for (const canvas of [base, annotation]) {
      canvas.width = displayWidth;
      canvas.height = displayHeight;
      canvas.style.width = `${displayWidth}px`;
      canvas.style.height = `${displayHeight}px`;
    }
    ns.drawEditBase();
    ns.redrawEditAnnotations();
  };
  ns.drawEditBase = () => {
    const edit = ns.state.edit;
    const ctx = baseCtx();
    if (!ctx || !edit?.image) return;
    ctx.clearRect(0, 0, edit.displayWidth, edit.displayHeight);
    ctx.drawImage(edit.image, 0, 0, edit.displayWidth, edit.displayHeight);
  };

  // 在给定 ctx 上按 scale（目标宽/原图宽）绘制一条笔画；坐标与线宽都从原图坐标系换算。
  function drawStroke(ctx, stroke, scale) {
    if (!stroke || !stroke.points?.length) return;
    ctx.save();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = Math.max(1, stroke.width * scale);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const pts = stroke.points;
    if (stroke.tool === 'brush') {
      ctx.beginPath();
      ctx.moveTo(pts[0].x * scale, pts[0].y * scale);
      if (pts.length === 1) ctx.lineTo(pts[0].x * scale + 0.01, pts[0].y * scale + 0.01);
      else for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x * scale, pts[i].y * scale);
      ctx.stroke();
    } else if (stroke.tool === 'rect') {
      const [a, b] = [pts[0], pts[pts.length - 1]];
      ctx.strokeRect(a.x * scale, a.y * scale, (b.x - a.x) * scale, (b.y - a.y) * scale);
    } else if (stroke.tool === 'ellipse') {
      const [a, b] = [pts[0], pts[pts.length - 1]];
      const cx = ((a.x + b.x) / 2) * scale;
      const cy = ((a.y + b.y) / 2) * scale;
      const rx = Math.abs(b.x - a.x) / 2 * scale;
      const ry = Math.abs(b.y - a.y) / 2 * scale;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(0.01, rx), Math.max(0.01, ry), 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  ns.redrawEditAnnotations = (preview = null) => {
    const edit = ns.state.edit;
    const ctx = annotationCtx();
    if (!ctx || !edit) return;
    const scale = displayScale();
    ctx.clearRect(0, 0, edit.displayWidth, edit.displayHeight);
    for (const stroke of edit.strokes) drawStroke(ctx, stroke, scale);
    if (preview) drawStroke(ctx, preview, scale);
  };

  // ---- 指针事件（统一 Pointer Events，支持触屏）----
  function naturalPointFromEvent(event) {
    const canvas = ns.els?.editAnnotationCanvas;
    const edit = ns.state.edit;
    if (!canvas || !edit) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const displayPoint = {
      x: rect.width ? (event.clientX - rect.left) * (canvas.width / rect.width) : 0,
      y: rect.height ? (event.clientY - rect.top) * (canvas.height / rect.height) : 0
    };
    const natural = ns.toNaturalPoint(
      displayPoint,
      { width: edit.displayWidth, height: edit.displayHeight },
      { width: edit.naturalWidth, height: edit.naturalHeight }
    );
    return {
      x: Math.max(0, Math.min(edit.naturalWidth, natural.x)),
      y: Math.max(0, Math.min(edit.naturalHeight, natural.y))
    };
  }

  ns.handleEditPointerDown = (event) => {
    const edit = ns.state.edit;
    if (!edit?.image) return;
    if (ns.state.isBusy || ns.hasPendingGeneration?.()) return;
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault?.();
    drawing = true;
    activePointerId = event.pointerId;
    ns.els?.editAnnotationCanvas?.setPointerCapture?.(event.pointerId);
    const point = naturalPointFromEvent(event);
    activeStroke = {
      tool: edit.tool,
      color: edit.color,
      width: ns.strokeWidthForTier(edit.widthTier, Math.min(edit.naturalWidth, edit.naturalHeight)),
      points: [point]
    };
    ns.redrawEditAnnotations(activeStroke);
  };
  ns.handleEditPointerMove = (event) => {
    if (!drawing || !activeStroke) return;
    if (activePointerId !== null && event.pointerId !== activePointerId) return;
    event.preventDefault?.();
    const point = naturalPointFromEvent(event);
    if (activeStroke.tool === 'brush') activeStroke.points.push(point);
    else activeStroke.points[1] = point;
    ns.redrawEditAnnotations(activeStroke);
  };
  ns.handleEditPointerUp = (event) => {
    if (!drawing || !activeStroke) return;
    if (activePointerId !== null && event.pointerId !== undefined && event.pointerId !== activePointerId) return;
    event.preventDefault?.();
    const stroke = activeStroke;
    drawing = false;
    activeStroke = null;
    try { ns.els?.editAnnotationCanvas?.releasePointerCapture?.(activePointerId); } catch {}
    activePointerId = null;
    // 形状类需要至少两个不同的点才算有效标注；单击（无拖拽）的矩形/椭圆丢弃。
    const meaningful = stroke.tool === 'brush'
      ? stroke.points.length >= 1
      : stroke.points.length >= 2 && (stroke.points[0].x !== stroke.points[1].x || stroke.points[0].y !== stroke.points[1].y);
    if (meaningful) ns.state.edit.strokes.push(stroke);
    ns.redrawEditAnnotations();
    ns.updateEditControls();
  };

  ns.bindEditCanvasEvents = () => {
    const canvas = ns.els?.editAnnotationCanvas;
    if (!canvas?.addEventListener) return;
    canvas.addEventListener('pointerdown', ns.handleEditPointerDown);
    canvas.addEventListener('pointermove', ns.handleEditPointerMove);
    canvas.addEventListener('pointerup', ns.handleEditPointerUp);
    canvas.addEventListener('pointercancel', ns.handleEditPointerUp);
    canvas.addEventListener('pointerleave', ns.handleEditPointerUp);
  };

  ns.undoEditStroke = () => {
    if (!ns.state.edit?.strokes?.length) return;
    ns.state.edit.strokes.pop();
    ns.redrawEditAnnotations();
    ns.updateEditControls();
  };
  ns.clearEditStrokes = () => {
    if (!ns.state.edit?.strokes?.length) return;
    ns.state.edit.strokes = [];
    ns.redrawEditAnnotations();
    ns.updateEditControls();
  };

  // ---- 合成到离屏 canvas 并导出 dataURL（按目标尺寸重放原图 + 笔画）----
  ns.renderCompositeDataUrl = (width, height, format = 'image/png', quality) => {
    const edit = ns.state.edit;
    if (!edit?.image) throw new Error('当前没有可导出的编辑图像。');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('浏览器不支持 canvas 导出。');
    ctx.drawImage(edit.image, 0, 0, width, height);
    const scale = width / edit.naturalWidth;
    for (const stroke of edit.strokes) drawStroke(ctx, stroke, scale);
    return quality === undefined ? canvas.toDataURL(format) : canvas.toDataURL(format, quality);
  };
})();

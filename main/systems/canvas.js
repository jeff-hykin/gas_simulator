/**
 * @typedef {{x:number,y:number}} Point
 */

/**
 * Create a reusable infinite canvas with pan/zoom and a render "world".
 *
 * @example
 * const canvasSys = createCanvasSystem({ width: 900, height: 600 });
 * document.body.append(canvasSys.canvas);
 * canvasSys.setWorld([{ type: 'point', x: 0, y: 0, r: 4, color: '#f00' }]);
 */
export function createCanvasSystem({ width = 800, height = 600 } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const pixelRatio = 2; // Double resolution for crisp rendering
  canvas.width = width * pixelRatio;
  canvas.height = height * pixelRatio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.style.border = 'none';
  canvas.style.background = '#e5e5ea';
  ctx.scale(pixelRatio, pixelRatio);

  const world = [];
  let backgroundImage = null;
  const hiddenLayers = new Set();

  const state = {
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    isPanning: false,
    lastPanX: 0,
    lastPanY: 0,
  };

  /** @type {Array<object>} */
  const controllers = [];

  function setSize(w, h) {
    const pixelRatio = 2;
    canvas.width = w * pixelRatio;
    canvas.height = h * pixelRatio;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.scale(pixelRatio, pixelRatio);
    render();
  }

  function getView() {
    return { offsetX: state.offsetX, offsetY: state.offsetY, scale: state.scale };
  }

  function setView({ offsetX, offsetY, scale } = {}) {
    if (offsetX != null) state.offsetX = offsetX;
    if (offsetY != null) state.offsetY = offsetY;
    if (scale != null) state.scale = Math.max(0.1, Math.min(6, scale));
    render();
  }

  /**
   * Center the view on a world coordinate.
   */
  function centerOn({ x, y }) {
    state.offsetX = -x-(width/2);
    state.offsetY = -y-(height/2);
    render();
  }

  /**
   * Convert world coordinates to screen pixels.
   * @example
   * const screen = canvasSys.worldToScreen({ x: 10, y: 20 });
   */
  function worldToScreen(pt) {
    return {
      x: (pt.x + state.offsetX) * state.scale + canvas.width / 2,
      y: (pt.y + state.offsetY) * state.scale + canvas.height / 2,
    };
  }

  /**
   * Convert screen pixels to world coordinates.
   * @example
   * const world = canvasSys.screenToWorld({ x: 100, y: 100 });
   */
  function screenToWorld(pt) {
    return {
      x: (pt.x - canvas.width / 2) / state.scale - state.offsetX,
      y: (pt.y - canvas.height / 2) / state.scale - state.offsetY,
    };
  }

  function flattenWorld(items, out = []) {
    for (const item of items) {
      if (Array.isArray(item)) {
        flattenWorld(item, out);
      } else if (item) {
        out.push(item);
      }
    }
    return out;
  }

  function styleValue(item, key, fallback) {
    if (item && Object.prototype.hasOwnProperty.call(item, key) && item[key] != null) return item[key];
    if (item && item.inherit && Object.prototype.hasOwnProperty.call(item.inherit, key) && item.inherit[key] != null) {
      return item.inherit[key];
    }
    return fallback;
  }

  function applyStrokeFill(item) {
    const stroke = styleValue(item, 'stroke', undefined) ?? styleValue(item, 'color', undefined);
    const fill = styleValue(item, 'fill', undefined);
    const lineWidth = styleValue(item, 'lineWidth', 1);
    const opacity = styleValue(item, 'opacity', 1);

    ctx.globalAlpha = opacity;
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
    }
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function renderItem(item) {
    const type = item.type || 'point';
    if (type === 'polygon') {
      const points = item.points || [];
      if (points.length < 2) return;
      ctx.beginPath();
      const start = worldToScreen(points[0]);
      ctx.moveTo(start.x, start.y);
      for (let i = 1; i < points.length; i += 1) {
        const p = worldToScreen(points[i]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      applyStrokeFill(item);
    } else if (type === 'line') {
      const points = item.points || [];
      if (points.length < 2) return;
      ctx.beginPath();
      const start = worldToScreen(points[0]);
      ctx.moveTo(start.x, start.y);
      for (let i = 1; i < points.length; i += 1) {
        const p = worldToScreen(points[i]);
        ctx.lineTo(p.x, p.y);
      }
      const stroke = styleValue(item, 'stroke', undefined) ?? styleValue(item, 'color', undefined);
      const lineWidth = styleValue(item, 'lineWidth', 1);
      const opacity = styleValue(item, 'opacity', 1);
      ctx.globalAlpha = opacity;
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lineWidth;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (type === 'point') {
      const r = styleValue(item, 'r', 4);
      const p = worldToScreen(item);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      applyStrokeFill(item);
    } else if (type === 'label') {
      const p = worldToScreen(item);
      const text = item.text ?? '';
      const font = styleValue(item, 'font', '12px monospace');
      const color = styleValue(item, 'color', '#eaeaea');
      ctx.font = font;
      ctx.fillStyle = color;
      ctx.fillText(text, p.x, p.y);
    } else if (type === 'rect') {
      const { x, y, w, h } = item;
      const angle = styleValue(item, 'angle', 0);
      const center = worldToScreen({ x, y });
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.rotate((angle * Math.PI) / 180);
      ctx.beginPath();
      ctx.rect(-w * state.scale / 2, -h * state.scale / 2, w * state.scale, h * state.scale);
      applyStrokeFill(item);
      ctx.restore();
    } else if (type === 'circle') {
      const { x, y, r } = item;
      const center = worldToScreen({ x, y });
      const radius = r * state.scale;
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
      applyStrokeFill(item);
    } else if (type === 'radialGradient') {
      const { x, y, r } = item;
      const center = worldToScreen({ x, y });
      let radius = r * state.scale;
      let alphaMul = 1;
      if (item.pulse) {
        const period = item.pulsePeriod ?? 0.9;
        const phase = (performance.now() / 1000) * (Math.PI * 2) / period;
        const wave = (Math.sin(phase) + 1) / 2; // 0..1
        const minA = item.pulseMinAlpha ?? 0.25;
        const maxA = item.pulseMaxAlpha ?? 0.6;
        alphaMul = minA + (maxA - minA) * wave;
        const radiusMin = item.pulseMinScale ?? 0.92;
        const radiusMax = item.pulseMaxScale ?? 1.12;
        radius *= radiusMin + (radiusMax - radiusMin) * wave;
      }
      const gradient = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, radius);
      const stops = item.stops || [
        { offset: 0, color: 'rgba(255,255,255,0.8)' },
        { offset: 1, color: 'rgba(255,255,255,0)' },
      ];
      for (const stop of stops) {
        gradient.addColorStop(stop.offset, stop.color);
      }
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = Math.max(0, Math.min(1, prevAlpha * alphaMul));
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = prevAlpha;
    }
  }

  function render() {
    ctx.fillStyle = '#e5e5ea';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    if (backgroundImage) {
      const screenW = backgroundImage.naturalWidth * state.scale;
      const screenH = backgroundImage.naturalHeight * state.scale;
      const center = worldToScreen({ x: 0, y: 0 });
      ctx.drawImage(backgroundImage, center.x - screenW / 2, center.y - screenH / 2, screenW, screenH);
    }
    const items = flattenWorld(world);
    for (const item of items) {
      const layer = item.layer ?? (item.inherit && item.inherit.layer);
      if (layer && hiddenLayers.has(layer)) continue;
      renderItem(item);
    }
    ctx.restore();
  }

  function setLayerVisible(layer, visible) {
    if (visible) hiddenLayers.delete(layer);
    else hiddenLayers.add(layer);
    render();
  }

  function isLayerVisible(layer) {
    return !hiddenLayers.has(layer);
  }

  function setBackground(src) {
    console.log('[canvas] setBackground called with:', src);
    if (!src) {
      backgroundImage = null;
      render();
      return;
    }
    const img = new Image();
    img.onload = () => {
      console.log('[canvas] background image loaded:', src);
      backgroundImage = img;
      render();
    };
    img.onerror = (e) => {
      console.warn('[canvas] background image failed to load:', src, e);
    };
    img.src = src;
  }

  /**
   * Replace the current world render list.
   * @example
   * canvasSys.setWorld([{ type: 'point', x: 0, y: 0 }]);
   */
  function setWorld(items) {
    world.length = 0;
    if (items) world.push(...items);
    render();
  }

  /**
   * Add a renderable item or group to the world.
   * @example
   * canvasSys.addToWorld({ type: 'line', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] });
   */
  function addToWorld(item) {
    world.push(item);
    render();
  }

  /**
   * Remove a renderable item from the world list.
   * @example
   * canvasSys.removeFromWorld(myItem);
   */
  function removeFromWorld(item) {
    const idx = world.indexOf(item);
    if (idx !== -1) world.splice(idx, 1);
    render();
  }

  /**
   * Clear all renderable items.
   * @example
   * canvasSys.clearWorld();
   */
  function clearWorld() {
    world.length = 0;
    render();
  }

  /**
   * Take control of input events (pan/zoom is disabled while in control).
   * @example
   * const release = canvasSys.takeControl({ onClick: (ev) => console.log(ev.worldX, ev.worldY) });
   * release();
   */
  function takeControl(controller) {
    controllers.push(controller);
    return () => releaseControl(controller);
  }

  /**
   * Release control so default pan/zoom resumes.
   * @example
   * canvasSys.releaseControl(controller);
   */
  function releaseControl(controller) {
    const idx = controllers.indexOf(controller);
    if (idx !== -1) controllers.splice(idx, 1);
  }

  function activeController() {
    if (controllers.length === 0) return null;
    return controllers[controllers.length - 1];
  }

  function augmentEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const worldPt = screenToWorld({ x: screenX, y: screenY });
    return {
      screenX,
      screenY,
      worldX: worldPt.x,
      worldY: worldPt.y,
      button: e.button,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      originalEvent: e,
      canvas,
      view: getView(),
    };
  }

  function handlePointerDown(e) {
    const controller = activeController();
    if (controller && controller.onPointerDown) {
      const handled = controller.onPointerDown(augmentEvent(e));
      if (handled !== false) return;
    }
    state.isPanning = true;
    state.lastPanX = e.clientX;
    state.lastPanY = e.clientY;
  }

  function handlePointerMove(e) {
    const controller = activeController();
    if (controller && controller.onPointerMove) {
      const handled = controller.onPointerMove(augmentEvent(e));
      if (handled !== false) return;
    }
    if (!state.isPanning) return;
    const dx = (e.clientX - state.lastPanX) / state.scale;
    const dy = (e.clientY - state.lastPanY) / state.scale;
    state.offsetX += dx;
    state.offsetY += dy;
    state.lastPanX = e.clientX;
    state.lastPanY = e.clientY;
    render();
  }

  function handlePointerUp(e) {
    const controller = activeController();
    if (controller && controller.onPointerUp) {
      const handled = controller.onPointerUp(augmentEvent(e));
      if (handled !== false) return;
    }
    state.isPanning = false;
  }

  function handleWheel(e) {
    const controller = activeController();
    if (controller && controller.onWheel) {
      const handled = controller.onWheel(augmentEvent(e));
      if (handled !== false) return;
    }
    e.preventDefault();
    const zoom = Math.exp(-e.deltaY * 0.001);
    state.scale = Math.max(0.1, Math.min(6, state.scale * zoom));
    render();
  }

  function handleClick(e) {
    const controller = activeController();
    if (controller && controller.onClick) {
      controller.onClick(augmentEvent(e));
    }
  }

  function handleDblClick(e) {
    const controller = activeController();
    if (controller && controller.onDblClick) {
      controller.onDblClick(augmentEvent(e));
    }
  }

  canvas.addEventListener('pointerdown', handlePointerDown);
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);
  canvas.addEventListener('wheel', handleWheel, { passive: false });
  canvas.addEventListener('click', handleClick);
  canvas.addEventListener('dblclick', handleDblClick);

  render();

  return {
    canvas,
    setSize,
    setWorld,
    addToWorld,
    removeFromWorld,
    clearWorld,
    getWorld: () => world.slice(),
    getView,
    setView,
    centerOn,
    worldToScreen,
    screenToWorld,
    takeControl,
    releaseControl,
    render,
    setBackground,
    setLayerVisible,
    isLayerVisible,
  };
}

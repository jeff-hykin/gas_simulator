import { load, dump } from 'https://cdn.jsdelivr.net/npm/js-yaml@4.1.0/dist/js-yaml.mjs';

/**
 * @typedef {{x:number,y:number}} Point
 */

const DEFAULT_STYLES = {
  marker: { r: 5, stroke: '#f2f2f2', fill: '#0ea5e9', lineWidth: 2, font: '12px monospace', color: '#f2f2f2' },
  route: { stroke: '#fbbf24', lineWidth: 2, r: 3, fill: '#fbbf24' },
  obstacle: { stroke: '#e11d48', fill: 'rgba(225,29,72,0.2)', lineWidth: 2 },
  gasNode: { stroke: '#22c55e', lineWidth: 2 },
};

function makeId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createMapData() {
  return {
    styles: JSON.parse(JSON.stringify(DEFAULT_STYLES)),
    markers: [],
    routes: [],
    obstacles: [],
    gasNodes: [],
  };
}

export function serializeMap(mapData) {
  const clean = {
    styles: mapData.styles,
    markers: mapData.markers.map(({ asCanvas, ...rest }) => rest),
    routes: mapData.routes.map(({ asCanvas, ...rest }) => rest),
    obstacles: mapData.obstacles.map(({ asCanvas, ...rest }) => rest),
    gasNodes: mapData.gasNodes.map(({ asCanvas, ...rest }) => rest),
  };
  return dump(clean, { noRefs: true, lineWidth: 120 });
}

export function deserializeMap(yamlText) {
  const parsed = load(yamlText);
  const data = createMapData();
  if (!parsed || typeof parsed !== 'object') return data;
  return {
    ...data,
    ...parsed,
    styles: { ...data.styles, ...(parsed.styles || {}) },
  };
}

export function markerAsCanvas(marker, styles) {
  const inherit = styles.marker;
  const point = {
    type: 'point',
    x: marker.x,
    y: marker.y,
    inherit,
    owner: marker,
  };
  if (marker.r != null) point.r = marker.r;
  if (marker.stroke != null) point.stroke = marker.stroke;
  if (marker.fill != null) point.fill = marker.fill;
  if (marker.lineWidth != null) point.lineWidth = marker.lineWidth;

  const label = {
    type: 'label',
    x: marker.x + 8,
    y: marker.y - 8,
    text: marker.label || '',
    inherit,
    owner: marker,
  };
  if (marker.font != null) label.font = marker.font;
  if (marker.color != null) label.color = marker.color;
  return [point, label];
}

export function routeAsCanvas(route, styles) {
  const inherit = styles.route;
  const line = {
    type: 'line',
    points: route.points,
    stroke: route.stroke,
    lineWidth: route.lineWidth,
    inherit,
    owner: route,
  };
  const points = route.points.map((pt) => ({
    type: 'point',
    x: pt.x,
    y: pt.y,
    r: route.r,
    fill: route.fill,
    stroke: route.stroke,
    lineWidth: route.lineWidth,
    inherit,
    owner: route,
  }));
  return [line, points];
}

export function obstacleAsCanvas(obstacle, styles) {
  const inherit = styles.obstacle;
  return [
    {
      type: 'rect',
      x: obstacle.x,
      y: obstacle.y,
      w: obstacle.w,
      h: obstacle.h,
      angle: obstacle.angle || 0,
      stroke: obstacle.stroke,
      fill: obstacle.fill,
      lineWidth: obstacle.lineWidth,
      inherit,
      owner: obstacle,
    },
  ];
}

export function gasNodeAsCanvas(node, styles) {
  const inherit = styles.gasNode;
  return [
    {
      type: 'radialGradient',
      x: node.x,
      y: node.y,
      r: node.radius,
      stops: node.stops || [
        { offset: 0, color: 'rgba(34,197,94,0.5)' },
        { offset: 1, color: 'rgba(34,197,94,0)' },
      ],
      inherit,
      owner: node,
    },
    {
      type: 'point',
      x: node.x,
      y: node.y,
      r: 3,
      stroke: node.stroke,
      lineWidth: node.lineWidth,
      inherit,
      owner: node,
    },
  ];
}

export function buildAsCanvas(mapData) {
  const out = [];
  for (const marker of mapData.markers) out.push(marker.asCanvas || markerAsCanvas(marker, mapData.styles));
  for (const route of mapData.routes) out.push(route.asCanvas || routeAsCanvas(route, mapData.styles));
  for (const obstacle of mapData.obstacles) out.push(obstacle.asCanvas || obstacleAsCanvas(obstacle, mapData.styles));
  for (const node of mapData.gasNodes) out.push(node.asCanvas || gasNodeAsCanvas(node, mapData.styles));
  return out;
}

/**
 * Create the map system with UI and helpers.
 *
 * @example
 * const mapSys = createMapSystem(canvasSys);
 * document.body.append(mapSys.element);
 * mapSys.addMarker({ x: 10, y: 20, label: 'A' });
 */
export function createMapSystem(canvasSys) {
  const element = document.createElement('div');
  element.className = 'map-panel';

  const mapData = createMapData();
  const mapWorldItems = [];

  const ui = {
    mode: 'idle',
    pendingRoute: null,
    pendingObstacle: null,
  };

  /**
   * Rebuild the canvas world from map data.
   * @example
   * mapSys.rebuildWorld();
   */
  function rebuildWorld() {
    for (const item of mapWorldItems) canvasSys.removeFromWorld(item);
    mapWorldItems.length = 0;
    const items = buildAsCanvas(mapData);
    for (const item of items) {
      mapWorldItems.push(item);
      canvasSys.addToWorld(item);
    }
  }

  /**
   * Add a labeled marker point to the map.
   * @example
   * mapSys.addMarker({ x: 10, y: 20, label: 'Depot' });
   */
  function addMarker({ x, y, label = 'marker' }) {
    const marker = { id: makeId('marker'), x, y, label };
    marker.asCanvas = markerAsCanvas(marker, mapData.styles);
    mapData.markers.push(marker);
    mapWorldItems.push(marker.asCanvas);
    canvasSys.addToWorld(marker.asCanvas);
    return marker;
  }

  /**
   * Add a route with a list of points.
   * @example
   * mapSys.addRoute([{ x: 0, y: 0 }, { x: 50, y: 30 }]);
   */
  function addRoute(points = []) {
    const route = { id: makeId('route'), points };
    route.asCanvas = routeAsCanvas(route, mapData.styles);
    mapData.routes.push(route);
    mapWorldItems.push(route.asCanvas);
    canvasSys.addToWorld(route.asCanvas);
    return route;
  }

  /**
   * Add a rectangular obstacle (x,y are center coordinates).
   * @example
   * mapSys.addObstacle({ x: 10, y: 10, w: 40, h: 20 });
   */
  function addObstacle({ x, y, w, h, angle = 0 }) {
    const obstacle = { id: makeId('obstacle'), x, y, w, h, angle };
    obstacle.asCanvas = obstacleAsCanvas(obstacle, mapData.styles);
    mapData.obstacles.push(obstacle);
    mapWorldItems.push(obstacle.asCanvas);
    canvasSys.addToWorld(obstacle.asCanvas);
    return obstacle;
  }

  /**
   * Add a gas node with gaussian radius/peak.
   * @example
   * mapSys.addGasNode({ x: 0, y: 0, radius: 80, peak: 1.5 });
   */
  function addGasNode({ x, y, radius = 60, peak = 1 }) {
    const node = { id: makeId('gas'), x, y, radius, peak };
    node.asCanvas = gasNodeAsCanvas(node, mapData.styles);
    mapData.gasNodes.push(node);
    mapWorldItems.push(node.asCanvas);
    canvasSys.addToWorld(node.asCanvas);
    return node;
  }

  /**
   * Set the map input mode (idle, add-marker, add-route, add-obstacle, add-gas).
   * @example
   * mapSys.setMode('add-route');
   */
  function setMode(mode) {
    ui.mode = mode;
    ui.pendingRoute = null;
    ui.pendingObstacle = null;
    updateModeUI();
  }

  /**
   * Save the current map as YAML.
   * @example
   * mapSys.saveMap();
   */
  function saveMap() {
    const yamlText = serializeMap(mapData);
    const blob = new Blob([yamlText], { type: 'text/yaml' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'map.yaml';
    link.click();
    URL.revokeObjectURL(link.href);
  }

  /**
   * Load a YAML file selected from a file input.
   * @example
   * mapSys.loadMapFile(fileInput.files[0]);
   */
  function loadMapFile(file) {
    return file.text().then((text) => {
      const loaded = deserializeMap(text);
      mapData.styles = loaded.styles;
      mapData.markers = (loaded.markers || []).map((marker) => ({
        ...marker,
        asCanvas: markerAsCanvas(marker, loaded.styles),
      }));
      mapData.routes = (loaded.routes || []).map((route) => ({
        ...route,
        asCanvas: routeAsCanvas(route, loaded.styles),
      }));
      mapData.obstacles = (loaded.obstacles || []).map((obstacle) => ({
        ...obstacle,
        asCanvas: obstacleAsCanvas(obstacle, loaded.styles),
      }));
      mapData.gasNodes = (loaded.gasNodes || []).map((node) => ({
        ...node,
        asCanvas: gasNodeAsCanvas(node, loaded.styles),
      }));
      rebuildWorld();
    });
  }

  function buildButton(label, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.yaml,.yml';
  fileInput.style.display = 'none';
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) loadMapFile(file);
  });

  function updateModeUI() {
    const modeText = ui.mode.replace('add-', '').replace('-', ' ');
    modeLabel.textContent = `Mode: ${modeText}`;
    const buttons = [buttonMarker, buttonRoute, buttonObstacle, buttonGas];
    for (const btn of buttons) btn.classList.remove('is-active');
    if (ui.mode === 'add-marker') buttonMarker.classList.add('is-active');
    if (ui.mode === 'add-route') buttonRoute.classList.add('is-active');
    if (ui.mode === 'add-obstacle') buttonObstacle.classList.add('is-active');
    if (ui.mode === 'add-gas') buttonGas.classList.add('is-active');
  }

  const controls = document.createElement('div');
  controls.className = 'map-controls';
  const modeLabel = document.createElement('div');
  modeLabel.className = 'mode-label';
  modeLabel.textContent = 'Mode: idle';

  const buttonMarker = buildButton('Add Marker', () => setMode('add-marker'));
  const buttonRoute = buildButton('Add Route', () => setMode('add-route'));
  const buttonObstacle = buildButton('Add Obstacle', () => setMode('add-obstacle'));
  const buttonGas = buildButton('Add Gas', () => setMode('add-gas'));
  const buttonSave = buildButton('Save YAML', saveMap);
  const buttonLoad = buildButton('Load YAML', () => fileInput.click());

  controls.append(buttonMarker, buttonRoute, buttonObstacle, buttonGas, buttonSave, buttonLoad);

  element.append(modeLabel, controls, fileInput);

  const controller = {
    onClick(ev) {
      if (ui.mode === 'add-marker') {
        addMarker({ x: ev.worldX, y: ev.worldY, label: 'marker' });
        setMode('idle');
      } else if (ui.mode === 'add-gas') {
        addGasNode({ x: ev.worldX, y: ev.worldY });
        setMode('idle');
      } else if (ui.mode === 'add-route') {
        if (!ui.pendingRoute) {
          ui.pendingRoute = addRoute([{ x: ev.worldX, y: ev.worldY }]);
        } else {
          ui.pendingRoute.points.push({ x: ev.worldX, y: ev.worldY });
          ui.pendingRoute.asCanvas = routeAsCanvas(ui.pendingRoute, mapData.styles);
          rebuildWorld();
        }
      } else if (ui.mode === 'add-obstacle') {
        if (!ui.pendingObstacle) {
          ui.pendingObstacle = { x: ev.worldX, y: ev.worldY };
        } else {
          const x1 = ui.pendingObstacle.x;
          const y1 = ui.pendingObstacle.y;
          const x2 = ev.worldX;
          const y2 = ev.worldY;
          const w = Math.abs(x2 - x1);
          const h = Math.abs(y2 - y1);
          const x = (x1 + x2) / 2;
          const y = (y1 + y2) / 2;
          addObstacle({ x, y, w, h });
          ui.pendingObstacle = null;
          setMode('idle');
        }
      }
    },
    onDblClick() {
      if (ui.mode === 'add-route' && ui.pendingRoute) {
        ui.pendingRoute = null;
        setMode('idle');
      }
    },
  };

  const releaseControl = canvasSys.takeControl(controller);
  updateModeUI();

  return {
    element,
    mapData,
    setMode,
    addMarker,
    addRoute,
    addObstacle,
    addGasNode,
    rebuildWorld,
    saveMap,
    loadMapFile,
    releaseControl,
  };
}

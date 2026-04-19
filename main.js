import { createCanvasSystem } from './main/systems/canvas.js';
import { createMapSystem, deserializeMap } from './main/systems/map.js';
import { createSimulator } from './main/systems/simulator.js';
import { createPubSub } from './main/tooling/pubsub.js';
import gradientAgent from './main/agents/neo/gradient_agent.js';
import dumbLobsterAgent from './main/agents/neo/dumb_lobster_agent.js';
import smartLobsterAgent from './main/agents/neo/smart_lobster_agent.js';
import baselineAgent from './main/agents/neo/baseline_agent.js';

const AGENT_OPTIONS = [
  { label: 'smart_lobster', agent: smartLobsterAgent },
  { label: 'dumb_lobster',  agent: dumbLobsterAgent },
  { label: 'gradient',      agent: gradientAgent },
  { label: 'baseline',      agent: baselineAgent },
];
let selectedGasAgent = AGENT_OPTIONS[0].agent;

const canvasSys = createCanvasSystem({ width: window.innerWidth, height: window.innerHeight });
window.addEventListener('resize', () => {
  canvasSys.setSize(window.innerWidth, window.innerHeight);
});

// Visualization points by ID (for debugging/analysis)
const visualizationPointsById = new Map();
const visualizationLinesById = new Map();
let vectorFieldItems = []; // Canvas items for vector field arrows

// Current JSON state (merged from all logJson publishes)
const currentJsonState = {};

function getStartPosition() {
  const markers = mapSys.mapData.markers || [];
  const start = markers.find((m) => m.label && m.label.toLowerCase() === 'start');
  return start ? { x: start.x, y: start.y } : { x: 0, y: 0 };
}

function onMapLoaded() {
  // When a map is loaded, reset the robot to the start marker position
  const startPos = getStartPosition();
  sim.setRobotPosition(startPos.x, startPos.y, 0);
  canvasSys.centerOn(startPos);
  // If the agent is running, stop it and clear state
  if (sim.agentActive) {
    sim.stopAgentLoop();
    mainPubSub = null;
    updateAgentButtons();
  }
}

const mapSys = createMapSystem(canvasSys, { onMapLoaded });
const sim = createSimulator(mapSys, canvasSys);

// ── Agent state ───────────────────────────────────────────────────────

let mainPubSub = null;
const agentConfig = {
  decisionRate: 0.05,        // How often agent makes movement decisions (5 times per second)
  samplingRate: 80,        // How often agent records gas samples (300 ticks = 3 seconds at current rate)
  gasNoiseStdDev: 0,
  maxMoveSpeed: 200,
  circlingSize: 40,
  gradientProjection: 80,
};

function buildButton(label, onClick) {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function updateAgentButtons() {
  const running = sim.isClockRunning;
  if (btnToggle) {
    btnToggle.innerHTML = running ? '&#9646;&#9646;' : '&#9654;'; // ⏸ or ▶
    btnToggle.classList.toggle('is-playing', running);
  }
}

function playAgent() {
  if (sim.isClockRunning) return;

  if (mainPubSub) {
    sim.play();
    updateAgentButtons();
    return;
  }

  {
    mainPubSub = createPubSub();

    // Set up JSON state display (merges new data with current state)
    mainPubSub.subscribe('logJson', (data) => {
      // Merge new data into current state
      Object.assign(currentJsonState, data);

      // Update display
      updateJsonStateDisplay();
    });

    // Set up visualization point channel (ID-based add/remove system)
    mainPubSub.subscribe('visualizePoints', (points) => {
      for (const data of points) handleVisualizePoint(data)
    })
    function handleVisualizePoint(data) {
      const { id, remove = false } = data;

      if (!id) {
        console.warn('visualizePoint requires an id');
        return;
      }

      // Handle removal
      if (remove) {
        const existing = visualizationPointsById.get(id);
        if (existing) {
          const world = canvasSys.getWorld();
          const index = world.indexOf(existing);
          if (index !== -1) {
            world.splice(index, 1);
          }
          visualizationPointsById.delete(id);
          canvasSys.render();
        }
        return;
      }

      // Add or update point
      const { x, y, color = '#ff0000', label = '', r = 5 } = data;
      const pointStroke = data.stroke || color;
      const pointFill = data.fill || `${color}80`;

      // Check if point already exists
      let point = visualizationPointsById.get(id);
      if (point) {
        // Update existing point
        point.x = x;
        point.y = y;
        point.r = r;
        point.stroke = pointStroke;
        point.fill = pointFill;
        point.label = label;
      } else {
        // Create new point
        point = {
          type: 'point',
          x,
          y,
          r,
          stroke: pointStroke,
          fill: pointFill,
          lineWidth: 2,
          label,
        };
        if (id.startsWith('gasDot_')) point.layer = 'gradient-trail';
        visualizationPointsById.set(id, point);
        canvasSys.addToWorld(point);
      }

      canvasSys.render();
    }

    // Set up visualization line channel (ID-based add/remove system)
    mainPubSub.subscribe('visualizeLines', (lines) => {
      for (const data of lines) {
        const { id, remove = false } = data;
        if (!id) { console.warn('visualizeLines requires an id'); continue }
        if (remove) {
          const existing = visualizationLinesById.get(id);
          if (existing) {
            canvasSys.removeFromWorld(existing);
            visualizationLinesById.delete(id);
          }
          continue;
        }
        const { x1, y1, x2, y2, color = '#ffffff', lineWidth = 2, opacity = 1 } = data;
        let line = visualizationLinesById.get(id);
        if (line) {
          line.points = [{ x: x1, y: y1 }, { x: x2, y: y2 }];
          line.color = color;
          line.lineWidth = lineWidth;
          line.opacity = opacity;
        } else {
          line = { type: 'line', points: [{ x: x1, y: y1 }, { x: x2, y: y2 }], color, lineWidth, opacity };
          visualizationLinesById.set(id, line);
          canvasSys.addToWorld(line);
        }
      }
      canvasSys.render();
    })

    // Set up toast channel (transient top-of-screen notifications)
    mainPubSub.subscribe('toast', (data) => {
      if (!data || !data.message) return;
      showToast(data.message, data.type || 'info', data.duration || 3000);
    });

    // Set up vector field channel (renders gradient arrows on the canvas)
    mainPubSub.subscribe('vectorField', (arrows) => {
      // Remove previous field arrows
      for (const item of vectorFieldItems) {
        canvasSys.removeFromWorld(item);
      }
      vectorFieldItems = [];

      if (!arrows || arrows.length === 0) {
        canvasSys.render();
        return;
      }

      // Find max slope for color scaling
      const maxSlope = arrows.reduce((m, a) => Math.max(m, a.slope), 0);

      for (const arrow of arrows) {
        // Color: interpolate from dim blue (weak) to bright red (strong)
        const t = maxSlope > 0 ? Math.min(arrow.slope / maxSlope, 1) : 0;
        const r = Math.round(50 + 205 * t);
        const g = Math.round(180 * (1 - t));
        const b = Math.round(255 * (1 - t));
        const color = `rgb(${r},${g},${b})`;

        const x1 = arrow.x;
        const y1 = arrow.y;
        const x2 = arrow.x + arrow.dx;
        const y2 = arrow.y + arrow.dy;

        // Arrow shaft
        const shaft = {
          type: 'line',
          points: [{ x: x1, y: y1 }, { x: x2, y: y2 }],
          color,
          lineWidth: 1.5,
          opacity: 0.7,
        };
        vectorFieldItems.push(shaft);
        canvasSys.addToWorld(shaft);

        // Arrowhead (two small lines)
        const angle = Math.atan2(arrow.dy, arrow.dx);
        const headLen = Math.hypot(arrow.dx, arrow.dy) * 0.35;
        const headAngle = 0.5; // ~29 degrees
        const hx1 = x2 - Math.cos(angle - headAngle) * headLen;
        const hy1 = y2 - Math.sin(angle - headAngle) * headLen;
        const hx2 = x2 - Math.cos(angle + headAngle) * headLen;
        const hy2 = y2 - Math.sin(angle + headAngle) * headLen;

        const head = {
          type: 'line',
          points: [{ x: hx1, y: hy1 }, { x: x2, y: y2 }, { x: hx2, y: hy2 }],
          color,
          lineWidth: 1.5,
          opacity: 0.7,
        };
        vectorFieldItems.push(head);
        canvasSys.addToWorld(head);
      }

      canvasSys.render();
    });

    const startPos = getStartPosition();
    sim.startAgentLoop(mainPubSub, {
      ...agentConfig,
      startPosition: startPos,
      gasAgent: selectedGasAgent,
    });

    const routes = mapSys.mapData.routes || [];
    if (routes.length > 0 && routes[0].points.length > 0) {
      mainPubSub.publish('route_update', { waypoints: routes[0].points });
    }
  }

  updateAgentButtons();
}

function pauseAgent() {
  sim.pause();
  updateAgentButtons();
}

// Fields to show in the status bar (mode is shown separately above)
const STATUS_FIELDS = ['heading', 'time', 'steer', 'maxGas', 'peakGas', 'productivity'];

function updateJsonStateDisplay() {
  if (typeof dynamicFieldsContainer === 'undefined' || !dynamicFieldsContainer) return;

  // Update mode indicator separately
  if ('mode' in currentJsonState) {
    updateModeIndicator(currentJsonState.mode);
  }

  dynamicFieldsContainer.innerHTML = '';
  for (const key of STATUS_FIELDS) {
    if (!(key in currentJsonState)) continue;
    const value = currentJsonState[key];
    const field = document.createElement('div');
    field.className = 'status-field';
    const label = document.createElement('div');
    label.className = 'field-label';
    label.textContent = key;
    const val = document.createElement('div');
    val.className = 'field-value';
    if (typeof value === 'number') {
      val.textContent = Number.isInteger(value) ? String(value) : value.toFixed(2);
    } else if (typeof value === 'object') {
      val.textContent = JSON.stringify(value);
    } else {
      val.textContent = String(value);
    }
    field.append(label, val);
    dynamicFieldsContainer.append(field);
  }
}

function resetAgent() {
  const startPos = getStartPosition();
  sim.resetRobot({ x: startPos.x, y: startPos.y, angle: 0 });
  mainPubSub = null;

  // Clear JSON state
  Object.keys(currentJsonState).forEach(key => delete currentJsonState[key]);
  updateJsonStateDisplay();

  // Clear visualization points
  const world = canvasSys.getWorld();
  visualizationPointsById.forEach(point => {
    const index = world.indexOf(point);
    if (index !== -1) world.splice(index, 1);
  });
  visualizationPointsById.clear();

  // Clear vector field
  for (const item of vectorFieldItems) {
    canvasSys.removeFromWorld(item);
  }
  vectorFieldItems = [];

  canvasSys.render();
  updateAgentButtons();
}

// ── Toast notifications ───────────────────────────────────────────────

const toastContainer = document.createElement('div');
toastContainer.className = 'toast-container';
document.body.append(toastContainer);

function showToast(message, type = 'info', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.style.setProperty('--toast-duration', `${duration}ms`);
  toastContainer.append(toast);
  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ── Layout ────────────────────────────────────────────────────────────

// Canvas fills the viewport
document.body.append(canvasSys.canvas);

// Legend — top-left overlay
const legend = document.createElement('div');
legend.className = 'canvas-legend';
const legendEntries = [
  { label: 'Agent',     stroke: '#22d3ee', fill: 'rgba(34,211,238,0.2)' },
  { label: 'Route',     stroke: '#fbbf24', fill: '#fbbf24' },
  { label: 'Building',  stroke: '#e11d48', fill: 'rgba(225,29,72,0.2)' },
  { label: 'Gas',       stroke: '#a855f7', fill: 'transparent' },
  { label: 'Smell lost', stroke: '#22c55e', fill: '#22c55e' },
];
for (const entry of legendEntries) {
  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px' });
  const swatch = document.createElement('div');
  Object.assign(swatch.style, {
    width: '12px', height: '12px',
    border: `2px solid ${entry.stroke}`,
    background: entry.fill,
    borderRadius: '3px',
    boxSizing: 'border-box',
  });
  const text = document.createElement('span');
  text.textContent = entry.label;
  row.append(swatch, text);
  legend.append(row);
}
document.body.append(legend);

// Layer toggle panel — bottom-left
const layerPanel = document.createElement('div');
layerPanel.className = 'canvas-layer-panel';
const layerToggles = [
  { label: 'Gas',            layer: 'gas',             initial: true },
  { label: 'Obstacles',      layer: 'obstacles',       initial: true },
  { label: 'Route',          layer: 'route',           initial: true },
  { label: 'Gradient trail', layer: 'gradient-trail',  initial: true },
];
for (const { label, layer, initial } of layerToggles) {
  const row = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = initial;
  canvasSys.setLayerVisible(layer, initial);
  cb.addEventListener('change', () => canvasSys.setLayerVisible(layer, cb.checked));
  const text = document.createElement('span');
  text.textContent = label;
  row.append(cb, text);
  layerPanel.append(row);
}
document.body.append(layerPanel);

// ── Mode indicator (above status bar) ──────────────────────────────

const modeIndicator = document.createElement('div');
modeIndicator.className = 'mode-indicator mode-idle';
modeIndicator.textContent = 'Idle';
document.body.append(modeIndicator);

const MODE_LABELS = {
  idle: 'Idle',
  routeFollow: 'Following Route',
  gasFollow: 'Chasing Gas',
  'gasFollow-returnArrived': 'Returning to Route',
  greedy: 'Navigating',
  random: 'Exploring',
};

function updateModeIndicator(mode) {
  if (!mode) return;
  // Normalize mode name for CSS class (strip anything after first hyphen variant)
  const cssClass = 'mode-' + mode.replace(/[^a-zA-Z-]/g, '');
  modeIndicator.className = 'mode-indicator ' + cssClass;
  modeIndicator.textContent = MODE_LABELS[mode] || mode;
}

// ── Status bar (bottom center) ─────────────────────────────────────

const statusBar = document.createElement('div');
statusBar.className = 'status-bar';

function toggleAgent() {
  if (sim.isClockRunning) {
    pauseAgent();
  } else {
    playAgent();
  }
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    toggleAgent();
  }
});

// Play/pause button (circle)
const btnPlay = document.createElement('button');
btnPlay.className = 'play-btn';
btnPlay.innerHTML = '&#9654;'; // ▶
btnPlay.addEventListener('click', toggleAgent);

const btnToggle = btnPlay; // alias for updateAgentButtons

const statusDivider = document.createElement('div');
statusDivider.className = 'status-divider';

// Status fields container
const statusFields = document.createElement('div');
statusFields.className = 'status-fields';

// Gas reading field
const gasField = document.createElement('div');
gasField.className = 'status-field';
const gasLabel = document.createElement('div');
gasLabel.className = 'field-label';
gasLabel.textContent = 'Gas';
const gasValue = document.createElement('div');
gasValue.className = 'field-value gas-cool';
gasValue.textContent = '0.000';
gasField.append(gasLabel, gasValue);

// Dynamic status fields (populated from logJson)
const dynamicFieldsContainer = document.createElement('div');
dynamicFieldsContainer.className = 'status-fields';

statusFields.append(gasField);
statusBar.append(btnPlay, statusDivider, statusFields, dynamicFieldsContainer);
document.body.append(statusBar);

// Update gas readout in status bar instead of the old element
const originalGasReadoutUpdate = Object.getOwnPropertyDescriptor(
  sim.gasReadout, 'textContent'
);
// Observe gas readout changes by polling from the simulator
let lastGasText = '';
setInterval(() => {
  const raw = sim.gasReadout.textContent;
  if (raw !== lastGasText) {
    lastGasText = raw;
    const num = parseFloat(raw.replace(/[^0-9.]/g, '')) || 0;
    gasValue.textContent = num.toFixed(3);
    gasValue.className = 'field-value ' + (
      num > 0.5 ? 'gas-hot' : num > 0.1 ? 'gas-warm' : 'gas-cool'
    );
  }
}, 100);

// JSON state display (hidden, but we use it to feed the status bar)
const jsonStateDisplay = document.createElement('div');
jsonStateDisplay.className = 'json-state-display';

// Override updateJsonStateDisplay to also update status bar fields
const _origUpdateJsonState = updateJsonStateDisplay;

// ── Controls drawer (gear icon, top-right) ───────────────────────────

const gearBtn = document.createElement('button');
gearBtn.className = 'controls-toggle';
gearBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="3"/><path d="M10 1.5v2M10 16.5v2M18.5 10h-2M3.5 10h-2M16 4l-1.4 1.4M5.4 14.6L4 16M16 16l-1.4-1.4M5.4 5.4L4 4"/></svg>';
gearBtn.title = 'Settings';

const drawer = document.createElement('div');
drawer.className = 'controls-drawer hidden';

let drawerOpen = false;
gearBtn.addEventListener('click', () => {
  drawerOpen = !drawerOpen;
  drawer.classList.toggle('hidden', !drawerOpen);
  gearBtn.classList.toggle('open', drawerOpen);
});

// Agent section in drawer
const agentTitle = document.createElement('div');
agentTitle.className = 'section-title';
agentTitle.textContent = 'Agent';

const agentControls = document.createElement('div');
agentControls.className = 'agent-controls';

const agentSelect = document.createElement('select');
for (const { label } of AGENT_OPTIONS) {
  const opt = document.createElement('option');
  opt.value = label;
  opt.textContent = label;
  agentSelect.append(opt);
}
agentSelect.addEventListener('change', () => {
  const chosen = AGENT_OPTIONS.find((o) => o.label === agentSelect.value);
  if (!chosen) return;
  selectedGasAgent = chosen.agent;
  if (sim.agentActive) sim.stopAgentLoop();
  mainPubSub = null;
  updateAgentButtons();
});

const agentButtons = document.createElement('div');
agentButtons.className = 'agent-buttons';
const btnResetDrawer = buildButton('Reset', resetAgent);
agentButtons.append(btnResetDrawer);

agentControls.append(agentSelect, agentButtons);

// Map section
const mapTitle = document.createElement('div');
mapTitle.className = 'section-title';
mapTitle.textContent = 'Map';

const sep1 = document.createElement('div');
sep1.className = 'drawer-separator';
const sep2 = document.createElement('div');
sep2.className = 'drawer-separator';

drawer.append(
  agentTitle,
  agentControls,
  sep1,
  mapTitle,
  mapSys.element,
  sep2,
);

// Keep gas readout in DOM but hidden
sim.gasReadout.style.display = 'none';
drawer.append(sim.gasReadout);

document.body.append(gearBtn, drawer);

// ── Load default map on startup ───────────────────────────────────────
let defaultMap = './maps/chemical_plant.yaml';
fetch(defaultMap)
  .then((response) => response.text())
  .then((yamlText) => {
    mapSys.loadMapText(yamlText, defaultMap.split('/').at(-1));
  })
  .catch((err) => console.warn('Could not load default map:', err));

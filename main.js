import { createCanvasSystem } from './main/systems/canvas.js';
import { createMapSystem, deserializeMap } from './main/systems/map.js';
import { createSimulator } from './main/systems/simulator.js';
import { createPubSub } from './main/tooling/pubsub.js';
import gradientAgent from './main/agents/neo/gradient_agent.js';
import hillClimberAgent from './main/agents/neo/hill_climber_agent.js';
import hillClimber2Agent from './main/agents/neo/hill_climber2_agent.js';

const AGENT_OPTIONS = [
  { label: 'hill_climber2', agent: hillClimber2Agent },
  { label: 'hill_climber',  agent: hillClimberAgent },
  { label: 'gradient',      agent: gradientAgent },
];
let selectedGasAgent = AGENT_OPTIONS[0].agent;

const canvasSys = createCanvasSystem({ width: 1100, height: 830 });

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
  btnToggle.textContent = running ? 'Pause' : 'Play';
  btnToggle.classList.toggle('is-active', running);
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

function updateJsonStateDisplay() {
  if (!jsonStateDisplay) return;

  // Clear existing content
  jsonStateDisplay.innerHTML = '';

  // Display each key-value pair
  Object.entries(currentJsonState).forEach(([key, value]) => {
    const entry = document.createElement('div');
    entry.className = 'json-entry';

    const keySpan = document.createElement('span');
    keySpan.className = 'json-key';
    keySpan.textContent = key + ': ';

    const valueSpan = document.createElement('span');
    valueSpan.className = 'json-value';
    valueSpan.textContent = typeof value === 'object' ? JSON.stringify(value) : String(value);

    entry.appendChild(keySpan);
    entry.appendChild(valueSpan);
    jsonStateDisplay.appendChild(entry);
  });
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

// Canvas goes directly in body, wrapped so the legend can overlay it
const canvasWrap = document.createElement('div');
canvasWrap.style.position = 'relative';
canvasWrap.style.display = 'inline-block';
canvasWrap.append(canvasSys.canvas);

const legend = document.createElement('div');
legend.className = 'canvas-legend';
Object.assign(legend.style, {
  position: 'absolute',
  top: '10px',
  left: '10px',
  padding: '8px 10px',
  background: 'rgba(15,15,16,0.78)',
  border: '1px solid #333',
  borderRadius: '4px',
  font: '12px monospace',
  color: '#eaeaea',
  pointerEvents: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
});
const legendEntries = [
  { label: 'agent',      stroke: '#22d3ee', fill: 'rgba(34,211,238,0.2)' },
  { label: 'route',      stroke: '#fbbf24', fill: '#fbbf24' },
  { label: 'building',   stroke: '#e11d48', fill: 'rgba(225,29,72,0.2)' },
  { label: 'gas',        stroke: '#a855f7', fill: 'transparent' },
  { label: 'smell lost point', stroke: '#22c55e', fill: '#22c55e' },
];
for (const entry of legendEntries) {
  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px' });
  const swatch = document.createElement('div');
  Object.assign(swatch.style, {
    width: '14px',
    height: '14px',
    border: `2px solid ${entry.stroke}`,
    background: entry.fill,
    boxSizing: 'border-box',
  });
  const text = document.createElement('span');
  text.textContent = entry.label;
  row.append(swatch, text);
  legend.append(row);
}
canvasWrap.append(legend);
document.body.append(canvasWrap);

// Sidebar on the right with all controls
const sidebar = document.createElement('div');
sidebar.className = 'sidebar';

// Agent controls
const agentLabel = document.createElement('div');
agentLabel.className = 'mode-label';
agentLabel.textContent = 'Agent';

const agentControls = document.createElement('div');
agentControls.className = 'agent-controls';

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

const btnToggle = buildButton('Play', toggleAgent);
const btnReset = buildButton('Reset', resetAgent);
btnToggle.classList.add('full-width');
btnReset.classList.add('full-width');

const agentSelect = document.createElement('select');
agentSelect.className = 'full-width';
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
  // Force a fresh agent session on next play so the new factory takes effect.
  if (sim.agentActive) sim.stopAgentLoop();
  mainPubSub = null;
  updateAgentButtons();
});

agentControls.append(agentSelect, btnToggle, btnReset);

// JSON state display container
const jsonStateDisplay = document.createElement('div');
jsonStateDisplay.className = 'json-state-display';

// Build sidebar
sidebar.append(
  mapSys.element,
  sim.gasReadout,
  agentLabel,
  agentControls,
  jsonStateDisplay
);

document.body.append(sidebar);

// ── Load default map on startup ───────────────────────────────────────
let defaultMap = './maps/train_real.yaml';
fetch(defaultMap)
  .then((response) => response.text())
  .then((yamlText) => {
    mapSys.loadMapText(yamlText, defaultMap.split('/').at(-1));
  })
  .catch((err) => console.warn('Could not load default map:', err));

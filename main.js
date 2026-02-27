import { createCanvasSystem } from './main/systems/canvas.js';
import { createMapSystem, deserializeMap } from './main/systems/map.js';
import { createSimulator } from './main/systems/simulator.js';
import { createPubSub } from './main/tooling/pubsub.js';

const canvasSys = createCanvasSystem({ width: 1100, height: 830 });

// Visualization points by ID (for debugging/analysis)
const visualizationPointsById = new Map();

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
  decisionRate: 0.01,       // How often agent makes movement decisions (100 times per second)
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
  const running = sim.agentActive;
  btnToggle.textContent = running ? 'Pause' : 'Play';
  btnToggle.classList.toggle('is-active', running);
}

function playAgent() {
  if (sim.agentActive) return;

  if (!mainPubSub) {
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

      // Check if point already exists
      let point = visualizationPointsById.get(id);
      if (point) {
        // Update existing point
        point.x = x;
        point.y = y;
        point.r = r;
        point.stroke = color;
        point.fill = `${color}80`;
        point.label = label;
      } else {
        // Create new point
        point = {
          type: 'point',
          x,
          y,
          r,
          stroke: color,
          fill: `${color}80`,
          lineWidth: 2,
          label,
        };
        visualizationPointsById.set(id, point);
        canvasSys.addToWorld(point);
      }

      canvasSys.render();
    }
  }

  const startPos = getStartPosition();
  sim.startAgentLoop(mainPubSub, {
    ...agentConfig,
    startPosition: startPos,
  });

  const routes = mapSys.mapData.routes || [];
  if (routes.length > 0 && routes[0].points.length > 0) {
    mainPubSub.publish('route_update', { waypoints: routes[0].points });
  }

  updateAgentButtons();
}

function pauseAgent() {
  sim.stopAgentLoop();
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

  canvasSys.render();
  updateAgentButtons();
}

// ── Layout ────────────────────────────────────────────────────────────

// Canvas goes directly in body
document.body.append(canvasSys.canvas);

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
  if (sim.agentActive) {
    pauseAgent();
  } else {
    playAgent();
  }
}

const btnToggle = buildButton('Play', toggleAgent);
const btnReset = buildButton('Reset', resetAgent);
btnToggle.classList.add('full-width');
btnReset.classList.add('full-width');
agentControls.append(btnToggle, btnReset);

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
let defaultMap = './maps/chemical_plant.yaml';
fetch(defaultMap)
  .then((response) => response.text())
  .then((yamlText) => {
    mapSys.loadMapText(yamlText, defaultMap.split('/').at(-1));
  })
  .catch((err) => console.warn('Could not load default map:', err));

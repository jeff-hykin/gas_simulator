import { createCanvasSystem } from './canvas.js';
import { createMapSystem, deserializeMap } from './map.js';
import { createSimulator } from './simulator.js';
import { createPubSub } from './pubsub.js';
import { GasAgent } from './agent.js';

const app = document.getElementById('app');

const canvasSys = createCanvasSystem({ width: 900, height: 600 });

// Centroid visualization for agent exploration
const centroidCanvas = {
  type: 'point',
  x: 0,
  y: 0,
  r: 8,
  stroke: '#f97316',
  fill: 'rgba(249, 115, 22, 0.3)',
  lineWidth: 3,
};
canvasSys.addToWorld(centroidCanvas);

// Exploration waypoints visualization (circle points)
const explorationWaypoints = [];
const maxWaypoints = 16; // Support up to 16 waypoints
for (let i = 0; i < maxWaypoints; i++) {
  const waypoint = {
    type: 'point',
    x: 0,
    y: 0,
    r: 0, // Hidden by default
    stroke: '#8b5cf6',
    fill: 'rgba(139, 92, 246, 0.2)',
    lineWidth: 2,
  };
  explorationWaypoints.push(waypoint);
  canvasSys.addToWorld(waypoint);
}

function getStartPosition() {
  const markers = mapSys.mapData.markers || [];
  const start = markers.find((m) => m.label && m.label.toLowerCase() === 'start');
  return start ? { x: start.x, y: start.y } : { x: 0, y: 0 };
}

function onMapLoaded() {
  // When a map is loaded, reset the robot to the start marker position
  const startPos = getStartPosition();
  sim.setRobotPosition(startPos.x, startPos.y, 0);
  // If the agent is running, stop it and clear agent state
  if (sim.agentActive || agent !== null) {
    sim.stopAgentLoop();
    agent = null;
    agentPubSub = null;
    updateAgentButtons();
  }
}

const mapSys = createMapSystem(canvasSys, { onMapLoaded });
const sim = createSimulator(mapSys, canvasSys);

// ── Agent state ───────────────────────────────────────────────────────

let agentPubSub = null;
let agent = null;
const agentConfig = {
  decisionRate: 0.01,       // How often agent makes movement decisions (100 times per second)
  samplingRate: 80,        // How often agent records gas samples (300 ticks = 3 seconds at current rate)
  gasNoiseStdDev: 0,
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

  if (!agentPubSub) {
    const startPos = getStartPosition();
    agentPubSub = createPubSub();
    agent = new GasAgent(agentPubSub, {
      decisionRate: agentConfig.decisionRate,
      samplingRate: agentConfig.samplingRate,
      moveSpeed: 3,
      turnSpeed: 0.3,
      circlingSize: 40,           // Much larger exploration circles
      gradientProjection: 80,     // Extrapolate gradient further
      startPosition: startPos,
    });
    sim.setRobotPosition(startPos.x, startPos.y, 0);
  }

  sim.startAgentLoop(agentPubSub, { samplingRate: agentConfig.decisionRate, gasNoiseStdDev: agentConfig.gasNoiseStdDev });

  // Update sensor readout display, centroid, and exploration waypoints
  agentPubSub.subscribe('gas_reading', () => {
    if (agent) {
      agentSensorReadout.textContent = `Agent Sensor: ${agent.sensorReading.toFixed(3)}`;
      agentInterestReadout.textContent = `Interest: ${agent.computeInterest().toFixed(3)}`;
      agentRefocusReadout.textContent = `Refocus Pressure: ${agent.computeRefocusPressure().toFixed(3)}`;

      // Update centroid visualization
      if (agent.tempCentroid) {
        centroidCanvas.x = agent.tempCentroid.x;
        centroidCanvas.y = agent.tempCentroid.y;
        centroidCanvas.r = 8;  // Visible
      } else {
        centroidCanvas.r = 0;  // Hidden when no centroid
      }

      // Update exploration waypoints visualization
      if (agent.tempWaypoints && agent.tempWaypoints.length > 0) {
        agent.tempWaypoints.forEach((wp, i) => {
          if (i < explorationWaypoints.length) {
            explorationWaypoints[i].x = wp.x;
            explorationWaypoints[i].y = wp.y;
            explorationWaypoints[i].r = 4;  // Visible
          }
        });
        // Hide unused waypoint slots
        for (let i = agent.tempWaypoints.length; i < explorationWaypoints.length; i++) {
          explorationWaypoints[i].r = 0;
        }
      } else {
        // Hide all waypoints when not exploring
        explorationWaypoints.forEach(wp => wp.r = 0);
      }

      canvasSys.render();
    }
  });

  const routes = mapSys.mapData.routes || [];
  if (routes.length > 0 && routes[0].points.length > 0) {
    agentPubSub.publish('route_update', { waypoints: routes[0].points });
  }

  updateAgentButtons();
}

function pauseAgent() {
  sim.stopAgentLoop();
  updateAgentButtons();
}

function resetAgent() {
  const startPos = getStartPosition();
  sim.resetRobot({ x: startPos.x, y: startPos.y, angle: 0 });
  agent = null;
  agentPubSub = null;
  agentSensorReadout.textContent = 'Agent Sensor: 0.000';
  agentInterestReadout.textContent = 'Interest: 0.000';
  agentRefocusReadout.textContent = 'Refocus Pressure: 0.000';
  centroidCanvas.r = 0;  // Hide centroid
  explorationWaypoints.forEach(wp => wp.r = 0);  // Hide all waypoints
  canvasSys.render();
  updateAgentButtons();
}

// ── Layout ────────────────────────────────────────────────────────────

const leftPanel = document.createElement('div');
leftPanel.className = 'left-panel';
leftPanel.append(canvasSys.canvas);

const rightPanel = document.createElement('div');
rightPanel.className = 'right-panel';

const agentPanel = document.createElement('div');
agentPanel.className = 'agent-panel';
const agentLabel = document.createElement('div');
agentLabel.className = 'mode-label';
agentLabel.textContent = 'Agent';

const agentSensorReadout = document.createElement('div');
agentSensorReadout.className = 'gas-readout';
agentSensorReadout.textContent = 'Agent Sensor: 0.000';

const agentInterestReadout = document.createElement('div');
agentInterestReadout.className = 'gas-readout';
agentInterestReadout.textContent = 'Interest: 0.000';

const agentRefocusReadout = document.createElement('div');
agentRefocusReadout.className = 'gas-readout';
agentRefocusReadout.textContent = 'Refocus Pressure: 0.000';

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
btnReset.classList.add('full-width');

agentControls.append(btnToggle, btnReset);
agentPanel.append(agentLabel, agentControls);

rightPanel.append(mapSys.element, sim.gasReadout, agentSensorReadout, agentInterestReadout, agentRefocusReadout, agentPanel);

const layout = document.createElement('div');
layout.className = 'layout';
layout.append(leftPanel, rightPanel);
app.append(layout);

function handleResize() {
  const rect = leftPanel.getBoundingClientRect();
  const width = Math.max(400, rect.width - 24);
  const height = Math.max(300, window.innerHeight - 24);
  canvasSys.setSize(width, height);
}

window.addEventListener('resize', handleResize);
handleResize();

// ── Load default map on startup ───────────────────────────────────────

fetch('./maps/chemical_plant.yaml')
  .then((response) => response.text())
  .then((yamlText) => {
    mapSys.loadMapText(yamlText, 'chemical_plant');
  })
  .catch((err) => console.warn('Could not load default map:', err));

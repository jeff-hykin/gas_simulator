import { createCanvasSystem } from './canvas.js';
import { createMapSystem, deserializeMap } from './map.js';
import { createSimulator } from './simulator.js';
import { createPubSub } from './pubsub.js';
import { GasAgent } from './agent.js';

const app = document.getElementById('app');

const canvasSys = createCanvasSystem({ width: 900, height: 600 });

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
  samplingRate: 1,
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
  btnPlay.classList.toggle('is-active', running);
  btnPause.classList.toggle('is-active', !running && agent !== null);
}

function playAgent() {
  if (sim.agentActive) return;

  if (!agentPubSub) {
    const startPos = getStartPosition();
    agentPubSub = createPubSub();
    agent = new GasAgent(agentPubSub, {
      samplingRate: agentConfig.samplingRate,
      moveSpeed: 3,
      turnSpeed: 0.3,
      startPosition: startPos,
    });
    sim.setRobotPosition(startPos.x, startPos.y, 0);
  }

  sim.startAgentLoop(agentPubSub, agentConfig);

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

const agentControls = document.createElement('div');
agentControls.className = 'agent-controls';

const btnPlay = buildButton('Play', playAgent);
const btnPause = buildButton('Pause', pauseAgent);
const btnReset = buildButton('Reset', resetAgent);
btnReset.classList.add('full-width');

agentControls.append(btnPlay, btnPause, btnReset);
agentPanel.append(agentLabel, agentControls);

rightPanel.append(mapSys.element, sim.gasReadout, agentPanel);

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
    mapSys.loadMapText(yamlText);
  })
  .catch((err) => console.warn('Could not load default map:', err));

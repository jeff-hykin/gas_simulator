import { createCanvasSystem } from './canvas.js';
import { createMapSystem } from './map.js';
import { createSimulator } from './simulator.js';
import { createPubSub } from './pubsub.js';
import { GasAgent } from './agent.js';

const app = document.getElementById('app');

const canvasSys = createCanvasSystem({ width: 900, height: 600 });
const mapSys = createMapSystem(canvasSys);
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
    agentPubSub = createPubSub();
    agent = new GasAgent(agentPubSub, {
      samplingRate: agentConfig.samplingRate,
      moveSpeed: 3,
      turnSpeed: 0.3,
    });
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
  sim.resetRobot();
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

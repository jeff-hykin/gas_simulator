import { createCanvasSystem } from './canvas.js';
import { createMapSystem } from './map.js';
import { createSimulator } from './simulator.js';

const app = document.getElementById('app');

const canvasSys = createCanvasSystem({ width: 900, height: 600 });
const mapSys = createMapSystem(canvasSys);
const sim = createSimulator(mapSys, canvasSys);

const leftPanel = document.createElement('div');
leftPanel.className = 'left-panel';
leftPanel.append(canvasSys.canvas);

const rightPanel = document.createElement('div');
rightPanel.className = 'right-panel';
rightPanel.append(mapSys.element, sim.gasReadout);

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

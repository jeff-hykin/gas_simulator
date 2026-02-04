/**
 * @typedef {{x:number,y:number}} Point
 */

export function gaussianPeakAt(distance, radius, peak) {
  if (radius <= 0) return 0;
  const sigma2 = radius * radius;
  return peak * Math.exp(-(distance * distance) / (2 * sigma2));
}

export function maxGasAt(point, gasNodes) {
  let max = 0;
  for (const node of gasNodes) {
    const dx = point.x - node.x;
    const dy = point.y - node.y;
    const d = Math.hypot(dx, dy);
    const value = gaussianPeakAt(d, node.radius, node.peak);
    if (value > max) max = value;
  }
  return max;
}

export function createRobot({ x = 0, y = 0, w = 30, h = 20, angle = 0 } = {}) {
  return { x, y, w, h, angle };
}

/**
 * Move the robot forward along its current heading.
 * @example
 * moveForward(robot, 10);
 */
export function moveForward(robot, distance) {
  const rad = (robot.angle * Math.PI) / 180;
  robot.x += Math.cos(rad) * distance;
  robot.y += Math.sin(rad) * distance;
}

/**
 * Move the robot backward along its current heading.
 * @example
 * moveBackward(robot, 5);
 */
export function moveBackward(robot, distance) {
  moveForward(robot, -distance);
}

/**
 * Move the robot left (strafe) relative to its heading.
 * @example
 * moveLeft(robot, 8);
 */
export function moveLeft(robot, distance) {
  const rad = ((robot.angle - 90) * Math.PI) / 180;
  robot.x += Math.cos(rad) * distance;
  robot.y += Math.sin(rad) * distance;
}

/**
 * Move the robot right (strafe) relative to its heading.
 * @example
 * moveRight(robot, 8);
 */
export function moveRight(robot, distance) {
  moveLeft(robot, -distance);
}

/**
 * Rotate the robot left by a number of degrees.
 * @example
 * rotateLeft(robot, 15);
 */
export function rotateLeft(robot, degrees) {
  robot.angle = (robot.angle - degrees + 360) % 360;
}

/**
 * Rotate the robot right by a number of degrees.
 * @example
 * rotateRight(robot, 15);
 */
export function rotateRight(robot, degrees) {
  robot.angle = (robot.angle + degrees) % 360;
}

/**
 * Create the simulator system for robot + gas sensing.
 *
 * @example
 * const sim = createSimulator(mapSys, canvasSys);
 * sim.moveForward(10);
 */
export function createSimulator(mapSys, canvasSys) {
  const robot = createRobot({ x: 0, y: 0, w: 26, h: 18, angle: 0 });
  const robotCanvas = {
    type: 'rect',
    x: robot.x,
    y: robot.y,
    w: robot.w,
    h: robot.h,
    angle: robot.angle,
    stroke: '#22d3ee',
    fill: 'rgba(34,211,238,0.2)',
    lineWidth: 2,
  };

  canvasSys.addToWorld(robotCanvas);

  const gasReadout = document.createElement('div');
  gasReadout.className = 'gas-readout';
  gasReadout.textContent = 'Gas: 0.00';

  function syncRobot() {
    robotCanvas.x = robot.x;
    robotCanvas.y = robot.y;
    robotCanvas.angle = robot.angle;
    canvasSys.render();
  }

  function updateGas() {
    const gas = maxGasAt(robot, mapSys.mapData.gasNodes || []);
    gasReadout.textContent = `Gas: ${gas.toFixed(3)}`;
  }

  function step() {
    syncRobot();
    updateGas();
  }

  function ensureRobotVisible() {
    const world = canvasSys.getWorld();
    if (!world.includes(robotCanvas)) {
      canvasSys.addToWorld(robotCanvas);
    }
  }

  const keyState = new Set();
  window.addEventListener('keydown', (e) => {
    keyState.add(e.key.toLowerCase());
  });
  window.addEventListener('keyup', (e) => {
    keyState.delete(e.key.toLowerCase());
  });

  function handleKeys() {
    const speed = 3;
    const turn = 4;
    if (keyState.has('w')) moveForward(robot, speed);
    if (keyState.has('s')) moveBackward(robot, speed);
    if (keyState.has('a')) rotateLeft(robot, turn);
    if (keyState.has('d')) rotateRight(robot, turn);
    step();
    requestAnimationFrame(handleKeys);
  }

  requestAnimationFrame(handleKeys);
  step();
  ensureRobotVisible();
  setInterval(ensureRobotVisible, 3000);

  return {
    robot,
    gasReadout,
    moveForward: (d) => {
      moveForward(robot, d);
      step();
    },
    moveBackward: (d) => {
      moveBackward(robot, d);
      step();
    },
    moveLeft: (d) => {
      moveLeft(robot, d);
      step();
    },
    moveRight: (d) => {
      moveRight(robot, d);
      step();
    },
    rotateLeft: (deg) => {
      rotateLeft(robot, deg);
      step();
    },
    rotateRight: (deg) => {
      rotateRight(robot, deg);
      step();
    },
    step,
  };
}

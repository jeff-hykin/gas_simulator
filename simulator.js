/**
 * @typedef {{x:number,y:number}} Point
 */

export function gaussianPeakAt(distance, radius, peak) {
  if (radius <= 0) return 0;
  const sigma2 = radius * radius;
  return peak * Math.exp(-(distance * distance) / (2 * sigma2));
}

/**
 * Generate a normally-distributed random number (Box-Muller transform).
 * @param {number} stdDev - standard deviation
 * @returns {number}
 */
export function gaussianNoise(stdDev) {
  if (stdDev <= 0) return 0;
  const u1 = Math.random();
  const u2 = Math.random();
  return stdDev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
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

export function isPointInObstacle(point, obstacle) {
  const halfW = obstacle.w / 2;
  const halfH = obstacle.h / 2;
  return (
    point.x >= obstacle.x - halfW &&
    point.x <= obstacle.x + halfW &&
    point.y >= obstacle.y - halfH &&
    point.y <= obstacle.y + halfH
  );
}

export function isCircleInObstacle(center, radius, obstacle) {
  const halfW = obstacle.w / 2;
  const halfH = obstacle.h / 2;
  const angle = ((obstacle.angle || 0) * Math.PI) / 180;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const dx = center.x - obstacle.x;
  const dy = center.y - obstacle.y;
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  const closestX = Math.max(-halfW, Math.min(localX, halfW));
  const closestY = Math.max(-halfH, Math.min(localY, halfH));
  const distX = localX - closestX;
  const distY = localY - closestY;
  return distX * distX + distY * distY <= radius * radius;
}

export function isRobotInObstacle(robot, obstacles = []) {
  const radius = Math.max(robot.w, robot.h) / 2;
  for (const obstacle of obstacles) {
    if (isCircleInObstacle(robot, radius, obstacle)) return true;
  }
  return false;
}

function isCircleInAnyObstacle(center, radius, obstacles = []) {
  for (const obstacle of obstacles) {
    if (isCircleInObstacle(center, radius, obstacle)) return true;
  }
  return false;
}

function tryMoveWithAngle(robot, angle, distance, obstacles) {
  const rad = (angle * Math.PI) / 180;
  const radius = Math.max(robot.w, robot.h) / 2;
  const next = {
    x: robot.x + Math.cos(rad) * distance,
    y: robot.y + Math.sin(rad) * distance,
  };
  const blocked = isCircleInAnyObstacle(next, radius, obstacles);
  if (blocked) return false;
  robot.x = next.x;
  robot.y = next.y;
  robot.angle = angle;
  return true;
}

function moveWithAvoidance(robot, distance, obstacles) {
  if (!obstacles || obstacles.length === 0) {
    const rad = (robot.angle * Math.PI) / 180;
    robot.x += Math.cos(rad) * distance;
    robot.y += Math.sin(rad) * distance;
    return;
  }
  if (!isRobotInObstacle(robot, obstacles)) {
    if (tryMoveWithAngle(robot, robot.angle, distance, obstacles)) return;
  }
  const maxRotate = 90;
  const step = 5;
  for (let offset = step; offset <= maxRotate; offset += step) {
    if (tryMoveWithAngle(robot, robot.angle - offset, distance, obstacles)) return;
    if (tryMoveWithAngle(robot, robot.angle + offset, distance, obstacles)) return;
  }
}

/**
 * Move the robot forward along its current heading.
 * @example
 * moveForward(robot, 10);
 */
export function moveForward(robot, distance, obstacles = []) {
  moveWithAvoidance(robot, distance, obstacles);
}

/**
 * Move the robot backward along its current heading.
 * @example
 * moveBackward(robot, 5);
 */
export function moveBackward(robot, distance, obstacles = []) {
  moveForward(robot, -distance, obstacles);
}

/**
 * Move the robot left (strafe) relative to its heading.
 * @example
 * moveLeft(robot, 8);
 */
export function moveLeft(robot, distance, obstacles = []) {
  const rad = ((robot.angle - 90) * Math.PI) / 180;
  const radius = Math.max(robot.w, robot.h) / 2;
  const next = {
    x: robot.x + Math.cos(rad) * distance,
    y: robot.y + Math.sin(rad) * distance,
  };
  if (obstacles.length && isCircleInAnyObstacle(next, radius, obstacles)) return;
  robot.x = next.x;
  robot.y = next.y;
}

/**
 * Move the robot right (strafe) relative to its heading.
 * @example
 * moveRight(robot, 8);
 */
export function moveRight(robot, distance, obstacles = []) {
  moveLeft(robot, -distance, obstacles);
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

  let agentActive = false;
  let agentInterval = null;
  let movementUnsub = null;

  const keyState = new Set();
  window.addEventListener('keydown', (e) => {
    keyState.add(e.key.toLowerCase());
  });
  window.addEventListener('keyup', (e) => {
    keyState.delete(e.key.toLowerCase());
  });

  function handleKeys() {
    if (!agentActive) {
      const speed = 3;
      const turn = 4;
      const obstacles = mapSys.mapData.obstacles || [];
      if (keyState.has('w')) moveForward(robot, speed, obstacles);
      if (keyState.has('s')) moveBackward(robot, speed, obstacles);
      if (keyState.has('a')) rotateLeft(robot, turn);
      if (keyState.has('d')) rotateRight(robot, turn);
    }
    step();
    requestAnimationFrame(handleKeys);
  }

  requestAnimationFrame(handleKeys);
  step();
  ensureRobotVisible();
  setInterval(ensureRobotVisible, 3000);

  /**
   * Start the agent simulation loop. Publishes gas readings at the given
   * sampling rate and applies movement commands received via pubsub.
   *
   * @param {object} pubsub - must have subscribe/publish
   * @param {object} [opts]
   * @param {number} [opts.samplingRate=1]     seconds between gas readings
   * @param {number} [opts.gasNoiseStdDev=0]   Gaussian noise std-dev (PPM)
   */
  function startAgentLoop(pubsub, { samplingRate = 1, gasNoiseStdDev = 0 } = {}) {
    if (agentInterval) return;
    agentActive = true;

    movementUnsub = pubsub.subscribe('movement', ({ forward, rotation }) => {
      const obstacles = mapSys.mapData.obstacles || [];
      const deg = rotation * (180 / Math.PI);
      if (deg >= 0) rotateRight(robot, deg);
      else rotateLeft(robot, Math.abs(deg));
      if (forward >= 0) moveForward(robot, forward, obstacles);
      else moveBackward(robot, Math.abs(forward), obstacles);
      step();
    });

    agentInterval = setInterval(() => {
      const gas = maxGasAt(robot, mapSys.mapData.gasNodes || []);
      const noisy = Math.max(0, gas + gaussianNoise(gasNoiseStdDev));
      pubsub.publish('gas_reading', { ppm: noisy });
    }, samplingRate * 1000);
  }

  function stopAgentLoop() {
    if (agentInterval) {
      clearInterval(agentInterval);
      agentInterval = null;
    }
    if (movementUnsub) {
      movementUnsub();
      movementUnsub = null;
    }
    agentActive = false;
  }

  function setRobotPosition(x, y, angle = 0) {
    robot.x = x;
    robot.y = y;
    robot.angle = angle;
    step();
  }

  function resetRobot({ x = 0, y = 0, angle = 0 } = {}) {
    stopAgentLoop();
    robot.x = x;
    robot.y = y;
    robot.angle = angle;
    step();
  }

  return {
    robot,
    gasReadout,
    startAgentLoop,
    stopAgentLoop,
    setRobotPosition,
    resetRobot,
    get agentActive() { return agentActive; },
    moveForward: (d) => {
      moveForward(robot, d, mapSys.mapData.obstacles || []);
      step();
    },
    moveBackward: (d) => {
      moveBackward(robot, d, mapSys.mapData.obstacles || []);
      step();
    },
    moveLeft: (d) => {
      moveLeft(robot, d, mapSys.mapData.obstacles || []);
      step();
    },
    moveRight: (d) => {
      moveRight(robot, d, mapSys.mapData.obstacles || []);
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

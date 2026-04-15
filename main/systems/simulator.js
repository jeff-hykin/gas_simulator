/**
 * @typedef {{x:number,y:number}} Point
 */

import { createPubSub, connectNeoAgent } from '../tooling/pubsub.js';
import defaultGasAgent from '../agents/neo/hill_climber2_agent.js';
import localPlannerAgent from '../agents/neo/local_planner.js';

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

export function isCircleInAnyObstacle(center, radius, obstacles = []) {
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

export function moveWithAvoidance(robot, distance, obstacles) {
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
 * Create the simulator system for robot + gas sensing.
 *
 * @example
 * const sim = createSimulator(mapSys, canvasSys);
 * sim.startAgentLoop(pubsub);
 */
export function createSimulator(mapSys, canvasSys, { maxLinearVelocity = 20, maxAngularVelocity = Math.PI } = {}) {

  const robot = createRobot({ x: 0, y: 0, w: 16, h: 10, angle: 0 });
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

  // ── Clock System ──────────────────────────────────────────────────────
  const clock = {
    virtualTime: 0,        // Virtual time in seconds
    timeSpeed: 1.0,        // Speed multiplier (1.0 = real-time)
    isRunning: false,      // Clock running state
    lastRealTime: null,    // Last real timestamp from requestAnimationFrame
    rafId: null,           // requestAnimationFrame ID
  };

  function clockTick(realTime) {
    if (!clock.isRunning) {
      clock.lastRealTime = null;
      return;
    }

    if (clock.lastRealTime === null) {
      clock.lastRealTime = realTime;
      clock.rafId = requestAnimationFrame(clockTick);
      return;
    }

    const realDelta = (realTime - clock.lastRealTime) / 1000; // Convert ms to seconds
    const virtualDelta = realDelta * clock.timeSpeed;
    clock.virtualTime += virtualDelta;
    clock.lastRealTime = realTime;

    // Check if it's time to publish gas reading
    if (simulatorPubSub && clock.virtualTime - lastGasSampleTime >= gasSamplingRate) {
      const gas = maxGasAt(robot, mapSys.mapData.gasNodes || []);
      const noisy = Math.max(0, gas + gaussianNoise(gasNoiseStdDev));
      simulatorPubSub.publish('gas_reading', { ppm: noisy });
      maxGasPpm = Math.max(maxGasPpm, noisy);
      simulatorPubSub.publish('max_gas_reading', { ppm: maxGasPpm });
      lastGasSampleTime = clock.virtualTime;
    }

    // Publish time and odometry at the tick rate
    if (simulatorPubSub && clock.virtualTime - lastTickTime >= tickRate) {
      simulatorPubSub.publish('time', {
        virtualTime: clock.virtualTime,
      });
      simulatorPubSub.publish('odom', {
        x: robot.x,
        y: robot.y,
        heading: robot.angle * (Math.PI / 180),
      });
      lastTickTime = clock.virtualTime;
    }

    clock.rafId = requestAnimationFrame(clockTick);
  }

  function pauseClock() {
    clock.isRunning = false;
    if (clock.rafId !== null) {
      cancelAnimationFrame(clock.rafId);
      clock.rafId = null;
    }
  }

  function playClock() {
    if (!clock.isRunning) {
      clock.isRunning = true;
      clock.lastRealTime = null;
      clock.rafId = requestAnimationFrame(clockTick);
    }
  }

  function resetClock() {
    pauseClock();
    clock.virtualTime = 0;
    clock.lastRealTime = null;
    maxGasPpm = 0;
  }

  function setTimeSpeed(speed) {
    clock.timeSpeed = Math.max(0, speed);
  }

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

  /**
   * Apply velocity-based movement to the robot. Caps velocities to max robot capabilities
   * and calculates actual movement based on time elapsed since last command.
   *
   * @param {number} linearVelocity - desired forward velocity in meters/second
   * @param {number} angularVelocity - desired rotation velocity in radians/second
   */
  function move(linearVelocity, angularVelocity) {
    // Treat inputs as per-tick displacement, not velocity.
    // The tick rate controls how many decisions per second (slow motion effect).
    const linearDistance = Math.max(-maxLinearVelocity, Math.min(linearVelocity, maxLinearVelocity));
    const angularDistance = Math.max(-maxAngularVelocity, Math.min(angularVelocity, maxAngularVelocity));

    const obstacles = mapSys.mapData.obstacles || [];

    const beforeX = robot.x, beforeY = robot.y, beforeAngle = robot.angle;

    // Apply rotation (inline from rotateLeft/rotateRight)
    const angularDeg = angularDistance * (180 / Math.PI);
    robot.angle = (robot.angle + angularDeg + 360) % 360;

    // Apply linear movement (inline from moveForward/moveWithAvoidance)
    moveWithAvoidance(robot, linearDistance, obstacles);

    // console.log(`[MOVE] linDist=${linearDistance.toFixed(2)} angDist=${angularDistance.toFixed(2)}rad(${(angularDistance*180/Math.PI).toFixed(1)}°) before=(${beforeX.toFixed(1)},${beforeY.toFixed(1)},${beforeAngle.toFixed(1)}°) after=(${robot.x.toFixed(1)},${robot.y.toFixed(1)},${robot.angle.toFixed(1)}°)`);
  }

  let agentActive = false;
  let simulatorPubSub = null;
  let agentUnsubs = [];
  let movementUnsub = null;
  let lastGasSampleTime = 0; // Track last gas sample in virtual time
  let lastTickTime = 0; // Track last agent tick in virtual time
  let gasSamplingRate = 1; // Seconds between gas readings
  let tickRate = 1; // Seconds between agent ticks (odom/time publishing)
  let gasNoiseStdDev = 0; // Gaussian noise std-dev
  let maxGasPpm = 0; // Running max of gas readings (hardware limitation: sensor only reports max)

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
      if (keyState.has('w')) moveWithAvoidance(robot, speed, obstacles);
      if (keyState.has('s')) moveWithAvoidance(robot, -speed, obstacles);
      if (keyState.has('a')) robot.angle = (robot.angle - turn + 360) % 360;
      if (keyState.has('d')) robot.angle = (robot.angle + turn) % 360;
    }
    step();
    requestAnimationFrame(handleKeys);
  }

  requestAnimationFrame(handleKeys);
  step();
  ensureRobotVisible();
  setInterval(ensureRobotVisible, 3000);

  /**
   * Start the agent simulation loop. Creates the agent, local planner, and starts publishing sensor data.
   *
   * @param {object} pubsub - pubsub instance { subscribe, publish }
   * @param {object} config - agent configuration
   */
  function startAgentLoop(pubsub, config = {}) {
    if (agentActive) return;
    agentActive = true;
    simulatorPubSub = pubsub;

    const getTime = () => clock.virtualTime;

    // Bridge channel names to what the neo agents expect
    const unsubBridgePosition = pubsub.subscribe('odom', (data) => {
      console.log(`[SIM-BRIDGE] odom→position x=${data.x.toFixed(1)} y=${data.y.toFixed(1)} heading=${data.heading.toFixed(2)}rad (${(data.heading * 180 / Math.PI).toFixed(1)}°)`);
      pubsub.publish('position', data);
    });
    const unsubBridgeRoute = pubsub.subscribe('route_update', (data) => pubsub.publish('routeUpdate', data));
    const unsubBridgeGas = pubsub.subscribe('gas_reading', (data) => pubsub.publish('gasReading', data.ppm));
    const unsubBridgeMaxGas = pubsub.subscribe('max_gas_reading', (data) => pubsub.publish('maxGasReading', data.ppm));

    // Connect neo agents
    agentUnsubs = [
      unsubBridgePosition,
      unsubBridgeRoute,
      unsubBridgeGas,
      unsubBridgeMaxGas,
      connectNeoAgent(pubsub, (config.gasAgent ?? defaultGasAgent).create({}), getTime),
      connectNeoAgent(pubsub, localPlannerAgent.create({
        closeEnoughToWaypoint: config.waypointThreshold ?? 10,
      }), getTime),
    ];

    // Store gas sampling parameters for clock tick handler
    tickRate = config.decisionRate ?? 1;
    gasSamplingRate = config.decisionRate ?? 1;
    gasNoiseStdDev = config.gasNoiseStdDev ?? 0;

    // Set clock speed and start clock
    setTimeSpeed(config.timeSpeed ?? 1.0);
    lastGasSampleTime = clock.virtualTime;
    lastTickTime = clock.virtualTime;
    playClock();

    // Publish initial odometry so agent knows its starting pose
    simulatorPubSub.publish('odom', {
      x: robot.x,
      y: robot.y,
      heading: robot.angle * (Math.PI / 180),
    });

    movementUnsub = simulatorPubSub.subscribe('movement', (data) => {
      move(data.linearVelocity ?? 0, data.angularVelocity ?? 0);
      step();
    });
  }

  function stopAgentLoop() {
    for (const unsub of agentUnsubs) unsub();
    agentUnsubs = [];
    if (movementUnsub) {
      movementUnsub();
      movementUnsub = null;
    }
    pauseClock();
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
    // Clock control methods
    pause: pauseClock,
    play: playClock,
    reset: resetClock,
    setTimeSpeed,
    get virtualTime() { return clock.virtualTime; },
    get timeSpeed() { return clock.timeSpeed; },
    get isClockRunning() { return clock.isRunning; },
  };
}

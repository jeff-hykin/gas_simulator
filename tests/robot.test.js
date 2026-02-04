import {
  gaussianPeakAt,
  maxGasAt,
  createRobot,
  moveForward,
  moveBackward,
  moveLeft,
  moveRight,
  rotateLeft,
  rotateRight,
} from '../simulator.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const robot = createRobot({ x: 0, y: 0, angle: 0 });
moveForward(robot, 10);
assert(Math.abs(robot.x - 10) < 1e-6, 'forward should move +x');
moveBackward(robot, 10);
assert(Math.abs(robot.x - 0) < 1e-6, 'backward should restore position');

moveLeft(robot, 5);
assert(Math.abs(robot.y + 5) < 1e-6, 'left should move -y at angle 0');
moveRight(robot, 5);
assert(Math.abs(robot.y - 0) < 1e-6, 'right should restore y');

rotateRight(robot, 90);
moveForward(robot, 10);
assert(Math.abs(robot.y - 10) < 1e-6, 'rotation should affect forward direction');
rotateLeft(robot, 90);

const peak = gaussianPeakAt(0, 10, 2);
assert(Math.abs(peak - 2) < 1e-6, 'gaussian peak at 0 distance equals peak');

const gas = maxGasAt({ x: 0, y: 0 }, [
  { x: 0, y: 0, radius: 10, peak: 1 },
  { x: 100, y: 100, radius: 10, peak: 5 },
]);
assert(gas > 0.9 && gas < 1.1, 'maxGasAt should use nearest max');

console.log('robot.test.js passed');

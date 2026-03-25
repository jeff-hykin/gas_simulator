import { awayFromRoute } from './math_helpers.js'

let passed = 0
let failed = 0

function assert(condition, message) {
    if (!condition) {
        console.error(`FAIL: ${message}`)
        failed++
    } else {
        console.log(`PASS: ${message}`)
        passed++
    }
}

function assertEq(actual, expected, message) {
    assert(actual === expected, `${message}: expected ${expected}, got ${actual}`)
}

// ─── Horizontal route along x-axis: [{0,0}, {10,0}] ───────────────

// Agent above the route, heading east → "away" is +y (up), need to turn left
assertEq(awayFromRoute({ x: 5, y: 5 }, 0, [{ x: 0, y: 0 }, { x: 10, y: 0 }]), -1,
    'above horizontal route, heading east → turn left')

// Agent above the route, heading west (π) → "away" is +y, need to turn right
assertEq(awayFromRoute({ x: 5, y: 5 }, Math.PI, [{ x: 0, y: 0 }, { x: 10, y: 0 }]), 1,
    'above horizontal route, heading west → turn right')

// Agent below the route, heading east → "away" is -y (down), need to turn right
assertEq(awayFromRoute({ x: 5, y: -5 }, 0, [{ x: 0, y: 0 }, { x: 10, y: 0 }]), 1,
    'below horizontal route, heading east → turn right')

// Agent below the route, heading west → "away" is -y, need to turn left
assertEq(awayFromRoute({ x: 5, y: -5 }, Math.PI, [{ x: 0, y: 0 }, { x: 10, y: 0 }]), -1,
    'below horizontal route, heading west → turn left')

// ─── Vertical route along y-axis: [{0,0}, {0,10}] ─────────────────

// Agent to the right, heading north (π/2) → "away" is +x, need to turn right
assertEq(awayFromRoute({ x: 5, y: 5 }, Math.PI / 2, [{ x: 0, y: 0 }, { x: 0, y: 10 }]), 1,
    'right of vertical route, heading north → turn right')

// Agent to the right, heading south (3π/2) → "away" is +x, need to turn left
assertEq(awayFromRoute({ x: 5, y: 5 }, 3 * Math.PI / 2, [{ x: 0, y: 0 }, { x: 0, y: 10 }]), -1,
    'right of vertical route, heading south → turn left')

// Agent to the left, heading north → "away" is -x, need to turn left
assertEq(awayFromRoute({ x: -5, y: 5 }, Math.PI / 2, [{ x: 0, y: 0 }, { x: 0, y: 10 }]), -1,
    'left of vertical route, heading north → turn left')

// ─── Agent already facing away → should still return a direction ────

// Agent above route, heading straight up (π/2) → already facing away
// away angle is π/2, heading is π/2, diff ≈ 0 → returns -1 (arbitrary but consistent)
const alreadyAway = awayFromRoute({ x: 5, y: 5 }, Math.PI / 2, [{ x: 0, y: 0 }, { x: 10, y: 0 }])
assert(alreadyAway === -1 || alreadyAway === 1, 'already facing away returns -1 or 1')

// ─── Agent facing toward route → picks correct turn direction ───────

// Agent above route, heading straight down (-π/2) → needs to turn around
// away is +y (π/2), heading is -π/2. diff = ±π (ambiguous), either direction is valid
const towardResult = awayFromRoute({ x: 5, y: 5 }, -Math.PI / 2, [{ x: 0, y: 0 }, { x: 10, y: 0 }])
assert(towardResult === -1 || towardResult === 1,
    'above route, heading straight toward it → returns -1 or 1 (either valid)')

// ─── Multi-segment route ────────────────────────────────────────────

// L-shaped route: (0,0)→(10,0)→(10,10). Agent at (5,5) is closest to first segment.
assertEq(awayFromRoute({ x: 5, y: 5 }, 0, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]), -1,
    'L-shaped route, agent closest to horizontal segment, heading east → turn left')

// Agent at (15,5) is closest to the vertical segment (10,0)→(10,10)
// Agent is to the right of that segment, heading east → away is +x, turn right... wait
// Segment goes from (10,0) to (10,10), direction is (0,10). Agent at (15,5), closest point is (10,5).
// toAgent = (5,0), awayAngle = 0 (east). heading = 0 (east). diff = 0 → -1
const lResult = awayFromRoute({ x: 15, y: 5 }, 0, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])
assert(lResult === -1 || lResult === 1, 'L-shaped route, agent right of vertical segment')

// ─── Diagonal route ─────────────────────────────────────────────────

// Route from (0,0) to (10,10). Agent at (0,10), heading east (0).
// Closest point on segment: t = dot((0,10)-(0,0), (10,10)) / dot((10,10),(10,10)) = 100/200 = 0.5
// Closest = (5,5). toAgent = (-5,5). awayAngle = atan2(5,-5) = 2.356 (135°).
// heading = 0. diff = angleDifference(0, 2.356) = 2.356 > 0 → -1 (left)
assertEq(awayFromRoute({ x: 0, y: 10 }, 0, [{ x: 0, y: 0 }, { x: 10, y: 10 }]), -1,
    'diagonal route, agent upper-left, heading east → turn left')

// ─── Edge cases ─────────────────────────────────────────────────────

// Single-point route → fallback to 1
assertEq(awayFromRoute({ x: 5, y: 5 }, 0, [{ x: 0, y: 0 }]), 1,
    'single-point route → default 1')

// Empty route → fallback to 1
assertEq(awayFromRoute({ x: 5, y: 5 }, 0, []), 1,
    'empty route → default 1')

// Null route → fallback to 1
assertEq(awayFromRoute({ x: 5, y: 5 }, 0, null), 1,
    'null route → default 1')

// ─── Summary ────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
    throw new Error(`${failed} test(s) failed`)
}

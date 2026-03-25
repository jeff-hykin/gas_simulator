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

const hRoute = [{ x: 0, y: 0 }, { x: 10, y: 0 }]
const vRoute = [{ x: 0, y: 0 }, { x: 0, y: 10 }]

// ─── Horizontal route along x-axis ─────────────────────────────────

assertEq(awayFromRoute({ location: { x: 5, y: 5 }, heading: 0, route: hRoute }), -1,
    'above horizontal route, heading east → turn left')

assertEq(awayFromRoute({ location: { x: 5, y: 5 }, heading: Math.PI, route: hRoute }), 1,
    'above horizontal route, heading west → turn right')

assertEq(awayFromRoute({ location: { x: 5, y: -5 }, heading: 0, route: hRoute }), 1,
    'below horizontal route, heading east → turn right')

assertEq(awayFromRoute({ location: { x: 5, y: -5 }, heading: Math.PI, route: hRoute }), -1,
    'below horizontal route, heading west → turn left')

// ─── Vertical route along y-axis ───────────────────────────────────

assertEq(awayFromRoute({ location: { x: 5, y: 5 }, heading: Math.PI / 2, route: vRoute }), 1,
    'right of vertical route, heading north → turn right')

assertEq(awayFromRoute({ location: { x: 5, y: 5 }, heading: 3 * Math.PI / 2, route: vRoute }), -1,
    'right of vertical route, heading south → turn left')

assertEq(awayFromRoute({ location: { x: -5, y: 5 }, heading: Math.PI / 2, route: vRoute }), -1,
    'left of vertical route, heading north → turn left')

// ─── Already facing away ────────────────────────────────────────────

const alreadyAway = awayFromRoute({ location: { x: 5, y: 5 }, heading: Math.PI / 2, route: hRoute })
assert(alreadyAway === -1 || alreadyAway === 1, 'already facing away returns -1 or 1')

// ─── Facing toward route (ambiguous ±π) ─────────────────────────────

const towardResult = awayFromRoute({ location: { x: 5, y: 5 }, heading: -Math.PI / 2, route: hRoute })
assert(towardResult === -1 || towardResult === 1,
    'above route, heading straight toward it → returns -1 or 1 (either valid)')

// ─── Multi-segment route ────────────────────────────────────────────

const lRoute = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]

assertEq(awayFromRoute({ location: { x: 5, y: 5 }, heading: 0, route: lRoute }), -1,
    'L-shaped route, agent closest to horizontal segment, heading east → turn left')

const lResult = awayFromRoute({ location: { x: 15, y: 5 }, heading: 0, route: lRoute })
assert(lResult === -1 || lResult === 1, 'L-shaped route, agent right of vertical segment')

// ─── Diagonal route ─────────────────────────────────────────────────

assertEq(awayFromRoute({ location: { x: 0, y: 10 }, heading: 0, route: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }), -1,
    'diagonal route, agent upper-left, heading east → turn left')

// ─── Edge cases ─────────────────────────────────────────────────────

assertEq(awayFromRoute({ location: { x: 5, y: 5 }, heading: 0, route: [{ x: 0, y: 0 }] }), 1,
    'single-point route → default 1')

assertEq(awayFromRoute({ location: { x: 5, y: 5 }, heading: 0, route: [] }), 1,
    'empty route → default 1')

assertEq(awayFromRoute({ location: { x: 5, y: 5 }, heading: 0, route: null }), 1,
    'null route → default 1')

// ─── Summary ────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
    throw new Error(`${failed} test(s) failed`)
}

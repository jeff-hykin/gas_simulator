import { simpleRouteAgent, DEFAULT_STATE } from '../simple_route_agent_pure.js'

function assert(condition, message) {
    if (!condition) throw new Error(message)
}

function assertEq(a, b, message) {
    if (a !== b) throw new Error(`${message}: expected ${b}, got ${a}`)
}

function assertNull(v, message) {
    if (v !== null) throw new Error(`${message}: expected null, got ${JSON.stringify(v)}`)
}

function assertNotNull(v, message) {
    if (v === null || v === undefined) throw new Error(`${message}: expected non-null`)
}

// --- routeUpdate publishes first waypoint immediately ---
{
    const { state, targetWaypoint, logJson } = simpleRouteAgent(DEFAULT_STATE, {
        time: 0,
        routeUpdate: { waypoints: [{ x: 10, y: 20 }, { x: 30, y: 40 }] },
    })
    assertNotNull(targetWaypoint, 'routeUpdate should emit first waypoint')
    assertEq(targetWaypoint.x, 10, 'first waypoint x')
    assertEq(targetWaypoint.y, 20, 'first waypoint y')
    assertNotNull(logJson, 'routeUpdate should emit logJson')
    assertEq(state.currentWaypointIndex, 0, 'index stays 0 after routeUpdate')
    assertEq(state.routeWaypoints.length, 2, 'route stored in state')
}

// --- does not re-emit same waypoint on next tick ---
{
    let { state } = simpleRouteAgent(DEFAULT_STATE, {
        time: 0,
        routeUpdate: { waypoints: [{ x: 10, y: 20 }] },
    })
    const { targetWaypoint } = simpleRouteAgent(state, { time: 1 })
    assertNull(targetWaypoint, 'should not re-emit waypoint with no change')
}

// --- waypointReached advances to next waypoint ---
{
    let { state } = simpleRouteAgent(DEFAULT_STATE, {
        time: 0,
        routeUpdate: { waypoints: [{ x: 10, y: 20 }, { x: 30, y: 40 }] },
    })
    const { state: s2, targetWaypoint } = simpleRouteAgent(state, {
        time: 1,
        waypointReached: true,
    })
    assertEq(s2.currentWaypointIndex, 1, 'index incremented after waypointReached')
    assertNotNull(targetWaypoint, 'should emit second waypoint after waypointReached')
    assertEq(targetWaypoint.x, 30, 'second waypoint x')
    assertEq(targetWaypoint.y, 40, 'second waypoint y')
}

// --- waypointReached on last waypoint logs completion, no new target ---
{
    let { state } = simpleRouteAgent(DEFAULT_STATE, {
        time: 0,
        routeUpdate: { waypoints: [{ x: 10, y: 20 }] },
    })
    const { state: s2, targetWaypoint } = simpleRouteAgent(state, {
        time: 1,
        waypointReached: true,
    })
    assertEq(s2.currentWaypointIndex, 1, 'index goes past end')
    assertNull(targetWaypoint, 'no target after final waypoint reached')
}

// --- position update stores position in state ---
{
    let { state } = simpleRouteAgent(DEFAULT_STATE, {
        time: 0,
        routeUpdate: { waypoints: [{ x: 100, y: 0 }] },
    })
    const { state: s2 } = simpleRouteAgent(state, {
        time: 1,
        position: { x: 5, y: 0 },
    })
    assertEq(s2.position.x, 5, 'position x stored')
    assertEq(s2.position.y, 0, 'position y stored')
}

// --- negative velocity for >1s skips waypoint ---
{
    // Waypoint at x=10. Robot approaches then retreats.
    let { state } = simpleRouteAgent(DEFAULT_STATE, {
        time: 0,
        routeUpdate: { waypoints: [{ x: 10, y: 0 }, { x: 20, y: 0 }] },
    })
    // t=1: at x=7, distance=3 — establishes baseline (lastDistanceCheck=null before this)
    ;({ state } = simpleRouteAgent(state, { time: 1, position: { x: 7, y: 0 } }))
    // t=2: at x=9, distance=1 — moving toward (positive velocity), timer stays null
    ;({ state } = simpleRouteAgent(state, { time: 2, position: { x: 9, y: 0 } }))
    // t=3: at x=7, distance=3 — moving away (negative velocity starts)
    ;({ state } = simpleRouteAgent(state, { time: 3, position: { x: 7, y: 0 } }))
    assertNotNull(state.negativeVelocityStartTime, 'negative velocity timer should be set')
    // t=3.5: still moving away, <1s elapsed — no skip yet
    const { state: s4, targetWaypoint: tw4 } = simpleRouteAgent(state, {
        time: 3.5,
        position: { x: 6, y: 0 },
    })
    assertEq(s4.currentWaypointIndex, 0, 'should not skip before 1s of negative velocity')
    assertNull(tw4, 'no new waypoint emitted yet')
    // t=4.1: still moving away, >1s elapsed — skip
    const { state: s5, targetWaypoint: tw5 } = simpleRouteAgent(s4, {
        time: 4.1,
        position: { x: 5, y: 0 },
    })
    assertEq(s5.currentWaypointIndex, 1, 'waypoint skipped after 1s negative velocity')
    assertNotNull(tw5, 'new waypoint emitted after skip')
    assertEq(tw5.x, 20, 'skipped to second waypoint x')
}

// --- negative velocity resets when moving toward target again ---
{
    // Waypoint at x=10. Approach, retreat, then approach again.
    let { state } = simpleRouteAgent(DEFAULT_STATE, {
        time: 0,
        routeUpdate: { waypoints: [{ x: 10, y: 0 }] },
    })
    // t=1: at x=7, distance=3 — baseline
    ;({ state } = simpleRouteAgent(state, { time: 1, position: { x: 7, y: 0 } }))
    // t=2: at x=5, distance=5 — moving away, neg velocity timer set
    ;({ state } = simpleRouteAgent(state, { time: 2, position: { x: 5, y: 0 } }))
    assert(state.negativeVelocityStartTime !== null, 'neg velocity timer set')
    // t=3: at x=8, distance=2 — moving toward, timer should clear
    ;({ state } = simpleRouteAgent(state, { time: 3, position: { x: 8, y: 0 } }))
    assertNull(state.negativeVelocityStartTime, 'neg velocity timer cleared when moving toward target')
}

// --- routeUpdate resets index and re-emits waypoint ---
{
    let { state } = simpleRouteAgent(DEFAULT_STATE, {
        time: 0,
        routeUpdate: { waypoints: [{ x: 10, y: 0 }, { x: 20, y: 0 }] },
    })
    // Advance to waypoint 2
    ;({ state } = simpleRouteAgent(state, { time: 1, waypointReached: true }))
    assertEq(state.currentWaypointIndex, 1, 'at waypoint 2')
    // New route resets
    const { state: s2, targetWaypoint } = simpleRouteAgent(state, {
        time: 2,
        routeUpdate: { waypoints: [{ x: 99, y: 99 }] },
    })
    assertEq(s2.currentWaypointIndex, 0, 'index reset after new route')
    assertNotNull(targetWaypoint, 'new route emits first waypoint')
    assertEq(targetWaypoint.x, 99, 'new route first waypoint x')
}

// --- state is not mutated ---
{
    const frozen = Object.freeze({ ...DEFAULT_STATE })
    const { state } = simpleRouteAgent(frozen, {
        time: 0,
        routeUpdate: { waypoints: [{ x: 1, y: 2 }] },
    })
    assert(state !== frozen, 'returned state is a new object')
    assertEq(DEFAULT_STATE.routeWaypoints.length, 0, 'DEFAULT_STATE not mutated')
}

// --- no route: no output ---
{
    const { targetWaypoint, logJson } = simpleRouteAgent(DEFAULT_STATE, { time: 0 })
    assertNull(targetWaypoint, 'no target with empty route')
    assertNull(logJson, 'no logJson with empty route')
}

console.log('simple_route_agent_pure.test.js passed')

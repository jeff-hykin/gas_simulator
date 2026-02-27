import simpleRouteAgent from './simple_route_agent.js'
const { create: createSimpleRouteAgent } = simpleRouteAgent

function assert(condition, message) {
    if (!condition) throw new Error(message)
}
function assertEq(a, b, message) {
    if (a !== b) throw new Error(`${message}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}
function assertNull(v, message) {
    if (v !== null) throw new Error(`${message}: expected null, got ${JSON.stringify(v)}`)
}
function assertNotNull(v, message) {
    if (v === null || v === undefined) throw new Error(`${message}: expected non-null`)
}

// Calls update with explicit time and input fields merged into state
function step(agent, state, { time = 0, routeUpdate = null, position = null, waypointReached = null } = {}) {
    const { state: nextState, outputs } = agent.update(() => time, {
        state: { ...state, time, routeUpdate, position, waypointReached },
        updated: {
            routeUpdate: routeUpdate != null,
            waypointReached: waypointReached != null,
            position: position != null,
        },
    })
    return { state: nextState, targetWaypoint: outputs.targetWaypoint, logJson: outputs.logJson }
}

Deno.test('factory creates agent with initialArg and update', () => {
    const agent = createSimpleRouteAgent({})
    assert(typeof agent.update === 'function', 'update should be a function')
    assertNotNull(agent.initialArg, 'initialArg should exist')
    assertEq(agent.initialArg.state.routeWaypoints.length, 0, 'initial route is empty')
    assertEq(agent.initialArg.state.currentWaypointIndex, 0, 'initial index is 0')
    assertNull(agent.initialArg.state.currentPublishedWaypoint, 'initial published waypoint is null')
})

Deno.test('routeUpdate publishes first waypoint immediately', () => {
    const agent = createSimpleRouteAgent({})
    const { state, targetWaypoint, logJson } = step(agent, agent.initialArg.state, {
        time: 0,
        routeUpdate: { waypoints: [{ x: 10, y: 20 }, { x: 30, y: 40 }] },
    })
    assertNotNull(targetWaypoint, 'routeUpdate should emit first waypoint')
    assertEq(targetWaypoint.x, 10, 'first waypoint x')
    assertEq(targetWaypoint.y, 20, 'first waypoint y')
    assertNotNull(logJson, 'routeUpdate should emit logJson')
    assertEq(state.currentWaypointIndex, 0, 'index stays 0 after routeUpdate')
    assertEq(state.routeWaypoints.length, 2, 'route stored in state')
})

Deno.test('does not re-emit same waypoint on next tick', () => {
    const agent = createSimpleRouteAgent({})
    let { state } = step(agent, agent.initialArg.state, {
        time: 0,
        routeUpdate: { waypoints: [{ x: 10, y: 20 }] },
    })
    const { targetWaypoint } = step(agent, state, { time: 1 })
    assertNull(targetWaypoint, 'should not re-emit waypoint with no change')
})

Deno.test('waypointReached advances to next waypoint', () => {
    const agent = createSimpleRouteAgent({})
    let { state } = step(agent, agent.initialArg.state, {
        time: 0,
        routeUpdate: { waypoints: [{ x: 10, y: 20 }, { x: 30, y: 40 }] },
    })
    const { state: s2, targetWaypoint } = step(agent, state, { time: 1, waypointReached: true })
    assertEq(s2.currentWaypointIndex, 1, 'index incremented after waypointReached')
    assertNotNull(targetWaypoint, 'should emit second waypoint after waypointReached')
    assertEq(targetWaypoint.x, 30, 'second waypoint x')
    assertEq(targetWaypoint.y, 40, 'second waypoint y')
})

Deno.test('waypointReached on last waypoint emits no new target', () => {
    const agent = createSimpleRouteAgent({})
    let { state } = step(agent, agent.initialArg.state, {
        time: 0,
        routeUpdate: { waypoints: [{ x: 10, y: 20 }] },
    })
    const { state: s2, targetWaypoint } = step(agent, state, { time: 1, waypointReached: true })
    assertEq(s2.currentWaypointIndex, 1, 'index goes past end')
    assertNull(targetWaypoint, 'no target after final waypoint reached')
})

Deno.test('position update is stored in state', () => {
    const agent = createSimpleRouteAgent({})
    let { state } = step(agent, agent.initialArg.state, {
        time: 0,
        routeUpdate: { waypoints: [{ x: 100, y: 0 }] },
    })
    const { state: s2 } = step(agent, state, { time: 1, position: { x: 5, y: 3 } })
    assertEq(s2.position.x, 5, 'position x stored')
    assertEq(s2.position.y, 3, 'position y stored')
})

Deno.test('skips waypoint when progress drops below minProgress', () => {
    const agent = createSimpleRouteAgent({ minProgress: 10 })
    let { state } = step(agent, agent.initialArg.state, {
        time: 0,
        routeUpdate: { waypoints: [{ x: 100, y: 0 }, { x: 200, y: 0 }] },
        position: { x: 0, y: 0 },
    })
    // at t=3 robot has not moved: progress = (100 - 100) / 3 = 0 < 10 → skip
    const { state: s2, targetWaypoint } = step(agent, state, { time: 3, position: { x: 0, y: 0 } })
    assertEq(s2.currentWaypointIndex, 1, 'waypoint skipped when progress below minProgress')
    assertNotNull(targetWaypoint, 'second waypoint emitted after skip')
    assertEq(targetWaypoint.x, 200, 'skipped to second waypoint')
})

Deno.test('does not skip when making good progress', () => {
    const agent = createSimpleRouteAgent({ minProgress: 10 })
    let { state } = step(agent, agent.initialArg.state, {
        time: 0,
        routeUpdate: { waypoints: [{ x: 100, y: 0 }] },
        position: { x: 0, y: 0 },
    })
    // at t=5 robot closed 55 of 100 units: progress = 55/5 = 11 > 10 → no skip
    ;({ state } = step(agent, state, { time: 5, position: { x: 55, y: 0 } }))
    assertEq(state.currentWaypointIndex, 0, 'should not skip when making good progress')
})

Deno.test('new routeUpdate resets index and re-emits first waypoint', () => {
    const agent = createSimpleRouteAgent({})
    let { state } = step(agent, agent.initialArg.state, {
        time: 0,
        routeUpdate: { waypoints: [{ x: 10, y: 0 }, { x: 20, y: 0 }] },
    })
    ;({ state } = step(agent, state, { time: 1, waypointReached: true }))
    assertEq(state.currentWaypointIndex, 1, 'at second waypoint')

    const { state: s2, targetWaypoint } = step(agent, state, {
        time: 2,
        routeUpdate: { waypoints: [{ x: 99, y: 99 }] },
    })
    assertEq(s2.currentWaypointIndex, 0, 'index reset after new route')
    assertNotNull(targetWaypoint, 'new route emits first waypoint')
    assertEq(targetWaypoint.x, 99, 'new route first waypoint x')
})

Deno.test('empty route emits no output', () => {
    const agent = createSimpleRouteAgent({})
    const { targetWaypoint, logJson } = step(agent, agent.initialArg.state, { time: 0 })
    assertNull(targetWaypoint, 'no target with empty route')
    assertNull(logJson, 'no logJson with empty route')
})

import localPlanner from './local_planner.js'
const { create: createLocalPlanner } = localPlanner

function assert(condition, message) {
    if (!condition) throw new Error(message)
}
function assertEq(a, b, message) {
    if (a !== b) throw new Error(`${message}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}
function assertNull(v, message) {
    if (v !== null && v !== undefined) throw new Error(`${message}: expected null/undefined, got ${JSON.stringify(v)}`)
}
function assertNotNull(v, message) {
    if (v === null || v === undefined) throw new Error(`${message}: expected non-null`)
}
function assertClose(a, b, eps = 1e-6, message = '') {
    if (Math.abs(a - b) > eps) throw new Error(`${message}: expected ${a} ≈ ${b} (eps=${eps})`)
}

// Mutable clock for timer control
function makeClock(initial = 0) {
    let t = initial
    return {
        get time() { return t },
        set time(v) { t = v },
        getTime: () => t,
        advance: (dt) => { t += dt },
    }
}

// Call update with explicit inputs merged into state
function step(agent, clock, state, updated, inputs = {}) {
    const { state: nextState, outputs } = agent.update(clock.getTime, {
        state: { ...state, ...inputs },
        updated: { ...agent.initialArg.updated, ...updated },
    })
    return {
        state: nextState,
        movement: outputs.movement,
        waypointReached: outputs.waypointReached,
        logJson: outputs.logJson,
    }
}

Deno.test('factory creates agent with initialArg and update', () => {
    const agent = createLocalPlanner({})
    assert(typeof agent.update === 'function', 'update should be a function')
    assertNotNull(agent.initialArg, 'initialArg should exist')
    assertEq(agent.initialArg.state.mode, 'idle', 'initial mode is idle')
    assertNull(agent.initialArg.state.odom, 'initial odom is null')
    assertNull(agent.initialArg.state.targetWaypoint, 'initial targetWaypoint is null')
})

Deno.test('returns idle state when odom is missing', () => {
    const agent = createLocalPlanner({})
    const clock = makeClock(0)
    const state = { ...agent.initialArg.state, time: 0, targetWaypoint: { x: 50, y: 0 } }
    const { state: s, movement } = step(agent, clock, state, { targetWaypoint: true }, { odom: null })
    assertEq(s.mode, 'idle', 'mode stays idle without odom')
    assertNull(movement, 'no movement emitted when idle')
})

Deno.test('returns idle state when targetWaypoint is missing', () => {
    const agent = createLocalPlanner({})
    const clock = makeClock(0)
    const odom = { x: 0, y: 0, heading: 0 }
    const state = { ...agent.initialArg.state, time: 0, odom }
    const { state: s, movement } = step(agent, clock, state, { odom: true })
    assertEq(s.mode, 'idle', 'mode stays idle without targetWaypoint')
    assertNull(movement, 'no movement emitted when idle')
})

Deno.test('switches from idle to greedy when odom and targetWaypoint provided', () => {
    const agent = createLocalPlanner({})
    const clock = makeClock(0)
    const odom = { x: 0, y: 0, heading: 0 }
    const targetWaypoint = { x: 100, y: 0 }
    const state = { ...agent.initialArg.state, time: 0, odom, targetWaypoint }
    const { state: s } = step(agent, clock, state, { odom: true, targetWaypoint: true })
    assertEq(s.mode, 'greedy', 'mode switches to greedy')
})

Deno.test('greedy mode emits movement toward waypoint', () => {
    const agent = createLocalPlanner({})
    const clock = makeClock(0)
    const odom = { x: 0, y: 0, heading: 0 }
    const targetWaypoint = { x: 100, y: 0 }
    const state = { ...agent.initialArg.state, time: 0, odom, targetWaypoint }
    const { movement } = step(agent, clock, state, { odom: true, targetWaypoint: true })
    assertNotNull(movement, 'movement should be emitted in greedy mode')
    assert(movement.linearVelocity > 0, 'linear velocity should be positive')
})

Deno.test('greedy mode: movement angular velocity is 0 when heading directly at waypoint', () => {
    const agent = createLocalPlanner({})
    const clock = makeClock(0)
    // robot at origin heading east (angle 0), waypoint due east → no turn needed
    const odom = { x: 0, y: 0, heading: 0 }
    const targetWaypoint = { x: 100, y: 0 }
    const state = { ...agent.initialArg.state, time: 0, odom, targetWaypoint }
    const { movement } = step(agent, clock, state, { odom: true, targetWaypoint: true })
    assertNotNull(movement, 'movement emitted')
    assertClose(movement.angularVelocity, 0, 1e-6, 'no turning needed when heading at waypoint')
})

Deno.test('greedy mode: angular velocity is positive when waypoint is to the left', () => {
    const agent = createLocalPlanner({})
    const clock = makeClock(0)
    // robot at origin heading east (0), waypoint is north (y > 0) → turn left (positive angular vel)
    const odom = { x: 0, y: 0, heading: 0 }
    const targetWaypoint = { x: 0, y: 100 }
    const state = { ...agent.initialArg.state, time: 0, odom, targetWaypoint }
    const { movement } = step(agent, clock, state, { odom: true, targetWaypoint: true })
    assertNotNull(movement, 'movement emitted')
    assert(movement.angularVelocity > 0, `angular velocity should be positive (got ${movement.angularVelocity})`)
})

Deno.test('emits waypointReached when odom is close enough to target', () => {
    const agent = createLocalPlanner({ closeEnoughToWaypoint: 5 })
    const clock = makeClock(0)
    const targetWaypoint = { x: 10, y: 0 }
    // put odom within closeEnoughToWaypoint
    const odom = { x: 8, y: 0, heading: 0 }
    const state = { ...agent.initialArg.state, time: 0, odom, targetWaypoint }
    const { waypointReached, state: s } = step(agent, clock, state, { odom: true, targetWaypoint: true })
    assertNotNull(waypointReached, 'waypointReached should be emitted')
    assertEq(waypointReached.waypoint.x, 10, 'waypointReached contains the waypoint')
    assertEq(s.mode, 'idle', 'mode returns to idle after reaching waypoint')
})

Deno.test('does not emit waypointReached when still far from target', () => {
    const agent = createLocalPlanner({ closeEnoughToWaypoint: 5 })
    const clock = makeClock(0)
    const targetWaypoint = { x: 100, y: 0 }
    const odom = { x: 0, y: 0, heading: 0 }
    const state = { ...agent.initialArg.state, time: 0, odom, targetWaypoint }
    const { waypointReached } = step(agent, clock, state, { odom: true, targetWaypoint: true })
    assertNull(waypointReached, 'waypointReached should not be emitted when far')
})

Deno.test('stall detection: switches to random mode after no progress', () => {
    const agent = createLocalPlanner({ timeBeforeRandomMove: 2, minimumDistanceThatIsProgress: 0.1 })
    const clock = makeClock(0)
    const odom = { x: 0, y: 0, heading: 0 }
    const targetWaypoint = { x: 100, y: 0 }

    // t=0: start in greedy
    let state = { ...agent.initialArg.state, time: 0, odom, targetWaypoint }
    ;({ state } = step(agent, clock, state, { odom: true, targetWaypoint: true }))
    assertEq(state.mode, 'greedy', 'starts in greedy')

    // t=1: same position, no progress
    clock.time = 1
    ;({ state } = step(agent, clock, { ...state, time: 1, odom }, { odom: true }))
    assertEq(state.mode, 'greedy', 'still greedy at t=1')

    // t=3: past timeBeforeRandomMove=2, still no progress → random
    clock.time = 3
    const { state: s3 } = step(agent, clock, { ...state, time: 3, odom }, { odom: true })
    assertEq(s3.mode, 'random', 'switches to random after stall')
})

Deno.test('stall timer resets when meaningful progress is made', () => {
    const agent = createLocalPlanner({ timeBeforeRandomMove: 5, minimumDistanceThatIsProgress: 0.1 })
    const clock = makeClock(0)
    const targetWaypoint = { x: 100, y: 0 }

    // t=0: start moving toward waypoint
    let odom = { x: 0, y: 0, heading: 0 }
    let state = { ...agent.initialArg.state, time: 0, odom, targetWaypoint }
    ;({ state } = step(agent, clock, state, { odom: true, targetWaypoint: true }))

    // t=1: moved closer by 10 units (meaningful progress)
    clock.time = 1
    odom = { x: 10, y: 0, heading: 0 }
    ;({ state } = step(agent, clock, { ...state, time: 1, odom }, { odom: true }))
    // timer should have been reset, not expired
    assertEq(state.mode, 'greedy', 'stays greedy after progress')

    // t=4: time = 4, but timer was reset at t=1, so timeBeforeRandomMove=5 means endTime=1+5=6
    clock.time = 4
    odom = { x: 10, y: 0, heading: 0 } // no progress since t=1
    ;({ state } = step(agent, clock, { ...state, time: 4, odom }, { odom: true }))
    assertEq(state.mode, 'greedy', 'still greedy: timer was reset by progress at t=1')
})

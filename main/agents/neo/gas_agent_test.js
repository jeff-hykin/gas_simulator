import { gasGradient, waypointsAlongGradient } from './gas_agent.js'
import gasAgent from './gas_agent.js'
const { create: createGasAgent } = gasAgent

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
function step(agent, clock, state, updatedOverrides = {}, inputs = {}) {
    const zeroUpdated = Object.fromEntries(agent.info.inputs.map(name => [name, false]))
    const { state: nextState, outputs } = agent.update(clock.getTime, {
        state: { ...state, ...inputs },
        updated: { ...zeroUpdated, ...updatedOverrides },
    })
    return {
        state: nextState,
        targetWaypoint: outputs.targetWaypoint,
        logJson: outputs.logJson,
    }
}

// ── gasGradient tests ──────────────────────────────────────────────────

Deno.test('gasGradient: returns zero for empty samples', () => {
    const result = gasGradient({ x: 0, y: 0 }, [])
    assertEq(result.angle, 0, 'angle should be 0 for empty samples')
    assertEq(result.slope, 0, 'slope should be 0 for empty samples')
})

Deno.test('gasGradient: returns zero for fewer than 3 samples', () => {
    const samples = [
        { time: 0, gasReading: 1, location: { x: 0, y: 0 } },
        { time: 1, gasReading: 2, location: { x: 1, y: 0 } },
    ]
    const result = gasGradient({ x: 0, y: 0 }, samples)
    assertEq(result.angle, 0, 'angle should be 0 for < 3 samples')
    assertEq(result.slope, 0, 'slope should be 0 for < 3 samples')
})

Deno.test('gasGradient: returns zero for flat surface', () => {
    const samples = [
        { time: 0, gasReading: 5, location: { x: 0,  y: 0  } },
        { time: 1, gasReading: 5, location: { x: 10, y: 0  } },
        { time: 2, gasReading: 5, location: { x: 0,  y: 10 } },
        { time: 3, gasReading: 5, location: { x: 10, y: 10 } },
    ]
    const result = gasGradient({ x: 5, y: 5 }, samples)
    assertClose(result.slope, 0, 1e-6, 'flat surface should have near-zero slope')
})

Deno.test('gasGradient: pure x-gradient points in +x direction', () => {
    // gas increases in +x direction: gas = x * 0.1
    const samples = [
        { time: 0, gasReading: 0,   location: { x: 0,  y: 0  } },
        { time: 1, gasReading: 1,   location: { x: 10, y: 0  } },
        { time: 2, gasReading: 2,   location: { x: 20, y: 0  } },
        { time: 3, gasReading: 0.5, location: { x: 5,  y: 5  } },
        { time: 4, gasReading: 1.5, location: { x: 15, y: 5  } },
    ]
    const result = gasGradient({ x: 10, y: 5 }, samples)
    assert(result.slope > 0, 'slope should be positive for ascending x-gradient')
    // angle should be close to 0 (pointing in +x direction)
    assertClose(result.angle, 0, 0.1, 'gradient direction should point in +x (angle ≈ 0)')
})

Deno.test('gasGradient: pure y-gradient points in +y direction', () => {
    // gas increases in +y direction: gas = y * 0.1
    const samples = [
        { time: 0, gasReading: 0,   location: { x: 0, y: 0  } },
        { time: 1, gasReading: 1,   location: { x: 0, y: 10 } },
        { time: 2, gasReading: 2,   location: { x: 0, y: 20 } },
        { time: 3, gasReading: 0.5, location: { x: 5, y: 5  } },
        { time: 4, gasReading: 1.5, location: { x: 5, y: 15 } },
    ]
    const result = gasGradient({ x: 5, y: 10 }, samples)
    assert(result.slope > 0, 'slope should be positive')
    // angle should be close to π/2 (pointing in +y direction)
    assertClose(result.angle, Math.PI / 2, 0.1, 'gradient direction should point in +y (angle ≈ π/2)')
})

Deno.test('gasGradient: negative gradient (decreasing in +x) points in -x direction', () => {
    // gas decreases in +x direction: gas = -x * 0.1 + 3
    const samples = [
        { time: 0, gasReading: 3,   location: { x: 0,  y: 0  } },
        { time: 1, gasReading: 2,   location: { x: 10, y: 0  } },
        { time: 2, gasReading: 1,   location: { x: 20, y: 0  } },
        { time: 3, gasReading: 2.5, location: { x: 5,  y: 5  } },
        { time: 4, gasReading: 1.5, location: { x: 15, y: 5  } },
    ]
    const result = gasGradient({ x: 10, y: 2 }, samples)
    assert(result.slope > 0, 'slope should be positive (magnitude)')
    // angle should be close to ±π (pointing in -x direction)
    assert(Math.abs(result.angle) > Math.PI / 2, 'gradient should point in -x direction')
})

Deno.test('gasGradient: diagonal gradient at 45 degrees', () => {
    // gas = x + y (equal gradient in both x and y)
    const samples = [
        { time: 0, gasReading: 0,  location: { x: 0,  y: 0  } },
        { time: 1, gasReading: 10, location: { x: 10, y: 0  } },
        { time: 2, gasReading: 10, location: { x: 0,  y: 10 } },
        { time: 3, gasReading: 20, location: { x: 10, y: 10 } },
        { time: 4, gasReading: 5,  location: { x: 5,  y: 0  } },
    ]
    const result = gasGradient({ x: 5, y: 5 }, samples)
    assert(result.slope > 0, 'slope should be positive')
    // angle should be close to π/4 (45 degrees)
    assertClose(result.angle, Math.PI / 4, 0.1, 'gradient should point at 45 degrees')
})

Deno.test('gasGradient: skips samples with null location or gasReading', () => {
    const samples = [
        { time: 0, gasReading: null, location: { x: 0, y: 0 } },
        { time: 1, gasReading: 1,    location: null             },
        { time: 2, gasReading: 1,    location: { x: 10, y: 0 } },
    ]
    // Only 1 valid sample → should return zero
    const result = gasGradient({ x: 0, y: 0 }, samples)
    assertEq(result.slope, 0, 'should return zero slope when < 3 valid samples')
})

// ── waypointsAlongGradient tests ───────────────────────────────────────

Deno.test('waypointsAlongGradient: returns correct count', () => {
    const pts = waypointsAlongGradient({ x: 0, y: 0 }, 0, 10, 3)
    assertEq(pts.length, 3, 'should return 3 waypoints')
})

Deno.test('waypointsAlongGradient: points step along angle=0 (+x)', () => {
    const pts = waypointsAlongGradient({ x: 0, y: 0 }, 0, 10, 3)
    assertClose(pts[0].x, 10, 1e-9, 'first x')
    assertClose(pts[0].y, 0,  1e-9, 'first y')
    assertClose(pts[1].x, 20, 1e-9, 'second x')
    assertClose(pts[2].x, 30, 1e-9, 'third x')
})

Deno.test('waypointsAlongGradient: points step along angle=π/2 (+y)', () => {
    const pts = waypointsAlongGradient({ x: 5, y: 5 }, Math.PI / 2, 10, 2)
    assertClose(pts[0].x, 5,  1e-9, 'first x stays same')
    assertClose(pts[0].y, 15, 1e-9, 'first y advances')
    assertClose(pts[1].y, 25, 1e-9, 'second y advances')
})

Deno.test('waypointsAlongGradient: returns empty array for count=0', () => {
    const pts = waypointsAlongGradient({ x: 0, y: 0 }, 0, 10, 0)
    assertEq(pts.length, 0, 'should return empty array for count=0')
})

// ── gas_agent behavioral tests ─────────────────────────────────────────

Deno.test('factory creates agent with initialArg and update', () => {
    const agent = createGasAgent({})
    assert(typeof agent.update === 'function', 'update should be a function')
    assertNotNull(agent.initialArg, 'initialArg should exist')
    assertEq(agent.initialArg.state.mode, 'idle', 'initial mode is idle')
    assertEq(agent.initialArg.state.gasBuffer.length, 0, 'gas buffer starts empty')
    assertNull(agent.initialArg.state.position, 'initial position is null')
})

Deno.test('routeUpdate transitions to routeFollow mode', () => {
    const agent = createGasAgent({})
    const clock = makeClock(0)
    const routeUpdate = { waypoints: [{ x: 100, y: 0 }, { x: 200, y: 0 }] }
    const { state, targetWaypoint } = step(agent, clock, agent.initialArg.state,
        { routeUpdate: true },
        { routeUpdate }
    )
    assertEq(state.mode, 'routeFollow', 'should enter routeFollow on routeUpdate')
    assertNotNull(targetWaypoint, 'should emit first waypoint')
    assertEq(targetWaypoint.x, 100, 'first waypoint x=100')
})

Deno.test('gas readings accumulate in gasBuffer', () => {
    const agent = createGasAgent({})
    const clock = makeClock(0)
    let state = agent.initialArg.state

    ;({ state } = step(agent, clock, state, { position: true }, { position: { x: 0, y: 0 } }))
    ;({ state } = step(agent, clock, state, { gasReading: true }, { gasReading: 0.5, position: { x: 0, y: 0 } }))
    assertEq(state.gasBuffer.length, 1, 'one gas reading accumulated')

    ;({ state } = step(agent, clock, state, { gasReading: true }, { gasReading: 0.8, position: { x: 5, y: 0 } }))
    assertEq(state.gasBuffer.length, 2, 'two gas readings accumulated')
    assertEq(state.gasBuffer[0].gasReading, 0.5, 'first reading stored')
    assertEq(state.gasBuffer[1].gasReading, 0.8, 'second reading stored')
})

Deno.test('gas buffer is capped at bufferSize', () => {
    const bufferSize = 5
    const agent = createGasAgent({ bufferSize })
    const clock = makeClock(0)
    let state = { ...agent.initialArg.state, position: { x: 0, y: 0 } }

    for (let i = 0; i < bufferSize + 3; i++) {
        ;({ state } = step(agent, clock, state, { gasReading: true }, { gasReading: i, position: { x: i, y: 0 } }))
    }
    assertEq(state.gasBuffer.length, bufferSize, 'buffer capped at bufferSize')
    // Should keep the most recent entries
    assertEq(state.gasBuffer[bufferSize - 1].gasReading, bufferSize + 2, 'most recent reading is last')
})

Deno.test('enters gasFollow when gradient is strong (switchingCooldown=0)', () => {
    const agent = createGasAgent({
        switchingCooldown: 0,
        gasThreshold: 0.1,
        gasRateIncreaseRatio: 0.01,
        gradientStepDist: 20,
        gradientStepCount: 3,
    })
    const clock = makeClock(0)
    let state = agent.initialArg.state

    // Seed a route so we start in routeFollow
    ;({ state } = step(agent, clock, state, { routeUpdate: true }, {
        routeUpdate: { waypoints: [{ x: 500, y: 0 }] },
    }))
    assertEq(state.mode, 'routeFollow', 'starts in routeFollow')

    // Build up a gas buffer with a clear x-gradient: gas ≈ x * 0.05
    // Samples must NOT be collinear in 2D or the plane fit is degenerate.
    const positions = [
        { x: 0,  y: 0,  gas: 0.0  },
        { x: 10, y: 0,  gas: 0.5  },
        { x: 20, y: 0,  gas: 1.0  },
        { x: 0,  y: 10, gas: 0.05 },
        { x: 10, y: 10, gas: 0.55 },
    ]
    for (const p of positions) {
        clock.advance(0.1)
        ;({ state } = step(agent, clock, state, { position: true, gasReading: true }, {
            position: { x: p.x, y: p.y },
            gasReading: p.gas,
        }))
    }

    // Trigger a tick with gas reading and current position to evaluate mode switch
    clock.advance(0.1)
    ;({ state } = step(agent, clock, state, { gasReading: true }, {
        position: { x: 10, y: 5 },
        gasReading: 0.55,
    }))

    assertEq(state.mode, 'gasFollow', 'should switch to gasFollow with strong gradient')
})

Deno.test('gasFollow generates waypoints along gradient direction', () => {
    const agent = createGasAgent({
        switchingCooldown: 0,
        gasThreshold: 0.1,
        gasRateIncreaseRatio: 0.01,
        gradientStepDist: 20,
        gradientStepCount: 3,
    })
    const clock = makeClock(0)
    let state = agent.initialArg.state

    // Seed routeFollow
    ;({ state } = step(agent, clock, state, { routeUpdate: true }, {
        routeUpdate: { waypoints: [{ x: 500, y: 0 }] },
    }))

    // Build gas buffer with x-gradient — must be non-collinear for plane fit
    const positions = [
        { x: 0,  y: 0,  gas: 0.0  },
        { x: 10, y: 0,  gas: 0.5  },
        { x: 20, y: 0,  gas: 1.0  },
        { x: 0,  y: 10, gas: 0.05 },
        { x: 10, y: 10, gas: 0.55 },
    ]
    for (const p of positions) {
        clock.advance(0.1)
        ;({ state } = step(agent, clock, state, { position: true, gasReading: true }, {
            position: { x: p.x, y: p.y },
            gasReading: p.gas,
        }))
    }

    // Switch position to (10, 5) to trigger gasFollow evaluation
    clock.advance(0.1)
    ;({ state } = step(agent, clock, state, { gasReading: true }, {
        position: { x: 10, y: 5 },
        gasReading: 0.55,
    }))

    assertEq(state.mode, 'gasFollow', 'should be in gasFollow')
    assertEq(state.gasWaypoints.length, 3, 'should have 3 gas waypoints')
})

Deno.test('returns to routeFollow when gradient weakens (switchingCooldown=0)', () => {
    const agent = createGasAgent({
        switchingCooldown: 0,
        gasThreshold: 0.1,
        gasRateIncreaseRatio: 0.1,  // threshold that flat readings will fall below
        gradientStepDist: 20,
        gradientStepCount: 2,
        bufferSize: 20,
    })
    const clock = makeClock(0)
    let state = agent.initialArg.state

    // Enter routeFollow
    ;({ state } = step(agent, clock, state, { routeUpdate: true }, {
        routeUpdate: { waypoints: [{ x: 500, y: 0 }] },
    }))

    // Build strong gradient buffer — non-collinear so plane fit is well-conditioned
    const strongPositions = [
        { x: 0,  y: 0,  gas: 0.0  },
        { x: 10, y: 0,  gas: 5.0  },
        { x: 20, y: 0,  gas: 10.0 },
        { x: 0,  y: 10, gas: 0.5  },
        { x: 10, y: 10, gas: 5.5  },
    ]
    for (const p of strongPositions) {
        clock.advance(0.1)
        ;({ state } = step(agent, clock, state, { position: true, gasReading: true }, {
            position: { x: p.x, y: p.y },
            gasReading: p.gas,
        }))
    }
    clock.advance(0.1)
    ;({ state } = step(agent, clock, state, { gasReading: true }, {
        position: { x: 10, y: 5 },
        gasReading: 5.5,
    }))
    assertEq(state.mode, 'gasFollow', 'should be in gasFollow')

    // Replace buffer with flat readings in a 2D spread — slope will fall below threshold
    // Use a grid so the plane fit is well-conditioned but shows near-zero slope
    const flatPositions = [
        { x: 0,  y: 0,  gas: 0.15 },
        { x: 5,  y: 0,  gas: 0.15 },
        { x: 10, y: 0,  gas: 0.15 },
        { x: 0,  y: 5,  gas: 0.15 },
        { x: 5,  y: 5,  gas: 0.15 },
        { x: 10, y: 5,  gas: 0.15 },
        { x: 0,  y: 10, gas: 0.15 },
        { x: 5,  y: 10, gas: 0.15 },
        { x: 10, y: 10, gas: 0.15 },
        { x: 3,  y: 3,  gas: 0.15 },
        { x: 7,  y: 3,  gas: 0.15 },
        { x: 3,  y: 7,  gas: 0.15 },
        { x: 7,  y: 7,  gas: 0.15 },
        { x: 5,  y: 2,  gas: 0.15 },
        { x: 2,  y: 5,  gas: 0.15 },
        { x: 8,  y: 5,  gas: 0.15 },
        { x: 5,  y: 8,  gas: 0.15 },
        { x: 1,  y: 9,  gas: 0.15 },
        { x: 9,  y: 1,  gas: 0.15 },
        { x: 4,  y: 6,  gas: 0.15 },
    ]
    for (const p of flatPositions) {
        clock.advance(0.1)
        ;({ state } = step(agent, clock, state, { position: true, gasReading: true }, {
            position: { x: p.x, y: p.y },
            gasReading: p.gas,
        }))
    }

    clock.advance(0.1)
    ;({ state } = step(agent, clock, state, { gasReading: true }, {
        position: { x: 5, y: 5 },
        gasReading: 0.15,
    }))

    assertEq(state.mode, 'routeFollow', 'should return to routeFollow when gradient weakens')
})

import { assertEquals, assertAlmostEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts"
import {
    vecAdd, vecSub, vecScale, vecNormalize, vecMagnitude, vecDistance,
    vecDot, vecCross, vecRotate, angleDifference,
    linearRegressionSlope, fitGradient2D, circleWaypoints,
    nearestPointOnSegment, nearestPointOnPolyline,
} from "./math_helpers.js"
import { GasAgent } from "./agent.js"

// ── Helpers ───────────────────────────────────────────────────────────

function createPubSub() {
    const subs = {}
    return {
        subscribe(channel, cb) {
            (subs[channel] ??= []).push(cb)
            return () => {
                const list = subs[channel]
                if (!list) return
                const idx = list.indexOf(cb)
                if (idx !== -1) list.splice(idx, 1)
            }
        },
        publish(channel, data) {
            (subs[channel] ?? []).forEach(cb => cb(data, "test"))
        },
    }
}

/**
 * Create a pubsub with automatic odometry simulation.
 * Tracks position/heading and publishes odom after each movement.
 */
function createPubSubWithOdom(startPos = { x: 0, y: 0 }, startHeading = 0, decisionRate = 0.01) {
    const ps = createPubSub()
    const state = { x: startPos.x, y: startPos.y, heading: startHeading }

    // Auto-publish odom after each movement command (simulates perfect movement)
    ps.subscribe("movement", (data, publisher) => {
        // Handle velocity-based commands
        const linearVelocity = data.linearVelocity ?? 0
        const angularVelocity = data.angularVelocity ?? 0

        // Convert velocities to movements using decision rate
        const forward = linearVelocity * decisionRate
        const rotation = angularVelocity * decisionRate

        state.heading += rotation
        state.x += forward * Math.cos(state.heading)
        state.y += forward * Math.sin(state.heading)
        ps.publish("odom", { ...state })
    })

    return ps
}

function approx(a, b, eps = 1e-6) {
    return Math.abs(a - b) < eps
}

// ── Math: Vector Ops ──────────────────────────────────────────────────

Deno.test("vecAdd", () => {
    const r = vecAdd({ x: 1, y: 2 }, { x: 3, y: 4 })
    assertEquals(r, { x: 4, y: 6 })
})

Deno.test("vecSub", () => {
    const r = vecSub({ x: 5, y: 7 }, { x: 2, y: 3 })
    assertEquals(r, { x: 3, y: 4 })
})

Deno.test("vecScale", () => {
    assertEquals(vecScale({ x: 2, y: 3 }, 0.5), { x: 1, y: 1.5 })
})

Deno.test("vecMagnitude", () => {
    assertAlmostEquals(vecMagnitude({ x: 3, y: 4 }), 5, 1e-10)
})

Deno.test("vecNormalize unit vector", () => {
    const r = vecNormalize({ x: 0, y: 5 })
    assertAlmostEquals(r.x, 0, 1e-10)
    assertAlmostEquals(r.y, 1, 1e-10)
})

Deno.test("vecNormalize zero vector", () => {
    assertEquals(vecNormalize({ x: 0, y: 0 }), { x: 0, y: 0 })
})

Deno.test("vecDistance", () => {
    assertAlmostEquals(vecDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5, 1e-10)
})

Deno.test("vecDot perpendicular", () => {
    assertAlmostEquals(vecDot({ x: 1, y: 0 }, { x: 0, y: 1 }), 0, 1e-10)
})

Deno.test("vecCross", () => {
    assertAlmostEquals(vecCross({ x: 1, y: 0 }, { x: 0, y: 1 }), 1, 1e-10)
})

Deno.test("vecRotate 90 degrees", () => {
    const r = vecRotate({ x: 1, y: 0 }, Math.PI / 2)
    assertAlmostEquals(r.x, 0, 1e-10)
    assertAlmostEquals(r.y, 1, 1e-10)
})

// ── Math: angleDifference ─────────────────────────────────────────────

Deno.test("angleDifference simple", () => {
    assertAlmostEquals(angleDifference(0, Math.PI / 2), Math.PI / 2, 1e-10)
})

Deno.test("angleDifference wrap-around", () => {
    const d = angleDifference(Math.PI * 0.9, -Math.PI * 0.9)
    assertAlmostEquals(d, 0.2 * Math.PI, 1e-10)
})

Deno.test("angleDifference negative", () => {
    assertAlmostEquals(angleDifference(0, -Math.PI / 4), -Math.PI / 4, 1e-10)
})

// ── Math: linearRegressionSlope ───────────────────────────────────────

Deno.test("linearRegressionSlope perfect line", () => {
    const slope = linearRegressionSlope([
        { x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 4 },
    ])
    assertAlmostEquals(slope, 2, 1e-10)
})

Deno.test("linearRegressionSlope single point returns 0", () => {
    assertEquals(linearRegressionSlope([{ x: 0, y: 0 }]), 0)
})

Deno.test("linearRegressionSlope negative slope", () => {
    const slope = linearRegressionSlope([
        { x: 0, y: 10 }, { x: 5, y: 0 },
    ])
    assertAlmostEquals(slope, -2, 1e-10)
})

// ── Math: fitGradient2D ───────────────────────────────────────────────

Deno.test("fitGradient2D x-gradient", () => {
    const g = fitGradient2D([
        { x: 0, y: 0, value: 0 },
        { x: 1, y: 0, value: 1 },
        { x: 0, y: 1, value: 0 },
    ])
    assertAlmostEquals(g.x, 1, 1e-6)
    assertAlmostEquals(g.y, 0, 1e-6)
})

Deno.test("fitGradient2D diagonal gradient", () => {
    const g = fitGradient2D([
        { x: 0, y: 0, value: 0 },
        { x: 1, y: 0, value: 1 },
        { x: 0, y: 1, value: 1 },
        { x: 1, y: 1, value: 2 },
    ])
    const expected = Math.SQRT1_2
    assertAlmostEquals(g.x, expected, 1e-6)
    assertAlmostEquals(g.y, expected, 1e-6)
})

Deno.test("fitGradient2D < 3 points returns zero", () => {
    assertEquals(fitGradient2D([{ x: 0, y: 0, value: 1 }]), { x: 0, y: 0 })
})

// ── Math: circleWaypoints ─────────────────────────────────────────────

Deno.test("circleWaypoints count and radius", () => {
    const pts = circleWaypoints({ x: 0, y: 0 }, 5, 4, 0, false)
    assertEquals(pts.length, 4)
    for (const p of pts) {
        assertAlmostEquals(vecDistance(p, { x: 0, y: 0 }), 5, 1e-10)
    }
})

Deno.test("circleWaypoints CCW ordering", () => {
    const pts = circleWaypoints({ x: 0, y: 0 }, 1, 4, 0, false)
    assertAlmostEquals(pts[0].x, 1, 1e-10)
    assertAlmostEquals(pts[1].y, 1, 1e-10)
    assertAlmostEquals(pts[2].x, -1, 1e-10)
    assertAlmostEquals(pts[3].y, -1, 1e-10)
})

Deno.test("circleWaypoints CW ordering", () => {
    const pts = circleWaypoints({ x: 0, y: 0 }, 1, 4, 0, true)
    assertAlmostEquals(pts[0].x, 1, 1e-10)
    assertAlmostEquals(pts[1].y, -1, 1e-10)
    assertAlmostEquals(pts[2].x, -1, 1e-10)
    assertAlmostEquals(pts[3].y, 1, 1e-10)
})

// ── Math: nearestPointOnSegment ───────────────────────────────────────

Deno.test("nearestPointOnSegment projection", () => {
    const r = nearestPointOnSegment({ x: 1, y: 3 }, { x: 0, y: 0 }, { x: 2, y: 0 })
    assertAlmostEquals(r.x, 1, 1e-10)
    assertAlmostEquals(r.y, 0, 1e-10)
})

Deno.test("nearestPointOnSegment clamps to start", () => {
    const r = nearestPointOnSegment({ x: -5, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 })
    assertAlmostEquals(r.x, 0, 1e-10)
})

Deno.test("nearestPointOnSegment clamps to end", () => {
    const r = nearestPointOnSegment({ x: 10, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 0 })
    assertAlmostEquals(r.x, 2, 1e-10)
})

Deno.test("nearestPointOnSegment degenerate segment", () => {
    const r = nearestPointOnSegment({ x: 5, y: 5 }, { x: 1, y: 1 }, { x: 1, y: 1 })
    assertEquals(r, { x: 1, y: 1 })
})

// ── Math: nearestPointOnPolyline ──────────────────────────────────────

Deno.test("nearestPointOnPolyline", () => {
    // Point (8, 5): segment (0,0)→(10,0) gives (8,0) dist=5,
    //               segment (10,0)→(10,10) gives (10,5) dist=2
    const r = nearestPointOnPolyline({ x: 8, y: 5 }, [
        { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
    ])
    assertAlmostEquals(r.x, 10, 1e-10)
    assertAlmostEquals(r.y, 5, 1e-10)
})

Deno.test("nearestPointOnPolyline empty returns input", () => {
    const r = nearestPointOnPolyline({ x: 3, y: 4 }, [])
    assertEquals(r, { x: 3, y: 4 })
})

// ═══════════════════════════════════════════════════════════════════════
// Agent Unit Tests
// ═══════════════════════════════════════════════════════════════════════

// ── Sensor Cap ────────────────────────────────────────────────────────

Deno.test("sensor reading only increases", () => {
    const ps = createPubSubWithOdom()
    const agent = new GasAgent(ps, { samplingRate: 1, minimumGasThreshold: 0 })

    ps.publish("gas_reading", { ppm: 1.0 })
    assertEquals(agent.sensorReading, 1.0)

    ps.publish("gas_reading", { ppm: 0.5 })
    assertEquals(agent.sensorReading, 1.0)

    ps.publish("gas_reading", { ppm: 1.5 })
    assertEquals(agent.sensorReading, 1.5)

    ps.publish("gas_reading", { ppm: 0.0 })
    assertEquals(agent.sensorReading, 1.5)
})

// ── Gas Memory ────────────────────────────────────────────────────────

Deno.test("gas memory records when above threshold and sensitivity", () => {
    const ps = createPubSubWithOdom()
    const agent = new GasAgent(ps, {
        samplingRate: 1,
        minimumGasThreshold: 0.5,
        gasSensitivity: 0.1,
    })

    // Below minimum — no entry
    ps.publish("gas_reading", { ppm: 0.3 })
    assertEquals(agent.gasMemory.length, 0)

    // Above minimum, first entry (> -Infinity + 0.1)
    ps.publish("gas_reading", { ppm: 0.7 })
    assertEquals(agent.gasMemory.length, 1)
    assertAlmostEquals(agent.gasMemory[0].ppm, 0.7, 1e-10)

    // Increase but below sensitivity (0.75 - 0.1 = 0.65 < 0.7)
    ps.publish("gas_reading", { ppm: 0.75 })
    assertEquals(agent.gasMemory.length, 1)

    // Sufficient increase (0.85 - 0.1 = 0.75 > 0.7)
    ps.publish("gas_reading", { ppm: 0.85 })
    assertEquals(agent.gasMemory.length, 2)
})

Deno.test("gas memory respects maxBufferSize", () => {
    const ps = createPubSubWithOdom()
    const agent = new GasAgent(ps, {
        samplingRate: 1,
        minimumGasThreshold: 0,
        gasSensitivity: 0.01,
        maxBufferSize: 3,
    })

    for (let i = 1; i <= 5; i++) {
        ps.publish("gas_reading", { ppm: i })
    }
    assertEquals(agent.gasMemory.length, 3)
    assertAlmostEquals(agent.gasMemory[0].ppm, 3, 1e-10)
    assertAlmostEquals(agent.gasMemory[2].ppm, 5, 1e-10)
})

Deno.test("gas memory stores position at time of reading", () => {
    const ps = createPubSubWithOdom()
    const agent = new GasAgent(ps, {
        samplingRate: 1,
        minimumGasThreshold: 0,
        gasSensitivity: 0.01,
        startPosition: { x: 5, y: 10 },
    })

    ps.publish("gas_reading", { ppm: 1 })
    assertEquals(agent.gasMemory.length, 1)
    assertAlmostEquals(agent.gasMemory[0].position.x, 5, 0.01)
    assertAlmostEquals(agent.gasMemory[0].position.y, 10, 0.01)
})

// ── Interest / Mode ───────────────────────────────────────────────────

Deno.test("interest is 0 with fewer than 2 memory entries", () => {
    const ps = createPubSubWithOdom()
    const agent = new GasAgent(ps, { samplingRate: 1 })
    assertEquals(agent.computeInterest(), 0)

    agent.gasMemory.push({ ppm: 1, time: 0, position: { x: 0, y: 0 } })
    assertEquals(agent.computeInterest(), 0)
})

Deno.test("interest reflects gradient steepness (scaled to 0-10 range)", () => {
    const ps = createPubSubWithOdom()
    const decisionRate = 1
    const agent = new GasAgent(ps, {
        decisionRate,
        samplingRate: 1,
        gasSensitivity: 0.05,
        attentionThreshold: 1.0,
        attentionSpan: 120, // 120 ticks = 2 minutes at 1s decision rate
    })

    // Manually inject gas memory with known gradient
    // slope = 0.5 PPM/min over 2 minutes
    agent.gasMemory = [
        { ppm: 1.0, time: 0, position: { x: 0, y: 0 } },
        { ppm: 2.0, time: 2, position: { x: 1, y: 0 } },
    ]
    agent.tickCount = 120

    // interest = ((slope / gasSensitivity) / attentionThreshold) / 100
    // = ((0.5 / 0.05) / 1.0) / 100 = 0.1
    assertAlmostEquals(agent.computeInterest(), 0.1, 0.01)
})

Deno.test("mode is inactive when interest <= refocusPressure + 1", () => {
    const ps = createPubSubWithOdom()
    const agent = new GasAgent(ps, { samplingRate: 1 })
    // No gas memory → interest = 0, pressure = 0, 0 - 0 = 0 ≤ 1
    agent._updateMode()
    assertEquals(agent.mode, "inactive")
})

Deno.test("mode is explore when interest - refocusPressure > 1", () => {
    const ps = createPubSubWithOdom()
    const decisionRate = 1
    const agent = new GasAgent(ps, {
        decisionRate,
        samplingRate: 1,
        gasSensitivity: 0.001,  // Very sensitive to get high interest
        attentionThreshold: 0.1,
        attentionSpan: 60,  // 60 ticks = 1 minute at 1s decision rate
        refocusRatio: 6000,  // Large value so pressure stays low
    })

    // Create steep gradient for high interest
    agent.gasMemory = [
        { ppm: 1.0, time: 0, position: { x: 0, y: 0 } },
        { ppm: 3.0, time: 1, position: { x: 1, y: 0 } },  // 2 PPM/min slope
    ]
    agent.tickCount = 60
    agent.exploreTime = 0

    agent._updateMode()
    assertEquals(agent.mode, "explore")
})

Deno.test("refocus pressure grows with explore time (scaled to 0-10 range)", () => {
    const ps = createPubSubWithOdom()
    const agent = new GasAgent(ps, { refocusRatio: 60 })

    agent.exploreTime = 0
    assertAlmostEquals(agent.computeRefocusPressure(), 0, 0.01)

    agent.exploreTime = 30
    // (30 / 60) * 10 = 5
    assertAlmostEquals(agent.computeRefocusPressure(), 5, 0.01)

    agent.exploreTime = 60
    // (60 / 60) * 10 = 10
    assertAlmostEquals(agent.computeRefocusPressure(), 10, 0.01)
})

// ── Route Following ───────────────────────────────────────────────────

Deno.test("route following advances to next waypoint when close", () => {
    const ps = createPubSubWithOdom()
    const movements = []
    const agent = new GasAgent(ps, {
        samplingRate: 1,
        minimumGasThreshold: 999,
        waypointThreshold: 2,
        moveSpeed: 5,
        turnSpeed: Math.PI,
        startPosition: { x: 0, y: 0 },
    })
    ps.subscribe("movement", (data, publisher) => movements.push(data))
    ps.publish("route_update", { waypoints: [{ x: 1, y: 0 }, { x: 20, y: 0 }] })

    // First tick: close to waypoint 0 (distance 1 < threshold 2)
    ps.publish("gas_reading", { ppm: 0 })
    assertEquals(agent.currentWaypointIndex, 1)
})

Deno.test("route following skips waypoint after patience exceeded", () => {
    const ps = createPubSubWithOdom()
    const agent = new GasAgent(ps, {
        samplingRate: 1,
        minimumGasThreshold: 999,
        waypointThreshold: 0.1,
        waypointPatience: 3,
        moveSpeed: 0,
        turnSpeed: Math.PI,
        startPosition: { x: 0, y: 0 },
    })
    ps.publish("route_update", { waypoints: [{ x: 100, y: 0 }, { x: 200, y: 0 }] })

    // moveSpeed=0: agent can't move, distance never improves, patience expires
    for (let i = 0; i < 10; i++) {
        ps.publish("gas_reading", { ppm: 0 })
    }
    assert(agent.currentWaypointIndex >= 1, `expected skip, got index ${agent.currentWaypointIndex}`)
})

Deno.test("route following publishes movement messages", () => {
    const decisionRate = 1
    const ps = createPubSubWithOdom({ x: 0, y: 0 }, 0, decisionRate)
    const movements = []
    const agent = new GasAgent(ps, {
        samplingRate: 1,
        minimumGasThreshold: 999,
        moveSpeed: 1,
        turnSpeed: Math.PI,
        startPosition: { x: 0, y: 0 },
        decisionRate,
    })
    ps.subscribe("movement", (data, publisher) => movements.push(data))
    ps.publish("route_update", { waypoints: [{ x: 10, y: 0 }] })

    ps.publish("gas_reading", { ppm: 0 })
    assertEquals(movements.length, 1)
    assert(movements[0].linearVelocity > 0, "should move forward")
})

// ── Route Update ──────────────────────────────────────────────────────

Deno.test("route update overwrites route but preserves gas memory", () => {
    const ps = createPubSubWithOdom()
    const agent = new GasAgent(ps, {
        samplingRate: 1,
        minimumGasThreshold: 0,
        gasSensitivity: 0.01,
    })

    ps.publish("route_update", { waypoints: [{ x: 1, y: 0 }] })
    ps.publish("gas_reading", { ppm: 1 })
    assertEquals(agent.gasMemory.length, 1)

    ps.publish("route_update", { waypoints: [{ x: 50, y: 50 }] })
    assertEquals(agent.routeWaypoints.length, 1)
    assertEquals(agent.routeWaypoints[0].x, 50)
    assertEquals(agent.currentWaypointIndex, 0)
    assertEquals(agent.gasMemory.length, 1, "gas memory should be preserved")
})

// ═══════════════════════════════════════════════════════════════════════
// Partial Integration Tests
// ═══════════════════════════════════════════════════════════════════════

Deno.test("integration: agent follows route with zero gas", () => {
    const decisionRate = 1
    const ps = createPubSubWithOdom({ x: 0, y: 0 }, 0, decisionRate)
    const movements = []
    const agent = new GasAgent(ps, {
        samplingRate: 1,
        minimumGasThreshold: 999,
        moveSpeed: 2,
        turnSpeed: Math.PI,
        waypointThreshold: 3,
        startPosition: { x: 0, y: 0 },
        startHeading: 0,
        decisionRate,
    })
    ps.subscribe("movement", (data, publisher) => movements.push(data))
    ps.publish("route_update", { waypoints: [{ x: 10, y: 0 }, { x: 20, y: 0 }] })

    for (let i = 0; i < 20; i++) {
        ps.publish("gas_reading", { ppm: 0 })
    }

    assert(movements.length > 0, "should have published movements")
    // Agent should have progressed along x-axis
    assert(agent.position.x > 5, `expected progress, got x=${agent.position.x}`)
    assertEquals(agent.mode, "inactive")
})

Deno.test("integration: agent enters explore mode on steep gas gradient", () => {
    const ps = createPubSubWithOdom()
    const agent = new GasAgent(ps, {
        samplingRate: 1,
        minimumGasThreshold: 0,
        gasSensitivity: 0.05,
        attentionThreshold: 0.5,
        attentionSpan: 5,
        refocusRatio: 120,
        circlingSize: 3,
        moveSpeed: 1,
        turnSpeed: Math.PI,
        startPosition: { x: 0, y: 0 },
    })
    ps.publish("route_update", { waypoints: [{ x: 100, y: 0 }] })

    // Feed rapidly increasing gas to build steep gradient
    // Each reading needs to exceed last_memory + gasSensitivity
    // sensor is monotonic so we just feed increasing values
    let ppm = 0.2
    for (let i = 0; i < 30; i++) {
        ppm += 0.2
        ps.publish("gas_reading", { ppm })
    }

    // With a steep enough gradient, should be in explore mode
    assert(agent.gasMemory.length >= 3, `expected ≥3 memory entries, got ${agent.gasMemory.length}`)
    const interest = agent.computeInterest()
    assert(interest > 1, `expected interest > 1, got ${interest}`)
    assertEquals(agent.mode, "explore")
})

Deno.test("integration: agent returns to inactive after explore time pressure", () => {
    const ps = createPubSubWithOdom()
    const agent = new GasAgent(ps, {
        samplingRate: 1,
        minimumGasThreshold: 0,
        gasSensitivity: 0.05,
        attentionThreshold: 0.5,
        attentionSpan: 0.5,  // 30 seconds lookback
        refocusRatio: 10,    // short exploration budget
        circlingSize: 3,
        moveSpeed: 1,
        turnSpeed: Math.PI,
        startPosition: { x: 0, y: 0 },
    })
    ps.publish("route_update", { waypoints: [{ x: 100, y: 0 }] })

    // Build up gas memory quickly
    let ppm = 0.2
    for (let i = 0; i < 10; i++) {
        ppm += 0.5
        ps.publish("gas_reading", { ppm })
    }

    // Now stop increasing — feed the same reading many times
    // sensor cap means these all read the same, no new memory entries
    // old entries fall outside attention span, interest drops
    for (let i = 0; i < 100; i++) {
        ps.publish("gas_reading", { ppm: 0 })
    }

    // With short refocusRatio and no new gas increases, should be back to inactive
    assertEquals(agent.mode, "inactive")
})

Deno.test("integration: explore builds circle waypoints away from route", () => {
    const ps = createPubSubWithOdom()
    const agent = new GasAgent(ps, {
        samplingRate: 1,
        minimumGasThreshold: 0,
        gasSensitivity: 0.01,
        attentionThreshold: 0.01,
        attentionSpan: 10,
        refocusRatio: 600,
        circlingSize: 5,
        circleWaypointCount: 8,
        moveSpeed: 0.5,
        turnSpeed: Math.PI,
        startPosition: { x: 0, y: 0 },
    })

    // Route goes along positive x-axis
    ps.publish("route_update", { waypoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }] })

    // Gas memory with gradient pointing roughly in +y direction
    // Positions must not be collinear in x for the plane fit to work
    agent.gasMemory = [
        { ppm: 1.0, time: 0, position: { x: 0, y: 0 } },
        { ppm: 2.0, time: 0.1, position: { x: 1, y: 1 } },
        { ppm: 3.0, time: 0.2, position: { x: 0, y: 2 } },
    ]
    agent.tickCount = 12  // ~0.2 min

    // Force explore mode
    agent.mode = "explore"
    agent.exploreTime = 0

    // Trigger a tick — this should build the circle
    agent._tickExplore()

    assert(agent.tempWaypoints.length > 0, "should have built circle waypoints")
})

Deno.test("integration: recalc delays one tick before rebuilding circle", () => {
    const ps = createPubSubWithOdom()
    const agent = new GasAgent(ps, {
        samplingRate: 1,
        minimumGasThreshold: 0,
        gasSensitivity: 0.01,
        attentionThreshold: 0.01,
        attentionSpan: 10,
        refocusRatio: 600,
        circlingSize: 5,
        circleWaypointCount: 8,
        moveSpeed: 0.5,
        turnSpeed: Math.PI,
        startPosition: { x: 0, y: 0 },
    })
    ps.publish("route_update", { waypoints: [{ x: 0, y: 0 }, { x: 100, y: 0 }] })

    agent.gasMemory = [
        { ppm: 1.0, time: 0, position: { x: 0, y: 0 } },
        { ppm: 2.0, time: 0.1, position: { x: 1, y: 1 } },
        { ppm: 3.0, time: 0.2, position: { x: 0, y: 2 } },
    ]
    agent.tickCount = 12
    agent.mode = "explore"

    // Build initial circle
    agent._tickExplore()
    assert(agent.tempWaypoints.length === 8, "circle should be built")

    // Simulate recalcPending (gas increase found)
    agent.recalcPending = true

    // Tick 1 after recalc: should clear waypoints and pause (no rebuild yet)
    agent._tickExplore()
    assertEquals(agent.tempWaypoints.length, 0, "waypoints should be cleared")

    // Tick 2: now rebuild
    agent._tickExplore()
    assert(agent.tempWaypoints.length > 0, "circle should be rebuilt on next tick")
})

Deno.test("integration: new route during exploration preserves explore state", () => {
    const ps = createPubSubWithOdom()
    const agent = new GasAgent(ps, {
        samplingRate: 1,
        minimumGasThreshold: 0,
        gasSensitivity: 0.01,
        attentionThreshold: 0.01,
        attentionSpan: 10,
        refocusRatio: 600,
    })

    // Set up explore mode manually
    agent.gasMemory = [
        { ppm: 1, time: 0, position: { x: 0, y: 0 } },
        { ppm: 2, time: 0.1, position: { x: 1, y: 0 } },
    ]
    agent.mode = "explore"
    agent.exploreTime = 5

    ps.publish("route_update", { waypoints: [{ x: 50, y: 50 }] })

    // Exploration state preserved
    assertEquals(agent.gasMemory.length, 2)
    assertEquals(agent.exploreTime, 5)
    // Route updated
    assertEquals(agent.routeWaypoints[0].x, 50)
})

// ── Pub/Sub Architecture ─────────────────────────────────────────────

Deno.test("agent publishes metrics as array of label/value pairs", () => {
    const decisionRate = 0.01
    const ps = createPubSubWithOdom({ x: 0, y: 0 }, 0, decisionRate)
    const agent = new GasAgent(ps, { decisionRate })

    let metricsReceived = null
    ps.subscribe('metrics', (data) => {
        metricsReceived = data
    })

    // Trigger gas reading to cause metrics publication
    ps.publish('gas_reading', { ppm: 0.5 })

    assert(metricsReceived !== null, "should have received metrics")
    assert(Array.isArray(metricsReceived), "metrics should be an array")
    assert(metricsReceived.length > 0, "should have at least one metric")
    assert(metricsReceived[0].label !== undefined, "metric should have label")
    assert(metricsReceived[0].value !== undefined, "metric should have value")
})

Deno.test("agent publishes logJson with scalar values only", () => {
    const decisionRate = 0.01
    const ps = createPubSubWithOdom({ x: 0, y: 0 }, 0, decisionRate)
    const agent = new GasAgent(ps, {
        decisionRate,
        minimumGasThreshold: 0.1,
    })

    let logDataReceived = null
    ps.subscribe('logJson', (data) => {
        logDataReceived = data
    })

    // Trigger mode change to inactive → explore
    agent.sensorReading = 0.5  // Above threshold
    agent._updateMode()

    assert(logDataReceived !== null, "should have received logJson data")
    // Verify all values are scalars (not objects)
    Object.values(logDataReceived).forEach(value => {
        assert(typeof value !== 'object' || value === null, `value should be scalar, got ${typeof value}`)
    })
})

// TODO: Fix pubsub identity issue in test - agent and test share same pubsub so messages filtered
Deno.test.ignore("agent publishes visualizePoint with IDs for add/remove", () => {
    const decisionRate = 0.01
    // Create pubsub without identity so agent and test can both receive messages
    const ps = createPubSub()

    // Add odom simulation manually
    ps.subscribe("movement", (data, publisher) => {
        const linearVelocity = data.linearVelocity ?? 0
        const angularVelocity = data.angularVelocity ?? 0
        const forward = linearVelocity * decisionRate
        const rotation = angularVelocity * decisionRate
        // Simple odom simulation
        ps.publish("odom", { x: 0, y: 0, heading: 0 })
    })

    const agent = new GasAgent(ps, {
        decisionRate,
        minimumGasThreshold: 0,
        gasSensitivity: 0.01,
    })

    const visualizationPoints = []
    ps.subscribe('visualizePoint', (data) => {
        visualizationPoints.push(data)
    })

    // Set up for circle building
    agent.gasMemory = [
        { ppm: 1.0, time: 0, position: { x: 0, y: 0 } },
        { ppm: 2.0, time: 1, position: { x: 1, y: 1 } },
        { ppm: 3.0, time: 2, position: { x: 2, y: 2 } },
    ]
    agent.mode = "explore"

    // Build circle
    agent._buildExplorationCircle()

    // Should have published points with IDs
    assert(visualizationPoints.length > 0, "should have published visualization points")
    assert(visualizationPoints[0].id !== undefined, "visualization points should have IDs")

    // Should have centroid
    const centroid = visualizationPoints.find(p => p.id === 'centroid')
    assert(centroid !== undefined, "should have published centroid")

    // Should have waypoints
    const waypoints = visualizationPoints.filter(p => p.id && p.id.startsWith('waypoint_'))
    assert(waypoints.length > 0, "should have published waypoints")
})

Deno.test("integration: position updates correctly after movement", () => {
    const ps = createPubSubWithOdom()
    const agent = new GasAgent(ps, {
        samplingRate: 1,
        minimumGasThreshold: 999,
        moveSpeed: 1,
        turnSpeed: Math.PI,
        startPosition: { x: 0, y: 0 },
        startHeading: 0,
    })
    ps.publish("route_update", { waypoints: [{ x: 10, y: 0 }] })

    ps.publish("gas_reading", { ppm: 0 })

    // Heading 0 means +x direction, should have moved ~1m in x
    assert(agent.position.x > 0, "should have moved in +x")
    assertAlmostEquals(agent.position.y, 0, 0.1)
})

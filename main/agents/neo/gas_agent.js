import { timer } from "../../tooling/time.js"
import simpleRouteAgent from './simple_route_agent.js'

const info = {
    inputs: ["position", "routeUpdate", "waypointReached", "gasReading"],
    outputs: ["targetWaypoint", "logJson", "visualizePoints", "visualizeLines"],
}

/**
 * Fit a plane  gas = a·x + b·y + c  to samples using weighted least-squares
 * (samples closer to `position` receive higher weight).  Returns the gradient
 * of that plane as { angle, slope } where:
 *   - slope  = magnitude of [a, b]  (steepness of the fitted surface)
 *   - angle  = Math.atan2(b, a)     (direction of steepest ascent, radians)
 *
 * @param {{x:number, y:number}} position
 * @param {{time:any, gasReading:number, location:{x:number,y:number}}[]} samples
 * @returns {{ angle:number, slope:number }}
 */
export function gasGradient(position, samples) {
    const pts = []
    for (const s of samples) {
        if (s.location != null && s.gasReading != null) {
            pts.push({ x: s.location.x, y: s.location.y, v: s.gasReading })
        }
    }
    if (pts.length < 3) return { angle: 0, slope: 0 }

    // Weighted least-squares: weight = 1 / (distance + 1)
    let sw = 0, swx = 0, swy = 0, swv = 0
    let swxx = 0, swyy = 0, swxy = 0, swxv = 0, swyv = 0
    for (const p of pts) {
        const d = Math.hypot(p.x - position.x, p.y - position.y)
        const w = 1 / (d + 1)
        sw   += w
        swx  += w * p.x
        swy  += w * p.y
        swv  += w * p.v
        swxx += w * p.x * p.x
        swyy += w * p.y * p.y
        swxy += w * p.x * p.y
        swxv += w * p.x * p.v
        swyv += w * p.y * p.v
    }

    // Solve 3×3 weighted normal equations via Cramer's rule:
    // | swxx swxy swx | | a |   | swxv |
    // | swxy swyy swy | | b | = | swyv |
    // | swx  swy  sw  | | c |   | swv  |
    const det = swxx * (swyy * sw   - swy  * swy)
              - swxy * (swxy * sw   - swy  * swx)
              + swx  * (swxy * swy  - swyy * swx)
    if (Math.abs(det) < 1e-15) return { angle: 0, slope: 0 }

    const a = (swxv * (swyy * sw  - swy  * swy)
             - swxy * (swyv * sw  - swy  * swv)
             + swx  * (swyv * swy - swyy * swv)) / det
    const b = (swxx * (swyv * sw  - swy  * swv)
             - swxv * (swxy * sw  - swy  * swx)
             + swx  * (swxy * swv - swyv * swx)) / det

    return { angle: Math.atan2(b, a), slope: Math.hypot(a, b) }
}

/**
 * Generate `count` waypoints stepping from `position` in direction `angle`,
 * each `stepDist` apart.
 *
 * @param {{x:number,y:number}} position
 * @param {number} angle - radians
 * @param {number} stepDist - distance between waypoints
 * @param {number} count
 * @returns {{x:number,y:number}[]}
 */
export function waypointsAlongGradient(position, angle, stepDist, count) {
    const dx = Math.cos(angle) * stepDist
    const dy = Math.sin(angle) * stepDist
    const pts = []
    for (let i = 1; i <= count; i++) {
        pts.push({ x: position.x + dx * i, y: position.y + dy * i })
    }
    return pts
}

function create({
    gasThreshold = 0.4,           // PPM — minimum reading to trigger gas follow
    bufferSize = 80,              // max number of {time, gasReading, location} entries
    switchingCooldown = 30,       // seconds between mode switches
    routeAgentConfig = {},
    gasMoveOnTime = 20,           // seconds between gas-waypoint recalculations
    gasRateIncreaseRatio = 0.05,  // gradient slope threshold to enter/exit gas follow
    gradientStepDist = 30,        // map units between gas-follow waypoints
    gradientStepCount = 3,        // number of gas-follow waypoints to generate
} = {}) {
    const routeAgent     = simpleRouteAgent.create(routeAgentConfig)
    const gasFollowAgent = simpleRouteAgent.create({})

    const initialArg = {
        updated: {
            position:        false,
            routeUpdate:     false,
            waypointReached: false,
            gasReading:      false,
        },
        state: {
            position:              null,
            routeUpdate:           null,
            waypointReached:       null,
            gasReading:            null,
            maxGasReading:         0,
            cooldown:              null,
            gasFollowRecalculate:  null,
            gasBuffer:             [],
            gasWaypoints:          [],
            gasFollowPendingRoute: null,   // fed to gasFollowAgent on next tick
            mode:                  "idle",
            routeFollowState:      structuredClone(routeAgent.initialArg.state),
            gasFollowState:        structuredClone(gasFollowAgent.initialArg.state),
        },
        outputs: {
            targetWaypoint:  null,
            logJson:         null,
            visualizePoints: null,
            visualizeLines:  null,
        },
    }

    function update(getTime, { state, updated }) {
        const { position, routeUpdate, waypointReached } = state
        let outputs = { targetWaypoint: null, logJson: null, visualizePoints: null, visualizeLines: null }
        state = { ...state }

        // ── Accumulate gas buffer ─────────────────────────────────────
        if (updated.gasReading && state.gasReading != null && position != null) {
            state.maxGasReading = Math.max(state.maxGasReading, state.gasReading)
            state.gasBuffer = [...state.gasBuffer, { time: getTime(), gasReading: state.maxGasReading, location: position }]
            if (state.gasBuffer.length > bufferSize) {
                state.gasBuffer = state.gasBuffer.slice(-bufferSize)
            }
        }

        // ── New route received → enter routeFollow ───────────────────
        if (updated.routeUpdate && routeUpdate != null) {
            state.mode = "routeFollow"
            if (state.cooldown == null) {
                state.cooldown = timer({ duration: switchingCooldown, getTime, data: null })
            }
        }

        // ── Delegate to route-follow sub-agent ───────────────────────
        if (state.mode === "routeFollow") {
            const { outputs: ro, state: rs } = routeAgent.update(getTime, {
                state: {
                    ...state.routeFollowState,
                    position,
                    routeUpdate:     updated.routeUpdate     ? routeUpdate     : null,
                    waypointReached: updated.waypointReached ? waypointReached : null,
                },
                updated: {
                    position:        updated.position,
                    routeUpdate:     updated.routeUpdate,
                    waypointReached: updated.waypointReached,
                },
            })
            state.routeFollowState = rs
            if (ro.targetWaypoint != null) outputs.targetWaypoint = ro.targetWaypoint
            if (ro.logJson        != null) outputs.logJson = { ...outputs.logJson, ...ro.logJson }
        }

        // ── Delegate to gas-follow sub-agent ─────────────────────────
        if (state.mode === "gasFollow") {
            const pendingRoute = state.gasFollowPendingRoute
            state = { ...state, gasFollowPendingRoute: null }
            const { outputs: go, state: gs } = gasFollowAgent.update(getTime, {
                state: {
                    ...state.gasFollowState,
                    position,
                    routeUpdate:     pendingRoute,
                    waypointReached: updated.waypointReached ? waypointReached : null,
                },
                updated: {
                    position:        updated.position,
                    routeUpdate:     pendingRoute != null,
                    waypointReached: updated.waypointReached,
                },
            })
            state.gasFollowState = gs
            if (go.targetWaypoint != null) outputs.targetWaypoint = go.targetWaypoint
            if (go.logJson        != null) outputs.logJson = { ...outputs.logJson, ...go.logJson }
        }

        // ── Always compute and log gradient ──────────────────────────
        const gradient = position != null
            ? gasGradient(position, state.gasBuffer)
            : { angle: 0, slope: 0 }
        outputs.logJson = { ...outputs.logJson, gradientAngle: gradient.angle.toFixed(1), gradientSlope: gradient.slope.toFixed(2) }
        if (position != null) {
            const lineLen = 40
            outputs.visualizeLines = [{ id: 'gradientDir', x1: position.x, y1: position.y, x2: position.x + Math.cos(gradient.angle) * lineLen, y2: position.y + Math.sin(gradient.angle) * lineLen, color: '#00ffcc', lineWidth: 2 }]
        }

        // ── Mode switching (after cooldown expires) ───────────────────
        if (state.cooldown != null && state.cooldown.done) {
            const interest = gradient.slope

            if (state.mode !== "gasFollow") {
                // Enter gas follow if reading is strong and gradient is rising
                if (state.gasBuffer.length >= 3
                        && state.maxGasReading > gasThreshold
                        && interest > gasRateIncreaseRatio) {
                    state.gasWaypoints         = waypointsAlongGradient(position, gradient.angle, gradientStepDist, gradientStepCount)
                    state.gasFollowState       = structuredClone(gasFollowAgent.initialArg.state)
                    state.gasFollowPendingRoute = { waypoints: state.gasWaypoints }
                    state.mode                 = "gasFollow"
                    state.gasFollowRecalculate = timer({ duration: gasMoveOnTime, getTime, data: null })
                    state.cooldown             = timer({ duration: switchingCooldown, getTime, data: null })
                    outputs.logJson = { ...outputs.logJson, gasAgent: `entering gas follow (slope=${interest.toFixed(3)})` }
                    outputs.visualizePoints = state.gasWaypoints.map((wp, i) => ({ id: `gasWp_${i}`, x: wp.x, y: wp.y, color: '#ffaa00', r: 8, label: `G${i+1}` }))
                }
            } else {
                if (interest < gasRateIncreaseRatio) {
                    // Gradient too weak → return to route follow
                    state.mode     = "routeFollow"
                    state.cooldown = timer({ duration: switchingCooldown, getTime, data: null })
                    outputs.logJson = { ...outputs.logJson, gasAgent: `returning to route follow (slope=${interest.toFixed(3)})` }
                    outputs.visualizePoints = Array.from({ length: gradientStepCount }, (_, i) => ({ id: `gasWp_${i}`, remove: true }))
                } else if (state.gasFollowRecalculate != null && state.gasFollowRecalculate.done) {
                    // Recalculate waypoints along updated gradient direction
                    state.gasWaypoints          = waypointsAlongGradient(position, gradient.angle, gradientStepDist, gradientStepCount)
                    state.gasFollowState        = structuredClone(gasFollowAgent.initialArg.state)
                    state.gasFollowPendingRoute = { waypoints: state.gasWaypoints }
                    state.gasFollowRecalculate  = timer({ duration: gasMoveOnTime, getTime, data: null })
                    outputs.logJson = { ...outputs.logJson, gasAgent: `recalculating gas waypoints (slope=${interest.toFixed(3)})` }
                    outputs.visualizePoints = state.gasWaypoints.map((wp, i) => ({ id: `gasWp_${i}`, x: wp.x, y: wp.y, color: '#ffaa00', r: 8, label: `G${i+1}` }))
                }
            }
        }

        outputs.logJson = { maxGasReading: state.maxGasReading.toFixed(2), mode: state.mode, ...outputs.logJson }

        return { state, outputs }
    }

    return { initialArg, info, update }
}

export default { info, create }

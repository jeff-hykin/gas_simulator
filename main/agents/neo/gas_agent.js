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
 * Generate `count` waypoints in a circle around a center point that lies
 * `centerDist` units from `position` in the gradient `angle` direction.
 * The center point itself is not a waypoint — it is only used as the orbit center.
 *
 * @param {{x:number,y:number}} position
 * @param {number} angle - radians, direction of steepest ascent
 * @param {number} centerDist - distance from position to circle center
 * @param {number} circleRadius - radius of the sampling circle
 * @param {number} count - number of waypoints around the circle
 * @returns {{x:number,y:number}[]}
 */
export function circleWaypointsAroundGradient(position, angle, centerDist, circleRadius, count) {
    const center = {
        x: position.x + Math.cos(angle) * centerDist,
        y: position.y + Math.sin(angle) * centerDist,
    }
    const pts = []
    for (let i = 0; i < count; i++) {
        const a = (2 * Math.PI * i) / count
        pts.push({ x: center.x + Math.cos(a) * circleRadius, y: center.y + Math.sin(a) * circleRadius })
    }
    return pts
}

function create({
    gasThreshold = 0.4,          // PPM — minimum reading to trigger gas follow
    bufferSize = 200,            // max number of {time, gasReading, location} entries
    switchingCooldown = 10,      // ticks between mode switches
    routeAgentConfig = {},
    gasMoveOnTime = 20,           // seconds between gas-waypoint recalculations
    gasRateIncreaseRatio = 0.002,  // gradient slope threshold to enter/exit gas follow
    gradientCenterDist = 50,      // map units from position to circle center (along gradient)
    gradientCircleRadius = 60,    // radius of the sampling circle
    gradientStepCount = 8,        // number of waypoints around the circle
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
        console.log(`[GAS] update: mode=${state.mode} updated=${JSON.stringify(updated)} pos=${position ? `(${position.x.toFixed(1)},${position.y.toFixed(1)})` : 'null'} maxGas=${state.maxGasReading.toFixed(2)} bufLen=${state.gasBuffer.length}`)

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
            console.log(`[GAS-ROUTE] routeAgent output: targetWaypoint=${ro.targetWaypoint ? `(${ro.targetWaypoint.x.toFixed(1)},${ro.targetWaypoint.y.toFixed(1)})` : 'null'} logJson=${JSON.stringify(ro.logJson)}`)
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
        outputs.logJson = { ...outputs.logJson, gradientAngle: gradient.angle.toFixed(1), gradientSlope: gradient.slope.toFixed(4) }
        if (position != null) {
            const lineLen = 40
            outputs.visualizeLines = [{ id: 'gradientDir', x1: position.x, y1: position.y, x2: position.x + Math.cos(gradient.angle) * lineLen, y2: position.y + Math.sin(gradient.angle) * lineLen, color: '#00ffcc', lineWidth: 2 }]
        }

        // ── Mode switching (after cooldown expires) ───────────────────
        if (state.cooldown != null && state.cooldown.done) {
            const interest = gradient.slope

            if (interest > gasRateIncreaseRatio) {
                console.log(`GasAgent: interest=${interest.toFixed(3)} > threshold=${gasRateIncreaseRatio}, mode=${state.mode}, maxGas=${state.maxGasReading.toFixed(2)}`)
            }

            if (state.mode !== "gasFollow") {
                // Enter gas follow if reading is strong and gradient is rising
                if (state.gasBuffer.length >= 3
                        && state.maxGasReading > gasThreshold
                        && interest > gasRateIncreaseRatio) {
                    state.gasWaypoints         = circleWaypointsAroundGradient(position, gradient.angle, gradientCenterDist, gradientCircleRadius, gradientStepCount)
                    state.gasFollowState       = structuredClone(gasFollowAgent.initialArg.state)
                    state.gasFollowPendingRoute = { waypoints: state.gasWaypoints }
                    state.mode                 = "gasFollow"
                    state.gasFollowRecalculate = timer({ duration: gasMoveOnTime, getTime, data: null })
                    state.cooldown             = timer({ duration: switchingCooldown, getTime, data: null })
                    outputs.logJson = { ...outputs.logJson, gasAgent: `entering gas follow (slope=${interest.toFixed(3)})` }
                    const center0 = { x: position.x + Math.cos(gradient.angle) * gradientCenterDist, y: position.y + Math.sin(gradient.angle) * gradientCenterDist }
                    outputs.visualizePoints = [{ id: 'gasCenter', x: center0.x, y: center0.y, color: '#ff4400', r: 5, label: 'C' }, ...state.gasWaypoints.map((wp, i) => ({ id: `gasWp_${i}`, x: wp.x, y: wp.y, color: '#ffaa00', r: 8, label: `G${i+1}` }))]
                }
            } else {
                if (interest < gasRateIncreaseRatio) {
                    // Gradient too weak → return to route follow
                    state.mode     = "routeFollow"
                    state.cooldown = timer({ duration: switchingCooldown, getTime, data: null })
                    outputs.logJson = { ...outputs.logJson, gasAgent: `returning to route follow (slope=${interest.toFixed(3)})` }
                    outputs.visualizePoints = [{ id: 'gasCenter', remove: true }, ...Array.from({ length: gradientStepCount }, (_, i) => ({ id: `gasWp_${i}`, remove: true }))]
                } else if (state.gasFollowRecalculate != null && state.gasFollowRecalculate.done) {
                    // Recalculate waypoints along updated gradient direction
                    state.gasWaypoints          = circleWaypointsAroundGradient(position, gradient.angle, gradientCenterDist, gradientCircleRadius, gradientStepCount)
                    state.gasFollowState        = structuredClone(gasFollowAgent.initialArg.state)
                    state.gasFollowPendingRoute = { waypoints: state.gasWaypoints }
                    state.gasFollowRecalculate  = timer({ duration: gasMoveOnTime, getTime, data: null })
                    outputs.logJson = { ...outputs.logJson, gasAgent: `recalculating gas waypoints (slope=${interest.toFixed(3)})` }
                    const center1 = { x: position.x + Math.cos(gradient.angle) * gradientCenterDist, y: position.y + Math.sin(gradient.angle) * gradientCenterDist }
                    outputs.visualizePoints = [{ id: 'gasCenter', x: center1.x, y: center1.y, color: '#ff4400', r: 5, label: 'C' }, ...state.gasWaypoints.map((wp, i) => ({ id: `gasWp_${i}`, x: wp.x, y: wp.y, color: '#ffaa00', r: 8, label: `G${i+1}` }))]
                }
            }
        }

        // ── Circle complete → start new circle immediately ────────────
        if (state.mode === "gasFollow" && state.gasFollowPendingRoute == null && position != null) {
            const { routeWaypoints, currentWaypointIndex } = state.gasFollowState
            if (routeWaypoints.length > 0 && currentWaypointIndex >= routeWaypoints.length) {
                state.gasWaypoints         = circleWaypointsAroundGradient(position, gradient.angle, gradientCenterDist, gradientCircleRadius, gradientStepCount)
                state.gasFollowState       = structuredClone(gasFollowAgent.initialArg.state)
                state.gasFollowPendingRoute = { waypoints: state.gasWaypoints }
                state.gasFollowRecalculate  = timer({ duration: gasMoveOnTime, getTime, data: null })
                outputs.logJson = { ...outputs.logJson, gasAgent: `new circle (slope=${gradient.slope.toFixed(3)})` }
                const centerC = { x: position.x + Math.cos(gradient.angle) * gradientCenterDist, y: position.y + Math.sin(gradient.angle) * gradientCenterDist }
                outputs.visualizePoints = [{ id: 'gasCenter', x: centerC.x, y: centerC.y, color: '#ff4400', r: 5, label: 'C' }, ...state.gasWaypoints.map((wp, i) => ({ id: `gasWp_${i}`, x: wp.x, y: wp.y, color: '#ffaa00', r: 8, label: `G${i+1}` }))]
            }
        }

        outputs.logJson = { maxGasReading: state.maxGasReading.toFixed(2), mode: state.mode, cooldown: state.cooldown == null ? "none" : state.cooldown.done ? "done" : state.cooldown.count.toFixed(1), ...outputs.logJson }

        console.log(`[GAS-OUT] targetWaypoint=${outputs.targetWaypoint ? `(${outputs.targetWaypoint.x.toFixed(1)},${outputs.targetWaypoint.y.toFixed(1)})` : 'null'} mode=${state.mode}`)
        return { state, outputs }
    }

    return { initialArg, info, update }
}

export default { info, create }

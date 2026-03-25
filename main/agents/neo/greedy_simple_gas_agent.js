import simpleRouteAgent from './simple_route_agent.js'
import { gasGradient } from './gas_agent.js'

const info = {
    inputs: ["position", "routeUpdate", "waypointReached", "gasReading"],
    outputs: ["targetWaypoint", "logJson", "visualizePoints", "visualizeLines", "vectorField"],
}

function create({
    gasThreshold = 0.4,
    gasFollowDuration = 200,       // ticks of gas-following after threshold is hit
    bufferSize = 200,
    stepDistance = 30,
    perturbAngle = 0.3,
    minSamplesForGradient = 3,
    gasRateIncreaseRatio = 0.002,
    vectorFieldGridSize = 5,
    vectorFieldSpacing = 40,
    vectorFieldArrowLen = 25,
    routeAgentConfig = {},
} = {}) {
    const routeAgent = simpleRouteAgent.create(routeAgentConfig)

    const initialArg = {
        updated: {
            position:        false,
            routeUpdate:     false,
            waypointReached: false,
            gasReading:      false,
        },
        state: {
            position:         null,
            routeUpdate:      null,
            waypointReached:  null,
            gasReading:       null,
            gasBuffer:        [],
            mode:             "idle",       // "idle" | "routeFollow" | "gasFollow"
            gasFollowCounter: 0,            // ticks remaining in gasFollow
            currentHeading:   null,
            routeFollowState: structuredClone(routeAgent.initialArg.state),
        },
        outputs: {
            targetWaypoint:  null,
            logJson:         null,
            visualizePoints: null,
            visualizeLines:  null,
            vectorField:     null,
        },
    }

    function update(getTime, { state, updated }) {
        const { position, routeUpdate, waypointReached } = state
        let outputs = { targetWaypoint: null, logJson: null, visualizePoints: null, visualizeLines: null, vectorField: null }
        state = { ...state }

        // ── Accumulate gas buffer ──────────────────────────────────
        if (updated.gasReading && state.gasReading != null && position != null) {
            state.gasBuffer = [...state.gasBuffer, { time: getTime(), gasReading: state.gasReading, location: position }]
            if (state.gasBuffer.length > bufferSize) {
                state.gasBuffer = state.gasBuffer.slice(-bufferSize)
            }
        }

        // ── New route → enter routeFollow ──────────────────────────
        if (updated.routeUpdate && routeUpdate != null) {
            state.mode = "routeFollow"
        }

        // ── Route follow: delegate to sub-agent ────────────────────
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

        // ── Compute gradient ───────────────────────────────────────
        const gradient = position != null
            ? gasGradient(position, state.gasBuffer)
            : { angle: 0, slope: 0 }

        // ── Switch: routeFollow → gasFollow when threshold hit ─────
        if (state.mode === "routeFollow"
            && state.gasReading != null
            && state.gasReading > gasThreshold
            && gradient.slope > gasRateIncreaseRatio
            && state.gasBuffer.length >= minSamplesForGradient) {
            state.mode = "gasFollow"
            state.gasFollowCounter = gasFollowDuration
            state.currentHeading = gradient.angle
        }

        // ── Gas follow: chase gradient for N ticks ─────────────────
        if (state.mode === "gasFollow" && position != null) {
            state.gasFollowCounter = state.gasFollowCounter - 1

            // pick heading
            if (gradient.slope > gasRateIncreaseRatio && state.gasBuffer.length >= minSamplesForGradient) {
                state.currentHeading = gradient.angle
            } else if (state.currentHeading != null) {
                state.currentHeading += (Math.random() - 0.5) * 2 * perturbAngle
            }

            // place waypoint ahead
            if (state.currentHeading != null) {
                const wp = {
                    x: position.x + Math.cos(state.currentHeading) * stepDistance,
                    y: position.y + Math.sin(state.currentHeading) * stepDistance,
                }
                outputs.targetWaypoint = wp
                outputs.visualizePoints = [{ id: 'gasTarget', x: wp.x, y: wp.y, color: '#ff4400', r: 6, label: 'G' }]
            }

            // countdown expired → back to route
            if (state.gasFollowCounter <= 0) {
                state.mode = "routeFollow"
                state.currentHeading = null
                outputs.visualizePoints = [{ id: 'gasTarget', remove: true }]
            }
        }

        // ── Gradient visualization (always) ────────────────────────
        if (position != null) {
            const lineLen = 40
            outputs.visualizeLines = [{
                id: 'gradientDir',
                x1: position.x, y1: position.y,
                x2: position.x + Math.cos(gradient.angle) * lineLen,
                y2: position.y + Math.sin(gradient.angle) * lineLen,
                color: '#00ffcc', lineWidth: 2,
            }]

            // vector field
            if (state.gasBuffer.length >= minSamplesForGradient) {
                const half = Math.floor(vectorFieldGridSize / 2)
                const arrows = []
                for (let gi = -half; gi <= half; gi++) {
                    for (let gj = -half; gj <= half; gj++) {
                        const px = position.x + gi * vectorFieldSpacing
                        const py = position.y + gj * vectorFieldSpacing
                        const localGrad = gasGradient({ x: px, y: py }, state.gasBuffer)
                        if (localGrad.slope > 1e-6) {
                            const scale = Math.min(localGrad.slope / gasRateIncreaseRatio, 1) * vectorFieldArrowLen
                            arrows.push({
                                x: px, y: py,
                                dx: Math.cos(localGrad.angle) * scale,
                                dy: Math.sin(localGrad.angle) * scale,
                                slope: localGrad.slope,
                            })
                        }
                    }
                }
                outputs.vectorField = arrows
            }
        }

        outputs.logJson = {
            mode: state.mode,
            gasFollowRemaining: state.gasFollowCounter,
            gas: (state.gasReading || 0).toFixed(3),
            gradientSlope: gradient.slope.toFixed(4),
            ...outputs.logJson,
        }

        return { state, outputs }
    }

    return { initialArg, info, update }
}

export default { info, create }

import simpleRouteAgent from './simple_route_agent.js'

const info = {
    inputs: ["position", "routeUpdate", "waypointReached", "maxGasReading"],
    outputs: ["targetWaypoint", "logJson", "visualizePoints", "visualizeLines", "toast"],
}

const DEG5 = 5 * Math.PI / 180
const DEG1 = 1 * Math.PI / 180

function gasToColor(t) {
    t = Math.max(0, Math.min(1, t))
    const r = Math.round(255 - 55 * t)
    const g = Math.round(160 * t)
    const b = Math.round(160 * t)
    return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')
}

function create({
    minGasToEnter = 0.1,
    gasIncreaseThreshold = 0.005,
    turnAngle = Math.PI / 6,
    stepDistance = 30,
    maxRandomTurns = 15,
    steerStep = DEG5,
    steerDecrement = DEG1,
    waypointTimeout = 2,
    gasFollowTimeout = 60,        // seconds: exit gasFollow after this long regardless
    routeAgentConfig = {},
} = {}) {
    const routeAgent = simpleRouteAgent.create(routeAgentConfig)

    const initialArg = {
        updated: {
            position:        false,
            routeUpdate:     false,
            waypointReached: false,
            maxGasReading:   false,
        },
        state: {
            position:         null,
            routeUpdate:      null,
            waypointReached:  null,
            maxGasReading:    null,
            mode:             "idle",
            currentHeading:   null,
            prevPrevGas:      0,
            prevGas:          0,
            bestGasThisLeg:   0,
            randomTurnCount:  0,
            currentSteer:     0,
            prevSteer:        0,
            waypointSetTime:  null,
            gasFollowStartTime: null,
            peakGasInFollow:  0,
            gasDotCount:      0,
            prevMaxGasForDot: null,
            firstSteerDone:   false,
            routeFollowState: structuredClone(routeAgent.initialArg.state),
        },
        outputs: {
            targetWaypoint:  null,
            logJson:         null,
            visualizePoints: null,
            visualizeLines:  null,
            toast:           null,
        },
    }

    function update(getTime, { state, updated }) {
        const { position, routeUpdate, waypointReached } = state
        let outputs = { targetWaypoint: null, logJson: null, visualizePoints: null, visualizeLines: null, toast: null }
        state = { ...state }
        const time = getTime()

        // ── Track best gas seen on current leg ───────────────────
        if (updated.maxGasReading && state.maxGasReading != null) {
            state.bestGasThisLeg = Math.max(state.bestGasThisLeg, state.maxGasReading)
            if (state.mode === "gasFollow") {
                state.peakGasInFollow = Math.max(state.peakGasInFollow, state.maxGasReading)
            }

            // ── Drop topology dot ────────────────────────────────────
            if (position != null) {
                const unchanged = state.prevMaxGasForDot != null && state.maxGasReading === state.prevMaxGasForDot
                const t = (state.maxGasReading > 0 && minGasToEnter > 0)
                    ? Math.max(0, Math.min(1, Math.log10(state.maxGasReading) / Math.log10(minGasToEnter)))
                    : 0
                const dotColor = gasToColor(t)
                const dotId = `gasDot_${state.gasDotCount++}`
                const dot = {
                    id: dotId, x: position.x, y: position.y, r: 3,
                    color: dotColor,
                    fill: dotColor,
                }
                if (unchanged) dot.stroke = '#ffffff'
                outputs.visualizePoints = [
                    ...(outputs.visualizePoints || []),
                    dot,
                ]
                state.prevMaxGasForDot = state.maxGasReading
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

        // ── Switch: routeFollow → gasFollow when gas is increasing ─
        if (state.mode === "routeFollow"
            && updated.maxGasReading
            && state.maxGasReading != null
            && state.maxGasReading >= minGasToEnter
            && state.bestGasThisLeg - state.prevGas > gasIncreaseThreshold) {
            outputs.toast = { message: `Gas detected — following gradient (${state.maxGasReading.toFixed(2)} PPM)`, type: "success" }
            state.mode = "gasFollow"
            state.randomTurnCount = 0
            state.currentSteer = 0
            state.prevSteer = 0
            state.prevPrevGas = 0
            state.gasFollowStartTime = time
            state.peakGasInFollow = state.maxGasReading
            state.prevGas = state.bestGasThisLeg
            state.bestGasThisLeg = 0
            if (position != null && position.heading != null) {
                state.currentHeading = position.heading
            } else {
                state.currentHeading = 0
            }
            // place initial waypoint ahead
            const wp = {
                x: position.x + Math.cos(state.currentHeading) * stepDistance,
                y: position.y + Math.sin(state.currentHeading) * stepDistance,
            }
            outputs.targetWaypoint = wp
            outputs.visualizePoints = [{ id: 'hillTarget', x: wp.x, y: wp.y, color: '#ffaa00', r: 6, label: 'ML' }]
            state.waypointSetTime = time
        }

        // ── Gas follow: decide when waypoint is reached or timed out ─
        if (state.mode === "gasFollow" && position != null) {
            const timedOut = state.waypointSetTime != null
                && (time - state.waypointSetTime) > waypointTimeout
            if (updated.waypointReached || timedOut) {
                // we arrived at the waypoint — compare best gas this leg vs previous leg
                const improved = state.bestGasThisLeg > state.prevGas + gasIncreaseThreshold

                if (improved) {
                    // gas improved → apply steering and reset random turn count
                    state.randomTurnCount = 0

                    if (state.currentSteer === 0 && state.prevSteer === 0) {
                        const direction = !state.firstSteerDone
                            ? -1
                            : (Math.random() < 0.5 ? -1 : 1)
                        state.firstSteerDone = true
                        state.prevSteer = state.currentSteer
                        state.currentSteer = direction * steerStep
                    }

                    state.currentHeading = (state.currentHeading || 0) + state.currentSteer
                } else {
                    // gas got worse → decrement steer back toward 0
                    if (state.currentSteer > 0) {
                        state.prevSteer = state.currentSteer
                        state.currentSteer = Math.max(0, state.currentSteer - steerDecrement)
                    } else if (state.currentSteer < 0) {
                        state.prevSteer = state.currentSteer
                        state.currentSteer = Math.min(0, state.currentSteer + steerDecrement)
                    }

                    state.currentHeading = (state.currentHeading || 0) + state.currentSteer

                    // if steer has hit 0 → random turn
                    if (state.currentSteer === 0) {
                        const direction = Math.random() < 0.5 ? -1 : 1
                        state.currentHeading = state.currentHeading + direction * turnAngle
                        state.randomTurnCount = state.randomTurnCount + 1
                        state.prevSteer = 0
                    }
                }

                // shift gas history
                state.prevPrevGas = state.prevGas
                state.prevGas = state.bestGasThisLeg
                state.bestGasThisLeg = 0

                // ── Timer-based exit: give up after gasFollowTimeout seconds ──
                const gasFollowingTimeSpent = time - state.gasFollowStartTime
                if (gasFollowingTimeSpent > gasFollowTimeout) {
                    state.randomTurnCount = maxRandomTurns + 1
                }

                // too many random turns → back to route
                if (state.randomTurnCount > maxRandomTurns) {
                    outputs.toast = { message: "Resuming route", type: "info" }
                    state.mode = "routeFollow"
                    state.currentHeading = null
                    state.prevPrevGas = 0
                    state.prevGas = state.maxGasReading || 0
                    state.bestGasThisLeg = 0
                    state.randomTurnCount = 0
                    state.currentSteer = 0
                    state.prevSteer = 0
                    state.waypointSetTime = null
                    state.gasFollowStartTime = null
                    state.peakGasInFollow = 0
                    state.routeFollowState = {
                        ...state.routeFollowState,
                        currentPublishedWaypoint: null,
                        currentWaypointStartTime: null,
                        currentWaypointInitialDistance: null,
                        ticksOnCurrentWaypoint: 0,
                    }
                    outputs.visualizePoints = [{ id: 'hillTarget', remove: true }]
                }

                // place next waypoint if still in gasFollow
                if (state.mode === "gasFollow" && state.currentHeading != null) {
                    const wp = {
                        x: position.x + Math.cos(state.currentHeading) * stepDistance,
                        y: position.y + Math.sin(state.currentHeading) * stepDistance,
                    }
                    outputs.targetWaypoint = wp
                    outputs.visualizePoints = [{ id: 'hillTarget', x: wp.x, y: wp.y, color: '#ffaa00', r: 6, label: 'ML' }]
                    state.waypointSetTime = time
                }
            }
        }

        const headingDeg = state.currentHeading != null ? (state.currentHeading * 180 / Math.PI).toFixed(0) + "°" : "none"
        const steerDeg = (state.currentSteer * 180 / Math.PI).toFixed(1)
        const gasFollowingTimeSpent = state.gasFollowStartTime != null ? time - state.gasFollowStartTime : 0
        outputs.logJson = {
            mode: state.mode,
            randomTurns: `${state.randomTurnCount}/${maxRandomTurns}`,
            maxGas: (state.maxGasReading || 0).toFixed(4),
            prevGas: state.prevGas.toFixed(4),
            bestThisLeg: state.bestGasThisLeg.toFixed(4),
            heading: headingDeg,
            steer: `${steerDeg}°`,
            followTime: gasFollowingTimeSpent.toFixed(1),
            peakGas: state.peakGasInFollow.toFixed(4),
            time: time.toFixed(1),
            ...outputs.logJson,
        }

        return { state, outputs }
    }

    return { initialArg, info, update }
}

export default { info, create }

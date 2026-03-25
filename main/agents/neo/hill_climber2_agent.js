import simpleRouteAgent from './simple_route_agent.js'

const info = {
    inputs: ["position", "routeUpdate", "waypointReached", "gasReading"],
    outputs: ["targetWaypoint", "logJson", "visualizePoints", "visualizeLines"],
}

function create({
    minGasToEnter = 0.1,          // minimum gas PPM to even consider entering gasFollow
    gasIncreaseThreshold = 0.005, // switch to gasFollow when current - prev > this
    turnAngle = Math.PI / 6,
    stepDistance = 30,
    maxRandomTurns = 15,          // exit gasFollow after this many consecutive random turns
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
            mode:             "idle",
            currentHeading:   null,
            prevGas:          0,        // gas at previous waypoint
            bestGasThisLeg:   0,        // best gas seen while traveling to current waypoint
            randomTurnCount:  0,
            routeFollowState: structuredClone(routeAgent.initialArg.state),
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
        const time = getTime()

        // ── Track best gas seen on current leg ───────────────────
        if (updated.gasReading && state.gasReading != null) {
            state.bestGasThisLeg = Math.max(state.bestGasThisLeg, state.gasReading)
            console.log(`[HC2] gasReading=${state.gasReading.toFixed(4)} bestThisLeg=${state.bestGasThisLeg.toFixed(4)} prevGas=${state.prevGas.toFixed(4)} mode=${state.mode}`)
        }

        // ── New route → enter routeFollow ──────────────────────────
        if (updated.routeUpdate && routeUpdate != null) {
            console.log(`[HC2] new route received, entering routeFollow`)
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
            && updated.gasReading
            && state.gasReading != null
            && state.gasReading >= minGasToEnter
            && state.bestGasThisLeg - state.prevGas > gasIncreaseThreshold) {
            console.log(`[HC2] *** ENTERING gasFollow *** gas=${state.gasReading.toFixed(4)} bestThisLeg=${state.bestGasThisLeg.toFixed(4)} prevGas=${state.prevGas.toFixed(4)} delta=${(state.bestGasThisLeg - state.prevGas).toFixed(4)}`)
            state.mode = "gasFollow"
            state.randomTurnCount = 0
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
            outputs.visualizePoints = [{ id: 'hillTarget', x: wp.x, y: wp.y, color: '#ffaa00', r: 6, label: 'H2' }]
            console.log(`[HC2] initial waypoint: (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)}) heading=${(state.currentHeading * 180 / Math.PI).toFixed(1)}°`)
        }

        // ── Gas follow: decide when waypoint is reached ────────────
        if (state.mode === "gasFollow" && position != null) {
            if (updated.waypointReached) {
                // we arrived at the waypoint — compare best gas this leg vs previous leg
                const improved = state.bestGasThisLeg > state.prevGas + gasIncreaseThreshold
                console.log(`[HC2] waypointReached! bestThisLeg=${state.bestGasThisLeg.toFixed(4)} prevGas=${state.prevGas.toFixed(4)} improved=${improved} randomTurns=${state.randomTurnCount}/${maxRandomTurns}`)

                if (improved) {
                    // gas improved → keep going straight, reset random turn count
                    state.randomTurnCount = 0
                    console.log(`[HC2] gas improved → going straight, reset turns`)
                } else {
                    // no improvement → random turn
                    const direction = Math.random() < 0.5 ? -1 : 1
                    state.currentHeading = (state.currentHeading || 0) + direction * turnAngle
                    state.randomTurnCount = state.randomTurnCount + 1
                    console.log(`[HC2] no improvement → random turn ${direction > 0 ? '+' : '-'}${(turnAngle * 180 / Math.PI).toFixed(0)}° newHeading=${(state.currentHeading * 180 / Math.PI).toFixed(1)}° turns=${state.randomTurnCount}/${maxRandomTurns}`)
                }

                // save this leg's best as reference, reset for next leg
                state.prevGas = state.bestGasThisLeg
                state.bestGasThisLeg = 0

                // too many random turns → back to route
                if (state.randomTurnCount > maxRandomTurns) {
                    console.log(`[HC2] *** EXITING gasFollow *** too many random turns (${state.randomTurnCount})`)
                    state.mode = "routeFollow"
                    state.currentHeading = null
                    state.prevGas = 0
                    state.bestGasThisLeg = 0
                    state.randomTurnCount = 0
                    outputs.visualizePoints = [{ id: 'hillTarget', remove: true }]
                }

                // place next waypoint if still in gasFollow
                if (state.mode === "gasFollow" && state.currentHeading != null) {
                    const wp = {
                        x: position.x + Math.cos(state.currentHeading) * stepDistance,
                        y: position.y + Math.sin(state.currentHeading) * stepDistance,
                    }
                    outputs.targetWaypoint = wp
                    outputs.visualizePoints = [{ id: 'hillTarget', x: wp.x, y: wp.y, color: '#ffaa00', r: 6, label: 'H2' }]
                    console.log(`[HC2] next waypoint: (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)})`)
                }
            }
        }

        const headingDeg = state.currentHeading != null ? (state.currentHeading * 180 / Math.PI).toFixed(0) + "°" : "none"
        outputs.logJson = {
            mode: state.mode,
            randomTurns: `${state.randomTurnCount}/${maxRandomTurns}`,
            rawGas: (state.gasReading || 0).toFixed(4),
            prevGas: state.prevGas.toFixed(4),
            bestThisLeg: state.bestGasThisLeg.toFixed(4),
            heading: headingDeg,
            time: time.toFixed(1),
            posX: position ? position.x.toFixed(1) : "?",
            posY: position ? position.y.toFixed(1) : "?",
            ...outputs.logJson,
        }

        return { state, outputs }
    }

    return { initialArg, info, update }
}

export default { info, create }

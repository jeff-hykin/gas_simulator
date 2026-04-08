import simpleRouteAgent from './simple_route_agent.js'
import { awayFromRoute } from '../../tooling/math_helpers.js'

const info = {
    inputs: ["position", "routeUpdate", "waypointReached", "maxGasReading"],
    outputs: ["targetWaypoint", "logJson", "visualizePoints", "visualizeLines"],
}

const DEG5 = 5 * Math.PI / 180   // 5 degrees in radians
const DEG1 = 1 * Math.PI / 180   // 1 degree in radians

// Map a normalized value [0,1] to desaturated red → saturated red
function gasToColor(t) {
    t = Math.max(0, Math.min(1, t))
    // At t=0: fully saturated red (255, 0, 0), at t=1: desaturated red (200, 160, 160)
    const r = Math.round(255 - 55 * t)
    const g = Math.round(160 * t)
    const b = Math.round(160 * t)
    return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')
}

function create({
    minGasToEnter = 0.1,          // minimum gas PPM to even consider entering gasFollow
    gasIncreaseThreshold = 0.005, // switch to gasFollow when current - prev > this
    turnAngle = Math.PI / 6,
    stepDistance = 30,
    returnsAfterRandomTurns = 10, // return to lost-scent position after this many consecutive random turns
    maxRandomTurns = 15,          // exit gasFollow after this many consecutive random turns (including post-return)
    steerStep = DEG5,             // initial steering bias when things are improving
    steerDecrement = DEG1,        // how much to reduce steer toward 0 when things get worse
    waypointTimeout = 2,         // seconds before giving up on a waypoint (e.g. stuck on building)
    minProductivity = 0.05,       // exit gasFollow if productivity drops below this (productivity=average rate of gas increase while searching for gas)
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
            prevPrevGas:      0,        // gas two waypoints ago
            prevGas:          0,        // gas at previous waypoint
            bestGasThisLeg:   0,        // best gas seen while traveling to current waypoint
            randomTurnCount:  0,
            currentSteer:     0,        // steering bias in radians (+ = right, - = left)
            prevSteer:        0,        // what currentSteer was last decision
            waypointSetTime:  null,     // when the current gasFollow waypoint was placed
            lostScentPos:     null,     // {x,y} where gradient first zeroed out
            returningToScent: false,    // true when navigating back to lostScentPos
            gasFollowStartTime: null,   // when gasFollow mode was entered (virtual time)
            peakGasInFollow:  0,        // highest maxGasReading seen during this gasFollow session
            gasDotCount:      0,        // incrementing ID for gas topology dots
            prevMaxGasForDot: null,     // previous maxGasReading value for border comparison
            gasDotPeakSeen:   0,        // running peak for normalizing dot colors
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
        if (updated.maxGasReading && state.maxGasReading != null) {
            state.bestGasThisLeg = Math.max(state.bestGasThisLeg, state.maxGasReading)
            if (state.mode === "gasFollow") {
                state.peakGasInFollow = Math.max(state.peakGasInFollow, state.maxGasReading)
            }

            // ── Drop topology dot ────────────────────────────────────
            if (position != null) {
                const unchanged = state.prevMaxGasForDot != null && state.maxGasReading === state.prevMaxGasForDot
                // Log-scale normalization: ~0 → 0, minGasToEnter → 1
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

            console.log(`[HC2] maxGasReading=${state.maxGasReading.toFixed(4)} bestThisLeg=${state.bestGasThisLeg.toFixed(4)} prevGas=${state.prevGas.toFixed(4)} mode=${state.mode}`)
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
            && updated.maxGasReading
            && state.maxGasReading != null
            && state.maxGasReading >= minGasToEnter
            && state.bestGasThisLeg - state.prevGas > gasIncreaseThreshold) {
            console.log(`[HC2] *** ENTERING gasFollow *** maxGas=${state.maxGasReading.toFixed(4)} bestThisLeg=${state.bestGasThisLeg.toFixed(4)} prevGas=${state.prevGas.toFixed(4)} delta=${(state.bestGasThisLeg - state.prevGas).toFixed(4)}`)
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
            outputs.visualizePoints = [{ id: 'hillTarget', x: wp.x, y: wp.y, color: '#ffaa00', r: 6, label: 'H2' }]
            state.waypointSetTime = time
            console.log(`[HC2] initial waypoint: (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)}) heading=${(state.currentHeading * 180 / Math.PI).toFixed(1)}°`)
        }

        // ── Gas follow: decide when waypoint is reached or timed out ─
        if (state.mode === "gasFollow" && position != null) {
            // no timeout while returning to scent (it may be far away)
            const timedOut = !state.returningToScent
                && state.waypointSetTime != null
                && (time - state.waypointSetTime) > waypointTimeout
            if (timedOut) {
                console.log(`[HC2] *** WAYPOINT TIMEOUT *** after ${(time - state.waypointSetTime).toFixed(1)}s → treating as failed leg, random turn`)
            }
            if (updated.waypointReached || timedOut) {
                // ── Returning to scent: on arrival, reset and resume ──
                if (state.returningToScent) {
                    console.log(`[HC2] arrived back at lost-scent position → resuming exploration`)
                    state.returningToScent = false
                    state.lostScentPos = null
                    outputs.visualizePoints = [{ id: 'lostScent', remove: true }]
                    state.randomTurnCount = 0
                    state.currentSteer = 0
                    state.prevSteer = 0
                    state.bestGasThisLeg = 0
                    // pick a random heading to try from here
                    state.currentHeading = Math.random() * 2 * Math.PI
                    const wp = {
                        x: position.x + Math.cos(state.currentHeading) * stepDistance,
                        y: position.y + Math.sin(state.currentHeading) * stepDistance,
                    }
                    outputs.targetWaypoint = wp
                    outputs.visualizePoints = [{ id: 'hillTarget', x: wp.x, y: wp.y, color: '#ffaa00', r: 6, label: 'H2' }]
                    state.waypointSetTime = time
                    console.log(`[HC2] random heading=${(state.currentHeading * 180 / Math.PI).toFixed(1)}° wp=(${wp.x.toFixed(1)}, ${wp.y.toFixed(1)})`)
                    // skip normal decision logic this tick
                    return { state, outputs: { ...outputs, logJson: { mode: 'gasFollow-returnArrived', ...outputs.logJson } } }
                }

                // we arrived at the waypoint — compare best gas this leg vs previous leg
                const improved       = state.bestGasThisLeg > state.prevGas + gasIncreaseThreshold
                const prevImproved   = state.prevGas > state.prevPrevGas + gasIncreaseThreshold
                console.log(`[HC2] waypointReached! bestThisLeg=${state.bestGasThisLeg.toFixed(4)} prevGas=${state.prevGas.toFixed(4)} prevPrevGas=${state.prevPrevGas.toFixed(4)} improved=${improved} prevImproved=${prevImproved} steer=${(state.currentSteer * 180 / Math.PI).toFixed(1)}° prevSteer=${(state.prevSteer * 180 / Math.PI).toFixed(1)}° randomTurns=${state.randomTurnCount}/${maxRandomTurns}`)

                if (improved) {
                    // gas improved → apply steering and reset random turn count
                    state.randomTurnCount = 0
                    // update last-known-good position (where gradient was still positive)
                    state.lostScentPos = { x: position.x, y: position.y }

                    // steering feedback: fine-tune the heading
                    if (state.currentSteer === 0 && state.prevSteer === 0) {
                        // no steering yet → bias away from route
                        const route = state.routeFollowState.routeWaypoints
                        // const direction = (route && route.length >= 2 && position)
                        //     ? awayFromRoute({ location: position, heading: state.currentHeading || 0, route })
                        //     : (Math.random() < 0.5 ? -1 : 1)
                        const direction = (Math.random() < 0.5 ? -1 : 1)
                        state.prevSteer = state.currentSteer
                        state.currentSteer = direction * steerStep
                        console.log(`[HC2] gas improved, no steer yet → steering away from route: ${(state.currentSteer * 180 / Math.PI).toFixed(1)}° bias`)
                    } else {
                        // already steering → keep it as-is
                        console.log(`[HC2] gas improved, keeping steer=${(state.currentSteer * 180 / Math.PI).toFixed(1)}°`)
                    }

                    // apply steering bias to heading
                    state.currentHeading = (state.currentHeading || 0) + state.currentSteer
                    console.log(`[HC2] applied steer → heading=${(state.currentHeading * 180 / Math.PI).toFixed(1)}°`)
                } else {
                    // gas got worse → decrement steer back toward 0
                    if (state.currentSteer > 0) {
                        state.prevSteer = state.currentSteer
                        state.currentSteer = Math.max(0, state.currentSteer - steerDecrement)
                        console.log(`[HC2] gas worse, decrementing steer: ${(state.prevSteer * 180 / Math.PI).toFixed(1)}° → ${(state.currentSteer * 180 / Math.PI).toFixed(1)}°`)
                    } else if (state.currentSteer < 0) {
                        state.prevSteer = state.currentSteer
                        state.currentSteer = Math.min(0, state.currentSteer + steerDecrement)
                        console.log(`[HC2] gas worse, decrementing steer: ${(state.prevSteer * 180 / Math.PI).toFixed(1)}° → ${(state.currentSteer * 180 / Math.PI).toFixed(1)}°`)
                    }

                    // apply remaining steer (may be 0 now)
                    state.currentHeading = (state.currentHeading || 0) + state.currentSteer

                    // if steer has hit 0 and gas is still not improving → random turn
                    if (state.currentSteer === 0) {
                        const direction = Math.random() < 0.5 ? -1 : 1
                        state.currentHeading = state.currentHeading + direction * turnAngle
                        state.randomTurnCount = state.randomTurnCount + 1
                        // reset steer state for next cycle
                        state.prevSteer = 0
                        console.log(`[HC2] steer exhausted → random turn ${direction > 0 ? '+' : '-'}${(turnAngle * 180 / Math.PI).toFixed(0)}° heading=${(state.currentHeading * 180 / Math.PI).toFixed(1)}° turns=${state.randomTurnCount}/${maxRandomTurns}`)
                    } else {
                        console.log(`[HC2] gas worse, applied reduced steer → heading=${(state.currentHeading * 180 / Math.PI).toFixed(1)}°`)
                    }
                }

                // shift gas history
                state.prevPrevGas = state.prevGas
                state.prevGas = state.bestGasThisLeg
                state.bestGasThisLeg = 0

                // after N random turns, return to where we lost the scent
                if (state.randomTurnCount >= returnsAfterRandomTurns
                    && !state.returningToScent
                    && state.lostScentPos != null) {
                    console.log(`[HC2] *** RETURNING TO SCENT *** at (${state.lostScentPos.x.toFixed(1)}, ${state.lostScentPos.y.toFixed(1)}) after ${state.randomTurnCount} random turns`)
                    state.returningToScent = true
                    outputs.targetWaypoint = { x: state.lostScentPos.x, y: state.lostScentPos.y }
                    state.waypointSetTime = time
                    // skip placing a normal next waypoint
                }

                // productivity check: exit if not worth staying in gasFollow (skip during return)
                if (state.gasFollowStartTime != null && !state.returningToScent) {
                    const gasFollowingTimeSpent = time - state.gasFollowStartTime
                    const gasFollowingProductivity = (state.peakGasInFollow - minGasToEnter) / (gasFollowingTimeSpent + 10)
                    if (gasFollowingProductivity < minProductivity && gasFollowingTimeSpent > 5) {
                        console.log(`[HC2] *** EXITING gasFollow (low productivity) *** productivity=${gasFollowingProductivity.toFixed(6)} peakGas=${state.peakGasInFollow.toFixed(4)} timeSpent=${gasFollowingTimeSpent.toFixed(1)}s`)
                        state.randomTurnCount = maxRandomTurns + 1 // trigger the exit below
                    }
                }

                // too many random turns → back to route
                if (state.randomTurnCount > maxRandomTurns) {
                    console.log(`[HC2] *** EXITING gasFollow *** too many random turns (${state.randomTurnCount})`)
                    state.mode = "routeFollow"
                    state.currentHeading = null
                    state.prevPrevGas = 0
                    state.prevGas = state.maxGasReading || 0  // prevent immediate re-entry (maxGasReading is monotonic)
                    state.bestGasThisLeg = 0
                    state.randomTurnCount = 0
                    state.currentSteer = 0
                    state.prevSteer = 0
                    state.waypointSetTime = null
                    state.lostScentPos = null
                    state.returningToScent = false
                    state.gasFollowStartTime = null
                    state.peakGasInFollow = 0
                    // force SRA to re-emit its current waypoint (local planner lost it during gasFollow)
                    state.routeFollowState = { ...state.routeFollowState, currentPublishedWaypoint: null }
                    outputs.visualizePoints = [{ id: 'hillTarget', remove: true }, { id: 'lostScent', remove: true }]
                }

                // place next waypoint if still in gasFollow (and not returning to scent)
                if (state.mode === "gasFollow" && state.currentHeading != null && !state.returningToScent) {
                    const wp = {
                        x: position.x + Math.cos(state.currentHeading) * stepDistance,
                        y: position.y + Math.sin(state.currentHeading) * stepDistance,
                    }
                    outputs.targetWaypoint = wp
                    outputs.visualizePoints = [{ id: 'hillTarget', x: wp.x, y: wp.y, color: '#ffaa00', r: 6, label: 'H2' }]
                    state.waypointSetTime = time
                    console.log(`[HC2] next waypoint: (${wp.x.toFixed(1)}, ${wp.y.toFixed(1)})`)
                }
            }
        }

        // ── Always show lostScent marker if we have one ──────────
        if (state.lostScentPos != null) {
            const scentColor = state.returningToScent ? '#ff4444' : '#44ff44'
            const scentLabel = state.returningToScent ? 'RETURN' : 'GRAD'
            outputs.visualizePoints = [
                ...(outputs.visualizePoints || []),
                { id: 'lostScent', x: state.lostScentPos.x, y: state.lostScentPos.y, color: scentColor, r: 6, label: scentLabel },
            ]
        }

        const headingDeg = state.currentHeading != null ? (state.currentHeading * 180 / Math.PI).toFixed(0) + "°" : "none"
        const steerDeg = (state.currentSteer * 180 / Math.PI).toFixed(1)
        const gasFollowingTimeSpent = state.gasFollowStartTime != null ? time - state.gasFollowStartTime : 0
        const gasFollowingProductivity = state.gasFollowStartTime != null
            ? (state.peakGasInFollow - minGasToEnter) / (gasFollowingTimeSpent + 10)
            : 0
        outputs.logJson = {
            mode: state.mode,
            randomTurns: `${state.randomTurnCount}/${maxRandomTurns}`,
            maxGas: (state.maxGasReading || 0).toFixed(4),
            prevPrevGas: state.prevPrevGas.toFixed(4),
            prevGas: state.prevGas.toFixed(4),
            bestThisLeg: state.bestGasThisLeg.toFixed(4),
            heading: headingDeg,
            steer: `${steerDeg}°`,
            followTime: gasFollowingTimeSpent.toFixed(1),
            productivity: gasFollowingProductivity.toFixed(6),
            peakGas: state.peakGasInFollow.toFixed(4),
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

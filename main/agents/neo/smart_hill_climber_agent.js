import simpleRouteAgent from './simple_route_agent.js'
import { vecDistance, angleDifference } from '../../tooling/math_helpers.js'

const info = {
    inputs: ["position", "routeUpdate", "waypointReached", "gasReading"],
    outputs: ["movement", "targetWaypoint", "logJson", "visualizePoints", "visualizeLines"],
}

function create({
    gasThreshold = 0.120,
    gasFollowDuration = 200,
    sampleInterval = 2,
    turnAngle = Math.PI / 6,   // 30 degrees
    moveSpeed = 3,             // map units per tick
    angularGain = 0.5,        // fraction of angular error corrected per tick
    maxAngularVelocity = 0.5, // max radians per tick
    maxRandomTurns = 6,        // random turns before returning to scent point
    returnThreshold = 5,       // close enough to scent point to resume exploring
    headingMatchThreshold = 0.1, // radians — close enough to desired heading after return
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
            mode:             "idle",       // "idle" | "routeFollow" | "gasFollow" | "returning" | "returnAlign"
            gasFollowCounter: 0,
            currentHeading:   null,
            prevSample:       0,
            currentSample:    0,
            lastSampleTime:   null,
            randomTurnCount:  0,
            scentPos:         null,
            scentHeading:     null,
            routeFollowState: structuredClone(routeAgent.initialArg.state),
        },
        outputs: {
            movement:        null,
            targetWaypoint:  null,
            logJson:         null,
            visualizePoints: null,
            visualizeLines:  null,
        },
    }

    /**
     * Compute movement to steer toward a desired heading.
     * Returns { linearVelocity, angularVelocity }.
     */
    function steerToHeading(robotHeading, desiredHeading) {
        const angErr = angleDifference(robotHeading, desiredHeading)
        const angVel = Math.max(-maxAngularVelocity, Math.min(angErr * angularGain, maxAngularVelocity))
        return { linearVelocity: moveSpeed, angularVelocity: angVel }
    }

    /**
     * Compute movement to drive toward a target point.
     * Returns { linearVelocity, angularVelocity }.
     */
    function steerToPoint(position, target) {
        const dx = target.x - position.x
        const dy = target.y - position.y
        const desiredHeading = Math.atan2(dy, dx)
        return steerToHeading(position.heading, desiredHeading)
    }

    function update(getTime, { state, updated }) {
        const { position, routeUpdate, waypointReached } = state
        let outputs = { movement: null, targetWaypoint: null, logJson: null, visualizePoints: null, visualizeLines: null }
        state = { ...state }
        const time = getTime()

        // ── Sample gas every sampleInterval time units ─────────────
        let newSampleReady = false
        if (updated.gasReading && state.gasReading != null) {
            const shouldSample = state.lastSampleTime === null || (time - state.lastSampleTime) >= sampleInterval
            if (shouldSample) {
                const clampedReading = Math.max(state.gasReading, state.prevSample)
                console.log(`[SMART-HC] SAMPLE: raw=${state.gasReading.toFixed(4)} clamped=${clampedReading.toFixed(4)} prev=${state.prevSample.toFixed(4)} curr(old)=${state.currentSample.toFixed(4)}`)
                state.currentSample = clampedReading
                state.lastSampleTime = time
                newSampleReady = true
            }
        }
        const gotIncrease = state.currentSample > state.prevSample
        const noChange = state.currentSample === state.prevSample
        if (newSampleReady) {
            console.log(`[SMART-HC] DECISION: prev=${state.prevSample.toFixed(4)} curr=${state.currentSample.toFixed(4)} gotIncrease=${gotIncrease} noChange=${noChange} mode=${state.mode}`)
        }

        // ── New route → enter routeFollow ──────────────────────────
        if (updated.routeUpdate && routeUpdate != null) {
            state.mode = "routeFollow"
        }

        // ── Route follow: delegate to sub-agent (still uses targetWaypoint) ──
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
            if (ro.logJson != null) outputs.logJson = { ...outputs.logJson, ...ro.logJson }
        }

        // ── Switch: routeFollow → gasFollow when threshold hit ─────
        if (state.mode === "routeFollow"
            && state.gasReading != null
            && state.gasReading > gasThreshold
            && position != null) {
            console.log(`[SMART-HC] MODE SWITCH: routeFollow → gasFollow (rawGas=${state.gasReading.toFixed(4)} > threshold=${gasThreshold})`)
            state.mode = "gasFollow"
            state.gasFollowCounter = gasFollowDuration
            state.randomTurnCount = 0
            state.scentPos = { x: position.x, y: position.y }
            state.currentHeading = (position.heading != null) ? position.heading : 0
            state.scentHeading = state.currentHeading
        }

        // ── Returning to scent point ───────────────────────────────
        if (state.mode === "returning" && position != null && state.scentPos != null) {
            if (newSampleReady) state.gasFollowCounter = state.gasFollowCounter - 1

            const dist = vecDistance(position, state.scentPos)
            if (dist < returnThreshold) {
                // Arrived — now align heading to scent heading before resuming
                console.log(`[SMART-HC] MODE SWITCH: returning → returnAlign (arrived, dist=${dist.toFixed(1)})`)
                state.mode = "returnAlign"
            } else {
                // Steer toward scent point
                outputs.movement = steerToPoint(position, state.scentPos)
                outputs.visualizePoints = [
                    { id: 'hillTarget', x: state.scentPos.x, y: state.scentPos.y, color: '#ff00ff', r: 8, label: 'R' },
                ]
            }

            if (state.gasFollowCounter <= 0) {
                state.mode = "routeFollow"
                state.currentHeading = null
                state.prevSample = 0
                state.currentSample = 0
                state.scentPos = null
                state.scentHeading = null
                state.randomTurnCount = 0
                outputs.visualizePoints = [{ id: 'hillTarget', remove: true }, { id: 'scentMark', remove: true }]
            }
        }

        // ── Return align: rotate to match scent heading, then resume gasFollow ──
        if (state.mode === "returnAlign" && position != null) {
            const targetHeading = state.scentHeading + (Math.random() < 0.5 ? -1 : 1) * turnAngle
            const angErr = angleDifference(position.heading, targetHeading)
            if (Math.abs(angErr) < headingMatchThreshold) {
                console.log(`[SMART-HC] MODE SWITCH: returnAlign → gasFollow (heading aligned)`)
                state.mode = "gasFollow"
                state.randomTurnCount = 0
                state.currentHeading = targetHeading
            } else {
                // Rotate in place (no linear velocity)
                const angVel = Math.max(-maxAngularVelocity, Math.min(angErr * angularGain, maxAngularVelocity))
                outputs.movement = { linearVelocity: 0, angularVelocity: angVel }
            }
        }

        // ── Gas follow ─────────────────────────────────────────────
        if (state.mode === "gasFollow" && position != null) {
            if (newSampleReady) state.gasFollowCounter = state.gasFollowCounter - 1

            // Decisions on sample ticks
            if (newSampleReady) {
                if (gotIncrease) {
                    console.log(`[SMART-HC] GAS INCREASE: saving scent at (${position.x.toFixed(1)},${position.y.toFixed(1)}) heading=${state.currentHeading?.toFixed(2)} prev=${state.prevSample.toFixed(4)} curr=${state.currentSample.toFixed(4)}`)
                    state.scentPos = { x: position.x, y: position.y }
                    state.scentHeading = state.currentHeading
                    state.randomTurnCount = 0
                } else if (noChange && state.currentHeading != null) {
                    state.randomTurnCount = state.randomTurnCount + 1
                    console.log(`[SMART-HC] NO CHANGE: randomTurn #${state.randomTurnCount}/${maxRandomTurns} prev=${state.prevSample.toFixed(4)} curr=${state.currentSample.toFixed(4)}`)

                    if (state.randomTurnCount > maxRandomTurns && state.scentPos != null) {
                        console.log(`[SMART-HC] MODE SWITCH: gasFollow → returning (${state.randomTurnCount} random turns exceeded max ${maxRandomTurns})`)
                        state.mode = "returning"
                    } else {
                        const direction = Math.random() < 0.5 ? -1 : 1
                        state.currentHeading = state.currentHeading + direction * turnAngle
                        console.log(`[SMART-HC] RANDOM TURN: ${direction > 0 ? 'right' : 'left'} → heading=${(state.currentHeading * 180 / Math.PI).toFixed(1)}°`)
                    }
                }
            }

            // Drive toward currentHeading every tick (direct control, no waypoints)
            if (state.mode === "gasFollow" && state.currentHeading != null) {
                outputs.movement = steerToHeading(position.heading, state.currentHeading)
                console.log(`[SMART-HC] MOVE: robotHeading=${(position.heading*180/Math.PI).toFixed(1)}° desiredHeading=${(state.currentHeading*180/Math.PI).toFixed(1)}° angVel=${outputs.movement.angularVelocity.toFixed(3)}`)
                const vizPts = [{ id: 'hillTarget', remove: true }]
                if (state.scentPos != null) {
                    vizPts.push({ id: 'scentMark', x: state.scentPos.x, y: state.scentPos.y, color: '#00ff88', r: 5, label: 'S' })
                }
                outputs.visualizePoints = vizPts
            }

            // countdown expired → back to route
            if (state.gasFollowCounter <= 0) {
                state.mode = "routeFollow"
                state.currentHeading = null
                state.prevSample = 0
                state.currentSample = 0
                state.scentPos = null
                state.scentHeading = null
                state.randomTurnCount = 0
                outputs.visualizePoints = [{ id: 'hillTarget', remove: true }, { id: 'scentMark', remove: true }]
            }
        }

        // ── Advance prevSample after all decisions ──────────────────
        if (newSampleReady) {
            state.prevSample = state.currentSample
        }

        // ── Debug log ──────────────────────────────────────────────
        const headingDeg = state.currentHeading != null ? (state.currentHeading * 180 / Math.PI).toFixed(0) + "°" : "none"
        const distToScent = (state.scentPos != null && position != null)
            ? vecDistance(position, state.scentPos).toFixed(1)
            : "n/a"
        outputs.logJson = {
            mode: state.mode,
            countdown: state.gasFollowCounter,
            rawGas: (state.gasReading || 0).toFixed(3),
            prevSample: state.prevSample.toFixed(3),
            currentSample: state.currentSample.toFixed(3),
            heading: headingDeg,
            randomTurns: `${state.randomTurnCount}/${maxRandomTurns}`,
            distToScent,
            ...outputs.logJson,
        }

        return { state, outputs }
    }

    return { initialArg, info, update }
}

export default { info, create }

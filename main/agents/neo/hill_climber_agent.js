import simpleRouteAgent from './simple_route_agent.js'

const info = {
    inputs: ["position", "routeUpdate", "waypointReached", "gasReading"],
    outputs: ["targetWaypoint", "logJson", "visualizePoints", "visualizeLines"],
}

function create({
    gasThreshold = 0.120,
    gasFollowDuration = 200,
    sampleInterval = 2,        // time units between gas samples
    turnAngle = Math.PI / 6,   // 30 degrees in radians
    stepDistance = 30,
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
            gasFollowCounter: 0,
            currentHeading:   null,
            prevSample:       0,
            currentSample:    0,
            lastSampleTime:   null,
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

        // ── Sample gas every sampleInterval time units ─────────────
        if (updated.gasReading && state.gasReading != null) {
            const shouldSample = state.lastSampleTime === null || (time - state.lastSampleTime) >= sampleInterval
            if (shouldSample) {
                state.prevSample = state.currentSample
                // only see increases
                state.currentSample = Math.max(state.currentSample, state.gasReading)
                state.lastSampleTime = time
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

        // ── Switch: routeFollow → gasFollow when threshold hit ─────
        if (state.mode === "routeFollow"
            && state.gasReading != null
            && state.gasReading > gasThreshold) {
            state.mode = "gasFollow"
            state.gasFollowCounter = gasFollowDuration
            // start heading in current robot direction
            if (position != null && position.heading != null) {
                state.currentHeading = position.heading
            } else {
                state.currentHeading = 0
            }
        }

        // ── Gas follow ─────────────────────────────────────────────
        if (state.mode === "gasFollow" && position != null) {
            state.gasFollowCounter = state.gasFollowCounter - 1

            // if no change between samples, turn 30 degrees randomly
            if (state.currentSample === state.prevSample && state.currentHeading != null) {
                const direction = Math.random() < 0.5 ? -1 : 1
                state.currentHeading = state.currentHeading + direction * turnAngle
            }

            // place waypoint ahead
            if (state.currentHeading != null) {
                const wp = {
                    x: position.x + Math.cos(state.currentHeading) * stepDistance,
                    y: position.y + Math.sin(state.currentHeading) * stepDistance,
                }
                outputs.targetWaypoint = wp
                outputs.visualizePoints = [{ id: 'hillTarget', x: wp.x, y: wp.y, color: '#ffaa00', r: 6, label: 'H' }]
            }

            // countdown expired → back to route
            if (state.gasFollowCounter <= 0) {
                state.mode = "routeFollow"
                state.currentHeading = null
                state.prevSample = 0
                state.currentSample = 0
                outputs.visualizePoints = [{ id: 'hillTarget', remove: true }]
            }
        }

        const timeSinceLastSample = state.lastSampleTime != null ? (time - state.lastSampleTime).toFixed(1) : "never"
        const sampleDelta = (state.currentSample - state.prevSample)
        const headingDeg = state.currentHeading != null ? (state.currentHeading * 180 / Math.PI).toFixed(0) + "°" : "none"
        outputs.logJson = {
            mode: state.mode,
            countdown: state.gasFollowCounter,
            rawGas: (state.gasReading || 0).toFixed(3),
            prevSample: state.prevSample.toFixed(3),
            currentSample: state.currentSample.toFixed(3),
            sampleDelta: sampleDelta.toFixed(4),
            heading: headingDeg,
            timeSinceLastSample,
            aboveThreshold: state.currentSample > gasThreshold ? "YES" : "no",
            ...outputs.logJson,
        }

        return { state, outputs }
    }

    return { initialArg, info, update }
}

export default { info, create }

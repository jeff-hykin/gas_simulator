import simpleRouteAgent from './simple_route_agent.js'

const info = {
    inputs: ["position", "routeUpdate", "waypointReached", "gasReading", "maxGasReading"],
    outputs: ["targetWaypoint", "logJson", "visualizePoints", "visualizeLines", "toast"],
}

// Map a normalized value [0,1] to desaturated red → saturated red
function gasToColor(t) {
    t = Math.max(0, Math.min(1, t))
    const r = Math.round(255 - 55 * t)
    const g = Math.round(160 * t)
    const b = Math.round(160 * t)
    return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')
}

function create({
    gasThreshold = 0.120,
    gasFollowDuration = 200,  // ticks to stay in gasFollow once engaged
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
            maxGasReading:   false,
        },
        state: {
            position:          null,
            routeUpdate:       null,
            waypointReached:   null,
            gasReading:        null,
            maxGasReading:     null,
            mode:              "idle",
            gasFollowCounter:  0,
            currentHeading:    null,
            gasDotCount:       0,
            prevMaxGasForDot:  null,
            routeFollowState:  structuredClone(routeAgent.initialArg.state),
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

        // ── Drop topology dot ────────────────────────────────────
        if (updated.maxGasReading && state.maxGasReading != null && position != null) {
            const unchanged = state.prevMaxGasForDot != null && state.maxGasReading === state.prevMaxGasForDot
            const t = (state.maxGasReading > 0 && gasThreshold > 0)
                ? Math.max(0, Math.min(1, Math.log10(state.maxGasReading) / Math.log10(gasThreshold)))
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

        // New route → enter routeFollow
        if (updated.routeUpdate && routeUpdate != null) {
            state.mode = "routeFollow"
        }

        // Route follow: delegate to sub-agent
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

        // Switch: routeFollow → gasFollow when threshold hit
        if (state.mode === "routeFollow"
            && state.gasReading != null
            && state.gasReading > gasThreshold) {
            state.mode = "gasFollow"
            state.gasFollowCounter = gasFollowDuration
            // lock in current heading — we'll just keep going straight
            state.currentHeading = (position != null && position.heading != null) ? position.heading : 0
            outputs.toast = { message: `Gas detected — following gradient (${state.gasReading.toFixed(2)} PPM)`, type: "success" }
        }

        // Gas follow: go straight in the locked heading until countdown expires.
        // No sensing, no turning — this is the dumb gradient follower.
        if (state.mode === "gasFollow" && position != null) {
            state.gasFollowCounter = state.gasFollowCounter - 1

            if (state.currentHeading != null) {
                const wp = {
                    x: position.x + Math.cos(state.currentHeading) * stepDistance,
                    y: position.y + Math.sin(state.currentHeading) * stepDistance,
                }
                outputs.targetWaypoint = wp
                outputs.visualizePoints = [
                    ...(outputs.visualizePoints || []),
                    { id: 'gradTarget', x: wp.x, y: wp.y, color: '#ffaa00', r: 6, label: 'G' },
                ]
            }

            if (state.gasFollowCounter <= 0) {
                state.mode = "routeFollow"
                state.currentHeading = null
                outputs.toast = { message: "Resuming route", type: "info" }
                outputs.visualizePoints = [
                    ...(outputs.visualizePoints || []),
                    { id: 'gradTarget', remove: true },
                ]
            }
        }

        outputs.logJson = {
            mode: state.mode,
            countdown: state.gasFollowCounter,
            gas: (state.gasReading || 0).toFixed(3),
            heading: state.currentHeading != null ? (state.currentHeading * 180 / Math.PI).toFixed(0) + '°' : 'none',
            ...outputs.logJson,
        }

        return { state, outputs }
    }

    return { initialArg, info, update }
}

export default { info, create }

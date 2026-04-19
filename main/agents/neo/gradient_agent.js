import simpleRouteAgent from './simple_route_agent.js'

const info = {
    inputs: ["position", "routeUpdate", "waypointReached", "maxGasReading"],
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
    gasFollowDuration = 400,  // ticks to stay in gasFollow once engaged
    stepDistance = 30,
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
            position:          null,
            routeUpdate:       null,
            waypointReached:   null,
            maxGasReading:     null,
            mode:              "idle",
            gasFollowCounter:  0,
            gasFollowWaypoint: null,
            lastTriggeredMaxGas: 0,
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

        // Switch: routeFollow → gasFollow when max gas reading crosses threshold
        // Only trigger on the actual maxGasReading update event (not stale state),
        // and only if the reading has increased meaningfully (>20%) since we last triggered.
        const reTriggerMargin = (state.lastTriggeredMaxGas || 0) * 0.2
        if (state.mode === "routeFollow"
            && updated.maxGasReading
            && state.maxGasReading != null
            && state.maxGasReading > gasThreshold
            && state.maxGasReading > (state.lastTriggeredMaxGas || 0) + reTriggerMargin) {
            state.mode = "gasFollow"
            state.gasFollowCounter = gasFollowDuration
            state.gasFollowWaypoint = null // will be set on first position update
            state.lastTriggeredMaxGas = state.maxGasReading
            // lock in current heading — we'll just keep going straight
            state.currentHeading = (position != null && position.heading != null) ? position.heading : 0
            console.log(`[GRADIENT] → gasFollow maxGas=${state.maxGasReading.toFixed(4)} lastTrigger=${state.lastTriggeredMaxGas.toFixed(4)} threshold=${gasThreshold}`)
            outputs.toast = { message: `Gas detected — following gradient (${state.maxGasReading.toFixed(2)} PPM)`, type: "success" }
        }

        // Gas follow: go straight in the locked heading until countdown expires.
        // Only set waypoint once (or when previous one is reached), not every tick.
        if (state.mode === "gasFollow" && position != null) {
            state.gasFollowCounter = state.gasFollowCounter - 1

            if (state.currentHeading != null) {
                // Only publish a new waypoint if we don't have one yet or the previous was reached
                const needsNewWaypoint = state.gasFollowWaypoint == null || updated.waypointReached
                if (needsNewWaypoint) {
                    const wp = {
                        x: position.x + Math.cos(state.currentHeading) * stepDistance,
                        y: position.y + Math.sin(state.currentHeading) * stepDistance,
                    }
                    state.gasFollowWaypoint = wp
                    outputs.targetWaypoint = wp
                    outputs.visualizePoints = [
                        ...(outputs.visualizePoints || []),
                        { id: 'gradTarget', x: wp.x, y: wp.y, color: '#ffaa00', r: 6, label: 'G' },
                    ]
                }
            }

            if (state.gasFollowCounter <= 0) {
                state.mode = "routeFollow"
                state.currentHeading = null
                state.gasFollowWaypoint = null
                // Snapshot current max so we don't re-trigger from the same gas field
                state.lastTriggeredMaxGas = state.maxGasReading || state.lastTriggeredMaxGas
                console.log(`[GRADIENT] → routeFollow (countdown done) lastTrigger now=${(state.lastTriggeredMaxGas||0).toFixed(4)}`)
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
            gas: (state.maxGasReading || 0).toFixed(3),
            heading: state.currentHeading != null ? (state.currentHeading * 180 / Math.PI).toFixed(0) + '°' : 'none',
            ...outputs.logJson,
        }

        return { state, outputs }
    }

    return { initialArg, info, update }
}

export default { info, create }

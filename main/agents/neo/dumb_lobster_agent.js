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
    gasFollowDuration = 400,
    sampleInterval = 1,        // time units between gas samples
    turnAngle = Math.PI / 4,   // 45 degrees in radians
    stepDistance = 15,
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
            prevSample:        0,
            currentSample:     0,
            lastSampleTime:    null,
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
        const time = getTime()

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

        // ── Sample gas every sampleInterval time units (using max reading) ──
        if (updated.maxGasReading && state.maxGasReading != null) {
            const shouldSample = state.lastSampleTime === null || (time - state.lastSampleTime) >= sampleInterval
            if (shouldSample) {
                state.prevSample = state.currentSample
                state.currentSample = state.maxGasReading
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

        // ── Switch: routeFollow → gasFollow when max gas increases past threshold ──
        const reTriggerMargin = (state.lastTriggeredMaxGas || 0) * 0.2
        if (state.mode === "routeFollow"
            && updated.maxGasReading
            && state.maxGasReading != null
            && state.maxGasReading > gasThreshold
            && state.maxGasReading > (state.lastTriggeredMaxGas || 0) + reTriggerMargin) {
            state.mode = "gasFollow"
            state.gasFollowCounter = gasFollowDuration
            state.gasFollowWaypoint = null
            state.lastTriggeredMaxGas = state.maxGasReading
            // start heading in current robot direction
            state.currentHeading = (position != null && position.heading != null) ? position.heading : 0
            console.log(`[DUMB_LOBSTER] → gasFollow maxGas=${state.maxGasReading.toFixed(4)} lastTrigger=${state.lastTriggeredMaxGas.toFixed(4)}`)
            outputs.toast = { message: `Gas detected — following gradient (${state.maxGasReading.toFixed(2)} PPM)`, type: "success" }
        }

        // ── Gas follow ─────────────────────────────────────────────
        if (state.mode === "gasFollow" && position != null) {
            state.gasFollowCounter = state.gasFollowCounter - 1

            // Place waypoint on entry or when previous one was reached
            const needsNewWaypoint = state.gasFollowWaypoint == null || updated.waypointReached
            if (needsNewWaypoint && state.currentHeading != null) {
                // On waypoint reached: if no gas change between samples, jiggle heading
                if (updated.waypointReached && state.currentSample === state.prevSample) {
                    const direction = Math.random() < 0.5 ? -1 : 1
                    state.currentHeading = state.currentHeading + direction * turnAngle
                    console.log(`[DUMB_LOBSTER] jiggle ${direction > 0 ? '+' : '-'}${(turnAngle * 180 / Math.PI).toFixed(0)}° heading=${(state.currentHeading * 180 / Math.PI).toFixed(1)}°`)
                }
                const wp = {
                    x: position.x + Math.cos(state.currentHeading) * stepDistance,
                    y: position.y + Math.sin(state.currentHeading) * stepDistance,
                }
                state.gasFollowWaypoint = wp
                outputs.targetWaypoint = wp
                outputs.visualizePoints = [
                    ...(outputs.visualizePoints || []),
                    { id: 'hillTarget', x: wp.x, y: wp.y, color: '#ffaa00', r: 6, label: 'H' },
                ]
            }

            // countdown expired → back to route
            if (state.gasFollowCounter <= 0) {
                state.mode = "routeFollow"
                state.currentHeading = null
                state.gasFollowWaypoint = null
                state.prevSample = 0
                state.currentSample = 0
                state.lastTriggeredMaxGas = state.maxGasReading || state.lastTriggeredMaxGas
                console.log(`[DUMB_LOBSTER] → routeFollow (countdown done) lastTrigger now=${(state.lastTriggeredMaxGas||0).toFixed(4)}`)
                outputs.toast = { message: "Resuming route", type: "info" }
                outputs.visualizePoints = [
                    ...(outputs.visualizePoints || []),
                    { id: 'hillTarget', remove: true },
                ]
            }
        }

        const timeSinceLastSample = state.lastSampleTime != null ? (time - state.lastSampleTime).toFixed(1) : "never"
        const sampleDelta = (state.currentSample - state.prevSample)
        const headingDeg = state.currentHeading != null ? (state.currentHeading * 180 / Math.PI).toFixed(0) + "°" : "none"
        outputs.logJson = {
            mode: state.mode,
            countdown: state.gasFollowCounter,
            gas: (state.maxGasReading || 0).toFixed(3),
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

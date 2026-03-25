import { timer } from "../../tooling/time.js"
import simpleRouteAgent from './simple_route_agent.js'
import { gasGradient } from './gas_agent.js'

const info = {
    inputs: ["position", "routeUpdate", "waypointReached", "gasReading"],
    outputs: ["targetWaypoint", "logJson", "visualizePoints", "visualizeLines"],
}

function create({
    gasThreshold = 0.4,            // PPM — minimum reading to trigger gas follow
    bufferSize = 200,              // max gas buffer entries
    switchingCooldown = 10,        // ticks between mode switches
    routeAgentConfig = {},
    stepDistance = 30,             // how far ahead to place the gradient waypoint
    perturbAngle = 0.3,           // radians (~17°) — max random turn when exploring
    interestWindow = 15,          // number of recent readings to check for progress
    interestDropRatio = 0.7,      // if best-in-window / peak < this, lose interest
    gasRateIncreaseRatio = 0.002, // gradient slope threshold to enter gas follow
    flatGradientThreshold = 0.0005, // if slope stays below this while gas is high, we're at the source
    flatGradientWindow = 10,      // how many consecutive flat readings before stopping
    noImprovementTimeout = 30,    // seconds without a new peak gas reading before giving up
    minSamplesForGradient = 3,    // need at least this many buffer entries
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
            position:              null,
            routeUpdate:           null,
            waypointReached:       null,
            gasReading:            null,
            maxGasReading:         0,
            lastLoggedGasReading:  null,   // skip logging duplicate readings
            cooldown:              null,
            gasBuffer:             [],
            mode:                  "idle",
            currentHeading:        null,   // current gas-chase heading (radians)
            peakGasInChase:        0,      // highest reading since entering gasFollow
            flatCount:             0,      // consecutive ticks with flat gradient during gas follow
            noImprovementTimer:    null,   // resets when a new peak is found in gasFollow
            routeFollowState:      structuredClone(routeAgent.initialArg.state),
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

        // ── Accumulate gas buffer (skip if reading unchanged) ─────────
        if (updated.gasReading && state.gasReading != null && position != null) {
            state.maxGasReading = Math.max(state.maxGasReading, state.gasReading)
            if (state.gasReading !== state.lastLoggedGasReading) {
                state.lastLoggedGasReading = state.gasReading
                state.gasBuffer = [...state.gasBuffer, { time: getTime(), gasReading: state.gasReading, location: position }]
                if (state.gasBuffer.length > bufferSize) {
                    state.gasBuffer = state.gasBuffer.slice(-bufferSize)
                }
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
            if (ro.targetWaypoint != null) outputs.targetWaypoint = ro.targetWaypoint
            if (ro.logJson        != null) outputs.logJson = { ...outputs.logJson, ...ro.logJson }
        }

        // ── Compute gradient (always) ────────────────────────────────
        const gradient = position != null
            ? gasGradient(position, state.gasBuffer)
            : { angle: 0, slope: 0 }
        outputs.logJson = { ...outputs.logJson, gradientAngle: gradient.angle.toFixed(1), gradientSlope: gradient.slope.toFixed(4) }
        if (position != null) {
            const lineLen = 40
            outputs.visualizeLines = [{ id: 'gradientDir', x1: position.x, y1: position.y, x2: position.x + Math.cos(gradient.angle) * lineLen, y2: position.y + Math.sin(gradient.angle) * lineLen, color: '#00ffcc', lineWidth: 2 }]
        }

        // ── Gas follow: greedy gradient chase ────────────────────────
        if (state.mode === "gasFollow" && position != null) {
            // Update peak gas reading during chase; reset timer on new peak
            if (state.gasReading != null) {
                if (state.gasReading > state.peakGasInChase) {
                    state.peakGasInChase = state.gasReading
                    state.noImprovementTimer = timer({ duration: noImprovementTimeout, getTime, data: null })
                }
            }

            // No-improvement timer expired → back to route follow
            if (state.noImprovementTimer != null && state.noImprovementTimer.done) {
                state.mode              = "routeFollow"
                state.currentHeading    = null
                state.peakGasInChase    = 0
                state.flatCount         = 0
                state.noImprovementTimer = null
                state.cooldown          = timer({ duration: switchingCooldown, getTime, data: null })
                outputs.visualizePoints = [{ id: 'gasTarget', remove: true }]
                outputs.logJson = { ...outputs.logJson, gasAgent: `no gas improvement for ${noImprovementTimeout}s — returning to route follow` }
            }
        }

        if (state.mode === "gasFollow" && position != null) {
            // Track flat gradient — if gas is high but gradient is flat
            if (gradient.slope < flatGradientThreshold && state.maxGasReading > gasThreshold) {
                state.flatCount = state.flatCount + 1
            } else {
                state.flatCount = 0
            }

            if (state.flatCount >= flatGradientWindow) {
                // Gradient is flat — return to route following
                state.mode           = "routeFollow"
                state.currentHeading = null
                state.peakGasInChase = 0
                state.flatCount      = 0
                state.cooldown       = timer({ duration: switchingCooldown, getTime, data: null })
                outputs.visualizePoints = [{ id: 'gasTarget', remove: true }]
                outputs.logJson = { ...outputs.logJson, gasAgent: `flat gradient — returning to route follow (peak=${state.peakGasInChase.toFixed(2)})` }
            } else {
                // Decide heading: use gradient if strong, otherwise perturb current heading
                if (gradient.slope > gasRateIncreaseRatio && state.gasBuffer.length >= minSamplesForGradient) {
                    // Strong gradient — follow it directly
                    state.currentHeading = gradient.angle
                } else if (state.currentHeading != null) {
                    // Weak/noisy gradient — randomly perturb current heading slightly
                    const perturbation = (Math.random() - 0.5) * 2 * perturbAngle
                    state.currentHeading = state.currentHeading + perturbation
                }

                // Place waypoint ahead in current heading direction
                if (state.currentHeading != null) {
                    const wp = {
                        x: position.x + Math.cos(state.currentHeading) * stepDistance,
                        y: position.y + Math.sin(state.currentHeading) * stepDistance,
                    }
                    outputs.targetWaypoint = wp
                    outputs.visualizePoints = [{ id: 'gasTarget', x: wp.x, y: wp.y, color: '#ff4400', r: 6, label: 'G' }]
                }
            }
        }

        // ── Mode switching (after cooldown expires) ───────────────────
        if (state.cooldown != null && state.cooldown.done) {
            const interest = gradient.slope

            if (state.mode !== "gasFollow") {
                // Enter gas follow if reading is strong and gradient is rising
                if (state.gasBuffer.length >= minSamplesForGradient
                        && state.maxGasReading > gasThreshold
                        && interest > gasRateIncreaseRatio) {
                    state.mode              = "gasFollow"
                    state.currentHeading    = gradient.angle
                    state.peakGasInChase    = state.gasReading || 0
                    state.flatCount         = 0
                    state.noImprovementTimer = timer({ duration: noImprovementTimeout, getTime, data: null })
                    state.cooldown          = timer({ duration: switchingCooldown, getTime, data: null })
                    outputs.logJson = { ...outputs.logJson, gasAgent: `entering greedy gas follow (slope=${interest.toFixed(3)})` }
                }
            } else {
                // ── Interest loss check ──────────────────────────────
                // Look at recent readings: if the best recent reading has dropped
                // well below the peak we saw during this chase, give up.
                const recentEntries = state.gasBuffer.slice(-interestWindow)
                const bestRecent = recentEntries.reduce((max, e) => Math.max(max, e.gasReading), 0)
                const lostInterest = state.peakGasInChase > 0
                    && bestRecent / state.peakGasInChase < interestDropRatio

                if (lostInterest || interest < gasRateIncreaseRatio) {
                    // Lost the scent → return to route follow
                    state.mode           = "routeFollow"
                    state.currentHeading = null
                    state.peakGasInChase = 0
                    state.cooldown       = timer({ duration: switchingCooldown, getTime, data: null })
                    outputs.logJson = { ...outputs.logJson, gasAgent: `returning to route follow (${lostInterest ? 'lost interest' : 'weak gradient'}, bestRecent=${bestRecent.toFixed(2)}, peak=${state.peakGasInChase.toFixed(2)})` }
                    outputs.visualizePoints = [{ id: 'gasTarget', remove: true }]
                }
            }
        }

        outputs.logJson = { maxGasReading: state.maxGasReading.toFixed(2), mode: state.mode, cooldown: state.cooldown == null ? "none" : state.cooldown.done ? "done" : state.cooldown.count.toFixed(1), ...outputs.logJson }

        return { state, outputs }
    }

    return { initialArg, info, update }
}

export default { info, create }

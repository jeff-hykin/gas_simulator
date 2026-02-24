import { vecDistance } from '../../tooling/math_helpers.js'
import { timer } from "../../tooling/time.js";

import simpleRouteAgent from './simple_route_agent.js'

const info = {
    inputs: ["position", "routeUpdate", "waypointReached", "gasReading"],
    outputs: ["targetWaypoint", "logJson"],
}
function create({
    gasThreshold = 0.1, // PPM
    bufferSize = 20, // timesteps
    switchingCooldown = 30, // timesteps
    routeAgentConfig = {},
    gasMoveOnTime = 20, // timesteps
    gasThreshold = 0.1, // PPM
    gasRateIncreaseRatio = 0.05, // PPM/timestep
}) {
    const initialArg = {
        updated: {
            time: false,
            routeWaypoints: false,
        },
        state: {
            time: null,
            routeWaypoints: [],
            cooldown: null,
            gasFollowRecalculate: null,
            gasBuffer: [],
            gasValueHistory: [],
            gasWaypoints: [],
            mode: "idle",
            routeFollowState: {},
            gasFollowState: {},
        },
        outputs: {
            targetWaypoint: null,
            logJson: null,
        }
    }
    const routeAgent = simpleRouteAgent.create(routeAgentConfig)
    function update(getTime, { state, updated }) {
        const { time, routeWaypoints, position, waypointReached, gasReading } = state
        const outputs = {}
        if (updated.routeWaypoints) {
            state.mode = "routeFollow"
            state.routeFollowState = routeAgent.initialArg
            state.cooldown = timer({ duration: switchingCooldown, getTime, data: structuredClone(state) })
        }

        if (mode === "routeFollow") {
            const { outputs: routeOutputs, state: routeState } = routeAgent.update(getTime, { state: {...state.routeFollowState, time, routeWaypoints, position, waypointReached }, updated })
            state.routeFollowState = routeState
            outputs.targetWaypoint = routeOutputs.targetWaypoint
            outputs.logJson = routeOutputs.logJson
        }

        if (mode === "gasFollow") {
            const { outputs: gasFollowOutputs, state: gasFollowState } = gasFollowAgent.update(getTime, { state: {...state.gasFollowState, time, routeWaypoints: state.gasWaypoints, position, waypointReached }, updated })
            state.gasFollowState = gasFollowState
            outputs.targetWaypoint = gasFollowOutputs.targetWaypoint
            outputs.logJson = gasFollowOutputs.logJson
        }
        
        state.gasBuffer.push({ time, gasReading })
        if (state.gasBuffer.length > bufferSize) {
            state.gasBuffer.shift()
        }
        
        if (cooldown.done) {
            if (mode != "gasFollow") {
                // FIXME: gradientOf
                // starting gas follow
                const smallBufferGradient = gradientOf(state.gasBuffer)
                if (state.gasBuffer.length > 2 && state.gasReading > gasThreshold && smallBufferGradient > gasRateIncreaseRatio) {
                    state.gasFollowState = gasFollowAgent.initialArg
                    state.mode = "gasFollow"
                    state.gasFollowRecalculate = timer({ duration: gasMoveOnTime, getTime, data: structuredClone(state) })
                    state.cooldown = timer({ duration: switchingCooldown, getTime, data: structuredClone(state) })
                    // FIXME: generate waypoints based on gradient
                    state.gasWaypoints = []
                }
            } else {
                // FIXME: calculate interest and refocusPressure
                // go back to normal follow
                if (interest < refocusPressure) {
                    state.mode = "routeFollow"
                    state.routeFollowState = routeAgent.initialArg
                    state.cooldown = timer({ duration: switchingCooldown, getTime, data: structuredClone(state) })
                }
                // do another round of gas reading
                if (gasFollowRecalculate.done) {
                    state.gasFollowRecalculate = timer({ duration: gasMoveOnTime, getTime, data: structuredClone(state) })
                    // FIXME: generate waypoints based on gradient
                    state.gasWaypoints = []
                }
            }
        }

        return { state, outputs }
    }
    return { initialArg, update }
}

export default { info, create }
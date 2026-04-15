import simpleRouteAgent from './simple_route_agent.js'

const info = {
    inputs: ["position", "routeUpdate", "waypointReached"],
    outputs: ["targetWaypoint", "logJson"],
}

function create({ routeAgentConfig = {} } = {}) {
    const routeAgent = simpleRouteAgent.create(routeAgentConfig)

    const initialArg = {
        updated: {
            position:        false,
            routeUpdate:     false,
            waypointReached: false,
        },
        state: {
            position:        null,
            routeUpdate:     null,
            waypointReached: null,
            routeFollowState: structuredClone(routeAgent.initialArg.state),
        },
        outputs: {
            targetWaypoint: null,
            logJson:        null,
        },
    }

    function update(getTime, { state, updated }) {
        const { position, routeUpdate, waypointReached } = state
        let outputs = { targetWaypoint: null, logJson: null }
        state = { ...state }

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

        return { state, outputs }
    }

    return { initialArg, info, update }
}

export default { info, create }

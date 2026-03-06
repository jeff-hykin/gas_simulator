import { vecDistance } from '../../tooling/math_helpers.js'

const info = {
    inputs: ["position", "routeUpdate", "waypointReached"],
    outputs: ["targetWaypoint", "logJson"],
}
function create({
    minProgress = 20,   // units/sec below which the waypoint is skipped
    gracePeriod = 0.5,  // seconds before the progress check kicks in
    minTicksPerWaypoint = 20, // minimum ticks before advancing to next waypoint
} = {}) {
    const initialArg = {
        updated: {},
        state: {
            routeWaypoints: [],
            currentWaypointIndex: 0,
            currentPublishedWaypoint: null,
            position: { x: 0, y: 0 },
            currentWaypointStartTime: null,
            currentWaypointInitialDistance: null,
            ticksOnCurrentWaypoint: 0,
        },
        outputs: {
            targetWaypoint: null,
            logJson: null,
        }
    }
    function update(getTime, { state, updated }) {
        const time = getTime()
        const { position, waypointReached, routeUpdate } = state
        let s = { ...state, ticksOnCurrentWaypoint: (state.ticksOnCurrentWaypoint || 0) + 1 }
        let targetWaypoint = null
        let logJson = null
        console.log(`[SRA] update: idx=${state.currentWaypointIndex}/${state.routeWaypoints.length} ticks=${s.ticksOnCurrentWaypoint} pos=${position ? `(${position.x.toFixed(1)},${position.y.toFixed(1)})` : 'null'} updated=${JSON.stringify(updated)}`)

        // 1. Apply routeUpdate (resets everything)
        if (updated.routeUpdate) {
            console.log(`SimpleAgent: route updated with ${routeUpdate.waypoints.length} waypoints`)
            s = {
                ...s,
                routeWaypoints: routeUpdate.waypoints.map(w => ({ x: w.x, y: w.y })),
                currentWaypointIndex: 0,
                currentPublishedWaypoint: null,
            }
        }

        // 2. Apply waypointReached (only if cooldown has elapsed)
        if (updated.waypointReached && s.ticksOnCurrentWaypoint >= minTicksPerWaypoint) {
            console.log(`SimpleAgent: waypoint ${s.currentWaypointIndex + 1}/${s.routeWaypoints.length} reached`)
            s = { ...s, currentWaypointIndex: s.currentWaypointIndex + 1, currentPublishedWaypoint: null, ticksOnCurrentWaypoint: 0 }
        }

        // 3. On position update, compute and log progress metrics; skip if time exceeded
        if (updated.position) {
            s = { ...s, position: { x: position.x, y: position.y } }

            if (s.routeWaypoints.length > 0 && s.currentWaypointIndex < s.routeWaypoints.length && s.currentWaypointStartTime !== null) {
                const target = s.routeWaypoints[s.currentWaypointIndex]
                const remainingDistance = vecDistance(s.position, target)
                const timeSinceWaypoint = time - s.currentWaypointStartTime
                const progress = timeSinceWaypoint > 0 ? (s.currentWaypointInitialDistance - remainingDistance) / timeSinceWaypoint : 0
                logJson = { progress: progress.toFixed(2) }

                if (timeSinceWaypoint > gracePeriod && progress < minProgress && s.ticksOnCurrentWaypoint >= minTicksPerWaypoint) {
                    console.log(`SimpleAgent: skipping waypoint ${s.currentWaypointIndex + 1}/${s.routeWaypoints.length} (progress=${progress.toFixed(2)}, t=${timeSinceWaypoint.toFixed(1)}s)`)
                    s = {
                        ...s,
                        currentWaypointIndex: s.currentWaypointIndex + 1,
                        currentPublishedWaypoint: null,
                        currentWaypointStartTime: null,
                        currentWaypointInitialDistance: null,
                        ticksOnCurrentWaypoint: 0,
                    }
                }
            }
        }

        // 4. Emit target_waypoint if current waypoint changed
        if (s.routeWaypoints.length === 0 || s.currentWaypointIndex >= s.routeWaypoints.length) {
            if (s.routeWaypoints.length > 0) {
                console.log('SimpleAgent: route completed')
            }
        } else {
            const target = s.routeWaypoints[s.currentWaypointIndex]
            const alreadyPublished =
                s.currentPublishedWaypoint &&
                s.currentPublishedWaypoint.x === target.x &&
                s.currentPublishedWaypoint.y === target.y

            if (!alreadyPublished) {
                console.log(`SimpleAgent: publishing waypoint ${s.currentWaypointIndex + 1}/${s.routeWaypoints.length} at (${target.x.toFixed(1)}, ${target.y.toFixed(1)})`)
                targetWaypoint = { x: target.x, y: target.y }
                logJson = { waypoint: `${s.currentWaypointIndex + 1}/${s.routeWaypoints.length}` }
                s = {
                    ...s,
                    currentPublishedWaypoint: { x: target.x, y: target.y },
                    currentWaypointStartTime: time,
                    currentWaypointInitialDistance: s.position != null ? vecDistance(s.position, target) : 0,
                    ticksOnCurrentWaypoint: 0,
                }
            }
        }

        return { state: s, outputs: { targetWaypoint, logJson } }
    }
    return { initialArg, info, update }
}

export default { info, create }

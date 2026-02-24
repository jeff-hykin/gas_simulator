import { vecDistance } from '../../tooling/math_helpers.js'

export const info = {
    inputs: ["position", "routeUpdate", "waypointReached"],
    outputs: ["targetWaypoint", "logJson"],
}
export function createSimpleRouteAgent({}) {
    const initialArg = {
        updated: {},
        state: {
            routeWaypoints: [],
            currentWaypointIndex: 0,
            currentPublishedWaypoint: null,
            position: { x: 0, y: 0 },
            waypointStartTime: 0,
            lastDistanceCheck: null,
            lastDistanceCheckTime: 0,
            negativeVelocityStartTime: null,
        },
        outputs: {
            targetWaypoint: null,
            logJson: null,
        }
    }
    function update(getTime, { state, updated }) {
        const { time, position, waypointReached, routeUpdate } = state
        let s = { ...state }
        let targetWaypoint = null
        let logJson = null
        
        // 1. Apply routeUpdate (resets everything)
        if (routeUpdate) {
            console.log(`SimpleAgent: route updated with ${routeUpdate.waypoints.length} waypoints`)
            s = {
                ...s,
                routeWaypoints: routeUpdate.waypoints.map(w => ({ x: w.x, y: w.y })),
                currentWaypointIndex: 0,
                currentPublishedWaypoint: null,
            }
        }
        
        // 2. Apply waypointReached
        if (waypointReached) {
            console.log(`SimpleAgent: waypoint ${s.currentWaypointIndex + 1}/${s.routeWaypoints.length} reached`)
            s = { ...s, currentWaypointIndex: s.currentWaypointIndex + 1, currentPublishedWaypoint: null }
        }
        
        // 3. Apply position update and check progress toward current waypoint
        if (position) {
            s = { ...s, position: { x: position.x, y: position.y } }

            if (s.routeWaypoints.length > 0 && s.currentWaypointIndex < s.routeWaypoints.length) {
                const target = s.routeWaypoints[s.currentWaypointIndex]
                const currentDistance = vecDistance(s.position, target)

                if (s.lastDistanceCheck !== null) {
                    const deltaDistance = s.lastDistanceCheck - currentDistance // positive = moving closer
                    const deltaTime = time - s.lastDistanceCheckTime
                    const velocity = deltaDistance / deltaTime

                    if (velocity < 0) {
                        if (s.negativeVelocityStartTime === null) {
                            console.log(`SimpleAgent: negative velocity detected (${velocity.toFixed(2)} units/s)`)
                            s = { ...s, negativeVelocityStartTime: time }
                        } else {
                            const negativeVelocityDuration = time - s.negativeVelocityStartTime
                            if (negativeVelocityDuration > 1.0) {
                                s = {
                                    ...s,
                                    currentWaypointIndex: s.currentWaypointIndex + 1,
                                    currentPublishedWaypoint: null,
                                    negativeVelocityStartTime: null,
                                }
                            }
                        }
                    } else {
                        s = { ...s, negativeVelocityStartTime: null }
                    }
                }

                s = { ...s, lastDistanceCheck: currentDistance, lastDistanceCheckTime: time }
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
                    waypointStartTime: time,
                    lastDistanceCheck: null,
                    lastDistanceCheckTime: 0,
                    negativeVelocityStartTime: null,
                }
            }
        }
        
        return { state: s, outputs: { targetWaypoint, logJson } }
    }
    return { initialArg, update }
}
import { createGetTime } from "./time.js"
import { vecDistance } from "./math_helpers.js"
import { SimpleRouteAgent } from "./simple_route_agent.js"


/**
 * Simple route-following agent for debugging the local planner.
 * Just follows waypoints in sequence without any gas sensing or exploration.
 */
export class CustomAgent {
    /**
     * @param {Function} pubsubFactory - factory function that returns pubsub instance
     * @param {object} [config]
     * @param {{x:number,y:number}} [config.startPosition={x:0,y:0}]
     */
    constructor(pubsubFactory, config = {}) {
        this.pubsub = pubsubFactory("simple_agent")
        this.getTime = createGetTime(this.pubsub)
        
        // create a waypoint follower agent
        this.routeFollower = new SimpleRouteAgent(pubsubFactory, config)

        // Route state
        this.routeWaypoints = []
        this.currentWaypointIndex = 0

        // Track currently published waypoint to avoid redundant publications
        this.currentPublishedWaypoint = null

        // Position tracking
        this.position = { x: 0, y: 0 }

        // Velocity tracking for waypoint timeout
        this.waypointStartTime = 0
        this.lastDistanceCheck = null
        this.lastDistanceCheckTime = 0
        this.negativeVelocityStartTime = null

        // Subscribe to odometry
        this.pubsub.subscribe("odom", (data, publisher) => {
            this.position.x = data.x
            this.position.y = data.y
            this._checkWaypointProgress()
        })

        // Subscribe to route updates
        this.pubsub.subscribe("route_update", (data, publisher) => {
            console.log(`SimpleAgent: route updated with ${data.waypoints.length} waypoints`)
            this.routeWaypoints = data.waypoints.map((w) => ({ x: w.x, y: w.y }))
            this.currentWaypointIndex = 0
            this.currentPublishedWaypoint = null
            // Immediately publish first waypoint
            this._publishCurrentWaypoint()
        })

        // Subscribe to waypoint reached events
        this.pubsub.subscribe("waypoint_reached", (data, publisher) => {
            console.log(`SimpleAgent: waypoint ${this.currentWaypointIndex + 1}/${this.routeWaypoints.length} reached`)
            this.currentWaypointIndex++
            this.currentPublishedWaypoint = null
            // Publish next waypoint
            this._publishCurrentWaypoint()
        })

        this.pubsub.subscribe("waypoint_reached", (data, publisher) => {
            console.log(`SimpleAgent: waypoint ${this.currentWaypointIndex + 1}/${this.routeWaypoints.length} reached`)
            this.currentWaypointIndex++
            this.currentPublishedWaypoint = null
            // Publish next waypoint
            this._publishCurrentWaypoint()
        })

        //
        // main loop
        //
        let mode = "route-following"
        this.pubsub.subscribe("time", ({ virtualTime }, publisher) => {
            let time = virtualTime

        })
    }

    _publishCurrentWaypoint() {
        if (this.routeWaypoints.length === 0 || this.currentWaypointIndex >= this.routeWaypoints.length) {
            console.log("SimpleAgent: route completed")
            return
        }

        const target = this.routeWaypoints[this.currentWaypointIndex]

        // Only publish if waypoint changed
        if (!this.currentPublishedWaypoint || this.currentPublishedWaypoint.x !== target.x || this.currentPublishedWaypoint.y !== target.y) {
            this.currentPublishedWaypoint = { x: target.x, y: target.y }
            console.log(`SimpleAgent: publishing waypoint ${this.currentWaypointIndex + 1}/${this.routeWaypoints.length} at (${target.x.toFixed(1)}, ${target.y.toFixed(1)})`)
            this.pubsub.publish("target_waypoint", { x: target.x, y: target.y })
            this.pubsub.publish("logJson", {
                waypoint: `${this.currentWaypointIndex + 1}/${this.routeWaypoints.length}`,
            })

            // Reset tracking for new waypoint
            this.waypointStartTime = this.getTime()
            this.lastDistanceCheck = null
            this.lastDistanceCheckTime = 0
            this.negativeVelocityStartTime = null
        }
    }

    _checkWaypointProgress() {
        if (this.routeWaypoints.length === 0 || this.currentWaypointIndex >= this.routeWaypoints.length) {
            return
        }

        const target = this.routeWaypoints[this.currentWaypointIndex]
        const currentDistance = vecDistance(this.position, target)
        const currentTime = this.getTime()
        const timeAtWaypoint = currentTime - this.waypointStartTime

        // Calculate velocity if we have a previous measurement
        if (this.lastDistanceCheck !== null) {
            const deltaDistance = this.lastDistanceCheck - currentDistance // positive = moving closer
            const deltaTime = currentTime - this.lastDistanceCheckTime
            const velocity = deltaDistance / deltaTime

            // Track negative velocity (moving away from waypoint)
            if (velocity < 0) {
                if (this.negativeVelocityStartTime === null) {
                    this.negativeVelocityStartTime = currentTime
                    console.log(`SimpleAgent: negative velocity detected (${velocity.toFixed(2)} units/s)`)
                } else {
                    const negativeVelocityDuration = currentTime - this.negativeVelocityStartTime
                    if (negativeVelocityDuration > 1.0) {
                        // console.log(`SimpleAgent: moving backwards for ${negativeVelocityDuration.toFixed(2)}s, skipping waypoint`)
                        this.currentWaypointIndex++
                        this.currentPublishedWaypoint = null
                        this._publishCurrentWaypoint()
                        return
                    }
                }
            } else {
                // Reset negative velocity timer if moving towards target
                this.negativeVelocityStartTime = null
            }

            // Log progress every second
            // if (Math.floor(timeAtWaypoint) !== Math.floor(timeAtWaypoint - deltaTime)) {
            //     console.log(`SimpleAgent: waypoint ${this.currentWaypointIndex + 1} progress - distance: ${currentDistance.toFixed(1)}, velocity: ${velocity.toFixed(2)} units/s, time: ${timeAtWaypoint.toFixed(1)}s`)
            // }
        }

        // Update tracking
        this.lastDistanceCheck = currentDistance
        this.lastDistanceCheckTime = currentTime
    }
}

/**
 * Simple route-following agent for debugging the local planner.
 * Just follows waypoints in sequence without any gas sensing or exploration.
 */
export class SimpleRouteAgent {
    /**
     * @param {Function} pubsubFactory - factory function that returns pubsub instance
     * @param {object} [config]
     * @param {{x:number,y:number}} [config.startPosition={x:0,y:0}]
     */
    constructor(pubsubFactory, config = {}) {
        this.pubsub = pubsubFactory("simple_agent")

        // Route state
        this.routeWaypoints = []
        this.currentWaypointIndex = 0

        // Track currently published waypoint to avoid redundant publications
        this.currentPublishedWaypoint = null

        // Subscribe to route updates
        this.pubsub.subscribe("route_update", (data, publisher) => {
            console.log(`SimpleAgent: route updated with ${data.waypoints.length} waypoints`);
            this.routeWaypoints = data.waypoints.map(w => ({ x: w.x, y: w.y }))
            this.currentWaypointIndex = 0
            this.currentPublishedWaypoint = null
            // Immediately publish first waypoint
            this._publishCurrentWaypoint()
        })

        // Subscribe to waypoint reached events
        this.pubsub.subscribe("waypoint_reached", (data, publisher) => {
            console.log(`SimpleAgent: waypoint ${this.currentWaypointIndex + 1}/${this.routeWaypoints.length} reached`);
            this.currentWaypointIndex++
            this.currentPublishedWaypoint = null
            // Publish next waypoint
            this._publishCurrentWaypoint()
        })
    }

    _publishCurrentWaypoint() {
        if (this.routeWaypoints.length === 0 ||
            this.currentWaypointIndex >= this.routeWaypoints.length) {
            console.log('SimpleAgent: route completed')
            return
        }

        const target = this.routeWaypoints[this.currentWaypointIndex]

        // Only publish if waypoint changed
        if (!this.currentPublishedWaypoint ||
            this.currentPublishedWaypoint.x !== target.x ||
            this.currentPublishedWaypoint.y !== target.y) {
            this.currentPublishedWaypoint = { x: target.x, y: target.y }
            console.log(`SimpleAgent: publishing waypoint ${this.currentWaypointIndex + 1}/${this.routeWaypoints.length} at (${target.x.toFixed(1)}, ${target.y.toFixed(1)})`)
            this.pubsub.publish('target_waypoint', { x: target.x, y: target.y })
        }
    }
}

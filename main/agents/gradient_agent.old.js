import { createGetTime } from '../tooling/time.js'
import {
    vecAdd, vecScale, vecDistance, vecMagnitude,
    linearRegressionSlope, fitGradient2D,
    circleWaypoints, nearestPointOnPolyline
} from '../tooling/math_helpers.js'

/**
 * Gradient-following agent that combines route following with gas gradient exploration.
 */
export class GradientAgent {
    constructor(pubsubFactory, config = {}) {
        this.pubsub = pubsubFactory("gradient_agent")
        this.getTime = createGetTime(this.pubsub)

        // Parameters
        this.minimumGasThreshold = config.minimumGasThreshold ?? 0.1
        this.gasSensitivity = config.gasSensitivity ?? 0.05
        this.circlingSize = config.circlingSize ?? 40
        this.attentionThreshold = config.attentionThreshold ?? 0.1
        this.refocusRatio = config.refocusRatio ?? 60 // seconds
        this.attentionSpan = config.attentionSpan ?? 120 // seconds
        this.maxBufferSize = config.maxBufferSize ?? 500
        this.samplingRate = config.samplingRate ?? 60 // ticks (will be converted to seconds)
        this.decisionRate = config.decisionRate ?? 1 // seconds between gas readings
        this.circleWaypointCount = config.circleWaypointCount ?? 8
        this.circleRebuildDelay = config.circleRebuildDelay ?? 30 // seconds - minimum time between circle rebuilds

        // Route state
        this.routeWaypoints = []
        this.currentRouteIndex = 0

        // Exploration state
        this.mode = "route-following"
        this.gasMemory = []
        this.exploreStartTime = 0
        this.tempWaypoints = []
        this.currentTempIndex = 0
        this.recalcPending = false
        this.lastSampleTime = 0
        this.lastCircleBuildTime = 0 // Track when circle was last built for debouncing

        // Position tracking
        this.position = { x: 0, y: 0 }
        this.heading = 0

        // Current sensor reading (monotonic - only increases)
        this.sensorReading = 0

        // Track published waypoint to avoid redundancy
        this.currentPublishedWaypoint = null

        // Track active visualization IDs for cleanup
        this.activeVisualizationIds = new Set()

        // Velocity tracking for waypoint timeout (from SimpleRouteAgent)
        this.waypointStartTime = 0
        this.lastDistanceCheck = null
        this.lastDistanceCheckTime = 0
        this.negativeVelocityStartTime = null

        // Subscribe to odometry
        this.pubsub.subscribe("odom", (data) => {
            this.position.x = data.x
            this.position.y = data.y
            this.heading = data.heading
            this._checkWaypointProgress()
        })

        // Subscribe to gas readings
        this.pubsub.subscribe("gas_reading", (data) => {
            this._onGasReading(data.ppm)
        })

        // Subscribe to route updates
        this.pubsub.subscribe("route_update", (data) => {
            console.log(`GradientAgent: route updated with ${data.waypoints.length} waypoints`)
            this.routeWaypoints = data.waypoints.map(w => ({ x: w.x, y: w.y }))
            this.currentRouteIndex = 0
            this.currentPublishedWaypoint = null
            this._tick()
        })

        // Subscribe to waypoint reached
        this.pubsub.subscribe("waypoint_reached", (data) => {
            if (this.mode === "explore" && this.tempWaypoints.length > 0) {
                console.log(`GradientAgent: exploration waypoint ${this.currentTempIndex + 1}/${this.tempWaypoints.length} reached`)
                this.currentTempIndex++
                if (this.currentTempIndex >= this.tempWaypoints.length) {
                    // Circle complete, rebuild
                    this.tempWaypoints = []
                    this.currentTempIndex = 0
                }
            } else if (this.mode === "route-following" && this.routeWaypoints.length > 0) {
                console.log(`GradientAgent: route waypoint ${this.currentRouteIndex + 1}/${this.routeWaypoints.length} reached`)
                this.currentRouteIndex++
            }
            this._tick()
        })
    }

    _onGasReading(ppm) {
        // Sensor only increases (monotonic)
        if (ppm > this.sensorReading) {
            this.sensorReading = ppm
        }

        this._updateGasMemory()
        this._updateMode()
        this._tick()
    }

    _updateGasMemory() {
        const currentTime = this.getTime()

        // Add to memory if above threshold (push all readings, not just significant increases)
        if (this.sensorReading > this.minimumGasThreshold) {

            this.gasMemory.push({
                ppm: this.sensorReading,
                time: currentTime / 60, // Store in minutes for calculations
                position: { x: this.position.x, y: this.position.y }
            })

            // console.log(`GradientAgent: gas memory recorded - ${this.sensorReading.toFixed(3)} PPM at (${this.position.x.toFixed(1)}, ${this.position.y.toFixed(1)})`)

            // Trim buffer if too large
            if (this.gasMemory.length > this.maxBufferSize) {
                this.gasMemory.shift()
            }

            // Check if we should recalculate exploration circle
            const timeSinceLastSample = currentTime - this.lastSampleTime
            const samplingInterval = this.samplingRate * this.decisionRate
            if (timeSinceLastSample >= samplingInterval) {
                this.lastSampleTime = currentTime
                if (this.mode === "explore") {
                    this.recalcPending = true
                }
            }
        }
    }

    _computeInterest() {
        const currentTimeMinutes = this.getTime() / 60
        const attentionSpanMinutes = this.attentionSpan / 60
        const cutoff = currentTimeMinutes - attentionSpanMinutes
        const recent = this.gasMemory.filter(e => e.time >= cutoff)

        if (recent.length < 2) return 0

        const slope = linearRegressionSlope(
            recent.map(e => ({ x: e.time, y: e.ppm }))
        )

        if (slope <= 0) return 0

        // Scale: (rate of increase / sensitivity) / attention threshold / 100
        return ((slope / this.gasSensitivity) / this.attentionThreshold) / 100
    }

    _computeRefocusPressure() {
        const exploreTime = this.getTime() - this.exploreStartTime
        return (exploreTime / this.refocusRatio) * 10
    }

    _updateMode() {
        const previousMode = this.mode

        // Immediate exploration trigger if gas detected
        if (this.sensorReading > this.minimumGasThreshold && this.mode === "route-following") {
            this.mode = "explore"
            this.exploreStartTime = this.getTime()
            console.log(`GradientAgent: mode changed to "explore" (gas detected: ${this.sensorReading.toFixed(3)} PPM)`)
            this._publishModeState()
            return
        }

        // Only check interest vs pressure if we're already exploring AND have enough data
        if (this.mode === "explore") {
            const interest = this._computeInterest()
            const pressure = this._computeRefocusPressure()

            // Need enough data to make meaningful decision
            const currentTimeMinutes = this.getTime() / 60
            const attentionSpanMinutes = this.attentionSpan / 60
            const cutoff = currentTimeMinutes - attentionSpanMinutes
            const recentCount = this.gasMemory.filter(e => e.time >= cutoff).length

            // Only switch back to route if we have data AND pressure exceeds interest
            if (recentCount >= 2 && (interest - pressure) <= 1) {
                this.mode = "route-following"
                console.log(`GradientAgent: mode changed to "route-following" (interest: ${interest.toFixed(2)}, pressure: ${pressure.toFixed(2)})`)

                // Reset exploration state
                this.tempWaypoints = []
                this.currentTempIndex = 0
                this.recalcPending = false

                // Remove all visualization points
                this._clearAllVisualizations()

                this._publishModeState()
            }
        }
    }

    _publishModeState() {
        // Calculate cooldown even in route-following mode
        const timeSinceLastBuild = this.getTime() - this.lastCircleBuildTime
        const timeUntilNextRebuild = Math.max(0, this.circleRebuildDelay - timeSinceLastBuild)

        this.pubsub.publish('logJson', {
            mode: this.mode,
            interest: this._computeInterest().toFixed(3),
            refocus: this._computeRefocusPressure().toFixed(3),
            sensor: this.sensorReading.toFixed(3),
            gasMemorySize: this.gasMemory.length,
            rebuildCooldown: timeUntilNextRebuild.toFixed(1) + 's'
        })
    }

    _tick() {
        if (this.mode === "explore") {
            this._tickExplore()
        } else {
            this._tickRouteFollow()
        }
    }

    _tickRouteFollow() {
        if (this.routeWaypoints.length === 0 ||
            this.currentRouteIndex >= this.routeWaypoints.length) {
            return
        }

        const target = this.routeWaypoints[this.currentRouteIndex]
        this._publishWaypoint(target)

        this.pubsub.publish('logJson', {
            waypoint: `${this.currentRouteIndex + 1}/${this.routeWaypoints.length}`
        })
    }

    _tickExplore() {
        // Calculate time until next rebuild is allowed
        const timeSinceLastBuild = this.getTime() - this.lastCircleBuildTime
        const timeUntilNextRebuild = Math.max(0, this.circleRebuildDelay - timeSinceLastBuild)

        // Publish countdown to next allowed rebuild
        this.pubsub.publish('logJson', {
            rebuildCooldown: timeUntilNextRebuild.toFixed(1) + 's'
        })

        // Handle pending recalculation (wait one tick after gas increase)
        if (this.recalcPending) {
            this.recalcPending = false

            // Only rebuild if enough time has passed (debounce)
            if (timeSinceLastBuild >= this.circleRebuildDelay) {
                this.tempWaypoints = []
                this.currentTempIndex = 0
                console.log(`GradientAgent: rebuilding circle (cooldown complete)`)
            } else {
                // Not enough time passed, skip rebuild
                console.log(`GradientAgent: rebuild delayed - ${timeUntilNextRebuild.toFixed(1)}s remaining`)
            }
            return
        }

        // Build exploration circle if needed
        if (this.tempWaypoints.length === 0) {
            // Check cooldown before building new circle
            if (timeUntilNextRebuild > 0) {
                console.log(`GradientAgent: cannot build circle yet - ${timeUntilNextRebuild.toFixed(1)}s cooldown remaining`)
                // Fall back to route while waiting for cooldown
                this._tickRouteFollow()
                return
            }

            if (!this._buildExplorationCircle()) {
                // Not enough data, fall back to route
                this._tickRouteFollow()
                return
            }
        }

        // Navigate temp waypoints
        if (this.currentTempIndex >= this.tempWaypoints.length) {
            // Circle complete, rebuild on next tick
            this.tempWaypoints = []
            this.currentTempIndex = 0
            return
        }

        const target = this.tempWaypoints[this.currentTempIndex]
        this._publishWaypoint(target)

        this.pubsub.publish('logJson', {
            exploreWaypoint: `${this.currentTempIndex + 1}/${this.tempWaypoints.length}`
        })
    }

    _clearAllVisualizations() {
        // Remove all tracked visualization points
        for (const id of this.activeVisualizationIds) {
            this.pubsub.publish('visualizePoint', { id, remove: true })
        }
        this.activeVisualizationIds.clear()
    }

    _publishVisualization(data) {
        // Publish and track the visualization point
        this.pubsub.publish('visualizePoint', data)
        if (data.id && !data.remove) {
            this.activeVisualizationIds.add(data.id)
        }
    }

    _buildExplorationCircle() {
        if (this.gasMemory.length < 3) {
            return false
        }

        // Clean up ALL previous visualizations before creating new ones
        this._clearAllVisualizations()

        // Use last 3 points to calculate gradient
        const last3 = this.gasMemory.slice(-3)
        const gradDir = fitGradient2D(last3.map(e => ({
            x: e.position.x,
            y: e.position.y,
            value: e.ppm
        })))

        if (vecMagnitude(gradDir) < 1e-9) {
            return false
        }

        // Project forward to create centroid
        const centroid = vecAdd(this.position, vecScale(gradDir, this.circlingSize))

        console.log(`GradientAgent: building exploration circle around centroid (${centroid.x.toFixed(1)}, ${centroid.y.toFixed(1)})`)

        // Publish centroid visualization
        this._publishVisualization({
            id: 'centroid',
            x: centroid.x,
            y: centroid.y,
            color: '#f97316',
            label: 'centroid',
        })

        // Choose CW vs CCW based on distance from route
        const startAngle = Math.atan2(gradDir.y, gradDir.x)
        const cwPoints = circleWaypoints(
            centroid, this.circlingSize,
            this.circleWaypointCount, startAngle, true
        )
        const ccwPoints = circleWaypoints(
            centroid, this.circlingSize,
            this.circleWaypointCount, startAngle, false
        )

        // Favor direction further from route
        if (this.routeWaypoints.length >= 2) {
            const nearestRoute = nearestPointOnPolyline(centroid, this.routeWaypoints)
            const cwDist = vecDistance(cwPoints[1] ?? cwPoints[0], nearestRoute)
            const ccwDist = vecDistance(ccwPoints[1] ?? ccwPoints[0], nearestRoute)
            this.tempWaypoints = cwDist >= ccwDist ? cwPoints : ccwPoints
        } else {
            this.tempWaypoints = ccwPoints
        }

        this.currentTempIndex = 0

        // Publish waypoint visualizations
        this.tempWaypoints.forEach((wp, i) => {
            this._publishVisualization({
                id: `waypoint_${i}`,
                x: wp.x,
                y: wp.y,
                color: '#8b5cf6',
                label: `wp${i}`,
            })
        })

        console.log(`GradientAgent: created ${this.tempWaypoints.length} exploration waypoints`)

        // Update last build time for debouncing
        this.lastCircleBuildTime = this.getTime()

        return true
    }

    _publishWaypoint(target) {
        // Only publish if waypoint changed
        if (!this.currentPublishedWaypoint ||
            this.currentPublishedWaypoint.x !== target.x ||
            this.currentPublishedWaypoint.y !== target.y) {
            this.currentPublishedWaypoint = { x: target.x, y: target.y }
            this.pubsub.publish('target_waypoint', { x: target.x, y: target.y })

            // Reset tracking for new waypoint (from SimpleRouteAgent)
            this.waypointStartTime = this.getTime()
            this.lastDistanceCheck = null
            this.lastDistanceCheckTime = 0
            this.negativeVelocityStartTime = null
        }
    }

    _checkWaypointProgress() {
        // Get current target based on mode
        let target = null
        if (this.mode === "explore" && this.tempWaypoints.length > 0 &&
            this.currentTempIndex < this.tempWaypoints.length) {
            target = this.tempWaypoints[this.currentTempIndex]
        } else if (this.mode === "route-following" && this.routeWaypoints.length > 0 &&
            this.currentRouteIndex < this.routeWaypoints.length) {
            target = this.routeWaypoints[this.currentRouteIndex]
        }

        if (!target) return

        const currentDistance = vecDistance(this.position, target)
        const currentTime = this.getTime()
        const timeAtWaypoint = currentTime - this.waypointStartTime

        // Calculate velocity if we have a previous measurement
        if (this.lastDistanceCheck !== null) {
            const deltaDistance = this.lastDistanceCheck - currentDistance // positive = moving closer
            const deltaTime = currentTime - this.lastDistanceCheckTime
            const velocity = deltaDistance / deltaTime

            // Track negative or very low velocity (moving away or stuck)
            const velocityThreshold = 1.0 // units/second - below this is considered stuck
            if (velocity < velocityThreshold) {
                if (this.negativeVelocityStartTime === null) {
                    this.negativeVelocityStartTime = currentTime
                } else {
                    const stuckDuration = currentTime - this.negativeVelocityStartTime
                    if (stuckDuration > 2.0) {
                        console.log(`GradientAgent: stuck/moving backwards (velocity: ${velocity.toFixed(2)}) for ${stuckDuration.toFixed(2)}s, skipping waypoint`)

                        // Skip waypoint based on mode
                        if (this.mode === "explore") {
                            this.currentTempIndex++
                            if (this.currentTempIndex >= this.tempWaypoints.length) {
                                this.tempWaypoints = []
                                this.currentTempIndex = 0
                            }
                        } else {
                            this.currentRouteIndex++
                        }

                        this.currentPublishedWaypoint = null
                        this._tick()
                        return
                    }
                }
            } else {
                // Reset timer if making good progress
                this.negativeVelocityStartTime = null
            }
        }

        // Update tracking
        this.lastDistanceCheck = currentDistance
        this.lastDistanceCheckTime = currentTime
    }
}

import {
    vecAdd, vecSub, vecScale, vecMagnitude, vecDistance,
    angleDifference, linearRegressionSlope, fitGradient2D,
    circleWaypoints, nearestPointOnPolyline,
} from "./math_helpers.js"
import { createGetTime } from "./time.js"

/**
 * Autonomous gas-sensing agent that follows routes and explores gas gradients.
 *
 * Subscribes to gas readings and route updates via pub/sub. Publishes movement
 * commands. The agent's sensor can only detect concentration increases — it
 * never sees decreasing readings.
 *
 * Two behaviors run on a tick driven by the gas reading callback:
 *   1. Soft route following — head toward waypoints, skip if stuck
 *   2. Gradient exploration — circle around detected gas increases,
 *      returning to the route when interest fades
 *
 * @example
 *   const pubsubFactory = createPubSub()
 *   const agent = new GasAgent(pubsubFactory, { decisionRate: 1 })
 *   const mainPubsub = pubsubFactory("main")
 *   mainPubsub.publish("route_update", { waypoints: [{x:0,y:0},{x:10,y:0}] })
 *   mainPubsub.publish("gas_reading", { ppm: 0.5 })
 */
export class GasAgent {
    /**
     * @param {Function} pubsubFactory - factory function that returns pubsub instance when called with identity
     * @param {object} [config]
     * @param {number} [config.minimumGasThreshold=0.1]   PPM — ignore readings below this
     * @param {number} [config.gasSensitivity=0.05]       PPM — min delta to record a memory entry
     * @param {number} [config.circlingSize=5]             meters — exploration circle radius
     * @param {number} [config.gradientProjection]         meters — how far to extrapolate gradient (defaults to circlingSize)
     * @param {number} [config.attentionThreshold=0.1]    (sensitivity-units/min) — minimum gradient to explore
     * @param {number} [config.refocusRatio=60]            seconds — max explore time at baseline gradient
     * @param {number} [config.attentionSpan=120]          seconds — lookback window for gradient calc
     * @param {number} [config.maxBufferSize=500]          max gas_memory entries
     * @param {number} [config.decisionRate=1]             seconds — interval between gas callbacks / movement decisions
     * @param {number} [config.samplingRate=60]            ticks — interval between recording gas samples (in decision ticks)
     * @param {number} [config.circleWaypointCount=8]      waypoints per exploration circle
     * @param {{x:number,y:number}} [config.startPosition={x:0,y:0}]
     * @param {number} [config.startHeading=0]             radians
     */
    constructor(pubsubFactory, config = {}) {
        globalThis.agent = this // For debugging
        this.pubsub = pubsubFactory("agent")
        this.getTime = createGetTime(this.pubsub)

        // Parameters
        this.minimumGasThreshold = config.minimumGasThreshold ?? 0.1
        this.gasSensitivity      = config.gasSensitivity ?? 0.05
        this.circlingSize        = config.circlingSize ?? 5
        this.gradientProjection  = config.gradientProjection ?? this.circlingSize
        this.attentionThreshold  = config.attentionThreshold ?? 0.1
        this.refocusRatio        = config.refocusRatio ?? 60
        this.attentionSpan       = config.attentionSpan ?? 120
        this.maxBufferSize       = config.maxBufferSize ?? 500
        this.decisionRate        = config.decisionRate ?? 1
        this.samplingRate        = config.samplingRate ?? 60
        this.circleWaypointCount = config.circleWaypointCount ?? 8

        // Position / heading
        this.position = { x: (config.startPosition?.x ?? 0), y: (config.startPosition?.y ?? 0) }
        this.heading = config.startHeading ?? 0

        // Sensor limitation: only increases
        this.sensorReading = 0

        // Route following state
        this.routeWaypoints = []
        this.currentWaypointIndex = 0

        // Gradient exploration state
        this.mode = "route-following"
        this.gasMemory = []
        this.exploreStartTime = 0
        this.tempWaypoints = []
        this.tempWaypointIndex = 0
        this.recalcPending = false

        // Time tracking using clock system
        this._lastSampleTime = 0

        // Track currently published waypoint to avoid redundant publications
        this.currentPublishedWaypoint = null

        // Subscribe
        this.pubsub.subscribe("gas_reading", (data, publisher) => this._onGasReading(data))
        this.pubsub.subscribe("route_update", (data, publisher) => this._onRouteUpdate(data))
        this.pubsub.subscribe("odom", (data, publisher) => {
            this.position.x = data.x
            this.position.y = data.y
            this.heading = data.heading
        })
        this.pubsub.subscribe("waypoint_reached", (data, publisher) => this._onWaypointReached(data))
    }

    /** Time spent exploring in seconds. */
    get exploreTime() {
        return this.mode === "explore" ? (this.getTime() - this.exploreStartTime) : 0
    }

    // ── Pub/Sub Handlers ──────────────────────────────────────────────

    /**
     * Route updates overwrite the route but preserve exploration state.
     * @param {{waypoints: {x:number,y:number}[]}} data
     */
    _onRouteUpdate(data) {
        console.log(`Agent: route updated with ${data.waypoints.length} waypoints`);
        this.routeWaypoints = data.waypoints.map(w => ({ x: w.x, y: w.y }))
        this.currentWaypointIndex = 0
    }

    /**
     * Main tick — processes gas, updates mode, decides movement.
     * @param {{ppm: number}} data
     */
    _onGasReading(data) {
        // Sensor can only go up
        if (data.ppm > this.sensorReading) {
            this.sensorReading = data.ppm
        }

        this._updateGasMemory()

        const prevMode = this.mode
        this._updateMode()

        // Transition route-following → explore: start tracking explore time
        if (prevMode === "route-following" && this.mode === "explore") {
            this.exploreStartTime = this.getTime()
        }

        // Transition explore → route-following: reset explore state
        if (prevMode === "explore" && this.mode === "route-following") {
            this.exploreStartTime = 0
            this.tempWaypoints = []
            this.tempWaypointIndex = 0
            this.recalcPending = false

            // Remove visualization points
            this.pubsub.publish('visualizePoint', { id: 'centroid', remove: true })
            const maxWaypoints = 16;
            for (let i = 0; i < maxWaypoints; i++) {
                this.pubsub.publish('visualizePoint', { id: `waypoint_${i}`, remove: true })
            }
        }

        if (this.mode === "explore") {
            this._tickExplore()
        } else {
            this._tickRouteFollow()
        }

        // Publish state for UI display
        this.pubsub.publish('logJson', {
            sensor: this.sensorReading.toFixed(3),
            interest: this.computeInterest().toFixed(3),
            refocus: this.computeRefocusPressure().toFixed(3),
            mode: this.mode,
        })
    }

    // ── Gas Memory ────────────────────────────────────────────────────

    /**
     * Record a gas memory entry immediately when reading passes minimum and
     * sensitivity thresholds. Trigger circle recalculation at samplingRate intervals.
     */
    _updateGasMemory() {
        const lastPpm = this.gasMemory.length > 0
            ? this.gasMemory[this.gasMemory.length - 1].ppm
            : -Infinity

        // Record samples immediately when they meet threshold/sensitivity requirements
        if (this.sensorReading > this.minimumGasThreshold &&
            (this.sensorReading - this.gasSensitivity) > lastPpm) {
            console.log(`Agent: gas memory recorded at (${this.position.x.toFixed(1)}, ${this.position.y.toFixed(1)}): ${this.sensorReading.toFixed(3)} PPM (total: ${this.gasMemory.length + 1})`);
            this.gasMemory.push({
                ppm: this.sensorReading,
                time: this.getTime() / 60,
                position: { x: this.position.x, y: this.position.y },
            })
            if (this.gasMemory.length > this.maxBufferSize) {
                this.gasMemory.shift()
            }

            // Only trigger circle recalculation at samplingRate intervals (converted to seconds)
            const timeSinceLastSample = this.getTime() - this._lastSampleTime
            const samplingInterval = this.samplingRate * this.decisionRate
            if (timeSinceLastSample >= samplingInterval) {
                this._lastSampleTime = this.getTime()
                // Signal recalculation if we're exploring
                if (this.mode === "explore") {
                    this.recalcPending = true
                }
            }
        }
    }

    // ── Interest / Mode ───────────────────────────────────────────────

    /**
     * Interest: normalized gradient steepness over the attention span window.
     * Scaled to be comparable with refocus pressure (typically 0-10 range).
     * @returns {number}
     */
    computeInterest() {
        // Convert attentionSpan from seconds to minutes for comparison with memory timestamps
        const attentionSpanMinutes = this.attentionSpan / 60
        const cutoff = (this.getTime() / 60) - attentionSpanMinutes
        const recent = this.gasMemory.filter(e => e.time >= cutoff)
        if (recent.length < 2) return 0
        const slope = linearRegressionSlope(
            recent.map(e => ({ x: e.time, y: e.ppm }))
        )
        if (slope <= 0) return 0
        // Scale down by 100x to bring into reasonable range (0-10) for typical gradients
        return ((slope / this.gasSensitivity) / this.attentionThreshold) / 100
    }

    /**
     * Refocus pressure: grows with exploration time (in seconds).
     * Scaled to match interest range (reaches ~10 after refocusRatio seconds).
     * @returns {number}
     */
    computeRefocusPressure() {
        // exploreTime and refocusRatio are both in seconds
        return (this.exploreTime / this.refocusRatio) * 10
    }

    /** Update mode based on interest vs refocus pressure. */
    _updateMode() {
        const previousMode = this.mode

        // Immediate exploration trigger: start exploring as soon as gas exceeds threshold
        if (this.sensorReading > this.minimumGasThreshold && this.mode === "route-following") {
            this.mode = "explore"
            if (previousMode !== this.mode) {
                this.pubsub.publish('logJson', {
                    mode: this.mode,
                    gasMemorySize: this.gasMemory.length,
                    exploreTime: this.exploreTime,
                })
            }
            return
        }

        // Continue exploring or return to route based on interest/pressure
        const interest = this.computeInterest()
        const pressure = this.computeRefocusPressure()
        this.mode = (interest - pressure) > 1 ? "explore" : "route-following"

        if (previousMode !== this.mode) {
            console.log(`Agent: mode changed from "${previousMode}" to "${this.mode}" (interest: ${interest.toFixed(2)}, pressure: ${pressure.toFixed(2)})`);
            this.pubsub.publish('logJson', {
                mode: this.mode,
                gasMemorySize: this.gasMemory.length,
                exploreTime: this.exploreTime,
            })
        }
    }

    // ── Route Following ───────────────────────────────────────────────

    /** Route following: move toward current waypoint. */
    _tickRouteFollow() {
        if (this.routeWaypoints.length === 0 ||
            this.currentWaypointIndex >= this.routeWaypoints.length) {
            return
        }

        const target = this.routeWaypoints[this.currentWaypointIndex]
        this._navigateToWaypoint(target)
    }

    // ── Gradient Exploration ──────────────────────────────────────────

    /**
     * Exploration tick: build or follow temp waypoints around gas gradient.
     * On a new gas memory entry, schedule recalculation after one tick.
     */
    _tickExplore() {
        // Recalc delay: gas increase was found last tick, now clear and pause.
        // The rebuild happens on the following tick when tempWaypoints is empty.
        if (this.recalcPending) {
            this.recalcPending = false
            this.tempWaypoints = []
            this.tempWaypointIndex = 0
            return
        }

        // Build exploration circle if needed
        if (this.tempWaypoints.length === 0) {
            if (!this._buildExplorationCircle()) {
                // Not enough data — fall back to route
                this._tickRouteFollow()
                return
            }
        }

        // Navigate temp waypoints
        if (this.tempWaypointIndex >= this.tempWaypoints.length) {
            // Completed circle — rebuild
            this.tempWaypoints = []
            this.tempWaypointIndex = 0
            return
        }

        const target = this.tempWaypoints[this.tempWaypointIndex]
        this._navigateToWaypoint(target)
    }

    /**
     * Compute gradient from last 3 gas memory points, project forward to
     * create a centroid, generate circle waypoints favoring the rotation
     * that moves away from the route.
     * @returns {boolean} true if circle was built
     */
    _buildExplorationCircle() {
        if (this.gasMemory.length < 3) return false

        const last3 = this.gasMemory.slice(-3)
        const gradDir = fitGradient2D(last3.map(e => ({
            x: e.position.x,
            y: e.position.y,
            value: e.ppm,
        })))
        if (vecMagnitude(gradDir) < 1e-9) return false

        // Project forward by gradientProjection distance to extrapolate source location
        const centroid = vecAdd(this.position, vecScale(gradDir, this.gradientProjection))

        // Publish centroid visualization (with ID for replacement)
        this.pubsub.publish('visualizePoint', {
            id: 'centroid',
            x: centroid.x,
            y: centroid.y,
            color: '#f97316',
            label: 'centroid',
        })

        // Choose CW vs CCW: favor direction away from route
        const startAngle = Math.atan2(gradDir.y, gradDir.x)
        const cwPoints = circleWaypoints(
            centroid, this.circlingSize,
            this.circleWaypointCount, startAngle, true
        )
        const ccwPoints = circleWaypoints(
            centroid, this.circlingSize,
            this.circleWaypointCount, startAngle, false
        )

        if (this.routeWaypoints.length >= 2) {
            const nearestRoute = nearestPointOnPolyline(centroid, this.routeWaypoints)
            const cwDist = vecDistance(cwPoints[1] ?? cwPoints[0], nearestRoute)
            const ccwDist = vecDistance(ccwPoints[1] ?? ccwPoints[0], nearestRoute)
            this.tempWaypoints = cwDist >= ccwDist ? cwPoints : ccwPoints
        } else {
            this.tempWaypoints = ccwPoints
        }

        // Remove old waypoints that won't be replaced
        const maxWaypoints = 16; // Should match what was in main.js
        for (let i = this.tempWaypoints.length; i < maxWaypoints; i++) {
            this.pubsub.publish('visualizePoint', {
                id: `waypoint_${i}`,
                remove: true,
            })
        }

        // Publish waypoint visualizations (with IDs for replacement)
        this.tempWaypoints.forEach((wp, i) => {
            this.pubsub.publish('visualizePoint', {
                id: `waypoint_${i}`,
                x: wp.x,
                y: wp.y,
                color: '#8b5cf6',
                label: `wp${i}`,
            })
        })

        this.tempWaypointIndex = 0

        // Publish scalar state info (centroid is already published via visualizePoint)
        this.pubsub.publish('logJson', {
            waypointCount: this.tempWaypoints.length,
            circlingSize: this.circlingSize,
        })

        console.log(`Agent: built exploration circle with ${this.tempWaypoints.length} waypoints around centroid (${centroid.x.toFixed(1)}, ${centroid.y.toFixed(1)})`);
        return true
    }

    // ── Movement ──────────────────────────────────────────────────────

    /**
     * Publish target waypoint to local planner (only if changed).
     * @param {{x:number,y:number}} target
     */
    _navigateToWaypoint(target) {
        // Only publish if waypoint changed
        if (!this.currentPublishedWaypoint ||
            this.currentPublishedWaypoint.x !== target.x ||
            this.currentPublishedWaypoint.y !== target.y) {
            this.currentPublishedWaypoint = { x: target.x, y: target.y }
            this.pubsub.publish('target_waypoint', { x: target.x, y: target.y })
        }
    }

    /**
     * Handle waypoint reached event from local planner.
     * @param {{waypoint: {x:number, y:number}}} data
     */
    _onWaypointReached(data) {
        // Advance to next waypoint in route or circle
        if (this.mode === "explore" && this.tempWaypoints.length > 0) {
            console.log(`Agent: exploration waypoint ${this.tempWaypointIndex + 1}/${this.tempWaypoints.length} reached`);
            this.tempWaypointIndex++
        } else if (this.mode === "route-following" && this.routeWaypoints.length > 0) {
            console.log(`Agent: route waypoint ${this.currentWaypointIndex + 1}/${this.routeWaypoints.length} reached`);
            this.currentWaypointIndex++
        }
    }

}

import {
    vecAdd, vecSub, vecScale, vecMagnitude, vecDistance,
    angleDifference, linearRegressionSlope, fitGradient2D,
    circleWaypoints, nearestPointOnPolyline,
} from "./math_helpers.js"

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
 *   const pubsub = createPubSub()
 *   const agent = new GasAgent(pubsub, { decisionRate: 1 })
 *   pubsub.publish("route_update", { waypoints: [{x:0,y:0},{x:10,y:0}] })
 *   pubsub.publish("gas_reading", { ppm: 0.5 })
 */
export class GasAgent {
    /**
     * @param {object} pubsub - must have subscribe(channel, callback) and publish(channel, data)
     * @param {object} [config]
     * @param {number} [config.minimumGasThreshold=0.1]   PPM — ignore readings below this
     * @param {number} [config.gasSensitivity=0.05]       PPM — min delta to record a memory entry
     * @param {number} [config.circlingSize=5]             meters — exploration circle radius
     * @param {number} [config.gradientProjection]         meters — how far to extrapolate gradient (defaults to circlingSize)
     * @param {number} [config.attentionThreshold=0.1]    (sensitivity-units/min) — minimum gradient to explore
     * @param {number} [config.refocusRatio=60]            seconds — max explore time at baseline gradient
     * @param {number} [config.attentionSpan=2]            minutes — lookback window for gradient calc
     * @param {number} [config.maxBufferSize=500]          max gas_memory entries
     * @param {number} [config.decisionRate=1]             seconds — interval between gas callbacks / movement decisions
     * @param {number} [config.samplingRate=60]            ticks — interval between recording gas samples (in decision ticks)
     * @param {number} [config.waypointThreshold=2]        meters — "close enough" to a waypoint
     * @param {number} [config.waypointPatience=30]        ticks — skip waypoint if no progress
     * @param {number} [config.moveSpeed=1]                meters per tick
     * @param {number} [config.turnSpeed=0.3]              radians per tick
     * @param {number} [config.circleWaypointCount=8]      waypoints per exploration circle
     * @param {{x:number,y:number}} [config.startPosition={x:0,y:0}]
     * @param {number} [config.startHeading=0]             radians
     */
    constructor(pubsub, config = {}) {
        this.pubsub = pubsub

        // Parameters
        this.minimumGasThreshold = config.minimumGasThreshold ?? 0.1
        this.gasSensitivity      = config.gasSensitivity ?? 0.05
        this.circlingSize        = config.circlingSize ?? 5
        this.gradientProjection  = config.gradientProjection ?? this.circlingSize
        this.attentionThreshold  = config.attentionThreshold ?? 0.1
        this.refocusRatio        = config.refocusRatio ?? 60
        this.attentionSpan       = config.attentionSpan ?? 2
        this.maxBufferSize       = config.maxBufferSize ?? 500
        this.decisionRate        = config.decisionRate ?? 1
        this.samplingRate        = config.samplingRate ?? 60
        this.waypointThreshold   = config.waypointThreshold ?? 2
        this.waypointPatience    = config.waypointPatience ?? 30
        this.moveSpeed           = config.moveSpeed ?? 1
        this.turnSpeed           = config.turnSpeed ?? 0.3
        this.circleWaypointCount = config.circleWaypointCount ?? 8

        // Position / heading
        this.position = { x: (config.startPosition?.x ?? 0), y: (config.startPosition?.y ?? 0) }
        this.heading = config.startHeading ?? 0

        // Sensor limitation: only increases
        this.sensorReading = 0

        // Route following state
        this.routeWaypoints = []
        this.currentWaypointIndex = 0
        this.bestDistanceToWaypoint = Infinity
        this.ticksAtWaypoint = 0

        // Gradient exploration state
        this.mode = "inactive"
        this.gasMemory = []
        this.exploreTime = 0
        this.tempCentroid = null
        this.tempWaypoints = []
        this.tempWaypointIndex = 0
        this.recalcPending = false

        // Time tracking
        this.tickCount = 0
        this.lastSampleTick = 0

        // Subscribe
        pubsub.subscribe("gas_reading", (data) => this._onGasReading(data))
        pubsub.subscribe("route_update", (data) => this._onRouteUpdate(data))
        pubsub.subscribe("odom", (data) => this._onOdom(data))
    }

    /** Current simulation time in seconds. */
    get currentTime() {
        return this.tickCount * this.decisionRate
    }

    /** Current simulation time in minutes. */
    get currentTimeMinutes() {
        return this.currentTime / 60
    }

    // ── Pub/Sub Handlers ──────────────────────────────────────────────

    /**
     * Route updates overwrite the route but preserve exploration state.
     * @param {{waypoints: {x:number,y:number}[]}} data
     */
    _onRouteUpdate(data) {
        this.routeWaypoints = data.waypoints.map(w => ({ x: w.x, y: w.y }))
        this.currentWaypointIndex = 0
        this.bestDistanceToWaypoint = Infinity
        this.ticksAtWaypoint = 0
    }

    /**
     * Main tick — processes gas, updates mode, decides movement.
     * @param {{ppm: number}} data
     */
    _onGasReading(data) {
        this.tickCount++

        // Sensor can only go up
        if (data.ppm > this.sensorReading) {
            this.sensorReading = data.ppm
        }

        this._updateGasMemory()

        const prevMode = this.mode
        this._updateMode()

        // Transition explore → inactive: reset explore state
        if (prevMode === "explore" && this.mode === "inactive") {
            this.exploreTime = 0
            this.tempCentroid = null
            this.tempWaypoints = []
            this.tempWaypointIndex = 0
            this.recalcPending = false
        }

        if (this.mode === "explore") {
            this.exploreTime += this.decisionRate
            this._tickExplore()
        } else {
            this._tickRouteFollow()
        }
    }

    // ── Gas Memory ────────────────────────────────────────────────────

    /**
     * Record a gas memory entry if the reading passes minimum and
     * sensitivity thresholds, and enough ticks have passed since last sample.
     */
    _updateGasMemory() {
        // Only record samples at samplingRate intervals (measured in ticks)
        const ticksSinceLastSample = this.tickCount - this.lastSampleTick
        if (ticksSinceLastSample < this.samplingRate) {
            return
        }

        const lastPpm = this.gasMemory.length > 0
            ? this.gasMemory[this.gasMemory.length - 1].ppm
            : -Infinity

        if (this.sensorReading > this.minimumGasThreshold &&
            (this.sensorReading - this.gasSensitivity) > lastPpm) {
            this.gasMemory.push({
                ppm: this.sensorReading,
                time: this.currentTimeMinutes,
                position: { x: this.position.x, y: this.position.y },
            })
            this.lastSampleTick = this.tickCount
            if (this.gasMemory.length > this.maxBufferSize) {
                this.gasMemory.shift()
            }
            // Signal recalculation if we're exploring
            if (this.mode === "explore") {
                this.recalcPending = true
            }
        }
    }

    // ── Interest / Mode ───────────────────────────────────────────────

    /**
     * Interest: normalized gradient steepness over the attention span window.
     * @returns {number}
     */
    computeInterest() {
        const cutoff = this.currentTimeMinutes - this.attentionSpan
        const recent = this.gasMemory.filter(e => e.time >= cutoff)
        if (recent.length < 2) return 0
        const slope = linearRegressionSlope(
            recent.map(e => ({ x: e.time, y: e.ppm }))
        )
        if (slope <= 0) return 0
        return (slope / this.gasSensitivity) / this.attentionThreshold
    }

    /**
     * Refocus pressure: grows with exploration time.
     * @returns {number}
     */
    computeRefocusPressure() {
        return this.exploreTime / this.refocusRatio
    }

    /** Update mode based on interest vs refocus pressure. */
    _updateMode() {
        const interest = this.computeInterest()
        const pressure = this.computeRefocusPressure()
        this.mode = (interest - pressure) > 1 ? "explore" : "inactive"
    }

    // ── Route Following ───────────────────────────────────────────────

    /** Soft route following: move toward current waypoint, skip if stuck. */
    _tickRouteFollow() {
        if (this.routeWaypoints.length === 0 ||
            this.currentWaypointIndex >= this.routeWaypoints.length) {
            return
        }

        const target = this.routeWaypoints[this.currentWaypointIndex]
        const dist = vecDistance(this.position, target)

        if (dist < this.waypointThreshold) {
            this._advanceWaypoint()
            return
        }

        if (dist < this.bestDistanceToWaypoint) {
            this.bestDistanceToWaypoint = dist
            this.ticksAtWaypoint = 0
        } else {
            this.ticksAtWaypoint++
        }

        if (this.ticksAtWaypoint >= this.waypointPatience) {
            this._advanceWaypoint()
            return
        }

        this._moveToward(target)
    }

    _advanceWaypoint() {
        this.currentWaypointIndex++
        this.bestDistanceToWaypoint = Infinity
        this.ticksAtWaypoint = 0
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
            this.tempCentroid = null
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
            this.tempCentroid = null
            this.tempWaypoints = []
            this.tempWaypointIndex = 0
            return
        }

        const target = this.tempWaypoints[this.tempWaypointIndex]
        const dist = vecDistance(this.position, target)
        if (dist < this.waypointThreshold) {
            this.tempWaypointIndex++
            return
        }
        this._moveToward(target)
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
        this.tempCentroid = vecAdd(this.position, vecScale(gradDir, this.gradientProjection))

        // Choose CW vs CCW: favor direction away from route
        const startAngle = Math.atan2(gradDir.y, gradDir.x)
        const cwPoints = circleWaypoints(
            this.tempCentroid, this.circlingSize,
            this.circleWaypointCount, startAngle, true
        )
        const ccwPoints = circleWaypoints(
            this.tempCentroid, this.circlingSize,
            this.circleWaypointCount, startAngle, false
        )

        if (this.routeWaypoints.length >= 2) {
            const nearestRoute = nearestPointOnPolyline(this.tempCentroid, this.routeWaypoints)
            const cwDist = vecDistance(cwPoints[1] ?? cwPoints[0], nearestRoute)
            const ccwDist = vecDistance(ccwPoints[1] ?? ccwPoints[0], nearestRoute)
            this.tempWaypoints = cwDist >= ccwDist ? cwPoints : ccwPoints
        } else {
            this.tempWaypoints = ccwPoints
        }

        this.tempWaypointIndex = 0
        return true
    }

    // ── Movement ──────────────────────────────────────────────────────

    /**
     * Rotate toward target and move forward, publishing a movement message.
     * @param {{x:number,y:number}} target
     */
    _moveToward(target) {
        const diff = vecSub(target, this.position)
        const targetAngle = Math.atan2(diff.y, diff.x)
        let rotation = angleDifference(this.heading, targetAngle)

        // Clamp rotation
        if (Math.abs(rotation) > this.turnSpeed) {
            rotation = Math.sign(rotation) * this.turnSpeed
        }

        const dist = vecMagnitude(diff)
        const forward = Math.min(this.moveSpeed, dist)

        this._publishMovement(forward, rotation)
    }

    /**
     * Publish movement command. Actual position/heading will be updated via odom.
     * @param {number} forward  meters
     * @param {number} rotation radians
     */
    _publishMovement(forward, rotation) {
        this.pubsub.publish("movement", { forward, rotation })
    }

    /**
     * Update position/heading from odometry (actual robot pose after obstacle avoidance).
     * @param {{x:number, y:number, heading:number}} data - robot pose
     */
    _onOdom(data) {
        this.position.x = data.x
        this.position.y = data.y
        this.heading = data.heading
    }
}

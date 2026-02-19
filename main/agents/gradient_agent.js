import { createGetTime } from '../../time.js'
import { Computed } from '../tooling/pubsub.js'
import { vecDistance } from '../tooling/math_helpers.js'

/**
 * Simple route-following agent for debugging the local planner.
 * Just follows waypoints in sequence without any gas sensing or exploration.
 */
export class GradientAgent {
    /**
     * @param {Function} pubsubFactory - factory function that returns pubsub instance
     * @param {object} [config]
     * @param {{x:number,y:number}} [config.startPosition={x:0,y:0}]
     */
    constructor(pubsubFactory, config = {}) {
        const pubsub = this.pubsub = pubsubFactory("simple_agent")
        const getTime = this.getTime = createGetTime(this.pubsub)
        
        this.disabledOutput = false
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

        // base values
        let gasValue = -Infinity
        const gasReadingComputed = new Computed({initValue:null, pubsub, topics:{gas_reading:null}}, ({gas_reading}, key, who)=>{
        const odomComputed = new Computed({initValue:null, pubsub, topics:{odom:null}}, (values, key, who)=>values.odom)
            return gasValue = Math.max(gasValue, gas_reading)
        })
        let gasMemoryMaxDuration = 30
        const gasMemoryComputed = new Computed({initValue:[], pubsub, topics:{gasReadingComputed}}, ({gasReadingComputed}, key, who)=>{
            const now = this.getTime()
            gasMemory.push({time:now, value:gasReadingComputed, position:odomComputed.value})
            return gasMemoryComputed.value.filter(each=>now-each.time<gasMemoryMaxDuration)
        })
        const gradientComputed = new Computed({initValue:null, pubsub, topics:{gasMemoryComputed}}, ({gasMemoryComputed}, key, who)=>{
            if (gasMemoryComputed.length < 3) {
                return 0
            }
            const { time: startTime, value: startConcentration, position: startPosition } = gasMemoryComputed.at(0)
            const { time: endTime, value: endConcentration, position: endPosition } = gasMemoryComputed.at(-1)
            const duration = endTime - startTime
            const gasChange = endConcentration - startConcentration
            if (gasChange < this.threshold) {
                return 0
            }
            return gasChange / duration
        })
        

        const boredomBehavior = {
            stampData: { "time": null, gasReadingComputed, odomComputed, },
            init() {

            },
            behaviorSwitcher: [
                { gradientComputed },
                ({ gradientComputed })=>{
                    if (gradientComputed.value < this.threshold) {
                        return explorationBehavior
                    }
                }
            ]
        }
        const explorationBehavior = {
            stampData: { "time": null, gasReadingComputed, odomComputed, },
            computed: (stampData)=>({
                refocusPressure: new Computed({initValue:null, pubsub, topics:{gasReadingComputed}}, ({gasReadingComputed}, key, who)=>{
                    const startTime = stampData.time
                    const now = getTime()
                    const duration = now - startTime
                    return duration / 
                })
            })
            init(stampData) {
                // clear out old values
                gasReadingComputed.value = []
                this.refocusPressure = new Computed({initValue:null, pubsub, topics:{gasReadingComputed}}, ({gasReadingComputed}, key, who)=>{

                })
            },
            behaviorSwitcher: [
                { gradientComputed },
                ({ gradientComputed })=>{
                    if (gradientComputed.value < this.threshold) {
                        return explorationBehavior
                    }
                }
            ]
        }

        // main loop
            // events:
                // init
                    // trigger: external
                // overwhelmed by boredom
                    // trigger: buffer large and insufficient gradient
                    // action:
                        // passively record gas values
                // exploration start
                    // trigger: external, init, from overwhelmed by boredom
                    // action:
                        // trigger a centroid
                        // listen to gas values
                        // calculate refocus pressure
                // centroid creation
                    // triggers:
                        // 1. no centroid and exploration
                        // 2. time since previous centroid is large enough to draw new gradient
                        // 3. all waypoints of centroid have been explored
                    // action:
                        // calculate the gradient direction
                        // 
                    
                
            // continuous values:
                // gas gradient slope: how fast the concentration of gas has been increasing in the recent window
                // gas gradient direction: the best relative angle towards what appears to be the gas source
                // refocus pressure: based on duration and ratio, how much pressure has built up

        this.pubsub.subscribe("time", ({virtualTime}, publisher) => {
            
        })
    }

    disableOutput() {
        this.disabledOutput = true
    }

    enableOutput() {
        this.disabledOutput = false
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
            if (!this.disabledOutput) {
                this.pubsub.publish('target_waypoint', { x: target.x, y: target.y })
                this.pubsub.publish('logJson', {
                    waypoint: `${this.currentWaypointIndex + 1}/${this.routeWaypoints.length}`
                })
            }

            // Reset tracking for new waypoint
            this.waypointStartTime = this.getTime()
            this.lastDistanceCheck = null
            this.lastDistanceCheckTime = 0
            this.negativeVelocityStartTime = null
        }
    }

    _checkWaypointProgress() {
        if (this.routeWaypoints.length === 0 ||
            this.currentWaypointIndex >= this.routeWaypoints.length) {
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

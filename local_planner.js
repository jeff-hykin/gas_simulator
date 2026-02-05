import { vecDistance, vecSub, angleDifference } from "./math_helpers.js";
import { createGetTime } from "./time.js";

export class LocalPlanner {
    constructor(pubsubFactory, {
        minimumDistanceThatIsProgress = 0.1,
        closeEnoughToWaypoint = 0.1,
        timeBeforeRandomMove = 30 /* timesteps */,
        randomMoveDistance = 40 /* map units */,
        randomMoveTime = 10 /* timesteps */,
        maxEvaluationPoints = 10,
        movementSpeed = 1,
    } = {}) {
        this.pubsub = pubsubFactory("localPlanner");
        this.getTime = createGetTime(pubsub);
        // setup odom
        this.odom = null;
        this.pubsub.subscribe("odom", (data) => this.odom=data)
        // helpers for progress calculation
        this.progress 
        this.randomSwitchTime 
        this.randomSwitchOdom 
        this.timeOfLastMeaningfulProgress 
        this.evaluationPoints  // [  [time, odom], [laterTime, odom] ] 
        this.reset() // inits all the not-assigned values above
        this.mode = "idle"

        // setup target waypoint
        this.targetWaypoint = null;
        this.pubsub.subscribe("target_waypoint", (data) => {
            if (JSON.stringify(this.targetWaypoint) === JSON.stringify(data)) {
                console.warn("LocalPlanner: received same target waypoint twice. This is bad, only send a new target waypoint when the target changes")
                return
            }
            // clear prev odom points (they may have been going after a different target)
            this.reset()
            this.targetWaypoint = data
            this.mode = "greedy"
        });

        // main loop
        this.pubsub.subscribe("time", (time) => {
            // setup evaluation points
            if (this.odom == null || this.targetWaypoint == null) {
                return 
            }
            // keep buffer up to date
            this.evaluationPoints.push([time, this.odom])
            while (this.evaluationPoints.length > maxEvaluationPoints) {
                this.evaluationPoints.shift()
            }

            if (distance(this.odom, this.targetWaypoint) < closeEnoughToWaypoint) {
                this.mode = "idle"
                this.pubsub.publish('waypoint_reached', { waypoint: this.targetWaypoint })
            }
            
            // evaluate if getting stuck
            if (this.targetWaypoint && this.evaluationPoints.length > 1) {
                let [ oldestEvalPositionTime, oldestEvalPosition ] = this.evaluationPoints.at(0)
                let [ newestEvalPositionTime, newestEvalPosition ] = this.evaluationPoints.at(-1)
                const changeInDistance = distance(oldestEvalPosition, this.targetWaypoint) - distance(newestEvalPosition, this.targetWaypoint)
                const changeInTime = newestEvalPositionTime - oldestEvalPositionTime
                this.progress = changeInDistance / changeInTime
                
                if (changeInDistance >= minimumDistanceThatIsProgress) {
                    this.timeOfLastMeaningfulProgress = time
                }

                // enable random mode if no progress is being made for a while
                if (time - timeOfLastMeaningfulProgress > timeBeforeRandomMove) {
                    this.activateRandomMode()
                    return
                } else if (this.mode === "random") {
                    // check if distance or time limit hit
                    const timeLimitHit = (time - this.randomSwitchTime) > randomMoveTime
                    const distanceLimitHit = distance(this.randomSwitchOdom, this.odom) > randomMoveDistance
                    if (distanceLimitHit) {
                        // go back to greedy
                        this.reset()
                        this.mode = "greedy"
                    } else if (timeLimitHit) {
                        // didn't move far enough, try new random angle
                        this.reset()
                        this.activateRandomMode()
                        return
                    }
                }
            }

            if (this.mode == "greedy") {
                // CHECKME: calculate angle to next waypoint
                const angle = Math.atan2(this.targetWaypoint.y - this.odom.y, this.targetWaypoint.x - this.odom.x)
                this.pubsub.publish('movement', { linearVelocity: movementSpeed, angularVelocity: angle })
            }
        })
    }

    reset() {
        this.progress = null
        this.randomSwitchTime = null
        this.randomSwitchOdom = null
        this.timeOfLastMeaningfulProgress = this.getTime()
        this.evaluationPoints = []; // [  [time, odom], [laterTime, odom] ] 
    }

    activateRandomMode() {
        this.mode = "random"
        this.randomSwitchTime = time
        this.randomSwitchOdom = this.odom
        const randomAngle = Math.random() * 2 * Math.PI;
        this.pubsub.publish('movement', { linearVelocity: randomMoveDistance, angularVelocity: randomAngle });
    }
}
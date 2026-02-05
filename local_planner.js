import { vecDistance as distance, vecSub, angleDifference } from "./math_helpers.js";
import { createGetTime } from "./time.js";

export class LocalPlanner {
    constructor(pubsubFactory, {
        minimumDistanceThatIsProgress = 0.1,
        closeEnoughToWaypoint = 0.1,
        timeBeforeRandomMove = 3 /* timesteps: (roughly seconds) */,
        randomMoveDistance = 45 /* map units, robot is 26 units long */,
        randomMoveTime = 2 /* timesteps: (roughly seconds) */,
        maxEvaluationPoints = 10,
        movementSpeed = 50,
    } = {}) {
        this.pubsub = pubsubFactory("localPlanner");
        this.getTime = createGetTime(this.pubsub);

        // Store config
        this.movementSpeed = movementSpeed;
        this.closeEnoughToWaypoint = closeEnoughToWaypoint;
        this.minimumDistanceThatIsProgress = minimumDistanceThatIsProgress;
        this.timeBeforeRandomMove = timeBeforeRandomMove;
        this.randomMoveDistance = randomMoveDistance;
        this.randomMoveTime = randomMoveTime;

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
        this.pubsub.subscribe("time", (data) => {
            const time = data.virtualTime;
            // setup evaluation points
            if (this.odom == null || this.targetWaypoint == null) {
                return 
            }
            // keep buffer up to date
            this.evaluationPoints.push([time, this.odom])
            while (this.evaluationPoints.length > maxEvaluationPoints) {
                this.evaluationPoints.shift()
            }

            if (distance(this.odom, this.targetWaypoint) < this.closeEnoughToWaypoint) {
                this.mode = "idle"
                this.pubsub.publish('waypoint_reached', { waypoint: this.targetWaypoint })
                this.targetWaypoint = null
                this.pubsub.publish('logJson', {
                    plannerMode: this.mode,
                    plannerProgress: 0
                })
            }
            
            // evaluate if getting stuck
            if (this.targetWaypoint && this.evaluationPoints.length > 1) {
                let [ oldestEvalPositionTime, oldestEvalPosition ] = this.evaluationPoints.at(0)
                let [ newestEvalPositionTime, newestEvalPosition ] = this.evaluationPoints.at(-1)
                const changeInDistance = distance(oldestEvalPosition, this.targetWaypoint) - distance(newestEvalPosition, this.targetWaypoint)
                const changeInTime = newestEvalPositionTime - oldestEvalPositionTime
                this.progress = changeInDistance / changeInTime
                
                if (changeInDistance >= this.minimumDistanceThatIsProgress) {
                    this.timeOfLastMeaningfulProgress = time
                }
                
                const timeSinceMeaningfulProgress = time - this.timeOfLastMeaningfulProgress
                this.pubsub.publish('logJson', {
                    stallTime: timeSinceMeaningfulProgress.toFixed(0),
                })
                // enable random mode if no progress is being made for a while
                if (timeSinceMeaningfulProgress > this.timeBeforeRandomMove) {
                    this.activateRandomMode()
                    return
                } else if (this.mode === "random") {
                    // check if distance or time limit hit
                    const timeLimitHit = (time - this.randomSwitchTime) > this.randomMoveTime
                    const distanceLimitHit = distance(this.randomSwitchOdom, this.odom) > this.randomMoveDistance
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
                // Calculate target angle to waypoint
                const targetAngle = Math.atan2(this.targetWaypoint.y - this.odom.y, this.targetWaypoint.x - this.odom.x)
                // Calculate angular difference (shortest rotation) from current heading to target
                const angularVelocity = angleDifference(this.odom.heading, targetAngle)
                this.pubsub.publish('movement', { linearVelocity: this.movementSpeed, angularVelocity })
                this.pubsub.publish('logJson', {
                    plannerMode: this.mode,
                    plannerProgress: this.progress ? this.progress.toFixed(0) : 0
                })
            }
        });
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
        this.randomSwitchTime = this.getTime()
        this.randomSwitchOdom = this.odom
        const randomTargetAngle = Math.random() * 2 * Math.PI;
        const angularVelocity = angleDifference(this.odom.heading, randomTargetAngle)
        this.pubsub.publish('movement', { linearVelocity: this.movementSpeed, angularVelocity });
        this.pubsub.publish('logJson', {
            plannerMode: this.mode,
            plannerProgress: 0
        })
    }
}
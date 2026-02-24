import { vecDistance as distance, vecSub, angleDifference } from "../../tooling/math_helpers.js";
import { timer } from "../../tooling/time.js";

export const info = {
    inputs: ["odom", "targetWaypoint"],
    outputs: ["movement", "waypointReached", "logJson"],
}
export function createLocalPlanner({
    minimumDistanceThatIsProgress = 0.1,
    closeEnoughToWaypoint = 0.1,
    timeBeforeRandomMove = 3 /* timesteps: (roughly seconds) */,
    randomMoveDistance = 45 /* map units, robot is 26 units long */,
    randomMoveTime = 2 /* timesteps: (roughly seconds) */,
    maxEvaluationPoints = 10,
    movementSpeed = 150,
    angularGain = 20, // Gain factor to make turning faster
    maxAngularVelocity = 10 * Math.PI, // ~31.4 rad/s (matches simulator cap)
}) {
    const initialArg = Object.freeze({
        updated: {
            time: false,
            odom: false,
            targetWaypoint: false,
        },
        state: {
            time: null,
            odom: null,
            targetWaypoint: null,
            prevOdom: null,
            prevTargetWaypoint: null,
            mode: "idle",
            randomTargetAngle: null,
            progress: null,
            decisionTimer: null,
            evaluationPoints: [],  // [  [time, odom], [laterTime, odom] ] 
        },
        outputs: {
            movement: null,
            waypointReached: null,
            logJson: null,
        }
    })
    function update(getTime, { state, updated }) {
        const { time, odom, targetWaypoint } = state
        const outputs = { logJson: {}}
        state = { ...state }
        // keep state.targetWaypoint up to date
        if (updated.targetWaypoint) {
            if (JSON.stringify(state.prevTargetWaypoint) === JSON.stringify(state.targetWaypoint)) {
                console.warn("LocalPlanner: received same target waypoint twice. This is bad, only send a new target waypoint when the target changes")
            } else {
                state.prevTargetWaypoint = state.targetWaypoint
            }
        }

        // not enough data => idle
        if (state.targetWaypoint == null || state.odom == null) {
            state = {
                ...initialArg.state,
                mode: "idle",
            }
            return { state, outputs }
        }

        // switch to greedy mode from idle
        if (state.mode === "idle" && targetWaypoint) {
            state = {
                ...state,
                mode: "greedy",
                decisionTimer: timer({ duration: timeBeforeRandomMove, getTime, data: structuredClone(state) }),
            }
        }

        // always have a timer if somehow one was not provided
        if (state.decisionTimer == null) {
            state.decisionTimer = timer({ duration: timeBeforeRandomMove, getTime, data: structuredClone(state) })
        }

        // keep state.evaluationPoints in check
        state.evaluationPoints.push([time, state.odom])
        while (state.evaluationPoints.length > maxEvaluationPoints) {
            state.evaluationPoints.shift()
        }

        // got to point => idle
        if (distance(state.odom, state.targetWaypoint) < closeEnoughToWaypoint) {
            return {
                state: initialArg.state,
                outputs: {
                    waypointReached: { waypoint: state.targetWaypoint },
                    logJson: {
                        localPlanner: `reached point (idle)`,
                    },
                }
            }
        }
        
        // if there are enough points
        if (state.evaluationPoints.length > 1) {
            let [oldestEvalPositionTime, oldestEvalPosition] = state.evaluationPoints.at(0)
            let [newestEvalPositionTime, newestEvalPosition] = state.evaluationPoints.at(-1)
            const changeInDistance = distance(oldestEvalPosition, state.targetWaypoint) - distance(newestEvalPosition, state.targetWaypoint)
            const changeInTime = newestEvalPositionTime - oldestEvalPositionTime
            state.progress = changeInDistance / changeInTime

            // delay timer every time there is progress
            if (changeInDistance >= minimumDistanceThatIsProgress) {
                state.decisionTimer = timer({ duration: timeBeforeRandomMove, getTime, data: structuredClone(state) })
            }
            outputs.logJson.stallTime = state.decisionTimer.count.toFixed(0)

            // switch to random mode
            if (state.mode != "random" && state.decisionTimer.done) {
                state.decisionTimer = timer({ duration: timeBeforeRandomMove, getTime, data: structuredClone(state) })
                state.mode = "random"
                state.randomTargetAngle = Math.random() * 2 * Math.PI
                const angularVelocity = angleDifference(odom.heading, state.randomTargetAngle)
                outputs.movement = { linearVelocity: movementSpeed, angularVelocity: angleDifference(odom.heading, state.randomTargetAngle) }
                outputs.logJson.localPlanner = `no progress for ${state.decisionTimer.count.toFixed(0)}s, switching to random mode`
            }

            if (state.mode === "random") {
                // try to move in the pre-selected random direction
                const rawAngularDiff = angleDifference(state.odom.heading, state.randomTargetAngle)
                const angularVelocity = Math.sign(rawAngularDiff) * Math.min(Math.abs(rawAngularDiff) * angularGain, maxAngularVelocity)
                outputs.movement = { linearVelocity: movementSpeed, angularVelocity }

                // check if distance or time limit hit
                const distanceLimitHit = distance(state.decisionTimer.atStart.prevOdom, state.odom) > randomMoveDistance
                if (distanceLimitHit) {
                    // go back to greedy
                    state = {
                        ...state,
                        mode: "greedy",
                        decisionTimer: timer({ duration: timeBeforeRandomMove, getTime, data: structuredClone(state) }),
                    }
                // if time limit hit, do a new random angle
                } else if (state.decisionTimer.done) {
                    state.randomTargetAngle = Math.random() * 2 * Math.PI;
                    const angularVelocity = angleDifference(state.odom.heading, state.randomTargetAngle)
                    state.decisionTimer = timer({ duration: timeBeforeRandomMove, getTime, data: structuredClone(state) })
                    outputs.movement = { linearVelocity: state.movementSpeed, angularVelocity }
                    outputs.logJson.localPlanner = `no progress for ${state.decisionTimer.count.toFixed(0)}s, re-shuffling`
                    return {state, outputs}
                }
            }

        }

        if (state.mode == "greedy" && state.targetWaypoint) {
            // Calculate target angle to waypoint
            const targetAngle = Math.atan2(state.targetWaypoint.y - state.odom.y, state.targetWaypoint.x - state.odom.x)
            // Calculate angular difference (shortest rotation) from current heading to target
            const rawAngularDiff = angleDifference(state.odom.heading, targetAngle)

            // Scale angular velocity - multiply by gain factor and cap at max
            // The difference is in radians, but we need rad/s as velocity
            const angularVelocity = Math.sign(rawAngularDiff) * Math.min(Math.abs(rawAngularDiff) * angularGain, maxAngularVelocity)
            outputs.movement = { linearVelocity: movementSpeed, angularVelocity }
            outputs.logJson.localPlanner = `going after waypoint (greedily)`
        }

        return {state, outputs}
    }
    return {
        initialArg,
        update,
    }
}
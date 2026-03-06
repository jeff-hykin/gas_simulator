import { vecDistance as distance, vecSub, angleDifference } from "../../tooling/math_helpers.js";
import { timer } from "../../tooling/time.js";

const info = {
    inputs: ["odom", "targetWaypoint"],
    outputs: ["movement", "waypointReached", "logJson"],
}
function create({
    minimumDistanceThatIsProgress = 0.1,
    closeEnoughToWaypoint = 0.1,
    timeBeforeRandomMove = 3 /* timesteps: (roughly seconds) */,
    randomMoveDistance = 45 /* map units, robot is 26 units long */,
    randomMoveTime = 2 /* timesteps: (roughly seconds) */,
    maxEvaluationPoints = 10,
    movementSpeed = 3,        // map units per tick
    angularGain = 0.5,        // fraction of angular error corrected per tick (0-1 range)
    maxAngularVelocity = 0.5, // max radians per tick (~29°)
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
        console.log(`[LP] update called. mode=${state.mode} updated=${JSON.stringify(updated)} odom=${state.odom ? `(${state.odom.x.toFixed(1)},${state.odom.y.toFixed(1)},h=${state.odom.heading.toFixed(2)})` : 'null'} target=${state.targetWaypoint ? `(${state.targetWaypoint.x.toFixed(1)},${state.targetWaypoint.y.toFixed(1)})` : 'null'}`)
        // keep state.targetWaypoint up to date
        if (updated.targetWaypoint) {
            if (JSON.stringify(state.prevTargetWaypoint) === JSON.stringify(state.targetWaypoint)) {
                console.warn("LocalPlanner: received same target waypoint twice. This is bad, only send a new target waypoint when the target changes")
            } else {
                state.prevTargetWaypoint = state.targetWaypoint
            }
        }

        // not enough data => idle (preserve received inputs so they accumulate)
        if (state.targetWaypoint == null || state.odom == null) {
            return { state, outputs: initialArg.outputs }
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

            console.log(`[LP-EVAL] changeInDist=${changeInDistance.toFixed(2)} changeInTime=${changeInTime.toFixed(2)} progress=${state.progress.toFixed(2)} timerDone=${state.decisionTimer.done}`)
            // switch to random mode
            if (state.mode != "random" && state.decisionTimer.done) {
                state.prevOdom = state.odom  // snapshot position at start of random move (used for distance limit check)
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
            const dist = distance(state.odom, state.targetWaypoint)
            console.log(`[LP-GREEDY] heading=${state.odom.heading.toFixed(2)}rad targetAngle=${targetAngle.toFixed(2)}rad rawAngDiff=${rawAngularDiff.toFixed(2)} angVel=${angularVelocity.toFixed(2)} linVel=${movementSpeed} dist=${dist.toFixed(1)}`)
            outputs.logJson.localPlanner = `going after waypoint (greedily)`
        }

        return {state, outputs}
    }
    return { initialArg, info, update }
}

export default { info, create }
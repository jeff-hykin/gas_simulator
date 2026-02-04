import { vecDistance, vecSub, angleDifference } from "./math_helpers.js";

/**
 * Create a local planner that listens for target waypoints and publishes movement commands.
 * Fully autonomous - subscribes to 'target_waypoint' and 'odom', publishes 'movement' and 'waypoint_reached'.
 *
 * @param {object} pubsub - pub/sub instance with subscribe/publish
 * @param {object} [config]
 * @param {number} [config.maxLinearVelocity=100] meters/second
 * @param {number} [config.maxAngularVelocity=10*Math.PI] radians/second
 * @param {number} [config.waypointThreshold=10] meters
 * @param {number} [config.minAlignment=0.5] 0-1
 */
export function createLocalPlanner(pubsub, config = {}) {
    const maxLinearVelocity = config.maxLinearVelocity ?? 100;
    const maxAngularVelocity = config.maxAngularVelocity ?? 10 * Math.PI;
    const waypointThreshold = config.waypointThreshold ?? 10;
    const minAlignment = config.minAlignment ?? 0.5;
    const stuckThreshold = config.stuckThreshold ?? 30; // Ticks without progress before random movement
    const randomMoveDistance = config.randomMoveDistance ?? 40; // Max distance for random movement
    const progressThreshold = config.progressThreshold ?? 2.0; // Minimum distance improvement to count as progress

    let currentPose = { x: 0, y: 0, heading: 0 };
    let targetWaypoint = null;
    let lastDistanceToGoal = Infinity;
    let ticksWithoutProgress = 0;
    let bestDistance = Infinity;

    // Random movement state
    let randomMode = false;
    let randomTarget = null;
    let randomStartDistance = 0;

    // Subscribe to odometry updates
    pubsub.subscribe('odom', (data, publisher) => {
        currentPose = { x: data.x, y: data.y, heading: data.heading };

        // If we have a target, plan movement
        if (targetWaypoint) {
            planAndPublish();
        }
    });

    // Subscribe to target waypoint updates
    pubsub.subscribe('target_waypoint', (data, publisher) => {
        targetWaypoint = { x: data.x, y: data.y };
        lastDistanceToGoal = vecDistance(currentPose, targetWaypoint);
        bestDistance = lastDistanceToGoal;
        ticksWithoutProgress = 0;
        randomMode = false;
        randomTarget = null;

        // Immediately plan movement to new target
        planAndPublish();
    });

    function planAndPublish() {
        if (!targetWaypoint) return;

        const currentDistance = vecDistance(currentPose, targetWaypoint);

        // Check if reached main waypoint
        if (currentDistance < waypointThreshold) {
            pubsub.publish('waypoint_reached', { waypoint: targetWaypoint });
            targetWaypoint = null;
            randomMode = false;
            randomTarget = null;
            pubsub.publish('movement', { linearVelocity: 0, angularVelocity: 0 });
            pubsub.publish('logJson', { plannerMode: 'idle', plannerProgress: 0 });
            return;
        }

        // Track progress towards waypoint (only count substantial improvements)
        const improvement = bestDistance - currentDistance;
        if (improvement > progressThreshold) {
            bestDistance = currentDistance;
            ticksWithoutProgress = 0;
        } else {
            ticksWithoutProgress++;
        }

        // Enter random mode if stuck
        if (!randomMode && ticksWithoutProgress > stuckThreshold) {
            console.log(`LocalPlanner: stuck for ${ticksWithoutProgress} ticks, entering random movement`);
            randomMode = true;
            ticksWithoutProgress = 0;
            bestDistance = currentDistance;

            // Pick random angle and distance
            const randomAngle = Math.random() * 2 * Math.PI;
            const randomDist = Math.random() * randomMoveDistance;
            randomTarget = {
                x: currentPose.x + Math.cos(randomAngle) * randomDist,
                y: currentPose.y + Math.sin(randomAngle) * randomDist
            };
            randomStartDistance = vecDistance(currentPose, randomTarget);
            pubsub.publish('logJson', { plannerMode: 'random', plannerProgress: 0 });
        }

        // Execute random movement
        if (randomMode && randomTarget) {
            const distToRandom = vecDistance(currentPose, randomTarget);
            const randomProgress = 1 - (distToRandom / randomStartDistance);

            // Exit random mode if close to random target or made good progress
            if (distToRandom < 5 || randomProgress > 0.8) {
                console.log('LocalPlanner: random movement complete, returning to waypoint');
                randomMode = false;
                randomTarget = null;
                bestDistance = currentDistance;
                ticksWithoutProgress = 0;
                pubsub.publish('logJson', { plannerMode: 'waypoint', plannerProgress: 0 });
            } else {
                // Navigate to random target
                const diff = vecSub(randomTarget, currentPose);
                const targetAngle = Math.atan2(diff.y, diff.x);
                let angularVelocity = angleDifference(currentPose.heading, targetAngle);
                if (Math.abs(angularVelocity) > maxAngularVelocity) {
                    angularVelocity = Math.sign(angularVelocity) * maxAngularVelocity;
                }

                const alignmentError = Math.abs(angleDifference(currentPose.heading, targetAngle));
                const alignment = 1 - (alignmentError / Math.PI);
                const linearVelocity = alignment > 0.75 ? maxLinearVelocity : 0;

                pubsub.publish('movement', { linearVelocity, angularVelocity });
                pubsub.publish('logJson', { plannerMode: 'random', plannerProgress: randomProgress.toFixed(2) });
                return;
            }
        }

        // Normal waypoint navigation
        const diff = vecSub(targetWaypoint, currentPose);
        const targetAngle = Math.atan2(diff.y, diff.x);
        let angularVelocity = angleDifference(currentPose.heading, targetAngle);

        // Clamp angular velocity
        if (Math.abs(angularVelocity) > maxAngularVelocity) {
            angularVelocity = Math.sign(angularVelocity) * maxAngularVelocity;
        }

        // Calculate alignment
        const alignmentError = Math.abs(angleDifference(currentPose.heading, targetAngle));
        const alignment = 1 - (alignmentError / Math.PI);

        let linearVelocity = 0;

        // If very poorly aligned (>45 degrees off), stop and just turn
        if (alignment < 0.75) {
            linearVelocity = 0;
        }
        // If moderately aligned, move slowly
        else if (alignment < minAlignment) {
            linearVelocity = maxLinearVelocity * 0.3;
        }
        // Move at full speed when well aligned
        else {
            linearVelocity = maxLinearVelocity;
        }

        const waypointProgress = 1 - (currentDistance / lastDistanceToGoal);
        lastDistanceToGoal = currentDistance;

        pubsub.publish('movement', { linearVelocity, angularVelocity });
        pubsub.publish('logJson', {
            plannerMode: 'waypoint',
            plannerProgress: waypointProgress.toFixed(2),
            plannerStuck: ticksWithoutProgress
        });
    }
}

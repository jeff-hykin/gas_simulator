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

    let currentPose = { x: 0, y: 0, heading: 0 };
    let targetWaypoint = null;
    let lastDistanceToGoal = Infinity;

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

        // Immediately plan movement to new target
        planAndPublish();
    });

    function planAndPublish() {
        if (!targetWaypoint) return;

        const currentDistance = vecDistance(currentPose, targetWaypoint);
        const progress = lastDistanceToGoal - currentDistance;
        lastDistanceToGoal = currentDistance;

        // Check if reached
        if (currentDistance < waypointThreshold) {
            pubsub.publish('waypoint_reached', { waypoint: targetWaypoint });
            targetWaypoint = null;
            // Stop moving
            pubsub.publish('movement', { linearVelocity: 0, angularVelocity: 0 });
            return;
        }

        // Calculate desired heading
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

        // If moving away, stop and turn
        if (progress < -0.1) {
            linearVelocity = 0;
        }
        // If poorly aligned, slow down
        else if (alignment < minAlignment) {
            linearVelocity = maxLinearVelocity * alignment * 0.5;
        }
        // Move at full speed
        else {
            linearVelocity = maxLinearVelocity;
        }

        pubsub.publish('movement', { linearVelocity, angularVelocity });
    }
}

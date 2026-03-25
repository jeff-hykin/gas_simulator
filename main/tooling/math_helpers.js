/**
 * Pure vector and geometry utilities for the gas agent.
 * All vectors are plain {x, y} objects.
 */

/**
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {{x:number,y:number}}
 * @example vecAdd({x:1,y:2},{x:3,y:4}) // {x:4,y:6}
 */
export function vecAdd(a, b) {
    return { x: a.x + b.x, y: a.y + b.y }
}

/**
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {{x:number,y:number}}
 * @example vecSub({x:3,y:4},{x:1,y:1}) // {x:2,y:3}
 */
export function vecSub(a, b) {
    return { x: a.x - b.x, y: a.y - b.y }
}

/**
 * @param {{x:number,y:number}} v
 * @param {number} s
 * @returns {{x:number,y:number}}
 * @example vecScale({x:2,y:3}, 2) // {x:4,y:6}
 */
export function vecScale(v, s) {
    return { x: v.x * s, y: v.y * s }
}

/**
 * @param {{x:number,y:number}} v
 * @returns {number}
 * @example vecMagnitude({x:3,y:4}) // 5
 */
export function vecMagnitude(v) {
    return Math.sqrt(v.x * v.x + v.y * v.y)
}

/**
 * Returns a unit vector, or {x:0,y:0} if magnitude is ~0.
 * @param {{x:number,y:number}} v
 * @returns {{x:number,y:number}}
 * @example vecNormalize({x:0,y:5}) // {x:0,y:1}
 */
export function vecNormalize(v) {
    const m = vecMagnitude(v)
    if (m < 1e-12) return { x: 0, y: 0 }
    return { x: v.x / m, y: v.y / m }
}

/**
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {number}
 * @example vecDistance({x:0,y:0},{x:3,y:4}) // 5
 */
export function vecDistance(a, b) {
    return vecMagnitude(vecSub(a, b))
}

/**
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {number}
 * @example vecDot({x:1,y:0},{x:0,y:1}) // 0
 */
export function vecDot(a, b) {
    return a.x * b.x + a.y * b.y
}

/**
 * 2D cross product (scalar).
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {number}
 * @example vecCross({x:1,y:0},{x:0,y:1}) // 1
 */
export function vecCross(a, b) {
    return a.x * b.y - a.y * b.x
}

/**
 * Rotate a vector by an angle (radians, counter-clockwise).
 * @param {{x:number,y:number}} v
 * @param {number} angle
 * @returns {{x:number,y:number}}
 * @example vecRotate({x:1,y:0}, Math.PI/2) // ≈ {x:0, y:1}
 */
export function vecRotate(v, angle) {
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }
}

/**
 * Shortest signed angle from `current` to `target` (radians), in [-PI, PI].
 * Positive = counter-clockwise.
 * @param {number} current
 * @param {number} target
 * @returns {number}
 * @example angleDifference(0, Math.PI/2) // Math.PI/2
 * @example angleDifference(0, -Math.PI/2) // -Math.PI/2
 */
export function angleDifference(current, target) {
    let d = target - current
    d = ((d % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI
    return d
}

/**
 * Slope of least-squares linear regression on [{x, y}] points.
 * Returns 0 if fewer than 2 points or zero variance in x.
 * @param {{x:number,y:number}[]} points
 * @returns {number}
 * @example linearRegressionSlope([{x:0,y:0},{x:1,y:2},{x:2,y:4}]) // 2
 */
export function linearRegressionSlope(points) {
    const n = points.length
    if (n < 2) return 0
    let sx = 0, sy = 0, sxy = 0, sxx = 0
    for (const p of points) {
        sx += p.x
        sy += p.y
        sxy += p.x * p.y
        sxx += p.x * p.x
    }
    const denom = n * sxx - sx * sx
    if (Math.abs(denom) < 1e-15) return 0
    return (n * sxy - sx * sy) / denom
}

/**
 * Fit a plane value = a*x + b*y + c to [{x, y, value}] and return the
 * normalized gradient direction {x, y}. Returns {x:0,y:0} if < 3 points.
 * @param {{x:number,y:number,value:number}[]} points
 * @returns {{x:number,y:number}}
 * @example fitGradient2D([{x:0,y:0,value:1},{x:1,y:0,value:3},{x:0,y:1,value:2}])
 *   // normalized direction ≈ {x:0.894, y:0.447}
 */
export function fitGradient2D(points) {
    const n = points.length
    if (n < 3) return { x: 0, y: 0 }

    // Least squares for value = a*x + b*y + c
    // Normal equations: [sum(xi^2) sum(xi*yi) sum(xi)] [a]   [sum(xi*vi)]
    //                   [sum(xi*yi) sum(yi^2) sum(yi)] [b] = [sum(yi*vi)]
    //                   [sum(xi)    sum(yi)   n      ] [c]   [sum(vi)   ]
    let sx = 0, sy = 0, sv = 0
    let sxx = 0, syy = 0, sxy = 0, sxv = 0, syv = 0
    for (const p of points) {
        sx += p.x; sy += p.y; sv += p.value
        sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y
        sxv += p.x * p.value; syv += p.y * p.value
    }

    // Solve 3x3 system via Cramer's rule
    // | sxx sxy sx | |a|   |sxv|
    // | sxy syy sy | |b| = |syv|
    // | sx  sy  n  | |c|   |sv |
    const det = sxx * (syy * n - sy * sy)
              - sxy * (sxy * n - sy * sx)
              + sx  * (sxy * sy - syy * sx)
    if (Math.abs(det) < 1e-15) return { x: 0, y: 0 }

    const a = (sxv * (syy * n - sy * sy)
             - sxy * (syv * n - sy * sv)
             + sx  * (syv * sy - syy * sv)) / det
    const b = (sxx * (syv * n - sy * sv)
             - sxv * (sxy * n - sy * sx)
             + sx  * (sxy * sv - syv * sx)) / det

    return vecNormalize({ x: a, y: b })
}

/**
 * Generate waypoints evenly spaced around a circle.
 * @param {{x:number,y:number}} center
 * @param {number} radius
 * @param {number} count
 * @param {number} startAngle - angle (radians) of first waypoint from center
 * @param {boolean} clockwise
 * @returns {{x:number,y:number}[]}
 * @example circleWaypoints({x:0,y:0}, 5, 4, 0, false)
 *   // [{x:5,y:0}, {x:0,y:5}, {x:-5,y:0}, {x:0,y:-5}]
 */
export function circleWaypoints(center, radius, count, startAngle, clockwise) {
    const step = (2 * Math.PI) / count * (clockwise ? -1 : 1)
    const points = []
    for (let i = 0; i < count; i++) {
        const angle = startAngle + step * i
        points.push({
            x: center.x + radius * Math.cos(angle),
            y: center.y + radius * Math.sin(angle),
        })
    }
    return points
}

/**
 * Nearest point on segment AB to point P.
 * @param {{x:number,y:number}} p
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {{x:number,y:number}}
 * @example nearestPointOnSegment({x:1,y:1},{x:0,y:0},{x:2,y:0}) // {x:1,y:0}
 */
export function nearestPointOnSegment(p, a, b) {
    const ab = vecSub(b, a)
    const len2 = vecDot(ab, ab)
    if (len2 < 1e-15) return { x: a.x, y: a.y }
    const t = Math.max(0, Math.min(1, vecDot(vecSub(p, a), ab) / len2))
    return vecAdd(a, vecScale(ab, t))
}

/**
 * Nearest point on a polyline (sequence of segments) to point P.
 * @param {{x:number,y:number}} p
 * @param {{x:number,y:number}[]} polyline
 * @returns {{x:number,y:number}}
 * @example nearestPointOnPolyline({x:5,y:5},[{x:0,y:0},{x:10,y:0}]) // {x:5,y:0}
 */
export function nearestPointOnPolyline(p, polyline) {
    if (polyline.length === 0) return { x: p.x, y: p.y }
    if (polyline.length === 1) return { x: polyline[0].x, y: polyline[0].y }
    let best = null
    let bestDist = Infinity
    for (let i = 0; i < polyline.length - 1; i++) {
        const candidate = nearestPointOnSegment(p, polyline[i], polyline[i + 1])
        const d = vecDistance(p, candidate)
        if (d < bestDist) {
            bestDist = d
            best = candidate
        }
    }
    return best
}

/**
 * Returns -1 (turn left) or 1 (turn right) to indicate the shortest turn
 * that would face the agent away from the nearest point on the route.
 *
 * "Away from the route" means perpendicular to the closest line segment,
 * on the side the agent is already on.
 *
 * @param {object} args
 * @param {{x:number, y:number}} args.location  - agent position
 * @param {number} args.heading                 - agent heading in radians
 * @param {{x:number, y:number}[]} args.route   - array of waypoints forming a polyline
 * @returns {number} -1 for left, 1 for right
 *
 * @example
 *   // agent at (5,5), heading east (0 rad), route along x-axis
 *   awayFromRoute({location:{x:5,y:5}, heading:0, route:[{x:0,y:0},{x:10,y:0}]}) // -1 (turn left, toward +y)
 */
export function awayFromRoute({ location, heading, route }) {
    if (!route || route.length < 2) return 1

    // 1. Find the closest segment and the nearest point on it
    let bestDist = Infinity
    let bestSegA = null
    let bestSegB = null
    let bestPoint = null
    for (let i = 0; i < route.length - 1; i++) {
        const candidate = nearestPointOnSegment(location, route[i], route[i + 1])
        const d = vecDistance(location, candidate)
        if (d < bestDist) {
            bestDist = d
            bestPoint = candidate
            bestSegA = route[i]
            bestSegB = route[i + 1]
        }
    }

    // 2. Compute the segment direction and the perpendicular pointing away
    const segDir = vecSub(bestSegB, bestSegA)
    const toAgent = vecSub(location, bestPoint)

    // If agent is essentially on the segment, pick perpendicular based on
    // which side a small nudge in the current heading would place it
    let awayDir
    if (vecMagnitude(toAgent) < 1e-6) {
        // Use heading to pick a side: project heading onto segment normal
        const headingVec = { x: Math.cos(heading), y: Math.sin(heading) }
        // Two perpendiculars: (-segDir.y, segDir.x) and (segDir.y, -segDir.x)
        const perpA = { x: -segDir.y, y: segDir.x }
        awayDir = vecDot(headingVec, perpA) >= 0 ? perpA : { x: segDir.y, y: -segDir.x }
    } else {
        awayDir = toAgent
    }

    // 3. Angle of the "away" direction
    const awayAngle = Math.atan2(awayDir.y, awayDir.x)

    // 4. Shortest signed angle from current heading to awayAngle
    const diff = angleDifference(heading, awayAngle)

    // diff > 0 means counter-clockwise (left), diff < 0 means clockwise (right)
    return diff >= 0 ? -1 : 1
}

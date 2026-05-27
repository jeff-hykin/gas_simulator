#!/usr/bin/env -S deno run -A

import { parse as parseYaml } from 'https://deno.land/std@0.224.0/yaml/mod.ts'
import { parseArgs } from 'https://deno.land/std@0.224.0/cli/parse_args.ts'
import { basename, fromFileUrl, join } from 'https://deno.land/std@0.224.0/path/mod.ts'
import {
  createRobot,
  maxGasAt,
  moveWithAvoidance,
  isCircleInAnyObstacle,
  gaussianNoise,
} from '../main/systems/simulator.js'
import { createPubSub, connectNeoAgent } from '../main/tooling/pubsub.js'
import localPlannerAgent from '../main/agents/neo/local_planner.js'
import { vecDistance } from '../main/tooling/math_helpers.js'

const REPO_ROOT = fromFileUrl(new URL('..', import.meta.url))
const MAPS_DIR = join(REPO_ROOT, 'maps')

// ── PRNG: mulberry32 ────────────────────────────────────────────────
function mulberry32(seed) {
    let s = seed >>> 0
    return function () {
        s = (s + 0x6d2b79f5) >>> 0
        let t = s
        t = Math.imul(t ^ (t >>> 15), 1 | t)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

// ── Map loading ─────────────────────────────────────────────────────
async function loadMaps() {
    const EVAL_MAPS = ['train_real.yaml', 'pipeline_break.yaml', 'chemical_plant.yaml']
    const files = []
    for await (const entry of Deno.readDir(MAPS_DIR)) {
        if (!entry.isFile) continue
        if (!EVAL_MAPS.includes(entry.name)) continue
        files.push(entry.name)
    }
    files.sort()
    const maps = []
    for (const name of files) {
        const text = await Deno.readTextFile(join(MAPS_DIR, name))
        const data = parseYaml(text) || {}
        const hasRoute = (data.routes || []).some(r => (r.points || []).length >= 2)
        if (!hasRoute) {
            console.warn(`Skipping ${name}: no route with ≥2 points`)
            continue
        }
        maps.push({ name, data })
    }
    if (maps.length === 0) throw new Error('No maps with routes found')
    return maps
}

function computeBounds(mapData) {
    const xs = [], ys = []
    for (const o of mapData.obstacles || []) {
        xs.push(o.x - o.w / 2, o.x + o.w / 2)
        ys.push(o.y - o.h / 2, o.y + o.h / 2)
    }
    for (const m of mapData.markers || []) { xs.push(m.x); ys.push(m.y) }
    for (const r of mapData.routes || []) {
        for (const p of (r.points || [])) { xs.push(p.x); ys.push(p.y) }
    }
    if (xs.length === 0) return { minX: -500, maxX: 500, minY: -500, maxY: 500 }
    return {
        minX: Math.min(...xs), maxX: Math.max(...xs),
        minY: Math.min(...ys), maxY: Math.max(...ys),
    }
}

function pickStartPosition(mapData) {
    const markers = mapData.markers || []
    const labeled = markers.find(m => /start/i.test(m.label || ''))
    const chosen = labeled || markers[0]
    if (!chosen) return { x: 0, y: 0 }
    return { x: chosen.x, y: chosen.y }
}

// ── Scenario generation ─────────────────────────────────────────────
function generateScenarios({ maps, count, seed }) {
    const rng = mulberry32(seed)
    const scenarios = []
    for (let i = 0; i < count; i++) {
        const map = maps[Math.floor(rng() * maps.length)]
        const bounds = computeBounds(map.data)
        const start = pickStartPosition(map.data)
        const obstacles = map.data.obstacles || []

        let gasPosition = null
        for (let attempt = 0; attempt < 200; attempt++) {
            const x = bounds.minX + rng() * (bounds.maxX - bounds.minX)
            const y = bounds.minY + rng() * (bounds.maxY - bounds.minY)
            const cand = { x, y }
            if (isCircleInAnyObstacle(cand, 10, obstacles)) continue
            if (vecDistance(cand, start) < 100) continue
            gasPosition = cand
            break
        }
        if (!gasPosition) {
            gasPosition = {
                x: bounds.minX + rng() * (bounds.maxX - bounds.minX),
                y: bounds.minY + rng() * (bounds.maxY - bounds.minY),
            }
        }

        const startAngleDeg = rng() * 360
        scenarios.push({
            mapName: map.name,
            mapData: map.data,
            gasPosition,
            start,
            startAngleDeg,
        })
    }
    return scenarios
}

// ── Headless simulation ─────────────────────────────────────────────
function runScenario({ agentModule, scenario, config }) {
    const { mapData, gasPosition, start, startAngleDeg } = scenario
    const obstacles = mapData.obstacles || []
    const routePoints = (mapData.routes?.[0]?.points) || []
    const gasNodes = [{
        id: 'eval-gas',
        x: gasPosition.x,
        y: gasPosition.y,
        radius: config.gasRadius,
        peak: config.gasPeak,
        gasCircleRate: config.gasCircleRate || 'gaussian',
    }]

    const robot = createRobot({
        x: start.x,
        y: start.y,
        w: 16,
        h: 10,
        angle: startAngleDeg,
    })

    const pubsub = createPubSub()
    let virtualTime = 0
    const getTime = () => virtualTime

    // Bridges (mirror simulator.startAgentLoop)
    pubsub.subscribe('odom', (data) => pubsub.publish('position', data))
    pubsub.subscribe('gas_reading', (data) => pubsub.publish('gasReading', data.ppm))
    pubsub.subscribe('max_gas_reading', (data) => pubsub.publish('maxGasReading', data.ppm))
    pubsub.subscribe('route_update', (data) => pubsub.publish('routeUpdate', data))

    // Movement sink
    let movementPending = null
    pubsub.subscribe('movement', (data) => { movementPending = data })

    // Route-progress tracking via simple_route_agent's logJson.
    //   - waypoint "N/M" → agent is currently *working on* the N-th waypoint (1-indexed),
    //     so (N-1) waypoints have been reached-or-skipped at that point. Each increment
    //     of N represents one "advance" (a reach or a skip).
    //   - routeDone: true → fires once when simple_route_agent has advanced PAST the last
    //     waypoint (reach or skip). Needed because a final blocked waypoint never produces
    //     a waypointReached event, so we can't detect completion from that channel alone.
    //
    // `routeAdvanceTimes` captures the virtual time of every advance (reach OR skip).
    // By comparing it with `routeHitTimes` (physical reaches only) the report can draw
    // a "skipped waypoints" curve as (advances − hits).
    let maxWaypointActive = 0
    let prevN = 0
    let firstWaypointEmission = true
    let routeDoneRecorded = false
    let timeToCompleteRoute = NaN
    const routeAdvanceTimes = []
    pubsub.subscribe('logJson', (data) => {
        if (!data) return
        if (typeof data.waypoint === 'string') {
            const m = data.waypoint.match(/^(\d+)\/(\d+)$/)
            if (m) {
                const n = parseInt(m[1], 10)
                if (n > prevN) {
                    if (firstWaypointEmission) {
                        // First emission: currentWaypointIndex just became 0, no advance yet.
                        firstWaypointEmission = false
                    } else {
                        for (let k = prevN; k < n; k++) routeAdvanceTimes.push(virtualTime)
                    }
                    prevN = n
                    if (n > maxWaypointActive) maxWaypointActive = n
                }
            }
        }
        if (data.routeDone === true && !routeDoneRecorded) {
            routeDoneRecorded = true
            // routeDone fires once, when currentWaypointIndex passes the final waypoint.
            // That's one final advance not otherwise visible via "N/M" changes.
            routeAdvanceTimes.push(virtualTime)
            if (Number.isNaN(timeToCompleteRoute)) timeToCompleteRoute = virtualTime
        }
    })

    // Physical waypoint-reach tracking (distinct from skipping).
    // Matches against the *original* route coordinates so gas-follow waypoints don't count.
    // Also records the virtual time at each hit so we can build arrival-pace charts later.
    const routeWaypointKey = new Set(routePoints.map(p => `${p.x},${p.y}`))
    let routeWaypointsHit = 0
    const routeHitTimes = []
    pubsub.subscribe('waypointReached', (data) => {
        if (!data || !data.waypoint) return
        const key = `${data.waypoint.x},${data.waypoint.y}`
        if (routeWaypointKey.has(key)) {
            routeWaypointsHit++
            routeHitTimes.push(virtualTime)
        }
    })

    // Silence agent console noise for eval
    const realLog = console.log
    const realWarn = console.warn
    if (!config.verbose) {
        console.log = () => {}
        console.warn = () => {}
    }

    let crashError = null
    try {
        // Connect agent under test
        const agent = agentModule.default.create({})
        connectNeoAgent(pubsub, agent, getTime)

        // Connect local planner (same default threshold as simulator.js)
        const planner = localPlannerAgent.create({ closeEnoughToWaypoint: 10 })
        connectNeoAgent(pubsub, planner, getTime)

        // Kick off: publish route first, then initial odom
        pubsub.publish('route_update', { waypoints: routePoints })
        pubsub.publish('odom', {
            x: robot.x,
            y: robot.y,
            heading: robot.angle * (Math.PI / 180),
        })

        // Metrics accumulators
        let minDistance = vecDistance(robot, gasPosition)
        let sumDistanceToGas = 0
        let tickCount = 0
        let totalDistanceTraveled = 0
        let maxGasPpm = 0
        let timeToFirstWithin50 = NaN
        let prevX = robot.x, prevY = robot.y

        const maxLinearVelocity = 20
        const maxAngularVelocity = Math.PI
        const dt = config.decisionRate
        const maxTicks = Math.ceil(config.maxSeconds / dt)

        for (let tick = 0; tick < maxTicks; tick++) {
            virtualTime += dt

            // Publish gas readings (mirror simulator tick order: gas first, then time+odom)
            const gas = maxGasAt(robot, gasNodes)
            const noiseStdDev = config.gasNoiseStdDev ?? 0
            const noisyGas = Math.max(0, gas + gaussianNoise(noiseStdDev))
            pubsub.publish('gas_reading', { ppm: noisyGas })
            maxGasPpm = Math.max(maxGasPpm, noisyGas)
            pubsub.publish('max_gas_reading', { ppm: maxGasPpm })

            pubsub.publish('time', { virtualTime })
            pubsub.publish('odom', {
                x: robot.x,
                y: robot.y,
                heading: robot.angle * (Math.PI / 180),
            })

            // Apply any pending movement command
            if (movementPending) {
                const lin = Math.max(-maxLinearVelocity, Math.min(movementPending.linearVelocity ?? 0, maxLinearVelocity))
                const ang = Math.max(-maxAngularVelocity, Math.min(movementPending.angularVelocity ?? 0, maxAngularVelocity))
                const angularDeg = ang * (180 / Math.PI)
                robot.angle = (robot.angle + angularDeg + 360) % 360
                moveWithAvoidance(robot, lin, obstacles)
                movementPending = null
            }

            // Sample metrics
            const d = vecDistance(robot, gasPosition)
            if (d < minDistance) minDistance = d
            sumDistanceToGas += d
            if (d < 50 && Number.isNaN(timeToFirstWithin50)) timeToFirstWithin50 = virtualTime
            const ddx = robot.x - prevX, ddy = robot.y - prevY
            totalDistanceTraveled += Math.hypot(ddx, ddy)
            prevX = robot.x
            prevY = robot.y
            tickCount++
        }

        console.log = realLog
        console.warn = realWarn

        return {
            minDistanceToGas: minDistance,
            finalDistanceToGas: vecDistance(robot, gasPosition),
            meanDistanceToGas: sumDistanceToGas / Math.max(1, tickCount),
            maxGasReading: maxGasPpm,
            totalDistanceTraveled,
            timeToFirstWithin50,
            routeCompletionFraction: routePoints.length > 0
                ? (Number.isFinite(timeToCompleteRoute) ? 1 : Math.max(0, maxWaypointActive - 1) / routePoints.length)
                : 1,
            routeWaypointsHit,
            routeWaypointsTotal: routePoints.length,
            routeHitTimes: routeHitTimes.slice(),
            routeAdvanceTimes: routeAdvanceTimes.slice(),
            waypointsHitPerMinute: (() => {
                const elapsed = Number.isFinite(timeToCompleteRoute) ? timeToCompleteRoute : config.maxSeconds
                return elapsed > 0 ? (routeWaypointsHit / elapsed) * 60 : 0
            })(),
            timeToCompleteRoute,
            crashed: false,
        }
    } catch (err) {
        console.log = realLog
        console.warn = realWarn
        crashError = err
        return {
            minDistanceToGas: NaN,
            finalDistanceToGas: NaN,
            meanDistanceToGas: NaN,
            maxGasReading: NaN,
            totalDistanceTraveled: NaN,
            timeToFirstWithin50: NaN,
            routeCompletionFraction: NaN,
            routeWaypointsHit: NaN,
            routeWaypointsTotal: NaN,
            routeHitTimes: [],
            routeAdvanceTimes: [],
            waypointsHitPerMinute: NaN,
            timeToCompleteRoute: NaN,
            crashed: true,
            error: err?.stack || String(err),
        }
    }
}

// ── Aggregation ─────────────────────────────────────────────────────
function mean(values) {
    const clean = values.filter(v => Number.isFinite(v))
    if (clean.length === 0) return NaN
    return clean.reduce((a, b) => a + b, 0) / clean.length
}
function stddev(values) {
    const clean = values.filter(v => Number.isFinite(v))
    if (clean.length < 2) return 0
    const m = mean(clean)
    const variance = clean.reduce((a, b) => a + (b - m) ** 2, 0) / (clean.length - 1)
    return Math.sqrt(variance)
}
function countDefined(values) {
    return values.filter(v => Number.isFinite(v)).length
}

function aggregate(runs) {
    const keys = [
        'minDistanceToGas',
        'finalDistanceToGas',
        'meanDistanceToGas',
        'maxGasReading',
        'totalDistanceTraveled',
        'timeToFirstWithin50',
        'routeCompletionFraction',
        'routeWaypointsHit',
        'waypointsHitPerMinute',
        'timeToCompleteRoute',
    ]
    const agg = {}
    for (const k of keys) {
        const vals = runs.map(r => r[k])
        agg[k] = {
            mean: mean(vals),
            std: stddev(vals),
            n: countDefined(vals),
            total: vals.length,
        }
    }
    agg.crashed = runs.filter(r => r.crashed).length
    return agg
}

// ── Table output ────────────────────────────────────────────────────
const METRIC_DEFS = [
    { key: 'minDistanceToGas',      label: 'min distance to gas',       lowerIsBetter: true,  fmt: 'fixed1' },
    { key: 'finalDistanceToGas',    label: 'final distance to gas',     lowerIsBetter: true,  fmt: 'fixed1' },
    { key: 'meanDistanceToGas',     label: 'mean distance to gas',      lowerIsBetter: true,  fmt: 'fixed1' },
    { key: 'maxGasReading',         label: 'peak gas reading (ppm)',    lowerIsBetter: false, fmt: 'fixed3' },
    { key: 'totalDistanceTraveled', label: 'total distance traveled',   lowerIsBetter: null,  fmt: 'fixed0' },
    { key: 'timeToCompleteRoute',   label: 'time to complete route',    lowerIsBetter: true,  fmt: 'timeHit' },
    { key: 'routeWaypointsHit',     label: 'route waypoints hit',       lowerIsBetter: false, fmt: 'fixed1' },
    { key: 'waypointsHitPerMinute', label: 'waypoints hit per minute',  lowerIsBetter: false, fmt: 'fixed2' },
    { key: 'timeToFirstWithin50',   label: 'time to first within 50',   lowerIsBetter: true,  fmt: 'timeHit' },
]

function formatValue(agg, fmt) {
    if (fmt === 'timeHit') {
        const hitCount = agg.n
        const total = agg.total
        if (hitCount === 0) return `never (0/${total})`
        return `${agg.mean.toFixed(1)}s (${hitCount}/${total})`
    }
    if (!Number.isFinite(agg.mean)) return 'NaN'
    const meanStr = fmt === 'fixed0' ? agg.mean.toFixed(0)
                  : fmt === 'fixed1' ? agg.mean.toFixed(1)
                  : fmt === 'fixed2' ? agg.mean.toFixed(2)
                  : fmt === 'fixed3' ? agg.mean.toFixed(3)
                  : fmt === 'pct'    ? (agg.mean * 100).toFixed(0) + '%'
                  : String(agg.mean)
    const stdStr  = fmt === 'fixed0' ? agg.std.toFixed(0)
                  : fmt === 'fixed1' ? agg.std.toFixed(1)
                  : fmt === 'fixed2' ? agg.std.toFixed(2)
                  : fmt === 'fixed3' ? agg.std.toFixed(3)
                  : fmt === 'pct'    ? (agg.std * 100).toFixed(0) + '%'
                  : String(agg.std)
    return `${meanStr} ± ${stdStr}`
}

function pickWinnerLetter(means, lowerIsBetter) {
    if (lowerIsBetter === null) return '-'
    const valid = means
        .map((m, i) => ({ m, i }))
        .filter(x => Number.isFinite(x.m))
    if (valid.length === 0) return '-'
    valid.sort((a, b) => lowerIsBetter ? a.m - b.m : b.m - a.m)
    if (valid.length > 1 && valid[0].m === valid[1].m) return '='
    return String.fromCharCode(65 + valid[0].i)
}

function printTable({ results, runs, seconds, seed }) {
    const labelWidth = Math.max(...METRIC_DEFS.map(m => m.label.length), 'metric'.length)
    const agentCount = results.length
    const colHeaders = results.map((r, i) => `${String.fromCharCode(65 + i)}: ${r.name}`)
    const valsByAgent = results.map(r => METRIC_DEFS.map(m => formatValue(r.agg[m.key], m.fmt)))
    const colWidths = colHeaders.map((h, i) => {
        const colVals = valsByAgent[i]
        return Math.max(h.length, ...colVals.map(s => s.length))
    })
    const winWidth = Math.max('winner'.length, 3)

    const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length))
    const sep = '─'.repeat(labelWidth)
        + '─┼─' + colWidths.map(w => '─'.repeat(w)).join('─┼─')
        + '─┼─' + '─'.repeat(winWidth)

    console.log()
    console.log(`Evaluation: ${runs} runs × ${seconds}s virtual time (seed=${seed})`)
    console.log()
    const headerLine = [pad('metric', labelWidth), ...colHeaders.map((h, i) => pad(h, colWidths[i])), pad('winner', winWidth)].join(' │ ')
    console.log(headerLine)
    console.log(sep)
    for (let mi = 0; mi < METRIC_DEFS.length; mi++) {
        const m = METRIC_DEFS[mi]
        const means = results.map(r => r.agg[m.key].mean)
        const winner = pickWinnerLetter(means, m.lowerIsBetter)
        const row = [
            pad(m.label, labelWidth),
            ...valsByAgent.map((vals, i) => pad(vals[mi], colWidths[i])),
            pad(winner, winWidth),
        ]
        console.log(row.join(' │ '))
    }
    const anyCrash = results.some(r => r.agg.crashed > 0)
    if (anyCrash) {
        console.log()
        results.forEach((r, i) => {
            if (r.agg.crashed > 0) {
                console.log(`⚠ agent ${String.fromCharCode(65 + i)} (${r.name}) crashed on ${r.agg.crashed}/${runs} runs`)
            }
        })
    }
    console.log()
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
    const args = parseArgs(Deno.args, {
        string: ['seed', 'runs', 'seconds'],
        boolean: ['verbose'],
        alias: { v: 'verbose' },
        default: { runs: '20', seconds: '100', seed: '42' },
    })
    const positional = args._.map(String)
    if (positional.length < 2) {
        console.error('Usage: ./run/evaluate <agent1.js> <agent2.js> [agent3.js ...] [--runs 20] [--seconds 100] [--seed 42] [--verbose]')
        Deno.exit(1)
    }
    const runs = parseInt(args.runs, 10)
    const seconds = parseFloat(args.seconds)
    const seed = parseInt(args.seed, 10)

    const absPaths = positional.map(p => p.startsWith('/') ? p : join(Deno.cwd(), p))
    const urls = absPaths.map(p => new URL('file://' + p).href)

    console.log(`Loading ${absPaths.length} agents...`)
    const modules = await Promise.all(urls.map(u => import(u)))
    const names = absPaths.map(p => basename(p, '.js'))

    const maps = await loadMaps()
    console.log(`Loaded ${maps.length} maps: ${maps.map(m => m.name).join(', ')}`)

    const scenarios = generateScenarios({ maps, count: runs, seed })

    const config = {
        decisionRate: 0.05,
        maxSeconds: seconds,
        gasRadius: 200,
        gasPeak: 1,
        verbose: args.verbose,
    }

    const results = []
    for (let a = 0; a < modules.length; a++) {
        const letter = String.fromCharCode(65 + a)
        console.log(`Running ${letter}: ${names[a]}...`)
        const agentRuns = []
        for (let i = 0; i < scenarios.length; i++) {
            const s = scenarios[i]
            Deno.stdout.writeSync(new TextEncoder().encode(`  [${i + 1}/${scenarios.length}] ${s.mapName}... `))
            const r = runScenario({ agentModule: modules[a], scenario: s, config })
            agentRuns.push({ scenarioIndex: i, ...r })
            const summary = r.crashed
                ? `CRASH: ${String(r.error).split('\n')[0]}\n`
                : `minDist=${r.minDistanceToGas.toFixed(1)} route=${(r.routeCompletionFraction * 100).toFixed(0)}%${Number.isFinite(r.timeToCompleteRoute) ? ` done@${r.timeToCompleteRoute.toFixed(1)}s` : ''}\n`
            Deno.stdout.writeSync(new TextEncoder().encode(summary))
        }
        results.push({ name: names[a], path: absPaths[a], runs: agentRuns, agg: aggregate(agentRuns) })
    }

    printTable({ results, runs, seconds, seed })

    const metricsPath = join(REPO_ROOT, 'logs', 'metrics.json')
    await writeMetricsJson(metricsPath, { results, scenarios, runs, seconds, seed, config })
    console.log(`Wrote ${metricsPath}`)
}

async function writeMetricsJson(outPath, { results, scenarios, runs, seconds, seed, config }) {
    await Deno.mkdir(join(REPO_ROOT, 'logs'), { recursive: true })
    const scenariosMeta = scenarios.map((s, i) => ({
        index: i,
        mapName: s.mapName,
        gasPosition: s.gasPosition,
        start: s.start,
        startAngleDeg: s.startAngleDeg,
    }))
    const agentsJson = results.map(r => ({
        name: r.name,
        path: r.path,
        runs: r.runs.map(run => {
            // Drop bulky error stack; keep short summary if present
            const { error, ...rest } = run
            return error ? { ...rest, error: String(error).split('\n')[0] } : rest
        }),
        aggregate: r.agg,
    }))
    const json = {
        meta: {
            timestamp: new Date().toISOString(),
            runs,
            seconds,
            seed,
            config: {
                decisionRate: config.decisionRate,
                gasRadius: config.gasRadius,
                gasPeak: config.gasPeak,
            },
        },
        scenarios: scenariosMeta,
        agents: agentsJson,
    }
    await Deno.writeTextFile(outPath, JSON.stringify(json, null, 2))
}

export { loadMaps, generateScenarios, runScenario, aggregate, mean, stddev }

if (import.meta.main) await main()

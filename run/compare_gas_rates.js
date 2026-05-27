#!/usr/bin/env -S deno run -A

import { fromFileUrl, join } from 'https://deno.land/std@0.224.0/path/mod.ts'
import { parseArgs } from 'https://deno.land/std@0.224.0/cli/parse_args.ts'
import { loadMaps, generateScenarios, runScenario, aggregate, mean, stddev } from './evaluate.js'

const REPO_ROOT = fromFileUrl(new URL('..', import.meta.url))

const args = parseArgs(Deno.args, {
    string: ['seed', 'runs', 'seconds', 'out'],
    boolean: ['verbose'],
    default: { runs: '60', seconds: '300', seed: '42' },
})

const runs = parseInt(args.runs, 10)
const seconds = parseFloat(args.seconds)
const seed = parseInt(args.seed, 10)
const outPath = args.out || join(REPO_ROOT, 'logs', 'gas_rate_comparison.json')

const agentPath = join(REPO_ROOT, 'main/agents/neo/smart_lobster_agent.js')
const agentModule = await import(new URL('file://' + agentPath).href)

const maps = await loadMaps()
console.error(`Loaded ${maps.length} maps: ${maps.map(m => m.name).join(', ')}`)

const scenarios = generateScenarios({ maps, count: runs, seed })

const rates = ['gaussian', 'inverse_square']
const allRuns = {}

for (const rate of rates) {
    console.error(`\nRunning smart_lobster with gasCircleRate=${rate}...`)
    const config = {
        decisionRate: 0.05,
        maxSeconds: seconds,
        gasRadius: 200,
        gasPeak: 1,
        gasCircleRate: rate,
        verbose: args.verbose,
    }
    const agentRuns = []
    for (let i = 0; i < scenarios.length; i++) {
        const s = scenarios[i]
        Deno.stderr.writeSync(new TextEncoder().encode(`  [${i + 1}/${scenarios.length}] ${s.mapName}... `))
        const r = runScenario({ agentModule, scenario: s, config })
        agentRuns.push(r)
        const summary = r.crashed
            ? `CRASH: ${String(r.error).split('\n')[0]}\n`
            : `minDist=${r.minDistanceToGas.toFixed(1)}\n`
        Deno.stderr.writeSync(new TextEncoder().encode(summary))
    }
    allRuns[rate] = agentRuns
}

function ci95(values) {
    const m = mean(values)
    const s = stddev(values)
    const n = values.filter(v => Number.isFinite(v)).length
    const se = s / Math.sqrt(n)
    return { mean: m, std: s, se, ci_lo: m - 1.96 * se, ci_hi: m + 1.96 * se, n }
}

function buildTable(runData) {
    const metrics = {}
    const keys = ['minDistanceToGas', 'meanDistanceToGas', 'maxGasReading', 'totalDistanceTraveled', 'timeToFirstWithin50', 'routeCompletionFraction', 'routeWaypointsHit', 'waypointsHitPerMinute', 'timeToCompleteRoute']
    for (const key of keys) {
        const vals = runData.map(r => r[key])
        const finite = vals.filter(v => Number.isFinite(v))
        const stats = ci95(finite)
        stats.reached = finite.length
        stats.total = vals.length
        metrics[key] = stats
    }
    metrics.crashed = runData.filter(r => r.crashed).length
    return metrics
}

function buildPaired(gaussianRuns, invSquareRuns) {
    const keys = ['minDistanceToGas', 'meanDistanceToGas', 'maxGasReading', 'totalDistanceTraveled']
    const paired = {}
    for (const key of keys) {
        const diffs = []
        for (let i = 0; i < gaussianRuns.length; i++) {
            const g = gaussianRuns[i][key]
            const inv = invSquareRuns[i][key]
            if (Number.isFinite(g) && Number.isFinite(inv)) {
                diffs.push(g - inv)
            }
        }
        const stats = ci95(diffs)
        stats.significant = stats.ci_lo > 0 || stats.ci_hi < 0
        paired[key] = stats
    }

    const within50 = { gaussian_only: 0, inv_sq_only: 0, both: 0, neither: 0 }
    for (let i = 0; i < gaussianRuns.length; i++) {
        const gHit = Number.isFinite(gaussianRuns[i].timeToFirstWithin50)
        const iHit = Number.isFinite(invSquareRuns[i].timeToFirstWithin50)
        if (gHit && iHit) within50.both++
        else if (gHit) within50.gaussian_only++
        else if (iHit) within50.inv_sq_only++
        else within50.neither++
    }
    paired.within50_reach = within50

    return paired
}

const json = {
    meta: {
        timestamp: new Date().toISOString(),
        agent: 'smart_lobster',
        runs,
        seconds,
        seed,
        gasRadius: 200,
        gasPeak: 1,
        maps: maps.map(m => m.name),
    },
    gaussian: buildTable(allRuns.gaussian),
    inverse_square: buildTable(allRuns.inverse_square),
    paired_difference: buildPaired(allRuns.gaussian, allRuns.inverse_square),
}

await Deno.mkdir(join(REPO_ROOT, 'logs'), { recursive: true })
await Deno.writeTextFile(outPath, JSON.stringify(json, null, 2))
console.error(`\nWrote ${outPath}`)
console.log(JSON.stringify(json, null, 2))

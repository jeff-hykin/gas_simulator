#!/usr/bin/env -S deno run -A

import { parseArgs } from 'https://deno.land/std@0.224.0/cli/parse_args.ts'
import { basename, fromFileUrl, join } from 'https://deno.land/std@0.224.0/path/mod.ts'
import { loadMaps, generateScenarios, runScenario, aggregate, mean, stddev } from './evaluate.js'

const REPO_ROOT = fromFileUrl(new URL('..', import.meta.url))

const NOISE_LEVELS = [0, 0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0]

async function main() {
    const args = parseArgs(Deno.args, {
        string: ['seed', 'runs', 'seconds', 'noise'],
        boolean: ['verbose'],
        alias: { v: 'verbose' },
        default: { runs: '20', seconds: '2000', seed: '42' },
    })
    const positional = args._.map(String)
    if (positional.length < 1) {
        console.error('Usage: ./run/noise_sweep.js <agent1.js> [agent2.js ...] [--runs 20] [--seconds 100] [--seed 42] [--noise "0,0.1,0.5,1.0"]')
        Deno.exit(1)
    }
    const runs = parseInt(args.runs, 10)
    const seconds = parseFloat(args.seconds)
    const seed = parseInt(args.seed, 10)
    const noiseLevels = args.noise
        ? args.noise.split(',').map(Number)
        : NOISE_LEVELS

    const absPaths = positional.map(p => p.startsWith('/') ? p : join(Deno.cwd(), p))
    const urls = absPaths.map(p => new URL('file://' + p).href)

    console.log(`Loading ${absPaths.length} agents...`)
    const modules = await Promise.all(urls.map(u => import(u)))
    const names = absPaths.map(p => basename(p, '.js'))

    const maps = await loadMaps()
    console.log(`Loaded ${maps.length} maps`)
    console.log(`Noise levels: ${noiseLevels.join(', ')}`)
    console.log(`${runs} runs × ${seconds}s per noise level\n`)

    const scenarios = generateScenarios({ maps, count: runs, seed })

    // results[agentIdx][noiseIdx] = aggregated stats
    const allResults = []

    for (let a = 0; a < modules.length; a++) {
        const agentResults = []
        console.log(`Agent: ${names[a]}`)
        for (let ni = 0; ni < noiseLevels.length; ni++) {
            const noise = noiseLevels[ni]
            Deno.stdout.writeSync(new TextEncoder().encode(`  noise=${noise.toFixed(3)} ... `))
            const config = {
                decisionRate: 0.05,
                maxSeconds: seconds,
                gasRadius: 200,
                gasPeak: 1,
                gasNoiseStdDev: noise,
                verbose: args.verbose,
            }
            const agentRuns = []
            for (const s of scenarios) {
                const r = runScenario({ agentModule: modules[a], scenario: s, config })
                agentRuns.push(r)
            }
            const agg = aggregate(agentRuns)
            agentResults.push({
                noise,
                agg,
                minDistMean: agg.minDistanceToGas.mean,
                minDistStd: agg.minDistanceToGas.std,
                meanDistMean: agg.meanDistanceToGas.mean,
                maxGasMean: agg.maxGasReading.mean,
                timeWithin50: agg.timeToFirstWithin50.mean,
                crashed: agg.crashed,
            })
            console.log(`minDist=${agg.minDistanceToGas.mean.toFixed(1)} ± ${agg.minDistanceToGas.std.toFixed(1)}`)
        }
        allResults.push({ name: names[a], data: agentResults })
    }

    // Print summary table
    console.log('\n' + '═'.repeat(70))
    console.log('NOISE vs MIN DISTANCE TO GAS SOURCE')
    console.log('═'.repeat(70))
    const header = ['noise', ...names.map(n => `${n} (min dist)`)]
    console.log(header.join('\t'))
    for (let ni = 0; ni < noiseLevels.length; ni++) {
        const row = [noiseLevels[ni].toFixed(3)]
        for (const ar of allResults) {
            const d = ar.data[ni]
            row.push(`${d.minDistMean.toFixed(1)} ± ${d.minDistStd.toFixed(1)}`)
        }
        console.log(row.join('\t'))
    }

    // Generate HTML chart
    const htmlPath = join(REPO_ROOT, 'logs', 'noise_sweep.html')
    await Deno.mkdir(join(REPO_ROOT, 'logs'), { recursive: true })
    await Deno.writeTextFile(htmlPath, generateHtml(allResults, noiseLevels, { runs, seconds, seed }))
    console.log(`\nChart written to ${htmlPath}`)

    // Also write raw JSON
    const jsonPath = join(REPO_ROOT, 'logs', 'noise_sweep.json')
    await Deno.writeTextFile(jsonPath, JSON.stringify({ meta: { runs, seconds, seed, noiseLevels }, agents: allResults }, null, 2))
    console.log(`Data written to ${jsonPath}`)
}

function generateHtml(allResults, noiseLevels, meta) {
    const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2']

    const datasets = allResults.map((agent, i) => {
        const color = COLORS[i % COLORS.length]
        return {
            name: agent.name,
            color,
            points: agent.data.map(d => ({
                x: d.noise,
                y: d.minDistMean,
                yLo: d.minDistMean - d.minDistStd,
                yHi: d.minDistMean + d.minDistStd,
            })),
        }
    })

    const allY = datasets.flatMap(ds => ds.points.flatMap(p => [p.yLo, p.yHi, p.y]))
    const yMin = 0
    const yMax = Math.ceil(Math.max(...allY) / 10) * 10
    const xMin = Math.min(...noiseLevels)
    const xMax = Math.max(...noiseLevels)

    const W = 800, H = 500
    const pad = { top: 60, right: 200, bottom: 70, left: 80 }
    const plotW = W - pad.left - pad.right
    const plotH = H - pad.top - pad.bottom

    function sx(x) { return pad.left + (xMax > xMin ? (x - xMin) / (xMax - xMin) * plotW : plotW / 2) }
    function sy(y) { return pad.top + plotH - (yMax > yMin ? (y - yMin) / (yMax - yMin) * plotH : plotH / 2) }

    let svg = ''

    // Grid lines
    const yTicks = 6
    for (let i = 0; i <= yTicks; i++) {
        const yVal = yMin + (yMax - yMin) * i / yTicks
        const yPx = sy(yVal)
        svg += `<line x1="${pad.left}" y1="${yPx}" x2="${pad.left + plotW}" y2="${yPx}" stroke="#e5e7eb" stroke-width="1"/>\n`
        svg += `<text x="${pad.left - 10}" y="${yPx + 4}" text-anchor="end" font-size="12" fill="#6b7280">${yVal.toFixed(0)}</text>\n`
    }
    for (const xVal of noiseLevels) {
        const xPx = sx(xVal)
        svg += `<line x1="${xPx}" y1="${pad.top}" x2="${xPx}" y2="${pad.top + plotH}" stroke="#e5e7eb" stroke-width="1"/>\n`
        svg += `<text x="${xPx}" y="${pad.top + plotH + 20}" text-anchor="middle" font-size="12" fill="#6b7280">${xVal}</text>\n`
    }

    // Axes
    svg += `<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#374151" stroke-width="2"/>\n`
    svg += `<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" stroke="#374151" stroke-width="2"/>\n`

    // Labels
    svg += `<text x="${pad.left + plotW / 2}" y="${pad.top + plotH + 50}" text-anchor="middle" font-size="14" fill="#111827">Gas Noise Std Dev (PPM)</text>\n`
    svg += `<text x="20" y="${pad.top + plotH / 2}" text-anchor="middle" font-size="14" fill="#111827" transform="rotate(-90, 20, ${pad.top + plotH / 2})">Min Distance to Gas Source</text>\n`
    svg += `<text x="${pad.left + plotW / 2}" y="30" text-anchor="middle" font-size="18" font-weight="bold" fill="#111827">Sensor Noise vs Gas-Finding Accuracy</text>\n`
    svg += `<text x="${pad.left + plotW / 2}" y="48" text-anchor="middle" font-size="12" fill="#6b7280">${meta.runs} runs × ${meta.seconds}s, seed=${meta.seed}</text>\n`

    // Plot each dataset
    for (const ds of datasets) {
        // Error band
        let bandPath = ''
        for (let i = 0; i < ds.points.length; i++) {
            const p = ds.points[i]
            bandPath += `${i === 0 ? 'M' : 'L'}${sx(p.x)},${sy(p.yHi)} `
        }
        for (let i = ds.points.length - 1; i >= 0; i--) {
            const p = ds.points[i]
            bandPath += `L${sx(p.x)},${sy(Math.max(0, p.yLo))} `
        }
        bandPath += 'Z'
        svg += `<path d="${bandPath}" fill="${ds.color}" fill-opacity="0.12" stroke="none"/>\n`

        // Line
        let linePath = ''
        for (let i = 0; i < ds.points.length; i++) {
            const p = ds.points[i]
            linePath += `${i === 0 ? 'M' : 'L'}${sx(p.x)},${sy(p.y)} `
        }
        svg += `<path d="${linePath}" fill="none" stroke="${ds.color}" stroke-width="2.5"/>\n`

        // Dots
        for (const p of ds.points) {
            svg += `<circle cx="${sx(p.x)}" cy="${sy(p.y)}" r="4" fill="${ds.color}"/>\n`
        }
    }

    // Legend
    let ly = pad.top + 10
    for (const ds of datasets) {
        svg += `<line x1="${pad.left + plotW + 20}" y1="${ly}" x2="${pad.left + plotW + 40}" y2="${ly}" stroke="${ds.color}" stroke-width="2.5"/>\n`
        svg += `<circle cx="${pad.left + plotW + 30}" cy="${ly}" r="4" fill="${ds.color}"/>\n`
        svg += `<text x="${pad.left + plotW + 48}" y="${ly + 4}" font-size="13" fill="#374151">${ds.name}</text>\n`
        ly += 24
    }

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Noise Sweep</title>
<style>body { font-family: system-ui; display: flex; justify-content: center; padding: 2em; background: #f9fafb; }</style>
</head><body>
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
<rect width="${W}" height="${H}" fill="white" rx="8"/>
${svg}
</svg>
</body></html>`
}

await main()

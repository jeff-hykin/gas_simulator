#!/usr/bin/env -S deno run -A

import { parseArgs } from 'https://deno.land/std@0.224.0/cli/parse_args.ts'
import { join } from 'https://deno.land/std@0.224.0/path/mod.ts'

const args = parseArgs(Deno.args, {
    string: ['input', 'output'],
    default: {
        input: 'logs/metrics.json',
        output: 'logs/report.html',
    },
})

const inputPath = args.input.startsWith('/') ? args.input : join(Deno.cwd(), args.input)
const outputPath = args.output.startsWith('/') ? args.output : join(Deno.cwd(), args.output)

function buildHtml(metrics) {
    const safeJson = JSON.stringify(metrics)
        .replace(/<\//g, '<\\/')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')

    return HTML_TEMPLATE.replace('__METRICS_JSON__', safeJson)
}

async function main() {
    let metrics
    try {
        metrics = JSON.parse(await Deno.readTextFile(inputPath))
    } catch (err) {
        console.error(`Failed to read ${inputPath}: ${err.message}`)
        console.error('Run ./run/evaluate first to generate logs/metrics.json')
        Deno.exit(1)
    }

    const html = buildHtml(metrics)
    await Deno.writeTextFile(outputPath, html)
    console.log(`Wrote ${outputPath}`)
}

const HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gas Simulator — Agent Evaluation Report</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --border-soft: rgba(148, 163, 184, 0.12);
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #22d3ee;
      --win-bg: rgba(34, 211, 238, 0.13);
    }
    * { box-sizing: border-box; }
    html, body { background: var(--bg); }
    body {
      margin: 0;
      padding: 32px 24px 48px;
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      font-size: 14px;
      line-height: 1.55;
    }
    .container { max-width: 1400px; margin: 0 auto; }
    h1 {
      font-size: 30px;
      font-weight: 600;
      margin: 0 0 6px 0;
      letter-spacing: -0.02em;
    }
    h2 {
      font-size: 16px;
      font-weight: 600;
      margin: 0 0 18px 0;
      color: var(--text);
      letter-spacing: -0.01em;
    }
    .subtitle {
      color: var(--muted);
      margin-bottom: 28px;
      font-size: 13px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
    }
    .meta-item {
      padding: 12px 14px;
      background: rgba(255, 255, 255, 0.025);
      border-radius: 8px;
      border: 1px solid var(--border-soft);
    }
    .meta-label {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 4px;
    }
    .meta-value {
      font-size: 16px;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
    }
    .agent-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 18px;
    }
    .agent-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-soft);
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
    }
    .agent-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
    }
    table.summary {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-variant-numeric: tabular-nums;
    }
    table.summary th, table.summary td {
      padding: 10px 14px;
      text-align: left;
      border-bottom: 1px solid var(--border-soft);
      font-size: 13px;
    }
    table.summary thead th {
      font-weight: 500;
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      border-bottom: 1px solid var(--border);
    }
    table.summary td.metric-label { color: var(--muted); }
    table.summary td.winner {
      background: var(--win-bg);
      color: var(--accent);
      font-weight: 600;
    }
    table.summary td.winner-col {
      font-weight: 600;
      color: var(--accent);
    }
    table.summary tbody tr:last-child td { border-bottom: none; }

    .chart-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
    }
    .chart-full { grid-column: 1 / -1; }
    @media (max-width: 900px) {
      .chart-grid { grid-template-columns: 1fr; }
      .chart-full { grid-column: 1; }
    }
    .chart-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px 20px 16px;
    }
    .small-multiples {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 14px;
    }
    .small-multiple {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border-soft);
      border-radius: 8px;
      padding: 10px 10px 6px;
    }
    .small-multiple-title {
      font-size: 11px;
      color: var(--muted);
      margin: 0 0 6px 2px;
      font-weight: 500;
    }
    footer {
      color: var(--muted);
      font-size: 11px;
      margin-top: 24px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Gas Simulator — Agent Evaluation</h1>
    <div id="subtitle" class="subtitle"></div>

    <div class="card">
      <h2>Run info</h2>
      <div id="meta" class="meta-grid"></div>
      <div id="agent-legend" class="agent-legend"></div>
    </div>

    <div class="card">
      <h2>Summary</h2>
      <table id="summary" class="summary"></table>
    </div>

    <div class="chart-grid">
      <div class="chart-card">
        <h2>Closeness — min distance to gas</h2>
        <div id="closeness-chart" style="height: 300px;"></div>
      </div>
      <div class="chart-card">
        <h2>Time to complete route</h2>
        <div id="route-chart" style="height: 300px;"></div>
      </div>
      <div class="chart-card chart-full">
        <h2>Per-scenario closeness</h2>
        <div id="scatter-chart" style="height: 380px;"></div>
      </div>
      <div class="chart-card chart-full">
        <h2>Closeness by map</h2>
        <div id="per-map" class="small-multiples"></div>
      </div>
    </div>

    <footer>Generated by run/report.js</footer>
  </div>

  <script>
    const METRICS = __METRICS_JSON__;

    const COLORS = ['#22d3ee','#fbbf24','#22c55e','#a78bfa','#f97316','#f43f5e','#60a5fa','#f472b6']
    const TEXT = '#f1f5f9'
    const MUTED = '#94a3b8'
    const GRID = 'rgba(148, 163, 184, 0.14)'

    const BASE_LAYOUT = {
      paper_bgcolor: 'transparent',
      plot_bgcolor: 'transparent',
      font: { color: TEXT, family: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif', size: 12 },
      xaxis: { gridcolor: GRID, linecolor: GRID, zerolinecolor: GRID, tickcolor: GRID, tickfont: { color: MUTED } },
      yaxis: { gridcolor: GRID, linecolor: GRID, zerolinecolor: GRID, tickcolor: GRID, tickfont: { color: MUTED } },
      margin: { l: 60, r: 20, t: 10, b: 50 },
      showlegend: false,
      hoverlabel: { bgcolor: '#0f172a', bordercolor: '#334155', font: { color: TEXT } },
    }

    const PLOTLY_CONFIG = { displayModeBar: false, responsive: true }

    const METRIC_DEFS = [
      { key: 'minDistanceToGas',        label: 'min distance to gas',       lowerIsBetter: true,  fmt: 'fixed1' },
      { key: 'finalDistanceToGas',      label: 'final distance to gas',     lowerIsBetter: true,  fmt: 'fixed1' },
      { key: 'meanDistanceToGas',       label: 'mean distance to gas',      lowerIsBetter: true,  fmt: 'fixed1' },
      { key: 'maxGasReading',           label: 'peak gas reading (ppm)',    lowerIsBetter: false, fmt: 'fixed3' },
      { key: 'totalDistanceTraveled',   label: 'total distance traveled',   lowerIsBetter: null,  fmt: 'fixed0' },
      { key: 'timeToCompleteRoute',     label: 'time to complete route',    lowerIsBetter: true,  fmt: 'timeHit' },
      { key: 'routeWaypointsHit',       label: 'route waypoints hit',       lowerIsBetter: false, fmt: 'fixed1' },
      { key: 'waypointsHitPerMinute',   label: 'waypoints hit per minute',  lowerIsBetter: false, fmt: 'fixed2' },
      { key: 'timeToFirstWithin50',     label: 'time to first within 50',   lowerIsBetter: true,  fmt: 'timeHit' },
    ]

    function fmtValue(agg, mode) {
      if (!agg) return '—'
      if (mode === 'timeHit') {
        if (agg.n === 0) return 'never (0/' + agg.total + ')'
        return agg.mean.toFixed(1) + 's (' + agg.n + '/' + agg.total + ')'
      }
      if (!Number.isFinite(agg.mean)) return '—'
      const m = mode === 'fixed0' ? agg.mean.toFixed(0)
              : mode === 'fixed1' ? agg.mean.toFixed(1)
              : mode === 'fixed2' ? agg.mean.toFixed(2)
              : mode === 'fixed3' ? agg.mean.toFixed(3)
              : mode === 'pct'    ? (agg.mean * 100).toFixed(0) + '%'
              : String(agg.mean)
      const s = mode === 'fixed0' ? agg.std.toFixed(0)
              : mode === 'fixed1' ? agg.std.toFixed(1)
              : mode === 'fixed2' ? agg.std.toFixed(2)
              : mode === 'fixed3' ? agg.std.toFixed(3)
              : mode === 'pct'    ? (agg.std * 100).toFixed(0) + '%'
              : String(agg.std)
      return m + ' ± ' + s
    }

    function pickWinnerIdx(means, lowerIsBetter) {
      if (lowerIsBetter === null) return -1
      const valid = means.map((m, i) => ({ m, i })).filter(x => Number.isFinite(x.m))
      if (valid.length === 0) return -1
      valid.sort((a, b) => lowerIsBetter ? a.m - b.m : b.m - a.m)
      if (valid.length > 1 && valid[0].m === valid[1].m) return -1
      return valid[0].i
    }

    function agentLetter(i) { return String.fromCharCode(65 + i) }
    function agentLabel(i, name) { return agentLetter(i) + ': ' + name }

    // ── Meta ─────────────────────────────────────────
    function renderMeta() {
      const m = METRICS.meta
      const date = new Date(m.timestamp)
      const mapNames = Array.from(new Set(METRICS.scenarios.map(s => s.mapName)))
      document.getElementById('subtitle').textContent =
        METRICS.agents.length + ' agents · ' + m.runs + ' runs × ' + m.seconds + 's · ' + date.toLocaleString()
      const items = [
        ['Agents', METRICS.agents.length],
        ['Runs each', m.runs],
        ['Virtual time', m.seconds + 's'],
        ['Seed', m.seed],
        ['Maps', mapNames.length],
        ['Tick rate', Math.round(1 / m.config.decisionRate) + ' Hz'],
      ]
      document.getElementById('meta').innerHTML = items.map(([label, value]) =>
        '<div class="meta-item"><div class="meta-label">' + label + '</div><div class="meta-value">' + value + '</div></div>'
      ).join('')

      document.getElementById('agent-legend').innerHTML = METRICS.agents.map((a, i) =>
        '<span class="agent-chip"><span class="agent-dot" style="background:' + COLORS[i % COLORS.length] + '"></span>' +
        agentLabel(i, a.name) + '</span>'
      ).join('')
    }

    // ── Summary table ────────────────────────────────
    function renderSummary() {
      const thead = '<thead><tr><th>Metric</th>' +
        METRICS.agents.map((a, i) => '<th>' + agentLabel(i, a.name) + '</th>').join('') +
        '<th>Winner</th></tr></thead>'
      const rows = METRIC_DEFS.map(def => {
        const means = METRICS.agents.map(a => {
          const agg = a.aggregate[def.key]
          return agg ? agg.mean : NaN
        })
        const winIdx = pickWinnerIdx(means, def.lowerIsBetter)
        const cells = METRICS.agents.map((a, i) => {
          const cls = (i === winIdx) ? ' class="winner"' : ''
          return '<td' + cls + '>' + fmtValue(a.aggregate[def.key], def.fmt) + '</td>'
        }).join('')
        const winnerLabel = winIdx < 0 ? '—' : agentLetter(winIdx)
        return '<tr><td class="metric-label">' + def.label + '</td>' + cells +
               '<td class="winner-col">' + winnerLabel + '</td></tr>'
      }).join('')
      document.getElementById('summary').innerHTML = thead + '<tbody>' + rows + '</tbody>'
    }

    // ── Closeness bar ────────────────────────────────
    function closenessChart() {
      const data = [{
        type: 'bar',
        orientation: 'h',
        x: METRICS.agents.map(a => a.aggregate.minDistanceToGas.mean),
        y: METRICS.agents.map((a, i) => agentLabel(i, a.name)),
        error_x: {
          type: 'data',
          array: METRICS.agents.map(a => a.aggregate.minDistanceToGas.std),
          visible: true,
          color: MUTED,
          thickness: 1.5,
          width: 6,
        },
        marker: {
          color: METRICS.agents.map((_, i) => COLORS[i % COLORS.length]),
          line: { width: 0 },
        },
        hovertemplate: '%{y}<br>mean: %{x:.1f}<extra></extra>',
      }]
      const layout = {
        ...BASE_LAYOUT,
        xaxis: { ...BASE_LAYOUT.xaxis, title: { text: 'min distance (lower is better)', font: { color: MUTED, size: 11 } } },
        yaxis: { ...BASE_LAYOUT.yaxis, automargin: true },
        margin: { l: 160, r: 30, t: 10, b: 50 },
      }
      Plotly.newPlot('closeness-chart', data, layout, PLOTLY_CONFIG)
    }

    // ── Time-to-complete-route bar ───────────────────
    // Only runs that actually finished the route count toward mean/stddev.
    function routeChart() {
      const perAgentTimes = METRICS.agents.map(a =>
        a.runs.map(r => r.timeToCompleteRoute).filter(Number.isFinite)
      )
      const meanOf = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN
      const stdOf  = arr => {
        if (arr.length < 2) return 0
        const m = meanOf(arr)
        return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1))
      }
      const means  = perAgentTimes.map(meanOf)
      const stds   = perAgentTimes.map(stdOf)
      const counts = perAgentTimes.map(a => a.length)
      const totals = METRICS.agents.map(a => a.runs.length)

      const data = [{
        type: 'bar',
        x: METRICS.agents.map((a, i) => agentLabel(i, a.name)),
        y: means,
        error_y: {
          type: 'data',
          array: stds,
          visible: true,
          color: MUTED,
          thickness: 1.5,
          width: 6,
        },
        marker: {
          color: METRICS.agents.map((_, i) => COLORS[i % COLORS.length]),
          line: { width: 0 },
        },
        customdata: counts.map((n, i) => [n, totals[i]]),
        hovertemplate: '%{x}<br>%{y:.1f}s mean<br>completed: %{customdata[0]}/%{customdata[1]}<extra></extra>',
      }]
      const layout = {
        ...BASE_LAYOUT,
        yaxis: { ...BASE_LAYOUT.yaxis, title: { text: 'seconds to final waypoint (lower is better)', font: { color: MUTED, size: 11 } }, rangemode: 'tozero' },
        xaxis: { ...BASE_LAYOUT.xaxis, automargin: true },
        margin: { l: 60, r: 20, t: 10, b: 80 },
      }
      Plotly.newPlot('route-chart', data, layout, PLOTLY_CONFIG)
    }

    // ── Per-scenario scatter ─────────────────────────
    function scatterChart() {
      const agentCount = METRICS.agents.length
      const jitter = 0.18
      const data = METRICS.agents.map((agent, i) => ({
        type: 'scatter',
        mode: 'markers',
        name: agentLabel(i, agent.name),
        x: agent.runs.map(r => r.scenarioIndex + (i - (agentCount - 1) / 2) * jitter),
        y: agent.runs.map(r => r.minDistanceToGas),
        customdata: agent.runs.map(r => METRICS.scenarios[r.scenarioIndex].mapName.replace('.yaml', '')),
        marker: { color: COLORS[i % COLORS.length], size: 9, opacity: 0.8, line: { color: '#0f172a', width: 1 } },
        hovertemplate: '<b>' + agent.name + '</b><br>scenario %{x:.0f} · %{customdata}<br>min dist: %{y:.1f}<extra></extra>',
      }))
      const layout = {
        ...BASE_LAYOUT,
        showlegend: true,
        legend: { orientation: 'h', y: -0.18, font: { color: TEXT, size: 12 }, bgcolor: 'transparent' },
        xaxis: {
          ...BASE_LAYOUT.xaxis,
          title: { text: 'scenario index', font: { color: MUTED, size: 11 } },
          tickmode: 'linear',
          dtick: 1,
          range: [-0.6, METRICS.scenarios.length - 0.4],
        },
        yaxis: { ...BASE_LAYOUT.yaxis, title: { text: 'min distance to gas', font: { color: MUTED, size: 11 } }, rangemode: 'tozero' },
        margin: { l: 65, r: 20, t: 10, b: 80 },
      }
      Plotly.newPlot('scatter-chart', data, layout, PLOTLY_CONFIG)
    }

    // ── ECDF of route-completion times ───────────────
    function ecdfChart() {
      const total = METRICS.meta.runs
      const seconds = METRICS.meta.seconds
      const data = METRICS.agents.map((agent, i) => {
        const times = agent.runs
          .map(r => r.timeToCompleteRoute)
          .filter(t => Number.isFinite(t))
          .sort((a, b) => a - b)
        const xs = [0]
        const ys = [0]
        for (let k = 0; k < times.length; k++) {
          xs.push(times[k])
          ys.push((k + 1) / total)
        }
        xs.push(seconds)
        ys.push(times.length / total)
        return {
          type: 'scatter',
          mode: 'lines',
          name: agentLabel(i, agent.name),
          x: xs,
          y: ys,
          line: { color: COLORS[i % COLORS.length], width: 2.5, shape: 'hv' },
          hovertemplate: '<b>' + agent.name + '</b><br>by %{x:.1f}s: %{y:.0%} done<extra></extra>',
        }
      })
      const layout = {
        ...BASE_LAYOUT,
        showlegend: true,
        legend: { orientation: 'h', y: -0.22, font: { color: TEXT, size: 12 }, bgcolor: 'transparent' },
        xaxis: { ...BASE_LAYOUT.xaxis, title: { text: 'virtual seconds', font: { color: MUTED, size: 11 } }, range: [0, seconds] },
        yaxis: { ...BASE_LAYOUT.yaxis, title: { text: 'fraction of runs with route complete', font: { color: MUTED, size: 11 } }, range: [0, 1.02], tickformat: '.0%' },
        margin: { l: 70, r: 20, t: 10, b: 80 },
      }
      // Plotly.newPlot('ecdf-chart', data, layout, PLOTLY_CONFIG)
    }

    // ── Per-map small multiples ──────────────────────
    function perMapCharts() {
      const mapNames = Array.from(new Set(METRICS.scenarios.map(s => s.mapName))).sort()
      const container = document.getElementById('per-map')
      container.innerHTML = ''

      // 1. Create all DOM nodes first so CSS grid distributes column widths
      //    before any Plotly chart measures its container.
      const pending = mapNames.map(mapName => {
        const wrap = document.createElement('div')
        wrap.className = 'small-multiple'
        const title = document.createElement('div')
        title.className = 'small-multiple-title'
        title.textContent = mapName.replace('.yaml', '')
        wrap.appendChild(title)
        const chartDiv = document.createElement('div')
        chartDiv.style.height = '170px'
        wrap.appendChild(chartDiv)
        container.appendChild(wrap)
        return { mapName, chartDiv }
      })

      // 2. Now render Plotly into each — container widths are settled.
      pending.forEach(({ mapName, chartDiv }) => {
        const scenIdxsForMap = new Set(
          METRICS.scenarios.filter(s => s.mapName === mapName).map(s => s.index)
        )
        const means = METRICS.agents.map((agent, i) => {
          const dists = agent.runs
            .filter(r => scenIdxsForMap.has(r.scenarioIndex))
            .map(r => r.minDistanceToGas)
            .filter(d => Number.isFinite(d))
          const mean = dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : NaN
          const std = dists.length > 1
            ? Math.sqrt(dists.reduce((a, b) => a + (b - mean) ** 2, 0) / (dists.length - 1))
            : 0
          return { letter: agentLetter(i), name: agent.name, mean, std, color: COLORS[i % COLORS.length], n: dists.length }
        })

        const data = [{
          type: 'bar',
          x: means.map(m => m.letter),
          y: means.map(m => m.mean),
          error_y: {
            type: 'data',
            array: means.map(m => m.std),
            visible: true,
            color: MUTED,
            thickness: 1,
            width: 4,
          },
          marker: { color: means.map(m => m.color), line: { width: 0 } },
          customdata: means.map(m => [m.name, m.n]),
          hovertemplate: '<b>%{customdata[0]}</b><br>n=%{customdata[1]}<br>mean: %{y:.1f}<extra></extra>',
        }]
        const layout = {
          ...BASE_LAYOUT,
          margin: { l: 42, r: 8, t: 6, b: 22 },
          xaxis: { ...BASE_LAYOUT.xaxis, tickfont: { color: MUTED, size: 10 } },
          yaxis: { ...BASE_LAYOUT.yaxis, tickfont: { color: MUTED, size: 10 }, rangemode: 'tozero' },
        }
        Plotly.newPlot(chartDiv, data, layout, PLOTLY_CONFIG)
      })
    }

    renderMeta()
    renderSummary()
    closenessChart()
    routeChart()
    scatterChart()
    ecdfChart()
    perMapCharts()
  </script>
</body>
</html>`

await main()

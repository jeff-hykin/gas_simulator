#!/usr/bin/env -S deno run -A

import { parseArgs } from 'https://deno.land/std@0.224.0/cli/parse_args.ts'
import { join } from 'https://deno.land/std@0.224.0/path/mod.ts'

const args = parseArgs(Deno.args, {
    string: ['input', 'output', 'noise-sweep', 'gas-rate'],
    default: {
        input: 'logs/metrics.json',
        output: 'logs/report.html',
        'noise-sweep': 'logs/noise_sweep.json',
        'gas-rate': 'logs/gas_rate_comparison.json',
    },
})

const inputPath = args.input.startsWith('/') ? args.input : join(Deno.cwd(), args.input)
const outputPath = args.output.startsWith('/') ? args.output : join(Deno.cwd(), args.output)
const noiseSweepPath = args['noise-sweep'].startsWith('/') ? args['noise-sweep'] : join(Deno.cwd(), args['noise-sweep'])
const gasRatePath = args['gas-rate'].startsWith('/') ? args['gas-rate'] : join(Deno.cwd(), args['gas-rate'])

function safeJsonString(obj) {
    return JSON.stringify(obj)
        .replace(/<\//g, '<\\/')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
}

function buildHtml(metrics, noiseSweep, gasRate) {
    return HTML_TEMPLATE
        .replace('__METRICS_JSON__', safeJsonString(metrics))
        .replace('__NOISE_SWEEP_JSON__', noiseSweep ? safeJsonString(noiseSweep) : 'null')
        .replace('__GAS_RATE_JSON__', gasRate ? safeJsonString(gasRate) : 'null')
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

    let noiseSweep = null
    try {
        noiseSweep = JSON.parse(await Deno.readTextFile(noiseSweepPath))
        console.log(`Loaded noise sweep data from ${noiseSweepPath}`)
    } catch {
        console.log(`No noise sweep data at ${noiseSweepPath} (skipping chart)`)
    }

    let gasRate = null
    try {
        gasRate = JSON.parse(await Deno.readTextFile(gasRatePath))
        console.log(`Loaded gas rate comparison from ${gasRatePath}`)
    } catch {
        console.log(`No gas rate comparison at ${gasRatePath} (skipping chart)`)
    }

    const html = buildHtml(metrics, noiseSweep, gasRate)
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
    .legend-note {
      font-size: 11px;
      color: var(--muted);
      margin: -10px 0 14px 0;
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
        <h2>Per-scenario closeness (higher = better)</h2>
        <div id="scatter-chart" style="height: 380px;"></div>
      </div>
      <div id="noise-sweep-section" class="chart-card chart-full" style="display:none;">
        <h2>Sensor noise vs gas-finding accuracy</h2>
        <div id="noise-sweep-subtitle" class="legend-note"></div>
        <div id="noise-sweep-chart" style="height: 420px;"></div>
      </div>
      <div id="detection-score-section" class="chart-card chart-full" style="display:none;">
        <h2>Detection score — proximity with inverse-square time penalty</h2>
        <div class="legend-note">score = max(0, 1 − d/D) / (1 + (t₅₀/τ)²) · higher = got close fast · τ = 25% of sim time</div>
        <div id="detection-score-chart" style="height: 380px;"></div>
      </div>
      <div id="response-score-section" class="chart-card chart-full" style="display:none;">
        <h2>Response score — proximity × time discount (by route completion time)</h2>
        <div class="legend-note">score = max(0, 1 − d/D) × exp(−t_route/τ) · higher = found gas while completing route quickly</div>
        <div id="response-score-chart" style="height: 380px;"></div>
      </div>
      <div id="gas-rate-section" class="chart-card chart-full" style="display:none;">
        <h2 id="gas-rate-title">Gas dispersion model (Gaussian vs Inv Square)</h2>
        <div id="gas-rate-subtitle" class="legend-note"></div>
        <div id="gas-rate-chart" style="height: 380px;"></div>
      </div>
      <div id="gas-rate-diff-section" class="chart-card chart-full" style="display:none;">
        <h2>Paired difference (gaussian − inverse square)</h2>
        <div class="legend-note">95% CI shown · bar crossing zero = not statistically significant</div>
        <div id="gas-rate-diff-chart" style="height: 320px;"></div>
      </div>
      <div class="chart-card chart-full">
        <h2>Closeness by map</h2>
        <div id="per-map" class="small-multiples"></div>
      </div>
      <div class="chart-card chart-full">
        <h2>Waypoints hit by map (agents can skip waypoints)</h2>
        <div id="waypoints-per-map" style="height: 360px;"></div>
      </div>
      <div class="chart-card chart-full">
        <h2>Waypoint arrival pace</h2>
        <div class="legend-note">solid line = advances (reaches + skips) · dashed line = physical reaches only · the gap shows skipped waypoints</div>
        <div id="pace-per-map" class="small-multiples"></div>
      </div>
      <div class="chart-card chart-full">
        <h2>Arrival pace (per scenario)</h2>
        <div class="legend-note">The gap between solid and dashed = skipped, x-axis: time, y-axis: waypoint #</div>
        <div id="pace-per-run" class="small-multiples"></div>
      </div>
    </div>

    <footer>Generated by run/report.js</footer>
  </div>

  <script>
    const METRICS = __METRICS_JSON__;
    const NOISE_SWEEP = __NOISE_SWEEP_JSON__;
    const GAS_RATE = __GAS_RATE_JSON__;

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
    // Values are shown as (baseline.minDist - agent.minDist) so that positive = the agent
    // got closer to gas than baseline on that scenario, and the baseline sits on the zero line.
    function scatterChart() {
      const baselineIdx = METRICS.agents.findIndex(a => /^baseline/i.test(a.name))
      const useBaseline = baselineIdx >= 0
      const baselineByScen = new Map()
      if (useBaseline) {
        for (const r of METRICS.agents[baselineIdx].runs) {
          baselineByScen.set(r.scenarioIndex, r.minDistanceToGas)
        }
      }

      const agentCount = METRICS.agents.length
      const visibleAgents = METRICS.agents
        .map((a, i) => ({ a, i }))
        .filter(({ i }) => i !== baselineIdx)

      // Keep jitter slots consistent with the original agent indices so colors/positions
      // stay aligned even though baseline is hidden.
      const jitter = 0.18

      const data = visibleAgents.map(({ a: agent, i }) => ({
        type: 'scatter',
        mode: 'markers',
        name: agentLabel(i, agent.name),
        x: agent.runs.map(r => r.scenarioIndex + (i - (agentCount - 1) / 2) * jitter),
        y: agent.runs.map(r => {
          if (!useBaseline) return r.minDistanceToGas
          const b = baselineByScen.get(r.scenarioIndex)
          if (!Number.isFinite(b) || !Number.isFinite(r.minDistanceToGas)) return null
          return b - r.minDistanceToGas
        }),
        customdata: agent.runs.map(r => METRICS.scenarios[r.scenarioIndex].mapName.replace('.yaml', '')),
        marker: { color: COLORS[i % COLORS.length], size: 9, opacity: 0.85, line: { color: '#0f172a', width: 1 } },
        hovertemplate: useBaseline
          ? '<b>' + agent.name + '</b><br>scenario %{x:.0f} · %{customdata}<br>Δ vs baseline: %{y:+.1f}<extra></extra>'
          : '<b>' + agent.name + '</b><br>scenario %{x:.0f} · %{customdata}<br>min dist: %{y:.1f}<extra></extra>',
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
        yaxis: {
          ...BASE_LAYOUT.yaxis,
          title: {
            text: useBaseline ? 'units closer to gas (how much better than baseline)' : 'min distance to gas',
            font: { color: MUTED, size: 11 },
          },
          zeroline: useBaseline,
          zerolinecolor: useBaseline ? 'rgba(241, 245, 249, 0.45)' : GRID,
          zerolinewidth: useBaseline ? 2 : 1,
          rangemode: useBaseline ? 'normal' : 'tozero',
        },
        shapes: useBaseline ? [{
          type: 'line',
          xref: 'paper', x0: 0, x1: 1,
          yref: 'y', y0: 0, y1: 0,
          line: { color: 'rgba(241, 245, 249, 0.5)', width: 1.5, dash: 'dash' },
          layer: 'below',
        }] : [],
        annotations: useBaseline ? [{
          xref: 'paper', x: 0.998, xanchor: 'right',
          yref: 'y', y: 0, yanchor: 'bottom',
          text: 'baseline',
          showarrow: false,
          font: { color: MUTED, size: 10 },
          bgcolor: 'rgba(15, 23, 42, 0.85)',
          borderpad: 2,
        }] : [],
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

    // ── Helper: scenarios grouped by map ─────────────
    function scenariosByMap() {
      const byMap = new Map()
      for (const s of METRICS.scenarios) {
        if (!byMap.has(s.mapName)) byMap.set(s.mapName, new Set())
        byMap.get(s.mapName).add(s.index)
      }
      return byMap
    }

    function routeTotalForMap(mapName) {
      // All runs of the same map report the same routeWaypointsTotal;
      // pick the first finite one we find across any agent.
      for (const agent of METRICS.agents) {
        for (const run of agent.runs) {
          if (METRICS.scenarios[run.scenarioIndex].mapName === mapName
              && Number.isFinite(run.routeWaypointsTotal)) {
            return run.routeWaypointsTotal
          }
        }
      }
      return 0
    }

    // ── Waypoints hit by map — grouped bar chart ─────
    function waypointsPerMapChart() {
      const mapNames = Array.from(new Set(METRICS.scenarios.map(s => s.mapName))).sort()
      const byMap = scenariosByMap()
      const totals = mapNames.map(m => routeTotalForMap(m))

      const traces = METRICS.agents.map((agent, i) => {
        const meansPct = []
        const stdsPct = []
        const counts = []
        const meansAbs = []
        for (let mi = 0; mi < mapNames.length; mi++) {
          const mapName = mapNames[mi]
          const total = totals[mi] || 0
          const scenIdxs = byMap.get(mapName)
          const hits = agent.runs
            .filter(r => scenIdxs.has(r.scenarioIndex))
            .map(r => r.routeWaypointsHit)
            .filter(Number.isFinite)
          const meanAbs = hits.length ? hits.reduce((a, b) => a + b, 0) / hits.length : 0
          const stdAbs  = hits.length > 1
            ? Math.sqrt(hits.reduce((a, b) => a + (b - meanAbs) ** 2, 0) / (hits.length - 1))
            : 0
          meansAbs.push(meanAbs)
          meansPct.push(total > 0 ? (meanAbs / total) * 100 : 0)
          stdsPct.push(total > 0 ? (stdAbs / total) * 100 : 0)
          counts.push(hits.length)
        }
        return {
          type: 'bar',
          name: agentLabel(i, agent.name),
          x: mapNames.map(m => m.replace('.yaml', '')),
          y: meansPct,
          error_y: { type: 'data', array: stdsPct, visible: true, color: MUTED, thickness: 1.5, width: 4 },
          marker: { color: COLORS[i % COLORS.length], line: { width: 0 } },
          customdata: meansPct.map((_, k) => [counts[k], totals[k], meansAbs[k]]),
          hovertemplate: '<b>' + agent.name + '</b><br>%{x}<br>%{y:.0f}%  (%{customdata[2]:.1f} / %{customdata[1]} wp)<br>n=%{customdata[0]} runs<extra></extra>',
        }
      })

      const tickText = mapNames.map((m, k) =>
        m.replace('.yaml', '') + ' <span style="color:' + MUTED + ';font-size:10px">(/' + totals[k] + ')</span>'
      )

      const layout = {
        ...BASE_LAYOUT,
        barmode: 'group',
        bargap: 0.25,
        bargroupgap: 0.08,
        showlegend: true,
        legend: { orientation: 'h', y: -0.22, font: { color: TEXT, size: 12 }, bgcolor: 'transparent' },
        xaxis: {
          ...BASE_LAYOUT.xaxis,
          tickmode: 'array',
          tickvals: mapNames.map(m => m.replace('.yaml', '')),
          ticktext: tickText,
          automargin: true,
        },
        yaxis: {
          ...BASE_LAYOUT.yaxis,
          title: { text: 'physical reaches (% of route length)', font: { color: MUTED, size: 11 } },
          range: [0, 105],
          ticksuffix: '%',
        },
        margin: { l: 60, r: 20, t: 10, b: 100 },
      }
      Plotly.newPlot('waypoints-per-map', traces, layout, PLOTLY_CONFIG)
    }

    // ── Helper: build a mean cumulative-count step curve from multiple runs' event
    //    time arrays. Given [run1Times, run2Times, ...], returns {xs, ys} where at
    //    each merged event time t, ys = mean(count of events in run_i with time <= t).
    //    Monotonic in t. The curve is extended flat to xMax.
    function meanCumulativeCurve(perRunTimes, xMax) {
      const nonEmpty = perRunTimes.filter(a => Array.isArray(a))
      if (nonEmpty.length === 0) return { xs: [0, xMax], ys: [0, 0] }
      const allTimes = Array.from(new Set(nonEmpty.flatMap(a => a))).sort((a, b) => a - b)
      const xs = [0]
      const ys = [0]
      for (const t of allTimes) {
        if (t > xMax) break
        let sum = 0
        for (const arr of nonEmpty) {
          for (const h of arr) if (h <= t) sum++
        }
        xs.push(t)
        ys.push(sum / nonEmpty.length)
      }
      // Extend line flat to xMax so short trajectories don't look cut off.
      xs.push(xMax)
      ys.push(ys[ys.length - 1])
      return { xs, ys }
    }

    // ── Waypoint arrival pace — small multiples (averaged across runs per map) ─
    // Per map: step plot of mean cumulative-advances / hits vs virtual time.
    // Solid line: reaches + skips (advances through the route).
    // Dashed line: physical reaches only.
    // The gap between them = mean number of skipped waypoints.
    function wayPointPaceCharts() {
      const mapNames = Array.from(new Set(METRICS.scenarios.map(s => s.mapName))).sort()
      const container = document.getElementById('pace-per-map')
      container.innerHTML = ''
      const byMap = scenariosByMap()
      const seconds = METRICS.meta.seconds

      const pending = mapNames.map(mapName => {
        const wrap = document.createElement('div')
        wrap.className = 'small-multiple'
        const title = document.createElement('div')
        title.className = 'small-multiple-title'
        const total = routeTotalForMap(mapName)
        title.textContent = mapName.replace('.yaml', '') + ' (' + total + ' wp)'
        wrap.appendChild(title)
        const chartDiv = document.createElement('div')
        chartDiv.style.height = '220px'
        wrap.appendChild(chartDiv)
        container.appendChild(wrap)
        return { mapName, chartDiv, total }
      })

      pending.forEach(({ mapName, chartDiv, total }) => {
        const scenIdxs = byMap.get(mapName)

        // x-range: cap at the max advance time seen across all agents+runs, × 1.1.
        let xMax = 0
        METRICS.agents.forEach(agent => {
          agent.runs
            .filter(r => scenIdxs.has(r.scenarioIndex))
            .forEach(r => {
              for (const arr of [r.routeAdvanceTimes, r.routeHitTimes]) {
                if (!Array.isArray(arr)) continue
                for (const t of arr) if (t > xMax) xMax = t
              }
            })
        })
        xMax = Math.min(seconds, Math.max(xMax * 1.1, 30))

        const traces = []
        METRICS.agents.forEach((agent, i) => {
          const runs = agent.runs.filter(r => scenIdxs.has(r.scenarioIndex))
          if (runs.length === 0) return

          const advanceCurve = meanCumulativeCurve(runs.map(r => r.routeAdvanceTimes || []), xMax)
          const hitCurve     = meanCumulativeCurve(runs.map(r => r.routeHitTimes     || []), xMax)

          traces.push({
            type: 'scatter',
            mode: 'lines',
            name: agentLabel(i, agent.name),
            x: advanceCurve.xs,
            y: advanceCurve.ys,
            line: { color: COLORS[i % COLORS.length], width: 2, shape: 'hv' },
            hovertemplate: '<b>' + agent.name + '</b><br>t=%{x:.1f}s → %{y:.1f} advances<extra></extra>',
            legendgroup: 'a' + i,
          })
          traces.push({
            type: 'scatter',
            mode: 'lines',
            name: agentLabel(i, agent.name) + ' (hits)',
            x: hitCurve.xs,
            y: hitCurve.ys,
            line: { color: COLORS[i % COLORS.length], width: 1.5, shape: 'hv', dash: 'dot' },
            opacity: 0.7,
            showlegend: false,
            hovertemplate: '<b>' + agent.name + '</b> (hits)<br>t=%{x:.1f}s → %{y:.1f} hit<extra></extra>',
            legendgroup: 'a' + i,
          })
        })

        const layout = {
          ...BASE_LAYOUT,
          margin: { l: 38, r: 10, t: 6, b: 30 },
          showlegend: false,
          xaxis: {
            ...BASE_LAYOUT.xaxis,
            range: [0, xMax],
            tickfont: { color: MUTED, size: 9 },
            title: { text: 'seconds', font: { color: MUTED, size: 9 }, standoff: 4 },
          },
          yaxis: {
            ...BASE_LAYOUT.yaxis,
            rangemode: 'tozero',
            range: [0, total + 0.5],
            dtick: Math.max(1, Math.ceil(total / 5)),
            tickfont: { color: MUTED, size: 9 },
          },
        }
        Plotly.newPlot(chartDiv, traces, layout, PLOTLY_CONFIG)
      })
    }

    // ── Per-run waypoint arrival pace — one mini chart per scenario ──
    // Each chart shows every agent's trajectory for a single run: solid = advances,
    // dashed = hits. Lets you inspect variability that the averaged chart smooths over.
    function perRunPaceCharts() {
      const container = document.getElementById('pace-per-run')
      container.innerHTML = ''
      const seconds = METRICS.meta.seconds

      const pending = METRICS.scenarios.map(s => {
        const wrap = document.createElement('div')
        wrap.className = 'small-multiple'
        const title = document.createElement('div')
        title.className = 'small-multiple-title'
        const total = routeTotalForMap(s.mapName)
        title.textContent = '#' + s.index + ' · ' + s.mapName.replace('.yaml', '') + ' (' + total + ' wp)'
        wrap.appendChild(title)
        const chartDiv = document.createElement('div')
        chartDiv.style.height = '170px'
        wrap.appendChild(chartDiv)
        container.appendChild(wrap)
        return { scenario: s, chartDiv, total }
      })

      pending.forEach(({ scenario, chartDiv, total }) => {
        const scenIdx = scenario.index

        // x-range: cap at max advance time in any agent on this run, × 1.1.
        let xMax = 0
        METRICS.agents.forEach(agent => {
          const run = agent.runs.find(r => r.scenarioIndex === scenIdx)
          if (!run) return
          for (const arr of [run.routeAdvanceTimes, run.routeHitTimes]) {
            if (!Array.isArray(arr)) continue
            for (const t of arr) if (t > xMax) xMax = t
          }
        })
        xMax = Math.min(seconds, Math.max(xMax * 1.1, 30))

        const stepPlot = (times, xMax) => {
          const arr = Array.isArray(times) ? [...times].sort((a, b) => a - b) : []
          const xs = [0]
          const ys = [0]
          for (const t of arr) {
            if (t > xMax) break
            xs.push(t)
            ys.push(ys[ys.length - 1] + 1)
          }
          xs.push(xMax)
          ys.push(ys[ys.length - 1])
          return { xs, ys }
        }

        const traces = []
        METRICS.agents.forEach((agent, i) => {
          const run = agent.runs.find(r => r.scenarioIndex === scenIdx)
          if (!run) return
          const advance = stepPlot(run.routeAdvanceTimes, xMax)
          const hit     = stepPlot(run.routeHitTimes, xMax)
          traces.push({
            type: 'scatter', mode: 'lines',
            x: advance.xs, y: advance.ys,
            line: { color: COLORS[i % COLORS.length], width: 1.6, shape: 'hv' },
            showlegend: false,
            hovertemplate: '<b>' + agent.name + '</b><br>t=%{x:.1f}s → %{y} advances<extra></extra>',
          })
          traces.push({
            type: 'scatter', mode: 'lines',
            x: hit.xs, y: hit.ys,
            line: { color: COLORS[i % COLORS.length], width: 1.2, shape: 'hv', dash: 'dot' },
            opacity: 0.65,
            showlegend: false,
            hovertemplate: '<b>' + agent.name + '</b> (hits)<br>t=%{x:.1f}s → %{y} hit<extra></extra>',
          })
        })

        const layout = {
          ...BASE_LAYOUT,
          margin: { l: 34, r: 8, t: 4, b: 24 },
          showlegend: false,
          xaxis: {
            ...BASE_LAYOUT.xaxis,
            range: [0, xMax],
            tickfont: { color: MUTED, size: 9 },
          },
          yaxis: {
            ...BASE_LAYOUT.yaxis,
            rangemode: 'tozero',
            range: [0, total + 0.5],
            dtick: Math.max(1, Math.ceil(total / 4)),
            tickfont: { color: MUTED, size: 9 },
          },
        }
        Plotly.newPlot(chartDiv, traces, layout, PLOTLY_CONFIG)
      })
    }

    function noiseSweepChart() {
      if (!NOISE_SWEEP) return
      const section = document.getElementById('noise-sweep-section')
      section.style.display = ''
      const m = NOISE_SWEEP.meta
      document.getElementById('noise-sweep-subtitle').textContent =
        m.runs + ' runs × ' + m.seconds + 's per noise level · seed=' + m.seed +
        ' · noise levels: ' + m.noiseLevels.join(', ')

      const traces = NOISE_SWEEP.agents.map((agent, i) => {
        const xs = agent.data.map(d => d.noise)
        const ys = agent.data.map(d => d.minDistMean)
        const errHi = agent.data.map(d => d.minDistStd / Math.sqrt(d.agg.minDistanceToGas.n))
        return {
          type: 'scatter',
          mode: 'lines+markers',
          name: agent.name,
          x: xs,
          y: ys,
          error_y: {
            type: 'data',
            array: errHi,
            visible: true,
            color: COLORS[i % COLORS.length],
            thickness: 1.5,
            width: 4,
          },
          line: { color: COLORS[i % COLORS.length], width: 2.5 },
          marker: { color: COLORS[i % COLORS.length], size: 7 },
          hovertemplate: '<b>' + agent.name + '</b><br>noise σ=%{x}<br>min dist: %{y:.1f} ± %{error_y.array:.1f}<extra></extra>',
        }
      })

      const layout = {
        ...BASE_LAYOUT,
        showlegend: true,
        legend: { orientation: 'h', y: -0.18, font: { color: TEXT, size: 12 }, bgcolor: 'transparent' },
        xaxis: {
          ...BASE_LAYOUT.xaxis,
          title: { text: 'gas noise std dev (PPM)', font: { color: MUTED, size: 12 } },
        },
        yaxis: {
          ...BASE_LAYOUT.yaxis,
          title: { text: 'min distance to gas source (lower is better)', font: { color: MUTED, size: 12 } },
          rangemode: 'tozero',
        },
        margin: { l: 70, r: 20, t: 10, b: 60 },
      }
      Plotly.newPlot('noise-sweep-chart', traces, layout, PLOTLY_CONFIG)
    }

    function computeCompositeFromAgg(dataPoint, timeKey) {
      const m = NOISE_SWEEP.meta
      const D = 200  // gasRadius
      const maxT = m.seconds
      const tau = maxT / 4

      const distAgg = dataPoint.agg.minDistanceToGas
      const timeAgg = dataPoint.agg[timeKey]
      if (!distAgg || !timeAgg) return { mean: 0, se: 0 }

      // If we have per-run composite scores, prefer those
      if (dataPoint.detectionScore && timeKey === 'timeToFirstWithin50') {
        return { mean: dataPoint.detectionScore.mean, se: dataPoint.detectionScore.std / Math.sqrt(dataPoint.detectionScore.n || 1) }
      }
      if (dataPoint.responseScore && timeKey === 'timeToCompleteRoute') {
        return { mean: dataPoint.responseScore.mean, se: dataPoint.responseScore.std / Math.sqrt(dataPoint.responseScore.n || 1) }
      }

      // Fallback: approximate from aggregated means
      const proximity = Math.max(0, 1 - distAgg.mean / D)
      const t = Number.isFinite(timeAgg.mean) ? timeAgg.mean : maxT
      if (timeKey === 'timeToFirstWithin50') {
        // Inverse-square time penalty
        return { mean: proximity / (1 + (t / tau) ** 2), se: 0 }
      } else {
        // Exponential discount for route completion
        const tauExp = maxT / (4 * Math.LN2)
        return { mean: proximity * Math.exp(-t / tauExp), se: 0 }
      }
    }

    function noiseCompositeChart(timeKey, chartId, sectionId, yLabel) {
      if (!NOISE_SWEEP) return
      document.getElementById(sectionId).style.display = ''

      const traces = NOISE_SWEEP.agents.map((agent, i) => {
        const xs = agent.data.map(d => d.noise)
        const scores = agent.data.map(d => computeCompositeFromAgg(d, timeKey))
        return {
          type: 'scatter',
          mode: 'lines+markers',
          name: agent.name,
          x: xs,
          y: scores.map(s => s.mean),
          error_y: {
            type: 'data',
            array: scores.map(s => s.se),
            visible: true,
            color: COLORS[i % COLORS.length],
            thickness: 1.5,
            width: 4,
          },
          line: { color: COLORS[i % COLORS.length], width: 2.5 },
          marker: { color: COLORS[i % COLORS.length], size: 7 },
          hovertemplate: '<b>' + agent.name + '</b><br>noise σ=%{x}<br>score: %{y:.3f}<extra></extra>',
        }
      })

      const layout = {
        ...BASE_LAYOUT,
        showlegend: true,
        legend: { orientation: 'h', y: -0.18, font: { color: TEXT, size: 12 }, bgcolor: 'transparent' },
        xaxis: {
          ...BASE_LAYOUT.xaxis,
          title: { text: 'gas noise std dev (PPM)', font: { color: MUTED, size: 12 } },
        },
        yaxis: {
          ...BASE_LAYOUT.yaxis,
          title: { text: yLabel, font: { color: MUTED, size: 12 } },
          rangemode: 'tozero',
        },
        margin: { l: 70, r: 20, t: 10, b: 60 },
      }
      Plotly.newPlot(chartId, traces, layout, PLOTLY_CONFIG)
    }

    function gasRateChart() {
      if (!GAS_RATE) return
      document.getElementById('gas-rate-section').style.display = ''
      document.getElementById('gas-rate-diff-section').style.display = ''

      const m = GAS_RATE.meta
      document.getElementById('gas-rate-title').textContent =
        'Gas dispersion model (Gaussian vs Inv Square) — ' + m.agent
      document.getElementById('gas-rate-subtitle').textContent =
        m.runs + ' runs × ' + m.seconds + 's · seed=' + m.seed +
        ' · maps: ' + m.maps.map(n => n.replace('.yaml', '')).join(', ')

      const models = ['gaussian', 'inverse_square']
      const modelColors = [COLORS[0], COLORS[1]]
      const modelLabels = ['Gaussian', 'Inverse Square']

      const metricDefs = [
        { key: 'minDistanceToGas',    label: 'Min dist to gas',       lower: true,  fmt: 1 },
        { key: 'meanDistanceToGas',   label: 'Mean dist to gas',      lower: true,  fmt: 1 },
        { key: 'maxGasReading',       label: 'Peak gas (ppm)',        lower: false, fmt: 3 },
        { key: 'timeToFirstWithin50', label: 'Time to within 50',     lower: true,  fmt: 1 },
        { key: 'timeToCompleteRoute', label: 'Route completion time', lower: true,  fmt: 1 },
        { key: 'routeWaypointsHit',   label: 'Waypoints hit',         lower: false, fmt: 1 },
      ]

      // Grouped bar chart
      const traces = models.map((model, mi) => ({
        type: 'bar',
        name: modelLabels[mi],
        x: metricDefs.map(d => d.label),
        y: metricDefs.map(d => {
          const agg = GAS_RATE[model][d.key]
          return agg ? agg.mean : 0
        }),
        error_y: {
          type: 'data',
          array: metricDefs.map(d => {
            const agg = GAS_RATE[model][d.key]
            return agg ? agg.se * 1.96 : 0
          }),
          visible: true,
          color: MUTED,
          thickness: 1.5,
          width: 4,
        },
        marker: { color: modelColors[mi], line: { width: 0 } },
        customdata: metricDefs.map(d => {
          const agg = GAS_RATE[model][d.key]
          return agg ? [agg.mean, agg.std, agg.reached || agg.n, agg.total || agg.n] : [0, 0, 0, 0]
        }),
        hovertemplate: '<b>' + modelLabels[mi] + '</b><br>%{x}<br>mean: %{customdata[0]:.2f} ± %{customdata[1]:.2f}<br>n=%{customdata[2]}/%{customdata[3]}<extra></extra>',
      }))

      const layout = {
        ...BASE_LAYOUT,
        barmode: 'group',
        bargap: 0.25,
        bargroupgap: 0.08,
        showlegend: true,
        legend: { orientation: 'h', y: -0.22, font: { color: TEXT, size: 12 }, bgcolor: 'transparent' },
        xaxis: { ...BASE_LAYOUT.xaxis, automargin: true },
        yaxis: { ...BASE_LAYOUT.yaxis, title: { text: 'value', font: { color: MUTED, size: 11 } } },
        margin: { l: 60, r: 20, t: 10, b: 120 },
      }
      Plotly.newPlot('gas-rate-chart', traces, layout, PLOTLY_CONFIG)

      // Paired difference chart
      const pd = GAS_RATE.paired_difference
      const diffMetrics = metricDefs.filter(d => pd[d.key])
      const diffTrace = {
        type: 'bar',
        orientation: 'h',
        x: diffMetrics.map(d => pd[d.key].mean),
        y: diffMetrics.map(d => d.label),
        error_x: {
          type: 'data',
          symmetric: false,
          array: diffMetrics.map(d => pd[d.key].ci_hi - pd[d.key].mean),
          arrayminus: diffMetrics.map(d => pd[d.key].mean - pd[d.key].ci_lo),
          visible: true,
          color: MUTED,
          thickness: 1.5,
          width: 6,
        },
        marker: {
          color: diffMetrics.map(d => pd[d.key].significant ? '#22d3ee' : '#64748b'),
          line: { width: 0 },
        },
        customdata: diffMetrics.map(d => [
          pd[d.key].significant ? 'significant' : 'not significant',
          pd[d.key].ci_lo,
          pd[d.key].ci_hi,
        ]),
        hovertemplate: '%{y}<br>Δ mean: %{x:.3f}<br>95% CI: [%{customdata[1]:.3f}, %{customdata[2]:.3f}]<br>%{customdata[0]}<extra></extra>',
      }

      const diffLayout = {
        ...BASE_LAYOUT,
        xaxis: {
          ...BASE_LAYOUT.xaxis,
          title: { text: 'difference (gaussian − inverse square)', font: { color: MUTED, size: 11 } },
          zeroline: true,
          zerolinecolor: 'rgba(241, 245, 249, 0.5)',
          zerolinewidth: 2,
        },
        yaxis: { ...BASE_LAYOUT.yaxis, automargin: true },
        margin: { l: 180, r: 30, t: 10, b: 50 },
        shapes: [{
          type: 'line',
          xref: 'x', x0: 0, x1: 0,
          yref: 'paper', y0: 0, y1: 1,
          line: { color: 'rgba(241, 245, 249, 0.4)', width: 1.5, dash: 'dash' },
          layer: 'below',
        }],
      }
      Plotly.newPlot('gas-rate-diff-chart', [diffTrace], diffLayout, PLOTLY_CONFIG)
    }

    renderMeta()
    renderSummary()
    closenessChart()
    routeChart()
    scatterChart()
    noiseSweepChart()
    noiseCompositeChart('timeToFirstWithin50', 'detection-score-chart', 'detection-score-section', 'detection score (higher = got close fast)')
    noiseCompositeChart('timeToCompleteRoute', 'response-score-chart', 'response-score-section', 'response score (higher = found gas + completed route fast)')
    gasRateChart()
    ecdfChart()
    perMapCharts()
    waypointsPerMapChart()
    wayPointPaceCharts()
    perRunPaceCharts()
  </script>
</body>
</html>`

await main()

# Gas Simulator

2D gas simulator for testing robot exploration strategies, running in the browser. A robot navigates a map, follows routes, and detects/chases gas plumes.

## Architecture

| File | Role |
|---|---|
| `main.js` | Entry point. Sets up canvas, map, simulator, wires agents via pub/sub, handles UI. |
| `main/systems/simulator.js` | Core engine: robot physics, gas sensing (Gaussian plumes), clock/tick loop. |
| `main/systems/canvas.js` | Generic 2D pan/zoom canvas rendering. |
| `main/systems/map.js` | Map data & UI (obstacles, gas nodes, routes, markers). Loads YAML from `maps/`. |
| `main/tooling/pubsub.js` | Reactive pub/sub bus. `connectNeoAgent(pubsub, agent, getTime)` wires agents. |
| `main/tooling/math_helpers.js` | Vector/angle utilities. |
| `main/tooling/time.js` | Timer utility. |

## Simulator Lifecycle

1. **Init** — `createCanvasSystem()`, `createMapSystem()`, `createSimulator()` in `main.js`.
2. **Play** — User clicks Play; calls `sim.startAgentLoop(pubsub, config)`.
3. **Each tick** (via `requestAnimationFrame`):
   - Simulator publishes `odom` (x, y, heading), `gas_reading` (PPM), `time` on pub/sub.
   - Agents react: subscribe to channels, compute, publish outputs.
   - Simulator receives `movement` commands, updates robot with obstacle avoidance.
   - Canvas re-renders.
4. Gas sensing: `ppm = peak * exp(-d^2 / 2r^2)` summed over all gas nodes, optional Gaussian noise.

## Pub/Sub Channels

| Channel | Producer | Consumer | Data |
|---|---|---|---|
| `odom` | Simulator | local_planner, agents | `{x, y, heading}` |
| `position` | Bridge (odom→position) | gas/route agents | `{x, y, heading}` |
| `time` | Simulator | agents | `{virtualTime}` |
| `gas_reading` | Simulator | gas agents | PPM float |
| `targetWaypoint` | gas/route agents | local_planner | `{x, y}` |
| `movement` | local_planner | Simulator | `{linearVelocity, angularVelocity}` |
| `waypointReached` | local_planner | route/gas agents | `{waypoint}` |
| `routeUpdate` | UI/map | route/gas agents | route data |
| `logJson` | any agent | UI | arbitrary JSON |
| `visualizePoints`/`visualizeLines` | gas agents | UI | drawing data |

## Neo Agent Interface (`main/agents/neo/`)

All neo agents follow this pattern:
```javascript
{
  initialArg: { updated: {}, state: {}, outputs: {} },
  info: { inputs: [...], outputs: [...] },
  update(getTime, { state, updated }) {
    // Pure function → returns { state, outputs }
  }
}
```

Connected via `connectNeoAgent(pubsub, agent, getTime)` in `pubsub.js`.

## Neo Agents

### `simple_route_agent.js` — Waypoint follower
- Follows a sequence of waypoints from a route.
- Skips waypoints if forward progress < `minProgress` (10 units/sec) after `gracePeriod` (0.5s).
- Inputs: `position`, `routeUpdate`, `waypointReached`. Outputs: `targetWaypoint`.

### `local_planner.js` — Movement controller
- Converts `targetWaypoint` → `movement` commands.
- **Greedy mode**: steer toward target (`angularGain=0.5`, `maxAngularVelocity=0.5`).
- **Stuck detection**: tracks last 10 odom samples; if progress < 0.1 units over 3s, switches to random walk.
- **Random mode**: picks random heading, moves up to 45 units or 2s, then back to greedy.
- Publishes `waypointReached` when distance < 0.1 units.

### `greedy_gas_agent.js` — Simple gradient gas follower
- Dual mode: `routeFollow` (delegates to simple_route_agent) and `gasFollow`.
- Accumulates gas readings in buffer (max 200).
- Computes gradient via **weighted least-squares plane fit** (`gas = ax + by + c`, weight = 1/(dist+1)).
- Switches to gasFollow when: max gas > 0.4 PPM AND gradient slope > 0.002.
- In gasFollow: perturbs current heading by up to 0.3 rad, places waypoint 30 units ahead.
- Returns to routeFollow when recent best drops below 70% of peak.

### `gas_agent.js` — Circle-sampling gas follower
- Same gradient computation, but places a **circle of 8 waypoints** around the projected gas source.
- Circle center: `gradientCenterDist` (50) units along gradient. Radius: 60 units.
- Recomputes circle every `gasMoveOnTime` (20s).
- Uses a second `simple_route_agent` internally to follow the circle waypoints.

## Gas Gradient Computation (shared by both gas agents)

`gasGradient(buffer)` in `gas_agent.js` (also used by greedy):
- Weighted least-squares fit of plane through `{x, y, gas}` samples.
- Weight = `1 / (distance_to_newest_point + 1)`.
- Returns `{ angle, slope }` — angle is steepest ascent direction.
- Needs `minSamplesForGradient` (3) entries minimum.

## Config (from main.js)

```javascript
agentConfig = {
  decisionRate: 0.05,      // seconds between decisions
  samplingRate: 80,         // ticks between gas samples
  gasNoiseStdDev: 0,        // noise on gas readings
  maxMoveSpeed: 200,        // max linear velocity
}
```

## Dev Server

`./run/serve` starts a deno file server (default port 8765).

## Notes

- `proofshot-artifacts/` is gitignored.
- For proofshot verification, use `AGENT_BROWSER_EXECUTABLE_PATH="/Applications/Chromium.app/Contents/MacOS/Chromium"` and run proofshot via `deno run -A --config /Users/jeffhykin/.deno/bin/.proofshot/deno.json 'npm:proofshot'` (the plain `proofshot` command lacks `--allow-env`).

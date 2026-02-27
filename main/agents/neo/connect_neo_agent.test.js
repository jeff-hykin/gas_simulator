#!/usr/bin/env -S deno run --allow-all

import { createPubSub, connectNeoAgent } from '../../tooling/pubsub.js'
import LocalPlanner from './local_planner.js'
import SimpleRouteAgent from './simple_route_agent.js'

// ── Helpers ───────────────────────────────────────────────────────────

function assert(condition, message) {
    if (!condition) throw new Error(message ?? 'assertion failed')
}
function assertEq(a, b, message) {
    if (a !== b) throw new Error(`${message ?? 'assertEq'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}
function assertNull(v, message) {
    if (v !== null && v !== undefined) throw new Error(`${message ?? 'assertNull'}: expected null, got ${JSON.stringify(v)}`)
}
function assertNotNull(v, message) {
    if (v === null || v === undefined) throw new Error(`${message ?? 'assertNotNull'}: expected non-null`)
}

// Build a minimal neoAgent for unit tests without pulling in real agent logic.
function makeAgent({ inputs, outputChannels = [], updateFn }) {
    const initialOutputs = Object.fromEntries(outputChannels.map(ch => [ch, null]))
    return {
        initialArg: {
            state: Object.fromEntries(inputs.map(ch => [ch, null])),
            outputs: initialOutputs,
        },
        info: { inputs, outputs: outputChannels },
        update: updateFn,
    }
}

// ── Unit tests ────────────────────────────────────────────────────────

// published value appears in state[channel]
{
    const pubsub = createPubSub()
    let capturedState = null
    const agent = makeAgent({
        inputs: ['foo'],
        updateFn(getTime, { state }) {
            capturedState = state
            return { state, outputs: {} }
        },
    })
    connectNeoAgent(pubsub, agent)
    pubsub.publish('foo', { value: 42 })
    assertNotNull(capturedState, 'update should be called')
    assertEq(capturedState.foo?.value, 42, 'state.foo should equal the published value')
    console.log('✓ published value appears in state[channel]')
}

// updated[channel] is true; all other inputs are false
{
    const pubsub = createPubSub()
    let capturedUpdated = null
    const agent = makeAgent({
        inputs: ['foo', 'bar', 'baz'],
        updateFn(getTime, { state, updated }) {
            capturedUpdated = updated
            return { state, outputs: {} }
        },
    })
    connectNeoAgent(pubsub, agent)
    pubsub.publish('bar', 1)
    assertEq(capturedUpdated.foo, false, 'foo should be false')
    assertEq(capturedUpdated.bar, true,  'bar should be true (the one that fired)')
    assertEq(capturedUpdated.baz, false, 'baz should be false')
    console.log('✓ updated[channel] is true; all other inputs are false')
}

// non-null output values get published back to pubsub
{
    const pubsub = createPubSub()
    let received = null
    pubsub.subscribe('result', (data) => { received = data })
    const agent = makeAgent({
        inputs: ['trigger'],
        outputChannels: ['result'],
        updateFn(getTime, { state }) {
            return { state, outputs: { result: 'hello' } }
        },
    })
    connectNeoAgent(pubsub, agent)
    pubsub.publish('trigger', true)
    assertEq(received, 'hello', 'non-null output should be published')
    console.log('✓ non-null output values get published back to pubsub')
}

// null output values do not publish
{
    const pubsub = createPubSub()
    let fired = false
    pubsub.subscribe('result', () => { fired = true })
    const agent = makeAgent({
        inputs: ['trigger'],
        outputChannels: ['result'],
        updateFn(getTime, { state }) {
            return { state, outputs: { result: null } }
        },
    })
    connectNeoAgent(pubsub, agent)
    pubsub.publish('trigger', true)
    assert(!fired, 'null output should not publish')
    console.log('✓ null output values do not publish')
}

// state from previous update is passed to the next call
{
    const pubsub = createPubSub()
    const seen = []
    const agent = makeAgent({
        inputs: ['tick'],
        updateFn(getTime, { state }) {
            seen.push(state.count)
            return { state: { count: state.count + 1 }, outputs: {} }
        },
    })
    agent.initialArg.state.count = 0
    connectNeoAgent(pubsub, agent)
    pubsub.publish('tick', null)
    pubsub.publish('tick', null)
    pubsub.publish('tick', null)
    assertEq(seen[0], 0, 'first call receives initial count 0')
    assertEq(seen[1], 1, 'second call receives count 1')
    assertEq(seen[2], 2, 'third call receives count 2')
    console.log('✓ state from previous update is passed to the next call')
}

// getTime function is threaded through to update
{
    const pubsub = createPubSub()
    let capturedTime = null
    const agent = makeAgent({
        inputs: ['tick'],
        updateFn(getTime, { state }) {
            capturedTime = getTime()
            return { state, outputs: {} }
        },
    })
    connectNeoAgent(pubsub, agent, () => 99)
    pubsub.publish('tick', null)
    assertEq(capturedTime, 99, 'getTime should be the function passed to connectNeoAgent')
    console.log('✓ getTime function is threaded through to update')
}

// non-input channels do not trigger update
{
    const pubsub = createPubSub()
    let callCount = 0
    const agent = makeAgent({
        inputs: ['foo'],
        updateFn(getTime, { state }) {
            callCount++
            return { state, outputs: {} }
        },
    })
    connectNeoAgent(pubsub, agent)
    pubsub.publish('bar', 1)
    pubsub.publish('baz', 2)
    pubsub.publish('unrelated', 3)
    assertEq(callCount, 0, 'update should not fire for non-input channels')
    console.log('✓ non-input channels do not trigger update')
}

// unsubscribe stops all updates
{
    const pubsub = createPubSub()
    let callCount = 0
    const agent = makeAgent({
        inputs: ['tick'],
        updateFn(getTime, { state }) {
            callCount++
            return { state, outputs: {} }
        },
    })
    const unsub = connectNeoAgent(pubsub, agent)
    pubsub.publish('tick', null)
    assertEq(callCount, 1, 'update called once before unsub')
    unsub()
    pubsub.publish('tick', null)
    pubsub.publish('tick', null)
    assertEq(callCount, 1, 'update not called after unsub')
    console.log('✓ unsubscribe stops all updates')
}

// multiple inputs: each independently triggers update
{
    const pubsub = createPubSub()
    const log = []
    const agent = makeAgent({
        inputs: ['a', 'b'],
        updateFn(getTime, { updated }) {
            if (updated.a) log.push('a')
            if (updated.b) log.push('b')
            return { state: {}, outputs: {} }
        },
    })
    connectNeoAgent(pubsub, agent)
    pubsub.publish('a', 1)
    pubsub.publish('b', 2)
    pubsub.publish('a', 3)
    assertEq(log.join(','), 'a,b,a', 'each input channel fires update independently')
    console.log('✓ multiple inputs each independently trigger update')
}

// outputs from update are passed as arg.outputs on the next call
{
    const pubsub = createPubSub()
    const seenOutputs = []
    const agent = makeAgent({
        inputs: ['tick'],
        outputChannels: ['result'],
        updateFn(getTime, { state, outputs }) {
            seenOutputs.push(outputs.result)
            return { state, outputs: { result: (outputs.result ?? 0) + 1 } }
        },
    })
    connectNeoAgent(pubsub, agent)
    pubsub.publish('tick', null)
    pubsub.publish('tick', null)
    assertEq(seenOutputs[0], null, 'first call sees initial null output')
    assertEq(seenOutputs[1], 1,    'second call sees output from first call')
    console.log('✓ outputs from update are passed as arg.outputs on the next call')
}

// ── Integration: SimpleRouteAgent ────────────────────────────────────

// publishes first targetWaypoint immediately on routeUpdate
{
    const pubsub = createPubSub()
    const waypoints = []
    pubsub.subscribe('targetWaypoint', (data) => waypoints.push(data))
    const agent = SimpleRouteAgent.create({})
    const unsub = connectNeoAgent(pubsub, agent, () => 0)
    pubsub.publish('routeUpdate', { waypoints: [{ x: 10, y: 0 }, { x: 20, y: 0 }] })
    assertEq(waypoints.length, 1, 'should emit first waypoint on routeUpdate')
    assertEq(waypoints[0].x, 10, 'first waypoint x=10')
    unsub()
    console.log('✓ SimpleRouteAgent: publishes first targetWaypoint on routeUpdate')
}

// advances to the next waypoint after waypointReached
{
    const pubsub = createPubSub()
    const waypoints = []
    pubsub.subscribe('targetWaypoint', (data) => waypoints.push(data))
    const agent = SimpleRouteAgent.create({})
    const unsub = connectNeoAgent(pubsub, agent, () => 0)
    pubsub.publish('routeUpdate', { waypoints: [{ x: 10, y: 0 }, { x: 20, y: 0 }] })
    pubsub.publish('waypointReached', { waypoint: { x: 10, y: 0 } })
    assertEq(waypoints.length, 2, 'should emit second waypoint after waypointReached')
    assertEq(waypoints[1].x, 20, 'second waypoint x=20')
    unsub()
    console.log('✓ SimpleRouteAgent: advances to next waypoint after waypointReached')
}

// no targetWaypoint published when route is empty
{
    const pubsub = createPubSub()
    let fired = false
    pubsub.subscribe('targetWaypoint', () => { fired = true })
    const agent = SimpleRouteAgent.create({})
    const unsub = connectNeoAgent(pubsub, agent, () => 0)
    pubsub.publish('position', { x: 0, y: 0 })
    assert(!fired, 'no targetWaypoint with empty route')
    unsub()
    console.log('✓ SimpleRouteAgent: no targetWaypoint published when route is empty')
}

// ── Integration: chained agents ───────────────────────────────────────
// Output of one agent auto-feeds into the input of the next via shared pubsub.

{
    const pubsub = createPubSub()

    // agentA: on 'raw', doubles the value and emits to 'processed'
    const agentA = makeAgent({
        inputs: ['raw'],
        outputChannels: ['processed'],
        updateFn(getTime, { state }) {
            return { state, outputs: { processed: state.raw * 2 } }
        },
    })

    // agentB: on 'processed', adds 1 and stores in state
    const agentB = makeAgent({
        inputs: ['processed'],
        updateFn(getTime, { state }) {
            return { state: { ...state, last: state.processed + 1 }, outputs: {} }
        },
    })

    let finalStateBLast = null
    const origUpdateB = agentB.update
    agentB.update = (getTime, arg) => {
        const result = origUpdateB(getTime, arg)
        finalStateBLast = result.state.last
        return result
    }

    connectNeoAgent(pubsub, agentA)
    connectNeoAgent(pubsub, agentB)

    pubsub.publish('raw', 5)
    // agentA receives raw=5 → emits processed=10
    // agentB receives processed=10 → state.last = 11
    assertEq(finalStateBLast, 11, 'chain: raw=5 → processed=10 → last=11')
    console.log('✓ chained agents: output of one feeds input of the next')
}

console.log('\nAll connectNeoAgent tests passed')

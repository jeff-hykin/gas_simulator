#!/usr/bin/env -S deno run --allow-all

/**
 * Create a simple publish/subscribe message bus.
 *
 * @example
 *   const pubsub = createPubSub()
 *   const unsub = pubsub.subscribe("gas_reading", (data) => console.log(data))
 *   pubsub.publish("gas_reading", { ppm: 1.5 })
 *   unsub()
 *
 * @returns {{ subscribe: Function, publish: Function }}
 */
export function createPubSub() {
    const subs = {}

    /**
     * Subscribe to a channel. Returns an unsubscribe function.
     * @param {string} channel
     * @param {Function} callback - (data) => void
     * @returns {Function} unsubscribe
     */
    function subscribe(channel, callback) {
        ;(subs[channel] ??= []).push(callback)
        return () => {
            const list = subs[channel]
            if (!list) return
            const idx = list.indexOf(callback)
            if (idx !== -1) list.splice(idx, 1)
        }
    }

    /**
     * Publish data to all subscribers on a channel.
     * @param {string} channel
     * @param {*} data
     */
    function publish(channel, data) {
        for (const cb of (subs[channel] ?? [])) cb(data)
    }

    return { subscribe, publish }
}

/**
 * Connect a neoAgent ({ initialArg, info, update }) to a pubsub instance.
 *
 * Subscribes to every channel listed in info.inputs. Whenever one fires:
 *   - state.<channel> is set to the published value
 *   - updated is a fresh object with only that channel set to true
 *   - neoAgent.update(getTime, { state, updated, outputs }) is called
 *   - any non-null value in the returned outputs is published back to pubsub
 *
 * @example
 *   import LocalPlanner from './neo/local_planner.js'
 *   const pubsub = createPubSub()
 *   const planner = LocalPlanner.create({ closeEnoughToWaypoint: 10 })
 *   const unsub = connectNeoAgent(pubsub, planner, getTime)
 *   unsub() // detach
 *
 * @param {object} pubsub    - { subscribe, publish }
 * @param {object} neoAgent  - { initialArg, info, update }
 * @param {Function} getTime - returns current virtual time (passed through to update)
 * @returns {Function} unsubscribe
 */
export function connectNeoAgent(pubsub, neoAgent, getTime = () => 0) {
    const { initialArg, info, update } = neoAgent

    let state = structuredClone(initialArg.state)
    let outputs = structuredClone(initialArg.outputs)

    // Template for updated: all inputs false, reset on every tick
    const zeroUpdated = Object.fromEntries(info.inputs.map(name => [name, false]))

    const unsubs = info.inputs.map(channel =>
        pubsub.subscribe(channel, (data) => {
            state = { ...state, [channel]: data }
            const updated = { ...zeroUpdated, [channel]: true }
            const result = update(getTime, { state, updated, outputs })
            state = result.state
            outputs = result.outputs
            for (const [ch, value] of Object.entries(outputs)) {
                if (value != null) pubsub.publish(ch, value)
            }
        })
    )

    return () => { for (const unsub of unsubs) unsub() }
}

export class Computed {
    constructor({pubsub, initValue, topics}, callback) {
        this.value = initValue
        const activeArg = {}
        this.subscribers = []
        this.unsubs = []
        const wrappedCallback = (...args)=>{
            this.value = callback(activeArg)
            for (let each of this.subscribers) {
                try {
                    this.value = each(this.value)
                } catch (error) {
                    console.warn(error.stack||error)
                }
            }
        }
        for (const [key, value] of Object.entries(topics)) {
            if (value instanceof Computed) {
                const computed = value
                this.unsubs.push(
                    value.subscribe((newValue)=>{
                        activeArg[key] = newValue
                        wrappedCallback(activeArg, key, computed)
                    })
                )
            } else {
                this.unsubs.push(
                    pubsub.subscribe(key, (value)=>{
                        activeArg[key] = value
                        wrappedCallback(activeArg, key)
                    })
                )
            }
        }
    }
    unsub() {
        for (const each of this.unsubs) {
            try {
                eachUnsub()
            } catch (error) {
                console.warn(error.stack||error)
            }
        }
        this.unsubs.length = 0
    }
    subscribe(callback) {
        this.subscribers.push(callback)
        return ()=>{
            const index = this.subscribers.indexOf(callback)
            if (index !== -1) this.subscribers.splice(index, 1)
        }
    }
}
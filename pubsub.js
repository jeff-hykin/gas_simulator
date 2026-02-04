/**
 * Create a simple publish/subscribe message bus.
 *
 * @example
 *   const ps = createPubSub()
 *   const unsub = ps.subscribe("gas_reading", (data) => console.log(data))
 *   ps.publish("gas_reading", { ppm: 1.5 })
 *   unsub()  // stop listening
 *
 * @returns {{ subscribe: (channel: string, cb: Function) => Function, publish: (channel: string, data: any) => void }}
 */
export function createPubSub() {
    const subs = {}

    /**
     * Subscribe to a channel. Returns an unsubscribe function.
     * @param {string} channel
     * @param {Function} callback
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
        const list = subs[channel]
        if (!list) return
        for (const cb of list) cb(data)
    }

    return { subscribe, publish }
}

/**
 * Create a publish/subscribe message bus with publisher identity tracking.
 * Prevents callbacks from being triggered by own publications.
 *
 * @example
 *   const ps = createPubSub("agent")
 *   const unsub = ps.subscribe("gas_reading", (data, publisher) => console.log(data, publisher))
 *   ps.publish("gas_reading", { ppm: 1.5 })  // won't trigger own callback
 *   unsub()  // stop listening
 *
 * @param {string} who - Identity of this publisher/subscriber
 * @returns {{ subscribe: (channel: string, cb: Function) => Function, publish: (channel: string, data: any) => void, who: string }}
 */
export function createPubSub(who = "anonymous") {
    const subs = {}

    /**
     * Subscribe to a channel. Returns an unsubscribe function.
     * Callback receives (data, publisher) and only fires if publisher !== this.who
     * @param {string} channel
     * @param {Function} callback - (data, publisher) => void
     * @returns {Function} unsubscribe
     */
    function subscribe(channel, callback) {
        const entry = { callback, subscriber: who }
        ;(subs[channel] ??= []).push(entry)
        return () => {
            const list = subs[channel]
            if (!list) return
            const idx = list.indexOf(entry)
            if (idx !== -1) list.splice(idx, 1)
        }
    }

    /**
     * Publish data to all subscribers on a channel (except self).
     * Allows communication when using default "anonymous" identity (shared pubsub).
     * @param {string} channel
     * @param {*} data
     */
    function publish(channel, data) {
        const list = subs[channel]
        if (!list) return
        for (const entry of list) {
            // Only call callback if publisher is different from subscriber
            // Exception: allow "anonymous" to communicate (shared pubsub use case)
            if (entry.subscriber !== who || who === "anonymous") {
                entry.callback(data, who)
            }
        }
    }

    return { subscribe, publish, who }
}

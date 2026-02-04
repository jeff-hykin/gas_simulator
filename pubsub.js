/**
 * Create a publish/subscribe message bus factory with publisher identity tracking.
 * Returns a function that requires an identity and returns a pubsub object.
 * Prevents callbacks from being triggered by own publications.
 *
 * @example
 *   const pubsubFactory = createPubSub()
 *   const agentPubsub = pubsubFactory("agent")
 *   const unsub = agentPubsub.subscribe("gas_reading", (data, publisher) => console.log(data, publisher))
 *   agentPubsub.publish("gas_reading", { ppm: 1.5 })  // won't trigger own callback
 *   unsub()  // stop listening
 *
 * @returns {(who: string) => { subscribe: Function, publish: Function, who: string }}
 */
export function createPubSub() {
    const subs = {}

    return function(who) {
        if (!who) throw new Error("pubsub requires an identity (who parameter)")

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
         * @param {string} channel
         * @param {*} data
         */
        function publish(channel, data) {
            const list = subs[channel]
            if (!list) return
            for (const entry of list) {
                // Only call callback if publisher is different from subscriber
                if (entry.subscriber !== who) {
                    entry.callback(data, who)
                }
            }
        }

        return { subscribe, publish, who }
    }
}

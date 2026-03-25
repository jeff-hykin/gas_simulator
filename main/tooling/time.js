/**
 * Create a time getter that subscribes to the simulator's clock.
 * Returns a synchronous function that returns the current simulation time.
 *
 * @param {object} pubsub - pubsub instance to subscribe to time updates
 * @returns {() => number} getTime function that returns current simulation time in seconds
 *
 * @example
 *   const pubsub = pubsubFactory("agent")
 *   const getTime = createGetTime(pubsub)
 *   const currentTime = getTime()
 */
export function createGetTime(pubsub) {
    let currentTime = 0

    // Subscribe to time updates from simulator
    pubsub.subscribe('time', (data, publisher) => {
        currentTime = data.virtualTime
    })

    // Return synchronous function that returns current time
    return function getTime() {
        return currentTime
    }
}

export function timer({duration, getTime, data}) {
    return {
        atStart: data,
        startTime: getTime(),
        endTime: getTime() + duration,
        isRunning: true,
        get done() {
            return getTime() >= this.endTime
        },
        get count() {
            return getTime() - this.startTime
        },
        get remaining() {
            return this.endTime - getTime()
        },
    }
}

const everyNthIds = new Map()
export function everyNth({rate, init=0, id}, func) {
    let count = init
    try {
        count = everyNthIds.get(id) || 0
    } catch (error) {
        console.debug(`error is:`,error)
    }
    if (count%rate == 0) {
        func()
    }
    console.debug(`count is:`,count)
    everyNthIds.set(id, count+1)
}
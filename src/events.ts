// Bus events are handled off the bus, in arrival order (see the server's `event` hook).
// Kept out of server.ts: opencode calls every function that module exports as a plugin.
let queue: Promise<void> = Promise.resolve()

export function enqueueEvent(job: () => void | Promise<void>) {
  queue = queue.then(job).catch(() => {})
}

// Resolves once every event received so far has been handled (tests).
export function drainEvents() {
  return queue
}

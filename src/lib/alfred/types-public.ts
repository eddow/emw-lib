/**
 * Public types for Alfred that can be imported by non-Svelte projects.
 * These types are also used internally by the Svelte components.
 */

/** How the chat sends messages to the agent. */
export type ChatSendMode = 'prompt' | 'queue' | 'steer' | 'interrupt'

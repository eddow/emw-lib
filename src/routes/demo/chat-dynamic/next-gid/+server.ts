import { freshGid } from '../mock-state.js'
import type { RequestHandler } from './$types'

/** `POST /demo/chat-dynamic/next-gid` — mint a fresh generation id. */
export const POST: RequestHandler = async () => Response.json({ gid: freshGid() })

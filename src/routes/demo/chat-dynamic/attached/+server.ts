import { __mockState } from '../mock-state.js'
import type { RequestHandler } from './$types'

/** `GET /demo/chat-dynamic/attached?gid=…` — is the mock stream reader live? */
export const GET: RequestHandler = async ({ url }) => {
	const gid = url.searchParams.get('gid') ?? ''
	const g = __mockState().generations.get(gid)
	return Response.json({ attached: !!g?.controller && !g.closed })
}

import { __mockState } from '../mock-state.js'
import type { RequestHandler } from './$types'

/**
 * `GET /demo/chat-dynamic/attached?gid=…` — is the mock stream reader live?
 * With `&armed=1` it also reports whether a per-gid failure arm is present
 * (read-your-write gate for the attach-failure test: the arm POST must be
 * visible to the process serving the attach GET).
 */
export const GET: RequestHandler = async ({ url }) => {
	const gid = url.searchParams.get('gid') ?? ''
	const state = __mockState()
	const g = state.generations.get(gid)
	const out: { attached: boolean; armed?: boolean } = {
		attached: !!g?.controller && !g.closed,
	}
	if (url.searchParams.has('armed')) out.armed = !!state.getFailGid(gid)
	return Response.json(out)
}

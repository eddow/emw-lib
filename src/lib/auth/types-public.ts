/**
 * Public types for Auth that can be imported by non-Svelte projects.
 * These types are also used internally by the Svelte components.
 */

/** Host-provided facade over `better-auth/svelte` (structural, swappable). */
export interface AuthClient {
	signInEmail(input: {
		email: string
		password: string
	}): Promise<{ error: { message?: string } | null }>
	signUpEmail(input: {
		name: string
		email: string
		password: string
	}): Promise<{ error: { message?: string } | null }>
	requestPasswordReset(input: { email: string; redirectTo: string }): Promise<{
		error: { message?: string } | null
	}>
	resetPassword(input: { newPassword: string; token: string }): Promise<{
		error: { message?: string } | null
	}>
	signInSocial(input: { provider: string; callbackURL: string }): Promise<void>
}

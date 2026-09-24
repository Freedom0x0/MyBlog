/**
 * An error the API raises deliberately, carrying the code the public contract
 * promises.
 *
 * Why this exists: the error handler must be able to tell "we decided this is a
 * 403 with this code" apart from "some library blew up". Without that
 * distinction it can only forward whatever `error.code` it finds, which leaks
 * the internals of whatever produced the error — `23505` from Postgres,
 * `FST_ERR_*` from Fastify — into a public API contract.
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

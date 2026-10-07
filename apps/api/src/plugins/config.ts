import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../config/index.js'
import { providerFromConfig, type OAuthProvider } from '../modules/auth/provider.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** The validated environment. Decorated once so nothing else reads process.env. */
    config: Config
    oauthProvider: OAuthProvider
  }
}

/**
 * Publishes configuration and the provider client on the instance.
 *
 * Registered before everything else: session and token code take the app as their
 * only ambient dependency, which keeps them constructible in tests without a bag
 * of loose parameters.
 */
export const configPlugin = fp(async (app: FastifyInstance, options: { config: Config }) => {
  app.decorate('config', options.config)
  app.decorate('oauthProvider', providerFromConfig(options.config))
})

import Fastify from 'fastify'

/**
 * A local stand-in for GitHub's OAuth provider.
 *
 * Exists so the failure branches of a hand-written code flow are testable at all.
 * github.com will not, on demand, hand back the same code twice, return 200 with a
 * missing field, or answer a token request with 401 — and those are precisely the
 * paths where this code goes wrong. The provider base URL comes from config, so the
 * production and test runs exercise the identical client.
 */

export interface StubBehaviour {
  /** Returned by /login/oauth/access_token. */
  tokenStatus: number
  tokenBody: unknown
  /** Returned by /user. */
  userStatus: number
  user: Record<string, unknown>
  emails: unknown
  /** Issue the same code twice instead of a fresh one, to test single-use codes. */
  reuseCode: boolean
}

export interface OAuthStub {
  url: string
  /** Codes the stub has handed out, so a test can assert one was redeemed once. */
  issuedCodes(): string[]
  redeemedCodes(): string[]
  setBehaviour(partial: Partial<StubBehaviour>): void
  close(): Promise<void>
}

const defaults = (): StubBehaviour => ({
  tokenStatus: 200,
  tokenBody: { access_token: 'provider-token-1' },
  userStatus: 200,
  user: { login: 'stub-user', name: 'Stub User', avatar_url: 'https://avatar.example/a.png' },
  emails: [{ email: 'primary@example.com', primary: true, verified: true }],
  reuseCode: false,
})

export async function startOAuthStub(): Promise<OAuthStub> {
  const app = Fastify({ logger: false })
  let behaviour = defaults()
  const issued: string[] = []
  const redeemed: string[] = []
  let counter = 0

  app.get('/login/oauth/authorize', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>
    const redirectUri = query.redirect_uri
    const state = query.state

    if (redirectUri === undefined) {
      return reply.code(400).send({ error: 'missing redirect_uri' })
    }

    const code = behaviour.reuseCode && issued.length > 0 ? issued[0]! : `code-${(counter += 1)}`
    issued.push(code)

    // Mirrors GitHub: a browser redirect back to the caller's callback URL.
    const target = new URL(redirectUri)
    target.searchParams.set('code', code)
    if (state !== undefined) target.searchParams.set('state', state)

    return reply.redirect(target.toString(), 302)
  })

  app.post('/login/oauth/access_token', async (request, reply) => {
    const body = request.body as { code?: string } | null

    if (typeof body?.code === 'string') redeemed.push(body.code)

    if (behaviour.tokenStatus !== 200) {
      return reply.code(behaviour.tokenStatus).send(behaviour.tokenBody ?? {})
    }

    return reply.send(behaviour.tokenBody)
  })

  app.get('/user', async (_request, reply) =>
    reply.code(behaviour.userStatus).send(behaviour.user),
  )

  app.get('/user/emails', async (_request, reply) => reply.send(behaviour.emails))

  const address = await app.listen({ port: 0, host: '127.0.0.1' })

  return {
    url: address,
    issuedCodes: () => [...issued],
    redeemedCodes: () => [...redeemed],
    setBehaviour: (partial) => {
      behaviour = { ...behaviour, ...partial }
    },
    close: async () => {
      await app.close()
    },
  }
}

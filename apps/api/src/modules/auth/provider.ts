import type { Config } from '../../config/index.js'

export interface OAuthProfile {
  login: string
  displayName: string | null
  avatarUrl: string | null
  email: string | null
}

/** The provider refused, or answered in a shape we cannot use. */
export class OAuthExchangeError extends Error {}
export class OAuthProfileError extends Error {}

interface ProviderOptions {
  base: string
  clientId: string
  clientSecret: string
}

const REQUEST_TIMEOUT_MS = 10_000

/**
 * GitHub's OAuth code flow, as a thin client.
 *
 * Hand-written rather than pulled from a library because the flow *is* the
 * exercise: state, single-use code exchange, profile fetch. What is deliberately
 * not hand-written is the cryptography (see lib/tokens.ts) — this file only moves
 * bytes between us and the provider.
 *
 * `base` is configurable so tests run the identical code path against a local stub
 * that can produce failures github.com will not: a spent code replayed, a 401
 * exchange, a 200 with a missing field.
 *
 * Credentials arrive as constructor options rather than being read from
 * process.env here: configuration is parsed once, in config/index.ts, so that a
 * bad value fails the boot with one message instead of failing a request with
 * another.
 */
export class OAuthProvider {
  readonly authorizeEndpoint: string

  private readonly tokenEndpoint: string
  private readonly apiBase: string
  private readonly clientId: string
  private readonly clientSecret: string

  constructor(options: ProviderOptions) {
    const base = options.base.replace(/\/+$/, '')
    this.authorizeEndpoint = `${base}/login/oauth/authorize`
    this.tokenEndpoint = `${base}/login/oauth/access_token`
    // GitHub serves the REST API from a different host; a stub serves both from
    // one, which is why this is derived rather than configured separately.
    this.apiBase = base === 'https://github.com' ? 'https://api.github.com' : base
    this.clientId = options.clientId
    this.clientSecret = options.clientSecret
  }

  authorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: 'read:user user:email',
      state,
      // 'consent' forces a fresh code. With 'auto', GitHub can reuse a prior
      // authorization and hand back a cached response, which turns a replay of an
      // already-spent code into something the provider might legitimately repeat.
      prompt: 'consent',
    })

    return `${this.authorizeEndpoint}?${params.toString()}`
  }

  /** Exchanges a code for a provider access token. The code is single-use. */
  async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const response = await this.request(
      this.tokenEndpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      },
      OAuthExchangeError,
      'token endpoint',
    )

    const body = await this.parseJson(response, OAuthExchangeError)
    const token = (body as { access_token?: unknown })?.access_token

    if (typeof token !== 'string' || token.length === 0) {
      throw new OAuthExchangeError('token response carried no access_token')
    }

    return token
  }

  async fetchProfile(accessToken: string): Promise<OAuthProfile> {
    const headers = {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'portal-api',
    }

    const userResponse = await this.request(
      `${this.apiBase}/user`,
      { headers },
      OAuthProfileError,
      '/user',
    )
    const user = (await this.parseJson(userResponse, OAuthProfileError)) as Record<
      string,
      unknown
    > | null
    const login = user?.login

    // Checked together: narrowing `login` to a string does not narrow `user`, and
    // the fields below are read off `user` directly.
    if (user === null || typeof login !== 'string' || login.length === 0) {
      throw new OAuthProfileError('profile response carried no login')
    }

    /**
     * Emails are a second call because GitHub hides the primary address behind it.
     * A failure here is deliberately non-fatal: `login` is the identity rows are
     * keyed on, so losing an email must not cost someone their session.
     */
    const emails = await this.request(`${this.apiBase}/user/emails`, { headers }, OAuthProfileError, '/user/emails')
      .then((res) => this.parseJson(res, OAuthProfileError))
      .catch(() => null)

    let primary: string | null = null
    if (Array.isArray(emails)) {
      for (const entry of emails) {
        const record = entry as { primary?: unknown; email?: unknown }
        if (record?.primary === true && typeof record.email === 'string') {
          primary = record.email
          break
        }
      }
    }

    return {
      login,
      displayName: typeof user.name === 'string' ? user.name : null,
      avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : null,
      email: typeof primary === 'string' ? primary : null,
    }
  }

  private async request(
    url: string,
    init: RequestInit,
    ErrorType: typeof OAuthExchangeError | typeof OAuthProfileError,
    label: string,
  ): Promise<Response> {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })

      if (!response.ok) {
        // Without the provider body: it can echo request contents, including the
        // code, and this message ends up in a response.
        throw new ErrorType(`${label} returned ${response.status}`)
      }

      return response
    } catch (error) {
      if (error instanceof ErrorType) throw error
      throw new ErrorType(`${label} unreachable (${error instanceof Error ? error.name : 'unknown'})`)
    }
  }

  /** Non-JSON becomes a typed failure rather than a raw SyntaxError. */
  private async parseJson(
    response: Response,
    ErrorType: typeof OAuthExchangeError | typeof OAuthProfileError,
  ): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      throw new ErrorType(`${response.url} returned a non-JSON body`)
    }
  }
}

export function providerFromConfig(config: Config): OAuthProvider {
  return new OAuthProvider({
    base: config.OAUTH_BASE_URL,
    clientId: config.OAUTH_CLIENT_ID,
    clientSecret: config.OAUTH_CLIENT_SECRET,
  })
}

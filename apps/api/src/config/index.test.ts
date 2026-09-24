import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from './index.js'

const validEnv = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/myblog',
  REDIS_URL: 'redis://localhost:6379',
}

describe('loadConfig', () => {
  it('applies defaults for optional values', () => {
    const config = loadConfig(validEnv)

    expect(config.NODE_ENV).toBe('development')
    expect(config.PORT).toBe(3001)
    expect(config.LOG_LEVEL).toBe('info')
  })

  it('coerces PORT from its string form', () => {
    // Environment variables are always strings; the schema is responsible for
    // turning them into the types the rest of the app expects.
    expect(loadConfig({ ...validEnv, PORT: '4000' }).PORT).toBe(4000)
  })

  it('reports every problem at once rather than only the first', () => {
    // This is the entire reason config is validated up front: one restart should
    // reveal every missing variable, not one per restart.
    let message = ''
    try {
      loadConfig({})
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      message = (error as Error).message
    }

    expect(message).toContain('DATABASE_URL')
    expect(message).toContain('REDIS_URL')
  })

  it('rejects a malformed URL', () => {
    expect(() => loadConfig({ ...validEnv, DATABASE_URL: 'not-a-url' })).toThrowError(ConfigError)
  })

  it('rejects a non-numeric PORT', () => {
    expect(() => loadConfig({ ...validEnv, PORT: 'abc' })).toThrowError(ConfigError)
  })

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => loadConfig({ ...validEnv, LOG_LEVEL: 'verbose' })).toThrowError(ConfigError)
  })
})

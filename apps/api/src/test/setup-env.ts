/**
 * Vitest setup: give tests the same configuration source as `pnpm dev`.
 *
 * Silently continuing when .env is absent would let an integration test "pass" by
 * skipping its own precondition, so the file is optional but the variables are not
 * — each test that needs a database checks for it explicitly and fails with
 * instructions rather than skipping.
 */
import { fileURLToPath } from 'node:url'

const localEnv = fileURLToPath(new URL('../../.env', import.meta.url))

try {
  process.loadEnvFile(localEnv)
} catch {
  // No local .env (CI injects real environment variables instead). Not an error here.
}

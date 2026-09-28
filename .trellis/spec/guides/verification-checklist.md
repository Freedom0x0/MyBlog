# Verification Checklist

> **Purpose**: stop "I changed it" from turning into "it works". Every rule here came from a claim that turned out to be wrong.

---

## Before claiming something is fixed

- [ ] **Did you run it, or only read it?** Reading source proves intent, not behaviour.
- [ ] **Did you test the artifact that actually ships?** Check build output, not source:
  - a plugin configured `prodOnly: true` is invisible in `dev` — only the bundle reveals it
  - `VITE_*` / `NEXT_PUBLIC_*` values are inlined into the client bundle at build time
  - a meta tag written across several lines does not match a single-line `grep`
- [ ] **Did you verify both sides of a removal?** See the next section.
- [ ] **Did you re-run the whole gate?** `lint`, `check`, `test`, `build`.

---

## Symmetric verification — the half that gets skipped

When you **remove or restrict** something, prove two things, not one:

1. it is gone where it should be gone
2. it still works where it should be kept

Concrete case: scoping `react-dev-locator` to `command === 'serve'`. Showing the
production bundle has zero `trae-inspector` attributes is half the check. The other
half is showing `vite dev` still mounts the plugin, so the capability was preserved
rather than quietly deleted.

**Test**: say both assertions out loud. If you can evidence only one, the check is
incomplete.

---

## Before asserting that something is absent

"X not found here" is not "X does not exist". Three claims in this repository were
each asserted wrongly, and every one was cheap to verify properly:

| Claim made | Evidence used | Actual state |
|---|---|---|
| "Docker is not installed" | `which docker` failed | installed; simply not on this shell's PATH |
| "no production deployment, no readers" | no local `.vercel` directory | site live; the Vercel GitHub App attaches at the **repository** level and leaves no local trace |
| "normalising line endings rewrites the whole repo" | reasoning from `core.autocrlf=true` | measured: zero content change, because commits were already normalised |

**Rule**: before writing "there is no X", name where you looked and whether that
place could ever have shown X. `which` reports PATH, not installation. Absence of
evidence is not evidence of absence — especially when the authoritative source is an
API one call away.

---

## Before acting on a severity ranking

Severity is not risk. Two independent questions:

1. **Will this code be replaced?** If yes, fixing it may be throwaway work.
2. **Is there anything valuable behind it?** A confirmed, exploitable privilege
   escalation over four rows of seeded demo data is a different decision from the
   same bug over real content.

Question 2 is answered by the owner, **not by the repository**. Ask it before
writing the fix — not after it is committed, pushed and under review.

---

## Related

- [Backend conventions](../backend/conventions.md) §8 — migrations must be executed against a scratch database, never reviewed by eye
- [Code Reuse guide](./code-reuse-thinking-guide.md) — search before modifying
- [Cross-Layer guide](./cross-layer-thinking-guide.md) — bugs live at boundaries

---

## Three more ways a check can be quietly worthless

**A 200 from a dev server is not a rendered page.** For an SPA the server returns
the shell HTML no matter how badly client-side mounting fails — `curl` sees the same
bytes whether the app crashed or painted. Verified this the hard way: the lazy
Supabase client was recorded as "app starts without credentials", checked by
curling `localhost:5175`, while `onAuthChange` still threw synchronously during
mount and blanked the tree.

**A test that passes with the feature removed.** A scale check for a tag filter
generated 5000 rows that *all* carried the tag being filtered. Both the broken and
the fixed query matched every row, produced the same plan, and "passed". Selectivity
is the thing being tested; a fixture that guarantees a match tests nothing.

**An assertion added twice is not an assertion added once.** A batch edit script that
validates before writing aborted on one unrelated pair and **silently skipped every
edit after it**. The retry applied the one that failed and reported success, so the
dropped edits — including the consumer side of a contract change — looked done.
Prefer per-edit reporting over all-or-nothing when a batch has independent items.

---


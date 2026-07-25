# Ducklang example snapshot

This directory was copied from `../binned/examples` on 2026-07-23 while that
working tree was based on commit `e991bf5756091fb3f257c140b97a051b7ac4799b`. The
snapshot intentionally includes the sibling working tree's current example
changes because those are the programs this compatibility work targets.

The corpus contains 121 Duck source files. Its original MIT license is recorded
in the repository's `THIRD_PARTY_NOTICES.md`.

`contract.json` snapshots the source repository's executable manifest: expected
results, intentional compile failures, traps, source tests, runtime inputs, and
dependency modules. Regenerate it from a sibling checkout with
`deno task duck:contract`.

`live/` separately freezes the current frontend preludes and selected
applications that drove the semantic Core roadmap. Its own `SOURCE.md` records
the dirty-working-tree provenance and content digest.

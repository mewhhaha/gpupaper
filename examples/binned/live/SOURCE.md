# Live Binned frontend target

These 35 Duck sources were copied from the sibling `../binned` working tree on
2026-07-24. That working tree was based on commit
`3b033713c93b515540a71d993194ee1a7b5f74c2` and contained uncommitted changes, so
the commit alone does not identify this snapshot.

The snapshot contains all 23 `src/frontend/prelude*.duck` modules; the editor,
Codex, grep, tar, raytracer, and wav applications; their host interfaces; and
the Codex citation-parser and protocol modules imported by the entry point. Its
deterministic content digest is:

```text
610f8d487a19d9d20e879bc7ed7b740a1975f828e12e5111a8d45a606f6dffad
```

The digest is the SHA-256 of the sorted stream of each relative path's
`sha256sum` output. The sources remain covered by Binned's MIT license recorded
in `THIRD_PARTY_NOTICES.md`.

# @livearchive/ticket-scanner

A headless, zero-dependency engine that reads concert ticket emails and proposes
events. It runs in browsers, Cloudflare Workers and Node, and works only in memory.
It has no knowledge of any database. The host app writes the results.

## Boundary rules

- No imports from outside `packages/ticket-scanner/` (no `../../`).
- Web Standard APIs only. No `fs`, `net`, `crypto` module, `stream`, `buffer` or Worker bindings.
- Deterministic code only. There is no model call anywhere in the package.
- Every extracted value carries the verbatim quote it came from (`isVerbatim`).

## Status

Built so far: query strings, HTML-to-lines, the weekday year rule, the verbatim
check, and the `.pkpass` reader. Not yet built: the seller layout readers, the
forwarded-email unwrapper, the verbatim heuristic reader, and the 100-fixture
golden corpus.

## Tests

    npm test

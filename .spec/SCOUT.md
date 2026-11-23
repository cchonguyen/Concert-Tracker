# Scout: docs, comments and app text audit (2026-11-23)

Files-Touched: 120
Contract-Change: no
Cross-Module: yes

- Docs: 36 specs and plans under docs/, 24 architecture sections, 11 .spec files. docs/README.md index misses docs/specs/ and lists 8 wrong statuses. One broken link.
- Code comments: about 106 comments cite slice numbers in src/ and worker/. No TODO or FIXME markers.
- App text: about 660 short strings found in src/components (labels, tooltips, placeholders, help lines), plus multi-line help text. Jargon seen: "canonical", "ingest", "edition", "candidate", "Lookups", "Finders", "Reader".
- Out of scope: migrations, .env.example (tripwire), engine files (.claude, .harness).

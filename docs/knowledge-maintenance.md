# Knowledge maintenance and M7+ definition of done

The `knowledge/` directory is an [Open Knowledge Format (OKF) v0.2](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md) bundle. It is a maintained contract, not a one-time export. Starting with **M7**, changes to planner behavior, authoring schema, API, REST requests or decisions are **not complete** until the corresponding OKF documentation and change history are reconciled.

## Required for every M7+ change

1. Update every **affected** `knowledge/concepts/`, `knowledge/decisions/`, `knowledge/schema/`, `knowledge/api/` and/or `knowledge/github/` page. Preserve source provenance and `status: draft` until independently reviewed; update `generated.at` when the content changes. Add a page to the appropriate directory index if new.
2. Record the meaningful behavioral/documentation decision in `knowledge/log.md` under a `YYYY-MM-DD` heading, **newest first**, with the issue and PR references. A documentation-only change still requires a log entry. Never fabricate human verification events (`verified.by: human:<id>`).
3. Run `npm run docs:readme` after changing any Concept title, description, Summary or order in `knowledge/concepts/index.md`. The generator may change **only** the contents between `<!-- okf:begin -->` and `<!-- okf:end -->` in the root README; handwritten Install/Quickstart remain unchanged.
4. Run `npm run docs:check`, `npm test`, `npm run schema:check`, `npm run build`, and `npm run test:dist`. CI gates the generated section and OKF conformance. A reviewer must also check that **the right affected pages** were updated; conformance cannot infer semantic coverage from arbitrary source changes.

## Scope boundary

M6.3 introduces documentation generation and the future maintenance policy; it does not make a new GitHub mutation executor, publish the package, change the public API, or grant GitHub permissions. `docs:readme` is deterministic and idempotent; `docs:check` never rewrites files.

For background see [the knowledge overview](../knowledge/overview.md), [the public contract](public-contract.md), and the [historical update log](../knowledge/log.md).

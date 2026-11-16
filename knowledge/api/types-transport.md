---
type: API
title: "Discovery and transport contracts"
description: "FetchLike abstraction and read-only REST discovery response contracts."
resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
tags: [api, public-contract, typescript]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T05:23:20.409+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/index.ts
---

## Summary

FetchLike abstraction and read-only REST discovery response contracts.

## Public symbols

- `FetchLike`
- `FetchRequestInitLike`
- `FetchResponseLike`
- `HeaderReaderLike`
- `GithubDiscoveryTransport`
- `RestDiscoveryTransportConfig`
- `DiscoveryResolutionResult`
- `IdentityResolutionOptions`
- `IdentityResolutionResult`

## Contract boundary

Injected fetch makes the GET-only planner testable without GitHub SDK or global DOM types; successful discovery results are separate from proposed mutation requests.

For the runtime entrypoint, see [planGithub()](/api/planGithub.md) and [normalization](/api/normalizeSchema.md).

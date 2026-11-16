---
type: Decision
title: "Progressive apply coverage and authoritative postconditions"
description: "Start optional apply with four narrowly verified issue and milestone operations; reject unsupported plans before any write."
tags: ["github", "apply", "verification", "safety"]
status: draft
generated: { by: gh-plan-docs/gpt-6, at: 2026-11-16T11:22:00+01:00 }
sources:
  - resource: https://github.com/attention-spa/gh-plan/issues/165
  - resource: https://github.com/attention-spa/gh-plan/issues/163
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/issue-compiler.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/milestone-compiler.ts
  - resource: https://github.com/attention-spa/gh-plan/blob/main/src/types.ts
  - resource: https://docs.github.com/en/rest/issues/issues
  - resource: https://docs.github.com/en/rest/issues/milestones
---

## Summary

**Architecture decision B1, accepted for future implementation in [#165](https://github.com/attention-spa/gh-plan/issues/165):** ship a *progressive, closed* execution capability allowlist. Only four compiler-emitted operation kinds are candidates: `milestone.create`, `milestone.update`, `issue.create` and `issue.update`. Each is eligible **only** for a fully recognized REST request shape with an independent, machine-verifiable GitHub state read. Reject the **entire plan before any resource mutation** when any planned operation or intended managed side effect is out of scope. This policy is not a completed REST writer, postcondition evaluator, lock implementation or public `applyPlan()` export.

This decision complements [A1 cooperative Git-ref ownership](/decisions/github-native-apply-ownership.md). Neither cooperative locking nor a successful HTTP response proves full resource reconciliation. The owner has now approved [C2 caller-injected public apply](/decisions/caller-injected-apply-contract.md) as an architecture decision, not implementation. B1's requirement for independently **GitHub-backed** postconditions can be met by a separately tested reference adapter; C2 cannot prove that arbitrary user callbacks performed real GETs.

## Closed B1 allowlist: exact first-version shapes

| Kind | Accepted proposed REST method/path | Eligible outgoing body | Authoritative read and acceptance |
| --- | --- | --- | --- |
| `milestone.create` | `POST /repos/{owner}/{repo}/milestones` | Required nonempty `title`; optional string `description`, `state` = `open`/`closed`, UTC ISO `due_on`. Nothing else. | Fresh fully paginated `GET /milestones?state=all` and post-create `GET /milestones/{number}`. Require one **exact-title** candidate across open and closed, matching REST `number`, `id`, `node_id` when available and all managed values; no preexisting ambiguous title. |
| `milestone.update` | `PATCH /repos/{owner}/{repo}/milestones/{number}` | Nonempty subset of `title`, `description` (including `""` to clear), `state`, `due_on` (UTC timestamp to set, `null` to clear). | Fresh `GET /milestones/{number}` before/after; compare the same observed milestone identity and every changed field, preserving omitted fields. Date sets compare the UTC calendar date; removal requires observable null. |
| `issue.create` | `POST /repos/{owner}/{repo}/issues` | Required nonempty string `title` and `body` with one valid unique canonical/custom marker; optional `milestone` as an existing or safely resolved future **milestone number**. No issue type, custom fields, labels, assignees, state or other embedded create effects. | Fresh paginated open+closed **issues** catalog excluding pull requests, exact unique marker, and `GET /issues/{number}`. Verify REST `id`, `node_id`, `number`, marker, title/body, initial state and milestone number. Returned create identity must agree with independent GET and marker catalog. |
| `issue.update` | `PATCH /repos/{owner}/{repo}/issues/{number}` | Nonempty subset of `title`, `body`, `state` (`open`/`closed`), `milestone` (positive milestone number or explicit `null`). Only already-uniquely-owned managed issues; no implicit marker adoption. | Fresh `GET /issues/{number}` before/after plus marker/identity validation; compare **all** changed fields and preserved marker. On a create→close step, bind the producer issue `number` before PATCH and verify closed state. |

The planner may compile other property intentions in its desired graph, but the future apply preflight must reject them, including properties omitted from the outgoing REST request. **No partial plan application**: a planned label, issue type, field, reviewer, duplicate close, relationship, project, marker-adoption operation or unsupported request nested in an otherwise eligible plan rejects the whole plan. Missing arguments, extra keys, non-REST requests, untrusted path fragments, cross-repository targets or uncontrolled multiple-resource side effects also reject.

For updates, `description: ""` and `due_on: null` (milestone), or `milestone: null` (issue), are deliberate clears. **Omission preserves state**. Issue milestone values refer to the GitHub **milestone number**, not REST resource `id`; typed late-bound producers must be verified before use. A due-date comparison uses the UTC calendar day for intended sets, and a null check for explicit removal. New-milestone `description/due_on` removal is satisfied by the documented omission semantics, not a second mutation. If any live behavior is insufficiently observable, disable that **shape** pending tests rather than relaxing verification.

## Typed postcondition contract and whole-plan preflight

**Decision:** use a **versioned, typed `PostconditionSpec`** produced by an exhaustive kind+request+managed-intent compiler/evaluator. It stores the canonical target repo, operation kind, request method/path, permitted field keys with set/clear presence, unique identity selector, expected normalized field predicates, authoritative endpoint(s), bound create dependencies and API/permission requirements. Implement the evaluator and descriptor schema as one guarded internal contract in [#178](https://github.com/attention-spa/gh-plan/issues/178); avoid parsing `PlanStep.expectedPostconditions: string[]`, which remains human-readable explanation only.

Before lock acquisition or resource dispatch, validate the **entire input plan**: `readiness`, blockers, unsupported diagnostics, requested schema/version, resources and *all* managed intentions (not merely `steps`), `noops` that may have become stale, operation enum and allowed shape, identity and target repository, exact endpoint/method, refs and dependency DAG. Unknown or unsafe intent must fail without writing or acquiring a lock. A noop is never proof that the live state remains unchanged: refresh/replan or verify it; fail closed if freshness cannot be established.

Once a static plan is eligible, independently verify current state before deciding each step **under the owner lock**, and after every mutation. Require complete, authoritative GETs; negative 404, incomplete pagination, stale snapshots, unexpected source IDs, identity disagreement, duplicate marker/title, wrong repository, an ambiguous/unknown write result or missing privileges all stop execution with sanitized failure. Lock ownership is checked before each resource write per A1. Never blindly retry a create or interpret HTTP 2xx alone as success.

For create ambiguity, safe recovery is **identity and full-field based**: issue marker unique across *all* issues excluding PRs; milestone exact title unique across all open/closed milestones. Before create, absence must be demonstrated under cooperative ownership. After response loss, a unique candidate plus complete property match may permit skip/resume; an absent or ambiguous candidate requires operator review, not automatic duplicate POST. GitHub does not atomically enforce uniqueness against uncooperative clients. Composite steps such as `issue.create` followed by `issue.update` must each verify independently and maintain producer bindings.

**Transport and permissions:** issue creates/updates require repository `Issues:write` (plus access to read), while milestone endpoints accept `Issues:write` or GitHub-documented alternative `Pull requests:write`. Use `Issues:write` consistently for the MVP. Setting a milestone on **issue create** additionally requires the GitHub-documented *push access*. The A1 Git-ref CAS lock separately requires repository `Contents:read/write`. GET collections must follow every page, including closed resources. Pause between serial writes and handle rate limits without speculative retries. Permission probes and all mutation semantics require a disposable private test repository, not production.

## Complete current PlanOperationKind disposition (33)

The list below is mechanically cross-checked against `src/types.ts` as of decision #165. The four eligible **kinds** are conditional candidates; every other kind and every unsupported shape is excluded from initial live application.

| Operation kind | Initial B1 apply support |
| --- | --- |
| `label.create` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `label.update` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `milestone.create` | **Conditional B1 candidate** — only approved kind, exact method/path/body shape and proven fresh evaluator; not implemented. |
| `milestone.update` | **Conditional B1 candidate** — only approved kind, exact method/path/body shape and proven fresh evaluator; not implemented. |
| `project.item.add` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `project.item.fields.set` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `pull_request.create` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `pull_request.update` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `pull_request.reviewer.add` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `pull_request.reviewer.remove` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.orphan.close` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.duplicate.comment` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.duplicate.close` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.duplicate.delete` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.create` | **Conditional B1 candidate** — only approved kind, exact method/path/body shape and proven fresh evaluator; not implemented. |
| `issue.update` | **Conditional B1 candidate** — only approved kind, exact method/path/body shape and proven fresh evaluator; not implemented. |
| `issue.type.set` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.marker.adopt` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.label.set` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.label.add` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.label.remove` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.assignee.set` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.assignee.add` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.assignee.remove` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.field.set` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.field.remove` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.parent.set` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.dependency.add` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.dependency.remove` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.parent.remove` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.relates_to.add` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `issue.relates_to.remove` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |
| `verification.read` | **Excluded from initial apply** — reject before mutation even if emitted by the planner. |

`issue.assignee.set` is normally a semantic no-op decomposed into add/remove steps; it is **not** a permission to bypass preflight when a managed assignee operation is requested. `verification.read` is reserved and is **not** a license for an arbitrary user-supplied postcondition. The irreversible GraphQL-only `issue.duplicate.delete` is never executable in B1.

## #178 first implementation checkpoint — static preflight only

[#178](https://github.com/attention-spa/gh-plan/issues/178) implements the internal-only versioned B1 `ApplyPostconditionSpec` descriptor and pure `preflightApplyPlan()` capability gate. The planner now retains an `applyIntent` manifest containing normalized resource property names, explicit removal intent, default state intent, and unsupported root intents, because its existing `desired` summary only contains counts. This prevents silently omitted unsupported fields, relationships, Projects, labels and prune requests from bypassing step-only checks.

The pure function validates the complete request DAG, plan metadata/version, target repository, four exact method/path/body shapes, title/marker uniqueness selectors, versioned field predicates, nullable clears, numeric milestone references, dependency ordering, and managed property coverage. It rejects unsupported operations including a last-step one **before any callback or lock could be invoked**. Unverified existing noops are currently rejected in full: they cannot safely be accepted without a fresh authoritative reader after ownership acquisition. This intentionally narrows eligibility; [#187](https://github.com/attention-spa/gh-plan/issues/187) may add strictly proven under-lock noop revalidation, not assume the planning snapshot is fresh.

These descriptors describe **what readers must verify**, not proof the read occurred. No live GitHub reader, lock, production mutation dispatcher, public apply export or package publication was added. The C2 callback boundary remains explicitly untrusted without the separately tested reference adapter. Preserve the still-open [#179](https://github.com/attention-spa/gh-plan/issues/179), [#180](https://github.com/attention-spa/gh-plan/issues/180), and [#181](https://github.com/attention-spa/gh-plan/issues/181) readback and disposable-repo proofs.

## Independent implementation and disposable-test evidence

- [#178](https://github.com/attention-spa/gh-plan/issues/178): typed capability predicate compiler, safe whole-plan preflight, exhaustive enum/shape tests, no-write rejection.
- [#179](https://github.com/attention-spa/gh-plan/issues/179): milestone create/update authoritative reader (including open/closed title uniqueness, due-date normalization and removal).
- [#180](https://github.com/attention-spa/gh-plan/issues/180): issue create/update authoritative reader (exact marker uniqueness, REST number/ID/node ID, late binding).
- [#181](https://github.com/attention-spa/gh-plan/issues/181): disposable private-repository end-to-end for all four kinds, first apply/zero-write replay, drift, 403/404, missing/corrupt pages, unknown write outcomes, interruption and mixed DAG.

For **each** allowed kind, verify first creation/update, an already-satisfied replay with zero writes, drift/identity mismatch, unknown result after a remote write, permission error, corrupted/partial GET and interruption/resume on a disposable private repository. Explicitly demonstrate that unsupported last-step kind or malformed nested field **causes zero resource writes** (and rejects before lock acquisition when statically detectable). Test due date clearing, description clearing, milestone link set/remove, issue close-on-create, complete catalog pagination, ambiguous title/marker and REST numeric ID versus node ID. The preflight, individual readers and private-repo proof are independently verifiable; no future child issue authorizes execution merely by existing.

The [#163 architecture gate](https://github.com/attention-spa/gh-plan/issues/163) and owner-specific implementation authorization are required before these leaves begin. Decision C2 on the public API and audit/transport contract is accepted under [#166](https://github.com/attention-spa/gh-plan/issues/166); implementation remains a separate authorization. Neither A1 nor B1 provides a production mutation executor by itself.

## Alternatives rejected for v1

**B2** (all planner operations before first export) would delay the first safe apply capability and couple correctness to many unrelated endpoints. **B3** (limited private callback-only) cannot deliver the requested high-level safe apply surface. The separately approved **C2** chooses a *public* callback facade plus independently tested reference GitHub adapter, explicitly without the built-in safety guarantee of C1. Expansion beyond the B1 shape allowlist must be independently approved, coded, tested and documented, not silently activated by future compiler changes.

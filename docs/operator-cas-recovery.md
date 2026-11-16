# Manual abandoned GitHub CAS lock recovery

**Operator-only.** [Issue #176](https://github.com/attention-spa/gh-plan/issues/176) implements an internal recovery helper and tests. This runbook is a human-gated procedure, **not** a job, lease expiration, automatic reaper, or blanket authorization for a production lock. The only Git ref it may delete is refs/heads/gh-plan/locks/repository in the expressly approved repository.

## Required independent evidence (before requesting approval)

1. Open a durable GitHub incident issue. Inspect the **exact** ref using GET /repos/{owner}/{repo}/git/ref/heads/gh-plan/locks/repository (never prefix-matching lists), its commit, the default commit tree, and canonical repository REST ID/node ID. Record the exact 40-hex owner SHA, run ID, nonce, repository ID and UTC observation time. If no ref exists, there is nothing to recover. If foreign or tampered, **stop**.
2. Independently prove **the original process and every cooperating agent/runner have terminated**. Check process/host/session and runner evidence. An idle or unreachable owner, old timestamp, canceled job, or completed Actions run alone does not suffice.
3. Independently prove **every in-flight GitHub mutation is terminal** (not just locally canceled). If any remote write might still complete, **stop**: GitHub Issues REST does not support lock fencing tokens.
4. Reconcile **every potentially affected resource operation** with fresh authoritative GitHub issue/milestone reads, preserving IDs, markers, field values, postconditions and any uncertain outcomes. Record a zero-write proof if nothing started; any unresolved operation is a hard stop.
5. Record the process/worker termination evidence, network-request terminality proof, all-resource-review evidence, and reason in the incident. Obtain a separate **human-authored exact-target approval comment** *after* evidence, naming repository and owner OID explicitly. A generic authorization or a prior implementation approval does **not** permit production recovery.

The internal recovery API requires a structured stop/review/approval dossier, validates exact owner commit/tree and repository identity, writes audit intent durably before mutation, rechecks ownership immediately before CAS, and sends **one** GraphQL updateRefs with beforeOid=the approved owner SHA, afterOid=40 zeros, force=false. A failed/unknown CAS response is **not retryable**, even if a later ref read shows absence. It cannot verify that caller-asserted process/worker termination or human identity is genuinely true: those checks remain the operator's responsibility.

## Operator-executable PowerShell 7 (GitHub CLI)

Requires gh authenticated with repository Metadata:read, Contents:read/write for the lock, and Issues:write on the incident issue (for durable pre/post audit comments). Use a current verified human/operator credential. This interactive function defaults to **inspection-only**. Deletion requires -Execute, all evidence flags and PowerShell confirmation. It does not change a plan or create any new owner.

```powershell
function Invoke-GhPlanAbandonedLockRecovery {
  [CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
  param(
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$')][string]$Repository,
    [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$OwnerOid,
    [Parameter(Mandatory)][ValidatePattern('^https://github.com/[A-Za-z0-9-]+/[A-Za-z0-9._-]+/issues/[1-9][0-9]*$')][string]$IncidentUrl,
    [Parameter(Mandatory)][ValidatePattern('^https://github.com/.+/issues/[1-9][0-9]*#issuecomment-[1-9][0-9]*$')][string]$StopProofUrl,
    [Parameter(Mandatory)][ValidatePattern('^https://github.com/.+/issues/[1-9][0-9]*#issuecomment-[1-9][0-9]*$')][string]$ResourceReviewUrl,
    [Parameter(Mandatory)][ValidatePattern('^https://github.com/.+/issues/[1-9][0-9]*#issuecomment-[1-9][0-9]*$')][string]$HumanApprovalUrl,
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9-]+$')][string]$HumanApproverLogin,
    [switch]$ConfirmedOwnerAndAllWorkersStopped,
    [switch]$ConfirmedAllNetworkRequestsTerminal,
    [switch]$ConfirmedAllResourcePostconditionsReviewed,
    [switch]$Execute
  )
  $ErrorActionPreference = 'Stop'
  $ref = 'refs/heads/gh-plan/locks/repository'
  $zero = '0' * 40
  $sourceIssue = $IncidentUrl.Substring('https://github.com/'.Length)
  function GhRead([string]$path) {
    $json = & gh api -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2026-03-10' $path
    if ($LASTEXITCODE -ne 0) { throw 'Authenticated GitHub GET failed. Stop.' }
    return ($json | ConvertFrom-Json -AsHashtable)
  }
  function Inspect {
    $repo = GhRead "repos/$Repository"
    if ($repo.full_name -cne $Repository -or !$repo.id -or !$repo.node_id) {
      throw 'Canonical repository identity mismatch.'
    }
    $lock = GhRead "repos/$Repository/git/ref/heads/gh-plan/locks/repository"
    if ($lock.ref -cne $ref -or $lock.object.type -cne 'commit' -or
        $lock.object.sha -cne $OwnerOid) { throw 'Lock ref missing or moved. Stop.' }
    $commit = GhRead "repos/$Repository/git/commits/$OwnerOid"
    if ($commit.sha -cne $OwnerOid -or $commit.parents.Count -ne 1) {
      throw 'Owner commit/ref mismatch.'
    }
    $parts = $commit.message -split '\r?\n'
    if ($parts.Count -ne 7 -or $parts[0] -cne 'gh-plan-cas/v1' -or
        $parts[1] -cne "repository=$Repository" -or
        $parts[2] -cne "repository-id=$($repo.id)" -or
        $parts[3] -cne "repository-node-id=$($repo.node_id)" -or
        $parts[4] -notmatch '^run-id=[A-Za-z0-9][A-Za-z0-9._-]*$' -or
        $parts[5] -notmatch '^nonce=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
        $parts[6] -cne "base=$($commit.parents[0].sha)") {
      throw 'Owner commit metadata not recognized. Stop.'
    }
    $parent = GhRead "repos/$Repository/git/commits/$($commit.parents[0].sha)"
    if ($parent.tree.sha -cne $commit.tree.sha) { throw 'Owner changed tree. Stop.' }
    return $repo
  }
  function Audit([string]$eventName, [string]$nodeId) {
    $details = @(
      "GH-PLAN-CAS-RECOVERY $eventName"
      "repository=$Repository"
      "nodeId=$nodeId"
      "ownerOid=$OwnerOid"
      "stopProof=$StopProofUrl"
      "resourceReview=$ResourceReviewUrl"
      "approval=$HumanApprovalUrl"
      "time=$([DateTime]::UtcNow.ToString('o'))"
    ) -join [Environment]::NewLine
    $payload = @{body=$details} | ConvertTo-Json -Compress
    $payload | & gh api --method POST "repos/$sourceIssue/comments" --input - | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Durable audit failed; no further CAS attempts.' }
  }
  $identity = Inspect
  Write-Output "Verified exact ref=$ref owner=$OwnerOid repo=$Repository node=$($identity.node_id)"
  if (!$Execute) {
    Write-Output 'Read-only inspection complete. No lock ref changed.'
    return
  }
  if (!$ConfirmedOwnerAndAllWorkersStopped -or !$ConfirmedAllNetworkRequestsTerminal -or
      !$ConfirmedAllResourcePostconditionsReviewed) {
    throw 'Process, network and resource proof confirmations are all mandatory.'
  }
  if ($HumanApprovalUrl -notmatch '^https://github.com/([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)/issues/[1-9][0-9]*#issuecomment-([1-9][0-9]*)$') {
    throw 'Human approval comment URL is invalid.'
  }
  $approval = GhRead "repos/$($Matches[1])/$($Matches[2])/issues/comments/$($Matches[3])"
  $phrase = "APPROVE GH-PLAN CAS RECOVERY repository=$Repository ownerOid=$OwnerOid"
  if ($approval.user.login -cne $HumanApproverLogin -or $approval.user.type -cne 'User' -or
      !$approval.body.Contains($phrase)) {
    throw 'Exact human-authored recovery approval was not verified.'
  }
  # The operator must independently verify this login is a human, not a machine user.
  if (!$PSCmdlet.ShouldProcess("$Repository $ref $OwnerOid",'CAS-delete approved abandoned lock')) {
    return
  }
  Audit 'authorized_attempt' $identity.node_id
  $identity = Inspect  # repeat exact GET immediately before CAS
  $mutation = 'mutation ($repositoryId:ID!, $name:GitRefname!, $before:GitObjectID!, $after:GitObjectID!) { updateRefs(input:{repositoryId:$repositoryId,refUpdates:[{name:$name,beforeOid:$before,afterOid:$after,force:false}]}) { clientMutationId } }'
  $raw = & gh api graphql -f query="$mutation" -f repositoryId="$($identity.node_id)" -f name="$ref" -f before="$OwnerOid" -f after="$zero"
  if ($LASTEXITCODE -ne 0) { throw 'CAS response uncertain. Do not retry.' }
  $result = $raw | ConvertFrom-Json -AsHashtable
  if ($result.errors -or !$result.data.updateRefs) {
    throw 'GraphQL CAS not confirmed. Do not retry.'
  }
  $after = & gh api "repos/$Repository/git/ref/heads/gh-plan/locks/repository" 2>&1
  if ($LASTEXITCODE -eq 0 -or ($after | Out-String) -notmatch '(404|Not Found)') {
    throw 'Post-CAS exact-ref absence unverified. Do not retry.'
  }
  $sameRepo = GhRead "repos/$Repository"
  if ($sameRepo.node_id -cne $identity.node_id) {
    throw 'Post-CAS repository identity changed. Do not retry.'
  }
  Audit 'confirmed_release' $identity.node_id
  Write-Output 'Recovery confirmed. A future run must acquire a fresh lock and revalidate its plan.'
}
```

**Run the function without -Execute first** to inspect the exact ref and owner. The listed switches are operator attestations, not machine proof of stopped processes or completed GitHub requests. For production use, human sign-off must explicitly name the exact SHA and be stored in the linked incident comment. The operator must independently inspect the termination/resource evidence. Do not paste authentication tokens into records.

## Refusal and failure handling

| Condition | Required action |
| --- | --- |
| Crash before acquisition, no lock ref | No CAS deletion; stop. |
| Owner alive, idle, unreachable or another worker possibly active | Refuse recovery. |
| Any possibly in-flight REST mutation | Refuse recovery, even if the client was canceled. |
| Unresolved create/update or unreadable resource state | Refuse recovery; no automatic resume. |
| Wrong repository, altered marker/tree/OID/ref or missing ref | Refuse; investigate before reinspection. |
| Permission/ruleset error, forbidden ref, unknown HTTP response | Refuse; never bypass branch protection. |
| CAS returns HTTP 200 with GraphQL errors | Not success. Stop and reread; never retry blindly. |
| Lost CAS response; post-ref is absent or changed | Outcome uncertain; audit and escalate, never repeat. |
| Confirmed exact-OID CAS, 404 ref read, and durable success audit | Recovery complete; no plan restart. |

**Guarantee limitations:** no TTL, auto-reclaim, worker fencing, global exactly-once or atomic transaction between lock check and GitHub Issues REST. Only cooperating writers use the A1 ref. The internal helper's callback/dossier proofs are trusted operator inputs and **do not authenticate the asserted human or network termination independently**. This runbook must not be integrated into CI cleanup or an always-on agent without a new, separate owner decision.

## Disposable-repository acceptance

#176 validates both hard denial and successful exact-OID conditional cleanup on a **separate private disposable repository**, using GraphQL updateRefs force=false and fresh exact-ref reads. The test's approved-only fixture is a test authorization under the user's permission to test #176; it is **not a real human approval of a production lock**. Synthetic tests cover the human-proof gates. After test completion, transfer summarized evidence to the durable #176 issue and delete the disposable repository. The next real apply run must acquire a new owner OID and rerun B1 preflight, independent postconditions and current desired-state verification.

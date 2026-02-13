#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  evaluateOfflineTagLookupFallback,
  evaluateStablePrMergeRequirement,
  evaluateStableTagGuardrails,
  hasSquashMarker,
  isMergeCommit,
  isStableVersion,
  parseParentCountFromRevList
} from "../scripts/release-guardrails.mjs";

assert.equal(isStableVersion("0.3.0"), true);
assert.equal(isStableVersion("10.20.30"), true);
assert.equal(isStableVersion("0.3.0-rc.1"), false);
assert.equal(isStableVersion("0.3.0+build.1"), false);

assert.equal(parseParentCountFromRevList("abc123 def456"), 1);
assert.equal(parseParentCountFromRevList("abc123 def456 789abc"), 2);
assert.equal(isMergeCommit(1), false);
assert.equal(isMergeCommit(2), true);
assert.equal(hasSquashMarker("feat: add release toggle (#123)", ["(#"]), true);
assert.equal(hasSquashMarker("feat: add release toggle", ["(#"]), false);

const stableWithoutMerge = evaluateStablePrMergeRequirement({
  version: "0.3.0",
  requirePrMergeForStable: true,
  parentCount: 1,
  subject: "feat: direct commit"
});
assert.equal(stableWithoutMerge.allowed, false);
assert.equal(
  stableWithoutMerge.message,
  "Stable cuts require a PR merge into main (merge commit or 'merge:' subject)."
);

const stableWithMergeParents = evaluateStablePrMergeRequirement({
  version: "0.3.0",
  requirePrMergeForStable: true,
  parentCount: 2,
  subject: "feat: normal commit subject"
});
assert.equal(stableWithMergeParents.allowed, true);

const stableWithMergeSubject = evaluateStablePrMergeRequirement({
  version: "0.3.0",
  requirePrMergeForStable: true,
  parentCount: 1,
  subject: "merge: release branch",
  stableMergeStrategy: "merge_commit"
});
assert.equal(stableWithMergeSubject.allowed, true);

const stableWithMergeSubjectRejected = evaluateStablePrMergeRequirement({
  version: "0.3.0",
  requirePrMergeForStable: true,
  parentCount: 1,
  subject: "feat: release branch",
  stableMergeStrategy: "merge_commit"
});
assert.equal(stableWithMergeSubjectRejected.allowed, false);

const squashStrategyWithPrNumberMarker = evaluateStablePrMergeRequirement({
  version: "0.3.0",
  requirePrMergeForStable: true,
  parentCount: 1,
  subject: "feat(runtime): accept receipts",
  message: "feat(runtime): accept receipts (#123)",
  stableMergeStrategy: "merge_or_squash",
  squashMarkers: ["(#", "merge:"]
});
assert.equal(squashStrategyWithPrNumberMarker.allowed, true);

const squashStrategyWithMergeMarker = evaluateStablePrMergeRequirement({
  version: "0.3.0",
  requirePrMergeForStable: true,
  parentCount: 1,
  subject: "chore: merge marker in body",
  message: "chore: merge marker in body\n\nrelease train\nmerge: rc/v0.3.x",
  stableMergeStrategy: "merge_or_squash",
  squashMarkers: ["(#", "merge:"]
});
assert.equal(squashStrategyWithMergeMarker.allowed, true);

const squashStrategyWithoutMarkers = evaluateStablePrMergeRequirement({
  version: "0.3.0",
  requirePrMergeForStable: true,
  parentCount: 1,
  subject: "feat(runtime): no marker",
  message: "feat(runtime): no marker",
  stableMergeStrategy: "merge_or_squash",
  squashMarkers: ["(#", "merge:"]
});
assert.equal(squashStrategyWithoutMarkers.allowed, false);
assert.equal(
  squashStrategyWithoutMarkers.message,
  "Stable cuts require a PR merge into main (merge commit, or squash merge with PR marker like '(#123)')."
);

const prereleaseNoMerge = evaluateStablePrMergeRequirement({
  version: "0.3.0-rc.1",
  requirePrMergeForStable: true,
  parentCount: 1,
  subject: "feat: direct commit"
});
assert.equal(prereleaseNoMerge.allowed, true);
assert.equal(prereleaseNoMerge.required, false);

const stableGateDisabled = evaluateStablePrMergeRequirement({
  version: "0.3.0",
  requirePrMergeForStable: false,
  parentCount: 1,
  subject: "feat: direct commit"
});
assert.equal(stableGateDisabled.allowed, true);
assert.equal(stableGateDisabled.required, false);

const stableTagPass = evaluateStableTagGuardrails({
  tagName: "v0.3.1",
  tagPrefix: "v",
  isAnnotatedTag: true,
  commitOnMain: true,
  requirePrMergeForStable: true,
  stableMergeStrategy: "merge_commit",
  parentCount: 2,
  subject: "merge pull request #42 from team/release"
});
assert.equal(stableTagPass.allowed, true);

const stableTagLightweight = evaluateStableTagGuardrails({
  tagName: "v0.3.1",
  tagPrefix: "v",
  isAnnotatedTag: false,
  commitOnMain: true,
  requirePrMergeForStable: true,
  stableMergeStrategy: "merge_commit",
  parentCount: 2,
  subject: "merge pull request #42 from team/release"
});
assert.equal(stableTagLightweight.allowed, false);
assert.equal(stableTagLightweight.message, "Release tags must be annotated: v0.3.1");

const stableTagOffMain = evaluateStableTagGuardrails({
  tagName: "v0.3.1",
  tagPrefix: "v",
  isAnnotatedTag: true,
  commitOnMain: false,
  requirePrMergeForStable: true,
  stableMergeStrategy: "merge_commit",
  parentCount: 2,
  subject: "merge pull request #42 from team/release"
});
assert.equal(stableTagOffMain.allowed, false);
assert.equal(
  stableTagOffMain.message,
  "Stable tags must reference a commit reachable from origin/main."
);

const prereleaseTagOffMain = evaluateStableTagGuardrails({
  tagName: "v0.3.1-rc.1",
  tagPrefix: "v",
  isAnnotatedTag: true,
  commitOnMain: false,
  requirePrMergeForStable: true,
  stableMergeStrategy: "merge_commit",
  parentCount: 1,
  subject: "chore: rc"
});
assert.equal(prereleaseTagOffMain.allowed, true);

const offlineFallbackProceedsOnGenericLsRemoteFailure = evaluateOfflineTagLookupFallback({
  fetchHeadPermissionError: true,
  lsRemoteFailed: true,
  onMain: true,
  mainMatchesRemote: true,
  localTagExists: false,
  tagName: "v0.3.0"
});
assert.equal(offlineFallbackProceedsOnGenericLsRemoteFailure.proceed, true);
assert.equal(offlineFallbackProceedsOnGenericLsRemoteFailure.mode, "local-only");
assert.equal(
  offlineFallbackProceedsOnGenericLsRemoteFailure.warning,
  "Preflight warning: remote tag lookup unavailable (ls-remote failed). Falling back to local tag check only."
);

const offlineFallbackLocalTagExistsOnGenericLsRemoteFailure = evaluateOfflineTagLookupFallback({
  fetchHeadPermissionError: true,
  lsRemoteFailed: true,
  onMain: true,
  mainMatchesRemote: true,
  localTagExists: true,
  tagName: "v0.3.0"
});
assert.equal(offlineFallbackLocalTagExistsOnGenericLsRemoteFailure.proceed, false);
assert.equal(
  offlineFallbackLocalTagExistsOnGenericLsRemoteFailure.error,
  "Tag already exists locally: v0.3.0"
);

const offlineFallbackBlockedOnBranchOrSync = evaluateOfflineTagLookupFallback({
  fetchHeadPermissionError: true,
  lsRemoteFailed: true,
  onMain: false,
  mainMatchesRemote: true,
  localTagExists: false,
  tagName: "v0.3.0"
});
assert.equal(offlineFallbackBlockedOnBranchOrSync.proceed, false);
assert.equal(offlineFallbackBlockedOnBranchOrSync.error, "offline_fallback_not_allowed");

console.log("OK: release guardrails tests");

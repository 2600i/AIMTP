#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  evaluateOfflineTagLookupFallback,
  evaluateStablePrMergeRequirement,
  isStableVersion,
  parseParentCountFromRevList
} from "../scripts/release-guardrails.mjs";

assert.equal(isStableVersion("0.3.0"), true);
assert.equal(isStableVersion("10.20.30"), true);
assert.equal(isStableVersion("0.3.0-rc.1"), false);
assert.equal(isStableVersion("0.3.0+build.1"), false);

assert.equal(parseParentCountFromRevList("abc123 def456"), 1);
assert.equal(parseParentCountFromRevList("abc123 def456 789abc"), 2);

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
  subject: "merge: release branch"
});
assert.equal(stableWithMergeSubject.allowed, true);

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

const offlineFallbackProceeds = evaluateOfflineTagLookupFallback({
  fetchHeadPermissionError: true,
  lsRemoteFailed: true,
  onMain: true,
  mainMatchesRemote: true,
  localTagExists: false,
  tagName: "v0.3.0"
});
assert.equal(offlineFallbackProceeds.proceed, true);
assert.equal(offlineFallbackProceeds.mode, "local-only");
assert.equal(
  offlineFallbackProceeds.warning,
  "Preflight warning: remote tag lookup unavailable (offline). Falling back to local tag check only."
);

const offlineFallbackLocalTagExists = evaluateOfflineTagLookupFallback({
  fetchHeadPermissionError: true,
  lsRemoteFailed: true,
  onMain: true,
  mainMatchesRemote: true,
  localTagExists: true,
  tagName: "v0.3.0"
});
assert.equal(offlineFallbackLocalTagExists.proceed, false);
assert.equal(offlineFallbackLocalTagExists.error, "Tag already exists locally: v0.3.0");

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

#!/usr/bin/env node

import assert from "node:assert/strict";
import {
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

console.log("OK: release guardrails tests");

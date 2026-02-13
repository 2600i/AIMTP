export function isStableVersion(version) {
  return /^\d+\.\d+\.\d+$/.test(String(version ?? "").trim());
}

const STABLE_MERGE_STRATEGIES = new Set([
  "merge_commit",
  "merge_or_squash",
  "merge-commit",
  "merge-commit-or-subject"
]);
const DEFAULT_SQUASH_MARKERS = ["(#", "merge:"];

export function isStableMergeStrategy(value) {
  return STABLE_MERGE_STRATEGIES.has(String(value ?? "").trim().toLowerCase());
}

export function normalizeStableMergeStrategy(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "merge-commit" || normalized === "merge-commit-or-subject") {
    return normalized === "merge-commit" ? "merge_commit" : "merge_or_squash";
  }
  if (normalized === "merge_commit" || normalized === "merge_or_squash") {
    return normalized;
  }
  return "merge_commit";
}

function normalizeSquashMarkers(markers) {
  if (!Array.isArray(markers)) {
    return [...DEFAULT_SQUASH_MARKERS];
  }
  const normalized = markers
    .map((entry) => String(entry ?? "").trim())
    .filter((entry) => entry.length > 0);
  return normalized.length > 0 ? normalized : [...DEFAULT_SQUASH_MARKERS];
}

function hasLegacyMergeSubject(subject) {
  return String(subject ?? "").trim().toLowerCase().startsWith("merge:");
}

export function stableMergeRequirementMessage(stableMergeStrategy = "merge_commit") {
  if (stableMergeStrategy === "merge_or_squash") {
    return "Stable cuts require a PR merge into main (merge commit, or squash merge with PR marker like '(#123)').";
  }
  if (stableMergeStrategy === "merge_commit") {
    return "Stable cuts require a PR merge into main (merge commit or 'merge:' subject).";
  }
  return "Stable cuts require a PR merge into main.";
}

export function parseParentCountFromRevList(line) {
  const tokens = String(line ?? "")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return Math.max(0, tokens.length - 1);
}

export function isMergeCommit(parentCount) {
  return Number.isInteger(parentCount) && parentCount >= 2;
}

export function hasSquashMarker(message, markers) {
  const body = String(message ?? "");
  if (!body) {
    return false;
  }
  const lower = body.toLowerCase();
  return normalizeSquashMarkers(markers).some((marker) => lower.includes(marker.toLowerCase()));
}

function headLooksLikePrMerge(input = {}) {
  const stableMergeStrategy = normalizeStableMergeStrategy(input.stableMergeStrategy);
  const parentCount = Number.isInteger(input.parentCount) ? input.parentCount : 0;
  const subject = String(input.subject ?? "");
  const message = String(input.message ?? subject);
  const squashMarkers = normalizeSquashMarkers(input.squashMarkers);

  if (isMergeCommit(parentCount)) {
    return true;
  }

  if (stableMergeStrategy === "merge_commit") {
    return hasLegacyMergeSubject(subject);
  }

  if (stableMergeStrategy === "merge_or_squash") {
    return hasSquashMarker(message, squashMarkers);
  }

  return false;
}

export function evaluateStablePrMergeRequirement(input) {
  const version = String(input?.version ?? "").trim();
  const requirePrMergeForStable = input?.requirePrMergeForStable !== false;
  const stableMergeStrategy = normalizeStableMergeStrategy(input?.stableMergeStrategy);
  const parentCount = Number.isInteger(input?.parentCount) ? input.parentCount : 0;
  const subject = String(input?.subject ?? "");
  const message = String(input?.message ?? subject);
  const squashMarkers = normalizeSquashMarkers(input?.squashMarkers);
  const stable = isStableVersion(version);
  const required = stable && requirePrMergeForStable;

  if (!required) {
    return {
      stable,
      required,
      stableMergeStrategy,
      allowed: true,
      message: "",
      squashMarkers
    };
  }

  const allowed = headLooksLikePrMerge({
    parentCount,
    subject,
    message,
    squashMarkers,
    stableMergeStrategy
  });
  return {
    stable,
    required,
    stableMergeStrategy,
    allowed,
    message: allowed ? "" : stableMergeRequirementMessage(stableMergeStrategy),
    squashMarkers
  };
}

export function evaluateStableTagGuardrails(input) {
  const tagName = String(input?.tagName ?? "").trim();
  const tagPrefix = String(input?.tagPrefix ?? "v");
  const isAnnotatedTag = input?.isAnnotatedTag !== false;
  const commitOnMain = Boolean(input?.commitOnMain);
  const parentCount = Number.isInteger(input?.parentCount) ? input.parentCount : 0;
  const subject = String(input?.subject ?? "");
  const message = String(input?.message ?? subject);
  const requirePrMergeForStable = input?.requirePrMergeForStable !== false;
  const stableMergeStrategy = normalizeStableMergeStrategy(input?.stableMergeStrategy);
  const squashMarkers = normalizeSquashMarkers(input?.squashMarkers);
  const version = tagName.startsWith(tagPrefix) ? tagName.slice(tagPrefix.length) : tagName;
  const stable = isStableVersion(version);

  if (!isAnnotatedTag) {
    return {
      stable,
      required: stable && requirePrMergeForStable,
      stableMergeStrategy,
      allowed: false,
      message: tagName
        ? `Release tags must be annotated: ${tagName}`
        : "Release tags must be annotated."
    };
  }

  if (!stable) {
    return {
      stable,
      required: false,
      stableMergeStrategy,
      allowed: true,
      message: ""
    };
  }

  if (!commitOnMain) {
    return {
      stable,
      required: stable && requirePrMergeForStable,
      stableMergeStrategy,
      allowed: false,
      message: "Stable tags must reference a commit reachable from origin/main."
    };
  }

  if (
    requirePrMergeForStable &&
    !headLooksLikePrMerge({
      parentCount,
      subject,
      message,
      squashMarkers,
      stableMergeStrategy
    })
  ) {
    return {
      stable,
      required: true,
      stableMergeStrategy,
      allowed: false,
      message: stableMergeRequirementMessage(stableMergeStrategy),
      squashMarkers
    };
  }

  return {
    stable,
    required: stable && requirePrMergeForStable,
    stableMergeStrategy,
    allowed: true,
    message: "",
    squashMarkers
  };
}

export function evaluateOfflineTagLookupFallback(input) {
  const fetchHeadPermissionError = Boolean(input?.fetchHeadPermissionError);
  const lsRemoteFailed = Boolean(input?.lsRemoteFailed);
  const onMain = Boolean(input?.onMain);
  const mainMatchesRemote = Boolean(input?.mainMatchesRemote);
  const localTagExists = Boolean(input?.localTagExists);
  const tagName = String(input?.tagName ?? "").trim();

  if (!fetchHeadPermissionError || !lsRemoteFailed) {
    return {
      mode: "remote",
      proceed: true,
      warning: "",
      error: ""
    };
  }

  if (!onMain || !mainMatchesRemote) {
    return {
      mode: "remote",
      proceed: false,
      warning: "",
      error: "offline_fallback_not_allowed"
    };
  }

  const warning =
    "Preflight warning: remote tag lookup unavailable (ls-remote failed). Falling back to local tag check only.";
  if (localTagExists) {
    return {
      mode: "local-only",
      proceed: false,
      warning,
      error: tagName ? `Tag already exists locally: ${tagName}` : "Tag already exists locally."
    };
  }

  return {
    mode: "local-only",
    proceed: true,
    warning,
    error: ""
  };
}

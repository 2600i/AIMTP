export function isStableVersion(version) {
  return /^\d+\.\d+\.\d+$/.test(String(version ?? "").trim());
}

export function parseParentCountFromRevList(line) {
  const tokens = String(line ?? "")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return Math.max(0, tokens.length - 1);
}

export function headLooksLikePrMerge(parentCount, subject) {
  if (Number.isInteger(parentCount) && parentCount > 1) {
    return true;
  }
  return String(subject ?? "").trim().toLowerCase().startsWith("merge:");
}

export function evaluateStablePrMergeRequirement(input) {
  const version = String(input?.version ?? "").trim();
  const requirePrMergeForStable = input?.requirePrMergeForStable !== false;
  const parentCount = Number.isInteger(input?.parentCount) ? input.parentCount : 0;
  const subject = String(input?.subject ?? "");
  const stable = isStableVersion(version);
  const required = stable && requirePrMergeForStable;

  if (!required) {
    return {
      stable,
      required,
      allowed: true,
      message: ""
    };
  }

  const allowed = headLooksLikePrMerge(parentCount, subject);
  return {
    stable,
    required,
    allowed,
    message: allowed
      ? ""
      : "Stable cuts require a PR merge into main (merge commit or 'merge:' subject)."
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

  const warning = "Preflight warning: remote tag lookup unavailable (offline). Falling back to local tag check only.";
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

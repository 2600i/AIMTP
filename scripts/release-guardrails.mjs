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

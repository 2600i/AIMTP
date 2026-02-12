import { compareTransparencyHeads, type HeadCompare, type TransparencyHead } from "./trust-transparency";

export type SnapshotPolicyMode = "off" | "warn" | "enforce";
export type SnapshotDecision = "accept" | "warn" | "reject";

export interface TrustSnapshotState {
  readonly transparencyHead?: TransparencyHead;
  readonly bundleId?: string;
  readonly appliedSnapshotId?: string;
  readonly fetchedAtMs?: number;
  readonly source?: string;
}

export interface TrustSnapshotCandidate {
  readonly transparencyHead?: TransparencyHead;
  readonly bundleId?: string;
  readonly appliedSnapshotId?: string;
  readonly fetchedAtMs?: number;
  readonly source?: string;
}

export interface SnapshotEvaluation {
  readonly decision: SnapshotDecision;
  readonly reason: string | null;
  readonly relation: HeadCompare | null;
}

function decide(mode: SnapshotPolicyMode, warningReason: string): SnapshotEvaluation {
  if (mode === "enforce") {
    return {
      decision: "reject",
      reason: warningReason,
      relation: null
    };
  }
  if (mode === "warn") {
    return {
      decision: "warn",
      reason: warningReason,
      relation: null
    };
  }
  return {
    decision: "accept",
    reason: warningReason,
    relation: null
  };
}

export function evaluateTrustSnapshot(
  current: TrustSnapshotState | null,
  next: TrustSnapshotCandidate,
  mode: SnapshotPolicyMode
): SnapshotEvaluation {
  if (!current) {
    return {
      decision: "accept",
      reason: null,
      relation: null
    };
  }

  const currentHead = current.transparencyHead;
  const nextHead = next.transparencyHead;
  if (!currentHead && !nextHead) {
    return {
      decision: "accept",
      reason: null,
      relation: null
    };
  }
  if (currentHead && !nextHead) {
    if (mode === "warn") {
      return {
        decision: "warn",
        reason: "snapshot_head_missing",
        relation: null
      };
    }
    return {
      decision: "accept",
      reason: null,
      relation: null
    };
  }
  if (!currentHead && nextHead) {
    return {
      decision: "accept",
      reason: null,
      relation: null
    };
  }

  const relation = compareTransparencyHeads(nextHead!, currentHead!);
  if (relation === "equal" || relation === "ahead") {
    return {
      decision: "accept",
      reason: null,
      relation
    };
  }
  if (relation === "behind") {
    if (mode === "enforce") {
      return {
        decision: "reject",
        reason: "snapshot_behind",
        relation
      };
    }
    if (mode === "warn") {
      return {
        decision: "warn",
        reason: "snapshot_behind",
        relation
      };
    }
    return {
      decision: "accept",
      reason: "snapshot_behind",
      relation
    };
  }
  if (relation === "conflict") {
    if (mode === "enforce") {
      return {
        decision: "reject",
        reason: "snapshot_conflict",
        relation
      };
    }
    if (mode === "warn") {
      return {
        decision: "warn",
        reason: "snapshot_conflict",
        relation
      };
    }
    return {
      decision: "accept",
      reason: "snapshot_conflict",
      relation
    };
  }
  return decide(mode, "snapshot_policy_error");
}

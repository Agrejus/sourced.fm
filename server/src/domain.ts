// Shared domain shapes stored as JSON on the episode row.

export type Speaker = "HOST" | "EXPERT";

export interface Segment {
  idx: number;
  speaker: Speaker;
  text: string;
  startMs?: number;
}

export interface Script {
  title: string;
  segments: Segment[];
}

// factcheck_json (the audit trail rendered on the episode page).
export interface FactcheckClaim {
  segmentIdx: number;
  claim: string;
  verdict: "supported" | "unsupported" | "distorted";
  note: string;
  sourceUrl?: string;
}

export interface Factcheck {
  claims: FactcheckClaim[];
}

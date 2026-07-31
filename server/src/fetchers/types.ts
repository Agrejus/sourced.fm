// Frozen fetcher seam. Every input type resolves to the same Dossier; nothing
// downstream knows which fetcher ran.

export type SourceInput =
  | { kind: "article"; url: string }
  | { kind: "tweet"; url: string }
  | { kind: "youtube"; url: string }
  | { kind: "topic"; topic: string }
  // A written research assignment. `brief` is what the user typed, `seedUrls`
  // are the links inside it, which are read first and steer the plan.
  | { kind: "research"; brief: string; seedUrls: string[] };

export type Dossier = {
  markdown: string;
  title: string;
  sources: { title: string; url: string }[];
};

export type FetchError = {
  code: "http" | "empty" | "timeout" | "no_sources";
  message: string;
};

export type FetchResult =
  | { ok: true; value: Dossier }
  | { ok: false; error: FetchError };

// onProgress is advisory: a fetcher that takes minutes (deep research) reports
// what it is doing so the app can show it. Ignoring it changes nothing.
export type ProgressReporter = (note: string) => void;

export interface SourceFetcher {
  kind: SourceInput["kind"];
  fetch(input: SourceInput, onProgress?: ProgressReporter): Promise<FetchResult>;
}

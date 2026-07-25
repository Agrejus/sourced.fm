// Frozen fetcher seam. Every input type resolves to the same Dossier; nothing
// downstream knows which fetcher ran.

export type SourceInput =
  | { kind: "article"; url: string }
  | { kind: "tweet"; url: string }
  | { kind: "topic"; topic: string };

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

export interface SourceFetcher {
  kind: SourceInput["kind"];
  fetch(input: SourceInput): Promise<FetchResult>;
}

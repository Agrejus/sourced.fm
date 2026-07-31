import type { SourceFetcher, SourceInput } from "./types";
import { firecrawlFetcher } from "./firecrawl";
import { tweetFetcher } from "./tweet";
import { researchFetcher } from "./research";
import { deepResearchFetcher } from "./deepresearch";

export function fetcherFor(kind: SourceInput["kind"]): SourceFetcher {
  switch (kind) {
    case "article":
      return firecrawlFetcher;
    case "tweet":
      return tweetFetcher;
    case "topic":
      return researchFetcher;
    case "research":
      return deepResearchFetcher;
  }
}

export type { SourceFetcher, SourceInput } from "./types";
export { classifyInput, ClassifyError } from "./classify";
export { extractSeedUrls } from "./deepresearch";

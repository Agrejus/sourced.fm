import type { SourceFetcher, SourceInput } from "./types";
import { firecrawlFetcher } from "./firecrawl";
import { tweetFetcher } from "./tweet";
import { researchFetcher } from "./research";

export function fetcherFor(kind: SourceInput["kind"]): SourceFetcher {
  switch (kind) {
    case "article":
      return firecrawlFetcher;
    case "tweet":
      return tweetFetcher;
    case "topic":
      return researchFetcher;
  }
}

export type { SourceFetcher, SourceInput } from "./types";
export { classifyInput, ClassifyError } from "./classify";

// On-device playlists (listen queues). Stored in localStorage — personal to
// this browser/device; there is no server copy. Kept deliberately tiny: an
// ordered list of episode ids per named playlist.

export interface Playlist {
  id: string;
  name: string;
  episodeIds: string[];
}

const KEY = "learn.playlists.v1";

export function loadPlaylists(): Playlist[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (p): p is Playlist =>
        p && typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.episodeIds),
    );
  } catch {
    return [];
  }
}

export function savePlaylists(playlists: Playlist[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(playlists));
  } catch {
    /* storage full / disabled — playlists are best-effort */
  }
}

export function newId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `pl_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

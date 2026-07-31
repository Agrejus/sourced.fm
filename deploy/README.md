# Deploy

Seven services in one compose file. Only `learn` publishes a port (7900);
Firecrawl and the speech service stay on the internal network.

| Service | What it is |
| --- | --- |
| `learn` | Bun: API, PWA host, pipeline worker. Built from `server/Dockerfile` |
| `speech` | Python and FastAPI on the GPU: VibeVoice, Kokoro, faster-whisper |
| `firecrawl-api`, `playwright-service`, `redis`, `rabbitmq`, `nuq-postgres` | Self-hosted Firecrawl, pinned by image digest |

## 1. Prerequisites

- A container runtime with compose support and GPU passthrough.
- An NVIDIA GPU with about 11 GB of VRAM.
- **GPU access.** With rootless podman, generate a CDI spec and point the
  runtime at it:

  ```sh
  nvidia-ctk cdi generate --output="$HOME/.config/cdi/nvidia.yaml"
  mkdir -p "$HOME/.config/containers"
  printf '[engine]\ncdi_spec_dirs = ["%s/.config/cdi"]\n' "$HOME" \
    > "$HOME/.config/containers/containers.conf"
  ```

  A host driver upgrade invalidates the spec, because it hardcodes
  driver-versioned library paths. Regenerate it after every driver update.

- **SELinux.** Where SELinux is enforcing, rootless containers are denied
  `/dev/nvidia*` unless the container runs with `label=disable`. The `speech`
  service already sets it. Bind-mounted volumes are relabelled with `:z`.

Verify GPU passthrough before deploying:

```sh
podman run --rm --security-opt=label=disable --device nvidia.com/gpu=all \
  docker.io/nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

## 2. Secrets

`compose.yml` reads `../.env` (repo root). It is gitignored; create it:

```sh
OLLAMA_API_KEY=<your key>
FIRECRAWL_API_KEY=<any self-set token; not enforced when USE_DB_AUTHENTICATION=false>
```

`OLLAMA_HOST` (default `https://ollama.com`) and `OLLAMA_MODEL` are optional
overrides. Nothing is baked into an image; the values are read at runtime.

## 3. Build the app, then bring the stack up

The `learn` image copies `app/dist`, so build the PWA first:

```sh
cd app && bun install && bun run build
cd ../deploy && podman compose up -d --build
```

First boot pulls the Firecrawl images, and the speech container downloads model
weights (about 5 GB) into the `learn-models` volume on its first render.

## 4. HTTPS for the microphone

Voice questions need a secure context. Front the app with HTTPS however you
prefer: a reverse proxy holding a real certificate, or a tunnel that terminates
TLS for you. `tailscale serve --bg 7900` is the shortest path if the host is on
a tailnet, since it supplies a valid certificate with no DNS or port forwarding.
Over a plain `http://` address the app hides the voice controls, because
`getUserMedia` will refuse.

## 5. Verify

```sh
curl -s localhost:7900/api/healthz                  # {"ok":true}
curl -s localhost:7900/api/episodes                 # [] on a fresh install
podman exec <compose-project>-speech-1 curl -s localhost:7910/healthz
```

Firecrawl must **not** be reachable from outside the compose network; it
publishes no ports by design.

## Gotchas

- **Rootless podman and bind mounts.** The `learn` service runs as
  container-root so the host user maps correctly and can write the bind-mounted
  `data` directory. The `oven/bun` image otherwise runs as a non-root uid whose
  subuid cannot write host files.
- **A crash during synthesis is recoverable.** Boot resets any episode stuck at
  `synthesizing` back to `verified` so it re-renders.
- **Restarting mid-pipeline costs work.** A deep research run interrupted part
  way re-spends its tokens on retry. Check for in-flight episodes first.

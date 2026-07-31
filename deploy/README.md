# Deploy — Fedora box (rootless podman, RTX 2080 Ti)

The stack runs with rootless `podman compose`: `learn` (API + PWA + pipeline),
`speech` (GPU), and self-hosted Firecrawl v2.11.0 (`firecrawl-api`,
`playwright-service`, `redis`, `rabbitmq`, `nuq-postgres`). Only `learn`
publishes a port (7900); everything else is internal to the compose network.

## 1. One-time box setup

### GPU (CDI) — rootless, no sudo needed

A host **driver upgrade invalidates the CDI spec** (it hardcodes
driver-versioned library paths), so regenerate it into your user config dir and
point rootless podman at it:

```sh
nvidia-ctk cdi generate --output="$HOME/.config/cdi/nvidia.yaml"
mkdir -p "$HOME/.config/containers"
printf '[engine]\ncdi_spec_dirs = ["%s/.config/cdi"]\n' "$HOME" \
  > "$HOME/.config/containers/containers.conf"
```

The canonical root path is `sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`;
use the user-dir method above when you have no console/sudo.

### SELinux

The box runs SELinux enforcing. Rootless GPU containers are denied
`/dev/nvidia*` unless the container runs with `label=disable` — the `speech`
service in `compose.yml` already sets `security_opt: [label=disable]`.

Verify GPU passthrough before deploying:

```sh
podman run --rm --security-opt=label=disable --device nvidia.com/gpu=all \
  docker.io/nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
# must print "NVIDIA GeForce RTX 2080 Ti"
```

## 2. Secrets — `.env` at the repo root

`compose.yml` reads `../.env` (repo root). Create it (gitignored):

```sh
OLLAMA_API_KEY=<your Ollama Cloud key>
FIRECRAWL_API_KEY=<any self-set token; not enforced when USE_DB_AUTHENTICATION=false>
```

`OLLAMA_HOST` (default `https://ollama.com`) and `OLLAMA_MODEL` (default
`glm-5.2`) are optional overrides.

## 3. Ship code to the box

Bare-push over SSH, as rust-runtime does:

```sh
# on the box, once:
git init --bare ~/Repos/podcast-learning.git
git -C ~/Repos/podcast-learning.git config receive.denyCurrentBranch updateInstead
# clone the working tree the bare repo updates into ~/Repos/podcast-learning
# from your machine:
git remote add box ssh://<user>@<box-host>/~/Repos/podcast-learning.git
git push box build/podcast-learning
```

(`rsync -az ./ <user>@<box-host>:~/Repos/podcast-learning/` also works.)

## 4. Build the PWA, then bring the stack up

The `learn` image copies `app/dist`, so build the PWA first:

```sh
cd ~/Repos/podcast-learning/app && bun install && bun run build
cd ~/Repos/podcast-learning/deploy && podman compose up -d --build
```

First boot pulls the Firecrawl images (~GB) and, on the `speech` container's
first render, downloads the model weights (~5 GB) to the `learn-models` volume.

## 5. HTTPS via Tailscale (required for mic/voice)

`getUserMedia` needs a secure context, so the PWA must be reached over the
tailnet's real cert:

```sh
sudo tailscale up            # if not already up
sudo tailscale serve --bg 7900
```

## Gotchas (rootless podman + SELinux, VERIFIED 2026-07-25)

- **After regenerating the CDI spec or editing `containers.conf`, restart the
  rootless podman socket** so the compose path (docker-compose → podman socket)
  re-reads it — a long-lived socket service caches `cdi_spec_dirs`. Over a
  non-login SSH, set the user session env first:
  `export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user restart podman.socket`.
  Symptom if stale: `speech` fails with `cannot stat .../libEGL_nvidia.so.<old-version>`.
- **`learn` runs as `user: "0"` and mounts data with `:z`** — the `oven/bun`
  image otherwise runs as a non-root uid that (a) maps to a subuid that can't
  write the host-owned `./data` (rootless) and (b) is denied by SELinux without
  a relabel. `speech` sidesteps SELinux via `label=disable` (needed for
  `/dev/nvidia*` anyway).

## 6. Verify

```sh
# app is up
curl -s http://localhost:7900/api/healthz          # {"ok":true}
# Firecrawl is NOT reachable from the LAN (no published port):
curl http://<box-lan-ip>:3002                      # must FAIL/refuse
# PWA over HTTPS on the tailnet loads with a valid cert:
#   https://<tailnet-name>/
```

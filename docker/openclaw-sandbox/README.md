# OpenClaw Tool Sandbox

This image contains only the dependencies needed by Agent Guard's isolated
native-tool probes. OpenClaw, the Agent Guard plugin, credentials, and the
Docker socket are not included.

The accepted public image is:

```text
ghcr.io/wuyang39/openclaw-sandbox@sha256:01630cbb3486af7c0908b326d956d20722fde3ceada2775b53e547370a4e0e38
```

Pull this exact digest for the portable workflow. The canonical reference is
also recorded in `configs/openclaw-distribution.json`.

Build it from the repository root:

```powershell
.\scripts\build-openclaw-sandbox.ps1
```

The script prints the immutable local repository digest to assign to
`AGENT_GUARD_DETECTION_IMAGE`. The runtime manager adds the non-root UID/GID,
read-only root filesystem, dropped capabilities, resource limits, temporary
filesystems, labels, and network policy when it creates each container.

Local digest output requires a Docker engine that records repository digests
for local builds, such as Docker Desktop with the containerd image store
enabled. A classic image store commonly leaves `RepoDigests` empty for local
builds. In that environment, push and pull the image through a registry (or
import a previously published image artifact) before running acceptance; the
builder fails instead of returning a mutable tag.

The pinned Python base keeps the tool set stable (`python3`, `sh`, and
`timeout`). Publishing the image and archiving SBOM/provenance are separate
release-hardening steps.

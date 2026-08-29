# The CI container contract

**Context:** [Decide the generic CI container contract](https://github.com/phix/sonar-remediation-automation/issues/6) · decided 2026-08-29

Nick asked for *"a very generic docker container to initialize, download the source code etc, everything a ci should do."* GitHub Actions offers at least four ways to honour that sentence, and they are not equally right for every job.

## Decision

**Split by what the job actually needs.**

| Job | Shape | Image |
|---|---|---|
| `execute-remediation` — build, test, re-scan | explicit bootstrap container | `ubuntu:24.04` + [`scripts/ci-bootstrap.sh`](../../scripts/ci-bootstrap.sh) |
| `sonar-recon`, `recon-and-plan`, retry/escalation | `container:` on the job | `node:24-bookworm` |

The heavy path is where Nick wants to watch a CI job behave like a real one: pull a base image that knows nothing about the project, install the toolchain, clone the source, build, test, scan. The light paths only ever need node and jq, and making them pay a full bootstrap on every run buys nothing.

## Why not the other options

| Option | Rejected because |
|---|---|
| `container:` everywhere | The scanner needs a JRE 21+, which no stock node image carries. The execute job would need a bootstrap step anyway, so the "simplicity" is illusory — and it would stop being a demonstration of a generic runner. |
| Custom image published to GHCR | Faster, but it moves the toolchain into an artifact that has to be built, versioned, and kept honest. The thing being demonstrated — *a generic container that sets itself up* — would be baked away, and the office adoption story becomes "first, adopt our image". |
| Dev container | Nice symmetry with local dev, but the sandbox has no local dev to speak of. Machinery without a second user. |

## What it cost, measured

Both runs on Nick's Mac (Docker 29.7.2), cold image pull, cloning and fully building the sandbox app.

| | bootstrap (`ubuntu:24.04`) | stock (`node:24-bookworm`) |
|---|---|---|
| toolchain install | **28 s** | 0 s |
| through `npm ci` | 40 s | 13 s |
| build + test complete | **44 s** | **17 s** |
| Java available | **21+ ✅** | **none ❌** |

So the bootstrap costs about **27 seconds per run**. That is the number the caching trade-off should be argued from, and it is small enough that no caching is warranted yet: a 27-second toolchain install that is *visible in the log* is worth more here than a cache that hides it. When the sandbox grows, `actions/cache` on `~/.npm` is the first thing to reach for — not a prebuilt image, which would undo the decision above.

The second row is the one that settles the argument. A stock node image has **no JRE at all**, and `sonarqube-scan-action@v7` uses Scanner CLI v8, whose analyses on Java below 21 have been unsupported since 2026-07-20. The execute job cannot use the light shape even if it wanted to.

## Reproducing it locally

The whole point of a mirror is that the same thing runs on a laptop:

```bash
docker run --rm -v "$PWD/scripts:/ci:ro" ubuntu:24.04 /ci/ci-bootstrap.sh
```

Verified output:

```
=== [19:42:42] toolchain: versions ===
v24.20.0
11.19.0
openjdk version "21.0.12" 2026-07-21
OpenJDK Runtime Environment (build 21.0.12+8-1-24.04-Ubuntu)
OpenJDK 64-Bit Server VM (build 21.0.12+8-1-24.04-Ubuntu, mixed mode, sharing)
git version 2.43.0
jq-1.7
...
Test Files  2 passed (2)  |  Tests  12 passed (12)     (api)
Test Files  3 passed (3)  |  Tests   8 passed  (8)     (web)
timing_seconds toolchain=28 through_deps=40 total=44
```

The script asserts both version floors itself and exits non-zero if either is missed, so a base image that quietly ships Java 17 fails the job rather than failing the scan later with a confusing scanner error.

## Abstraction for the office

Every site-specific value in `ci-bootstrap.sh` is an environment variable with a default, so the internal version overrides rather than forks:

| Variable | Default | The office will change |
|---|---|---|
| `SANDBOX_REPO_URL` | `https://github.com/phix/sonar-sandbox-app.git` | to the target repo |
| `SANDBOX_REF` | `main` | usually the remediation branch |
| `NODE_MAJOR` | `24` | per application |
| `JRE_PACKAGE` | `openjdk-21-jre-headless` | if the base image is not Debian-family |
| `WORKDIR` | `/workspace` | rarely |

The base image itself is named once, in the workflow's `container:` key. An internal registry substitution is a one-line change, which is the property that matters — the office will not be pulling `ubuntu:24.04` from Docker Hub.

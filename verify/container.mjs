/**
 * The container gate: build the app's image, boot it, and prove it serves.
 *
 * ## Why this exists, stated as the thing it catches
 *
 * `npm test` structurally cannot see this class of breakage. The api suite
 * drives the Express app in-process through supertest, which never runs
 * `server.js`, never reads `PORT`, and never binds a socket; the web suite is
 * component tests. So a change that leaves every test green while making the
 * *built* app fail to start — a bad top-level import, a missing env var, a
 * route wired at construction time — passes everything the pipeline had and
 * merges. Building the image and booting it is the only step that runs the
 * real entry point.
 *
 * ## What it is NOT allowed to claim
 *
 * It does not decide whether a code smell is fixed, and nothing downstream may
 * read it that way. "The app boots and answers" is the whole claim. A smell is
 * gone when Sonar's re-scan stops reporting it, which is a different question
 * asked after the push, by a different service — see
 * `docs/decisions/container-gate.md`. This gate's verdict is a gate on the
 * PUSH, exactly like the test suite beside it, and it is red for the same kind
 * of reason.
 */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

export const DEFAULT_PORT = 3000;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_TAG = 'sonar-sandbox-app:gate';

/**
 * Real command runner. Never rejects: a non-zero exit is an answer, not an
 * exception, which keeps every caller from needing its own try/catch to tell
 * "docker said no" from "docker is not installed".
 */
export async function defaultRun(cmd, args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      maxBuffer: 32 * 1024 * 1024, ...opts
    });
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (e) {
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? String(e)
    };
  }
}

/** The tail of docker's complaint is the useful part; the head is progress output. */
function tail(text, n = 400) {
  const s = String(text ?? '').trim();
  return s.length <= n ? s : `…${s.slice(-n)}`;
}

/**
 * Poll until the app answers or the deadline passes. Returns the LAST failure
 * rather than a bare boolean, because "it never came up" and "it came up and
 * then 500'd" are different problems and the log should say which.
 */
export async function waitForHealth(url, {
  fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now()
} = {}) {
  const deadline = now() + timeoutMs;
  let last = 'no attempt made';
  for (;;) {
    try {
      const res = await fetchImpl(url);
      if (res.ok) return { ok: true };
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e.message;
    }
    if (now() >= deadline) {
      return { ok: false, reason: `the app did not answer ${url} within ${timeoutMs}ms (last: ${last})` };
    }
    await sleep(intervalMs);
  }
}

/**
 * @param {object} o
 * @param {string} o.root      checkout to build
 * @param {number} o.port      host port to publish
 * @param {string} o.tag       image tag
 * @param {string} o.docker    CLI to drive (podman works; nothing docker-specific is used)
 * @param {function} o.run     (cmd, args) -> {code, stdout, stderr}; injectable
 * @returns {{ok: boolean, built: boolean, booted: boolean, checks: object[], reason: string|null}}
 */
export async function containerGate({
  root = '.', port = DEFAULT_PORT, tag = DEFAULT_TAG, docker = 'docker',
  timeoutMs = DEFAULT_TIMEOUT_MS, run = defaultRun,
  fetchImpl = globalThis.fetch, sleep, now, log = () => {}
} = {}) {
  const checks = [];
  const name = `${tag.replace(/[^A-Za-z0-9_.-]/g, '-')}-gate`;
  const fail = (reason, extra = {}) => ({ ok: false, built: false, booted: false, checks, reason, ...extra });

  log(`building ${tag} from ${root}`);
  const build = await run(docker, ['build', '-t', tag, root]);
  if (build.code !== 0) {
    return fail(`${docker} build failed (exit ${build.code}): ${tail(build.stderr || build.stdout)}`);
  }
  checks.push({ name: 'image built', ok: true });

  // A container left behind by a killed run holds both the name and the
  // published port, and would make this gate red for a reason with nothing to
  // do with the code. Best-effort, and deliberately not an error if there was
  // none to remove. The IMAGE is deliberately left alone — it is the thing the
  // run just produced and may be wanted for inspection.
  await run(docker, ['rm', '-f', name]);

  log(`booting ${name} on port ${port}`);
  const started = await run(docker, [
    'run', '--rm', '-d', '--name', name, '-p', `${port}:${DEFAULT_PORT}`,
    '-e', `PORT=${DEFAULT_PORT}`, tag
  ]);
  if (started.code !== 0) {
    return fail(`${docker} run failed (exit ${started.code}): ${tail(started.stderr || started.stdout)}`);
  }
  const containerId = started.stdout.trim().split('\n').pop();
  checks.push({ name: 'container started', ok: true, containerId });

  let booted = false;
  let reason = null;
  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/health`, {
      fetchImpl, timeoutMs, sleep, now
    });
    if (!health.ok) {
      // The container's own log is where the actual stack trace is; docker's
      // exit status only ever says "not running".
      const logs = await run(docker, ['logs', name]);
      reason = `${health.reason}. Container log: ${tail(`${logs.stdout}${logs.stderr}`, 1200)}`;
      checks.push({ name: 'health endpoint', ok: false });
    } else {
      booted = true;
      checks.push({ name: 'health endpoint', ok: true });

      // /health is a stub that answers before the app has wired anything. This
      // is the check that proves the router, service and store are reachable
      // from the real process.
      const res = await fetchImpl(`http://127.0.0.1:${port}/api/orders`);
      const body = res.ok ? await res.json().catch(() => null) : null;
      const listOk = Array.isArray(body?.orders);
      checks.push({ name: 'GET /api/orders', ok: res.ok && listOk });
      if (!res.ok) reason = `the app booted but GET /api/orders answered HTTP ${res.status}`;
      else if (!listOk) reason = 'the app booted but GET /api/orders did not return an {orders: []} payload';
    }
  } finally {
    // Always, including on the failure path above — a gate that leaks a
    // container per run wedges the runner for the next one.
    await run(docker, ['rm', '-f', name]);
  }

  return { ok: reason === null, built: true, booted, checks, reason, containerId };
}

export function renderGateReport(result, tag = DEFAULT_TAG) {
  const l = ['<!-- sonar-container-gate -->', '### Container gate', ''];
  l.push(result.ok
    ? `**Passed.** \`${tag}\` built, booted, and answered on every check.`
    : `**Failed.** ${result.reason}`);
  l.push('', '| Check | Result |', '|---|---|');
  for (const c of result.checks) l.push(`| ${c.name} | ${c.ok ? 'ok' : '**failed**'} |`);
  l.push('', 'This gate proves the built app boots and serves. It does **not** prove any '
    + 'finding is fixed — that is the re-scan\'s verdict, not this one.');
  return l.join('\n');
}

export async function main(argv) {
  const args = argv.slice(2);
  const val = (n, d) => {
    const i = args.indexOf(`--${n}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const tag = val('tag', DEFAULT_TAG);
  const result = await containerGate({
    root: val('root', '.'),
    port: Number(val('port', DEFAULT_PORT)),
    tag,
    docker: val('docker', 'docker'),
    timeoutMs: Number(val('timeout', DEFAULT_TIMEOUT_MS)),
    log: (m) => console.log(`container-gate: ${m}`)
  });
  for (const c of result.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}`);
  if (!result.ok) console.error(`container-gate: ${result.reason}`);
  const out = val('json');
  if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync('container-gate-comment.md', renderGateReport(result, tag));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).then((code) => process.exit(code));
}

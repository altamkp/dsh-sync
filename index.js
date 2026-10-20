/**
 * DSH Sync — sync DeepSeek Harness plugins and settings across devices
 * through a GitHub repository the user owns.
 *
 * A git checkout under ~/.dsh-sync/<profile>/repo is the local cache. Every
 * snapshot regenerates dsh-sync.json from live Harness state and commits it
 * (snapshot); push additionally pushes the branch to GitHub; pull resets the
 * checkout to the remote branch and applies the manifest through the same
 * services the Web UI uses — pluginManager for bundles and plugin rows,
 * configEditor for plugin configurations. Secret-shaped config values are
 * never written to the manifest.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';

const SYNC_ENTRY_ID = 'dsh-sync';
const MANIFEST_FILE = 'dsh-sync.json';
const MANIFEST_VERSION = 1;
const DEFAULT_SECRET_SEGMENTS = ['key', 'token', 'tokens', 'secret', 'password', 'passphrase', 'credential', 'pat', 'bearer'];
const DEFAULT_BENIGN_QUALIFIERS = ['max', 'min', 'limit', 'limits', 'output', 'inline', 'total', 'default', 'context', 'window', 'input', 'completion', 'prompt', 'reasoning', 'cached', 'budget', 'threshold', 'per'];
const READ_ACTIONS = new Set(['status', 'diff']);
const LIST_LIMIT = 25;
/** Timeout for the reachability probe the page and the tool's status use. */
const PROBE_TIMEOUT_MS = 15000;
/** Timeout for one GitHub CLI call. */
const GH_TIMEOUT_MS = 15000;

/** Plugin configuration; users edit these values in the profile patch. */
export const Config = z.object({
  repoUrl: z.string().default('').description('GitHub repository that holds the sync snapshot, e.g. https://github.com/<owner>/<repo>. Empty until dsh_sync configure assigns one.'),
  branch: z.string().default('main').description('Branch to sync on the remote repository.'),
  authMode: z.union([z.const('gh'), z.const('pat')]).default('gh').description('How the GitHub repository is authenticated. "gh" (the default) uses the credential of the account the GitHub CLI is logged in as; "pat" uses the personal access token found in the environment variable named by githubTokenEnv. An SSH remote is authenticated by your SSH key in either mode.'),
  githubTokenEnv: z.string().default('DSH_SYNC_GITHUB_TOKEN').description('Name of the environment variable holding the GitHub personal access token used for HTTPS remotes when authMode is "pat". When unset, git credential helpers or SSH remotes provide access.'),
  commitName: z.string().default('DSH Sync').description('Git author name for snapshot commits.'),
  commitEmail: z.string().default('dsh-sync@users.noreply.github.com').description('Git author email for snapshot commits.'),
  redactKeySegments: z.string().default(DEFAULT_SECRET_SEGMENTS.join(',')).description('Comma-separated key words that mark a config key as secret (matched per camelCase/underscore word). Those values are omitted from the manifest and never leave this device.'),
  redactBenignQualifiers: z.string().default(DEFAULT_BENIGN_QUALIFIERS.join(',')).description('Comma-separated words that make a secret-looking key benign when they precede it, e.g. "max" in "maxTokens" — such values are synced like any other setting.'),
  timeoutMs: z.number().step(1).min(5000).default(120000).description('Per git-command timeout in milliseconds.'),
});

export const inject = ['tools', 'pluginManager', 'configEditor', 'profileContext', 'sandboxPolicy'];

/* ----------------------------- small helpers ----------------------------- */

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function deepMerge(base, over) {
  if (over === undefined) return base;
  if (isPlainObject(base) && isPlainObject(over)) {
    const out = { ...base };
    for (const [key, value] of Object.entries(over)) out[key] = deepMerge(out[key], value);
    return out;
  }
  return over;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function getPath(root, path) {
  let current = root;
  for (const segment of String(path).split('.')) {
    if (current === null || current === undefined) return undefined;
    current = current[segment];
  }
  return current;
}

function setPath(root, path, value) {
  const segments = String(path).split('.');
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const next = current[segment];
    if (next === null || next === undefined || typeof next !== 'object') {
      current[segment] = /^\d+$/.test(segments[index + 1]) ? [] : {};
    }
    current = current[segment];
  }
  current[segments[segments.length - 1]] = value;
  return root;
}

/** Split a config key into its camelCase/underscore words, lowercased. */
function splitKeyWords(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
}

/**
 * A key is secret when one of its words names a credential — "apiKey",
 * "authToken", "password" — unless a benign qualifier precedes it, so
 * "maxTokens" stays an ordinary setting while "apiKeyEnv" does not.
 */
function secretKeyPredicate(secretWords, benignWords) {
  return (key) => {
    const words = splitKeyWords(key);
    for (let index = 0; index < words.length; index += 1) {
      if (!secretWords.has(words[index])) continue;
      const previous = index > 0 ? words[index - 1] : undefined;
      if (previous !== undefined && benignWords.has(previous)) continue;
      return true;
    }
    return false;
  };
}

/** Omit every value whose config key looks like a secret; report the omitted paths. */
function redactSecrets(value, isSecretKey) {
  const redacted = [];
  const walk = (node, prefix) => {
    if (Array.isArray(node)) return node.map((item, index) => walk(item, prefix === '' ? String(index) : `${prefix}.${index}`));
    if (isPlainObject(node)) {
      const out = {};
      for (const [key, child] of Object.entries(node)) {
        const path = prefix === '' ? key : `${prefix}.${key}`;
        if (isSecretKey(key)) {
          redacted.push(path);
          continue;
        }
        out[key] = walk(child, path);
      }
      return out;
    }
    return node;
  };
  return { value: walk(value, ''), redacted };
}

function tail(text, lines = 6) {
  const rows = String(text ?? '').split(/\r?\n/).filter((line) => line.trim() !== '');
  return rows.slice(-lines).join('\n');
}

/**
 * Why a remote probe failed, so the page can say whether the repository is
 * out of reach or refused the access.
 *
 * Git prints the specific reason first and a generic line after it, so the
 * specific patterns are tested first: "Permission denied" or "Repository not
 * found" mean the credentials or the repository rights are wrong, while
 * "Could not resolve host" or "Connection timed out" mean the network is.
 */
function classifyRemoteFailure(stderr) {
  const text = String(stderr ?? '').toLowerCase();
  if (/denied|authentication failed|permission|not found|forbidden|credential|terminal prompts disabled|invalid username|could not read username|403|404/.test(text)) return 'denied';
  if (/could not resolve|failed to connect|timed out|timeout|unreachable|connection refused|connection reset|no route to host|proxy|could not read from remote/.test(text)) return 'unreachable';
  return 'unknown';
}

function truncateList(items) {
  return items.length <= LIST_LIMIT ? items : [...items.slice(0, LIST_LIMIT), `…and ${items.length - LIST_LIMIT} more`];
}

/* ------------------------------ git engine ------------------------------- */

class GitError extends Error {
  constructor(message, detail) {
    super(detail === undefined ? message : `${message}\n${detail}`);
    this.name = 'GitError';
  }
}

/**
 * Run one command and capture its result.
 *
 * A program that is not installed is reported as `missing-command`, so the
 * caller can tell "the tool is not there" from "the tool failed" — the two
 * need different answers for the user.
 */
function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeout: options.timeoutMs ?? 120000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      ...(options.signal ? { signal: options.signal } : {}),
    }, (error, stdout, stderr) => {
      if (error && error.code === 'ENOENT') {
        resolve({
          code: 'missing-command',
          stdout: '',
          stderr: `the command line tool "${command}" was not found on PATH`,
          error,
        });
        return;
      }
      resolve({
        code: error === null || error === undefined ? 0 : (typeof error.code === 'number' ? error.code : 1),
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        error,
      });
    });
  });
}

function runGit(settings, args, options = {}) {
  return runCommand('git', ['--no-optional-locks', ...args], {
    ...options,
    timeoutMs: options.timeoutMs ?? settings.timeoutMs,
  }).then((result) => {
    if (result.code !== 'missing-command') return result;
    // ENOENT means either that git is not installed or that the working
    // directory is gone; the two need different answers.
    const cwdMissing = options.cwd !== undefined && !existsSync(options.cwd);
    return {
      code: cwdMissing ? 'missing-dir' : 'missing-git',
      stdout: '',
      stderr: cwdMissing
        ? `the working directory ${options.cwd} does not exist`
        : 'the git command line tool was not found on PATH; install Git from https://git-scm.com',
      error: result.error,
    };
  });
}

function mustGit(result, what) {
  if (result.code === 'missing-git') throw new GitError(`dsh-sync: cannot ${what}: ${result.stderr}`);
  if (result.code === 'missing-dir') throw new GitError(`dsh-sync: cannot ${what}: ${result.stderr}`);
  if (result.code !== 0) throw new GitError(`dsh-sync: git ${what} failed (exit ${result.code})`, tail(result.stderr));
  return result;
}

/**
 * The environment a git command runs in.
 *
 * The host has no terminal: a credential prompt would hang the command
 * until the timeout, so git fails fast and the reason reaches the user.
 * An HTTPS GitHub remote carries its token as an authorization header, so
 * the token appears neither in the remote URL, nor in the process arguments,
 * nor in the configuration.
 */
function authEnvironment(settings, remoteUrl, credentials) {
  const env = { ...process.env };
  env.GIT_TERMINAL_PROMPT = '0';
  const token = credentials?.token;
  if (token !== undefined && /^https:\/\/github\.com\//i.test(remoteUrl)) {
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = header;
  }
  return env;
}

function resolveToken(settings) {
  const name = (settings.githubTokenEnv ?? '').trim();
  if (name === '' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
  const value = (process.env[name] ?? '').trim();
  return value === '' ? undefined : value;
}

/* ------------------------------ credentials ------------------------------- */

/**
 * The credential the GitHub CLI already holds for github.com.
 *
 * `gh auth token` reads the login the CLI has — the system keyring, its own
 * configuration file, or GH_TOKEN — without contacting GitHub, so it answers
 * quickly and works offline. The token never leaves this function except as
 * the credential of a git command.
 */
async function ghCredential({ signal } = {}) {
  const result = await runCommand('gh', ['auth', 'token', '--hostname', 'github.com'], {
    env: process.env,
    timeoutMs: GH_TIMEOUT_MS,
    signal,
  });
  if (result.code === 'missing-command') {
    return {
      available: false,
      authenticated: false,
      reason: 'missing-gh',
      error: 'the GitHub CLI (gh) is not installed; install it from https://cli.github.com or use a personal access token instead',
    };
  }
  if (result.code !== 0) {
    return {
      available: true,
      authenticated: false,
      reason: 'not-authenticated',
      error: tail(result.stderr, 4) || 'the GitHub CLI is not logged in; run `gh auth login`',
    };
  }
  const token = result.stdout.trim();
  if (token === '') {
    return {
      available: true,
      authenticated: false,
      reason: 'not-authenticated',
      error: 'the GitHub CLI holds no token for github.com; run `gh auth login`',
    };
  }
  return { available: true, authenticated: true, token };
}

/** The account the GitHub CLI acts as, read from its own configuration. */
async function ghAccount({ signal } = {}) {
  const config = await runCommand('gh', ['config', 'get', 'user', '--host', 'github.com'], {
    env: process.env,
    timeoutMs: GH_TIMEOUT_MS,
    signal,
  });
  const fromConfig = config.code === 0 ? config.stdout.trim() : '';
  if (fromConfig !== '') return fromConfig;
  // The configuration file does not always name the account; the status
  // output does, but it needs the network.
  const status = await runCommand('gh', ['auth', 'status', '--hostname', 'github.com'], {
    env: process.env,
    timeoutMs: GH_TIMEOUT_MS,
    signal,
  });
  const match = /Logged in to github\.com account (\S+)/i.exec(`${status.stdout}\n${status.stderr}`);
  return match?.[1];
}

/**
 * The credential this device authenticates the GitHub remote with.
 *
 * `gh` mode — the default — asks the GitHub CLI for the token of the account
 * it is logged in as. `pat` mode reads a personal access token from the
 * environment variable named by `githubTokenEnv`. The token is applied to
 * HTTPS remotes only; an SSH remote is authenticated by the user's SSH key.
 */
async function resolveCredentials(settings, { signal } = {}) {
  if (settings.authMode === 'pat') {
    const token = resolveToken(settings);
    return {
      mode: 'pat',
      token,
      ok: token !== undefined,
      reason: token === undefined ? 'no-token' : undefined,
      source: token === undefined ? 'no credential' : `the environment variable ${settings.githubTokenEnv}`,
      error: token === undefined
        ? (settings.githubTokenEnv === ''
          ? 'no environment variable is configured for the personal access token (githubTokenEnv is empty)'
          : `the environment variable ${settings.githubTokenEnv} is empty or not set`)
        : undefined,
    };
  }
  const gh = await ghCredential({ signal });
  const account = gh.authenticated ? await ghAccount({ signal }) : undefined;
  return {
    mode: 'gh',
    token: gh.token,
    ok: gh.authenticated,
    reason: gh.reason,
    error: gh.error,
    ...(account === undefined ? {} : { account }),
    source: gh.authenticated ? 'the GitHub CLI' : 'no credential',
  };
}

/** What the user can do about a credential that is not usable. */
function credentialHint(settings, credentials) {
  switch (credentials?.reason) {
    case 'missing-gh':
      return 'the GitHub CLI (gh) is not installed — install it from https://cli.github.com, or switch the authentication mode to a personal access token';
    case 'not-authenticated':
      return 'the GitHub CLI is not logged in — run `gh auth login`, or switch the authentication mode to a personal access token';
    case 'no-token':
      return settings.githubTokenEnv === ''
        ? 'no environment variable is configured for the personal access token — set githubTokenEnv, or switch the authentication mode to the GitHub CLI'
        : `the environment variable ${settings.githubTokenEnv} is empty — set a personal access token, or switch the authentication mode to the GitHub CLI`;
    default:
      return undefined;
  }
}

/**
 * What the page and the tool show about the credential in use.
 *
 * The token itself never appears here — only where it came from and whether
 * it is there at all.
 */
function authenticationBlock(settings, credentials, remote) {
  const block = {
    mode: credentials.mode,
    ok: credentials.ok,
    source: credentials.source,
  };
  if (credentials.account !== undefined) block.account = credentials.account;
  if (credentials.mode === 'pat') {
    block.tokenEnv = settings.githubTokenEnv;
    block.tokenPresent = credentials.token !== undefined;
  } else {
    block.cliAvailable = credentials.reason !== 'missing-gh';
    block.authenticated = credentials.token !== undefined;
  }
  if (credentials.reason !== undefined) block.reason = credentials.reason;
  if (credentials.error !== undefined) block.error = credentials.error;
  if (remote !== undefined) {
    block.remoteKind = isSshRemote(remote) ? 'ssh' : 'https';
    if (block.remoteKind === 'ssh') {
      block.note = 'the remote is an SSH URL: your SSH key authenticates it, so no token is used';
    }
  }
  return block;
}

/** Whether a remote URL is an SSH one, which the user's SSH key authenticates. */
function isSshRemote(remoteUrl) {
  return /^(?:ssh:\/\/|git@)/i.test(String(remoteUrl ?? ''));
}

/** The owner and repository of a GitHub remote URL. */
function parseGithubSlug(remoteUrl) {
  const text = String(remoteUrl ?? '').trim();
  const match = /^(?:github:([^/\s]+)\/([^/\s#?]+)|git@github\.com:([^/\s]+)\/([^/\s#?]+)|https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+))(?:\.git)?$/i.exec(text);
  if (match === null) return undefined;
  const owner = match[1] ?? match[3] ?? match[5];
  const repo = (match[2] ?? match[4] ?? match[6])?.replace(/\.git$/i, '');
  if (owner === undefined || repo === undefined || repo === '') return undefined;
  return { owner, repo };
}

/**
 * Whether the credential may write to the repository.
 *
 * The GitHub API answers with the permissions the token holds, which says
 * more than reachability does: a read-only token reaches a private
 * repository but cannot push to it. The answer is advisory — a failure here
 * never blocks an operation.
 */
async function checkWriteAccess(remote, credentials, { signal } = {}) {
  if (credentials?.token === undefined) return undefined;
  const slug = parseGithubSlug(remote);
  if (slug === undefined) return undefined;
  try {
    const response = await fetch(`https://api.github.com/repos/${slug.owner}/${slug.repo}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${credentials.token}`,
        'user-agent': 'dsh-sync',
        'x-github-api-version': '2022-11-28',
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 404) return { canPush: false, reason: 'no-access' };
    if (!response.ok) return undefined;
    const payload = await response.json();
    const permissions = payload?.permissions ?? {};
    return { canPush: permissions.push === true, private: payload.private === true };
  } catch {
    // The advisory check never fails an operation.
    return undefined;
  }
}

/** Accept https, ssh, and shorthand GitHub repository references; normalize to a remote URL. */
function parseGithubRemote(raw) {
  const url = String(raw ?? '').trim();
  if (url === '') return undefined;
  let match = /^github:([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i.exec(url);
  if (match !== null) return `https://github.com/${match[1]}/${match[2]}.git`;
  match = /^git@github\.com:([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i.exec(url);
  if (match !== null) return `git@github.com:${match[1]}/${match[2]}.git`;
  match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?$/i.exec(url);
  if (match !== null) return `https://github.com/${match[1]}/${match[2]}.git`;
  throw new Error(`dsh-sync: repoUrl must be a GitHub repository — https://github.com/<owner>/<repo>, git@github.com:<owner>/<repo>.git, or github:<owner>/<repo> — but got: ${url}`);
}

function validBranch(branch) {
  return /^[^\s~^:?*[\]\\]+$/i.test(branch)
    && !branch.startsWith('/') && !branch.startsWith('-') && !branch.startsWith('.')
    && !branch.endsWith('/') && !branch.endsWith('.lock')
    && !branch.includes('..') && !branch.includes('//') && !branch.includes('@{');
}

function checkoutDirectory(ctx) {
  const profile = String(ctx.profileContext?.name ?? 'default');
  const safe = profile.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
  return join(homedir(), '.dsh-sync', safe, 'repo');
}

/**
 * Make sure the local checkout exists, points at the configured remote, and —
 * when `fetch` is set — knows the remote branch. The checkout is a managed
 * cache: when the remote branch exists it is hard-reset to it.
 */
async function ensureCheckout(ctx, settings, remote, { fetch, signal }) {
  const dir = checkoutDirectory(ctx);
  const credentials = await resolveCredentials(settings, { signal });
  const env = authEnvironment(settings, remote, credentials);
  const cwd = { cwd: dir, env, signal };
  await fsp.mkdir(dir, { recursive: true });

  if (!existsSync(join(dir, '.git'))) {
    mustGit(await runGit(settings, ['init'], cwd), 'init');
    mustGit(await runGit(settings, ['symbolic-ref', 'HEAD', `refs/heads/${settings.branch}`], cwd), 'set initial branch');
  }
  const current = await runGit(settings, ['remote', 'get-url', 'origin'], cwd);
  if (current.code !== 0 || current.stdout.trim() !== remote) {
    const set = await runGit(settings, ['remote', 'set-url', 'origin', remote], cwd);
    if (set.code !== 0) mustGit(await runGit(settings, ['remote', 'add', 'origin', remote], cwd), 'add remote');
  }

  let fetchError;
  let hasRemoteBranch = false;
  if (fetch) {
    const fetched = await runGit(settings, ['fetch', 'origin', settings.branch], cwd);
    if (fetched.code === 'missing-git') throw new GitError(`dsh-sync: ${fetched.stderr}`);
    if (fetched.code === 0) {
      const verify = await runGit(settings, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${settings.branch}`], cwd);
      hasRemoteBranch = verify.code === 0;
    } else {
      fetchError = tail(fetched.stderr, 4);
    }
    if (hasRemoteBranch) {
      mustGit(await runGit(settings, ['reset', '--hard', `origin/${settings.branch}`], cwd), 'align to remote branch');
      await runGit(settings, ['clean', '-fd'], cwd);
    }
  }
  return { dir, env, hasRemoteBranch, fetchError, signal, credentials, credentialHint: credentialHint(settings, credentials) };
}

/* --------------------------- manifest read/write -------------------------- */

/** Read live Harness state into a manifest object. */
async function gatherState(ctx, settings) {
  const bundles = [];
  for (const bundle of await ctx.pluginManager.listBundles()) {
    if (bundle.availability === 'missing') continue;
    if (bundle.installed !== true && bundle.enabled !== true) continue;
    bundles.push({
      name: bundle.name,
      enabled: bundle.enabled === true,
      installed: bundle.installed === true,
      availability: bundle.availability,
      ...(typeof bundle.source === 'string' && bundle.source !== '' ? { source: bundle.source } : {}),
    });
  }

  const plugins = [];
  for (const row of await ctx.pluginManager.listPlugins()) {
    plugins.push({
      entryId: row.entryId,
      moduleName: row.moduleName,
      enabled: row.enabled === true,
      ...(row.patchId !== undefined ? { patchId: row.patchId } : {}),
      ...(row.readOnlyReason !== undefined ? { readOnlyReason: row.readOnlyReason } : {}),
    });
  }

  const configs = [];
  for (const { entry, inherited, override } of ctx.configEditor.configuration()) {
    // Only the profile layer's own values travel: a value a bundle ships as its
    // default arrives with the bundle on every device, and copying it into the
    // profile would pin it there.
    if (Object.keys(override).length === 0) continue;
    const { value, redacted } = redactSecrets(override, settings.isSecretKey);
    configs.push({
      id: entry.options.id,
      ...(typeof entry.options.name === 'string' && entry.options.name !== '' ? { name: entry.options.name } : {}),
      config: value,
      ...(redacted.length > 0 ? { redacted } : {}),
    });
  }

  return {
    manifestVersion: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    device: hostname(),
    profile: String(ctx.profileContext?.name ?? ''),
    bundles,
    plugins,
    configs,
  };
}

async function writeManifest(dir, manifest) {
  await fsp.writeFile(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function readManifest(dir) {
  const path = join(dir, MANIFEST_FILE);
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(await fsp.readFile(path, 'utf8'));
  if (raw?.manifestVersion !== MANIFEST_VERSION) {
    throw new Error(`dsh-sync: unsupported manifest version ${JSON.stringify(raw?.manifestVersion)} in ${MANIFEST_FILE}; this device runs manifest version ${MANIFEST_VERSION}`);
  }
  return raw;
}

/* ------------------------------- apply logic ------------------------------ */

function changeFields(result) {
  if (result === null || typeof result !== 'object') return {};
  const out = {};
  for (const key of ['application', 'restartReason', 'changed']) {
    if (result[key] !== undefined) out[key] = result[key];
  }
  if (result.error !== undefined) out.error = typeof result.error === 'object' ? { code: result.error.code, message: result.error.message } : String(result.error);
  if (Array.isArray(result.pendingBuilds) && result.pendingBuilds.length > 0) {
    out.pendingBuilds = result.pendingBuilds;
    out.note = 'build scripts need approval; rerun install via plugin_manager install_bundle with approvedBuilds after the user approves';
  }
  return out;
}

function isLocalPathSpec(spec) {
  return /^(?:file|link):/i.test(spec) || /^(?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])/.test(spec);
}

/** Make this device match the remote manifest. */
async function applyManifest(ctx, manifest) {
  const steps = [];
  const changed = [];
  const skippedSteps = [];
  const skippedByReason = new Map();
  const summary = { bundlesInstalled: 0, bundleToggles: 0, pluginToggles: 0, configsWritten: 0, skipped: 0, failures: 0 };
  let restartNeeded = false;
  const record = (step) => {
    steps.push(step);
    if (step.failed === true) summary.failures += 1;
    else if (step.skipped !== undefined) {
      summary.skipped += 1;
      skippedSteps.push(step);
      skippedByReason.set(step.skipped, (skippedByReason.get(step.skipped) ?? 0) + 1);
    } else {
      changed.push(step);
      if (step.step === 'install-bundle') summary.bundlesInstalled += 1;
      else if (step.step === 'set-bundle') summary.bundleToggles += 1;
      else if (step.step === 'set-plugin') summary.pluginToggles += 1;
      else if (step.step === 'set-config') summary.configsWritten += 1;
    }
    if (step.restartReason !== undefined) restartNeeded = true;
  };

  // 1. Install profile-owned bundles this device is missing.
  const localBundles = new Map((await ctx.pluginManager.listBundles()).map((bundle) => [bundle.name, bundle]));
  for (const bundle of manifest.bundles ?? []) {
    if (bundle.installed !== true || bundle.availability !== 'profile') continue;
    const local = localBundles.get(bundle.name);
    if (local !== undefined && (local.installed === true || local.availability === 'installation')) continue;
    if (typeof bundle.source !== 'string' || bundle.source === '') {
      record({ step: 'install-bundle', target: bundle.name, skipped: 'no installable source recorded in the manifest' });
      continue;
    }
    if (isLocalPathSpec(bundle.source) && !existsSync(bundle.source.replace(/^(?:file|link):/i, ''))) {
      record({ step: 'install-bundle', target: bundle.name, skipped: `local-path source ${bundle.source} does not exist on this device` });
      continue;
    }
    try {
      const result = changeFields(await ctx.pluginManager.installBundle(bundle.source, { enabled: bundle.enabled !== false }));
      if (result.error !== undefined) record({ step: 'install-bundle', target: bundle.name, failed: true, ...result });
      else record({ step: 'install-bundle', target: bundle.name, ...result });
    } catch (error) {
      record({ step: 'install-bundle', target: bundle.name, failed: true, reason: String(error?.message ?? error) });
    }
  }

  // 2. Align bundle selection with the manifest.
  const afterBundles = new Map((await ctx.pluginManager.listBundles()).map((bundle) => [bundle.name, bundle]));
  for (const bundle of manifest.bundles ?? []) {
    const local = afterBundles.get(bundle.name);
    if (local === undefined) {
      record({ step: 'set-bundle', target: bundle.name, skipped: 'bundle not present on this device (see install step)' });
      continue;
    }
    if (local.readOnlyReason !== undefined) {
      record({ step: 'set-bundle', target: bundle.name, skipped: `read-only here (${local.readOnlyReason})` });
      continue;
    }
    if (local.enabled === true || bundle.enabled !== true) continue;
    try {
      record({ step: 'set-bundle', target: bundle.name, ...changeFields(await ctx.pluginManager.setBundleEnabled(bundle.name, true)) });
    } catch (error) {
      record({ step: 'set-bundle', target: bundle.name, failed: true, reason: String(error?.message ?? error) });
    }
  }
  for (const local of afterBundles.values()) {
    if (local.readOnlyReason !== undefined || local.enabled !== true) continue;
    const remote = (manifest.bundles ?? []).find((bundle) => bundle.name === local.name);
    if (remote === undefined && local.availability === 'profile') {
      try {
        record({ step: 'set-bundle', target: local.name, note: 'not in remote manifest; leaving enabled (remove manually if undesired)', ...changeFields(await ctx.pluginManager.setBundleEnabled(local.name, false)) });
      } catch (error) {
        record({ step: 'set-bundle', target: local.name, failed: true, reason: String(error?.message ?? error) });
      }
    }
  }

  // 3. Align plugin row enable states.
  const localPlugins = await ctx.pluginManager.listPlugins();
  for (const plugin of manifest.plugins ?? []) {
    let local = localPlugins.find((row) => row.entryId === plugin.entryId);
    if (local === undefined) {
      const byModule = localPlugins.filter((row) => row.moduleName === plugin.moduleName);
      if (byModule.length === 1) local = byModule[0];
    }
    if (local === undefined) {
      record({ step: 'set-plugin', target: `${plugin.entryId} (${plugin.moduleName})`, skipped: 'plugin row not present on this device (install its bundle first)' });
      continue;
    }
    if (local.readOnlyReason !== undefined) {
      record({ step: 'set-plugin', target: local.entryId, skipped: `read-only here (${local.readOnlyReason})` });
      continue;
    }
    if (local.enabled === (plugin.enabled === true)) continue;
    try {
      record({ step: 'set-plugin', target: local.entryId, ...changeFields(await ctx.pluginManager.setPluginEnabled(local.entryId, plugin.enabled === true)) });
    } catch (error) {
      record({ step: 'set-plugin', target: local.entryId, failed: true, reason: String(error?.message ?? error) });
    }
  }

  // 4. Write plugin configurations; secret-shaped paths keep local values.
  const configuration = ctx.configEditor.configuration();
  for (const config of manifest.configs ?? []) {
    const item = configuration.find((candidate) => candidate.entry.options.id === config.id);
    if (item === undefined) {
      record({ step: 'set-config', target: config.id, skipped: 'configuration entry not present on this device' });
      continue;
    }
    const effectiveLocal = deepMerge(item.inherited, item.override);
    let next = structuredClone(config.config ?? {});
    // A secret-shaped path keeps this device's own value; when this device has
    // none in the profile layer, the path stays absent and the bundle's own
    // default still applies.
    for (const path of config.redacted ?? []) {
      const localValue = getPath(item.override, path);
      if (localValue !== undefined) setPath(next, path, localValue);
    }
    if (stable(next) === stable(item.override ?? {})) {
      record({ step: 'set-config', target: config.id, skipped: 'already matches the remote manifest' });
      continue;
    }
    try {
      await ctx.configEditor.edit(item.entry, () => next);
      record({ step: 'set-config', target: config.id });
    } catch (error) {
      record({ step: 'set-config', target: config.id, failed: true, reason: String(error?.message ?? error) });
    }
  }

  return {
    applied: summary.failures === 0,
    summary,
    steps: changed.length > 40 ? [...changed.slice(0, 40), { note: `…and ${changed.length - 40} more changes` }] : changed,
    skipped: {
      byReason: [...skippedByReason.entries()].map(([reason, count]) => ({ reason, count })),
      sample: skippedSteps.slice(0, 8).map(({ step, target, skipped: reason }) => ({ step, target, reason })),
    },
    ...(restartNeeded ? { restartAdvisory: 'at least one change reports restart-required; restart DSH to complete it' } : {}),
  };
}

/* ------------------------------ sync actions ------------------------------ */

async function doSnapshot(ctx, settings, { push, overrideUrl, signal }) {
  const parsed = parseGithubRemote(overrideUrl ?? settings.repoUrl);
  if (parsed === undefined) {
    throw new Error('dsh-sync: no repository assigned yet — call dsh_sync action=configure repoUrl=<github repository>, or pass repoUrl for this call only');
  }
  const checkout = await ensureCheckout(ctx, settings, parsed, { fetch: true, signal });

  if (push && !checkout.hasRemoteBranch) {
    // Distinguish an empty/branchless repository (safe to push a new branch)
    // from an unreachable or unauthorized one.
    const probe = await runGit(settings, ['ls-remote', 'origin', 'HEAD'], { cwd: checkout.dir, env: checkout.env, timeoutMs: 20000, signal });
    if (probe.code !== 0) {
      throw new GitError(`dsh-sync: cannot reach the remote repository${checkout.credentialHint === undefined ? ' (check access for private repositories)' : `: ${checkout.credentialHint}`}`, tail(probe.stderr, 4));
    }
  }

  const manifest = await gatherState(ctx, settings);
  await writeManifest(checkout.dir, manifest);
  const cwd = { cwd: checkout.dir, env: checkout.env, signal };
  mustGit(await runGit(settings, ['add', '-A'], cwd), 'stage manifest');
  const status = await runGit(settings, ['status', '--porcelain'], cwd);
  mustGit(status, 'read status');
  const result = { repository: parsed, branch: settings.branch, device: manifest.device };

  if (status.stdout.trim() === '') {
    return { ...result, committed: false, pushed: false, note: 'local state already matches the committed snapshot; nothing to commit' };
  }

  mustGit(await runGit(settings, [
    '-c', `user.name=${settings.commitName}`,
    '-c', `user.email=${settings.commitEmail}`,
    '-c', 'commit.gpgsign=false',
    'commit', '-m', `dsh-sync: snapshot from ${manifest.device} at ${manifest.createdAt}`,
  ], cwd), 'commit snapshot');
  result.committed = true;

  if (!push) return { ...result, pushed: false, note: 'committed locally only; call push to publish to GitHub' };

  const upstream = await runGit(settings, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: checkout.dir, env: checkout.env, signal });
  const upstreamArgs = upstream.code === 0 ? [] : ['--set-upstream'];
  let pushResult = await runGit(settings, ['push', ...upstreamArgs, 'origin', settings.branch], cwd);
  if (pushResult.code !== 0 && /non-fast-forward|fetch first|rejected/i.test(pushResult.stderr)) {
    mustGit(await runGit(settings, ['pull', '--rebase', 'origin', settings.branch], cwd), 'rebase onto remote');
    pushResult = await runGit(settings, ['push', ...upstreamArgs, 'origin', settings.branch], cwd);
  }
  if (pushResult.code !== 0) {
    throw new GitError('dsh-sync: push failed; the remote may hold newer commits that could not be rebased automatically', tail(pushResult.stderr, 6));
  }
  return { ...result, pushed: true, summary: { bundles: manifest.bundles.length, plugins: manifest.plugins.length, configs: manifest.configs.length } };
}

async function doPull(ctx, settings, { overrideUrl, signal }) {
  const parsed = parseGithubRemote(overrideUrl ?? settings.repoUrl);
  if (parsed === undefined) {
    throw new Error('dsh-sync: no repository assigned yet — call dsh_sync action=configure repoUrl=<github repository>, or pass repoUrl for this call only');
  }
  const checkout = await ensureCheckout(ctx, settings, parsed, { fetch: true, signal });
  if (!checkout.hasRemoteBranch) {
    if (checkout.fetchError !== undefined) {
      throw new GitError(`dsh-sync: cannot fetch the remote repository${checkout.credentialHint === undefined ? ' (check network and access for private repositories)' : `: ${checkout.credentialHint}`}`, checkout.fetchError);
    }
    throw new Error(`dsh-sync: the remote repository has no branch "${settings.branch}" yet — push first from the device that holds your settings`);
  }
  const manifest = await readManifest(checkout.dir);
  if (manifest === undefined) {
    throw new Error(`dsh-sync: branch "${settings.branch}" carries no ${MANIFEST_FILE}; was it pushed by dsh-sync?`);
  }
  const applied = await applyManifest(ctx, manifest);
  return {
    repository: parsed,
    branch: settings.branch,
    manifest: { createdAt: manifest.createdAt, device: manifest.device, profile: manifest.profile },
    ...applied,
  };
}

function diffManifests(current, committed) {
  const diff = {
    equal: true,
    bundles: { added: [], removed: [], changed: [] },
    plugins: { added: [], removed: [], changed: [] },
    configs: { added: [], removed: [], changed: [] },
  };
  const bundle = (list) => new Map((list ?? []).map((item) => [item.name, item]));
  for (const [label, list, keyOf] of [['bundles', current.bundles, (item) => item.name], ['plugins', current.plugins, (item) => item.entryId], ['configs', current.configs, (item) => item.id]]) {
    const before = new Map((committed[label] ?? []).map((item) => [keyOf(item), item]));
    const after = new Map((list ?? []).map((item) => [keyOf(item), item]));
    for (const [key, item] of after) {
      if (!before.has(key)) diff[label].added.push(key);
      else if (stable(item) !== stable(before.get(key))) {
        const fields = [];
        for (const field of Object.keys(item)) {
          if (stable(item[field]) !== stable(before.get(key)[field])) fields.push(field);
        }
        diff[label].changed.push(`${key} (${fields.join(', ')})`);
      }
    }
    for (const key of before.keys()) if (!after.has(key)) diff[label].removed.push(key);
  }
  // The snapshot's own timestamp differs by construction, so equality is about content.
  diff.equal = ['bundles', 'plugins', 'configs'].every((label) => diff[label].added.length === 0 && diff[label].removed.length === 0 && diff[label].changed.length === 0);
  return diff;
}

async function doStatus(ctx, settings, { probeRemote, overrideUrl, signal }) {
  let parsed;
  let configError;
  try {
    parsed = parseGithubRemote(overrideUrl ?? settings.repoUrl);
  } catch (error) {
    configError = String(error?.message ?? error);
  }
  const credentials = await resolveCredentials(settings, { signal });
  const out = {
    configured: parsed !== undefined,
    ...(parsed !== undefined ? { repository: parsed } : {}),
    branch: settings.branch,
    authentication: authenticationBlock(settings, credentials, parsed),
    ...(configError !== undefined ? { configError } : {}),
  };
  if (parsed === undefined) {
    out.hint = 'assign a repository first: dsh_sync action=configure repoUrl=https://github.com/<owner>/<repo>';
    return out;
  }

  const dir = checkoutDirectory(ctx);
  if (!existsSync(join(dir, '.git'))) {
    out.checkout = { path: dir, initialized: false, note: 'the first snapshot, push, or pull creates it' };
  } else {
    const env = authEnvironment(settings, parsed, credentials);
    const cwd = { cwd: dir, env, signal };
    const branch = await runGit(settings, ['symbolic-ref', '--short', 'HEAD'], cwd);
    const dirty = await runGit(settings, ['status', '--porcelain'], cwd);
    const head = await runGit(settings, ['rev-parse', 'HEAD'], cwd);
    const log = head.code === 0 ? await runGit(settings, ['log', '-1', '--format=%cI %s'], cwd) : undefined;
    const upstream = await runGit(settings, ['rev-list', '--left-right', '--count', '@{u}...HEAD'], cwd);
    out.checkout = {
      path: dir,
      initialized: true,
      ...(branch.code === 0 ? { branch: branch.stdout.trim() } : {}),
      ...(head.code === 0 ? { head: head.stdout.trim().slice(0, 12) } : {}),
      clean: dirty.code === 0 && dirty.stdout.trim() === '',
      ...(log !== undefined && log.code === 0 ? { lastCommit: log.stdout.trim() } : {}),
      ...(upstream.code === 0
        ? (() => {
          const [behind, ahead] = upstream.stdout.trim().split(/\s+/).map(Number);
          return { behindUpstream: behind, aheadUpstream: ahead };
        })()
        : { upstream: 'not set (push with this checkout once)' }),
    };

    const committed = await readManifest(dir).catch(() => undefined);
    if (committed !== undefined) {
      const current = await gatherState(ctx, settings);
      const diff = diffManifests(current, committed);
      out.drift = {
        equalsCommittedSnapshot: diff.equal,
        counts: {
          bundlesChanged: diff.bundles.added.length + diff.bundles.removed.length + diff.bundles.changed.length,
          pluginsChanged: diff.plugins.added.length + diff.plugins.removed.length + diff.plugins.changed.length,
          configsChanged: diff.configs.added.length + diff.configs.removed.length + diff.configs.changed.length,
        },
      };
    } else {
      out.checkout.manifest = `no ${MANIFEST_FILE} committed yet`;
    }
  }

  if (probeRemote === true) {
    const env = authEnvironment(settings, parsed, credentials);
    // Probe the remote URL itself rather than the `origin` remote: the local
    // checkout does not exist before the first sync, and the question the
    // probe answers is whether this device can reach the repository at all.
    const probe = await runGit(settings, ['ls-remote', '--heads', parsed, settings.branch], { env, timeoutMs: PROBE_TIMEOUT_MS, signal });
    if (probe.code === 'missing-git') {
      out.remote = { reachable: false, reason: 'missing-git', error: tail(probe.stderr, 3) };
    } else if (probe.code === 0) {
      out.remote = { reachable: true, hasBranch: probe.stdout.trim() !== '' };
    } else {
      const classified = classifyRemoteFailure(probe.stderr);
      // A credential that is known to be unusable explains a refusal better
      // than git's generic message does.
      const reason = classified === 'denied' && credentials.reason !== undefined ? credentials.reason : classified;
      out.remote = {
        reachable: false,
        reason,
        error: tail(probe.stderr, 3),
        ...(credentials.error === undefined ? {} : { authError: credentials.error }),
      };
    }
    // The reachability probe says nothing about writing; the API does.
    const access = await checkWriteAccess(parsed, credentials, { signal });
    if (access !== undefined) out.remote.access = access;
  }
  return out;
}

async function doDiff(ctx, settings, { overrideUrl, signal }) {
  const dir = checkoutDirectory(ctx);
  const committed = existsSync(join(dir, '.git')) ? await readManifest(dir).catch(() => undefined) : undefined;
  if (committed === undefined) {
    return { compared: false, reason: `no committed ${MANIFEST_FILE} yet — run snapshot or pull first` };
  }
  const current = await gatherState(ctx, settings);
  const diff = diffManifests(current, committed);
  return {
    compared: true,
    committedAt: committed.createdAt,
    committedBy: committed.device,
    equal: diff.equal,
    bundles: {
      added: truncateList(diff.bundles.added),
      removed: truncateList(diff.bundles.removed),
      changed: truncateList(diff.bundles.changed),
    },
    plugins: {
      added: truncateList(diff.plugins.added),
      removed: truncateList(diff.plugins.removed),
      changed: truncateList(diff.plugins.changed),
    },
    configs: {
      added: truncateList(diff.configs.added),
      removed: truncateList(diff.configs.removed),
      changed: truncateList(diff.configs.changed),
    },
    note: 'this compares live state against the locally committed snapshot only; it does not contact GitHub',
    ...(signal?.aborted ? {} : {}),
  };
}

async function doConfigure(ctx, args) {
  const patch = {};
  if (args.repoUrl !== undefined) {
    parseGithubRemote(args.repoUrl); // throws on anything that is not a GitHub repository
    patch.repoUrl = String(args.repoUrl).trim();
  }
  if (args.branch !== undefined) {
    const branch = String(args.branch).trim();
    if (!validBranch(branch)) throw new Error(`dsh-sync: branch "${branch}" is not a valid git branch name`);
    patch.branch = branch;
  }
  if (args.authMode !== undefined) {
    const mode = String(args.authMode).trim().toLowerCase();
    if (mode !== 'gh' && mode !== 'pat') {
      throw new Error(`dsh-sync: authMode must be "gh" (the GitHub CLI) or "pat" (a personal access token), not: ${args.authMode}`);
    }
    patch.authMode = mode;
  }
  if (args.githubTokenEnv !== undefined) {
    const name = String(args.githubTokenEnv).trim();
    if (name !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`dsh-sync: githubTokenEnv must be an environment variable name such as DSH_SYNC_GITHUB_TOKEN, not: ${name}`);
    }
    patch.githubTokenEnv = name;
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('dsh-sync: configure needs at least one of repoUrl, branch, authMode, githubTokenEnv');
  }
  const entry = ctx.configEditor.entries().find((candidate) => candidate.options.id === SYNC_ENTRY_ID);
  if (entry === undefined) {
    throw new Error('dsh-sync: its own configuration entry is not addressable in this profile; set repoUrl in the profile patch instead');
  }
  await ctx.configEditor.edit(entry, (current) => ({ ...current, ...patch }));
  return { saved: patch, note: 'live profiles apply the change immediately; otherwise restart DSH' };
}

/* ------------------------------ web surface ------------------------------- */

/** Routes the browser half of this package calls. */
const WEB_STATUS_ROUTE = '/dsh-sync/api/status';
const WEB_ACTION_ROUTE = '/dsh-sync/api/action';
const WEB_BODY_LIMIT = 64 * 1024;

/** Write one JSON payload with no-store caching. */
function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

/** Whether a Host header names a loopback authority. */
function loopbackAuthority(host) {
  if (typeof host !== 'string') return false;
  const lower = host.toLowerCase();
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/**
 * Whether a Host header names one of the deployment's declared authorities.
 * A port-less declaration matches the hostname on any port; one with a port
 * matches that exact authority.
 */
function trustedAuthority(host, trustedHosts) {
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  return trustedHosts.some((entry) => {
    let entryUrl;
    try {
      entryUrl = new URL(`http://${entry}`);
    } catch {
      return false;
    }
    return entryUrl.port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
  });
}

/**
 * Whether one request may drive this package's web routes.
 *
 * The routes are exact registrations on the bare web server, so they are not
 * covered by the host's own /api fence and decide for themselves:
 *
 * - a cross-site request is refused (the browser states this itself);
 * - a Host header that names neither loopback nor a declared authority is
 *   refused — Host is the one header a rebinding page cannot forge;
 * - an Origin that is present and different from Host is refused, and so is
 *   an unparseable one. An absent Origin means the caller is not a page (or a
 *   stripping proxy forwarded it), which is not a statement about intent.
 */
function isTrustedWebRequest(request, trustedHosts) {
  const headers = request.headers ?? {};
  if (headers['sec-fetch-site'] === 'cross-site') return false;
  const host = typeof headers.host === 'string' ? headers.host : undefined;
  const loopback = host !== undefined && loopbackAuthority(host);
  if (host !== undefined && !loopback && !trustedAuthority(host, trustedHosts)) return false;
  const origin = headers.origin;
  if (origin === undefined) return true;
  // The desktop shell's own page has a null origin; it reaches the host over
  // loopback, and a cross-site page is already refused above.
  if (origin === 'null') return loopback;
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Read one JSON request body, refusing anything over the limit. */
async function readJsonBody(request, maxBytes = WEB_BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  return JSON.parse(raw);
}

/**
 * The effective settings right now.
 *
 * The plugin's own configuration row is the single place the repository is
 * assigned, so a change written there is visible to the next call even when
 * the profile has not been re-applied yet.
 */
function currentSettings(ctx, base) {
  try {
    for (const item of ctx.configEditor.configuration()) {
      if (item.entry.options.id !== SYNC_ENTRY_ID) continue;
      return resolveSettings(deepMerge(item.inherited ?? {}, item.override ?? {}));
    }
  } catch {
    // Fall back to the configuration the plugin was applied with.
  }
  return base;
}

/**
 * One web action, mapped onto the same operations the tool performs.
 *
 * The browser calls this after a human pressed a button, so no sandbox
 * escalation is asked for here: the request already carries that human's
 * decision. The operations themselves are the shared ones — no second
 * implementation of a sync step lives in the web layer.
 */
async function runWebAction(ctx, settings, action, body) {
  const overrideUrl = body.repoUrl === undefined ? undefined : String(body.repoUrl);
  switch (action) {
    case 'status':
      return doStatus(ctx, settings, { probeRemote: body.probeRemote === true, overrideUrl });
    case 'diff':
      return doDiff(ctx, settings, { overrideUrl });
    case 'snapshot':
      return doSnapshot(ctx, settings, { push: false, overrideUrl });
    case 'push':
      return doSnapshot(ctx, settings, { push: true, overrideUrl });
    case 'pull':
      return doPull(ctx, settings, { overrideUrl });
    case 'configure':
      return doConfigure(ctx, {
        ...(body.repoUrl === undefined ? {} : { repoUrl: body.repoUrl }),
        ...(body.branch === undefined ? {} : { branch: body.branch }),
        ...(body.authMode === undefined ? {} : { authMode: body.authMode }),
        ...(body.githubTokenEnv === undefined ? {} : { githubTokenEnv: body.githubTokenEnv }),
      });
    default:
      throw new Error(`dsh-sync: unknown action ${String(action)}`);
  }
}

/* ------------------------------ plugin entry ------------------------------ */

/**
 * Ask before a mutating action when the session runs below
 * danger-full-access, mirroring how plugin_manager gates profile changes.
 */
async function requireFullAccess(ctx, exec, subject, justification) {
  const policy = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session });
  if (policy.mode === 'danger-full-access') return;
  if (policy.mode !== 'read-only' && policy.mode !== 'workspace-write') {
    throw new Error(`dsh-sync: ${subject} is not available under sandbox mode "${String(policy.mode)}"`);
  }
  const approver = ctx.get('approval');
  if (approver === undefined) throw new Error(`dsh-sync: ${subject} requires danger-full-access approval, but no approval service is composed`);
  if (exec.agent === undefined) throw new Error(`dsh-sync: ${subject} requires danger-full-access approval, but the call has no agent to route approval through`);
  const outcome = await approver.request({
    agent: exec.agent,
    toolName: 'dsh_sync',
    callId: exec.callId,
    reason: `escalate sandbox to danger-full-access: ${justification}`,
    displayReason: {
      en: `Allow dsh-sync ${subject} with full access: ${justification}`,
      zh: `允许 dsh-sync 执行「${subject}」并使用完全访问权限：${justification}`,
    },
    ...(exec.signal ? { signal: exec.signal } : {}),
  });
  if (outcome !== 'allowed-once') {
    throw new Error(`dsh-sync: the user did not allow escalating ${subject} to danger-full-access; nothing was changed`);
  }
}

function resolveSettings(config) {
  const secretWords = new Set(String(config.redactKeySegments ?? '').split(',').map((word) => word.trim().toLowerCase()).filter((word) => word !== ''));
  const benignWords = new Set(String(config.redactBenignQualifiers ?? '').split(',').map((word) => word.trim().toLowerCase()).filter((word) => word !== ''));
  return {
    repoUrl: String(config.repoUrl ?? '').trim(),
    branch: validBranch(String(config.branch ?? '')) ? String(config.branch) : 'main',
    authMode: config.authMode === 'pat' ? 'pat' : 'gh',
    githubTokenEnv: String(config.githubTokenEnv ?? '').trim(),
    commitName: String(config.commitName ?? '').trim() || 'DSH Sync',
    commitEmail: String(config.commitEmail ?? '').trim() || 'dsh-sync@users.noreply.github.com',
    timeoutMs: Number.isFinite(config.timeoutMs) ? config.timeoutMs : 120000,
    isSecretKey: secretKeyPredicate(
      secretWords.size > 0 ? secretWords : new Set(DEFAULT_SECRET_SEGMENTS),
      benignWords.size > 0 ? benignWords : new Set(DEFAULT_BENIGN_QUALIFIERS),
    ),
  };
}

export function apply(ctx, config) {
  const base = resolveSettings(config);

  const dispose = ctx.tools.register({
    name: 'dsh_sync',
    description: 'Sync DeepSeek Harness plugins and settings across devices through a GitHub repository assigned in the plugin settings. status and diff are read-only local checks. configure assigns the repository (GitHub URL, branch, authentication mode, optional token environment variable) and persists it in this profile. Authentication defaults to the GitHub CLI (gh): the credential of the account gh is logged in as is used for HTTPS remotes; authMode=pat switches to a personal access token held in the environment variable named by githubTokenEnv. snapshot regenerates the sync manifest from this device and commits it to the local git checkout; push publishes that commit to GitHub; pull applies the remote manifest here — installing missing bundles, aligning enable states, and writing plugin configs through the same services as the settings UI, so some changes need a DSH restart. Config values whose key looks like a secret (token, password, …) are never exported. snapshot/push/pull/configure change the profile or files under ~/.dsh-sync and require danger-full-access or user approval.',
    parameters: {
      action: {
        type: 'string', required: true,
        enum: ['status', 'configure', 'snapshot', 'push', 'pull', 'diff'],
        description: 'Sync operation: status (local state and drift), configure (assign repository/branch/token variable), snapshot (commit state locally), push (commit and push to GitHub), pull (apply remote state here), diff (live state vs committed snapshot).',
      },
      repoUrl: {
        type: 'string',
        description: 'GitHub repository (https://github.com/<owner>/<repo> and other GitHub forms). configure persists it; snapshot/push/pull/status accept it as a one-call override.',
      },
      branch: { type: 'string', description: 'configure only: branch to sync; defaults to main.' },
      authMode: {
        type: 'string', enum: ['gh', 'pat'],
        description: 'configure only: how the GitHub repository is authenticated — "gh" (the default) uses the credential of the account the GitHub CLI is logged in as; "pat" uses the personal access token found in the environment variable named by githubTokenEnv. An SSH remote is authenticated by your SSH key in either mode.',
      },
      githubTokenEnv: {
        type: 'string',
        description: 'configure only: name of an environment variable holding a GitHub personal access token for private repositories over HTTPS, used when authMode is "pat"; git credential helpers or SSH remotes are used when unset.',
      },
      probeRemote: { type: 'boolean', description: 'status only: also contact GitHub to check the repository is reachable and has the branch.' },
    },
    timeoutMs: 600000,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Sync DSH settings',
      kind: READ_ACTIONS.has(args.action) ? 'read' : 'other',
      rawInput: args,
    }),
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const signal = exec.signal;
      // The repository assignment lives in this plugin's own configuration
      // row, so every call reads the effective settings as they are now.
      const settings = currentSettings(ctx, base);
      switch (args.action) {
        case 'status':
          return JSON.stringify(await doStatus(ctx, settings, { probeRemote: args.probeRemote === true, overrideUrl: args.repoUrl, signal }), null, 2);
        case 'diff':
          return JSON.stringify(await doDiff(ctx, settings, { overrideUrl: args.repoUrl, signal }), null, 2);
        case 'configure':
          await requireFullAccess(ctx, exec, 'configure', 'assign the GitHub repository used to sync this profile');
          exec.signal.throwIfAborted();
          return JSON.stringify(await doConfigure(ctx, args), null, 2);
        case 'snapshot':
          await requireFullAccess(ctx, exec, 'snapshot', 'write the sync manifest into the local git checkout');
          exec.signal.throwIfAborted();
          return JSON.stringify(await doSnapshot(ctx, settings, { push: false, overrideUrl: args.repoUrl, signal }), null, 2);
        case 'push':
          await requireFullAccess(ctx, exec, 'push', 'publish this profile\'s plugins and settings to the GitHub sync repository');
          exec.signal.throwIfAborted();
          return JSON.stringify(await doSnapshot(ctx, settings, { push: true, overrideUrl: args.repoUrl, signal }), null, 2);
        case 'pull':
          await requireFullAccess(ctx, exec, 'pull', 'apply the remote sync manifest to this profile');
          exec.signal.throwIfAborted();
          return JSON.stringify(await doPull(ctx, settings, { overrideUrl: args.repoUrl, signal }), null, 2);
        default:
          throw new Error(`dsh-sync: unknown action ${String(args.action)}`);
      }
    },
  });

  // The browser half of this package reaches the host through these routes.
  // They live in their own injection, so a host without a web server (a
  // headless profile) still runs the tool.
  ctx.inject(['webServer'], (hostCtx) => {
    const host = hostCtx;
    host.effect(() => {
      const trustedHosts = () => {
        const connection = ctx.get('connection');
        return Array.isArray(connection?.trustedHosts)
          ? connection.trustedHosts.filter((entry) => typeof entry === 'string')
          : [];
      };
      const register = (path, method, handler) => host.webServer.register({
        kind: 'exact',
        path,
        handler: (request, response) => {
          if (request.method !== method) {
            response.writeHead(405, { allow: method });
            response.end();
            return;
          }
          if (!isTrustedWebRequest(request, trustedHosts())) {
            sendJson(response, 403, { ok: false, error: 'this request did not come from a trusted local page' });
            return;
          }
          Promise.resolve()
            .then(() => handler(request, response))
            .catch((error) => {
              sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
            });
        },
      });
      const disposers = [
        register(WEB_STATUS_ROUTE, 'GET', async (request, response) => {
          const probe = new URL(request.url ?? '/', 'http://localhost').searchParams.get('probe') === '1';
          const result = await runWebAction(ctx, currentSettings(ctx, base), 'status', { probeRemote: probe });
          sendJson(response, 200, { ok: true, result });
        }),
        register(WEB_ACTION_ROUTE, 'POST', async (request, response) => {
          const body = await readJsonBody(request);
          const action = String(body.action ?? '');
          const result = await runWebAction(ctx, currentSettings(ctx, base), action, body);
          sendJson(response, 200, { ok: true, action, result });
        }),
      ];
      return () => {
        for (const disposeRoute of disposers.splice(0)) {
          try {
            disposeRoute();
          } catch {
            // the web server may already have torn the route down
          }
        }
      };
    }, 'dsh-sync: web routes');
  });

  return () => {
    try {
      dispose();
    } catch {
      // the tools layer may already have torn the registration down
    }
  };
}

/**
 * DSH Sync — sync DeepSeek Harness plugins and settings across devices
 * through a GitHub Gist (the default) or a GitHub repository the user owns.
 *
 * Both targets carry the same manifest, dsh-sync.json, regenerated from live
 * Harness state on every snapshot:
 *
 * - gist: the manifest travels through the GitHub API into a secret gist.
 *   The copy under ~/.dsh-sync/<profile>/gist is this device's own record.
 *   The first push creates the gist and remembers its id in the plugin's own
 *   configuration, so the id reaches the other devices inside the manifest
 *   itself.
 * - repo: a git checkout under ~/.dsh-sync/<profile>/repo is the local
 *   cache; snapshot commits the manifest, push publishes the branch, pull
 *   resets the checkout to the remote branch.
 *
 * Pull applies the manifest through the same services the Web UI uses —
 * pluginManager for bundles and plugin rows, configEditor for plugin
 * configurations. Secret-shaped config values are never written to the
 * manifest.
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
/** The GitHub REST API the gist calls go to. */
const GIST_API = 'https://api.github.com';
/** Timeout for the reachability probe the page and the tool's status use. */
const PROBE_TIMEOUT_MS = 15000;
/** Timeout for one GitHub CLI call. */
const GH_TIMEOUT_MS = 15000;

/** Plugin configuration; users edit these values in the profile patch. */
export const Config = z.object({
  target: z.union([z.const('gist'), z.const('repo')]).default('gist').description('Where the sync snapshot lives: a GitHub Gist (the default) or a GitHub repository. A gist needs no repository and no branch — the snapshot travels through the GitHub API into a secret gist only you can see. A repository keeps the git flow of earlier versions.'),
  repoUrl: z.string().default('').description('GitHub repository that holds the sync snapshot, used when target is "repo", e.g. https://github.com/<owner>/<repo>. Empty until dsh_sync configure assigns one.'),
  branch: z.string().default('main').description('Branch to sync on the remote repository; used when target is "repo".'),
  gistId: z.string().default('').description('The GitHub Gist that holds the sync snapshot, used when target is "gist". A bare gist id, a https://gist.github.com/<user>/<id> URL, or a https://api.github.com/gists/<id> URL are all accepted. Empty until dsh_sync configure assigns one; the first push creates a secret gist and remembers its id when this is empty.'),
  gistDescription: z.string().default('DSH Sync').description('Description of the GitHub Gist the plugin creates when target is "gist".'),
  authMode: z.union([z.const('gh'), z.const('pat')]).default('gh').description('How GitHub is authenticated; both targets use the same credential. "gh" (the default) uses the credential of the account the GitHub CLI is logged in as; "pat" uses the personal access token found in the environment variable named by githubTokenEnv. An SSH remote is authenticated by your SSH key in either mode.'),
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
  // The name of the environment variable is not a secret, and the page needs
  // it in every mode: a form that does not know it would save an empty name
  // over the configured one.
  if (settings.githubTokenEnv !== '') block.tokenEnv = settings.githubTokenEnv;
  if (credentials.mode === 'pat') {
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

/** The profile's own directory name under ~/.dsh-sync, safe for every file system. */
function profileSlug(ctx) {
  const profile = String(ctx.profileContext?.name ?? 'default');
  return profile.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

function checkoutDirectory(ctx) {
  return join(homedir(), '.dsh-sync', profileSlug(ctx), 'repo');
}

/** Where the gist flow keeps its local copy of the snapshot. */
function gistCacheDirectory(ctx) {
  return join(homedir(), '.dsh-sync', profileSlug(ctx), 'gist');
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

/* ------------------------------- gist engine ------------------------------ */

/**
 * The id of a gist, from an id, a gist URL, or an API URL.
 *
 * The user pastes whatever their browser showed them, so all three forms are
 * accepted; the id itself is what the API needs.
 */
function parseGistId(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return undefined;
  const patterns = [
    /^(?:https?:\/\/)?gist\.github\.com\/(?:[^/\s#?]+\/)?([0-9a-f]{6,64})\/?(?:[?#].*)?$/i,
    /^(?:https?:\/\/)?api\.github\.com\/gists\/([0-9a-f]{6,64})\/?(?:[?#].*)?$/i,
    /^([0-9a-f]{6,64})$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match !== null) return match[1].toLowerCase();
  }
  return undefined;
}

/** Why the GitHub API refused a call. */
function githubFailureReason(status) {
  if (status === 401 || status === 403) return 'denied';
  if (status === 404) return 'not-found';
  return 'unknown';
}

/**
 * One call to the GitHub API.
 *
 * The answer is normalized into { ok, status, payload, headers, error, reason }.
 * The caller has to tell "the gist is not there" from "the credential may not
 * see it" — the API answers both with 404, and both mean the same thing to a
 * client, so 404 becomes the `not-found` reason.
 */
async function githubApi(credentials, path, { method = 'GET', body, signal } = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'dsh-sync',
    'x-github-api-version': '2022-11-28',
  };
  if (credentials?.token !== undefined) headers.authorization = `Bearer ${credentials.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetch(`${GIST_API}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      reason: 'unreachable',
      error: `the GitHub API could not be reached: ${String(error?.message ?? error)}`,
    };
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    const message = typeof payload?.message === 'string' ? payload.message : `the GitHub API answered ${response.status}`;
    return { ok: false, status: response.status, reason: githubFailureReason(response.status), error: message };
  }
  return { ok: true, status: response.status, payload, headers: response.headers };
}

/**
 * Read one gist, with the manifest file's content.
 *
 * A file larger than a megabyte arrives truncated, so the raw URL is fetched
 * in that case; the manifest is far smaller, but the answer has to be right
 * either way.
 */
async function readGist(credentials, id, { signal } = {}) {
  const response = await githubApi(credentials, `/gists/${id}`, { signal });
  if (!response.ok) return response;
  const gist = response.payload ?? {};
  const file = gist.files?.[MANIFEST_FILE];
  let content;
  if (file !== undefined) {
    if (file.truncated === true && typeof file.raw_url === 'string') {
      const raw = await fetch(file.raw_url, {
        headers: {
          'user-agent': 'dsh-sync',
          ...(credentials?.token === undefined ? {} : { authorization: `Bearer ${credentials.token}` }),
        },
        ...(signal === undefined ? {} : { signal }),
      });
      content = raw.ok ? await raw.text() : undefined;
    } else {
      content = typeof file.content === 'string' ? file.content : undefined;
    }
  }
  return { ...response, gist, file, content };
}

/**
 * Create or update the gist that holds the manifest.
 *
 * The gist is created secret: a snapshot lists the plugins and the settings
 * of a device, and a secret gist is visible to nobody but its owner — the
 * same privacy a private repository gives.
 */
async function writeGist(credentials, { id, description, content }, { signal } = {}) {
  const files = { [MANIFEST_FILE]: { content } };
  if (id === undefined || id === '') {
    const created = await githubApi(credentials, '/gists', {
      method: 'POST',
      body: { description, public: false, files },
      signal,
    });
    if (!created.ok) return created;
    return { ...created, created: true, gist: created.payload };
  }
  const updated = await githubApi(credentials, `/gists/${id}`, {
    method: 'PATCH',
    body: { description, files },
    signal,
  });
  if (!updated.ok) return updated;
  return { ...updated, created: false, gist: updated.payload };
}

/** The account and the scopes the credential holds, as the API reports them. */
async function githubIdentity(credentials, { signal } = {}) {
  const response = await githubApi(credentials, '/user', { signal });
  if (!response.ok) return response;
  const account = typeof response.payload?.login === 'string' ? response.payload.login : undefined;
  const header = response.headers?.get?.('x-oauth-scopes');
  const scopes = typeof header === 'string'
    ? header.split(',').map((scope) => scope.trim()).filter((scope) => scope !== '')
    : undefined;
  return { ...response, account, scopes };
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

/** The manifest's text form, as it is written to disk and into a gist. */
function manifestText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function writeManifest(dir, manifest) {
  await fsp.writeFile(join(dir, MANIFEST_FILE), manifestText(manifest), 'utf8');
}

/**
 * Read a manifest and check that this device understands it.
 *
 * The version check is the same for a file in a git checkout and for a file
 * in a gist, so both go through here.
 */
async function readManifestFile(path) {
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(await fsp.readFile(path, 'utf8'));
  if (raw?.manifestVersion !== MANIFEST_VERSION) {
    throw new Error(`dsh-sync: unsupported manifest version ${JSON.stringify(raw?.manifestVersion)} in ${MANIFEST_FILE}; this device runs manifest version ${MANIFEST_VERSION}`);
  }
  return raw;
}

function readManifest(dir) {
  return readManifestFile(join(dir, MANIFEST_FILE));
}

/** Parse a manifest from text, or undefined when it is not one this device understands. */
function parseManifest(text) {
  try {
    const raw = JSON.parse(text);
    if (raw?.manifestVersion !== MANIFEST_VERSION) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/**
 * Whether two manifests describe the same state.
 *
 * Every snapshot carries the moment it was taken, so that timestamp always
 * differs; the content behind it is what "the same snapshot" means.
 */
function sameManifest(a, b) {
  if (a === undefined || b === undefined) return false;
  const strip = (manifest) => {
    const copy = { ...manifest };
    delete copy.createdAt;
    return stable(copy);
  };
  return strip(a) === strip(b);
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

/** The target an action runs against: a gist or a repository. */
function resolveTarget(settings, override) {
  const value = String(override ?? settings.target ?? '').trim().toLowerCase();
  return value === 'repo' ? 'repo' : 'gist';
}

async function doRepoSnapshot(ctx, settings, { push, overrideUrl, signal }) {
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
  const result = { target: 'repo', repository: parsed, branch: settings.branch, device: manifest.device };

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

async function doRepoPull(ctx, settings, { overrideUrl, signal }) {
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
    target: 'repo',
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

async function doRepoStatus(ctx, settings, { probeRemote, overrideUrl, signal }) {
  let parsed;
  let configError;
  try {
    parsed = parseGithubRemote(overrideUrl ?? settings.repoUrl);
  } catch (error) {
    configError = String(error?.message ?? error);
  }
  const credentials = await resolveCredentials(settings, { signal });
  const out = {
    target: 'repo',
    configured: parsed !== undefined,
    ...(parsed !== undefined ? { repository: parsed } : {}),
    branch: settings.branch,
    authentication: authenticationBlock(settings, credentials, parsed),
    ...(configError !== undefined ? { configError } : {}),
  };
  if (parsed === undefined) {
    out.hint = 'assign a repository first: dsh_sync action=configure target=repo repoUrl=https://github.com/<owner>/<repo>';
    return out;
  }

  const dir = checkoutDirectory(ctx);
  if (!existsSync(join(dir, '.git'))) {
    out.cache = { path: dir, initialized: false, kind: 'repo', note: 'the first snapshot, push, or pull creates it' };
  } else {
    const env = authEnvironment(settings, parsed, credentials);
    const cwd = { cwd: dir, env, signal };
    const branch = await runGit(settings, ['symbolic-ref', '--short', 'HEAD'], cwd);
    const dirty = await runGit(settings, ['status', '--porcelain'], cwd);
    const head = await runGit(settings, ['rev-parse', 'HEAD'], cwd);
    const log = head.code === 0 ? await runGit(settings, ['log', '-1', '--format=%cI %s'], cwd) : undefined;
    const upstream = await runGit(settings, ['rev-list', '--left-right', '--count', '@{u}...HEAD'], cwd);
    out.cache = {
      path: dir,
      initialized: true,
      kind: 'repo',
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
      out.cache.manifest = `no ${MANIFEST_FILE} committed yet`;
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

/**
 * The state of the gist flow.
 *
 * A gist has no branch and no checkout, so the local copy of the snapshot is
 * the only thing this device keeps; the drift compares the live state with
 * that copy, exactly as the repository flow compares it with the commit.
 */
async function doGistStatus(ctx, settings, { probeRemote, overrideGistId, signal }) {
  const credentials = await resolveCredentials(settings, { signal });
  const gistId = parseGistId(overrideGistId ?? settings.gistId) ?? '';
  const dir = gistCacheDirectory(ctx);
  const out = {
    target: 'gist',
    configured: gistId !== '',
    authentication: authenticationBlock(settings, credentials, undefined),
    cache: { path: dir, initialized: existsSync(join(dir, MANIFEST_FILE)), kind: 'gist' },
  };
  if (gistId !== '') out.gist = { id: gistId, url: `https://gist.github.com/${gistId}` };
  else out.hint = 'no gist is assigned yet — the first push creates a secret gist and remembers its id';

  const cached = await readManifestFile(join(dir, MANIFEST_FILE)).catch(() => undefined);
  if (cached !== undefined) {
    const current = await gatherState(ctx, settings);
    const diff = diffManifests(current, cached);
    out.drift = {
      equalsCommittedSnapshot: diff.equal,
      counts: {
        bundlesChanged: diff.bundles.added.length + diff.bundles.removed.length + diff.bundles.changed.length,
        pluginsChanged: diff.plugins.added.length + diff.plugins.removed.length + diff.plugins.changed.length,
        configsChanged: diff.configs.added.length + diff.configs.removed.length + diff.configs.changed.length,
      },
    };
  }

  if (probeRemote === true) {
    const identity = await githubIdentity(credentials, { signal });
    if (!identity.ok) {
      out.remote = {
        reachable: false,
        reason: identity.reason ?? 'denied',
        error: identity.error,
        ...(credentials.error === undefined ? {} : { authError: credentials.error }),
      };
    } else {
      if (identity.account !== undefined && out.authentication.account === undefined) {
        out.authentication.account = identity.account;
      }
      if (identity.scopes !== undefined) {
        out.authentication.scopes = identity.scopes;
        out.authentication.gistScope = identity.scopes.includes('gist');
      }
      if (gistId === '') {
        // No gist yet: the API answered and the credential is accepted, which
        // is what the first push needs.
        out.remote = { reachable: true, access: { canPush: out.authentication.gistScope !== false } };
      } else {
        const read = await readGist(credentials, gistId, { signal });
        if (!read.ok) {
          out.remote = {
            reachable: false,
            reason: read.reason ?? 'unknown',
            error: read.error,
            ...(credentials.error === undefined ? {} : { authError: credentials.error }),
          };
        } else {
          out.remote = { reachable: true, hasFile: read.file !== undefined, access: { canPush: out.authentication.gistScope !== false } };
          if (typeof read.gist?.html_url === 'string') out.gist.url = read.gist.html_url;
          if (typeof read.gist?.description === 'string' && read.gist.description !== '') {
            out.gist.description = read.gist.description;
          }
        }
      }
    }
  }
  return out;
}

/**
 * Take a snapshot and, when asked, publish it.
 *
 * A gist is written through the API, so there is no commit: the local copy
 * under ~/.dsh-sync is the device's own record, and the gist is the shared
 * one.
 */
async function doGistSnapshot(ctx, settings, { push, overrideGistId, signal }) {
  const credentials = await resolveCredentials(settings, { signal });
  if (credentials.token === undefined) {
    throw new Error(`dsh-sync: the gist API needs a GitHub token — ${credentialHint(settings, credentials) ?? 'no credential is configured'}`);
  }
  const manifest = await gatherState(ctx, settings);
  const dir = gistCacheDirectory(ctx);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(join(dir, MANIFEST_FILE), manifestText(manifest), 'utf8');
  const result = { target: 'gist', committed: true, pushed: false, device: manifest.device, cache: dir };
  if (!push) {
    return { ...result, note: 'the snapshot is in the local cache; call push to publish it to the gist' };
  }

  const gistId = parseGistId(overrideGistId ?? settings.gistId) ?? '';
  if (gistId !== '') {
    const read = await readGist(credentials, gistId, { signal });
    if (!read.ok) throw new Error(`dsh-sync: cannot read the gist ${gistId}: ${read.error}`);
    const remote = read.content === undefined ? undefined : parseManifest(read.content);
    if (remote !== undefined && sameManifest(remote, manifest)) {
      return { ...result, gistId, gistUrl: read.gist?.html_url, pushed: false, note: 'the gist already holds this snapshot' };
    }
  }

  const written = await writeGist(credentials, { id: gistId, description: settings.gistDescription, content: manifestText(manifest) }, { signal });
  if (!written.ok) throw new Error(`dsh-sync: cannot write the gist: ${written.error}`);
  const id = written.gist?.id ?? gistId;
  const url = written.gist?.html_url ?? `https://gist.github.com/${id}`;
  let published = manifest;

  if (id !== '' && id !== settings.gistId) {
    // Remembering the gist here hands its id to the other devices through
    // the manifest this push publishes.
    let remembered = false;
    try {
      remembered = await persistSetting(ctx, 'gistId', id);
    } catch (error) {
      result.note = `the gist id ${id} could not be written to the configuration (${String(error?.message ?? error)}) — assign it by hand to keep using it`;
    }
    if (remembered) {
      // The manifest now carries the id, so publish it once more: the other
      // devices learn the gist from the manifest they pull.
      const refreshed = await gatherState(ctx, settings);
      const updated = await writeGist(credentials, { id, description: settings.gistDescription, content: manifestText(refreshed) }, { signal });
      if (updated.ok) {
        published = refreshed;
        await fsp.writeFile(join(dir, MANIFEST_FILE), manifestText(refreshed), 'utf8');
      }
    }
  }
  return {
    ...result,
    gistId: id,
    gistUrl: url,
    pushed: true,
    created: written.created === true,
    summary: { bundles: published.bundles.length, plugins: published.plugins.length, configs: published.configs.length },
  };
}

/** Apply the manifest a gist holds to this device. */
async function doGistPull(ctx, settings, { overrideGistId, signal }) {
  const credentials = await resolveCredentials(settings, { signal });
  const gistId = parseGistId(overrideGistId ?? settings.gistId) ?? '';
  if (gistId === '') {
    throw new Error('dsh-sync: no gist is assigned yet — call dsh_sync action=configure target=gist gistId=<id or URL>, or pass gistId for this call only');
  }
  if (credentials.token === undefined) {
    throw new Error(`dsh-sync: the gist API needs a GitHub token — ${credentialHint(settings, credentials) ?? 'no credential is configured'}`);
  }
  const read = await readGist(credentials, gistId, { signal });
  if (!read.ok) throw new Error(`dsh-sync: cannot read the gist ${gistId}: ${read.error}`);
  if (read.content === undefined) {
    throw new Error(`dsh-sync: the gist ${gistId} carries no ${MANIFEST_FILE}; was it published by dsh-sync?`);
  }
  const manifest = parseManifest(read.content);
  if (manifest === undefined) {
    throw new Error(`dsh-sync: the gist ${gistId} carries no manifest this device understands (manifest version ${MANIFEST_VERSION})`);
  }
  const dir = gistCacheDirectory(ctx);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(join(dir, MANIFEST_FILE), read.content, 'utf8');
  const applied = await applyManifest(ctx, manifest);
  return {
    target: 'gist',
    gistId,
    gistUrl: read.gist?.html_url,
    manifest: { createdAt: manifest.createdAt, device: manifest.device, profile: manifest.profile },
    ...applied,
  };
}

/** The state, for whichever target is in effect. */
async function doStatus(ctx, settings, { probeRemote, overrideUrl, overrideTarget, overrideGistId, signal }) {
  const target = resolveTarget(settings, overrideTarget);
  if (target === 'gist') return doGistStatus(ctx, settings, { probeRemote, overrideGistId, signal });
  return doRepoStatus(ctx, settings, { probeRemote, overrideUrl, signal });
}

/** A snapshot, for whichever target is in effect. */
async function doSnapshot(ctx, settings, { push, overrideUrl, overrideTarget, overrideGistId, signal }) {
  const target = resolveTarget(settings, overrideTarget);
  if (target === 'gist') return doGistSnapshot(ctx, settings, { push, overrideGistId, signal });
  return doRepoSnapshot(ctx, settings, { push, overrideUrl, signal });
}

/** A pull, for whichever target is in effect. */
async function doPull(ctx, settings, { overrideUrl, overrideTarget, overrideGistId, signal }) {
  const target = resolveTarget(settings, overrideTarget);
  if (target === 'gist') return doGistPull(ctx, settings, { overrideGistId, signal });
  return doRepoPull(ctx, settings, { overrideUrl, signal });
}

async function doDiff(ctx, settings, { target, signal }) {
  const dir = target === 'gist' ? gistCacheDirectory(ctx) : checkoutDirectory(ctx);
  const committed = await readManifest(dir).catch(() => undefined);
  if (committed === undefined) {
    return { target: target === 'gist' ? 'gist' : 'repo', compared: false, reason: `no committed ${MANIFEST_FILE} yet — run snapshot or pull first` };
  }
  const current = await gatherState(ctx, settings);
  const diff = diffManifests(current, committed);
  return {
    target: target === 'gist' ? 'gist' : 'repo',
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

/**
 * Write one value into this plugin's own configuration row.
 *
 * The gist id lives there, so a device that creates the gist hands the id to
 * the other devices through the manifest it publishes.
 */
async function persistSetting(ctx, key, value) {
  const entry = ctx.configEditor.entries().find((candidate) => candidate.options.id === SYNC_ENTRY_ID);
  if (entry === undefined) return false;
  await ctx.configEditor.edit(entry, (current) => ({ ...current, [key]: value }));
  return true;
}

async function doConfigure(ctx, args) {
  const patch = {};
  if (args.target !== undefined) {
    const target = String(args.target).trim().toLowerCase();
    if (target !== 'gist' && target !== 'repo') {
      throw new Error(`dsh-sync: target must be "gist" (the default) or "repo", not: ${args.target}`);
    }
    patch.target = target;
  }
  if (args.gistId !== undefined) {
    const raw = String(args.gistId).trim();
    if (raw === '') {
      patch.gistId = '';
    } else {
      const id = parseGistId(raw);
      if (id === undefined) {
        throw new Error(`dsh-sync: gistId must be a gist id, a https://gist.github.com/<user>/<id> URL, or a https://api.github.com/gists/<id> URL — but got: ${raw}`);
      }
      patch.gistId = id;
    }
  }
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
    throw new Error('dsh-sync: configure needs at least one of target, gistId, repoUrl, branch, authMode, githubTokenEnv');
  }
  const entry = ctx.configEditor.entries().find((candidate) => candidate.options.id === SYNC_ENTRY_ID);
  if (entry === undefined) {
    throw new Error('dsh-sync: its own configuration entry is not addressable in this profile; set target and gistId in the profile patch instead');
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
  const overrideTarget = body.target === undefined ? undefined : String(body.target);
  const overrideGistId = body.gistId === undefined ? undefined : String(body.gistId);
  switch (action) {
    case 'status':
      return doStatus(ctx, settings, { probeRemote: body.probeRemote === true, overrideUrl, overrideTarget, overrideGistId });
    case 'diff':
      return doDiff(ctx, settings, { target: resolveTarget(settings, overrideTarget) });
    case 'snapshot':
      return doSnapshot(ctx, settings, { push: false, overrideUrl, overrideTarget, overrideGistId });
    case 'push':
      return doSnapshot(ctx, settings, { push: true, overrideUrl, overrideTarget, overrideGistId });
    case 'pull':
      return doPull(ctx, settings, { overrideUrl, overrideTarget, overrideGistId });
    case 'configure':
      return doConfigure(ctx, {
        ...(body.target === undefined ? {} : { target: body.target }),
        ...(body.gistId === undefined ? {} : { gistId: body.gistId }),
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
    target: config.target === 'repo' ? 'repo' : 'gist',
    repoUrl: String(config.repoUrl ?? '').trim(),
    branch: validBranch(String(config.branch ?? '')) ? String(config.branch) : 'main',
    gistId: parseGistId(config.gistId) ?? '',
    gistDescription: String(config.gistDescription ?? '').trim() || 'DSH Sync',
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
    description: 'Sync DeepSeek Harness plugins and settings across devices through a GitHub Gist (the default) or a GitHub repository you own. status and diff are read-only local checks. configure assigns where the snapshot lives and persists it in this profile. snapshot regenerates the sync manifest from this device; push publishes it to the gist or the repository; pull applies the remote manifest here — installing missing bundles, aligning enable states, and writing plugin configs through the same services as the settings UI, so some changes need a DSH restart. Config values whose key looks like a secret (token, password, …) are never exported. snapshot/push/pull/configure change the profile or files under ~/.dsh-sync and require danger-full-access or user approval.',
    parameters: {
      action: {
        type: 'string', required: true,
        enum: ['status', 'configure', 'snapshot', 'push', 'pull', 'diff'],
        description: 'Sync operation: status (local state and drift), configure (assign the target and where the snapshot lives), snapshot (record the state locally), push (publish it), pull (apply the remote state here), diff (live state vs the stored snapshot).',
      },
      target: {
        type: 'string', enum: ['gist', 'repo'],
        description: 'Where the snapshot lives: "gist" (the default) or "repo". configure persists it; the other actions accept it as a one-call override.',
      },
      gistId: {
        type: 'string',
        description: 'The GitHub Gist that holds the snapshot: a gist id, a https://gist.github.com/<user>/<id> URL, or a https://api.github.com/gists/<id> URL. configure persists it; the other actions accept it as a one-call override. Leave it empty and the first push creates a secret gist and remembers its id.',
      },
      repoUrl: {
        type: 'string',
        description: 'GitHub repository that holds the snapshot, used when the target is "repo" (https://github.com/<owner>/<repo> and other GitHub forms). configure persists it; the other actions accept it as a one-call override.',
      },
      branch: { type: 'string', description: 'configure only: branch to sync on the repository, used when the target is "repo"; defaults to main.' },
      authMode: {
        type: 'string', enum: ['gh', 'pat'],
        description: 'How GitHub is authenticated; both targets use the same credential. "gh" (the default) uses the credential of the account the GitHub CLI is logged in as; "pat" uses the personal access token held in the environment variable named by githubTokenEnv. An SSH remote is authenticated by your SSH key in either mode. configure persists it.',
      },
      githubTokenEnv: {
        type: 'string',
        description: 'configure only: name of an environment variable holding a GitHub personal access token, used when authMode is "pat"; git credential helpers or SSH remotes are used when unset.',
      },
      probeRemote: { type: 'boolean', description: 'status only: also contact GitHub to check whether the gist or the repository is reachable and usable.' },
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
      // The target and the place it points at live in this plugin's own
      // configuration row, so every call reads the effective settings as they
      // are now; a parameter overrides them for that one call.
      const overrides = { overrideUrl: args.repoUrl, overrideTarget: args.target, overrideGistId: args.gistId };
      switch (args.action) {
        case 'status':
          return JSON.stringify(await doStatus(ctx, settings, { probeRemote: args.probeRemote === true, ...overrides, signal }), null, 2);
        case 'diff':
          return JSON.stringify(await doDiff(ctx, settings, { target: resolveTarget(settings, args.target), signal }), null, 2);
        case 'configure':
          await requireFullAccess(ctx, exec, 'configure', 'assign where this profile syncs to');
          exec.signal.throwIfAborted();
          return JSON.stringify(await doConfigure(ctx, args), null, 2);
        case 'snapshot':
          await requireFullAccess(ctx, exec, 'snapshot', 'write the sync manifest into the local cache');
          exec.signal.throwIfAborted();
          return JSON.stringify(await doSnapshot(ctx, settings, { push: false, ...overrides, signal }), null, 2);
        case 'push':
          await requireFullAccess(ctx, exec, 'push', 'publish this profile\'s plugins and settings to GitHub');
          exec.signal.throwIfAborted();
          return JSON.stringify(await doSnapshot(ctx, settings, { push: true, ...overrides, signal }), null, 2);
        case 'pull':
          await requireFullAccess(ctx, exec, 'pull', 'apply the remote sync manifest to this profile');
          exec.signal.throwIfAborted();
          return JSON.stringify(await doPull(ctx, settings, { ...overrides, signal }), null, 2);
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

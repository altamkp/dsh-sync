# @altamkp/dsh-sync

Sync DeepSeek Harness plugins and settings across devices through a GitHub Gist or a GitHub repository you own.

- **Bundles** — which plugin packages are installed (with the install spec that reproduces them) and whether they are selected.
- **Plugin rows** — the enabled/disabled state of each plugin row in the profile.
- **Plugin settings** — each plugin's configuration, as it is stored in the profile patch.

The **default target is a GitHub Gist**: the first `push` creates a secret gist and remembers its
id, so the other devices find the same snapshot without a repository, a branch or a git checkout.
A repository you own stays available as the second target, with the git flow of the earlier
versions.

Published from <https://github.com/altamkp/dsh-sync>. The current release is 0.2.0.

## Install

Add the package to your profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@altamkp/dsh-sync"]
    }
  },
  "dependencies": {
    "@altamkp/dsh-sync": "link:C:/Users/altamkp/dsh-sync"
  }
}
```

The `link:` spec points at a local checkout; install from the GitHub repository instead with:

```json
{
  "dependencies": {
    "@altamkp/dsh-sync": "github:altamkp/dsh-sync"
  }
}
```

The row that enables the plugin is the bundle patch the package ships, `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-sync
      name: '@altamkp/dsh-sync'
      config: {}
```

The row name must match the installed package, so a profile that pins
`@altamkp/dsh-sync` needs the same name here. Restart the Harness, or toggle the bundle off and
on in the plugin manager; the **同步 / Sync** entry then appears in the sidebar.

## The page in the Web GUI

The plugin contributes a **同步 / Sync** entry to the sidebar's global panel row (the group that
holds 插件, 插件市场, 自动化任务, 任务看板) and a page to the center column. The page shows the
assigned target — the gist or the repository — how the plugin authenticates, the local state, and
how far the live state has drifted from the last published snapshot — and it carries the same
actions as the tool: refresh, snapshot, push, pull, and diff.

The page scrolls as a whole: the header, the settings card and the actions card travel together
in one scroll area inside the center column, so a long status list is reached by scrolling the
page rather than by scrolling a box inside it.

The status block is a collapsible section inside the settings card. It expands and collapses
with the mouse, and it is open by default, so the first look at the page already shows the state
of the target, the credential and the drift. Collapsing it only folds the details away: no
state changes, and the actions keep working.

The settings card opens with a **target selector**: choosing **Gist** shows the gist id field,
choosing **Repository** shows the repository and the branch. The target, the gist id or the
repository and branch are edited on the page itself (edit → save); the save writes the plugin's
own configuration row in the profile patch, exactly like the tool's `configure` action. The same
form chooses the authentication method — the GitHub CLI (the default) or a personal access
token — and shows which credential is in use.

The page is a view over the plugin's own host routes (`/dsh-sync/api/status`,
`/dsh-sync/api/action`); the actions call exactly the functions the `dsh_sync` tool calls, so
there is one implementation of every sync step. The routes refuse requests that do not come from
a trusted local page (cross-site requests, a foreign `Origin`, or a `Host` that is neither
loopback nor a declared authority).

### The actions follow the remote

The page reads the local state first and then asks the host whether the target can actually be
reached — for the `repo` target a `git ls-remote` against the remote URL (which works before the
local checkout exists), for the `gist` target the GitHub API itself. Snapshot, push, pull, and
diff stay disabled until that probe succeeds, and the page says why when they are disabled: no
repository assigned yet (the `repo` target only — a `gist` target needs none, because the first
push creates the gist), the remote refused the access (wrong credential or missing rights), the
remote could not be reached, git is not installed on the device (the `repo` target), the GitHub
CLI is missing or not logged in, or no token variable is set. Refresh stays enabled in every
case — it is the button that re-checks the remote. The failure reason is classified from the
error the host got, so "authentication failed" and "could not resolve host" are told apart.

The probe says nothing about writing, so the host also asks the GitHub API which permissions
the credential holds; a credential that may only read leaves the push button disabled with the
reason shown, while snapshot, pull, and diff stay usable.

## Configuration

The plugin's own configuration row in the profile patch holds these keys. Every one of them is
optional; the default is what a fresh install uses.

| Key | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `target` | `gist` | both | Where the snapshot lives: `gist` (a GitHub Gist) or `repo` (a branch of a GitHub repository). |
| `gistId` | *(empty)* | `gist` | The gist that holds the snapshot: a bare id, a `https://gist.github.com/<user>/<id>` URL, or a `https://api.github.com/gists/<id>` URL. Empty until the first push creates a gist. |
| `gistDescription` | `DSH Sync` | `gist` | The description of the gist the plugin creates. |
| `repoUrl` | *(empty)* | `repo` | The GitHub repository that holds the snapshot, e.g. `https://github.com/<owner>/<repo>`. Only read when `target` is `repo`. |
| `branch` | `main` | `repo` | The branch to sync on. Only read when `target` is `repo`. |
| `authMode` | `gh` | both | `gh` uses the credential of the account the GitHub CLI is logged in as; `pat` uses a personal access token. |
| `githubTokenEnv` | `DSH_SYNC_GITHUB_TOKEN` | both | The environment variable that holds the personal access token. |
| `commitName` | `DSH Sync` | `repo` | The git author name of a snapshot commit. |
| `commitEmail` | `dsh-sync@users.noreply.github.com` | `repo` | The git author email of a snapshot commit. |
| `timeoutMs` | `120000` | `repo` | The timeout of a single git command, in milliseconds (at least 5000). |
| `redactKeySegments` | the built-in secret words | both | Comma-separated key words that mark a config key as secret. |
| `redactBenignQualifiers` | the built-in benign words | both | Comma-separated words that cancel the secret match when they stand in front of a secret word. |

`repoUrl` and `branch` belong to the `repo` target; the `gist` target uses `gistId` and
`gistDescription` and ignores them. `commitName`, `commitEmail` and `timeoutMs` belong to the
git flow of the `repo` target. `authMode` and `githubTokenEnv` apply to both targets: they pick
the credential the plugin talks to GitHub with.

## The `dsh_sync` tool

The tool works on the same targets as the page:

| Parameter | Target | Meaning |
| --- | --- | --- |
| `action` | — | `status`, `configure`, `snapshot`, `push`, `pull` or `diff`. |
| `target` | both | `gist` (the default) or `repo` — where the snapshot lives. |
| `gistId` | `gist` | The gist that holds the snapshot: a bare id or a gist URL. |
| `repoUrl` | `repo` | The GitHub repository that holds the snapshot. |
| `branch` | `repo` | The branch to sync on. |
| `authMode` | both | `gh` (the default) or `pat`. |
| `githubTokenEnv` | both | The environment variable that holds the personal access token. |
| `probeRemote` | — | `status` only: also contact GitHub to check that the target is reachable. |

`target` and `gistId` work in two ways: passed for one call only, as an override of what is
stored, or persisted with `action=configure`:

```
dsh_sync action=configure target=gist gistId=https://gist.github.com/<user>/<id>
dsh_sync action=push target=repo repoUrl=https://github.com/<owner>/<repo> branch=main
dsh_sync action=status target=gist gistId=https://gist.github.com/<user>/<id>
```

## How it works

The snapshot is a single `dsh-sync.json`. With the `repo` target it lives in a managed git
checkout under `~/.dsh-sync/<profile>/repo`; with the `gist` target the gist file is the
snapshot, and the plugin keeps a local copy of it under `~/.dsh-sync/<profile>/gist`.

| Action | Effect |
| --- | --- |
| `status` | Local facts: the assigned target, the state of the checkout or the gist, the distance to the published snapshot, and the drift against it. Read-only. |
| `configure` | Assigns the target, the gist id or the repository and branch, the authentication method, and the token variable name in the plugin settings. |
| `snapshot` | Regenerates the snapshot from live Harness state and stores it locally. |
| `push` | Same as `snapshot`, then publishes it to GitHub — into the gist, or onto the branch of the repository. |
| `pull` | Reads the published snapshot — from the gist or from the branch of the repository — and applies it on this device. |
| `diff` | Live state against the last published snapshot, without contacting GitHub. |

`pull` applies changes through the same services the settings UI uses — `pluginManager` for
bundles and plugin rows, `configEditor` for plugin configurations — so a change that the
Loader cannot apply live is reported as `restart-required`.

## Assigning the repository

The `repo` target keeps the snapshot in a branch of a GitHub repository you own. Through the
agent tool:

```
dsh_sync action=configure target=repo repoUrl=https://github.com/<owner>/<repo> branch=main
```

or by editing the plugin's own configuration in the profile patch:

```yaml
- insert:
    - id: dsh-sync
      name: '@altamkp/dsh-sync'
      config:
        target: repo
        repoUrl: https://github.com/<owner>/<repo>
        branch: main
```

`git@github.com:<owner>/<repo>.git` and `github:<owner>/<repo>` are accepted as well. The row
name must match the installed package (`@altamkp/dsh-sync`); the profile patch layer wins over
the bundle layer, so a renamed package needs the same rename here.

## Assigning a gist

The `gist` target keeps the snapshot in a GitHub Gist, and it needs neither a repository nor a
branch nor a checkout: the plugin talks to the GitHub REST API.

The first `push` creates the gist. It is created **secret** — a snapshot lists the plugins and
the settings of a device, and a secret gist is visible to nobody but its owner. The plugin
writes `dsh-sync.json` into the gist, remembers the gist id in its own configuration, and that
id travels inside the synced snapshot, so the other devices find the same gist on their own.

A gist can also be assigned by hand:

```
dsh_sync action=configure target=gist gistId=https://gist.github.com/<user>/<id>
```

`gistId` accepts a bare id, a `https://gist.github.com/<user>/<id>` URL, or a
`https://api.github.com/gists/<id>` URL. The description of the gist the plugin creates comes
from `gistDescription` (`DSH Sync` by default).

The credential needs the **`gist`** scope to create or update a gist. The GitHub CLI's default
login already has it; a personal access token must be created with it.

## Access to GitHub

The target may be public or private: a repository you own, or a secret gist only you can see.
The plugin authenticates in one of two modes, chosen with `authMode` (on the page, or in the
plugin's own configuration); both targets use the same credential.

### `authMode: gh` — the GitHub CLI (the default)

The plugin asks the GitHub CLI for the credential it already holds:

```
gh auth token --hostname github.com
```

That is the token of the account `gh` is logged in as — from the system keyring, from gh's own
configuration, or from `GH_TOKEN`. For the `repo` target the plugin reads it, hands it to git as
an HTTP `Authorization` header scoped to `https://github.com/` (through git's `GIT_CONFIG_*`
environment mechanism, so it never reaches the command line, the repository configuration, or
the manifest), and forgets it; for the `gist` target the same token is sent to the GitHub API.
The account it acts as is shown in the status block.

Nothing has to be copied around: `gh auth login` on a device is enough.

If the CLI is not installed, the page says so and points at <https://cli.github.com>; if it is
installed but not logged in, the page says that too, and names `gh auth login`. The token is
refreshed whenever a sync operation resolves the credential, so an expired login is picked up
without restarting anything.

### `authMode: pat` — a personal access token

The plugin reads the personal access token from the environment variable named by
`githubTokenEnv` (default `DSH_SYNC_GITHUB_TOKEN`):

```
DSH_SYNC_GITHUB_TOKEN=ghp_…   # exported before DSH starts
```

The variable name is the only thing that is stored; the token itself stays in the environment
and is sent the same way as the gh token. A classic token needs the `repo` scope for a private
repository, and the `gist` scope for a gist.

### SSH remotes

With an `git@github.com:<owner>/<repo>.git` remote, your SSH key authenticates the repository and
no token is used — in either mode. The status block says so. A gist is always read through the
HTTPS API, so it always needs a token.

### If neither is available

Git's own credential helper (e.g. Git Credential Manager on Windows) is still consulted by git
itself, and the manifest records no credential either way.

## What travels, and what stays

- **Bundles** — which plugin packages are installed (with the install spec that reproduces them) and
  whether they are selected.
- **Plugin rows** — the enabled/disabled state of each plugin row in the profile.
- **Plugin settings** — the values the *profile layer* holds explicitly. A value a bundle ships as
  its own default is not copied: it arrives with the bundle on every device, and pinning it in the
  profile would freeze it. The profile's own choices travel.
- **The gist id** — it is part of the plugin's own configuration, and that configuration travels
  with the snapshot, so the other devices know which gist to read.

## What is never synced

- Credentials, tokens, and keys: a config key whose **word** names a credential (`key`, `token`,
  `secret`, `password`, `passphrase`, `credential`, `pat`, `bearer`) is omitted from the manifest
  and recorded only as a path — `apiKeyEnv`, `authToken`, and `clientSecret` never leave the
  device. On `pull` those paths keep this device's local value. A benign word in front cancels
  the match, so `maxTokens`, `maxOutputTokens`, and `contextWindow` are ordinary settings and
  **do** sync. Both word lists are configurable (`redactKeySegments`, `redactBenignQualifiers`).
- Sessions, workspace files, and anything outside the profile's plugin configuration.

The manifest does contain your plugin list and plugin settings, so use a **private** repository —
or the secret gist, which is private by default — unless you intend to publish that inventory.

## The checkout is a managed cache

With the `repo` target, `~/.dsh-sync/<profile>/repo` is rewritten by the plugin (`reset --hard`
on `pull`). Do not edit it by hand; every snapshot regenerates the manifest from live Harness
state. The `gist` target keeps its local copy under `~/.dsh-sync/<profile>/gist` and
regenerates it the same way.

## Requirements

- Git on `PATH` (<https://git-scm.com>) — the `repo` target pushes with git; the `gist` target
  talks to the GitHub API and needs no git.
- The GitHub CLI on `PATH` for `authMode: gh` (<https://cli.github.com>) — `gh auth login` once
  per device. A personal access token (`authMode: pat`) or an SSH key works without it.
- A credential with the `gist` scope for the `gist` target.
- A DSH profile (the plugin stores a per-profile snapshot for each target).

## License

MIT — see [LICENSE](LICENSE).

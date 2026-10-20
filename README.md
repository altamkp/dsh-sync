# @altamkp/dsh-sync

Sync DeepSeek Harness plugins and settings across devices through a GitHub repository you own.

- **Bundles** — which plugin packages are installed (with the install spec that reproduces them) and whether they are selected.
- **Plugin rows** — the enabled/disabled state of each plugin row in the profile.
- **Plugin settings** — each plugin's configuration, as it is stored in the profile patch.

Published from <https://github.com/altamkp/dsh-sync>. The current release is 0.1.0.

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
assigned repository, the branch, how the plugin authenticates, the local checkout state, and how
far the live state has drifted from the last committed snapshot — and it carries the same actions
as the tool: refresh, snapshot, push, pull, and diff.

The page scrolls as a whole: the header, the repository card and the actions card travel together in
one scroll area inside the center column, so a long status list is reached by scrolling the page
rather than by scrolling a box inside it.

The status block is a collapsible section inside the repository card. It expands and collapses
with the mouse, and it is open by default, so the first look at the page already shows the
checkout state, the credential and the drift. Collapsing it only folds the details away: no
state changes, and the actions keep working.

The page is a view over the plugin's own host routes (`/dsh-sync/api/status`,
`/dsh-sync/api/action`); the actions call exactly the functions the `dsh_sync` tool calls, so
there is one implementation of every sync step. The routes refuse requests that do not come from
a trusted local page (cross-site requests, a foreign `Origin`, or a `Host` that is neither
loopback nor a declared authority).

The repository is assigned on the page itself ("修改仓库 / Edit repository" → save); the save
writes the plugin's own configuration row in the profile patch, exactly like the tool's
`configure` action. The same form chooses the authentication method — the GitHub CLI (the
default) or a personal access token — and shows which credential is in use.

### The actions follow the remote

The page reads the local state first and then asks the host whether the repository can actually
be reached (`git ls-remote` against the remote URL, which works before the local checkout
exists). Snapshot, push, pull, and diff stay disabled until that probe succeeds, and the page
says why when they are disabled: no repository assigned yet, the remote refused the access
(wrong credential or missing repository rights), the remote could not be reached, git is not
installed on the device, the GitHub CLI is missing or not logged in, or no token variable is
set. Refresh stays enabled in every case — it is the button that re-checks the remote. The
failure reason is classified from git's own message, so "authentication failed" and "could not
resolve host" are told apart.

The probe says nothing about writing, so the host also asks the GitHub API which permissions
the credential holds; a credential that may only read leaves the push button disabled with the
reason shown, while snapshot, pull, and diff stay usable.

## How it works

The plugin keeps a managed git checkout under `~/.dsh-sync/<profile>/repo` and a single
`dsh-sync.json` manifest in it.

| Action | Effect |
| --- | --- |
| `status` | Local facts: configured repository, checkout state, upstream distance, and drift against the committed snapshot. Read-only. |
| `configure` | Assigns the repository, branch, authentication method, and token variable name in the plugin settings. |
| `snapshot` | Regenerates the manifest from live Harness state and commits it locally. |
| `push` | Same as `snapshot`, then pushes the branch to GitHub. |
| `pull` | Resets the checkout to the remote branch and applies the manifest on this device. |
| `diff` | Live state against the committed snapshot, without contacting GitHub. |

`pull` applies changes through the same services the settings UI uses — `pluginManager` for
bundles and plugin rows, `configEditor` for plugin configurations — so a change that the
Loader cannot apply live is reported as `restart-required`.

## Assigning the repository

Through the agent tool:

```
dsh_sync action=configure repoUrl=https://github.com/<owner>/<repo> branch=main
```

or by editing the plugin's own configuration in the profile patch:

```yaml
- insert:
    - id: dsh-sync
      name: '@altamkp/dsh-sync'
      config:
        repoUrl: https://github.com/<owner>/<repo>
        branch: main
```

`git@github.com:<owner>/<repo>.git` and `github:<owner>/<repo>` are accepted as well. The row
name must match the installed package (`@altamkp/dsh-sync`); the profile patch layer wins over
the bundle layer, so a renamed package needs the same rename here.

## Access to private repositories

The repository may be public or private. The plugin authenticates in one of two modes, chosen
with `authMode` (on the page, or in the plugin's own configuration):

### `authMode: gh` — the GitHub CLI (the default)

The plugin asks the GitHub CLI for the credential it already holds:

```
gh auth token --hostname github.com
```

That is the token of the account `gh` is logged in as — from the system keyring, from gh's own
configuration, or from `GH_TOKEN`. The plugin reads it, hands it to git as an HTTP `Authorization`
header scoped to `https://github.com/` (through git's `GIT_CONFIG_*` environment mechanism, so it
never reaches the command line, the repository configuration, or the manifest), and forgets it.
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
repository.

### SSH remotes

With an `git@github.com:<owner>/<repo>.git` remote, your SSH key authenticates the repository and
no token is used — in either mode. The status block says so.

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

## What is never synced

- Credentials, tokens, and keys: a config key whose **word** names a credential (`key`, `token`,
  `secret`, `password`, `passphrase`, `credential`, `pat`, `bearer`) is omitted from the manifest
  and recorded only as a path — `apiKeyEnv`, `authToken`, and `clientSecret` never leave the
  device. On `pull` those paths keep this device's local value. A benign word in front cancels
  the match, so `maxTokens`, `maxOutputTokens`, and `contextWindow` are ordinary settings and
  **do** sync. Both word lists are configurable (`redactKeySegments`, `redactBenignQualifiers`).
- Sessions, workspace files, and anything outside the profile's plugin configuration.

The manifest does contain your plugin list and plugin settings, so use a **private** repository
unless you intend to publish that inventory.

## The checkout is a managed cache

`~/.dsh-sync/<profile>/repo` is rewritten by the plugin (`reset --hard` on `pull`). Do not edit it
by hand; every snapshot regenerates the manifest from live Harness state.

## Requirements

- Git on `PATH` (<https://git-scm.com>).
- The GitHub CLI on `PATH` for `authMode: gh` (<https://cli.github.com>) — `gh auth login` once
  per device. A personal access token (`authMode: pat`) or an SSH key works without it.
- A DSH profile (the plugin stores per-profile checkouts).

## License

MIT — see [LICENSE](LICENSE).

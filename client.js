/**
 * DSH Sync — browser half.
 *
 * Contributes one sidebar row and one center-column page to the Harness Web
 * GUI, so the same operations the `dsh_sync` tool performs are reachable by
 * hand: watch the repository state, take a snapshot, publish it, pull the
 * remote manifest, and see what differs.
 *
 * The page is a thin view over the Host half: every action travels to the
 * package's own HTTP routes, which call exactly the functions the tool calls.
 * Nothing is duplicated here, and nothing is decided in the browser.
 *
 * Plain JavaScript on purpose — the browser artifact is served as-is, with no
 * build step. React comes from the browser module table; no Harness client
 * package is imported.
 */
window.__ModuleLoader__.load({
  id: '@altamkp/dsh-sync',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace this package owns. */
    const NS = 'dsh-sync';
    /** Panel id shared by the sidebar row and the main-slot occupant. */
    const PANEL_ID = 'dsh-sync';
    /** Row order among the shell's global panel rows (Plugins 0, Market 1, Schedules 10, Task board 20). */
    const PANEL_ORDER = 30;
    /** Host routes served by this package's own host half. */
    const STATUS_ROUTE = '/dsh-sync/api/status';
    const ACTION_ROUTE = '/dsh-sync/api/action';

    /* ------------------------------ dictionaries ----------------------------- */

    /** zh copy (the key set is the source of truth). */
    const zh = {
      'nav.label': '同步',
      'page.title': '同步',
      'page.subtitle': '在多台设备之间同步 DeepSeek Harness 的插件与设置。',
      'card.repository': '仓库',
      'card.status': '状态',
      'card.actions': '操作',
      'card.result': '结果',
      'field.repository': 'GitHub 仓库',
      'field.branch': '分支',
      'field.tokenEnv': '令牌环境变量',
      'field.authMode': '认证方式',
      'auth.mode.gh': 'GitHub CLI (gh)',
      'auth.mode.pat': '个人访问令牌 (PAT)',
      'auth.hint.gh': '使用 gh auth login 登录的账号凭据，无需自行配置令牌。',
      'auth.hint.pat': '令牌从环境变量读取，不会写入配置，也不会离开这台设备。',
      'field.checkout': '本地缓存',
      'field.auth': '认证',
      'field.drift': '与快照的差异',
      'field.remote': '远端仓库',
      'field.device': '本机',
      'notConfigured': '尚未指定仓库',
      'notConfiguredHint': '填写一个 GitHub 仓库地址并保存，即可开始同步。',
      'placeholder.repository': 'https://github.com/<owner>/<repo>',
      'btn.save': '保存',
      'btn.cancel': '取消',
      'btn.edit': '修改仓库',
      'btn.refresh': '刷新状态',
      'btn.snapshot': '生成快照',
      'btn.push': '推送到 GitHub',
      'btn.pull': '从 GitHub 拉取',
      'btn.diff': '查看差异',
      'busy': '处理中…',
      'error.title': '操作失败',
      'error.request': '无法连接本机 DSH 服务，请确认它仍在运行。',
      'error.unexpected': '后台返回了无法识别的响应。',
      'result.snapshot.committed': '已在本地提交快照。',
      'result.snapshot.unchanged': '本地状态与已提交的快照一致，无需提交。',
      'result.snapshot.localOnly': '快照只提交在本地，调用「推送到 GitHub」即可发布。',
      'result.push.pushed': '已推送到 GitHub。',
      'result.push.counts': '插件包 {bundles} 个 · 插件 {plugins} 个 · 设置 {configs} 项',
      'result.pull.summary': '已应用：安装 {bundlesInstalled} · 开关 {bundleToggles} · 插件 {pluginToggles} · 设置 {configsWritten} · 跳过 {skipped} · 失败 {failures}',
      'result.pull.steps': '本次改动',
      'result.pull.skipped': '已跳过',
      'result.pull.restart': '部分改动需要重启 DeepSeek Harness 后生效。',
      'result.diff.equal': '本地状态与已提交的快照完全一致。',
      'result.diff.title': '与已提交快照的差异',
      'result.diff.added': '新增',
      'result.diff.removed': '移除',
      'result.diff.changed': '变化',
      'result.configure.saved': '已保存仓库设置。',
      'status.tokenPresent': '已找到令牌',
      'status.tokenMissing': '未设置令牌',
      'status.authHelper': '将使用 git 凭据助手或 SSH 密钥访问',
      'status.auth.ghAccount': 'GitHub CLI · 已登录 {account}',
      'status.auth.ghLoggedIn': 'GitHub CLI · 已登录',
      'status.auth.ghMissing': 'GitHub CLI · 未安装',
      'status.auth.ghNotLoggedIn': 'GitHub CLI · 未登录',
      'status.auth.ssh': 'SSH 远程仓库 · 使用 SSH 密钥认证',
      'status.access.canPush': '可推送',
      'status.access.readOnly': '只读，无法推送',
      'status.clean': '工作区干净',
      'status.dirty': '本地有未提交的改动',
      'status.aheadBehind': '领先 {ahead} 个提交 · 落后 {behind} 个提交',
      'status.sameAsSnapshot': '与上次快照一致',
      'status.drift': '{bundles} 个插件包、{plugins} 个插件、{configs} 项设置与快照不同',
      'status.noSnapshot': '还没有提交过快照',
      'status.checkoutMissing': '尚未创建本地缓存，首次同步时会自动建立',
      'remote.reachable': '远端可访问',
      'remote.unreachable': '远端不可访问',
      'remote.hasBranch': '远端包含该分支',
      'remote.noBranch': '远端还没有该分支',
      'remote.checking': '正在检查远端…',
      'remote.reason.denied': '认证或权限不足',
      'remote.reason.unreachable': '网络不可达',
      'remote.reason.missingGit': '缺少 git 命令行工具',
      'remote.reason.missingGh': '未安装 GitHub CLI',
      'remote.reason.notAuthenticated': 'GitHub CLI 未登录',
      'remote.reason.noToken': '未设置令牌',
      'remote.reason.unknown': '未知原因',
      'actions.blocked.loading': '正在读取同步状态，操作按钮暂不可用。',
      'actions.blocked.checking': '正在检查远端仓库是否可访问，操作按钮暂不可用。',
      'actions.blocked.notConfigured': '尚未指定仓库，操作按钮暂不可用。',
      'actions.blocked.denied': '远端拒绝了访问（认证或权限问题），操作按钮暂不可用。',
      'actions.blocked.unreachable': '无法连接远端仓库，操作按钮暂不可用。',
      'actions.blocked.missingGit': '本机没有可用的 git 命令行工具，操作按钮暂不可用。',
      'actions.blocked.missingGh': '本机没有安装 GitHub CLI (gh)，操作按钮暂不可用。',
      'actions.blocked.notAuthenticated': 'GitHub CLI 尚未登录（请运行 gh auth login），操作按钮暂不可用。',
      'actions.blocked.noToken': '尚未设置令牌环境变量，操作按钮暂不可用。',
      'actions.blocked.readOnly': '当前凭据对该仓库只有只读权限，无法推送。',
      'actions.blocked.unknown': '无法访问远端仓库，操作按钮暂不可用。',
      'note.secret': '密钥类设置不会被导出，也不会离开这台设备。',
      'note.tool': '同样的操作也可以交给 Agent：dsh_sync 工具。',
      'raw': '原始结果',
      'unknown': '未知',
    };

    /** en copy. */
    const en = {
      'nav.label': 'Sync',
      'page.title': 'Sync',
      'page.subtitle': 'Sync DeepSeek Harness plugins and settings between devices.',
      'card.repository': 'Repository',
      'card.status': 'Status',
      'card.actions': 'Actions',
      'card.result': 'Result',
      'field.repository': 'GitHub repository',
      'field.branch': 'Branch',
      'field.tokenEnv': 'Token environment variable',
      'field.authMode': 'Authentication method',
      'auth.mode.gh': 'GitHub CLI (gh)',
      'auth.mode.pat': 'Personal access token (PAT)',
      'auth.hint.gh': "Uses the credential of the account the GitHub CLI is logged in as; there is no token to configure.",
      'auth.hint.pat': 'The token is read from an environment variable — it is never written to the configuration and never leaves this device.',
      'field.checkout': 'Local checkout',
      'field.auth': 'Authentication',
      'field.drift': 'Difference from snapshot',
      'field.remote': 'Remote repository',
      'field.device': 'Device',
      'notConfigured': 'No repository assigned yet',
      'notConfiguredHint': 'Enter a GitHub repository and save to start syncing.',
      'placeholder.repository': 'https://github.com/<owner>/<repo>',
      'btn.save': 'Save',
      'btn.cancel': 'Cancel',
      'btn.edit': 'Edit repository',
      'btn.refresh': 'Refresh status',
      'btn.snapshot': 'Snapshot',
      'btn.push': 'Push to GitHub',
      'btn.pull': 'Pull from GitHub',
      'btn.diff': 'Show differences',
      'busy': 'Working…',
      'error.title': 'Action failed',
      'error.request': 'Cannot reach the local DSH service; check that it is still running.',
      'error.unexpected': 'The host returned a response this page cannot read.',
      'result.snapshot.committed': 'Snapshot committed locally.',
      'result.snapshot.unchanged': 'Local state already matches the committed snapshot; nothing to commit.',
      'result.snapshot.localOnly': 'The snapshot is committed locally only; use Push to publish it.',
      'result.push.pushed': 'Pushed to GitHub.',
      'result.push.counts': '{bundles} bundles · {plugins} plugins · {configs} settings',
      'result.pull.summary': 'Applied: {bundlesInstalled} installed · {bundleToggles} toggles · {pluginToggles} plugins · {configsWritten} settings · {skipped} skipped · {failures} failed',
      'result.pull.steps': 'Changes',
      'result.pull.skipped': 'Skipped',
      'result.pull.restart': 'Some changes need a DeepSeek Harness restart to take effect.',
      'result.diff.equal': 'Local state matches the committed snapshot exactly.',
      'result.diff.title': 'Difference from the committed snapshot',
      'result.diff.added': 'Added',
      'result.diff.removed': 'Removed',
      'result.diff.changed': 'Changed',
      'result.configure.saved': 'Repository settings saved.',
      'status.tokenPresent': 'Token found',
      'status.tokenMissing': 'No token set',
      'status.authHelper': "Access relies on git's credential helper or an SSH remote",
      'status.auth.ghAccount': 'GitHub CLI · logged in as {account}',
      'status.auth.ghLoggedIn': 'GitHub CLI · logged in',
      'status.auth.ghMissing': 'GitHub CLI · not installed',
      'status.auth.ghNotLoggedIn': 'GitHub CLI · not logged in',
      'status.auth.ssh': 'SSH remote · your SSH key authenticates it',
      'status.access.canPush': 'can push',
      'status.access.readOnly': 'read-only, cannot push',
      'status.clean': 'Working tree clean',
      'status.dirty': 'Local changes are not committed',
      'status.aheadBehind': '{ahead} commit(s) ahead · {behind} commit(s) behind',
      'status.sameAsSnapshot': 'Matches the last snapshot',
      'status.drift': '{bundles} bundles, {plugins} plugins and {configs} settings differ from the snapshot',
      'status.noSnapshot': 'No snapshot committed yet',
      'status.checkoutMissing': 'The local checkout is created on the first sync',
      'remote.reachable': 'Remote reachable',
      'remote.unreachable': 'Remote unreachable',
      'remote.hasBranch': 'The remote has this branch',
      'remote.noBranch': 'The remote has no such branch yet',
      'remote.checking': 'Checking the remote…',
      'remote.reason.denied': 'authentication or permission',
      'remote.reason.unreachable': 'network unreachable',
      'remote.reason.missingGit': 'git command line tool missing',
      'remote.reason.missingGh': 'the GitHub CLI is not installed',
      'remote.reason.notAuthenticated': 'the GitHub CLI is not logged in',
      'remote.reason.noToken': 'no token set',
      'remote.reason.unknown': 'unknown reason',
      'actions.blocked.loading': 'Reading the sync state — the action buttons are unavailable.',
      'actions.blocked.checking': 'Checking whether the remote repository is reachable — the action buttons are unavailable.',
      'actions.blocked.notConfigured': 'No repository is assigned yet — the action buttons are unavailable.',
      'actions.blocked.denied': 'The remote refused the access (authentication or permissions) — the action buttons are unavailable.',
      'actions.blocked.unreachable': 'The remote repository cannot be reached — the action buttons are unavailable.',
      'actions.blocked.missingGit': 'No git command line tool is available on this device — the action buttons are unavailable.',
      'actions.blocked.missingGh': 'The GitHub CLI (gh) is not installed on this device — the action buttons are unavailable.',
      'actions.blocked.notAuthenticated': 'The GitHub CLI is not logged in (run `gh auth login`) — the action buttons are unavailable.',
      'actions.blocked.noToken': 'No token environment variable is set — the action buttons are unavailable.',
      'actions.blocked.readOnly': 'The current credential has read-only access to this repository — it cannot push.',
      'actions.blocked.unknown': 'The remote repository cannot be accessed — the action buttons are unavailable.',
      'note.secret': 'Secret-shaped settings are never exported and never leave this device.',
      'note.tool': 'The same operations are available to an Agent through the dsh_sync tool.',
      'raw': 'Raw result',
      'unknown': 'unknown',
    };

    const DICTIONARIES = { zh, en };

    /** The locale service, once the plugin has applied. */
    let localeService;
    /** Active language id, refreshed from the locale service. */
    let language = 'zh';

    /** Replace `{name}` placeholders with the given values. */
    function interpolate(text, params) {
      if (params === undefined) return text;
      return String(text).replace(/\{(\w+)\}/g, (match, name) => {
        const value = params[name];
        return value === undefined ? match : String(value);
      });
    }

    /** The active language id, read from the locale service at call time. */
    function activeLanguage() {
      if (localeService !== undefined && typeof localeService.getSnapshot === 'function') {
        try {
          const snapshot = localeService.getSnapshot();
          const active = snapshot === undefined ? undefined : snapshot.active;
          if (typeof active === 'string' && active !== '') return active;
        } catch {
          // Fall back to the language read when the plugin applied.
        }
      }
      return language;
    }

    /** The active language's dictionary, English as the fallback. */
    function dictionary() {
      return activeLanguage().startsWith('zh') ? zh : en;
    }

    /** Translate one key in the active language. */
    function t(key, params) {
      const dict = dictionary();
      const text = dict[key] ?? en[key] ?? key;
      return interpolate(text, params);
    }

    /* --------------------------------- routes -------------------------------- */

    /**
     * Resolve one package route against the page's own base, so the request
     * reaches the host route the host half registered (root-absolute).
     */
    function route(path) {
      const relative = String(path).replace(/^\/+/, '');
      if (typeof document === 'undefined') return `/${relative}`;
      try {
        const base = new URL(document.baseURI);
        if (base.protocol === 'http:' || base.protocol === 'https:') {
          return new URL(relative, `${base.origin}/`).pathname;
        }
      } catch {
        // A non-standard scheme (the desktop shell) has no usable origin; the
        // host route is root-absolute there too.
      }
      return `/${relative}`;
    }

    /** Read one JSON response, refusing anything that is not JSON. */
    async function readJson(response) {
      const text = await response.text();
      if (text.trim() === '') return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(t('error.unexpected'));
      }
    }

    /**
     * Ask the host half for the current sync state.
     *
     * `probe` asks the host to contact GitHub as well, which is what tells
     * the page whether the repository can be reached and used at all.
     */
    async function readStatus(probe) {
      const suffix = probe === true ? '?probe=1' : '';
      let response;
      try {
        response = await fetch(`${route(STATUS_ROUTE)}${suffix}`, { cache: 'no-store', headers: { accept: 'application/json' } });
      } catch {
        throw new Error(t('error.request'));
      }
      const payload = await readJson(response);
      if (!response.ok) throw new Error(payload && payload.error ? String(payload.error) : t('error.unexpected'));
      // The host answers with an envelope; the page reads the result itself.
      return payload.result ?? payload;
    }

    /** Run one sync action through the host half. */
    async function runAction(action, body) {
      let response;
      try {
        response = await fetch(route(ACTION_ROUTE), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ action, ...(body ?? {}) }),
          cache: 'no-store',
        });
      } catch {
        throw new Error(t('error.request'));
      }
      const payload = await readJson(response);
      if (!response.ok) throw new Error(payload && payload.error ? String(payload.error) : t('error.unexpected'));
      return payload;
    }

    /* ------------------------------- components ------------------------------ */

    /**
     * The sidebar row glyph. The shell owns the button, the label, the active
     * highlight and the collapsed rail; this draws only the mark.
     */
    function SyncPanelIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 16;
      return h('svg', {
        'data-dsh-panel-entry': PANEL_ID,
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M3.5 7a4.75 4.75 0 0 1 8.3-3.2' }),
        h('path', { d: 'M11.8 1.7v2.4H9.4' }),
        h('path', { d: 'M12.5 9a4.75 4.75 0 0 1-8.3 3.2' }),
        h('path', { d: 'M4.2 14.3v-2.4h2.4' }),
      );
    }

    /** One label/value row. */
    function Row(props) {
      return h('div', { className: 'dsh-sync-row' },
        h('div', { className: 'dsh-sync-key' }, props.label),
        h('div', { className: 'dsh-sync-value' }, props.value),
      );
    }

    /** One button. */
    function Button(props) {
      return h('button', {
        type: 'button',
        className: `dsh-sync-button${props.primary === true ? ' dsh-sync-button-primary' : ''}`,
        disabled: props.disabled === true,
        title: props.title,
        onClick: props.onClick,
      }, props.label);
    }

    /** The result of one action, rendered as a short summary. */
    function ResultView(props) {
      const outcome = props.outcome;
      if (outcome === null || outcome === undefined) return null;
      if (outcome.ok !== true) {
        return h('div', { className: 'dsh-sync-card' },
          h('div', { className: 'dsh-sync-card-title dsh-sync-error' }, t('error.title')),
          h('pre', { className: 'dsh-sync-pre' }, String(outcome.error ?? '')),
        );
      }
      const result = outcome.result ?? {};
      const lines = [];
      if (outcome.action === 'snapshot') {
        lines.push(result.committed === true ? t('result.snapshot.committed') : t('result.snapshot.unchanged'));
        if (result.committed === true && result.pushed !== true) lines.push(t('result.snapshot.localOnly'));
      } else if (outcome.action === 'push') {
        lines.push(result.pushed === true ? t('result.push.pushed') : t('result.snapshot.localOnly'));
        if (result.summary !== undefined) {
          lines.push(t('result.push.counts', {
            bundles: result.summary.bundles ?? 0,
            plugins: result.summary.plugins ?? 0,
            configs: result.summary.configs ?? 0,
          }));
        }
      } else if (outcome.action === 'pull') {
        const summary = result.summary ?? {};
        lines.push(t('result.pull.summary', {
          bundlesInstalled: summary.bundlesInstalled ?? 0,
          bundleToggles: summary.bundleToggles ?? 0,
          pluginToggles: summary.pluginToggles ?? 0,
          configsWritten: summary.configsWritten ?? 0,
          skipped: summary.skipped ?? 0,
          failures: summary.failures ?? 0,
        }));
        if (result.restartAdvisory !== undefined) lines.push(t('result.pull.restart'));
      } else if (outcome.action === 'diff') {
        lines.push(result.equal === true ? t('result.diff.equal') : t('result.diff.title'));
      } else if (outcome.action === 'configure') {
        lines.push(t('result.configure.saved'));
      }
      const steps = Array.isArray(result.steps) ? result.steps : [];
      const skipped = result.skipped && Array.isArray(result.skipped.sample) ? result.skipped.sample : [];
      return h('div', { className: 'dsh-sync-card' },
        h('div', { className: 'dsh-sync-card-title' }, t('card.result')),
        h('div', { className: 'dsh-sync-success' }, lines.map((line, index) => h('div', { key: `line-${index}` }, line))),
        steps.length > 0
          ? h('div', null,
            h('div', { className: 'dsh-sync-note', style: { marginTop: '10px' } }, t('result.pull.steps')),
            h('ul', { className: 'dsh-sync-list' }, steps.map((step, index) => h('li', { key: `step-${index}` },
              h('span', { className: 'dsh-sync-mono' }, `${step.step ?? ''}${step.target ? ` ${step.target}` : ''}`),
            ))),
          )
          : null,
        skipped.length > 0
          ? h('div', null,
            h('div', { className: 'dsh-sync-note', style: { marginTop: '10px' } }, t('result.pull.skipped')),
            h('ul', { className: 'dsh-sync-list' }, skipped.map((step, index) => h('li', { key: `skip-${index}` },
              h('span', { className: 'dsh-sync-mono' }, `${step.target ?? ''} — ${step.reason ?? ''}`),
            ))),
          )
          : null,
        h('details', { className: 'dsh-sync-details' },
          h('summary', null, t('raw')),
          h('pre', { className: 'dsh-sync-pre' }, JSON.stringify(result, null, 2)),
        ),
      );
    }

    /** Why the repository is unusable, mapped to its localized sentence. */
    const BLOCKED_TEXT = {
      loading: 'actions.blocked.loading',
      checking: 'actions.blocked.checking',
      notConfigured: 'actions.blocked.notConfigured',
      denied: 'actions.blocked.denied',
      unreachable: 'actions.blocked.unreachable',
      'missing-git': 'actions.blocked.missingGit',
      'missing-gh': 'actions.blocked.missingGh',
      'not-authenticated': 'actions.blocked.notAuthenticated',
      'no-token': 'actions.blocked.noToken',
      unknown: 'actions.blocked.unknown',
    };

    /** The host's failure reason, mapped to a short localized label. */
    const REASON_TEXT = {
      denied: 'remote.reason.denied',
      unreachable: 'remote.reason.unreachable',
      'missing-git': 'remote.reason.missingGit',
      'missing-gh': 'remote.reason.missingGh',
      'not-authenticated': 'remote.reason.notAuthenticated',
      'no-token': 'remote.reason.noToken',
      unknown: 'remote.reason.unknown',
    };

    /**
     * The authentication line in the status card.
     *
     * The host reports which credential is in use — the GitHub CLI or a
     * personal access token — and whether it is there at all. The token
     * itself never reaches the browser.
     */
    function authText(auth) {
      if (auth === undefined) return t('unknown');
      let text;
      if (auth.mode === 'gh') {
        if (auth.cliAvailable !== true) text = t('status.auth.ghMissing');
        else if (auth.authenticated !== true) text = t('status.auth.ghNotLoggedIn');
        else text = auth.account !== undefined
          ? t('status.auth.ghAccount', { account: auth.account })
          : t('status.auth.ghLoggedIn');
      } else {
        text = auth.tokenPresent === true
          ? `${auth.tokenEnv ?? ''} — ${t('status.tokenPresent')}`
          : `${auth.tokenEnv ?? ''} — ${t('status.tokenMissing')} (${t('status.authHelper')})`;
      }
      // An SSH remote is authenticated by the user's SSH key, not by a token.
      return auth.remoteKind === 'ssh' ? `${text} · ${t('status.auth.ssh')}` : text;
    }

    /** The page: repository settings, live status, and the actions. */
    function SyncPanelPage() {
      const [status, setStatus] = React.useState(null);
      const [statusError, setStatusError] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [outcome, setOutcome] = React.useState(null);
      const [editing, setEditing] = React.useState(false);
      // The status is a disclosure inside the repository card. It starts open,
      // so the page shows the same state it showed before the reorganisation.
      const [statusOpen, setStatusOpen] = React.useState(true);
      const [form, setForm] = React.useState({ repoUrl: '', branch: '', githubTokenEnv: '', authMode: 'gh' });
      const [formTouched, setFormTouched] = React.useState(false);
      const [probing, setProbing] = React.useState(false);
      const [, setRevision] = React.useState(0);

      // The shell re-reads the sidebar label on every locale change; the page
      // re-renders with it so the copy follows the Language setting.
      React.useEffect(() => {
        if (localeService === undefined) return undefined;
        const unsubscribe = localeService.subscribe(() => setRevision((value) => value + 1));
        return unsubscribe;
      }, []);

      /** Fill the edit form from the state, unless the user already typed. */
      const applyFormDefaults = (next) => {
        if (formTouched) return;
        setForm((current) => ({
          repoUrl: current.repoUrl || next.repository || '',
          branch: current.branch || next.branch || '',
          githubTokenEnv: current.githubTokenEnv || (next.authentication && next.authentication.tokenEnv) || '',
          authMode: current.authMode || (next.authentication && next.authentication.mode) || 'gh',
        }));
      };

      /**
       * Read the state, then — when a repository is assigned — ask the host
       * whether that repository can actually be reached.
       *
       * The local read comes first so the page is usable at once; the probe
       * decides whether the repository actions may run at all.
       */
      const refresh = async () => {
        let local;
        try {
          local = await readStatus(false);
        } catch (error) {
          setStatusError(String(error && error.message ? error.message : error));
          return;
        }
        setStatus(local);
        setStatusError(null);
        applyFormDefaults(local);
        if (local.configured !== true) {
          setProbing(false);
          return;
        }
        setProbing(true);
        try {
          const probed = await readStatus(true);
          setStatus(probed);
        } catch (error) {
          setStatusError(String(error && error.message ? error.message : error));
        } finally {
          setProbing(false);
        }
      };

      React.useEffect(() => {
        void refresh();
      }, []);

      const doRefresh = async () => {
        setBusy('status');
        try {
          await refresh();
        } finally {
          setBusy(null);
        }
      };

      const act = async (action, body) => {
        setBusy(action);
        setOutcome(null);
        try {
          const payload = await runAction(action, body);
          setOutcome({ action, ok: payload.ok !== false, result: payload.result ?? payload });
        } catch (error) {
          setOutcome({ action, ok: false, error: String(error && error.message ? error.message : error) });
        } finally {
          setBusy(null);
        }
        await refresh();
      };

      const save = async () => {
        setBusy('configure');
        setOutcome(null);
        try {
          const payload = await runAction('configure', {
            repoUrl: form.repoUrl.trim(),
            branch: form.branch.trim(),
            authMode: form.authMode,
            githubTokenEnv: form.githubTokenEnv.trim(),
          });
          setOutcome({ action: 'configure', ok: payload.ok !== false, result: payload.result ?? payload });
          setEditing(false);
        } catch (error) {
          setOutcome({ action: 'configure', ok: false, error: String(error && error.message ? error.message : error) });
        } finally {
          setBusy(null);
        }
        await refresh();
      };

      const configured = status !== null && status.configured === true;
      const checkout = status && status.checkout ? status.checkout : undefined;
      const auth = status && status.authentication ? status.authentication : undefined;
      const drift = status && status.drift ? status.drift : undefined;
      const remote = status && status.remote ? status.remote : undefined;

      /**
       * Why the repository cannot be used right now, or undefined when it can.
       *
       * An operation that needs the repository — snapshot, push, pull, diff —
       * would fail with a transport error otherwise, so the buttons stay
       * disabled until the host confirms the repository is reachable and
       * usable from this device.
       */
      const blocked = status === null
        ? 'loading'
        : configured !== true
          ? 'notConfigured'
          : remote === undefined
            ? (probing === true ? 'checking' : 'unknown')
            : remote.reachable === true
              ? undefined
              : remote.reason ?? 'unknown';

      const blockedText = blocked === undefined ? undefined : t(BLOCKED_TEXT[blocked] ?? 'actions.blocked.unknown');
      /** Every repository operation waits for an accessible repository. */
      const operationsDisabled = busy !== null || blocked !== undefined;
      /** A credential that may only read cannot publish the snapshot. */
      const readOnly = remote !== undefined && remote.access !== undefined && remote.access.canPush === false;
      const pushDisabled = operationsDisabled || readOnly === true;
      const pushTitle = readOnly === true ? t('actions.blocked.readOnly') : blockedText;

      const statusRows = [];
      if (status !== null) {
        statusRows.push(h(Row, { key: 'repo', label: t('field.repository'), value: status.repository ?? t('notConfigured') }));
        statusRows.push(h(Row, { key: 'branch', label: t('field.branch'), value: status.branch ?? t('unknown') }));
        if (auth !== undefined) {
          statusRows.push(h(Row, { key: 'auth', label: t('field.auth'), value: authText(auth) }));
        }
        if (checkout !== undefined) {
          statusRows.push(h(Row, {
            key: 'checkout',
            label: t('field.checkout'),
            value: checkout.initialized === true
              ? h('span', { className: 'dsh-sync-mono' }, checkout.path ?? '')
              : t('status.checkoutMissing'),
          }));
          if (checkout.initialized === true) {
            statusRows.push(h(Row, {
              key: 'clean',
              label: t('field.device'),
              value: checkout.clean === true
                ? `${t('status.clean')}${checkout.aheadUpstream !== undefined ? ` · ${t('status.aheadBehind', { ahead: checkout.aheadUpstream ?? 0, behind: checkout.behindUpstream ?? 0 })}` : ''}`
                : t('status.dirty'),
            }));
          }
        }
        if (drift !== undefined) {
          const counts = drift.counts ?? {};
          statusRows.push(h(Row, {
            key: 'drift',
            label: t('field.drift'),
            value: drift.equalsCommittedSnapshot === true
              ? t('status.sameAsSnapshot')
              : t('status.drift', {
                bundles: counts.bundlesChanged ?? 0,
                plugins: counts.pluginsChanged ?? 0,
                configs: counts.configsChanged ?? 0,
              }),
          }));
        }
        if (remote !== undefined) {
          const access = remote.access;
          const accessText = access === undefined
            ? undefined
            : access.canPush === true ? t('status.access.canPush') : t('status.access.readOnly');
          statusRows.push(h(Row, {
            key: 'remote',
            label: t('field.remote'),
            value: [
              remote.reachable === true
                ? `${t('remote.reachable')} · ${remote.hasBranch === true ? t('remote.hasBranch') : t('remote.noBranch')}`
                : `${t('remote.unreachable')} · ${t(REASON_TEXT[remote.reason] ?? 'remote.reason.unknown')}`,
              ...(accessText === undefined ? [] : [accessText]),
            ].join(' · '),
          }));
        } else if (probing === true) {
          statusRows.push(h(Row, { key: 'remote', label: t('field.remote'), value: t('remote.checking') }));
        }
      }

      /**
       * The one-line state summary shown on the disclosure header.
       *
       * It is built from the state the page already holds — the credential in
       * use and the access the remote grants — so the header answers "can I
       * sync right now?" without opening the section. Only existing
       * dictionary keys are used.
       */
      const statusSummary = (() => {
        if (status === null) return t('busy');
        if (configured !== true) return t('notConfigured');
        const parts = [];
        if (auth !== undefined) {
          if (auth.mode === 'gh') {
            if (auth.cliAvailable !== true) parts.push(t('status.auth.ghMissing'));
            else if (auth.authenticated !== true) parts.push(t('status.auth.ghNotLoggedIn'));
            else if (auth.account !== undefined) parts.push(t('status.auth.ghAccount', { account: auth.account }));
            else parts.push(t('status.auth.ghLoggedIn'));
          } else {
            parts.push(auth.tokenPresent === true ? t('status.tokenPresent') : t('status.tokenMissing'));
          }
        }
        if (remote !== undefined) {
          if (remote.reachable !== true) parts.push(t('remote.unreachable'));
          else if (remote.access !== undefined) {
            parts.push(remote.access.canPush === true ? t('status.access.canPush') : t('status.access.readOnly'));
          }
        }
        return parts.length > 0 ? parts.join(' · ') : t('unknown');
      })();

      return h(React.Fragment, null,
        h('style', null, PAGE_STYLES),
        // The shell's center column is a clipping flex column and the slot
        // outlet anchor is `display:contents`, so this wrapper — not the page
        // — is the flex item. It may shrink below its content and scroll;
        // the page keeps its own fixed measure inside it.
        h('div', { className: 'dsh-sync-scroll' },
          h('div', { className: 'dsh-sync-page' },
            h('header', { className: 'dsh-sync-header' },
              h('h1', { className: 'dsh-sync-title' }, t('page.title')),
              h('p', { className: 'dsh-sync-subtitle' }, t('page.subtitle')),
            ),

            statusError !== null
              ? h('div', { className: 'dsh-sync-card dsh-sync-error' }, statusError)
              : null,

            h('section', { className: 'dsh-sync-card' },
              h('div', { className: 'dsh-sync-card-title' }, t('card.repository')),
              configured === false && status !== null
                ? h('div', null,
                  h('div', { className: 'dsh-sync-warn' }, t('notConfigured')),
                  h('div', { className: 'dsh-sync-note' }, t('notConfiguredHint')),
                )
                : null,
              editing === true
                ? h('div', null,
                  h('div', { className: 'dsh-sync-field' },
                    h('label', { className: 'dsh-sync-label' }, t('field.repository')),
                    h('input', {
                      className: 'dsh-sync-input',
                      type: 'text',
                      value: form.repoUrl,
                      placeholder: t('placeholder.repository'),
                      onChange: (event) => { setFormTouched(true); setForm((current) => ({ ...current, repoUrl: event.target.value })); },
                    }),
                  ),
                  h('div', { className: 'dsh-sync-field' },
                    h('label', { className: 'dsh-sync-label' }, t('field.branch')),
                    h('input', {
                      className: 'dsh-sync-input',
                      type: 'text',
                      value: form.branch,
                      onChange: (event) => { setFormTouched(true); setForm((current) => ({ ...current, branch: event.target.value })); },
                    }),
                  ),
                  h('div', { className: 'dsh-sync-field' },
                    h('label', { className: 'dsh-sync-label' }, t('field.authMode')),
                    h('select', {
                      className: 'dsh-sync-input',
                      value: form.authMode,
                      onChange: (event) => { setFormTouched(true); setForm((current) => ({ ...current, authMode: event.target.value })); },
                    },
                      h('option', { value: 'gh' }, t('auth.mode.gh')),
                      h('option', { value: 'pat' }, t('auth.mode.pat')),
                    ),
                    h('div', { className: 'dsh-sync-note', style: { marginTop: '4px' } }, form.authMode === 'pat' ? t('auth.hint.pat') : t('auth.hint.gh')),
                  ),
                  form.authMode === 'pat'
                    ? h('div', { className: 'dsh-sync-field' },
                      h('label', { className: 'dsh-sync-label' }, t('field.tokenEnv')),
                      h('input', {
                        className: 'dsh-sync-input',
                        type: 'text',
                        value: form.githubTokenEnv,
                        onChange: (event) => { setFormTouched(true); setForm((current) => ({ ...current, githubTokenEnv: event.target.value })); },
                      }),
                    )
                    : null,
                  h('div', { className: 'dsh-sync-actions' },
                    h(Button, { label: busy === 'configure' ? t('busy') : t('btn.save'), disabled: busy !== null, onClick: save }),
                    h(Button, { label: t('btn.cancel'), disabled: busy !== null, onClick: () => setEditing(false) }),
                  ),
                )
                : h('div', { className: 'dsh-sync-actions' },
                  h(Button, { label: t('btn.edit'), disabled: busy !== null, onClick: () => { setFormTouched(false); setEditing(true); } }),
                ),

              // The status describes the repository configured right above it,
              // so it lives inside that card as a disclosure rather than
              // standing on its own.
              h('div', { className: 'dsh-sync-disclosure' },
                h('button', {
                  type: 'button',
                  className: 'dsh-sync-disclosure-header',
                  'aria-expanded': statusOpen,
                  onClick: () => setStatusOpen((open) => !open),
                },
                  h('span', { className: 'dsh-sync-disclosure-title' }, t('card.status')),
                  h('span', { className: 'dsh-sync-disclosure-summary' }, statusSummary),
                  h('span', { className: 'dsh-sync-disclosure-marker' },
                    h('svg', {
                      className: `dsh-sync-chevron${statusOpen ? ' dsh-sync-chevron-open' : ''}`,
                      viewBox: '0 0 16 16',
                      width: 14,
                      height: 14,
                      fill: 'none',
                      stroke: 'currentColor',
                      strokeWidth: 1.6,
                      strokeLinecap: 'round',
                      strokeLinejoin: 'round',
                      'aria-hidden': true,
                    }, h('path', { d: 'M6 3.5 10.5 8 6 12.5' })),
                  ),
                ),
                statusOpen
                  ? h('div', { className: 'dsh-sync-disclosure-body' },
                    statusRows.length > 0
                      ? h('div', { className: 'dsh-sync-rows' }, statusRows)
                      : h('div', { className: 'dsh-sync-note' }, t('busy')),
                    h('div', { className: 'dsh-sync-note', style: { marginTop: '12px' } }, t('note.secret')),
                  )
                  : null,
              ),
            ),

            h('section', { className: 'dsh-sync-card' },
              h('div', { className: 'dsh-sync-card-title' }, t('card.actions')),
              h('div', { className: 'dsh-sync-actions' },
                h(Button, { label: busy === 'status' ? t('busy') : t('btn.refresh'), disabled: busy !== null, onClick: doRefresh }),
                h(Button, { label: busy === 'snapshot' ? t('busy') : t('btn.snapshot'), disabled: operationsDisabled, title: blockedText, onClick: () => act('snapshot') }),
                h(Button, { label: busy === 'push' ? t('busy') : t('btn.push'), primary: true, disabled: pushDisabled, title: pushTitle, onClick: () => act('push') }),
                h(Button, { label: busy === 'pull' ? t('busy') : t('btn.pull'), primary: true, disabled: operationsDisabled, title: blockedText, onClick: () => act('pull') }),
                h(Button, { label: busy === 'diff' ? t('busy') : t('btn.diff'), disabled: operationsDisabled, title: blockedText, onClick: () => act('diff') }),
              ),
              blockedText !== undefined
                ? h('div', { className: 'dsh-sync-note dsh-sync-warn', style: { marginTop: '10px' } }, blockedText)
                : null,
              readOnly === true
                ? h('div', { className: 'dsh-sync-note dsh-sync-warn', style: { marginTop: '10px' } }, t('actions.blocked.readOnly'))
                : null,
              h('div', { className: 'dsh-sync-note', style: { marginTop: '10px' } }, t('note.tool')),
            ),

            h(ResultView, { outcome }),
          ),
        ),
      );
    }

    /** Component-local styles: only theme tokens, no literal colors. */
    const PAGE_STYLES = `
/* The shell's center column is a clipping flex column (overflow:hidden) and
   the slot outlet anchor is rendered with display:contents — so this wrapper,
   not the page, is the flex item. min-height:0 lets it shrink below its
   content, and overflow-y:auto turns the remaining height into a scroll
   area; the page keeps its own fixed measure inside it. */
.dsh-sync-scroll {
  box-sizing: border-box;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  width: 100%;
}
.dsh-sync-page {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px 28px 40px;
  /* A fixed measure: the page keeps its own width instead of following the
     window, and never grows past the space the shell hands it. */
  width: 760px;
  max-width: 100%;
  min-width: 0;
  margin: 0 auto;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.6;
}
.dsh-sync-header { display: flex; flex-direction: column; gap: 2px; }
.dsh-sync-title { margin: 0; font-size: 18px; font-weight: 600; }
.dsh-sync-subtitle { margin: 0; color: var(--dsw-alias-label-secondary); }
.dsh-sync-card {
  box-sizing: border-box;
  min-width: 0;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  padding: 16px;
}
.dsh-sync-card-title { font-weight: 600; margin-bottom: 10px; }
.dsh-sync-rows { display: grid; grid-template-columns: minmax(110px, 170px) minmax(0, 1fr); gap: 8px 16px; }
.dsh-sync-key { color: var(--dsw-alias-label-secondary); }
.dsh-sync-value { min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
.dsh-sync-disclosure {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dsh-sync-disclosure-header {
  display: flex;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  width: 100%;
  margin: 0;
  padding: 4px 0;
  background: none;
  border: 0;
  color: var(--dsw-alias-label-primary);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.dsh-sync-disclosure-header:hover .dsh-sync-disclosure-title { color: var(--dsw-alias-brand-primary); }
.dsh-sync-disclosure-title { flex: 0 0 auto; font-weight: 600; }
.dsh-sync-disclosure-summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: right;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
.dsh-sync-disclosure-marker { display: inline-flex; flex: 0 0 auto; color: var(--dsw-alias-label-secondary); }
.dsh-sync-chevron { display: block; transition: transform 160ms ease; }
.dsh-sync-chevron-open { transform: rotate(90deg); }
.dsh-sync-disclosure-body { margin-top: 10px; }
.dsh-sync-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.dsh-sync-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.dsh-sync-button {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
}
.dsh-sync-button:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.dsh-sync-button:disabled { opacity: 0.55; cursor: default; }
.dsh-sync-button-primary {
  border-color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
}
.dsh-sync-field { margin-bottom: 12px; }
.dsh-sync-label { display: block; font-size: 12px; color: var(--dsw-alias-label-secondary); margin-bottom: 4px; }
.dsh-sync-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--dsw-alias-bg-base);
  border: 1px solid var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 13px;
  font-family: inherit;
}
select.dsh-sync-input { cursor: pointer; }
.dsh-sync-error { color: var(--dsw-alias-state-error-primary); }
.dsh-sync-success { color: var(--dsw-alias-state-success-primary); }
.dsh-sync-warn { color: var(--dsw-alias-state-warn-primary); }
.dsh-sync-note { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-sync-list { margin: 6px 0 0; padding-left: 18px; }
.dsh-sync-details { margin-top: 10px; }
.dsh-sync-details summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.dsh-sync-pre {
  margin: 8px 0 0;
  padding: 10px;
  max-width: 100%;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
`;

    /* ------------------------------- registration ---------------------------- */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.get('locale');
        if (locale !== undefined) {
          localeService = locale;
          // The active language is read from the locale service, so the page
          // follows the Language setting without a reload.
          ctx.effect(() => {
            const readLanguage = () => {
              const snapshot = locale.getSnapshot ? locale.getSnapshot() : undefined;
              const active = snapshot === undefined ? undefined : snapshot.active;
              if (typeof active === 'string' && active !== '') language = active;
            };
            readLanguage();
            return locale.subscribe(readLanguage);
          }, 'dsh-sync: language');
          // The shared catalog owns this namespace's texts; the page reads the
          // active language from the same service.
          try {
            ctx.effect(() => locale.register(NS, { zh, en }), 'dsh-sync: dictionaries');
          } catch {
            // Another owner already holds the namespace, or the deployment
            // ships other locales; the page still has its own copy.
          }
        }

        const slots = ctx.slots;
        const disposers = [];
        disposers.push(slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: PANEL_ORDER,
          // The shell reads this on every projection, so the label follows the
          // active language without re-registering.
          label: () => t('nav.label'),
        }, SyncPanelIcon)));
        disposers.push(slots.inject('main', () => slots.register({
          name: 'main',
          key: PANEL_ID,
        }, SyncPanelPage)));

        return () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose();
            } catch {
              // the slot layer may already have torn the registration down
            }
          }
        };
      },
    };
  },
});

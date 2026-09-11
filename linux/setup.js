#!/usr/bin/env node
/**
 * Claude Desktop (Linux) - 3P 配置 / HTTP 补丁 / 全功能补丁
 *
 * 与 Windows 版三种方案一一对应：
 *   config      方案 1：只写配置，不改文件（HTTPS 端点，或 127.0.0.1/localhost 的 HTTP 端点）
 *   http-patch  方案 2：在方案 1 基础上给 app.asar 打补丁，允许任意 HTTP 端点
 *   full-patch  方案 3：官方登录模式下的功能解锁补丁（实验性）
 *
 * Linux 版 Claude Desktop 的 3P 配置来源：
 *   系统级  /etc/claude-desktop/managed-settings.json     （root 所有，优先级最高）
 *   用户级  ~/.config/Claude-3p/configLibrary/<id>.json     （由 _meta.json 的 appliedId 指定）
 * 键名是扁平的（inferenceProvider / inferenceGatewayBaseUrl / ...），默认写用户级，无需 root。
 *
 * 用法：
 *   node setup.js config      [--from-cli | --url URL --key KEY] [--models a,b] [--system]
 *   node setup.js http-patch  [--from-cli | --url URL --key KEY] [--models a,b] [--in-place] [--system]
 *   node setup.js full-patch  [--in-place] [--all-flags]
 *   node setup.js status
 *   node setup.js launch
 *   node setup.js uninstall   [--system]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { execSync, execFileSync, spawn } = require('child_process');

// ============ 路径 ============
const HERE = __dirname;
const PORTABLE_DIR = path.join(HERE, 'claude-portable');
const LAUNCHER = path.join(HERE, 'launch.sh');
const TMP = path.join(HERE, '_patch_tmp');
const HOME = os.homedir();
const XDG_CONFIG = process.env.XDG_CONFIG_HOME || path.join(HOME, '.config');
const CLI_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const LOCAL_CONFIG_DIR = path.join(XDG_CONFIG, 'Claude-3p', 'configLibrary');
const LOCAL_META = path.join(LOCAL_CONFIG_DIR, '_meta.json');
const SYSTEM_DIR = '/etc/claude-desktop';
const SYSTEM_FILE = path.join(SYSTEM_DIR, 'managed-settings.json');
const ENTRY_NAME = 'claude-app-patch';

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('-') ? args.shift() : null;
const flag = f => args.includes(f);
const argVal = f => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };

// ============ 输出 ============
const C = { r: '\x1b[0m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', e: '\x1b[31m' };
const ok = m => console.log(`${C.g}  [+] ${m}${C.r}`);
const inf = m => console.log(`${C.c}  [i] ${m}${C.r}`);
const err = m => console.log(`${C.e}  [x] ${m}${C.r}`);
const wrn = m => console.log(`${C.y}  [!] ${m}${C.r}`);
const hdr = m => console.log(`${C.c}\n${m}${C.r}`);

function maskKey(k) {
    if (!k) return '(none)';
    return k.length > 12 ? k.slice(0, 8) + '...' + k.slice(-4) : '***';
}

function ask(q) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()); }));
}

function sh(command, opts = {}) {
    return execSync(command, { stdio: 'pipe', encoding: 'utf-8', ...opts });
}

// ============ 读取 CLI 配置 ============
function readCli() {
    if (!fs.existsSync(CLI_SETTINGS)) return null;
    try {
        const j = JSON.parse(fs.readFileSync(CLI_SETTINGS, 'utf-8'));
        const e = j.env || {};
        const token = e.ANTHROPIC_AUTH_TOKEN || null;
        const apiKey = e.ANTHROPIC_API_KEY || e.API_KEY || null;
        return {
            url: e.ANTHROPIC_BASE_URL || null,
            key: token || apiKey,
            // ANTHROPIC_AUTH_TOKEN 对应 Authorization: Bearer，ANTHROPIC_API_KEY 对应 x-api-key
            authScheme: token ? 'bearer' : (apiKey ? 'x-api-key' : 'bearer'),
            model: e.ANTHROPIC_MODEL || null,
        };
    } catch { return null; }
}

// ============ 查找官方安装 ============
const BIN_NAMES = ['claude-desktop', 'claude', 'Claude'];

function findInstallDir() {
    const candidates = [];
    for (const b of BIN_NAMES) {
        try {
            const p = sh(`command -v ${b}`).trim();
            if (p) candidates.push(path.dirname(fs.realpathSync(p)));
        } catch {}
    }
    candidates.push(
        '/usr/lib/claude-desktop', '/usr/lib64/claude-desktop', '/usr/share/claude-desktop',
        '/opt/Claude', '/opt/claude-desktop', '/opt/claude',
        path.join(HOME, '.local', 'lib', 'claude-desktop'),
        path.join(HOME, '.local', 'share', 'claude-desktop'),
    );
    // flatpak
    for (const base of ['/var/lib/flatpak/app', path.join(HOME, '.local/share/flatpak/app')]) {
        try {
            for (const app of fs.readdirSync(base)) {
                if (!/claude/i.test(app)) continue;
                const files = path.join(base, app, 'current', 'active', 'files');
                for (const sub of ['claude-desktop', 'Claude', 'lib/claude-desktop', 'extra']) candidates.push(path.join(files, sub));
            }
        } catch {}
    }
    for (const d of candidates) {
        if (!d.includes('claude-portable') && fs.existsSync(path.join(d, 'resources', 'app.asar'))) return d;
    }
    return null;
}

function findBinary(dir) {
    for (const b of BIN_NAMES) {
        const p = path.join(dir, b);
        try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
    return null;
}

const OFFICIAL_DIR = findInstallDir();
const OFFICIAL_ASAR = OFFICIAL_DIR ? path.join(OFFICIAL_DIR, 'resources', 'app.asar') : null;
const OFFICIAL_BIN = OFFICIAL_DIR ? findBinary(OFFICIAL_DIR) : null;

// ============ asar ============
let asarMod = null;
function asar() {
    if (asarMod) return asarMod;
    try { asarMod = require('@electron/asar'); return asarMod; } catch {}
    inf('Installing @electron/asar (first run only)...');
    sh('npm install --no-audit --no-fund --loglevel=error', { cwd: HERE, stdio: 'inherit' });
    asarMod = require('@electron/asar');
    return asarMod;
}

function readAppVersion(asarPath) {
    try {
        const pkg = JSON.parse(asar().extractFile(asarPath, 'package.json').toString('utf-8'));
        return pkg.version || '?';
    } catch { return '?'; }
}

// 原始 app.asar.unpacked 里有哪些目录（重新打包时要保持一致，否则原生模块加载不到）
function unpackedDirs(asarPath) {
    const root = asarPath + '.unpacked';
    const dirs = new Set();
    const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else dirs.add(path.relative(root, path.dirname(p)));
        }
    };
    try { walk(root); } catch {}
    return [...dirs];
}

// ============ 补丁引擎 ============
// patch: { name, file: 文件名 | RegExp | '*'(所有 .vite/build/*.js), find: string | RegExp, replace, required? }
function applyPatches(extractDir, patches) {
    const buildDir = path.join(extractDir, '.vite', 'build');
    const jsFiles = fs.readdirSync(buildDir).filter(f => f.endsWith('.js'));
    const cache = new Map();
    const read = f => { if (!cache.has(f)) cache.set(f, fs.readFileSync(path.join(buildDir, f), 'utf-8')); return cache.get(f); };
    const dirty = new Set();
    let applied = 0;

    for (const p of patches) {
        const targets = p.file === '*' ? jsFiles
            : p.file instanceof RegExp ? jsFiles.filter(f => p.file.test(f))
            : [p.file];
        let hits = 0;
        for (const f of targets) {
            if (!fs.existsSync(path.join(buildDir, f))) continue;
            let code = read(f);
            let next;
            if (p.find instanceof RegExp) {
                const re = new RegExp(p.find.source, p.find.flags.includes('g') ? p.find.flags : p.find.flags + 'g');
                let n = 0;
                next = code.replace(re, (...m) => { n++; return typeof p.replace === 'function' ? p.replace(...m) : m[0].replace(p.find, p.replace); });
                if (n) hits += n;
            } else if (code.includes(p.find)) {
                const n = code.split(p.find).length - 1;
                next = code.split(p.find).join(p.replace);
                hits += n;
            }
            if (next !== undefined && next !== code) { cache.set(f, next); dirty.add(f); }
        }
        if (p.append) {
            const f = p.file;
            cache.set(f, read(f) + '\n' + p.append + '\n');
            dirty.add(f);
            hits = 1;
        }
        if (hits) { ok(`${p.name} (${hits})`); applied++; }
        else (p.required ? err : wrn)(`MISS: ${p.name}`);
    }
    for (const f of dirty) fs.writeFileSync(path.join(buildDir, f), cache.get(f), 'utf-8');
    inf(`Patches: ${applied}/${patches.length} applied`);
    return applied;
}

// ============ 补丁定义 ============
// 方案 2：去掉 “HTTP 只允许 loopback” 的限制。
// 原文（index.pre.js 与主 chunk 各一份）：
//   n==="http:"&&(!!e.allowHttp||!!e.allowLoopbackHttp&&Go.has(r))
const HTTP_PATCHES = [
    {
        name: 'Allow HTTP endpoints (remove loopback-only restriction)',
        file: '*',
        find: /n==="http:"&&\(!!e\.allowHttp\|\|!!e\.allowLoopbackHttp&&[\w$]+\.has\(r\)\)/g,
        replace: () => 'n==="http:"',
        required: true,
    },
];

// 方案 3（实验性）：登录模式下的功能解锁。锚点用正则写，尽量跨版本。
function fullPatches({ allFlags }) {
    const cliEnvReader = `(function(){var _log=function(m){try{var _e=require("electron"),_fs=require("fs"),_p=require("path");var d=_p.join(_e.app.getPath("userData"),"logs");_fs.mkdirSync(d,{recursive:true});_fs.appendFileSync(_p.join(d,"patch.log"),new Date().toISOString()+" "+m+"\\n")}catch(e){}};try{var _fs=require("fs"),_p=require("path"),_h=process.env.HOME||"";var _f=_p.join(_h,".claude","settings.json");if(_fs.existsSync(_f)){var _c=JSON.parse(_fs.readFileSync(_f,"utf-8"));if(_c&&_c.env){_log("CLI env injected into Claude Code session: "+Object.keys(_c.env).join(", "));return _c.env}}}catch(_e){_log("read CLI settings failed: "+_e)}return{}})()`;

    // 渲染进程里的 bootstrap 能力注入（沿用 Windows 版思路）：拦截 /api/bootstrap，把 seat_tier 改成 max 并补齐 capabilities
    const rendererHook = `(function(){try{if(window.__bsPatchInstalled)return"dup";window.__bsPatchInstalled=true;function fix(d){if(d&&d.account&&d.account.memberships){d.account.memberships.forEach(function(m){m.seat_tier="max";if(m.organization){var c=m.organization.capabilities||[];c=c.filter(function(x){return x!=="claude_pro"});["claude_max","code","cowork","operon","computer_use"].forEach(function(x){if(c.indexOf(x)===-1)c.push(x)});m.organization.capabilities=c;m.organization.billing_type="stripe_subscription"}})}return d}var _orig=window.fetch;window.fetch=function(){var a=Array.prototype.slice.call(arguments);var u=typeof a[0]==="string"?a[0]:(a[0]&&a[0].url?a[0].url:"");if(u.indexOf("/api/bootstrap")!==-1&&u.indexOf("/system_prompts")===-1){return _orig.apply(this,a).then(function(r){if(!r.ok)return r;return r.clone().text().then(function(t){try{return new Response(JSON.stringify(fix(JSON.parse(t))),{status:r.status,statusText:r.statusText,headers:{"content-type":"application/json"}})}catch(e){return r}})})}return _orig.apply(this,a)};function getQC(){var root=document.getElementById("root");if(!root)return null;var ck=Object.keys(root).find(function(k){return k.startsWith("__reactContainer")});if(!ck)return null;var qc=null;(function find(f,d){if(!f||d>50||qc)return;if(f.memoizedProps&&f.memoizedProps.client&&typeof f.memoizedProps.client.invalidateQueries==="function"){qc=f.memoizedProps.client;return}find(f.child,d+1);if(!qc)find(f.sibling,d)})(root[ck],0);return qc}var tries=0;(function retry(){var qc=getQC();if(qc){qc.getQueryCache().getAll().forEach(function(q){if(q.queryKey&&q.queryKey[0]==="current_account"&&q.state.data){qc.setQueryData(q.queryKey,fix(JSON.parse(JSON.stringify(q.state.data))))}});qc.invalidateQueries({queryKey:["current_account"]})}else if(++tries<8)setTimeout(retry,1500)})();return"ok"}catch(e){return"err:"+e.message}})()`;

    const mainHook = `;(function(){try{var _el=require("electron"),_app=_el.app,_fs=require("fs"),_path=require("path");function plog(m){try{var d=_path.join(_app.getPath("userData"),"logs");_fs.mkdirSync(d,{recursive:true});_fs.appendFileSync(_path.join(d,"patch.log"),new Date().toISOString()+" "+m+"\\n")}catch(e){}}var HOOK=${JSON.stringify(rendererHook)};_app.on("web-contents-created",function(_e,wc){wc.on("did-finish-load",function(){try{var u=wc.getURL()||"";if(!/^https:\\/\\/([a-z0-9-]+\\.)*claude\\.ai\\//.test(u))return;wc.executeJavaScript(HOOK).then(function(r){plog("bootstrap hook on "+u+": "+r)}).catch(function(e){plog("bootstrap hook failed: "+e)})}catch(e){}});wc.on("before-input-event",function(ev,input){if(input.type!=="keyDown")return;if(input.key==="F12"||(input.control&&input.shift&&String(input.key).toLowerCase()==="i")){try{wc.toggleDevTools()}catch(e){}}})});plog("main hooks registered (app "+_app.getVersion()+")")}catch(e){try{require("fs").appendFileSync("/tmp/claude-patch-error.log",String(e)+"\\n")}catch(_){}}})();`;

    const patches = [
        {
            // 原文: function Vz(e){return o.app.isPackaged?{status:"unavailable"}:e()}
            name: 'Unlock dev-only features (bypass isPackaged gate)',
            file: '*',
            find: /function ([\w$]+)\(e\)\{return [\w$]+\.app\.isPackaged\?\{status:"unavailable"\}:e\(\)\}/g,
            replace: (_m, fn) => `function ${fn}(e){return e()}`,
        },
        {
            name: 'Default sidebarMode -> "code"',
            file: '*',
            find: 'sidebarMode:"chat",',
            replace: 'sidebarMode:"code",',
        },
        {
            // 原文: ...DISABLE_MICROCOMPACT:"1",NODE_USE_SYSTEM_CA:"1"},hostAuthoredEnvKeys:o}
            // Claude Code 子进程的 sessionEnv 末尾追加 ~/.claude/settings.json 的 env，走自己的端点
            name: 'Inject ~/.claude/settings.json env into Claude Code session env',
            file: '*',
            find: /DISABLE_MICROCOMPACT:"1",NODE_USE_SYSTEM_CA:"1"\},hostAuthoredEnvKeys:([\w$]+)\}/g,
            replace: (_m, v) => `DISABLE_MICROCOMPACT:"1",NODE_USE_SYSTEM_CA:"1",...${cliEnvReader}},hostAuthoredEnvKeys:${v}}`,
        },
        {
            // 原文: p&&T.push("--model",p)  —— 不强制指定模型，交给 CLI 自己的 settings.json
            name: 'Drop --model CLI arg (let CLI settings decide)',
            file: '*',
            find: /([\w$]+)&&([\w$]+)\.push\("--model",\1\)/g,
            replace: () => 'void 0',
        },
        {
            name: 'Bootstrap capability injection + DevTools (F12 / Ctrl+Shift+I)',
            file: 'index.pre.js',
            append: mainHook,
        },
    ];
    if (allFlags) {
        patches.push({
            // 原文: function Jx(e){if(Cyt.has(e))return!0;let t=jx[e];return Kx(e,t),t?.on??!1}
            name: 'Force all GrowthBook feature flags ON',
            file: '*',
            find: /function ([\w$]+)\(e\)\{if\([\w$]+\.has\(e\)\)return!0;let t=[\w$]+\[e\];return [\w$]+\(e,t\),t\?\.on\?\?!1\}/g,
            replace: (_m, fn) => `function ${fn}(e){return!0}`,
        });
    }
    return patches;
}

// ============ 构建：便携副本 或 原地替换 ============
function buildPatched(patches, { inPlace }) {
    if (!OFFICIAL_DIR || !OFFICIAL_BIN) { err('Official Claude Desktop not found (looked for resources/app.asar next to the binary)'); return false; }
    inf(`Official: ${OFFICIAL_DIR} (v${readAppVersion(OFFICIAL_ASAR)})`);

    // 原始 asar：原地模式下优先用备份，保证可重复打补丁
    let srcAsar = OFFICIAL_ASAR;
    const backup = OFFICIAL_ASAR + '.orig';
    if (inPlace && fs.existsSync(backup)) srcAsar = backup;

    inf('Extracting app.asar...');
    fs.rmSync(TMP, { recursive: true, force: true });
    asar().extractAll(srcAsar, TMP);

    const applied = applyPatches(TMP, patches);
    if (!applied) { err('No patch applied — app version probably changed'); fs.rmSync(TMP, { recursive: true, force: true }); return false; }

    const outAsar = path.join(HERE, '_patched.asar');
    fs.rmSync(outAsar, { force: true });
    fs.rmSync(outAsar + '.unpacked', { recursive: true, force: true });
    const dirs = unpackedDirs(srcAsar.endsWith('.orig') ? OFFICIAL_ASAR : srcAsar);
    const unpackDir = dirs.length > 1 ? `{${dirs.join(',')}}` : dirs[0];
    inf('Repacking app.asar...');
    return asar().createPackageWithOptions(TMP, outAsar, unpackDir ? { unpackDir } : {}).then(() => {
        fs.rmSync(TMP, { recursive: true, force: true });

        let targetDir;
        if (inPlace) {
            targetDir = OFFICIAL_DIR;
            inf('Installing in place (sudo)...');
            const cmds = [];
            if (!fs.existsSync(backup)) cmds.push(`cp -a "${OFFICIAL_ASAR}" "${backup}"`);
            cmds.push(`install -m 644 "${outAsar}" "${OFFICIAL_ASAR}"`);
            cmds.push(`rm -rf "${OFFICIAL_ASAR}.unpacked" && cp -a "${outAsar}.unpacked" "${OFFICIAL_ASAR}.unpacked" && chown -R root:root "${OFFICIAL_ASAR}.unpacked"`);
            execFileSync('sudo', ['sh', '-c', cmds.join(' && ')], { stdio: 'inherit' });
            ok(`Patched in place, backup: ${backup}`);
        } else {
            targetDir = PORTABLE_DIR;
            inf('Copying official Claude to portable dir (this may take a moment)...');
            fs.rmSync(PORTABLE_DIR, { recursive: true, force: true });
            sh(`cp -a "${OFFICIAL_DIR}" "${PORTABLE_DIR}"`);
            const dst = path.join(PORTABLE_DIR, 'resources', 'app.asar');
            fs.copyFileSync(outAsar, dst);
            fs.rmSync(dst + '.unpacked', { recursive: true, force: true });
            sh(`cp -a "${outAsar}.unpacked" "${dst}.unpacked"`);
            writeLauncher();
            ok(`Portable build: ${PORTABLE_DIR}`);
        }
        fs.rmSync(outAsar, { force: true });
        fs.rmSync(outAsar + '.unpacked', { recursive: true, force: true });

        // 验证
        const live = path.join(targetDir, 'resources', 'app.asar');
        const check = patches.find(p => p.required) || patches[0];
        if (check && check.find && !check.append) {
            const vdir = path.join(HERE, '_verify_tmp');
            fs.rmSync(vdir, { recursive: true, force: true });
            asar().extractAll(live, vdir);
            const build = path.join(vdir, '.vite', 'build');
            const still = fs.readdirSync(build).filter(f => f.endsWith('.js')).some(f => {
                const c = fs.readFileSync(path.join(build, f), 'utf-8');
                return check.find instanceof RegExp ? new RegExp(check.find.source).test(c) : c.includes(check.find);
            });
            fs.rmSync(vdir, { recursive: true, force: true });
            if (still) { err('Verification failed: original code still present'); return false; }
            ok('Verified');
        }
        return true;
    });
}

function writeLauncher() {
    const bin = path.basename(OFFICIAL_BIN);
    fs.writeFileSync(LAUNCHER, `#!/bin/sh
# Claude Desktop (patched portable) launcher
DIR="$(cd "$(dirname "$0")" && pwd)/claude-portable"
EXTRA=""
# 便携副本里的 chrome-sandbox 不再是 root 所有的 setuid 文件；
# 若内核禁止非特权 user namespace，Chromium 就无法建立沙箱，只能 --no-sandbox
if [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" = "0" ] \\
   || [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ] \\
   || [ -n "$CLAUDE_NO_SANDBOX" ]; then
  EXTRA="--no-sandbox"
fi
exec "$DIR/${bin}" $EXTRA "$@"
`, { mode: 0o755 });
    ok(`Launcher: ${LAUNCHER}`);
}

// ============ 3P 配置 ============
function buildConfig({ url, key, authScheme, models, telemetryOnly }) {
    const cfg = {};
    if (!telemetryOnly) {
        cfg.inferenceProvider = 'gateway';
        cfg.inferenceGatewayBaseUrl = url;
        cfg.inferenceCredentialKind = 'static';
        cfg.inferenceGatewayApiKey = key;
        cfg.inferenceGatewayAuthScheme = authScheme || 'bearer';
        if (models && models.length) cfg.inferenceModels = models;
    }
    cfg.disableEssentialTelemetry = true;
    cfg.disableNonessentialTelemetry = true;
    cfg.disableAutoUpdates = true;
    return cfg;
}

function parseModels(v) {
    if (!v) return null;
    const s = v.trim();
    if (s.startsWith('[')) {
        // 兼容 Windows 版的 [{"id":..,"name":..}] 写法
        return JSON.parse(s).map(m => typeof m === 'string' ? m : (m.name && m.id && m.name !== m.id ? { name: m.id, labelOverride: m.name } : (m.id || m.name)));
    }
    return s.split(',').map(x => x.trim()).filter(Boolean);
}

function isLoopbackUrl(url) {
    try { const h = new URL(url).hostname; return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(h) || h.endsWith('.localhost'); } catch { return false; }
}

function readMeta() {
    try { return JSON.parse(fs.readFileSync(LOCAL_META, 'utf-8')); } catch { return null; }
}

function writeLocalConfig(cfg) {
    fs.mkdirSync(LOCAL_CONFIG_DIR, { recursive: true, mode: 0o700 });
    const meta = readMeta() || { appliedId: '', entries: [] };
    if (!Array.isArray(meta.entries)) meta.entries = [];
    let entry = meta.entries.find(e => e && e.name === ENTRY_NAME);
    if (!entry) { entry = { id: crypto.randomUUID(), name: ENTRY_NAME, provider: 'gateway' }; meta.entries.push(entry); }
    meta.appliedId = entry.id;
    const file = path.join(LOCAL_CONFIG_DIR, `${entry.id}.json`);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(LOCAL_META, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
    ok(`Local config: ${file}`);
    if (fs.existsSync(SYSTEM_FILE)) wrn(`${SYSTEM_FILE} exists and takes precedence over local config!`);
}

function writeSystemConfig(cfg) {
    const tmp = path.join(os.tmpdir(), `claude-managed-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    inf('Writing system managed config (sudo)...');
    try {
        // 应用要求：目录与文件均 root 所有、非 group/world 可写、非符号链接
        execFileSync('sudo', ['sh', '-c',
            `install -d -m 755 -o root -g root "${SYSTEM_DIR}" && install -m 644 -o root -g root "${tmp}" "${SYSTEM_FILE}"`
        ], { stdio: 'inherit' });
        ok(`System config: ${SYSTEM_FILE}`);
    } finally { fs.rmSync(tmp, { force: true }); }
}

function writeConfig(opts, system) {
    const cfg = buildConfig(opts);
    if (system) writeSystemConfig(cfg); else writeLocalConfig(cfg);
    if (!opts.telemetryOnly) {
        ok(`inferenceProvider = gateway`);
        ok(`inferenceGatewayBaseUrl = ${opts.url}`);
        ok(`inferenceGatewayApiKey = ${maskKey(opts.key)} (${opts.authScheme})`);
        if (opts.models && opts.models.length) ok(`inferenceModels = ${JSON.stringify(opts.models)}`);
    }
    ok('Telemetry + auto-update disabled');
}

function removeConfig(system) {
    if (system) {
        if (fs.existsSync(SYSTEM_FILE)) {
            execFileSync('sudo', ['rm', '-f', SYSTEM_FILE], { stdio: 'inherit' });
            ok(`Removed ${SYSTEM_FILE}`);
        } else inf('No system config');
        return;
    }
    const meta = readMeta();
    if (!meta) { inf('No local config'); return; }
    const mine = (meta.entries || []).filter(e => e && e.name === ENTRY_NAME);
    for (const e of mine) fs.rmSync(path.join(LOCAL_CONFIG_DIR, `${e.id}.json`), { force: true });
    meta.entries = (meta.entries || []).filter(e => !(e && e.name === ENTRY_NAME));
    if (mine.some(e => e.id === meta.appliedId)) meta.appliedId = meta.entries[0] ? meta.entries[0].id : '';
    if (meta.entries.length) fs.writeFileSync(LOCAL_META, JSON.stringify(meta, null, 2) + '\n');
    else fs.rmSync(LOCAL_META, { force: true });
    ok('Local config removed');
}

// ============ 进程 ============
function killDesktop() {
    // 只杀桌面端（官方目录或便携目录里的二进制），不碰 Claude Code CLI
    try {
        const out = sh(`pgrep -af '(^|/)(claude-desktop|Claude)( |$)' || true`);
        let killed = 0;
        for (const line of out.split('\n')) {
            const m = line.match(/^(\d+)\s+(\S+)/);
            if (!m) continue;
            const [, pid, exe] = m;
            if (OFFICIAL_DIR && exe.startsWith(OFFICIAL_DIR) || exe.includes('claude-portable') || exe.endsWith('/claude-desktop') || exe === 'claude-desktop') {
                try { process.kill(+pid, 'SIGTERM'); killed++; } catch {}
            }
        }
        if (killed) { ok(`Stopped ${killed} Desktop process(es)`); sh('sleep 2'); }
        else inf('No Desktop processes found');
    } catch { inf('Could not enumerate processes'); }
}

function launch(portable) {
    const exe = portable ? LAUNCHER : OFFICIAL_BIN;
    if (!exe || !fs.existsSync(exe)) { wrn('Launcher not found, please start Claude manually'); return; }
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.unref();
    ok(`Launched: ${exe}`);
}

// ============ 状态 ============
function showStatus() {
    hdr('===== Claude Desktop (Linux) =====');
    if (OFFICIAL_DIR) inf(`Official: ${OFFICIAL_DIR} (v${readAppVersion(OFFICIAL_ASAR)})`);
    else err('Official Claude Desktop not found');
    if (OFFICIAL_ASAR && fs.existsSync(OFFICIAL_ASAR + '.orig')) ok('In-place patch: applied (backup app.asar.orig present)');
    if (fs.existsSync(PORTABLE_DIR)) ok(`Portable: ${PORTABLE_DIR} (v${readAppVersion(path.join(PORTABLE_DIR, 'resources', 'app.asar'))})`);
    else inf('Portable: not built');

    hdr('===== 3P Config =====');
    if (fs.existsSync(SYSTEM_FILE)) {
        try {
            const j = JSON.parse(fs.readFileSync(SYSTEM_FILE, 'utf-8'));
            ok(`${SYSTEM_FILE} (takes precedence)`);
            for (const [k, v] of Object.entries(j)) console.log(`    ${k} = ${/apikey/i.test(k) ? maskKey(String(v)) : JSON.stringify(v)}`);
        } catch { wrn(`${SYSTEM_FILE} exists but unreadable`); }
    } else inf('System config: none');
    const meta = readMeta();
    if (meta && meta.appliedId) {
        const entry = (meta.entries || []).find(e => e.id === meta.appliedId);
        const file = path.join(LOCAL_CONFIG_DIR, `${meta.appliedId}.json`);
        try {
            const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
            ok(`Local config applied: ${entry ? entry.name : meta.appliedId}`);
            for (const [k, v] of Object.entries(j)) console.log(`    ${k} = ${/apikey/i.test(k) ? maskKey(String(v)) : JSON.stringify(v)}`);
        } catch { wrn(`Local config ${file} unreadable`); }
    } else inf('Local config: none');

    const cli = readCli();
    if (cli) {
        hdr('===== CLI Config (~/.claude/settings.json) =====');
        inf(`URL=${cli.url}  Key=${maskKey(cli.key)} (${cli.authScheme})  Model=${cli.model}`);
    }
    const log = path.join(XDG_CONFIG, 'Claude-3p', 'logs', 'main.log');
    if (fs.existsSync(log)) inf(`3P log: ${log}`);
    console.log('');
}

// ============ 参数解析 ============
async function resolveEndpoint({ interactive, allowHttp }) {
    let url = argVal('--url'), key = argVal('--key'), authScheme = argVal('--auth') || null;
    let models = parseModels(argVal('--models'));
    const cli = readCli();

    if (!url && (flag('--from-cli') || !interactive)) {
        if (!cli || !cli.url) { err('CLI config not found in ~/.claude/settings.json'); return null; }
        url = cli.url; key = cli.key; authScheme = authScheme || cli.authScheme;
        if (!models && cli.model) models = [cli.model];
    }
    if (!url && interactive) {
        if (cli && cli.url) {
            ok(`CLI config: ${cli.url} | ${maskKey(cli.key)} | ${cli.model || '(auto model discovery)'}`);
            const ch = await ask('  Reuse? [Y/n] ');
            if (ch === '' || /^[Yy]/.test(ch)) {
                url = cli.url; key = cli.key; authScheme = authScheme || cli.authScheme;
                if (!models && cli.model) models = [cli.model];
            }
        }
        if (!url) {
            url = await ask(`  Base URL (${allowHttp ? 'HTTP or HTTPS' : 'HTTPS, or HTTP on localhost'}): `);
            if (!url) { err('Cancelled'); return null; }
            key = await ask('  API Key: ');
            if (!key) { err('Cancelled'); return null; }
            const m = await ask('  Models (comma separated, enter to auto-discover): ');
            models = parseModels(m);
            authScheme = authScheme || 'bearer';
        }
    }
    if (!url || !key) { err('--url and --key are required'); return null; }
    url = url.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(url)) { err(`URL must start with http:// or https://: ${url}`); return null; }
    if (!allowHttp && url.startsWith('http://') && !isLoopbackUrl(url)) {
        err(`Plain HTTP is only allowed for 127.0.0.1/localhost without patching: ${url}`);
        wrn('Use "http-patch" (方案 2) for remote HTTP endpoints.');
        return null;
    }
    return { url, key, authScheme: authScheme || 'bearer', models };
}

function help() {
    console.log(`
  Claude Desktop (Linux) 3P setup
  ================================
  node setup.js config      [--from-cli | --url URL --key KEY] [--auth bearer|x-api-key] [--models a,b] [--system]
                            方案 1：仅写配置（默认用户级 ~/.config/Claude-3p/configLibrary，--system 写 /etc/claude-desktop）
  node setup.js http-patch  [同上] [--in-place]
                            方案 2：打补丁允许任意 HTTP 端点（默认生成 claude-portable/ 便携副本，--in-place 用 sudo 原地替换）
  node setup.js full-patch  [--in-place] [--all-flags]
                            方案 3（实验性）：官方登录模式下解锁开发特性、注入 CLI env、F12 DevTools
  node setup.js status      查看状态
  node setup.js launch      启动（优先便携副本）
  node setup.js uninstall   [--system] 移除配置、便携副本、原地补丁
`);
}

// ============ 主流程 ============
async function main() {
    const interactive = !flag('--from-cli') && !argVal('--url') && process.stdin.isTTY;
    const system = flag('--system');
    const inPlace = flag('--in-place');

    switch (cmd) {
        case 'status': return showStatus();
        case 'launch': return launch(fs.existsSync(LAUNCHER) && fs.existsSync(PORTABLE_DIR));
        case 'uninstall': {
            killDesktop();
            removeConfig(system);
            if (fs.existsSync(PORTABLE_DIR)) { fs.rmSync(PORTABLE_DIR, { recursive: true, force: true }); ok('Portable dir removed'); }
            fs.rmSync(LAUNCHER, { force: true });
            if (OFFICIAL_ASAR && fs.existsSync(OFFICIAL_ASAR + '.orig')) {
                inf('Restoring original app.asar (sudo)...');
                execFileSync('sudo', ['sh', '-c', `mv -f "${OFFICIAL_ASAR}.orig" "${OFFICIAL_ASAR}"`], { stdio: 'inherit' });
                wrn('app.asar.unpacked was rebuilt from the same files; reinstall the package if anything looks off');
                ok('In-place patch reverted');
            }
            ok('Uninstall complete');
            return;
        }
        case 'config': {
            hdr('===== 方案 1: 3P config (no patch) =====');
            const ep = await resolveEndpoint({ interactive, allowHttp: false });
            if (!ep) process.exit(1);
            writeConfig(ep, system);
            killDesktop();
            if (fs.existsSync(PORTABLE_DIR)) inf('Portable build exists; the config applies to it too');
            launch(false);
            console.log(`\n${C.g}  Done! Claude Desktop starts in 3P mode (no login).${C.r}\n`);
            return;
        }
        case 'http-patch': {
            hdr('===== 方案 2: HTTP patch =====');
            const ep = await resolveEndpoint({ interactive, allowHttp: true });
            if (!ep) process.exit(1);
            if (!ep.url.startsWith('http://') || isLoopbackUrl(ep.url)) inf('This endpoint would also work without patching (方案 1); patching anyway for consistency');
            killDesktop();
            if (!await buildPatched(HTTP_PATCHES, { inPlace })) { err('Patch failed'); process.exit(1); }
            writeConfig(ep, system);
            launch(!inPlace);
            console.log(`\n${C.g}  Done!${C.r} ${inPlace ? '' : `${C.c}Next time: ./launch.sh${C.r}`}\n`);
            return;
        }
        case 'full-patch': {
            hdr('===== 方案 3: Full patch (experimental, requires login) =====');
            const cli = readCli();
            if (cli && cli.url) ok(`CLI env will be injected into Claude Code sessions: ${cli.url} | ${maskKey(cli.key)}`);
            else wrn('No ~/.claude/settings.json env found; Claude Code sessions will use the official endpoint');
            if (fs.existsSync(SYSTEM_FILE) || (readMeta() || {}).appliedId) wrn('A 3P config is present; remove it (uninstall) if you want the official login mode');
            killDesktop();
            if (!await buildPatched(fullPatches({ allFlags: flag('--all-flags') }), { inPlace })) { err('Patch failed'); process.exit(1); }
            // 只写应用行为类键（遥测/更新），不会触发 3P 模式
            writeConfig({ telemetryOnly: true }, system);
            launch(!inPlace);
            console.log(`\n${C.g}  Done!${C.r} ${inPlace ? '' : `${C.c}Next time: ./launch.sh${C.r}`}\n`);
            return;
        }
        default:
            help();
            if (cmd) process.exit(1);
    }
}

main().catch(e => { err(e.stack || e.message); process.exit(1); });

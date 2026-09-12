'use strict';
/**
 * 中文界面补丁 — 移植自 javaht/claude-desktop-zh-cn（scripts/patch_claude_zh_cn.py），
 * 适配 Linux 版 Claude Desktop 的目录结构：
 *
 *   resources/<lang>.json                   主进程（桌面壳层）翻译，主进程按 resources/ 下的 xx-XX.json 枚举可用语言
 *   resources/ion-dist/i18n/<lang>.json     前端 i18n（3P 模式下前端由 app://localhost 从 ion-dist 本地提供）
 *   resources/ion-dist/i18n/dynamic/<lang>.json   前端要求 base + dynamic 两份都存在
 *   resources/ion-dist/assets/v1/*.js       语言白名单加入 <lang>、Intl.DisplayNames 显示名、未走 i18n 的硬编码文本
 *   resources/claude-zh/                    运行时数据：dom-<lang>.js（claude.ai 在线页面 DOM 翻译）、menu-<lang>.json、default-lang
 *
 * app.asar 侧（见 asarPatches()）：模型选择器硬编码文本、DesktopIntl 语言锁定（仅远程 claude.ai 页面）、
 * 主进程 hook（菜单标签映射 + 在线页面 DOM 翻译注入）。
 *
 * 翻译资源（frontend-*.json / frontend-hardcoded-*.json / desktop-*.json）不随本仓库分发，
 * 默认从上游 GitHub 按 release tag 下载并缓存。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = 'javaht/claude-desktop-zh-cn';
const LANGS = ['zh-CN', 'zh-TW', 'zh-HK'];
const LABELS = { 'zh-CN': '简体中文', 'zh-TW': '繁体中文（中国台湾）', 'zh-HK': '繁体中文（中国香港）' };
const TABLES = require('./zh-tables.json');
const RUNTIME_DIR = 'claude-zh';

// ============ 翻译资源获取 ============
// 优先用 curl（遵守 http(s)_proxy 环境变量），没有 curl 时退回 Node 自带 fetch
let hasCurl = null;
async function fetchText(url) {
    if (hasCurl === null) { try { execFileSync('curl', ['--version'], { stdio: 'ignore' }); hasCurl = true; } catch { hasCurl = false; } }
    if (hasCurl) {
        return execFileSync('curl', ['-fsSL', '--retry', '3', '--retry-delay', '2', '-A', 'claude-app-patch', url], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    }
    const r = await fetch(url, { headers: { 'User-Agent': 'claude-app-patch' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return r.text();
}

async function latestTag() {
    try {
        const j = JSON.parse(await fetchText(`https://api.github.com/repos/${REPO}/releases/latest`));
        if (j.tag_name) return j.tag_name;
    } catch {}
    return 'master';
}

function resourceFiles(lang) {
    return [`frontend-${lang}.json`, `frontend-hardcoded-${lang}.json`, `desktop-${lang}.json`, 'release.json'];
}

// 返回包含 resources/ 文件的目录。dir：本地上游仓库 checkout（或其 resources/ 目录）；否则按 ref 下载到 cacheDir
async function resolveResources({ lang, dir, ref, cacheDir, log }) {
    if (dir) {
        const d = fs.existsSync(path.join(dir, 'resources')) ? path.join(dir, 'resources') : dir;
        for (const f of resourceFiles(lang).slice(0, 3)) {
            if (!fs.existsSync(path.join(d, f))) throw new Error(`Missing ${f} in ${d}`);
        }
        return d;
    }
    ref = ref || await latestTag();
    const out = path.join(cacheDir, ref);
    const missing = resourceFiles(lang).filter(f => !fs.existsSync(path.join(out, f)));
    if (missing.length) {
        fs.mkdirSync(out, { recursive: true });
        log(`Downloading ${REPO}@${ref} resources (${missing.join(', ')})...`);
        for (const f of missing) {
            const url = `https://raw.githubusercontent.com/${REPO}/${ref}/resources/${f}`;
            try {
                fs.writeFileSync(path.join(out, f), await fetchText(url));
            } catch (e) {
                if (f === 'release.json') continue;
                throw new Error(`Download failed: ${url}: ${e.message}`);
            }
        }
    }
    return out;
}

function loadPack(resDir, lang) {
    const read = f => JSON.parse(fs.readFileSync(path.join(resDir, f), 'utf-8'));
    const hardcoded = read(`frontend-hardcoded-${lang}.json`);
    if (!Array.isArray(hardcoded) || hardcoded.some(x => !Array.isArray(x) || x.length !== 2 || typeof x[0] !== 'string' || typeof x[1] !== 'string')) {
        throw new Error(`Unsupported frontend-hardcoded-${lang}.json shape`);
    }
    let release = '?';
    try { release = read('release.json').release || '?'; } catch {}
    return { frontend: read(`frontend-${lang}.json`), hardcoded, desktop: read(`desktop-${lang}.json`), release };
}

// ============ 前端（ion-dist）============
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 语言白名单：["en-US","de-DE",...] 数组加入 lang
function patchLanguageWhitelist(assetsDir, lang) {
    const re = /\["en-US"(?:,"[a-zA-Z]{2,3}-[A-Za-z0-9]{2,8}")+\]/g;
    let file = null, already = false;
    for (const f of fs.readdirSync(assetsDir).filter(f => f.endsWith('.js'))) {
        const p = path.join(assetsDir, f);
        const text = fs.readFileSync(p, 'utf-8');
        if (!text.includes('["en-US","de-DE"')) continue;
        let hit = false;
        const patched = text.replace(re, m => {
            if (!m.includes('"ja-JP"')) return m;
            hit = true;
            if (m.includes(`"${lang}"`)) { already = true; return m; }
            return m.slice(0, -1) + `,"${lang}"]`;
        });
        if (!hit) continue;
        if (patched !== text) fs.writeFileSync(p, patched);
        file = p;
        break;
    }
    if (!file) throw new Error('Could not find the frontend language whitelist; bundle format may have changed');
    return { file, already };
}

// Intl.DisplayNames：语言选择器里把 zh-* 显示为中文名称
function patchDisplayNames(file) {
    const marker = '__claudeZhLabelPatch';
    const text = fs.readFileSync(file, 'utf-8');
    if (text.includes(marker)) return false;
    const names = JSON.stringify(LABELS);
    const patch = `\n;(()=>{try{const e=Intl.DisplayNames&&Intl.DisplayNames.prototype;if(!e||e.${marker})return;const N=${names},n=e.of;e.of=function(e){const t=String(e);return N[t]||n.call(this,e)};Object.defineProperty(e,"${marker}",{value:!0})}catch{}})();\n`;
    fs.writeFileSync(file, text + patch);
    return true;
}

// 未走 i18n key 的硬编码文本（规则与守卫与上游一致）：
//   - 含引号/反斜杠/=/;/=>/换行的“代码型”规则：原样整串替换
//   - 纯文本规则：仅替换被引号包住的完整字面量，且跳过 name:/type:/icon: 等结构性上下文
const STRUCTURAL_JS_STRING = new Set(['hour', 'hours', 'minute', 'minutes', 'second', 'seconds', 'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years']);
const STRUCTURAL_JS_LITERAL = new Set(['"Search"']);
const STRUCTURAL_CTX_RE = /(?<![A-Za-z0-9_$-])(?:as|component|displayName|glyph|icon|iconName|leadingIcon|name|role|trailingIcon|type)\s*[:=]\s*$/;
const isPlainUiText = s => !s.includes('\n') && !['"', '\\', '=', ';', '=>'].some(m => s.includes(m));

function compileHardcoded(rules) {
    const plain = new Map(), literal = new Map();
    for (const [src, dst] of rules) {
        if (!src || src === dst || STRUCTURAL_JS_STRING.has(src) || STRUCTURAL_JS_LITERAL.has(src)) continue;
        (isPlainUiText(src) ? plain : literal).set(src, dst);
    }
    const alt = m => [...m.keys()].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
    return {
        plain, literal,
        plainRe: plain.size ? new RegExp(`(["'\`])(${alt(plain)})\\1`, 'g') : null,
        literalRe: literal.size ? new RegExp(alt(literal), 'g') : null,
    };
}

function patchHardcodedStrings(assetsDir, rules, log) {
    const c = compileHardcoded(rules);
    let files = 0, total = 0;
    for (const f of fs.readdirSync(assetsDir).filter(f => f.endsWith('.js'))) {
        const p = path.join(assetsDir, f);
        const text = fs.readFileSync(p, 'utf-8');
        let n = 0, out = text;
        if (c.literalRe) out = out.replace(c.literalRe, m => { const d = c.literal.get(m); if (d === undefined) return m; n++; return d; });
        if (c.plainRe) {
            const base = out;
            out = out.replace(c.plainRe, (m, q, src, off) => {
                if (STRUCTURAL_CTX_RE.test(base.slice(Math.max(0, off - 96), off))) return m;
                const d = c.plain.get(src); if (d === undefined) return m;
                n++; return q + d + q;
            });
        }
        if (n) { fs.writeFileSync(p, out); files++; total += n; }
    }
    log(`Hardcoded frontend strings: ${total} replacements in ${files} files (${c.plain.size + c.literal.size} rules)`);
    return total;
}

// i18n：以当前版本 en-US.json 的 key 为准合并，缺失的 key 保留英文
function mergeLocale(en, pack) {
    const out = {};
    let translated = 0;
    for (const [k, v] of Object.entries(en)) {
        if (Object.prototype.hasOwnProperty.call(pack, k)) { out[k] = pack[k]; if (pack[k] !== v) translated++; }
        else out[k] = v;
    }
    return { out, translated, fallback: Object.keys(en).length - translated };
}

function writeJson(p, obj) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function installFrontendLocale(i18nDir, lang, pack, log) {
    const en = JSON.parse(fs.readFileSync(path.join(i18nDir, 'en-US.json'), 'utf-8'));
    const m = mergeLocale(en, pack.frontend);
    writeJson(path.join(i18nDir, `${lang}.json`), m.out);
    log(`Frontend i18n ${lang}: ${m.translated} translated, ${m.fallback} fallback to English`);
    const dynEn = path.join(i18nDir, 'dynamic', 'en-US.json');
    if (fs.existsSync(dynEn)) {
        const d = mergeLocale(JSON.parse(fs.readFileSync(dynEn, 'utf-8')), pack.frontend);
        writeJson(path.join(i18nDir, 'dynamic', `${lang}.json`), d.out);
    }
    const statsigEn = path.join(i18nDir, 'statsig', 'en-US.json');
    if (fs.existsSync(statsigEn) && !fs.existsSync(path.join(i18nDir, 'statsig', `${lang}.json`))) {
        fs.copyFileSync(statsigEn, path.join(i18nDir, 'statsig', `${lang}.json`));
    }
    return en;
}

function installDesktopLocale(resDir, lang, pack, log) {
    const en = JSON.parse(fs.readFileSync(path.join(resDir, 'en-US.json'), 'utf-8'));
    const m = mergeLocale(en, pack.desktop);
    writeJson(path.join(resDir, `${lang}.json`), m.out);
    log(`Desktop shell i18n ${lang}: ${m.translated} translated, ${m.fallback} fallback to English`);
}

// claude.ai 在线页面 DOM 翻译表：i18n 英文原文 → 中文，加上硬编码规则
function buildDomMap(en, pack) {
    const ok = (s, t) => s && t && s !== t && s.length <= 1000 && !/[{\n]/.test(s) && !/[{\n]/.test(t);
    const map = {};
    for (const [k, src] of Object.entries(en)) {
        const dst = pack.frontend[k];
        if (typeof src === 'string' && typeof dst === 'string' && ok(src, dst)) map[src] = dst;
    }
    for (const [src, dst] of pack.hardcoded) if (ok(src, dst)) map[src] = dst;
    return Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function buildDomScript(lang, map) {
    const skeleton = TABLES.langs[lang].dom;
    const needle = `const L="${lang}",M={},`;
    if (!skeleton.includes(needle)) throw new Error(`zh-tables.json dom skeleton for ${lang} is malformed`);
    return skeleton.replace(needle, `const L="${lang}",M=${JSON.stringify(map)},`);
}

function writeRuntimeData(resDir, lang, en, pack, log) {
    const dir = path.join(resDir, RUNTIME_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const map = buildDomMap(en, pack);
    fs.writeFileSync(path.join(dir, `dom-${lang}.js`), buildDomScript(lang, map));
    writeJson(path.join(dir, `menu-${lang}.json`), { labels: TABLES.langs[lang].labels, roles: TABLES.langs[lang].roles });
    fs.writeFileSync(path.join(dir, 'default-lang'), lang + '\n');
    writeJson(path.join(dir, 'installed.json'), {
        lang, label: LABELS[lang], upstream: REPO, upstreamRelease: pack.release,
        files: [`${lang}.json`, `ion-dist/i18n/${lang}.json`, `ion-dist/i18n/dynamic/${lang}.json`, `ion-dist/i18n/statsig/${lang}.json`, `${RUNTIME_DIR}/`],
    });
    log(`Runtime data: ${Object.keys(map).length} DOM strings, menu tables -> resources/${RUNTIME_DIR}/`);
}

// 对一个 resources/ 目录（官方安装目录或便携副本里的）就地打中文资源
function applyResources(resDir, lang, packDir, log) {
    if (!LANGS.includes(lang)) throw new Error(`Unsupported language: ${lang} (${LANGS.join(' | ')})`);
    const assets = path.join(resDir, 'ion-dist', 'assets', 'v1');
    const i18n = path.join(resDir, 'ion-dist', 'i18n');
    for (const p of [assets, i18n, path.join(resDir, 'en-US.json')]) {
        if (!fs.existsSync(p)) throw new Error(`Not a Claude Desktop resources dir (missing ${path.relative(resDir, p)}): ${resDir}`);
    }
    const pack = loadPack(packDir, lang);
    log(`Chinese pack: ${REPO} release ${pack.release}, ${Object.keys(pack.frontend).length} frontend + ${Object.keys(pack.desktop).length} desktop strings`);

    const wl = patchLanguageWhitelist(assets, lang);
    log(`Language whitelist ${wl.already ? 'already has' : '+='} ${lang}: ${path.basename(wl.file)}`);
    if (patchDisplayNames(wl.file)) log('Intl.DisplayNames override appended');
    patchHardcodedStrings(assets, pack.hardcoded, log);
    const en = installFrontendLocale(i18n, lang, pack, log);
    installDesktopLocale(resDir, lang, pack, log);
    writeRuntimeData(resDir, lang, en, pack, log);
    return pack;
}

// ============ app.asar 侧补丁 ============
// 主进程 hook：语言无关，运行时从 resources/claude-zh/ 读取数据；
// 生效语言 = <userData>/config.json 的 locale（zh-*）；未设置时用 default-lang
function mainHook() {
    return `;(function(){try{var el=require("electron"),app=el.app,fs=require("fs"),path=require("path");var dir=path.join(process.resourcesPath,${JSON.stringify(RUNTIME_DIR)});if(!fs.existsSync(dir))return;
function plog(m){try{var d=path.join(app.getPath("userData"),"logs");fs.mkdirSync(d,{recursive:true});fs.appendFileSync(path.join(d,"patch.log"),new Date().toISOString()+" [zh] "+m+"\\n")}catch(e){}}
function lang(){try{var l;try{l=JSON.parse(fs.readFileSync(path.join(app.getPath("userData"),"config.json"),"utf8")).locale}catch(e){}if(l==null||l===""){try{l=fs.readFileSync(path.join(dir,"default-lang"),"utf8").trim()}catch(e){}}return l&&/^zh-/.test(l)&&fs.existsSync(path.join(dir,"dom-"+l+".js"))?l:null}catch(e){return null}}
var cur,M,R;function load(){var l=lang();if(l===cur)return;cur=l;M=R=null;if(!l)return;try{var t=JSON.parse(fs.readFileSync(path.join(dir,"menu-"+l+".json"),"utf8"));M=t.labels||{};R=t.roles||{}}catch(e){}}
var norm=function(s){return String(s||"").replace(/\\u2026/g,"...").trim()},tr=function(s){return M[s]||M[norm(s)]||M[String(s||"").replace(/\\.\\.\\.$/,"\\u2026")]};
var menuHits=0,menuLogged=false;
function item(i){if(!i||typeof i!=="object")return;if(i.label){var l=tr(i.label);if(l){i.label=l;menuHits++}}var r=i.role==null?"":String(i.role),k=R[r]||R[r.charAt(0).toLowerCase()+r.slice(1)]||R[r.toLowerCase()];if(!i.label&&k){i.label=k;menuHits++}if(Array.isArray(i.submenu))walk(i.submenu)}
function walk(a){if(Array.isArray(a))for(var j=0;j<a.length;j++)item(a[j])}
function note(){if(!menuLogged&&menuHits){menuLogged=true;plog("menu labels translated ("+cur+"): "+menuHits)}}
try{var b=el.Menu.buildFromTemplate;el.Menu.buildFromTemplate=function(a){try{load();if(M){walk(a);note()}}catch(e){}return b.call(this,a)}}catch(e){}
try{var ins=el.Menu.prototype.insert;el.Menu.prototype.insert=function(p,i){try{load();if(M)item(i)}catch(e){}return ins.call(this,p,i)}}catch(e){}
var remote=function(u){return /^https:\\/\\/([a-z0-9-]+\\.)*claude\\.(ai|com)\\//.test(u||"")};
app.on("web-contents-created",function(_e,wc){
wc.on("did-start-navigation",function(ev,url,inPlace,mainFrame){try{var d=ev&&typeof ev==="object"&&"url" in ev?ev:{url:url,isMainFrame:mainFrame};if(!d.isMainFrame||!remote(d.url))return;var l=lang();if(globalThis.__claudeZhLockLocale!==l){globalThis.__claudeZhLockLocale=l;plog(l?"locale locked to "+l+" for remote pages":"locale lock released")}}catch(e){}});
wc.on("dom-ready",function(){try{var u=wc.getURL()||"";if(!remote(u))return;var l=lang();if(!l)return;var code=fs.readFileSync(path.join(dir,"dom-"+l+".js"),"utf8");wc.executeJavaScript(code).then(function(){plog("dom translation "+l+" injected: "+u)}).catch(function(e){plog("dom translation failed: "+e)})}catch(e){}})});
plog("main hook ready (default "+(function(){try{return fs.readFileSync(path.join(dir,"default-lang"),"utf8").trim()}catch(e){return"?"}})()+")")}catch(e){try{require("fs").appendFileSync("/tmp/claude-zh-error.log",String(e)+"\\n")}catch(_){}}})();`;
}

function asarPatches(lang) {
    if (!LANGS.includes(lang)) throw new Error(`Unsupported language: ${lang}`);
    const picker = TABLES.langs[lang].picker;
    const patches = [];
    for (const [src, dst] of Object.entries(picker).sort(([a], [b]) => b.length - a.length)) {
        patches.push({ name: `Model picker text: ${src.slice(0, 40)}`, file: '*', find: src, replace: dst, optional: true });
    }
    patches.push({
        // 原文: requestLocaleChange(e){B6e(e)} —— 远程 claude.ai 页面请求切换语言时锁定为中文
        name: 'DesktopIntl locale lock (remote claude.ai pages only)',
        file: '*',
        find: /requestLocaleChange\(([\w$]+)\)\{([\w$]+)\(\1\)\}/g,
        near: 'getInitialLocale',
        replace: (_m, a, f) => `requestLocaleChange(${a}){${f}(globalThis.__claudeZhLockLocale||${a})}`,
    });
    patches.push({ name: 'Chinese UI main hook (menus + online DOM translation)', file: 'index.pre.js', append: mainHook() });
    return patches;
}

module.exports = { REPO, LANGS, LABELS, RUNTIME_DIR, resolveResources, applyResources, asarPatches };

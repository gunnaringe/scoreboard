// Single-page app: routes on location.pathname (the Worker serves index.html
// for every non-API path). Render user text with textContent only — h() does
// that for strings; never build markup from names.

import { displayRating, winProbability, balanceTeams, newRating, PROVISIONAL_ROUNDS } from './rating.js';
import qrcodegen from './qrcodegen.js';
import { t, locale, applyI18n } from './i18n.js';

const app = document.getElementById('app');

// ---- tiny DOM helper ----------------------------------------------------------

function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'value' || k === 'checked' || k === 'selected') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
        if (kid === null || kid === undefined || kid === false) continue;
        el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
}

// Static, trusted SVG paths (Lucide-style, 24×24).
const ICONS = {
    back: '<path d="m15 18-6-6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>',
    settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    shuffle: '<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
};

function icon(name) {
    const span = document.createElement('span');
    span.className = 'icon';
    span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
    return span.firstChild;
}

// ---- local storage ------------------------------------------------------------

// groups: [{ id, name, token, code }] — the groups this browser has joined.
function myGroups() {
    try {
        return JSON.parse(localStorage.getItem('groups')) || [];
    } catch {
        return [];
    }
}
function saveGroups(list) {
    localStorage.setItem('groups', JSON.stringify(list));
}
function rememberGroup(entry) {
    const list = myGroups().filter((g) => g.id !== entry.id);
    list.unshift(entry);
    saveGroups(list);
}
function updateGroupEntry(id, patch) {
    saveGroups(myGroups().map((g) => (g.id === id ? { ...g, ...patch } : g)));
}
function forgetGroup(id) {
    saveGroups(myGroups().filter((g) => g.id !== id));
}
const tokenFor = (gid) => myGroups().find((g) => g.id === gid)?.token;

// ---- API ----------------------------------------------------------------------

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function api(method, path, body, token) {
    let res;
    try {
        res = await fetch(`/api${path}`, {
            method,
            headers: {
                ...(body ? { 'content-type': 'application/json' } : {}),
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
    } catch {
        throw new ApiError(0, t('offline'));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error || res.statusText);
    return data;
}

// Group-scoped call. A 401 means this device was removed (or the group was
// deleted): forget the group and go home.
async function gapi(gid, method, path, body) {
    try {
        return await api(method, `/g/${gid}${path}`, body, tokenFor(gid));
    } catch (err) {
        if (err.status === 401) {
            forgetGroup(gid);
            toast(t('removedFromGroup'));
            navigate('/', true);
        }
        throw err;
    }
}

// ---- routing ------------------------------------------------------------------

let pollTimer = null;
let pollFn = null;
// Bumped by every page load/refresh; a slower, older refresh must not draw
// over a newer one.
let loadSeq = 0;
let routeSeq = 0;

function navigate(path, replace = false) {
    history[replace ? 'replaceState' : 'pushState'](null, '', path);
    route();
}

document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download') || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
    e.preventDefault();
    navigate(url.pathname + url.search);
});
addEventListener('popstate', () => route());

const ROUTES = [
    [/^\/$/, pageHome],
    [/^\/settings$/, pageAppSettings],
    [/^\/j\/([\w-]+)$/, pageJoin],
    [/^\/g\/(\w+)$/, pageGroup],
    [/^\/g\/(\w+)\/settings$/, pageGroupSettings],
    [/^\/g\/(\w+)\/poster$/, pagePoster],
    [/^\/g\/(\w+)\/game\/(\w+)$/, pageGame],
    [/^\/g\/(\w+)\/game\/(\w+)\/history$/, pageHistory],
    [/^\/g\/(\w+)\/game\/(\w+)\/t\/(\w+)$/, pageTournament],
    [/^\/g\/(\w+)\/game\/(\w+)\/p\/(\w+)$/, pagePlayer],
];

async function route() {
    clearInterval(pollTimer);
    pollTimer = null;
    const seq = ++routeSeq;
    const path = location.pathname.replace(/\/+$/, '') || '/';
    // Launched from the home screen: go back to where we were.
    if (path === '/' && new URLSearchParams(location.search).has('app')) {
        const last = localStorage.getItem('lastPath');
        if (last && last !== '/') return navigate(last, true);
    }
    for (const [pattern, page] of ROUTES) {
        const m = path.match(pattern);
        if (!m) continue;
        if (path.startsWith('/g/')) {
            if (!tokenFor(m[1])) return navigate('/', true);
            localStorage.setItem('lastPath', path);
        }
        // The old page stays visible while the next one loads, but can't be used.
        app.inert = true;
        app.classList.add('loading');
        try {
            await page(...m.slice(1), () => seq === routeSeq);
        } catch (err) {
            if (seq !== routeSeq) return;
            if (err.status === 401) return;
            render(topbar({ back: '/' }), h('main', { class: 'wrap narrow' },
                h('div', { class: 'card empty' }, h('p', null, err.status === 404 ? t('notFound') : err.message),
                    h('a', { class: 'btn', href: '/' }, t('home')))));
        }
        return;
    }
    navigate('/', true);
}

function render(...nodes) {
    app.inert = false;
    app.classList.remove('loading');
    app.replaceChildren(...nodes);
    window.scrollTo?.(0, 0);
}

// Keeps scroll position; for refreshes of the same page.
function rerender(...nodes) {
    const y = window.scrollY;
    app.inert = false;
    app.classList.remove('loading');
    app.replaceChildren(...nodes);
    window.scrollTo?.(0, y);
}

function poll(fn) {
    clearInterval(pollTimer);
    pollFn = fn;
    pollTimer = setInterval(() => {
        if (document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) fn();
    }, 60000);
}
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pollTimer && !document.querySelector('dialog[open]')) pollFn();
});

// ---- shared bits --------------------------------------------------------------

function topbar({ back, title, actions = [] } = {}) {
    return h('header', { class: 'topbar' },
        back
            ? h('a', { class: 'icon-btn', href: back, 'aria-label': t('back'), title: t('back') }, icon('back'))
            : h('a', { class: 'brand', href: '/' }, h('span', { class: 'brand-dot' }), t('appName')),
        title ? h('h1', { class: 'title' }, title) : h('span', { class: 'title' }),
        h('div', { class: 'actions' }, actions));
}

function iconLink(name, href, label) {
    return h('a', { class: 'icon-btn', href, 'aria-label': label, title: label }, icon(name));
}

function iconButton(name, label, onclick, cls = '') {
    return h('button', { class: `icon-btn ${cls}`, type: 'button', 'aria-label': label, title: label, onclick }, icon(name));
}

let toastTimer;
function toast(message, action) {
    document.querySelector('.toast')?.remove();
    clearTimeout(toastTimer);
    const el = h('div', { class: 'toast', role: 'status' }, h('span', null, message),
        action && h('button', { type: 'button', onclick: () => { el.remove(); action.run(); } }, action.label));
    document.body.append(el);
    toastTimer = setTimeout(() => el.remove(), action ? 8000 : 3500);
}

function errorToast(err) {
    toast(err.message || String(err));
}

function joinUrl(code) {
    return `${location.origin}/j/${code}`;
}

async function share(title, text, url) {
    if (navigator.share) {
        try {
            await navigator.share({ title, text, url });
            return;
        } catch (err) {
            if (err.name === 'AbortError') return;
        }
    }
    try {
        await navigator.clipboard.writeText(url);
        toast(t('linkCopied'));
    } catch {
        prompt(t('copyThisLink'), url);
    }
}

function qrSvg(text) {
    const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
    const border = 2;
    const size = qr.size + border * 2;
    let d = '';
    for (let y = 0; y < qr.size; y++) {
        for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) d += `M${x + border},${y + border}h1v1h-1z`;
    }
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('class', 'qr');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', text);
    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('width', size);
    bg.setAttribute('height', size);
    bg.setAttribute('fill', '#fff');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', '#000');
    svg.append(bg, path);
    return svg;
}

function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}

function fmtDay(ms) {
    const day = new Date(ms);
    day.setHours(0, 0, 0, 0);
    const diff = Math.round((startOfToday() - day.getTime()) / 86400000);
    if (diff === 0) return t('today');
    if (diff === 1) return t('yesterday');
    return new Date(ms).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short', year: diff > 300 ? 'numeric' : undefined });
}

function fmtDelta(n) {
    if (!n) return '±0';
    return n > 0 ? `+${n}` : `−${-n}`;
}

function deltaEl(n, cls = '') {
    return h('span', { class: `delta ${n > 0 ? 'up' : n < 0 ? 'down' : ''} ${cls}` }, fmtDelta(n));
}

function roundDelta(p) {
    return p.before && p.after ? displayRating(p.after) - displayRating(p.before) : 0;
}

function playerName(ctx, id) {
    return ctx.playersById.get(id)?.name ?? '?';
}

// Group data shared by all group pages; refetched on each page load.
async function loadGroup(gid) {
    const data = await gapi(gid, 'GET', '');
    data.playersById = new Map(data.players.map((p) => [p.id, p]));
    const code = data.group.inviteCode;
    const entry = myGroups().find((g) => g.id === gid);
    if (entry && (entry.name !== data.group.name || entry.code !== code)) updateGroupEntry(gid, { name: data.group.name, code });
    return data;
}

// ---- pages: home, join, app settings -------------------------------------------

async function pageHome() {
    document.title = t('appName');
    const groups = myGroups();
    const codeInput = h('input', { class: 'input code-input', placeholder: 'ABCD-EFGH', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': t('inviteCode') });
    const joinForm = h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); joinWithCode(codeInput.value); } },
        codeInput, h('button', { class: 'btn' }, t('join')));

    const groupName = h('input', { class: 'input', placeholder: t('groupNamePlaceholder'), required: true, maxlength: 40 });
    const yourName = h('input', { class: 'input', placeholder: t('yourNamePlaceholder'), maxlength: 40 });
    const gameName = h('input', { class: 'input', value: 'Rocket League', maxlength: 40 });
    const createForm = h('form', { class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        try {
            const res = await api('POST', '/groups', { name: groupName.value, playerName: yourName.value || undefined, gameName: gameName.value || undefined });
            rememberGroup({ id: res.groupId, name: res.name, token: res.token });
            navigate(`/g/${res.groupId}`);
        } catch (err) { errorToast(err); }
    } },
    h('label', { class: 'field' }, h('span', null, t('groupName')), groupName),
    h('label', { class: 'field' }, h('span', null, t('yourName')), yourName),
    h('label', { class: 'field' }, h('span', null, t('firstGame')), gameName),
    h('button', { class: 'btn' }, t('createGroup')));

    render(
        topbar({ actions: [iconLink('settings', '/settings', t('settings'))] }),
        h('main', { class: 'wrap narrow' },
            h('section', { class: 'hero' }, h('h1', null, t('heroTitle')), h('p', null, t('heroText'))),
            groups.length > 0 && h('section', { class: 'card pad' }, h('h2', null, t('yourGroups')),
                h('ul', { class: 'list' }, groups.map((g) => h('li', null, h('a', { class: 'list-link', href: `/g/${g.id}` },
                    h('span', null, g.name), icon('back')))))),
            h('section', { class: 'card pad' }, h('h2', null, t('joinGroup')), h('p', { class: 'muted' }, t('joinHint')), joinForm),
            h('section', { class: 'card pad' }, h('h2', null, t('newGroup')), createForm)));
}

async function joinWithCode(raw) {
    const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 8) return toast(t('invalidCode'));
    const pretty = `${code.slice(0, 4)}-${code.slice(4)}`;
    const known = myGroups().find((g) => g.code === pretty);
    if (known) return navigate(`/g/${known.id}`, true);
    try {
        const res = await api('POST', '/join', { code });
        rememberGroup({ id: res.groupId, name: res.name, token: res.token, code: pretty });
        navigate(`/g/${res.groupId}?welcome`, true);
    } catch (err) {
        toast(err.status === 404 ? t('unknownCode') : err.message);
        if (location.pathname.startsWith('/j/')) navigate('/', true);
    }
}

async function pageJoin(code) {
    render(topbar({ back: '/' }), h('main', { class: 'wrap narrow' }, h('div', { class: 'card empty' }, h('p', null, t('joining')))));
    await joinWithCode(code);
}

function segmented(options, current, onchange) {
    const el = h('div', { class: 'segmented', role: 'radiogroup' });
    const draw = (value) => el.replaceChildren(...options.map(([v, label]) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(v === value), class: v === value ? 'on' : '',
        onclick: () => { draw(v); onchange(v); },
    }, label)));
    draw(current);
    return el;
}

async function pageAppSettings() {
    document.title = `${t('settings')} · ${t('appName')}`;
    const groups = myGroups();
    render(
        topbar({ back: '/', title: t('settings') }),
        h('main', { class: 'wrap narrow' },
            h('section', { class: 'card pad' }, h('h2', null, t('theme')),
                segmented([['auto', t('themeAuto')], ['light', t('themeLight')], ['dark', t('themeDark')], ['hacker', t('themeHacker')]],
                    localStorage.getItem('theme') || 'auto', (v) => { localStorage.setItem('theme', v); window.applyTheme(); })),
            h('section', { class: 'card pad' }, h('h2', null, t('language')),
                segmented([['auto', t('langAuto')], ['en', 'English'], ['no', 'Norsk']],
                    localStorage.getItem('lang') || 'auto', (v) => { localStorage.setItem('lang', v); applyI18n(); pageAppSettings(); })),
            h('section', { class: 'card pad' }, h('h2', null, t('groupsOnDevice')),
                groups.length ? h('ul', { class: 'list' }, groups.map((g) => h('li', { class: 'list-row' },
                    h('a', { href: `/g/${g.id}` }, g.name),
                    h('a', { class: 'btn ghost small', href: `/g/${g.id}/settings` }, t('groupSettings')))))
                    : h('p', { class: 'muted' }, t('noGroups'))),
            h('p', { class: 'muted small center' }, t('aboutRating'))));
}

// ---- who am I -----------------------------------------------------------------

function whoAmI(gid, ctx, onDone) {
    const active = ctx.players.filter((p) => !p.archived);
    const nameInput = h('input', { class: 'input', placeholder: t('yourNamePlaceholder'), maxlength: 40 });
    const choose = async (playerId) => {
        try {
            await gapi(gid, 'PUT', '/me', { playerId });
            dialog.close();
            onDone();
        } catch (err) { errorToast(err); }
    };
    const dialog = h('dialog', { class: 'sheet' },
        h('div', { class: 'sheet-body' },
            h('h2', null, t('whoAreYou')),
            active.length > 0 && h('div', { class: 'chips' }, active.map((p) => h('button', {
                type: 'button', class: `pchip ${p.id === ctx.me.playerId ? 'sel' : ''}`, onclick: () => choose(p.id),
            }, p.name))),
            h('form', { class: 'row', onsubmit: async (e) => {
                e.preventDefault();
                try {
                    await gapi(gid, 'POST', '/players', { name: nameInput.value, me: true });
                    dialog.close();
                    onDone();
                } catch (err) { toast(err.status === 409 ? t('nameTaken') : err.message); }
            } }, nameInput, h('button', { class: 'btn' }, active.length ? t('imNew') : t('add'))),
            h('div', { class: 'sheet-actions' },
                ctx.me.playerId && h('button', { type: 'button', class: 'btn ghost', onclick: () => choose(null) }, t('notAPlayer')),
                h('button', { type: 'button', class: 'btn ghost', onclick: () => dialog.close() }, t('skip')))));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
}

// ---- group page ---------------------------------------------------------------

function inviteCard(gid, ctx) {
    const code = ctx.group.inviteCode;
    const url = joinUrl(code);
    return h('section', { class: 'card pad invite' },
        h('div', { class: 'invite-text' },
            h('h2', null, t('invite')),
            h('p', { class: 'muted' }, t('inviteHint')),
            h('div', { class: 'code' }, code),
            h('div', { class: 'row wrap-row' },
                h('button', { class: 'btn', type: 'button', onclick: () => share(ctx.group.name, t('shareText', { group: ctx.group.name }), url) }, icon('share'), t('share')),
                h('a', { class: 'btn ghost', href: `/g/${gid}/poster` }, icon('printer'), t('poster')))),
        h('a', { class: 'invite-qr', href: `/g/${gid}/poster`, 'aria-label': t('poster') }, qrSvg(url)));
}

async function pageGroup(gid, current) {
    const ctx = await loadGroup(gid);
    if (!current()) return;
    document.title = `${ctx.group.name} · ${t('appName')}`;
    const games = ctx.games.filter((g) => !g.archived);
    const gameName = h('input', { class: 'input', placeholder: t('gameNamePlaceholder'), maxlength: 40 });
    const me = ctx.playersById.get(ctx.me.playerId);
    const welcome = new URLSearchParams(location.search).has('welcome');

    render(
        topbar({ back: '/', title: ctx.group.name, actions: [
            iconButton('share', t('share'), () => share(ctx.group.name, t('shareText', { group: ctx.group.name }), joinUrl(ctx.group.inviteCode))),
            iconLink('settings', `/g/${gid}/settings`, t('groupSettings')),
        ] }),
        h('main', { class: 'wrap narrow' },
            h('section', { class: 'card pad' }, h('h2', null, t('games')),
                games.length ? h('ul', { class: 'list' }, games.map((g) => h('li', null,
                    h('a', { class: 'list-link big', href: `/g/${gid}/game/${g.id}` }, h('span', null, g.name), icon('back')))))
                    : h('p', { class: 'muted' }, t('noGames')),
                h('form', { class: 'row', onsubmit: async (e) => {
                    e.preventDefault();
                    try {
                        const game = await gapi(gid, 'POST', '/games', { name: gameName.value });
                        navigate(`/g/${gid}/game/${game.id}`);
                    } catch (err) { errorToast(err); }
                } }, gameName, h('button', { class: 'btn ghost' }, icon('plus'), t('addGame')))),
            h('section', { class: 'card pad' },
                h('div', { class: 'section-head' }, h('h2', null, t('players')),
                    h('button', { class: 'btn ghost small', type: 'button', onclick: () => whoAmI(gid, ctx, () => route()) },
                        me ? t('youAre', { name: me.name }) : t('whoAreYou'))),
                h('div', { class: 'chips' }, ctx.players.filter((p) => !p.archived).map((p) => h('span', { class: `pchip static ${p.id === ctx.me.playerId ? 'sel' : ''}` }, p.name)))),
            inviteCard(gid, ctx)));

    if (welcome) {
        history.replaceState(null, '', `/g/${gid}`);
        whoAmI(gid, ctx, () => (games.length === 1 ? navigate(`/g/${gid}/game/${games[0].id}`, true) : route()));
    }
}

// ---- game page ----------------------------------------------------------------

async function loadGame(gid, gameId) {
    const [ctx, data] = await Promise.all([
        loadGroup(gid),
        gapi(gid, 'GET', `/games/${gameId}?since=${startOfToday()}`),
    ]);
    ctx.game = data.game;
    ctx.tournaments = data.tournaments;
    ctx.rounds = data.rounds;
    ctx.ratings = new Map(data.ratings.map((r) => [r.playerId, r]));
    return ctx;
}

function leaderboard(gid, ctx, todayRounds) {
    // Rating before each player's first round today, for the "today" column.
    const startOfDay = new Map();
    for (const r of [...todayRounds].reverse()) {
        for (const p of r.players) if (!startOfDay.has(p.id) && p.before) startOfDay.set(p.id, p.before);
    }
    const rows = [...ctx.ratings.values()]
        .filter((r) => ctx.playersById.get(r.playerId) && !ctx.playersById.get(r.playerId).archived)
        .map((r) => ({ ...r, display: displayRating(r) }))
        .sort((a, b) => b.display - a.display || b.wins - a.wins);
    if (!rows.length) return h('p', { class: 'muted empty-small' }, t('noRoundsYet'));
    let rank = 0;
    return h('table', { class: 'board' },
        h('thead', null, h('tr', null,
            h('th', { class: 'num' }, '#'), h('th', null, t('player')), h('th', { class: 'num' }, t('rating')),
            h('th', { class: 'num' }, t('todayShort')), h('th', { class: 'num hide-narrow' }, t('wl')))),
        h('tbody', null, rows.map((r, i) => {
            const provisional = r.rounds < PROVISIONAL_ROUNDS;
            if (!provisional) rank++;
            const start = startOfDay.get(r.playerId);
            const today = start ? r.display - displayRating(start) : null;
            const isMe = r.playerId === ctx.me.playerId;
            return h('tr', { class: `${isMe ? 'me' : ''} ${provisional ? 'provisional' : ''} ${i < 3 && !provisional ? `top top${rank}` : ''}` },
                h('td', { class: 'num rank' }, provisional ? '–' : rank),
                h('td', { class: 'name' }, h('a', { href: `/g/${gid}/game/${ctx.game.id}/p/${r.playerId}` }, playerName(ctx, r.playerId)),
                    provisional && h('span', { class: 'chip', title: t('provisionalHint', { n: PROVISIONAL_ROUNDS }) }, t('provisional'))),
                h('td', { class: 'num rating' }, r.display),
                h('td', { class: 'num' }, today === null ? '' : deltaEl(today)),
                h('td', { class: 'num hide-narrow muted' }, `${r.wins}–${r.rounds - r.wins}`));
        })));
}

function roundItem(gid, ctx, round, { showDay = false, onChange } = {}) {
    const team = (i) => round.players.filter((p) => p.team === i);
    const side = (i) => h('div', { class: `side side-${i} ${round.winner === i ? 'won' : ''}` },
        team(i).map((p) => h('span', { class: 'who' }, h('span', { class: 'pname' }, playerName(ctx, p.id)), deltaEl(roundDelta(p), 'small'))));
    const hasScore = round.scoreA !== null && round.scoreB !== null;
    const tour = round.tournamentId && ctx.tournaments?.find((x) => x.id === round.tournamentId);
    const el = h(round.canEdit ? 'button' : 'div', {
        class: 'round', type: round.canEdit ? 'button' : null,
        onclick: round.canEdit ? () => roundSheet(gid, ctx, { round, onSaved: onChange }) : null,
    },
    side(0),
    h('div', { class: 'mid' },
        h('span', { class: 'score' }, hasScore ? `${round.scoreA}–${round.scoreB}` : round.winner === 0 ? '◀' : '▶'),
        h('span', { class: 'when' }, showDay ? `${fmtDay(round.playedAt)} ${fmtTime(round.playedAt)}` : fmtTime(round.playedAt)),
        tour && h('span', { class: 'tour' }, icon('trophy'), tour.name)),
    side(1));
    return h('li', null, el);
}

function roundList(gid, ctx, rounds, opts = {}) {
    if (!rounds.length) return h('p', { class: 'muted empty-small' }, opts.empty || t('noRoundsToday'));
    const items = [];
    let lastDay = null;
    for (const r of rounds) {
        if (opts.groupByDay) {
            const day = fmtDay(r.playedAt);
            if (day !== lastDay) items.push(h('li', { class: 'day' }, day));
            lastDay = day;
        }
        items.push(roundItem(gid, ctx, r, opts));
    }
    return h('ul', { class: 'rounds' }, items);
}

function teamLegend(ctx) {
    return h('div', { class: 'team-legend' },
        h('span', { class: 'tl tl-0' }, ctx.game.teamA), h('span', { class: 'muted' }, t('vs')), h('span', { class: 'tl tl-1' }, ctx.game.teamB));
}

async function pageGame(gid, gameId, current) {
    const seq = ++loadSeq;
    const ctx = await loadGame(gid, gameId);
    if (!current() || seq !== loadSeq) return;
    document.title = `${ctx.game.name} · ${ctx.group.name}`;
    const today = ctx.rounds.filter((r) => r.playedAt >= startOfToday());
    const recent = today.length ? today : ctx.rounds.slice(0, 5);
    const refresh = () => pageGame(gid, gameId, current);
    const tourName = h('input', { class: 'input', placeholder: t('tournamentPlaceholder'), maxlength: 40 });

    (pollTimer ? rerender : render)(
        topbar({ back: `/g/${gid}`, title: ctx.game.name, actions: [
            iconButton('share', t('share'), () => share(ctx.group.name, t('shareText', { group: ctx.group.name }), joinUrl(ctx.group.inviteCode))),
            iconLink('settings', `/g/${gid}/settings`, t('groupSettings')),
        ] }),
        h('main', { class: 'wrap game-grid' },
            h('section', { class: 'card pad board-card' },
                h('div', { class: 'section-head' }, h('h2', null, t('leaderboard')), teamLegend(ctx)),
                leaderboard(gid, ctx, today)),
            h('div', { class: 'side-col' },
                h('section', { class: 'card pad' },
                    h('div', { class: 'section-head' }, h('h2', null, today.length ? t('today') : t('recent')),
                        h('a', { class: 'btn ghost small', href: `/g/${gid}/game/${gameId}/history` }, icon('history'), t('history'))),
                    roundList(gid, ctx, recent, { showDay: !today.length, onChange: refresh })),
                h('section', { class: 'card pad' },
                    h('h2', null, t('tournaments')),
                    ctx.tournaments.length > 0 && h('ul', { class: 'list' }, ctx.tournaments.slice(0, 8).map((x) => h('li', null,
                        h('a', { class: 'list-link', href: `/g/${gid}/game/${gameId}/t/${x.id}` },
                            h('span', null, icon('trophy'), ' ', x.name), h('span', { class: 'chip' }, x.endedAt ? t('ended') : t('active')))))),
                    h('form', { class: 'row', onsubmit: async (e) => {
                        e.preventDefault();
                        try {
                            const x = await gapi(gid, 'POST', `/games/${gameId}/tournaments`, { name: tourName.value });
                            navigate(`/g/${gid}/game/${gameId}/t/${x.id}`);
                        } catch (err) { errorToast(err); }
                    } }, tourName, h('button', { class: 'btn ghost' }, icon('plus'), t('start'))))),
            h('button', { class: 'fab btn', type: 'button', onclick: () => roundSheet(gid, ctx, { tournamentId: null, onSaved: refresh }) },
                icon('plus'), t('newRound'))));
    if (!pollTimer) poll(refresh);
}

async function pageHistory(gid, gameId, current) {
    const ctx = await loadGame(gid, gameId);
    if (!current()) return;
    document.title = `${t('history')} · ${ctx.game.name}`;
    let rounds = [];
    let more = true;
    const list = h('div');
    const moreBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => load() }, t('loadMore'));
    async function load() {
        const before = rounds.length ? rounds[rounds.length - 1].playedAt : '';
        const res = await gapi(gid, 'GET', `/games/${gameId}/rounds?before=${before}&limit=50`);
        rounds = rounds.concat(res.rounds);
        more = res.more;
        list.replaceChildren(roundList(gid, ctx, rounds, { groupByDay: true, empty: t('noRoundsYet'), onChange: () => pageHistory(gid, gameId, current) }));
        moreBtn.hidden = !more;
    }
    render(
        topbar({ back: `/g/${gid}/game/${gameId}`, title: t('history') }),
        h('main', { class: 'wrap narrow' }, h('section', { class: 'card pad' }, list, h('div', { class: 'center' }, moreBtn))));
    await load();
}

// ---- tournament page ----------------------------------------------------------

async function pageTournament(gid, gameId, tid, current) {
    const seq = ++loadSeq;
    const [ctx, res] = await Promise.all([loadGame(gid, gameId), gapi(gid, 'GET', `/games/${gameId}/rounds?tournament=${tid}&limit=1000`)]);
    if (!current() || seq !== loadSeq) return;
    const tour = ctx.tournaments.find((x) => x.id === tid);
    if (!tour) throw Object.assign(new Error(t('notFound')), { status: 404 });
    document.title = `${tour.name} · ${ctx.game.name}`;
    const refresh = () => pageTournament(gid, gameId, tid, current);
    const stats = new Map();
    for (const r of res.rounds) {
        for (const p of r.players) {
            const s = stats.get(p.id) || { id: p.id, wins: 0, losses: 0, delta: 0 };
            if (p.team === r.winner) s.wins++; else s.losses++;
            s.delta += roundDelta(p);
            stats.set(p.id, s);
        }
    }
    const rows = [...stats.values()].sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.delta - a.delta);
    const rename = async () => {
        const name = prompt(t('rename'), tour.name);
        if (!name) return;
        try { await gapi(gid, 'PATCH', `/tournaments/${tid}`, { name }); refresh(); } catch (err) { errorToast(err); }
    };
    const toggleEnded = async () => {
        try { await gapi(gid, 'PATCH', `/tournaments/${tid}`, { ended: !tour.endedAt }); refresh(); } catch (err) { errorToast(err); }
    };
    (pollTimer ? rerender : render)(
        topbar({ back: `/g/${gid}/game/${gameId}`, title: tour.name }),
        h('main', { class: 'wrap game-grid' },
            h('section', { class: 'card pad board-card' },
                h('div', { class: 'section-head' }, h('h2', null, icon('trophy'), ' ', t('standings')),
                    h('span', { class: 'chip' }, tour.endedAt ? t('ended') : t('active'))),
                rows.length ? h('table', { class: 'board' },
                    h('thead', null, h('tr', null, h('th', { class: 'num' }, '#'), h('th', null, t('player')),
                        h('th', { class: 'num' }, t('winsShort')), h('th', { class: 'num' }, t('lossesShort')), h('th', { class: 'num' }, t('ratingChange')))),
                    h('tbody', null, rows.map((s, i) => h('tr', { class: `${s.id === ctx.me.playerId ? 'me' : ''} ${i < 3 ? `top top${i + 1}` : ''}` },
                        h('td', { class: 'num rank' }, i + 1),
                        h('td', { class: 'name' }, h('a', { href: `/g/${gid}/game/${gameId}/p/${s.id}` }, playerName(ctx, s.id))),
                        h('td', { class: 'num rating' }, s.wins), h('td', { class: 'num muted' }, s.losses), h('td', { class: 'num' }, deltaEl(s.delta))))))
                    : h('p', { class: 'muted empty-small' }, t('noRoundsYet')),
                h('p', { class: 'muted small' }, t('tournamentHint')),
                h('div', { class: 'row wrap-row' },
                    h('button', { class: 'btn ghost small', type: 'button', onclick: rename }, t('rename')),
                    h('button', { class: 'btn ghost small', type: 'button', onclick: toggleEnded }, tour.endedAt ? t('reopen') : t('endTournament')))),
            h('div', { class: 'side-col' },
                h('section', { class: 'card pad' }, h('h2', null, t('rounds')),
                    roundList(gid, ctx, res.rounds, { groupByDay: true, empty: t('noRoundsYet'), onChange: refresh }))),
            !tour.endedAt && h('button', { class: 'fab btn', type: 'button', onclick: () => roundSheet(gid, ctx, { tournamentId: tid, onSaved: refresh }) },
                icon('plus'), t('newRound'))));
    if (!pollTimer) poll(refresh);
}

// ---- player page --------------------------------------------------------------

function ratingChart(points) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'chart');
    svg.setAttribute('viewBox', '0 0 300 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    if (points.length < 2) return svg;
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = Math.max(max - min, 20);
    const xy = points.map((v, i) => [(i / (points.length - 1)) * 300, 95 - ((v - min) / span) * 90]);
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    const area = document.createElementNS(ns, 'polygon');
    area.setAttribute('points', `0,100 ${xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} 300,100`);
    area.setAttribute('class', 'area');
    svg.append(area, line);
    return svg;
}

async function pagePlayer(gid, gameId, pid, current) {
    const [ctx, res] = await Promise.all([loadGame(gid, gameId), gapi(gid, 'GET', `/games/${gameId}/rounds?player=${pid}&limit=1000`)]);
    if (!current()) return;
    const player = ctx.playersById.get(pid);
    if (!player) throw Object.assign(new Error(t('notFound')), { status: 404 });
    document.title = `${player.name} · ${ctx.game.name}`;
    const rounds = res.rounds; // newest first
    const rating = ctx.ratings.get(pid) || { ...newRating(), rounds: 0, wins: 0 };
    const display = displayRating(rating);
    const chrono = [...rounds].reverse();
    const points = [1000, ...chrono.map((r) => {
        const p = r.players.find((x) => x.id === pid);
        return p.after ? displayRating(p.after) : 1000;
    })];
    const best = Math.max(...points);
    let streak = 0;
    let streakWin = null;
    for (const r of rounds) {
        const won = r.players.find((x) => x.id === pid).team === r.winner;
        if (streakWin === null) streakWin = won;
        if (won !== streakWin) break;
        streak++;
    }
    const withMap = new Map();
    const vsMap = new Map();
    const bump = (map, id, won) => {
        const s = map.get(id) || { id, games: 0, wins: 0 };
        s.games++;
        if (won) s.wins++;
        map.set(id, s);
    };
    for (const r of rounds) {
        const myTeam = r.players.find((x) => x.id === pid).team;
        const won = myTeam === r.winner;
        for (const p of r.players) {
            if (p.id === pid) continue;
            bump(p.team === myTeam ? withMap : vsMap, p.id, won);
        }
    }
    const pct = (s) => s.wins / s.games;
    const qualified = (map) => [...map.values()].filter((s) => s.games >= 3);
    const bestMate = qualified(withMap).sort((a, b) => pct(b) - pct(a) || b.games - a.games)[0];
    const nemesis = qualified(vsMap).sort((a, b) => pct(a) - pct(b) || b.games - a.games)[0];
    const ranked = [...ctx.ratings.values()].filter((r) => r.rounds >= PROVISIONAL_ROUNDS && !ctx.playersById.get(r.playerId)?.archived)
        .sort((a, b) => displayRating(b) - displayRating(a));
    const rank = ranked.findIndex((r) => r.playerId === pid) + 1;
    const stat = (label, value, sub) => h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, label), h('span', { class: 'stat-value' }, value), sub && h('span', { class: 'stat-sub' }, sub));
    const pctText = (s) => `${Math.round(pct(s) * 100)} %`;
    const h2hRows = (map) => [...map.values()].sort((a, b) => b.games - a.games).map((s) => h('tr', null,
        h('td', { class: 'name' }, h('a', { href: `/g/${gid}/game/${gameId}/p/${s.id}` }, playerName(ctx, s.id))),
        h('td', { class: 'num' }, s.games), h('td', { class: 'num' }, `${s.wins}–${s.games - s.wins}`), h('td', { class: 'num muted' }, pctText(s))));
    const h2hTable = (title, map) => map.size > 0 && h('div', null, h('h3', null, title), h('table', { class: 'board compact' },
        h('thead', null, h('tr', null, h('th', null, t('player')), h('th', { class: 'num' }, t('roundsShort')), h('th', { class: 'num' }, t('wl')), h('th', { class: 'num' }, '%'))),
        h('tbody', null, h2hRows(map))));

    render(
        topbar({ back: `/g/${gid}/game/${gameId}`, title: player.name }),
        h('main', { class: 'wrap game-grid' },
            h('section', { class: 'card pad board-card' },
                h('div', { class: 'stats' },
                    stat(t('rating'), display, rating.rounds < PROVISIONAL_ROUNDS ? t('provisional') : rank ? t('rankOf', { rank, n: ranked.length }) : ''),
                    stat(t('rounds'), rating.rounds, rating.rounds ? `${Math.round((rating.wins / rating.rounds) * 100)} % ${t('wins')}` : ''),
                    stat(t('best'), best),
                    stat(t('streak'), streak ? `${streak} ${streakWin ? 'W' : 'L'}` : '–')),
                ratingChart(points),
                h('div', { class: 'stats' },
                    bestMate && stat(t('bestTeammate'), playerName(ctx, bestMate.id), `${bestMate.wins}–${bestMate.games - bestMate.wins}`),
                    nemesis && stat(t('nemesis'), playerName(ctx, nemesis.id), `${nemesis.wins}–${nemesis.games - nemesis.wins}`)),
                h('div', { class: 'h2h' }, h2hTable(t('with'), withMap), h2hTable(t('against'), vsMap))),
            h('div', { class: 'side-col' },
                h('section', { class: 'card pad' }, h('h2', null, t('rounds')),
                    roundList(gid, ctx, rounds.slice(0, 100), { groupByDay: true, empty: t('noRoundsYet'), onChange: () => pagePlayer(gid, gameId, pid, current) })))));
}

// ---- round sheet --------------------------------------------------------------

// Record a new round (or edit `round`). Tap a player chip to cycle it through
// team A → team B → out.
function roundSheet(gid, ctx, { round = null, tournamentId = null, onSaved }) {
    const editing = !!round;
    const assign = new Map(); // playerId -> 0 | 1
    let winner = editing ? round.winner : null;
    if (editing) for (const p of round.players) assign.set(p.id, p.team);

    const ratingOf = (id) => ctx.ratings.get(id) || { ...newRating(), rounds: 0, wins: 0 };
    // Most active players first, then alphabetical.
    let players = ctx.players.filter((p) => !p.archived || assign.has(p.id))
        .sort((a, b) => ratingOf(b.id).rounds - ratingOf(a.id).rounds || a.name.localeCompare(b.name, locale()));

    const lastRound = ctx.rounds?.[0];
    const chips = h('div', { class: 'chips pool' });
    const summary = h('div', { class: 'matchup' });
    const winA = h('button', { type: 'button', class: 'win-btn win-0', onclick: () => { winner = winner === 0 ? null : 0; draw(); } });
    const winB = h('button', { type: 'button', class: 'win-btn win-1', onclick: () => { winner = winner === 1 ? null : 1; draw(); } });
    const scoreA = h('input', { class: 'input score-input', type: 'number', inputmode: 'numeric', min: 0, max: 999, placeholder: '–', 'aria-label': t('scoreFor', { team: ctx.game.teamA }), value: editing && round.scoreA !== null ? String(round.scoreA) : '' });
    const scoreB = h('input', { class: 'input score-input', type: 'number', inputmode: 'numeric', min: 0, max: 999, placeholder: '–', 'aria-label': t('scoreFor', { team: ctx.game.teamB }), value: editing && round.scoreB !== null ? String(round.scoreB) : '' });
    // A typed score picks the winner.
    const fromScore = () => {
        const a = scoreA.value === '' ? null : Number(scoreA.value);
        const b = scoreB.value === '' ? null : Number(scoreB.value);
        if (a !== null && b !== null && a !== b) { winner = a > b ? 0 : 1; draw(); }
    };
    scoreA.addEventListener('input', fromScore);
    scoreB.addEventListener('input', fromScore);

    const tournaments = (ctx.tournaments || []).filter((x) => !x.endedAt || x.id === (round?.tournamentId ?? tournamentId));
    const tourSelect = h('select', { class: 'input' },
        h('option', { value: '' }, t('noTournament')),
        tournaments.map((x) => h('option', { value: x.id, selected: x.id === (editing ? round.tournamentId : tournamentId) }, x.name)));

    const newName = h('input', { class: 'input', placeholder: t('addPlayerPlaceholder'), maxlength: 40 });
    const saveBtn = h('button', { type: 'button', class: 'btn', onclick: save }, editing ? t('save') : t('saveRound'));

    function teamIds(i) {
        return players.filter((p) => assign.get(p.id) === i).map((p) => p.id);
    }

    function draw() {
        chips.replaceChildren(...players.map((p) => {
            const team = assign.get(p.id);
            return h('button', {
                type: 'button',
                class: `pchip ${team === 0 ? 'team-0' : team === 1 ? 'team-1' : ''}`,
                'aria-pressed': String(team !== undefined),
                onclick: () => {
                    if (team === undefined) assign.set(p.id, 0);
                    else if (team === 0) assign.set(p.id, 1);
                    else assign.delete(p.id);
                    draw();
                },
            }, p.name, team !== undefined && h('span', { class: 'chip-team' }, team === 0 ? ctx.game.teamA : ctx.game.teamB));
        }));
        const a = teamIds(0);
        const b = teamIds(1);
        const ready = a.length > 0 && b.length > 0;
        const prob = ready ? winProbability(a.map(ratingOf), b.map(ratingOf)) : null;
        const names = (ids) => (ids.length ? ids.map((id) => playerName(ctx, id)).join(', ') : t('tapToAdd'));
        summary.replaceChildren(
            h('div', { class: 'mteam mteam-0' }, h('strong', null, ctx.game.teamA), h('span', null, names(a))),
            h('div', { class: 'mvs' }, prob === null ? t('vs') : `${Math.round(prob * 100)}–${100 - Math.round(prob * 100)} %`),
            h('div', { class: 'mteam mteam-1' }, h('strong', null, ctx.game.teamB), h('span', null, names(b))));
        winA.textContent = t('teamWon', { team: ctx.game.teamA });
        winB.textContent = t('teamWon', { team: ctx.game.teamB });
        winA.classList.toggle('on', winner === 0);
        winB.classList.toggle('on', winner === 1);
        saveBtn.disabled = !(ready && winner !== null);
    }

    async function addPlayer(e) {
        e.preventDefault();
        const name = newName.value.trim();
        if (!name) return;
        let p;
        try {
            p = await gapi(gid, 'POST', '/players', { name });
        } catch (err) {
            if (err.status !== 409) return errorToast(err);
            // Someone already added them: pick that player instead.
            const fresh = await gapi(gid, 'GET', '').catch(() => null);
            p = fresh?.players.find((x) => x.name.toLowerCase() === name.toLowerCase());
            if (!p) return toast(t('nameTaken'));
        }
        if (!ctx.playersById.has(p.id)) {
            ctx.players.push(p);
            ctx.playersById.set(p.id, p);
        }
        if (!players.some((x) => x.id === p.id)) players = [...players, p];
        if (!assign.has(p.id)) assign.set(p.id, teamIds(0).length <= teamIds(1).length ? 0 : 1);
        newName.value = '';
        draw();
    }

    function sameAsLast() {
        if (!lastRound) return;
        assign.clear();
        for (const p of lastRound.players) if (ctx.playersById.get(p.id) && !ctx.playersById.get(p.id).archived) assign.set(p.id, p.team);
        winner = null;
        draw();
    }

    function swapTeams() {
        for (const [id, team] of assign) assign.set(id, 1 - team);
        if (winner !== null) winner = 1 - winner;
        draw();
    }

    function balance() {
        const ids = [...assign.keys()];
        if (ids.length < 2) return toast(t('pickPlayersFirst'));
        if (ids.length > 14) return toast(t('tooManyToBalance'));
        const [a, b] = balanceTeams(ids.map((id) => ({ id, ...ratingOf(id) })));
        assign.clear();
        for (const p of a) assign.set(p.id, 0);
        for (const p of b) assign.set(p.id, 1);
        winner = null;
        draw();
    }

    async function save() {
        const body = {
            teams: [teamIds(0), teamIds(1)],
            winner,
            scoreA: scoreA.value === '' ? null : Number(scoreA.value),
            scoreB: scoreB.value === '' ? null : Number(scoreB.value),
            tournamentId: tourSelect.value || null,
        };
        saveBtn.disabled = true;
        try {
            if (editing) {
                await gapi(gid, 'PATCH', `/rounds/${round.id}`, body);
                dialog.close();
                toast(t('roundUpdated'));
            } else {
                const created = await gapi(gid, 'POST', `/games/${ctx.game.id}/rounds`, body);
                dialog.close();
                const winners = body.teams[winner].map((id) => playerName(ctx, id)).join(' & ');
                toast(t('roundSaved', { winners }), { label: t('undo'), run: async () => {
                    try { await gapi(gid, 'DELETE', `/rounds/${created.id}`); onSaved?.(); } catch (err) { errorToast(err); }
                } });
            }
            onSaved?.();
        } catch (err) {
            saveBtn.disabled = false;
            errorToast(err);
        }
    }

    async function remove() {
        if (!confirm(t('deleteRoundConfirm'))) return;
        try {
            await gapi(gid, 'DELETE', `/rounds/${round.id}`);
            dialog.close();
            toast(t('roundDeleted'), { label: t('undo'), run: async () => {
                try { await gapi(gid, 'POST', `/rounds/${round.id}/restore`); onSaved?.(); } catch (err) { errorToast(err); }
            } });
            onSaved?.();
        } catch (err) { errorToast(err); }
    }

    const dialog = h('dialog', { class: 'sheet round-sheet' },
        h('div', { class: 'sheet-body' },
            h('div', { class: 'sheet-head' },
                h('h2', null, editing ? t('editRound') : t('newRound')),
                iconButton('x', t('close'), () => dialog.close(), 'small')),
            h('p', { class: 'muted small' }, t('tapHint', { a: ctx.game.teamA, b: ctx.game.teamB })),
            chips,
            h('form', { class: 'row', onsubmit: addPlayer }, newName, h('button', { class: 'btn ghost' }, icon('plus'), t('add'))),
            h('div', { class: 'row wrap-row tools' },
                !editing && lastRound && h('button', { type: 'button', class: 'btn ghost small', onclick: sameAsLast }, icon('repeat'), t('sameAsLast')),
                h('button', { type: 'button', class: 'btn ghost small', onclick: balance }, icon('shuffle'), t('balance')),
                h('button', { type: 'button', class: 'btn ghost small', onclick: swapTeams }, t('swap')),
                h('button', { type: 'button', class: 'btn ghost small', onclick: () => { assign.clear(); winner = null; draw(); } }, t('clear'))),
            summary,
            h('div', { class: 'winners' }, winA, winB),
            h('div', { class: 'row score-row' },
                h('span', { class: 'muted small' }, t('scoreOptional')), scoreA, h('span', null, '–'), scoreB),
            tournaments.length > 0 && h('label', { class: 'field' }, h('span', null, t('tournament')), tourSelect),
            h('div', { class: 'sheet-actions' },
                editing && h('button', { type: 'button', class: 'btn ghost danger', onclick: remove }, t('delete')),
                h('span', { class: 'spacer' }),
                h('button', { type: 'button', class: 'btn ghost', onclick: () => dialog.close() }, t('cancel')),
                saveBtn)));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    draw();
    dialog.showModal();
    // The page's player list can be a minute old (or older than a player
    // someone just added): merge in the current one.
    gapi(gid, 'GET', '').then((fresh) => {
        let added = false;
        for (const p of fresh.players) {
            if (ctx.playersById.has(p.id)) continue;
            ctx.players.push(p);
            ctx.playersById.set(p.id, p);
            if (!p.archived) players.push(p);
            added = true;
        }
        if (added && dialog.open) draw();
    }).catch(() => {});
}

// ---- group settings -----------------------------------------------------------

function switchEl(checked, disabled, onchange) {
    const input = h('input', { type: 'checkbox', checked, disabled, onchange: () => onchange(input.checked) });
    return h('label', { class: 'switch' }, input, h('span'));
}

async function pageGroupSettings(gid, current) {
    const ctx = await loadGroup(gid);
    const devices = ctx.me.admin ? (await gapi(gid, 'GET', '/devices')).devices : [];
    if (!current()) return;
    document.title = `${t('groupSettings')} · ${ctx.group.name}`;
    const admin = ctx.me.admin;
    const refresh = () => pageGroupSettings(gid, current);
    const patch = async (path, body, msg) => {
        try {
            await gapi(gid, 'PATCH', path, body);
            if (msg) toast(msg);
            refresh();
        } catch (err) { errorToast(err); }
    };
    const nameInput = h('input', { class: 'input', value: ctx.group.name, maxlength: 40, disabled: !admin });

    const playerRows = ctx.players.map((p) => {
        const mine = p.id === ctx.me.playerId;
        const can = admin || mine;
        return h('li', { class: `list-row ${p.archived ? 'faded' : ''}` },
            h('span', null, p.name, mine && h('span', { class: 'chip' }, t('you'))),
            can && h('span', { class: 'row' },
                h('button', { class: 'btn ghost small', type: 'button', onclick: () => {
                    const name = prompt(t('rename'), p.name);
                    if (name) patch(`/players/${p.id}`, { name });
                } }, t('rename')),
                h('button', { class: 'btn ghost small', type: 'button', onclick: () => patch(`/players/${p.id}`, { archived: !p.archived }) },
                    p.archived ? t('unarchive') : t('archive'))));
    });

    const gameRows = ctx.games.map((g) => h('li', { class: `list-row ${g.archived ? 'faded' : ''}` },
        h('span', null, g.name, h('span', { class: 'muted small' }, ` · ${g.teamA} / ${g.teamB}`)),
        admin && h('span', { class: 'row wrap-row' },
            h('button', { class: 'btn ghost small', type: 'button', onclick: () => {
                const name = prompt(t('rename'), g.name);
                if (name) patch(`/games/${g.id}`, { name });
            } }, t('rename')),
            h('button', { class: 'btn ghost small', type: 'button', onclick: () => {
                const a = prompt(t('teamNames', { n: 1 }), g.teamA);
                if (!a) return;
                const b = prompt(t('teamNames', { n: 2 }), g.teamB);
                if (b) patch(`/games/${g.id}`, { teamA: a, teamB: b });
            } }, t('teams')),
            h('button', { class: 'btn ghost small', type: 'button', onclick: () => patch(`/games/${g.id}`, { recalculate: true }, t('recalculated')) }, t('recalculate')),
            h('button', { class: 'btn ghost small', type: 'button', onclick: () => patch(`/games/${g.id}`, { archived: !g.archived }) },
                g.archived ? t('unarchive') : t('archive')))));

    const deviceRows = devices.map((d) => h('li', { class: 'list-row' },
        h('span', null, d.playerId ? playerName(ctx, d.playerId) : t('unnamedDevice'),
            d.me && h('span', { class: 'chip' }, t('thisDevice')),
            h('span', { class: 'muted small' }, ` · ${new Date(d.createdAt).toLocaleDateString(locale())}`)),
        h('span', { class: 'row' },
            h('span', { class: 'muted small' }, t('admin')),
            switchEl(d.admin || ctx.group.everyoneAdmin, ctx.group.everyoneAdmin || d.me, (v) => patch(`/devices/${d.id}`, { admin: v })),
            !d.me && iconButton('x', t('removeDevice'), async () => {
                if (!confirm(t('removeDeviceConfirm'))) return;
                try { await gapi(gid, 'DELETE', `/devices/${d.id}`); refresh(); } catch (err) { errorToast(err); }
            }, 'small danger'))));

    render(
        topbar({ back: `/g/${gid}`, title: t('groupSettings') }),
        h('main', { class: 'wrap narrow' },
            h('section', { class: 'card pad' }, h('h2', null, t('group')),
                h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); patch('', { name: nameInput.value }, t('saved')); } },
                    nameInput, admin && h('button', { class: 'btn ghost' }, t('save'))),
                h('p', { class: 'muted small' }, admin ? t('youAreAdmin') : t('youAreNotAdmin'))),
            h('section', { class: 'card pad' }, h('h2', null, t('permissions')),
                h('div', { class: 'setting' },
                    h('div', null, h('strong', null, t('everyoneAdmin')), h('p', { class: 'muted small' }, t('everyoneAdminHint'))),
                    switchEl(ctx.group.everyoneAdmin, !admin, (v) => patch('', { everyoneAdmin: v }))),
                h('div', { class: 'setting stack-setting' },
                    h('div', null, h('strong', null, t('whoCanEdit')), h('p', { class: 'muted small' }, t('whoCanEditHint'))),
                    admin
                        ? segmented([['anyone', t('editAnyone')], ['admin', t('editAdmins')]], ctx.group.editPolicy, (v) => patch('', { editPolicy: v }))
                        : h('span', { class: 'chip' }, ctx.group.editPolicy === 'anyone' ? t('editAnyone') : t('editAdmins')))),
            inviteCard(gid, ctx),
            admin && h('section', { class: 'card pad' }, h('h2', null, t('inviteCode')),
                h('p', { class: 'muted small' }, t('rotateHint')),
                h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
                    if (!confirm(t('rotateConfirm'))) return;
                    try { await gapi(gid, 'POST', '/invite'); toast(t('rotated')); refresh(); } catch (err) { errorToast(err); }
                } }, t('rotate'))),
            h('section', { class: 'card pad' }, h('h2', null, t('players')), h('ul', { class: 'list' }, playerRows)),
            h('section', { class: 'card pad' }, h('h2', null, t('games')), h('ul', { class: 'list' }, gameRows)),
            admin && h('section', { class: 'card pad' }, h('h2', null, t('devices')), h('p', { class: 'muted small' }, t('devicesHint')),
                h('ul', { class: 'list' }, deviceRows)),
            h('section', { class: 'card pad danger-zone' }, h('h2', null, t('dangerZone')),
                h('div', { class: 'row wrap-row' },
                    h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
                        if (!confirm(t('leaveConfirm'))) return;
                        try { await gapi(gid, 'DELETE', `/devices/${ctx.me.deviceId}`); } catch { /* leaving anyway */ }
                        forgetGroup(gid);
                        navigate('/', true);
                    } }, t('leaveGroup')),
                    admin && h('button', { class: 'btn ghost danger', type: 'button', onclick: async () => {
                        const typed = prompt(t('deleteGroupConfirm', { name: ctx.group.name }));
                        if (typed !== ctx.group.name) return;
                        try { await gapi(gid, 'DELETE', ''); forgetGroup(gid); navigate('/', true); } catch (err) { errorToast(err); }
                    } }, t('deleteGroup'))))));
}

// ---- poster -------------------------------------------------------------------

async function pagePoster(gid, current) {
    const ctx = await loadGroup(gid);
    if (!current()) return;
    const url = joinUrl(ctx.group.inviteCode);
    document.title = `${ctx.group.name} · ${t('poster')}`;
    render(
        topbar({ back: `/g/${gid}`, title: t('poster'), actions: [
            iconButton('share', t('share'), () => share(ctx.group.name, t('shareText', { group: ctx.group.name }), url)),
            iconButton('printer', t('print'), () => print()),
        ] }),
        h('main', { class: 'poster' },
            h('h1', null, ctx.group.name),
            h('p', { class: 'poster-sub' }, t('posterScan')),
            qrSvg(url),
            h('p', { class: 'poster-code' }, ctx.group.inviteCode),
            h('p', { class: 'poster-url' }, url.replace(/^https?:\/\//, ''))));
}

// ---- boot ---------------------------------------------------------------------

applyI18n();
route();

if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}

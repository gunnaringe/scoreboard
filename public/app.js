// Single-page app: routes on location.pathname (the Worker serves index.html
// for every non-API path). Render user text with textContent only — h() does
// that for strings; never build markup from names.

import {
    displayRating, displayDelta, winProbability, balanceTeams, newRating, PROVISIONAL_ROUNDS, SCALE,
} from './rating.js';
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
        else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'open') el[k] = v;
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
    printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>',
    trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
    shuffle: '<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    swap: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    tv: '<rect width="20" height="15" x="2" y="7" rx="2"/><path d="m17 2-5 5-5-5"/>',
    mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-10 5L2 7"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
};

function icon(name) {
    const span = document.createElement('span');
    span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
    return span.firstChild;
}

let uid = 0;
const newDomId = () => `x${++uid}`;

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
    saveGroups([entry, ...myGroups().filter((g) => g.id !== entry.id)]);
}
function updateGroupEntry(id, patch) {
    saveGroups(myGroups().map((g) => (g.id === id ? { ...g, ...patch } : g)));
}
function forgetGroup(id) {
    saveGroups(myGroups().filter((g) => g.id !== id));
    if ((localStorage.getItem('lastPath') || '').startsWith(`/g/${id}`)) localStorage.removeItem('lastPath');
}
const tokenFor = (gid) => myGroups().find((g) => g.id === gid)?.token;

// ---- API ----------------------------------------------------------------------

class ApiError extends Error {
    constructor(status, message, data) {
        super(message);
        this.status = status;
        this.data = data;
    }
}

const ERRORS = { 'too many requests, wait a minute': 'errRateLimit', 'too many attempts, wait a minute': 'errJoinLimit', 'limit reached': 'errLimit', 'too far back to change': 'errTooFarBack' };

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
    if (!res.ok) throw new ApiError(res.status, ERRORS[data.error] ? t(ERRORS[data.error]) : data.error || res.statusText, data);
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
            navigate('/?home', true);
        }
        throw err;
    }
}

// ---- routing ------------------------------------------------------------------

let pollTimer = null;
let pollFn = null;
let routeSeq = 0;
// Bumped by every page load/refresh; a slower, older refresh must not draw
// over a newer one.
let loadSeq = 0;
let wakeLock = null;

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
    [/^\/o\/([\w-]+)$/, pageOwnerLink],
    [/^\/d\/(\w+)$/, pageDashboard],
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
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    document.querySelectorAll('dialog').forEach((d) => d.remove());
    const seq = ++routeSeq;
    const path = location.pathname.replace(/\/+$/, '') || '/';
    // Opening the app goes back to where you were; "/?home" shows the start page.
    if (path === '/' && !new URLSearchParams(location.search).has('home')) {
        const last = localStorage.getItem('lastPath');
        if (last && tokenFor(last.split('/')[2])) return navigate(last, true);
    }
    for (const [pattern, page] of ROUTES) {
        const m = path.match(pattern);
        if (!m) continue;
        if (path.startsWith('/g/')) {
            if (!tokenFor(m[1])) return navigate('/?home', true);
            localStorage.setItem('lastPath', path);
        }
        // The old page stays visible while the next one loads, but can't be used.
        app.inert = true;
        app.classList.add('loading');
        try {
            await page(...m.slice(1), () => seq === routeSeq);
        } catch (err) {
            if (seq !== routeSeq || err.status === 401) return;
            render(topbar({ back: '/?home' }), h('main', { class: 'wrap narrow' },
                h('div', { class: 'card empty' }, h('p', null, err.status === 404 ? t('notFound') : err.message),
                    h('a', { class: 'btn', href: '/?home' }, t('home')))));
        }
        return;
    }
    navigate('/?home', true);
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

function poll(fn, ms = 60000) {
    clearInterval(pollTimer);
    pollFn = fn;
    pollTimer = setInterval(() => {
        if (document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) fn();
    }, ms);
}
// Polling screens ask for the game's version (2–3 rows read) and only reload
// the page (hundreds of rows on a busy day) when a rating write changed it, at
// midnight so "today" resets, and every 40th check for names and tournaments.
// A wall screen stays around 1–2 % of the account's daily D1 read quota.
let shownVersion = null;
function pollVersion(fetchVersion, refresh, ms) {
    let ticks = 0;
    let day = startOfToday();
    poll(async () => {
        ticks++;
        try {
            const { version } = await fetchVersion();
            if (version !== shownVersion || ticks % 40 === 0 || day !== startOfToday()) {
                day = startOfToday();
                refresh();
            }
        } catch { /* offline: try again next time */ }
    }, ms);
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pollTimer && !document.querySelector('dialog[open]')) pollFn();
});

// ---- shared bits --------------------------------------------------------------

function topbar({ back, title, actions = [] } = {}) {
    return h('header', { class: 'topbar' },
        back
            ? h('a', { class: 'icon-btn', href: back, 'aria-label': t('back'), title: t('back') }, icon('back'))
            : h('a', { class: 'brand', href: '/?home' }, h('span', { class: 'brand-dot' }), t('appName')),
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

const officeUrl = (code) => `${location.origin}/j/${code}`;
const dashboardUrl = (token) => `${location.origin}/d/${token}`;
const ownerUrl = (token) => `${location.origin}/o/${token}`;

async function share(title, text, url) {
    if (navigator.share) {
        try {
            await navigator.share({ title, text, url });
            return;
        } catch (err) {
            if (err.name === 'AbortError') return;
        }
    }
    await copy(url);
}

async function copy(text) {
    try {
        await navigator.clipboard.writeText(text);
        toast(t('linkCopied'));
    } catch {
        prompt(t('copyThisLink'), text);
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
    svg.setAttribute('aria-label', t('qrFor', { url: text }));
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

const roundDelta = (p) => (p.before && p.after ? displayDelta(p.before, p.after) : 0);
const playerName = (ctx, id) => ctx.playersById.get(id)?.name ?? '?';
const teamName = (game, i) => (i === 0 ? game.teamA || t('teamBlue') : game.teamB || t('teamOrange'));

// A dialog that labels itself, closes on Escape/backdrop and removes itself.
function sheet(title, ...content) {
    const id = newDomId();
    const dialog = h('dialog', { class: 'sheet', 'aria-labelledby': id },
        h('div', { class: 'sheet-body' },
            h('div', { class: 'sheet-head' }, h('h2', { id, tabindex: '-1' }, title),
                iconButton('x', t('close'), () => dialog.close(), 'small')),
            ...content));
    dialog.addEventListener('close', () => dialog.remove());
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    document.body.append(dialog);
    dialog.showModal();
    dialog.querySelector('h2').focus();
    return dialog;
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

// ---- pages: home, joining, owner link, app settings ---------------------------

async function pageHome() {
    document.title = t('appName');
    const groups = myGroups();
    const codeInput = h('input', { class: 'input code-input', placeholder: 'ABCD-EFGH', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', 'aria-label': t('officeCode') });
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
            const next = res.gameId ? `/g/${res.groupId}/game/${res.gameId}` : `/g/${res.groupId}`;
            navigate(next);
            ownerLinkDialog(res.ownerToken, { created: true });
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
    if (known) {
        // Already a member: scanning the poster again opens the game.
        const last = localStorage.getItem('lastPath');
        return navigate(last?.startsWith(`/g/${known.id}`) ? last : `/g/${known.id}`, true);
    }
    try {
        const res = await api('POST', '/join', { code });
        rememberGroup({ id: res.groupId, name: res.name, token: res.token, code: pretty });
        navigate(`/g/${res.groupId}?welcome`, true);
    } catch (err) {
        if (err.status !== 404) return errorToast(err);
        if (!location.pathname.startsWith('/j/')) return toast(t('unknownCode'));
        render(topbar({ back: '/?home' }), h('main', { class: 'wrap narrow' }, h('div', { class: 'card empty' },
            h('h2', null, t('staleCodeTitle')), h('p', null, t('staleCodeText')), h('a', { class: 'btn', href: '/?home' }, t('home')))));
    }
}

async function pageJoin(code) {
    render(topbar({ back: '/?home' }), h('main', { class: 'wrap narrow' }, h('div', { class: 'card empty' }, h('p', null, t('joining')))));
    await joinWithCode(code);
}

// Opening the owner link: this browser becomes an owner of the group.
async function pageOwnerLink(token) {
    render(topbar({ back: '/?home' }), h('main', { class: 'wrap narrow' }, h('div', { class: 'card empty' }, h('p', null, t('joining')))));
    try {
        const res = await api('POST', '/owner', { token, tokens: myGroups().map((g) => g.token) });
        if (res.token) rememberGroup({ id: res.groupId, name: res.name, token: res.token });
        toast(t('nowOwner', { group: res.name }));
        navigate(`/g/${res.groupId}/settings`, true);
    } catch (err) {
        render(topbar({ back: '/?home' }), h('main', { class: 'wrap narrow' }, h('div', { class: 'card empty' },
            h('h2', null, err.status === 404 ? t('staleOwnerTitle') : err.message),
            err.status === 404 && h('p', null, t('staleOwnerText')), h('a', { class: 'btn', href: '/?home' }, t('home')))));
    }
}

function ownerLinkDialog(token, { created = false } = {}) {
    const url = ownerUrl(token);
    const mail = `mailto:?subject=${encodeURIComponent(t('ownerMailSubject'))}&body=${encodeURIComponent(t('ownerMailBody', { url }))}`;
    sheet(created ? t('groupCreated') : t('newOwnerLink'),
        h('p', null, t('ownerLinkIntro')),
        h('input', { class: 'input mono', value: url, readonly: true, 'aria-label': t('ownerLink'), onfocus: (e) => e.target.select() }),
        h('div', { class: 'row wrap-row' },
            h('button', { class: 'btn', type: 'button', onclick: () => copy(url) }, icon('copy'), t('copy')),
            h('a', { class: 'btn ghost', href: mail }, icon('mail'), t('emailToMe')),
            h('button', { class: 'btn ghost', type: 'button', onclick: () => share(t('ownerLink'), t('ownerLink'), url) }, icon('share'), t('share'))),
        h('p', { class: 'muted small' }, t('ownerLinkWarning')));
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
        topbar({ back: '/?home', title: t('settings') }),
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
            h('section', { class: 'card pad' }, h('h2', null, t('aboutRatingTitle')), ratingExplainer())));
}

function ratingExplainer() {
    return h('div', { class: 'prose' },
        h('p', null, t('ratingInfo1')),
        h('p', null, t('ratingInfo2', { n: PROVISIONAL_ROUNDS })),
        h('p', null, t('ratingInfo3')),
        h('p', { class: 'muted small' }, t('ratingInfo4')));
}

// ---- who am I -----------------------------------------------------------------

function whoAmI(gid, ctx, onDone) {
    const active = ctx.players.filter((p) => !p.archived);
    const nameInput = h('input', { class: 'input', placeholder: t('yourNamePlaceholder'), maxlength: 40, 'aria-label': t('yourNamePlaceholder') });
    const done = () => { dialog.close(); onDone(); };
    const choose = async (playerId) => {
        try {
            await gapi(gid, 'PUT', '/me', { playerId });
            done();
        } catch (err) { errorToast(err); }
    };
    const dialog = sheet(t('whoAreYou'),
        active.length > 0 && h('p', { class: 'muted small' }, t('whoAreYouHint')),
        active.length > 0 && h('div', { class: 'chips' }, active.map((p) => h('button', {
            type: 'button', class: `pchip ${p.id === ctx.me.playerId ? 'sel' : ''}`, onclick: () => choose(p.id),
        }, p.name))),
        h('form', { class: 'row', onsubmit: async (e) => {
            e.preventDefault();
            try {
                await gapi(gid, 'POST', '/players', { name: nameInput.value, me: true });
                done();
            } catch (err) {
                if (err.status === 409 && err.data?.player) return choose(err.data.player.id);
                errorToast(err);
            }
        } }, nameInput, h('button', { class: 'btn' }, active.length ? t('imNew') : t('add'))),
        h('div', { class: 'sheet-actions' },
            ctx.me.playerId && h('button', { type: 'button', class: 'btn ghost', onclick: () => choose(null) }, t('notAPlayer')),
            h('button', { type: 'button', class: 'btn ghost', onclick: done }, t('skip'))));
}

// ---- group page ---------------------------------------------------------------

function officeLinkCard(gid, ctx) {
    const url = officeUrl(ctx.group.inviteCode);
    return h('section', { class: 'card pad invite' },
        h('div', { class: 'invite-text' },
            h('h2', null, t('officeLink')),
            h('p', { class: 'muted' }, t('officeLinkHint')),
            h('div', { class: 'code' }, ctx.group.inviteCode),
            h('div', { class: 'row wrap-row' },
                h('button', { class: 'btn', type: 'button', onclick: () => share(ctx.group.name, t('shareText', { group: ctx.group.name }), url) }, icon('share'), t('share')),
                h('a', { class: 'btn ghost', href: `/g/${gid}/poster` }, icon('printer'), t('poster')))),
        h('a', { class: 'invite-qr', href: `/g/${gid}/poster`, 'aria-label': t('poster') }, qrSvg(url)));
}

function dashboardLinkCard(ctx) {
    const url = dashboardUrl(ctx.group.dashboardToken);
    return h('section', { class: 'card pad' },
        h('h2', null, t('dashboardLink')),
        h('p', { class: 'muted' }, t('dashboardLinkHint')),
        h('div', { class: 'row wrap-row' },
            h('a', { class: 'btn ghost', href: url, target: '_blank', rel: 'noopener' }, icon('tv'), t('openDashboard')),
            h('button', { class: 'btn ghost', type: 'button', onclick: () => share(ctx.group.name, t('dashboardShareText', { group: ctx.group.name }), url) }, icon('share'), t('share'))));
}

async function pageGroup(gid, current) {
    const ctx = await loadGroup(gid);
    if (!current()) return;
    document.title = `${ctx.group.name} · ${t('appName')}`;
    const games = ctx.games.filter((g) => !g.archived);
    const gameName = h('input', { class: 'input', placeholder: t('gameNamePlaceholder'), maxlength: 40, 'aria-label': t('gameNamePlaceholder') });
    const me = ctx.playersById.get(ctx.me.playerId);
    const welcome = new URLSearchParams(location.search).has('welcome');

    render(
        topbar({ back: '/?home', title: ctx.group.name, actions: [
            iconButton('share', t('share'), () => share(ctx.group.name, t('shareText', { group: ctx.group.name }), officeUrl(ctx.group.inviteCode))),
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
            officeLinkCard(gid, ctx),
            dashboardLinkCard(ctx)));

    if (welcome) {
        history.replaceState(null, '', `/g/${gid}`);
        whoAmI(gid, ctx, () => (games.length === 1 ? navigate(`/g/${gid}/game/${games[0].id}`, true) : route()));
    }
}

// ---- leaderboard and rounds (shared with the dashboard) -----------------------

// ctx: { game, ratings (Map), playersById, me? }. hrefFor(playerId) or null.
function leaderboard(ctx, todayRounds, hrefFor, { big = false } = {}) {
    // Skill estimate before each player's first round today, for "today".
    const startOfDay = new Map();
    for (const r of [...todayRounds].reverse()) {
        for (const p of r.players) if (!startOfDay.has(p.id) && p.before) startOfDay.set(p.id, p.before);
    }
    const rows = [...ctx.ratings.values()]
        .filter((r) => ctx.playersById.get(r.playerId) && !ctx.playersById.get(r.playerId).archived)
        .map((r) => ({ ...r, display: displayRating(r) }));
    const ranked = rows.filter((r) => r.rounds >= PROVISIONAL_ROUNDS).sort((a, b) => b.display - a.display || b.wins - a.wins);
    const fresh = rows.filter((r) => r.rounds < PROVISIONAL_ROUNDS).sort((a, b) => b.rounds - a.rounds || b.display - a.display);
    if (!rows.length) return h('p', { class: 'muted empty-small' }, t('noRoundsYet'));
    const nameCell = (r) => {
        const name = playerName(ctx, r.playerId);
        return h('td', { class: 'name' },
            hrefFor ? h('a', { href: hrefFor(r.playerId) }, name) : name,
            h('span', { class: 'sub' }, t('wlShort', { w: r.wins, l: r.rounds - r.wins })));
    };
    const todayCell = (r) => {
        const start = startOfDay.get(r.playerId);
        return h('td', { class: 'num' }, start ? deltaEl(Math.round(SCALE * (r.mu - start.mu))) : '');
    };
    const rowProps = (r, cls) => ({
        class: `${cls} ${r.playerId === ctx.me?.playerId ? 'me' : ''} ${hrefFor ? 'clickable' : ''}`,
        onclick: hrefFor ? (e) => { if (!e.target.closest('a')) navigate(hrefFor(r.playerId)); } : null,
    });
    return h('div', { class: `board-wrap ${big ? 'big' : ''}` },
        ranked.length > 0 && h('table', { class: 'board' },
            h('thead', null, h('tr', null,
                h('th', { class: 'num' }, h('span', { class: 'sr-only' }, t('rank')), '#'), h('th', null, t('player')),
                h('th', { class: 'num' }, t('rating')), h('th', { class: 'num' }, t('todayShort')))),
            h('tbody', null, ranked.map((r, i) => h('tr', rowProps(r, i < 3 ? `top top${i + 1}` : ''),
                h('td', { class: 'num rank' }, i + 1), nameCell(r), h('td', { class: 'num rating' }, r.display), todayCell(r))))),
        fresh.length > 0 && h('div', { class: 'fresh' },
            h('h3', null, t('newPlayers'), h('span', { class: 'muted small' }, ` · ${t('newPlayersHint', { n: PROVISIONAL_ROUNDS })}`)),
            h('table', { class: 'board compact' }, h('tbody', null, fresh.map((r) => h('tr', rowProps(r, 'provisional'),
                nameCell(r),
                h('td', { class: 'num muted' }, t('toGo', { n: PROVISIONAL_ROUNDS - r.rounds })),
                h('td', { class: 'num rating' }, r.display), todayCell(r)))))));
}

function roundItem(ctx, round, { showDay = false, onEdit } = {}) {
    const team = (i) => round.players.filter((p) => p.team === i);
    const names = (i) => team(i).map((p) => playerName(ctx, p.id)).join(', ');
    const side = (i) => h('div', { class: `side side-${i} ${round.winner === i ? 'won' : ''}` },
        round.winner === i && h('span', { class: 'win-mark' }, icon('trophy'), t('win')),
        team(i).map((p) => h('span', { class: 'who' }, h('span', { class: 'pname' }, playerName(ctx, p.id)), deltaEl(roundDelta(p), 'small'))));
    const hasScore = round.scoreA !== null && round.scoreB !== null;
    const tour = round.tournamentId && ctx.tournaments?.find((x) => x.id === round.tournamentId);
    const when = showDay ? `${fmtDay(round.playedAt)} ${fmtTime(round.playedAt)}` : fmtTime(round.playedAt);
    const label = t('roundAria', { winners: names(round.winner), losers: names(1 - round.winner), when })
        + (hasScore ? `, ${round.scoreA}–${round.scoreB}` : '');
    return h('li', null, h(onEdit ? 'button' : 'div', {
        class: 'round', type: onEdit ? 'button' : null, 'aria-label': label,
        onclick: onEdit ? () => onEdit(round) : null,
    },
    side(0),
    h('div', { class: 'mid', 'aria-hidden': 'true' },
        hasScore && h('span', { class: 'score' }, `${round.scoreA}–${round.scoreB}`),
        h('span', { class: 'when' }, when),
        tour && h('span', { class: 'tour' }, icon('trophy'), tour.name)),
    side(1)));
}

function roundList(ctx, rounds, opts = {}) {
    if (!rounds.length) return h('p', { class: 'muted empty-small' }, opts.empty || t('noRoundsToday'));
    const items = [];
    let lastDay = null;
    for (const r of rounds) {
        if (opts.groupByDay) {
            const day = fmtDay(r.playedAt);
            if (day !== lastDay) items.push(h('li', { class: 'day' }, day));
            lastDay = day;
        }
        items.push(roundItem(ctx, r, opts));
    }
    return h('ul', { class: 'rounds' }, items);
}

function teamLegend(game) {
    return h('div', { class: 'team-legend' },
        h('span', { class: 'tl tl-0' }, teamName(game, 0)), h('span', { class: 'muted' }, t('vs')), h('span', { class: 'tl tl-1' }, teamName(game, 1)));
}

function ratingInfoButton() {
    return iconButton('info', t('aboutRatingTitle'), () => sheet(t('aboutRatingTitle'), ratingExplainer()), 'small');
}

// ---- game page ----------------------------------------------------------------

async function loadGame(gid, gameId) {
    const [ctx, data] = await Promise.all([
        loadGroup(gid),
        gapi(gid, 'GET', `/games/${gameId}?since=${startOfToday()}`),
    ]);
    return withGameData(ctx, data);
}

function withGameData(ctx, data) {
    ctx.game = data.game;
    ctx.tournaments = data.tournaments;
    ctx.rounds = data.rounds;
    ctx.ratings = new Map(data.ratings.map((r) => [r.playerId, r]));
    ctx.handicaps = new Map(data.handicaps.map((x) => [x.format, x]));
    ctx.version = data.version;
    return ctx;
}

// iPhone Safari forgets sites after 7 days unless they're on the home screen.
function homeScreenNudge() {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    if (!ios || navigator.standalone || localStorage.getItem('a2hsDismissed')) return null;
    const el = h('section', { class: 'card pad nudge' },
        h('p', null, t('a2hs')),
        h('button', { class: 'btn ghost small', type: 'button', onclick: () => { localStorage.setItem('a2hsDismissed', '1'); el.remove(); } }, t('gotIt')));
    return el;
}

async function pageGame(gid, gameId, current) {
    const seq = ++loadSeq;
    const ctx = await loadGame(gid, gameId);
    if (!current() || seq !== loadSeq) return;
    document.title = `${ctx.game.name} · ${ctx.group.name}`;
    const today = ctx.rounds.filter((r) => r.playedAt >= startOfToday());
    const recent = today.length ? today : ctx.rounds.slice(0, 5);
    const refresh = () => pageGame(gid, gameId, current);
    const tourName = h('input', { class: 'input', placeholder: t('tournamentPlaceholder'), maxlength: 40, 'aria-label': t('tournamentPlaceholder') });
    const edit = (round) => roundSheet(gid, ctx, { round, onSaved: refresh });
    const empty = !ctx.rounds.length;

    (pollTimer ? rerender : render)(
        topbar({ back: `/g/${gid}`, title: ctx.game.name, actions: [
            iconButton('share', t('share'), () => share(ctx.group.name, t('shareText', { group: ctx.group.name }), officeUrl(ctx.group.inviteCode))),
            iconLink('settings', `/g/${gid}/settings`, t('groupSettings')),
        ] }),
        h('main', { class: 'wrap game-grid' },
            h('div', { class: 'main-col' },
                homeScreenNudge(),
                h('section', { class: 'card pad board-card' },
                    h('div', { class: 'section-head' }, h('h2', null, t('leaderboard'), ratingInfoButton()), teamLegend(ctx.game)),
                    empty ? h('p', { class: 'muted empty-small' }, t('emptyGame')) : leaderboard(ctx, today, (pid) => `/g/${gid}/game/${gameId}/p/${pid}`)),
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
            h('div', { class: 'side-col' },
                h('section', { class: 'card pad' },
                    h('div', { class: 'section-head' }, h('h2', null, today.length ? t('today') : t('recent')),
                        h('a', { class: 'btn ghost small', href: `/g/${gid}/game/${gameId}/history` }, icon('history'), t('history'))),
                    roundList(ctx, recent, { showDay: !today.length, onEdit: edit, empty: empty ? t('emptyGameRounds') : undefined }))),
            h('button', { class: 'fab btn', type: 'button', onclick: () => roundSheet(gid, ctx, { onSaved: refresh }) },
                icon('plus'), t('newRound'))));
    shownVersion = ctx.version;
    if (!pollTimer) pollVersion(() => gapi(gid, 'GET', `/games/${gameId}/version`), refresh, 60000);
}

async function pageHistory(gid, gameId, current) {
    const ctx = await loadGame(gid, gameId);
    if (!current()) return;
    document.title = `${t('history')} · ${ctx.game.name}`;
    let rounds = [];
    let next = '';
    const list = h('div');
    const moreBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => load() }, t('loadMore'));
    const redraw = () => list.replaceChildren(roundList(ctx, rounds, { groupByDay: true, empty: t('noRoundsYet'),
        onEdit: (round) => roundSheet(gid, ctx, { round, onSaved: () => pageHistory(gid, gameId, current) }) }));
    async function load() {
        const res = await gapi(gid, 'GET', `/games/${gameId}/rounds?limit=50&before=${next}`);
        rounds = rounds.concat(res.rounds);
        next = res.next || '';
        redraw();
        moreBtn.hidden = !next;
    }
    render(
        topbar({ back: `/g/${gid}/game/${gameId}`, title: `${t('history')} · ${ctx.game.name}` }),
        h('main', { class: 'wrap narrow' }, h('section', { class: 'card pad' }, list, h('div', { class: 'center' }, moreBtn))));
    await load();
}

// All rounds matching a filter, following the paging cursor (bounded).
async function allRounds(gid, gameId, query, maxPages = 10) {
    const out = [];
    let next = '';
    for (let i = 0; i < maxPages; i++) {
        const res = await gapi(gid, 'GET', `/games/${gameId}/rounds?limit=200&${query}&before=${next}`);
        out.push(...res.rounds);
        next = res.next;
        if (!next) break;
    }
    return out;
}

// ---- tournament page ----------------------------------------------------------

async function pageTournament(gid, gameId, tid, current) {
    const seq = ++loadSeq;
    const [ctx, rounds] = await Promise.all([loadGame(gid, gameId), allRounds(gid, gameId, `tournament=${tid}`)]);
    if (!current() || seq !== loadSeq) return;
    const tour = ctx.tournaments.find((x) => x.id === tid);
    if (!tour) throw Object.assign(new Error(t('notFound')), { status: 404 });
    document.title = `${tour.name} · ${ctx.game.name}`;
    const refresh = () => pageTournament(gid, gameId, tid, current);
    const stats = new Map();
    for (const r of rounds) {
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
                    roundList(ctx, rounds, { groupByDay: true, empty: t('noRoundsYet'), onEdit: (round) => roundSheet(gid, ctx, { round, onSaved: refresh }) }))),
            !tour.endedAt && h('button', { class: 'fab btn', type: 'button', onclick: () => roundSheet(gid, ctx, { tournamentId: tid, onSaved: refresh }) },
                icon('plus'), t('newRound'))));
    shownVersion = ctx.version;
    if (!pollTimer) pollVersion(() => gapi(gid, 'GET', `/games/${gameId}/version`), refresh, 60000);
}

// ---- player page --------------------------------------------------------------

function ratingChart(points) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'chart');
    svg.setAttribute('viewBox', '0 0 300 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    if (points.length < 2) return svg;
    const min = Math.min(1000, ...points) - 10;
    const max = Math.max(1000, ...points) + 10;
    const y = (v) => 95 - ((v - min) / (max - min)) * 90;
    const xy = points.map((v, i) => `${((i / (points.length - 1)) * 300).toFixed(1)},${y(v).toFixed(1)}`);
    const base = document.createElementNS(ns, 'line');
    base.setAttribute('x1', 0);
    base.setAttribute('x2', 300);
    base.setAttribute('y1', y(1000));
    base.setAttribute('y2', y(1000));
    base.setAttribute('class', 'baseline');
    base.setAttribute('vector-effect', 'non-scaling-stroke');
    const area = document.createElementNS(ns, 'polygon');
    area.setAttribute('points', `0,100 ${xy.join(' ')} 300,100`);
    area.setAttribute('class', 'area');
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', xy.join(' '));
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(area, base, line);
    svg.setAttribute('aria-label', t('chartAria', { n: points.length - 1, first: points[1], last: points[points.length - 1], min: Math.min(...points), max: Math.max(...points) }));
    return svg;
}

async function pagePlayer(gid, gameId, pid, current) {
    const [ctx, stats] = await Promise.all([loadGame(gid, gameId), gapi(gid, 'GET', `/games/${gameId}/players/${pid}`)]);
    if (!current()) return;
    const player = ctx.playersById.get(pid);
    if (!player) throw Object.assign(new Error(t('notFound')), { status: 404 });
    document.title = `${player.name} · ${ctx.game.name}`;
    const rating = ctx.ratings.get(pid) || { ...newRating(), rounds: 0, wins: 0 };
    const display = displayRating(rating);
    const points = [1000, ...stats.history.map(([, mu, sigma]) => displayRating({ mu, sigma }))];
    const best = points.length > 1 ? Math.max(...points.slice(1)) : null;
    let streak = 0;
    let streakWin = null;
    for (const [, , , won] of [...stats.history].reverse()) {
        if (streakWin === null) streakWin = !!won;
        if (!!won !== streakWin) break;
        streak++;
    }
    const pct = (s) => s.wins / s.games;
    const qualified = (list) => list.filter((s) => s.games >= 3);
    const bestMate = qualified(stats.with).sort((a, b) => pct(b) - pct(a) || b.games - a.games)[0];
    const nemesis = qualified(stats.against).sort((a, b) => pct(a) - pct(b) || b.games - a.games)[0];
    const ranked = [...ctx.ratings.values()].filter((r) => r.rounds >= PROVISIONAL_ROUNDS && !ctx.playersById.get(r.playerId)?.archived)
        .sort((a, b) => displayRating(b) - displayRating(a));
    const rank = ranked.findIndex((r) => r.playerId === pid) + 1;
    const stat = (label, value, sub) => h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, label), h('span', { class: 'stat-value' }, value), sub && h('span', { class: 'stat-sub' }, sub));
    const h2hTable = (title, list) => list.length > 0 && h('div', null, h('h3', null, title), h('table', { class: 'board compact' },
        h('thead', null, h('tr', null, h('th', null, t('player')), h('th', { class: 'num' }, t('roundsShort')), h('th', { class: 'num' }, t('wl')), h('th', { class: 'num' }, '%'))),
        h('tbody', null, [...list].sort((a, b) => b.games - a.games).map((s) => h('tr', null,
            h('td', { class: 'name' }, h('a', { href: `/g/${gid}/game/${gameId}/p/${s.id}` }, playerName(ctx, s.id))),
            h('td', { class: 'num' }, s.games), h('td', { class: 'num' }, `${s.wins}–${s.games - s.wins}`),
            h('td', { class: 'num muted' }, `${Math.round(pct(s) * 100)} %`))))));

    let rounds = [];
    let next = '';
    const list = h('div');
    const moreBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => loadRounds() }, t('loadMore'));
    async function loadRounds() {
        const res = await gapi(gid, 'GET', `/games/${gameId}/rounds?player=${pid}&limit=30&before=${next}`);
        rounds = rounds.concat(res.rounds);
        next = res.next || '';
        list.replaceChildren(roundList(ctx, rounds, { groupByDay: true, empty: t('noRoundsYet'),
            onEdit: (round) => roundSheet(gid, ctx, { round, onSaved: () => pagePlayer(gid, gameId, pid, current) }) }));
        moreBtn.hidden = !next;
    }

    render(
        topbar({ back: `/g/${gid}/game/${gameId}`, title: `${player.name} · ${ctx.game.name}` }),
        h('main', { class: 'wrap game-grid' },
            h('section', { class: 'card pad board-card' },
                h('div', { class: 'stats' },
                    stat(t('rating'), display, rating.rounds < PROVISIONAL_ROUNDS ? t('toGo', { n: PROVISIONAL_ROUNDS - rating.rounds }) : t('rankOf', { rank, n: ranked.length })),
                    stat(t('rounds'), rating.rounds, rating.rounds ? `${rating.wins}–${rating.rounds - rating.wins} · ${Math.round((rating.wins / rating.rounds) * 100)} %` : ''),
                    stat(t('best'), best ?? '–'),
                    stat(t('streak'), streak ? `${streak} ${streakWin ? t('winLetter') : t('lossLetter')}` : '–')),
                ratingChart(points),
                h('div', { class: 'stats' },
                    bestMate && stat(t('bestTeammate'), playerName(ctx, bestMate.id), `${bestMate.wins}–${bestMate.games - bestMate.wins}`),
                    nemesis && stat(t('nemesis'), playerName(ctx, nemesis.id), `${nemesis.wins}–${nemesis.games - nemesis.wins}`)),
                h('div', { class: 'h2h' }, h2hTable(t('with'), stats.with), h2hTable(t('against'), stats.against))),
            h('div', { class: 'side-col' },
                h('section', { class: 'card pad' }, h('h2', null, t('rounds')), list, h('div', { class: 'center' }, moreBtn)))));
    await loadRounds();
}

// ---- round sheet --------------------------------------------------------------

// Records a new round (or edits `round`). Players sit on the bench until
// tapped onto a team; tapping a team member moves them across, × benches them.
// A new round opens with the last round's line-up, and tapping who won saves.
function roundSheet(gid, ctx, { round = null, tournamentId = null, onSaved }) {
    const editing = !!round;
    const game = ctx.game;
    const assign = new Map(); // playerId -> 0 | 1
    let winner = editing ? round.winner : null;
    const lastRound = ctx.rounds?.[0];
    const usable = (id) => ctx.playersById.get(id) && !ctx.playersById.get(id).archived;
    if (editing) {
        for (const p of round.players) assign.set(p.id, p.team);
    } else if (lastRound) {
        for (const p of lastRound.players) if (usable(p.id)) assign.set(p.id, p.team);
    } else if (ctx.me.playerId && usable(ctx.me.playerId)) {
        assign.set(ctx.me.playerId, 0);
    }

    const ratingOf = (id) => ctx.ratings.get(id) || newRating();
    // Stable order: you first, then alphabetical.
    const order = (a, b) => (b.id === ctx.me.playerId) - (a.id === ctx.me.playerId) || a.name.localeCompare(b.name, locale());
    let players = ctx.players.filter((p) => !p.archived || assign.has(p.id)).sort(order);
    const teamIds = (i) => players.filter((p) => assign.get(p.id) === i).map((p) => p.id);

    const teamBoxes = [0, 1].map(() => h('div'));
    const bench = h('div', { class: 'chips bench-chips' });
    const scoreInput = (i) => h('input', {
        class: 'input score-input', type: 'number', inputmode: 'numeric', min: 0, max: 999, placeholder: '–',
        'aria-label': t('scoreFor', { team: teamName(game, i) }),
        value: editing && (i ? round.scoreB : round.scoreA) !== null ? String(i ? round.scoreB : round.scoreA) : '',
    });
    const scores = [scoreInput(0), scoreInput(1)];
    const tournaments = (ctx.tournaments || []).filter((x) => !x.endedAt || x.id === (round?.tournamentId ?? tournamentId));
    const tourSelect = h('select', { class: 'input', 'aria-label': t('tournament') },
        h('option', { value: '' }, t('noTournament')),
        tournaments.map((x) => h('option', { value: x.id, selected: x.id === (editing ? round.tournamentId : tournamentId) }, x.name)));
    const winButtons = [0, 1].map((i) => h('button', { type: 'button', class: `win-btn win-${i}`, onclick: () => pickWinner(i) }));
    const saveBtn = editing && h('button', { type: 'button', class: 'btn', onclick: () => save() }, t('save'));
    const newName = h('input', { class: 'input', placeholder: t('addPlayerPlaceholder'), maxlength: 40, 'aria-label': t('addPlayerPlaceholder') });

    // A typed score picks the winner (but doesn't save).
    const fromScore = () => {
        const [a, b] = scores.map((s) => (s.value === '' ? null : Number(s.value)));
        if (a !== null && b !== null && a !== b) { winner = a > b ? 0 : 1; draw(); }
    };
    scores.forEach((s) => s.addEventListener('input', fromScore));

    function chip(p, team) {
        if (team === undefined) {
            return h('button', { type: 'button', class: 'pchip', onclick: () => {
                assign.set(p.id, teamIds(0).length <= teamIds(1).length ? 0 : 1);
                draw();
            } }, p.name);
        }
        return h('span', { class: `pchip team-${team}` },
            h('button', { type: 'button', class: 'chip-main', 'aria-label': t('moveTo', { name: p.name, team: teamName(game, 1 - team) }),
                onclick: () => { assign.set(p.id, 1 - team); draw(); } }, p.name),
            h('button', { type: 'button', class: 'chip-x', 'aria-label': t('benchPlayer', { name: p.name }),
                onclick: () => { assign.delete(p.id); draw(); } }, icon('x')));
    }

    function draw() {
        const ids = [teamIds(0), teamIds(1)];
        const ready = ids[0].length > 0 && ids[1].length > 0;
        const prob = ready && !editing ? winProbability(ids[0].map(ratingOf), ids[1].map(ratingOf), ctx.handicaps) : null;
        [0, 1].forEach((i) => teamBoxes[i].replaceChildren(h('div', { class: `team-box team-box-${i}` },
            h('div', { class: 'team-box-head' }, h('strong', null, teamName(game, i)),
                prob !== null && h('span', { class: 'odds' }, `${Math.round((i ? 1 - prob : prob) * 100)} %`)),
            h('div', { class: 'chips' }, ids[i].length
                ? players.filter((p) => assign.get(p.id) === i).map((p) => chip(p, i))
                : h('span', { class: 'muted small' }, t('tapToAdd'))))));
        bench.replaceChildren(...players.filter((p) => !assign.has(p.id)).map((p) => chip(p)));
        winButtons.forEach((b, i) => {
            b.textContent = t('teamWon', { team: teamName(game, i) });
            b.disabled = !ready;
            b.classList.toggle('on', editing && winner === i);
            if (editing) b.setAttribute('aria-pressed', String(winner === i));
        });
        if (saveBtn) saveBtn.disabled = !(ready && winner !== null);
    }

    function pickWinner(i) {
        winner = i;
        if (editing) draw();
        else save();
    }

    async function addPlayer(e) {
        e.preventDefault();
        const name = newName.value.trim();
        if (!name) return;
        let p;
        try {
            p = await gapi(gid, 'POST', '/players', { name });
        } catch (err) {
            if (err.status !== 409 || !err.data?.player) return errorToast(err);
            p = err.data.player; // Someone already added them: use that player.
        }
        if (!ctx.playersById.has(p.id)) {
            ctx.players.push(p);
            ctx.playersById.set(p.id, p);
        }
        if (!players.some((x) => x.id === p.id)) players = [...players, p].sort(order);
        if (!assign.has(p.id)) assign.set(p.id, teamIds(0).length <= teamIds(1).length ? 0 : 1);
        newName.value = '';
        draw();
    }

    function sameAsLast() {
        if (!lastRound) return;
        assign.clear();
        for (const p of lastRound.players) if (usable(p.id)) assign.set(p.id, p.team);
        draw();
    }

    function swapTeams() {
        for (const [id, team] of assign) assign.set(id, 1 - team);
        if (editing && winner !== null) winner = 1 - winner;
        draw();
    }

    function balance() {
        const ids = [...assign.keys()];
        if (ids.length < 2) return toast(t('pickPlayersFirst'));
        if (ids.length > 14) return toast(t('tooManyToBalance'));
        const [a, b] = balanceTeams(ids.map((id) => ({ id, ...ratingOf(id) })), ctx.handicaps);
        assign.clear();
        for (const p of a) assign.set(p.id, 0);
        for (const p of b) assign.set(p.id, 1);
        draw();
    }

    // Same players and winner logged in the last two minutes: probably a double entry.
    function looksLikeDuplicate(body) {
        const key = (teams) => teams.map((x) => [...x].sort().join()).join('|');
        const want = key(body.teams);
        return (ctx.rounds || []).some((r) => Date.now() - r.playedAt < 120000 && r.winner === body.winner
            && key([0, 1].map((i) => r.players.filter((p) => p.team === i).map((p) => p.id))) === want);
    }

    async function save() {
        const body = {
            teams: [teamIds(0), teamIds(1)],
            winner,
            scoreA: scores[0].value === '' ? null : Number(scores[0].value),
            scoreB: scores[1].value === '' ? null : Number(scores[1].value),
            tournamentId: tourSelect.value || null,
        };
        if (!editing && looksLikeDuplicate(body) && !confirm(t('duplicateConfirm'))) return;
        winButtons.forEach((b) => { b.disabled = true; });
        try {
            if (editing) {
                await gapi(gid, 'PATCH', `/rounds/${round.id}`, body);
                dialog.close();
                toast(t('roundUpdated'));
            } else {
                const created = await gapi(gid, 'POST', `/games/${game.id}/rounds`, body);
                dialog.close();
                const winners = body.teams[winner].map((id) => playerName(ctx, id)).join(' & ');
                toast(t('roundSaved', { winners }), { label: t('undo'), run: async () => {
                    try { await gapi(gid, 'DELETE', `/rounds/${created.id}`); onSaved?.(); } catch (err) { errorToast(err); }
                } });
            }
            onSaved?.();
        } catch (err) {
            draw();
            errorToast(err);
        }
    }

    async function remove() {
        try {
            await gapi(gid, 'DELETE', `/rounds/${round.id}`);
            dialog.close();
            toast(t('roundDeleted'), { label: t('undo'), run: async () => {
                try { await gapi(gid, 'POST', `/rounds/${round.id}/restore`); onSaved?.(); } catch (err) { errorToast(err); }
            } });
            onSaved?.();
        } catch (err) { errorToast(err); }
    }

    const hasDetails = editing ? round.scoreA !== null || !!round.tournamentId : !!tournamentId;
    const dialog = sheet(editing ? t('editRound') : t('newRound'),
        h('div', { class: 'teams' }, teamBoxes),
        h('div', { class: 'bench' },
            h('div', { class: 'section-head' }, h('h3', null, t('bench')), h('span', { class: 'muted small' }, t('benchHint'))),
            bench,
            h('form', { class: 'row', onsubmit: addPlayer }, newName, h('button', { class: 'btn ghost' }, icon('plus'), t('add')))),
        h('div', { class: 'row wrap-row tools' },
            !editing && lastRound && h('button', { type: 'button', class: 'btn ghost small', onclick: sameAsLast }, icon('repeat'), t('sameAsLast')),
            h('button', { type: 'button', class: 'btn ghost small', onclick: balance }, icon('shuffle'), t('balance')),
            h('button', { type: 'button', class: 'btn ghost small', onclick: swapTeams }, icon('swap'), t('swap')),
            h('button', { type: 'button', class: 'btn ghost small', onclick: () => { assign.clear(); draw(); } }, t('clear'))),
        h('details', { class: 'more', open: hasDetails },
            h('summary', null, tournaments.length ? t('scoreAndTournament') : t('scoreOptional')),
            h('div', { class: 'row score-row' }, h('span', { class: 'muted small' }, t('score')), scores[0], h('span', null, '–'), scores[1]),
            tournaments.length > 0 && h('label', { class: 'field' }, h('span', null, t('tournament')), tourSelect)),
        h('div', { class: 'sheet-footer' },
            !editing && h('p', { class: 'muted small center' }, t('whoWon')),
            h('div', { class: 'winners' }, winButtons),
            editing && h('div', { class: 'sheet-actions' },
                h('button', { type: 'button', class: 'btn ghost danger', onclick: remove }, t('delete')),
                h('span', { class: 'spacer' }),
                saveBtn)));
    dialog.classList.add('round-sheet');
    draw();
    // The page's player list can be a minute old: merge in the current one.
    gapi(gid, 'GET', '').then((fresh) => {
        let added = false;
        for (const p of fresh.players) {
            if (ctx.playersById.has(p.id)) continue;
            ctx.players.push(p);
            ctx.playersById.set(p.id, p);
            if (!p.archived) players.push(p);
            added = true;
        }
        if (added && dialog.open) { players.sort(order); draw(); }
    }).catch(() => {});
}

// ---- group settings -----------------------------------------------------------

async function pageGroupSettings(gid, current) {
    const ctx = await loadGroup(gid);
    const devices = ctx.me.owner ? (await gapi(gid, 'GET', '/devices')).devices : [];
    if (!current()) return;
    document.title = `${t('groupSettings')} · ${ctx.group.name}`;
    const owner = ctx.me.owner;
    const refresh = () => pageGroupSettings(gid, current);
    const patch = async (path, body, msg) => {
        try {
            await gapi(gid, 'PATCH', path, body);
            if (msg) toast(msg);
            refresh();
        } catch (err) { errorToast(err); }
    };
    const rotate = async (kind, confirmKey, doneKey) => {
        if (!confirm(t(confirmKey))) return;
        try {
            const res = await gapi(gid, 'POST', `/links/${kind}`);
            if (kind === 'owner') ownerLinkDialog(res.ownerToken);
            else toast(t(doneKey));
            if (kind !== 'owner') refresh();
        } catch (err) { errorToast(err); }
    };
    const nameInput = h('input', { class: 'input', value: ctx.group.name, maxlength: 40, 'aria-label': t('groupName') });
    const ownerNames = ctx.owners.map((o) => (o.playerId ? playerName(ctx, o.playerId) : o.label || t('unnamedDevice')));

    const playerRows = ctx.players.map((p) => h('li', { class: `list-row ${p.archived ? 'faded' : ''}` },
        h('span', null, p.name, p.id === ctx.me.playerId && h('span', { class: 'chip' }, t('you'))),
        h('span', { class: 'row' },
            h('button', { class: 'btn ghost small', type: 'button', onclick: () => {
                const name = prompt(t('rename'), p.name);
                if (name) patch(`/players/${p.id}`, { name });
            } }, t('rename')),
            h('button', { class: 'btn ghost small', type: 'button', onclick: () => patch(`/players/${p.id}`, { archived: !p.archived }) },
                p.archived ? t('unarchive') : t('archive')))));

    const gameRows = ctx.games.map((g) => h('li', { class: `list-row ${g.archived ? 'faded' : ''}` },
        h('span', null, g.name, h('span', { class: 'muted small' }, ` · ${teamName(g, 0)} / ${teamName(g, 1)}`)),
        h('span', { class: 'row wrap-row' },
            h('button', { class: 'btn ghost small', type: 'button', onclick: () => {
                const name = prompt(t('rename'), g.name);
                if (name) patch(`/games/${g.id}`, { name });
            } }, t('rename')),
            h('button', { class: 'btn ghost small', type: 'button', onclick: () => {
                const a = prompt(t('teamNames', { n: 1 }), teamName(g, 0));
                if (a === null) return;
                const b = prompt(t('teamNames', { n: 2 }), teamName(g, 1));
                if (b === null) return;
                // Keeping the default names stores nothing, so they follow the language.
                patch(`/games/${g.id}`, { teamA: a === t('teamBlue') ? null : a, teamB: b === t('teamOrange') ? null : b });
            } }, t('teams')),
            h('button', { class: 'btn ghost small', type: 'button', onclick: () => patch(`/games/${g.id}`, { archived: !g.archived }) },
                g.archived ? t('unarchive') : t('archive')))));

    const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(locale()) : '–');
    const deviceRows = devices.map((d) => h('li', { class: 'list-row' },
        h('span', { class: 'device' },
            h('span', null, d.playerId ? playerName(ctx, d.playerId) : t('unnamedDevice'),
                d.me && h('span', { class: 'chip' }, t('thisDevice')), d.owner && h('span', { class: 'chip' }, t('owner'))),
            h('span', { class: 'muted small' }, [d.label, t('lastSeen', { date: fmtDate(d.lastSeen) })].filter(Boolean).join(' · '))),
        !d.me && iconButton('x', t('removeDevice'), async () => {
            if (!confirm(t('removeDeviceConfirm'))) return;
            try { await gapi(gid, 'DELETE', `/devices/${d.id}`); refresh(); } catch (err) { errorToast(err); }
        }, 'small danger')));

    render(
        topbar({ back: `/g/${gid}`, title: t('groupSettings') }),
        h('main', { class: 'wrap narrow' },
            h('section', { class: 'card pad' }, h('h2', null, t('group')),
                owner
                    ? h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); patch('', { name: nameInput.value }, t('saved')); } },
                        nameInput, h('button', { class: 'btn ghost' }, t('save')))
                    : h('p', null, ctx.group.name),
                h('p', { class: 'muted small' }, owner ? t('youAreOwner') : t('ownersAre', { names: ownerNames.join(', ') || '–' }))),
            officeLinkCard(gid, ctx),
            dashboardLinkCard(ctx),
            owner && h('section', { class: 'card pad' }, h('h2', null, icon('key'), t('ownerTools')),
                h('p', { class: 'muted small' }, t('ownerToolsHint')),
                h('div', { class: 'stack' },
                    h('button', { class: 'btn ghost', type: 'button', onclick: () => rotate('office', 'rotateOfficeConfirm', 'rotatedOffice') }, t('rotateOffice')),
                    h('button', { class: 'btn ghost', type: 'button', onclick: () => rotate('dashboard', 'rotateDashboardConfirm', 'rotatedDashboard') }, t('rotateDashboard')),
                    h('button', { class: 'btn ghost', type: 'button', onclick: () => rotate('owner', 'rotateOwnerConfirm') }, t('rotateOwner')))),
            !owner && h('section', { class: 'card pad' }, h('h2', null, icon('key'), t('ownerTools')), h('p', { class: 'muted' }, t('notOwnerHint'))),
            h('section', { class: 'card pad' }, h('h2', null, t('players')), h('ul', { class: 'list' }, playerRows)),
            h('section', { class: 'card pad' }, h('h2', null, t('games')), h('ul', { class: 'list' }, gameRows)),
            owner && h('section', { class: 'card pad' }, h('h2', null, t('devices')), h('p', { class: 'muted small' }, t('devicesHint')),
                h('ul', { class: 'list' }, deviceRows)),
            h('section', { class: 'card pad danger-zone' }, h('h2', null, t('dangerZone')),
                h('div', { class: 'row wrap-row' },
                    h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
                        if (!confirm(t('leaveConfirm'))) return;
                        try { await gapi(gid, 'DELETE', `/devices/${ctx.me.deviceId}`); } catch { /* leaving anyway */ }
                        forgetGroup(gid);
                        navigate('/?home', true);
                    } }, t('leaveGroup')),
                    owner && h('button', { class: 'btn ghost danger', type: 'button', onclick: async () => {
                        const typed = prompt(t('deleteGroupConfirm', { name: ctx.group.name }));
                        if (typed !== ctx.group.name) return;
                        try { await gapi(gid, 'DELETE', ''); forgetGroup(gid); navigate('/?home', true); } catch (err) { errorToast(err); }
                    } }, t('deleteGroup'))))));
}

// ---- poster -------------------------------------------------------------------

async function pagePoster(gid, current) {
    const ctx = await loadGroup(gid);
    if (!current()) return;
    const url = officeUrl(ctx.group.inviteCode);
    const games = ctx.games.filter((g) => !g.archived).map((g) => g.name).join(' · ');
    document.title = `${ctx.group.name} · ${t('poster')}`;
    render(
        topbar({ back: `/g/${gid}`, title: t('poster'), actions: [
            iconButton('share', t('share'), () => share(ctx.group.name, t('shareText', { group: ctx.group.name }), url)),
            iconButton('printer', t('print'), () => print()),
        ] }),
        h('main', { class: 'poster' },
            h('h1', null, ctx.group.name),
            games && h('p', { class: 'poster-games' }, games),
            qrSvg(url),
            h('ol', { class: 'poster-steps' }, h('li', null, t('posterStep1')), h('li', null, t('posterStep2')), h('li', null, t('posterStep3'))),
            h('p', { class: 'poster-code' }, ctx.group.inviteCode),
            h('p', { class: 'poster-url' }, url.replace(/^https?:\/\//, ''))));
}

// ---- dashboard (read-only, for wall screens) -----------------------------------

let dashboardRefreshes = 0;

async function pageDashboard(token, current, known = null) {
    const seq = ++loadSeq;
    const base = known || await api('GET', `/d/${token}`);
    const params = new URLSearchParams(location.search);
    const game = base.games.find((g) => g.id === params.get('game')) || base.games[0];
    const data = game ? await api('GET', `/d/${token}/games/${game.id}?since=${startOfToday()}`) : null;
    if (!current() || seq !== loadSeq) return;
    document.title = `${base.group.name} · ${t('appName')}`;
    const ctx = { group: base.group, players: base.players, playersById: new Map(base.players.map((p) => [p.id, p])), me: null };
    // Group, games and players only change rarely: refetched every 10th refresh.
    const refresh = () => pageDashboard(token, current, ++dashboardRefreshes % 10 ? base : null);
    const url = dashboardUrl(token);
    let content;
    if (!data) {
        content = h('div', { class: 'card empty' }, h('p', null, t('noGames')));
    } else {
        withGameData(ctx, data);
        const today = ctx.rounds.filter((r) => r.playedAt >= startOfToday());
        content = h('div', { class: 'game-grid tv-grid' },
            h('section', { class: 'card pad board-card' },
                h('div', { class: 'section-head' }, h('h2', null, t('leaderboard')), teamLegend(ctx.game)),
                leaderboard(ctx, today, null, { big: true })),
            h('section', { class: 'card pad' },
                h('h2', null, today.length ? t('today') : t('recent')),
                roundList(ctx, (today.length ? today : ctx.rounds).slice(0, 8), { showDay: !today.length })));
    }
    (pollTimer ? rerender : render)(
        h('header', { class: 'topbar' },
            h('span', { class: 'brand' }, h('span', { class: 'brand-dot' }), base.group.name),
            h('h1', { class: 'title' }, game?.name || ''),
            h('div', { class: 'actions' },
                base.games.length > 1 && h('select', { class: 'input game-select', 'aria-label': t('games'),
                    onchange: (e) => navigate(`/d/${token}?game=${e.target.value}`, true) },
                base.games.map((g) => h('option', { value: g.id, selected: g.id === game?.id }, g.name))),
                iconButton('share', t('share'), () => share(base.group.name, t('dashboardShareText', { group: base.group.name }), url)),
                iconLink('settings', '/settings', t('settings')))),
        h('main', { class: 'wrap tv' }, content, h('p', { class: 'muted small center' }, t('dashboardFooter'))));
    shownVersion = data?.version ?? null;
    if (!pollTimer) {
        if (game) pollVersion(() => api('GET', `/d/${token}/games/${game.id}/version`), refresh, 30000);
        // Keep a wall screen awake while the dashboard is showing.
        navigator.wakeLock?.request('screen').then((l) => { wakeLock = l; }).catch(() => {});
    }
}

// ---- boot ---------------------------------------------------------------------

applyI18n();
route();

if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
}

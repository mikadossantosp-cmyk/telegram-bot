import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import express from 'express';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { detectGender, genderize } from './gender-helper.js';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ BOT TOKEN FEHLT!'); process.exit(1); }

const DATA_FILE      = process.env.DATA_FILE || '/data/daten.json';
const DASHBOARD_URL  = process.env.DASHBOARD_URL || '';
const APP_URL        = process.env.APP_URL || 'https://web-production-7981d.up.railway.app';
const BRIDGE_SECRET  = process.env.BRIDGE_SECRET || 'geheimer-key';
const BRIDGE_BOT_URL = process.env.BRIDGE_BOT_URL || '';
const ADMIN_IDS      = new Set((process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean));
const GROUP_A_ID       = Number(process.env.GROUP_A_ID);
const GROUP_B_ID       = Number(process.env.GROUP_B_ID);
const GROUP_A_INVITE   = process.env.GROUP_A_INVITE || 'https://t.me/+w-V2QL-igJw5YjY0';  // Link-Gruppe (zum Insta-Posten)
const GROUP_B_INVITE   = process.env.GROUP_B_INVITE || '';                                  // Chat-Gruppe (Community-Chat)
const MEINE_GRUPPE     = 'B';

process.env.TZ = 'Europe/Berlin';

// ── FEATURE FLAGS (Phase 2 Play-Store-Compliance) ─────────────────────
// Schritt-für-Schritt-Rollout: jedes Feature kann unabhängig via Railway
// env-var aktiviert werden. Default: alle OFF (safe). Aktivierung:
//   Railway → Variables → FEATURE_BLOCK_USER=1
// Sobald gesetzt, ist das Feature scharf. Wieder ausschalten: Variable löschen.
const FEATURE_FLAGS = {
    // Block/Unblock: schreibt blockedUsers[] auf User-Objekt.
    blockUser: process.env.FEATURE_BLOCK_USER === '1',
    // Age-Gate: erzwingt Altersbestätigung (16+) bei Signup. OFF = Backward-Compat
    // für bestehende Signup-Flows die noch nicht aktualisiert sind.
    ageGate: process.env.FEATURE_AGE_GATE === '1',
    // Email-Confirmation: bei Signup wird Token generiert, User ist bis Klick
    // auf Confirm-Link 'pending'. OFF = Auto-Confirm wie bisher (für bestehende
    // Signup-Flows die kein Email-Verschicken erwarten).
    emailConfirmation: process.env.FEATURE_EMAIL_CONFIRMATION === '1',
};
console.log('[FEATURE_FLAGS]', FEATURE_FLAGS);

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Browser/App-Clients laufen teils auf einer anderen Domain als dieser Bot-Service.
// Ohne Preflight-Antwort bleibt die App vor dem Login/Bootstrap im Browser hängen.
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-bridge-secret');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// App-Usage-Tracking: erfasst wer wann welche Endpoints in der CreatorBoost-App benutzt
app.use((req, res, next) => {
    try {
        if (req.path === '/data' || req.path.startsWith('/bild/')) return next();
        // /app-presence ist nur ein Marker für "User existiert in App" — soll NICHT
        // als echte Aktivität für Dashboard-Online-Status zählen, sonst zeigt
        // Dashboard nach App-Restart alle Sessions als "🟢 online".
        if (req.path === '/app-presence' || req.path === '/track-funnel') return next();
        const uid = String(req.query?.uid || req.body?.uid || req.body?.user_id || req.query?.user_id || '');
        if (!uid || !/^\d+$/.test(uid)) return next();
        if (!d.appActivity) d.appActivity = {};
        const e = d.appActivity[uid] || (d.appActivity[uid] = { firstSeen: Date.now(), lastSeen: 0, sessions: 0, totalCalls: 0, lastEndpoint: '', endpoints: {} });
        const now = Date.now();
        if (!e.lastSeen || (now - e.lastSeen) > 5*60*1000) e.sessions = (e.sessions||0) + 1; // 5-Min-Lücke = neue Session
        e.lastSeen = now;
        e.totalCalls = (e.totalCalls||0) + 1;
        const ep = (req.path.replace(/^\/+/, '').split('/')[0] || 'root').slice(0,40);
        e.lastEndpoint = ep;
        e.endpoints[ep] = (e.endpoints[ep]||0) + 1;
        // Permanent Flag: User war in App. Nie zurückgesetzt. Für Member-Eligibility.
        if (d.users[uid]) d.users[uid].appUser = true;
    } catch(_) {}
    next();
});

function istAdminId(uid) { return ADMIN_IDS.has(Number(uid)); }

// System-User für In-App DMs (CreatorBoost). Hier oben definiert damit laden() unten
// safely darauf referenzieren kann (vorher: TDZ-ReferenceError wenn man's bräuchte).
const CREATORBOOST_UID = 'creatorboost';

let d = {
    users: {}, chats: {}, links: {},
    tracker: {}, counter: {},
    gepostet: [], seasonStart: Date.now(),
    seasonGewinner: [],
    communityFeed: [],
    threadMessages: {},
    threads: [],
    dailyLogins: {},
    dailyGroupMsgs: {},
    threadLastRead: {},
    dailyXP: {}, weeklyXP: {},
    dailyReset: null, weeklyReset: null,
    bonusLinks: {},
    wochenGewinnspiel: { aktiv: true, gewinner: [], letzteAuslosung: null },
    warteNachricht: {}, dmNachrichten: {}, instaWarte: {},
    missionen: {}, wochenMissionen: {},
    missionQueue: {},
    missionAuswertungErledigt: {},
    gesternDailyXP: {},
    badgeTracker: {},
    m1Streak: {},
    backupDatum: null,
    _lastEvents: {},
    _seenEngagementJobs: {},
    xpEvent: { aktiv: false, multiplier: 1, start: null, end: null, announced: false },
    // Mindset Stories: 1 zufälliger User pro Woche wird auf @mindset.stories_ vorgestellt.
    // weeklyState: aktuelle Woche + gepickter User. waitlist: User die "Ja" gesagt haben.
    // rejected: User die "Nein" gesagt haben (kriegen keine erneuten Einlade-DMs).
    // done: alle bisher gefeaturten User (kommen nicht zurück auf waitlist außer admin restored).
    mindsetStories: { weeklyState: { week: null, pickedUid: null, pickedAt: null, locked: false }, waitlist: {}, rejected: {}, done: {} },
};

function laden() {
    try {
        if (!fs.existsSync(DATA_FILE)) return;
        const geladen = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        d = Object.assign({}, d, geladen);
        for (const uid in d.users) {
            // System-User wie 'creatorboost' nicht als gestarteter Telegram-User markieren —
            // sonst iterieren welcomeFunnel/announce/insta-check etc. über ihn und versuchen
            // bot.telegram.sendMessage(NaN, ...) → wasted error pro Lauf.
            if (uid === CREATORBOOST_UID || d.users[uid].isSystem) continue;
            d.users[uid].started = true;
            if (!d.users[uid].instagram) d.users[uid].instagram = null;
            if (istAdminId(Number(uid))) { d.users[uid].xp = 0; d.users[uid].level = 1; d.users[uid].role = '⚙️ Admin'; }
        }
        for (const k of Object.keys(d.links)) {
            const link = d.links[k];
            // KONSISTENT String — vorher hatten Telegram-Pfade Number, App-Pfade auch Number, aber
            // Sub-UIDs waren String. has(Number) vs has(String) ergibt false → Likes verschwanden.
            link.likes = new Set((Array.isArray(link.likes) ? link.likes : []).map(String));
            link.msgId = Number(k);
            if (!link.likerNames) link.likerNames = {};
            if (!link.counter_msg_id || !link.chat_id) { delete d.links[k]; continue; }
        }
        // Gleiche String-Normalisierung für sl.likes — legacy Number-Einträge würden sonst
        // beim Engagement-Check via .includes(stringUid) silent failen.
        for (const k of Object.keys(d.superlinks||{})) {
            const sl = d.superlinks[k];
            if (sl && Array.isArray(sl.likes)) sl.likes = sl.likes.map(String);
        }
        const defaults = {
            dailyXP: {}, weeklyXP: {}, bonusLinks: {}, missionen: {}, wochenMissionen: {},
            warteNachricht: {}, dmNachrichten: {}, instaWarte: {}, missionQueue: {},
            gesternDailyXP: {}, badgeTracker: {}, m1Streak: {}, missionAuswertungErledigt: {},
            _lastEvents: {},
            threadMessages: {}, threads: [], dailyLogins: {}, dailyGroupMsgs: {}, threadLastRead: {}, superlinks: {}, fullEngagementThreadId: null,
            appChat: [], appChatLastRead: {},
            wochenGewinnspiel: { aktiv: true, gewinner: [], letzteAuslosung: null },
            xpEvent: { aktiv: false, multiplier: 1, start: null, end: null, announced: false },
            newsletter: [], pinnedEngages: {},
            weeklyHistory: [],
            mindsetStories: { weeklyState: { week: null, pickedUid: null, pickedAt: null, locked: false }, waitlist: {}, rejected: {}, done: {} },
        };
        for (const [key, val] of Object.entries(defaults)) { if (!d[key]) d[key] = val; }
        const linkKeys = Object.keys(d.links).sort((a, b) => d.links[a].timestamp - d.links[b].timestamp);
        while (linkKeys.length > 500) { delete d.links[linkKeys.shift()]; }
        for (const uid in d.users) {
            if (d.users[uid].inGruppe === undefined) d.users[uid].inGruppe = true;
            if (!d.users[uid].projects) d.users[uid].projects = [];
            if (d.users[uid].diamonds === undefined) d.users[uid].diamonds = 0;
        }
        console.log('✅ Daten geladen');
    } catch (e) { console.log('Ladefehler:', e.message); }
}

let isSaving = false;
let savePending = false;

function speichern() {
    if (isSaving) { savePending = true; return; }
    isSaving = true;
    try {
        const s = Object.assign({}, d);
        s.links = {};
        for (const [k, v] of Object.entries(d.links)) s.links[k] = Object.assign({}, v, { likes: Array.from(v.likes) });
        s.users = {};
        for (const [uid, u] of Object.entries(d.users)) {
            s.users[uid] = Object.assign({}, u);
            if (istAdminId(Number(uid))) { s.users[uid].xp = 0; s.users[uid].level = 1; s.users[uid].role = '⚙️ Admin'; }
        }
        const tmp = DATA_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
        fs.renameSync(tmp, DATA_FILE);
    } catch (e) { console.log('Speicherfehler:', e.message); }
    finally {
        isSaving = false;
        if (savePending) { savePending = false; setTimeout(speichern, 100); }
    }
}

let saveTimer = null;
function speichernDebounced() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; speichern(); }, 2000);
}

setInterval(speichern, 30000);
laden();

// ── MIGRATION: Email-User auf started:true + inGruppe:true backfillen ──
// Vor diesem Fix wurden Email-User mit started:false + inGruppe:false angelegt,
// dadurch wurden sie aus allen Ranking-/Mission-/Daily-Filtern rausgefiltert.
(function backfillEmailUsers() {
    let fixed = 0;
    for (const [uid, u] of Object.entries(d.users || {})) {
        if (!u || typeof u !== 'object') continue;
        const isEmailUser = u.signupSource === 'email' || (u.email && u.appUser);
        if (!isEmailUser) continue;
        let changed = false;
        if (u.started !== true) { u.started = true; changed = true; }
        if (u.inGruppe === false) { u.inGruppe = true; changed = true; }
        if (changed) fixed++;
    }
    if (fixed > 0) {
        console.log(`✅ Email-User Backfill: ${fixed} User auf started:true + inGruppe:true gesetzt`);
        speichern();
    }
})();

// ── FULL ENGAGEMENT / SUPERLINK SYSTEM ──

function getBerlinWeekKey() {
    const now = new Date(); // TZ already set to Europe/Berlin
    const day = now.getDay() || 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - (day - 1));
    return monday.getFullYear() + '-' + String(monday.getMonth()+1).padStart(2,'0') + '-' + String(monday.getDate()).padStart(2,'0');
}

function isSuperLinkPostingAllowed() {
    const now = new Date();
    const day = now.getDay();
    if (day === 0) return false;                               // Sonntag komplett geschlossen
    if (day === 6 && (now.getHours() === 23 && now.getMinutes() >= 59)) return false; // Sa 23:59 cutoff
    return day >= 1 && day <= 6;                               // Mo bis Sa 23:58
}

function buildSuperLinkKarte(userName, insta, url, caption, likeCount, likerNames) {
    const esc = (s) => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const topLikers = Object.values(likerNames||{}).slice(0,5).map(esc);
    const more = Object.keys(likerNames||{}).length > 5 ? ` +${Object.keys(likerNames).length-5}` : '';
    const likerLine = topLikers.length ? '\n👥 ' + topLikers.join(', ') + more : '';
    return `⭐ <b>SUPERLINK</b>\n\n👤 ${esc(userName)}${insta ? ' (@' + esc(insta) + ')' : ''}\n🔗 ${esc(url)}${caption ? '\n💬 ' + esc(caption) : ''}\n\n🙏 <b>Bitte Liken, Kommentieren, Teilen und Speichern!</b>\n\n━━━━━━━━━━━━━━\n❤️ ${likeCount} Like${likeCount!==1?'s':''}${likerLine}\n━━━━━━━━━━━━━━`;
}

function buildSuperLinkButtons(slId, likeCount) {
    return { inline_keyboard: [[
        Markup.button.callback('❤️ Like · ' + likeCount, 'sllike_' + slId),
        Markup.button.callback('👁 Liker', 'slliker_' + slId),
        Markup.button.callback('🚩 Melden', 'slrep_' + slId),
    ]] };
}

async function updateSuperLinkCard(slId) {
    const sl = d.superlinks?.[slId];
    if (!sl || !sl.msg_id || !d.fullEngagementThreadId) return;
    const u = d.users[sl.uid];
    const cardText = buildSuperLinkKarte(u?.spitzname||u?.name||'User', u?.instagram, sl.url, sl.caption, sl.likes.length, sl.likerNames);
    try {
        await bot.telegram.editMessageText(GROUP_B_ID, sl.msg_id, undefined, cardText, {
            parse_mode: 'HTML',
            reply_markup: buildSuperLinkButtons(slId, sl.likes.length)
        });
    } catch(e) { console.log('updateSuperLinkCard Fehler:', e.message); }
}

async function handleSuperlink(ctx, senderUid, senderUser, text) {
    // Superlinks werden nicht mehr über Telegram gepostet — alles nur noch in der App.
    // Der Engagement-Check liest weiterhin d.superlinks (gespeist von /post-superlink-api).
    try { await ctx.deleteMessage(); } catch(e) {}
    try { await bot.telegram.sendMessage(Number(senderUid),
        '⭐ Superlinks werden jetzt direkt über die App gepostet.\n\n' +
        '📲 Öffne die App → Feed → ⭐ Superlink posten',
    ); } catch(e) {}
}

async function runEngagementCheck(isReminder = false) {
    const weekKey = getBerlinWeekKey();
    const weekSuperlinks = Object.values(d.superlinks||{}).filter(s => s.week === weekKey);
    if (!weekSuperlinks.length) return { checked: 0, warned: 0 };
    const posters = [...new Set(weekSuperlinks.map(s => s.uid))];
    let warned = 0;
    for (const uid of posters) {
        const u = d.users[uid];
        if (!u || u.isSystem || uid === CREATORBOOST_UID) continue;
        // Family-Filter: eigene Family (Parent ↔ Sub) zählt nicht als 'andere Links'.
        const fam = new Set(familyUids(uid));
        const otherLinks = weekSuperlinks.filter(s => !fam.has(String(s.uid)));
        if (!otherLinks.length) continue;
        // Family-aware Like-Check: zählt wenn IRGENDEIN Family-Mitglied (Parent oder Sub)
        // den Link geliked hat — sonst wird User penalized obwohl er von seinem Sub aus geliked hat.
        const likedAll = otherLinks.every(s => {
            if (!Array.isArray(s.likes)) return false;
            for (const f of fam) if (s.likes.includes(f)) return true;
            return false;
        });
        if (!likedAll) {
            warned++;
            const magicUrl = buildMagicLinkUrl(uid, '/feed?tab=engagement');
            if (isReminder) {
                const reminderText = '⚠️ Erinnerung: Full Engagement\n\nDu hast diese Woche noch nicht alle Superlinks geliked! Vergiss nicht: Liken, Kommentieren, Teilen und Speichern. Sonst gibt es um 23:59 Uhr −50 XP.';
                try { sendCreatorBoostDM(uid, reminderText, { link: { url: magicUrl, label: '📲 Jetzt engagen' } }); } catch(e) {}
            } else {
                u.xp = Math.max(0, (u.xp||0) - 50);
                u.level = level(u.xp); u.role = badge(u.xp); u.warnings = (u.warnings||0) + 1;
                const warnCount = u.warnings;
                const violationText = `⚠️ Full Engagement Pflicht verletzt!\n\nDu hast diese Woche nicht alle Superlinks geliked.\n\n📉 −50 XP\n⚠️ Verwarnung #${warnCount} (insgesamt)`;
                addNotification(uid, '⚠️', `Full Engagement Pflicht verletzt — −50 XP, Verwarnung #${warnCount}`);
                try { sendCreatorBoostDM(uid, violationText, { link: { url: magicUrl, label: '📲 In der App ansehen' } }); } catch(e) {}
            }
        }
    }
    if (!isReminder) speichern();
    return { checked: posters.length, warned };
}

function buildAppReminderMessage(uid = null) {
    const appUrl = (APP_URL || 'https://web-production-7981d.up.railway.app').replace(/\/$/, '');
    const apkUrl = appUrl + '/download-app';
    // Wenn uid bekannt → Magic-Link für 1-Klick-Login. Sonst nackter App-URL als Fallback.
    const openUrl = uid ? buildMagicLinkUrl(uid, '/feed') : appUrl;
    const text =
        '📱 *Hast du schon die CreatorX-App?*\n\n' +
        'Die App ist deine Zentrale für die Community:\n' +
        '• Feed mit allen Posts der Woche\n' +
        '• Direktnachrichten\n' +
        '• Profile, Stats & Diamanten-Shop\n' +
        '• Push-Benachrichtigungen über Engagement\n\n' +
        '📲 *Auf dem Handy installieren:*\n' +
        '• iPhone: Safari → Teilen → "Zum Home-Bildschirm"\n' +
        '• Android (PWA): Chrome → Menü → "App installieren"\n' +
        '• Android (APK): ' + apkUrl + '\n\n' +
        (uid
            ? '🔐 Klick einfach auf den Button — du bist sofort eingeloggt, kein Code nötig.'
            : '🔐 *Login-Code holen:*\nSchick mir hier den Befehl /mycode — du bekommst einen persönlichen Login-Code.');
    const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '📲 App öffnen (auto-login)', url: openUrl }],
        [{ text: '⬇️ APK Download (Android)', url: apkUrl }]
    ] } };
    return { text, opts };
}

async function appReminderForNonUsers() {
    const APP_REMINDER_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let sent = 0, skipped = 0;
    for (const uid of Object.keys(d.users || {})) {
        const u = d.users[uid];
        if (!u?.started) continue;
        if (uid === CREATORBOOST_UID) continue;
        if (!/^\d+$/.test(String(uid))) continue;
        if (d.appActivity?.[uid]) { skipped++; continue; }
        if (u.lastAppReminder && (now - u.lastAppReminder) < APP_REMINDER_COOLDOWN_MS) { skipped++; continue; }
        try {
            const { text, opts } = buildAppReminderMessage(uid);
            await bot.telegram.sendMessage(Number(uid), text, opts);
            u.lastAppReminder = now;
            sent++;
        } catch(e) {}
    }
    if (sent || skipped) {
        speichern();
        console.log(`📱 App-Reminder: ${sent} gesendet, ${skipped} skipped`);
    }
    return { sent, skipped };
}

// 30-Min Feed-Batch: sammelt neue Gruppen-Links seit letztem Batch und schickt
// jedem Bot-User eine zusammengefasste DM mit Magic-Link zum Feed.
async function feedBatchDM() {
    const now = Date.now();
    const lastBatch = d.lastFeedBatchAt || (now - 30*60*1000);
    // Trigger: gibt es überhaupt was Neues seit dem letzten Batch?
    const newLinks = Object.values(d.links||{}).filter(l =>
        l.timestamp && l.timestamp > lastBatch && l.timestamp <= now &&
        l.text && l.text.includes('instagram.com')
    );
    if (!newLinks.length) {
        d.lastFeedBatchAt = now;
        return { sent: 0, links: 0 };
    }
    // Inhalt: alle Insta-Links von HEUTE — User sieht immer den aktuellen Stand
    // (offene Links insgesamt), nicht nur die vom letzten 30min-Slot.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todaysLinks = Object.values(d.links||{}).filter(l =>
        l.timestamp && l.timestamp >= startOfToday.getTime() && l.timestamp <= now &&
        l.text && l.text.includes('instagram.com')
    );
    let sent = 0;
    for (const uid of Object.keys(d.users||{})) {
        const u = d.users[uid];
        if (!u?.started) continue;
        if (uid === CREATORBOOST_UID || u.isSystem) continue;
        if (!/^\d+$/.test(String(uid))) continue;
        const stillToEngage = todaysLinks.filter(l => {
            if (String(l.user_id) === String(uid)) return false; // eigener Post
            return !(l.likes instanceof Set ? l.likes.has(String(uid)) : (Array.isArray(l.likes) && l.likes.includes(String(uid))));
        });
        if (!stillToEngage.length) {
            // Keine offenen Links mehr → alte Reminder-Nachricht löschen, kein neuer Send.
            if (u._lastFeedBatchMsgId) {
                try { await bot.telegram.deleteMessage(Number(uid), u._lastFeedBatchMsgId); } catch(e) {}
                delete u._lastFeedBatchMsgId;
            }
            continue;
        }
        // Anti-Spam: alte 'offene Links'-Nachricht löschen BEVOR die neue gesendet wird —
        // der User sieht so immer nur EINE aktuelle Reminder-Nachricht im Chat.
        if (u._lastFeedBatchMsgId) {
            try { await bot.telegram.deleteMessage(Number(uid), u._lastFeedBatchMsgId); } catch(e) {}
            delete u._lastFeedBatchMsgId;
        }
        try {
            const magicUrl = buildMagicLinkUrl(uid, '/feed?tab=heute');
            const todoNames = stillToEngage.slice(0, 5).map(l => {
                const lu = d.users[l.user_id];
                return '• ' + (lu?.spitzname || lu?.name || l.user_name || 'User');
            }).join('\n');
            const todoMore = stillToEngage.length > 5 ? `\n• +${stillToEngage.length - 5} weitere` : '';
            const text = `🔗 *${stillToEngage.length} offene${stillToEngage.length===1?'r':''} Link${stillToEngage.length===1?'':'s'} im Feed*\n\n${todoNames}${todoMore}\n\nKlick zum Engagen — du bist sofort eingeloggt:`;
            const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📲 Im Heute-Feed öffnen', url: magicUrl }]] } };
            const msg = await bot.telegram.sendMessage(Number(uid), text, opts);
            if (msg?.message_id) u._lastFeedBatchMsgId = msg.message_id;
            sent++;
            await new Promise(r => setTimeout(r, 50));
        } catch(e) {}
    }
    d.lastFeedBatchAt = now;
    speichern();
    console.log(`📨 Feed-Batch: ${newLinks.length} neue Links (Trigger), ${todaysLinks.length} heute total → ${sent} DMs gesendet/aktualisiert`);
    return { sent, links: newLinks.length };
}

async function superlinkDailyReminder() {
    const weekKey = getBerlinWeekKey();
    const weekSuperlinks = Object.values(d.superlinks||{}).filter(s => s.week === weekKey);
    const posters = [...new Set(weekSuperlinks.map(s => s.uid))];
    let sent = 0;
    for (const uid of posters) {
        const u = d.users[uid];
        if (!u || u.isSystem || uid === CREATORBOOST_UID) continue;
        // Family-Filter: nicht für ungelinkte Posts der eigenen Family (Parent ↔ Sub) erinnern.
        const fam = new Set(familyUids(uid));
        const familyHasLiked = (likes) => {
            if (!Array.isArray(likes)) return false;
            for (const f of fam) if (likes.includes(f)) return true;
            return false;
        };
        const offen = weekSuperlinks.filter(s =>
            !fam.has(String(s.uid)) && !familyHasLiked(s.likes)
        ).length;
        if (offen === 0) continue;
        // Nur noch In-App-DM — Superlinks laufen vollständig über die App.
        try {
            const inappText = `⭐ Superlink-Erinnerung\n\nDu hast noch ${offen} offene${offen===1?'n':''} Superlink${offen===1?'':'s'} dieser Woche.\n\n⚠️ Liken, Kommentieren, Teilen & Speichern ist Pflicht — sonst Sonntag 23:59 Uhr −50 XP.`;
            const engageUrl = (APP_URL || 'https://web-production-7981d.up.railway.app').replace(/\/$/,'') + '/feed?tab=engagement';
            sendCreatorBoostDM(uid, inappText, { link: { url: engageUrl, label: '📲 Jetzt engagen' } });
            sent++;
        } catch(e) {}
    }
    if (sent) console.log(`📨 Daily Superlink Reminder: ${sent} DMs gesendet`);
    return { sent };
}

async function cleanupOldSuperlinks() {
    const currentWeek = getBerlinWeekKey();
    const all = d.superlinks || {};
    // Behalte die letzten 8 Wochen für /admin/superlinks-debug Analyse (Penalty-Diagnose).
    // Ältere Wochen: Datenrecord komplett raus.
    const keepWeeks = new Set();
    {
        const now = new Date();
        for (let i = 0; i < 8; i++) {
            const d2 = new Date(now);
            const day = d2.getDay() || 7;
            d2.setDate(d2.getDate() - (day - 1) - i*7);
            keepWeeks.add(d2.getFullYear() + '-' + String(d2.getMonth()+1).padStart(2,'0') + '-' + String(d2.getDate()).padStart(2,'0'));
        }
    }
    const allIds = Object.keys(all);
    const tgDeleteIds = allIds.filter(id => all[id]?.week !== currentWeek && !all[id]?.tgDeleted);   // TG-Message weg, Data bleibt
    const dataDeleteIds = allIds.filter(id => all[id]?.week && !keepWeeks.has(all[id].week));         // > 8 Wochen alt → ganz weg
    if (!tgDeleteIds.length && !dataDeleteIds.length) return { totalOld: 0, removed: 0, tgDeleted: 0, tgFailed: 0, failures: [] };
    let removed = 0, tgDeleted = 0, tgFailed = 0;
    const failures = [];
    for (const id of tgDeleteIds) {
        const sl = all[id];
        if (sl?.msg_id && GROUP_B_ID) {
            try {
                await bot.telegram.deleteMessage(GROUP_B_ID, sl.msg_id);
                sl.tgDeleted = true;
                tgDeleted++;
            } catch(e) {
                tgFailed++;
                failures.push(`${id}: ${e.description || e.message}`);
                sl.tgDeleted = true; // Markieren, sonst Re-Try in jedem Cleanup
            }
        } else {
            sl.tgDeleted = true;
        }
    }
    for (const id of dataDeleteIds) {
        delete d.superlinks[id];
        removed++;
    }
    speichern();
    console.log(`🧹 Superlinks-Cleanup: TG ${tgDeleted} gelöscht / ${tgFailed} fehlgeschlagen, Data-Records ${removed} > 8 Wochen alt entfernt`);
    if (failures.length) console.log('Telegram-Löschfehler:', failures.slice(0,5).join(' | '));
    return { totalOld: oldIds.length, removed, tgDeleted, tgFailed, failures };
}

function getFullEngagementThreadUrl() {
    if (!d.fullEngagementThreadId || !GROUP_B_ID) return null;
    const idStr = String(GROUP_B_ID);
    if (idStr.startsWith('-100')) return `https://t.me/c/${idStr.slice(4)}/${d.fullEngagementThreadId}`;
    return null;
}

// Web-Push an die CreatorBoost-App schicken — komplett zusätzlich, kein Eingriff in bestehende Logik
async function sendAppPush(targetUid, title, body, urlPath = '/feed') {
    if (!APP_URL || !targetUid || !body) return;
    try {
        const fullUrl = APP_URL.replace(/\/$/, '') + '/api/push-notify';
        const data = JSON.stringify({ uid: String(targetUid), title, body, url: urlPath });
        const lib = fullUrl.startsWith('https') ? https : http;
        const u = new URL(fullUrl);
        await new Promise(resolve => {
            const req = lib.request({
                hostname: u.hostname, port: u.port||(fullUrl.startsWith('https')?443:80), path: u.pathname,
                method: 'POST', headers: { 'Content-Type':'application/json', 'x-bridge-secret': BRIDGE_SECRET, 'Content-Length': Buffer.byteLength(data) }
            }, res => { res.on('data', () => {}); res.on('end', resolve); });
            req.on('error', () => resolve());
            req.setTimeout(4000, () => { req.destroy(); resolve(); });
            req.write(data); req.end();
        });
    } catch(e) {}
}
async function broadcastAppPush(title, body, urlPath = '/feed', exceptUid = null) {
    if (!APP_URL || !body) return;
    try {
        const fullUrl = APP_URL.replace(/\/$/, '') + '/api/push-broadcast';
        const data = JSON.stringify({ title, body, url: urlPath, exceptUid: exceptUid ? String(exceptUid) : '' });
        const lib = fullUrl.startsWith('https') ? https : http;
        const u = new URL(fullUrl);
        await new Promise(resolve => {
            const req = lib.request({
                hostname: u.hostname, port: u.port||(fullUrl.startsWith('https')?443:80), path: u.pathname,
                method: 'POST', headers: { 'Content-Type':'application/json', 'x-bridge-secret': BRIDGE_SECRET, 'Content-Length': Buffer.byteLength(data) }
            }, res => { res.on('data', () => {}); res.on('end', resolve); });
            req.on('error', () => resolve());
            req.setTimeout(4000, () => { req.destroy(); resolve(); });
            req.write(data); req.end();
        });
    } catch(e) {}
}

async function syncSuperlinkDMs() {
    let deleted = 0, failed = 0;
    for (const sl of Object.values(d.superlinks||{})) {
        if (!sl?.dmNotifications) continue;
        const likers = (Array.isArray(sl.likes) ? sl.likes : []).map(String);
        for (const uid of Object.keys(sl.dmNotifications)) {
            if (!likers.includes(String(uid))) continue;
            const msgId = sl.dmNotifications[uid];
            try {
                await bot.telegram.deleteMessage(Number(uid), msgId);
                deleted++;
            } catch(e) { failed++; }
            delete sl.dmNotifications[uid];
        }
    }
    if (deleted || failed) {
        speichern();
        console.log(`🧹 syncSuperlinkDMs: ${deleted} DMs gelöscht, ${failed} fehlgeschlagen`);
    }
    return { deleted, failed };
}

setInterval(async () => {
    const now = new Date();
    const day = now.getDay(); // 0=So, 1=Mo, ..., 6=Sa
    const wk = getBerlinWeekKey();
    const h = now.getHours(), m = now.getMinutes();
    if (!d._seenEngagementJobs) d._seenEngagementJobs = {};

    // Montag 08:00 — TG-Wochen-Ankündigung deaktiviert (Superlinks laufen jetzt App-only).

    // Mo-Sa 20:00 → Tägliche Erinnerung an Poster mit noch offenen Superlinks
    if (day !== 0 && h === 20 && m === 0 && !d._seenEngagementJobs[wk+'_dr_'+day]) {
        d._seenEngagementJobs[wk+'_dr_'+day] = true;
        speichern();
        await superlinkDailyReminder().catch(()=>{});
    }

    // Sonntag 21:00 → Erinnerung
    if (day === 0 && h === 21 && m === 0 && !d._seenEngagementJobs[wk+'_r']) {
        d._seenEngagementJobs[wk+'_r'] = true;
        speichern();
        await runEngagementCheck(true).catch(()=>{});
    }
    // Sonntag 23:59 → Finale Auswertung
    if (day === 0 && h === 23 && m === 59 && !d._seenEngagementJobs[wk+'_p']) {
        d._seenEngagementJobs[wk+'_p'] = true;
        speichern();
        await runEngagementCheck(false).catch(()=>{});
    }

    // Montag 00:05 → Alte Superlinks der Vorwoche löschen
    if (day === 1 && h === 0 && m === 5 && !d._seenEngagementJobs[wk+'_clean']) {
        d._seenEngagementJobs[wk+'_clean'] = true;
        speichern();
        await cleanupOldSuperlinks().catch(e => console.log('cleanupOldSuperlinks Fehler:', e.message));
    }
}, 60000);

// Beim Start: zurückgebliebene Superlinks aus früheren Wochen aufräumen
setTimeout(() => { cleanupOldSuperlinks().catch(e => console.log('cleanupOldSuperlinks Startup Fehler:', e.message)); }, 15000);

// Beim Start: Reminder-DMs für bereits gelikete Superlinks aufräumen
setTimeout(() => { syncSuperlinkDMs().catch(e => console.log('syncSuperlinkDMs Startup Fehler:', e.message)); }, 25000);

// Alle 3 Minuten: für jeden Liker dessen Reminder-DM noch hängt → löschen
setInterval(() => { syncSuperlinkDMs().catch(()=>{}); }, 3*60*1000);

async function ensureFullEngagementThread() {
    if (d.fullEngagementThreadId) return d.fullEngagementThreadId;
    if (!GROUP_B_ID) return null;
    try {
        const result = await bot.telegram.callApi('createForumTopic', { chat_id: GROUP_B_ID, name: 'Full Engagement' });
        d.fullEngagementThreadId = result.message_thread_id;
        speichern();
        console.log('✅ Full Engagement Thread erstellt:', d.fullEngagementThreadId);
        return d.fullEngagementThreadId;
    } catch(e) { console.log('Full Engagement Thread Fehler:', e.message); return null; }
}

async function checkInstagramForAllUsers() {
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started || (u.instagram && u.instagram.trim() !== '') || d.instaWarte[uid]) continue;
        if (uid === CREATORBOOST_UID || u.isSystem) continue;
        try {
            await bot.telegram.sendMessage(Number(uid), '📸 Bitte schick mir deinen Instagram Namen.\n\n(z.B. max123)', { reply_markup: { inline_keyboard: [[{ text: '📸 Instagram eingeben', callback_data: 'set_insta' }]] } });
            d.instaWarte[uid] = true;
            await new Promise(r => setTimeout(r, 150));
        } catch (e) {}
    }
    speichern();
}

async function backup() {
    try {
        const heute = new Date().toDateString();
        if (d.backupDatum === heute) return;
        const backupFile = DATA_FILE.replace('.json', '_backup_' + new Date().toISOString().slice(0, 10) + '.json');
        const s = Object.assign({}, d);
        s.links = {};
        for (const [k, v] of Object.entries(d.links)) s.links[k] = Object.assign({}, v, { likes: Array.from(v.likes) });
        fs.writeFileSync(backupFile, JSON.stringify(s, null, 2));
        d.backupDatum = heute;
        console.log('✅ Backup:', backupFile);
    } catch (e) { console.log('Backup Fehler:', e.message); }
}

function badge(xp) {
    if (xp >= 10000) return '🌟 Elite+';
    if (xp >= 5000)  return '👑 Elite';
    if (xp >= 1000)  return '🏅 Erfahrener';
    if (xp >= 500)   return '⬆️ Aufsteiger';
    if (xp >= 50)    return '📘 Anfänger';
    return '🆕 New';
}
function badgeBonusLinks(xp) { return xp >= 1000 ? 1 : 0; }
function xpBisNaechstesBadge(xp) {
    if (xp < 50)    return { ziel: '📘 Anfänger',   fehlend: 50 - xp };
    if (xp < 500)   return { ziel: '⬆️ Aufsteiger', fehlend: 500 - xp };
    if (xp < 1000)  return { ziel: '🏅 Erfahrener', fehlend: 1000 - xp };
    if (xp < 5000)  return { ziel: '👑 Elite',       fehlend: 5000 - xp };
    if (xp < 10000) return { ziel: '🌟 Elite+',      fehlend: 10000 - xp };
    return null;
}
function level(xp) { return Math.floor(xp / 100) + 1; }

function xpAdd(uid, menge, name) {
    if (istAdminId(uid)) return 0;
    const u = user(uid, name);
    let finalXP = menge;
    if (d.xpEvent?.aktiv && d.xpEvent.multiplier > 1) finalXP = Math.round(menge * d.xpEvent.multiplier);
    const alteBadge = u.role;
    u.xp += finalXP; u.level = level(u.xp); u.role = badge(u.xp);
    if (!d.weeklyXP[uid]) d.weeklyXP[uid] = 0;
    d.weeklyXP[uid] += finalXP;
    // Trophäe bei Badge Aufstieg
    if (alteBadge !== u.role && u.role) {
        if (!u.trophies) u.trophies = [];
        const trophyMap = { '📘 Anfänger': '📘', '⬆️ Aufsteiger': '⬆️', '🏅 Erfahrener': '🏅', '👑 Elite': '👑', '🌟 Elite+': '🌟' };
        const trophy = trophyMap[u.role];
        if (trophy && !u.trophies.includes(trophy)) u.trophies.push(trophy);
        // Level-Up DM
        const isElitePlus = u.role === '🌟 Elite+';
        const levelUpExtra = isElitePlus ? '\n\n🌟 *Elite+ Bonus:* Du erhältst jetzt 2 Superlinks pro Woche!' : '';
        bot.telegram.sendMessage(Number(uid),
            '🎉 *Badge Aufstieg!*\n\n' + alteBadge + ' → ' + u.role + '\n\n━━━━━━━━━━━━━━\n⭐ ' + u.xp + ' XP\n━━━━━━━━━━━━━━\n\nWeiter so! 💪' + levelUpExtra,
            { parse_mode: 'Markdown' }
        ).catch(() => {});
    }
    return finalXP;
}

function xpAddMitDaily(uid, menge, name) {
    if (istAdminId(uid)) return 0;
    const u = user(uid, name);
    let finalXP = menge;
    if (d.xpEvent?.aktiv && d.xpEvent.multiplier > 1) finalXP = Math.round(menge * d.xpEvent.multiplier);
    const alteBadge = u.role;
    u.xp += finalXP; u.level = level(u.xp); u.role = badge(u.xp);
    if (!d.dailyXP[uid]) d.dailyXP[uid] = 0;
    d.dailyXP[uid] += finalXP;
    if (!d.weeklyXP[uid]) d.weeklyXP[uid] = 0;
    d.weeklyXP[uid] += finalXP;
    // Badge-Aufstieg auch hier — Vorher gingen Level-Ups via App-Aktionen (Like/Post/Comment) lautlos durch.
    if (alteBadge !== u.role && u.role) {
        if (!u.trophies) u.trophies = [];
        const trophyMap = { '📘 Anfänger': '📘', '⬆️ Aufsteiger': '⬆️', '🏅 Erfahrener': '🏅', '👑 Elite': '👑', '🌟 Elite+': '🌟' };
        const trophy = trophyMap[u.role];
        if (trophy && !u.trophies.includes(trophy)) u.trophies.push(trophy);
        const isElitePlus = u.role === '🌟 Elite+';
        const levelUpExtra = isElitePlus ? '\n\n🌟 *Elite+ Bonus:* Du erhältst jetzt 2 Superlinks pro Woche!' : '';
        bot.telegram.sendMessage(Number(uid),
            '🎉 *Badge Aufstieg!*\n\n' + alteBadge + ' → ' + u.role + '\n\n━━━━━━━━━━━━━━\n⭐ ' + u.xp + ' XP\n━━━━━━━━━━━━━━\n\nWeiter so! 💪' + levelUpExtra,
            { parse_mode: 'Markdown' }
        ).catch(() => {});
    }
    return finalXP;
}

function user(uid, name) {
    if (!d.users[uid]) {
        d.users[uid] = { name: name || '', username: null, instagram: null, bio: null, nische: null, spitzname: null, trophies: [], xp: 0, level: 1, warnings: 0, started: false, links: 0, likes: 0, role: '🆕 New', lastDaily: null, totalLikes: 0, chats: [], joinDate: Date.now(), inGruppe: true, diamonds: 0, projects: [], profileCompletionRewarded: false, inventory: [], activeRing: null, gender: null };
    }
    if (name) d.users[uid].name = name;
    if (istAdminId(uid)) { d.users[uid].xp = 0; d.users[uid].level = 1; d.users[uid].role = '⚙️ Admin'; }
    // Auto-Detect Gender wenn noch nicht gesetzt — manuelles /setgender überschreibt das.
    if (d.users[uid].gender == null) {
        const detected = detectGender(d.users[uid].spitzname || d.users[uid].name);
        if (detected) d.users[uid].gender = detected;
    }
    return d.users[uid];
}

// Sub-Account: nur in der App lebende Persona. parent_uid zeigt auf den Telegram-User.
function isSubAccount(uid) { return !!(d.users[uid] && d.users[uid].parent_uid); }
function getRootUid(uid) { return d.users[uid]?.parent_uid ? String(d.users[uid].parent_uid) : String(uid); }
// Liefert alle UIDs der Account-Family (Parent + Sub) — nützlich um zu vermeiden
// dass jemand für ungelinkte Posts der eigenen Family erinnert/bestraft wird.
function familyUids(uid) {
    const u = d.users[uid];
    const set = new Set([String(uid)]);
    if (!u) return [...set];
    // Bestimme Root: wenn Sub → parent_uid, wenn Hauptaccount → uid selbst
    const rootUid = u.parent_uid ? String(u.parent_uid) : String(uid);
    set.add(rootUid);
    const root = d.users[rootUid];
    if (root) {
        // Legacy primary subUid
        if (root.subUid) set.add(String(root.subUid));
        // Neu: subUids[] Array (nach unlimited-subs PR)
        if (Array.isArray(root.subUids)) root.subUids.forEach(s => set.add(String(s)));
    }
    // Plus Reverse-Lookup: alle Users mit parent_uid === rootUid
    // (robust gegen orphaned Subs wo parent.subUid nicht mehr stimmt)
    for (const [otherUid, otherUser] of Object.entries(d.users||{})) {
        if (otherUser && String(otherUser.parent_uid||'') === rootUid) set.add(String(otherUid));
    }
    return [...set];
}
// DM-Send-Wrapper: Sub-Accounts haben keine Telegram-UID, sendMessage würde "chat not found" werfen.
// dmUser route jetzt in den App-Chat (CreatorBoost-System-User), NICHT mehr via Telegram.
// Vorher: await bot.telegram.sendMessage(...). Telegram-Abhängigkeit soll langfristig weg —
// damit landen Reward-/Admin-/Mission-DMs alle im /nachrichten-Tab.
// Markdown wird auf Plain-Text reduziert weil der In-App-Chat kein Markdown rendert.
async function dmUser(uid, text, opts) {
    if (isSubAccount(uid)) return;
    const plain = String(text || '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/_([^_]+)_/g, '$1')
        .replace(/`([^`]+)`/g, '$1');
    sendInAppDM(uid, plain);
}

function chat(cid, obj) {
    if (!d.chats[cid]) d.chats[cid] = { id: cid, type: (obj?.type) || 'unknown', title: (obj?.title || obj?.first_name) || 'Unbekannt', msgs: 0 };
    if (obj) { d.chats[cid].type = obj.type; d.chats[cid].title = obj.title || obj.first_name || d.chats[cid].title; }
    d.chats[cid].msgs++;
    return d.chats[cid];
}

function istGruppe(t) { return t === 'group' || t === 'supergroup'; }
function istPrivat(t) { return t === 'private'; }

async function istAdmin(ctx, uid) {
    try {
        if (istPrivat(ctx.chat?.type)) return true;
        const m = await ctx.telegram.getChatMember(ctx.chat.id, uid);
        return ['administrator', 'creator'].includes(m.status);
    } catch (e) { return false; }
}

function hatLink(text) {
    if (!text) return false;
    const t = text.toLowerCase().trim();
    return t.includes('http://') || t.includes('https://') || t.includes('www.') || t.includes('t.me/');
}
function istInstagramLink(text) {
    if (!text) return false;
    const t = text.toLowerCase();
    return t.includes('instagram.com') || t.includes('instagr.am');
}
// Extrahiert die erste Instagram-URL aus einem freien Text. Toleriert auch
// schemenlose URLs ('www.instagram.com/p/ABC' oder 'instagram.com/p/ABC') und
// trimmt typische trailing-Punktuation ('.', ',', ')', etc.) ab.
function extractInstagramUrl(text) {
    if (!text) return null;
    const s = String(text);
    const trim = (u) => u.replace(/[.,;)\]!?]+$/, '');
    const m = s.match(/https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/[^\s]+/i);
    if (m) return trim(m[0]);
    // Schemen-lose Version → https:// vorschieben.
    const m2 = s.match(/(?:^|\s)((?:www\.)?(?:instagram\.com|instagr\.am)\/[^\s]+)/i);
    if (m2) return 'https://' + trim(m2[1]);
    return null;
}
function linkUrl(text) {
    if (!text || typeof text !== 'string') return null;
    const t = text.trim();
    if (t.includes('http://') || t.includes('https://') || t.includes('www.') || t.includes('t.me/')) return t;
    return null;
}
function normalisiereUrl(url) {
    if (!url) return url;
    try { return url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').split('?')[0]; }
    catch (e) { return url; }
}
function istSperrzeit() {
    return false;
}
function hatBonusLink(uid) { return d.bonusLinks[uid] && d.bonusLinks[uid] > 0; }
function bonusLinkNutzen(uid) {
    if (hatBonusLink(uid)) { d.bonusLinks[uid]--; if (d.bonusLinks[uid] <= 0) delete d.bonusLinks[uid]; return true; }
    return false;
}

// M3 cap: "alle Links liken" wird ab 30 als erfüllt gewertet — keine endlose
// Like-Pflicht wenn viele Links posten. Bei <30 Links zählt weiterhin alles.
const M3_CAP = 30;

function getMission(uid) {
    const heute = new Date().toDateString();
    if (!d.missionen[uid] || d.missionen[uid].date !== heute) {
        d.missionen[uid] = { date: heute, likesGegeben: 0, m1: false, m2: false, m3: false };
    }
    return d.missionen[uid];
}

function updateMissionProgress(uid) {
    if (istAdminId(uid)) return;
    const heute = new Date().toDateString();
    const mission = getMission(uid);
    const heuteLinks = Object.values(d.links).filter(l =>
        istInstagramLink(l.text) && new Date(l.timestamp).toDateString() === heute && String(getRootUid(l.user_id)) !== String(getRootUid(uid))
    );
    heuteLinks.forEach(l => { if (!l.likes) l.likes = new Set(); });
    const gesamt = heuteLinks.length;
    const geliked = heuteLinks.filter(l => l.likes.has(String(uid))).length;
    const m3Target = Math.min(M3_CAP, gesamt);
    if (gesamt > 0) { mission.m2 = geliked / gesamt >= 0.8; mission.m3 = m3Target > 0 && geliked >= m3Target; }
    else { mission.m2 = false; mission.m3 = false; }
}

function getWochenMission(uid) {
    if (!d.wochenMissionen[uid]) d.wochenMissionen[uid] = { m1Tage: 0, m2Tage: 0, m3Tage: 0, letzterTag: null };
    return d.wochenMissionen[uid];
}

function addWeeklyMissionDay(wMission, counterKey, dayKey) {
    const lastKey = counterKey + 'LetzterTag';
    if (wMission[lastKey] === dayKey) return false;
    wMission[counterKey] = (wMission[counterKey] || 0) + 1;
    wMission[lastKey] = dayKey;
    wMission.letzterTag = dayKey;
    return true;
}

async function checkMissionen(uid, name) {
    if (istAdminId(uid)) return;
    const heute = new Date().toDateString();
    const mission = getMission(uid);
    if (!d.missionQueue[uid]) d.missionQueue[uid] = { date: heute, m1Pending: false };
    if (d.missionQueue[uid].date !== heute) d.missionQueue[uid] = { date: heute, m1Pending: false };
    if (!mission.m1 && mission.likesGegeben >= 5) {
        mission.m1 = true;
        d.missionQueue[uid].m1Pending = true;
        try { await bot.telegram.sendMessage(Number(uid), '🎯 *Mission 1 erreicht!*\n\n✅ 5 Links geliked!\n\n━━━━━━━━━━━━━━\n⏳ XP gibt es um 12:00 Uhr', { parse_mode: 'Markdown' }); } catch (e) {}
    }
    speichernDebounced();
}

// Per-User-per-Tag Auswertung. Idempotent via d.missionAuswertungProUser:
//   key = `uid_dayKey` → wird gesetzt nachdem auswertet wurde, verhindert Doppel-Reward.
// `opts.silent=true` → keine Telegram-DMs (für Backfill: User hatte ja sowieso schon
//   die kaputte UI gesehen, wir wollen ihn jetzt nicht mit 5 Tage alten "Auswertungen" zuspammen).
async function auswertenForUserDay(uid, dayKey, opts) {
    opts = opts || {};
    if (!d.missionAuswertungProUser) d.missionAuswertungProUser = {};
    const idemKey = uid + '_' + dayKey;
    if (d.missionAuswertungProUser[idemKey]) return { skipped:'already-processed' };

    if (istAdminId(uid)) {
        d.missionAuswertungProUser[idemKey] = Date.now();
        return { skipped:'admin' };
    }
    const u = d.users[uid];
    if (!u || !u.started) return { skipped:'inactive' };
    const name = u.name || '';
    const wMission = getWochenMission(uid);
    const queue = d.missionQueue[uid] || {};

    const dayLinks = Object.values(d.links).filter(l => new Date(l.timestamp).toDateString() === dayKey);
    const dayInstaLinks = dayLinks.filter(l => istInstagramLink(l.text) && String(getRootUid(l.user_id)) !== String(getRootUid(uid)));
    const gesamtTag = dayInstaLinks.length;
    const gelikedTag = dayInstaLinks.filter(l => l.likes && (l.likes instanceof Set ? l.likes.has(String(uid)) : Array.isArray(l.likes) && l.likes.includes(String(uid)))).length;
    const prozentTag = gesamtTag > 0 ? gelikedTag / gesamtTag : 0;
    const minLinksVorhanden = dayInstaLinks.length >= 5;
    const storedMission = d.missionen?.[uid]?.date === dayKey ? d.missionen[uid] : null;
    const m1Done = gelikedTag >= 5 || (queue.date === dayKey && !!queue.m1Pending) || !!storedMission?.m1;
    const m2Done = gesamtTag > 0 && prozentTag >= 0.8;
    const m3Target = Math.min(M3_CAP, gesamtTag);
    const m3Done = m3Target > 0 && gelikedTag >= m3Target;
    const anyDailyMissionDone = m1Done || m2Done || m3Done;
    if (!anyDailyMissionDone && gesamtTag === 0 && !storedMission) {
        d.missionAuswertungProUser[idemKey] = Date.now();
        return { skipped:'no-activity' };
    }

    let meldungen = [];
    let xpEarned = 0;
    let diamondsEarned = 0;
    if (m1Done) { xpAdd(uid, 5, name); xpEarned += 5; meldungen.push('✅ *Mission 1!*\n5 Links geliked → +5 XP'); }
    if (anyDailyMissionDone && addWeeklyMissionDay(wMission, 'm1Tage', dayKey)) {
        if (wMission.m1Tage >= 7) { xpAdd(uid, 10, name); xpEarned += 10; meldungen.push('🏆 *Wochen-M1!* +10 XP'); wMission.m1Tage = 0; }
    }
    if (m2Done) {
        xpAdd(uid, 5, name); xpEarned += 5;
        meldungen.push('✅ *Mission 2!*\n' + Math.round(prozentTag * 100) + '% geliked → +5 XP');
        if (addWeeklyMissionDay(wMission, 'm2Tage', dayKey)) {
            if (wMission.m2Tage >= 7) {
                xpAdd(uid, 15, name); xpEarned += 15;
                addDiamond(uid, 1); diamondsEarned += 1;
                meldungen.push('🏆 *Wochen-M2!* +15 XP + 💎 1 Diamant');
                wMission.m2Tage = 0;
            }
        }
    }
    if (m3Done) {
        xpAdd(uid, 5, name); xpEarned += 5;
        addDiamond(uid, 1); diamondsEarned += 1;
        meldungen.push('✅ *Mission 3!*\nAlle Links geliked → +5 XP + 💎 1 Diamant');
        if (addWeeklyMissionDay(wMission, 'm3Tage', dayKey)) {
            if (wMission.m3Tage >= 7) {
                xpAdd(uid, 20, name); xpEarned += 20;
                addDiamond(uid, 2); diamondsEarned += 2;
                meldungen.push('🏆 *Wochen-M3!* +20 XP + 💎 2 Diamanten');
                wMission.m3Tage = 0;
            }
        }
    }

    const hatTagLink = Object.values(d.links).some(l => istInstagramLink(l.text) && String(l.user_id) === String(uid) && new Date(l.timestamp).toDateString() === dayKey);
    if (!d.m1Streak[uid]) d.m1Streak[uid] = { count: 0, letzterTag: null };
    if (m1Done) {
        // Streak nur bumpen wenn neuer Tag — sonst zählt Backfill mehrere Tage rückwirkend doppelt.
        if (d.m1Streak[uid].letzterTag !== dayKey) {
            d.m1Streak[uid].count++;
            d.m1Streak[uid].letzterTag = dayKey;
            if (d.m1Streak[uid].count >= 5 && d.users[uid]?.warnings > 0) {
                d.users[uid].warnings--;
                d.m1Streak[uid].count = 0;
                if (!opts.silent) { try { await bot.telegram.sendMessage(Number(uid), '🎉 *Warn entfernt!*\n5 Tage M1 in Folge!\n\n⚠️ Warns: ' + d.users[uid].warnings + '/5', { parse_mode: 'Markdown' }); } catch (e) {} }
            }
        }
    } else if (!opts.skipStreakReset) { d.m1Streak[uid].count = 0; }

    if (hatTagLink && !m1Done && minLinksVorhanden && d.users[uid] && !opts.silent) {
        d.users[uid].warnings = (d.users[uid].warnings || 0) + 1;
        try { await bot.telegram.sendMessage(Number(uid), '⚠️ *Verwarnung!*\n\nLink gepostet, aber M1 nicht erfüllt.\n\n⚠️ Warns: ' + d.users[uid].warnings + '/5', { parse_mode: 'Markdown' }); } catch (e) {}
    }

    if (!opts.silent) {
        if (meldungen.length > 0 && d.users[uid]) {
            const u2 = d.users[uid];
            const nb = xpBisNaechstesBadge(u2.xp);
            try { await bot.telegram.sendMessage(Number(uid), '🎯 *Missions Auswertung*\n━━━━━━━━━━━━━━\n\n' + meldungen.join('\n\n') + '\n\n━━━━━━━━━━━━━━\n⭐ Gesamt: ' + u2.xp + ' XP' + (nb ? '  ·  ⬆️ Noch ' + nb.fehlend + ' bis ' + nb.ziel : ''), { parse_mode: 'Markdown' }); } catch (e) {}
        } else if (hatTagLink && d.users[uid]?.started) {
            try { await bot.telegram.sendMessage(Number(uid), '📊 *Missions Auswertung*\n\n❌ Keine Mission erfüllt\n\nHeute neue Chance! 💪', { parse_mode: 'Markdown' }); } catch (e) {}
        }
    }

    if (d.missionQueue[uid] && d.missionQueue[uid].date === dayKey) delete d.missionQueue[uid];
    d.missionAuswertungProUser[idemKey] = Date.now();
    return { ok:true, m1Done, m2Done, m3Done, xpEarned, diamondsEarned, wMission: {...wMission} };
}

async function missionenAuswerten() {
    const heute = new Date().toDateString();
    const gesternDate = new Date(Date.now() - 86400000);
    const gesternStr = gesternDate.toDateString();
    const jetzt12 = heute + '_12';
    if (d.missionAuswertungErledigt?.[jetzt12]) return;
    if (!d.missionAuswertungErledigt) d.missionAuswertungErledigt = {};
    d.missionAuswertungErledigt[jetzt12] = true;

    // Alle started-User für gestern auswerten. Idempotenz-Flag verhindert Doppel-Auswertung
    // falls /admin-backfill-missionen-api auch gestern abdeckte.
    const candidates = new Set([
        ...Object.keys(d.missionQueue || {}),
        ...Object.keys(d.users || {}),
    ]);
    for (const uid of candidates) {
        await auswertenForUserDay(uid, gesternStr, {});
    }

    d.missionAuswertungErledigt = { [jetzt12]: true };
    speichern();
}

// Berlin-Wochenstart = Montag. Liefert dayKey-Strings (`toDateString`) für die Tage
// dieser Woche ab letztem Montag bis einschließlich gestern.
function thisWeekBackfillDays() {
    const now = new Date();
    const day = now.getDay() || 7;            // 1..7 (Mo..So)
    const monday = new Date(now);
    monday.setDate(now.getDate() - (day - 1));
    monday.setHours(0,0,0,0);
    const out = [];
    const yesterdayCutoff = new Date(now); yesterdayCutoff.setDate(now.getDate() - 1); yesterdayCutoff.setHours(23,59,59,999);
    for (let d2 = new Date(monday); d2 <= yesterdayCutoff; d2.setDate(d2.getDate() + 1)) {
        out.push(new Date(d2).toDateString());
    }
    return out;
}

// Admin-Backfill: re-rechnet alle nicht-bereits-auswertet-en Tage seit letztem Montag.
// Silent (keine DMs, keine Warns) damit User nicht mit alten Auswertungen gespammt werden.
// Idempotent via d.missionAuswertungProUser.
async function backfillMissionenSinceMonday(opts) {
    opts = Object.assign({ silent: true, skipStreakReset: true }, opts || {});
    const days = thisWeekBackfillDays();
    const stats = { days: days.length, users: 0, bumped: 0, xp: 0, diamonds: 0, skipped: 0 };
    if (!days.length) return { ok:true, stats };
    for (const [uid, u] of Object.entries(d.users || {})) {
        if (!u || !u.started || istAdminId(uid)) continue;
        stats.users++;
        for (const dayKey of days) {
            const r = await auswertenForUserDay(uid, dayKey, opts);
            if (r && r.ok) { stats.bumped++; stats.xp += r.xpEarned||0; stats.diamonds += r.diamondsEarned||0; }
            else if (r && r.skipped) stats.skipped++;
        }
    }
    speichern();
    return { ok:true, days, stats };
}

app.post('/admin-backfill-missionen-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    try {
        const result = await backfillMissionenSinceMonday(req.body || {});
        res.json(result);
    } catch(e) {
        res.status(500).json({ ok:false, error: e.message });
    }
});

async function weeklyRankingDM() {
    const sorted = Object.entries(d.weeklyXP).filter(([uid]) => d.users[uid] && !istAdminId(uid)).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return;
    const badges = ['🥇', '🥈', '🥉'];
    for (const [uid] of Object.entries(d.users)) {
        if (!d.users[uid].started || istAdminId(uid)) continue;
        const rank = sorted.findIndex(([id]) => id === uid);
        if (rank === -1) continue;
        const xp = d.weeklyXP[uid] || 0;
        const u = d.users[uid];
        let text = '📆 *Weekly Ranking*\n━━━━━━━━━━━━━━\n\n';
        text += (rank < 3 ? badges[rank] : '#' + (rank + 1)) + ' Platz ' + (rank + 1) + ' von ' + sorted.length + '\n';
        text += '⭐ ' + xp + ' XP diese Woche\n\n━━━━━━━━━━━━━━\n🏆 *Top 3:*\n';
        sorted.slice(0, 3).forEach(([tid, txp], i) => { text += badges[i] + ' ' + d.users[tid].name + '  ·  ' + txp + ' XP\n'; });
        text += '\n🔥 Weiter so, ' + u.name + '!';
        try { await bot.telegram.sendMessage(Number(uid), text, { parse_mode: 'Markdown' }); } catch (e) {}
    }
}

bot.use(async (ctx, next) => {
    try {
        if (ctx.chat && ctx.from) {
            chat(ctx.chat.id, ctx.chat);
            const u = user(ctx.from.id, ctx.from.first_name);
            if (ctx.from.username) u.username = ctx.from.username;
            if (!u.chats) u.chats = [];
            if (!u.chats.includes(ctx.chat.id)) u.chats.push(ctx.chat.id);
            if (istAdminId(ctx.from.id)) { u.xp = 0; u.level = 1; u.role = '⚙️ Admin'; }
        }
        return next();
    } catch (e) { console.log('Middleware Fehler:', e.message); return next(); }
});

// Welcome-Briefing — wird beim /start (Erst- + Re-) und über /welcome wieder aufgerufen.
async function sendWelcomeBriefing(ctx, uid, opts = {}) {
    const wasNew = !!opts.wasNew;
    const magicAppUrl = buildMagicLinkUrl(uid, '/feed');
    const greeting = wasNew ? `👋 *Willkommen, ${ctx.from.first_name || 'Creator'}!*` : `👋 *Hi ${ctx.from.first_name || 'Creator'}!*`;
    const briefing = greeting + '\n\n' +
        'Schön dass du dabei bist 🚀\n\n' +
        'Hier ist wie *CreatorX* funktioniert — wir haben *2 Gruppen* + *eine App*:\n\n' +
        '━━━━━━━━━━━━━━\n' +
        '🔗 *Link-Gruppe* — _hier postest du deine Insta-Reels_\n' +
        'Jeder postet täglich seinen Reel-Link. Andere Creator liken zurück. Bot trackt alles.\n\n' +
        '💬 *Chat-Gruppe* — _hier wird gequatscht_\n' +
        'Community-Chat, Tipps, Fragen, Engagement-Pflicht-Threads.\n\n' +
        '📱 *Die App* — _vereinfacht alles, nutze am besten die_ ⭐\n' +
        'Feed, Stories, Profil, Ranking (👑 Gold / 🥈 Silber / 🥉 Bronze für Top-3), Messages, Sub-Account, Einstellungen — alles an einem Ort.\n' +
        '━━━━━━━━━━━━━━\n\n' +
        '⚠️ *Wichtig:* Setz unten deinen Instagram-Username — sonst kannst du in der App nicht posten/liken.';
    const buttons = [];
    if (GROUP_A_INVITE) buttons.push([{ text: '🔗 Zur Link-Gruppe', url: GROUP_A_INVITE }]);
    if (GROUP_B_INVITE) buttons.push([{ text: '💬 Zur Chat-Gruppe', url: GROUP_B_INVITE }]);
    buttons.push([{ text: '📱 App öffnen (1-Klick-Login)', url: magicAppUrl }]);
    try {
        await ctx.reply(briefing, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
    } catch (e) {
        await ctx.reply(briefing.replace(/\*/g,'').replace(/_/g,''), { reply_markup: { inline_keyboard: buttons } });
    }
}

bot.start(async (ctx) => {
    const uid = ctx.from.id;
    const u = user(uid, ctx.from.first_name);
    const wasNew = !u.started;
    u.started = true;
    if (d.warteNachricht?.[uid]) {
        try { await bot.telegram.deleteMessage(d.warteNachricht[uid].chatId, d.warteNachricht[uid].msgId); } catch (e) {}
        delete d.warteNachricht[uid];
    }
    speichern();
    if (istPrivat(ctx.chat.type)) {
        const payload = ctx.startPayload;
        if (payload === 'melden') return startMeldenFlow(ctx, uid);
        if (payload === 'shop') return sendShopNachricht(ctx, uid);
        // Group-Link Payload: User klickt einen geteilten Link → bot sendet sofort
        // Magic-Login-Button ohne Welcome-Briefing.
        if (payload === 'app' || payload === 'login') {
            const magicAppUrl = buildMagicLinkUrl(uid, '/feed');
            return ctx.reply('🚀 *Hi ' + (ctx.from.first_name || 'Creator') + '!*\n\nKlick den Button und du bist sofort in der CreatorX-App eingeloggt — kein Code-Tippen nötig.', {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '📱 In die App einloggen', url: magicAppUrl }]] }
            });
        }
        await sendWelcomeBriefing(ctx, uid, { wasNew });
        if (!u.instagram) {
            d.instaWarte[uid] = true; speichern();
            return ctx.reply('📸 Bevor du loslegst — wie heißt dein Instagram?\n\n(z.B. max123 — nur der Username, ohne @)');
        }
    }
});

// /welcome — zum Re-Anzeigen des Welcome-Briefings (Test + jederzeit verfügbar).
// /grouplink — generiert den shareable Link für die Telegram-Gruppe.
// Jeder der drauf klickt bekommt im DM den 1-Klick-App-Login-Button.
// Admin-Command: stellt soft-deleted App-Chat-Messages wieder her.
// /restoremsg              → alle löschbaren wiederherstellen
// /restoremsg minutes 30   → alle deleted in den letzten 30 Min
bot.command('restoremsg', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    if (!d.appChat) d.appChat = [];
    const args = (ctx.message.text||'').split(/\s+/).slice(1);
    let sinceTs = 0;
    if (args[0] === 'minutes' && Number(args[1]) > 0) sinceTs = Date.now() - Number(args[1]) * 60 * 1000;
    let restored = 0;
    for (const m of d.appChat) {
        if (!m.deleted) continue;
        if (sinceTs && (m.deletedAt || 0) < sinceTs) continue;
        if (!m.text && !m.image) continue;
        delete m.deleted;
        delete m.deletedAt;
        delete m.deletedBy;
        restored++;
    }
    if (restored > 0) speichern();
    const recoverable = d.appChat.filter(m => m.deleted && (m.text || m.image)).length;
    const lost = d.appChat.filter(m => m.deleted && !m.text && !m.image).length;
    let msg = '🔄 *App-Chat Restore*\n\n';
    msg += '✅ Wiederhergestellt: *' + restored + '*\n';
    if (recoverable > 0) msg += '⏳ Noch wiederherstellbar (soft-deleted): ' + recoverable + '\n';
    if (lost > 0) msg += '❌ Hart-zerstört (vor Soft-Delete-Fix): ' + lost + ' — nur Backup-Restore möglich (passiert beim Bot-Restart).';
    await ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.command('grouplink', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    const info = await ctx.telegram.getMe();
    const link = 'https://t.me/' + info.username + '?start=app';
    await ctx.reply(
        '🚀 *Group-Login-Link*\n\n' +
        'Teile diesen Link in der Gruppe — jeder der drauf klickt bekommt vom Bot einen 1-Klick-Login-Button:\n\n' +
        '`' + link + '`\n\n' +
        'Tippe auf den Link um ihn zu kopieren.',
        { parse_mode: 'Markdown' }
    );
});

bot.command('welcome', async (ctx) => {
    if (!istPrivat(ctx.chat.type)) {
        const info = await ctx.telegram.getMe();
        return ctx.reply('📩 Bitte im DM mit dem Bot tippen.', { reply_markup: { inline_keyboard: [[{ text: '📩 Bot DM öffnen', url: 'https://t.me/' + info.username + '?start=welcome' }]] } });
    }
    const uid = ctx.from.id;
    user(uid, ctx.from.first_name);
    await sendWelcomeBriefing(ctx, uid, { wasNew: false });
});

bot.command('help', async (ctx) => {
    const uid = ctx.from.id;
    const u = user(uid, ctx.from.first_name);
    const text = '📋 *Bot Hilfe*\n━━━━━━━━━━━━━━\n\n🔗 *Link System*\n• 1 Link pro Tag\n• Doppelte Links geblockt\n• 👍 Likes = XP\n\n👍 *Like System*\n• 1 Like pro Link\n• Kein Self-Like\n• +5 XP pro Like\n\n⭐ *Full Engagement (Superlinks)*\n• 1 Superlink pro Woche (Mo–Sa)\n• Alle Mitglieder müssen liken, kommentieren, teilen & speichern\n• Wer nicht engaged: −50 XP\n• /superlink — Status & posten\n\n🎯 *Tägliche Missionen*\n• M1: 5 Links liken → +5 XP\n• M2: 80% liken → +5 XP\n• M3: Alle liken → +5 XP\n• ⏳ Auswertung um 12:00 Uhr\n\n📅 *Wochen Missionen*\n• 7× M1 → +10 XP\n• 7× M2 → +15 XP\n• 7× M3 → +20 XP\n\n🏅 *Badges*\n• 🆕 New: 0–49 XP\n• 📘 Anfänger: 50–499 XP\n• ⬆️ Aufsteiger: 500–999 XP\n• 🏅 Erfahrener: 1000–4999 XP\n• 👑 Elite: 5000–9999 XP\n• 🌟 Elite+: 10000+ XP (2 Superlinks/Woche)\n\n━━━━━━━━━━━━━━\n👤 *Profil*\n• /profil — dein Profil\n• /profil @username — fremdes Profil\n• /setbio — Bio setzen\n• /setspitzname — Spitzname\n• /setinsta — Instagram\n\n📊 *Rankings*\n• /ranking — Gesamt\n• /dailyranking — Heute\n• /weeklyranking — Diese Woche\n\n🎁 *Sonstiges*\n• /daily — Täglicher Bonus\n• /missionen — Missions Übersicht\n• /superlink — Engagement Status';
    if (u.started) {
        try { await ctx.telegram.sendMessage(uid, text, { parse_mode: 'Markdown' }); if (!istPrivat(ctx.chat.type)) await ctx.reply('📩 Hilfe per DM!'); }
        catch (e) { await ctx.reply(text, { parse_mode: 'Markdown' }); }
    } else {
        const info = await ctx.telegram.getMe();
        await ctx.reply('⚠️ Starte zuerst den Bot per DM!', { reply_markup: Markup.inlineKeyboard([Markup.button.url('📩 Bot starten', 'https://t.me/' + info.username + '?start=help')]).reply_markup });
    }
});

bot.command('missionen', async (ctx) => {
    const uid = ctx.from.id;
    if (istAdminId(uid)) return ctx.reply('⚙️ Admins nehmen nicht an Missionen teil.');
    const u = user(uid, ctx.from.first_name);
    const mission = getMission(uid);
    const wMission = getWochenMission(uid);
    const heute = new Date().toDateString();
    const gestern = new Date(Date.now() - 86400000).toDateString();

    // Gestrige Links für M2/M3 (bis 12:00 heute Zeit sie zu liken)
    const gestrigeLinks = Object.values(d.links).filter(l =>
        new Date(l.timestamp).toDateString() === gestern &&
        String(getRootUid(l.user_id)) !== String(getRootUid(uid)) &&
        istInstagramLink(l.text)
    );
    const gesamtGestern = gestrigeLinks.length;
    const gelikedGestern = gestrigeLinks.filter(l => l.likes.has(String(uid))).length;
    const prozentGestern = gesamtGestern > 0 ? Math.round(gelikedGestern / gesamtGestern * 100) : 0;

    // Heutige Links für M1
    const heutigeLinks = Object.values(d.links).filter(l => new Date(l.timestamp).toDateString() === heute);

    // Auswertung bereits um 12:00?
    const jetzt = new Date();
    const auswertungHeute = jetzt.getHours() >= 12;
    const zeitBisAuswertung = auswertungHeute ? 'Auswertung bereits erfolgt' : 'Auswertung heute um 12:00 Uhr';

    let text = '🎯 *Deine Missionen*\n━━━━━━━━━━━━━━\n\n📅 *Täglich:*\n';
    text += (mission.m1 ? '✅' : '⬜') + ' M1: ' + mission.likesGegeben + '/5 Links geliked\n';
    text += (mission.m2 ? '✅' : '⬜') + ' M2: ' + gelikedGestern + '/' + gesamtGestern + ' (' + prozentGestern + '%)  — Ziel: 80%\n';
    const m3TargetGestern = Math.min(M3_CAP, gesamtGestern);
    text += (mission.m3 ? '✅' : '⬜') + ' M3: ' + Math.min(gelikedGestern, m3TargetGestern) + '/' + m3TargetGestern + (gesamtGestern > M3_CAP ? ' (max ' + M3_CAP + ')' : ' alle') + '\n';
    text += '\n⏰ ' + zeitBisAuswertung + '\n\n━━━━━━━━━━━━━━\n';
    text += '📆 *Wöchentlich:*\n🔹 W-M1: ' + wMission.m1Tage + '/7  ·  W-M2: ' + wMission.m2Tage + '/7  ·  W-M3: ' + wMission.m3Tage + '/7\n\n━━━━━━━━━━━━━━\n';
    text += '⭐ ' + u.xp + ' XP  ·  ' + u.role;
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('profile', async (ctx) => {
    const uid = ctx.from.id;
    const u = user(uid, ctx.from.first_name);
    const sorted = Object.entries(d.users).filter(([id]) => !istAdminId(id)).sort((a, b) => b[1].xp - a[1].xp);
    const rank = sorted.findIndex(x => x[0] == uid) + 1;
    const bonusL = d.bonusLinks[uid] || 0;
    const mission = getMission(uid);
    await ctx.reply(
        '👤 <b>' + u.name + (istAdminId(uid) ? ' ⚙️ Admin' : '') + '</b>\n' +
        (u.instagram ? '📸 @' + u.instagram : '') + (u.username ? (u.instagram ? '  ·  ' : '') + '@' + u.username : '') + ((u.instagram || u.username) ? '\n' : '') +
        '\n━━━━━━━━━━━━━━\n' +
        u.role + '  ·  ⭐ ' + u.xp + ' XP  ·  Lvl ' + u.level + '\n' +
        '🏆 Rang #' + rank + '\n' +
        '━━━━━━━━━━━━━━\n\n' +
        '📅 Heute: ' + (d.dailyXP[uid] || 0) + ' XP  ·  📆 Woche: ' + (d.weeklyXP[uid] || 0) + ' XP\n' +
        '👍 Likes heute: ' + (mission.likesGegeben || 0) + '  ·  👍 Gesamt: ' + u.totalLikes + '\n' +
        '🔗 Links: ' + u.links + (bonusL > 0 ? '  ·  🎁 Bonus: ' + bonusL : '') + '  ·  ⚠️ Warns: ' + u.warnings + '/5\n' +
        '🔥 Streak: ' + (u.streak || 0) + ' Tag' + ((u.streak||0) !== 1 ? 'e' : ''),
        { parse_mode: 'HTML' }
    );
});

bot.command('setinsta', async (ctx) => {
    if (!istPrivat(ctx.chat.type)) return ctx.reply('❌ Bitte nutze den Befehl im privaten Chat.');
    d.instaWarte[ctx.from.id] = true; speichern();
    return ctx.reply('📸 Schick mir deinen neuen Instagram Namen.\n\n(z.B. max123)');
});

bot.command('ranking', async (ctx) => {
    const sorted = Object.entries(d.users).filter(([uid, u]) => !istAdminId(uid) && !u?.isSystem && uid !== CREATORBOOST_UID).sort((a, b) => b[1].xp - a[1].xp).slice(0, 10);
    if (!sorted.length) return ctx.reply('Noch keine Daten.');
    const b = ['🥇', '🥈', '🥉'];
    let text = '🏆 *GESAMT RANKING*\n━━━━━━━━━━━━━━\n\n';
    sorted.forEach(([, u], i) => { text += (b[i] || (i + 1) + '.') + ' *' + u.name + '*  ' + u.role + '\n   ⭐ ' + u.xp + ' XP  ·  Lvl ' + u.level + '\n\n'; });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('dailyranking', async (ctx) => {
    const sorted = Object.entries(d.dailyXP).filter(([uid]) => d.users[uid] && !istAdminId(uid)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return ctx.reply('Heute noch keine XP.');
    const b = ['🥇', '🥈', '🥉'];
    let text = '📅 *TAGES RANKING*\n━━━━━━━━━━━━━━\n\n';
    sorted.forEach(([uid, xp], i) => { text += (b[i] || (i + 1) + '.') + ' *' + d.users[uid].name + '*  ' + d.users[uid].role + '\n   ⭐ ' + xp + ' XP\n\n'; });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('weeklyranking', async (ctx) => {
    const sorted = Object.entries(d.weeklyXP).filter(([uid]) => d.users[uid] && !istAdminId(uid)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return ctx.reply('Diese Woche noch keine XP.');
    const b = ['🥇', '🥈', '🥉'];
    let text = '📆 *WOCHEN RANKING*\n━━━━━━━━━━━━━━\n\n';
    sorted.forEach(([uid, xp], i) => { text += (b[i] || (i + 1) + '.') + ' *' + d.users[uid].name + '*  ' + d.users[uid].role + '\n   ⭐ ' + xp + ' XP\n\n'; });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('daily', async (ctx) => {
    const uid = ctx.from.id;
    if (istAdminId(uid)) return ctx.reply('⚙️ Admins nehmen nicht am Daily teil.');
    const u = user(uid, ctx.from.first_name);
    const jetzt = Date.now(), h24 = 86400000;
    if (u.lastDaily && jetzt - u.lastDaily < h24) {
        const left = h24 - (jetzt - u.lastDaily);
        return ctx.reply('⏳ Noch ' + Math.floor(left / 3600000) + 'h ' + Math.floor((left % 3600000) / 60000) + 'min.');
    }
    const bonus = Math.floor(Math.random() * 20) + 10;
    u.lastDaily = jetzt;
    xpAdd(uid, bonus, ctx.from.first_name);
    speichern();
    await ctx.reply('🎁 *Daily Bonus!*\n\n+' + bonus + ' XP erhalten!\n\n━━━━━━━━━━━━━━\n⭐ ' + u.xp + ' XP  ·  ' + u.role + '\n━━━━━━━━━━━━━━', { parse_mode: 'Markdown' });
});

bot.command(['bonuslinks','bonus','bonuslink'], async (ctx) => {
    const uid = ctx.from.id;
    const u = user(uid, ctx.from.first_name);
    const count = d.bonusLinks?.[String(uid)] || 0;
    if (count <= 0) {
        return ctx.reply('🎁 *Bonus Links*\n\nDu hast aktuell *0 Bonus Links*.\n\nBonus Links bekommst du:\n• 🛒 im Shop für 5 💎 (`/shop`)\n• 🏆 als Gewinnspiel-Preis\n• 🎯 als Mission-Belohnung\n\nMit einem Bonus Link darfst du an einem Tag *einen zusätzlichen Link* posten.', { parse_mode: 'Markdown' });
    }
    return ctx.reply('🎁 *Deine Bonus Links: ' + count + '*\n\nDu kannst heute *' + count + ' zusätzliche Link' + (count===1?'':'s') + '* posten — über das normale Tageslimit hinaus.\n\n📲 Einfach wie gewohnt einen Link in die Gruppe oder per `/post` schicken — der Bonus wird automatisch verwendet.', { parse_mode: 'Markdown' });
});

bot.command('stats', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const alleChats = Object.values(d.chats);
    const userCount = Object.keys(d.users).filter(uid => uid !== CREATORBOOST_UID && !d.users[uid]?.isSystem).length;
    await ctx.reply('📊 *Stats*\n\n👥 User: ' + userCount + '\n💬 Chats: ' + alleChats.length + '\n🔗 Links: ' + Object.keys(d.links).length, { parse_mode: 'Markdown' });
});

bot.command('dashboard', async (ctx) => {
    const uid = ctx.from.id;
    if (!await istAdmin(ctx, uid)) return ctx.reply('❌ Kein Zugriff');
    await ctx.reply('📊 Admin Dashboard:', { reply_markup: { inline_keyboard: [[{ text: '🚀 Dashboard öffnen', url: DASHBOARD_URL }]] } });
    if (!istPrivat(ctx.chat.type)) await ctx.reply('📊 Dashboard per DM!');
});

bot.command('chats', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const alle = Object.values(d.chats);
    let text = '💬 *Chats*\n\nPrivat: ' + alle.filter(c => c.type === 'private').length + '\nGruppen: ' + alle.filter(c => istGruppe(c.type)).length + '\n\n';
    alle.filter(c => istGruppe(c.type)).forEach(g => { text += '• ' + g.title + ' (`' + g.id + '`)\n'; });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('chatinfo', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    await ctx.reply('🆔 `' + ctx.chat.id + '`\n📝 ' + (ctx.chat.title || 'Privat') + '\n🔤 ' + ctx.chat.type, { parse_mode: 'Markdown' });
});

bot.command('dm', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const nachricht = ctx.message.text.replace('/dm', '').trim();
    if (!nachricht) return ctx.reply('❌ /dm Text');
    let ok = 0, err = 0;
    await ctx.reply('📨 Sende...');
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started || u.parent_uid) continue; // Subs haben keine Telegram-UID
        if (uid === CREATORBOOST_UID || u.isSystem) continue; // System-User keine TG-DM
        try { await bot.telegram.sendMessage(Number(uid), '📢 *Admin:*\n\n' + nachricht, { parse_mode: 'Markdown' }); ok++; await new Promise(r => setTimeout(r, 200)); }
        catch (e) { err++; }
    }
    await ctx.reply('✅ ' + ok + ' | ❌ ' + err);
});

bot.command('warn', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    if (!ctx.message.reply_to_message) return ctx.reply('❌ Antworte auf eine Nachricht.');
    const userId = ctx.message.reply_to_message.from.id;
    const u = user(userId, ctx.message.reply_to_message.from.first_name);
    u.warnings = (u.warnings || 0) + 1; speichern();
    await ctx.reply('⚠️ Warn an *' + u.name + '*: ' + u.warnings + '/5', { parse_mode: 'Markdown' });
    try { await bot.telegram.sendMessage(userId, '⚠️ *Verwarnung!*\nWarn: ' + u.warnings + '/5', { parse_mode: 'Markdown' }); } catch (e) {}
});

bot.command('unban', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    if (!ctx.message.reply_to_message) return ctx.reply('❌ Antworte auf eine Nachricht.');
    const userId = ctx.message.reply_to_message.from.id;
    try { await ctx.telegram.unbanChatMember(ctx.chat.id, userId); if (d.users[userId]) { d.users[userId].warnings = 0; speichern(); } await ctx.reply('✅ Entbannt!'); }
    catch (e) { await ctx.reply('❌ Fehler.'); }
});

bot.command('fixlink', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const reply = ctx.message.reply_to_message;
    if (!reply) return ctx.reply('❌ Antworte auf eine Link-Nachricht mit /fixlink');
    const text = reply.text || reply.caption || '';
    // URL aus dem Reply-Text sauber extrahieren (Insta first, sonst linkUrl-Fallback).
    const url = extractInstagramUrl(text) || linkUrl(text);
    if (!url) return ctx.reply('❌ Kein Link in der Nachricht gefunden.');
    const userId = reply.from?.id;
    const userName = reply.from?.first_name || 'User';
    const u = userId ? user(userId, userName) : {};
    const msgId = reply.message_id;
    try { await ctx.telegram.deleteMessage(ctx.chat.id, msgId); } catch (e) {}
    try { await ctx.deleteMessage(); } catch (e) {}
    const isAdmin = istAdminId(userId);
    let botMsg;
    try {
        botMsg = await bot.telegram.sendMessage(ctx.chat.id,
            buildLinkKarte(userName, u.role || '🆕 New', url, 0, u.xp || 0, isAdmin),
            { reply_markup: buildLinkButtons(msgId, 0) }
        );
    } catch (e) { return ctx.reply('❌ Fehler: ' + e.message); }
    const mapKey = MEINE_GRUPPE + '_' + msgId;
    d.links[mapKey] = { chat_id: ctx.chat.id, user_id: userId, user_name: userName, text: url, likes: new Set(), likerNames: {}, counter_msg_id: botMsg.message_id, timestamp: Date.now(), origin: 'telegram', likeSource: { app: 0, telegram: 0 } };
    tryFetchThumbnail(d.links[mapKey], 'text');
    if (!istAdminId(userId) && userId) { u.links = (u.links || 0) + 1; updateStreak(String(userId)); }
    speichern();
});

bot.command('extralink', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    if (!ctx.message.reply_to_message) return ctx.reply('❌ Antworte auf eine Nachricht vom User!');
    const uid = ctx.message.reply_to_message.from.id;
    const u = user(uid, ctx.message.reply_to_message.from.first_name);
    if (!d.bonusLinks[uid]) d.bonusLinks[uid] = 0;
    d.bonusLinks[uid] += 1; speichern();
    try { await bot.telegram.sendMessage(uid, '🎁 *Extra-Link erhalten!*', { parse_mode: 'Markdown' }); } catch (e) {}
    await ctx.reply('✅ Extra-Link vergeben an ' + u.name);
});

bot.command('testxp', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; xpAddMitDaily(ctx.from.id, 50, ctx.from.first_name); speichern(); await ctx.reply('✅ +50 XP'); });
bot.command('testwarn', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; const u = user(ctx.from.id, ctx.from.first_name); u.warnings++; speichern(); await ctx.reply('✅ Warn: ' + u.warnings + '/5'); });
bot.command('testdaily', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; user(ctx.from.id, ctx.from.first_name).lastDaily = null; speichern(); await ctx.reply('✅ Daily reset!'); });
// /setthread <name> [emoji]  — im jeweiligen Topic ausführen, setzt Name+Emoji für die App.
// Zum Backfill von Threads die VOR dem forum_topic_created-Capture existierten.
bot.command('setthread', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    const tid = ctx.message?.message_thread_id;
    if (!tid) return ctx.reply('⚠️ Bitte im jeweiligen Thread/Topic ausführen.');
    const args = (ctx.message.text || '').replace(/^\/setthread(@\w+)?\s*/i, '').trim();
    if (!args) return ctx.reply('Format: /setthread <Name> [Emoji]\nBeispiel: /setthread Tipps & Tricks 💡');
    const parts = args.split(/\s+/);
    let emoji = '📌';
    let name = args;
    const last = parts[parts.length - 1];
    // Emoji-Heuristik: letztes Token ist ein Single-Symbol/Emoji (nicht alphanumerisch, max 4 chars)
    if (parts.length > 1 && last.length <= 4 && !/^[a-z0-9_-]+$/i.test(last) && !/^\d+$/.test(last)) {
        emoji = last;
        name = parts.slice(0, -1).join(' ');
    }
    if (!d.threads) d.threads = [];
    let thr = d.threads.find(t => String(t.id) === String(tid));
    if (thr) { thr.name = name; thr.emoji = emoji; }
    else d.threads.push({ id: Number(tid), name, emoji, last_msg: null, msg_count: 0 });
    speichern();
    await ctx.reply('✅ Thread gesetzt: ' + emoji + ' ' + name);
});
// /threadlist — übersicht aller bekannten threads (admin-only)
bot.command('threadlist', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    const list = (d.threads||[]).map(t => '• ' + (t.emoji||'📌') + ' ' + (t.name||('Thread '+t.id)) + ' (id ' + t.id + ')').join('\n');
    await ctx.reply(list || 'Keine Threads gespeichert.');
});
bot.command(['diamanten', 'diamonds'], async (ctx) => {
    const u = d.users[String(ctx.from.id)];
    const stand = u ? (u.diamonds||0) : 0;
    const text = '💎 *DIAMANTEN-SYSTEM*\n\n' +
        'Diamanten sind die Währung im Shop (App + Telegram). Aktuell zu kaufen: *Extralinks* + *Superlinks*. Mehr folgt.\n\n' +
        '*Wie verdiene ich Diamanten?*\n\n' +
        '🟢 *Profil vervollständigen* (Name, Bio, Nische, Bild) → +1 💎 (einmalig)\n' +
        '🟢 *Wochenmission M2* (7 Tage je 80% liken) → +1 💎\n' +
        '🟢 *Tagesmission M3* (alle Links liken) → +1 💎 (täglich!)\n' +
        '🟢 *Wochenmission M3* (7 Tage alle liken) → +2 💎\n' +
        '🟢 *Alle Superlinks der Woche engagiert* → +1 💎\n' +
        '🟢 *100 Likes via App* → +1 💎\n' +
        '🟢 *10 Thread-Nachrichten* (min 10 Zeichen, kein Spam) → +1 💎\n' +
        '🟢 *Pinned Post engagiert* → Owner kriegt +1 💎\n\n' +
        '⚠️ *Wichtig:* Standard-Regeln gelten weiter (1 Post = 5 Likes + Kommentar). Niemand muss mehr machen — wer aber engagiert, wird belohnt 🙏\n\n' +
        '━━━━━━━━━━━━━━\n' +
        '*Dein Stand:* ' + stand + ' 💎';
    await ctx.reply(text, { parse_mode: 'Markdown' });
});
// Diagnose: /checkcode <code>  — Admin sucht in d.users nach exakt dem Code, returnt Match.
// Hilft zu finden warum App-Login fehlschlägt: zeigt Bot ihn überhaupt an?
bot.command('checkcode', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    const code = (ctx.message.text||'').replace(/^\/checkcode(@\w+)?\s*/i,'').trim().toLowerCase();
    if (!code) return ctx.reply('Format: /checkcode <code>');
    const matches = Object.entries(d.users||{}).filter(([,u]) => u.appCode === code);
    if (!matches.length) {
        // Fuzzy: ist der Code als prefix/suffix bei jemandem?
        const fuzzy = Object.entries(d.users||{}).filter(([,u]) => u.appCode && (u.appCode.startsWith(code.slice(0,8)) || u.appCode.endsWith(code.slice(-4))));
        const list = fuzzy.slice(0,5).map(([uid,u]) => `${uid}: ${u.name||'?'} → \`${u.appCode}\``).join('\n');
        return ctx.reply(`❌ Kein User hat genau diesen Code.\n${fuzzy.length?'Ähnliche:\n'+list:'(keine ähnlichen)'}`, {parse_mode:'Markdown'});
    }
    const out = matches.map(([uid,u]) => `✅ uid \`${uid}\` (${u.name||'?'}${u.username?' @'+u.username:''}) — code \`${u.appCode}\``).join('\n');
    await ctx.reply(out, {parse_mode:'Markdown'});
});
// /resetmycode <uid>  — Admin löscht den appCode eines Users, nächstes /mycode generiert neu
bot.command('resetmycode', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    const target = (ctx.message.text||'').replace(/^\/resetmycode(@\w+)?\s*/i,'').trim();
    if (!target) return ctx.reply('Format: /resetmycode <uid>');
    const u = d.users[target];
    if (!u) return ctx.reply('User nicht gefunden');
    delete u.appCode;
    speichern();
    await ctx.reply(`✅ AppCode gelöscht für ${target}. User soll /mycode neu schreiben.`);
});
bot.command('testreset', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; d.dailyXP = {}; d.weeklyXP = {}; d.missionen = {}; d.wochenMissionen = {}; d.missionQueue = {}; d.tracker = {}; d.counter = {}; d.badgeTracker = {}; speichern(); await ctx.reply('✅ Reset!'); });


async function _adminAddXp(ctx) {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const args = (ctx.message.text || '').split(/\s+/).slice(1);
    const menge = parseInt(args[0], 10);
    if (!menge || isNaN(menge)) return ctx.reply('❌ Nutzung: Antworte auf einen User mit /addxp <menge>\nz.B. /addxp 1000\n\nNegative Werte ziehen XP ab.');
    if (!ctx.message.reply_to_message) return ctx.reply('❌ Antworte auf eine Nachricht des Users.');
    const targetId = ctx.message.reply_to_message.from.id;
    const targetName = ctx.message.reply_to_message.from.first_name || 'User';
    if (istAdminId(targetId)) return ctx.reply('❌ Admins haben kein XP-Konto.');
    const u = user(targetId, targetName);
    const alteBadge = u.role;
    let finalXP = menge;
    if (menge > 0 && d.xpEvent && d.xpEvent.aktiv && d.xpEvent.multiplier > 1) finalXP = Math.round(menge * d.xpEvent.multiplier);
    u.xp = Math.max(0, (u.xp || 0) + finalXP);
    u.level = level(u.xp);
    u.role = badge(u.xp);
    // Admin-XP deliberately excluded from weekly/daily rankings
    speichern();
    const sign = finalXP >= 0 ? '+' : '';
    await ctx.reply('✅ ' + sign + finalXP + ' XP an *' + u.name + '*\n⭐ Gesamt: ' + u.xp + ' XP  ·  ' + u.role + (alteBadge !== u.role ? '\n🎉 Badge: ' + alteBadge + ' → ' + u.role : ''), { parse_mode: 'Markdown' });
    try {
        const dmText = finalXP >= 0
            ? '🎁 *Geschenk vom Admin!*\n\n+' + finalXP + ' XP\n⭐ Gesamt: ' + u.xp + ' XP  ·  ' + u.role
            : '⚠️ *XP angepasst*\n\n' + finalXP + ' XP\n⭐ Gesamt: ' + u.xp + ' XP  ·  ' + u.role;
        await bot.telegram.sendMessage(targetId, dmText, { parse_mode: 'Markdown' });
    } catch (e) {}
}
bot.command('addxp', _adminAddXp);
bot.command('xpadd', _adminAddXp);
bot.command('givexp', _adminAddXp);
bot.command('version', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; await ctx.reply('🔨 Patch-Build: ' + (process.env.PATCH_TIME || '2026-05-11T18:08:32.896Z') + '\n✅ /addxp + /xpadd + /givexp registriert'); });
console.log('\n🔨 [PATCHED-BUILD] /addxp + /xpadd + /givexp + /version registriert  (Build: ' + (process.env.PATCH_TIME || '2026-05-11T18:08:32.896Z') + ')\n');

// ── ADMIN: /merge-user + /delete-user ──────────────────────────────────

function _purgeUidFromCollections(uid) {
    const id = String(uid);

    // Scalar maps keyed by uid
    for (const key of [
        'dailyXP','weeklyXP','gesternDailyXP','tracker','counter','badgeTracker',
        'bonusLinks','missionen','wochenMissionen','missionQueue','m1Streak',
        'dailyLogins','dailyGroupMsgs','threadLastRead','warteNachricht',
        'instaWarte','dmNachrichten','appActivity','_smartReminderSent'
    ]) {
        if (d[key] && d[key][id] !== undefined) delete d[key][id];
    }

    if (d.notifications) delete d.notifications[id];
    if (d.appChatLastRead) delete d.appChatLastRead[id];
    if (d.posts) delete d.posts[id];
    if (d.pinnedEngages) delete d.pinnedEngages[id];

    // Remove uid from followers/following of all other users
    for (const u of Object.values(d.users || {})) {
        if (Array.isArray(u.followers)) u.followers = u.followers.filter(x => String(x) !== id);
        if (Array.isArray(u.following)) u.following = u.following.filter(x => String(x) !== id);
    }

    // Links (object keyed by msgId): remove as poster, remove from likers
    for (const [k, l] of Object.entries(d.links || {})) {
        if (String(l.user_id) === id) { delete d.links[k]; continue; }
        if (l.likes) {
            if (typeof l.likes.delete === 'function') l.likes.delete(id);
            else if (Array.isArray(l.likes)) l.likes = l.likes.filter(x => String(x) !== id);
        }
        if (l.likerNames && l.likerNames[id]) delete l.likerNames[id];
    }

    // Superlinks (object keyed by slId): remove as poster, remove from likers
    for (const [k, sl] of Object.entries(d.superlinks || {})) {
        if (String(sl.uid) === id) { delete d.superlinks[k]; continue; }
        if (Array.isArray(sl.likes)) sl.likes = sl.likes.filter(x => String(x) !== id);
        if (sl.likerNames && sl.likerNames[id]) delete sl.likerNames[id];
    }

    // Comments (object keyed by linkId): remove comments authored by uid
    if (d.comments && typeof d.comments === 'object') {
        for (const cKey of Object.keys(d.comments)) {
            if (Array.isArray(d.comments[cKey])) {
                d.comments[cKey] = d.comments[cKey].filter(c => String(c.uid) !== id);
            }
        }
    }

    // App chat messages: mark as deleted (preserve history)
    if (Array.isArray(d.appChat)) {
        for (const m of d.appChat) {
            if (String(m.uid) === id) { m.deleted = true; m.deletedAt = Date.now(); }
            if (m.reactions) {
                for (const emoji of Object.keys(m.reactions)) {
                    if (Array.isArray(m.reactions[emoji])) {
                        m.reactions[emoji] = m.reactions[emoji].filter(x => String(x) !== id);
                        if (m.reactions[emoji].length === 0) delete m.reactions[emoji];
                    }
                }
            }
        }
    }

    // Thread messages: remove authored messages
    if (d.threadMessages && typeof d.threadMessages === 'object') {
        for (const tk of Object.keys(d.threadMessages)) {
            if (Array.isArray(d.threadMessages[tk])) {
                d.threadMessages[tk] = d.threadMessages[tk].filter(m => String(m.uid) !== id);
            }
        }
    }

    // DMs (d.messages): remove chats where uid is participant
    if (d.messages && typeof d.messages === 'object') {
        for (const chatKey of Object.keys(d.messages)) {
            if (chatKey.split('_').includes(id)) {
                delete d.messages[chatKey];
            }
        }
    }

    // Notifications: remove uid as actorUid from other users' notifications
    if (d.notifications && typeof d.notifications === 'object') {
        for (const nk of Object.keys(d.notifications)) {
            if (Array.isArray(d.notifications[nk])) {
                d.notifications[nk] = d.notifications[nk].filter(n => String(n.actorUid || '') !== id);
            }
        }
    }

    // PinnedEngages: remove uid from other users' pinned lists
    if (d.pinnedEngages && typeof d.pinnedEngages === 'object') {
        for (const pk of Object.keys(d.pinnedEngages)) {
            if (Array.isArray(d.pinnedEngages[pk])) {
                d.pinnedEngages[pk] = d.pinnedEngages[pk].filter(x => String(x) !== id);
            }
        }
    }

    // Email login log: remove entries referencing this uid
    if (Array.isArray(d.emailLoginLog)) {
        d.emailLoginLog = d.emailLoginLog.filter(e => String(e.uid || '') !== id);
    }

    // Mindset stories
    if (d.mindsetStories) {
        if (d.mindsetStories.waitlist) delete d.mindsetStories.waitlist[id];
        if (d.mindsetStories.rejected) delete d.mindsetStories.rejected[id];
        if (d.mindsetStories.done) delete d.mindsetStories.done[id];
        if (d.mindsetStories.weeklyState && String(d.mindsetStories.weeklyState.pickedUid) === id) {
            d.mindsetStories.weeklyState.pickedUid = null;
        }
    }

    // Sub-account link: clear parent reference
    const u = d.users[id];
    if (u && u.parent_uid && d.users[u.parent_uid]) {
        delete d.users[u.parent_uid].subUid;
    }
    if (u && u.subUid && d.users[u.subUid]) {
        delete d.users[u.subUid].parent_uid;
    }
}

function _mergeUserData(sourceUid, targetUid) {
    const src = d.users[String(sourceUid)];
    const tgt = d.users[String(targetUid)];
    if (!src || !tgt) return { ok: false, error: 'User nicht gefunden' };

    const sId = String(sourceUid);
    const tId = String(targetUid);
    const log = [];

    // Transfer profile fields (only if target is empty/missing)
    const profileFields = ['email','emailConfirmedAt','pendingEmail','password_hash',
        'instagram','bio','nische','spitzname','website','tiktok','youtube','twitter',
        'banner','profilePic','accentColor','appCode','appCodeChosenAt','signupSource'];
    for (const f of profileFields) {
        if (src[f] && !tgt[f]) { tgt[f] = src[f]; log.push('Profil: ' + f + ' übertragen'); }
    }

    // Merge XP (additive)
    if (src.xp > 0) {
        const oldXp = tgt.xp || 0;
        tgt.xp = (tgt.xp || 0) + src.xp;
        tgt.level = level(tgt.xp);
        tgt.role = badge(tgt.xp);
        log.push('XP: ' + oldXp + ' + ' + src.xp + ' = ' + tgt.xp);
    }

    // Merge diamonds
    if (src.diamonds > 0) {
        tgt.diamonds = (tgt.diamonds || 0) + src.diamonds;
        log.push('Diamonds: +' + src.diamonds + ' = ' + tgt.diamonds);
    }

    // Merge link/like counters
    if (src.links > 0) { tgt.links = (tgt.links || 0) + src.links; log.push('Links: +' + src.links); }
    if (src.totalLikes > 0) { tgt.totalLikes = (tgt.totalLikes || 0) + src.totalLikes; log.push('TotalLikes: +' + src.totalLikes); }

    // Merge followers/following (deduplicated)
    if (Array.isArray(src.followers)) {
        if (!Array.isArray(tgt.followers)) tgt.followers = [];
        const existing = new Set(tgt.followers.map(String));
        for (const f of src.followers) {
            if (String(f) !== tId && !existing.has(String(f))) {
                tgt.followers.push(String(f));
                existing.add(String(f));
            }
        }
        // Update reverse references: followers of source now follow target
        for (const fUid of src.followers) {
            const fUser = d.users[String(fUid)];
            if (fUser && Array.isArray(fUser.following)) {
                fUser.following = fUser.following.filter(x => String(x) !== sId);
                if (!fUser.following.map(String).includes(tId)) fUser.following.push(tId);
            }
        }
        log.push('Followers: ' + src.followers.length + ' zusammengeführt');
    }
    if (Array.isArray(src.following)) {
        if (!Array.isArray(tgt.following)) tgt.following = [];
        const existing = new Set(tgt.following.map(String));
        for (const f of src.following) {
            if (String(f) !== tId && !existing.has(String(f))) {
                tgt.following.push(String(f));
                existing.add(String(f));
            }
        }
        // Update reverse references: users followed by source now have target as follower
        for (const fUid of src.following) {
            const fUser = d.users[String(fUid)];
            if (fUser && Array.isArray(fUser.followers)) {
                fUser.followers = fUser.followers.filter(x => String(x) !== sId);
                if (!fUser.followers.map(String).includes(tId)) fUser.followers.push(tId);
            }
        }
        log.push('Following: ' + src.following.length + ' zusammengeführt');
    }

    // Remove self-follow after merge
    if (Array.isArray(tgt.followers)) tgt.followers = tgt.followers.filter(x => String(x) !== tId);
    if (Array.isArray(tgt.following)) tgt.following = tgt.following.filter(x => String(x) !== tId);

    // Merge trophies (deduplicated)
    if (Array.isArray(src.trophies) && src.trophies.length > 0) {
        if (!Array.isArray(tgt.trophies)) tgt.trophies = [];
        const existingT = new Set(tgt.trophies.map(JSON.stringify));
        for (const t of src.trophies) {
            if (!existingT.has(JSON.stringify(t))) tgt.trophies.push(t);
        }
        log.push('Trophies: zusammengeführt');
    }

    // Merge inventory
    if (Array.isArray(src.inventory) && src.inventory.length > 0) {
        if (!Array.isArray(tgt.inventory)) tgt.inventory = [];
        tgt.inventory = tgt.inventory.concat(src.inventory);
        log.push('Inventar: +' + src.inventory.length + ' Items');
    }

    // Merge projects
    if (Array.isArray(src.projects) && src.projects.length > 0) {
        if (!Array.isArray(tgt.projects)) tgt.projects = [];
        tgt.projects = tgt.projects.concat(src.projects);
        log.push('Projekte: +' + src.projects.length);
    }

    // Transfer scalar XP maps (additive)
    for (const key of ['dailyXP','weeklyXP','gesternDailyXP']) {
        if (d[key] && d[key][sId]) {
            d[key][tId] = (d[key][tId] || 0) + d[key][sId];
            delete d[key][sId];
            log.push(key + ': zusammengeführt');
        }
    }

    // Transfer other scalar maps
    for (const key of ['tracker','counter','badgeTracker','bonusLinks','dailyLogins','dailyGroupMsgs','m1Streak']) {
        if (d[key] && d[key][sId] !== undefined && d[key][tId] === undefined) {
            d[key][tId] = d[key][sId];
            delete d[key][sId];
            log.push(key + ': übertragen');
        } else if (d[key] && d[key][sId] !== undefined) {
            delete d[key][sId];
        }
    }

    // Transfer mission data
    for (const key of ['missionen','wochenMissionen','missionQueue']) {
        if (d[key] && d[key][sId] && !d[key][tId]) {
            d[key][tId] = d[key][sId];
            delete d[key][sId];
            log.push(key + ': übertragen');
        } else if (d[key] && d[key][sId]) {
            delete d[key][sId];
        }
    }

    // Transfer thread read state
    if (d.threadLastRead && d.threadLastRead[sId]) {
        if (!d.threadLastRead[tId]) d.threadLastRead[tId] = {};
        Object.assign(d.threadLastRead[tId], d.threadLastRead[sId]);
        delete d.threadLastRead[sId];
        log.push('ThreadLastRead: übertragen');
    }

    // Transfer notifications
    if (d.notifications && Array.isArray(d.notifications[sId])) {
        if (!d.notifications[tId]) d.notifications[tId] = [];
        d.notifications[tId] = d.notifications[tId].concat(d.notifications[sId]);
        if (d.notifications[tId].length > 50) d.notifications[tId] = d.notifications[tId].slice(-50);
        delete d.notifications[sId];
        log.push('Benachrichtigungen: zusammengeführt');
    }

    // Transfer app activity
    if (d.appActivity && d.appActivity[sId]) {
        if (!d.appActivity[tId]) d.appActivity[tId] = d.appActivity[sId];
        else {
            const t = d.appActivity[tId], s = d.appActivity[sId];
            t.firstSeen = Math.min(t.firstSeen || Infinity, s.firstSeen || Infinity);
            t.lastSeen = Math.max(t.lastSeen || 0, s.lastSeen || 0);
            t.sessions = (t.sessions || 0) + (s.sessions || 0);
            t.totalCalls = (t.totalCalls || 0) + (s.totalCalls || 0);
        }
        delete d.appActivity[sId];
        log.push('AppActivity: zusammengeführt');
    }

    // Transfer appChatLastRead
    if (d.appChatLastRead && d.appChatLastRead[sId]) {
        if (!d.appChatLastRead[tId] || d.appChatLastRead[sId] > d.appChatLastRead[tId]) {
            d.appChatLastRead[tId] = d.appChatLastRead[sId];
        }
        delete d.appChatLastRead[sId];
    }

    // Re-assign links ownership
    let linksReassigned = 0;
    for (const l of Object.values(d.links || {})) {
        if (String(l.user_id) === sId) { l.user_id = /^\d+$/.test(tId) ? Number(tId) : tId; l.user_name = tgt.name; linksReassigned++; }
        if (l.likes) {
            if (typeof l.likes.delete === 'function' && l.likes.has(sId)) { l.likes.delete(sId); l.likes.add(tId); }
            else if (Array.isArray(l.likes)) l.likes = l.likes.map(x => String(x) === sId ? tId : String(x));
        }
        if (l.likerNames && l.likerNames[sId]) {
            l.likerNames[tId] = l.likerNames[sId];
            delete l.likerNames[sId];
        }
    }
    if (linksReassigned > 0) log.push('Links: ' + linksReassigned + ' umgeschrieben');

    // Re-assign superlinks ownership
    let slReassigned = 0;
    for (const sl of Object.values(d.superlinks || {})) {
        if (String(sl.uid) === sId) { sl.uid = tId; slReassigned++; }
        if (Array.isArray(sl.likes)) sl.likes = sl.likes.map(x => String(x) === sId ? tId : String(x));
        if (sl.likerNames && sl.likerNames[sId]) {
            sl.likerNames[tId] = sl.likerNames[sId];
            delete sl.likerNames[sId];
        }
    }
    if (slReassigned > 0) log.push('Superlinks: ' + slReassigned + ' umgeschrieben');

    // Re-assign comments
    if (d.comments) {
        let cReassigned = 0;
        for (const arr of Object.values(d.comments)) {
            if (Array.isArray(arr)) {
                for (const c of arr) {
                    if (String(c.uid) === sId) { c.uid = tId; c.name = tgt.name; cReassigned++; }
                }
            }
        }
        if (cReassigned > 0) log.push('Kommentare: ' + cReassigned + ' umgeschrieben');
    }

    // Re-assign posts
    if (d.posts && d.posts[sId]) {
        if (!d.posts[tId]) d.posts[tId] = [];
        d.posts[tId] = d.posts[tId].concat(d.posts[sId]);
        delete d.posts[sId];
        log.push('Posts: zusammengeführt');
    }

    // Re-assign app chat messages
    if (Array.isArray(d.appChat)) {
        let chatReassigned = 0;
        for (const m of d.appChat) {
            if (String(m.uid) === sId) { m.uid = tId; m.name = tgt.name; chatReassigned++; }
            if (m.reactions) {
                for (const emoji of Object.keys(m.reactions)) {
                    if (Array.isArray(m.reactions[emoji])) {
                        m.reactions[emoji] = m.reactions[emoji].map(x => String(x) === sId ? tId : String(x));
                        m.reactions[emoji] = [...new Set(m.reactions[emoji])];
                    }
                }
            }
        }
        if (chatReassigned > 0) log.push('AppChat: ' + chatReassigned + ' Nachrichten umgeschrieben');
    }

    // Re-assign thread messages
    if (d.threadMessages) {
        let tmReassigned = 0;
        for (const arr of Object.values(d.threadMessages)) {
            if (Array.isArray(arr)) {
                for (const m of arr) {
                    if (String(m.uid) === sId) { m.uid = tId; m.name = tgt.name; tmReassigned++; }
                }
            }
        }
        if (tmReassigned > 0) log.push('ThreadMessages: ' + tmReassigned + ' umgeschrieben');
    }

    // Re-assign DMs
    if (d.messages) {
        const keysToMigrate = Object.keys(d.messages).filter(k => k.split('_').includes(sId));
        for (const oldKey of keysToMigrate) {
            const newKey = [String(oldKey.split('_')[0]) === sId ? tId : oldKey.split('_')[0],
                            String(oldKey.split('_')[1]) === sId ? tId : oldKey.split('_')[1]]
                            .sort().join('_');
            for (const m of d.messages[oldKey]) {
                if (String(m.from) === sId) m.from = tId;
                if (String(m.to) === sId) m.to = tId;
            }
            if (d.messages[newKey] && newKey !== oldKey) {
                d.messages[newKey] = d.messages[newKey].concat(d.messages[oldKey]);
                d.messages[newKey].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
                if (d.messages[newKey].length > 200) d.messages[newKey] = d.messages[newKey].slice(-200);
            } else if (newKey !== oldKey) {
                d.messages[newKey] = d.messages[oldKey];
            }
            if (newKey !== oldKey) delete d.messages[oldKey];
        }
        if (keysToMigrate.length > 0) log.push('DMs: ' + keysToMigrate.length + ' Chats migriert');
    }

    // Re-assign notifications referencing source as actor
    if (d.notifications) {
        for (const arr of Object.values(d.notifications)) {
            if (Array.isArray(arr)) {
                for (const n of arr) {
                    if (String(n.actorUid || '') === sId) n.actorUid = tId;
                }
            }
        }
    }

    // PinnedEngages: transfer and re-reference
    if (d.pinnedEngages) {
        if (d.pinnedEngages[sId]) {
            if (!d.pinnedEngages[tId]) d.pinnedEngages[tId] = [];
            d.pinnedEngages[tId] = [...new Set([...d.pinnedEngages[tId], ...d.pinnedEngages[sId]])];
            delete d.pinnedEngages[sId];
        }
        for (const pk of Object.keys(d.pinnedEngages)) {
            if (Array.isArray(d.pinnedEngages[pk])) {
                d.pinnedEngages[pk] = d.pinnedEngages[pk].map(x => String(x) === sId ? tId : String(x));
                d.pinnedEngages[pk] = [...new Set(d.pinnedEngages[pk])];
            }
        }
    }

    // Mindset stories: transfer references
    if (d.mindsetStories) {
        for (const cat of ['waitlist','rejected','done']) {
            if (d.mindsetStories[cat] && d.mindsetStories[cat][sId]) {
                if (!d.mindsetStories[cat][tId]) d.mindsetStories[cat][tId] = d.mindsetStories[cat][sId];
                delete d.mindsetStories[cat][sId];
            }
        }
        if (d.mindsetStories.weeklyState && String(d.mindsetStories.weeklyState.pickedUid) === sId) {
            d.mindsetStories.weeklyState.pickedUid = tId;
        }
    }

    // Re-assign email login log entries from source to target
    if (Array.isArray(d.emailLoginLog)) {
        for (const e of d.emailLoginLog) {
            if (String(e.uid || '') === sId) e.uid = tId;
        }
        log.push('EmailLoginLog: UIDs umgeschrieben');
    }

    // Clean up remaining source-keyed entries
    for (const key of ['warteNachricht','instaWarte','dmNachrichten','_smartReminderSent']) {
        if (d[key] && d[key][sId] !== undefined) delete d[key][sId];
    }

    // Transfer sub-account relationship
    if (src.subUid && d.users[src.subUid]) {
        if (!tgt.subUid) {
            tgt.subUid = src.subUid;
            d.users[src.subUid].parent_uid = tId;
            log.push('Sub-Account übertragen: ' + src.subUid);
        }
    }
    if (src.parent_uid && d.users[src.parent_uid]) {
        d.users[src.parent_uid].subUid = tId;
        tgt.parent_uid = src.parent_uid;
        log.push('Parent-Beziehung übertragen');
    }

    // Flags
    if (src.appUser) tgt.appUser = true;
    if (src.started) tgt.started = true;
    if (src.inGruppe) tgt.inGruppe = true;
    if (src.rulesAcceptedAt && !tgt.rulesAcceptedAt) tgt.rulesAcceptedAt = src.rulesAcceptedAt;
    if (src.joinDate && (!tgt.joinDate || src.joinDate < tgt.joinDate)) tgt.joinDate = src.joinDate;

    // Backup source user before deletion
    if (!d._mergeLog) d._mergeLog = [];
    d._mergeLog.push({
        timestamp: Date.now(),
        sourceUid: sId,
        targetUid: tId,
        sourceBackup: JSON.parse(JSON.stringify(src)),
        changes: log
    });
    while (d._mergeLog.length > 50) d._mergeLog.shift();

    // Delete source user
    delete d.users[sId];

    speichern();
    return { ok: true, log };
}

function _deleteUser(uid) {
    const id = String(uid);
    const u = d.users[id];
    if (!u) return { ok: false, error: 'User nicht gefunden' };

    // Backup before deletion
    if (!d._deleteLog) d._deleteLog = [];
    d._deleteLog.push({
        timestamp: Date.now(),
        uid: id,
        backup: JSON.parse(JSON.stringify(u))
    });
    while (d._deleteLog.length > 50) d._deleteLog.shift();

    _purgeUidFromCollections(id);
    delete d.users[id];
    speichern();

    return { ok: true, name: u.name || u.email || id };
}

function _findUser(query) {
    const q = String(query).trim().toLowerCase().replace(/^@/, '');
    if (!q) return null;
    // Direct UID match
    if (d.users[q]) return q;
    if (d.users[query]) return query;
    // Search by username, instagram, name, spitzname, email
    for (const [uid, u] of Object.entries(d.users)) {
        if (String(u.username || '').toLowerCase() === q) return uid;
        if (String(u.instagram || '').toLowerCase() === q) return uid;
        if (String(u.name || '').toLowerCase() === q) return uid;
        if (String(u.spitzname || '').toLowerCase() === q) return uid;
        if (String(u.email || '').toLowerCase() === q) return uid;
    }
    return null;
}

bot.command('mergeuser', async (ctx) => {
    try {
        if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
        const args = (ctx.message.text || '').split(/\s+/).slice(1);
        if (args.length < 2) return ctx.reply('❌ Nutzung: /mergeuser <quell> <ziel>\n\nDu kannst UID, Username, Instagram oder Name verwenden.\nAlle Daten von Quell-User werden auf Ziel-User übertragen. Quell-User wird danach gelöscht.');

        const sourceUid = _findUser(args[0]);
        const targetUid = _findUser(args[1]);

        if (!sourceUid) return ctx.reply('❌ Quell-User nicht gefunden: ' + args[0]);
        if (!targetUid) return ctx.reply('❌ Ziel-User nicht gefunden: ' + args[1]);
        if (sourceUid === targetUid) return ctx.reply('❌ Quell und Ziel sind der gleiche User (' + sourceUid + ').');

        const srcName = d.users[sourceUid].spitzname || d.users[sourceUid].name || sourceUid;
        const tgtName = d.users[targetUid].spitzname || d.users[targetUid].name || targetUid;

        const result = _mergeUserData(sourceUid, targetUid);
        if (!result.ok) return ctx.reply('❌ Merge fehlgeschlagen: ' + result.error);

        const logText = result.log.length > 0 ? '\n\n📋 Details:\n' + result.log.map(l => '• ' + l).join('\n') : '';
        await ctx.reply('✅ Merge abgeschlossen!\n\n👤 ' + srcName + ' (' + sourceUid + ') → ' + tgtName + ' (' + targetUid + ')\n🗑 Quell-User gelöscht.' + logText);
        console.log('[MERGE] ' + sourceUid + ' → ' + targetUid + ' von Admin ' + ctx.from.id + ': ' + result.log.join(', '));
    } catch (e) {
        console.log('[MERGE] Fehler:', e.message, e.stack);
        try { await ctx.reply('❌ Fehler beim Merge: ' + e.message); } catch(_) {}
    }
});

bot.command('deleteuser', async (ctx) => {
    try {
        if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
        const args = (ctx.message.text || '').split(/\s+/).slice(1);
        if (args.length < 1) return ctx.reply('❌ Nutzung: /deleteuser <uid oder name>\n\nDu kannst UID, Username, Instagram oder Name verwenden.');

        const uid = _findUser(args[0]);
        if (!uid) return ctx.reply('❌ User nicht gefunden: ' + args[0]);
        if (istAdminId(Number(uid))) return ctx.reply('❌ Admin-Accounts können nicht gelöscht werden.');

        const userName = d.users[uid].spitzname || d.users[uid].name || uid;
        const result = _deleteUser(uid);
        if (!result.ok) return ctx.reply('❌ Fehler: ' + result.error);

        await ctx.reply('✅ User gelöscht!\n\n👤 ' + userName + ' (' + uid + ')\n📋 Backup im _deleteLog gespeichert.');
        console.log('[DELETE] User ' + uid + ' (' + userName + ') gelöscht von Admin ' + ctx.from.id);
    } catch (e) {
        console.log('[DELETE] Fehler:', e.message, e.stack);
        try { await ctx.reply('❌ Fehler beim Löschen: ' + e.message); } catch(_) {}
    }
});

function _generatePassword() {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let pw = '';
    for (let i = 0; i < 10; i++) pw += chars[crypto.randomInt(chars.length)];
    return pw;
}

bot.command('resetpw', async (ctx) => {
    try {
        if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
        const args = (ctx.message.text || '').split(/\s+/).slice(1);
        if (args.length < 1) return ctx.reply('❌ Nutzung: /resetpw <uid oder name oder email>\n\nGeneriert ein neues Passwort und schickt es dem User per DM.');
        const uid = _findUser(args[0]);
        if (!uid) return ctx.reply('❌ User nicht gefunden: ' + args[0]);
        const u = d.users[uid];
        if (!u.email) return ctx.reply('❌ User ' + (u.spitzname || u.name || uid) + ' hat keine Email — kein Passwort-Login möglich.');
        const newPw = _generatePassword();
        u.password_hash = hashPasswordPBKDF2(newPw);
        speichern();
        try {
            await bot.telegram.sendMessage(Number(uid),
                '🔐 Dein Passwort wurde zurückgesetzt!\n\nNeues Passwort: ' + newPw + '\n\nBitte ändere es nach dem Login in den Einstellungen.');
        } catch (e) {}
        await ctx.reply('✅ Passwort zurückgesetzt für ' + (u.spitzname || u.name || uid) + ' (' + u.email + ')\nNeues Passwort: ' + newPw);
        console.log('[RESETPW] Admin ' + ctx.from.id + ' hat Passwort für ' + uid + ' (' + u.email + ') zurückgesetzt');
    } catch (e) {
        console.log('[RESETPW] Fehler:', e.message);
        try { await ctx.reply('❌ Fehler: ' + e.message); } catch(_) {}
    }
});

bot.command('dellink', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const suche = ctx.message.text.replace('/dellink', '').trim().toLowerCase();
    if (!suche) return ctx.reply('❌ Nutze: /dellink <suchwort>');
    const treffer = Object.entries(d.links).filter(([, l]) => (l.text || '').toLowerCase().includes(suche));
    if (!treffer.length) return ctx.reply('❌ Keine Links mit "' + suche + '" gefunden.');
    let geloescht = 0;
    const deletedMsgIds = new Set();
    for (const [key, l] of treffer) {
        if (l.counter_msg_id && l.chat_id) {
            try { await bot.telegram.deleteMessage(l.chat_id, l.counter_msg_id); } catch(e) {}
            deletedMsgIds.add(String(l.counter_msg_id));
        }
        delete d.links[key];
        geloescht++;
    }
    // Aus threadMessages und communityFeed entfernen
    for (const threadId of Object.keys(d.threadMessages || {})) {
        const vorher = d.threadMessages[threadId].length;
        d.threadMessages[threadId] = d.threadMessages[threadId].filter(m => !deletedMsgIds.has(String(m.msg_id)));
        // last_msg in d.threads aktualisieren falls gelöscht
        if (d.threadMessages[threadId].length !== vorher) {
            const thr = (d.threads||[]).find(t => String(t.id) === threadId);
            if (thr) {
                thr.last_msg = d.threadMessages[threadId][0] || null;
                thr.msg_count = d.threadMessages[threadId].length;
            }
        }
    }
    if (d.communityFeed) {
        d.communityFeed = d.communityFeed.filter(m => !deletedMsgIds.has(String(m.msg_id)));
    }
    speichern();
    await ctx.reply('✅ ' + geloescht + ' Link(s) mit "' + suche + '" aus Telegram + Web-Feed gelöscht.');
});
bot.command('testmissionauswertung', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    const gestern = new Date(Date.now() - 86400000).toDateString();
    for (const uid of Object.keys(d.missionQueue)) d.missionQueue[uid].date = gestern;
    d.missionAuswertungErledigt = {};
    await missionenAuswerten();
    await ctx.reply('✅ Auswertung!');
});
bot.command('cleanlinks', async (ctx) => {
    if (!istAdminId(ctx.from.id) && !await istAdmin(ctx, ctx.from.id)) {
        return ctx.reply('❌ Nur für Admins.');
    }
    const vorher = Object.keys(d.links).length;
    await ctx.reply('🔍 Prüfe alle ' + vorher + ' Links...');
    const keys = Object.keys(d.links);
    let removed = 0;
    for (const key of keys) {
        const link = d.links[key];
        if (!link?.chat_id || !link?.counter_msg_id) { delete d.links[key]; removed++; continue; }
        try {
            await bot.telegram.editMessageReplyMarkup(
                link.chat_id, link.counter_msg_id, null,
                buildLinkButtons(link.counter_msg_id, link.likes?.size || 0)
            );
        } catch(e) {
            const errText = ((e?.response?.description || '') + ' ' + (e?.message || '')).toLowerCase();
            const isGone = errText.includes('message to edit not found') || errText.includes('message not found') || errText.includes('message_id_invalid');
            const isNotModified = errText.includes('not modified');
            if (isGone && !isNotModified) {
                const dmKey = String(link.counter_msg_id);
                if (d.dmNachrichten?.[dmKey]) {
                    for (const [uid2, dmId] of Object.entries(d.dmNachrichten[dmKey])) bot.telegram.deleteMessage(Number(uid2), dmId).catch(()=>{});
                    delete d.dmNachrichten[dmKey];
                }
                delete d.links[key]; removed++;
            }
        }
        await new Promise(r => setTimeout(r, 200));
    }
    if (removed) speichern();
    await ctx.reply('✅ ' + removed + ' gelöschte Links bereinigt. Vorher: ' + vorher + ' → Jetzt: ' + Object.keys(d.links).length);
});
bot.command('dmcleanup', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    await ctx.reply('🧹 Lösche DMs für bereits gelikte Links...');
    let deleted = 0;
    for (const [msgKey, uids] of Object.entries(d.dmNachrichten || {})) {
        const lnk = Object.values(d.links).find(l => String(l.counter_msg_id) === msgKey);
        for (const [uidStr, dmId] of Object.entries(uids)) {
            const hasLiked = lnk && lnk.likes && lnk.likes.has(String(uidStr));
            if (hasLiked) {
                bot.telegram.deleteMessage(Number(uidStr), dmId).catch(()=>{});
                delete d.dmNachrichten[msgKey][uidStr];
                deleted++;
            }
        }
        if (Object.keys(d.dmNachrichten[msgKey]).length === 0) delete d.dmNachrichten[msgKey];
        await new Promise(r => setTimeout(r, 50));
    }
    speichern();
    await ctx.reply('✅ ' + deleted + ' DMs gelöscht.');
});
bot.command('testweeklyranking', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; await weeklyRankingDM(); await ctx.reply('✅ Weekly!'); });
bot.command('time', (ctx) => { ctx.reply('🕒 ' + new Date().toString()); });


bot.command('setbio', async (ctx) => {
    if (!istPrivat(ctx.chat.type)) return ctx.reply('❌ Bitte im privaten Chat nutzen.');
    const uid = ctx.from.id;
    const bio = ctx.message.text.replace('/setbio', '').trim();
    if (!bio) return ctx.reply('❌ Bitte gib eine Bio an.\n\nBeispiel: /setbio Ich poste täglich Fitness Reels');
    if (bio.length > 100) return ctx.reply('❌ Bio max. 100 Zeichen.');
    const u = user(uid, ctx.from.first_name);
    u.bio = bio;
    speichern();
    await ctx.reply('✅ Bio gespeichert!\n\n✍️ ' + bio);
});

bot.command('setspitzname', async (ctx) => {
    if (!istPrivat(ctx.chat.type)) return ctx.reply('❌ Bitte im privaten Chat nutzen.');
    const uid = ctx.from.id;
    const spitzname = ctx.message.text.replace('/setspitzname', '').trim();
    if (!spitzname) return ctx.reply('❌ Bitte gib einen Spitznamen an.\n\nBeispiel: /setspitzname König der Reels');
    if (spitzname.length > 30) return ctx.reply('❌ Spitzname max. 30 Zeichen.');
    const u = user(uid, ctx.from.first_name);
    u.spitzname = spitzname;
    speichern();
    await ctx.reply('✅ Spitzname gespeichert: ' + spitzname);
});

bot.command('profil', async (ctx) => {
    const uid = ctx.from.id;
    const args = ctx.message.text.split(' ');
    let zielUid = uid;
    let zielUser = user(uid, ctx.from.first_name);

    // /profil @username oder /profil userid
    if (args[1]) {
        const suche = args[1].replace('@', '').toLowerCase();
        const gefunden = Object.entries(d.users).find(([, u]) =>
            (u.username && u.username.toLowerCase() === suche) ||
            (u.name && u.name.toLowerCase() === suche)
        );
        if (!gefunden) return ctx.reply('❌ User nicht gefunden.');
        zielUid = gefunden[0];
        zielUser = gefunden[1];
    }

    const u = zielUser;
    const sorted = Object.entries(d.users).filter(([id]) => !istAdminId(id)).sort((a, b) => b[1].xp - a[1].xp);
    const rank = sorted.findIndex(x => x[0] == zielUid) + 1;
    const bonusL = d.bonusLinks[zielUid] || 0;
    const nb = xpBisNaechstesBadge(u.xp || 0);
    const joinDatum = u.joinDate ? new Date(u.joinDate).toLocaleDateString('de-DE') : '—';
    const trophies = (u.trophies || []).join(' ') || '—';

    let text = '';
    text += '👤 *' + (u.spitzname || u.name || 'Unbekannt') + '*';
    if (u.spitzname) text += ' (' + u.name + ')';
    text += '\n';
    if (u.instagram) text += '📸 [@' + u.instagram + '](https://instagram.com/' + u.instagram + ')';
    if (u.username) text += (u.instagram ? '  ·  ' : '') + '💬 @' + u.username;
    if (u.instagram || u.username) text += '\n';
    if (u.bio) text += '✍️ _' + u.bio + '_\n';
    text += '\n━━━━━━━━━━━━━━\n';
    text += u.role + '  ·  ⭐ ' + (u.xp || 0) + ' XP  ·  Lvl ' + (u.level || 1) + '\n';
    text += '🏆 Rang #' + rank + '\n';
    text += '━━━━━━━━━━━━━━\n\n';
    text += '📅 Heute: ' + (d.dailyXP[zielUid] || 0) + ' XP  ·  📆 Woche: ' + (d.weeklyXP[zielUid] || 0) + ' XP\n';
    text += '🔗 ' + (u.links || 0) + ' Links  ·  👍 ' + (u.totalLikes || 0) + ' Likes\n';
    if (bonusL > 0) text += '🎁 Bonus Links: ' + bonusL + '\n';
    text += '⚠️ Warns: ' + (u.warnings || 0) + '/5  ·  📆 Seit: ' + joinDatum + '\n';
    if (nb) text += '\n⬆️ Noch ' + nb.fehlend + ' XP bis ' + nb.ziel;
    if (trophies !== '—') text += '\n\n🎖️ *Trophäen:* ' + trophies;

    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('remindinsta', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    let count = 0;
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started || u.parent_uid || (u.instagram && u.instagram.trim() !== '')) continue;
        try {
            await bot.telegram.sendMessage(Number(uid),
                '📸 *Hey ' + u.name + '!*\n\nDu hast noch keinen Instagram Account eingetragen.\n\nBitte trage deinen Instagram Namen ein damit wir dich besser supporten können! 💪\n\n👉 Tippe: /setinsta deinname',
                { parse_mode: 'Markdown' }
            );
            count++;
            await new Promise(r => setTimeout(r, 200));
        } catch (e) {}
    }
    await ctx.reply('✅ Erinnerung gesendet an ' + count + ' User ohne Instagram.');
});

bot.on('new_chat_members', async (ctx) => {
    for (const m of ctx.message.new_chat_members) {
        if (m.is_bot) continue;
        const newU = user(m.id, m.first_name);
        newU.inGruppe = true;
        if (newU.verlaessenAm) delete newU.verlaessenAm;
        const info = await ctx.telegram.getMe();
        await ctx.reply('👋 Willkommen *' + m.first_name + '*!\n\n⚠️ Starte den Bot per DM!\n\n👇', {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([Markup.button.url('📩 Bot starten', 'https://t.me/' + info.username + '?start=gruppe')]).reply_markup
        });
    }
});



bot.command('checkmembers', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    await ctx.reply('🔍 Prüfe Mitglieder...');
    await gruppenMitgliederPruefen();
    const aktiv = Object.values(d.users).filter(u => u.inGruppe !== false && u.started).length;
    await ctx.reply('✅ Fertig!\n\n👥 Aktiv: ' + aktiv + ' User');
});


// ================================
// MELDEN SYSTEM
// ================================
const meldenWarte = new Map();
const restoreWaiting = new Set();

async function startMeldenFlow(ctx, uid) {
    try {
        const userList = Object.entries(d.users)
            .filter(([id, u]) => !istAdminId(id) && u.started && Number(id) !== uid)
            .sort((a, b) => (a[1].name||'').localeCompare(b[1].name||''));
        if (!userList.length) return ctx.reply('❌ Keine User verfügbar.');
        const buttons = userList.map(([id, u]) => [Markup.button.callback(u.name || 'User', 'mld_' + id)]);
        meldenWarte.set(uid, { step: 'warte' });
        await ctx.reply('📋 *Meldung einreichen*\n\n👤 Wen möchtest du melden?', {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard(buttons).reply_markup
        });
    } catch(e) { console.log('melden Fehler:', e.message); }
}

bot.command('melden', async (ctx) => {
    const uid = ctx.from.id;
    if (istAdminId(uid)) return ctx.reply('⚙️ Admins können /melden nicht nutzen. Nur reguläre User können Verstöße melden.');
    try {
        if (!istPrivat(ctx.chat.type)) {
            const info = await ctx.telegram.getMe();
            return ctx.reply('📩 Bitte melde im privaten Chat!', {
                reply_markup: Markup.inlineKeyboard([[Markup.button.url('📩 Hier melden', 'https://t.me/' + info.username + '?start=melden')]]).reply_markup
            });
        }
        await startMeldenFlow(ctx, uid);
    } catch(e) { console.log('melden Fehler:', e.message); }
});

bot.action(/^mld_(.+)$/, async (ctx) => {
    try {
        const melderUid = ctx.from.id;
        const gemeldeterUid = ctx.match[1];
        const gemeldeter = d.users[gemeldeterUid];
        if (!gemeldeter) return ctx.answerCbQuery('❌ User nicht gefunden.');
        meldenWarte.set(melderUid, { step: 'nachricht', gemeldeterUid, gemeldeterName: gemeldeter.name });
        await ctx.editMessageText(
            '📋 *Meldung gegen:* ' + gemeldeter.name + '\n\n✍️ Schreib jetzt deine Meldung:',
            { parse_mode: 'Markdown' }
        );
        await ctx.answerCbQuery();
    } catch(e) { console.log('mld action Fehler:', e.message); }
});


// ================================
// TELEGRAM SHOP
// ================================
async function sendShopNachricht(ctx, uid) {
    const u = d.users[String(uid)];
    if (!u) return ctx.reply('❌ Bitte zuerst der Gruppe beitreten.');
    const diamonds = u.diamonds || 0;
    const bonusLinks = d.bonusLinks?.[String(uid)] || 0;
    const week = getBerlinWeekKey();
    const isElitePlusShop = u.role === '🌟 Elite+';
    const maxSLShop = isElitePlusShop ? 2 : 1;
    const slThisWeekShop = Object.values(d.superlinks||{}).filter(s => s.uid === String(uid) && s.week === week).length;
    const hasSLThisWeek = slThisWeekShop >= maxSLShop;
    const canBuyEl = diamonds >= 5;
    const canBuySL = diamonds >= 10 && !hasSLThisWeek;
    await ctx.reply(
        '🛒 *Telegram Shop*\n━━━━━━━━━━━━━━\n\n' +
        '💎 Dein Guthaben: *' + diamonds + ' Diamanten*\n\n' +
        '🔗 *Extra-Link — 5 💎*\nErlaubt dir heute einen zusätzlichen Link zu posten.\nVorhanden: ' + bonusLinks + '\n\n' +
        '⭐ *Superlink — 10 💎*\n' + maxSLShop + '× pro Woche im Full Engagement Thread.\nWird beim Posten via /superlink abgezogen.' +
        '\nDiese Woche: ' + slThisWeekShop + '/' + maxSLShop + (hasSLThisWeek ? ' ✅' : ''),
        {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('🔗 Extra-Link kaufen — 5 💎' + (canBuyEl ? '' : ' (zu wenig 💎)'), 'shopbuy_el')],
                [Markup.button.callback('⭐ Superlink posten → /superlink', 'shopinfo_sl')],
                [Markup.button.callback('🔄 Aktualisieren', 'shop_refresh')],
            ]).reply_markup
        }
    );
}

bot.command('shop', async (ctx) => {
    const uid = ctx.from.id;
    // Admin-Block entfernt — Admins können /shop ansehen (User-Anfrage zur Vorschau)
    if (!istPrivat(ctx.chat.type)) {
        try {
            await sendShopNachricht({ reply: (text, opts) => bot.telegram.sendMessage(uid, text, opts) }, uid);
            await ctx.reply('🛒 Shop wurde dir per DM gesendet!');
        } catch(e) {
            await ctx.reply('❌ Bitte starte zuerst den Bot: @' + (await ctx.telegram.getMe()).username);
        }
        return;
    }
    await sendShopNachricht(ctx, uid);
});

bot.action('shopbuy_el', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const uid = String(ctx.from.id);
        const u = d.users[uid];
        if (!u) return;
        if ((u.diamonds||0) < 5) return ctx.reply('❌ Nicht genug Diamanten (benötigt: 5, vorhanden: ' + (u.diamonds||0) + ')');
        u.diamonds = (u.diamonds||0) - 5;
        if (!d.bonusLinks) d.bonusLinks = {};
        d.bonusLinks[uid] = (d.bonusLinks[uid] || 0) + 1;
        speichern();
        addNotification(uid, '🔗', 'Extra-Link gekauft! Du kannst heute einen zusätzlichen Link posten. 💎 -5 Diamanten.');
        await ctx.reply('✅ *Extra-Link gekauft!*\n\n💎 Verbleibend: ' + u.diamonds + ' Diamanten\n🔗 Bonus-Links: ' + d.bonusLinks[uid], { parse_mode: 'Markdown' });
    } catch(e) { console.log('shopbuy_el Fehler:', e.message); }
});

bot.action('shopinfo_sl', async (ctx) => {
    try {
        await ctx.answerCbQuery('Nutze /superlink um deinen Superlink zu posten (10 💎).');
    } catch(e) {}
});

bot.action('shop_refresh', async (ctx) => {
    try {
        await ctx.answerCbQuery('🔄 Aktualisiert!');
        await ctx.deleteMessage().catch(()=>{});
        await sendShopNachricht(ctx, ctx.from.id);
    } catch(e) {}
});

// ================================
// APP LOGIN CODE SYSTEM
// ================================
bot.command('mycode', async (ctx) => {
    const uid = String(ctx.from.id);
    const u = user(ctx.from.id, ctx.from.first_name);

    // Code generieren falls noch keiner existiert. Mit firstName + 4 zufälligen Ziffern hatten
    // mehrere "Max1234"-User Kollisionsrisiko (Login-Hijack: 1. Treffer gewinnt). Jetzt 8 zufällige
    // Hex-Zeichen + Kollisionscheck gegen alle bestehenden Codes.
    if (!u.appCode) {
        const taken = new Set(Object.values(d.users||{}).map(x => x.appCode).filter(Boolean));
        const namePart = (ctx.from.first_name||'user').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,8) || 'user';
        let candidate;
        do {
            const rand = crypto.randomBytes(4).toString('hex'); // 8 hex chars, ~1 in 4 Mrd
            candidate = namePart + rand;
        } while (taken.has(candidate));
        u.appCode = candidate;
        speichern();
    }

    const appLink = APP_URL || 'https://web-production-7981d.up.railway.app';
    await ctx.reply(
        '🔐 *Dein CreatorX Login Code*\n\n' +
        '`' + u.appCode + '`\n\n' +
        '👆 Tippe auf den Code zum Kopieren\n\n' +
        '🌐 *Link zur App:*\n' + appLink + '\n\n' +
        '⚠️ *Wichtig:* Öffne den Link in einem richtigen Browser (Chrome, Safari) — nicht direkt in Telegram!\n\n' +
        '👉 Entweder den Link kopieren und im Browser eingeben, oder auf den Link tippen → dann oben rechts „Im Browser öffnen" wählen.\n\n' +
        '📲 *App auf Homescreen hinzufügen:*\n' +
        '• *iPhone (Safari):* Teilen-Symbol → „Zum Home-Bildschirm"\n' +
        '• *Android (Chrome):* Menü (⋮) → „Zum Startbildschirm hinzufügen"\n\n' +
        '⚠️ Teile deinen Code mit niemandem!',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🚀 App öffnen', url: appLink }]] } }
    );
});

bot.on('left_chat_member', async (ctx) => {
    try {
        const m = ctx.message.left_chat_member;
        if (!m || m.is_bot) return;
        const uid = String(m.id);
        if (d.users[uid] && !istAdminId(Number(uid))) {
            // Email-User: NICHT löschen — App-Zugang bleibt erhalten, nur als 'nicht in Gruppe' markieren.
            if (d.users[uid].email) {
                d.users[uid].inGruppe = false;
                d.users[uid].leftGroupAt = Date.now();
                speichern();
                console.log('Email-User behalten (left group):', m.first_name, uid);
                return;
            }
            delete d.users[uid];
            delete d.dailyXP[uid];
            delete d.weeklyXP[uid];
            delete d.bonusLinks[uid];
            delete d.missionen[uid];
            delete d.tracker[uid];
            delete d.counter[uid];
            delete d.badgeTracker[uid];
            delete d.wochenMissionen[uid];
            delete d.missionQueue[uid];
            delete d.m1Streak[uid];
            if (d.notifications) delete d.notifications[uid];
            speichern();
            console.log('User gelöscht:', m.first_name, uid);
        }
    } catch(e) { console.log('left_chat_member Fehler:', e.message); }
});

// Capture forum topic names when topics are created
bot.on('message', async (ctx, next) => {
    if (ctx.chat?.id === GROUP_B_ID && ctx.message?.forum_topic_created) {
        const name = ctx.message.forum_topic_created.name;
        // icon_emoji_id ist eine Custom-Sticker-ID (numerisch) — nicht renderbar als Zeichen.
        // Stattdessen Default-Pin nutzen; App rendert dann hash-basiertes Emoji aus dem Namen.
        const rawEmoji = ctx.message.forum_topic_created.icon_emoji_id;
        const emoji = (!rawEmoji || /^\d+$/.test(String(rawEmoji))) ? '📌' : String(rawEmoji);
        const topicId = String(ctx.message.message_id);
        if (!d.threads) d.threads = [];
        const existing = d.threads.find(t => String(t.id) === topicId);
        if (existing) { existing.name = name; existing.emoji = emoji; }
        else d.threads.push({ id: Number(topicId), name, emoji, last_msg: null, msg_count: 0 });
        speichern();
    }
    // Forum Topic edited: Namen synchronisieren wenn Admin im Telegram umbenennt
    if (ctx.chat?.id === GROUP_B_ID && ctx.message?.forum_topic_edited) {
        const ed = ctx.message.forum_topic_edited;
        const topicId = String(ctx.message.message_thread_id || ctx.message.message_id);
        if (d.threads) {
            const t = d.threads.find(x => String(x.id) === topicId);
            if (t) {
                if (ed.name) t.name = ed.name;
                if (ed.icon_emoji_id !== undefined) {
                    t.emoji = (!ed.icon_emoji_id || /^\d+$/.test(String(ed.icon_emoji_id))) ? '📌' : String(ed.icon_emoji_id);
                }
                speichern();
            }
        }
    }
    return next();
});

bot.on('message', async (ctx, next) => {
    // Befehle (/foo) durchreichen an die bot.command(...) Handler weiter unten
    if (ctx.message?.text?.startsWith('/')) return next();
    try {
        const uid_msg = ctx.from.id;

        // Restore Data via document upload
        if (restoreWaiting.has(uid_msg) && ctx.message?.document) {
            const doc = ctx.message.document;
            restoreWaiting.delete(uid_msg);
            try {
                const fileLink = await bot.telegram.getFileLink(doc.file_id);
                const resp = await fetch(fileLink.href);
                const text = await resp.text();
                const parsed = JSON.parse(text);
                Object.assign(d, parsed);
                speichern();
                await ctx.reply(`✅ Daten wiederhergestellt! ${Object.keys(parsed.users||{}).length} User geladen.`);
            } catch (e) {
                await ctx.reply('❌ Fehler beim Laden: ' + e.message);
            }
            return;
        }

        // Melden System
        if (meldenWarte.has(uid_msg) && istPrivat(ctx.chat.type)) {
            const text = ctx.message.text;
            const melde = meldenWarte.get(uid_msg);
            if (text && !text.startsWith('/') && melde?.step === 'nachricht') {
                meldenWarte.delete(uid_msg);
                const melder = d.users[String(uid_msg)];
                const adminText = '🚨 *Neue Meldung!*\n\n👤 *Gemeldet:* ' + melde.gemeldeterName + ' (ID: ' + melde.gemeldeterUid + ')\n\n📝 ' + text + '\n\n👤 *Von:* ' + (melder?.name || ctx.from.first_name) + (ctx.from.username ? ' @' + ctx.from.username : '');
                for (const adminId of [...ADMIN_IDS]) {
                    try {
                        await bot.telegram.sendMessage(Number(adminId), adminText, { parse_mode: 'Markdown' });
                        console.log('✅ Meldung an Admin gesendet:', adminId);
                    } catch(e) { console.log('❌ Admin DM Fehler:', adminId, e.message); }
                }
                return ctx.reply('✅ *Meldung eingereicht!*\n\nDanke! Der Admin kümmert sich darum.', { parse_mode: 'Markdown' });
            }
        }

        if (istPrivat(ctx.chat.type) && d.instaWarte[ctx.from.id]) {
            const text = ctx.message.text;
            if (!text) return;
            const clean = text.replace('@', '').trim();
            const u = user(ctx.from.id, ctx.from.first_name);
            u.instagram = clean;
            delete d.instaWarte[ctx.from.id];
            speichern();
            await ctx.reply('✅ Instagram gespeichert: @' + clean);
            return;
        }

        // Superlink-Wartestand: User antwortet mit Instagram-Link nach /superlink
        if (istPrivat(ctx.chat.type) && _slWaiting?.[String(ctx.from.id)]) {
            const uid = String(ctx.from.id);
            const waitedAt = _slWaiting[uid];
            if (Date.now() - waitedAt < 5 * 60 * 1000) { // 5 Minuten Fenster
                const text = ctx.message.text || '';
                if (text.includes('instagram.com')) {
                    delete _slWaiting[uid];
                    await handleSuperlink(ctx, uid, d.users[uid], text).catch(e => ctx.reply('❌ Fehler: ' + e.message));
                    return;
                } else if (text && !text.startsWith('/')) {
                    await ctx.reply('❌ Bitte sende einen gültigen Instagram-Link (instagram.com/...)');
                    return;
                }
            } else {
                delete _slWaiting[uid];
            }
        }

        if (!ctx.message || !ctx.from) return;
        if (!istGruppe(ctx.chat.type)) return;

        // Community Feed – alle GROUP_B Nachrichten (außer Bot)
        if (ctx.chat.id === GROUP_B_ID && !ctx.from.is_bot) {
            const threadId = String(ctx.message.message_thread_id || 'general');
            const senderUid = String(ctx.from.id);

            // Full Engagement thread → handle as Superlink
            if (d.fullEngagementThreadId && threadId === String(d.fullEngagementThreadId)) {
                const text = ctx.message.text || ctx.message.caption || '';
                if (text && text.includes('instagram.com')) {
                    await handleSuperlink(ctx, senderUid, d.users[senderUid], text).catch(()=>{});
                } else if (text && !ctx.from.is_bot) {
                    try { await ctx.deleteMessage(); } catch(e) {}
                    try { await bot.telegram.sendMessage(Number(senderUid), '⭐ Hier nur Instagram-Links posten! Nutze z.B.: https://www.instagram.com/p/XYZ'); } catch(e) {}
                }
                return;
            }

            const senderUser = d.users[senderUid];
            let msgType = 'text', msgContent = '', mediaId = null;
            if (ctx.message.text) {
                msgContent = ctx.message.text; msgType = 'text';
            } else if (ctx.message.photo?.length) {
                mediaId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                msgContent = ctx.message.caption || ''; msgType = 'photo';
            } else if (ctx.message.sticker) {
                mediaId = ctx.message.sticker.file_id;
                msgContent = ctx.message.sticker.emoji || '🎭'; msgType = 'sticker';
            } else if (ctx.message.video) {
                msgContent = ctx.message.caption || ''; msgType = 'video';
            }
            if (msgType) {
                const tgName = ctx.from.username ? '@' + ctx.from.username : null;
                const entry = {
                    uid: senderUid,
                    tgName,
                    name: senderUser?.spitzname || senderUser?.name || ctx.from.first_name || 'Unbekannt',
                    role: senderUser?.role || null,
                    type: msgType,
                    text: msgContent,
                    mediaId,
                    timestamp: (ctx.message.date || Math.floor(Date.now() / 1000)) * 1000,
                    msg_id: ctx.message.message_id,
                };
                if (!d.threadMessages[threadId]) d.threadMessages[threadId] = [];
                d.threadMessages[threadId].unshift(entry);
                if (d.threadMessages[threadId].length > 100) d.threadMessages[threadId] = d.threadMessages[threadId].slice(0, 100);
                // Update or auto-create thread metadata
                if (!d.threads) d.threads = [];
                let thr = d.threads.find(t => String(t.id) === threadId);
                // Fallback-Name aus reply_to_message.forum_topic_created (oft mitgesendet)
                const ftc = ctx.message?.reply_to_message?.forum_topic_created;
                const inferredName = ftc?.name;
                const inferredRawEmoji = ftc?.icon_emoji_id;
                const inferredEmoji = (!inferredRawEmoji || /^\d+$/.test(String(inferredRawEmoji))) ? '📌' : String(inferredRawEmoji);
                if (!thr) {
                    thr = {
                        id: threadId === 'general' ? 'general' : Number(threadId),
                        name: threadId === 'general' ? 'Allgemein' : (inferredName || `Thread ${threadId}`),
                        emoji: threadId === 'general' ? '💬' : inferredEmoji,
                        last_msg: null, msg_count: 0
                    };
                    threadId === 'general' ? d.threads.unshift(thr) : d.threads.push(thr);
                } else if (inferredName && (thr.name === `Thread ${threadId}` || !thr.name)) {
                    // Backfill für früher auto-erstellte Threads ohne richtigen Namen
                    thr.name = inferredName;
                    if (inferredEmoji !== '📌' || thr.emoji === '📌') thr.emoji = inferredEmoji;
                }
                thr.last_msg = entry; thr.msg_count = d.threadMessages[threadId].length;
                // Track daily group messages
                if (!d.dailyGroupMsgs[senderUid]) d.dailyGroupMsgs[senderUid] = 0;
                d.dailyGroupMsgs[senderUid]++;
                // Backwards compat communityFeed
                if (msgType === 'text') {
                    if (!d.communityFeed) d.communityFeed = [];
                    d.communityFeed.unshift({ username: tgName || entry.name, name: entry.name, text: msgContent, timestamp: entry.timestamp, thread_id: threadId === 'general' ? null : Number(threadId), msg_id: entry.msg_id });
                    if (d.communityFeed.length > 100) d.communityFeed = d.communityFeed.slice(0, 100);
                }
            }
        }

        const uid = ctx.from.id;
        const u = user(uid, ctx.from.first_name);
        const text = ctx.message.text || ctx.message.caption || '';

        if (!hatLink(text)) {
            if (ctx.chat.id === GROUP_A_ID) {
                const istAdminMsg = await istAdmin(ctx, uid);
                if (!istAdminMsg) {
                    try {
                        await ctx.forwardMessage(GROUP_B_ID);
                        await ctx.deleteMessage();
                        const hinweis = await ctx.reply('📨 *' + ctx.from.first_name + '*, deine Nachricht wurde weitergeleitet!', { parse_mode: 'Markdown' });
                        setTimeout(async () => { try { await ctx.telegram.deleteMessage(ctx.chat.id, hinweis.message_id); } catch (e) {} }, 30000);
                    } catch (e) {}
                }
            }
            return;
        }

        const admin = await istAdmin(ctx, uid) || istAdminId(uid);
        if (admin || u.links > 0 || u.xp > 0) u.started = true;

        if (!u.started) {
            try { await ctx.deleteMessage(); } catch (e) {}
            const info = await ctx.telegram.getMe();
            const warteMsg = await ctx.reply('⚠️ *' + ctx.from.first_name + '*, starte den Bot per DM!', {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([Markup.button.url('📩 Bot starten', 'https://t.me/' + info.username + '?start=gruppe')]).reply_markup
            });
            d.warteNachricht[uid] = { chatId: ctx.chat.id, msgId: warteMsg.message_id };
            speichern(); return;
        }

        // Prefer Instagram-URL-Extraktion (sauber), fallback auf linkUrl (whole-text Validator).
        const cleanUrl = extractInstagramUrl(text) || linkUrl(text);
        const url = cleanUrl;
        const urlNorm = normalisiereUrl(cleanUrl);
        if (cleanUrl && d.gepostet.some(g => normalisiereUrl(g) === urlNorm)) {
            if (!admin) {
                try { await ctx.deleteMessage(); } catch (e) {}
                const msg = await ctx.reply('❌ Duplikat! Dieser Link wurde bereits gepostet.');
                setTimeout(async () => { try { await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch (e) {} }, 10000);
                try { await ctx.telegram.sendMessage(uid, '⚠️ Dein Link wurde gelöscht - bereits gepostet.'); } catch (e) {}
                return;
            }
        }
        if (url) { d.gepostet.push(url); if (d.gepostet.length > 2000) d.gepostet.shift(); }

        if (!d.counter[uid]) d.counter[uid] = 0;
        const heute = new Date().toDateString();

        if (!admin && d.tracker[uid] === heute) {
            if (hatBonusLink(uid)) {
                bonusLinkNutzen(uid);
                await ctx.reply('🎁 Bonus Link genutzt!');
            } else if (badgeBonusLinks(u.xp) > 0 && (!d.badgeTracker[uid] || d.badgeTracker[uid] !== heute)) {
                d.badgeTracker[uid] = heute;
                await ctx.reply('🏅 Erfahrener Extra Link genutzt!');
            } else {
                try { await ctx.deleteMessage(); } catch (e) {}
                d.counter[uid]++;
                if (u.warnings >= 5) {
                    try { await ctx.telegram.banChatMember(ctx.chat.id, uid); } catch (e) {}
                    await ctx.reply('🔨 *' + ctx.from.first_name + '* gebannt!', { parse_mode: 'Markdown' });
                } else {
                    const msg = await ctx.reply('❌ Nur 1 Link pro Tag!\n🕛 Ab Mitternacht wieder möglich.');
                    setTimeout(async () => { try { await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch (e) {} }, 10000);
                    try { await ctx.telegram.sendMessage(uid, '⚠️ Link gelöscht! Morgen wieder möglich.'); } catch (e) {}
                }
                speichern(); return;
            }
        }

        if (istAdminId(uid)) { u.xp = 0; u.level = 1; u.role = '⚙️ Admin'; }
        if (!istAdminId(uid)) d.tracker[uid] = heute;
        d.counter[uid] = 0;
        if (!istAdminId(uid)) { u.links++; xpAddMitDaily(uid, 1, ctx.from.first_name); }

        const msgId = ctx.message.message_id;
        const istInsta = istInstagramLink(text);

        if (istInsta) {
            // App-only Flow: Bot löscht User-Message, postet KEINE Karte in der Gruppe.
            // Link wird mit synthetischer ID in d.links gespeichert → erscheint im
            // App-Feed und wird in der nächsten 30-Min-Batch-DM angekündigt.
            try { await ctx.deleteMessage(); } catch (e) {}

            // URL extrahieren + Caption-Text trennen → konsistent mit App-Post-Pfad.
            // Vorher: text=fullMessage (z.B. 'Schaut mein Reel <URL>') → window.open() bricht.
            const extractedUrl = extractInstagramUrl(text) || text;
            const captionText = (text === extractedUrl) ? '' : text.replace(extractedUrl, '').trim();

            const linkId = generateSyntheticLinkId();
            const mapKey = linkId;
            d.links[mapKey] = {
                chat_id: ctx.chat.id, user_id: uid, user_name: ctx.from.first_name,
                text: extractedUrl, caption: captionText,
                likes: new Set(), likerNames: {},
                counter_msg_id: linkId, timestamp: Date.now(),
                origin: 'telegram', appOnly: true,
                likeSource: { app: 0, telegram: 0 }
            };
            tryFetchThumbnail(d.links[mapKey], 'text');

            // Confirmation-DM an Poster mit Magic-Link in den App-Feed.
            try {
                const magicUrl = buildMagicLinkUrl(uid, '/feed?tab=heute');
                await bot.telegram.sendMessage(Number(uid),
                    '✅ *Dein Link ist im Feed!*\n\nDein Instagram-Link wurde aus der Gruppe in den App-Feed übernommen. Andere User werden in der nächsten 30-Min-DM-Welle benachrichtigt.\n\n💡 *Vergiss nicht*: andere Links liken & mit 2 Wörtern kommentieren — Pflicht!',
                    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📲 Im Feed engagen', url: magicUrl }]] } }
                );
            } catch (e) {}

            const linkKeys = Object.keys(d.links);
            if (linkKeys.length > 500) {
                const oldest = linkKeys.sort((a, b) => d.links[a].timestamp - d.links[b].timestamp)[0];
                delete d.links[oldest];
            }
        } else if (!istAdminId(uid)) {
            const mapKey = MEINE_GRUPPE + '_' + msgId;
            d.links[mapKey] = { chat_id: ctx.chat.id, user_id: uid, user_name: ctx.from.first_name, text: text, likes: new Set(), likerNames: {}, counter_msg_id: msgId, timestamp: Date.now(), origin: 'telegram', likeSource: { app: 0, telegram: 0 } };
            tryFetchThumbnail(d.links[mapKey], 'text');
        }
        speichern();
    } catch (e) { console.log('Message Handler Fehler:', e.message); }
});

function buildLinkKarte(name, role, link, anz, xp, isAdmin) {
    const header = isAdmin ? '⚙️ Admin ' + name : '👤 ' + name + '  ' + role;
    const stats = isAdmin ? '👍 ' + anz : '👍 ' + anz + '   ⭐ ' + xp + ' XP';
    return header + '\n🔗 ' + link + '\n\n━━━━━━━━━━━━━━\n' + stats + '\n━━━━━━━━━━━━━━';
}

function buildLinkButtons(msgId, anz) {
    return Markup.inlineKeyboard([[
        Markup.button.callback('👍 Like · ' + anz, 'like_' + msgId),
        Markup.button.callback('👁 Liker', 'liker_' + msgId)
    ]]).reply_markup;
}

const likeInProgress = new Set();

bot.action(/^like_(\d+)$/, async (ctx) => {
    const msgId = parseInt(ctx.match[1]);
    const uid = ctx.from.id;
    const mapKey = MEINE_GRUPPE + '_' + msgId;
    const likeKey = msgId + '_' + uid;

    let lnk = d.links[mapKey];
    if (!lnk) {
        lnk = d.links[msgId] || Object.values(d.links).find(l => String(l.counter_msg_id) === String(msgId));
    }
    if (!lnk) { try { await ctx.answerCbQuery('❌ Link nicht mehr vorhanden.'); } catch (e) {} return; }

    if (likeInProgress.has(likeKey)) { try { await ctx.answerCbQuery(); } catch (e) {} return; }
    likeInProgress.add(likeKey);
    setTimeout(() => likeInProgress.delete(likeKey), 5000);

    try {
        if (String(uid) === String(lnk.user_id)) { try { await ctx.answerCbQuery('❌ Kein Self-Like!'); } catch (e) {} return; }
        // Auch über Sub-Account-Verbindung: kein Like auf Posts vom eigenen Parent/Sub
        if (String(getRootUid(uid)) === String(getRootUid(lnk.user_id))) { try { await ctx.answerCbQuery('❌ Kein Self-Like!'); } catch (e) {} return; }
        if (lnk.likes.has(String(uid))) { try { await ctx.answerCbQuery('✅ Bereits geliked! (auch via App möglich)'); } catch (e) {} return; }

        lnk.likes.add(String(uid));
        lnk.likerNames[uid] = { name: ctx.from.first_name, insta: d.users[uid]?.instagram || null };
        if (!lnk.likeSource) lnk.likeSource = { app: 0, telegram: 0 };
        lnk.likeSource.telegram = (lnk.likeSource.telegram||0) + 1;
        const anz = lnk.likes.size;
        const poster = user(lnk.user_id, lnk.user_name);
        poster.totalLikes++;
        // Benachrichtigung an Poster
        if (!istAdminId(uid) && lnk.user_id !== uid) {
            const likerName = d.users[uid]?.spitzname || d.users[uid]?.name || 'Jemand';
            addNotification(String(lnk.user_id), '❤️', likerName + ' hat deinen Link geliked', String(uid));
            sendAppPush(String(lnk.user_id), '❤️ Neuer Like!', likerName + ' hat deinen Link geliked', '/feed').catch(()=>{});
        }

        const istHeutigerLink = new Date(lnk.timestamp).toDateString() === new Date().toDateString();
        let vergebenXP = 0;
        if (!istAdminId(uid)) {
            vergebenXP = istHeutigerLink ? xpAddMitDaily(uid, 5, ctx.from.first_name) : xpAdd(uid, 5, ctx.from.first_name);
        }

        const msgKey = String(lnk.counter_msg_id);
        const dmUidKey = String(uid);
        if (d.dmNachrichten?.[msgKey]?.[dmUidKey]) {
            try { await bot.telegram.deleteMessage(uid, d.dmNachrichten[msgKey][dmUidKey]); } catch (e) {}
            delete d.dmNachrichten[msgKey][dmUidKey];
        }

        if (!istAdminId(uid)) {
            const mission = getMission(uid);
            updateMissionProgress(uid);
            if (istHeutigerLink && istInstagramLink(lnk.text)) mission.likesGegeben++;
            await checkMissionen(uid, ctx.from.first_name);
        }

        const liker = user(uid, ctx.from.first_name);
        const nb = xpBisNaechstesBadge(liker.xp);
        const eventBonus = d.xpEvent?.aktiv && d.xpEvent.multiplier > 1 ? ` (+${Math.round((d.xpEvent.multiplier - 1) * 100)}% Event)` : '';
        const feedbackText = istAdminId(uid) ? '✅ Like registriert! (Admin)' : `🎉 +${vergebenXP} XP${eventBonus}  ·  ⭐ ` + liker.xp + '\n' + liker.role + (nb ? '  ·  ⬆️ Noch ' + nb.fehlend + ' bis ' + nb.ziel : '');

        const feedbackMsg = await ctx.reply(feedbackText);
        setTimeout(async () => { try { await ctx.telegram.deleteMessage(ctx.chat.id, feedbackMsg.message_id); } catch (e) {} }, 8000);

        try { await ctx.answerCbQuery('👍 ' + anz + '!'); } catch (e) {}

        try {
            await ctx.telegram.editMessageText(lnk.chat_id, lnk.counter_msg_id, null,
                buildLinkKarte(lnk.user_name, poster.role, lnk.text, anz, poster.xp, istAdminId(lnk.user_id)),
                { reply_markup: buildLinkButtons(msgId, anz) }
            );
        } catch (e) {}

        // Bridge Bot sync — nur für Counter update in anderer Gruppe, KEIN XP
        if (BRIDGE_BOT_URL) {
            try {
                const bridgeSyncUrl = BRIDGE_BOT_URL.replace('/new-link-from-group', '/sync-like');
                fetch(bridgeSyncUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'x-bridge-secret': BRIDGE_SECRET },
                    body: JSON.stringify({ fromGroup: MEINE_GRUPPE, msgId: msgId, likeCount: anz, mapKey: MEINE_GRUPPE + '_' + msgId, botMsgId: lnk.counter_msg_id })
                }).catch(e => console.log('Bridge sync failed:', e.message));
            } catch (e) {}
        }

        speichernDebounced();
    } catch (e) { console.log('Like Fehler:', e.message); }
    finally { likeInProgress.delete(likeKey); }
});

bot.action(/^liker_(\d+)$/, async (ctx) => {
    const msgId = parseInt(ctx.match[1]);
    const mapKey = MEINE_GRUPPE + '_' + msgId;
    let lnk = d.links[mapKey];
    if (!lnk) {
        lnk = d.links[msgId] || Object.values(d.links).find(l => String(l.counter_msg_id) === String(msgId));
    }
    if (!lnk) { try { await ctx.answerCbQuery('❌ Nicht gefunden.'); } catch (e) {} return; }

    const names = Object.values(lnk.likerNames || {}).map(l => l.name);
    if (!names.length) { try { await ctx.answerCbQuery('Noch keine Likes 👀', { show_alert: true }); } catch (e) {} return; }

    // Show all liker names; Telegram alert max ~200 chars
    let text = '👥 ' + names.join(', ');
    if (text.length > 195) {
        let shown = 0;
        let built = '👥 ';
        for (const n of names) {
            if ((built + n).length > 185) { built += `+${names.length - shown} weitere`; break; }
            built += (shown > 0 ? ', ' : '') + n;
            shown++;
        }
        text = built;
    }
    try { await ctx.answerCbQuery(text, { show_alert: true }); } catch (e) {}
});

bot.action('remind_insta', async (ctx) => {
    let count = 0;
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started || u.parent_uid || (u.instagram && u.instagram.trim() !== '')) continue;
        try {
            await bot.telegram.sendMessage(Number(uid), '📸 Bitte sende mir deinen Instagram Namen.\n\n(z.B. max123)', { reply_markup: { inline_keyboard: [[{ text: '📸 Instagram eingeben', callback_data: 'set_insta' }]] } });
            count++;
            await new Promise(r => setTimeout(r, 100));
        } catch (e) {}
    }
    await ctx.answerCbQuery(`✅ ${count} User erinnert`);
});

bot.action('set_insta', async (ctx) => {
    try {
        const uid = ctx.from.id;
        d.instaWarte[uid] = true; speichern();
        await ctx.answerCbQuery('✅ Sende mir jetzt deinen Insta Namen');
        await ctx.reply('📸 Schick mir jetzt deinen Instagram Namen.\n\n(z.B. max123)');
    } catch (err) { console.log('FEHLER set_insta:', err); }
});

// ── SUPERLINK ACTIONS ──
const slLikeInProgress = new Set();
const _slWaiting = {};
bot.action(/^sllike_(.+)$/, async (ctx) => {
    // Liken läuft nur noch über die App — TG-Button wird vom Bot stummgeschaltet.
    try { await ctx.answerCbQuery('⭐ Liken läuft jetzt nur noch über die App. Öffne den Feed → Engagement-Tab.', { show_alert: true }); } catch(e) {}
});

bot.action(/^slliker_(.+)$/, async (ctx) => {
    const slId = ctx.match[1];
    const sl = d.superlinks?.[slId];
    if (!sl) return ctx.answerCbQuery('❌ Nicht gefunden');
    const likes = Array.isArray(sl.likes) ? sl.likes : [];
    if (!likes.length) return ctx.answerCbQuery('Noch keine Likes 👀', { show_alert: true });
    const names = likes.map(likerUid => {
        const liker = d.users[String(likerUid)];
        return liker?.spitzname||liker?.name||'User';
    });
    let text = '❤️ ' + names.join(', ');
    if (text.length > 195) {
        let shown = 0, built = '❤️ ';
        for (const n of names) {
            if ((built + n).length > 185) { built += `+${names.length - shown} weitere`; break; }
            built += (shown > 0 ? ', ' : '') + n; shown++;
        }
        text = built;
    }
    try { await ctx.answerCbQuery(text, { show_alert: true }); } catch(e) {}
});

bot.action(/^slrepuser_(\w+)_(\d+)$/, async (ctx) => {
    try {
        const slId = ctx.match[1];
        const likerUid = ctx.match[2];
        const reporterUid = String(ctx.from.id);
        const sl = d.superlinks?.[slId];
        if (!sl) return ctx.answerCbQuery('❌ Nicht gefunden');
        if (sl.uid !== reporterUid) return ctx.answerCbQuery('❌ Nur der Poster kann melden');
        const reporter = d.users[reporterUid];
        const liker = d.users[likerUid];
        const adminMsg = '🚨 *Engagement Report*\n\n' +
            '👤 *Poster:* ' + (reporter?.spitzname||reporter?.name||'User') + '\n' +
            '🚩 *Gemeldet:* ' + (liker?.spitzname||liker?.name||likerUid) + '\n' +
            '🔗 ' + sl.url + '\n' +
            'Grund: Hat nicht vollständig geliked/kommentiert/geteilt/gespeichert\n' +
            '📅 Woche: ' + sl.week;
        for (const adminId of ADMIN_IDS) {
            try { await bot.telegram.sendMessage(Number(adminId), adminMsg, { parse_mode: 'Markdown' }); } catch(e){}
        }
        await ctx.answerCbQuery('✅ ' + (liker?.name||'User') + ' wurde gemeldet!', { show_alert: true });
    } catch(e) { console.log('slrepuser Fehler:', e.message); await ctx.answerCbQuery('❌ Fehler'); }
});

bot.action(/^slrep_(.+)$/, async (ctx) => {
    try {
        const slId = ctx.match[1];
        const reporterUid = String(ctx.from.id);
        const sl = d.superlinks?.[slId];
        if (!sl) return ctx.answerCbQuery('❌ Superlink nicht gefunden.');
        if (sl.uid === reporterUid) return ctx.answerCbQuery('❌ Du kannst deinen eigenen Superlink nicht melden.');
        const reporter = d.users[reporterUid];
        const poster = d.users[sl.uid];
        const adminMsg = '🚩 *Superlink Meldung*\n\n' +
            '📌 *Gemeldeter Superlink:*\n' +
            '👤 Poster: ' + (poster?.spitzname||poster?.name||sl.uid) + '\n' +
            '🔗 ' + sl.url + (sl.caption ? '\n💬 ' + sl.caption : '') + '\n\n' +
            '👤 *Gemeldet von:* ' + (reporter?.spitzname||reporter?.name||ctx.from.first_name) + (ctx.from.username ? ' @' + ctx.from.username : '') + '\n' +
            '📅 Woche: ' + sl.week;
        for (const adminId of ADMIN_IDS) {
            try { await bot.telegram.sendMessage(Number(adminId), adminMsg, { parse_mode: 'Markdown' }); } catch(e){}
        }
        await ctx.answerCbQuery('✅ Superlink wurde gemeldet! Admins wurden informiert.', { show_alert: true });
    } catch(e) { console.log('slrep Fehler:', e.message); await ctx.answerCbQuery('❌ Fehler'); }
});

bot.command(['givesuperlink','givesl'], async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const args = (ctx.message.text||'').split(/\s+/).slice(1);
    let targetUid = null, allText = args.join(' ');
    if (ctx.message.reply_to_message) {
        // Reply auf eine Superlink-Karte? → User über msg_id der Karte ermitteln
        const replyMsgId = Number(ctx.message.reply_to_message.message_id);
        const replySl = Object.values(d.superlinks||{}).find(s => Number(s.msg_id) === replyMsgId);
        if (replySl) {
            targetUid = String(replySl.uid);
        } else {
            targetUid = String(ctx.message.reply_to_message.from.id);
        }
    } else {
        const target = args.shift() || '';
        allText = args.join(' ');
        if (/^\d+$/.test(target)) targetUid = target;
        else if (target.startsWith('@')) {
            const uname = target.slice(1).toLowerCase();
            const found = Object.entries(d.users||{}).find(([id, u]) =>
                String(u?.username||'').toLowerCase() === uname ||
                String(u?.spitzname||'').toLowerCase() === uname ||
                String(u?.name||'').toLowerCase() === uname
            );
            if (!found) return ctx.reply('❌ User '+target+' nicht gefunden.\nNutzung: /givesuperlink <UserID|@username|@name> [Instagram-Link]\nOder als Reply auf eine User-Nachricht (mit oder ohne Link).');
            targetUid = found[0];
        } else if (target) {
            return ctx.reply('❌ Erstes Argument muss UserID, @username oder Reply sein.\nNutzung: /givesuperlink <UserID|@username> [Instagram-Link]');
        }
    }
    if (!targetUid) return ctx.reply('❌ Kein Target-User. Nutzung: /givesuperlink <UserID|@username> [Instagram-Link]\nOder Reply auf User-Nachricht.');
    const urlMatch = allText.match(/(?:https?:\/\/)?((?:www\.)?instagram\.com\/[^\s]+)/i);
    // OHNE URL = Slot/Gutschein-Modus: User darf selbst einen Extra-Superlink posten
    if (!urlMatch) {
        const u = d.users[targetUid];
        if (!u) return ctx.reply('❌ User '+targetUid+' nicht in Daten. User muss erst /start im Bot machen.');
        u.superlinkCredits = (u.superlinkCredits||0) + 1;
        speichern();
        try { await bot.telegram.sendMessage(Number(targetUid),
            '🎁 *Superlink-Gutschein erhalten!*\n\nEin Admin hat dir einen *Superlink-Slot* freigeschaltet!\n\n' +
            'Du kannst jetzt einen *zusätzlichen Superlink* posten — auch wenn dein Wochenlimit erreicht ist und ohne 10 💎 zu zahlen.\n\n' +
            '📲 So gehts: schreib hier `/superlink <dein-Instagram-Link>` oder posts den Link einfach in den Full-Engagement-Thread.\n\n' +
            '✅ Verbleibende Slots: ' + u.superlinkCredits,
            { parse_mode: 'Markdown' }); } catch(e) {}
        sendAppPush(targetUid, '🎁 Superlink-Slot!', 'Admin hat dir einen Superlink-Slot gegeben — nutze /superlink', '/feed?tab=engagement&opensl=1').catch(()=>{});
        return ctx.reply('✅ ' + (u.spitzname||u.name||targetUid) + ' hat jetzt *' + u.superlinkCredits + '* Superlink-Slot(s)\n\nDer User kann mit `/superlink <Instagram-Link>` einen Extra-Superlink posten.', { parse_mode:'Markdown' });
    }
    let url = urlMatch[0].startsWith('http') ? urlMatch[0] : 'https://' + urlMatch[0];
    url = url.replace(/[.,;!?]+$/, '');
    const caption = allText.replace(urlMatch[0], '').trim();
    const u = d.users[targetUid];
    if (!u) return ctx.reply('❌ User '+targetUid+' nicht in Daten. User muss zuerst /start im Bot machen.');
    let feThreadId;
    try { feThreadId = await ensureFullEngagementThread(); } catch(e) {}
    if (!feThreadId) return ctx.reply('❌ Full Engagement Thread nicht verfügbar.');
    const slId = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    const week = getBerlinWeekKey();
    const cardCaption = (caption || '') + (caption ? ' · ' : '') + '🎁 Geschenk vom Admin';
    const cardText = buildSuperLinkKarte((u.spitzname||u.name||'User'), u.instagram, url, cardCaption, 0, {});
    try {
        const sent = await bot.telegram.sendMessage(GROUP_B_ID, cardText, {
            parse_mode: 'HTML',
            message_thread_id: Number(feThreadId),
            reply_markup: buildSuperLinkButtons(slId, 0)
        });
        d.superlinks = d.superlinks || {};
        d.superlinks[slId] = {
            id: slId, uid: targetUid, url, caption,
            msg_id: sent.message_id, timestamp: Date.now(), week,
            likes: [], likerNames: {},
            gift: true, giftedBy: String(ctx.from.id),
            dmNotifications: {}
        };
        tryFetchThumbnail(d.superlinks[slId], 'url');
        const feThreadKey = String(feThreadId);
        if (!d.threadMessages[feThreadKey]) d.threadMessages[feThreadKey] = [];
        d.threadMessages[feThreadKey].unshift({
            uid: targetUid, tgName: u.username ? '@'+u.username : null,
            name: (u.spitzname||u.name||'User'),
            role: u.role || null, type: 'text',
            text: '🎁 Admin-Geschenk · Superlink:\n🔗 ' + url + (caption ? '\n' + caption : '') + '\n👍 0 Likes',
            mediaId: null, timestamp: Date.now(), msg_id: sent.message_id, slId, gift: true
        });
        if (d.threadMessages[feThreadKey].length > 100) d.threadMessages[feThreadKey] = d.threadMessages[feThreadKey].slice(0, 100);
        const feThr = (d.threads||[]).find(t => String(t.id) === feThreadKey);
        if (feThr) { feThr.last_msg = d.threadMessages[feThreadKey][0]; feThr.msg_count = d.threadMessages[feThreadKey].length; }
        speichern();
        try { await bot.telegram.sendMessage(Number(targetUid), '🎁 *Du hast einen Superlink geschenkt bekommen!*\n\nEin Admin hat dir einen Superlink im Full-Engagement-Thread gepostet. Engagement-Pflicht für alle anderen Superlinks der Woche bleibt!\n\n🔗 ' + url, { parse_mode: 'Markdown' }); } catch(e) {}
        sendAppPush(targetUid, '🎁 Superlink geschenkt!', 'Admin hat dir einen Superlink gegeben — engage die anderen!', '/feed?tab=engagement').catch(()=>{});
        const otherPosters = Object.values(d.superlinks).filter(s => s.week === week && s.uid !== targetUid);
        for (const other of otherPosters) {
            try {
                const magicUrlGift = buildMagicLinkUrl(other.uid, '/feed?tab=engagement');
                const dmMsg = await bot.telegram.sendMessage(Number(other.uid),
                    `⭐ *Neuer Superlink (Geschenk)!*\n\n👤 ${u.spitzname||u.name||'User'} · 🔗 ${url}\n\n⚠️ Engagement-Pflicht!`,
                    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📲 Im Engagement-Feed öffnen', url: magicUrlGift }]] } }
                );
                if (dmMsg?.message_id) d.superlinks[slId].dmNotifications[String(other.uid)] = dmMsg.message_id;
                sendAppPush(String(other.uid), '⭐ Neuer Superlink!', (u.spitzname||u.name||'User') + ' (Geschenk) — engagen', '/feed?tab=engagement').catch(()=>{});
            } catch(e) {}
        }
        speichern();
        await ctx.reply('✅ Superlink geschenkt an ' + (u.spitzname||u.name||targetUid) + '\n\n🆔 ID: `' + slId + '`\n📨 msg_id: ' + sent.message_id + '\n🎁 markiert als Admin-Geschenk', { parse_mode: 'Markdown' });
    } catch(e) {
        await ctx.reply('❌ Fehler: ' + e.message);
    }
});

bot.command('delete', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    const replyTo = ctx.message.reply_to_message;
    if (!replyTo) return ctx.reply('❌ /delete als Reply auf eine Superlink-Karte verwenden.\nFür beliebige Superlink-ID: /deletesuperlink <slId>');
    const targetMsgId = Number(replyTo.message_id);
    const sl = Object.values(d.superlinks||{}).find(s => Number(s.msg_id) === targetMsgId);
    if (!sl) {
        return ctx.reply('❌ Diese Nachricht ist kein Superlink (oder schon aus der DB entfernt).\nFalls Telegram-Nachricht trotzdem weg soll: /deletesuperlink <slId> oder manuell per Long-Press.');
    }
    const slId = sl.id;
    let tgDeleted = false; let dmsDeleted = 0; let threadCleaned = 0;
    if (sl.msg_id && GROUP_B_ID) {
        try { await bot.telegram.deleteMessage(GROUP_B_ID, Number(sl.msg_id)); tgDeleted = true; }
        catch(e) { console.log('/delete TG-Delete Fehler:', e.description||e.message); }
    }
    if (sl.dmNotifications) {
        for (const [uid, mid] of Object.entries(sl.dmNotifications)) {
            try { await bot.telegram.deleteMessage(Number(uid), Number(mid)); dmsDeleted++; } catch(e) {}
        }
    }
    for (const tid of Object.keys(d.threadMessages || {})) {
        const before = d.threadMessages[tid].length;
        d.threadMessages[tid] = d.threadMessages[tid].filter(m => m.slId !== slId && Number(m.msg_id) !== Number(sl.msg_id||0));
        const after = d.threadMessages[tid].length;
        if (after !== before) {
            threadCleaned += (before - after);
            const thr = (d.threads||[]).find(t => String(t.id) === tid);
            if (thr) { thr.last_msg = d.threadMessages[tid][0] || null; thr.msg_count = d.threadMessages[tid].length; }
        }
    }
    delete d.superlinks[slId];
    speichern();
    try { await ctx.deleteMessage(); } catch(e) {}
    try {
        const conf = await ctx.reply('✅ Superlink gelöscht\n📨 TG: ' + (tgDeleted?'✅':'⚠️') + ' · 📩 DMs: ' + dmsDeleted + ' · 📋 Threads: ' + threadCleaned);
        setTimeout(() => { ctx.telegram.deleteMessage(ctx.chat.id, conf.message_id).catch(()=>{}); }, 8000);
    } catch(e) {}
});

bot.command(['deletesuperlink','delsl','rmsl'], async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const args = (ctx.message.text||'').split(/\s+/).slice(1);
    if (!args[0]) return ctx.reply('❌ Nutzung: /deletesuperlink <slId>\n\nID-Liste: /listsuperlinks oder /fixsuperlink');
    const slId = args[0].trim();
    const sl = d.superlinks?.[slId];
    if (!sl) return ctx.reply('❌ Superlink `'+slId+'` nicht gefunden.', { parse_mode:'Markdown' });
    let tgDeleted = false; let dmsDeleted = 0; let threadCleaned = 0;
    if (sl.msg_id && GROUP_B_ID) {
        try { await bot.telegram.deleteMessage(GROUP_B_ID, Number(sl.msg_id)); tgDeleted = true; }
        catch(e) { console.log('deletesuperlink TG-Delete Fehler:', e.description||e.message); }
    }
    if (sl.dmNotifications) {
        for (const [uid, mid] of Object.entries(sl.dmNotifications)) {
            try { await bot.telegram.deleteMessage(Number(uid), Number(mid)); dmsDeleted++; } catch(e) {}
        }
    }
    for (const tid of Object.keys(d.threadMessages || {})) {
        const before = d.threadMessages[tid].length;
        d.threadMessages[tid] = d.threadMessages[tid].filter(m => m.slId !== slId && Number(m.msg_id) !== Number(sl.msg_id||0));
        const after = d.threadMessages[tid].length;
        if (after !== before) {
            threadCleaned += (before - after);
            const thr = (d.threads||[]).find(t => String(t.id) === tid);
            if (thr) { thr.last_msg = d.threadMessages[tid][0] || null; thr.msg_count = d.threadMessages[tid].length; }
        }
    }
    delete d.superlinks[slId];
    speichern();
    await ctx.reply('✅ Superlink permanent gelöscht\n\n🆔 `'+slId+'`\n📨 Telegram-Karte: ' + (tgDeleted?'✅ gelöscht':'⚠️ nicht gelöscht (siehe Log)') + '\n📩 Reminder-DMs gelöscht: ' + dmsDeleted + '\n📋 Aus Threads entfernt: ' + threadCleaned + '\n💾 Aus Datenbank: ✅', { parse_mode:'Markdown' });
});

bot.command('weekhistory', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const hist = d.weeklyHistory || [];
    if (!hist.length) return ctx.reply('📅 Noch keine Wochen-Historie gespeichert.\n\nWird ab nächstem Wochenreset gefüllt.');
    const last = hist.slice(-6).reverse();
    let text = '📅 *Wochen-Historie* (letzte ' + last.length + ')\n━━━━━━━━━━━━━━\n\n';
    for (const w of last) {
        const dt = new Date(w.endedAt).toLocaleDateString('de-DE');
        text += `📆 *KW ab ${w.weekKey}* (Ende: ${dt})\n`;
        text += `   Total: ${w.total} XP · ${Object.keys(w.snapshot).length} User · ${w.reason}\n`;
        for (let i=0; i<Math.min(3, w.top.length); i++) {
            const m = ['🥇','🥈','🥉'][i];
            text += `   ${m} ${w.top[i].name} — ${w.top[i].xp} XP\n`;
        }
        text += '\n';
    }
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('forceweeklyreset', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const archived = archiveWeeklyXP('manual');
    d.weeklyXP = {};
    d.weeklyReset = Date.now();
    speichern();
    await ctx.reply(archived ? '✅ Weekly archiviert & resettet' : '✅ Reset (nichts zu archivieren)');
});

bot.command('syncthreaddeletes', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    await ctx.reply('🔄 Prüfe ob Telegram-Nachrichten gelöscht wurden...');
    try {
        const r = await syncDeletedThreadMessages();
        await ctx.reply('✅ Sync fertig\n\n📨 Geprüft: ' + r.checked + '\n🗑️ Gelöscht: ' + r.removed + ' (waren auf Telegram nicht mehr vorhanden)');
    } catch(e) { await ctx.reply('❌ Fehler: ' + e.message); }
});

bot.command('syncsldms', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    await ctx.reply('🧹 Synchronisiere Superlink-DMs...');
    try {
        const r = await syncSuperlinkDMs();
        await ctx.reply('✅ Sync fertig\n\n📨 DMs gelöscht: ' + r.deleted + '\n❌ Fehlgeschlagen: ' + r.failed);
    } catch(e) { await ctx.reply('❌ Fehler: ' + e.message); }
});

bot.command('cleansuperlinks', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    await ctx.reply('🧹 Räume alte Superlinks auf...');
    try {
        const r = await cleanupOldSuperlinks();
        let msg = `📊 Alte Superlinks gefunden: ${r.totalOld}\n` +
                  `✅ Daten entfernt: ${r.removed}\n` +
                  `📨 Telegram gelöscht: ${r.tgDeleted}\n` +
                  `❌ Telegram fehlgeschlagen: ${r.tgFailed}`;
        if (r.tgFailed) {
            msg += '\n\n⚠️ Fehler (Bot braucht Admin + "Nachrichten löschen"-Recht):\n' +
                   (r.failures||[]).slice(0,5).map(f => '• ' + f).join('\n');
        }
        await ctx.reply(msg);
    } catch(e) { await ctx.reply('❌ Fehler: ' + e.message); }
});

bot.command('listsuperlinks', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const all = d.superlinks || {};
    const ids = Object.keys(all);
    if (!ids.length) return ctx.reply('📭 Keine Superlinks im Speicher.');
    const currentWeek = getBerlinWeekKey();
    const lines = ids.slice(0, 40).map(id => {
        const s = all[id];
        const u = d.users[s.uid];
        const name = u?.spitzname || u?.name || s.uid;
        const tag = s.week === currentWeek ? '✅' : '🗑';
        return `${tag} \`${s.week}\` | ${name} | msg ${s.msg_id || '-'}`;
    });
    await ctx.reply(`📋 Superlinks im Speicher (${ids.length}):\n\n` + lines.join('\n'), { parse_mode: 'Markdown' });
});

bot.command('superlinkdm', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    if (!d.superlinkDmSent) d.superlinkDmSent = {};
    const force = (ctx.message.text || '').includes('force');
    const userIds = Object.keys(d.users || {});
    let sent = 0, skipped = 0, failed = 0;
    await ctx.reply(`📤 Sende Superlink-DM an ${userIds.length} User${force ? ' (force-Mode)' : ''}...`);
    for (const uid of userIds) {
        const u = d.users[uid];
        if (!u || !u.started) { skipped++; continue; }
        if (!force && d.superlinkDmSent[uid]) { skipped++; continue; }
        try {
            const magicUrl = buildMagicLinkUrl(uid, '/feed?tab=engagement&opensl=1');
            await bot.telegram.sendMessage(Number(uid),
                '⭐ *Hast du schon deinen Superlink gesendet?*\n\n' +
                'Jede Woche darfst du *einen* Superlink posten (Elite+ darf 2). ' +
                'Wer postet, muss auch alle anderen Superlinks engagen (Liken, Kommentieren, Teilen, Speichern) — sonst gibt es −50 XP am Sonntag.\n\n' +
                'Klick zum Posten — du bist sofort eingeloggt:',
                { parse_mode: 'Markdown', disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: '⭐ Superlink posten', url: magicUrl }]] } }
            );
            d.superlinkDmSent[uid] = Date.now();
            sent++;
        } catch(e) { failed++; }
        await new Promise(r => setTimeout(r, 50));
    }
    speichern();
    await ctx.reply(`✅ Fertig\n\n📤 Gesendet: ${sent}\n⏭ Übersprungen: ${skipped}\n❌ Fehlgeschlagen: ${failed}`);
});

bot.command('checkengagement', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    const weekKey = getBerlinWeekKey();
    const weekSuperlinks = Object.values(d.superlinks||{}).filter(s => s.week === weekKey);
    if (!weekSuperlinks.length) return ctx.reply('📊 Keine Superlinks diese Woche.');
    const posters = [...new Set(weekSuperlinks.map(s => s.uid))];
    let report = `📊 *Full Engagement Woche ${weekKey}*\n${weekSuperlinks.length} Superlinks von ${posters.length} Usern\n\n`;
    for (const uid of posters) {
        const u = d.users[uid];
        const name = u?.spitzname||u?.name||uid;
        const fam = new Set(familyUids(uid));
        const otherLinks = weekSuperlinks.filter(s => !fam.has(String(s.uid)));
        const likedCount = otherLinks.filter(s => {
            if (!Array.isArray(s.likes)) return false;
            for (const f of fam) if (s.likes.includes(f)) return true;
            return false;
        }).length;
        const status = likedCount >= otherLinks.length ? '✅' : `⚠️ ${likedCount}/${otherLinks.length}`;
        report += `${status} ${name}\n`;
    }
    await ctx.reply(report, { parse_mode: 'Markdown' });
});

bot.command('runengagementcheck', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    await ctx.reply('⏳ Führe Engagement-Check durch...');
    const result = await runEngagementCheck(false);
    await ctx.reply(`✅ Check abgeschlossen: ${result.checked} geprüft, ${result.warned} verwarnt`);
});

bot.command('superlinkreminder', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    await ctx.reply('⏳ Sende Reminder an alle Poster mit offenen Superlinks...');
    const result = await superlinkDailyReminder();
    await ctx.reply(`✅ ${result.sent} Reminder-DMs gesendet`);
});

bot.command('setgender', async (ctx) => {
    const u = user(ctx.from.id, ctx.from.first_name);
    const arg = (ctx.message?.text||'').split(/\s+/)[1]?.toLowerCase().trim();
    if (!arg || !['m','w','d','unset','reset','auto'].includes(arg)) {
        const current = u.gender ? (u.gender === 'm' ? 'männlich' : u.gender === 'w' ? 'weiblich' : 'divers') : 'nicht gesetzt (Auto-Detect aktiv)';
        return ctx.reply(
            '👤 *Geschlecht festlegen*\n\n' +
            'Aktuell: *' + current + '*\n\n' +
            'Setzen mit:\n' +
            '• `/setgender m` — männlich\n' +
            '• `/setgender w` — weiblich\n' +
            '• `/setgender d` — divers / neutrale Sprache\n' +
            '• `/setgender unset` — zurück auf Auto-Detect',
            { parse_mode: 'Markdown' });
    }
    if (arg === 'unset' || arg === 'reset' || arg === 'auto') {
        u.gender = null;
        speichern();
        return ctx.reply('🔄 Geschlecht zurückgesetzt — Auto-Detect ist wieder aktiv.');
    }
    u.gender = arg;
    speichern();
    const label = arg === 'm' ? 'männlich' : arg === 'w' ? 'weiblich' : 'divers';
    return ctx.reply('✅ Geschlecht gesetzt auf *' + label + '*.', { parse_mode: 'Markdown' });
});

bot.command('setemail', async (ctx) => {
    const u = user(ctx.from.id, ctx.from.first_name);
    const arg = (ctx.message?.text||'').split(/\s+/).slice(1).join(' ').toLowerCase().trim();
    if (!arg || arg === 'show' || arg === 'status') {
        const current = u.email ? '`' + u.email + '`' : '_nicht gesetzt_';
        return ctx.reply(
            '📧 *Email-Login*\n\n' +
            'Aktuell: ' + current + '\n\n' +
            'Wenn du eine Email setzt, kannst du dich auch ohne Telegram-Code in der App einloggen — wir schicken dir einen Magic-Link an die Email.\n\n' +
            'Setzen mit:\n' +
            '• `/setemail deine@email.de`\n' +
            '• `/setemail unset` — Email entfernen',
            { parse_mode: 'Markdown' });
    }
    if (arg === 'unset' || arg === 'reset' || arg === 'remove' || arg === 'delete') {
        delete u.email;
        speichern();
        return ctx.reply('🗑️ Email entfernt. Email-Login ist deaktiviert.');
    }
    // Email-Format prüfen.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(arg) || arg.length > 200) {
        return ctx.reply('❌ Das sieht nicht nach einer gültigen Email aus.\n\nBeispiel: `/setemail max@gmail.com`', { parse_mode: 'Markdown' });
    }
    // Schon vergeben? Email muss eindeutig sein, sonst weiß der App-Server nicht zu wem sie gehört.
    const taken = Object.entries(d.users || {}).find(([uid, x]) => String(uid) !== String(ctx.from.id) && String(x.email||'').toLowerCase() === arg);
    if (taken) {
        return ctx.reply('⚠️ Diese Email ist bereits bei einem anderen Account hinterlegt. Bitte nutze eine andere.');
    }
    u.email = arg;
    speichern();
    return ctx.reply(
        '✅ Email gesetzt auf `' + arg + '`.\n\n' +
        '👉 Du kannst dich jetzt unter *App → Login → Email* mit dieser Adresse einloggen. Wir schicken dir dann einen einmaligen Magic-Link per Mail.',
        { parse_mode: 'Markdown' });
});

bot.command('appreminder', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    await ctx.reply('⏳ Sende App-Reminder an alle User die die App noch nie geöffnet haben...');
    const result = await appReminderForNonUsers();
    await ctx.reply(`✅ ${result.sent} Reminder gesendet, ${result.skipped} skipped (bereits aktiv oder Cooldown)`);
});

// /findmysub — sucht in allen Backup-Dateien nach Subs des aufrufenden Admins.
// Zeigt für jedes Datum: ob ein Sub mit parent_uid = ctx.from.id existierte.
bot.command('findmysub', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    const myUid = String(ctx.from.id);
    try {
        const dir = require('path').dirname(DATA_FILE);
        const base = require('path').basename(DATA_FILE).replace('.json', '');
        const files = fs.readdirSync(dir).filter(f => f.startsWith(base + '_backup_') && f.endsWith('.json')).sort().reverse();
        if (!files.length) return ctx.reply('❌ Keine Backups gefunden.');
        const found = [];
        for (const f of files) {
            try {
                const data = JSON.parse(fs.readFileSync(require('path').join(dir, f), 'utf8'));
                const subs = Object.entries(data.users || {}).filter(([, u]) => u && String(u.parent_uid||'') === myUid);
                if (subs.length) {
                    const dateStr = f.replace(base + '_backup_', '').replace('.json', '');
                    for (const [sUid, sU] of subs) {
                        found.push({ date: dateStr, sub_uid: sUid, name: sU.spitzname || sU.name || '?', xp: sU.xp || 0 });
                    }
                }
            } catch(e) {}
        }
        if (!found.length) return ctx.reply('❌ Kein Sub-Account von dir in den Backups gefunden. Vielleicht hattest du nie einen, oder die Backups sind älter als der Zeitpunkt des Erstellens.');
        const aktuellHat = !!Object.entries(d.users || {}).find(([, u]) => u && String(u.parent_uid||'') === myUid);
        let msg = '🔍 *Deine Sub-Accounts in Backups:*\n\n';
        // Gruppieren nach sub_uid
        const groups = {};
        for (const f of found) {
            if (!groups[f.sub_uid]) groups[f.sub_uid] = { name: f.name, xp: f.xp, dates: [] };
            groups[f.sub_uid].dates.push(f.date);
        }
        for (const [suid, g] of Object.entries(groups)) {
            msg += `• *${g.name}* (\`${suid}\`, ${g.xp} XP)\n  Backups: ${g.dates.slice(0, 6).join(', ')}${g.dates.length > 6 ? ' …' : ''}\n\n`;
        }
        msg += aktuellHat ? '\n✅ Du hast aktuell schon einen Sub in den Live-Daten.' : '\n⚠️ Aktuell kein Sub in Live-Daten.\n\nWiederherstellen mit:\n`/restoresubs ' + found[0].date + '`';
        return ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch(e) { return ctx.reply('❌ Fehler: ' + e.message); }
});

// /relinksubs [dry] — Repariert kaputte Parent→Sub-Backlinks.
// Hintergrund: Sub-Accounts haben d.users[sub].parent_uid gesetzt, aber
// d.users[parent].subUid kann durch Bug verloren gegangen sein. Switcher
// rendert dann leer obwohl die Subs in d.users weiter existieren.
bot.command('relinksubs', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    const args = (ctx.message?.text||'').split(/\s+/).slice(1);
    const dry = args.some(a => a.toLowerCase() === 'dry' || a.toLowerCase() === 'trocken');
    const fixed = [], alreadyOk = [], conflicts = [], orphaned = [];
    for (const [uid, u] of Object.entries(d.users || {})) {
        if (!u || !u.parent_uid) continue;
        const parentUid = String(u.parent_uid);
        const parent = d.users[parentUid];
        if (!parent) {
            orphaned.push({ sub: uid, parent: parentUid, name: u.spitzname || u.name || '?' });
            continue;
        }
        if (parent.subUid && String(parent.subUid) === String(uid)) {
            alreadyOk.push({ sub: uid, parent: parentUid });
            continue;
        }
        if (parent.subUid && String(parent.subUid) !== String(uid)) {
            // Parent hat bereits einen anderen Sub-Pointer → potentielles Problem.
            // Wir überschreiben NICHT automatisch; user muss manuell prüfen.
            conflicts.push({ sub: uid, parent: parentUid, parentSubUid: parent.subUid, name: u.spitzname || u.name || '?' });
            continue;
        }
        // parent.subUid fehlt → setzen.
        if (!dry) parent.subUid = String(uid);
        fixed.push({ sub: uid, parent: parentUid, name: u.spitzname || u.name || '?', xp: u.xp || 0 });
    }
    if (!dry && fixed.length) speichern();
    const head = dry ? '🧪 *Dry-Run* — nichts gespeichert' : '✅ *Relink ausgeführt*';
    let msg = head + '\n\n';
    msg += `🔗 Repariert: *${fixed.length}*\n👌 Bereits OK: *${alreadyOk.length}*\n⚠️ Konflikt: *${conflicts.length}*\n❓ Verwaist: *${orphaned.length}*`;
    if (fixed.length) {
        msg += '\n\n*Repariert (Parent → Sub):*\n' + fixed.slice(0, 15).map(f => '• ' + f.name + ' → Parent `' + f.parent + '` (' + f.xp + ' XP)').join('\n');
        if (fixed.length > 15) msg += '\n• … +' + (fixed.length - 15) + ' weitere';
    }
    if (conflicts.length) {
        msg += '\n\n*Konflikte (Parent zeigt auf anderen Sub):*\n' + conflicts.slice(0, 5).map(c => '• ' + c.name + ' (Parent zeigt auf `' + c.parentSubUid + '` statt `' + c.sub + '`)').join('\n');
    }
    if (orphaned.length) {
        msg += '\n\n*Verwaist (Parent fehlt komplett):*\n' + orphaned.slice(0, 5).map(o => '• ' + o.name + ' → Parent `' + o.parent + '` nicht in d.users').join('\n');
    }
    return ctx.reply(msg, { parse_mode: 'Markdown' });
});

// /restoresubs [YYYY-MM-DD] [dry] — Sub-Accounts aus einem Backup wiederherstellen.
// Default: heutiges Datum. 'dry' an zweiter Stelle = Trockenlauf ohne Speichern.
bot.command('restoresubs', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    const args = (ctx.message?.text||'').split(/\s+/).slice(1);
    const today = new Date().toISOString().slice(0, 10);
    let date = today, dry = false;
    for (const a of args) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(a)) date = a;
        else if (a.toLowerCase() === 'dry' || a.toLowerCase() === 'trocken') dry = true;
    }
    const backupFile = DATA_FILE.replace('.json', '_backup_' + date + '.json');
    if (!fs.existsSync(backupFile)) {
        // Liste verfügbare Backups zeigen falls Datum daneben liegt.
        try {
            const dir = require('path').dirname(DATA_FILE);
            const base = require('path').basename(DATA_FILE).replace('.json', '');
            const files = fs.readdirSync(dir).filter(f => f.startsWith(base + '_backup_') && f.endsWith('.json')).sort().reverse().slice(0, 7);
            return ctx.reply('❌ Backup nicht gefunden für `' + date + '`.\n\nVerfügbar:\n' + (files.length ? files.map(f => '• `'+f.replace(base+'_backup_','').replace('.json','')+'`').join('\n') : '_keine_'), { parse_mode: 'Markdown' });
        } catch { return ctx.reply('❌ Backup nicht gefunden: ' + backupFile); }
    }
    try {
        const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
        const restored = [], skipped = [], orphaned = [];
        for (const [uid, u] of Object.entries(backup.users || {})) {
            if (!u || !u.parent_uid) continue;
            if (d.users[uid]) { skipped.push(uid); continue; }
            const parentUid = String(u.parent_uid);
            if (!d.users[parentUid]) { orphaned.push({uid, parentUid}); continue; }
            if (!dry) {
                d.users[uid] = u;
                d.users[parentUid].subUid = uid;
            }
            restored.push({ uid, parent: parentUid, name: u.spitzname || u.name || '?', xp: u.xp || 0 });
        }
        if (!dry && restored.length) speichern();
        const head = dry ? '🧪 *Dry-Run* — nichts gespeichert' : '✅ *Restore ausgeführt*';
        let msg = head + '\n\nQuelle: `' + backupFile.split('/').pop() + '`\n\n';
        msg += `🔄 Wiederhergestellt: *${restored.length}*\n⏭️ Schon vorhanden (skip): *${skipped.length}*\n⚠️ Verwaist (parent fehlt): *${orphaned.length}*`;
        if (restored.length) {
            msg += '\n\n*Wiederhergestellt:*\n' + restored.slice(0, 15).map(r => '• ' + r.name + ' (Parent ' + r.parent + ', ' + r.xp + ' XP)').join('\n');
            if (restored.length > 15) msg += '\n• … +' + (restored.length - 15) + ' weitere';
        }
        if (orphaned.length) {
            msg += '\n\n*Verwaist (Parent fehlt):*\n' + orphaned.slice(0, 5).map(o => '• `'+o.uid+'`').join('\n');
        }
        return ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch(e) {
        return ctx.reply('❌ Fehler: ' + e.message);
    }
});

bot.command('feedbatch', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    await ctx.reply('⏳ Sende Feed-Batch DM an alle gestarteten Bot-User...');
    const result = await feedBatchDM();
    await ctx.reply(`✅ ${result.links} neue Links → ${result.sent} DMs gesendet`);
});

bot.command('refreshthumbs', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    await ctx.reply('⏳ Refresh Instagram-Thumbnails (kann ein bisschen dauern)...');
    const result = await refreshThumbnails();
    await ctx.reply(`✅ ${result.refreshed}/${result.attempts} Thumbnails neu geladen`);
});

bot.command('dmappreminder', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    user(ctx.from.id, ctx.from.first_name);
    const { text, opts } = buildAppReminderMessage(ctx.from.id);
    try { await bot.telegram.sendMessage(ctx.from.id, text, opts); } catch(e) {}
    await ctx.reply('✅ App-Reminder Vorschau hier in deinem Telegram-Chat (siehe oben).');
});

bot.command('dmpreview', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    const uid = String(ctx.from.id);
    const appUrl = (APP_URL || 'https://web-production-7981d.up.railway.app').replace(/\/$/,'');
    const rulesUrl = appUrl + '/explore?tab=regeln#r-superlinks';
    const engageUrl = appUrl + '/feed?tab=engagement';
    const previews = [
        {
            label: '1️⃣ App-Post Bestätigung',
            text: '⭐ Dein Superlink wurde gepostet!\n\nDu hast heute einen Superlink gepostet — vergiss nicht: Du musst alle Superlinks dieser Woche engagieren (Liken, Kommentieren, Teilen, Speichern) bis Sonntag 23:59 Uhr.',
            link: { url: rulesUrl, label: '📖 Superlink-Regeln' }
        },
        {
            label: '2️⃣ Daily Reminder (Mo–Sa 20:00)',
            text: '⭐ Superlink-Erinnerung\n\nDu hast noch 3 offene Superlinks dieser Woche.\n\n⚠️ Liken, Kommentieren, Teilen & Speichern ist Pflicht — sonst Sonntag 23:59 Uhr −50 XP.',
            link: { url: engageUrl, label: '📲 Jetzt engagen' }
        },
        {
            label: '3️⃣ Sonntag 21:00 Reminder',
            text: '⚠️ Erinnerung: Full Engagement\n\nDu hast diese Woche noch nicht alle Superlinks geliked! Vergiss nicht: Liken, Kommentieren, Teilen und Speichern. Sonst gibt es um 23:59 Uhr −50 XP.',
            link: { url: engageUrl, label: '📲 Jetzt engagen' }
        },
        {
            label: '4️⃣ Sonntag 23:59 Pflicht-Verletzt',
            text: '⚠️ Full Engagement Pflicht verletzt!\n\nDu hast diese Woche nicht alle Superlinks geliked.\n\n📉 −50 XP\n⚠️ Verwarnung #1 (insgesamt)',
            link: { url: engageUrl, label: '📲 In der App ansehen' }
        }
    ];
    for (const p of previews) {
        const intro = `[VORSCHAU ${p.label}]\n\n`;
        sendCreatorBoostDM(uid, intro + p.text, p.link ? { link: p.link } : undefined);
    }
    await ctx.reply(`✅ ${previews.length} DM-Previews als CreatorBoost-Chat in der App. Öffne die App → Nachrichten → CreatorBoost.`);
});

bot.command('fethread', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    if (!GROUP_B_ID) return ctx.reply('❌ GROUP_B_ID nicht gesetzt!');
    const oldId = d.fullEngagementThreadId;
    await ctx.reply(`ℹ️ Alter Thread-ID: ${oldId || 'nicht gesetzt'}\n⏳ Erstelle neuen Thread...`);
    d.fullEngagementThreadId = null;
    const threadId = await ensureFullEngagementThread();
    if (!threadId) return ctx.reply('❌ Thread-Erstellung fehlgeschlagen. Prüfe ob Gruppe B Forum-Modus aktiviert hat und Bot Admin ist.');
    try {
        await bot.telegram.sendMessage(GROUP_B_ID,
            '⭐ *Full Engagement Thread geöffnet!*\n\n' +
            'Hier könnt ihr eure Superlinks posten.\n\n' +
            '📌 *Regeln:*\n• 1–2 Superlinks pro Person pro Woche (Mo–Sa)\n• Wer postet, muss ALLE anderen liken, kommentieren, teilen & speichern\n• Verstoß: -50 XP\n\n' +
            '📲 Einfach euren Instagram-Link hier reinposten oder /superlink im Bot nutzen!',
            { parse_mode: 'Markdown', message_thread_id: Number(threadId) }
        );
    } catch(e) { await ctx.reply('⚠️ Thread erstellt aber Willkommensnachricht fehlgeschlagen: ' + e.message); }
    await ctx.reply(`✅ Full Engagement Thread erstellt! ID: ${threadId}`);
});

bot.command('fixsuperlink', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    const args = ctx.message.text.split(' ').slice(1);
    if (!args[0]) {
        // List this week's superlinks with their IDs
        const week = getBerlinWeekKey();
        const sls = Object.values(d.superlinks||{}).filter(s => s.week === week).sort((a,b) => b.timestamp-a.timestamp);
        if (!sls.length) return ctx.reply('❌ Keine Superlinks diese Woche.');
        const list = sls.map(s => {
            const u = d.users[s.uid];
            return `• ${u?.spitzname||u?.name||'User'}\n  ID: \`${s.id}\`\n  URL: ${s.url||'⚠️ leer'}`;
        }).join('\n\n');
        return ctx.reply('⭐ *Superlinks diese Woche:*\n\n' + list + '\n\n📌 Nutze `/fixsuperlink <ID>` um einen neu zu posten.', { parse_mode: 'Markdown' });
    }
    const slId = args[0].trim();
    const sl = d.superlinks?.[slId];
    if (!sl) return ctx.reply('❌ Superlink nicht gefunden: ' + slId);
    const u = d.users[sl.uid];
    // Try to delete old message
    if (sl.msg_id) {
        try { await bot.telegram.deleteMessage(GROUP_B_ID, sl.msg_id); } catch(e) {}
    }
    let feThreadId;
    try { feThreadId = await ensureFullEngagementThread(); } catch(e) {}
    if (!feThreadId) return ctx.reply('❌ Full Engagement Thread nicht verfügbar.');
    const cardText = buildSuperLinkKarte(u?.spitzname||u?.name||'User', u?.instagram, sl.url, sl.caption, sl.likes.length, sl.likerNames||{});
    try {
        const sent = await bot.telegram.sendMessage(GROUP_B_ID, cardText, {
            parse_mode: 'HTML',
            message_thread_id: Number(feThreadId),
            reply_markup: buildSuperLinkButtons(slId, sl.likes.length)
        });
        sl.msg_id = sent.message_id;
        speichern();
        await ctx.reply('✅ Superlink neu gepostet! msg_id: ' + sent.message_id);
    } catch(e) { await ctx.reply('❌ Fehler: ' + e.message); }
});

bot.command('superlink', async (ctx) => {
    // Superlinks werden nicht mehr über Telegram gepostet/verwaltet — alles in der App.
    await ctx.reply(
        '⭐ *Full Engagement — Superlinks*\n\n' +
        'Superlinks werden jetzt direkt über die App gepostet und verwaltet.\n\n' +
        '📲 Öffne die App → Feed → ⭐ Superlink posten\n\n' +
        'Dort siehst du auch deinen Engagement-Status und kannst andere Superlinks liken.',
        { parse_mode: 'Markdown' }
    );
});

bot.command('restoredata', async (ctx) => {
    restoreWaiting.add(ctx.from.id);
    await ctx.reply('📂 Schicke mir jetzt die daten.json Datei als Dokument in diesen Chat.');
});

bot.action(/^slreport_(.+)$/, async (ctx) => {
    const parts = ctx.match[1].split('_');
    const slId = parts[0];
    const likerUid = parts[1];
    const sl = d.superlinks?.[slId];
    if (!sl) return ctx.answerCbQuery('❌ Nicht gefunden');
    const likerUser = d.users[likerUid];
    const likerName = likerUser?.spitzname||likerUser?.name||'User';
    meldenWarte.set(ctx.from.id, { step: 'nachricht', gemeldeterUid: likerUid, gemeldeterName: likerName, context: 'superlink', slId });
    await ctx.answerCbQuery('✅ Meldung geöffnet');
    await bot.telegram.sendMessage(ctx.from.id, `🚨 Melde ${likerName} wegen mangelndem Engagement.\n\nSchreibe jetzt die Details (oder einfach "Kein Engagement"):`, {});
});

async function topLinks(chatId) {
    const sorted = Object.values(d.links).sort((a, b) => b.likes.size - a.likes.size).slice(0, 3);
    if (!sorted.length) return;
    const b = ['🥇', '🥈', '🥉'];
    let text = '🔥 *Top Links*\n━━━━━━━━━━━━━━\n\n';
    sorted.forEach((l, i) => { text += b[i] + ' *' + l.user_name + '*  ·  ' + l.likes.size + ' 👍\n'; });
    try { await bot.telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' }); } catch (e) {}
}

async function sendeDM(uid, text, options = {}) {
    for (let i = 0; i < 3; i++) {
        try { return await bot.telegram.sendMessage(Number(uid), text, options); }
        catch (e) { if (i < 2) await new Promise(r => setTimeout(r, 1000)); }
    }
    return null;
}

async function sendeLinkAnAlle(linkData) {
    if (!d.dmNachrichten) d.dmNachrichten = {};
    const msgKey = String(linkData.counter_msg_id);
    if (!d.dmNachrichten[msgKey]) d.dmNachrichten[msgKey] = {};
    const empfaenger = Object.entries(d.users).filter(([uid, u]) => parseInt(uid) !== linkData.user_id && u.started);
    const linkUrl2 = 'https://t.me/c/' + String(linkData.chat_id).replace('-100', '') + '/' + linkData.counter_msg_id;
    for (let i = 0; i < empfaenger.length; i += 10) {
        const batch = empfaenger.slice(i, i + 10);
        const results = await Promise.allSettled(
            batch.map(([uid]) => sendeDM(uid, '📢 Neuer Link!\n\n👤 ' + linkData.user_name + '\n🔗 ' + linkData.text + '\n\n━━━━━━━━━━━━━━\n👍 Bitte liken!',
                { reply_markup: { inline_keyboard: [[{ text: '👉 Zum Beitrag', url: linkUrl2 }]] } }
            ))
        );
        results.forEach((result, idx) => {
            if (result.status === 'fulfilled' && result.value) d.dmNachrichten[msgKey][batch[idx][0]] = result.value.message_id;
        });
        if (i + 10 < empfaenger.length) await new Promise(r => setTimeout(r, 1000));
    }
    speichern();
}

async function aktivitätsScore(uid) {
    const logins = d.dailyLogins[uid] || 0;
    const groupMsgs = d.dailyGroupMsgs[uid] || 0;
    const m = d.missionen[uid];
    const heute = new Date().toDateString();
    const likesGegeben = (m?.date === heute ? m.likesGegeben || 0 : 0);
    const missionen = (m?.date === heute ? (m.m1 ? 1 : 0) + (m.m2 ? 1 : 0) + (m.m3 ? 1 : 0) : 0);
    return logins * 3 + groupMsgs * 2 + likesGegeben + missionen;
}

async function dailyRankingAbschluss() {
    const sorted = Object.entries(d.dailyXP).filter(([uid]) => d.users[uid] && d.dailyXP[uid] > 0 && !istAdminId(uid)).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return;
    // Tiebreaker: sort by activity score within same XP groups
    const withScore = await Promise.all(sorted.map(async ([uid, xp]) => ({ uid, xp, score: await aktivitätsScore(uid) })));
    withScore.sort((a, b) => b.xp !== a.xp ? b.xp - a.xp : b.score !== a.score ? b.score - a.score : Math.random() - 0.5);
    // Send tie notifications
    let i = 0;
    while (i < withScore.length) {
        const xp = withScore[i].xp;
        let j = i + 1;
        while (j < withScore.length && withScore[j].xp === xp) j++;
        if (j > i + 1) {
            const tiedGroup = withScore.slice(i, j);
            for (let k = 0; k < tiedGroup.length; k++) {
                const { uid } = tiedGroup[k];
                const myRank = i + k + 1;
                const otherNames = tiedGroup.filter((_, idx) => idx !== k).map(e => d.users[e.uid]?.spitzname || d.users[e.uid]?.name || 'User');
                const othersStr = otherNames.length === 1 ? otherNames[0] : otherNames.slice(0,-1).join(', ') + ' und ' + otherNames[otherNames.length-1];
                const rankRange = `Platz ${i+1}–${j}`;
                const msg = myRank <= 3
                    ? `🎲 *Gleichstand & Verlosung!*

Du und ${othersStr} hattet alle *${xp} XP* und wärt auf ${rankRange} gleichauf.

Eine automatische Verlosung nach Aktivität hat stattgefunden — du hast gewonnen! 🎉

🏆 *Dein aktueller Rang: Platz ${myRank}*
Top ${myRank} Bonus folgt!`
                    : `🎲 *Gleichstand & Verlosung!*

Du und ${othersStr} hattet alle *${xp} XP* und wärt auf ${rankRange} gleichauf.

Eine automatische Verlosung nach Aktivität hat stattgefunden — diesmal war ${tiedGroup[0] && tiedGroup[0].uid !== uid ? (d.users[tiedGroup[0].uid]?.spitzname || d.users[tiedGroup[0].uid]?.name || 'ein anderer User') : othersStr} vorne.

📊 *Dein aktueller Rang: Platz ${myRank}*
Mehr Aktivität morgen für einen besseren Platz! 💪`;
                try { await bot.telegram.sendMessage(Number(uid), msg, { parse_mode: 'Markdown' }); await new Promise(r => setTimeout(r, 200)); } catch (e) {}
            }
        }
        i = j;
    }
    const bel = [{ xp: 10, links: 1, text: '🥇' }, { xp: 5, links: 0, text: '🥈' }, { xp: 2, links: 0, text: '🥉' }];
    for (let i = 0; i < Math.min(3, withScore.length); i++) {
        const { uid } = withScore[i];
        const u = d.users[uid];
        const b = bel[i];
        xpAdd(uid, b.xp, u.name);
        if (b.links > 0) { if (!d.bonusLinks[uid]) d.bonusLinks[uid] = 0; d.bonusLinks[uid] += b.links; }
        try { await bot.telegram.sendMessage(Number(uid), `🎉 *${b.text} im Tagesranking!*\n\n+${b.xp} XP erhalten!` + (b.links > 0 ? '\n🔗 Extra Link für morgen!' : '') + '\n\n━━━━━━━━━━━━━━\n⭐ ' + d.users[uid].xp + ' XP Gesamt', { parse_mode: 'Markdown' }); } catch (e) {}
    }
    d.gesternDailyXP = Object.assign({}, d.dailyXP);
    d.dailyXP = {}; d.tracker = {}; d.counter = {}; d.badgeTracker = {};
    d.dailyLogins = {}; d.dailyGroupMsgs = {};
    d.dailyReset = Date.now();
    speichern();
}

async function likeErinnerung() {
    const heute = new Date().toDateString();
    const heutigeLinks = Object.entries(d.links).filter(([, l]) =>
        new Date(l.timestamp).toDateString() === heute
    );
    if (!heutigeLinks.length) return;

    let gesendet = 0;
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started || istAdminId(uid)) continue;

        const nichtGeliked = heutigeLinks.filter(([, l]) =>
            String(getRootUid(l.user_id)) !== String(getRootUid(uid)) && !l.likes.has(String(uid))
        );
        if (!nichtGeliked.length) continue;

        let text = '👋 *Hey ' + u.name + '!*\n\n━━━━━━━━━━━━━━\n⬜ Noch nicht geliked:\n\n';
        for (const [, l] of nichtGeliked) {
            const insta = l.user_id ? (d.users[String(l.user_id)]?.instagram ? ' · 📸 @' + d.users[String(l.user_id)].instagram : '') : '';
            text += '👤 ' + l.user_name + insta + '\n';
        }
        text += '\n━━━━━━━━━━━━━━\n⏳ Missionen schließen um 12:00 Uhr!';

        // App-only Flow: t.me/c/.../{counter_msg_id} würde bei synthetischen App-IDs 404'en.
        // Stattdessen ein Magic-Link zum App-Feed wo der User alles engagen kann.
        const magicUrl = buildMagicLinkUrl(uid, '/feed?tab=heute');
        const buttons = [[{ text: '📲 Im Heute-Feed engagen', url: magicUrl }]];

        try {
            await bot.telegram.sendMessage(Number(uid), text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: buttons }
            });
            gesendet++;
            await new Promise(r => setTimeout(r, 200));
        } catch (e) {}
    }
    console.log('✅ Like Erinnerung gesendet an ' + gesendet + ' User');
}


async function abendM1Warnung() {
    const heute = new Date().toDateString();
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started || istAdminId(uid)) continue;
        const hatLinkHeute = Object.values(d.links).some(l => String(l.user_id) === String(uid) && new Date(l.timestamp).toDateString() === heute);
        if (!hatLinkHeute) continue;
        const fremde = Object.values(d.links).filter(l => istInstagramLink(l.text) && String(getRootUid(l.user_id)) !== String(getRootUid(uid)) && new Date(l.timestamp).toDateString() === heute);
        if (fremde.length < 5) continue;
        const m = d.missionen[uid];
        if (m?.date === heute && m.m1) continue;
        const likes = m ? m.likesGegeben : 0;
        try { await bot.telegram.sendMessage(Number(uid), '⚠️ *Erinnerung!*\nNur ' + likes + '/5 Likes vergeben.\nNoch ' + (5 - likes) + ' liken — sonst Verwarnung!', { parse_mode: 'Markdown' }); } catch (e) {}
    }
}

// Smart-Reminders: berechnet pro User die typische Peak-Stunde aus Link/Like-Timestamps
// und schickt eine Push-DM ~30 Min vor seiner Peak-Zeit, falls er heute noch nicht aktiv war.
function _userPeakHour(uid) {
    const counts = Array(24).fill(0);
    for (const l of Object.values(d.links||{})) {
        if (!l.timestamp) continue;
        const dt = new Date(l.timestamp);
        if (String(l.user_id) === String(uid)) counts[dt.getHours()]++;
        const likes = Array.isArray(l.likes) ? l.likes : [];
        if (likes.map(String).includes(String(uid))) counts[dt.getHours()]++;
    }
    const max = Math.max(...counts);
    if (max < 3) return null; // zu wenig Daten für sinnvollen Peak
    return counts.indexOf(max);
}
async function smartReminderCheck() {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMin = now.getMinutes();
    if (currentMin < 25 || currentMin > 35) return; // läuft :30 herum
    const heuteStr = now.toDateString();
    if (!d._smartReminderSent) d._smartReminderSent = {};
    let sent = 0;
    for (const [uid, u] of Object.entries(d.users||{})) {
        if (!u || !u.started || istAdminId(uid) || u.inGruppe === false) continue;
        const peakHour = _userPeakHour(uid);
        if (peakHour === null) continue;
        // 30 min vor Peak — also wenn aktuelle Stunde+1 == peakHour
        if ((currentHour + 1) % 24 !== peakHour) continue;
        if (d._smartReminderSent[uid] === heuteStr) continue;
        // Nur senden wenn er heute noch keine Aktivität hatte
        const heuteAktiv = Object.values(d.links||{}).some(l => {
            if (!l.timestamp || new Date(l.timestamp).toDateString() !== heuteStr) return false;
            if (String(l.user_id) === String(uid)) return true;
            return (Array.isArray(l.likes) ? l.likes : []).map(String).includes(String(uid));
        });
        if (heuteAktiv) continue;
        const text = '⏰ *Deine Peak-Zeit*\n\nHey '+(u.spitzname||u.name||'')+', deine aktive Stunde ist gleich ('+peakHour.toString().padStart(2,'0')+':00). Heute noch nichts geliked oder gepostet — schau kurz vorbei!';
        try { await bot.telegram.sendMessage(Number(uid), text, { parse_mode: 'Markdown' }); } catch(e) {}
        sendAppPush(uid, '⏰ Deine Peak-Zeit', 'Deine aktive Stunde ist gleich — schau vorbei!', '/feed').catch(()=>{});
        d._smartReminderSent[uid] = heuteStr;
        sent++;
        await new Promise(r => setTimeout(r, 80));
    }
    if (sent) { speichern(); console.log('⏰ Smart-Reminder: ' + sent + ' DMs gesendet'); }
}

async function welcomeFunnelCheck() {
    if (!d.users) return;
    const now = Date.now();
    const stages = [
        { day: 1, key: 'wf1', text: '👋 *Hi {name}!*\n\nDu bist jetzt 1 Tag dabei. Schon alles eingerichtet?\n\n✅ Bot gestartet — perfekt!\n📸 Instagram noch nicht verbunden? → /setinsta\n📋 Profil komplett? → /profil\n\nFragen? Antworte einfach hier oder schau /help.' },
        { day: 3, key: 'wf3', text: '🚀 *3 Tage in der Community, {name}!*\n\nWie läufts?\n\n🔗 Schon deinen ersten Link gepostet? Du bekommst XP und Likes von allen!\n🎯 Schau dir die Missionen an: /missionen\n⭐ Highlight: 1× pro Woche darfst du einen *Superlink* posten den jeder engagen muss → /superlink' },
        { day: 7, key: 'wf7', text: '🎉 *1 Woche dabei, {name}!*\n\nKlasse dass du am Ball bleibst! Hier dein Status:\n\n⭐ {xp} XP gesammelt\n🏅 Badge: {role}\n\n💎 Diamanten verdienen geht über Missionen. Damit kannst du im Shop (/shop) Extra-Links und Superlinks kaufen!\n\n🤝 Wenn du Fragen hast oder etwas brauchst — schreib einfach hier.' },
    ];
    let sent = 0;
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u || !u.joinDate || !u.started || istAdminId(uid) || u.inGruppe === false) continue;
        if (!u.welcomeFunnel) u.welcomeFunnel = {};
        const daysSince = Math.floor((now - u.joinDate) / 86400000);
        for (const s of stages) {
            if (daysSince >= s.day && !u.welcomeFunnel[s.key]) {
                const txt = s.text.replace(/\{name\}/g, u.spitzname||u.name||'').replace(/\{xp\}/g, String(u.xp||0)).replace(/\{role\}/g, u.role||'🆕 New');
                try {
                    await bot.telegram.sendMessage(Number(uid), txt, { parse_mode: 'Markdown' });
                    u.welcomeFunnel[s.key] = now;
                    sent++;
                    await new Promise(r => setTimeout(r, 80));
                } catch(e) {}
                break; // pro User max eine Stufe pro Lauf
            }
        }
    }
    if (sent) { speichern(); console.log('👋 Welcome-Funnel: ' + sent + ' DMs gesendet'); }
}

async function bonusLinkErinnerung() {
    const entries = Object.entries(d.bonusLinks||{}).filter(([uid,c]) => c > 0 && d.users[uid]?.started && d.users[uid]?.inGruppe !== false && !istAdminId(uid));
    let sent = 0;
    for (const [uid, count] of entries) {
        try {
            await bot.telegram.sendMessage(Number(uid),
                '🎁 *Bonus Links Erinnerung*\n\n' +
                'Du hast noch *' + count + ' Bonus Link' + (count===1?'':'s') + '* übrig!\n\n' +
                'Damit darfst du heute *' + count + ' zusätzliche' + (count===1?'n':'') + ' Link' + (count===1?'':'s') + '* posten — über das Tageslimit hinaus.\n\n' +
                '📲 Einfach wie gewohnt einen Instagram-Link in die Gruppe schicken, der Bonus wird automatisch verwendet.\n\n' +
                'ℹ️ Status jederzeit per /bonuslinks',
                { parse_mode: 'Markdown' }
            );
            sent++;
            await new Promise(r => setTimeout(r, 50));
        } catch(e) {}
    }
    if (sent > 0) console.log('🎁 Bonus-Links Erinnerung an ' + sent + ' User gesendet');
    return sent;
}


async function gruppenMitgliederPruefen() {
    console.log('🔍 Prüfe Gruppenmitglieder...');
    let aktiv = 0, geloescht = 0;
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started || istAdminId(uid)) continue;
        // Sub-Accounts haben keine Telegram-Identität → wären immer 'left/kicked'
        // und würden gelöscht. Plus wasted Telegram-API-Call pro Sub pro Tag.
        if (u.parent_uid) continue;
        try {
            const member = await bot.telegram.getChatMember(GROUP_A_ID, Number(uid));
            if (['left', 'kicked', 'banned'].includes(member.status)) {
                // Email-User: NICHT löschen — App-Zugang bleibt erhalten.
                if (u.email) {
                    u.inGruppe = false;
                    if (!u.leftGroupAt) u.leftGroupAt = Date.now();
                    continue;
                }
                delete d.users[uid];
                // Auch aus dailyXP, weeklyXP etc. entfernen
                delete d.dailyXP[uid];
                delete d.weeklyXP[uid];
                delete d.bonusLinks[uid];
                delete d.missionen[uid];
                delete d.tracker[uid];
                delete d.counter[uid];
                delete d.badgeTracker[uid];
                delete d.wochenMissionen[uid];
                delete d.missionQueue[uid];
                delete d.m1Streak[uid];
                if (d.notifications) delete d.notifications[uid];
                geloescht++;
            } else {
                d.users[uid].inGruppe = true;
                aktiv++;
            }
        } catch(e) {
            // Bei Fehler nur markieren, nicht löschen
            d.users[uid].inGruppe = false;
        }
        await new Promise(r => setTimeout(r, 100));
    }
    speichern();
    console.log('✅ Mitglieder geprüft: ' + aktiv + ' aktiv, ' + geloescht + ' gelöscht');
}



function updateStreak(uid) {
    const u = d.users[uid];
    if (!u) return;
    const heute = new Date().toDateString();
    const gestern = new Date(Date.now() - 86400000).toDateString();
    if (u.lastStreakDay === heute) return; // Heute bereits gezählt
    if (u.lastStreakDay === gestern) {
        u.streak = (u.streak || 0) + 1; // Streak verlängern
    } else {
        u.streak = 1; // Streak neu starten
    }
    u.lastStreakDay = heute;
}

// System-User "CreatorBoost" für In-App DMs (z.B. Superlink-Pflicht-Reminder)
// Holt das Instagram-OG-Image (Thumbnail/Deckblatt) für eine URL.
// Returns die Bild-URL oder null. Fail-soft: bei Block/Timeout/Parse-Fehler → null.
// Instagram blockt Bots aggressiv, ~80% Success-Rate mit Browser-Headers.
// Instagram-Reel-URL → robuste Embed-URL (öffentlich, weniger restriktiv beim Scraping).
function buildInstaEmbedUrl(url) {
    const m = String(url||'').match(/instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/);
    if (!m) return null;
    return `https://www.instagram.com/p/${m[1]}/embed/captioned/`;
}
async function _scrapeOgImage(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const r = await fetch(url, {
            signal: controller.signal,
            redirect: 'follow',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9',
                'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
                'Cache-Control': 'no-cache'
            }
        });
        clearTimeout(timer);
        if (!r.ok) return null;
        const html = await r.text();
        // Mehrere OG-Image-Patterns abdecken (Embed-Page liefert manchmal andere Reihenfolge).
        const m = html.match(/<meta\s+(?:property|name)="og:image"\s+content="([^"]+)"/i)
              || html.match(/<meta\s+content="([^"]+)"\s+(?:property|name)="og:image"/i)
              || html.match(/"display_url":"([^"]+)"/)
              || html.match(/"thumbnail_src":"([^"]+)"/);
        if (!m) return null;
        return m[1].replace(/&amp;/g,'&').replace(/\\u0026/g,'&').replace(/\\\//g,'/').slice(0, 800);
    } catch(e) { clearTimeout(timer); return null; }
}
async function fetchInstagramThumbnail(url) {
    if (!url || typeof url !== 'string' || !url.includes('instagram.com')) return null;
    // Erst Embed-URL versuchen (öffentlich, robuster gegen Login-Wall).
    const embedUrl = buildInstaEmbedUrl(url);
    if (embedUrl) {
        const t1 = await _scrapeOgImage(embedUrl);
        if (t1) return t1;
    }
    // Fallback: original URL scrapen.
    return await _scrapeOgImage(url);
}

// Synthetischer Link-ID-Generator für App-only Posts (kein Telegram-Message dahinter).
function generateSyntheticLinkId() {
    return 'app_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

// Async-Hook: nicht blockierend ein Thumbnail für eine link/superlink Entry holen.
function tryFetchThumbnail(entry, urlField = 'text') {
    if (!entry) return;
    const url = entry[urlField];
    if (!url) return;
    fetchInstagramThumbnail(url).then(thumb => {
        if (!thumb) return;
        entry.thumbnail = thumb;
        entry.thumbnailFetchedAt = Date.now();
        speichernDebounced();
    }).catch(()=>{});
}

// Refreshed Thumbnails alle 6 Std da Instagram-OG-URLs nach ~24h ablaufen.
// Targets: Links < 48h alt mit fehlendem oder >12h altem Thumbnail.
async function refreshThumbnails() {
    const now = Date.now();
    const cutoff48h = now - 48*3600*1000;
    const cutoff12h = now - 12*3600*1000;
    let refreshed = 0, attempts = 0;
    for (const link of Object.values(d.links||{})) {
        if (!link.timestamp || link.timestamp < cutoff48h) continue;
        if (link.thumbnail && (link.thumbnailFetchedAt || 0) > cutoff12h) continue;
        if (!link.text || !link.text.includes('instagram.com')) continue;
        attempts++;
        const thumb = await fetchInstagramThumbnail(link.text);
        if (thumb) { link.thumbnail = thumb; link.thumbnailFetchedAt = now; refreshed++; }
        await new Promise(r => setTimeout(r, 250));
    }
    const wk = (typeof getBerlinWeekKey === 'function') ? getBerlinWeekKey() : null;
    for (const sl of Object.values(d.superlinks||{})) {
        if (wk && sl.week !== wk) continue;
        if (sl.thumbnail && (sl.thumbnailFetchedAt || 0) > cutoff12h) continue;
        if (!sl.url) continue;
        attempts++;
        const thumb = await fetchInstagramThumbnail(sl.url);
        if (thumb) { sl.thumbnail = thumb; sl.thumbnailFetchedAt = now; refreshed++; }
        await new Promise(r => setTimeout(r, 250));
    }
    if (refreshed) speichernDebounced();
    if (attempts) console.log(`📸 Thumbnail-Refresh: ${refreshed}/${attempts} erfolgreich`);
    return { refreshed, attempts };
}

// Stellt sicher dass user u einen appCode hat — generiert einen wenn nicht.
// Wiederverwendet die Logik von /mycode (Hex-Random + Namen-Prefix + Kollisionscheck).
// Persistiert NEU generierte Codes via speichernDebounced damit Magic-Links nach
// einem Bot-Restart noch gültig sind, auch wenn der Caller selbst nicht speichert.
function ensureAppCode(uid, u) {
    if (!u) return null;
    if (u.appCode) return u.appCode;
    const taken = new Set(Object.values(d.users||{}).map(x => x.appCode).filter(Boolean));
    const namePart = (u.name||'user').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,8) || 'user';
    let candidate;
    do {
        const rand = crypto.randomBytes(4).toString('hex');
        candidate = namePart + rand;
    } while (taken.has(candidate));
    u.appCode = candidate;
    speichernDebounced();
    return candidate;
}

// Baut Magic-Link URL: /auth/auto?code=X&redirect=Y → User klickt → instant Session.
function buildMagicLinkUrl(uid, redirect = '/feed') {
    const u = d.users[String(uid)];
    if (!u) return (APP_URL || 'https://web-production-7981d.up.railway.app').replace(/\/$/,'');
    const code = ensureAppCode(String(uid), u);
    const baseUrl = (APP_URL || 'https://web-production-7981d.up.railway.app').replace(/\/$/,'');
    return baseUrl + '/auth/auto?code=' + encodeURIComponent(code) + '&redirect=' + encodeURIComponent(redirect);
}
function ensureCreatorBoostUser() {
    if (!d.users) d.users = {};
    if (!d.users[CREATORBOOST_UID]) {
        d.users[CREATORBOOST_UID] = {
            id: CREATORBOOST_UID,
            name: 'CreatorBoost',
            spitzname: 'CreatorBoost',
            role: '🤖 System',
            xp: 0,
            joined: Date.now(),
            isSystem: true
        };
    }
}
function sendCreatorBoostDM(toUid, text, options = {}) {
    ensureCreatorBoostUser();
    if (!d.messages) d.messages = {};
    const chatKey = [CREATORBOOST_UID, String(toUid)].sort().join('_');
    if (!d.messages[chatKey]) d.messages[chatKey] = [];
    const msg = {
        from: CREATORBOOST_UID,
        to: String(toUid),
        text: String(text||'').slice(0,1000),
        timestamp: Date.now(),
        read: false
    };
    if (options.link?.url) {
        msg.link = {
            url: String(options.link.url).slice(0, 500),
            label: String(options.link.label || 'Öffnen').slice(0, 60)
        };
    }
    d.messages[chatKey].push(msg);
    if (d.messages[chatKey].length > 200) d.messages[chatKey].shift();
    addNotification(String(toUid), '💬', 'CreatorBoost: ' + String(text||'').slice(0,40), CREATORBOOST_UID);
    sendAppPush(String(toUid), '💬 CreatorBoost', String(text||'').slice(0,100), '/nachrichten/' + CREATORBOOST_UID).catch(()=>{});
    speichernDebounced();
}

function addNotification(targetUid, icon, text, actorUid = null) {
    if (!d.notifications) d.notifications = {};
    if (!d.notifications[targetUid]) d.notifications[targetUid] = [];
    const entry = { icon, text, timestamp: Date.now(), read: false };
    if (actorUid) entry.actorUid = String(actorUid);
    d.notifications[targetUid].push(entry);
    // Max 50 Benachrichtigungen pro User
    if (d.notifications[targetUid].length > 50) d.notifications[targetUid].shift();
}

async function zeitCheck() {
    try {
        const jetzt = new Date();
        const h = jetzt.getHours();
        const m = jetzt.getMinutes();
        const tagStr = jetzt.toDateString();
        if (!d._lastEvents) d._lastEvents = {};
        const einmalig = (key, fn) => {
            const fullKey = `${key}_${h}:${m}_${tagStr}`;
            if (d._lastEvents[fullKey]) return;
            d._lastEvents[fullKey] = true;
            return fn();
        };
        // Einmal-pro-Stunde-pro-Tag: nimmt einen 5-Minuten-Toleranzfenster auf, damit setInterval-
        // Drift nicht ganze Tage überspringt (vorher: einziger Tick auf m===0 — bei einer Verzögerung
        // läuft missionenAuswerten/dailyRanking gar nicht).
        const taeglich = (key, fn) => {
            const fullKey = `${key}_${h}_${tagStr}`;
            if (d._lastEvents[fullKey]) return;
            d._lastEvents[fullKey] = true;
            return fn();
        };
        if (h === 3  && m < 5)  taeglich('backup',       () => backup());
        if (h === 4  && m < 5)  taeglich('memberCheck', () => gruppenMitgliederPruefen());
        if (jetzt.getDay() === 1 && h === 0 && m < 10) taeglich('wochenReset', () => {
            d.wochenMissionen = {};
            // Weekly reset runs once at the start of Monday in Berlin time.
            // (Berlin TZ). Vorher wurde das fälschlicherweise Sonntag 20:00 via /gewinnspiel-abschluss
            // gemacht — dadurch zeigte das Wochen-Ranking ab So 20:00 schon eine "neue Woche".
            if (archiveWeeklyXP('monday-reset')) console.log('💾 weeklyXP archiviert');
            d.weeklyXP = {};
            d.weeklyReset = Date.now();
            // Letzte-Woche-Key (Montag vor 7 Tagen)
            const lastWeekMonday = new Date(jetzt);
            lastWeekMonday.setDate(jetzt.getDate() - 7);
            const lastWeekKey = lastWeekMonday.getFullYear() + '-' + String(lastWeekMonday.getMonth()+1).padStart(2,'0') + '-' + String(lastWeekMonday.getDate()).padStart(2,'0');
            // Superlink-Credit nur für User die letzte Woche IHR Standard-Slot NICHT
            // verbraucht haben. Wer gepostet hat bekommt nur den normalen 1/1-Reset.
            const postedLastWeekUids = new Set(
                Object.values(d.superlinks||{})
                    .filter(s => s && s.week === lastWeekKey)
                    .map(s => String(s.uid))
            );
            let granted = 0, skipped = 0;
            for (const [uid, u] of Object.entries(d.users||{})) {
                if (!u || u.parent_uid || u.banned || !u.started) continue;
                if (istAdminId(uid)) continue;
                if (postedLastWeekUids.has(String(uid))) { skipped++; continue; }
                u.superlinkCredits = (Number(u.superlinkCredits)||0) + 1;
                granted++;
            }
            console.log('✅ weeklyXP + Wochenmissionen resettet (Mo 00:05) · ' + granted + ' Credits vergeben · ' + skipped + ' User skipped (hatten letzte Woche gepostet)');
            speichern();
        });
        if (h === 7  && m >= 5 && m < 10)  taeglich('toplinks',     () => { Object.values(d.chats).filter(c => istGruppe(c.type)).forEach(g => topLinks(g.id)); });
        if (h === 12 && m < 5)  taeglich('missionen',    () => missionenAuswerten());
        if (h === 22 && m < 5)  taeglich('abendwarnung', () => abendM1Warnung());
        if (h === 22 && m < 5)  taeglich('reminder',     () => likeErinnerung());
        if (h === 19 && m < 5)  taeglich('bonusReminder',() => bonusLinkErinnerung());
        if (h === 11 && m < 5)  taeglich('welcomeFunnel',() => welcomeFunnelCheck());
        if (jetzt.getDay() === 3 && h === 18 && m < 5) taeglich('appReminder', () => appReminderForNonUsers());
        if (m === 0 || m === 30) einmalig('feedBatch_'+h+'_'+m, () => feedBatchDM().catch(e => console.log('feedBatchDM Fehler:', e.message)));
        if (m < 5 && [0,6,12,18].includes(h)) taeglich('thumbnailRefresh_'+h, () => refreshThumbnails().catch(e => console.log('refreshThumbnails Fehler:', e.message)));
        if (m === 30) einmalig('smartReminder_'+h, () => smartReminderCheck());
        if (m === 15 || m === 45) einmalig('syncDelTM_'+h+'_'+m, () => syncDeletedThreadMessages().catch(e => console.log('syncDeletedThreadMessages Fehler:', e.message)));
        if (h === 23 && m >= 55) taeglich('dailyRanking', () => dailyRankingAbschluss());
        if (d.xpEvent?.start && d.xpEvent?.end) {
            const now = Date.now();
            if (!d.xpEvent.aktiv && now >= d.xpEvent.start && now <= d.xpEvent.end) {
                d.xpEvent.aktiv = true; speichernDebounced();
                const pct = Math.round((d.xpEvent.multiplier-1)*100);
                broadcastAppPush('🚀 XP Event läuft!', '+'+pct+'% XP auf alle Aktionen — jetzt aktiv sein!', '/feed').catch(()=>{});
            }
            if (d.xpEvent.aktiv && now > d.xpEvent.end) { d.xpEvent.aktiv = false; speichernDebounced(); }
        }
        const zweiTage = 2 * 24 * 60 * 60 * 1000;
        for (const [k, l] of Object.entries(d.links)) {
            if (Date.now() - l.timestamp > zweiTage) {
                if (!l.appOnly) bot.telegram.deleteMessage(l.chat_id, l.counter_msg_id).catch(() => {});
                const mk = String(l.counter_msg_id);
                if (d.dmNachrichten?.[mk]) {
                    for (const [uid2, dmId] of Object.entries(d.dmNachrichten[mk])) bot.telegram.deleteMessage(Number(uid2), dmId).catch(() => {});
                    delete d.dmNachrichten[mk];
                }
                const lu = linkUrl(l.text);
                if (lu) { const idx = d.gepostet.indexOf(lu); if (idx !== -1) d.gepostet.splice(idx, 1); }
                delete d.links[k];
            }
        }
        for (const key of Object.keys(d._lastEvents)) { if (!key.endsWith(tagStr)) delete d._lastEvents[key]; }
    } catch (e) { console.log('ZeitCheck Fehler:', e.message); }
}

setInterval(zeitCheck, 60000);

// ── CLEANUP: Gelöschte Telegram-Nachrichten aus d.links entfernen ──
let cleanupOffset = 0;
async function cleanupDeletedLinks() {
    const keys = Object.keys(d.links);
    if (!keys.length) return;
    const batch = keys.slice(cleanupOffset, cleanupOffset + 15);
    cleanupOffset = (cleanupOffset + 15) >= keys.length ? 0 : cleanupOffset + 15;
    let changed = false;
    for (const key of batch) {
        const link = d.links[key];
        if (!link?.chat_id || !link?.counter_msg_id) { delete d.links[key]; changed = true; continue; }
        // App-only Links haben kein Telegram-Message → Cleanup würde sie sonst löschen.
        if (link.appOnly) continue;
        try {
            await bot.telegram.editMessageReplyMarkup(
                link.chat_id, link.counter_msg_id, null,
                buildLinkButtons(link.counter_msg_id, link.likes?.size || 0)
            );
        } catch(e) {
            const errText = ((e?.response?.description || '') + ' ' + (e?.message || '')).toLowerCase();
            const isGone = errText.includes('message to edit not found') || errText.includes('message not found') || errText.includes('message_id_invalid');
            const isNotModified = errText.includes('not modified');
            if (isGone && !isNotModified) {
                const dmKey = String(link.counter_msg_id);
                if (d.dmNachrichten?.[dmKey]) {
                    for (const [uid2, dmId] of Object.entries(d.dmNachrichten[dmKey])) bot.telegram.deleteMessage(Number(uid2), dmId).catch(()=>{});
                    delete d.dmNachrichten[dmKey];
                }
                delete d.links[key];
                changed = true;
            }
        }
        await new Promise(r => setTimeout(r, 300));
    }
    if (changed) speichern();
}
setInterval(cleanupDeletedLinks, 3 * 60 * 1000); // alle 3 Minuten


app.get('/restore-upload', (req, res) => {
    const key = req.query.key;
    if (key !== BRIDGE_SECRET) return res.status(403).send('Falscher Key');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Daten hochladen</title>
    <style>body{font-family:sans-serif;max-width:500px;margin:40px auto;padding:20px}
    input,textarea,button{width:100%;padding:12px;margin:8px 0;font-size:14px;box-sizing:border-box}
    button{background:#2563eb;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:16px}</style></head>
    <body><h2>📂 Daten wiederherstellen</h2>
    <p>Option 1: Datei hochladen</p>
    <form method="POST" action="/restore-upload?key=${key}" enctype="multipart/form-data">
    <input type="file" name="file" accept=".json" required>
    <button type="submit">Hochladen ✅</button></form>
    <hr><p>Option 2: JSON direkt einfügen</p>
    <form method="POST" action="/restore-json?key=${key}">
    <textarea name="json" rows="6" placeholder='{"users":{...}}'></textarea>
    <button type="submit">Einfügen ✅</button></form>
    </body></html>`);
});

app.post('/restore-json', express.urlencoded({ extended: true, limit: '50mb' }), (req, res) => {
    const key = req.query.key;
    if (key !== BRIDGE_SECRET) return res.status(403).send('Falscher Key');
    try {
        const parsed = JSON.parse(req.body.json);
        fs.writeFileSync(DATA_FILE, JSON.stringify(parsed));
        laden();
        res.send(`<h2>✅ ${Object.keys(d.users||{}).length} User, ${Object.keys(d.links||{}).length} Links geladen!</h2>`);
    } catch(e) { res.status(500).send('Fehler: ' + e.message); }
});

app.post('/restore-upload', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    const key = req.query.key;
    if (key !== BRIDGE_SECRET) return res.status(403).send('Falscher Key');
    try {
        const body = req.body.toString();
        const jsonMatch = body.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return res.status(400).send('Keine JSON Daten gefunden');
        fs.writeFileSync(DATA_FILE, jsonMatch[0]);
        laden();
        res.send(`<h2>✅ ${Object.keys(d.users||{}).length} User, ${Object.keys(d.links||{}).length} Links geladen!</h2>`);
    } catch (e) {
        res.status(500).send('Fehler: ' + e.message);
    }
});

app.get('/data', (req, res) => {
    const secret = req.headers['x-bridge-secret'] || req.query.secret;
    if (secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Forbidden' });
    const out = Object.assign({}, d);
    out._adminIds = [...ADMIN_IDS];

    // Likes nach URL zusammenführen - Bridge Bot Links bekommen alle Likes
    const likesByUrl = {};
    for (const [k, v] of Object.entries(d.links)) {
        const url = (v.text||'').trim();
        if (!url) continue;
        if (!likesByUrl[url]) likesByUrl[url] = { likes: new Set(), likerNames: {} };
        v.likes.forEach(uid => likesByUrl[url].likes.add(uid));
        Object.assign(likesByUrl[url].likerNames, v.likerNames||{});
    }

    out.links = {};
    for (const [k, v] of Object.entries(d.links)) {
        const url = (v.text||'').trim();
        const merged = likesByUrl[url] || { likes: new Set(), likerNames: {} };
        const likesArr = Array.from(merged.likes);
        // Auto-include poster AND their family (parent/sub) in likes for display.
        // Self-like is blocked for the whole family via getRootUid, so all family
        // members should see this post as "done" in feed progress calculations.
        const posterFamily = familyUids(String(v.user_id));
        for (const fUid of posterFamily) {
            if (!likesArr.includes(fUid)) likesArr.push(fUid);
        }
        out.links[k] = Object.assign({}, v, {
            likes: likesArr,
            likerNames: merged.likerNames
        });
    }
    res.json(out);
});

function collectionCount(value) {
    if (!value) return 0;
    if (value instanceof Set) return value.size;
    if (Array.isArray(value)) return value.length;
    if (typeof value === 'object') return Object.keys(value).length;
    return 0;
}

function isPublicCommunityUser(uid, u) {
    if (!u || uid === CREATORBOOST_UID || u.isSystem || u.parent_uid) return false;
    if (u.inGruppe === false) return false;
    if (istAdminId(Number(uid))) return false;
    if (u.is_bot === true || (u.username && /bot$/i.test(String(u.username)))) return false;
    return true;
}

function buildCommunityStats() {
    const users = Object.entries(d.users || {}).filter(([uid, u]) => isPublicCommunityUser(uid, u));
    const links = Object.values(d.links || {});
    const superlinks = Object.values(d.superlinks || {});
    const likes = links.reduce((sum, l) => sum + collectionCount(l && l.likes), 0) +
        superlinks.reduce((sum, sl) => sum + collectionCount(sl && sl.likes), 0);
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const activeToday = users.filter(([uid, u]) => {
        const activityTs = Number(d.appActivity?.[uid]?.lastSeen || u.appLastSeen || 0);
        return activityTs >= since;
    }).length;
    return {
        ok: true,
        members: users.length,
        activeToday,
        posts: links.length + superlinks.length,
        likes,
        currentPosts: links.length + superlinks.length,
        totalPosts: links.length + superlinks.length,
        currentLikes: likes,
        totalLikes: likes
    };
}

app.get('/community-stats-api', (req, res) => {
    res.json(buildCommunityStats());
});

// Public app alias used by the browser landing/login app. This intentionally
// avoids loading /data, which can be large enough to make the UI appear blank.
app.get('/api/community-stats', (req, res) => {
    res.json(buildCommunityStats());
});

function checkBridgeSecret(req, res) {
    const secret = req.headers['x-bridge-secret'] || req.query?.secret;
    if (secret !== BRIDGE_SECRET) { res.status(403).json({ error: 'Forbidden' }); return false; }
    return true;
}

// ── One-time Superlink-Credit-Backfill ──
// Vergangene Roulette-/Gewinnspiel-Wins wurden teilweise nicht korrekt
// gutgeschrieben (postBot fire-and-forget, kein Retry). Ein-mal-Backfill
// gibt jedem aktiven User +1 Superlink-Credit als Wiedergutmachung.
// Idempotent via d._slCreditBackfillDone Flag.
function runSuperlinkCreditBackfill() {
    if (d._slCreditBackfillDone) return;
    let granted = 0;
    for (const [uid, u] of Object.entries(d.users||{})) {
        if (!u || u.parent_uid || u.banned || !u.started) continue;
        if (istAdminId(uid)) continue;
        u.superlinkCredits = (Number(u.superlinkCredits)||0) + 1;
        granted++;
    }
    d._slCreditBackfillDone = Date.now();
    speichern();
    console.log('🎁 Superlink-Credit-Backfill: ' + granted + ' User haben +1 Credit erhalten (Wiedergutmachung für nicht-gutgeschriebene Roulette-Wins)');
}
// Beim Start ausführen
setTimeout(runSuperlinkCreditBackfill, 5000);

// ── XP-Event Legacy-Cleanup ──
// Alte XP-Events mit bonusPerPost-Modus zeigen im App-Feed-Banner noch
// "+X XP pro Post". Beim Boot: alle aktiven Legacy-Events stoppen damit
// User sauber im neuen %-pro-Like-Modus starten können.
function cleanupLegacyXpEvent() {
    if (!d.xpEvent) return;
    const hasLegacy = d.xpEvent.bonusPerPost > 0 && (!d.xpEvent.multiplier || d.xpEvent.multiplier <= 1);
    if (!hasLegacy) return;
    console.log('🧹 Legacy XP-Event cleanup: bonusPerPost=' + d.xpEvent.bonusPerPost + ' → gestoppt');
    d.xpEvent.bonusPerPost = 0;
    d.xpEvent.aktiv = false;
    d.xpEvent.end = null;
    speichern();
}
setTimeout(cleanupLegacyXpEvent, 6000);

app.get('/xp-event-status', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    res.json({ aktiv: d.xpEvent?.aktiv || false, multiplier: d.xpEvent?.multiplier || 1 });
});

app.post('/bridge-event', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const event = req.body?.event || req.body;
    const userId = event.userId || event.user_id;
    if (!event?.type) return res.status(400).json({ error: 'Ungültig' });

    // Sofort antworten
    res.status(200).json({ ok: true });

    try {
        let uid = userId ? String(userId) : null;
        const name = event.userName || 'Unbekannt';
        if (uid && !d.users[uid]) user(uid, name);

        if (event.type === 'post_forwarded') {
            if (event.meta?.groupBMsgId && event.meta?.groupBChatId) {
                const msgId = event.meta.groupBMsgId;
                const linkData = { chat_id: event.meta.groupBChatId, user_id: Number(event.userId), user_name: event.userName, text: event.meta.linkText || '', likes: new Set(), likerNames: {}, counter_msg_id: msgId, timestamp: Date.now(), origin: 'telegram', likeSource: { app: 0, telegram: 0 } };
                const mapKey = MEINE_GRUPPE + '_' + msgId;
                d.links[mapKey] = linkData;
                tryFetchThumbnail(linkData, 'text');
                const url = event.meta.linkText || '';
                if (url && !d.gepostet.includes(url)) { d.gepostet.push(url); if (d.gepostet.length > 2000) d.gepostet.shift(); }
                if (uid && !istAdminId(Number(uid))) { d.users[uid].links = (d.users[uid].links || 0) + 1; updateStreak(uid); }
                speichernDebounced();
                await sendeLinkAnAlle(linkData);
            }
        }

        if (event.type === 'like_given') {
            const { mapKey, groupBMsgId } = event.meta || {};
            if (!mapKey || !uid) return;

            console.log('[LIKE_GIVEN] mapKey:', mapKey, 'groupBMsgId:', groupBMsgId, 'linkText:', event.meta?.linkText?.slice(0,30));
            console.log('[LIKE_GIVEN] Links in d.links:', Object.keys(d.links).length, 'keys sample:', Object.keys(d.links).slice(0,5));

            let link = d.links[mapKey];
            if (link) { console.log('[LIKE_GIVEN] Gefunden via mapKey direkt'); }

            if (!link) {
                const msgId = mapKey.split('_').slice(1).join('_');
                link = d.links['B_' + msgId] || d.links['C_' + msgId] ||
                    Object.values(d.links).find(l => String(l.counter_msg_id) === String(msgId));
                if (link) console.log('[LIKE_GIVEN] Gefunden via msgId Fallback:', msgId);
            }
            if (!link && groupBMsgId) {
                link = Object.values(d.links).find(l => String(l.counter_msg_id) === String(groupBMsgId));
                if (link) console.log('[LIKE_GIVEN] Gefunden via groupBMsgId:', groupBMsgId);
            }
            if (!link && event.meta?.linkText) {
                link = Object.values(d.links).find(l => l.text === event.meta.linkText);
                if (link) console.log('[LIKE_GIVEN] Gefunden via linkText');
            }
            if (!link) {
                console.log('[LIKE_GIVEN] ❌ NICHT GEFUNDEN! mapKey:', mapKey, 'linkText:', event.meta?.linkText?.slice(0,50));
                console.log('[LIKE_GIVEN] Alle Keys:', Object.keys(d.links).join(', '));
                return;
            }
            console.log('[LIKE_GIVEN] ✅ Link gefunden, counter_msg_id:', link.counter_msg_id, 'likes vorher:', link.likes?.size);

            const uidNum = Number(uid);
            if (!link.likes) link.likes = new Set();
            // FIX: Nicht nochmal hinzufügen wenn schon geliked
            if (!link.likes.has(String(uid))) {
                link.likes.add(String(uid));
                if (!link.likerNames) link.likerNames = {};
                link.likerNames[String(uid)] = { name: name, insta: d.users[uid]?.instagram || null };
                if (!link.likeSource) link.likeSource = { app: 0, telegram: 0 };
                link.likeSource.telegram = (link.likeSource.telegram||0) + 1;
            }

            // FIX 1: XP nur vergeben wenn fromBridge=true (Bridge Bot Like, nicht eigener Main Bot Like)
            if (event.meta?.fromBridge) {
                xpAddMitDaily(uid, event.xp || 5, name);
            }

            if (!istAdminId(uid)) {
                const mission = getMission(uid);
                updateMissionProgress(uid);
                const linkTimestamp = Object.values(d.links).find(l => l.text === event.meta?.linkText)?.timestamp;
                const istHeutigerBridgeLink = linkTimestamp && new Date(linkTimestamp).toDateString() === new Date().toDateString();
                if (istHeutigerBridgeLink && istInstagramLink(event.meta.linkText)) mission.likesGegeben++;
                await checkMissionen(uid, name);
            }

            // Telegram Counter sofort updaten
            try {
                const anz = link.likes.size;
                const poster = d.users[String(link.user_id)] || {};
                const posterLabel = istAdminId(link.user_id) ? '⚙️ Admin ' + link.user_name : (poster.role||'🆕') + ' ' + link.user_name;
                const posterStats = istAdminId(link.user_id) ? '' : '  |  ⭐ ' + (poster.xp||0) + ' XP';
                const chatId = link.chat_id || GROUP_B_ID;
                console.log('[LIKE_GIVEN] Updating Telegram chat_id:', chatId, 'msg_id:', link.counter_msg_id);
                await bot.telegram.editMessageText(
                    Number(chatId),
                    Number(link.counter_msg_id),
                    null,
                    posterLabel + '\n🔗 ' + link.text + '\n\n👍 ' + anz + ' Likes' + posterStats,
                    { reply_markup: buildLinkButtons(link.counter_msg_id, anz) }
                );
                console.log('[LIKE_GIVEN] ✅ Telegram Counter updated:', anz);
            } catch(e) { console.log('[LIKE_GIVEN] Telegram update Fehler:', e.message); }

            speichernDebounced();
        }

    } catch (e) { console.log('Bridge event Fehler:', e.message); }
});

app.post('/xp-event-announced', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    if (d.xpEvent) d.xpEvent.announced = true;
    speichern(); res.json({ ok: true });
});

// Wochen-Gewinnspiel: Vollständige Auswertung in EINEM Endpoint.
// Trigger: creatorboost-app cron (Sonntag 20:00 Berlin TZ) ruft das via fetch auf.
// Vorher: Announcer-Bot pickte den Gewinner und rief /gewinnspiel-abschluss.
// Der Announcer ist abgeschaltet — die Logik (inkl. Random-Winner-Wahl) lebt jetzt hier.
app.post('/run-wochen-gewinnspiel-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    try {
        // 1) Random-Winner aus weeklyXP (gefiltert wie früher im Announcer)
        const adminIds = Array.isArray(d._adminIds) ? d._adminIds.map(Number) : [];
        const isBot = (u) => !!(u && (u.is_bot === true || (u.username && /bot$/i.test(u.username))));
        const teilnehmer = Object.entries(d.weeklyXP || {})
            .filter(([uid]) => {
                const u = d.users[uid];
                if (!u || !u.started || u.inGruppe === false) return false;
                if (adminIds.includes(Number(uid)) || istAdminId(uid)) return false;
                if (isBot(u)) return false;
                return d.weeklyXP[uid] > 0;
            })
            .map(([uid]) => uid);
        let winnerId = null, winnerName = null;
        if (teilnehmer.length) {
            winnerId = teilnehmer[Math.floor(Math.random() * teilnehmer.length)];
            const winner = d.users[winnerId];
            winnerName = winner ? winner.name : '?';
            if (!d.bonusLinks[winnerId]) d.bonusLinks[winnerId] = 0;
            d.bonusLinks[winnerId] += 1;
            if (!d.wochenGewinnspiel) d.wochenGewinnspiel = { gewinner: [] };
            if (!Array.isArray(d.wochenGewinnspiel.gewinner)) d.wochenGewinnspiel.gewinner = [];
            d.wochenGewinnspiel.gewinner.push({ name: winnerName, uid: winnerId, datum: new Date().toLocaleDateString() });
            d.wochenGewinnspiel.letzteAuslosung = Date.now();
            try { await dmUser(winnerId, '🎉 *Du hast das Wochen-Gewinnspiel gewonnen!*\n\n🎁 1 Extra Link nächste Woche!', { parse_mode: 'Markdown' }); } catch (e) {}
        } else {
            console.log('❌ Wochen-Gewinnspiel: keine Teilnehmer');
        }

        // 2) Wochen-Superlink-Engagement-Diamanten (wer alle Superlinks der Woche engagiert hat → +1 💎)
        try {
            const woche = Object.values(d.superlinks||{}).filter(sl => sl && sl.likes !== undefined);
            if (woche.length >= 2) {
                const slLikersPerSl = woche.map(sl => new Set((Array.isArray(sl.likes)?sl.likes:[]).map(String)));
                const slPosters = new Set(woche.map(sl => String(sl.uid||sl.user_id||'')));
                for (const [uid, u] of Object.entries(d.users||{})) {
                    if (!u || istAdminId(uid) || u.parent_uid || u.inGruppe===false || !u.started) continue;
                    if (slPosters.has(String(uid))) continue;
                    const allEngaged = slLikersPerSl.every(set => set.has(String(uid)));
                    if (allEngaged) {
                        addDiamond(uid, 1);
                        dmUser(uid, '💎 *Wochenengagement-Bonus!*\n\nDu hast diese Woche ALLE Superlinks engagiert. +1 Diamant 🙏\nAktuell: ' + (d.users[uid].diamonds||0) + ' 💎', { parse_mode: 'Markdown' });
                    }
                }
            }
        } catch(e) { console.log('Wochen-Engagement-Diamant Fehler:', e.message); }

        // weeklyXP wird hier NICHT resettet — Reset läuft Montag 00:05 (wochenReset).
        speichern();
        await weeklyRankingDM();
        res.json({ ok: true, winnerId, winnerName, teilnehmer: teilnehmer.length });
    } catch (e) {
        console.log('Wochen-Gewinnspiel Fehler:', e.message);
        res.status(500).json({ ok: false, error: e.message });
    }
});

function archiveWeeklyXP(reason='auto') {
    const snapshot = Object.assign({}, d.weeklyXP||{});
    const total = Object.values(snapshot).reduce((s,x)=>s+x,0);
    if (!Object.keys(snapshot).length) return false;
    if (!d.weeklyHistory) d.weeklyHistory = [];
    const sortedTop = Object.entries(snapshot).filter(([uid])=>d.users[uid] && !istAdminId(uid)).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([uid,xp])=>({uid, name:d.users[uid]?.name||'?', xp}));
    d.weeklyHistory.push({ weekKey: getBerlinWeekKey(), endedAt: Date.now(), reason, total, top: sortedTop, snapshot });
    while (d.weeklyHistory.length > 26) d.weeklyHistory.shift(); // 6 Monate aufheben
    return true;
}


// ================================
// MINDSET STORIES — 1 zufälliger User pro Woche auf @mindset.stories_
// ================================

// Locked = ab Samstag 23:59 bis nach dem Sonntag-Pick keine Änderungen mehr möglich
function isMindsetLocked() {
    const now = new Date();
    const day = now.getDay();      // 0=Sonntag, 6=Samstag
    if (day === 0) return true;    // Sonntag komplett gefroren
    if (day === 6 && now.getHours() >= 23 && now.getMinutes() >= 59) return true;
    return false;
}

// In-App-DM: schreibt direkt in d.messages (keine Telegram-Weiterleitung), Absender 'creatorboost'.
function sendInAppDM(toUid, text) {
    if (!d.users[String(toUid)]) return false;
    if (!d.messages) d.messages = {};
    const chatKey = [CREATORBOOST_UID, String(toUid)].sort().join('_');
    if (!d.messages[chatKey]) d.messages[chatKey] = [];
    d.messages[chatKey].push({
        from: CREATORBOOST_UID, to: String(toUid),
        text: String(text||'').slice(0, 2000),
        image: null, audio: null,
        timestamp: Date.now(), read: false, system: true,
    });
    if (d.messages[chatKey].length > 200) d.messages[chatKey].shift();
    addNotification(String(toUid), '💬', 'CreatorX: ' + String(text||'').slice(0,40), CREATORBOOST_UID);
    return true;
}

async function sendMindsetWinnerDM(uid) {
    const name = d.users[uid]?.spitzname || d.users[uid]?.name || '';
    const greeting = name ? 'Hallo ' + name + ',' : 'Hallo,';
    const text = greeting + '\n\n' +
        'du wurdest diese Woche für die Mindset Stories auf @mindset.stories_ ausgewählt — herzlichen Glückwunsch. Du erscheinst am kommenden Sonntag bzw. Montag in den Stories.\n\n' +
        'Damit ich dich gut vorstellen kann, benötige ich folgende Infos von dir:\n\n' +
        '1. 1–2 Deckblätter (Bilder oder Grafiken, die zu dir passen)\n' +
        '2. 1–2 Interessen oder Themen, die du abdeckst\n' +
        '3. Eine kurze Beschreibung deines Kanals bzw. deiner Nische\n' +
        '4. Was sollen meine Follower aus deinem Post mitnehmen?\n' +
        '5. Bietest du etwas an (Kurse, Beratung, Coaching o.ä.)?\n' +
        '6. Bist du auch auf YouTube oder TikTok aktiv? Falls ja, gerne mit Handles.\n\n' +
        'Schick mir die Infos einfach hier in der DM zurück — ich erstelle daraus eine ansprechende Vorstellung.\n\n' +
        'Bitte spätestens bis Samstag 23:59 zurückmelden, damit genug Zeit für die Vorbereitung bleibt.\n\n' +
        'Viele Grüße';
    sendInAppDM(uid, text);
}

async function sendMindsetInviteDM(uid) {
    const name = d.users[uid]?.spitzname || d.users[uid]?.name || '';
    const greeting = name ? 'Hallo ' + name + ',' : 'Hallo,';
    const text = greeting + '\n\n' +
        'ich starte einen wöchentlichen Mindset-Stories-Slot auf meinem Instagram-Profil @mindset.stories_, in dem ich Creator aus unserer Community vorstelle.\n\n' +
        'Ziel ist es, die Community zu pushen und gemeinsam mehr Reichweite zu generieren.\n\n' +
        'Wenn du Interesse hast, kannst du dich gerne über die App eintragen. Ich wähle anschließend jede Woche einen User aus der Warteliste aus und stelle ihn am Sonntag/Montag auf @mindset.stories_ vor.\n\n' +
        'So funktioniert\'s:\n' +
        '1. App öffnen → Explore → News\n' +
        '2. Bei "Mindset Stories" auf Ja oder Nein klicken\n' +
        '3. Bei Ja: du bist auf der Warteliste, ich melde mich sobald du dran bist\n\n' +
        'Ohne Druck — du kannst deine Antwort bis Samstag 23:59 jederzeit ändern.\n\n' +
        'Viele Grüße';
    sendInAppDM(uid, text);
}

// GET state für einen User (oder Admin-View)
app.get('/mindset-state-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const ms = d.mindsetStories;
    const uid = String(req.query.uid || '');
    const isAdmin = uid && (istAdminId(uid) || String(d.users[uid]?.role||'').includes('Admin'));
    const currentWeek = getBerlinWeekKey();
    // weeklyState ist nur "aktuell" wenn week === currentWeek. Sonst stale Daten der letzten Woche.
    const stateIsCurrent = ms.weeklyState?.week === currentWeek;
    const currentPickedUid = stateIsCurrent ? ms.weeklyState.pickedUid : null;
    const myStatus = uid ? (
        currentPickedUid === uid ? 'picked' :
        ms.done[uid] ? 'done' :
        ms.waitlist[uid] ? 'yes' :
        ms.rejected[uid] ? 'no' :
        'none'
    ) : 'none';
    const out = {
        ok: true,
        week: currentWeek,
        pickedUid: currentPickedUid,
        pickedName: currentPickedUid ? (d.users[currentPickedUid]?.spitzname || d.users[currentPickedUid]?.name || '?') : null,
        skipped: stateIsCurrent ? !!ms.weeklyState?.skipped : false,
        locked: isMindsetLocked(),
        myStatus,
        myDoneWeek: ms.done[uid]?.week || null,
        counts: {
            waitlist: Object.keys(ms.waitlist).length,
            rejected: Object.keys(ms.rejected).length,
            done: Object.keys(ms.done).length,
        },
    };
    if (isAdmin) {
        out.waitlist = Object.entries(ms.waitlist)
            .sort((a,b)=>(a[1].joinedAt||0)-(b[1].joinedAt||0))
            .map(([u,v])=>({ uid:u, name:d.users[u]?.spitzname||d.users[u]?.name||'?', insta:d.users[u]?.instagram||'', joinedAt:v.joinedAt }));
        out.done = Object.entries(ms.done)
            .sort((a,b)=>(b[1].featuredAt||0)-(a[1].featuredAt||0))
            .map(([u,v])=>({ uid:u, name:v.name||d.users[u]?.spitzname||d.users[u]?.name||'?', week:v.week, featuredAt:v.featuredAt }));
    }
    res.json(out);
});

// POST setzt yes/no für einen User
app.post('/mindset-set-answer-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String(req.body.uid || '');
    const answer = String(req.body.answer || ''); // 'yes' oder 'no'
    if (!uid || !d.users[uid]) return res.json({ ok:false, error:'User nicht gefunden' });
    if (!['yes','no'].includes(answer)) return res.json({ ok:false, error:'Ungültige Antwort' });
    if (!d.users[uid].instagram) return res.json({ ok:false, error:'Erst Instagram-Username in den Einstellungen setzen' });
    if (isMindsetLocked()) return res.json({ ok:false, error:'Antworten für diese Woche bereits gefroren' });
    if (d.mindsetStories.done[uid]) return res.json({ ok:false, error:'Du wurdest bereits vorgestellt' });
    const now = Date.now();
    if (answer === 'yes') {
        delete d.mindsetStories.rejected[uid];
        const prev = d.mindsetStories.waitlist[uid];
        d.mindsetStories.waitlist[uid] = { joinedAt: prev?.joinedAt || now, lastChangedAt: now };
    } else {
        delete d.mindsetStories.waitlist[uid];
        d.mindsetStories.rejected[uid] = { rejectedAt: now };
    }
    speichern();
    res.json({ ok:true });
});

// POST Sonntag 20:00 Cron-Trigger → zufälliger Pick
app.post('/run-mindset-pick-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const ms = d.mindsetStories;
    const week = getBerlinWeekKey();
    // Bereits gepickt diese Woche? Idempotent.
    if (ms.weeklyState.week === week && ms.weeklyState.pickedUid) {
        return res.json({ ok:true, already:true, pickedUid: ms.weeklyState.pickedUid });
    }
    // Eligible: User in waitlist mit gesetztem Insta, nicht bereits in done, existiert.
    const eligible = Object.keys(ms.waitlist).filter(uid => {
        const u = d.users[uid];
        return u && u.instagram && !ms.done[uid];
    });
    if (!eligible.length) {
        ms.weeklyState = { week, pickedUid: null, pickedAt: Date.now(), locked: true };
        speichern();
        return res.json({ ok:true, pickedUid: null, reason:'Niemand auf Warteliste' });
    }
    const winner = eligible[Math.floor(Math.random() * eligible.length)];
    ms.weeklyState = { week, pickedUid: winner, pickedAt: Date.now(), locked: true };
    // Aus waitlist raus, in done rein
    delete ms.waitlist[winner];
    ms.done[winner] = { week, featuredAt: Date.now(), name: d.users[winner]?.spitzname || d.users[winner]?.name || '?' };
    speichern();
    try { await sendMindsetWinnerDM(winner); } catch(e) { console.log('Mindset Winner-DM Fehler:', e.message); }
    res.json({ ok:true, pickedUid: winner, pickedName: d.users[winner]?.name });
});

// POST Admin überschreibt Pick mit konkreter uid
app.post('/mindset-admin-pick-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const callerUid = String(req.body.callerUid || '');
    if (!callerUid || !(istAdminId(callerUid) || String(d.users[callerUid]?.role||'').includes('Admin'))) return res.json({ ok:false, error:'Kein Admin' });
    const targetUid = String(req.body.targetUid || '');
    if (!targetUid || !d.users[targetUid]) return res.json({ ok:false, error:'User nicht gefunden' });
    const ms = d.mindsetStories;
    const week = getBerlinWeekKey();
    // Falls schon jemand gepickt: zurück auf waitlist (wenn er da war)
    if (ms.weeklyState.pickedUid && ms.weeklyState.pickedUid !== targetUid) {
        const prev = ms.weeklyState.pickedUid;
        if (ms.done[prev] && ms.done[prev].week === week) {
            delete ms.done[prev];
            ms.waitlist[prev] = { joinedAt: Date.now(), lastChangedAt: Date.now() };
        }
    }
    delete ms.waitlist[targetUid];
    ms.weeklyState = { week, pickedUid: targetUid, pickedAt: Date.now(), locked: true };
    ms.done[targetUid] = { week, featuredAt: Date.now(), name: d.users[targetUid]?.spitzname || d.users[targetUid]?.name || '?' };
    speichern();
    try { await sendMindsetWinnerDM(targetUid); } catch(e) {}
    res.json({ ok:true, pickedUid: targetUid });
});

// POST Admin skipt diese Woche (kein Pick)
app.post('/mindset-admin-skip-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const callerUid = String(req.body.callerUid || '');
    if (!callerUid || !(istAdminId(callerUid) || String(d.users[callerUid]?.role||'').includes('Admin'))) return res.json({ ok:false, error:'Kein Admin' });
    d.mindsetStories.weeklyState = { week: getBerlinWeekKey(), pickedUid: null, pickedAt: Date.now(), locked: true, skipped: true };
    speichern();
    res.json({ ok:true });
});

// POST Admin: Initial-DM-Blast an alle Insta-User die noch nicht geantwortet haben
app.post('/mindset-admin-blast-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const callerUid = String(req.body.callerUid || '');
    if (!callerUid || !(istAdminId(callerUid) || String(d.users[callerUid]?.role||'').includes('Admin'))) return res.json({ ok:false, error:'Kein Admin' });
    const ms = d.mindsetStories;
    const targets = Object.keys(d.users).filter(uid => {
        const u = d.users[uid];
        if (!u || !u.instagram || u.isSystem) return false;
        if (istAdminId(uid)) return false;
        if (ms.waitlist[uid] || ms.rejected[uid] || ms.done[uid]) return false;
        return true;
    });
    // In-App DMs sind synchron — alle auf einmal pushen.
    let sent = 0;
    for (const uid of targets) {
        try { await sendMindsetInviteDM(uid); sent++; } catch(e) {}
    }
    speichern();
    res.json({ ok:true, queued: targets.length, sent });
});

// POST Admin: User von done zurück auf waitlist verschieben
app.post('/mindset-admin-restore-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const callerUid = String(req.body.callerUid || '');
    if (!callerUid || !(istAdminId(callerUid) || String(d.users[callerUid]?.role||'').includes('Admin'))) return res.json({ ok:false, error:'Kein Admin' });
    const targetUid = String(req.body.targetUid || '');
    if (!d.mindsetStories.done[targetUid]) return res.json({ ok:false, error:'User nicht in Erledigt-Liste' });
    // Falls Restore-Target diese Woche der Pick ist: auch weeklyState zurücksetzen, sonst
    // bleibt das pickedUid stale und UI zeigt "DIESE WOCHE" auf einen User der jetzt
    // wieder auf der Warteliste steht.
    if (d.mindsetStories.weeklyState?.pickedUid === targetUid) {
        d.mindsetStories.weeklyState = { week: d.mindsetStories.weeklyState.week, pickedUid: null, pickedAt: null, locked: false };
    }
    delete d.mindsetStories.done[targetUid];
    d.mindsetStories.waitlist[targetUid] = { joinedAt: Date.now(), lastChangedAt: Date.now() };
    speichern();
    res.json({ ok:true });
});

// ================================
// DASHBOARD API ENDPOINTS
// ================================

app.get('/reset-user', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = req.query.id;
    if (d.users[uid]) {
        d.users[uid].xp=0; d.users[uid].level=1; d.users[uid].role=badge(0);
        speichern();
        await dmUser(uid, '♻️ *XP zurückgesetzt*\n\nEin Admin hat deinen XP-Stand auf 0 zurückgesetzt.', { parse_mode: 'Markdown' });
    }
    res.json({ ok: true });
});

app.get('/remove-warn', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = req.query.id;
    if (d.users[uid]) {
        d.users[uid].warnings = 0;
        speichern();
        await dmUser(uid, '✅ *Verwarnungen entfernt*\n\nEin Admin hat alle deine Verwarnungen gelöscht. Warns: 0/5', { parse_mode: 'Markdown' });
    }
    res.json({ ok: true });
});

app.get('/add-warn', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = req.query.id;
    if (d.users[uid]) {
        d.users[uid].warnings = (d.users[uid].warnings||0)+1;
        speichern();
        await dmUser(uid, '⚠️ *Verwarnung!*\nWarn: ' + d.users[uid].warnings + '/5', { parse_mode: 'Markdown' });
    }
    res.json({ ok: true });
});

app.get('/remove-xp', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = req.query.id;
    const amount = parseInt(req.query.amount)||0;
    if (d.users[uid] && amount > 0) {
        const alteBadge = d.users[uid].role;
        d.users[uid].xp = Math.max(0, (d.users[uid].xp||0)-amount);
        d.users[uid].level = level(d.users[uid].xp);
        d.users[uid].role = badge(d.users[uid].xp);
        speichern();
        const badgeChange = alteBadge !== d.users[uid].role ? `\n📉 Badge: ${alteBadge} → ${d.users[uid].role}` : '';
        await dmUser(uid, `📉 *XP-Abzug*\n\nEin Admin hat dir −${amount} XP abgezogen.\n⭐ Aktuell: ${d.users[uid].xp} XP${badgeChange}`, { parse_mode: 'Markdown' });
    }
    res.json({ ok: true });
});

app.get('/give-bonus', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = req.query.id;
    if (d.users[uid]) {
        if (!d.bonusLinks[uid]) d.bonusLinks[uid] = 0;
        d.bonusLinks[uid]++;
        speichern();
        await dmUser(uid, '🎁 *Extra-Link erhalten!*', { parse_mode: 'Markdown' });
    }
    res.json({ ok: true });
});

app.get('/delete-link', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const msgId = req.query.id;
    if (d.links[msgId]) {
        const link = d.links[msgId];
        const heuteStr = new Date().toDateString();
        const isToday = link.timestamp && new Date(link.timestamp).toDateString() === heuteStr;

        // 0. XP/Daily-Counter zurückrechnen (Like = 5 XP, Post = 1 XP).
        try {
            const likers = Array.from(link.likes instanceof Set ? link.likes : (Array.isArray(link.likes) ? link.likes : []));
            for (const lUid of likers) {
                if (!lUid || lUid === CREATORBOOST_UID || istAdminId(lUid)) continue;
                const lu = d.users[lUid];
                if (!lu) continue;
                lu.xp = Math.max(0, (lu.xp||0) - 5);
                lu.level = level(lu.xp); lu.role = badge(lu.xp);
                lu.totalLikes = Math.max(0, (lu.totalLikes||0) - 1);
                if (isToday) {
                    if (d.dailyXP) d.dailyXP[lUid] = Math.max(0, (d.dailyXP[lUid]||0) - 5);
                    if (d.missionen?.[lUid]?.date === heuteStr) {
                        d.missionen[lUid].likesGegeben = Math.max(0, (d.missionen[lUid].likesGegeben||0) - 1);
                    }
                }
                if (d.weeklyXP) d.weeklyXP[lUid] = Math.max(0, (d.weeklyXP[lUid]||0) - 5);
            }
            // Poster: -1 XP + -1 Link-Count (war beim Posten via xpAddMitDaily(uid, 1) gegeben).
            const posterUid = String(link.user_id||'');
            if (posterUid && d.users[posterUid] && !istAdminId(posterUid)) {
                const pu = d.users[posterUid];
                pu.xp = Math.max(0, (pu.xp||0) - 1);
                pu.level = level(pu.xp); pu.role = badge(pu.xp);
                pu.links = Math.max(0, (pu.links||0) - 1);
                if (isToday && d.dailyXP) d.dailyXP[posterUid] = Math.max(0, (d.dailyXP[posterUid]||0) - 1);
                if (d.weeklyXP) d.weeklyXP[posterUid] = Math.max(0, (d.weeklyXP[posterUid]||0) - 1);
            }
        } catch(e) { console.log('[DELETE-LINK] XP-Rollback Fehler:', e.message); }

        // 1. Telegram-Nachricht in der Link-Gruppe löschen (sowohl Original-Msg als auch Counter-Msg).
        try { if (link.chat_id && link.counter_msg_id) await bot.telegram.deleteMessage(link.chat_id, link.counter_msg_id).catch(()=>{}); } catch(e){}
        try { if (link.chat_id && msgId && /^\d+$/.test(String(msgId))) await bot.telegram.deleteMessage(link.chat_id, Number(msgId)).catch(()=>{}); } catch(e){}
        // 2. Counter-Mapping aus dmNachrichten räumen.
        if (d.dmNachrichten) delete d.dmNachrichten[String(link.counter_msg_id)];
        // 3. Comments zum Link löschen (auch unter counter_msg_id Schlüssel).
        if (d.comments) {
            delete d.comments[msgId];
            if (link.counter_msg_id) delete d.comments[String(link.counter_msg_id)];
        }
        // 4. Tracker/Counter-Referenzen aufräumen falls vorhanden.
        if (d.likerNames) delete d.likerNames[msgId];
        // 5. Aus pinnedEngages entfernen falls dort referenziert.
        if (d.pinnedEngages) {
            for (const k of Object.keys(d.pinnedEngages)) {
                if (String(d.pinnedEngages[k]?.linkId||'') === String(msgId)) delete d.pinnedEngages[k];
            }
        }
        // 6. Den Link selbst löschen.
        delete d.links[msgId];
        speichern();
        console.log('[DELETE-LINK] Link', msgId, 'komplett gelöscht (TG + Comments + DMs + XP-Rollback)');
    }
    res.json({ ok: true });
});

app.get('/ban-user', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = req.query.id;
    if (d.users[uid]) {
        // Sub-Account hat keine Telegram-Identität → "Ban" macht keinen Sinn.
        // Stattdessen: Sub komplett löschen, Parent-Verbindung räumen.
        if (isSubAccount(uid)) {
            const parentUid = String(d.users[uid].parent_uid);
            delete d.users[uid];
            if (d.users[parentUid]) delete d.users[parentUid].subUid;
            for (const u of Object.values(d.users||{})) {
                if (Array.isArray(u.followers)) u.followers = u.followers.filter(x => String(x) !== uid);
                if (Array.isArray(u.following)) u.following = u.following.filter(x => String(x) !== uid);
            }
            if (d.dailyXP) delete d.dailyXP[uid];
            if (d.weeklyXP) delete d.weeklyXP[uid];
            speichern();
            return res.json({ ok: true, action: 'sub-deleted' });
        }
        // DM ZUERST schicken, danach bannen — nach dem Ban kann der Bot dem User nichts mehr senden.
        await dmUser(uid, '🚫 *Du wurdest gebannt*\n\nEin Admin hat dich aus der CreatorX-Community entfernt.', { parse_mode: 'Markdown' });
        try {
            for (const chatId of [GROUP_A_ID, GROUP_B_ID]) {
                if (chatId) await bot.telegram.banChatMember(chatId, Number(uid)).catch(()=>{});
            }
        } catch(e) {}
    }
    res.json({ ok: true });
});

app.post('/send-dm-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { text, uid } = req.body || {};
    if (!text) return res.json({ ok: false });
    const adminButton = { inline_keyboard: [[{ text: '💬 Admin antworten', url: 'https://t.me/mindsetstories' }]] };
    if (uid) {
        // DM an einzelnen User
        try { await bot.telegram.sendMessage(Number(uid), '📢 *Admin:*\n\n' + text, { parse_mode: 'Markdown', reply_markup: adminButton }); } catch(e) {}
    } else {
        // DM an alle
        let ok = 0;
        for (const [id, u] of Object.entries(d.users)) {
            if (!u.started || u.parent_uid) continue;
            try { await bot.telegram.sendMessage(Number(id), '📢 *Admin:*\n\n' + text, { parse_mode: 'Markdown', reply_markup: adminButton }); ok++; await new Promise(r=>setTimeout(r,200)); } catch(e) {}
        }
    }
    res.json({ ok: true });
});

app.post('/create-xp-event-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { multiplier, start, end } = req.body || {};
    if (!multiplier || !end) return res.json({ ok: false });
    d.xpEvent = { aktiv: false, multiplier, start: start||Date.now(), end, announced: false };
    speichern();
    res.json({ ok: true });
});

app.get('/stop-xp-event', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    d.xpEvent = { aktiv: false, multiplier: 1, start: null, end: null, announced: false };
    speichern();
    res.json({ ok: true });
});

app.get('/manual-backup-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    await backup();
    res.json({ ok: true });
});

// ─── Sub-Account-Wiederherstellung aus Backup ────────────────────────────────
// Listet alle Backup-Dateien auf (datum + #subs darin).
app.get('/list-backups', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    try {
        const dir = require('path').dirname(DATA_FILE);
        const base = require('path').basename(DATA_FILE).replace('.json', '');
        const files = fs.readdirSync(dir)
            .filter(f => f.startsWith(base + '_backup_') && f.endsWith('.json'))
            .sort()
            .reverse();
        const out = files.map(f => {
            try {
                const full = require('path').join(dir, f);
                const stat = fs.statSync(full);
                const data = JSON.parse(fs.readFileSync(full, 'utf8'));
                const subs = Object.entries(data.users || {}).filter(([,u]) => u && u.parent_uid).length;
                const users = Object.keys(data.users || {}).length;
                return { file: f, mtime: stat.mtime.toISOString(), users, subs };
            } catch(e) { return { file: f, error: e.message }; }
        });
        res.json({ ok: true, backups: out });
    } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Stellt nur die fehlenden Sub-Accounts aus einem Backup wieder her — überschreibt
// nichts an aktuellen Daten. Query-Param ?date=2026-05-09 (default = heute).
// Optional ?dry=1 → zeigt nur was wiederhergestellt würde, ohne zu schreiben.
app.get('/restore-subs-only', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    try {
        const dryRun = req.query.dry === '1';
        const today = new Date().toISOString().slice(0, 10);
        const date = String(req.query.date || today);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ ok: false, error: 'date format YYYY-MM-DD' });
        const backupFile = DATA_FILE.replace('.json', '_backup_' + date + '.json');
        if (!fs.existsSync(backupFile)) {
            return res.status(404).json({ ok: false, error: 'Backup-Datei nicht gefunden: ' + backupFile });
        }
        const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
        const restored = [];
        const skipped = [];
        const orphaned = [];
        for (const [uid, u] of Object.entries(backup.users || {})) {
            if (!u || !u.parent_uid) continue; // nur Subs
            if (d.users[uid]) {
                skipped.push({ sub_uid: uid, reason: 'sub already exists in current data' });
                continue;
            }
            const parentUid = String(u.parent_uid);
            if (!d.users[parentUid]) {
                orphaned.push({ sub_uid: uid, parent_uid: parentUid, reason: 'parent missing — sub kann nicht relinkt werden' });
                continue;
            }
            if (!dryRun) {
                d.users[uid] = u;
                d.users[parentUid].subUid = uid;
            }
            restored.push({ sub_uid: uid, parent_uid: parentUid, name: u.name, spitzname: u.spitzname || null, xp: u.xp || 0 });
        }
        if (!dryRun && restored.length) speichern();
        res.json({ ok: true, dryRun, fromBackup: backupFile, restored: restored.length, skipped: skipped.length, orphaned: orphaned.length, details: { restored, skipped, orphaned } });
    } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/add-xp', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = req.query.id;
    const amount = parseInt(req.query.amount)||0;
    if (d.users[uid] && amount > 0) {
        // Admin-XP: add to total only, not to daily/weekly rankings
        const u = d.users[uid];
        let finalAmount = amount;
        if (d.xpEvent?.aktiv && d.xpEvent.multiplier > 1) finalAmount = Math.round(amount * d.xpEvent.multiplier);
        u.xp = (u.xp || 0) + finalAmount;
        u.level = level(u.xp);
        u.role = badge(u.xp);
        speichern();
        await dmUser(uid, `🎁 *Bonus-XP erhalten!*\n\nEin Admin hat dir +${finalAmount} XP gutgeschrieben.\n⭐ Aktuell: ${u.xp} XP`, { parse_mode: 'Markdown' });
    }
    res.json({ ok: true });
});

function _reasonLabel(r) {
    if (r === 'roulette') return '🎡 Roulette';
    if (r === 'daily-bonus') return '🎁 Daily Bonus';
    if (r === 'gewinnspiel') return '🏆 Gewinnspiel';
    if (r === 'admin') return '⚙️ Admin';
    return '🎁';
}

app.post('/add-xp', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const amount = Number(req.body && req.body.amount);
    const noRanking = req.body?.noRanking === true;
    const reason = req.body?.reason || '';
    const u = d.users[uid];
    if (!uid || !u) return res.status(404).json({ ok: false, error: 'User nicht gefunden' });
    if (!Number.isFinite(amount)) return res.status(400).json({ ok: false, error: 'amount erforderlich' });
    u.xp = (u.xp || 0) + amount;
    if (u.xp < 0) u.xp = 0;
    u.level = level(u.xp);
    u.role = badge(u.xp);
    if (!noRanking) {
        if (!d.weeklyXP) d.weeklyXP = {};
        d.weeklyXP[uid] = Math.max(0, (d.weeklyXP[uid] || 0) + amount);
    }
    speichern();
    if (amount > 0) {
        try { await dmUser(uid, `✨ *+${amount} XP*\n\n${_reasonLabel(reason)}\n⭐ Aktuell: ${u.xp} XP`, { parse_mode:'Markdown' }); } catch(e) {}
    }
    res.json({ ok: true, newXp: u.xp });
});

// Bewusste Verkleinerung: amount darf positiv (= subtract) oder explizit negativ (Legacy) sein.
app.post('/remove-xp', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const raw = Number(req.body && req.body.amount);
    const reason = req.body?.reason || '';
    const u = d.users[uid];
    if (!uid || !u) return res.status(404).json({ ok: false, error: 'User nicht gefunden' });
    if (!Number.isFinite(raw)) return res.status(400).json({ ok: false, error: 'amount erforderlich' });
    const amount = Math.abs(raw);
    u.xp = Math.max(0, (u.xp||0) - amount);
    u.level = level(u.xp);
    u.role = badge(u.xp);
    if (!d.weeklyXP) d.weeklyXP = {};
    d.weeklyXP[uid] = Math.max(0, (d.weeklyXP[uid] || 0) - amount);
    speichern();
    try { await dmUser(uid, `📉 *−${amount} XP*\n\n${_reasonLabel(reason)}\n⭐ Aktuell: ${u.xp} XP`, { parse_mode:'Markdown' }); } catch(e) {}
    res.json({ ok: true, newXp: u.xp });
});

// ══════════════════════════════════════════════════════════════════════
//  POST-BONUS EVENTS (flat bonus per link-post während Event-Zeit)
// ══════════════════════════════════════════════════════════════════════
//   d.xpEvent       = { active, bonusPerPost, end, label?, type:'xp' }
//                     LEGACY: { aktiv, multiplier, start, end } — bleibt parallel.
//                     bonusPerPost > 0 → wird beim Link-Post addiert.
//   d.diamondEvent  = { active, bonusPerPost, end, label? }
//   applyPostBonus(uid) wird bei jedem App-Link-Post aufgerufen.
function applyPostBonus(uid, userName) {
    const out = { xp: 0, diamonds: 0, events: [] };
    if (istAdminId(uid)) return out;
    const now = Date.now();
    // XP Flat-Bonus
    if (d.xpEvent?.bonusPerPost && d.xpEvent.bonusPerPost > 0 && d.xpEvent.end && now < d.xpEvent.end) {
        xpAdd(uid, d.xpEvent.bonusPerPost, userName);
        out.xp = d.xpEvent.bonusPerPost;
        out.events.push({type:'xp', amount: d.xpEvent.bonusPerPost, label: d.xpEvent.label||''});
    } else if (d.xpEvent?.bonusPerPost && d.xpEvent.end && now >= d.xpEvent.end) {
        // Event abgelaufen → clearen
        d.xpEvent.bonusPerPost = 0;
        d.xpEvent.end = null;
    }
    // Diamond Flat-Bonus
    if (d.diamondEvent?.bonusPerPost && d.diamondEvent.bonusPerPost > 0 && d.diamondEvent.end && now < d.diamondEvent.end) {
        addDiamond(uid, d.diamondEvent.bonusPerPost);
        out.diamonds = d.diamondEvent.bonusPerPost;
        out.events.push({type:'diamond', amount: d.diamondEvent.bonusPerPost, label: d.diamondEvent.label||''});
    } else if (d.diamondEvent?.bonusPerPost && d.diamondEvent.end && now >= d.diamondEvent.end) {
        d.diamondEvent.bonusPerPost = 0;
        d.diamondEvent.end = null;
    }
    return out;
}

// Like-Bonus: gilt für JEDEN Like (auch alte Links) während Event-Zeit.
// User-Wunsch: Diamond-Event soll für jeden Like gelten, nicht nur eigene Posts.
function applyLikeBonus(uid, userName) {
    const out = { xp: 0, diamonds: 0, events: [] };
    if (istAdminId(uid)) return out;
    const now = Date.now();
    if (d.xpEvent?.bonusPerPost && d.xpEvent.bonusPerPost > 0 && d.xpEvent.end && now < d.xpEvent.end) {
        xpAdd(uid, d.xpEvent.bonusPerPost, userName);
        out.xp = d.xpEvent.bonusPerPost;
        out.events.push({type:'xp', amount: d.xpEvent.bonusPerPost});
    }
    if (d.diamondEvent?.bonusPerPost && d.diamondEvent.bonusPerPost > 0 && d.diamondEvent.end && now < d.diamondEvent.end) {
        addDiamond(uid, d.diamondEvent.bonusPerPost);
        out.diamonds = d.diamondEvent.bonusPerPost;
        out.events.push({type:'diamond', amount: d.diamondEvent.bonusPerPost});
    }
    return out;
}

// Status der aktiven Events — wird von der App im Feed-Banner abgefragt.
app.get('/events-status-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const now = Date.now();
    const out = { events: [] };
    // XP-Event: %-Multiplikator pro Like (Standard-Modus)
    if (d.xpEvent?.aktiv && d.xpEvent.multiplier > 1 && d.xpEvent.end && now < d.xpEvent.end) {
        const pct = d.xpEvent.bonusPercent || Math.round((d.xpEvent.multiplier - 1) * 100);
        out.events.push({
            type: 'xp',
            mode: 'percent',
            bonusPercent: pct,
            multiplier: d.xpEvent.multiplier,
            amount: pct,
            label: d.xpEvent.label || ('+' + pct + '% XP pro Like'),
            end: d.xpEvent.end,
            remainingMs: d.xpEvent.end - now,
        });
    } else if (d.xpEvent?.bonusPerPost > 0 && d.xpEvent.end && now < d.xpEvent.end) {
        // Legacy: alter flat-XP-pro-Post Modus
        out.events.push({
            type: 'xp',
            mode: 'flat',
            amount: d.xpEvent.bonusPerPost,
            label: d.xpEvent.label || ('+' + d.xpEvent.bonusPerPost + ' XP pro Post'),
            end: d.xpEvent.end,
            remainingMs: d.xpEvent.end - now,
        });
    }
    if (d.diamondEvent?.bonusPerPost > 0 && d.diamondEvent.end && now < d.diamondEvent.end) {
        out.events.push({
            type: 'diamond',
            amount: d.diamondEvent.bonusPerPost,
            label: d.diamondEvent.label || ('+' + d.diamondEvent.bonusPerPost + ' 💎 pro Post'),
            end: d.diamondEvent.end,
            remainingMs: d.diamondEvent.end - now,
        });
    }
    res.json({ ok:true, ...out });
});

// Start XP Post-Bonus-Event (flat amount per post für Dauer X)
app.post('/admin-start-xp-event-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    // amount = Prozent-Bonus pro Like, z.B. 100 → +100% → 2× XP
    const amount = parseInt(req.body?.amount, 10);
    const durationMs = parseInt(req.body?.durationMs, 10);
    const label = String(req.body?.label || '').slice(0, 60);
    if (!Number.isFinite(amount) || amount <= 0) return res.json({ ok:false, error:'amount muss > 0 sein' });
    if (!Number.isFinite(durationMs) || durationMs <= 0) return res.json({ ok:false, error:'durationMs muss > 0 sein' });
    if (durationMs > 7*24*3600*1000) return res.json({ ok:false, error:'Max 7 Tage' });
    const multiplier = 1 + (amount / 100);  // 100% → 2x, 50% → 1.5x
    d.xpEvent = {
        aktiv: true,
        multiplier,
        bonusPercent: amount,
        bonusPerPost: 0,  // alten Flat-Modus deaktivieren
        end: Date.now() + durationMs,
        label: label || ('+' + amount + '% XP pro Like'),
        startedAt: Date.now(),
    };
    speichern();
    res.json({ ok:true, event: d.xpEvent });
});

// Start Diamond Post-Bonus-Event
app.post('/admin-start-diamond-event-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const amount = parseInt(req.body?.amount, 10);
    const durationMs = parseInt(req.body?.durationMs, 10);
    const label = String(req.body?.label || '').slice(0, 60);
    if (!Number.isFinite(amount) || amount <= 0) return res.json({ ok:false, error:'amount muss > 0 sein' });
    if (!Number.isFinite(durationMs) || durationMs <= 0) return res.json({ ok:false, error:'durationMs muss > 0 sein' });
    if (durationMs > 7*24*3600*1000) return res.json({ ok:false, error:'Max 7 Tage' });
    d.diamondEvent = {
        bonusPerPost: amount,
        end: Date.now() + durationMs,
        label: label || ('+' + amount + ' 💎 pro Post'),
        startedAt: Date.now(),
    };
    speichern();
    res.json({ ok:true, event: d.diamondEvent });
});

// Stop laufendes Event
app.post('/admin-stop-event-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const type = String(req.body?.type || '');
    if (type === 'xp') {
        if (d.xpEvent) { d.xpEvent.bonusPerPost = 0; d.xpEvent.end = null; d.xpEvent.aktiv = false; d.xpEvent.multiplier = 1; }
    } else if (type === 'diamond') {
        d.diamondEvent = { bonusPerPost: 0, end: null };
    } else {
        return res.json({ ok:false, error:'type muss xp oder diamond sein' });
    }
    speichern();
    res.json({ ok:true });
});

app.post('/add-warn', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const reason = req.body?.reason || '';
    const u = d.users[uid];
    if (!u) return res.status(404).json({ ok:false, error:'User nicht gefunden' });
    u.warnings = (u.warnings||0) + 1;
    speichern();
    try { await dmUser(uid, `⚠️ *Verwarnung!*\n\nWarn: ${u.warnings}/5${reason?'\n\nGrund: '+reason:''}`, { parse_mode:'Markdown' }); } catch(e) {}
    res.json({ ok:true, warnings: u.warnings });
});

app.post('/remove-warn', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const u = d.users[uid];
    if (!u) return res.status(404).json({ ok:false, error:'User nicht gefunden' });
    u.warnings = Math.max(0, (u.warnings||0) - 1);
    speichern();
    try { await dmUser(uid, `✅ *Verwarnung entfernt*\n\nWarn: ${u.warnings}/5`, { parse_mode:'Markdown' }); } catch(e) {}
    res.json({ ok:true, warnings: u.warnings });
});

app.post('/reset-user', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const u = d.users[uid];
    if (!u) return res.status(404).json({ ok:false, error:'User nicht gefunden' });
    u.xp = 0; u.level = 1; u.role = badge(0);
    if (d.dailyXP) delete d.dailyXP[uid];
    if (d.weeklyXP) delete d.weeklyXP[uid];
    speichern();
    try { await dmUser(uid, `♻️ *XP zurückgesetzt*\n\nEin Admin hat deinen XP-Stand auf 0 zurückgesetzt.`, { parse_mode:'Markdown' }); } catch(e) {}
    res.json({ ok:true, xp: 0 });
});

app.post('/ban-user-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const u = d.users[uid];
    if (!u) return res.status(404).json({ ok:false, error:'User nicht gefunden (UID: '+uid+')' });
    if (Array.isArray(d._adminIds) && d._adminIds.map(Number).includes(Number(uid))) {
        return res.status(400).json({ ok:false, error:'Admins können nicht gebannt werden' });
    }
    // Ban: User aus ALLEN Sichtbarkeits-Checks rausnehmen (Ranking, Suche, Top, Feeds).
    u.banned = true;
    u.bannedAt = Date.now();
    u.inGruppe = false;     // App-Ranking-Filter
    u.started = false;       // Missionen + alle anderen started-gates
    // Aus aktiven Counters/Maps entfernen damit Ranking sofort sauber ist.
    if (d.dailyXP)  delete d.dailyXP[uid];
    if (d.weeklyXP) delete d.weeklyXP[uid];
    if (d.bonusLinks) delete d.bonusLinks[uid];
    if (d.missionen) delete d.missionen[uid];
    if (d.wochenMissionen) delete d.wochenMissionen[uid];
    // Sessions terminieren — Force-Logout falls noch eingeloggt (App holt sich nach Reload neue Session)
    if (d.userSessions) delete d.userSessions[uid];
    // Eventuelle Sub-Accounts mit-bannen
    if (Array.isArray(d.users)) ; // noop guard
    for (const [otherUid, other] of Object.entries(d.users||{})) {
        if (other && other.parent_uid && String(other.parent_uid) === uid) {
            other.banned = true; other.bannedAt = Date.now(); other.inGruppe = false; other.started = false;
        }
    }
    speichern();
    try { await dmUser(uid, `🚫 *Du wurdest gebannt*\n\nEin Admin hat dich aus der Community entfernt.`, { parse_mode:'Markdown' }); } catch(e) {}
    res.json({ ok:true });
});

app.post('/unban-user-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const u = d.users[uid];
    if (!u) return res.status(404).json({ ok:false, error:'User nicht gefunden (UID: '+uid+')' });
    u.banned = false; delete u.bannedAt;
    u.started = true;
    if (u.email || true) u.inGruppe = true;
    // Sub-Accounts mit-entbannen
    for (const [otherUid, other] of Object.entries(d.users||{})) {
        if (other && other.parent_uid && String(other.parent_uid) === uid) {
            other.banned = false; delete other.bannedAt; other.inGruppe = true; other.started = true;
        }
    }
    speichern();
    try { await dmUser(uid, `✅ *Bann aufgehoben*\n\nDu bist wieder Teil der Community. Willkommen zurück!`, { parse_mode:'Markdown' }); } catch(e) {}
    res.json({ ok:true });
});

app.post('/send-dm-single-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.json({ ok:false, error:'Text fehlt' });
    if (text.length > 1500) return res.json({ ok:false, error:'Max 1500 Zeichen' });
    const u = d.users[uid];
    if (!u) return res.status(404).json({ ok:false, error:'User nicht gefunden' });
    try { await dmUser(uid, text, { parse_mode:'Markdown' }); } catch(e) {}
    res.json({ ok:true });
});

app.post('/send-dm-all-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.json({ ok:false, error:'Text fehlt' });
    if (text.length > 1500) return res.json({ ok:false, error:'Max 1500 Zeichen' });
    let sent = 0;
    for (const [uid, u] of Object.entries(d.users || {})) {
        if (!u || !u.started || u.banned || u.parent_uid) continue;
        if (Array.isArray(d._adminIds) && d._adminIds.map(Number).includes(Number(uid))) continue;
        try { await dmUser(uid, text, { parse_mode:'Markdown' }); sent++; } catch(e) {}
    }
    res.json({ ok:true, sent });
});

// Dashboard-Stats: online (App-Presence ≤ 5min), today/week landing visits, signup-source breakdown, top stats.
// Debug: rohe Funnel-Daten (welche Events wann gespeichert wurden)
app.get('/admin-funnel-debug-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const funnel = d.funnel || { events: [], daily: {} };
    const allEvents = funnel.events || [];
    const last20 = allEvents.slice(-20).reverse().map(e => ({
        event: e.event,
        ts: e.ts,
        date: new Date(e.ts).toISOString(),
        meta: e.meta || {},
    }));
    // Welche Event-Namen kommen überhaupt vor?
    const eventCounts = {};
    for (const e of allEvents) eventCounts[e.event] = (eventCounts[e.event]||0) + 1;
    res.json({
        ok: true,
        totalEvents: allEvents.length,
        funnelExists: !!d.funnel,
        eventCounts,
        last20Events: last20,
        dailyKeys: Object.keys(funnel.daily || {}).sort(),
        dailyToday: funnel.daily?.[new Date().toISOString().slice(0,10)] || {},
        dailyBerlinToday: funnel.daily?.[(()=>{const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());return p.find(x=>x.type==='year').value+'-'+p.find(x=>x.type==='month').value+'-'+p.find(x=>x.type==='day').value;})()] || {},
        nowUtc: new Date().toISOString(),
        nowBerlin: new Date().toLocaleString('de-DE',{timeZone:'Europe/Berlin'}),
    });
});

// Test: fire a synthetic event so we can verify tracking pipeline works
app.post('/admin-funnel-test-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const evt = String(req.body?.event || 'test-event');
    trackFunnel(evt, { test: true, ts: Date.now() });
    speichern();
    res.json({ ok:true, event: evt, totalEvents: (d.funnel?.events||[]).length });
});

app.get('/admin-stats-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const now = Date.now();
    const ONLINE_THRESHOLD = 5 * 60 * 1000;
    let online = 0, activeToday = 0, app24h = 0, app7d = 0, app30d = 0;
    const sources = { telegram: 0, email: 0 };
    let banned = 0;
    // Berlin-Tagesanfang berechnen (für "heute online")
    const todayStartBerlin = (() => {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Berlin', year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false }).formatToParts(new Date());
        const get = (t) => parts.find(p=>p.type===t).value;
        // ISO-String mit Berlin-Offset (+01:00 oder +02:00 je nach DST)
        const offsetMin = -new Date().getTimezoneOffset(); // Berlin liegt = TZ; aber wir setzen TZ schon auf Berlin
        return new Date(get('year')+'-'+get('month')+'-'+get('day')+'T00:00:00').getTime();
    })();
    for (const u of Object.values(d.users||{})) {
        if (!u) continue;
        // Sub-accounts haben eigene appLastSeen (eigener Login in der App) — also
        // zählen sie für Online/Active. Erst beim Haupt-Account-Count (newUsers
        // u.ä. weiter unten) wird auf parent_uid gefiltert.
        if (u.appLastSeen) {
            const age = now - u.appLastSeen;
            if (age <= ONLINE_THRESHOLD) online++;
            if (u.appLastSeen >= todayStartBerlin) activeToday++;
            if (age <= 24*60*60*1000) app24h++;
            if (age <= 7*24*60*60*1000) app7d++;
            if (age <= 30*24*60*60*1000) app30d++;
        }
        if (!u.parent_uid) {
            const src = u.signupSource || 'telegram';
            sources[src] = (sources[src]||0) + 1;
            if (u.banned) banned++;
        }
    }
    // Activity-Aggregat heute vs gestern (XP, Likes, Links)
    const todayStrLocal = new Date().toDateString();
    const yesterdayStrLocal = new Date(Date.now() - 86400000).toDateString();
    const xpTodaySum = Object.values(d.dailyXP||{}).reduce((s,v)=>s+(Number(v)||0), 0);
    const xpYesterdaySum = Object.values(d.gesternDailyXP||{}).reduce((s,v)=>s+(Number(v)||0), 0);
    let linksToday = 0, linksYesterday = 0, likesToday = 0, likesYesterday = 0;
    for (const l of Object.values(d.links||{})) {
        if (!l || !l.timestamp) continue;
        const lDay = new Date(l.timestamp).toDateString();
        const likeCount = l.likes ? (l.likes.size !== undefined ? l.likes.size : (Array.isArray(l.likes) ? l.likes.length : 0)) : 0;
        if (lDay === todayStrLocal) linksToday++;
        else if (lDay === yesterdayStrLocal) linksYesterday++;
        // likesYesterday: Likes auf gestern-geposteten Links (Proxy für "gestern getätigte Likes",
        // da die meisten Likes am selben Tag wie der Post passieren).
        if (lDay === yesterdayStrLocal) likesYesterday += likeCount;
    }
    // likesToday: echter Heute-Event-Count = Σ mission.likesGegeben über alle User
    // deren mission.date == heute. Das zählt jeden Like-Event heute (auch auf gestrige Links).
    const heuteToString = new Date().toDateString();
    for (const m of Object.values(d.missionen||{})) {
        if (m && m.date === heuteToString) likesToday += (Number(m.likesGegeben)||0);
    }
    const todayStr = new Date().toISOString().slice(0,10);
    const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0,10);
    const daily = d.funnel?.daily || {};
    const last7Days = [];
    for (let i = 6; i >= 0; i--) {
        const day = new Date(Date.now() - i*86400000).toISOString().slice(0,10);
        last7Days.push({ day, events: daily[day] || {} });
    }
    const last30Days = [];
    for (let i = 29; i >= 0; i--) {
        const day = new Date(Date.now() - i*86400000).toISOString().slice(0,10);
        last30Days.push({ day, events: daily[day] || {} });
    }
    const last7DaysAggregated = {};
    for (const d2 of last7Days) {
        for (const [evt, count] of Object.entries(d2.events)) {
            last7DaysAggregated[evt] = (last7DaysAggregated[evt]||0) + count;
        }
    }
    // Heute Aggregat
    const today = daily[todayStr] || {};
    const yesterday = daily[yesterdayStr] || {};
    // Last-7-Days Funnel-Aggregat (für Conversion-Berechnung)
    const f7 = last7DaysAggregated;
    const conversion = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
    // Letzte 30 Tage neu registrierte User
    const last30dCutoff = now - 30*24*60*60*1000;
    const last7dCutoff = now - 7*24*60*60*1000;
    let newUsers30d = 0, newUsers7d = 0, newUsersToday = 0;
    const recentSignups = [];
    for (const [uid, u] of Object.entries(d.users||{})) {
        if (!u || u.parent_uid) continue;
        const j = u.joinDate || 0;
        if (j >= last30dCutoff) {
            newUsers30d++;
            if (j >= last7dCutoff) newUsers7d++;
            if (new Date(j).toISOString().slice(0,10) === todayStr) newUsersToday++;
            recentSignups.push({
                uid: String(uid),
                name: u.spitzname || u.name || ('User '+uid),
                email: u.email||'',
                instagram: u.instagram||'',
                signupSource: u.signupSource||'telegram',
                joinDate: j,
                emailConfirmed: !!u.emailConfirmedAt && !u.pendingEmail,
                hasInstagram: !!u.instagram,
            });
        }
    }
    recentSignups.sort((a,b)=>b.joinDate-a.joinDate);

    // Top Creators heute (sortiert nach heutigem XP-Gewinn)
    const topXpToday = Object.entries(d.dailyXP||{})
        .filter(([uid, xp]) => xp > 0 && d.users?.[uid] && !d.users[uid].banned)
        .map(([uid, xp]) => {
            const u = d.users[uid] || {};
            return {
                uid: String(uid),
                name: u.spitzname || u.name || ('User '+uid),
                instagram: u.instagram || '',
                role: u.role || '',
                xpGained: Number(xp)||0,
                xpTotal: u.xp || 0,
                isSub: !!u.parent_uid,
            };
        })
        .sort((a,b) => b.xpGained - a.xpGained)
        .slice(0, 10);

    // Per-Source Funnel (last 7d) — Telegram vs Email
    let tgSignups7d = 0, emSignups7d = 0;
    for (const u of Object.values(d.users||{})) {
        if (!u || u.parent_uid) continue;
        if ((u.joinDate||0) < last7dCutoff) continue;
        if (u.signupSource === 'email') emSignups7d++;
        else tgSignups7d++;
    }
    // Login-Erfolge per source (rough: kein per-source-Tracking in funnel events,
    // wir nehmen den Anteil signupSource der heute-aktiven User)
    let tgActive7d = 0, emActive7d = 0;
    for (const u of Object.values(d.users||{})) {
        if (!u) continue;
        if (!u.appLastSeen || (now - u.appLastSeen) > 7*86400000) continue;
        if (u.signupSource === 'email') emActive7d++;
        else tgActive7d++;
    }
    const sourceFunnel = {
        telegram: { signups: tgSignups7d, active7d: tgActive7d, retentionPct: conversion(tgActive7d, tgSignups7d) },
        email: { signups: emSignups7d, active7d: emActive7d, retentionPct: conversion(emActive7d, emSignups7d) },
    };

    // Recent Activity Feed (letzte 20 Events aus d.funnel.events)
    const recentActivity = (d.funnel?.events || [])
        .slice(-30)
        .reverse()
        .slice(0, 20)
        .map(e => ({
            event: e.event,
            ts: e.ts,
            uid: e.meta?.uid || '',
            name: e.meta?.uid && d.users?.[e.meta.uid]
                ? (d.users[e.meta.uid].spitzname || d.users[e.meta.uid].name || 'User')
                : (e.meta?.email || 'anonym'),
        }));

    res.json({
        ok: true,
        online,
        activeToday,
        app24h,
        app7d,
        app30d,
        sources,
        banned,
        landingToday: today['landing-view']||0,
        landingYesterday: yesterday['landing-view']||0,
        signupViewToday: today['signup-view']||0,
        signupCompleteToday: today['signup-complete']||0,
        signupToday: (today['signup-complete']||0) + (today['signup']||0) + (today['email-signup']||0),
        loginSuccessToday: today['login-success']||0,
        emailSubmitToday: today['email-submit']||0,
        telegramClickToday: today['telegram-click']||0,
        ctaClickToday: today['landing-cta-click']||0,
        // Funnel-Conversion last 7 days
        funnel7d: {
            landing: f7['landing-view']||0,
            ctaClick: f7['landing-cta-click']||0,
            signupView: f7['signup-view']||0,
            signupComplete: f7['signup-complete']||0,
            loginSuccess: f7['login-success']||0,
            telegramClick: f7['telegram-click']||0,
            emailSubmit: f7['email-submit']||0,
            // Conversion Rates
            ctaPct: conversion(f7['landing-cta-click']||0, f7['landing-view']||0),
            signupViewPct: conversion(f7['signup-view']||0, f7['landing-view']||0),
            signupCompletePct: conversion(f7['signup-complete']||0, f7['signup-view']||0),
            loginRetentionPct: conversion(f7['login-success']||0, f7['signup-complete']||0),
        },
        newUsersToday, newUsers7d, newUsers30d,
        recentSignups: recentSignups.slice(0, 50),
        last7Days,
        last30Days,
        last7DaysAggregated,
        // Activity heute vs gestern
        xpToday: xpTodaySum,
        xpYesterday: xpYesterdaySum,
        likesToday,
        likesYesterday,
        linksToday,
        linksYesterday,
        // Pro-Cards
        topXpToday,
        sourceFunnel,
        recentActivity,
        totalUsers: Object.values(d.users||{}).filter(u => u && !u.parent_uid).length,
    });
});

app.post('/add-extra-link', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const reason = req.body?.reason || '';
    if (!uid || !d.users[uid]) return res.status(404).json({ ok: false, error: 'User nicht gefunden' });
    if (!d.bonusLinks) d.bonusLinks = {};
    d.bonusLinks[uid] = (d.bonusLinks[uid] || 0) + 1;
    speichern();
    try { await dmUser(uid, `🔗 *+1 Extra-Link*\n\n${_reasonLabel(reason)}\nVerfügbar: ${d.bonusLinks[uid]} Extra-Links`, { parse_mode:'Markdown' }); } catch(e) {}
    res.json({ ok: true });
});

// FIX: Posting-Logik prüft superlinkCredits (line ~260), nicht superlinks.
// Vorher: u.superlinks wurde gesetzt → Slot war nie einlösbar.
app.post('/add-superlink', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const reason = req.body?.reason || '';
    const u = d.users[uid];
    if (!uid || !u) return res.status(404).json({ ok: false, error: 'User nicht gefunden' });
    u.superlinkCredits = (u.superlinkCredits || 0) + 1;
    speichern();
    try { await dmUser(uid, `⚡ *+1 Superlink-Slot*\n\n${_reasonLabel(reason)}\nVerfügbar: ${u.superlinkCredits} Extra-Superlinks`, { parse_mode:'Markdown' }); } catch(e) {}
    res.json({ ok: true, superlinkCredits: u.superlinkCredits });
});

app.post('/add-diamonds', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const amount = Number(req.body && req.body.amount);
    const reason = req.body?.reason || '';
    const u = d.users[uid];
    if (!uid || !u) return res.status(404).json({ ok: false, error: 'User nicht gefunden' });
    if (!Number.isFinite(amount)) return res.status(400).json({ ok: false, error: 'amount erforderlich' });
    u.diamonds = (u.diamonds || 0) + amount;
    if (u.diamonds < 0) u.diamonds = 0;
    speichern();
    if (amount > 0) {
        try { await dmUser(uid, `💎 *+${amount} Diamant${amount!==1?'en':''}*\n\n${_reasonLabel(reason)}\nAktuell: ${u.diamonds} 💎`, { parse_mode:'Markdown' }); } catch(e) {}
    }
    res.json({ ok: true, newDiamonds: u.diamonds });
});

app.post('/remove-diamonds', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const raw = Number(req.body && req.body.amount);
    const reason = req.body?.reason || '';
    const u = d.users[uid];
    if (!uid || !u) return res.status(404).json({ ok: false, error: 'User nicht gefunden' });
    if (!Number.isFinite(raw)) return res.status(400).json({ ok: false, error: 'amount erforderlich' });
    const amount = Math.abs(raw);
    u.diamonds = Math.max(0, (u.diamonds||0) - amount);
    speichern();
    try { await dmUser(uid, `💎 *−${amount} Diamant${amount!==1?'en':''}*\n\n${_reasonLabel(reason)}\nAktuell: ${u.diamonds} 💎`, { parse_mode:'Markdown' }); } catch(e) {}
    res.json({ ok: true, newDiamonds: u.diamonds });
});

// User-Liste für App-Dashboard (Admin-only via App-side Check).
// Bewusst schmal: keine Sessions, keine Email-Tokens, keine Passwort-Hashes.
app.get('/admin-userlist-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const out = [];
    const adminIds = Array.isArray(d._adminIds) ? d._adminIds.map(Number) : [];
    // Listet ALLE User (auch Subs) damit Admin sie im Dashboard finden + linken kann.
    // isSub-Flag damit UI Sub-Accounts visuell unterscheiden kann.
    for (const [uid, u] of Object.entries(d.users||{})) {
        if (!u) continue;
        out.push({
            uid: String(uid),
            name: u.name||'',
            spitzname: u.spitzname||'',
            instagram: u.instagram||'',
            email: u.email||'',
            pendingEmail: u.pendingEmail||'',
            emailConfirmedAt: u.emailConfirmedAt||null,
            xp: u.xp||0,
            diamonds: u.diamonds||0,
            role: u.role||'',
            level: u.level||1,
            joinDate: u.joinDate||0,
            started: !!u.started,
            inGruppe: u.inGruppe!==false,
            likes: u.likes||0,
            totalLikes: u.totalLikes||0,
            links: u.links||0,
            bio: u.bio||'',
            nische: u.nische||'',
            signupSource: u.signupSource||'telegram',
            superlinkCredits: u.superlinkCredits||0,
            bonusLinks: d.bonusLinks?.[uid]||0,
            warnings: u.warnings||0,
            appLastSeen: u.appLastSeen||null,
            isAdmin: adminIds.includes(Number(uid)) || String(u.role||'').includes('Admin'),
            isSub: !!u.parent_uid,
            parentUid: u.parent_uid ? String(u.parent_uid) : null,
            banned: !!u.banned,
        });
    }
    res.json({ ok:true, users: out });
});

app.get('/reset-daily-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    d.dailyXP={}; d.tracker={}; d.counter={}; d.badgeTracker={};
    speichern();
    res.json({ ok: true });
});

app.all('/admin/fix-weekly-xp', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const input = String(req.body?.uid || req.query?.uid || '');
    const value = req.body?.value !== undefined ? Number(req.body.value) : (req.query?.value !== undefined ? Number(req.query.value) : null);
    if (!input) return res.status(400).json({ ok: false, error: 'uid erforderlich' });
    const uid = _findUser(input);
    if (!uid) return res.status(404).json({ ok: false, error: 'User nicht gefunden: ' + input });
    if (value === null || isNaN(value)) return res.status(400).json({ ok: false, error: 'value erforderlich (Zahl)' });
    const oldVal = (d.weeklyXP && d.weeklyXP[uid]) || 0;
    if (!d.weeklyXP) d.weeklyXP = {};
    d.weeklyXP[uid] = Math.max(0, value);
    speichern();
    const name = d.users[uid]?.spitzname || d.users[uid]?.name || uid;
    console.log('[FIX-WEEKLY-XP] ' + name + ' (' + uid + '): ' + oldVal + ' → ' + d.weeklyXP[uid]);
    res.json({ ok: true, uid, name, oldWeeklyXP: oldVal, newWeeklyXP: d.weeklyXP[uid], totalXP: d.users[uid]?.xp });
});


app.get('/remind-insta-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    let count = 0;
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started || u.parent_uid || (u.instagram && u.instagram.trim() !== '')) continue;
        try {
            await bot.telegram.sendMessage(Number(uid),
                '📸 *Hey ' + u.name + '!*\n\nDu hast noch keinen Instagram Account eingetragen.\n\nBitte trage deinen Instagram Namen ein!\n\n👉 Tippe: /setinsta deinname',
                { parse_mode: 'Markdown' }
            );
            count++;
            await new Promise(r => setTimeout(r, 200));
        } catch(e) {}
    }
    res.json({ ok: true, count });
});


app.get('/set-insta-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = req.query.id;
    const insta = req.query.insta;
    if (d.users[uid] && insta) {
        d.users[uid].instagram = insta.replace('@','').trim();
        speichern();
    }
    res.json({ ok: true });
});


// Bilder separat speichern
const BILDER_DIR = '/data';
function saveBild(uid, type, data) {
    try {
        const file = BILDER_DIR + '/bild_' + uid + '_' + type + '.txt';
        fs.writeFileSync(file, data);
        return '/bild/' + uid + '/' + type;
    } catch(e) { return data; }
}
function loadBild(uid, type) {
    try {
        const file = BILDER_DIR + '/bild_' + uid + '_' + type + '.txt';
        if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    } catch(e) {}
    return null;
}

app.post('/update-profile-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, bio, spitzname, banner, accentColor, profilePic } = req.body || {};
    if (d.users[uid]) {
        if (bio !== undefined) d.users[uid].bio = bio.slice(0,100);
        if (spitzname !== undefined) d.users[uid].spitzname = spitzname.slice(0,30);
        if (accentColor !== undefined) d.users[uid].accentColor = accentColor;
        if (req.body.nische !== undefined) d.users[uid].nische = req.body.nische.slice(0,50);
        if (req.body.website !== undefined) { d.users[uid].website = req.body.website.slice(0,100); console.log('[PROFILE] website gesetzt:', req.body.website); }
        if (req.body.tiktok !== undefined) d.users[uid].tiktok = req.body.tiktok.replace('@','').slice(0,50);
        if (req.body.youtube !== undefined) d.users[uid].youtube = req.body.youtube.replace('@','').slice(0,50);
        if (req.body.twitter !== undefined) d.users[uid].twitter = req.body.twitter.replace('@','').slice(0,50);
        if (req.body.instagram !== undefined) d.users[uid].instagram = String(req.body.instagram||'').replace(/^@/,'').replace(/[^a-zA-Z0-9._]/g,'').slice(0,50);
        if (req.body.email !== undefined) {
            const newEmail = String(req.body.email||'').toLowerCase().trim();
            if (newEmail === '') {
                delete d.users[uid].email;
                delete d.users[uid].pendingEmail;
            } else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail) && newEmail.length <= 200) {
                // Wenn unverändert → no-op
                if (String(d.users[uid].email||'').toLowerCase() === newEmail) {
                    delete d.users[uid].pendingEmail;
                } else {
                    // Eindeutigkeit prüfen — eine Email darf nur einem Account gehören.
                    const taken = Object.entries(d.users || {}).find(([oid, x]) =>
                        String(oid) !== String(uid) &&
                        (String(x.email||'').toLowerCase() === newEmail || String(x.pendingEmail||'').toLowerCase() === newEmail));
                    if (!taken) {
                        // Speichern als PENDING — wird erst nach Confirm zur echten email
                        d.users[uid].pendingEmail = newEmail;
                    }
                }
            }
        }
        // Direktes Setzen der bestätigten email (nach Confirm-Click — nur intern via Bridge)
        if (req.body.confirmEmail !== undefined && req.body.confirmEmail) {
            const conf = String(req.body.confirmEmail).toLowerCase().trim();
            d.users[uid].email = conf;
            d.users[uid].emailConfirmedAt = Date.now();
            delete d.users[uid].pendingEmail;
        }
        // Welcome-Briefing dismiss-flag (App-Modal beim ersten Login).
        if (req.body.appBriefingSeenV2 !== undefined) {
            d.users[uid].appBriefingSeenV2 = !!req.body.appBriefingSeenV2;
        }
        // Regeln-Akzeptanz-Timestamp (von Tour-Ende → Pflicht-Bestätigung)
        if (req.body.rulesAcceptedAt !== undefined) {
            const ts = Number(req.body.rulesAcceptedAt) || 0;
            if (ts > 0) d.users[uid].rulesAcceptedAt = ts;
        }
        // Bilder separat speichern
        if (banner !== undefined) {
            if (banner.startsWith('data:image')) {
                saveBild(uid, 'banner', banner);
                d.users[uid].banner = '/bild/' + uid + '/banner';
            } else {
                d.users[uid].banner = banner;
            }
        }
        if (profilePic !== undefined) {
            if (profilePic.startsWith('data:image')) {
                saveBild(uid, 'profilepic', profilePic);
                d.users[uid].profilePic = '/bild/' + uid + '/profilepic';
            } else {
                d.users[uid].profilePic = profilePic;
            }
        }
        speichern();
    }
    res.json({ ok: true });
});

// Bild Endpoint
app.get('/bild/:uid/:type', (req, res) => {
    const data = loadBild(req.params.uid, req.params.type);
    if (!data) return res.status(404).send('');
    const mime = data.split(';')[0].replace('data:','');
    const base64 = data.split(',')[1];
    res.writeHead(200, {'Content-Type': mime, 'Cache-Control': 'public, max-age=86400'});
    res.end(Buffer.from(base64, 'base64'));
});


app.post('/auth/code', (req, res) => {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Kein Code' });

    // Suche User mit diesem Code
    const found = Object.entries(d.users).find(([, u]) => u.appCode === code.toLowerCase().trim());
    if (!found) return res.status(401).json({ error: 'Ungültiger Code' });

    const [uid, u] = found;
    res.json({
        ok: true,
        uid,
        name: u.name,
        username: u.username,
        role: u.role,
        xp: u.xp
    });
});

// ─── Email-Passwort-Login (App-Bridge) ───────────────────────────────────────
// Hash mit PBKDF2 + 100k iter SHA-256 — keine ext. Dependencies, ausreichend
// für unsere Größenordnung (alternativ argon2/bcrypt).
function hashPasswordPBKDF2(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 64, 'sha256').toString('hex');
    return 'pbkdf2$100000$' + salt + '$' + hash;
}
function verifyPasswordPBKDF2(password, stored) {
    if (!stored || typeof stored !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iter = parseInt(parts[1], 10) || 100000;
    const salt = parts[2], hash = parts[3];
    if (!salt || !hash) return false;
    try {
        const compare = crypto.pbkdf2Sync(String(password), salt, iter, 64, 'sha256').toString('hex');
        return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(compare, 'hex'));
    } catch { return false; }
}

function authenticateEmailPassword(emailInput, passwordInput, opts = {}) {
    const email = String(emailInput || '').toLowerCase().trim();
    const password = String(passwordInput || '');
    if (!email || !password) return { status: 400, body: { ok: false, error: 'Email und Passwort erforderlich' } };
    const found = Object.entries(d.users || {}).find(([, u]) => String(u.email || '').toLowerCase() === email);
    if (!found) return { status: 401, body: { ok: false, error: 'Email oder Passwort falsch', notRegistered: true } };
    const [uid, u] = found;
    if (!u.password_hash) return { status: 401, body: { ok: false, error: 'noch kein Passwort gesetzt', noPassword: true } };
    if (!verifyPasswordPBKDF2(password, u.password_hash)) {
        return { status: 401, body: { ok: false, error: 'Email oder Passwort falsch' } };
    }
    u.appLastSeen = Date.now();
    u.appUser = true;
    speichernDebounced();
    const body = { ok: true, uid: String(uid), hasPassword: true };
    if (opts.includeRedirect) {
        const code = ensureAppCode(String(uid), u);
        body.redirect = '/auth/auto?code=' + encodeURIComponent(code) + '&redirect=' + encodeURIComponent('/feed');
    }
    return { status: 200, body };
}

// Setzt das Passwort für einen User. Bridge-Secret-geschützt.
app.post('/set-user-password', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, password } = req.body || {};
    if (!uid || !d.users[uid]) return res.status(404).json({ ok: false, error: 'User nicht gefunden' });
    const pw = String(password || '');
    if (pw === '') {
        delete d.users[uid].password_hash;
        speichern();
        return res.json({ ok: true, cleared: true });
    }
    if (pw.length < 6) return res.status(400).json({ ok: false, error: 'Passwort muss mindestens 6 Zeichen haben' });
    if (pw.length > 200) return res.status(400).json({ ok: false, error: 'Passwort zu lang' });
    d.users[uid].password_hash = hashPasswordPBKDF2(pw);
    speichern();
    res.json({ ok: true });
});

// Admin: reset password and generate a new one. Supports browser GET.
app.all('/admin/reset-password', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const input = String(req.body?.uid || req.query?.uid || '');
    if (!input) return res.status(400).json({ ok: false, error: 'uid erforderlich' });
    const uid = _findUser(input);
    if (!uid) return res.status(404).json({ ok: false, error: 'User nicht gefunden: ' + input });
    const u = d.users[uid];
    if (!u.email) return res.status(400).json({ ok: false, error: 'User hat keine Email' });
    const newPw = _generatePassword();
    u.password_hash = hashPasswordPBKDF2(newPw);
    speichern();
    try { bot.telegram.sendMessage(Number(uid), '🔐 Dein Passwort wurde zurückgesetzt!\n\nNeues Passwort: ' + newPw + '\n\nBitte ändere es nach dem Login in den Einstellungen.'); } catch(e) {}
    const name = u.spitzname || u.name || uid;
    console.log('[RESET-PW-API] ' + name + ' (' + u.email + ') — neues Passwort generiert');
    res.json({ ok: true, uid, name, email: u.email, newPassword: newPw });
});

// User self-service: request password reset by email. Returns new password
// directly (no email service needed). Also sends via Telegram DM if possible.
app.post('/api/auth/reset-password', (req, res) => {
    const email = String((req.body && req.body.email) || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ ok: false, error: 'Email erforderlich' });
    const found = Object.entries(d.users || {}).find(([, u]) => String(u.email || '').toLowerCase() === email);
    if (!found) return res.status(404).json({ ok: false, error: 'Kein Account mit dieser Email gefunden' });
    const [uid, u] = found;
    const newPw = _generatePassword();
    u.password_hash = hashPasswordPBKDF2(newPw);
    speichern();
    try { bot.telegram.sendMessage(Number(uid), '🔐 Dein Passwort wurde zurückgesetzt!\n\nNeues Passwort: ' + newPw + '\n\nBitte ändere es nach dem Login in den Einstellungen.'); } catch(e) {}
    console.log('[RESET-PW-SELF] ' + (u.spitzname || u.name) + ' (' + email + ') — neues Passwort generiert');
    res.json({ ok: true, newPassword: newPw, message: 'Dein neues Passwort wurde generiert. Falls du Telegram nutzt, wurde es dir auch per DM geschickt.' });
});

// Setzt einen vom User selbst gewählten appCode. Bridge-Secret-geschützt.
// Validiert: lowercase a-z 0-9 _ -, 4–30 chars, eindeutig.
app.post('/set-app-code-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '').trim();
    const raw = String((req.body && req.body.code) || '').toLowerCase().trim();
    if (!uid || !d.users[uid]) return res.status(404).json({ ok: false, error: 'User nicht gefunden' });
    if (!/^[a-z0-9_-]{4,30}$/.test(raw)) {
        return res.status(400).json({ ok: false, error: 'Code: 4–30 Zeichen, nur a–z, 0–9, _ oder -' });
    }
    // Reservierte Wörter blockieren (typische Routen / Verwechslungsgefahr).
    const reserved = new Set(['admin','root','system','api','login','logout','feed','auth','signup','register','help','test']);
    if (reserved.has(raw)) return res.status(400).json({ ok: false, error: 'Code reserviert — bitte anderen wählen' });
    // Eindeutigkeit
    const taken = Object.entries(d.users || {}).find(([oid, x]) => String(oid) !== uid && String(x.appCode||'').toLowerCase() === raw);
    if (taken) return res.status(409).json({ ok: false, error: 'Code schon vergeben — bitte anderen wählen' });
    d.users[uid].appCode = raw;
    d.users[uid].appCodeChosenAt = Date.now();
    speichern();
    res.json({ ok: true, code: raw });
});

// Email-Only Signup: erstellt einen neuen User-Account mit nur Email als Identifier.
// Wird vom App-Magic-Link-Flow aufgerufen wenn Email noch nicht existiert.
app.post('/create-email-user-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const email = String((req.body && req.body.email) || '').toLowerCase().trim();
    const password = String((req.body && req.body.password) || '');
    // Age-Gate (Play-Store + DSGVO Art. 8) — wenn FEATURE_AGE_GATE=1 ist, Pflicht.
    const ageConfirmedAt = Number((req.body && req.body.ageConfirmedAt) || 0);
    const termsAcceptedAt = Number((req.body && req.body.termsAcceptedAt) || 0);
    const termsVersion = String((req.body && req.body.termsVersion) || '').slice(0, 30);
    if (FEATURE_FLAGS.ageGate && (!ageConfirmedAt || !termsAcceptedAt)) {
        return res.status(400).json({ ok: false, error: 'Altersbestätigung (16+) und AGB/Datenschutz-Zustimmung erforderlich' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
        return res.status(400).json({ ok: false, error: 'Ungültige Email' });
    }
    // Doppelte Email blockieren — auch in pendingEmail
    const existing = Object.entries(d.users || {}).find(([, u]) =>
        String(u.email || '').toLowerCase() === email ||
        String(u.pendingEmail || '').toLowerCase() === email
    );
    if (existing) return res.json({ ok: true, uid: String(existing[0]), existed: true });
    // Passwort-Validierung wenn übergeben
    if (password && (password.length < 6 || password.length > 200)) {
        return res.status(400).json({ ok: false, error: 'Passwort muss 6–200 Zeichen lang sein' });
    }
    // Neue UID generieren — synthetisch (Date.now()), kollisionssicher
    let uid = String(Date.now());
    let attempts = 0;
    while (d.users[uid] && attempts++ < 50) uid = String(Date.now()) + Math.floor(Math.random() * 1000);
    if (d.users[uid]) return res.status(500).json({ ok: false, error: 'UID-Kollision' });
    // Email-Confirmation: wenn Flag an, generiere Token + lasse User unbestätigt.
    // App-Bot bekommt Token zurück und schickt Confirmation-Email.
    let emailConfirmToken = null;
    if (FEATURE_FLAGS.emailConfirmation) {
        emailConfirmToken = require('crypto').randomBytes(24).toString('hex');
    }
    d.users[uid] = {
        name: email.split('@')[0].slice(0, 30),
        username: null, instagram: null, bio: null, nische: null, spitzname: null,
        email: email,
        // Bei Flag ON: User ist 'pending' bis Klick auf Confirm-Link.
        // Bei Flag OFF: Auto-Confirm wie bisher (Backward-Compat).
        emailConfirmedAt: FEATURE_FLAGS.emailConfirmation ? null : Date.now(),
        emailConfirmToken: emailConfirmToken,
        emailConfirmTokenExp: emailConfirmToken ? (Date.now() + 7 * 24 * 60 * 60 * 1000) : null, // 7 Tage
        trophies: [], xp: 0, level: 1, warnings: 0, started: true, links: 0, likes: 0,
        role: '🆕 New', lastDaily: null, totalLikes: 0, chats: [], joinDate: Date.now(),
        inGruppe: true, diamonds: 0, projects: [], profileCompletionRewarded: false,
        inventory: [], activeRing: null, followers: [], following: [],
        appUser: true,
        appLastSeen: Date.now(),
        signupSource: 'email',
        // Audit-Trail für DSGVO Art. 8 + Play-Store-Compliance.
        ageConfirmedAt: ageConfirmedAt || null,
        termsAcceptedAt: termsAcceptedAt || null,
        termsVersion: termsVersion || null,
        blockedUsers: [],
    };
    if (password) {
        d.users[uid].password_hash = hashPasswordPBKDF2(password);
    }
    console.log('✅ Neuer Email-User erstellt:', email, '→ uid:', uid, password ? '(mit Passwort)' : '(ohne Passwort)', ageConfirmedAt ? '(age-confirmed)' : '', emailConfirmToken ? '(needs-confirm)' : '(auto-confirmed)');
    // Response ZUERST — User-Daten sind bereits in d.users[] in-memory.
    // Mobile-Clients (5G) droppen sonst die Connection wenn speichern() >5s blockiert.
    // speichern() läuft danach im next-tick im Hintergrund.
    res.json({ ok: true, uid, existed: false, emailConfirmToken });
    setImmediate(() => { try { speichern(); } catch(e) { console.error('[signup] speichern fail:', e.message); } });
});

// ── EMAIL-CONFIRMATION ENDPOINTS ──────────────────────────────────────
// Aktivierung via FEATURE_EMAIL_CONFIRMATION=1 in Railway env-vars.

// Token einlösen → emailConfirmedAt setzen, Token entfernen
app.post('/confirm-email-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    if (!FEATURE_FLAGS.emailConfirmation) {
        return res.json({ ok: false, error: 'Email-Confirmation-Feature ist nicht aktiviert', flagged: true });
    }
    const token = String((req.body && req.body.token) || '').trim();
    if (!token) return res.json({ ok: false, error: 'Token fehlt' });
    // User mit diesem Token finden
    const found = Object.entries(d.users || {}).find(([, u]) => u.emailConfirmToken === token);
    if (!found) return res.json({ ok: false, error: 'Token ungültig oder bereits eingelöst' });
    const [uid, u] = found;
    if (u.emailConfirmTokenExp && u.emailConfirmTokenExp < Date.now()) {
        return res.json({ ok: false, error: 'Token abgelaufen — bitte neuen anfordern', expired: true });
    }
    u.emailConfirmedAt = Date.now();
    u.emailConfirmToken = null;
    u.emailConfirmTokenExp = null;
    speichern();
    console.log('[CONFIRM-EMAIL]', uid, '→ bestätigt');
    res.json({ ok: true, uid });
});

// Neuen Token generieren (bestehenden User, der noch nicht bestätigt hat)
app.post('/resend-confirmation-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    if (!FEATURE_FLAGS.emailConfirmation) {
        return res.json({ ok: false, error: 'Email-Confirmation-Feature ist nicht aktiviert', flagged: true });
    }
    const uid = String((req.body && req.body.uid) || '').trim();
    if (!uid || !d.users[uid]) return res.json({ ok: false, error: 'User nicht gefunden' });
    if (d.users[uid].emailConfirmedAt) return res.json({ ok: false, error: 'Email ist bereits bestätigt' });
    const newToken = require('crypto').randomBytes(24).toString('hex');
    d.users[uid].emailConfirmToken = newToken;
    d.users[uid].emailConfirmTokenExp = Date.now() + 7 * 24 * 60 * 60 * 1000;
    speichern();
    console.log('[RESEND-CONFIRM]', uid);
    res.json({ ok: true, emailConfirmToken: newToken, email: d.users[uid].email });
});

// ── BLOCK/UNBLOCK USER (Play-Store §1.10 UGC-Pflicht) ─────────────────
// Aktivierung via Railway env-var: FEATURE_BLOCK_USER=1
// Speichert blockedUsers[]-Array auf dem Blocker-User. Die App-Side
// verwendet diese Liste um Inhalte des blockierten Users auszublenden.
app.post('/block-user-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    if (!FEATURE_FLAGS.blockUser) {
        return res.json({ ok: false, error: 'Block-Feature ist noch nicht aktiviert (FEATURE_BLOCK_USER fehlt)', flagged: true });
    }
    const { blockerUid, targetUid } = req.body || {};
    if (!blockerUid || !targetUid) return res.json({ ok: false, error: 'blockerUid+targetUid erforderlich' });
    if (String(blockerUid) === String(targetUid)) return res.json({ ok: false, error: 'Self-Block nicht erlaubt' });
    if (!d.users[blockerUid] || !d.users[targetUid]) return res.json({ ok: false, error: 'User nicht gefunden' });
    if (!Array.isArray(d.users[blockerUid].blockedUsers)) d.users[blockerUid].blockedUsers = [];
    const tStr = String(targetUid);
    if (!d.users[blockerUid].blockedUsers.map(String).includes(tStr)) {
        d.users[blockerUid].blockedUsers.push(tStr);
        // Auch Following-Beziehung beidseitig auflösen (wer blockiert wird, soll nicht
        // mehr in following/followers stehen — sonst Inkonsistenz).
        if (Array.isArray(d.users[blockerUid].following)) {
            d.users[blockerUid].following = d.users[blockerUid].following.filter(u => String(u) !== tStr);
        }
        if (Array.isArray(d.users[targetUid].followers)) {
            d.users[targetUid].followers = d.users[targetUid].followers.filter(u => String(u) !== String(blockerUid));
        }
        speichern();
        console.log('[BLOCK]', blockerUid, '→ blockiert', targetUid);
    }
    res.json({ ok: true });
});

app.post('/unblock-user-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    if (!FEATURE_FLAGS.blockUser) {
        return res.json({ ok: false, error: 'Block-Feature ist noch nicht aktiviert (FEATURE_BLOCK_USER fehlt)', flagged: true });
    }
    const { blockerUid, targetUid } = req.body || {};
    if (!blockerUid || !targetUid) return res.json({ ok: false, error: 'blockerUid+targetUid erforderlich' });
    if (!d.users[blockerUid]) return res.json({ ok: false, error: 'User nicht gefunden' });
    if (!Array.isArray(d.users[blockerUid].blockedUsers)) d.users[blockerUid].blockedUsers = [];
    const before = d.users[blockerUid].blockedUsers.length;
    d.users[blockerUid].blockedUsers = d.users[blockerUid].blockedUsers.filter(u => String(u) !== String(targetUid));
    if (d.users[blockerUid].blockedUsers.length !== before) {
        speichern();
        console.log('[UNBLOCK]', blockerUid, '→ entblockt', targetUid);
    }
    res.json({ ok: true });
});

// Verifiziert Email + Passwort. Bridge-Secret-geschützt. Liefert uid wenn ok.
app.post('/auth-email-password', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const result = authenticateEmailPassword(req.body && req.body.email, req.body && req.body.password);
    res.status(result.status).json(result.body);
});

// Browser-facing alias for the app login form. The bridge endpoint above remains
// available for server-to-server callers that still send x-bridge-secret.
app.post('/api/auth/email-password', (req, res) => {
    const result = authenticateEmailPassword(req.body && req.body.email, req.body && req.body.password, { includeRedirect: true });
    res.status(result.status).json(result.body);
});


app.get('/auth/code-check', (req, res) => {
    const code = (req.query.code||'').toLowerCase().trim();
    if (!code) return res.status(400).json({ error: 'Kein Code' });
    const found = Object.entries(d.users).find(([, u]) => u.appCode === code);
    if (!found) return res.status(401).json({ error: 'Ungültig' });
    const [uid, u] = found;
    res.json({ ok: true, uid, name: u.name, username: u.username||null, role: u.role, xp: u.xp });
});


app.get('/like-from-app', async (req, res) => {
    const uid = req.query.uid;
    const msgId = req.query.msgId;
    if (!uid || !msgId) return res.json({ok:false});
    // Kein Bridge Secret nötig - kommt von der App

    // Link finden - alle Möglichkeiten
    let lnk = d.links[msgId] 
        || d.links['B_' + msgId] 
        || d.links['C_' + msgId]
        || Object.values(d.links).find(l => String(l.counter_msg_id) === String(msgId));
    if (!lnk) return res.json({ok:false, error:'Link nicht gefunden'});
    console.log('[APP-LIKE] Link gefunden, counter_msg_id:', lnk.counter_msg_id, 'chat_id:', lnk.chat_id);

    const uidNum = Number(uid);
    if (!lnk.likes) lnk.likes = new Set();
    const wasLiked = lnk.likes.has(String(uid));
    if (wasLiked) {
        // Bereits geliked - kein Unlike möglich
        return res.json({ok:true, liked:true, likes: lnk.likes.size});
    } else {
        // Like — Sub-Account-safe: String(uid) statt String(uidNum) damit
        // non-numeric IDs (Number → NaN) nicht den Self-Check umgehen.
        if (String(uid) === String(lnk.user_id)) return res.json({ok:false, error:'Kein Self-Like'});
        if (String(getRootUid(uid)) === String(getRootUid(lnk.user_id))) return res.json({ok:false, error:'Kein Self-Like (eigener Account)'});
        lnk.likes.add(String(uid));
        const u = d.users[uid];
        if (!lnk.likerNames) lnk.likerNames = {};
        lnk.likerNames[String(uid)] = { name: u?.name||'User', insta: u?.instagram||null };
        if (!lnk.likeSource) lnk.likeSource = { app: 0, telegram: 0 };
        lnk.likeSource.app = (lnk.likeSource.app||0) + 1;
        // DM-Benachrichtigung löschen
        const dmKey = String(lnk.counter_msg_id);
        const dmUidStr = String(uid);
        if (d.dmNachrichten?.[dmKey]?.[dmUidStr]) {
            bot.telegram.deleteMessage(Number(uid), d.dmNachrichten[dmKey][dmUidStr]).catch(()=>{});
            delete d.dmNachrichten[dmKey][dmUidStr];
        }
        // XP vergeben — Likes auf gestrige Links zählen NICHT für Daily-Ranking.
        // Auswertung der gestrigen Missionen läuft heute 12:00 → User braucht das Zeitfenster
        // 00:00–12:00 um M2/M3 nachzuholen. Diese Likes dürfen aber HEUTIGES Daily-XP
        // nicht aufpumpen, sonst verfälschen sie das Daily-Ranking. WeeklyXP + GesamtXP
        // bekommt der User trotzdem.
        const istHeutigerLinkApp = new Date(lnk.timestamp).toDateString() === new Date().toDateString();
        if (!istAdminId(uid)) {
            if (istHeutigerLinkApp) xpAddMitDaily(uid, 5, u?.name||'User');
            else                    xpAdd(uid, 5, u?.name||'User');
        }
        // ── FIRST-POST-BONUS für LIKER ──
        // Wenn der Link ein gepinnter First-Post ist (innerhalb 8h-Window) → +20 XP extra
        // für Liker als Anreiz neue Member zu supporten.
        if (!istAdminId(uid) && u && lnk.firstPostBonus && lnk.firstPostBonusUntil && Date.now() < lnk.firstPostBonusUntil) {
            xpAdd(uid, 20, u.name||'User');
            try { sendInAppDM(uid, '🌟 +20 XP First-Post-Bonus!\n\nDu hast den allerersten Post eines neuen Members geliked — vielen Dank fürs Support! +20 XP extra.'); } catch(e) {}
        }
        // 💎 alle 100 App-Likes ein Diamant
        if (!istAdminId(uid) && u) {
            u.appLikeCount = (u.appLikeCount||0) + 1;
            if (u.appLikeCount % 100 === 0) {
                addDiamond(uid, 1);
                dmUser(uid, `💎 *${u.appLikeCount} Likes via App!*\n\nDu hast +1 Diamant verdient. Aktuell: ${u.diamonds||0} 💎`, { parse_mode: 'Markdown' });
            }
        }
        // ── EVENT-BONUS pro LIKE (alle Links — auch ältere) ──
        // Diamond-Event: jeder Like während Event-Zeit gibt dem User bonusPerPost-Diamanten.
        // XP-Event: jeder Like gibt zusätzlich XP (flat-bonus, on top of dem normalen +5).
        if (!istAdminId(uid) && u) {
            const _evtBonusL = applyLikeBonus(uid, u.name||'User');
            if (_evtBonusL.events.length) {
                const parts = _evtBonusL.events.map(e =>
                    e.type === 'diamond' ? ('+' + e.amount + ' 💎')
                    : e.type === 'xp' ? ('+' + e.amount + ' XP')
                    : ''
                ).filter(Boolean);
                if (parts.length) {
                    try { sendInAppDM(uid, '🎉 Event-Bonus für deinen Like!\n\n' + parts.join(' · ') + '\n\nLäuft noch — like weiter!'); } catch(e) {}
                }
            }
        }
        // Mission aktualisieren
        const mission = getMission(uid);
        updateMissionProgress(uid);
        if (istHeutigerLinkApp && istInstagramLink(lnk.text)) mission.likesGegeben++;
        await checkMissionen(uid, u?.name||'User');
    }

    speichernDebounced();

    // Sofort antworten – Telegram-Updates im Hintergrund
    const liked = !wasLiked;
    res.json({ok:true, liked, likes: lnk.likes.size});

    // App-only Links haben keine Telegram-Message → Sync-Updates überspringen.
    if (lnk.appOnly) return;

    // Telegram Counter + Feedback asynchron (kein await → blockiert Response nicht)
    const anz = lnk.likes.size;
    const poster = d.users[String(lnk.user_id)] || {};
    const posterLabel = istAdminId(lnk.user_id) ? '⚙️ Admin ' + lnk.user_name : (poster.role||'🆕') + ' ' + lnk.user_name;
    const posterStats = istAdminId(lnk.user_id) ? '' : '  |  ⭐ ' + (poster.xp||0) + ' XP';
    bot.telegram.editMessageText(
        lnk.chat_id, lnk.counter_msg_id, null,
        posterLabel + '\n🔗 ' + lnk.text + '\n\n👍 ' + anz + ' Likes' + posterStats,
        { reply_markup: buildLinkButtons(lnk.counter_msg_id, anz) }
    ).catch(e => console.log('Telegram Sync Fehler:', e.message));

    if (liked && !istAdminId(uid)) {
        const liker = d.users[uid] || {};
        const nb = xpBisNaechstesBadge(liker.xp||0);
        const eventBonus = d.xpEvent?.aktiv && d.xpEvent?.multiplier > 1 ? ` (+${Math.round((d.xpEvent.multiplier-1)*100)}% Event)` : '';
        const feedbackText = '🎉 +5 XP' + eventBonus + '\n' + (liker.role||'🆕') + ' | ⭐ ' + (liker.xp||0) + (nb ? '\n⬆️ Noch ' + nb.fehlend + ' bis ' + nb.ziel : '');
        bot.telegram.sendMessage(lnk.chat_id, feedbackText, { reply_to_message_id: lnk.counter_msg_id })
            .then(feedbackMsg => setTimeout(() => bot.telegram.deleteMessage(lnk.chat_id, feedbackMsg.message_id).catch(()=>{}), 8000))
            .catch(e => console.log('Feedback Fehler:', e.message));
    }
});


// ── PHASE 2 API ENDPOINTS ──

// Sub-Account erstellen (App-only Persona, keine Telegram-Identität).
// Body: { parent_uid: "<tg uid>", name: "<display name>" } → returns { ok, sub_uid }
app.post('/create-subaccount-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const parent_uid = req.body && req.body.parent_uid ? String(req.body.parent_uid) : '';
    const name = (req.body && req.body.name ? String(req.body.name) : '').trim().slice(0, 30);
    if (!parent_uid || !name) return res.json({ok:false, error:'parent_uid + name erforderlich'});
    if (!d.users[parent_uid]) return res.json({ok:false, error:'Parent-User nicht gefunden'});
    if (d.users[parent_uid].parent_uid) return res.json({ok:false, error:'Sub-Account kann keinen Sub-Account erstellen'});
    // Admins haben unbegrenzte Sub-Accounts. Normale User max 1.
    const isAdm = istAdminId(parent_uid);
    if (!isAdm && d.users[parent_uid].subUid && d.users[d.users[parent_uid].subUid]) {
        return res.json({ok:false, error:'Du hast schon einen Sub-Account', sub_uid: String(d.users[parent_uid].subUid)});
    }
    // Sub-UID: Date.now() liegt im 13-stelligen Bereich, Telegram-UIDs sind <11-stellig → keine Kollision.
    // Plus Kollisions-Check: zwei Parents im selben Millisekunden würden sonst die gleiche UID kriegen.
    let sub_uid = String(Date.now());
    let attempts = 0;
    while (d.users[sub_uid] && attempts++ < 50) {
        sub_uid = String(Date.now()) + Math.floor(Math.random() * 1000);
    }
    if (d.users[sub_uid]) {
        return res.json({ok:false, error:'Sub-UID-Kollision — bitte gleich nochmal versuchen'});
    }
    d.users[sub_uid] = {
        name, username: null, instagram: null, bio: null, nische: null, spitzname: null,
        trophies: [], xp: 0, level: 1, warnings: 0, started: true, links: 0, likes: 0,
        role: '🆕 New', lastDaily: null, totalLikes: 0, chats: [], joinDate: Date.now(),
        inGruppe: true, diamonds: 0, projects: [], profileCompletionRewarded: false,
        inventory: [], activeRing: null, followers: [], following: [],
        parent_uid: parent_uid // ← markiert als Sub
    };
    // Legacy: parent.subUid = primärer Sub (für alten Code der u.subUid liest)
    // Neu: parent.subUids = Array aller Subs (Admins können viele haben)
    if (!Array.isArray(d.users[parent_uid].subUids)) d.users[parent_uid].subUids = [];
    if (d.users[parent_uid].subUid && !d.users[parent_uid].subUids.includes(String(d.users[parent_uid].subUid))) {
        d.users[parent_uid].subUids.push(String(d.users[parent_uid].subUid));
    }
    d.users[parent_uid].subUids.push(sub_uid);
    // Primary subUid NICHT überschreiben wenn schon einer existiert — der erste Sub
    // bleibt primary. Neuere Subs sind über subUids[] erreichbar.
    if (!d.users[parent_uid].subUid) d.users[parent_uid].subUid = sub_uid;
    speichern();
    res.json({ok:true, sub_uid, allSubs: d.users[parent_uid].subUids.slice()});
});

// Admin-only: linkt einen bereits existierenden User als Sub-Account eines Admin-Parents.
// Use-Case: Admin hat einen 2. Account auf der Plattform → will ihn zu seinen Sub-Accounts
// hinzufügen ohne dass die History/Posts des Accounts verloren gehen.
app.post('/admin-link-as-sub-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const parent_uid = String((req.body && req.body.parent_uid) || '');
    const target_uid = String((req.body && req.body.target_uid) || '');
    if (!parent_uid || !target_uid) return res.json({ok:false, error:'parent_uid + target_uid erforderlich'});
    if (!istAdminId(parent_uid)) return res.json({ok:false, error:'Nur Admins können andere User als Sub linken'});
    const parent = d.users[parent_uid];
    const target = d.users[target_uid];
    if (!parent) return res.json({ok:false, error:'Parent-User nicht gefunden'});
    if (!target) return res.json({ok:false, error:'Target-User nicht gefunden'});
    if (target_uid === parent_uid) return res.json({ok:false, error:'Kann sich nicht selbst als Sub linken'});
    if (target.parent_uid && String(target.parent_uid) !== parent_uid) {
        return res.json({ok:false, error:'User ist bereits Sub eines anderen Accounts (' + target.parent_uid + ')'});
    }
    target.parent_uid = parent_uid;
    if (!Array.isArray(parent.subUids)) parent.subUids = [];
    if (parent.subUid && !parent.subUids.includes(String(parent.subUid))) parent.subUids.push(String(parent.subUid));
    if (!parent.subUids.includes(target_uid)) parent.subUids.push(target_uid);
    if (!parent.subUid) parent.subUid = target_uid;  // wenn vorher kein Sub → wird primary
    speichern();
    console.log('[ADMIN-LINK-SUB] Parent', parent_uid, '+ Sub', target_uid, '(', target.spitzname||target.name, ')');
    res.json({ok:true, parent_uid, target_uid, allSubs: parent.subUids.slice()});
});

// Sub-Account löschen — Parent ruft das auf, Sub wird komplett aus d.users entfernt.
app.post('/delete-subaccount-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const parent_uid = req.body && req.body.parent_uid ? String(req.body.parent_uid) : '';
    const sub_uid = req.body && req.body.sub_uid ? String(req.body.sub_uid) : '';
    if (!parent_uid || !sub_uid) return res.json({ok:false, error:'parent_uid + sub_uid erforderlich'});
    const sub = d.users[sub_uid];
    if (!sub || String(sub.parent_uid) !== parent_uid) return res.json({ok:false, error:'Sub gehört nicht zu diesem Parent'});
    delete d.users[sub_uid];
    if (d.users[parent_uid]) delete d.users[parent_uid].subUid;
    // Sub aus Followern/Following anderer User entfernen damit keine Geister-Referenzen bleiben
    for (const u of Object.values(d.users||{})) {
        if (Array.isArray(u.followers)) u.followers = u.followers.filter(x => String(x) !== sub_uid);
        if (Array.isArray(u.following)) u.following = u.following.filter(x => String(x) !== sub_uid);
    }
    if (d.dailyXP) delete d.dailyXP[sub_uid];
    if (d.weeklyXP) delete d.weeklyXP[sub_uid];
    // Orphans bereinigen: Links, Superlinks, Kommentare, Notifs und Likes des Subs vollständig löschen
    if (Array.isArray(d.links)) {
        d.links = d.links.filter(l => String(l.uid) !== sub_uid);
        for (const l of d.links) {
            if (l.likes && typeof l.likes.delete === 'function') l.likes.delete(sub_uid);
            else if (Array.isArray(l.likes)) l.likes = l.likes.filter(x => String(x) !== sub_uid);
            if (Array.isArray(l.comments)) l.comments = l.comments.filter(c => String(c.uid) !== sub_uid);
        }
    }
    if (Array.isArray(d.superlinks)) {
        d.superlinks = d.superlinks.filter(s => String(s.uid) !== sub_uid);
    }
    if (d.notifications && typeof d.notifications === 'object') {
        delete d.notifications[sub_uid];
        for (const k of Object.keys(d.notifications)) {
            if (Array.isArray(d.notifications[k])) {
                d.notifications[k] = d.notifications[k].filter(n => String(n.actorUid||'') !== sub_uid);
            }
        }
    }
    if (d.threadMessages && typeof d.threadMessages === 'object') {
        for (const tk of Object.keys(d.threadMessages)) {
            if (Array.isArray(d.threadMessages[tk])) {
                d.threadMessages[tk] = d.threadMessages[tk].filter(m => String(m.uid) !== sub_uid);
            }
        }
    }
    speichern();
    res.json({ok:true});
});

app.post('/follow-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const followerUid = req.body && req.body.followerUid ? String(req.body.followerUid) : '';
    const targetUid = req.body && req.body.targetUid ? String(req.body.targetUid) : '';
    if (!followerUid || !targetUid) return res.json({ok:false, error:'Fehlende UIDs'});
    // Auto-create für unbekannte Telegram-UIDs (≤12 stellig) — Sub-UIDs sind 13-stellig (Date.now)
    // und werden NICHT auto-created um Orphans zu vermeiden.
    if (!d.users[followerUid]) {
        if (followerUid.length <= 12 && /^\d+$/.test(followerUid)) {
            user(followerUid, '');
        } else {
            return res.json({ok:false, error:'Follower-Account nicht gefunden ('+followerUid+')'});
        }
    }
    if (!d.users[targetUid]) return res.json({ok:false, error:'Ziel-User nicht gefunden ('+targetUid+')'});
    if (!Array.isArray(d.users[followerUid].following)) d.users[followerUid].following = [];
    if (!Array.isArray(d.users[targetUid].followers)) d.users[targetUid].followers = [];
    // Konsistenz: alles als String speichern damit indexOf zuverlässig matcht
    d.users[followerUid].following = d.users[followerUid].following.map(String);
    d.users[targetUid].followers = d.users[targetUid].followers.map(String);
    const idx = d.users[followerUid].following.indexOf(targetUid);
    let action = '';
    if (idx === -1) {
        d.users[followerUid].following.push(targetUid);
        if (!d.users[targetUid].followers.includes(followerUid)) d.users[targetUid].followers.push(followerUid);
        const followerName = d.users[followerUid]?.spitzname || d.users[followerUid]?.name || 'Jemand';
        try { addNotification(targetUid, '👤', followerName + ' folgt dir jetzt', String(followerUid)); } catch(e) {}
        action = 'follow';
    } else {
        d.users[followerUid].following.splice(idx, 1);
        d.users[targetUid].followers = d.users[targetUid].followers.filter(id => id !== followerUid);
        action = 'unfollow';
    }
    speichern();
    console.log('[follow-api] ' + followerUid + ' ' + action + ' ' + targetUid);
    res.json({ok:true, action});
});

app.post('/create-post-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, text, attachment, attachmentType } = req.body || {};
    if (!uid || (!text && !attachment)) return res.json({ok:false});
    if (!d.posts) d.posts = {};
    if (!d.posts[uid]) d.posts[uid] = [];
    const post = { text: (text||'').slice(0,300), timestamp: Date.now(), likes: [] };
    if (attachment) { post.attachment = attachment; post.attachmentType = attachmentType; }
    d.posts[uid].push(post);
    if (d.posts[uid].length > 50) d.posts[uid].shift();
    speichern();
    res.json({ok:true});
});

app.post('/comment-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, name, linkId, text } = req.body || {};
    if (!uid || !text || !linkId) return res.json({ok:false});
    if (!d.comments) d.comments = {};
    if (!d.comments[linkId]) d.comments[linkId] = [];
    d.comments[linkId].push({ uid, name, text: text.slice(0,200), timestamp: Date.now() });
    if (d.comments[linkId].length > 100) d.comments[linkId].shift();
    // Post-Owner benachrichtigen. linkId ist eine counter_msg_id (oder selten ein "uid_ts"-Schlüssel),
    // NICHT zwingend uid_irgendwas. Erst d.links lookup, dann notfalls als post-Schlüssel parsen.
    let postOwnerUid = null;
    const lnk = d.links?.[linkId] || Object.values(d.links||{}).find(l => String(l.counter_msg_id) === String(linkId));
    if (lnk?.user_id) postOwnerUid = String(lnk.user_id);
    else if (typeof linkId === 'string' && linkId.includes('_')) postOwnerUid = linkId.split('_')[0]; // legacy/post-Schlüssel
    if (postOwnerUid && String(postOwnerUid) !== String(uid) && d.users[postOwnerUid]) {
        addNotification(postOwnerUid, '💬', (name||'Jemand') + ' hat kommentiert: ' + text.slice(0,40), String(uid));
    }
    speichern();
    res.json({ok:true});
});


app.post('/delete-post-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, timestamp } = req.body || {};
    if (!uid || !timestamp || !d.posts?.[uid]) return res.json({ok:false});
    d.posts[uid] = d.posts[uid].filter(p => p.timestamp !== Number(timestamp));
    speichern();
    res.json({ok:true});
});

app.post('/delete-comment-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, postId, commentIdx, commentTs } = req.body || {};
    if (!uid || !postId || !d.comments?.[postId]) return res.json({ok:false});
    const comments = d.comments[postId];
    // Bevorzugt: by timestamp + uid (race-safe). Index ist Fallback nur wenn ts fehlt.
    let target = -1;
    if (commentTs) {
        target = comments.findIndex(c => Number(c.timestamp) === Number(commentTs) && String(c.uid) === String(uid));
        // Admin-Override: Admin darf auch fremde Kommentare löschen wenn nur ts gegeben
        if (target < 0 && istAdminId(Number(uid))) {
            target = comments.findIndex(c => Number(c.timestamp) === Number(commentTs));
        }
    } else if (Number.isInteger(commentIdx) && comments[commentIdx]) {
        const c = comments[commentIdx];
        if (String(c.uid) === String(uid) || istAdminId(Number(uid))) target = commentIdx;
    }
    if (target < 0) return res.json({ok:false, error:'Kommentar nicht gefunden oder keine Berechtigung'});
    comments.splice(target, 1);
    speichern();
    res.json({ok:true});
});


app.post('/post-link-from-app', async (req, res) => {
    // Notes: Frühe Returns nutzen jetzt {ok:false, error} (vorher nur {error}).
    // Caller in App prüfte 'result.ok !== false' — undefined !== false war true →
    // hat Web-Push auch bei Fehlern abgefeuert + 'success' an User retourniert.
    if (!checkBridgeSecret(req, res)) return;
    const { uid, name, url, caption } = req.body || {};
    if (!uid || !url) return res.json({ok:false, error:'Ungültig'});
    console.log('[APP-LINK] uid:', uid, 'url:', url?.slice(0,30), 'GROUP_A_ID:', GROUP_A_ID);

    const u = d.users[uid];
    if (!u) return res.json({ok:false, error:'User nicht gefunden'});

    // Duplikat Check
    const heute = new Date().toDateString();
    const norm = (t) => t.toLowerCase().replace(/\?.*$/, '').replace(/\/$/, '').trim();
    const isDuplicate = Object.values(d.links).some(l => norm(l.text) === norm(url));
    if (isDuplicate) { console.log('[APP-LINK] Duplikat!'); return res.json({ok:false, error:'Dieser Link wurde bereits gepostet!'}); }

    // Daily Limit Check - Admins haben kein Limit
    let usedBonusLink = false;
    let usedBadgeBonus = false;
    if (!istAdminId(uid)) {
        const todayLinks = Object.values(d.links).filter(l =>
            String(l.user_id) === String(uid) && new Date(l.timestamp).toDateString() === heute
        ).length;
        const bonusAvail = d.bonusLinks?.[uid] || 0;
        const badgeBonus = badgeBonusLinks(u.xp||0) > 0 && (!d.badgeTracker?.[uid] || d.badgeTracker[uid] !== heute) ? 1 : 0;
        const maxLinks = 1 + bonusAvail + badgeBonus;
        if (todayLinks >= maxLinks) { console.log('[APP-LINK] Limit erreicht:', todayLinks, '/', maxLinks); return res.json({ok:false, error:'Limit erreicht! Max ' + maxLinks + ' Link(s) pro Tag'}); }
        if (todayLinks >= 1) {
            if (bonusAvail > 0) usedBonusLink = true;
            else usedBadgeBonus = true;
        }
    }
    console.log('[APP-LINK] Checks OK - sende Link...');

    try {
        // App-only Flow: kein Telegram-Group-Post, nur d.links + Confirmation-DM.
        // Link erscheint im App-Feed und wird via 30-Min-Batch-DM angekündigt.
        const linkId = generateSyntheticLinkId();
        const mapKey = linkId;
        const linkData = {
            chat_id: GROUP_A_ID,
            // Sub-Account-Safe: uid bleibt String (Number('sub_xyz') = NaN würde
            // String(link.user_id)===String(myUid) Self-Check brechen).
            user_id: /^\d+$/.test(String(uid)) ? Number(uid) : String(uid),
            user_name: u.spitzname||u.name||name,
            text: url,
            caption: caption||'',
            likes: new Set(),
            likerNames: {},
            counter_msg_id: linkId,
            timestamp: Date.now(),
            origin: 'app',
            appOnly: true,
            likeSource: { app: 0, telegram: 0 }
        };
        d.links[mapKey] = linkData;
        tryFetchThumbnail(linkData, 'text');
        console.log('[APP-LINK] Link gespeichert als:', mapKey, '(app-only)');

        // Confirmation-DM an Poster mit Magic-Link in den App-Feed.
        try {
            const magicUrl = buildMagicLinkUrl(uid, '/feed?tab=heute');
            await bot.telegram.sendMessage(Number(uid),
                '✅ *Dein Link ist im Feed!*\n\nDein Instagram-Link ist jetzt im App-Feed sichtbar. Andere User werden in der nächsten 30-Min-DM-Welle benachrichtigt.\n\n💡 *Vergiss nicht*: andere Links liken & mit 2 Wörtern kommentieren — Pflicht!',
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📲 Im Feed engagen', url: magicUrl }]] } }
            );
        } catch (e) { console.log('[APP-LINK] DM-Bestätigung Fehler:', e.message); }

        // App-DM (CreatorBoost) mit Link-Regeln — User sieht das auch wenn er kein Telegram offen hat.
        try {
            const rulesUrl = (APP_URL || 'https://web-production-7981d.up.railway.app').replace(/\/$/,'') + '/explore?tab=regeln#r-links';
            const linkRules = '✅ Dein Link ist gepostet!\n\n' +
                '📋 *Link-Regeln (kurz):*\n' +
                '• 1 Link pro Tag (Bonus-Links optional)\n' +
                '• Andere Links musst du liken (Mission M1: 5 Likes/Tag)\n' +
                '• Erst Insta-Reel öffnen, dann liken (Visit-before-Like)\n' +
                '• 2-Wort-Kommentar = Pflicht (M2/M3 Missionen)\n' +
                '• Mission-Auswertung 12:00 — sonst Verwarnung';
            sendCreatorBoostDM(uid, linkRules, { link: { url: rulesUrl, label: '📖 Alle Link-Regeln' } });
        } catch(e) {}

        // Bonus-Link verbrauchen falls verwendet
        if (usedBonusLink && d.bonusLinks?.[uid] > 0) {
            d.bonusLinks[uid]--;
            if (d.bonusLinks[uid] <= 0) delete d.bonusLinks[uid];
            console.log('[APP-LINK] Bonus-Link verbraucht, verbleibend:', d.bonusLinks[uid] || 0);
        }
        if (usedBadgeBonus) {
            if (!d.badgeTracker) d.badgeTracker = {};
            d.badgeTracker[uid] = heute;
            console.log('[APP-LINK] Badge-Bonus-Link (Erfahrener) verbraucht für uid:', uid);
        }

        // XP vergeben
        xpAddMitDaily(uid, 1, u.name||name);
        u.links = (u.links||0) + 1;

        // ── FIRST-POST-BONUS (allererster Post eines neuen Members) ──
        // u.links === 1 nach Increment → das ist der allererste Post jemals.
        // Plus: User muss frisch sein (joinDate ≤ 7 Tage) → echter Newcomer.
        // Markiert den Link mit firstPostBonus=true + gibt Poster +20 XP Welcome-Bonus.
        // Liker bekommen während der 8h-Pin-Window zusätzlich +20 XP pro Like.
        const NEW_MEMBER_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
        const isFirstPostEver = Number(u.links) === 1
            && u.joinDate && (Date.now() - u.joinDate) <= NEW_MEMBER_MAX_AGE_MS;
        if (isFirstPostEver) {
            linkData.firstPostBonus = true;
            linkData.firstPostBonusUntil = Date.now() + 8*3600*1000;
            xpAdd(uid, 20, u.name||name);
            try { sendInAppDM(uid, '🌟 Willkommen — dein erster Post ist live!\n\n+20 XP Welcome-Bonus erhalten.\nDein Post wird 8h lang ganz oben im Heute-Feed gepinned. Liker bekommen +20 XP extra.'); } catch(e) {}
        }

        // ── EVENT-BONUS pro Post anwenden ──
        // Wenn ein xpEvent / diamondEvent aktiv ist → flat-bonus zusätzlich gutschreiben + DM.
        const _evtBonus = applyPostBonus(uid, u.name||name);
        if (_evtBonus.events.length) {
            const parts = _evtBonus.events.map(e =>
                e.type === 'diamond' ? ('+' + e.amount + ' 💎')
                : e.type === 'xp' ? ('+' + e.amount + ' XP')
                : ''
            ).filter(Boolean);
            if (parts.length) {
                try { sendInAppDM(uid, '🎉 Event-Bonus für deinen Post!\n\n' + parts.join(' · ') + '\n\nLäuft noch — postet weiter!'); } catch(e) {}
            }
        }

        // Mission updaten
        const mission = getMission(uid);
        if (istInstagramLink(url)) mission.linksGepostet++;
        await checkMissionen(uid, u.name||name);

        // App-only Flow: kein sendeLinkAnAlle (replaced durch 30-Min Feed-Batch)
        // und kein Bridge-Notify (Bridge erwartet einen echten Group-Post den
        // wir hier nicht mehr machen).

        speichern();
        res.json({ok:true, msgId: linkId});
    } catch(e) {
        console.log('post-link-from-app Fehler:', e.message);
        res.json({ok:false, error:'Fehler: '+e.message});
    }
});


app.post('/pin-post-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, timestamp } = req.body || {};
    if (!uid || !d.posts?.[uid]) return res.json({ok:false});
    const post = d.posts[uid].find(p => p.timestamp === Number(timestamp));
    if (!post) return res.json({ok:false});
    // Alle anderen entpinnen
    d.posts[uid].forEach(p => p.pinned = false);
    post.pinned = true;
    speichern();
    res.json({ok:true});
});


app.post('/mark-notifications-read', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid } = req.body || {};
    if (!uid || !d.notifications?.[uid]) return res.json({ok:false});
    d.notifications[uid].forEach(n => n.read = true);
    speichern();
    res.json({ok:true});
});


app.post('/send-message-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { from, to, text, image, audio, replyTo } = req.body || {};
    if (!from || !to || (!text?.trim() && !image && !audio)) return res.json({ok:false});
    if (!d.messages) d.messages = {};
    const chatKey = [String(from), String(to)].sort().join('_');
    if (!d.messages[chatKey]) d.messages[chatKey] = [];
    const msgEntry = { from: String(from), to: String(to), text: (text||'').slice(0,500), image: image||null, audio: audio||null, timestamp: Date.now(), read: false };
    if (replyTo && (replyTo.text || replyTo.name)) {
        msgEntry.replyTo = {
            ts: Number(replyTo.ts) || 0,
            name: String(replyTo.name||'').slice(0,40),
            text: String(replyTo.text||'').slice(0,140)
        };
    }
    d.messages[chatKey].push(msgEntry);
    if (d.messages[chatKey].length > 200) d.messages[chatKey].shift();
    const fromUser = d.users[from];
    const senderName = fromUser?.spitzname || fromUser?.name || 'Jemand';
    if (fromUser) addNotification(String(to), '💬', senderName + (text ? ': ' + text.slice(0,40) : ' hat dir etwas gesendet'), String(from));
    // Telegram DM weiterleiten
    if (d.users[to]?.started) {
        try {
            const tgText = image ? '📷 Foto' : audio ? '🎤 Sprachnachricht' : text;
            await bot.telegram.sendMessage(Number(to),
                '💬 *' + senderName + ':*\n\n' + tgText,
                { parse_mode: 'Markdown' }
            );
        } catch(e) {}
    }
    speichern();
    res.json({ok:true});
});

app.post('/mark-messages-read', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, chatKey } = req.body || {};
    if (!uid || !chatKey || !d.messages?.[chatKey]) return res.json({ok:false});
    d.messages[chatKey].forEach(m => { if (m.to === String(uid)) m.read = true; });
    speichern();
    res.json({ok:true});
});

app.post('/edit-message-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, chatKey, timestamp, newText } = req.body || {};
    if (!uid || !chatKey || !timestamp || typeof newText !== 'string') return res.json({ok:false, error:'Fehlende Felder'});
    const arr = d.messages?.[chatKey];
    if (!arr) return res.json({ok:false, error:'Chat nicht gefunden'});
    const msg = arr.find(m => Number(m.timestamp) === Number(timestamp) && String(m.from) === String(uid));
    if (!msg) return res.json({ok:false, error:'Nachricht nicht gefunden oder nicht von dir'});
    if (Date.now() - msg.timestamp > 5*60*1000) return res.json({ok:false, error:'Bearbeitungs-Limit (5 Min) überschritten'});
    if (msg.image || msg.audio) return res.json({ok:false, error:'Nur Text-Nachrichten editierbar'});
    const trimmed = String(newText||'').trim().slice(0, 500);
    if (!trimmed) return res.json({ok:false, error:'Text darf nicht leer sein'});
    msg.text = trimmed;
    msg.edited = true;
    msg.editedAt = Date.now();
    speichern();
    res.json({ok:true});
});

app.post('/delete-dm-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { chatKey, timestamp, uid } = req.body || {};
    if (!chatKey || !timestamp || !d.messages?.[chatKey]) return res.json({ok:false});
    const msg = d.messages[chatKey].find(m => m.timestamp === Number(timestamp));
    if (!msg) return res.json({ok:false});
    const isAdmin = d.users?.[String(uid)]?.role?.includes('Admin');
    if (msg.from !== String(uid) && !isAdmin) return res.json({ok:false, error:'Kein Zugriff'});
    d.messages[chatKey] = d.messages[chatKey].filter(m => m.timestamp !== Number(timestamp));
    speichern();
    res.json({ok:true});
});

app.post('/delete-thread-msg-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { threadId, timestamp, msgId, uid } = req.body || {};
    if (!threadId || !timestamp) return res.json({ok:false, error:'Fehlende Felder'});
    // Akzeptiere Admin via Role ODER via ADMIN_IDS env (robuster)
    const userRole = d.users?.[String(uid)]?.role || '';
    const isAdmin = userRole.includes('Admin') || istAdminId(uid);
    const msgs = d.threadMessages?.[threadId] || [];
    let msg = msgs.find(m => Number(m.timestamp) === Number(timestamp));
    let isCFOnly = false;
    if (!msg && threadId === 'general' && d.communityFeed?.length) {
        msg = d.communityFeed.find(m => Number(m.timestamp) === Number(timestamp));
        if (msg) isCFOnly = true;
    }
    if (!msg) return res.json({ok:false, error:'Nachricht nicht gefunden (eventuell schon gelöscht)'});
    if (msg.uid && String(msg.uid) !== String(uid) && !isAdmin) return res.json({ok:false, error:'Kein Zugriff (nicht eigene Nachricht)'});
    if (!isCFOnly) d.threadMessages[threadId] = msgs.filter(m => Number(m.timestamp) !== Number(timestamp));
    if (d.communityFeed) d.communityFeed = d.communityFeed.filter(m => Number(m.timestamp) !== Number(timestamp));
    const thr = (d.threads||[]).find(t => String(t.id) === threadId);
    if (thr) {
        thr.last_msg = d.threadMessages[threadId]?.[0] || null;
        thr.msg_count = d.threadMessages[threadId]?.length || 0;
    }
    speichern();
    if ((msgId || msg.msg_id) && GROUP_B_ID) {
        try { await bot.telegram.deleteMessage(GROUP_B_ID, Number(msgId || msg.msg_id)); }
        catch(e) { console.log('Telegram-Löschen fehlgeschlagen:', e.description || e.message); }
    }
    res.json({ok:true});
});

// Auto-Sync: prüft alle ~30 Min ob Nachrichten in Telegram gelöscht wurden und entfernt sie
async function syncDeletedThreadMessages() {
    if (!GROUP_B_ID) return { checked: 0, removed: 0 };
    const tm = d.threadMessages || {};
    let checked = 0, removed = 0;
    for (const threadId of Object.keys(tm)) {
        const arr = tm[threadId] || [];
        const candidates = arr.filter(m => m && m.msg_id).slice(0, 30);
        const toRemove = new Set();
        for (const m of candidates) {
            checked++;
            const exists = await _probeMessageExists(m.msg_id);
            if (exists === false) toRemove.add(Number(m.msg_id));
            await new Promise(r => setTimeout(r, 30));
        }
        if (toRemove.size) {
            tm[threadId] = arr.filter(m => !toRemove.has(Number(m.msg_id)));
            removed += toRemove.size;
            const thr = (d.threads||[]).find(t => String(t.id) === threadId);
            if (thr) { thr.last_msg = tm[threadId][0] || null; thr.msg_count = tm[threadId].length; }
        }
    }
    if (d.communityFeed?.length) {
        const cfRemove = new Set();
        for (const m of d.communityFeed.slice(0, 30)) {
            if (!m.msg_id) continue;
            checked++;
            const exists = await _probeMessageExists(m.msg_id);
            if (exists === false) cfRemove.add(Number(m.msg_id));
            await new Promise(r => setTimeout(r, 30));
        }
        if (cfRemove.size) {
            d.communityFeed = d.communityFeed.filter(m => !cfRemove.has(Number(m.msg_id)));
            removed += cfRemove.size;
        }
    }
    if (removed) { speichern(); console.log(`🔄 syncDeletedThreadMessages: ${removed}/${checked} entfernt`); }
    return { checked, removed };
}

app.post('/send-group-message', async (req, res) => {
    const { text, uid } = req.body || {};
    if (!text?.trim()) return res.json({ ok: false, error: 'Kein Text' });
    const u = d.users[String(uid)];
    if (!u) return res.json({ ok: false, error: 'User nicht gefunden' });
    const name = u.spitzname || u.name || 'User';
    const label = (u.role || '🆕') + ' ' + name;
    try {
        await bot.telegram.sendMessage(GROUP_B_ID, `💬 ${label}:
${text.trim()}`);
        res.json({ ok: true });
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
});

app.get('/telegram-feed', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ messages: d.communityFeed || [] });
});

app.get('/forum-topics', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!d.threads || d.threads.length === 0) await ladeForumTopics();
    // Build from received messages if API failed
    if (!d.threads || d.threads.length === 0) {
        const msgKeys = Object.keys(d.threadMessages || {});
        d.threads = msgKeys.length > 0
            ? msgKeys.map(tid => ({ id: tid, name: tid === 'general' ? 'Allgemein' : `Thread ${tid}`, emoji: tid === 'general' ? '💬' : '📌', last_msg: d.threadMessages[tid]?.[0] || null, msg_count: d.threadMessages[tid]?.length || 0 }))
            : [{ id: 'general', name: 'Allgemein', emoji: '💬', last_msg: null, msg_count: 0 }];
    }
    // Always ensure 'general' exists
    if (!d.threads.find(t => String(t.id) === 'general')) {
        d.threads.unshift({ id: 'general', name: 'Allgemein', emoji: '💬', last_msg: d.threadMessages?.['general']?.[0] || null, msg_count: d.threadMessages?.['general']?.length || 0 });
    }
    // Merge any threads discovered from messages not yet in list
    for (const tid of Object.keys(d.threadMessages || {})) {
        if (!d.threads.find(t => String(t.id) === tid)) {
            d.threads.push({ id: tid === 'general' ? 'general' : Number(tid), name: `Thread ${tid}`, emoji: '📌', last_msg: d.threadMessages[tid]?.[0] || null, msg_count: d.threadMessages[tid]?.length || 0 });
        }
    }
    res.json({ threads: d.threads });
});

app.get('/forum-debug', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const info = { GROUP_B_ID, threadsCount: (d.threads||[]).length, threadMsgKeys: Object.keys(d.threadMessages||{}), error: null, apiResult: null };
    if (GROUP_B_ID) {
        try { info.apiResult = await bot.telegram.callApi('getForumTopics', { chat_id: GROUP_B_ID, limit: 10 }); }
        catch (e) { info.error = e.message; }
    }
    res.json(info);
});

app.get('/fethread-setup', (req, res) => {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const baseUrl = proto + '://' + req.headers.host;
    const status = d.fullEngagementThreadId ? `✅ Thread-ID: ${d.fullEngagementThreadId}` : '❌ Kein Thread gesetzt';
    const groupStatus = GROUP_B_ID ? `✅ GROUP_B_ID: ${GROUP_B_ID}` : '❌ GROUP_B_ID nicht gesetzt!';
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Full Engagement Setup</title>
<style>body{font-family:sans-serif;max-width:480px;margin:40px auto;padding:20px;background:#111;color:#fff}
h2{color:#fff;margin-bottom:4px}p{color:#aaa;font-size:14px;margin-bottom:24px}
.status{background:#1e1e1e;border-radius:10px;padding:14px;margin-bottom:20px;font-size:14px;line-height:2}
button{width:100%;padding:14px;background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;margin-bottom:10px}
button:disabled{opacity:.5;cursor:not-allowed}
.result{background:#1e1e1e;border-radius:10px;padding:14px;margin-top:16px;font-size:13px;display:none;white-space:pre-wrap;word-break:break-all}
.ok{color:#22c55e}.err{color:#ef4444}</style></head>
<body>
<h2>⭐ Full Engagement Setup</h2>
<p>Erstellt den Full Engagement Thread in Gruppe B</p>
<div class="status">${groupStatus}<br>${status}</div>
<button id="btn" onclick="createThread()">🚀 Thread erstellen / zurücksetzen</button>
<div class="result" id="result"></div>
<script>
const BASE='${baseUrl}';
async function createThread(){
  const btn=document.getElementById('btn');
  const res=document.getElementById('result');
  btn.disabled=true;btn.textContent='⏳ Erstelle Thread...';
  res.style.display='none';
  try{
    const r=await fetch(BASE+'/fethread-setup',{method:'POST',headers:{'Content-Type':'application/json'}});
    const data=await r.json();
    res.style.display='block';
    if(data.ok){res.className='result ok';res.textContent='✅ Erfolgreich!\\nThread-ID: '+data.threadId;}
    else{res.className='result err';res.textContent='❌ Fehler: '+data.error+'\\n\\nHinweis: '+data.hint;}
    btn.textContent='🔄 Nochmal versuchen';
  }catch(e){res.style.display='block';res.className='result err';res.textContent='❌ '+e.message;btn.textContent='🔄 Nochmal versuchen';}
  btn.disabled=false;
}
</script></body></html>`);
});

app.post('/fethread-setup-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    return fethreadCreate(res);
});

app.post('/fethread-announce-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    if (!d.fullEngagementThreadId) return res.json({ ok: false, error: 'Kein Full Engagement Thread gesetzt. Zuerst erstellen.' });
    if (!GROUP_B_ID) return res.json({ ok: false, error: 'GROUP_B_ID nicht gesetzt.' });
    try {
        await bot.telegram.sendMessage(GROUP_B_ID,
            '⭐ *Full Engagement Thread!*\n\n' +
            'Hier postet ihr eure Superlinks für diese Woche.\n\n' +
            '📌 *Regeln:*\n• 1–2 Superlinks pro Person pro Woche (Mo–Sa)\n• Wer postet, muss ALLE anderen liken, kommentieren, teilen & speichern\n• Verstoß: -50 XP\n\n' +
            '📲 Instagram-Link hier reinposten oder /superlink im Bot nutzen!',
            { parse_mode: 'Markdown', message_thread_id: Number(d.fullEngagementThreadId) }
        );
        res.json({ ok: true });
    } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.post('/fethread-setup', async (req, res) => {
    return fethreadCreate(res);
});

async function fethreadCreate(res) {
    if (!GROUP_B_ID) return res.json({ ok: false, error: 'GROUP_B_ID nicht gesetzt in Railway Variables!', hint: 'Gehe zu Railway → telegram-bot → Variables und setze GROUP_B_ID.' });
    const oldId = d.fullEngagementThreadId;
    d.fullEngagementThreadId = null;
    let threadId = null, createError = null;
    try {
        const result = await bot.telegram.callApi('createForumTopic', { chat_id: GROUP_B_ID, name: 'Full Engagement' });
        threadId = result.message_thread_id;
        d.fullEngagementThreadId = threadId;
        speichern();
    } catch(e) { createError = e.message; d.fullEngagementThreadId = oldId; }
    if (!threadId) return res.json({ ok: false, error: createError, hint: 'Ist Forum-Modus in Gruppe B aktiv? Hat der Bot "Themen verwalten" als Admin-Recht?' });
    try {
        await bot.telegram.sendMessage(GROUP_B_ID,
            '⭐ *Full Engagement Thread geöffnet!*\n\nHier könnt ihr eure Superlinks posten.\n\n📌 *Regeln:*\n• 1–2 Superlinks pro Person pro Woche (Mo–Sa)\n• Wer postet, muss ALLE anderen liken, kommentieren, teilen & speichern\n• Verstoß: -50 XP\n\n📲 Einfach euren Instagram-Link hier reinposten oder /superlink im Bot nutzen!',
            { parse_mode: 'Markdown', message_thread_id: Number(threadId) }
        );
    } catch(e) {}
    res.json({ ok: true, threadId });
}

// Quick-Sync: prüft die letzten N Nachrichten eines Threads parallel auf Telegram-Existenz
const _qsBusy = new Set();
const _qsLast = new Map();
async function _probeMessageExists(messageId) {
    // forwardMessage zum Bot selbst — sicherste Methode um Existenz zu prüfen.
    // Wir leiten an die erste ADMIN_ID weiter und löschen den Forward direkt wieder.
    const sinkChatId = [...ADMIN_IDS][0];
    if (!sinkChatId) return null; // ohne Sink können wir nicht prüfen
    try {
        const fwd = await bot.telegram.callApi('forwardMessage', {
            chat_id: sinkChatId,
            from_chat_id: GROUP_B_ID,
            message_id: Number(messageId),
            disable_notification: true
        });
        // Sofort wieder im Sink löschen damit Admin-DM sauber bleibt
        if (fwd?.message_id) {
            bot.telegram.deleteMessage(sinkChatId, fwd.message_id).catch(()=>{});
        }
        return true;
    } catch(e) {
        const desc = String(e.description || e.message || '').toLowerCase();
        if (desc.includes('not found') || desc.includes('to forward') || desc.includes('message_id_invalid')) return false;
        return null; // unbekannter Fehler — sicherheitshalber nicht löschen
    }
}

async function quickSyncThread(threadId, limit = 12) {
    if (!GROUP_B_ID) return 0;
    if (_qsBusy.has(threadId)) return 0;
    const last = _qsLast.get(threadId) || 0;
    if (Date.now() - last < 8000) return 0;
    _qsBusy.add(threadId);
    _qsLast.set(threadId, Date.now());
    try {
        const arr = d.threadMessages?.[threadId] || [];
        const candidates = arr.filter(m => m && m.msg_id).slice(0, limit);
        if (!candidates.length) return 0;
        const results = await Promise.allSettled(candidates.map(async m => {
            const exists = await _probeMessageExists(m.msg_id);
            return exists === false ? Number(m.msg_id) : null;
        }));
        const toRemove = new Set(results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean));
        if (toRemove.size) {
            d.threadMessages[threadId] = arr.filter(m => !toRemove.has(Number(m.msg_id)));
            const thr = (d.threads||[]).find(t => String(t.id) === threadId);
            if (thr) { thr.last_msg = d.threadMessages[threadId][0] || null; thr.msg_count = d.threadMessages[threadId].length; }
            if (threadId === 'general' && d.communityFeed?.length) {
                d.communityFeed = d.communityFeed.filter(m => !toRemove.has(Number(m.msg_id)));
            }
            speichern();
            console.log(`⚡ quickSyncThread ${threadId}: ${toRemove.size} entfernt`);
        }
        return toRemove.size;
    } finally { _qsBusy.delete(threadId); }
}

app.get('/thread-messages/:threadId', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const tid = req.params.threadId;
    // Quick-Sync: wartet max 1.5s auf Telegram-Probe der letzten 12 Nachrichten
    try { await Promise.race([quickSyncThread(tid, 12), new Promise(r => setTimeout(r, 1500))]); } catch(_) {}
    let msgs = d.threadMessages[tid] || [];
    if (!msgs.length && tid === 'general' && d.communityFeed?.length) {
        msgs = d.communityFeed.map(m => ({
            uid: String(m.uid || ''), tgName: m.username || null,
            name: m.name || m.username || 'Unbekannt', role: null,
            type: 'text', text: m.text || '', mediaId: null,
            timestamp: m.timestamp, msg_id: m.msg_id
        }));
    }
    res.json({ messages: msgs });
});

app.post('/send-thread-message', async (req, res) => {
    const { text, uid, thread_id, replyTo } = req.body || {};
    if (!text?.trim()) return res.json({ ok: false, error: 'Kein Text' });
    const u = d.users[String(uid)];
    if (!u) return res.json({ ok: false, error: 'User nicht gefunden' });
    const tgName = u.username ? '@' + u.username : (u.spitzname || u.name || 'User');
    const label = (u.role || '🆕') + ' ' + tgName;
    const tid = String(thread_id || 'general');
    if (!d.threadMessages[tid]) d.threadMessages[tid] = [];
    const entry = {
        uid: String(uid),
        tgName,
        name: u.spitzname || u.name || tgName,
        role: u.role || null,
        type: 'text',
        text: text.trim(),
        mediaId: null,
        timestamp: Date.now(),
        msg_id: null,
        replyTo: replyTo ? { timestamp: replyTo.timestamp, name: replyTo.name, text: (replyTo.text||'').slice(0,100), msgId: replyTo.msgId } : null
    };
    d.threadMessages[tid].unshift(entry);
    if (d.threadMessages[tid].length > 200) d.threadMessages[tid] = d.threadMessages[tid].slice(0, 200);
    if (!d.threads) d.threads = [];
    let thr = d.threads.find(t => String(t.id) === tid);
    if (thr) { thr.last_msg = entry; thr.msg_count = d.threadMessages[tid].length; }
    // 💎 alle 10 sinnvolle Thread-Nachrichten ein Diamant.
    // Anti-Spam: min 10 Zeichen + min 60 Sek seit letzter gezählter Nachricht.
    if (!istAdminId(uid)) {
        const trimmed = text.trim();
        const SPAM_MIN_LEN = 10, SPAM_COOLDOWN_MS = 60000;
        const now = Date.now();
        if (trimmed.length >= SPAM_MIN_LEN && (now - (u.lastCountedThreadMsg||0)) >= SPAM_COOLDOWN_MS) {
            u.lastCountedThreadMsg = now;
            u.threadMsgCount = (u.threadMsgCount||0) + 1;
            if (u.threadMsgCount % 10 === 0) {
                addDiamond(uid, 1);
                dmUser(uid, `💎 *${u.threadMsgCount} Thread-Nachrichten!*\n\nDanke für dein Engagement — +1 Diamant.\nAktuell: ${u.diamonds||0} 💎`, { parse_mode: 'Markdown' });
            }
        }
    }
    speichernDebounced();
    res.json({ ok: true });
    // Telegram-Nachricht asynchron (kein await → blockiert Response nicht)
    if (GROUP_B_ID) {
        const opts = { parse_mode: 'Markdown' };
        if (tid !== 'general') opts.message_thread_id = Number(tid);
        if (replyTo?.msgId) opts.reply_to_message_id = Number(replyTo.msgId);
        bot.telegram.sendMessage(GROUP_B_ID, `${label}:\n${text.trim()}`, opts)
            .then(sent => { entry.msg_id = sent.message_id; speichernDebounced(); })
            .catch(e => console.log('Thread-Telegram-Send Fehler:', e.message));
    }
});

// DM-Nachrichten-Reaktionen — gleiche Shape wie thread-msg-api: reactions = { emoji: [uid, ...] }
app.post('/react-dm-msg-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { chatKey, timestamp, emoji, uid } = req.body || {};
    if (!chatKey || !timestamp || !emoji || !uid) return res.json({ok:false});
    const msgs = d.messages?.[String(chatKey)] || [];
    const msg = msgs.find(m => Number(m.timestamp) === Number(timestamp));
    if (!msg) return res.json({ok:false, error:'Nachricht nicht gefunden'});
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const uidStr = String(uid);
    const idx = msg.reactions[emoji].indexOf(uidStr);
    if (idx >= 0) {
        msg.reactions[emoji].splice(idx, 1);
        if (!msg.reactions[emoji].length) delete msg.reactions[emoji];
    } else {
        msg.reactions[emoji].push(uidStr);
    }
    speichern();
    res.json({ok:true});
});

app.post('/react-thread-msg-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { threadId, timestamp, emoji, uid } = req.body || {};
    if (!threadId || !timestamp || !emoji || !uid) return res.json({ok:false});
    const msgs = d.threadMessages?.[String(threadId)] || [];
    const msg = msgs.find(m => m.timestamp === Number(timestamp));
    if (!msg) return res.json({ok:false});
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const uidStr = String(uid);
    const idx = msg.reactions[emoji].indexOf(uidStr);
    if (idx >= 0) {
        msg.reactions[emoji].splice(idx, 1);
        if (!msg.reactions[emoji].length) delete msg.reactions[emoji];
    } else {
        msg.reactions[emoji].push(uidStr);
    }
    speichern();
    if (msg.msg_id && GROUP_B_ID) {
        try {
            const reactionEmojis = Object.keys(msg.reactions||{}).slice(0,3);
            await bot.telegram.callApi('setMessageReaction', {
                chat_id: GROUP_B_ID,
                message_id: Number(msg.msg_id),
                reaction: reactionEmojis.map(e=>({type:'emoji',emoji:e})),
                is_big: false
            });
        } catch(e) {}
    }
    res.json({ ok: true, reactions: msg.reactions });
});

app.post('/create-thread', async (req, res) => {
    const { name, emoji, uid } = req.body || {};
    if (!name?.trim()) return res.json({ ok: false, error: 'Kein Name' });
    if (!istAdminId(Number(uid))) return res.json({ ok: false, error: 'Kein Admin' });
    try {
        const result = await bot.telegram.callApi('createForumTopic', { chat_id: GROUP_B_ID, name: name.trim(), ...(emoji ? { icon_emoji_id: emoji } : {}) });
        const newThread = { id: result.message_thread_id, name: result.name, emoji: emoji || '💬', last_msg: null, msg_count: 0 };
        if (!d.threads) d.threads = [];
        d.threads.push(newThread);
        speichern();
        res.json({ ok: true, thread: newThread });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/complete-profile-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid } = req.body || {};
    if (!uid) return res.json({ok:false});
    const u = d.users[String(uid)];
    if (!u || u.profileCompletionRewarded) return res.json({ok:false, alreadyRewarded:true});
    u.profileCompletionRewarded = true;
    u.diamonds = (u.diamonds||0) + 1;
    speichern();
    addNotification(String(uid), '🏆', 'Profil 100% vollständig! Du erhältst 💎 1 Diamant als Belohnung!');
    res.json({ ok: true, diamonds: u.diamonds });
});

app.post('/buy-item-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, itemId } = req.body || {};
    if (!uid || !itemId) return res.json({ok:false, error:'Fehlende Parameter'});
    const u = d.users[String(uid)];
    if (!u) return res.json({ok:false, error:'User nicht gefunden'});
    if (!u.inventory) u.inventory = [];
    if (u.inventory.includes(itemId)) return res.json({ok:false, error:'Item bereits besessen'});
    const ITEM_PRICES = {
        ring_flame:8, ring_ocean:8, ring_gold:10, ring_purple:12, ring_rainbow:15, ring_diamond:20,
        banner_sunset:5, banner_peach:5, banner_mint:5, banner_forest:5,
        banner_ocean:7, banner_sky:7, banner_lavender:7, banner_rose:7,
        banner_gold:10, banner_candy:10, banner_coral:10, banner_aurora:10,
    };
    const price = ITEM_PRICES[itemId];
    if (!price) return res.json({ok:false, error:'Unbekanntes Item'});
    const isAdmin = istAdminId(Number(uid));
    if (!isAdmin && (u.diamonds||0) < price) return res.json({ok:false, error:`Nicht genug Diamanten (benötigt: ${price})`});
    if (!isAdmin) u.diamonds = (u.diamonds||0) - price;
    u.inventory.push(itemId);
    speichern();
    const itemNames = {
        ring_flame:'🔥 Flame Ring', ring_ocean:'🌊 Ocean Ring', ring_gold:'✨ Gold Ring', ring_purple:'🔮 Cosmic Ring', ring_rainbow:'🌈 Rainbow Ring', ring_diamond:'💎 Diamond Ring',
        banner_sunset:'🌅 Sunset Banner', banner_ocean:'🌊 Ocean Banner', banner_forest:'🌿 Forest Banner', banner_candy:'🍭 Candy Banner',
        banner_sky:'☁️ Sky Blue Banner', banner_lavender:'💜 Lavender Banner', banner_mint:'🌱 Mint Banner', banner_peach:'🍑 Peach Banner',
        banner_gold:'✨ Golden Hour Banner', banner_coral:'🪸 Coral Banner', banner_aurora:'🌌 Aurora Banner', banner_rose:'🌹 Rose Gold Banner',
    };
    addNotification(String(uid), '🎁', `${itemNames[itemId]||itemId} gekauft! Wähle es in deinem Profil unter "Items" aus.${isAdmin ? ' (Admin – kostenlos)' : ` 💎 -${price} Diamanten.`}`);
    res.json({ ok: true, diamonds: u.diamonds, inventory: u.inventory });
});

app.post('/set-active-ring-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, ringId } = req.body || {};
    if (!uid) return res.json({ok:false});
    const u = d.users[String(uid)];
    if (!u) return res.json({ok:false});
    if (ringId && !(u.inventory||[]).includes(ringId)) return res.json({ok:false, error:'Item nicht im Inventar'});
    u.activeRing = ringId || null;
    speichern();
    res.json({ ok: true, activeRing: u.activeRing });
});

app.post('/buy-extralink-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid } = req.body || {};
    if (!uid) return res.json({ok:false, error:'Fehlende UID'});
    const u = d.users[String(uid)];
    if (!u) return res.json({ok:false, error:'User nicht gefunden'});
    const isAdminEl = istAdminId(Number(uid));
    if (!isAdminEl && (u.diamonds||0) < 5) return res.json({ok:false, error:'Nicht genug Diamanten (benötigt: 5)'});
    if (!isAdminEl) u.diamonds = (u.diamonds||0) - 5;
    if (!d.bonusLinks) d.bonusLinks = {};
    d.bonusLinks[String(uid)] = (d.bonusLinks[String(uid)] || 0) + 1;
    speichern();
    addNotification(String(uid), '🔗', `Extra-Link gekauft! Du kannst heute einen zusätzlichen Link posten.${isAdminEl ? ' (Admin – kostenlos)' : ' 💎 -5 Diamanten.'}`);
    res.json({ ok: true, diamonds: u.diamonds, bonusLinks: d.bonusLinks[String(uid)] });
});

app.get('/link-status-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String(req.query.uid || '');
    if (!uid) return res.json({ok:false});
    const heute = new Date().toDateString();
    const todayCount = Object.values(d.links).filter(l =>
        String(l.user_id) === String(uid) && new Date(l.timestamp).toDateString() === heute
    ).length;
    const bonusLinks = d.bonusLinks?.[uid] || 0;
    const isAdmin = istAdminId(Number(uid));
    const u = d.users[uid];
    const badgeBonus = !isAdmin && badgeBonusLinks(u?.xp||0) > 0 && (!d.badgeTracker?.[uid] || d.badgeTracker[uid] !== heute) ? 1 : 0;
    const maxLinks = isAdmin ? 999 : 1 + bonusLinks + badgeBonus;
    const canPost = isAdmin || todayCount < maxLinks;
    res.json({ ok: true, todayCount, bonusLinks, badgeBonus, maxLinks, canPost, isAdmin });
});

app.get('/mission-status-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String(req.query.uid || '');
    if (!uid) return res.json({ok:false});
    const heute = new Date().toDateString();
    const mission = getMission(uid);
    const wMission = getWochenMission(uid);
    const heuteLinks = Object.values(d.links).filter(l =>
        istInstagramLink(l.text) && new Date(l.timestamp).toDateString() === heute && String(getRootUid(l.user_id)) !== String(getRootUid(uid))
    );
    const gesamt = heuteLinks.length;
    const geliked = heuteLinks.filter(l => l.likes && l.likes.has(String(uid))).length;
    const prozent = gesamt > 0 ? Math.round((geliked / gesamt) * 100) : 0;
    // FIX: m2/m3 live aus aktuellen Zahlen berechnen — die gespeicherten Felder werden nur
    // beim Like aktualisiert, nicht wenn später NEUE Links erscheinen. Vorher: User hatte
    // morgens 5/5 → m2/m3=true, abends sind's 7/19 → UI zeigt trotzdem ✅.
    const m2Live = gesamt > 0 && (geliked / gesamt) >= 0.8;
    const m3Target = Math.min(M3_CAP, gesamt);
    const m3Live = m3Target > 0 && geliked >= m3Target;
    // Cached-State wird synchron mit Live-Wahrheit gehalten — sonst läuft die Abend-Auswertung
    // (storedMission.m1/m2/m3) später mit veralteten Werten.
    if (mission.m2 !== m2Live) mission.m2 = m2Live;
    if (mission.m3 !== m3Live) mission.m3 = m3Live;
    // Count user's own Instagram posts today (excluded from gesamt since self-like is blocked)
    const eigenePosts = Object.values(d.links).filter(l =>
        istInstagramLink(l.text) && new Date(l.timestamp).toDateString() === heute && String(getRootUid(l.user_id)) === String(getRootUid(uid))
    ).length;
    res.json({
        ok: true,
        daily: {
            likesGegeben: mission.likesGegeben || 0,
            m1: mission.m1 || false,
            m2: m2Live,
            m3: m3Live,
            gesamtLinks: gesamt,
            gelikedLinks: geliked,
            m3Target,
            m3Cap: M3_CAP,
            prozent,
            eigenePosts,
            totalInklEigene: gesamt + eigenePosts,
            alleGeliked: gesamt > 0 && geliked === gesamt
        },
        weekly: {
            m1Tage: wMission.m1Tage || 0,
            m2Tage: wMission.m2Tage || 0,
            m3Tage: wMission.m3Tage || 0
        }
    });
});

app.get('/tg-file/:fileId', async (req, res) => {
    try {
        const file = await bot.telegram.getFile(req.params.fileId);
        res.redirect(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`);
    } catch (e) { res.status(404).json({ error: 'Datei nicht gefunden' }); }
});

app.post('/rename-thread', (req, res) => {
    const { uid, thread_id, name } = req.body || {};
    if (!uid || !thread_id || !name?.trim()) return res.json({ ok: false, error: 'Fehlende Parameter' });
    if (!d.threads) d.threads = [];
    let thr = d.threads.find(t => String(t.id) === String(thread_id));
    if (!thr) {
        thr = { id: thread_id === 'general' ? 'general' : Number(thread_id), name: name.trim(), emoji: '📌', last_msg: null, msg_count: 0 };
        d.threads.push(thr);
    } else {
        thr.name = name.trim();
    }
    speichern();
    res.json({ ok: true });
});

app.post('/mark-read', (req, res) => {
    const { uid, thread_id } = req.body || {};
    if (!uid || !thread_id) return res.json({ ok: false });
    if (!d.threadLastRead[uid]) d.threadLastRead[uid] = {};
    d.threadLastRead[uid][thread_id] = Date.now();
    speichern();
    res.json({ ok: true });
});

// ─── App-Community-Chat: globale Chat-Gruppe für alle App-User ────────────
// Storage: d.appChat = [{uid, name, text, image?, ts, deleted?}], FIFO max 1000.
// Read-Tracking: d.appChatLastRead[uid] = ts.
app.get('/app-chat', (req, res) => {
    const uid = String(req.query.uid || '');
    const since = Number(req.query.since || 0);
    if (!d.appChat) d.appChat = [];
    if (!d.appChatLastRead) d.appChatLastRead = {};
    // User der den Chat aufruft ist garantiert in der App → als Member markieren
    if (uid && d.users[uid]) { d.users[uid].appLastSeen = Date.now(); speichernDebounced(); }
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    // Lightweight Polling: bei since>0 nur neue Messages zurückgeben (Bandwidth/Speed)
    let msgs = since > 0 ? d.appChat.filter(m => (m.ts||0) > since) : d.appChat.slice(-limit);
    const lastRead = uid ? (d.appChatLastRead[uid] || 0) : 0;
    const unread = uid ? d.appChat.filter(m => (m.ts||0) > lastRead && String(m.uid) !== uid && !m.deleted).length : 0;
    // Member = User mit u.appUser-Flag (permanent gesetzt sobald User irgendeinen
    // App-Endpoint hittet). Sub-Accounts werden nicht doppelt gezählt.
    // Fallback für alte Daten: appLastSeen / password_hash / d.appActivity-Eintrag.
    const memberCount = Object.entries(d.users || {}).filter(([uid, u]) => {
        if (!u) return false;
        if (u.parent_uid) return false;
        if (u.appUser) return true;
        if (u.appLastSeen) return true;
        if (u.password_hash) return true;
        if (d.appActivity && d.appActivity[uid]) return true;
        return false;
    }).length;
    res.json({ ok: true, messages: msgs, lastRead, unread, memberCount });
});

app.post('/app-chat-send', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
    const image = (req.body && req.body.image) ? String(req.body.image).slice(0, 500000) : null;
    const replyToTs = Number((req.body && req.body.replyToTs) || 0);
    if (!uid || !d.users[uid]) return res.status(404).json({ ok: false, error: 'User nicht gefunden' });
    if (!text && !image) return res.status(400).json({ ok: false, error: 'Leer' });
    if (!d.appChat) d.appChat = [];
    const u = d.users[uid];
    u.appLastSeen = Date.now();
    const msg = {
        uid,
        name: u.spitzname || u.name || 'User',
        text,
        image: image || null,
        ts: Date.now()
    };
    // Reply-Snapshot: wir speichern die Original-Werte direkt mit, damit ein
    // späteres Delete des Parents den Quote nicht zerstört.
    if (replyToTs) {
        const parent = d.appChat.find(x => Number(x.ts) === replyToTs);
        if (parent) {
            msg.replyTo = {
                ts: Number(parent.ts),
                uid: String(parent.uid),
                name: parent.name || 'User',
                text: (parent.text || '').slice(0, 200),
                hasImage: !!parent.image
            };
        }
    }
    d.appChat.push(msg);
    if (d.appChat.length > 1000) d.appChat = d.appChat.slice(-1000);
    speichernDebounced();
    res.json({ ok: true, message: msg });
});

app.post('/app-chat-mark-read', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    if (!uid) return res.status(400).json({ ok: false });
    if (!d.appChatLastRead) d.appChatLastRead = {};
    d.appChatLastRead[uid] = Date.now();
    speichernDebounced();
    res.json({ ok: true });
});

app.post('/app-chat-delete', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const ts = Number((req.body && req.body.ts) || 0);
    if (!uid || !ts) return res.status(400).json({ ok: false });
    if (!d.appChat) d.appChat = [];
    const idx = d.appChat.findIndex(m => Number(m.ts) === ts);
    if (idx < 0) return res.status(404).json({ ok: false, error: 'Nicht gefunden' });
    const m = d.appChat[idx];
    const isOwner = String(m.uid) === uid;
    const isAdmin = istAdminId(Number(uid));
    if (!isOwner && !isAdmin) return res.status(403).json({ ok: false, error: 'Kein Zugriff' });
    // Soft-Delete: NUR Flag setzen, Text + Image bleiben erhalten (Recovery möglich).
    m.deleted = true;
    m.deletedAt = Date.now();
    m.deletedBy = uid;
    speichernDebounced();
    res.json({ ok: true });
});

// Admin-Endpoint: Soft-deleted Messages wiederherstellen.
// body: { uid, ts? (einzelne), all? (alle deleted), sinceTs? (alle deleted seit) }
app.post('/app-chat-restore', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const ts = Number((req.body && req.body.ts) || 0);
    const sinceTs = Number((req.body && req.body.sinceTs) || 0);
    if (!uid || !istAdminId(Number(uid))) return res.status(403).json({ ok: false, error: 'Nur Admin' });
    if (!d.appChat) d.appChat = [];
    let restored = 0;
    for (const m of d.appChat) {
        if (!m.deleted) continue;
        if (ts && Number(m.ts) !== ts) continue;
        if (sinceTs && (m.deletedAt || 0) < sinceTs) continue;
        if (!m.text && !m.image) continue; // Hart-zerstörte können nicht über diesen Pfad
        delete m.deleted;
        delete m.deletedAt;
        delete m.deletedBy;
        restored++;
    }
    if (restored > 0) speichernDebounced();
    const recoverable = d.appChat.filter(m => m.deleted && (m.text || m.image)).length;
    const lost = d.appChat.filter(m => m.deleted && !m.text && !m.image).length;
    res.json({ ok: true, restored, recoverable, lost });
});

// Auto-Restore beim Bot-Start: stellt Messages wieder her die durch das alte
// destruktive Delete (text='', image=null) zerstört wurden — sucht im letzten
// Backup nach den Originalen.
function autoRestoreAppChatFromBackup() {
    try {
        if (!d.appChat || !d.appChat.length) return;
        const lostMsgs = d.appChat.filter(m => m.deleted && !m.text && !m.image);
        if (!lostMsgs.length) { console.log('🔄 App-Chat Auto-Restore: keine zerstörten Messages'); return; }
        console.log('🔄 App-Chat Auto-Restore: ' + lostMsgs.length + ' zerstörte Messages — suche Backup…');
        const path = require('path');
        const dataDir = path.dirname(DATA_FILE);
        const baseName = path.basename(DATA_FILE, '.json');
        let files = [];
        try { files = fs.readdirSync(dataDir).filter(f => f.startsWith(baseName + '_backup_') && f.endsWith('.json')).sort().reverse(); } catch(e) {}
        if (!files.length) { console.log('  → kein Backup gefunden'); return; }
        let totalRestored = 0;
        for (const f of files) {
            try {
                const bk = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
                const bkChat = bk.appChat || [];
                const bkMap = new Map(bkChat.map(m => [Number(m.ts), m]));
                let restoredFromThis = 0;
                for (const m of d.appChat) {
                    if (!m.deleted || m.text || m.image) continue;
                    const orig = bkMap.get(Number(m.ts));
                    if (orig && (orig.text || orig.image) && !orig.deleted) {
                        m.text = orig.text || '';
                        m.image = orig.image || null;
                        delete m.deleted;
                        delete m.deletedAt;
                        delete m.deletedBy;
                        restoredFromThis++;
                        totalRestored++;
                    }
                }
                if (restoredFromThis > 0) console.log('  ✅ ' + restoredFromThis + ' aus ' + f);
                if (!d.appChat.find(m => m.deleted && !m.text && !m.image)) break;
            } catch (e) { console.log('  Backup-Parse-Fehler ' + f + ':', e.message); }
        }
        if (totalRestored > 0) { speichern(); console.log('🎉 Total: ' + totalRestored + ' App-Chat-Messages wiederhergestellt'); }
        else console.log('  → kein passender Eintrag im Backup (Backup älter als Messages)');
    } catch(e) { console.log('Auto-Restore Fehler:', e.message); }
}

// Reaction toggle: User klickt Emoji unter Message → add/remove
app.post('/app-chat-react', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const ts = Number((req.body && req.body.ts) || 0);
    const emoji = String((req.body && req.body.emoji) || '').slice(0, 8);
    if (!uid || !ts || !emoji) return res.status(400).json({ ok: false });
    if (!/[\p{Emoji}‍]+/u.test(emoji)) return res.status(400).json({ ok: false, error: 'Kein Emoji' });
    if (!d.appChat) d.appChat = [];
    const m = d.appChat.find(x => Number(x.ts) === ts);
    if (!m) return res.status(404).json({ ok: false, error: 'Nicht gefunden' });
    if (!m.reactions) m.reactions = {};
    // 1 User = 1 Reaction pro Message: User aus ALLEN anderen Emojis entfernen.
    let hadSameEmoji = false;
    for (const e of Object.keys(m.reactions)) {
        const i = m.reactions[e].indexOf(uid);
        if (i >= 0) {
            m.reactions[e].splice(i, 1);
            if (e === emoji) hadSameEmoji = true;
            if (m.reactions[e].length === 0) delete m.reactions[e];
        }
    }
    // Wenn User dasselbe Emoji nochmal antippt → Toggle (entfernt). Sonst → neues setzen.
    if (!hadSameEmoji) {
        if (!m.reactions[emoji]) m.reactions[emoji] = [];
        m.reactions[emoji].push(uid);
    }
    if (d.users[uid]) d.users[uid].appLastSeen = Date.now();
    speichernDebounced();
    res.json({ ok: true, reactions: m.reactions });
});

// ─── Funnel-Tracking (Landing → Login → Telegram → Email-Login) ─────────────
// Speichert Events als rolling 60-Tage-Liste in d.funnel.events
// + aggregierte Counter pro Tag in d.funnel.daily[YYYY-MM-DD]
// Plus Email-Login-Audit-Log in d.emailLoginLog (welche Email wann eingeloggt)
function ensureFunnelStore() {
    if (!d.funnel) d.funnel = { events: [], daily: {} };
    if (!d.emailLoginLog) d.emailLoginLog = [];
}
function trackFunnel(event, meta) {
    ensureFunnelStore();
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    d.funnel.events.push({ event: String(event||'').slice(0,40), ts: now, meta: meta || {} });
    // Rolling 60 Tage
    const cutoff = now - 60 * 24 * 60 * 60 * 1000;
    if (d.funnel.events.length > 5000 || d.funnel.events.length % 100 === 0) {
        d.funnel.events = d.funnel.events.filter(e => (e.ts||0) >= cutoff);
    }
    if (!d.funnel.daily[day]) d.funnel.daily[day] = {};
    d.funnel.daily[day][event] = (d.funnel.daily[day][event] || 0) + 1;
    // Daily-Map auch nach 90 Tagen aufräumen
    const keepDays = 90;
    const keepCutoff = new Date(now - keepDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const k of Object.keys(d.funnel.daily)) {
        if (k < keepCutoff) delete d.funnel.daily[k];
    }
}
function handleTrackFunnel(req, res) {
    const event = String((req.body && req.body.event) || '').trim();
    if (!event) return res.status(400).json({ ok: false });
    const meta = (req.body && typeof req.body.meta === 'object') ? req.body.meta : {};
    // Optional UID — wenn vorhanden + bekannt → mitspeichern (sonst anonym)
    const uid = String((req.body && req.body.uid) || '');
    if (uid && d.users[uid]) meta.uid = uid;
    // Light Sanitization auf häufige Felder
    if (meta.ua) meta.ua = String(meta.ua).slice(0, 200);
    if (meta.ref) meta.ref = String(meta.ref).slice(0, 300);
    if (meta.path) meta.path = String(meta.path).slice(0, 200);
    trackFunnel(event, meta);
    speichernDebounced();
    res.json({ ok: true });
}
app.post('/track-funnel', handleTrackFunnel);
app.post('/api/track-funnel', handleTrackFunnel);
// Email-Login-Audit: wird vom App-Bridge auf Erfolg/Misserfolg aufgerufen
app.post('/log-email-login', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    ensureFunnelStore();
    const email = String((req.body && req.body.email) || '').toLowerCase().trim().slice(0, 200);
    const success = !!(req.body && req.body.success);
    const method = String((req.body && req.body.method) || 'magic-link').slice(0, 30);
    const uid = String((req.body && req.body.uid) || '');
    const ip = String((req.body && req.body.ip) || '').slice(0, 64);
    const ua = String((req.body && req.body.ua) || '').slice(0, 200);
    if (!email) return res.status(400).json({ ok: false });
    d.emailLoginLog.push({ email, success, method, uid, ip, ua, ts: Date.now() });
    // Rolling 1000 Einträge
    if (d.emailLoginLog.length > 1000) d.emailLoginLog = d.emailLoginLog.slice(-1000);
    speichernDebounced();
    res.json({ ok: true });
});

app.post('/track-login', (req, res) => {
    const { uid } = req.body || {};
    if (!uid || !d.users[String(uid)]) return res.json({ ok: false });
    if (!d.dailyLogins[uid]) d.dailyLogins[uid] = 0;
    d.dailyLogins[uid]++;
    d.users[String(uid)].appLastSeen = Date.now();
    speichernDebounced();
    res.json({ ok: true });
});

// Leichtgewichtiges Heartbeat: App pingt das alle paar Minuten — markiert User als aktiv.
app.post('/app-presence', (req, res) => {
    const uid = String((req.body && req.body.uid) || '');
    if (!uid || !d.users[uid]) return res.json({ ok: false });
    d.users[uid].appLastSeen = Date.now();
    speichernDebounced();
    res.json({ ok: true });
});

app.post('/add-project-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, projectId, title, description, link, docName } = req.body || {};
    if (!uid || !projectId || !title?.trim()) return res.json({ok:false, error:'Fehlende Felder'});
    const u = d.users[String(uid)];
    if (!u) return res.json({ok:false, error:'User nicht gefunden'});
    if (!u.projects) u.projects = [];
    if (u.projects.length >= 2) return res.json({ok:false, error:'Max 2 Projekte erlaubt'});
    u.projects.push({ id: projectId, title: title.trim(), description: (description||'').trim(), link: (link||'').trim(), docName: (docName||'').trim(), timestamp: Date.now() });
    speichern();
    res.json({ok:true});
});

app.post('/update-project-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, projectId, title, description, link, docName } = req.body || {};
    if (!uid || !projectId || !title?.trim()) return res.json({ok:false, error:'Fehlende Felder'});
    const u = d.users[String(uid)];
    if (!u || !u.projects) return res.json({ok:false, error:'Projekt nicht gefunden'});
    const proj = u.projects.find(p => p.id === String(projectId));
    if (!proj) return res.json({ok:false, error:'Projekt nicht gefunden'});
    proj.title = title.trim();
    proj.description = (description||'').trim();
    proj.link = (link||'').trim();
    proj.docName = (docName||'').trim();
    speichern();
    res.json({ok:true});
});

app.post('/delete-project-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, projectId } = req.body || {};
    if (!uid || !projectId) return res.json({ok:false});
    const u = d.users[String(uid)];
    if (!u || !u.projects) return res.json({ok:false});
    u.projects = u.projects.filter(p => p.id !== String(projectId));
    speichern();
    res.json({ok:true});
});

function addDiamond(uid, amount) {
    const u = d.users[String(uid)];
    if (!u) return;
    if (u.diamonds === undefined) u.diamonds = 0;
    u.diamonds += amount;
}

app.post('/engage-pinned-post-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { engagerUid, ownerUid } = req.body || {};
    if (!engagerUid || !ownerUid || engagerUid === ownerUid) return res.json({ok:false});
    // Track per ENGAGER (nicht per Owner) — jeder User kann nur 1× pro Owner einen Diamant kriegen
    if (!d.pinnedEngages) d.pinnedEngages = {};
    if (!d.pinnedEngages[engagerUid]) d.pinnedEngages[engagerUid] = [];
    if (d.pinnedEngages[engagerUid].includes(String(ownerUid))) return res.json({ok:false, alreadyDone:true});
    d.pinnedEngages[engagerUid].push(String(ownerUid));
    // Belohnung an den ENGAGER (= der den pinned-link geliked hat) — nicht an den Owner
    addDiamond(engagerUid, 1);
    addNotification(engagerUid, '💎', 'Du hast einen Pinned-Post engagiert! +1 Diamant');
    // Bestätigungs-DM pro Like (jedes Mal, nicht nur einmalig — soll als Audit-Trail dienen)
    sendInAppDM(engagerUid,
        '📌 Pinned-Post engagiert\n\n' +
        'Du hast einen pinned Link engagiert und 1 💎 Diamant erhalten.\n\n' +
        'Du bestätigst hiermit den Post geliked, kommentiert, geteilt und gespeichert zu haben. ' +
        'Dies wird kontrolliert. Bei Schein-Engagement folgen Sanktionen.\n\n' +
        'Mehr im Explore → Regeln.');
    // Audit-Trail: Timestamp + ownerUid pro Engagement (für Dashboard-Anzeige)
    if (!d.pinnedEngageLog) d.pinnedEngageLog = [];
    d.pinnedEngageLog.push({ engagerUid: String(engagerUid), ownerUid: String(ownerUid), ts: Date.now() });
    if (d.pinnedEngageLog.length > 2000) d.pinnedEngageLog = d.pinnedEngageLog.slice(-2000);
    speichern();
    res.json({ok:true});
});

// Report a user (z.B. fake-pinned-like, fake-collab-like). Geht als
// Audit-Log + Admin-Notification, der Admin entscheidet manuell.
app.post('/report-user-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { reporterUid, targetUid, reason, context } = req.body || {};
    if (!reporterUid || !targetUid) return res.json({ok:false, error:'reporterUid+targetUid erforderlich'});
    if (reporterUid === targetUid) return res.json({ok:false, error:'Self-Report nicht erlaubt'});
    if (!d.users[reporterUid] || !d.users[targetUid]) return res.json({ok:false, error:'User nicht gefunden'});
    if (!d.reports) d.reports = [];
    d.reports.push({
        id: 'rep_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        reporterUid: String(reporterUid), targetUid: String(targetUid),
        reason: String(reason||'').slice(0,200),
        context: String(context||'').slice(0,200),
        ts: Date.now(), status: 'open',
    });
    if (d.reports.length > 1000) d.reports = d.reports.slice(-1000);
    // Admins benachrichtigen
    const adminIds = Array.isArray(d._adminIds) ? d._adminIds : [];
    const reporterName = d.users[reporterUid].spitzname || d.users[reporterUid].name || reporterUid;
    const targetName = d.users[targetUid].spitzname || d.users[targetUid].name || targetUid;
    for (const aId of adminIds) {
        addNotification(String(aId), '🚩', reporterName + ' meldet ' + targetName + (reason?' ('+String(reason).slice(0,40)+')':''), String(reporterUid));
    }
    speichern();
    res.json({ok:true});
});

// Admin User-Detail (Instagram-Insights-Style): alles was wir über einen User wissen
// in einer Response gebündelt — für das Dashboard-Detail-Modal.
app.get('/admin-user-detail-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.query && req.query.uid) || '');
    if (!uid) return res.status(400).json({ ok:false, error:'uid erforderlich' });
    const u = d.users[uid];
    if (!u) return res.status(404).json({ ok:false, error:'User nicht gefunden' });
    const adminIds = Array.isArray(d._adminIds) ? d._adminIds.map(Number) : [];
    const act = (d.appActivity && d.appActivity[uid]) || null;

    // Reports
    const reports = Array.isArray(d.reports) ? d.reports : [];
    const reportsAgainst = reports.filter(r => String(r.targetUid) === uid).map(r => ({
        id: r.id, reporterUid: r.reporterUid,
        reporterName: (d.users[r.reporterUid]?.spitzname || d.users[r.reporterUid]?.name || ('User ' + r.reporterUid)),
        reason: r.reason || '', context: r.context || '',
        ts: r.ts, status: r.status || 'open', action: r.action || null,
    }));
    const reportsMade = reports.filter(r => String(r.reporterUid) === uid).map(r => ({
        id: r.id, targetUid: r.targetUid,
        targetName: (d.users[r.targetUid]?.spitzname || d.users[r.targetUid]?.name || ('User ' + r.targetUid)),
        reason: r.reason || '', context: r.context || '',
        ts: r.ts, status: r.status || 'open',
    }));

    // Engagement counts
    let pinnedEngaged = 0, pinnedReceived = 0;
    for (const e of (d.pinnedEngageLog || [])) {
        if (String(e.engagerUid) === uid) pinnedEngaged++;
        if (String(e.ownerUid) === uid) pinnedReceived++;
    }
    let collabEngaged = 0, collabReceived = 0;
    for (const p of Object.values(d.collabPosts || {})) {
        const likes = Array.isArray(p.likes) ? p.likes : [];
        if (likes.includes(uid) || likes.includes(Number(uid))) collabEngaged++;
        if (String(p.uid) === uid || String(p.partnerUid) === uid) collabReceived += likes.length;
    }

    // Sub-Accounts (kids) + Parent
    const subAccounts = [];
    for (const [oUid, oU] of Object.entries(d.users || {})) {
        if (oU && String(oU.parent_uid) === uid) {
            subAccounts.push({
                uid: oUid, name: oU.spitzname || oU.name || ('Sub ' + oUid),
                joinDate: oU.joinDate || null, xp: oU.xp || 0, banned: !!oU.banned,
            });
        }
    }
    const parent = u.parent_uid && d.users[u.parent_uid]
        ? { uid: String(u.parent_uid), name: d.users[u.parent_uid].spitzname || d.users[u.parent_uid].name || ('User '+u.parent_uid) }
        : null;

    // Recent in-app notifications (last 20)
    const notifications = Array.isArray(d.notifications && d.notifications[uid])
        ? d.notifications[uid].slice(-20).reverse().map(n => ({ icon: n.icon||'', text: n.text||'', ts: n.ts||n.timestamp||null }))
        : [];

    res.json({
        ok: true,
        user: {
            uid, name: u.name||'', spitzname: u.spitzname||'', email: u.email||'',
            instagram: u.instagram||'', bio: u.bio||'', nische: u.nische||'', gender: u.gender||'',
            role: u.role||'', xp: u.xp||0, level: u.level||1, diamonds: u.diamonds||0,
            links: u.links||0, totalLikes: u.totalLikes||0, warnings: u.warnings||0,
            joinDate: u.joinDate||null, started: !!u.started, inGruppe: !!u.inGruppe,
            banned: !!u.banned, bannedAt: u.bannedAt||null,
            emailConfirmedAt: u.emailConfirmedAt||null,
            signupSource: u.signup_source||u.signupSource||null,
            profileCompletionRewarded: !!u.profileCompletionRewarded,
            isAdmin: adminIds.includes(Number(uid)),
            appUser: !!u.appUser,
            pinnedReel: u.pinnedReel || null,
            superlinkCredits: u.superlinkCredits || 0,
            extraLinks: u.extraLinks || 0,
        },
        activity: act ? {
            firstSeen: act.firstSeen, lastSeen: act.lastSeen, sessions: act.sessions||0,
            totalCalls: act.totalCalls||0, lastEndpoint: act.lastEndpoint||'',
            topEndpoints: Object.entries(act.endpoints||{}).sort((a,b)=>b[1]-a[1]).slice(0,5),
        } : null,
        engagement: {
            pinnedEngaged, pinnedReceived,
            collabEngaged, collabReceived,
        },
        reportsAgainst, reportsMade,
        subAccounts, parent,
        notifications,
    });
});

// Moderation-Queue: Admin bearbeitet einen Report. Aktionen:
//   dismiss  → Report als "harmlos" markieren (status='dismissed')
//   resolve  → Report als "erledigt" markieren (status='resolved')
//   warn     → Target +1 Warnung, DM, Report resolved
//   ban      → Target gebannt, DM, Report resolved
//   delete   → Report aus Liste entfernen
app.post('/admin-report-action-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const reportId = String((req.body && req.body.reportId) || '');
    const action = String((req.body && req.body.action) || '');
    const adminUid = String((req.body && req.body.adminUid) || '');
    if (!reportId || !action) return res.json({ ok:false, error:'reportId+action erforderlich' });
    if (!Array.isArray(d.reports)) d.reports = [];
    const idx = d.reports.findIndex(r => r && r.id === reportId);
    if (idx < 0) return res.status(404).json({ ok:false, error:'Report nicht gefunden' });
    const rep = d.reports[idx];

    if (action === 'delete') {
        d.reports.splice(idx, 1);
        speichern();
        return res.json({ ok:true });
    }
    if (action === 'dismiss') {
        rep.status = 'dismissed';
        rep.resolvedAt = Date.now();
        rep.resolvedBy = adminUid;
        speichern();
        return res.json({ ok:true });
    }
    if (action === 'resolve') {
        rep.status = 'resolved';
        rep.resolvedAt = Date.now();
        rep.resolvedBy = adminUid;
        speichern();
        return res.json({ ok:true });
    }
    if (action === 'warn') {
        const u = d.users[rep.targetUid];
        if (!u) return res.status(404).json({ ok:false, error:'Target-User nicht gefunden' });
        u.warnings = (u.warnings || 0) + 1;
        rep.status = 'resolved';
        rep.resolvedAt = Date.now();
        rep.resolvedBy = adminUid;
        rep.action = 'warn';
        speichern();
        try { await dmUser(rep.targetUid, `⚠️ *Verwarnung!*\n\nEin Admin hat dich verwarnt nach einer Meldung.\n\n⚠️ Warns: ${u.warnings}/5`, { parse_mode:'Markdown' }); } catch(e) {}
        addNotification(rep.targetUid, '⚠️', 'Du wurdest verwarnt nach einer Meldung. Warns: ' + u.warnings + '/5');
        return res.json({ ok:true, warnings: u.warnings });
    }
    if (action === 'ban') {
        const u = d.users[rep.targetUid];
        if (!u) return res.status(404).json({ ok:false, error:'Target-User nicht gefunden' });
        if (Array.isArray(d._adminIds) && d._adminIds.map(Number).includes(Number(rep.targetUid))) {
            return res.status(400).json({ ok:false, error:'Admins können nicht gebannt werden' });
        }
        u.banned = true;
        u.bannedAt = Date.now();
        u.inGruppe = false;
        u.started = false;
        if (d.dailyXP) delete d.dailyXP[rep.targetUid];
        if (d.weeklyXP) delete d.weeklyXP[rep.targetUid];
        if (d.bonusLinks) delete d.bonusLinks[rep.targetUid];
        if (d.missionen) delete d.missionen[rep.targetUid];
        if (d.wochenMissionen) delete d.wochenMissionen[rep.targetUid];
        if (d.userSessions) delete d.userSessions[rep.targetUid];
        for (const [otherUid, other] of Object.entries(d.users||{})) {
            if (other && other.parent_uid && String(other.parent_uid) === rep.targetUid) {
                other.banned = true; other.bannedAt = Date.now(); other.inGruppe = false; other.started = false;
            }
        }
        rep.status = 'resolved';
        rep.resolvedAt = Date.now();
        rep.resolvedBy = adminUid;
        rep.action = 'ban';
        speichern();
        try { await dmUser(rep.targetUid, `🚫 *Du wurdest gebannt*\n\nEin Admin hat dich nach einer Meldung aus der Community entfernt.`, { parse_mode:'Markdown' }); } catch(e) {}
        return res.json({ ok:true });
    }
    return res.json({ ok:false, error:'Unbekannte Action: ' + action });
});

// Dashboard-Datenquelle: alle Pinned-Engagements + Kollab-Likes mit Timestamps.
// Erlaubt Admin, im App-Dashboard zu sehen wer was wann engagiert hat.
app.get('/admin-engagement-log-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    // Pinned-Log: aus pinnedEngageLog (neuere) + Fallback aus pinnedEngages (ältere, ohne TS)
    const pinned = [];
    for (const e of (d.pinnedEngageLog || []).slice(-500).reverse()) {
        const eu = d.users[e.engagerUid] || {};
        const ou = d.users[e.ownerUid] || {};
        const pinnedUrl = ou.pinnedReel || null;
        pinned.push({
            engagerUid: e.engagerUid,
            engagerName: eu.spitzname || eu.name || 'User ' + e.engagerUid,
            engagerInstagram: eu.instagram || '',
            ownerUid: e.ownerUid,
            ownerName: ou.spitzname || ou.name || 'User ' + e.ownerUid,
            ownerInstagram: ou.instagram || '',
            ts: e.ts,
            pinnedUrl,
        });
    }
    // Kollab-Likes mit Timestamps (best-effort — likes-Array hat keine ts, also Post-Timestamps).
    const collabs = [];
    for (const p of Object.values(d.collabPosts || {})) {
        const a = d.users[p.uid] || {}, b = d.users[p.partnerUid] || {};
        for (const lUid of (Array.isArray(p.likes) ? p.likes : [])) {
            const lu = d.users[lUid] || {};
            collabs.push({
                postId: p.id, url: p.url, caption: (p.caption||'').slice(0, 100),
                authorA: { uid: p.uid, name: a.spitzname || a.name || 'User', instagram: a.instagram || '' },
                authorB: { uid: p.partnerUid, name: b.spitzname || b.name || 'User', instagram: b.instagram || '' },
                engagerUid: String(lUid),
                engagerName: lu.spitzname || lu.name || 'User ' + lUid,
                engagerInstagram: lu.instagram || '',
                createdAt: p.createdAt,
                week: p.week,
            });
        }
    }
    collabs.sort((a, b) => (b.createdAt||0) - (a.createdAt||0));
    // Reports angereichert mit Namen + Status (für Moderation-Queue im Dashboard)
    const reports = [];
    for (const r of (d.reports || []).slice().reverse()) {
        const rep = d.users[r.reporterUid] || {};
        const tgt = d.users[r.targetUid] || {};
        reports.push({
            id: r.id,
            reporterUid: r.reporterUid,
            reporterName: rep.spitzname || rep.name || ('User ' + r.reporterUid),
            reporterInstagram: rep.instagram || '',
            targetUid: r.targetUid,
            targetName: tgt.spitzname || tgt.name || ('User ' + r.targetUid),
            targetInstagram: tgt.instagram || '',
            targetWarnings: Number(tgt.warnings || 0),
            targetBanned: !!tgt.banned,
            reason: r.reason || '',
            context: r.context || '',
            ts: r.ts,
            status: r.status || 'open',
            resolvedAt: r.resolvedAt || null,
            resolvedBy: r.resolvedBy || null,
            action: r.action || null,
        });
    }
    res.json({ ok:true, pinned: pinned.slice(0, 500), collabs: collabs.slice(0, 500), reports });
});

app.post('/add-newsletter-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, title, content } = req.body || {};
    if (!uid || !content?.trim()) return res.json({ok:false, error:'Inhalt fehlt'});
    if (!istAdminId(Number(uid))) return res.json({ok:false, error:'Kein Admin'});
    if (!d.newsletter) d.newsletter = [];
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    const trimmedTitle = (title||'').trim();
    const trimmedContent = content.trim();
    d.newsletter.push({ id, title: trimmedTitle, content: trimmedContent, timestamp: Date.now() });
    // In-App-Notification an alle User (nicht-Admins, nicht-Subs)
    for (const [tUid, tU] of Object.entries(d.users||{})) {
        if (istAdminId(Number(tUid))) continue;
        if (tU.parent_uid) continue; // Subs kriegen Push via Parent's Subscription
        addNotification(tUid, '📩', (trimmedTitle || 'Neuer Newsletter-Eintrag').slice(0,60));
    }
    // Web-Push an ALLE Geräte (alle Push-Subscriptions). exceptUid=Admin selber, der schon weiß.
    const pushTitle = '📩 ' + (trimmedTitle || 'Neue News');
    const pushBody = trimmedContent.slice(0, 140) + (trimmedContent.length > 140 ? '…' : '');
    broadcastAppPush(pushTitle, pushBody, '/explore?tab=newsletter', String(uid)).catch(e=>console.log('News-Push Fehler:', e.message));
    // Telegram-DM an alle Telegram-User (nicht Admin/Sub). Markdown-safe escapen damit der Content
    // nicht den Markdown-Parser bricht (z.B. _ in Namen, * in Text).
    const mdEsc = (s) => String(s||'').replace(/[_*`\[\]]/g, c=>'\\'+c);
    const dmContent = trimmedContent.length > 600 ? trimmedContent.slice(0, 600) + '\n\n…' : trimmedContent;
    const dmText = '📩 *' + mdEsc(trimmedTitle || 'Neue News') + '*\n\n' + mdEsc(dmContent) + '\n\n━━━━━━━━━━━━━━\n👉 In der App lesen';
    setTimeout(async () => {
        let sent = 0, failed = 0;
        for (const [tUid, tU] of Object.entries(d.users||{})) {
            if (istAdminId(Number(tUid)) || tU.parent_uid || !tU.started) continue;
            try {
                await bot.telegram.sendMessage(Number(tUid), dmText, {
                    parse_mode: 'Markdown',
                    reply_markup: APP_URL ? { inline_keyboard: [[{ text: '📲 Zur App', url: APP_URL }]] } : undefined
                });
                sent++;
                await new Promise(r => setTimeout(r, 120)); // Rate-Limit-Schutz (~8/Sek)
            } catch(e) { failed++; }
        }
        console.log('[news] Telegram-DM: ' + sent + ' gesendet, ' + failed + ' fehlgeschlagen');
    }, 0);
    speichern();
    res.json({ok:true});
});

app.post('/edit-newsletter-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, id, title, content } = req.body || {};
    if (!uid || !id || !content?.trim()) return res.json({ok:false});
    if (!istAdminId(Number(uid))) return res.json({ok:false, error:'Kein Admin'});
    const entry = (d.newsletter||[]).find(e=>e.id===id);
    if (!entry) return res.json({ok:false, error:'Nicht gefunden'});
    entry.title = (title||'').trim();
    entry.content = content.trim();
    entry.editedAt = Date.now();
    speichern();
    res.json({ok:true});
});

app.post('/delete-newsletter-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, id } = req.body || {};
    if (!uid || !id) return res.json({ok:false});
    if (!istAdminId(Number(uid))) return res.json({ok:false, error:'Kein Admin'});
    d.newsletter = (d.newsletter||[]).filter(e=>e.id!==id);
    speichern();
    res.json({ok:true});
});

// ── SUPERLINK APIs ──
app.get('/superlinks', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const sls = Object.values(d.superlinks||{}).sort((a,b)=>b.timestamp-a.timestamp);
    res.json({ superlinks: sls, fullEngagementThreadId: d.fullEngagementThreadId });
});

app.post('/like-superlink-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { slId, uid } = req.body || {};
    if (!slId || !uid) return res.json({ok:false, error:'Fehlende Felder'});
    const sl = d.superlinks?.[slId];
    if (!sl) return res.json({ok:false, error:'Superlink nicht gefunden'});
    if (String(sl.uid) === String(uid)) return res.json({ok:false, error:'Eigener Post'});
    if (String(getRootUid(uid)) === String(getRootUid(sl.uid))) return res.json({ok:false, error:'Eigener Account — kein Self-Like'});
    if (!Array.isArray(sl.likes)) sl.likes = [];
    if (!sl.likerNames) sl.likerNames = {};
    const idx = sl.likes.indexOf(String(uid));
    // Engagement-Pflicht: einmal geliked = erfüllt. Unlike NICHT erlaubt (analog zum
    // Telegram-Button-Callback Line 2233 + zur /like-from-app Logik). Vorher konnte
    // App-User über direkten API-Hit den Like wieder entfernen → Pflicht-Bypass.
    if (idx >= 0) {
        return res.json({ok:true, liked:true, likes: sl.likes.length});
    }
    {
        sl.likes.push(String(uid));
        const u = d.users[String(uid)];
        sl.likerNames[String(uid)] = u?.spitzname||u?.name||'User';
        addNotification(String(sl.uid), '❤️', (u?.spitzname||u?.name||'User') + ' hat deinen Superlink geliked!');
        sendAppPush(String(sl.uid), '⭐ Superlink geliked!', (u?.spitzname||u?.name||'User') + ' hat deinen Superlink geliked', '/feed?tab=engagement').catch(()=>{});
        // Reminder-DM in Liker-Chat löschen
        if (sl.dmNotifications && sl.dmNotifications[String(uid)]) {
            bot.telegram.deleteMessage(Number(uid), sl.dmNotifications[String(uid)]).catch(()=>{});
            delete sl.dmNotifications[String(uid)];
        }
    }
    speichern();
    updateSuperLinkCard(slId).catch(()=>{});
    res.json({ok:true, liked: idx<0, likes: sl.likes.length});
});

app.post('/post-superlink-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, url, caption } = req.body || {};
    if (!uid || !url) return res.json({ok:false, error:'Fehlende Felder'});
    const u = d.users[String(uid)];
    if (!u) return res.json({ok:false, error:'User nicht gefunden'});
    if (!u.instagram) return res.json({ok:false, error:'Bitte zuerst /setinsta im Bot setzen'});
    if (!isSuperLinkPostingAllowed()) return res.json({ok:false, error:'Superlinks können nur Mo–Sa (bis 23:58) gepostet werden — Sonntag ist Auswertung'});
    const week = getBerlinWeekKey();
    const isElitePlusSL = u.role === '🌟 Elite+';
    const maxSL = isElitePlusSL ? 2 : 1;
    const slThisWeekCount = Object.values(d.superlinks||{}).filter(s=>s.uid===String(uid)&&s.week===week).length;
    const hasSlCredit = Number(u.superlinkCredits||0) > 0;
    // Superlink-Credits (z.B. aus Gewinnspiel/Roulette via /add-superlink) ignorieren
    // das maxSL-Wochenlimit. Sie kosten auch keine 10💎 für Extra-Slots —
    // werden direkt vom u.superlinkCredits-Counter abgezogen.
    if (slThisWeekCount >= maxSL && !hasSlCredit) return res.json({ok:false, error:'Du hast diese Woche bereits ' + maxSL + ' Superlink(s) gepostet'});
    const usesSlCredit = slThisWeekCount >= maxSL && hasSlCredit;
    const isAdminSL = istAdminId(Number(uid));
    // First superlink each week is free; extra slots (Elite+) cost 10 diamonds.
    // Credits haben Vorrang vor dem Extra-Slot-Diamond-Preis.
    const isExtraSlot = !usesSlCredit && slThisWeekCount > 0;
    if (!isAdminSL && isExtraSlot && (u.diamonds||0) < 10) return res.json({ok:false, error:'Nicht genug Diamanten (benötigt: 💎 10 für Extra-Superlink)'});
    if (!url.includes('instagram.com')) return res.json({ok:false, error:'Nur Instagram-Links erlaubt'});
    let feThreadId;
    try { feThreadId = await ensureFullEngagementThread(); } catch(e) {}
    if (!feThreadId) return res.json({ok:false, error:'Full Engagement Thread nicht verfügbar'});
    const slId = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    const cardText = buildSuperLinkKarte(u?.spitzname||u?.name||'User', u.instagram, url, caption||'', 0, {});
    try {
        const sent = await bot.telegram.sendMessage(GROUP_B_ID, cardText, {
            parse_mode: 'HTML',
            message_thread_id: Number(feThreadId),
            reply_markup: buildSuperLinkButtons(slId, 0)
        });
        d.superlinks = d.superlinks || {};
        const newSL = { id: slId, uid: String(uid), url, caption: caption||'', msg_id: sent.message_id, timestamp: Date.now(), week, likes: [], likerNames: {} };
        d.superlinks[slId] = newSL;
        tryFetchThumbnail(newSL, 'url');
        if (!isAdminSL && isExtraSlot) u.diamonds = (u.diamonds||0) - 10;
        if (usesSlCredit) u.superlinkCredits = Math.max(0, Number(u.superlinkCredits||0) - 1);
        speichern();
        // In-App DM von CreatorBoost an den Poster (Pflicht-Reminder + Regel-Link).
        // Telegram-DM bewusst weggelassen — Telegram-Bot deckt seinen Flow selbst ab.
        try {
            const rulesUrl = (APP_URL || 'https://web-production-7981d.up.railway.app').replace(/\/$/,'') + '/explore?tab=regeln#r-superlinks';
            sendCreatorBoostDM(uid,
                '⭐ Dein Superlink wurde gepostet!\n\nDu hast heute einen Superlink gepostet — vergiss nicht: Du musst alle Superlinks dieser Woche engagieren (Liken, Kommentieren, Teilen, Speichern) bis Sonntag 23:59 Uhr.',
                { link: { url: rulesUrl, label: '📖 Superlink-Regeln' } });
        } catch(e) {}
        // DM an alle anderen Poster dieser Woche → führt direkt in den Engagement-Feed der App
        const posterUser = d.users[String(uid)];
        const otherPosters2 = Object.values(d.superlinks).filter(s => s.week === week && s.uid !== String(uid));
        const slApi = d.superlinks[slId];
        if (slApi) slApi.dmNotifications = slApi.dmNotifications || {};
        for (const other of otherPosters2) {
            try {
                const magicUrl2 = buildMagicLinkUrl(other.uid, '/feed?tab=engagement');
                const dmMsg = await bot.telegram.sendMessage(Number(other.uid),
                    `⭐ *Neuer Superlink!*\n\n👤 ${posterUser?.spitzname||posterUser?.name||'Ein User'} hat einen Superlink gepostet.\n🔗 ${url}\n\n⚠️ Liken, Kommentieren, Teilen & Speichern ist Pflicht!`,
                    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📲 Im Engagement-Feed öffnen', url: magicUrl2 }]] } }
                );
                if (slApi && dmMsg?.message_id) slApi.dmNotifications[String(other.uid)] = dmMsg.message_id;
                sendAppPush(String(other.uid), '⭐ Neuer Superlink!', (posterUser?.spitzname||posterUser?.name||'Jemand') + ' hat einen Superlink gepostet — engagen!', '/feed?tab=engagement').catch(()=>{});
            } catch(e) {}
        }
        res.json({ok:true, slId});
    } catch(e) { res.json({ok:false, error:'Telegram Fehler: '+e.message}); }
});

app.post('/report-nonengager-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { reporterUid, likerUid, slId } = req.body || {};
    if (!reporterUid || !likerUid || !slId) return res.json({ok:false});
    const sl = d.superlinks?.[slId];
    if (!sl || String(sl.uid) !== String(reporterUid)) return res.json({ok:false, error:'Nur Poster kann reporten'});
    const reporter = d.users[String(reporterUid)];
    const liker = d.users[String(likerUid)];
    const msg = `🚨 *Engagement Report*\n\nPoster: ${reporter?.spitzname||reporter?.name||'User'}\nGemeldet: ${liker?.spitzname||liker?.name||'User'}\nLink: ${sl.url}\nGrund: Hat nicht geliked/kommentiert/geteilt/gespeichert`;
    for (const adminId of ADMIN_IDS) {
        try { await bot.telegram.sendMessage(adminId, msg, { parse_mode: 'Markdown' }); } catch(e){}
    }
    res.json({ok:true});
});

// ── ADMIN API: merge + delete ───────────────────────────────────────────

app.post('/admin/merge-users', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const srcInput = req.body && req.body.source_uid ? String(req.body.source_uid) : '';
    const tgtInput = req.body && req.body.target_uid ? String(req.body.target_uid) : '';
    if (!srcInput || !tgtInput) return res.status(400).json({ ok: false, error: 'source_uid und target_uid erforderlich' });
    const sourceUid = _findUser(srcInput);
    const targetUid = _findUser(tgtInput);
    if (!sourceUid) return res.status(404).json({ ok: false, error: 'Quell-User nicht gefunden: ' + srcInput });
    if (!targetUid) return res.status(404).json({ ok: false, error: 'Ziel-User nicht gefunden: ' + tgtInput });
    if (sourceUid === targetUid) return res.status(400).json({ ok: false, error: 'Quell und Ziel sind der gleiche User (' + sourceUid + ')' });

    const srcName = d.users[sourceUid].spitzname || d.users[sourceUid].name || sourceUid;
    const tgtName = d.users[targetUid].spitzname || d.users[targetUid].name || targetUid;
    const result = _mergeUserData(sourceUid, targetUid);
    if (!result.ok) return res.status(500).json(result);

    console.log('[MERGE-API] ' + sourceUid + ' → ' + targetUid + ': ' + result.log.join(', '));
    res.json({ ok: true, source: { uid: sourceUid, name: srcName }, target: { uid: targetUid, name: tgtName }, log: result.log });
});

app.post('/admin/delete-user', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const input = req.body && req.body.uid ? String(req.body.uid) : '';
    if (!input) return res.status(400).json({ ok: false, error: 'uid erforderlich' });
    const uid = _findUser(input);
    if (!uid) return res.status(404).json({ ok: false, error: 'User nicht gefunden: ' + input });
    if (istAdminId(Number(uid))) return res.status(403).json({ ok: false, error: 'Admin-Accounts können nicht gelöscht werden' });

    const userName = d.users[uid].spitzname || d.users[uid].name || uid;
    const result = _deleteUser(uid);
    if (!result.ok) return res.status(500).json(result);

    console.log('[DELETE-API] User ' + uid + ' (' + userName + ') gelöscht');
    res.json({ ok: true, uid, name: userName });
});

// ════════════════════════════════════════════════════════════════
//  COLLABORATION-POSTS
// ════════════════════════════════════════════════════════════════
// Boost-Window: 7 Tage lang erscheint jeder Kollab-Post alle 4h
// für 20min im normalen Heute-Feed. Liken während Boost gibt +1
// Extra-Diamant (zusätzlich zum Standard-1-Diamant).
const COLLAB_BOOST_TOTAL_MS  = 7 * 24 * 3600 * 1000;
const COLLAB_BOOST_CYCLE_MS  = 4 * 3600 * 1000;
const COLLAB_BOOST_WINDOW_MS = 20 * 60 * 1000;
function collabBoostState(post, now) {
    now = now || Date.now();
    const age = now - (post?.createdAt || 0);
    if (age < 0 || age > COLLAB_BOOST_TOTAL_MS) {
        return { active: false, endsAt: null, nextStartAt: null, expired: age > COLLAB_BOOST_TOTAL_MS };
    }
    const cyclePos = age % COLLAB_BOOST_CYCLE_MS;
    if (cyclePos < COLLAB_BOOST_WINDOW_MS) {
        return { active: true, endsAt: now + (COLLAB_BOOST_WINDOW_MS - cyclePos), nextStartAt: null, expired: false };
    }
    const nextStartAt = now + (COLLAB_BOOST_CYCLE_MS - cyclePos);
    // Aber nur wenn nächster Slot noch innerhalb der 7-Tage-Lifetime liegt
    const nextSlotAge = age + (COLLAB_BOOST_CYCLE_MS - cyclePos);
    return { active: false, endsAt: null, nextStartAt: nextSlotAge <= COLLAB_BOOST_TOTAL_MS ? nextStartAt : null, expired: false };
}

//  Datenmodell:
//    u.collaborations = [{ partnerUid, since }]
//    u.collabPostThisWeek = berlin-week-key (block double-post pro Woche)
//    u.collabFeedRulesAcceptedAt = ts (1× Modal abgehakt)
//    u.collabRulesDMSent = ts (1× DM beim ersten Engage)
//    d.collabRequests[reqId] = { fromUid, toUid, ts, status: 'pending'|'accepted'|'declined' }
//    d.collabPosts[postId] = { id, uid, partnerUid, url, caption, likes:Set, likeCount,
//                              createdAt, week, comments:[], shares:[] }
// ════════════════════════════════════════════════════════════════

function _collabEnsure() {
    if (!d.collabRequests) d.collabRequests = {};
    if (!d.collabPosts) d.collabPosts = {};
}
function _collabPartnerLink(uid) {
    const u = d.users[uid]; if (!u) return [];
    return Array.isArray(u.collaborations) ? u.collaborations.slice() : [];
}
function _collabHasPair(uidA, uidB) {
    const a = _collabPartnerLink(uidA);
    return a.some(c => String(c.partnerUid) === String(uidB));
}
function _collabValidUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return /https?:\/\/(www\.)?instagram\.com\//i.test(url) && url.length <= 500;
}

// Anfrage an einen User
app.post('/collab-request-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    _collabEnsure();
    const fromUid = String((req.body && req.body.fromUid) || '');
    const toUid = String((req.body && req.body.toUid) || '');
    if (!fromUid || !toUid) return res.json({ ok:false, error:'fromUid + toUid erforderlich' });
    if (fromUid === toUid) return res.json({ ok:false, error:'Self-Collab nicht erlaubt' });
    if (!d.users[fromUid] || !d.users[toUid]) return res.json({ ok:false, error:'User nicht gefunden' });
    if (_collabHasPair(fromUid, toUid)) return res.json({ ok:false, error:'Ihr seid bereits Kollab-Partner' });
    // Existierender Pending-Request in eine Richtung blockieren
    const existing = Object.entries(d.collabRequests).find(([, r]) =>
        r.status === 'pending' && ((String(r.fromUid)===fromUid && String(r.toUid)===toUid) || (String(r.fromUid)===toUid && String(r.toUid)===fromUid)));
    if (existing) return res.json({ ok:false, error:'Anfrage existiert bereits', reqId: existing[0] });

    const reqId = 'cr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    d.collabRequests[reqId] = { id: reqId, fromUid, toUid, ts: Date.now(), status: 'pending' };
    speichern();

    const fromName = d.users[fromUid]?.spitzname || d.users[fromUid]?.name || 'Ein User';
    addNotification(toUid, '🤝', fromName + ' möchte mit dir eine Kollaboration eingehen', fromUid);
    sendInAppDM(toUid,
        '🤝 Kollab-Anfrage\n\n' + fromName + ' möchte mit dir eine Kollaboration eingehen.\n' +
        'Wenn du akzeptierst, dürft ihr gemeinsam 1× pro Woche einen Kollab-Post veröffentlichen.\n\n' +
        '→ Öffne deine Benachrichtigungen um zu antworten.');
    speichern();
    res.json({ ok:true, reqId });
});

// Antwort auf Anfrage
app.post('/collab-respond-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    _collabEnsure();
    const reqId = String((req.body && req.body.reqId) || '');
    const accept = !!(req.body && req.body.accept);
    const callerUid = String((req.body && req.body.callerUid) || '');
    const r = d.collabRequests[reqId];
    if (!r) return res.json({ ok:false, error:'Anfrage nicht gefunden' });
    if (r.status !== 'pending') return res.json({ ok:false, error:'Anfrage schon beantwortet' });
    if (String(r.toUid) !== callerUid) return res.json({ ok:false, error:'Nur der Empfänger kann antworten' });

    r.status = accept ? 'accepted' : 'declined';
    r.respondedAt = Date.now();
    const fromU = d.users[r.fromUid];
    const toU = d.users[r.toUid];

    if (accept && fromU && toU) {
        if (!Array.isArray(fromU.collaborations)) fromU.collaborations = [];
        if (!Array.isArray(toU.collaborations)) toU.collaborations = [];
        if (!_collabHasPair(r.fromUid, r.toUid)) fromU.collaborations.push({ partnerUid: r.toUid, since: Date.now() });
        if (!_collabHasPair(r.toUid, r.fromUid)) toU.collaborations.push({ partnerUid: r.fromUid, since: Date.now() });
        const fromName = fromU.spitzname || fromU.name || 'Partner';
        const toName = toU.spitzname || toU.name || 'Partner';
        addNotification(r.fromUid, '🎉', toName + ' hat deine Kollab-Anfrage angenommen', r.toUid);
        sendInAppDM(r.fromUid, '🎉 Kollaboration aktiv!\n\nDu bist jetzt Kollab-Partner mit ' + toName + '.\nIhr könnt im + Menü "🤝 Kollab-Link" auswählen — 1× pro Woche.');
        sendInAppDM(r.toUid, '🎉 Kollaboration aktiv!\n\nDu bist jetzt Kollab-Partner mit ' + fromName + '.\nIhr könnt im + Menü "🤝 Kollab-Link" auswählen — 1× pro Woche.');
    } else if (!accept && fromU) {
        const toName = toU?.spitzname || toU?.name || 'Der User';
        addNotification(r.fromUid, '❌', toName + ' hat deine Kollab-Anfrage abgelehnt', r.toUid);
    }
    speichern();
    res.json({ ok:true, status: r.status });
});

// Liste Partner + pending requests für UID
app.get('/collab-list-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    _collabEnsure();
    const uid = String(req.query.uid || '');
    if (!uid) return res.json({ ok:false, error:'uid fehlt' });
    const u = d.users[uid] || {};
    const partners = (u.collaborations||[]).map(c => {
        const p = d.users[c.partnerUid] || {};
        return { uid: c.partnerUid, name: p.spitzname || p.name || 'User', since: c.since, instagram: p.instagram || '' };
    });
    const pendingIn = Object.values(d.collabRequests).filter(r => r.status==='pending' && String(r.toUid)===uid).map(r => {
        const f = d.users[r.fromUid] || {};
        return { reqId: r.id, fromUid: r.fromUid, name: f.spitzname || f.name || 'User', instagram: f.instagram || '', ts: r.ts };
    });
    const pendingOut = Object.values(d.collabRequests).filter(r => r.status==='pending' && String(r.fromUid)===uid).map(r => {
        const t = d.users[r.toUid] || {};
        return { reqId: r.id, toUid: r.toUid, name: t.spitzname || t.name || 'User', instagram: t.instagram || '', ts: r.ts };
    });
    const week = getBerlinWeekKey();
    const postedThisWeek = u.collabPostThisWeek === week;
    res.json({ ok:true, partners, pendingIn, pendingOut, postedThisWeek, currentWeek: week, rulesAccepted: !!u.collabFeedRulesAcceptedAt });
});

// ════════════════════════════════════════════════════════════════
//  DIAMANTLINKS — Premium-Posts mit Vollengagement
// ════════════════════════════════════════════════════════════════
//   Kosten 30 💎, 3 Tage im Feed an erster Stelle (älteste zuerst).
//   Liker bekommen +3 💎. Posts bleiben FOREVER im Admin-Dashboard
//   (soft-delete via deletedAt), damit Betrug kontrolliert werden kann.
//
//   d.diamondLinks[id] = { id, uid, url, caption, createdAt, expiresAt,
//                          likes:[], deletedAt? }
//   u.diamondRulesAcceptedAt — Modal bestätigt
const DIAMOND_LINK_COST = 30;
const DIAMOND_LINK_REWARD = 3;
const DIAMOND_LINK_LIFETIME_MS = 3 * 24 * 3600 * 1000; // 3 Tage

function _diamondEnsure() {
    if (!d.diamondLinks) d.diamondLinks = {};
}
function _diamondActive(p) {
    return p && !p.deletedAt && p.expiresAt > Date.now();
}

// Liste aktive Diamantlinks (sortiert ASC nach createdAt — älteste zuerst, wie gewünscht)
app.get('/diamond-link-feed-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    _diamondEnsure();
    const callerUid = String(req.query.uid || '');
    const caller = d.users[callerUid] || {};
    const now = Date.now();
    const posts = Object.values(d.diamondLinks)
        .filter(_diamondActive)
        .sort((a,b) => (a.createdAt||0) - (b.createdAt||0))
        .map(p => {
            const author = d.users[p.uid] || {};
            const likes = Array.isArray(p.likes) ? p.likes.map(String) : [];
            return {
                id: p.id, uid: p.uid, url: p.url, caption: p.caption,
                createdAt: p.createdAt, expiresAt: p.expiresAt,
                remainingMs: Math.max(0, p.expiresAt - now),
                likeCount: likes.length,
                liked: callerUid ? likes.includes(callerUid) : false,
                isSelf: callerUid && String(p.uid) === callerUid,
                author: { uid: p.uid, name: author.spitzname || author.name || 'User', instagram: author.instagram || '' },
                reward: DIAMOND_LINK_REWARD,
            };
        });
    res.json({ ok:true, posts, rulesAccepted: !!caller.diamondRulesAcceptedAt, cost: DIAMOND_LINK_COST, reward: DIAMOND_LINK_REWARD });
});

// Diamantlink erstellen — 30 💎 Kosten, 3 Tage Lifetime
app.post('/diamond-link-create-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    _diamondEnsure();
    const uid = String((req.body && req.body.uid) || '');
    const url = String((req.body && req.body.url) || '').trim();
    const caption = String((req.body && req.body.caption) || '').slice(0, 500);
    const u = d.users[uid];
    if (!u) return res.json({ ok:false, error:'User nicht gefunden' });
    if (!/https?:\/\/(www\.)?instagram\.com\//i.test(url) || url.length > 500) {
        return res.json({ ok:false, error:'Ungültige Instagram-URL' });
    }
    if ((u.diamonds||0) < DIAMOND_LINK_COST && !istAdminId(uid)) {
        return res.json({ ok:false, error:'Du hast nur '+(u.diamonds||0)+' 💎 — du brauchst '+DIAMOND_LINK_COST+' 💎' });
    }
    // 30 💎 abziehen (Admin gratis)
    const wasAdmin = istAdminId(uid);
    if (!wasAdmin) u.diamonds = (u.diamonds||0) - DIAMOND_LINK_COST;
    const id = 'dl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const now = Date.now();
    d.diamondLinks[id] = {
        id, uid, url, caption,
        createdAt: now,
        expiresAt: now + DIAMOND_LINK_LIFETIME_MS,
        likes: [],
        adminFree: wasAdmin || undefined,
    };
    speichern();
    sendInAppDM(uid,
        '💎 Diamantlink veröffentlicht!\n\n' +
        'Dein Post ist 3 Tage im Feed an erster Stelle.\n' +
        (wasAdmin ? '⚙️ Admin: gratis (keine Kosten)\n' : 'Kosten: −' + DIAMOND_LINK_COST + ' 💎 (Aktuell: ' + u.diamonds + ' 💎)\n') +
        '\nJeder Liker bekommt +' + DIAMOND_LINK_REWARD + ' 💎. Der Post muss FULL ENGAGED werden ' +
        '(Like + Kommentar + Teilen + Speichern). Schein-Engagement wird hart sanktioniert.');
    res.json({ ok:true, id, adminFree: wasAdmin });
});

// Like + 3 💎 für den Liker + DM
app.post('/diamond-link-like-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    _diamondEnsure();
    const uid = String((req.body && req.body.uid) || '');
    const postId = String((req.body && req.body.postId) || '');
    const u = d.users[uid];
    const p = d.diamondLinks[postId];
    if (!u) return res.json({ ok:false, error:'User nicht gefunden' });
    if (!p) return res.json({ ok:false, error:'Post nicht gefunden' });
    if (!_diamondActive(p)) return res.json({ ok:false, error:'Post abgelaufen oder gelöscht' });
    if (String(p.uid) === uid) return res.json({ ok:false, error:'collaborator-self-like', message:'Kein Self-Like für eigene Diamantlinks' });
    if (!Array.isArray(p.likes)) p.likes = [];
    if (p.likes.includes(uid)) return res.json({ ok:true, liked:true, likeCount: p.likes.length, already:true });
    p.likes.push(uid);
    if (!p.engagedAt) p.engagedAt = {};
    p.engagedAt[uid] = Date.now();
    // +3 💎 für Liker
    addDiamond(uid, DIAMOND_LINK_REWARD);
    addNotification(p.uid, '💎', (u.spitzname || u.name || 'User') + ' hat deinen Diamantlink engagiert', uid);
    // DM mit Regeln + Bestätigung
    sendInAppDM(uid,
        '💎 Diamantlink engagiert\n\n' +
        'Du hast einen Diamantlink engagiert und +' + DIAMOND_LINK_REWARD + ' 💎 erhalten.\n\n' +
        'Du bestätigst hiermit den Post:\n' +
        '✓ geliked\n' +
        '✓ kommentiert\n' +
        '✓ geteilt\n' +
        '✓ gespeichert\n\n' +
        'Dies wird kontrolliert. Bei Schein-Engagement: XP-Abzug + Diamonds-Reset + Bann.\n\n' +
        'Mehr im Explore → Regeln → 💎 Diamantlinks.');
    speichern();
    res.json({ ok:true, liked:true, likeCount: p.likes.length, diamondsTotal: u.diamonds || 0 });
});

// Modal-Akzeptanz speichern
app.post('/diamond-link-accept-rules-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const u = d.users[uid];
    if (!u) return res.json({ ok:false, error:'User nicht gefunden' });
    if (!u.diamondRulesAcceptedAt) {
        u.diamondRulesAcceptedAt = Date.now();
        speichern();
    }
    res.json({ ok:true });
});

// Admin: ALLE Diamantlinks (auch expired + deleted) für Dashboard-Übersicht
app.get('/diamond-link-admin-list-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    _diamondEnsure();
    const now = Date.now();
    const out = Object.values(d.diamondLinks)
        .sort((a,b) => (b.createdAt||0) - (a.createdAt||0))
        .map(p => {
            const author = d.users[p.uid] || {};
            const likes = Array.isArray(p.likes) ? p.likes : [];
            const engagers = likes.map(lUid => {
                const lu = d.users[lUid] || {};
                return {
                    uid: String(lUid),
                    name: lu.spitzname || lu.name || ('User '+lUid),
                    instagram: lu.instagram || '',
                    engagedAt: p.engagedAt?.[lUid] || null,
                };
            });
            return {
                id: p.id, uid: p.uid, url: p.url, caption: p.caption,
                createdAt: p.createdAt, expiresAt: p.expiresAt, deletedAt: p.deletedAt || null,
                active: !p.deletedAt && p.expiresAt > now,
                likeCount: likes.length,
                author: { uid: p.uid, name: author.spitzname || author.name || 'User', instagram: author.instagram || '' },
                engagers,
            };
        });
    res.json({ ok:true, posts: out, cost: DIAMOND_LINK_COST, reward: DIAMOND_LINK_REWARD });
});

// Admin: Soft-Delete (Post bleibt in d.diamondLinks aber active=false)
app.post('/diamond-link-admin-delete-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    _diamondEnsure();
    const postId = String((req.body && req.body.postId) || '');
    const p = d.diamondLinks[postId];
    if (!p) return res.json({ ok:false, error:'Post nicht gefunden' });
    p.deletedAt = Date.now();
    speichern();
    res.json({ ok:true });
});

// Kollab-Post erstellen
app.post('/collab-create-post-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    _collabEnsure();
    const uid = String((req.body && req.body.uid) || '');
    const partnerUid = String((req.body && req.body.partnerUid) || '');
    const url = String((req.body && req.body.url) || '').trim();
    const caption = String((req.body && req.body.caption) || '').slice(0, 500);
    if (!d.users[uid]) return res.json({ ok:false, error:'User nicht gefunden' });
    if (!d.users[partnerUid]) return res.json({ ok:false, error:'Partner nicht gefunden' });
    if (!_collabHasPair(uid, partnerUid)) return res.json({ ok:false, error:'Keine Kollaboration mit diesem User' });
    if (!_collabValidUrl(url)) return res.json({ ok:false, error:'Ungültige Instagram-URL' });
    const week = getBerlinWeekKey();
    const u = d.users[uid], p = d.users[partnerUid];
    if (u.collabPostThisWeek === week) return res.json({ ok:false, error:'Du hast diese Woche schon einen Kollab-Post veröffentlicht' });
    if (p.collabPostThisWeek === week) return res.json({ ok:false, error:'Dein Partner hat diese Woche schon einen Kollab-Post veröffentlicht' });

    const postId = 'cp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    d.collabPosts[postId] = {
        id: postId, uid, partnerUid, url, caption,
        likes: [], likeCount: 0,
        createdAt: Date.now(), week,
    };
    u.collabPostThisWeek = week;
    p.collabPostThisWeek = week;
    speichern();

    const fromName = u.spitzname || u.name || 'Dein Partner';
    addNotification(partnerUid, '🤝', fromName + ' hat euren Kollab-Post veröffentlicht', uid);
    sendInAppDM(partnerUid, '🤝 Kollab-Post live!\n\n' + fromName + ' hat euren gemeinsamen Kollab-Post veröffentlicht.\nUser können ihn jetzt im Feed → 🤝 Kollabs engagieren.');
    speichern();
    res.json({ ok:true, postId });
});

// Feed: alle aktiven Kollab-Posts
app.get('/collab-feed-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    _collabEnsure();
    const callerUid = String(req.query.uid || '');
    const week = getBerlinWeekKey();
    const _nowB = Date.now();
    const out = Object.values(d.collabPosts || {})
        .sort((a, b) => (b.createdAt||0) - (a.createdAt||0))
        .slice(0, 100)
        .map(p => {
            const likes = Array.isArray(p.likes) ? p.likes.map(String) : [];
            const a = d.users[p.uid] || {}, b = d.users[p.partnerUid] || {};
            const boost = collabBoostState(p, _nowB);
            return {
                id: p.id, uid: p.uid, partnerUid: p.partnerUid, url: p.url, caption: p.caption,
                likeCount: likes.length,
                liked: callerUid ? likes.includes(callerUid) : false,
                isSelf: callerUid && (callerUid === String(p.uid) || callerUid === String(p.partnerUid)),
                createdAt: p.createdAt, week: p.week,
                authorA: { uid: p.uid, name: a.spitzname || a.name || 'User', instagram: a.instagram || '' },
                authorB: { uid: p.partnerUid, name: b.spitzname || b.name || 'User', instagram: b.instagram || '' },
                boostActive: boost.active,
                boostEndsAt: boost.endsAt,
                boostNextStartAt: boost.nextStartAt,
                boostExpired: boost.expired,
            };
        });
    res.json({ ok:true, posts: out, currentWeek: week, boostWindowMs: COLLAB_BOOST_WINDOW_MS, boostCycleMs: COLLAB_BOOST_CYCLE_MS });
});

// Like + 1 Diamant
app.post('/collab-like-post-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    _collabEnsure();
    const uid = String((req.body && req.body.uid) || '');
    const postId = String((req.body && req.body.postId) || '');
    const p = d.collabPosts[postId];
    if (!p) return res.json({ ok:false, error:'Post nicht gefunden' });
    const u = d.users[uid];
    if (!u) return res.json({ ok:false, error:'User nicht gefunden' });
    if (uid === String(p.uid) || uid === String(p.partnerUid)) {
        return res.json({ ok:false, error:'collaborator-self-like', message:'Kein Self-Like für Kollaboratoren' });
    }
    if (!Array.isArray(p.likes)) p.likes = [];
    if (p.likes.includes(uid)) return res.json({ ok:true, liked:true, likeCount: p.likes.length, already:true });
    p.likes.push(uid);
    p.likeCount = p.likes.length;
    // Base-Reward: +1 💎 für jeden Like. Boost-Window aktiv: zusätzlicher +1 💎 (= total 2 💎).
    const boost = collabBoostState(p, Date.now());
    let diamondsGiven = 1;
    addDiamond(uid, 1);
    if (boost.active) { addDiamond(uid, 1); diamondsGiven = 2; }
    addNotification(p.uid, '🤝❤️', (u.spitzname || u.name || 'User') + ' hat euren Kollab-Post geliked' + (boost.active ? ' (Boost-Slot!)' : ''), uid);
    addNotification(p.partnerUid, '🤝❤️', (u.spitzname || u.name || 'User') + ' hat euren Kollab-Post geliked' + (boost.active ? ' (Boost-Slot!)' : ''), uid);

    // Regel-DM einmalig — als In-App-DM (kein Telegram)
    let dmSentNow = false;
    if (!u.collabRulesDMSent) {
        sendInAppDM(uid,
            '🤝 Kollab-Post engagiert\n\n' +
            'Du hast deinen ersten Kollab-Post engagiert! Die Regeln nochmal kurz:\n\n' +
            '• Zuerst auf Instagram öffnen → LIKEN, KOMMENTIEREN, SPEICHERN und TEILEN\n' +
            '• Dann hier in der App ✅ tippen\n' +
            '• Pro engagiertem Kollab-Post bekommst du 1 💎 Diamant\n' +
            '• Im Reel muss sichtbar sein, dass beide Parteien zusammenarbeiten (z.B. Logos beider Creator, gemeinsamer Branding-Frame oder beide @-Handles)\n' +
            '• Reine Schein-Likes und Posts ohne sichtbare Zusammenarbeit werden sanktioniert\n\n' +
            'Mehr im Explore → Regeln → 🤝 Kollabs. Viel Erfolg!');
        u.collabRulesDMSent = Date.now();
        dmSentNow = true;
    }
    // Boost-Bonus-DM (separate vom Regel-DM)
    if (boost.active) {
        sendInAppDM(uid,
            '🤝⚡ Kollab-Boost-Slot!\n\n' +
            'Du hast den Kollab-Post während eines Boost-Slots engagiert → +1 💎 Extra-Diamant (' + diamondsGiven + ' total).\n\n' +
            'Kollab-Posts erscheinen 7 Tage lang alle 4h für 20 Minuten im Feed mit Boost-Bonus.');
    }
    speichern();
    res.json({ ok:true, liked:true, likeCount: p.likes.length, diamondsTotal: u.diamonds || 0, rulesDmSent: dmSentNow, diamondsGiven, boostActive: boost.active });
});

// Feed-Regeln akzeptieren (1× pro User)
app.post('/collab-accept-feed-rules-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String((req.body && req.body.uid) || '');
    const u = d.users[uid];
    if (!u) return res.json({ ok:false, error:'User nicht gefunden' });
    if (!u.collabFeedRulesAcceptedAt) {
        u.collabFeedRulesAcceptedAt = Date.now();
        speichern();
    }
    res.json({ ok:true, acceptedAt: u.collabFeedRulesAcceptedAt });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('🌐 Dashboard läuft auf Port ' + PORT); });

bot.launch().then(() => {
    // App-Chat Auto-Restore: zerstörte Messages aus letztem Backup wiederherstellen
    try { autoRestoreAppChatFromBackup(); } catch(e) {}
    // One-time Cleanup: User die mehrere Reactions auf gleicher Message haben →
    // nur die ERSTE behalten (Migration zur 1-Reaction-pro-User-Regel)
    try {
        let cleanedMsgs = 0, removed = 0;
        for (const m of (d.appChat || [])) {
            if (!m.reactions) continue;
            const seen = new Set();
            let touched = false;
            for (const e of Object.keys(m.reactions)) {
                m.reactions[e] = m.reactions[e].filter(uid => {
                    if (seen.has(String(uid))) { removed++; touched = true; return false; }
                    seen.add(String(uid));
                    return true;
                });
                if (m.reactions[e].length === 0) { delete m.reactions[e]; touched = true; }
            }
            if (touched) cleanedMsgs++;
        }
        if (cleanedMsgs > 0) { speichern(); console.log('🧹 Reaction-Cleanup: ' + cleanedMsgs + ' Messages, ' + removed + ' Mehrfach-Reactions entfernt'); }
    } catch(e) { console.log('Reaction-Cleanup Fehler:', e.message); }
    // One-time Backfill: u.appUser=true für alle User mit historischer App-Aktivität
    try {
        let backfilled = 0;
        for (const [uid, e] of Object.entries(d.appActivity || {})) {
            if (d.users[uid] && !d.users[uid].appUser) { d.users[uid].appUser = true; backfilled++; }
        }
        for (const [uid, u] of Object.entries(d.users || {})) {
            if (!u || u.appUser) continue;
            if (u.password_hash || u.appLastSeen) { u.appUser = true; backfilled++; }
        }
        if (backfilled > 0) { speichern(); console.log('📡 appUser-Flag Backfill: ' + backfilled + ' User markiert'); }
    } catch(e) { console.log('appUser-Backfill Fehler:', e.message); }
    setTimeout(async () => {
        if (!GROUP_B_ID) { console.log('⚠️ GROUP_B_ID nicht gesetzt – Full Engagement Thread übersprungen'); return; }
        try {
            // Prüfe ob gespeicherter Thread noch existiert
            if (d.fullEngagementThreadId) {
                try {
                    const topics = await bot.telegram.callApi('getForumTopics', { chat_id: GROUP_B_ID, limit: 100 });
                    const exists = topics.topics?.some(t => t.message_thread_id === Number(d.fullEngagementThreadId));
                    if (!exists) {
                        console.log('⚠️ Full Engagement Thread nicht mehr gefunden, erstelle neu...');
                        d.fullEngagementThreadId = null;
                    }
                } catch(e) { console.log('Thread-Check Fehler:', e.message); }
            }
            const wasNull = !d.fullEngagementThreadId;
            const threadId = await ensureFullEngagementThread();
            if (wasNull && threadId) {
                await bot.telegram.sendMessage(GROUP_B_ID,
                    '⭐ *Full Engagement Thread geöffnet!*\n\n' +
                    'Hier könnt ihr eure Superlinks posten.\n\n' +
                    '📌 *Regeln:*\n• 1–2 Superlinks pro Person pro Woche (Mo–Sa)\n• Wer postet, muss ALLE anderen liken, kommentieren, teilen & speichern\n• Verstoß: -50 XP\n\n' +
                    '📲 Einfach euren Instagram-Link hier reinposten oder /superlink im Bot nutzen!',
                    { parse_mode: 'Markdown', message_thread_id: Number(threadId) }
                );
            }
            if (threadId) console.log('✅ Full Engagement Thread bereit:', threadId);
        } catch(e) { console.log('Startup Engagement Fehler:', e.message); }
    }, 5000);
});
console.log('🤖 Bot läuft!');

// Migrate communityFeed → threadMessages['general'] on startup
function migriereAlteDaten() {
    if (!d.communityFeed?.length) return;
    if (!d.threadMessages) d.threadMessages = {};
    if (!d.threadMessages['general']) d.threadMessages['general'] = [];
    const existingIds = new Set(d.threadMessages['general'].map(m => m.msg_id));
    let added = 0;
    for (const m of d.communityFeed) {
        if (!existingIds.has(m.msg_id)) {
            d.threadMessages['general'].push({
                uid: String(m.uid || ''),
                tgName: m.username || null,
                name: m.name || m.username || 'Unbekannt',
                role: null, type: 'text', text: m.text || '',
                mediaId: null,
                timestamp: m.timestamp,
                msg_id: m.msg_id
            });
            added++;
        }
    }
    d.threadMessages['general'].sort((a, b) => b.timestamp - a.timestamp);
    if (d.threadMessages['general'].length > 100) d.threadMessages['general'] = d.threadMessages['general'].slice(0, 100);
    if (added > 0) { console.log(`✅ ${added} alte Nachrichten nach threadMessages['general'] migriert`); speichern(); }
}

async function ladeForumTopics() {
    if (!GROUP_B_ID) return;
    try {
        const result = await bot.telegram.callApi('getForumTopics', { chat_id: GROUP_B_ID, limit: 100 });
        const topics = result?.topics || [];
        const existing = new Map((d.threads || []).map(t => [String(t.id), t]));
        const updated = topics.map(t => {
            const ex = existing.get(String(t.message_thread_id));
            return { id: t.message_thread_id, name: t.name, emoji: t.icon_emoji_id || '💬', last_msg: ex?.last_msg || null, msg_count: ex?.msg_count || (d.threadMessages[String(t.message_thread_id)] || []).length };
        });
        const gen = existing.get('general');
        const generalEntry = { id: 'general', name: 'Allgemein', emoji: '💬', last_msg: gen?.last_msg || (d.threadMessages['general']?.[0] || null), msg_count: (d.threadMessages['general'] || []).length };
        d.threads = [generalEntry, ...updated];
        console.log(`✅ ${d.threads.length} Forum-Topics geladen`);
    } catch (e) { console.log('Forum Topics Fehler (normal wenn keine Forum-Gruppe):', e.message); }
}

setTimeout(() => { migriereAlteDaten(); ladeForumTopics(); }, 2000);

process.on('unhandledRejection', (reason) => {
    const msg = reason?.message || reason?.description || String(reason);
    const code = reason?.code || reason?.response?.error_code || '';
    const desc = reason?.response?.description || '';
    console.log('🔴 Unhandled:', code, msg, desc ? ('| ' + desc) : '');
    if (reason?.stack) console.log(reason.stack);
});
process.on('uncaughtException', (error) => {
    console.log('🔴 Uncaught:', error.message);
    if (error.stack) console.log(error.stack);
});
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

(async () => { await checkInstagramForAllUsers(); })();



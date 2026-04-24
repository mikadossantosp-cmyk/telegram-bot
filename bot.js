import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import express from 'express';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ BOT TOKEN FEHLT!'); process.exit(1); }

const DATA_FILE      = process.env.DATA_FILE || '/data/daten.json';
const DASHBOARD_URL  = process.env.DASHBOARD_URL || '';
const BRIDGE_SECRET  = process.env.BRIDGE_SECRET || 'geheimer-key';
const BRIDGE_BOT_URL = process.env.BRIDGE_BOT_URL || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || 'admin';
const ADMIN_IDS      = new Set((process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean));
const GROUP_A_ID     = Number(process.env.GROUP_A_ID);
const GROUP_B_ID     = Number(process.env.GROUP_B_ID);
const MEINE_GRUPPE   = 'B';

process.env.TZ = 'Europe/Berlin';

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const dashboardSessions = new Map();
function generateSessionId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function isAuthenticated(req) {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/dashSession=([^;]+)/);
    return match ? dashboardSessions.has(match[1]) : false;
}
function getSessionId(req) {
    const cookie = req.headers.cookie || '';
    const match = cookie.match(/dashSession=([^;]+)/);
    return match ? match[1] : null;
}

function istAdminId(uid) { return ADMIN_IDS.has(Number(uid)); }

let d = {
    users: {}, chats: {}, links: {},
    tracker: {}, counter: {}, warte: {},
    gepostet: [], seasonStart: Date.now(),
    seasonGewinner: [],
    dailyXP: {}, weeklyXP: {},
    dailyReset: null, weeklyReset: null,
    bonusLinks: {},
    wochenGewinnspiel: { aktiv: true, gewinner: [], letzteAuslosung: null },
    warteNachricht: {}, dmNachrichten: {}, instaWarte: {},
    missionen: {}, wochenMissionen: {},
    missionQueue: {}, missionQueueVerarbeitet: null,
    missionAuswertungErledigt: {},
    gesternDailyXP: {},
    badgeTracker: {},
    m1Streak: {},
    backupDatum: null,
    _lastEvents: {},
    xpEvent: { aktiv: false, multiplier: 1, start: null, end: null, announced: false },
};

function laden() {
    try {
        if (!fs.existsSync(DATA_FILE)) return;
        const geladen = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        d = Object.assign({}, d, geladen);
        for (const uid in d.users) {
            d.users[uid].started = true;
            if (!d.users[uid].instagram) d.users[uid].instagram = null;
            if (istAdminId(Number(uid))) { d.users[uid].xp = 0; d.users[uid].level = 1; d.users[uid].role = '⚙️ Admin'; }
        }
        for (const k of Object.keys(d.links)) {
            const link = d.links[k];
            link.likes = new Set(Array.isArray(link.likes) ? link.likes : []);
            link.msgId = Number(k);
            if (!link.likerNames) link.likerNames = {};
            if (!link.counter_msg_id || !link.chat_id) { delete d.links[k]; continue; }
        }
        const defaults = {
            dailyXP: {}, weeklyXP: {}, bonusLinks: {}, missionen: {}, wochenMissionen: {},
            warteNachricht: {}, dmNachrichten: {}, instaWarte: {}, missionQueue: {},
            gesternDailyXP: {}, badgeTracker: {}, m1Streak: {}, missionAuswertungErledigt: {},
            _lastEvents: {},
            wochenGewinnspiel: { aktiv: true, gewinner: [], letzteAuslosung: null },
            xpEvent: { aktiv: false, multiplier: 1, start: null, end: null, announced: false },
        };
        for (const [key, val] of Object.entries(defaults)) { if (!d[key]) d[key] = val; }
        const linkKeys = Object.keys(d.links).sort((a, b) => d.links[a].timestamp - d.links[b].timestamp);
        while (linkKeys.length > 500) { delete d.links[linkKeys.shift()]; }
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

async function sendeAdminNotification(text) {
    for (const adminId of ADMIN_IDS) {
        try { await bot.telegram.sendMessage(adminId, '🔔 ' + text, { parse_mode: 'Markdown' }); } catch (e) {}
    }
}

async function checkInstagramForAllUsers() {
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started || (u.instagram && u.instagram.trim() !== '') || d.instaWarte[uid]) continue;
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
    if (xp >= 5000) return '👑 Elite';
    if (xp >= 1000) return '🏅 Erfahrener';
    if (xp >= 500)  return '⬆️ Aufsteiger';
    if (xp >= 50)   return '📘 Anfänger';
    return '🆕 New';
}
function badgeBonusLinks(xp) { return xp >= 1000 ? 1 : 0; }
function xpBisNaechstesBadge(xp) {
    if (xp < 50)   return { ziel: '📘 Anfänger',   fehlend: 50 - xp };
    if (xp < 500)  return { ziel: '⬆️ Aufsteiger', fehlend: 500 - xp };
    if (xp < 1000) return { ziel: '🏅 Erfahrener', fehlend: 1000 - xp };
    if (xp < 5000) return { ziel: '👑 Elite',       fehlend: 5000 - xp };
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
    if (alteBadge !== u.role && alteBadge) {
        sendeAdminNotification('🏅 *Badge Aufstieg!*\n\n👤 ' + (u.name||uid) + '\n' + alteBadge + ' → ' + u.role + '\n⭐ ' + u.xp + ' XP');
    }
    return finalXP;
}

function xpAddMitDaily(uid, menge, name) {
    if (istAdminId(uid)) return 0;
    const u = user(uid, name);
    let finalXP = menge;
    if (d.xpEvent?.aktiv && d.xpEvent.multiplier > 1) finalXP = Math.round(menge * d.xpEvent.multiplier);
    u.xp += finalXP; u.level = level(u.xp); u.role = badge(u.xp);
    if (!d.dailyXP[uid]) d.dailyXP[uid] = 0;
    d.dailyXP[uid] += finalXP;
    if (!d.weeklyXP[uid]) d.weeklyXP[uid] = 0;
    d.weeklyXP[uid] += finalXP;
    return finalXP;
}

function user(uid, name) {
    if (!d.users[uid]) {
        d.users[uid] = { name: name || '', username: null, instagram: null, xp: 0, level: 1, warnings: 0, started: false, links: 0, likes: 0, role: '🆕 New', lastDaily: null, totalLikes: 0, chats: [] };
    }
    if (name) d.users[uid].name = name;
    if (istAdminId(uid)) { d.users[uid].xp = 0; d.users[uid].level = 1; d.users[uid].role = '⚙️ Admin'; }
    return d.users[uid];
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
    const jetzt = new Date();
    const tag = jetzt.getDay(), h = jetzt.getHours();
    return (tag === 0 && h >= 20) || (tag === 1 && h < 6);
}
function hatBonusLink(uid) { return d.bonusLinks[uid] && d.bonusLinks[uid] > 0; }
function bonusLinkNutzen(uid) {
    if (hatBonusLink(uid)) { d.bonusLinks[uid]--; if (d.bonusLinks[uid] <= 0) delete d.bonusLinks[uid]; return true; }
    return false;
}

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
        istInstagramLink(l.text) && new Date(l.timestamp).toDateString() === heute && l.user_id !== Number(uid)
    );
    heuteLinks.forEach(l => { if (!l.likes) l.likes = new Set(); });
    const gesamt = heuteLinks.length;
    const geliked = heuteLinks.filter(l => l.likes.has(Number(uid))).length;
    if (gesamt > 0) { mission.m2 = geliked / gesamt >= 0.8; mission.m3 = geliked === gesamt; }
    else { mission.m2 = false; mission.m3 = false; }
}

function getWochenMission(uid) {
    if (!d.wochenMissionen[uid]) d.wochenMissionen[uid] = { m1Tage: 0, m2Tage: 0, m3Tage: 0, letzterTag: null };
    return d.wochenMissionen[uid];
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
        try { await bot.telegram.sendMessage(Number(uid), '🎯 *Mission 1 erreicht!*\n\n✅ Du hast heute 5 Instagram-Links geliked!\n\n⏳ XP werden um 12:00 Uhr vergeben.', { parse_mode: 'Markdown' }); } catch (e) {}
    }
    speichernDebounced();
}

async function missionenAuswerten() {
    const heute = new Date().toDateString();
    const jetzt12 = heute + '_12';
    if (d.missionAuswertungErledigt?.[jetzt12]) return;
    if (!d.missionAuswertungErledigt) d.missionAuswertungErledigt = {};
    d.missionAuswertungErledigt[jetzt12] = true;

    for (const [uid, queue] of Object.entries(d.missionQueue)) {
        if (istAdminId(uid) || queue.date === heute) continue;
        const name = d.users[uid]?.name || '';
        const wMission = getWochenMission(uid);
        const gestern = queue.date;
        let meldungen = [];

        const gestrigeLinks = Object.values(d.links).filter(l => new Date(l.timestamp).toDateString() === gestern);
        const gestrigeInstaLinks = gestrigeLinks.filter(l => istInstagramLink(l.text) && l.user_id !== Number(uid));
        const gesamtGestern = gestrigeInstaLinks.length;
        const gelikedGestern = gestrigeInstaLinks.filter(l => l.likes.has(Number(uid))).length;
        const prozentGestern = gesamtGestern > 0 ? gelikedGestern / gesamtGestern : 0;
        const minLinksVorhanden = gestrigeInstaLinks.length >= 5;
        const mission = getMission(uid);

        if (queue.m1Pending) {
            xpAdd(uid, 5, name);
            meldungen.push('✅ *Mission 1!*\n5 Links geliked → +5 XP');
            if (wMission.letzterTag !== gestern) {
                wMission.m1Tage++;
                if (wMission.m1Tage >= 7) { xpAdd(uid, 10, name); meldungen.push('🏆 *Wochen-M1!* +10 XP'); wMission.m1Tage = 0; }
            }
        }
        // FIX 5: gesamtGestern > 0 statt minLinksVorhanden — M2/M3 braucht nicht 5 Links
        if (gesamtGestern > 0 && prozentGestern >= 0.8) {
            mission.m2 = true;
            xpAdd(uid, 5, name);
            meldungen.push('✅ *Mission 2!*\n' + Math.round(prozentGestern * 100) + '% geliked → +5 XP');
            if (wMission.letzterTag !== gestern) {
                wMission.m2Tage++;
                if (wMission.m2Tage >= 7) { xpAdd(uid, 15, name); meldungen.push('🏆 *Wochen-M2!* +15 XP'); wMission.m2Tage = 0; }
            }
        }
        // FIX 5: gesamtGestern > 0 statt minLinksVorhanden
        if (gesamtGestern > 0 && gelikedGestern === gesamtGestern) {
            mission.m3 = true;
            xpAdd(uid, 5, name);
            meldungen.push('✅ *Mission 3!*\nAlle Links geliked → +5 XP');
            if (wMission.letzterTag !== gestern) {
                wMission.m3Tage++;
                if (wMission.m3Tage >= 7) { xpAdd(uid, 20, name); meldungen.push('🏆 *Wochen-M3!* +20 XP'); wMission.m3Tage = 0; }
            }
        }

        wMission.letzterTag = gestern;

        const hatGesternLink = Object.values(d.links).some(l => l.user_id === Number(uid) && new Date(l.timestamp).toDateString() === gestern);

        if (!d.m1Streak[uid]) d.m1Streak[uid] = { count: 0, letzterTag: null };
        if (queue.m1Pending) {
            d.m1Streak[uid].count++;
            d.m1Streak[uid].letzterTag = gestern;
            if (d.m1Streak[uid].count >= 5 && d.users[uid]?.warnings > 0) {
                d.users[uid].warnings--;
                d.m1Streak[uid].count = 0;
                try { await bot.telegram.sendMessage(Number(uid), '🎉 *Warn entfernt!* 5 Tage M1 in Folge!\n⚠️ Warns: ' + d.users[uid].warnings + '/5', { parse_mode: 'Markdown' }); } catch (e) {}
            }
        } else { d.m1Streak[uid].count = 0; }

        if (hatGesternLink && !queue.m1Pending && minLinksVorhanden && d.users[uid]) {
            d.users[uid].warnings = (d.users[uid].warnings || 0) + 1;
            try { await bot.telegram.sendMessage(Number(uid), '⚠️ *Verwarnung!*\nLink gepostet aber M1 nicht erfüllt.\n⚠️ Warns: ' + d.users[uid].warnings + '/5', { parse_mode: 'Markdown' }); } catch (e) {}
        }

        if (meldungen.length > 0 && d.users[uid]) {
            const u = d.users[uid];
            const nb = xpBisNaechstesBadge(u.xp);
            try { await bot.telegram.sendMessage(Number(uid), '🎯 *Missions Auswertung*\n\n' + meldungen.join('\n\n') + '\n\n⭐ Gesamt: ' + u.xp + ' XP' + (nb ? '\n⬆️ Noch ' + nb.fehlend + ' XP bis ' + nb.ziel : ''), { parse_mode: 'Markdown' }); } catch (e) {}
        } else if (d.users[uid]?.started && !hatGesternLink) {
            try { await bot.telegram.sendMessage(Number(uid), '📊 *Missions Auswertung*\n\n❌ Keine Mission erfüllt.\n\nHeute neue Chance! 💪', { parse_mode: 'Markdown' }); } catch (e) {}
        }

        delete d.missionQueue[uid];
    }

    d.missionAuswertungErledigt = { [jetzt12]: true };
    speichern();
}

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
        let text = '📆 *Weekly Ranking*\n\n';
        text += (rank < 3 ? badges[rank] : '#' + (rank + 1)) + ' Platz ' + (rank + 1) + ' von ' + sorted.length + '\n';
        text += '⭐ XP diese Woche: ' + xp + '\n\n🏆 Top 3:\n';
        sorted.slice(0, 3).forEach(([tid, txp], i) => { text += badges[i] + ' ' + d.users[tid].name + ': ' + txp + ' XP\n'; });
        text += '\n🔥 Weiter so ' + u.name + '!';
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

bot.start(async (ctx) => {
    const uid = ctx.from.id;
    const u = user(uid, ctx.from.first_name);
    u.started = true;
    if (d.warteNachricht?.[uid]) {
        try { await bot.telegram.deleteMessage(d.warteNachricht[uid].chatId, d.warteNachricht[uid].msgId); } catch (e) {}
        delete d.warteNachricht[uid];
    }
    if (d.warte?.[uid]) delete d.warte[uid];
    speichern();
    if (istPrivat(ctx.chat.type)) {
        if (!u.instagram) { d.instaWarte[uid] = true; speichern(); return ctx.reply('📸 Willkommen!\n\nWie heißt dein Instagram Account?\n\n(z.B. max123)'); }
        return ctx.reply('✅ Bot gestartet!\n\n📋 /help für alle Befehle.');
    }
});

bot.command('help', async (ctx) => {
    const uid = ctx.from.id;
    const u = user(uid, ctx.from.first_name);
    const text = '📋 *Bot Hilfe*\n\n🔗 *Link System:*\n• 1 Link pro Tag\n• Doppelte Links geblockt\n• 👍 Likes = XP\n\n👍 *Like System:*\n• 1 Like pro Link\n• Kein Self-Like\n• +5 XP pro Like\n\n🎯 *Tägliche Missionen:*\n• M1: 5 Links liken → +5 XP\n• M2: 80% liken → +5 XP\n• M3: Alle liken → +5 XP\n• ⏳ XP um 12:00 Uhr\n\n📅 *Wochen Missionen:*\n• 7x M1 → +10 XP\n• 7x M2 → +15 XP\n• 7x M3 → +20 XP\n\n🏅 *Badges:*\n• 🆕 New: 0-49 XP\n• 📘 Anfänger: 50-499 XP\n• ⬆️ Aufsteiger: 500-999 XP\n• 🏅 Erfahrener: 1000+ XP\n\n/ranking /dailyranking /weeklyranking /profile /daily /missionen';
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
    const heutigeLinks = Object.values(d.links).filter(l => new Date(l.timestamp).toDateString() === heute);
    const gesamtLinks = heutigeLinks.length;
    const geliked = heutigeLinks.filter(l => l.likes.has(Number(uid))).length;
    const prozent = gesamtLinks > 0 ? Math.round(geliked / gesamtLinks * 100) : 0;
    let text = '🎯 *Deine Missionen*\n\n📅 *Täglich:*\n';
    text += (mission.m1 ? '✅' : '⬜') + ' M1: ' + mission.likesGegeben + '/5 geliked\n';
    text += '⏳ M2: ' + prozent + '% (Ziel: 80%)\n';
    text += '⏳ M3: ' + geliked + '/' + gesamtLinks + ' alle\n\n';
    text += '📆 *Wöchentlich:*\n🔹 W-M1: ' + wMission.m1Tage + '/7\n🔹 W-M2: ' + wMission.m2Tage + '/7\n🔹 W-M3: ' + wMission.m3Tage + '/7\n\n';
    text += '⭐ XP: ' + u.xp + '\n🏅 ' + u.role;
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
        (u.instagram ? '📸 @' + u.instagram + '\n' : '') + (u.username ? '@' + u.username + '\n' : '') +
        '🏅 ' + u.role + '\n⭐ XP: ' + u.xp + '\n👍 Likes heute: ' + (mission.likesGegeben || 0) + '\n' +
        '📅 Heute: ' + (d.dailyXP[uid] || 0) + '\n📆 Woche: ' + (d.weeklyXP[uid] || 0) + '\n' +
        '🏆 Rang: #' + rank + '\n🔗 Links: ' + u.links + (bonusL > 0 ? '\n🎁 Bonus: ' + bonusL : '') +
        '\n👍 Likes gesamt: ' + u.totalLikes + '\n⚠️ Warns: ' + u.warnings + '/5',
        { parse_mode: 'HTML' }
    );
});

bot.command('setinsta', async (ctx) => {
    if (!istPrivat(ctx.chat.type)) return ctx.reply('❌ Bitte nutze den Befehl im privaten Chat.');
    d.instaWarte[ctx.from.id] = true; speichern();
    return ctx.reply('📸 Schick mir deinen neuen Instagram Namen.\n\n(z.B. max123)');
});

bot.command('ranking', async (ctx) => {
    const sorted = Object.entries(d.users).filter(([uid]) => !istAdminId(uid)).sort((a, b) => b[1].xp - a[1].xp).slice(0, 10);
    if (!sorted.length) return ctx.reply('Noch keine Daten.');
    const b = ['🥇', '🥈', '🥉'];
    let text = '🏆 *GESAMT RANKING*\n\n';
    sorted.forEach(([, u], i) => { text += (b[i] || (i + 1) + '.') + ' ' + u.role + ' *' + u.name + '*\n   ⭐' + u.xp + ' | Lvl ' + u.level + '\n\n'; });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('dailyranking', async (ctx) => {
    const sorted = Object.entries(d.dailyXP).filter(([uid]) => d.users[uid] && !istAdminId(uid)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return ctx.reply('Heute noch keine XP.');
    const b = ['🥇', '🥈', '🥉'];
    let text = '📅 *TAGES RANKING*\n\n';
    sorted.forEach(([uid, xp], i) => { text += (b[i] || (i + 1) + '.') + ' ' + d.users[uid].role + ' *' + d.users[uid].name + '*\n   ⭐ ' + xp + ' XP\n\n'; });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('weeklyranking', async (ctx) => {
    const sorted = Object.entries(d.weeklyXP).filter(([uid]) => d.users[uid] && !istAdminId(uid)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return ctx.reply('Diese Woche noch keine XP.');
    const b = ['🥇', '🥈', '🥉'];
    let text = '📆 *WOCHEN RANKING*\n\n';
    sorted.forEach(([uid, xp], i) => { text += (b[i] || (i + 1) + '.') + ' ' + d.users[uid].role + ' *' + d.users[uid].name + '*\n   ⭐ ' + xp + ' XP\n\n'; });
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
    await ctx.reply('🎁 *Daily!*\n\n+' + bonus + ' XP!\n⭐ ' + u.xp + '\n🏅 ' + u.role, { parse_mode: 'Markdown' });
});

bot.command('stats', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const alleChats = Object.values(d.chats);
    await ctx.reply('📊 *Stats*\n\n👥 User: ' + Object.keys(d.users).length + '\n💬 Chats: ' + alleChats.length + '\n🔗 Links: ' + Object.keys(d.links).length, { parse_mode: 'Markdown' });
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
        if (!u.started) continue;
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
    if ((u.warnings||0) >= 5) sendeAdminNotification('🚨 *5 Warns erreicht!*\n\n👤 ' + u.name + '\n🆔 ' + userId + '\n⚠️ Ban möglich!');
});

bot.command('unban', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    if (!ctx.message.reply_to_message) return ctx.reply('❌ Antworte auf eine Nachricht.');
    const userId = ctx.message.reply_to_message.from.id;
    try { await ctx.telegram.unbanChatMember(ctx.chat.id, userId); if (d.users[userId]) d.users[userId].warnings = 0; await ctx.reply('✅ Entbannt!'); }
    catch (e) { await ctx.reply('❌ Fehler.'); }
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
bot.command('testreset', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; d.dailyXP = {}; d.weeklyXP = {}; d.missionen = {}; d.wochenMissionen = {}; d.missionQueue = {}; d.tracker = {}; d.counter = {}; d.badgeTracker = {}; speichern(); await ctx.reply('✅ Reset!'); });
bot.command('testmissionauswertung', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    const gestern = new Date(Date.now() - 86400000).toDateString();
    for (const uid of Object.keys(d.missionQueue)) d.missionQueue[uid].date = gestern;
    d.missionAuswertungErledigt = {};
    await missionenAuswerten();
    await ctx.reply('✅ Auswertung!');
});
bot.command('testweeklyranking', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; await weeklyRankingDM(); await ctx.reply('✅ Weekly!'); });
bot.command('time', (ctx) => { ctx.reply('🕒 ' + new Date().toString()); });

bot.on('new_chat_members', async (ctx) => {
    for (const m of ctx.message.new_chat_members) {
        if (m.is_bot) continue;
        d.warte[m.id] = ctx.chat.id;
        user(m.id, m.first_name);
        const info = await ctx.telegram.getMe();
        await ctx.reply('👋 Willkommen *' + m.first_name + '*!\n\n⚠️ Starte den Bot per DM!\n\n👇', {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([Markup.button.url('📩 Bot starten', 'https://t.me/' + info.username + '?start=gruppe')]).reply_markup
        });
        sendeAdminNotification('👋 *Neuer User beigetreten!*\n\n👤 ' + m.first_name + (m.username ? ' @' + m.username : '') + '\n🆔 ' + m.id + '\n👥 Gesamt: ' + Object.keys(d.users).length + ' User');
    }
});

bot.on('message', async (ctx) => {
    try {
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

        if (!ctx.message || !ctx.from) return;
        if (!istGruppe(ctx.chat.type)) return;

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

        if (istSperrzeit() && !admin) {
            try { await ctx.deleteMessage(); } catch (e) {}
            const msg = await ctx.reply('🚫 Keine Links von Sonntag 20:00 bis Montag 06:00!');
            setTimeout(async () => { try { await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch (e) {} }, 15000);
            return;
        }

        const url = linkUrl(text);
        const urlNorm = normalisiereUrl(url);
        if (url && d.gepostet.some(g => normalisiereUrl(g) === urlNorm)) {
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
            try { await ctx.deleteMessage(); } catch (e) {}
            const posterName = istAdminId(uid) ? '⚙️ Admin ' + ctx.from.first_name : u.role + ' ' + ctx.from.first_name;
            const posterStats = istAdminId(uid) ? '' : '  |  ⭐ ' + u.xp + ' XP';
            let botMsg;
            try {
                botMsg = await bot.telegram.sendMessage(ctx.chat.id,
                    posterName + '\n🔗 ' + text + '\n\n👍 0 Likes' + posterStats,
                    { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('👍 Like  |  0', 'like_' + msgId)]]).reply_markup }
                );
            } catch (e) { console.log('Fehler beim Posten:', e.message); speichern(); return; }

            const mapKey = MEINE_GRUPPE + '_' + msgId;
            d.links[mapKey] = { chat_id: ctx.chat.id, user_id: uid, user_name: ctx.from.first_name, text: text, likes: new Set(), likerNames: {}, counter_msg_id: botMsg.message_id, timestamp: Date.now() };

            if (!istAdminId(uid)) {
                try {
                    const erin = await bot.telegram.sendMessage(ctx.chat.id, '⚠️ Mindestens 5 Links liken (M1) — sonst Verwarnung!', { reply_to_message_id: botMsg.message_id });
                    setTimeout(async () => { try { await bot.telegram.deleteMessage(ctx.chat.id, erin.message_id); } catch (e) {} }, 10000);
                } catch (e) {}
            }

            const linkKeys = Object.keys(d.links);
            if (linkKeys.length > 500) {
                const oldest = linkKeys.sort((a, b) => d.links[a].timestamp - d.links[b].timestamp)[0];
                delete d.links[oldest];
            }
            await sendeLinkAnAlle(d.links[mapKey]);

            if (BRIDGE_BOT_URL) {
                try {
                    await fetch(BRIDGE_BOT_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-bridge-secret': BRIDGE_SECRET },
                        body: JSON.stringify({ fromGroup: MEINE_GRUPPE, msgId: msgId, chatId: ctx.chat.id, botMsgId: botMsg.message_id, linkText: text, userName: ctx.from.first_name, userId: uid, username: ctx.from.username || null })
                    });
                    const updateUrl = BRIDGE_BOT_URL.replace('/new-link-from-group', '/update-msg-id');
                    fetch(updateUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bridge-secret': BRIDGE_SECRET }, body: JSON.stringify({ fromGroup: MEINE_GRUPPE, mapKey: MEINE_GRUPPE + '_' + msgId, realBotMsgId: botMsg.message_id }) }).catch(e => {});
                    console.log('Bridge Meldung: msgId=' + msgId + ' botMsgId=' + botMsg.message_id);
                } catch (e) { console.log('Bridge Bot Meldung fehlgeschlagen:', e.message); }
            }
        } else {
            const mapKey = MEINE_GRUPPE + '_' + msgId;
            d.links[mapKey] = { chat_id: ctx.chat.id, user_id: uid, user_name: ctx.from.first_name, text: text, likes: new Set(), counter_msg_id: msgId, timestamp: Date.now() };
        }
        speichern();
    } catch (e) { console.log('Message Handler Fehler:', e.message); }
});

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
        if (uid === lnk.user_id) { try { await ctx.answerCbQuery('❌ Kein Self-Like!'); } catch (e) {} return; }
        if (lnk.likes.has(uid)) { try { await ctx.answerCbQuery('❌ Bereits geliked!'); } catch (e) {} return; }

        lnk.likes.add(uid);
        lnk.likerNames[uid] = { name: ctx.from.first_name, insta: d.users[uid]?.instagram || null };
        const anz = lnk.likes.size;
        const poster = user(lnk.user_id, lnk.user_name);
        poster.totalLikes++;

        const istHeutigerLink = new Date(lnk.timestamp).toDateString() === new Date().toDateString();
        let vergebenXP = 0;
        if (!istAdminId(uid)) {
            vergebenXP = istHeutigerLink ? xpAddMitDaily(uid, 5, ctx.from.first_name) : xpAdd(uid, 5, ctx.from.first_name);
        }

        const msgKey = String(lnk.counter_msg_id);
        if (d.dmNachrichten?.[msgKey]?.[uid]) {
            try { await bot.telegram.deleteMessage(uid, d.dmNachrichten[msgKey][uid]); delete d.dmNachrichten[msgKey][uid]; } catch (e) {}
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
        const feedbackText = istAdminId(uid) ? '✅ Like registriert! (Admin)' : `🎉 +${vergebenXP} XP${eventBonus}\n` + liker.role + ' | ⭐ ' + liker.xp + (nb ? '\n⬆️ Noch ' + nb.fehlend + ' bis ' + nb.ziel : '');

        const feedbackMsg = await ctx.reply(feedbackText);
        setTimeout(async () => { try { await ctx.telegram.deleteMessage(ctx.chat.id, feedbackMsg.message_id); } catch (e) {} }, 8000);

        try { await ctx.answerCbQuery('👍 ' + anz + '!'); } catch (e) {}

        try {
            const posterLabel = istAdminId(lnk.user_id) ? '⚙️ Admin ' + lnk.user_name : poster.role + ' ' + lnk.user_name;
            const posterStats = istAdminId(lnk.user_id) ? '' : '  |  ⭐ ' + poster.xp + ' XP';
            await ctx.telegram.editMessageText(lnk.chat_id, lnk.counter_msg_id, null,
                posterLabel + '\n🔗 ' + lnk.text + '\n\n👍 ' + anz + ' Likes' + posterStats,
                { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('👍 Like  |  ' + anz, 'like_' + msgId)]]).reply_markup }
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

bot.action('remind_insta', async (ctx) => {
    let count = 0;
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started || (u.instagram && u.instagram.trim() !== '')) continue;
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

async function topLinks(chatId) {
    const sorted = Object.values(d.links).sort((a, b) => b.likes.size - a.likes.size).slice(0, 3);
    if (!sorted.length) return;
    let text = '🔥 *Trending Links*\n\n';
    sorted.forEach((l, i) => { text += (i + 1) + '. ' + l.user_name + ': ' + l.likes.size + ' 👍\n'; });
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
            batch.map(([uid]) => sendeDM(uid, '📢 Neuer Booster-Link\n\n👤 ' + linkData.user_name + '\n\n🔗 ' + linkData.text + '\n\nBitte liken! 👍',
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

async function dailyRankingAbschluss() {
    const sorted = Object.entries(d.dailyXP).filter(([uid]) => d.users[uid] && d.dailyXP[uid] > 0 && !istAdminId(uid)).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return;
    const bel = [{ xp: 10, links: 1, text: '🥇' }, { xp: 5, links: 0, text: '🥈' }, { xp: 2, links: 0, text: '🥉' }];
    for (let i = 0; i < Math.min(3, sorted.length); i++) {
        const [uid] = sorted[i];
        const u = d.users[uid];
        const b = bel[i];
        xpAdd(uid, b.xp, u.name);
        if (b.links > 0) { if (!d.bonusLinks[uid]) d.bonusLinks[uid] = 0; d.bonusLinks[uid] += b.links; }
        try { await bot.telegram.sendMessage(Number(uid), `🎉 *${b.text} im Tagesranking!*\n\n+${b.xp} XP` + (b.links > 0 ? '\n🔗 Extra Link für morgen!' : ''), { parse_mode: 'Markdown' }); } catch (e) {}
    }
    d.gesternDailyXP = Object.assign({}, d.dailyXP);
    d.dailyXP = {}; d.tracker = {}; d.counter = {}; d.badgeTracker = {};
    d.dailyReset = Date.now();
    speichern();
}

async function likeErinnerung() {
    const heute = new Date().setHours(0, 0, 0, 0);
    const heutigeLinks = Object.entries(d.links).filter(([, l]) => l.timestamp >= heute && new Date(l.timestamp).toDateString() === new Date().toDateString());
    if (!heutigeLinks.length) return;
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started || istAdminId(uid)) continue;
        const nichtGeliked = heutigeLinks.filter(([, l]) => l.user_id != uid && !l.likes.has(Number(uid)));
        if (!nichtGeliked.length) continue;
        let text = '👋 *Hallo ' + u.name + '!*\n\n⚠️ Noch nicht geliked:\n\n';
        const buttons = [];
        for (const [, l] of nichtGeliked) {
            text += '🔗 ' + l.user_name + '\n';
            // FIX: Immer counter_msg_id verwenden für korrekte URL
            if (l.counter_msg_id) {
                buttons.push([Markup.button.url('👍 Liken', 'https://t.me/c/' + String(l.chat_id).replace('-100', '') + '/' + l.counter_msg_id)]);
            }
        }
        text += '\n⏳ Missionen schließen um 12:00 Uhr!';
        if (buttons.length > 0) {
            try { await bot.telegram.sendMessage(Number(uid), text, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard(buttons).reply_markup }); } catch (e) {}
        }
    }
}

async function abendM1Warnung() {
    const heute = new Date().toDateString();
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started || istAdminId(uid)) continue;
        const hatLinkHeute = Object.values(d.links).some(l => l.user_id === Number(uid) && new Date(l.timestamp).toDateString() === heute);
        if (!hatLinkHeute) continue;
        const fremde = Object.values(d.links).filter(l => istInstagramLink(l.text) && l.user_id !== Number(uid) && new Date(l.timestamp).toDateString() === heute);
        if (fremde.length < 5) continue;
        const m = d.missionen[uid];
        if (m?.date === heute && m.m1) continue;
        const likes = m ? m.likesGegeben : 0;
        try { await bot.telegram.sendMessage(Number(uid), '⚠️ *Erinnerung!*\nNur ' + likes + '/5 Likes vergeben.\nNoch ' + (5 - likes) + ' liken — sonst Verwarnung!', { parse_mode: 'Markdown' }); } catch (e) {}
    }
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
        if (h === 3  && m === 0)  einmalig('backup',       () => backup());
        if (jetzt.getDay() === 1 && h === 0 && m === 5) einmalig('wochenReset', () => {
            d.wochenMissionen = {};
            let eliteCount = 0;
            for (const [uid, u] of Object.entries(d.users)) {
                if (istAdminId(uid) || !u.started) continue;
                if (u.xp >= 5000) {
                    if (!d.bonusLinks[uid]) d.bonusLinks[uid] = 0;
                    d.bonusLinks[uid] += 1;
                    eliteCount++;
                    bot.telegram.sendMessage(Number(uid), '👑 *Elite Bonus!*\n\n🎁 Du hast als Elite-Mitglied deinen wöchentlichen Extra-Link erhalten!', { parse_mode: 'Markdown' }).catch(() => {});
                }
            }
            console.log('✅ Elite Bonus vergeben an ' + eliteCount + ' User');
            speichern();
        });
        if (h === 7  && m === 5)  einmalig('toplinks',     () => { Object.values(d.chats).filter(c => istGruppe(c.type)).forEach(g => topLinks(g.id)); });
        if (h === 12 && m === 0)  einmalig('missionen',    () => missionenAuswerten());
        if (h === 22 && m === 0)  einmalig('abendwarnung', () => abendM1Warnung());
        if (h === 23 && m === 0)  einmalig('reminder',     () => likeErinnerung());
        if (h === 23 && m === 55) einmalig('dailyRanking', () => dailyRankingAbschluss());
        if (d.xpEvent?.start && d.xpEvent?.end) {
            const now = Date.now();
            if (!d.xpEvent.aktiv && now >= d.xpEvent.start && now <= d.xpEvent.end) { d.xpEvent.aktiv = true; speichernDebounced(); }
            if (d.xpEvent.aktiv && now > d.xpEvent.end) { d.xpEvent.aktiv = false; speichernDebounced(); }
        }
        const zweiTage = 2 * 24 * 60 * 60 * 1000;
        for (const [k, l] of Object.entries(d.links)) {
            if (Date.now() - l.timestamp > zweiTage) {
                bot.telegram.deleteMessage(l.chat_id, l.counter_msg_id).catch(() => {});
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


app.get('/login', (req, res) => {
    if (isAuthenticated(req)) return res.redirect('/dashboard');
    const err = (req.headers.referer||'').includes('error') || false;
    res.send('<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Login</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#0a0f1a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center}.box{background:#111827;border:1px solid #1e2d45;border-radius:16px;padding:40px;width:100%;max-width:380px}.logo{text-align:center;font-size:40px;margin-bottom:8px}.title{text-align:center;font-size:20px;font-weight:700;margin-bottom:4px}.sub{text-align:center;font-size:13px;color:#64748b;margin-bottom:28px}label{display:block;font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;margin-bottom:6px}input{width:100%;background:#1a2235;border:1px solid #2a3a55;color:#e2e8f0;border-radius:8px;padding:12px 16px;font-size:14px;outline:none;margin-bottom:16px}button{width:100%;background:#3b82f6;color:#fff;border:none;border-radius:8px;padding:13px;font-size:14px;font-weight:600;cursor:pointer}.error{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);color:#ef4444;border-radius:8px;padding:12px;font-size:13px;margin-bottom:16px}</style></head><body><div class="box"><div class="logo">📊</div><div class="title">Admin Dashboard</div><div class="sub">Telegram Bot Control Panel</div>' + (req.query.error ? '<div class="error">❌ Falsches Passwort</div>' : '') + '<form method="POST" action="/login"><label>Passwort</label><input type="password" name="password" placeholder="••••••••" autofocus required><button type="submit">🔐 Einloggen</button></form></div></body></html>');
});

app.post('/login', (req, res) => {
    if (req.body.password === DASHBOARD_PASSWORD) {
        const sid = generateSessionId();
        dashboardSessions.set(sid, { createdAt: Date.now() });
        setTimeout(() => dashboardSessions.delete(sid), 24*60*60*1000);
        res.setHeader('Set-Cookie', 'dashSession=' + sid + '; HttpOnly; Path=/; Max-Age=86400');
        res.redirect('/dashboard');
    } else {
        res.redirect('/login?error=1');
    }
});

app.get('/logout', (req, res) => {
    const sid = getSessionId(req);
    if (sid) dashboardSessions.delete(sid);
    res.setHeader('Set-Cookie', 'dashSession=; HttpOnly; Path=/; Max-Age=0');
    res.redirect('/login');
});

app.get('/data', (req, res) => {
    const secret = req.headers['x-bridge-secret'] || req.query.secret;
    if (secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Forbidden' });
    const out = Object.assign({}, d);
    out.links = {};
    for (const [k, v] of Object.entries(d.links)) out.links[k] = Object.assign({}, v, { likes: Array.from(v.likes) });
    res.json(out);
});

app.get('/dashboard', (req, res) => {
    if (!isAuthenticated(req)) return res.redirect('/login');
    const today = new Date().toDateString();
    const now   = new Date();
    const allUsers   = Object.entries(d.users);
    const totalUsers = allUsers.length;
    const totalLinks = Object.keys(d.links).length;
    const totalLikes = Object.values(d.links).reduce((s,l) => s+(l.likes?.size||0), 0);
    let todayLinks = 0;
    for (const l of Object.values(d.links)) if (l.timestamp && new Date(l.timestamp).toDateString()===today) todayLinks++;
    const gelikedSet = new Set();
    Object.values(d.links).filter(l=>new Date(l.timestamp).toDateString()===today).forEach(l=>l.likes.forEach(uid=>gelikedSet.add(uid)));
    const started     = allUsers.filter(([,u])=>u.started).length;
    const activeToday = allUsers.filter(([uid])=>d.dailyXP[uid]>0).length;
    const withWarns   = allUsers.filter(([,u])=>(u.warnings||0)>0).length;
    const noInsta     = allUsers.filter(([,u])=>!u.instagram).map(([,u])=>u);
    let m1c=0,m2c=0,m3c=0;
    for (const [uid,m] of Object.entries(d.missionen)) { if (istAdminId(uid)||m.date!==today) continue; if(m.m1)m1c++;if(m.m2)m2c++;if(m.m3)m3c++; }
    const medals = ['🥇','🥈','🥉'];
    const gesamtRanking = Object.entries(d.users).filter(([uid])=>!istAdminId(uid)).sort((a,b)=>(b[1].xp||0)-(a[1].xp||0)).slice(0,10);
    const dailyRanking  = Object.entries(d.dailyXP).filter(([uid])=>d.users[uid]&&!istAdminId(uid)).sort((a,b)=>b[1]-a[1]).slice(0,10);
    const weeklyRanking = Object.entries(d.weeklyXP).filter(([uid])=>d.users[uid]&&!istAdminId(uid)).sort((a,b)=>b[1]-a[1]).slice(0,10);
    const topLinksList  = Object.values(d.links).sort((a,b)=>(b.likes?.size||0)-(a.likes?.size||0)).slice(0,5);
    const eliteUser     = Object.entries(d.users).filter(([uid,u])=>!istAdminId(uid)&&(u.xp||0)>=5000);
    const erfahreneUser = Object.entries(d.users).filter(([uid,u])=>!istAdminId(uid)&&(u.xp||0)>=1000&&(u.xp||0)<5000);
    const topAllzeit    = Object.entries(d.users).filter(([uid])=>!istAdminId(uid)).sort((a,b)=>(b[1].xp||0)-(a[1].xp||0)).slice(0,3);
    const topLinksHof   = Object.entries(d.users).filter(([uid])=>!istAdminId(uid)).sort((a,b)=>(b[1].links||0)-(a[1].links||0)).slice(0,3);
    const topLikesHof   = Object.entries(d.users).filter(([uid])=>!istAdminId(uid)).sort((a,b)=>(b[1].totalLikes||0)-(a[1].totalLikes||0)).slice(0,3);
    const usersWithWarns = Object.entries(d.users).filter(([,u])=>(u.warnings||0)>0).sort((a,b)=>(b[1].warnings||0)-(a[1].warnings||0));
    const nextReset = new Date(); nextReset.setHours(23,55,0,0);
    if (now>nextReset) nextReset.setDate(nextReset.getDate()+1);
    const msLeft = nextReset-now;
    const hLeft = Math.floor(msLeft/3600000);
    const mLeft = Math.floor((msLeft%3600000)/60000);
    const evtAktiv    = d.xpEvent?.aktiv||false;
    const evtPct      = d.xpEvent?.multiplier?Math.round((d.xpEvent.multiplier-1)*100):0;
    const evtEndStr   = d.xpEvent?.end?new Date(d.xpEvent.end).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'}):'—';
    const evtStartStr = d.xpEvent?.start?new Date(d.xpEvent.start).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'}):'—';
    const rankRow = (i,name,val) => `<div class="rank-row"><span class="rank-pos">${medals[i]||`<span style="font-size:11px;color:var(--muted)">#${i+1}</span>`}</span><span class="rank-name">${name}</span><span class="rank-xp">${val}</span></div>`;

    res.send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Dashboard</title><meta http-equiv="refresh" content="30">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0f1a;--surface:#111827;--surface2:#1a2235;--surface3:#212d42;--border:#1e2d45;--border2:#2a3a55;--text:#e2e8f0;--muted:#64748b;--muted2:#94a3b8;--green:#10b981;--green-bg:rgba(16,185,129,.1);--blue:#3b82f6;--blue-bg:rgba(59,130,246,.1);--amber:#f59e0b;--amber-bg:rgba(245,158,11,.1);--red:#ef4444;--red-bg:rgba(239,68,68,.1);--purple:#8b5cf6;--purple-bg:rgba(139,92,246,.1);--radius:14px;--radius-sm:8px}
body{font-family:-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);font-size:14px;line-height:1.6;padding-bottom:70px}
.page{max-width:1400px;margin:0 auto;padding:20px 14px}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;flex-wrap:wrap;gap:10px}
.header-left{display:flex;align-items:center;gap:12px}
.header-logo{width:42px;height:42px;border-radius:12px;background:linear-gradient(135deg,var(--blue),var(--purple));display:flex;align-items:center;justify-content:center;font-size:20px}
.header-title{font-size:18px;font-weight:700}.header-sub{font-size:11px;color:var(--muted)}
.header-right{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.header-time{font-size:12px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);padding:5px 12px;border-radius:20px}
.logout-btn{font-size:12px;color:var(--red);background:var(--red-bg);border:1px solid rgba(239,68,68,.3);padding:5px 12px;border-radius:20px;text-decoration:none}
.live-dot{display:inline-block;width:6px;height:6px;background:var(--green);border-radius:50%;margin-right:5px;animation:blink 2s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.nav-tabs{display:flex;gap:3px;margin-bottom:20px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:4px;overflow-x:auto;scrollbar-width:none}
.nav-tab{padding:7px 14px;border-radius:9px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;white-space:nowrap;border:none;background:none}
.nav-tab.active{background:var(--blue);color:#fff}
.tab-content{display:none}.tab-content.active{display:block}
.section-title{font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);margin-bottom:10px;display:flex;align-items:center;gap:8px}
.section-title::after{content:'';flex:1;height:1px;background:var(--border)}
.mb-20{margin-bottom:20px}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:20px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;position:relative;overflow:hidden}
.stat-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.stat-card.c-green::before{background:var(--green)}.stat-card.c-blue::before{background:var(--blue)}.stat-card.c-amber::before{background:var(--amber)}.stat-card.c-red::before{background:var(--red)}.stat-card.c-purple::before{background:var(--purple)}
.stat-icon{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px;margin-bottom:10px}
.stat-icon.c-green{background:var(--green-bg)}.stat-icon.c-blue{background:var(--blue-bg)}.stat-icon.c-amber{background:var(--amber-bg)}.stat-icon.c-red{background:var(--red-bg)}.stat-icon.c-purple{background:var(--purple-bg)}
.stat-value{font-size:24px;font-weight:800;line-height:1}.stat-label{font-size:11px;color:var(--muted);margin-top:3px}.stat-sub{font-size:10px;color:var(--muted);margin-top:2px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:14px}
.card-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--border)}
.card-title{font-size:13px;font-weight:600}.card-body{padding:16px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.grid-3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
@media(max-width:900px){.grid-3{grid-template-columns:1fr 1fr}}
@media(max-width:600px){.grid-2,.grid-3{grid-template-columns:1fr}}
.rank-row{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--border)}.rank-row:last-child{border-bottom:none}
.rank-pos{width:22px;text-align:center;font-size:14px;flex-shrink:0}
.rank-name{flex:1;font-weight:500;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rank-xp{font-size:11px;font-weight:700;color:var(--amber);white-space:nowrap}
.search-row{padding:10px 16px;border-bottom:1px solid var(--border)}
.search-input{width:100%;background:var(--surface2);border:1px solid var(--border2);color:var(--text);border-radius:var(--radius-sm);padding:9px 13px;font-size:13px;outline:none}
.user-table-wrap{max-height:600px;overflow-y:auto;scrollbar-width:thin}
.user-row{display:flex;align-items:center;gap:8px;padding:9px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap}.user-row:hover{background:var(--surface2)}
.user-avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--blue),var(--purple));display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;color:#fff}
.user-info{flex:1;min-width:0}
.user-name{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.user-meta{font-size:10px;color:var(--muted);margin-top:1px}
.user-xp{text-align:right;min-width:65px}
.user-xp-val{font-size:12px;font-weight:700;color:var(--amber)}
.user-xp-sub{font-size:10px;color:var(--muted)}
.user-actions{display:flex;gap:3px;flex-wrap:wrap}
.abtn{font-size:10px;font-weight:600;padding:3px 7px;border-radius:5px;text-decoration:none;white-space:nowrap;cursor:pointer;border:none}
.abtn.red{color:var(--red);background:var(--red-bg)}.abtn.amber{color:var(--amber);background:var(--amber-bg)}.abtn.muted{color:var(--muted2);background:var(--surface3)}.abtn.green{color:var(--green);background:var(--green-bg)}
.progress-wrap{background:var(--surface3);border-radius:3px;height:3px;margin-top:3px;overflow:hidden}
.progress-bar{height:3px;border-radius:3px;background:linear-gradient(90deg,var(--blue),var(--purple))}
.badge-pill{display:inline-block;font-size:9px;font-weight:700;padding:1px 6px;border-radius:20px}
.bp-new{background:var(--surface3);color:var(--muted2)}.bp-anf{background:var(--blue-bg);color:var(--blue)}.bp-auf{background:var(--purple-bg);color:var(--purple)}.bp-erf{background:var(--amber-bg);color:var(--amber)}.bp-elite{background:rgba(245,158,11,.2);color:#f59e0b;border:1px solid rgba(245,158,11,.4)}
.warn-badge{font-size:10px;font-weight:700;padding:2px 6px;border-radius:20px;background:var(--red-bg);color:var(--red)}
.link-item{padding:10px 0;border-bottom:1px solid var(--border)}.link-item:last-child{border-bottom:none}
.link-url{color:var(--blue);font-size:12px;font-weight:500;word-break:break-all;text-decoration:none}
.link-meta{font-size:10px;color:var(--muted);margin-top:2px}
.liker-tag{display:inline-block;font-size:10px;padding:1px 6px;border-radius:4px;background:var(--surface3);margin:2px}
.like-badge{font-size:11px;font-weight:700;background:var(--red-bg);color:var(--red);padding:2px 8px;border-radius:20px}
.mission-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.mission-item{background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;text-align:center}
.mission-id{font-size:9px;font-weight:700;color:var(--muted);letter-spacing:1px;margin-bottom:5px}
.mission-count{font-size:28px;font-weight:800;line-height:1}
.m1{color:var(--green)}.m2{color:var(--blue)}.m3{color:var(--amber)}
.mission-sub{font-size:9px;color:var(--muted);margin-top:2px}
.event-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:500px){.event-form-grid{grid-template-columns:1fr}}
.form-group{display:flex;flex-direction:column;gap:5px}.form-group.full{grid-column:1/-1}
label{font-size:10px;font-weight:600;color:var(--muted);letter-spacing:.5px;text-transform:uppercase}
input[type=number],input[type=datetime-local],input[type=text],select,textarea{background:var(--surface2);border:1px solid var(--border2);color:var(--text);border-radius:var(--radius-sm);padding:9px 13px;font-size:13px;width:100%;outline:none}
textarea{resize:vertical;min-height:70px}
.btn{display:inline-flex;align-items:center;gap:5px;padding:9px 16px;border-radius:var(--radius-sm);font-size:12px;font-weight:600;cursor:pointer;border:none;text-decoration:none}
.btn-primary{background:var(--blue);color:#fff}.btn-danger{background:var(--red-bg);color:var(--red);border:1px solid rgba(239,68,68,.3)}.btn-green{background:var(--green-bg);color:var(--green);border:1px solid rgba(16,185,129,.3)}
.event-status-row{display:flex;gap:14px;padding:10px 16px;background:var(--surface2);border-top:1px solid var(--border);flex-wrap:wrap}
.event-stat-label{font-size:9px;color:var(--muted);text-transform:uppercase}
.event-stat-value{font-size:14px;font-weight:700;margin-top:2px}
.hof-card{background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;text-align:center;margin-bottom:6px}
.hof-medal{font-size:24px;margin-bottom:4px}.hof-name{font-size:12px;font-weight:600}.hof-val{font-size:11px;color:var(--amber);margin-top:2px}
.countdown{font-size:28px;font-weight:800;color:var(--amber);text-align:center;padding:14px}
.countdown-sub{font-size:11px;color:var(--muted);text-align:center}
.bar-chart{display:flex;align-items:flex-end;gap:6px;height:70px;padding:0 2px}
.bar-wrap{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px}
.bar{width:100%;border-radius:3px 3px 0 0;background:linear-gradient(180deg,var(--blue),var(--purple));min-height:3px}
.bar-label{font-size:9px;color:var(--muted);white-space:nowrap}
.tag{display:inline-block;font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px}
.tag.green{background:var(--green-bg);color:var(--green)}.tag.red{background:var(--red-bg);color:var(--red)}.tag.muted{background:var(--surface3);color:var(--muted2)}.tag.amber{background:var(--amber-bg);color:var(--amber)}
.empty{text-align:center;padding:24px;color:var(--muted);font-size:12px}
.bonus-item{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)}.bonus-item:last-child{border-bottom:none}
.bottom-nav{display:none;position:fixed;bottom:0;left:0;right:0;background:var(--surface);border-top:1px solid var(--border);padding:6px 0;z-index:100}
@media(max-width:768px){.bottom-nav{display:flex;justify-content:space-around}}
.bnav-item{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:9px;color:var(--muted);cursor:pointer;padding:3px 8px;border:none;background:none}
.bnav-item.active{color:var(--blue)}.bnav-icon{font-size:18px}
</style>
<script>
function showTab(id){document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));document.querySelectorAll('.nav-tab,.bnav-item').forEach(t=>t.classList.remove('active'));document.getElementById('tab-'+id).classList.add('active');document.querySelectorAll('[data-tab="'+id+'"]').forEach(el=>el.classList.add('active'));localStorage.setItem('activeTab',id);}
function filterUsers(){const q=document.getElementById('search').value.toLowerCase();document.querySelectorAll('.user-row').forEach(r=>{r.style.display=r.innerText.toLowerCase().includes(q)?'':'none'});}
window.onload=()=>{showTab(localStorage.getItem('activeTab')||'overview');};
</script>
</head>
<body><div class="page">

<div class="header">
  <div class="header-left"><div class="header-logo">📊</div><div><div class="header-title">Admin Dashboard</div><div class="header-sub">Main Bot DE</div></div></div>
  <div class="header-right">
    <div class="header-time"><span class="live-dot"></span>${now.toLocaleDateString('de-DE',{weekday:'short',day:'2-digit',month:'short'})} · ${now.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})}</div>
    <a href="/logout" class="logout-btn">🚪 Logout</a>
  </div>
</div>

<div class="nav-tabs">
  <button class="nav-tab" data-tab="overview" onclick="showTab('overview')">📊 Übersicht</button>
  <button class="nav-tab" data-tab="users" onclick="showTab('users')">👥 User</button>
  <button class="nav-tab" data-tab="links" onclick="showTab('links')">🔗 Links</button>
  <button class="nav-tab" data-tab="missions" onclick="showTab('missions')">🎯 Missionen</button>
  <button class="nav-tab" data-tab="ranking" onclick="showTab('ranking')">🏆 Rankings</button>
  <button class="nav-tab" data-tab="events" onclick="showTab('events')">⚡ Events</button>
  <button class="nav-tab" data-tab="actions" onclick="showTab('actions')">⚙️ Aktionen</button>
</div>

<!-- ÜBERSICHT -->
<div id="tab-overview" class="tab-content">
  <div class="stats-grid mb-20">
    <div class="stat-card c-blue"><div class="stat-icon c-blue">👥</div><div class="stat-value">${totalUsers}</div><div class="stat-label">Gesamt User</div><div class="stat-sub">${started} gestartet</div></div>
    <div class="stat-card c-green"><div class="stat-icon c-green">⚡</div><div class="stat-value">${activeToday}</div><div class="stat-label">Aktiv heute</div></div>
    <div class="stat-card c-amber"><div class="stat-icon c-amber">🔗</div><div class="stat-value">${todayLinks}</div><div class="stat-label">Links heute</div><div class="stat-sub">${totalLinks} gesamt</div></div>
    <div class="stat-card c-red"><div class="stat-icon c-red">❤️</div><div class="stat-value">${totalLikes}</div><div class="stat-label">Likes gesamt</div></div>
    <div class="stat-card c-purple"><div class="stat-icon c-purple">⚠️</div><div class="stat-value">${withWarns}</div><div class="stat-label">Mit Warns</div><div class="stat-sub">${noInsta.length} ohne Insta</div></div>
    <div class="stat-card c-amber"><div class="stat-icon c-amber">👑</div><div class="stat-value">${eliteUser.length}</div><div class="stat-label">Elite User</div><div class="stat-sub">${erfahreneUser.length} Erfahrene</div></div>
  </div>

  <div class="grid-2 mb-20">
    <div class="card"><div class="card-header"><div class="card-title">📈 XP heute</div></div><div class="card-body"><div style="font-size:36px;font-weight:800;color:var(--amber);text-align:center;padding:10px">${Object.values(d.dailyXP).reduce((s,x)=>s+x,0)}</div><div style="font-size:11px;color:var(--muted);text-align:center">XP heute vergeben</div></div></div>
    <div class="card"><div class="card-header"><div class="card-title">⏰ Nächster Reset</div></div><div class="card-body"><div class="countdown">${hLeft}h ${mLeft}m</div><div class="countdown-sub">bis Tagesreset (23:55)</div><div style="margin-top:12px;font-size:11px;color:var(--muted)"><div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border)"><span>Mission Auswertung</span><span style="color:var(--blue)">12:00</span></div><div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border)"><span>Gewinnspiel</span><span style="color:var(--amber)">So. 20:00</span></div><div style="display:flex;justify-content:space-between;padding:5px 0"><span>Elite Bonus</span><span style="color:#f59e0b">Mo. 00:05</span></div></div></div></div>
  </div>

  <div class="section-title">🏆 Hall of Fame</div>
  <div class="grid-3 mb-20">
    <div class="card"><div class="card-header"><div class="card-title">⭐ Top XP</div></div><div class="card-body">${topAllzeit.map(([,u],i)=>`<div class="hof-card"><div class="hof-medal">${medals[i]}</div><div class="hof-name">${u.name||'?'}</div><div class="hof-val">${u.xp||0} XP</div></div>`).join('')}</div></div>
    <div class="card"><div class="card-header"><div class="card-title">🔗 Meiste Links</div></div><div class="card-body">${topLinksHof.map(([,u],i)=>`<div class="hof-card"><div class="hof-medal">${medals[i]}</div><div class="hof-name">${u.name||'?'}</div><div class="hof-val">${u.links||0} Links</div></div>`).join('')}</div></div>
    <div class="card"><div class="card-header"><div class="card-title">❤️ Meiste Likes</div></div><div class="card-body">${topLikesHof.map(([,u],i)=>`<div class="hof-card"><div class="hof-medal">${medals[i]}</div><div class="hof-name">${u.name||'?'}</div><div class="hof-val">${u.totalLikes||0} Likes</div></div>`).join('')}</div></div>
  </div>

  <div class="grid-2 mb-20">
    <div class="card"><div class="card-header"><div class="card-title">👑 Elite User (${eliteUser.length})</div></div><div class="card-body">${eliteUser.length?eliteUser.map(([,u])=>`<div class="rank-row"><span class="badge-pill bp-elite">👑</span><span class="rank-name" style="margin-left:6px">${u.name}</span><span class="rank-xp">${u.xp} XP</span></div>`).join(''):'<div class="empty">Noch kein Elite User</div>'}</div></div>
    <div class="card"><div class="card-header"><div class="card-title">🏅 Erfahrene (${erfahreneUser.length})</div></div><div class="card-body">${erfahreneUser.slice(0,5).map(([,u])=>`<div class="rank-row"><span class="badge-pill bp-erf">🏅</span><span class="rank-name" style="margin-left:6px">${u.name}</span><span class="rank-xp">${u.xp} XP</span></div>`).join('')||'<div class="empty">Keine Erfahrenen</div>'}</div></div>
  </div>
</div>

<!-- USER -->
<div id="tab-users" class="tab-content">
  <div class="card mb-20">
    <div class="search-row"><input type="text" id="search" class="search-input" placeholder="🔍 User suchen..." onkeyup="filterUsers()"></div>
    <div class="user-table-wrap">
      ${Object.entries(d.users).sort((a,b)=>(b[1].xp||0)-(a[1].xp||0)).map(([id,u])=>{
        const initials=(u.name||'?').slice(0,2).toUpperCase();
        const hasLiked=gelikedSet.has(Number(id));
        const hasLink=d.tracker[id]===today;
        const mData=d.missionen[id]?.date===today?d.missionen[id]:null;
        const nb=xpBisNaechstesBadge(u.xp||0);
        const progress=nb?Math.round(((u.xp||0)/((u.xp||0)+nb.fehlend))*100):100;
        const bc=u.role?.includes('Elite')?'bp-elite':u.role?.includes('Erfahrener')?'bp-erf':u.role?.includes('Aufsteiger')?'bp-auf':u.role?.includes('Anfänger')?'bp-anf':'bp-new';
        return `<div class="user-row">
          <div class="user-avatar">${initials}</div>
          <div class="user-info">
            <div class="user-name">${u.name||'Unbekannt'}${u.username?` <span style="color:var(--muted);font-size:10px">@${u.username}</span>`:''}</div>
            <div class="user-meta">${u.instagram?'📸 @'+u.instagram:'<span style="color:var(--red)">❌ kein Insta</span>'} · <span class="badge-pill ${bc}">${u.role||'🆕'}</span> · <span style="color:${hasLiked?'var(--green)':'var(--red)'}">Like:${hasLiked?'✓':'✗'}</span> · <span style="color:${hasLink?'var(--blue)':'var(--muted)'}">Link:${hasLink?'✓':'✗'}</span>${mData?` · M${mData.m1?'1✓':'1✗'} M${mData.m2?'2✓':'2✗'} M${mData.m3?'3✓':'3✗'}`:''}</div>
            ${nb?`<div class="progress-wrap"><div class="progress-bar" style="width:${progress}%"></div></div><div style="font-size:9px;color:var(--muted);margin-top:1px">Noch ${nb.fehlend} XP bis ${nb.ziel}</div>`:`<div style="font-size:9px;color:#f59e0b;margin-top:1px">👑 Maximales Level!</div>`}
          </div>
          <div class="user-xp"><div class="user-xp-val">${u.xp||0} XP</div><div class="user-xp-sub">Heute: ${d.dailyXP[id]||0}</div><div class="user-xp-sub">Woche: ${d.weeklyXP[id]||0}</div></div>
          ${(u.warnings||0)>0?`<span class="warn-badge">⚠️${u.warnings}</span>`:''}
          <div class="user-actions">
            <a href="/reset-user?id=${id}" class="abtn red">Reset</a>
            <a href="/add-warn?id=${id}" class="abtn red">Warn+</a>
            <a href="/remove-warn?id=${id}" class="abtn amber">Warn−</a>
            <a href="/remove-xp?id=${id}&amount=10" class="abtn muted">−10XP</a>
            <a href="/give-bonus?id=${id}" class="abtn green">+Link</a>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>

  <div class="section-title">⚠️ Warn Center (${usersWithWarns.length})</div>
  <div class="card mb-20"><div class="card-body">${usersWithWarns.length?usersWithWarns.map(([id,u])=>`<div class="bonus-item"><div><div style="font-size:12px;font-weight:600">${u.name||'?'}</div><div style="font-size:10px;color:var(--muted)">${u.xp||0} XP</div></div><div style="display:flex;align-items:center;gap:6px"><span class="warn-badge">⚠️ ${u.warnings}/5</span><a href="/remove-warn?id=${id}" class="abtn amber">Entfernen</a></div></div>`).join(''):'<div class="empty">✅ Keine Warns</div>'}</div></div>

  <div class="section-title">🎁 Bonus Links</div>
  <div class="card"><div class="card-body">${Object.entries(d.bonusLinks||{}).length?Object.entries(d.bonusLinks||{}).map(([id,count])=>`<div class="bonus-item"><div><div style="font-size:12px;font-weight:600">${d.users[id]?.name||'?'}</div></div><span class="tag amber">${count} Bonus Link${count>1?'s':''}</span></div>`).join(''):'<div class="empty">Keine Bonus Links</div>'}</div></div>
</div>

<!-- LINKS -->
<div id="tab-links" class="tab-content">
  <div class="card"><div class="card-body">${Object.entries(d.links).length===0?'<div class="empty">Keine Links</div>':Object.entries(d.links).sort((a,b)=>(b[1].timestamp||0)-(a[1].timestamp||0)).map(([msgId,link])=>{
    const likerIds=Array.from(link.likes||[]);
    const allLikers=likerIds.map(lid=>{const ln=link.likerNames?.[lid];if(ln)return ln;const u=d.users[String(lid)];return u?{name:u.name,insta:u.instagram}:{name:'User '+lid,insta:null};});
    const isToday=new Date(link.timestamp).toDateString()===today;
    return `<div class="link-item"><div style="display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap"><div style="flex:1;min-width:0"><a href="${link.text}" target="_blank" class="link-url">${link.text}</a><div class="link-meta">👤 ${link.user_name} · ❤️ ${link.likes?.size||0} · ${new Date(link.timestamp).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})} ${isToday?'<span class="tag green">Heute</span>':''}</div>${allLikers.length>0?`<div style="margin-top:4px;display:flex;flex-wrap:wrap;gap:2px">${allLikers.map(l=>`<span class="liker-tag">${l.name||'User'}${l.insta?' @'+l.insta:''}</span>`).join('')}</div>`:'<div style="font-size:10px;color:var(--muted);margin-top:3px">Noch keine Likes</div>'}</div><div style="display:flex;gap:4px;align-items:center"><span class="like-badge">❤️${link.likes?.size||0}</span><a href="/delete-link?id=${msgId}" class="abtn red">🗑️</a></div></div></div>`;
  }).join('')}</div></div>
</div>

<!-- MISSIONEN -->
<div id="tab-missions" class="tab-content">
  <div class="mission-grid mb-20">
    <div class="mission-item"><div class="mission-id">MISSION 1</div><div class="mission-count m1">${m1c}</div><div class="mission-sub">erfüllt</div></div>
    <div class="mission-item"><div class="mission-id">MISSION 2</div><div class="mission-count m2">${m2c}</div><div class="mission-sub">erfüllt</div></div>
    <div class="mission-item"><div class="mission-id">MISSION 3</div><div class="mission-count m3">${m3c}</div><div class="mission-sub">erfüllt</div></div>
  </div>
  <div class="grid-2">
    <div class="card"><div class="card-header"><div class="card-title">✅ M1 erfüllt</div></div><div class="card-body">${Object.entries(d.missionen).filter(([uid,m])=>m.date===today&&m.m1&&!istAdminId(uid)).map(([uid])=>`<div class="rank-row"><span class="tag green">✅</span><span class="rank-name" style="margin-left:6px">${d.users[uid]?.name||'?'}</span></div>`).join('')||'<div class="empty">Noch niemand</div>'}</div></div>
    <div class="card"><div class="card-header"><div class="card-title">❌ M1 offen (mit Link)</div></div><div class="card-body">${Object.entries(d.users).filter(([uid,u])=>!istAdminId(uid)&&u.started&&d.tracker[uid]===today&&!(d.missionen[uid]?.m1)).map(([uid,u])=>`<div class="rank-row"><span class="tag red">❌</span><span class="rank-name" style="margin-left:6px">${u.name||'?'}</span><a href="/remind-user?id=${uid}" class="abtn amber">DM</a></div>`).join('')||'<div class="empty">✅ Alle erfüllt</div>'}</div></div>
  </div>
</div>

<!-- RANKINGS -->
<div id="tab-ranking" class="tab-content">
  <div class="grid-3">
    <div class="card"><div class="card-header"><div class="card-title">🏆 Gesamt</div></div><div class="card-body">${gesamtRanking.length?gesamtRanking.map(([,u],i)=>rankRow(i,u.name||'User',(u.xp||0)+' XP')).join(''):'<div class="empty">Keine Daten</div>'}</div></div>
    <div class="card"><div class="card-header"><div class="card-title">📅 Daily</div></div><div class="card-body">${dailyRanking.length?dailyRanking.map(([uid,xp],i)=>rankRow(i,d.users[uid]?.name||'User',xp+' XP')).join(''):'<div class="empty">Heute keine XP</div>'}</div></div>
    <div class="card"><div class="card-header"><div class="card-title">📆 Weekly</div></div><div class="card-body">${weeklyRanking.length?weeklyRanking.map(([uid,xp],i)=>rankRow(i,d.users[uid]?.name||'User',xp+' XP')).join(''):'<div class="empty">Keine XP diese Woche</div>'}</div></div>
  </div>
</div>

<!-- EVENTS -->
<div id="tab-events" class="tab-content">
  <div class="card ${evtAktiv?'active':''}">
    <div class="card-header"><div class="card-title">⚡ XP Event</div><span class="tag ${evtAktiv?'green':'muted'}">${evtAktiv?'🟢 AKTIV':'⭕ INAKTIV'}</span></div>
    <div class="card-body">
      <form action="/create-xp-event" method="get"><div class="event-form-grid">
        <div class="form-group"><label>Bonus (%)</label><input type="number" name="percent" placeholder="z.B. 50" min="1" max="500" required></div>
        <div class="form-group"><label>Dauer (Min)</label><input type="number" name="duration" placeholder="z.B. 120" min="1" required></div>
        <div class="form-group"><label>Start</label><select name="startType" onchange="document.getElementById('ct').style.display=this.value==='custom'?'block':'none'"><option value="now">Sofort</option><option value="custom">Geplant</option></select></div>
        <div class="form-group" id="ct" style="display:none"><label>Startzeit</label><input type="datetime-local" name="startCustom"></div>
        <div class="form-group full" style="display:flex;gap:8px;flex-wrap:wrap"><button type="submit" class="btn btn-primary">🚀 Starten</button><a href="/stop-xp-event" class="btn btn-danger">🛑 Stoppen</a></div>
      </div></form>
    </div>
    <div class="event-status-row">
      <div><div class="event-stat-label">Status</div><div class="event-stat-value" style="color:${evtAktiv?'var(--green)':'var(--muted)'}">${evtAktiv?'Läuft':'Gestoppt'}</div></div>
      <div><div class="event-stat-label">Bonus</div><div class="event-stat-value" style="color:var(--amber)">${evtPct>0?'+'+evtPct+'%':'—'}</div></div>
      <div><div class="event-stat-label">Start</div><div class="event-stat-value">${evtStartStr}</div></div>
      <div><div class="event-stat-label">Ende</div><div class="event-stat-value">${evtEndStr}</div></div>
    </div>
  </div>
</div>

<!-- AKTIONEN -->
<div id="tab-actions" class="tab-content">
  <div class="grid-2 mb-20">
    <div class="card"><div class="card-header"><div class="card-title">📨 DM an alle</div></div><div class="card-body"><form action="/send-dm-all" method="get" style="display:flex;flex-direction:column;gap:10px"><textarea name="text" placeholder="Nachricht an alle User..."></textarea><button type="submit" class="btn btn-primary">📨 Senden</button></form></div></div>
    <div class="card"><div class="card-header"><div class="card-title">⚙️ System</div></div><div class="card-body" style="display:flex;flex-direction:column;gap:8px"><a href="/manual-backup" class="btn btn-green">💾 Backup erstellen</a><a href="/reset-daily" class="btn btn-danger" onclick="return confirm('Daily wirklich zurücksetzen?')">🔄 Daily Reset</a></div></div>
  </div>
  <div class="section-title">📸 Ohne Instagram (${noInsta.length})</div>
  <div class="card"><div class="card-body">${noInsta.length>0?noInsta.map(u=>`<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">👤 ${u.name||'?'}</div>`).join(''):'<div class="empty">✅ Alle haben Instagram</div>'}</div></div>
</div>

</div>
<div class="bottom-nav">
  <button class="bnav-item" data-tab="overview" onclick="showTab('overview')"><span class="bnav-icon">📊</span>Übersicht</button>
  <button class="bnav-item" data-tab="users" onclick="showTab('users')"><span class="bnav-icon">👥</span>User</button>
  <button class="bnav-item" data-tab="links" onclick="showTab('links')"><span class="bnav-icon">🔗</span>Links</button>
  <button class="bnav-item" data-tab="ranking" onclick="showTab('ranking')"><span class="bnav-icon">🏆</span>Ranking</button>
  <button class="bnav-item" data-tab="actions" onclick="showTab('actions')"><span class="bnav-icon">⚙️</span>Aktionen</button>
</div>
</body></html>`);

app.get('/add-warn', (req, res) => {
    if (!isAuthenticated(req)) return res.redirect('/login');
    const uid = req.query.id;
    if (d.users[uid]) { d.users[uid].warnings = (d.users[uid].warnings||0)+1; speichern(); if (d.users[uid].warnings >= 5) sendeAdminNotification('🚨 *5 Warns!*\n👤 ' + d.users[uid].name); }
    res.redirect('/dashboard');
});
app.get('/give-bonus', (req, res) => {
    if (!isAuthenticated(req)) return res.redirect('/login');
    const uid = req.query.id;
    if (d.users[uid]) { if (!d.bonusLinks[uid]) d.bonusLinks[uid]=0; d.bonusLinks[uid]++; speichern(); }
    res.redirect('/dashboard');
});
app.get('/remind-user', async (req, res) => {
    if (!isAuthenticated(req)) return res.redirect('/login');
    const uid = req.query.id;
    if (d.users[uid]) { try { await bot.telegram.sendMessage(Number(uid), '⚠️ *Erinnerung!*\n\nLike noch heute 5 Links! 💪', { parse_mode: 'Markdown' }); } catch(e){} }
    res.redirect('/dashboard');
});
app.get('/send-dm-all', async (req, res) => {
    if (!isAuthenticated(req)) return res.redirect('/login');
    const text = req.query.text;
    if (!text) return res.redirect('/dashboard');
    let ok = 0;
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started) continue;
        try { await bot.telegram.sendMessage(Number(uid), '📢 *Admin:*\n\n' + text, { parse_mode: 'Markdown' }); ok++; await new Promise(r=>setTimeout(r,200)); } catch(e){}
    }
    res.redirect('/dashboard');
});
app.get('/manual-backup', async (req, res) => {
    if (!isAuthenticated(req)) return res.redirect('/login');
    await backup();
    res.redirect('/dashboard');
});
app.get('/reset-daily', (req, res) => {
    if (!isAuthenticated(req)) return res.redirect('/login');
    d.dailyXP={}; d.tracker={}; d.counter={}; d.badgeTracker={};
    speichern();
    res.redirect('/dashboard');
});

app.get('/reset-user',  (req, res) => { if(!isAuthenticated(req)) return res.redirect('/login'); const uid=req.query.id; if(d.users[uid]){d.users[uid].xp=0;d.users[uid].level=1;speichern();} res.redirect('/dashboard'); });
app.get('/remove-warn', (req, res) => { if(!isAuthenticated(req)) return res.redirect('/login'); const uid=req.query.id; if(d.users[uid]){d.users[uid].warnings=0;speichern();} res.redirect('/dashboard'); });
app.get('/delete-link', (req, res) => { if(!isAuthenticated(req)) return res.redirect('/login'); const msgId=req.query.id; if(d.links[msgId]){delete d.links[msgId];speichern();} res.redirect('/dashboard'); });
app.get('/remove-xp',   (req, res) => {
    const uid=req.query.id; const amount=parseInt(req.query.amount)||0;
    if(d.users[uid]&&amount>0){d.users[uid].xp=Math.max(0,(d.users[uid].xp||0)-amount);d.users[uid].level=level(d.users[uid].xp);d.users[uid].role=badge(d.users[uid].xp);speichern();}
    res.redirect('/dashboard');
});
app.get('/create-xp-event', (req, res) => {
    const percent=parseInt(req.query.percent); const durationMin=parseInt(req.query.duration);
    if(!percent||!durationMin) return res.send('❌ Ungültige Eingabe');
    let startTime=req.query.startType==='custom'&&req.query.startCustom?new Date(req.query.startCustom).getTime():Date.now();
    d.xpEvent={aktiv:false,multiplier:1+(percent/100),start:startTime,end:startTime+durationMin*60000,announced:false};
    speichern(); res.redirect('/dashboard');
});
app.get('/stop-xp-event', (req, res) => { d.xpEvent={aktiv:false,multiplier:1,start:null,end:null,announced:false}; speichern(); res.redirect('/dashboard'); });

function checkBridgeSecret(req, res) {
    if (req.headers['x-bridge-secret'] !== BRIDGE_SECRET) { res.status(403).json({ error: 'Forbidden' }); return false; }
    return true;
}

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
                const linkData = { chat_id: event.meta.groupBChatId, user_id: Number(event.userId), user_name: event.userName, text: event.meta.linkText || '', likes: new Set(), likerNames: {}, counter_msg_id: msgId, timestamp: Date.now() };
                const mapKey = MEINE_GRUPPE + '_' + msgId;
                d.links[mapKey] = linkData;
                const url = event.meta.linkText || '';
                if (url && !d.gepostet.includes(url)) { d.gepostet.push(url); if (d.gepostet.length > 2000) d.gepostet.shift(); }
                if (uid && !istAdminId(Number(uid))) d.users[uid].links = (d.users[uid].links || 0) + 1;
                speichernDebounced();
                await sendeLinkAnAlle(linkData);
            }
        }

        if (event.type === 'like_given') {
            const { mapKey } = event.meta || {};
            if (!mapKey || !uid) return;

            let link = d.links[mapKey];
            // FIX: Fallback mit slice(1).join('_')
            if (!link) {
                const msgId = mapKey.split('_').slice(1).join('_');
                link = d.links['B_' + msgId] || d.links['C_' + msgId] ||
                    Object.values(d.links).find(l => String(l.counter_msg_id) === String(msgId));
            }
            if (!link) return;

            const uidNum = Number(uid);
            if (!link.likes) link.likes = new Set();
            // FIX: Nicht nochmal hinzufügen wenn schon geliked
            if (!link.likes.has(uidNum)) {
                link.likes.add(uidNum);
                if (!link.likerNames) link.likerNames = {};
                link.likerNames[uidNum] = { name: name, insta: d.users[uid]?.instagram || null };
            }

            // FIX 1: XP nur vergeben wenn fromBridge=true (Bridge Bot Like, nicht eigener Main Bot Like)
            if (event.meta?.fromBridge) {
                xpAddMitDaily(uid, event.xp || 5, name);
            }

            if (!istAdminId(uid)) {
                const mission = getMission(uid);
                updateMissionProgress(uid);
                if (event.meta?.linkText && istInstagramLink(event.meta.linkText)) mission.likesGegeben++;
                await checkMissionen(uid, name);
            }
            speichernDebounced();
        }

    } catch (e) { console.log('Bridge event Fehler:', e.message); }
});

app.post('/xp-event-announced', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    if (d.xpEvent) d.xpEvent.announced = true;
    speichern(); res.json({ ok: true });
});

app.post('/gewinnspiel-abschluss', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { winnerId, winnerName } = req.body || {};
    if (winnerId) {
        const uid = String(winnerId);
        if (!d.bonusLinks[uid]) d.bonusLinks[uid] = 0;
        d.bonusLinks[uid] += 1;
        d.wochenGewinnspiel.gewinner.push({ name: winnerName, uid, datum: new Date().toLocaleDateString() });
        d.wochenGewinnspiel.letzteAuslosung = Date.now();
    }
    d.weeklyXP = {}; d.weeklyReset = Date.now();
    speichern();
    await weeklyRankingDM();
    res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('🌐 Dashboard läuft auf Port ' + PORT); });

bot.launch();
console.log('🤖 Bot läuft!');

process.on('unhandledRejection', (reason) => { console.log('Unhandled:', reason); });
process.on('uncaughtException', (error)  => { console.log('Uncaught:', error.message); });
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

(async () => { await checkInstagramForAllUsers(); })();

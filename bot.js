import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import express from 'express';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ BOT TOKEN FEHLT!'); process.exit(1); }

const DATA_FILE      = process.env.DATA_FILE || '/data/daten.json';
const DASHBOARD_URL  = process.env.DASHBOARD_URL || '';
const BRIDGE_SECRET  = process.env.BRIDGE_SECRET || 'geheimer-key';
const BRIDGE_BOT_URL = process.env.BRIDGE_BOT_URL || '';
const ADMIN_IDS      = new Set((process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean));
const GROUP_A_ID     = Number(process.env.GROUP_A_ID);
const GROUP_B_ID     = Number(process.env.GROUP_B_ID);
const MEINE_GRUPPE   = 'B';

process.env.TZ = 'Europe/Berlin';

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json());

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
        for (const uid in d.users) {
            if (d.users[uid].inGruppe === undefined) d.users[uid].inGruppe = true;
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
        const trophyMap = { '📘 Anfänger': '📘', '⬆️ Aufsteiger': '⬆️', '🏅 Erfahrener': '🏅', '👑 Elite': '👑' };
        const trophy = trophyMap[u.role];
        if (trophy && !u.trophies.includes(trophy)) u.trophies.push(trophy);
        // Level-Up DM
        bot.telegram.sendMessage(Number(uid),
            '🎉 *Badge Aufstieg!*\n\n' + alteBadge + ' → ' + u.role + '\n\n⭐ ' + u.xp + ' XP\n\nWeiter so! 💪',
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
    u.xp += finalXP; u.level = level(u.xp); u.role = badge(u.xp);
    if (!d.dailyXP[uid]) d.dailyXP[uid] = 0;
    d.dailyXP[uid] += finalXP;
    if (!d.weeklyXP[uid]) d.weeklyXP[uid] = 0;
    d.weeklyXP[uid] += finalXP;
    return finalXP;
}

function user(uid, name) {
    if (!d.users[uid]) {
        d.users[uid] = { name: name || '', username: null, instagram: null, bio: null, spitzname: null, trophies: [], xp: 0, level: 1, warnings: 0, started: false, links: 0, likes: 0, role: '🆕 New', lastDaily: null, totalLikes: 0, chats: [], joinDate: Date.now(), inGruppe: true };
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
    const text = '📋 *Bot Hilfe*\n\n🔗 *Link System:*\n• 1 Link pro Tag\n• Doppelte Links geblockt\n• 👍 Likes = XP\n\n👍 *Like System:*\n• 1 Like pro Link\n• Kein Self-Like\n• +5 XP pro Like\n\n🎯 *Tägliche Missionen:*\n• M1: 5 Links liken → +5 XP\n• M2: 80% liken → +5 XP\n• M3: Alle liken → +5 XP\n• ⏳ XP um 12:00 Uhr\n\n📅 *Wochen Missionen:*\n• 7x M1 → +10 XP\n• 7x M2 → +15 XP\n• 7x M3 → +20 XP\n\n🏅 *Badges:*\n• 🆕 New: 0-49 XP\n• 📘 Anfänger: 50-499 XP\n• ⬆️ Aufsteiger: 500-999 XP\n• 🏅 Erfahrener: 1000-4999 XP (+1 Link/Tag)\n• 👑 Elite: 5000+ XP (+1 Link/Tag +1 Link/Woche)\n\n👤 *Profil:*\n• /profil — dein Profil\n• /profil @username — fremdes Profil\n• /setbio — Bio setzen\n• /setspitzname — Spitzname setzen\n• /setinsta — Instagram setzen\n\n📊 *Rankings:*\n• /ranking — Gesamt\n• /dailyranking — Heute\n• /weeklyranking — Diese Woche\n\n🎁 *Sonstiges:*\n• /daily — Täglicher Bonus\n• /missionen — Missions Übersicht';
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
    if (u.instagram) text += '📸 [@' + u.instagram + '](https://instagram.com/' + u.instagram + ')\n';
    if (u.username) text += '💬 @' + u.username + '\n';
    if (u.bio) text += '✍️ _' + u.bio + '_\n';
    text += '\n';
    text += u.role + '\n';
    text += '⭐ ' + (u.xp || 0) + ' XP · Lvl ' + (u.level || 1) + '\n';
    text += '🏆 Rang #' + rank + '\n';
    text += '🔗 ' + (u.links || 0) + ' Links · ❤️ ' + (u.totalLikes || 0) + ' Likes\n';
    text += '📅 Daily: ' + (d.dailyXP[zielUid] || 0) + ' · 📆 Weekly: ' + (d.weeklyXP[zielUid] || 0) + '\n';
    if (bonusL > 0) text += '🎁 Bonus Links: ' + bonusL + '\n';
    text += '⚠️ Warns: ' + (u.warnings || 0) + '/5\n';
    text += '📆 Dabei seit: ' + joinDatum + '\n';
    if (nb) text += '\n⬆️ Noch ' + nb.fehlend + ' XP bis ' + nb.ziel;
    if (trophies !== '—') text += '\n\n🎖️ *Trophäen:* ' + trophies;

    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('remindinsta', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    let count = 0;
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started || (u.instagram && u.instagram.trim() !== '')) continue;
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
        d.warte[m.id] = ctx.chat.id;
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

bot.command('melden', async (ctx) => {
    const uid = ctx.from.id;
    if (istAdminId(uid)) return;
    try {
        if (!istPrivat(ctx.chat.type)) {
            const info = await ctx.telegram.getMe();
            return ctx.reply('📩 Bitte melde im privaten Chat!', {
                reply_markup: Markup.inlineKeyboard([[Markup.button.url('📩 Hier melden', 'https://t.me/' + info.username + '?start=start')]]).reply_markup
            });
        }
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
// APP LOGIN CODE SYSTEM
// ================================
bot.command('mycode', async (ctx) => {
    const uid = String(ctx.from.id);
    const u = user(ctx.from.id, ctx.from.first_name);

    // Code generieren falls noch keiner existiert
    if (!u.appCode) {
        const name = (ctx.from.first_name||'user').toLowerCase().replace(/[^a-z0-9]/g,'');
        const rand = Math.floor(1000 + Math.random() * 9000);
        u.appCode = name + rand;
        speichern();
    }

    await ctx.reply(
        '🔐 *Dein CreatorBoost Login Code*\n\n' +
        '`' + u.appCode + '`\n\n' +
        '👆 Tippe auf den Code zum Kopieren\n\n' +
        '📱 Öffne die App und trage diesen Code ein.\n' +
        '⚠️ Teile deinen Code mit niemandem!',
        { parse_mode: 'Markdown' }
    );
});

bot.on('left_chat_member', async (ctx) => {
    try {
        const m = ctx.message.left_chat_member;
        if (!m || m.is_bot) return;
        const uid = String(m.id);
        if (d.users[uid] && !istAdminId(Number(uid))) {
            delete d.users[uid];
            delete d.dailyXP[uid];
            delete d.weeklyXP[uid];
            delete d.bonusLinks[uid];
            delete d.missionen[uid];
            delete d.tracker[uid];
            delete d.counter[uid];
            delete d.badgeTracker[uid];
            speichern();
            console.log('User gelöscht:', m.first_name, uid);
        }
    } catch(e) { console.log('left_chat_member Fehler:', e.message); }
});

bot.on('message', async (ctx) => {
    try {
        const uid_msg = ctx.from.id;

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
    const heute = new Date().toDateString();
    const heutigeLinks = Object.entries(d.links).filter(([, l]) =>
        new Date(l.timestamp).toDateString() === heute
    );
    if (!heutigeLinks.length) return;

    let gesendet = 0;
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started || istAdminId(uid)) continue;

        const nichtGeliked = heutigeLinks.filter(([, l]) =>
            l.user_id !== Number(uid) && !l.likes.has(Number(uid))
        );
        if (!nichtGeliked.length) continue;

        let text = '👋 *Hey ' + u.name + '!*\n\n⚠️ Du hast heute noch nicht alle Links geliked:\n\n';
        const buttons = [];

        for (const [, l] of nichtGeliked) {
            const insta = l.user_id ? (d.users[String(l.user_id)]?.instagram ? ' · 📸 @' + d.users[String(l.user_id)].instagram : '') : '';
            text += '👤 ' + l.user_name + insta + '\n';
            if (l.counter_msg_id && l.chat_id) {
                const url = 'https://t.me/c/' + String(l.chat_id).replace('-100', '') + '/' + l.counter_msg_id;
                buttons.push([{ text: '👍 ' + l.user_name + ' liken', url: url }]);
            }
        }

        text += '\n⏳ Missionen schließen um 12:00 Uhr!';

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


async function gruppenMitgliederPruefen() {
    console.log('🔍 Prüfe Gruppenmitglieder...');
    let aktiv = 0, geloescht = 0;
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started || istAdminId(uid)) continue;
        try {
            const member = await bot.telegram.getChatMember(GROUP_A_ID, Number(uid));
            if (['left', 'kicked', 'banned'].includes(member.status)) {
                delete d.users[uid];
                // Auch aus dailyXP, weeklyXP etc. entfernen
                delete d.dailyXP[uid];
                delete d.weeklyXP[uid];
                delete d.bonusLinks[uid];
                delete d.missionen[uid];
                delete d.tracker[uid];
                delete d.counter[uid];
                delete d.badgeTracker[uid];
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
        if (h === 4  && m === 0)  einmalig('memberCheck', () => gruppenMitgliederPruefen());
        if (jetzt.getDay() === 1 && h === 0 && m === 5) einmalig('wochenReset', () => { d.wochenMissionen = {}; console.log('✅ Wochenmissionen resettet'); speichern(); });
        if (h === 7  && m === 5)  einmalig('toplinks',     () => { Object.values(d.chats).filter(c => istGruppe(c.type)).forEach(g => topLinks(g.id)); });
        if (h === 12 && m === 0)  einmalig('missionen',    () => missionenAuswerten());
        if (h === 22 && m === 0)  einmalig('abendwarnung', () => abendM1Warnung());
        if (h === 22 && m === 0)  einmalig('reminder',     () => likeErinnerung());
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

app.get('/data', (req, res) => {
    const secret = req.headers['x-bridge-secret'] || req.query.secret;
    if (secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Forbidden' });
    const out = Object.assign({}, d);
    out.links = {};
    for (const [k, v] of Object.entries(d.links)) out.links[k] = Object.assign({}, v, { likes: Array.from(v.likes) });
    res.json(out);
});

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


// ================================
// DASHBOARD API ENDPOINTS
// ================================

app.get('/reset-user', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = req.query.id;
    if (d.users[uid]) { d.users[uid].xp=0; d.users[uid].level=1; d.users[uid].role=badge(0); speichern(); }
    res.json({ ok: true });
});

app.get('/remove-warn', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = req.query.id;
    if (d.users[uid]) { d.users[uid].warnings=0; speichern(); }
    res.json({ ok: true });
});

app.get('/add-warn', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = req.query.id;
    if (d.users[uid]) {
        d.users[uid].warnings = (d.users[uid].warnings||0)+1;
        speichern();
        try { await bot.telegram.sendMessage(Number(uid), '⚠️ *Verwarnung!*\nWarn: ' + d.users[uid].warnings + '/5', { parse_mode: 'Markdown' }); } catch(e) {}
    }
    res.json({ ok: true });
});

app.get('/remove-xp', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = req.query.id;
    const amount = parseInt(req.query.amount)||0;
    if (d.users[uid] && amount > 0) {
        d.users[uid].xp = Math.max(0, (d.users[uid].xp||0)-amount);
        d.users[uid].level = level(d.users[uid].xp);
        d.users[uid].role = badge(d.users[uid].xp);
        speichern();
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
        try { await bot.telegram.sendMessage(Number(uid), '🎁 *Extra-Link erhalten!*', { parse_mode: 'Markdown' }); } catch(e) {}
    }
    res.json({ ok: true });
});

app.get('/delete-link', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const msgId = req.query.id;
    if (d.links[msgId]) { delete d.links[msgId]; speichern(); }
    res.json({ ok: true });
});

app.get('/ban-user', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = req.query.id;
    if (d.users[uid]) {
        try {
            // Ban in allen Gruppen
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
            if (!u.started) continue;
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

app.get('/add-xp', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = req.query.id;
    const amount = parseInt(req.query.amount)||0;
    if (d.users[uid] && amount > 0) {
        xpAddMitDaily(uid, amount, d.users[uid].name);
        speichern();
    }
    res.json({ ok: true });
});

app.get('/reset-daily-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    d.dailyXP={}; d.tracker={}; d.counter={}; d.badgeTracker={};
    speichern();
    res.json({ ok: true });
});


app.get('/remind-insta-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    let count = 0;
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started || (u.instagram && u.instagram.trim() !== '')) continue;
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


app.post('/update-profile-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, bio, spitzname, banner, accentColor } = req.body || {};
    if (d.users[uid]) {
        if (bio !== undefined) d.users[uid].bio = bio.slice(0,100);
        if (spitzname !== undefined) d.users[uid].spitzname = spitzname.slice(0,30);
        if (banner !== undefined) d.users[uid].banner = banner;
        if (accentColor !== undefined) d.users[uid].accentColor = accentColor;
        speichern();
    }
    res.json({ ok: true });
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

    // Link finden
    let lnk = d.links[msgId] || Object.values(d.links).find(l => String(l.counter_msg_id) === String(msgId));
    if (!lnk) return res.json({ok:false, error:'Link nicht gefunden'});

    const uidNum = Number(uid);
    if (!lnk.likes) lnk.likes = new Set();
    if (lnk.likes.has(uidNum)) {
        // Unlike
        lnk.likes.delete(uidNum);
        if (lnk.likerNames) delete lnk.likerNames[uidNum];
    } else {
        // Like
        if (uidNum === lnk.user_id) return res.json({ok:false, error:'Kein Self-Like'});
        lnk.likes.add(uidNum);
        const u = d.users[uid];
        if (!lnk.likerNames) lnk.likerNames = {};
        lnk.likerNames[uidNum] = { name: u?.name||'User', insta: u?.instagram||null };
        // XP vergeben
        if (!istAdminId(uid)) xpAddMitDaily(uid, 5, u?.name||'User');
        // Mission aktualisieren
        const mission = getMission(uid);
        if (istInstagramLink(lnk.text)) mission.likesGegeben++;
        await checkMissionen(uid, u?.name||'User');
    }

    speichernDebounced();

    // Telegram Counter sofort updaten
    try {
        const { Markup } = require('telegraf');
        const poster = d.users[String(lnk.user_id)] || {};
        const anz = lnk.likes.size;
        const posterLabel = istAdminId(lnk.user_id) ? '⚙️ Admin ' + lnk.user_name : (poster.role||'🆕') + ' ' + lnk.user_name;
        const posterStats = istAdminId(lnk.user_id) ? '' : '  |  ⭐ ' + (poster.xp||0) + ' XP';
        await bot.telegram.editMessageText(
            lnk.chat_id,
            lnk.counter_msg_id,
            null,
            posterLabel + '\n🔗 ' + lnk.text + '\n\n👍 ' + anz + ' Likes' + posterStats,
            { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('👍 Like  |  ' + anz, 'like_' + (msgId.includes('_') ? msgId.split('_').slice(1).join('_') : msgId))]]).reply_markup }
        );
    } catch(e) { console.log('Telegram Sync Fehler:', e.message); }

    res.json({ok:true, likes: lnk.likes.size});
});


// ── PHASE 2 API ENDPOINTS ──

app.post('/follow-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { followerUid, targetUid } = req.body || {};
    if (!followerUid || !targetUid) return res.json({ok:false});
    if (!d.users[followerUid]) return res.json({ok:false});
    if (!d.users[followerUid].following) d.users[followerUid].following = [];
    if (!d.users[targetUid].followers) d.users[targetUid].followers = [];
    const idx = d.users[followerUid].following.indexOf(targetUid);
    if (idx === -1) {
        d.users[followerUid].following.push(targetUid);
        d.users[targetUid].followers.push(followerUid);
    } else {
        d.users[followerUid].following.splice(idx, 1);
        d.users[targetUid].followers = d.users[targetUid].followers.filter(id => id !== followerUid);
    }
    speichern();
    res.json({ok:true});
});

app.post('/create-post-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, text } = req.body || {};
    if (!uid || !text) return res.json({ok:false});
    if (!d.posts) d.posts = {};
    if (!d.posts[uid]) d.posts[uid] = [];
    d.posts[uid].push({ text: text.slice(0,300), timestamp: Date.now(), likes: [] });
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
    speichern();
    res.json({ok:true});
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


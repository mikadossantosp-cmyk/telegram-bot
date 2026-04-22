import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import express from 'express';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN || BOT_TOKEN === "DEIN_BOT_TOKEN") {
    console.error("❌ BOT TOKEN FEHLT!");
    process.exit(1);
}
const DATA_FILE = process.env.DATA_FILE || '/data/daten.json';
process.env.TZ = 'Europe/Berlin';
const bot = new Telegraf(BOT_TOKEN);
const app = express();

const ADMIN_IDS = new Set((process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean));
const GROUP_A_ID = Number(process.env.GROUP_A_ID);
const GROUP_B_ID = Number(process.env.GROUP_B_ID);
const DASHBOARD_URL = process.env.DASHBOARD_URL;
function istAdminId(uid) { return ADMIN_IDS.has(Number(uid)); }

// ================================
// DATEN
// ================================
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
    xpEvent: {
    aktiv: false,
    multiplier: 1,
    start: null,
    end: null,
    announced: false
},
};

function laden() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const geladen = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            d = Object.assign({}, d, geladen);
            for (const uid in d.users) {
                d.users[uid].started = true;
                if (!d.users[uid].instagram) d.users[uid].instagram = null;
                if (istAdminId(Number(uid))) {
                    d.users[uid].xp = 0;
                    d.users[uid].level = 1;
                    d.users[uid].role = '⚙️ Admin';
                }
            }
            for (const k of Object.keys(d.links)) {
                const link = d.links[k];
                link.likes = new Set(Array.isArray(link.likes) ? link.likes : []);
                link.msgId = Number(k);
                if (!link.likerNames) link.likerNames = {};
                if (!link.counter_msg_id || !link.chat_id) { delete d.links[k]; continue; }
            }
            if (!d.dailyXP) d.dailyXP = {};
            if (!d.weeklyXP) d.weeklyXP = {};
            if (!d.bonusLinks) d.bonusLinks = {};
            if (!d.missionen) d.missionen = {};
            if (!d.wochenMissionen) d.wochenMissionen = {};
            if (!d.warteNachricht) d.warteNachricht = {};
            if (!d.dmNachrichten) d.dmNachrichten = {};
            if (!d.instaWarte) d.instaWarte = {};
            if (!d.wochenGewinnspiel) d.wochenGewinnspiel = { aktiv: true, gewinner: [], letzteAuslosung: null };
            if (!d.missionQueue) d.missionQueue = {};
            if (!d.gesternDailyXP) d.gesternDailyXP = {};
            if (!d.badgeTracker) d.badgeTracker = {};
            if (!d.m1Streak) d.m1Streak = {};
            if (!d.missionAuswertungErledigt) d.missionAuswertungErledigt = {};
            if (!d._lastEvents) d._lastEvents = {};
            if (!d.xpEvent) {
    d.xpEvent = {
        aktiv: false,
        multiplier: 1,
        start: null,
        end: null,
        announced: false
    };
            }
            console.log('✅ Daten geladen');
        }
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
        for (const [k, v] of Object.entries(d.links)) {
            s.links[k] = Object.assign({}, v, { likes: Array.from(v.likes) });
        }
        s.users = {};
        for (const [uid, u] of Object.entries(d.users)) {
            s.users[uid] = Object.assign({}, u);
            if (istAdminId(Number(uid))) {
                s.users[uid].xp = 0;
                s.users[uid].level = 1;
                s.users[uid].role = '⚙️ Admin';
            }
        }
        const tmpFile = DATA_FILE + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(s, null, 2));
        fs.renameSync(tmpFile, DATA_FILE);
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

async function checkInstagramForAllUsers(bot) {
    console.log('📸 Starte Instagram Check...');
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started) continue;
        if (u.instagram && u.instagram.trim() !== '') continue;
        if (d.instaWarte[uid]) continue;
        try {
            await bot.telegram.sendMessage(
                Number(uid),
                '📸 Bitte schick mir deinen Instagram Namen.\n\n(z.B. max123)',
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '📸 Instagram eingeben', callback_data: 'set_insta' }]
                        ]
                    }
                }
            );
            d.instaWarte[uid] = true;
            console.log('✅ DM gesendet an', uid);
            await new Promise(r => setTimeout(r, 150));
        } catch (e) {
            console.log('❌ DM fehlgeschlagen bei', uid);
        }
    }
    speichern();
}

// ================================
// BACKUP
// ================================
async function backup() {
    try {
        const heute = new Date().toDateString();
        if (d.backupDatum === heute) return;
        const backupFile = DATA_FILE.replace('.json', '_backup_' + new Date().toISOString().slice(0, 10) + '.json');
        const s = Object.assign({}, d);
        s.links = {};
        for (const [k, v] of Object.entries(d.links)) {
            s.links[k] = Object.assign({}, v, { likes: Array.from(v.likes) });
        }
        fs.writeFileSync(backupFile, JSON.stringify(s, null, 2));
        d.backupDatum = heute;
        console.log('✅ Backup:', backupFile);
    } catch (e) { console.log('Backup Fehler:', e.message); }
}

// ================================
// BADGE SYSTEM
// ================================
function badge(xp) {
    if (xp >= 1000) return '🏅 Erfahrener';
    if (xp >= 500) return '⬆️ Aufsteiger';
    if (xp >= 50) return '📘 Anfänger';
    return '🆕 New';
}

function badgeBonusLinks(xp) {
    if (xp >= 1000) return 1;
    return 0;
}

function xpBisNaechstesBadge(xp) {
    if (xp < 50) return { ziel: '📘 Anfänger', fehlend: 50 - xp };
    if (xp < 500) return { ziel: '⬆️ Aufsteiger', fehlend: 500 - xp };
    if (xp < 1000) return { ziel: '🏅 Erfahrener', fehlend: 1000 - xp };
    return null;
}

// ================================
// HILFSFUNKTIONEN
// ================================
function level(xp) { return Math.floor(xp / 100) + 1; }

function xpAdd(uid, menge, name) {
    if (istAdminId(uid)) return 0;
    const u = user(uid, name);
    let finalXP = menge;
    if (d.xpEvent && d.xpEvent.aktiv && d.xpEvent.multiplier > 1) {
        finalXP = Math.round(menge * d.xpEvent.multiplier);
    }
    u.xp += finalXP;
    u.level = level(u.xp);
    u.role = badge(u.xp);
    if (!d.weeklyXP[uid]) d.weeklyXP[uid] = 0;
    d.weeklyXP[uid] += finalXP;
    return finalXP;
}

function xpAddMitDaily(uid, menge, name) {
    if (istAdminId(uid)) return 0;
    const u = user(uid, name);
    let finalXP = menge;
    if (d.xpEvent && d.xpEvent.aktiv && d.xpEvent.multiplier > 1) {
        finalXP = Math.round(menge * d.xpEvent.multiplier);
    }
    u.xp += finalXP;
    u.level = level(u.xp);
    u.role = badge(u.xp);
    if (!d.dailyXP[uid]) d.dailyXP[uid] = 0;
    d.dailyXP[uid] += finalXP;
    if (!d.weeklyXP[uid]) d.weeklyXP[uid] = 0;
    d.weeklyXP[uid] += finalXP;
    return finalXP;
}

function user(uid, name) {
    if (!d.users[uid]) {
        d.users[uid] = {
            name: name || '', username: null, instagram: null, xp: 0, level: 1,
            warnings: 0, started: false, links: 0, likes: 0,
            role: '🆕 New', lastDaily: null, totalLikes: 0, chats: []
        };
    }
    if (name) d.users[uid].name = name;
    if (istAdminId(uid)) {
        d.users[uid].xp = 0;
        d.users[uid].level = 1;
        d.users[uid].role = '⚙️ Admin';
    }
    return d.users[uid];
}

function chat(cid, obj) {
    if (!d.chats[cid]) {
        d.chats[cid] = { id: cid, type: (obj && obj.type) || 'unknown', title: (obj && (obj.title || obj.first_name)) || 'Unbekannt', msgs: 0 };
    }
    if (obj) { d.chats[cid].type = obj.type; d.chats[cid].title = obj.title || obj.first_name || d.chats[cid].title; }
    d.chats[cid].msgs++;
    return d.chats[cid];
}

function istGruppe(t) { return t === 'group' || t === 'supergroup'; }
function istPrivat(t) { return t === 'private'; }

async function istAdmin(ctx, uid) {
    try {
        if (istPrivat(ctx.chat && ctx.chat.type)) return true;
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
    try {
        return url.toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/\/$/, '')
            .split('?')[0];
    } catch (e) { return url; }
}

function istSperrzeit() {
    const jetzt = new Date();
    const tag = jetzt.getDay();
    const h = jetzt.getHours();
    if (tag === 0 && h >= 20) return true;
    if (tag === 1 && h < 6) return true;
    return false;
}

function hatBonusLink(uid) { return d.bonusLinks[uid] && d.bonusLinks[uid] > 0; }
function bonusLinkNutzen(uid) {
    if (hatBonusLink(uid)) { d.bonusLinks[uid]--; if (d.bonusLinks[uid] <= 0) delete d.bonusLinks[uid]; return true; }
    return false;
}

// ================================
// MISSIONS SYSTEM
// ================================
function getMission(uid) {
    const heute = new Date().toDateString();
    if (!d.missionen[uid] || d.missionen[uid].date !== heute) {
        d.missionen[uid] = { date: heute, likesGegeben: 0, m1: false, m2: false, m3: false };
    }
    return d.missionen[uid];
}

function getWochenMission(uid) {
    if (!d.wochenMissionen[uid]) {
        d.wochenMissionen[uid] = { m1Tage: 0, m2Tage: 0, m3Tage: 0, letzterTag: null };
    }
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
        try {
            await bot.telegram.sendMessage(Number(uid),
                '🎯 *Mission 1 erreicht!*\n\n✅ Du hast heute 5 Instagram-Links geliked!\n\n⏳ XP werden um 12:00 Uhr vergeben.',
                { parse_mode: 'Markdown' }
            );
        } catch (e) {}
    }
    speichernDebounced();
}

// ================================
// MISSIONS AUSWERTUNG
// ================================
async function missionenAuswerten() {
    const heute = new Date().toDateString();
    const jetzt12 = heute + '_12';
    if (d.missionAuswertungErledigt && d.missionAuswertungErledigt[jetzt12]) return;
    if (!d.missionAuswertungErledigt) d.missionAuswertungErledigt = {};
    d.missionAuswertungErledigt[jetzt12] = true;

    for (const [uid, queue] of Object.entries(d.missionQueue)) {
        if (istAdminId(uid)) continue;
        if (queue.date === heute) continue;

        const name = d.users[uid] ? d.users[uid].name : '';
        const wMission = getWochenMission(uid);
        const gestern = queue.date;
        let meldungen = [];

        const gestrigeLinks = Object.values(d.links).filter(l => new Date(l.timestamp).toDateString() === gestern);
        const gestrigeInstaLinks = gestrigeLinks.filter(l => istInstagramLink(l.text) && l.user_id !== Number(uid));
        const gesamtGestern = gestrigeInstaLinks.length;
        const gelikedGestern = gestrigeInstaLinks.filter(l => l.likes.has(Number(uid))).length;
        const prozentGestern = gesamtGestern > 0 ? gelikedGestern / gesamtGestern : 0;
        const minLinksVorhanden = gestrigeInstaLinks.length >= 5;

        if (queue.m1Pending) {
            xpAdd(uid, 5, name);
            meldungen.push('✅ *Mission 1!*\n5 Links geliked → +5 XP');
            if (wMission.letzterTag !== gestern) {
                wMission.m1Tage++;
                if (wMission.m1Tage >= 7) {
                    xpAdd(uid, 10, name);
                    meldungen.push('🏆 *Wochen-M1!* +10 XP');
                    wMission.m1Tage = 0;
                }
            }
        }

        if (gesamtGestern > 0 && prozentGestern >= 0.8) {
            xpAdd(uid, 5, name);
            meldungen.push('✅ *Mission 2!*\n' + Math.round(prozentGestern * 100) + '% geliked → +5 XP');
            if (wMission.letzterTag !== gestern) {
                wMission.m2Tage++;
                if (wMission.m2Tage >= 7) { xpAdd(uid, 15, name); meldungen.push('🏆 *Wochen-M2!* +15 XP'); wMission.m2Tage = 0; }
            }
        }

        if (gesamtGestern > 0 && gelikedGestern === gesamtGestern) {
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
            if (d.m1Streak[uid].count >= 5 && d.users[uid] && d.users[uid].warnings > 0) {
                d.users[uid].warnings--;
                d.m1Streak[uid].count = 0;
                try { await bot.telegram.sendMessage(Number(uid), '🎉 *Warn entfernt!* 5 Tage M1 in Folge!\n⚠️ Warns: ' + d.users[uid].warnings + '/5', { parse_mode: 'Markdown' }); } catch (e) {}
            }
        } else {
            d.m1Streak[uid].count = 0;
        }

        if (hatGesternLink && !queue.m1Pending && minLinksVorhanden && d.users[uid]) {
            d.users[uid].warnings = (d.users[uid].warnings || 0) + 1;
            const warnCount = d.users[uid].warnings;
            try {
                await bot.telegram.sendMessage(Number(uid),
                    '⚠️ *Verwarnung!*\nLink gepostet aber M1 nicht erfüllt.\n⚠️ Warns: ' + warnCount + '/5',
                    { parse_mode: 'Markdown' }
                );
            } catch (e) {}
        }

        if (meldungen.length > 0 && d.users[uid]) {
            const u = d.users[uid];
            const nb = xpBisNaechstesBadge(u.xp);
            try {
                await bot.telegram.sendMessage(Number(uid),
                    '🎯 *Missions Auswertung*\n\n' + meldungen.join('\n\n') + '\n\n⭐ Gesamt: ' + u.xp + ' XP' + (nb ? '\n⬆️ Noch ' + nb.fehlend + ' XP bis ' + nb.ziel : ''),
                    { parse_mode: 'Markdown' }
                );
            } catch (e) {}
        } else if (d.users[uid] && d.users[uid].started && !hatGesternLink) {
            try { await bot.telegram.sendMessage(Number(uid), '📊 *Missions Auswertung*\n\n❌ Keine Mission erfüllt.\n\nHeute neue Chance! 💪', { parse_mode: 'Markdown' }); } catch (e) {}
        }

        delete d.missionQueue[uid];
    }

    const nurHeute = {};
    if (d.missionAuswertungErledigt[jetzt12]) nurHeute[jetzt12] = true;
    d.missionAuswertungErledigt = nurHeute;
    speichern();
}

// ================================
// WEEKLY RANKING DM
// ================================
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

// ================================
// MIDDLEWARE
// ================================
bot.use(async (ctx, next) => {
    try {
        if (ctx.chat && ctx.from) {
            chat(ctx.chat.id, ctx.chat);
            const u = user(ctx.from.id, ctx.from.first_name);
            if (ctx.from.username) u.username = ctx.from.username;
            if (!u.chats.includes(ctx.chat.id)) u.chats.push(ctx.chat.id);
            if (istAdminId(ctx.from.id)) { u.xp = 0; u.level = 1; u.role = '⚙️ Admin'; }
        }
        return next();
    } catch (e) { console.log('Middleware Fehler:', e.message); return next(); }
});

// ================================
// /start
// ================================
bot.start(async (ctx) => {
    const uid = ctx.from.id;
    const u = user(uid, ctx.from.first_name);
    u.started = true;
    if (d.warteNachricht && d.warteNachricht[uid]) {
        try {
            const { chatId, msgId } = d.warteNachricht[uid];
            await bot.telegram.deleteMessage(chatId, msgId);
        } catch (e) {}
        delete d.warteNachricht[uid];
    }
    if (d.warte[uid]) delete d.warte[uid];
    speichern();
    if (istPrivat(ctx.chat.type)) {
        if (!u.instagram) {
            d.instaWarte[uid] = true;
            speichern();
            return ctx.reply('📸 Willkommen!\n\nWie heißt dein Instagram Account?\n\n(z.B. max123)');
        }
        return ctx.reply('✅ Bot gestartet!\n\n📋 /help für alle Befehle.');
    }
});

// ================================
// /help
// ================================
bot.command('help', async (ctx) => {
    const uid = ctx.from.id;
    const u = user(uid, ctx.from.first_name);
    const text =
        '📋 *Bot Hilfe*\n\n' +
        '🔗 *Link System:*\n• 1 Link pro Tag\n• Doppelte Links geblockt\n• 👍 Likes = XP\n\n' +
        '👍 *Like System:*\n• 1 Like pro Link\n• Kein Self-Like\n• +5 XP pro Like\n\n' +
        '🎯 *Tägliche Missionen:*\n• M1: 5 Links liken → +5 XP\n• M2: 80% liken → +5 XP\n• M3: Alle liken → +5 XP\n• ⏳ XP um 12:00 Uhr\n\n' +
        '📅 *Wochen Missionen:*\n• 7x M1 → +10 XP\n• 7x M2 → +15 XP\n• 7x M3 → +20 XP\n\n' +
        '🏅 *Badges:*\n• 🆕 New: 0-49 XP\n• 📘 Anfänger: 50-499 XP\n• ⬆️ Aufsteiger: 500-999 XP\n• 🏅 Erfahrener: 1000+ XP\n\n' +
        '/ranking /dailyranking /weeklyranking /profile /daily /missionen';
    if (u.started) {
        try { await ctx.telegram.sendMessage(uid, text, { parse_mode: 'Markdown' }); if (!istPrivat(ctx.chat.type)) await ctx.reply('📩 Hilfe per DM!'); }
        catch (e) { await ctx.reply(text, { parse_mode: 'Markdown' }); }
    } else {
        const info = await ctx.telegram.getMe();
        await ctx.reply('⚠️ Starte zuerst den Bot per DM!', { reply_markup: Markup.inlineKeyboard([Markup.button.url('📩 Bot starten', 'https://t.me/' + info.username + '?start=help')]).reply_markup });
    }
});

// ================================
// /missionen
// ================================
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

// ================================
// /profile
// ================================
bot.command('profile', async (ctx) => {
    const uid = ctx.from.id;
    const u = user(uid, ctx.from.first_name);

    const sorted = Object.entries(d.users)
        .filter(([id]) => !istAdminId(id))
        .sort((a, b) => b[1].xp - a[1].xp);

    const rank = sorted.findIndex(x => x[0] == uid) + 1;
    const bonusL = d.bonusLinks[uid] || 0;

    const mission = getMission(uid);
    const likesHeute = mission.likesGegeben || 0;

    await ctx.reply(
        '👤 <b>' + u.name + (istAdminId(uid) ? ' ⚙️ Admin' : '') + '</b>\n' +
        (u.instagram ? '📸 @' + u.instagram + '\n' : '') +
        (u.username ? '@' + u.username + '\n' : '') +
        '🏅 ' + u.role + '\n' +
        '⭐ XP: ' + u.xp + '\n' +
        '👍 Likes heute: ' + likesHeute + '\n' +
        '📅 Heute: ' + (d.dailyXP[uid] || 0) + '\n' +
        '📆 Woche: ' + (d.weeklyXP[uid] || 0) + '\n' +
        '🏆 Rang: #' + rank + '\n' +
        '🔗 Links: ' + u.links +
        (bonusL > 0 ? '\n🎁 Bonus: ' + bonusL : '') +
        '\n👍 Likes gesamt: ' + u.totalLikes + '\n' +
        '⚠️ Warns: ' + u.warnings + '/5',
        { parse_mode: 'HTML' }
    );
});
// ================================
// /setinsta
// ================================
bot.command('setinsta', async (ctx) => {
    const uid = ctx.from.id;
    if (!istPrivat(ctx.chat.type)) return ctx.reply('❌ Bitte nutze den Befehl im privaten Chat mit dem Bot.');
    d.instaWarte[uid] = true;
    speichern();
    return ctx.reply('📸 Schick mir deinen neuen Instagram Namen.\n\n(z.B. max123)');
});

// ================================
// /ranking
// ================================
bot.command('ranking', async (ctx) => {
    const sorted = Object.entries(d.users).filter(([uid]) => !istAdminId(uid)).sort((a, b) => b[1].xp - a[1].xp).slice(0, 10);
    if (!sorted.length) return ctx.reply('Noch keine Daten.');
    const b = ['🥇', '🥈', '🥉'];
    let text = '🏆 *GESAMT RANKING*\n\n';
    sorted.forEach(([, u], i) => { text += (b[i] || (i + 1) + '.') + ' ' + u.role + ' *' + u.name + '*\n   ⭐' + u.xp + ' | Lvl ' + u.level + '\n\n'; });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ================================
// /dailyranking
// ================================
bot.command('dailyranking', async (ctx) => {
    const sorted = Object.entries(d.dailyXP).filter(([uid]) => d.users[uid] && !istAdminId(uid)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return ctx.reply('Heute noch keine XP.');
    const b = ['🥇', '🥈', '🥉'];
    let text = '📅 *TAGES RANKING*\n\n';
    sorted.forEach(([uid, xp], i) => { text += (b[i] || (i + 1) + '.') + ' ' + d.users[uid].role + ' *' + d.users[uid].name + '*\n   ⭐ ' + xp + ' XP\n\n'; });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ================================
// /weeklyranking
// ================================
bot.command('weeklyranking', async (ctx) => {
    const sorted = Object.entries(d.weeklyXP).filter(([uid]) => d.users[uid] && !istAdminId(uid)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return ctx.reply('Diese Woche noch keine XP.');
    const b = ['🥇', '🥈', '🥉'];
    let text = '📆 *WOCHEN RANKING*\n\n';
    sorted.forEach(([uid, xp], i) => { text += (b[i] || (i + 1) + '.') + ' ' + d.users[uid].role + ' *' + d.users[uid].name + '*\n   ⭐ ' + xp + ' XP\n\n'; });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ================================
// /daily
// ================================
bot.command('daily', async (ctx) => {
    const uid = ctx.from.id;
    if (istAdminId(uid)) return ctx.reply('⚙️ Admins nehmen nicht am Daily teil.');
    const u = user(uid, ctx.from.first_name);
    const jetzt = Date.now();
    const h24 = 86400000;
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

// ================================
// /stats
// ================================
bot.command('stats', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const alleChats = Object.values(d.chats);
    await ctx.reply('📊 *Stats*\n\n👥 User: ' + Object.keys(d.users).length + '\n💬 Chats: ' + alleChats.length + '\n🔗 Links: ' + Object.keys(d.links).length, { parse_mode: 'Markdown' });
});

// ================================
// /dashboard  ← ORIGINAL UNVERÄNDERT
// ================================
bot.command('dashboard', async (ctx) => {
    const uid = ctx.from.id;
    if (!await istAdmin(ctx, uid)) return ctx.reply('❌ Kein Zugriff');
    await ctx.reply('📊 Admin Dashboard:', {
        reply_markup: {
            inline_keyboard: [[{ text: '🚀 Dashboard öffnen', url: DASHBOARD_URL }]]
        }
    });

    const heute = new Date().toDateString();
    const hLinks = Object.values(d.links).filter(l => new Date(l.timestamp).toDateString() === heute);
    const alleUser = Object.entries(d.users);
    const gestartet = alleUser.filter(([, u]) => u.started);
    const aktiv = alleUser.filter(([uid]) => d.dailyXP[uid] && d.dailyXP[uid] > 0);
    const gelikedSet = new Set();
    hLinks.forEach(l => l.likes.forEach(uid => gelikedSet.add(uid)));
    const nichtGeliked = gestartet.filter(([uid]) => !gelikedSet.has(Number(uid)));
    const mitWarns = alleUser.filter(([, u]) => u.warnings > 0);
    const gesamtLikes = hLinks.reduce((s, l) => s + l.likes.size, 0);
    const likeRate = hLinks.length && gestartet.length ? Math.round(gesamtLikes / (hLinks.length * gestartet.length) * 100) : 0;
    let m1 = 0, m2 = 0, m3 = 0;
    alleUser.forEach(([uid]) => { if (d.missionen[uid] && d.missionen[uid].date === heute) { if (d.missionen[uid].m1) m1++; if (d.missionen[uid].m2) m2++; if (d.missionen[uid].m3) m3++; } });
    const top3 = Object.entries(d.dailyXP).filter(([uid]) => d.users[uid] && !istAdminId(uid)).sort((a, b) => b[1] - a[1]).slice(0, 3);

    let t1 = 'ADMIN DASHBOARD - ' + new Date().toLocaleString('de-DE') + '\n\n';
    t1 += 'USER: ' + alleUser.length + ' | Gestartet: ' + gestartet.length + ' | Aktiv: ' + aktiv.length + '\n';
    t1 += 'Nicht geliked: ' + nichtGeliked.length + ' | Warns: ' + mitWarns.length + '\n\n';
    t1 += 'LINKS: ' + hLinks.length + ' | Likes: ' + gesamtLikes + ' | Rate: ' + likeRate + '%\n';
    t1 += 'M1: ' + m1 + ' M2: ' + m2 + ' M3: ' + m3 + '\n\n';
    t1 += 'TOP 3: ';
    top3.forEach(([uid, xp], i) => { t1 += (i + 1) + '. ' + d.users[uid].name + '(' + xp + ') '; });
    await ctx.telegram.sendMessage(ctx.from.id, t1, {
        reply_markup: {
            inline_keyboard: [[{ text: '📸 Alle ohne Insta erinnern', callback_data: 'remind_insta' }]]
        }
    });

    let tLinks = '🔗 HEUTIGE LINKS + LIKES\n\n';
    for (const l of hLinks) {
        const likerListe = Object.values(l.likerNames || {});
        tLinks += '👤 ' + l.user_name + '\n🔗 ' + l.text + '\n👍 ' + likerListe.length + ' Likes\n';
        if (likerListe.length > 0) {
            tLinks += '❤️ Geliked von:\n';
            tLinks += likerListe.map(liker => {
                if (typeof liker === 'string') return ' - ' + liker;
                return ' - ' + liker.name + (liker.insta ? ' (@' + liker.insta + ')' : '');
            }).join('\n') + '\n';
        } else {
            tLinks += '❌ Noch keine Likes\n';
        }
        tLinks += '\n----------------\n\n';
        if (tLinks.length > 3500) { await ctx.telegram.sendMessage(ctx.from.id, tLinks); tLinks = ''; }
    }
    if (tLinks.length > 0) await ctx.telegram.sendMessage(ctx.from.id, tLinks);

    let t2 = 'ALLE USER\n\n';
    for (const [uid, u] of alleUser.sort((a, b) => b[1].xp - a[1].xp)) {
        const m = d.missionen[uid] && d.missionen[uid].date === heute ? d.missionen[uid] : null;
        t2 += u.name + (u.username ? ' @' + u.username : '') + (u.instagram ? ' | 📸 @' + u.instagram : ' | ❌ kein Insta') + '\n';
        t2 += '  ' + u.role + ' XP:' + u.xp + ' Heute:' + (d.dailyXP[uid] || 0) + '\n';
        t2 += '  Geliked:' + (gelikedSet.has(Number(uid)) ? 'Ja' : 'Nein') + ' Link:' + (d.tracker[uid] === heute ? 'Ja' : 'Nein') + ' W:' + u.warnings + '/5\n';
        if (m) t2 += '  M1:' + (m.m1 ? 'OK' : 'X') + ' M2:' + (m.m2 ? 'OK' : 'X') + ' M3:' + (m.m3 ? 'OK' : 'X') + '\n';
        t2 += '\n';
        if (t2.length > 3500) { await ctx.telegram.sendMessage(ctx.from.id, t2); t2 = ''; }
    }
    if (t2.length > 0) await ctx.telegram.sendMessage(ctx.from.id, t2);
    if (!istPrivat(ctx.chat.type)) await ctx.reply('📊 Dashboard per DM!');
});

// ================================
// /chats
// ================================
bot.command('chats', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const alle = Object.values(d.chats);
    let text = '💬 *Chats*\n\nPrivat: ' + alle.filter(c => c.type === 'private').length + '\nGruppen: ' + alle.filter(c => istGruppe(c.type)).length + '\n\n';
    alle.filter(c => istGruppe(c.type)).forEach(g => { text += '• ' + g.title + ' (`' + g.id + '`)\n'; });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ================================
// /chatinfo
// ================================
bot.command('chatinfo', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    await ctx.reply('🆔 `' + ctx.chat.id + '`\n📝 ' + (ctx.chat.title || 'Privat') + '\n🔤 ' + ctx.chat.type, { parse_mode: 'Markdown' });
});

// ================================
// /dm
// ================================
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

// ================================
// /warn
// ================================
bot.command('warn', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    if (!ctx.message.reply_to_message) return ctx.reply('❌ Antworte auf eine Nachricht.');
    const userId = ctx.message.reply_to_message.from.id;
    const u = user(userId, ctx.message.reply_to_message.from.first_name);
    u.warnings = (u.warnings || 0) + 1;
    speichern();
    await ctx.reply('⚠️ Warn an *' + u.name + '*: ' + u.warnings + '/5', { parse_mode: 'Markdown' });
    try { await bot.telegram.sendMessage(userId, '⚠️ *Verwarnung!*\nWarn: ' + u.warnings + '/5', { parse_mode: 'Markdown' }); } catch (e) {}
});

// ================================
// /unban
// ================================
bot.command('unban', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    if (!ctx.message.reply_to_message) return ctx.reply('❌ Antworte auf eine Nachricht.');
    const userId = ctx.message.reply_to_message.from.id;
    try { await ctx.telegram.unbanChatMember(ctx.chat.id, userId); if (d.users[userId]) d.users[userId].warnings = 0; await ctx.reply('✅ Entbannt!'); }
    catch (e) { await ctx.reply('❌ Fehler.'); }
});

// ================================
// /extralink
// ================================
bot.command('extralink', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    if (!ctx.message.reply_to_message) return ctx.reply('❌ Antworte auf eine Nachricht vom User!');
    const uid = ctx.message.reply_to_message.from.id;
    const u = user(uid, ctx.message.reply_to_message.from.first_name);
    if (!d.bonusLinks[uid]) d.bonusLinks[uid] = 0;
    d.bonusLinks[uid] += 1;
    speichern();
    try { await bot.telegram.sendMessage(uid, '🎁 *Extra-Link erhalten!*\n\nDu hast einen Extra-Link vom Admin erhalten!', { parse_mode: 'Markdown' }); } catch (e) {}
    await ctx.reply('✅ Extra-Link vergeben an ' + u.name);
});

// ================================
// TEST COMMANDS
// ================================
bot.command('testxp', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; xpAddMitDaily(ctx.from.id, 50, ctx.from.first_name); speichern(); await ctx.reply('✅ +50 XP'); });
bot.command('testwarn', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; const u = user(ctx.from.id, ctx.from.first_name); u.warnings++; speichern(); await ctx.reply('✅ Warn: ' + u.warnings + '/5'); });
bot.command('testdaily', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; user(ctx.from.id, ctx.from.first_name).lastDaily = null; speichern(); await ctx.reply('✅ Daily reset!'); });
bot.command('testranking', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; const s = Object.entries(d.users).filter(([uid]) => !istAdminId(uid)).sort((a, b) => b[1].xp - a[1].xp).slice(0, 3); await ctx.reply('Top 3:\n' + s.map((x, i) => (i+1) + '. ' + x[1].name + ': ' + x[1].xp).join('\n')); });
bot.command('testreset', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; d.dailyXP = {}; d.weeklyXP = {}; d.missionen = {}; d.wochenMissionen = {}; d.missionQueue = {}; d.tracker = {}; d.counter = {}; d.badgeTracker = {}; speichern(); await ctx.reply('✅ Reset!'); });
bot.command('testdailyranking', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; await dailyRankingAbschluss(); await ctx.reply('✅ Daily Ranking!'); });
bot.command('testgewinnspiel', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; await wochenGewinnspiel(); await ctx.reply('✅ Gewinnspiel!'); });
bot.command('testliked', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; await likeErinnerung(); await ctx.reply('✅ Erinnerung!'); });
bot.command('testmission', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; await checkMissionen(ctx.from.id, ctx.from.first_name); await ctx.reply('✅ Mission!'); });
bot.command('testmissionauswertung', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    const gestern = new Date(Date.now() - 86400000).toDateString();
    for (const uid of Object.keys(d.missionQueue)) d.missionQueue[uid].date = gestern;
    d.missionQueueVerarbeitet = null;
    if (d.missionAuswertungErledigt) d.missionAuswertungErledigt = {};
    await missionenAuswerten();
    await ctx.reply('✅ Auswertung!');
});
bot.command('testweeklyranking', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; await weeklyRankingDM(); await ctx.reply('✅ Weekly!'); });
bot.command('testregeln', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; await ctx.reply('📜 *Regeln*\n\n1️⃣ 1 Link/Tag\n2️⃣ Kein Duplikat\n3️⃣ Bot starten\n4️⃣ 5 Warns = Ban', { parse_mode: 'Markdown' }); });
bot.command('testcontent', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; await topLinks(ctx.chat.id); });
bot.command('ankuendigung', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    await ctx.reply('📢 *Updates!*\n\n✅ XP permanent\n✅ Missionen\n✅ Badges\n✅ Gewinnspiel\n✅ Ranking System\n\nViel Spaß! 🎉', { parse_mode: 'Markdown' });
});
bot.command('time', (ctx) => { ctx.reply('🕒 ' + new Date().toString()); });

// ================================
// NEUE MITGLIEDER
// ================================
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
    }
});

// ================================
// NACHRICHTEN HANDLER
// ================================
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
                        const hinweis = await ctx.reply('📨 *' + ctx.from.first_name + '*, deine Nachricht wurde weitergeleitet!\n\n👉 [Hier klicken](https://t.me/c/3906557227/1)', { parse_mode: 'Markdown' });
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
            speichern();
            return;
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
                speichern();
                return;
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
            } catch (e) {
                console.log('Fehler beim Posten:', e.message);
                speichern();
                return;
            }

            d.links[msgId] = {
                chat_id: ctx.chat.id, user_id: uid, user_name: ctx.from.first_name,
                text: text, likes: new Set(), likerNames: {}, counter_msg_id: botMsg.message_id, timestamp: Date.now()
            };

            if (!istAdminId(uid)) {
                try {
                    const erin = await bot.telegram.sendMessage(ctx.chat.id,
                        '⚠️ Mindestens 5 Links liken (M1) — sonst Verwarnung!',
                        { reply_to_message_id: botMsg.message_id }
                    );
                    setTimeout(async () => { try { await bot.telegram.deleteMessage(ctx.chat.id, erin.message_id); } catch (e) {} }, 10000);
                } catch (e) {}
            }

            const linkKeys = Object.keys(d.links);
            if (linkKeys.length > 500) {
                const oldest = linkKeys.sort((a, b) => d.links[a].timestamp - d.links[b].timestamp)[0];
                delete d.links[oldest];
            }
            await sendeLinkAnAlle(d.links[msgId]);
        } else {
            d.links[msgId] = {
                chat_id: ctx.chat.id, user_id: uid, user_name: ctx.from.first_name,
                text: text, likes: new Set(), counter_msg_id: msgId, timestamp: Date.now()
            };
        }
        speichern();
    } catch (e) { console.log('Message Handler Fehler:', e.message); }
});

// ================================
// LIKE SYSTEM
// ================================
const likeInProgress = new Set();

bot.action(/^like_(\d+)$/, async (ctx) => {
    const msgId = parseInt(ctx.match[1]);
    const uid = ctx.from.id;
    const likeKey = msgId + '_' + uid;

    if (likeInProgress.has(likeKey)) {
        try { await ctx.answerCbQuery(); } catch (e) {}
        return;
    }
    likeInProgress.add(likeKey);
    setTimeout(() => likeInProgress.delete(likeKey), 5000);

    try {
        if (!d.links[msgId]) {
            try { await ctx.answerCbQuery('❌ Link nicht mehr vorhanden.'); } catch (e) {}
            return;
        }
        const lnk = d.links[msgId];
        if (uid === lnk.user_id) {
            try { await ctx.answerCbQuery('❌ Kein Self-Like!'); } catch (e) {}
            return;
        }
        if (lnk.likes.has(uid)) {
            try { await ctx.answerCbQuery('❌ Bereits geliked!'); } catch (e) {}
            return;
        }

        lnk.likes.add(uid);
        lnk.likerNames[uid] = { name: ctx.from.first_name, insta: d.users[uid]?.instagram || null };
        const anz = lnk.likes.size;
        const poster = user(lnk.user_id, lnk.user_name);
        poster.totalLikes++;

        const istHeutigerLink = new Date(lnk.timestamp).toDateString() === new Date().toDateString();

        let vergebenXP = 0;
        if (!istAdminId(uid)) {
            if (istHeutigerLink) { vergebenXP = xpAddMitDaily(uid, 5, ctx.from.first_name); }
            else { vergebenXP = xpAdd(uid, 5, ctx.from.first_name); }
        }

        const msgKey = String(lnk.counter_msg_id);
        if (d.dmNachrichten && d.dmNachrichten[msgKey] && d.dmNachrichten[msgKey][uid]) {
            try { await bot.telegram.deleteMessage(uid, d.dmNachrichten[msgKey][uid]); delete d.dmNachrichten[msgKey][uid]; } catch (e) {}
        }

        if (!istAdminId(uid)) {
            const mission = getMission(uid);
            if (istHeutigerLink && istInstagramLink(lnk.text)) { mission.likesGegeben++; }
            await checkMissionen(uid, ctx.from.first_name);
        }

        const liker = user(uid, ctx.from.first_name);
        const nb = xpBisNaechstesBadge(liker.xp);
        const eventBonus = d.xpEvent && d.xpEvent.aktiv && d.xpEvent.multiplier > 1
            ? ` (+${Math.round((d.xpEvent.multiplier - 1) * 100)}% Event)`
            : '';
        const feedbackText = istAdminId(uid)
            ? '✅ Like registriert! (Admin)'
            : `🎉 +${vergebenXP} XP${eventBonus}\n` + liker.role + ' | ⭐ ' + liker.xp + (nb ? '\n⬆️ Noch ' + nb.fehlend + ' bis ' + nb.ziel : '');

        const feedbackMsg = await ctx.reply(feedbackText);
        setTimeout(async () => { try { await ctx.telegram.deleteMessage(ctx.chat.id, feedbackMsg.message_id); } catch (e) {} }, 8000);

        try { await ctx.answerCbQuery('👍 ' + anz + '!'); } catch (e) {}

        try {
            const posterLabel = istAdminId(lnk.user_id) ? '⚙️ Admin ' + lnk.user_name : poster.role + ' ' + lnk.user_name;
            const posterStats = istAdminId(lnk.user_id) ? '' : '  |  ⭐ ' + poster.xp + ' XP';
            await ctx.telegram.editMessageText(
                lnk.chat_id, lnk.counter_msg_id, null,
                posterLabel + '\n🔗 ' + lnk.text + '\n\n👍 ' + anz + ' Likes' + posterStats,
                { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('👍 Like  |  ' + anz, 'like_' + msgId)]]).reply_markup }
            );
        } catch (e) { console.log('Edit Fehler:', e.message); }

        speichernDebounced();
    } catch (e) { console.log('Like Fehler:', e.message); }
    finally { likeInProgress.delete(likeKey); }
});

// ================================
// CALLBACK ACTIONS
// ================================
bot.action('remind_insta', async (ctx) => {
    let count = 0;
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started) continue;
        if (u.instagram && u.instagram.trim() !== '') continue;
        try {
            await bot.telegram.sendMessage(Number(uid), '📸 Bitte sende mir deinen Instagram Namen.\n\n(z.B. max123)', {
                reply_markup: { inline_keyboard: [[{ text: '📸 Instagram eingeben', callback_data: 'set_insta' }]] }
            });
            count++;
            await new Promise(r => setTimeout(r, 100));
        } catch (e) {}
    }
    await ctx.answerCbQuery(`✅ ${count} User erinnert`);
});

bot.action('set_insta', async (ctx) => {
    try {
        const uid = ctx.from.id;
        if (!d.instaWarte) d.instaWarte = {};
        d.instaWarte[uid] = true;
        speichern();
        await ctx.answerCbQuery('✅ Sende mir jetzt deinen Insta Namen');
        await ctx.reply('📸 Schick mir jetzt deinen Instagram Namen.\n\n(z.B. max123)');
    } catch (err) { console.log('FEHLER set_insta:', err); }
});

// ================================
// AUTO CONTENT
// ================================
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
            batch.map(([uid]) => sendeDM(uid,
                '📢 Neuer Booster-Link\n\n👤 ' + linkData.user_name + '\n\n🔗 ' + linkData.text + '\n\nBitte liken! 👍',
                { reply_markup: { inline_keyboard: [[{ text: '👉 Zum Beitrag', url: linkUrl2 }]] } }
            ))
        );
        results.forEach((result, idx) => {
            if (result.status === 'fulfilled' && result.value) {
                d.dmNachrichten[msgKey][batch[idx][0]] = result.value.message_id;
            }
        });
        if (i + 10 < empfaenger.length) await new Promise(r => setTimeout(r, 1000));
    }
    speichern();
}

// ================================
// DAILY RANKING ABSCHLUSS
// ================================
async function dailyRankingAbschluss() {
    const sorted = Object.entries(d.dailyXP)
        .filter(([uid]) => d.users[uid] && d.dailyXP[uid] > 0 && !istAdminId(uid))
        .sort((a, b) => b[1] - a[1]);

    if (!sorted.length) return;

    const bel = [
        { xp: 10, links: 1, text: '🥇' },
        { xp: 5,  links: 0, text: '🥈' },
        { xp: 2,  links: 0, text: '🥉' }
    ];

    // 🧠 Gewinner bekommen XP + Bonus
    for (let i = 0; i < Math.min(3, sorted.length); i++) {
        const [uid, xp] = sorted[i];
        const u = d.users[uid];
        const b = bel[i];

        xpAdd(uid, b.xp, u.name);

        if (b.links > 0) {
            if (!d.bonusLinks[uid]) d.bonusLinks[uid] = 0;
            d.bonusLinks[uid] += b.links;
        }

        // Optional: DM an Gewinner
        try {
            await bot.telegram.sendMessage(
                Number(uid),
                `🎉 *${b.text} im Tagesranking!*\n\n+${b.xp} XP` +
                (b.links > 0 ? `\n🔗 Extra Link für morgen!` : ''),
                { parse_mode: 'Markdown' }
            );
        } catch (e) {}
    }

    // 🔥 WICHTIG: Daten sichern für Announcer
    d.gesternDailyXP = Object.assign({}, d.dailyXP);

    // ❌ KEIN POST IN GRUPPEN MEHR

    // 🔄 Reset
    d.dailyXP = {};
    d.tracker = {};
    d.counter = {};
    d.badgeTracker = {};
    d.dailyReset = Date.now();

    speichern();
}

// ================================
// GEWINNSPIEL
// ================================
async function wochenGewinnspiel() {
    const gruppen = Object.values(d.chats).filter(c => istGruppe(c.type));
    const teilnehmer = Object.entries(d.weeklyXP).filter(([uid]) => d.users[uid] && d.weeklyXP[uid] > 0 && !istAdminId(uid)).map(([uid]) => uid);
    if (!teilnehmer.length) return;
    const gwUid = teilnehmer[Math.floor(Math.random() * teilnehmer.length)];
    const gw = d.users[gwUid];
    if (!d.bonusLinks[gwUid]) d.bonusLinks[gwUid] = 0;
    d.bonusLinks[gwUid] += 1;
    d.wochenGewinnspiel.gewinner.push({ name: gw.name, uid: gwUid, datum: new Date().toLocaleDateString() });
    d.wochenGewinnspiel.letzteAuslosung = Date.now();
    const text = '🎰 *GEWINNSPIEL*\n\n🎉 Gewinner: *' + gw.name + '*\n\n🎁 1 Extra Link nächste Woche!\n\n📆 Nächste Auslosung: Sonntag';
    gruppen.forEach(g => { bot.telegram.sendMessage(g.id, text, { parse_mode: 'Markdown' }).catch(() => {}); });
    try { await bot.telegram.sendMessage(Number(gwUid), '🎉 *Du hast gewonnen!*\n\n🎁 1 Extra Link!', { parse_mode: 'Markdown' }); } catch (e) {}
    d.weeklyXP = {};
    d.weeklyReset = Date.now();
    speichern();
    await weeklyRankingDM();
}

// ================================
// LIKE ERINNERUNG
// ================================
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
        for (const [msgId, l] of nichtGeliked) {
            text += '🔗 ' + l.user_name + '\n';
            buttons.push([Markup.button.url('👍 Liken', 'https://t.me/c/' + String(l.chat_id).replace('-100', '') + '/' + (l.counter_msg_id || msgId))]);
        }
        text += '\n⏳ Missionen schließen um 12:00 Uhr!';
        try { await bot.telegram.sendMessage(Number(uid), text, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard(buttons).reply_markup }); } catch (e) {}
    }
}

// ================================
// ABEND WARNUNG
// ================================
async function abendM1Warnung() {
    const heute = new Date().toDateString();
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started || istAdminId(uid)) continue;
        const hatLinkHeute = Object.values(d.links).some(l => l.user_id === Number(uid) && new Date(l.timestamp).toDateString() === heute);
        if (!hatLinkHeute) continue;
        const fremde = Object.values(d.links).filter(l => istInstagramLink(l.text) && l.user_id !== Number(uid) && new Date(l.timestamp).toDateString() === heute);
        if (fremde.length < 5) continue;
        const m = d.missionen[uid];
        if (m && m.date === heute && m.m1) continue;
        const likes = m ? m.likesGegeben : 0;
        try {
            await bot.telegram.sendMessage(Number(uid),
                '⚠️ *Erinnerung!*\nNur ' + likes + '/5 Likes vergeben.\nNoch ' + (5 - likes) + ' liken — sonst Verwarnung!',
                { parse_mode: 'Markdown' }
            );
        } catch (e) {}
    }
}

// ================================
// ZEITGESTEUERTE EVENTS
// ================================
async function zeitCheck() {
    try {
        const jetzt = new Date();
        const h = jetzt.getHours();
        const m = jetzt.getMinutes();
        const eventKey = h + ':' + m + ':' + jetzt.toDateString();

        if (!d._lastEvents) d._lastEvents = {};

        // ============================
        // BACKUP
        // ============================
        if (h === 3 && m === 0 && d._lastEvents['backup'] !== eventKey) {
            d._lastEvents['backup'] = eventKey;
            await backup();
        }

        // ============================
        // TOP LINKS
        // ============================
        if (h === 7 && m === 5 && d._lastEvents['toplinks'] !== eventKey) {
            d._lastEvents['toplinks'] = eventKey;
            const gruppen = Object.values(d.chats).filter(c => istGruppe(c.type));
            gruppen.forEach(g => topLinks(g.id));
        }

        // ============================
        // MISSIONEN AUSWERTUNG
        // ============================
        if (h === 12 && m === 0 && d._lastEvents['missionen'] !== eventKey) {
            d._lastEvents['missionen'] = eventKey;
            await missionenAuswerten();
        }

        // ============================
        // ABEND WARNUNG
        // ============================
        if (h === 22 && m === 0 && d._lastEvents['abendwarnung'] !== eventKey) {
            d._lastEvents['abendwarnung'] = eventKey;
            await abendM1Warnung();
        }

        // ============================
        // LIKE REMINDER
        // ============================
        if (h === 23 && m === 0 && d._lastEvents['reminder'] !== eventKey) {
            d._lastEvents['reminder'] = eventKey;
            await likeErinnerung();
        }

        // ============================
        // 🔥 DAILY RANKING + RESET (WICHTIG)
        // ============================
        if (h === 23 && m === 55 && d._lastEvents['dailyRanking'] !== eventKey) {
            d._lastEvents['dailyRanking'] = eventKey;
            await dailyRankingAbschluss();
        }

        // ============================
        // ALTE LINKS LÖSCHEN
        // ============================
        const zweiTage = 2 * 24 * 60 * 60 * 1000;
        for (const [k, l] of Object.entries(d.links)) {
            if (Date.now() - l.timestamp > zweiTage) {
                bot.telegram.deleteMessage(l.chat_id, l.counter_msg_id).catch(() => {});

                const mk = String(l.counter_msg_id);
                if (d.dmNachrichten && d.dmNachrichten[mk]) {
                    for (const [uid2, dmId] of Object.entries(d.dmNachrichten[mk])) {
                        bot.telegram.deleteMessage(Number(uid2), dmId).catch(() => {});
                    }
                    delete d.dmNachrichten[mk];
                }

                const lu = linkUrl(l.text);
                if (lu) {
                    const idx = d.gepostet.indexOf(lu);
                    if (idx !== -1) d.gepostet.splice(idx, 1);
                }

                delete d.links[k];
            }
        }

        // ============================
        // EVENT CACHE CLEANUP
        // ============================
        const heuteStr = jetzt.toDateString();
        for (const key of Object.keys(d._lastEvents)) {
            if (!key.endsWith(heuteStr)) delete d._lastEvents[key];
        }

    } catch (e) {
        console.log('ZeitCheck Fehler:', e.message);
    }
}
// ================================
// GLOBALER ERROR HANDLER
// ================================
process.on('unhandledRejection', (reason) => { console.log('Unhandled:', reason); });
process.on('uncaughtException', (error) => { console.log('Uncaught:', error.message); });

// ================================
// EXPRESS SERVER & DASHBOARD
// ================================
app.get('/data', (req, res) => { res.json(d); });

// ================================
// WEB DASHBOARD — NEU GESTALTET
// ================================
app.get('/dashboard', (req, res) => {
    const today = new Date().toDateString();
    const now   = new Date();

    const allUsers    = Object.entries(d.users);
    const totalUsers  = allUsers.length;
    const totalLinks  = Object.keys(d.links).length;
    const totalLikes  = Object.values(d.links).reduce((s, l) => s + (l.likes?.size || 0), 0);
    let   todayLinks  = 0;
    for (const l of Object.values(d.links))
        if (l.timestamp && new Date(l.timestamp).toDateString() === today) todayLinks++;

    const gelikedSet  = new Set();
    Object.values(d.links)
        .filter(l => new Date(l.timestamp).toDateString() === today)
        .forEach(l => l.likes.forEach(uid => gelikedSet.add(uid)));

    const started     = allUsers.filter(([, u]) => u.started).length;
    const activeToday = allUsers.filter(([uid]) => d.dailyXP[uid] > 0).length;
    const withWarns   = allUsers.filter(([, u]) => (u.warnings || 0) > 0).length;
    const noInsta     = allUsers.filter(([, u]) => !u.instagram);

    let m1c = 0, m2c = 0, m3c = 0;
    for (const [uid, m] of Object.entries(d.missionen)) {
        if (istAdminId(uid) || m.date !== today) continue;
        if (m.m1) m1c++;
        if (m.m2) m2c++;
        if (m.m3) m3c++;
    }

    const medals        = ['🥇', '🥈', '🥉'];
    const gesamtRanking = Object.entries(d.users).filter(([uid]) => !istAdminId(uid)).sort((a, b) => (b[1].xp || 0) - (a[1].xp || 0)).slice(0, 10);
    const dailyRanking  = Object.entries(d.dailyXP).filter(([uid]) => d.users[uid] && !istAdminId(uid)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const weeklyRanking = Object.entries(d.weeklyXP).filter(([uid]) => d.users[uid] && !istAdminId(uid)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const topLinksList  = Object.values(d.links).sort((a, b) => (b.likes?.size || 0) - (a.likes?.size || 0)).slice(0, 5);

    const rankRow = (i, name, xp) => `
      <div class="rank-row">
        <span class="rank-pos">${medals[i] || `<span class="rank-num">#${i + 1}</span>`}</span>
        <span class="rank-name">${name}</span>
        <span class="rank-xp">${xp} XP</span>
      </div>`;

    const evtAktiv    = d.xpEvent?.aktiv || false;
    const evtPct      = d.xpEvent?.multiplier ? Math.round((d.xpEvent.multiplier - 1) * 100) : 0;
    const evtEndStr   = d.xpEvent?.end   ? new Date(d.xpEvent.end).toLocaleTimeString('de-DE',   { hour: '2-digit', minute: '2-digit' }) : '—';
    const evtStartStr = d.xpEvent?.start ? new Date(d.xpEvent.start).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '—';

    res.send(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Dashboard</title>
<meta http-equiv="refresh" content="15">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:#0a0f1a; --surface:#111827; --surface2:#1a2235; --surface3:#212d42;
    --border:#1e2d45; --border2:#2a3a55; --text:#e2e8f0; --muted:#64748b; --muted2:#94a3b8;
    --green:#10b981; --green-bg:rgba(16,185,129,.1);
    --blue:#3b82f6; --blue-bg:rgba(59,130,246,.1);
    --amber:#f59e0b; --amber-bg:rgba(245,158,11,.1);
    --red:#ef4444; --red-bg:rgba(239,68,68,.1);
    --purple:#8b5cf6; --purple-bg:rgba(139,92,246,.1);
    --radius:14px; --radius-sm:8px;
  }
  html { scroll-behavior:smooth; }
  body { font-family:-apple-system,'Segoe UI',sans-serif; background:var(--bg); color:var(--text); font-size:14px; line-height:1.6; }
  .page { max-width:1400px; margin:0 auto; padding:24px 20px 60px; }

  .header { display:flex; align-items:center; justify-content:space-between; margin-bottom:32px; flex-wrap:wrap; gap:12px; }
  .header-left { display:flex; align-items:center; gap:14px; }
  .header-logo { width:40px; height:40px; border-radius:10px; background:linear-gradient(135deg,var(--blue),var(--purple)); display:flex; align-items:center; justify-content:center; font-size:20px; }
  .header-title { font-size:20px; font-weight:700; }
  .header-sub { font-size:12px; color:var(--muted); }
  .header-time { font-size:12px; color:var(--muted); background:var(--surface2); border:1px solid var(--border); padding:6px 14px; border-radius:20px; }
  .live-dot { display:inline-block; width:7px; height:7px; background:var(--green); border-radius:50%; margin-right:6px; animation:blink 2s infinite; }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }

  .section-title { font-size:11px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; color:var(--muted); margin-bottom:12px; display:flex; align-items:center; gap:8px; }
  .section-title::after { content:''; flex:1; height:1px; background:var(--border); }

  .stats-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:14px; margin-bottom:28px; }
  .stat-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:20px 22px; transition:transform .2s; position:relative; overflow:hidden; }
  .stat-card::before { content:''; position:absolute; top:0; left:0; right:0; height:2px; }
  .stat-card.c-green::before { background:var(--green); }
  .stat-card.c-blue::before  { background:var(--blue); }
  .stat-card.c-amber::before { background:var(--amber); }
  .stat-card.c-red::before   { background:var(--red); }
  .stat-card.c-purple::before{ background:var(--purple); }
  .stat-card:hover { transform:translateY(-2px); }
  .stat-icon { width:36px; height:36px; border-radius:9px; display:flex; align-items:center; justify-content:center; font-size:18px; margin-bottom:14px; }
  .stat-icon.c-green { background:var(--green-bg); } .stat-icon.c-blue { background:var(--blue-bg); }
  .stat-icon.c-amber { background:var(--amber-bg); } .stat-icon.c-red  { background:var(--red-bg); }
  .stat-icon.c-purple{ background:var(--purple-bg); }
  .stat-value { font-size:28px; font-weight:800; line-height:1; }
  .stat-label { font-size:12px; color:var(--muted); margin-top:5px; }
  .stat-sub   { font-size:11px; color:var(--muted); margin-top:3px; }

  .card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; }
  .card-header { display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid var(--border); }
  .card-title { font-size:14px; font-weight:600; }
  .card-body { padding:20px; }

  .event-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); margin-bottom:28px; overflow:hidden; }
  .event-card.active { border-color:rgba(16,185,129,.4); box-shadow:0 0 0 1px rgba(16,185,129,.15); }
  .event-header { display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:1px solid var(--border); flex-wrap:wrap; gap:10px; }
  .event-title { font-size:14px; font-weight:600; }
  .badge-pill { font-size:11px; font-weight:700; padding:3px 10px; border-radius:20px; }
  .badge-pill.active   { background:var(--green-bg); color:var(--green); border:1px solid rgba(16,185,129,.3); }
  .badge-pill.inactive { background:var(--surface3); color:var(--muted); border:1px solid var(--border); }
  .event-body { padding:20px; }
  .event-form-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  @media(max-width:600px){ .event-form-grid { grid-template-columns:1fr; } }
  .form-group { display:flex; flex-direction:column; gap:6px; }
  .form-group.full { grid-column:1 / -1; }
  label { font-size:11px; font-weight:600; color:var(--muted); letter-spacing:.5px; text-transform:uppercase; }
  input[type=number], input[type=datetime-local], select {
    background:var(--surface2); border:1px solid var(--border2); color:var(--text);
    border-radius:var(--radius-sm); padding:10px 14px; font-size:14px; width:100%;
    outline:none; transition:border-color .2s; -webkit-appearance:none;
  }
  input:focus, select:focus { border-color:var(--blue); }
  .btn { display:inline-flex; align-items:center; gap:7px; padding:10px 18px; border-radius:var(--radius-sm); font-size:13px; font-weight:600; cursor:pointer; border:none; transition:all .2s; text-decoration:none; }
  .btn-primary { background:var(--blue); color:#fff; }
  .btn-primary:hover { background:#2563eb; }
  .btn-danger { background:var(--red-bg); color:var(--red); border:1px solid rgba(239,68,68,.3); }
  .btn-danger:hover { background:var(--red); color:#fff; }
  .event-status-row { display:flex; gap:20px; padding:14px 20px; background:var(--surface2); border-top:1px solid var(--border); flex-wrap:wrap; }
  .event-stat-label { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:.5px; }
  .event-stat-value { font-size:16px; font-weight:700; margin-top:2px; }

  .mission-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
  @media(max-width:500px){ .mission-grid { grid-template-columns:1fr; } }
  .mission-item { background:var(--surface2); border:1px solid var(--border); border-radius:var(--radius-sm); padding:16px; text-align:center; }
  .mission-id { font-size:11px; font-weight:700; color:var(--muted); letter-spacing:1px; margin-bottom:8px; }
  .mission-count { font-size:36px; font-weight:800; line-height:1; }
  .m1{color:var(--green);} .m2{color:var(--blue);} .m3{color:var(--amber);}
  .mission-sub { font-size:11px; color:var(--muted); margin-top:4px; }

  .rankings-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin-bottom:28px; }
  @media(max-width:900px){ .rankings-grid { grid-template-columns:1fr; } }
  .rank-row { display:flex; align-items:center; gap:10px; padding:9px 0; border-bottom:1px solid var(--border); }
  .rank-row:last-child { border-bottom:none; }
  .rank-pos { width:26px; text-align:center; font-size:16px; flex-shrink:0; }
  .rank-num { font-size:11px; color:var(--muted); font-weight:700; }
  .rank-name { flex:1; font-weight:500; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .rank-xp { font-size:12px; font-weight:700; color:var(--amber); white-space:nowrap; }

  .link-item { display:flex; align-items:center; gap:12px; padding:12px 0; border-bottom:1px solid var(--border); }
  .link-item:last-child { border-bottom:none; }
  .link-rank { width:22px; font-size:16px; text-align:center; }
  .link-info { flex:1; min-width:0; }
  .link-url { color:var(--blue); font-size:12px; font-weight:500; text-decoration:none; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .link-url:hover { text-decoration:underline; }
  .link-meta { font-size:11px; color:var(--muted); margin-top:2px; }
  .like-badge { font-size:12px; font-weight:700; background:var(--red-bg); color:var(--red); padding:3px 10px; border-radius:20px; white-space:nowrap; }

  .user-table-wrap { max-height:520px; overflow-y:auto; scrollbar-width:thin; scrollbar-color:var(--border2) transparent; }
  .user-table-wrap::-webkit-scrollbar { width:5px; }
  .user-table-wrap::-webkit-scrollbar-thumb { background:var(--border2); border-radius:3px; }
  .search-row { padding:14px 20px; border-bottom:1px solid var(--border); }
  .search-input { width:100%; background:var(--surface2); border:1px solid var(--border2); color:var(--text); border-radius:var(--radius-sm); padding:10px 14px; font-size:13px; outline:none; }
  .search-input:focus { border-color:var(--blue); }
  .user-row { display:flex; align-items:center; gap:12px; padding:11px 20px; border-bottom:1px solid var(--border); transition:background .15s; flex-wrap:wrap; }
  .user-row:hover { background:var(--surface2); }
  .user-row:last-child { border-bottom:none; }
  .user-avatar { width:34px; height:34px; border-radius:50%; background:linear-gradient(135deg,var(--blue),var(--purple)); display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:700; flex-shrink:0; color:#fff; }
  .user-info { flex:1; min-width:0; }
  .user-name { font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .user-meta { font-size:11px; color:var(--muted); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .user-xp { font-size:13px; font-weight:700; color:var(--amber); white-space:nowrap; text-align:right; min-width:60px; }
  .user-xp-sub { font-size:10px; color:var(--muted); text-align:right; }
  .warn-badge { font-size:11px; font-weight:700; padding:2px 8px; border-radius:20px; background:var(--red-bg); color:var(--red); border:1px solid rgba(239,68,68,.25); }
  .user-actions { display:flex; gap:5px; flex-wrap:wrap; }
  .action-link { font-size:11px; font-weight:600; padding:4px 9px; border-radius:6px; text-decoration:none; transition:all .15s; white-space:nowrap; }
  .action-link.c-red   { color:var(--red);    background:var(--red-bg); }
  .action-link.c-amber { color:var(--amber);  background:var(--amber-bg); }
  .action-link.c-muted { color:var(--muted2); background:var(--surface3); }
  .action-link:hover { filter:brightness(1.2); }

  .two-col { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin-bottom:28px; }
  @media(max-width:768px){ .two-col { grid-template-columns:1fr; } }
  .mb-28 { margin-bottom:28px; }
  .empty-state { text-align:center; padding:32px; color:var(--muted); font-size:13px; }
  .insta-warn { background:var(--amber-bg); border:1px solid rgba(245,158,11,.3); border-radius:var(--radius-sm); padding:12px 16px; font-size:13px; color:var(--amber); margin-bottom:14px; }
  .tag { display:inline-block; font-size:10px; font-weight:700; padding:2px 7px; border-radius:4px; }
  .tag.green { background:var(--green-bg); color:var(--green); }
  .tag.red   { background:var(--red-bg);   color:var(--red); }
  .tag.muted { background:var(--surface3); color:var(--muted2); }
</style>
<script>
  function filterUsers() {
    const q = document.getElementById('search').value.toLowerCase();
    document.querySelectorAll('.user-row').forEach(r => {
      r.style.display = r.innerText.toLowerCase().includes(q) ? '' : 'none';
    });
  }
</script>
</head>
<body>
<div class="page">

  <div class="header">
    <div class="header-left">
      <div class="header-logo">📊</div>
      <div>
        <div class="header-title">Admin Dashboard</div>
        <div class="header-sub">Telegram Bot Control Panel</div>
      </div>
    </div>
    <div class="header-time">
      <span class="live-dot"></span>
      ${now.toLocaleDateString('de-DE', { weekday:'short', day:'2-digit', month:'short' })}
      &nbsp;·&nbsp;
      ${now.toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' })}
    </div>
  </div>

  <div class="section-title">Übersicht</div>
  <div class="stats-grid mb-28">
    <div class="stat-card c-blue">
      <div class="stat-icon c-blue">👥</div>
      <div class="stat-value">${totalUsers}</div>
      <div class="stat-label">Gesamt User</div>
      <div class="stat-sub">${started} gestartet</div>
    </div>
    <div class="stat-card c-green">
      <div class="stat-icon c-green">⚡</div>
      <div class="stat-value">${activeToday}</div>
      <div class="stat-label">Aktiv heute</div>
      <div class="stat-sub">mit XP heute</div>
    </div>
    <div class="stat-card c-amber">
      <div class="stat-icon c-amber">🔗</div>
      <div class="stat-value">${todayLinks}</div>
      <div class="stat-label">Links heute</div>
      <div class="stat-sub">${totalLinks} gesamt</div>
    </div>
    <div class="stat-card c-red">
      <div class="stat-icon c-red">❤️</div>
      <div class="stat-value">${totalLikes}</div>
      <div class="stat-label">Likes gesamt</div>
    </div>
    <div class="stat-card c-purple">
      <div class="stat-icon c-purple">⚠️</div>
      <div class="stat-value">${withWarns}</div>
      <div class="stat-label">User mit Warns</div>
      <div class="stat-sub">${noInsta.length} ohne Instagram</div>
    </div>
  </div>

  <div class="section-title">XP Event</div>
  <div class="event-card ${evtAktiv ? 'active' : ''} mb-28">
    <div class="event-header">
      <div class="event-title">⚡ XP Event System</div>
      <span class="badge-pill ${evtAktiv ? 'active' : 'inactive'}">${evtAktiv ? '🟢 AKTIV' : '⭕ INAKTIV'}</span>
    </div>
    <div class="event-body">
      <form action="/create-xp-event" method="get">
        <div class="event-form-grid">
          <div class="form-group">
            <label>Bonus (%)</label>
            <input type="number" name="percent" placeholder="z.B. 50" min="1" max="500" required>
          </div>
          <div class="form-group">
            <label>Dauer (Minuten)</label>
            <input type="number" name="duration" placeholder="z.B. 120" min="1" required>
          </div>
          <div class="form-group">
            <label>Start</label>
            <select name="startType" onchange="document.getElementById('ct').style.display=this.value==='custom'?'block':'none'">
              <option value="now">Sofort starten</option>
              <option value="custom">Geplanter Start</option>
            </select>
          </div>
          <div class="form-group" id="ct" style="display:none">
            <label>Startzeit</label>
            <input type="datetime-local" name="startCustom">
          </div>
          <div class="form-group full" style="display:flex;gap:10px;flex-wrap:wrap">
            <button type="submit" class="btn btn-primary">🚀 Event starten</button>
            <a href="/stop-xp-event" class="btn btn-danger">🛑 Stoppen</a>
          </div>
        </div>
      </form>
    </div>
    <div class="event-status-row">
      <div><div class="event-stat-label">Status</div><div class="event-stat-value" style="color:${evtAktiv ? 'var(--green)' : 'var(--muted)'}">${evtAktiv ? 'Läuft' : 'Gestoppt'}</div></div>
      <div><div class="event-stat-label">Bonus</div><div class="event-stat-value" style="color:var(--amber)">${evtPct > 0 ? '+' + evtPct + '%' : '—'}</div></div>
      <div><div class="event-stat-label">Start</div><div class="event-stat-value">${evtStartStr}</div></div>
      <div><div class="event-stat-label">Ende</div><div class="event-stat-value">${evtEndStr}</div></div>
    </div>
  </div>

  <div class="section-title">Missionen heute</div>
  <div class="card mb-28">
    <div class="card-body">
      <div class="mission-grid">
        <div class="mission-item"><div class="mission-id">MISSION 1</div><div class="mission-count m1">${m1c}</div><div class="mission-sub">User erfüllt</div></div>
        <div class="mission-item"><div class="mission-id">MISSION 2</div><div class="mission-count m2">${m2c}</div><div class="mission-sub">User erfüllt</div></div>
        <div class="mission-item"><div class="mission-id">MISSION 3</div><div class="mission-count m3">${m3c}</div><div class="mission-sub">User erfüllt</div></div>
      </div>
    </div>
  </div>

  <div class="section-title">Rankings</div>
  <div class="rankings-grid">
    <div class="card">
      <div class="card-header"><div class="card-title">🏆 Gesamt</div></div>
      <div class="card-body">
        ${gesamtRanking.length ? gesamtRanking.map(([, u], i) => rankRow(i, u.name || 'User', u.xp || 0)).join('') : '<div class="empty-state">Keine Daten</div>'}
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">📅 Daily</div></div>
      <div class="card-body">
        ${dailyRanking.length ? dailyRanking.map(([uid, xp], i) => rankRow(i, d.users[uid]?.name || 'User', xp)).join('') : '<div class="empty-state">Heute noch keine XP</div>'}
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">📆 Weekly</div></div>
      <div class="card-body">
        ${weeklyRanking.length ? weeklyRanking.map(([uid, xp], i) => rankRow(i, d.users[uid]?.name || 'User', xp)).join('') : '<div class="empty-state">Diese Woche noch keine XP</div>'}
      </div>
    </div>
  </div>

  <div class="two-col">
    <div class="card">
      <div class="card-header">
        <div class="card-title">🔥 Top Links</div>
        <span class="tag muted">${topLinksList.length}</span>
      </div>
      <div class="card-body">
        ${topLinksList.length ? topLinksList.map((l, i) => `
          <div class="link-item">
            <div class="link-rank">${medals[i] || (i + 1) + '.'}</div>
            <div class="link-info">
              <a href="${l.text}" target="_blank" class="link-url">${l.text}</a>
              <div class="link-meta">👤 ${l.user_name}</div>
            </div>
            <div class="like-badge">❤️ ${l.likes?.size || 0}</div>
          </div>`).join('')
        : '<div class="empty-state">Keine Links</div>'}
      </div>
    </div>
    <div class="card">
      <div class="card-header">
        <div class="card-title">📸 Ohne Instagram</div>
        <span class="tag ${noInsta.length > 0 ? 'red' : 'green'}">${noInsta.length}</span>
      </div>
      <div class="card-body">
        ${noInsta.length > 0
          ? `<div class="insta-warn">⚠️ ${noInsta.length} User ohne Instagram</div>
             ${noInsta.map(u => `<div style="padding:7px 0;border-bottom:1px solid var(--border);font-size:13px">👤 ${u.name || '?'}</div>`).join('')}`
          : '<div class="empty-state">✅ Alle haben Instagram</div>'}
      </div>
    </div>
  </div>

  <div class="section-title">Alle User (${totalUsers})</div>
  <div class="card mb-28">
    <div class="search-row">
      <input type="text" id="search" class="search-input" placeholder="🔍  User suchen..." onkeyup="filterUsers()">
    </div>
    <div class="user-table-wrap">
      ${Object.entries(d.users).sort((a, b) => (b[1].xp || 0) - (a[1].xp || 0)).map(([id, u]) => {
        const initials = (u.name || '?').slice(0, 2).toUpperCase();
        const hasLiked = gelikedSet.has(Number(id));
        const hasLink  = d.tracker[id] === today;
        const mData    = d.missionen[id]?.date === today ? d.missionen[id] : null;
        return `
        <div class="user-row">
          <div class="user-avatar">${initials}</div>
          <div class="user-info">
            <div class="user-name">${u.name || 'Unbekannt'} ${u.username ? '<span style="color:var(--muted);font-weight:400">@' + u.username + '</span>' : ''}</div>
            <div class="user-meta">
              ${u.instagram ? '📸 @' + u.instagram : '<span style="color:var(--red)">❌ kein Insta</span>'}
              &nbsp;·&nbsp; ${u.role || '—'}
              &nbsp;·&nbsp; <span style="color:${hasLiked ? 'var(--green)' : 'var(--red)'}">Like:${hasLiked ? '✓' : '✗'}</span>
              &nbsp;·&nbsp; <span style="color:${hasLink ? 'var(--blue)' : 'var(--muted)'}">Link:${hasLink ? '✓' : '✗'}</span>
              ${mData ? `&nbsp;·&nbsp; M1:${mData.m1 ? '✓' : '✗'} M2:${mData.m2 ? '✓' : '✗'} M3:${mData.m3 ? '✓' : '✗'}` : ''}
            </div>
          </div>
          <div>
            <div class="user-xp">${u.xp || 0} XP</div>
            <div class="user-xp-sub">Heute: ${d.dailyXP[id] || 0}</div>
          </div>
          ${(u.warnings || 0) > 0 ? `<span class="warn-badge">⚠️ ${u.warnings}/5</span>` : ''}
          <div class="user-actions">
            <a href="/reset-user?id=${id}"          class="action-link c-red"   title="XP Reset">🔴 Reset</a>
            <a href="/remove-warn?id=${id}"         class="action-link c-amber" title="Warn Reset">⚠️ Warn</a>
            <a href="/remove-xp?id=${id}&amount=10" class="action-link c-muted" title="-10 XP">−10 XP</a>
            <a href="/remove-xp?id=${id}&amount=50" class="action-link c-muted" title="-50 XP">−50 XP</a>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>

  <div class="section-title">Links (${Object.keys(d.links).length})</div>
  <div class="card">
    <div class="card-body">
      ${Object.entries(d.links).length === 0
        ? '<div class="empty-state">Keine Links vorhanden</div>'
        : Object.entries(d.links).map(([msgId, link]) => `
          <div style="padding:14px 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap">
              <div style="flex:1;min-width:0">
                <a href="${link.text}" target="_blank" style="color:var(--blue);font-size:13px;font-weight:500;word-break:break-all;text-decoration:none">${link.text}</a>
                <div style="font-size:11px;color:var(--muted);margin-top:4px">
                  👤 ${link.user_name} &nbsp;·&nbsp; ❤️ ${link.likes?.size || 0} Likes
                  &nbsp;·&nbsp; ${new Date(link.timestamp).toLocaleTimeString('de-DE', { hour:'2-digit', minute:'2-digit' })} Uhr
                </div>
                ${link.likerNames && Object.values(link.likerNames).length > 0
                  ? `<div style="font-size:11px;color:var(--muted2);margin-top:6px;display:flex;flex-wrap:wrap;gap:5px">
                      ${Object.values(link.likerNames).map(liker =>
                        `<span style="background:var(--surface3);padding:2px 8px;border-radius:4px">${liker.name || 'User'}${liker.insta ? ' @' + liker.insta : ''}</span>`
                      ).join('')}
                    </div>`
                  : '<div style="font-size:11px;color:var(--muted);margin-top:4px">Noch keine Likes</div>'}
              </div>
              <a href="/delete-link?id=${msgId}" class="action-link c-red">🗑️ Löschen</a>
            </div>
          </div>`).join('')}
    </div>
  </div>

</div>
</body>
</html>`);
});

app.get('/reset-user', (req, res) => {
    const uid = req.query.id;
    if (d.users[uid]) { d.users[uid].xp = 0; d.users[uid].level = 1; speichern(); }
    res.redirect('/dashboard');
});

app.get('/remove-warn', (req, res) => {
    const uid = req.query.id;
    if (d.users[uid]) { d.users[uid].warnings = 0; speichern(); }
    res.redirect('/dashboard');
});

app.get('/delete-link', (req, res) => {
    const msgId = req.query.id;
    if (d.links[msgId]) { delete d.links[msgId]; speichern(); }
    res.redirect('/dashboard');
});

app.get('/create-xp-event', (req, res) => {
    const percent = parseInt(req.query.percent);
    const durationMin = parseInt(req.query.duration);
    const startType = req.query.startType;
    if (!percent || !durationMin) return res.send('❌ Ungültige Eingabe');
    let startTime = startType === 'custom' && req.query.startCustom
        ? new Date(req.query.startCustom).getTime()
        : Date.now();
    d.xpEvent = { aktiv: false, multiplier: 1 + (percent / 100), start: startTime, end: startTime + durationMin * 60000, announced: false };
    speichern();
    res.redirect('/dashboard');
});

app.get('/stop-xp-event', (req, res) => {
    d.xpEvent = { aktiv: false, multiplier: 1, start: null, end: null, announced: false };
    speichern();
    res.redirect('/dashboard');
});

app.get('/remove-xp', (req, res) => {
    const uid = req.query.id;
    const amount = parseInt(req.query.amount) || 0;
    if (d.users[uid] && amount > 0) {
        d.users[uid].xp = Math.max(0, (d.users[uid].xp || 0) - amount);
        d.users[uid].level = level(d.users[uid].xp);
        d.users[uid].role = badge(d.users[uid].xp);
        speichern();
    }
    res.redirect('/dashboard');
});
// ================================
// BRIDGE ENDPOINT
// ================================
app.use(express.json());

app.post('/bridge-event', async (req, res) => {
    const secret = req.headers['x-bridge-secret'];
    if (secret !== process.env.BRIDGE_SECRET)
        return res.status(403).json({ error: 'Forbidden' });

    const event = req.body;
    if (!event || !event.type || !event.userId)
        return res.status(400).json({ error: 'Ungültig' });

    const uid  = String(event.userId);
    const name = event.userName || 'Unbekannt';

    if (!d.users[uid]) user(uid, name);

    if (event.type === 'post_forwarded') {
        if (event.meta && event.meta.groupBMsgId && event.meta.groupBChatId) {
            const msgId = event.meta.groupBMsgId;
            const linkData = {
                chat_id:        event.meta.groupBChatId,
                user_id:        Number(event.userId),
                user_name:      event.userName,
                text:           event.meta.linkText || '',
                likes:          new Set(),
                likerNames:     {},
                counter_msg_id: msgId,
                timestamp:      Date.now()
            };

            // Link in d.links speichern
            d.links[msgId] = linkData;

            // Duplikat verhindern
            const url = event.meta.linkText || '';
            if (url && !d.gepostet.includes(url)) {
                d.gepostet.push(url);
                if (d.gepostet.length > 2000) d.gepostet.shift();
            }

            // Kein XP für Poster — aber Link-Counter erhöhen
            if (!istAdminId(Number(uid))) {
                d.users[uid].links = (d.users[uid].links || 0) + 1;
            }

            speichernDebounced();

            // DM an alle User senden
            await sendeLinkAnAlle(linkData);
        }
    }

    if (event.type === 'like_given') {
        xpAddMitDaily(uid, event.xp || 5, name);
    }

    if (event.type === 'like_received') {
        // Poster bekommt keine XP
    }

    speichernDebounced();
    console.log(`[BRIDGE] ${event.type} → User ${uid} +${event.xp} XP`);
    return res.status(200).json({ ok: true });
});

// XP Event Status Endpoint für Bridge Bot
app.get('/xp-event-status', (req, res) => {
    const secret = req.headers['x-bridge-secret'];
    if (secret !== process.env.BRIDGE_SECRET)
        return res.status(403).json({ error: 'Forbidden' });
    res.json({
        aktiv:      d.xpEvent ? d.xpEvent.aktiv : false,
        multiplier: d.xpEvent ? d.xpEvent.multiplier : 1,
    });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('🌐 Dashboard läuft auf Port ' + PORT); });

// ================================
// START
// ================================
bot.launch();
console.log('🤖 Bot läuft!');

(async () => { await checkInstagramForAllUsers(bot); })();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

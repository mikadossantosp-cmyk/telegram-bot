import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';

const BOT_TOKEN = process.env.BOT_TOKEN || "8406939789:AAHDq3RHOf-nAaUVCL4ZeMduB_KYiBD0i7M";
if (!BOT_TOKEN || BOT_TOKEN === "DEIN_BOT_TOKEN") {
    console.error("❌ BOT TOKEN FEHLT!");
    process.exit(1);
}
const DATA_FILE = '/data/daten.json';
process.env.TZ = 'Europe/Berlin';
const bot = new Telegraf(BOT_TOKEN);

const ADMIN_IDS = new Set([1094738615]);
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
    warteNachricht: {}, dmNachrichten: {},
    missionen: {}, wochenMissionen: {},
    missionQueue: {}, missionQueueVerarbeitet: null,
    missionAuswertungErledigt: {},
    gesternDailyXP: {},
    badgeTracker: {},
    m1Streak: {},
    backupDatum: null,
    _lastEvents: {},
};

function laden() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const geladen = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            d = Object.assign({}, d, geladen);
            for (const uid in d.users) {
                d.users[uid].started = true;
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
                if (!link.counter_msg_id || !link.chat_id) { delete d.links[k]; continue; }
            }
            if (!d.dailyXP) d.dailyXP = {};
            if (!d.weeklyXP) d.weeklyXP = {};
            if (!d.bonusLinks) d.bonusLinks = {};
            if (!d.missionen) d.missionen = {};
            if (!d.wochenMissionen) d.wochenMissionen = {};
            if (!d.warteNachricht) d.warteNachricht = {};
            if (!d.dmNachrichten) d.dmNachrichten = {};
            if (!d.wochenGewinnspiel) d.wochenGewinnspiel = { aktiv: true, gewinner: [], letzteAuslosung: null };
            if (!d.missionQueue) d.missionQueue = {};
            if (!d.gesternDailyXP) d.gesternDailyXP = {};
            if (!d.badgeTracker) d.badgeTracker = {};
            if (!d.m1Streak) d.m1Streak = {};
            if (!d.missionAuswertungErledigt) d.missionAuswertungErledigt = {};
            if (!d._lastEvents) d._lastEvents = {};
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
    if (istAdminId(uid)) return;
    const u = user(uid, name);
    u.xp += menge;
    u.level = level(u.xp);
    u.role = badge(u.xp);
    if (!d.weeklyXP[uid]) d.weeklyXP[uid] = 0;
    d.weeklyXP[uid] += menge;
}

function xpAddMitDaily(uid, menge, name) {
    if (istAdminId(uid)) return;
    const u = user(uid, name);
    u.xp += menge;
    u.level = level(u.xp);
    u.role = badge(u.xp);
    if (!d.dailyXP[uid]) d.dailyXP[uid] = 0;
    d.dailyXP[uid] += menge;
    if (!d.weeklyXP[uid]) d.weeklyXP[uid] = 0;
    d.weeklyXP[uid] += menge;
}

function user(uid, name) {
    if (!d.users[uid]) {
        d.users[uid] = {
            name: name || '', username: null, xp: 0, level: 1,
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
        try { const { chatId, msgId } = d.warteNachricht[uid]; await bot.telegram.deleteMessage(chatId, msgId); } catch (e) {}
        delete d.warteNachricht[uid];
    }
    if (d.warte[uid]) delete d.warte[uid];
    speichern();
    if (istPrivat(ctx.chat.type)) {
        return ctx.reply('👋 Hallo ' + ctx.from.first_name + '!\n\n✅ Bot gestartet!\n🎉 Du kannst jetzt Links posten!\n\n📋 /help für alle Befehle.');
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
    const sorted = Object.entries(d.users).filter(([id]) => !istAdminId(id)).sort((a, b) => b[1].xp - a[1].xp);
    const rank = sorted.findIndex(x => x[0] == uid) + 1;
    const bonusL = d.bonusLinks[uid] || 0;
    await ctx.reply(
        '👤 *' + u.name + (istAdminId(uid) ? ' ⚙️ Admin' : '') + '*\n' +
        (u.username ? '@' + u.username + '\n' : '') +
        '🏅 ' + u.role + '\n⭐ XP: ' + u.xp + '\n📅 Heute: ' + (d.dailyXP[uid] || 0) +
        '\n📆 Woche: ' + (d.weeklyXP[uid] || 0) + '\n🏆 Rang: #' + rank +
        '\n🔗 Links: ' + u.links + (bonusL > 0 ? '\n🎁 Bonus: ' + bonusL : '') +
        '\n👍 Likes: ' + u.totalLikes + '\n⚠️ Warns: ' + u.warnings + '/5',
        { parse_mode: 'Markdown' }
    );
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
    xpAddMitDaily(uid, bonus, ctx.from.first_name);
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
// /dashboard
// ================================
bot.command('dashboard', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
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
    await ctx.telegram.sendMessage(ctx.from.id, t1);

    let t2 = 'ALLE USER\n\n';
    for (const [uid, u] of alleUser.sort((a, b) => b[1].xp - a[1].xp)) {
        const m = d.missionen[uid] && d.missionen[uid].date === heute ? d.missionen[uid] : null;
        t2 += u.name + (u.username ? ' @' + u.username : '') + '\n';
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
    const c = d.chats[ctx.chat.id];
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
bot.command('extralink', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');

    if (!ctx.message.reply_to_message) {
        return ctx.reply('❌ Antworte auf eine Nachricht vom User!');
    }

    const uid = ctx.message.reply_to_message.from.id;
    const u = user(uid, ctx.message.reply_to_message.from.first_name);

    if (!d.bonusLinks[uid]) d.bonusLinks[uid] = 0;
    d.bonusLinks[uid] += 1;

    speichern();

    try {
        await bot.telegram.sendMessage(uid,
            '🎁 *Extra-Link erhalten!*\n\nDu hast einen Extra-Link vom Admin erhalten!',
            { parse_mode: 'Markdown' }
        );
    } catch (e) {}

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
        if (!ctx.message || !ctx.from) return;
        if (!istGruppe(ctx.chat.type)) return;

        const uid = ctx.from.id;
        const u = user(uid, ctx.from.first_name);
        const text = ctx.message.text || ctx.message.caption || '';

        // Textnachrichten weiterleiten
        if (!hatLink(text)) {
            if (ctx.chat.id === -1003800312818) {
                const istAdminMsg = await istAdmin(ctx, uid);
                if (!istAdminMsg) {
                    try {
                        await ctx.forwardMessage(-1003906557227);
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

        // Sperrzeit
        if (istSperrzeit() && !admin) {
            try { await ctx.deleteMessage(); } catch (e) {}
            const msg = await ctx.reply('🚫 Keine Links von Sonntag 20:00 bis Montag 06:00!');
            setTimeout(async () => { try { await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id); } catch (e) {} }, 15000);
            return;
        }

        // Duplikat Check
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

        // Tages-Limit
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

        // Admin Badge erzwingen
        if (istAdminId(uid)) { u.xp = 0; u.level = 1; u.role = '⚙️ Admin'; }

        if (!istAdminId(uid)) d.tracker[uid] = heute;
        d.counter[uid] = 0;
        if (!istAdminId(uid)) { u.links++; xpAddMitDaily(uid, 1, ctx.from.first_name); }

        const msgId = ctx.message.message_id;
        const istInsta = istInstagramLink(text);

        if (istInsta) {
            // Original Nachricht löschen
            try { await ctx.deleteMessage(); } catch (e) {}

            const posterName = istAdminId(uid) ? '⚙️ Admin ' + ctx.from.first_name : u.role + ' ' + ctx.from.first_name;
            const posterStats = istAdminId(uid) ? '' : '  |  ⭐ ' + u.xp + ' XP';

            // Bot Nachricht senden - OHNE Markdown wegen URLs
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
                text: text, likes: new Set(), counter_msg_id: botMsg.message_id, timestamp: Date.now()
            };

            // Erinnerung für normale User
            if (!istAdminId(uid)) {
                try {
                    const erin = await bot.telegram.sendMessage(ctx.chat.id,
                        '⚠️ Mindestens 5 Links liken (M1) — sonst Verwarnung!',
                        { reply_to_message_id: botMsg.message_id }
                    );
                    setTimeout(async () => { try { await bot.telegram.deleteMessage(ctx.chat.id, erin.message_id); } catch (e) {} }, 10000);
                } catch (e) {}
            }

            // Links Limit
            const linkKeys = Object.keys(d.links);
            if (linkKeys.length > 500) {
                const oldest = linkKeys.sort((a, b) => d.links[a].timestamp - d.links[b].timestamp)[0];
                delete d.links[oldest];
            }

            await sendeLinkAnAlle(d.links[msgId]);
        } else {
            // Nicht-Instagram Link: nur tracken
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

    // Doppelklick verhindern
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
        const anz = lnk.likes.size;
        const poster = user(lnk.user_id, lnk.user_name);
        poster.totalLikes++;

        const istHeutigerLink = new Date(lnk.timestamp).toDateString() === new Date().toDateString();

        // XP für Liker (nicht für Admin-Liker)
        if (!istAdminId(uid)) {
            if (istHeutigerLink) { xpAddMitDaily(uid, 5, ctx.from.first_name); }
            else { xpAdd(uid, 5, ctx.from.first_name); }
        }

        // DM löschen nach Like
        const msgKey = String(lnk.counter_msg_id);
        if (d.dmNachrichten && d.dmNachrichten[msgKey] && d.dmNachrichten[msgKey][uid]) {
            try { await bot.telegram.deleteMessage(uid, d.dmNachrichten[msgKey][uid]); delete d.dmNachrichten[msgKey][uid]; } catch (e) {}
        }

        // Mission tracken (für alle nicht-Admin Liker)
        if (!istAdminId(uid)) {
            const mission = getMission(uid);
            if (istHeutigerLink && istInstagramLink(lnk.text)) {
                mission.likesGegeben++;
            }
            await checkMissionen(uid, ctx.from.first_name);
        }

        // Feedback Nachricht
        const liker = user(uid, ctx.from.first_name);
        const nb = xpBisNaechstesBadge(liker.xp);
        const feedbackText = istAdminId(uid)
            ? '✅ Like registriert! (Admin)'
            : '🎉 +5 XP!\n' + liker.role + ' | ⭐ ' + liker.xp + (nb ? '\n⬆️ Noch ' + nb.fehlend + ' bis ' + nb.ziel : '');

        const feedbackMsg = await ctx.reply(feedbackText);
        setTimeout(async () => { try { await ctx.telegram.deleteMessage(ctx.chat.id, feedbackMsg.message_id); } catch (e) {} }, 8000);

        try { await ctx.answerCbQuery('👍 ' + anz + '!'); } catch (e) {}

        // Like Counter in Gruppe aktualisieren - OHNE Markdown
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
    const gruppen = Object.values(d.chats).filter(c => istGruppe(c.type));
    const sorted = Object.entries(d.dailyXP).filter(([uid]) => d.users[uid] && d.dailyXP[uid] > 0 && !istAdminId(uid)).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return;

    const bel = [{ xp: 10, links: 1, text: '🥇' }, { xp: 5, links: 0, text: '🥈' }, { xp: 2, links: 0, text: '🥉' }];
    let rankText = '🏆 *TAGES RANKING*\n\n';

    for (let i = 0; i < Math.min(3, sorted.length); i++) {
        const [uid, xp] = sorted[i];
        const u = d.users[uid];
        const b = bel[i];
        xpAdd(uid, b.xp, u.name);
        if (b.links > 0) { if (!d.bonusLinks[uid]) d.bonusLinks[uid] = 0; d.bonusLinks[uid] += b.links; }
        rankText += b.text + ' *' + u.name + '*\n   ⭐ ' + xp + ' XP | +' + b.xp + ' Bonus' + (b.links > 0 ? ' + Extra Link!' : '') + '\n\n';
        try { await bot.telegram.sendMessage(Number(uid), '🎉 *' + b.text + ' im Ranking!*\n+' + b.xp + ' XP' + (b.links > 0 ? '\n🔗 Extra Link morgen!' : ''), { parse_mode: 'Markdown' }); } catch (e) {}
    }

    d.gesternDailyXP = Object.assign({}, d.dailyXP);
    gruppen.forEach(g => { bot.telegram.sendMessage(g.id, rankText, { parse_mode: 'Markdown' }).catch(() => {}); });
    d.dailyXP = {};
    d.tracker = {};
    d.counter = {};
    d.badgeTracker = {};
    d.dailyReset = Date.now();
    speichern();
}

// ================================
// GESTERN RANKING
// ================================
async function gesternRankingPosten() {
    const gruppen = Object.values(d.chats).filter(c => istGruppe(c.type));
    const sorted = Object.entries(d.gesternDailyXP).filter(([uid]) => d.users[uid] && !istAdminId(uid)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return;
    const b = ['🥇', '🥈', '🥉'];
    let text = '🌅 *VORTAGS RANKING*\n\n';
    if (sorted[0]) text += '🎉 *' + d.users[sorted[0][0]].name + '* war gestern der Beste!\n\n';
    sorted.forEach(([uid, xp], i) => { text += (b[i] || (i+1) + '.') + ' *' + d.users[uid].name + '*\n   ⭐ ' + xp + ' XP\n\n'; });
    gruppen.forEach(g => { bot.telegram.sendMessage(g.id, text, { parse_mode: 'Markdown' }).catch(() => {}); });
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
        const hatLink = Object.values(d.links).some(l => l.user_id === Number(uid) && new Date(l.timestamp).toDateString() === heute);
        if (!hatLink) continue;
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
        const wochentag = jetzt.getDay();
        const eventKey = h + ':' + m + ':' + jetzt.toDateString();
        if (!d._lastEvents) d._lastEvents = {};

        const gruppen = Object.values(d.chats).filter(c => istGruppe(c.type));

        if (h === 3 && m === 0 && d._lastEvents['backup'] !== eventKey) { d._lastEvents['backup'] = eventKey; await backup(); }

        if (h === 6 && m === 0 && d._lastEvents['regeln'] !== eventKey) {
            d._lastEvents['regeln'] = eventKey;
            gruppen.forEach(g => {
                bot.telegram.sendMessage(g.id,
                    '📜 *Regeln*\n\n1️⃣ 1 Link pro Tag\n2️⃣ Keine Duplikate\n3️⃣ Bot starten\n4️⃣ 5 Warns = Ban\n5️⃣ Respekt\n\n👍 Jeden Link liken & kommentieren!\n🔍 Tägliche Kontrollen',
                    { parse_mode: 'Markdown' }
                ).catch(() => {});
            });
            await gesternRankingPosten();
        }

        if (h === 7 && m === 5 && d._lastEvents['toplinks'] !== eventKey) { d._lastEvents['toplinks'] = eventKey; gruppen.forEach(g => topLinks(g.id)); }

        if (h === 12 && m === 0 && d._lastEvents['missionen'] !== eventKey) { d._lastEvents['missionen'] = eventKey; await missionenAuswerten(); }

        if (h === 22 && m === 0 && d._lastEvents['abendwarnung'] !== eventKey) { d._lastEvents['abendwarnung'] = eventKey; await abendM1Warnung(); }

        if (h === 23 && m === 0 && d._lastEvents['reminder'] !== eventKey) { d._lastEvents['reminder'] = eventKey; await likeErinnerung(); }

        if (h === 23 && m === 55 && d._lastEvents['dailyRanking'] !== eventKey) { d._lastEvents['dailyRanking'] = eventKey; await dailyRankingAbschluss(); }

        if (wochentag === 0 && h === 20 && m === 0 && d._lastEvents['gewinnspiel'] !== eventKey) { d._lastEvents['gewinnspiel'] = eventKey; await wochenGewinnspiel(); }

        // Alte Links löschen
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
                if (lu) { const idx = d.gepostet.indexOf(lu); if (idx !== -1) d.gepostet.splice(idx, 1); }
                delete d.links[k];
            }
        }

        // _lastEvents bereinigen
        const heuteStr = jetzt.toDateString();
        for (const key of Object.keys(d._lastEvents)) { if (!key.endsWith(heuteStr)) delete d._lastEvents[key]; }

    } catch (e) { console.log('ZeitCheck Fehler:', e.message); }
}

setInterval(zeitCheck, 60000);

// ================================
// GLOBALER ERROR HANDLER
// ================================
process.on('unhandledRejection', (reason) => { console.log('Unhandled:', reason); });
process.on('uncaughtException', (error) => { console.log('Uncaught:', error.message); });

// ================================
// START
// ================================
bot.launch().then(() => console.log('🤖 Bot läuft!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

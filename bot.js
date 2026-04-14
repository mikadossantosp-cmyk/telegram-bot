import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';

const BOT_TOKEN = process.env.BOT_TOKEN || "7909817546:AAF5W5gY-sKl_SNA7Xu45QT54Pr5a5SASzs";
if (!BOT_TOKEN || BOT_TOKEN === "DEIN_BOT_TOKEN") {
    console.error("❌ BOT TOKEN FEHLT!");
    process.exit(1);
}
const DATA_FILE = '/workspace/data/daten.json';
process.env.TZ = 'Europe/Berlin';
const bot = new Telegraf(BOT_TOKEN);

// ================================
// DATEN
// ================================
let d = {
    users: {}, chats: {}, links: {},
    tracker: {}, counter: {}, warte: {},
    gepostet: [], seasonStart: Date.now(),
    seasonGewinner: [],
    dailyXP: {},
    weeklyXP: {},
    dailyReset: null,
    weeklyReset: null,
    bonusLinks: {},
    wochenGewinnspiel: { aktiv: true, gewinner: [], letzteAuslosung: null },
    warteNachricht: {},
    dmNachrichten: {},
    missionen: {},
    wochenMissionen: {},
    missionQueue: {},
    missionQueueVerarbeitet: null,
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
            console.log('Daten geladen');
        }
    } catch (e) { console.log('Ladefehler:', e.message); }
}

// Debounced Save - max 1x alle 2 Sekunden
let isSaving = false;
let savePending = false;
let saveTimer = null;

function speichernDebounced() {
    if (saveTimer) return; // Bereits geplant
    saveTimer = setTimeout(() => {
        saveTimer = null;
        speichern();
    }, 2000);
}

function speichern() {
    if (isSaving) {
        savePending = true;
        return;
    }
    isSaving = true;
    try {
        const s = Object.assign({}, d);
        s.links = {};
        for (const [k, v] of Object.entries(d.links)) {
            s.links[k] = Object.assign({}, v, { likes: Array.from(v.likes) });
        }
        s.users = Object.assign({}, d.users);
        for (const uid of Object.keys(s.users)) {
            if (istAdminId(Number(uid))) {
                s.users[uid] = Object.assign({}, s.users[uid], { xp: 0, level: 1, role: '⚙️ Admin' });
            }
        }
        // Atomic Write - verhindert korrupte JSON bei Crash
        const tmpFile = DATA_FILE + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(s, null, 2));
        fs.renameSync(tmpFile, DATA_FILE);
    } catch (e) { console.log('Speicherfehler:', e.message); }
    finally {
        isSaving = false;
        if (savePending) {
            savePending = false;
            setTimeout(speichern, 100);
        }
    }
}

setInterval(speichern, 30000);
laden();

// ================================
// TÄGLICHES BACKUP
// ================================
async function backup() {
    try {
        const heute = new Date().toDateString();
        if (d.backupDatum === heute) return;
        const backupFile = DATA_FILE.replace('.json', '_backup_' + new Date().toISOString().slice(0,10) + '.json');
        const s = Object.assign({}, d);
        s.links = {};
        for (const [k, v] of Object.entries(d.links)) {
            s.links[k] = Object.assign({}, v, { likes: Array.from(v.likes) });
        }
        fs.writeFileSync(backupFile, JSON.stringify(s, null, 2));
        d.backupDatum = heute;
        console.log('✅ Backup erstellt:', backupFile);
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

function badgeFuerAnzeige(uid) {
    if (istAdminId(uid)) return '⚙️ Admin';
    return d.users[uid] ? d.users[uid].role : '🆕 New';
}

function badgeBonusLinks(xp) {
    if (xp >= 1000) return 1;
    return 0;
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
            role: '🆕 New', lastDaily: null, totalLikes: 0, chats: [],
            isAdmin: false
        };
    }
    if (name) d.users[uid].name = name;
    if (istAdminId(uid)) {
        d.users[uid].isAdmin = true;
        d.users[uid].xp = 0;
        d.users[uid].level = 1;
        d.users[uid].role = '⚙️ Admin';
    }
    return d.users[uid];
}

function anzeigeName(uid) {
    const u = d.users[uid];
    if (!u) return 'Unbekannt';
    if (istAdminId(uid)) return u.role + ' ' + u.name + ' ⚙️ Admin';
    return u.role + ' ' + u.name;
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

function xpBisNaechstesBadge(xp) {
    if (xp < 50) return { ziel: '📘 Anfänger', fehlend: 50 - xp };
    if (xp < 500) return { ziel: '⬆️ Aufsteiger', fehlend: 500 - xp };
    if (xp < 1000) return { ziel: '🏅 Erfahrener', fehlend: 1000 - xp };
    return null;
}

const ADMIN_IDS = new Set([1094738615]);

function istAdminId(uid) {
    return ADMIN_IDS.has(Number(uid));
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

    if (!d.missionQueue[uid]) {
        d.missionQueue[uid] = { date: heute, m1Pending: false, m2Pending: false, m3Pending: false };
    }
    if (d.missionQueue[uid].date !== heute) {
        d.missionQueue[uid] = { date: heute, m1Pending: false, m2Pending: false, m3Pending: false };
    }

    if (!mission.m1 && mission.likesGegeben >= 5) {
        mission.m1 = true;
        d.missionQueue[uid].m1Pending = true;
        try {
            await bot.telegram.sendMessage(Number(uid),
                '🎯 *Mission 1 erreicht!*\n\n✅ Du hast heute 5 Instagram-Links geliked!\n\n⏳ XP werden um 12:00 Uhr vergeben.\n_Missionen schließen um 12:00 Uhr — weiter liken für M2 & M3!_',
                { parse_mode: 'Markdown' }
            );
        } catch (e) {}
    }

    speichern();
}

// ================================
// MISSIONS AUSWERTUNG UM 12:00
// ================================
async function missionenAuswerten() {
    const heute = new Date().toDateString();
    const jetzt12 = heute + '_12';
    if (d.missionAuswertungErledigt && d.missionAuswertungErledigt[jetzt12]) return;
    if (!d.missionAuswertungErledigt) d.missionAuswertungErledigt = {};
    d.missionAuswertungErledigt[jetzt12] = true;
    d.missionQueueVerarbeitet = heute;

    for (const [uid, queue] of Object.entries(d.missionQueue)) {
        if (istAdminId(uid)) continue;
        if (queue.date === heute) continue;

        const name = d.users[uid] ? d.users[uid].name : '';
        const wMission = getWochenMission(uid);
        const gestern = queue.date;
        let meldungen = [];

        const gestrigeLinks = Object.values(d.links).filter(l =>
            new Date(l.timestamp).toDateString() === gestern
        );
        const gestrigeInstaLinks = gestrigeLinks.filter(l =>
            istInstagramLink(l.text) && l.user_id !== Number(uid)
        );
        const gesamtGestern = gestrigeInstaLinks.length;
        const gelikedGestern = gestrigeInstaLinks.filter(l => l.likes.has(Number(uid))).length;
        const prozentGestern = gesamtGestern > 0 ? gelikedGestern / gesamtGestern : 0;
        const minLinksVorhanden = gestrigeInstaLinks.length >= 5;

        if (queue.m1Pending) {
            xpAdd(uid, 5, name);
            meldungen.push('✅ *Mission 1 abgeschlossen!*\n5 Links geliked → +5 XP');
            if (wMission.letzterTag !== gestern) {
                wMission.m1Tage++;
                if (wMission.m1Tage >= 7) {
                    xpAdd(uid, 10, name);
                    meldungen.push('🏆 *Wochen-Mission 1!*\n7 Tage 5+ Links geliked → +10 XP');
                    wMission.m1Tage = 0;
                }
            }
        }

        if (gesamtGestern > 0 && prozentGestern >= 0.8) {
            xpAdd(uid, 5, name);
            meldungen.push('✅ *Mission 2 abgeschlossen!*\n' + Math.round(prozentGestern * 100) + '% der Links geliked → +5 XP');
            if (wMission.letzterTag !== gestern) {
                wMission.m2Tage++;
                if (wMission.m2Tage >= 7) {
                    xpAdd(uid, 15, name);
                    meldungen.push('🏆 *Wochen-Mission 2!*\n7 Tage 80% geliked → +15 XP');
                    wMission.m2Tage = 0;
                }
            }
        }

        if (gesamtGestern > 0 && gelikedGestern === gesamtGestern) {
            xpAdd(uid, 5, name);
            meldungen.push('✅ *Mission 3 abgeschlossen!*\nAlle ' + gesamtGestern + ' Links geliked → +5 XP');
            if (wMission.letzterTag !== gestern) {
                wMission.m3Tage++;
                if (wMission.m3Tage >= 7) {
                    xpAdd(uid, 20, name);
                    meldungen.push('🏆 *Wochen-Mission 3!*\n7 Tage alle Links geliked → +20 XP');
                    wMission.m3Tage = 0;
                }
            }
        }

        wMission.letzterTag = gestern;

        const hatGesternLink = Object.values(d.links).some(l =>
            l.user_id === Number(uid) && new Date(l.timestamp).toDateString() === gestern
        );
        const m1Erfuellt = queue.m1Pending;

        if (!d.m1Streak[uid]) d.m1Streak[uid] = { count: 0, letzterTag: null };
        if (m1Erfuellt) {
            const streak = d.m1Streak[uid];
            const gesternTs = new Date(gestern).getTime() - 86400000;
            const gesternD = new Date(gesternTs).toDateString();
            if (streak.letzterTag === gesternD || streak.count === 0) {
                streak.count++;
            } else {
                streak.count = 1;
            }
            streak.letzterTag = gestern;
            if (streak.count >= 5 && d.users[uid] && d.users[uid].warnings > 0) {
                d.users[uid].warnings--;
                streak.count = 0;
                try {
                    await bot.telegram.sendMessage(Number(uid),
                        '🎉 *Warn entfernt!*\n\n✅ Du hast M1 *5 Tage in Folge* erfüllt!\n⚠️ Warns: *' + d.users[uid].warnings + '/5*',
                        { parse_mode: 'Markdown' }
                    );
                } catch (e) {}
            }
        } else {
            d.m1Streak[uid].count = 0;
        }

        if (hatGesternLink && !m1Erfuellt && minLinksVorhanden && d.users[uid]) {
            d.users[uid].warnings = (d.users[uid].warnings || 0) + 1;
            const warnCount = d.users[uid].warnings;
            const rotMarkierung = warnCount >= 3 ? '\n🔴 *ACHTUNG: 3+ Verwarnungen — du wirst bald gebannt!*' : '';
            try {
                await bot.telegram.sendMessage(Number(uid),
                    '⚠️ *Verwarnung!*\n\nDu hast gestern einen Link gepostet aber *M1 nicht erfüllt* (< 5 Likes gegeben).\n\n📋 Fairness-Verstoß.\n⚠️ Verwarnung: *' + warnCount + '/5*' + rotMarkierung,
                    { parse_mode: 'Markdown' }
                );
            } catch (e) {}
        }

        if (meldungen.length > 0 && d.users[uid]) {
            const u = d.users[uid];
            const naechstesBadge = xpBisNaechstesBadge(u.xp);
            const badgeHinweis = naechstesBadge
                ? '\n⬆️ Noch *' + naechstesBadge.fehlend + ' XP* bis ' + naechstesBadge.ziel
                : '\n🏅 Maximales Badge erreicht!';
            try {
                await bot.telegram.sendMessage(Number(uid),
                    '🎯 *Missions Auswertung — Gestern*\n\n' +
                    meldungen.filter(m => !m.includes('Verwarnung')).join('\n\n') +
                    '\n\n✅ *Diese XP wurden dir gutgeschrieben!*\n⭐ Gesamt XP: *' + u.xp + '*' + badgeHinweis,
                    { parse_mode: 'Markdown' }
                );
            } catch (e) {}
        } else if (d.users[uid] && d.users[uid].started && !hatGesternLink) {
            try {
                await bot.telegram.sendMessage(Number(uid),
                    '📊 *Missions Auswertung — Gestern*\n\n❌ Keine Mission erfüllt.\n\nHeute neue Chance! 💪',
                    { parse_mode: 'Markdown' }
                );
            } catch (e) {}
        }

        delete d.missionQueue[uid];
    }

    const nurHeute = {};
    if (d.missionAuswertungErledigt[jetzt12]) nurHeute[jetzt12] = true;
    d.missionAuswertungErledigt = nurHeute;

    for (const uid of Object.keys(d.m1Streak)) {
        if (d.m1Streak[uid].count === 0 && !d.users[uid]) {
            delete d.m1Streak[uid];
        }
    }

    speichern();
}

// ================================
// WEEKLY RANKING DM
// ================================
async function weeklyRankingDM() {
    const sorted = Object.entries(d.weeklyXP)
        .filter(([uid]) => d.users[uid])
        .sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return;
    const badges = ['🥇', '🥈', '🥉'];

    for (const [uid] of Object.entries(d.users)) {
        if (!d.users[uid].started) continue;
        if (istAdminId(uid)) continue;
        const rank = sorted.findIndex(([id]) => id === uid);
        if (rank === -1) continue;
        const xp = d.weeklyXP[uid] || 0;
        const u = d.users[uid];
        let platzText = rank < 3 ? badges[rank] : '#' + (rank + 1);
        let text = '📆 *Deine Weekly Ranking Platzierung*\n\n';
        text += platzText + ' Platz *' + (rank + 1) + '* von ' + sorted.length + ' Teilnehmern\n';
        text += '⭐ XP diese Woche: ' + xp + '\n\n';
        text += '🏆 *Top 3 dieser Woche:*\n';
        sorted.slice(0, 3).forEach(([tid, txp], i) => {
            const tu = d.users[tid];
            text += badges[i] + ' ' + tu.name + ': ' + txp + ' XP\n';
        });
        text += '\n🔥 Weiter so ' + u.name + '!';
        try {
            await bot.telegram.sendMessage(Number(uid), text, { parse_mode: 'Markdown' });
        } catch (e) {}
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
            if (istAdminId(ctx.from.id)) {
                u.xp = 0; u.level = 1; u.role = '⚙️ Admin';
            }
        }
        return next();
    } catch(e) {
        console.log('Middleware Fehler:', e.message);
        return next();
    }
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
        '👍 *Like System:*\n• 1 Like pro Link\n• Kein Self-Like\n• +5 XP pro Like (für dich)\n\n' +
        '🎯 *Tägliche Missionen:*\n• M1: 5 Links liken → +5 XP (sofort bestätigt)\n• M2: 80% aller Links liken → +5 XP\n• M3: Alle Links liken → +5 XP\n• ⏳ M2 & M3 XP werden täglich um 12:00 Uhr vergeben!\n\n' +
        '📅 *Wochen Missionen:*\n• 7x M1 → +10 XP\n• 7x M2 → +15 XP\n• 7x M3 → +20 XP\n\n' +
        '🏅 *Badges:*\n• 🆕 New: 0-49 XP\n• 📘 Anfänger: 50-499 XP\n• ⬆️ Aufsteiger: 500-999 XP\n• 🏅 Erfahrener: 1000+ XP (+1 Extra Link täglich!)\n\n' +
        '🏆 *Commands:*\n/ranking /dailyranking /weeklyranking\n/profile /daily /missionen';

    if (u.started) {
        try {
            await ctx.telegram.sendMessage(uid, text, { parse_mode: 'Markdown' });
            if (!istPrivat(ctx.chat.type)) await ctx.reply('📩 Hilfe per DM geschickt!');
        } catch (e) { await ctx.reply(text, { parse_mode: 'Markdown' }); }
    } else {
        const info = await ctx.telegram.getMe();
        await ctx.reply('⚠️ Starte zuerst den Bot per DM!', {
            reply_markup: Markup.inlineKeyboard([Markup.button.url('📩 Bot starten', 'https://t.me/' + info.username + '?start=help')]).reply_markup
        });
    }
});

// ================================
// /missionen
// ================================
bot.command('missionen', async (ctx) => {
    const uid = ctx.from.id;
    if (istAdminId(uid)) return ctx.reply('⚙️ *Admins nehmen nicht an Missionen teil.*', { parse_mode: 'Markdown' });
    const u = user(uid, ctx.from.first_name);
    const mission = getMission(uid);
    const wMission = getWochenMission(uid);
    const heute = new Date().toDateString();
    const heutigeLinks = Object.values(d.links).filter(l => new Date(l.timestamp).toDateString() === heute);
    const gesamtLinks = heutigeLinks.length;
    const geliked = heutigeLinks.filter(l => l.likes.has(Number(uid))).length;
    const prozent = gesamtLinks > 0 ? Math.round(geliked / gesamtLinks * 100) : 0;
    const queue = d.missionQueue[uid];
    let text = '🎯 *Deine Missionen*\n\n';
    text += '📅 *Täglich:*\n';
    text += (mission.m1 ? '✅' : '⬜') + ' M1: ' + mission.likesGegeben + '/5 Links geliked _(sofort)_\n';
    text += '⏳ M2: ' + prozent + '% geliked (Ziel: 80%) _(Auswertung 12:00)_\n';
    text += '⏳ M3: ' + geliked + '/' + gesamtLinks + ' alle Links _(Auswertung 12:00)_\n\n';
    if (queue && queue.date === heute && queue.m1Pending) {
        text += '⏳ *Ausstehende XP (werden um 12:00 vergeben):*\n• M1: +5 XP\n\n';
    }
    text += '📆 *Wöchentlich:*\n';
    text += '🔹 W-M1: ' + wMission.m1Tage + '/7 Tage\n';
    text += '🔹 W-M2: ' + wMission.m2Tage + '/7 Tage\n';
    text += '🔹 W-M3: ' + wMission.m3Tage + '/7 Tage\n\n';
    text += '⭐ Gesamt XP: ' + u.xp + '\n';
    text += '🏅 Badge: ' + u.role;
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ================================
// /profile
// ================================
bot.command('profile', async (ctx) => {
    const uid = ctx.from.id;
    const u = user(uid, ctx.from.first_name);
    const sorted = Object.entries(d.users).sort((a, b) => b[1].xp - a[1].xp);
    const rank = sorted.findIndex(x => x[0] == uid) + 1;
    const bonusL = d.bonusLinks[uid] || 0;
    await ctx.reply(
        '👤 *Profil von ' + u.name + (istAdminId(uid) ? ' ⚙️ Admin' : '') + '*\n' +
        (u.username ? '🔗 @' + u.username + '\n' : '') +
        '🆔 ID: `' + uid + '`\n\n' +
        '🏅 Badge: ' + u.role + '\n' +
        '⭐ XP Gesamt: ' + u.xp + '\n' +
        '📅 XP Heute: ' + (d.dailyXP[uid] || 0) + '\n' +
        '📆 XP Diese Woche: ' + (d.weeklyXP[uid] || 0) + '\n' +
        '📊 Level: ' + u.level + '\n' +
        '🏆 Rang: #' + rank + '\n' +
        '🔗 Links: ' + u.links + '\n' +
        (bonusL > 0 ? '🎁 Bonus Links: ' + bonusL + '\n' : '') +
        '👍 Likes gegeben: ' + u.totalLikes + '\n' +
        '⚠️ Warns: ' + u.warnings + '/5',
        { parse_mode: 'Markdown' }
    );
});

// ================================
// /ranking
// ================================
bot.command('ranking', async (ctx) => {
    const sorted = Object.entries(d.users)
        .filter(([uid]) => !istAdminId(uid))
        .sort((a, b) => b[1].xp - a[1].xp).slice(0, 10);
    if (!sorted.length) return ctx.reply('Noch keine Daten.');
    const badges = ['🥇', '🥈', '🥉'];
    let text = '🏆 *GESAMT RANKING*\n_(Permanent)_\n\n';
    sorted.forEach(([uid, u], i) => {
        const warns = u.warnings >= 3 ? ' 🔴' : '';
        text += (badges[i] || (i + 1) + '.') + ' ' + u.role + ' *' + u.name + '*' + warns + '\n';
        text += '   ⭐' + u.xp + ' | Lvl ' + u.level + '\n\n';
    });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ================================
// /dailyranking
// ================================
bot.command('dailyranking', async (ctx) => {
    const sorted = Object.entries(d.dailyXP)
        .filter(([uid]) => d.users[uid] && !istAdminId(uid))
        .sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return ctx.reply('Heute noch keine XP gesammelt.');
    const badges = ['🥇', '🥈', '🥉'];
    let text = '📅 *TAGES RANKING*\n\n';
    sorted.forEach(([uid, xp], i) => {
        const u = d.users[uid];
        const warns = u.warnings >= 3 ? ' 🔴' : '';
        text += (badges[i] || (i + 1) + '.') + ' ' + u.role + ' *' + u.name + '*' + warns + '\n';
        text += '   ⭐ ' + xp + ' XP heute\n\n';
    });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ================================
// /weeklyranking
// ================================
bot.command('weeklyranking', async (ctx) => {
    const sorted = Object.entries(d.weeklyXP)
        .filter(([uid]) => d.users[uid] && !istAdminId(uid))
        .sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return ctx.reply('Diese Woche noch keine XP.');
    const badges = ['🥇', '🥈', '🥉'];
    let text = '📆 *WOCHEN RANKING*\n\n';
    sorted.forEach(([uid, xp], i) => {
        const u = d.users[uid];
        const warns = u.warnings >= 3 ? ' 🔴' : '';
        text += (badges[i] || (i + 1) + '.') + ' ' + u.role + ' *' + u.name + '*' + warns + '\n';
        text += '   ⭐ ' + xp + ' XP diese Woche\n\n';
    });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ================================
// /daily
// ================================
bot.command('daily', async (ctx) => {
    const uid = ctx.from.id;
    const u = user(uid, ctx.from.first_name);
    const jetzt = Date.now();
    const h24 = 86400000;
    if (u.lastDaily && jetzt - u.lastDaily < h24) {
        const left = h24 - (jetzt - u.lastDaily);
        const h = Math.floor(left / 3600000);
        const m = Math.floor((left % 3600000) / 60000);
        return ctx.reply('⏳ Noch ' + h + 'h ' + m + 'min warten.');
    }
    if (istAdminId(uid)) return ctx.reply('⚙️ *Admins nehmen nicht am Daily Bonus teil.*', { parse_mode: 'Markdown' });
    const bonus = Math.floor(Math.random() * 20) + 10;
    u.lastDaily = jetzt;
    xpAddMitDaily(uid, bonus, ctx.from.first_name);
    speichern();
    await ctx.reply('🎁 *Daily Reward!*\n\n+' + bonus + ' XP!\n⭐ Gesamt: ' + u.xp + '\n🏅 Badge: ' + u.role, { parse_mode: 'Markdown' });
});

// ================================
// /stats
// ================================
bot.command('stats', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const alleChats = Object.values(d.chats);
    const gruppen = alleChats.filter(c => istGruppe(c.type));
    await ctx.reply('📊 *Statistiken*\n\n👥 User: ' + Object.keys(d.users).length + '\n💬 Chats: ' + alleChats.length + '\n👥 Gruppen: ' + gruppen.length + '\n🔗 Links: ' + Object.keys(d.links).length, { parse_mode: 'Markdown' });
});

// ================================
// /dashboard
// ================================
bot.command('dashboard', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('Nur Admins!');
    const heute = new Date().toDateString();
    const heutigeLinks = Object.values(d.links).filter(l => new Date(l.timestamp).toDateString() === heute);
    const gesamtLinksHeute = heutigeLinks.length;
    const alleUser = Object.entries(d.users);
    const gestarteteUser = alleUser.filter(([, u]) => u.started);
    const aktiveHeute = alleUser.filter(([uid]) => d.dailyXP[uid] && d.dailyXP[uid] > 0);
    const habenGeliked = new Set();
    heutigeLinks.forEach(l => l.likes.forEach(uid => habenGeliked.add(uid)));
    const nichtGeliked = gestarteteUser.filter(([uid]) => !habenGeliked.has(Number(uid)));
    const mitWarns = alleUser.filter(([, u]) => u.warnings > 0);
    let m1Heute = 0, m2Heute = 0, m3Heute = 0;
    for (const [uid] of alleUser) {
        if (d.missionen[uid] && d.missionen[uid].date === heute) {
            if (d.missionen[uid].m1) m1Heute++;
            if (d.missionen[uid].m2) m2Heute++;
            if (d.missionen[uid].m3) m3Heute++;
        }
    }
    const top3 = Object.entries(d.dailyXP).filter(([uid]) => d.users[uid]).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const gesamtLikes = heutigeLinks.reduce((sum, l) => sum + l.likes.size, 0);
    const maxMoeglicheLikes = gesamtLinksHeute * gestarteteUser.length;
    const likeRate = maxMoeglicheLikes > 0 ? Math.round(gesamtLikes / maxMoeglicheLikes * 100) : 0;
    const badgeCount = { 'New': 0, 'Anfanger': 0, 'Aufsteiger': 0, 'Erfahrener': 0 };
    alleUser.forEach(([, u]) => {
        if (u.xp >= 1000) badgeCount['Erfahrener']++;
        else if (u.xp >= 500) badgeCount['Aufsteiger']++;
        else if (u.xp >= 50) badgeCount['Anfanger']++;
        else badgeCount['New']++;
    });
    const bdg = ['1.', '2.', '3.'];
    let t1 = 'ADMIN DASHBOARD\n' + new Date().toLocaleString('de-DE') + '\n\n';
    t1 += 'USER: ' + alleUser.length + ' | Gestartet: ' + gestarteteUser.length + '\n';
    t1 += 'Aktiv heute: ' + aktiveHeute.length + ' | Nicht geliked: ' + nichtGeliked.length + '\n';
    t1 += 'Mit Warns: ' + mitWarns.length + '\n\n';
    t1 += 'LINKS: ' + gesamtLinksHeute + ' | Likes: ' + gesamtLikes + ' | Rate: ' + likeRate + '%\n\n';
    t1 += 'MISSIONEN: M1=' + m1Heute + ' M2=' + m2Heute + ' M3=' + m3Heute + '\n\n';
    t1 += 'BADGES: New=' + badgeCount['New'] + ' Anf=' + badgeCount['Anfanger'] + ' Auf=' + badgeCount['Aufsteiger'] + ' Erf=' + badgeCount['Erfahrener'] + '\n\n';
    t1 += 'TOP 3: ';
    top3.forEach(([uid, xp], i) => { t1 += bdg[i] + ' ' + d.users[uid].name + '(' + xp + ') '; });
    await ctx.telegram.sendMessage(ctx.from.id, t1);

    const sortedUsers = alleUser.sort((a, b) => b[1].xp - a[1].xp);
    let t2 = 'ALLE USER DETAILS\n\n';
    for (const [uid, u] of sortedUsers) {
        const mission = d.missionen[uid] && d.missionen[uid].date === heute ? d.missionen[uid] : null;
        const hatGelikedH = habenGeliked.has(Number(uid));
        const hatLinkH = d.tracker[uid] === heute;
        t2 += u.name + (u.username ? ' @' + u.username : '') + '\n';
        t2 += '  ' + u.role + ' | XP:' + u.xp + ' | Heute:' + (d.dailyXP[uid] || 0) + '\n';
        t2 += '  Geliked:' + (hatGelikedH ? 'Ja' : 'Nein') + ' | Link:' + (hatLinkH ? 'Ja' : 'Nein') + ' | W:' + u.warnings + '/5\n';
        if (mission) t2 += '  M1:' + (mission.m1 ? 'OK' : 'X') + ' M2:' + (mission.m2 ? 'OK' : 'X') + ' M3:' + (mission.m3 ? 'OK' : 'X') + '\n';
        t2 += '\n';
        if (t2.length > 3500) {
            await ctx.telegram.sendMessage(ctx.from.id, t2);
            t2 = '';
        }
    }
    if (t2.length > 0) await ctx.telegram.sendMessage(ctx.from.id, t2);
    if (!istPrivat(ctx.chat.type)) await ctx.reply('Dashboard per DM geschickt!');
});

// ================================
// /chats
// ================================
bot.command('chats', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const alle = Object.values(d.chats);
    if (!alle.length) return ctx.reply('Keine Chats bekannt.');
    const privat = alle.filter(c => c.type === 'private').length;
    const gruppen = alle.filter(c => istGruppe(c.type));
    let text = '💬 *Bekannte Chats*\n\n👤 Privat: ' + privat + '\n👥 Gruppen: ' + gruppen.length + '\n\n';
    gruppen.forEach(g => { text += '• ' + g.title + ' (`' + g.id + '`)\n'; });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ================================
// /chatinfo
// ================================
bot.command('chatinfo', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const c = d.chats[ctx.chat.id];
    await ctx.reply('💬 *Chat Info*\n\n🆔 ID: `' + ctx.chat.id + '`\n📝 Titel: ' + (ctx.chat.title || ctx.chat.first_name || 'Privat') + '\n🔤 Typ: ' + ctx.chat.type + '\n💬 Nachrichten: ' + ((c && c.msgs) || 0), { parse_mode: 'Markdown' });
});

// ================================
// /dm
// ================================
bot.command('dm', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const nachricht = ctx.message.text.replace('/dm', '').trim();
    if (!nachricht) return ctx.reply('❌ Benutzung: /dm Deine Nachricht hier');
    let gesendet = 0, fehler = 0;
    await ctx.reply('📨 Sende Nachricht an alle User...');
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started) continue;
        try {
            await bot.telegram.sendMessage(Number(uid), '📢 *Nachricht vom Admin:*\n\n' + nachricht, { parse_mode: 'Markdown' });
            gesendet++;
            await new Promise(r => setTimeout(r, 200));
        } catch (e) { fehler++; }
    }
    await ctx.reply('✅ Gesendet: ' + gesendet + '\n❌ Fehler: ' + fehler);
});

// ================================
// TEST COMMANDS
// ================================
bot.command('testxp', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    xpAddMitDaily(ctx.from.id, 50, ctx.from.first_name);
    speichern();
    await ctx.reply('✅ +50 XP! Gesamt: ' + (d.users[ctx.from.id] ? d.users[ctx.from.id].xp : 0));
});
bot.command('testwarn', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    const u = user(ctx.from.id, ctx.from.first_name);
    u.warnings++;
    speichern();
    await ctx.reply('✅ Warn: ' + u.warnings + '/5');
});
bot.command('testban', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    await ctx.reply('✅ Bei 5 Warns = Ban.');
});
bot.command('testranking', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    const s = Object.entries(d.users).sort((a, b) => b[1].xp - a[1].xp).slice(0, 3);
    await ctx.reply('✅ Top 3:\n' + s.map((x, i) => (i + 1) + '. ' + x[1].name + ': ' + x[1].xp + ' XP').join('\n'));
});
bot.command('testreset', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    d.dailyXP = {}; d.weeklyXP = {}; d.missionen = {}; d.wochenMissionen = {}; d.missionQueue = {};
    d.tracker = {}; d.counter = {}; d.badgeTracker = {};
    speichern();
    await ctx.reply('✅ Vollständiger Reset! Permanente XP bleiben.');
});
bot.command('testregeln', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    await ctx.reply('📜 *Regeln*\n\n1️⃣ 1 Link pro Tag\n2️⃣ Keine Duplikate\n3️⃣ Bot starten Pflicht\n4️⃣ 5 Warns = Ban\n5️⃣ Respekt', { parse_mode: 'Markdown' });
});
bot.command('testsieger', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    const s = Object.values(d.users).filter(u => !istAdminId(u)).sort((a, b) => b.xp - a.xp);
    if (s.length) await ctx.reply('🥇 ' + s[0].name + ' mit ' + s[0].xp + ' XP');
});
bot.command('testdaily', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    user(ctx.from.id, ctx.from.first_name).lastDaily = null;
    speichern();
    await ctx.reply('✅ Daily reset!');
});
bot.command('testcontent', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    await topLinks(ctx.chat.id);
});
bot.command('testreward', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    await ctx.reply('✅ Reward: Platz 1 bekommt Extra Link.');
});
bot.command('testdailyranking', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    await dailyRankingAbschluss();
    await ctx.reply('✅ Daily Ranking getestet!');
});
bot.command('testgewinnspiel', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    await wochenGewinnspiel();
    await ctx.reply('✅ Gewinnspiel getestet!');
});
bot.command('testliked', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    await likeErinnerung();
    await ctx.reply('✅ Like Erinnerung gesendet!');
});
bot.command('testmission', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    await checkMissionen(ctx.from.id, ctx.from.first_name);
    await ctx.reply('✅ Missionen geprüft!');
});
bot.command('testmissionauswertung', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    const gestern = new Date(Date.now() - 86400000).toDateString();
    for (const uid of Object.keys(d.missionQueue)) {
        d.missionQueue[uid].date = gestern;
    }
    d.missionQueueVerarbeitet = null;
    await missionenAuswerten();
    await ctx.reply('✅ Missions Auswertung getestet!');
});
bot.command('testweeklyranking', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    await weeklyRankingDM();
    await ctx.reply('✅ Weekly Ranking DM gesendet!');
});
bot.command('warn', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    if (!ctx.message.reply_to_message) return ctx.reply('❌ Antworte auf eine Nachricht des Users.');
    const userId = ctx.message.reply_to_message.from.id;
    const u = user(userId, ctx.message.reply_to_message.from.first_name);
    u.warnings = (u.warnings || 0) + 1;
    const rotMarkierung = u.warnings >= 3 ? '\n🔴 *3+ Verwarnungen!*' : '';
    speichern();
    await ctx.reply('⚠️ Verwarnung an *' + u.name + '*\n⚠️ Warns: *' + u.warnings + '/5*' + rotMarkierung, { parse_mode: 'Markdown' });
    try {
        await bot.telegram.sendMessage(userId, '⚠️ *Du hast eine Verwarnung erhalten!*\n\n📋 Grund: Admin-Entscheidung\n⚠️ Warns: *' + u.warnings + '/5*' + rotMarkierung, { parse_mode: 'Markdown' });
    } catch (e) {}
});
bot.command('unban', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    if (!ctx.message.reply_to_message) return ctx.reply('❌ Antworte auf eine Nachricht.');
    const userId = ctx.message.reply_to_message.from.id;
    try {
        await ctx.telegram.unbanChatMember(ctx.chat.id, userId);
        if (d.users[userId]) d.users[userId].warnings = 0;
        await ctx.reply('✅ User entbannt!');
    } catch (e) { await ctx.reply('❌ Fehler.'); }
});
bot.command('ankuendigung', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    await ctx.reply('📢 *Wichtige Bot-Updates!*\n\n1️⃣ Text-Weiterleitung aktiv\n2️⃣ XP wird dauerhaft gespeichert\n3️⃣ 3 XP Systeme: Permanent, Daily, Weekly\n4️⃣ Tägliche & Wöchentliche Missionen\n5️⃣ Badge System mit Belohnungen\n6️⃣ Wöchentliches Gewinnspiel\n\n✅ Viel Spaß!', { parse_mode: 'Markdown' });
});
bot.command('time', (ctx) => {
    ctx.reply("🕒 Serverzeit:\n" + new Date().toString());
});

// ================================
// NEUE MITGLIEDER
// ================================
bot.on('new_chat_members', async (ctx) => {
    for (const m of ctx.message.new_chat_members) {
        if (m.is_bot) continue;
        d.warte[m.id] = ctx.chat.id;
        user(m.id, m.first_name);
        const info = await ctx.telegram.getMe();
        await ctx.reply(
            '👋 Willkommen *' + m.first_name + '*!\n\n⚠️ Starte den Bot per DM!\n• Links posten\n• XP sammeln\n• Missionen erfüllen\n\n👇',
            { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([Markup.button.url('📩 Bot starten', 'https://t.me/' + info.username + '?start=gruppe')]).reply_markup }
        );
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

    if (!hatLink(text)) {
        if (ctx.chat.id === -1003800312818) {
            const istAdminMsg = await istAdmin(ctx, uid);
            if (!istAdminMsg) {
                try {
                    await ctx.forwardMessage(-1003906557227);
                    await ctx.deleteMessage();
                    const hinweis = await ctx.reply(
                        '📨 *' + ctx.from.first_name + '*, deine Nachricht wurde in diesen Ordner verschoben:\n\n👉 [Hier klicken](https://t.me/c/3906557227/1)',
                        { parse_mode: 'Markdown' }
                    );
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
        d.warte[uid] = ctx.chat.id;
        const info = await ctx.telegram.getMe();
        const warteMsg = await ctx.reply('⚠️ *' + ctx.from.first_name + '*, starte den Bot per DM!', {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([Markup.button.url('📩 Bot starten', 'https://t.me/' + info.username + '?start=gruppe')]).reply_markup
        });
        if (!d.warteNachricht) d.warteNachricht = {};
        d.warteNachricht[uid] = { chatId: ctx.chat.id, msgId: warteMsg.message_id };
        speichern();
        return;
    }

    if (istSperrzeit() && !admin) {
        try { await ctx.deleteMessage(); } catch (e) {}
        const sperrMsg = await ctx.reply('🚫 *Keine Links erlaubt!*\n\n📅 Von *Sonntag 20:00* bis *Montag 06:00* sind keine Links erlaubt.\n\n✅ Ab Montag 06:00 Uhr kannst du wieder posten!', { parse_mode: 'Markdown' });
        setTimeout(async () => { try { await ctx.telegram.deleteMessage(ctx.chat.id, sperrMsg.message_id); } catch (e) {} }, 20000);
        return;
    }

    const url = linkUrl(text);
    const urlNorm = normalisiereUrl(url);
    if (url && d.gepostet.some(u => normalisiereUrl(u) === urlNorm)) {
        if (!admin) {
            try { await ctx.deleteMessage(); } catch (e) {}
            const warnMsg = await ctx.reply('❌ *Duplikat!* Dieser Link wurde bereits gepostet.', { parse_mode: 'Markdown' });
            setTimeout(async () => { try { await ctx.telegram.deleteMessage(ctx.chat.id, warnMsg.message_id); } catch (e) {} }, 10000);
            try { await ctx.telegram.sendMessage(uid, '⚠️ Dein Link wurde gelöscht — er wurde bereits gepostet.'); } catch (e) {}
            speichern();
            return;
        }
    }
    if (url) {
        const cleanUrl = linkUrl(url) || url;
        if (!d.gepostet.includes(cleanUrl)) {
            d.gepostet.push(cleanUrl);
            if (d.gepostet.length > 2000) d.gepostet.shift();
        }
    }

    if (!d.counter[uid]) d.counter[uid] = 0;
    const heute = new Date().toDateString();
    const badgeBonus = badgeBonusLinks(u.xp);

    if (!admin && d.tracker[uid] === heute) {
        if (hatBonusLink(uid)) {
            bonusLinkNutzen(uid);
            await ctx.reply('🎁 *Bonus Link genutzt!*', { parse_mode: 'Markdown' });
        } else if (badgeBonus > 0 && (!d.badgeTracker[uid] || d.badgeTracker[uid] !== heute)) {
            d.badgeTracker[uid] = heute;
            await ctx.reply('🏅 *Erfahrener Badge Extra Link genutzt!*', { parse_mode: 'Markdown' });
        } else {
            try { await ctx.deleteMessage(); } catch (e) {}
            d.counter[uid]++;
            if (u.warnings >= 5) {
                try { await ctx.telegram.banChatMember(ctx.chat.id, uid); } catch (e) {}
                await ctx.reply('🔨 *' + ctx.from.first_name + '* gebannt!', { parse_mode: 'Markdown' });
            } else {
                const warnMsg = await ctx.reply('❌ *Nur 1 Link pro Tag!*\n🕛 Ab Mitternacht wieder möglich.', { parse_mode: 'Markdown' });
                setTimeout(async () => { try { await ctx.telegram.deleteMessage(ctx.chat.id, warnMsg.message_id); } catch (e) {} }, 10000);
                try { await ctx.telegram.sendMessage(uid, '⚠️ Link gelöscht!\n🕛 Du kannst morgen wieder posten.'); } catch (e) {}
            }
            speichern();
            return;
        }
    }

    if (!istAdminId(uid)) d.tracker[uid] = heute;
    d.counter[uid] = 0;
    if (!istAdminId(uid)) u.links++;
    if (!istAdminId(uid)) xpAddMitDaily(uid, 1, ctx.from.first_name);
    // Admin Badge IMMER sofort erzwingen
    if (istAdminId(uid)) { u.xp = 0; u.level = 1; u.role = '⚙️ Admin'; }
    const msgId = ctx.message.message_id;
    const istInsta = istInstagramLink(text);

    if (istInsta) {
        const origMsgId = ctx.message.message_id;
        const chatId = ctx.chat.id;
        try { await ctx.deleteMessage(); } catch (e) {}
        const posterName = istAdminId(uid) ? '⚙️ Admin ' + ctx.from.first_name : u.role + ' ' + ctx.from.first_name;
        const posterStats = istAdminId(uid) ? '' : ' | ⭐ ' + u.xp + ' XP | Lvl ' + u.level;
        let botMsg;
        try {
            botMsg = await bot.telegram.sendMessage(chatId,
                posterName + '\n🔗 ' + text + '\n\n👍 0 Likes' + posterStats,
                {
                    reply_markup: Markup.inlineKeyboard([[Markup.button.callback('👍 Like  |  0', 'like_' + origMsgId)]]).reply_markup
                }
            );
        } catch (e) {
            console.log('Fehler beim Reposten:', e.message);
            speichern();
            return;
        }

        d.links[origMsgId] = {
            chat_id: chatId, user_id: uid, user_name: ctx.from.first_name,
            text: text, likes: new Set(), counter_msg_id: botMsg.message_id, timestamp: Date.now()
        };

        if (!istAdminId(uid)) {
            try {
                const erinnerungMsg = await bot.telegram.sendMessage(chatId,
                    '🎯 *' + posterName + '*\n⭐ ' + u.xp + ' XP | Lvl ' + u.level + '\n\n⚠️ Mindestens *5 Links* liken (M1) — sonst droht Verwarnung!',
                    { parse_mode: 'Markdown', reply_to_message_id: botMsg.message_id }
                );
                setTimeout(async () => { try { await bot.telegram.deleteMessage(chatId, erinnerungMsg.message_id); } catch (e) {} }, 10000);
            } catch (e) {}
        }

        const linkKeys = Object.keys(d.links);
        if (linkKeys.length > 500) {
            const oldest = linkKeys.sort((a, b) => d.links[a].timestamp - d.links[b].timestamp)[0];
            delete d.links[oldest];
        }
        await sendeLinkAnAlle(d.links[origMsgId]);
    } else {
        d.links[msgId] = {
            chat_id: ctx.chat.id, user_id: uid, user_name: ctx.from.first_name,
            text: text, likes: new Set(), counter_msg_id: msgId, timestamp: Date.now()
        };
    }

    speichern();
    } catch(e) { console.log('Message Handler Fehler:', e.message); }
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
        try { await ctx.answerCbQuery(); } catch(e) {}
        return;
    }
    likeInProgress.add(likeKey);
    setTimeout(() => likeInProgress.delete(likeKey), 5000);

    try {
    if (!d.links[msgId]) {
        try { await ctx.answerCbQuery('❌ Link nicht mehr vorhanden.'); } catch(e) {}
        return;
    }
    const lnk = d.links[msgId];
    if (uid === lnk.user_id) {
        try { await ctx.answerCbQuery('❌ Kein Self-Like!'); } catch(e) {}
        return;
    }
    if (lnk.likes.has(uid)) {
        try { await ctx.answerCbQuery('❌ Bereits geliked!'); } catch(e) {}
        return;
    }

    lnk.likes.add(uid);
    const anz = lnk.likes.size;
    const poster = user(lnk.user_id, lnk.user_name);
    // Poster totalLikes erhöhen (auch für Admin-Posts)
    poster.totalLikes++;

    const linkDatum = new Date(lnk.timestamp).toDateString();
    const heuteDatum = new Date().toDateString();
    const istHeutigerLink = linkDatum === heuteDatum;

    // Liker bekommt IMMER XP - egal ob Admin-Link oder nicht
    // Nur der Liker selbst bekommt keine XP wenn er Admin ist
    if (!istAdminId(uid)) {
        if (istHeutigerLink) {
            xpAddMitDaily(uid, 5, ctx.from.first_name);
        } else {
            xpAdd(uid, 5, ctx.from.first_name);
        }
    }

    const msgKey = String(lnk.counter_msg_id);
    if (d.dmNachrichten && d.dmNachrichten[msgKey] && d.dmNachrichten[msgKey][uid]) {
        try {
            await bot.telegram.deleteMessage(uid, d.dmNachrichten[msgKey][uid]);
            delete d.dmNachrichten[msgKey][uid];
        } catch (e) {}
    }

    // Mission zählt für ALLE Links - auch Admin Links
    if (!istAdminId(uid)) {
        const mission = getMission(uid);
        if (istHeutigerLink && istInstagramLink(lnk.text)) {
            mission.likesGegeben++;
        }
        await checkMissionen(uid, ctx.from.first_name);
    }

    const liker = user(uid, ctx.from.first_name);
    const naechstesBadge = xpBisNaechstesBadge(liker.xp);
    const badgeInfo = naechstesBadge ? '\n⬆️ Noch *' + naechstesBadge.fehlend + ' XP* bis ' + naechstesBadge.ziel : '\n🏅 Maximales Badge erreicht!';

    const feedbackText = istAdminId(uid)
        ? '✅ *Like registriert!* _(Admin)_'
        : istHeutigerLink
            ? '🎉 *+5 XP!*\n' + liker.role + ' | ⭐ ' + liker.xp + badgeInfo
            : '🎉 *+5 XP!* _(nur Weekly)_\n' + liker.role + ' | ⭐ ' + liker.xp + badgeInfo;

    const feedbackMsg = await ctx.reply(feedbackText, { parse_mode: 'Markdown' });
    setTimeout(async () => { try { await ctx.telegram.deleteMessage(ctx.chat.id, feedbackMsg.message_id); } catch (e) {} }, 10000);

    try { await ctx.answerCbQuery('👍 ' + anz + '!'); } catch(e) {}

    try {
        // Kein Markdown - verhindert Parse-Fehler bei Instagram URLs
        const posterLabel = istAdminId(lnk.user_id) ? '⚙️ Admin ' + lnk.user_name : poster.role + ' ' + lnk.user_name;
        const editText = posterLabel + '\n' +
            '🔗 ' + lnk.text + '\n\n' +
            '👍 ' + anz + ' Likes' + (istAdminId(lnk.user_id) ? '' : ' | ⭐ ' + poster.xp + ' XP | Lvl ' + poster.level);
        await ctx.telegram.editMessageText(
            lnk.chat_id, lnk.counter_msg_id, null,
            editText,
            {
                reply_markup: Markup.inlineKeyboard([[Markup.button.callback('👍 Like  |  ' + anz, 'like_' + msgId)]]).reply_markup
            }
        );
    } catch (e) { console.log('Edit Fehler:', e.message); }

    speichernDebounced(); // Debounced - nicht bei jedem Like sofort schreiben
    } catch(e) { console.log('Like Fehler:', e.message); }
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
        try {
            return await bot.telegram.sendMessage(Number(uid), text, options);
        } catch (e) {
            if (i < 2) await new Promise(r => setTimeout(r, 1000));
            else console.log('DM fehlgeschlagen für', uid, ':', e.message);
        }
    }
    return null;
}

// Batch DM Funktion - sendet an viele User in Batches
async function sendeInBatches(empfaenger, textFn, optionsFn) {
    const BATCH = 10;
    const DELAY = 1000;
    for (let i = 0; i < empfaenger.length; i += BATCH) {
        const batch = empfaenger.slice(i, i + BATCH);
        await Promise.allSettled(
            batch.map(([uid, u]) => sendeDM(uid, textFn(uid, u), optionsFn ? optionsFn(uid, u) : {}))
        );
        if (i + BATCH < empfaenger.length) {
            await new Promise(r => setTimeout(r, DELAY));
        }
    }
}

async function sendeLinkAnAlle(linkData) {
    if (!d.dmNachrichten) d.dmNachrichten = {};
    const msgKey = String(linkData.counter_msg_id);
    if (!d.dmNachrichten[msgKey]) d.dmNachrichten[msgKey] = {};

    const empfaenger = Object.entries(d.users).filter(([uid, u]) =>
        parseInt(uid) !== linkData.user_id && u.started
    );

    const linkUrl2 = 'https://t.me/c/' + String(linkData.chat_id).replace('-100', '') + '/' + linkData.counter_msg_id;

    for (let i = 0; i < empfaenger.length; i += 10) {
        const batch = empfaenger.slice(i, i + 10);
        const results = await Promise.allSettled(
            batch.map(([uid]) => sendeDM(uid,
                '📢 Neuer Booster-Link\n\n👤 Member: ' + linkData.user_name + '\n\n🔗 ' + linkData.text + '\n\nBitte liken und kommentieren! 👍',
                { reply_markup: { inline_keyboard: [[{ text: '👉 Zum Beitrag', url: linkUrl2 }]] } }
            ))
        );
        results.forEach((result, idx) => {
            if (result.status === 'fulfilled' && result.value) {
                const uid = batch[idx][0];
                d.dmNachrichten[msgKey][uid] = result.value.message_id;
            }
        });
        if (i + 10 < empfaenger.length) {
            await new Promise(r => setTimeout(r, 1000));
        }
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
    const belohnungen = [
        { xp: 10, links: 1, text: '🥇 Platz 1' },
        { xp: 5, links: 0, text: '🥈 Platz 2' },
        { xp: 2, links: 0, text: '🥉 Platz 3' }
    ];
    let rankText = '🏆 *TAGES RANKING ABSCHLUSS*\n\n';
    for (let i = 0; i < Math.min(3, sorted.length); i++) {
        const [uid, xp] = sorted[i];
        const u = d.users[uid];
        const bel = belohnungen[i];
        xpAdd(uid, bel.xp, u.name);
        if (bel.links > 0) { if (!d.bonusLinks[uid]) d.bonusLinks[uid] = 0; d.bonusLinks[uid] += bel.links; }
        rankText += bel.text + ': *' + u.name + '*\n   ⭐ ' + xp + ' XP | +' + bel.xp + ' Bonus' + (bel.links > 0 ? ' + 1 Extra Link!' : '') + '\n\n';
        try { await bot.telegram.sendMessage(Number(uid), '🎉 *' + bel.text + '!*\n\n🎁 +' + bel.xp + ' XP' + (bel.links > 0 ? '\n🔗 1 Extra Link für morgen!' : ''), { parse_mode: 'Markdown' }); } catch (e) {}
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
// GESTERN RANKING POSTEN
// ================================
async function gesternRankingPosten() {
    const gruppen = Object.values(d.chats).filter(c => istGruppe(c.type));
    const sorted = Object.entries(d.gesternDailyXP)
        .filter(([uid]) => d.users[uid] && d.gesternDailyXP[uid] > 0 && !istAdminId(uid))
        .sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return;
    const badges = ['🥇', '🥈', '🥉'];
    const sieger = sorted[0] ? d.users[sorted[0][0]] : null;
    let text = '🌅 *TAGES RANKING — VORTAG*\n\n';
    if (sieger) text += '🎉 Herzlichen Glückwunsch *' + sieger.name + '*! 👑\n\n';
    sorted.forEach(([uid, xp], i) => {
        const u = d.users[uid];
        text += (badges[i] || (i + 1) + '.') + ' *' + u.name + '*\n   ⭐ ' + xp + ' XP gestern\n\n';
    });
    text += '🔥 Macht heute weiter so!';
    gruppen.forEach(g => { bot.telegram.sendMessage(g.id, text, { parse_mode: 'Markdown' }).catch(() => {}); });
}

// ================================
// WÖCHENTLICHES GEWINNSPIEL
// ================================
async function wochenGewinnspiel() {
    const gruppen = Object.values(d.chats).filter(c => istGruppe(c.type));
    const teilnehmer = Object.entries(d.weeklyXP).filter(([uid]) => d.users[uid] && d.weeklyXP[uid] > 0 && !istAdminId(uid)).map(([uid]) => uid);
    if (!teilnehmer.length) return;
    const gewinnerUid = teilnehmer[Math.floor(Math.random() * teilnehmer.length)];
    const gewinner = d.users[gewinnerUid];
    if (!d.bonusLinks[gewinnerUid]) d.bonusLinks[gewinnerUid] = 0;
    d.bonusLinks[gewinnerUid] += 1;
    d.wochenGewinnspiel.gewinner.push({ name: gewinner.name, uid: gewinnerUid, datum: new Date().toLocaleDateString() });
    d.wochenGewinnspiel.letzteAuslosung = Date.now();
    const text = '🎰 *WÖCHENTLICHES GEWINNSPIEL*\n\n🎉 Gewinner: *' + gewinner.name + '*\n\n🎁 1 Extra Link für nächste Woche!\n\n📆 Nächste Auslosung: Nächsten Sonntag';
    gruppen.forEach(g => { bot.telegram.sendMessage(g.id, text, { parse_mode: 'Markdown' }).catch(() => {}); });
    try { await bot.telegram.sendMessage(Number(gewinnerUid), '🎉 *Du hast das Gewinnspiel gewonnen!*\n\n🎁 1 Extra Link für diese Woche!', { parse_mode: 'Markdown' }); } catch (e) {}
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
    const heutigeLinks = Object.entries(d.links).filter(([, l]) => {
        return l.timestamp >= heute && new Date(l.timestamp).toDateString() === new Date().toDateString();
    });
    if (!heutigeLinks.length) return;
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started) continue;
        if (istAdminId(uid)) continue;
        const nichtGeliked = heutigeLinks.filter(([, l]) => l.user_id != uid && !l.likes.has(Number(uid)));
        if (!nichtGeliked.length) continue;
        let text = '👋 *Hallo ' + u.name + '!*\n\n⚠️ Du hast heute noch diese Links nicht geliked:\n\n';
        const buttons = [];
        for (const [msgId, l] of nichtGeliked) {
            text += '🔗 Link von *' + l.user_name + '*\n';
            const linkMsgId = l.counter_msg_id || msgId;
            buttons.push([Markup.button.url('👍 Liken - ' + l.user_name, 'https://t.me/c/' + String(l.chat_id).replace('-100', '') + '/' + linkMsgId)]);
        }
        text += '\n⏳ *Missionen schließen um 12:00 Uhr — jetzt noch liken!*';
        try { await bot.telegram.sendMessage(Number(uid), text, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard(buttons).reply_markup }); } catch (e) {}
    }
}

// ================================
// ABEND M1 WARNUNG
// ================================
async function abendM1Warnung() {
    const heute = new Date().toDateString();
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started) continue;
        if (istAdminId(uid)) continue;
        const hatHeuteLink = Object.values(d.links).some(l =>
            l.user_id === Number(uid) && new Date(l.timestamp).toDateString() === heute
        );
        if (!hatHeuteLink) continue;
        const fremdeInstaLinks = Object.values(d.links).filter(l =>
            istInstagramLink(l.text) && l.user_id !== Number(uid) && new Date(l.timestamp).toDateString() === heute
        );
        if (fremdeInstaLinks.length < 5) continue;
        const mission = d.missionen[uid];
        if (mission && mission.date === heute && mission.m1) continue;
        const likesGegeben = mission ? mission.likesGegeben : 0;
        const fehlend = 5 - likesGegeben;
        try {
            await bot.telegram.sendMessage(Number(uid),
                '⚠️ *Erinnerung — Mindestlikes!*\n\nDu hast heute einen Link gepostet aber erst *' + likesGegeben + '/5* Likes vergeben.\n\n👉 Du musst noch *' + fehlend + ' Links* liken!\n🚨 Sonst erhältst du morgen eine *Verwarnung*.',
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

    // Event Key ZUERST — verhindert doppelte Ausführung
    const eventKey = h + ':' + m + ':' + jetzt.toDateString();
    if (!d._lastEvents) d._lastEvents = {};

    const gruppen = Object.values(d.chats).filter(c => istGruppe(c.type));

    // 03:00 Backup
    if (h === 3 && m === 0 && d._lastEvents['backup'] !== eventKey) {
        d._lastEvents['backup'] = eventKey;
        await backup();
    }

    // 06:00 Regeln + Vortags Ranking
    if (h === 6 && m === 0 && d._lastEvents['regeln'] !== eventKey) {
        d._lastEvents['regeln'] = eventKey;
        gruppen.forEach(g => {
            bot.telegram.sendMessage(g.id,
                '📜 *Regeln*\n\n1️⃣ 1 Link pro Tag\n2️⃣ Keine Duplikate\n3️⃣ Bot starten Pflicht\n4️⃣ 5 Warns = Ban\n5️⃣ Respektvoller Umgang\n\n🆕 Kommentare: mind. 2 Wörter\n👍 Pflicht: jeden Link liken & kommentieren\n\n🔍 Tägliche Kontrollen\n❗ Mogeln = sofortiger Ban',
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        });
        await gesternRankingPosten();
    }

    // 12:00 Missions Auswertung
    if (h === 12 && m === 0 && d._lastEvents['missionen'] !== eventKey) {
        d._lastEvents['missionen'] = eventKey;
        await missionenAuswerten();
    }

    // 22:00 Abend M1 Warnung
    if (h === 22 && m === 0 && d._lastEvents['abendwarnung'] !== eventKey) {
        d._lastEvents['abendwarnung'] = eventKey;
        await abendM1Warnung();
    }

    // 23:00 Like Erinnerung
    if (h === 23 && m === 0 && d._lastEvents['reminder'] !== eventKey) {
        d._lastEvents['reminder'] = eventKey;
        await likeErinnerung();
    }

    // 23:55 Daily Ranking Abschluss
    if (h === 23 && m === 55 && d._lastEvents['dailyRanking'] !== eventKey) {
        d._lastEvents['dailyRanking'] = eventKey;
        await dailyRankingAbschluss();
    }

    // Sonntag 20:00 Gewinnspiel
    if (wochentag === 0 && h === 20 && m === 0 && d._lastEvents['gewinnspiel'] !== eventKey) {
        d._lastEvents['gewinnspiel'] = eventKey;
        await wochenGewinnspiel();
    }

    // Alte Links löschen (älter als 2 Tage)
    const zweiTage = 2 * 24 * 60 * 60 * 1000;
    for (const [k, l] of Object.entries(d.links)) {
        if (Date.now() - l.timestamp > zweiTage) {
            bot.telegram.deleteMessage(l.chat_id, l.counter_msg_id).catch(() => {});
            const msgKey = String(l.counter_msg_id);
            if (d.dmNachrichten && d.dmNachrichten[msgKey]) {
                for (const [uid2, dmMsgId] of Object.entries(d.dmNachrichten[msgKey])) {
                    bot.telegram.deleteMessage(Number(uid2), dmMsgId).catch(() => {});
                }
                delete d.dmNachrichten[msgKey];
            }
            const linkUrlToRemove = linkUrl(l.text);
            if (linkUrlToRemove) {
                const idx = d.gepostet.indexOf(linkUrlToRemove);
                if (idx !== -1) d.gepostet.splice(idx, 1);
            }
            delete d.links[k];
        }
    }

    // _lastEvents bereinigen (nur heutigen Tag behalten)
    const heuteStr = jetzt.toDateString();
    for (const key of Object.keys(d._lastEvents)) {
        if (!key.endsWith(heuteStr)) delete d._lastEvents[key];
    }

    } catch(e) { console.log('ZeitCheck Fehler:', e.message); }
}

setInterval(zeitCheck, 60000);

// ================================
// GLOBALER ERROR HANDLER
// ================================
process.on('unhandledRejection', (reason) => {
    console.log('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (error) => {
    console.log('Uncaught Exception:', error.message);
});

// ================================
// START
// ================================
bot.launch().then(() => console.log('🤖 Bot läuft!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

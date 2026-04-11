import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';

const BOT_TOKEN = "8406939789:AAHDq3RHOf-nAaUVCL4ZeMduB_KYiBD0i7M"
const DATA_FILE = '/data/daten.json';
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
    warteNachricht: {},  // { uid: { chatId, msgId } } - Aufforderungs-Nachricht
    dmNachrichten: {},   // { uid: { msgId: dmMessageId } } - DM Nachrichten zum abhaken
    // MISSIONEN
    missionen: {},      // { uid: { date: 'heute', likesGegeben: 0, m1: false, m2: false, m3: false } }
    wochenMissionen: {}, // { uid: { m1Tage: 0, m2Tage: 0, m3Tage: 0, letzterTag: null } }
    // MISSIONS QUEUE: Missionen die um 12:00 des nächsten Tages verarbeitet werden sollen
    missionQueue: {},   // { uid: { date: 'gestern', likesGegeben: 0, m1Pending: bool, m2Pending: bool, m3Pending: bool } }
    missionQueueVerarbeitet: null, // Datum wann Queue zuletzt verarbeitet wurde
    // GESTERN daily ranking für 06:00 posting
    gesternDailyXP: {}, // wird um 23:55 gespeichert bevor reset
};

function laden() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const geladen = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            d = Object.assign({}, d, geladen);
            for (const uid in d.users) { d.users[uid].started = true; }
            for (const k of Object.keys(d.links)) {
                const link = d.links[k];
                link.likes = new Set(link.likes || []);
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
            console.log('Daten geladen');
        }
    } catch (e) { console.log('Ladefehler:', e.message); }
}

function speichern() {
    try {
        const s = Object.assign({}, d);
        s.links = {};
        for (const [k, v] of Object.entries(d.links)) {
            s.links[k] = Object.assign({}, v, { likes: Array.from(v.likes) });
        }
        fs.writeFileSync(DATA_FILE, JSON.stringify(s, null, 2));
    } catch (e) { console.log('Speicherfehler:', e.message); }
}

setInterval(speichern, 30000);
laden();

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

// ================================
// HILFSFUNKTIONEN
// ================================
function level(xp) { return Math.floor(xp / 100) + 1; }

function xpAdd(uid, menge, name) {
    const u = user(uid, name);
    u.xp += menge;
    u.level = level(u.xp);
    u.role = badge(u.xp);
    // NUR Gesamt XP und Weekly XP — kein dailyXP mehr für Missionen
    if (!d.weeklyXP[uid]) d.weeklyXP[uid] = 0;
    d.weeklyXP[uid] += menge;
}

// xpAdd für normale Aktionen (Links posten, Likes geben) — diese dürfen dailyXP nutzen
function xpAddMitDaily(uid, menge, name) {
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

// Missionen werden NUR noch in die Queue geschrieben — XP gibt es erst um 12:00 nächsten Tag
async function checkMissionen(uid, name) {
    const heute = new Date().toDateString();
    const mission = getMission(uid);

    // Heutige Links zählen
    const heutigeLinks = Object.values(d.links).filter(l => {
        return new Date(l.timestamp).toDateString() === heute;
    });
    const gesamtLinksHeute = heutigeLinks.length;
    const gelikedVonUser = heutigeLinks.filter(l => l.likes.has(Number(uid))).length;

    // Queue initialisieren
    if (!d.missionQueue[uid]) {
        d.missionQueue[uid] = { date: heute, m1Pending: false, m2Pending: false, m3Pending: false };
    }
    // Wenn neuer Tag, Queue zurücksetzen
    if (d.missionQueue[uid].date !== heute) {
        d.missionQueue[uid] = { date: heute, m1Pending: false, m2Pending: false, m3Pending: false };
    }

    // Missionen in Queue einschreiben (noch keine XP!)
    if (!mission.m1 && mission.likesGegeben >= 5) {
        mission.m1 = true;
        d.missionQueue[uid].m1Pending = true;
    }
    if (!mission.m2 && gesamtLinksHeute > 0 && gelikedVonUser / gesamtLinksHeute >= 0.8) {
        mission.m2 = true;
        d.missionQueue[uid].m2Pending = true;
    }
    if (!mission.m3 && gesamtLinksHeute > 0 && gelikedVonUser === gesamtLinksHeute) {
        mission.m3 = true;
        d.missionQueue[uid].m3Pending = true;
    }

    // Nur Info-DM senden (noch keine XP — Hinweis auf 12:00 Auswertung)
    let infoMeldungen = [];
    if (d.missionQueue[uid].m1Pending && mission.m1) infoMeldungen.push('✅ *Mission 1* — 5 Links geliked');
    if (d.missionQueue[uid].m2Pending && mission.m2) infoMeldungen.push('✅ *Mission 2* — 80% der Links geliked');
    if (d.missionQueue[uid].m3Pending && mission.m3) infoMeldungen.push('✅ *Mission 3* — Alle Links geliked');

    if (infoMeldungen.length > 0) {
        try {
            await bot.telegram.sendMessage(Number(uid),
                '🎯 *Missions Update!*\n\n' + infoMeldungen.join('\n') +
                '\n\n⏳ *XP werden morgen um 12:00 Uhr vergeben!*\n_Missionen schließen um 12:00 Uhr — du hast bis dahin Zeit alle Links zu liken._',
                { parse_mode: 'Markdown' }
            );
        } catch (e) {}
    }

    speichern();
}

// ================================
// MISSIONS AUSWERTUNG UM 12:00 (nächster Tag)
// ================================
async function missionenAuswerten() {
    const heute = new Date().toDateString();

    // Nur einmal pro Tag auswerten
    if (d.missionQueueVerarbeitet === heute) return;
    d.missionQueueVerarbeitet = heute;

    for (const [uid, queue] of Object.entries(d.missionQueue)) {
        // Nur Queues vom Vortag verarbeiten
        if (queue.date === heute) continue;

        const name = d.users[uid] ? d.users[uid].name : '';
        const wMission = getWochenMission(uid);
        const gestern = queue.date;
        let meldungen = [];

        if (queue.m1Pending) {
            // XP für Mission 1 → NUR Weekly + Gesamt
            xpAdd(uid, 5, name);
            meldungen.push('✅ *Mission 1 abgeschlossen!*\n5 Links geliked → +5 XP');
            // Wochenmission 1
            if (wMission.letzterTag !== gestern) {
                wMission.m1Tage++;
                if (wMission.m1Tage >= 7) {
                    xpAdd(uid, 10, name);
                    meldungen.push('🏆 *Wochen-Mission 1!*\n7 Tage 5+ Links geliked → +10 XP');
                    wMission.m1Tage = 0;
                }
            }
        }

        if (queue.m2Pending) {
            xpAdd(uid, 5, name);
            meldungen.push('✅ *Mission 2 abgeschlossen!*\n80% der Links geliked → +5 XP');
            if (wMission.letzterTag !== gestern) {
                wMission.m2Tage++;
                if (wMission.m2Tage >= 7) {
                    xpAdd(uid, 15, name);
                    meldungen.push('🏆 *Wochen-Mission 2!*\n7 Tage 80% geliked → +15 XP');
                    wMission.m2Tage = 0;
                }
            }
        }

        if (queue.m3Pending) {
            xpAdd(uid, 5, name);
            meldungen.push('✅ *Mission 3 abgeschlossen!*\nAlle Links geliked → +5 XP');
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

        // XP DM an User senden
        if (meldungen.length > 0 && d.users[uid]) {
            const u = d.users[uid];
            try {
                await bot.telegram.sendMessage(Number(uid),
                    '🎯 *Missions Auswertung vom Vortag!*\n\n' +
                    meldungen.join('\n\n') +
                    '\n\n⭐ Gesamt XP: ' + u.xp,
                    { parse_mode: 'Markdown' }
                );
            } catch (e) {}
        }

        // Queue für diesen User leeren
        delete d.missionQueue[uid];
    }

    speichern();
}

// ================================
// WEEKLY RANKING DM UM 12:01
// ================================
async function weeklyRankingDM() {
    const sorted = Object.entries(d.weeklyXP)
        .filter(([uid]) => d.users[uid])
        .sort((a, b) => b[1] - a[1]);

    if (!sorted.length) return;

    const badges = ['🥇', '🥈', '🥉'];

    for (const [uid] of Object.entries(d.users)) {
        if (!d.users[uid].started) continue;

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
    if (ctx.chat && ctx.from) {
        chat(ctx.chat.id, ctx.chat);
        const u = user(ctx.from.id, ctx.from.first_name);
        if (ctx.from.username) u.username = ctx.from.username;
        if (!u.chats.includes(ctx.chat.id)) u.chats.push(ctx.chat.id);
    }
    return next();
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
        '🎯 *Tägliche Missionen:*\n• M1: 5 Links liken → +5 XP\n• M2: 80% aller Links liken → +5 XP\n• M3: Alle Links liken → +5 XP\n• ⏳ XP werden täglich um 12:00 Uhr vergeben!\n\n' +
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
    text += '📅 *Täglich (XP Vergabe um 12:00 Uhr):*\n';
    text += (mission.m1 ? '✅' : '⬜') + ' M1: ' + mission.likesGegeben + '/5 Links geliked\n';
    text += (mission.m2 ? '✅' : '⬜') + ' M2: ' + prozent + '% der Links geliked (Ziel: 80%)\n';
    text += (mission.m3 ? '✅' : '⬜') + ' M3: ' + geliked + '/' + gesamtLinks + ' alle Links geliked\n\n';

    if (queue && queue.date === heute) {
        text += '⏳ *Ausstehende XP (werden um 12:00 vergeben):*\n';
        if (queue.m1Pending) text += '• M1: +5 XP\n';
        if (queue.m2Pending) text += '• M2: +5 XP\n';
        if (queue.m3Pending) text += '• M3: +5 XP\n';
        text += '\n';
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
        '👤 *Profil von ' + u.name + '*\n' +
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
    const sorted = Object.entries(d.users).sort((a, b) => b[1].xp - a[1].xp).slice(0, 10);
    if (!sorted.length) return ctx.reply('Noch keine Daten.');
    const badges = ['🥇', '🥈', '🥉'];
    let text = '🏆 *GESAMT RANKING*\n_(Permanent)_\n\n';
    sorted.forEach(([, u], i) => {
        text += (badges[i] || (i + 1) + '.') + ' *' + u.name + '*\n';
        text += '   ' + u.role + ' | ⭐' + u.xp + ' | Lvl ' + u.level + '\n\n';
    });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ================================
// /dailyranking
// ================================
bot.command('dailyranking', async (ctx) => {
    const sorted = Object.entries(d.dailyXP).filter(([uid]) => d.users[uid]).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return ctx.reply('Heute noch keine XP gesammelt.');
    const badges = ['🥇', '🥈', '🥉'];
    let text = '📅 *TAGES RANKING*\n\n';
    sorted.forEach(([uid, xp], i) => {
        const u = d.users[uid];
        text += (badges[i] || (i + 1) + '.') + ' *' + u.name + '*\n';
        text += '   ⭐ ' + xp + ' XP heute\n\n';
    });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ================================
// /weeklyranking
// ================================
bot.command('weeklyranking', async (ctx) => {
    const sorted = Object.entries(d.weeklyXP).filter(([uid]) => d.users[uid]).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return ctx.reply('Diese Woche noch keine XP.');
    const badges = ['🥇', '🥈', '🥉'];
    let text = '📆 *WOCHEN RANKING*\n\n';
    sorted.forEach(([uid, xp], i) => {
        const u = d.users[uid];
        text += (badges[i] || (i + 1) + '.') + ' *' + u.name + '*\n';
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
// /dashboard - Admin Dashboard
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

    const badges = ['1.', '2.', '3.'];
    let t1 = 'ADMIN DASHBOARD\n';
    t1 += new Date().toLocaleString('de-DE') + '\n\n';
    t1 += 'USER UBERSICHT\n';
    t1 += 'Gesamt User: ' + alleUser.length + '\n';
    t1 += 'Bot gestartet: ' + gestarteteUser.length + '\n';
    t1 += 'Aktiv heute: ' + aktiveHeute.length + '\n';
    t1 += 'Nicht geliked: ' + nichtGeliked.length + '\n';
    t1 += 'Mit Warns: ' + mitWarns.length + '\n\n';
    t1 += 'LINKS HEUTE\n';
    t1 += 'Links heute: ' + gesamtLinksHeute + '\n';
    t1 += 'Gesamt Likes: ' + gesamtLikes + '\n';
    t1 += 'Like Rate: ' + likeRate + '%\n\n';
    t1 += 'MISSIONEN HEUTE\n';
    t1 += 'M1 (5 Likes): ' + m1Heute + ' User\n';
    t1 += 'M2 (80%): ' + m2Heute + ' User\n';
    t1 += 'M3 (Alle): ' + m3Heute + ' User\n\n';
    t1 += 'BADGES\n';
    t1 += 'New: ' + badgeCount['New'] + '\n';
    t1 += 'Anfanger: ' + badgeCount['Anfanger'] + '\n';
    t1 += 'Aufsteiger: ' + badgeCount['Aufsteiger'] + '\n';
    t1 += 'Erfahrener: ' + badgeCount['Erfahrener'] + '\n\n';
    t1 += 'TOP 3 HEUTE\n';
    top3.forEach(([uid, xp], i) => { t1 += badges[i] + ' ' + d.users[uid].name + ': ' + xp + ' XP\n'; });

    await ctx.telegram.sendMessage(ctx.from.id, t1);

    const sortedUsers = alleUser.sort((a, b) => b[1].xp - a[1].xp);
    let t2 = 'ALLE USER DETAILS\n\n';

    for (const [uid, u] of sortedUsers) {
        const mission = d.missionen[uid] && d.missionen[uid].date === heute ? d.missionen[uid] : null;
        const hatGelikedH = habenGeliked.has(Number(uid));
        const hatLinkH = d.tracker[uid] === heute;
        t2 += u.name + (u.username ? ' @' + u.username : '') + '\n';
        t2 += '  Badge: ' + u.role + ' | XP: ' + u.xp + '\n';
        t2 += '  Heute XP: ' + (d.dailyXP[uid] || 0) + '\n';
        t2 += '  Geliked: ' + (hatGelikedH ? 'Ja' : 'Nein') + '\n';
        t2 += '  Link: ' + (hatLinkH ? 'Ja' : 'Nein') + '\n';
        t2 += '  Warns: ' + u.warnings + '/5\n';
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
// /dm - Broadcast an alle User
// ================================
bot.command('dm', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const nachricht = ctx.message.text.replace('/dm', '').trim();
    if (!nachricht) return ctx.reply('❌ Benutzung: /dm Deine Nachricht hier');

    let gesendet = 0;
    let fehler = 0;
    await ctx.reply('📨 Sende Nachricht an alle User...');

    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started) continue;
        try {
            await bot.telegram.sendMessage(Number(uid),
                '📢 *Nachricht vom Admin:*\n\n' + nachricht,
                { parse_mode: 'Markdown' }
            );
            gesendet++;
            await new Promise(r => setTimeout(r, 100));
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
    await ctx.reply('✅ +50 XP! Gesamt: ' + d.users[ctx.from.id].xp);
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
    speichern();
    await ctx.reply('✅ Daily/Weekly/Missionen Reset! Permanente XP bleiben.');
});

bot.command('testregeln', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    await ctx.reply('📜 *Regeln*\n\n1️⃣ 1 Link pro Tag\n2️⃣ Keine Duplikate\n3️⃣ Bot starten Pflicht\n4️⃣ 5 Warns = Ban\n5️⃣ Respekt', { parse_mode: 'Markdown' });
});

bot.command('testsieger', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    const s = Object.values(d.users).sort((a, b) => b.xp - a.xp);
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
    await ctx.reply('✅ Reward: Platz 1 bekommt Link-Repost.');
});

bot.command('testdailyranking', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    await dailyRankingAbschluss();
    await ctx.reply('✅ Daily Ranking Abschluss getestet!');
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
    d.missionQueueVerarbeitet = null; // Reset damit es nochmal läuft
    await missionenAuswerten();
    await ctx.reply('✅ Missions Auswertung getestet!');
});

bot.command('testweeklyranking', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    await weeklyRankingDM();
    await ctx.reply('✅ Weekly Ranking DM gesendet!');
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
    await ctx.reply(
        '📢 *Wichtige Bot-Updates!*\n\n' +
        '1️⃣ Text-Weiterleitung aktiv\n' +
        '2️⃣ XP wird dauerhaft gespeichert\n' +
        '3️⃣ 3 XP Systeme: Permanent, Daily, Weekly\n' +
        '4️⃣ Tägliche & Wöchentliche Missionen\n' +
        '5️⃣ Badge System mit Belohnungen\n' +
        '6️⃣ Wöchentliches Gewinnspiel\n\n' +
        '✅ Viel Spaß!',
        { parse_mode: 'Markdown' }
    );
});
bot.command('time', (ctx) => {
    const now = new Date();
    ctx.reply("🕒 Serverzeit:\n" + now.toString());
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

    const admin = await istAdmin(ctx, uid);
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

    const url = linkUrl(text);
    if (url && d.gepostet.includes(url)) {
        if (!admin) {
            try { await ctx.deleteMessage(); } catch (e) {}
            u.warnings++;
            if (u.warnings >= 5) {
                try { await ctx.telegram.banChatMember(ctx.chat.id, uid); } catch (e) {}
                await ctx.reply('🔨 *' + ctx.from.first_name + '* gebannt!', { parse_mode: 'Markdown' });
            } else {
                await ctx.reply('❌ Duplikat!\n⚠️ Warn ' + u.warnings + '/5');
            }
            speichern();
            return;
        }
    }
    if (url) d.gepostet.push(url);

    if (!d.counter[uid]) d.counter[uid] = 0;
    const heute = new Date().toDateString();

    const badgeBonus = badgeBonusLinks(u.xp);

    if (!admin && d.tracker[uid] === heute) {
        if (hatBonusLink(uid)) {
            bonusLinkNutzen(uid);
            await ctx.reply('🎁 *Bonus Link genutzt!*', { parse_mode: 'Markdown' });
        } else if (badgeBonus > 0 && (!d.badgeTracker || !d.badgeTracker[uid] || d.badgeTracker[uid] !== heute)) {
            if (!d.badgeTracker) d.badgeTracker = {};
            d.badgeTracker[uid] = heute;
            await ctx.reply('🏅 *Erfahrener Badge Extra Link genutzt!*', { parse_mode: 'Markdown' });
        } else {
            try { await ctx.deleteMessage(); } catch (e) {}
            d.counter[uid]++;
            u.warnings++;
            if (u.warnings >= 5) {
                try { await ctx.telegram.banChatMember(ctx.chat.id, uid); } catch (e) {}
                await ctx.reply('🔨 *' + ctx.from.first_name + '* gebannt!', { parse_mode: 'Markdown' });
            } else {
                await ctx.reply('❌ Nur 1 Link pro Tag!\n🕛 Ab Mitternacht wieder möglich.\n⚠️ Warn ' + u.warnings + '/5', { parse_mode: 'Markdown' });
                if (u.started) {
                    try { await ctx.telegram.sendMessage(uid, '⚠️ Link gelöscht!\n🕛 Du kannst morgen wieder posten.'); } catch (e) {}
                }
            }
            speichern();
            return;
        }
    }

    d.tracker[uid] = heute;
    d.counter[uid] = 0;
    u.links++;
    xpAddMitDaily(uid, 1, ctx.from.first_name);
    const msgId = ctx.message.message_id;

    const istInsta = istInstagramLink(text);
    const replyOptions = {
        parse_mode: 'Markdown',
        reply_to_message_id: msgId,
    };
    if (istInsta) {
        replyOptions.reply_markup = Markup.inlineKeyboard([Markup.button.callback('👍 Like', 'like_' + msgId)]).reply_markup;
    }

    const reply = await ctx.reply(
        '🔗 *Link von ' + ctx.from.first_name + '*\n\n' +
        (istInsta ? '👍 Likes: **0**\n' : '') +
        '⭐ XP: ' + u.xp + ' | Lvl ' + u.level + '\n\n' +
        (istInsta ? '_1 Like pro User erlaubt_' : '_Kein Like Button für diesen Link_'),
        replyOptions
    );

    d.links[msgId] = {
        chat_id: ctx.chat.id, user_id: uid, user_name: ctx.from.first_name,
        text: text, likes: new Set(), counter_msg_id: reply.message_id, timestamp: Date.now()
    };

    await sendeLinkAnAlle(d.links[msgId]);
    speichern();
});

// ================================
// LIKE SYSTEM
// ================================
bot.action(/^like_(\d+)$/, async (ctx) => {
    const msgId = parseInt(ctx.match[1]);
    const uid = ctx.from.id;
    await ctx.answerCbQuery();

    if (!d.links[msgId]) return ctx.answerCbQuery('❌ Nicht mehr vorhanden.', { show_alert: true });
    const lnk = d.links[msgId];
    if (uid === lnk.user_id) return ctx.answerCbQuery('❌ Kein Self-Like!', { show_alert: true });
    if (lnk.likes.has(uid)) return ctx.answerCbQuery('❌ Bereits geliked!', { show_alert: true });

    lnk.likes.add(uid);
    const anz = lnk.likes.size;
    const poster = user(lnk.user_id, lnk.user_name);
    poster.totalLikes++;

    // Liker bekommt +5 XP (mit daily)
    xpAddMitDaily(uid, 5, ctx.from.first_name);

    const msgKey = String(lnk.counter_msg_id);
    if (d.dmNachrichten && d.dmNachrichten[msgKey] && d.dmNachrichten[msgKey][uid]) {
        try {
            await bot.telegram.editMessageText(
                uid, d.dmNachrichten[msgKey][uid], null,
                '✅ *Erledigt geliked!*\n\n📢 Link von *' + lnk.user_name + '*\n🔗 ' + lnk.text + '\n\n✅ Du hast diesen Link bereits geliked!',
                { parse_mode: 'Markdown' }
            );
        } catch (e) {}
    }

    const mission = getMission(uid);
    mission.likesGegeben++;
    await checkMissionen(uid, ctx.from.first_name);

    const feedbackMsg = await ctx.reply('🎉 +5 XP erhalten!\nDanke für deine Unterstützung 💪');
    setTimeout(async () => { try { await ctx.telegram.deleteMessage(ctx.chat.id, feedbackMsg.message_id); } catch (e) {} }, 5000);

    await ctx.answerCbQuery('👍 ' + anz + ' Likes!');

    try {
        await ctx.telegram.editMessageText(
            lnk.chat_id, lnk.counter_msg_id, null,
            '🔗 *Link von ' + lnk.user_name + '*\n\n👍 Likes: **+' + anz + '**\n⭐ XP: ' + poster.xp + ' | Lvl ' + poster.level + '\n\n_1 Like pro User erlaubt_',
            { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard([Markup.button.callback('👍 Like', 'like_' + msgId)]).reply_markup }
        );
    } catch (e) {}

    speichern();
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

async function sendeLinkAnAlle(linkData) {
    if (!d.dmNachrichten) d.dmNachrichten = {};
    const msgKey = String(linkData.counter_msg_id);
    if (!d.dmNachrichten[msgKey]) d.dmNachrichten[msgKey] = {};

    for (const [uid, u] of Object.entries(d.users)) {
        if (parseInt(uid) === linkData.user_id) continue;
        if (!u.started) continue;
        try {
            const sent = await bot.telegram.sendMessage(uid,
                '📢 Neuer Booster-Link\n\n👤 Member: ' + linkData.user_name + '\n\n🔗 ' + linkData.text + '\n\nBitte liken und kommentieren! 👍',
                { reply_markup: { inline_keyboard: [[{ text: '👉 Zum Beitrag', url: 'https://t.me/c/' + String(linkData.chat_id).replace('-100', '') + '/' + linkData.counter_msg_id }]] } }
            );
            d.dmNachrichten[msgKey][uid] = sent.message_id;
        } catch (e) { console.log('FEHLER:', uid, e.message); }
    }
    speichern();
}

// ================================
// DAILY RANKING ABSCHLUSS
// ================================
async function dailyRankingAbschluss() {
    const gruppen = Object.values(d.chats).filter(c => istGruppe(c.type));
    const sorted = Object.entries(d.dailyXP).filter(([uid]) => d.users[uid] && d.dailyXP[uid] > 0).sort((a, b) => b[1] - a[1]);
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
        rankText += bel.text + ': *' + u.name + '*\n   ⭐ ' + xp + ' XP heute | +' + bel.xp + ' Bonus XP' + (bel.links > 0 ? ' + 1 Extra Link!' : '') + '\n\n';
        try {
            await bot.telegram.sendMessage(Number(uid), '🎉 *' + bel.text + ' im Tages-Ranking!*\n\n🎁 +' + bel.xp + ' XP' + (bel.links > 0 ? '\n🔗 1 Extra Link für morgen!' : ''), { parse_mode: 'Markdown' });
        } catch (e) {}
    }

    // Gestern Daily XP speichern vor Reset (für 06:00 Posting)
    d.gesternDailyXP = Object.assign({}, d.dailyXP);

    gruppen.forEach(g => { bot.telegram.sendMessage(g.id, rankText, { parse_mode: 'Markdown' }).catch(() => {}); });
    d.dailyXP = {};
    d.dailyReset = Date.now();
    speichern();
}

// ================================
// DAILY RANKING VORTAG UM 06:00 IN GRUPPE POSTEN
// ================================
async function gesternRankingPosten() {
    const gruppen = Object.values(d.chats).filter(c => istGruppe(c.type));
    const sorted = Object.entries(d.gesternDailyXP)
        .filter(([uid]) => d.users[uid] && d.gesternDailyXP[uid] > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    if (!sorted.length) return;

    const badges = ['🥇', '🥈', '🥉'];
    const sieger = sorted[0] ? d.users[sorted[0][0]] : null;

    let text = '🌅 *TAGES RANKING — VORTAG*\n\n';

    if (sieger) {
        text += '🎉 Herzlichen Glückwunsch an *' + sieger.name + '*!\n';
        text += '👑 Du warst gestern der aktivste Member!\n\n';
    }

    sorted.forEach(([uid, xp], i) => {
        const u = d.users[uid];
        text += (badges[i] || (i + 1) + '.') + ' *' + u.name + '*\n';
        text += '   ⭐ ' + xp + ' XP gestern\n\n';
    });

    text += '🔥 Macht heute weiter so!';

    gruppen.forEach(g => {
        bot.telegram.sendMessage(g.id, text, { parse_mode: 'Markdown' }).catch(() => {});
    });
}

// ================================
// WÖCHENTLICHES GEWINNSPIEL
// ================================
async function wochenGewinnspiel() {
    const gruppen = Object.values(d.chats).filter(c => istGruppe(c.type));
    const teilnehmer = Object.entries(d.weeklyXP).filter(([uid]) => d.users[uid] && d.weeklyXP[uid] > 0).map(([uid]) => uid);
    if (!teilnehmer.length) return;

    const gewinnerUid = teilnehmer[Math.floor(Math.random() * teilnehmer.length)];
    const gewinner = d.users[gewinnerUid];
    if (!d.bonusLinks[gewinnerUid]) d.bonusLinks[gewinnerUid] = 0;
    d.bonusLinks[gewinnerUid] += 1;
    d.wochenGewinnspiel.gewinner.push({ name: gewinner.name, uid: gewinnerUid, datum: new Date().toLocaleDateString() });
    d.wochenGewinnspiel.letzteAuslosung = Date.now();

    const text = '🎰 *WÖCHENTLICHES GEWINNSPIEL*\n\n🎉 Gewinner: *' + gewinner.name + '*\n\n🎁 Gewinn: 1 Extra Link für nächste Woche!\n\n📆 Nächste Auslosung: Nächsten Sonntag';
    gruppen.forEach(g => { bot.telegram.sendMessage(g.id, text, { parse_mode: 'Markdown' }).catch(() => {}); });

    try { await bot.telegram.sendMessage(Number(gewinnerUid), '🎉 *Du hast das Gewinnspiel gewonnen!*\n\n🎁 1 Extra Link für diese Woche!', { parse_mode: 'Markdown' }); } catch (e) {}

    d.weeklyXP = {};
    d.weeklyReset = Date.now();
    speichern();
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
        const nichtGeliked = heutigeLinks.filter(([, l]) => l.user_id != uid && !l.likes.has(Number(uid)));
        if (!nichtGeliked.length) continue;

        let text = '👋 *Hallo ' + u.name + '!*\n\n⚠️ Du hast heute noch diese Links nicht geliked:\n\n';
        const buttons = [];
        for (const [msgId, l] of nichtGeliked) {
            text += '🔗 Link von *' + l.user_name + '*\n';
            buttons.push([Markup.button.url('👍 Liken - ' + l.user_name, 'https://t.me/c/' + String(l.chat_id).replace('-100', '') + '/' + msgId)]);
        }
        text += '\n⏳ *Missionen schließen um 12:00 Uhr — jetzt noch liken!*';

        try { await bot.telegram.sendMessage(Number(uid), text, { parse_mode: 'Markdown', reply_markup: Markup.inlineKeyboard(buttons).reply_markup }); } catch (e) {}
    }
}

// ================================
// ZEITGESTEUERTE EVENTS
// ================================
async function zeitCheck() {
    const jetzt = new Date();
    const h = jetzt.getHours();
    const m = jetzt.getMinutes();
    const wochentag = jetzt.getDay();

    const gruppen = Object.values(d.chats).filter(c => istGruppe(c.type));
    if (!gruppen.length) return;

    gruppen.forEach(g => {
        // Regeln um 06:00
        if (h === 6 && m === 0) {
            bot.telegram.sendMessage(g.id, '📜 *Regeln*\n\n1️⃣ 1 Link pro Tag\n2️⃣ Keine Duplikate\n3️⃣ Bot starten Pflicht\n4️⃣ 5 Warns = Ban\n5️⃣ Respekt', { parse_mode: 'Markdown' }).catch(() => {});
        }
    });

    // Daily Ranking Vortag um 06:00 in Gruppe posten
    if (h === 6 && m === 0) {
        await gesternRankingPosten();
    }

    // Missions Auswertung um 12:00 — XP für Missionen vom Vortag vergeben
    if (h === 12 && m === 0) {
        await missionenAuswerten();
    }

    // Weekly Ranking DM um 12:01
    if (h === 12 && m === 1) {
        await weeklyRankingDM();
    }

    // Trending Links um 07:05
    if (h === 7 && m === 5) {
        gruppen.forEach(g => topLinks(g.id));
    }

    // Like Erinnerung um 23:00
    if (h === 23 && m === 0) {
        await likeErinnerung();
    }

    // Daily Ranking Abschluss um 23:55
    if (h === 23 && m === 55) {
        await dailyRankingAbschluss();
    }

    // Alte Links löschen (älter als 2 Tage)
    const zweiTage = 2 * 24 * 60 * 60 * 1000;
    for (const [k, l] of Object.entries(d.links)) {
        if (Date.now() - l.timestamp > zweiTage) {
            try { await bot.telegram.deleteMessage(l.chat_id, l.counter_msg_id); } catch (e) {}
            delete d.links[k];
            if (d.dmNachrichten && d.dmNachrichten[String(l.counter_msg_id)]) {
                delete d.dmNachrichten[String(l.counter_msg_id)];
            }
        }
    }

    if (wochentag === 0 && h === 20 && m === 0) wochenGewinnspiel();
}

setInterval(zeitCheck, 60000);

// ================================
// START
// ================================
bot.launch().then(() => console.log('🤖 Bot läuft!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

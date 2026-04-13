import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';

const BOT_TOKEN = "7909817546:AAF5W5gY-sKl_SNA7Xu45QT54Pr5a5SASzs";
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
    missionAuswertungErledigt: {},  // { 'datum': true } — verhindert doppelte Auswertung
    gesternDailyXP: {},
    badgeTracker: {},               // uid → datum (Extra-Link für Erfahrener)
    m1Streak: {},                   // uid → { count: 0, letzterTag: null }
    backupDatum: null,              // Datum des letzten Backups
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
            if (!d.badgeTracker) d.badgeTracker = {};
            if (!d.m1Streak) d.m1Streak = {};
            if (!d.missionAuswertungErledigt) d.missionAuswertungErledigt = {};
            // tracker bleibt erhalten — Link-Limit überlebt Neustart
            console.log('Daten geladen');
        }
    } catch (e) { console.log('Ladefehler:', e.message); }
}

let isSaving = false;
function speichern() {
    if (isSaving) return; // Lock gegen Race Condition
    isSaving = true;
    try {
        const s = Object.assign({}, d);
        s.links = {};
        for (const [k, v] of Object.entries(d.links)) {
            s.links[k] = Object.assign({}, v, { likes: Array.from(v.likes) });
        }
        // Admin-XP nie speichern — immer 0 halten
        s.users = Object.assign({}, d.users);
        for (const uid of Object.keys(s.users)) {
            if (istAdminId(Number(uid))) {
                s.users[uid] = Object.assign({}, s.users[uid], { xp: 0, level: 1, role: '⚙️ Admin' });
            }
        }
        fs.writeFileSync(DATA_FILE, JSON.stringify(s, null, 2));
    } catch (e) { console.log('Speicherfehler:', e.message); }
    finally { isSaving = false; }
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
    if (istAdminId(uid)) return; // Admin bekommt keine XP
    const u = user(uid, name);
    u.xp += menge;
    u.level = level(u.xp);
    u.role = badge(u.xp);
    if (!d.weeklyXP[uid]) d.weeklyXP[uid] = 0;
    d.weeklyXP[uid] += menge;
}

function xpAddMitDaily(uid, menge, name) {
    if (istAdminId(uid)) return; // Admin bekommt keine XP
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
        // Admin immer auf 0 XP halten
        d.users[uid].xp = 0;
        d.users[uid].level = 1;
        d.users[uid].role = '⚙️ Admin';
    }
    return d.users[uid];
}

// Name mit Badge anzeigen (Admin bekommt ⚙️ Admin dahinter)
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
        // www entfernen, trailing slash entfernen, lowercase
        return url.toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/\/$/, '')
            .split('?')[0]; // Query-Parameter ignorieren für Duplikat-Check
    } catch (e) { return url; }
}

// XP bis zum nächsten Badge berechnen
function xpBisNaechstesBadge(xp) {
    if (xp < 50) return { ziel: '📘 Anfänger', fehlend: 50 - xp };
    if (xp < 500) return { ziel: '⬆️ Aufsteiger', fehlend: 500 - xp };
    if (xp < 1000) return { ziel: '🏅 Erfahrener', fehlend: 1000 - xp };
    return null; // Bereits max Badge
}

// Admin IDs — hier deine Telegram ID eintragen
const ADMIN_IDS = new Set([1094738615]); // deine ID

function istAdminId(uid) {
    return ADMIN_IDS.has(Number(uid));
}

// Sperrzeit: Sonntag 20:00 bis Montag 06:00
function istSperrzeit() {
    const jetzt = new Date();
    const tag = jetzt.getDay(); // 0=Sonntag, 1=Montag
    const h = jetzt.getHours();
    if (tag === 0 && h >= 20) return true;  // Sonntag ab 20:00
    if (tag === 1 && h < 6) return true;    // Montag bis 05:59
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

// checkMissionen:
// Mission 1 (5 Links geliked) → live prüfen, sofortige DM
// Mission 2 & 3 → werden erst um 12:00 Uhr ausgewertet, kein vorzeitiges Feedback
async function checkMissionen(uid, name) {
    if (istAdminId(uid)) return; // Admin nimmt nicht an Missionen teil
    const heute = new Date().toDateString();
    const mission = getMission(uid);

    // Queue initialisieren
    if (!d.missionQueue[uid]) {
        d.missionQueue[uid] = { date: heute, m1Pending: false, m2Pending: false, m3Pending: false };
    }
    if (d.missionQueue[uid].date !== heute) {
        d.missionQueue[uid] = { date: heute, m1Pending: false, m2Pending: false, m3Pending: false };
    }

    // MISSION 1: live prüfen — 5 heutige Instagram-Links geliked
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

    // Mission 2 & 3 werden NICHT live geprüft — nur um 12:00 Uhr ausgewertet
    speichern();
}

// ================================
// MISSIONS AUSWERTUNG UM 12:00
// ================================
async function missionenAuswerten() {
    const heute = new Date().toDateString();

    // Neustart-sicher: Datum + Stunde prüfen
    const jetzt12 = heute + '_12';
    if (d.missionAuswertungErledigt && d.missionAuswertungErledigt[jetzt12]) return;
    if (!d.missionAuswertungErledigt) d.missionAuswertungErledigt = {};
    d.missionAuswertungErledigt[jetzt12] = true;
    d.missionQueueVerarbeitet = heute;

    for (const [uid, queue] of Object.entries(d.missionQueue)) {
        if (istAdminId(uid)) continue; // Admin nicht in Missionen
        if (queue.date === heute) continue;

        const name = d.users[uid] ? d.users[uid].name : '';
        const wMission = getWochenMission(uid);
        const gestern = queue.date;
        let meldungen = [];

        // Gestrige Links — NUR Instagram-Links für M2 & M3
        const gestrigeLinks = Object.values(d.links).filter(l =>
            new Date(l.timestamp).toDateString() === gestern
        );
        const gestrigeInstaLinks = gestrigeLinks.filter(l =>
            istInstagramLink(l.text) && l.user_id !== Number(uid)
        );
        const gesamtGestern = gestrigeInstaLinks.length;
        const gelikedGestern = gestrigeInstaLinks.filter(l => l.likes.has(Number(uid))).length;
        const prozentGestern = gesamtGestern > 0 ? gelikedGestern / gesamtGestern : 0;
        // Für M1-Warn: min 5 fremde Instagram-Links gestern?
        const minLinksVorhanden = gestrigeInstaLinks.length >= 5;

        // Mission 1
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

        // Mission 2: erst jetzt berechnen — 80% der gestrigen Links geliked?
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

        // Mission 3: erst jetzt berechnen — alle gestrigen Links geliked?
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

        // Verwarnung wenn Link gepostet aber M1 NICHT erfüllt
        // NUR wenn gestern mindestens 5 fremde Instagram-Links vorhanden waren
        const hatGesternLink = Object.values(d.links).some(l =>
            l.user_id === Number(uid) && new Date(l.timestamp).toDateString() === gestern
        );
        const m1Erfuellt = queue.m1Pending;

        // m1Streak tracken
        if (!d.m1Streak[uid]) d.m1Streak[uid] = { count: 0, letzterTag: null };
        if (m1Erfuellt) {
            // Streak erhöhen wenn gestern auch erfüllt oder erster Tag
            const streak = d.m1Streak[uid];
            // gesternD = der Tag vor dem queue.date (also vorgestern aus heutiger Sicht)
            const gesternTs = new Date(gestern).getTime() - 86400000;
            const gesternD = new Date(gesternTs).toDateString();
            if (streak.letzterTag === gesternD || streak.count === 0) {
                streak.count++;
            } else {
                streak.count = 1; // Unterbrochen
            }
            streak.letzterTag = gestern;
            // 5 Tage Streak → 1 Warn entfernen
            if (streak.count >= 5 && d.users[uid] && d.users[uid].warnings > 0) {
                d.users[uid].warnings--;
                streak.count = 0; // Reset nach Belohnung
                try {
                    await bot.telegram.sendMessage(Number(uid),
                        '🎉 *Warn entfernt!*\n\n✅ Du hast M1 *5 Tage in Folge* erfüllt!\n⚠️ Warns: *' + d.users[uid].warnings + '/5*',
                        { parse_mode: 'Markdown' }
                    );
                } catch (e) {}
            }
        } else {
            d.m1Streak[uid].count = 0; // Streak unterbrochen
        }

        if (hatGesternLink && !m1Erfuellt && minLinksVorhanden && d.users[uid]) {
            d.users[uid].warnings = (d.users[uid].warnings || 0) + 1;
            const warnCount = d.users[uid].warnings;
            const rotMarkierung = warnCount >= 3 ? '\n🔴 *ACHTUNG: 3+ Verwarnungen — du wirst bald gebannt!*' : '';
            try {
                await bot.telegram.sendMessage(Number(uid),
                    '⚠️ *Verwarnung!*\n\n' +
                    'Du hast gestern einen Link gepostet aber *M1 nicht erfüllt* (< 5 Likes gegeben).\n\n' +
                    '📋 Fairness-Verstoß.\n' +
                    '⚠️ Verwarnung: *' + warnCount + '/5*' + rotMarkierung,
                    { parse_mode: 'Markdown' }
                );
            } catch (e) {}
            meldungen.push('⚠️ *Verwarnung für M1 nicht erfüllt!*\nLink gepostet aber < 5 Likes gegeben → Warn ' + warnCount + '/5');
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
                    '\n\n✅ *Diese XP wurden dir gutgeschrieben!*\n' +
                    '⭐ Gesamt XP: *' + u.xp + '*' + badgeHinweis,
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

    // missionAuswertungErledigt bereinigen — nur heutigen Eintrag behalten
    const nurHeute = {};
    if (d.missionAuswertungErledigt[jetzt12]) nurHeute[jetzt12] = true;
    d.missionAuswertungErledigt = nurHeute;

    // m1Streak bereinigen — nach Belohnung (count=0) löschen
    for (const uid of Object.keys(d.m1Streak)) {
        if (d.m1Streak[uid].count === 0 && !d.users[uid]) {
            delete d.m1Streak[uid];
        }
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
        if (istAdminId(uid)) continue; // Admin nicht im Ranking

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
        // Admin-Role immer sofort setzen
        if (istAdminId(ctx.from.id)) {
            u.xp = 0;
            u.level = 1;
            u.role = '⚙️ Admin';
        }
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
        text += '⏳ *Ausstehende XP (werden um 12:00 vergeben):*\n';
        text += '• M1: +5 XP\n\n';
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
            await new Promise(r => setTimeout(r, 200)); // Rate limit 200ms
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
    // Für Test: Queue-Datum auf gestern setzen damit Auswertung greift
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
    await ctx.reply('⚠️ Verwarnung an *' + u.name + '* gegeben.\n⚠️ Warns: *' + u.warnings + '/5*' + rotMarkierung, { parse_mode: 'Markdown' });
    try {
        await bot.telegram.sendMessage(userId,
            '⚠️ *Du hast eine Verwarnung erhalten!*\n\n📋 Grund: Admin-Entscheidung\n⚠️ Warns: *' + u.warnings + '/5*' + rotMarkierung,
            { parse_mode: 'Markdown' }
        );
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

    // Sperrzeit: Sonntag 20:00 bis Montag 06:00 — keine Links erlaubt
    if (istSperrzeit() && !admin) {
        try { await ctx.deleteMessage(); } catch (e) {}
        const sperrMsg = await ctx.reply(
            '🚫 *Keine Links erlaubt!*\n\n' +
            '📅 Von *Sonntag 20:00* bis *Montag 06:00* sind keine Links erlaubt.\n\n' +
            '⏳ Grund: Auswertung & Prüfung der Vorwoche läuft.\n' +
            '✅ Ab Montag 06:00 Uhr kannst du wieder posten!',
            { parse_mode: 'Markdown' }
        );
        setTimeout(async () => { try { await ctx.telegram.deleteMessage(ctx.chat.id, sperrMsg.message_id); } catch (e) {} }, 20000);
        speichern();
        return;
    }

    const url = linkUrl(text);
    const urlNorm = normalisiereUrl(url);
    if (url && d.gepostet.some(u => normalisiereUrl(u) === urlNorm)) {
        if (!admin) {
            try { await ctx.deleteMessage(); } catch (e) {}
            // Keine Verwarnung — nur Warnnachricht (10 Sek) + DM
            const warnMsg = await ctx.reply('❌ *Duplikat!* Dieser Link wurde bereits gepostet.\n🗑️ Link gelöscht.', { parse_mode: 'Markdown' });
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
            if (d.gepostet.length > 2000) d.gepostet.shift(); // Max 2000 URLs
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
            // Keine Verwarnung — nur Warnnachricht (10 Sek) + DM
            if (u.warnings >= 5) {
                try { await ctx.telegram.banChatMember(ctx.chat.id, uid); } catch (e) {}
                await ctx.reply('🔨 *' + ctx.from.first_name + '* gebannt! (5 Warns erreicht)', { parse_mode: 'Markdown' });
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
    xpAddMitDaily(uid, 1, ctx.from.first_name);
    const msgId = ctx.message.message_id;
    const istInsta = istInstagramLink(text);

    if (istInsta) {
        // msgId vor dem Löschen sichern
        const origMsgId = ctx.message.message_id;
        const chatId = ctx.chat.id;

        // Originale User-Nachricht löschen
        try { await ctx.deleteMessage(); } catch (e) {}

        // Bot repostet direkt im Chat (NICHT ctx.reply — die originale ist gelöscht)
        // u.role neu laden damit Admin-Badge sicher stimmt
        const u2 = user(uid, ctx.from.first_name);
        const posterName = istAdminId(uid) ? '⚙️ Admin ' + ctx.from.first_name : u2.role + ' ' + ctx.from.first_name;
        const posterStats = istAdminId(uid) ? '' : ' | ⭐ ' + u2.xp + ' XP | Lvl ' + u2.level;

        let botMsg;
        try {
            botMsg = await bot.telegram.sendMessage(
                chatId,
                '*' + posterName + '*\n' +
                '🔗 ' + text + '\n\n' +
                '👍 *0 Likes*' + posterStats,
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        [Markup.button.callback('👍 Like  |  0', 'like_' + origMsgId)]
                    ]).reply_markup
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

        // 10-Sek Erinnerung — nur für normale User (nicht Admin)
        if (!istAdminId(uid)) {
            try {
                const erinnerungMsg = await bot.telegram.sendMessage(
                    chatId,
                    '🎯 *' + posterName + '*\n' +
                    '⭐ ' + u.xp + ' XP | Lvl ' + u.level + '\n\n' +
                    '⚠️ Mindestens *5 Links* liken (M1) — sonst droht Verwarnung!',
                    { parse_mode: 'Markdown', reply_to_message_id: botMsg.message_id }
                );
                setTimeout(async () => { try { await bot.telegram.deleteMessage(chatId, erinnerungMsg.message_id); } catch (e) {} }, 10000);
            } catch (e) {}
        }

        // Links Limit: max 500 gleichzeitig
    const linkKeys = Object.keys(d.links);
    if (linkKeys.length > 500) {
        const oldest = linkKeys.sort((a, b) => d.links[a].timestamp - d.links[b].timestamp)[0];
        delete d.links[oldest];
    }
    await sendeLinkAnAlle(d.links[origMsgId]);
    } else {
        // Nicht-Instagram-Link: nur tracken, kein Bot-Reply
        d.links[msgId] = {
            chat_id: ctx.chat.id, user_id: uid, user_name: ctx.from.first_name,
            text: text, likes: new Set(), counter_msg_id: msgId, timestamp: Date.now()
        };
    }

    speichern();
});

// ================================
// LIKE SYSTEM
// ================================
bot.action(/^like_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery(); // MUSS erste Zeile sein — Telegram Timeout vermeiden
    const msgId = parseInt(ctx.match[1]);
    const uid = ctx.from.id;

    if (!d.links[msgId]) return ctx.answerCbQuery('❌ Nicht mehr vorhanden.', { show_alert: true });
    const lnk = d.links[msgId];
    if (uid === lnk.user_id) return ctx.answerCbQuery('❌ Kein Self-Like!', { show_alert: true });
    if (lnk.likes.has(uid)) return ctx.answerCbQuery('❌ Bereits geliked!', { show_alert: true });

    lnk.likes.add(uid);
    const anz = lnk.likes.size;
    const poster = user(lnk.user_id, lnk.user_name);
    if (!istAdminId(lnk.user_id)) poster.totalLikes++;

    // Nur Links von HEUTE zählen fürs Daily Ranking
    // Links vom Vortag geben nur Gesamt/Weekly XP (für Missionen)
    const linkDatum = new Date(lnk.timestamp).toDateString();
    const heuteDatum = new Date().toDateString();
    const istHeutigerLink = linkDatum === heuteDatum;

    if (!istAdminId(uid)) {
        if (istHeutigerLink) {
            xpAddMitDaily(uid, 5, ctx.from.first_name);
        } else {
            xpAdd(uid, 5, ctx.from.first_name);
        }
    }

    const msgKey = String(lnk.counter_msg_id);
    // DM nach Like LÖSCHEN (nicht nur editieren)
    if (d.dmNachrichten && d.dmNachrichten[msgKey] && d.dmNachrichten[msgKey][uid]) {
        try {
            await bot.telegram.deleteMessage(uid, d.dmNachrichten[msgKey][uid]);
            delete d.dmNachrichten[msgKey][uid];
        } catch (e) {}
    }

    const mission = getMission(uid);
    // Nur heutige Instagram-Links zählen für M1 von heute
    if (istHeutigerLink && istInstagramLink(lnk.text)) {
        mission.likesGegeben++;
    }
    await checkMissionen(uid, ctx.from.first_name);

    // XP bis nächstes Badge berechnen
    const liker = user(uid, ctx.from.first_name);
    const naechstesBadge = xpBisNaechstesBadge(liker.xp);
    const badgeInfo = naechstesBadge
        ? '\n⬆️ Noch *' + naechstesBadge.fehlend + ' XP* bis ' + naechstesBadge.ziel
        : '\n🏅 Maximales Badge erreicht!';

    const feedbackText = istAdminId(uid)
        ? '✅ *Like registriert!* _(Admin — keine XP)_'
        : istHeutigerLink
            ? '🎉 *+5 XP erhalten!*\n' + liker.role + ' | ⭐ ' + liker.xp + ' XP' + badgeInfo
            : '🎉 *+5 XP erhalten!* _(nur Weekly)_\n' + liker.role + ' | ⭐ ' + liker.xp + ' XP' + badgeInfo + '\n📅 _Gestriger Link — nicht im Daily_';

    const feedbackMsg = await ctx.reply(feedbackText, { parse_mode: 'Markdown' });
    setTimeout(async () => { try { await ctx.telegram.deleteMessage(ctx.chat.id, feedbackMsg.message_id); } catch (e) {} }, 10000);

    await ctx.answerCbQuery('👍 ' + anz + ' Likes!');

    try {
        await ctx.telegram.editMessageText(
            lnk.chat_id, lnk.counter_msg_id, null,
            (istAdminId(lnk.user_id) ? '⚙️ Admin ' + lnk.user_name : poster.role + ' ' + lnk.user_name) + '\n' +
            '🔗 ' + lnk.text + '\n\n' +
            '👍 *' + anz + ' Likes*' + (istAdminId(lnk.user_id) ? '' : ' | ⭐ ' + poster.xp + ' XP | Lvl ' + poster.level),
            {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    [Markup.button.callback('👍 Like  |  ' + anz, 'like_' + msgId)]
                ]).reply_markup
            }
        );
    } catch (e) {}

    speichern();
});

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

async function sendeLinkAnAlle(linkData) {
    if (!d.dmNachrichten) d.dmNachrichten = {};
    const msgKey = String(linkData.counter_msg_id);
    if (!d.dmNachrichten[msgKey]) d.dmNachrichten[msgKey] = {};

    for (const [uid, u] of Object.entries(d.users)) {
        if (parseInt(uid) === linkData.user_id) continue;
        if (!u.started) continue;
        const sent = await sendeDM(uid,
            '📢 Neuer Booster-Link\n\n👤 Member: ' + linkData.user_name + '\n\n🔗 ' + linkData.text + '\n\nBitte liken und kommentieren! 👍',
            { reply_markup: { inline_keyboard: [[{ text: '👉 Zum Beitrag', url: 'https://t.me/c/' + String(linkData.chat_id).replace('-100', '') + '/' + linkData.counter_msg_id }]] } }
        );
        if (sent) d.dmNachrichten[msgKey][uid] = sent.message_id;
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
        rankText += bel.text + ': *' + u.name + '*\n   ⭐ ' + xp + ' XP heute | +' + bel.xp + ' Bonus XP' + (bel.links > 0 ? ' + 1 Extra Link!' : '') + '\n\n';
        try {
            await bot.telegram.sendMessage(Number(uid), '🎉 *' + bel.text + ' im Tages-Ranking!*\n\n🎁 +' + bel.xp + ' XP' + (bel.links > 0 ? '\n🔗 1 Extra Link für morgen!' : ''), { parse_mode: 'Markdown' });
        } catch (e) {}
    }

    d.gesternDailyXP = Object.assign({}, d.dailyXP);
    gruppen.forEach(g => { bot.telegram.sendMessage(g.id, rankText, { parse_mode: 'Markdown' }).catch(() => {}); });
    d.dailyXP = {};
    d.dailyReset = Date.now();
    speichern();
}

// ================================
// DAILY RANKING VORTAG UM 06:00
// ================================
async function gesternRankingPosten() {
    const gruppen = Object.values(d.chats).filter(c => istGruppe(c.type));
    const sorted = Object.entries(d.gesternDailyXP)
        .filter(([uid]) => d.users[uid] && d.gesternDailyXP[uid] > 0 && !istAdminId(uid))
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

    const text = '🎰 *WÖCHENTLICHES GEWINNSPIEL*\n\n🎉 Gewinner: *' + gewinner.name + '*\n\n🎁 Gewinn: 1 Extra Link für nächste Woche!\n\n📆 Nächste Auslosung: Nächsten Sonntag';
    gruppen.forEach(g => { bot.telegram.sendMessage(g.id, text, { parse_mode: 'Markdown' }).catch(() => {}); });

    try { await bot.telegram.sendMessage(Number(gewinnerUid), '🎉 *Du hast das Gewinnspiel gewonnen!*\n\n🎁 1 Extra Link für diese Woche!', { parse_mode: 'Markdown' }); } catch (e) {}

    d.weeklyXP = {};
    d.weeklyReset = Date.now();
    speichern();

    // Weekly Ranking DM nach Gewinnspiel senden
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
        if (istAdminId(uid)) continue; // Admin überspringen
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
// ABEND DM: User mit Link aber ohne M1 warnen
// ================================
async function abendM1Warnung() {
    const heute = new Date().toDateString();
    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started) continue;
        if (istAdminId(uid)) continue; // Admin überspringen

        // Hat heute einen Link gepostet?
        const hatHeuteLink = Object.values(d.links).some(l =>
            l.user_id === Number(uid) && new Date(l.timestamp).toDateString() === heute
        );
        if (!hatHeuteLink) continue;

        // Mindestens 5 fremde Instagram-Links vorhanden?
        const fremdeInstaLinks = Object.values(d.links).filter(l =>
            istInstagramLink(l.text) &&
            l.user_id !== Number(uid) &&
            new Date(l.timestamp).toDateString() === heute
        );
        if (fremdeInstaLinks.length < 5) continue;

        // Hat M1 schon erfüllt?
        const mission = d.missionen[uid];
        if (mission && mission.date === heute && mission.m1) continue;

        // Wie viele Likes bisher?
        const likesGegeben = mission ? mission.likesGegeben : 0;
        const fehlend = 5 - likesGegeben;

        try {
            await bot.telegram.sendMessage(Number(uid),
                '⚠️ *Erinnerung — Mindestlikes!*\n\n' +
                'Du hast heute einen Link gepostet aber erst *' + likesGegeben + '/5* Likes vergeben.\n\n' +
                '👉 Du musst noch *' + fehlend + ' Links* liken!\n' +
                '🚨 Sonst erhältst du morgen eine *Verwarnung*.\n\n' +
                '_Missionen schließen um 12:00 Uhr morgen._',
                { parse_mode: 'Markdown' }
            );
        } catch (e) {}
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

    // Tägliches Backup um 03:00
    if (h === 3 && m === 0) await backup();

    // Regeln + Vortags-Ranking um 06:00
    if (h === 6 && m === 0) {
        gruppen.forEach(g => {
            bot.telegram.sendMessage(g.id,
                '📜 *Regeln*\n\n' +
                '1️⃣ 1 Link pro Tag\n' +
                '2️⃣ Keine Duplikate\n' +
                '3️⃣ Bot starten Pflicht\n' +
                '4️⃣ 5 Warns = Ban\n' +
                '5️⃣ Respektvoller Umgang\n\n' +
                '🆕 Kommentare: mind. 2 Wörter (keine Emojis)\n\n' +
                '👍 Pflicht: Jeder Link muss geliked & kommentiert werden\n\n' +
                '🔍 Tägliche Kontrollen\n' +
                '❗ Mogeln = sofortiger Ban\n\n' +
                '👉 Vor Bestätigung prüfen: Geliked & kommentiert',
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        });
        await gesternRankingPosten();
    }

    // Missions Auswertung um 12:00
    if (h === 12 && (m === 0 || m === 1)) await missionenAuswerten();

    // Weekly Ranking DM nur beim Gewinnspiel (Sonntag 20:00) — hier entfernt



    // Abend M1 Warnung um 22:00 (für User die Link gepostet aber M1 noch nicht erfüllt)
    if (h === 22 && m === 0) await abendM1Warnung();

    // Like Erinnerung um 23:00
    if (h === 23 && m === 0) await likeErinnerung();

    // Daily Ranking Abschluss um 23:55
    if (h === 23 && (m === 55 || m === 56)) await dailyRankingAbschluss();

    // Alte Links löschen (älter als 2 Tage) + DMs löschen + URL aus gepostet entfernen
    const zweiTage = 2 * 24 * 60 * 60 * 1000;
    for (const [k, l] of Object.entries(d.links)) {
        if (Date.now() - l.timestamp > zweiTage) {
            try { await bot.telegram.deleteMessage(l.chat_id, l.counter_msg_id); } catch (e) {}
            // Alle noch offenen DMs löschen
            const msgKey = String(l.counter_msg_id);
            if (d.dmNachrichten && d.dmNachrichten[msgKey]) {
                for (const [uid, dmMsgId] of Object.entries(d.dmNachrichten[msgKey])) {
                    try { await bot.telegram.deleteMessage(Number(uid), dmMsgId); } catch (e) {}
                }
                delete d.dmNachrichten[msgKey];
            }
            // URL aus gepostet-Array entfernen
            const linkUrlToRemove = linkUrl(l.text);
            if (linkUrlToRemove) {
                const idx = d.gepostet.indexOf(linkUrlToRemove);
                if (idx !== -1) d.gepostet.splice(idx, 1);
            }
            delete d.links[k];
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

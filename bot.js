import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import express from 'express';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ BOT TOKEN FEHLT!'); process.exit(1); }

const DATA_FILE      = process.env.DATA_FILE || '/data/daten.json';
const DASHBOARD_URL  = process.env.DASHBOARD_URL || '';
const APP_URL        = process.env.APP_URL || DASHBOARD_URL || '';
const BRIDGE_SECRET  = process.env.BRIDGE_SECRET || 'geheimer-key';
const BRIDGE_BOT_URL = process.env.BRIDGE_BOT_URL || '';
const ADMIN_IDS      = new Set((process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean));
const GROUP_A_ID     = Number(process.env.GROUP_A_ID);
const GROUP_B_ID     = Number(process.env.GROUP_B_ID);
const MEINE_GRUPPE   = 'B';

process.env.TZ = 'Europe/Berlin';

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

function istAdminId(uid) { return ADMIN_IDS.has(Number(uid)); }

let d = {
    users: {}, chats: {}, links: {},
    tracker: {}, counter: {}, warte: {},
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
        const data = fs.readFileSync(DATA_FILE, 'utf-8');
        const loaded = JSON.parse(data);
        Object.assign(d, loaded);
        d.dailyXP = d.dailyXP || {};
        d.weeklyXP = d.weeklyXP || {};
        d.dailyLogins = d.dailyLogins || {};
        d.dailyGroupMsgs = d.dailyGroupMsgs || {};
        d.threadLastRead = d.threadLastRead || {};
        d.badgeTracker = d.badgeTracker || {};
        d.m1Streak = d.m1Streak || {};
    } catch (err) {
        console.error('Fehler beim Laden:', err.message);
    }
}

function speichern() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
    } catch (err) {
        console.error('Fehler beim Speichern:', err.message);
    }
}

function getBenutzer(uid) {
    if (!d.users[uid]) {
        d.users[uid] = {
            id: uid, name: 'Unknown', punkt: 0, balance: 0, lastLogin: Date.now(),
            lastDaily: 0, dailyLogins: 0, missionDailyReset: null,
            badges: [], notifications: [], settings: {}, reputation: 0,
        };
    }
    return d.users[uid];
}

function getChat(cid) {
    if (!d.chats[cid]) {
        d.chats[cid] = { id: cid, name: '', users: [], mods: [] };
    }
    return d.chats[cid];
}

function missionTitel(id) {
    const missionen = {
        m1: '🎯 Erste Schritte',
        m2: '💬 Gesprächig',
        m3: '🎁 Großzügig',
        m4: '📸 Foto-Fan',
        m5: '🏅 Seriös',
        m6: '🌟 Top-Glückspilz',
        m7: '⏳ Geduldiger',
        m8: '🎪 Entertainer',
        m9: '📱 Mobilist',
        m10: '📍 Standort-Meister',
        m11: '🎵 Musik-Freund',
        m12: '🎬 Video-Profi',
        m13: '📞 Kontakt-König',
        m14: '🔐 Sicherheits-Experte',
        m15: '🌍 Weltenbummler',
        m16: '💎 VIP-Enthusiast',
        m17: '🎮 Gaming-Profi',
        m18: '🎭 Kunstliebhaber',
        m19: '🚀 Schnellstarter',
        m20: '🏆 Champion',
    };
    return missionen[id] || id;
}

const missionen = {
    m1: { name: 'Erste Schritte', belohnung: 100, bedingung: (user) => user.punkt >= 10 },
    m2: { name: 'Gesprächig', belohnung: 150, bedingung: (user) => (d.dailyGroupMsgs[user.id] || 0) >= 5 },
    m3: { name: 'Großzügig', belohnung: 200, bedingung: (user) => user.balance >= 500 },
    m4: { name: 'Foto-Fan', belohnung: 100, bedingung: (user) => true },
    m5: { name: 'Seriös', belohnung: 150, bedingung: (user) => user.punkt >= 100 },
    m6: { name: 'Top-Glückspilz', belohnung: 250, bedingung: (user) => true },
    m7: { name: 'Geduldiger', belohnung: 120, bedingung: (user) => (Date.now() - user.lastLogin) > 86400000 },
    m8: { name: 'Entertainer', belohnung: 180, bedingung: (user) => true },
    m9: { name: 'Mobilist', belohnung: 100, bedingung: (user) => true },
    m10: { name: 'Standort-Meister', belohnung: 150, bedingung: (user) => true },
    m11: { name: 'Musik-Freund', belohnung: 100, bedingung: (user) => true },
    m12: { name: 'Video-Profi', belohnung: 200, bedingung: (user) => true },
    m13: { name: 'Kontakt-König', belohnung: 150, bedingung: (user) => true },
    m14: { name: 'Sicherheits-Experte', belohnung: 100, bedingung: (user) => true },
    m15: { name: 'Weltenbummler', belohnung: 200, bedingung: (user) => true },
    m16: { name: 'VIP-Enthusiast', belohnung: 250, bedingung: (user) => user.punkt >= 500 },
    m17: { name: 'Gaming-Profi', belohnung: 150, bedingung: (user) => true },
    m18: { name: 'Kunstliebhaber', belohnung: 100, bedingung: (user) => true },
    m19: { name: 'Schnellstarter', belohnung: 100, bedingung: (user) => true },
    m20: { name: 'Champion', belohnung: 300, bedingung: (user) => user.punkt >= 1000 },
};

function checkMissionen(user) {
    user.missionen = user.missionen || [];
    for (const [key, mission] of Object.entries(missionen)) {
        if (!user.missionen.includes(key) && mission.bedingung(user)) {
            user.missionen.push(key);
            user.balance = (user.balance || 0) + mission.belohnung;
            return { completed: key, reward: mission.belohnung };
        }
    }
    return null;
}

function getTodayString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function getWeekString() {
    const now = new Date();
    const jan4 = new Date(now.getFullYear(), 0, 4);
    const msPerDay = 24 * 60 * 60 * 1000;
    const dayDiff = (now - jan4) / msPerDay;
    const weekNum = Math.floor((dayDiff + jan4.getDay()) / 7);
    return `${now.getFullYear()}-W${String(weekNum + 1).padStart(2, '0')}`;
}

function getUserBalance(userId) {
    return d.users[userId]?.balance || 0;
}

function addUserBalance(userId, amount) {
    const user = getBenutzer(userId);
    user.balance = (user.balance || 0) + amount;
    const result = checkMissionen(user);
    speichern();
    return { newBalance: user.balance, missionResult: result };
}

function addUserPoints(userId, amount) {
    const user = getBenutzer(userId);
    user.punkt = (user.punkt || 0) + amount;
    const result = checkMissionen(user);
    speichern();
    return { newPoints: user.punkt, missionResult: result };
}

function initBridge() {
    app.post('/bridge/transferBalance', (req, res) => {
        const { secret, userId, amount } = req.body;
        if (!secret || secret !== BRIDGE_SECRET || !userId || !amount) {
            return res.status(403).json({ ok: false, error: 'Invalid secret or parameters' });
        }
        const result = addUserBalance(userId, amount);
        res.json({ ok: true, ...result });
    });
    app.post('/bridge/addPoints', (req, res) => {
        const { secret, userId, amount } = req.body;
        if (!secret || secret !== BRIDGE_SECRET || !userId || !amount) {
            return res.status(403).json({ ok: false, error: 'Invalid secret or parameters' });
        }
        const result = addUserPoints(userId, amount);
        res.json({ ok: true, ...result });
    });
    app.get('/bridge/getBalance/:userId', (req, res) => {
        const balance = getUserBalance(req.params.userId);
        res.json({ ok: true, balance });
    });
}

function formatTimestamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function initBot() {
    bot.start(async (ctx) => {
        const user = getBenutzer(ctx.from.id);
        user.name = ctx.from.first_name || 'Unknown';
        const today = getTodayString();
        if (!d.dailyLogins[today]) { d.dailyLogins[today] = []; }
        if (!d.dailyLogins[today].includes(ctx.from.id)) {
            d.dailyLogins[today].push(ctx.from.id);
            user.punkt = (user.punkt || 0) + 10;
            user.dailyLogins = (user.dailyLogins || 0) + 1;
            user.lastDaily = Date.now();
            user.lastLogin = Date.now();
        }
        speichern();
        return ctx.reply(`🌟 Willkommen ${user.name}!\n\n📊 Punkte: ${user.punkt}\n💰 Balance: ${user.balance || 0}`, Markup.inlineKeyboard([[Markup.button.url('🎮 Bot spielen', APP_URL || DASHBOARD_URL)], [Markup.button.callback('📋 Missionen', 'show_missions')], [Markup.button.callback('💎 Balance', 'show_balance')]]));
    });
    bot.action('show_missions', async (ctx) => {
        const user = getBenutzer(ctx.from.id);
        const available = Object.keys(missionen).filter((m) => !user.missionen?.includes(m) && missionen[m].bedingung(user));
        const completed = (user.missionen || []).map((m) => missionTitel(m)).join('\n');
        const text = `📋 Missionen\n\n✅ Abgeschlossen:\n${completed || 'Keine'}\n\n🔓 Verfügbar:\n${available.map((m) => `${missionTitel(m)}`).join('\n') || 'Keine'}`;
        return ctx.editMessageText(text, Markup.inlineKeyboard([[Markup.button.callback('↩️ Zurück', 'show_menu')]]))
            .catch(() => ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback('↩️ Zurück', 'show_menu')]]));
    });
    bot.action('show_balance', async (ctx) => {
        const user = getBenutzer(ctx.from.id);
        const text = `💰 Deine Balance: ${user.balance || 0}`;
        return ctx.editMessageText(text, Markup.inlineKeyboard([[Markup.button.callback('↩️ Zurück', 'show_menu')]]))
            .catch(() => ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback('↩️ Zurück', 'show_menu')]]));
    });
    bot.action('show_menu', async (ctx) => {
        const user = getBenutzer(ctx.from.id);
        const text = `🌟 Menü\n\n📊 Punkte: ${user.punkt}\n💰 Balance: ${user.balance || 0}`;
        return ctx.editMessageText(text, Markup.inlineKeyboard([[Markup.button.callback('📋 Missionen', 'show_missions')], [Markup.button.callback('💎 Balance', 'show_balance')]]))
            .catch(() => ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback('📋 Missionen', 'show_missions')], [Markup.button.callback('💎 Balance', 'show_balance')]]));
    });
    bot.on('message', async (ctx) => {
        const user = getBenutzer(ctx.from.id);
        const today = getTodayString();
        d.dailyGroupMsgs[today] = (d.dailyGroupMsgs[today] || 0) + 1;
        if (ctx.chat.type === 'supergroup' || ctx.chat.type === 'group') {
            user.punkt = (user.punkt || 0) + 1;
        }
        speichern();
    });
    bot.on('forum_topic_created', async (ctx) => {
        next();
    });
    bot.catch((err, ctx) => {
        console.error(`❌ Fehler für ${ctx.updateType}:`, err);
    });
}

function startServer() {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`🚀 Server läuft auf Port ${PORT}`);
    });
}

laden();
initBridge();
initBot();
startServer();

bot.launch().catch(console.error);

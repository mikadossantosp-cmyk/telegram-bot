import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';

const BOT_TOKEN = "7909817546:AAF5W5gY-sKl_SNA7Xu45QT54Pr5a5SASzs";
const DATA_FILE = '/workspace/data/daten.json';
const bot = new Telegraf(BOT_TOKEN);

// ================================
// DATEN
// ================================
let d = {
    users: {}, chats: {}, links: {},
    tracker: {}, counter: {}, warte: {},
    gepostet: [], seasonStart: Date.now(),
    seasonGewinner: [],
    // NEU: XP Systeme
    dailyXP: {},        // { uid: xp heute }
    weeklyXP: {},       // { uid: xp diese Woche }
    dailyReset: null,   // letzter daily reset
    weeklyReset: null,  // letzter weekly reset
    // NEU: Extra Links
    bonusLinks: {},     // { uid: anzahl bonus links }
    wochenGewinnspiel: {
        aktiv: true,
        gewinner: [],   // vergangene Gewinner
        letzteAuslosung: null
    }
};

function laden() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const geladen = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            d = Object.assign({}, d, geladen);

            for (const uid in d.users) {
                d.users[uid].started = true;
            }
            for (const k of Object.keys(d.links)) {
                const link = d.links[k];
                link.likes = new Set(link.likes || []);
                link.msgId = Number(k);
                if (!link.counter_msg_id || !link.chat_id) {
                    delete d.links[k];
                    continue;
                }
            }
            // Fehlende Felder ergänzen
            if (!d.dailyXP) d.dailyXP = {};
            if (!d.weeklyXP) d.weeklyXP = {};
            if (!d.bonusLinks) d.bonusLinks = {};
            if (!d.wochenGewinnspiel) d.wochenGewinnspiel = { aktiv: true, gewinner: [], letzteAuslosung: null };

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
// HILFSFUNKTIONEN
// ================================
function level(xp) { return Math.floor(xp / 100) + 1; }

function rolle(xp) {
    if (xp >= 500) return '👑 Elite';
    if (xp >= 200) return '💎 Pro';
    if (xp >= 50) return '🔥 Aktiv';
    return '🆕 Anfänger';
}

// XP hinzufügen - zu allen 3 Töpfen
function xpAdd(uid, menge, name) {
    const u = user(uid, name);
    // Permanenter XP Topf (wächst für immer)
    u.xp += menge;
    u.level = level(u.xp);
    u.role = rolle(u.xp);

    // Daily XP (wird täglich zurückgesetzt)
    if (!d.dailyXP[uid]) d.dailyXP[uid] = 0;
    d.dailyXP[uid] += menge;

    // Weekly XP (wird wöchentlich zurückgesetzt)
    if (!d.weeklyXP[uid]) d.weeklyXP[uid] = 0;
    d.weeklyXP[uid] += menge;
}

function user(uid, name) {
    if (!d.users[uid]) {
        d.users[uid] = {
            name: name || '', username: null, xp: 0, level: 1,
            warnings: 0, started: false, links: 0, likes: 0,
            role: '🆕 Anfänger', lastDaily: null, totalLikes: 0,
            chats: []
        };
    }
    if (name) d.users[uid].name = name;
    return d.users[uid];
}

function chat(cid, obj) {
    if (!d.chats[cid]) {
        d.chats[cid] = {
            id: cid,
            type: (obj && obj.type) || 'unknown',
            title: (obj && (obj.title || obj.first_name)) || 'Unbekannt',
            msgs: 0
        };
    }
    if (obj) {
        d.chats[cid].type = obj.type;
        d.chats[cid].title = obj.title || obj.first_name || d.chats[cid].title;
    }
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
    return t.includes('http://') || t.includes('https://') ||
           t.includes('www.') || t.includes('t.me/');
}

function linkUrl(text) {
    if (!text || typeof text !== 'string') return null;
    const t = text.trim();
    if (t.includes('http://') || t.includes('https://') || t.includes('www.') || t.includes('t.me/')) {
        return t;
    }
    return null;
}

// Bonus Link Check
function hatBonusLink(uid) {
    return d.bonusLinks[uid] && d.bonusLinks[uid] > 0;
}

function bonusLinkNutzen(uid) {
    if (hatBonusLink(uid)) {
        d.bonusLinks[uid]--;
        if (d.bonusLinks[uid] <= 0) delete d.bonusLinks[uid];
        return true;
    }
    return false;
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
    if (d.warte[uid]) delete d.warte[uid];
    speichern();
    if (istPrivat(ctx.chat.type)) {
        return ctx.reply(
            '👋 Hallo ' + ctx.from.first_name + '!\n\n' +
            '✅ Bot gestartet!\n' +
            '🎉 Du kannst jetzt Links posten!\n\n' +
            '📋 /help für alle Befehle.'
        );
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
        '🔗 *Link System:*\n' +
        '• 1 Link pro 24h\n' +
        '• Doppelte Links geblockt\n' +
        '• 👍 Likes = XP\n\n' +
        '👍 *Like System:*\n' +
        '• 1 Like pro Link\n' +
        '• Kein Self-Like\n' +
        '• +5 XP pro Like\n\n' +
        '🏆 *Ranking Systeme:*\n' +
        '• /ranking - Gesamt XP (permanent)\n' +
        '• /dailyranking - Heutiges Ranking\n' +
        '• /weeklyranking - Wöchentliches Ranking\n\n' +
        '🎰 *Gewinnspiel:*\n' +
        '• Jeden Sonntag Auslosung\n' +
        '• Gewinner: 1 Bonus Link pro Woche\n\n' +
        '⚠️ *Warn System:*\n' +
        '• 5 Verwarnungen = Ban\n\n' +
        '🎖️ *Rollen:*\n' +
        '🆕 Anfänger 0 XP\n' +
        '🔥 Aktiv 50 XP\n' +
        '💎 Pro 200 XP\n' +
        '👑 Elite 500 XP';

    if (u.started) {
        try {
            await ctx.telegram.sendMessage(uid, text, { parse_mode: 'Markdown' });
            if (!istPrivat(ctx.chat.type)) await ctx.reply('📩 Hilfe per DM geschickt!');
        } catch (e) {
            await ctx.reply(text, { parse_mode: 'Markdown' });
        }
    } else {
        const info = await ctx.telegram.getMe();
        await ctx.reply('⚠️ Starte zuerst den Bot per DM!', {
            reply_markup: Markup.inlineKeyboard([
                Markup.button.url('📩 Bot starten', 'https://t.me/' + info.username + '?start=help')
            ]).reply_markup
        });
    }
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
        '🎖️ ' + u.role + '\n' +
        '⭐ XP Gesamt: ' + u.xp + '\n' +
        '📅 XP Heute: ' + (d.dailyXP[uid] || 0) + '\n' +
        '📆 XP Diese Woche: ' + (d.weeklyXP[uid] || 0) + '\n' +
        '📊 Level: ' + u.level + '\n' +
        '🏆 Rang: #' + rank + '\n' +
        '🔗 Links: ' + u.links + '\n' +
        (bonusL > 0 ? '🎁 Bonus Links: ' + bonusL + '\n' : '') +
        '👍 Likes: ' + u.totalLikes + '\n' +
        '⚠️ Warns: ' + u.warnings + '/5',
        { parse_mode: 'Markdown' }
    );
});

// ================================
// /ranking - PERMANENTES RANKING
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
// /dailyranking - TAGES RANKING
// ================================
bot.command('dailyranking', async (ctx) => {
    const sorted = Object.entries(d.dailyXP)
        .filter(([uid]) => d.users[uid])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    if (!sorted.length) return ctx.reply('Heute noch keine XP gesammelt.');
    const badges = ['🥇', '🥈', '🥉'];
    let text = '📅 *TAGES RANKING*\n_(Wird täglich zurückgesetzt)_\n\n';
    sorted.forEach(([uid, xp], i) => {
        const u = d.users[uid];
        text += (badges[i] || (i + 1) + '.') + ' *' + u.name + '*\n';
        text += '   ⭐ ' + xp + ' XP heute\n\n';
    });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ================================
// /weeklyranking - WOCHEN RANKING
// ================================
bot.command('weeklyranking', async (ctx) => {
    const sorted = Object.entries(d.weeklyXP)
        .filter(([uid]) => d.users[uid])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    if (!sorted.length) return ctx.reply('Diese Woche noch keine XP gesammelt.');
    const badges = ['🥇', '🥈', '🥉'];
    let text = '📆 *WOCHEN RANKING*\n_(Wird jeden Sonntag zurückgesetzt)_\n\n';
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
    xpAdd(uid, bonus, ctx.from.first_name);
    speichern();
    await ctx.reply(
        '🎁 *Daily Reward!*\n\n+' + bonus + ' XP!\n' +
        '⭐ Gesamt: ' + u.xp + '\n' +
        '📅 Heute: ' + (d.dailyXP[uid] || 0) + '\n' +
        '📊 Level: ' + u.level + '\n' +
        '🎖️ ' + u.role,
        { parse_mode: 'Markdown' }
    );
});

// ================================
// /stats
// ================================
bot.command('stats', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const alleChats = Object.values(d.chats);
    const gruppen = alleChats.filter(c => istGruppe(c.type));
    let text = '📊 *Statistiken*\n\n' +
        '👥 User: ' + Object.keys(d.users).length + '\n' +
        '💬 Chats: ' + alleChats.length + '\n' +
        '👥 Gruppen: ' + gruppen.length + '\n' +
        '🔗 Links: ' + Object.keys(d.links).length + '\n';
    await ctx.reply(text, { parse_mode: 'Markdown' });
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
    let text = '💬 *Bekannte Chats*\n\n' +
        '👤 Privat: ' + privat + '\n' +
        '👥 Gruppen: ' + gruppen.length + '\n\n';
    gruppen.forEach(g => { text += '• ' + g.title + ' (`' + g.id + '`)\n'; });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

// ================================
// /chatinfo
// ================================
bot.command('chatinfo', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const c = d.chats[ctx.chat.id];
    await ctx.reply(
        '💬 *Chat Info*\n\n' +
        '🆔 ID: `' + ctx.chat.id + '`\n' +
        '📝 Titel: ' + (ctx.chat.title || ctx.chat.first_name || 'Privat') + '\n' +
        '🔤 Typ: ' + ctx.chat.type + '\n' +
        '💬 Nachrichten: ' + ((c && c.msgs) || 0),
        { parse_mode: 'Markdown' }
    );
});

// ================================
// TEST COMMANDS
// ================================
bot.command('testxp', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    xpAdd(ctx.from.id, 50, ctx.from.first_name);
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
    // Nur daily/weekly zurücksetzen, NICHT permanente XP!
    d.dailyXP = {};
    d.weeklyXP = {};
    speichern();
    await ctx.reply('✅ Daily/Weekly Reset! Permanente XP bleiben erhalten.');
});

bot.command('testregeln', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    await ctx.reply(
        '📜 *Regeln*\n\n1️⃣ 1 Link pro 24h\n2️⃣ Keine Duplikate\n' +
        '3️⃣ Bot starten Pflicht\n4️⃣ 5 Warns = Ban\n5️⃣ Respekt',
        { parse_mode: 'Markdown' }
    );
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
    await ctx.reply('✅ Wöchentliches Gewinnspiel getestet!');
});

bot.command('testliked', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    await likeErinnerung();
    await ctx.reply('✅ Like Erinnerung gesendet!');
});

bot.command('unban', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    if (!ctx.message.reply_to_message) {
        return ctx.reply('❌ Antworte auf die Nachricht vom User.');
    }
    const userId = ctx.message.reply_to_message.from.id;
    try {
        await ctx.telegram.unbanChatMember(ctx.chat.id, userId);
        if (d.users[userId]) d.users[userId].warnings = 0;
        await ctx.reply('✅ User wurde entbannt!');
    } catch (e) {
        await ctx.reply('❌ Fehler beim Entbannen.');
    }
});

bot.command('ankuendigung', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    await ctx.reply(
        '📢 *Wichtige Bot-Updates!*\n\n' +
        '1️⃣ *Text-Weiterleitung*\n' +
        'Alle normalen Textnachrichten werden ab sofort automatisch in den Chat-Ordner weitergeleitet!\n\n' +
        '2️⃣ *Einmaliger /start erforderlich*\n' +
        'Aufgrund eines Fehlers im Code bitten wir alle User einmalig den Bot neu zu starten.\n' +
        'Bitte klickt auf den Button unten! 👇\n\n' +
        '3️⃣ *Automatische Like-Kontrolle*\n' +
        'Jeden Tag um 23:00 Uhr erhaltet ihr eine DM mit allen Links die ihr noch nicht geliked habt!\n\n' +
        '4️⃣ *XP wird jetzt dauerhaft gespeichert!*\n' +
        'Eure XP Punkte bleiben ab sofort auch nach Bot-Updates erhalten! 🎉\n\n' +
        '5️⃣ *3 XP Systeme ab jetzt:*\n' +
        '• /ranking - Permanente XP (wächst für immer)\n' +
        '• /dailyranking - Tages XP\n' +
        '• /weeklyranking - Wochen XP\n\n' +
        '6️⃣ *Gewinnspiel kommt!*\n' +
        'Jeden Sonntag wird ein Gewinner ausgelost der eine Woche lang einen extra Link posten darf! 🎰\n\n' +
        '⚠️ *Hinweis:* Bisherige XP wurden durch technisches Update zurückgesetzt. Es geht fair für alle von vorne los!\n\n' +
        '✅ Danke für eure Geduld!',
        { parse_mode: 'Markdown' }
    );
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
            '👋 Willkommen *' + m.first_name + '*!\n\n' +
            '⚠️ Starte den Bot per DM!\n' +
            '• Links posten\n• XP sammeln\n• Ranking\n\n👇',
            {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    Markup.button.url('📩 Bot starten', 'https://t.me/' + info.username + '?start=gruppe')
                ]).reply_markup
            }
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
            try {
                await ctx.forwardMessage(-1003906557227);
                await ctx.deleteMessage();
                const hinweis = await ctx.reply(
                    '📨 *' + ctx.from.first_name + '*, deine Nachricht wurde in diesen Ordner verschoben:\n\n' +
                    '👉 [Hier klicken](https://t.me/c/3906557227/1)',
                    { parse_mode: 'Markdown' }
                );
                setTimeout(async () => {
                    try { await ctx.telegram.deleteMessage(ctx.chat.id, hinweis.message_id); } catch (e) {}
                }, 30000);
            } catch (e) {}
        }
        return;
    }

    const admin = await istAdmin(ctx, uid);

    if (admin || u.links > 0 || u.xp > 0) u.started = true;

    if (!u.started) {
        try { await ctx.deleteMessage(); } catch (e) {}
        d.warte[uid] = ctx.chat.id;
        const info = await ctx.telegram.getMe();
        await ctx.reply(
            '⚠️ *' + ctx.from.first_name + '*, starte den Bot per DM!',
            {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    Markup.button.url('📩 Bot starten', 'https://t.me/' + info.username + '?start=gruppe')
                ]).reply_markup
            }
        );
        return;
    }

    // Duplikat Check
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

    // 24h Limit - mit Bonus Link Check
    if (!d.counter[uid]) d.counter[uid] = 0;
    const heute = new Date().toDateString();

    if (!admin && d.tracker[uid] === heute) {
        // Prüfe ob Bonus Link verfügbar
        if (hatBonusLink(uid)) {
            bonusLinkNutzen(uid);
            await ctx.reply(
                '🎁 *Bonus Link genutzt!*\nDu hattest noch ' + (d.bonusLinks[uid] || 0) + ' Bonus Links übrig.',
                { parse_mode: 'Markdown' }
            );
        } else {
            try { await ctx.deleteMessage(); } catch (e) {}
            d.counter[uid]++;
            u.warnings++;
            if (u.warnings >= 5) {
                try { await ctx.telegram.banChatMember(ctx.chat.id, uid); } catch (e) {}
                await ctx.reply('🔨 *' + ctx.from.first_name + '* gebannt!', { parse_mode: 'Markdown' });
            } else {
                await ctx.reply(
                    '❌ Nur 1 Link pro Tag erlaubt!\n🕛 Ab Mitternacht kannst du wieder posten.\n⚠️ Warn ' + u.warnings + '/5',
                    { parse_mode: 'Markdown' }
                );
                if (u.started) {
                    try {
                        await ctx.telegram.sendMessage(uid, '⚠️ Link gelöscht!\n🕛 Du kannst morgen wieder posten.');
                    } catch (e) {}
                }
            }
            speichern();
            return;
        }
    }

    // Link erlaubt
    d.tracker[uid] = heute;
    d.counter[uid] = 0;
    u.links++;
    xpAdd(uid, 1, ctx.from.first_name);
    const msgId = ctx.message.message_id;

    const reply = await ctx.reply(
        '🔗 *Link von ' + ctx.from.first_name + '*\n\n' +
        '👍 Likes: **0**\n' +
        '⭐ XP: ' + u.xp + ' | Lvl ' + u.level + '\n\n' +
        '_1 Like pro User erlaubt_',
        {
            parse_mode: 'Markdown',
            reply_to_message_id: msgId,
            reply_markup: Markup.inlineKeyboard([
                Markup.button.callback('👍 Like', 'like_' + msgId)
            ]).reply_markup
        }
    );

    d.links[msgId] = {
        chat_id: ctx.chat.id,
        user_id: uid,
        user_name: ctx.from.first_name,
        text: text,
        likes: new Set(),
        counter_msg_id: reply.message_id,
        timestamp: Date.now()
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
    xpAdd(lnk.user_id, 5, lnk.user_name);

    const feedbackMsg = await ctx.reply(
        '🎉 +5 XP erhalten!\n\nDanke für deine Unterstützung 💪'
    );
    setTimeout(async () => {
        try { await ctx.telegram.deleteMessage(ctx.chat.id, feedbackMsg.message_id); } catch (e) {}
    }, 5000);

    await ctx.answerCbQuery('👍 ' + anz + ' Likes!');

    try {
        await ctx.telegram.editMessageText(
            lnk.chat_id, lnk.counter_msg_id, null,
            '🔗 *Link von ' + lnk.user_name + '*\n\n' +
            '👍 Likes: **+' + anz + '**\n' +
            '⭐ XP: ' + poster.xp + ' | Lvl ' + poster.level + '\n\n' +
            '_1 Like pro User erlaubt_',
            {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    Markup.button.callback('👍 Like', 'like_' + msgId)
                ]).reply_markup
            }
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
    for (const [uid, u] of Object.entries(d.users)) {
        if (parseInt(uid) === linkData.user_id) continue;
        try {
            await bot.telegram.sendMessage(
                uid,
                '📢 Neuer Booster-Link\n\n' +
                '👤 Member: ' + linkData.user_name + '\n\n' +
                '🔗 ' + linkData.text + '\n\n' +
                'Lieber Booster,\n\n' +
                'Member ' + linkData.user_name + ' hat gerade diesen Link gepostet.\n' +
                'Bitte liken und kommentieren und nicht vergessen in der Gruppe zu bestätigen 👍',
                {
                    reply_markup: {
                        inline_keyboard: [[{
                            text: '👉 Zum Beitrag',
                            url: 'https://t.me/c/' + String(linkData.chat_id).replace('-100', '') + '/' + linkData.counter_msg_id
                        }]]
                    }
                }
            );
        } catch (e) { console.log('FEHLER:', uid, e.message); }
    }
}

// ================================
// DAILY RANKING ABSCHLUSS
// ================================
async function dailyRankingAbschluss() {
    const gruppen = Object.values(d.chats).filter(c => istGruppe(c.type));

    const sorted = Object.entries(d.dailyXP)
        .filter(([uid]) => d.users[uid] && d.dailyXP[uid] > 0)
        .sort((a, b) => b[1] - a[1]);

    if (!sorted.length) return;

    // Gewinner belohnen
    const belohnungen = [
        { xp: 10, links: 1, text: '🥇 Platz 1' },
        { xp: 5, links: 0, text: '🥈 Platz 2' },
        { xp: 2, links: 0, text: '🥉 Platz 3' }  // 2.5 gerundet
    ];

    let rankText = '🏆 *TAGES RANKING ABSCHLUSS*\n\n';
    rankText += '🎉 Herzlichen Glückwunsch an die Gewinner!\n\n';

    for (let i = 0; i < Math.min(3, sorted.length); i++) {
        const [uid, xp] = sorted[i];
        const u = d.users[uid];
        const bel = belohnungen[i];

        xpAdd(uid, bel.xp, u.name);
        if (bel.links > 0) {
            if (!d.bonusLinks[uid]) d.bonusLinks[uid] = 0;
            d.bonusLinks[uid] += bel.links;
        }

        rankText += bel.text + ': *' + u.name + '*\n';
        rankText += '   ⭐ ' + xp + ' XP heute\n';
        rankText += '   🎁 +' + bel.xp + ' Bonus XP';
        if (bel.links > 0) rankText += ' + 1 Extra Link morgen!';
        rankText += '\n\n';

        // DM an Gewinner
        try {
            let dm = '🎉 *Glückwunsch ' + u.name + '!*\n\n';
            dm += 'Du hast heute ' + bel.text + ' im Tages-Ranking erreicht!\n\n';
            dm += '🎁 Du bekommst:\n';
            dm += '• +' + bel.xp + ' Bonus XP\n';
            if (bel.links > 0) dm += '• 1 Extra Link für morgen! 🔗\n';
            await bot.telegram.sendMessage(Number(uid), dm, { parse_mode: 'Markdown' });
        } catch (e) {}
    }

    // Ranking in Gruppe posten
    gruppen.forEach(g => {
        bot.telegram.sendMessage(g.id, rankText, { parse_mode: 'Markdown' }).catch(() => {});
    });

    // Daily XP zurücksetzen
    d.dailyXP = {};
    d.dailyReset = Date.now();
    speichern();
}

// ================================
// WÖCHENTLICHES GEWINNSPIEL
// ================================
async function wochenGewinnspiel() {
    const gruppen = Object.values(d.chats).filter(c => istGruppe(c.type));

    // Alle User mit wöchentlichen XP als Teilnehmer
    const teilnehmer = Object.entries(d.weeklyXP)
        .filter(([uid]) => d.users[uid] && d.weeklyXP[uid] > 0)
        .map(([uid]) => uid);

    if (!teilnehmer.length) return;

    // Zufälligen Gewinner auslosen
    const gewinnerUid = teilnehmer[Math.floor(Math.random() * teilnehmer.length)];
    const gewinner = d.users[gewinnerUid];

    // Gewinner bekommt 1 Bonus Link für die nächste Woche
    if (!d.bonusLinks[gewinnerUid]) d.bonusLinks[gewinnerUid] = 0;
    d.bonusLinks[gewinnerUid] += 1;

    // Gewinner speichern
    d.wochenGewinnspiel.gewinner.push({
        name: gewinner.name,
        uid: gewinnerUid,
        datum: new Date().toLocaleDateString(),
        weeklyXP: d.weeklyXP[gewinnerUid] || 0
    });
    d.wochenGewinnspiel.letzteAuslosung = Date.now();

    // Ankündigung in Gruppen
    const text =
        '🎰 *WÖCHENTLICHES GEWINNSPIEL*\n\n' +
        '🎉 Der Gewinner diese Woche ist:\n\n' +
        '🏆 *' + gewinner.name + '*\n\n' +
        '🎁 Gewinn: 1 Extra Link für die nächste Woche!\n\n' +
        '📆 Nächste Auslosung: Nächsten Sonntag\n' +
        '💪 Sammelt XP um dabei zu sein!';

    gruppen.forEach(g => {
        bot.telegram.sendMessage(g.id, text, { parse_mode: 'Markdown' }).catch(() => {});
    });

    // DM an Gewinner
    try {
        await bot.telegram.sendMessage(
            Number(gewinnerUid),
            '🎉 *Herzlichen Glückwunsch!*\n\n' +
            'Du hast das wöchentliche Gewinnspiel gewonnen!\n\n' +
            '🎁 Dein Gewinn: 1 Extra Link für diese Woche!\n' +
            'Du kannst ihn in der Gruppe nutzen wenn dein normales Limit erreicht ist.',
            { parse_mode: 'Markdown' }
        );
    } catch (e) {}

    // Weekly XP zurücksetzen
    d.weeklyXP = {};
    d.weeklyReset = Date.now();
    speichern();
}

// ================================
// LIKE ERINNERUNG
// ================================
async function likeErinnerung() {
    const heute = new Date().setHours(0, 0, 0, 0);
    const heutigeLinks = Object.entries(d.links).filter(([, l]) => l.timestamp >= heute);

    if (!heutigeLinks.length) return;

    for (const [uid, u] of Object.entries(d.users)) {
        if (!u.started) continue;

        const nichtGeliked = heutigeLinks.filter(([, l]) => {
            return l.user_id != uid && !l.likes.has(Number(uid));
        });

        if (!nichtGeliked.length) continue;

        let text = '👋 *Hallo ' + u.name + '!*\n\n';
        text += '⚠️ Du hast heute noch diese Links nicht geliked:\n\n';

        const buttons = [];
        for (const [msgId, l] of nichtGeliked) {
            text += '🔗 Link von *' + l.user_name + '*\n';
            buttons.push([
                Markup.button.url(
                    '👍 Liken - ' + l.user_name,
                    'https://t.me/c/' + String(l.chat_id).replace('-100', '') + '/' + msgId
                )
            ]);
        }
        text += '\n_Klick auf die Buttons um die Links zu liken!_';

        try {
            await bot.telegram.sendMessage(Number(uid), text, {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard(buttons).reply_markup
            });
        } catch (e) {}
    }
}

// ================================
// ZEITGESTEUERTE EVENTS
// ================================
function zeitCheck() {
    const jetzt = new Date();
    const h = jetzt.getHours();
    const m = jetzt.getMinutes();
    const wochentag = jetzt.getDay(); // 0=Sonntag

    const gruppen = Object.values(d.chats).filter(c => istGruppe(c.type));
    if (!gruppen.length) return;

    gruppen.forEach(g => {
        // 06:00 - Regeln
        if (h === 6 && m === 0) {
            bot.telegram.sendMessage(g.id,
                '📜 *Regeln*\n\n1️⃣ 1 Link pro 24h\n2️⃣ Keine Duplikate\n' +
                '3️⃣ Bot starten Pflicht\n4️⃣ 5 Warns = Ban\n5️⃣ Respekt',
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }

        // 07:00 - Tages-Ranking
        if (h === 7 && m === 0) {
            const s = Object.entries(d.dailyXP)
                .filter(([uid]) => d.users[uid])
                .sort((a, b) => b[1] - a[1]).slice(0, 3);
            if (s.length) {
                const badges = ['🥇', '🥈', '🥉'];
                let text = '📅 *Tages-Ranking*\n\n';
                s.forEach(([uid, xp], i) => {
                    text += badges[i] + ' ' + d.users[uid].name + ': ' + xp + ' XP\n';
                });
                bot.telegram.sendMessage(g.id, text, { parse_mode: 'Markdown' }).catch(() => {});
            }
        }

        // 07:05 - Top Links
        if (h === 7 && m === 5) topLinks(g.id);

        // 23:00 - Like Erinnerung
        if (h === 23 && m === 0) likeErinnerung();
    });

    // 23:55 - Daily Ranking Abschluss
    if (h === 23 && m === 55) {
        dailyRankingAbschluss();
    }

    // Sonntag 20:00 - Wöchentliches Gewinnspiel
    if (wochentag === 0 && h === 20 && m === 0) {
        wochenGewinnspiel();
    }
}

setInterval(zeitCheck, 60000);

// ================================
// START
// ================================
bot.launch().then(() => console.log('🤖 Bot läuft!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

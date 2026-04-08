import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';

const BOT_TOKEN = "7909817546:AAF5W5gY-sKl_SNA7Xu45QT54Pr5a5SASzs";
const DATA_FILE = './daten.json';
const bot = new Telegraf(BOT_TOKEN);

// ================================
// DATEN
// ================================
let d = {
    users: {}, chats: {}, links: {},
    tracker: {}, counter: {}, warte: {},
    gepostet: [], seasonStart: Date.now(),
    seasonGewinner: []
};

function laden() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const geladen = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            d = Object.assign({}, d, geladen);
            for (const k of Object.keys(d.links)) {
    d.links[k].likes = new Set(d.links[k].likes || []);

    // 🔥 NEU
    if (!d.links[k].timestamp) {
        d.links[k].timestamp = 0; // sofort Reminder
    }

    if (d.links[k].reminderSent === undefined) {
        d.links[k].reminderSent = false;
    }
            }
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

function xpAdd(uid, menge, name) {
    const u = user(uid, name);
    u.xp += menge;
    u.level = level(u.xp);
    u.role = rolle(u.xp);
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
    return /(https?:\/\/|www\.|t\.me\/)|(\b\w+\.(com|de|net|org|io|me|gg|tv)\b)/i.test(text);
}

function linkUrl(text) {
    const m = text.match(/(https?:\/\/[^\s]+|www\.[^\s]+)/i);
    return m ? m[0] : null;
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
        '⚠️ *Warn System:*\n' +
        '• 5 Verwarnungen = Ban\n\n' +
        '🏆 *Commands:*\n' +
        '/ranking - Top 10\n' +
        '/profile - Dein Profil\n' +
        '/daily - XP Bonus\n' +
        '/chatinfo - Chat Info (Admin)\n' +
        '/chats - Alle Chats (Admin)\n' +
        '/stats - Statistiken (Admin)\n\n' +
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
    await ctx.reply(
        '👤 *Profil von ' + u.name + '*\n' +
        (u.username ? '🔗 @' + u.username + '\n' : '') +
        '🆔 ID: `' + uid + '`\n\n' +
        '🎖️ ' + u.role + '\n' +
        '⭐ XP: ' + u.xp + '\n' +
        '📊 Level: ' + u.level + '\n' +
        '🏆 Rang: #' + rank + '\n' +
        '🔗 Links: ' + u.links + '\n' +
        '👍 Likes: ' + u.totalLikes + '\n' +
        '⚠️ Warns: ' + u.warnings + '/5\n' +
        '💬 Chats: ' + u.chats.length,
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
    let text = '🏆 *TOP RANKING*\n\n';
    sorted.forEach(([, u], i) => {
        text += (badges[i] || (i + 1) + '.') + ' *' + u.name + '*\n';
        text += '   ' + u.role + ' | ⭐' + u.xp + ' | Lvl ' + u.level + '\n\n';
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
    for (const u of Object.values(d.users)) { u.xp = 0; u.level = 1; u.role = '🆕 Anfänger'; }
    speichern();
    await ctx.reply('✅ Reset!');
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
bot.command('testsend', async (ctx) => {

    const uid = ctx.from.id;

    try {
        await ctx.telegram.sendMessage(uid,
            '🧪 *TEST LINK*\n\n' +
            '👤 Von: *Test User*\n\n' +
            '📎 https://example.com\n\n' +
            '💬 Bitte liken und kommentieren und in der Gruppe bestätigen 👇',
            {
                parse_mode: 'Markdown',
                reply_markup: Markup.inlineKeyboard([
                    Markup.button.url('➡️ Zum Beitrag', 'https://t.me/test')
                ]).reply_markup
            }
        );

        await ctx.reply('✅ Test an dich gesendet!');

    } catch (e) {
        await ctx.reply('❌ Konnte dir keine DM senden. Hast du den Bot gestartet?');
    }
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
    const admin = await istAdmin(ctx, uid);

    if (!hatLink(text)) return;

    // Admins + aktive User = automatisch gestartet
    if (admin || u.links > 0 || u.xp > 0) u.started = true;

    // Force Start
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

    // 24h Limit
    if (!d.counter[uid]) d.counter[uid] = 0;
    if (!admin && d.tracker[uid]) {
        const diff = Date.now() - d.tracker[uid];
        if (diff < 86400000) {
            try { await ctx.deleteMessage(); } catch (e) {}
            const left = 86400000 - diff;
            const h = Math.floor(left / 3600000);
            const m = Math.floor((left % 3600000) / 60000);
            d.counter[uid]++;
            u.warnings++;
            if (u.warnings >= 5) {
                try { await ctx.telegram.banChatMember(ctx.chat.id, uid); } catch (e) {}
                await ctx.reply('🔨 *' + ctx.from.first_name + '* gebannt!', { parse_mode: 'Markdown' });
            } else {
                await ctx.reply(
                    '❌ Nur 1 Link pro 24h!\n⏳ Noch ' + h + 'h ' + m + 'min\n⚠️ Warn ' + u.warnings + '/5',
                    { parse_mode: 'Markdown' }
                );
                if (u.started) {
                    try { await ctx.telegram.sendMessage(uid, '⚠️ Link gelöscht!\n⏳ Noch ' + h + 'h ' + m + 'min'); } catch (e) {}
                }
            }
            speichern();
            return;
        }
    }

    // Link erlaubt
    d.tracker[uid] = Date.now();
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
    timestamp: Date.now(),
    reminderSent: false
};
await sendeLinkAnAlle(d.links[msgId], msgId);
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

// XP bekommt jetzt der LIKER
xpAdd(uid, 5, ctx.from.first_name);

    await ctx.answerCbQuery('👍 ' + anz + ' Likes!');

    try {
        await ctx.telegram.editMessageText(
            lnk.chat_id, lnk.counter_msg_id, null,
            '🔗 *Link von ' + lnk.user_name + '*\n\n' +
            '👍 Likes: **+' + anz + '**\n\n' +
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
async function sendeLinkAnAlle(linkData, msgId) {
    const gruppenLink = `https://t.me/c/${String(linkData.chat_id).replace('-100', '')}/${msgId}`;

    for (const [uid, u] of Object.entries(d.users)) {

        if (parseInt(uid) === linkData.user_id) continue;

        try {
            await bot.telegram.sendMessage(uid,
                '🔗 *Neuer Link gepostet!*\n\n' +
                '👤 Von: *' + linkData.user_name + '*\n\n' +
                '📎 ' + linkData.text + '\n\n' +
                '💬 Bitte liken und kommentieren und in der Gruppe bestätigen 👇',
                {
                    parse_mode: 'Markdown',
                    reply_markup: Markup.inlineKeyboard([
                        Markup.button.url('➡️ Zum Beitrag', gruppenLink)
                    ]).reply_markup
                }
            );
        } catch (e) {}
        for (const u of Object.values(d.users)) { u.xp = 0; u.level = 1; u.role = '🆕 Anfänger'; }
        d.seasonStart = Date.now();
        speichern();

async function sendeGebündelteReminder() {
    console.log("Reminder läuft");
    console.log("Links:", Object.keys(d.links).length);
    console.log("Users:", Object.keys(d.users).length);

    const jetzt = Date.now();

    for (const [uid, u] of Object.entries(d.users)) {

        let offeneLinks = [];

        for (const [msgId, lnk] of Object.entries(d.links)) {

            // 👉 TEST: 1 Minute warten
            // später ändern auf 24h = 86400000
            if (jetzt - lnk.timestamp < 60000) continue;

            // eigener Link skippen
            if (parseInt(uid) === lnk.user_id) continue;

            // schon geliked skippen
            if (lnk.likes && lnk.likes.has(parseInt(uid))) continue;

            offeneLinks.push({ msgId, lnk });
        }

        if (!offeneLinks.length) continue;

        try {
            let buttons = [];

            offeneLinks.forEach((item, i) => {
                const link = `https://t.me/c/${String(item.lnk.chat_id).replace('-100', '')}/${item.msgId}`;

                buttons.push({
                    text: `🔗 Link ${i + 1}`,
                    url: link
                });
            });

            console.log("Buttons:", buttons.length);

            await bot.telegram.sendMessage(
uid,
'📌 *Kurze Erinnerung*\n\n' +
'Du hast dich bei einigen Beiträgen noch nicht beteiligt.\n' +
'Bitte kurz liken und in der Gruppe bestätigen 👍\n\n' +
'Du bekommst später nochmal eine Erinnerung.',
{
    parse_mode: 'Markdown',
    reply_markup: {
        inline_keyboard: buttons.map(btn => [
            {
                text: btn.text,
                url: btn.url
            }
        ])
    }
}
);
} catch (e) {
    console.log("Fehler beim Senden:", e);
}

speichern();
// ================================
// ZEITGESTEUERTE EVENTS
// ================================
function zeitCheck() {
    const h = new Date().getHours();
    const m = new Date().getMinutes();
    const gruppen = Object.values(d.chats).filter(c => istGruppe(c.type));
// if (!gruppen.length) return;

    gruppen.forEach(g => {
        if (h === 6 && m === 0) {
            bot.telegram.sendMessage(g.id,
                '📜 *Regeln*\n\n1️⃣ 1 Link pro 24h\n2️⃣ Keine Duplikate\n' +
                '3️⃣ Bot starten Pflicht\n4️⃣ 5 Warns = Ban\n5️⃣ Respekt',
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }
        if (h === 7 && m === 0) {
            const s = Object.entries(d.users).sort((a, b) => b[1].xp - a[1].xp).slice(0, 3);
            if (s.length) {
                const badges = ['🥇', '🥈', '🥉'];
                let text = '🏆 *Tages-Ranking*\n\n';
                s.forEach(([, u], i) => { text += badges[i] + ' ' + u.name + ': ' + u.xp + ' XP\n'; });
                bot.telegram.sendMessage(g.id, text, { parse_mode: 'Markdown' }).catch(() => {});
            }
        }
        if (h === 7 && m === 5) topLinks(g.id);
});
    sendeGebündelteReminder();

    // Season Reset alle 7 Tage
    if (Date.now() - d.seasonStart > 604800000) {
        const s = Object.entries(d.users).sort((a, b) => b[1].xp - a[1].xp);
        if (s.length) {
            const w = d.users[s[0][0]];
            d.seasonGewinner.push({ name: w.name, xp: w.xp, datum: new Date().toLocaleDateString() });
            gruppen.forEach(g => {
                bot.telegram.sendMessage(g.id,
tInterval(zeitCheck, 60000);
setTimeout(() => {
    console.log("TEST START");
    sendeGebündelteReminder();
}, 5000);

// ================================
// START
// ================================
bot.launch().then(() => console.log('🤖 Bot läuft!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

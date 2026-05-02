import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import express from 'express';

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) { console.error('❌ BOT TOKEN FEHLT!'); process.exit(1); }

const DATA_FILE      = process.env.DATA_FILE || '/data/daten.json';
const DASHBOARD_URL  = process.env.DASHBOARD_URL || '';
const APP_URL        = process.env.APP_URL || 'https://site--creatorboost-app--899dydmn7d7v.code.run';
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
    tracker: {}, counter: {},
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
    missionQueue: {},
    missionAuswertungErledigt: {},
    gesternDailyXP: {},
    badgeTracker: {},
    m1Streak: {},
    backupDatum: null,
    _lastEvents: {},
    _seenEngagementJobs: {},
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
            threadMessages: {}, threads: [], dailyLogins: {}, dailyGroupMsgs: {}, threadLastRead: {}, superlinks: {}, fullEngagementThreadId: null,
            wochenGewinnspiel: { aktiv: true, gewinner: [], letzteAuslosung: null },
            xpEvent: { aktiv: false, multiplier: 1, start: null, end: null, announced: false },
            newsletter: [], pinnedEngages: {},
        };
        for (const [key, val] of Object.entries(defaults)) { if (!d[key]) d[key] = val; }
        const linkKeys = Object.keys(d.links).sort((a, b) => d.links[a].timestamp - d.links[b].timestamp);
        while (linkKeys.length > 500) { delete d.links[linkKeys.shift()]; }
        for (const uid in d.users) {
            if (d.users[uid].inGruppe === undefined) d.users[uid].inGruppe = true;
            if (!d.users[uid].projects) d.users[uid].projects = [];
            if (d.users[uid].diamonds === undefined) d.users[uid].diamonds = 0;
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

// ── FULL ENGAGEMENT / SUPERLINK SYSTEM ──

function getBerlinWeekKey() {
    const now = new Date(); // TZ already set to Europe/Berlin
    const day = now.getDay() || 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - (day - 1));
    return monday.getFullYear() + '-' + String(monday.getMonth()+1).padStart(2,'0') + '-' + String(monday.getDate()).padStart(2,'0');
}

function isSuperLinkPostingAllowed() {
    const day = new Date().getDay();
    return day >= 1 && day <= 6; // Mon–Sat
}

function buildSuperLinkKarte(userName, insta, url, caption, likeCount, likerNames) {
    const topLikers = Object.values(likerNames||{}).slice(0,5);
    const likerLine = topLikers.length ? '\n👥 ' + topLikers.join(', ') + (Object.keys(likerNames||{}).length > 5 ? ` +${Object.keys(likerNames).length-5}` : '') : '';
    return `⭐ *SUPERLINK*\n\n👤 ${userName}${insta ? ' (@' + insta + ')' : ''}\n🔗 ${url}${caption ? '\n💬 ' + caption : ''}\n\n🙏 *Bitte Liken, Kommentieren, Teilen und Speichern\\!*\n\n━━━━━━━━━━━━━━\n❤️ ${likeCount} Like${likeCount!==1?'s':''}${likerLine}\n━━━━━━━━━━━━━━`;
}

function buildSuperLinkButtons(slId, likeCount) {
    return { inline_keyboard: [[
        Markup.button.callback('❤️ Like · ' + likeCount, 'sllike_' + slId),
        Markup.button.callback('👁 Liker', 'slliker_' + slId),
        Markup.button.callback('🚩 Melden', 'slrep_' + slId),
    ]] };
}

async function updateSuperLinkCard(slId) {
    const sl = d.superlinks?.[slId];
    if (!sl || !sl.msg_id || !d.fullEngagementThreadId) return;
    const u = d.users[sl.uid];
    const cardText = buildSuperLinkKarte(u?.spitzname||u?.name||'User', u?.instagram, sl.url, sl.caption, sl.likes.length, sl.likerNames);
    try {
        await bot.telegram.editMessageText(GROUP_B_ID, sl.msg_id, undefined, cardText, {
            parse_mode: 'Markdown',
            reply_markup: buildSuperLinkButtons(slId, sl.likes.length)
        });
    } catch(e) {}
}

async function handleSuperlink(ctx, senderUid, senderUser, text) {
    const uidStr = String(senderUid);
    if (!senderUser?.instagram) {
        try { await ctx.deleteMessage(); } catch(e) {}
        try { await bot.telegram.sendMessage(Number(senderUid), '❌ Zuerst Instagram verbinden! Schreibe /setinsta'); } catch(e) {}
        return;
    }
    if (!isSuperLinkPostingAllowed()) {
        try { await ctx.deleteMessage(); } catch(e) {}
        try { await bot.telegram.sendMessage(Number(senderUid), '❌ Superlinks sind nur Montag bis Samstag möglich!'); } catch(e) {}
        return;
    }
    const week = getBerlinWeekKey();
    const isElitePlus = d.users[uidStr]?.role === '🌟 Elite+';
    const maxSuperlinks = isElitePlus ? 2 : 1;
    const slThisWeek = Object.values(d.superlinks||{}).filter(s => s.uid === uidStr && s.week === week);
    if (slThisWeek.length >= maxSuperlinks) {
        try { await ctx.deleteMessage(); } catch(e) {}
        try { await bot.telegram.sendMessage(Number(senderUid), '❌ Du hast diese Woche bereits ' + maxSuperlinks + ' Superlink(s) gepostet! Limit: ' + maxSuperlinks + 'x pro Woche.'); } catch(e) {}
        return;
    }
    const uCheck = d.users[uidStr];
    if (!istAdminId(Number(senderUid)) && (uCheck?.diamonds||0) < 10) {
        try { await ctx.deleteMessage(); } catch(e) {}
        try { await bot.telegram.sendMessage(Number(senderUid), '❌ Für einen Superlink benötigst du 💎 10 Diamanten. Du hast ' + (uCheck?.diamonds||0) + ' 💎.'); } catch(e) {}
        return;
    }
    const urlMatch = text.match(/https?:\/\/(www\.)?instagram\.com\/[^\s]+/i);
    const url = urlMatch ? urlMatch[0].replace(/[.,;!?]+$/, '') : text.trim();
    const caption = text.replace(url, '').trim();
    try { await ctx.deleteMessage(); } catch(e) {}
    const slId = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    const u = d.users[uidStr];
    const cardText = buildSuperLinkKarte(u?.spitzname||u?.name||ctx.from.first_name||'User', u?.instagram, url, caption, 0, {});
    const sent = await bot.telegram.sendMessage(GROUP_B_ID, cardText, {
        parse_mode: 'Markdown',
        message_thread_id: Number(d.fullEngagementThreadId),
        reply_markup: buildSuperLinkButtons(slId, 0)
    });
    d.superlinks = d.superlinks || {};
    d.superlinks[slId] = { id: slId, uid: uidStr, url, caption, msg_id: sent.message_id, timestamp: Date.now(), week, likes: [], likerNames: {} };
    if (!istAdminId(Number(senderUid)) && d.users[uidStr]) d.users[uidStr].diamonds = (d.users[uidStr].diamonds||0) - 10;
    // Superlink-Karte im Web-Thread speichern
    const feThreadKey = String(d.fullEngagementThreadId);
    if (!d.threadMessages[feThreadKey]) d.threadMessages[feThreadKey] = [];
    const u2 = d.users[uidStr];
    d.threadMessages[feThreadKey].unshift({
        uid: uidStr, tgName: u2?.username ? '@'+u2.username : null,
        name: u2?.spitzname || u2?.name || ctx.from.first_name || 'User',
        role: u2?.role || null, type: 'text',
        text: '🔗 ' + url + (caption ? '\n' + caption : '') + '\n👍 0 Likes',
        mediaId: null, timestamp: Date.now(), msg_id: sent.message_id, slId
    });
    if (d.threadMessages[feThreadKey].length > 100) d.threadMessages[feThreadKey] = d.threadMessages[feThreadKey].slice(0, 100);
    const feThr = (d.threads||[]).find(t => String(t.id) === feThreadKey);
    if (feThr) { feThr.last_msg = d.threadMessages[feThreadKey][0]; feThr.msg_count = d.threadMessages[feThreadKey].length; }
    speichern();
    // DM an Poster
    try {
        const maxMsg = isElitePlus ? 2 : 1;
        await bot.telegram.sendMessage(Number(senderUid),
            '⭐ *Dein Superlink wurde gepostet!*\n\nSuperlinks können ' + maxMsg + '× pro Woche gepostet werden. Wenn du einen postest, verpflichtest du dich, *die ganze Woche alle anderen Superlinks zu engagieren* (Liken, Kommentieren, Teilen, Speichern).',
            { parse_mode: 'Markdown' });
    } catch(e) {}
    // DM an alle anderen Superlink-Poster dieser Woche → sie müssen jetzt engagen
    const otherPosters = Object.values(d.superlinks).filter(s => s.week === week && s.uid !== uidStr);
    for (const other of otherPosters) {
        try {
            await bot.telegram.sendMessage(Number(other.uid),
                `⭐ *Neuer Superlink!*\n\n👤 ${u?.spitzname||u?.name||'Ein User'} hat einen neuen Superlink gepostet.\n🔗 ${url}\n\n⚠️ *Vergiss nicht:* Liken, Kommentieren, Teilen & Speichern ist Pflicht!`,
                { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❤️ Jetzt liken', callback_data: 'sllike_' + slId }]] } }
            );
        } catch(e) {}
    }
}

async function runEngagementCheck(isReminder = false) {
    const weekKey = getBerlinWeekKey();
    const weekSuperlinks = Object.values(d.superlinks||{}).filter(s => s.week === weekKey);
    if (!weekSuperlinks.length) return { checked: 0, warned: 0 };
    const posters = [...new Set(weekSuperlinks.map(s => s.uid))];
    let warned = 0;
    for (const uid of posters) {
        const otherLinks = weekSuperlinks.filter(s => s.uid !== uid);
        if (!otherLinks.length) continue;
        const likedAll = otherLinks.every(s => Array.isArray(s.likes) && s.likes.includes(uid));
        if (!likedAll) {
            warned++;
            if (isReminder) {
                try { await bot.telegram.sendMessage(Number(uid), '⚠️ *Erinnerung: Full Engagement*\n\nDu hast diese Woche noch nicht alle Superlinks geliked\\! Vergiss nicht: Liken, Kommentieren, Teilen und Speichern\\. Sonst gibt es um 23:59 Uhr \\-50 XP\\.', { parse_mode: 'MarkdownV2' }); } catch(e) {}
            } else {
                const u = d.users[uid];
                if (u) { u.xp = Math.max(0, (u.xp||0) - 50); u.level = level(u.xp); u.role = badge(u.xp); u.warnings = (u.warnings||0) + 1; }
                addNotification(uid, '⚠️', 'Full Engagement Pflicht verletzt! -50 XP');
                try { await bot.telegram.sendMessage(Number(uid), '⚠️ *Full Engagement Pflicht verletzt\\!*\n\nDu hast diese Woche nicht alle Superlinks geliked\\.\n📉 −50 XP und eine Verwarnung wurden vergeben\\.', { parse_mode: 'MarkdownV2' }); } catch(e) {}
            }
        }
    }
    if (!isReminder) speichern();
    return { checked: posters.length, warned };
}

setInterval(async () => {
    const now = new Date();
    const day = now.getDay(); // 0=So, 1=Mo, ..., 6=Sa
    const wk = getBerlinWeekKey();
    const h = now.getHours(), m = now.getMinutes();
    if (!d._seenEngagementJobs) d._seenEngagementJobs = {};

    // Montag 08:00 → Neue Engagement-Woche ankündigen
    if (day === 1 && h === 8 && m === 0 && !d._seenEngagementJobs[wk+'_open']) {
        d._seenEngagementJobs[wk+'_open'] = true;
        speichern();
        try {
            const threadId = await ensureFullEngagementThread();
            if (threadId && GROUP_B_ID) {
                await bot.telegram.sendMessage(GROUP_B_ID,
                    '⭐ *Neue Full Engagement Woche gestartet!*\n\n' +
                    'Ihr könnt jetzt eure Superlinks posten.\n\n' +
                    '📌 *Regeln:*\n• 1–2 Superlinks pro Person pro Woche (Elite+ = 2)\n• Wer postet, muss ALLE anderen Superlinks liken, kommentieren, teilen & speichern\n• Sonst: -50 XP am Sonntag\n\n' +
                    '📲 Link hier in diesen Thread posten oder per /superlink im Bot.',
                    { parse_mode: 'Markdown', message_thread_id: Number(threadId) }
                );
            }
        } catch(e) { console.log('Engagement Ankündigung Fehler:', e.message); }
    }

    // Sonntag 21:00 → Erinnerung
    if (day === 0 && h === 21 && m === 0 && !d._seenEngagementJobs[wk+'_r']) {
        d._seenEngagementJobs[wk+'_r'] = true;
        speichern();
        await runEngagementCheck(true).catch(()=>{});
    }
    // Sonntag 23:59 → Finale Auswertung
    if (day === 0 && h === 23 && m === 59 && !d._seenEngagementJobs[wk+'_p']) {
        d._seenEngagementJobs[wk+'_p'] = true;
        speichern();
        await runEngagementCheck(false).catch(()=>{});
    }
}, 60000);

async function ensureFullEngagementThread() {
    if (d.fullEngagementThreadId) return d.fullEngagementThreadId;
    if (!GROUP_B_ID) return null;
    try {
        const result = await bot.telegram.callApi('createForumTopic', { chat_id: GROUP_B_ID, name: 'Full Engagement' });
        d.fullEngagementThreadId = result.message_thread_id;
        speichern();
        console.log('✅ Full Engagement Thread erstellt:', d.fullEngagementThreadId);
        return d.fullEngagementThreadId;
    } catch(e) { console.log('Full Engagement Thread Fehler:', e.message); return null; }
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
    if (xp >= 10000) return '🌟 Elite+';
    if (xp >= 5000)  return '👑 Elite';
    if (xp >= 1000)  return '🏅 Erfahrener';
    if (xp >= 500)   return '⬆️ Aufsteiger';
    if (xp >= 50)    return '📘 Anfänger';
    return '🆕 New';
}
function badgeBonusLinks(xp) { return xp >= 1000 ? 1 : 0; }
function xpBisNaechstesBadge(xp) {
    if (xp < 50)    return { ziel: '📘 Anfänger',   fehlend: 50 - xp };
    if (xp < 500)   return { ziel: '⬆️ Aufsteiger', fehlend: 500 - xp };
    if (xp < 1000)  return { ziel: '🏅 Erfahrener', fehlend: 1000 - xp };
    if (xp < 5000)  return { ziel: '👑 Elite',       fehlend: 5000 - xp };
    if (xp < 10000) return { ziel: '🌟 Elite+',      fehlend: 10000 - xp };
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
        const trophyMap = { '📘 Anfänger': '📘', '⬆️ Aufsteiger': '⬆️', '🏅 Erfahrener': '🏅', '👑 Elite': '👑', '🌟 Elite+': '🌟' };
        const trophy = trophyMap[u.role];
        if (trophy && !u.trophies.includes(trophy)) u.trophies.push(trophy);
        // Level-Up DM
        const isElitePlus = u.role === '🌟 Elite+';
        const levelUpExtra = isElitePlus ? '\n\n🌟 *Elite+ Bonus:* Du erhältst jetzt 2 Superlinks pro Woche!' : '';
        bot.telegram.sendMessage(Number(uid),
            '🎉 *Badge Aufstieg!*\n\n' + alteBadge + ' → ' + u.role + '\n\n━━━━━━━━━━━━━━\n⭐ ' + u.xp + ' XP\n━━━━━━━━━━━━━━\n\nWeiter so! 💪' + levelUpExtra,
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
        d.users[uid] = { name: name || '', username: null, instagram: null, bio: null, nische: null, spitzname: null, trophies: [], xp: 0, level: 1, warnings: 0, started: false, links: 0, likes: 0, role: '🆕 New', lastDaily: null, totalLikes: 0, chats: [], joinDate: Date.now(), inGruppe: true, diamonds: 0, projects: [], profileCompletionRewarded: false, inventory: [], activeRing: null };
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
        istInstagramLink(l.text) && new Date(l.timestamp).toDateString() === heute && String(l.user_id) !== String(uid)
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
        try { await bot.telegram.sendMessage(Number(uid), '🎯 *Mission 1 erreicht!*\n\n✅ 5 Links geliked!\n\n━━━━━━━━━━━━━━\n⏳ XP gibt es um 12:00 Uhr', { parse_mode: 'Markdown' }); } catch (e) {}
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
        const gestrigeInstaLinks = gestrigeLinks.filter(l => istInstagramLink(l.text) && String(l.user_id) !== String(uid));
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
                if (wMission.m2Tage >= 7) {
                    xpAdd(uid, 15, name);
                    addDiamond(uid, 1);
                    speichern();
                    meldungen.push('🏆 *Wochen-M2!* +15 XP + 💎 1 Diamant');
                    wMission.m2Tage = 0;
                }
            }
        }
        // FIX 5: gesamtGestern > 0 statt minLinksVorhanden
        if (gesamtGestern > 0 && gelikedGestern === gesamtGestern) {
            mission.m3 = true;
            xpAdd(uid, 5, name);
            addDiamond(uid, 1);
            meldungen.push('✅ *Mission 3!*\nAlle Links geliked → +5 XP + 💎 1 Diamant');
            if (wMission.letzterTag !== gestern) {
                wMission.m3Tage++;
                if (wMission.m3Tage >= 7) {
                    xpAdd(uid, 20, name);
                    addDiamond(uid, 2);
                    speichern();
                    meldungen.push('🏆 *Wochen-M3!* +20 XP + 💎 2 Diamanten');
                    wMission.m3Tage = 0;
                }
            }
        }

        wMission.letzterTag = gestern;

        const hatGesternLink = Object.values(d.links).some(l => istInstagramLink(l.text) && String(l.user_id) === String(uid) && new Date(l.timestamp).toDateString() === gestern);

        if (!d.m1Streak[uid]) d.m1Streak[uid] = { count: 0, letzterTag: null };
        if (queue.m1Pending) {
            d.m1Streak[uid].count++;
            d.m1Streak[uid].letzterTag = gestern;
            if (d.m1Streak[uid].count >= 5 && d.users[uid]?.warnings > 0) {
                d.users[uid].warnings--;
                d.m1Streak[uid].count = 0;
                try { await bot.telegram.sendMessage(Number(uid), '🎉 *Warn entfernt!*\n5 Tage M1 in Folge!\n\n⚠️ Warns: ' + d.users[uid].warnings + '/5', { parse_mode: 'Markdown' }); } catch (e) {}
            }
        } else { d.m1Streak[uid].count = 0; }

        if (hatGesternLink && !queue.m1Pending && minLinksVorhanden && d.users[uid]) {
            d.users[uid].warnings = (d.users[uid].warnings || 0) + 1;
            try { await bot.telegram.sendMessage(Number(uid), '⚠️ *Verwarnung!*\n\nLink gepostet, aber M1 nicht erfüllt.\n\n⚠️ Warns: ' + d.users[uid].warnings + '/5', { parse_mode: 'Markdown' }); } catch (e) {}
        }

        if (meldungen.length > 0 && d.users[uid]) {
            const u = d.users[uid];
            const nb = xpBisNaechstesBadge(u.xp);
            try { await bot.telegram.sendMessage(Number(uid), '🎯 *Missions Auswertung*\n━━━━━━━━━━━━━━\n\n' + meldungen.join('\n\n') + '\n\n━━━━━━━━━━━━━━\n⭐ Gesamt: ' + u.xp + ' XP' + (nb ? '  ·  ⬆️ Noch ' + nb.fehlend + ' bis ' + nb.ziel : ''), { parse_mode: 'Markdown' }); } catch (e) {}
        } else if (d.users[uid]?.started && !hatGesternLink) {
            try { await bot.telegram.sendMessage(Number(uid), '📊 *Missions Auswertung*\n\n❌ Keine Mission erfüllt\n\nHeute neue Chance! 💪', { parse_mode: 'Markdown' }); } catch (e) {}
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
        let text = '📆 *Weekly Ranking*\n━━━━━━━━━━━━━━\n\n';
        text += (rank < 3 ? badges[rank] : '#' + (rank + 1)) + ' Platz ' + (rank + 1) + ' von ' + sorted.length + '\n';
        text += '⭐ ' + xp + ' XP diese Woche\n\n━━━━━━━━━━━━━━\n🏆 *Top 3:*\n';
        sorted.slice(0, 3).forEach(([tid, txp], i) => { text += badges[i] + ' ' + d.users[tid].name + '  ·  ' + txp + ' XP\n'; });
        text += '\n🔥 Weiter so, ' + u.name + '!';
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
    speichern();
    if (istPrivat(ctx.chat.type)) {
        const payload = ctx.startPayload;
        if (payload === 'melden') return startMeldenFlow(ctx, uid);
        if (payload === 'shop') return sendShopNachricht(ctx, uid);
        if (!u.instagram) { d.instaWarte[uid] = true; speichern(); return ctx.reply('📸 Willkommen!\n\nWie heißt dein Instagram Account?\n\n(z.B. max123)'); }
        return ctx.reply('✅ Bot gestartet!\n\n📋 /help für alle Befehle.');
    }
});

bot.command('help', async (ctx) => {
    const uid = ctx.from.id;
    const u = user(uid, ctx.from.first_name);
    const text = '📋 *Bot Hilfe*\n━━━━━━━━━━━━━━\n\n🔗 *Link System*\n• 1 Link pro Tag\n• Doppelte Links geblockt\n• 👍 Likes = XP\n\n👍 *Like System*\n• 1 Like pro Link\n• Kein Self-Like\n• +5 XP pro Like\n\n⭐ *Full Engagement (Superlinks)*\n• 1 Superlink pro Woche (Mo–Sa)\n• Alle Mitglieder müssen liken, kommentieren, teilen & speichern\n• Wer nicht engaged: −50 XP\n• /superlink — Status & posten\n\n🎯 *Tägliche Missionen*\n• M1: 5 Links liken → +5 XP\n• M2: 80% liken → +5 XP\n• M3: Alle liken → +5 XP\n• ⏳ Auswertung um 12:00 Uhr\n\n📅 *Wochen Missionen*\n• 7× M1 → +10 XP\n• 7× M2 → +15 XP\n• 7× M3 → +20 XP\n\n🏅 *Badges*\n• 🆕 New: 0–49 XP\n• 📘 Anfänger: 50–499 XP\n• ⬆️ Aufsteiger: 500–999 XP\n• 🏅 Erfahrener: 1000–4999 XP\n• 👑 Elite: 5000–9999 XP\n• 🌟 Elite+: 10000+ XP (2 Superlinks/Woche)\n\n━━━━━━━━━━━━━━\n👤 *Profil*\n• /profil — dein Profil\n• /profil @username — fremdes Profil\n• /setbio — Bio setzen\n• /setspitzname — Spitzname\n• /setinsta — Instagram\n\n📊 *Rankings*\n• /ranking — Gesamt\n• /dailyranking — Heute\n• /weeklyranking — Diese Woche\n\n🎁 *Sonstiges*\n• /daily — Täglicher Bonus\n• /missionen — Missions Übersicht\n• /superlink — Engagement Status';
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
    const gestern = new Date(Date.now() - 86400000).toDateString();

    // Gestrige Links für M2/M3 (bis 12:00 heute Zeit sie zu liken)
    const gestrigeLinks = Object.values(d.links).filter(l => 
        new Date(l.timestamp).toDateString() === gestern &&
        String(l.user_id) !== String(uid) &&
        istInstagramLink(l.text)
    );
    const gesamtGestern = gestrigeLinks.length;
    const gelikedGestern = gestrigeLinks.filter(l => l.likes.has(Number(uid))).length;
    const prozentGestern = gesamtGestern > 0 ? Math.round(gelikedGestern / gesamtGestern * 100) : 0;

    // Heutige Links für M1
    const heutigeLinks = Object.values(d.links).filter(l => new Date(l.timestamp).toDateString() === heute);

    // Auswertung bereits um 12:00?
    const jetzt = new Date();
    const auswertungHeute = jetzt.getHours() >= 12;
    const zeitBisAuswertung = auswertungHeute ? 'Auswertung bereits erfolgt' : 'Auswertung heute um 12:00 Uhr';

    let text = '🎯 *Deine Missionen*\n━━━━━━━━━━━━━━\n\n📅 *Täglich:*\n';
    text += (mission.m1 ? '✅' : '⬜') + ' M1: ' + mission.likesGegeben + '/5 Links geliked\n';
    text += (mission.m2 ? '✅' : '⬜') + ' M2: ' + gelikedGestern + '/' + gesamtGestern + ' (' + prozentGestern + '%)  — Ziel: 80%\n';
    text += (mission.m3 ? '✅' : '⬜') + ' M3: ' + gelikedGestern + '/' + gesamtGestern + ' alle\n';
    text += '\n⏰ ' + zeitBisAuswertung + '\n\n━━━━━━━━━━━━━━\n';
    text += '📆 *Wöchentlich:*\n🔹 W-M1: ' + wMission.m1Tage + '/7  ·  W-M2: ' + wMission.m2Tage + '/7  ·  W-M3: ' + wMission.m3Tage + '/7\n\n━━━━━━━━━━━━━━\n';
    text += '⭐ ' + u.xp + ' XP  ·  ' + u.role;
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
        (u.instagram ? '📸 @' + u.instagram : '') + (u.username ? (u.instagram ? '  ·  ' : '') + '@' + u.username : '') + ((u.instagram || u.username) ? '\n' : '') +
        '\n━━━━━━━━━━━━━━\n' +
        u.role + '  ·  ⭐ ' + u.xp + ' XP  ·  Lvl ' + u.level + '\n' +
        '🏆 Rang #' + rank + '\n' +
        '━━━━━━━━━━━━━━\n\n' +
        '📅 Heute: ' + (d.dailyXP[uid] || 0) + ' XP  ·  📆 Woche: ' + (d.weeklyXP[uid] || 0) + ' XP\n' +
        '👍 Likes heute: ' + (mission.likesGegeben || 0) + '  ·  👍 Gesamt: ' + u.totalLikes + '\n' +
        '🔗 Links: ' + u.links + (bonusL > 0 ? '  ·  🎁 Bonus: ' + bonusL : '') + '  ·  ⚠️ Warns: ' + u.warnings + '/5\n' +
        '🔥 Streak: ' + (u.streak || 0) + ' Tag' + ((u.streak||0) !== 1 ? 'e' : ''),
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
    let text = '🏆 *GESAMT RANKING*\n━━━━━━━━━━━━━━\n\n';
    sorted.forEach(([, u], i) => { text += (b[i] || (i + 1) + '.') + ' *' + u.name + '*  ' + u.role + '\n   ⭐ ' + u.xp + ' XP  ·  Lvl ' + u.level + '\n\n'; });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('dailyranking', async (ctx) => {
    const sorted = Object.entries(d.dailyXP).filter(([uid]) => d.users[uid] && !istAdminId(uid)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return ctx.reply('Heute noch keine XP.');
    const b = ['🥇', '🥈', '🥉'];
    let text = '📅 *TAGES RANKING*\n━━━━━━━━━━━━━━\n\n';
    sorted.forEach(([uid, xp], i) => { text += (b[i] || (i + 1) + '.') + ' *' + d.users[uid].name + '*  ' + d.users[uid].role + '\n   ⭐ ' + xp + ' XP\n\n'; });
    await ctx.reply(text, { parse_mode: 'Markdown' });
});

bot.command('weeklyranking', async (ctx) => {
    const sorted = Object.entries(d.weeklyXP).filter(([uid]) => d.users[uid] && !istAdminId(uid)).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (!sorted.length) return ctx.reply('Diese Woche noch keine XP.');
    const b = ['🥇', '🥈', '🥉'];
    let text = '📆 *WOCHEN RANKING*\n━━━━━━━━━━━━━━\n\n';
    sorted.forEach(([uid, xp], i) => { text += (b[i] || (i + 1) + '.') + ' *' + d.users[uid].name + '*  ' + d.users[uid].role + '\n   ⭐ ' + xp + ' XP\n\n'; });
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
    await ctx.reply('🎁 *Daily Bonus!*\n\n+' + bonus + ' XP erhalten!\n\n━━━━━━━━━━━━━━\n⭐ ' + u.xp + ' XP  ·  ' + u.role + '\n━━━━━━━━━━━━━━', { parse_mode: 'Markdown' });
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
    try { await ctx.telegram.unbanChatMember(ctx.chat.id, userId); if (d.users[userId]) { d.users[userId].warnings = 0; speichern(); } await ctx.reply('✅ Entbannt!'); }
    catch (e) { await ctx.reply('❌ Fehler.'); }
});

bot.command('fixlink', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const reply = ctx.message.reply_to_message;
    if (!reply) return ctx.reply('❌ Antworte auf eine Link-Nachricht mit /fixlink');
    const text = reply.text || reply.caption || '';
    const url = linkUrl(text);
    if (!url) return ctx.reply('❌ Kein Link in der Nachricht gefunden.');
    const userId = reply.from?.id;
    const userName = reply.from?.first_name || 'User';
    const u = userId ? user(userId, userName) : {};
    const msgId = reply.message_id;
    try { await ctx.telegram.deleteMessage(ctx.chat.id, msgId); } catch (e) {}
    try { await ctx.deleteMessage(); } catch (e) {}
    const isAdmin = istAdminId(userId);
    let botMsg;
    try {
        botMsg = await bot.telegram.sendMessage(ctx.chat.id,
            buildLinkKarte(userName, u.role || '🆕 New', url, 0, u.xp || 0, isAdmin),
            { reply_markup: buildLinkButtons(msgId, 0) }
        );
    } catch (e) { return ctx.reply('❌ Fehler: ' + e.message); }
    const mapKey = MEINE_GRUPPE + '_' + msgId;
    d.links[mapKey] = { chat_id: ctx.chat.id, user_id: userId, user_name: userName, text: url, likes: new Set(), likerNames: {}, counter_msg_id: botMsg.message_id, timestamp: Date.now() };
    if (!istAdminId(userId) && userId) { u.links = (u.links || 0) + 1; updateStreak(String(userId)); }
    speichern();
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

bot.command('dellink', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const suche = ctx.message.text.replace('/dellink', '').trim().toLowerCase();
    if (!suche) return ctx.reply('❌ Nutze: /dellink <suchwort>');
    const treffer = Object.entries(d.links).filter(([, l]) => (l.text || '').toLowerCase().includes(suche));
    if (!treffer.length) return ctx.reply('❌ Keine Links mit "' + suche + '" gefunden.');
    let geloescht = 0;
    const deletedMsgIds = new Set();
    for (const [key, l] of treffer) {
        if (l.counter_msg_id && l.chat_id) {
            try { await bot.telegram.deleteMessage(l.chat_id, l.counter_msg_id); } catch(e) {}
            deletedMsgIds.add(String(l.counter_msg_id));
        }
        delete d.links[key];
        geloescht++;
    }
    // Aus threadMessages und communityFeed entfernen
    for (const threadId of Object.keys(d.threadMessages || {})) {
        const vorher = d.threadMessages[threadId].length;
        d.threadMessages[threadId] = d.threadMessages[threadId].filter(m => !deletedMsgIds.has(String(m.msg_id)));
        // last_msg in d.threads aktualisieren falls gelöscht
        if (d.threadMessages[threadId].length !== vorher) {
            const thr = (d.threads||[]).find(t => String(t.id) === threadId);
            if (thr) {
                thr.last_msg = d.threadMessages[threadId][0] || null;
                thr.msg_count = d.threadMessages[threadId].length;
            }
        }
    }
    if (d.communityFeed) {
        d.communityFeed = d.communityFeed.filter(m => !deletedMsgIds.has(String(m.msg_id)));
    }
    speichern();
    await ctx.reply('✅ ' + geloescht + ' Link(s) mit "' + suche + '" aus Telegram + Web-Feed gelöscht.');
});
bot.command('testmissionauswertung', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return;
    const gestern = new Date(Date.now() - 86400000).toDateString();
    for (const uid of Object.keys(d.missionQueue)) d.missionQueue[uid].date = gestern;
    d.missionAuswertungErledigt = {};
    await missionenAuswerten();
    await ctx.reply('✅ Auswertung!');
});
bot.command('cleanlinks', async (ctx) => {
    if (!istAdminId(ctx.from.id) && !await istAdmin(ctx, ctx.from.id)) {
        return ctx.reply('❌ Nur für Admins.');
    }
    const vorher = Object.keys(d.links).length;
    await ctx.reply('🔍 Prüfe alle ' + vorher + ' Links...');
    const keys = Object.keys(d.links);
    let removed = 0;
    for (const key of keys) {
        const link = d.links[key];
        if (!link?.chat_id || !link?.counter_msg_id) { delete d.links[key]; removed++; continue; }
        try {
            await bot.telegram.editMessageReplyMarkup(
                link.chat_id, link.counter_msg_id, null,
                buildLinkButtons(link.counter_msg_id, link.likes?.size || 0)
            );
        } catch(e) {
            const errText = ((e?.response?.description || '') + ' ' + (e?.message || '')).toLowerCase();
            const isGone = errText.includes('message to edit not found') || errText.includes('message not found') || errText.includes('message_id_invalid');
            const isNotModified = errText.includes('not modified');
            if (isGone && !isNotModified) {
                console.log('[cleanlinks] Lösche key=' + key + ' err=' + (e?.response?.description || e?.message));
                if (d.dmNachrichten) delete d.dmNachrichten[String(link.counter_msg_id)];
                delete d.links[key]; removed++;
            }
        }
        await new Promise(r => setTimeout(r, 200));
    }
    if (removed) speichern();
    await ctx.reply('✅ ' + removed + ' gelöschte Links bereinigt. Vorher: ' + vorher + ' → Jetzt: ' + Object.keys(d.links).length);
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
    if (u.instagram) text += '📸 [@' + u.instagram + '](https://instagram.com/' + u.instagram + ')';
    if (u.username) text += (u.instagram ? '  ·  ' : '') + '💬 @' + u.username;
    if (u.instagram || u.username) text += '\n';
    if (u.bio) text += '✍️ _' + u.bio + '_\n';
    text += '\n━━━━━━━━━━━━━━\n';
    text += u.role + '  ·  ⭐ ' + (u.xp || 0) + ' XP  ·  Lvl ' + (u.level || 1) + '\n';
    text += '🏆 Rang #' + rank + '\n';
    text += '━━━━━━━━━━━━━━\n\n';
    text += '📅 Heute: ' + (d.dailyXP[zielUid] || 0) + ' XP  ·  📆 Woche: ' + (d.weeklyXP[zielUid] || 0) + ' XP\n';
    text += '🔗 ' + (u.links || 0) + ' Links  ·  👍 ' + (u.totalLikes || 0) + ' Likes\n';
    if (bonusL > 0) text += '🎁 Bonus Links: ' + bonusL + '\n';
    text += '⚠️ Warns: ' + (u.warnings || 0) + '/5  ·  📆 Seit: ' + joinDatum + '\n';
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
const restoreWaiting = new Set();

async function startMeldenFlow(ctx, uid) {
    try {
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
}

bot.command('melden', async (ctx) => {
    const uid = ctx.from.id;
    if (istAdminId(uid)) return;
    try {
        if (!istPrivat(ctx.chat.type)) {
            const info = await ctx.telegram.getMe();
            return ctx.reply('📩 Bitte melde im privaten Chat!', {
                reply_markup: Markup.inlineKeyboard([[Markup.button.url('📩 Hier melden', 'https://t.me/' + info.username + '?start=melden')]]).reply_markup
            });
        }
        await startMeldenFlow(ctx, uid);
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
// TELEGRAM SHOP
// ================================
async function sendShopNachricht(ctx, uid) {
    const u = d.users[String(uid)];
    if (!u) return ctx.reply('❌ Bitte zuerst der Gruppe beitreten.');
    const diamonds = u.diamonds || 0;
    const bonusLinks = d.bonusLinks?.[String(uid)] || 0;
    const week = getBerlinWeekKey();
    const isElitePlusShop = u.role === '🌟 Elite+';
    const maxSLShop = isElitePlusShop ? 2 : 1;
    const slThisWeekShop = Object.values(d.superlinks||{}).filter(s => s.uid === String(uid) && s.week === week).length;
    const hasSLThisWeek = slThisWeekShop >= maxSLShop;
    const canBuyEl = diamonds >= 5;
    const canBuySL = diamonds >= 10 && !hasSLThisWeek;
    await ctx.reply(
        '🛒 *Telegram Shop*\n━━━━━━━━━━━━━━\n\n' +
        '💎 Dein Guthaben: *' + diamonds + ' Diamanten*\n\n' +
        '🔗 *Extra-Link — 5 💎*\nErlaubt dir heute einen zusätzlichen Link zu posten.\nVorhanden: ' + bonusLinks + '\n\n' +
        '⭐ *Superlink — 10 💎*\n' + maxSLShop + '× pro Woche im Full Engagement Thread.\nWird beim Posten via /superlink abgezogen.' +
        '\nDiese Woche: ' + slThisWeekShop + '/' + maxSLShop + (hasSLThisWeek ? ' ✅' : ''),
        {
            parse_mode: 'Markdown',
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('🔗 Extra-Link kaufen — 5 💎' + (canBuyEl ? '' : ' (zu wenig 💎)'), 'shopbuy_el')],
                [Markup.button.callback('⭐ Superlink posten → /superlink', 'shopinfo_sl')],
                [Markup.button.callback('🔄 Aktualisieren', 'shop_refresh')],
            ]).reply_markup
        }
    );
}

bot.command('shop', async (ctx) => {
    const uid = ctx.from.id;
    if (istAdminId(uid)) return;
    if (!istPrivat(ctx.chat.type)) {
        try {
            await sendShopNachricht({ reply: (text, opts) => bot.telegram.sendMessage(uid, text, opts) }, uid);
            await ctx.reply('🛒 Shop wurde dir per DM gesendet!');
        } catch(e) {
            await ctx.reply('❌ Bitte starte zuerst den Bot: @' + (await ctx.telegram.getMe()).username);
        }
        return;
    }
    await sendShopNachricht(ctx, uid);
});

bot.action('shopbuy_el', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        const uid = String(ctx.from.id);
        const u = d.users[uid];
        if (!u) return;
        if ((u.diamonds||0) < 5) return ctx.reply('❌ Nicht genug Diamanten (benötigt: 5, vorhanden: ' + (u.diamonds||0) + ')');
        u.diamonds -= 5;
        if (!d.bonusLinks) d.bonusLinks = {};
        d.bonusLinks[uid] = (d.bonusLinks[uid] || 0) + 1;
        speichern();
        addNotification(uid, '🔗', 'Extra-Link gekauft! Du kannst heute einen zusätzlichen Link posten. 💎 -5 Diamanten.');
        await ctx.reply('✅ *Extra-Link gekauft!*\n\n💎 Verbleibend: ' + u.diamonds + ' Diamanten\n🔗 Bonus-Links: ' + d.bonusLinks[uid], { parse_mode: 'Markdown' });
    } catch(e) { console.log('shopbuy_el Fehler:', e.message); }
});

bot.action('shopinfo_sl', async (ctx) => {
    try {
        await ctx.answerCbQuery('Nutze /superlink um deinen Superlink zu posten (10 💎).');
    } catch(e) {}
});

bot.action('shop_refresh', async (ctx) => {
    try {
        await ctx.answerCbQuery('🔄 Aktualisiert!');
        await ctx.deleteMessage().catch(()=>{});
        await sendShopNachricht(ctx, ctx.from.id);
    } catch(e) {}
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

    const appLink = APP_URL || 'https://creatorx.app';
    await ctx.reply(
        '🔐 *Dein CreatorX Login Code*\n\n' +
        '`' + u.appCode + '`\n\n' +
        '👆 Tippe auf den Code zum Kopieren\n\n' +
        '🌐 *Link zur App:*\n' + appLink + '\n\n' +
        '⚠️ *Wichtig:* Öffne den Link in einem richtigen Browser (Chrome, Safari) — nicht direkt in Telegram!\n\n' +
        '👉 Entweder den Link kopieren und im Browser eingeben, oder auf den Link tippen → dann oben rechts „Im Browser öffnen" wählen.\n\n' +
        '📲 *App auf Homescreen hinzufügen:*\n' +
        '• *iPhone (Safari):* Teilen-Symbol → „Zum Home-Bildschirm"\n' +
        '• *Android (Chrome):* Menü (⋮) → „Zum Startbildschirm hinzufügen"\n\n' +
        '⚠️ Teile deinen Code mit niemandem!',
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🚀 App öffnen', url: appLink }]] } }
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
            delete d.wochenMissionen[uid];
            delete d.missionQueue[uid];
            delete d.m1Streak[uid];
            if (d.notifications) delete d.notifications[uid];
            speichern();
            console.log('User gelöscht:', m.first_name, uid);
        }
    } catch(e) { console.log('left_chat_member Fehler:', e.message); }
});

// Capture forum topic names when topics are created
bot.on('message', async (ctx, next) => {
    if (ctx.chat?.id === GROUP_B_ID && ctx.message?.forum_topic_created) {
        const name = ctx.message.forum_topic_created.name;
        const emoji = ctx.message.forum_topic_created.icon_emoji_id || '📌';
        const topicId = String(ctx.message.message_id);
        if (!d.threads) d.threads = [];
        const existing = d.threads.find(t => String(t.id) === topicId);
        if (existing) { existing.name = name; existing.emoji = emoji; }
        else d.threads.push({ id: Number(topicId), name, emoji, last_msg: null, msg_count: 0 });
        speichern();
    }
    return next();
});

bot.on('message', async (ctx) => {
    try {
        const uid_msg = ctx.from.id;

        // Restore Data via document upload
        if (restoreWaiting.has(uid_msg) && ctx.message?.document) {
            const doc = ctx.message.document;
            restoreWaiting.delete(uid_msg);
            try {
                const fileLink = await bot.telegram.getFileLink(doc.file_id);
                const resp = await fetch(fileLink.href);
                const text = await resp.text();
                const parsed = JSON.parse(text);
                Object.assign(d, parsed);
                speichern();
                await ctx.reply(`✅ Daten wiederhergestellt! ${Object.keys(parsed.users||{}).length} User geladen.`);
            } catch (e) {
                await ctx.reply('❌ Fehler beim Laden: ' + e.message);
            }
            return;
        }

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

        // Superlink-Wartestand: User antwortet mit Instagram-Link nach /superlink
        if (istPrivat(ctx.chat.type) && _slWaiting?.[String(ctx.from.id)]) {
            const uid = String(ctx.from.id);
            const waitedAt = _slWaiting[uid];
            if (Date.now() - waitedAt < 5 * 60 * 1000) { // 5 Minuten Fenster
                const text = ctx.message.text || '';
                if (text.includes('instagram.com')) {
                    delete _slWaiting[uid];
                    await handleSuperlink(ctx, uid, d.users[uid], text).catch(e => ctx.reply('❌ Fehler: ' + e.message));
                    return;
                } else if (text && !text.startsWith('/')) {
                    await ctx.reply('❌ Bitte sende einen gültigen Instagram-Link (instagram.com/...)');
                    return;
                }
            } else {
                delete _slWaiting[uid];
            }
        }

        if (!ctx.message || !ctx.from) return;
        if (!istGruppe(ctx.chat.type)) return;

        // Community Feed – alle GROUP_B Nachrichten (außer Bot)
        if (ctx.chat.id === GROUP_B_ID && !ctx.from.is_bot) {
            const threadId = String(ctx.message.message_thread_id || 'general');
            const senderUid = String(ctx.from.id);

            // Full Engagement thread → handle as Superlink
            if (d.fullEngagementThreadId && threadId === String(d.fullEngagementThreadId)) {
                const text = ctx.message.text || ctx.message.caption || '';
                if (text && text.includes('instagram.com')) {
                    await handleSuperlink(ctx, senderUid, d.users[senderUid], text).catch(()=>{});
                } else if (text && !ctx.from.is_bot) {
                    try { await ctx.deleteMessage(); } catch(e) {}
                    try { await bot.telegram.sendMessage(Number(senderUid), '⭐ Hier nur Instagram-Links posten! Nutze z.B.: https://www.instagram.com/p/XYZ'); } catch(e) {}
                }
                return;
            }

            const senderUser = d.users[senderUid];
            let msgType = 'text', msgContent = '', mediaId = null;
            if (ctx.message.text) {
                msgContent = ctx.message.text; msgType = 'text';
            } else if (ctx.message.photo?.length) {
                mediaId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                msgContent = ctx.message.caption || ''; msgType = 'photo';
            } else if (ctx.message.sticker) {
                mediaId = ctx.message.sticker.file_id;
                msgContent = ctx.message.sticker.emoji || '🎭'; msgType = 'sticker';
            } else if (ctx.message.video) {
                msgContent = ctx.message.caption || ''; msgType = 'video';
            }
            if (msgType) {
                const tgName = ctx.from.username ? '@' + ctx.from.username : null;
                const entry = {
                    uid: senderUid,
                    tgName,
                    name: senderUser?.spitzname || senderUser?.name || ctx.from.first_name || 'Unbekannt',
                    role: senderUser?.role || null,
                    type: msgType,
                    text: msgContent,
                    mediaId,
                    timestamp: (ctx.message.date || Math.floor(Date.now() / 1000)) * 1000,
                    msg_id: ctx.message.message_id,
                };
                if (!d.threadMessages[threadId]) d.threadMessages[threadId] = [];
                d.threadMessages[threadId].unshift(entry);
                if (d.threadMessages[threadId].length > 100) d.threadMessages[threadId] = d.threadMessages[threadId].slice(0, 100);
                // Update or auto-create thread metadata
                if (!d.threads) d.threads = [];
                let thr = d.threads.find(t => String(t.id) === threadId);
                if (!thr) {
                    thr = { id: threadId === 'general' ? 'general' : Number(threadId), name: threadId === 'general' ? 'Allgemein' : `Thread ${threadId}`, emoji: threadId === 'general' ? '💬' : '📌', last_msg: null, msg_count: 0 };
                    threadId === 'general' ? d.threads.unshift(thr) : d.threads.push(thr);
                }
                thr.last_msg = entry; thr.msg_count = d.threadMessages[threadId].length;
                // Track daily group messages
                if (!d.dailyGroupMsgs[senderUid]) d.dailyGroupMsgs[senderUid] = 0;
                d.dailyGroupMsgs[senderUid]++;
                // Backwards compat communityFeed
                if (msgType === 'text') {
                    if (!d.communityFeed) d.communityFeed = [];
                    d.communityFeed.unshift({ username: tgName || entry.name, name: entry.name, text: msgContent, timestamp: entry.timestamp, thread_id: threadId === 'general' ? null : Number(threadId), msg_id: entry.msg_id });
                    if (d.communityFeed.length > 100) d.communityFeed = d.communityFeed.slice(0, 100);
                }
            }
        }

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
            const isAdmin = istAdminId(uid);
            let botMsg;
            try {
                botMsg = await bot.telegram.sendMessage(ctx.chat.id,
                    buildLinkKarte(ctx.from.first_name, u.role, text, 0, u.xp, isAdmin),
                    { reply_markup: buildLinkButtons(msgId, 0) }
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
        } else if (!istAdminId(uid)) {
            const mapKey = MEINE_GRUPPE + '_' + msgId;
            d.links[mapKey] = { chat_id: ctx.chat.id, user_id: uid, user_name: ctx.from.first_name, text: text, likes: new Set(), likerNames: {}, counter_msg_id: msgId, timestamp: Date.now() };
        }
        speichern();
    } catch (e) { console.log('Message Handler Fehler:', e.message); }
});

function buildLinkKarte(name, role, link, anz, xp, isAdmin) {
    const header = isAdmin ? '⚙️ Admin ' + name : '👤 ' + name + '  ' + role;
    const stats = isAdmin ? '👍 ' + anz : '👍 ' + anz + '   ⭐ ' + xp + ' XP';
    return header + '\n🔗 ' + link + '\n\n━━━━━━━━━━━━━━\n' + stats + '\n━━━━━━━━━━━━━━';
}

function buildLinkButtons(msgId, anz) {
    return Markup.inlineKeyboard([[
        Markup.button.callback('👍 Like · ' + anz, 'like_' + msgId),
        Markup.button.callback('👁 Liker', 'liker_' + msgId)
    ]]).reply_markup;
}

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
        if (String(uid) === String(lnk.user_id)) { try { await ctx.answerCbQuery('❌ Kein Self-Like!'); } catch (e) {} return; }
        if (lnk.likes.has(uid)) { try { await ctx.answerCbQuery('✅ Bereits geliked! (auch via App möglich)'); } catch (e) {} return; }

        lnk.likes.add(uid);
        lnk.likerNames[uid] = { name: ctx.from.first_name, insta: d.users[uid]?.instagram || null };
        const anz = lnk.likes.size;
        const poster = user(lnk.user_id, lnk.user_name);
        poster.totalLikes++;
        // Benachrichtigung an Poster
        if (!istAdminId(uid) && lnk.user_id !== uid) {
            const likerName = d.users[uid]?.spitzname || d.users[uid]?.name || 'Jemand';
            addNotification(String(lnk.user_id), '❤️', likerName + ' hat deinen Link geliked');
        }

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
        const feedbackText = istAdminId(uid) ? '✅ Like registriert! (Admin)' : `🎉 +${vergebenXP} XP${eventBonus}  ·  ⭐ ` + liker.xp + '\n' + liker.role + (nb ? '  ·  ⬆️ Noch ' + nb.fehlend + ' bis ' + nb.ziel : '');

        const feedbackMsg = await ctx.reply(feedbackText);
        setTimeout(async () => { try { await ctx.telegram.deleteMessage(ctx.chat.id, feedbackMsg.message_id); } catch (e) {} }, 8000);

        try { await ctx.answerCbQuery('👍 ' + anz + '!'); } catch (e) {}

        try {
            await ctx.telegram.editMessageText(lnk.chat_id, lnk.counter_msg_id, null,
                buildLinkKarte(lnk.user_name, poster.role, lnk.text, anz, poster.xp, istAdminId(lnk.user_id)),
                { reply_markup: buildLinkButtons(msgId, anz) }
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

bot.action(/^liker_(\d+)$/, async (ctx) => {
    const msgId = parseInt(ctx.match[1]);
    const mapKey = MEINE_GRUPPE + '_' + msgId;
    let lnk = d.links[mapKey];
    if (!lnk) {
        lnk = d.links[msgId] || Object.values(d.links).find(l => String(l.counter_msg_id) === String(msgId));
    }
    if (!lnk) { try { await ctx.answerCbQuery('❌ Nicht gefunden.'); } catch (e) {} return; }

    const names = Object.values(lnk.likerNames || {}).map(l => l.name);
    if (!names.length) { try { await ctx.answerCbQuery('Noch keine Likes 👀', { show_alert: true }); } catch (e) {} return; }

    // Show all liker names; Telegram alert max ~200 chars
    let text = '👥 ' + names.join(', ');
    if (text.length > 195) {
        let shown = 0;
        let built = '👥 ';
        for (const n of names) {
            if ((built + n).length > 185) { built += `+${names.length - shown} weitere`; break; }
            built += (shown > 0 ? ', ' : '') + n;
            shown++;
        }
        text = built;
    }
    try { await ctx.answerCbQuery(text, { show_alert: true }); } catch (e) {}
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

// ── SUPERLINK ACTIONS ──
const slLikeInProgress = new Set();
const _slWaiting = {};
bot.action(/^sllike_(.+)$/, async (ctx) => {
    const slId = ctx.match[1];
    const uid = String(ctx.from.id);
    if (slLikeInProgress.has(uid + '_' + slId)) return ctx.answerCbQuery('⏳');
    slLikeInProgress.add(uid + '_' + slId);
    try {
        const sl = d.superlinks?.[slId];
        if (!sl) return ctx.answerCbQuery('❌ Nicht gefunden');
        if (sl.uid === uid) return ctx.answerCbQuery('❌ Du kannst deinen eigenen Link nicht liken');
        if (!Array.isArray(sl.likes)) sl.likes = [];
        if (!sl.likerNames) sl.likerNames = {};
        const idx = sl.likes.indexOf(uid);
        if (idx >= 0) {
            sl.likes.splice(idx, 1);
            delete sl.likerNames[uid];
            await ctx.answerCbQuery('💔 Like entfernt');
        } else {
            sl.likes.push(uid);
            const u = d.users[uid];
            sl.likerNames[uid] = u?.spitzname||u?.name||ctx.from.first_name||'User';
            addNotification(sl.uid, '❤️', (sl.likerNames[uid]) + ' hat deinen Superlink geliked!');
            await ctx.answerCbQuery('❤️ Geliked!');
        }
        speichern();
        await updateSuperLinkCard(slId);
    } finally { slLikeInProgress.delete(uid + '_' + slId); }
});

bot.action(/^slliker_(.+)$/, async (ctx) => {
    const slId = ctx.match[1];
    const uid = String(ctx.from.id);
    const sl = d.superlinks?.[slId];
    if (!sl) return ctx.answerCbQuery('❌ Nicht gefunden');
    await ctx.answerCbQuery();
    const likes = Array.isArray(sl.likes) ? sl.likes : [];
    const isPoster = sl.uid === uid;
    const poster = d.users[sl.uid];
    const posterName = poster?.spitzname||poster?.name||'User';
    if (!likes.length) {
        return bot.telegram.sendMessage(ctx.chat.id,
            '👁 *Superlink von ' + posterName + '*\n\nNoch keine Likes.',
            { parse_mode:'Markdown', message_thread_id: ctx.callbackQuery?.message?.message_thread_id||undefined }
        );
    }
    let text = '👁 *Likes für Superlink von ' + posterName + ':*\n' + sl.url.slice(0,50) + '\n\n';
    const buttons = [];
    likes.forEach((likerUid, i) => {
        const liker = d.users[String(likerUid)];
        const name = liker?.spitzname||liker?.name||'User';
        text += (i + 1) + '. ' + name + '\n';
        if (isPoster) buttons.push([Markup.button.callback('🚩 ' + name + ' melden', 'slrepuser_' + slId + '_' + likerUid)]);
    });
    if (!isPoster) text += '\n_Nur der Poster kann Engager melden._';
    await bot.telegram.sendMessage(ctx.chat.id, text, {
        parse_mode: 'Markdown',
        message_thread_id: ctx.callbackQuery?.message?.message_thread_id||undefined,
        reply_markup: buttons.length ? Markup.inlineKeyboard(buttons).reply_markup : undefined,
    });
});

bot.action(/^slrepuser_(\w+)_(\d+)$/, async (ctx) => {
    try {
        const slId = ctx.match[1];
        const likerUid = ctx.match[2];
        const reporterUid = String(ctx.from.id);
        const sl = d.superlinks?.[slId];
        if (!sl) return ctx.answerCbQuery('❌ Nicht gefunden');
        if (sl.uid !== reporterUid) return ctx.answerCbQuery('❌ Nur der Poster kann melden');
        const reporter = d.users[reporterUid];
        const liker = d.users[likerUid];
        const adminMsg = '🚨 *Engagement Report*\n\n' +
            '👤 *Poster:* ' + (reporter?.spitzname||reporter?.name||'User') + '\n' +
            '🚩 *Gemeldet:* ' + (liker?.spitzname||liker?.name||likerUid) + '\n' +
            '🔗 ' + sl.url + '\n' +
            'Grund: Hat nicht vollständig geliked/kommentiert/geteilt/gespeichert\n' +
            '📅 Woche: ' + sl.week;
        for (const adminId of ADMIN_IDS) {
            try { await bot.telegram.sendMessage(Number(adminId), adminMsg, { parse_mode: 'Markdown' }); } catch(e){}
        }
        await ctx.answerCbQuery('✅ ' + (liker?.name||'User') + ' wurde gemeldet!', { show_alert: true });
    } catch(e) { console.log('slrepuser Fehler:', e.message); await ctx.answerCbQuery('❌ Fehler'); }
});

bot.action(/^slrep_(.+)$/, async (ctx) => {
    try {
        const slId = ctx.match[1];
        const reporterUid = String(ctx.from.id);
        const sl = d.superlinks?.[slId];
        if (!sl) return ctx.answerCbQuery('❌ Superlink nicht gefunden.');
        if (sl.uid === reporterUid) return ctx.answerCbQuery('❌ Du kannst deinen eigenen Superlink nicht melden.');
        const reporter = d.users[reporterUid];
        const poster = d.users[sl.uid];
        const adminMsg = '🚩 *Superlink Meldung*\n\n' +
            '📌 *Gemeldeter Superlink:*\n' +
            '👤 Poster: ' + (poster?.spitzname||poster?.name||sl.uid) + '\n' +
            '🔗 ' + sl.url + (sl.caption ? '\n💬 ' + sl.caption : '') + '\n\n' +
            '👤 *Gemeldet von:* ' + (reporter?.spitzname||reporter?.name||ctx.from.first_name) + (ctx.from.username ? ' @' + ctx.from.username : '') + '\n' +
            '📅 Woche: ' + sl.week;
        for (const adminId of ADMIN_IDS) {
            try { await bot.telegram.sendMessage(Number(adminId), adminMsg, { parse_mode: 'Markdown' }); } catch(e){}
        }
        await ctx.answerCbQuery('✅ Superlink wurde gemeldet! Admins wurden informiert.', { show_alert: true });
    } catch(e) { console.log('slrep Fehler:', e.message); await ctx.answerCbQuery('❌ Fehler'); }
});

bot.command('checkengagement', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    const weekKey = getBerlinWeekKey();
    const weekSuperlinks = Object.values(d.superlinks||{}).filter(s => s.week === weekKey);
    if (!weekSuperlinks.length) return ctx.reply('📊 Keine Superlinks diese Woche.');
    const posters = [...new Set(weekSuperlinks.map(s => s.uid))];
    let report = `📊 *Full Engagement Woche ${weekKey}*\n${weekSuperlinks.length} Superlinks von ${posters.length} Usern\n\n`;
    for (const uid of posters) {
        const u = d.users[uid];
        const name = u?.spitzname||u?.name||uid;
        const otherLinks = weekSuperlinks.filter(s => s.uid !== uid);
        const likedCount = otherLinks.filter(s => Array.isArray(s.likes) && s.likes.includes(uid)).length;
        const status = likedCount >= otherLinks.length ? '✅' : `⚠️ ${likedCount}/${otherLinks.length}`;
        report += `${status} ${name}\n`;
    }
    await ctx.reply(report, { parse_mode: 'Markdown' });
});

bot.command('runengagementcheck', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    await ctx.reply('⏳ Führe Engagement-Check durch...');
    const result = await runEngagementCheck(false);
    await ctx.reply(`✅ Check abgeschlossen: ${result.checked} geprüft, ${result.warned} verwarnt`);
});

bot.command('fethread', async (ctx) => {
    if (!istAdminId(ctx.from.id)) return;
    if (!GROUP_B_ID) return ctx.reply('❌ GROUP_B_ID nicht gesetzt!');
    const oldId = d.fullEngagementThreadId;
    await ctx.reply(`ℹ️ Alter Thread-ID: ${oldId || 'nicht gesetzt'}\n⏳ Erstelle neuen Thread...`);
    d.fullEngagementThreadId = null;
    const threadId = await ensureFullEngagementThread();
    if (!threadId) return ctx.reply('❌ Thread-Erstellung fehlgeschlagen. Prüfe ob Gruppe B Forum-Modus aktiviert hat und Bot Admin ist.');
    try {
        await bot.telegram.sendMessage(GROUP_B_ID,
            '⭐ *Full Engagement Thread geöffnet!*\n\n' +
            'Hier könnt ihr eure Superlinks posten.\n\n' +
            '📌 *Regeln:*\n• 1–2 Superlinks pro Person pro Woche (Mo–Sa)\n• Wer postet, muss ALLE anderen liken, kommentieren, teilen & speichern\n• Verstoß: -50 XP\n\n' +
            '📲 Einfach euren Instagram-Link hier reinposten oder /superlink im Bot nutzen!',
            { parse_mode: 'Markdown', message_thread_id: Number(threadId) }
        );
    } catch(e) { await ctx.reply('⚠️ Thread erstellt aber Willkommensnachricht fehlgeschlagen: ' + e.message); }
    await ctx.reply(`✅ Full Engagement Thread erstellt! ID: ${threadId}`);
});

bot.command('superlink', async (ctx) => {
    const uid = String(ctx.from.id);
    const u = user(ctx.from.id, ctx.from.first_name);
    if (!u.started) return ctx.reply('⚠️ Starte zuerst den Bot per DM mit /start');
    if (istAdminId(ctx.from.id)) return ctx.reply('⚙️ Admins können keine Superlinks posten.');

    const weekKey = getBerlinWeekKey();
    const weekSuperlinks = Object.values(d.superlinks||{}).sort((a,b) => b.timestamp - a.timestamp).filter(s => s.week === weekKey);
    const isElitePlusSL = u.role === '🌟 Elite+';
    const maxSLCmd = isElitePlusSL ? 2 : 1;
    const mySlCountThisWeek = weekSuperlinks.filter(s => s.uid === uid).length;
    const mySlThisWeek = mySlCountThisWeek > 0;
    const canPost = mySlCountThisWeek < maxSLCmd && isSuperLinkPostingAllowed();

    let text = '⭐ *Full Engagement – Superlinks*\n\n';
    text += '📌 *Regeln:*\n• ' + maxSLCmd + ' Superlink' + (maxSLCmd > 1 ? 's' : '') + ' pro Woche (Mo–Sa)\n• Wer postet, MUSS alle anderen liken, kommentieren, teilen & speichern\n• Verstoß: -50 XP\n\n';

    if (weekSuperlinks.length === 0) {
        text += '📭 Noch keine Superlinks diese Woche.\n\n';
    } else {
        text += `📊 *Diese Woche: ${weekSuperlinks.length} Superlink${weekSuperlinks.length !== 1 ? 's' : ''}*\n`;
        for (const sl of weekSuperlinks) {
            const poster = d.users[sl.uid];
            const name = (poster?.spitzname || poster?.name || 'User').replace(/[*_`]/g, '');
            const liked = (sl.likes||[]).includes(uid);
            const isOwn = sl.uid === uid;
            const status = isOwn ? '(dein)' : liked ? '✅' : '❌ noch nicht geliked';
            text += `\n• *${name}* ${status}\n  ${sl.url}`;
        }
        text += '\n\n';
    }

    if (mySlCountThisWeek >= maxSLCmd) {
        text += `✅ *Du hast diese Woche bereits ${maxSLCmd}/${maxSLCmd} Superlink(s) gepostet.*`;
    } else if (!isSuperLinkPostingAllowed()) {
        text += '⏰ Superlinks können nur Mo–Sa gepostet werden.';
        if (mySlThisWeek) text += ` (${mySlCountThisWeek}/${maxSLCmd} diese Woche gepostet)`;
    } else if (mySlThisWeek && canPost) {
        text += `⭐ *${mySlCountThisWeek}/${maxSLCmd} Superlinks gepostet — noch 1 übrig!*\n📲 Schicke mir deinen Instagram-Link als nächste Nachricht.`;
        _slWaiting[uid] = Date.now();
    } else if (!u.instagram) {
        text += '⚠️ Bitte zuerst /setinsta verwenden.';
    } else {
        text += '📲 *Superlink posten:*\nSchicke mir deinen Instagram-Link als nächste Nachricht.';
        _slWaiting[uid] = Date.now();
    }

    const buttons = [];
    if (canPost && u.instagram) buttons.push([{ text: '🚀 Per App posten', url: APP_URL || 'https://creatorx.app' }]);

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined });
});

bot.command('restoredata', async (ctx) => {
    restoreWaiting.add(ctx.from.id);
    await ctx.reply('📂 Schicke mir jetzt die daten.json Datei als Dokument in diesen Chat.');
});

bot.action(/^slreport_(.+)$/, async (ctx) => {
    const parts = ctx.match[1].split('_');
    const slId = parts[0];
    const likerUid = parts[1];
    const sl = d.superlinks?.[slId];
    if (!sl) return ctx.answerCbQuery('❌ Nicht gefunden');
    const likerUser = d.users[likerUid];
    const likerName = likerUser?.spitzname||likerUser?.name||'User';
    meldenWarte.set(ctx.from.id, { step: 'nachricht', gemeldeterUid: likerUid, gemeldeterName: likerName, context: 'superlink', slId });
    await ctx.answerCbQuery('✅ Meldung geöffnet');
    await bot.telegram.sendMessage(ctx.from.id, `🚨 Melde ${likerName} wegen mangelndem Engagement.\n\nSchreibe jetzt die Details (oder einfach "Kein Engagement"):`, {});
});

async function topLinks(chatId) {
    const sorted = Object.values(d.links).sort((a, b) => b.likes.size - a.likes.size).slice(0, 3);
    if (!sorted.length) return;
    const b = ['🥇', '🥈', '🥉'];
    let text = '🔥 *Top Links*\n━━━━━━━━━━━━━━\n\n';
    sorted.forEach((l, i) => { text += b[i] + ' *' + l.user_name + '*  ·  ' + l.likes.size + ' 👍\n'; });
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
            batch.map(([uid]) => sendeDM(uid, '📢 Neuer Link!\n\n👤 ' + linkData.user_name + '\n🔗 ' + linkData.text + '\n\n━━━━━━━━━━━━━━\n👍 Bitte liken!',
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

async function aktivitätsScore(uid) {
    const logins = d.dailyLogins[uid] || 0;
    const groupMsgs = d.dailyGroupMsgs[uid] || 0;
    const m = d.missionen[uid];
    const heute = new Date().toDateString();
    const likesGegeben = (m?.date === heute ? m.likesGegeben || 0 : 0);
    const missionen = (m?.date === heute ? (m.m1 ? 1 : 0) + (m.m2 ? 1 : 0) + (m.m3 ? 1 : 0) : 0);
    return logins * 3 + groupMsgs * 2 + likesGegeben + missionen;
}

async function dailyRankingAbschluss() {
    const sorted = Object.entries(d.dailyXP).filter(([uid]) => d.users[uid] && d.dailyXP[uid] > 0 && !istAdminId(uid)).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return;
    // Tiebreaker: sort by activity score within same XP groups
    const withScore = await Promise.all(sorted.map(async ([uid, xp]) => ({ uid, xp, score: await aktivitätsScore(uid) })));
    withScore.sort((a, b) => b.xp !== a.xp ? b.xp - a.xp : b.score !== a.score ? b.score - a.score : Math.random() - 0.5);
    // Send tie notifications
    let i = 0;
    while (i < withScore.length) {
        const xp = withScore[i].xp;
        let j = i + 1;
        while (j < withScore.length && withScore[j].xp === xp) j++;
        if (j > i + 1) {
            const tiedGroup = withScore.slice(i, j);
            for (let k = 0; k < tiedGroup.length; k++) {
                const { uid } = tiedGroup[k];
                const myRank = i + k + 1;
                const otherNames = tiedGroup.filter((_, idx) => idx !== k).map(e => d.users[e.uid]?.spitzname || d.users[e.uid]?.name || 'User');
                const othersStr = otherNames.length === 1 ? otherNames[0] : otherNames.slice(0,-1).join(', ') + ' und ' + otherNames[otherNames.length-1];
                const rankRange = `Platz ${i+1}–${j}`;
                const msg = myRank <= 3
                    ? `🎲 *Gleichstand & Verlosung!*

Du und ${othersStr} hattet alle *${xp} XP* und wärt auf ${rankRange} gleichauf.

Eine automatische Verlosung nach Aktivität hat stattgefunden — du hast gewonnen! 🎉

🏆 *Dein aktueller Rang: Platz ${myRank}*
Top ${myRank} Bonus folgt!`
                    : `🎲 *Gleichstand & Verlosung!*

Du und ${othersStr} hattet alle *${xp} XP* und wärt auf ${rankRange} gleichauf.

Eine automatische Verlosung nach Aktivität hat stattgefunden — diesmal war ${tiedGroup[0] && tiedGroup[0].uid !== uid ? (d.users[tiedGroup[0].uid]?.spitzname || d.users[tiedGroup[0].uid]?.name || 'ein anderer User') : othersStr} vorne.

📊 *Dein aktueller Rang: Platz ${myRank}*
Mehr Aktivität morgen für einen besseren Platz! 💪`;
                try { await bot.telegram.sendMessage(Number(uid), msg, { parse_mode: 'Markdown' }); await new Promise(r => setTimeout(r, 200)); } catch (e) {}
            }
        }
        i = j;
    }
    const bel = [{ xp: 10, links: 1, text: '🥇' }, { xp: 5, links: 0, text: '🥈' }, { xp: 2, links: 0, text: '🥉' }];
    for (let i = 0; i < Math.min(3, withScore.length); i++) {
        const { uid } = withScore[i];
        const u = d.users[uid];
        const b = bel[i];
        xpAdd(uid, b.xp, u.name);
        if (b.links > 0) { if (!d.bonusLinks[uid]) d.bonusLinks[uid] = 0; d.bonusLinks[uid] += b.links; }
        try { await bot.telegram.sendMessage(Number(uid), `🎉 *${b.text} im Tagesranking!*\n\n+${b.xp} XP erhalten!` + (b.links > 0 ? '\n🔗 Extra Link für morgen!' : '') + '\n\n━━━━━━━━━━━━━━\n⭐ ' + d.users[uid].xp + ' XP Gesamt', { parse_mode: 'Markdown' }); } catch (e) {}
    }
    d.gesternDailyXP = Object.assign({}, d.dailyXP);
    d.dailyXP = {}; d.tracker = {}; d.counter = {}; d.badgeTracker = {};
    d.dailyLogins = {}; d.dailyGroupMsgs = {};
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
            String(l.user_id) !== String(uid) && !l.likes.has(Number(uid))
        );
        if (!nichtGeliked.length) continue;

        let text = '👋 *Hey ' + u.name + '!*\n\n━━━━━━━━━━━━━━\n⬜ Noch nicht geliked:\n\n';
        const buttons = [];

        for (const [, l] of nichtGeliked) {
            const insta = l.user_id ? (d.users[String(l.user_id)]?.instagram ? ' · 📸 @' + d.users[String(l.user_id)].instagram : '') : '';
            text += '👤 ' + l.user_name + insta + '\n';
            if (l.counter_msg_id && l.chat_id) {
                const url = 'https://t.me/c/' + String(l.chat_id).replace('-100', '') + '/' + l.counter_msg_id;
                buttons.push([{ text: '👍 ' + l.user_name + ' liken', url: url }]);
            }
        }

        text += '\n━━━━━━━━━━━━━━\n⏳ Missionen schließen um 12:00 Uhr!';

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
        const hatLinkHeute = Object.values(d.links).some(l => String(l.user_id) === String(uid) && new Date(l.timestamp).toDateString() === heute);
        if (!hatLinkHeute) continue;
        const fremde = Object.values(d.links).filter(l => istInstagramLink(l.text) && String(l.user_id) !== String(uid) && new Date(l.timestamp).toDateString() === heute);
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
                delete d.wochenMissionen[uid];
                delete d.missionQueue[uid];
                delete d.m1Streak[uid];
                if (d.notifications) delete d.notifications[uid];
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



function updateStreak(uid) {
    const u = d.users[uid];
    if (!u) return;
    const heute = new Date().toDateString();
    const gestern = new Date(Date.now() - 86400000).toDateString();
    if (u.lastStreakDay === heute) return; // Heute bereits gezählt
    if (u.lastStreakDay === gestern) {
        u.streak = (u.streak || 0) + 1; // Streak verlängern
    } else {
        u.streak = 1; // Streak neu starten
    }
    u.lastStreakDay = heute;
}

function addNotification(targetUid, icon, text) {
    if (!d.notifications) d.notifications = {};
    if (!d.notifications[targetUid]) d.notifications[targetUid] = [];
    d.notifications[targetUid].push({ icon, text, timestamp: Date.now(), read: false });
    // Max 50 Benachrichtigungen pro User
    if (d.notifications[targetUid].length > 50) d.notifications[targetUid].shift();
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

// ── CLEANUP: Gelöschte Telegram-Nachrichten aus d.links entfernen ──
let cleanupOffset = 0;
async function cleanupDeletedLinks() {
    const keys = Object.keys(d.links);
    if (!keys.length) return;
    const batch = keys.slice(cleanupOffset, cleanupOffset + 15);
    cleanupOffset = (cleanupOffset + 15) >= keys.length ? 0 : cleanupOffset + 15;
    let changed = false;
    for (const key of batch) {
        const link = d.links[key];
        if (!link?.chat_id || !link?.counter_msg_id) { delete d.links[key]; changed = true; continue; }
        try {
            await bot.telegram.editMessageReplyMarkup(
                link.chat_id, link.counter_msg_id, null,
                buildLinkButtons(link.counter_msg_id, link.likes?.size || 0)
            );
        } catch(e) {
            const errText = ((e?.response?.description || '') + ' ' + (e?.message || '')).toLowerCase();
            const isGone = errText.includes('message to edit not found') || errText.includes('message not found') || errText.includes('message_id_invalid');
            const isNotModified = errText.includes('not modified');
            if (isGone && !isNotModified) {
                if (d.dmNachrichten) delete d.dmNachrichten[String(link.counter_msg_id)];
                delete d.links[key];
                changed = true;
            }
        }
        await new Promise(r => setTimeout(r, 300));
    }
    if (changed) speichern();
}
setInterval(cleanupDeletedLinks, 3 * 60 * 1000); // alle 3 Minuten


app.get('/restore-upload', (req, res) => {
    const key = req.query.key;
    if (key !== BRIDGE_SECRET) return res.status(403).send('Falscher Key');
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Daten hochladen</title>
    <style>body{font-family:sans-serif;max-width:500px;margin:40px auto;padding:20px}
    input,textarea,button{width:100%;padding:12px;margin:8px 0;font-size:14px;box-sizing:border-box}
    button{background:#2563eb;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:16px}</style></head>
    <body><h2>📂 Daten wiederherstellen</h2>
    <p>Option 1: Datei hochladen</p>
    <form method="POST" action="/restore-upload?key=${key}" enctype="multipart/form-data">
    <input type="file" name="file" accept=".json" required>
    <button type="submit">Hochladen ✅</button></form>
    <hr><p>Option 2: JSON direkt einfügen</p>
    <form method="POST" action="/restore-json?key=${key}">
    <textarea name="json" rows="6" placeholder='{"users":{...}}'></textarea>
    <button type="submit">Einfügen ✅</button></form>
    </body></html>`);
});

app.post('/restore-json', express.urlencoded({ extended: true, limit: '50mb' }), (req, res) => {
    const key = req.query.key;
    if (key !== BRIDGE_SECRET) return res.status(403).send('Falscher Key');
    try {
        const parsed = JSON.parse(req.body.json);
        fs.writeFileSync(DATA_FILE, JSON.stringify(parsed));
        laden();
        res.send(`<h2>✅ ${Object.keys(d.users||{}).length} User, ${Object.keys(d.links||{}).length} Links geladen!</h2>`);
    } catch(e) { res.status(500).send('Fehler: ' + e.message); }
});

app.post('/restore-upload', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    const key = req.query.key;
    if (key !== BRIDGE_SECRET) return res.status(403).send('Falscher Key');
    try {
        const body = req.body.toString();
        const jsonMatch = body.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return res.status(400).send('Keine JSON Daten gefunden');
        fs.writeFileSync(DATA_FILE, jsonMatch[0]);
        laden();
        res.send(`<h2>✅ ${Object.keys(d.users||{}).length} User, ${Object.keys(d.links||{}).length} Links geladen!</h2>`);
    } catch (e) {
        res.status(500).send('Fehler: ' + e.message);
    }
});

app.get('/data', (req, res) => {
    const secret = req.headers['x-bridge-secret'] || req.query.secret;
    if (secret !== BRIDGE_SECRET) return res.status(403).json({ error: 'Forbidden' });
    const out = Object.assign({}, d);

    // Likes nach URL zusammenführen - Bridge Bot Links bekommen alle Likes
    const likesByUrl = {};
    for (const [k, v] of Object.entries(d.links)) {
        const url = (v.text||'').trim();
        if (!url) continue;
        if (!likesByUrl[url]) likesByUrl[url] = { likes: new Set(), likerNames: {} };
        v.likes.forEach(uid => likesByUrl[url].likes.add(uid));
        Object.assign(likesByUrl[url].likerNames, v.likerNames||{});
    }

    out.links = {};
    for (const [k, v] of Object.entries(d.links)) {
        const url = (v.text||'').trim();
        const merged = likesByUrl[url] || { likes: new Set(), likerNames: {} };
        out.links[k] = Object.assign({}, v, {
            likes: Array.from(merged.likes),
            likerNames: merged.likerNames
        });
    }
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
                if (uid && !istAdminId(Number(uid))) { d.users[uid].links = (d.users[uid].links || 0) + 1; updateStreak(uid); }
                speichernDebounced();
                await sendeLinkAnAlle(linkData);
            }
        }

        if (event.type === 'like_given') {
            const { mapKey, groupBMsgId } = event.meta || {};
            if (!mapKey || !uid) return;

            console.log('[LIKE_GIVEN] mapKey:', mapKey, 'groupBMsgId:', groupBMsgId, 'linkText:', event.meta?.linkText?.slice(0,30));
            console.log('[LIKE_GIVEN] Links in d.links:', Object.keys(d.links).length, 'keys sample:', Object.keys(d.links).slice(0,5));

            let link = d.links[mapKey];
            if (link) { console.log('[LIKE_GIVEN] Gefunden via mapKey direkt'); }

            if (!link) {
                const msgId = mapKey.split('_').slice(1).join('_');
                link = d.links['B_' + msgId] || d.links['C_' + msgId] ||
                    Object.values(d.links).find(l => String(l.counter_msg_id) === String(msgId));
                if (link) console.log('[LIKE_GIVEN] Gefunden via msgId Fallback:', msgId);
            }
            if (!link && groupBMsgId) {
                link = Object.values(d.links).find(l => String(l.counter_msg_id) === String(groupBMsgId));
                if (link) console.log('[LIKE_GIVEN] Gefunden via groupBMsgId:', groupBMsgId);
            }
            if (!link && event.meta?.linkText) {
                link = Object.values(d.links).find(l => l.text === event.meta.linkText);
                if (link) console.log('[LIKE_GIVEN] Gefunden via linkText');
            }
            if (!link) {
                console.log('[LIKE_GIVEN] ❌ NICHT GEFUNDEN! mapKey:', mapKey, 'linkText:', event.meta?.linkText?.slice(0,50));
                console.log('[LIKE_GIVEN] Alle Keys:', Object.keys(d.links).join(', '));
                return;
            }
            console.log('[LIKE_GIVEN] ✅ Link gefunden, counter_msg_id:', link.counter_msg_id, 'likes vorher:', link.likes?.size);

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
                const linkTimestamp = Object.values(d.links).find(l => l.text === event.meta?.linkText)?.timestamp;
                const istHeutigerBridgeLink = linkTimestamp && new Date(linkTimestamp).toDateString() === new Date().toDateString();
                if (istHeutigerBridgeLink && istInstagramLink(event.meta.linkText)) mission.likesGegeben++;
                await checkMissionen(uid, name);
            }

            // Telegram Counter sofort updaten
            try {
                const anz = link.likes.size;
                const poster = d.users[String(link.user_id)] || {};
                const posterLabel = istAdminId(link.user_id) ? '⚙️ Admin ' + link.user_name : (poster.role||'🆕') + ' ' + link.user_name;
                const posterStats = istAdminId(link.user_id) ? '' : '  |  ⭐ ' + (poster.xp||0) + ' XP';
                const chatId = link.chat_id || GROUP_B_ID;
                console.log('[LIKE_GIVEN] Updating Telegram chat_id:', chatId, 'msg_id:', link.counter_msg_id);
                await bot.telegram.editMessageText(
                    Number(chatId),
                    Number(link.counter_msg_id),
                    null,
                    posterLabel + '\n🔗 ' + link.text + '\n\n👍 ' + anz + ' Likes' + posterStats,
                    { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('👍 Like  |  ' + anz, 'like_' + link.counter_msg_id)]]).reply_markup }
                );
                console.log('[LIKE_GIVEN] ✅ Telegram Counter updated:', anz);
            } catch(e) { console.log('[LIKE_GIVEN] Telegram update Fehler:', e.message); }

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

app.get('/delete-link', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const msgId = req.query.id;
    if (d.links[msgId]) {
        const link = d.links[msgId];
        if (link.chat_id && link.counter_msg_id) {
            bot.telegram.deleteMessage(link.chat_id, link.counter_msg_id).catch(()=>{});
        }
        // Remove from dmNachrichten
        if (d.dmNachrichten) delete d.dmNachrichten[String(link.counter_msg_id)];
        delete d.links[msgId];
        speichern();
    }
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


// Bilder separat speichern
const BILDER_DIR = '/data';
function saveBild(uid, type, data) {
    try {
        const file = BILDER_DIR + '/bild_' + uid + '_' + type + '.txt';
        require('fs').writeFileSync(file, data);
        return '/bild/' + uid + '/' + type;
    } catch(e) { return data; }
}
function loadBild(uid, type) {
    try {
        const file = BILDER_DIR + '/bild_' + uid + '_' + type + '.txt';
        if (require('fs').existsSync(file)) return require('fs').readFileSync(file, 'utf8');
    } catch(e) {}
    return null;
}

app.post('/update-profile-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, bio, spitzname, banner, accentColor, profilePic } = req.body || {};
    if (d.users[uid]) {
        if (bio !== undefined) d.users[uid].bio = bio.slice(0,100);
        if (spitzname !== undefined) d.users[uid].spitzname = spitzname.slice(0,30);
        if (accentColor !== undefined) d.users[uid].accentColor = accentColor;
        if (req.body.nische !== undefined) d.users[uid].nische = req.body.nische.slice(0,50);
        if (req.body.website !== undefined) { d.users[uid].website = req.body.website.slice(0,100); console.log('[PROFILE] website gesetzt:', req.body.website); }
        if (req.body.tiktok !== undefined) d.users[uid].tiktok = req.body.tiktok.replace('@','').slice(0,50);
        if (req.body.youtube !== undefined) d.users[uid].youtube = req.body.youtube.replace('@','').slice(0,50);
        if (req.body.twitter !== undefined) d.users[uid].twitter = req.body.twitter.replace('@','').slice(0,50);
        // Bilder separat speichern
        if (banner !== undefined) {
            if (banner.startsWith('data:image')) {
                saveBild(uid, 'banner', banner);
                d.users[uid].banner = '/bild/' + uid + '/banner';
            } else {
                d.users[uid].banner = banner;
            }
        }
        if (profilePic !== undefined) {
            if (profilePic.startsWith('data:image')) {
                saveBild(uid, 'profilepic', profilePic);
                d.users[uid].profilePic = '/bild/' + uid + '/profilepic';
            } else {
                d.users[uid].profilePic = profilePic;
            }
        }
        speichern();
    }
    res.json({ ok: true });
});

// Bild Endpoint
app.get('/bild/:uid/:type', (req, res) => {
    const data = loadBild(req.params.uid, req.params.type);
    if (!data) return res.status(404).send('');
    const mime = data.split(';')[0].replace('data:','');
    const base64 = data.split(',')[1];
    res.writeHead(200, {'Content-Type': mime, 'Cache-Control': 'public, max-age=86400'});
    res.end(Buffer.from(base64, 'base64'));
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
    // Kein Bridge Secret nötig - kommt von der App

    // Link finden - alle Möglichkeiten
    let lnk = d.links[msgId] 
        || d.links['B_' + msgId] 
        || d.links['C_' + msgId]
        || Object.values(d.links).find(l => String(l.counter_msg_id) === String(msgId));
    if (!lnk) return res.json({ok:false, error:'Link nicht gefunden'});
    console.log('[APP-LIKE] Link gefunden, counter_msg_id:', lnk.counter_msg_id, 'chat_id:', lnk.chat_id);

    const uidNum = Number(uid);
    if (!lnk.likes) lnk.likes = new Set();
    const wasLiked = lnk.likes.has(uidNum);
    if (wasLiked) {
        // Bereits geliked - kein Unlike möglich
        return res.json({ok:true, liked:true, likes: lnk.likes.size});
    } else {
        // Like
        if (String(uidNum) === String(lnk.user_id)) return res.json({ok:false, error:'Kein Self-Like'});
        lnk.likes.add(uidNum);
        const u = d.users[uid];
        if (!lnk.likerNames) lnk.likerNames = {};
        lnk.likerNames[uidNum] = { name: u?.name||'User', insta: u?.instagram||null };
        // XP vergeben
        if (!istAdminId(uid)) xpAddMitDaily(uid, 5, u?.name||'User');
        // Mission aktualisieren
        const mission = getMission(uid);
        updateMissionProgress(uid);
        const istHeutigerLinkApp = new Date(lnk.timestamp).toDateString() === new Date().toDateString();
        if (istHeutigerLinkApp && istInstagramLink(lnk.text)) mission.likesGegeben++;
        await checkMissionen(uid, u?.name||'User');
    }

    speichernDebounced();

    // Sofort antworten – Telegram-Updates im Hintergrund
    const liked = !wasLiked;
    res.json({ok:true, liked, likes: lnk.likes.size});

    // Telegram Counter + Feedback asynchron (kein await → blockiert Response nicht)
    const anz = lnk.likes.size;
    const poster = d.users[String(lnk.user_id)] || {};
    const posterLabel = istAdminId(lnk.user_id) ? '⚙️ Admin ' + lnk.user_name : (poster.role||'🆕') + ' ' + lnk.user_name;
    const posterStats = istAdminId(lnk.user_id) ? '' : '  |  ⭐ ' + (poster.xp||0) + ' XP';
    bot.telegram.editMessageText(
        lnk.chat_id, lnk.counter_msg_id, null,
        posterLabel + '\n🔗 ' + lnk.text + '\n\n👍 ' + anz + ' Likes' + posterStats,
        { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('👍 Like  |  ' + anz, 'like_' + lnk.counter_msg_id)]]).reply_markup }
    ).catch(e => console.log('Telegram Sync Fehler:', e.message));

    if (liked && !istAdminId(uid)) {
        const liker = d.users[uid] || {};
        const nb = xpBisNaechstesBadge(liker.xp||0);
        const eventBonus = d.xpEvent?.aktiv && d.xpEvent?.multiplier > 1 ? ` (+${Math.round((d.xpEvent.multiplier-1)*100)}% Event)` : '';
        const feedbackText = '🎉 +5 XP' + eventBonus + '\n' + (liker.role||'🆕') + ' | ⭐ ' + (liker.xp||0) + (nb ? '\n⬆️ Noch ' + nb.fehlend + ' bis ' + nb.ziel : '');
        bot.telegram.sendMessage(lnk.chat_id, feedbackText, { reply_to_message_id: lnk.counter_msg_id })
            .then(feedbackMsg => setTimeout(() => bot.telegram.deleteMessage(lnk.chat_id, feedbackMsg.message_id).catch(()=>{}), 8000))
            .catch(e => console.log('Feedback Fehler:', e.message));
    }
});


// ── PHASE 2 API ENDPOINTS ──

app.post('/follow-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { followerUid, targetUid } = req.body || {};
    if (!followerUid || !targetUid) return res.json({ok:false});
    if (!d.users[followerUid]) return res.json({ok:false});
    if (!d.users[followerUid].following) d.users[followerUid].following = [];
    if (!d.users[targetUid]) return res.json({ok:false});
    if (!d.users[targetUid].followers) d.users[targetUid].followers = [];
    const idx = d.users[followerUid].following.indexOf(targetUid);
    if (idx === -1) {
        d.users[followerUid].following.push(targetUid);
        d.users[targetUid].followers.push(followerUid);
        // Benachrichtigung
        const followerName = d.users[followerUid]?.spitzname || d.users[followerUid]?.name || 'Jemand';
        addNotification(targetUid, '👤', followerName + ' folgt dir jetzt');
    } else {
        d.users[followerUid].following.splice(idx, 1);
        d.users[targetUid].followers = d.users[targetUid].followers.filter(id => id !== followerUid);
    }
    speichern();
    res.json({ok:true});
});

app.post('/create-post-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, text, attachment, attachmentType } = req.body || {};
    if (!uid || (!text && !attachment)) return res.json({ok:false});
    if (!d.posts) d.posts = {};
    if (!d.posts[uid]) d.posts[uid] = [];
    const post = { text: (text||'').slice(0,300), timestamp: Date.now(), likes: [] };
    if (attachment) { post.attachment = attachment; post.attachmentType = attachmentType; }
    d.posts[uid].push(post);
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
    // Post Owner benachrichtigen
    const postOwnerUid = linkId.split('_')[0];
    if (postOwnerUid && postOwnerUid !== uid && d.users[postOwnerUid]) {
        addNotification(postOwnerUid, '💬', (name||'Jemand') + ' hat kommentiert: ' + text.slice(0,40));
    }
    speichern();
    res.json({ok:true});
});


app.post('/delete-post-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, timestamp } = req.body || {};
    if (!uid || !timestamp || !d.posts?.[uid]) return res.json({ok:false});
    d.posts[uid] = d.posts[uid].filter(p => p.timestamp !== Number(timestamp));
    speichern();
    res.json({ok:true});
});

app.post('/delete-comment-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, postId, commentIdx } = req.body || {};
    if (!uid || !postId || !d.comments?.[postId]) return res.json({ok:false});
    const comment = d.comments[postId][commentIdx];
    if (!comment || String(comment.uid) !== String(uid)) return res.json({ok:false});
    d.comments[postId].splice(commentIdx, 1);
    speichern();
    res.json({ok:true});
});


app.post('/post-link-from-app', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, name, url, caption } = req.body || {};
    if (!uid || !url) return res.json({error:'Ungültig'});
    console.log('[APP-LINK] uid:', uid, 'url:', url?.slice(0,30), 'GROUP_A_ID:', GROUP_A_ID);

    const u = d.users[uid];
    if (!u) return res.json({error:'User nicht gefunden'});

    // Duplikat Check
    const heute = new Date().toDateString();
    const norm = (t) => t.toLowerCase().replace(/\?.*$/, '').replace(/\/$/, '').trim();
    const isDuplicate = Object.values(d.links).some(l => norm(l.text) === norm(url));
    if (isDuplicate) { console.log('[APP-LINK] Duplikat!'); return res.json({error:'Dieser Link wurde bereits gepostet!'}); }

    // Daily Limit Check - Admins haben kein Limit
    let usedBonusLink = false;
    if (!istAdminId(uid)) {
        const todayLinks = Object.values(d.links).filter(l =>
            String(l.user_id) === String(uid) && new Date(l.timestamp).toDateString() === heute
        ).length;
        const bonusAvail = d.bonusLinks?.[uid] || 0;
        const maxLinks = 1 + bonusAvail;
        if (todayLinks >= maxLinks) { console.log('[APP-LINK] Limit erreicht:', todayLinks, '/', maxLinks); return res.json({error:'Limit erreicht! Max ' + maxLinks + ' Link(s) pro Tag'}); }
        if (todayLinks >= 1) usedBonusLink = true;
    }
    console.log('[APP-LINK] Checks OK - sende Link...');

    try {
        console.log('[APP-LINK] Sende Warnung an GROUP_A_ID:', GROUP_A_ID);
        // Warnung in Gruppe senden - nur wenn nicht Admin
        if (!istAdminId(uid)) {
            try {
                const warnMsg = await bot.telegram.sendMessage(GROUP_A_ID,
                    '⚠️ Mindestens 5 Links liken (M1) — sonst Verwarnung!', {}
                );
                setTimeout(async () => { try { await bot.telegram.deleteMessage(GROUP_A_ID, warnMsg.message_id); } catch(e) {} }, 10000);
            } catch(e) { console.log('[APP-LINK] Warnung Fehler:', e.message); }
        }

        // Link in Gruppe senden (gleiche Formatierung wie Telegram-Post)
        console.log('[APP-LINK] Sende Link an GROUP_A_ID:', GROUP_A_ID);
        const isAdmin = istAdminId(uid);
        const botMsg = await bot.telegram.sendMessage(
            GROUP_A_ID,
            buildLinkKarte(u.spitzname||u.name||name, u.role||'🆕 New', url, 0, u.xp||0, isAdmin) + (caption ? '\n💬 ' + caption : ''),
            { reply_markup: Markup.inlineKeyboard([[Markup.button.callback('👍 Like  |  0', 'like_0')]]).reply_markup }
        );
        console.log('[APP-LINK] Gesendet an Gruppe A, msgId:', botMsg.message_id);

        // Button mit echter msgId updaten
        const mapKey = 'A_' + botMsg.message_id;
        await bot.telegram.editMessageReplyMarkup(GROUP_A_ID, botMsg.message_id, null,
            buildLinkButtons(botMsg.message_id, 0)
        );

        // Link speichern
        const linkData = {
            chat_id: GROUP_A_ID,
            user_id: Number(uid),
            user_name: u.spitzname||u.name||name,
            text: url,
            caption: caption||'',
            likes: new Set(),
            likerNames: {},
            counter_msg_id: botMsg.message_id,
            timestamp: Date.now()
        };
        d.links[mapKey] = linkData;
        console.log('[APP-LINK] Link gespeichert als:', mapKey);

        // Bonus-Link verbrauchen falls verwendet
        if (usedBonusLink && d.bonusLinks?.[uid] > 0) {
            d.bonusLinks[uid]--;
            if (d.bonusLinks[uid] <= 0) delete d.bonusLinks[uid];
            console.log('[APP-LINK] Bonus-Link verbraucht, verbleibend:', d.bonusLinks[uid] || 0);
        }

        // XP vergeben
        xpAddMitDaily(uid, 1, u.name||name);
        u.links = (u.links||0) + 1;

        // Mission updaten
        const mission = getMission(uid);
        if (istInstagramLink(url)) mission.linksGepostet++;
        await checkMissionen(uid, u.name||name);

        // DM an alle User senden
        await sendeLinkAnAlle(linkData);

        // Bridge Bot informieren
        try {
            const burl = BRIDGE_BOT_URL;
            const lib2 = burl.startsWith('https') ? require('https') : require('http');
            const bdata = JSON.stringify({
                fromGroup: 'A', msgId: botMsg.message_id, botMsgId: botMsg.message_id,
                chatId: GROUP_A_ID, linkText: url,
                userName: u.spitzname||u.name||name, userId: Number(uid), username: u.username||null
            });
            const urlObj2 = new (require('url').URL)(burl);
            const req2 = lib2.request({
                hostname: urlObj2.hostname, path: urlObj2.pathname, method: 'POST',
                headers: {'Content-Type':'application/json','x-bridge-secret':BRIDGE_SECRET,'Content-Length':Buffer.byteLength(bdata)}
            }, r=>{r.on('data',()=>{});r.on('end',()=>{});});
            req2.on('error',()=>{}); req2.write(bdata); req2.end();
        } catch(e) { console.log('Bridge Fehler:', e.message); }

        speichern();
        res.json({ok:true, msgId: botMsg.message_id});
    } catch(e) {
        console.log('post-link-from-app Fehler:', e.message);
        res.json({error:'Fehler: '+e.message});
    }
});


app.post('/pin-post-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, timestamp } = req.body || {};
    if (!uid || !d.posts?.[uid]) return res.json({ok:false});
    const post = d.posts[uid].find(p => p.timestamp === Number(timestamp));
    if (!post) return res.json({ok:false});
    // Alle anderen entpinnen
    d.posts[uid].forEach(p => p.pinned = false);
    post.pinned = true;
    speichern();
    res.json({ok:true});
});


app.post('/mark-notifications-read', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid } = req.body || {};
    if (!uid || !d.notifications?.[uid]) return res.json({ok:false});
    d.notifications[uid].forEach(n => n.read = true);
    speichern();
    res.json({ok:true});
});


app.post('/send-message-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { from, to, text, image, audio } = req.body || {};
    if (!from || !to || (!text?.trim() && !image && !audio)) return res.json({ok:false});
    if (!d.messages) d.messages = {};
    const chatKey = [String(from), String(to)].sort().join('_');
    if (!d.messages[chatKey]) d.messages[chatKey] = [];
    d.messages[chatKey].push({ from: String(from), to: String(to), text: (text||'').slice(0,500), image: image||null, audio: audio||null, timestamp: Date.now(), read: false });
    if (d.messages[chatKey].length > 200) d.messages[chatKey].shift();
    const fromUser = d.users[from];
    const senderName = fromUser?.spitzname || fromUser?.name || 'Jemand';
    if (fromUser) addNotification(String(to), '💬', senderName + (text ? ': ' + text.slice(0,40) : ' hat dir etwas gesendet'));
    // Telegram DM weiterleiten
    if (d.users[to]?.started) {
        try {
            const tgText = image ? '📷 Foto' : audio ? '🎤 Sprachnachricht' : text;
            await bot.telegram.sendMessage(Number(to),
                '💬 *' + senderName + ':*\n\n' + tgText,
                { parse_mode: 'Markdown' }
            );
        } catch(e) {}
    }
    speichern();
    res.json({ok:true});
});

app.post('/mark-messages-read', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, chatKey } = req.body || {};
    if (!uid || !chatKey || !d.messages?.[chatKey]) return res.json({ok:false});
    d.messages[chatKey].forEach(m => { if (m.to === String(uid)) m.read = true; });
    speichern();
    res.json({ok:true});
});

app.post('/delete-dm-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { chatKey, timestamp, uid } = req.body || {};
    if (!chatKey || !timestamp || !d.messages?.[chatKey]) return res.json({ok:false});
    const msg = d.messages[chatKey].find(m => m.timestamp === Number(timestamp));
    if (!msg) return res.json({ok:false});
    const isAdmin = d.users?.[String(uid)]?.role?.includes('Admin');
    if (msg.from !== String(uid) && !isAdmin) return res.json({ok:false, error:'Kein Zugriff'});
    d.messages[chatKey] = d.messages[chatKey].filter(m => m.timestamp !== Number(timestamp));
    speichern();
    res.json({ok:true});
});

app.post('/delete-thread-msg-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { threadId, timestamp, msgId, uid } = req.body || {};
    if (!threadId || !timestamp) return res.json({ok:false});
    const isAdmin = d.users?.[String(uid)]?.role?.includes('Admin');
    const msgs = d.threadMessages?.[threadId] || [];
    const msg = msgs.find(m => m.timestamp === Number(timestamp));
    if (!msg) return res.json({ok:false});
    if (msg.uid && msg.uid !== String(uid) && !isAdmin) return res.json({ok:false, error:'Kein Zugriff'});
    d.threadMessages[threadId] = msgs.filter(m => m.timestamp !== Number(timestamp));
    if (d.communityFeed) d.communityFeed = d.communityFeed.filter(m => m.timestamp !== Number(timestamp));
    // Aktualisiere d.threads last_msg + msg_count
    const thr = (d.threads||[]).find(t => String(t.id) === threadId);
    if (thr) {
        thr.last_msg = d.threadMessages[threadId]?.[0] || null;
        thr.msg_count = d.threadMessages[threadId]?.length || 0;
    }
    speichern();
    if (msgId && GROUP_B_ID) {
        try { await bot.telegram.deleteMessage(GROUP_B_ID, Number(msgId)); } catch(e) {}
    }
    res.json({ok:true});
});

app.post('/send-group-message', async (req, res) => {
    const { text, uid } = req.body || {};
    if (!text?.trim()) return res.json({ ok: false, error: 'Kein Text' });
    const u = d.users[String(uid)];
    if (!u) return res.json({ ok: false, error: 'User nicht gefunden' });
    const name = u.spitzname || u.name || 'User';
    const label = (u.role || '🆕') + ' ' + name;
    try {
        await bot.telegram.sendMessage(GROUP_B_ID, `💬 ${label}:
${text.trim()}`);
        res.json({ ok: true });
    } catch (e) {
        res.json({ ok: false, error: e.message });
    }
});

app.get('/telegram-feed', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({ messages: d.communityFeed || [] });
});

app.get('/forum-topics', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (!d.threads || d.threads.length === 0) await ladeForumTopics();
    // Build from received messages if API failed
    if (!d.threads || d.threads.length === 0) {
        const msgKeys = Object.keys(d.threadMessages || {});
        d.threads = msgKeys.length > 0
            ? msgKeys.map(tid => ({ id: tid, name: tid === 'general' ? 'Allgemein' : `Thread ${tid}`, emoji: tid === 'general' ? '💬' : '📌', last_msg: d.threadMessages[tid]?.[0] || null, msg_count: d.threadMessages[tid]?.length || 0 }))
            : [{ id: 'general', name: 'Allgemein', emoji: '💬', last_msg: null, msg_count: 0 }];
    }
    // Always ensure 'general' exists
    if (!d.threads.find(t => String(t.id) === 'general')) {
        d.threads.unshift({ id: 'general', name: 'Allgemein', emoji: '💬', last_msg: d.threadMessages?.['general']?.[0] || null, msg_count: d.threadMessages?.['general']?.length || 0 });
    }
    // Merge any threads discovered from messages not yet in list
    for (const tid of Object.keys(d.threadMessages || {})) {
        if (!d.threads.find(t => String(t.id) === tid)) {
            d.threads.push({ id: tid === 'general' ? 'general' : Number(tid), name: `Thread ${tid}`, emoji: '📌', last_msg: d.threadMessages[tid]?.[0] || null, msg_count: d.threadMessages[tid]?.length || 0 });
        }
    }
    res.json({ threads: d.threads });
});

app.get('/forum-debug', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const info = { GROUP_B_ID, threadsCount: (d.threads||[]).length, threadMsgKeys: Object.keys(d.threadMessages||{}), error: null, apiResult: null };
    if (GROUP_B_ID) {
        try { info.apiResult = await bot.telegram.callApi('getForumTopics', { chat_id: GROUP_B_ID, limit: 10 }); }
        catch (e) { info.error = e.message; }
    }
    res.json(info);
});

app.get('/fethread-setup', (req, res) => {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const baseUrl = proto + '://' + req.headers.host;
    const status = d.fullEngagementThreadId ? `✅ Thread-ID: ${d.fullEngagementThreadId}` : '❌ Kein Thread gesetzt';
    const groupStatus = GROUP_B_ID ? `✅ GROUP_B_ID: ${GROUP_B_ID}` : '❌ GROUP_B_ID nicht gesetzt!';
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Full Engagement Setup</title>
<style>body{font-family:sans-serif;max-width:480px;margin:40px auto;padding:20px;background:#111;color:#fff}
h2{color:#fff;margin-bottom:4px}p{color:#aaa;font-size:14px;margin-bottom:24px}
.status{background:#1e1e1e;border-radius:10px;padding:14px;margin-bottom:20px;font-size:14px;line-height:2}
button{width:100%;padding:14px;background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;border:none;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;margin-bottom:10px}
button:disabled{opacity:.5;cursor:not-allowed}
.result{background:#1e1e1e;border-radius:10px;padding:14px;margin-top:16px;font-size:13px;display:none;white-space:pre-wrap;word-break:break-all}
.ok{color:#22c55e}.err{color:#ef4444}</style></head>
<body>
<h2>⭐ Full Engagement Setup</h2>
<p>Erstellt den Full Engagement Thread in Gruppe B</p>
<div class="status">${groupStatus}<br>${status}</div>
<button id="btn" onclick="createThread()">🚀 Thread erstellen / zurücksetzen</button>
<div class="result" id="result"></div>
<script>
const BASE='${baseUrl}';
async function createThread(){
  const btn=document.getElementById('btn');
  const res=document.getElementById('result');
  btn.disabled=true;btn.textContent='⏳ Erstelle Thread...';
  res.style.display='none';
  try{
    const r=await fetch(BASE+'/fethread-setup',{method:'POST',headers:{'Content-Type':'application/json'}});
    const data=await r.json();
    res.style.display='block';
    if(data.ok){res.className='result ok';res.textContent='✅ Erfolgreich!\\nThread-ID: '+data.threadId;}
    else{res.className='result err';res.textContent='❌ Fehler: '+data.error+'\\n\\nHinweis: '+data.hint;}
    btn.textContent='🔄 Nochmal versuchen';
  }catch(e){res.style.display='block';res.className='result err';res.textContent='❌ '+e.message;btn.textContent='🔄 Nochmal versuchen';}
  btn.disabled=false;
}
</script></body></html>`);
});

app.post('/fethread-setup-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    return fethreadCreate(res);
});

app.post('/fethread-announce-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    if (!d.fullEngagementThreadId) return res.json({ ok: false, error: 'Kein Full Engagement Thread gesetzt. Zuerst erstellen.' });
    if (!GROUP_B_ID) return res.json({ ok: false, error: 'GROUP_B_ID nicht gesetzt.' });
    try {
        await bot.telegram.sendMessage(GROUP_B_ID,
            '⭐ *Full Engagement Thread!*\n\n' +
            'Hier postet ihr eure Superlinks für diese Woche.\n\n' +
            '📌 *Regeln:*\n• 1–2 Superlinks pro Person pro Woche (Mo–Sa)\n• Wer postet, muss ALLE anderen liken, kommentieren, teilen & speichern\n• Verstoß: -50 XP\n\n' +
            '📲 Instagram-Link hier reinposten oder /superlink im Bot nutzen!',
            { parse_mode: 'Markdown', message_thread_id: Number(d.fullEngagementThreadId) }
        );
        res.json({ ok: true });
    } catch(e) { res.json({ ok: false, error: e.message }); }
});

app.post('/fethread-setup', async (req, res) => {
    return fethreadCreate(res);
});

async function fethreadCreate(res) {
    if (!GROUP_B_ID) return res.json({ ok: false, error: 'GROUP_B_ID nicht gesetzt in Railway Variables!', hint: 'Gehe zu Railway → telegram-bot → Variables und setze GROUP_B_ID.' });
    const oldId = d.fullEngagementThreadId;
    d.fullEngagementThreadId = null;
    let threadId = null, createError = null;
    try {
        const result = await bot.telegram.callApi('createForumTopic', { chat_id: GROUP_B_ID, name: 'Full Engagement' });
        threadId = result.message_thread_id;
        d.fullEngagementThreadId = threadId;
        speichern();
    } catch(e) { createError = e.message; d.fullEngagementThreadId = oldId; }
    if (!threadId) return res.json({ ok: false, error: createError, hint: 'Ist Forum-Modus in Gruppe B aktiv? Hat der Bot "Themen verwalten" als Admin-Recht?' });
    try {
        await bot.telegram.sendMessage(GROUP_B_ID,
            '⭐ *Full Engagement Thread geöffnet!*\n\nHier könnt ihr eure Superlinks posten.\n\n📌 *Regeln:*\n• 1–2 Superlinks pro Person pro Woche (Mo–Sa)\n• Wer postet, muss ALLE anderen liken, kommentieren, teilen & speichern\n• Verstoß: -50 XP\n\n📲 Einfach euren Instagram-Link hier reinposten oder /superlink im Bot nutzen!',
            { parse_mode: 'Markdown', message_thread_id: Number(threadId) }
        );
    } catch(e) {}
    res.json({ ok: true, threadId });
}

app.get('/thread-messages/:threadId', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const tid = req.params.threadId;
    let msgs = d.threadMessages[tid] || [];
    // Fallback für 'general': communityFeed migrieren wenn threadMessages leer
    if (!msgs.length && tid === 'general' && d.communityFeed?.length) {
        msgs = d.communityFeed.map(m => ({
            uid: String(m.uid || ''), tgName: m.username || null,
            name: m.name || m.username || 'Unbekannt', role: null,
            type: 'text', text: m.text || '', mediaId: null,
            timestamp: m.timestamp, msg_id: m.msg_id
        }));
    }
    res.json({ messages: msgs });
});

app.post('/send-thread-message', async (req, res) => {
    const { text, uid, thread_id, replyTo } = req.body || {};
    if (!text?.trim()) return res.json({ ok: false, error: 'Kein Text' });
    const u = d.users[String(uid)];
    if (!u) return res.json({ ok: false, error: 'User nicht gefunden' });
    const tgName = u.username ? '@' + u.username : (u.spitzname || u.name || 'User');
    const label = (u.role || '🆕') + ' ' + tgName;
    const tid = String(thread_id || 'general');
    if (!d.threadMessages[tid]) d.threadMessages[tid] = [];
    const entry = {
        uid: String(uid),
        tgName,
        name: u.spitzname || u.name || tgName,
        role: u.role || null,
        type: 'text',
        text: text.trim(),
        mediaId: null,
        timestamp: Date.now(),
        msg_id: null,
        replyTo: replyTo ? { timestamp: replyTo.timestamp, name: replyTo.name, text: (replyTo.text||'').slice(0,100), msgId: replyTo.msgId } : null
    };
    d.threadMessages[tid].unshift(entry);
    if (d.threadMessages[tid].length > 200) d.threadMessages[tid] = d.threadMessages[tid].slice(0, 200);
    if (!d.threads) d.threads = [];
    let thr = d.threads.find(t => String(t.id) === tid);
    if (thr) { thr.last_msg = entry; thr.msg_count = d.threadMessages[tid].length; }
    speichernDebounced();
    res.json({ ok: true });
    // Telegram-Nachricht asynchron (kein await → blockiert Response nicht)
    if (GROUP_B_ID) {
        const opts = { parse_mode: 'Markdown' };
        if (tid !== 'general') opts.message_thread_id = Number(tid);
        if (replyTo?.msgId) opts.reply_to_message_id = Number(replyTo.msgId);
        bot.telegram.sendMessage(GROUP_B_ID, `${label}:\n${text.trim()}`, opts)
            .then(sent => { entry.msg_id = sent.message_id; speichernDebounced(); })
            .catch(e => console.log('Thread-Telegram-Send Fehler:', e.message));
    }
});

app.post('/react-thread-msg-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { threadId, timestamp, emoji, uid } = req.body || {};
    if (!threadId || !timestamp || !emoji || !uid) return res.json({ok:false});
    const msgs = d.threadMessages?.[String(threadId)] || [];
    const msg = msgs.find(m => m.timestamp === Number(timestamp));
    if (!msg) return res.json({ok:false});
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const uidStr = String(uid);
    const idx = msg.reactions[emoji].indexOf(uidStr);
    if (idx >= 0) {
        msg.reactions[emoji].splice(idx, 1);
        if (!msg.reactions[emoji].length) delete msg.reactions[emoji];
    } else {
        msg.reactions[emoji].push(uidStr);
    }
    speichern();
    if (msg.msg_id && GROUP_B_ID) {
        try {
            const reactionEmojis = Object.keys(msg.reactions||{}).slice(0,3);
            await bot.telegram.callApi('setMessageReaction', {
                chat_id: GROUP_B_ID,
                message_id: Number(msg.msg_id),
                reaction: reactionEmojis.map(e=>({type:'emoji',emoji:e})),
                is_big: false
            });
        } catch(e) {}
    }
    res.json({ ok: true, reactions: msg.reactions });
});

app.post('/create-thread', async (req, res) => {
    const { name, emoji, uid } = req.body || {};
    if (!name?.trim()) return res.json({ ok: false, error: 'Kein Name' });
    if (!istAdminId(Number(uid))) return res.json({ ok: false, error: 'Kein Admin' });
    try {
        const result = await bot.telegram.callApi('createForumTopic', { chat_id: GROUP_B_ID, name: name.trim(), ...(emoji ? { icon_emoji_id: emoji } : {}) });
        const newThread = { id: result.message_thread_id, name: result.name, emoji: emoji || '💬', last_msg: null, msg_count: 0 };
        if (!d.threads) d.threads = [];
        d.threads.push(newThread);
        speichern();
        res.json({ ok: true, thread: newThread });
    } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/complete-profile-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid } = req.body || {};
    if (!uid) return res.json({ok:false});
    const u = d.users[String(uid)];
    if (!u || u.profileCompletionRewarded) return res.json({ok:false, alreadyRewarded:true});
    u.profileCompletionRewarded = true;
    u.diamonds = (u.diamonds||0) + 1;
    speichern();
    addNotification(String(uid), '🏆', 'Profil 100% vollständig! Du erhältst 💎 1 Diamant als Belohnung!');
    res.json({ ok: true, diamonds: u.diamonds });
});

app.post('/buy-item-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, itemId } = req.body || {};
    if (!uid || !itemId) return res.json({ok:false, error:'Fehlende Parameter'});
    const u = d.users[String(uid)];
    if (!u) return res.json({ok:false, error:'User nicht gefunden'});
    if (!u.inventory) u.inventory = [];
    if (u.inventory.includes(itemId)) return res.json({ok:false, error:'Item bereits besessen'});
    const ITEM_PRICES = {
        ring_flame:8, ring_ocean:8, ring_gold:10, ring_purple:12, ring_rainbow:15, ring_diamond:20,
        banner_sunset:5, banner_peach:5, banner_mint:5, banner_forest:5,
        banner_ocean:7, banner_sky:7, banner_lavender:7, banner_rose:7,
        banner_gold:10, banner_candy:10, banner_coral:10, banner_aurora:10,
    };
    const price = ITEM_PRICES[itemId];
    if (!price) return res.json({ok:false, error:'Unbekanntes Item'});
    const isAdmin = istAdminId(Number(uid));
    if (!isAdmin && (u.diamonds||0) < price) return res.json({ok:false, error:`Nicht genug Diamanten (benötigt: ${price})`});
    if (!isAdmin) u.diamonds -= price;
    u.inventory.push(itemId);
    speichern();
    const itemNames = {
        ring_flame:'🔥 Flame Ring', ring_ocean:'🌊 Ocean Ring', ring_gold:'✨ Gold Ring', ring_purple:'🔮 Cosmic Ring', ring_rainbow:'🌈 Rainbow Ring', ring_diamond:'💎 Diamond Ring',
        banner_sunset:'🌅 Sunset Banner', banner_ocean:'🌊 Ocean Banner', banner_forest:'🌿 Forest Banner', banner_candy:'🍭 Candy Banner',
        banner_sky:'☁️ Sky Blue Banner', banner_lavender:'💜 Lavender Banner', banner_mint:'🌱 Mint Banner', banner_peach:'🍑 Peach Banner',
        banner_gold:'✨ Golden Hour Banner', banner_coral:'🪸 Coral Banner', banner_aurora:'🌌 Aurora Banner', banner_rose:'🌹 Rose Gold Banner',
    };
    addNotification(String(uid), '🎁', `${itemNames[itemId]||itemId} gekauft! Wähle es in deinem Profil unter "Items" aus.${isAdmin ? ' (Admin – kostenlos)' : ` 💎 -${price} Diamanten.`}`);
    res.json({ ok: true, diamonds: u.diamonds, inventory: u.inventory });
});

app.post('/set-active-ring-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, ringId } = req.body || {};
    if (!uid) return res.json({ok:false});
    const u = d.users[String(uid)];
    if (!u) return res.json({ok:false});
    if (ringId && !(u.inventory||[]).includes(ringId)) return res.json({ok:false, error:'Item nicht im Inventar'});
    u.activeRing = ringId || null;
    speichern();
    res.json({ ok: true, activeRing: u.activeRing });
});

app.post('/buy-extralink-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid } = req.body || {};
    if (!uid) return res.json({ok:false, error:'Fehlende UID'});
    const u = d.users[String(uid)];
    if (!u) return res.json({ok:false, error:'User nicht gefunden'});
    const isAdminEl = istAdminId(Number(uid));
    if (!isAdminEl && (u.diamonds||0) < 5) return res.json({ok:false, error:'Nicht genug Diamanten (benötigt: 5)'});
    if (!isAdminEl) u.diamonds -= 5;
    if (!d.bonusLinks) d.bonusLinks = {};
    d.bonusLinks[String(uid)] = (d.bonusLinks[String(uid)] || 0) + 1;
    speichern();
    addNotification(String(uid), '🔗', `Extra-Link gekauft! Du kannst heute einen zusätzlichen Link posten.${isAdminEl ? ' (Admin – kostenlos)' : ' 💎 -5 Diamanten.'}`);
    res.json({ ok: true, diamonds: u.diamonds, bonusLinks: d.bonusLinks[String(uid)] });
});

app.get('/link-status-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String(req.query.uid || '');
    if (!uid) return res.json({ok:false});
    const heute = new Date().toDateString();
    const todayCount = Object.values(d.links).filter(l =>
        String(l.user_id) === String(uid) && new Date(l.timestamp).toDateString() === heute
    ).length;
    const bonusLinks = d.bonusLinks?.[uid] || 0;
    const isAdmin = istAdminId(Number(uid));
    const maxLinks = isAdmin ? 999 : 1 + bonusLinks;
    const canPost = isAdmin || todayCount < maxLinks;
    res.json({ ok: true, todayCount, bonusLinks, maxLinks, canPost, isAdmin });
});

app.get('/mission-status-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const uid = String(req.query.uid || '');
    if (!uid) return res.json({ok:false});
    const heute = new Date().toDateString();
    const mission = getMission(uid);
    const wMission = getWochenMission(uid);
    const heuteLinks = Object.values(d.links).filter(l =>
        istInstagramLink(l.text) && new Date(l.timestamp).toDateString() === heute && String(l.user_id) !== String(uid)
    );
    const gesamt = heuteLinks.length;
    const geliked = heuteLinks.filter(l => l.likes && l.likes.has(Number(uid))).length;
    const prozent = gesamt > 0 ? Math.round((geliked / gesamt) * 100) : 0;
    res.json({
        ok: true,
        daily: {
            likesGegeben: mission.likesGegeben || 0,
            m1: mission.m1 || false,
            m2: mission.m2 || false,
            m3: mission.m3 || false,
            gesamtLinks: gesamt,
            gelikedLinks: geliked,
            prozent
        },
        weekly: {
            m1Tage: wMission.m1Tage || 0,
            m2Tage: wMission.m2Tage || 0,
            m3Tage: wMission.m3Tage || 0
        }
    });
});

app.get('/tg-file/:fileId', async (req, res) => {
    try {
        const file = await bot.telegram.getFile(req.params.fileId);
        res.redirect(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`);
    } catch (e) { res.status(404).json({ error: 'Datei nicht gefunden' }); }
});

app.post('/rename-thread', (req, res) => {
    const { uid, thread_id, name } = req.body || {};
    if (!uid || !thread_id || !name?.trim()) return res.json({ ok: false, error: 'Fehlende Parameter' });
    if (!d.threads) d.threads = [];
    let thr = d.threads.find(t => String(t.id) === String(thread_id));
    if (!thr) {
        thr = { id: thread_id === 'general' ? 'general' : Number(thread_id), name: name.trim(), emoji: '📌', last_msg: null, msg_count: 0 };
        d.threads.push(thr);
    } else {
        thr.name = name.trim();
    }
    speichern();
    res.json({ ok: true });
});

app.post('/mark-read', (req, res) => {
    const { uid, thread_id } = req.body || {};
    if (!uid || !thread_id) return res.json({ ok: false });
    if (!d.threadLastRead[uid]) d.threadLastRead[uid] = {};
    d.threadLastRead[uid][thread_id] = Date.now();
    speichern();
    res.json({ ok: true });
});

app.post('/track-login', (req, res) => {
    const { uid } = req.body || {};
    if (!uid || !d.users[String(uid)]) return res.json({ ok: false });
    if (!d.dailyLogins[uid]) d.dailyLogins[uid] = 0;
    d.dailyLogins[uid]++;
    res.json({ ok: true });
});

app.post('/add-project-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, projectId, title, description, link, docName } = req.body || {};
    if (!uid || !projectId || !title?.trim()) return res.json({ok:false, error:'Fehlende Felder'});
    const u = d.users[String(uid)];
    if (!u) return res.json({ok:false, error:'User nicht gefunden'});
    if (!u.projects) u.projects = [];
    if (u.projects.length >= 2) return res.json({ok:false, error:'Max 2 Projekte erlaubt'});
    u.projects.push({ id: projectId, title: title.trim(), description: (description||'').trim(), link: (link||'').trim(), docName: (docName||'').trim(), timestamp: Date.now() });
    speichern();
    res.json({ok:true});
});

app.post('/update-project-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, projectId, title, description, link, docName } = req.body || {};
    if (!uid || !projectId || !title?.trim()) return res.json({ok:false, error:'Fehlende Felder'});
    const u = d.users[String(uid)];
    if (!u || !u.projects) return res.json({ok:false, error:'Projekt nicht gefunden'});
    const proj = u.projects.find(p => p.id === String(projectId));
    if (!proj) return res.json({ok:false, error:'Projekt nicht gefunden'});
    proj.title = title.trim();
    proj.description = (description||'').trim();
    proj.link = (link||'').trim();
    proj.docName = (docName||'').trim();
    speichern();
    res.json({ok:true});
});

app.post('/delete-project-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, projectId } = req.body || {};
    if (!uid || !projectId) return res.json({ok:false});
    const u = d.users[String(uid)];
    if (!u || !u.projects) return res.json({ok:false});
    u.projects = u.projects.filter(p => p.id !== String(projectId));
    speichern();
    res.json({ok:true});
});

function addDiamond(uid, amount) {
    const u = d.users[String(uid)];
    if (!u) return;
    if (u.diamonds === undefined) u.diamonds = 0;
    u.diamonds += amount;
}

app.post('/engage-pinned-post-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { engagerUid, ownerUid } = req.body || {};
    if (!engagerUid || !ownerUid || engagerUid === ownerUid) return res.json({ok:false});
    if (!d.pinnedEngages) d.pinnedEngages = {};
    if (!d.pinnedEngages[ownerUid]) d.pinnedEngages[ownerUid] = [];
    if (d.pinnedEngages[ownerUid].includes(String(engagerUid))) return res.json({ok:false, alreadyDone:true});
    d.pinnedEngages[ownerUid].push(String(engagerUid));
    addDiamond(ownerUid, 1);
    addNotification(ownerUid, '💎', 'Jemand hat deinen Post engagiert! +1 Diamant');
    speichern();
    res.json({ok:true});
});

app.post('/add-newsletter-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, title, content } = req.body || {};
    if (!uid || !content?.trim()) return res.json({ok:false, error:'Inhalt fehlt'});
    if (!istAdminId(Number(uid))) return res.json({ok:false, error:'Kein Admin'});
    if (!d.newsletter) d.newsletter = [];
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    d.newsletter.push({ id, title: (title||'').trim(), content: content.trim(), timestamp: Date.now() });
    // Alle User benachrichtigen
    for (const tUid of Object.keys(d.users||{})) {
        if (!istAdminId(Number(tUid))) addNotification(tUid, '📩', (title||'Neuer Newsletter').slice(0,60) || 'Neuer Newsletter-Eintrag');
    }
    speichern();
    res.json({ok:true});
});

app.post('/edit-newsletter-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, id, title, content } = req.body || {};
    if (!uid || !id || !content?.trim()) return res.json({ok:false});
    if (!istAdminId(Number(uid))) return res.json({ok:false, error:'Kein Admin'});
    const entry = (d.newsletter||[]).find(e=>e.id===id);
    if (!entry) return res.json({ok:false, error:'Nicht gefunden'});
    entry.title = (title||'').trim();
    entry.content = content.trim();
    entry.editedAt = Date.now();
    speichern();
    res.json({ok:true});
});

app.post('/delete-newsletter-api', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, id } = req.body || {};
    if (!uid || !id) return res.json({ok:false});
    if (!istAdminId(Number(uid))) return res.json({ok:false, error:'Kein Admin'});
    d.newsletter = (d.newsletter||[]).filter(e=>e.id!==id);
    speichern();
    res.json({ok:true});
});

// ── SUPERLINK APIs ──
app.get('/superlinks', (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const sls = Object.values(d.superlinks||{}).sort((a,b)=>b.timestamp-a.timestamp);
    res.json({ superlinks: sls, fullEngagementThreadId: d.fullEngagementThreadId });
});

app.post('/like-superlink-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { slId, uid } = req.body || {};
    if (!slId || !uid) return res.json({ok:false, error:'Fehlende Felder'});
    const sl = d.superlinks?.[slId];
    if (!sl) return res.json({ok:false, error:'Superlink nicht gefunden'});
    if (String(sl.uid) === String(uid)) return res.json({ok:false, error:'Eigener Post'});
    if (!Array.isArray(sl.likes)) sl.likes = [];
    if (!sl.likerNames) sl.likerNames = {};
    const idx = sl.likes.indexOf(String(uid));
    if (idx >= 0) {
        sl.likes.splice(idx, 1);
        delete sl.likerNames[String(uid)];
    } else {
        sl.likes.push(String(uid));
        const u = d.users[String(uid)];
        sl.likerNames[String(uid)] = u?.spitzname||u?.name||'User';
        addNotification(String(sl.uid), '❤️', (u?.spitzname||u?.name||'User') + ' hat deinen Superlink geliked!');
    }
    speichern();
    updateSuperLinkCard(slId).catch(()=>{});
    res.json({ok:true, liked: idx<0, likes: sl.likes.length});
});

app.post('/post-superlink-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { uid, url, caption } = req.body || {};
    if (!uid || !url) return res.json({ok:false, error:'Fehlende Felder'});
    const u = d.users[String(uid)];
    if (!u) return res.json({ok:false, error:'User nicht gefunden'});
    if (!u.instagram) return res.json({ok:false, error:'Bitte zuerst /setinsta im Bot setzen'});
    if (!isSuperLinkPostingAllowed()) return res.json({ok:false, error:'Superlinks können nur Mo–Sa gepostet werden'});
    const week = getBerlinWeekKey();
    const isElitePlusSL = u.role === '🌟 Elite+';
    const maxSL = isElitePlusSL ? 2 : 1;
    const slThisWeekCount = Object.values(d.superlinks||{}).filter(s=>s.uid===String(uid)&&s.week===week).length;
    if (slThisWeekCount >= maxSL) return res.json({ok:false, error:'Du hast diese Woche bereits ' + maxSL + ' Superlink(s) gepostet'});
    const isAdminSL = istAdminId(Number(uid));
    if (!isAdminSL && (u.diamonds||0) < 10) return res.json({ok:false, error:'Nicht genug Diamanten (benötigt: 💎 10 für Superlink)'});
    if (!url.includes('instagram.com')) return res.json({ok:false, error:'Nur Instagram-Links erlaubt'});
    let feThreadId;
    try { feThreadId = await ensureFullEngagementThread(); } catch(e) {}
    if (!feThreadId) return res.json({ok:false, error:'Full Engagement Thread nicht verfügbar'});
    const slId = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    const cardText = buildSuperLinkKarte(u?.spitzname||u?.name||'User', u.instagram, url, caption||'', 0, {});
    try {
        const sent = await bot.telegram.sendMessage(GROUP_B_ID, cardText, {
            parse_mode: 'Markdown',
            message_thread_id: Number(feThreadId),
            reply_markup: buildSuperLinkButtons(slId, 0)
        });
        d.superlinks = d.superlinks || {};
        const newSL = { id: slId, uid: String(uid), url, caption: caption||'', msg_id: sent.message_id, timestamp: Date.now(), week, likes: [], likerNames: {} };
        d.superlinks[slId] = newSL;
        if (!isAdminSL) u.diamonds = (u.diamonds||0) - 10;
        speichern();
        // DM an Poster
        try { await bot.telegram.sendMessage(Number(uid), '⭐ *Dein Superlink wurde gepostet!*\n\nVergiss nicht: Du bist verpflichtet, *alle anderen Superlinks diese Woche* zu liken, kommentieren, teilen & speichern.', { parse_mode: 'Markdown' }); } catch(e) {}
        // DM an alle anderen Poster dieser Woche
        const posterUser = d.users[String(uid)];
        const otherPosters2 = Object.values(d.superlinks).filter(s => s.week === week && s.uid !== String(uid));
        for (const other of otherPosters2) {
            try {
                await bot.telegram.sendMessage(Number(other.uid),
                    `⭐ *Neuer Superlink!*\n\n👤 ${posterUser?.spitzname||posterUser?.name||'Ein User'} hat einen Superlink gepostet.\n🔗 ${url}\n\n⚠️ Liken, Kommentieren, Teilen & Speichern ist Pflicht!`,
                    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '❤️ Jetzt liken', callback_data: 'sllike_' + slId }]] } }
                );
            } catch(e) {}
        }
        res.json({ok:true, slId});
    } catch(e) { res.json({ok:false, error:'Telegram Fehler: '+e.message}); }
});

app.post('/report-nonengager-api', async (req, res) => {
    if (!checkBridgeSecret(req, res)) return;
    const { reporterUid, likerUid, slId } = req.body || {};
    if (!reporterUid || !likerUid || !slId) return res.json({ok:false});
    const sl = d.superlinks?.[slId];
    if (!sl || String(sl.uid) !== String(reporterUid)) return res.json({ok:false, error:'Nur Poster kann reporten'});
    const reporter = d.users[String(reporterUid)];
    const liker = d.users[String(likerUid)];
    const msg = `🚨 *Engagement Report*\n\nPoster: ${reporter?.spitzname||reporter?.name||'User'}\nGemeldet: ${liker?.spitzname||liker?.name||'User'}\nLink: ${sl.url}\nGrund: Hat nicht geliked/kommentiert/geteilt/gespeichert`;
    for (const adminId of ADMIN_IDS) {
        try { await bot.telegram.sendMessage(adminId, msg, { parse_mode: 'Markdown' }); } catch(e){}
    }
    res.json({ok:true});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log('🌐 Dashboard läuft auf Port ' + PORT); });

bot.launch().then(() => {
    setTimeout(async () => {
        if (!GROUP_B_ID) { console.log('⚠️ GROUP_B_ID nicht gesetzt – Full Engagement Thread übersprungen'); return; }
        try {
            // Prüfe ob gespeicherter Thread noch existiert
            if (d.fullEngagementThreadId) {
                try {
                    const topics = await bot.telegram.callApi('getForumTopics', { chat_id: GROUP_B_ID, limit: 100 });
                    const exists = topics.topics?.some(t => t.message_thread_id === Number(d.fullEngagementThreadId));
                    if (!exists) {
                        console.log('⚠️ Full Engagement Thread nicht mehr gefunden, erstelle neu...');
                        d.fullEngagementThreadId = null;
                    }
                } catch(e) { console.log('Thread-Check Fehler:', e.message); }
            }
            const wasNull = !d.fullEngagementThreadId;
            const threadId = await ensureFullEngagementThread();
            if (wasNull && threadId) {
                await bot.telegram.sendMessage(GROUP_B_ID,
                    '⭐ *Full Engagement Thread geöffnet!*\n\n' +
                    'Hier könnt ihr eure Superlinks posten.\n\n' +
                    '📌 *Regeln:*\n• 1–2 Superlinks pro Person pro Woche (Mo–Sa)\n• Wer postet, muss ALLE anderen liken, kommentieren, teilen & speichern\n• Verstoß: -50 XP\n\n' +
                    '📲 Einfach euren Instagram-Link hier reinposten oder /superlink im Bot nutzen!',
                    { parse_mode: 'Markdown', message_thread_id: Number(threadId) }
                );
            }
            if (threadId) console.log('✅ Full Engagement Thread bereit:', threadId);
        } catch(e) { console.log('Startup Engagement Fehler:', e.message); }
    }, 5000);
});
console.log('🤖 Bot läuft!');

// Migrate communityFeed → threadMessages['general'] on startup
function migriereAlteDaten() {
    if (!d.communityFeed?.length) return;
    if (!d.threadMessages) d.threadMessages = {};
    if (!d.threadMessages['general']) d.threadMessages['general'] = [];
    const existingIds = new Set(d.threadMessages['general'].map(m => m.msg_id));
    let added = 0;
    for (const m of d.communityFeed) {
        if (!existingIds.has(m.msg_id)) {
            d.threadMessages['general'].push({
                uid: String(m.uid || ''),
                tgName: m.username || null,
                name: m.name || m.username || 'Unbekannt',
                role: null, type: 'text', text: m.text || '',
                mediaId: null,
                timestamp: m.timestamp,
                msg_id: m.msg_id
            });
            added++;
        }
    }
    d.threadMessages['general'].sort((a, b) => b.timestamp - a.timestamp);
    if (d.threadMessages['general'].length > 100) d.threadMessages['general'] = d.threadMessages['general'].slice(0, 100);
    if (added > 0) { console.log(`✅ ${added} alte Nachrichten nach threadMessages['general'] migriert`); speichern(); }
}

async function ladeForumTopics() {
    if (!GROUP_B_ID) return;
    try {
        const result = await bot.telegram.callApi('getForumTopics', { chat_id: GROUP_B_ID, limit: 100 });
        const topics = result?.topics || [];
        const existing = new Map((d.threads || []).map(t => [String(t.id), t]));
        const updated = topics.map(t => {
            const ex = existing.get(String(t.message_thread_id));
            return { id: t.message_thread_id, name: t.name, emoji: t.icon_emoji_id || '💬', last_msg: ex?.last_msg || null, msg_count: ex?.msg_count || (d.threadMessages[String(t.message_thread_id)] || []).length };
        });
        const gen = existing.get('general');
        const generalEntry = { id: 'general', name: 'Allgemein', emoji: '💬', last_msg: gen?.last_msg || (d.threadMessages['general']?.[0] || null), msg_count: (d.threadMessages['general'] || []).length };
        d.threads = [generalEntry, ...updated];
        console.log(`✅ ${d.threads.length} Forum-Topics geladen`);
    } catch (e) { console.log('Forum Topics Fehler (normal wenn keine Forum-Gruppe):', e.message); }
}

setTimeout(() => { migriereAlteDaten(); ladeForumTopics(); }, 2000);

process.on('unhandledRejection', (reason) => { console.log('Unhandled:', reason); });
process.on('uncaughtException', (error)  => { console.log('Uncaught:', error.message); });
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

(async () => { await checkInstagramForAllUsers(); })();



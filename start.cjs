// start.cjs v3 - patches bot.js with /addxp, dynamic-import the patched ESM
// RUNTIME muss neben bot.js liegen damit Node node_modules findet (telegraf etc.)
const fs = require('fs');
const path = require('path');

const BOT_SRC = path.join(__dirname, 'bot.js');
const RUNTIME = path.join(__dirname, 'bot-runtime.mjs');

const ANCHOR = "bot.command('testreset', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; d.dailyXP = {}; d.weeklyXP = {}; d.missionen = {}; d.wochenMissionen = {}; d.missionQueue = {}; d.tracker = {}; d.counter = {}; d.badgeTracker = {}; speichern(); await ctx.reply('✅ Reset!'); });";

const ADDXP = `


bot.command('addxp', async (ctx) => {
    if (!await istAdmin(ctx, ctx.from.id)) return ctx.reply('❌ Nur Admins!');
    const args = (ctx.message.text || '').split(/\\s+/).slice(1);
    const menge = parseInt(args[0], 10);
    if (!menge || isNaN(menge)) return ctx.reply('❌ Nutzung: Antworte auf einen User mit /addxp <menge>\\nz.B. /addxp 1000\\n\\nNegative Werte ziehen XP ab.');
    if (!ctx.message.reply_to_message) return ctx.reply('❌ Antworte auf eine Nachricht des Users.');
    const targetId = ctx.message.reply_to_message.from.id;
    const targetName = ctx.message.reply_to_message.from.first_name || 'User';
    if (istAdminId(targetId)) return ctx.reply('❌ Admins haben kein XP-Konto.');
    const u = user(targetId, targetName);
    const alteBadge = u.role;
    let finalXP = menge;
    if (menge > 0 && d.xpEvent && d.xpEvent.aktiv && d.xpEvent.multiplier > 1) finalXP = Math.round(menge * d.xpEvent.multiplier);
    u.xp = Math.max(0, (u.xp || 0) + finalXP);
    u.level = level(u.xp);
    u.role = badge(u.xp);
    if (!d.weeklyXP[targetId]) d.weeklyXP[targetId] = 0;
    d.weeklyXP[targetId] += finalXP;
    speichern();
    const sign = finalXP >= 0 ? '+' : '';
    await ctx.reply('✅ ' + sign + finalXP + ' XP an *' + u.name + '*\\n⭐ Gesamt: ' + u.xp + ' XP  ·  ' + u.role + (alteBadge !== u.role ? '\\n🎉 Badge: ' + alteBadge + ' → ' + u.role : ''), { parse_mode: 'Markdown' });
    try {
        const dmText = finalXP >= 0
            ? '🎁 *Geschenk vom Admin!*\\n\\n+' + finalXP + ' XP\\n⭐ Gesamt: ' + u.xp + ' XP  ·  ' + u.role
            : '⚠️ *XP angepasst*\\n\\n' + finalXP + ' XP\\n⭐ Gesamt: ' + u.xp + ' XP  ·  ' + u.role;
        await bot.telegram.sendMessage(targetId, dmText, { parse_mode: 'Markdown' });
    } catch (e) {}
});`;

console.log('[start] Lese bot.js ...');
let src;
try {
    src = fs.readFileSync(BOT_SRC, 'utf8');
} catch (e) {
    console.error('[start] FEHLER bot.js:', e.message);
    process.exit(1);
}
console.log('[start] bot.js ' + src.length + ' bytes');

if (src.includes("bot.command('addxp'")) {
    console.log('[start] /addxp bereits vorhanden');
} else if (src.includes(ANCHOR)) {
    src = src.replace(ANCHOR, ANCHOR + ADDXP);
    console.log('[start] /addxp Command eingefuegt');
} else {
    console.log('[start] WARNUNG: Anchor (testreset) nicht gefunden');
}

try {
    fs.writeFileSync(RUNTIME, src);
    console.log('[start] Geschrieben: ' + RUNTIME);
} catch (e) {
    console.error('[start] FEHLER beim Schreiben:', e.message);
    process.exit(1);
}

console.log('[start] Importiere bot-runtime ...');
import(RUNTIME).then(() => {
    console.log('[start] bot-runtime gestartet');
}).catch(e => {
    console.error('[start] FEHLER beim Import:');
    console.error(e && e.stack || e);
    process.exit(1);
});

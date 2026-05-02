// patch-bot.cjs - Build-time Patch fuer bot.js
// Wird via npm postinstall + Dockerfile RUN aufgerufen.
// Schreibt /addxp (+ alias /xpadd) Command direkt in bot.js auf der Disk.
const fs = require('fs');
const path = require('path');

const BOT = path.resolve(__dirname, 'bot.js');

if (!fs.existsSync(BOT)) {
    console.log('[patch-bot] bot.js noch nicht da - skip (wird beim naechsten Step gemacht)');
    process.exit(0);
}

const ANCHOR = "bot.command('testreset', async (ctx) => { if (!await istAdmin(ctx, ctx.from.id)) return; d.dailyXP = {}; d.weeklyXP = {}; d.missionen = {}; d.wochenMissionen = {}; d.missionQueue = {}; d.tracker = {}; d.counter = {}; d.badgeTracker = {}; speichern(); await ctx.reply('✅ Reset!'); });";

// Beide Schreibweisen registrieren: /addxp UND /xpadd
const ADDXP = `


async function _adminAddXp(ctx) {
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
}
bot.command('addxp', _adminAddXp);
bot.command('xpadd', _adminAddXp);
bot.command('givexp', _adminAddXp);
console.log('[patched] /addxp + /xpadd + /givexp registriert');`;

let src = fs.readFileSync(BOT, 'utf8');

// Idempotenz: wenn schon da, skip
if (src.includes('_adminAddXp')) {
    console.log('[patch-bot] /addxp bereits vorhanden, skip');
    process.exit(0);
}

// Alte Version ohne Alias entfernen, falls vorhanden
if (src.includes("bot.command('addxp', async (ctx) =>")) {
    const oldStart = src.indexOf("bot.command('addxp', async (ctx) =>");
    const oldEnd = src.indexOf('});', oldStart) + 3;
    if (oldEnd > oldStart) {
        src = src.slice(0, oldStart) + src.slice(oldEnd);
        console.log('[patch-bot] Alte /addxp Version entfernt');
    }
}

if (!src.includes(ANCHOR)) {
    console.error('[patch-bot] FEHLER: Anchor (testreset) nicht gefunden!');
    process.exit(1);
}

src = src.replace(ANCHOR, ANCHOR + ADDXP);
fs.writeFileSync(BOT, src);
console.log('[patch-bot] /addxp + /xpadd + /givexp eingefuegt (' + src.length + ' bytes)');

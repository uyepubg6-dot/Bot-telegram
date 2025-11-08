// @category utility
const fs = require('fs');
const path = require('path');

module.exports = (bot) => {
  const commandsFolder = __dirname;
  const imageUrl = 'https://files.catbox.moe/z9dcu4.png';

  const getThreadIdFromMsg = (msg) =>
    msg?.message_thread_id ||
    msg?.reply_to_message?.message_thread_id ||
    null;

  const getThreadIdFromQuery = (query) =>
    query?.message?.message_thread_id || null;

  const isPhotoMessage = (message) => Array.isArray(message?.photo) && message.photo.length > 0;

  async function safeEdit(chatId, message, textOrCaption, replyMarkup, threadId) {
    try {
      if (isPhotoMessage(message)) {
        await bot.editMessageCaption(textOrCaption, {
          chat_id: chatId,
          message_id: message.message_id,
          parse_mode: 'Markdown',
          reply_markup: replyMarkup
        });
      } else {
        await bot.editMessageText(textOrCaption, {
          chat_id: chatId,
          message_id: message.message_id,
          parse_mode: 'Markdown',
          reply_markup: replyMarkup
        });
      }
    } catch (e) {

      if (isPhotoMessage(message)) {
        await bot.sendPhoto(chatId, imageUrl, {
          caption: textOrCaption,
          parse_mode: 'Markdown',
          reply_markup: replyMarkup,
          ...(threadId ? { message_thread_id: threadId } : {})
        });
      } else {
        await bot.sendMessage(chatId, textOrCaption, {
          parse_mode: 'Markdown',
          reply_markup: replyMarkup,
          ...(threadId ? { message_thread_id: threadId } : {})
        });
      }
    }
  }


  function getCategories() {
    try {
      const items = fs.readdirSync(commandsFolder, { withFileTypes: true });
      return items
        .filter(item => item.isDirectory())
        .map(item => item.name)
        .filter(name => !name.startsWith('.'))
        .sort();
    } catch (err) {
      console.error('Error reading categories:', err);
      return [];
    }
  }

  function getCommandsFromCategory(categoryName) {
    try {
      const categoryFolder = path.join(commandsFolder, categoryName);
      if (!fs.existsSync(categoryFolder)) return [];

      const files = fs.readdirSync(categoryFolder).filter(f => f.endsWith('.js'));
      const allCommands = [];

      for (const file of files) {
        const filePath = path.join(categoryFolder, file);
        const content = fs.readFileSync(filePath, 'utf8');

        const matches = [
          ...content.matchAll(/bot\.onText\(\s*\/\\?\/?\(?([a-zA-Z0-9_|]+)\)?/g),
          ...content.matchAll(/bot\.onText\(\s*['"`]\/\\?\/?\(?([a-zA-Z0-9_|]+)\)?/g)
        ];

        for (const match of matches) {
          const raw = match[1];
          if (raw.includes('|')) {
            allCommands.push(...raw.split('|').map(c => c.trim()));
          } else {
            allCommands.push(raw.trim());
          }
        }

        const manualMatch = content.match(/@commands\s+(.+)/i);
        if (manualMatch) {
          const commands = manualMatch[1].split(',').map(c => c.trim());
          allCommands.push(...commands);
        }
      }

      return [...new Set(allCommands)].sort();
    } catch (err) {
      console.error(`Error reading commands from ${categoryName}:`, err);
      return [];
    }
  }


  function buildMainButtons(categories) {
    const buttons = [];
    for (let i = 0; i < categories.length; i += 2) {
      const row = [];
      const cat1 = categories[i];
      const d1 = cat1.charAt(0).toUpperCase() + cat1.slice(1);
      row.push({ text: `📂 ${d1}`, callback_data: `menu_${cat1}` });

      if (categories[i + 1]) {
        const cat2 = categories[i + 1];
        const d2 = cat2.charAt(0).toUpperCase() + cat2.slice(1);
        row.push({ text: `📂 ${d2}`, callback_data: `menu_${cat2}` });
      }
      buttons.push(row);
    }
    return buttons;
  }


  async function sendMainMenu(chatId, threadId = null) {
    const categories = getCategories();
    if (categories.length === 0) {
      return bot.sendMessage(chatId, '❌ Tidak ada kategori ditemukan.', {
        parse_mode: 'Markdown',
        ...(threadId ? { message_thread_id: threadId } : {})
      });
    }

    const caption = `*Menu Utama*\n\nSilakan pilih salah satu kategori:`;
    const buttons = buildMainButtons(categories);

    return bot.sendPhoto(chatId, imageUrl, {
      caption,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons },
      ...(threadId ? { message_thread_id: threadId } : {})
    });
  }


  async function sendCategoryMenu(bot, chatId, categoryName, message = null, threadId = null) {
    try {
      const commands = getCommandsFromCategory(categoryName);
      const displayName = categoryName.charAt(0).toUpperCase() + categoryName.slice(1);

      const replyMarkup = {
        inline_keyboard: [[{ text: '🔙 Kembali ke Menu Utama', callback_data: 'back_to_main' }]]
      };

      if (commands.length === 0) {
        const text = `⚠️ Tidak ada perintah ditemukan di kategori *${displayName}*.`;
        if (message) return safeEdit(chatId, message, text, replyMarkup, threadId);

        return bot.sendPhoto(chatId, imageUrl, {
          caption: text,
          parse_mode: 'Markdown',
          reply_markup: replyMarkup,
          ...(threadId ? { message_thread_id: threadId } : {})
        });
      }

      const text =
        `📂 *Perintah dalam kategori "${displayName}":*\n\n` +
        commands.map(c => `◦ /${c}`).join('\n');

      if (message) return safeEdit(chatId, message, text, replyMarkup, threadId);

      return bot.sendPhoto(chatId, imageUrl, {
        caption: text,
        parse_mode: 'Markdown',
        reply_markup: replyMarkup,
        ...(threadId ? { message_thread_id: threadId } : {})
      });
    } catch (err) {
      console.error(`Error sending category menu for ${categoryName}:`, err);
      const errorText = `❌ Gagal membaca plugin dari kategori *${categoryName}*.`;
      const replyMarkup = {
        inline_keyboard: [[{ text: '🔙 Kembali ke Menu Utama', callback_data: 'back_to_main' }]]
      };

      if (message) return safeEdit(chatId, message, errorText, replyMarkup, threadId);

      return bot.sendMessage(chatId, errorText, {
        parse_mode: 'Markdown',
        reply_markup: replyMarkup,
        ...(threadId ? { message_thread_id: threadId } : {})
      });
    }
  }

  // ---- /menu ----
  bot.onText(/\/menu(?:\s+(\w+))?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const threadId = getThreadIdFromMsg(msg);
    const input = match[1]?.toLowerCase();

    if (!input) return sendMainMenu(chatId, threadId);

    const categories = getCategories();
    if (categories.includes(input)) {
      return sendCategoryMenu(bot, chatId, input, null, threadId);
    }

    return bot.sendMessage(
      chatId,
      `❌ Kategori *${input}* tidak ditemukan.`,
      { parse_mode: 'Markdown', ...(threadId ? { message_thread_id: threadId } : {}) }
    );
  });


  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const threadId = getThreadIdFromQuery(query);

    if (!data.startsWith('menu_') && data !== 'back_to_main') return;

    await bot.answerCallbackQuery(query.id);

    if (data.startsWith('menu_')) {
      const category = data.replace('menu_', '');
      return sendCategoryMenu(bot, chatId, category, query.message, threadId);
    }

    if (data === 'back_to_main') {
      const categories = getCategories();
      if (categories.length === 0) {
        return safeEdit(chatId, query.message, '❌ Tidak ada kategori ditemukan.', null, threadId);
      }
      const caption = `*Menu Utama*\n\nSilakan pilih salah satu kategori:`;
      const buttons = buildMainButtons(categories);
      return safeEdit(chatId, query.message, caption, { inline_keyboard: buttons }, threadId);
    }
  });
};
/**
 * Cloudflare Worker untuk Telegram Webhook (tanpa VPS/Termux)
 * - Mode webhook, stateless, tanpa fs
 * - Fitur dasar: /start, /menu, /help, cek kuota (KMSP), converter (link <-> config)
 * - Set TOKEN bot di Secrets Cloudflare: TELEGRAM_TOKEN
 * - Set path rahasia webhook: WEBHOOK_SECRET (misal "mysecret123")
 *
 * Deploy:
 * 1) npm i -g wrangler
 * 2) wrangler login
 * 3) wrangler secret put TELEGRAM_TOKEN
 * 4) wrangler secret put WEBHOOK_SECRET
 * 5) wrangler publish
 * 6) Set webhook:
 *    curl -XPOST https://api.telegram.org/bot$TELEGRAM_TOKEN/setWebhook \
 *      -d "url=https://<your-worker-subdomain>/webhook/$WEBHOOK_SECRET"
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (request.method === 'GET' && path === '/') {
      return new Response('OK', { status: 200 });
    }

    // Verifikasi path webhook agar tidak kena spam
    const secret = env.WEBHOOK_SECRET;
    if (!secret) {
      return new Response('Missing WEBHOOK_SECRET', { status: 500 });
    }
    if (!(path === `/webhook/${secret}`)) {
      return new Response('Not Found', { status: 404 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    const token = env.TELEGRAM_TOKEN;
    if (!token) {
      return new Response('Missing TELEGRAM_TOKEN', { status: 500 });
    }

    const api = telegramApi(token);

    try {
      await handleUpdate(update, api, env);
    } catch (e) {
      console.error('handleUpdate error:', e?.message || e);
    }
    // Telegram expects 200 quickly
    return new Response('OK', { status: 200 });
  }
};

// ===== Telegram API (via fetch) =====
function telegramApi(token) {
  const base = `https://api.telegram.org/bot${token}`;
  const send = async (method, payload) => {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(`${method} failed: ${res.status} ${j?.description || ''}`);
    return j.result;
  };
  return {
    sendMessage: (chat_id, text, extra={}) => send('sendMessage', { chat_id, text, ...extra }),
    sendPhoto: (chat_id, photo, extra={}) => send('sendPhoto', { chat_id, photo, ...extra }),
    editMessageText: (chat_id, message_id, text, extra={}) =>
      send('editMessageText', { chat_id, message_id, text, ...extra }),
    editMessageCaption: (chat_id, message_id, caption, extra={}) =>
      send('editMessageCaption', { chat_id, message_id, caption, ...extra }),
    answerCallbackQuery: (id, extra={}) => send('answerCallbackQuery', { callback_query_id: id, ...extra }),
    sendChatAction: (chat_id, action) => send('sendChatAction', { chat_id, action }),
    getMe: () => send('getMe', {})
  };
}

// ===== Utilities =====
const esc = (s='') =>
  String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');

const isPhotoMessage = (message) => Array.isArray(message?.photo) && message.photo.length > 0;

function safeEdit(api, chatId, message, textOrCaption, replyMarkup) {
  return (isPhotoMessage(message)
    ? api.editMessageCaption(chatId, message.message_id, textOrCaption, { parse_mode: 'Markdown', reply_markup: replyMarkup })
    : api.editMessageText(chatId, message.message_id, textOrCaption, { parse_mode: 'Markdown', reply_markup: replyMarkup })
  ).catch(async () => {
    if (isPhotoMessage(message)) {
      await api.sendPhoto(chatId, MENU_IMAGE, { caption: textOrCaption, parse_mode: 'Markdown', reply_markup: replyMarkup });
    } else {
      await api.sendMessage(chatId, textOrCaption, { parse_mode: 'Markdown', reply_markup: replyMarkup });
    }
  });
}

const MENU_IMAGE = 'https://files.catbox.moe/z9dcu4.png';

// Tambah kategori "custom" untuk command dinamis dari KV
const categoryList = ['all', 'utility', 'custom'];
const menuKb = (cats) => {
  const btns = [];
  for (let i = 0; i < cats.length; i += 2) {
    const row = [];
    const a = cats[i], b = cats[i+1];
    if (a) row.push({ text: `📂 ${capitalize(a)}`, callback_data: `menu_${a}` });
    if (b) row.push({ text: `📂 ${capitalize(b)}`, callback_data: `menu_${b}` });
    btns.push(row);
  }
  return { inline_keyboard: btns };
};
const backKb = { inline_keyboard: [[{ text: '🔙 Kembali', callback_data: 'back_main' }]] };
const capitalize = (s='') => s.charAt(0).toUpperCase() + s.slice(1);

// Static daftar commands per kategori (tanpa fs)
function getCommandsForCategory(category) {
  const map = {
    all: ['start', 'help', 'menu', 'cek', 'kuota', 'cekkuota', 'convert', 'converter', 'v2conv', 'v2ray'],
    utility: ['convert', 'converter', 'v2conv', 'v2ray']
  };
  return map[category] || [];
}

// ====== KV Helpers (Custom Commands) ======
async function kvAddCommand(env, name, responseText, createdBy) {
  const key = `cmd:${name.toLowerCase()}`;
  const value = JSON.stringify({ text: responseText, by: createdBy, ts: Date.now() });
  await env.COMMANDS.put(key, value);
}
async function kvGetCommand(env, name) {
  const key = `cmd:${name.toLowerCase()}`;
  const val = await env.COMMANDS.get(key);
  if (!val) return null;
  try { return JSON.parse(val); } catch { return null; }
}
async function kvDeleteCommand(env, name) {
  const key = `cmd:${name.toLowerCase()}`;
  await env.COMMANDS.delete(key);
}
async function kvListCommands(env, limit = 100) {
  const list = await env.COMMANDS.list({ prefix: 'cmd:' });
  const names = (list.keys || []).slice(0, limit).map(k => k.name.replace(/^cmd:/, ''));
  return names;
}

// ===== Handle update =====
async function handleUpdate(update, api, env) {
  if (update.message) {
    return handleMessage(update.message, api, env);
  }
  if (update.callback_query) {
    return handleCallback(update.callback_query, api, env);
  }
}

// ===== Message Router =====
async function handleMessage(msg, api, env) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const isCmd = text.startsWith('/');
  const threadId = msg.message_thread_id || msg?.reply_to_message?.message_thread_id;
  const adminId = Number(env.ADMIN_ID || 0);

  // Basic commands
  if (/^\/start\b/i.test(text)) {
    const caption =
      `👋 Welcome!\n\n` +
      `Bot berjalan di Cloudflare Workers (Webhook). Beberapa fitur porting.\n\n` +
      `Pilih menu di bawah untuk mulai.`;
    await api.sendPhoto(chatId, MENU_IMAGE, {
      caption,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📖 Help', callback_data: 'help_main' }, { text: '🎛️ Menu', callback_data: 'menu_main' }]
        ]
      },
      ...(threadId ? { message_thread_id: threadId } : {})
    });
    return;
  }

  if (/^\/help\b/i.test(text)) {
    const help =
      `📖 Available Commands\n\n` +
      `• /menu — daftar kategori\n` +
      `• /cekkuota <nomor>\n` +
      `• /convert — kirim link vless/vmess/trojan atau Clash YAML satu proxy\n` +
      `• /addcmd <nama> <teks>\n` +
      `• /delcmd <nama>\n` +
      `• /listcmd`;
    await api.sendMessage(chatId, help, { parse_mode: 'Markdown', ...(threadId ? { message_thread_id: threadId } : {}) });
    return;
  }

  if (/^\/menu\b/i.test(text)) {
    await sendMainMenu(api, chatId, threadId);
    return;
  }

  // ===== Custom Command Management (/addcmd, /delcmd, /listcmd) =====
  const addMatch = text.match(/^\/addcmd(?:@[A-Za-z0-9_]+)?\s+(\w+)\s+([\s\S]+)/i);
  if (addMatch) {
    if (adminId && msg.from?.id !== adminId) {
      await api.sendMessage(chatId, '🔒 Perintah ini hanya untuk admin.', { ...(threadId ? { message_thread_id: threadId } : {}) });
      return;
    }
    const name = addMatch[1].toLowerCase();
    const resp = addMatch[2].trim();
    if (!/^[a-zA-Z0-9_]{2,32}$/.test(name)) {
      await api.sendMessage(chatId, '❌ Nama command hanya huruf/angka/underscore, 2-32 karakter.', { ...(threadId ? { message_thread_id: threadId } : {}) });
      return;
    }
    await kvAddCommand(env, name, resp, msg.from?.id || 0);
    await api.sendMessage(chatId, `✅ Command ditambahkan: /${name}`, { ...(threadId ? { message_thread_id: threadId } : {}) });
    return;
  }

  const delMatch = text.match(/^\/delcmd(?:@[A-Za-z0-9_]+)?\s+(\w+)/i);
  if (delMatch) {
    if (adminId && msg.from?.id !== adminId) {
      await api.sendMessage(chatId, '🔒 Perintah ini hanya untuk admin.', { ...(threadId ? { message_thread_id: threadId } : {}) });
      return;
    }
    const name = delMatch[1].toLowerCase();
    await kvDeleteCommand(env, name);
    await api.sendMessage(chatId, `🗑️ Command dihapus: /${name}`, { ...(threadId ? { message_thread_id: threadId } : {}) });
    return;
  }

  if (/^\/listcmd(?:@[A-Za-z0-9_]+)?$/i.test(text)) {
    const names = await kvListCommands(env);
    const body = names.length ? names.map(n => `• /${n}`).join('\n') : '— (kosong)';
    await api.sendMessage(chatId, `📜 Daftar Custom Commands:\n\n${body}`, { ...(threadId ? { message_thread_id: threadId } : {}) });
    return;
  }

  // ===== cekkuota: command atau angka langsung =====
  const msisdnArg = text.match(/^\/(?:cek|kuota|cekkuota)(?:@[A-Za-z0-9_]+)?\s+(.+)/i)?.[1];
  const normalized = normalizeNumber(msisdnArg || (!isCmd ? text.trim() : ''));
  if (normalized) {
    await api.sendChatAction(chatId, 'typing');
    const loading = await api.sendMessage(chatId, `🔍 Mengecek <code>${normalized}</code>...`, {
      parse_mode: 'HTML',
      ...(threadId ? { message_thread_id: threadId } : {})
    });
    try {
      const res = await cekKuotaKMSP(normalized);
      const kb = { inline_keyboard: [[{ text: '🔄 Cek ulang', callback_data: `cekkuota:retry:${normalized}` }]] };
      await api.editMessageText(chatId, loading.message_id, formatKuotaHTML(normalized, res), {
        parse_mode: 'HTML', reply_markup: kb
      });
    } catch (e) {
      await api.editMessageText(chatId, loading.message_id, `❌ ${esc(e.message)}`, { parse_mode: 'HTML' });
    }
    return;
  }

  // ===== converter: entry =====
  if (/^\/(?:convert|converter|v2conv|v2ray)(?:@[A-Za-z0-9_]+)?$/i.test(text)) {
    await api.sendMessage(chatId,
      'Pilih salah satu atau langsung kirim input:\n\n' +
      '• Kirim link VLESS/VMESS/TROJAN ➜ aku kirim menu format\n' +
      '• Kirim Clash YAML (1 proxy) ➜ aku kirim link yang sesuai',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔗 Link → Config', callback_data: 'conv:l2c' }],
            [{ text: '🧩 Config → Link', callback_data: 'conv:c2l' }],
            [{ text: '❌ Tutup', callback_data: 'conv:close' }],
          ]
        },
        ...(threadId ? { message_thread_id: threadId } : {})
      }
    );
    return;
  }

  // ===== converter: langsung kirim link / config =====
  if (text.startsWith('vless://') || text.startsWith('vmess://') || text.startsWith('trojan://')) {
    try {
      const link = tryUrlDecode(text.split(/\s+/)[0]);
      const d = link.startsWith('vless://') ? parseVlessUri(link)
            : link.startsWith('vmess://') ? parseVmessUri(link)
            : parseTrojanUri(link);
      await api.sendMessage(chatId,
        `<b>Link → Config</b>\nProtocol: <code>${esc(d.protocol.toUpperCase())}</code>\nRemark: <code>${esc(d.remark)}</code>\nServer: <code>${esc(d.server)}:${d.port}</code>\n\nPilih format hasil:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Clash Meta (Full)', callback_data: `fmt:clash:${encodeState(d)}` },
               { text: 'Nekobox', callback_data: `fmt:neko:${encodeState(d)}` }],
              [{ text: 'Sing-Box New', callback_data: `fmt:singnew:${encodeState(d)}` },
               { text: 'Sing-Box Old', callback_data: `fmt:singold:${encodeState(d)}` }],
              [{ text: 'Config → Link', callback_data: `fmt:link:${encodeState(d)}` }]
            ]
          }
        }
      );
    } catch (e) {
      await api.sendMessage(chatId, `❌ Gagal baca link: <code>${esc(e.message)}</code>`, { parse_mode: 'HTML' });
    }
    return;
  }

  if (/proxies\s*:/i.test(text) || /\btype\s*:\s*(vless|vmess|trojan)/i.test(text)) {
    try {
      const d = parseClashProxy(text);
      if (!d || !d.protocol || !d.server || !d.port) {
        await api.sendMessage(chatId, '❌ Config tidak lengkap. Pastikan section "proxies:" berisi satu proxy.', { parse_mode: 'HTML' });
        return;
      }
      const link = objectToLink(d);
      await api.sendMessage(chatId, `🔗 <b>Config → Link</b>\n\n<code>${esc(link)}</code>`, {
        parse_mode: 'HTML', disable_web_page_preview: true
      });
      await api.sendMessage(chatId, 'Ingin format lain dari objek ini?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Clash Meta (Full)', callback_data: `fmt:clash:${encodeState(d)}` },
             { text: 'Nekobox', callback_data: `fmt:neko:${encodeState(d)}` }],
            [{ text: 'Sing-Box New', callback_data: `fmt:singnew:${encodeState(d)}` },
             { text: 'Sing-Box Old', callback_data: `fmt:singold:${encodeState(d)}` }],
            [{ text: 'Config → Link', callback_data: `fmt:link:${encodeState(d)}` }]
          ]
        }
      });
    } catch (e) {
      await api.sendMessage(chatId, `❌ Gagal baca config: <code>${esc(e.message)}</code>`, { parse_mode: 'HTML' });
    }
    return;
  }

  // ===== Custom command execution: /<name> =====
  if (isCmd) {
    const m = text.match(/^\/(\w+)/);
    if (m) {
      const name = m[1].toLowerCase();
      const cmd = await kvGetCommand(env, name);
      if (cmd && cmd.text) {
        await api.sendMessage(chatId, cmd.text, { ...(threadId ? { message_thread_id: threadId } : {}) });
        return;
      }
    }
  }
}

// ===== Callback Router =====
async function handleCallback(q, api, env) {
  const chatId = q.message.chat.id;
  const data = q.data || '';
  try { await api.answerCallbackQuery(q.id); } catch {}

  if (data === 'help_main') {
    const text =
      '📖 Available Commands\n\n' +
      categoryList.map(c => `• ${capitalize(c)}`).join('\n') +
      '\n\nKetik /help untuk detail.';
    await safeEdit(api, chatId, q.message, text, backKb);
    return;
  }
  if (data === 'menu_main') {
    await sendMainMenu(api, chatId);
    return;
  }
  if (data === 'back_main') {
    await sendMainMenu(api, chatId);
    return;
  }

  // Menu kategori: tampilkan daftar perintah
  if (data.startsWith('menu_')) {
    const category = data.slice('menu_'.length);
    if (category === 'custom') {
      const names = await kvListCommands(env);
      const displayName = capitalize(category);
      const text = names.length
        ? `📂 *Perintah dalam kategori "${displayName}":*\n\n` + names.map(n => `◦ /${n}`).join('\n')
        : `⚠️ Tidak ada perintah ditemukan di kategori *${displayName}*.`;
      await safeEdit(api, chatId, q.message, text, backKb);
      return;
    } else {
      const cmds = getCommandsForCategory(category);
      const displayName = capitalize(category);
      let text;
      if (!cmds.length) {
        text = `⚠️ Tidak ada perintah ditemukan di kategori *${displayName}*.`;
      } else {
        text = `📂 *Perintah dalam kategori "${displayName}":*\n\n` + cmds.map(c => `◦ /${c}`).join('\n');
      }
      await safeEdit(api, chatId, q.message, text, backKb);
      return;
    }
  }

  if (data.startsWith('cekkuota:')) {
    const [_, action, num] = data.split(':');
    if (action === 'retry' && num) {
      try {
        const res = await cekKuotaKMSP(num);
        const kb = { inline_keyboard: [[{ text: '🔄 Cek ulang', callback_data: `cekkuota:retry:${num}` }]] };
        await safeEdit(api, chatId, q.message, formatKuotaHTML(num, res), kb);
      } catch {
        await api.editMessageText(chatId, q.message.message_id, '❌ Error cek ulang.');
      }
    }
    return;
  }

  if (data.startsWith('conv:')) {
    const action = data.split(':')[1];
    if (action === 'close') {
      try { await api.editMessageText(chatId, q.message.message_id, '❎ Ditutup.'); } catch {}
      return;
    }
    if (action === 'l2c') {
      await api.sendMessage(chatId, 'Kirim link VLESS/VMESS/TROJAN (satu baris).');
      return;
    }
    if (action === 'c2l') {
      await api.sendMessage(chatId, 'Kirim Clash YAML yang berisi satu proxy pada section "proxies:".');
      return;
    }
  }

  if (data.startsWith('fmt:')) {
    const [_, fmt, encoded] = data.split(':');
    const d = decodeState(encoded);
    if (!d || !d.protocol) {
      await api.sendMessage(chatId, '❌ Sesi hilang. Kirim ulang link atau config.');
      return;
    }
    if (fmt === 'link') {
      const link = objectToLink(d);
      await api.sendMessage(chatId, `🔗 <b>Hasil LINK</b>\n\n<code>${esc(link)}</code>`, { parse_mode: 'HTML', disable_web_page_preview: true });
      return;
    }
    let out = '';
    if (fmt === 'clash') out = generateClashFull(d);
    else if (fmt === 'neko') out = generateNeko(d);
    else if (fmt === 'singnew') out = generateSingNew(d);
    else if (fmt === 'singold') out = generateSingOld(d);

    await api.sendMessage(chatId, `🔹 <b>Hasil</b>\n<pre><code>${esc(out)}</code></pre>`, { parse_mode: 'HTML' });
    return;
  }
}
    if (fmt === 'link') {
      const link = objectToLink(d);
      await api.sendMessage(chatId, `🔗 <b>Hasil LINK</b>\n\n<code>${esc(link)}</code>`, { parse_mode: 'HTML', disable_web_page_preview: true });
      return;
    }
    let out = '';
    if (fmt === 'clash') out = generateClashFull(d);
    else if (fmt === 'neko') out = generateNeko(d);
    else if (fmt === 'singnew') out = generateSingNew(d);
    else if (fmt === 'singold') out = generateSingOld(d);

    await api.sendMessage(chatId, `🔹 <b>Hasil</b>\n<pre><code>${esc(out)}</code></pre>`, { parse_mode: 'HTML' });
    return;
  }
}

// ===== Menu helpers =====
async function sendMainMenu(api, chatId, threadId) {
  const caption = `*Menu Utama*\n\nSilakan pilih salah satu kategori:`;
  const kb = menuKb(categoryList);
  await api.sendPhoto(chatId, MENU_IMAGE, {
    caption, parse_mode: 'Markdown', reply_markup: kb, ...(threadId ? { message_thread_id: threadId } : {})
  });
}

// ===== Cek Kuota (port dari commands/all/cekkuota.js) =====
function normalizeNumber(input) {
  if (!input) return null;
  let s = String(input).trim().replace(/[\\s().\\-]/g, '');
  if (s.startsWith('+')) s = s.slice(1);

  if (/^0\\d+$/i.test(s)) s = '62' + s.slice(1);
  else if (/^8\\d+$/i.test(s)) s = '62' + s;
  else if (/^62\\d+$/i.test(s)) {
    // ok
  } else if (!/^\\d+$/.test(s)) return null;

  if (s.length < 10 || s.length > 15) return null;
  return s;
}
const progressBar = (remaining, total) => {
  if (!total) return '□□□□□□□□□□ 0%';
  const pct = Math.max(0, Math.min(1, remaining / total));
  const len = 10;
  const filled = Math.round(pct * len);
  const bar = '█'.repeat(filled) + '░'.repeat(len - filled);
  return `${bar} ${(pct * 100).toFixed(0)}%`;
};
const parseSize = (sizeStr) => {
  if (!sizeStr) return 0;
  const m = sizeStr.match(/^([\\d.]+)\\s*(TB|GB|MB|KB|B)?/i);
  if (!m) return 0;
  const value = parseFloat(m[1]);
  const unit = (m[2] || 'MB').toUpperCase();
  switch (unit) {
    case 'TB': return value * 1024 ** 4;
    case 'GB': return value * 1024 ** 3;
    case 'MB': return value * 1024 ** 2;
    case 'KB': return value * 1024;
    default: return value;
  }
};
function formatKuotaHTML(msisdn, res) {
  const sp = res?.data?.data_sp || {};
  const operator = esc(sp?.prefix?.value || '-') || '-';
  const aktif = esc(sp?.active_period?.value || '-') || '-';
  const tenggang = esc(sp?.grace_period?.value || '-') || '-';

  let text = `📡 <b>Cek Kuota</b> <code>${operator}</code>\n`;
  text += `📱 <b>Nomor:</b> <code>${msisdn}</code>\n`;
  text += `⏳ Aktif: ${aktif} | ⚠️ Tenggang: ${tenggang}\n\n`;

  if (res?.data?.hasil) {
    const raw = String(res.data.hasil)
      .replace(/<br\\s*\\/?>/gi, '\\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim();

    const sections = raw.split(/(?=🎁\\s*(Quota|Benefit)\\s*:)/g);
    let printed = false;

    for (const section of sections) {
      if (!section.trim()) continue;
      const lines = section.split('\\n').map(l => l.trim());

      const name = lines.find(l => /🎁\\s*(Quota|Benefit)\\s*:/i.test(l));
      const total = lines.find(l => /🎁\\s*Kuota\\s*:/i.test(l));
      const sisa = lines.find(l => /🌲\\s*Sisa Kuota\\s*:/i.test(l));
      const exp = lines.find(l => /🍂\\s*Aktif Hingga\\s*:/i.test(l));

      if (name) {
        printed = true;
        const n = esc(name.replace(/🎁\\s*(Quota|Benefit)\\s*:\\s*/i, ''));
        text += `📦 <b>${n}</b>${exp ? ' — ' + exp.replace('🍂 Aktif Hingga:', 'Exp:') : ''}\\n`;
        if (total && sisa) {
          const t = total.replace(/🎁\\s*Kuota:\\s*/i, '');
          const s = sisa.replace(/🌲\\s*Sisa Kuota:\\s*/i, '');
          const bar = progressBar(parseSize(s), parseSize(t));
          text += `  • ${s} / ${t}\\n  • <code>${bar}</code>\\n\\n`;
        }
      }
    }

    if (!printed) text += `<pre>${esc(raw)}</pre>\\n`;
  } else {
    text += '❌ Tidak ada info kuota.\\n';
  }

  return text;
}
async function cekKuotaKMSP(msisdn) {
  const url = 'https://apigw.kmsp-store.com/sidompul/v4/cek_kuota';
  const res = await fetch(`${url}?msisdn=${encodeURIComponent(msisdn)}&isJSON=true`, {
    headers: {
      Authorization: 'Basic c2lkb21wdWxhcGk6YXBpZ3drbXNw',
      'X-API-Key': '60ef29aa-a648-4668-90ae-20951ef90c55',
      'X-App-Version': '4.0.0'
    }
  });
  const data = await res.json();
  return data;
}

// ===== Converter helpers (port dari convert.js) =====
const tryUrlDecode = (s='') => { try {
  return /%[0-9A-Fa-f]{2}/.test(s) ? decodeURIComponent(s) : s;
} catch { return s; } };

function parseVlessUri(uri) {
  const u = new URL(uri);
  return {
    protocol: 'vless',
    remark: decodeURIComponent(u.hash.substring(1)) || 'VLESS',
    server: u.hostname,
    port: parseInt(u.port || '443', 10),
    uuid: decodeURIComponent(u.username),
    network: u.searchParams.get('type') || 'tcp',
    security: (u.searchParams.get('security') || 'none').toLowerCase(),
    sni: u.searchParams.get('sni') || u.searchParams.get('servername') || u.searchParams.get('host') || u.hostname,
    host: u.searchParams.get('host') || u.searchParams.get('sni') || u.hostname,
    path: decodeURIComponent(u.searchParams.get('path') || '/'),
  };
}
function parseVmessUri(uri) {
  const base64Part = uri.substring('vmess://'.length).trim();
  const decoded = JSON.parse(Buffer.from(base64Part, 'base64').toString('utf8'));
  return {
    protocol: 'vmess',
    remark: decoded.ps || 'VMess',
    server: decoded.add,
    port: parseInt(decoded.port || '443', 10),
    uuid: decoded.id,
    alterId: parseInt(decoded.aid || '0', 10),
    network: decoded.net || 'tcp',
    security: decoded.tls === 'tls' ? 'tls' : 'none',
    sni: decoded.sni || decoded.host || decoded.add,
    host: decoded.host || decoded.sni || decoded.add,
    path: decoded.path || '/',
  };
}
function parseTrojanUri(uri) {
  const u = new URL(uri);
  return {
    protocol: 'trojan',
    remark: decodeURIComponent(u.hash.substring(1)) || 'Trojan',
    server: u.hostname,
    port: parseInt(u.port || '443', 10),
    password: decodeURIComponent(u.username),
    network: u.searchParams.get('type') || 'tcp',
    security: (u.searchParams.get('security') || 'none').toLowerCase(),
    sni: u.searchParams.get('sni') || u.searchParams.get('host') || u.hostname,
    host: u.searchParams.get('host') || u.searchParams.get('sni') || u.hostname,
    path: decodeURIComponent(u.searchParams.get('path') || '/'),
  };
}
function parseClashProxy(text) {
  const m = text.match(/proxies:\\s*([\\s\\S]*?)(?:\\n(?:proxy-groups|rules)\\s*:|\\s*$)/i);
  const block = (m ? m[1] : text).trim();

  const pick = (key) => {
    const re = new RegExp(`\\b${key}\\s*:\\s*([^\\n#]+)`, 'i');
    const x = block.match(re);
    if (!x) return '';
    return x[1].trim().replace(/^[\"']|[\"']$/g,'');
  };

  let hostHeader = '';
  const wsBlockMatch = block.match(/ws-opts\\s*:\\s*([\\s\\S]*?)(?:\\n\\s*[a-zA-Z_-]+\\s*:|\\n{2,}|$)/i);
  if (wsBlockMatch) {
    const wsBlock = wsBlockMatch[1];
    const hostM = wsBlock.match(/headers\\s*:\\s*[\\s\\S]*?\\bHost\\s*:\\s*([^\\n#]+)/i);
    if (hostM) hostHeader = hostM[1].trim().replace(/^[\"']|[\"']$/g,'');
  }

  const protocolRaw = pick('type').toLowerCase();
  const d = {
    protocol: protocolRaw,
    remark: pick('name') || 'Proxy',
    server: pick('server'),
    port: parseInt(pick('port') || '0', 10),
    network: (pick('network') || 'tcp').toLowerCase(),
    sni: pick('servername') || pick('sni') || '',
    host: hostHeader || pick('host') || '',
    path: pick('path') || '',
    security: (/tls:\\s*true/i.test(block) || /security:\\s*tls/i.test(block)) ? 'tls' : 'none'
  };

  if (protocolRaw === 'vless' || protocolRaw === 'vmess') {
    d.uuid = pick('uuid');
    d.alterId = parseInt(pick('alterId') || '0', 10);
  } else if (protocolRaw === 'trojan') {
    d.password = pick('password');
  }

  return d;
}
function objectToLink(d) {
  if (!d || !d.protocol) return '';
  if (d.protocol === 'vless') {
    return `vless://${d.uuid}@${d.server}:${d.port}?encryption=none&type=${d.network}` +
           `&host=${encodeURIComponent(d.host||'')}&path=${encodeURIComponent(d.path||'/')}` +
           `&security=${d.security||'none'}&sni=${encodeURIComponent(d.sni||'')}` +
           `#${encodeURIComponent(d.remark||'VLESS')}`;
  }
  if (d.protocol === 'vmess') {
    const json = {
      v: "2",
      ps: d.remark || 'vmess',
      add: d.server,
      port: String(d.port || 0),
      id: d.uuid || '',
      aid: String(d.alterId || 0),
      net: d.network || 'tcp',
      type: "none",
      host: d.host || '',
      path: d.path || '',
      tls: d.security === 'tls' ? 'tls' : ''
    };
    return "vmess://" + Buffer.from(JSON.stringify(json)).toString("base64");
  }
  if (d.protocol === 'trojan') {
    return `trojan://${d.password}@${d.server}:${d.port}?type=${d.network}` +
           `&host=${encodeURIComponent(d.host||'')}&path=${encodeURIComponent(d.path||'/')}` +
           `&security=${d.security||'none'}&sni=${encodeURIComponent(d.sni||'')}` +
           `#${encodeURIComponent(d.remark||'Trojan')}`;
  }
  return '';
}
function generateClashFull(d) {
  let proxyBlock = "";
  if (d.protocol === "trojan") {
    proxyBlock = `- name: "${d.remark}"
  server: ${d.server}
  port: ${d.port}
  type: trojan
  password: ${d.password}
  skip-cert-verify: true
  sni: ${d.sni}
  network: ${d.network}
  ws-opts:
    path: "${d.path}"
    headers:
      Host: ${d.host}
  udp: true`;
  } else {
    proxyBlock = `- name: "${d.remark}"
  server: ${d.server}
  port: ${d.port}
  type: ${d.protocol}
  uuid: ${d.uuid}
  ${d.protocol==='vmess' ? `alterId: ${d.alterId}\n  ` : ''}cipher: auto
  tls: ${d.security==='tls'}
  udp: true
  skip-cert-verify: true
  network: ${d.network}
  servername: ${d.sni}
  ws-opts:
    path: "${d.path}"
    headers:
      Host: ${d.host}`;
  }

  return `port: 7890
mixed-port: 7893
allow-lan: true
mode: rule
external-controller: 0.0.0.0:9090
dns:
  enable: true
  enhanced-mode: fake-ip
  nameserver:
    - 8.8.8.8
proxies:
${proxyBlock}
proxy-groups:
- name: INTERNET
  type: select
  proxies:
    - "${d.remark}"
    - DIRECT
rules:
- MATCH,INTERNET`;
}
function generateNeko(d){
  if (d.protocol === 'trojan') {
    return JSON.stringify({
      outbounds:[{
        tag:d.remark, type:'trojan',
        server:d.server, server_port:d.port, password:d.password,
        tls:{ enabled:true, insecure:true, server_name:d.sni },
        transport:{ type:'ws', path:d.path, headers:{ Host:d.host } }
      }]
    }, null, 2);
  }
  const o = { tag:d.remark, type:d.protocol, server:d.server, server_port:d.port, uuid:d.uuid };
  if (d.protocol==='vmess') { o.alter_id = d.alterId; o.security = 'auto'; }
  if (d.security==='tls') o.tls = { enabled:true, insecure:true, server_name:d.sni };
  if (d.network==='ws') o.transport = { type:'ws', path:d.path, headers:{ Host:d.host } };
  return JSON.stringify({ outbounds:[o] }, null, 2);
}
const generateSingNew = generateNeko;
const generateSingOld = generateClashFull;

// Encode state kecil di callback_data (panjang dibatasi, jadi compress sederhana)
function encodeState(obj) {
  const json = JSON.stringify(obj);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  // Hindari karakter ":" yang bentrok dengan parsing callback
  return b64.replace(/:/g, '_');
}
function decodeState(s) {
  try {
    const fixed = s.replace(/_/g, ':');
    const json = decodeURIComponent(escape(atob(fixed)));
    return JSON.parse(json);
  } catch { return null; }
}
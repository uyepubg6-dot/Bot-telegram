
const axios = require("axios");

const lastUse = new Map();
function rateLimit(userId, ms = 6000) {
  const now = Date.now();
  const prev = lastUse.get(userId) || 0;
  if (now - prev < ms) return Math.ceil((ms - (now - prev)) / 1000);
  lastUse.set(userId, now);
  return 0;
}

function normalizeNumber(input) {
  if (!input) return null;
  let s = String(input).trim().replace(/[\s().\-]/g, "");
  if (s.startsWith("+")) s = s.slice(1);

  if (/^0\d+$/i.test(s)) s = "62" + s.slice(1);
  else if (/^8\d+$/i.test(s)) s = "62" + s;
  else if (/^62\d+$/i.test(s)) {
    // ok
  } else if (!/^\d+$/.test(s)) return null;

  if (s.length < 10 || s.length > 15) return null;
  return s;
}

function threadOpts(msg, extra = {}) {
  const opts = { ...extra };
  if (msg?.message_thread_id) opts.message_thread_id = msg.message_thread_id;
  else if (msg?.reply_to_message?.message_thread_id)
    opts.message_thread_id = msg.reply_to_message.message_thread_id;
  return opts;
}

function kb(msisdn) {
  return {
    inline_keyboard: [[{ text: "🔄 Cek ulang", callback_data: `cekkuota:retry:${msisdn}` }]],
  };
}

function escapeHTML(str) {
  if (!str && str !== 0) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// Progress bar
function progressBar(remaining, total) {
  if (!total) return "□□□□□□□□□□ 0%";
  const pct = Math.max(0, Math.min(1, remaining / total));
  const len = 10;
  const filled = Math.round(pct * len);
  const bar = "█".repeat(filled) + "░".repeat(len - filled);
  return `${bar} ${(pct * 100).toFixed(0)}%`;
}

function parseSize(sizeStr) {
  if (!sizeStr) return 0;
  const m = sizeStr.match(/^([\d.]+)\s*(TB|GB|MB|KB|B)?/i);
  if (!m) return 0;
  const value = parseFloat(m[1]);
  const unit = (m[2] || "MB").toUpperCase();
  switch (unit) {
    case "TB": return value * 1024 ** 4;
    case "GB": return value * 1024 ** 3;
    case "MB": return value * 1024 ** 2;
    case "KB": return value * 1024;
    default: return value;
  }
}


function formatHTML(msisdn, res) {
  const sp = res?.data?.data_sp || {};
  const operator = escapeHTML(sp?.prefix?.value) || "-";
  const aktif = escapeHTML(sp?.active_period?.value) || "-";
  const tenggang = escapeHTML(sp?.grace_period?.value) || "-";

  let text = `📡 <b>Cek Kuota</b> <code>${operator}</code>\n`;
  text += `📱 <b>Nomor:</b> <code>${msisdn}</code>\n`;
  text += `⏳ Aktif: ${aktif} | ⚠️ Tenggang: ${tenggang}\n\n`;

 
  if (res?.data?.hasil) {
    const raw = String(res.data.hasil)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .trim();

    const sections = raw.split(/(?=🎁\s*(Quota|Benefit)\s*:)/g);
    let printed = false;

    for (const section of sections) {
      if (!section.trim()) continue;
      const lines = section.split("\n").map(l => l.trim());

      const name = lines.find(l => /🎁\s*(Quota|Benefit)\s*:/i.test(l));
      const total = lines.find(l => /🎁\s*Kuota\s*:/i.test(l));
      const sisa = lines.find(l => /🌲\s*Sisa Kuota\s*:/i.test(l));
      const exp = lines.find(l => /🍂\s*Aktif Hingga\s*:/i.test(l));

      if (name) {
        printed = true;
        const n = escapeHTML(name.replace(/🎁\s*(Quota|Benefit)\s*:\s*/i, ""));
        text += `📦 <b>${n}</b>${exp ? " — " + exp.replace("🍂 Aktif Hingga:", "Exp:") : ""}\n`;
        if (total && sisa) {
          const t = total.replace(/🎁\s*Kuota:\s*/i, "");
          const s = sisa.replace(/🌲\s*Sisa Kuota:\s*/i, "");
          const bar = progressBar(parseSize(s), parseSize(t));
          text += `  • ${s} / ${t}\n  • <code>${bar}</code>\n\n`;
        }
      }
    }

    if (!printed) text += `<pre>${escapeHTML(raw)}</pre>\n`;
  } else {
    text += "❌ Tidak ada info kuota.\n";
  }

  return text;
}

async function cekKuotaKMSP(msisdn) {
  const { data: res } = await axios.get(
    "https://apigw.kmsp-store.com/sidompul/v4/cek_kuota",
    {
      params: { msisdn, isJSON: true },
      headers: {
        Authorization: "Basic c2lkb21wdWxhcGk6YXBpZ3drbXNw",
        "X-API-Key": "60ef29aa-a648-4668-90ae-20951ef90c55",
        "X-App-Version": "4.0.0",
      },
      timeout: 30000,
    }
  );
  return res;
}

module.exports = (bot) => {
  const CMD_ARG = /\/(?:cek|kuota|cekkuota)(?:@[A-Za-z0-9_]+)?\s+(.+)/i;
  const CMD_NOARG = /\/(?:cek|kuota|cekkuota)(?:@[A-Za-z0-9_]+)?$/i;

 
  bot.onText(CMD_ARG, async (msg, match) => {
    const chatId = msg.chat.id;
    const msisdn = normalizeNumber(match[1]);
    if (!msisdn) {
      return bot.sendMessage(chatId, "❌ Nomor tidak valid.", threadOpts(msg));
    }

    const wait = rateLimit(msg.from.id);
    if (wait) return bot.sendMessage(chatId, `⏳ Tunggu ${wait} detik lagi.`, threadOpts(msg));

    const loading = await bot.sendMessage(chatId, `🔍 Mengecek <code>${msisdn}</code>...`, threadOpts(msg, { parse_mode: "HTML" }));
    try {
      const res = await cekKuotaKMSP(msisdn);
      if (!res || !res.status) throw new Error("Gagal cek kuota.");
      await bot.editMessageText(formatHTML(msisdn, res), {
        chat_id: chatId,
        message_id: loading.message_id,
        parse_mode: "HTML",
        reply_markup: kb(msisdn),
      });
    } catch (e) {
      await bot.editMessageText("❌ " + escapeHTML(e.message), { chat_id: chatId, message_id: loading.message_id, parse_mode: "HTML" });
    }
  });

  
  bot.onText(CMD_NOARG, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      `📋 <b>Cara cek kuota:</b>\n\n<code>/cek 081234567890</code>\n<code>/kuota 6281234567890</code>`,
      threadOpts(msg, { parse_mode: "HTML" })
    );
  });

  
  bot.on("message", async (msg) => {
    if (!msg.text) return;
    if (msg.text.startsWith("/")) return; 

    const msisdn = normalizeNumber(msg.text.trim());
    if (!msisdn) return;

    const chatId = msg.chat.id;
    const wait = rateLimit(msg.from.id);
    if (wait) return bot.sendMessage(chatId, `⏳ Tunggu ${wait} detik lagi.`, threadOpts(msg));

    const loading = await bot.sendMessage(chatId, `🔍 Mengecek <code>${msisdn}</code>...`, threadOpts(msg, { parse_mode: "HTML" }));
    try {
      const res = await cekKuotaKMSP(msisdn);
      if (!res || !res.status) throw new Error("Gagal cek kuota.");
      await bot.editMessageText(formatHTML(msisdn, res), {
        chat_id: chatId,
        message_id: loading.message_id,
        parse_mode: "HTML",
        reply_markup: kb(msisdn),
      });
    } catch (e) {
      await bot.editMessageText("❌ " + escapeHTML(e.message), { chat_id: chatId, message_id: loading.message_id, parse_mode: "HTML" });
    }
  });

  
  bot.on("callback_query", async (cq) => {
    if (!cq.data.startsWith("cekkuota:")) return;
    const [_, action, num] = cq.data.split(":");
    if (action !== "retry") return;

    await bot.answerCallbackQuery(cq.id);
    try {
      const res = await cekKuotaKMSP(num);
      await bot.editMessageText(formatHTML(num, res), {
        chat_id: cq.message.chat.id,
        message_id: cq.message.message_id,
        parse_mode: "HTML",
        reply_markup: kb(num),
      });
    } catch (e) {
      await bot.editMessageText("❌ Error cek ulang.", { chat_id: cq.message.chat.id, message_id: cq.message.message_id });
    }
  });
};
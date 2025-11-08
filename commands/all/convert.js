// @category utility
// @commands convert, converter, v2conv, v2ray


const { Buffer } = require('buffer');

module.exports = (bot) => {
  // ===== Helpers =====
  const threadIdOf = (m) =>
    m?.message_thread_id || m?.reply_to_message?.message_thread_id || undefined;

  const esc = (s='') => String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  const asCode = (s='') => `<pre><code>${esc(s)}</code></pre>`;

  const sendHTML = (chatId, text, opts={}) =>
    bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...opts });

  const tryUrlDecode = (s='') => { try {
    return /%[0-9A-Fa-f]{2}/.test(s) ? decodeURIComponent(s) : s;
  } catch { return s; }};

  const state = new Map();
  const TTL = 10 * 60 * 1000;
  const keep = (uid, st) => state.set(uid, { ...st, ts: Date.now() });
  const get = (uid) => {
    const st = state.get(uid);
    if (!st) return null;
    if (Date.now() - st.ts > TTL) { state.delete(uid); return null; }
    return st;
  };

  
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
    const m = text.match(/proxies:\s*([\s\S]*?)(?:\n(?:proxy-groups|rules)\s*:|\s*$)/i);
    const block = (m ? m[1] : text).trim();

    const pick = (key) => {
      const re = new RegExp(`\\b${key}\\s*:\\s*([^\\n#]+)`, 'i');
      const x = block.match(re);
      if (!x) return '';
      return x[1].trim().replace(/^["']|["']$/g,'');
    };

    let hostHeader = '';
    const wsBlockMatch = block.match(/ws-opts\s*:\s*([\s\S]*?)(?:\n\s*[a-zA-Z_-]+\s*:|\n{2,}|$)/i);
    if (wsBlockMatch) {
      const wsBlock = wsBlockMatch[1];
      const hostM = wsBlock.match(/headers\s*:\s*[\s\S]*?\bHost\s*:\s*([^\n#]+)/i);
      if (hostM) hostHeader = hostM[1].trim().replace(/^["']|["']$/g,'');
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
      security: (/tls:\s*true/i.test(block) || /security:\s*tls/i.test(block)) ? 'tls' : 'none'
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

  
  const entryKb = {
    inline_keyboard: [
      [{ text: '🔗 Link → Config', callback_data: 'conv:l2c' }],
      [{ text: '🧩 Config → Link', callback_data: 'conv:c2l' }],
      [{ text: '❌ Tutup', callback_data: 'conv:close' }],
    ]
  };
  const formatKb = {
    inline_keyboard: [
      [{ text: 'Clash Meta (Full)', callback_data: 'fmt:clash' },
       { text: 'Nekobox', callback_data: 'fmt:neko' }],
      [{ text: 'Sing-Box New', callback_data: 'fmt:singnew' },
       { text: 'Sing-Box Old', callback_data: 'fmt:singold' }],
      [{ text: 'Config → Link', callback_data: 'fmt:link' }]
    ]
  };


  const entryRegex = /^\/(?:convert|converter|v2conv|v2ray)(?:@[A-Za-z0-9_]+)?$/i;
  bot.onText(entryRegex, async (msg) => {
    const chatId = msg.chat.id;
    const threadId = threadIdOf(msg);
    keep(msg.from.id, { data: null, chatId, threadId });
    await sendHTML(
      chatId,
      'Pilih salah satu atau langsung kirim input:\n\n' +
      '• Kirim <b>link</b> vless/vmess/trojan ➜ aku kirim menu format (Clash/Neko/SingBox)\n' +
      '• Kirim <b>Clash YAML</b> (berisi 1 proxy) ➜ aku kirim link yang sesuai',
      { reply_markup: entryKb, ...(threadId ? { message_thread_id: threadId } : {}) }
    );
  });

 
  bot.on('callback_query', async (q) => {
    if (!q.data) return;
    try { await bot.answerCallbackQuery(q.id); } catch {}
    const chatId = q.message?.chat?.id;
    const threadId = q.message?.message_thread_id;
    const st = get(q.from.id) || { chatId, threadId };

    if (q.data === 'conv:close') {
      try { await bot.editMessageText('❎ Ditutup.', { chat_id: chatId, message_id: q.message.message_id }); } catch {}
      state.delete(q.from.id);
      return;
    }
    if (q.data === 'conv:l2c') {
      return sendHTML(chatId, 'Kirim link <b>VLESS / VMESS / TROJAN</b> (satu baris).', {
        ...(threadId ? { message_thread_id: threadId } : {})
      });
    }
    if (q.data === 'conv:c2l') {
      return sendHTML(chatId, 'Kirim <b>Clash YAML</b> yang berisi satu proxy pada section <code>proxies:</code>.', {
        ...(threadId ? { message_thread_id: threadId } : {})
      });
    }

    if (q.data.startsWith('fmt:')) {
      const cur = get(q.from.id);
      if (!cur || !cur.data) {
        return sendHTML(chatId, '❌ Sesi hilang. Kirim ulang link atau config.', {
          ...(threadId ? { message_thread_id: threadId } : {})
        });
      }
      const d = cur.data;
      const choice = q.data.split(':')[1];
      let out = '';

      if (choice === 'clash') out = generateClashFull(d);
      else if (choice === 'neko') out = generateNeko(d);
      else if (choice === 'singnew') out = generateSingNew(d);
      else if (choice === 'singold') out = generateSingOld(d);
      else if (choice === 'link') {
        const link = objectToLink(d);
        return bot.sendMessage(cur.chatId, `🔗 <b>Hasil LINK</b>\n\n<code>${esc(link)}</code>`, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...(cur.threadId ? { message_thread_id: cur.threadId } : {}),
        });
      }

      keep(q.from.id, cur); // refresh ttl
      return sendHTML(cur.chatId, `🔹 <b>Hasil</b>\n${asCode(out)}`, {
        ...(cur.threadId ? { message_thread_id: cur.threadId } : {})
      });
    }
  });

  
  bot.on('message', async (msg) => {
    if (!msg.text) return;
    const chatId = msg.chat.id;
    const threadId = threadIdOf(msg);
    const text = msg.text.trim();

    
    if (text.startsWith('vless://') || text.startsWith('vmess://') || text.startsWith('trojan://')) {
      try {
        let link = tryUrlDecode(text.split(/\s+/)[0]);
        let d;
        if (link.startsWith('vless://')) d = parseVlessUri(link);
        else if (link.startsWith('vmess://')) d = parseVmessUri(link);
        else d = parseTrojanUri(link);

        keep(msg.from.id, { data: d, chatId, threadId });

        await sendHTML(
          chatId,
          `<b>Link → Config</b>\nProtocol: <code>${esc(d.protocol.toUpperCase())}</code>\nRemark: <code>${esc(d.remark)}</code>\nServer: <code>${esc(d.server)}:${d.port}</code>\n\nPilih format hasil yang diinginkan:`,
          { reply_markup: {
              inline_keyboard: [
                [{ text: 'Clash Meta (Full)', callback_data: 'fmt:clash' },
                 { text: 'Nekobox', callback_data: 'fmt:neko' }],
                [{ text: 'Sing-Box New', callback_data: 'fmt:singnew' },
                 { text: 'Sing-Box Old', callback_data: 'fmt:singold' }],
                [{ text: 'Config → Link', callback_data: 'fmt:link' }]
              ]
            },
            ...(threadId ? { message_thread_id: threadId } : {})
          }
        );
      } catch (e) {
        await sendHTML(chatId, `❌ Gagal baca link: <code>${esc(e.message)}</code>`, {
          ...(threadId ? { message_thread_id: threadId } : {})
        });
      }
      return;
    }


    if (/proxies\s*:/i.test(text) || /\btype\s*:\s*(vless|vmess|trojan)/i.test(text)) {
      try {
        const d = parseClashProxy(text);
        if (!d || !d.protocol || !d.server || !d.port) {
          return sendHTML(chatId, '❌ Config tidak lengkap. Pastikan section <code>proxies:</code> berisi satu proxy.', {
            ...(threadId ? { message_thread_id: threadId } : {})
          });
        }
        const link = objectToLink(d);
        keep(msg.from.id, { data: d, chatId, threadId });

        await bot.sendMessage(chatId, `🔗 <b>Config → Link</b>\n\n<code>${esc(link)}</code>`, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...(threadId ? { message_thread_id: threadId } : {})
        });


        await sendHTML(chatId, `Ingin format lain dari objek ini?`, {
          reply_markup: formatKb,
          ...(threadId ? { message_thread_id: threadId } : {})
        });
      } catch (e) {
        await sendHTML(chatId, `❌ Gagal baca config: <code>${esc(e.message)}</code>`, {
          ...(threadId ? { message_thread_id: threadId } : {})
        });
      }
    }
  });
};
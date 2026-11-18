// Send the check-in summary by SMTP (163 mailbox by default).
// No dependencies: a minimal SMTP client over implicit TLS.
//
// Usage:
//   node mail.js [--state last-run.json] [--config mail.json] [--to a@b.c] [--dry]
//   node mail.js --test            # send a one-line connectivity test
//
// mail.json:
//   { "host": "smtp.163.com", "port": 465, "secure": true,
//     "user": "xxx@163.com", "pass": "<163 授权码>",
//     "from": "xxx@163.com", "to": "181013051@qq.com" }

const fs = require('fs');
const path = require('path');
const tls = require('tls');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[k] = next; i++; }
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }

function encSubject(s) { return '=?UTF-8?B?' + b64(s) + '?='; }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readJson(file) {
  // Windows PowerShell's UTF8 writer may prepend a BOM; strip it before parsing
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function readConfig(file) {
  if (!fs.existsSync(file)) return null;
  try { return readJson(file); } catch (e) {
    throw new Error('cannot parse ' + file + ': ' + e.message);
  }
}

// ---- minimal SMTP over implicit TLS ----------------------------------------

function smtpSend(cfg, message) {
  return new Promise((resolve, reject) => {
    const host = cfg.host || 'smtp.163.com';
    const port = cfg.port || 465;
    const steps = [];
    let buf = '';
    let waiter = null;
    let finished = false;

    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: true }, () => {
      // wait for the greeting before talking
    });

    const timer = setTimeout(() => fail(new Error('timeout talking to ' + host + ':' + port)), 30000);

    function fail(err) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch (_) {}
      reject(err);
    }

    function done() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { sock.end(); } catch (_) {}
      resolve(steps);
    }

    function onLine(line) {
      steps.push(line);
      if (waiter) { const w = waiter; waiter = null; w(line); }
    }

    function readLine() {
      return new Promise((res) => {
        const idx = buf.indexOf('\r\n');
        if (idx >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          res(line);
          return;
        }
        waiter = res;
      });
    }

    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (waiter) {
        const idx = buf.indexOf('\r\n');
        if (idx >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const w = waiter; waiter = null; w(line);
        }
      }
    });
    sock.on('error', (e) => fail(e));

    // read a full (possibly multi-line) reply, return its final line
    async function reply() {
      for (;;) {
        const line = await readLine();
        onLine(line);
        if (/^\d{3} /.test(line)) return line;
        if (/^\d{3}-/.test(line)) continue;
        return line;
      }
    }

    function cmd(text, expect) {
      return new Promise((res, rej) => {
        sock.write(text + '\r\n');
        reply().then((line) => {
          const code = parseInt(line.slice(0, 3), 10);
          if (expect && code !== expect) return rej(new Error('expect ' + expect + ' got: ' + line));
          res(line);
        }).catch(rej);
      });
    }

    (async () => {
      await reply();                                  // 220 greeting
      await cmd('EHLO checkin-all', 250);
      await cmd('AUTH LOGIN', 334);
      await cmd(b64(cfg.user), 334);
      const authRes = await cmd(b64(cfg.pass), 235).catch((e) => {
        throw new Error('AUTH failed (check the 163 授权码, not the login password): ' + e.message);
      });
      void authRes;
      await cmd('MAIL FROM:<' + cfg.from + '>', 250);
      await cmd('RCPT TO:<' + (cfg.to) + '>', 250);
      await cmd('DATA', 354);
      sock.write(message);
      sock.write('\r\n.\r\n');
      const end = await reply();
      if (parseInt(end.slice(0, 3), 10) !== 250) throw new Error('message rejected: ' + end);
      await cmd('QUIT', 221).catch(() => {});
      done();
    })().catch(fail);
  });
}

// ---- report rendering ------------------------------------------------------

function stateEmoji(state) {
  switch (state) {
    case 'OK': return '✅';
    case 'WARN': return '⚠️';
    case 'NEEDS-AUTH': return '🔑';
    case 'TIMEOUT': return '⏱️';
    case 'MISSING': return '❓';
    default: return '❌';
  }
}

function fmtNum(n) {
  const v = Number(n);
  if (!isFinite(v)) return String(n == null ? 0 : n);
  const r = Math.round(v * 100) / 100;
  return r.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function parseBalance(line) {
  if (!line) return '';
  const m = line.match(/BALANCE\s+(\{.*\})\s*$/);
  if (!m) return '';
  try {
    const bal = JSON.parse(m[1]);
    // 优先展示真实「剩余可用额度」，没有该字段时才退回活动维度数据
    if (bal.remaining != null) {
      if (bal.service === 'Loomy') {
        return `${fmtNum(bal.remaining)} 点（永久 ${fmtNum(bal.permanent || 0)} + 每日 ${fmtNum(bal.daily || 0)}）`;
      }
      if (bal.service === 'MiniMax' && bal.planCredits != null) {
        return `${fmtNum(bal.remaining)} 点（套餐 ${fmtNum(bal.planCredits)} + 活动 ${fmtNum(bal.bonusCredits || 0)}）`;
      }
      let s = `${fmtNum(bal.remaining)} ${bal.service === 'Qoder' || bal.service === 'Trae' ? 'Credits' : bal.service === 'WorkBuddy' ? '积分' : '点'}`;
      const whole = bal.quotaTotal != null ? bal.quotaTotal : (bal.total != null ? bal.total : bal.capacity);
      if (whole != null && Math.abs(Number(whole) - Number(bal.remaining)) > 0.001) s += ` / 共 ${fmtNum(whole)}`;
      if (bal.reward) s += ` · 每日 +${bal.reward}`;
      return s; // 剩余优先
    }
    if (bal.service === 'WorkBuddy') return `总计 ${bal.total || 0} 积分 / 今日 ${bal.daily || 0} / 连签 ${bal.streak || 0}天`;
    if (bal.service === 'Trae') return `${bal.credits || 0} 积分`;
    if (bal.service === 'Qoder') return `${bal.balance || 0} Credits`;
    if (bal.service === 'MiniMax') return `今日 ${bal.todayPoints || 0} 点 / 累计 ${bal.totalPoints || 0} / 第${bal.streak || 0}天`;
    if (bal.service === 'Doubao') return `累计 ${bal.earnedTotal || bal.total || 0} 点 / 每日 ${bal.reward || 400} / 连签 ${bal.streak || 0}天`;
    return JSON.stringify(bal);
  } catch { return ''; }
}

function buildReport(state, opts) {
  const when = new Date(state.at || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = when.getFullYear() + '-' + pad(when.getMonth() + 1) + '-' + pad(when.getDate())
    + ' ' + pad(when.getHours()) + ':' + pad(when.getMinutes());

  const jobs = state.jobs || [];
  const ok = jobs.filter((j) => j.State === 'OK').length;
  const overall = state.overall === 'ok';

  // 需要人工介入的服务（exit 2 = 凭证/session 失效，只能本人重新登录）
  const reauth = (state.reauth || []);

  const rows = jobs.map((j) => {
    const tail = String(j.Tail || '').replace(/\s+/g, ' ').trim();
    const short = tail.length > 260 ? tail.slice(0, 260) + '…' : tail;
    const balanceText = parseBalance(j.Balance);
    return '<tr>'
      + '<td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap">' + esc(j.Name) + '</td>'
      + '<td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap">' + stateEmoji(j.State) + ' ' + esc(j.State) + '</td>'
      + '<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">' + esc(j.Exit) + '</td>'
      + '<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">' + esc(j.Elapsed) + 's</td>'
      + '<td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap;color:#444">' + esc(balanceText) + '</td>'
      + '</tr>'
      + '<tr><td colspan="5" style="padding:0 10px 10px 10px;border-bottom:1px solid #f2f2f2;color:#666;font-size:12px;'
      + 'font-family:Consolas,Menlo,monospace;word-break:break-all">' + esc(short) + '</td></tr>';
  }).join('');

  const reauthBlock = reauth.length ? (
    '<div style="margin:14px 20px 0;padding:12px 14px;background:#fff6e5;border:1px solid #f0d49a;border-radius:8px">'
    + '<div style="font-size:13px;font-weight:600;color:#8a5a00">需要你手动处理：登录态失效</div>'
    + reauth.map((r) => '<div style="margin-top:8px;font-size:12px;color:#5a4a2a">'
      + '<b>' + esc(r.Name) + '</b>（退出码 ' + esc(r.Exit) + '）—— ' + esc(r.Hint || '请重新登录')
      + (r.Command ? '<br><code style="display:inline-block;margin-top:4px;padding:4px 6px;background:#fff;'
        + 'border:1px solid #e6d6b0;border-radius:4px;font-family:Consolas,Menlo,monospace;font-size:11px">'
        + esc(r.Command) + '</code>' : '')
      + '</div>').join('')
    + '</div>'
  ) : '';

  const subject = (reauth.length
    ? '🔐 需要重新登录 · ' + reauth.map((r) => r.Name).join('、') + ' · ' + stamp
    : (overall ? '✅ 签到全部正常' : '⚠️ 签到有异常') + ' · ' + stamp + ' · ' + ok + '/' + jobs.length);

  const headerBg = reauth.length ? '#8a3a00' : (overall ? '#0d7a3f' : '#8a5a00');

  const html = '<!doctype html><html><body style="margin:0;padding:18px;background:#f7f7f8;'
    + 'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#222">'
    + '<div style="max-width:720px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;'
    + 'box-shadow:0 1px 3px rgba(0,0,0,.08)">'
    + '<div style="padding:16px 20px;background:' + headerBg + ';color:#fff">'
    + '<div style="font-size:16px;font-weight:600">'
    + (reauth.length ? '签到汇总 · 需要重新登录' : '每日签到汇总') + '</div>'
    + '<div style="font-size:12px;opacity:.85;margin-top:4px">' + esc(stamp) + ' · '
    + ok + '/' + jobs.length + ' 正常</div></div>'
    + reauthBlock
    + '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:14px">'
    + '<thead><tr style="background:#fafafa;color:#555;font-size:12px">'
    + '<th style="padding:8px 10px;text-align:left;border-bottom:1px solid #eee">服务</th>'
    + '<th style="padding:8px 10px;text-align:left;border-bottom:1px solid #eee">状态</th>'
    + '<th style="padding:8px 10px;text-align:right;border-bottom:1px solid #eee">退出码</th>'
    + '<th style="padding:8px 10px;text-align:right;border-bottom:1px solid #eee">耗时</th>'
    + '<th style="padding:8px 10px;text-align:left;border-bottom:1px solid #eee">剩余额度</th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table>'
    + '<div style="padding:12px 20px;color:#888;font-size:12px;border-top:1px solid #f0f0f0">'
    + '整体：' + esc(state.overall || '-') + ' · 由 checkin-all 自动发送'
    + (opts && opts.note ? '<br>' + esc(opts.note) : '')
    + '</div></div></body></html>';

  return { subject, html, stamp };
}

function buildMessage(cfg, subject, html) {
  const domain = String(cfg.from || cfg.user || 'localhost').split('@')[1] || 'localhost';
  const date = new Date().toUTCString().replace('GMT', '+0000');
  const body = Buffer.from(html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const fromName = cfg.fromName || 'checkin-all';
  return [
    'From: =?UTF-8?B?' + b64(fromName) + '?= <' + cfg.from + '>',
    'To: <' + cfg.to + '>',
    'Subject: ' + encSubject(subject),
    'Date: ' + date,
    'Message-ID: <' + Date.now() + '.' + Math.random().toString(36).slice(2) + '@' + domain + '>',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body
  ].join('\r\n');
}

// ---- main ------------------------------------------------------------------

async function probe(cfg) {
  // connect + EHLO + QUIT: proves TLS and the script's SMTP state machine work
  return new Promise((resolve, reject) => {
    const host = cfg.host || 'smtp.163.com';
    const port = cfg.port || 465;
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
    let buf = '';
    let waiter = null;
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, 20000);
    const lines = [];
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (waiter) {
        const i = buf.indexOf('\r\n');
        if (i >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); const w = waiter; waiter = null; w(l); }
      }
    });
    const readLine = () => new Promise((res) => {
      const i = buf.indexOf('\r\n');
      if (i >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); res(l); return; }
      waiter = res;
    });
    (async () => {
      lines.push(await readLine());                                  // 220
      sock.write('EHLO checkin-probe\r\n');
      for (;;) {
        const l = await readLine();
        lines.push(l);
        if (/^\d{3} /.test(l)) break;
      }
      sock.write('QUIT\r\n');
      await readLine().catch(() => {});
      clearTimeout(timer);
      sock.end();
      resolve(lines);
    })().catch((e) => { clearTimeout(timer); reject(e); });
  });
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const root = __dirname;
  const cfgFile = args.config || path.join(root, 'mail.json');
  const stateFile = args.state || path.join(root, 'last-run.json');

  if (args.probe) {
    const pc = Object.assign({ host: 'smtp.163.com', port: 465 }, readConfig(cfgFile) || {});
    const lines = await probe(pc);
    console.log(lines.join('\n'));
    process.exit(0);
  }

  let cfg = readConfig(cfgFile);
  if (args.dry) {
    // dry run only renders the message, so placeholder credentials are fine
    cfg = Object.assign({}, cfg || {});
    if (!cfg.user) cfg.user = 'preview@163.com';
    if (!cfg.pass) cfg.pass = 'x';
    if (!cfg.from) cfg.from = cfg.user;
    if (!cfg.to) cfg.to = 'preview@163.com';
  }
  if (!cfg || !cfg.user || !cfg.pass) {
    console.log('mail: skipped (no credentials in ' + cfgFile + ')');
    process.exit(3);
  }
  const mail = Object.assign({ host: 'smtp.163.com', port: 465, secure: true }, cfg);
  if (args.to) mail.to = args.to;
  if (!mail.from) mail.from = mail.user;

  if (!mail.to) {
    console.log('mail: skipped (no recipient)');
    process.exit(3);
  }

  let subject, html;
  if (args.test) {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    subject = '签到通知测试 · ' + stamp;
    html = '<p>这是一封来自 checkin-all 的测试邮件。</p><p>SMTP: ' + esc(mail.host) + ':' + esc(mail.port)
      + '<br>From: ' + esc(mail.from) + '<br>To: ' + esc(mail.to) + '</p>';
  } else {
    if (!fs.existsSync(stateFile)) {
      console.log('mail: skipped (no state file ' + stateFile + ')');
      process.exit(3);
    }
    const state = readJson(stateFile);
    const rep = buildReport(state, {});
    subject = rep.subject;
    html = rep.html;
  }

  if (args.dry) {
    console.log('dry run: subject=' + subject + ' html=' + html.length + ' bytes, target=' + mail.host + ':' + mail.port);
    console.log(html);
    process.exit(0);
  }

  try {
    await smtpSend(mail, buildMessage(mail, subject, html));
    console.log('mail: sent to ' + mail.to + ' via ' + mail.host + ':' + mail.port);
    process.exit(0);
  } catch (e) {
    console.log('mail: send failed - ' + e.message);
    process.exit(1);
  }
})().catch((e) => {
  console.log('mail: fatal - ' + e.message);
  process.exit(1);
});


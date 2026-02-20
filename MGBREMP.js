const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

// ================= DISCORD =================
const DISCORD_CONFIG = {
  webhookUrl: process.env.DISCORD_WEBHOOK_URL_MGBREMP,
  threadId: process.env.DISCORD_THREAD_ID_MGBREMP
};

// ================= URLS =================
const urls = [
'https://emprestimo.altarendabr.com/pt-br-recomendacao-de-emprestimos-4',
'https://emprestimo.sofinancas.com/p1-emprestimos-recomendados-r'];

// ================= TARGET GROUPS (REGRA: OU em TODOS os grupos) =================
const TARGET_GROUPS = {
  top: ['mob_top', 'desk_top'],
  rewarded: ['rewarded','offerwall'],
  interstitial: ['interstitial']
};

// ================= CONFIGS =================
const CONCURRENCY = 5;
const NAV_TIMEOUT_MS = 60000;
const GPT_READY_TIMEOUT_MS = 60000;
const FIND_TIMEOUT_MS = 45000;
const HOLD_TOP_MS = 9000;
const EVIDENCE_DIR = path.join(process.cwd(), 'evidences');

// ================= STATE =================
// errosPorDominio[dom] = [{ url, missingGroups, missingTargetsByGroup }]
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

// ================= EVIDÊNCIAS (screenshot + html + debug json) =================
async function capturarEvidencia(page, urlLimpa, debugState, extra = {}) {
  const slug = slugifyUrl(urlLimpa);
  const stamp = nowStamp();
  const base = path.join(EVIDENCE_DIR, `${stamp}__${slug}`);

  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
  } catch {}

  try {
    const html = await page.content().catch(() => '');
    if (html) fs.writeFileSync(`${base}.html`, html, 'utf-8');
  } catch {}

  try {
    const payload = {
      url: urlLimpa,
      ts: new Date().toISOString(),
      debugState,
      extra
    };
    fs.writeFileSync(`${base}.json`, JSON.stringify(payload, null, 2), 'utf-8');
  } catch {}
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

// ================= MOUSE "JITTER" =================
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

// ================= BUSCA POR GRUPOS (REGRA: OU em TODOS) =================
async function buscarTargetGroupsNaPagina(page, targetGroups, timeout = FIND_TIMEOUT_MS) {
  return await page.evaluate(async (targetGroups, timeout) => {
    const start = Date.now();
    const groups = targetGroups;

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

    // checa 1 target string (via GPT slots ou DOM)
    const checkOneTarget = (t) => {
      const tLower = String(t).toLowerCase();

      // GPT slots
      try {
        if (window.googletag && googletag.pubads) {
          const slots = googletag.pubads().getSlots();
          const hit = slots.find((s) => {
            const id = (s.getSlotElementId() || '').toLowerCase();
            const path = (s.getAdUnitPath() || '').toLowerCase();
            return id.includes(tLower) || path.includes(tLower);
          });
          if (hit) {
            return { found: true, tipo: 'GPT', detalhe: hit.getSlotElementId() || '(sem id)' };
          }
        }
      } catch {}

      // DOM
      const el = document.querySelector(`[id*="${t}"], [id*="${tLower}"]`);
      if (el) {
        if (el.getAttribute && el.getAttribute('data-google-query-id')) {
          return { found: true, tipo: 'DOM-CHECK', detalhe: `data-google-query-id (${t})` };
        }

        if (el.tagName === 'IFRAME' && isVisibleEnough(el)) {
          return { found: true, tipo: 'DOM-CHECK', detalhe: `IFRAME visível (${t})` };
        }

        if (hasAdInsideTargetEl(el)) {
          return { found: true, tipo: 'DOM-CHECK', detalhe: `Ad dentro do container (${t})` };
        }
      }

      return { found: false };
    };

    const computeStatus = () => {
      const perGroup = {};
      const missingGroups = [];
      const missingTargetsByGroup = {};

      for (const groupName of Object.keys(groups)) {
        const targets = groups[groupName] || [];
        const perTarget = {};

        for (const t of targets) {
          perTarget[t] = checkOneTarget(t);
        }

        // ✅ REGRA OU (ANY) para TODOS os grupos:
        // grupo passa se encontrar PELO MENOS UM target dentro dele
        const okGroup = targets.length ? targets.some((t) => perTarget[t]?.found) : false;

        perGroup[groupName] = { sucesso: okGroup, targets: perTarget };

        if (!okGroup) {
          missingGroups.push(groupName);
          missingTargetsByGroup[groupName] = targets.filter((t) => !perTarget[t]?.found);
        }
      }

      return { perGroup, missingGroups, missingTargetsByGroup };
    };

    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const status = computeStatus();

        if (status.missingGroups.length === 0) {
          clearInterval(timer);
          resolve({
            sucesso: true,
            tipo: 'GROUPS-OK',
            perGroup: status.perGroup
          });
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
            debugSlots,
            perGroup: status.perGroup,
            missingGroups: status.missingGroups,
            missingTargetsByGroup: status.missingTargetsByGroup
          });
        }
      }, 500);
    });
  }, targetGroups, timeout);
}

// ================= PROCESSA =================
async function processarUrl(url, browser) {
  let page;
  let mouseJitter;
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

    // INICIA jitter
    mouseJitter = await iniciarMouseJitter(page, 22000, 650);
    await page.mouse.move(500, 220, { steps: 10 }).catch(() => {});

    // segura no topo
    await new Promise((r) => setTimeout(r, HOLD_TOP_MS));

    // layout settle + reflow/resize
    await esperarLayoutEstavel(page, 15000, 1200);
    await forcarReflowResize(page);

    // espera GPT ready (sem travar)
    const gptReady = await esperarGptReady(page, GPT_READY_TIMEOUT_MS);

    // tentativa 1: topo
    let resultado = await buscarTargetGroupsNaPagina(page, TARGET_GROUPS, 25000);

    // se faltou algum grupo, scroll e tenta de novo
    if (!resultado.sucesso) {
      await scrollHumano(page);
      await esperarLayoutEstavel(page, 8000, 1000);

      await scrollAteSelector(
        page,
        '#mob_top, #desk_top, [id*="mob_top"], [id*="desk_top"], [id*="rewarded"], [id*="interstitial"]',
        10
      ).catch(() => {});

      await esperarLayoutEstavel(page, 8000, 1000);

      resultado = await buscarTargetGroupsNaPagina(page, TARGET_GROUPS, FIND_TIMEOUT_MS);
    }

    console.log(`\n📊 ${limpa}`);

    if (resultado.sucesso) {
      console.log(` 🟢 STATUS: OK (todos os grupos passaram na regra OU)`);
      try {
        mouseJitter?.stop();
      } catch {}
      return;
    }

    console.log(' 🔴 STATUS: FALHA');
    console.log(`    GPT Status: ${resultado.gptStatus || (gptReady.ok ? 'Ativo' : 'Inativo')}`);

    const faltando = resultado.missingGroups || ['(desconhecido)'];
    console.log(`    ❌ Grupos faltando: ${faltando.join(', ')}`);

    if (resultado.missingTargetsByGroup) {
      for (const g of Object.keys(resultado.missingTargetsByGroup)) {
        const missT = resultado.missingTargetsByGroup[g] || [];
        if (missT.length) console.log(`       - ${g}: faltando targets -> ${missT.join(', ')}`);
      }
    }

    if (resultado.debugSlots && resultado.debugSlots.length > 0) {
      console.log('    ⚠️ Slots carregados (debug):');
      resultado.debugSlots.slice(0, 25).forEach((s) => {
        console.log(`       - ID: ${s.id}`);
        console.log(`         Path: ${s.path}`);
      });
      if (resultado.debugSlots.length > 25) console.log(`       ... +${resultado.debugSlots.length - 25} slots`);
    } else {
      console.log('    ⚠️ Nenhum slot GPT listado (pode ser AdSense/AutoAds ou inicialização tardia).');
    }

    await capturarEvidencia(page, limpa, debugState, { resultado, gptReady });
    registrarErro(limpa, resultado.missingGroups || [], resultado.missingTargetsByGroup || {});
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
        await capturarEvidencia(page, limpa, debugState, { exception: true, error: String(e.message || e) });
      }
    } catch {}
    registrarErro(limpa, ['exception'], {});
  } finally {
    try {
      mouseJitter?.stop();
    } catch {}
    if (page) await page.close().catch(() => {});
  }
}

// ================= MAIN =================
(async () => {
  console.log('\n🚀 MONITOR V13 (GROUPS com regra OU em todos) [DISCORD]\n');

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
function registrarErro(url, missingGroups = [], missingTargetsByGroup = {}) {
  try {
    const dom = new URL(url).hostname;
    if (!errosPorDominio[dom]) errosPorDominio[dom] = [];
    errosPorDominio[dom].push({ url, missingGroups, missingTargetsByGroup });
  } catch {}
}

async function enviarDiscord() {
  let corpo = '🚨 FALHAS DE ANÚNCIO - MG EMP BR\n\n';

  // ordena domínios e URLs (por domínio)
  const dominios = Object.keys(errosPorDominio).sort((a, b) => a.localeCompare(b));

  for (const d of dominios) {
    const itens = (errosPorDominio[d] || [])
      .slice()
      .sort((a, b) => String(a.url).localeCompare(String(b.url)));

    for (const item of itens) {
      // nomes dos grupos que faltaram (é isso que você quer mostrar)
      const mgList = Array.isArray(item.missingGroups) ? item.missingGroups : [];
      const mg = mgList.length ? mgList.join(', ') : 'desconhecido';

      corpo += `${d}\n`;
      corpo += `${item.url}\n`;
      corpo += `faltando: ${mg}\n\n`;
    }
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
    const content = partes[i] + (partes.length > 1 ? `\n(${i + 1}/${partes.length})` : '');

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

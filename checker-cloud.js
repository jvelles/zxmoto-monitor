// checker-cloud.js v4
// Monitor Zxmoto 500RR
// Heartbeat fiable: guarda el timestamp del último aviso en state.json del repo.
// Si han pasado >2h desde el último heartbeat → lo manda, sin depender de qué cron disparó GitHub.

const TARGET_URL       = 'https://zxmoto.es/';
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GITHUB_TOKEN     = process.env.GITHUB_TOKEN;       // Automático en GitHub Actions
const GITHUB_REPO      = process.env.GITHUB_REPOSITORY; // Ej: jvelles/zxmoto-monitor

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 horas

// ─── Telegram ─────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) { console.log('Sin credenciales Telegram.'); return false; }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
  });
  const json = await res.json();
  if (json.ok) { console.log('Telegram OK'); return true; }
  console.error('Error Telegram:', json.description);
  return false;
}

// ─── Estado (state.json en el repo) ──────────────────────────────────────────
async function readState() {
  try {
    const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/state.json?t=${Date.now()}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { lastHeartbeat: 0 };
    return await res.json();
  } catch {
    return { lastHeartbeat: 0 };
  }
}

async function writeState(state) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) { console.log('Sin GITHUB_TOKEN para escribir estado.'); return; }
  try {
    // Obtener SHA actual del archivo (necesario para actualizarlo)
    const getMeta = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/state.json`, {
      headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'zxmoto' },
    });
    const meta = getMeta.ok ? await getMeta.json() : null;

    const body = {
      message: 'chore: update heartbeat state',
      content: Buffer.from(JSON.stringify(state, null, 2)).toString('base64'),
      ...(meta?.sha ? { sha: meta.sha } : {}),
    };

    const put = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/state.json`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept':        'application/vnd.github+json',
        'Content-Type':  'application/json',
        'User-Agent':    'zxmoto',
      },
      body: JSON.stringify(body),
    });
    const result = await put.json();
    if (put.ok) console.log('Estado guardado en repo (state.json)');
    else console.error('Error guardando estado:', result.message);
  } catch (e) {
    console.error('Error writeState:', e.message);
  }
}

// ─── Descarga y análisis de la web ────────────────────────────────────────────
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
      'Accept-Language': 'es-ES,es;q=0.9',
      'Accept':          'text/html,application/xhtml+xml',
      'Cache-Control':   'no-cache',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function extractMainText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function analyzeHTML(html, mainText) {
  const signals   = [];
  const closedKws = [];

  // 1. Formularios con campos de pago reales
  const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/gi)].map(m => m[0].toLowerCase());
  for (const form of forms) {
    if (form.includes('card') || form.includes('cvv') || form.includes('iban') ||
        form.includes('payment') || form.includes('tarjeta') || form.includes('pago')) {
      signals.push('Formulario de pago real en la pagina');
      break;
    }
  }

  // 2. Iframes de pasarela de pago
  const iframes = [...html.matchAll(/<iframe[^>]*>/gi)].map(m => m[0]);
  for (const iframe of iframes) {
    const src = (iframe.match(/src=["']([^"']*)/i)?.[1] || '').toLowerCase();
    if (src.includes('stripe') || src.includes('redsys') || src.includes('paypal') ||
        src.includes('checkout') || src.includes('payment')) {
      signals.push('Pasarela de pago embebida detectada');
      break;
    }
  }

  // 3. Texto de acción de reserva/compra en el cuerpo (nav ya eliminado)
  const reservaKws = [
    'reservar ahora', 'hacer reserva', 'realizar reserva', 'reservar ya',
    'comprar ahora', 'anadir al carrito', 'add to cart', 'pedir ahora',
    'solicitar reserva', 'preventa', 'pre-order', 'preorder',
  ];
  for (const kw of reservaKws) {
    if (mainText.includes(kw)) signals.push(`Texto de reserva: "${kw}"`);
  }

  // 4. Precios reales en euros (>500€)
  const priceMatches = mainText.match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?\s*€/g) || [];
  const realPrices = priceMatches.filter(p =>
    parseFloat(p.replace(/[€.,\s]/g, '').replace(',', '.')) > 500
  );
  if (realPrices.length > 0) signals.push(`Precios detectados: ${realPrices.slice(0, 3).join(', ')}`);

  // 5. Links a tienda/reserva
  const shopHrefKws = ['/reserv', '/comprar', '/tienda', '/shop', '/cart', '/checkout', '/pedido'];
  const linkMatches = [...html.matchAll(/href=["']([^"']*)/gi)].map(m => m[1].toLowerCase());
  for (const href of linkMatches) {
    if (shopHrefKws.some(kw => href.includes(kw))) { signals.push(`Link tienda: ${href}`); break; }
  }

  // 6. Indicadores de cierre
  const closedList = [
    'proximamente', 'coming soon', 'en breve', 'stay tuned',
    'pronto disponible', 'available soon', 'launching soon',
    'abriremos', 'mantente informado', 'registro de interes',
  ];
  for (const kw of closedList) { if (mainText.includes(kw)) closedKws.push(kw); }

  const isOpen     = signals.length >= 1 && closedKws.length === 0;
  const isPossible = signals.length >= 1 && closedKws.length > 0;
  return { isOpen, isPossible, signals, closedKws };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const now    = new Date();
  const nowStr = now.toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  console.log(`\nZxmoto 500RR Monitor v4 — ${nowStr}`);
  console.log(`Repo: ${GITHUB_REPO}`);

  // Leer estado guardado para saber cuándo fue el último heartbeat
  const state = await readState();
  const msSinceLastHB = now.getTime() - (state.lastHeartbeat || 0);
  const hSinceLastHB  = (msSinceLastHB / 3600000).toFixed(1);
  const needsHeartbeat = msSinceLastHB >= HEARTBEAT_INTERVAL_MS;

  console.log(`Ultimo heartbeat: hace ${hSinceLastHB}h → ${needsHeartbeat ? 'ENVIAR' : 'no necesario aun'}`);
  console.log(`Comprobando: ${TARGET_URL}\n`);

  // Descargar y analizar la web
  let html, mainText;
  try {
    html     = await fetchPage(TARGET_URL);
    mainText = extractMainText(html);
  } catch (err) {
    console.error(`Error descargando: ${err.message}`);
    if (needsHeartbeat) {
      await sendTelegram(
        `⚠️ <b>Zxmoto Monitor — Error de conexion</b>\n\n` +
        `No pude acceder a zxmoto.es\n` +
        `Error: ${err.message}\n\n` +
        `Sigo intentando. ⏰ ${nowStr}`
      );
      await writeState({ ...state, lastHeartbeat: now.getTime() });
    }
    process.exit(0);
  }

  const result = analyzeHTML(html, mainText);
  console.log(`Senales de apertura  : ${result.signals.length}`);
  console.log(`Indicadores de cierre: ${result.closedKws.length}`);
  if (result.signals.length  > 0) result.signals.forEach(s => console.log(`  + ${s}`));
  if (result.closedKws.length > 0) console.log(`  Cerrado: ${result.closedKws.join(', ')}`);

  if (result.isOpen) {
    // ─── ALERTA REAL ─────────────────────────────────────────────────────────
    console.log('\nSENALES DE APERTURA DETECTADAS\n');
    const signalList = result.signals.map(s => `• ${s}`).join('\n');
    await sendTelegram(
      `🏍️ <b>ZXMOTO 500RR — RESERVAS ABIERTAS!</b>\n\n` +
      `Senales detectadas:\n${signalList}\n\n` +
      `🔗 <a href="https://zxmoto.es/">VE A ZXMOTO.ES AHORA</a>\n\n` +
      `Detectado: ${nowStr}`
    );

  } else if (result.isPossible) {
    console.log('\nSenales mixtas');
    await sendTelegram(
      `⚠️ <b>Zxmoto 500RR — Cambio detectado (revisar)</b>\n\n` +
      `Senales: ${result.signals.join(', ')}\n` +
      `Pero sigue con: ${result.closedKws.join(', ')}\n\n` +
      `🔗 <a href="https://zxmoto.es/">zxmoto.es</a>\n\n${nowStr}`
    );

  } else {
    // Sin reservas — heartbeat si toca
    console.log('\nEstado: SIN RESERVAS todavia.');
    if (needsHeartbeat) {
      console.log('-> Enviando heartbeat (han pasado ' + hSinceLastHB + 'h)');
      const sent = await sendTelegram(
        `🏍️ <b>Zxmoto Monitor — Todo OK</b>\n\n` +
        `✅ Sigo vigilando zxmoto.es\n` +
        `📋 Estado: <b>Sin reservas todavia</b>\n` +
        `🔒 La web sigue en modo proximamente\n\n` +
        `Te aviso en cuanto haya algo 💪\n\n` +
        `⏰ ${nowStr}`
      );
      if (sent) {
        await writeState({ ...state, lastHeartbeat: now.getTime(), lastCheck: now.getTime() });
      }
    } else {
      console.log(`-> Proximo heartbeat en aprox. ${(2 - msSinceLastHB/3600000).toFixed(1)}h`);
    }
  }
}

main().catch(err => { console.error('Error fatal:', err); process.exit(1); });

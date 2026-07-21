// checker-cloud.js
// Monitor Zxmoto 500RR — con heartbeat cada 2h
// Sin dependencias externas, corre en GitHub Actions

const TARGET_URL      = 'https://zxmoto.es/';
const TELEGRAM_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const IS_HEARTBEAT    = process.env.HEARTBEAT === 'true';

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

  // 3. Texto de reserva en el cuerpo (nav ya eliminado)
  const reservaKws = [
    'reservar ahora', 'hacer reserva', 'realizar reserva', 'reservar ya',
    'comprar ahora', 'anadir al carrito', 'add to cart', 'pedir ahora',
    'solicitar reserva', 'preventa', 'pre-order', 'preorder',
  ];
  for (const kw of reservaKws) {
    if (mainText.includes(kw)) signals.push(`Texto de reserva: "${kw}"`);
  }

  // 4. Precios reales en euros (> 500 EUR)
  const priceMatches = mainText.match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?\s*€/g) || [];
  const realPrices = priceMatches.filter(p => parseFloat(p.replace(/[€.,\s]/g, '').replace(',', '.')) > 500);
  if (realPrices.length > 0) signals.push(`Precios detectados: ${realPrices.slice(0, 3).join(', ')}`);

  // 5. Links a tienda/reserva
  const shopHrefKws = ['/reserv', '/comprar', '/tienda', '/shop', '/cart', '/checkout', '/pedido'];
  const linkMatches = [...html.matchAll(/href=["']([^"']*)/gi)].map(m => m[1].toLowerCase());
  for (const href of linkMatches) {
    if (shopHrefKws.some(kw => href.includes(kw))) { signals.push(`Link tienda: ${href}`); break; }
  }

  // 6. Indicadores de cierre
  const closedList = [
    'proximamente', 'proximo', 'coming soon', 'en breve', 'stay tuned',
    'pronto disponible', 'available soon', 'launching soon', 'abriremos',
    'mantente informado', 'registro de interes',
  ];
  for (const kw of closedList) { if (mainText.includes(kw)) closedKws.push(kw); }

  const isOpen     = signals.length >= 1 && closedKws.length === 0;
  const isPossible = signals.length >= 1 && closedKws.length > 0;
  return { isOpen, isPossible, signals, closedKws };
}

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Sin credenciales Telegram.');
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
  });
  const json = await res.json();
  if (json.ok) console.log('Telegram enviado OK');
  else console.error('Error Telegram:', json.description);
}

async function main() {
  const now = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  console.log(`\nZxmoto 500RR Monitor — ${now}`);
  console.log(`Heartbeat: ${IS_HEARTBEAT}`);
  console.log(`Comprobando: ${TARGET_URL}\n`);

  let html, mainText;
  try {
    html     = await fetchPage(TARGET_URL);
    mainText = extractMainText(html);
  } catch (err) {
    console.error(`Error al descargar: ${err.message}`);
    if (IS_HEARTBEAT) {
      await sendTelegram(
        `⚠️ <b>Zxmoto Monitor — Error de conexion</b>\n\n` +
        `No se pudo acceder a zxmoto.es en el check de las ${now}\n` +
        `Error: ${err.message}\n\n` +
        `Se seguira intentando cada 15 minutos.`
      );
    }
    process.exit(0);
  }

  const result = analyzeHTML(html, mainText);
  console.log(`Senales de apertura: ${result.signals.length}`);
  console.log(`Indicadores de cierre: ${result.closedKws.length}`);
  if (result.signals.length > 0) result.signals.forEach(s => console.log(`  + ${s}`));
  if (result.closedKws.length > 0) console.log(`  Cierre: ${result.closedKws.join(', ')}`);

  if (result.isOpen) {
    // ─── ALERTA REAL ─────────────────────────────────────────────────────────
    console.log('\nSENALES DE APERTURA DETECTADAS\n');
    const signalList = result.signals.map(s => `• ${s}`).join('\n');
    await sendTelegram(
      `🏍️ <b>ZXMOTO 500RR — ¡RESERVAS POSIBLEMENTE ABIERTAS!</b>\n\n` +
      `Senales detectadas:\n${signalList}\n\n` +
      `🔗 <a href="https://zxmoto.es/">👉 VE A ZXMOTO.ES AHORA</a>\n\n` +
      `⏰ ${now}`
    );
  } else if (result.isPossible) {
    console.log('\nSenales mixtas — revision manual recomendada');
    await sendTelegram(
      `⚠️ <b>Zxmoto 500RR — Cambio detectado (revisar)</b>\n\n` +
      `Senales: ${result.signals.join(', ')}\n` +
      `Pero sigue indicando: ${result.closedKws.join(', ')}\n\n` +
      `🔗 <a href="https://zxmoto.es/">zxmoto.es</a>\n\n` +
      `⏰ ${now}`
    );
  } else {
    // Sin reservas — solo enviar Telegram si es el heartbeat de cada 2h
    console.log('\nEstado: SIN RESERVAS todavia.');
    if (IS_HEARTBEAT) {
      await sendTelegram(
        `🏍️ <b>Zxmoto Monitor — Todo OK</b>\n\n` +
        `✅ Sigo vigilando zxmoto.es cada 15 minutos.\n` +
        `📋 Estado actual: <b>Sin reservas todavia</b>\n` +
        `🔒 La web sigue en modo "proximamente"\n\n` +
        `Te avisare en cuanto haya algo. Sigue esperando 💪\n\n` +
        `⏰ Ultimo check: ${now}`
      );
    }
  }
}

main().catch(err => { console.error('Error fatal:', err); process.exit(1); });

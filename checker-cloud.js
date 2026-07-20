// checker-cloud.js
// Monitor Zxmoto 500RR — versión cloud (sin dependencias externas)
// Diseñado para correr en GitHub Actions cada 15 minutos, gratis y sin PC

const TARGET_URL = 'https://zxmoto.es/';
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─── Descarga la página ───────────────────────────────────────────────────────
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

// ─── Extrae el texto del cuerpo (ignora nav/header/footer/scripts) ────────────
function extractMainText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')       // quitar scripts
    .replace(/<style[\s\S]*?<\/style>/gi, '')          // quitar estilos
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')              // quitar nav (tiene "500RR" siempre)
    .replace(/<header[\s\S]*?<\/header>/gi, '')        // quitar header
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')        // quitar footer
    .replace(/<[^>]+>/g, ' ')                          // quitar resto de tags HTML
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// ─── Motor de detección — solo señales estructurales reales ──────────────────
function analyzeHTML(html, mainText) {
  const signals    = [];   // señales de apertura
  const closedKws  = [];   // indicadores de que sigue cerrado

  // 1. ¿Hay formularios con campos de pago REALES? (no scripts externos)
  const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/gi)].map(m => m[0].toLowerCase());
  for (const form of forms) {
    if (form.includes('card') || form.includes('cvv') || form.includes('iban') ||
        form.includes('payment') || form.includes('tarjeta') || form.includes('pago')) {
      signals.push('Formulario de pago real en la página');
      break;
    }
  }

  // 2. ¿Hay iframes de pasarela de pago embebidos?
  const iframes = [...html.matchAll(/<iframe[^>]*>/gi)].map(m => m[0]);
  for (const iframe of iframes) {
    const src = (iframe.match(/src=["']([^"']*)/i)?.[1] || '').toLowerCase();
    if (src.includes('stripe') || src.includes('redsys') || src.includes('paypal') ||
        src.includes('checkout') || src.includes('payment')) {
      signals.push(`Pasarela de pago embebida detectada`);
      break;
    }
  }

  // 3. ¿Botones de reserva/compra en el CUERPO de la página (no en el nav)?
  //    El nav ya se eliminó del mainText, así que si aparece aquí es real.
  const reservaKws = ['reservar ahora', 'hacer reserva', 'realizar reserva', 'reservar ya',
                      'comprar ahora', 'añadir al carrito', 'add to cart', 'pedir ahora',
                      'solicitar reserva', 'preventa', 'pre-order', 'preorder'];
  for (const kw of reservaKws) {
    if (mainText.includes(kw)) {
      signals.push(`Texto de acción de reserva: "${kw}"`);
    }
  }

  // 4. ¿Aparecen precios reales en euros? (números > 500€)
  const priceMatches = mainText.match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?\s*€/g) || [];
  const realPrices = priceMatches.filter(p => {
    const num = parseFloat(p.replace(/[€.,\s]/g, '').replace(',', '.'));
    return num > 500;
  });
  if (realPrices.length > 0) {
    signals.push(`Precios en euros: ${realPrices.slice(0, 3).join(', ')}`);
  }

  // 5. ¿Links a páginas de tienda/reserva nuevas?
  const shopHrefKws = ['/reserv', '/comprar', '/tienda', '/shop', '/cart', '/checkout', '/pedido'];
  const linkMatches = [...html.matchAll(/href=["']([^"']*)/gi)].map(m => m[1].toLowerCase());
  for (const href of linkMatches) {
    if (shopHrefKws.some(kw => href.includes(kw))) {
      signals.push(`Enlace a tienda/reserva: ${href}`);
      break;
    }
  }

  // 6. Indicadores de que SIGUE cerrado (texto del body sin nav)
  const closedList = [
    'próximamente', 'proximamente', 'coming soon', 'en breve',
    'stay tuned', 'pronto disponible', 'available soon', 'launching soon',
    'abriremos', 'mantente informado', 'recibe información', 'avísame cuando',
    'registro de interés',
  ];
  for (const kw of closedList) {
    if (mainText.includes(kw)) closedKws.push(kw);
  }

  // ─── Decisión final ───
  // Solo "open" si hay señales estructurales reales Y no hay indicadores de cierre
  const isOpen     = signals.length >= 1 && closedKws.length === 0;
  // "possible" si hay señales pero también indicadores de cierre (raro, pero por si acaso)
  const isPossible = signals.length >= 1 && closedKws.length > 0;

  return { isOpen, isPossible, signals, closedKws };
}

// ─── Envía mensaje por Telegram ────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('⚠️  Variables TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID no configuradas.');
    return false;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    }),
  });
  const json = await res.json();
  if (json.ok) {
    console.log('✅ Mensaje de Telegram enviado correctamente');
    return true;
  } else {
    console.error('❌ Error Telegram:', json.description);
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const now = new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' });
  console.log(`\n🏍️  Zxmoto 500RR Monitor — ${now}`);
  console.log(`🔍 Comprobando: ${TARGET_URL}\n`);

  let html, mainText;

  try {
    html     = await fetchPage(TARGET_URL);
    mainText = extractMainText(html);
  } catch (err) {
    console.error(`❌ Error al descargar la página: ${err.message}`);
    // No enviamos Telegram en cada error de red para no hacer spam
    // Si falla más de X veces seguidas sería buena idea avisar, pero lo dejamos simple
    process.exit(0);
  }

  const result = analyzeHTML(html, mainText);

  console.log(`   Señales de apertura encontradas : ${result.signals.length}`);
  console.log(`   Indicadores de cierre encontrados: ${result.closedKws.length}`);

  if (result.signals.length > 0) {
    console.log(`\n📌 Señales:`);
    result.signals.forEach(s => console.log(`     • ${s}`));
  }
  if (result.closedKws.length > 0) {
    console.log(`🔒 Indica cerrado: ${result.closedKws.join(', ')}`);
  }

  if (result.isOpen) {
    // ─── ¡ALERTA REAL! ───────────────────────────────────────────────────────
    console.log('\n🚨🚨🚨 ¡SEÑALES DE APERTURA DETECTADAS! 🚨🚨🚨\n');

    const signalList = result.signals.map(s => `• ${s}`).join('\n');
    const message =
      `🏍️ <b>ZXMOTO 500RR — ¡RESERVAS POSIBLEMENTE ABIERTAS!</b>\n\n` +
      `Se han detectado señales reales de reserva en la web:\n` +
      `${signalList}\n\n` +
      `🔗 <a href="https://zxmoto.es/">👉 VE A ZXMOTO.ES AHORA</a>\n\n` +
      `⏰ Detectado: ${now}`;

    await sendTelegram(message);

  } else if (result.isPossible) {
    // Hay señales pero también indicadores de cierre → aviso suave
    console.log('\n⚠️  Señales mixtas detectadas (posible cambio parcial)');

    const message =
      `⚠️ <b>Zxmoto 500RR — Cambio detectado (revisar manualmente)</b>\n\n` +
      `Señales: ${result.signals.join(', ')}\n` +
      `Pero también detecté: ${result.closedKws.join(', ')}\n\n` +
      `Puede ser un falso positivo. Revisa por si acaso:\n` +
      `🔗 <a href="https://zxmoto.es/">zxmoto.es</a>\n\n` +
      `⏰ ${now}`;

    await sendTelegram(message);

  } else {
    // Todo normal, sin reservas
    console.log('\n   ✅ Estado: SIN RESERVAS todavía. Normal, sigue esperando 🏍️');
  }
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});

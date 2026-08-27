// =====================================================================
// ANA SUNUCU
// WhatsApp'tan gelen mesajları karşılar, işler, kaydeder.
//
// Akış:
//   Meta → POST /webhook/whatsapp → imza doğrula → 200 dön (HEMEN)
//        → arka planda: KVKK kontrolü → yapay zeka → mükerrer → kayıt
// =====================================================================

import 'dotenv/config';
import Fastify from 'fastify';
import crypto from 'node:crypto';
import { mesajIsle } from './konusma.js';
import { db } from './db.js';
import { analizUclariniBagla } from './analiz.js';

const app = Fastify({
  logger: { level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' },
  // Meta imzasını doğrulamak için ham gövdeye ihtiyacımız var
  bodyLimit: 5 * 1024 * 1024,
});

// Ham gövdeyi sakla (imza doğrulaması için)
app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
  req.rawBody = body;
  try { done(null, JSON.parse(body.toString('utf8'))); }
  catch (e) { done(e, undefined); }
});

// ---------------------------------------------------------------------
// 1. Webhook doğrulama (Meta ilk kurulumda bir kez çağırır)
// ---------------------------------------------------------------------
app.get('/webhook/whatsapp', async (req, reply) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    app.log.info('Webhook doğrulandı');
    return reply.code(200).send(challenge);
  }
  return reply.code(403).send('Doğrulama başarısız');
});

// ---------------------------------------------------------------------
// 2. Gelen mesaj
// ---------------------------------------------------------------------
app.post('/webhook/whatsapp', async (req, reply) => {
  // İmza doğrula — bu olmadan herkes sahte şikayet gönderebilir
  if (!imzaGecerli(req)) {
    app.log.warn('Geçersiz imza — istek reddedildi');
    return reply.code(401).send();
  }

  // Meta 20 saniyede yanıt bekler; alamazsa aynı mesajı tekrar tekrar
  // gönderir. Bu yüzden ÖNCE 200 dönüp işi arka planda yapıyoruz.
  reply.code(200).send();

  try {
    const girisler = req.body?.entry ?? [];
    for (const giris of girisler) {
      for (const degisim of giris.changes ?? []) {
        const veri = degisim.value;

        // Durum güncellemeleri (iletildi/okundu) — şimdilik yok say
        if (!veri?.messages) continue;

        for (const mesaj of veri.messages) {
          // Aynı mesajın iki kez işlenmesini engelle
          const varMi = await db.mesajVarMi(mesaj.id);
          if (varMi) continue;

          await mesajIsle({
            kanal: 'whatsapp',
            waMesajId: mesaj.id,
            telefon: '+' + mesaj.from,
            hedefId: '+' + mesaj.from,
            ad: veri.contacts?.[0]?.profile?.name ?? null,
            tip: mesaj.type,                       // text | audio | image | location | interactive
            metin: mesaj.text?.body
                 ?? mesaj.interactive?.button_reply?.title
                 ?? mesaj.interactive?.list_reply?.title
                 ?? null,
            medyaId: mesaj.image?.id ?? mesaj.audio?.id ?? mesaj.document?.id ?? null,
            konum: mesaj.location
              ? { lat: mesaj.location.latitude, lng: mesaj.location.longitude }
              : null,
            zaman: new Date(Number(mesaj.timestamp) * 1000),
          });
        }
      }
    }
  } catch (err) {
    // Hata olsa bile Meta'ya 200 döndük; hatayı logla ve izleme sistemine gönder
    app.log.error({ err }, 'Mesaj işlenirken hata');
  }
});

function imzaGecerli(req) {
  const imza = req.headers['x-hub-signature-256'];
  if (!imza || !req.rawBody) return false;
  const beklenen = 'sha256=' + crypto
    .createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
    .update(req.rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(imza), Buffer.from(beklenen));
  } catch { return false; }
}

// ---------------------------------------------------------------------
// 2b. Telegram — demo/test kanalı
//     Meta'nın kurumsal onayını beklemeden aynı yapay zeka + veritabanı
//     + panel zincirini denemek için. WhatsApp onayı geldiğinde bu
//     route'u kapatmanıza gerek yok — ikisi aynı anda da çalışabilir,
//     birbirini etkilemez (mesajIsle her ikisini de aynı şekilde işler).
//
//     Telegram'ın kendi "webhook doğrulama" adımı yok (Meta'daki gibi
//     bir GET isteği gelmiyor); bunun yerine isteğe bağlı bir "gizli
//     anahtar" başlığıyla korunur — TELEGRAM_WEBHOOK_SECRET doluysa.
// ---------------------------------------------------------------------
app.post('/webhook/telegram', async (req, reply) => {
  if (process.env.TELEGRAM_WEBHOOK_SECRET &&
      req.headers['x-telegram-bot-api-secret-token'] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    app.log.warn('Telegram: geçersiz gizli anahtar — istek reddedildi');
    return reply.code(401).send();
  }

  // Telegram da hızlı yanıt bekler; WhatsApp'taki gibi önce 200 dönüyoruz.
  reply.code(200).send();

  try {
    const msg = req.body?.message;
    if (!msg) return; // edited_message, callback_query vb. şimdilik yok sayılıyor

    // Aynı mesajın iki kez işlenmesini engelle (WhatsApp'taki wa_mesaj_id ile aynı mantık)
    const mesajKimligi = 'tg-' + msg.message_id + '-' + msg.chat.id;
    const varMi = await db.mesajVarMi(mesajKimligi);
    if (varMi) return;

    const foto = msg.photo?.[msg.photo.length - 1]; // Telegram en büyük çözünürlüğü son sıraya koyar

    await mesajIsle({
      kanal: 'telegram',
      waMesajId: mesajKimligi,
      // Telegram'da telefon numarası yok — chat id'yi benzersiz kimlik olarak kullanıyoruz.
      telefon: 'tg:' + msg.chat.id,
      hedefId: msg.chat.id,
      ad: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ')
          || msg.from?.username || null,
      tip: msg.voice ? 'audio' : foto ? 'image' : msg.location ? 'location' : 'text',
      metin: msg.text ?? msg.caption ?? null,
      medyaId: msg.voice?.file_id ?? foto?.file_id ?? null,
      konum: msg.location
        ? { lat: msg.location.latitude, lng: msg.location.longitude }
        : null,
      zaman: new Date(msg.date * 1000),
    });
  } catch (err) {
    app.log.error({ err }, 'Telegram mesajı işlenirken hata');
  }
});

// ---------------------------------------------------------------------
// 3. Analiz uçları  (/analiz/yorum, /analiz/metrikler, /analiz/haftalik-rapor)
//    Panelin "yapay zeka yorumu" düğmesi buraya bağlanır.
// ---------------------------------------------------------------------
analizUclariniBagla(app);

// CORS — paneli başka bir adreste barındırıyorsan gerekli
app.addHook('onRequest', async (req, reply) => {
  const izin = process.env.PANEL_KOKEN ?? '*';
  reply.header('Access-Control-Allow-Origin', izin);
  reply.header('Access-Control-Allow-Headers', 'Content-Type, x-panel-anahtari');
  reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return reply.code(204).send();
});

// ---------------------------------------------------------------------
// 4. Sağlık kontrolü ve zamanlanmış işler
// ---------------------------------------------------------------------
app.get('/saglik', async () => ({ durum: 'calisiyor', zaman: new Date().toISOString() }));

// SLA uyarıları, otomatik kapanma, hatırlatmalar — cron ile tetiklenir
app.post('/gorevler/gunluk', async (req, reply) => {
  if (req.headers['x-gorev-anahtari'] !== process.env.GOREV_ANAHTARI) {
    return reply.code(401).send();
  }
  const { gunlukGorevler } = await import('./gorevler.js');
  const sonuc = await gunlukGorevler();
  return sonuc;
});

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`Sunucu ${port} portunda`))
  .catch((err) => { app.log.error(err); process.exit(1); });

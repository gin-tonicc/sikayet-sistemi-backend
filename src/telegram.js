// =====================================================================
// TELEGRAM BOT — DEMO / TEST KANALI
// Telegram'ın kendi Bot API'si. Meta'nın aksine kurumsal onay,
// belge, bekleme yok — bir bot birkaç dakikada oluşturulur.
//
// Bu dosya whatsapp.js ile AYNI ŞEKİLDE çalışır (aynı iki fonksiyon:
// mesajGonder, medyaIndir) — konusma.js hangi kanaldan geldiğine göre
// ikisi arasında geçiş yapar, kendi mantığı hiç değişmez.
//
// Üretime WhatsApp onayı geldiğinde bu dosyayı SİLMENİZE gerek yok;
// iki kanal aynı anda da çalışabilir (demo + gerçek trafik bir arada).
// =====================================================================

const API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

export async function mesajGonder(chatId, metin) {
  const r = await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: metin }),
  });
  if (!r.ok) throw new Error('Telegram mesajı gönderilemedi: ' + await r.text());
  return r.json();
}

/**
 * Telegram dosyaları iki adımda iner: önce file_id'den bir "file_path"
 * alınır, sonra o path'ten gerçek dosya indirilir. WhatsApp'ın tek
 * adımlı medya indirmesinden farkı bu — geri kalan davranış aynı.
 */
export async function medyaIndir(fileId) {
  const meta = await fetch(`${API}/getFile?file_id=${fileId}`).then(r => r.json());
  if (!meta.ok) throw new Error('Telegram dosya bilgisi alınamadı: ' + JSON.stringify(meta));

  const yol = meta.result.file_path;
  const dosya = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${yol}`);
  const buffer = Buffer.from(await dosya.arrayBuffer());

  const mime = yol.endsWith('.oga') ? 'audio/ogg'
    : yol.endsWith('.jpg') || yol.endsWith('.jpeg') ? 'image/jpeg'
    : yol.endsWith('.png') ? 'image/png'
    : 'application/octet-stream';

  return { buffer, mime };
}

/**
 * Webhook'u Telegram'a kaydeder — kurulumda BİR KEZ çalıştırılır.
 * Elle bir kere tarayıcıdan çağırmak da yeterlidir (bkz. kılavuz);
 * bu fonksiyon aynı işi kod içinden yapmak isteyenler için.
 */
export async function webhookKaydet(url, secret) {
  const r = await fetch(`${API}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, secret_token: secret }),
  });
  return r.json();
}

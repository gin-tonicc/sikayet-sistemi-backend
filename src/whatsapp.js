// =====================================================================
// WHATSAPP MESAJ GÖNDERME
// Meta Cloud API. Vatandaş 24 saat içinde yazdıysa serbest metin gönderilir
// (ücretsiz). 24 saat geçtiyse ONAYLI ŞABLON kullanmak zorunludur (ücretli).
// =====================================================================

const API = 'https://graph.facebook.com/v20.0';

export async function mesajGonder(telefon, metin) {
  const r = await fetch(`${API}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefon.replace('+', ''),
      type: 'text',
      text: { body: metin, preview_url: false },
    }),
  });
  if (!r.ok) throw new Error('WhatsApp gönderilemedi: ' + await r.text());
  return r.json();
}

/**
 * 24 saatlik pencere kapandıysa (ör. "şikayetiniz çözüldü" bildirimi
 * ertesi gün gidiyorsa) onaylı şablon kullanılır.
 * Şablonlar Meta Business > WhatsApp Manager > Message Templates'ten
 * önceden oluşturulup ONAYLATILIR. Kategori: UTILITY.
 */
export async function sablonGonder(telefon, sablonAdi, degiskenler = [], dil = 'tr') {
  const r = await fetch(`${API}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefon.replace('+', ''),
      type: 'template',
      template: {
        name: sablonAdi,
        language: { code: dil },
        components: degiskenler.length ? [{
          type: 'body',
          parameters: degiskenler.map(d => ({ type: 'text', text: String(d) })),
        }] : [],
      },
    }),
  });
  if (!r.ok) throw new Error('Şablon gönderilemedi: ' + await r.text());
  return r.json();
}

/** Butonlu mesaj — memnuniyet sorusu için */
export async function butonluGonder(telefon, metin, butonlar) {
  const r = await fetch(`${API}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefon.replace('+', ''),
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: metin },
        action: {
          buttons: butonlar.map((b, i) => ({
            type: 'reply', reply: { id: b.id ?? `btn_${i}`, title: b.baslik },
          })),
        },
      },
    }),
  });
  if (!r.ok) throw new Error('Butonlu mesaj gönderilemedi: ' + await r.text());
  return r.json();
}

export async function medyaIndir(medyaId) {
  const meta = await fetch(`${API}/${medyaId}`, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
  }).then(r => r.json());

  const dosya = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
  });
  const buffer = Buffer.from(await dosya.arrayBuffer());
  return { buffer, mime: meta.mime_type };
}

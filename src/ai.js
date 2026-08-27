// =====================================================================
// YAPAY ZEKA KATMANI
// Claude'a vatandaşın mesajını + kategori listesini verir, yapılandırılmış
// JSON alır. Kategori listesi veritabanından geldiği için, panelden
// kategori eklendiğinde bu dosyayı DEĞİŞTİRMEK GEREKMEZ.
// =====================================================================

import Anthropic from '@anthropic-ai/sdk';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Vatandaşın mesajını analiz eder.
 * @param {object} p
 * @param {Array}  p.gecmis      - önceki mesajlar [{rol, metin}]
 * @param {string} p.mesaj       - güncel mesaj
 * @param {Array}  p.kategoriler - DB'den gelen aktif kategoriler
 * @param {Array}  p.mahalleler  - DB'den gelen mahalle listesi
 */
export async function analizEt({ gecmis, mesaj, kategoriler, mahalleler }) {
  const kategoriListesi = kategoriler.map(k =>
    `- ${k.kod}: ${k.ad}${k.aciklama ? ' — ' + k.aciklama : ''}` +
    (k.yetki_disi ? ` [YETKİ DIŞI: ${k.sorumlu_kurum}]` : '')
  ).join('\n');

  const mahalleListesi = mahalleler.map(m => m.ad).join(', ');

  const sistemTalimati = `Sen bir ilçe belediyesinin Beyaz Masa görevlisisin. Vatandaşlarla WhatsApp üzerinden konuşuyorsun.

GÖREVİN
Vatandaşın mesajını anlamak, eksik bilgiyi kibarca sormak ve doğru kategoriye yerleştirmek.

KATEGORİLER
${kategoriListesi}

MAHALLELER
${mahalleListesi}

KURALLAR
1. ACİL DURUM ÖNCELİKLİ: Can veya mal güvenliği tehlikesi (gaz kokusu, çökme, yangın, yaralı insan/hayvan, elektrik teması) varsa "acil": true yap ve vatandaşa DERHAL 112 / 110 / 187'yi aramasını söyle. Sıraya alma, oyalama.
2. Her mesaj şikayet değildir. Tipi doğru belirle: sikayet / talep / oneri / bilgi / tesekkur / ilgisiz.
3. Bir kayıt açmak için EN AZ şunlar gerekir: ne olduğu + nerede olduğu (mahalle ve sokak/bina). Eksikse sor.
4. En fazla 3 soru sor. Vatandaşı yorma. Mümkünse tek soruda birden fazla bilgi iste.
5. Kategoriden emin değilsen tahmin etme; "guven" değerini düşük ver. Yanlış birime düşen şikayet kaybolur.
6. Yetki dışı kategorilerde vatandaşa hangi kuruma başvuracağını net söyle. "Bizi ilgilendirmiyor" deme; yönlendir.
7. Vatandaş hangi dilde yazdıysa o dilde cevap ver, ama "ozet" alanını her zaman Türkçe yaz.
8. Kısa, sade, saygılı ol. Resmî ama soğuk değil. "Sayın vatandaşımız" gibi şişirme kalıplar kullanma.
9. Hakaret veya küfür varsa sakin kal, şikayeti yine de işle, "moderasyon": true işaretle.
10. Söz verme. "Yarın çözülecek" deme. "İlgili müdürlüğe iletiyorum" de.

ÇIKTI
Yalnızca aşağıdaki JSON'u döndür. Açıklama, markdown, kod bloğu ekleme.

{
  "tip": "sikayet|talep|oneri|bilgi|tesekkur|ilgisiz",
  "acil": false,
  "moderasyon": false,
  "yeterli_bilgi": true,
  "eksik_alanlar": [],
  "vatandasa_mesaj": "Vatandaşa gönderilecek metin",
  "kategori_kodu": "KATEGORI_KODU veya null",
  "guven": 0.0,
  "gerekce": "Bu kategoriyi neden seçtin, tek cümle",
  "mahalle": "Mahalle adı veya null",
  "adres": "Sokak/bina detayı veya null",
  "baslik": "En fazla 8 kelime",
  "ozet": "Panelde görünecek 1-2 cümlelik özet (Türkçe)",
  "oncelik": "dusuk|normal|yuksek|kritik"
}`;

  const mesajlar = [
    ...gecmis.map(g => ({
      role: g.rol === 'vatandas' ? 'user' : 'assistant',
      content: g.metin,
    })),
    { role: 'user', content: mesaj },
  ];

  const yanit = await claude.messages.create({
    model: process.env.MODEL_SOHBET ?? 'claude-sonnet-5',
    max_tokens: 1000,
    system: [
      // Kategori listesi her istekte tekrarlanıyor → önbelleğe al, maliyet düşsün
      { type: 'text', text: sistemTalimati, cache_control: { type: 'ephemeral' } },
    ],
    messages: mesajlar,
  });

  const ham = yanit.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return jsonAyikla(ham);
}

/**
 * Sesli mesajı metne çevirir (konuşma tanıma servisi).
 * Whisper, Google STT veya Azure Speech kullanılabilir.
 */
export async function sesiMetneCevir(sesBuffer, mimeType) {
  // Örnek: OpenAI Whisper API
  const form = new FormData();
  form.append('file', new Blob([sesBuffer], { type: mimeType }), 'ses.ogg');
  form.append('model', 'whisper-1');
  form.append('language', 'tr');

  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!r.ok) throw new Error('Ses çevrilemedi: ' + await r.text());
  const j = await r.json();
  return j.text;
}

/**
 * İki şikayetin aynı sorunu anlatıp anlatmadığını kontrol eder.
 * Önce veritabanı metin benzerliğiyle aday bulunur, sonra burada teyit edilir.
 */
export async function mukerrerMi(yeniOzet, adaylar) {
  if (!adaylar.length) return null;

  const yanit = await claude.messages.create({
    model: process.env.MODEL_SINIFLANDIRMA ?? 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system: `Belediye şikayetlerinde mükerrer tespiti yapıyorsun.
Yeni bildirim, mevcut bildirimlerden biriyle AYNI FİZİKSEL SORUNU mu anlatıyor?
Aynı sokakta farklı iki çukur AYNI DEĞİLDİR. Aynı konteynerin iki kez bildirilmesi AYNIDIR.
Emin değilsen aynı deme — yanlış birleştirme, ayrı kayıttan daha zararlıdır.
Sadece JSON döndür: {"ayni_mi": true|false, "takip_no": "..." veya null, "gerekce": "tek cümle"}`,
    messages: [{
      role: 'user',
      content: `YENİ: ${yeniOzet}\n\nMEVCUT:\n${adaylar.map(a => `${a.takip_no}: ${a.ozet}`).join('\n')}`,
    }],
  });

  const ham = yanit.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const j = jsonAyikla(ham);
  return j?.ayni_mi ? j.takip_no : null;
}

function jsonAyikla(metin) {
  const temiz = metin.replace(/```json/g, '').replace(/```/g, '').trim();
  try { return JSON.parse(temiz); }
  catch {
    // Model bazen metnin içine JSON gömer — ilk { ile son } arasını dene
    const a = temiz.indexOf('{'), b = temiz.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try { return JSON.parse(temiz.slice(a, b + 1)); } catch { /* düş */ }
    }
    return null;
  }
}

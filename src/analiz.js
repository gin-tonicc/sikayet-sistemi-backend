// =====================================================================
// ANALİZ UCU
// Panelin "yapay zeka yorumu" düğmesi buraya bağlanır.
//
// NEDEN SUNUCU ÜZERİNDEN: API anahtarı tarayıcıya konursa herkes görür
// ve fatura sana gelir. Anahtar burada, sunucuda kalır.
//
// AKIŞ
//   1. Sayıları analiz-motoru.js hesaplar (matematik, model değil)
//   2. Sadece hesaplanmış özet modele gönderilir (ham şikayet metni GİTMEZ)
//   3. Model sayı üretmez; hesaplanmış sayıyı Türkçe yorumlar
// =====================================================================

import Anthropic from '@anthropic-ai/sdk';
import { db } from './db.js';
import {
  normalizeEt, analizEt, yzOzetiHazirla, YZ_SISTEM_TALIMATI,
} from './analiz-motoru.js';

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/** Panelden gelen hazır özeti yorumlar */
export async function yorumUret(ozet) {
  if (!ozet) throw new Error('Özet boş');

  const yanit = await claude.messages.create({
    model: process.env.MODEL_ANALIZ ?? 'claude-sonnet-5',
    max_tokens: 1500,
    system: YZ_SISTEM_TALIMATI,
    messages: [{
      role: 'user',
      content: 'Hesaplanmış metrikler:\n' + JSON.stringify(ozet, null, 1) +
               '\n\nBu metrikleri yorumla.',
    }],
  });

  return yanit.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

/** Veritabanındaki canlı kayıtları, motorun beklediği CSV kolon adlarıyla düzeltir.
    Hem /analiz/metrikler hem de /veri/csv bu satırları kullanır — tek kaynak. */
async function canliSatirlar(gun = 365) {
  const kayitlar = await db.analizIcinKayitlar(gun);
  return kayitlar.map(k => ({
    'Başvuru Tarihi': k.olusturma,
    'Kapanış Tarihi': k.kapanma ?? '',
    // Tek ilçeli belediyede "ilçe" sabittir; İBB gibi çok ilçeli veride
    // bu alan verinin kendisinden gelir.
    'İlçe': process.env.BELEDIYE_ILCE ?? 'Belirtilmemiş',
    'Mahalle': k.mahalle ?? 'Belirtilmemiş',
    'Başvuru Konusu': k.kategori ?? 'Belirtilmemiş',
    'İlgili Müdürlük': k.birim ?? 'Belirtilmemiş',
    'Durum': k.durum,
    'Açıklama': k.ozet ?? '',
  }));
}

/** Bir hücreyi ; ile ayrılan CSV'ye güvenli şekilde yazar */
function csvHucre(deger) {
  const s = String(deger ?? '');
  return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function satirlarCsvYap(satirlar) {
  if (!satirlar.length) return '';
  const basliklar = Object.keys(satirlar[0]);
  const govde = satirlar.map(s => basliklar.map(b => csvHucre(s[b])).join(';'));
  return '\uFEFF' + [basliklar.join(';'), ...govde].join('\n');
}

/** Veritabanındaki canlı kayıtları motorun formatına çevirir */
export async function canliAnaliz({ gun = 365 } = {}) {
  const norm = normalizeEt(await canliSatirlar(gun));
  return analizEt(norm);
}

/** Fastify uçlarını kaydeder — index.js'ten çağrılır */
export function analizUclariniBagla(app) {

  // Panel bu uca POST eder: { ozet: {...} }
  app.post('/analiz/yorum', async (req, reply) => {
    // Basit koruma: paneli kimin kullanacağını sen belirle
    if (process.env.PANEL_ANAHTARI &&
        req.headers['x-panel-anahtari'] !== process.env.PANEL_ANAHTARI) {
      return reply.code(401).send({ hata: 'Yetkisiz' });
    }
    try {
      const yorum = await yorumUret(req.body?.ozet);
      return { yorum };
    } catch (e) {
      req.log.error({ e }, 'Yorum üretilemedi');
      return reply.code(500).send({ hata: e.message });
    }
  });

  // Canlı veritabanından hesaplanmış metrikler (panel bunu da çekebilir)
  app.get('/analiz/metrikler', async (req, reply) => {
    if (process.env.PANEL_ANAHTARI &&
        req.headers['x-panel-anahtari'] !== process.env.PANEL_ANAHTARI) {
      return reply.code(401).send({ hata: 'Yetkisiz' });
    }
    const s = await canliAnaliz({ gun: Number(req.query.gun ?? 365) });
    return yzOzetiHazirla(s);
  });

  // ---------------------------------------------------------------------
  // Erken Uyarı Panosu için CANLI VERİ UCU.
  // Panelin CONFIG.veriUrl alanına bu adres yazılır; panel her açılışta
  // (ve isterse belirli aralıklarla) buraya gelip en güncel kayıtları
  // CSV olarak indirir — siz elle dosya yüklemek zorunda kalmazsınız.
  //
  // Tarayıcıdan basit bir fetch() ile çağrıldığı için özel bir başlık
  // (header) gönderemiyor; bu yüzden yetkilendirme URL'in İÇİNDE bir
  // sorgu parametresiyle yapılıyor: ?anahtar=PANEL_ANAHTARI
  // Bu adresi kimseyle paylaşmayın — şikayet açıklamaları gibi vatandaş
  // verisi içeriyor.
  // ---------------------------------------------------------------------
  app.get('/veri/csv', async (req, reply) => {
    if (process.env.PANEL_ANAHTARI &&
        req.query.anahtar !== process.env.PANEL_ANAHTARI) {
      return reply.code(401).send('Yetkisiz — adresteki ?anahtar= değeri yanlış.');
    }
    try {
      const satirlar = await canliSatirlar(Number(req.query.gun ?? 730));
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Cache-Control', 'no-store');
      return satirlarCsvYap(satirlar);
    } catch (e) {
      req.log.error({ e }, 'Canlı veri CSV üretilemedi');
      return reply.code(500).send('Hata: ' + e.message);
    }
  });

  // Haftalık rapor — cron ile tetiklenir, çıktı e-postayla gider
  app.post('/analiz/haftalik-rapor', async (req, reply) => {
    if (req.headers['x-gorev-anahtari'] !== process.env.GOREV_ANAHTARI) {
      return reply.code(401).send();
    }
    const s = await canliAnaliz({ gun: 365 });
    const ozet = yzOzetiHazirla(s);
    const yorum = await yorumUret(ozet);

    const { epostaGonder } = await import('./bildirim.js');
    await epostaGonder({
      kime: (process.env.RAPOR_ALICILARI ?? '').split(',').filter(Boolean),
      konu: `Haftalık şikayet analizi — ${new Date().toLocaleDateString('tr-TR')}`,
      metin: yorum + '\n\n--- Hesaplanan bulgular ---\n' +
             s.cikarimlar.map(c => `• ${c.cumle}\n  (${c.formul})`).join('\n\n'),
    });

    return { gonderildi: true, bulgu: s.cikarimlar.length };
  });
}

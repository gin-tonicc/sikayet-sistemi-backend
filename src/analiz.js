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

/** Veritabanındaki canlı kayıtları motorun formatına çevirir */
export async function canliAnaliz({ gun = 365 } = {}) {
  const kayitlar = await db.analizIcinKayitlar(gun);

  // Motor CSV kolon adlarıyla çalışır; veritabanı alanlarını o adlara çeviriyoruz
  const satirlar = kayitlar.map(k => ({
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

  const norm = normalizeEt(satirlar);
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

// =====================================================================
// KONUŞMA AKIŞI
// Gelen bir mesajın (WhatsApp veya Telegram, hangisi olursa) baştan
// sona ne olduğunu yöneten dosya. Sistemin "beyni" burada — kanaldan
// tamamen bağımsızdır, sadece gelen.kanal alanına bakar.
// =====================================================================

import { db } from './db.js';
import { analizEt, sesiMetneCevir, mukerrerMi } from './ai.js';
import * as whatsapp from './whatsapp.js';
import * as telegram from './telegram.js';
import { birimeBildir } from './bildirim.js';

// Hangi kanaldan geldiğine göre "gönder" ve "medya indir" burada seçilir.
// Aşağıdaki akışın geri kalanı kanaldan tamamen habersizdir — yeni bir
// kanal eklemek (SMS, web formu) sadece burada bir satır demektir.
const KANALLAR = {
  whatsapp: { gonder: whatsapp.mesajGonder, medyaIndir: whatsapp.medyaIndir },
  telegram: { gonder: telegram.mesajGonder, medyaIndir: telegram.medyaIndir },
};

export async function mesajIsle(gelen) {
  const ayarlar = await db.ayarlariGetir();

  // ---- 1. Vatandaşı bul veya oluştur -------------------------------
  const vatandas = await db.vatandasBulVeyaOlustur(gelen.telefon, gelen.ad);

  if (vatandas.kara_liste) {
    return; // sessizce yok say
  }

  // ---- 2. Hız sınırı ----------------------------------------------
  const bugunkuKayit = await db.bugunkuKayitSayisi(vatandas.id);
  if (bugunkuKayit >= Number(ayarlar.gunluk_bildirim_limiti ?? 10)) {
    await KANALLAR[gelen.kanal].gonder(gelen.hedefId,
      'Bugün için bildirim sınırınıza ulaştınız. Mevcut bildirimleriniz işleme alındı. Acil bir durum varsa 153 veya belediye çağrı merkezini arayabilirsiniz.');
    return;
  }

  // ---- 3. Medyayı metne çevir --------------------------------------
  let metin = gelen.metin;
  let medyaYolu = null;

  if (gelen.tip === 'audio' && gelen.medyaId) {
    const { buffer, mime } = await KANALLAR[gelen.kanal].medyaIndir(gelen.medyaId);
    metin = await sesiMetneCevir(buffer, mime);
    medyaYolu = await db.medyaYukle(buffer, mime, 'ses');
  } else if (gelen.tip === 'image' && gelen.medyaId) {
    const { buffer, mime } = await KANALLAR[gelen.kanal].medyaIndir(gelen.medyaId);
    medyaYolu = await db.medyaYukle(buffer, mime, 'foto');
    metin = metin || '[Fotoğraf gönderildi]';
  } else if (gelen.tip === 'location') {
    metin = `[Konum paylaşıldı: ${gelen.konum.lat}, ${gelen.konum.lng}]`;
  }

  await db.konusmaKaydet({
    vatandas_id: vatandas.id, yon: 'gelen', rol: 'vatandas',
    mesaj: metin, medya_yolu: medyaYolu, wa_mesaj_id: gelen.waMesajId,
  });

  // ---- 4. KVKK rızası ----------------------------------------------
  if (!vatandas.kvkk_onay) {
    if (/^(evet|onaylıyorum|kabul|tamam|ok)$/i.test((metin ?? '').trim())) {
      await db.kvkkOnayla(vatandas.id);
      await yanitla(vatandas, gelen,
        'Teşekkürler. Şimdi bildiriminizi yazabilirsiniz. Ne olduğunu ve nerede olduğunu (mahalle ve sokak) belirtirseniz daha hızlı ilerleriz.');
    } else {
      await yanitla(vatandas, gelen,
        `${ayarlar.kvkk_metni}\n\nDevam etmek için EVET yazın.`);
    }
    return;
  }

  // ---- 5. Yapay zeka analizi ---------------------------------------
  const [kategoriler, mahalleler, gecmis] = await Promise.all([
    db.aktifKategoriler(),
    db.mahalleler(),
    db.sonKonusmalar(vatandas.id, 10),
  ]);

  const analiz = await analizEt({ gecmis, mesaj: metin, kategoriler, mahalleler });

  if (!analiz) {
    await yanitla(vatandas, gelen,
      'Mesajınızı alamadım. Tekrar yazar mısınız? Sorun ne, hangi mahalle ve sokakta olduğunu belirtirseniz yardımcı olabilirim.');
    return;
  }

  // ---- 6. ACİL DURUM ------------------------------------------------
  if (analiz.acil) {
    await yanitla(vatandas, gelen, analiz.vatandasa_mesaj);
    const kayit = await kayitOlustur({ vatandas, analiz, metin, medyaYolu, gelen,
                                       kategoriler, mahalleler, acil: true });
    await birimeBildir(kayit, { acil: true });   // e-posta + SMS + nöbetçi amir
    return;
  }

  // ---- 7. Şikayet değilse -------------------------------------------
  if (['bilgi', 'tesekkur', 'ilgisiz'].includes(analiz.tip)) {
    await yanitla(vatandas, gelen, analiz.vatandasa_mesaj);
    return;   // iş emri açılmaz — dashboard sahte sayıyla dolmasın
  }

  // ---- 8. Bilgi eksikse sor -----------------------------------------
  if (!analiz.yeterli_bilgi) {
    await yanitla(vatandas, gelen, analiz.vatandasa_mesaj);
    return;   // konuşma devam eder, bir sonraki mesajda tekrar analiz
  }

  // ---- 9. Mükerrer kontrolü -----------------------------------------
  const kategori = kategoriler.find(k => k.kod === analiz.kategori_kodu);
  const mahalle = mahalleler.find(m =>
    m.ad === analiz.mahalle || (m.esanlamlar ?? []).includes(analiz.mahalle));

  if (kategori) {
    const adaylar = await db.benzerSikayetler({
      kategori_id: kategori.id,
      mahalle_id: mahalle?.id ?? null,
      ozet: analiz.ozet,
      gun: Number(ayarlar.mukerrer_gun ?? 15),
      esik: Number(ayarlar.mukerrer_benzerlik ?? 0.35),
    });

    const ayniTakipNo = await mukerrerMi(analiz.ozet, adaylar);
    if (ayniTakipNo) {
      const ana = await db.sikayetGetirTakipNo(ayniTakipNo);
      await db.destekleyenEkle(ana.id, vatandas.id, analiz.ozet, gelen.kanal);
      await yanitla(vatandas, gelen,
        `Bu sorun daha önce bildirilmiş ve ${ana.takip_no} numarasıyla takip ediliyor. Bildiriminizi mevcut kayda ekledik; aynı sorunu bildiren kişi sayısı arttıkça önceliği yükseliyor.\n\nDurum: ${durumMetni(ana.durum)}`);
      return;
    }
  }

  // ---- 10. Kaydı oluştur ---------------------------------------------
  const kayit = await kayitOlustur({ vatandas, analiz, metin, medyaYolu, gelen,
                                     kategoriler, mahalleler });

  // ---- 11. Vatandaşa dön ---------------------------------------------
  if (kategori?.yetki_disi) {
    await yanitla(vatandas, gelen,
      `${kategori.yonlendirme_metni}\n\nTakip numaranız: ${kayit.takip_no}`);
  } else {
    await yanitla(vatandas, gelen,
      `Bildiriminiz alındı.\n\nTakip numarası: *${kayit.takip_no}*\nİlgili birim: ${kayit.birim_adi ?? 'Beyaz Masa'}\nKonu: ${analiz.baslik}\n\nDurumu öğrenmek için istediğiniz zaman takip numaranızı yazabilirsiniz.`);
    await birimeBildir(kayit);
  }
}

// ---------------------------------------------------------------------

async function kayitOlustur({ vatandas, analiz, metin, medyaYolu, gelen,
                              kategoriler, mahalleler, acil = false }) {
  const ayarlar = await db.ayarlariGetir();
  const kategori = kategoriler.find(k => k.kod === analiz.kategori_kodu);
  const mahalle = mahalleler.find(m =>
    m.ad === analiz.mahalle || (m.esanlamlar ?? []).includes(analiz.mahalle));

  const guvenEsigi = Number(ayarlar.ai_guven_esigi ?? 0.75);
  const guvenliMi = kategori && (analiz.guven ?? 0) >= guvenEsigi;

  // Güven düşükse otomatik atama YOK — triyaj havuzuna
  const durum = acil ? 'yeni'
              : kategori?.yetki_disi ? 'havale'
              : guvenliMi ? 'yeni'
              : 'triyaj';

  const kayit = await db.sikayetOlustur({
    kanal: gelen.kanal,
    tip: analiz.tip,
    vatandas_id: vatandas.id,
    ham_metin: metin,
    ozet: analiz.ozet,
    baslik: analiz.baslik,
    kategori_id: guvenliMi ? kategori.id : null,
    birim_id: guvenliMi ? kategori.birim_id : null,
    oncelik: acil ? 'kritik' : (analiz.oncelik ?? 'normal'),
    acil,
    ai_guven: analiz.guven,
    ai_gerekce: analiz.gerekce,
    ai_model: process.env.MODEL_SOHBET,
    mahalle_id: mahalle?.id ?? null,
    mahalle_metin: analiz.mahalle,
    adres: analiz.adres,
    konum_lat: gelen.konum?.lat ?? null,
    konum_lng: gelen.konum?.lng ?? null,
    durum,
    moderasyon: analiz.moderasyon ?? false,
    havale_kurum: kategori?.yetki_disi ? kategori.sorumlu_kurum : null,
    havale_tarih: kategori?.yetki_disi ? new Date().toISOString() : null,
  });

  if (medyaYolu) {
    await db.ekEkle(kayit.id, medyaYolu, gelen.tip === 'audio' ? 'ses' : 'foto', metin);
  }
  await db.hareketEkle(kayit.id, 'ai', 'olusturuldu',
    `Kategori: ${analiz.kategori_kodu ?? 'belirsiz'} (güven ${analiz.guven}) — ${analiz.gerekce}`);

  return kayit;
}

async function yanitla(vatandas, gelen, metin) {
  await KANALLAR[gelen.kanal].gonder(gelen.hedefId, metin);
  await db.konusmaKaydet({
    vatandas_id: vatandas.id, yon: 'giden', rol: 'ai', mesaj: metin,
  });
}

function durumMetni(d) {
  return ({
    triyaj: 'Değerlendiriliyor', yeni: 'İlgili birime iletildi',
    atandi: 'Birime atandı', islemde: 'İşleme alındı',
    beklemede: 'Beklemede', havale: 'İlgili kuruma havale edildi',
    cozuldu: 'Çözüldü, onayınız bekleniyor', kapandi: 'Kapandı',
    tekrar_acildi: 'Yeniden açıldı', reddedildi: 'İşleme alınamadı',
  })[d] ?? d;
}

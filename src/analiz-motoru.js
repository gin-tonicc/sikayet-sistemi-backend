/* =====================================================================
   ÖNEMLİ — BU DOSYA BİR KOPYADIR
   Asıl (düzenlenecek) kopya: /02-ANALIZ/analiz-motoru.js
   Bu kopya, backend'in GitHub'a AYRI bir repo olarak yüklenebilmesi için
   buraya konuldu (kardeş klasöre bağımlılık Railway'de "bulunamadı" hatası
   veriyordu — bkz. Bölüm 8, "ERR_MODULE_NOT_FOUND" sorun giderme).
   Motorda bir değişiklik yaparsanız İKİ dosyayı da güncelleyin, ya da
   /02-ANALIZ/analiz-motoru.js dosyasını buraya yeniden kopyalayın.
   ===================================================================== */

/* =====================================================================
   ANALİZ MOTORU — 153 / şikayet verisi
   ---------------------------------------------------------------------
   Bu dosya panelin BEYNİDİR. Paneldeki her sayı ve her çıkarım cümlesi
   buradaki fonksiyonlar tarafından, YÜKLENEN VERİDEN hesaplanır.
   Hiçbir müdürlük adı, hiçbir ilçe adı, hiçbir hedef süre bu dosyada
   yazılı DEĞİLDİR. Yeni bir CSV yüklendiğinde sonuçlar tamamen değişir.

   Aynı dosya hem tarayıcıda (panel) hem Node.js'te (zamanlanmış rapor)
   çalışır.

   Kullanım:
     const veri   = normalizeEt(hamSatirlar);      // kolonları tanı
     const sonuc  = analizEt(veri, { bugun: new Date() });
     sonuc.cikarimlar  →  [{ baslik, cumle, formul, siddet, veri }]
   ===================================================================== */

/* ---------------------------------------------------------------------
   0. YARDIMCILAR
   --------------------------------------------------------------------- */

const trHarf = { 'ı': 'i', 'İ': 'i', 'ş': 's', 'Ş': 's', 'ğ': 'g', 'Ğ': 'g', 'ü': 'u', 'Ü': 'u', 'ö': 'o', 'Ö': 'o', 'ç': 'c', 'Ç': 'c' };

function sadelestir(s) {
  return String(s ?? '')
    .replace(/[ıİşŞğĞüÜöÖçÇ]/g, ch => trHarf[ch])
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

const GUN = 86400000;

function medyan(dizi) {
  if (!dizi.length) return null;
  const s = [...dizi].sort((a, b) => a - b);
  const o = Math.floor(s.length / 2);
  return s.length % 2 ? s[o] : (s[o - 1] + s[o]) / 2;
}

function ortalama(d) { return d.length ? d.reduce((a, b) => a + b, 0) / d.length : null; }

function stdSapma(d) {
  if (d.length < 2) return 0;
  const m = ortalama(d);
  return Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / (d.length - 1));
}

/** Yüzdelik dilim (p: 0–100) — çözüm süresi dağılımı için */
function yuzdelik(dizi, p) {
  if (!dizi.length) return null;
  const s = [...dizi].sort((a, b) => a - b);
  const i = (p / 100) * (s.length - 1);
  const alt = Math.floor(i), ust = Math.ceil(i);
  return alt === ust ? s[alt] : s[alt] + (s[ust] - s[alt]) * (i - alt);
}

/** Pazartesi 00:00'a yuvarlar — hafta kovaları için */
function haftaBasi(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  const gun = (d.getDay() + 6) % 7;      // pazartesi = 0
  d.setDate(d.getDate() - gun);
  return d.getTime();
}

function tarihOku(deger) {
  if (deger instanceof Date) return isNaN(deger) ? null : deger;
  if (deger == null || deger === '') return null;

  // Excel seri numarası (ör. 45321)
  if (typeof deger === 'number' && deger > 20000 && deger < 60000) {
    return new Date(Date.UTC(1899, 11, 30) + deger * GUN);
  }
  const m = String(deger).trim();

  // GG.AA.YYYY veya GG/AA/YYYY (+ saat)
  let e = m.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (e) return new Date(+e[3], +e[2] - 1, +e[1], +(e[4] ?? 0), +(e[5] ?? 0));

  // YYYY-AA-GG
  e = m.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (e) return new Date(+e[1], +e[2] - 1, +e[3], +(e[4] ?? 0), +(e[5] ?? 0));

  const d = new Date(m);
  return isNaN(d) ? null : d;
}

/* ---------------------------------------------------------------------
   1. KOLON TANIMA
   Kolon adları belediyeden belediyeye değişir. Aday listelerle eşleşir.
   Eşleşme bulunamazsa kullanıcı panelden elle seçer.
   --------------------------------------------------------------------- */

export const KOLON_ADAYLARI = {
  acilis:   ['basvurutarihi', 'acilistarihi', 'kayittarihi', 'talep tarihi', 'taleptarihi', 'tarih', 'olusturmatarihi', 'gelistarihi', 'basvuru', 'createddate'],
  kapanis:  ['kapanistarihi', 'cozumtarihi', 'sonlandirmatarihi', 'kapanma', 'kapatmatarihi', 'cevaptarihi', 'closeddate'],
  ilce:     ['ilce', 'ilcesi', 'ilceadi', 'bolge', 'district'],
  mahalle:  ['mahalle', 'mahallesi', 'mahalleadi', 'semt', 'neighborhood'],
  kategori: ['kategori', 'konu', 'konubasligi', 'sikayetturu', 'talepturu', 'altkategori', 'basvurukonusu', 'complainttype'],
  birim:    ['birim', 'mudurluk', 'ilgilimudurluk', 'daire', 'dairebaskanligi', 'sorumlubirim', 'yonlendirilenbirim', 'agency'],
  durum:    ['durum', 'statu', 'kayitdurumu', 'sonuc', 'status'],
  metin:    ['aciklama', 'talepmetni', 'sikayetmetni', 'icerik', 'detay', 'basvurumetni', 'descriptor'],
  kanal:    ['kanal', 'basvurukanali', 'geldigikanal', 'iletisimkanali'],
};

/** Ham başlıkları tarayıp hangi kolonun ne olduğunu tahmin eder */
export function kolonlariTani(basliklar) {
  const eslesme = {};
  const sadeBasliklar = basliklar.map(b => ({ ham: b, sade: sadelestir(b) }));

  for (const [alan, adaylar] of Object.entries(KOLON_ADAYLARI)) {
    let bulunan = null;
    for (const aday of adaylar) {
      const a = sadelestir(aday);
      // önce tam eşleşme, sonra "içeriyor"
      bulunan = sadeBasliklar.find(b => b.sade === a)
             ?? sadeBasliklar.find(b => b.sade.includes(a));
      if (bulunan) break;
    }
    eslesme[alan] = bulunan?.ham ?? null;
  }
  return eslesme;
}

const KAPALI_SOZCUKLER = ['kapand', 'kapali', 'cozuld', 'cozum', 'tamamland', 'sonucland', 'closed', 'iptal', 'reddedild'];

/** Ham satırları motorun anladığı tek biçime çevirir */
export function normalizeEt(satirlar, eslesmeDisaridan = null) {
  if (!satirlar?.length) return { kayitlar: [], eslesme: {}, atlanan: 0 };

  const eslesme = eslesmeDisaridan ?? kolonlariTani(Object.keys(satirlar[0]));
  const al = (s, alan) => (eslesme[alan] ? s[eslesme[alan]] : null);

  let atlanan = 0;
  const kayitlar = [];

  for (const s of satirlar) {
    const acilis = tarihOku(al(s, 'acilis'));
    if (!acilis) { atlanan++; continue; }        // tarihi olmayan satır analize giremez

    const kapanis = tarihOku(al(s, 'kapanis'));
    const durumHam = String(al(s, 'durum') ?? '').trim();
    const durumSade = sadelestir(durumHam);

    // Kapalı mı? Önce kapanış tarihi, yoksa durum metni karar verir.
    const kapali = !!kapanis || KAPALI_SOZCUKLER.some(k => durumSade.includes(sadelestir(k)));

    kayitlar.push({
      acilis,
      kapanis: kapali ? kapanis : null,
      cozumGun: (kapali && kapanis) ? Math.max(0, (kapanis - acilis) / GUN) : null,
      kapali,
      ilce:     (String(al(s, 'ilce')     ?? '').trim() || 'Belirtilmemiş'),
      mahalle:  (String(al(s, 'mahalle')  ?? '').trim() || 'Belirtilmemiş'),
      kategori: (String(al(s, 'kategori') ?? '').trim() || 'Belirtilmemiş'),
      birim:    (String(al(s, 'birim')    ?? '').trim() || 'Belirtilmemiş'),
      durum:    durumHam || (kapali ? 'Kapandı' : 'Açık'),
      metin:    String(al(s, 'metin') ?? ''),
      kanal:    String(al(s, 'kanal') ?? '').trim(),
    });
  }
  return { kayitlar, eslesme, atlanan };
}

/* ---------------------------------------------------------------------
   2. AYARLAR
   Hepsi panelden değiştirilebilir. Hiçbiri "şu sürede kapanmalı" gibi
   bir hedef DEĞİLDİR — sadece istatistiksel eşiklerdir.
   --------------------------------------------------------------------- */

export const VARSAYILAN_AYAR = {
  bazHafta: 12,          // karşılaştırma için kaç haftalık geçmişe bakılacak
  zEsigi: 2.0,           // kaç standart sapma üstü "sapma" sayılır
  enAzKayit: 5,          // bu sayının altındaki artışlar gürültü kabul edilir
  yeniSorunEsigi: 3,     // geçmişte hiç yokken bu kadar görülürse "yeni sorun"
  kumeGun: 7,            // coğrafi kümelenme penceresi (gün)
  kumeEsigi: 4,          // aynı mahalle+konu bu kadar kayıt = kümelenme
  perfSonGun: 30,        // birim performansında "son dönem"
  perfBazGun: 90,        // birimin kendi karşılaştırma tabanı (son dönemden önceki)
  perfEnAzKapanan: 8,    // bu kadar kapanmış kaydı olmayan birim kıyaslanmaz
  yavaslamaOrani: 1.30,  // kendi geçmişinin %30 üstü = yavaşlama sinyali
  hizlanmaOrani: 0.75,   // kendi geçmişinin %25 altı = hızlanma sinyali
  yaslanmaYuzdelik: 90,  // açık kayıt yaşı bu yüzdelikle kıyaslanır
  ustSayi: 8,            // listelerde kaç satır gösterilecek
};

/* ---------------------------------------------------------------------
   3. TEMEL DAĞILIMLAR
   --------------------------------------------------------------------- */

function dagilimSay(kayitlar, alan) {
  const m = new Map();
  for (const k of kayitlar) m.set(k[alan], (m.get(k[alan]) ?? 0) + 1);
  return [...m.entries()]
    .map(([ad, adet]) => ({ ad, adet, oran: adet / kayitlar.length }))
    .sort((a, b) => b.adet - a.adet);
}

function sayCift(kayitlar, a1, a2) {
  const m = new Map();
  for (const k of kayitlar) {
    const anahtar = k[a1] + ' ▸ ' + k[a2];
    const o = m.get(anahtar) ?? { [a1]: k[a1], [a2]: k[a2], adet: 0 };
    o.adet++;
    m.set(anahtar, o);
  }
  return [...m.values()].sort((a, b) => b.adet - a.adet);
}

/* ---------------------------------------------------------------------
   4. HAFTALIK SERİ + Z-SKORU (ERKEN UYARI)
   Mantık: son TAM haftanın sayısı, kendinden önceki N haftanın
   ortalaması ve standart sapmasıyla kıyaslanır.
   z = (sonHafta − ortalama) / stdSapma
   --------------------------------------------------------------------- */

function haftalikSeri(kayitlar, bugun, haftaSayisi) {
  const sonTamHafta = haftaBasi(bugun) - 7 * GUN;   // içinde bulunulan hafta hariç
  const kovalar = new Map();
  for (let i = 0; i <= haftaSayisi; i++) kovalar.set(sonTamHafta - i * 7 * GUN, 0);

  for (const k of kayitlar) {
    const h = haftaBasi(k.acilis);
    if (kovalar.has(h)) kovalar.set(h, kovalar.get(h) + 1);
  }
  return [...kovalar.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hafta, adet]) => ({ hafta, adet }));
}

function sapmaHesapla(kayitlar, bugun, ayar) {
  const seri = haftalikSeri(kayitlar, bugun, ayar.bazHafta);
  const son = seri[seri.length - 1];
  const baz = seri.slice(0, -1).map(s => s.adet);
  const ort = ortalama(baz) ?? 0;
  const sd = stdSapma(baz);
  const z = sd > 0 ? (son.adet - ort) / sd : (son.adet > ort ? 99 : 0);
  return { seri, sonHafta: son.adet, bazOrtalama: ort, bazSapma: sd, z, bazHaftaSayisi: baz.length };
}

/** Konu × coğrafi alan kırılımında istatistiksel sapma arar.
    alan: 'ilce' (çok ilçeli veri) veya 'mahalle' (tek ilçeli belediye) */
function erkenUyari(kayitlar, bugun, ayar, alan = 'ilce') {
  const gruplar = new Map();
  for (const k of kayitlar) {
    const bolge = k[alan];
    if (bolge === 'Belirtilmemiş') continue;
    const anahtar = k.kategori + '|' + bolge;
    if (!gruplar.has(anahtar)) gruplar.set(anahtar, { kategori: k.kategori, ilce: bolge, kayitlar: [] });
    gruplar.get(anahtar).kayitlar.push(k);
  }

  const sapmalar = [], yeniSorunlar = [];

  for (const g of gruplar.values()) {
    const h = sapmaHesapla(g.kayitlar, bugun, ayar);
    if (h.sonHafta < ayar.enAzKayit) continue;

    if (h.bazOrtalama === 0 && h.sonHafta >= ayar.yeniSorunEsigi) {
      yeniSorunlar.push({
        kategori: g.kategori, ilce: g.ilce, sonHafta: h.sonHafta,
        bazHafta: h.bazHaftaSayisi,
        formul: `Son ${h.bazHaftaSayisi} haftada bu konu-ilçe eşleşmesinde hiç kayıt yok; son tam haftada ${h.sonHafta} kayıt açıldı.`,
      });
    } else if (h.z >= ayar.zEsigi) {
      sapmalar.push({
        kategori: g.kategori, ilce: g.ilce, z: h.z,
        sonHafta: h.sonHafta, bazOrtalama: h.bazOrtalama, bazSapma: h.bazSapma,
        artisKat: h.bazOrtalama ? h.sonHafta / h.bazOrtalama : null,
        seri: h.seri,
        formul: `z = (${h.sonHafta} − ${h.bazOrtalama.toFixed(1)}) / ${h.bazSapma.toFixed(1)} = ${h.z.toFixed(1)}  •  baz: önceki ${h.bazHaftaSayisi} hafta`,
      });
    }
  }
  sapmalar.sort((a, b) => b.z - a.z);
  yeniSorunlar.sort((a, b) => b.sonHafta - a.sonHafta);
  return { sapmalar, yeniSorunlar };
}

/* ---------------------------------------------------------------------
   5. COĞRAFİ KÜMELENME
   Kısa pencerede aynı mahalle + aynı konudan çoklu başvuru.
   --------------------------------------------------------------------- */

function kumelenme(kayitlar, bugun, ayar) {
  const sinir = bugun.getTime() - ayar.kumeGun * GUN;
  const m = new Map();

  for (const k of kayitlar) {
    if (k.acilis.getTime() < sinir) continue;
    if (k.mahalle === 'Belirtilmemiş') continue;
    const anahtar = k.ilce + '|' + k.mahalle + '|' + k.kategori;
    const o = m.get(anahtar) ?? { ilce: k.ilce, mahalle: k.mahalle, kategori: k.kategori, adet: 0, acikAdet: 0 };
    o.adet++;
    if (!k.kapali) o.acikAdet++;
    m.set(anahtar, o);
  }

  return [...m.values()]
    .filter(o => o.adet >= ayar.kumeEsigi)
    .map(o => ({ ...o, formul: `Son ${ayar.kumeGun} günde ${o.mahalle} × "${o.kategori}" = ${o.adet} kayıt (eşik: ${ayar.kumeEsigi})` }))
    .sort((a, b) => b.adet - a.adet);
}

/* ---------------------------------------------------------------------
   6. BİRİM PERFORMANSI
   ÖNEMLİ: Sistemde "şu iş şu sürede kapanmalı" diye bir hedef YOKTUR.
   Her birim YALNIZCA KENDİ GEÇMİŞİYLE kıyaslanır. Bu yüzden bir birimin
   işi doğası gereği uzun sürüyorsa cezalandırılmaz; ama kendi normalinin
   dışına çıktığında görünür olur.
   --------------------------------------------------------------------- */

function birimPerformansi(kayitlar, bugun, ayar) {
  const t = bugun.getTime();
  const sonSinir = t - ayar.perfSonGun * GUN;
  const bazSinir = t - (ayar.perfSonGun + ayar.perfBazGun) * GUN;

  const gruplar = new Map();
  for (const k of kayitlar) {
    if (!gruplar.has(k.birim)) gruplar.set(k.birim, []);
    gruplar.get(k.birim).push(k);
  }

  const satirlar = [];

  for (const [birim, liste] of gruplar) {
    const acik = liste.filter(k => !k.kapali);
    const acikYaslar = acik.map(k => (t - k.acilis.getTime()) / GUN);

    // Çözüm süresi: kapanış tarihine göre dönemlere ayrılır
    const sonKapanan = liste.filter(k => k.kapali && k.kapanis && k.kapanis.getTime() >= sonSinir);
    const bazKapanan = liste.filter(k => k.kapali && k.kapanis &&
      k.kapanis.getTime() < sonSinir && k.kapanis.getTime() >= bazSinir);

    const sonMed = medyan(sonKapanan.map(k => k.cozumGun).filter(v => v != null));
    const bazMed = medyan(bazKapanan.map(k => k.cozumGun).filter(v => v != null));

    const kiyaslanabilir = sonKapanan.length >= ayar.perfEnAzKapanan &&
                           bazKapanan.length >= ayar.perfEnAzKapanan &&
                           sonMed != null && bazMed != null && bazMed > 0;

    const oran = kiyaslanabilir ? sonMed / bazMed : null;

    // Tüm dönem boyunca kapanmış işler — "kaç iş bitirdi, ortalama kaç günde"
    const tumKapanan = liste.filter(k => k.cozumGun != null).map(k => k.cozumGun);

    satirlar.push({
      birim,
      toplam: liste.length,
      acik: acik.length,
      kapanan: tumKapanan.length,
      // Medyan tipik hızı gösterir; ortalama tek bir çok uzun işten etkilenir.
      // İkisini birlikte vermek, aradaki farkın kendisini bilgi hâline getirir.
      ortalamaCozumGun: ortalama(tumKapanan),
      medyanCozumGun: medyan(tumKapanan),
      acikOran: liste.length ? acik.length / liste.length : 0,
      enYasliAcikGun: acikYaslar.length ? Math.max(...acikYaslar) : null,
      medyanAcikYasGun: medyan(acikYaslar),
      sonDonemKapanan: sonKapanan.length,
      sonMedyanGun: sonMed,
      bazMedyanGun: bazMed,
      bazKapanan: bazKapanan.length,
      p90Gun: yuzdelik(liste.filter(k => k.cozumGun != null).map(k => k.cozumGun), 90),
      oran,
      yon: !kiyaslanabilir ? 'yetersiz-veri'
         : oran >= ayar.yavaslamaOrani ? 'yavasliyor'
         : oran <= ayar.hizlanmaOrani ? 'hizlaniyor'
         : 'sabit',
      formul: kiyaslanabilir
        ? `Son ${ayar.perfSonGun} günde kapanan ${sonKapanan.length} kaydın medyanı ${sonMed.toFixed(1)} gün; ` +
          `önceki ${ayar.perfBazGun} günde kapanan ${bazKapanan.length} kaydın medyanı ${bazMed.toFixed(1)} gün. ` +
          `Oran = ${oran.toFixed(2)}`
        : `Kıyas için yeterli kapanmış kayıt yok (son dönem ${sonKapanan.length}, baz dönem ${bazKapanan.length}; gereken ${ayar.perfEnAzKapanan}).`,
    });
  }

  return satirlar.sort((a, b) => b.acik - a.acik);
}

/** Uzun süredir açık kalan kayıtlar — birimin kendi dağılımına göre */
function yaslanmaAnalizi(kayitlar, bugun, ayar) {
  const t = bugun.getTime();
  const gruplar = new Map();
  for (const k of kayitlar) {
    if (!gruplar.has(k.birim)) gruplar.set(k.birim, []);
    gruplar.get(k.birim).push(k);
  }

  const bulgular = [];
  for (const [birim, liste] of gruplar) {
    const kapananSureler = liste.filter(k => k.cozumGun != null).map(k => k.cozumGun);
    if (kapananSureler.length < ayar.perfEnAzKapanan) continue;

    // Bu birimin kendi kapanış dağılımının üst yüzdeliği referans alınır
    const esik = yuzdelik(kapananSureler, ayar.yaslanmaYuzdelik);
    const takilanlar = liste.filter(k => !k.kapali && (t - k.acilis.getTime()) / GUN > esik);

    if (takilanlar.length) {
      bulgular.push({
        birim,
        adet: takilanlar.length,
        esikGun: esik,
        enYasliGun: Math.max(...takilanlar.map(k => (t - k.acilis.getTime()) / GUN)),
        formul: `${birim} biriminde kapanmış kayıtların %${ayar.yaslanmaYuzdelik}'i ${esik.toFixed(1)} gün içinde kapanmış. ` +
                `Hâlen açık ${takilanlar.length} kayıt bu süreyi aşmış durumda.`,
      });
    }
  }
  return bulgular.sort((a, b) => b.adet - a.adet);
}

/** Her birimin AÇIK işlerinin konu kırılımı — "elimizde ne var" ekranı */
function birimAcikKirilim(kayitlar) {
  const m = new Map();
  for (const k of kayitlar) {
    if (k.kapali) continue;
    if (!m.has(k.birim)) m.set(k.birim, new Map());
    const kk = m.get(k.birim);
    kk.set(k.kategori, (kk.get(k.kategori) ?? 0) + 1);
  }
  const cikti = {};
  for (const [birim, kk] of m) {
    cikti[birim] = [...kk.entries()]
      .map(([ad, adet]) => ({ ad, adet }))
      .sort((a, b) => b.adet - a.adet);
  }
  return cikti;
}

/* ---------------------------------------------------------------------
   7. DÖNEM KIYASLAMASI (YÜKSELENLER)
   --------------------------------------------------------------------- */

function yukselenler(kayitlar, bugun, ayar, alan = 'kategori') {
  const t = bugun.getTime();
  const sonBas = t - ayar.perfSonGun * GUN;
  const oncekiBas = t - 2 * ayar.perfSonGun * GUN;

  const son = new Map(), onceki = new Map();
  for (const k of kayitlar) {
    const z = k.acilis.getTime();
    if (z >= sonBas) son.set(k[alan], (son.get(k[alan]) ?? 0) + 1);
    else if (z >= oncekiBas) onceki.set(k[alan], (onceki.get(k[alan]) ?? 0) + 1);
  }

  const cikti = [];
  for (const [ad, sonAdet] of son) {
    const oncekiAdet = onceki.get(ad) ?? 0;
    if (sonAdet < ayar.enAzKayit) continue;
    const fark = sonAdet - oncekiAdet;
    const yuzde = oncekiAdet ? (fark / oncekiAdet) * 100 : null;
    cikti.push({
      ad, sonAdet, oncekiAdet, fark, yuzde,
      formul: `Son ${ayar.perfSonGun} gün: ${sonAdet} • önceki ${ayar.perfSonGun} gün: ${oncekiAdet}` +
              (yuzde != null ? ` → %${yuzde.toFixed(0)} değişim` : ' → önceki dönemde kayıt yok'),
    });
  }
  return cikti.sort((a, b) => (b.yuzde ?? 999) - (a.yuzde ?? 999));
}

/* ---------------------------------------------------------------------
   8. ÇIKARIM ÜRETİCİ
   Yukarıdaki hesapların sonuçlarını Türkçe cümleye çevirir.
   Her cümlenin yanında ONU ÜRETEN FORMÜL vardır. Uydurma yoktur:
   bir bulgu hesaplanmadıysa cümle de yazılmaz.
   --------------------------------------------------------------------- */

function cikarimUret(s, ayar) {
  const c = [];
  const gun = n => n == null ? '—' : `${n.toFixed(1)} gün`;

  // 1) Sapmalar
  for (const x of s.erkenUyari.sapmalar.slice(0, 5)) {
    c.push({
      tur: 'sapma',
      siddet: x.z >= 3 ? 'yuksek' : 'orta',
      baslik: `${x.ilce} — ${x.kategori}`,
      cumle: `${x.ilce} ilçesinde "${x.kategori}" başvuruları son tam haftada ${x.sonHafta}'e çıktı; ` +
             `önceki ${ayar.bazHafta} haftanın ortalaması ${x.bazOrtalama.toFixed(1)} idi. ` +
             `Bu, normal dalgalanmanın ${x.z.toFixed(1)} standart sapma üzerinde.`,
      formul: x.formul,
      veri: x,
    });
  }

  // 2) Yeni ortaya çıkan sorunlar
  for (const x of s.erkenUyari.yeniSorunlar.slice(0, 4)) {
    c.push({
      tur: 'yeni-sorun',
      siddet: 'yuksek',
      baslik: `Yeni: ${x.ilce} — ${x.kategori}`,
      cumle: `${x.ilce} ilçesinde "${x.kategori}" konusu önceki ${x.bazHafta} hafta boyunca hiç görülmemişti; ` +
             `son tam haftada ${x.sonHafta} başvuru geldi.`,
      formul: x.formul,
      veri: x,
    });
  }

  // 3) Coğrafi kümelenme
  for (const x of s.kumelenme.slice(0, 4)) {
    c.push({
      tur: 'kumelenme',
      siddet: x.adet >= ayar.kumeEsigi * 2 ? 'yuksek' : 'orta',
      baslik: `${x.mahalle} (${x.ilce})`,
      cumle: `${x.ilce} ${x.mahalle} Mahallesi'nden son ${ayar.kumeGun} günde "${x.kategori}" konusunda ${x.adet} ayrı başvuru geldi` +
             (x.acikAdet ? `; bunların ${x.acikAdet} tanesi hâlâ açık.` : '.') +
             ` Aynı noktada tek bir kaynak sorun olması muhtemel.`,
      formul: x.formul,
      veri: x,
    });
  }

  // 4) Yavaşlayan birimler — hedef süre yok, kendi geçmişiyle kıyas
  for (const x of s.birimPerformansi.filter(b => b.yon === 'yavasliyor').slice(0, 5)) {
    c.push({
      tur: 'birim-yavasliyor',
      siddet: x.oran >= 1.75 ? 'yuksek' : 'orta',
      baslik: `${x.birim} — çözüm süresi uzuyor`,
      cumle: `${x.birim} son ${ayar.perfSonGun} günde kapattığı kayıtları medyan ${gun(x.sonMedyanGun)} içinde sonuçlandırdı. ` +
             `Aynı birimin önceki ${ayar.perfBazGun} gündeki medyanı ${gun(x.bazMedyanGun)} idi — kendi normaline göre %${((x.oran - 1) * 100).toFixed(0)} daha yavaş.`,
      formul: x.formul,
      veri: x,
    });
  }

  // 5) Hızlanan birimler
  for (const x of s.birimPerformansi.filter(b => b.yon === 'hizlaniyor').slice(0, 3)) {
    c.push({
      tur: 'birim-hizlaniyor',
      siddet: 'dusuk',
      baslik: `${x.birim} — çözüm süresi kısaldı`,
      cumle: `${x.birim} son ${ayar.perfSonGun} günde medyan ${gun(x.sonMedyanGun)} ile çalışıyor; ` +
             `önceki ${ayar.perfBazGun} gündeki medyanı ${gun(x.bazMedyanGun)} idi.`,
      formul: x.formul,
      veri: x,
    });
  }

  // 6) Yaşlanan açık kayıtlar
  for (const x of s.yaslanma.slice(0, 4)) {
    c.push({
      tur: 'yaslanma',
      siddet: x.adet >= 10 ? 'yuksek' : 'orta',
      baslik: `${x.birim} — bekleyen kayıtlar`,
      cumle: `${x.birim} biriminde ${x.adet} kayıt, bu birimin kendi kapanış süresinin üst dilimini aşmış durumda ` +
             `(referans ${gun(x.esikGun)}, en eskisi ${gun(x.enYasliGun)}).`,
      formul: x.formul,
      veri: x,
    });
  }

  // 7) Açık yük dengesizliği
  const enYuklu = s.birimPerformansi.filter(b => b.acik >= ayar.enAzKayit)[0];
  if (enYuklu && s.ozet.acik > 0) {
    const pay = enYuklu.acik / s.ozet.acik;
    if (pay >= 0.30) {
      c.push({
        tur: 'yuk-dengesi',
        siddet: 'orta',
        baslik: `Açık yükün yoğunlaştığı birim`,
        cumle: `Sistemdeki ${s.ozet.acik} açık kaydın ${enYuklu.acik} tanesi (%${(pay * 100).toFixed(0)}) ${enYuklu.birim} biriminde toplanmış.`,
        formul: `${enYuklu.acik} / ${s.ozet.acik} = %${(pay * 100).toFixed(0)} (eşik %30)`,
        veri: enYuklu,
      });
    }
  }

  // 8) Genel hacim değişimi
  const g = s.genelSapma;
  if (Math.abs(g.z) >= ayar.zEsigi && g.sonHafta >= ayar.enAzKayit) {
    c.push({
      tur: 'hacim',
      siddet: 'orta',
      baslik: g.z > 0 ? 'Toplam başvuru hacmi yükseldi' : 'Toplam başvuru hacmi düştü',
      cumle: `Son tam haftada toplam ${g.sonHafta} başvuru alındı; önceki ${g.bazHaftaSayisi} haftanın ortalaması ` +
             `${g.bazOrtalama.toFixed(1)}. Sapma ${g.z.toFixed(1)} standart sapma.`,
      formul: `z = (${g.sonHafta} − ${g.bazOrtalama.toFixed(1)}) / ${g.bazSapma.toFixed(1)} = ${g.z.toFixed(1)}`,
      veri: g,
    });
  }

  // 9) Yükselen konular
  for (const x of s.yukselenKonular.filter(y => y.yuzde != null && y.yuzde >= 50).slice(0, 3)) {
    c.push({
      tur: 'yukselen',
      siddet: 'orta',
      baslik: `Artan konu: ${x.ad}`,
      cumle: `"${x.ad}" başvuruları son ${ayar.perfSonGun} günde ${x.sonAdet}'e ulaştı; ` +
             `bir önceki ${ayar.perfSonGun} günlük dönemde ${x.oncekiAdet} idi (%${x.yuzde.toFixed(0)} artış).`,
      formul: x.formul,
      veri: x,
    });
  }

  const sira = { yuksek: 0, orta: 1, dusuk: 2 };
  return c.sort((a, b) => sira[a.siddet] - sira[b.siddet]);
}

/* ---------------------------------------------------------------------
   9. ANA GİRİŞ
   --------------------------------------------------------------------- */

export function analizEt(normalize, secenek = {}) {
  const ayar = { ...VARSAYILAN_AYAR, ...(secenek.ayar ?? {}) };
  let kayitlar = normalize.kayitlar ?? normalize;

  // Filtreler (panelden gelir)
  const f = secenek.filtre ?? {};
  if (f.ilce)     kayitlar = kayitlar.filter(k => k.ilce === f.ilce);
  if (f.kategori) kayitlar = kayitlar.filter(k => k.kategori === f.kategori);
  if (f.birim)    kayitlar = kayitlar.filter(k => k.birim === f.birim);
  if (f.gun) {
    const sinir = (secenek.bugun ?? new Date()).getTime() - f.gun * GUN;
    kayitlar = kayitlar.filter(k => k.acilis.getTime() >= sinir);
  }

  // "Bugün" verinin son gününe göre belirlenir — eski dosyalar da doğru analiz edilsin
  const bugun = secenek.bugun ??
    (kayitlar.length ? new Date(Math.max(...kayitlar.map(k => k.acilis.getTime()))) : new Date());

  if (!kayitlar.length) {
    return { bos: true, ayar, bugun, ozet: {}, cikarimlar: [] };
  }

  const cozumSureleri = kayitlar.filter(k => k.cozumGun != null).map(k => k.cozumGun);
  const t = bugun.getTime();

  // Veri tek ilçeliyse (ilçe belediyesi) coğrafi analiz mahalle bazına düşer.
  const ilceKumesi = new Set(kayitlar.map(k => k.ilce).filter(a => a !== 'Belirtilmemiş'));
  const cografiAlan = ilceKumesi.size > 1 ? 'ilce' : 'mahalle';

  const ozet = {
    toplam: kayitlar.length,
    acik: kayitlar.filter(k => !k.kapali).length,
    kapali: kayitlar.filter(k => k.kapali).length,
    kapanmaOrani: kayitlar.filter(k => k.kapali).length / kayitlar.length,
    medyanCozumGun: medyan(cozumSureleri),
    p90CozumGun: yuzdelik(cozumSureleri, 90),
    medyanAcikYasGun: medyan(kayitlar.filter(k => !k.kapali).map(k => (t - k.acilis.getTime()) / GUN)),
    ilkTarih: new Date(Math.min(...kayitlar.map(k => k.acilis.getTime()))),
    sonTarih: new Date(Math.max(...kayitlar.map(k => k.acilis.getTime()))),
    ilceSayisi: new Set(kayitlar.map(k => k.ilce)).size,
    kategoriSayisi: new Set(kayitlar.map(k => k.kategori)).size,
    birimSayisi: new Set(kayitlar.map(k => k.birim)).size,
  };

  const sonuc = {
    bos: false,
    ayar,
    bugun,
    ozet,
    kayitSayisi: kayitlar.length,
    kategoriler: dagilimSay(kayitlar, 'kategori'),
    ilceler: dagilimSay(kayitlar, 'ilce'),
    mahalleler: dagilimSay(kayitlar, 'mahalle').filter(m => m.ad !== 'Belirtilmemiş'),
    birimler: dagilimSay(kayitlar, 'birim'),
    ilceKategori: sayCift(kayitlar, 'ilce', 'kategori'),
    // Mahalle × konu: "en yoğun sorun noktalarımız neresi ve ne" sorusunun cevabı.
    // Tek ilçeli belediyede ilceKategori işe yaramadığı için asıl kullanılan bu.
    mahalleKategori: sayCift(kayitlar, 'mahalle', 'kategori')
      .filter(x => x.mahalle !== 'Belirtilmemiş'),
    cografiAlan,
    genelSapma: sapmaHesapla(kayitlar, bugun, ayar),
    erkenUyari: erkenUyari(kayitlar, bugun, ayar, cografiAlan),
    kumelenme: kumelenme(kayitlar, bugun, ayar),
    birimPerformansi: birimPerformansi(kayitlar, bugun, ayar),
    yaslanma: yaslanmaAnalizi(kayitlar, bugun, ayar),
    birimAcikKirilim: birimAcikKirilim(kayitlar),
    yukselenKonular: yukselenler(kayitlar, bugun, ayar, 'kategori'),
    yukselenIlceler: yukselenler(kayitlar, bugun, ayar, 'ilce'),
  };

  sonuc.cikarimlar = cikarimUret(sonuc, ayar);
  return sonuc;
}

/* ---------------------------------------------------------------------
   10. YAPAY ZEKA İÇİN ÖZET
   Ham veri modele GÖNDERİLMEZ. Sadece yukarıda hesaplanmış sayılar
   gönderilir. Model sayı üretmez; hesaplanmış sayıları yorumlar.
   --------------------------------------------------------------------- */

export function yzOzetiHazirla(s) {
  if (s.bos) return null;
  const k = (x, n = 1) => x == null ? null : Number(x.toFixed(n));

  return {
    donem: {
      ilk: s.ozet.ilkTarih.toISOString().slice(0, 10),
      son: s.ozet.sonTarih.toISOString().slice(0, 10),
    },
    ozet: {
      toplam: s.ozet.toplam, acik: s.ozet.acik, kapali: s.ozet.kapali,
      medyan_cozum_gun: k(s.ozet.medyanCozumGun),
      p90_cozum_gun: k(s.ozet.p90CozumGun),
      medyan_acik_yas_gun: k(s.ozet.medyanAcikYasGun),
    },
    en_cok_konular: s.kategoriler.slice(0, 10).map(x => ({ konu: x.ad, adet: x.adet })),
    cografi_analiz_seviyesi: s.cografiAlan,
    en_cok_ilceler: s.ilceler.slice(0, 10).map(x => ({ ilce: x.ad, adet: x.adet })),
    en_cok_mahalleler: s.mahalleler.slice(0, 10).map(x => ({ mahalle: x.ad, adet: x.adet })),
    sapmalar: s.erkenUyari.sapmalar.slice(0, 10).map(x => ({
      ilce: x.ilce, konu: x.kategori, son_hafta: x.sonHafta,
      baz_ortalama: k(x.bazOrtalama), z: k(x.z),
    })),
    yeni_sorunlar: s.erkenUyari.yeniSorunlar.slice(0, 8),
    kumelenmeler: s.kumelenme.slice(0, 8).map(x => ({
      ilce: x.ilce, mahalle: x.mahalle, konu: x.kategori, adet: x.adet, acik: x.acikAdet,
    })),
    birimler: s.birimPerformansi.slice(0, 20).map(x => ({
      birim: x.birim, toplam: x.toplam, acik: x.acik, kapanan: x.kapanan,
      ortalama_cozum_gun: k(x.ortalamaCozumGun),
      medyan_cozum_gun: k(x.medyanCozumGun),
      son_donem_medyan_gun: k(x.sonMedyanGun),
      onceki_donem_medyan_gun: k(x.bazMedyanGun),
      degisim_orani: k(x.oran, 2),
      yon: x.yon,
      en_yasli_acik_gun: k(x.enYasliAcikGun),
    })),
    yaslanan: s.yaslanma.slice(0, 8).map(x => ({
      birim: x.birim, adet: x.adet, esik_gun: k(x.esikGun), en_yasli_gun: k(x.enYasliGun),
    })),
    hesaplanan_cikarimlar: s.cikarimlar.map(c => ({ tur: c.tur, siddet: c.siddet, cumle: c.cumle })),
  };
}

export const YZ_SISTEM_TALIMATI = `Sen bir belediyenin veri analiz danışmanısın. Sana ham şikayet verisi DEĞİL, önceden hesaplanmış metrikler veriliyor.

KURALLAR
1. Yeni sayı üretme. Sadece sana verilen sayıları kullan. Bir sayı verilmediyse "veride yok" de.
2. Hedef süre belirleme. "Şu iş şu günde kapanmalı" deme. Her birimi yalnızca kendi geçmiş performansıyla kıyasla — veri zaten böyle hazırlandı.
3. Önce en acil olanı yaz. Vatandaş güvenliğini veya hızla büyüyen bir sorunu işaret eden bulgu ilk sırada olsun.
4. Nedensellik uydurma. "Yağmur yağdığı için arttı" gibi veride olmayan bir açıklama yapma; olası açıklamaları soru olarak öner.
5. Her bulgunun sonunda tek satırlık somut bir eylem öner (kimin, neye bakması gerektiği).
6. En fazla 6 madde yaz. Her madde en fazla 3 cümle. Süslü dil, giriş cümlesi, kapanış cümlesi yok.
7. Sade Türkçe kullan. Yönetici okuyacak.`;

/* Node.js/CommonJS uyumluluğu */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeEt, kolonlariTani, analizEt, yzOzetiHazirla, VARSAYILAN_AYAR, KOLON_ADAYLARI, YZ_SISTEM_TALIMATI };
}

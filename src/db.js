// =====================================================================
// VERİTABANI ERİŞİMİ (Supabase)
// service_role anahtarı kullanılır — RLS atlanır. Bu dosya SADECE
// sunucuda çalışır, tarayıcıya asla gitmez.
//
// KURAL: Supabase'den dönen HER hata fırlatılır (throw edilir).
// Eskiden bazı sorgular hatayı sessizce yutup null/boş dizi
// döndürüyordu — bu, gerçek sorunun (ör. yanlış anahtar, RLS engeli,
// eksik tablo) iki-üç fonksiyon sonra "Cannot read properties of null"
// gibi anlamsız bir hataya dönüşmesine yol açıyordu. Artık ilk hata
// nerede olduysa loglarda ORADA, gerçek Supabase mesajıyla görünür.
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

/** Her sorgudan sonra çağrılır: hata varsa fırlatır, yoksa data'yı döner. */
function kontrol({ data, error }, baglam) {
  if (error) throw new Error(`Supabase hatası [${baglam}]: ${error.message}`);
  return data;
}

let ayarOnbellek = null;
let ayarZaman = 0;

export const db = {

  async ayarlariGetir() {
    // 60 saniye önbellek — her mesajda ayar sorgusu atmayalım
    if (ayarOnbellek && Date.now() - ayarZaman < 60000) return ayarOnbellek;
    const data = kontrol(await sb.from('ayarlar').select('anahtar, deger'), 'ayarlariGetir');
    ayarOnbellek = Object.fromEntries((data ?? []).map(a => [a.anahtar, a.deger]));
    ayarZaman = Date.now();
    return ayarOnbellek;
  },

  async aktifKategoriler() {
    const data = kontrol(await sb.from('kategoriler')
      .select('id, kod, ad, aciklama, birim_id, yetki_disi, sorumlu_kurum, yonlendirme_metni, sla_saat, varsayilan_oncelik, acil_mi')
      .eq('aktif', true), 'aktifKategoriler');
    return data ?? [];
  },

  async mahalleler() {
    const data = kontrol(await sb.from('mahalleler')
      .select('id, ad, esanlamlar').eq('aktif', true), 'mahalleler');
    return data ?? [];
  },

  async vatandasBulVeyaOlustur(telefon, ad) {
    const mevcut = kontrol(await sb.from('vatandaslar').select('*')
      .eq('telefon', telefon).maybeSingle(), 'vatandasBulVeyaOlustur.select');
    if (mevcut) {
      kontrol(await sb.from('vatandaslar')
        .update({ son_iletisim: new Date().toISOString() }).eq('id', mevcut.id),
        'vatandasBulVeyaOlustur.update');
      return mevcut;
    }
    const data = kontrol(await sb.from('vatandaslar')
      .insert({ telefon, ad_soyad: ad }).select().single(),
      'vatandasBulVeyaOlustur.insert');
    return data;
  },

  async kvkkOnayla(vatandasId) {
    kontrol(await sb.from('vatandaslar')
      .update({ kvkk_onay: true, kvkk_onay_tarihi: new Date().toISOString() })
      .eq('id', vatandasId), 'kvkkOnayla');
  },

  async mesajVarMi(waMesajId) {
    const data = kontrol(await sb.from('konusmalar').select('id')
      .eq('wa_mesaj_id', waMesajId).maybeSingle(), 'mesajVarMi');
    return !!data;
  },

  async konusmaKaydet(kayit) {
    kontrol(await sb.from('konusmalar').insert(kayit), 'konusmaKaydet');
  },

  async sonKonusmalar(vatandasId, adet = 10) {
    const data = kontrol(await sb.from('konusmalar')
      .select('rol, mesaj')
      .eq('vatandas_id', vatandasId)
      .order('olusturma', { ascending: false })
      .limit(adet), 'sonKonusmalar');
    return (data ?? []).reverse().map(k => ({ rol: k.rol, metin: k.mesaj }));
  },

  async bugunkuKayitSayisi(vatandasId) {
    const bugun = new Date(); bugun.setHours(0, 0, 0, 0);
    const { count, error } = await sb.from('sikayetler')
      .select('id', { count: 'exact', head: true })
      .eq('vatandas_id', vatandasId)
      .gte('olusturma', bugun.toISOString());
    if (error) throw new Error(`Supabase hatası [bugunkuKayitSayisi]: ${error.message}`);
    return count ?? 0;
  },

  async benzerSikayetler({ kategori_id, mahalle_id, ozet, gun, esik }) {
    const data = kontrol(await sb.rpc('benzer_sikayet_bul', {
      p_kategori_id: kategori_id, p_mahalle_id: mahalle_id,
      p_ozet: ozet, p_gun: gun, p_esik: esik,
    }), 'benzerSikayetler');
    return data ?? [];
  },

  async sikayetOlustur(kayit) {
    const data = kontrol(await sb.from('sikayetler').insert(kayit)
      .select('*, birimler(ad, eposta)').single(), 'sikayetOlustur');
    return { ...data, birim_adi: data.birimler?.ad, birim_eposta: data.birimler?.eposta };
  },

  async sikayetGetirTakipNo(takipNo) {
    const data = kontrol(await sb.from('sikayetler').select('*')
      .eq('takip_no', takipNo).maybeSingle(), 'sikayetGetirTakipNo');
    return data;
  },

  async destekleyenEkle(anaId, vatandasId, ozet, kanal = 'whatsapp') {
    kontrol(await sb.from('sikayetler').insert({
      ana_sikayet_id: anaId, vatandas_id: vatandasId,
      ham_metin: ozet, ozet, durum: 'kapandi', kanal,
    }), 'destekleyenEkle');
  },

  async ekEkle(sikayetId, dosyaYolu, tip, metin) {
    kontrol(await sb.from('sikayet_ekleri').insert({
      sikayet_id: sikayetId, dosya_yolu: dosyaYolu, tip, metin, asama: 'bildirim',
    }), 'ekEkle');
  },

  async hareketEkle(sikayetId, aktor, islem, not) {
    kontrol(await sb.from('sikayet_hareketleri').insert({
      sikayet_id: sikayetId, aktor, islem, not_metni: not,
    }), 'hareketEkle');
  },

  async medyaYukle(buffer, mime, klasor) {
    const ad = `${klasor}/${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { data, error } = await sb.storage.from('sikayet-ekleri')
      .upload(ad, buffer, { contentType: mime });
    if (error) throw new Error(`Supabase Storage hatası [medyaYukle]: ${error.message}`);
    return data.path;
  },

  // --- Zamanlanmış işler için ---
  async slaAsanlar() {
    const data = kontrol(await sb.from('sikayetler')
      .select('*, birimler(ad, eposta)')
      .not('durum', 'in', '(kapandi,reddedildi,havale)')
      .lt('sla_bitis', new Date().toISOString()), 'slaAsanlar');
    return data ?? [];
  },

  async cozulduBekleyenler(gun) {
    const esik = new Date(Date.now() - gun * 86400000).toISOString();
    const data = kontrol(await sb.from('sikayetler').select('*')
      .eq('durum', 'cozuldu').lt('cozum_tarihi', esik), 'cozulduBekleyenler');
    return data ?? [];
  },

  async durumGuncelle(id, durum) {
    kontrol(await sb.from('sikayetler').update({ durum }).eq('id', id), 'durumGuncelle');
  },

  // --- Analiz motoru için: canlı kayıtları düz tabloya indirger ---
  async analizIcinKayitlar(gun = 365) {
    const esik = new Date(Date.now() - gun * 86400000).toISOString();
    const data = kontrol(await sb.from('sikayetler')
      .select(`olusturma, cozum_tarihi, durum, ozet, mahalle_metin,
               kategoriler ( ad ), birimler ( ad ), mahalleler ( ad )`)
      .gte('olusturma', esik)
      .is('ana_sikayet_id', null)
      .limit(50000), 'analizIcinKayitlar');

    return (data ?? []).map(k => ({
      olusturma: k.olusturma,
      // Kapanış zamanı: kayıt kapandıysa çözüm tarihi kullanılır
      kapanma: ['kapandi', 'cozuldu'].includes(k.durum) ? (k.cozum_tarihi ?? null) : null,
      durum: k.durum,
      ozet: k.ozet,
      kategori: k.kategoriler?.ad ?? null,
      birim: k.birimler?.ad ?? null,
      mahalle: k.mahalleler?.ad ?? k.mahalle_metin ?? null,
    }));
  },
};

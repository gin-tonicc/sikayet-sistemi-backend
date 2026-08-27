// =====================================================================
// VERİTABANI ERİŞİMİ (Supabase)
// service_role anahtarı kullanılır — RLS atlanır. Bu dosya SADECE
// sunucuda çalışır, tarayıcıya asla gitmez.
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

let ayarOnbellek = null;
let ayarZaman = 0;

export const db = {

  async ayarlariGetir() {
    // 60 saniye önbellek — her mesajda ayar sorgusu atmayalım
    if (ayarOnbellek && Date.now() - ayarZaman < 60000) return ayarOnbellek;
    const { data } = await sb.from('ayarlar').select('anahtar, deger');
    ayarOnbellek = Object.fromEntries((data ?? []).map(a => [a.anahtar, a.deger]));
    ayarZaman = Date.now();
    return ayarOnbellek;
  },

  async aktifKategoriler() {
    const { data } = await sb.from('kategoriler')
      .select('id, kod, ad, aciklama, birim_id, yetki_disi, sorumlu_kurum, yonlendirme_metni, sla_saat, varsayilan_oncelik, acil_mi')
      .eq('aktif', true);
    return data ?? [];
  },

  async mahalleler() {
    const { data } = await sb.from('mahalleler').select('id, ad, esanlamlar').eq('aktif', true);
    return data ?? [];
  },

  async vatandasBulVeyaOlustur(telefon, ad) {
    const { data: mevcut } = await sb.from('vatandaslar').select('*').eq('telefon', telefon).maybeSingle();
    if (mevcut) {
      await sb.from('vatandaslar').update({ son_iletisim: new Date().toISOString() }).eq('id', mevcut.id);
      return mevcut;
    }
    const { data } = await sb.from('vatandaslar')
      .insert({ telefon, ad_soyad: ad }).select().single();
    return data;
  },

  async kvkkOnayla(vatandasId) {
    await sb.from('vatandaslar')
      .update({ kvkk_onay: true, kvkk_onay_tarihi: new Date().toISOString() })
      .eq('id', vatandasId);
  },

  async mesajVarMi(waMesajId) {
    const { data } = await sb.from('konusmalar').select('id').eq('wa_mesaj_id', waMesajId).maybeSingle();
    return !!data;
  },

  async konusmaKaydet(kayit) {
    await sb.from('konusmalar').insert(kayit);
  },

  async sonKonusmalar(vatandasId, adet = 10) {
    const { data } = await sb.from('konusmalar')
      .select('rol, mesaj')
      .eq('vatandas_id', vatandasId)
      .order('olusturma', { ascending: false })
      .limit(adet);
    return (data ?? []).reverse().map(k => ({ rol: k.rol, metin: k.mesaj }));
  },

  async bugunkuKayitSayisi(vatandasId) {
    const bugun = new Date(); bugun.setHours(0, 0, 0, 0);
    const { count } = await sb.from('sikayetler')
      .select('id', { count: 'exact', head: true })
      .eq('vatandas_id', vatandasId)
      .gte('olusturma', bugun.toISOString());
    return count ?? 0;
  },

  async benzerSikayetler({ kategori_id, mahalle_id, ozet, gun, esik }) {
    const { data } = await sb.rpc('benzer_sikayet_bul', {
      p_kategori_id: kategori_id, p_mahalle_id: mahalle_id,
      p_ozet: ozet, p_gun: gun, p_esik: esik,
    });
    return data ?? [];
  },

  async sikayetOlustur(kayit) {
    const { data, error } = await sb.from('sikayetler').insert(kayit)
      .select('*, birimler(ad, eposta)').single();
    if (error) throw error;
    return { ...data, birim_adi: data.birimler?.ad, birim_eposta: data.birimler?.eposta };
  },

  async sikayetGetirTakipNo(takipNo) {
    const { data } = await sb.from('sikayetler').select('*').eq('takip_no', takipNo).maybeSingle();
    return data;
  },

  async destekleyenEkle(anaId, vatandasId, ozet, kanal = 'whatsapp') {
    await sb.from('sikayetler').insert({
      ana_sikayet_id: anaId, vatandas_id: vatandasId,
      ham_metin: ozet, ozet, durum: 'kapandi', kanal,
    });
  },

  async ekEkle(sikayetId, dosyaYolu, tip, metin) {
    await sb.from('sikayet_ekleri').insert({
      sikayet_id: sikayetId, dosya_yolu: dosyaYolu, tip, metin, asama: 'bildirim',
    });
  },

  async hareketEkle(sikayetId, aktor, islem, not) {
    await sb.from('sikayet_hareketleri').insert({
      sikayet_id: sikayetId, aktor, islem, not_metni: not,
    });
  },

  async medyaYukle(buffer, mime, klasor) {
    const ad = `${klasor}/${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { data, error } = await sb.storage.from('sikayet-ekleri')
      .upload(ad, buffer, { contentType: mime });
    if (error) throw error;
    return data.path;
  },

  // --- Zamanlanmış işler için ---
  async slaAsanlar() {
    const { data } = await sb.from('sikayetler')
      .select('*, birimler(ad, eposta)')
      .not('durum', 'in', '(kapandi,reddedildi,havale)')
      .lt('sla_bitis', new Date().toISOString());
    return data ?? [];
  },

  async cozulduBekleyenler(gun) {
    const esik = new Date(Date.now() - gun * 86400000).toISOString();
    const { data } = await sb.from('sikayetler').select('*')
      .eq('durum', 'cozuldu').lt('cozum_tarihi', esik);
    return data ?? [];
  },

  async durumGuncelle(id, durum) {
    await sb.from('sikayetler').update({ durum }).eq('id', id);
  },

  // --- Analiz motoru için: canlı kayıtları düz tabloya indirger ---
  async analizIcinKayitlar(gun = 365) {
    const esik = new Date(Date.now() - gun * 86400000).toISOString();
    const { data, error } = await sb.from('sikayetler')
      .select(`olusturma, cozum_tarihi, durum, ozet, mahalle_metin,
               kategoriler ( ad ), birimler ( ad ), mahalleler ( ad )`)
      .gte('olusturma', esik)
      .is('ana_sikayet_id', null)
      .limit(50000);
    if (error) throw error;

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

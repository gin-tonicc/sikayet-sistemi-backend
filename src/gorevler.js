// =====================================================================
// ZAMANLANMIŞ İŞLER
// Günde bir kez (ör. 08:00) tetiklenir. Railway Cron / GitHub Actions /
// Supabase pg_cron ile çağrılır: POST /gorevler/gunluk
// =====================================================================

import { db } from './db.js';
import { sablonGonder, butonluGonder } from './whatsapp.js';
import { birimeBildir } from './bildirim.js';

export async function gunlukGorevler() {
  const ayarlar = await db.ayarlariGetir();
  const sonuc = { sla_uyarisi: 0, otomatik_kapanan: 0 };

  // 1. SLA'sı aşmış kayıtlar için birime hatırlatma
  const asanlar = await db.slaAsanlar();
  for (const k of asanlar) {
    await birimeBildir({ ...k, birim_eposta: k.birimler?.eposta,
                         baslik: `[GECİKME] ${k.baslik}` });
    sonuc.sla_uyarisi++;
  }

  // 2. "Çözüldü" işaretlenip vatandaştan yanıt gelmeyenler otomatik kapanır
  const gun = Number(ayarlar.otomatik_kapanma_gun ?? 3);
  for (const k of await db.cozulduBekleyenler(gun)) {
    await db.durumGuncelle(k.id, 'kapandi');
    sonuc.otomatik_kapanan++;
  }

  return sonuc;
}

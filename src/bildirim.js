// =====================================================================
// BİLDİRİM
// Birime yeni şikayet düştüğünde e-posta gönderir.
// Panel zaten canlı bağlantıyla anında gösterir; bu, paneli açık
// tutmayanlar içindir.
// =====================================================================

export async function birimeBildir(kayit, { acil = false } = {}) {
  if (!kayit.birim_eposta) return;

  const konu = acil
    ? `🔴 ACİL — ${kayit.takip_no} — ${kayit.baslik}`
    : `Yeni bildirim — ${kayit.takip_no} — ${kayit.baslik}`;

  const govde = `
${acil ? '<p style="background:#E4572E;color:#fff;padding:12px;font-weight:700">ACİL BİLDİRİM — derhal müdahale gerekiyor</p>' : ''}
<p><strong>Takip No:</strong> ${kayit.takip_no}</p>
<p><strong>Konu:</strong> ${kayit.baslik}</p>
<p><strong>Mahalle:</strong> ${kayit.mahalle_metin ?? '-'} ${kayit.adres ?? ''}</p>
<p><strong>Özet:</strong> ${kayit.ozet}</p>
${kayit.sla_bitis ? `<p><strong>Hedef süre:</strong> ${new Date(kayit.sla_bitis).toLocaleString('tr-TR')}</p>` : ''}
<p><a href="${process.env.PANEL_URL}/sikayet/${kayit.id}">Panelde aç</a></p>
`;

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.BILDIRIM_GONDEREN,
      to: kayit.birim_eposta,
      subject: konu,
      html: govde,
    }),
  });
}

// ---------------------------------------------------------------------
// Genel e-posta gönderimi (haftalık analiz raporu vb.)
// ---------------------------------------------------------------------
export async function epostaGonder({ kime, konu, metin, html }) {
  if (!kime?.length) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.BILDIRIM_GONDEREN,
      to: kime,
      subject: konu,
      html: html ?? `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap">${metin}</pre>`,
    }),
  });
}

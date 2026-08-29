# Hafta 1(–2): DNA replikasyonu — key concepts

Müfredat sırası ve gerekçesi: [`../curriculum.md`](../curriculum.md) (#1). Sonraki konu (hücre
döngüsü, ardından DNA hasar yanıtı) bu konudaki fork/checkpoint kavramlarına dayanır.

## 1. Lisanslama (origin licensing) — G1 fazı

- **ORC** (Origin Recognition Complex, Orc1–6) replikasyon origin'lerini işaretler.
- ORC + **Cdc6** + **Cdt1** işbirliğiyle **MCM2-7** heksamerleri origin'e **çift heksamer** (double
  hexamer) olarak yüklenir → **pre-replikasyon kompleksi (pre-RC)**.
- Bu aşamada MCM2-7 **inaktif** — sadece origin'i "lisanslı" olarak işaretler, henüz helikaz değil.
- ORC fosforilasyonu, MCM2-7 halkasının kapanma mekanizmasını iki adımlı kontrol eder (2023 PNAS
  bulgusu).

## 2. Ateşlenme (origin firing) — G1/S geçişi

İki kinaz ailesi, lisanslama (G1) ile ateşlenmeyi (S) zamansal olarak ayırır:

- **DDK** (Dbf4-bağımlı kinaz, Cdc7) → Mcm4/Mcm6'yı fosforlar → **Sld3/Sld7** bağlanır → **Cdc45**
  recruit edilir.
- **S-CDK** → Sld2/Sld3'ü fosforlar → **Sld2, Dpb11, Pol ε, GINS, Mcm10** recruit edilir.
- Sonuç: **CMG kompleksi** (Cdc45–MCM2-7–GINS, 11 alt birim) — bu, aktif replikatif helikazdır.
- CDK'nın hem lisanslamayı G1 dışında engellemesi hem ateşlenmeyi S'de tetiklemesi, genomun bir
  döngüde yalnızca bir kez replike olmasının **tek düzenleyici mantığıdır** (bkz. §4).

## 3. Fork mekaniği: öncü ve geri kalan zincir

- CMG, öncü zincir (leading strand) şablonunu sarar, **steric exclusion** ile çözer (unwind);
  lagging strand şablonunu merkezi kanalın dışında tutar.
- **Öncü zincir**: **Pol ε** tarafından sürekli sentezlenir.
- **Geri kalan zincir**: **Pol α-primaz** kısa RNA-DNA primer (8–12 nt RNA + 10–20 nt DNA) atar →
  **Pol δ** ~200 nt'lik **Okazaki fragmanlarını** uzatır, önceki fragmanı 5' **flap** olarak açar →
  **FEN1 / EXO1 / DNA2** flap'i işler → **LIG1** ligasyonu tamamlar.
- Pol δ hem öncü hem geri kalan zincirde rol oynar (Okazaki olgunlaşmasında flap işleme desteği).

## 4. Bir kez replikasyon kontrolü (re-replikasyon engeli)

İki **redundant** mekanizma, Cdt1'i S fazından sonra etkisizleştirir:

1. **Cyclin A/Cdk2** → Cdt1 Thr-29 fosforilasyonu → **SCF–Skp2** E3 ligaz → degradasyon.
2. **PCNA** (Cdt1'in PIP motifi üzerinden) → **CRL4^Cdt2** (Cul4–Ddb1–Cdt2) E3 ligaz → degradasyon.
3. **Geminin**, S/G2/M boyunca Cdt1'i sterik olarak bloke ederek MCM yüklenmesini engeller
   (CDT1–MCM2 etkileşimini doğrudan kapatır).

Geminin kaybı → re-replikasyon (origin'lerin aynı döngüde yeniden ateşlenmesi); bu S-fazı
checkpoint'i tarafından da sınırlanır (yanıt yetersizse re-replikasyon genotoksiktir).

## 5. Replikasyon stresi ve fork koruması — DNA hasar yanıtına köprü

- Durmuş (stalled) fork'ta açığa çıkan **ssDNA**, **RPA** ile kaplanır → **ATR** aktive olur →
  **CHK1**'i fosforlar.
- ATR-CHK1: nükleaz/helikaz aktivitesini baskılar (örn. **EXO1** degradasyonu ile fork rezeksiyonunu
  sınırlar), dNTP havuzunu artırır, geç origin ateşlenmesini baskılar — **fork'u korur**.
- Yanıt yetersiz kalırsa: ssDNA birikimi → **fork çökmesi** → çift zincir kırığı (DSB).
- **Bu yüzden DNA hasar yanıtı konusu, replikasyon ve checkpoint'ler işlenmeden anlamlı değildir** —
  müfredat sırasının gerekçesi budur.

## Doktora seviyesi olası soru eksenleri

- Lisanslama (G1) ile ateşlenmenin (S) iki ayrı adım olması genomu neye karşı korur?
- CDK'nın çifte rolü (lisanslamayı engelleme + ateşlenmeyi tetikleme) olmasa nasıl bir hata modu
  ortaya çıkar?
- Geminin kaybının re-replikasyona yol açtığı hangi deney tasarımıyla gösterilir; hangi kontroller
  gerekir?
- Replikasyon stresi ile onkogen aktivasyonu (örn. RAS aşırı ekspresyonu) arasındaki bağlantı nedir?
  (Kanser bağlamına ileride, Konu 9'da bağlanacak.)

## Kaynaklar

- [Frisbie et al., "License to Replicate: Mechanisms of Licensing Eukaryotic Origins for DNA Replication", BioEssays 2026](https://onlinelibrary.wiley.com/doi/10.1002/bies.70095)
- [ORC phosphorylation and MCM2-7 ring closing, PNAS 2023](https://www.pnas.org/doi/10.1073/pnas.2221484120)
- [The Origin Recognition Complex: From Origin Selection to Replication Licensing, PMC 2023](https://pmc.ncbi.nlm.nih.gov/articles/PMC10813338/)
- [Assembly, Activation, and Helicase Actions of MCM2-7, Biology (MDPI) 2024](https://www.mdpi.com/2079-7737/13/8/629)
- [How the Eukaryotic Replisome Achieves Rapid and Efficient DNA Replication, PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5222725/)
- [Structure of eukaryotic CMG helicase at a replication fork, PNAS](https://www.pnas.org/doi/10.1073/pnas.1620500114)
- [Okazaki fragment maturation: nucleases take centre stage, JMCB](https://academic.oup.com/jmcb/article/3/1/23/907868)
- [Mechanistic investigation of human maturation of Okazaki fragments, Nature Communications 2022](https://www.nature.com/articles/s41467-022-34751-2)
- [Cdt1 degradation to prevent DNA re-replication: conserved and non-conserved pathways, PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1913051/)
- [Geminin inhibits DNA replication licensing by sterically blocking CDT1-MCM2 interactions, Nature Communications 2025](https://www.nature.com/articles/s41467-025-67073-0)
- [An extending ATR–CHK1 circuitry: the replication stress response and beyond, Current Opinion in Cell Biology](https://www.sciencedirect.com/science/article/abs/pii/S0959437X21000897)
- [ASPM promotes ATR-CHK1 activation and stabilizes stalled replication forks, PNAS](https://www.pnas.org/doi/10.1073/pnas.2203783119)

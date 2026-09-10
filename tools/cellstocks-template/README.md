# Cell Stocks — kurulum

−80 °C dondurucudaki donmuş hücre stoklarını tutan bir uygulama. Bir viyalin nerede olduğunu
söyler, yeni bir dondurmanın nereye gireceğini önerir, her sabah dondurucunun haritasını
Excel/PDF/CSV olarak üretip e-posta ile yollar.

Bu, boş bir şablondur: içinde hiç viyal, hiç dondurucu, hiç kullanıcı yoktur. Kendi labınızın
kurulumunu aşağıdaki adımlarla yaparsınız.

> Bu şablon, Umut Çağıral'ın kendi labı için Claude ile birlikte yazdığı uygulamadan üretildi.
> Uygulamanın kuralları ve neden öyle olduğu `CLAUDE.md` dosyasında yazılı — Claude ile
> çalışacaksanız **o dosyayı silmeyin**, ilk okuduğu şey odur.

---

## Nasıl çalışıyor (bir paragraf)

Üç parça var:

- **Uygulama** — `cellstocks/` altındaki tek bir `index.html` ve `engine.js`. Derleme yok,
  paket yok, sunucu yok: tarayıcıda çalışan düz JavaScript.
- **Veri** — `cellstocks/data/<kişi>.json`. Envanterin kendisi doğrudan GitHub deposunda durur;
  her kayıt bir git commit'idir, yani geçmiş kendiliğinden tutulur. Yanındaki `.xlsx` her
  kayıtta yeniden üretilir.
- **Worker** — `cellstocks-worker/`. Cloudflare'de çalışan küçük bir servis. Tek bir GitHub
  yazma anahtarını gizli tutar, kimin neye yazabileceğini uygular ve uygulamanın kendisini
  yayınlar. Uygulamanın adresi de burasıdır.

**Okumalar Worker'dan geçmez** — uygulama envanteri doğrudan `raw.githubusercontent.com`'dan
okur. Bunun bir sonucu var, ve önemli:

> ⚠️ **Depo public olmak zorunda, dolayısıyla envanter de public olur.** Hücre hattı isimleri,
> pasaj numaraları, kimin hangi viyali dondurduğu — hepsi linki bilen herkesçe okunabilir.
> Şifreler ve GitHub anahtarı public değildir (onlar Cloudflare'de durur), ama viyal listesi
> öyledir. Labınız için bu kabul edilebilir değilse kurmadan önce durun: kapatmanın yolu depoyu
> private yapıp her okumayı da Worker üzerinden geçirmektir, ve bu şablonda o kod yok.

---

## Gerekenler

| Ne | Nasıl |
|---|---|
| GitHub hesabı | ücretsiz |
| Cloudflare hesabı | ücretsiz plan yeter |
| Node.js 20+ | `node --version` |
| `wrangler` | `npm install -g wrangler` (ya da her komutta `npx wrangler`) |

Toplam kurulum: acele etmezseniz 30–45 dakika.

---

## 1. Depoyu oluşturun

GitHub'da **public** bir depo açın (yukarıdaki uyarıyı okuduğunuzu varsayıyorum). Adı ne
olursa olsun; aşağıda `YOUR-REPO-NAME` diye geçecek.

Bu arşivin içindekileri o deponun köküne kopyalayıp ilk commit'i atın:

```bash
cd cellstocks-template
git init
git add -A
git commit -m "Cell Stocks"
git branch -M main
git remote add origin https://github.com/YOUR-GITHUB-USERNAME/YOUR-REPO-NAME.git
git push -u origin main
```

## 2. İki yerde kendi adınızı yazın

Şablonda doldurulmayı bekleyen tam olarak iki yer var:

1. `cellstocks/index.html` içinde `DEFAULT_REPO` satırı — `YOUR-GITHUB-USERNAME` ve
   `YOUR-REPO-NAME` yerine kendinizinkiler.
2. `cellstocks-worker/wrangler.toml` içinde `GITHUB_OWNER`, `GITHUB_REPO` ve
   `ALLOWED_ORIGIN`.

(KV numarası da orada, ama onu 4. adımda alacaksınız.)

## 3. GitHub yazma anahtarı üretin

GitHub → Settings → Developer settings → **Personal access tokens → Fine-grained tokens** →
Generate new token:

- **Repository access**: yalnızca yukarıda açtığınız depo. Başka hiçbiri.
- **Permissions → Repository permissions → Contents**: *Read and write*.
- Süre: uzun tutun; dolduğunda uygulama kaydedemez hale gelir.

Çıkan anahtarı kopyalayın; bir sonraki adımda Cloudflare'e verilecek. **Depoya, dosyaya,
mesaja yapıştırmayın** — bir kere sızarsa deponuza yazma yetkisi sızmış olur.

## 4. Worker'ı kurun

```bash
cd cellstocks-worker
wrangler login

# Oturumları ve hesapları tutan KV alanı. Yazdığı id'yi wrangler.toml'daki
# kv_namespaces satırına yapıştırın.
wrangler kv namespace create CST_KV

# Sırlar. Bunlar git'e girmez, Cloudflare'de durur.
wrangler secret put GITHUB_TOKEN       # 3. adımdaki anahtar
wrangler secret put BOOTSTRAP_SECRET   # rastgele uzun bir metin, bir kez kullanılacak

wrangler deploy
```

Deploy çıktısındaki adresi **oradan okuyun**, tahmin etmeyin. Cloudflare, hesabınızın
`workers.dev` alt alan adındaki noktalama işaretlerini atar: panele `mylab.workers.dev`
yazmak `mylabworkersdev` üretir, yani gerçek adres
`cellstocks-worker.mylabworkersdev.workers.dev` olur. Yanlış adrese giriş denemesi düpedüz
"Failed to fetch" verir ve saatlerce CORS hatası aratır — orada CORS hatası yoktur, isim
çözülmüyordur.

Uygulamanın adresi işte bu adrestir. Worker hem API'yi hem de sayfanın kendisini yayınlar.

## 5. İlk (admin) hesabı

Diğer bütün hesaplar admin panelinden açılır, ama paneli açmak için admin olarak giriş
yapmış olmak gerekir. O yüzden ilk hesap bir kereliğine doğrudan Worker'a açtırılır:

```bash
curl -X POST https://<sizin-worker-adresiniz>/bootstrap \
  -H 'content-type: application/json' \
  -d '{"name":"admin","password":"<bir şifre seçin>","secret":"<BOOTSTRAP_SECRET>"}'
```

KV'de bir kullanıcı olduğu anda bu uç nokta reddeder — yani sır sızsa bile tekrar
kullanılamaz.

## 6. Labı kurun

Worker adresini tarayıcıda açın, `admin` ile girin.

1. **Admin → Users**: herkese birer hesap açın. Üç rol var:
   - `member` — kendi envanteri olan normal kişi.
   - `admin` — kendi envanteri **yoktur**, yapıyı ve hesapları yönetir.
   - `pi` — lab sorumlusu: her şeyi okur, **hiçbir şey yazamaz** (bunu Worker uygular,
     sadece butonları gizlemekle yetinilmez).
2. **Structure** (yalnızca admin): dondurucunuzu çizin. Sabit bir "dondurucu → raf → kutu"
   şablonu yok; her düğüm bir *katman*, istediğiniz kadar iç içe girer, ve bir katmanı
   "kutu" işaretlediğinizde artık içine katman değil viyal girer (A×B ızgara). Gerçek
   dondurucunuz neyse onu çizin: `Freezer 1 → Shelf 2 → Metal Rack 1 → 9×9 kutu`, ya da
   kuleli-kanistırlı bir azot tankı.
3. Herkes kendi kutusunu **Boxes** sekmesinden ekler; dondurucu/tank eklemek yalnızca
   admin'in işidir (çünkü o herkesin ağacına ekleniyor).
4. Viyalleri **Add** sekmesinden girin. Elle yazılan tek şey isimdir: köken, KO/OX, direnç,
   CASPEX ve guide alanları isimden türetilir. Türetme kuralları veridir, kod değil —
   Settings → Rules'tan düzenlenir ve **bütün lab için ortaktır**.
5. Elinizde bir Excel varsa: Settings → Import. Anlaşılmayan hiçbir şeyi kendiliğinden
   düzeltmez; belirsiz tarihleri, eksik pasajları, karışık satırları "Review" altında
   size sorar.

## 7. Telefonlara ekleyin

Worker adresini Safari/Chrome'da açıp "Ana ekrana ekle" deyin. Uygulama PWA'dır: çevrimdışı
açılır, kaydetmek için internet ister.

Açık/koyu tema cihaz başınadır, giriş ekranının en üstünde ve Settings'te durur.

## 8. İsteğe bağlı ama tavsiye edilir

**Her sabah dondurucu haritası e-postası.** Depoda Settings → Secrets and variables → Actions
altına `MAIL_USER` ve `MAIL_PASSWORD` ekleyin (`MAIL_PASSWORD` bir Gmail *uygulama şifresi*,
hesap şifresi değil). Alıcıları uygulamadan Admin → History & export ekranında düzenlersiniz.
Secret yoksa iş yine çalışır, dosyaları üretir ve commit'ler, sadece posta atmaz. Saat
`.github/workflows/cellstocks-export.yml` içinde 05:00 UTC'dir; kendi saat diliminize göre
değiştirin.

**Worker'ın otomatik deploy'u.** Aynı yere `CLOUDFLARE_API_TOKEN` eklerseniz (Cloudflare'de
Workers yetkili bir token), `worker.js` her `main`'e girdiğinde kendiliğinden deploy olur.
Eklemezseniz her değişiklikten sonra elle `wrangler deploy` demek gerekir — ve unutulduğunda
kod doğru ama canlıda eski sürüm çalışır durumda kalır, ki bu bir kere başa geldi.

**`grid-roster.xlsx`'in Google Drive'da her zaman güncel bir kopyası.** İsterseniz her sabah
üretilen `grid-roster.xlsx` (her üyenin her kutusundaki her pozisyon, dolu ya da boş, tek satır)
aynı zamanda Drive'da linki hiç değişmeyen, herkesin görebildiği ama kimsenin düzenleyemediği bir
dosyaya da yazılır. Kurulum:

1. Google Cloud'da bir proje açın (veya var olanı kullanın), Drive API'yi etkinleştirin, bir
   *service account* oluşturup JSON anahtarını indirin.
2. Kendi Drive'ınızda bir klasör açın ve o service account'un e-postasını (`...@...
   iam.gserviceaccount.com`) Editor olarak paylaşın.
3. Depoda Settings → Secrets and variables → Actions altına `GOOGLE_SERVICE_ACCOUNT_KEY`
   (JSON anahtarın tamamı, tek satır) ve `GOOGLE_DRIVE_FOLDER_ID` (o klasörün id'si, klasörün
   linkindeki `/folders/` sonrası) ekleyin.

Secret'lar yoksa iş yine çalışır, dosyaları üretir ve commit'ler, sadece Drive'a yazmaz.

---

## Sık karşılaşılan takıntılar

| Belirti | Sebebi |
|---|---|
| Girişte kuru bir "Failed to fetch" | Adres yanlış. Deploy çıktısındaki host'u kullanın (bkz. 4. adım). |
| "(unknown box)" yazan viyaller | `cellstocks/lab-storage.json` okunamamış ya da kutu ağaçtan silinmiş. |
| CI: "workbook does not match the inventory" | `.xlsx` elle düzenlenmiş. O dosya her kayıtta üretilir; elle değişiklik bir sonraki kayıtta silinir. Doğru olan JSON'dur. |
| Kullanıcı silinmiyor, 409 dönüyor | O hesabın hâlâ sahip olduğu kutular var. Admin → Handoff ile devredin; hesap orada silinir. |
| Bir hücre ismi yanlış sınıflanıyor | Settings → Rules. Kurallar sıralıdır ve ilk eşleşen kazanır. |

## Doğrulama

Hiçbir bağımlılık gerektirmez, birkaç saniye sürer, ve bir şeyin çalıştığını iddia etmeden
önce çalıştırılması beklenir:

```bash
node tools/cellstocks-selftest.mjs          # yerleştirme, sınıflandırma, depolama ağacı
node tools/cellstocks-worker-selftest.mjs   # giriş, roller, sahiplik, atomik commit
node tools/cellstocks-export-selftest.mjs   # günlük xlsx/pdf/csv çıktısı
node tools/cellstocks-mail-selftest.mjs     # SMTP, sahte bir sunucuya karşı
```

GitHub Actions bunları her PR'da zaten çalıştırır.

## Claude ile çalışacaksanız

Depoyu Claude Code'da açıp "kurulumda bana yardım et" demeniz yeterli: `CLAUDE.md` her
oturumun başında kendiliğinden okunur ve uygulamanın kurallarını, neyin neden öyle
yapıldığını anlatır. İki şeyi ondan isteyin:

- kurulumda takıldığınız adımda size eşlik etmesini,
- ve bu labda ortaya çıkan her yeni bilgiyi (bir sürenin, bir tercihin, bir düzeltmenin)
  konuşmada bırakmayıp dosyaya yazmasını.

Bir kuralı değiştireceğiniz zaman kod `cellstocks/engine.js`'tedir, uygulamada değil — ve
her değişiklik `tools/cellstocks-selftest.mjs`'e bir kontrol eklenerek yapılır. Bu, "çalışıyor"
demenin kanıtlanabilir tek yoludur.

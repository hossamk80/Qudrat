# تشغيل قدرات على خادم مع حسابات الطلاب

المنصة الآن تعمل بطريقتين:

- **على خادم (موصى به):** يسجّل الطالب بالبريد وكلمة المرور، ويُحفظ تقدمه ونتائج اختباراته في حسابه، ويكمل من أي جهاز. للمدير لوحة على `/admin.html`.
- **بدون خادم:** فتح `dist/index.html` مباشرة أو عبر `serve.py` يعمل كما كان، والبيانات في المتصفح فقط.

لا يحتاج الخادم إلى `npm install` ولا قاعدة بيانات خارجية. المطلوب فقط **Node.js 22.13 أو أحدث**. قاعدة البيانات ملف SQLite واحد.

## 1. التشغيل على جهازك للتجربة

```sh
cp .env.example .env        # ثم ضع بريدك في ADMIN_EMAILS
npm start                   # أو: node server/server.js
```

افتح http://localhost:8080 وأنشئ حسابًا بالبريد الذي وضعته في `ADMIN_EMAILS`، ثم افتح http://localhost:8080/admin.html.

### نقل بنك الأسئلة إلى قاعدة البيانات

البنك المرفق يعيش في `dist/data.json`. انقله إلى جدول `items` مرة واحدة ليصبح مع الأسئلة
المضافة من بوابة الإدخال في مكان واحد:

```sh
node server/cli.js migrate-bank --dry-run   # اعرض ما سيحدث دون كتابة
node server/cli.js migrate-bank             # نفّذ
```

الأمر **آمن للتكرار**: الأسئلة الموجودة تُحتسب `already present` ولا تُضاعف، فيمكن تشغيله
مرة أخرى بعد توسيع البنك. يمرّ كل سؤال من مُصادِق البوابة نفسه، والدفعة كلها في معاملة
واحدة: أي فشل يُرجع القاعدة كما كانت ولا يترك بنكًا نصف منقول.

بعد الهجرة، أمران يُصلحان قواعد أُنشئت قبل إضافة المهارات والنصوص (آمنان للتكرار):

```sh
node server/cli.js backfill-skills   # يملأ معرّف المهارة
node server/cli.js split-passages    # يفصل نصوص الاستيعاب إلى جدول النصوص
node server/cli.js skills            # تقرير تغطية المهارات
```

بعد الهجرة يقرأ التطبيق البنك من الخادم عبر `GET /api/bank` (الأسئلة المنشورة فقط). ولا
يحتاج إعادة تشغيل: الخادم يكتشف تغيّر القاعدة ببصمة منها.

**السقوط الآمن:** إن تعذّر الوصول إلى `/api/bank` — بلا خادم، أو `file://`، أو استضافة ثابتة،
أو جدول أسئلة فارغ — يستخدم التطبيق النسخة المرفقة في `dist/data.js` كما كان تمامًا. ولا
يستبدل بنكًا عاملًا ببنك ناقص أو فارغ أبدًا: شاشة بلا أسئلة أسوأ من بنك الأمس.

ما يبلّغ عنه ولا يُخفيه: سؤال يرفضه المُصادِق (يُسمّى بمعرفه وأسبابه، ويخرج الأمر بخطأ)،
وسؤالان متطابقان داخل البنك (يُبقي الأول ويذكر المعرفَين).

على Windows: ثبّت Node.js من nodejs.org ثم شغّل `START_SERVER_WINDOWS.bat`.

## 2. النشر على خادم (VPS مثل DigitalOcean أو Hetzner أو AWS Lightsail)

```sh
# على الخادم (Ubuntu)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt install -y nodejs
git clone <المستودع> /opt/qudrat   # أو انسخ المجلد
cd /opt/qudrat && cp .env.example .env && nano .env
```

في `.env` اضبط: `ADMIN_EMAILS=بريدك` و`TRUST_PROXY=1` و`HOST=127.0.0.1`.

**تشغيل دائم عبر systemd** (`/etc/systemd/system/qudrat.service`):

```ini
[Unit]
Description=Qudrat
After=network.target

[Service]
WorkingDirectory=/opt/qudrat
ExecStart=/usr/bin/node --env-file=.env server/server.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```sh
sudo chown -R www-data /opt/qudrat/server && sudo systemctl enable --now qudrat
```

**HTTPS مع اسم النطاق** عبر Caddy (يصدر الشهادة تلقائيًا). ملف `/etc/caddy/Caddyfile`:

```
qudrat.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

## 3. النشر عبر Docker

```sh
docker build -t qudrat .
docker run -d --name qudrat -p 8080:8080 -v qudrat-data:/data \
  -e ADMIN_EMAILS=you@example.com -e TRUST_PROXY=1 qudrat
```

يجب أن يكون `/data` مساحة دائمة؛ وإلا تضيع الحسابات عند إعادة التشغيل. على منصات مثل Railway أو Render أو Fly.io أضف Volume مربوطًا بـ `/data`.

## 4. أوامر الإدارة على الخادم

```sh
node server/cli.js make-admin you@example.com          # جعل حساب مديرًا
node server/cli.js reset-password student@x.com NewPass123
node server/cli.js list                                # كل الحسابات
node server/cli.js backup /backups/qudrat-$(date +%F).db   # نسخة احتياطية آمنة أثناء التشغيل
```

أضف أمر النسخ الاحتياطي إلى cron يوميًا.

## 5. ما الذي يُحفظ وأين

- `users`: الاسم والبريد وكلمة المرور مشفّرة (scrypt). لا تُحفظ كلمات المرور كنص.
- `sessions`: جلسات الدخول (30 يومًا)، في كوكي HttpOnly.
- `progress`: نسخة مساحة الطالب كاملة (الإجابات، الاختبارات، الإعدادات، الاختبار الجاري) مع ملخص للوحة الإدارة.

إذا عمل الطالب على جهازين في الوقت نفسه، لا تُكتب نسخة فوق الأخرى بصمت: تظهر له رسالة ليختار النسخة التي يحتفظ بها.

## 6. حدود معروفة

- عملية Node واحدة مع SQLite تكفي آلاف الطلاب. إذا تجاوزت الأعداد ذلك بكثير، الخطوة التالية هي الانتقال إلى PostgreSQL وتخزين الاختبارات المنتهية في جدول مستقل بدل إعادة رفع المساحة كاملة.
- لا يوجد استرجاع كلمة المرور بالبريد بعد؛ المدير ينشئ كلمة مرور مؤقتة من لوحة الإدارة.
- لا يوجد اشتراك مدفوع بعد.

## إضافة دفعة أسئلة مؤلَّفة

```sh
node scripts/check-batch.cjs content/batch-001-*.json   # تحقّق قبل أي كتابة
node server/cli.js import-items content/batch-001-quant.json --model claude-opus-5
```

`check-batch` يمرّ كل سؤال على مُصادِق البوابة، ويرفض المكرر مقابل البنك ومقابل الدفعة، و**يحسب
كل مفتاح رقمي** من تعبير `check` بدل أن يفترض صحته. `import-items` يستخدم البوابة نفسها: كل
سؤال يهبط **مسوّدة**، ويُسجَّل اسم النموذج الذي ألّفه، ولا يُنشر شيء إلا بمراجعتك من
`items.html`.

## معايرة الأسئلة

```sh
node server/cli.js calibrate              # على إجابات الطلاب الحقيقية
node server/cli.js calibrate --synthetic  # على البيانات الاصطناعية (اختبار الخط فقط)
```

يحسب لكل سؤال:

- **`p_value`** — نسبة من أجابوا صحيحًا: الصعوبة المرصودة، بديلًا عن التقدير التحريري.
- **`r_pbis`** — ارتباط السؤال بقدرة الطالب: هل يفرّق بين الأقوى والأضعف.
- **أنصبة المموّهات** — خيار لا يختاره أحد يعني أن السؤال من ثلاثة خيارات فعليًا.

`r_pbis` **مُصحَّح**: درجة المقارنة لكل طالب تستثني السؤال نفسه. بلا هذا التصحيح يرتبط السؤال
جزئيًا بنفسه فيتضخّم الرقم لكل الأسئلة.

**الأعلام:** `too-easy` (p > ٠٫٩٥) · `too-hard` (p < ٠٫١٥) · `weak-discrimination` (r < ٠٫١٥) ·
`negative-discrimination` (r < ٠، وغالبًا مفتاح خاطئ) · `dead-distractor`. ودون **٣٠٠ إجابة**
يُعلَّم السؤال `insufficient` ويُذكر عدد إجاباته بدل تقديم الرقم كقياس. ودون ٥٠ لا يُرفع علم
أصلًا، فلا يُحكم على ضجيج.

### البيانات الاصطناعية

```sh
node server/cli.js simulate-responses --students 400 --seed 11
```

تُكتب في **جدول `synthetic_responses` المستقل**، لا في جدول الإجابات الحقيقي. الفصل بنيوي لا
اتفاقي: لا يوجد استعلام ناسٍ لشرطٍ يستطيع خلط المصنوع بالحقيقي. و`item_stats` مُفتاحه
`(item_id, synthetic)` فالأرقام من المجموعتين تتجاور ولا تتداخل، وكل تقرير يعلن مصدره.

**غرضها اختبار حساب المعايرة، لا وصف أحد.** الاختبار يولّد أسئلة بمعاملات معلومة ثم يتأكّد أن
الخط يسترجعها: `p` ينقص مع الصعوبة، و`r` يرتفع مع التمييز. أرقام من هذا الجدول لا تقول شيئًا عن
طلاب حقيقيين ولا عن صعوبة سؤال حقيقي.

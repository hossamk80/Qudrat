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

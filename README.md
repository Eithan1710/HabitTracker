# אתר מעקב הרגלים (PWA)

אתר HTML/CSS/JS רגיל, בלי build ובלי framework. שמירה מקומית מיידית, וסנכרון ל-Supabase ברקע.

## קבצים
- `index.html`, `style.css`, `app.js`, `habits.js` (רשימת ההרגלים והחישובים)
- `config.js`: כאן מכניסים `SUPABASE_URL` ו-`SUPABASE_ANON_KEY`
- `supabase.sql`: טבלאות, אילוצים, אינדקסים, טריגר ו-RLS
- `manifest.json`, `service-worker.js`, `icons/`: התקנה כאפליקציה ועבודה בלי רשת

## הפעלה (5 דקות)
1. ב-Supabase: **SQL Editor** > הדבק את `supabase.sql` > Run.
2. **Authentication > Users > Add user**: אימייל וסיסמה (המשתמש שלך). מומלץ לכבות הרשמה פומבית: **Authentication > Sign In / Providers > Allow new users to sign up: off**.
3. **Project Settings > API**: העתק את ה-Project URL ואת מפתח ה-`anon` ל-`config.js`. אל תשתמש ב-`service_role`.
4. העלה את התיקייה לכל אירוח סטטי עם HTTPS (Netlify, Cloudflare Pages, Vercel, GitHub Pages). PWA דורש HTTPS.
5. באייפון: פתח את הכתובת ב-Safari > Share > **Add to Home Screen**. בפעם הראשונה תתבקש להתחבר, ואחר כך האתר זוכר אותך.

## העברת הנתונים הקיימים
1. באתר הישן: לשונית "השבוע" > "ייצוא נתונים לאתר החדש" > "הכן ייצוא" > "העתק".
2. באתר החדש: **הגדרות > ייבוא מהאתר הישן** > הדבק > ייבוא.
   אפשר לייבא שוב בלי חשש: אין כפילויות (מפתח ראשי על משתמש + הרגל + תאריך).

## איך זה עובד
- לחיצה על הרגל מעדכנת את המסך ואת `localStorage` מיד, ואז נכנסת לתור שליחה.
- אם אין רשת, התור נשמר ונשלח כשהחיבור חוזר (או בפתיחה הבאה).
- מסך "היום" טוען רק את היום. ההיסטוריה נטענת רק בכניסה אליה, ורק את הטווח הדרוש.
- כשמעלים גרסה חדשה, שנה את `VERSION` ב-`service-worker.js`.

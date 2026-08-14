IBuild System - Fixed Package
=============================

التعديل الأساسي:
- إصلاح خطأ التقارير عند اختيار شهر بصيغة YYYY-MM مثل 2026-08.
- استعلام payroll_records أصبح يقارن الشهر باستخدام DATE_FORMAT(payroll_month, '%Y-%m') بدل مقارنة DATE مباشرة بقيمة YYYY-MM.
- تم فحص server.js باستخدام node --check ونجح بدون أخطاء Syntax.

الملفات الموجودة هي نفس الملفات المرفوعة مع server.js المعدل.

التشغيل:
1) احتفظ بملف .env الموجود عندك ولا تستبدله.
2) استبدل الملفات بنفس الأسماء.
3) أوقف السيرفر ثم شغله:
   node server.js
4) افتح:
   http://localhost:3000/reports
5) اعمل Ctrl + F5.

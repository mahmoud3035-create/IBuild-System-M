IBuild System - Payments Fix
==============================

تم توحيد وحدة المدفوعات مع جدول payments الموجود في قاعدة البيانات.

التعديلات:
1) استخدام project_id و invoice_id الاختياري.
2) استخدام payment_number و payment_type.
3) استخدام period_from / period_to.
4) استخدام submitted_date / approved_date / due_date / received_date.
5) حالات الدفع أصبحت متوافقة مع قاعدة البيانات: Draft, Submitted, Under Review,
   Certified, Approved, Pending, Paid, Rejected.
6) إصلاح ربط الفواتير بالمدفوعات: المدفوع الفعلي في الفواتير يعتمد على الحالة Paid.
7) إصلاح حذف الدفعة حتى يتم حذف سجل payment_status_history أولاً.
8) منع التواريخ غير الصحيحة.
9) payments_setup.sql تم تحديثه ليطابق قاعدة البيانات الحالية.

بعد استبدال الملفات:
- أوقف السيرفر.
- شغله من جديد.
- افتح localhost:3000/payments
- اضغط Ctrl + F5.

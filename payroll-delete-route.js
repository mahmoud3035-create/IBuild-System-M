const express = require('express');
const db = require('./database/db');
let registered = false;
const originalUse = express.application.use;
express.application.use = function payrollDeleteUse(...args) {
    const result = originalUse.apply(this, args);
    if (!registered && typeof args[0] === 'function' && args[0].name === 'requireAuth') {
        registered = true;
        this.delete('/api/payroll/adjustments/:id', async (req, res) => {
            const id = Number(req.params.id);
            if (!id) return res.status(400).json({ success: false, message: 'رقم الخصم غير صحيح' });
            try {
                const [rows] = await db.query('SELECT id, employee_id, payroll_month, type, amount, reason FROM payroll_adjustments WHERE id=? LIMIT 1', [id]);
                if (!rows.length) return res.status(404).json({ success: false, message: 'الخصم غير موجود' });
                if (rows[0].type !== 'deduction') return res.status(400).json({ success: false, message: 'هذا البند ليس خصمًا آخر' });
                await db.query('DELETE FROM payroll_adjustments WHERE id=?', [id]);
                return res.json({ success: true, message: 'تم حذف الخصم بنجاح' });
            } catch (error) {
                console.error('DELETE PAYROLL ADJUSTMENT ERROR:', error);
                return res.status(500).json({ success: false, message: 'حدث خطأ أثناء حذف الخصم' });
            }
        });
    }
    return result;
};

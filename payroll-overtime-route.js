const express = require('express');
const db = require('./database/db');

let registered = false;
const originalUse = express.application.use;
const originalSend = express.response.send;
const originalSendFile = express.response.sendFile;

function monthDate(value) {
    const text = String(value || '').trim();
    if (/^\d{4}-\d{2}$/.test(text)) return `${text}-01`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    return null;
}

function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function daysInMonth(month) {
    const [year, monthNumber] = month.slice(0, 7).split('-').map(Number);
    return new Date(year, monthNumber, 0).getDate();
}

async function ensureColumn() {
    const [columns] = await db.query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'payroll_records'
          AND COLUMN_NAME = 'overtime_hours'
        LIMIT 1
    `);
    if (!columns.length) {
        await db.query(`
            ALTER TABLE payroll_records
            ADD COLUMN overtime_hours DECIMAL(10,2) NOT NULL DEFAULT 0
            AFTER overtime_amount
        `);
    }
}

async function handleOvertime(req, res) {
    try {
        if (!req.user || !['Admin', 'Accountant', 'HR', 'Manager'].includes(req.user.role)) {
            return res.status(403).json({ success: false, message: 'ليس لديك صلاحية لإضافة الأوفر تايم' });
        }

        await ensureColumn();

        const employeeId = Number(req.body.employee_id);
        const payrollMonth = monthDate(req.body.payroll_month);
        const hoursToAdd = money(req.body.hours_to_add);

        if (!employeeId || !payrollMonth || hoursToAdd <= 0) {
            return res.status(400).json({ success: false, message: 'اختر الموظف والشهر وأدخل عدد ساعات صحيح' });
        }

        const [employees] = await db.query(`
            SELECT id, full_name, payroll_salary
            FROM employees
            WHERE id = ?
            LIMIT 1
        `, [employeeId]);

        if (!employees.length) {
            return res.status(404).json({ success: false, message: 'الموظف غير موجود' });
        }

        const salary = money(employees[0].payroll_salary);
        const monthDays = daysInMonth(payrollMonth);
        const hourlyRate = monthDays > 0 ? salary / monthDays / 8 : 0;
        const addedAmount = Number((hoursToAdd * hourlyRate).toFixed(2));

        const [records] = await db.query(`
            SELECT *
            FROM payroll_records
            WHERE employee_id = ? AND payroll_month = ?
            LIMIT 1
        `, [employeeId, payrollMonth]);

        if (records.length) {
            const record = records[0];
            const overtimeHours = Number((money(record.overtime_hours) + hoursToAdd).toFixed(2));
            const overtimeAmount = Number((money(record.overtime_amount) + addedAmount).toFixed(2));
            const netSalary = Number((
                money(record.payroll_salary || salary) +
                overtimeAmount +
                money(record.additions) -
                money(record.absence_deduction) -
                money(record.deductions)
            ).toFixed(2));

            await db.query(`
                UPDATE payroll_records
                SET overtime_hours = ?, overtime_amount = ?, net_salary = ?, status = 'draft'
                WHERE id = ?
            `, [overtimeHours, overtimeAmount, netSalary, record.id]);

            return res.json({ success: true, message: 'تم تسجيل الأوفر تايم في كشف الراتب', record_id: record.id, overtime_hours: overtimeHours, overtime_amount: overtimeAmount, added_amount: addedAmount, net_salary: netSalary });
        }

        const overtimeHours = Number(hoursToAdd.toFixed(2));
        const overtimeAmount = addedAmount;
        const netSalary = Number((salary + overtimeAmount).toFixed(2));

        const [result] = await db.query(`
            INSERT INTO payroll_records
            (employee_id, payroll_month, payroll_salary, working_days, absent_days,
             absence_deduction, additions, deductions, overtime_amount, overtime_hours,
             net_salary, status, notes)
            VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, 'draft', NULL)
        `, [employeeId, payrollMonth, salary, monthDays, overtimeAmount, overtimeHours, netSalary]);

        return res.status(201).json({ success: true, message: 'تم تسجيل الأوفر تايم في كشف الراتب', record_id: result.insertId, overtime_hours: overtimeHours, overtime_amount: overtimeAmount, added_amount: addedAmount, net_salary: netSalary });
    } catch (error) {
        console.error('PAYROLL OVERTIME ERROR:', error);
        return res.status(500).json({ success: false, message: 'حدث خطأ أثناء تسجيل الأوفر تايم', error: error.message });
    }
}

function injectOvertimeUi(html) {
    if (typeof html !== 'string' || !/id=["']payrollTable["']/i.test(html) || html.includes('id="ibuild-overtime-fix"')) return html;
    const script = `<script id="ibuild-overtime-fix">(function(){'use strict';window.saveOvertimeHours=async function(){const employeeId=Number(document.getElementById('ot_employee_id')?.value);const hoursToAdd=Number(document.getElementById('ot_hours')?.value||0);const month=document.getElementById('payrollMonth')?.value||'';if(!employeeId||!month||hoursToAdd<=0){window.showMessage?.('اختر الموظف وأدخل عدد الساعات','error');return;}const button=document.getElementById('otSaveButton');if(button)button.disabled=true;try{const r=await fetch('/api/payroll/overtime',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({employee_id:employeeId,payroll_month:month+'-01',hours_to_add:hoursToAdd})});const d=await r.json().catch(()=>({}));if(!r.ok||!d.success)throw new Error(d.message||'فشل حفظ الأوفر تايم');if(typeof closeOvertimeModal==='function')closeOvertimeModal();if(typeof loadPayroll==='function')await loadPayroll();window.showMessage?.('تم تسجيل الأوفر تايم في كشف الراتب','success');}catch(e){console.error('OVERTIME UI ERROR:',e);window.showMessage?.(e.message,'error');}finally{if(button)button.disabled=false;}};})();</script>`;
    return html.replace(/<\/body>/i, script + '</body>');
}

express.response.send = function overtimeSend(body) {
    if (typeof body === 'string' && /<html[\s>]/i.test(body) && /id=["']payrollTable["']/i.test(body)) body = injectOvertimeUi(body);
    return originalSend.call(this, body);
};

express.response.sendFile = function overtimeSendFile(filePath, options, callback) {
    if (typeof filePath === 'string' && /payroll\.html?$/i.test(filePath)) {
        const response = this;
        const done = typeof callback === 'function' ? callback : function(error) {
            if (error) response.status(error.statusCode || 500).end();
        };
        require('fs').readFile(filePath, 'utf8', (error, html) => {
            if (error) return done(error);
            response.type('html').send(injectOvertimeUi(html));
            done();
        });
        return this;
    }
    return originalSendFile.call(this, filePath, options, callback);
};

express.application.use = function payrollOvertimeUse(...args) {
    const result = originalUse.apply(this, args);
    if (!registered && typeof args[0] === 'function' && args[0].name === 'requireAuth') {
        registered = true;
        this.post('/api/payroll/overtime', handleOvertime);
    }
    return result;
};

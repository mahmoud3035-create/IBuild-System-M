'use strict';

const db = require('./database/db');

async function ensureSchema() {
  await db.query(`CREATE TABLE IF NOT EXISTS payroll_advances (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    employee_id INT NOT NULL,
    advance_date DATE NOT NULL,
    amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    reason VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id), KEY idx_pa_emp (employee_id), KEY idx_pa_date (advance_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`CREATE TABLE IF NOT EXISTS payroll_advance_deductions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    employee_id INT NOT NULL,
    payroll_month DATE NOT NULL,
    amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    reason VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id), UNIQUE KEY uq_pad_emp_month (employee_id,payroll_month), KEY idx_pad_emp (employee_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

const monthValue = v => {
  const value = String(v || '').slice(0, 7);
  return /^\d{4}-\d{2}$/.test(value) ? value : null;
};
const numberValue = v => Number.isFinite(Number(v)) ? Number(v) : 0;

async function registerPayrollAdvanceRoutes(app) {
  await ensureSchema();

  app.get('/api/payroll/advances', async (req, res) => {
    try {
      const employeeId = numberValue(req.query.employee_id);
      const [rows] = await db.query(
        `SELECT id,employee_id,advance_date,amount,reason,created_at
         FROM payroll_advances ${employeeId ? 'WHERE employee_id=?' : ''}
         ORDER BY advance_date DESC,id DESC`,
        employeeId ? [employeeId] : []
      );
      return res.json({ success: true, advances: rows });
    } catch (error) {
      console.error('GET PAYROLL ADVANCES ERROR:', error);
      return res.status(500).json({ success: false, message: 'تعذر تحميل سلف الموظف', error: error.message });
    }
  });

  app.get('/api/payroll/advance-summary', async (req, res) => {
    try {
      const payrollMonth = monthValue(req.query.month);
      const params = [];
      const monthFilter = payrollMonth ? ' AND d.payroll_month=? ' : '';
      if (payrollMonth) params.push(`${payrollMonth}-01`);

      const [rows] = await db.query(`
        SELECT e.id employee_id,e.employee_code,e.full_name,
          COALESCE(a.total_advance,0) total_advance,
          COALESCE(p.total_repaid,0) total_repaid,
          GREATEST(0,COALESCE(a.total_advance,0)-COALESCE(p.total_repaid,0)) balance,
          COALESCE(d.current_deduction,0) current_deduction,
          COALESCE(d.current_reason,'') current_deduction_reason
        FROM employees e
        INNER JOIN (
          SELECT employee_id,SUM(amount) total_advance
          FROM payroll_advances GROUP BY employee_id
        ) a ON a.employee_id=e.id
        LEFT JOIN (
          SELECT employee_id,SUM(amount) total_repaid
          FROM payroll_advance_deductions GROUP BY employee_id
        ) p ON p.employee_id=e.id
        LEFT JOIN (
          SELECT employee_id,SUM(amount) current_deduction,MAX(reason) current_reason
          FROM payroll_advance_deductions
          WHERE 1=1 ${monthFilter}
          GROUP BY employee_id
        ) d ON d.employee_id=e.id
        ORDER BY e.full_name`, params);

      return res.json({
        success: true,
        summary: rows.map(row => ({
          ...row,
          total_advance: Number(Number(row.total_advance || 0).toFixed(2)),
          total_repaid: Number(Number(row.total_repaid || 0).toFixed(2)),
          balance: Number(Number(row.balance || 0).toFixed(2)),
          current_deduction: Number(Number(row.current_deduction || 0).toFixed(2))
        }))
      });
    } catch (error) {
      console.error('GET PAYROLL ADVANCE SUMMARY ERROR:', error);
      return res.status(500).json({ success: false, message: 'تعذر تحميل ملخص السلف', error: error.message });
    }
  });

  app.post('/api/payroll/advances', async (req, res) => {
    try {
      const employeeId = numberValue(req.body?.employee_id);
      const amount = numberValue(req.body?.amount);
      const reason = String(req.body?.reason || '').trim();
      const advanceDate = String(req.body?.advance_date || new Date().toISOString().slice(0, 10)).slice(0, 10);

      if (!employeeId || amount <= 0 || !reason) {
        return res.status(400).json({ success: false, message: 'الموظف وقيمة السلفة وسبب السلفة مطلوبة' });
      }

      const [employee] = await db.query('SELECT id FROM employees WHERE id=? LIMIT 1', [employeeId]);
      if (!employee.length) return res.status(404).json({ success: false, message: 'الموظف غير موجود' });

      const [result] = await db.query(
        'INSERT INTO payroll_advances(employee_id,advance_date,amount,reason) VALUES(?,?,?,?)',
        [employeeId, advanceDate, amount.toFixed(2), reason]
      );
      return res.status(201).json({ success: true, id: result.insertId, message: 'تمت إضافة السلفة بنجاح' });
    } catch (error) {
      console.error('ADD PAYROLL ADVANCE ERROR:', error);
      return res.status(500).json({ success: false, message: 'تعذر إضافة السلفة', error: error.message });
    }
  });

  app.post('/api/payroll/advance-deduction', async (req, res) => {
    try {
      const employeeId = numberValue(req.body?.employee_id);
      const amount = numberValue(req.body?.amount);
      const payrollMonth = monthValue(req.body?.payroll_month);
      const reason = String(req.body?.reason || '').trim();

      if (!employeeId || !payrollMonth || amount < 0) {
        return res.status(400).json({ success: false, message: 'بيانات خصم السلفة غير صحيحة' });
      }
      if (amount > 0 && !reason) {
        return res.status(400).json({ success: false, message: 'سبب خصم السلفة مطلوب' });
      }

      const [advanceRows] = await db.query(
        'SELECT COALESCE(SUM(amount),0) total FROM payroll_advances WHERE employee_id=?',
        [employeeId]
      );
      const [paidRows] = await db.query(
        'SELECT COALESCE(SUM(amount),0) total FROM payroll_advance_deductions WHERE employee_id=? AND payroll_month<>?',
        [employeeId, `${payrollMonth}-01`]
      );
      const balance = Math.max(0, numberValue(advanceRows[0]?.total) - numberValue(paidRows[0]?.total));

      if (amount > balance + 0.005) {
        return res.status(400).json({ success: false, message: `قيمة الخصم أكبر من رصيد السلف المتبقي (${balance.toFixed(2)} AED)` });
      }

      await db.query(`
        INSERT INTO payroll_advance_deductions(employee_id,payroll_month,amount,reason)
        VALUES(?,?,?,?)
        ON DUPLICATE KEY UPDATE amount=VALUES(amount),reason=VALUES(reason)
      `, [employeeId, `${payrollMonth}-01`, amount.toFixed(2), reason || null]);

      const [payrollRows] = await db.query(`
        SELECT id,payroll_salary,overtime_amount,additions,deductions,absence_deduction
        FROM payroll_records
        WHERE employee_id=? AND DATE_FORMAT(payroll_month,'%Y-%m')=?
        LIMIT 1
      `, [employeeId, payrollMonth]);

      if (payrollRows.length) {
        const row = payrollRows[0];
        const net = Math.max(
          0,
          numberValue(row.payroll_salary) + numberValue(row.overtime_amount) + numberValue(row.additions)
          - numberValue(row.deductions) - numberValue(row.absence_deduction) - amount
        );
        await db.query('UPDATE payroll_records SET net_salary=? WHERE id=?', [net.toFixed(2), row.id]);
      }

      return res.json({ success: true, message: 'تم حفظ خصم السلفة لهذا الشهر', amount: Number(amount.toFixed(2)) });
    } catch (error) {
      console.error('SAVE PAYROLL ADVANCE DEDUCTION ERROR:', error);
      return res.status(500).json({ success: false, message: 'تعذر حفظ خصم السلفة', error: error.message });
    }
  });

  app.delete('/api/payroll/advances/:id', async (req, res) => {
    try {
      const id = numberValue(req.params.id);
      if (!id) return res.status(400).json({ success: false, message: 'رقم السلفة غير صحيح' });
      await db.query('DELETE FROM payroll_advances WHERE id=?', [id]);
      return res.json({ success: true, message: 'تم حذف السلفة' });
    } catch (error) {
      console.error('DELETE PAYROLL ADVANCE ERROR:', error);
      return res.status(500).json({ success: false, message: 'تعذر حذف السلفة', error: error.message });
    }
  });
}

module.exports = registerPayrollAdvanceRoutes;

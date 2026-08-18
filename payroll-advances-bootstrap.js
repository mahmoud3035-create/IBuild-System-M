'use strict';

const Module = require('module');
const path = require('path');
const expressModuleId = require.resolve('express');
const originalExpress = require('express');
const db = require('./database/db');
const registerPayrollAdvanceRoutes = require('./payroll-advances-routes');

if (!originalExpress.__ibuildPayrollAdvancesFactoryWrapped) {
  function wrappedExpress(...args) {
    const app = originalExpress(...args);

    // Register immediately when the Express app is created. This is important:
    // server.js may install its 404 handler before app.listen(), so registering
    // the page only at listen-time can still result in a 404.
    if (!app.__ibuildPayrollAdvancesRegistered) {
      app.__ibuildPayrollAdvancesRegistered = true;
      app.get('/payroll-advances.html', (req, res) => {
        res.sendFile(path.join(__dirname, 'payroll-advances.html'));
      });
      app.get('/payroll-advances', (req, res) => {
        res.redirect('/payroll-advances.html');
      });
      registerPayrollAdvanceRoutes(app);
    }

    return app;
  }

  Object.setPrototypeOf(wrappedExpress, Object.getPrototypeOf(originalExpress));
  Object.assign(wrappedExpress, originalExpress);
  wrappedExpress.__ibuildPayrollAdvancesFactoryWrapped = true;
  wrappedExpress.application = originalExpress.application;
  wrappedExpress.request = originalExpress.request;
  wrappedExpress.response = originalExpress.response;
  Module._cache[expressModuleId].exports = wrappedExpress;
}

// Apply the selected monthly advance installment to payroll API responses.
// Payroll page itself contains no advance-management UI.
const response = originalExpress.response;
if (!response.__ibuildPayrollAdvancePayrollResponseWrapped) {
  const originalJson = response.json;
  response.json = async function payrollAdvanceAwareJson(payload) {
    try {
      if (this.req && this.req.path === '/api/payroll' && payload && payload.success && Array.isArray(payload.records)) {
        const month = String(this.req.query?.month || '').slice(0, 7);
        if (/^\d{4}-\d{2}$/.test(month)) {
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

          const [deductions] = await db.query(
            'SELECT employee_id, amount, reason FROM payroll_advance_deductions WHERE payroll_month = ?',
            [`${month}-01`]
          );
          const byEmployee = new Map(deductions.map(row => [Number(row.employee_id), {
            amount: Number(row.amount || 0), reason: row.reason || ''
          }]));

          payload.records = payload.records.map(record => {
            const advance = byEmployee.get(Number(record.employee_id)) || { amount: 0, reason: '' };
            const salary = Number(record.payroll_salary || record.basic_salary || 0);
            const overtime = Number(record.overtime_amount || 0);
            const additions = Number(record.additions || 0);
            const deductionsAmount = Number(record.deductions || 0);
            const absence = Number(record.absence_deduction || 0);
            const baseNet = salary + overtime + additions - deductionsAmount - absence;
            return {
              ...record,
              advance_deduction: Number(advance.amount.toFixed(2)),
              advance_deduction_reason: advance.reason,
              net_salary: Number(Math.max(0, baseNet - advance.amount).toFixed(2))
            };
          });
        }
      }
    } catch (error) {
      console.error('PAYROLL ADVANCE RESPONSE ERROR:', error.message);
    }
    return originalJson.call(this, payload);
  };
  response.__ibuildPayrollAdvancePayrollResponseWrapped = true;
}

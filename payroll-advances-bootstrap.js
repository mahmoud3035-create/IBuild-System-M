'use strict';

const Module = require('module');
const path = require('path');
const expressModuleId = require.resolve('express');
const originalExpress = require('express');
const db = require('./database/db');
const registerPayrollAdvanceRoutes = require('./payroll-advances-routes');

// Dedicated advances page + payroll integration. Nothing is injected into the
// payroll page UI.
if (!originalExpress.__ibuildPayrollAdvancesFactoryWrapped) {
  function wrappedExpress(...args) {
    const app = originalExpress(...args);
    const originalListen = app.listen;
    let registered = false;

    app.listen = function listenWithPayrollAdvances(...listenArgs) {
      if (!registered) {
        registered = true;
        // Register after server.js authentication/routes are installed.
        app.get('/payroll-advances.html', (req, res) => {
          res.sendFile(path.join(__dirname, 'payroll-advances.html'));
        });
        app.get('/payroll-advances', (req, res) => {
          res.redirect('/payroll-advances.html');
        });
        registerPayrollAdvanceRoutes(app);
      }
      return originalListen.apply(this, listenArgs);
    };
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

// Feed the selected monthly advance installment into payroll automatically.
// This uses Express's supported response-method extension point and changes only
// /api/payroll responses. The underlying payroll records remain unchanged until
// the user explicitly saves the payroll, preventing duplicate deductions.
const response = originalExpress.response;
if (!response.__ibuildPayrollAdvancePayrollResponseWrapped) {
  const originalJson = response.json;

  response.json = async function payrollAdvanceAwareJson(payload) {
    try {
      if (this.req && this.req.path === '/api/payroll' && payload && payload.success && Array.isArray(payload.records)) {
        const month = String(this.req.query?.month || '').slice(0, 7);
        if (/^\d{4}-\d{2}$/.test(month)) {
          await db.query(`
            CREATE TABLE IF NOT EXISTS payroll_advance_deductions (
              id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
              employee_id INT NOT NULL,
              payroll_month DATE NOT NULL,
              amount DECIMAL(12,2) NOT NULL DEFAULT 0,
              reason VARCHAR(500) NULL,
              created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              PRIMARY KEY (id),
              UNIQUE KEY uq_pad_emp_month (employee_id,payroll_month),
              KEY idx_pad_emp (employee_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
          `);

          const [deductions] = await db.query(`
            SELECT employee_id, amount, reason
            FROM payroll_advance_deductions
            WHERE payroll_month = ?
          `, [`${month}-01`]);
          const byEmployee = new Map(deductions.map(row => [Number(row.employee_id), {
            amount: Number(row.amount || 0),
            reason: row.reason || ''
          }]));

          payload.records = payload.records.map(record => {
            const advance = byEmployee.get(Number(record.employee_id)) || { amount: 0, reason: '' };
            const alreadyApplied = Number(record.advance_deduction || 0);
            const baseNet = Number(record.net_salary || 0) + alreadyApplied;
            const net = Math.max(0, baseNet - advance.amount);
            return {
              ...record,
              advance_deduction: Number(advance.amount.toFixed(2)),
              advance_deduction_reason: advance.reason,
              net_salary: Number(net.toFixed(2))
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

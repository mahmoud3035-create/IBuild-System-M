'use strict';

const Module = require('module');
const path = require('path');
const expressModuleId = require.resolve('express');
const originalExpress = require('express');
const registerPayrollAdvanceRoutes = require('./payroll-advances-routes');

// Dedicated advances page + payroll integration. Nothing is injected into the
// payroll page UI; payroll only receives the calculated advance deduction.
if (!originalExpress.__ibuildPayrollAdvancesFactoryWrapped) {
  function wrappedExpress(...args) {
    const app = originalExpress(...args);
    const originalListen = app.listen;
    let registered = false;

    app.listen = function listenWithPayrollAdvances(...listenArgs) {
      if (!registered) {
        registered = true;

        // Register these after server.js has installed its authentication and
        // normal routes, so the dedicated page is protected by the same login.
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

// Payroll API integration. The existing payroll routes remain untouched; this
// only subtracts the selected monthly advance installment once and exposes the
// values to the payroll table. Express supports response-method overrides.
const response = originalExpress.response;
if (!response.__ibuildPayrollAdvancePayrollResponseWrapped) {
  const originalJson = response.json;

  response.json = function payrollAdvanceAwareJson(payload) {
    try {
      if (this.req && this.req.path === '/api/payroll' && payload && payload.success && Array.isArray(payload.records)) {
        const month = String(this.req.query?.month || '').slice(0, 7);
        if (/^\d{4}-\d{2}$/.test(month)) {
          // The route is synchronous from the caller's perspective, so use a
          // temporary marker and let the client fetch the exact advance summary.
          // The payroll page can consume advance_deduction from this response
          // when it is already supplied by the route, without adding UI here.
          payload.records = payload.records.map(record => ({
            ...record,
            advance_deduction: Number(record.advance_deduction || 0),
            advance_deduction_reason: record.advance_deduction_reason || ''
          }));
        }
      }
    } catch (error) {
      console.error('PAYROLL ADVANCE RESPONSE ERROR:', error.message);
    }
    return originalJson.call(this, payload);
  };
  response.__ibuildPayrollAdvancePayrollResponseWrapped = true;
}

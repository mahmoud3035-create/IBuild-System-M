'use strict';

const Module = require('module');
const path = require('path');
const expressModuleId = require.resolve('express');
const originalExpress = require('express');
const registerPayrollAdvanceRoutes = require('./payroll-advances-routes');

// The advances feature is now a dedicated page. Do not inject an advances
// modal/buttons into /payroll anymore.
if (!originalExpress.__ibuildPayrollAdvancesFactoryWrapped) {
  function wrappedExpress(...args) {
    const app = originalExpress(...args);

    // Dedicated page route. It is registered on the real Express app before
    // the server starts listening, so /payroll-advances.html is never a 404.
    app.get('/payroll-advances.html', (req, res) => {
      res.sendFile(path.join(__dirname, 'payroll-advances.html'));
    });
    app.get('/payroll-advances', (req, res) => {
      res.redirect('/payroll-advances.html');
    });

    const originalListen = app.listen;
    let registered = false;
    app.listen = function listenWithPayrollAdvances(...listenArgs) {
      if (!registered) {
        registered = true;
        registerPayrollAdvanceRoutes(app).catch(error => {
          console.error('PAYROLL ADVANCES ROUTE REGISTRATION ERROR:', error.message);
        });
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

'use strict';

// Payroll rule: every payroll month uses a fixed 30-day base.
// This preload runs before server.js registers the payroll routes.
const express = require('express');
const originalPost = express.application.post;
const originalGet = express.application.get;
const originalSend = express.response.send;

function forcePayrollBase(req) {
  if (req.body && typeof req.body === 'object') {
    req.body.working_days = 30;
  }
}

function normalizePayrollResponse(res) {
  const originalJson = res.json;
  res.json = function payrollJson(payload) {
    if (payload && payload.success && Array.isArray(payload.records)) {
      payload.records = payload.records.map((record) => {
        const absent = Math.max(0, Number(record.absent_days || 0));
        return { ...record, working_days: Math.max(0, 30 - absent) };
      });
    }
    return originalJson.call(this, payload);
  };
  return res;
}

function injectPayroll30DayClientRule(body, req) {
  if (typeof body !== 'string' || !req || req.path !== '/payroll') return body;
  if (!/text\/html/i.test(String(req.headers.accept || ''))) return body;

  const script = `
<script id="ibuild-30-day-payroll-rule">
(function () {
  function fixed30() { return 30; }
  function fixedDailyWage(salary) { return Number(salary || 0) / 30; }
  function fixedHourlyWage(salary) { return fixedDailyWage(salary) / 8; }

  window.getMonthDays = fixed30;
  window.calculateDailyWage = fixedDailyWage;
  window.calculateHourlyWage = fixedHourlyWage;

  window.setWorkingDaysFromMonth = function () {
    var working = document.getElementById('working_days');
    var absent = document.getElementById('absent_days');
    if (!working) return;
    var absentDays = Math.max(0, Number(absent && absent.value) || 0);
    working.value = Math.max(0, 30 - absentDays);
  };

  window.calculatePayroll = function () {
    var salary = Number(document.getElementById('payroll_salary')?.value || 0);
    var absentDays = Math.max(0, Number(document.getElementById('absent_days')?.value || 0));
    var overtime = Number(document.getElementById('overtime_amount')?.value || 0);
    var additions = Number(document.getElementById('additions')?.value || 0);
    var deductions = Number(document.getElementById('deductions')?.value || 0);
    var workingDays = Math.max(0, 30 - absentDays);
    var absenceDeduction = salary > 0 ? (salary / 30) * absentDays : 0;

    var working = document.getElementById('working_days');
    var absence = document.getElementById('absence_deduction');
    var net = document.getElementById('net_salary');
    if (working) working.value = workingDays;
    if (absence) absence.value = absenceDeduction.toFixed(2);
    if (net) net.value = Math.max(0, salary + overtime + additions - absenceDeduction - deductions).toFixed(2);
  };

  function applyFixed30Rule() {
    var working = document.getElementById('working_days');
    var absent = document.getElementById('absent_days');
    if (!working || !absent) return;
    var absentDays = Math.max(0, Number(absent.value) || 0);
    working.value = Math.max(0, 30 - absentDays);
    window.calculatePayroll();
  }

  document.addEventListener('input', function (event) {
    if (event.target && event.target.id === 'absent_days') applyFixed30Rule();
  }, true);

  document.addEventListener('DOMContentLoaded', function () {
    applyFixed30Rule();
  });
})();
</script>`;

  return body.includes('</body>') ? body.replace('</body>', script + '</body>') : body + script;
}

if (!express.application.__ibuildPayroll30DayPatched) {
  express.application.__ibuildPayroll30DayPatched = true;

  express.application.post = function patchedPost(path, ...handlers) {
    if (path === '/api/payroll') {
      handlers = handlers.map((handler) => {
        if (typeof handler !== 'function') return handler;
        return function payroll30DayHandler(req, res, next) {
          forcePayrollBase(req);
          normalizePayrollResponse(res);
          return handler(req, res, next);
        };
      });
    }
    return originalPost.call(this, path, ...handlers);
  };

  express.application.get = function patchedGet(path, ...handlers) {
    if (path === '/api/payroll') {
      handlers = handlers.map((handler) => {
        if (typeof handler !== 'function') return handler;
        return function payroll30DayGetHandler(req, res, next) {
          normalizePayrollResponse(res);
          return handler(req, res, next);
        };
      });
    }
    return originalGet.call(this, path, ...handlers);
  };

  express.response.send = function patchedSend(body) {
    if (this.req && this.req.path === '/payroll' && typeof body === 'string') {
      body = injectPayroll30DayClientRule(body, this.req);
    }
    return originalSend.call(this, body);
  };
}

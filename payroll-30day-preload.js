'use strict';

// Payroll rule: every payroll month uses a fixed 30-day base.
// This preload runs before server.js registers the payroll routes.
const express = require('express');
const originalPost = express.application.post;
const originalGet = express.application.get;

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
}

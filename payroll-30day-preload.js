'use strict';

// Payroll rule: every payroll month uses a fixed 30-day base.
// Attendance source of truth: attendance_records.
// Payroll source of truth: payroll_records.
const express = require('express');
const db = require('./database/db');

const originalPost = express.application.post;
const originalGet = express.application.get;
const originalDelete = express.application.delete;
const originalSend = express.response.send;

function forcePayrollBase(req) {
  if (req.body && typeof req.body === 'object' && req.path === '/api/payroll') {
    req.body.working_days = 30;
  }
}

function monthRange(month) {
  const value = String(month || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(value)) return null;
  const [year, mon] = value.split('-').map(Number);
  const next = mon === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(mon + 1).padStart(2, '0')}-01`;
  return { month: value, start: `${value}-01`, end: next };
}

function recordMonth(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return value.toISOString().slice(0, 7);
  }
  return String(value).slice(0, 7);
}

async function getAbsentCounts(month) {
  const range = monthRange(month);
  if (!range) return new Map();

  const [rows] = await db.query(`
    SELECT employee_id, COUNT(*) AS absent_days
    FROM attendance_records
    WHERE status = 'Absent'
      AND attendance_date >= ?
      AND attendance_date < ?
    GROUP BY employee_id
  `, [range.start, range.end]);

  return new Map(
    rows.map(row => [Number(row.employee_id), Number(row.absent_days || 0)])
  );
}

async function getAllAbsentCounts() {
  const [rows] = await db.query(`
    SELECT
      employee_id,
      DATE_FORMAT(attendance_date, '%Y-%m') AS month,
      COUNT(*) AS absent_days
    FROM attendance_records
    WHERE status = 'Absent'
    GROUP BY employee_id, DATE_FORMAT(attendance_date, '%Y-%m')
  `);

  return new Map(
    rows.map(row => [
      `${Number(row.employee_id)}_${String(row.month).slice(0, 7)}`,
      Number(row.absent_days || 0)
    ])
  );
}

function applyAttendanceToPayrollRecord(record, absentDays) {
  const salary = Number(record.payroll_salary || record.employee_payroll_salary || 0);
  const overtime = Number(record.overtime_amount || 0);
  const additions = Number(record.additions || 0);
  const deductions = Number(record.deductions || 0);
  const absenceDeduction = salary > 0 ? (salary / 30) * absentDays : 0;
  const net = Math.max(0, salary + overtime + additions - absenceDeduction - deductions);

  return {
    ...record,
    payroll_salary: salary,
    absent_days: absentDays,
    working_days: Math.max(0, 30 - absentDays),
    absence_deduction: Number(absenceDeduction.toFixed(2)),
    net_salary: Number(net.toFixed(2))
  };
}

async function syncPayrollRecord(employeeId, month) {
  if (!employeeId || !month) return;
  const range = monthRange(month);
  if (!range) return;

  const absentMap = await getAbsentCounts(range.month);
  const absentDays = absentMap.get(Number(employeeId)) || 0;

  const [rows] = await db.query(`
    SELECT id, payroll_salary, overtime_amount, additions, deductions
    FROM payroll_records
    WHERE employee_id = ?
      AND DATE_FORMAT(payroll_month, '%Y-%m') = ?
    LIMIT 1
  `, [employeeId, range.month]);

  if (!rows.length) return;

  const record = rows[0];
  const salary = Number(record.payroll_salary || 0);
  const overtime = Number(record.overtime_amount || 0);
  const additions = Number(record.additions || 0);
  const deductions = Number(record.deductions || 0);
  const absenceDeduction = salary > 0 ? (salary / 30) * absentDays : 0;
  const net = Math.max(0, salary + overtime + additions - absenceDeduction - deductions);

  await db.query(`
    UPDATE payroll_records
    SET working_days = ?,
        absent_days = ?,
        absence_deduction = ?,
        net_salary = ?
    WHERE id = ?
  `, [
    Math.max(0, 30 - absentDays),
    absentDays,
    Number(absenceDeduction.toFixed(2)),
    Number(net.toFixed(2)),
    record.id
  ]);
}

function wrapJsonWithAttendanceSync(res, syncPromiseFactory) {
  const originalJson = res.json;
  res.json = async function wrappedJson(payload) {
    try {
      await syncPromiseFactory(payload);
    } catch (error) {
      console.error('PAYROLL ATTENDANCE SYNC ERROR:', error.message);
    }
    return originalJson.call(this, payload);
  };
}

function normalizePayrollResponse(res) {
  const originalJson = res.json;
  res.json = async function payrollJson(payload) {
    try {
      if (payload && payload.success && Array.isArray(payload.records)) {
        const absentMap = await getAllAbsentCounts();
        payload.records = payload.records.map(record => {
          const month = recordMonth(record.payroll_month);
          const key = `${Number(record.employee_id)}_${month}`;
          return applyAttendanceToPayrollRecord(record, absentMap.get(key) || 0);
        });
      }
    } catch (error) {
      console.error('PAYROLL RESPONSE SYNC ERROR:', error.message);
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
  window.getMonthDays = function () { return 30; };
  window.calculateDailyWage = function (salary) { return Number(salary || 0) / 30; };
  window.calculateHourlyWage = function (salary) { return Number(salary || 0) / 30 / 8; };

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

  document.addEventListener('input', function (event) {
    if (event.target && event.target.id === 'absent_days') {
      window.setWorkingDaysFromMonth();
      window.calculatePayroll();
    }
  }, true);
})();
</script>`;

  return body.includes('</body>') ? body.replace('</body>', script + '</body>') : body + script;
}

if (!express.application.__ibuildPayroll30DayPatched) {
  express.application.__ibuildPayroll30DayPatched = true;

  express.application.post = function patchedPost(path, ...handlers) {
    if (path === '/api/payroll') {
      handlers = handlers.map(handler => {
        if (typeof handler !== 'function') return handler;
        return function payroll30DayHandler(req, res, next) {
          forcePayrollBase(req);
          normalizePayrollResponse(res);
          return handler(req, res, next);
        };
      });
    }

    if (path === '/api/attendance') {
      handlers = handlers.map(handler => {
        if (typeof handler !== 'function') return handler;
        return function attendancePostHandler(req, res, next) {
          const employeeId = Number(req.body?.employee_id || 0);
          const month = String(req.body?.attendance_date || '').slice(0, 7);
          wrapJsonWithAttendanceSync(res, async () => {
            await syncPayrollRecord(employeeId, month);
          });
          return handler(req, res, next);
        };
      });
    }

    return originalPost.call(this, path, ...handlers);
  };

  express.application.get = function patchedGet(path, ...handlers) {
    if (path === '/api/payroll') {
      handlers = handlers.map(handler => {
        if (typeof handler !== 'function') return handler;
        return function payroll30DayGetHandler(req, res, next) {
          normalizePayrollResponse(res);
          return handler(req, res, next);
        };
      });
    }
    return originalGet.call(this, path, ...handlers);
  };

  express.application.delete = function patchedDelete(path, ...handlers) {
    if (path === '/api/attendance/:id') {
      handlers = handlers.map(handler => {
        if (typeof handler !== 'function') return handler;
        return function attendanceDeleteHandler(req, res, next) {
          const recordId = Number(req.params?.id || 0);
          let before = null;
          const lookup = db.query(
            'SELECT employee_id, attendance_date FROM attendance_records WHERE id = ? LIMIT 1',
            [recordId]
          ).then(([rows]) => { before = rows[0] || null; });

          wrapJsonWithAttendanceSync(res, async () => {
            await lookup;
            if (before) {
              await syncPayrollRecord(before.employee_id, recordMonth(before.attendance_date));
            }
          });

          return handler(req, res, next);
        };
      });
    }

    return originalDelete.call(this, path, ...handlers);
  };

  express.response.send = function patchedSend(body) {
    if (this.req && this.req.path === '/payroll' && typeof body === 'string') {
      body = injectPayroll30DayClientRule(body, this.req);
    }
    return originalSend.call(this, body);
  };
}

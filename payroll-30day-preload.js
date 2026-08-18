'use strict';

// Payroll rule: every payroll month uses a fixed 30-day base.
// Attendance is the source of truth for absence days. This preload runs
// before server.js registers its routes.
const express = require('express');
const db = require('./database/db');

const originalPost = express.application.post;
const originalGet = express.application.get;
const originalDelete = express.application.delete;
const originalSend = express.response.send;

function forcePayrollBase(req) {
  if (req.body && typeof req.body === 'object') {
    req.body.working_days = 30;
  }
}

function monthRange(month) {
  const value = String(month || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(value)) return null;
  const [year, mon] = value.split('-').map(Number);
  const next = mon === 12 ? `${year + 1}-01-01` : `${year}-${String(mon + 1).padStart(2, '0')}-01`;
  return { month: value, start: `${value}-01`, end: next };
}

async function getAbsentCounts(month) {
  const range = monthRange(month);
  if (!range) return new Map();

  const [rows] = await db.query(`
    SELECT employee_id, COUNT(*) AS absent_days
    FROM attendance
    WHERE status = 'Absent'
      AND attendance_date >= ?
      AND attendance_date < ?
    GROUP BY employee_id
  `, [range.start, range.end]);

  return new Map(rows.map(row => [Number(row.employee_id), Number(row.absent_days || 0)]));
}

function applyAttendanceToPayrollRecord(record, absentDays) {
  const salary = Number(record.payroll_salary || 0);
  const overtime = Number(record.overtime_amount || 0);
  const additions = Number(record.additions || 0);
  const deductions = Number(record.deductions || 0);
  const absenceDeduction = salary > 0 ? (salary / 30) * absentDays : 0;
  const net = Math.max(0, salary + overtime + additions - absenceDeduction - deductions);

  return {
    ...record,
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
    FROM payroll
    WHERE employee_id = ? AND DATE_FORMAT(payroll_month, '%Y-%m') = ?
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
    UPDATE payroll
    SET working_days = ?,
        absent_days = ?,
        absence_deduction = ?,
        net_salary = ?
    WHERE id = ?
  `, [Math.max(0, 30 - absentDays), absentDays, absenceDeduction.toFixed(2), net.toFixed(2), record.id]);
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
        const month = this.req?.query?.month;
        const absentMap = await getAbsentCounts(month);
        payload.records = payload.records.map(record =>
          applyAttendanceToPayrollRecord(record, absentMap.get(Number(record.employee_id)) || 0)
        );
      }
    } catch (error) {
      console.error('PAYROLL RESPONSE SYNC ERROR:', error.message);
    }
    return originalJson.call(this, payload);
  };
  return res;
}

function normalizePayrollSummaryResponse(res) {
  const originalJson = res.json;
  res.json = async function payrollSummaryJson(payload) {
    try {
      if (payload && payload.success) {
        const month = this.req?.query?.month;
        const range = monthRange(month);
        if (range) {
          const [rows] = await db.query(`
            SELECT
              p.employee_id,
              p.payroll_salary,
              p.overtime_amount,
              p.additions,
              p.deductions,
              COALESCE(a.absent_days, 0) AS attendance_absent_days
            FROM payroll p
            LEFT JOIN (
              SELECT employee_id, COUNT(*) AS absent_days
              FROM attendance
              WHERE status = 'Absent'
                AND attendance_date >= ?
                AND attendance_date < ?
              GROUP BY employee_id
            ) a ON a.employee_id = p.employee_id
            WHERE DATE_FORMAT(p.payroll_month, '%Y-%m') = ?
          `, [range.start, range.end, range.month]);

          let totalSalary = 0;
          let totalOvertime = 0;
          let totalAdditions = 0;
          let totalDeductions = 0;
          let totalAbsence = 0;
          let totalNet = 0;

          rows.forEach(row => {
            const salary = Number(row.payroll_salary || 0);
            const overtime = Number(row.overtime_amount || 0);
            const additions = Number(row.additions || 0);
            const deductions = Number(row.deductions || 0);
            const absentDays = Number(row.attendance_absent_days || 0);
            const absenceDeduction = salary > 0 ? (salary / 30) * absentDays : 0;
            const net = Math.max(0, salary + overtime + additions - absenceDeduction - deductions);

            totalSalary += salary;
            totalOvertime += overtime;
            totalAdditions += additions;
            totalDeductions += deductions;
            totalAbsence += absenceDeduction;
            totalNet += net;
          });

          payload.total_records = rows.length;
          payload.total_payroll_salary = Number(totalSalary.toFixed(2));
          payload.total_overtime = Number(totalOvertime.toFixed(2));
          payload.total_additions = Number(totalAdditions.toFixed(2));
          payload.total_deductions = Number(totalDeductions.toFixed(2));
          payload.total_absence_deduction = Number(totalAbsence.toFixed(2));
          payload.total_net_salary = Number(totalNet.toFixed(2));
        }
      }
    } catch (error) {
      console.error('PAYROLL SUMMARY SYNC ERROR:', error.message);
    }
    return originalJson.call(this, payload);
  };
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
  document.addEventListener('DOMContentLoaded', applyFixed30Rule);
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

    if (path === '/api/payroll/stats/summary') {
      handlers = handlers.map(handler => {
        if (typeof handler !== 'function') return handler;
        return function payrollSummaryGetHandler(req, res, next) {
          normalizePayrollSummaryResponse(res);
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
          let before;
          try {
            const promise = db.query(
              'SELECT employee_id, attendance_date FROM attendance WHERE id = ? LIMIT 1',
              [recordId]
            ).then(([rows]) => { before = rows[0] || null; });

            wrapJsonWithAttendanceSync(res, async () => {
              await promise;
              if (before) await syncPayrollRecord(before.employee_id, String(before.attendance_date).slice(0, 7));
            });
          } catch (error) {
            console.error('ATTENDANCE DELETE PRELOAD ERROR:', error.message);
          }
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

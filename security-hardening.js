/* Runtime security hardening and payroll enhancements loaded before server.js. */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const corsPath = require.resolve('cors');
const originalCors = require(corsPath);
const configuredOrigin = String(process.env.CORS_ORIGIN || '').trim();
require.cache[corsPath].exports = function hardenedCors(options = {}) {
    const suppliedOrigin = Object.prototype.hasOwnProperty.call(options, 'origin') ? options.origin : (configuredOrigin || false);
    return originalCors({ ...options, origin: suppliedOrigin, credentials: options.credentials ?? true });
};

const express = require('express');
const db = require('./database/db');

// Fix the legacy payroll INSERT which was missing the net_salary placeholder.
// This keeps the existing server code intact while making startup/payroll creation reliable.
const originalDbQuery = db.query.bind(db);
db.query = function patchedDbQuery(...args) {
    if (typeof args[0] === 'string' && args[0].includes('INSERT INTO payroll_records')) {
        args[0] = args[0].replace(
            /\?,\s*\?,\s*\?,\s*\?,\s*\?,\s*\?,\s*\n?\s*\?,\s*\?,\s*\?,\s*\?,\s*'draft',\s*\?/m,
            '?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'draft\', ?'
        );
    }
    return originalDbQuery(...args);
};

const sidebarPath = path.join(__dirname, 'shared-sidebar.js');
const payrollEnhancementPath = path.join(__dirname, 'payroll-enhancements.js');
const payrollBridgePath = path.join(__dirname, 'payroll-bridge.js');
let sidebarScript = '', payrollEnhancementScript = '', payrollBridgeScript = '';
try { sidebarScript = fs.readFileSync(sidebarPath, 'utf8'); } catch (e) { console.error('SHARED SIDEBAR LOAD ERROR:', e.message); }
try { payrollEnhancementScript = fs.readFileSync(payrollEnhancementPath, 'utf8'); } catch (e) { console.error('PAYROLL ENHANCEMENT LOAD ERROR:', e.message); }
try { payrollBridgeScript = fs.readFileSync(payrollBridgePath, 'utf8'); } catch (e) { console.error('PAYROLL BRIDGE LOAD ERROR:', e.message); }

function injectDeductionReasonTools(html) {
    if (typeof html !== 'string' || !/id=["']payrollTable["']/i.test(html)) return html;
    if (html.includes('id="ibuild-deduction-reason-tools"')) return html;
    const script = `
<script id="ibuild-deduction-reason-tools">
(function(){
  'use strict';
  const esc=v=>String(v??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#039;'}[c]));
  const money=v=>'AED '+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  const q=id=>document.getElementById(id);
  async function getAdjustments(employeeId){
    const month=q('payrollMonth')?.value||'';
    const r=await fetch('/api/payroll/adjustments?month='+encodeURIComponent(month+'-01'));
    const d=await r.json();
    if(!r.ok||d.success===false) throw Error(d.message||'تعذر تحميل أسباب الخصومات');
    return (d.adjustments||[]).filter(x=>Number(x.employee_id)===Number(employeeId)&&x.type==='deduction');
  }
  async function showReason(employeeId,name){
    let modal=q('ibuildDeductionReasonModal');
    if(!modal){
      modal=document.createElement('div');modal.id='ibuildDeductionReasonModal';
      modal.style.cssText='position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px';
      modal.innerHTML='<div style="background:#fff;width:min(650px,100%);max-height:85vh;overflow:auto;border-radius:14px;padding:20px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:15px"><h3 id="ibuildDeductionReasonTitle" style="margin:0">📋 أسباب الخصومات</h3><button type="button" id="ibuildDeductionReasonClose" style="border:0;background:#f1f5f9;border-radius:8px;font-size:22px;width:38px;height:38px;cursor:pointer">×</button></div><div id="ibuildDeductionReasonList"></div></div>';
      document.body.appendChild(modal);q('ibuildDeductionReasonClose').onclick=()=>modal.remove();
    }
    q('ibuildDeductionReasonTitle').textContent='📋 أسباب خصومات '+(name||'الموظف');
    q('ibuildDeductionReasonList').innerHTML='<div style="padding:25px;text-align:center;color:#64748b">جاري التحميل...</div>';
    try{
      const rows=await getAdjustments(employeeId);
      q('ibuildDeductionReasonList').innerHTML=rows.length?rows.map(x=>'<div style="border:1px solid #e2e8f0;border-radius:9px;padding:12px;margin-bottom:9px;background:#f8fafc"><div style="display:flex;justify-content:space-between;gap:10px"><strong>'+esc(x.reason||'بدون سبب')+'</strong><strong style="color:#dc2626">'+money(x.amount)+'</strong></div><div style="font-size:11px;color:#64748b;margin-top:6px">'+esc(x.payroll_month||'')+'</div></div>').join(''):'<div style="padding:25px;text-align:center;color:#64748b">لا توجد خصومات أخرى مسجلة لهذا الموظف في هذا الشهر.</div>';
    }catch(e){q('ibuildDeductionReasonList').innerHTML='<div style="padding:25px;text-align:center;color:#dc2626">'+esc(e.message)+'</div>';}
  }
  function addButtons(){
    const body=q('payrollTable');if(!body)return;
    [...body.querySelectorAll('tr')].forEach(row=>{
      if(row.querySelector('.ibuild-reason-btn'))return;
      const cells=row.querySelectorAll('td');if(!cells.length)return;
      const employeeCell=cells[1];const actionCell=cells[cells.length-1];
      if(!employeeCell||!actionCell)return;
      const name=employeeCell.textContent.trim();
      const employeeCode=(cells[0]?.textContent||'').trim();
      const employees=window.payrollEmployees||[];
      const employee=employees.find(e=>String(e.employee_code||e.id)===employeeCode||String(e.full_name||'').trim()===name);
      if(!employee)return;
      const btn=document.createElement('button');btn.type='button';btn.className='action-btn ibuild-reason-btn';btn.textContent='📋 السبب';btn.style.cssText='margin-inline-start:5px;background:#ede9fe;color:#6d28d9';btn.onclick=()=>showReason(employee.id,employee.full_name);actionCell.appendChild(btn);
    });
  }
  const observer=new MutationObserver(addButtons);
  document.addEventListener('DOMContentLoaded',()=>{addButtons();const b=q('payrollTable');if(b)observer.observe(b,{childList:true,subtree:true});});
  setInterval(addButtons,1200);
})();
</script>`;
    return html.replace(/<\/body>/i, script + '\n</body>');
}

function injectSharedSidebar(html) {
    if (typeof html !== 'string' || !/<html[\s>]/i.test(html)) return html;
    let output = html;
    if (sidebarScript && !output.includes('id="ibuild-shared-sidebar-style"') && !output.includes('shared-sidebar.js')) output = output.replace(/<\/body>/i, `<script>\n${sidebarScript}\n</script>\n</body>`);
    if (/id=["']payrollMonth["']/i.test(output)) {
        if (!output.includes('id="ibuild-payroll-step1-style"')) output = output.replace(/<\/head>/i, `<style id="ibuild-payroll-step1-style">.form-card{display:none!important}</style>\n</head>`);
        if (payrollEnhancementScript && !output.includes('payroll-enhancements.js')) output = output.replace(/<\/body>/i, `<script>\n${payrollEnhancementScript}\n</script>\n</body>`);
        if (payrollBridgeScript && !output.includes('payroll-bridge.js')) output = output.replace(/<\/body>/i, `<script>\n${payrollBridgeScript}\n</script>\n</body>`);
        output = injectDeductionReasonTools(output);
    }
    return output;
}

const originalSend = express.response.send;
express.response.send = function hardenedSend(body) {
    if (typeof body === 'string' && /<html[\s>]/i.test(body)) { body = injectSharedSidebar(body); this.type('html'); }
    return originalSend.call(this, body);
};
const originalSendFile = express.response.sendFile;
express.response.sendFile = function hardenedSendFile(filePath, options, callback) {
    if (typeof filePath === 'string' && /\.html?$/i.test(filePath)) {
        const response = this;
        const done = typeof callback === 'function' ? callback : function (error) { if (error) return response.status(error.statusCode || 500).end(); };
        fs.readFile(filePath, 'utf8', function (error, html) { if (error) return done(error); response.type('html').send(injectSharedSidebar(html)); done(); });
        return this;
    }
    return originalSendFile.call(this, filePath, options, callback);
};
const originalWrite = express.response.write;
const originalEnd = express.response.end;
express.response.write = function hardenedWrite(chunk, encoding, callback) {
    const contentType = String(this.getHeader('Content-Type') || '').toLowerCase();
    if (contentType.includes('text/html')) { if (!this.__ibuildHtmlBuffer) this.__ibuildHtmlBuffer = []; if (chunk) this.__ibuildHtmlBuffer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding)); if (typeof callback === 'function') callback(); return true; }
    return originalWrite.call(this, chunk, encoding, callback);
};
express.response.end = function hardenedEnd(chunk, encoding, callback) {
    const contentType = String(this.getHeader('Content-Type') || '').toLowerCase();
    if (contentType.includes('text/html') || this.__ibuildHtmlBuffer) { if (!this.__ibuildHtmlBuffer) this.__ibuildHtmlBuffer = []; if (chunk) this.__ibuildHtmlBuffer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding)); const html = Buffer.concat(this.__ibuildHtmlBuffer).toString('utf8'); delete this.__ibuildHtmlBuffer; const finalHtml = injectSharedSidebar(html); this.removeHeader('Content-Length'); return originalEnd.call(this, finalHtml, 'utf8', callback); }
    return originalEnd.call(this, chunk, encoding, callback);
};

function ensurePayrollSchema() {
    return db.query(`ALTER TABLE payroll_records ADD COLUMN overtime_hours DECIMAL(10,2) NOT NULL DEFAULT 0`).catch(() => null)
        .then(() => db.query(`CREATE TABLE IF NOT EXISTS payroll_adjustments (id INT AUTO_INCREMENT PRIMARY KEY, employee_id INT NOT NULL, payroll_month DATE NOT NULL, type VARCHAR(30) NOT NULL, amount DECIMAL(12,2) NOT NULL DEFAULT 0, reason VARCHAR(255) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE, INDEX idx_adjustment_employee_month (employee_id, payroll_month))`))
        .then(() => db.query(`CREATE TABLE IF NOT EXISTS payroll_advances (id INT AUTO_INCREMENT PRIMARY KEY, employee_id INT NOT NULL, total_amount DECIMAL(12,2) NOT NULL DEFAULT 0, monthly_installment DECIMAL(12,2) NOT NULL DEFAULT 0, remaining_amount DECIMAL(12,2) NOT NULL DEFAULT 0, start_month DATE NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'active', notes VARCHAR(255) NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE, INDEX idx_advance_employee (employee_id))`))
        .then(() => db.query(`CREATE TABLE IF NOT EXISTS payroll_advance_payments (id INT AUTO_INCREMENT PRIMARY KEY, advance_id INT NOT NULL, employee_id INT NOT NULL, payroll_month DATE NOT NULL, amount DECIMAL(12,2) NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY unique_advance_month (advance_id, payroll_month), FOREIGN KEY (advance_id) REFERENCES payroll_advances(id) ON DELETE CASCADE, FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE)`));
}

function registerPayrollRoutes(app) {
    const ready = ensurePayrollSchema();
    const withReady = handler => async (req, res) => { try { await ready; return await handler(req, res); } catch (error) { console.error('PAYROLL ENHANCEMENT API:', error); return res.status(500).json({success:false,message:'حدث خطأ في نظام الرواتب'}); } };
    app.get('/api/payroll/adjustments', withReady(async (req,res)=>{ const month=String(req.query.month||'').slice(0,10); const [rows]=await db.query(`SELECT a.*,e.full_name,e.employee_code FROM payroll_adjustments a JOIN employees e ON e.id=a.employee_id WHERE a.payroll_month=? ORDER BY a.id DESC`,[month]); res.json({success:true,adjustments:rows}); }));
    app.post('/api/payroll/adjustments', withReady(async (req,res)=>{ const employeeId=Number(req.body.employee_id), month=String(req.body.payroll_month||'').slice(0,10), type=String(req.body.type||'deduction'), amount=Number(req.body.amount||0), reason=String(req.body.reason||'').trim(); if(!employeeId||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(month)||amount<=0||!reason||!['deduction','advance'].includes(type)) return res.status(400).json({success:false,message:'بيانات الخصم غير صحيحة'}); await db.query(`INSERT INTO payroll_adjustments(employee_id,payroll_month,type,amount,reason) VALUES(?,?,?,?,?)`,[employeeId,month,type,amount,reason]); res.json({success:true,message:'تم حفظ البند'}); }));
    app.get('/api/payroll/advances', withReady(async (req,res)=>{ const employeeId=Number(req.query.employee_id||0); const [rows]=await db.query(`SELECT a.*,e.full_name,e.employee_code FROM payroll_advances a JOIN employees e ON e.id=a.employee_id WHERE (?=0 OR a.employee_id=?) ORDER BY a.id DESC`,[employeeId,employeeId]); res.json({success:true,advances:rows}); }));
    app.post('/api/payroll/advances', withReady(async (req,res)=>{ const employeeId=Number(req.body.employee_id), total=Number(req.body.total_amount||0), installment=Number(req.body.monthly_installment||0), startMonth=String(req.body.start_month||'').slice(0,10), notes=String(req.body.notes||'').trim(); if(!employeeId||total<=0||installment<=0||installment>total||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(startMonth)) return res.status(400).json({success:false,message:'بيانات السلفة غير صحيحة'}); await db.query(`INSERT INTO payroll_advances(employee_id,total_amount,monthly_installment,remaining_amount,start_month,notes) VALUES(?,?,?,?,?,?)`,[employeeId,total,installment,total,startMonth,notes||null]); res.json({success:true,message:'تم حفظ السلفة'}); }));
    app.post('/api/payroll/advances/:id/deduct', withReady(async (req,res)=>{ const advanceId=Number(req.params.id), month=String(req.body.month||'').slice(0,10), requested=Number(req.body.amount||0); if(!advanceId||requested<=0||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(month)) return res.status(400).json({success:false,message:'بيانات خصم السلفة غير صحيحة'}); const connection=await db.getConnection(); try{ await connection.beginTransaction(); const [advRows]=await connection.query(`SELECT * FROM payroll_advances WHERE id=? FOR UPDATE`,[advanceId]); if(!advRows.length) throw new Error('السلفة غير موجودة'); const advance=advRows[0]; if(advance.status!=='active'||Number(advance.remaining_amount)<=0) throw new Error('السلفة مكتملة السداد'); const amount=Math.min(requested,Number(advance.remaining_amount)); const [existing]=await connection.query(`SELECT id FROM payroll_advance_payments WHERE advance_id=? AND payroll_month=?`,[advanceId,month]); if(existing.length) throw new Error('تم خصم هذه السلفة لهذا الشهر بالفعل'); await connection.query(`INSERT INTO payroll_advance_payments(advance_id,employee_id,payroll_month,amount) VALUES(?,?,?,?)`,[advanceId,advance.employee_id,month,amount]); const remaining=Math.max(0,Number(advance.remaining_amount)-amount); await connection.query(`UPDATE payroll_advances SET remaining_amount=?,status=? WHERE id=?`,[remaining,remaining<=0?'completed':'active',advanceId]); await connection.query(`INSERT INTO payroll_adjustments(employee_id,payroll_month,type,amount,reason) VALUES(?,?,?,?,?)`,[advance.employee_id,month,'advance',amount,`خصم قسط سلفة #${advanceId}`]); await connection.commit(); res.json({success:true,amount,remaining_amount:remaining}); }catch(error){await connection.rollback();res.status(400).json({success:false,message:error.message});}finally{connection.release();} }));
}
let payrollRoutesRegistered=false;
const originalUse=express.application.use;
express.application.use=function hardenedUse(...args){ const result=originalUse.apply(this,args); if(!payrollRoutesRegistered&&typeof args[0]==='function'&&args[0].name==='requireAuth'){registerPayrollRoutes(this);payrollRoutesRegistered=true;} return result; };
if(String(process.env.NODE_ENV||'').toLowerCase()==='production'){ const originalJson=express.response.json; express.response.json=function secureJson(payload){ if(payload&&typeof payload==='object'&&!Array.isArray(payload)){const sanitized={...payload};delete sanitized.error;return originalJson.call(this,sanitized);} return originalJson.call(this,payload); }; }
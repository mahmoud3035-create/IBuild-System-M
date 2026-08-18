'use strict';

const express = require('express');
const db = require('./database/db');

const originalGet = express.application.get;
const originalPost = express.application.post;
const originalDelete = express.application.delete;
const originalSend = express.response.send;

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clean(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
}

function month(v) {
  const s = String(v || '').slice(0, 7);
  return /^\d{4}-\d{2}$/.test(s) ? s : null;
}

let schemaPromise;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS payroll_advances (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
          employee_id INT NOT NULL,
          advance_date DATE NOT NULL,
          amount DECIMAL(12,2) NOT NULL DEFAULT 0,
          reason VARCHAR(500) NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (id),
          KEY idx_payroll_advances_employee (employee_id),
          KEY idx_payroll_advances_date (advance_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
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
          UNIQUE KEY uq_payroll_advance_deduction (employee_id, payroll_month),
          KEY idx_payroll_advance_deductions_employee (employee_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    })().catch(err => { schemaPromise = null; throw err; });
  }
  return schemaPromise;
}

async function getAdvanceSummary(payrollMonth) {
  await ensureSchema();
  const m = month(payrollMonth);
  const params = [];
  let monthSql = '';
  if (m) {
    monthSql = ' AND d.payroll_month = ? ';
    params.push(`${m}-01`);
  }

  const [rows] = await db.query(`
    SELECT
      e.id AS employee_id,
      e.employee_code,
      e.full_name,
      COALESCE(a.total_advance, 0) AS total_advance,
      COALESCE(p.total_repaid, 0) AS total_repaid,
      COALESCE(a.total_advance, 0) - COALESCE(p.total_repaid, 0) AS balance,
      COALESCE(d.current_deduction, 0) AS current_deduction,
      COALESCE(d.current_reason, '') AS current_deduction_reason
    FROM employees e
    LEFT JOIN (
      SELECT employee_id, SUM(amount) AS total_advance
      FROM payroll_advances
      GROUP BY employee_id
    ) a ON a.employee_id = e.id
    LEFT JOIN (
      SELECT employee_id, SUM(amount) AS total_repaid
      FROM payroll_advance_deductions
      GROUP BY employee_id
    ) p ON p.employee_id = e.id
    LEFT JOIN (
      SELECT employee_id, SUM(amount) AS current_deduction, MAX(reason) AS current_reason
      FROM payroll_advance_deductions
      WHERE 1=1 ${monthSql}
      GROUP BY employee_id
    ) d ON d.employee_id = e.id
    WHERE COALESCE(a.total_advance,0) > 0
    ORDER BY e.full_name ASC
  `, params);

  return rows.map(r => ({
    ...r,
    total_advance: Number(Number(r.total_advance || 0).toFixed(2)),
    total_repaid: Number(Number(r.total_repaid || 0).toFixed(2)),
    balance: Number(Math.max(0, Number(r.balance || 0)).toFixed(2)),
    current_deduction: Number(Number(r.current_deduction || 0).toFixed(2))
  }));
}

async function currentAdvanceDeduction(employeeId, payrollMonth) {
  await ensureSchema();
  const m = month(payrollMonth);
  if (!m) return { amount: 0, reason: null };
  const [rows] = await db.query(`
    SELECT amount, reason
    FROM payroll_advance_deductions
    WHERE employee_id = ? AND payroll_month = ?
    LIMIT 1
  `, [employeeId, `${m}-01`]);
  return rows.length ? { amount: money(rows[0].amount), reason: rows[0].reason || null } : { amount: 0, reason: null };
}

async function recalcPayrollRecord(employeeId, payrollMonth) {
  const m = month(payrollMonth);
  if (!m) return;
  const advance = await currentAdvanceDeduction(employeeId, m);
  const [rows] = await db.query(`
    SELECT id, payroll_salary, overtime_amount, additions, deductions, absence_deduction
    FROM payroll_records
    WHERE employee_id = ? AND DATE_FORMAT(payroll_month, '%Y-%m') = ?
    LIMIT 1
  `, [employeeId, m]);
  if (!rows.length) return;
  const r = rows[0];
  const baseNet = money(r.payroll_salary) + money(r.overtime_amount) + money(r.additions)
    - money(r.absence_deduction) - money(r.deductions);
  const net = Math.max(0, baseNet - advance.amount);
  await db.query('UPDATE payroll_records SET net_salary=? WHERE id=?', [Number(net.toFixed(2)), r.id]);
}

function patchPayrollResponse(res) {
  const originalJson = res.json;
  res.json = async function(payload) {
    try {
      if (payload && payload.success && Array.isArray(payload.records)) {
        await ensureSchema();
        const rows = payload.records;
        const months = [...new Set(rows.map(r => String(r.payroll_month || '').slice(0,7)).filter(Boolean))];
        const [advances] = await db.query('SELECT employee_id, SUM(amount) total_advance FROM payroll_advances GROUP BY employee_id');
        const [repaid] = await db.query('SELECT employee_id, SUM(amount) total_repaid FROM payroll_advance_deductions GROUP BY employee_id');
        const [deductions] = months.length
          ? await db.query(`SELECT employee_id, DATE_FORMAT(payroll_month,'%Y-%m') month, amount, reason FROM payroll_advance_deductions WHERE DATE_FORMAT(payroll_month,'%Y-%m') IN (${months.map(()=>'?').join(',')})`, months)
          : [[]];
        const aMap = new Map(advances.map(r => [Number(r.employee_id), money(r.total_advance)]));
        const pMap = new Map(repaid.map(r => [Number(r.employee_id), money(r.total_repaid)]));
        const dMap = new Map(deductions.map(r => [`${Number(r.employee_id)}_${r.month}`, r]));
        payload.records = rows.map(record => {
          const id = Number(record.employee_id);
          const m = String(record.payroll_month || '').slice(0,7);
          const d = dMap.get(`${id}_${m}`);
          const total = aMap.get(id) || 0;
          const paid = pMap.get(id) || 0;
          const current = d ? money(d.amount) : 0;
          const net = Math.max(0, money(record.net_salary) - current);
          return {
            ...record,
            advance_total: Number(total.toFixed(2)),
            advance_repaid: Number(paid.toFixed(2)),
            advance_balance: Number(Math.max(0,total-paid).toFixed(2)),
            advance_deduction: Number(current.toFixed(2)),
            advance_deduction_reason: d?.reason || '',
            net_salary: Number(net.toFixed(2))
          };
        });
      }
    } catch (error) {
      console.error('PAYROLL ADVANCE RESPONSE ERROR:', error.message);
    }
    return originalJson.call(this, payload);
  };
}

function injectAdvanceManager(body, req) {
  if (typeof body !== 'string' || req.path !== '/payroll' || !/text\/html/i.test(String(req.headers.accept || ''))) return body;
  const script = `
<style id="ibuild-advances-style">
.ib-advance-btn{border:0;background:#7c3aed;color:#fff;padding:10px 15px;border-radius:8px;font-weight:bold;cursor:pointer;margin-inline-start:6px}.ib-advance-btn:hover{background:#6d28d9}
.ib-advance-modal{position:fixed;inset:0;background:rgba(15,23,42,.62);z-index:60000;display:none;align-items:center;justify-content:center;padding:18px}.ib-advance-box{background:#fff;width:min(1050px,96vw);max-height:90vh;overflow:auto;border-radius:16px;padding:22px;direction:rtl}.ib-advance-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.ib-advance-box input,.ib-advance-box select,.ib-advance-box textarea{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px}.ib-advance-table{width:100%;border-collapse:collapse;margin-top:18px}.ib-advance-table th,.ib-advance-table td{padding:10px;border-bottom:1px solid #e2e8f0;text-align:right}.ib-advance-table th{background:#f8fafc}.ib-advance-actions{display:flex;gap:8px;justify-content:flex-start;margin-top:15px}.ib-advance-close{border:0;background:#e2e8f0;padding:9px 15px;border-radius:8px;cursor:pointer}.ib-advance-save{border:0;background:#2563eb;color:#fff;padding:9px 15px;border-radius:8px;cursor:pointer}.ib-advance-danger{border:0;background:#fee2e2;color:#b91c1c;padding:6px 9px;border-radius:7px;cursor:pointer}.ib-advance-reason{font-size:11px;color:#64748b;margin-top:4px}@media(max-width:800px){.ib-advance-grid{grid-template-columns:1fr 1fr}}
</style>
<div id="ibAdvanceModal" class="ib-advance-modal"><div class="ib-advance-box">
<div style="display:flex;justify-content:space-between;align-items:center"><h2>💰 إدارة سلف الموظفين</h2><button id="ibAdvanceClose" class="ib-advance-close">✕</button></div>
<p style="color:#64748b;margin:8px 0 18px">كل سلف الموظف تتجمع في رصيد واحد، وأنت تحدد قيمة الخصم في كل شهر.</p>
<div class="ib-advance-grid">
<div><label>الموظف</label><select id="ibAdvanceEmployee"></select></div>
<div><label>قيمة السلفة الجديدة</label><input id="ibAdvanceAmount" type="number" min="0" step="0.01" placeholder="0.00"></div>
<div style="grid-column:span 2"><label>سبب السلفة</label><input id="ibAdvanceReason" placeholder="مثال: ظرف طارئ / علاج / احتياجات شخصية"></div>
</div>
<div class="ib-advance-actions"><button id="ibAdvanceAdd" class="ib-advance-save">➕ إضافة السلفة</button></div>
<hr style="margin:20px 0;border:0;border-top:1px solid #e2e8f0">
<div class="ib-advance-grid">
<div><label>خصم السلف هذا الشهر</label><input id="ibAdvanceDeduction" type="number" min="0" step="0.01" placeholder="0.00"></div>
<div style="grid-column:span 3"><label>سبب خصم السلفة هذا الشهر</label><input id="ibAdvanceDeductionReason" placeholder="مثال: قسط السلفة - الدفعة الأولى"></div>
</div>
<div class="ib-advance-actions"><button id="ibAdvanceSaveDeduction" class="ib-advance-save">💾 حفظ خصم هذا الشهر</button></div>
<div id="ibAdvanceSummary"></div>
<div id="ibAdvanceHistory" style="margin-top:18px"></div>
</div></div>
<script id="ibuild-advances-client">
(function(){
'use strict';
const esc=v=>String(v??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#039;'}[c]));
const money=v=>'AED '+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const monthEl=()=>document.getElementById('payrollMonth');
const currentMonth=()=>String(monthEl()?.value||new Date().toISOString().slice(0,7)).slice(0,7);
const modal=()=>document.getElementById('ibAdvanceModal');
async function employees(){
 const r=await fetch('/api/payroll/employees'); const d=await r.json(); return d.employees||[];
}
async function load(){
 const list=await employees(); window.__ibAdvanceEmployees=list;
 const s=document.getElementById('ibAdvanceEmployee'); if(!s)return;
 const old=s.value; s.innerHTML='<option value="">اختر الموظف</option>'+list.map(e=>'<option value="'+e.id+'">'+esc(e.full_name)+'</option>').join(''); if(old)s.value=old;
 await render();
}
async function render(){
 const s=document.getElementById('ibAdvanceEmployee'); const id=Number(s?.value||0); const m=currentMonth();
 const r=await fetch('/api/payroll/advance-summary?month='+encodeURIComponent(m)); const d=await r.json(); const rows=d.summary||[];
 const selected=rows.find(x=>Number(x.employee_id)===id);
 const ded=document.getElementById('ibAdvanceDeduction'); const reason=document.getElementById('ibAdvanceDeductionReason');
 if(selected){ded.value=selected.current_deduction||'';reason.value=selected.current_deduction_reason||'';} else {ded.value='';reason.value='';}
 document.getElementById('ibAdvanceSummary').innerHTML=rows.length?'<table class="ib-advance-table"><thead><tr><th>الموظف</th><th>إجمالي السلف</th><th>تم خصمه</th><th>الرصيد المتبقي</th><th>خصم هذا الشهر</th><th>سبب الخصم</th></tr></thead><tbody>'+rows.map(x=>'<tr><td>'+esc(x.full_name)+'</td><td>'+money(x.total_advance)+'</td><td>'+money(x.total_repaid)+'</td><td><b>'+money(x.balance)+'</b></td><td>'+money(x.current_deduction)+'</td><td>'+esc(x.current_deduction_reason||'—')+'</td></tr>').join('')+'</tbody></table>':'<div style="padding:20px;text-align:center;color:#64748b">لا توجد سلف مسجلة.</div>';
 if(id){
  const rr=await fetch('/api/payroll/advances?employee_id='+id);const dd=await rr.json();const hs=dd.advances||[];
  document.getElementById('ibAdvanceHistory').innerHTML='<h3>سجل سلف '+esc(selected?.full_name||'الموظف')+'</h3>'+(hs.length?'<table class="ib-advance-table"><thead><tr><th>التاريخ</th><th>المبلغ</th><th>السبب</th><th>إجراء</th></tr></thead><tbody>'+hs.map(x=>'<tr><td>'+esc(String(x.advance_date).slice(0,10))+'</td><td>'+money(x.amount)+'</td><td>'+esc(x.reason||'—')+'</td><td><button class="ib-advance-danger" data-del="'+x.id+'">حذف</button></td></tr>').join('')+'</tbody></table>':'<div style="padding:12px;color:#64748b">لا توجد سلف لهذا الموظف.</div>');
  document.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(!confirm('حذف هذه السلفة؟'))return;const x=await fetch('/api/payroll/advances/'+b.dataset.del,{method:'DELETE'});if(!x.ok){alert('تعذر حذف السلفة');return;}await render();await refreshPayroll();});
 } else document.getElementById('ibAdvanceHistory').innerHTML='';
}
async function refreshPayroll(){try{if(typeof window.loadPayroll==='function')await window.loadPayroll();}catch(e){};location.reload();}
async function add(){
 const employee_id=Number(document.getElementById('ibAdvanceEmployee').value);const amount=Number(document.getElementById('ibAdvanceAmount').value);const reason=document.getElementById('ibAdvanceReason').value.trim();
 if(!employee_id||amount<=0||!reason){alert('اختر الموظف واكتب قيمة السلفة وسبب السلفة');return;}
 const r=await fetch('/api/payroll/advances',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({employee_id,amount,reason,advance_date:new Date().toISOString().slice(0,10)})});const d=await r.json();if(!r.ok||!d.success){alert(d.message||'تعذر إضافة السلفة');return;}document.getElementById('ibAdvanceAmount').value='';document.getElementById('ibAdvanceReason').value='';await render();await refreshPayroll();}
async function saveDeduction(){
 const employee_id=Number(document.getElementById('ibAdvanceEmployee').value);const amount=Number(document.getElementById('ibAdvanceDeduction').value||0);const reason=document.getElementById('ibAdvanceDeductionReason').value.trim();
 if(!employee_id){alert('اختر الموظف');return;} if(amount<0){alert('قيمة الخصم غير صحيحة');return;} if(amount>0&&!reason){alert('اكتب سبب خصم السلفة لهذا الشهر');return;}
 const r=await fetch('/api/payroll/advance-deduction',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({employee_id,amount,reason,payroll_month:currentMonth()})});const d=await r.json();if(!r.ok||!d.success){alert(d.message||'تعذر حفظ خصم السلفة');return;}await render();await refreshPayroll();}
function open(){modal().style.display='flex';load().catch(e=>alert(e.message));}
function init(){
 if(document.getElementById('ibAdvanceOpen'))return;
 const b=document.createElement('button');b.id='ibAdvanceOpen';b.className='ib-advance-btn';b.textContent='💰 إدارة السلف';b.onclick=open;
 const host=document.querySelector('.top-actions')||document.querySelector('.content');if(host)host.appendChild(b);
 document.getElementById('ibAdvanceClose').onclick=()=>modal().style.display='none';
 document.getElementById('ibAdvanceEmployee').onchange=render;document.getElementById('ibAdvanceAdd').onclick=add;document.getElementById('ibAdvanceSaveDeduction').onclick=saveDeduction;
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else setTimeout(init,150);
})();
</script>`;
  return body.includes('</body>') ? body.replace('</body>', script + '</body>') : body + script;
}

async function getPayrollAdvanceForMonth(employeeId, payrollMonth) {
  const d = await currentAdvanceDeduction(employeeId, payrollMonth);
  return d.amount;
}

function wrapPayrollGet(res) {
  patchPayrollResponse(res);
}

if (!express.application.__ibuildPayrollAdvancesPatched) {
  express.application.__ibuildPayrollAdvancesPatched = true;

  express.application.get = function(path, ...handlers) {
    if (path === '/api/payroll') handlers = handlers.map(h => function(req,res,next){ patchPayrollResponse(res); return h(req,res,next); });
    if (path === '/api/payroll/advances') handlers = handlers.map(h => async function(req,res,next){ try { await ensureSchema(); return h(req,res,next); } catch(e){ return res.status(500).json({success:false,message:e.message}); } });
    if (path === '/api/payroll/advance-summary') handlers = handlers.map(h => async function(req,res,next){ try { const summary=await getAdvanceSummary(req.query.month); return res.json({success:true,summary}); } catch(e){ return res.status(500).json({success:false,message:'تعذر تحميل السلف',error:e.message}); } });
    return originalGet.call(this,path,...handlers);
  };

  express.application.post = function(path, ...handlers) {
    if (path === '/api/payroll/advances') handlers = handlers.map(h => async function(req,res,next){
      try {
        await ensureSchema();
        const employeeId=Number(req.body?.employee_id||0); const amount=money(req.body?.amount); const reason=clean(req.body?.reason); const date=clean(req.body?.advance_date)||new Date().toISOString().slice(0,10);
        if(!employeeId||amount<=0||!reason) return res.status(400).json({success:false,message:'الموظف وقيمة السلفة وسبب السلفة مطلوبة'});
        const [emp]=await db.query('SELECT id FROM employees WHERE id=? LIMIT 1',[employeeId]); if(!emp.length)return res.status(404).json({success:false,message:'الموظف غير موجود'});
        const [r]=await db.query('INSERT INTO payroll_advances (employee_id,advance_date,amount,reason) VALUES (?,?,?,?)',[employeeId,date,Number(amount.toFixed(2)),reason]);
        return res.status(201).json({success:true,id:r.insertId,message:'تمت إضافة السلفة بنجاح'});
      } catch(e){return res.status(500).json({success:false,message:'تعذر إضافة السلفة',error:e.message});}
    });
    if (path === '/api/payroll/advance-deduction') handlers = handlers.map(h => async function(req,res,next){
      try {
        await ensureSchema();
        const employeeId=Number(req.body?.employee_id||0); const m=month(req.body?.payroll_month); const amount=money(req.body?.amount); const reason=clean(req.body?.reason);
        if(!employeeId||!m||amount<0) return res.status(400).json({success:false,message:'بيانات خصم السلفة غير صحيحة'});
        if(amount>0&&!reason)return res.status(400).json({success:false,message:'سبب خصم السلفة مطلوب'});
        const [a]=await db.query('SELECT COALESCE(SUM(amount),0) total FROM payroll_advances WHERE employee_id=?',[employeeId]);
        const [p]=await db.query('SELECT COALESCE(SUM(amount),0) total FROM payroll_advance_deductions WHERE employee_id=? AND payroll_month<>?',[employeeId,`${m}-01`]);
        const max=Number(a[0]?.total||0)-Number(p[0]?.total||0);
        if(amount>max+0.005)return res.status(400).json({success:false,message:`قيمة الخصم أكبر من رصيد السلف المتبقي (${max.toFixed(2)} AED)`});
        await db.query(`INSERT INTO payroll_advance_deductions (employee_id,payroll_month,amount,reason) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE amount=VALUES(amount),reason=VALUES(reason)`,[employeeId,`${m}-01`,Number(amount.toFixed(2)),reason]);
        await recalcPayrollRecord(employeeId,m);
        return res.json({success:true,message:'تم حفظ خصم السلفة لهذا الشهر',amount:Number(amount.toFixed(2))});
      } catch(e){return res.status(500).json({success:false,message:'تعذر حفظ خصم السلفة',error:e.message});}
    });
    return originalPost.call(this,path,...handlers);
  };

  express.application.delete = function(path,...handlers) {
    if(path === '/api/payroll/advances/:id') handlers = handlers.map(h => async function(req,res,next){
      try{await ensureSchema();const id=Number(req.params.id);if(!id)return res.status(400).json({success:false,message:'رقم السلفة غير صحيح'});await db.query('DELETE FROM payroll_advances WHERE id=?',[id]);return res.json({success:true,message:'تم حذف السلفة'});}catch(e){return res.status(500).json({success:false,message:'تعذر حذف السلفة',error:e.message});}
    });
    return originalDelete.call(this,path,...handlers);
  };

  express.response.send = function(body) {
    if (this.req && this.req.path === '/payroll' && typeof body === 'string') body = injectAdvanceManager(body,this.req);
    return originalSend.call(this,body);
  };
}

ensureSchema().catch(e=>console.error('PAYROLL ADVANCES SCHEMA ERROR:',e.message));

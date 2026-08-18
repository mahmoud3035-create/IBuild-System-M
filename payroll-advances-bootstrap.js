'use strict';

// Preloaded before server.js creates its Express app. We wrap only the Express
// factory so the real app can register the advance routes at the correct time.
const Module = require('module');
const expressModuleId = require.resolve('express');
const originalExpress = require('express');
const registerPayrollAdvanceRoutes = require('./payroll-advances-routes');

if (!originalExpress.__ibuildPayrollAdvancesFactoryWrapped) {
  function wrappedExpress(...args) {
    const app = originalExpress(...args);
    const originalListen = app.listen;
    let registered = false;
    app.listen = function listenWithPayrollAdvances(...listenArgs) {
      if (!registered) {
        registered = true;
        try { registerPayrollAdvanceRoutes(app); }
        catch (error) { console.error('PAYROLL ADVANCES ROUTE REGISTRATION ERROR:', error.message); }
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

const response = originalExpress.response;
if (!response.__ibuildPayrollAdvanceUiWrapped) {
  const originalSend = response.send;
  response.send = function sendWithPayrollAdvances(body) {
    if (this.req && this.req.path === '/payroll' && typeof body === 'string' && /text\/html/i.test(String(this.req.headers.accept || ''))) {
      const script = `
<style id="ibuild-advances-style">
.ib-advance-btn{border:0;background:#7c3aed;color:#fff;padding:10px 15px;border-radius:8px;font-weight:bold;cursor:pointer;margin-inline-start:6px}.ib-advance-btn:hover{background:#6d28d9}
.ib-advance-modal{position:fixed;inset:0;background:rgba(15,23,42,.62);z-index:60000;display:none;align-items:center;justify-content:center;padding:18px}.ib-advance-box{background:#fff;width:min(1100px,96vw);max-height:90vh;overflow:auto;border-radius:16px;padding:22px;direction:rtl}.ib-advance-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.ib-advance-box input,.ib-advance-box select{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px}.ib-advance-table{width:100%;border-collapse:collapse;margin-top:18px}.ib-advance-table th,.ib-advance-table td{padding:10px;border-bottom:1px solid #e2e8f0;text-align:right}.ib-advance-table th{background:#f8fafc}.ib-advance-actions{display:flex;gap:8px;justify-content:flex-start;margin-top:15px}.ib-advance-close{border:0;background:#e2e8f0;padding:9px 15px;border-radius:8px;cursor:pointer}.ib-advance-save{border:0;background:#2563eb;color:#fff;padding:9px 15px;border-radius:8px;cursor:pointer}.ib-advance-danger{border:0;background:#fee2e2;color:#b91c1c;padding:6px 9px;border-radius:7px;cursor:pointer}@media(max-width:800px){.ib-advance-grid{grid-template-columns:1fr 1fr}}
</style>
<div id="ibAdvanceModal" class="ib-advance-modal"><div class="ib-advance-box">
<div style="display:flex;justify-content:space-between;align-items:center"><h2>💰 إدارة سلف الموظفين</h2><button id="ibAdvanceClose" class="ib-advance-close">✕</button></div>
<p style="color:#64748b;margin:8px 0 18px">كل سلف الموظف تتجمع في رصيد واحد، وأنت تحدد قيمة الخصم في كل شهر.</p>
<div class="ib-advance-grid">
<div><label>الموظف</label><select id="ibAdvanceEmployee"></select></div>
<div><label>قيمة السلفة الجديدة</label><input id="ibAdvanceAmount" type="number" min="0" step="0.01" placeholder="0.00"></div>
<div style="grid-column:span 2"><label>سبب السلفة</label><input id="ibAdvanceReason" placeholder="مثال: ظرف طارئ / احتياجات شخصية"></div>
</div>
<div class="ib-advance-actions"><button id="ibAdvanceAdd" class="ib-advance-save">➕ إضافة السلفة</button></div>
<hr style="margin:20px 0;border:0;border-top:1px solid #e2e8f0">
<div class="ib-advance-grid">
<div><label>خصم السلف هذا الشهر</label><input id="ibAdvanceDeduction" type="number" min="0" step="0.01" placeholder="0.00"></div>
<div style="grid-column:span 3"><label>سبب خصم السلفة هذا الشهر</label><input id="ibAdvanceDeductionReason" placeholder="مثال: قسط السلفة - الدفعة الأولى"></div>
</div>
<div class="ib-advance-actions"><button id="ibAdvanceSaveDeduction" class="ib-advance-save">💾 حفظ خصم هذا الشهر</button></div>
<div id="ibAdvanceSummary"></div><div id="ibAdvanceHistory" style="margin-top:18px"></div>
</div></div>
<script id="ibuild-advances-client">
(function(){'use strict';
const esc=v=>String(v??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#039;'}[c]));
const money=v=>'AED '+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const modal=()=>document.getElementById('ibAdvanceModal');
const currentMonth=()=>{const e=document.getElementById('payrollMonth');return String(e?.value||new Date().toISOString().slice(0,7)).slice(0,7)};
async function loadEmployees(){const r=await fetch('/api/employees');const d=await r.json();return d.employees||[]}
async function render(){
 const id=Number(document.getElementById('ibAdvanceEmployee').value||0),m=currentMonth();
 const r=await fetch('/api/payroll/advance-summary?month='+encodeURIComponent(m)),d=await r.json(),rows=d.summary||[],selected=rows.find(x=>Number(x.employee_id)===id);
 document.getElementById('ibAdvanceDeduction').value=selected?.current_deduction||'';document.getElementById('ibAdvanceDeductionReason').value=selected?.current_deduction_reason||'';
 document.getElementById('ibAdvanceSummary').innerHTML=rows.length?'<table class="ib-advance-table"><thead><tr><th>الموظف</th><th>إجمالي السلف</th><th>تم خصمه</th><th>الرصيد المتبقي</th><th>خصم هذا الشهر</th><th>سبب الخصم</th></tr></thead><tbody>'+rows.map(x=>'<tr><td>'+esc(x.full_name)+'</td><td>'+money(x.total_advance)+'</td><td>'+money(x.total_repaid)+'</td><td><b>'+money(x.balance)+'</b></td><td>'+money(x.current_deduction)+'</td><td>'+esc(x.current_deduction_reason||'—')+'</td></tr>').join('')+'</tbody></table>':'<div style="padding:20px;text-align:center;color:#64748b">لا توجد سلف مسجلة.</div>';
 if(id){const rr=await fetch('/api/payroll/advances?employee_id='+id),dd=await rr.json(),hs=dd.advances||[];document.getElementById('ibAdvanceHistory').innerHTML='<h3>سجل سلف '+esc(selected?.full_name||'الموظف')+'</h3>'+(hs.length?'<table class="ib-advance-table"><thead><tr><th>التاريخ</th><th>المبلغ</th><th>السبب</th><th>إجراء</th></tr></thead><tbody>'+hs.map(x=>'<tr><td>'+esc(String(x.advance_date).slice(0,10))+'</td><td>'+money(x.amount)+'</td><td>'+esc(x.reason||'—')+'</td><td><button class="ib-advance-danger" data-del="'+x.id+'">حذف</button></td></tr>').join('')+'</tbody></table>':'<div style="padding:12px;color:#64748b">لا توجد سلف لهذا الموظف.</div>');document.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(!confirm('حذف هذه السلفة؟'))return;const x=await fetch('/api/payroll/advances/'+b.dataset.del,{method:'DELETE'});if(!x.ok){alert('تعذر حذف السلفة');return}await render()})}else document.getElementById('ibAdvanceHistory').innerHTML='';
}
async function open(){modal().style.display='flex';const list=await loadEmployees(),s=document.getElementById('ibAdvanceEmployee'),old=s.value;s.innerHTML='<option value="">اختر الموظف</option>'+list.map(e=>'<option value="'+e.id+'">'+esc(e.full_name)+'</option>').join('');if(old)s.value=old;await render()}
async function add(){const employee_id=Number(document.getElementById('ibAdvanceEmployee').value),amount=Number(document.getElementById('ibAdvanceAmount').value),reason=document.getElementById('ibAdvanceReason').value.trim();if(!employee_id||amount<=0||!reason){alert('اختر الموظف واكتب قيمة السلفة وسبب السلفة');return}const r=await fetch('/api/payroll/advances',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({employee_id,amount,reason,advance_date:new Date().toISOString().slice(0,10)})}),d=await r.json();if(!r.ok||!d.success){alert(d.message||'تعذر إضافة السلفة');return}document.getElementById('ibAdvanceAmount').value='';document.getElementById('ibAdvanceReason').value='';await render()}
async function saveDeduction(){const employee_id=Number(document.getElementById('ibAdvanceEmployee').value),amount=Number(document.getElementById('ibAdvanceDeduction').value||0),reason=document.getElementById('ibAdvanceDeductionReason').value.trim();if(!employee_id){alert('اختر الموظف');return}if(amount<0){alert('قيمة الخصم غير صحيحة');return}if(amount>0&&!reason){alert('اكتب سبب خصم السلفة لهذا الشهر');return}const r=await fetch('/api/payroll/advance-deduction',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({employee_id,amount,reason,payroll_month:currentMonth()})}),d=await r.json();if(!r.ok||!d.success){alert(d.message||'تعذر حفظ خصم السلفة');return}await render();location.reload()}
function init(){if(document.getElementById('ibAdvanceOpen'))return;const b=document.createElement('button');b.id='ibAdvanceOpen';b.className='ib-advance-btn';b.textContent='💰 إدارة السلف';b.onclick=()=>open().catch(e=>alert(e.message));const host=document.querySelector('.top-actions')||document.querySelector('.content');if(host)host.appendChild(b);document.getElementById('ibAdvanceClose').onclick=()=>modal().style.display='none';document.getElementById('ibAdvanceEmployee').onchange=render;document.getElementById('ibAdvanceAdd').onclick=()=>add().catch(e=>alert(e.message));document.getElementById('ibAdvanceSaveDeduction').onclick=()=>saveDeduction().catch(e=>alert(e.message))}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else setTimeout(init,100)
})();
</script>`;
      body = body.includes('</body>') ? body.replace('</body>', script + '</body>') : body + script;
    }
    return originalSend.call(this, body);
  };
  response.__ibuildPayrollAdvanceUiWrapped = true;
}

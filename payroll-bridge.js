(function(){
'use strict';
const esc=v=>String(v??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#039;'}[c]));
const money=v=>'AED '+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});

function hideManualSummary(){const el=document.getElementById('peManual');const card=el?.closest('.pe-summary-card');if(card)card.style.display='none';}

function showPayrollForm(){
  document.querySelectorAll('.form-card').forEach(el=>{el.style.removeProperty('display');el.style.removeProperty('visibility');el.style.removeProperty('opacity');});
  const form=[...document.querySelectorAll('.form-card')].find(el=>/كشف\s*الراتب|تعديل|إنشاء/.test(el.textContent||''));
  if(form){form.scrollIntoView({behavior:'smooth',block:'center'});form.querySelector('select,input,textarea,button')?.focus();}
}
function bindEditButtons(){
  const table=document.getElementById('payrollTable');if(!table)return;
  table.querySelectorAll('button,a').forEach(btn=>{
    if(!/تعديل/.test((btn.textContent||''))||btn.dataset.ibuildEditBound)return;
    btn.dataset.ibuildEditBound='1';btn.addEventListener('click',()=>setTimeout(showPayrollForm,30));
  });
}

async function ensurePayrollEmployees(){
  if(Array.isArray(window.payrollEmployees)&&window.payrollEmployees.length)return true;
  try{
    const r=await fetch('/api/payroll/employees');
    const d=await r.json();
    if(r.ok&&d.success&&Array.isArray(d.employees)&&d.employees.length){window.payrollEmployees=d.employees;return true;}
  }catch(e){console.warn('Payroll employee API failed',e);}
  try{
    const r=await fetch('/api/employees');
    const d=await r.json();
    const rows=Array.isArray(d.employees)?d.employees:[];
    if(r.ok&&d.success&&rows.length){
      window.payrollEmployees=rows.filter(e=>String(e.status||'active').toLowerCase()!=='inactive').map(e=>({...e,payroll_salary:Number(e.payroll_salary||e.basic_salary||0)}));
      return true;
    }
  }catch(e){console.warn('Employee fallback failed',e);}
  return false;
}

async function refreshPayrollEmployees(){
  const ok=await ensurePayrollEmployees();
  if(!ok)return;
  if(typeof window.populateEmployees==='function')window.populateEmployees();
  const selectIds=['peAdvanceEmployee','peDeductionEmployee','ot_employee_id'];
  const html='<option value="">اختر الموظف</option>'+(window.payrollEmployees||[]).map(e=>`<option value="${e.id}">${esc(e.employee_code||e.id)} - ${esc(e.full_name)}</option>`).join('');
  selectIds.forEach(id=>{const el=document.getElementById(id);if(el){const old=el.value;el.innerHTML=html;if(old)el.value=old;}});
  if(typeof window.loadPayroll==='function')await window.loadPayroll();
}

function syncPayrollGlobals(){
  try{
    if(typeof payrollRecords!=='undefined')window.payrollRecords=payrollRecords;
    if(typeof payrollEmployees!=='undefined')window.payrollEmployees=payrollEmployees;
  }catch(e){console.warn('Payroll globals sync failed',e);}
}

function wrapPayrollLoader(){
  if(window.__ibuildPayrollLoaderWrapped||typeof window.loadPayroll!=='function')return;
  const original=window.loadPayroll;
  window.loadPayroll=async function(...args){
    const result=await original.apply(this,args);
    syncPayrollGlobals();
    if(typeof window.renderEnhancedTable==='function')window.renderEnhancedTable();
    if(typeof window.renderEnhancedSummary==='function')window.renderEnhancedSummary();
    return result;
  };
  window.__ibuildPayrollLoaderWrapped=true;
}

function watchOvertimeSuccess(){
  if(window.__ibuildOvertimeWatch)return;
  window.__ibuildOvertimeWatch=true;
  const observer=new MutationObserver(()=>{
    syncPayrollGlobals();
    const text=document.body?.innerText||'';
    if(/تمت إضافة ساعات الأوفر تايم|تم إضافة ساعات الأوفر تايم|تمت إضافة ساعات إضافية/.test(text)&&!window.__ibuildOvertimeReloaded){
      window.__ibuildOvertimeReloaded=true;
      setTimeout(()=>location.reload(),700);
    }
  });
  observer.observe(document.body,{childList:true,subtree:true,characterData:true});
}

function ensureReasonModal(){
  let m=document.getElementById('ibuildDeductionReasonModal');if(m)return m;
  m=document.createElement('div');m.id='ibuildDeductionReasonModal';m.style.cssText='position:fixed;inset:0;background:rgba(15,23,42,.62);z-index:50000;display:none;align-items:center;justify-content:center;padding:20px';
  m.innerHTML='<div style="background:#fff;width:min(650px,100%);max-height:85vh;overflow:auto;border-radius:14px;padding:22px"><div style="display:flex;justify-content:space-between;align-items:center"><h3 id="ibuildDeductionReasonTitle">📋 أسباب الخصومات</h3><button type="button" id="ibuildDeductionReasonClose">×</button></div><div id="ibuildDeductionReasonList"></div></div>';
  document.body.appendChild(m);document.getElementById('ibuildDeductionReasonClose').onclick=()=>m.style.display='none';return m;
}
async function showReason(employeeId,name){
  const m=ensureReasonModal(),list=document.getElementById('ibuildDeductionReasonList');document.getElementById('ibuildDeductionReasonTitle').textContent='📋 أسباب خصومات '+(name||'الموظف');m.style.display='flex';list.innerHTML='<div style="padding:20px">جاري التحميل...</div>';
  try{
    const month=document.getElementById('payrollMonth')?.value||'';const r=await fetch('/api/payroll/adjustments?month='+encodeURIComponent(month+'-01'));const d=await r.json();
    if(!r.ok||d.success===false)throw new Error(d.message||'تعذر تحميل أسباب الخصومات');
    const rows=(d.adjustments||[]).filter(x=>Number(x.employee_id)===Number(employeeId)&&x.type==='deduction');
    if(!rows.length){list.innerHTML='<div style="padding:20px">لا توجد خصومات مسجلة لهذا الموظف في هذا الشهر.</div>';return;}
    list.innerHTML=rows.map(x=>`<div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin:8px 0"><b>${esc(x.reason||'بدون سبب')}</b> <strong style="color:#dc2626;float:left">${money(x.amount)}</strong><div style="margin-top:10px"><button type="button" data-del="${x.id}" style="background:#fee2e2;color:#b91c1c;border:0;padding:7px 10px;border-radius:7px">🗑️ حذف الخصم</button></div></div>`).join('');
    list.querySelectorAll('[data-del]').forEach(b=>b.onclick=async()=>{if(!confirm('هل أنت متأكد من حذف هذا الخصم؟'))return;const rr=await fetch('/api/payroll/adjustments/'+b.dataset.del,{method:'DELETE'});if(!rr.ok)alert('تعذر حذف الخصم');else{await showReason(employeeId,name);if(typeof window.loadPayroll==='function')window.loadPayroll();}});
  }catch(e){list.innerHTML='<div style="padding:20px;color:#dc2626">'+esc(e.message)+'</div>';}
}
function bindReasonButtons(){
  const table=document.getElementById('payrollTable');if(!table)return;
  table.querySelectorAll('tr').forEach(row=>{if(row.querySelector('.ibuild-reason-btn'))return;const cells=row.querySelectorAll('td');const emp=(window.payrollEmployees||[]).find(e=>cells.length&&[...cells].some(c=>String(c.textContent||'').trim()===String(e.employee_code||e.id)||String(c.textContent||'').trim()===String(e.full_name||'').trim()));if(!emp)return;const cell=cells[cells.length-1];if(!cell)return;const b=document.createElement('button');b.className='action-btn ibuild-reason-btn';b.textContent='📋 السبب';b.style.cssText='margin-inline-start:6px;background:#ede9fe;color:#6d28d9';b.onclick=()=>showReason(emp.id,emp.full_name);cell.appendChild(b);});
}

async function init(){
  hideManualSummary();
  syncPayrollGlobals();
  wrapPayrollLoader();
  watchOvertimeSuccess();
  await refreshPayrollEmployees();
  syncPayrollGlobals();
  wrapPayrollLoader();
  bindReasonButtons();
  const table=document.getElementById('payrollTable');if(table)new MutationObserver(()=>{syncPayrollGlobals();hideManualSummary();bindEditButtons();bindReasonButtons();}).observe(table,{childList:true,subtree:true});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else setTimeout(init,100);
})();

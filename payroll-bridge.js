(function(){
  'use strict';
  let refreshed = false;
  function esc(v){return String(v??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#039;'}[c]));}
  function money(v){return 'AED '+Number(v||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
  function getEmployeeForRow(row){
    const cells=row.querySelectorAll('td');
    if(!cells.length)return null;
    const code=(cells[0]?.textContent||'').trim();
    const name=(cells[1]?.textContent||'').trim();
    const employees=window.payrollEmployees||[];
    return employees.find(e=>String(e.id)===code||String(e.employee_code||'')===code||String(e.full_name||'').trim()===name)||null;
  }
  function hideManualSummary(){
    const el=document.getElementById('peManual');
    const card=el?.closest('.pe-summary-card');
    if(card)card.style.display='none';
  }
  function ensureReasonModal(){
    let modal=document.getElementById('ibuildDeductionReasonModal');
    if(modal)return modal;
    modal=document.createElement('div');
    modal.id='ibuildDeductionReasonModal';
    modal.style.cssText='position:fixed;inset:0;background:rgba(15,23,42,.62);z-index:50000;display:none;align-items:center;justify-content:center;padding:20px';
    modal.innerHTML='<div style="background:#fff;width:min(650px,100%);max-height:85vh;overflow:auto;border-radius:14px;padding:22px;box-shadow:0 20px 50px rgba(0,0,0,.25)"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><h3 id="ibuildDeductionReasonTitle" style="margin:0">📋 أسباب الخصومات</h3><button type="button" id="ibuildDeductionReasonClose" style="border:0;background:#f1f5f9;border-radius:8px;width:38px;height:38px;font-size:22px;cursor:pointer">×</button></div><div id="ibuildDeductionReasonList"></div></div>';
    document.body.appendChild(modal);
    document.getElementById('ibuildDeductionReasonClose').onclick=()=>{modal.style.display='none';};
    modal.addEventListener('click',e=>{if(e.target===modal)modal.style.display='none';});
    return modal;
  }
  async function showReason(employeeId,name){
    const modal=ensureReasonModal();
    const title=document.getElementById('ibuildDeductionReasonTitle');
    const list=document.getElementById('ibuildDeductionReasonList');
    title.textContent='📋 أسباب خصومات '+(name||'الموظف');
    modal.style.display='flex';
    list.innerHTML='<div style="padding:25px;text-align:center;color:#64748b">جاري تحميل الأسباب...</div>';
    try{
      const month=document.getElementById('payrollMonth')?.value||'';
      const response=await fetch('/api/payroll/adjustments?month='+encodeURIComponent(month+'-01'));
      const data=await response.json().catch(()=>({}));
      if(!response.ok||data.success===false)throw new Error(data.message||'تعذر تحميل أسباب الخصومات');
      const rows=(data.adjustments||[]).filter(x=>Number(x.employee_id)===Number(employeeId)&&x.type==='deduction');
      if(!rows.length){list.innerHTML='<div style="padding:25px;text-align:center;color:#64748b">لا توجد خصومات مسجلة لهذا الموظف في هذا الشهر.</div>';return;}
      list.innerHTML=rows.map(x=>`<div style="border:1px solid #e2e8f0;border-radius:10px;padding:13px;margin-bottom:9px;background:#f8fafc"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><strong>${esc(x.reason||'بدون سبب')}</strong><strong style="color:#dc2626">${money(x.amount)}</strong></div><div style="font-size:11px;color:#64748b;margin-top:7px">خصم آخر — ${esc(x.payroll_month||'')}</div><div style="margin-top:10px;text-align:left"><button type="button" data-delete-deduction="${x.id}" style="border:0;background:#fee2e2;color:#b91c1c;border-radius:7px;padding:7px 11px;font-weight:bold;cursor:pointer">🗑️ حذف الخصم</button></div></div>`).join('');
      list.querySelectorAll('[data-delete-deduction]').forEach(btn=>btn.addEventListener('click',()=>deleteDeduction(Number(btn.dataset.deleteDeduction),employeeId,name)));
    }catch(error){list.innerHTML='<div style="padding:25px;text-align:center;color:#dc2626">'+esc(error.message)+'</div>';}
  }
  async function deleteDeduction(id,employeeId,name){
    if(!id)return;
    if(!confirm('هل أنت متأكد من حذف هذا الخصم؟'))return;
    try{
      const response=await fetch('/api/payroll/adjustments/'+encodeURIComponent(id),{method:'DELETE'});
      const data=await response.json().catch(()=>({}));
      if(!response.ok||data.success===false)throw new Error(data.message||'تعذر حذف الخصم');
      await showReason(employeeId,name);
      if(typeof window.loadPayroll==='function')await window.loadPayroll();
    }catch(error){alert(error.message);}
  }
  function addReasonButtons(){
    hideManualSummary();
    const table=document.getElementById('payrollTable');
    if(!table)return;
    table.querySelectorAll('tr').forEach(row=>{
      if(row.querySelector('.ibuild-reason-btn'))return;
      const employee=getEmployeeForRow(row);
      const cells=row.querySelectorAll('td');
      if(!employee||cells.length<2)return;
      const actionCell=cells[cells.length-1];
      if(!actionCell)return;
      const btn=document.createElement('button');
      btn.type='button';
      btn.className='action-btn ibuild-reason-btn';
      btn.textContent='📋 السبب';
      btn.title='عرض أسباب الخصومات';
      btn.style.cssText='margin-inline-start:6px;background:#ede9fe;color:#6d28d9';
      btn.addEventListener('click',()=>showReason(employee.id,employee.full_name));
      actionCell.appendChild(btn);
    });
  }
  function sync(){
    try{
      const employees = window.eval('payrollEmployees') || [];
      const records = window.eval('payrollRecords') || [];
      window.payrollEmployees = employees;
      window.payrollRecords = records;
      if(employees.length){
        const html='<option value="">اختر الموظف</option>'+employees.map(e=>`<option value="${e.id}">${esc(e.employee_code||e.id)} - ${esc(e.full_name)}</option>`).join('');
        ['peAdvanceEmployee','peDeductionEmployee'].forEach(id=>{const el=document.getElementById(id);if(el){const old=el.value;el.innerHTML=html;if(old)el.value=old;}});
      }
      hideManualSummary();
      addReasonButtons();
      if(!refreshed && typeof window.loadPayroll==='function' && (employees.length || records.length)){
        refreshed=true;
        const month=document.getElementById('payrollMonth');
        if(month) month.dispatchEvent(new Event('change',{bubbles:true}));
      }
    }catch(_){ }
    hideManualSummary();
    addReasonButtons();
  }
  sync();
  const table=document.getElementById('payrollTable');
  if(table)new MutationObserver(addReasonButtons).observe(table,{childList:true,subtree:true});
  const timer=setInterval(()=>{sync();if(refreshed)clearInterval(timer);},500);
  setInterval(hideManualSummary,800);
})();
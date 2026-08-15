(function(){
  'use strict';
  let refreshed = false;
  function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));}
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
      if(!refreshed && typeof window.loadPayroll==='function' && (employees.length || records.length)){
        refreshed=true;
        const month=document.getElementById('payrollMonth');
        if(month) month.dispatchEvent(new Event('change',{bubbles:true}));
      }
    }catch(_){ }
  }
  sync();
  const timer=setInterval(()=>{sync();if(refreshed)clearInterval(timer);},500);
})();

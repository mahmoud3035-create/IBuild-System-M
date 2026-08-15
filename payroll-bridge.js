(function(){
  'use strict';
  let refreshed = false;
  function sync(){
    try{
      const employees = window.eval('payrollEmployees');
      const records = window.eval('payrollRecords');
      window.payrollEmployees = employees || [];
      window.payrollRecords = records || [];
      if(!refreshed && typeof window.loadPayroll === 'function' && (window.payrollEmployees.length || window.payrollRecords.length)){
        refreshed = true;
        const month = document.getElementById('payrollMonth');
        if(month){
          month.dispatchEvent(new Event('change', {bubbles:true}));
        }
      }
    }catch(_){ }
  }
  sync();
  const timer=setInterval(()=>{
    sync();
    if(refreshed) clearInterval(timer);
  },500);
})();

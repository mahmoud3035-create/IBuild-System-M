const express = require('express');

let registered = false;
const originalUse = express.application.use;
const originalSend = express.response.send;
const originalSendFile = express.response.sendFile;

function injectControls(html) {
    if (typeof html !== 'string' || !/id=["']payrollTable["']/i.test(html) || html.includes('id="ibuild-overtime-controls"')) return html;
    const script = `<script id="ibuild-overtime-controls">(function(){'use strict';
const esc=v=>String(v??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#039;'}[c]));
const msg=(text,type)=>{if(typeof window.showMessage==='function')window.showMessage(text,type);else alert(text)};
const month=()=>document.getElementById('payrollMonth')?.value||'';
function findEmployee(row){const cells=[...row.querySelectorAll('td')];const code=(cells[0]?.textContent||'').trim();const name=(cells[1]?.textContent||'').trim();const list=window.payrollEmployees||[];return list.find(e=>String(e.employee_code||e.id).trim()===code)||list.find(e=>String(e.full_name||'').trim()===name)||null}
function installStyle(){if(document.getElementById('ibuild-overtime-controls-style'))return;const s=document.createElement('style');s.id='ibuild-overtime-controls-style';s.textContent='.ot-controls{display:flex;gap:5px;justify-content:center;margin-top:6px}.ot-edit,.ot-delete{border:0;border-radius:6px;padding:5px 8px;cursor:pointer;font-size:11px;font-weight:bold}.ot-edit{background:#dbeafe;color:#1d4ed8}.ot-delete{background:#fee2e2;color:#b91c1c}.ot-modal{position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:60000;padding:20px}.ot-modal[hidden]{display:none}.ot-modal-card{width:min(420px,100%);background:#fff;border-radius:14px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.2)}.ot-modal-card h3{margin:0 0 15px}.ot-modal-card label{display:block;font-size:12px;font-weight:bold;color:#475569;margin-bottom:6px}.ot-modal-card input{width:100%;padding:11px;border:1px solid #cbd5e1;border-radius:8px;font-size:15px}.ot-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:15px}.ot-modal-actions button{border:0;border-radius:8px;padding:10px 15px;font-weight:bold;cursor:pointer}.ot-save{background:#2563eb;color:#fff}.ot-cancel{background:#e2e8f0;color:#334155}';document.head.appendChild(s)}
function openEdit(employee,current){let m=document.getElementById('ibuildOtEditModal');if(!m){m=document.createElement('div');m.id='ibuildOtEditModal';m.className='ot-modal';m.hidden=true;m.innerHTML='<div class="ot-modal-card"><h3>✏️ تعديل الأوفر تايم</h3><label>عدد ساعات الأوفر تايم</label><input id="ibuildOtHours" type="number" min="0" step="0.01"><div class="ot-modal-actions"><button class="ot-cancel" type="button">إلغاء</button><button class="ot-save" type="button">حفظ التعديل</button></div></div>';document.body.appendChild(m);m.querySelector('.ot-cancel').onclick=()=>m.hidden=true}m.querySelector('#ibuildOtHours').value=Number(current||0).toFixed(2);m.hidden=false;m.querySelector('.ot-save').onclick=async()=>{const hours=Number(m.querySelector('#ibuildOtHours').value);if(!Number.isFinite(hours)||hours<0){msg('أدخل عدد ساعات صحيح','error');return}try{const r=await fetch('/api/payroll/overtime',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({employee_id:employee.id,payroll_month:month()+'-01',hours})});const d=await r.json().catch(()=>({}));if(!r.ok||!d.success)throw new Error(d.message||'تعذر تعديل الأوفر تايم');m.hidden=true;msg('تم تعديل الأوفر تايم بنجاح','success');if(typeof window.loadPayroll==='function')await window.loadPayroll();}catch(e){msg(e.message,'error')}}}
async function removeOt(employee){if(!confirm('هل تريد حذف الأوفر تايم لهذا الموظف؟'))return;try{const r=await fetch('/api/payroll/overtime',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({employee_id:employee.id,payroll_month:month()+'-01'})});const d=await r.json().catch(()=>({}));if(!r.ok||!d.success)throw new Error(d.message||'تعذر حذف الأوفر تايم');msg('تم حذف الأوفر تايم وإعادة حساب الراتب','success');if(typeof window.loadPayroll==='function')await window.loadPayroll();}catch(e){msg(e.message,'error')}}
function bind(){installStyle();const table=document.getElementById('payrollTable');if(!table)return;table.querySelectorAll('tbody tr').forEach(row=>{if(row.dataset.otControlsBound)return;const cells=row.querySelectorAll('td');if(cells.length<16)return;const employee=findEmployee(row);if(!employee)return;const hours=Number((cells[6].textContent||'').replace(/[^0-9.-]/g,''))||0;const host=cells[6];const wrap=document.createElement('div');wrap.className='ot-controls';const edit=document.createElement('button');edit.type='button';edit.className='ot-edit';edit.textContent='✏️ تعديل';edit.onclick=()=>openEdit(employee,hours);const del=document.createElement('button');del.type='button';del.className='ot-delete';del.textContent='🗑 حذف';del.onclick=()=>removeOt(employee);wrap.append(edit,del);host.appendChild(wrap);row.dataset.otControlsBound='1'})}
function init(){bind();const table=document.getElementById('payrollTable');if(table)new MutationObserver(()=>bind()).observe(table,{childList:true,subtree:true})}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else setTimeout(init,150);
})();</script>`;
    return html.replace(/<\/body>/i, script + '</body>');
}

express.response.send = function overtimeControlsSend(body) {
    if (typeof body === 'string' && /<html[\s>]/i.test(body)) body = injectControls(body);
    return originalSend.call(this, body);
};

express.response.sendFile = function overtimeControlsSendFile(filePath, options, callback) {
    if (typeof filePath === 'string' && /payroll\\.html?$/i.test(filePath)) {
        const response = this;
        const done = typeof callback === 'function' ? callback : function(error){ if(error) response.status(error.statusCode||500).end(); };
        require('fs').readFile(filePath,'utf8',(error,html)=>{if(error)return done(error);response.type('html').send(injectControls(html));done();});
        return this;
    }
    return originalSendFile.call(this,filePath,options,callback);
};

express.application.use=function payrollOvertimeControlsUse(...args){
    const result=originalUse.apply(this,args);
    if(!registered&&typeof args[0]==='function'&&args[0].name==='requireAuth')registered=true;
    return result;
};

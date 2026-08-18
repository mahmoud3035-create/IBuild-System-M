'use strict';

const express = require('express');
const db = require('./database/db');

const schema = async () => {
  await db.query(`CREATE TABLE IF NOT EXISTS payroll_advances (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    employee_id INT NOT NULL,
    advance_date DATE NOT NULL,
    amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    reason VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id), KEY idx_pa_emp (employee_id), KEY idx_pa_date (advance_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`CREATE TABLE IF NOT EXISTS payroll_advance_deductions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    employee_id INT NOT NULL,
    payroll_month DATE NOT NULL,
    amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    reason VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id), UNIQUE KEY uq_pad_emp_month (employee_id,payroll_month), KEY idx_pad_emp (employee_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
};

const m = v => /^\d{4}-\d{2}$/.test(String(v||'').slice(0,7)) ? String(v).slice(0,7) : null;
const n = v => Number.isFinite(Number(v)) ? Number(v) : 0;

// These routes are registered explicitly because the original advances preload
// adds middleware around these paths but the main server has no native routes.
express.application.get('/api/payroll/advances', async (req,res) => {
  try {
    await schema();
    const id=n(req.query.employee_id);
    const [rows]=await db.query(`SELECT id,employee_id,advance_date,amount,reason,created_at FROM payroll_advances ${id?'WHERE employee_id=?':''} ORDER BY advance_date DESC,id DESC`, id?[id]:[]);
    return res.json({success:true,advances:rows});
  } catch(e) { return res.status(500).json({success:false,message:'تعذر تحميل سلف الموظف',error:e.message}); }
});

express.application.get('/api/payroll/advance-summary', async (req,res) => {
  try {
    await schema();
    const month=m(req.query.month);
    const params=[];
    const monthJoin=month ? ' AND d.payroll_month=? ' : '';
    if(month) params.push(`${month}-01`);
    const [rows]=await db.query(`
      SELECT e.id employee_id,e.employee_code,e.full_name,
        COALESCE(a.total_advance,0) total_advance,
        COALESCE(p.total_repaid,0) total_repaid,
        GREATEST(0,COALESCE(a.total_advance,0)-COALESCE(p.total_repaid,0)) balance,
        COALESCE(d.current_deduction,0) current_deduction,
        COALESCE(d.current_reason,'') current_deduction_reason
      FROM employees e
      INNER JOIN (SELECT employee_id,SUM(amount) total_advance FROM payroll_advances GROUP BY employee_id) a ON a.employee_id=e.id
      LEFT JOIN (SELECT employee_id,SUM(amount) total_repaid FROM payroll_advance_deductions GROUP BY employee_id) p ON p.employee_id=e.id
      LEFT JOIN (SELECT employee_id,SUM(amount) current_deduction,MAX(reason) current_reason FROM payroll_advance_deductions WHERE 1=1 ${monthJoin} GROUP BY employee_id) d ON d.employee_id=e.id
      ORDER BY e.full_name`,params);
    return res.json({success:true,summary:rows.map(r=>({...r,total_advance:n(r.total_advance),total_repaid:n(r.total_repaid),balance:n(r.balance),current_deduction:n(r.current_deduction)}))});
  } catch(e) { return res.status(500).json({success:false,message:'تعذر تحميل ملخص السلف',error:e.message}); }
});

express.application.post('/api/payroll/advances', async (req,res) => {
  try {
    await schema();
    const employeeId=n(req.body?.employee_id), amount=n(req.body?.amount), reason=String(req.body?.reason||'').trim();
    const date=String(req.body?.advance_date||new Date().toISOString().slice(0,10)).slice(0,10);
    if(!employeeId||amount<=0||!reason)return res.status(400).json({success:false,message:'الموظف وقيمة السلفة وسبب السلفة مطلوبة'});
    const [emp]=await db.query('SELECT id FROM employees WHERE id=? LIMIT 1',[employeeId]);
    if(!emp.length)return res.status(404).json({success:false,message:'الموظف غير موجود'});
    const [r]=await db.query('INSERT INTO payroll_advances(employee_id,advance_date,amount,reason) VALUES(?,?,?,?)',[employeeId,date,amount.toFixed(2),reason]);
    return res.status(201).json({success:true,id:r.insertId,message:'تمت إضافة السلفة بنجاح'});
  } catch(e){return res.status(500).json({success:false,message:'تعذر إضافة السلفة',error:e.message});}
});

express.application.post('/api/payroll/advance-deduction', async (req,res) => {
  try {
    await schema();
    const employeeId=n(req.body?.employee_id), amount=n(req.body?.amount), month=m(req.body?.payroll_month), reason=String(req.body?.reason||'').trim();
    if(!employeeId||!month||amount<0)return res.status(400).json({success:false,message:'بيانات خصم السلفة غير صحيحة'});
    if(amount>0&&!reason)return res.status(400).json({success:false,message:'سبب خصم السلفة مطلوب'});
    const [a]=await db.query('SELECT COALESCE(SUM(amount),0) total FROM payroll_advances WHERE employee_id=?',[employeeId]);
    const [p]=await db.query('SELECT COALESCE(SUM(amount),0) total FROM payroll_advance_deductions WHERE employee_id=? AND payroll_month<>?',[employeeId,`${month}-01`]);
    const balance=Math.max(0,n(a[0]?.total)-n(p[0]?.total));
    if(amount>balance+0.005)return res.status(400).json({success:false,message:`قيمة الخصم أكبر من رصيد السلف المتبقي (${balance.toFixed(2)} AED)`});
    await db.query(`INSERT INTO payroll_advance_deductions(employee_id,payroll_month,amount,reason) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE amount=VALUES(amount),reason=VALUES(reason)`,[employeeId,`${month}-01`,amount.toFixed(2),reason||null]);
    const [rows]=await db.query(`SELECT id,payroll_salary,overtime_amount,additions,deductions,absence_deduction FROM payroll_records WHERE employee_id=? AND DATE_FORMAT(payroll_month,'%Y-%m')=? LIMIT 1`,[employeeId,month]);
    if(rows.length){const r=rows[0];const net=Math.max(0,n(r.payroll_salary)+n(r.overtime_amount)+n(r.additions)-n(r.deductions)-n(r.absence_deduction)-amount);await db.query('UPDATE payroll_records SET net_salary=? WHERE id=?',[net.toFixed(2),r.id]);}
    return res.json({success:true,message:'تم حفظ خصم السلفة لهذا الشهر',amount:Number(amount.toFixed(2))});
  } catch(e){return res.status(500).json({success:false,message:'تعذر حفظ خصم السلفة',error:e.message});}
});

express.application.delete('/api/payroll/advances/:id', async (req,res) => {
  try { await schema(); const id=n(req.params.id); if(!id)return res.status(400).json({success:false,message:'رقم السلفة غير صحيح'}); await db.query('DELETE FROM payroll_advances WHERE id=?',[id]); return res.json({success:true,message:'تم حذف السلفة'}); }
  catch(e){return res.status(500).json({success:false,message:'تعذر حذف السلفة',error:e.message});}
});

// Normalize the final payroll response. The database value is recalculated from
// the payroll components so the current advance deduction is applied exactly once.
const originalGet = express.application.get;
express.application.get = function(path,...handlers){
  if(path==='/api/payroll') handlers=handlers.map(h=>async function(req,res,next){
    const originalJson=res.json;
    res.json=async function(payload){
      try{
        if(payload?.success&&Array.isArray(payload.records)){
          await schema();
          for(const record of payload.records){
            const month=String(record.payroll_month||'').slice(0,7); const id=n(record.employee_id);
            if(!id||!m(month))continue;
            const [drows]=await db.query('SELECT amount,reason FROM payroll_advance_deductions WHERE employee_id=? AND payroll_month=? LIMIT 1',[id,`${month}-01`]);
            const adv=n(drows[0]?.amount);
            const base=n(record.payroll_salary)+n(record.overtime_amount)+n(record.additions)-n(record.deductions)-n(record.absence_deduction);
            record.advance_deduction=Number(adv.toFixed(2));
            record.advance_deduction_reason=drows[0]?.reason||'';
            record.net_salary=Number(Math.max(0,base-adv).toFixed(2));
          }
        }
      }catch(e){console.error('FINAL ADVANCE PAYROLL RESPONSE ERROR:',e.message)}
      return originalJson.call(this,payload);
    };
    return h(req,res,next);
  });
  return originalGet.call(this,path,...handlers);
};

schema().catch(e=>console.error('PAYROLL ADVANCE ROUTES SCHEMA ERROR:',e.message));

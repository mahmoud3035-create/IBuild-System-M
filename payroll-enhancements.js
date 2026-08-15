(function () {
    'use strict';

    let adjustments = [];
    let attendanceByEmployee = {};
    let advances = [];

    const q = (id) => document.getElementById(id);
    const num = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
    const monthValue = () => q('payrollMonth')?.value || '';
    const monthDate = () => monthValue() ? monthValue() + '-01' : '';
    const moneyText = (v) => 'AED ' + num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[c]));

    function monthDays(month) {
        if (!month) return 30;
        const [y, m] = month.split('-').map(Number);
        return new Date(y, m, 0).getDate();
    }

    async function getJson(url, options) {
        const response = await fetch(url, options);
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false) {
            throw new Error(data.message || 'تعذر تنفيذ العملية');
        }
        return data;
    }

    function addStyles() {
        if (q('payroll-enhancement-style')) return;
        const style = document.createElement('style');
        style.id = 'payroll-enhancement-style';
        style.textContent = `
            .payroll-extra-actions{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 20px}
            .payroll-extra-actions button{border:0;border-radius:8px;padding:11px 16px;color:#fff;font-weight:bold;cursor:pointer}
            .pe-overtime{background:#d97706}.pe-advance{background:#0f766e}.pe-deduction{background:#dc2626}
            .table-card tbody td:last-child .action-btn + .action-btn{display:none!important}
            .pe-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0 0 25px}
            .pe-summary-card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px}
            .pe-summary-label{font-size:11px;color:#64748b;margin-bottom:8px}.pe-summary-value{font-size:19px;font-weight:bold}
            .pe-blue{color:#2563eb}.pe-orange{color:#d97706}.pe-green{color:#16a34a}.pe-red{color:#dc2626}.pe-purple{color:#7c3aed}.pe-teal{color:#0f766e}
            .pe-panel{background:#fff;border:1px solid #e2e8f0;border-radius:13px;padding:20px;margin:0 0 25px}
            .pe-panel h3{margin:0 0 15px;font-size:17px}.pe-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
            .pe-field{display:flex;flex-direction:column;gap:6px}.pe-field label{font-size:12px;color:#475569;font-weight:bold}.pe-field input,.pe-field select,.pe-field textarea{width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;background:#fff}
            .pe-field.full{grid-column:1/-1}.pe-save{border:0;background:#2563eb;color:#fff;border-radius:8px;padding:10px 16px;font-weight:bold;cursor:pointer}
            .pe-secondary{border:0;background:#e2e8f0;color:#334155;border-radius:8px;padding:10px 16px;font-weight:bold;cursor:pointer}
            .pe-table-wrap{overflow:auto;margin-top:15px}.pe-table{width:100%;min-width:900px;border-collapse:collapse}.pe-table th,.pe-table td{padding:10px;border-bottom:1px solid #e2e8f0;text-align:right;white-space:nowrap;font-size:12px}.pe-table th{background:#f8fafc;color:#475569}
            .pe-mini-input{width:110px;padding:7px;border:1px solid #cbd5e1;border-radius:6px}.pe-mini-btn{border:0;background:#0f766e;color:#fff;padding:7px 10px;border-radius:6px;cursor:pointer}
            .pe-modal{position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:30000;padding:20px}.pe-modal[hidden]{display:none}.pe-modal-card{width:min(700px,100%);max-height:90vh;overflow:auto;background:#fff;border-radius:14px;padding:22px}.pe-modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.pe-close{border:0;background:#f1f5f9;border-radius:8px;font-size:24px;cursor:pointer;width:38px;height:38px}
            @media(max-width:900px){.pe-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.pe-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
            @media(max-width:600px){.pe-summary,.pe-grid{grid-template-columns:1fr}.pe-field.full{grid-column:auto}}
        `;
        document.head.appendChild(style);
    }

    function employeeOptions() {
        const employees = window.payrollEmployees || [];
        return `<option value="">اختر الموظف</option>` + employees.map(e => `<option value="${e.id}">${esc(e.employee_code || e.id)} - ${esc(e.full_name)}</option>`).join('');
    }

    function installActions() {
        if (q('payrollExtraActions')) return;
        const anchor = document.querySelector('.month-bar');
        if (!anchor) return;
        const box = document.createElement('div');
        box.id = 'payrollExtraActions';
        box.className = 'payroll-extra-actions';
        box.innerHTML = `
            <button type="button" class="pe-advance" onclick="openAdvancePanel()">💵 إدارة السلف</button>
            <button type="button" class="pe-deduction" onclick="openOtherDeductionModal()">➖ خصم آخر + السبب</button>`;
        anchor.insertAdjacentElement('afterend', box);
    }

    function installSummary() {
        if (q('payrollEnhancedSummary')) return;
        const base = document.querySelector('.stats');
        if (!base) return;
        base.style.display = 'none';
        const panel = document.createElement('div');
        panel.id = 'payrollEnhancedSummary';
        panel.className = 'pe-summary';
        panel.innerHTML = [
            ['إجمالي الرواتب الأساسية','pe-blue','peBasic'],
            ['إجمالي الأوفر تايم','pe-orange','peOvertime'],
            ['إجمالي الإضافات','pe-teal','peAdditions'],
            ['إجمالي خصم الغياب','pe-red','peAbsence'],
            ['إجمالي الخصومات اليدوية','pe-red','peManual'],
            ['إجمالي الخصومات الأخرى','pe-purple','peOther'],
            ['إجمالي خصم السلف','pe-orange','peAdvance'],
            ['إجمالي صافي الرواتب','pe-green','peNet']
        ].map(x => `<div class="pe-summary-card"><div class="pe-summary-label">${x[0]}</div><div id="${x[2]}" class="pe-summary-value ${x[1]}">AED 0.00</div></div>`).join('');
        base.insertAdjacentElement('afterend', panel);
    }

    function installAdvancePanel() {
        if (q('advancePanel')) return;
        const panel = document.createElement('section');
        panel.id = 'advancePanel';
        panel.className = 'pe-panel';
        panel.hidden = true;
        panel.innerHTML = `
            <h3>💵 السلف</h3>
            <div class="pe-grid">
                <div class="pe-field"><label>الموظف</label><select id="peAdvanceEmployee">${employeeOptions()}</select></div>
                <div class="pe-field"><label>قيمة السلفة الجديدة</label><input id="peAdvanceTotal" type="number" min="0" step="0.01" placeholder="مثال: 3000"></div>
                <div class="pe-field"><label>القسط الشهري</label><input id="peAdvanceInstallment" type="number" min="0" step="0.01" placeholder="مثال: 500"></div>
                <div class="pe-field"><label>شهر بداية السداد</label><input id="peAdvanceStart" type="month"></div>
                <div class="pe-field full"><label>ملاحظات السلفة</label><input id="peAdvanceNotes" type="text" placeholder="سبب أو ملاحظات اختيارية"></div>
            </div>
            <div style="margin-top:12px"><button class="pe-save" type="button" onclick="createPayrollAdvance()">💾 حفظ السلفة</button></div>
            <div id="advanceList" class="pe-table-wrap"></div>`;
        const table = document.querySelector('.table-card');
        table?.insertAdjacentElement('beforebegin', panel);
    }

    function installOtherDeductionModal() {
        if (q('otherDeductionModal')) return;
        const modal = document.createElement('div');
        modal.id = 'otherDeductionModal';
        modal.className = 'pe-modal';
        modal.hidden = true;
        modal.innerHTML = `
            <div class="pe-modal-card">
                <div class="pe-modal-head"><h3>➖ إضافة خصم آخر</h3><button class="pe-close" type="button" onclick="closeOtherDeductionModal()">×</button></div>
                <div class="pe-grid">
                    <div class="pe-field"><label>الموظف *</label><select id="peDeductionEmployee">${employeeOptions()}</select></div>
                    <div class="pe-field"><label>المبلغ *</label><input id="peDeductionAmount" type="number" min="0.01" step="0.01"></div>
                    <div class="pe-field full"><label>سبب الخصم *</label><input id="peDeductionReason" type="text" placeholder="مثال: تلف مادة / غرامة / سلفة أخرى"></div>
                </div>
                <div style="margin-top:15px;display:flex;gap:10px"><button class="pe-secondary" type="button" onclick="closeOtherDeductionModal()">إلغاء</button><button class="pe-save" type="button" onclick="saveOtherDeduction()">💾 حفظ الخصم</button></div>
            </div>`;
        document.body.appendChild(modal);
    }

    function installUi() {
        addStyles();
        installActions();
        installSummary();
        installAdvancePanel();
        installOtherDeductionModal();
    }

    async function loadAdjustments() {
        const month = monthDate();
        if (!month) return;
        const data = await getJson(`/api/payroll/adjustments?month=${encodeURIComponent(month)}`);
        adjustments = data.adjustments || [];
        const attendance = await getJson(`/api/attendance?month=${encodeURIComponent(monthValue())}`).catch(() => ({ records: [] }));
        attendanceByEmployee = {};
        (attendance.records || []).forEach(r => {
            const id = Number(r.employee_id);
            if (!attendanceByEmployee[id]) attendanceByEmployee[id] = { absent:0, present:0, late:0, leave:0, off:0 };
            const s = String(r.status || '').toLowerCase();
            if (attendanceByEmployee[id][s] !== undefined) attendanceByEmployee[id][s]++;
        });
        await loadAdvances();
    }

    async function loadAdvances(employeeId) {
        const query = employeeId ? `?employee_id=${encodeURIComponent(employeeId)}` : '';
        const data = await getJson(`/api/payroll/advances${query}`);
        advances = data.advances || [];
        renderAdvanceList();
    }

    function adjustmentTotals(employeeId) {
        const rows = adjustments.filter(a => Number(a.employee_id) === Number(employeeId));
        return {
            advance: rows.filter(a => a.type === 'advance').reduce((s,a) => s + num(a.amount), 0),
            other: rows.filter(a => a.type === 'deduction').reduce((s,a) => s + num(a.amount), 0)
        };
    }

    function renderAdvanceList() {
        const target = q('advanceList');
        if (!target) return;
        const employeeId = q('peAdvanceEmployee')?.value;
        const rows = advances.filter(a => !employeeId || Number(a.employee_id) === Number(employeeId));
        if (!rows.length) {
            target.innerHTML = '<div class="empty">لا توجد سلف مسجلة للموظف المختار</div>';
            return;
        }
        target.innerHTML = `<table class="pe-table"><thead><tr><th>الموظف</th><th>قيمة السلفة</th><th>المتبقي</th><th>القسط الشهري</th><th>خصم هذا الشهر</th><th>إجراء</th></tr></thead><tbody>${rows.map(a => `
            <tr><td>${esc(a.full_name || a.employee_name || '-')}</td><td>${moneyText(a.total_amount)}</td><td>${moneyText(a.remaining_amount)}</td><td>${moneyText(a.monthly_installment)}</td>
            <td><input class="pe-mini-input" id="advanceAmount_${a.id}" type="number" min="0.01" max="${num(a.remaining_amount)}" step="0.01" value="${Math.min(num(a.monthly_installment), num(a.remaining_amount)).toFixed(2)}"></td>
            <td><button class="pe-mini-btn" type="button" onclick="applyAdvanceDeduction(${a.id})">خصم هذا الشهر</button></td></tr>`).join('')}</tbody></table>`;
    }

    async function refreshPayrollView() {
        await loadAdjustments().catch(e => console.error('PAYROLL ENHANCEMENT LOAD:', e));
        renderEnhancedTable();
        renderEnhancedSummary();
    }

    function renderEnhancedSummary() {
        const employees = window.payrollEmployees || [];
        const records = window.payrollRecords || [];
        const days = monthDays(monthValue());
        let basic=0, overtime=0, additions=0, absence=0, manual=0, other=0, advance=0, net=0;
        employees.forEach(employee => {
            const record = records.find(r => Number(r.employee_id) === Number(employee.id));
            const salary = num(record?.payroll_salary ?? employee.payroll_salary);
            const absentDays = record ? num(record.absent_days) : num(attendanceByEmployee[Number(employee.id)]?.absent);
            const absenceDeduction = record ? num(record.absence_deduction) : (salary / days) * absentDays;
            const ot = num(record?.overtime_amount);
            const add = num(record?.additions);
            const man = num(record?.deductions);
            const adj = adjustmentTotals(employee.id);
            const rowNet = Math.max(0, salary + ot + add - absenceDeduction - man - adj.other - adj.advance);
            basic += salary; overtime += ot; additions += add; absence += absenceDeduction; manual += man; other += adj.other; advance += adj.advance; net += rowNet;
        });
        [['peBasic',basic],['peOvertime',overtime],['peAdditions',additions],['peAbsence',absence],['peManual',manual],['peOther',other],['peAdvance',advance],['peNet',net]].forEach(([id,value]) => { if(q(id)) q(id).textContent=moneyText(value); });
    }

    function renderEnhancedTable() {
        const table = q('payrollTable');
        if (!table) return;
        const employees = window.payrollEmployees || [];
        const records = window.payrollRecords || [];
        const days = monthDays(monthValue());
        const headers = q('payrollTable')?.closest('table')?.querySelector('thead tr');
        if (headers) headers.innerHTML = ['الكود','الموظف','الراتب الأساسي','أيام العمل','الغياب','خصم الغياب','ساعات الأوفر تايم','قيمة الأوفر تايم','الإضافات','الخصومات اليدوية','خصومات أخرى','خصم السلف','إجمالي الخصومات','صافي الراتب','الحالة','الإجراء'].map(h=>`<th>${h}</th>`).join('');
        table.innerHTML = '';
        if (!employees.length) { table.innerHTML='<tr><td colspan="16" class="empty">لا يوجد موظفون</td></tr>'; return; }
        employees.forEach(employee => {
            const record = records.find(r => Number(r.employee_id) === Number(employee.id));
            const salary = num(record?.payroll_salary ?? employee.payroll_salary);
            const absentDays = record ? num(record.absent_days) : num(attendanceByEmployee[Number(employee.id)]?.absent);
            const absenceDeduction = record ? num(record.absence_deduction) : (salary / days) * absentDays;
            const otHours = num(record?.overtime_hours);
            const otAmount = num(record?.overtime_amount);
            const additions = num(record?.additions);
            const manual = num(record?.deductions);
            const adj = adjustmentTotals(employee.id);
            const totalDeductions = absenceDeduction + manual + adj.other + adj.advance;
            const net = Math.max(0, salary + otAmount + additions - totalDeductions);
            const status = String(record?.status || 'draft').toLowerCase();
            const statusText = status === 'paid' ? 'مدفوع' : status === 'approved' ? 'معتمد' : record ? 'مسودة' : 'غير محفوظ';
            const action = record ? `<button class="action-btn" onclick="editPayroll(${record.id})">✏️ تعديل</button>` : `<button class="action-btn" onclick="createPayrollForEmployee(${employee.id})">➕ إضافة</button>`;
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${esc(employee.employee_code || employee.id)}</td><td><strong>${esc(employee.full_name)}</strong></td><td>${moneyText(salary)}</td><td>${record?.working_days || days}</td><td>${absentDays}</td><td>${moneyText(absenceDeduction)}</td><td>${otHours.toFixed(2)}</td><td>${moneyText(otAmount)}</td><td>${moneyText(additions)}</td><td>${moneyText(manual)}</td><td>${moneyText(adj.other)}</td><td>${moneyText(adj.advance)}</td><td class="pe-red"><strong>${moneyText(totalDeductions)}</strong></td><td class="net">${moneyText(net)}</td><td><span class="badge ${status === 'paid' ? 'paid' : status === 'approved' ? 'approved' : 'draft'}">${statusText}</span></td><td>${action}</td>`;
            table.appendChild(tr);
        });
    }

    async function createPayrollAdvance() {
        const employeeId = num(q('peAdvanceEmployee')?.value);
        const total = num(q('peAdvanceTotal')?.value);
        const installment = num(q('peAdvanceInstallment')?.value);
        const startMonth = q('peAdvanceStart')?.value || monthValue();
        if (!employeeId || total <= 0 || installment <= 0) return window.showMessage?.('أدخل الموظف وقيمة السلفة والقسط الشهري', 'error');
        if (installment > total) return window.showMessage?.('القسط الشهري لا يمكن أن يكون أكبر من قيمة السلفة', 'error');
        try {
            await getJson('/api/payroll/advances', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ employee_id:employeeId, total_amount:total, monthly_installment:installment, start_month:startMonth+'-01', notes:q('peAdvanceNotes')?.value || '' }) });
            q('peAdvanceTotal').value=''; q('peAdvanceInstallment').value=''; q('peAdvanceNotes').value='';
            await loadAdvances(employeeId); await refreshPayrollView();
            window.showMessage?.('تم حفظ السلفة بنجاح','success');
        } catch(e) { window.showMessage?.(e.message,'error'); }
    }

    async function applyAdvanceDeduction(advanceId) {
        const amount = num(q(`advanceAmount_${advanceId}`)?.value);
        if (amount <= 0) return window.showMessage?.('أدخل مبلغ الخصم لهذا الشهر','error');
        try {
            await getJson(`/api/payroll/advances/${advanceId}/deduct`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ month:monthDate(), amount }) });
            await loadAdvances(q('peAdvanceEmployee')?.value); await refreshPayrollView();
            window.showMessage?.('تم تسجيل خصم السلفة لهذا الشهر','success');
        } catch(e) { window.showMessage?.(e.message,'error'); }
    }

    function openAdvancePanel() {
        const panel=q('advancePanel'); if(!panel) return; panel.hidden=!panel.hidden; if(!panel.hidden){ q('peAdvanceStart').value=monthValue(); loadAdvances(q('peAdvanceEmployee')?.value).catch(e=>window.showMessage?.(e.message,'error')); }
    }

    function openOtherDeductionModal() { const modal=q('otherDeductionModal'); if(!modal)return; q('peDeductionEmployee').innerHTML=employeeOptions(); q('peDeductionAmount').value=''; q('peDeductionReason').value=''; modal.hidden=false; }
    function closeOtherDeductionModal() { if(q('otherDeductionModal')) q('otherDeductionModal').hidden=true; }

    async function saveOtherDeduction() {
        const employeeId=num(q('peDeductionEmployee')?.value); const amount=num(q('peDeductionAmount')?.value); const reason=(q('peDeductionReason')?.value||'').trim();
        if(!employeeId || amount<=0 || !reason) return window.showMessage?.('اختر الموظف وأدخل المبلغ والسبب','error');
        try {
            await getJson('/api/payroll/adjustments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({employee_id:employeeId,payroll_month:monthDate(),type:'deduction',amount,reason})});
            closeOtherDeductionModal(); await refreshPayrollView(); window.showMessage?.('تم حفظ الخصم واحتسابه في الراتب','success');
        } catch(e){window.showMessage?.(e.message,'error');}
    }

    function patchLoadPayroll() {
        if (typeof window.loadPayroll !== 'function' || window.loadPayroll.__enhanced) return;
        const original = window.loadPayroll;
        const wrapped = async function() { await original.apply(this, arguments); await refreshPayrollView(); };
        wrapped.__enhanced = true;
        window.loadPayroll = wrapped;
    }

    function patchHandleMonthChange() {
        if (typeof window.handleMonthChange !== 'function' || window.handleMonthChange.__enhanced) return;
        const original = window.handleMonthChange;
        const wrapped = async function() { await original.apply(this, arguments); await refreshPayrollView(); };
        wrapped.__enhanced = true;
        window.handleMonthChange = wrapped;
    }

    function start() {
        installUi();
        patchLoadPayroll();
        patchHandleMonthChange();
        refreshPayrollView();
        q('peAdvanceEmployee')?.addEventListener('change', () => loadAdvances(q('peAdvanceEmployee').value));
    }

    window.createPayrollAdvance = createPayrollAdvance;
    window.applyAdvanceDeduction = applyAdvanceDeduction;
    window.openAdvancePanel = openAdvancePanel;
    window.openOtherDeductionModal = openOtherDeductionModal;
    window.closeOtherDeductionModal = closeOtherDeductionModal;
    window.saveOtherDeduction = saveOtherDeduction;

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
const express = require('express');

let registered = false;
const originalUse = express.application.use;
const originalSend = express.response.send;
const originalSendFile = express.response.sendFile;

function inject(html) {
    if (typeof html !== 'string' || !/id=["']payrollTable["']/i.test(html) || html.includes('id="ibuild-hide-payroll-edit"')) return html;
    const script = `<script id="ibuild-hide-payroll-edit">(function(){function hide(){const table=document.getElementById('payrollTable');if(!table)return;table.querySelectorAll('button,a').forEach(el=>{const text=(el.textContent||'').replace(/\\s+/g,' ').trim();if(text==='تعديل' || text.includes('✏️ تعديل')){el.style.display='none';el.setAttribute('aria-hidden','true');}})}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',hide);else hide();new MutationObserver(hide).observe(document.body,{childList:true,subtree:true});})();</script>`;
    return html.replace(/<\\/body>/i, script + '</body>');
}

express.response.send = function hidePayrollEditSend(body) {
    if (typeof body === 'string' && /<html[\\s>]/i.test(body) && /id=["']payrollTable["']/i.test(body)) body = inject(body);
    return originalSend.call(this, body);
};

express.response.sendFile = function hidePayrollEditSendFile(filePath, options, callback) {
    if (typeof filePath === 'string' && /payroll\\.html?$/i.test(filePath)) {
        const response = this;
        const done = typeof callback === 'function' ? callback : function(error) {
            if (error) response.status(error.statusCode || 500).end();
        };
        require('fs').readFile(filePath, 'utf8', (error, html) => {
            if (error) return done(error);
            response.type('html').send(inject(html));
            done();
        });
        return this;
    }
    return originalSendFile.call(this, filePath, options, callback);
};

express.application.use = function hidePayrollEditUse(...args) {
    const result = originalUse.apply(this, args);
    if (!registered && typeof args[0] === 'function' && args[0].name === 'requireAuth') registered = true;
    return result;
};

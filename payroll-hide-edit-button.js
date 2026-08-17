const express = require('express');

const originalSend = express.response.send;
const originalSendFile = express.response.sendFile;

function inject(html) {
    if (typeof html !== 'string') return html;
    if (!/id=["']payrollTable["']/i.test(html)) return html;
    if (html.includes('id="ibuild-hide-payroll-edit"')) return html;

    const script = `<script id="ibuild-hide-payroll-edit">(function(){function hide(){const table=document.getElementById('payrollTable');if(!table)return;table.querySelectorAll('button,a').forEach(function(el){const text=(el.textContent||'').replace(/\s+/g,' ').trim();if(text==='تعديل'||text.includes('✏️ تعديل')){el.style.display='none';el.setAttribute('aria-hidden','true');}});}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',hide);else hide();new MutationObserver(hide).observe(document.body,{childList:true,subtree:true});})();</script>`;
    return html.replace(/<\/body>/i, script + '</body>');
}

express.response.send = function hidePayrollEditSend(body) {
    return originalSend.call(this, inject(body));
};

express.response.sendFile = function hidePayrollEditSendFile(filePath, options, callback) {
    if (typeof filePath === 'string' && /payroll\.html?$/i.test(filePath)) {
        const response = this;
        const done = typeof callback === 'function' ? callback : function(error) {
            if (error) response.status(error.statusCode || 500).end();
        };
        require('fs').readFile(filePath, 'utf8', function(error, html) {
            if (error) return done(error);
            response.type('html').send(inject(html));
            done();
        });
        return this;
    }
    return originalSendFile.call(this, filePath, options, callback);
};

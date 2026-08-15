/* Runtime security hardening loaded before server.js. */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const corsPath = require.resolve('cors');
const originalCors = require(corsPath);
const configuredOrigin = String(process.env.CORS_ORIGIN || '').trim();

require.cache[corsPath].exports = function hardenedCors(options = {}) {
    const suppliedOrigin = Object.prototype.hasOwnProperty.call(options, 'origin')
        ? options.origin
        : (configuredOrigin || false);

    return originalCors({
        ...options,
        origin: suppliedOrigin,
        credentials: options.credentials ?? true
    });
};

const express = require('express');
const sidebarPath = path.join(__dirname, 'shared-sidebar.js');
let sidebarScript = '';
try {
    sidebarScript = fs.readFileSync(sidebarPath, 'utf8');
} catch (error) {
    console.error('SHARED SIDEBAR LOAD ERROR:', error.message);
}

function injectSharedSidebar(html) {
    if (typeof html !== 'string' || !sidebarScript || !/<html[\s>]/i.test(html)) return html;
    if (html.includes('id="ibuild-shared-sidebar-style"') || html.includes('shared-sidebar.js')) return html;
    const script = `<script>\n${sidebarScript}\n</script>`;
    if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${script}\n</body>`);
    return `${html}\n${script}`;
}

// Normal Express responses.
const originalSend = express.response.send;
express.response.send = function hardenedSend(body) {
    if (typeof body === 'string' && /<html[\s>]/i.test(body)) {
        body = injectSharedSidebar(body);
        this.type('html');
    }
    return originalSend.call(this, body);
};

const originalSendFile = express.response.sendFile;
express.response.sendFile = function hardenedSendFile(filePath, options, callback) {
    if (typeof filePath === 'string' && /\.html?$/i.test(filePath)) {
        const response = this;
        const done = typeof callback === 'function' ? callback : function (error) {
            if (error) return response.status(error.statusCode || 500).end();
        };
        fs.readFile(filePath, 'utf8', function (error, html) {
            if (error) return done(error);
            response.type('html').send(injectSharedSidebar(html));
            done();
        });
        return this;
    }
    return originalSendFile.call(this, filePath, options, callback);
};

// serve-static does not use res.send()/res.sendFile(). Buffer HTML at the final
// response boundary so legacy static pages receive the same sidebar too.
const originalWrite = express.response.write;
const originalEnd = express.response.end;
express.response.write = function hardenedWrite(chunk, encoding, callback) {
    const contentType = String(this.getHeader('Content-Type') || '').toLowerCase();
    if (contentType.includes('text/html')) {
        if (!this.__ibuildHtmlBuffer) this.__ibuildHtmlBuffer = [];
        if (chunk) this.__ibuildHtmlBuffer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding));
        if (typeof callback === 'function') callback();
        return true;
    }
    return originalWrite.call(this, chunk, encoding, callback);
};

express.response.end = function hardenedEnd(chunk, encoding, callback) {
    const contentType = String(this.getHeader('Content-Type') || '').toLowerCase();
    if (contentType.includes('text/html') || this.__ibuildHtmlBuffer) {
        if (!this.__ibuildHtmlBuffer) this.__ibuildHtmlBuffer = [];
        if (chunk) this.__ibuildHtmlBuffer.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding));
        const html = Buffer.concat(this.__ibuildHtmlBuffer).toString('utf8');
        delete this.__ibuildHtmlBuffer;
        const finalHtml = injectSharedSidebar(html);
        this.removeHeader('Content-Length');
        return originalEnd.call(this, finalHtml, 'utf8', callback);
    }
    return originalEnd.call(this, chunk, encoding, callback);
};

// In production, never expose raw database/implementation errors to clients.
if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    const originalJson = express.response.json;

    express.response.json = function secureJson(payload) {
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            const sanitized = { ...payload };
            delete sanitized.error;
            return originalJson.call(this, sanitized);
        }
        return originalJson.call(this, payload);
    };
}

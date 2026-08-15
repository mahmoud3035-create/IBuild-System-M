/* Runtime security hardening loaded before server.js. */
require('dotenv').config();

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

// In production, never expose raw database/implementation errors to clients.
if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    const expressPath = require.resolve('express');
    const express = require(expressPath);
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

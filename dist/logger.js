"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const timestamp = () => new Date().toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
});
exports.logger = {
    info: (msg, ...args) => console.log(`[${timestamp()}] INFO  ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[${timestamp()}] WARN  ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[${timestamp()}] ERROR ${msg}`, ...args),
};

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CapitalAPI = void 0;
const axios_1 = __importDefault(require("axios"));
const logger_1 = require("./logger");
class CapitalAPI {
    constructor(apiKey, identifier, password, isDemo = false) {
        this.apiKey = apiKey;
        this.identifier = identifier;
        this.password = password;
        this.isDemo = isDemo;
        this.cst = '';
        this.securityToken = '';
        const baseURL = isDemo
            ? 'https://demo-api-capital.backend-capital.com/api/v1'
            : 'https://api-capital.backend-capital.com/api/v1';
        this.client = axios_1.default.create({ baseURL, timeout: 10000 });
    }
    async createSession() {
        const res = await this.client.post('/session', { identifier: this.identifier, password: this.password, encryptedPassword: false }, { headers: { 'X-CAP-API-KEY': this.apiKey, 'Content-Type': 'application/json' } });
        this.cst = res.headers['cst'];
        this.securityToken = res.headers['x-security-token'];
        logger_1.logger.info('Capital.com session created');
    }
    get authHeaders() {
        return {
            'CST': this.cst,
            'X-SECURITY-TOKEN': this.securityToken,
            'Content-Type': 'application/json',
        };
    }
    async getCandles(epic, resolution, max = 20) {
        const res = await this.client.get(`/prices/${epic}`, {
            headers: this.authHeaders,
            params: { resolution, max, pageSize: max },
        });
        const prices = res.data.prices;
        return prices.map(p => ({
            time: p.snapshotTimeUTC,
            open: (p.openPrice.bid + p.openPrice.ask) / 2,
            high: (p.highPrice.bid + p.highPrice.ask) / 2,
            low: (p.lowPrice.bid + p.lowPrice.ask) / 2,
            close: (p.closePrice.bid + p.closePrice.ask) / 2,
        }));
    }
}
exports.CapitalAPI = CapitalAPI;

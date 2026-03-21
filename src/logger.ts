const timestamp = () => new Date().toLocaleString('de-DE', {
  timeZone: 'Europe/Berlin',
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export const logger = {
  info:  (msg: string, ...args: any[]) => console.log(`[${timestamp()}] INFO  ${msg}`, ...args),
  warn:  (msg: string, ...args: any[]) => console.warn(`[${timestamp()}] WARN  ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[${timestamp()}] ERROR ${msg}`, ...args),
};

import axios from 'axios';
import { logger } from './logger';

export class TelegramNotifier {
  private baseUrl: string;

  constructor(private botToken: string, private chatId: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  async sendMessage(text: string): Promise<void> {
    try {
      await axios.post(`${this.baseUrl}/sendMessage`, {
        chat_id: this.chatId,
        text,
        parse_mode: 'HTML',
      });
      logger.info('Telegram message sent');
    } catch (err) {
      logger.error('Telegram send error:', err);
    }
  }
}

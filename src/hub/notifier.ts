import notifier from 'node-notifier';
import { execFile } from 'node:child_process';
import { logger } from '../shared/logger.js';
import type { NotifyLevel, WebhookConfig } from '../shared/types.js';

export class Notifier {
  private webhooks: WebhookConfig[] = [];
  private desktopEnabled = true;
  private notificationSettingsOpened = false;
  private dashboardUrl?: string;

  configure(options: { desktop?: boolean; webhooks?: WebhookConfig[]; dashboardUrl?: string }): void {
    if (options.dashboardUrl) this.dashboardUrl = options.dashboardUrl;
    if (options.desktop !== undefined) this.desktopEnabled = options.desktop;
    if (options.webhooks) this.webhooks = options.webhooks;
  }

  async notify(title: string, message: string, level: NotifyLevel = 'info'): Promise<void> {
    const promises: Promise<void>[] = [];

    if (this.desktopEnabled) {
      promises.push(this.sendDesktop(title, message, level));
    }

    for (const webhook of this.webhooks) {
      promises.push(this.sendWebhook(webhook, title, message, level));
    }

    await Promise.allSettled(promises);
  }

  private async sendDesktop(title: string, message: string, _level: NotifyLevel): Promise<void> {
    if (process.platform === 'win32') {
      // Check if notifications are enabled by running snoretoast directly
      const enabled = await this.checkWindowsNotifications();
      if (!enabled) {
        this.openNotificationSettings();
        return;
      }
    }

    return new Promise((resolve) => {
      const notification = (notifier as any).notify(
        {
          title: `Claude Alarm: ${title}`,
          message,
          sound: true,
          wait: true,
        },
        (err: Error | null) => {
          if (err) {
            logger.warn(`Desktop notification failed: ${err.message}`);
          }
          resolve();
        },
      );

      if (this.dashboardUrl && notification) {
        const url = this.dashboardUrl;
        notification.on('click', () => {
          if (process.platform === 'win32') {
            execFile('powershell', ['-Command', `Start-Process "${url}"`]);
          } else if (process.platform === 'darwin') {
            execFile('open', [url]);
          } else {
            execFile('xdg-open', [url]);
          }
        });
      }
    });
  }

  private checkWindowsNotifications(): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(
        'powershell',
        ['-Command', '(Get-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications" -Name ToastEnabled -ErrorAction SilentlyContinue).ToastEnabled'],
        (err, stdout) => {
          if (err) { resolve(true); return; } // assume enabled on error
          const value = stdout.trim();
          resolve(value !== '0');
        },
      );
    });
  }

  private openNotificationSettings(): void {
    if (this.notificationSettingsOpened) return;
    this.notificationSettingsOpened = true;

    logger.warn('Windows notifications are disabled. Opening notification settings...');
    logger.warn('Please enable notifications for this app, then try again.');

    if (process.platform === 'win32') {
      execFile('powershell', ['-Command', 'Start-Process ms-settings:notifications']);
    }

    // Allow re-opening after 5 minutes
    setTimeout(() => { this.notificationSettingsOpened = false; }, 5 * 60 * 1000);
  }

  private async sendWebhook(
    webhook: WebhookConfig,
    title: string,
    message: string,
    level: NotifyLevel,
  ): Promise<void> {
    try {
      const response = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...webhook.headers,
        },
        body: JSON.stringify({
          title,
          message,
          level,
          timestamp: Date.now(),
          source: 'claude-alarm',
        }),
      });

      if (!response.ok) {
        logger.warn(`Webhook ${webhook.url} returned ${response.status}`);
      }
    } catch (err) {
      logger.warn(`Webhook ${webhook.url} failed: ${(err as Error).message}`);
    }
  }
}
